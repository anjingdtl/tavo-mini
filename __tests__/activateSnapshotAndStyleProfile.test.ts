jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: jest.fn(),
}));

jest.mock('../src/data/connection/transaction', () => ({
  executeTransaction: jest.fn(),
}));

jest.mock('../src/services/continuation/continuationSourceReader', () => ({
  continuationSourceReader: {
    getSnapshot: jest.fn(),
  },
}));

jest.mock('../src/services/continuation/canon/canonRepository', () => ({
  getSnapshotById: jest.fn(),
  getRunById: jest.fn(),
  countFutureEvidence: jest.fn(),
  countOrphanEvidence: jest.fn(),
}));

jest.mock('../src/services/continuation/styleProfile/styleProfileRepository', () => ({
  getStyleProfileById: jest.fn(),
}));

jest.mock('../src/services/continuation/canon/canonAnalysisService', () => ({
  buildDefaultCanonAdoptionStatements: jest.fn(),
}));

import { openDatabase } from '../src/data/connection/openDatabase';
import { executeTransaction } from '../src/data/connection/transaction';
import { continuationSourceReader } from '../src/services/continuation/continuationSourceReader';
import {
  getSnapshotById,
  getRunById,
  countFutureEvidence,
  countOrphanEvidence,
} from '../src/services/continuation/canon/canonRepository';
import { buildDefaultCanonAdoptionStatements } from '../src/services/continuation/canon/canonAnalysisService';
import { getStyleProfileById } from '../src/services/continuation/styleProfile/styleProfileRepository';
import { computeStyleProfileHash } from '../src/services/continuation/styleProfile/styleProfileHash';
import { activateSnapshotAndStyleProfile } from '../src/services/continuation/canon/activateSnapshotAndStyleProfile';
import { ContinuationSnapshotOutdatedError } from '../src/services/continuation/types';
import {
  asSourcePosition,
  asUtf16Offset,
} from '../src/services/continuation/continuationSourceRepository';

const liveSnapshot = {
       projectId: 1,
  sourceId: 10,
  sourceVersion: 3,
  normalizedSha256: 'abc',
  parserVersion: 'p1',
  normalizationVersion: 'n1',
  boundary: {
    chapterId: 99,
    chapterPosition: asSourcePosition(5),
    charOffsetExclusive: asUtf16Offset(5000),
  },
};

const awaitingSnap = {
  id: 'snap-1',
  projectId: 1,
  sourceId: 10,
  sourceVersion: 3,
  sourceSha256: 'abc',
  parserVersion: 'p1',
  normalizationVersion: 'n1',
  boundaryChapterId: 99,
  boundaryPosition: asSourcePosition(5),
  boundaryCharOffsetExclusive: asUtf16Offset(5000),
  profile: 'standard',
  status: 'awaiting_review',
};

