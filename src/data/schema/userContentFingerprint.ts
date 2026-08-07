/**
 * CL-03: content-level user data fingerprint.
 *
 * The legacy `userDataRecallSnapshot` only proves count / min / max / sum /
 * id-set preservation — a same-count rewrite of a chapter body or a character
 * card passes it silently. This module fingerprints the IRREPLACEABLE content
 * columns of the user's creative data:
 *
 *   projects                   id + name + mode
 *   chapters                   id + project_id + position + title + synopsis + content + summary_json
 *   characters                 id + project_id + collection_id + name + source_type + data_json
 *   worldbook_entries          id + project_id + collection_id + keyword_primary + keyword_secondary + content + comment + enabled + constant + position
 *   notes                      id + project_id + collection_id + title + content
 *   project_resources          project_id + resource_type + resource_id + enabled
 *   project_collection_settings project_id + resource_type + collection_id + enabled
 *
 * Rules:
 *   - rows are sorted by their stable key columns before hashing
 *   - values are explicitly normalized: null ≠ '' ≠ 0 ≠ false ≠ missing column
 *   - per-row SHA-256 over the normalized JSON, then a per-table aggregate
 *     SHA-256 over (rowCount, sorted row hashes) — any content rewrite flips
 *     the aggregate
 *   - FAIL-CLOSED: any read error on a table that exists throws (never
 *     `catch { return emptySnapshot }`)
 *   - tables that do not exist are recorded as `missing` (distinct from an
 *     empty table)
 *
 * Migration allowlist: v4→v5 / v10→v11 normalize `collection_id = 0` into a
 * real collection binding. When upgrading from schema < 11 the caller passes
 * `allowCollectionIdMigration: true` and collection_id-only differences are
 * ignored (all other columns are still strict).
 */
import type SQLite from 'react-native-sqlite-storage';
import { execute } from '../connection/execute';
import { tableColumns } from '../../services/migrations/helpers';
import { sha256Hex } from '../../services/continuation/hashUtils';

export interface ContentFingerprintTableSpec {
  label: string;
  table: string;
  keyColumns: readonly string[];
  valueColumns: readonly string[];
}

/**
 * The content columns that MUST round-trip through any migration / repair.
 * Ordered deterministically; every row of every table is hashed.
 */
export const CONTENT_FINGERPRINT_TABLES: readonly ContentFingerprintTableSpec[] = [
  {
    label: 'projects',
    table: 'projects',
    keyColumns: ['id'],
    valueColumns: ['id', 'name', 'mode'],
  },
  {
    label: 'chapters',
    table: 'chapters',
    keyColumns: ['id'],
    valueColumns: [
      'id',
      'project_id',
      'position',
      'title',
      'synopsis',
      'content',
      'summary_json',
    ],
  },
  {
    label: 'characters',
    table: 'characters',
    keyColumns: ['id'],
    valueColumns: [
      'id',
      'project_id',
      'collection_id',
      'name',
      'source_type',
      'data_json',
    ],
  },
  {
    label: 'worldbook_entries',
    table: 'worldbook_entries',
    keyColumns: ['id'],
    valueColumns: [
      'id',
      'project_id',
      'collection_id',
      'keyword_primary',
      'keyword_secondary',
      'content',
      'comment',
      'enabled',
      'constant',
      'position',
    ],
  },
  {
    label: 'notes',
    table: 'notes',
    keyColumns: ['id'],
    valueColumns: [
      'id',
      'project_id',
      'collection_id',
      'title',
      'content',
    ],
  },
  {
    label: 'project_resources',
    table: 'project_resources',
    keyColumns: ['project_id', 'resource_type', 'resource_id'],
    valueColumns: ['project_id', 'resource_type', 'resource_id', 'enabled'],
  },
  {
    label: 'project_collection_settings',
    table: 'project_collection_settings',
    keyColumns: ['project_id', 'resource_type', 'collection_id'],
    valueColumns: [
      'project_id',
      'resource_type',
      'collection_id',
      'enabled',
    ],
  },
];

export const MAX_ROW_HASH_MAP_ROWS = 200_000;

