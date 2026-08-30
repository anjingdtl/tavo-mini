/**
 * Phase III-C C7: Timeout & Failure Policy Seal.
 *
 * The phase must distinguish the request boundary without changing the
 * existing watchdog or retry topology.  These are intentionally Red-first
 * contracts: the implementation must expose a truthful phase for each error
 * boundary and keep non-success observations out of Governor learning.
 */
import {
  classifyLLMFailurePhase,
  LLMRequestError,
  shouldAutoRetryFailure,
  toLLMRequestError,
  LLM_TIMEOUTS,
  resolveLLMTimeoutPolicy,
} from '../src/services/llm/requestPolicy';
import {
  observeWritingGovernorResult,
  resolveWritingGovernorShadow,
  type WritingGovernorProfileStore,
} from '../src/services/writing/governor/writingGovernor';

function metrics(overrides: Record<string, unknown> = {}) {
  return {
    startedAt: 1,
    lastProgressAt: 1,
    queuedAt: 1,
    dispatchStartedAt: 2,
    ...overrides,
  } as any;
}

describe('C7 timeout and failure boundary policy', () => {
  it('keeps the existing long watchdog; changing timeout is not the fix', () => {
    expect(LLM_TIMEOUTS.chapterDraftMs).toBe(570_000);
    expect(resolveLLMTimeoutPolicy('pipeline_draft').totalTimeoutMs).toBe(
      570_000,
    );
  });

  it('separates pre-send network from post-send outcome_unknown', () => {
    expect(
      classifyLLMFailurePhase({
        code: 'network_error',
        metrics: metrics(),
      }),
    ).toBe('network');
    expect(
      classifyLLMFailurePhase({
        code: 'network_error',
        metrics: metrics({ requestSentAt: 3 }),
      }),
    ).toBe('outcome_unknown');
  });

  it('separates queue, HTTP, provider-body and response parse failures', () => {
    expect(
      classifyLLMFailurePhase({
        code: 'cancelled',
        metrics: metrics({ dispatchStartedAt: undefined }),
      }),
    ).toBe('queue');
    expect(
      classifyLLMFailurePhase({
        code: 'HTTP_503',
        httpStatus: 503,
        metrics: metrics({ responseReceivedAt: 4 }),
      }),
    ).toBe('http');
    expect(
      classifyLLMFailurePhase({
        code: 'provider_error',
        httpStatus: 200,
        metrics: metrics({ responseReceivedAt: 4 }),
        phaseHint: 'provider',
      } as any),
    ).toBe('provider');
    expect(
      classifyLLMFailurePhase({
        code: 'SyntaxError',
        metrics: metrics({ requestSentAt: 3, responseReceivedAt: 4 }),
        phaseHint: 'parse',
      } as any),
    ).toBe('parse');
  });

  it('maps timeout/network/parse errors to phase plus safe billing semantics', () => {
    const controller = { getAbortCode: () => undefined } as any;
    const preSend = toLLMRequestError(
      new TypeError('Network request failed'),
      controller,
      'fallback',
      { metrics: metrics() },
    );
    expect(preSend).toBeInstanceOf(LLMRequestError);
    expect(preSend.failurePhase).toBe('network');
    expect(preSend.failureClass).toBe('safe_retry');
    expect(preSend.requestMayHaveExecuted).toBe(false);

    const postSend = toLLMRequestError(
      new TypeError('Network request failed'),
      controller,
      'fallback',
      { metrics: metrics({ requestSentAt: 3 }) },
    );
    expect(postSend.failurePhase).toBe('outcome_unknown');
    expect(postSend.failureClass).toBe('outcome_unknown');
    expect(postSend.requestMayHaveExecuted).toBe(true);

    const parsed = toLLMRequestError(
      new SyntaxError('Unexpected token'),
      controller,
      'fallback',
      { metrics: metrics({ requestSentAt: 3, responseReceivedAt: 4 }) },
    );
    expect(parsed.failurePhase).toBe('parse');
    expect(parsed.failureClass).toBe('response_invalid');
    expect(parsed.requestMayHaveExecuted).toBe(true);
  });

  it('never auto-retries outcome_unknown and exposes generation/persist hints', () => {
    expect(
      classifyLLMFailurePhase({ phaseHint: 'generation' } as any),
    ).toBe('generation');
    expect(classifyLLMFailurePhase({ phaseHint: 'persist' } as any)).toBe(
      'persist',
    );
    expect(
      shouldAutoRetryFailure({
        failureClass: 'outcome_unknown',
        attemptNo: 1,
      }),
    ).toBe(false);
  });
});

describe('C7 Governor learning boundary', () => {
  it('does not learn from a network phase even if a caller forgot failureClass', () => {
    const store: WritingGovernorProfileStore = { profiles: {} };
    const shadow = resolveWritingGovernorShadow(
      {
        stage: 'draft',
        messages: [{ role: 'user', content: 'draft' }],
        legacyWireMax: 1000,
        contextWindow: 10_000,
        completionCapability: 10_000,
        providerWireCeiling: 10_000,
        providerAdapterId: 'c7-test-adapter',
        modelName: 'c7-test-model',
        targetChars: 500,
        outputContract: 'prose',
        thinking: { type: 'enabled' },
        reasoningEffort: 'high',
      },
      store,
    );

    observeWritingGovernorResult(store, shadow, {
      actualCompletionUsage: 20,
      visibleOutput: 20,
      reasoningUsage: 0,
      finishReason: 'stop',
      latencyMs: 10,
      businessResultValid: true,
      failureClass: null,
      failurePhase: 'network' as any,
    } as any);

    expect(store.profiles[shadow.profileKey]).toBeUndefined();
  });
});
