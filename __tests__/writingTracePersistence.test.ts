import {
  parsePersistedPipelineTaskContext,
  serializePipelineTaskContext,
} from '../src/services/pipelineTaskContext';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';
import type { PipelineExecutionSnapshot } from '../src/types/pipelineExecution';
import type { WritingKernelTrace } from '../src/services/writing/contracts/frozenWritingContext';
import type { WritingSourceTrace } from '../src/services/writing/contracts/writingSource';
import { mergePostFreezeKernelTrace } from '../src/services/writing/productionWritingEntry';
import { buildFinalArtifactSummary } from '../src/services/writing/finalArtifact';

function context(): PipelineContextSnapshot {
  const sourceTrace: WritingSourceTrace = {
    scenario: 'outline',
    sourceAdapter: 'OutlineWritingAdapter',
    sourceCandidateCount: 4,
    mandatoryCount: 4,
    preferredCount: 0,
    optionalCount: 0,
    sourceFingerprint: 'source-fingerprint',
    rejectedSources: [],
    missingSources: [],
  };
  const kernelTrace: WritingKernelTrace = {
    version: 1,
    writingRunId: 'wr_trace-persistence',
    generationTraceId: 'gt_trace-persistence',
    scenario: 'outline',
    sourceFingerprint: 'source-fingerprint',
    contextPlanFingerprint: 'plan-fingerprint',
    allocationFingerprint: 'allocation-fingerprint',
    renderFingerprint: 'render-fingerprint',
    freezeFingerprint: 'freeze-fingerprint',
    events: [
      { stage: 'collect', status: 'completed' },
      { stage: 'freeze', status: 'completed' },
    ],
    silentContextLossCount: 0,
    unexpectedLiveReadCount: 0,
    fatalCount: 0,
    falseAppliedRequirementCount: 0,
  };
  return {
    presetText: 'preset',
    storyMemoryText: '',
    characterText: '',
    noteText: '',
    worldbookText: '',
    episodicMemoryText: '',
    recentBridgeText: '',
    currentInstructionText: '继续本章',
    retrievalUserPrompt: '',
    outlineText: '继续推进',
    outlineFingerprint: 'outline-fingerprint',
    outlineIds: [1],
    outlineComplete: true,
    outlineEstimatedTokens: 10,
    projectId: 1,
    chapterId: 2,
    createdAt: 1,
    snapshotVersion: 1,
    writingSourceTrace: sourceTrace,
    writingKernelTrace: kernelTrace,
  };
}

