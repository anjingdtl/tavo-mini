import type {
  ContinuationContextSnapshot,
  ContinuationContextTrace,
} from '../src/services/continuation/generation/types';
import type {
  ContinuationChapterPosition,
  SourceChapterPosition,
} from '../src/types/novel';
import {
  appendContinuationGenerationTraceEvent,
  createContinuationGenerationTrace,
  createContinuationBatchTraceId,
  ensureContinuationGenerationTrace,
} from '../src/services/continuation/generation/continuationGenerationTrace';
import { buildContinuationBatchChapterInstruction } from '../src/services/multiChapterBatch/continuationBatchInstruction';

const asContinuationPosition = (value: number) =>
  value as ContinuationChapterPosition;

function makeSnapshot(instruction = '推进当前章节冲突'): ContinuationContextSnapshot {
  return {
    schemaVersion: 2,
    workflowVersion: 2,
    projectId: 7,
    targetChapterId: 101,
    targetPosition: asContinuationPosition(3),
    source: {
      projectId: 7,
      sourceId: 11,
      sourceVersion: 2,
      normalizedSha256: 'source-hash',
      parserVersion: 'parser-v1',
      normalizationVersion: 'normalizer-v1',
      boundary: {
        chapterId: 20,
        chapterPosition: 2 as SourceChapterPosition,
        charOffsetExclusive: 456,
      },
    } as unknown as ContinuationContextSnapshot['source'],
    canon: {
      snapshotId: 'canon-1',
      revision: 4,
      boundaryGlobalCharOffset: 456,
      capabilities: {} as ContinuationContextSnapshot['canon']['capabilities'],
    },
    storyMemory: {
      stateFingerprint: 'memory-hash',
      throughPosition: asContinuationPosition(2),
      status: 'ready',
    },
    inputRevisionHash: 'input-hash',
    contextBudget: {
      modelContextLimit: 32768,
      inputBudget: 24000,
      reservedOutputTokens: 4000,
      writerMaxOutputTokens: 4000,
    },
    primaryAnchor: {
      kind: 'continuation_chapter',
      chapterId: 20,
      position: asContinuationPosition(2),
      sourceId: 11,
      sourceVersion: 2,
      sourceSha256: 'source-hash',
      charOffsetExclusive: 456,
      summary: '上一章接缝',
      excerpt: '上一章结尾',
    } as unknown as ContinuationContextSnapshot['primaryAnchor'],
    settingsSnapshot: {
      schemaVersion: 1,
      workflowVersion: 5,
      values: {} as ContinuationContextSnapshot['settingsSnapshot']['values'],
      resolvedModelConfigIds: {
        planner: 1,
        writer: 2,
        checker: 3,
        repair: 4,
        stateExtraction: 5,
        control: 6,
        draftWriter: 7,
        narrativeArchitect: 8,
        revisionWriter: 9,
        adversarialAuditor: 10,
        finalReviser: 11,
      },
      frozenModelConfigs: {
        planner: null,
        writer: null,
        checker: null,
        repair: null,
        stateExtraction: null,
        control: null,
        draftWriter: null,
        narrativeArchitect: null,
        revisionWriter: null,
        adversarialAuditor: null,
        finalReviser: null,
      },
    },
    bundles: {
      lockedRules: ['只使用当前章节上下文'],
      canon: {} as ContinuationContextSnapshot['bundles']['canon'],
      effectiveState: {
        freshness: {
          canonReady: true,
          storyMemoryStatus: 'ready',
          pendingStateExtractionCount: 0,
          pendingMajorProposalCount: 0,
          dirtyFromPosition: null,
        },
      } as ContinuationContextSnapshot['bundles']['effectiveState'],
      seam: { summary: '接缝', excerpt: '接缝摘录' },
      recentChapters: [],
      storyMemory: {
        summary: 'memory',
        estimatedTokens: 10,
        throughPosition: asContinuationPosition(2),
      },
      episodic: [],
      style: null,
      userInstruction: instruction,
    },
    createdAt: '2026-08-15T00:00:00.000Z',
  };
}

function makeBaseTrace(): ContinuationContextTrace {
  return {
    sourceId: 11,
    canonSnapshotId: 'canon-1',
    canonRevision: 4,
    targetPosition: asContinuationPosition(3),
    entityRefs: [],
    storyMemoryFingerprint: 'memory-hash',
    freshness: {
      canonReady: true,
      storyMemoryStatus: 'ready',
      pendingStateExtractionCount: 0,
      pendingMajorProposalCount: 0,
    },
    categories: [],
    totalInputTokens: 12,
    reservedOutputTokens: 4000,
    inputBudget: 24000,
    modelContextLimit: 32768,
    omittedCapabilities: [],
  };
}

