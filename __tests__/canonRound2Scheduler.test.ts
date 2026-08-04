/**
 * Round-2 scheduler / sub-batch persistence contracts.
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import {
  insertBatches,
  insertWorkItems,
  findNextQueuedBatch,
  insertSubBatchIfAbsent,
  allocateNextBatchIndex,
  mapBatch,
} from '../src/services/continuation/canon/canonRepository';

async function seedRun(db: any) {
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
}

describe('Canon round-2 scheduler persistence', () => {
  it('findNextQueuedBatch is DB-driven and sees newly inserted sub-batches', async () => {
    const db = await createCanonInMemoryDb();
    try {
      await seedRun(db);
      await insertBatches(db as any, [
        {
          runId: 'run-1',
          canonSnapshotId: 'snap-1',
          batchIndex: 0,
          startPosition: 0,
          endPosition: 1,
          inputHash: 'h0',
          idempotencyKey: 'run-1:0',
        },
      ]);
      // Mark parent running so next queued is empty until sub-batch arrives.
      await db.executeSql(
        `UPDATE continuation_analysis_batches SET state='running' WHERE batch_index=0`,
      );
      expect(await findNextQueuedBatch(db as any, 'run-1')).toBeNull();

      const next = await allocateNextBatchIndex(db as any, 'run-1');
      await insertSubBatchIfAbsent(db as any, {
        runId: 'run-1',
        canonSnapshotId: 'snap-1',
        batchIndex: next,
        startPosition: 0,
        endPosition: 1,
        inputHash: 'h1',
        idempotencyKey: 'run-1:0:character_state:1:100:500:retry_tail',
        parentBatchIndex: 0,
        materialType: 'character_state',
        chapterId: 1,
        sourceCharStart: 100,
        sourceCharEnd: 500,
        coverageKind: 'retry_tail',
      });
      const found = await findNextQueuedBatch(db as any, 'run-1');
      expect(found).not.toBeNull();
      expect(found!.batchIndex).toBe(next);
      expect(found!.sourceCharStart).toBe(100);
      expect(found!.sourceCharEnd).toBe(500);
      expect(found!.materialType).toBe('character_state');
      expect(found!.parentBatchIndex).toBe(0);
    } finally {
      db.close();
    }
  });

  it('two simultaneous partial routes create two independent sub-batches', async () => {
    const db = await createCanonInMemoryDb();
    try {
      await seedRun(db);
      await insertBatches(db as any, [
        {
          runId: 'run-1',
          canonSnapshotId: 'snap-1',
          batchIndex: 0,
          startPosition: 0,
          endPosition: 1,
          inputHash: 'h0',
          idempotencyKey: 'run-1:0',
        },
      ]);
      for (const materialType of ['character_state', 'world_plot'] as const) {
        const next = await allocateNextBatchIndex(db as any, 'run-1');
        await insertSubBatchIfAbsent(db as any, {
          runId: 'run-1',
          canonSnapshotId: 'snap-1',
          batchIndex: next,
          startPosition: 0,
          endPosition: 1,
          inputHash: `h-${materialType}`,
          idempotencyKey: `run-1:0:${materialType}:1:200:800:retry_tail`,
          parentBatchIndex: 0,
          materialType,
          chapterId: 1,
          sourceCharStart: 200,
          sourceCharEnd: 800,
          coverageKind: 'retry_tail',
        });
        await insertWorkItems(db as any, [
          { runId: 'run-1', batchIndex: next, materialType },
        ]);
      }
      const [rows] = await db.executeSql(
        `SELECT material_type, source_char_start, source_char_end, parent_batch_index
          FROM continuation_analysis_batches
          WHERE parent_batch_index = 0
          ORDER BY material_type`,
      );
      expect(rows.rows.length).toBe(2);
      expect(rows.rows.item(0).material_type).toBe('character_state');
      expect(rows.rows.item(1).material_type).toBe('world_plot');
      expect(rows.rows.item(0).source_char_start).toBe(200);
      expect(rows.rows.item(1).source_char_end).toBe(800);
    } finally {
      db.close();
    }
  });

  it('sub-batch insert is idempotent on the same idempotency key', async () => {
    const db = await createCanonInMemoryDb();
    try {
      await seedRun(db);
      const key = 'run-1:0:world_plot:1:10:20:retry_tail';
      const a = await insertSubBatchIfAbsent(db as any, {
        runId: 'run-1',
        canonSnapshotId: 'snap-1',
        batchIndex: 1,
        startPosition: 0,
        endPosition: 1,
        inputHash: 'h',
        idempotencyKey: key,
        parentBatchIndex: 0,
        materialType: 'world_plot',
        chapterId: 1,
        sourceCharStart: 10,
        sourceCharEnd: 20,
        coverageKind: 'retry_tail',
      });
      expect(a.inserted).toBe(true);
      const b = await insertSubBatchIfAbsent(db as any, {
        runId: 'run-1',
        canonSnapshotId: 'snap-1',
        batchIndex: 99,
        startPosition: 0,
        endPosition: 1,
        inputHash: 'h2',
        idempotencyKey: key,
        parentBatchIndex: 0,
        materialType: 'world_plot',
        chapterId: 1,
        sourceCharStart: 10,
        sourceCharEnd: 20,
        coverageKind: 'retry_tail',
      });
      expect(b.inserted).toBe(false);
      expect(b.batchIndex).toBe(1);
      const [count] = await db.executeSql(
        `SELECT COUNT(*) AS c FROM continuation_analysis_batches WHERE run_id='run-1'`,
      );
      expect(count.rows.item(0).c).toBe(1);
    } finally {
      db.close();
    }
  });

  it('mapBatch reads Schema 34 segment fields', async () => {
    const db = await createCanonInMemoryDb();
    try {
      await seedRun(db);
      await db.executeSql(
        `INSERT INTO continuation_analysis_batches (
          run_id, canon_snapshot_id, batch_index, start_position, end_position,
          input_hash, idempotency_key, state, attempt_count,
          parent_batch_index, material_type, chapter_id,
          source_char_start, source_char_end, coverage_kind, had_partial_coverage,
          created_at, updated_at
        ) VALUES (
          'run-1','snap-1',3,0,1,'h','k3','queued',0,
          1,'world_plot',1,50,90,'rescan',0,'t','t'
        )`,
      );
      const [res] = await db.executeSql(
        `SELECT * FROM continuation_analysis_batches WHERE batch_index=3`,
      );
      const batch = mapBatch(res.rows.item(0));
      expect(batch.parentBatchIndex).toBe(1);
      expect(batch.materialType).toBe('world_plot');
      expect(batch.chapterId).toBe(1);
      expect(batch.sourceCharStart).toBe(50);
      expect(batch.sourceCharEnd).toBe(90);
      expect(batch.coverageKind).toBe('rescan');
      expect(batch.hadPartialCoverage).toBe(false);
    } finally {
      db.close();
    }
  });
});
