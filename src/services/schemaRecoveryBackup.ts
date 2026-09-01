/**
 * Schema-recovery backup: a pre-migration safety net that captures the
 * user's irreplaceable creative data BEFORE any ALTER / migration / repair
 * touches the physical schema.
 *
 * This writer is deliberately separate from the ordinary Backup Center
 * writer. A schema-recovery snapshot runs on the startup hot path, where a
 * large continuation source or chapter must not become a giant JS string,
 * array, or object graph. It streams bounded row batches and text chunks to
 * a staging file, hashes the same logical v3 JSON stream, patches the
 * checksum in place, and atomically renames only after all checks pass.
 *
 * Fail-closed: any read / checksum / row-count / write failure throws. The
 * caller MUST NOT proceed with schema mutation after such a failure.
 */
import RNFS from 'react-native-fs';
import type SQLite from 'react-native-sqlite-storage';
import appVersionJson from '../constants/version.json';
import { execute } from '../data/connection/execute';
import { SCHEMA_VERSION } from './migrations';
import {
  BackupPayloadHasher,
  isSensitiveKey,
  sanitizeBackupRow,
} from './backupService';
import {
  SCHEMA_RECOVERY_MANIFEST,
  type TableManifest,
} from './database/schemaManifest';
import { utf8ByteLength } from './continuation/hashUtils';

export const SCHEMA_RECOVERY_DIR = `${RNFS.DocumentDirectoryPath}/schema-recovery`;

const RECOVERY_ROW_BATCH_SIZE = 32;
const RECOVERY_TEXT_CHUNK_SIZE_CHARS = 32 * 1024;
const RECOVERY_JSON_OUTPUT_CHUNK_SIZE = 16 * 1024;
const CHECKSUM_PLACEHOLDER = '0'.repeat(64);
const RECOVERY_ROW_ID_ALIAS = '__shinewriter_schema_recovery_rowid';

export interface SchemaRecoveryBackupResult {
  path: string;
  checksum: string;
  verified: boolean;
  coreCounts: Record<string, number>;
}

export interface SchemaRecoveryBackupFailure {
  ok: false;
  reason: string;
  error?: unknown;
  /** Partial path if a staging file was written but verification failed. */
  stagingPath?: string;
}

/**
 * These are the non-optional compatibility-floor tables whose row counts
 * must survive the startup snapshot. Newer domain tables are still audited
 * and streamed when present, but their absence is allowed for old schemas.
 */
export const CORE_RECOVERY_TABLES = [
  'projects',
  'chapters',
  'fragments',
  'plotlines',
  'project_plotlines',
  'characters',
  'worldbook_collections',
  'worldbook_entries',
  'notes',
  'presets',
  'llm_config',
  'settings',
] as const;

const CORE_RECOVERY_TABLE_SET = new Set<string>(CORE_RECOVERY_TABLES);

interface PhysicalColumn {
  name: string;
  declaredType: string;
  primaryKeyOrder: number;
}

interface RowLocator {
  whereSql?: string;
  params: any[];
  fallbackOffset?: number;
}

interface RecoveryRowStreamResult {
  rows: number;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function isTextColumn(column: PhysicalColumn): boolean {
  const declaredType = column.declaredType.trim().toUpperCase();
  // SQLite's empty declared type has text affinity only when values happen
  // to be text, but treating it as text is the safe bounded-memory choice.
  return (
    declaredType.length === 0 ||
    /CHAR|CLOB|TEXT|VARCHAR|VARYING|NCHAR|NVARCHAR|JSON/.test(declaredType)
  );
}

function normalizeScalar(value: unknown): unknown {
  return value === undefined
    ? null
    : typeof value === 'boolean'
      ? value ? 1 : 0
      : value;
}

function serializeScalar(value: unknown, table: string, column: string): string {
  const normalized = normalizeScalar(value);
  if (normalized !== null && typeof normalized === 'object') {
    throw new Error(`Schema-recovery backup encountered a non-scalar value in ${table}.${column}`);
  }
  const json = JSON.stringify(normalized);
  if (json === undefined) {
    throw new Error(`Schema-recovery backup could not serialize ${table}.${column}`);
  }
  return json;
}

function countUnicodeCharacters(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      index += 1;
    }
    count += 1;
  }
  return count;
}

