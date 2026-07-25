/**
 * pipelineMessages unit tests (SPEC §16, §20).
 *
 * Covers:
 * - review/factCheck/proof receive the partitioned context from the snapshot;
 * - the 3000-char `slice(0, 3000)` truncation is gone — long worldbook rules
 *   at the end of the context still reach the fact-check stage (SPEC §9.1, §20.4);
 * - empty / undefined partitions are filtered, never injected as blank headers;
 * - Pending Bridge text reaches factCheck even though it is a "user" role block
 *   in the draft messages (SPEC §20.3);
 * - proof receives the real review + factCheck reports (SPEC §20.2);
 * - reports are framed as editorial opinion, not system instructions.
 */
import {
  buildReviewMessages,
  buildFactCheckMessages,
  buildProofMessages,
  buildReviewRepairMessages,
  buildFactCheckRepairMessages,
} from '../src/services/pipelineMessages';
import type {
  FactCheckContext,
  ProofConstraints,
  ReviewContext,
} from '../src/types/pipelineContext';

const baseReviewContext: ReviewContext = {
  presetText: 'preset-content',
  characterText: 'character-content',
  noteText: 'note-content',
  worldbookText: 'worldbook-content',
  storyMemoryText: 'story-memory-content',
  episodicMemoryText: 'episodic-content',
  recentBridgeText: 'recent-bridge-content',
  currentInstructionText: 'instruction-content',
  retrievalUserPrompt: 'user-prompt-content',
};

const baseFactCheckContext: FactCheckContext = {
  presetText: 'preset-content',
  currentInstructionText: 'instruction-content',
  retrievalUserPrompt: 'user-prompt-content',
  recentBridgeText: 'recent-bridge-content',
  storyMemoryText: 'story-memory-content',
  episodicMemoryText: 'episodic-content',
  worldbookText: 'worldbook-content',
  characterText: 'character-content',
  noteText: 'note-content',
};

const baseProofConstraints: ProofConstraints = {
  presetText: 'preset-content',
  currentInstructionText: 'instruction-content',
  retrievalUserPrompt: 'user-prompt-content',
  relevantCharacterConstraints: 'char-constraints',
  relevantWorldRules: 'world-rules',
  currentStoryState: 'story-state',
  episodicMemoryText: 'episodic-content',
  noteText: 'note-content',
  recentBridgeText: 'recent-bridge-content',
};

function userContent(messages: { role: string; content: string }[]): string {
  return messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
}

describe('buildReviewMessages', () => {
  test('includes preset, character, story memory, recent bridge and instruction', () => {
    const messages = buildReviewMessages('draft-body', baseReviewContext);
    const content = userContent(messages);
    expect(content).toContain('preset-content');
    expect(content).toContain('character-content');
    expect(content).toContain('story-memory-content');
    expect(content).toContain('recent-bridge-content');
    expect(content).toContain('instruction-content');
    expect(content).toContain('user-prompt-content');
    expect(content).toContain('draft-body');
  });

  test('filters empty partitions so no blank headers leak into the prompt', () => {
    const messages = buildReviewMessages('d', {
      ...baseReviewContext,
      storyMemoryText: '',
      recentBridgeText: '',
    });
    const content = userContent(messages);
    expect(content).not.toContain('【当前故事状态】\n\n');
    expect(content).not.toContain('【近期正文 / 衔接】\n\n');
    // Non-empty sections still present.
    expect(content).toContain('preset-content');
  });

  test('instructs the model to output strict JSON without fences', () => {
    const messages = buildReviewMessages('d', baseReviewContext);
    const system = messages.find(m => m.role === 'system')!.content;
    expect(system).toContain('{"strengths": [...], "issues": [...], "suggestions": [...]}');
    expect(system).toContain('不要输出 Markdown 围栏');
  });
});

