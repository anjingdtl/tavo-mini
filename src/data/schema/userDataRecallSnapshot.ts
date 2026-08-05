/**
 * User-data recall snapshot: captures the identity of the user's irreplaceable
 * creative data before and after a schema repair / migration, so the startup
 * chain can assert nothing was silently dropped.
 *
 * Characters, worldbook entries, and their collections must keep their EXACT id
 * set. Projects and chapters must not decrease. Link tables
 * (`project_resources`, `project_collection_settings`) must keep their exact
 * composite-key set.
 *
 * The snapshot reads complete id sets in chunks (to avoid a single giant
 * result set on large libraries) and computes count/min/max/sum for a cheap
 * fast-path equality check.
 */
import type SQLite from 'react-native-sqlite-storage';
import { execute } from '../connection/execute';

const RECALL_CHUNK_SIZE = 2000;

export interface IdentitySummary {
  count: number;
  minId: number | null;
  maxId: number | null;
  sumId: number;
  /** Complete id set (chunked read). Used for strict equality on key tables. */
  ids: number[];
}

export interface LinkSummary {
  count: number;
  /** Composite-key strings, sorted. e.g. "1:character:7". */
  keys: string[];
}

export interface UserDataRecallSnapshot {
  projects: IdentitySummary;
  chapters: IdentitySummary;
  characterCollections: IdentitySummary;
  characters: IdentitySummary;
  worldbookCollections: IdentitySummary;
  worldbookEntries: IdentitySummary;
  notes: IdentitySummary;
  projectResources: LinkSummary;
  projectCollectionSettings: LinkSummary;
}

export interface RecallMismatch {
  table: string;
  reason: string;
  beforeCount: number;
  afterCount: number;
  /**
   * Ids present before but missing after (data loss). Empty when counts match
   * but ids differ (a rewrite rather than a drop).
   */
  missingIds?: number[];
}

async function readIdentity(
  database: SQLite.SQLiteDatabase,
  table: string,
  idColumn: string,
): Promise<IdentitySummary> {
  // Aggregate stats in one cheap query.
  const stats = await execute(
    database,
    `SELECT COUNT(*) AS count, MIN(${idColumn}) AS min_id, MAX(${idColumn}) AS max_id, COALESCE(SUM(${idColumn}), 0) AS sum_id FROM ${table}`,
  );
  const row = stats.rows.item(0) ?? {};
  const count = Number(row.count ?? 0);
  const minId = row.min_id === null || row.min_id === undefined ? null : Number(row.min_id);
  const maxId = row.max_id === null || row.max_id === undefined ? null : Number(row.max_id);
  const sumId = Number(row.sum_id ?? 0);

  // Chunked id read for strict set equality.
  const ids: number[] = [];
  let offset = 0;
  while (true) {
    const batch = await execute(
      database,
      `SELECT ${idColumn} AS id FROM ${table} ORDER BY ${idColumn} ASC LIMIT ? OFFSET ?`,
      [RECALL_CHUNK_SIZE, offset],
    );
    const batchLen = batch.rows.length;
    for (let i = 0; i < batchLen; i++) {
      ids.push(Number(batch.rows.item(i).id));
    }
    if (batchLen < RECALL_CHUNK_SIZE) break;
    offset += RECALL_CHUNK_SIZE;
  }

  return { count, minId, maxId, sumId, ids };
}

async function readLinkKeys(
  database: SQLite.SQLiteDatabase,
  table: string,
  columns: string[],
): Promise<LinkSummary> {
  const colList = columns.join(', ');
  const stats = await execute(
    database,
    `SELECT COUNT(*) AS count FROM ${table}`,
  );
  const count = Number(stats.rows.item(0)?.count ?? 0);

  const keys: string[] = [];
  let offset = 0;
  while (true) {
    const batch = await execute(
      database,
      `SELECT ${colList} FROM ${table} LIMIT ? OFFSET ?`,
      [RECALL_CHUNK_SIZE, offset],
    );
    const batchLen = batch.rows.length;
    for (let i = 0; i < batchLen; i++) {
      const r = batch.rows.item(i);
      keys.push(columns.map(c => String(r[c] ?? '')).join(':'));
    }
    if (batchLen < RECALL_CHUNK_SIZE) break;
    offset += RECALL_CHUNK_SIZE;
  }
  keys.sort();
  return { count, keys };
}

/**
 * Capture a user-data recall snapshot. Tables are read defensively — a missing
 * table or query error yields an empty identity rather than throwing, so the
 * caller can still run the before/after comparison (an empty→empty result is
 * a pass; a populated→empty is a flagged mismatch).
 */
