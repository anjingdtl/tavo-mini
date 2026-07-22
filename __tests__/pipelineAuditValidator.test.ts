import {
  describeAuditFailureReason,
  detectDraftEcho,
  extractAuditJsonPayload,
  formatAuditFailureMessage,
  validateFactCheckResult,
  validateReviewResult,
} from '../src/services/pipelineAuditValidator';
import type { LLMResult } from '../src/services/llm/types';

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

const DRAFT =
  '夜色笼罩古城，主角拔剑走向城门。风沙扑面，远处传来钟声。'.repeat(20);

describe('validateReviewResult', () => {
  test('accepts valid JSON report', () => {
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: ['节奏好'],
          issues: ['结尾仓促'],
          suggestions: ['补一段收束'],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(true);
    expect(result.report?.issues).toEqual(['结尾仓促']);
    expect(result.normalizedText).toContain('结尾仓促');
  });

  test('strips markdown fence and accepts', () => {
    const body = JSON.stringify({
      strengths: [],
      issues: ['人物动机不清'],
      suggestions: ['补充内心戏'],
    });
    const result = validateReviewResult(
      llm({ text: '```json\n' + body + '\n```' }),
      DRAFT,
    );
    expect(result.valid).toBe(true);
    expect(result.normalizedText).toBe(body);
  });

  test('missing required fields fails', () => {
    const result = validateReviewResult(
      llm({ text: JSON.stringify({ issues: ['a'], suggestions: ['b'] }) }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_required_fields');
  });

  test('non-array fields fail', () => {
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: '好',
          issues: [],
          suggestions: [],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unexpected_shape');
  });

  test('full novel body fails as novel_output or draft_echo', () => {
    const result = validateReviewResult(llm({ text: DRAFT }), DRAFT);
    expect(result.valid).toBe(false);
    expect(['novel_output', 'draft_echo']).toContain(result.reason);
  });

  test('reasoning-only fails', () => {
    const result = validateReviewResult(
      llm({ text: null, reasoningText: '思考中……' }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('reasoning_only');
  });

  test('empty content fails', () => {
    const result = validateReviewResult(llm({ text: '   ' }), DRAFT);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('empty_content');
  });

  test('truncated JSON with finishReason=length fails', () => {
    const result = validateReviewResult(
      llm({
        text: '{"strengths":["a"],"issues":["b"],"suggestions":',
        finishReason: 'length',
      }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('truncated_output');
  });

  test('oversized single item fails', () => {
    const huge = 'X'.repeat(2500);
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: [],
          issues: [huge],
          suggestions: [],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('oversized_report');
  });

  test('short quote must not be false-positive draft_echo', () => {
    const quote = DRAFT.slice(0, 40);
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: ['氛围好'],
          issues: [`引用：「${quote}」动机不足`],
          suggestions: ['补动机'],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(true);
  });

  test('extra top-level field is rejected (unexpected_shape)', () => {
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: ['节奏好'],
          issues: ['结尾仓促'],
          suggestions: ['补收束'],
          rewritten: DRAFT,
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unexpected_shape');
    expect(result.details).toMatch(/rewritten|不允许的顶层字段/);
  });

  test('extra top-level field containing full body is rejected', () => {
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: [],
          issues: [],
          suggestions: [],
          fullChapter: DRAFT + DRAFT,
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(['unexpected_shape', 'draft_echo', 'oversized_report']).toContain(
      result.reason,
    );
  });

  test('illegal array elements (number/boolean/null) yield unexpected_shape', () => {
    for (const bad of [42, true, null, {}]) {
      const result = validateReviewResult(
        llm({
          text: JSON.stringify({
            strengths: [bad],
            issues: [],
            suggestions: [],
          }),
        }),
        DRAFT,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('unexpected_shape');
    }
  });

  test('illegal elements are not silently dropped into empty success', () => {
    // If numbers were filtered out, this would look like "no issues".
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: [1, 2, 3],
          issues: [false, null],
          suggestions: [{}],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unexpected_shape');
  });

  test('empty string in strengths fails as unexpected_shape (not filtered to success)', () => {
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: [''],
          issues: [],
          suggestions: [],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unexpected_shape');
    expect(result.details).toMatch(/strengths/);
    expect(result.details).toMatch(/数组元素\[0\]/);
  });

  test('whitespace-only string in issues fails as unexpected_shape', () => {
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: [],
          issues: ['   '],
          suggestions: [],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unexpected_shape');
    expect(result.details).toMatch(/issues/);
    expect(result.details).toMatch(/数组元素\[0\]/);
  });

  test('empty string mixed with valid suggestions fails whole report', () => {
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: [],
          issues: [],
          suggestions: ['', '有效建议'],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unexpected_shape');
    expect(result.details).toMatch(/suggestions/);
    expect(result.details).toMatch(/数组元素\[0\]/);
  });

  test('legal empty arrays still pass', () => {
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: [],
          issues: [],
          suggestions: [],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(true);
    expect(result.report?.strengths).toEqual([]);
    expect(result.report?.issues).toEqual([]);
    expect(result.report?.suggestions).toEqual([]);
  });

  test('legal non-empty strings are trimmed and kept', () => {
    const result = validateReviewResult(
      llm({
        text: JSON.stringify({
          strengths: ['  节奏好  '],
          issues: ['结尾仓促'],
          suggestions: ['补收束'],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(true);
    expect(result.report?.strengths).toEqual(['节奏好']);
  });
});

describe('validateFactCheckResult', () => {
  test('accepts string arrays', () => {
    const result = validateFactCheckResult(
      llm({
        text: JSON.stringify({
          errors: ['银钥匙归属错误'],
          warnings: [],
          confirmed: ['地点一致'],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(true);
    expect(result.report?.errors).toEqual(['银钥匙归属错误']);
  });

  test('accepts object arrays', () => {
    const result = validateFactCheckResult(
      llm({
        text: JSON.stringify({
          errors: [
            {
              category: 'item',
              description: '钥匙持有者错误',
              draftQuote: '他摸出银钥匙',
              evidence: '上章钥匙已交给乙',
              evidenceType: 'episodic',
              suggestedAction: '改为乙持有',
            },
          ],
          warnings: [],
          confirmed: [],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(true);
    expect((result.report!.errors[0] as any).description).toBe(
      '钥匙持有者错误',
    );
  });

  test('missing fields fails', () => {
    const result = validateFactCheckResult(
      llm({ text: JSON.stringify({ errors: [] }) }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_required_fields');
  });

  test('full body fails', () => {
    const result = validateFactCheckResult(llm({ text: DRAFT }), DRAFT);
    expect(result.valid).toBe(false);
    expect(['novel_output', 'draft_echo']).toContain(result.reason);
  });

  test('stuffing full draft into a field fails', () => {
    const result = validateFactCheckResult(
      llm({
        text: JSON.stringify({
          errors: [DRAFT + DRAFT],
          warnings: [],
          confirmed: [],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(['oversized_report', 'draft_echo']).toContain(result.reason);
  });

  test('truncated JSON fails', () => {
    const result = validateFactCheckResult(
      llm({
        text: '{"errors":["a"],"warnings":[],"confirmed":',
        finishReason: 'length',
      }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('truncated_output');
  });

  test('reasoning-only fails', () => {
    const result = validateFactCheckResult(
      llm({ text: null, reasoningText: 'check facts…' }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('reasoning_only');
  });

  test('extra top-level field with full body fails', () => {
    const result = validateFactCheckResult(
      llm({
        text: JSON.stringify({
          errors: [],
          warnings: [],
          confirmed: ['地点一致'],
          manuscript: DRAFT,
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(['unexpected_shape', 'draft_echo', 'oversized_report']).toContain(
      result.reason,
    );
  });

  test('nested unknown field containing full draft fails', () => {
    const result = validateFactCheckResult(
      llm({
        text: JSON.stringify({
          errors: [
            {
              description: '钥匙问题',
              fullText: DRAFT,
            },
          ],
          warnings: [],
          confirmed: [],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(['unexpected_shape', 'draft_echo', 'oversized_report']).toContain(
      result.reason,
    );
  });

  test('illegal array elements fail whole report (not empty success)', () => {
    const result = validateFactCheckResult(
      llm({
        text: JSON.stringify({
          errors: [123, null, true, {}],
          warnings: [],
          confirmed: [],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unexpected_shape');
  });

  test('object item missing description fails (not silently dropped)', () => {
    const result = validateFactCheckResult(
      llm({
        text: JSON.stringify({
          errors: [{ category: 'item' }],
          warnings: [],
          confirmed: [],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unexpected_shape');
  });

  test('empty string in errors fails as unexpected_shape (not filtered to success)', () => {
    const result = validateFactCheckResult(
      llm({
        text: JSON.stringify({
          errors: [''],
          warnings: [],
          confirmed: [],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unexpected_shape');
    expect(result.details).toMatch(/errors/);
    expect(result.details).toMatch(/数组元素\[0\]/);
  });

  test('whitespace-only string in warnings fails as unexpected_shape', () => {
    const result = validateFactCheckResult(
      llm({
        text: JSON.stringify({
          errors: [],
          warnings: ['   '],
          confirmed: [],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unexpected_shape');
    expect(result.details).toMatch(/warnings/);
    expect(result.details).toMatch(/数组元素\[0\]/);
  });

  test('empty string mixed with valid confirmed fails whole report', () => {
    const result = validateFactCheckResult(
      llm({
        text: JSON.stringify({
          errors: [],
          warnings: [],
          confirmed: ['', '地点一致'],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unexpected_shape');
    expect(result.details).toMatch(/confirmed/);
    expect(result.details).toMatch(/数组元素\[0\]/);
  });

  test('legal empty arrays still pass', () => {
    const result = validateFactCheckResult(
      llm({
        text: JSON.stringify({
          errors: [],
          warnings: [],
          confirmed: [],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(true);
    expect(result.report?.errors).toEqual([]);
    expect(result.report?.warnings).toEqual([]);
    expect(result.report?.confirmed).toEqual([]);
  });

  test('legal non-empty strings are trimmed and kept', () => {
    const result = validateFactCheckResult(
      llm({
        text: JSON.stringify({
          errors: ['  银钥匙归属错误  '],
          warnings: [],
          confirmed: ['地点一致'],
        }),
      }),
      DRAFT,
    );
    expect(result.valid).toBe(true);
    expect(result.report?.errors).toEqual(['银钥匙归属错误']);
  });
});

describe('detectDraftEcho', () => {
  test('flags near-full copy', () => {
    const echo = detectDraftEcho(DRAFT, DRAFT);
    expect(echo.isEcho).toBe(true);
  });

  test('allows short independent report text', () => {
    const echo = detectDraftEcho(
      '节奏偏慢，建议压缩开场对话。',
      DRAFT,
    );
    expect(echo.isEcho).toBe(false);
  });
});

describe('extractAuditJsonPayload', () => {
  test('detects truncated unbalanced braces', () => {
    const r = extractAuditJsonPayload('{"errors":["a"],"warnings":[');
    expect(r.jsonText).toBeNull();
    expect(r.truncatedLikely).toBe(true);
  });
});

describe('formatAuditFailureMessage', () => {
  test('maps reasons to Chinese', () => {
    expect(formatAuditFailureMessage('review', 'draft_echo')).toContain(
      '初稿回显',
    );
    expect(formatAuditFailureMessage('factCheck', 'reasoning_only')).toContain(
      '推理过程',
    );
  });
});

describe('describeAuditFailureReason', () => {
  test('uses human labels for repair prompts', () => {
    expect(describeAuditFailureReason('novel_output')).toBe('输出了完整正文');
    expect(describeAuditFailureReason('truncated_output')).toBe('输出被截断');
  });
});
