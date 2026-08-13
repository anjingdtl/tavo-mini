import {
  buildFactCheckContextFromSnapshot,
  buildProofConstraintsFromSnapshot,
  buildReviewContextFromSnapshot,
  PIPELINE_CONTEXT_SNAPSHOT_VERSION,
  PIPELINE_CONTEXT_SNAPSHOT_VERSION_V4,
} from '../src/types/pipelineContext';
import {
  buildReviewContextFromSnapshotV4,
  isPhase2Snapshot,
} from '../src/services/pipeline/stageResourceContextV4';
import { parsePipelineContextSnapshotStrict } from '../src/services/pipelineTaskContext';

function v4Snapshot() {
  return {
    presetText: '预设全文',
    storyMemoryText: '记忆',
    characterText: '林晚详情',
    noteText: '',
    worldbookText: '青秀路详情',
    episodicMemoryText: '',
    recentBridgeText: '上一章',
    currentInstructionText: '走过青秀路',
    retrievalUserPrompt: '写回家',
    outlineText: '未来计划',
    outlineFingerprint: 'ofp',
    outlineIds: [],
    outlineComplete: true,
    outlineEstimatedTokens: 10,
    snapshotVersion: 4,
    resourceContextVersion: 2,
    characterAwarenessText: '林晚：周沉的妹妹；不知道事故真相',
    worldbookAwarenessText: '青秀路存在雨夜杀人狂',
    globalResourceAwarenessText: '骨架+约束',
    presetSystemText: '中文悬疑',
    presetWritingStyleText: '冷峻',
    presetExtraInstructionsText: '禁超自然',
    presetSourceFingerprint: 'preset-fp',
    presetSource: 'user_selected' as const,
    resourceDetailItems: [
      {
        id: 'character-detail:1',
        sourceKind: 'character' as const,
        sourceId: 1,
        title: '林晚',
        content: '林晚详情外貌',
        actualTokens: 20,
        allocatedTokens: 20,
        activationReason: 'user_prompt_hit',
      },
    ],
  };
}

test('V4 snapshot is phase-2 and keeps V3 projection fields', () => {
  const snap = v4Snapshot();
  expect(isPhase2Snapshot(snap as any)).toBe(true);
  expect(PIPELINE_CONTEXT_SNAPSHOT_VERSION).toBe(3);
  expect(PIPELINE_CONTEXT_SNAPSHOT_VERSION_V4).toBe(4);
  const review = buildReviewContextFromSnapshotV4(snap as any);
  expect(review.characterAwarenessText).toContain('不知道事故真相');
  expect(review.worldbookAwarenessText).toContain('杀人狂');
  expect(review.characterText).toContain('林晚详情外貌');
});

test('legacy V3 snapshot builder still reads old fields only', () => {
  const snap = {
    ...v4Snapshot(),
    snapshotVersion: 3,
    resourceContextVersion: undefined,
    characterAwarenessText: undefined,
    worldbookAwarenessText: undefined,
    globalResourceAwarenessText: undefined,
    resourceDetailItems: undefined,
  };
  expect(isPhase2Snapshot(snap as any)).toBe(false);
  const review = buildReviewContextFromSnapshot(snap as any);
  expect(review.characterText).toBe('林晚详情');
  expect(review.characterAwarenessText).toBe('');
});

test('parser accepts snapshot version 3 and 4 without upgrading', () => {
  const parsedV3 = parsePipelineContextSnapshotStrict(
    { ...v4Snapshot(), snapshotVersion: 3 },
    {},
  );
  const parsedV4 = parsePipelineContextSnapshotStrict(v4Snapshot(), {});
  expect(parsedV3.snapshotVersion).toBe(3);
  expect(parsedV4.snapshotVersion).toBe(4);
  expect(parsedV4.characterAwarenessText).toContain('林晚');
  expect(parsedV4.presetSourceFingerprint).toBe('preset-fp');
});

test('factcheck and proof V3 helpers remain callable on old snapshots', () => {
  const snap = {
    ...v4Snapshot(),
    snapshotVersion: 3,
    resourceContextVersion: undefined,
    characterAwarenessText: undefined,
    worldbookAwarenessText: undefined,
    globalResourceAwarenessText: undefined,
  };
  expect(buildFactCheckContextFromSnapshot(snap as any).worldbookText).toBe(
    '青秀路详情',
  );
  expect(buildProofConstraintsFromSnapshot(snap as any).relevantWorldRules).toBe(
    '青秀路详情',
  );
});
