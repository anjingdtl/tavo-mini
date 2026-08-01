import {
  LLM_TIMEOUTS,
  resolveLLMTimeoutPolicy,
} from '../src/services/llm/requestPolicy';

describe('LLM timeout policy', () => {
  it('gives continuation stages the long chapter-draft timeout', () => {
    expect(resolveLLMTimeoutPolicy('continuation_planner').totalTimeoutMs).toBe(
      LLM_TIMEOUTS.chapterDraftMs,
    );
    expect(resolveLLMTimeoutPolicy('continuation_writer').totalTimeoutMs).toBe(
      LLM_TIMEOUTS.chapterDraftMs,
    );
    expect(resolveLLMTimeoutPolicy('continuation_checker').totalTimeoutMs).toBe(
      LLM_TIMEOUTS.chapterDraftMs,
    );
  });
});