describe('Continuation unified Generation Trace V2', () => {
  test('keeps one trace identity across start, interruption, resume and completion', () => {
    const started = createContinuationGenerationTrace({
      snapshot: makeSnapshot(),
      trace: makeBaseTrace(),
      runId: 'ct_run_1',
      generationTraceId: 'gt_run_1',
      state: 'running',
      stage: 'round1',
    });
    const interrupted = appendContinuationGenerationTraceEvent(started, {
      event: 'interrupted',
      state: 'interrupted',
      stage: 'round1',
    });
    const resumed = appendContinuationGenerationTraceEvent(interrupted, {
      event: 'resume',
      state: 'running',
      stage: 'round1',
    });
    const completed = appendContinuationGenerationTraceEvent(resumed, {
      event: 'completed',
      state: 'completed',
      stage: 'final_validate',
      finalization: {
        status: 'finalized',
        finalizedRevisionHash: 'final-hash',
        completionReason: 'adopted',
      },
    });

    expect(completed.generationTraceId).toBe('gt_run_1');
    expect(completed.generationTrace?.events.map(event => event.event)).toEqual([
      'queued',
      'running',
      'interrupted',
      'resume',
      'completed',
    ]);
    expect(completed.generationTrace?.stateGate.currentState).toBe('completed');
    expect(completed.generationTrace?.finalization).toMatchObject({
      status: 'finalized',
      finalizedRevisionHash: 'final-hash',
      completionReason: 'adopted',
    });

    const resumedFromDb = ensureContinuationGenerationTrace(
      JSON.parse(JSON.stringify(completed)),
      makeSnapshot(),
      { runId: 'ct_run_1', state: 'completed', stage: 'final_validate' },
    );
    expect(resumedFromDb.generationTraceId).toBe('gt_run_1');
    expect(resumedFromDb.generationTrace?.events).toHaveLength(5);
  });

  test('backfills a stable identity for historical runs without weakening legacy trace fields', () => {
    const legacy = makeBaseTrace();
    const hydrated = ensureContinuationGenerationTrace(legacy, makeSnapshot(), {
      runId: 'ct_historical_1',
      state: 'interrupted',
      stage: 'writer',
    });
    const hydratedAgain = ensureContinuationGenerationTrace(
      JSON.parse(JSON.stringify(hydrated)),
      makeSnapshot(),
      { runId: 'ct_historical_1', state: 'interrupted', stage: 'writer' },
    );

    expect(hydrated.generationTraceId).toBe(hydratedAgain.generationTraceId);
    expect(hydrated.generationTraceId).toMatch(/^gt_/);
    expect(hydrated.categories).toEqual(legacy.categories);
    expect(hydrated.totalInputTokens).toBe(legacy.totalInputTokens);
    expect(hydrated.generationTrace?.stateGate.currentState).toBe('interrupted');
  });

  test('records source/canon/tail/instruction/budget/request and gate evidence without prompt leakage', () => {
    const futureOnly = 'FUTURE_ONLY_CHAPTER_3_SECRET';
    const batch = {
      sourcePrompt: '完成本批续写',
      writingMode: 'continuation' as const,
    };
    const currentItem = {
      ordinal: 1,
      title: '当前章',
      synopsis: '当前章梗概',
      keyBeatsJson: JSON.stringify(['当前章事件']),
      carryIn: '当前章承接',
      carryOut: '当前章交接',
      targetWords: 3000,
    };
    const instruction = buildContinuationBatchChapterInstruction(batch, currentItem);
    expect(instruction).not.toContain(futureOnly);
    const trace = createContinuationGenerationTrace({
      snapshot: makeSnapshot(instruction),
      trace: makeBaseTrace(),
      runId: 'ct_batch_1',
      generationTraceId: 'gt_batch_1',
      batchTraceId: createContinuationBatchTraceId('batch_1'),
      chapterOrdinal: 1,
      chapterCount: 3,
      state: 'running',
      stage: 'round1',
    });
    const serialized = JSON.stringify(trace);

    expect(trace.generationTrace?.sourceSnapshot).toMatchObject({
      sourceId: 11,
      sourceVersion: 2,
      normalizedSha256: 'source-hash',
    });
    expect(trace.generationTrace?.canon).toEqual({
      snapshotId: 'canon-1',
      revision: 4,
    });
    expect(trace.generationTrace?.tail).toMatchObject({
      kind: 'continuation_chapter',
      position: 2,
    });
    expect(trace.generationTrace?.currentInstruction).toMatchObject({
      charCount: instruction.length,
    });
    expect(trace.generationTrace?.budget).toMatchObject({
      inputBudget: 24000,
      reservedOutputTokens: 4000,
    });
    expect(trace.generationTrace?.llmRequestIdentity.stageConfigIds).toEqual({
      planner: 1,
      writer: 2,
      checker: 3,
      repair: 4,
      stateExtraction: 5,
      control: 6,
      draftWriter: 7,
      narrativeArchitect: 8,
      revisionWriter: 9,
      adversarialAuditor: 10,
      finalReviser: 11,
    });
    expect(serialized).not.toContain(futureOnly);
    expect(serialized).not.toContain(instruction);
  });

  test('gives a three-chapter batch one lineage with independent chapter fingerprints', () => {
    const batchTraceId = createContinuationBatchTraceId('batch_n3');
    const traces = [1, 2, 3].map(ordinal =>
      createContinuationGenerationTrace({
        snapshot: {
          ...makeSnapshot(`当前第${ordinal}章`),
          targetChapterId: 100 + ordinal,
          targetPosition: (ordinal + 2) as ContinuationChapterPosition,
        },
        trace: makeBaseTrace(),
        runId: `ct_n3_${ordinal}`,
        generationTraceId: `gt_n3_${ordinal}`,
        batchTraceId,
        chapterOrdinal: ordinal,
        chapterCount: 3,
        state: 'running',
        stage: 'round1',
      }),
    );

    expect(traces.map(trace => trace.batchTraceId)).toEqual([
      batchTraceId,
      batchTraceId,
      batchTraceId,
    ]);
    expect(traces.map(trace => trace.generationTrace?.lineage.chapterOrdinal)).toEqual([
      1,
      2,
      3,
    ]);
    expect(new Set(traces.map(trace => trace.generationTrace?.lineage.chapterFingerprint)).size).toBe(3);
    expect(traces.every(trace => trace.generationTrace?.lineage.chapterCount === 3)).toBe(true);
  });
});