/** Explicit normalization tokens — null ≠ '' ≠ 0 ≠ false ≠ missing column. */
const MISSING_COLUMN_TOKEN = '<<column-missing>>';

export function normalizeFingerprintValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') {
    if (value.length === 0) return '""';
    return value;
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return JSON.stringify(value.map(normalizeFingerprintValue));
  }
  if (typeof value === 'object') {
    // Stable key order for objects (summary_json etc.).
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys.map(
      k => `${JSON.stringify(k)}:${normalizeFingerprintValue(record[k])}`,
    );
    return `{${parts.join(',')}}`;
  }
  return String(value);
}

export interface ContentFingerprintTable {
  /** Whether the physical table exists in this database. */
  missing: boolean;
  rowCount: number;
  /** Value columns actually present when captured (sorted). */
  columnsUsed: string[];
  /**
   * Per-column aggregate hash (sorted per-column value hashes). Lets the
   * comparator align two snapshots captured under different column sets
   * (migrations that ADD columns) while still proving unchanged columns.
   * Only populated when rowCount <= MAX_ROW_HASH_MAP_ROWS.
   */
  columnAggregates: Record<string, string>;
  /** Per-row hash map (stable key → row hash). Empty when rowCount > cap. */
  rowHashes: Map<string, string>;
  /** Aggregate SHA-256 over (rowCount, sorted row hashes). */
  aggregateHash: string;
}

export interface UserContentFingerprint {
  /** Table label → fingerprint. */
  tables: Record<string, ContentFingerprintTable>;
  /** SHA-256 over all table aggregates (fast equality check). */
  overallHash: string;
  capturedAt: number;
}

export interface ContentFingerprintMismatch {
  table: string;
  reason: 'row_count' | 'row_content' | 'table_missing' | 'table_appeared';
  /** Stable key of the first differing row (row_content only). */
  rowKey?: string;
  detail: string;
}

/** Columns ignored for comparison when the migration allowlist is active. */
const COLLECTION_ID_ALLOWLIST_COLUMNS = new Set(['collection_id']);

function rowHash(
  spec: ContentFingerprintTableSpec,
  row: Record<string, unknown>,
  missingColumns: Set<string>,
): string {
  const normalized = spec.valueColumns.map(column => {
    if (missingColumns.has(column)) return `${column}=${MISSING_COLUMN_TOKEN}`;
    const raw = (row as Record<string, unknown>)[column];
    return `${column}=${normalizeFingerprintValue(raw)}`;
  });
  return sha256Hex(normalized.join('\u0001'));
}

function rowKeyOf(
  spec: ContentFingerprintTableSpec,
  row: Record<string, unknown>,
): string {
  return spec.keyColumns
    .map(column => `${column}=${normalizeFingerprintValue(row[column])}`)
    .join('\u0001');
}

/**
 * Capture a content-level fingerprint of every covered table.
 * Fail-closed: an existing table whose SELECT throws propagates the error.
 */
