import type SQLite from 'react-native-sqlite-storage';
import { SCHEMA_MANIFEST } from './schemaManifest';
import { SCHEMA_VERSION } from '../migrations';

export type SchemaIssueCode =
  | 'MISSING_TABLE'
  | 'MISSING_COLUMN'
  | 'MISSING_INDEX'
  | 'SCHEMA_VERSION_MISMATCH'
  | 'FOREIGN_KEYS_DISABLED'
  | 'INVALID_ACTIVE_LLM'
  | 'ORPHAN_REFERENCE'
  | 'QUERY_FAILED';

export interface SchemaIssue {
  code: SchemaIssueCode;
  message: string;
  table?: string;
  column?: string;
  index?: string;
}

export interface SchemaValidationResult {
  valid: boolean;
  issues: SchemaIssue[];
}

interface ValidationOptions {
  requireActiveLlmConfig?: boolean;
}

type DatabaseLike = Pick<SQLite.SQLiteDatabase, 'executeSql'>;

async function rows<T>(
  database: DatabaseLike,
  sql: string,
  params: any[] = [],
): Promise<T[]> {
  const [result] = await database.executeSql(sql, params);
  const output: T[] = [];
  for (let index = 0; index < result.rows.length; index += 1) {
    output.push(result.rows.item(index) as T);
  }
  return output;
}

const ORPHAN_CHECKS: Array<{
  label: string;
  tables: string[];
  sql: string;
}> = [
  {
    label: 'chapters.project_id',
    tables: ['chapters', 'projects'],
    sql: 'SELECT c.id FROM chapters c LEFT JOIN projects p ON p.id = c.project_id WHERE p.id IS NULL LIMIT 1',
  },
  {
    label: 'fragments.project_id',
    tables: ['fragments', 'projects'],
    sql: 'SELECT f.id FROM fragments f LEFT JOIN projects p ON p.id = f.project_id WHERE p.id IS NULL LIMIT 1',
  },
  {
    label: 'plotlines.project_id',
    tables: ['plotlines', 'projects'],
    sql: 'SELECT pl.id FROM plotlines pl LEFT JOIN projects p ON p.id = pl.project_id WHERE p.id IS NULL LIMIT 1',
  },
  {
    label: 'characters.project_id',
    tables: ['characters', 'projects'],
    sql: 'SELECT c.id FROM characters c LEFT JOIN projects p ON p.id = c.project_id WHERE p.id IS NULL LIMIT 1',
  },
  {
    label: 'character_collections.project_id',
    tables: ['character_collections', 'projects'],
    sql: 'SELECT cc.id FROM character_collections cc LEFT JOIN projects p ON p.id = cc.project_id WHERE p.id IS NULL LIMIT 1',
  },
  {
    label: 'worldbook_collections.project_id',
    tables: ['worldbook_collections', 'projects'],
    sql: 'SELECT wc.id FROM worldbook_collections wc LEFT JOIN projects p ON p.id = wc.project_id WHERE p.id IS NULL LIMIT 1',
  },
  {
    label: 'worldbook_entries.project_id',
    tables: ['worldbook_entries', 'projects'],
    sql: 'SELECT we.id FROM worldbook_entries we LEFT JOIN projects p ON p.id = we.project_id WHERE p.id IS NULL LIMIT 1',
  },
  {
    label: 'notes.project_id',
    tables: ['notes', 'projects'],
    sql: 'SELECT n.id FROM notes n LEFT JOIN projects p ON p.id = n.project_id WHERE p.id IS NULL LIMIT 1',
  },
  {
    label: 'presets.project_id',
    tables: ['presets', 'projects'],
    sql: 'SELECT pr.id FROM presets pr LEFT JOIN projects p ON p.id = pr.project_id WHERE p.id IS NULL LIMIT 1',
  },
  {
    label: 'project_resources.project_id',
    tables: ['project_resources', 'projects'],
    sql: 'SELECT r.project_id FROM project_resources r LEFT JOIN projects p ON p.id = r.project_id WHERE p.id IS NULL LIMIT 1',
  },
  {
    label: 'freeform_documents.project_id',
    tables: ['freeform_documents', 'projects'],
    sql: 'SELECT f.project_id FROM freeform_documents f LEFT JOIN projects p ON p.id = f.project_id WHERE p.id IS NULL LIMIT 1',
  },
  {
    label: 'content_revisions.project_id',
    tables: ['content_revisions', 'projects'],
    sql: 'SELECT cr.id FROM content_revisions cr LEFT JOIN projects p ON p.id = cr.project_id WHERE p.id IS NULL LIMIT 1',
  },
  {
    label: 'generation_drafts.project_id',
    tables: ['generation_drafts', 'projects'],
    sql: 'SELECT gd.id FROM generation_drafts gd LEFT JOIN projects p ON p.id = gd.project_id WHERE p.id IS NULL LIMIT 1',
  },
  {
    label: 'project_note_config.project_id',
    tables: ['project_note_config', 'projects'],
    sql: 'SELECT pnc.project_id FROM project_note_config pnc LEFT JOIN projects p ON p.id = pnc.project_id WHERE p.id IS NULL LIMIT 1',
  },
  {
    label: 'note_style_profiles.note_id',
    tables: ['note_style_profiles', 'notes'],
    sql: 'SELECT nsp.note_id FROM note_style_profiles nsp LEFT JOIN notes n ON n.id = nsp.note_id WHERE n.id IS NULL LIMIT 1',
  },
  {
    label: 'project_plotlines.chapter_id',
    tables: ['project_plotlines', 'chapters'],
    sql: 'SELECT pp.chapter_id FROM project_plotlines pp LEFT JOIN chapters c ON c.id = pp.chapter_id WHERE c.id IS NULL LIMIT 1',
  },
  {
    label: 'project_plotlines.plotline_id',
    tables: ['project_plotlines', 'plotlines'],
    sql: 'SELECT pp.plotline_id FROM project_plotlines pp LEFT JOIN plotlines p ON p.id = pp.plotline_id WHERE p.id IS NULL LIMIT 1',
  },
];

