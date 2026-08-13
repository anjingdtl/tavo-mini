import { serializePipelineTaskContext } from '../src/services/pipelineTaskContext';
import { parsePipelineContextSnapshotStrict } from '../src/services/pipelineTaskContext';

test('cold-start envelope keeps V4 resource fields after serialize/parse', () => {
  const envelope = serializePipelineTaskContext({
    draftContext: {
      presetText: 'preset',
      storyMemoryText: 'mem',
      characterText: 'detail',
      noteText: '',
      worldbookText: 'wb-detail',
      episodicMemoryText: '',
      recentBridgeText: 'bridge',
      currentInstructionText: 'walk',
      retrievalUserPrompt: 'go',
      outlineText: 'plan',
      outlineFingerprint: 'ofp',
      outlineIds: [1],
      outlineComplete: true,
      outlineEstimatedTokens: 3,
      snapshotVersion: 4,
      resourceContextVersion: 2,
      characterAwarenessText: '骨架林晚',
      worldbookAwarenessText: '青秀路风险',
      globalResourceAwarenessText: '全局',
      presetSourceFingerprint: 'p-fp',
      resourceAwarenessItems: [
        {
          id: 'character-awareness:1',
          sourceKind: 'character',
          sourceId: 1,
          title: '林晚',
          content: '骨架林晚',
          sourceFingerprint: 'c-fp',
          compilerVersion: 'character-awareness-v1',
          constraintClasses: ['identity'],
        },
      ],
      resourceDetailItems: [
        {
          id: 'character-detail:1',
          sourceKind: 'character',
          sourceId: 1,
          title: '林晚',
          content: '详情',
          actualTokens: 4,
          allocatedTokens: 4,
          activationReason: 'pov',
        },
      ],
    },
    execution: {
      pipelineMode: 'full',
      outlineWorkflowVersion: 4,
      contextBudgetVersion: 7,
      finalReviserReasoningPolicyVersion: 3,
      reasoningProfileVersion: 5,
      draftMaxTokens: 1000,
      reviewMaxTokens: 800,
      factCheckMaxTokens: 800,
      proofMaxTokens: 800,
      draftPresetId: 1,
      reviewPresetId: null,
      factCheckPresetId: null,
      proofPresetId: null,
      draftPreset: {
        id: 1,
        name: '悬疑',
        system_prompt: '中文',
        writing_style: '冷',
        extra_instructions: '',
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 1000,
      },
      reviewPreset: null,
      factCheckPreset: null,
      proofPreset: null,
      model: {
        llmConfigId: 1,
        modelName: 'x',
        contextWindow: 128000,
      },
      createdAt: 1,
    } as any,
  });

  const raw = JSON.parse(envelope.pipelineContextJson);
  expect(raw.execution.contextBudgetVersion).toBe(7);
  const parsed = parsePipelineContextSnapshotStrict(raw.draftContext);
  expect(parsed.snapshotVersion).toBe(4);
  expect(parsed.characterAwarenessText).toBe('骨架林晚');
  expect(parsed.worldbookAwarenessText).toBe('青秀路风险');
  expect(parsed.resourceAwarenessItems?.[0].sourceFingerprint).toBe('c-fp');
});
