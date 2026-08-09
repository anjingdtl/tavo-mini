import {
  buildBriefImmutableEnvelopeV31,
  type BriefCompilerInputV1,
} from '../src/services/pipeline/briefCompilerTypes';
import { validateFinalWritingBriefV31 } from '../src/services/pipeline/briefResultValidator';
import { validateFinalBriefCompliance } from '../src/services/pipeline/finalBriefComplianceValidator';
import {
  validateFactCheckV3Result,
  validateReviewV3Result,
} from '../src/services/pipeline/revisionAuditValidator';
import { adaptV31AuditResult } from '../src/services/pipeline/v31AuditCompatibility';
import {
  resolveV31StageReasoning,
  structuredOutputCompatibilityForConfig,
} from '../src/services/pipeline/reasoningPolicy';
import { buildAuditFormatterPrompt } from '../src/services/pipeline/auditFormatter';
import { buildBriefContractFormatterPrompt } from '../src/services/pipeline/briefFormatter';
import { getPipelineStageOrder } from '../src/utils/stages';
import {
  determineNextPipelineAction,
  type PersistedPipelineTaskView,
  type PersistedStageCheckpoint,
} from '../src/services/pipeline';
import type { PipelineMode, PipelineStageName } from '../src/types/pipeline';
import type { LLMResult } from '../src/services/llm/types';

const MODEL = {
  provider_type: 'openai_compatible' as const,
  model_name: 'deepseek-v4-flash',
  url: 'https://api.deepseek.com',
};

function result(
  text: string | null,
  reasoningText: string | null = null,
): LLMResult {
  return {
    text,
    reasoningText,
    finishReason: 'stop',
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    reasoningTokens: reasoningText ? 12 : 0,
    visibleOutputTokens: text ? 8 : 0,
  };
}

function reviewPayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 3,
    draftHash: 'draft-hash',
    corrections: [
      {
        id: 'r1',
        severity: 'required',
        category: 'opening_continuity',
        target: {
          kind: 'scene',
          sceneHint: '门口',
          evidenceQuote: '门声再次响起',
        },
        finding: '开头缺少上一章的门声承接。',
        instruction: '在开头补上门声及人物反应。',
        preserve: ['人物仍在旧宅。'],
        sourceRefs: ['seam-1'],
      },
    ],
    protectedFacts: [],
    outlineExecution: {
      fulfilledBeats: ['抵达旧宅'],
      missingBeats: [],
      deviations: [],
      prematureBeats: [],
      mustPreserve: ['人物仍在旧宅。'],
      endingGoal: '停在门声之后的选择。',
      mustNotAdvance: ['不得揭示幕后身份。'],
    },
    ...overrides,
  };
}

function briefInput(): BriefCompilerInputV1 {
  return {
    schemaVersion: 1,
    sourceHash: 'brief-source-hash',
    workflowMode: 'full',
    review: {
      executableCorrections: [
        {
          sourceId: 'r1',
          severity: 'required',
          dimension: 'opening_continuity',
          diagnosis: '缺少承接',
          rewriteGoal: '补上门声',
          preserveMeaning: ['人物仍在旧宅。'],
          locationHint: 'opening',
        },
      ],
      unlocatedRequired: [],
      advisoryNotes: [],
      outlineExecution: {
        fulfilledBeats: ['抵达旧宅'],
        missingBeats: [],
        deviations: [],
        prematureBeats: [],
        mustPreserve: ['人物仍在旧宅。'],
        endingGoal: '停在门声之后的选择。',
        mustNotAdvance: ['不得揭示幕后身份。'],
      },
    },
    factCheck: {
      corrections: [],
      protectedFacts: ['门声来自东侧。'],
      hardConstraints: ['不得揭示幕后身份。'],
    },
  };
}

function checkpoint(
  stage: PipelineStageName,
  status: PersistedStageCheckpoint['status'],
): PersistedStageCheckpoint {
  return {
    stage,
    status,
    outputText: status === 'succeeded' ? `${stage}-evidence` : null,
  };
}

