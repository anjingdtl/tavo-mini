import {
  LLM_TIMEOUTS,
  resolveLLMTimeoutPolicy,
} from '../src/services/llm/requestPolicy';

describe('LLM timeout policy', () => {
  it('gives every pipeline stage a 300-second client watchdog', () => {
    for (const scenario of [
      'pipeline_draft',
      'pipeline_review',
      'pipeline_factcheck',
      'pipeline_proof',
    ]) {
      expect(resolveLLMTimeoutPolicy(scenario).totalTimeoutMs).toBe(300_000);
    }
    expect(LLM_TIMEOUTS.chapterDraftMs).toBe(300_000);
  });

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
