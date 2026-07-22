/**
 * Live DeepSeek integration (opt-in via DEEPSEEK_API_KEY).
 * Verifies Provider content/reasoning separation against the real API.
 *
 * Run:
 *   $env:DEEPSEEK_API_KEY='...'; npx jest __tests__/deepseekLiveProvider.integration.test.ts --runInBand
 */
import { openAICompatibleProvider } from '../src/services/llm/openAICompatibleProvider';
import {
  validateFactCheckResult,
  validateReviewResult,
} from '../src/services/pipelineAuditValidator';

const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const runLive = Boolean(API_KEY);

const requestConfig = {
  provider_type: 'openai_compatible' as const,
  api_key: API_KEY,
  model_name: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  url: 'https://api.deepseek.com/chat/completions',
};

const draft =
  '夜色笼罩古城。林深把银钥匙塞进怀里，沿东城墙走向钟楼。他记得上章钥匙本已交给阿乙，此刻却仍在自己口袋里。';

(runLive ? describe : describe.skip)('DeepSeek live provider + audit validator', () => {
  jest.setTimeout(120000);

  test('low max_tokens: reasoning-only yields text=null and fails review validation', async () => {
    const result = await openAICompatibleProvider.generate(
      [{ role: 'user', content: '只回复：pong' }],
      { max_tokens: 12, temperature: 0, requestConfig },
    );

    expect(result.text).toBeNull();
    expect(result.reasoningText && result.reasoningText.length > 0).toBe(true);
    // Old bug: content || reasoning would be non-null Chinese reasoning.
    expect(result.text || result.reasoningText).toBeTruthy();

    const validation = validateReviewResult(result, draft);
    expect(validation.valid).toBe(false);
    expect(validation.reason).toBe('reasoning_only');
  });

  test('review JSON mode returns separable content and can validate', async () => {
    const result = await openAICompatibleProvider.generate(
      [
        {
          role: 'system',
          content:
            '你是小说审阅编辑。只输出 JSON：{"strengths":[],"issues":[],"suggestions":[]}。不要 Markdown。',
        },
        { role: 'user', content: `【初稿】\n${draft}\n请审阅。` },
      ],
      {
        max_tokens: 1200,
        temperature: 0.3,
        responseFormat: 'json_object',
        requestConfig,
      },
    );

    // Must not put reasoning into text
    if (result.reasoningText) {
      expect(result.text || '').not.toBe(result.reasoningText);
    }

    const validation = validateReviewResult(result, draft);
    // Model may occasionally fail JSON; if so it must be invalid not silently novel body.
    if (validation.valid) {
      expect(validation.normalizedText).toContain('strengths');
      expect(validation.normalizedText).toContain('issues');
    } else {
      expect(validation.reason).toBeTruthy();
      expect(validation.reason).not.toBeUndefined();
    }
  });

  test('factCheck JSON mode validates structure', async () => {
    const result = await openAICompatibleProvider.generate(
      [
        {
          role: 'system',
          content:
            '你是事实核查员。只输出 JSON：{"errors":[],"warnings":[],"confirmed":[]}。不要 Markdown。',
        },
        {
          role: 'user',
          content: `【设定】银钥匙已交给阿乙。\n【初稿】\n${draft}\n请核查。`,
        },
      ],
      {
        max_tokens: 1200,
        temperature: 0.3,
        responseFormat: 'json_object',
        requestConfig,
      },
    );

    const validation = validateFactCheckResult(result, draft);
    if (validation.valid) {
      expect(validation.normalizedText).toContain('errors');
    } else {
      // Must not treat reasoning-only as success
      expect(['reasoning_only', 'empty_content', 'invalid_json', 'missing_required_fields', 'truncated_output', 'unexpected_shape', 'novel_output', 'draft_echo', 'oversized_report']).toContain(
        validation.reason,
      );
    }
  });
});
