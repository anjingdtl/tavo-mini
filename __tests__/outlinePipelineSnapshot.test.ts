/**
 * Outline pipeline snapshot tests (大纲创作模式升级, 阶段 6-10).
 *
 * Verifies the frozen outline text flows from the snapshot to EVERY downstream
 * stage (review / factCheck / proof) so all stages of one task see the same
 * outline plan. Also verifies the stage prompts include the outline and the
 * outline-specific instructions (consistency review, fact-vs-plan separation,
 * proof protection).
 */
import {
  buildReviewMessages,
  buildFactCheckMessages,
  buildProofMessages,
  buildDraftMessages,
} from '../src/services/pipelineMessages';
import {
  buildReviewContextFromSnapshot,
  buildFactCheckContextFromSnapshot,
  buildProofConstraintsFromSnapshot,
} from '../src/types/pipelineContext';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';

const OUTLINE_TEXT =
  '【项目大纲｜最高创作约束】\n主角在第30章发现父亲是幕后主使。';

function snapshotWithOutline(outlineText: string): PipelineContextSnapshot {
  return {
    presetText: 'preset',
    storyMemoryText: 'story',
    characterText: 'char',
    noteText: 'note',
    worldbookText: 'wb',
    episodicMemoryText: 'episodic',
    recentBridgeText: 'bridge',
    currentInstructionText: 'instruction',
    retrievalUserPrompt: 'prompt',
    outlineText,
    outlineFingerprint: 'abc123',
    outlineIds: [1, 2],
    outlineComplete: true,
    outlineEstimatedTokens: 100,
  };
}

describe('outline snapshot flows to every stage', () => {
  test('review context carries outlineText from snapshot', () => {
    const snap = snapshotWithOutline(OUTLINE_TEXT);
    const ctx = buildReviewContextFromSnapshot(snap);
    expect(ctx.outlineText).toBe(OUTLINE_TEXT);
  });

  test('factCheck context carries outlineText from snapshot', () => {
    const snap = snapshotWithOutline(OUTLINE_TEXT);
    const ctx = buildFactCheckContextFromSnapshot(snap);
    expect(ctx.outlineText).toBe(OUTLINE_TEXT);
  });

  test('proof constraints carry outlineText from snapshot', () => {
    const snap = snapshotWithOutline(OUTLINE_TEXT);
    const ctx = buildProofConstraintsFromSnapshot(snap);
    expect(ctx.outlineText).toBe(OUTLINE_TEXT);
  });

  test('empty snapshot (no outline) carries empty outlineText to all stages', () => {
    const snap = snapshotWithOutline('');
    expect(buildReviewContextFromSnapshot(snap).outlineText).toBe('');
    expect(buildFactCheckContextFromSnapshot(snap).outlineText).toBe('');
    expect(buildProofConstraintsFromSnapshot(snap).outlineText).toBe('');
  });
});

describe('review stage outline assessment', () => {
  test('review prompt includes outline partition when outline present', () => {
    const ctx = buildReviewContextFromSnapshot(snapshotWithOutline(OUTLINE_TEXT));
    const messages = buildReviewMessages('draft', ctx);
    const userContent = messages.find(m => m.role === 'user')!.content;
    expect(userContent).toContain('项目大纲');
    expect(userContent).toContain(OUTLINE_TEXT);
  });

  test('review prompt requests outlineAssessment when outline present', () => {
    const ctx = buildReviewContextFromSnapshot(snapshotWithOutline(OUTLINE_TEXT));
    const messages = buildReviewMessages('draft', ctx);
    const systemContent = messages.find(m => m.role === 'system')!.content;
    expect(systemContent).toContain('outlineAssessment');
    expect(systemContent).toContain('主线推进');
  });

  test('review prompt omits outlineAssessment when no outline', () => {
    const ctx = buildReviewContextFromSnapshot(snapshotWithOutline(''));
    const messages = buildReviewMessages('draft', ctx);
    const systemContent = messages.find(m => m.role === 'system')!.content;
    expect(systemContent).not.toContain('outlineAssessment');
  });
});