function unicodeEscape(code: number): string {
  return `\\u${code.toString(16).padStart(4, '0')}`;
}

interface JsonTextEscapeState {
  pendingHighSurrogate: string;
}

/**
 * JSON.stringify-compatible escaping for a text chunk. It never builds a
 * string larger than RECOVERY_JSON_OUTPUT_CHUNK_SIZE before handing it to the
 * file writer, and carries a high surrogate across SQLite substr boundaries.
 */
async function writeEscapedJsonText(
  writer: SchemaRecoveryJsonWriter,
  value: string,
  state: JsonTextEscapeState,
): Promise<void> {
  let output = '';
  const flushOutput = async () => {
    if (output.length === 0) return;
    await writer.append(output);
    output = '';
  };
  const emit = async (piece: string) => {
    output += piece;
    if (output.length >= RECOVERY_JSON_OUTPUT_CHUNK_SIZE) {
      await flushOutput();
    }
  };

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (state.pendingHighSurrogate) {
      if (code >= 0xdc00 && code <= 0xdfff) {
        await emit(state.pendingHighSurrogate);
        await emit(value[index]);
        state.pendingHighSurrogate = '';
        continue;
      }
      await emit(unicodeEscape(state.pendingHighSurrogate.charCodeAt(0)));
      state.pendingHighSurrogate = '';
    }

    if (code >= 0xd800 && code <= 0xdbff) {
      if (
        index + 1 < value.length &&
        value.charCodeAt(index + 1) >= 0xdc00 &&
        value.charCodeAt(index + 1) <= 0xdfff
      ) {
        await emit(value[index]);
        await emit(value[index + 1]);
        index += 1;
      } else {
        state.pendingHighSurrogate = value[index];
      }
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      await emit(unicodeEscape(code));
      continue;
    }

    switch (code) {
      case 0x08:
        await emit('\\b');
        break;
      case 0x09:
        await emit('\\t');
        break;
      case 0x0a:
        await emit('\\n');
        break;
      case 0x0c:
        await emit('\\f');
        break;
      case 0x0d:
        await emit('\\r');
        break;
      case 0x22:
        await emit('\\"');
        break;
      case 0x5c:
        await emit('\\\\');
        break;
      default:
        if (code < 0x20) {
          await emit(unicodeEscape(code));
        } else {
          await emit(value[index]);
        }
    }
  }

  if (state.pendingHighSurrogate) {
    await emit(unicodeEscape(state.pendingHighSurrogate.charCodeAt(0)));
    state.pendingHighSurrogate = '';
  }
  await flushOutput();
}

/**
 * Appends small chunks to RNFS and feeds the same logical chunks to the
 * historical v3 checksum stream. The actual file and logical hash differ
 * only at the fixed-width checksum placeholder, which is patched in place at
 * the end.
 */
class SchemaRecoveryJsonWriter {
  private actualBuffer = '';
  private logicalBuffer = '';
  private committedBytes = 0;
  private checksumStream = new BackupPayloadHasher();

  constructor(private readonly path: string) {}

  get currentByteOffset(): number {
    return this.committedBytes + utf8ByteLength(this.actualBuffer);
  }

  async append(actual: string, logical: string = actual): Promise<void> {
    this.actualBuffer += actual;
    this.logicalBuffer += logical;
    if (this.actualBuffer.length >= RECOVERY_JSON_OUTPUT_CHUNK_SIZE) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.actualBuffer.length === 0 && this.logicalBuffer.length === 0) return;
    if (this.actualBuffer.length === 0 || this.logicalBuffer.length === 0) {
      throw new Error('Schema-recovery writer buffer is inconsistent');
    }
    await RNFS.appendFile(this.path, this.actualBuffer, 'utf8');
    this.committedBytes += utf8ByteLength(this.actualBuffer);
    this.checksumStream.feed(this.logicalBuffer);
    this.actualBuffer = '';
    this.logicalBuffer = '';
  }

  digest(): string {
    if (this.actualBuffer.length !== 0 || this.logicalBuffer.length !== 0) {
      throw new Error('Schema-recovery writer must be flushed before digest');
    }
    return this.checksumStream.digest();
  }
}

