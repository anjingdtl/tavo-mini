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
import type { PipelineConfig } from '../types/pipeline';
import {
  clearSecureLLMApiKey,
  getSecureLLMApiKey,
  migrateLegacyLLMApiKey,
  setSecureLLMApiKey,
} from './secureStorage';
import { estimateTokens } from '../utils/tokenEstimator';
import { runMigrations, SCHEMA_VERSION, hasBreakingMigration, isIncompatibleUpgrade } from './migrations';
import type { InstallInfo, InstallType, MigrationResult } from './migrations/types';
import appVersionJson from '../constants/version.json';

SQLite.enablePromise(true);

const DB_NAME = 'tavo_mini.db';
const GLOBAL_PROJECT_ID = 0;
const GLOBAL_PROJECT_NAME = '__tavo_global_workspace__';
const NOTE_TEXT_CHUNK_CHARS = 120000;
const NOTE_LIST_PREVIEW_CHARS = 1200;
let db: SQLite.SQLiteDatabase | null = null;
let opening: Promise<SQLite.SQLiteDatabase> | null = null;

type Row = Record<string, any>;
export type ResourceType = 'character' | 'worldbook' | 'note' | 'preset';

export async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  if (opening) return opening;
  opening = (async () => {
    const database = await SQLite.openDatabase({ name: DB_NAME, location: 'default' });
    await createTables(database);
    await ensureSchemaCompatibility(database);
    await seedDefaults(database);
    await migrate(database);
    await repairOversizedNotes(database);
    db = database;
    opening = null;
    return database;
  })().catch((error) => {
    db = null;
    opening = null;
    throw error;
  });
  return opening;
}

