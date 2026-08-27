import { checkpointMaxTokens } from '../src/services/storyMemory/storyMemoryCheckpointService';

describe('storyMemoryCheckpointService helpers', () => {
  it('scales output budget by sqrt(batchSize) with clamp bounds', () => {
    const model = {
      contextWindow: 32768,
      maxOutputTokens: 8192,
      estimatedInputTokens: 256,
    };
    expect(checkpointMaxTokens(1200, 1, model)).toBe(2400);
    expect(checkpointMaxTokens(1200, 4, model)).toBe(2400);
    expect(checkpointMaxTokens(4000, 9, model)).toBe(8192);
    expect(checkpointMaxTokens(8000, 10, model)).toBe(8192);
    expect(checkpointMaxTokens(100, 1, model)).toBe(2400);
  });
});
