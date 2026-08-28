import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import {
  buildProjectWritingStatsCreateSql,
  migrateV58ToV59,
} from '../src/services/migrations/v58-to-v59';

describe('Schema 58 → 59 project writing stats projection', () => {
  it('rebuilds exact chapter and non-whitespace Unicode counts deterministically', async () => {
    const db = await createCanonInMemoryDb();
    try {
      await db.executeSql('DROP TABLE IF EXISTS project_writing_stats');
      await db.executeSql(
        `INSERT INTO projects (id, name, mode, created_at, updated_at)
         VALUES (?, ?, 'outline', ?, ?)`,
        [
          591,
          '统计迁移项目',
          '2026-08-28T00:00:00.000Z',
          '2026-08-28T00:00:00.000Z',
        ],
      );
      await db.executeSql(
        `INSERT INTO chapters
          (project_id, position, title, synopsis, content, status, created_at, updated_at)
         VALUES (?, 0, '第一章', '', ?, 'final', ?, ?)`,
        [
          591,
          ' 第一章\n😀\tA  ',
          '2026-08-28T00:00:00.000Z',
          '2026-08-28T00:00:00.000Z',
        ],
      );
      await db.executeSql(
        `INSERT INTO chapters
          (project_id, position, title, synopsis, content, status, created_at, updated_at)
         VALUES (?, 1, '第二章', '', ?, 'draft', ?, ?)`,
        [
          591,
          '\n第二章内容\n',
          '2026-08-28T00:00:00.000Z',
          '2026-08-28T00:00:00.000Z',
        ],
      );

      await migrateV58ToV59(db as any);

      const result = await db.executeSql(
        `SELECT project_id, chapter_count, body_char_count
         FROM project_writing_stats WHERE project_id = ?`,
        [591],
      );
      expect(result[0].rows.raw()).toEqual([
        { project_id: 591, chapter_count: 2, body_char_count: 10 },
      ]);

      await migrateV58ToV59(db as any);
      const repeated = await db.executeSql(
        'SELECT chapter_count, body_char_count FROM project_writing_stats WHERE project_id = ?',
        [591],
      );
      expect(repeated[0].rows.raw()).toEqual([
        { chapter_count: 2, body_char_count: 10 },
      ]);
    } finally {
      db.close();
    }
  });

  it('exposes the same table DDL to fresh installs', () => {
    expect(buildProjectWritingStatsCreateSql()).toContain(
      'CREATE TABLE IF NOT EXISTS project_writing_stats',
    );
  });
});
