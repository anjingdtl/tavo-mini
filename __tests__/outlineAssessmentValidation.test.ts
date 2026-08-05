/**
 * outlineAssessment validation + repair schema regression tests
 * (大纲模式升级缺漏修复 — P0).
 */
import {
  buildReviewMessages,
  buildReviewRepairMessages,
} from '../src/services/pipelineMessages';
import { validateReviewResult } from '../src/services/pipelineAuditValidator';
import type { LLMResult } from '../src/services/llm/types';
import type { ReviewContext } from '../src/types/pipelineContext';

function llm(
  partial: Partial<LLMResult> & { text?: string | null },
): LLMResult {
  return {
    text: partial.text ?? null,
    reasoningText: partial.reasoningText ?? null,
    inputTokens: partial.inputTokens ?? 1,
    outputTokens: partial.outputTokens ?? 1,
    totalTokens: partial.totalTokens ?? 2,
    finishReason: partial.finishReason ?? 'stop',
  };
}

const DRAFT = '夜色笼罩古城，主角拔剑走向城门。'.repeat(12);

const validAssessment = {
  status: 'aligned',
  fulfilledBeats: ['抵达城门'],
  missingBeats: [],
  deviations: [],
  prematureBeats: [],
  factRollbackRisks: [],
};

const outlineContext: ReviewContext = {
  presetText: '',
  characterText: '',
  noteText: '',
  worldbookText: '',
  storyMemoryText: '',
  episodicMemoryText: '',
  recentBridgeText: '',
  currentInstructionText: '',
  retrievalUserPrompt: '',
  outlineText: '【项目大纲】主角将在第三章揭开身世。',
};

describe('validateReviewResult outlineAssessment', () => {
  test('accepts legal outlineAssessment when hasOutline=true', () => {
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: ['节奏稳'],
          issues: [],
          suggestions: [],
          outlineAssessment: validAssessment,
        }),
      }),
      DRAFT,
      { hasOutline: true },
    );
    expect(result.valid).toBe(true);
    expect(result.report?.outlineAssessment?.status).toBe('aligned');
    expect(result.normalizedText).toContain('outlineAssessment');
    expect(result.normalizedText).toContain('fulfilledBeats');
  });

  test('rejects illegal status', () => {
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: [],
          issues: [],
          suggestions: [],
          outlineAssessment: { ...validAssessment, status: 'ok' },
        }),
      }),
      DRAFT,
      { hasOutline: true },
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unexpected_shape');
  });

  test('rejects missing assessment arrays', () => {
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: [],
          issues: [],
          suggestions: [],
          outlineAssessment: { status: 'aligned' },
        }),
      }),
      DRAFT,
      { hasOutline: true },
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unexpected_shape');
  });

  test('rejects empty string array elements', () => {
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: [],
          issues: [],
          suggestions: [],
          outlineAssessment: {
            ...validAssessment,
            missingBeats: ['  '],
          },
        }),
      }),
      DRAFT,
      { hasOutline: true },
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unexpected_shape');
  });

  test('rejects unknown fields inside outlineAssessment', () => {
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: [],
          issues: [],
          suggestions: [],
          outlineAssessment: {
            ...validAssessment,
            extra: 'nope',
          },
        }),
      }),
      DRAFT,
      { hasOutline: true },
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unexpected_shape');
  });

  test('requires outlineAssessment when hasOutline=true', () => {
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: [],
          issues: [],
          suggestions: [],
        }),
      }),
      DRAFT,
      { hasOutline: true },
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_required_fields');
  });

  test('legacy three-field format still passes without outline', () => {
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: ['好'],
          issues: [],
          suggestions: [],
        }),
      }),
      DRAFT,
      { hasOutline: false },
    );
    expect(result.valid).toBe(true);
    expect(result.report?.outlineAssessment).toBeUndefined();
  });

  test('rejects outlineAssessment when hasOutline=false', () => {
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: [],
          issues: [],
          suggestions: [],
          outlineAssessment: validAssessment,
        }),
      }),
      DRAFT,
      { hasOutline: false },
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unexpected_shape');
  });
});

describe('review repair schema keeps outlineAssessment', () => {
  test('repair prompt requires outlineAssessment when outline present', () => {
    const messages = buildReviewRepairMessages(
      DRAFT,
      outlineContext,
      'unexpected_shape',
    );
    const last = messages[messages.length - 1].content;
    expect(last).toContain('outlineAssessment');
    expect(last).toContain('fulfilledBeats');
    expect(last).toContain('over_advanced');
  });

  test('repair prompt keeps three-field schema without outline', () => {
    const messages = buildReviewRepairMessages(
      DRAFT,
      { ...outlineContext, outlineText: '' },
      'unexpected_shape',
    );
    const last = messages[messages.length - 1].content;
    expect(last).toContain('strengths');
    expect(last).not.toContain('outlineAssessment');
  });

  test('review system schema mentions outlineAssessment when outline present', () => {
    const messages = buildReviewMessages(DRAFT, outlineContext);
    const system = messages.find(m => m.role === 'system')!.content;
    expect(system).toContain('outlineAssessment');
  });
});
