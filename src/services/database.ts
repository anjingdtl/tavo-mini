import SQLite from 'react-native-sqlite-storage';
import type {
  Chapter,
  ContextConfig,
  Fragment,
  FragmentType,
  LLMConfig,
  Note,
  Plotline,
  Preset,
  Project,
  ProjectMode,
} from '../types/novel';
import type { LocalModel } from '../types/localModel';
import type { PipelineConfig } from '../types/pipeline';
import type { VoiceConfig, TtsEngine, SystemTtsConfig } from '../types/tts';
import {
  DEFAULT_VOICE_CONFIG,
  DEFAULT_SYSTEM_TTS_CONFIG,
} from '../constants/voice';
import { DEFAULT_CONTEXT_CONFIG } from '../constants/defaults';
import {
  clearSecureLLMApiKey,
  getSecureLLMApiKey,
  migrateLegacyLLMApiKey,
  setSecureLLMApiKey,
} from './secureStorage';
import { estimateTokens } from '../utils/tokenEstimator';
import { getNoteChapters } from '../utils/noteChapters';
import {
  runMigrations,
  SCHEMA_VERSION,
  hasBreakingMigration,
  isIncompatibleUpgrade,
} from './migrations';
import type {
  InstallInfo,
  InstallType,
  MigrationResult,
} from './migrations/types';
import appVersionJson from '../constants/version.json';

SQLite.enablePromise(true);

const DB_NAME = 'shine_writer.db';
const GLOBAL_PROJECT_ID = 0;
const GLOBAL_PROJECT_NAME = '__tavo_global_workspace__';
const NOTE_TEXT_CHUNK_CHARS = 120000;
const NOTE_LIST_PREVIEW_CHARS = 1200;
let db: SQLite.SQLiteDatabase | null = null;
let opening: Promise<SQLite.SQLiteDatabase> | null = null;

type Row = Record<string, any>;
export type RowRecord = Row;
export type ResourceType = 'character' | 'worldbook' | 'note' | 'preset';

// 仅供测试使用：重置 module-level db 缓存，让单测可以重新注入 mock
export function __resetForTest(): void {
  db = null;
  opening = null;
}

export async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  if (opening) return opening;
  opening = (async () => {
    const database = await SQLite.openDatabase({
      name: DB_NAME,
      location: 'default',
    });
    await createTables(database);
    await ensureSchemaCompatibility(database);
    await seedDefaults(database);
    await migrate(database);
    // Create the usage-log index AFTER migrations: the project_id column it
    // depends on is added by the v7→v8 migration, which runs in migrate().
    // Creating it earlier (in createTables) crashes on upgrade from <V1.6.0
    // because the legacy llm_usage_logs table lacks project_id.
    await execute(
      database,
      'CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_month ON llm_usage_logs(project_id, created_at)',
    );
    await repairOversizedNotes(database);
    db = database;
    opening = null;
    return database;
  })().catch(error => {
    db = null;
    opening = null;
    throw error;
  });
  return opening;
}

async function execute(
  database: SQLite.SQLiteDatabase,
  sql: string,
  params: any[] = [],
) {
  const [result] = await database.executeSql(sql, params);
  return result;
}

/**
 * V2.2.2 修复：react-native-sqlite-storage 的 `transaction(callback)` 期望 callback **同步**
 * 执行所有 SQL。原代码用 `database.transaction(async (tx) => { ... await tx.executeSql ... })`
 * 会导致第一次 await 时 transaction 已被 finalize，后续 executeSql 抛 InvalidStateError
 * (DOM Exception 11)。
 *
 * 这个 helper 强制把"先 async 读、再 async 写"的常见模式拆成两步：
 * 1. `collect` 阶段：调用方先 async 收集所有要写的 SQL（参数）
 * 2. 同步 push 到 transaction 中
 * 整体丢给 `transaction`，由 SQLite 库同步调度执行，原子性保留。
 */
async function runInTransactionSafe(
  database: SQLite.SQLiteDatabase,
  statements: Array<{ sql: string; params?: any[] }>,
): Promise<void> {
  if (statements.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    database.transaction(
      (tx: any) => {
        for (const stmt of statements) {
          tx.executeSql(stmt.sql, stmt.params || []);
        }
      },
      (err: any) => reject(err instanceof Error ? err : new Error(String(err))),
      () => resolve(),
    );
  });
}

async function all<T = Row>(sql: string, params: any[] = []): Promise<T[]> {
  const database = await openDatabase();
  const result = await execute(database, sql, params);
  const items: T[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    items.push(result.rows.item(i));
  }
  return items;
}

async function one<T = Row>(
  sql: string,
  params: any[] = [],
): Promise<T | null> {
  const rows = await all<T>(sql, params);
  return rows[0] || null;
}

