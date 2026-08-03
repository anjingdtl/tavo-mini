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
  style: { text: '', quantitative: { dialogueRatio: 0.2 }, omittedReason: null },
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
  beats: [{ order: 1, summary: '承接' }],
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
  insertionBoundaries: [0],
} as any;

const controlReport = {
  schemaVersion: 1,
  action: 'expand',
  currentHan: 2000,
  targetHan: 3000,
  allowedMinHan: 2500,
  allowedMaxHan: 3500,
  suggestions: [],
  preserve: ['章末钩子'],
} as any;

describe('Continuation V4 Prompt contracts', () => {
  test('Writer 使用完整初稿 envelope 与动态长度契约', () => {
    const messages = compileContinuationV4WriterMessages(writerView);
    const system = messages[0].content;
    expect(system).toContain('schemaVersion');
    expect(system).toContain('Writer 本次汉字产出硬目标');
    expect(system).toContain('在 content 未达到最低合格线 2500 前不得结束章节');
    expect(system).toContain('而不是约 3000 个 token');
    expect(system).toContain('2500–3500');
    expect(system).toContain('外部资料包装');
    expect(system).toContain('minimumOutputTokens');
    expect(messages[1].content).toContain('Writer 输出前最后检查');
    expect(messages[1].content).toContain('必须落在 2500–3500');
    expect(messages[1].content).toContain('不要把 plan 或 content 提升到顶层');
  });

  test('Checker 绑定 Writer hash 并排除本地硬门禁重复问题', () => {
    const messages = compileContinuationV4CheckerMessages({
      view: checkerView,
      artifactText: 'Writer 正文',
      writerArtifactHash: 'writer_hash',
      plan,
    });
    expect(messages[0].content).toContain('writerArtifactHash');
    expect(messages[0].content).toContain('source_overlap');
    expect(messages[1].content).toContain('writer_hash');
  });

  test('Control 只看到本地指标和量化风格，不看到 Canon/原始补充', () => {
    const messages = compileContinuationV4ControlMessages({
      view: controlView,
      artifactText: 'Writer 正文',
      metrics,
      plan,
    });
    expect(messages[0].content).toContain('actualHanCharacters');
    expect(messages[0].content).toContain('dialogueRatio');
    expect(messages[0].content).not.toContain('外部资料包装');
    expect(messages[0].content).not.toContain('canonSnapshotId');
  });

  test('Repair contract 只能输出完整终稿 envelope', () => {
    const messages = compileContinuationV4RepairMessages({
      view: repairView,
      artifactText: '完整 Writer 正文',
      plan,
      checkerReport: { issues: [] },
      controlReport,
    });
    expect(messages[0].content).toContain('完整终稿 envelope');
    expect(messages[0].content).toContain('2500–3500');
    expect(messages[0].content).toContain('五个顶层字段一个都不能省略');
    expect(messages[0].content).toContain('finalText、final_content、text、draft、result');
    expect(messages[0].content).toContain('当前 2000 个汉字');
    expect(messages[0].content).toContain('至少还缺 500 个汉字');
    expect(messages[1].content).toContain('appliedControlSuggestionIds');
    expect(messages[0].content).not.toContain('"patches"');
    expect(messages[1].content).toContain('完整 Writer 初稿开始');
  });

  test('protocol skeleton demand is measured, not a stage token constant', () => {
    expect(continuationV4ProtocolSkeletonTokens('writer')).toBeGreaterThan(0);
    expect(continuationV4ProtocolSkeletonTokens('repair')).toBeGreaterThan(0);
  });
});
