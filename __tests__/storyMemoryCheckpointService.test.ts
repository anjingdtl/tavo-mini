import { checkpointMaxTokens } from '../src/services/storyMemory/storyMemoryCheckpointService';

describe('storyMemoryCheckpointService helpers', () => {
  it('scales output budget by sqrt(batchSize) with clamp bounds', () => {
    expect(checkpointMaxTokens(1200, 1)).toBe(2400);
    expect(checkpointMaxTokens(1200, 4)).toBe(2400);
    expect(checkpointMaxTokens(4000, 9)).toBe(12000);
    expect(checkpointMaxTokens(8000, 10)).toBe(16000);
    expect(checkpointMaxTokens(100, 1)).toBe(2400);
  });
});
