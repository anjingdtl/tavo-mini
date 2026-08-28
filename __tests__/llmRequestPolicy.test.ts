import {
  LLM_TIMEOUTS,
  resolveLLMTimeoutPolicy,
} from '../src/services/llm/requestPolicy';

describe('LLM timeout policy', () => {
  it('gives every pipeline stage a long-running client watchdog', () => {
    for (const scenario of [
      'pipeline_draft',
      'pipeline_qa',
      'pipeline_review',
      'pipeline_factcheck',
      'pipeline_brief',
      'pipeline_proof',
    ]) {
      expect(resolveLLMTimeoutPolicy(scenario).totalTimeoutMs).toBe(570_000);
    }
    expect(LLM_TIMEOUTS.chapterDraftMs).toBe(570_000);
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
