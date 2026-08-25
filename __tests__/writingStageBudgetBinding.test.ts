import { executeSharedWriterStage } from '../src/services/writing/stages/writerCore';
import { compileSharedWritingPrompt } from '../src/services/writing/prompt/sharedPromptCompiler';
import {
  buildSharedStageMaxOutputTokens,
  resolveElasticStageOutputReservation,
} from '../src/services/contextAutoAllocator';

describe('shared Writer stage budget binding', () => {
  it('uses the frozen continuation stage budget instead of the model ceiling', async () => {
    const requirements = { items: [], fingerprint: 'requirements-fingerprint' };
    const calls: number[] = [];
    const stagePolicy = {
      version: 1,
      reviewMode: 'continuation-v5',
      strictness: 'fail-closed',
      semanticApplyRequired: true,
      stageOrder: ['draft'],
      outputContract: 'json_envelope',
      skipRules: {},
      values: {
        sharedStageMaxOutputTokens: { draft: 14_680 },
      },
      requirementsFingerprint: requirements.fingerprint,
    };
    const frozenContext = {
      projectId: 27,
      writingRunId: 'wr-budget-binding',
      generationTraceId: 'gt-budget-binding',
      instruction: {
        title: 'Continuation chapter',
        synopsis: '推进冲突',
        userInstruction: '推进冲突',
        currentContent: '',
        targetPosition: 8,
      },
      rendered: { text: '' },
      requirements,
      stagePolicy,
      model: {
        configId: 1,
        provider: 'openai_compatible',
        modelName: 'deepseek-v4-flash',
        contextWindow: 1_000_000,
        maxOutputTokens: 200_000,
      },
      freezeFingerprint: 'freeze-budget-binding',
    } as any;

    await executeSharedWriterStage({
      stage: 'draft',
      stageInput: {
        frozenContext,
        artifacts: {},
        requirements,
        stagePolicy,
        modelConfig: {
          configId: 1,
          name: 'default',
          providerType: 'openai_compatible',
          url: 'https://api.deepseek.com/chat/completions',
          modelName: 'deepseek-v4-flash',
          contextWindow: 1_000_000,
          maxOutputTokens: 200_000,
        },
        trace: { freezeFingerprint: frozenContext.freezeFingerprint },
        callStage: async (input: { maxTokens: number }) => {
          calls.push(input.maxTokens);
          return { text: JSON.stringify({ schemaVersion: 1, content: '正文' }) };
        },
      } as any,
    });

    expect(calls).toEqual([14_680]);
  });

  it('revision uses frozen elastic output reserve instead of a 8192 cap', () => {
    const requirements = { items: [], fingerprint: 'requirements-fingerprint' };
    const reservation = resolveElasticStageOutputReservation({
      contextWindow: 1_000_000,
      modelMaxOutputTokens: 200_000,
    });
    expect(reservation).toBe(200_000);
    const mapped = buildSharedStageMaxOutputTokens({
      contextWindow: 1_000_000,
      modelMaxOutputTokens: 200_000,
      outlineStageBudgets: [
        { stage: 'brief', requestMaxTokens: 200_000 },
        { stage: 'draft', requestMaxTokens: 200_000 },
      ],
    });
    expect(mapped.revision).toBe(200_000);
    const compiled = compileSharedWritingPrompt({
      stage: 'revision',
      frozenContext: {
        instruction: { title: 't', synopsis: 's', userInstruction: 'u' },
        rendered: { text: '' },
        requirements,
        stagePolicy: {
          version: 1,
          reviewMode: 'full',
          strictness: 'fail-closed',
          semanticApplyRequired: true,
          stageOrder: ['revision'],
          outputContract: 'json_envelope',
          skipRules: {},
          values: { sharedStageMaxOutputTokens: mapped },
          requirementsFingerprint: requirements.fingerprint,
        },
        model: {
          configId: 1,
          provider: 'openai_compatible',
          modelName: 'deepseek-v4-flash',
          contextWindow: 1_000_000,
          maxOutputTokens: 200_000,
        },
        freezeFingerprint: 'freeze-rev-budget',
      } as any,
      artifacts: {
        draft: { stage: 'draft', body: '初稿'.repeat(2000) },
      } as any,
      requirements: requirements as any,
      stagePolicy: {
        version: 1,
        reviewMode: 'full',
        strictness: 'fail-closed',
        semanticApplyRequired: true,
        stageOrder: ['revision'],
        outputContract: 'json_envelope',
        skipRules: {},
        values: { sharedStageMaxOutputTokens: mapped },
        requirementsFingerprint: requirements.fingerprint,
      } as any,
    });
    expect(compiled.maxTokens).toBe(200_000);
    expect(compiled.maxTokens).toBeGreaterThan(8192);
  });

  it('a stale small ledger row can never under-reserve revision/QA/draft below the elastic envelope', () => {
    // Legacy V3 non-elastic stages froze small requestMaxTokens
    // (visibleOutputFloor + reasoningHeadroom). The shared Writer must lift
    // them to the elastic reserve — this is the residual path that used to
    // truncate long revision/QA JSON into "返回格式无效".
    const mapped = buildSharedStageMaxOutputTokens({
      contextWindow: 1_000_000,
      modelMaxOutputTokens: 200_000,
      outlineStageBudgets: [
        { stage: 'draft', requestMaxTokens: 6_048 },
        { stage: 'review', requestMaxTokens: 3_036 },
        { stage: 'factCheck', requestMaxTokens: 2_524 },
        { stage: 'brief', requestMaxTokens: 2_400 },
        { stage: 'proof', requestMaxTokens: 7_048 },
      ],
    });
    const elastic = resolveElasticStageOutputReservation({
      contextWindow: 1_000_000,
      modelMaxOutputTokens: 200_000,
    });
    expect(elastic).toBe(200_000);
    expect(mapped.revision).toBe(elastic);
    expect(mapped.qa).toBe(elastic);
    expect(mapped.draft).toBe(elastic);
    expect(mapped.review).toBe(elastic);
    expect(mapped.factCheck).toBe(elastic);
    expect(mapped.proof).toBe(elastic);
    // A frozen row above the reserve is honored as-is, never shrunk.
    const generous = buildSharedStageMaxOutputTokens({
      contextWindow: 1_000_000,
      modelMaxOutputTokens: 200_000,
      outlineStageBudgets: [
        { stage: 'brief', requestMaxTokens: 500_000 },
      ],
    });
    expect(generous.revision).toBe(500_000);
  });

  it('revision compile with a stale small frozen row still gets the elastic envelope', () => {
    const requirements = { items: [], fingerprint: 'requirements-fingerprint' };
    const mapped = buildSharedStageMaxOutputTokens({
      contextWindow: 1_000_000,
      modelMaxOutputTokens: 200_000,
      outlineStageBudgets: [{ stage: 'brief', requestMaxTokens: 2_400 }],
    });
    const compiled = compileSharedWritingPrompt({
      stage: 'revision',
      frozenContext: {
        instruction: { title: 't', synopsis: 's', userInstruction: 'u' },
        rendered: { text: '' },
        requirements,
        stagePolicy: {
          version: 1,
          reviewMode: 'full',
          strictness: 'fail-closed',
          semanticApplyRequired: true,
          stageOrder: ['revision'],
          outputContract: 'json_envelope',
          skipRules: {},
          values: { sharedStageMaxOutputTokens: mapped },
          requirementsFingerprint: requirements.fingerprint,
        },
        model: {
          configId: 1,
          provider: 'openai_compatible',
          modelName: 'deepseek-v4-flash',
          contextWindow: 1_000_000,
          maxOutputTokens: 200_000,
        },
        freezeFingerprint: 'freeze-rev-stale-ledger',
      } as any,
      artifacts: { draft: { stage: 'draft', body: '初稿'.repeat(2000) } } as any,
      requirements: requirements as any,
      stagePolicy: {
        version: 1,
        reviewMode: 'full',
        strictness: 'fail-closed',
        semanticApplyRequired: true,
        stageOrder: ['revision'],
        outputContract: 'json_envelope',
        skipRules: {},
        values: { sharedStageMaxOutputTokens: mapped },
        requirementsFingerprint: requirements.fingerprint,
      } as any,
    });
    expect(compiled.maxTokens).toBe(200_000);
    expect(compiled.maxTokens).not.toBeLessThanOrEqual(8192);
  });

  it('revision without a frozen stage row still uses the elastic envelope', () => {
    const requirements = { items: [], fingerprint: 'requirements-fingerprint' };
    const compiled = compileSharedWritingPrompt({
      stage: 'revision',
      frozenContext: {
        instruction: { title: 't', synopsis: 's', userInstruction: 'u' },
        rendered: { text: '' },
        requirements,
        stagePolicy: {
          version: 1,
          reviewMode: 'full',
          strictness: 'fail-closed',
          semanticApplyRequired: true,
          stageOrder: ['revision'],
          outputContract: 'json_envelope',
          skipRules: {},
          values: {},
          requirementsFingerprint: requirements.fingerprint,
        },
        model: {
          configId: 1,
          provider: 'openai_compatible',
          modelName: 'deepseek-v4-flash',
          contextWindow: 128_000,
          maxOutputTokens: 200_000,
        },
        freezeFingerprint: 'freeze-rev-elastic',
      } as any,
      artifacts: { draft: { stage: 'draft', body: '初稿' } } as any,
      requirements: requirements as any,
      stagePolicy: {
        version: 1,
        reviewMode: 'full',
        strictness: 'fail-closed',
        semanticApplyRequired: true,
        stageOrder: ['revision'],
        outputContract: 'json_envelope',
        skipRules: {},
        values: {},
        requirementsFingerprint: requirements.fingerprint,
      } as any,
    });
    expect(compiled.maxTokens).toBe(
      resolveElasticStageOutputReservation({
        contextWindow: 128_000,
        modelMaxOutputTokens: 200_000,
      }),
    );
    expect(compiled.maxTokens).toBe(25_600);
  });
});
