import {
  resolveV33StageReasoning,
  type PipelineReasoningTier,
} from '../src/services/pipeline/reasoningPolicy';
import { buildReviewV33Messages } from '../src/services/pipelineMessages';
import { allocateOutlinePipelineBudgetV3 } from '../src/services/contextAutoAllocator';
import {
  parsePersistedPipelineTaskContext,
  serializePipelineTaskContext,
} from '../src/services/pipelineTaskContext';
import { getPipelineStageOrder } from '../src/utils/stages';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';
import type { PipelineExecutionSnapshot } from '../src/types/pipelineExecution';

const MODEL = {
  provider_type: 'openai_compatible' as const,
  model_name: 'model-a',
  url: 'https://example.com/v1',
};

function context(): PipelineContextSnapshot {
  return {
    presetText: 'preset',
    storyMemoryText: '',
    characterText: 'character',
    noteText: '',
    worldbookText: 'worldbook',
    episodicMemoryText: '',
    recentBridgeText: '',
    currentInstructionText: '继续本章',
    retrievalUserPrompt: '',
    outlineText: '停在门前',
    outlineFingerprint: 'outline-fp',
    outlineIds: [1],
    outlineComplete: true,
    outlineEstimatedTokens: 10,
    projectId: 1,
    chapterId: 2,
    createdAt: Date.now(),
    snapshotVersion: 1,
  };
}

function currentExecution(): PipelineExecutionSnapshot {
  const requestedTier: PipelineReasoningTier = 'high';
  const tiers: Record<
    'draft' | 'review' | 'factCheck' | 'brief' | 'proof',
    PipelineReasoningTier
  > = {
    draft: 'high',
    review: 'high',
    factCheck: 'low',
    brief: 'high',
    proof: 'high',
  };
  const stageReasoning = Object.fromEntries(
    Object.entries(tiers).map(([stage, effectiveTier]) => [
      stage,
      {
        stage,
        requestedTier,
        effectiveTier,
        thinking: 'enabled',
        effort: effectiveTier,
        supported: true,
      },
    ]),
  ) as PipelineExecutionSnapshot['stageReasoning'];
  return {
    pipelineMode: 'full',
    outlineWorkflowVersion: 4,
    contextBudgetVersion: 5,
    finalReviserReasoningPolicyVersion: 3,
    reasoningEffort: 'high',
    reasoningProfileVersion: 5,
    requestedReasoningTier: requestedTier,
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
      name: 'Model',
      provider: 'openai_compatible',
      modelName: 'model-a',
      contextWindow: 128000,
      maxOutputTokens: 8192,
    },
    createdAt: Date.now(),
  };
}

describe('current unified outline pipeline', () => {
  test('uses the selected tier for Draft/Review/Brief/Final while FactCheck remains low', () => {
    for (const tier of ['low', 'high', 'max'] as const) {
      for (const stage of ['draft', 'review', 'brief', 'proof'] as const) {
        expect(resolveV33StageReasoning(tier, stage, MODEL)).toMatchObject({
          effectiveTier: tier,
          effort: tier,
          thinking: { type: 'enabled' },
        });
      }
      expect(resolveV33StageReasoning(tier, 'factCheck', MODEL)).toMatchObject({
        effectiveTier: 'low',
        effort: 'low',
        thinking: { type: 'enabled' },
      });
    }
    expect(
      resolveV33StageReasoning('max', 'review', MODEL).downgradeReason,
    ).toBeUndefined();
    expect(
      resolveV33StageReasoning('max', 'factCheck', MODEL).downgradeReason,
    ).toContain('FactCheck');
  });

  test('Review prompt delegates the effective tier to the frozen request', () => {
    const system = String(
      buildReviewV33Messages({
        canonicalDraft: '[draft-p-001] 初稿。',
        context: context(),
      })[0].content,
    );
    expect(system).toContain('按本次任务冻结的有效 Thinking 档位执行');
    expect(system).not.toContain('保持 low Thinking');
  });

  test('current budget allocation keeps Review at MAX while FactCheck stays low', () => {
    const allocation = allocateOutlinePipelineBudgetV3({
      contextWindow: 128000,
      modelMaxOutputTokens: 8192,
      requestedTier: 'max',
    });
    expect(allocation.stages.review.effectiveTier).toBe('max');
    expect(allocation.stages.factCheck.effectiveTier).toBe('low');
  });

  test('current pipeline stage order stays full for the frozen snapshot', () => {
    expect(
      getPipelineStageOrder('noReview', {
        outlineWorkflowVersion: 4,
        contextBudgetVersion: 5,
      }),
    ).toEqual(['draft', 'review', 'factCheck', 'brief', 'proof']);
  });

  test('round-trips the current frozen workflow snapshot', () => {
    const serialized = serializePipelineTaskContext({
      draftContext: context(),
      execution: currentExecution(),
    });
    expect(serialized.pipelineContextVersion).toBe(4);
    const parsed = parsePersistedPipelineTaskContext(serialized);
    expect(parsed.version).toBe(4);
    expect(parsed.execution).toMatchObject({
      outlineWorkflowVersion: 4,
      contextBudgetVersion: 5,
      reasoningProfileVersion: 5,
      briefPolicyVersion: 4,
      pipelineMode: 'full',
    });
  });
});
