import { execute } from './execute';
import { openDatabase } from './openDatabase';
import type { Row } from './execute';

export async function all<T = Row>(
  sql: string,
  params: any[] = [],
): Promise<T[]> {
  const result = await execute(await openDatabase(), sql, params);
  const items: T[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    items.push(result.rows.item(i) as T);
  }
  return items;
}

export async function one<T = Row>(
  sql: string,
  params: any[] = [],
): Promise<T | null> {
  const rows = await all<T>(sql, params);
  return rows[0] || null;
}