async function createTables(database: SQLite.SQLiteDatabase): Promise<void> {
  await execute(database, 'PRAGMA foreign_keys = ON');
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
    // NOTE: idx_llm_usage_logs_month is intentionally NOT created here — its
    // project_id column is only added by the v7→v8 migration, so on an upgrade
    // the column does not exist yet at this point. That index is created after
    // migrations finish in openDatabase().
    `CREATE INDEX IF NOT EXISTS idx_content_revisions_target ON content_revisions(target_type, target_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_generation_drafts_target ON generation_drafts(target_type, target_id, created_at DESC)`,
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

async function tableColumns(
  database: SQLite.SQLiteDatabase,
  table: string,
): Promise<Set<string>> {
  const result = await execute(database, `PRAGMA table_info(${table})`);
  const columns = new Set<string>();
  for (let i = 0; i < result.rows.length; i++) {
    columns.add(result.rows.item(i).name);
  }
  return columns;
}

async function ensureColumn(
  database: SQLite.SQLiteDatabase,
  table: string,
  columns: Set<string>,
  column: string,
  definition: string,
): Promise<void> {
  if (columns.has(column)) return;
  await execute(database, `ALTER TABLE ${table} ADD COLUMN ${definition}`);
  columns.add(column);
}

async function ensureSchemaCompatibility(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  const projects = await tableColumns(database, 'projects');
  await ensureColumn(
    database,
    'projects',
    projects,
    'name',
    "name TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'projects',
    projects,
    'mode',
    "mode TEXT NOT NULL DEFAULT 'outline'",
  );
  await ensureColumn(
    database,
    'projects',
    projects,
    'created_at',
    "created_at TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'projects',
    projects,
    'updated_at',
    "updated_at TEXT NOT NULL DEFAULT ''",
  );

  const chapters = await tableColumns(database, 'chapters');
  await ensureColumn(
    database,
    'chapters',
    chapters,
    'project_id',
    'project_id INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'chapters',
    chapters,
    'position',
    'position INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'chapters',
    chapters,
    'title',
    "title TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'chapters',
    chapters,
    'synopsis',
    "synopsis TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'chapters',
    chapters,
    'content',
    "content TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'chapters',
    chapters,
    'status',
    "status TEXT NOT NULL DEFAULT 'planned'",
  );
  await ensureColumn(
    database,
    'chapters',
    chapters,
    'summary_json',
    'summary_json TEXT',
  );
  await ensureColumn(
    database,
    'chapters',
    chapters,
    'memory_summary',
    "memory_summary TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'chapters',
    chapters,
    'memory_summary_tokens',
    'memory_summary_tokens INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'chapters',
    chapters,
    'finalized_at',
    'finalized_at TEXT',
  );
  await ensureColumn(
    database,
    'chapters',
    chapters,
    'created_at',
    "created_at TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'chapters',
    chapters,
    'updated_at',
    "updated_at TEXT NOT NULL DEFAULT ''",
  );

  const fragments = await tableColumns(database, 'fragments');
  await ensureColumn(
    database,
    'fragments',
    fragments,
    'project_id',
    'project_id INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'fragments',
    fragments,
    'position',
    'position INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'fragments',
    fragments,
    'type',
    "type TEXT NOT NULL DEFAULT 'seed'",
  );
  await ensureColumn(
    database,
    'fragments',
    fragments,
    'content',
    "content TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'fragments',
    fragments,
    'created_at',
    "created_at TEXT NOT NULL DEFAULT ''",
  );

  const plotlines = await tableColumns(database, 'plotlines');
  await ensureColumn(
    database,
    'plotlines',
    plotlines,
    'project_id',
    'project_id INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'plotlines',
    plotlines,
    'name',
    "name TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'plotlines',
    plotlines,
    'description',
    "description TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'plotlines',
    plotlines,
    'color',
    "color TEXT NOT NULL DEFAULT '#2563EB'",
  );

  const characters = await tableColumns(database, 'characters');
  await ensureColumn(
    database,
    'characters',
    characters,
    'project_id',
    'project_id INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'characters',
    characters,
    'collection_id',
    'collection_id INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'characters',
    characters,
    'name',
    "name TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'characters',
    characters,
    'source_type',
    "source_type TEXT NOT NULL DEFAULT 'json'",
  );
  await ensureColumn(
    database,
    'characters',
    characters,
    'data_json',
    "data_json TEXT NOT NULL DEFAULT '{}'",
  );
  await ensureColumn(
    database,
    'characters',
    characters,
    'max_tokens',
    'max_tokens INTEGER NOT NULL DEFAULT 50000',
  );
  await ensureColumn(
    database,
    'characters',
    characters,
    'estimated_tokens',
    'estimated_tokens INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'characters',
    characters,
    'created_at',
    "created_at TEXT NOT NULL DEFAULT ''",
  );

  const characterCollections = await tableColumns(
    database,
    'character_collections',
  );
  await ensureColumn(
    database,
    'character_collections',
    characterCollections,
    'project_id',
    'project_id INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'character_collections',
    characterCollections,
    'name',
    "name TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'character_collections',
    characterCollections,
    'enabled',
    'enabled INTEGER NOT NULL DEFAULT 1',
  );
  await ensureColumn(
    database,
    'character_collections',
    characterCollections,
    'max_tokens',
    'max_tokens INTEGER NOT NULL DEFAULT 50000',
  );
  await ensureColumn(
    database,
    'character_collections',
    characterCollections,
    'estimated_tokens',
    'estimated_tokens INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'character_collections',
    characterCollections,
    'created_at',
    "created_at TEXT NOT NULL DEFAULT ''",
  );

  const collections = await tableColumns(database, 'worldbook_collections');
  await ensureColumn(
    database,
    'worldbook_collections',
    collections,
    'project_id',
    'project_id INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'worldbook_collections',
    collections,
    'name',
    "name TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'worldbook_collections',
    collections,
    'enabled',
    'enabled INTEGER NOT NULL DEFAULT 1',
  );
  await ensureColumn(
    database,
    'worldbook_collections',
    collections,
    'max_tokens',
    'max_tokens INTEGER NOT NULL DEFAULT 50000',
  );
  await ensureColumn(
    database,
    'worldbook_collections',
    collections,
    'estimated_tokens',
    'estimated_tokens INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'worldbook_collections',
    collections,
    'created_at',
    "created_at TEXT NOT NULL DEFAULT ''",
  );

  const worldbook = await tableColumns(database, 'worldbook_entries');
  await ensureColumn(
    database,
    'worldbook_entries',
    worldbook,
    'project_id',
    'project_id INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'worldbook_entries',
    worldbook,
    'collection_id',
    'collection_id INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'worldbook_entries',
    worldbook,
    'keyword_primary',
    "keyword_primary TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'worldbook_entries',
    worldbook,
    'keyword_secondary',
    "keyword_secondary TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'worldbook_entries',
    worldbook,
    'content',
    "content TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'worldbook_entries',
    worldbook,
    'comment',
    "comment TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'worldbook_entries',
    worldbook,
    'enabled',
    'enabled INTEGER NOT NULL DEFAULT 1',
  );
  await ensureColumn(
    database,
    'worldbook_entries',
    worldbook,
    'constant',
    'constant INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'worldbook_entries',
    worldbook,
    'max_tokens',
    'max_tokens INTEGER NOT NULL DEFAULT 2000',
  );
  await ensureColumn(
    database,
    'worldbook_entries',
    worldbook,
    'estimated_tokens',
    'estimated_tokens INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'worldbook_entries',
    worldbook,
    'position',
    'position INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'worldbook_entries',
    worldbook,
    'created_at',
    "created_at TEXT NOT NULL DEFAULT ''",
  );

  const notes = await tableColumns(database, 'notes');
  await ensureColumn(
    database,
    'notes',
    notes,
    'project_id',
    'project_id INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'notes',
    notes,
    'title',
    "title TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'notes',
    notes,
    'content',
    "content TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'notes',
    notes,
    'max_tokens',
    'max_tokens INTEGER NOT NULL DEFAULT 30000',
  );
  await ensureColumn(
    database,
    'notes',
    notes,
    'estimated_tokens',
    'estimated_tokens INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'notes',
    notes,
    'created_at',
    "created_at TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'notes',
    notes,
    'updated_at',
    "updated_at TEXT NOT NULL DEFAULT ''",
  );

  const presets = await tableColumns(database, 'presets');
  await ensureColumn(
    database,
    'presets',
    presets,
    'project_id',
    'project_id INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'presets',
    presets,
    'name',
    "name TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'presets',
    presets,
    'is_default',
    'is_default INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'presets',
    presets,
    'system_prompt',
    "system_prompt TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'presets',
    presets,
    'writing_style',
    "writing_style TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'presets',
    presets,
    'temperature',
    'temperature REAL NOT NULL DEFAULT 0.8',
  );
  await ensureColumn(
    database,
    'presets',
    presets,
    'top_p',
    'top_p REAL NOT NULL DEFAULT 0.9',
  );
  await ensureColumn(
    database,
    'presets',
    presets,
    'max_tokens',
    'max_tokens INTEGER NOT NULL DEFAULT 4000',
  );
  await ensureColumn(
    database,
    'presets',
    presets,
    'extra_instructions',
    "extra_instructions TEXT NOT NULL DEFAULT ''",
  );

  const llm = await tableColumns(database, 'llm_config');
  await ensureColumn(
    database,
    'llm_config',
    llm,
    'name',
    "name TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'llm_config',
    llm,
    'base_url',
    "base_url TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'llm_config',
    llm,
    'api_key',
    "api_key TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'llm_config',
    llm,
    'model_name',
    "model_name TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'llm_config',
    llm,
    'is_active',
    'is_active INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'llm_config',
    llm,
    'provider_type',
    "provider_type TEXT NOT NULL DEFAULT 'openai_compatible'",
  );
  await ensureColumn(
    database,
    'llm_config',
    llm,
    'local_model_id',
    'local_model_id TEXT',
  );
  await ensureColumn(
    database,
    'llm_config',
    llm,
    'local_backend',
    'local_backend TEXT',
  );
  await ensureColumn(
    database,
    'llm_config',
    llm,
    'context_window',
    'context_window INTEGER NOT NULL DEFAULT 4096',
  );
  await ensureColumn(
    database,
    'llm_config',
    llm,
    'max_output_tokens',
    'max_output_tokens INTEGER NOT NULL DEFAULT 4000',
  );

  const settings = await tableColumns(database, 'settings');
  await ensureColumn(
    database,
    'settings',
    settings,
    'key',
    "key TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'settings',
    settings,
    'value',
    "value TEXT NOT NULL DEFAULT ''",
  );

  // llm_usage_logs: columns added by the v7→v8 migration. We also ensure them
  // here (which runs before migrate()) so that legacy databases upgrading from
  // <V1.6.0 have the columns in place before the post-migration index creation.
  const usageLogs = await tableColumns(database, 'llm_usage_logs');
  await ensureColumn(
    database,
    'llm_usage_logs',
    usageLogs,
    'model_name',
    "model_name TEXT NOT NULL DEFAULT ''",
  );
  await ensureColumn(
    database,
    'llm_usage_logs',
    usageLogs,
    'project_id',
    'project_id INTEGER NOT NULL DEFAULT 0',
  );
  // V2.2.0 (schema 10): 按配置区分用量。这两个字段让 UsageStatsScreen 能展示每个 LLM 配置
  // 的调用量，不再仅靠 model_name 区分（多个配置可能共用同一 model_name）。
  await ensureColumn(
    database,
    'llm_usage_logs',
    usageLogs,
    'llm_config_id',
    'llm_config_id INTEGER NOT NULL DEFAULT 0',
  );
  await ensureColumn(
    database,
    'llm_usage_logs',
    usageLogs,
    'llm_config_name',
    "llm_config_name TEXT NOT NULL DEFAULT ''",
  );

  // V2.4.3 修复：project_note_config 曾被 ensureSchemaCompatibility 遗漏，
  // 导致从老版本升级且 v13→v14 迁移未跑到的设备缺 retrieval_fragment_chars 列，
  // setProjectNoteConfig 的 INSERT 报 "no column named retrieval_fragment_chars"。
  // 与其他表同款兜底，启动时无条件补齐。
  const noteConfig = await tableColumns(database, 'project_note_config');
  await ensureColumn(
    database,
    'project_note_config',
    noteConfig,
    'mode',
    "mode TEXT NOT NULL DEFAULT 'none'",
  );
  await ensureColumn(
    database,
    'project_note_config',
    noteConfig,
    'style_weights',
    "style_weights TEXT NOT NULL DEFAULT '{}'",
  );
  await ensureColumn(
    database,
    'project_note_config',
    noteConfig,
    'retrieval_top_k',
    'retrieval_top_k INTEGER NOT NULL DEFAULT 5',
  );
  await ensureColumn(
    database,
    'project_note_config',
    noteConfig,
    'retrieval_fragment_chars',
    'retrieval_fragment_chars INTEGER NOT NULL DEFAULT 1000',
  );
  await ensureColumn(
    database,
    'project_note_config',
    noteConfig,
    'enabled_note_ids',
    "enabled_note_ids TEXT NOT NULL DEFAULT '[]'",
  );
  await ensureColumn(
    database,
    'project_note_config',
    noteConfig,
    'updated_at',
    "updated_at TEXT NOT NULL DEFAULT ''",
  );
}

async function seedDefaults(database: SQLite.SQLiteDatabase): Promise<void> {
  await ensureGlobalProject(database);
  await execute(
    database,
    `INSERT OR IGNORE INTO llm_config (
      id, name, provider_type, base_url, api_key, model_name, is_active,
      local_model_id, local_backend, context_window, max_output_tokens
    ) VALUES (1, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ['默认配置', 'openai_compatible', '', '', '', null, null, 4096, 4000],
  );
  await execute(
    database,
    "UPDATE llm_config SET name = '默认配置' WHERE id = 1 AND name = ''",
  );
  const active = await execute(
    database,
    'SELECT id FROM llm_config WHERE is_active = 1 ORDER BY id ASC LIMIT 1',
  );
  if (active.rows.length === 0) {
    await execute(
      database,
      'UPDATE llm_config SET is_active = 1 WHERE id = (SELECT id FROM llm_config ORDER BY id ASC LIMIT 1)',
    );
  }
  await ensureDefaultPreset(database);
}

async function ensureGlobalProject(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  const timestamp = now();
  await execute(
    database,
    'INSERT OR IGNORE INTO projects (id, name, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [GLOBAL_PROJECT_ID, GLOBAL_PROJECT_NAME, 'outline', timestamp, timestamp],
  );
}

export async function detectInstallType(
  database: SQLite.SQLiteDatabase,
): Promise<InstallInfo> {
  const currentVersion = appVersionJson.versionName.replace(/^V/, '');
  const storedVersionResult = await execute(
    database,
    'SELECT value FROM settings WHERE key = ?',
    ['app_version'],
  );
  const storedVersion =
    storedVersionResult.rows.length > 0
      ? storedVersionResult.rows.item(0).value
      : null;

  const firstInstallResult = await execute(
    database,
    'SELECT value FROM settings WHERE key = ?',
    ['first_install_version'],
  );
  const firstInstallVersion =
    firstInstallResult.rows.length > 0
      ? firstInstallResult.rows.item(0).value
      : currentVersion;

  let installType: InstallType;
  let previousVersion: string | null = null;

  if (!storedVersion) {
    installType = 'fresh';
    await execute(
      database,
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      ['first_install_version', currentVersion],
    );
  } else if (storedVersion !== currentVersion) {
    installType = 'upgrade';
    previousVersion = storedVersion;
    await execute(
      database,
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      ['previous_version', storedVersion],
    );
  } else {
    installType = 'same';
  }

  await execute(
    database,
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    ['app_version', currentVersion],
  );
  await execute(
    database,
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    ['app_version_code', String(appVersionJson.versionCode)],
  );
  await execute(
    database,
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    ['install_type', installType],
  );

  const schemaVersionResult = await execute(
    database,
    'SELECT value FROM settings WHERE key = ?',
    ['schema_version'],
  );
  const schemaVersion =
    schemaVersionResult.rows.length > 0
      ? parseInt(schemaVersionResult.rows.item(0).value, 10)
      : 0;

  return {
    installType,
    currentVersion,
    previousVersion,
    firstInstallVersion: storedVersion ? firstInstallVersion : currentVersion,
    schemaVersion,
  };
}

export let lastInstallInfo: InstallInfo | null = null;
export let lastMigrationResult: MigrationResult | null = null;

async function migrate(database: SQLite.SQLiteDatabase): Promise<void> {
  const installInfo = await detectInstallType(database);
  lastInstallInfo = installInfo;

  if (installInfo.installType === 'fresh') {
    await execute(
      database,
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      ['schema_version', String(SCHEMA_VERSION)],
    );
    return;
  }

  if (installInfo.installType === 'same') {
    // 修复：即使 app_version 相同，也检查 schema_version 是否需要补迁移
    // 防止迁移失败后 app_version 已更新但 schema_version 卡在旧值
    const fromSchema = installInfo.schemaVersion || 1;
    if (
      fromSchema < SCHEMA_VERSION &&
      !hasBreakingMigration(fromSchema) &&
      !isIncompatibleUpgrade(fromSchema)
    ) {
      const migrationResult = await runMigrations(database, fromSchema);
      lastMigrationResult = migrationResult;
    }
    return;
  }

  const fromSchema = installInfo.schemaVersion || 1;
  if (fromSchema >= SCHEMA_VERSION) {
    return;
  }

  if (hasBreakingMigration(fromSchema) || isIncompatibleUpgrade(fromSchema)) {
    return;
  }

  const migrationResult = await runMigrations(database, fromSchema);
  lastMigrationResult = migrationResult;
}

function now(): string {
  return new Date().toISOString();
}

function parseChapter(row: Row): Chapter {
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

export async function getAllProjects(): Promise<Project[]> {
  return all<Project>(
    'SELECT * FROM projects WHERE id > 0 ORDER BY updated_at DESC',
  );
}

export async function getProjectById(id: number): Promise<Project | null> {
  return one<Project>('SELECT * FROM projects WHERE id = ? AND id > 0', [id]);
}

export async function createProject(
  name: string,
  mode: ProjectMode | string,
): Promise<number> {
  const database = await openDatabase();
  const timestamp = now();
  // V2.2.2 修复：用 `runInTransactionSafe` 取代直接的 `database.transaction(async ...)`。
  // 原因：react-native-sqlite-storage 的 transaction 期望 callback **同步**执行所有 SQL，
  // 任何 await 都会让 transaction 被 finalize 触发 InvalidStateError (DOM Exception 11)。
  // 这里改成：先 INSERT projects → 拿 insertId → 再 ensureDefaultPreset → 绑预设 + 建首章 + touch。
  // 整个写入过程走 runInTransactionSafe 的同步 push 模式，原子性保留。
  const insertProjectResult = await execute(
    database,
    'INSERT INTO projects (name, mode, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [name, mode, timestamp, timestamp],
  );
  const projectId = insertProjectResult.insertId!;
  // ensureDefaultPreset 自己有事务，不能嵌套。所以拆成两步：
  //   1) 先把 project 行 + 关联写入放进一个事务
  //   2) 再调用 ensureDefaultPreset（它内部可能有自己的事务）
  // 任何一步失败时，项目已建但不完整；UI 层可看到空项目并由用户决定删除/重试。
  await runInTransactionSafe(database, [
    {
      sql: 'INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, ?)',
      params: [projectId, 'preset', 0, 1], // 先占位：0 表示"未指定预设"，UI 上不会生效
    },
    {
      sql: 'INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      params: [
        projectId,
        0,
        '第 1 章',
        '',
        '',
        'planned',
        timestamp,
        timestamp,
      ],
    },
  ]);
  // ensureDefaultPreset 不依赖当前事务，单独调用
  await ensureDefaultPreset(database);
  await execute(database, 'UPDATE projects SET updated_at = ? WHERE id = ?', [
    timestamp,
    projectId,
  ]);
  return projectId;
}

export async function updateProject(id: number, name: string): Promise<void> {
  await execute(
    await openDatabase(),
    'UPDATE projects SET name = ?, updated_at = ? WHERE id = ?',
    [name, now(), id],
  );
}

export async function deleteProject(id: number): Promise<void> {
  if (id <= 0) return; // 防止删除全局资源（project_id=0 的数据）
  await execute(await openDatabase(), 'DELETE FROM projects WHERE id = ?', [
    id,
  ]);
}

export async function getChaptersByProject(
  projectId: number,
): Promise<Chapter[]> {
  const rows = await all<Row>(
    'SELECT * FROM chapters WHERE project_id = ? ORDER BY position ASC',
    [projectId],
  );
  return rows.map(parseChapter);
}

export async function getChapterById(id: number): Promise<Chapter | null> {
  const row = await one<Row>('SELECT * FROM chapters WHERE id = ?', [id]);
  return row ? parseChapter(row) : null;
}

export type ChapterReadingRange = 'current' | 'fromCurrent' | 'all';

export async function buildChapterReadingText(
  projectId: number,
  chapterId: number,
  range: ChapterReadingRange,
): Promise<string> {
  const current = await getChapterById(chapterId);
  if (!current) return '';

  let rows: Row[];
  if (range === 'current') {
    rows = [current as unknown as Row];
  } else if (range === 'fromCurrent') {
    rows = await all<Row>(
      'SELECT * FROM chapters WHERE project_id = ? AND position >= ? ORDER BY position ASC, id ASC',
      [projectId, current.position],
    );
  } else {
    rows = await all<Row>(
      'SELECT * FROM chapters WHERE project_id = ? ORDER BY position ASC, id ASC',
      [projectId],
    );
  }

  return rows
    .map(parseChapter)
    .filter(chapter => chapter.content.trim())
    .map((chapter, index) => {
      const title = chapter.title.trim() || `第 ${index + 1} 章`;
      return `${title}\n\n${chapter.content.trim()}`;
    })
    .join('\n\n');
}

export async function createChapter(
  projectId: number,
  position: number,
  title?: string,
): Promise<number> {
  const timestamp = now();
  const result = await execute(
    await openDatabase(),
    'INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      projectId,
      position,
      title || `第 ${position + 1} 章`,
      '',
      '',
      'planned',
      timestamp,
      timestamp,
    ],
  );
  await touchProject(projectId);
  return result.insertId!;
}

const CHAPTER_COLUMNS = new Set([
  'title',
  'synopsis',
  'content',
  'status',
  'summary_json',
  'memory_summary',
  'memory_summary_tokens',
  'finalized_at',
  'position',
]);

export async function updateChapter(
  id: number,
  fields: Partial<Chapter>,
): Promise<void> {
  const chapter = await getChapterById(id);
  const sets = ['updated_at = ?'];
  const values: any[] = [now()];
  for (const [key, value] of Object.entries(fields)) {
    if (!CHAPTER_COLUMNS.has(key)) continue;
    sets.push(`${key} = ?`);
    values.push(
      key === 'summary_json' && value !== null && typeof value !== 'string'
        ? JSON.stringify(value)
        : value,
    );
  }
  if (sets.length === 1) return;
  values.push(id);
  await execute(
    await openDatabase(),
    `UPDATE chapters SET ${sets.join(', ')} WHERE id = ?`,
    values,
  );
  if (chapter) await touchProject(chapter.project_id);
}

export async function deleteChapter(id: number): Promise<void> {
  const chapter = await getChapterById(id);
  await execute(await openDatabase(), 'DELETE FROM chapters WHERE id = ?', [
    id,
  ]);
  if (chapter) await touchProject(chapter.project_id);
}

export async function getFragmentsByProject(
  projectId: number,
): Promise<Fragment[]> {
  return all<Fragment>(
    'SELECT * FROM fragments WHERE project_id = ? ORDER BY position ASC',
    [projectId],
  );
}

export async function createFragment(
  projectId: number,
  type: FragmentType | string,
  content: string,
  position: number,
): Promise<number> {
  const result = await execute(
    await openDatabase(),
    'INSERT INTO fragments (project_id, position, type, content, created_at) VALUES (?, ?, ?, ?, ?)',
    [projectId, position, type, content, now()],
  );
  await touchProject(projectId);
  return result.insertId!;
}

export async function deleteFragment(id: number): Promise<void> {
  await execute(await openDatabase(), 'DELETE FROM fragments WHERE id = ?', [
    id,
  ]);
}

export async function getPlotlinesByProject(
  projectId: number,
): Promise<Plotline[]> {
  return all<Plotline>(
    'SELECT * FROM plotlines WHERE project_id = ? ORDER BY id ASC',
    [projectId],
  );
}

export async function createPlotline(
  projectId: number,
  name: string,
  description: string,
  color: string,
): Promise<number> {
  const result = await execute(
    await openDatabase(),
    'INSERT INTO plotlines (project_id, name, description, color) VALUES (?, ?, ?, ?)',
    [projectId, name, description, color],
  );
  return result.insertId!;
}

export async function deletePlotline(id: number): Promise<void> {
  await execute(await openDatabase(), 'DELETE FROM plotlines WHERE id = ?', [
    id,
  ]);
}

export async function setChapterPlotlines(
  chapterId: number,
  plotlineIds: number[],
): Promise<void> {
  const database = await openDatabase();
  // V2.2.2 修复：改用 runInTransactionSafe（见顶部 helper 注释），
  // 原 `database.transaction(async (tx) => {...})` 在 await 处触发 InvalidStateError。
  const stmts: Array<{ sql: string; params: any[] }> = [
    {
      sql: 'DELETE FROM project_plotlines WHERE chapter_id = ?',
      params: [chapterId],
    },
  ];
  for (const plotlineId of plotlineIds) {
    stmts.push({
      sql: 'INSERT INTO project_plotlines (chapter_id, plotline_id) VALUES (?, ?)',
      params: [chapterId, plotlineId],
    });
  }
  await runInTransactionSafe(database, stmts);
}

export async function getChapterPlotlineIds(
  chapterId: number,
): Promise<number[]> {
  const rows = await all<{ plotline_id: number }>(
    'SELECT plotline_id FROM project_plotlines WHERE chapter_id = ?',
    [chapterId],
  );
  return rows.map(row => row.plotline_id);
}

export async function setProjectResourceEnabled(
  projectId: number,
  resourceType: ResourceType,
  resourceId: number,
  enabled: boolean,
): Promise<void> {
  await execute(
    await openDatabase(),
    'INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, ?)',
    [projectId, resourceType, resourceId, enabled ? 1 : 0],
  );
}

async function deleteProjectResourceLinks(
  resourceType: ResourceType,
  resourceId: number,
): Promise<void> {
  await execute(
    await openDatabase(),
    'DELETE FROM project_resources WHERE resource_type = ? AND resource_id = ?',
    [resourceType, resourceId],
  );
}

async function linkResourceToProject(
  projectId: number,
  resourceType: ResourceType,
  resourceId: number,
): Promise<void> {
  if (projectId > 0) {
    await setProjectResourceEnabled(projectId, resourceType, resourceId, true);
  }
}

function usageJoin(
  resourceType: ResourceType,
  alias: string,
  projectId?: number,
): string {
  if (!projectId) return '0 AS enabled_for_project';
  return `COALESCE((SELECT enabled FROM project_resources pr WHERE pr.project_id = ${Number(
    projectId,
  )} AND pr.resource_type = '${resourceType}' AND pr.resource_id = ${alias}.id), 0) AS enabled_for_project`;
}

export async function getAllCharacters(projectId?: number): Promise<Row[]> {
  return all<Row>(
    `SELECT c.*, cc.name AS collection_name, cc.enabled AS collection_enabled, cc.max_tokens AS collection_max_tokens, ${usageJoin(
      'character',
      'c',
      projectId,
    )}
     FROM characters c
     LEFT JOIN character_collections cc ON cc.id = c.collection_id
     ORDER BY cc.id DESC, c.id DESC`,
  );
}

export async function getCharactersByProject(
  projectId: number,
): Promise<Row[]> {
  return all<Row>(
    `SELECT c.*, cc.name AS collection_name, cc.enabled AS collection_enabled, cc.max_tokens AS collection_max_tokens
     FROM characters c
     JOIN project_resources pr ON pr.resource_id = c.id AND pr.resource_type = 'character'
     LEFT JOIN character_collections cc ON cc.id = c.collection_id
     WHERE pr.project_id = ? AND pr.enabled = 1 AND COALESCE(cc.enabled, 1) = 1
     ORDER BY c.id ASC`,
    [projectId],
  );
}

export async function getCharacterById(id: number): Promise<Row | null> {
  return one<Row>(
    `SELECT c.*, cc.name AS collection_name, cc.enabled AS collection_enabled, cc.max_tokens AS collection_max_tokens
     FROM characters c
     LEFT JOIN character_collections cc ON cc.id = c.collection_id
     WHERE c.id = ?`,
    [id],
  );
}

export async function getCharacterCollections(
  projectId?: number,
): Promise<Row[]> {
  if (!projectId) {
    return all<Row>('SELECT * FROM character_collections ORDER BY id DESC');
  }
  return all<Row>(
    `SELECT cc.*, COUNT(c.id) AS character_count
     FROM character_collections cc
     LEFT JOIN characters c ON c.collection_id = cc.id
     GROUP BY cc.id
     ORDER BY cc.id DESC`,
  );
}

export async function createCharacterCollection(
  _projectId: number,
  name: string,
  extra: Partial<Row> = {},
): Promise<number> {
  const result = await execute(
    await openDatabase(),
    'INSERT INTO character_collections (project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      0,
      name,
      extra.enabled === 0 ? 0 : 1,
      Number(extra.max_tokens || 50000),
      Number(extra.estimated_tokens || 0),
      now(),
    ],
  );
  return result.insertId!;
}

export async function updateCharacterCollection(
  id: number,
  fields: Row,
): Promise<void> {
  await updateColumns(
    'character_collections',
    id,
    new Set(['name', 'enabled', 'max_tokens', 'estimated_tokens']),
    fields,
  );
}

export async function updateCharacterCollectionTokenEstimate(
  id: number,
): Promise<void> {
  const rows = await all<{ estimated_tokens: number }>(
    'SELECT estimated_tokens FROM characters WHERE collection_id = ?',
    [id],
  );
  const estimatedTokens = rows.reduce(
    (total, row) => total + Number(row.estimated_tokens || 0),
    0,
  );
  await updateCharacterCollection(id, { estimated_tokens: estimatedTokens });
}

export async function ensureDefaultCharacterCollection(
  projectId: number,
  name = '未分组角色',
): Promise<number> {
  const existing = await one<{ id: number }>(
    'SELECT id FROM character_collections ORDER BY id ASC LIMIT 1',
  );
  if (existing?.id) return existing.id;
  return createCharacterCollection(projectId, name, { enabled: 1 });
}

export async function getCharactersByCollection(
  collectionId: number,
  projectId?: number,
): Promise<Row[]> {
  return all<Row>(
    `SELECT c.*, cc.name AS collection_name, cc.enabled AS collection_enabled, ${usageJoin(
      'character',
      'c',
      projectId,
    )}
     FROM characters c
     LEFT JOIN character_collections cc ON cc.id = c.collection_id
     WHERE c.collection_id = ?
     ORDER BY c.id DESC`,
    [collectionId],
  );
}

export async function setCharacterCollectionEnabledForProject(
  projectId: number,
  collectionId: number,
  enabled: boolean,
): Promise<void> {
  const database = await openDatabase();
  const rows = await all<{ id: number }>(
    'SELECT id FROM characters WHERE collection_id = ?',
    [collectionId],
  );
  const stmts: Array<{ sql: string; params: any[] }> = [
    {
      sql: 'UPDATE character_collections SET enabled = ? WHERE id = ?',
      params: [enabled ? 1 : 0, collectionId],
    },
  ];
  // projectId=0 表示尚未选择项目，只更新合集全局开关，不写 project_resources
  if (projectId > 0) {
    for (const row of rows) {
      stmts.push({
        sql: 'INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, ?)',
        params: [projectId, 'character', row.id, enabled ? 1 : 0],
      });
    }
  }
  await runInTransactionSafe(database, stmts);
}

export async function setAllCharactersCollectionId(
  projectId: number,
  collectionId: number,
): Promise<void> {
  await execute(
    await openDatabase(),
    'UPDATE characters SET collection_id = ? WHERE collection_id = 0',
    [collectionId],
  );
  await updateCharacterCollectionTokenEstimate(collectionId);
  const rows = await all<{ id: number }>(
    'SELECT id FROM characters WHERE collection_id = ?',
    [collectionId],
  );
  for (const row of rows) {
    await linkResourceToProject(projectId, 'character', row.id);
  }
}

export async function deleteCharacterCollection(id: number): Promise<void> {
  const database = await openDatabase();
  const characters = await all<{ id: number }>(
    'SELECT id FROM characters WHERE collection_id = ?',
    [id],
  );
  const stmts: Array<{ sql: string; params: any[] }> = [];
  for (const character of characters) {
    stmts.push({
      sql: 'DELETE FROM project_resources WHERE resource_type = ? AND resource_id = ?',
      params: ['character', character.id],
    });
  }
  stmts.push({
    sql: 'DELETE FROM characters WHERE collection_id = ?',
    params: [id],
  });
  stmts.push({
    sql: 'DELETE FROM character_collections WHERE id = ?',
    params: [id],
  });
  await runInTransactionSafe(database, stmts);
}

export async function createCharacter(
  projectId: number,
  name: string,
  sourceType: string,
  dataJson: string,
  extra: Partial<Row> = {},
): Promise<number> {
  const estimatedTokens = estimateTokens(dataJson);
  const collectionId = Number(extra.collectionId ?? extra.collection_id ?? 0);
  const result = await execute(
    await openDatabase(),
    'INSERT INTO characters (project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      0,
      collectionId,
      name,
      sourceType,
      dataJson,
      Number(extra.max_tokens || 50000),
      estimatedTokens,
      now(),
    ],
  );
  const id = result.insertId!;
  await linkResourceToProject(projectId, 'character', id);
  if (collectionId) await updateCharacterCollectionTokenEstimate(collectionId);
  return id;
}

export async function updateCharacter(
  id: number,
  name: string,
  dataJson: string,
): Promise<void> {
  const existing = await getCharacterById(id);
  await execute(
    await openDatabase(),
    'UPDATE characters SET name = ?, data_json = ?, estimated_tokens = ? WHERE id = ?',
    [name, dataJson, estimateTokens(dataJson), id],
  );
  if (existing?.collection_id)
    await updateCharacterCollectionTokenEstimate(
      Number(existing.collection_id),
    );
}

export async function updateCharacterTokenBudget(
  id: number,
  maxTokens: number,
): Promise<void> {
  const existing = await getCharacterById(id);
  await execute(
    await openDatabase(),
    'UPDATE characters SET max_tokens = ? WHERE id = ?',
    [maxTokens, id],
  );
  if (existing?.collection_id)
    await updateCharacterCollectionTokenEstimate(
      Number(existing.collection_id),
    );
}

export async function deleteCharacter(id: number): Promise<void> {
  const existing = await getCharacterById(id);
  await deleteProjectResourceLinks('character', id);
  await execute(await openDatabase(), 'DELETE FROM characters WHERE id = ?', [
    id,
  ]);
  if (existing?.collection_id)
    await updateCharacterCollectionTokenEstimate(
      Number(existing.collection_id),
    );
}

export async function getAllWorldbookEntries(
  projectId?: number,
): Promise<Row[]> {
  return all<Row>(
    `SELECT w.*, wc.name AS collection_name, wc.enabled AS collection_enabled, wc.max_tokens AS collection_max_tokens, ${usageJoin(
      'worldbook',
      'w',
      projectId,
    )}
     FROM worldbook_entries w
     LEFT JOIN worldbook_collections wc ON wc.id = w.collection_id
     ORDER BY wc.id DESC, w.position ASC, w.id DESC`,
  );
}

export async function setAllProjectResourcesEnabled(
  projectId: number,
  resourceType: ResourceType,
  enabled: boolean,
): Promise<void> {
  const idColumnSql: Record<ResourceType, string> = {
    character: 'SELECT id FROM characters',
    worldbook: 'SELECT id FROM worldbook_entries',
    note: 'SELECT id FROM notes',
    preset: 'SELECT id FROM presets',
  };
  const rows = await all<{ id: number }>(idColumnSql[resourceType]);
  for (const row of rows) {
    await setProjectResourceEnabled(projectId, resourceType, row.id, enabled);
  }
}

export async function setWorldbookCollectionEnabledForProject(
  projectId: number,
  collectionId: number,
  enabled: boolean,
): Promise<void> {
  const database = await openDatabase();
  // V2.2.2 修复：改用 runInTransactionSafe。先做必要的 async 读（entry id 列表），
  // 再把所有写入合并到一次同步 push 的事务里。
  const stmts: Array<{ sql: string; params: any[] }> = [
    {
      sql: 'UPDATE worldbook_collections SET enabled = ? WHERE id = ?',
      params: [enabled ? 1 : 0, collectionId],
    },
  ];
  if (enabled) {
    stmts.push({
      sql: 'UPDATE worldbook_entries SET enabled = 1 WHERE collection_id = ?',
      params: [collectionId],
    });
    const rows = await all<{ id: number }>(
      'SELECT id FROM worldbook_entries WHERE collection_id = ?',
      [collectionId],
    );
    for (const row of rows) {
      stmts.push({
        sql: 'INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, 1)',
        params: [projectId, 'worldbook', row.id],
      });
    }
  }
  await runInTransactionSafe(database, stmts);
}

export async function getWorldbookEntriesByProject(
  projectId: number,
): Promise<Row[]> {
  return all<Row>(
    `SELECT w.*, wc.name AS collection_name, wc.enabled AS collection_enabled, wc.max_tokens AS collection_max_tokens FROM worldbook_entries w
     JOIN project_resources pr ON pr.resource_id = w.id AND pr.resource_type = 'worldbook'
     LEFT JOIN worldbook_collections wc ON wc.id = w.collection_id
     WHERE pr.project_id = ? AND pr.enabled = 1 AND w.enabled = 1 AND COALESCE(wc.enabled, 1) = 1
     ORDER BY w.position ASC, w.id ASC`,
    [projectId],
  );
}

export async function getWorldbookCollections(
  projectId?: number,
): Promise<Row[]> {
  if (!projectId) {
    return all<Row>('SELECT * FROM worldbook_collections ORDER BY id DESC');
  }
  return all<Row>(
    `SELECT wc.*, COUNT(w.id) AS entry_count
     FROM worldbook_collections wc
     LEFT JOIN worldbook_entries w ON w.collection_id = wc.id
     LEFT JOIN project_resources pr ON pr.resource_id = w.id AND pr.resource_type = 'worldbook' AND pr.project_id = ?
     GROUP BY wc.id
     ORDER BY wc.id DESC`,
    [projectId],
  );
}

export async function createWorldbookCollection(
  projectId: number,
  name: string,
  extra: Partial<Row> = {},
): Promise<number> {
  const result = await execute(
    await openDatabase(),
    'INSERT INTO worldbook_collections (project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      0,
      name,
      extra.enabled === 0 ? 0 : 1,
      Number(extra.max_tokens || 50000),
      Number(extra.estimated_tokens || 0),
      now(),
    ],
  );
  return result.insertId!;
}

export async function updateWorldbookCollection(
  id: number,
  fields: Row,
): Promise<void> {
  await updateColumns(
    'worldbook_collections',
    id,
    new Set(['name', 'enabled', 'max_tokens', 'estimated_tokens']),
    fields,
  );
}

export async function updateWorldbookCollectionTokenEstimate(
  id: number,
): Promise<void> {
  const rows = await all<{ content: string }>(
    'SELECT content FROM worldbook_entries WHERE collection_id = ?',
    [id],
  );
  const estimatedTokens = rows.reduce(
    (total, row) => total + estimateTokens(row.content),
    0,
  );
  await updateWorldbookCollection(id, { estimated_tokens: estimatedTokens });
}

export async function deleteWorldbookCollection(id: number): Promise<void> {
  const database = await openDatabase();
  const entries = await all<{ id: number }>(
    'SELECT id FROM worldbook_entries WHERE collection_id = ?',
    [id],
  );
  // V2.2.2 修复：改用 runInTransactionSafe。先 async 读 entry id，再合并到一次同步 push 事务。
  const stmts: Array<{ sql: string; params: any[] }> = [];
  for (const entry of entries) {
    stmts.push({
      sql: 'DELETE FROM project_resources WHERE resource_type = ? AND resource_id = ?',
      params: ['worldbook', entry.id],
    });
  }
  stmts.push({
    sql: 'DELETE FROM worldbook_entries WHERE collection_id = ?',
    params: [id],
  });
  stmts.push({
    sql: 'DELETE FROM worldbook_collections WHERE id = ?',
    params: [id],
  });
  await runInTransactionSafe(database, stmts);
}

export async function getWorldbookEntryById(id: number): Promise<Row | null> {
  return one<Row>('SELECT * FROM worldbook_entries WHERE id = ?', [id]);
}

export async function getWorldbookEntriesByCollection(
  collectionId: number,
): Promise<Row[]> {
  return all<Row>(
    'SELECT * FROM worldbook_entries WHERE collection_id = ? ORDER BY position ASC, id ASC',
    [collectionId],
  );
}

export async function createWorldbookEntry(
  projectId: number,
  keywordPrimary: string,
  content: string,
  enabled: number,
  extra: Partial<Row> = {},
): Promise<number> {
  const estimatedTokens = estimateTokens(content);
  const result = await execute(
    await openDatabase(),
    'INSERT INTO worldbook_entries (project_id, collection_id, keyword_primary, keyword_secondary, content, comment, enabled, constant, max_tokens, estimated_tokens, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      0,
      Number(extra.collection_id || 0),
      keywordPrimary,
      extra.keyword_secondary || '',
      content,
      extra.comment || '',
      enabled,
      Number(extra.constant || 0),
      Number(extra.max_tokens || 2000),
      estimatedTokens,
      Number(extra.position || 0),
      now(),
    ],
  );
  const id = result.insertId!;
  await linkResourceToProject(projectId, 'worldbook', id);
  if (extra.collection_id)
    await updateWorldbookCollectionTokenEstimate(Number(extra.collection_id));
  return id;
}

const WB_COLUMNS = new Set([
  'collection_id',
  'keyword_primary',
  'keyword_secondary',
  'content',
  'comment',
  'enabled',
  'constant',
  'max_tokens',
  'estimated_tokens',
  'position',
]);

export async function updateWorldbookEntry(
  id: number,
  fields: Row,
): Promise<void> {
  if (typeof fields.content === 'string' && fields.estimated_tokens == null) {
    fields.estimated_tokens = estimateTokens(fields.content);
  }
  await updateColumns('worldbook_entries', id, WB_COLUMNS, fields);
  const entry = await getWorldbookEntryById(id);
  if (entry?.collection_id)
    await updateWorldbookCollectionTokenEstimate(Number(entry.collection_id));
}

export async function deleteWorldbookEntry(id: number): Promise<void> {
  const entry = await getWorldbookEntryById(id);
  await deleteProjectResourceLinks('worldbook', id);
  await execute(
    await openDatabase(),
    'DELETE FROM worldbook_entries WHERE id = ?',
    [id],
  );
  if (entry?.collection_id)
    await updateWorldbookCollectionTokenEstimate(Number(entry.collection_id));
}

export function splitNoteTextIntoChunks(
  text: string,
  chunkSize = NOTE_TEXT_CHUNK_CHARS,
): string[] {
  if (!text) return [''];
  if (text.length <= chunkSize) return [text];

  const chapters = getNoteChapters(text);
  if (chapters.length > 1) {
    const chunkStarts = chapters[0].offset > 0 ? [{ title: '', offset: 0 }, ...chapters] : chapters;
    return packChaptersIntoNoteChunks(
      chunkStarts.map((chapter, index) =>
        text.slice(chapter.offset, chunkStarts[index + 1]?.offset ?? text.length),
      ),
      chunkSize,
    );
  }
  return splitOversizedNoteText(text, chunkSize);
}

function packChaptersIntoNoteChunks(chapters: string[], chunkSize: number): string[] {
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current) chunks.push(current);
    current = '';
  };

  for (const chapter of chapters) {
    if (chapter.length > chunkSize) {
      flush();
      chunks.push(...splitOversizedNoteText(chapter, chunkSize));
    } else if (current.length + chapter.length <= chunkSize) {
      current += chapter;
    } else {
      flush();
      current = chapter;
    }
  }
  flush();
  return chunks;
}

function splitOversizedNoteText(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end);
      if (newline > start + Math.floor(chunkSize * 0.5)) {
        end = newline + 1;
      }
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

async function insertNoteRow(
  database: SQLite.SQLiteDatabase,
  title: string,
  content: string,
): Promise<number> {
  const timestamp = now();
  const result = await execute(
    database,
    'INSERT INTO notes (project_id, title, content, max_tokens, estimated_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [0, title, content, 30000, estimateTokens(content), timestamp, timestamp],
  );
  return result.insertId!;
}

export async function createNotesFromTextChunks(
  projectId: number,
  title: string,
  content: string,
): Promise<{ firstId: number; createdCount: number }> {
  const database = await openDatabase();
  const chunks = splitNoteTextIntoChunks(content);
  let firstId = 0;
  for (let i = 0; i < chunks.length; i++) {
    const noteTitle =
      chunks.length === 1 ? title : `${title} (${i + 1}/${chunks.length})`;
    const id = await insertNoteRow(database, noteTitle, chunks[i]);
    if (!firstId) firstId = id;
    await linkResourceToProject(projectId, 'note', id);
  }
  return { firstId, createdCount: chunks.length };
}

async function getNoteContentByIdFromDatabase(
  database: SQLite.SQLiteDatabase,
  id: number,
): Promise<string> {
  const meta = await execute(
    database,
    'SELECT length(content) AS length FROM notes WHERE id = ?',
    [id],
  );
  if (meta.rows.length === 0) return '';
  const totalLength = Number(meta.rows.item(0).length || 0);
  let content = '';
  for (let offset = 1; offset <= totalLength; offset += NOTE_TEXT_CHUNK_CHARS) {
    const result = await execute(
      database,
      'SELECT substr(content, ?, ?) AS chunk FROM notes WHERE id = ?',
      [offset, NOTE_TEXT_CHUNK_CHARS, id],
    );
    content += result.rows.item(0)?.chunk || '';
  }
  return content;
}

export async function getNoteContentById(id: number): Promise<string> {
  return getNoteContentByIdFromDatabase(await openDatabase(), id);
}

/**
 * V2.2.0：批量读取笔记内容，返回 id → content 映射。
 *
 * 单条实现 getNoteContentById 在 60 条笔记时是 60 次 round-trip（每条还会按 120k 分块多次 fetch）。
 * 这里一次性把所有 chunk 拉回来按 id 聚合，1 次 round-trip。
 *
 * ids 为空直接返回空 Map；不抛错。ids 中不存在的 id 不会出现在结果中（调用方按需 fallback）。
 */
export async function getNotesContentByIds(
  ids: number[],
): Promise<Record<number, string>> {
  const out: Record<number, string> = {};
  if (!ids?.length) return out;
  const idList = ids.filter(n => Number.isFinite(n) && n > 0);
  if (idList.length === 0) return out;
  const placeholders = idList.map(() => '?').join(',');
  const rows = await all<{ id: number; chunk: string }>(
    `SELECT id, substr(content, ?, ?) AS chunk
     FROM notes
     WHERE id IN (${placeholders})`,
    [1, NOTE_TEXT_CHUNK_CHARS, ...idList],
  );
  // 同 id 的多个 chunk 按顺序追加（SQLite substr 配合 OFFSET 即可保证顺序）
  for (const row of rows) {
    const id = Number(row.id);
    out[id] = (out[id] || '') + (row.chunk || '');
  }
  // 大小超过 NOTE_TEXT_CHUNK_CHARS 的笔记续拉：
  // 用第二次查询拿到每个 id 的总长度，然后追加（NOTE_TEXT_CHUNK_CHARS 截断的尾巴）
  const idsNeedingMore: Array<{ id: number; offset: number }> = [];
  const lengthRows = await all<{ id: number; length: number }>(
    `SELECT id, length(content) AS length FROM notes WHERE id IN (${placeholders})`,
    idList,
  );
  for (const lr of lengthRows) {
    let off = NOTE_TEXT_CHUNK_CHARS + 1;
    while (off <= Number(lr.length || 0)) {
      idsNeedingMore.push({ id: Number(lr.id), offset: off });
      off += NOTE_TEXT_CHUNK_CHARS;
    }
  }
  if (idsNeedingMore.length > 0) {
    // 仍然批量：按 offset 分组批量查
    const groupedByOffset = new Map<number, number[]>();
    for (const r of idsNeedingMore) {
      if (!groupedByOffset.has(r.offset)) groupedByOffset.set(r.offset, []);
      groupedByOffset.get(r.offset)!.push(r.id);
    }
    for (const [offset, subIds] of groupedByOffset.entries()) {
      const ph = subIds.map(() => '?').join(',');
      const moreRows = await all<{ id: number; chunk: string }>(
        `SELECT id, substr(content, ?, ?) AS chunk FROM notes WHERE id IN (${ph})`,
        [offset, NOTE_TEXT_CHUNK_CHARS, ...subIds],
      );
      for (const row of moreRows) {
        const id = Number(row.id);
        out[id] = (out[id] || '') + (row.chunk || '');
      }
    }
  }
  return out;
}

async function repairOversizedNotes(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  try {
    const oversized = await execute(
      database,
      'SELECT id, title FROM notes WHERE length(content) > ? ORDER BY id ASC',
      [NOTE_TEXT_CHUNK_CHARS],
    );
    for (let i = 0; i < oversized.rows.length; i++) {
      const note = oversized.rows.item(i);
      const content = await getNoteContentByIdFromDatabase(database, note.id);
      const chunks = splitNoteTextIntoChunks(content);
      if (chunks.length <= 1) continue;
      const links = await execute(
        database,
        'SELECT project_id, enabled FROM project_resources WHERE resource_type = ? AND resource_id = ?',
        ['note', note.id],
      );
      // V2.2.2 修复：改用 runInTransactionSafe（见 helper 注释）。
      // 原 `database.transaction(async (tx) => {...})` 在 await 处触发 InvalidStateError。
      // 修法：先在事务外 async 收集数据（chunks/links 已经在上层异步读好），
      // 把所有 INSERT/DELETE 推入一次同步的事务执行。
      const timestamp = now();
      // 先 INSERT 新 chunk 拿 id。SQLite 在事务外自增 id 是稳定的（auto-increment counter 单调递增），
      // 但要注意：mock 模式下 insertId 都返回 100；真机下 SQLite 库会分配真实 id。
      // 由于 chunk 数和资源链接数都是已知的，我们直接用占位：原代码用 tx.executeSql 拿 insertId，
      // 现在改为分两步：第一步非事务 INSERT 取 id，第二步再事务化迁移链接 + 删旧。
      // 这是为了彻底绕开"async 拿 insertId"的需要。
      const newIds: number[] = [];
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const insertResult = await execute(
          database,
          'INSERT INTO notes (project_id, title, content, max_tokens, estimated_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            0,
            `${note.title} (${chunkIndex + 1}/${chunks.length})`,
            chunks[chunkIndex],
            30000,
            estimateTokens(chunks[chunkIndex]),
            timestamp,
            timestamp,
          ],
        );
        newIds.push(insertResult.insertId!);
      }
      const linkRows: Array<{ project_id: number; enabled: number }> = [];
      for (let linkIndex = 0; linkIndex < links.rows.length; linkIndex++) {
        const link = links.rows.item(linkIndex);
        linkRows.push({
          project_id: Number(link.project_id),
          enabled: Number(link.enabled),
        });
      }
      const migrationStmts: Array<{ sql: string; params: any[] }> = [];
      for (const newId of newIds) {
        for (const link of linkRows) {
          migrationStmts.push({
            sql: 'INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, ?)',
            params: [link.project_id, 'note', newId, link.enabled],
          });
        }
      }
      migrationStmts.push({
        sql: 'DELETE FROM project_resources WHERE resource_type = ? AND resource_id = ?',
        params: ['note', note.id],
      });
      migrationStmts.push({
        sql: 'DELETE FROM notes WHERE id = ?',
        params: [note.id],
      });
      await runInTransactionSafe(database, migrationStmts);
    }
  } catch (error) {
    console.warn('[database] repairOversizedNotes failed:', error);
  }
}

export async function getAllNotes(projectId?: number): Promise<Note[]> {
  return all<Note>(
    `SELECT n.id, n.project_id, n.title, substr(n.content, 1, ${NOTE_LIST_PREVIEW_CHARS}) AS content,
            n.max_tokens, n.estimated_tokens, n.created_at, n.updated_at, ${usageJoin(
              'note',
              'n',
              projectId,
            )}
     FROM notes n ORDER BY n.updated_at DESC`,
  );
}

export async function getNotesByProject(projectId: number): Promise<Note[]> {
  return all<Note>(
    `SELECT n.id, n.project_id, n.title, substr(n.content, 1, ${NOTE_LIST_PREVIEW_CHARS}) AS content,
            n.max_tokens, n.estimated_tokens, n.created_at, n.updated_at
     FROM notes n
     JOIN project_resources pr ON pr.resource_id = n.id AND pr.resource_type = 'note'
     WHERE pr.project_id = ? AND pr.enabled = 1
     ORDER BY n.updated_at DESC`,
    [projectId],
  );
}

export async function createNote(
  projectId: number,
  title: string,
  content = '',
): Promise<number> {
  const id = await insertNoteRow(await openDatabase(), title, content);
  await linkResourceToProject(projectId, 'note', id);
  return id;
}

export async function updateNote(
  id: number,
  title: string,
  content: string,
): Promise<void> {
  await execute(
    await openDatabase(),
    'UPDATE notes SET title = ?, content = ?, estimated_tokens = ?, updated_at = ? WHERE id = ?',
    [title, content, estimateTokens(content), now(), id],
  );
}

export async function updateNoteTokenBudget(
  id: number,
  maxTokens: number,
): Promise<void> {
  await execute(
    await openDatabase(),
    'UPDATE notes SET max_tokens = ? WHERE id = ?',
    [maxTokens, id],
  );
}

export async function deleteNote(id: number): Promise<void> {
  await deleteProjectResourceLinks('note', id);
  await execute(await openDatabase(), 'DELETE FROM notes WHERE id = ?', [id]);
}

export async function getAllPresets(projectId?: number): Promise<Preset[]> {
  return all<Preset>(
    `SELECT p.*, ${usageJoin(
      'preset',
      'p',
      projectId,
    )} FROM presets p ORDER BY p.is_default DESC, p.id ASC`,
  );
}

export async function getPresetsByProject(
  projectId: number,
): Promise<Preset[]> {
  return all<Preset>(
    `SELECT p.* FROM presets p
     JOIN project_resources pr ON pr.resource_id = p.id AND pr.resource_type = 'preset'
     WHERE pr.project_id = ? AND pr.enabled = 1
     ORDER BY p.is_default DESC, p.id ASC`,
    [projectId],
  );
}

const PRESET_COLUMNS = new Set([
  'name',
  'is_default',
  'system_prompt',
  'writing_style',
  'temperature',
  'top_p',
  'max_tokens',
  'extra_instructions',
]);

export async function updatePreset(
  id: number,
  fields: Partial<Preset>,
): Promise<void> {
  if (fields.is_default === 1) {
    await execute(
      await openDatabase(),
      'UPDATE presets SET is_default = 0 WHERE id != ?',
      [id],
    );
  }
  await updateColumns('presets', id, PRESET_COLUMNS, fields);
}

export async function createPreset(
  projectId: number,
  name: string,
  isDefault = false,
): Promise<number> {
  if (isDefault) {
    await execute(await openDatabase(), 'UPDATE presets SET is_default = 0');
  }
  const result = await execute(
    await openDatabase(),
    `INSERT INTO presets (project_id, name, is_default, system_prompt, writing_style, temperature, top_p, max_tokens, extra_instructions)
     VALUES (?, ?, ?, ?, ?, 0.8, 0.9, 4000, ?)`,
    [
      0,
      name,
      isDefault ? 1 : 0,
      '你是一位经验丰富的中文小说作者。请保持人物一致、场景清晰、节奏自然，并承接上文继续创作。',
      '文学化叙事，注重氛围和人物心理。',
      '每次输出控制在 800-1500 字，结尾自然停在段落或情节转折处。',
    ],
  );
  const id = result.insertId!;
  await linkResourceToProject(projectId, 'preset', id);
  return id;
}

export async function deletePreset(id: number): Promise<void> {
  await deleteProjectResourceLinks('preset', id);
  await execute(await openDatabase(), 'DELETE FROM presets WHERE id = ?', [id]);
}

async function ensureDefaultPreset(
  database?: SQLite.SQLiteDatabase,
): Promise<number> {
  const target = database || (await openDatabase());
  const existing = await execute(
    target,
    'SELECT id FROM presets WHERE is_default = 1 ORDER BY id ASC LIMIT 1',
  );
  if (existing.rows.length > 0) return existing.rows.item(0).id;

  // If user already has presets (e.g. from a previous version), respect them —
  // do NOT create a duplicate default preset during upgrades.
  const anyPreset = await execute(
    target,
    'SELECT id FROM presets ORDER BY id ASC LIMIT 1',
  );
  if (anyPreset.rows.length > 0) return anyPreset.rows.item(0).id;

  const result = await execute(
    target,
    `INSERT INTO presets (project_id, name, is_default, system_prompt, writing_style, temperature, top_p, max_tokens, extra_instructions)
     VALUES (?, ?, 1, ?, ?, 0.8, 0.9, 4000, ?)`,
    [
      0,
      '默认写作预设',
      '你是一位经验丰富的中文小说作者。请保持人物一致、场景清晰、节奏自然，并承接上文继续创作。',
      '文学化叙事，注重氛围和人物心理。',
      '每次输出控制在 800-1500 字，结尾自然停在段落或情节转折处。',
    ],
  );
  return result.insertId!;
}

function normalizeLLMConfig(row?: Partial<LLMConfig> | null): LLMConfig {
  return {
    id: Number(row?.id || 1),
    name: row?.name || '默认配置',
    provider_type: row?.provider_type || 'openai_compatible',
    base_url: row?.base_url || '',
    api_key: row?.api_key || '',
    model_name: row?.model_name || '',
    is_active: Number(row?.is_active ?? 1),
    local_model_id: row?.local_model_id ?? null,
    local_backend: row?.local_backend ?? null,
    context_window: Number(row?.context_window ?? 4096),
    max_output_tokens: Number(row?.max_output_tokens ?? 4000),
  };
}

async function hydrateLLMConfig(row: LLMConfig): Promise<LLMConfig> {
  let apiKey = await getSecureLLMApiKey(row.id);
  if (!apiKey && row.id === 1) {
    apiKey = await migrateLegacyLLMApiKey(row.id);
  }
  if (row.api_key && !apiKey) {
    apiKey = row.api_key;
    await setSecureLLMApiKey(row.api_key, row.id);
  }
  if (row.api_key) {
    await execute(
      await openDatabase(),
      'UPDATE llm_config SET api_key = ? WHERE id = ?',
      ['', row.id],
    );
  }
  return { ...row, api_key: apiKey };
}

export async function getLLMConfigs(): Promise<LLMConfig[]> {
  const rows = await all<LLMConfig>(
    'SELECT * FROM llm_config ORDER BY is_active DESC, id ASC',
  );
  if (rows.length === 0) {
    await execute(
      await openDatabase(),
      `INSERT INTO llm_config (
        name, provider_type, base_url, api_key, model_name, is_active,
        local_model_id, local_backend, context_window, max_output_tokens
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      ['默认配置', 'openai_compatible', '', '', '', null, null, 4096, 4000],
    );
    return getLLMConfigs();
  }
  return Promise.all(
    rows.map(row => hydrateLLMConfig(normalizeLLMConfig(row))),
  );
}

export async function getActiveLLMConfig(): Promise<LLMConfig> {
  let config = await one<LLMConfig>(
    'SELECT * FROM llm_config WHERE is_active = 1 ORDER BY id ASC LIMIT 1',
  );
  if (!config) {
    const fallback = await one<LLMConfig>(
      'SELECT * FROM llm_config ORDER BY id ASC LIMIT 1',
    );
    if (!fallback) {
      const id = await saveLLMConfig({
        name: '默认配置',
        base_url: '',
        api_key: '',
        model_name: '',
        is_active: 1,
      });
      config = await one<LLMConfig>('SELECT * FROM llm_config WHERE id = ?', [
        id,
      ]);
    } else {
      await setActiveLLMConfig(fallback.id);
      config = await one<LLMConfig>('SELECT * FROM llm_config WHERE id = ?', [
        fallback.id,
      ]);
    }
  }
  return hydrateLLMConfig(normalizeLLMConfig(config));
}

export async function saveLLMConfig(
  config: Partial<LLMConfig>,
): Promise<number> {
  const name = (config.name || '').trim() || '未命名配置';
  const providerType = config.provider_type || 'openai_compatible';
  const baseUrl = (config.base_url || '').trim();
  const modelName = (config.model_name || '').trim();
  const localModelId = config.local_model_id ?? null;
  const localBackend = config.local_backend ?? null;
  const contextWindow = Number(config.context_window ?? 4096);
  const maxOutputTokens = Number(config.max_output_tokens ?? 4000);
  const database = await openDatabase();
  // 修复#A: UPDATE 不再写 is_active 字段，避免用过时的 draft.is_active 把刚被 setActiveLLMConfig
  // 激活的配置又写回 0。is_active 的写入权专属 setActiveLLMConfig / INSERT 初始值。
  // 仅当用户显式要求 is_active=1 时，才在 INSERT 写入并在保存后调用 setActiveLLMConfig 激活。
  const shouldActivate = Number(config.is_active ?? 0) === 1;

  let id = Number(config.id || 0);
  if (id > 0) {
    await execute(
      database,
      `UPDATE llm_config SET
        name = ?, provider_type = ?, base_url = ?, api_key = ?, model_name = ?,
        local_model_id = ?, local_backend = ?, context_window = ?, max_output_tokens = ?
      WHERE id = ?`,
      [
        name,
        providerType,
        baseUrl,
        '',
        modelName,
        localModelId,
        localBackend,
        contextWindow,
        maxOutputTokens,
        id,
      ],
    );
  } else {
    const result = await execute(
      database,
      `INSERT INTO llm_config (
        name, provider_type, base_url, api_key, model_name, is_active,
        local_model_id, local_backend, context_window, max_output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        providerType,
        baseUrl,
        '',
        modelName,
        shouldActivate ? 1 : 0,
        localModelId,
        localBackend,
        contextWindow,
        maxOutputTokens,
      ],
    );
    id = Number(result.insertId);
    // V2.2.1 修复：react-native-sqlite-storage 6.0.1 在部分机型/事务场景下
    // result.insertId 可能是 undefined 或 0，导致上层 setSelectedId(0) 触发
    // LLMSettingsScreen useEffect 的「selectedId === 0 时提前 return」分支，
    // draft 永远不更新，"设为当前"按钮一直弹"请先保存"。
    // 用 last_insert_rowid() 显式查询新行 rowid 作为后备。
    if (!Number.isFinite(id) || id <= 0) {
      const row = await one<{ id: number }>('SELECT last_insert_rowid() AS id');
      id = Number(row?.id || 0);
    }
  }

  if (config.api_key !== undefined) {
    await setSecureLLMApiKey(config.api_key, id);
  }
  if (shouldActivate) {
    await setActiveLLMConfig(id);
  }
  return id;
}

export async function setActiveLLMConfig(id: number): Promise<void> {
  const database = await openDatabase();
  // V2.2.1 修复：react-native-sqlite-storage 6.0.1 的 transaction 在 async 回调下
  // 可能只执行第一个 executeSql 就提前提交，导致第二个 UPDATE is_active=1 WHERE id=?
  // 丢失，UI 标题显示"当前：未选择"。改为两个独立 execute，确保两个 UPDATE 都执行。
  // 非原子操作，但切换激活状态不需要严格原子性（最坏情况是短暂的全 is_active=0，
  // 下次 loadSettings 的自愈逻辑会兜底）。
  await execute(database, 'UPDATE llm_config SET is_active = 0');
  await execute(database, 'UPDATE llm_config SET is_active = 1 WHERE id = ?', [
    id,
  ]);
}

export async function deleteLLMConfig(id: number): Promise<void> {
  const configs = await getLLMConfigs();
  if (configs.length <= 1) {
    throw new Error('至少需要保留一个 LLM 配置。');
  }

  const target = configs.find(config => config.id === id);
  const database = await openDatabase();
  // 11.8 修复：DELETE + 切换激活配置整体包进事务，保证原子性；
  // clearSecureLLMApiKey 是异步 keystore 操作，放事务外执行避免嵌入 SQLite 事务
  await database.transaction(async tx => {
    const txx = tx as unknown as SQLite.SQLiteDatabase;
    await execute(txx, 'DELETE FROM llm_config WHERE id = ?', [id]);
    if (target?.is_active === 1) {
      const next = await execute(
        txx,
        'SELECT id FROM llm_config ORDER BY id ASC LIMIT 1',
      );
      if (next.rows.length > 0) {
        const nextId = next.rows.item(0).id;
        await execute(txx, 'UPDATE llm_config SET is_active = 0');
        await execute(txx, 'UPDATE llm_config SET is_active = 1 WHERE id = ?', [
          nextId,
        ]);
      }
    }
  });
  await clearSecureLLMApiKey(id);
}

export async function getLLMConfig(): Promise<LLMConfig> {
  return getActiveLLMConfig();
}

export async function setLLMConfig(
  baseUrl: string,
  apiKey: string,
  modelName: string,
): Promise<void> {
  const active = await getActiveLLMConfig();
  await saveLLMConfig({
    ...active,
    base_url: baseUrl,
    api_key: apiKey,
    model_name: modelName,
    is_active: 1,
  });
}

export async function listLocalModels(): Promise<LocalModel[]> {
  const database = await openDatabase();
  const result = await execute(
    database,
    'SELECT * FROM local_llm_models ORDER BY imported_at DESC',
  );
  const models: LocalModel[] = [];
  for (let i = 0; i < result.rows.length; i += 1) {
    models.push(result.rows.item(i) as LocalModel);
  }
  return models;
}

export async function getLocalModelById(
  id: string,
): Promise<LocalModel | null> {
  const database = await openDatabase();
  const result = await execute(
    database,
    'SELECT * FROM local_llm_models WHERE id = ?',
    [id],
  );
  return result.rows.length > 0 ? (result.rows.item(0) as LocalModel) : null;
}

export async function getLocalModelBySha256(
  sha256: string,
): Promise<LocalModel | null> {
  const database = await openDatabase();
  const result = await execute(
    database,
    'SELECT * FROM local_llm_models WHERE sha256 = ?',
    [sha256],
  );
  return result.rows.length > 0 ? (result.rows.item(0) as LocalModel) : null;
}

export async function createLocalModel(
  model: Omit<LocalModel, 'imported_at'> & { imported_at?: string },
): Promise<void> {
  const database = await openDatabase();
  await execute(
    database,
    `INSERT INTO local_llm_models (
      id, display_name, original_filename, relative_path, file_size, sha256,
      status, backend_preference, validated_backend,
      context_length, max_output_tokens,
      load_time_ms, first_token_ms, tokens_per_second,
      imported_at, last_used_at, last_validated_at, error_code, error_message,
      prompt_template, actual_backend
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      model.id,
      model.display_name,
      model.original_filename,
      model.relative_path,
      model.file_size,
      model.sha256,
      model.status,
      model.backend_preference,
      model.validated_backend,
      model.context_length,
      model.max_output_tokens,
      model.load_time_ms,
      model.first_token_ms,
      model.tokens_per_second,
      model.imported_at || now(),
      model.last_used_at,
      model.last_validated_at,
      model.error_code,
      model.error_message,
      model.prompt_template,
      model.actual_backend,
    ],
  );
}

export async function updateLocalModel(
  id: string,
  fields: Partial<Omit<LocalModel, 'id' | 'sha256'>>,
): Promise<void> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => (fields as Record<string, any>)[k]);
  const database = await openDatabase();
  await execute(database, `UPDATE local_llm_models SET ${sets} WHERE id = ?`, [
    ...values,
    id,
  ]);
}