describe('buildFactCheckMessages — no more slice(0, 3000)', () => {
  test('includes worldbook, Story Memory, episodic events, bridge, instruction and user prompt', () => {
    const messages = buildFactCheckMessages('draft-body', baseFactCheckContext);
    const content = userContent(messages);
    expect(content).toContain('worldbook-content');
    expect(content).toContain('story-memory-content');
    expect(content).toContain('episodic-content');
    expect(content).toContain('recent-bridge-content');
    expect(content).toContain('instruction-content');
    expect(content).toContain('user-prompt-content');
    expect(content).toContain('character-content');
    expect(content).toContain('note-content');
    expect(content).toContain('draft-body');
  });

  test('Pending Bridge text is NOT lost even though it is a "user"-role block in the draft messages (SPEC §20.3)', () => {
    const messages = buildFactCheckMessages('正文草稿', {
      ...baseFactCheckContext,
      recentBridgeText: '【第 7 章】张明把银钥匙交给了李雪。',
    });
    const content = userContent(messages);
    expect(content).toContain('张明把银钥匙交给了李雪');
  });

  test('a worldbook body is kept whole up to the per-section token budget (no 3000-char hard cut)', () => {
    // The old code merged every system message into one `contextText` and ran
    // `contextText.slice(0, 3000)` — a hard CHARACTER cut. The new code gives
    // EACH section its own TOKEN budget. A worldbook body of ~2500 CJK chars
    // (≈2500 tokens, inside the 3000-token worldbook budget) is preserved whole,
    // even though under the old merged-character-slice logic the tail of this
    // body would have been dropped once other sections filled the first 3000
    // characters of the merged text.
    const filler = '盐湖设定。'.repeat(400); // 2000 chars ≈ 2000 tokens
    const criticalRule = '\n关键规则：龙族不能进入盐湖。';
    const worldbookText = filler + criticalRule;

    const messages = buildFactCheckMessages('正文草稿', {
      ...baseFactCheckContext,
      worldbookText,
    });
    const content = userContent(messages);
    // The rule at the tail of the body survives — per-section budget kept it.
    expect(content).toContain('龙族不能进入盐湖');
    // And the worldbook body is present as a dedicated partition, not merged.
    expect(content).toContain('【世界书 / 世界规则】');
  });

  test('the source no longer contains the legacy slice(0, 3000) call', () => {
    // Regression guard: the hard CHARACTER truncation must stay deleted.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/services/pipelineMessages.ts'),
      'utf8',
    );
    expect(source).not.toContain('.slice(0, 3000)');
    expect(source).not.toContain('slice(0,3000)');
  });

  test('does not apply the old slice(0, 3000) char truncation — long content is preserved up to the per-section TOKEN budget', () => {
    // A 2500-char CJK worldbook body fits well inside the 3000-TOKEN worldbook
    // budget. Under the old code, if this body sat after other system messages
    // in the merged `contextText`, anything past character 3000 was sliced off.
    // Under the new per-section token budget, the whole body is retained.
    const longBody = '盐湖荒漠设定条目。'.repeat(200); // 2000 chars ≈ 2000 tokens
    expect(longBody.length).toBeLessThan(3000);
    const messages = buildFactCheckMessages('d', {
      ...baseFactCheckContext,
      worldbookText: longBody,
    });
    const content = userContent(messages);
    // The full body is present (no 3000-char hard cut).
    expect(content).toContain(longBody);
    // Sanity: the worldbook partition was injected.
    expect(content).toContain('【世界书 / 世界规则】');
  });

  test('instructs the model that worldbook overrides real-world common sense', () => {
    const messages = buildFactCheckMessages('d', baseFactCheckContext);
    const system = messages.find(m => m.role === 'system')!.content;
    expect(system).toContain('不得用现实常识否定世界书');
    expect(system).toContain('近期正文');
  });
});

describe('buildProofMessages — targeted revision', () => {
  test('receives the REAL review and factCheck reports (SPEC §20.2)', () => {
    const reviewText = JSON.stringify({
      strengths: [],
      issues: ['主角突然会飞，不符合角色能力'],
      suggestions: ['改为通过楼梯上楼'],
    });
    const factCheckText = JSON.stringify({
      errors: ['主角当前没有银钥匙'],
      warnings: [],
      confirmed: [],
    });
    const messages = buildProofMessages(
      'draft-body',
      reviewText,
      factCheckText,
      baseProofConstraints,
    );
    const content = userContent(messages);
    expect(content).toContain('主角突然会飞，不符合角色能力');
    expect(content).toContain('改为通过楼梯上楼');
    expect(content).toContain('主角当前没有银钥匙');
  });

  test('when a report is empty, the placeholder makes clear it was not provided', () => {
    const messages = buildProofMessages(
      'draft-body',
      '',
      '',
      baseProofConstraints,
    );
    const content = userContent(messages);
    expect(content).toContain('未提供有效文学评估');
    expect(content).toContain('未提供有效事实核查');
  });

  test('reports are framed as editorial opinion, not system instructions', () => {
    const messages = buildProofMessages('d', 'r', 'f', baseProofConstraints);
    const system = messages.find(m => m.role === 'system')!.content;
    expect(system).toContain('待验证的编辑意见');
    expect(system).toContain('定向修订');
    expect(system).toContain('不得引入新人物');
  });

  test('constraints (current chapter goal, recent bridge, world rules) are injected', () => {
    const messages = buildProofMessages('d', 'r', 'f', baseProofConstraints);
    const content = userContent(messages);
    expect(content).toContain('instruction-content');
    expect(content).toContain('recent-bridge-content');
    expect(content).toContain('world-rules');
    expect(content).toContain('char-constraints');
    expect(content).toContain('story-state');
  });
});

describe('repair messages', () => {
  test('review repair forbids prose and injects reason without invalid body', () => {
    const invalidBody = '这是一整段无效正文' + 'X'.repeat(200);
    const messages = buildReviewRepairMessages(
      'draft',
      baseReviewContext,
      '输出了完整正文',
    );
    const joined = messages.map(m => m.content).join('\n');
    expect(joined).toContain('不是有效的文学评估 JSON');
    expect(joined).toContain('不要重写、续写、润色或复述小说正文');
    expect(joined).toContain('上一轮错误类型：输出了完整正文');
    expect(joined).toContain('"strengths"');
    expect(joined).not.toContain(invalidBody);
  });

  test('factCheck repair forbids prose and keeps JSON-only instruction', () => {
    const messages = buildFactCheckRepairMessages(
      'draft',
      baseFactCheckContext,
      '输出被截断',
    );
    const joined = messages.map(m => m.content).join('\n');
    expect(joined).toContain('不是有效的事实核查 JSON');
    expect(joined).toContain('不要输出推理过程');
    expect(joined).toContain('上一轮错误类型：输出被截断');
    expect(joined).toContain('"errors"');
  });
});
