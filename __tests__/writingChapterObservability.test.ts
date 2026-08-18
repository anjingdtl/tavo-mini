/**
 * Phase 0 observability contract.
 *
 * These gates lock the four call kinds apart and prove instrumentation
 * does not change Freeze identity or One-Shot paid-call accounting.
 */
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import {
  classifyWritingLlmCall,
  createWritingPhysicalRequestAccounting,
  finalizeWritingKernelObservability,
  measureDuplicateContext,
  measureStageContextProjection,
  measureStructuralChapterObservability,
  parseWritingChapterObservability,
  percentileMs,
  recordPostWritingObservability,
  resetWritingObservabilityForTests,
  runWritingStages,
  summarizeWritingLlmCalls,
} from '../src/services/writing';
import { executeSharedWriterStage } from '../src/services/writing/stages/writerCore';
import * as stageLlmCall from '../src/services/writing/stages/stageLlmCall';
import { setSecureLLMApiKey } from '../src/services/secureStorage';
import {
  continuationRequest,
  outlineRequest,
} from './helpers/oneShotFixtures';

beforeEach(() => {
  resetWritingObservabilityForTests();
});

describe('Writing chapter observability contract', () => {
  test('the four call kinds stay distinct and never collapse into one API count', () => {
    expect(classifyWritingLlmCall({})).toBe('logical_stage');
    expect(classifyWritingLlmCall({ isFormatter: true })).toBe('formatter');
    expect(classifyWritingLlmCall({ isPostWriting: true })).toBe(
      'post_writing_auxiliary',
    );
    expect(
      classifyWritingLlmCall({ isFormatter: true, isPostWriting: true }),
    ).toBe('post_writing_auxiliary');

    const llm = summarizeWritingLlmCalls([
      {
        kind: 'logical_stage',
        stage: 'draft',
        inputTokens: 100,
        outputTokens: 50,
        physicalRequestCount: 2,
        protocolFallbackCount: 1,
        promptCacheHitTokens: 40,
        promptCacheMissTokens: 60,
        durationMs: 10,
      },
      {
        kind: 'formatter',
        stage: 'draft',
        inputTokens: 20,
        outputTokens: 10,
        physicalRequestCount: 1,
        protocolFallbackCount: 0,
        promptCacheHitTokens: null,
        promptCacheMissTokens: null,
        durationMs: 5,
      },
      {
        kind: 'post_writing_auxiliary',
        stage: 'state_extraction',
        inputTokens: 30,
        outputTokens: 8,
        physicalRequestCount: 1,
        protocolFallbackCount: 0,
        promptCacheHitTokens: null,
        promptCacheMissTokens: null,
        durationMs: 7,
      },
    ]);

    expect(llm.logicalStageCallCount).toBe(1);
    expect(llm.formatterCallCount).toBe(1);
    expect(llm.physicalRequestCount).toBe(4);
    expect(llm.protocolFallbackCount).toBe(1);
    expect(llm.chapterWritingPaidCallCount).toBe(2);
    expect(llm.postWritingAuxiliaryCallCount).toBe(1);
    expect(llm.chapterWritingPaidCallCount + llm.postWritingAuxiliaryCallCount).not.toBe(
      llm.physicalRequestCount,
    );
  });

  test('physical request accounting counts protocol_fallback separately', async () => {
    const accounting = createWritingPhysicalRequestAccounting();
    await accounting.hooks.beforeRequest?.({ kind: 'primary' });
    await accounting.hooks.beforeRequest?.({ kind: 'protocol_fallback' });
    expect(accounting.snapshot()).toEqual({
      physicalRequestCount: 2,
      protocolFallbackCount: 1,
    });
  });

  test('P50 / P95 are defined and do not invent values for an empty set', () => {
    expect(percentileMs([], 50)).toBeNull();
    expect(percentileMs([437000], 50)).toBe(437000);
    expect(percentileMs([437000], 95)).toBe(437000);
    expect(percentileMs([100, 200, 300, 400, 500], 50)).toBe(300);
  });

  test('instrumentation does not change the freeze fingerprint', () => {
    const request = outlineRequest({});
    const first = buildWritingKernelFreezeTrace({ request });
    resetWritingObservabilityForTests();
    const second = buildWritingKernelFreezeTrace({ request });
    expect(first.frozenContext.freezeFingerprint).toBe(
      second.frozenContext.freezeFingerprint,
    );
    expect(first.frozenContext.freezeFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test('standard outline structurally pays five writer stages; audit is formal skipped', () => {
    const { frozenContext } = buildWritingKernelFreezeTrace({
      request: outlineRequest({}),
    });
    const snapshot = measureStructuralChapterObservability({
      frozenContext,
      sampleKind: 'outline_standard',
    });
    const executed = snapshot.stages.filter(stage => stage.status !== 'skipped');
    const skipped = snapshot.stages.filter(stage => stage.status === 'skipped');
    expect(executed.map(stage => stage.stage)).toEqual([
      'draft',
      'review',
      'factCheck',
      'revision',
      'proof',
    ]);
    expect(skipped).toEqual([
      expect.objectContaining({
        stage: 'audit',
        status: 'skipped',
        policyRuleId: 'policy.outline.review_covers_audit',
      }),
    ]);
    expect(snapshot.llm.logicalStageCallCount).toBe(5);
    expect(snapshot.llm.formatterCallCount).toBe(0);
    expect(snapshot.llm.chapterWritingPaidCallCount).toBe(5);
    expect(snapshot.llm.postWritingAuxiliaryCallCount).toBe(0);
    expect(snapshot.context.duplicateContextTokens).toBeGreaterThan(0);
    expect(snapshot.context.duplicateContextRatio).toBeGreaterThan(0);
    expect(snapshot.context.frozenContextTokens).toBeGreaterThan(0);
    expect(
      snapshot.stages.filter(stage => stage.status !== 'skipped').every(
        stage => stage.frozenContextTokens === snapshot.context.frozenContextTokens,
      ),
    ).toBe(true);
  });

  test('standard continuation structurally pays five writer stages; factCheck is formal skipped', () => {
    const { frozenContext } = buildWritingKernelFreezeTrace({
      request: continuationRequest({}),
    });
    const snapshot = measureStructuralChapterObservability({
      frozenContext,
      sampleKind: 'continuation_standard',
    });
    expect(
      snapshot.stages.filter(stage => stage.status !== 'skipped').map(stage => stage.stage),
    ).toEqual(['draft', 'review', 'audit', 'revision', 'proof']);
    expect(snapshot.stages.find(stage => stage.stage === 'factCheck')).toEqual(
      expect.objectContaining({
        status: 'skipped',
        policyRuleId: 'policy.continuation.audit_covers_factcheck',
      }),
    );
    expect(snapshot.llm.chapterWritingPaidCallCount).toBe(5);
  });

  test('one-shot chapter writing paid calls stay 1 and exclude post-writing auxiliary', () => {
    const { frozenContext, trace } = buildWritingKernelFreezeTrace({
      request: outlineRequest({ executionProfile: 'one_shot' }),
    });
    const snapshot = measureStructuralChapterObservability({
      frozenContext,
      sampleKind: 'one_shot',
    });
    expect(snapshot.executionProfile).toBe('one_shot');
    expect(snapshot.llm.chapterWritingPaidCallCount).toBe(1);
    expect(snapshot.llm.logicalStageCallCount).toBe(1);
    expect(snapshot.llm.formatterCallCount).toBe(0);
    expect(
      snapshot.stages.filter(stage => stage.status === 'skipped').map(stage => stage.stage),
    ).toEqual(['review', 'audit', 'factCheck', 'revision', 'proof']);
    expect(snapshot.context.duplicateContextRatio).toBe(0);

    recordPostWritingObservability({
      generationTraceId: trace.generationTraceId,
      kind: 'story_memory',
      durationMs: 12,
      blockingMs: 12,
      physicalRequestCount: 0,
    });
    const finalized = finalizeWritingKernelObservability(trace, frozenContext);
    expect(finalized.observability?.llm.chapterWritingPaidCallCount).toBe(0);
    expect(finalized.observability?.llm.postWritingAuxiliaryCallCount).toBe(1);
    expect(finalized.observability?.postWriting.storyMemoryUpdateMs).toBe(12);
  });

  test('runWritingStages records logical vs formatter vs persist timings', async () => {
    await setSecureLLMApiKey('sk-obs', 7);
    const { frozenContext, trace } = buildWritingKernelFreezeTrace({
      request: outlineRequest({}),
    });
    const persist = {
      persistMs: 0,
      persistStageArtifact: jest.fn(async () => {
        persist.persistMs += 1;
      }),
    };
    const transport = jest
      .spyOn(stageLlmCall, 'callWritingStageLLM')
      .mockResolvedValueOnce({
        text: '观测用初稿正文。',
        inputTokens: 11,
        outputTokens: 22,
        totalTokens: 33,
        physicalRequestCount: 1,
        protocolFallbackCount: 0,
      } as any)
      .mockResolvedValueOnce({
        text: JSON.stringify({
          content: '审阅通过',
          verdict: 'pass',
          findings: [],
        }),
        inputTokens: 15,
        outputTokens: 8,
        totalTokens: 23,
        physicalRequestCount: 2,
        protocolFallbackCount: 1,
      } as any);
    try {
      await runWritingStages({
        frozenContext,
        trace,
        stages: ['draft', 'review'],
        persistAdapter: persist as any,
      });
      const finalized = finalizeWritingKernelObservability(trace, frozenContext);
      const obs = finalized.observability!;
      expect(obs.llm.logicalStageCallCount).toBe(2);
      expect(obs.llm.formatterCallCount).toBe(0);
      expect(obs.llm.physicalRequestCount).toBe(3);
      expect(obs.llm.protocolFallbackCount).toBe(1);
      expect(obs.llm.inputTokens).toBe(26);
      expect(obs.llm.outputTokens).toBe(30);
      expect(obs.stages.map(stage => stage.stage)).toEqual(['draft', 'review']);
      expect(obs.stages.every(stage => stage.stageExecutionMs >= 0)).toBe(true);
      expect(obs.stages.every(stage => stage.stageDependencyWaitMs === 0)).toBe(
        true,
      );
      expect(obs.chapterE2EMs).toBeGreaterThanOrEqual(0);
      expect(persist.persistStageArtifact).toHaveBeenCalled();
    } finally {
      transport.mockRestore();
    }
  });

  test('standard formatter rescue is counted as formatter, not a second logical stage', async () => {
    await setSecureLLMApiKey('sk-obs', 7);
    const { frozenContext, trace } = buildWritingKernelFreezeTrace({
      request: outlineRequest({}),
    });
    const transport = jest
      .spyOn(stageLlmCall, 'callWritingStageLLM')
      .mockResolvedValueOnce({
        text: '',
        reasoningText: '只有推理。',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        emptyReason: 'reasoning_only',
        physicalRequestCount: 1,
        protocolFallbackCount: 0,
      } as any)
      .mockResolvedValueOnce({
        text: 'Formatter 整理出的正文。',
        inputTokens: 6,
        outputTokens: 9,
        totalTokens: 15,
        physicalRequestCount: 1,
        protocolFallbackCount: 0,
      } as any);
    try {
      const artifact = await executeSharedWriterStage({
        stage: 'draft',
        stageInput: {
          frozenContext,
          artifacts: {},
          requirements: frozenContext.requirements,
          stagePolicy: frozenContext.stagePolicy,
          modelConfig: {
            configId: 7,
            name: 'obs',
            providerType: 'openai_compatible',
            url: 'https://obs.example/v1/chat/completions',
            modelName: 'obs',
            contextWindow: 65536,
            maxOutputTokens: 2048,
            credentialRef: { kind: 'llm-config-api-key', configId: 7 },
          },
          trace,
        } as any,
      });
      expect(artifact.formatterUsed).toBe(true);
      expect(artifact.usage?.logicalStageCallCount).toBe(1);
      expect(artifact.usage?.formatterCallCount).toBe(1);
      expect(artifact.usage?.physicalRequestCount).toBe(2);
      const finalized = finalizeWritingKernelObservability(trace, frozenContext);
      expect(finalized.observability?.llm.logicalStageCallCount).toBe(1);
      expect(finalized.observability?.llm.formatterCallCount).toBe(1);
      expect(finalized.observability?.llm.chapterWritingPaidCallCount).toBe(2);
    } finally {
      transport.mockRestore();
    }
  });

  test('stacked previous artifacts increase duplicate context tokens', () => {
    const { frozenContext } = buildWritingKernelFreezeTrace({
      request: outlineRequest({ sourceScale: 3 }),
    });
    const draftOnly = measureStageContextProjection({
      stage: 'draft',
      frozenContext,
      artifacts: {},
    });
    const reviewWithDraft = measureStageContextProjection({
      stage: 'review',
      frozenContext,
      artifacts: {
        draft: { stage: 'draft', body: '初稿正文。'.repeat(80) },
      },
    });
    const proofWithStack = measureStageContextProjection({
      stage: 'proof',
      frozenContext,
      artifacts: {
        draft: { stage: 'draft', body: '初稿正文。'.repeat(80) },
        review: { stage: 'review', body: '审阅报告。'.repeat(20) },
        factCheck: { stage: 'factCheck', body: '事实核查。'.repeat(20) },
        revision: { stage: 'revision', body: '修订合同。'.repeat(20) },
      },
    });
    const duplicate = measureDuplicateContext({
      frozenContext,
      projections: [draftOnly, reviewWithDraft, proofWithStack],
    });
    expect(draftOnly.carriesFullFrozenContext).toBe(true);
    expect(reviewWithDraft.carriesFullFrozenContext).toBe(false);
    expect(proofWithStack.previousArtifactKeys).toEqual(
      expect.arrayContaining(['draft', 'review', 'factCheck', 'revision']),
    );
    expect(proofWithStack.artifactTokens).toBeGreaterThan(0);
    expect(duplicate.duplicateContextTokens).toBeGreaterThan(0);
  });

  test('observability JSON round-trips without collapsing call kinds', () => {
    const { frozenContext } = buildWritingKernelFreezeTrace({
      request: outlineRequest({}),
    });
    const observability = measureStructuralChapterObservability({
      frozenContext,
      sampleKind: 'outline_standard',
    });
    const parsed = parseWritingChapterObservability(
      JSON.parse(JSON.stringify(observability)),
    );
    expect(parsed?.llm.logicalStageCallCount).toBe(5);
    expect(parsed?.llm.formatterCallCount).toBe(0);
    expect(parsed?.llm.chapterWritingPaidCallCount).toBe(5);
    expect(parsed?.llm.postWritingAuxiliaryCallCount).toBe(0);
    expect(parsed?.context.duplicateContextTokens).toBeGreaterThan(0);
    expect(parsed?.sampleKind).toBe('outline_standard');
  });
});
