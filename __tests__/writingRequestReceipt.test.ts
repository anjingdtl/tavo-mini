/**
 * Phase 3 A3: every real model request has a reconstructable Request Receipt.
 * Receipts store fingerprints, not the full prompt blob.
 */
import {
  compileSharedWritingPrompt,
  SHARED_PROMPT_COMPILER_VERSION,
} from '../src/services/writing/prompt/sharedPromptCompiler';
import {
  buildWritingRequestReceipt,
  compactWritingRequestReceipt,
} from '../src/services/writing/contracts/writingRequestReceipt';
import { executeSharedWriterStage } from '../src/services/writing/stages/writerCore';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { outlineRequest } from './helpers/oneShotFixtures';

describe('Writing Request Receipt', () => {
  test('each compiled stage request has a unique reconstructable receipt without the full prompt', () => {
    const { frozenContext, trace } = buildWritingKernelFreezeTrace({
      request: outlineRequest({
        pipelineTopologyVersion: 'compact_standard',
        qualityProfile: 'standard',
      }),
    });
    const receipts = (['draft', 'qa'] as const).map(stage => {
      const compiled = compileSharedWritingPrompt({
        stage,
        frozenContext,
        artifacts: {},
        requirements: frozenContext.requirements,
        stagePolicy: frozenContext.stagePolicy,
      });
      return buildWritingRequestReceipt({
        generationTraceId: frozenContext.generationTraceId,
        stage,
        frozenContext,
        compiled,
        thinking: { type: 'enabled' },
        reasoningEffort: 'high',
      });
    });
    expect(receipts[0].requestId).not.toBe(receipts[1].requestId);
    expect(receipts[0].requestFingerprint).not.toBe(
      receipts[1].requestFingerprint,
    );
    expect(receipts[0].promptCompilerVersion).toBe(
      SHARED_PROMPT_COMPILER_VERSION,
    );
    expect(receipts[0].freezeFingerprint).toBe(frozenContext.freezeFingerprint);
    expect(receipts[0].truthProjectionFingerprint).toBe(
      frozenContext.truthProjection?.fingerprint,
    );
    expect(receipts[0].messagesFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(receipts[0].generationTraceId).toBe(trace.generationTraceId);
    const json = JSON.stringify(compactWritingRequestReceipt(receipts[0]));
    expect(json).not.toMatch(/你是初稿作者/);
    expect(json).not.toContain('完成本章写作指令');
    expect(JSON.parse(json).messages).toBeUndefined();
  });

  test('shared writer records a receipt on the stage artifact for the actual call', async () => {
    const { frozenContext, trace } = buildWritingKernelFreezeTrace({
      request: outlineRequest({
        pipelineTopologyVersion: 'compact_standard',
        qualityProfile: 'fast',
      }),
    });
    const artifact = await executeSharedWriterStage({
      stage: 'draft',
      stageInput: {
        frozenContext,
        artifacts: {},
        requirements: frozenContext.requirements,
        stagePolicy: frozenContext.stagePolicy,
        trace,
        modelConfig: {
          configId: frozenContext.model.configId,
          name: frozenContext.model.name || 'cfg',
          providerType: frozenContext.model.provider,
          url: frozenContext.model.url || '',
          modelName: frozenContext.model.modelName,
          contextWindow: frozenContext.model.contextWindow,
          maxOutputTokens: frozenContext.model.maxOutputTokens,
        },
        callStage: async () => ({
          text: '完整正文。',
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14,
          finishReason: 'stop',
        }),
      },
    });
    expect(artifact.requestReceipts).toHaveLength(1);
    expect(artifact.requestReceipts?.[0].stage).toBe('draft');
    expect(artifact.requestReceipts?.[0].outcome).toBe('succeeded');
    expect(artifact.requestReceipts?.[0].usage?.outputTokens).toBe(4);
    expect(artifact.requestReceipts?.[0].resultArtifactRef).toBeTruthy();
  });
});
