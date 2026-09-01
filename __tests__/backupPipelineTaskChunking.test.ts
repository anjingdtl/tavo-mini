import { readBackupTables } from '../src/services/backupService';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';

const createRows = (rows: Record<string, any>[]) => ({
  length: rows.length,
  item: (index: number) => rows[index],
  raw: () => rows,
});

describe('backup pipeline_tasks large context handling', () => {
  test('reads an oversized pipeline context in chunks without SELECT *', async () => {
    const context = 'x'.repeat(600_001);
    const pipelineManifest = SCHEMA_MANIFEST.find(table => table.name === 'pipeline_tasks');
    if (!pipelineManifest) throw new Error('pipeline_tasks manifest missing');
    const pipelineRow = Object.fromEntries(
      pipelineManifest.columns.map(column => [
        column,
        column === 'id' ? 'task-large' : column === 'pipeline_context_json' ? context : null,
      ]),
    );
    const availableTables = SCHEMA_MANIFEST
      .filter(table => table.backup)
      .map(table => ({ name: table.name }));
    const statements: string[] = [];
    const db = {
      executeSql: jest.fn(async (sql: string, params: any[] = []) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        statements.push(normalized);
        if (/^SELECT name FROM sqlite_master WHERE type = 'table'/i.test(normalized)) {
          return [{ rows: createRows(availableTables) }];
        }
        if (/^SELECT COALESCE\(MAX\(LENGTH\(CAST\(pipeline_context_json AS TEXT\)\)\), 0\)/i.test(normalized)) {
          return [{ rows: createRows([{ max_chars: context.length }]) }];
        }
        if (/^PRAGMA table_info\(pipeline_tasks\)/i.test(normalized)) {
          return [{ rows: createRows(pipelineManifest.columns.map((name, cid) => ({ name, cid }))) }];
        }
        if (/^SELECT .* FROM "pipeline_tasks"$/i.test(normalized) && !/substr\(/i.test(normalized)) {
          const selected = normalized
            .replace(/^SELECT /i, '')
            .replace(/ FROM "pipeline_tasks"$/i, '')
            .split(', ')
            .map(column => column.replace(/^"|"$/g, ''));
          return [{ rows: createRows([Object.fromEntries(selected.map(column => [column, pipelineRow[column]]))]) }];
        }
        if (/^SELECT CASE WHEN .* AS char_length FROM "pipeline_tasks"/i.test(normalized)) {
          return [{ rows: createRows([{ char_length: context.length }]) }];
        }
        if (/^SELECT substr\(/i.test(normalized)) {
          const [offset, length] = params;
          return [{ rows: createRows([{ chunk: context.slice(Number(offset) - 1, Number(offset) - 1 + Number(length)) }]) }];
        }
        return [{ rows: createRows([]) }];
      }),
    } as any;

    const tables = await readBackupTables(db);
    expect(tables.pipeline_tasks).toHaveLength(1);
    expect(tables.pipeline_tasks[0].pipeline_context_json).toBe(context);
    expect(statements).not.toContain('SELECT * FROM pipeline_tasks');
  });
});
