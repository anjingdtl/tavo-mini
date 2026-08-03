import type SQLite from 'react-native-sqlite-storage';
import { SCHEMA_MANIFEST } from './schemaManifest';
import { SCHEMA_VERSION } from '../migrations';

export type SchemaIssueCode =
  | 'MISSING_TABLE'
  | 'MISSING_COLUMN'
  | 'MISSING_INDEX'
  | 'SCHEMA_VERSION_MISMATCH'
  | 'FOREIGN_KEYS_DISABLED'
  | 'FOREIGN_KEY_VIOLATION'
  | 'FOREIGN_KEY_TARGET_MISMATCH'
  | 'ACTIVE_POINTER_INVALID'
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
    label: 'note_collections.project_id',
    tables: ['note_collections', 'projects'],
    sql: 'SELECT nc.id FROM note_collections nc LEFT JOIN projects p ON p.id = nc.project_id WHERE p.id IS NULL LIMIT 1',
  },
  {
    label: 'notes.project_id',
    tables: ['notes', 'projects'],
    sql: 'SELECT n.id FROM notes n LEFT JOIN projects p ON p.id = n.project_id WHERE p.id IS NULL LIMIT 1',
  },
  {
    label: 'notes.collection_id',
    tables: ['notes', 'note_collections'],
    sql: 'SELECT n.id FROM notes n LEFT JOIN note_collections nc ON nc.id = n.collection_id WHERE n.collection_id <> 0 AND nc.id IS NULL LIMIT 1',
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
  {
    label: 'continuation_generation_stage_results.run_id',
    tables: ['continuation_generation_stage_results', 'continuation_generation_runs'],
    sql: `SELECT sr.id
      FROM continuation_generation_stage_results sr
      LEFT JOIN continuation_generation_runs r ON r.id = sr.run_id
      WHERE r.id IS NULL LIMIT 1`,
  },
  {
    label: 'continuation_generation_stage_results.artifact_id',
    tables: ['continuation_generation_stage_results', 'continuation_generation_artifacts'],
    sql: `SELECT sr.id
      FROM continuation_generation_stage_results sr
      LEFT JOIN continuation_generation_artifacts a ON a.id = sr.artifact_id
      WHERE sr.artifact_id IS NOT NULL AND a.id IS NULL LIMIT 1`,
  },
  {
    label: 'continuation_generation_artifacts.eligibility_status',
    tables: ['continuation_generation_artifacts'],
    sql: `SELECT id FROM continuation_generation_artifacts
      WHERE eligibility_status NOT IN ('eligible', 'rejected') LIMIT 1`,
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
      // Spec §15: tables marked backup:false (e.g. continuation_import_jobs)
      // are runtime/transient state and never restored from backup. A missing
      // backup:false table must not fail post-restore validation, because a
      // restored DB is expected to recreate it on next schema init. Only
      // persisted (backup:true) tables are required for a valid restore.
      if (!table.backup) continue;
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

    const foreignKeyViolations = await rows<Record<string, unknown>>(
      database,
      'PRAGMA foreign_key_check',
    );
    if (foreignKeyViolations.length > 0) {
      issues.push({
        code: 'FOREIGN_KEY_VIOLATION',
        message: `发现 ${foreignKeyViolations.length} 条 SQLite 外键孤儿记录。`,
      });
    }

    const foreignKeyTargetChecks: Array<{
      table: string;
      fromColumns: string[];
      expectedTarget: string;
    }> = [
      {
        table: 'continuation_analysis_batches',
        fromColumns: ['run_id'],
        expectedTarget: 'continuation_analysis_runs',
      },
      {
        table: 'continuation_analysis_work_items',
        fromColumns: ['run_id', 'batch_index'],
        expectedTarget: 'continuation_analysis_batches',
      },
      {
        table: 'canon_evidence',
        fromColumns: ['analysis_run_id'],
        expectedTarget: 'continuation_analysis_runs',
      },
      {
        table: 'continuation_generation_stage_results',
        fromColumns: ['run_id'],
        expectedTarget: 'continuation_generation_runs',
      },
      {
        table: 'continuation_generation_stage_results',
        fromColumns: ['artifact_id'],
        expectedTarget: 'continuation_generation_artifacts',
      },
    ];
    for (const check of foreignKeyTargetChecks) {
      if (!tableNames.has(check.table)) continue;
      const foreignKeyRows = await rows<{
        table: string;
        from: string;
      }>(database, `PRAGMA foreign_key_list(${check.table})`);
      for (const foreignKey of foreignKeyRows) {
        if (
          check.fromColumns.includes(foreignKey.from) &&
          foreignKey.table !== check.expectedTarget
        ) {
          issues.push({
            code: 'FOREIGN_KEY_TARGET_MISMATCH',
            message: `${check.table}.${foreignKey.from} 的外键目标异常：${foreignKey.table}。`,
            table: check.table,
          });
        }
      }
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
        base_url?: string;
        model_name?: string;
      }>(
        database,
        'SELECT id, provider_type, base_url, model_name FROM llm_config WHERE is_active = 1',
      );
      if (requireActiveLlmConfig && activeConfigs.length === 0) {
        issues.push({
          code: 'INVALID_ACTIVE_LLM',
          message: '没有可用的激活 LLM 配置。',
          table: 'llm_config',
        });
      }
    }

    if (
      tableNames.has('continuation_settings') &&
      tableNames.has('continuation_canon_snapshots')
    ) {
      const orphanCanonPointers = await rows<Record<string, unknown>>(
        database,
        `SELECT st.project_id
         FROM continuation_settings st
         LEFT JOIN continuation_canon_snapshots snap
           ON snap.id = st.active_canon_snapshot_id
         WHERE st.active_canon_snapshot_id IS NOT NULL
           AND (
             snap.id IS NULL OR snap.project_id <> st.project_id
             OR snap.source_id <> st.active_source_id
             OR snap.boundary_chapter_id <> st.boundary_chapter_id
             OR snap.boundary_char_offset_exclusive <> st.boundary_char_offset_global
           )
         LIMIT 1`,
      );
      if (orphanCanonPointers.length > 0) {
        issues.push({
          code: 'ACTIVE_POINTER_INVALID',
          message: 'continuation_settings 的 active Canon 指针不是同项目/同 source/boundary 的有效快照。',
          table: 'continuation_settings',
          column: 'active_canon_snapshot_id',
        });
      }
    }

    if (
      tableNames.has('continuation_settings') &&
      tableNames.has('continuation_style_profiles') &&
      tableNames.has('continuation_sources') &&
      tableNames.has('continuation_source_chapters')
    ) {
      const orphanStylePointers = await rows<Record<string, unknown>>(
        database,
        `SELECT st.project_id
         FROM continuation_settings st
         LEFT JOIN continuation_style_profiles style
           ON style.id = st.active_style_profile_id
         LEFT JOIN continuation_sources src ON src.id = style.source_id
         LEFT JOIN continuation_source_chapters ch
           ON ch.id = style.boundary_chapter_id
         WHERE st.active_style_profile_id IS NOT NULL
           AND (
             style.id IS NULL OR style.project_id <> st.project_id
             OR style.state <> 'ready' OR style.review_status = 'ignored'
             OR style.source_id <> st.active_source_id
             OR src.version <> style.source_version
             OR src.normalized_sha256 <> style.source_sha256
             OR src.parser_version <> style.parser_version
             OR src.normalization_version <> style.normalization_version
             OR ch.position <> style.boundary_position
             OR style.boundary_chapter_id <> st.boundary_chapter_id
             OR style.boundary_char_offset_exclusive <> st.boundary_char_offset_global
             OR (
               st.active_canon_snapshot_id IS NOT NULL
               AND style.canon_snapshot_id <> st.active_canon_snapshot_id
             )
           )
         LIMIT 1`,
      );
      if (orphanStylePointers.length > 0) {
        issues.push({
          code: 'ACTIVE_POINTER_INVALID',
          message: 'continuation_settings 的 active Style 指针不是同项目/同 source/boundary 的可用画像。',
          table: 'continuation_settings',
          column: 'active_style_profile_id',
        });
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
