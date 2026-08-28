import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  __resetForTest,
  __setDatabaseForTest,
} from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { openDatabase } from '../src/data/connection/openDatabase';
import {
  createChaptersBulk,
  deleteChapter,
  deleteProjects,
  getAllProjects,
  getChaptersByProjectForExport,
  updateChapter,
} from '../src/data/repositories/projectRepository';

let testDb: InMemorySqliteDb | null = null;

async function seedProject(id: number, name = `项目${id}`): Promise<void> {
  await execute(
    await openDatabase(),
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (?, ?, 'outline', '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`,
    [id, name],
  );
}

beforeEach(async () => {
  __resetForTest();
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
});

afterEach(() => {
  __resetForTest();
  testDb?.close();
  testDb = null;
});

describe('project writing stats repository integration', () => {
  it('keeps TXT/restore-style body writes and edits in one materialized count', async () => {
    await seedProject(601);

    await createChaptersBulk(601, [
      { position: 0, title: '第一章', content: '  甲😀\n' },
      { position: 1, title: '第二章', content: '\n乙\t' },
    ]);

    let project = (await getAllProjects()).find(item => item.id === 601);
    expect(project).toMatchObject({
      chapter_count: 2,
      body_char_count: 3,
    });

    const chapters = await getChaptersByProjectForExport(601, 1);
    expect(chapters).toHaveLength(2);
    expect(chapters.map(chapter => chapter.content)).toEqual([
      '  甲😀\n',
      '\n乙\t',
    ]);

    await updateChapter(chapters[0].id, { content: '甲乙丙' });
    project = (await getAllProjects()).find(item => item.id === 601);
    expect(project).toMatchObject({
      chapter_count: 2,
      body_char_count: 4,
    });

    await deleteChapter(chapters[1].id);
    project = (await getAllProjects()).find(item => item.id === 601);
    expect(project).toMatchObject({
      chapter_count: 1,
      body_char_count: 3,
    });
  });

  it('deletes three projects atomically without leaving chapter/stat rows', async () => {
    await Promise.all([seedProject(611), seedProject(612), seedProject(613)]);
    await seedProject(614, '保留项目');
    await createChaptersBulk(611, [{ position: 0, content: '甲' }]);
    await createChaptersBulk(612, [{ position: 0, content: '乙' }]);
    await createChaptersBulk(613, [{ position: 0, content: '丙' }]);

    await deleteProjects([611, 612, 613]);

    const [projects, chapters, stats] = await Promise.all([
      testDb!._sqljs.exec(
        'SELECT id FROM projects WHERE id IN (611,612,613,614)',
      ),
      testDb!._sqljs.exec(
        'SELECT project_id FROM chapters WHERE project_id IN (611,612,613)',
      ),
      testDb!._sqljs.exec(
        'SELECT project_id FROM project_writing_stats WHERE project_id IN (611,612,613)',
      ),
    ]);
    expect(projects[0]?.values).toEqual([[614]]);
    expect(chapters[0]?.values ?? []).toEqual([]);
    expect(stats[0]?.values ?? []).toEqual([]);
  });
});
