import {
  buildAuditSourceManifest,
  buildFactCheckImmutableEnvelopeV32,
  buildReviewImmutableEnvelopeV32,
  validateFactCheckSemanticPayloadV32,
  validateReviewSemanticPayloadV32,
} from '../src/services/pipeline/auditSemanticEnvelope';
import { selectStructuredCandidate } from '../src/services/pipeline/structuredCandidate';
import {
  buildBriefCompilerMessages,
  calculateBriefBudget,
} from '../src/services/pipeline/compileBriefStageRequest';
import {
  type BriefCompilerInputV32,
  type FinalWritingBriefImmutableEnvelopeV32,
} from '../src/services/pipeline/briefCompilerTypes';
import { validateFinalWritingBriefV32 } from '../src/services/pipeline/briefResultValidator';
import {
  resolveV31StageReasoning,
  resolveV32StageReasoning,
} from '../src/services/pipeline/reasoningPolicy';
import { buildAuditFormatterPrompt } from '../src/services/pipeline/auditFormatter';
import { buildFactCheckV32Messages } from '../src/services/pipelineMessages';
import {
  buildSchema49CreateSqls,
  V49_ATTEMPT_COLUMNS,
} from '../src/services/migrations/v48-to-v49';

const MODEL = {
  provider_type: 'openai_compatible' as const,
  model_name: 'deepseek-v4-flash',
  url: 'https://api.deepseek.com',
};

const REVIEW_COVERAGE = [
  'opening_continuity',
  'outline_execution',
  'character',
  'prose',
  'ending_boundary',
];

function reviewPayload(overrides: Record<string, unknown> = {}) {
  return {
    verdict: 'pass',
    findings: [],
    outlineAssessment: {
      fulfilled: [],
      missing: [],
      deviations: [],
      premature: [],
      endingAssessment: '',
    },
    coverage: { checkedDimensions: REVIEW_COVERAGE },
    ...overrides,
  };
}

function factCheckPayload(overrides: Record<string, unknown> = {}) {
  return {
    verdict: 'pass',
    findings: [],
    confirmedFactRefs: ['fact-1'],
    coverage: {
      checkedDimensions: ['timeline'],
      checkedFactRefs: ['fact-1'],
    },
    ...overrides,
  };
}

function briefEnvelope(
  requiredSourceIds: string[] = [],
): FinalWritingBriefImmutableEnvelopeV32 {
  return {
    schemaVersion: 3,
    briefPolicyVersion: 3,
    sourceHash: 'local-source-hash',
    requiredSourceIds,
    protectedFacts: ['人物仍在旧宅。'],
    hardConstraints: ['不得揭示幕后身份。'],
    mustNotAdvance: ['不得提前揭示身份。'],
    outlineObligations: ['本章停在门声之后。'],
    endingBoundary: '停在门声之后的选择。',
  };
}

function briefInput(requiredSourceIds: string[]): BriefCompilerInputV32 {
  return {
    schemaVersion: 3,
    briefPolicyVersion: 3,
    sourceHash: 'local-source-hash',
    workflowMode: 'full',
    immutableEnvelope: briefEnvelope(requiredSourceIds),
  };
}