export async function validateSchema(
  database: DatabaseLike,
  options: ValidationOptions = {},
): Promise<SchemaValidationResult> {
  const issues: SchemaIssue[] = [];
  const requireActiveLlmConfig = options.requireActiveLlmConfig ?? true;

  try {
    const tableRows = await rows<{ name: string }>(
      database,
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    const tableNames = new Set(tableRows.map(row => row.name));

    for (const table of SCHEMA_MANIFEST) {
      if (!tableNames.has(table.name)) {
        issues.push({
          code: 'MISSING_TABLE',
          message: `缺少必要数据表：${table.name}`,
          table: table.name,
        });
        continue;
      }

      const columnRows = await rows<{ name: string }>(
        database,
        `PRAGMA table_info(${table.name})`,
      );
      const columns = new Set(columnRows.map(row => row.name));
      for (const column of table.columns) {
        if (!columns.has(column)) {
          issues.push({
            code: 'MISSING_COLUMN',
            message: `数据表 ${table.name} 缺少字段：${column}`,
            table: table.name,
            column,
          });
        }
      }

      if (table.indexes?.length) {
        const indexRows = await rows<{ name: string }>(
          database,
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?",
          [table.name],
        );
        const indexes = new Set(indexRows.map(row => row.name));
        for (const index of table.indexes) {
          if (!indexes.has(index)) {
            issues.push({
              code: 'MISSING_INDEX',
              message: `数据表 ${table.name} 缺少索引：${index}`,
              table: table.name,
              index,
            });
          }
        }
      }
    }

    const foreignKeys = await rows<{ foreign_keys?: number; value?: number }>(
      database,
      'PRAGMA foreign_keys',
    );
    const foreignKeysEnabled = Number(
      foreignKeys[0]?.foreign_keys ?? foreignKeys[0]?.value ?? 0,
    );
    if (foreignKeysEnabled !== 1) {
      issues.push({
        code: 'FOREIGN_KEYS_DISABLED',
        message: 'SQLite 外键约束未启用。',
      });
    }

    if (tableNames.has('settings')) {
      const schemaRows = await rows<{ value: string }>(
        database,
        'SELECT value FROM settings WHERE key = ?',
        ['schema_version'],
      );
      const schemaVersion = schemaRows.length
        ? Number(schemaRows[0].value)
        : NaN;
      if (schemaVersion !== SCHEMA_VERSION) {
        issues.push({
          code: 'SCHEMA_VERSION_MISMATCH',
          message: `Schema 版本不匹配：当前记录为 ${String(
            schemaRows[0]?.value ?? '空',
          )}，要求 ${SCHEMA_VERSION}。`,
          table: 'settings',
          column: 'schema_version',
        });
      }
    }

    if (tableNames.has('llm_config')) {
      const activeConfigs = await rows<{
        id: number;
        provider_type?: string;
        local_model_id?: string | null;
        base_url?: string;
        model_name?: string;
      }>(
        database,
        'SELECT id, provider_type, local_model_id, base_url, model_name FROM llm_config WHERE is_active = 1',
      );
      if (requireActiveLlmConfig && activeConfigs.length === 0) {
        issues.push({
          code: 'INVALID_ACTIVE_LLM',
          message: '没有可用的激活 LLM 配置。',
          table: 'llm_config',
        });
      }
      for (const config of activeConfigs) {
        const isLocal =
          config.provider_type === 'llama_cpp' ||
          config.provider_type === 'local_litertlm';
        if (isLocal && !config.local_model_id) {
          issues.push({
            code: 'INVALID_ACTIVE_LLM',
            message: `激活的本地 LLM 配置 ${config.id} 未引用模型。`,
            table: 'llm_config',
          });
          continue;
        }
        if (isLocal && tableNames.has('local_llm_models')) {
          const modelRows = await rows<{ id: string }>(
            database,
            'SELECT id FROM local_llm_models WHERE id = ?',
            [config.local_model_id],
          );
          if (modelRows.length === 0) {
            issues.push({
              code: 'INVALID_ACTIVE_LLM',
              message: `激活的 LLM 配置 ${config.id} 引用了不存在的本地模型：${config.local_model_id}。`,
              table: 'llm_config',
              column: 'local_model_id',
            });
          }
        }
      }
    }

    for (const check of ORPHAN_CHECKS) {
      if (!check.tables.every(table => tableNames.has(table))) continue;
      const orphanRows = await rows<Record<string, unknown>>(
        database,
        check.sql,
      );
      if (orphanRows.length > 0) {
        issues.push({
          code: 'ORPHAN_REFERENCE',
          message: `发现孤儿引用：${check.label}。`,
        });
      }
    }
  } catch (error) {
    issues.push({
      code: 'QUERY_FAILED',
      message: `Schema 验证查询失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  return { valid: issues.length === 0, issues };
}

export function formatSchemaIssues(issues: readonly SchemaIssue[]): string {
  return issues.map(issue => `[${issue.code}] ${issue.message}`).join('；');
}

export function assertValidSchema(result: SchemaValidationResult): void {
  if (!result.valid) {
    throw new Error(
      `数据库 Schema 验证失败：${formatSchemaIssues(result.issues)}`,
    );
  }
}