describe('fact-check stage plan vs fact separation', () => {
  test('factCheck prompt labels outline as future plan, not facts', () => {
    const ctx = buildFactCheckContextFromSnapshot(snapshotWithOutline(OUTLINE_TEXT));
    const messages = buildFactCheckMessages('draft', ctx);
    const userContent = messages.find(m => m.role === 'user')!.content;
    expect(userContent).toContain('项目大纲');
    expect(userContent).toContain('未来规划，非已发生事实');
  });

  test('factCheck system prompt distinguishes future events from facts', () => {
    const ctx = buildFactCheckContextFromSnapshot(snapshotWithOutline(OUTLINE_TEXT));
    const messages = buildFactCheckMessages('draft', ctx);
    const systemContent = messages.find(m => m.role === 'system')!.content;
    expect(systemContent).toContain('未来事件不能被当作已经发生');
    expect(systemContent).toContain('不应建议回滚历史');
  });

  test('factCheck prompt has no outline rules when outline absent', () => {
    const ctx = buildFactCheckContextFromSnapshot(snapshotWithOutline(''));
    const messages = buildFactCheckMessages('draft', ctx);
    const systemContent = messages.find(m => m.role === 'system')!.content;
    expect(systemContent).not.toContain('未来事件不能被当作已经发生');
  });
});

describe('proof stage outline protection', () => {
  test('proof prompt includes outline in constraints when present', () => {
    const ctx = buildProofConstraintsFromSnapshot(snapshotWithOutline(OUTLINE_TEXT));
    const messages = buildProofMessages('draft', '', '', ctx);
    const userContent = messages.find(m => m.role === 'user')!.content;
    expect(userContent).toContain('项目大纲');
    expect(userContent).toContain(OUTLINE_TEXT);
  });

  test('proof system prompt has protection rules when outline present', () => {
    const ctx = buildProofConstraintsFromSnapshot(snapshotWithOutline(OUTLINE_TEXT));
    const messages = buildProofMessages('draft', '', '', ctx);
    const systemContent = messages.find(m => m.role === 'system')!.content;
    expect(systemContent).toContain('保留已正确完成的大纲节点');
    expect(systemContent).toContain('不得为了服从旧大纲而回滚');
  });

  test('proof system prompt has no outline rules when outline absent', () => {
    const ctx = buildProofConstraintsFromSnapshot(snapshotWithOutline(''));
    const messages = buildProofMessages('draft', '', '', ctx);
    const systemContent = messages.find(m => m.role === 'system')!.content;
    expect(systemContent).not.toContain('大纲节点');
  });
});

describe('draft stage outline-aware instructions', () => {
  test('draft downgrades chapter synopsis to execution goal when outline present', () => {
    const messages = buildDraftMessages(
      [],
      '第8章',
      '',
      'user prompt',
      undefined,
      '本章概要',
      OUTLINE_TEXT,
    );
    const userContent = messages.find(m => m.role === 'user')!.content;
    expect(userContent).toContain('当前章节执行目标');
    expect(userContent).toContain('只能细化大纲，不得改变主线');
    expect(userContent).not.toContain('章节大纲（必须遵循）');
  });

  test('draft keeps chapter synopsis as must-follow when no outline', () => {
    const messages = buildDraftMessages(
      [],
      '第8章',
      '',
      'user prompt',
      undefined,
      '本章概要',
      undefined,
    );
    const userContent = messages.find(m => m.role === 'user')!.content;
    expect(userContent).toContain('章节大纲（必须遵循）');
  });

  test('draft includes outline-servicing rules when outline present', () => {
    const messages = buildDraftMessages(
      [],
      '第8章',
      '',
      'user prompt',
      undefined,
      '',
      OUTLINE_TEXT,
    );
    const userContent = messages.find(m => m.role === 'user')!.content;
    expect(userContent).toContain('不得提前完成属于后续章节的关键事件');
    expect(userContent).toContain('不得为了服从旧大纲而回滚既有事实');
  });
});
