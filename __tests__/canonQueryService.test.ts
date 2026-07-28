/**
 * CanonQueryService contract (Spec §13): only active ready snapshot;
 * revision mismatch → canon_snapshot_outdated; ignored excluded.
 */
import { CanonSnapshotOutdatedError } from '../src/services/continuation/canon/types';

const mockState = {
  activeId: 'snap-ready' as string | null,
  snapshots: {
    'snap-ready': {
      id: 'snap-ready',
      project_id: 1,
      source_id: 1,
      analysis_run_id: 'run-1',
      source_version: 1,
      source_sha256: 'abc',
      parser_version: 'v1',
      normalization_version: 'v1',
      boundary_chapter_id: 10,
      boundary_position: 19,
      boundary_char_offset_exclusive: 9999,
      extraction_version: 'v1',
      profile: 'standard',
      revision: 3,
      status: 'ready',
      capabilities_json: JSON.stringify({
        worldRules: true,
        characterProfiles: true,
        characterStates: true,
        relationships: true,
        plotThreads: true,
        experiences: true,
        knowledgeBoundaries: true,
        timelineEvents: true,
        evidenceValidated: true,
      }),
      coverage_json: JSON.stringify({
        schemaVersion: 1,
        sourceChapterCount: 20,
        analyzedChapterCount: 20,
        analyzedThroughPosition: 19,
        categoryCounts: {},
        incompleteReasons: [],
      }),
      created_at: 't',
      updated_at: 't',
      activated_at: 't',
    },
    'snap-staging': {
      id: 'snap-staging',
      project_id: 1,
      source_id: 1,
      analysis_run_id: 'run-2',
      source_version: 1,
      source_sha256: 'abc',
      parser_version: 'v1',
      normalization_version: 'v1',
      boundary_chapter_id: 10,
      boundary_position: 19,
      boundary_char_offset_exclusive: 9999,
      extraction_version: 'v1',
      profile: 'standard',
      revision: 1,
      status: 'staging',
      capabilities_json: '{}',
      coverage_json: '{}',
      created_at: 't',
      updated_at: 't',
      activated_at: null,
    },
  } as Record<string, any>,
  worldRules: [
    {
      id: 1,
      project_id: 1,
      source_id: 1,
      snapshot_id: 'snap-ready',
      analysis_run_id: 'run-1',
      valid_from_position: 0,
      valid_to_position: null,
      first_observed_position: 0,
      last_observed_position: 5,
      confidence: 0.9,
      review_status: 'confirmed',
      origin: 'ai',
      extraction_version: 'v1',
      revision: 1,
      supersedes_id: null,
      user_reviewed_at: 't',
      created_at: 't',
      updated_at: 't',
      category: 'fundamental',
      title: '灵气',
      description: '规则',
      constraint_level: 'hard',
    },
    {
      id: 2,
      project_id: 1,
      source_id: 1,
      snapshot_id: 'snap-ready',
      analysis_run_id: 'run-1',
      valid_from_position: 0,
      valid_to_position: null,
      first_observed_position: 0,
      last_observed_position: 5,
      confidence: 0.5,
      review_status: 'ignored',
      origin: 'ai',
      extraction_version: 'v1',
      revision: 1,
      supersedes_id: null,
      user_reviewed_at: 't',
      created_at: 't',
      updated_at: 't',
      category: 'other',
      title: '应忽略',
      description: 'x',
      constraint_level: 'reference',
    },
  ],
  characters: [
    {
      id: 7,
      project_id: 1,
      source_id: 1,
      snapshot_id: 'snap-ready',
      analysis_run_id: 'run-1',
      valid_from_position: 0,
      valid_to_position: null,
      first_observed_position: 0,
      last_observed_position: 5,
      confidence: 0.9,
      review_status: 'confirmed',
      origin: 'ai',
      extraction_version: 'v1',
      revision: 1,
      supersedes_id: null,
      user_reviewed_at: 't',
      created_at: 't',
      updated_at: 't',
      canonical_name: '沈青',
      description: '主角的剑术师父',
      background: '',
      appearance_json: '{}',
      personality_json: '{}',
      values_json: '[]',
      behavior_patterns_json: '[]',
      speech_style_json: '{}',
      abilities_json: '[]',
      weaknesses_json: '[]',
      goals_json: '[]',
      fears_json: '[]',
      secrets_json: '[]',
      first_appearance_position: 0,
      importance: 'major',
    },
  ],
};

jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: jest.fn(async () => ({
    executeSql: jest.fn(async (sql: string, params: any[] = []) => {
      const n = sql.replace(/\s+/g, ' ');
      const rows = (items: any[]) => ({
        length: items.length,
        item: (i: number) => items[i],
      });
      if (
        /SELECT active_canon_snapshot_id FROM continuation_settings/i.test(n)
      ) {
        return [
          { rows: rows([{ active_canon_snapshot_id: mockState.activeId }]) },
        ];
      }
      if (/SELECT \* FROM continuation_canon_snapshots WHERE id/i.test(n)) {
        const snap = mockState.snapshots[params[0]];
        return [{ rows: rows(snap ? [snap] : []) }];
      }
      if (/FROM canon_world_rules/i.test(n)) {
        const statuses: string[] = [];
        // statuses are params after snapshot id
        const snapId = params[0];
        let filtered = mockState.worldRules.filter(
          r => r.snapshot_id === snapId,
        );
        // rough: if query includes review_status IN
        if (/review_status IN/i.test(n)) {
          // collect string params that look like statuses
          for (const p of params) {
            if (
              typeof p === 'string' &&
              [
                'pending',
                'confirmed',
                'locked',
                'ignored',
                'superseded',
              ].includes(p)
            ) {
              statuses.push(p);
            }
          }
          if (statuses.length) {
            filtered = filtered.filter(r => statuses.includes(r.review_status));
          }
        }
        filtered = filtered.filter(
          r => r.valid_from_position <= (params[params.length - 3] ?? 0),
        );
        return [{ rows: rows(filtered) }];
      }
      if (/FROM canon_characters/i.test(n)) {
        return [
          {
            rows: rows(
              mockState.characters.filter(r => r.snapshot_id === params[0]),
            ),
          },
        ];
      }
      if (/FROM canon_evidence_links/i.test(n)) {
        return [
          {
            rows: rows([
              {
                owner_id: 1,
                evidence_id: 11,
              },
            ]),
          },
        ];
      }
      return [{ rows: rows([]) }];
    }),
  })),
}));

import { CanonQueryService } from '../src/services/continuation/canon/canonQueryService';
import { asSourcePosition } from '../src/services/continuation/continuationSourceRepository';

describe('CanonQueryService (Spec §13)', () => {
  beforeEach(() => {
    mockState.activeId = 'snap-ready';
    mockState.snapshots['snap-ready'].profile = 'standard';
  });

  it('getActiveSnapshot returns ready active only', async () => {
    const snap = await CanonQueryService.getActiveSnapshot(1);
    expect(snap.id).toBe('snap-ready');
    expect(snap.status).toBe('ready');
    expect(snap.revision).toBe(3);
  });

  it('throws when no active pointer', async () => {
    mockState.activeId = null;
    await expect(CanonQueryService.getActiveSnapshot(1)).rejects.toBeInstanceOf(
      CanonSnapshotOutdatedError,
    );
  });

  it('does not expose a legacy Quick snapshot to Phase 3', async () => {
    mockState.snapshots['snap-ready'].profile = 'quick';
    await expect(CanonQueryService.getActiveSnapshot(1)).rejects.toBeInstanceOf(
      CanonSnapshotOutdatedError,
    );
  });

  it('throws on snapshotId mismatch', async () => {
    await expect(
      CanonQueryService.getWorldRules({
        projectId: 1,
        snapshotId: 'snap-staging',
        snapshotRevision: 1,
        atSourcePosition: asSourcePosition(5),
      }),
    ).rejects.toBeInstanceOf(CanonSnapshotOutdatedError);
  });

  it('throws on revision mismatch', async () => {
    await expect(
      CanonQueryService.getWorldRules({
        projectId: 1,
        snapshotId: 'snap-ready',
        snapshotRevision: 1,
        atSourcePosition: asSourcePosition(5),
      }),
    ).rejects.toBeInstanceOf(CanonSnapshotOutdatedError);
  });

  it('excludes ignored by default review statuses', async () => {
    const rules = await CanonQueryService.getWorldRules({
      projectId: 1,
      snapshotId: 'snap-ready',
      snapshotRevision: 3,
      atSourcePosition: asSourcePosition(5),
      reviewStatuses: ['confirmed', 'locked'],
    });
    expect(rules.every(r => r.reviewStatus !== 'ignored')).toBe(true);
    expect(rules.some(r => r.title === '灵气')).toBe(true);
  });

  it('returns evidence ids for the selected facts so continuation checks can cite them', async () => {
    const bundle = await CanonQueryService.getContextBundle({
      projectId: 1,
      snapshotId: 'snap-ready',
      snapshotRevision: 3,
      atSourcePosition: asSourcePosition(5),
      queryText: '',
      characterIds: [],
      tokenBudget: 10000,
      reviewPolicy: 'strict',
    });

    expect(bundle.evidenceRefs).toEqual([11]);
    expect(bundle.evidenceRefsByOwner?.world_rule?.[1]).toEqual([11]);
  });

  it('keeps a base set of important original characters even before the prompt names one', async () => {
    const bundle = await CanonQueryService.getContextBundle({
      projectId: 1,
      snapshotId: 'snap-ready',
      snapshotRevision: 3,
      atSourcePosition: asSourcePosition(5),
      queryText: '推进剧情',
      characterIds: [],
      tokenBudget: 10000,
      reviewPolicy: 'strict',
    });

    expect(bundle.characters.map(item => item.canonicalName)).toContain('沈青');
  });
});
