/* eslint-env jest */

type Row = Record<string, any>;
type SchemaState = {
  schemas: Map<string, Set<string>>;
  indexes: Set<string>;
  settings: Map<string, string>;
  collectionRows: number;
};

function createRows(rows: Row[]) {
  return {
    length: rows.length,
    item: (index: number) => rows[index],
    raw: () => rows,
  };
}

function cloneSchemas(schemas: Map<string, Set<string>>) {
  return new Map(
    Array.from(schemas.entries()).map(([table, columns]) => [
      table,
      new Set(columns),
    ]),
  );
}

function parseCreateTable(sql: string, schemas: Map<string, Set<string>>) {
  const match = sql.match(
    /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]+)\)/i,
  );
  if (!match || schemas.has(match[1])) return;

  const columns = new Set<string>();
  for (const part of match[2].split(',')) {
    const name = part.trim().match(/^([a-z_][a-z0-9_]*)\s+/i)?.[1];
    if (
      name &&
      !['primary', 'foreign', 'unique', 'constraint'].includes(
        name.toLowerCase(),
      )
    ) {
      columns.add(name);
    }
  }
  schemas.set(match[1], columns);
}

export function createMigrationDb(
  options: {
    schemaVersion?: number;
    failWhenSqlIncludes?: string;
  } = {},
) {
  const schemaVersion = options.schemaVersion ?? 3;
  const baseSchemas = new Map<string, Set<string>>([
    ['projects', new Set(['id', 'name', 'mode', 'created_at', 'updated_at'])],
    ['characters', new Set(['id', 'project_id', 'estimated_tokens'])],
    [
      'project_resources',
      new Set(['project_id', 'resource_type', 'resource_id', 'enabled']),
    ],
    ['worldbook_entries', new Set(['id', 'project_id', 'collection_id'])],
    ['worldbook_collections', new Set(['id'])],
    ['notes', new Set(['id', 'project_id'])],
    ['presets', new Set(['id', 'project_id'])],
    ['llm_usage_logs', new Set(['id', 'created_at'])],
    ['llm_config', new Set(['id'])],
    ['settings', new Set(['key', 'value'])],
  ]);
  if (schemaVersion >= 6) {
    baseSchemas.set('content_revisions', new Set(['id', 'project_id']));
  }
  if (schemaVersion >= 7) {
    baseSchemas.set('generation_drafts', new Set(['id', 'project_id']));
  }
  if (schemaVersion >= 9) {
    baseSchemas.set(
      'project_note_config',
      new Set([
        'project_id',
        'mode',
        'style_weights',
        'retrieval_top_k',
        ...(schemaVersion < 13 ? ['retrieval_fragment_chars'] : []),
        'enabled_note_ids',
        'updated_at',
      ]),
    );
    baseSchemas.set(
      'note_style_profiles',
      new Set(['note_id', 'profile_text']),
    );
  }
  if (schemaVersion >= 11) {
    baseSchemas.set('character_collections', new Set(['id', 'project_id']));
    baseSchemas.get('characters')?.add('collection_id');
  }
  if (schemaVersion >= 12) {
    baseSchemas.set('local_llm_models', new Set(['id', 'status']));
    for (const column of [
      'provider_type',
      'local_model_id',
      'local_backend',
      'context_window',
      'max_output_tokens',
    ]) {
      baseSchemas.get('llm_config')?.add(column);
    }
  }
  if (schemaVersion >= 13) {
    baseSchemas.get('local_llm_models')?.add('prompt_template');
    baseSchemas.get('local_llm_models')?.add('actual_backend');
  }
  if (schemaVersion >= 19) {
    baseSchemas.set(
      'continuation_sources',
      new Set(['id', 'project_id', 'version', 'status']),
    );
    baseSchemas.set(
      'continuation_source_text_chunks',
      new Set(['id', 'source_id', 'chunk_index']),
    );
    baseSchemas.set(
      'continuation_source_chapters',
      new Set(['id', 'source_id', 'position']),
    );
    baseSchemas.set(
      'continuation_settings',
      new Set([
        'project_id',
        'active_source_id',
        'boundary_source_id',
        'boundary_chapter_id',
        'boundary_char_offset_global',
        'boundary_mode',
        'import_completed',
        'analysis_status',
        ...(schemaVersion >= 20 ? ['active_canon_snapshot_id'] : []),
        'created_at',
        'updated_at',
      ]),
    );
    baseSchemas.set(
      'continuation_import_jobs',
      new Set(['id', 'project_id', 'state']),
    );
  }
  if (schemaVersion >= 20) {
    baseSchemas.set(
      'continuation_canon_snapshots',
      new Set(['id', 'project_id', 'source_id', 'status']),
    );
    baseSchemas.set(
      'continuation_analysis_runs',
      new Set([
        'id',
        'project_id',
        'source_id',
        'canon_snapshot_id',
        'state',
        'stage',
      ]),
    );
  }
  if (schemaVersion >= 21 && schemaVersion < 26) {
    // Legacy single-row style profile shape (pre Schema 26 rebuild).
    baseSchemas.set(
      'continuation_style_profiles',
      new Set([
        'project_id',
        'source_id',
        'canon_snapshot_id',
        'canon_revision',
        'review_status',
        'created_at',
        'updated_at',
      ]),
    );
  }
  if (schemaVersion >= 22) {
    baseSchemas.set(
      'continuation_analysis_work_items',
      new Set([
        'run_id',
        'batch_index',
        'material_type',
        'state',
        'attempt_count',
        'result_json',
        'error_code',
        'error_message',
        'created_at',
        'updated_at',
        'completed_at',
      ]),
    );
  }

  const state: SchemaState = {
    schemas: baseSchemas,
    indexes: new Set<string>(),
    settings: new Map<string, string>([
      ['schema_version', String(schemaVersion)],
    ]),
    collectionRows: 0,
  };
  const executed: string[] = [];

  const applyStatement = (
    target: SchemaState,
    sql: string,
    params: any[] = [],
    record = true,
  ) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (record) executed.push(normalized);
    if (
      options.failWhenSqlIncludes &&
      normalized.includes(options.failWhenSqlIncludes)
    ) {
      throw new Error(
        `Injected migration failure: ${options.failWhenSqlIncludes}`,
      );
    }

    const pragma = normalized.match(/^PRAGMA table_info\((\w+)\)/i);
    if (pragma) {
      const columns = Array.from(target.schemas.get(pragma[1]) || []).map(
        (name, cid) => ({ name, cid }),
      );
      return [{ rows: createRows(columns), rowsAffected: 0, insertId: 0 }];
    }

    const alter = normalized.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/i);
    if (alter) {
      const columns = target.schemas.get(alter[1]) || new Set<string>();
      columns.add(alter[2]);
      target.schemas.set(alter[1], columns);
      return [{ rows: createRows([]), rowsAffected: 0, insertId: 0 }];
    }

    const rename = normalized.match(/^ALTER TABLE (\w+) RENAME TO (\w+)/i);
    if (rename) {
      const columns = target.schemas.get(rename[1]);
      if (columns) {
        target.schemas.delete(rename[1]);
        target.schemas.set(rename[2], columns);
      }
      return [{ rows: createRows([]), rowsAffected: 0, insertId: 0 }];
    }

    const drop = normalized.match(/^DROP TABLE (?:IF EXISTS )?(\w+)/i);
    if (drop) {
      target.schemas.delete(drop[1]);
      return [{ rows: createRows([]), rowsAffected: 0, insertId: 0 }];
    }

    parseCreateTable(sql, target.schemas);
    // Match both plain and partial/unique indexes (CREATE [UNIQUE] INDEX ...).
    // Partial indexes (CREATE UNIQUE INDEX ... WHERE ...) are used by the
    // continuation tables (Schema 19) and must be registered by name.
    const index = normalized.match(
      /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/i,
    );
    if (index) target.indexes.add(index[1]);
    if (
      /^INSERT .*INTO worldbook_collections/i.test(normalized) &&
      target.collectionRows === 0
    ) {
      target.collectionRows = 1;
    }
    if (/^INSERT OR REPLACE INTO settings/i.test(normalized)) {
      target.settings.set(params[0], params[1]);
    }
    return [{ rows: createRows([]), rowsAffected: 1, insertId: 0 }];
  };

  const database = {
    executeSql: jest.fn(async (sql: string, params: any[] = []) =>
      applyStatement(state, sql, params),
    ),
    transaction: jest.fn(
      (
        scope: (tx: {
          executeSql: (sql: string, params?: any[]) => void;
        }) => void,
        onError: (error: unknown) => void,
        onSuccess: () => void,
      ) => {
        const staged: SchemaState = {
          schemas: cloneSchemas(state.schemas),
          indexes: new Set(state.indexes),
          settings: new Map(state.settings),
          collectionRows: state.collectionRows,
        };
        const stagedExecuted: string[] = [];
        const stagedDb = {
          executeSql: (sql: string, params: any[] = []) => {
            const before = executed.length;
            const result = applyStatement(staged, sql, params, false);
            stagedExecuted.push(sql.replace(/\s+/g, ' ').trim());
            executed.splice(before);
            return result;
          },
        };

        try {
          scope(stagedDb);
          state.schemas = staged.schemas;
          state.indexes = staged.indexes;
          state.settings = staged.settings;
          state.collectionRows = staged.collectionRows;
          executed.push(...stagedExecuted);
          onSuccess();
        } catch (error) {
          onError(error);
        }
      },
    ),
  };

  return {
    database,
    get schemas() {
      return state.schemas;
    },
    get indexes() {
      return state.indexes;
    },
    get settings() {
      return state.settings;
    },
    executed,
    getCollectionRows: () => state.collectionRows,
  };
}