export async function deleteLocalModelRecord(id: string): Promise<void> {
  const database = await openDatabase();
  await execute(database, 'DELETE FROM local_llm_models WHERE id = ?', [id]);
}

export async function countLLMConfigsUsingModel(
  modelId: string,
): Promise<number> {
  const database = await openDatabase();
  const result = await execute(
    database,
    'SELECT COUNT(*) AS cnt FROM llm_config WHERE local_model_id = ?',
    [modelId],
  );
  return result.rows.length > 0 ? Number(result.rows.item(0).cnt || 0) : 0;
}

export async function getSetting(key: string): Promise<string | null> {
  const row = await one<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    [key],
  );
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await execute(
    await openDatabase(),
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    [key, value],
  );
}

export async function getContextConfig(): Promise<ContextConfig> {
  return {
    strategy:
      ((await getSetting('context_strategy')) as ContextConfig['strategy']) ||
      DEFAULT_CONTEXT_CONFIG.strategy,
    slidingWindowSize: Number(
      (await getSetting('sliding_window_size')) ||
        DEFAULT_CONTEXT_CONFIG.slidingWindowSize,
    ),
    customRangeStart: Number(
      (await getSetting('custom_range_start')) ||
        DEFAULT_CONTEXT_CONFIG.customRangeStart,
    ),
    customRangeEnd: Number(
      (await getSetting('custom_range_end')) ||
        DEFAULT_CONTEXT_CONFIG.customRangeEnd,
    ),
    resourceBudget: Number(
      (await getSetting('resource_budget')) ||
        DEFAULT_CONTEXT_CONFIG.resourceBudget,
    ),
    includeResources: (await getSetting('include_resources')) !== 'false',
    summaryBudgetTokens: Number(
      (await getSetting('summary_budget_tokens')) ||
        DEFAULT_CONTEXT_CONFIG.summaryBudgetTokens,
    ),
    memoryTopK: Number(
      (await getSetting('memory_top_k')) || DEFAULT_CONTEXT_CONFIG.memoryTopK,
    ),
    recentChapterCount: Number(
      (await getSetting('recent_chapter_count')) ||
        DEFAULT_CONTEXT_CONFIG.recentChapterCount,
    ),
    worldbookRecursive: (await getSetting('worldbook_recursive')) !== 'false',
    worldbookScanDepth: Number(
      (await getSetting('worldbook_scan_depth')) ||
        DEFAULT_CONTEXT_CONFIG.worldbookScanDepth,
    ),
  };
}

