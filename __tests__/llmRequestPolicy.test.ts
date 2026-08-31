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

  it('gives user revision calls the long chapter-draft timeout', () => {
    // A user revision is one thinking-enabled novel-prose call; the 60s
    // normal timeout would turn a slow-but-valid revision into an
    // outcome-unknown abort, which the one-request contract cannot risk.
    expect(
      resolveLLMTimeoutPolicy('user_revision_targeted').totalTimeoutMs,
    ).toBe(LLM_TIMEOUTS.chapterDraftMs);
    expect(
      resolveLLMTimeoutPolicy('user_revision_whole_chapter').totalTimeoutMs,
    ).toBe(LLM_TIMEOUTS.chapterDraftMs);
    // Ordinary chat keeps the normal watchdog.
    expect(resolveLLMTimeoutPolicy('chat').totalTimeoutMs).toBe(
      LLM_TIMEOUTS.normalMs,
    );
  });
});