async function execute(database: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await database.executeSql(sql, params);
  return result;
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

async function one<T = Row>(sql: string, params: any[] = []): Promise<T | null> {
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
        is_active INTEGER NOT NULL DEFAULT 0
      )
    `,
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
  ];
  for (const statement of statements) {
    await execute(database, statement);
  }
}

async function tableColumns(database: SQLite.SQLiteDatabase, table: string): Promise<Set<string>> {
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

async function ensureSchemaCompatibility(database: SQLite.SQLiteDatabase): Promise<void> {
  const projects = await tableColumns(database, 'projects');
  await ensureColumn(database, 'projects', projects, 'name', "name TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'projects', projects, 'mode', "mode TEXT NOT NULL DEFAULT 'outline'");
  await ensureColumn(database, 'projects', projects, 'created_at', "created_at TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'projects', projects, 'updated_at', "updated_at TEXT NOT NULL DEFAULT ''");

  const chapters = await tableColumns(database, 'chapters');
  await ensureColumn(database, 'chapters', chapters, 'project_id', 'project_id INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'chapters', chapters, 'position', 'position INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'chapters', chapters, 'title', "title TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'chapters', chapters, 'synopsis', "synopsis TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'chapters', chapters, 'content', "content TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'chapters', chapters, 'status', "status TEXT NOT NULL DEFAULT 'planned'");
  await ensureColumn(database, 'chapters', chapters, 'summary_json', 'summary_json TEXT');
  await ensureColumn(database, 'chapters', chapters, 'memory_summary', "memory_summary TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'chapters', chapters, 'memory_summary_tokens', 'memory_summary_tokens INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'chapters', chapters, 'finalized_at', 'finalized_at TEXT');
  await ensureColumn(database, 'chapters', chapters, 'created_at', "created_at TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'chapters', chapters, 'updated_at', "updated_at TEXT NOT NULL DEFAULT ''");

  const fragments = await tableColumns(database, 'fragments');
  await ensureColumn(database, 'fragments', fragments, 'project_id', 'project_id INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'fragments', fragments, 'position', 'position INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'fragments', fragments, 'type', "type TEXT NOT NULL DEFAULT 'seed'");
  await ensureColumn(database, 'fragments', fragments, 'content', "content TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'fragments', fragments, 'created_at', "created_at TEXT NOT NULL DEFAULT ''");

  const plotlines = await tableColumns(database, 'plotlines');
  await ensureColumn(database, 'plotlines', plotlines, 'project_id', 'project_id INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'plotlines', plotlines, 'name', "name TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'plotlines', plotlines, 'description', "description TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'plotlines', plotlines, 'color', "color TEXT NOT NULL DEFAULT '#2563EB'");

  const characters = await tableColumns(database, 'characters');
  await ensureColumn(database, 'characters', characters, 'project_id', 'project_id INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'characters', characters, 'name', "name TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'characters', characters, 'source_type', "source_type TEXT NOT NULL DEFAULT 'json'");
  await ensureColumn(database, 'characters', characters, 'data_json', "data_json TEXT NOT NULL DEFAULT '{}'");
  await ensureColumn(database, 'characters', characters, 'max_tokens', 'max_tokens INTEGER NOT NULL DEFAULT 50000');
  await ensureColumn(database, 'characters', characters, 'estimated_tokens', 'estimated_tokens INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'characters', characters, 'created_at', "created_at TEXT NOT NULL DEFAULT ''");

  const collections = await tableColumns(database, 'worldbook_collections');
  await ensureColumn(database, 'worldbook_collections', collections, 'project_id', 'project_id INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'worldbook_collections', collections, 'name', "name TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'worldbook_collections', collections, 'enabled', 'enabled INTEGER NOT NULL DEFAULT 1');
  await ensureColumn(database, 'worldbook_collections', collections, 'max_tokens', 'max_tokens INTEGER NOT NULL DEFAULT 50000');
  await ensureColumn(database, 'worldbook_collections', collections, 'estimated_tokens', 'estimated_tokens INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'worldbook_collections', collections, 'created_at', "created_at TEXT NOT NULL DEFAULT ''");

  const worldbook = await tableColumns(database, 'worldbook_entries');
  await ensureColumn(database, 'worldbook_entries', worldbook, 'project_id', 'project_id INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'worldbook_entries', worldbook, 'collection_id', 'collection_id INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'worldbook_entries', worldbook, 'keyword_primary', "keyword_primary TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'worldbook_entries', worldbook, 'keyword_secondary', "keyword_secondary TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'worldbook_entries', worldbook, 'content', "content TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'worldbook_entries', worldbook, 'comment', "comment TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'worldbook_entries', worldbook, 'enabled', 'enabled INTEGER NOT NULL DEFAULT 1');
  await ensureColumn(database, 'worldbook_entries', worldbook, 'constant', 'constant INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'worldbook_entries', worldbook, 'max_tokens', 'max_tokens INTEGER NOT NULL DEFAULT 2000');
  await ensureColumn(database, 'worldbook_entries', worldbook, 'estimated_tokens', 'estimated_tokens INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'worldbook_entries', worldbook, 'position', 'position INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'worldbook_entries', worldbook, 'created_at', "created_at TEXT NOT NULL DEFAULT ''");

  const notes = await tableColumns(database, 'notes');
  await ensureColumn(database, 'notes', notes, 'project_id', 'project_id INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'notes', notes, 'title', "title TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'notes', notes, 'content', "content TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'notes', notes, 'max_tokens', 'max_tokens INTEGER NOT NULL DEFAULT 30000');
  await ensureColumn(database, 'notes', notes, 'estimated_tokens', 'estimated_tokens INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'notes', notes, 'created_at', "created_at TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'notes', notes, 'updated_at', "updated_at TEXT NOT NULL DEFAULT ''");

  const presets = await tableColumns(database, 'presets');
  await ensureColumn(database, 'presets', presets, 'project_id', 'project_id INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'presets', presets, 'name', "name TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'presets', presets, 'is_default', 'is_default INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(database, 'presets', presets, 'system_prompt', "system_prompt TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'presets', presets, 'writing_style', "writing_style TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'presets', presets, 'temperature', 'temperature REAL NOT NULL DEFAULT 0.8');
  await ensureColumn(database, 'presets', presets, 'top_p', 'top_p REAL NOT NULL DEFAULT 0.9');
  await ensureColumn(database, 'presets', presets, 'max_tokens', 'max_tokens INTEGER NOT NULL DEFAULT 4000');
  await ensureColumn(database, 'presets', presets, 'extra_instructions', "extra_instructions TEXT NOT NULL DEFAULT ''");

  const llm = await tableColumns(database, 'llm_config');
  await ensureColumn(database, 'llm_config', llm, 'name', "name TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'llm_config', llm, 'base_url', "base_url TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'llm_config', llm, 'api_key', "api_key TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'llm_config', llm, 'model_name', "model_name TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'llm_config', llm, 'is_active', 'is_active INTEGER NOT NULL DEFAULT 0');

  const settings = await tableColumns(database, 'settings');
  await ensureColumn(database, 'settings', settings, 'key', "key TEXT NOT NULL DEFAULT ''");
  await ensureColumn(database, 'settings', settings, 'value', "value TEXT NOT NULL DEFAULT ''");
}

async function seedDefaults(database: SQLite.SQLiteDatabase): Promise<void> {
  await ensureGlobalProject(database);
  await execute(
    database,
    'INSERT OR IGNORE INTO llm_config (id, name, base_url, api_key, model_name, is_active) VALUES (1, ?, ?, ?, ?, 1)',
    ['默认配置', '', '', ''],
  );
  await execute(database, "UPDATE llm_config SET name = '默认配置' WHERE id = 1 AND name = ''");
  const active = await execute(database, 'SELECT id FROM llm_config WHERE is_active = 1 ORDER BY id ASC LIMIT 1');
  if (active.rows.length === 0) {
    await execute(database, 'UPDATE llm_config SET is_active = 1 WHERE id = (SELECT id FROM llm_config ORDER BY id ASC LIMIT 1)');
  }
  await ensureDefaultPreset(database);
}

async function ensureGlobalProject(database: SQLite.SQLiteDatabase): Promise<void> {
  const timestamp = now();
  await execute(
    database,
    'INSERT OR IGNORE INTO projects (id, name, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [GLOBAL_PROJECT_ID, GLOBAL_PROJECT_NAME, 'outline', timestamp, timestamp],
  );
}

export async function detectInstallType(database: SQLite.SQLiteDatabase): Promise<InstallInfo> {
  const currentVersion = appVersionJson.versionName.replace(/^V/, '');
  const storedVersionResult = await execute(database, 'SELECT value FROM settings WHERE key = ?', ['app_version']);
  const storedVersion = storedVersionResult.rows.length > 0 ? storedVersionResult.rows.item(0).value : null;

  const firstInstallResult = await execute(database, 'SELECT value FROM settings WHERE key = ?', ['first_install_version']);
  const firstInstallVersion = firstInstallResult.rows.length > 0 ? firstInstallResult.rows.item(0).value : currentVersion;

  let installType: InstallType;
  let previousVersion: string | null = null;

  if (!storedVersion) {
    installType = 'fresh';
    await execute(database, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['first_install_version', currentVersion]);
  } else if (storedVersion !== currentVersion) {
    installType = 'upgrade';
    previousVersion = storedVersion;
    await execute(database, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['previous_version', storedVersion]);
  } else {
    installType = 'same';
  }

  await execute(database, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['app_version', currentVersion]);
  await execute(database, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['app_version_code', String(appVersionJson.versionCode)]);
  await execute(database, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['install_type', installType]);

  const schemaVersionResult = await execute(database, 'SELECT value FROM settings WHERE key = ?', ['schema_version']);
  const schemaVersion = schemaVersionResult.rows.length > 0 ? parseInt(schemaVersionResult.rows.item(0).value, 10) : 0;

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
    await execute(database, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'schema_version', String(SCHEMA_VERSION),
    ]);
    return;
  }

  if (installInfo.installType === 'same') {
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
      summary = typeof row.summary_json === 'string' ? JSON.parse(row.summary_json) : row.summary_json;
    } catch {
      summary = null;
    }
  }
  return { ...row, summary_json: summary } as Chapter;
}

export async function getAllProjects(): Promise<Project[]> {
  return all<Project>('SELECT * FROM projects WHERE id > 0 ORDER BY updated_at DESC');
}

export async function getProjectById(id: number): Promise<Project | null> {
  return one<Project>('SELECT * FROM projects WHERE id = ? AND id > 0', [id]);
}

export async function createProject(name: string, mode: ProjectMode | string): Promise<number> {
  const database = await openDatabase();
  const timestamp = now();
  const result = await execute(
    database,
    'INSERT INTO projects (name, mode, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [name, mode, timestamp, timestamp],
  );
  const projectId = result.insertId!;
  const presetId = await ensureDefaultPreset();
  await setProjectResourceEnabled(projectId, 'preset', presetId, true);
  await createChapter(projectId, 0, '第 1 章');
  return projectId;
}

export async function updateProject(id: number, name: string): Promise<void> {
  await execute(await openDatabase(), 'UPDATE projects SET name = ?, updated_at = ? WHERE id = ?', [name, now(), id]);
}

export async function deleteProject(id: number): Promise<void> {
  await execute(await openDatabase(), 'DELETE FROM projects WHERE id = ?', [id]);
}

export async function getChaptersByProject(projectId: number): Promise<Chapter[]> {
  const rows = await all<Row>('SELECT * FROM chapters WHERE project_id = ? ORDER BY position ASC', [projectId]);
  return rows.map(parseChapter);
}

export async function getChapterById(id: number): Promise<Chapter | null> {
  const row = await one<Row>('SELECT * FROM chapters WHERE id = ?', [id]);
  return row ? parseChapter(row) : null;
}

export async function createChapter(projectId: number, position: number, title?: string): Promise<number> {
  const timestamp = now();
  const result = await execute(
    await openDatabase(),
    'INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [projectId, position, title || `第 ${position + 1} 章`, '', '', 'planned', timestamp, timestamp],
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

export async function updateChapter(id: number, fields: Partial<Chapter>): Promise<void> {
  const chapter = await getChapterById(id);
  const sets = ['updated_at = ?'];
  const values: any[] = [now()];
  for (const [key, value] of Object.entries(fields)) {
    if (!CHAPTER_COLUMNS.has(key)) continue;
    sets.push(`${key} = ?`);
    values.push(key === 'summary_json' && value !== null && typeof value !== 'string' ? JSON.stringify(value) : value);
  }
  if (sets.length === 1) return;
  values.push(id);
  await execute(await openDatabase(), `UPDATE chapters SET ${sets.join(', ')} WHERE id = ?`, values);
  if (chapter) await touchProject(chapter.project_id);
}

export async function deleteChapter(id: number): Promise<void> {
  const chapter = await getChapterById(id);
  await execute(await openDatabase(), 'DELETE FROM chapters WHERE id = ?', [id]);
  if (chapter) await touchProject(chapter.project_id);
}

export async function getFragmentsByProject(projectId: number): Promise<Fragment[]> {
  return all<Fragment>('SELECT * FROM fragments WHERE project_id = ? ORDER BY position ASC', [projectId]);
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
  await execute(await openDatabase(), 'DELETE FROM fragments WHERE id = ?', [id]);
}

export async function getPlotlinesByProject(projectId: number): Promise<Plotline[]> {
  return all<Plotline>('SELECT * FROM plotlines WHERE project_id = ? ORDER BY id ASC', [projectId]);
}

export async function createPlotline(projectId: number, name: string, description: string, color: string): Promise<number> {
  const result = await execute(
    await openDatabase(),
    'INSERT INTO plotlines (project_id, name, description, color) VALUES (?, ?, ?, ?)',
    [projectId, name, description, color],
  );
  return result.insertId!;
}

export async function deletePlotline(id: number): Promise<void> {
  await execute(await openDatabase(), 'DELETE FROM plotlines WHERE id = ?', [id]);
}

export async function setChapterPlotlines(chapterId: number, plotlineIds: number[]): Promise<void> {
  const database = await openDatabase();
  await database.transaction(async (tx) => {
    await tx.executeSql('DELETE FROM project_plotlines WHERE chapter_id = ?', [chapterId]);
    for (const plotlineId of plotlineIds) {
      await tx.executeSql('INSERT INTO project_plotlines (chapter_id, plotline_id) VALUES (?, ?)', [chapterId, plotlineId]);
    }
  });
}

export async function getChapterPlotlineIds(chapterId: number): Promise<number[]> {
  const rows = await all<{ plotline_id: number }>('SELECT plotline_id FROM project_plotlines WHERE chapter_id = ?', [chapterId]);
  return rows.map((row) => row.plotline_id);
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

async function deleteProjectResourceLinks(resourceType: ResourceType, resourceId: number): Promise<void> {
  await execute(await openDatabase(), 'DELETE FROM project_resources WHERE resource_type = ? AND resource_id = ?', [
    resourceType,
    resourceId,
  ]);
}

async function linkResourceToProject(projectId: number, resourceType: ResourceType, resourceId: number): Promise<void> {
  if (projectId > 0) {
    await setProjectResourceEnabled(projectId, resourceType, resourceId, true);
  }
}

function usageJoin(resourceType: ResourceType, alias: string, projectId?: number): string {
  if (!projectId) return '0 AS enabled_for_project';
  return `COALESCE((SELECT enabled FROM project_resources pr WHERE pr.project_id = ${Number(projectId)} AND pr.resource_type = '${resourceType}' AND pr.resource_id = ${alias}.id), 0) AS enabled_for_project`;
}

export async function getAllCharacters(projectId?: number): Promise<Row[]> {
  return all<Row>(`SELECT c.*, ${usageJoin('character', 'c', projectId)} FROM characters c ORDER BY c.id DESC`);
}

export async function getCharactersByProject(projectId: number): Promise<Row[]> {
  return all<Row>(
    `SELECT c.* FROM characters c
     JOIN project_resources pr ON pr.resource_id = c.id AND pr.resource_type = 'character'
     WHERE pr.project_id = ? AND pr.enabled = 1
     ORDER BY c.id ASC`,
    [projectId],
  );
}

export async function getCharacterById(id: number): Promise<Row | null> {
  return one<Row>('SELECT * FROM characters WHERE id = ?', [id]);
}

export async function createCharacter(projectId: number, name: string, sourceType: string, dataJson: string): Promise<number> {
  const estimatedTokens = estimateTokens(dataJson);
  const result = await execute(
    await openDatabase(),
    'INSERT INTO characters (project_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [0, name, sourceType, dataJson, 50000, estimatedTokens, now()],
  );
  const id = result.insertId!;
  await linkResourceToProject(projectId, 'character', id);
  return id;
}

export async function updateCharacter(id: number, name: string, dataJson: string): Promise<void> {
  await execute(await openDatabase(), 'UPDATE characters SET name = ?, data_json = ?, estimated_tokens = ? WHERE id = ?', [
    name,
    dataJson,
    estimateTokens(dataJson),
    id,
  ]);
}

export async function updateCharacterTokenBudget(id: number, maxTokens: number): Promise<void> {
  await execute(await openDatabase(), 'UPDATE characters SET max_tokens = ? WHERE id = ?', [maxTokens, id]);
}

export async function deleteCharacter(id: number): Promise<void> {
  await deleteProjectResourceLinks('character', id);
  await execute(await openDatabase(), 'DELETE FROM characters WHERE id = ?', [id]);
}

export async function getAllWorldbookEntries(projectId?: number): Promise<Row[]> {
  return all<Row>(
    `SELECT w.*, wc.name AS collection_name, wc.enabled AS collection_enabled, wc.max_tokens AS collection_max_tokens, ${usageJoin('worldbook', 'w', projectId)}
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
  await database.transaction(async (tx) => {
    await tx.executeSql('UPDATE worldbook_collections SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, collectionId]);
    if (!enabled) return;
    await tx.executeSql('UPDATE worldbook_entries SET enabled = 1 WHERE collection_id = ?', [collectionId]);
    const [result] = await tx.executeSql('SELECT id FROM worldbook_entries WHERE collection_id = ?', [collectionId]);
    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows.item(i);
      await tx.executeSql(
        'INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, 1)',
        [projectId, 'worldbook', row.id],
      );
    }
  });
}

