import {
  checkpointMaxTokens,
  nextCheckpointBudget,
  safeOutputMaxForModel,
} from '../src/services/storyMemory/storyMemoryBudget';

describe('storyMemoryBudget planner (repair plan P1 §6.3)', () => {
  it('safeOutputMax is capped by configured max_output_tokens', () => {
    expect(
      safeOutputMaxForModel({
        memoryPatchMaxTokens: 1200,
        batchSize: 1,
        contextWindow: 100_000,
        maxOutputTokens: 16_000,
      }),
    ).toBe(16_000);
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
        maxOutputTokens: 8192,
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

  it('derives an unset output capability from context_window × 20%', () => {
    expect(
      safeOutputMaxForModel({
        memoryPatchMaxTokens: 1200,
        batchSize: 1,
        contextWindow: 8192,
        estimatedInputTokens: 0,
      }),
    ).toBe(Math.floor(8192 * 0.2));
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
        maxOutputTokens: 4000,
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

  it('fails closed when no model capability is available', () => {
    expect(checkpointMaxTokens({ memoryPatchMaxTokens: 1200, batchSize: 1 })).toBe(0);
    expect(checkpointMaxTokens({ memoryPatchMaxTokens: 8000, batchSize: 10 })).toBe(0);
  });

  it('nextCheckpointBudget never exceeds the model max_output_tokens', () => {
    expect(nextCheckpointBudget(2400)).toBe(0);
    expect(nextCheckpointBudget(2400, 3000)).toBe(3000);
    expect(nextCheckpointBudget(2400, 2000)).toBe(2000);
    expect(nextCheckpointBudget(2400, 4000)).toBe(4000);
  });

  it('every retry expansion stays within context_window - input - safetyMargin (P1 fix 3)', () => {
    // 窗口剩余空间 8192-6000-256 = 1936，扩容不得突破。
    expect(
      nextCheckpointBudget(2400, 4000, {
        contextWindow: 8192,
        estimatedInputTokens: 6000,
      }),
    ).toBe(1936);
    // 窗口连协议 + 输入都放不下 → 预算无法继续增长（返回 0）。
    expect(
      nextCheckpointBudget(2400, 4000, {
        contextWindow: 5000,
        estimatedInputTokens: 5000,
      }),
    ).toBe(0);
    // max_output_tokens 更紧时取更小值。
    expect(
      nextCheckpointBudget(2400, 1200, {
        contextWindow: 32768,
        estimatedInputTokens: 1000,
      }),
    ).toBe(1200);
    // 无模型能力声明时 fail-closed，不恢复旧的固定输出预算。
    expect(nextCheckpointBudget(2400, undefined)).toBe(0);
  });
});
