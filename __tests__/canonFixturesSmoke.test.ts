/**
 * Smoke test for the canonEvidenceTestFixtures helpers: seedCanonBaseline +
 * seedSourceTextChunk + seedCanonFactWithEvidence.
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import {
  seedCanonBaseline,
  seedSourceTextChunk,
  seedAnalysisRun,
  seedCanonFactWithEvidence,
} from './helpers/canonEvidenceTestFixtures';

describe('canonEvidenceTestFixtures smoke', () => {
  it('seeds baseline + chunk + fact-with-evidence and reads back', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const base = await seedCanonBaseline(db, { boundaryExclusive: 5000 });
      await seedAnalysisRun(db, base);
      await seedSourceTextChunk(db, base.sourceId, 0, 0, '林凡在青云镇拜师。');
      const { factId, evidenceId } = await seedCanonFactWithEvidence(db, {
        projectId: base.projectId,
        sourceId: base.sourceId,
        snapshotId: base.snapshotId,
        runId: base.runId,
        chapterId: base.chapterId,
        boundaryExclusive: base.boundaryExclusive,
        table: 'canon_world_rules',
        title: '灵气复苏',
        charStart: 100,
        charEnd: 110,
        quotePreview: '灵气复苏',
      });
      expect(factId).toBeGreaterThan(0);
      expect(evidenceId).toBeGreaterThan(0);

      const [factRow] = await db.executeSql(
        'SELECT title FROM canon_world_rules WHERE id = ?',
        [factId],
      );
      expect(factRow.rows.item(0).title).toBe('灵气复苏');

      const [linkRow] = await db.executeSql(
        `SELECT owner_type AS ot FROM canon_evidence_links WHERE evidence_id = ?`,
        [evidenceId],
      );
      expect(linkRow.rows.item(0).ot).toBe('world_rule');
    } finally {
      db.close();
    }
  });
});