export async function getWorldbookEntriesByProject(projectId: number): Promise<Row[]> {
  return all<Row>(
    `SELECT w.*, wc.name AS collection_name, wc.enabled AS collection_enabled, wc.max_tokens AS collection_max_tokens FROM worldbook_entries w
     JOIN project_resources pr ON pr.resource_id = w.id AND pr.resource_type = 'worldbook'
     LEFT JOIN worldbook_collections wc ON wc.id = w.collection_id
     WHERE pr.project_id = ? AND pr.enabled = 1 AND w.enabled = 1 AND COALESCE(wc.enabled, 1) = 1
     ORDER BY w.position ASC, w.id ASC`,
    [projectId],
  );
}

export async function getWorldbookCollections(projectId?: number): Promise<Row[]> {
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
    [0, name, extra.enabled === 0 ? 0 : 1, Number(extra.max_tokens || 50000), Number(extra.estimated_tokens || 0), now()],
  );
  return result.insertId!;
}

export async function updateWorldbookCollection(id: number, fields: Row): Promise<void> {
  await updateColumns('worldbook_collections', id, new Set(['name', 'enabled', 'max_tokens', 'estimated_tokens']), fields);
}

export async function updateWorldbookCollectionTokenEstimate(id: number): Promise<void> {
  const rows = await all<{ content: string }>('SELECT content FROM worldbook_entries WHERE collection_id = ?', [id]);
  const estimatedTokens = rows.reduce((total, row) => total + estimateTokens(row.content), 0);
  await updateWorldbookCollection(id, { estimated_tokens: estimatedTokens });
}

