import { parsePipelineContextSnapshotStrict } from '../src/services/pipelineTaskContext';
import { buildReviewContextFromSnapshotV4 } from '../src/services/pipeline/stageResourceContextV4';

test('resume uses frozen awareness even if live copy would have changed', () => {
  const frozen = parsePipelineContextSnapshotStrict(
    {
      presetText: 'old-preset',
      storyMemoryText: '',
      characterText: 'old-detail',
      noteText: '',
      worldbookText: 'old-wb',
      episodicMemoryText: '',
      recentBridgeText: '',
      currentInstructionText: 'x',
      retrievalUserPrompt: 'y',
      outlineText: '',
      outlineFingerprint: '',
      outlineIds: [],
      outlineComplete: true,
      outlineEstimatedTokens: 0,
      snapshotVersion: 4,
      resourceContextVersion: 2,
      characterAwarenessText: '林晚不知道真相',
      worldbookAwarenessText: '北区处于封锁状态',
      presetSourceFingerprint: 'fp-old',
    },
    {},
  );
  const review = buildReviewContextFromSnapshotV4(frozen);
  expect(review.characterAwarenessText).toBe('林晚不知道真相');
  expect(review.worldbookAwarenessText).toBe('北区处于封锁状态');
  expect(review.characterAwarenessText).not.toContain('已经知道');
});

test('V3 snapshot resume is not auto-upgraded to V4', () => {
  const frozen = parsePipelineContextSnapshotStrict(
    {
      presetText: 'p',
      storyMemoryText: '',
      characterText: 'c',
      noteText: '',
      worldbookText: 'w',
      episodicMemoryText: '',
      recentBridgeText: '',
      currentInstructionText: 'i',
      retrievalUserPrompt: 'u',
      outlineText: '',
      outlineFingerprint: '',
      outlineIds: [],
      outlineComplete: true,
      outlineEstimatedTokens: 0,
      snapshotVersion: 3,
    },
    {},
  );
  expect(frozen.snapshotVersion).toBe(3);
  expect(frozen.resourceContextVersion).toBeUndefined();
});