async function existingTableNames(
  database: SQLite.SQLiteDatabase,
): Promise<Set<string>> {
  const result = await execute(
    database,
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  const names = new Set<string>();
  for (let index = 0; index < result.rows.length; index += 1) {
    names.add(String(result.rows.item(index).name || ''));
  }
  return names;
}

async function readPhysicalColumns(
  database: SQLite.SQLiteDatabase,
  table: string,
): Promise<PhysicalColumn[]> {
  const result = await execute(
    database,
    `PRAGMA table_info(${quoteIdentifier(table)})`,
  );
  const columns: PhysicalColumn[] = [];
  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows.item(index);
    const name = String(row.name || '');
    if (!name) continue;
    columns.push({
      name,
      declaredType: String(row.type || ''),
      primaryKeyOrder: Number(row.pk || 0),
    });
  }
  if (columns.length === 0) {
    throw new Error(`Schema-recovery backup could not inspect table ${table}`);
  }
  return columns;
}

async function supportsRowId(
  database: SQLite.SQLiteDatabase,
  table: string,
): Promise<boolean> {
  try {
    await execute(
      database,
      `SELECT rowid FROM ${quoteIdentifier(table)} LIMIT 1`,
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such column:\s*rowid|without rowid/i.test(message)) return false;
    throw error;
  }
}

function primaryKeyColumns(columns: PhysicalColumn[]): PhysicalColumn[] {
  return columns
    .filter(column => column.primaryKeyOrder > 0)
    .sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder);
}

function buildRowLocator(
  columns: PhysicalColumn[],
  row: Record<string, any>,
  absoluteOffset: number,
  rowIdSupported: boolean,
): RowLocator {
  const primaryKeys = primaryKeyColumns(columns);
  if (
    primaryKeys.length > 0 &&
    primaryKeys.every(column => Object.prototype.hasOwnProperty.call(row, column.name))
  ) {
    return {
      whereSql: primaryKeys
        .map(column => `${quoteIdentifier(column.name)} IS ?`)
        .join(' AND '),
      params: primaryKeys.map(column => row[column.name]),
    };
  }
  if (rowIdSupported && row[RECOVERY_ROW_ID_ALIAS] !== undefined) {
    return {
      whereSql: `rowid = ?`,
      params: [row[RECOVERY_ROW_ID_ALIAS]],
    };
  }
  return { params: [], fallbackOffset: absoluteOffset };
}

function locatorSuffix(locator: RowLocator): { sql: string; params: any[] } {
  if (locator.whereSql) {
    return {
      sql: ` WHERE ${locator.whereSql} LIMIT 1`,
      params: locator.params,
    };
  }
  if (locator.fallbackOffset === undefined) {
    throw new Error('Schema-recovery backup has no row locator');
  }
  return {
    sql: ' LIMIT 1 OFFSET ?',
    params: [locator.fallbackOffset],
  };
}

async function readTextLength(
  database: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  locator: RowLocator,
): Promise<number | null> {
  const suffix = locatorSuffix(locator);
  const result = await execute(
    database,
    `SELECT CASE WHEN ${quoteIdentifier(column)} IS NULL THEN NULL ELSE LENGTH(CAST(${quoteIdentifier(column)} AS TEXT)) END AS "__shinewriter_schema_recovery_length" FROM ${quoteIdentifier(table)}${suffix.sql}`,
    suffix.params,
  );
  if (result.rows.length === 0) {
    throw new Error(`Schema-recovery backup could not re-read ${table}.${column}`);
  }
  const value = result.rows.item(0).__shinewriter_schema_recovery_length;
  if (value === null || value === undefined) return null;
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`Schema-recovery backup found invalid length for ${table}.${column}`);
  }
  return length;
}

