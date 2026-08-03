import { cloneDefaultContextAutomationPolicy } from '../src/services/contextAutomationPolicy';
import {
  resolveContinuationV4BudgetPreview,
  type ContinuationV4StageBudget,
} from '../src/services/continuation/generation/continuationV4Budget';
import {
  buildContinuationV4StageViews,
  EXTERNAL_SUPPLEMENT_WRAPPER,
  hashContinuationV4StageView,
} from '../src/services/continuation/generation/continuationV4ContextViews';
import type { ContinuationContextSnapshot } from '../src/services/continuation/generation/types';

function snapshot(): ContinuationContextSnapshot {
  return {
    projectId: 1,
    targetChapterId: 8,
    targetPosition: 4 as any,
    canon: {
      snapshotId: 'canon_1',
      revision: 3,
      boundaryGlobalCharOffset: 100,
      capabilities: {} as any,
    },
    inputRevisionHash: 'input_hash',
    style: null,
    primaryAnchor: {
      kind: 'continuation_chapter',
      chapterId: 7,
      position: 3 as any,
      summary: '上一章结尾',
      excerpt: '风停在门外。',
    } as any,
    settingsSnapshot: {
      schemaVersion: 1,
      values: { targetChapterChars: 3000 },
    } as any,
    bundles: {
      lockedRules: ['不可复活'],
      canon: {
        snapshot: {} as any,
        worldRules: [
          {
            id: 1,
            title: '死亡规则',
            description: '死亡不可逆',
            constraintLevel: 'hard',
          } as any,
        ],
        characters: [],
        characterStates: [],
        relationships: [],
        experiences: [],
        knowledge: [],
        plotThreads: [],
        timelineEvents: [],
        evidenceRefs: [11],
        evidenceRefsByOwner: { world_rule: { 1: [11] } },
        estimatedTokens: 20,
        omittedReasonCounts: {},
      },
      effectiveState: {
        characterStates: [],
        relationships: [],
        plotThreads: [],
        knowledge: [],
        experiences: [],
      } as any,
      seam: { summary: '接缝', excerpt: '接缝摘要' },
      recentChapters: [],
      storyMemory: { summary: '长期状态', estimatedTokens: 3 },
      episodic: [{ chapterId: 7, summary: '上一章事件' }],
      style: null,
      supplements: {
        characterText: '角色补充正文',
        worldbookText: '世界规则补充正文',
        noteText: '笔记补充正文',
        presetText: '预设补充正文',
        selected: [
          {
            resourceKind: 'character',
            resourceId: 1,
            title: '角色',
            estimatedTokens: 5,
            contentHash: 'char_hash',
            stageEligibility: ['writer', 'checker', 'repair'],
          },
          {
            resourceKind: 'note',
            resourceId: 2,
            title: '笔记',
            estimatedTokens: 5,
            contentHash: 'note_hash',
            stageEligibility: ['writer', 'repair'],
          },
        ],
        excluded: [],
      },
      userInstruction: '推进冲突',
    },
    source: {} as any,
    storyMemory: { stateFingerprint: 'state', throughPosition: -1, status: 'ready' },
    createdAt: '2026-08-03T00:00:00.000Z',
    schemaVersion: 2,
  };
}

function budgets(): Record<'writer' | 'checker' | 'control' | 'repair', ContinuationV4StageBudget> {
  return resolveContinuationV4BudgetPreview({
    frozenPolicy: cloneDefaultContextAutomationPolicy(),
    stages: {
      writer: { configId: 1, contextWindow: 128000, maxOutputTokens: 32000 },
      checker: { configId: 2, contextWindow: 64000, maxOutputTokens: 16000 },
      control: { configId: 3, contextWindow: 64000, maxOutputTokens: 16000 },
      repair: { configId: 4, contextWindow: 128000, maxOutputTokens: 32000 },
    },
    targetChapterChars: 3000,
    writerDraftTokens: 9000,
    paragraphCount: 20,
    compiledPromptTokens: 1000,
    protocolSkeletonTokens: 100,
  }).stages;
}

describe('Continuation V4 frozen stage views', () => {
  test('四个视图从同一 snapshot 派生并按职责裁剪', () => {
    const views = buildContinuationV4StageViews({
      snapshot: snapshot(),
      stageBudgets: budgets(),
    });

    expect(views.writer.canon.worldRules[0].title).toBe('死亡规则');
    expect(views.writer.supplements.contentHashes).toEqual([
      'char_hash',
      'note_hash',
    ]);
    expect(views.checker.canon.hardFacts[0].evidenceIds).toEqual([11]);
    expect(views.checker.supplements.contentHashes).toEqual(['char_hash']);
    expect(views.control).not.toHaveProperty('canon');
    expect(views.control).not.toHaveProperty('supplements');
    expect(views.repair.supplements.contentHashes).toEqual([
      'char_hash',
      'note_hash',
    ]);
    expect(views.writer.supplements.text).toContain(EXTERNAL_SUPPLEMENT_WRAPPER);
    expect(views.control.lockedRuleSummary).toEqual(['不可复活']);
  });

  test('视图哈希稳定且只由冻结视图内容决定', () => {
    const views = buildContinuationV4StageViews({
      snapshot: snapshot(),
      stageBudgets: budgets(),
    });
    const first = hashContinuationV4StageView(views.writer);
    const second = hashContinuationV4StageView(views.writer);
    expect(first).toBe(second);
    expect(first).toHaveLength(64);
    expect(hashContinuationV4StageView(views.control)).not.toBe(first);
  });
});