export async function deleteWorldbookCollection(id: number): Promise<void> {
  const database = await openDatabase();
  const entries = await all<{ id: number }>('SELECT id FROM worldbook_entries WHERE collection_id = ?', [id]);
  await database.transaction(async (tx) => {
    for (const entry of entries) {
      await tx.executeSql('DELETE FROM project_resources WHERE resource_type = ? AND resource_id = ?', ['worldbook', entry.id]);
    }
    await tx.executeSql('DELETE FROM worldbook_entries WHERE collection_id = ?', [id]);
    await tx.executeSql('DELETE FROM worldbook_collections WHERE id = ?', [id]);
  });
}

export async function getWorldbookEntryById(id: number): Promise<Row | null> {
  return one<Row>('SELECT * FROM worldbook_entries WHERE id = ?', [id]);
}

export async function getWorldbookEntriesByCollection(collectionId: number): Promise<Row[]> {
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
  if (extra.collection_id) await updateWorldbookCollectionTokenEstimate(Number(extra.collection_id));
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

export async function updateWorldbookEntry(id: number, fields: Row): Promise<void> {
  if (typeof fields.content === 'string' && fields.estimated_tokens == null) {
    fields.estimated_tokens = estimateTokens(fields.content);
  }
  await updateColumns('worldbook_entries', id, WB_COLUMNS, fields);
  const entry = await getWorldbookEntryById(id);
  if (entry?.collection_id) await updateWorldbookCollectionTokenEstimate(Number(entry.collection_id));
}

export async function deleteWorldbookEntry(id: number): Promise<void> {
  const entry = await getWorldbookEntryById(id);
  await deleteProjectResourceLinks('worldbook', id);
  await execute(await openDatabase(), 'DELETE FROM worldbook_entries WHERE id = ?', [id]);
  if (entry?.collection_id) await updateWorldbookCollectionTokenEstimate(Number(entry.collection_id));
}

export function splitNoteTextIntoChunks(text: string, chunkSize = NOTE_TEXT_CHUNK_CHARS): string[] {
  if (!text) return [''];
  if (text.length <= chunkSize) return [text];
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

async function insertNoteRow(database: SQLite.SQLiteDatabase, title: string, content: string): Promise<number> {
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
    const noteTitle = chunks.length === 1 ? title : `${title} (${i + 1}/${chunks.length})`;
    const id = await insertNoteRow(database, noteTitle, chunks[i]);
    if (!firstId) firstId = id;
    await linkResourceToProject(projectId, 'note', id);
  }
  return { firstId, createdCount: chunks.length };
}

async function getNoteContentByIdFromDatabase(database: SQLite.SQLiteDatabase, id: number): Promise<string> {
  const meta = await execute(database, 'SELECT length(content) AS length FROM notes WHERE id = ?', [id]);
  if (meta.rows.length === 0) return '';
  const totalLength = Number(meta.rows.item(0).length || 0);
  let content = '';
  for (let offset = 1; offset <= totalLength; offset += NOTE_TEXT_CHUNK_CHARS) {
    const result = await execute(database, 'SELECT substr(content, ?, ?) AS chunk FROM notes WHERE id = ?', [
      offset,
      NOTE_TEXT_CHUNK_CHARS,
      id,
    ]);
    content += result.rows.item(0)?.chunk || '';
  }
  return content;
}

export async function getNoteContentById(id: number): Promise<string> {
  return getNoteContentByIdFromDatabase(await openDatabase(), id);
}

async function repairOversizedNotes(database: SQLite.SQLiteDatabase): Promise<void> {
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
      const newIds: number[] = [];
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const newId = await insertNoteRow(database, `${note.title} (${chunkIndex + 1}/${chunks.length})`, chunks[chunkIndex]);
        newIds.push(newId);
      }
      await database.transaction(async (tx) => {
        for (const newId of newIds) {
          for (let linkIndex = 0; linkIndex < links.rows.length; linkIndex++) {
            const link = links.rows.item(linkIndex);
            await tx.executeSql(
              'INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, ?)',
              [link.project_id, 'note', newId, link.enabled],
            );
          }
        }
        await tx.executeSql('DELETE FROM project_resources WHERE resource_type = ? AND resource_id = ?', ['note', note.id]);
        await tx.executeSql('DELETE FROM notes WHERE id = ?', [note.id]);
      });
    }
  } catch (error) {
    console.warn('[database] repairOversizedNotes failed:', error);
  }
}

