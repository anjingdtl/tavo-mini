import type SQLite from 'react-native-sqlite-storage';

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

// v8 → v9: 新增笔记双模式相关表
// - project_note_config: 项目级笔记模式（none/style/retrieval）+ 微调配置
// - note_style_profiles: 笔记风格画像缓存（全局共享，按 note_id）
// 不修改现有表，向后兼容。
export async function migrateV8toV9(db: SQLite.SQLiteDatabase): Promise<void> {
  await execute(
    db,
    `CREATE TABLE IF NOT EXISTS project_note_config (
      project_id INTEGER PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'none',
      style_weights TEXT NOT NULL DEFAULT '{}',
      retrieval_top_k INTEGER NOT NULL DEFAULT 5,
      retrieval_fragment_chars INTEGER NOT NULL DEFAULT 1000,
      enabled_note_ids TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`,
  );

  await execute(
    db,
    `CREATE TABLE IF NOT EXISTS note_style_profiles (
      note_id INTEGER PRIMARY KEY,
      profile_text TEXT NOT NULL DEFAULT '',
      profile_json TEXT NOT NULL DEFAULT '{}',
      analyzed_at TEXT NOT NULL,
      source_hash TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    )`,
  );
}