async function readTextChunk(
  database: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  locator: RowLocator,
  offset: number,
): Promise<string> {
  const suffix = locatorSuffix(locator);
  const result = await execute(
    database,
    `SELECT substr(CAST(${quoteIdentifier(column)} AS TEXT), ?, ?) AS "__shinewriter_schema_recovery_chunk" FROM ${quoteIdentifier(table)}${suffix.sql}`,
    [offset, RECOVERY_TEXT_CHUNK_SIZE_CHARS, ...suffix.params],
  );
  if (result.rows.length === 0) {
    throw new Error(`Schema-recovery backup could not read ${table}.${column}`);
  }
  const chunk = result.rows.item(0).__shinewriter_schema_recovery_chunk;
  if (chunk === null || chunk === undefined) {
    throw new Error(`Schema-recovery backup lost ${table}.${column} while streaming`);
  }
  return String(chunk);
}

async function streamTextColumn(
  database: SQLite.SQLiteDatabase,
  writer: SchemaRecoveryJsonWriter,
  table: string,
  column: string,
  locator: RowLocator,
): Promise<void> {
  const length = await readTextLength(database, table, column, locator);
  if (length === null) {
    await writer.append('null');
    return;
  }
  await writer.append('"');
  if (length === 0) {
    await writer.append('"');
    return;
  }

  const escapeState: JsonTextEscapeState = { pendingHighSurrogate: '' };
  let offset = 1;
  let consumed = 0;
  while (consumed < length) {
    const chunk = await readTextChunk(database, table, column, locator, offset);
    if (chunk.length === 0) {
      throw new Error(`Schema-recovery backup received an empty ${table}.${column} chunk`);
    }
    const characterCount = countUnicodeCharacters(chunk);
    if (characterCount <= 0) {
      throw new Error(`Schema-recovery backup received an invalid ${table}.${column} chunk`);
    }
    await writeEscapedJsonText(writer, chunk, escapeState);
    consumed += characterCount;
    offset += characterCount;
    if (consumed > length) {
      throw new Error(`Schema-recovery backup over-read ${table}.${column}`);
    }
  }
  await writer.append('"');
}

function excludedColumnsFor(table: TableManifest): Set<string> {
  return new Set([
    ...(table.backupExcludedColumns || []),
    ...(table.schemaRecoveryExcludedColumns || []),
  ]);
}

