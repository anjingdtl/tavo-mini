/**
 * One-Shot elastic-context gates (极速档 V1.0 plan §6 / §13 Gate C).
 *
 * 极速 = fewer stages, NEVER less context. The Execution Profile must not
 * touch the context budget: identical sources produce identical plan /
 * allocation / rendered fingerprints under one_shot and standard, across
 * small and huge context windows. No hard token caps may appear.
 */
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { compileSharedWritingPrompt } from '../src/services/writing/prompt/sharedPromptCompiler';
import { outlineRequest } from './helpers/oneShotFixtures';
import type { FrozenWritingContext } from '../src/services/writing/contracts/frozenWritingContext';

function budgetPart(ctx: FrozenWritingContext) {
  return JSON.stringify({
    plan: ctx.plan,
    allocation: ctx.allocation,
    rendered: ctx.rendered,
  });
}

describe('One-Shot elastic context budget inheritance', () => {
  test.each([
    ['small window', 8192],
    ['normal window', 65536],
    ['huge window', 1000000],
  ])('%s: one_shot plan/allocation/render identical to standard', (_label, contextWindow) => {
    const standard = buildWritingKernelFreezeTrace({
      request: outlineRequest({}, { contextWindow }),
    }).frozenContext;
    const oneShot = buildWritingKernelFreezeTrace({
      request: outlineRequest(
        { executionProfile: 'one_shot' },
        { contextWindow },
      ),
    }).frozenContext;
    expect(budgetPart(oneShot)).toBe(budgetPart(standard));
    // The only policy difference is the profile projection itself.
    expect(oneShot.freezeFingerprint).not.toBe(standard.freezeFingerprint);
  });

  test('large sources: clipping still governed by the SAME elastic allocator (not a fixed cap)', () => {
    const small = buildWritingKernelFreezeTrace({
      request: outlineRequest({ executionProfile: 'one_shot' }, { contextWindow: 65536 }),
    }).frozenContext;
    const big = buildWritingKernelFreezeTrace({
      request: outlineRequest(
        { executionProfile: 'one_shot' },
        { contextWindow: 65536, sourceScale: 8 },
      ),
    }).frozenContext;
    // Bigger sources must still render through clipping — the rendered text
    // length stays bounded by the SAME budget, never explodes unbounded.
    const smallLen = String(small.rendered?.text || '').length;
    const bigLen = String(big.rendered?.text || '').length;
    expect(bigLen).toBeGreaterThan(0);
    expect(bigLen).toBeLessThanOrEqual(smallLen * 8 + 1024);
  });

  test('one_shot draft prompt keeps the full frozen rendered context (no truncation added)', () => {
    const frozen = buildWritingKernelFreezeTrace({
      request: outlineRequest({ executionProfile: 'one_shot' }),
    }).frozenContext;
    const standardFrozen = buildWritingKernelFreezeTrace({
      request: outlineRequest({}),
    }).frozenContext;
    const compile = (ctx: FrozenWritingContext) =>
      compileSharedWritingPrompt({
        stage: 'draft',
        frozenContext: ctx,
        artifacts: {},
        requirements: ctx.requirements,
        stagePolicy: ctx.stagePolicy,
      });
    const oneShotPrompt = compile(frozen);
    const standardPrompt = compile(standardFrozen);
    const oneShotUser = oneShotPrompt.messages[1].content;
    const standardUser = standardPrompt.messages[1].content;
    // The frozen rendered context block is included verbatim.
    expect(oneShotUser).toContain('【冻结上下文】');
    expect(oneShotUser.length).toBeGreaterThanOrEqual(
      standardUser.length * 0.95,
    );
    // maxTokens still derives from the model, not from the profile.
    expect(oneShotPrompt.maxTokens).toBe(standardPrompt.maxTokens);
    expect(oneShotPrompt.maxTokens).toBe(4096);
  });

  test('one_shot draft prompt carries the one-shot policy projection block', () => {
    const frozen = buildWritingKernelFreezeTrace({
      request: outlineRequest({ executionProfile: 'one_shot' }),
    }).frozenContext;
    const compiled = compileSharedWritingPrompt({
      stage: 'draft',
      frozenContext: frozen,
      artifacts: {},
      requirements: frozen.requirements,
      stagePolicy: frozen.stagePolicy,
    });
    const joined = compiled.messages.map(m => m.content).join('\n');
    expect(joined).toContain('One-Shot');
    expect(joined).toContain('唯一一次模型生成');
    // Non-draft stages never see the one-shot projection.
    const proof = compileSharedWritingPrompt({
      stage: 'proof',
      frozenContext: frozen,
      artifacts: { draft: { stage: 'draft', body: '正文' } } as any,
      requirements: frozen.requirements,
      stagePolicy: frozen.stagePolicy,
    });
    expect(
      proof.messages.map(m => m.content).join('\n'),
    ).not.toContain('唯一一次模型生成');
  });

  test('no hard token caps are introduced by the profile anywhere in the policy', () => {
    const frozen = buildWritingKernelFreezeTrace({
      request: outlineRequest({ executionProfile: 'one_shot' }),
    }).frozenContext;
    const values = frozen.stagePolicy.values as Record<string, unknown>;
    for (const [key, value] of Object.entries(values)) {
      expect(key).not.toMatch(/fast|extreme/i);
      if (typeof value === 'number') {
        expect(key).not.toMatch(/token|cap|limit|budget/i);
      }
    }
    const profilePolicy = values.executionProfilePolicy as
      | Record<string, unknown>
      | undefined;
    expect(profilePolicy).toBeDefined();
    expect(Object.keys(profilePolicy!)).toEqual([
      'id',
      'maxPaidLlmCalls',
      'allowFormatter',
      'allowPrimaryRetry',
    ]);
  });
});
