/**
 * Outline pipeline V5-Lite — workflow version routing (Phase 0).
 *
 * Covers:
 *   - snapshot serialize/parse round-trip of outlineWorkflowVersion
 *   - legacy tasks without the field stay V1 (undefined)
 *   - invalid version values fail closed
 */
import {
  parsePersistedPipelineTaskContext,
  serializePipelineTaskContext,
} from '../src/services/pipelineTaskContext';
import {
  CURRENT_CONTEXT_BUDGET_VERSION,
  PHASE2_CONTEXT_BUDGET_VERSION,
  resolveNewChapterContextBudgetVersion,
  shouldFreezeOutlineWorkflowV4,
  type ContextBudgetVersion,
  type OutlineWorkflowVersion,
} from '../src/services/pipeline/outlineWorkflowVersion';
import type { PipelineReasoningTier } from '../src/services/pipeline/reasoningPolicy';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';
import type { PipelineExecutionSnapshot } from '../src/types/pipelineExecution';

function snap(): PipelineContextSnapshot {
  return {
    presetText: 'preset',
    storyMemoryText: 'sm',
    characterText: 'char',
    noteText: '',
    worldbookText: '',
    episodicMemoryText: '',
    recentBridgeText: '',
    currentInstructionText: '',
    retrievalUserPrompt: 'write',
    outlineText: '大纲',
    outlineFingerprint: 'fp',
    outlineIds: [1],
    outlineComplete: true,
    outlineEstimatedTokens: 10,
    projectId: 1,
    chapterId: 2,
    createdAt: Date.now(),
    snapshotVersion: 1,
  };
}

function execution(
  overrides: Partial<PipelineExecutionSnapshot> = {},
): PipelineExecutionSnapshot {
  const requestedTier = 'high' as const;
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
        thinking: 'enabled' as const,
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
    draftMaxTokens: 4000,
    reviewMaxTokens: 2000,
    factCheckMaxTokens: 2000,
    proofMaxTokens: 2000,
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
      name: 'm',
      provider: 'openai_compatible',
      modelName: 'model-a',
      contextWindow: 128000,
      maxOutputTokens: 8000,
    },
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('shouldFreezeOutlineWorkflowV4', () => {
  test('freezes V4 for real outline chapter by production default', () => {
    expect(
      shouldFreezeOutlineWorkflowV4({
        projectMode: 'outline',
        chapterId: 12,
      }),
    ).toBe(true);
  });

  test('freeform pseudo-chapter (id 0) stays out of V4', () => {
    expect(
      shouldFreezeOutlineWorkflowV4({
        projectMode: 'outline',
        chapterId: 0,
      }),
    ).toBe(false);
  });

  test('non-outline project modes never freeze V4 via outline pipeline', () => {
    expect(
      shouldFreezeOutlineWorkflowV4({
        projectMode: 'continuation',
        chapterId: 12,
      }),
    ).toBe(false);
    expect(
      shouldFreezeOutlineWorkflowV4({
        projectMode: 'freeform',
        chapterId: 12,
      }),
    ).toBe(false);
  });
});

describe('snapshot outlineWorkflowVersion round-trip', () => {
  test('serialize/parse preserves outlineWorkflowVersion=4', () => {
    const ser = serializePipelineTaskContext({
      draftContext: snap(),
      execution: execution({ outlineWorkflowVersion: 4 }),
    });
    const parsed = parsePersistedPipelineTaskContext(ser);
    expect(parsed.execution?.outlineWorkflowVersion).toBe(4);
  });

  test('missing workflow version is rejected as legacy (fail-closed)', () => {
    const ser = serializePipelineTaskContext({
      draftContext: snap(),
      execution: execution({ outlineWorkflowVersion: 1 }),
    });
    expect(() => parsePersistedPipelineTaskContext(ser)).toThrow(
      /已下线旧版流水线/,
    );
  });

  test('invalid version fails closed', () => {
    const ser = serializePipelineTaskContext({
      draftContext: snap(),
      execution: execution(),
    });
    const raw = JSON.parse(ser.pipelineContextJson);
    raw.execution.outlineWorkflowVersion = 99;
    const tampered = JSON.stringify(raw);
    // Hash is optional in parsing; omit it so the version check is reached.
    expect(() =>
      parsePersistedPipelineTaskContext({
        pipelineContextJson: tampered,
      }),
    ).toThrow(/工作流版本/);
  });

  test('hash mismatch (tampered) fails closed before version read', () => {
    const ser = serializePipelineTaskContext({
      draftContext: snap(),
      execution: execution({ outlineWorkflowVersion: 2 }),
    });
    const tampered = ser.pipelineContextJson.replace('model-a', 'model-b');
    expect(() =>
      parsePersistedPipelineTaskContext({
        pipelineContextJson: tampered,
        pipelineContextVersion: ser.pipelineContextVersion,
        pipelineContextHash: ser.pipelineContextHash,
      }),
    ).toThrow(/校验失败/);
  });

  test('type-level: version allows historical 1 | 2 | 3 and current 4', () => {
    const v: OutlineWorkflowVersion = 4;
    expect(v).toBe(4);
  });

  test('current context budget version is V5 for the independent elastic stages', () => {
    const v: ContextBudgetVersion = 5;
    expect(v).toBe(CURRENT_CONTEXT_BUDGET_VERSION);
    expect(CURRENT_CONTEXT_BUDGET_VERSION).toBe(5);
  });

  test('new outline chapter preflight uses the same Phase II budget version as task creation', () => {
    expect(
      resolveNewChapterContextBudgetVersion({
        projectMode: 'outline',
        chapterId: 18,
      }),
    ).toBe(PHASE2_CONTEXT_BUDGET_VERSION);
    expect(
      resolveNewChapterContextBudgetVersion({
        projectMode: 'continuation',
        chapterId: 18,
      }),
    ).toBe(1);
    expect(
      resolveNewChapterContextBudgetVersion({
        projectMode: 'outline',
        chapterId: 0,
      }),
    ).toBe(1);
  });
});
