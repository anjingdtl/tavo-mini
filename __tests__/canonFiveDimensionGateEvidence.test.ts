/**
 * Bug #2 part 2 / extra-check #4: the five-dimension gate must count only facts
 * that have at least one valid evidence link, not raw row counts.
 *
 * Previously `countValidCanonRowsForGate` did `SELECT COUNT(*) FROM <table>
 * WHERE snapshot_id AND run_id AND review_status NOT IN (...)` — no evidence
 * join. A fact row could exist with zero evidence (orphan) and still be
 * counted, letting the gate pass on data that has no verifiable backing.
 */
import {
  countValidCanonRowsForGate,
  evaluateFiveDimensionGate,
} from '../src/services/continuation/canon/canonFiveDimensionGate';
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import {
  seedCanonBaseline,
  seedAnalysisRun,
  seedCanonFactWithEvidence,
} from './helpers/canonEvidenceTestFixtures';

async function insertOrphanWorldRule(
  db: Awaited<ReturnType<typeof createCanonInMemoryDb>>,
  base: { projectId: number; sourceId: number; snapshotId: string; runId: string },
  title: string,
): Promise<number> {
  const [res] = await db.executeSql(
    `INSERT INTO canon_world_rules
      (project_id, source_id, snapshot_id, analysis_run_id,
       valid_from_position, first_observed_position, last_observed_position,
       confidence, review_status, origin, extraction_version, revision,
       created_at, updated_at, category, title, description, constraint_level)
     VALUES (?, ?, ?, ?, 0, 0, 0, 0.9, 'pending', 'ai', 'v1', 1, 't', 't',
       'other', ?, ?, 'reference')`,
    [base.projectId, base.sourceId, base.snapshotId, base.runId, title, title],
  );
  return res.insertId!;
}

describe('Bug #2 part 2: five-dimension gate counts only facts WITH evidence', () => {
  it('counts a fact that has a valid evidence link', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const base = await seedCanonBaseline(db);
      await seedAnalysisRun(db, base);
      await seedCanonFactWithEvidence(db, {
        projectId: base.projectId,
        sourceId: base.sourceId,
        snapshotId: base.snapshotId,
        runId: base.runId,
        chapterId: base.chapterId,
        boundaryExclusive: base.boundaryExclusive,
        table: 'canon_world_rules',
        title: '有证据的规则',
        charStart: 0,
        charEnd: 4,
        quotePreview: '原文片段',
      });
      const counts = await countValidCanonRowsForGate(
        db as any,
        base.snapshotId,
        base.runId,
      );
      expect(counts.worldRules).toBe(1);
    } finally {
      db.close();
    }
  });

  it('does NOT count a fact that has no evidence link (orphan)', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const base = await seedCanonBaseline(db);
      await seedAnalysisRun(db, base);
      // Insert a world_rule WITHOUT any evidence link.
      await insertOrphanWorldRule(db, base, '无证据的规则');
      const counts = await countValidCanonRowsForGate(
        db as any,
        base.snapshotId,
        base.runId,
      );
      expect(counts.worldRules).toBe(0);
    } finally {
      db.close();
    }
  });

  it('mixes: 2 with evidence + 1 orphan → counts only 2', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const base = await seedCanonBaseline(db);
      await seedAnalysisRun(db, base);
      await seedCanonFactWithEvidence(db, {
        projectId: base.projectId,
        sourceId: base.sourceId,
        snapshotId: base.snapshotId,
        runId: base.runId,
        chapterId: base.chapterId,
        boundaryExclusive: base.boundaryExclusive,
        table: 'canon_world_rules',
        title: '规则A',
        charStart: 0,
        charEnd: 2,
        quotePreview: '原文',
      });
      await seedCanonFactWithEvidence(db, {
        projectId: base.projectId,
        sourceId: base.sourceId,
        snapshotId: base.snapshotId,
        runId: base.runId,
        chapterId: base.chapterId,
        boundaryExclusive: base.boundaryExclusive,
        table: 'canon_world_rules',
        title: '规则B',
        charStart: 2,
        charEnd: 4,
        quotePreview: '片段',
      });
      await insertOrphanWorldRule(db, base, '规则C-无证据');
      const counts = await countValidCanonRowsForGate(
        db as any,
        base.snapshotId,
        base.runId,
      );
      expect(counts.worldRules).toBe(2);
    } finally {
      db.close();
    }
  });

  it('gate does not pass when all 3 world_rules are orphans (no evidence)', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const base = await seedCanonBaseline(db);
      await seedAnalysisRun(db, base);
      await insertOrphanWorldRule(db, base, '孤儿1');
      await insertOrphanWorldRule(db, base, '孤儿2');
      await insertOrphanWorldRule(db, base, '孤儿3');
      const counts = await countValidCanonRowsForGate(
        db as any,
        base.snapshotId,
        base.runId,
      );
      const gate = evaluateFiveDimensionGate(counts);
      expect(counts.worldRules).toBe(0);
      expect(gate.passed).toBe(false);
      expect(gate.missingDimensions).toContain('worldRules');
    } finally {
      db.close();
    }
  });

  it('does not count evidence whose owner_type does not match the fact table', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const base = await seedCanonBaseline(db);
      await seedAnalysisRun(db, base);
      // A world_rule fact...
      const factId = await insertOrphanWorldRule(db, base, '错配规则');
      // ...with an evidence link whose owner_type is 'character' (wrong table).
      const [evRes] = await db.executeSql(
        `INSERT INTO canon_evidence
          (project_id, source_id, snapshot_id, chapter_id, chapter_position,
           char_start, char_end, quote_preview, quote_sha256, analysis_run_id,
           source_origin, created_at)
         VALUES (?, ?, ?, ?, 0, 0, 4, '原文', 'sha', ?, 'batch', 't')`,
        [base.projectId, base.sourceId, base.snapshotId, base.chapterId, base.runId],
      );
      await db.executeSql(
        `INSERT INTO canon_evidence_links (evidence_id, snapshot_id, owner_type, owner_id, created_at)
         VALUES (?, ?, 'character', ?, 't')`,
        [evRes.insertId, base.snapshotId, factId],
      );
      const counts = await countValidCanonRowsForGate(
        db as any,
        base.snapshotId,
        base.runId,
      );
      // owner_type mismatch → not counted for worldRules.
      expect(counts.worldRules).toBe(0);
    } finally {
      db.close();
    }
  });
});
