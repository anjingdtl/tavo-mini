import {
  decideEmptyResponseAction,
  STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
} from '../src/services/storyMemory/storyMemoryAttemptPolicy';

describe('decideEmptyResponseAction recovery matrix (repair plan P1 §6.2)', () => {
  it('reasoning_only: fresh retry with thinking disabled + budget raise', () => {
    const action = decideEmptyResponseAction({
      emptyReason: 'reasoning_only',
      finishReason: 'stop',
      attempt: 1,
      maxAttempts: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
      currentBudget: 2400,
      nextBudget: 4800,
    });
    expect(action.type).toBe('fresh_retry');
    if (action.type === 'fresh_retry') {
      expect(action.disableThinking).toBe(true);
      expect(action.budget).toBe(4800);
    }
  });

  it('reasoning_only on the final attempt fails with actionable diagnostic', () => {
    const action = decideEmptyResponseAction({
      emptyReason: 'reasoning_only',
      finishReason: 'stop',
      attempt: 3,
      maxAttempts: 3,
      currentBudget: 4800,
      nextBudget: 9600,
    });
    expect(action.type).toBe('fail');
    if (action.type === 'fail') {
      expect(action.retryable).toBe(true);
      expect(action.reason).toContain('思考');
    }
  });

  it('length: fresh retry with raised budget when the cap has headroom', () => {
    const action = decideEmptyResponseAction({
      emptyReason: 'length',
      finishReason: 'length',
      attempt: 1,
      maxAttempts: 3,
      currentBudget: 2400,
      nextBudget: 4800,
    });
    expect(action.type).toBe('fresh_retry');
    if (action.type === 'fresh_retry') {
      expect(action.disableThinking).toBe(false);
      expect(action.budget).toBe(4800);
    }
  });

  it('length with no budget headroom fails and suggests model capability', () => {
    const action = decideEmptyResponseAction({
      emptyReason: 'length',
      finishReason: 'length',
      attempt: 2,
      maxAttempts: 3,
      currentBudget: 4000,
      nextBudget: 4000,
    });
    expect(action.type).toBe('fail');
    if (action.type === 'fail') {
      expect(action.userActionHint).toContain('context_window');
    }
  });

  it('empty: one fresh retry, then fail on the final attempt', () => {
    const first = decideEmptyResponseAction({
      emptyReason: 'empty',
      finishReason: 'stop',
      attempt: 1,
      maxAttempts: 3,
      currentBudget: 2400,
      nextBudget: 4800,
    });
    expect(first.type).toBe('fresh_retry');
    if (first.type === 'fresh_retry') {
      expect(first.disableThinking).toBe(false);
    }
    const last = decideEmptyResponseAction({
      emptyReason: 'empty',
      finishReason: 'stop',
      attempt: 3,
      maxAttempts: 3,
      currentBudget: 4800,
      nextBudget: 9600,
    });
    expect(last.type).toBe('fail');
  });

  it('no_choices fails as a gateway/provider error without retrying', () => {
    const action = decideEmptyResponseAction({
      emptyReason: 'no_choices',
      finishReason: null,
      attempt: 1,
      maxAttempts: 3,
      currentBudget: 2400,
      nextBudget: 4800,
    });
    expect(action.type).toBe('fail');
    if (action.type === 'fail') {
      expect(action.retryable).toBe(true);
      expect(action.reason).toContain('no choices');
    }
  });

  it('content_filter never blind-retries', () => {
    const action = decideEmptyResponseAction({
      emptyReason: 'content_filter',
      finishReason: 'content_filter',
      attempt: 1,
      maxAttempts: 3,
      currentBudget: 2400,
      nextBudget: 4800,
    });
    expect(action.type).toBe('fail');
    if (action.type === 'fail') {
      expect(action.retryable).toBe(false);
      expect(action.reason).toContain('内容审核');
    }
  });

  it('undefined emptyReason is treated as plain empty', () => {
    const action = decideEmptyResponseAction({
      finishReason: 'stop',
      attempt: 1,
      maxAttempts: 3,
      currentBudget: 2400,
      nextBudget: 4800,
    });
    expect(action.type).toBe('fresh_retry');
  });
});
