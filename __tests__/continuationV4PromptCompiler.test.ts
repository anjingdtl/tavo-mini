import {
  compileContinuationV4CheckerMessages,
  compileContinuationV4ControlMessages,
  compileContinuationV4RepairMessages,
  compileContinuationV4WriterMessages,
  continuationV4ProtocolSkeletonTokens,
} from '../src/services/continuation/generation/continuationV4PromptCompiler';

const budget = {
  minimumOutputTokens: 1000,
  maximumOutputTokens: 8000,
} as any;

const refs = {
  canonSnapshotId: 'canon_1',
  canonRevision: 3,
  inputRevisionHash: 'input_hash',
  styleProfileHash: 'style_hash',
};

const writerView = {
  targetChapterChars: 3000,
  userInstruction: '推进冲突',
  lockedRules: ['不可复活'],
  canon: { worldRules: [{ title: '死亡规则', description: '不可逆' }] },
  effectiveState: {},
  primaryAnchor: { summary: '接缝', excerpt: '接缝正文' },
  recentChapters: [],
  storyMemory: { summary: '长期状态' },
  episodic: [],
  style: { text: '短句、克制', quantitative: {}, omittedReason: null },
  supplements: { text: '外部资料包装', contentHashes: ['supp_hash'] },
  budget,
  snapshotRefs: refs,
} as any;

const checkerView = {
  targetChapterChars: 3000,
  userInstruction: '推进冲突',
  lockedRules: ['不可复活'],
  canon: {
    hardFacts: [
      { ownerType: 'world_rule', ownerId: 1, text: '死亡不可逆', evidenceIds: [11] },
    ],
    softFacts: [],
  },
  effectiveState: {},
  seam: { summary: '接缝', excerpt: '接缝摘要' },
  style: { text: '审查风格', quantitative: {}, omittedReason: null },
  supplements: { text: '审查资料', contentHashes: ['supp_hash'] },
  budget,
  snapshotRefs: refs,
} as any;

const controlView = {
  targetChapterChars: 3000,
  userInstruction: '推进冲突',
  lockedRuleSummary: ['不可复活'],
  style: { text: '短句克制', quantitative: { dialogueRatio: 0.2 }, omittedReason: null },
  budget,
  snapshotRefs: refs,
} as any;

const repairView = {
  targetChapterChars: 3000,
  userInstruction: '推进冲突',
  lockedRules: ['不可复活'],
  canon: checkerView.canon,
  effectiveState: {},
  primaryAnchorSummary: '不得复述接缝',
  recentBridgeSummary: '上一章摘要',
  style: { text: '终稿风格', quantitative: {}, omittedReason: null },
  supplements: { text: '终稿资料', contentHashes: ['supp_hash'] },
  budget,
  snapshotRefs: refs,
} as any;

const plan = {
  schemaVersion: 1,
  chapterGoal: '推进',
  centralConflict: '冲突',
  beats: [{ order: 1, summary: '对峙' }],
  participatingCharacterIds: [],
  characterActions: [],
  plotAdvances: [],
  foreshadowingActions: [],
  proposedStateChanges: [],
  risks: [],
} as any;

const metrics = {
  actualHanCharacters: 2000,
  targetHanCharacters: 3000,
  minHanCharacters: 2500,
  maxHanCharacters: 3500,
  missingToMinimum: 500,
  excessOverMaximum: 0,
  deltaToTarget: -1000,
  paragraphs: [],
  dialogueHanRatio: 0.2,
  paragraphLengthDistribution: { min: 0, max: 0, mean: 0, median: 0 },
  duplicateWindows: [],
  beatCoverage: [],
  insertionBoundaries: [],
} as any;

const controlReport = {
  schemaVersion: 2 as const,
  action: 'keep' as const,
  currentHan: 2000,
  targetHan: 3000,
  allowedMinHan: 2500,
  allowedMaxHan: 3500,
  suggestions: [],
  findings: [],
  styleIssues: [],
  styleWarnings: [],
  preserve: ['章末钩子'],
} as any;