export async function setContextConfig(config: ContextConfig): Promise<void> {
  await setSetting('context_strategy', config.strategy);
  await setSetting('sliding_window_size', String(config.slidingWindowSize));
  await setSetting('custom_range_start', String(config.customRangeStart));
  await setSetting('custom_range_end', String(config.customRangeEnd));
  await setSetting('resource_budget', String(config.resourceBudget));
  await setSetting('include_resources', String(config.includeResources));
  await setSetting(
    'summary_budget_tokens',
    String(
      config.summaryBudgetTokens ?? DEFAULT_CONTEXT_CONFIG.summaryBudgetTokens,
    ),
  );
  await setSetting(
    'memory_top_k',
    String(config.memoryTopK ?? DEFAULT_CONTEXT_CONFIG.memoryTopK),
  );
  await setSetting(
    'recent_chapter_count',
    String(
      config.recentChapterCount ?? DEFAULT_CONTEXT_CONFIG.recentChapterCount,
    ),
  );
  await setSetting(
    'worldbook_recursive',
    String(
      config.worldbookRecursive ?? DEFAULT_CONTEXT_CONFIG.worldbookRecursive,
    ),
  );
  await setSetting(
    'worldbook_scan_depth',
    String(
      config.worldbookScanDepth ?? DEFAULT_CONTEXT_CONFIG.worldbookScanDepth,
    ),
  );
}

