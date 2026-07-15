import { execute } from '../connection/execute';
import { openDatabase } from '../connection/openDatabase';
import type { Chapter } from '../../types/novel';

export type Row = Record<string, any>;
export type RowRecord = Row;
export type ResourceType = 'character' | 'worldbook' | 'note' | 'preset';

export const NOTE_TEXT_CHUNK_CHARS = 120000;
export const NOTE_LIST_PREVIEW_CHARS = 1200;

export function now(): string {
  return new Date().toISOString();
}
export function parseChapter(row: Row): Chapter {
  let summary = null;
  if (row.summary_json) {
    try {
      summary =
        typeof row.summary_json === 'string'
          ? JSON.parse(row.summary_json)
          : row.summary_json;
    } catch {
      summary = null;
    }
  }
  return { ...row, summary_json: summary } as Chapter;
}
export async function touchProject(projectId: number): Promise<void> {
  await execute(
    await openDatabase(),
    'UPDATE projects SET updated_at = ? WHERE id = ?',
    [now(), projectId],
  );
}
export async function updateColumns(
  table: string,
  id: number,
  allowed: Set<string>,
  fields: Row,
): Promise<void> {
  const sets: string[] = [];
  const values: any[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.has(key)) continue;
    sets.push(`${key} = ?`);
    values.push(value);
  }
  if (sets.length === 0) return;
  values.push(id);
  await execute(
    await openDatabase(),
    `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`,
    values,
  );
}