describe('activateSnapshotAndStyleProfile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (openDatabase as jest.Mock).mockResolvedValue({});
    (continuationSourceReader.getSnapshot as jest.Mock).mockResolvedValue(
      liveSnapshot,
    );
    (getSnapshotById as jest.Mock).mockResolvedValue(awaitingSnap);
    (getRunById as jest.Mock).mockResolvedValue({
      id: 'run-1',
      projectId: 1,
      canonSnapshotId: 'snap-1',
      state: 'awaiting_review',
    });
    const profile = {
      id: 'style-1',
      projectId: 1,
      sourceId: 10,
      sourceVersion: 3,
      sourceSha256: 'abc',
      parserVersion: 'p1',
      normalizationVersion: 'n1',
      boundaryChapterId: 99,
      boundaryPosition: 5,
      boundaryCharOffsetExclusive: 5000,
      analysisRunId: 'run-1',
      canonSnapshotId: 'snap-1',
      profileSchemaVersion: 2,
      analyzerVersion: 'a1',
      profileJson: { summary: 'style' },
      metricsJson: { count: 1 },
      sampleRefsJson: [],
      userOverridesJson: {},
      profileHash: '',
      confidence: 1,
      state: 'ready',
      reviewStatus: 'confirmed',
    };
    profile.profileHash = computeStyleProfileHash({
      profile: profile.profileJson,
      metrics: profile.metricsJson,
      sampleRefs: profile.sampleRefsJson,
      profileSchemaVersion: profile.profileSchemaVersion,
      analyzerVersion: profile.analyzerVersion,
      userOverrides: profile.userOverridesJson,
    });
    (getStyleProfileById as jest.Mock).mockResolvedValue(profile);
    (countFutureEvidence as jest.Mock).mockResolvedValue(0);
    (countOrphanEvidence as jest.Mock).mockResolvedValue(0);
    (buildDefaultCanonAdoptionStatements as jest.Mock).mockReturnValue([
      { sql: 'ADOPT pending', params: ['t', 'snap-1'] },
    ]);
    // After activation, the snapshot read returns status ready.
    (executeTransaction as jest.Mock).mockImplementation(async () => {
      (getSnapshotById as jest.Mock).mockResolvedValue({
        ...awaitingSnap,
        status: 'ready',
      });
    });
  });

  it('activates Canon + style together in a single transaction', async () => {
    await activateSnapshotAndStyleProfile({
      projectId: 1,
      analysisRunId: 'run-1',
      canonSnapshotId: 'snap-1',
      styleProfileId: 'style-1',
      allowStyleSkip: false,
    });

    // Exactly one transaction commit — no half-state possible.
    expect(executeTransaction).toHaveBeenCalledTimes(1);
    const [, statements] = (executeTransaction as jest.Mock).mock.calls[0];
    const sqls: string[] = statements.map(
      (s: { sql: string }) => s.sql as string,
    );

    // Canon: old → outdated (only old ready snapshots, excluding the new one).
    expect(
      sqls.some(
        s =>
          s.includes("status = 'outdated'") &&
          s.includes('continuation_canon_snapshots') &&
          s.includes('id != ?'),
      ),
    ).toBe(true);
    // Canon: new → ready.
    expect(
      sqls.some(s => s.includes("SET status = 'ready', activated_at =")),
    ).toBe(true);
    // Style: new profile → ready.
    expect(
      sqls.some(
        s =>
          s.includes('continuation_style_profiles') &&
          s.includes("SET state = 'ready'"),
      ),
    ).toBe(true);
    // Settings: both pointers updated together.
    expect(
      sqls.some(
        s =>
          s.includes('active_canon_snapshot_id = ?') &&
          s.includes('active_style_profile_id = ?'),
      ),
    ).toBe(true);
    // Run completion.
    expect(
      sqls.some(s => s.includes("state = 'completed'") && s.includes('canon_snapshot_id')),
    ).toBe(true);
    // Generation runs → outdated.
    expect(
      sqls.some(s => s.includes('continuation_generation_runs') && s.includes("state = 'outdated'")),
    ).toBe(true);
  });

  it('skip-style activation sets active_style_profile_id = NULL', async () => {
    await activateSnapshotAndStyleProfile({
      projectId: 1,
      analysisRunId: 'run-1',
      canonSnapshotId: 'snap-1',
      styleProfileId: null,
      allowStyleSkip: true,
    });

    const [, statements] = (executeTransaction as jest.Mock).mock.calls[0];
    const settingsStmt = statements.find(
      (s: { sql: string }) =>
        s.sql.includes('active_canon_snapshot_id') &&
        s.sql.includes('active_style_profile_id'),
    );
    expect(settingsStmt.params).toEqual([
      'snap-1',
      null, // explicit skip
      expect.any(String),
      1,
    ]);
    // No statement sets a style profile to 'ready' when skipping.
    const styleReadyStmts = statements.filter(
      (s: { sql: string }) =>
        s.sql.includes('continuation_style_profiles') &&
        s.sql.includes("SET state = 'ready'"),
    );
    expect(styleReadyStmts).toHaveLength(0);
  });

  it('throws when styleProfileId is null but allowStyleSkip is false (no implicit skip)', async () => {
    await expect(
      activateSnapshotAndStyleProfile({
        projectId: 1,
        analysisRunId: 'run-1',
        canonSnapshotId: 'snap-1',
        styleProfileId: null,
        allowStyleSkip: false,
      }),
    ).rejects.toThrow('跳过文风');

    // No transaction should have been attempted.
    expect(executeTransaction).not.toHaveBeenCalled();
  });

  it('leaves no half-state when source/boundary has drifted (throws before transaction)', async () => {
    (continuationSourceReader.getSnapshot as jest.Mock).mockResolvedValue({
      ...liveSnapshot,
      sourceVersion: 999, // drift
    });

    await expect(
      activateSnapshotAndStyleProfile({
        projectId: 1,
        analysisRunId: 'run-1',
        canonSnapshotId: 'snap-1',
        styleProfileId: 'style-1',
        allowStyleSkip: false,
      }),
    ).rejects.toThrow(ContinuationSnapshotOutdatedError);

    // The main activation transaction must NOT have committed.
    // (Only the best-effort single-statement outdated mark may run, which does
    // not touch activated_at.)
    const txCalls = (executeTransaction as jest.Mock).mock.calls;
    const activationCall = txCalls.find(
      ([, stmts]: [unknown, { sql: string }[]]) =>
        Array.isArray(stmts) &&
        stmts.some(s => typeof s?.sql === 'string' && s.sql.includes('activated_at')),
    );
    expect(activationCall).toBeUndefined();
  });

  it('marks old style profiles outdated on fingerprint mismatch within the same transaction', async () => {
    await activateSnapshotAndStyleProfile({
      projectId: 1,
      analysisRunId: 'run-1',
      canonSnapshotId: 'snap-1',
      styleProfileId: 'style-1',
      allowStyleSkip: false,
    });

    const [, statements] = (executeTransaction as jest.Mock).mock.calls[0];
    const invalidateStmt = statements.find(
      (s: { sql: string }) =>
        s.sql.includes('continuation_style_profiles') &&
        s.sql.includes("SET state = 'outdated'") &&
        s.sql.includes('NOT ('),
    );
    expect(invalidateStmt).toBeDefined();
    // It must key off the live fingerprint fields.
    expect(invalidateStmt.params).toContain(10); // sourceId
    expect(invalidateStmt.params).toContain(99); // boundaryChapterId
    expect(invalidateStmt.params).toContain(5000); // boundaryCharOffsetExclusive
  });

  it('refuses to activate a snapshot that is neither awaiting_review nor ready', async () => {
    (getSnapshotById as jest.Mock).mockResolvedValue({
      ...awaitingSnap,
      status: 'failed',
    });

    await expect(
      activateSnapshotAndStyleProfile({
        projectId: 1,
        analysisRunId: 'run-1',
        canonSnapshotId: 'snap-1',
        styleProfileId: 'style-1',
        allowStyleSkip: false,
      }),
    ).rejects.toThrow('不可激活');

    expect(executeTransaction).not.toHaveBeenCalled();
  });

  it('refuses to activate when future evidence exists (boundary integrity guard)', async () => {
    (countFutureEvidence as jest.Mock).mockResolvedValue(2);

    await expect(
      activateSnapshotAndStyleProfile({
        projectId: 1,
        analysisRunId: 'run-1',
        canonSnapshotId: 'snap-1',
        styleProfileId: 'style-1',
        allowStyleSkip: false,
      }),
    ).rejects.toThrow('未来证据');

    expect(executeTransaction).not.toHaveBeenCalled();
  });
});
