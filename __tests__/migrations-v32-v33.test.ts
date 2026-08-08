/**
 * Schema 32 → 33 migration: Canon fact business-key UNIQUE indexes + evidence
 * provenance columns.
 *
 * Schema 40 refactor: the two `ALTER TABLE ADD COLUMN` statements moved out of
 * `buildV32toV33Statements` into the shared idempotent
 * `ensureCanonEvidenceProvenanceSchema` (called by the logic migration
 * `migrateV32ToV33`). The build-statements path now only carries the dedup +
 * index work, all of which is already idempotent.
 */
import {
  buildSchema33CreateSqls,
  buildV32toV33Statements,
  migrateV32ToV33,
} from '../src/services/migrations/v32-to-v33';
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  columnExists,
  dropProvenanceColumns,
  dropRescanOpOnly,
  dropSourceOriginOnly,
  indexExists,
  seedCanonicalData,
} from './schema40-fixture-helpers';

describe('Schema 32 → 33 Canon dedup infrastructure', () => {
  it('is superseded by a later current SCHEMA_VERSION', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(33);
  });

  it('emits rebind-then-dedup + 6 indexes (provenance ALTERs moved to ensure function)', () => {
    const statements = buildV32toV33Statements();
    const sqls = statements.map(s => s.sql);
    // The ALTER TABLE ADD COLUMN statements are now applied dynamically by
    // ensureCanonEvidenceProvenanceSchema (check-then-ALTER), NOT in the static
    // build-statements batch. Assert they are absent here.
    expect(sqls.filter(s => /ADD COLUMN source_origin/.test(s))).toHaveLength(0);
    expect(sqls.filter(s => /ADD COLUMN rescan_operation_id/.test(s))).toHaveLength(0);
    // Each of 5 fact tables: rebind UPDATE + link dedup DELETE + fact DELETE
    expect(sqls.filter(s => /UPDATE canon_evidence_links/.test(s)).length).toBeGreaterThanOrEqual(5);
    expect(sqls.filter(s => /^DELETE FROM canon_/.test(s)).length).toBeGreaterThanOrEqual(5);
    // 5 UNIQUE business indexes + 1 rescan-op index
    expect(sqls.filter(s => /CREATE UNIQUE INDEX.*_business/.test(s))).toHaveLength(5);
    expect(sqls.filter(s => /CREATE INDEX.*idx_canon_evidence_rescan_op/.test(s))).toHaveLength(1);
  });

  it('buildSchema33CreateSqls emits the same UNIQUE indexes for fresh installs', () => {
    const sqls = buildSchema33CreateSqls();
    expect(sqls.filter(s => /CREATE UNIQUE INDEX.*_business/.test(s))).toHaveLength(5);
    expect(sqls.some(s => /idx_canon_evidence_rescan_op/.test(s))).toBe(true);
    // Fresh-install path must NOT emit ALTER TABLE (columns are inline in v19-v20)
    expect(sqls.some(s => /ALTER TABLE/.test(s))).toBe(false);
    expect(sqls.some(s => /DELETE FROM/.test(s))).toBe(false);
  });

  it('creates all 6 indexes on a real in-memory schema', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const [res] = await db.executeSql(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_canon_%_business' OR name='idx_canon_evidence_rescan_op'`,
      );
      const names: string[] = [];
      for (let i = 0; i < res.rows.length; i++) names.push(res.rows.item(i).name);
      expect(names).toContain('idx_canon_world_rules_business');
      expect(names).toContain('idx_canon_characters_business');
      expect(names).toContain('idx_canon_plot_threads_business');
      expect(names).toContain('idx_canon_relationships_business');
      expect(names).toContain('idx_canon_experiences_business');
      expect(names).toContain('idx_canon_evidence_rescan_op');
    } finally {
      db.close();
    }
  });

  it('canon_evidence has source_origin and rescan_operation_id columns', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const [res] = await db.executeSql('PRAGMA table_info(canon_evidence)');
      const cols: string[] = [];
      for (let i = 0; i < res.rows.length; i++) cols.push(res.rows.item(i).name);
      expect(cols).toContain('source_origin');
      expect(cols).toContain('rescan_operation_id');
    } finally {
      db.close();
    }
  });

  it('UNIQUE index blocks a second active world_rule with the same title', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const base = {
        projectId: 1,
        sourceId: 1,
        snapshotId: 'snap-1',
        runId: 'run-1',
        chapterId: 1,
        boundaryExclusive: 1000,
      };
      // Seed FK chain + analysis run.
      await db.executeSql(`INSERT INTO projects (id,name,mode,created_at,updated_at) VALUES (1,'t','continuation','t','t')`);
      await db.executeSql(`INSERT INTO continuation_sources (id,project_id,version,status,display_name,original_file_name,detected_encoding,raw_sha256,normalized_sha256,normalized_char_count,normalized_byte_count,file_size_bytes,parser_version,normalization_version,created_at,updated_at) VALUES (1,1,1,'ready','s','s.txt','UTF-8','x','y',1000,2000,2000,'v1','v1','t','t')`);
      await db.executeSql(`INSERT INTO continuation_source_chapters (id,source_id,position,detected_title,title,content_sha256,char_count,paragraph_count,source_start_offset,content_start_offset,source_end_offset,created_at,updated_at) VALUES (1,1,0,'c','c','c',1000,1,0,0,1000,'t','t')`);
      await db.executeSql(`INSERT INTO continuation_canon_snapshots (id,project_id,source_id,analysis_run_id,source_version,source_sha256,parser_version,normalization_version,boundary_chapter_id,boundary_position,boundary_char_offset_exclusive,extraction_version,profile,status,revision,capabilities_json,coverage_json,created_at,updated_at) VALUES ('snap-1',1,1,'run-1',1,'y','v1','v1',1,0,1000,'v1','standard','staging',1,'{}','{}','t','t')`);
      await db.executeSql(`INSERT INTO continuation_analysis_runs (id,project_id,source_id,source_version,source_sha256,parser_version,normalization_version,boundary_chapter_id,boundary_position,boundary_char_offset_exclusive,canon_snapshot_id,profile,state,stage,extraction_version,created_at,updated_at) VALUES ('run-1',1,1,1,'y','v1','v1',1,0,1000,'snap-1','standard','running','chapter_extraction','v1','t','t')`);
      const insertRule = (title: string) =>
        db.executeSql(
          `INSERT INTO canon_world_rules (project_id,source_id,snapshot_id,analysis_run_id,valid_from_position,first_observed_position,last_observed_position,confidence,review_status,origin,extraction_version,revision,created_at,updated_at,category,title,description,constraint_level) VALUES (1,1,'snap-1','run-1',0,0,0,0.9,'pending','ai','v1',1,'t','t','other',?,?,'reference')`,
          [title, title],
        );
      await insertRule('鐏垫皵澶嶈嫃');
      // Second active (non-superseded) rule with the same title+snapshot must fail.
      await expect(insertRule('鐏垫皵澶嶈嫃')).rejects.toThrow(/UNIQUE constraint failed/);
      // A superseded row with the same title is allowed (partial index exempts it).
      await db.executeSql(
        `INSERT INTO canon_world_rules (project_id,source_id,snapshot_id,analysis_run_id,valid_from_position,first_observed_position,last_observed_position,confidence,review_status,origin,extraction_version,revision,created_at,updated_at,category,title,description,constraint_level) VALUES (1,1,'snap-1','run-1',0,0,0,0.9,'superseded','ai','v1',1,'t','t','other','鐏垫皵澶嶈嫃','鐏垫皵澶嶈嫃','reference')`,
      );
      // A different title succeeds.
      await expect(insertRule('鍙︿竴瑙勫垯')).resolves.toBeDefined();
      void base;
    } finally {
      db.close();
    }
  });

  it('direct logic migration repairs both and partial provenance-column states idempotently', async () => {
    const db = await createCanonInMemoryDb();
    try {
      await dropProvenanceColumns(db);
      await migrateV32ToV33(db as any);
      expect(await columnExists(db, 'canon_evidence', 'source_origin')).toBe(true);
      expect(await columnExists(db, 'canon_evidence', 'rescan_operation_id')).toBe(true);
      expect(await indexExists(db, 'idx_canon_evidence_rescan_op')).toBe(true);

      await dropSourceOriginOnly(db);
      await migrateV32ToV33(db as any);
      expect(await columnExists(db, 'canon_evidence', 'source_origin')).toBe(true);

      await dropRescanOpOnly(db);
      await migrateV32ToV33(db as any);
      await migrateV32ToV33(db as any);
      expect(await columnExists(db, 'canon_evidence', 'rescan_operation_id')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('rebinds duplicate evidence links to the newest keeper before deleting old facts', async () => {
    const db = await createCanonInMemoryDb();
    try {
      await seedCanonicalData(db);
      await db.executeSql(
        `INSERT INTO continuation_sources
          (id, project_id, version, status, display_name, original_file_name,
           detected_encoding, raw_sha256, normalized_sha256,
           normalized_char_count, normalized_byte_count, file_size_bytes,
           parser_version, normalization_version, created_at, updated_at)
         VALUES (1, 1, 1, 'ready', 's', 's.txt', 'UTF-8', 'raw', 'norm',
                 1000, 2000, 2000, 'v1', 'v1', 't', 't')`,
      );
      await db.executeSql(
        `INSERT INTO continuation_source_chapters
          (id, source_id, position, detected_title, title, content_sha256,
           char_count, paragraph_count, source_start_offset,
           content_start_offset, source_end_offset, created_at, updated_at)
         VALUES (1, 1, 0, 'c', 'c', 'sha', 1000, 1, 0, 0, 1000, 't', 't')`,
      );
      await db.executeSql(
        `INSERT INTO continuation_canon_snapshots
          (id, project_id, source_id, analysis_run_id, source_version,
           source_sha256, parser_version, normalization_version,
           boundary_chapter_id, boundary_position, boundary_char_offset_exclusive,
           extraction_version, profile, status, revision, capabilities_json,
           coverage_json, created_at, updated_at)
         VALUES ('snap-1', 1, 1, 'run-1', 1, 'norm', 'v1', 'v1', 1, 0, 1000,
                 'v1', 'standard', 'staging', 1, '{}', '{}', 't', 't')`,
      );
      await db.executeSql(
        `INSERT INTO continuation_analysis_runs
          (id, project_id, source_id, source_version, source_sha256,
           parser_version, normalization_version, boundary_chapter_id,
           boundary_position, boundary_char_offset_exclusive, canon_snapshot_id,
           profile, state, stage, extraction_version, created_at, updated_at)
         VALUES ('run-1', 1, 1, 1, 'norm', 'v1', 'v1', 1, 0, 1000, 'snap-1',
                 'standard', 'running', 'chapter_extraction', 'v1', 't', 't')`,
      );
      await db.executeSql(
        `DROP INDEX IF EXISTS idx_canon_world_rules_business`,
      );
      const insertRule = (id: number) =>
        db.executeSql(
          `INSERT INTO canon_world_rules
            (id, project_id, source_id, snapshot_id, analysis_run_id,
             valid_from_position, first_observed_position, last_observed_position,
             confidence, review_status, origin, extraction_version, revision,
             created_at, updated_at, category, title, description, constraint_level)
           VALUES (?, 1, 1, 'snap-1', 'run-1', 0, 0, 0, 0.9, 'pending',
                   'ai', 'v1', 1, 't', 't', 'other', '同一规则', '描述',
                   'reference')`,
          [id],
        );
      await insertRule(1);
      await insertRule(2);
      await db.executeSql(
        `INSERT INTO canon_evidence
          (id, project_id, source_id, snapshot_id, chapter_id,
           chapter_position, paragraph_start, paragraph_end, char_start, char_end,
           quote_preview, quote_sha256, analysis_run_id, source_origin,
           created_at)
         VALUES (1, 1, 1, 'snap-1', 1, 0, 0, 1, 0, 100, 'preview', 'sha',
                 'run-1', 'batch', 't')`,
      );
      await db.executeSql(
        `INSERT INTO canon_evidence_links
          (evidence_id, snapshot_id, owner_type, owner_id, created_at)
         VALUES (1, 'snap-1', 'world_rule', 1, 't'),
                (1, 'snap-1', 'world_rule', 2, 't')`,
      );

      await migrateV32ToV33(db as any);

      const [facts] = await db.executeSql(
        `SELECT id FROM canon_world_rules
          WHERE snapshot_id = 'snap-1' AND title = '同一规则'`,
      );
      expect(facts.rows.length).toBe(1);
      expect(facts.rows.item(0).id).toBe(2);
      const [links] = await db.executeSql(
        `SELECT owner_id, COUNT(*) AS count
           FROM canon_evidence_links
          WHERE evidence_id = 1 AND owner_type = 'world_rule'
          GROUP BY owner_id`,
      );
      expect(links.rows.length).toBe(1);
      expect(links.rows.item(0)).toMatchObject({ owner_id: 2, count: 1 });

      await migrateV32ToV33(db as any);
      const [stableFacts] = await db.executeSql(
        `SELECT COUNT(*) AS count FROM canon_world_rules
          WHERE snapshot_id = 'snap-1' AND title = '同一规则'`,
      );
      expect(stableFacts.rows.item(0).count).toBe(1);
    } finally {
      db.close();
    }
  });
});
