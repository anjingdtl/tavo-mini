/**
 * Schema 34 → 35: partial batch state + segment columns + evidence rebind cleanup.
 */
import {
  buildV34toV35Statements,
  buildAnalysisBatchesCreateSqlV35,
  buildSchema35CreateSqls,
} from '../src/services/migrations/v34-to-v35';
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import { SCHEMA_VERSION } from '../src/services/migrations';

describe('Schema 34 → 35 Canon batch reliability', () => {
  it('reports SCHEMA_VERSION as 35', () => {
    expect(SCHEMA_VERSION).toBe(35);
  });

  it('emits batches rebuild with partial + segment columns', () => {
    const sqls = buildV34toV35Statements().map(s => s.sql);
    expect(
      sqls.some(s => /RENAME TO continuation_analysis_batches_v34/.test(s)),
    ).toBe(true);
    expect(
      sqls.some(s => /state IN \('queued', 'running', 'partial'/.test(s)),
    ).toBe(true);
    expect(sqls.some(s => /parent_batch_index/.test(s))).toBe(true);
    expect(sqls.some(s => /source_char_start/.test(s))).toBe(true);
    expect(sqls.some(s => /coverage_kind/.test(s))).toBe(true);
    expect(sqls.some(s => /had_partial_coverage/.test(s))).toBe(true);
  });

  it('fresh-install DDL allows partial and segment fields', () => {
    const ddl = buildAnalysisBatchesCreateSqlV35();
    expect(ddl).toContain("'partial'");
    expect(ddl).toContain('parent_batch_index');
    expect(ddl).toContain('source_char_start');
    expect(ddl).toContain('coverage_kind');
    expect(buildSchema35CreateSqls().length).toBeGreaterThanOrEqual(3);
  });

  it('accepts state=partial on a real in-memory schema', async () => {
    const db = await createCanonInMemoryDb();
    try {
      await db.executeSql(
        `INSERT INTO projects (id,name,mode,created_at,updated_at) VALUES (1,'t','continuation','t','t')`,
      );
      await db.executeSql(
        `INSERT INTO continuation_sources (id,project_id,version,status,display_name,original_file_name,detected_encoding,raw_sha256,normalized_sha256,normalized_char_count,normalized_byte_count,file_size_bytes,parser_version,normalization_version,created_at,updated_at) VALUES (1,1,1,'ready','s','s.txt','UTF-8','x','y',1000,2000,2000,'v1','v1','t','t')`,
      );
      await db.executeSql(
        `INSERT INTO continuation_source_chapters (id,source_id,position,detected_title,title,content_sha256,char_count,paragraph_count,source_start_offset,content_start_offset,source_end_offset,created_at,updated_at) VALUES (1,1,0,'c','c','c',1000,1,0,0,1000,'t','t')`,
      );
      await db.executeSql(
        `INSERT INTO continuation_canon_snapshots (id,project_id,source_id,analysis_run_id,source_version,source_sha256,parser_version,normalization_version,boundary_chapter_id,boundary_position,boundary_char_offset_exclusive,extraction_version,profile,status,revision,capabilities_json,coverage_json,created_at,updated_at) VALUES ('snap-1',1,1,'run-1',1,'y','v1','v1',1,0,1000,'v1','standard','staging',1,'{}','{}','t','t')`,
      );
      await db.executeSql(
        `INSERT INTO continuation_analysis_runs (id,project_id,source_id,source_version,source_sha256,parser_version,normalization_version,boundary_chapter_id,boundary_position,boundary_char_offset_exclusive,canon_snapshot_id,profile,state,stage,extraction_version,created_at,updated_at) VALUES ('run-1',1,1,1,'y','v1','v1',1,0,1000,'snap-1','standard','running','chapter_extraction','v1','t','t')`,
      );
      await expect(
        db.executeSql(
          `INSERT INTO continuation_analysis_batches (
            run_id, canon_snapshot_id, batch_index, start_position, end_position,
            input_hash, idempotency_key, state, attempt_count,
            parent_batch_index, material_type, chapter_id,
            source_char_start, source_char_end, coverage_kind, had_partial_coverage,
            created_at, updated_at
          ) VALUES (
            'run-1','snap-1',0,0,1,'h','k','partial',1,
            NULL,'character_state',1,100,500,'retry_tail',1,'t','t'
          )`,
        ),
      ).resolves.toBeDefined();
      const [res] = await db.executeSql(
        `SELECT state, coverage_kind, source_char_start, source_char_end
          FROM continuation_analysis_batches WHERE run_id='run-1'`,
      );
      expect(res.rows.item(0).state).toBe('partial');
      expect(res.rows.item(0).coverage_kind).toBe('retry_tail');
      expect(res.rows.item(0).source_char_start).toBe(100);
      expect(res.rows.item(0).source_char_end).toBe(500);
    } finally {
      db.close();
    }
  });
});