export async function getBackgroundPipelineEnabled(): Promise<boolean> {
  const v = await getSetting('background_pipeline_enabled');
  if (v == null) return true; // 默认开启
  return v !== 'false';
}

export async function setBackgroundPipelineEnabled(
  enabled: boolean,
): Promise<void> {
  await setSetting('background_pipeline_enabled', String(enabled));
}

export async function getVoiceConfig(): Promise<VoiceConfig> {
  const raw = await getSetting('voice_config');
  if (!raw) return DEFAULT_VOICE_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<VoiceConfig>;
    return { ...DEFAULT_VOICE_CONFIG, ...parsed };
  } catch {
    return DEFAULT_VOICE_CONFIG;
  }
}

export async function setVoiceConfig(config: VoiceConfig): Promise<void> {
  await setSetting('voice_config', JSON.stringify(config));
}

export async function getTtsEngine(): Promise<TtsEngine> {
  const value = await getSetting('tts_engine');
  return value === 'cloud' ? 'cloud' : 'system';
}

export async function setTtsEngine(engine: TtsEngine): Promise<void> {
  await setSetting('tts_engine', engine);
}

export async function getSystemTtsConfig(): Promise<SystemTtsConfig> {
  const raw = await getSetting('system_tts_config');
  if (!raw) return DEFAULT_SYSTEM_TTS_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<SystemTtsConfig>;
    return { ...DEFAULT_SYSTEM_TTS_CONFIG, ...parsed };
  } catch {
    return DEFAULT_SYSTEM_TTS_CONFIG;
  }
}

