/**
 * Phase 4 ONE Flow integration gates.
 *
 * Memory → Context Candidates → Freeze → Pipeline → Persist →
 * WritingPersistedEvent → Memory. No second Writer / Budget / LTM.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  adaptContinuationWritingSources,
  assertWritingPersistedEvent,
  buildWritingPersistedEvent,
  classifyContinuityProposalCommit,
  fingerprintPersistedBody,
  MEMORY_TO_CONTEXT_CANDIDATE_KINDS,
  ONE_FLOW_FORBIDDEN_DUAL_TRUTHS,
  ONE_FLOW_MEMORY_ENTRY_POINTS,
  ONE_FLOW_STEPS,
  ONE_FLOW_UNIQUE_OBJECTS,
  projectFrozenContextForStage,
  renderStructuredContinuityStateCandidate,
  STAGE_CONTEXT_KIND_ALLOWLIST,
  validateWritingSourceBundle,
} from '../src/services/writing';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { continuationRequest, outlineRequest } from './helpers/oneShotFixtures';

const ROOT = path.resolve(__dirname, '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(ROOT, rel));
}

function continuationSnapshotWithState() {
  return {
    projectId: 7,
    targetChapterId: 12,
    targetPosition: 1 as any,
    source: {
      sourceId: 9,
      sourceVersion: 2,
      normalizedSha256: 'source-hash',
      parserVersion: 'p1',
      normalizationVersion: 'n1',
      boundary: {
        chapterId: 4,
        chapterPosition: 3 as any,
        charOffsetExclusive: 100,
      },
    },
    canon: {
      snapshotId: 'canon-1',
      revision: 3,
      boundaryGlobalCharOffset: 100,
      capabilities: {},
    },
    storyMemory: {
      stateFingerprint: 'sm-1',
      throughPosition: 0 as any,
      status: 'ready',
    },
    inputRevisionHash: 'chapter-hash',
    style: {
      profileId: 'style-1',
      profileHash: 'style-hash',
      frozenProfile: { global: { narrative: { person: 'third' } } },
    },
    bundles: {
      userInstruction: '从边界继续。',
      lockedRules: [],
      canon: {
        worldRules: [{ title: '规则', description: '魔法有代价' }],
        characters: [],
        characterStates: [],
        relationships: [],
        experiences: [],
        knowledge: [],
        plotThreads: [],
        timelineEvents: [],
      },
      effectiveState: {
        schemaVersion: 1,
        characterStates: [
          {
            ref: { refType: 'canon_character', id: 'c1', name: '林遥' },
            source: 'state_event',
            summary: '人在码头',
            fields: { location: '码头' },
          },
        ],
        relationships: [],
        plotThreads: [
          {
            id: 'p1',
            title: '夜雨追查',
            status: 'active',
            summary: '线索未闭合',
            sourceLayer: 'state_event',
          },
        ],
        knowledge: [],
        experiences: [],
        appliedEventIds: ['ev-1'],
      },
      seam: { summary: '末章', excerpt: '门后传来脚步声。' },
      recentChapters: [],
      storyMemory: { summary: '状态摘要' },
      episodic: [],
      style: null,
      supplements: {
        characterText: '',
        worldbookText: '',
        noteText: '',
        presetText: '',
        selected: [],
        excluded: [],
      },
    },
    primaryAnchor: {
      kind: 'source_seam',
      chapterId: 4,
      position: 3 as any,
      summary: '末章',
      excerpt: '门后传来脚步声。',
    },
  } as any;
}

describe('ONE Flow contract', () => {
  test('closed loop is Memory → Context → Freeze → Pipeline → Persist → Memory', () => {
    expect(ONE_FLOW_STEPS).toEqual([
      'user_or_batch_or_resume',
      'source_adapter',
      'context_candidates',
      'one_context_planner',
      'elastic_hierarchical_budget',
      'render',
      'requirements_and_policy',
      'one_freeze',
      'one_pipeline_dag',
      'persist',
      'writing_persisted_event',
      'post_writing_update',
      'one_memory',
      'next_chapter_ready',
    ]);
    expect(ONE_FLOW_UNIQUE_OBJECTS).toMatchObject({
      productionWritingEntry: 'runWritingKernel',
      contextPlanner: 'buildWritingContextPlan',
      finalBudget: 'allocateWritingContextBudget',
      persistToMemoryEvent: 'WritingPersistedEvent',
      narrativeLongTermMemory: 'story_memory',
    });
    expect(ONE_FLOW_FORBIDDEN_DUAL_TRUTHS).toEqual(
      expect.arrayContaining([
        'second_writer_core',
        'second_final_budget',
        'second_long_term_memory',
        'post_freeze_live_source_read',
        'memory_prompt_bypass',
      ]),
    );
  });
});

describe('WritingPersistedEvent', () => {
  test('builds a fail-closed handoff with the required fields', () => {
    const event = buildWritingPersistedEvent({
      generationTraceId: 'gt-phase4',
      freezeFingerprint: 'a'.repeat(64),
      projectId: 3,
      chapterId: 11,
      chapterPosition: 4,
      finalBody: '定稿正文',
      executionProfile: 'standard',
      appliedRequirementIds: ['req-1'],
      scenario: 'outline',
      persistedAt: '2026-08-18T00:00:00.000Z',
    });
    expect(event.kind).toBe('writing_persisted');
    expect(event.finalBodyFingerprint).toBe(fingerprintPersistedBody('定稿正文'));
    expect(event.finalBodyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertWritingPersistedEvent(event)).not.toThrow();
  });

  test('rejects an unfinished or incomplete persist', () => {
    expect(() =>
      buildWritingPersistedEvent({
        generationTraceId: '',
        freezeFingerprint: 'fp',
        projectId: 1,
        chapterId: 1,
        chapterPosition: 0,
        finalBody: 'x',
        scenario: 'outline',
      }),
    ).toThrow(/generationTraceId/);
    expect(() =>
      assertWritingPersistedEvent({
        kind: 'writing_persisted',
        contractVersion: 1,
        generationTraceId: 'gt',
        freezeFingerprint: 'fp',
        projectId: 1,
        chapterId: 1,
        chapterPosition: 0,
        finalBodyFingerprint: 'not-a-hash',
        executionProfile: 'standard',
        appliedRequirementIds: [],
        scenario: 'outline',
        persistedAt: '2026-08-18T00:00:00.000Z',
      }),
    ).toThrow(/finalBodyFingerprint/);
  });

  test('Memory update entry points require the persisted event', () => {
    const outline = read('src/services/storyMemory/storyMemoryService.ts');
    const continuation = read(
      'src/services/writing/persist/continuationAdoption.ts',
    );
    expect(ONE_FLOW_MEMORY_ENTRY_POINTS).toHaveLength(2);
    expect(outline).toContain('buildWritingPersistedEvent');
    expect(outline).toContain('assertWritingPersistedEventAllowsMemoryUpdate');
    expect(continuation).toContain('buildWritingPersistedEvent');
    expect(continuation).toContain('writingPersistedEvent: persistedEvent');
    expect(continuation).toContain('extract_state');
  });
});

describe('Memory → Context candidates', () => {
  test('Story Memory / Continuity State / Canon enter as candidates, not prompts', () => {
    expect(MEMORY_TO_CONTEXT_CANDIDATE_KINDS).toEqual([
      'story_memory',
      'episodic_memory',
      'structured_continuity_state',
      'canon',
    ]);
    const outlineAdapter = read(
      'src/services/writing/scenario/outlineWritingAdapter.ts',
    );
    const continuationAdapter = read(
      'src/services/writing/scenario/continuationWritingAdapter.ts',
    );
    for (const text of [outlineAdapter, continuationAdapter]) {
      expect(text).not.toContain('compileSharedWritingPrompt');
      expect(text).not.toContain('allocateWritingContextBudget');
      expect(text).not.toContain('buildWritingContextPlan');
    }
    expect(continuationAdapter).toContain('structured_continuity_state');
    expect(continuationAdapter).toContain(
      'renderStructuredContinuityStateCandidate',
    );
    expect(outlineAdapter).toContain("'story_memory'");
  });

  test('Continuity State deltas become a preferred candidate', () => {
    const adapted = adaptContinuationWritingSources({
      snapshot: continuationSnapshotWithState(),
    });
    const state = adapted.bundle.preferred.find(
      item => item.kind === 'structured_continuity_state',
    );
    expect(state).toBeTruthy();
    expect(state?.content).toContain('人在码头');
    expect(state?.content).toContain('夜雨追查');
    expect(state?.content).not.toMatch(/compile|system prompt/i);
    expect(
      validateWritingSourceBundle('continuation', adapted.bundle).ok,
    ).toBe(true);
    expect(
      validateWritingSourceBundle('outline', {
        mandatory: adapted.bundle.mandatory,
        preferred: [state!],
        optional: [],
      }).issues.map(item => item.code),
    ).toContain('INVALID_SCENARIO_SOURCE');
  });

  test('Canon-only state rows do not create a second candidate', () => {
    expect(
      renderStructuredContinuityStateCandidate({
        characterStates: [
          { source: 'canon', ref: 'c1', summary: '原著人物' },
        ],
        plotThreads: [
          { sourceLayer: 'canon', title: '原著线', status: 'open' },
        ],
      }),
    ).toBe('');
  });

  test('audit / revision projection may carry Continuity State; proof does not', () => {
    expect(STAGE_CONTEXT_KIND_ALLOWLIST.audit).toEqual(
      expect.arrayContaining(['structured_continuity_state', 'canon']),
    );
    expect(STAGE_CONTEXT_KIND_ALLOWLIST.revision).toEqual(
      expect.arrayContaining(['structured_continuity_state']),
    );
    expect(STAGE_CONTEXT_KIND_ALLOWLIST.proof).not.toContain(
      'structured_continuity_state',
    );
    const { frozenContext } = buildWritingKernelFreezeTrace({
      request: continuationRequest({}),
    });
    const proof = projectFrozenContextForStage({
      frozenContext,
      stage: 'proof',
    });
    expect(proof.includedKinds).not.toContain('structured_continuity_state');
  });
});

describe('No dual truth', () => {
  test('no second Writer / Budget / LTM / post-freeze live source read', () => {
    const forbiddenFiles = [
      'src/services/writing/memory/continuationMemory.ts',
      'src/services/writing/memory/outlineMemory.ts',
      'src/services/writing/memory/fastMemory.ts',
      'src/services/writing/memory/oneShotMemory.ts',
      'src/services/writing/stages/outlineWriterCore.ts',
      'src/services/writing/stages/continuationWriterCore.ts',
      'src/services/writing/prompt/fastPromptCompiler.ts',
      'src/services/writing/context/fastContextBuilder.ts',
    ];
    for (const file of forbiddenFiles) {
      expect(exists(file)).toBe(false);
    }
    const freeze = read('src/services/writing/context/buildFrozenWritingContext.ts');
    expect(freeze).toContain('buildWritingContextPlan(normalized)');
    expect(freeze).toContain('allocateWritingContextBudget({');
    const runner = read('src/services/writing/stages/writingStageRunner.ts');
    expect(runner).not.toMatch(/getActiveSnapshot|openDatabase\(/);
    expect(read('src/services/writing/stages/writerCore.ts')).not.toMatch(
      /getChapterById|CanonQueryService/,
    );
  });

  test('batch next-chapter Freeze uses the ONE Memory ready policy', () => {
    const gate = read(
      'src/services/multiChapterBatch/continuationBatchStateGate.ts',
    );
    expect(gate).toContain('evaluatePostWritingMemoryReady');
    expect(gate).toContain('replayPendingContinuityProposals');
    expect(gate).toContain('BATCH_CONTINUATION_STATE_CONFLICT');
    expect(gate).not.toMatch(/OutlineWriterCore|ContinuationMemory/);
  });

  test('legacy leftover pending is classified, not treated as a conflict by type', () => {
    const leftover = classifyContinuityProposalCommit({
      proposalType: 'plot_advance',
      payloadJson: JSON.stringify({
        summary: '林澜和陈伯谦离开灯塔前往北岸旧闸门。',
      }),
    });
    expect(leftover.action).toBe('auto_commit');
    const leftoverFact = classifyContinuityProposalCommit({
      proposalType: 'new_world_fact',
      payloadJson: JSON.stringify({
        summary: '铁盒凹槽与纹章吻合。',
      }),
    });
    expect(leftoverFact.action).toBe('auto_commit');
  });

  test('One-Shot paid path stays a single Draft after the flow contract', () => {
    const { frozenContext } = buildWritingKernelFreezeTrace({
      request: outlineRequest({ executionProfile: 'one_shot' }),
    });
    const skip = frozenContext.stagePolicy.skipRules || {};
    expect(Object.keys(skip)).toEqual(
      expect.arrayContaining([
        'review',
        'audit',
        'factCheck',
        'revision',
        'proof',
      ]),
    );
    expect(skip.draft).toBeUndefined();
  });
});
