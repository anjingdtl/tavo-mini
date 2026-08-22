import { executeSharedWriterStage } from '../src/services/writing/stages/writerCore';

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
});