export async function captureUserContentFingerprint(
  database: SQLite.SQLiteDatabase,
): Promise<UserContentFingerprint> {
  const tables: Record<string, ContentFingerprintTable> = {};
  const tableAggregates: string[] = [];

  for (const spec of CONTENT_FINGERPRINT_TABLES) {
    let columns: Set<string>;
    try {
      columns = new Set(await tableColumns(database, spec.table));
    } catch (error: any) {
      // Fail-closed: a PRAGMA error is NOT "table missing" — propagate.
      // (SQLite returns an empty result set for a truly missing table.)
      throw new Error(
        `内容指纹读取失败：${spec.table}（${error?.message ?? String(error)}）`,
      );
    }
    if (columns.size === 0) {
      // Table missing — record `missing` (distinct from an empty table).
      tables[spec.label] = {
        missing: true,
        rowCount: 0,
        columnsUsed: [],
        columnAggregates: {},
        rowHashes: new Map(),
        aggregateHash: sha256Hex('missing-table'),
      };
      tableAggregates.push(`${spec.label}:${sha256Hex('missing-table')}`);
      continue;
    }

    const available = spec.valueColumns.filter(column => columns.has(column));
    const missingColumns = new Set(
      spec.valueColumns.filter(column => !columns.has(column)),
    );
    const keyAvailable = spec.keyColumns.filter(column => columns.has(column));
    const selectColumns = [...keyAvailable, ...available];
    if (selectColumns.length === 0) {
      throw new Error(
        `内容指纹读取失败：表 ${spec.table} 无可用列`,
      );
    }

    let result;
    try {
      result = await execute(
        database,
        `SELECT ${selectColumns.join(', ')} FROM ${spec.table}`,
      );
    } catch (error: any) {
      // Fail-closed: never swallow a read error into an empty snapshot.
      throw new Error(
        `内容指纹读取失败：${spec.table}（${error?.message ?? String(error)}）`,
      );
    }

    const rows: Array<{ key: string; hash: string }> = [];
    // Per-column value hashes for column-set alignment (bounded by the cap).
    const columnValues: Record<string, string[]> = {};
    for (const column of available) columnValues[column] = [];

    for (let i = 0; i < result.rows.length; i += 1) {
      const row = result.rows.item(i) as Record<string, unknown>;
      rows.push({ key: rowKeyOf(spec, row), hash: rowHash(spec, row, missingColumns) });
      for (const column of available) {
        columnValues[column].push(
          sha256Hex(normalizeFingerprintValue(row[column])),
        );
      }
    }
    // Stable sort by key before hashing — insertion order must not matter.
    rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const rowHashes = new Map<string, string>();
    const columnAggregates: Record<string, string> = {};
    const bounded = rows.length <= MAX_ROW_HASH_MAP_ROWS;
    if (bounded) {
      for (const row of rows) rowHashes.set(row.key, row.hash);
      for (const [column, values] of Object.entries(columnValues)) {
        values.sort();
        columnAggregates[column] = sha256Hex(JSON.stringify(values));
      }
    }
    const aggregateHash = sha256Hex(
      JSON.stringify([rows.length, rows.map(r => r.hash)]),
    );
    tables[spec.label] = {
      missing: false,
      rowCount: rows.length,
      columnsUsed: [...available].sort(),
      columnAggregates,
      rowHashes,
      aggregateHash,
    };
    tableAggregates.push(`${spec.label}:${aggregateHash}`);
  }

  tableAggregates.sort();
  return {
    tables,
    overallHash: sha256Hex(tableAggregates.join('\u0001')),
    capturedAt: Date.now(),
  };
}

/**
 * Strict compare of two content fingerprints.
 *
 * Column-set alignment: migrations that ADD columns make the raw per-row hash
 * incomparable across snapshots. When the captured column sets differ we
 * compare the shared columns via per-column aggregates (a column that existed
 * BEFORE must be byte-identical AFTER; newly added columns are not asserted).
 * Column REMOVAL (before had a column after lacks it) is a hard mismatch.
 *
 * allowCollectionIdMigration: historical v4→v5 / v10→v11 migrations normalize
 * `collection_id = 0` into a real binding; those differences are ignored when
 * set (all other columns remain strict).
 */