function execution(): PipelineExecutionSnapshot {
  const stageReasoning = {
    draft: {
      stage: 'draft' as const,
      requestedTier: 'high' as const,
      effectiveTier: 'high' as const,
      thinking: 'enabled' as const,
      effort: 'high' as const,
      supported: true,
    },
    review: {
      stage: 'review' as const,
      requestedTier: 'high' as const,
      effectiveTier: 'high' as const,
      thinking: 'enabled' as const,
      effort: 'high' as const,
      supported: true,
    },
    factCheck: {
      stage: 'factCheck' as const,
      requestedTier: 'high' as const,
      effectiveTier: 'low' as const,
      thinking: 'enabled' as const,
      effort: 'low' as const,
      supported: true,
    },
    brief: {
      stage: 'brief' as const,
      requestedTier: 'high' as const,
      effectiveTier: 'high' as const,
      thinking: 'enabled' as const,
      effort: 'high' as const,
      supported: true,
    },
    proof: {
      stage: 'proof' as const,
      requestedTier: 'high' as const,
      effectiveTier: 'high' as const,
      thinking: 'enabled' as const,
      effort: 'high' as const,
      supported: true,
    },
  };
  return {
    pipelineMode: 'full',
    outlineWorkflowVersion: 4,
    contextBudgetVersion: 5,
    finalReviserReasoningPolicyVersion: 3,
    reasoningEffort: 'high',
    reasoningProfileVersion: 5,
    requestedReasoningTier: 'high',
    stageReasoning,
    briefPolicyVersion: 4,
    briefVisibleOutputFloor: 1200,
    briefReasoningHeadroom: 1200,
    briefMaxTokens: 4096,
    draftMaxTokens: 4000,
    reviewMaxTokens: 1500,
    factCheckMaxTokens: 1500,
    proofMaxTokens: 4000,
    draftPresetId: null,
    reviewPresetId: null,
    factCheckPresetId: null,
    proofPresetId: null,
    draftPreset: null,
    reviewPreset: null,
    factCheckPreset: null,
    proofPreset: null,
    model: {
      llmConfigId: 1,
      provider: 'openai_compatible',
      modelName: 'model-a',
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
    createdAt: 1,
  };
}

describe('Writing Trace persistence', () => {
  test('bridges facade trace events onto the durable Freeze without source drift', () => {
    const durable = context().writingKernelTrace!;
    const facade = {
      ...durable,
      writingRunId: 'wr_facade-run',
      sourceFingerprint: 'facade-source-fingerprint',
      events: [
        ...durable.events,
        { stage: 'draft' as const, status: 'started' as const },
        { stage: 'postWritingUpdate' as const, status: 'completed' as const },
      ],
    };

    const merged = mergePostFreezeKernelTrace(durable, facade);

    expect(merged.sourceFingerprint).toBe(durable.sourceFingerprint);
    expect(merged.events).toEqual([
      ...durable.events,
      { stage: 'draft', status: 'started' },
      { stage: 'postWritingUpdate', status: 'completed' },
    ]);
  });

  test('B1: carries the Final Artifact summary onto the durable Freeze trace', () => {
    const durable = context().writingKernelTrace!;
    const body = '最终稿正文。';
    const summary = buildFinalArtifactSummary({
      chapterId: 9,
      generationTraceId: durable.generationTraceId,
      qualityProfile: 'standard',
      draftBody: body,
      finalBody: body,
      finalizedAt: '2026-08-26T00:00:00.000Z',
    });
    const facade = {
      ...durable,
      events: [...durable.events, { stage: 'persist' as const, status: 'completed' as const }],
      finalArtifactSummary: summary,
    };

    const merged = mergePostFreezeKernelTrace(durable, facade);

    expect(merged.finalArtifactSummary).toEqual(summary);
    expect(merged.finalArtifactSummary!.sourceKind).toBe('draft');
  });

  test('B1: durable trace without summary stays summary-free (historical)', () => {
    const durable = context().writingKernelTrace!;
    const facade = {
      ...durable,
      events: [...durable.events, { stage: 'persist' as const, status: 'completed' as const }],
    };
    const merged = mergePostFreezeKernelTrace(durable, facade);
    expect(merged.finalArtifactSummary).toBeUndefined();
  });

  test('preserves source and Kernel traces across post-draft reserialization', () => {
    const first = serializePipelineTaskContext({
      draftContext: context(),
      execution: execution(),
      trace: {
        version: 1,
        generationTraceId: 'gt_trace-persistence',
        createdAt: 1,
      },
    });
    const parsed = parsePersistedPipelineTaskContext(first);

    const second = serializePipelineTaskContext({
      draftContext: parsed.draftContext,
      auditContext: parsed.draftContext,
      execution: parsed.execution!,
      frozenDraftRequest: parsed.frozenDraftRequest,
      frozenAuditCandidates: parsed.frozenAuditCandidates,
      trace: parsed.trace,
      createdAt: parsed.createdAt,
      draftCompletedAt: 2,
      auditContextCreatedAt: 2,
    });
    const reparsed = parsePersistedPipelineTaskContext(second);

    expect(reparsed.draftContext.writingSourceTrace).toEqual(
      context().writingSourceTrace,
    );
    expect(reparsed.draftContext.writingKernelTrace).toEqual(
      context().writingKernelTrace,
    );
    expect(reparsed.auditContext?.writingSourceTrace).toEqual(
      context().writingSourceTrace,
    );
    expect(reparsed.auditContext?.writingKernelTrace).toEqual(
      context().writingKernelTrace,
    );
  });

  test('accepts the unified QA stage when resuming a frozen trace', () => {
    const draft = context();
    draft.writingKernelTrace = {
      ...draft.writingKernelTrace!,
      events: [
        ...draft.writingKernelTrace!.events,
        { stage: 'qa', status: 'started' },
        { stage: 'qa', status: 'completed' },
      ],
    };
    const serialized = serializePipelineTaskContext({
      draftContext: draft,
      execution: execution(),
      createdAt: 1,
    });

    const parsed = parsePersistedPipelineTaskContext(serialized);

    expect(
      parsed.draftContext.writingKernelTrace?.events.slice(-2),
    ).toEqual([
      { stage: 'qa', status: 'started' },
      { stage: 'qa', status: 'completed' },
    ]);
  });
});