function v31Task(
  pipelineMode: PipelineMode,
  overrides: Partial<PersistedPipelineTaskView> = {},
): PersistedPipelineTaskView {
  return {
    id: 'v31-state-test',
    pipelineMode,
    status: 'failed',
    hasExecutionSnapshot: true,
    hasDraftContext: true,
    hasAuditContext: true,
    finalText: null,
    outlineWorkflowVersion: 3,
    contextBudgetVersion: 3,
    ...overrides,
  };
}

describe('ShineWriter V3.1 contracts', () => {
  test('semantic Review accepts a target without hard anchor locators', () => {
    const validation = validateReviewV3Result({
      result: result(JSON.stringify(reviewPayload())),
      expectedHash: 'draft-hash',
      anchors: [],
      strictSemantic: true,
    });
    expect(validation.valid).toBe(true);
    expect(validation.report?.executableCorrections[0]).toEqual(
      expect.objectContaining({
        sourceId: 'r1',
        locationHint: 'middle',
        sceneHint: '门口',
        evidenceQuote: '门声再次响起',
        sourceRefs: ['seam-1'],
      }),
    );
  });

  test('reasoning-only Review can be parsed locally from a fenced JSON object', () => {
    const validation = validateReviewV3Result({
      result: result(
        '',
        `先整理合同：\n\`\`\`json\n${JSON.stringify(reviewPayload())}\n\`\`\``,
      ),
      expectedHash: 'draft-hash',
      anchors: [],
      strictSemantic: true,
    });
    expect(validation.valid).toBe(true);
  });

  test('advisory is a safe alias and does not require executable instruction', () => {
    const validation = validateReviewV3Result({
      result: result(
        JSON.stringify(
          reviewPayload({
            corrections: [
              {
                id: 'style-1',
                severity: 'advisory',
                category: 'style',
                target: { kind: 'middle' },
                finding: '个别句子略显拥挤。',
              },
            ],
          }),
        ),
      ),
      expectedHash: 'draft-hash',
      anchors: [],
      strictSemantic: true,
    });
    expect(validation.valid).toBe(true);
    expect(validation.report?.executableCorrections).toEqual([]);
    expect(validation.report?.advisoryNotes.join(' ')).toContain(
      '句子略显拥挤',
    );
  });

  test('FactCheck with zero corrections is success, but missing hardConstraints fails', () => {
    const valid = validateFactCheckV3Result({
      result: result(
        JSON.stringify({
          schemaVersion: 3,
          draftHash: 'draft-hash',
          corrections: [],
          protectedFacts: [],
          hardConstraints: [],
        }),
      ),
      expectedHash: 'draft-hash',
      anchors: [],
      strictSemantic: true,
    });
    expect(valid.valid).toBe(true);
    expect(valid.report?.corrections).toEqual([]);

    const invalid = validateFactCheckV3Result({
      result: result(
        JSON.stringify({
          schemaVersion: 3,
          draftHash: 'draft-hash',
          corrections: [],
          protectedFacts: [],
        }),
      ),
      expectedHash: 'draft-hash',
      anchors: [],
      strictSemantic: true,
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.reason).toBe('missing_required_fields');
  });

  test('Brief immutable envelope overrides omitted or forged model fields', () => {
    const envelope = buildBriefImmutableEnvelopeV31(briefInput());
    const validation = validateFinalWritingBriefV31({
      envelope,
      raw: JSON.stringify({
        schemaVersion: 2,
        sourceHash: 'forged',
        hardConstraints: ['伪造约束'],
        coveredRequiredIds: [' REVIEW-r1 '],
        openingContinuity: ['从门声自然接续。'],
        mustFix: [
          {
            sourceIds: [' REVIEW-r1 '],
            target: { kind: 'opening' },
            instruction: '在开头补上门声及人物反应。',
            preserve: ['人物仍在旧宅。'],
          },
        ],
        mustPreserve: [],
        endingState: envelope.endingBoundary,
        styleAdvisories: [],
      }),
    });
    expect(validation.valid).toBe(true);
    expect(validation.brief).toMatchObject({
      sourceHash: envelope.sourceHash,
      hardConstraints: envelope.hardConstraints,
      requiredSourceIds: ['r1'],
      coveredRequiredIds: ['r1'],
    });
    expect(validation.warnings.join(' ')).toMatch(/不可变信封|sourceId/);
  });

  test('compact structured-output Brief may omit semantically empty fields only', () => {
    const envelope = {
      schemaVersion: 2 as const,
      sourceHash: 'brief-source-hash',
      requiredSourceIds: [],
      protectedFacts: ['沈岚仍在档案馆。'],
      hardConstraints: ['不得打开北塔。'],
      mustNotAdvance: ['不得打开北塔。'],
      outlineObligations: ['已覆盖：找到账册残页。'],
      endingBoundary: '账册残页被夹进目录。',
    };
    const validation = validateFinalWritingBriefV31({
      envelope,
      compatibility: 'compact-structured-output',
      raw: JSON.stringify({ schemaVersion: 2 }),
    });
    expect(validation.valid).toBe(true);
    expect(validation.brief).toMatchObject({
      requiredSourceIds: [],
      endingState: envelope.endingBoundary,
      protectedFacts: envelope.protectedFacts,
      hardConstraints: envelope.hardConstraints,
    });
    expect(validation.warnings.join(' ')).toContain('兼容结构化 JSON');
  });

  test('compact structured-output compatibility never bypasses required source coverage', () => {
    const envelope = buildBriefImmutableEnvelopeV31(briefInput());
    const validation = validateFinalWritingBriefV31({
      envelope,
      compatibility: 'compact-structured-output',
      raw: JSON.stringify({ schemaVersion: 2 }),
    });
    expect(validation.valid).toBe(false);
    expect(validation.error).toMatch(/required\/hard|覆盖/);
  });

  test('compact structured-output compatibility drops only unknown optional Brief findings', () => {
    const envelope = {
      schemaVersion: 2 as const,
      sourceHash: 'brief-source-hash',
      requiredSourceIds: [],
      protectedFacts: [],
      hardConstraints: [],
      mustNotAdvance: [],
      outlineObligations: [],
      endingBoundary: '',
    };
    const validation = validateFinalWritingBriefV31({
      envelope,
      compatibility: 'compact-structured-output',
      raw: JSON.stringify({
        schemaVersion: 2,
        coveredRequiredIds: ['hallucinated-optional-id'],
        mustFix: [
          {
            sourceIds: ['hallucinated-optional-id'],
            target: { kind: 'middle' },
            instruction: '保持节奏。',
            preserve: [],
          },
        ],
        openingContinuity: [],
        mustPreserve: [],
        styleAdvisories: [],
      }),
    });
    expect(validation.valid).toBe(true);
    expect(validation.brief).toMatchObject({
      requiredSourceIds: [],
      coveredRequiredIds: [],
      mustFix: [],
    });
    expect(validation.warnings.join(' ')).toMatch(/未知可选/);
  });

  test('compact structured-output drops malformed optional findings without hard sources', () => {
    const envelope = {
      schemaVersion: 2 as const,
      sourceHash: 'brief-source-hash',
      requiredSourceIds: [],
      protectedFacts: [],
      hardConstraints: [],
      mustNotAdvance: [],
      outlineObligations: [],
      endingBoundary: '',
    };
    const validation = validateFinalWritingBriefV31({
      envelope,
      compatibility: 'compact-structured-output',
      raw: JSON.stringify({
        schemaVersion: 2,
        mustFix: [{ description: '模型给出的可选建议，但没有 sourceId' }],
        openingContinuity: [],
        mustPreserve: [],
        styleAdvisories: [],
      }),
    });
    expect(validation.valid).toBe(true);
    expect(validation.brief?.mustFix).toEqual([]);
    expect(validation.warnings.join(' ')).toContain('无法归属');
  });

  test('the same compact compatibility applies across configured LLMs', () => {
    expect(
      structuredOutputCompatibilityForConfig({
        provider_type: 'openai_compatible',
        model_name: 'deepseek-v4-flash',
        url: 'https://api.deepseek.com/chat/completions',
      }),
    ).toBe('compact-structured-output');
    expect(
      structuredOutputCompatibilityForConfig({
        provider_type: 'openai_compatible',
        model_name: 'another-strong-model',
        url: 'https://gateway.example.com/chat/completions',
      }),
    ).toBe('compact-structured-output');
  });

  test('Final compliance does not derive forbidden words from mustFix instructions', () => {
    const envelope = buildBriefImmutableEnvelopeV31(briefInput());
    const brief = {
      ...envelope,
      coveredRequiredIds: envelope.requiredSourceIds,
      openingContinuity: [],
      mustFix: [
        {
          sourceIds: ['r1'],
          target: { kind: 'opening' as const },
          instruction: '补充坐标并保持动作连续。',
          preserve: [],
        },
      ],
      mustPreserve: [],
      endingState: envelope.endingBoundary,
      styleAdvisories: [],
    };
    expect(
      validateFinalBriefCompliance({
        text: '她补充了坐标，随后停在门边。',
        brief,
      }).valid,
    ).toBe(true);
  });

  test('all V3.1 audit/Brief tiers are low while Draft/Final follow request', () => {
    for (const requested of ['low', 'high', 'max'] as const) {
      expect(
        resolveV31StageReasoning(requested, 'review', MODEL).effectiveTier,
      ).toBe('low');
      expect(
        resolveV31StageReasoning(requested, 'factCheck', MODEL).effectiveTier,
      ).toBe('low');
      expect(
        resolveV31StageReasoning(requested, 'brief', MODEL).effectiveTier,
      ).toBe('low');
      expect(
        resolveV31StageReasoning(requested, 'draft', MODEL).effectiveTier,
      ).toBe(requested);
      expect(
        resolveV31StageReasoning(requested, 'proof', MODEL).effectiveTier,
      ).toBe(requested);
      expect(
        resolveV31StageReasoning(requested, 'review', MODEL).thinking,
      ).toEqual({
        type: 'disabled',
      });
      expect(
        resolveV31StageReasoning(requested, 'factCheck', MODEL).thinking,
      ).toEqual({ type: 'disabled' });
      expect(
        resolveV31StageReasoning(requested, 'brief', MODEL).thinking,
      ).toEqual({
        type: 'disabled',
      });
      expect(
        resolveV31StageReasoning(requested, 'draft', MODEL).thinking,
      ).toEqual({
        type: 'enabled',
      });
      expect(
        resolveV31StageReasoning(requested, 'proof', MODEL).thinking,
      ).toEqual({
        type: 'enabled',
      });
    }
  });

  test('adapts recognized legacy audit JSON without accepting arbitrary objects', () => {
    const legacyReview = adaptV31AuditResult(
      result(
        JSON.stringify({
          strengths: ['场景关系清楚'],
          issues: ['开头承接略显突兀'],
          suggestions: ['补一处上一章结尾的动作回声'],
          outlineAssessment: {
            status: 'aligned',
            fulfilledBeats: ['抵达旧宅'],
            missingBeats: [],
            deviations: [],
            prematureBeats: [],
            factRollbackRisks: [],
          },
        }),
      ),
      'review',
      'draft-hash',
    );
    expect(legacyReview.adaptation).toBe('legacy_review_shape');
    expect(
      validateReviewV3Result({
        result: legacyReview.result,
        expectedHash: 'draft-hash',
        anchors: [],
        strictSemantic: true,
      }).valid,
    ).toBe(true);

    const legacyFactCheck = adaptV31AuditResult(
      result(
        JSON.stringify({
          errors: [
            {
              category: 'timeline',
              description: '时间点与近期正文不一致',
              suggestedAction: '按近期正文修正时间点',
            },
          ],
          warnings: [],
          confirmed: ['铜钥匙仍在布包内'],
        }),
      ),
      'factCheck',
      'draft-hash',
    );
    expect(legacyFactCheck.adaptation).toBe('legacy_fact_check_shape');
    expect(
      validateFactCheckV3Result({
        result: legacyFactCheck.result,
        expectedHash: 'draft-hash',
        anchors: [],
        strictSemantic: true,
      }).valid,
    ).toBe(true);

    expect(
      adaptV31AuditResult(
        result(JSON.stringify({ answer: 'not an audit contract' })),
        'review',
        'draft-hash',
      ).adaptation,
    ).toBe('none');
  });

  test('Formatter prompts contain no Draft/context and force disabled Thinking', () => {
    const audit = buildAuditFormatterPrompt({
      stage: 'review',
      candidate: JSON.stringify({ id: 'r1', finding: '已有判断' }),
    });
    expect(JSON.stringify(audit.messages)).not.toContain('长大纲正文');
    expect(JSON.stringify(audit.messages)).toContain('只整理已有判断');
    const brief = buildBriefContractFormatterPrompt({
      candidate: '已有 Brief 判断',
      envelope: buildBriefImmutableEnvelopeV31(briefInput()),
    });
    expect(JSON.stringify(brief.messages)).not.toContain('Draft 全文');
    expect(JSON.stringify(brief.messages)).toContain(
      '必须输出 message.content',
    );
  });

  test('V3.1 stage graph has five full stages and four audit paths', () => {
    expect(
      getPipelineStageOrder('full', {
        outlineWorkflowVersion: 3,
        contextBudgetVersion: 3,
      }),
    ).toEqual(['draft', 'review', 'factCheck', 'brief', 'proof']);
    expect(
      getPipelineStageOrder('twoStage', {
        outlineWorkflowVersion: 3,
        contextBudgetVersion: 3,
      }),
    ).toHaveLength(4);
    expect(
      getPipelineStageOrder('conditional', {
        outlineWorkflowVersion: 3,
        contextBudgetVersion: 3,
      }),
    ).toHaveLength(4);
    expect(
      getPipelineStageOrder('noReview', {
        outlineWorkflowVersion: 3,
        contextBudgetVersion: 3,
      }),
    ).toHaveLength(1);
    expect(
      getPipelineStageOrder('full', {
        outlineWorkflowVersion: 2,
        contextBudgetVersion: 2,
      }),
    ).toHaveLength(4);
  });

  test('V3.1 blocks every failed required node instead of degrading into Final', () => {
    const full = (
      review: PersistedStageCheckpoint['status'],
      factCheck: PersistedStageCheckpoint['status'],
      brief: PersistedStageCheckpoint['status'] = 'succeeded',
      proof: PersistedStageCheckpoint['status'] = 'pending',
    ) => [
      checkpoint('draft', 'succeeded'),
      checkpoint('review', review),
      checkpoint('factCheck', factCheck),
      checkpoint('brief', brief),
      checkpoint('proof', proof),
    ];
    expect(
      determineNextPipelineAction(v31Task('full'), full('failed', 'succeeded')),
    ).toMatchObject({
      type: 'blocked',
      reason: { stage: 'review', userAction: 'retry' },
    });
    expect(
      determineNextPipelineAction(v31Task('full'), full('succeeded', 'failed')),
    ).toMatchObject({
      type: 'blocked',
      reason: { stage: 'factCheck', userAction: 'retry' },
    });
    expect(
      determineNextPipelineAction(
        v31Task('full'),
        full('succeeded', 'succeeded', 'failed'),
      ),
    ).toMatchObject({
      type: 'blocked',
      reason: { stage: 'brief', userAction: 'retry' },
    });
    expect(
      determineNextPipelineAction(
        v31Task('full'),
        full('succeeded', 'succeeded', 'succeeded', 'skipped'),
      ),
    ).toMatchObject({
      type: 'blocked',
      reason: { stage: 'proof', userAction: 'retry' },
    });
  });
});
