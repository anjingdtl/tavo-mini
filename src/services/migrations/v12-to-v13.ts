import type SQLite from 'react-native-sqlite-storage';
import { applyMigration, tableColumns } from './helpers';
import type { SqlStatement } from '../database/transaction';

export async function buildV12toV13Statements(
  database: SQLite.SQLiteDatabase,
): Promise<SqlStatement[]> {
  const localModelColumns = await tableColumns(database, 'local_llm_models');
  const statements: SqlStatement[] = [];
  if (!localModelColumns.has('prompt_template')) {
    statements.push({
      sql: "ALTER TABLE local_llm_models ADD COLUMN prompt_template TEXT DEFAULT 'chatml'",
    });
  }
  if (!localModelColumns.has('actual_backend')) {
    statements.push({
      sql: 'ALTER TABLE local_llm_models ADD COLUMN actual_backend TEXT DEFAULT NULL',
    });
  }
  statements.push(
    {
      sql: "UPDATE local_llm_models SET status = 'unavailable', error_message = 'LiteRT-LM 引擎已移除，请重新导入 GGUF 模型' WHERE status != 'unavailable'",
    },
    {
      sql: "UPDATE llm_config SET provider_type = 'llama_cpp' WHERE provider_type = 'local_litertlm'",
    },
    {
      sql: "UPDATE llm_config SET local_backend = 'cpu' WHERE provider_type = 'llama_cpp'",
    },
  );
  return statements;
}

/** Backward-compatible direct entry point for migration unit tests. */
export async function migrateV12ToV13(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, await buildV12toV13Statements(database));
}