async function streamTableRows(
  database: SQLite.SQLiteDatabase,
  writer: SchemaRecoveryJsonWriter,
  table: TableManifest,
): Promise<RecoveryRowStreamResult> {
  const columns = await readPhysicalColumns(database, table.name);
  const physicalByName = new Map(columns.map(column => [column.name, column]));
  const excluded = excludedColumnsFor(table);
  const outputColumns = table.columns
    .filter(column => physicalByName.has(column))
    .filter(column => !excluded.has(column) && !isSensitiveKey(column));
  if (outputColumns.length === 0) {
    throw new Error(`Schema-recovery backup has no recoverable columns for ${table.name}`);
  }

  const primaryKeys = primaryKeyColumns(columns);
  const rowIdSupported = primaryKeys.length === 0
    ? await supportsRowId(database, table.name)
    : false;
  const baseColumns = Array.from(
    new Set([
      ...outputColumns
        .map(column => physicalByName.get(column) as PhysicalColumn)
        .filter(column => !isTextColumn(column)),
      ...primaryKeys,
    ]),
  );
  if (rowIdSupported) {
    baseColumns.push({
      name: RECOVERY_ROW_ID_ALIAS,
      declaredType: 'INTEGER',
      primaryKeyOrder: 0,
    });
  }

  const selectColumns = baseColumns.length > 0
    ? baseColumns
      .map(column =>
        column.name === RECOVERY_ROW_ID_ALIAS
          ? `rowid AS ${quoteIdentifier(RECOVERY_ROW_ID_ALIAS)}`
          : quoteIdentifier(column.name),
      )
      .join(', ')
    : '1 AS "__shinewriter_schema_recovery_dummy"';
  const orderColumns = primaryKeys.length > 0
    ? primaryKeys.map(column => quoteIdentifier(column.name)).join(', ')
    : rowIdSupported ? 'rowid' : '';
  let offset = 0;
  let rows = 0;
  let firstRow = true;

  await writer.append('[');
  while (true) {
    const orderSql = orderColumns ? ` ORDER BY ${orderColumns}` : '';
    const result = await execute(
      database,
      `SELECT ${selectColumns} FROM ${quoteIdentifier(table.name)}${orderSql} LIMIT ? OFFSET ?`,
      [RECOVERY_ROW_BATCH_SIZE, offset],
    );
    if (result.rows.length === 0) break;

    for (let index = 0; index < result.rows.length; index += 1) {
      const rawRow = result.rows.item(index) as Record<string, any>;
      const cleanRow = sanitizeBackupRow(table.name, rawRow);
      offset += 1;
      if (cleanRow === null) continue;

      const locator = buildRowLocator(columns, rawRow, offset - 1, rowIdSupported);
      if (!firstRow) await writer.append(',');
      firstRow = false;
      await writer.append('{');
      let firstColumn = true;
      for (const column of outputColumns) {
        if (!firstColumn) await writer.append(',');
        firstColumn = false;
        await writer.append(`${JSON.stringify(column)}:`);
        const physicalColumn = physicalByName.get(column) as PhysicalColumn;
        if (isTextColumn(physicalColumn)) {
          await streamTextColumn(database, writer, table.name, column, locator);
        } else {
          await writer.append(serializeScalar(cleanRow[column], table.name, column));
        }
      }
      await writer.append('}');
      rows += 1;
    }
  }
  await writer.append(']');
  return { rows };
}

async function liveCoreCounts(
  database: SQLite.SQLiteDatabase,
  availableTables: Set<string>,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of CORE_RECOVERY_TABLES) {
    if (!availableTables.has(table)) {
      counts[table] = -1;
      continue;
    }
    if (table === 'settings') {
      const result = await execute(
        database,
        `SELECT key FROM ${quoteIdentifier(table)}`,
      );
      let count = 0;
      for (let index = 0; index < result.rows.length; index += 1) {
        if (!isSensitiveKey(String(result.rows.item(index).key || ''))) count += 1;
      }
      counts[table] = count;
      continue;
    }
    const result = await execute(
      database,
      `SELECT COUNT(*) AS c FROM ${quoteIdentifier(table)}`,
    );
    counts[table] = Number(result.rows.item(0)?.c ?? 0);
    if (!Number.isSafeInteger(counts[table]) || counts[table] < 0) {
      throw new Error(`Schema-recovery backup received an invalid row count for ${table}`);
    }
  }
  return counts;
}

async function cleanupSchemaRecoveryStagingFiles(): Promise<void> {
  try {
    const files = await RNFS.readDir(SCHEMA_RECOVERY_DIR);
    for (const file of files) {
      if (!file.name.endsWith('.tmp')) continue;
      try {
        await RNFS.unlink(file.path);
      } catch {
        // A stale staging file is best-effort cleanup; a current write still
        // remains fail-closed if its own unlink or rename fails.
      }
    }
  } catch {
    // Directory creation/read failure is handled by the active writer.
  }
}

/**
 * Create a schema-recovery backup without materializing the complete payload,
 * any table, or any large text column in JavaScript memory.
 *
 * The on-disk format remains standard v3. The SHA-256 input is the exact
 * JSON.stringify field order used by computeBackupChecksum, with only the
 * checksum field omitted. A fixed-width placeholder lets the checksum be
 * patched without a second full-file read or rewrite.
 */