export async function getAllNotes(projectId?: number): Promise<Note[]> {
  return all<Note>(
    `SELECT n.id, n.project_id, n.title, substr(n.content, 1, ${NOTE_LIST_PREVIEW_CHARS}) AS content,
            n.max_tokens, n.estimated_tokens, n.created_at, n.updated_at, ${usageJoin('note', 'n', projectId)}
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

export async function createNote(projectId: number, title: string, content = ''): Promise<number> {
  const id = await insertNoteRow(await openDatabase(), title, content);
  await linkResourceToProject(projectId, 'note', id);
  return id;
}

export async function updateNote(id: number, title: string, content: string): Promise<void> {
  await execute(await openDatabase(), 'UPDATE notes SET title = ?, content = ?, estimated_tokens = ?, updated_at = ? WHERE id = ?', [
    title,
    content,
    estimateTokens(content),
    now(),
    id,
  ]);
}

export async function updateNoteTokenBudget(id: number, maxTokens: number): Promise<void> {
  await execute(await openDatabase(), 'UPDATE notes SET max_tokens = ? WHERE id = ?', [maxTokens, id]);
}

export async function deleteNote(id: number): Promise<void> {
  await deleteProjectResourceLinks('note', id);
  await execute(await openDatabase(), 'DELETE FROM notes WHERE id = ?', [id]);
}

export async function getAllPresets(projectId?: number): Promise<Preset[]> {
  return all<Preset>(
    `SELECT p.*, ${usageJoin('preset', 'p', projectId)} FROM presets p ORDER BY p.is_default DESC, p.id ASC`,
  );
}

export async function getPresetsByProject(projectId: number): Promise<Preset[]> {
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

export async function updatePreset(id: number, fields: Partial<Preset>): Promise<void> {
  if (fields.is_default === 1) {
    await execute(await openDatabase(), 'UPDATE presets SET is_default = 0 WHERE id != ?', [id]);
  }
  await updateColumns('presets', id, PRESET_COLUMNS, fields);
}

export async function createPreset(projectId: number, name: string, isDefault = false): Promise<number> {
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

async function ensureDefaultPreset(database?: SQLite.SQLiteDatabase): Promise<number> {
  const target = database || (await openDatabase());
  const existing = await execute(target, 'SELECT id FROM presets WHERE is_default = 1 ORDER BY id ASC LIMIT 1');
  if (existing.rows.length > 0) return existing.rows.item(0).id;

  // If user already has presets (e.g. from a previous version), respect them —
  // do NOT create a duplicate default preset during upgrades.
  const anyPreset = await execute(target, 'SELECT id FROM presets ORDER BY id ASC LIMIT 1');
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
    base_url: row?.base_url || '',
    api_key: row?.api_key || '',
    model_name: row?.model_name || '',
    is_active: Number(row?.is_active ?? 1),
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
    await execute(await openDatabase(), 'UPDATE llm_config SET api_key = ? WHERE id = ?', ['', row.id]);
  }
  return { ...row, api_key: apiKey };
}

export async function getLLMConfigs(): Promise<LLMConfig[]> {
  const rows = await all<LLMConfig>('SELECT * FROM llm_config ORDER BY is_active DESC, id ASC');
  if (rows.length === 0) {
    await execute(
      await openDatabase(),
      'INSERT INTO llm_config (name, base_url, api_key, model_name, is_active) VALUES (?, ?, ?, ?, 1)',
      ['默认配置', '', '', ''],
    );
    return getLLMConfigs();
  }
  return Promise.all(rows.map((row) => hydrateLLMConfig(normalizeLLMConfig(row))));
}

export async function getActiveLLMConfig(): Promise<LLMConfig> {
  let config = await one<LLMConfig>('SELECT * FROM llm_config WHERE is_active = 1 ORDER BY id ASC LIMIT 1');
  if (!config) {
    const fallback = await one<LLMConfig>('SELECT * FROM llm_config ORDER BY id ASC LIMIT 1');
    if (!fallback) {
      const id = await saveLLMConfig({ name: '默认配置', base_url: '', api_key: '', model_name: '', is_active: 1 });
      config = await one<LLMConfig>('SELECT * FROM llm_config WHERE id = ?', [id]);
    } else {
      await setActiveLLMConfig(fallback.id);
      config = await one<LLMConfig>('SELECT * FROM llm_config WHERE id = ?', [fallback.id]);
    }
  }
  return hydrateLLMConfig(normalizeLLMConfig(config));
}

export async function saveLLMConfig(config: Partial<LLMConfig>): Promise<number> {
  const name = (config.name || '').trim() || '未命名配置';
  const baseUrl = (config.base_url || '').trim();
  const modelName = (config.model_name || '').trim();
  const isActive = Number(config.is_active || 0) === 1 ? 1 : 0;
  const database = await openDatabase();

  let id = Number(config.id || 0);
  if (id > 0) {
    await execute(
      database,
      'UPDATE llm_config SET name = ?, base_url = ?, api_key = ?, model_name = ?, is_active = ? WHERE id = ?',
      [name, baseUrl, '', modelName, isActive, id],
    );
  } else {
    const result = await execute(
      database,
      'INSERT INTO llm_config (name, base_url, api_key, model_name, is_active) VALUES (?, ?, ?, ?, ?)',
      [name, baseUrl, '', modelName, isActive],
    );
    id = Number(result.insertId);
  }

  if (config.api_key !== undefined) {
    await setSecureLLMApiKey(config.api_key, id);
  }
  if (isActive) {
    await setActiveLLMConfig(id);
  }
  return id;
}

export async function setActiveLLMConfig(id: number): Promise<void> {
  const database = await openDatabase();
  await execute(database, 'UPDATE llm_config SET is_active = 0');
  await execute(database, 'UPDATE llm_config SET is_active = 1 WHERE id = ?', [id]);
}

export async function deleteLLMConfig(id: number): Promise<void> {
  const configs = await getLLMConfigs();
  if (configs.length <= 1) {
    throw new Error('至少需要保留一个 LLM 配置。');
  }

  const target = configs.find((config) => config.id === id);
  await execute(await openDatabase(), 'DELETE FROM llm_config WHERE id = ?', [id]);
  await clearSecureLLMApiKey(id);

  if (target?.is_active === 1) {
    const next = await one<LLMConfig>('SELECT * FROM llm_config ORDER BY id ASC LIMIT 1');
    if (next) await setActiveLLMConfig(next.id);
  }
}

export async function getLLMConfig(): Promise<LLMConfig> {
  return getActiveLLMConfig();
}

export async function setLLMConfig(baseUrl: string, apiKey: string, modelName: string): Promise<void> {
  const active = await getActiveLLMConfig();
  await saveLLMConfig({
    ...active,
    base_url: baseUrl,
    api_key: apiKey,
    model_name: modelName,
    is_active: 1,
  });
}

export async function getSetting(key: string): Promise<string | null> {
  const row = await one<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await execute(await openDatabase(), 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
}

export async function getContextConfig(): Promise<ContextConfig> {
  return {
    strategy: ((await getSetting('context_strategy')) as ContextConfig['strategy']) || 'sliding',
    slidingWindowSize: Number((await getSetting('sliding_window_size')) || 4000),
    customRangeStart: Number((await getSetting('custom_range_start')) || 0),
    customRangeEnd: Number((await getSetting('custom_range_end')) || -1),
    resourceBudget: Number((await getSetting('resource_budget')) || 2000),
    includeResources: (await getSetting('include_resources')) !== 'false',
    summaryBudgetTokens: Number((await getSetting('summary_budget_tokens')) || 20000),
    memoryTopK: Number((await getSetting('memory_top_k')) || 10),
    recentChapterCount: Number((await getSetting('recent_chapter_count')) || 3),
    worldbookRecursive: (await getSetting('worldbook_recursive')) !== 'false',
    worldbookScanDepth: Number((await getSetting('worldbook_scan_depth')) || 4),
  };
}

export async function setContextConfig(config: ContextConfig): Promise<void> {
  await setSetting('context_strategy', config.strategy);
  await setSetting('sliding_window_size', String(config.slidingWindowSize));
  await setSetting('custom_range_start', String(config.customRangeStart));
  await setSetting('custom_range_end', String(config.customRangeEnd));
  await setSetting('resource_budget', String(config.resourceBudget));
  await setSetting('include_resources', String(config.includeResources));
  await setSetting('summary_budget_tokens', String(config.summaryBudgetTokens ?? 20000));
  await setSetting('memory_top_k', String(config.memoryTopK ?? 10));
  await setSetting('recent_chapter_count', String(config.recentChapterCount ?? 3));
  await setSetting('worldbook_recursive', String(config.worldbookRecursive ?? true));
  await setSetting('worldbook_scan_depth', String(config.worldbookScanDepth ?? 4));
}

export async function logLLMUsage(fields: {
  scenario: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  status: string;
  errorCode?: string;
}): Promise<void> {
  await execute(
    await openDatabase(),
    `INSERT INTO llm_usage_logs (scenario, input_tokens, output_tokens, total_tokens, status, error_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.scenario,
      fields.inputTokens,
      fields.outputTokens,
      fields.totalTokens,
      fields.status,
      fields.errorCode || '',
      now(),
    ],
  );
}

