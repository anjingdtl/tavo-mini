import type SQLite from 'react-native-sqlite-storage';
import { executeTransaction, type SqlStatement } from '../database/transaction';
import { countProjectBodyChars } from '../projectWritingStats';

export const PROJECT_WRITING_STATS_REBUILD_CHUNK_SIZE = 64;

export function buildProjectWritingStatsCreateSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS project_writing_stats (
      project_id INTEGER PRIMARY KEY,
      chapter_count INTEGER NOT NULL DEFAULT 0 CHECK(chapter_count >= 0),
      body_char_count INTEGER NOT NULL DEFAULT 0 CHECK(body_char_count >= 0),
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`;
}

function buildChapterDeltaStatement(
  projectId: number,
  chapterCount: number,
  bodyCharCount: number,
  timestamp: string,
): SqlStatement {
  return {
    sql: `INSERT INTO project_writing_stats
      (project_id, chapter_count, body_char_count, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        chapter_count = project_writing_stats.chapter_count + excluded.chapter_count,
        body_char_count = project_writing_stats.body_char_count + excluded.body_char_count,
        updated_at = excluded.updated_at`,
    params: [projectId, chapterCount, bodyCharCount, timestamp],
  };
}

function rowsFromResult(result: any): any[] {
  const rows: any[] = [];
  for (let index = 0; index < result.rows.length; index += 1) {
    rows.push(result.rows.item(index));
  }
  return rows;
}

async function tableExists(
  db: SQLite.SQLiteDatabase,
  tableName: string,
): Promise<boolean> {
  const [result] = await db.executeSql(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    [tableName],
  );
  return result.rows.length > 0;
}

/**
 * Schema 58 → 59. The projection is derived data, so the migration always
 * clears and rebuilds it from the authoritative `projects`/`chapters` rows.
 * Chapter bodies are read in small narrow batches, never as one giant result.
 */
export async function migrateV58ToV59(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  // Some historical migration tests intentionally use a minimal database that
  // contains only the tables under test. The production Schema 58 always has
  // both authorities; on a partial fixture there is no safe projection to
  // rebuild, so leave the fixture untouched and let the runner advance its
  // version marker as it does for other additive migrations.
  if (
    !(await tableExists(db, 'projects')) ||
    !(await tableExists(db, 'chapters'))
  ) {
    return;
  }
  const timestamp = new Date().toISOString();
  await executeTransaction(
    db,
    [
      { sql: buildProjectWritingStatsCreateSql() },
      { sql: 'DELETE FROM project_writing_stats' },
      {
        sql: `INSERT INTO project_writing_stats
          (project_id, chapter_count, body_char_count, updated_at)
          SELECT id, 0, 0, ? FROM projects`,
        params: [timestamp],
      },
    ],
    { faultDomain: 'migration' },
  );

  let lastChapterId = 0;
  while (true) {
    const [result] = await db.executeSql(
      `SELECT id, project_id, content
       FROM chapters
       WHERE id > ?
       ORDER BY id ASC
       LIMIT ?`,
      [lastChapterId, PROJECT_WRITING_STATS_REBUILD_CHUNK_SIZE],
    );
    const rows = rowsFromResult(result);
    if (rows.length === 0) break;

    const totals = new Map<
      number,
      { chapterCount: number; bodyCharCount: number }
    >();
    for (const row of rows) {
      const projectId = Number(row.project_id);
      const current = totals.get(projectId) ?? {
        chapterCount: 0,
        bodyCharCount: 0,
      };
      current.chapterCount += 1;
      current.bodyCharCount += countProjectBodyChars(row.content);
      totals.set(projectId, current);
      lastChapterId = Number(row.id);
    }

    await executeTransaction(
      db,
      Array.from(totals.entries()).map(([projectId, total]) =>
        buildChapterDeltaStatement(
          projectId,
          total.chapterCount,
          total.bodyCharCount,
          timestamp,
        ),
      ),
      { faultDomain: 'migration' },
    );
  }
}