export async function setSystemTtsConfig(
  config: SystemTtsConfig,
): Promise<void> {
  await setSetting('system_tts_config', JSON.stringify(config));
}

export async function logLLMUsage(fields: {
  scenario: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  status: string;
  errorCode?: string;
  modelName?: string;
  projectId?: number;
  // V2.2.0 (schema 10): 按配置区分用量，便于多 LLM 场景下识别来源
  llmConfigId?: number;
  llmConfigName?: string;
}): Promise<void> {
  await execute(
    await openDatabase(),
    `INSERT INTO llm_usage_logs (scenario, input_tokens, output_tokens, total_tokens, status, error_code, model_name, project_id, llm_config_id, llm_config_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.scenario,
      fields.inputTokens,
      fields.outputTokens,
      fields.totalTokens,
      fields.status,
      fields.errorCode || '',
      fields.modelName || '',
      fields.projectId ?? 0,
      fields.llmConfigId ?? 0,
      fields.llmConfigName || '',
      now(),
    ],
  );
}

export async function getFreeformDocument(projectId: number): Promise<string> {
  const row = await one<{ content: string }>(
    'SELECT content FROM freeform_documents WHERE project_id = ?',
    [projectId],
  );
  return row?.content || '';
}

export async function setFreeformDocument(
  projectId: number,
  content: string,
): Promise<void> {
  await execute(
    await openDatabase(),
    'INSERT OR REPLACE INTO freeform_documents (project_id, content, updated_at) VALUES (?, ?, ?)',
    [projectId, content, now()],
  );
  await touchProject(projectId);
}

async function touchProject(projectId: number): Promise<void> {
  await execute(
    await openDatabase(),
    'UPDATE projects SET updated_at = ? WHERE id = ?',
    [now(), projectId],
  );
}

async function updateColumns(
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

export async function getPipelineConfig(): Promise<PipelineConfig> {
  // 11.9 优化：原实现每个字段独立 getSetting（最多 9 次独立 SQL），合并为单次 SELECT
  const keys = [
    'pipeline_mode',
    'pipeline_draft_preset_id',
    'pipeline_review_preset_id',
    'pipeline_factcheck_preset_id',
    'pipeline_proof_preset_id',
    'pipeline_draft_max_tokens',
    'pipeline_review_max_tokens',
    'pipeline_factcheck_max_tokens',
    'pipeline_proof_max_tokens',
  ];
  const rows = await all<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE key IN (${keys
      .map(() => '?')
      .join(', ')})`,
    keys,
  );
  const settingsMap = new Map(rows.map(r => [r.key, r.value]));
  const get = (k: string): string | null => settingsMap.get(k) ?? null;

  const savedMode = get('pipeline_mode');
  const pipelineMode =
    savedMode === 'noReview' ||
    savedMode === 'conditional' ||
    savedMode === 'full' ||
    savedMode === 'twoStage'
      ? savedMode
      : 'twoStage';

  const presetId = (k: string): number | null => {
    const v = get(k);
    return v !== null ? Number(v) : null;
  };

  return {
    pipelineMode,
    draftPresetId: presetId('pipeline_draft_preset_id'),
    reviewPresetId: presetId('pipeline_review_preset_id'),
    factCheckPresetId: presetId('pipeline_factcheck_preset_id'),
    proofPresetId: presetId('pipeline_proof_preset_id'),
    draftMaxTokens: Number(get('pipeline_draft_max_tokens') || 4000),
    reviewMaxTokens: Number(get('pipeline_review_max_tokens') || 1500),
    factCheckMaxTokens: Number(get('pipeline_factcheck_max_tokens') || 1500),
    proofMaxTokens: Number(get('pipeline_proof_max_tokens') || 4000),
  };
}