export async function createSchemaRecoveryBackup(
  database: SQLite.SQLiteDatabase,
  kind: 'pre_migration' | 'schema_recovery' = 'schema_recovery',
  sourceSchemaVersion?: number,
): Promise<SchemaRecoveryBackupResult> {
  await RNFS.mkdir(SCHEMA_RECOVERY_DIR);
  await cleanupSchemaRecoveryStagingFiles();

  const availableTables = await existingTableNames(database);
  const liveCounts = await liveCoreCounts(database, availableTables);
  const appVersion = appVersionJson.versionName.replace(/^V/, '');
  const metaBase = {
    app_version: appVersion,
    schema_version: sourceSchemaVersion ?? SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    kind,
    checksum_algorithm: 'sha256',
  } as const;
  const logicalMeta = JSON.stringify(metaBase);
  const actualMeta = JSON.stringify({
    ...metaBase,
    checksum: CHECKSUM_PLACEHOLDER,
  });
  const checksumMarker = `"checksum":"${CHECKSUM_PLACEHOLDER}"`;
  const markerOffset = actualMeta.indexOf(checksumMarker);
  if (markerOffset < 0) {
    throw new Error('Schema-recovery backup could not locate checksum placeholder');
  }

  const timestamp = Date.now();
  const destName = `schemarecovery_v${appVersion}_${timestamp}.json`;
  const destPath = `${SCHEMA_RECOVERY_DIR}/${destName}`;
  const stagingPath = `${destPath}.tmp`;
  const writer = new SchemaRecoveryJsonWriter(stagingPath);
  let checksumPosition = 0;

  try {
    // Initialize the staging file with no user-sized content. All following
    // writes are append-only bounded chunks until the fixed checksum patch.
    await RNFS.writeFile(stagingPath, '', 'utf8');

    const prefix = `{"format":${JSON.stringify('shinewriter-backup')},"format_version":3,"meta":`;
    await writer.append(prefix);
    checksumPosition = writer.currentByteOffset
      + utf8ByteLength(actualMeta.slice(0, markerOffset + `"checksum":"`.length));
    await writer.append(actualMeta, logicalMeta);
    await writer.append(',"tables":{');

    let firstTable = true;
    for (const table of SCHEMA_RECOVERY_MANIFEST) {
      if (!availableTables.has(table.name)) {
        if (CORE_RECOVERY_TABLE_SET.has(table.name)) {
          throw new Error(`核心备份表缺失：${table.name}`);
        }
        continue;
      }
      if (!firstTable) await writer.append(',');
      firstTable = false;
      await writer.append(`${JSON.stringify(table.name)}:`);
      const streamed = await streamTableRows(database, writer, table);
      if (CORE_RECOVERY_TABLE_SET.has(table.name)) {
        const expected = liveCounts[table.name];
        if (expected >= 0 && streamed.rows !== expected) {
          throw new Error(
            `Schema-recovery backup row-count mismatch for ${table.name}: live=${expected} backed=${streamed.rows}`,
          );
        }
      }
    }

    await writer.append('},"external_assets":[]}', '},"external_assets":[]}');
    await writer.flush();
    const checksum = writer.digest();
    if (!/^[0-9a-f]{64}$/.test(checksum)) {
      throw new Error('Schema-recovery backup produced an invalid checksum');
    }

    // `position` is a byte offset in RNFS. The placeholder is fixed-width
    // ASCII, so this patch cannot change the file length or JSON structure.
    await RNFS.write(stagingPath, checksum, checksumPosition, 'utf8');
    await RNFS.moveFile(stagingPath, destPath);

    return {
      path: destPath,
      checksum,
      verified: true,
      coreCounts: liveCounts,
    };
  } catch (error) {
    try {
      await RNFS.unlink(stagingPath);
    } catch {
      // The write can fail before the staging file exists. Never remove an
      // existing completed .json recovery file while handling this failure.
    }
    throw error;
  }
}

/**
 * Legacy name retained for callers. Recovery JSON files are never pruned:
 * they may be the only usable copy during an incident. Only stale staging
 * `.tmp` files are cleaned.
 */
export async function pruneSchemaRecoveryBackups(): Promise<void> {
  await cleanupSchemaRecoveryStagingFiles();
}
