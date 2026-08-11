/**
 * Prompt Cache P0-8 + P1: Frozen Request byte stability + prompt byte stability
 * tooling.
 *
 * These tests LOCK IN the cache-friendly properties the pipeline already has.
 * They must not require any change to production code — they assert that:
 *  - the same frozen request compiles to byte-identical messages every time;
 *  - a retry only appends one trailing user message and leaves the frozen
 *    prefix byte-identical (so the DeepSeek prefix cache can still match);
 *  - the frozen request fingerprint is stable across independently-constructed
 *    but structurally-equal objects;
 *  - the diagnostic fingerprint tool is deterministic and detects divergence.
 *
 * If any of these breaks, a non-deterministic serialization regression has
 * entered prompt construction and is hurting cache reuse — investigate before
 * "fixing" the test.
 */
import {
  compileDraftFromFrozenRequest,
} from '../src/services/pipeline/compileStageRequest';
import {
  computeFrozenDraftRequestFingerprint,
} from '../src/services/pipelineTaskContext';
import type { FrozenDraftRequest } from '../src/types/pipelineFrozen';
import {
  fingerprintChatMessages,
  serializeChatMessagesForFingerprint,
} from '../src/services/llm/promptByteStability';

const META = {
  estimatedInputTokens: 100,
  reservedOutputTokens: 1000,
  safetyMargin: 512,
  contextWindow: 128000,
};

function makeFrozen(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): FrozenDraftRequest {
  return {
    messages,
    ...META,
    allocations: [],
    requestFingerprint: computeFrozenDraftRequestFingerprint(messages, META),
    chapterTitle: '第 1 章',
    prevEnding: '',
    userPrompt: 'continue',
  };
}

const BASE_MESSAGES: Array<{ role: 'system' | 'user'; content: string }> = [
  { role: 'system', content: '你是小说写作助手。完整大纲：\n第一章 …\n第二章 …' },
  { role: 'user', content: '请续写第 3 章，保持人物一致。' },
];

describe('promptByteStability diagnostic tool', () => {
  test('fingerprint is deterministic for the same messages', () => {
    const a = fingerprintChatMessages(BASE_MESSAGES);
    const b = fingerprintChatMessages([...BASE_MESSAGES]);
    expect(a).toBe(b);
    expect(a).toHaveLength(64); // full SHA-256 hex
  });

  test('serialisation is stable across repeated calls', () => {
    const a = serializeChatMessagesForFingerprint(BASE_MESSAGES);
    const b = serializeChatMessagesForFingerprint([...BASE_MESSAGES]);
    expect(a).toBe(b);
  });

  test('detects byte-level divergence (content change)', () => {
    const variant: Array<{ role: 'system' | 'user'; content: string }> = [
      { role: 'system', content: '你是小说写作助手。完整大纲：\n第一章 …' },
      { role: 'user', content: '请续写第 3 章，保持人物一致。' },
    ];
    expect(fingerprintChatMessages(variant)).not.toBe(
      fingerprintChatMessages(BASE_MESSAGES),
    );
  });

  test('detects order divergence (arrays carry business meaning)', () => {
    const reordered: Array<{ role: 'system' | 'user'; content: string }> = [
      BASE_MESSAGES[1],
      BASE_MESSAGES[0],
    ];
    expect(fingerprintChatMessages(reordered)).not.toBe(
      fingerprintChatMessages(BASE_MESSAGES),
    );
  });
});