export async function setPipelineConfig(config: PipelineConfig): Promise<void> {
  await setSetting('pipeline_mode', config.pipelineMode);
  await setSetting(
    'pipeline_draft_preset_id',
    config.draftPresetId !== null ? String(config.draftPresetId) : '',
  );
  await setSetting(
    'pipeline_review_preset_id',
    config.reviewPresetId !== null ? String(config.reviewPresetId) : '',
  );
  await setSetting(
    'pipeline_factcheck_preset_id',
    config.factCheckPresetId !== null ? String(config.factCheckPresetId) : '',
  );
  await setSetting(
    'pipeline_proof_preset_id',
    config.proofPresetId !== null ? String(config.proofPresetId) : '',
  );
  await setSetting('pipeline_draft_max_tokens', String(config.draftMaxTokens));
  await setSetting(
    'pipeline_review_max_tokens',
    String(config.reviewMaxTokens),
  );
  await setSetting(
    'pipeline_factcheck_max_tokens',
    String(config.factCheckMaxTokens),
  );
  await setSetting('pipeline_proof_max_tokens', String(config.proofMaxTokens));
}

// =============================================================================
// Pipeline Tasks CRUD (BUG1 fix: persist tasks to SQLite)
// =============================================================================

export async function savePipelineTask(task: {
  id: string;
  targetType: string;
  targetId: number;
  status: string;
  stageResults: any[];
  finalText: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  resolvedAction?: string | null;
}): Promise<void> {
  await execute(
    await openDatabase(),
    `INSERT OR REPLACE INTO pipeline_tasks (id, target_type, target_id, status, stage_results, final_text, error, created_at, updated_at, resolved_at, resolved_action)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.id,
      task.targetType,
      task.targetId,
      task.status,
      JSON.stringify(task.stageResults),
      task.finalText,
      task.error,
      task.createdAt,
      task.updatedAt,
      task.resolvedAt,
      task.resolvedAction || null,
    ],
  );
}

export async function getUnresolvedPipelineTasks(): Promise<any[]> {
  const rows = await all<Row>(
    'SELECT * FROM pipeline_tasks WHERE resolved_at IS NULL ORDER BY created_at DESC',
  );
  return rows.map(row => ({
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    status: row.status,
    stageResults: (() => {
      try {
        return JSON.parse(row.stage_results);
      } catch {
        return [];
      }
    })(),
    finalText: row.final_text,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    resolvedAction: row.resolved_action,
  }));
}

export async function getAllPipelineTasks(): Promise<any[]> {
  const rows = await all<Row>(
    'SELECT * FROM pipeline_tasks ORDER BY created_at DESC',
  );
  return rows.map(row => ({
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    status: row.status,
    stageResults: (() => {
      try {
        return JSON.parse(row.stage_results);
      } catch {
        return [];
      }
    })(),
    finalText: row.final_text,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    resolvedAction: row.resolved_action,
  }));
}

export async function deletePipelineTask(id: string): Promise<void> {
  await execute(
    await openDatabase(),
    'DELETE FROM pipeline_tasks WHERE id = ?',
    [id],
  );
}

export async function deleteResolvedPipelineTasks(): Promise<void> {
  await execute(
    await openDatabase(),
    'DELETE FROM pipeline_tasks WHERE resolved_at IS NOT NULL',
  );
}

// =============================================================================
// Worldbook collection batch enable (优化2: enable all entries when collection enabled)
// =============================================================================

export async function setAllWorldbookEntriesEnabledByCollection(
  collectionId: number,
  enabled: boolean,
): Promise<void> {
  await execute(
    await openDatabase(),
    'UPDATE worldbook_entries SET enabled = ? WHERE collection_id = ?',
    [enabled ? 1 : 0, collectionId],
  );
}

// ---------------------------------------------------------------------------
// Content Revisions
// ---------------------------------------------------------------------------

export async function createContentRevision(fields: {
  projectId: number;
  targetType: string;
  targetId: number;
  title: string;
  content: string;
  source: string;
  sourceRef?: string | null;
}): Promise<number> {
  const createdAt = new Date().toISOString();
  const result = await execute(
    await openDatabase(),
    `INSERT INTO content_revisions (project_id, target_type, target_id, title, content, source, source_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.projectId,
      fields.targetType,
      fields.targetId,
      fields.title,
      fields.content,
      fields.source,
      fields.sourceRef ?? null,
      createdAt,
    ],
  );
  return result.insertId;
}

