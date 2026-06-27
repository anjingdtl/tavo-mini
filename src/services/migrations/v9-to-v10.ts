import type SQLite from 'react-native-sqlite-storage';

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

// v9 → v10: llm_usage_logs 增加 llm_config_id / llm_config_name 字段，让用量统计
// 能按 LLM 配置分组（不再仅靠 model_name，多个配置可能共用同一 model_name）。
//
// 字段实际由 ensureSchemaCompatibility() 通过 idempotent ALTER TABLE 添加，
// 这里不重复 ALTER：react-native-sqlite-storage 在事务中遇到 "duplicate column
// name" 会标记整个事务失败（即使 try-catch 也无法挽救），与 v7→v8 同样的处理。
// 本 migration 只创建索引，让按 llm_config_id 的查询更快。
export async function migrateV9toV10(db: SQLite.SQLiteDatabase): Promise<void> {
  await execute(
    db,
    `CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_config
     ON llm_usage_logs(llm_config_id, created_at)`,
  );
}