describe('Continuation V4 Prompt contracts', () => {
  test('Writer 动态注入不同用户目标字数为弱提示', () => {
    for (const target of [1800, 3200, 6000]) {
      const messages = compileContinuationV4WriterMessages({
        ...writerView,
        targetChapterChars: target,
      });
      const system = messages[0].content;
      expect(system).toContain(`参考篇幅约为 ${target} 个汉字`);
      expect(system).toContain('不是必须机械达到的硬指标');
      expect(system).not.toContain('汉字产出硬目标');
      expect(system).not.toContain('最低合格线');
      expect(system).not.toContain('在 content 未达到最低合格线');
      expect(system).toContain('不得为了接近参考字数');
      expect(system).toContain('不要求逐项机械复现');
    }
  });

  test('Writer 使用完整初稿 envelope 与动态参考篇幅', () => {
    const messages = compileContinuationV4WriterMessages(writerView);
    const system = messages[0].content;
    expect(system).toContain('schemaVersion');
    expect(system).toContain('参考篇幅约为 3000 个汉字');
    expect(system).toContain('外部资料包装');
    expect(system).toContain('minimumOutputTokens');
    expect(messages[1].content).toContain('Writer 输出前最后检查');
  });

  test('Checker 只审查五维资料并排除字数/文风硬任务', () => {
    const messages = compileContinuationV4CheckerMessages({
      view: checkerView,
      artifactText: 'Writer 正文',
      writerArtifactHash: 'writer_hash',
      plan,
    });
    expect(messages[0].content).toContain('原著五维资料一致性');
    expect(messages[0].content).toContain('writerArtifactHash');
    expect(messages[0].content).toContain('chapter_length');
    expect(messages[0].content).toContain('不负责：字数、文风');
    expect(messages[1].content).toContain('writer_hash');
    expect(messages[0].content).toContain('generatedExcerpt');
    expect(messages[0].content).toContain('suggestedFix');
  });

  test('Control 改为原著文风审查，不要求 expand/compress', () => {
    const messages = compileContinuationV4ControlMessages({
      view: controlView,
      artifactText: 'Writer 正文',
      metrics,
      plan,
      writerArtifactHash: 'writer_hash',
    });
    expect(messages[0].content).toContain('原著文风一致性审查');
    expect(messages[0].content).toContain('emotional_expression');
    expect(messages[0].content).toContain('ai_template');
    expect(messages[0].content).not.toContain('keep|expand|compress');
    expect(messages[0].content).toContain('不负责 expand/compress');
    expect(messages[0].content).toContain('短句克制');
  });

  test('Repair contract 最小干预且必须输出完整章节', () => {
    const messages = compileContinuationV4RepairMessages({
      view: repairView,
      artifactText: '完整 Writer 正文',
      plan,
      checkerReport: { issues: [] },
      controlReport,
    });
    expect(messages[0].content).toContain('最小干预修订者');
    expect(messages[0].content).toContain('即使只修改一句话');
    expect(messages[0].content).toContain('完整终稿');
    expect(messages[0].content).toContain('不得为了接近参考字数');
    expect(messages[0].content).toContain('appliedControlFindingIds');
    expect(messages[0].content).not.toContain('最低实质进度');
    expect(messages[0].content).not.toContain('requiredProgress');
    expect(messages[1].content).toContain('完整 Writer 初稿开始');
    expect(messages[0].content).not.toContain('冻结 Canon 审查依据');
  });

  test('Repair Prompt 含 Checker 五维与 Control 文风两组任务', () => {
    const messages = compileContinuationV4RepairMessages({
      view: repairView,
      artifactText: '完整 Writer 正文',
      plan,
      checkerReport: {
        issues: [
          {
            id: 9,
            generatedExcerpt: '冲突片段',
            description: '冻结冲突',
            evidenceIds: [3],
            category: 'plot',
            severity: 'error',
            subtype: 'canon_conflict',
            suggestedFix: '改写冲突片段',
            generatedStart: 0,
            generatedEnd: 4,
          } as any,
        ],
      },
      controlReport: {
        ...controlReport,
        findings: [
          {
            findingId: 'style_1',
            subtype: 'emotional_expression',
            styleDimension: 'emotional_expression',
            severity: 'error',
            location: 'utf16:0-10',
            generatedStart: 0,
            generatedEnd: 10,
            description: '模板化心理',
            suggestedFix: '改为动作表现',
            rewriteGoal: '改为动作表现',
            preserveMeaning: ['保留事件'],
            styleEvidenceIds: ['s1'],
            repairReady: true,
          },
        ],
        styleIssues: [
          {
            findingId: 'style_1',
            styleDimension: 'emotional_expression',
            severity: 'error',
            confidence: 0.9,
            generatedStart: 0,
            generatedEnd: 10,
            generatedExcerpt: '冲突片段XX',
            description: '模板化心理',
            styleEvidenceIds: ['s1'],
            rewriteGoal: '改为动作表现',
            preserveMeaning: ['保留事件'],
            repairReady: true,
          },
        ],
      } as any,
    });
    const system = messages[0].content;
    expect(system).toContain('Checker：五维资料一致性修订');
    expect(system).toContain('Control：原著文风修订');
    expect(system).toContain('repairReady');
    expect(system).toContain('style_1');
  });

  test('protocol skeleton demand is measured, not a stage token constant', () => {
    expect(continuationV4ProtocolSkeletonTokens('writer')).toBeGreaterThan(0);
    expect(continuationV4ProtocolSkeletonTokens('repair')).toBeGreaterThan(0);
    expect(continuationV4ProtocolSkeletonTokens('control')).toBeGreaterThan(0);
  });
});
