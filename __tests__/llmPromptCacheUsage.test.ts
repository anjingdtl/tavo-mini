import {
  parsePromptCacheUsage,
  parseReasoningTokens,
} from '../src/services/llm/openAICompatibleProvider';

describe('parsePromptCacheUsage', () => {
  test('1. reads DeepSeek hit/miss when both present', () => {
    expect(
      parsePromptCacheUsage({
        prompt_tokens: 1000,
        prompt_cache_hit_tokens: 700,
        prompt_cache_miss_tokens: 300,
        completion_tokens: 50,
      }),
    ).toEqual({ hitTokens: 700, missTokens: 300 });
  });

  test('2. hit=0 / miss>0 is a real miss, not fabricated away', () => {
    expect(
      parsePromptCacheUsage({
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 900,
      }),
    ).toEqual({ hitTokens: 0, missTokens: 900 });
  });

  test('3. hit>0 / miss=0 is a full hit', () => {
    expect(
      parsePromptCacheUsage({
        prompt_cache_hit_tokens: 900,
        prompt_cache_miss_tokens: 0,
      }),
    ).toEqual({ hitTokens: 900, missTokens: 0 });
  });

  test('4. both fields missing → null/null (never 0)', () => {
    expect(parsePromptCacheUsage({ prompt_tokens: 1000 })).toEqual({
      hitTokens: null,
      missTokens: null,
    });
  });

  test('5. third-party gateway returns no cache fields → null/null', () => {
    expect(
      parsePromptCacheUsage({
        prompt_tokens: 1000,
        completion_tokens: 50,
        total_tokens: 1050,
      }),
    ).toEqual({ hitTokens: null, missTokens: null });
  });

  test('6. negative values rejected → null', () => {
    expect(
      parsePromptCacheUsage({
        prompt_cache_hit_tokens: -5,
        prompt_cache_miss_tokens: 300,
      }),
    ).toEqual({ hitTokens: null, missTokens: 300 });
    expect(
      parsePromptCacheUsage({
        prompt_cache_hit_tokens: 100,
        prompt_cache_miss_tokens: -1,
      }),
    ).toEqual({ hitTokens: 100, missTokens: null });
  });

  test('7. numeric strings are accepted', () => {
    expect(
      parsePromptCacheUsage({
        prompt_cache_hit_tokens: '123',
        prompt_cache_miss_tokens: '456',
      }),
    ).toEqual({ hitTokens: 123, missTokens: 456 });
  });

  test('8. NaN / Infinity / non-numeric strings rejected → null', () => {
    expect(
      parsePromptCacheUsage({
        prompt_cache_hit_tokens: NaN,
        prompt_cache_miss_tokens: Infinity,
      }),
    ).toEqual({ hitTokens: null, missTokens: null });
    expect(
      parsePromptCacheUsage({
        prompt_cache_hit_tokens: 'abc',
        prompt_cache_miss_tokens: {},
      }),
    ).toEqual({ hitTokens: null, missTokens: null });
    // Note: JS `Number(true) === 1`, so booleans coerce to numbers — this is
    // the SAME behaviour as the existing parseNonNegativeUsageNumber used for
    // every other usage field. Providers never send booleans here; we do not
    // special-case them to stay consistent with reasoning_tokens parsing.
    expect(
      parsePromptCacheUsage({
        prompt_cache_hit_tokens: true,
        prompt_cache_miss_tokens: false,
      }),
    ).toEqual({ hitTokens: 1, missTokens: 0 });
  });

  test('non-object usage → null/null without throwing', () => {
    expect(parsePromptCacheUsage(null)).toEqual({
      hitTokens: null,
      missTokens: null,
    });
    expect(parsePromptCacheUsage(undefined)).toEqual({
      hitTokens: null,
      missTokens: null,
    });
    expect(parsePromptCacheUsage('not-an-object')).toEqual({
      hitTokens: null,
      missTokens: null,
    });
  });

  test('9. reasoning_tokens parse independently of cache telemetry', () => {
    const usage = {
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 700,
      prompt_cache_miss_tokens: 300,
      completion_tokens: 200,
      completion_tokens_details: { reasoning_tokens: 150 },
    };
    expect(parseReasoningTokens(usage)).toBe(150);
    expect(parsePromptCacheUsage(usage)).toEqual({
      hitTokens: 700,
      missTokens: 300,
    });
  });

  test('10. cache telemetry never alters content/reasoning parsing (pure metadata)', () => {
    // The parser is a pure read of numeric fields; it must not mutate input or
    // throw, regardless of what other usage fields exist.
    const usage = {
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 700,
      prompt_cache_miss_tokens: 300,
      completion_tokens: 200,
      total_tokens: 1200,
      completion_tokens_details: { reasoning_tokens: 150 },
      choices: [{ message: { content: 'hello' } }],
    };
    const parsed = parsePromptCacheUsage(usage);
    expect(parsed).toEqual({ hitTokens: 700, missTokens: 300 });
    // Input untouched.
    expect(usage.completion_tokens).toBe(200);
    expect(usage.choices[0].message.content).toBe('hello');
  });

  test('hit+miss != prompt_tokens does not cause rejection', () => {
    // Provider accounting varies; the parser must not enforce the identity
    // prompt_tokens == hit + miss.
    expect(
      parsePromptCacheUsage({
        prompt_tokens: 1000,
        prompt_cache_hit_tokens: 700,
        prompt_cache_miss_tokens: 250,
      }),
    ).toEqual({ hitTokens: 700, missTokens: 250 });
  });
});