describe('P0-8 frozen draft request byte stability', () => {
  test('no-retry compile is byte-identical to frozen.messages', () => {
    const frozen = makeFrozen(BASE_MESSAGES);
    const ready = compileDraftFromFrozenRequest({ frozen });
    expect(ready.ready).toBe(true);
    if (!ready.ready) return;

    // Byte-level equality via the diagnostic fingerprint.
    expect(fingerprintChatMessages(ready.messages)).toBe(
      fingerprintChatMessages(frozen.messages),
    );
    // And structural equality.
    expect(ready.messages).toEqual(frozen.messages);
  });

  test('repeated no-retry compiles produce identical bytes', () => {
    const frozen = makeFrozen(BASE_MESSAGES);
    const first = compileDraftFromFrozenRequest({ frozen });
    const second = compileDraftFromFrozenRequest({ frozen });
    expect(first.ready).toBe(true);
    expect(second.ready).toBe(true);
    if (!first.ready || !second.ready) return;
    expect(
      serializeChatMessagesForFingerprint(first.messages),
    ).toBe(serializeChatMessagesForFingerprint(second.messages));
  });

  test('retry leaves the frozen prefix byte-identical and adds exactly one trailing user message', () => {
    const frozen = makeFrozen(BASE_MESSAGES);
    const retryInstruction = '请直接输出章节正文；不要输出分析、思考过程或标题。';
    const retry = compileDraftFromFrozenRequest({
      frozen,
      retryInstruction,
    });
    expect(retry.ready).toBe(true);
    if (!retry.ready) return;

    // Exactly one extra message.
    expect(retry.messages).toHaveLength(frozen.messages.length + 1);
    // The extra message is the retry instruction, as a user message.
    const appended = retry.messages[retry.messages.length - 1];
    expect(appended.role).toBe('user');
    expect(appended.content).toBe(retryInstruction);
    // The frozen prefix is byte-identical (cache prefix still matches).
    const prefix = retry.messages.slice(0, frozen.messages.length);
    expect(fingerprintChatMessages(prefix)).toBe(
      fingerprintChatMessages(frozen.messages),
    );
  });

  test('retry with a different instruction still preserves the frozen prefix', () => {
    const frozen = makeFrozen(BASE_MESSAGES);
    const a = compileDraftFromFrozenRequest({
      frozen,
      retryInstruction: '指令A',
    });
    const b = compileDraftFromFrozenRequest({
      frozen,
      retryInstruction: '指令B',
    });
    expect(a.ready).toBe(true);
    expect(b.ready).toBe(true);
    if (!a.ready || !b.ready) return;
    // Prefix identical even though the trailing instruction differs.
    expect(
      fingerprintChatMessages(a.messages.slice(0, frozen.messages.length)),
    ).toBe(
      fingerprintChatMessages(b.messages.slice(0, frozen.messages.length)),
    );
  });

  test('frozen request fingerprint is stable across independently-constructed equal objects', () => {
    // Two separately-built frozen requests with the same business content must
    // share the same fingerprint — the precondition for cache reuse on retry.
    const fp1 = computeFrozenDraftRequestFingerprint(BASE_MESSAGES, META);
    const fp2 = computeFrozenDraftRequestFingerprint(
      [...BASE_MESSAGES],
      { ...META },
    );
    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(32); // truncated fingerprint
  });

  test('frozen base fingerprint is unaffected by appending a retry message', () => {
    // The frozen request itself is immutable; only the compiled retry gains a
    // message. The frozen fingerprint must therefore be invariant.
    const frozen = makeFrozen(BASE_MESSAGES);
    const beforeRetry = frozen.requestFingerprint;
    // Simulate the retry path reading the persisted frozen request back.
    const recompiled = compileDraftFromFrozenRequest({
      frozen,
      retryInstruction: '请直接输出章节正文。',
    });
    expect(recompiled.ready).toBe(true);
    // frozen object itself is untouched.
    expect(frozen.requestFingerprint).toBe(beforeRetry);
  });

  test('compileDraftFromFrozenRequest is pure: identical across many invocations', () => {
    // The function must not read Date.now / Math.random / DB / store. Prove it
    // by calling it many times and asserting every output is byte-identical.
    const frozen = makeFrozen(BASE_MESSAGES);
    const fingerprints = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const ready = compileDraftFromFrozenRequest({ frozen });
      expect(ready.ready).toBe(true);
      if (!ready.ready) return;
      fingerprints.add(fingerprintChatMessages(ready.messages));
    }
    expect(fingerprints.size).toBe(1);
  });
});
