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
      CREATE TABLE IF NOT EXISTS note_collections (
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
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        collection_id INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        max_tokens INTEGER NOT NULL DEFAULT 30000,
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
    `CREATE INDEX IF NOT EXISTS idx_notes_collection_id ON notes(collection_id)`,
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
      CREATE TABLE IF NOT EXISTS project_collection_settings (
        project_id INTEGER NOT NULL,
        resource_type TEXT NOT NULL,
        collection_id INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (project_id, resource_type, collection_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
    `CREATE INDEX IF NOT EXISTS idx_project_collection_settings_lookup ON project_collection_settings(project_id, resource_type, collection_id)`,
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
    `
      CREATE TABLE IF NOT EXISTS project_story_memory (
        project_id INTEGER PRIMARY KEY,
        schema_version INTEGER NOT NULL DEFAULT 1,
        through_chapter_id INTEGER,
        through_chapter_position INTEGER NOT NULL DEFAULT -1,
        memory_json TEXT NOT NULL DEFAULT '{}',
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        state_fingerprint TEXT NOT NULL DEFAULT '',
        last_applied_patch_id TEXT,
        status TEXT NOT NULL DEFAULT 'empty',
        source TEXT NOT NULL DEFAULT 'native',
        dirty_from_position INTEGER,
        last_error TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (through_chapter_id) REFERENCES chapters(id) ON DELETE SET NULL
      )
    `,
    `CREATE INDEX IF NOT EXISTS idx_project_story_memory_status ON project_story_memory(status)`,
    `CREATE INDEX IF NOT EXISTS idx_project_story_memory_dirty ON project_story_memory(dirty_from_position)`,
    `
      CREATE TABLE IF NOT EXISTS chapter_memory_patches (
        chapter_id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        chapter_position INTEGER NOT NULL,
        patch_id TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL DEFAULT 1,
        source_fingerprint TEXT NOT NULL,
        base_memory_fingerprint TEXT NOT NULL DEFAULT '',
        result_memory_fingerprint TEXT NOT NULL DEFAULT '',
        episodic_summary_json TEXT NOT NULL DEFAULT '{}',
        patch_json TEXT NOT NULL DEFAULT '{}',
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'generated',
        last_error TEXT NOT NULL DEFAULT '',
        generated_at TEXT NOT NULL,
        applied_at TEXT,
        FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
    `CREATE INDEX IF NOT EXISTS idx_chapter_memory_patches_project_position ON chapter_memory_patches(project_id, chapter_position)`,
    `CREATE INDEX IF NOT EXISTS idx_chapter_memory_patches_status ON chapter_memory_patches(status)`,
    `
      CREATE TABLE IF NOT EXISTS story_memory_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        through_chapter_id INTEGER NOT NULL,
        through_chapter_position INTEGER NOT NULL,
        memory_json TEXT NOT NULL,
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        state_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, through_chapter_position),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (through_chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
      )
    `,
    `CREATE INDEX IF NOT EXISTS idx_story_memory_snapshots_project_position ON story_memory_snapshots(project_id, through_chapter_position DESC)`,
    `
      CREATE TABLE IF NOT EXISTS project_story_memory_policy (
        project_id INTEGER PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'smart',
        interval_chapters INTEGER NOT NULL DEFAULT 3,
        pending_token_soft_limit INTEGER NOT NULL DEFAULT 2400,
        update_on_key_chapter INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS story_memory_batches (
        batch_id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        from_chapter_id INTEGER NOT NULL,
        from_position INTEGER NOT NULL,
        through_chapter_id INTEGER NOT NULL,
        through_position INTEGER NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 2,
        source_fingerprint TEXT NOT NULL,
        base_state_fingerprint TEXT NOT NULL,
        result_state_fingerprint TEXT NOT NULL DEFAULT '',
        patch_json TEXT NOT NULL DEFAULT '{}',
        chapter_summaries_json TEXT NOT NULL DEFAULT '[]',
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'generated',
        last_error TEXT NOT NULL DEFAULT '',
        generated_at TEXT NOT NULL,
        applied_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (from_chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
        FOREIGN KEY (through_chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
      )
    `,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_story_memory_batches_project_range ON story_memory_batches(project_id, from_position, through_position)`,
    `CREATE INDEX IF NOT EXISTS idx_story_memory_batches_project_through ON story_memory_batches(project_id, through_position DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_story_memory_batches_status ON story_memory_batches(status)`,
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
    // Schema 19 (continuation Phase 1): original-work continuation foundation.
    // Mirrored from migrations/v18-to-v19.ts so fresh installs match upgraded
    // installs. See docs/superpowers/specs/next/continuation-phase-1-project-foundation.spec.md §9.
    `
      CREATE TABLE IF NOT EXISTS continuation_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(
          status IN ('staging', 'needs_review', 'ready', 'failed', 'superseded')
        ),
        display_name TEXT NOT NULL,
        original_file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'text/plain',
        detected_encoding TEXT NOT NULL,
        file_size_bytes INTEGER NOT NULL,
        raw_sha256 TEXT NOT NULL,
        normalized_sha256 TEXT NOT NULL,
        normalized_char_count INTEGER NOT NULL,
        normalized_byte_count INTEGER NOT NULL,
        chapter_count INTEGER NOT NULL DEFAULT 0,
        parser_version TEXT NOT NULL,
        normalization_version TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        activated_at TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        UNIQUE(project_id, version),
        UNIQUE(project_id, id)
      )
    `,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_continuation_sources_one_ready ON continuation_sources(project_id) WHERE status = 'ready'`,
    `
      CREATE TABLE IF NOT EXISTS continuation_source_text_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
        char_start_offset INTEGER NOT NULL CHECK(char_start_offset >= 0),
        char_end_offset INTEGER NOT NULL CHECK(char_end_offset > char_start_offset),
        content TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
        UNIQUE(source_id, chunk_index),
        UNIQUE(source_id, char_start_offset)
      )
    `,
    `CREATE INDEX IF NOT EXISTS idx_continuation_text_chunks_range ON continuation_source_text_chunks(source_id, char_start_offset, char_end_offset)`,
    `
      CREATE TABLE IF NOT EXISTS continuation_source_chapters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        position INTEGER NOT NULL CHECK(position >= 0),
        volume_title TEXT,
        detected_title TEXT NOT NULL,
        title TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        char_count INTEGER NOT NULL,
        paragraph_count INTEGER NOT NULL,
        source_start_offset INTEGER NOT NULL,
        content_start_offset INTEGER NOT NULL,
        source_end_offset INTEGER NOT NULL,
        is_excluded INTEGER NOT NULL DEFAULT 0 CHECK(is_excluded IN (0, 1)),
        exclusion_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
        UNIQUE(source_id, position),
        UNIQUE(source_id, id),
        CHECK(char_count >= 0),
        CHECK(paragraph_count >= 0),
        CHECK(source_start_offset >= 0),
        CHECK(content_start_offset >= source_start_offset),
        CHECK(source_end_offset >= content_start_offset)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS continuation_settings (
        project_id INTEGER PRIMARY KEY,
        active_source_id INTEGER,
        boundary_source_id INTEGER,
        boundary_chapter_id INTEGER,
        boundary_char_offset_global INTEGER,
        boundary_mode TEXT NOT NULL DEFAULT 'end_of_source',
        import_completed INTEGER NOT NULL DEFAULT 0,
        analysis_status TEXT NOT NULL DEFAULT 'not_started',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id, active_source_id)
          REFERENCES continuation_sources(project_id, id),
        FOREIGN KEY(boundary_source_id, boundary_chapter_id)
          REFERENCES continuation_source_chapters(source_id, id),
        CHECK(boundary_mode IN ('end_of_source', 'end_of_chapter', 'custom_offset')),
        CHECK(import_completed IN (0, 1)),
        CHECK(analysis_status IN ('not_started', 'running', 'ready', 'outdated', 'failed')),
        CHECK(
          (active_source_id IS NULL AND boundary_source_id IS NULL
            AND boundary_chapter_id IS NULL AND boundary_char_offset_global IS NULL)
          OR
          (active_source_id IS NOT NULL AND boundary_source_id = active_source_id
            AND boundary_chapter_id IS NOT NULL AND boundary_char_offset_global IS NOT NULL)
        ),
        CHECK(active_source_id IS NULL OR boundary_source_id = active_source_id),
        CHECK(boundary_char_offset_global IS NULL OR boundary_char_offset_global >= 0)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS continuation_import_jobs (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        source_id INTEGER NOT NULL,
        source_version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(
          state IN (
            'queued', 'running', 'paused', 'awaiting_review',
            'completed', 'failed', 'cancelled', 'interrupted'
          )
        ),
        stage TEXT NOT NULL,
        progress_current INTEGER NOT NULL DEFAULT 0,
        progress_total INTEGER NOT NULL DEFAULT 0,
        parser_version TEXT NOT NULL,
        normalization_version TEXT NOT NULL,
        input_copy_relative_path TEXT,
        checkpoint_json TEXT,
        error_code TEXT,
        error_message TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK(stage IN (
          'reading', 'decoding', 'normalizing', 'detecting_chapters',
          'persisting', 'validating', 'awaiting_review', 'activating'
        )),
        CHECK(progress_current >= 0),
        CHECK(progress_total >= 0),
        CHECK(progress_total = 0 OR progress_current <= progress_total),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE
      )
    `,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_continuation_import_one_active ON continuation_import_jobs(project_id) WHERE state IN ('queued', 'running', 'paused', 'awaiting_review', 'interrupted')`,
  ];
  for (const statement of statements) {
    await execute(database, statement);
  }
}
