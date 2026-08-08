import {
  checkpointMaxTokens,
  nextCheckpointBudget,
  safeOutputMaxForModel,
  MIN_CHECKPOINT_OUTPUT_TOKENS,
} from '../src/services/storyMemory/storyMemoryBudget';

describe('storyMemoryBudget planner (repair plan P1 §6.3)', () => {
  it('safeOutputMax is capped by configured max_output_tokens', () => {
    expect(safeOutputMaxForModel({ memoryPatchMaxTokens: 1200, batchSize: 1 })).toBe(
      16000,
    );
    expect(
      safeOutputMaxForModel({
        memoryPatchMaxTokens: 1200,
        batchSize: 1,
        maxOutputTokens: 4000,
      }),
    ).toBe(4000);
  });

  it('safeOutputMax reserves context_window headroom for input + protocol', () => {
    expect(
      safeOutputMaxForModel({
        memoryPatchMaxTokens: 1200,
        batchSize: 1,
        contextWindow: 8192,
        estimatedInputTokens: 3000,
      }),
    ).toBe(8192 - 3000 - 256);
    // Smaller of the two caps wins.
    expect(
      safeOutputMaxForModel({
        memoryPatchMaxTokens: 1200,
        batchSize: 1,
        contextWindow: 8192,
        estimatedInputTokens: 3000,
        maxOutputTokens: 2000,
      }),
    ).toBe(2000);
  });

  it('returns 0 when the window cannot fit protocol + input at all', () => {
    expect(
      safeOutputMaxForModel({
        memoryPatchMaxTokens: 1200,
        batchSize: 1,
        contextWindow: 3000,
        estimatedInputTokens: 3000,
      }),
    ).toBe(0);
  });

  it('clamps the legacy derivation by the active model capability', () => {
    // Legacy derivation 4000×√9=12000, clamped by max_output_tokens=8000.
    expect(
      checkpointMaxTokens({
        memoryPatchMaxTokens: 4000,
        batchSize: 9,
        maxOutputTokens: 8000,
      }),
    ).toBe(8000);
    // A small but positive cap is respected (never exceeds the model).
    expect(
      checkpointMaxTokens({
        memoryPatchMaxTokens: 1200,
        batchSize: 1,
        contextWindow: 4000,
        estimatedInputTokens: 3500,
      }),
    ).toBe(4000 - 3500 - 256);
    // Infeasible window → 0.
    expect(
      checkpointMaxTokens({
        memoryPatchMaxTokens: 1200,
        batchSize: 1,
        contextWindow: 3000,
        estimatedInputTokens: 3000,
      }),
    ).toBe(0);
  });

  it('legacy two-arg derivation is preserved', () => {
    expect(checkpointMaxTokens({ memoryPatchMaxTokens: 1200, batchSize: 1 })).toBe(
      MIN_CHECKPOINT_OUTPUT_TOKENS,
    );
    expect(checkpointMaxTokens({ memoryPatchMaxTokens: 8000, batchSize: 10 })).toBe(
      16000,
    );
  });

  it('nextCheckpointBudget never exceeds the model max_output_tokens', () => {
    expect(nextCheckpointBudget(2400)).toBe(4800);
    expect(nextCheckpointBudget(2400, 3000)).toBe(3000);
    expect(nextCheckpointBudget(2400, 2000)).toBe(2000);
    expect(nextCheckpointBudget(2400, 4000)).toBe(4000);
  });
});
