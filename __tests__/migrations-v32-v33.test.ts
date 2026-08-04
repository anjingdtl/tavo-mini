/**
 * Schema 32 鈫?33 migration: Canon fact business-key UNIQUE indexes + evidence
 * provenance columns.
 */
import { buildV32toV33Statements, buildSchema33CreateSqls } from '../src/services/migrations/v32-to-v33';
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import { SCHEMA_VERSION } from '../src/services/migrations';

describe('Schema 32 鈫?33 Canon dedup infrastructure', () => {
  it('is superseded by a later current SCHEMA_VERSION', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(33);
  });

  it('emits provenance columns + rebind-then-dedup + 6 indexes', () => {
    const statements = buildV32toV33Statements();
    const sqls = statements.map(s => s.sql);
    expect(sqls.filter(s => /ADD COLUMN source_origin/.test(s))).toHaveLength(1);
    expect(sqls.filter(s => /ADD COLUMN rescan_operation_id/.test(s))).toHaveLength(1);
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
});
