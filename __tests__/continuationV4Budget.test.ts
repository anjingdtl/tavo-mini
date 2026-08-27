import fs from 'fs';
import path from 'path';
import { cloneDefaultContextAutomationPolicy } from '../src/services/contextAutomationPolicy';
import {
  preflightContinuationStageBudget,
  resolveContinuationStageBudget,
  resolveContinuationV4BudgetPreview,
} from '../src/services/continuation/generation/continuationV4Budget';

const baseInput = {
  frozenPolicy: cloneDefaultContextAutomationPolicy(),
  compiledPromptTokens: 2_000,
  protocolSkeletonTokens: 180,
  targetChapterChars: 3_000,
  writerDraftTokens: 9_000,
  paragraphCount: 24,
  hardContextTokens: 500,
};

describe('Continuation V4 stage budget resolver', () => {
  test('四个阶段分别使用自己的冻结模型窗口和 max output', () => {
    const models = {
      writer: { configId: 1, contextWindow: 128_000, maxOutputTokens: 32_000 },
      checker: { configId: 2, contextWindow: 32_768, maxOutputTokens: 8_000 },
      control: { configId: 3, contextWindow: 512_000, maxOutputTokens: 64_000 },
      repair: { configId: 4, contextWindow: 200_000, maxOutputTokens: 40_000 },
    } as const;
    const preview = resolveContinuationV4BudgetPreview({
      ...baseInput,
      stages: models,
    });

    expect(preview.stages.writer.contextWindow).toBe(128_000);
    expect(preview.stages.checker.contextWindow).toBe(32_768);
    expect(preview.stages.control.contextWindow).toBe(512_000);
    expect(preview.stages.repair.contextWindow).toBe(200_000);
    for (const stage of Object.values(preview.stages)) {
      expect(stage.maximumOutputTokens).toBeLessThanOrEqual(
        stage.declaredMaxOutputTokens,
      );
      expect(stage.maximumOutputTokens).toBeLessThanOrEqual(
        Math.floor(stage.contextWindow * stage.maxOutputRatio),
      );
    }
  });

  test('目标汉字数增大时 Writer/Repair 最低需求不下降', () => {
    const model = {
      configId: 1,
      contextWindow: 200_000,
      maxOutputTokens: 80_000,
    };
    const resolve = (stage: 'writer' | 'repair', chars: number) =>
      resolveContinuationStageBudget({
        ...baseInput,
        stage,
        frozenModelConfig: model,
        targetChapterChars: chars,
      });

    expect(resolve('writer', 6_000).minimumOutputTokens).toBeGreaterThanOrEqual(
      resolve('writer', 3_000).minimumOutputTokens,
    );
    expect(resolve('repair', 6_000).minimumOutputTokens).toBeGreaterThanOrEqual(
      resolve('repair', 3_000).minimumOutputTokens,
    );
  });

  test('所有阶段满足 prompt + max output + safety 不超过 effective window', () => {
    const preview = resolveContinuationV4BudgetPreview({
      ...baseInput,
      stages: {
        writer: {
          configId: 1,
          contextWindow: 128_000,
          maxOutputTokens: 32_000,
        },
        checker: {
          configId: 2,
          contextWindow: 128_000,
          maxOutputTokens: 32_000,
        },
        control: {
          configId: 3,
          contextWindow: 128_000,
          maxOutputTokens: 32_000,
        },
        repair: {
          configId: 4,
          contextWindow: 128_000,
          maxOutputTokens: 32_000,
        },
      },
    });

    for (const budget of Object.values(preview.stages)) {
      expect(
        budget.compiledPromptTokens +
          budget.maximumOutputTokens +
          budget.safetyReserveTokens,
      ).toBeLessThanOrEqual(budget.effectiveWindow);
      expect(preflightContinuationStageBudget(budget).ok).toBe(
        budget.blockedReason == null,
      );
    }
  });

  test('极小模型能力无法满足动态最低需求时，请求前阻断', () => {
    const budget = resolveContinuationStageBudget({
      stage: 'writer',
      frozenPolicy: cloneDefaultContextAutomationPolicy(),
      frozenModelConfig: {
        configId: 1,
        contextWindow: 4_096,
        maxOutputTokens: 512,
      },
      compiledPromptTokens: 300,
      protocolSkeletonTokens: 100,
      targetChapterChars: 3_000,
    });

    expect(budget.maximumOutputTokens).toBeLessThan(budget.minimumOutputTokens);
    expect(preflightContinuationStageBudget(budget)).toMatchObject({
      ok: false,
      stage: 'writer',
    });
  });

  test('缺少阶段 max output 时从同一 context window 弹性派生', () => {
    const budget = resolveContinuationStageBudget({
      stage: 'checker',
      frozenPolicy: cloneDefaultContextAutomationPolicy(),
      frozenModelConfig: {
        configId: 1,
        contextWindow: 16_000,
        maxOutputTokens: undefined as never,
      },
      compiledPromptTokens: 100,
      protocolSkeletonTokens: 50,
      targetChapterChars: 100,
      writerDraftTokens: 500,
    });
    expect(budget.declaredMaxOutputTokens).toBe(Math.floor(16_000 * 0.2));
    expect(budget.wireMaxOutputTokens).toBe(Math.floor(16_000 * 0.2));
  });

  test('缺少 context window 和 max output 时 fail-closed', () => {
    expect(() =>
      resolveContinuationStageBudget({
        stage: 'checker',
        frozenPolicy: cloneDefaultContextAutomationPolicy(),
        frozenModelConfig: {
          configId: 1,
          contextWindow: undefined as never,
          maxOutputTokens: undefined as never,
        },
        compiledPromptTokens: 100,
        protocolSkeletonTokens: 50,
        targetChapterChars: 100,
        writerDraftTokens: 500,
      }),
    ).toThrow(/context_window/);
  });

  test('hard context 实测值大于编译 Prompt 时会参与可用输出计算', () => {
    const common = {
      stage: 'writer' as const,
      frozenPolicy: cloneDefaultContextAutomationPolicy(),
      frozenModelConfig: {
        configId: 1,
        contextWindow: 20_000,
        maxOutputTokens: 20_000,
      },
      compiledPromptTokens: 100,
      protocolSkeletonTokens: 50,
      targetChapterChars: 100,
    };
    const withLargeHardContext = resolveContinuationStageBudget({
      ...common,
      hardContextTokens: 8_000,
    });
    const withoutLargeHardContext = resolveContinuationStageBudget({
      ...common,
      hardContextTokens: 0,
    });
    expect(withLargeHardContext.availableOutputTokens).toBeLessThan(
      withoutLargeHardContext.availableOutputTokens,
    );
  });

  test('Preview 与真实 resolver 使用同一输入时完全等价', () => {
    const stages = {
      writer: { configId: 1, contextWindow: 128_000, maxOutputTokens: 32_000 },
      checker: { configId: 2, contextWindow: 64_000, maxOutputTokens: 16_000 },
      control: { configId: 3, contextWindow: 64_000, maxOutputTokens: 16_000 },
      repair: { configId: 4, contextWindow: 200_000, maxOutputTokens: 40_000 },
    } as const;
    const preview = resolveContinuationV4BudgetPreview({
      ...baseInput,
      stages,
    });
    for (const stage of Object.keys(stages) as Array<keyof typeof stages>) {
      expect(preview.stages[stage]).toEqual(
        resolveContinuationStageBudget({
          ...baseInput,
          stage,
          frozenModelConfig: stages[stage],
        }),
      );
    }
  });

  test('V4 resolver 不包含旧阶段 token fallback', () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        'src/services/continuation/generation/continuationV4Budget.ts',
      ),
      'utf8',
    );
    expect(source).not.toContain('1500');
    expect(source).not.toContain('Math.max(256');
    expect(source).not.toContain('8192');
    expect(source).not.toContain('4096');
  });
});