export async function captureUserDataRecallSnapshot(
  database: SQLite.SQLiteDatabase,
): Promise<UserDataRecallSnapshot> {
  const safe = async (
    fn: () => Promise<IdentitySummary>,
  ): Promise<IdentitySummary> => {
    try {
      return await fn();
    } catch {
      return { count: 0, minId: null, maxId: null, sumId: 0, ids: [] };
    }
  };
  const safeLink = async (
    fn: () => Promise<LinkSummary>,
  ): Promise<LinkSummary> => {
    try {
      return await fn();
    } catch {
      return { count: 0, keys: [] };
    }
  };

  const [
    projects,
    chapters,
    characterCollections,
    characters,
    worldbookCollections,
    worldbookEntries,
    notes,
    projectResources,
    projectCollectionSettings,
  ] = await Promise.all([
    safe(() => readIdentity(database, 'projects', 'id')),
    safe(() => readIdentity(database, 'chapters', 'id')),
    safe(() => readIdentity(database, 'character_collections', 'id')),
    safe(() => readIdentity(database, 'characters', 'id')),
    safe(() => readIdentity(database, 'worldbook_collections', 'id')),
    safe(() => readIdentity(database, 'worldbook_entries', 'id')),
    safe(() => readIdentity(database, 'notes', 'id')),
    safeLink(() =>
      readLinkKeys(database, 'project_resources', [
        'project_id',
        'resource_type',
        'resource_id',
      ]),
    ),
    safeLink(() =>
      readLinkKeys(database, 'project_collection_settings', [
        'project_id',
        'resource_type',
        'collection_id',
      ]),
    ),
  ]);

  return {
    projects,
    chapters,
    characterCollections,
    characters,
    worldbookCollections,
    worldbookEntries,
    notes,
    projectResources,
    projectCollectionSettings,
  };
}

function identityMismatch(
  table: string,
  before: IdentitySummary,
  after: IdentitySummary,
): RecallMismatch | null {
  if (before.count === after.count && before.sumId === after.sumId) {
    // Fast path: stats match. For key tables, still verify exact id set.
    const beforeSet = new Set(before.ids);
    const afterSet = new Set(after.ids);
    if (beforeSet.size === afterSet.size) {
      let allPresent = true;
      for (const id of before.ids) {
        if (!afterSet.has(id)) {
          allPresent = false;
          break;
        }
      }
      if (allPresent) return null;
    }
  }
  const missing = before.ids.filter(id => !new Set(after.ids).has(id));
  return {
    table,
    reason:
      missing.length > 0
        ? `${missing.length} id(s) lost`
        : 'id set changed without count loss',
    beforeCount: before.count,
    afterCount: after.count,
    missingIds: missing.length > 0 ? missing : undefined,
  };
}

function countGuard(
  table: string,
  before: IdentitySummary,
  after: IdentitySummary,
): RecallMismatch | null {
  // Projects and chapters must not DECREASE (a same-count rewrite is allowed
  // for chapters since migration 38→39 may rewrite JSON, but never a drop).
  if (after.count < before.count) {
    return {
      table,
      reason: `${before.count - after.count} row(s) lost`,
      beforeCount: before.count,
      afterCount: after.count,
    };
  }
  return null;
}

function linkMismatch(
  table: string,
  before: LinkSummary,
  after: LinkSummary,
): RecallMismatch | null {
  if (before.count === after.count) {
    const beforeKeys = new Set(before.keys);
    const afterKeys = new Set(after.keys);
    if (beforeKeys.size === afterKeys.size) {
      let allPresent = true;
      for (const k of before.keys) {
        if (!afterKeys.has(k)) {
          allPresent = false;
          break;
        }
      }
      if (allPresent) return null;
    }
  }
  const missing = before.keys.filter(k => !new Set(after.keys).has(k));
  return {
    table,
    reason:
      missing.length > 0
        ? `${missing.length} composite key(s) lost`
        : 'composite keys changed',
    beforeCount: before.count,
    afterCount: after.count,
  };
}

/**
 * Compare before/after recall snapshots. Returns null when all data is
 * intact, or a {@link RecallMismatch} describing the first divergence.
 */
export function compareRecallSnapshots(
  before: UserDataRecallSnapshot,
  after: UserDataRecallSnapshot,
): RecallMismatch | null {
  // Strict id-set equality for irreplaceable creative resources.
  const strictTables: Array<{
    table: string;
    before: IdentitySummary;
    after: IdentitySummary;
  }> = [
    { table: 'character_collections', before: before.characterCollections, after: after.characterCollections },
    { table: 'characters', before: before.characters, after: after.characters },
    { table: 'worldbook_collections', before: before.worldbookCollections, after: after.worldbookCollections },
    { table: 'worldbook_entries', before: before.worldbookEntries, after: after.worldbookEntries },
    { table: 'notes', before: before.notes, after: after.notes },
  ];
  for (const entry of strictTables) {
    const mismatch = identityMismatch(entry.table, entry.before, entry.after);
    if (mismatch) return mismatch;
  }

  // Non-decreasing guard for projects / chapters.
  const guardedTables: Array<{
    table: string;
    before: IdentitySummary;
    after: IdentitySummary;
  }> = [
    { table: 'projects', before: before.projects, after: after.projects },
    { table: 'chapters', before: before.chapters, after: after.chapters },
  ];
  for (const entry of guardedTables) {
    const mismatch = countGuard(entry.table, entry.before, entry.after);
    if (mismatch) return mismatch;
  }

  // Strict composite-key equality for link tables.
  const linkTables: Array<{
    table: string;
    before: LinkSummary;
    after: LinkSummary;
  }> = [
    { table: 'project_resources', before: before.projectResources, after: after.projectResources },
    { table: 'project_collection_settings', before: before.projectCollectionSettings, after: after.projectCollectionSettings },
  ];
  for (const entry of linkTables) {
    const mismatch = linkMismatch(entry.table, entry.before, entry.after);
    if (mismatch) return mismatch;
  }

  return null;
}
