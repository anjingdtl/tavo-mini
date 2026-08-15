/**
 * Outline pipeline V5-Lite — workflow version routing (Phase 0).
 *
 * Covers:
 *   - shouldFreezeOutlineWorkflowV2 remains available for historical V2
 *   - shouldFreezeOutlineWorkflowV3 gating (outline/chapter/id>0/default=3)
 *   - snapshot serialize/parse round-trip of outlineWorkflowVersion
 *   - legacy tasks without the field stay V1 (undefined)
 *   - invalid version values fail closed
 */
import {
  parsePersistedPipelineTaskContext,
  serializePipelineTaskContext,
} from '../src/services/pipelineTaskContext';
import {
  DEFAULT_OUTLINE_WORKFLOW_VERSION,
  CURRENT_CONTEXT_BUDGET_VERSION,
  PHASE2_CONTEXT_BUDGET_VERSION,
  resolveNewChapterContextBudgetVersion,
  shouldFreezeOutlineWorkflowV2,
  shouldFreezeOutlineWorkflowV3,
  type ContextBudgetVersion,
  type OutlineWorkflowVersion,
} from '../src/services/pipeline/outlineWorkflowVersion';
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
  return {
    pipelineMode: 'full',
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

describe('shouldFreezeOutlineWorkflowV2', () => {
  test('freezes V2 for real outline chapter when default is 2', () => {
    expect(
      shouldFreezeOutlineWorkflowV2({
        projectMode: 'outline',
        chapterId: 12,
        defaultVersion: 2,
      }),
    ).toBe(true);
  });

  test('never V2 when default is 1 (production rollback)', () => {
    expect(
      shouldFreezeOutlineWorkflowV2({
        projectMode: 'outline',
        chapterId: 12,
        defaultVersion: 1,
      }),
    ).toBe(false);
  });

  test('freeform pseudo-chapter (id 0) stays V1', () => {
    expect(
      shouldFreezeOutlineWorkflowV2({
        projectMode: 'outline',
        chapterId: 0,
        defaultVersion: 2,
      }),
    ).toBe(false);
  });

  test('continuation projects never freeze V2 via outline pipeline', () => {
    expect(
      shouldFreezeOutlineWorkflowV2({
        projectMode: 'continuation',
        chapterId: 12,
        defaultVersion: 2,
      }),
    ).toBe(false);
  });

  test('historical freeform project mode never V2', () => {
    expect(
      shouldFreezeOutlineWorkflowV2({
        projectMode: 'freeform',
        chapterId: 12,
        defaultVersion: 2,
      }),
    ).toBe(false);
  });

  test('missing project mode never V2 (unconfirmable resume path)', () => {
    expect(
      shouldFreezeOutlineWorkflowV2({
        projectMode: undefined,
        chapterId: 12,
        defaultVersion: 2,
      }),
    ).toBe(false);
  });

  test('default constant is 1 until A/B passes', () => {
    expect(DEFAULT_OUTLINE_WORKFLOW_VERSION).toBe(1);
  });

  test('freezes V3 for real outline chapter when default is 3', () => {
    expect(
      shouldFreezeOutlineWorkflowV3({
        projectMode: 'outline',
        chapterId: 12,
        defaultVersion: 3,
      }),
    ).toBe(true);
  });

  test('freeform pseudo-chapter (id 0) stays out of V3', () => {
    expect(
      shouldFreezeOutlineWorkflowV3({
        projectMode: 'outline',
        chapterId: 0,
        defaultVersion: 3,
      }),
    ).toBe(false);
  });
});

describe('snapshot outlineWorkflowVersion round-trip', () => {
  test('serialize/parse preserves outlineWorkflowVersion=2', () => {
    const ser = serializePipelineTaskContext({
      draftContext: snap(),
      execution: execution({ outlineWorkflowVersion: 2 }),
    });
    const parsed = parsePersistedPipelineTaskContext(ser);
    expect(parsed.execution?.outlineWorkflowVersion).toBe(2);
  });

  test('serialize/parse preserves outlineWorkflowVersion=1', () => {
    const ser = serializePipelineTaskContext({
      draftContext: snap(),
      execution: execution({ outlineWorkflowVersion: 1 }),
    });
    const parsed = parsePersistedPipelineTaskContext(ser);
    expect(parsed.execution?.outlineWorkflowVersion).toBe(1);
  });

  test('legacy task without the field parses as undefined (V1)', () => {
    const ser = serializePipelineTaskContext({
      draftContext: snap(),
      execution: execution(),
    });
    const parsed = parsePersistedPipelineTaskContext(ser);
    expect(parsed.execution?.outlineWorkflowVersion).toBeUndefined();
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