export function compareUserContentFingerprints(
  before: UserContentFingerprint,
  after: UserContentFingerprint,
  options?: { allowCollectionIdMigration?: boolean },
): ContentFingerprintMismatch | null {
  const allow = options?.allowCollectionIdMigration ?? false;

  for (const spec of CONTENT_FINGERPRINT_TABLES) {
    const beforeTable = before.tables[spec.label];
    const afterTable = after.tables[spec.label];
    if (!beforeTable || !afterTable) {
      return {
        table: spec.label,
        reason: 'table_missing',
        detail: `指纹缺少 ${spec.label} 快照`,
      };
    }
    if (beforeTable.missing !== afterTable.missing) {
      return {
        table: spec.label,
        reason: beforeTable.missing ? 'table_appeared' : 'table_missing',
        detail: beforeTable.missing
          ? `升级后出现了新表 ${spec.table}`
          : `升级后表 ${spec.table} 消失`,
      };
    }
    if (beforeTable.missing) continue; // both missing — no data to protect

    if (beforeTable.rowCount !== afterTable.rowCount) {
      return {
        table: spec.label,
        reason: 'row_count',
        detail: `${spec.table} 行数变化：before=${beforeTable.rowCount} after=${afterTable.rowCount}`,
      };
    }

    const effectiveColumns = (columnsUsed: string[]): string[] => {
      if (!allow) return columnsUsed;
      return columnsUsed.filter(c => !COLLECTION_ID_ALLOWLIST_COLUMNS.has(c));
    };
    const beforeColumns = effectiveColumns(beforeTable.columnsUsed);
    const afterColumns = effectiveColumns(afterTable.columnsUsed);

    // Column removal is data loss — hard fail regardless of row hashes.
    const removedColumns = beforeColumns.filter(
      c => !afterColumns.includes(c),
    );
    if (removedColumns.length > 0) {
      return {
        table: spec.label,
        reason: 'row_content',
        detail: `${spec.table} 升级后列消失：${removedColumns.join(', ')}`,
      };
    }

    if (beforeTable.aggregateHash === afterTable.aggregateHash) continue;

    // Column sets aligned → per-row hashes are directly comparable.
    const sameColumnSet =
      beforeColumns.length === afterColumns.length &&
      beforeColumns.every((c, i) => c === afterColumns[i]);

    // Per-column aggregates can prove "every shared column byte-identical"
    // regardless of column-set changes or the collection_id allowlist.
    const columnAggregatesUsable =
      beforeTable.columnAggregates &&
      Object.keys(beforeTable.columnAggregates).length > 0 &&
      afterTable.columnAggregates &&
      Object.keys(afterTable.columnAggregates).length > 0;

    if (allow || !sameColumnSet) {
      // Allowlist (collection_id 归一化) or migrated column set: compare the
      // shared columns via per-column aggregates. Row hashes embed the raw
      // (un-filtered) columns and are NOT comparable in these modes.
      if (columnAggregatesUsable) {
        for (const column of beforeColumns) {
          if (!afterColumns.includes(column)) {
            return {
              table: spec.label,
              reason: 'row_content',
              detail: `${spec.table} 升级后列消失：${column}`,
            };
          }
          if (
            beforeTable.columnAggregates[column] !==
            afterTable.columnAggregates[column]
          ) {
            return {
              table: spec.label,
              reason: 'row_content',
              detail: `${spec.table} 列内容变化：${column}`,
            };
          }
        }
        continue; // shared columns identical — added/allowlisted columns fine
      }
      return {
        table: spec.label,
        reason: 'row_content',
        detail: `${spec.table} 列集变化且行数过大，无法按列对齐校验`,
      };
    }

    if (
      beforeTable.rowHashes.size === beforeTable.rowCount &&
      afterTable.rowHashes.size === afterTable.rowCount
    ) {
      // Locate the first differing row for the audit trail.
      for (const [key, hash] of beforeTable.rowHashes) {
        const afterHash = afterTable.rowHashes.get(key);
        if (afterHash === undefined) {
          return {
            table: spec.label,
            reason: 'row_content',
            rowKey: key,
            detail: `${spec.table} 行缺失（before 有 after 无）：${key}`,
          };
        }
        if (afterHash !== hash) {
          return {
            table: spec.label,
            reason: 'row_content',
            rowKey: key,
            detail: `${spec.table} 行内容变化：${key}`,
          };
        }
      }
      for (const key of afterTable.rowHashes.keys()) {
        if (!beforeTable.rowHashes.has(key)) {
          return {
            table: spec.label,
            reason: 'row_content',
            rowKey: key,
            detail: `${spec.table} 新增行（before 无 after 有）：${key}`,
          };
        }
      }
    }
    return {
      table: spec.label,
      reason: 'row_content',
      detail: `${spec.table} 内容指纹不一致（行数相同但聚合哈希不同）`,
    };
  }
  return null;
}

/** Compact summary for the UI / audit trail. */
export function fingerprintTableSummary(
  fingerprint: UserContentFingerprint,
): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const [label, table] of Object.entries(fingerprint.tables)) {
    summary[label] = table.missing ? -1 : table.rowCount;
  }
  return summary;
}
