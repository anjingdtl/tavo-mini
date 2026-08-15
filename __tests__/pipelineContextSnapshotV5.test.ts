import {
  PIPELINE_CONTEXT_SNAPSHOT_VERSION_V5,
  type PipelineContextSnapshot,
} from '../src/types/pipelineContext';
import type { PipelineExecutionSnapshot } from '../src/types/pipelineExecution';
import type { FrozenWriterStyleV1 } from '../src/services/writerStyle/types';
import {
  parsePersistedPipelineTaskContext,
  parsePipelineContextSnapshotStrict,
  serializePipelineTaskContext,
} from '../src/services/pipelineTaskContext';

function writerStyle(): FrozenWriterStyleV1 {
  const projection = (stage: FrozenWriterStyleV1['stageProjections']['draft']['stage']) => ({
    stage,
    mode: 'FULL' as const,
    protected: true as const,
    text: `protected-${stage}`,
    estimatedTokens: 2,
    compilerVersion: 'writer-style-projection-v1',
  });
  return {
    semanticVersion: 1,
    assetId: 7,
    assetName: '冷峻悬疑',
    sourceFormat: 'shinewriter',
    semantic: null,
    sourceFingerprint: 'writer-style-source',
    samplerResolution: {
      temperature: 0.7,
      topP: 1,
      preservedFields: [],
      ignoredAtPipeline: [],
    },
    stageProjections: {
      draft: projection('draft'),
      review: { ...projection('review'), mode: 'EVALUATION' },
      factCheck: { ...projection('factCheck'), mode: 'HARD' },
      brief: { ...projection('brief'), mode: 'MINIMAL' },
      proof: projection('proof'),
    },
  };
}

function snapshot(overrides: Partial<PipelineContextSnapshot> = {}): PipelineContextSnapshot {
  return {
    presetText: 'preset',
    storyMemoryText: 'memory',
    characterText: 'character',
    noteText: '',
    worldbookText: 'worldbook',
    episodicMemoryText: '',
    recentBridgeText: '',
    currentInstructionText: 'instruction',
    retrievalUserPrompt: '',
    outlineText: 'outline',
    outlineFingerprint: 'outline-fp',
    outlineIds: [],
    outlineComplete: true,
    outlineEstimatedTokens: 10,
    createdAt: 1700000000000,
    snapshotVersion: PIPELINE_CONTEXT_SNAPSHOT_VERSION_V5,
    writerStyleSnapshot: writerStyle(),
    ...overrides,
  };
}

function execution(): PipelineExecutionSnapshot {
  return {
    pipelineMode: 'full',
    draftMaxTokens: 1000,
    reviewMaxTokens: 500,
    factCheckMaxTokens: 500,
    proofMaxTokens: 1000,
    draftPresetId: null,
    reviewPresetId: null,
    factCheckPresetId: null,
    proofPresetId: null,
    draftPreset: null,
    reviewPreset: null,
    factCheckPreset: null,
    proofPreset: null,
    writerStyle: writerStyle(),
    model: {
      llmConfigId: 1,
      name: 'test',
      modelName: 'model',
      contextWindow: 32000,
      maxOutputTokens: 4000,
    },
    createdAt: 1700000000000,
  };
}

test('V5 writer style snapshot and execution writer style survive serialize/parse', () => {
  const serialized = serializePipelineTaskContext({
    draftContext: snapshot(),
    execution: execution(),
  });
  const raw = JSON.parse(serialized.pipelineContextJson);
  expect(raw.draftContext.snapshotVersion).toBe(5);

  const parsed = parsePersistedPipelineTaskContext(serialized);
  expect(parsed.draftContext.snapshotVersion).toBe(5);
  expect(parsed.draftContext.writerStyleSnapshot?.stageProjections.review.text).toBe(
    'protected-review',
  );
  expect(parsed.execution?.writerStyle?.assetId).toBe(7);
});

test('V5 malformed writer style fails closed', () => {
  const raw = snapshot() as any;
  raw.writerStyleSnapshot.stageProjections.review.text = 123;
  expect(() => parsePipelineContextSnapshotStrict(raw)).toThrow(
    /作家风格|writerStyle/i,
  );
});

test('V4 residual writer style field remains ignored', () => {
  const parsed = parsePipelineContextSnapshotStrict({
    ...snapshot({ snapshotVersion: 4 }),
    writerStyleSnapshot: writerStyle(),
  } as any);
  expect(parsed.snapshotVersion).toBe(4);
  expect(parsed.writerStyleSnapshot).toBeUndefined();
});
