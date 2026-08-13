import {
  buildFactCheckContextFromSnapshotV4,
  buildProofConstraintsFromSnapshotV4,
  buildReviewContextFromSnapshotV4,
} from '../src/services/pipeline/stageResourceContextV4';
import { buildReviewMessages } from '../src/services/pipelineMessages';

const snapshot = {
  presetText: '中文悬疑\n\n写作风格：冷峻\n\n附加要求：禁超自然',
  storyMemoryText: '第24章北区封锁已解除',
  characterText: '林晚详情',
  noteText: '风格画像B',
  worldbookText: '青秀路详情',
  episodicMemoryText: '',
  recentBridgeText: '昨天下了雨',
  currentInstructionText: '林晚走过青秀路',
  retrievalUserPrompt: '写回家',
  outlineText: '第50章角色死亡',
  outlineFingerprint: 'ofp',
  outlineIds: [1],
  outlineComplete: true,
  outlineEstimatedTokens: 8,
  snapshotVersion: 4 as const,
  resourceContextVersion: 2 as const,
  characterAwarenessText: '林晚：周沉的妹妹；不知道事故真相。许安是林晚前男友。',
  worldbookAwarenessText: '青秀路雨夜有连环杀人风险。北区基线曾封锁。',
  globalResourceAwarenessText: '骨架',
  presetSystemText: '中文悬疑',
  presetWritingStyleText: '冷峻',
  presetExtraInstructionsText: '禁超自然',
  presetSource: 'user_selected' as const,
  resourceDetailItems: [
    {
      id: 'character-detail:1',
      sourceKind: 'character' as const,
      sourceId: 1,
      title: '林晚',
      content: '林晚外貌与说话方式',
      actualTokens: 12,
      allocatedTokens: 12,
      activationReason: 'pov',
    },
  ],
};

test('all five-stage views share the same frozen awareness text', () => {
  const review = buildReviewContextFromSnapshotV4(snapshot as any);
  const fact = buildFactCheckContextFromSnapshotV4(snapshot as any);
  const proof = buildProofConstraintsFromSnapshotV4(snapshot as any);
  expect(review.characterAwarenessText).toBe(snapshot.characterAwarenessText);
  expect(fact.characterAwarenessText).toBe(snapshot.characterAwarenessText);
  expect(proof.characterAwarenessText).toBe(snapshot.characterAwarenessText);
  expect(review.worldbookAwarenessText).toBe(snapshot.worldbookAwarenessText);
  expect(fact.worldbookAwarenessText).toBe(snapshot.worldbookAwarenessText);
  expect(proof.worldbookAwarenessText).toBe(snapshot.worldbookAwarenessText);
});

test('Review prompt keeps outline as future plan and awareness as constraint', () => {
  const review = buildReviewContextFromSnapshotV4(snapshot as any);
  const messages = buildReviewMessages('初稿正文', review);
  const joined = messages.map(item => item.content).join('\n');
  expect(joined).toContain('人物全局骨架');
  expect(joined).toContain('不知道事故真相');
  expect(joined).toContain('未来规划');
  expect(joined).toContain('第50章角色死亡');
});

test('stage compilers never take a projectId', () => {
  const src = require('fs').readFileSync(
    require('path').join(
      process.cwd(),
      'src/services/pipeline/stageResourceContextV4.ts',
    ),
    'utf8',
  );
  expect(src).not.toMatch(/getCharactersByProject|getWorldbookEntriesByProject|getPresetsByProject/);
});
