/**
 * Rescan cleanup must freeze evidence IDs, delete links, then delete evidence —
 * leaving zero orphans for the operation, without touching batch evidence.
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import { materializeRescanResult } from '../src/services/continuation/canon/canonAnalysisService';
import type { ChapterExtractionResult } from '../src/services/continuation/canon/canonJsonValidators';
import {
  asSourcePosition,
  asUtf16Offset,
} from '../src/services/continuation/continuationSourceRepository';

async function seed(db: any) {
  await db.executeSql(
    `INSERT INTO projects (id,name,mode,created_at,updated_at) VALUES (1,'t','continuation','t','t')`,
  );
  await db.executeSql(
    `INSERT INTO continuation_sources (id,project_id,version,status,display_name,original_file_name,detected_encoding,raw_sha256,normalized_sha256,normalized_char_count,normalized_byte_count,file_size_bytes,parser_version,normalization_version,created_at,updated_at) VALUES (1,1,1,'ready','s','s.txt','UTF-8','x','y',1000,2000,2000,'v1','v1','t','t')`,
  );
  await db.executeSql(
    `INSERT INTO continuation_source_chapters (id,source_id,position,detected_title,title,content_sha256,char_count,paragraph_count,source_start_offset,content_start_offset,source_end_offset,created_at,updated_at) VALUES (1,1,0,'c','灵气复苏开始了','c',1000,1,0,0,1000,'t','t')`,
  );
  await db.executeSql(
    `INSERT INTO continuation_canon_snapshots (id,project_id,source_id,analysis_run_id,source_version,source_sha256,parser_version,normalization_version,boundary_chapter_id,boundary_position,boundary_char_offset_exclusive,extraction_version,profile,status,revision,capabilities_json,coverage_json,created_at,updated_at) VALUES ('snap-1',1,1,'run-1',1,'y','v1','v1',1,0,1000,'v1','standard','staging',1,'{}','{}','t','t')`,
  );
  await db.executeSql(
    `INSERT INTO continuation_analysis_runs (id,project_id,source_id,source_version,source_sha256,parser_version,normalization_version,boundary_chapter_id,boundary_position,boundary_char_offset_exclusive,canon_snapshot_id,profile,state,stage,extraction_version,created_at,updated_at) VALUES ('run-1',1,1,1,'y','v1','v1',1,0,1000,'snap-1','standard','running','chapter_extraction','v1','t','t')`,
  );
}

const emptyResult = (): ChapterExtractionResult => ({
  schemaVersion: 1,
  worldRules: [],
  characters: [],
  relationships: [],
  plotThreads: [],
  experiences: [],
  knowledge: [],
  states: [],
  timelineEvents: [],
});

describe('rescan evidence cleanup isolation', () => {
  it('re-running the same rescan operation leaves zero orphan evidence', async () => {
    const db = await createCanonInMemoryDb();
    try {
      await seed(db);
      const quote = '灵气复苏';
      // Seed a batch evidence row that must survive rescan cleanup.
      await db.executeSql(
        `INSERT INTO canon_evidence (
          project_id, source_id, snapshot_id, chapter_id, chapter_position,
          char_start, char_end, quote_preview, quote_sha256, analysis_run_id,
          source_origin, rescan_operation_id, created_at
        ) VALUES (1,1,'snap-1',1,0,0,4,?,?,?,'batch',NULL,'t')`,
        [quote, 'sha-batch', 'run-1'],
      );
      const [batchEv] = await db.executeSql(
        `SELECT id FROM canon_evidence WHERE source_origin='batch'`,
      );
      const batchEvId = batchEv.rows.item(0).id;
      await db.executeSql(
        `INSERT INTO canon_evidence_links (evidence_id, snapshot_id, owner_type, owner_id, created_at)
          VALUES (?,'snap-1','world_rule',999,'t')`,
        [batchEvId],
      );

      const chapters = [
        {
          id: 1,
          sourceId: 1,
          position: asSourcePosition(0),
          title: 'c',
          content: '灵气复苏开始了',
          range: { start: asUtf16Offset(0), end: asUtf16Offset(7) },
          clippedByBoundary: false,
        },
      ];

      const result: ChapterExtractionResult = {
        ...emptyResult(),
        worldRules: [
          {
            category: 'fundamental',
            title: '灵气复苏',
            description: '规则',
            constraintLevel: 'hard',
            confidence: 0.9,
            evidence: [
              {
                chapterId: 1,
                chapterPosition: 0,
                charStart: 0,
                charEnd: quote.length,
                quotePreview: quote,
              },
            ],
          },
        ],
      };

      const opId = 'run-1:rescan:r1:world_plot:s1';
      const ctx = {
        projectId: 1,
        sourceId: 1,
        snapshotId: 'snap-1',
        runId: 'run-1',
        boundaryExclusive: 1000,
        profile: 'standard' as const,
        requestGroup: 'world_plot' as const,
        rescanOperationId: opId,
        readBackVerifier: async () => quote,
      };

      await materializeRescanResult(db as any, ctx, result, chapters as any);
      await materializeRescanResult(db as any, ctx, result, chapters as any);

      const [orphans] = await db.executeSql(
        `SELECT COUNT(*) AS c FROM canon_evidence e
          WHERE e.source_origin='rescan' AND e.rescan_operation_id=?
            AND NOT EXISTS (SELECT 1 FROM canon_evidence_links l WHERE l.evidence_id=e.id)`,
        [opId],
      );
      expect(orphans.rows.item(0).c).toBe(0);

      const [batchStill] = await db.executeSql(
        `SELECT COUNT(*) AS c FROM canon_evidence WHERE id=? AND source_origin='batch'`,
        [batchEvId],
      );
      expect(batchStill.rows.item(0).c).toBe(1);
    } finally {
      db.close();
    }
  });
});
