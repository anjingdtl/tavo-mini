import SQLite from 'react-native-sqlite-storage';
import { execute } from '../connection/execute';

export async function createCurrentSchema(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  const statements = [
    `
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'outline',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS chapters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '',
        synopsis TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planned',
        summary_json TEXT,
        memory_summary TEXT NOT NULL DEFAULT '',
        memory_summary_tokens INTEGER NOT NULL DEFAULT 0,
        finalized_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS fragments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL DEFAULT 'seed',
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS plotlines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '#2563EB',
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS project_plotlines (
        chapter_id INTEGER NOT NULL,
        plotline_id INTEGER NOT NULL,
        PRIMARY KEY (chapter_id, plotline_id),
        FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
        FOREIGN KEY (plotline_id) REFERENCES plotlines(id) ON DELETE CASCADE
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS characters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        collection_id INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'json',
        data_json TEXT NOT NULL DEFAULT '{}',
        max_tokens INTEGER NOT NULL DEFAULT 50000,
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS character_collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        max_tokens INTEGER NOT NULL DEFAULT 50000,
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS worldbook_collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        max_tokens INTEGER NOT NULL DEFAULT 50000,
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS worldbook_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        collection_id INTEGER NOT NULL DEFAULT 0,
        keyword_primary TEXT NOT NULL DEFAULT '',
        keyword_secondary TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        comment TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        constant INTEGER NOT NULL DEFAULT 0,
        max_tokens INTEGER NOT NULL DEFAULT 2000,
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        max_tokens INTEGER NOT NULL DEFAULT 30000,
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS presets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        is_default INTEGER NOT NULL DEFAULT 0,
        system_prompt TEXT NOT NULL DEFAULT '',
        writing_style TEXT NOT NULL DEFAULT '',
        temperature REAL NOT NULL DEFAULT 0.8,
        top_p REAL NOT NULL DEFAULT 0.9,
        max_tokens INTEGER NOT NULL DEFAULT 4000,
        extra_instructions TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS llm_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL DEFAULT '',
        base_url TEXT NOT NULL DEFAULT '',
        api_key TEXT NOT NULL DEFAULT '',
        model_name TEXT NOT NULL DEFAULT '',
        is_active INTEGER NOT NULL DEFAULT 0,
        provider_type TEXT NOT NULL DEFAULT 'openai_compatible',
        local_model_id TEXT,
        local_backend TEXT,
        context_window INTEGER NOT NULL DEFAULT 4096,
        max_output_tokens INTEGER NOT NULL DEFAULT 4000
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS local_llm_models (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        relative_path TEXT NOT NULL UNIQUE,
        file_size INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'importing',
        backend_preference TEXT NOT NULL DEFAULT 'auto',
        validated_backend TEXT,
        context_length INTEGER,
        max_output_tokens INTEGER,
        load_time_ms INTEGER,
        first_token_ms INTEGER,
        tokens_per_second REAL,
        imported_at TEXT NOT NULL,
        last_used_at TEXT,
        last_validated_at TEXT,
        error_code TEXT,
        error_message TEXT,
        prompt_template TEXT NOT NULL DEFAULT 'chatml',
        actual_backend TEXT
      )
    `,
    `CREATE INDEX IF NOT EXISTS idx_local_llm_models_status ON local_llm_models(status)`,
    `CREATE INDEX IF NOT EXISTS idx_local_llm_models_last_used ON local_llm_models(last_used_at)`,
    `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS project_resources (
        project_id INTEGER NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (project_id, resource_type, resource_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS llm_usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scenario TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '',
        error_code TEXT NOT NULL DEFAULT '',
        model_name TEXT NOT NULL DEFAULT '',
        project_id INTEGER NOT NULL DEFAULT 0,
        llm_config_id INTEGER NOT NULL DEFAULT 0,
        llm_config_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS pipeline_tasks (
        id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        stage_results TEXT NOT NULL DEFAULT '[]',
        final_text TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolved_action TEXT
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS freeform_documents (
        project_id INTEGER PRIMARY KEY,
        content TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
    // V1.4.0 (schema 6): content revision snapshots for chapter/freeform.
    // Mirrored here from migrations/v5-to-v6.ts so fresh installs have the
    // same schema as upgraded installs (fresh installs skip all migrations).
    `
      CREATE TABLE IF NOT EXISTS content_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        target_type TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        source_ref TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
    // V1.5.0 (schema 7): pipeline generation drafts. See migrations/v6-to-v7.ts.
    `
      CREATE TABLE IF NOT EXISTS generation_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        target_type TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        pipeline_task_id TEXT,
        token_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
    // Indexes for the two NEW tables above. Safe to create here because both
    // tables are created fresh in this same statements list (CREATE TABLE IF
    // NOT EXISTS), so their columns always exist by the time the index runs.
    // These indexes are safe here because fresh installs create the latest
    // columns before index creation. Existing databases get them in the
    // post-migration index step.
    `CREATE INDEX IF NOT EXISTS idx_content_revisions_target ON content_revisions(target_type, target_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_generation_drafts_target ON generation_drafts(target_type, target_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_month ON llm_usage_logs(project_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_config ON llm_usage_logs(llm_config_id, created_at)`,
    // V1.7.0 (schema 9): 笔记双模式相关表
    `
      CREATE TABLE IF NOT EXISTS project_note_config (
        project_id INTEGER PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'none',
        style_weights TEXT NOT NULL DEFAULT '{}',
        retrieval_top_k INTEGER NOT NULL DEFAULT 5,
        retrieval_fragment_chars INTEGER NOT NULL DEFAULT 1000,
        enabled_note_ids TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS note_style_profiles (
        note_id INTEGER PRIMARY KEY,
        profile_text TEXT NOT NULL DEFAULT '',
        profile_json TEXT NOT NULL DEFAULT '{}',
        analyzed_at TEXT NOT NULL,
        source_hash TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
      )
    `,
  ];
  for (const statement of statements) {
    await execute(database, statement);
  }
}