export async function getFreeformDocument(projectId: number): Promise<string> {
  const row = await one<{ content: string }>('SELECT content FROM freeform_documents WHERE project_id = ?', [projectId]);
  return row?.content || '';
}

export async function setFreeformDocument(projectId: number, content: string): Promise<void> {
  await execute(
    await openDatabase(),
    'INSERT OR REPLACE INTO freeform_documents (project_id, content, updated_at) VALUES (?, ?, ?)',
    [projectId, content, now()],
  );
  await touchProject(projectId);
}

async function touchProject(projectId: number): Promise<void> {
  await execute(await openDatabase(), 'UPDATE projects SET updated_at = ? WHERE id = ?', [now(), projectId]);
}

async function updateColumns(table: string, id: number, allowed: Set<string>, fields: Row): Promise<void> {
  const sets: string[] = [];
  const values: any[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.has(key)) continue;
    sets.push(`${key} = ?`);
    values.push(value);
  }
  if (sets.length === 0) return;
  values.push(id);
  await execute(await openDatabase(), `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, values);
}

export async function getPipelineConfig(): Promise<PipelineConfig> {
  const savedMode = await getSetting('pipeline_mode');
  const pipelineMode =
    savedMode === 'noReview' || savedMode === 'conditional' || savedMode === 'full' || savedMode === 'twoStage'
      ? savedMode
      : 'twoStage';

  return {
    pipelineMode,
    draftPresetId: (await getSetting('pipeline_draft_preset_id')) !== null
      ? Number(await getSetting('pipeline_draft_preset_id'))
      : null,
    reviewPresetId: (await getSetting('pipeline_review_preset_id')) !== null
      ? Number(await getSetting('pipeline_review_preset_id'))
      : null,
    factCheckPresetId: (await getSetting('pipeline_factcheck_preset_id')) !== null
      ? Number(await getSetting('pipeline_factcheck_preset_id'))
      : null,
    proofPresetId: (await getSetting('pipeline_proof_preset_id')) !== null
      ? Number(await getSetting('pipeline_proof_preset_id'))
      : null,
    draftMaxTokens: Number((await getSetting('pipeline_draft_max_tokens')) || 4000),
    reviewMaxTokens: Number((await getSetting('pipeline_review_max_tokens')) || 1500),
    factCheckMaxTokens: Number((await getSetting('pipeline_factcheck_max_tokens')) || 1500),
    proofMaxTokens: Number((await getSetting('pipeline_proof_max_tokens')) || 4000),
  };
}

export async function setPipelineConfig(config: PipelineConfig): Promise<void> {
  await setSetting('pipeline_mode', config.pipelineMode);
  await setSetting('pipeline_draft_preset_id', config.draftPresetId !== null ? String(config.draftPresetId) : '');
  await setSetting('pipeline_review_preset_id', config.reviewPresetId !== null ? String(config.reviewPresetId) : '');
  await setSetting('pipeline_factcheck_preset_id', config.factCheckPresetId !== null ? String(config.factCheckPresetId) : '');
  await setSetting('pipeline_proof_preset_id', config.proofPresetId !== null ? String(config.proofPresetId) : '');
  await setSetting('pipeline_draft_max_tokens', String(config.draftMaxTokens));
  await setSetting('pipeline_review_max_tokens', String(config.reviewMaxTokens));
  await setSetting('pipeline_factcheck_max_tokens', String(config.factCheckMaxTokens));
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
  const rows = await all<Row>('SELECT * FROM pipeline_tasks WHERE resolved_at IS NULL ORDER BY created_at DESC');
  return rows.map((row) => ({
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    status: row.status,
    stageResults: (() => { try { return JSON.parse(row.stage_results); } catch { return []; } })(),
    finalText: row.final_text,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    resolvedAction: row.resolved_action,
  }));
}

export async function getAllPipelineTasks(): Promise<any[]> {
  const rows = await all<Row>('SELECT * FROM pipeline_tasks ORDER BY created_at DESC');
  return rows.map((row) => ({
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    status: row.status,
    stageResults: (() => { try { return JSON.parse(row.stage_results); } catch { return []; } })(),
    finalText: row.final_text,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    resolvedAction: row.resolved_action,
  }));
}

export async function deletePipelineTask(id: string): Promise<void> {
  await execute(await openDatabase(), 'DELETE FROM pipeline_tasks WHERE id = ?', [id]);
}

export async function deleteResolvedPipelineTasks(): Promise<void> {
  await execute(await openDatabase(), 'DELETE FROM pipeline_tasks WHERE resolved_at IS NOT NULL');
}

// =============================================================================
// Worldbook collection batch enable (优化2: enable all entries when collection enabled)
// =============================================================================

export async function setAllWorldbookEntriesEnabledByCollection(collectionId: number, enabled: boolean): Promise<void> {
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
    [fields.projectId, fields.targetType, fields.targetId, fields.title, fields.content, fields.source, fields.sourceRef ?? null, createdAt],
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
  await execute(await openDatabase(), 'DELETE FROM content_revisions WHERE id = ?', [id]);
}

export async function trimContentRevisions(
  targetType: string,
  targetId: number,
  maxAuto = 50,
  maxManual = 20,
): Promise<void> {
  const database = await openDatabase();
  await database.transaction(async (tx) => {
    const [autoResult] = await tx.executeSql(
      `SELECT id FROM content_revisions
       WHERE target_type = ? AND target_id = ? AND source != 'manual_checkpoint'
       ORDER BY created_at DESC`,
      [targetType, targetId],
    );
    const autoIds: number[] = [];
    for (let i = 0; i < autoResult.rows.length; i++) {
      autoIds.push(autoResult.rows.item(i).id);
    }
    const toDeleteAuto = autoIds.slice(maxAuto);
    for (const id of toDeleteAuto) {
      await tx.executeSql('DELETE FROM content_revisions WHERE id = ?', [id]);
    }

    const [manualResult] = await tx.executeSql(
      `SELECT id FROM content_revisions
       WHERE target_type = ? AND target_id = ? AND source = 'manual_checkpoint'
       ORDER BY created_at DESC`,
      [targetType, targetId],
    );
    const manualIds: number[] = [];
    for (let i = 0; i < manualResult.rows.length; i++) {
      manualIds.push(manualResult.rows.item(i).id);
    }
    const toDeleteManual = manualIds.slice(maxManual);
    for (const id of toDeleteManual) {
      await tx.executeSql('DELETE FROM content_revisions WHERE id = ?', [id]);
    }
  });
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
    [fields.projectId, fields.targetType, fields.targetId, fields.content, fields.source, fields.pipelineTaskId ?? null, fields.tokenCount, createdAt],
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
  return one(
    `SELECT * FROM generation_drafts WHERE id = ?`,
    [id],
  );
}

export async function deleteGenerationDraft(id: number): Promise<void> {
  await execute(await openDatabase(), 'DELETE FROM generation_drafts WHERE id = ?', [id]);
}

export async function deleteGenerationDraftsByTarget(
  targetType: string,
  targetId: number,
): Promise<void> {
  await execute(await openDatabase(), 'DELETE FROM generation_drafts WHERE target_type = ? AND target_id = ?', [targetType, targetId]);
}

// ---------------------------------------------------------------------------
// LLM Usage Stats
// ---------------------------------------------------------------------------

export async function getLLMUsageStats(projectId: number | null): Promise<any[]> {
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

export async function getLLMUsageSummary(projectId: number | null): Promise<any> {
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
  return result.rows.length > 0 ? result.rows.item(0) : { total_calls: 0, total_input_tokens: 0, total_output_tokens: 0, total_tokens: 0 };
}
