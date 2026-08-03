/**
 * Bug #2: targeted rescan must not delete other categories' evidence.
 *
 * The original `materializeBatchResult` opened with an unconditional
 * `DELETE FROM canon_evidence WHERE chapter_position BETWEEN fromPos AND pos`,
 * scoped only by snapshot + run + position. A targeted rescan covers a wide
 * chapter range, so re-running it for one request group (e.g. character_state)
 * wiped the evidence of every other group (e.g. world_plot) in that range.
 *
 * This test seeds two categories of facts + evidence, then runs a rescan-style
 * materialization scoped to ONLY one owner type, and asserts the other
 * category's facts, evidence and evidence_links are untouched.
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import {
  seedCanonBaseline,
  seedAnalysisRun,
  seedCanonFactWithEvidence,
  seedSourceTextChunk,
  type CanonBaselineSeed,
} from './helpers/canonEvidenceTestFixtures';
import { materializeRescanResult } from '../src/services/continuation/canon/canonAnalysisService';
import {
  asSourcePosition,
  asUtf16Offset,
} from '../src/services/continuation/continuationSourceRepository';
import type { BoundedSourceChapter } from '../src/services/continuation/types';
import type { ChapterExtractionResult } from '../src/services/continuation/canon/canonJsonValidators';

function countAll(db: Awaited<ReturnType<typeof createCanonInMemoryDb>>, table: string, where: string, params: any[]) {
  return db.executeSql(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`, params).then(r => r[0].rows.item(0).c as number);
}

async function snapshotCounts(db: Awaited<ReturnType<typeof createCanonInMemoryDb>>, base: CanonBaselineSeed) {
  return {
    worldRules: await countAll(db, 'canon_world_rules', 'snapshot_id=? AND analysis_run_id=?', [base.snapshotId, base.runId]),
    worldRuleEvidence: await countAll(db, 'canon_evidence', 'snapshot_id=? AND analysis_run_id=?', [base.snapshotId, base.runId]),
    worldRuleLinks: await countAll(db, 'canon_evidence_links', 'snapshot_id=?', [base.snapshotId]),
  };
}

describe('Bug #2: targeted rescan does not delete other categories evidence', () => {
  it('rescanning character_state leaves world_plot facts/evidence/links intact', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const base = await seedCanonBaseline(db, { boundaryExclusive: 5000 });
      await seedAnalysisRun(db, base);
      await seedSourceTextChunk(db, base.sourceId, 0, 0, 'A'.repeat(50) + '灵气复苏原文片段' + 'B'.repeat(30));

      // Seed a world_plot fact + evidence (must survive a character_state rescan).
      await seedCanonFactWithEvidence(db, {
        projectId: base.projectId,
        sourceId: base.sourceId,
        snapshotId: base.snapshotId,
        runId: base.runId,
        chapterId: base.chapterId,
        boundaryExclusive: base.boundaryExclusive,
        table: 'canon_world_rules',
        title: '灵气复苏',
        charStart: 50,
        charEnd: 58,
        quotePreview: '灵气复苏原文片段',
      });
      const before = await snapshotCounts(db, base);
      expect(before.worldRules).toBe(1);
      expect(before.worldRuleEvidence).toBe(1);
      expect(before.worldRuleLinks).toBe(1);

      // A rescan scoped to character_state that produces a NEW character.
      const chapters: BoundedSourceChapter[] = [
        {
          id: base.chapterId,
          sourceId: base.sourceId,
          position: asSourcePosition(0),
          title: '第一章',
          content: 'A'.repeat(50) + '林凡在此修炼' + 'B'.repeat(30),
          range: { start: asUtf16Offset(0), end: asUtf16Offset(100) },
          clippedByBoundary: false,
        },
      ];
      const rescanResult: ChapterExtractionResult = {
        schemaVersion: 1,
        worldRules: [],
        characters: [
          {
            canonicalName: '林凡',
            aliases: [],
            description: '主角',
            importance: 'primary',
            confidence: 0.9,
            evidence: [
              {
                chapterId: base.chapterId,
                chapterPosition: 0,
                charStart: 50,
                charEnd: 56,
                quotePreview: '林凡在此修炼',
              },
            ],
          },
        ],
        relationships: [],
        plotThreads: [],
        experiences: [],
        knowledge: [],
        states: [],
        timelineEvents: [],
      };

      await materializeRescanResult(
        db as unknown as Parameters<typeof materializeRescanResult>[0],
        {
          projectId: base.projectId,
          sourceId: base.sourceId,
          snapshotId: base.snapshotId,
          runId: base.runId,
          boundaryExclusive: base.boundaryExclusive,
          profile: 'standard',
          requestGroup: 'character_state',
          rescanOperationId: 'rescan-op-1',
          readBackVerifier: async (cs, ce) => readChunk(db, base.sourceId, cs, ce),
        },
        rescanResult,
        chapters,
      );

      const after = await snapshotCounts(db, base);
      // world_plot untouched.
      expect(after.worldRules).toBe(1);
      expect(after.worldRuleEvidence).toBe(1);
      expect(after.worldRuleLinks).toBe(1);
      // The new character was added.
      const [charRes] = await db.executeSql(
        `SELECT COUNT(*) AS c FROM canon_characters WHERE snapshot_id=? AND analysis_run_id=? AND canonical_name=?`,
        [base.snapshotId, base.runId, '林凡'],
      );
      expect(charRes.rows.item(0).c).toBe(1);
    } finally {
      db.close();
    }
  });

  it('a fact with no evidence link is not counted by the evidence-aware query', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const base = await seedCanonBaseline(db, { boundaryExclusive: 5000 });
      await seedAnalysisRun(db, base);
      // Insert a world_rule fact WITHOUT any evidence link.
      await db.executeSql(
        `INSERT INTO canon_world_rules
          (project_id, source_id, snapshot_id, analysis_run_id,
           valid_from_position, first_observed_position, last_observed_position,
           confidence, review_status, origin, extraction_version, revision,
           created_at, updated_at, category, title, description, constraint_level)
         VALUES (?, ?, ?, ?, 0, 0, 0, 0.9, 'pending', 'ai', 'v1', 1, 't', 't',
           'other', '无证据规则', '无证据规则', 'reference')`,
        [base.projectId, base.sourceId, base.snapshotId, base.runId],
      );
      // Evidence-aware count must be 0 for this orphan fact.
      const [res] = await db.executeSql(
        `SELECT COUNT(*) AS c FROM canon_world_rules wr
          WHERE wr.snapshot_id = ? AND wr.analysis_run_id = ?
            AND wr.review_status NOT IN ('superseded', 'ignored')
            AND EXISTS (
              SELECT 1 FROM canon_evidence_links l
              JOIN canon_evidence e ON e.id = l.evidence_id
              WHERE l.owner_type = 'world_rule' AND l.owner_id = wr.id
                AND e.snapshot_id = wr.snapshot_id
                AND e.analysis_run_id = wr.analysis_run_id
            )`,
        [base.snapshotId, base.runId],
      );
      expect(res.rows.item(0).c).toBe(0);
    } finally {
      db.close();
    }
  });
});

async function readChunk(
  db: Awaited<ReturnType<typeof createCanonInMemoryDb>>,
  sourceId: number,
  start: number,
  end: number,
): Promise<string> {
  const [res] = await db.executeSql(
    `SELECT content, char_start_offset AS cso FROM continuation_source_text_chunks
       WHERE source_id = ? AND char_start_offset <= ? AND char_end_offset >= ?
       ORDER BY char_start_offset`,
    [sourceId, start, start],
  );
  if (res.rows.length === 0) return '';
  const row = res.rows.item(0);
  const content = row.content as string;
  const cso = row.cso as number;
  return content.slice(Math.max(0, start - cso), Math.min(content.length, end - cso));
}