describe('ShineWriter V3.2 structured-stage contracts', () => {
  test('Review/FactCheck/Brief primary use enabled + low while V3.1 stays disabled', () => {
    expect(resolveV32StageReasoning('max', 'draft', MODEL)).toMatchObject({
      effectiveTier: 'max',
      thinking: { type: 'enabled' },
    });
    expect(resolveV32StageReasoning('max', 'proof', MODEL)).toMatchObject({
      effectiveTier: 'max',
      thinking: { type: 'enabled' },
    });
    for (const stage of ['review', 'factCheck', 'brief'] as const) {
      expect(resolveV32StageReasoning('max', stage, MODEL)).toMatchObject({
        effectiveTier: 'low',
        effort: 'low',
        thinking: { type: 'enabled' },
      });
      expect(resolveV31StageReasoning('max', stage, MODEL).thinking).toEqual({
        type: 'disabled',
      });
    }
  });

  test('formatter is explicitly body-free and disables Thinking by contract', () => {
    const prompt = buildAuditFormatterPrompt({
      stage: 'review',
      contractVersion: 32,
      candidate: JSON.stringify(reviewPayload()),
      legalSourceIds: ['review.1.prose.hash'],
    });
    expect(prompt.messages[0].content).toContain(
      '一次性的 V3.2 Audit Formatter',
    );
    expect(prompt.messages[0].content).toContain('不得重新分析');
    expect(prompt.messages[1].content).not.toContain('canonicalDraft');
    expect(prompt.legalSourceIds).toEqual(['review.1.prose.hash']);
  });

  test('selects the semantically fuller reasoning candidate when both channels exist', () => {
    const selection = selectStructuredCandidate({
      content: JSON.stringify({ verdict: 'pass', findings: [] }),
      reasoning: `整理结果：\n${JSON.stringify(reviewPayload())}`,
      expectedRootKeys: [
        'verdict',
        'findings',
        'outlineAssessment',
        'coverage',
      ],
      coverageKeys: REVIEW_COVERAGE,
    });
    expect(selection.responseChannel).toBe('both_reasoning_preferred');
    expect(selection.candidate?.channel).toBe('reasoning');
    expect(selection.candidate?.rootKeys).toEqual(
      expect.arrayContaining(['coverage', 'outlineAssessment']),
    );
  });

  test('Review fills only local envelope fields and rejects missing coverage', () => {
    const envelope = buildReviewImmutableEnvelopeV32({
      draftHash: 'local-draft-hash',
      endingBoundary: '停在门声之后。',
    });
    const valid = validateReviewSemanticPayloadV32({
      raw: reviewPayload(),
      envelope,
    });
    expect(valid.valid).toBe(true);
    expect(valid.report).toEqual(
      expect.objectContaining({
        schemaVersion: 4,
        auditContractVersion: 32,
        draftHash: 'local-draft-hash',
        immutableEnvelope: envelope,
      }),
    );

    const missingCoverage = validateReviewSemanticPayloadV32({
      raw: reviewPayload({ coverage: undefined }),
      envelope,
    });
    expect(missingCoverage.valid).toBe(false);
    expect(missingCoverage.details?.missingPaths).toContain('coverage');

    const missingFindings = validateReviewSemanticPayloadV32({
      raw: reviewPayload({ findings: undefined }),
      envelope,
    });
    expect(missingFindings.valid).toBe(false);
    expect(missingFindings.details?.missingPaths).toContain('findings');
  });

  test('Review needs_revision requires an executable finding', () => {
    const validation = validateReviewSemanticPayloadV32({
      raw: reviewPayload({ verdict: 'needs_revision' }),
      envelope: buildReviewImmutableEnvelopeV32({ draftHash: 'draft' }),
    });
    expect(validation.valid).toBe(false);
    expect(validation.details?.invalidPaths).toContain(
      'findings.required_or_hard',
    );
  });

  test('FactCheck accepts an empty finding set only with a coverage receipt', () => {
    const envelope = buildFactCheckImmutableEnvelopeV32({
      draftHash: 'local-draft-hash',
      inputFactRefs: ['fact-1'],
    });
    const valid = validateFactCheckSemanticPayloadV32({
      raw: factCheckPayload(),
      envelope,
      inputDimensions: ['timeline'],
    });
    expect(valid.valid).toBe(true);

    const missingReceipt = validateFactCheckSemanticPayloadV32({
      raw: factCheckPayload({
        coverage: { checkedDimensions: [], checkedFactRefs: [] },
        confirmedFactRefs: [],
      }),
      envelope,
      inputDimensions: ['timeline'],
    });
    expect(missingReceipt.valid).toBe(false);

    const missingFindings = validateFactCheckSemanticPayloadV32({
      raw: factCheckPayload({ findings: undefined }),
      envelope,
      inputDimensions: ['timeline'],
    });
    expect(missingFindings.valid).toBe(false);
    expect(missingFindings.details?.missingPaths).toContain('findings');
  });

  test('FactCheck prompt exposes only local input IDs for coverage receipts', () => {
    const messages = buildFactCheckV32Messages({
      canonicalDraft: 'draft',
      context: {} as any,
      inputFactRefs: ['fact.continuity.abc123'],
      inputDimensions: ['timeline'],
    });
    expect(messages[0].content).toContain('fact.continuity.abc123');
    expect(messages[0].content).toContain('不能使用 not_applicable');
    expect(messages[0].content).toContain('不要输出半条 finding');
    expect(messages[0].content).toContain('"checkedDimensions":["timeline"]');
  });

  test('FactCheck not_applicable is only valid when no fact-check input exists', () => {
    const envelope = buildFactCheckImmutableEnvelopeV32({ draftHash: 'draft' });
    const notApplicable = validateFactCheckSemanticPayloadV32({
      raw: {
        verdict: 'not_applicable',
        findings: [],
        confirmedFactRefs: [],
        coverage: { checkedDimensions: [], checkedFactRefs: [] },
      },
      envelope,
      inputDimensions: [],
    });
    expect(notApplicable.valid).toBe(true);
    expect(notApplicable.warnings).toContain('FACT_CONTEXT_EMPTY');

    const dishonest = validateFactCheckSemanticPayloadV32({
      raw: {
        verdict: 'not_applicable',
        findings: [],
        confirmedFactRefs: [],
        coverage: { checkedDimensions: [], checkedFactRefs: [] },
      },
      envelope,
      inputDimensions: ['timeline'],
    });
    expect(dishonest.valid).toBe(false);
  });

  test('Formatter source IDs are derived locally and invented IDs fail closed', () => {
    const finding = {
      severity: 'required',
      category: 'prose',
      target: { kind: 'scene' },
      finding: '开头缺少承接。',
      instruction: '补上门声及人物反应。',
    };
    const primary = reviewPayload({
      findings: [finding],
      verdict: 'needs_revision',
    });
    const legalSourceIds = buildAuditSourceManifest('review', primary);
    expect(legalSourceIds).toHaveLength(1);
    const envelope = buildReviewImmutableEnvelopeV32({ draftHash: 'draft' });
    const accepted = validateReviewSemanticPayloadV32({
      raw: {
        ...primary,
        findings: [{ ...finding, sourceId: legalSourceIds[0] }],
      },
      envelope,
      legalSourceIds,
    });
    expect(accepted.valid).toBe(true);

    const invented = validateReviewSemanticPayloadV32({
      raw: {
        ...primary,
        findings: [{ ...finding, sourceId: 'invented-source-id' }],
      },
      envelope,
      legalSourceIds,
    });
    expect(invented.valid).toBe(false);
  });

  test('Brief rejects no_changes with required IDs and accepts full coverage', () => {
    const envelope = briefEnvelope(['review.1.prose.hash']);
    const rejected = validateFinalWritingBriefV32({
      raw: JSON.stringify({
        verdict: 'no_changes',
        instructions: [],
        openingContinuity: ['保持门声承接。'],
        styleAdvisories: [],
      }),
      envelope,
    });
    expect(rejected.valid).toBe(false);

    const accepted = validateFinalWritingBriefV32({
      raw: JSON.stringify({
        verdict: 'apply_changes',
        instructions: [
          {
            sourceIds: ['review.1.prose.hash'],
            priority: 'required',
            target: 'opening',
            instruction: '补上门声及人物反应。',
            preserve: ['人物仍在旧宅。'],
          },
        ],
        openingContinuity: [],
        styleAdvisories: [],
      }),
      envelope,
    });
    expect(accepted.valid).toBe(true);
    expect(accepted.brief?.schemaVersion).toBe(3);
    expect(accepted.brief?.sourceHash).toBe('local-source-hash');
  });

  test('V3.2 Brief budget grows with required-source complexity instead of a fixed 2K cap', () => {
    const input = briefInput(
      Array.from({ length: 20 }, (_, index) => 'source-' + String(index + 1)),
    );
    const budget = calculateBriefBudget({
      input,
      contextWindow: 1_000_000,
      modelMaxOutputTokens: 1_000_000,
    });
    expect(budget.visibleOutputFloor).toBeGreaterThan(2048);
    expect(budget.reasoningHeadroom).toBeGreaterThanOrEqual(1024);
    expect(String(buildBriefCompilerMessages(input)[0].content)).toContain(
      'low Thinking',
    );
    expect(String(buildBriefCompilerMessages(input)[0].content)).toContain(
      '不能输出空数组',
    );
    expect(String(buildBriefCompilerMessages(input)[0].content)).toContain(
      '每个 hard/required sourceId 只能出现在一条逻辑 instruction 中',
    );
  });

  test('Schema 49 declares all structured-stage scratch and diagnostic columns', () => {
    const sql = buildSchema49CreateSqls().join('\n');
    for (const column of V49_ATTEMPT_COLUMNS) {
      expect(sql).toContain(column.ddl);
    }
    expect(sql).toContain('response_candidate_temp');
    expect(sql).toContain('response_candidate_channel');
    expect(sql).toContain('validation_details_json');
  });
});
