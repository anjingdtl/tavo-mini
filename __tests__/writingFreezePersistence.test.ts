import { parsePersistedPipelineTaskContext } from '../src/services/pipelineTaskContext';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import type { WritingRequest } from '../src/services/writing/contracts/writingSource';
import { writingSourceContentHash } from '../src/services/writing/contracts/writingFingerprint';

function frozenRequest(): WritingRequest {
  const source = (
    candidateId: string,
    kind: 'instruction' | 'chapter' | 'outline' | 'preset',
    content: string,
  ) => ({
    candidateId,
    kind,
    sourceId: 1,
    revision: 'r1',
    contentHash: writingSourceContentHash(content),
    content,
    requirement: 'mandatory' as const,
    activation: 'automatic' as const,
  });
  return {
    writingRunId: 'wr-freeze-persistence',
    generationTraceId: 'gt-freeze-persistence',
    projectId: 1,
    chapterId: 2,
    scenario: 'outline',
    instruction: {
      title: '冻结测试',
      synopsis: '验证冻结上下文可恢复',
      userInstruction: '保持冻结输入一致',
      currentContent: '',
      targetPosition: 1,
    },
    sourceBundle: {
      mandatory: [
        source('instruction:freeze', 'instruction', '保持冻结输入一致'),
        source('chapter:freeze', 'chapter', '冻结测试章节'),
        source('outline:freeze', 'outline', '不可变剧情方向'),
        source('preset:freeze', 'preset', '克制叙事'),
      ],
      preferred: [],
      optional: [],
    },
    model: {
      configId: 1,
      provider: 'test',
      modelName: 'test',
      contextWindow: 65536,
      maxOutputTokens: 4096,
    },
    policy: {
      version: 1,
      reviewMode: 'full',
      strictness: 'fail-closed',
      values: {
        requirements: [
          {
            id: 'obligation:freeze',
            kind: 'obligation',
            severity: 'blocking',
            validation: 'semantic',
            text: '冻结后不得读取实时输入',
          },
        ],
      },
    },
  };
}

describe('Writing Kernel frozen context persistence', () => {
  test('preserves the complete frozen requirement/policy context on parse', () => {
    const { frozenContext, trace } = buildWritingKernelFreezeTrace({
      request: frozenRequest(),
    });
    const json = JSON.stringify({
      ...{
        presetText: '',
        storyMemoryText: '',
        characterText: '',
        noteText: '',
        worldbookText: '',
        episodicMemoryText: '',
        recentBridgeText: '',
        currentInstructionText: '冻结测试',
        retrievalUserPrompt: '保持冻结输入一致',
        outlineText: '',
        outlineFingerprint: '',
        outlineIds: [],
        outlineComplete: true,
        outlineEstimatedTokens: 0,
      },
      writingKernelTrace: trace,
      frozenWritingContext: frozenContext,
    });

    const parsed = parsePersistedPipelineTaskContext({
      pipelineContextJson: json,
      pipelineContextVersion: 1,
    });

    expect(parsed.draftContext.frozenWritingContext?.freezeFingerprint).toBe(
      frozenContext.freezeFingerprint,
    );
    expect(parsed.draftContext.frozenWritingContext?.requirements.fingerprint).toBe(
      frozenContext.requirements.fingerprint,
    );
    expect(parsed.draftContext.frozenWritingContext?.stagePolicy.requirementsFingerprint).toBe(
      frozenContext.stagePolicy.requirementsFingerprint,
    );
  });
});
