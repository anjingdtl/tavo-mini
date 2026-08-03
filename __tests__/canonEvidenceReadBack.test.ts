/**
 * Bug #1 part 2: evidence read-back verification at insert time.
 *
 * insertEvidence must, when a readBackVerifier is supplied, read the source text
 * at [charStart, charEnd) and reject the evidence when the read-back text does
 * NOT match the quotePreview. This catches chunk-offset bugs, future leakage
 * clipped by the boundary, and any other mismatch before it reaches the DB.
 */
import { insertEvidence, insertEvidenceAndLink } from '../src/services/continuation/canon/canonEvidenceService';
import type SQLite from 'react-native-sqlite-storage';
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import {
  seedCanonBaseline,
  seedAnalysisRun,
  seedSourceTextChunk,
} from './helpers/canonEvidenceTestFixtures';

describe('Bug #1 part 2: evidence read-back verification', () => {
  it('accepts an evidence whose read-back text matches quotePreview', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const base = await seedCanonBaseline(db, { boundaryExclusive: 5000 });
      await seedAnalysisRun(db, base);
      // Seed source text covering [0, 100).
      await seedSourceTextChunk(db, base.sourceId, 0, 0, 'A'.repeat(50) + '拜师仪式' + 'B'.repeat(42));
      // '拜师仪式' starts at offset 50, length 4.
      const id = await insertEvidence(db as unknown as SQLite.SQLiteDatabase, {
        projectId: base.projectId,
        sourceId: base.sourceId,
        snapshotId: base.snapshotId,
        analysisRunId: base.runId,
        boundaryExclusive: base.boundaryExclusive,
        candidate: {
          chapterId: base.chapterId,
          chapterPosition: 0,
          charStart: 50,
          charEnd: 54,
          quotePreview: '拜师仪式',
        },
        readBackVerifier: async (cs, ce) => readChunk(db as any, base.sourceId, cs, ce),
      });
      expect(id).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('rejects an evidence whose read-back text does NOT match (offset wrong)', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const base = await seedCanonBaseline(db, { boundaryExclusive: 5000 });
      await seedAnalysisRun(db, base);
      await seedSourceTextChunk(db, base.sourceId, 0, 0, 'A'.repeat(50) + '拜师仪式' + 'B'.repeat(42));
      // Claim the quote is '拜师仪式' at [0,4) — but [0,4) is 'AAAA'. Read-back
      // mismatches → must be rejected (returns null, no row inserted).
      const id = await insertEvidence(db as unknown as SQLite.SQLiteDatabase, {
        projectId: base.projectId,
        sourceId: base.sourceId,
        snapshotId: base.snapshotId,
        analysisRunId: base.runId,
        boundaryExclusive: base.boundaryExclusive,
        candidate: {
          chapterId: base.chapterId,
          chapterPosition: 0,
          charStart: 0,
          charEnd: 4,
          quotePreview: '拜师仪式',
        },
        readBackVerifier: async (cs, ce) => readChunk(db as any, base.sourceId, cs, ce),
      });
      expect(id).toBeNull();
      const [res] = await db.executeSql('SELECT COUNT(*) AS c FROM canon_evidence');
      expect(res.rows.item(0).c).toBe(0);
    } finally {
      db.close();
    }
  });

  it('insertEvidenceAndLink forwards the verifier and rejects bad evidence', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const base = await seedCanonBaseline(db, { boundaryExclusive: 5000 });
      await seedAnalysisRun(db, base);
      await seedSourceTextChunk(db, base.sourceId, 0, 0, 'A'.repeat(50) + '正确片段' + 'B'.repeat(42));
      const okId = await insertEvidenceAndLink(
        db as unknown as SQLite.SQLiteDatabase,
        {
          projectId: base.projectId,
          sourceId: base.sourceId,
          snapshotId: base.snapshotId,
          analysisRunId: base.runId,
          boundaryExclusive: base.boundaryExclusive,
          candidate: {
            chapterId: base.chapterId,
            chapterPosition: 0,
            charStart: 50,
            charEnd: 54,
            quotePreview: '正确片段',
          },
          readBackVerifier: async (cs, ce) => readChunk(db as any, base.sourceId, cs, ce),
        },
        'world_rule',
        999,
      );
      expect(okId).toBeGreaterThan(0);
      const badId = await insertEvidenceAndLink(
        db as unknown as SQLite.SQLiteDatabase,
        {
          projectId: base.projectId,
          sourceId: base.sourceId,
          snapshotId: base.snapshotId,
          analysisRunId: base.runId,
          boundaryExclusive: base.boundaryExclusive,
          candidate: {
            chapterId: base.chapterId,
            chapterPosition: 0,
            charStart: 1,
            charEnd: 5,
            quotePreview: '正确片段',
          },
          readBackVerifier: async (cs, ce) => readChunk(db as any, base.sourceId, cs, ce),
        },
        'world_rule',
        999,
      );
      expect(badId).toBeNull();
    } finally {
      db.close();
    }
  });
});

/** Minimal read-back that reads continuation_source_text_chunks like SourceReader. */
async function readChunk(
  db: Awaited<ReturnType<typeof createCanonInMemoryDb>>,
  sourceId: number,
  start: number,
  end: number,
): Promise<string> {
  const [res] = await db.executeSql(
    `SELECT content, char_start_offset AS cso, char_end_offset AS ceo
       FROM continuation_source_text_chunks
       WHERE source_id = ? AND char_start_offset <= ? AND char_end_offset >= ?
       ORDER BY char_start_offset`,
    [sourceId, start, start],
  );
  if (res.rows.length === 0) return '';
  const row = res.rows.item(0);
  const content = row.content as string;
  const cso = row.cso as number;
  const localStart = Math.max(0, start - cso);
  const localEnd = Math.min(content.length, end - cso);
  return content.slice(localStart, localEnd);
}
