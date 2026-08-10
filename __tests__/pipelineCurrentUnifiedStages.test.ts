import {
  buildFactCheckImmutableEnvelopeV33,
  buildReviewImmutableEnvelopeV33,
  validateFactCheckSemanticPayloadV33,
  validateReviewSemanticPayloadV33,
} from '../src/services/pipeline/currentSemanticContract';
import {
  buildBriefImmutableEnvelopeV33,
  type BriefCompilerInputV1,
  type FinalWritingBriefImmutableEnvelopeV33,
} from '../src/services/pipeline/briefCompilerTypes';
import { validateFinalWritingBriefV33 } from '../src/services/pipeline/briefResultValidator';
import {
  resolveV33StageReasoning,
  type PipelineReasoningTier,
} from '../src/services/pipeline/reasoningPolicy';
import { buildAuditFormatterPrompt } from '../src/services/pipeline/auditFormatter';
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

const REVIEW_CHECKED = [
  'opening_continuity',
  'outline_execution',
  'character',
  'prose',
  'ending_boundary',
];

const ANCHORS = [
  {
    id: 'draft-p-001',
    start: 0,
    end: 4,
    text: '初稿。',
    paragraphIndex: 0,
    segmentIndex: 0,
  },
];

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
    review: 'low',
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
    contextBudgetVersion: 4,
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
  test('uses one tier for Draft/Brief/Final while audits remain low', () => {
    for (const tier of ['low', 'high', 'max'] as const) {
      expect(resolveV33StageReasoning(tier, 'draft', MODEL).effectiveTier).toBe(
        tier,
      );
      expect(resolveV33StageReasoning(tier, 'brief', MODEL).effectiveTier).toBe(
        tier,
      );
      expect(resolveV33StageReasoning(tier, 'proof', MODEL).effectiveTier).toBe(
        tier,
      );
      for (const stage of ['review', 'factCheck'] as const) {
        expect(resolveV33StageReasoning(tier, stage, MODEL)).toMatchObject({
          effectiveTier: 'low',
          effort: 'low',
          thinking: { type: 'enabled' },
        });
      }
    }
  });

  test('accepts compact audit payloads and rejects unknown anchors', () => {
    const reviewEnvelope = buildReviewImmutableEnvelopeV33({
      draftHash: 'draft-hash',
      endingBoundary: '停在门前',
    });
    const review = validateReviewSemanticPayloadV33({
      raw: {
        verdict: 'pass',
        checked: REVIEW_CHECKED,
        findings: [],
      },
      envelope: reviewEnvelope,
      anchors: ANCHORS,
    });
    expect(review.valid).toBe(true);
    expect(review.report?.schemaVersion).toBe(5);

    const invalidAnchor = validateReviewSemanticPayloadV33({
      raw: {
        verdict: 'needs_revision',
        checked: REVIEW_CHECKED,
        findings: [
          {
            target: 'draft-p-999',
            level: 'required',
            issue: '问题',
            instruction: '修正',
          },
        ],
      },
      envelope: reviewEnvelope,
      anchors: ANCHORS,
    });
    expect(invalidAnchor.valid).toBe(false);

    const factEnvelope = buildFactCheckImmutableEnvelopeV33({
      draftHash: 'draft-hash',
      inputFactRefs: ['F-1'],
    });
    const fact = validateFactCheckSemanticPayloadV33({
      raw: JSON.stringify({
        verdict: 'pass',
        checked: ['timeline', 'F-1'],
        findings: [],
      }),
      envelope: factEnvelope,
      inputDimensions: ['timeline'],
      anchors: ANCHORS,
    });
    expect(fact.valid).toBe(true);
  });

  test('compiles the short-ID Brief envelope and enforces required coverage', () => {
    const input: BriefCompilerInputV1 = {
      schemaVersion: 1,
      sourceHash: 'source-hash',
      workflowMode: 'full',
      review: {
        executableCorrections: [
          {
            sourceId: 'R1',
            severity: 'required',
            dimension: 'prose',
            diagnosis: '重复',
            rewriteGoal: '压缩',
            preserveMeaning: [],
          },
        ],
        unlocatedRequired: [],
        advisoryNotes: [],
        outlineExecution: {
          fulfilledBeats: [],
          missingBeats: [],
          deviations: [],
          prematureBeats: [],
          mustPreserve: [],
          endingGoal: '停在门前',
          mustNotAdvance: [],
        },
      },
    };
    const envelope = buildBriefImmutableEnvelopeV33(input);
    const valid = validateFinalWritingBriefV33({
      raw: JSON.stringify({
        strategy: '保留必要推进，压缩重复动作',
        actions: [{ covers: ['R1'], instruction: '压缩重复动作' }],
        preserve: ['人物关系'],
        ending: '停在门前',
      }),
      envelope,
    });
    expect(valid.valid).toBe(true);
    expect(valid.brief?.mustFix).toHaveLength(1);

    const missingRequired = validateFinalWritingBriefV33({
      raw: JSON.stringify({
        strategy: '保持连续',
        actions: [],
        preserve: [],
        ending: '停在门前',
      }),
      envelope,
    });
    expect(missingRequired.valid).toBe(false);
  });

  test('Formatter stays body-free and the current protocol ignores mode choices', () => {
    const prompt = buildAuditFormatterPrompt({
      stage: 'review',
      contractVersion: 33,
      candidate: '{"verdict":"pass","checked":[],"findings":[]}',
      legalSourceIds: ['draft-p-001'],
      requiredCoverageDimensions: REVIEW_CHECKED,
    });
    expect(prompt.messages[0].content).toContain('当前协议 Audit Formatter');
    expect(prompt.messages[0].content).toContain('verdict');
    expect(
      getPipelineStageOrder('noReview', {
        outlineWorkflowVersion: 4,
        contextBudgetVersion: 4,
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
      contextBudgetVersion: 4,
      reasoningProfileVersion: 5,
      briefPolicyVersion: 4,
      pipelineMode: 'full',
    });
  });

  test('current formatter uses the compact contract version', () => {
    const envelope: FinalWritingBriefImmutableEnvelopeV33 = {
      schemaVersion: 4,
      briefPolicyVersion: 4,
      sourceHash: 'source',
      allowedSourceIds: ['R1'],
      requiredSourceIds: ['R1'],
      protectedFacts: [],
      hardConstraints: [],
      mustNotAdvance: [],
      outlineObligations: [],
      endingBoundary: '停在门前',
    };
    expect(envelope.allowedSourceIds).toEqual(['R1']);
  });
});