export async function getContentRevisions(
  targetType: string,
  targetId: number,
): Promise<any[]> {
  return all(
    `SELECT * FROM content_revisions WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC`,
    [targetType, targetId],
  );
}

export async function getLatestContentRevision(
  targetType: string,
  targetId: number,
): Promise<any | null> {
  return one(
    `SELECT * FROM content_revisions WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC LIMIT 1`,
    [targetType, targetId],
  );
}

export async function deleteContentRevision(id: number): Promise<void> {
  await execute(
    await openDatabase(),
    'DELETE FROM content_revisions WHERE id = ?',
    [id],
  );
}

export async function trimContentRevisions(
  targetType: string,
  targetId: number,
  maxAuto = 50,
  maxManual = 20,
): Promise<void> {
  const database = await openDatabase();
  // V2.2.2 修复：原 `database.transaction(async (tx) => {...})` 内部多次 await → InvalidStateError。
  // 改成：先 async 收集要删的 id，再合并到一次同步 push 事务。
  const autoRows = await all<{ id: number }>(
    `SELECT id FROM content_revisions
     WHERE target_type = ? AND target_id = ? AND source != 'manual_checkpoint'
     ORDER BY created_at DESC`,
    [targetType, targetId],
  );
  const manualRows = await all<{ id: number }>(
    `SELECT id FROM content_revisions
     WHERE target_type = ? AND target_id = ? AND source = 'manual_checkpoint'
     ORDER BY created_at DESC`,
    [targetType, targetId],
  );
  const toDeleteAuto = autoRows.map(r => r.id).slice(maxAuto);
  const toDeleteManual = manualRows.map(r => r.id).slice(maxManual);
  const stmts: Array<{ sql: string; params: any[] }> = [];
  for (const id of toDeleteAuto) {
    stmts.push({
      sql: 'DELETE FROM content_revisions WHERE id = ?',
      params: [id],
    });
  }
  for (const id of toDeleteManual) {
    stmts.push({
      sql: 'DELETE FROM content_revisions WHERE id = ?',
      params: [id],
    });
  }
  await runInTransactionSafe(database, stmts);
}

// ---------------------------------------------------------------------------
// Generation Drafts
// ---------------------------------------------------------------------------

export async function createGenerationDraft(fields: {
  projectId: number;
  targetType: string;
  targetId: number;
  content: string;
  source: string;
  pipelineTaskId?: string | null;
  tokenCount: number;
}): Promise<number> {
  const createdAt = new Date().toISOString();
  const result = await execute(
    await openDatabase(),
    `INSERT INTO generation_drafts (project_id, target_type, target_id, content, source, pipeline_task_id, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.projectId,
      fields.targetType,
      fields.targetId,
      fields.content,
      fields.source,
      fields.pipelineTaskId ?? null,
      fields.tokenCount,
      createdAt,
    ],
  );
  return result.insertId;
}

export async function getGenerationDrafts(
  targetType: string,
  targetId: number,
): Promise<any[]> {
  return all(
    `SELECT * FROM generation_drafts WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC`,
    [targetType, targetId],
  );
}

export async function getGenerationDraft(id: number): Promise<any | null> {
  return one(`SELECT * FROM generation_drafts WHERE id = ?`, [id]);
}

export async function deleteGenerationDraft(id: number): Promise<void> {
  await execute(
    await openDatabase(),
    'DELETE FROM generation_drafts WHERE id = ?',
    [id],
  );
}

export async function deleteGenerationDraftsByTarget(
  targetType: string,
  targetId: number,
): Promise<void> {
  await execute(
    await openDatabase(),
    'DELETE FROM generation_drafts WHERE target_type = ? AND target_id = ?',
    [targetType, targetId],
  );
}

// ---------------------------------------------------------------------------
// LLM Usage Stats
// ---------------------------------------------------------------------------

export async function getLLMUsageStats(
  projectId: number | null,
): Promise<any[]> {
  const database = await openDatabase();
  const projectFilter = projectId ? 'WHERE project_id = ?' : '';
  const params = projectId ? [projectId] : [];
  const [result] = await database.executeSql(
    `SELECT
      DATE(created_at) as date,
      COUNT(*) as call_count,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      SUM(total_tokens) as total_tokens,
      GROUP_CONCAT(DISTINCT model_name) as models
    FROM llm_usage_logs ${projectFilter}
    GROUP BY DATE(created_at)
    ORDER BY date DESC
    LIMIT 30`,
    params,
  );
  const rows: any[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    rows.push(result.rows.item(i));
  }
  return rows;
}

export async function getLLMUsageSummary(
  projectId: number | null,
): Promise<any> {
  const database = await openDatabase();
  const projectFilter = projectId ? 'WHERE project_id = ?' : '';
  const params = projectId ? [projectId] : [];
  const [result] = await database.executeSql(
    `SELECT
      COUNT(*) as total_calls,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens
    FROM llm_usage_logs ${projectFilter}`,
    params,
  );
  return result.rows.length > 0
    ? result.rows.item(0)
    : {
        total_calls: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_tokens: 0,
      };
}

// V2.2.0 (schema 10): 按 LLM 配置分组返回调用量。
// 兼容旧数据（llm_config_id = 0 时回退到 model_name 作标识），
// 让 UsageStatsScreen 能在多 LLM 配置场景下识别每个配置的调用量。
export async function getLLMUsageByConfig(
  projectId: number | null,
): Promise<any[]> {
  const database = await openDatabase();
  const projectFilter = projectId ? 'WHERE project_id = ?' : '';
  const params = projectId ? [projectId] : [];
  const [result] = await database.executeSql(
    `SELECT
      llm_config_id,
      COALESCE(NULLIF(llm_config_name, ''), '未命名配置') as llm_config_name,
      COUNT(*) as call_count,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      GROUP_CONCAT(DISTINCT model_name) as models,
      MAX(created_at) as last_used_at
    FROM llm_usage_logs ${projectFilter}
    GROUP BY llm_config_id, llm_config_name
    ORDER BY call_count DESC, last_used_at DESC`,
    params,
  );
  const rows: any[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    rows.push(result.rows.item(i));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 笔记双模式（V1.7.0 / schema 9）
// ---------------------------------------------------------------------------

export type NoteMode = 'none' | 'style' | 'retrieval';

export interface ProjectNoteConfig {
  projectId: number;
  mode: NoteMode;
  styleWeights: Record<string, number>;
  retrievalTopK: number;
  retrievalFragmentChars: number;
  enabledNoteIds: number[];
  updatedAt: string;
}

function safeJsonParse(text: string, fallback: any): any {
  try {
    // ?? 只匹配 null/undefined，但 JSON.parse('null') 会返回 null 也会污染 state
    // 改用 || 同时拦截 null 和空对象（空对象会导致后续 .length/.map 报错）
    if (text == null || text === '') return fallback;
    const parsed = JSON.parse(text);
    if (parsed == null) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

function parseProjectNoteConfigRow(row: Row): ProjectNoteConfig {
  return {
    projectId: Number(row.project_id),
    mode: row.mode as NoteMode,
    styleWeights: safeJsonParse(row.style_weights, {}),
    // 11.10 修复：原 || 把 0 当 falsy 回退到 5，改用 ?? 保留显式 0
    retrievalTopK: Number(row.retrieval_top_k) ?? 5,
    retrievalFragmentChars: Number(row.retrieval_fragment_chars) || 1000,
    enabledNoteIds: safeJsonParse(row.enabled_note_ids, []),
    updatedAt: row.updated_at,
  };
}

export async function getProjectNoteConfig(
  projectId: number,
): Promise<ProjectNoteConfig | null> {
  const result = await execute(
    await openDatabase(),
    'SELECT * FROM project_note_config WHERE project_id = ?',
    [projectId],
  );
  if (result.rows.length === 0) return null;
  return parseProjectNoteConfigRow(result.rows.item(0));
}

export async function setProjectNoteConfig(
  projectId: number,
  config: Partial<Omit<ProjectNoteConfig, 'projectId' | 'updatedAt'>>,
): Promise<void> {
  // 11.13 修复：原实现用 `database.transaction(async (tx) => {...})` 在 callback 中 await，
  // react-native-sqlite-storage 的 transaction 期望 callback **同步**执行 SQL，
  // async callback 在第一次 await 之前 transaction 已被 finalize，导致 InvalidStateError
  // (DOM Exception 11)。改成分步：先 SELECT 读 existing → INSERT OR REPLACE 写。
  // 单 project 单行写入，丢失"严格原子性"在并发场景下极少见且可接受
  // （下一句写会覆盖上一句写，最终态一致）。
  const database = await openDatabase();
  const existing = await getProjectNoteConfig(projectId);
  const mode = config.mode ?? existing?.mode ?? 'none';
  const styleWeights = JSON.stringify(
    config.styleWeights ?? existing?.styleWeights ?? {},
  );
  const retrievalTopK = config.retrievalTopK ?? existing?.retrievalTopK ?? 5;
  const retrievalFragmentChars =
    config.retrievalFragmentChars ?? existing?.retrievalFragmentChars ?? 1000;
  const enabledNoteIds = JSON.stringify(
    config.enabledNoteIds ?? existing?.enabledNoteIds ?? [],
  );
  const updatedAt = new Date().toISOString();
  await execute(
    database,
    `INSERT OR REPLACE INTO project_note_config (project_id, mode, style_weights, retrieval_top_k, retrieval_fragment_chars, enabled_note_ids, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      projectId,
      mode,
      styleWeights,
      retrievalTopK,
      retrievalFragmentChars,
      enabledNoteIds,
      updatedAt,
    ],
  );
}

export interface NoteStyleProfileRow {
  noteId: number;
  profileText: string;
  profileJson: string;
  analyzedAt: string;
  sourceHash: string;
}

export async function getNoteStyleProfile(
  noteId: number,
): Promise<NoteStyleProfileRow | null> {
  const result = await execute(
    await openDatabase(),
    'SELECT * FROM note_style_profiles WHERE note_id = ?',
    [noteId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows.item(0);
  return {
    noteId: Number(row.note_id),
    profileText: row.profile_text || '',
    profileJson: row.profile_json || '{}',
    analyzedAt: row.analyzed_at,
    sourceHash: row.source_hash || '',
  };
}

export async function setNoteStyleProfile(
  noteId: number,
  profileText: string,
  profileJson: string,
  sourceHash: string,
): Promise<void> {
  const analyzedAt = new Date().toISOString();
  await execute(
    await openDatabase(),
    `INSERT OR REPLACE INTO note_style_profiles (note_id, profile_text, profile_json, analyzed_at, source_hash)
     VALUES (?, ?, ?, ?, ?)`,
    [noteId, profileText, profileJson, analyzedAt, sourceHash],
  );
}

export async function deleteNoteStyleProfile(noteId: number): Promise<void> {
  await execute(
    await openDatabase(),
    'DELETE FROM note_style_profiles WHERE note_id = ?',
    [noteId],
  );
}

// 简易 hash（非加密级别，用于笔记内容变更检测）
export async function computeNoteSourceHash(content: string): Promise<string> {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return (
    Math.abs(hash).toString(16).padStart(8, '0') +
    '_' +
    content.length.toString(16)
  );
}
