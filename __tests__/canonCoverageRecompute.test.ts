/**
 * Bug #5: coverage / capabilities must be recomputed after a targeted rescan.
 *
 * Previously buildCoverage ran ONCE before the rescan; facts added by the
 * rescan never reached the snapshot's capabilities / categoryCounts, so UI and
 * CanonQueryService read stale coverage inconsistent with the DB.
 */
import { buildCoverage } from '../src/services/continuation/canon/canonAnalysisService';
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import {
  seedCanonBaseline,
  seedAnalysisRun,
  seedCanonFactWithEvidence,
} from './helpers/canonEvidenceTestFixtures';

describe('Bug #5: buildCoverage reflects DB state (recomputable after rescan)', () => {
  it('categoryCounts reflects facts WITH evidence, not raw row counts', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const base = await seedCanonBaseline(db);
      await seedAnalysisRun(db, base);
      // 3 world_rules with evidence → counted.
      for (let i = 0; i < 3; i++) {
        await seedCanonFactWithEvidence(db, {
          projectId: base.projectId,
          sourceId: base.sourceId,
          snapshotId: base.snapshotId,
          runId: base.runId,
          chapterId: base.chapterId,
          boundaryExclusive: base.boundaryExclusive,
          table: 'canon_world_rules',
          title: `规则${i}`,
          charStart: i * 10,
          charEnd: i * 10 + 4,
          quotePreview: `原文${i}`,
        });
      }
      const { coverage, capabilities } = await buildCoverage(
        db as any,
        base.snapshotId,
        'standard',
        1,
        1,
        0,
        { schemaVersion: 1 as const, kind: 'full' as const, tailChapterCount: null },
        [],
      );
      expect(coverage.categoryCounts.worldRules).toBe(3);
      expect(capabilities.worldRules).toBe(true);
    } finally {
      db.close();
    }
  });

  it('orphan facts (no evidence) are NOT counted in categoryCounts', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const base = await seedCanonBaseline(db);
      await seedAnalysisRun(db, base);
      // 3 world_rules WITHOUT evidence.
      for (let i = 0; i < 3; i++) {
        await db.executeSql(
          `INSERT INTO canon_world_rules
            (project_id, source_id, snapshot_id, analysis_run_id,
             valid_from_position, first_observed_position, last_observed_position,
             confidence, review_status, origin, extraction_version, revision,
             created_at, updated_at, category, title, description, constraint_level)
           VALUES (?, ?, ?, ?, 0, 0, 0, 0.9, 'pending', 'ai', 'v1', 1, 't', 't',
             'other', ?, ?, 'reference')`,
          [base.projectId, base.sourceId, base.snapshotId, base.runId, `孤${i}`, `孤${i}`],
        );
      }
      const { coverage, capabilities } = await buildCoverage(
        db as any,
        base.snapshotId,
        'standard',
        1,
        1,
        0,
        { schemaVersion: 1 as const, kind: 'full' as const, tailChapterCount: null },
        [],
      );
      expect(coverage.categoryCounts.worldRules).toBe(0);
      // capability only flips when >= 1 valid (evidence-backed) row exists.
      expect(capabilities.worldRules).toBe(false);
    } finally {
      db.close();
    }
  });

  it('adding facts after the first buildCoverage changes the counts (recomputable)', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const base = await seedCanonBaseline(db);
      await seedAnalysisRun(db, base);
      // First compute: 1 relationship.
      await seedCanonFactWithEvidence(db, {
        projectId: base.projectId,
        sourceId: base.sourceId,
        snapshotId: base.snapshotId,
        runId: base.runId,
        chapterId: base.chapterId,
        boundaryExclusive: base.boundaryExclusive,
        table: 'canon_world_rules',
        title: '唯一规则',
        charStart: 0,
        charEnd: 4,
        quotePreview: '原文',
      });
      const first = await buildCoverage(
        db as any,
        base.snapshotId,
        'standard',
        1,
        1,
        0,
        { schemaVersion: 1 as const, kind: 'full' as const, tailChapterCount: null },
        [],
      );
      expect(first.coverage.categoryCounts.worldRules).toBe(1);

      // Simulate a rescan adding 2 more world_rules with evidence.
      for (let i = 0; i < 2; i++) {
        await seedCanonFactWithEvidence(db, {
          projectId: base.projectId,
          sourceId: base.sourceId,
          snapshotId: base.snapshotId,
          runId: base.runId,
          chapterId: base.chapterId,
          boundaryExclusive: base.boundaryExclusive,
          table: 'canon_world_rules',
          title: `补扫规则${i}`,
          charStart: 10 + i * 10,
          charEnd: 14 + i * 10,
          quotePreview: `补扫${i}`,
        });
      }
      // Recompute — must reflect the newly-added facts.
      const recomputed = await buildCoverage(
        db as any,
        base.snapshotId,
        'standard',
        1,
        1,
        0,
        { schemaVersion: 1 as const, kind: 'full' as const, tailChapterCount: null },
        [],
      );
      expect(recomputed.coverage.categoryCounts.worldRules).toBe(3);
      expect(recomputed.capabilities.worldRules).toBe(true);
    } finally {
      db.close();
    }
  });
});
