import type SQLite from 'react-native-sqlite-storage';

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

async function tableColumns(db: SQLite.SQLiteDatabase, table: string): Promise<Set<string>> {
  const result = await execute(db, `PRAGMA table_info(${table})`);
  const columns = new Set<string>();
  for (let i = 0; i < result.rows.length; i += 1) {
    columns.add(result.rows.item(i).name);
  }
  return columns;
}

export async function migrateV12ToV13(db: SQLite.SQLiteDatabase): Promise<void> {
  // 1. Add prompt_template column to local_llm_models
  const localModelColumns = await tableColumns(db, 'local_llm_models');
  if (!localModelColumns.has('prompt_template')) {
    await execute(db, "ALTER TABLE local_llm_models ADD COLUMN prompt_template TEXT DEFAULT 'chatml'");
  }
  if (!localModelColumns.has('actual_backend')) {
    await execute(db, 'ALTER TABLE local_llm_models ADD COLUMN actual_backend TEXT DEFAULT NULL');
  }

  // 2. Mark all existing litertlm models as unavailable
  // All existing local_llm_models records are litertlm models (the only backend before v13).
  // Mark them unavailable so users know to re-import as GGUF.
  await execute(
    db,
    "UPDATE local_llm_models SET status = 'unavailable', error_message = 'LiteRT-LM 引擎已移除，请重新导入 GGUF 模型' WHERE status != 'unavailable'",
  );

  // 3. Update llm_config: change provider_type from 'local_litertlm' to 'llama_cpp'
  await execute(
    db,
    "UPDATE llm_config SET provider_type = 'llama_cpp' WHERE provider_type = 'local_litertlm'",
  );

  // 4. Update llm_config: set local_backend to 'cpu' for llama_cpp configs
  await execute(
    db,
    "UPDATE llm_config SET local_backend = 'cpu' WHERE provider_type = 'llama_cpp'",
  );
}
