import {
  compileContinuationV4CheckerMessages,
  compileContinuationV4ControlMessages,
  compileContinuationV4RepairMessages,
  compileContinuationV4WriterMessages,
  continuationV4ProtocolSkeletonTokens,
  buildRepairUnifiedTasks,
  injectRepairAnchors,
  stripRepairAnchors,
  renderStyleFinding,
  resolveStyleFindingExcerpt,
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
  minHanCharacters: 2100,
  maxHanCharacters: 3900,
  missingToMinimum: 100,
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
  allowedMinHan: 2100,
  allowedMaxHan: 3900,
  suggestions: [],
  findings: [],
  styleIssues: [],
  styleWarnings: [],
  preserve: ['章末钩子'],
} as any;

describe('Continuation V4 Prompt contracts', () => {
  test('Writer 注入 ±30% 软区间与自然深化引导，不分配 Beat 数字预算', () => {
    for (const target of [1800, 3200, 6000]) {
      const messages = compileContinuationV4WriterMessages({
        ...writerView,
        targetChapterChars: target,
      });
      const system = messages[0].content;
      expect(system).toContain(`约 ${target} 个汉字`);
      expect(system).toContain('±30%');
      expect(system).toContain('优先深化已有场景');
      expect(system).not.toContain('为每个 beat');
      expect(system).not.toContain('可自然长于或短于');
      expect(system).not.toContain('汉字产出硬目标');
      expect(system).not.toContain('最低合格线');
      expect(system).not.toContain('在 content 未达到最低合格线');
      expect(system).toContain('不得为了接近参考字数');
    }
    const tail = compileContinuationV4WriterMessages(writerView)[1].content;
    expect(tail).toContain('大致接近 3000 个汉字参考目标');
    expect(tail).not.toContain('是哪个节拍被压缩了');
  });

  test('Writer 使用完整初稿 envelope 与动态目标体量', () => {
    const messages = compileContinuationV4WriterMessages(writerView);
    const system = messages[0].content;
    expect(system).toContain('schemaVersion');
    expect(system).toContain('约 3000 个汉字');
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

  test('renderStyleFinding 从 offset 切片命中原文，不使用证据占位', () => {
    const artifactText = '他感到非常悲伤，因为失去了一切。门外风声未停。';
    const finding = {
      findingId: 'style_1',
      subtype: 'emotional_expression',
      styleDimension: 'emotional_expression',
      severity: 'error' as const,
      location: 'utf16:0-14',
      generatedStart: 0,
      generatedEnd: 14,
      description: '模板化心理',
      suggestedFix: '改为动作表现',
      rewriteGoal: '改为动作表现',
      preserveMeaning: ['保留事件'],
      styleEvidenceIds: ['s1'],
      repairReady: true,
    };
    const rendered = JSON.parse(renderStyleFinding(finding as any, artifactText));
    expect(rendered.generatedExcerpt).toBe(artifactText.slice(0, 14));
    expect(rendered.styleEvidenceIds).toEqual(['s1']);
    expect(rendered.styleEvidenceIds).not.toContain('x');
    expect(resolveStyleFindingExcerpt(finding as any, artifactText)).toBe(
      artifactText.slice(0, 14),
    );

    const noEvidence = JSON.parse(
      renderStyleFinding(
        {
          ...finding,
          styleEvidenceIds: [],
          repairReady: false,
          generatedExcerpt: undefined,
        } as any,
        artifactText,
      ),
    );
    expect(noEvidence.styleEvidenceIds).toEqual([]);
    expect(noEvidence.repairReady).toBe(false);
  });

  test('Repair Prompt 含统一任务清单、锚点与文风 excerpt', () => {
    const artifactText = '完整 Writer 正文冲突片段XX后续';
    const messages = compileContinuationV4RepairMessages({
      view: repairView,
      artifactText,
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
            generatedStart: 9,
            generatedEnd: 13,
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
            location: 'utf16:0-8',
            generatedStart: 0,
            generatedEnd: 8,
            description: '模板化心理',
            suggestedFix: '改为动作表现',
            rewriteGoal: '改为动作表现',
            preserveMeaning: ['保留事件'],
            styleEvidenceIds: ['s1'],
            bindingStatus: 'bound_by_range',
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
            generatedEnd: 8,
            generatedExcerpt: '完整 Wri',
            description: '模板化心理',
            styleEvidenceIds: ['s1'],
            bindingStatus: 'bound_by_range',
            rewriteGoal: '改为动作表现',
            preserveMeaning: ['保留事件'],
            repairReady: true,
          },
        ],
      } as any,
    });
    const system = messages[0].content;
    const user = messages[1].content;
    expect(system).toContain('统一可执行任务清单');
    expect(system).toContain('[checker] subtype=canon_conflict taskId=9');
    expect(system).toContain('subtype=emotional_expression');
    expect(system).toContain(
      '[style_control] subtype=emotional_expression taskId=style_1',
    );
    expect(system).toContain('统一可执行任务清单');
    expect(system).toContain('style_1');
    expect(system).toContain('完整 Wri');
    expect(user).toContain('⟦ISSUE_');
    expect(user).toContain('_START⟧');
    expect(system).toContain('禁止保留任何锚点标记');
  });

  test('Repair 不把长度偏差编译成自动 Repair 任务', () => {
    const shortText = '甲'.repeat(1000);
    const messages = compileContinuationV4RepairMessages({
      view: repairView,
      artifactText: shortText,
      plan,
      checkerReport: {
        issues: [
          {
            id: 42,
            category: 'style',
            subtype: 'chapter_length_under_target',
            severity: 'error',
            description: '偏短',
            suggestedFix: '深化扩写',
            generatedStart: null,
            generatedEnd: null,
            generatedExcerpt: '',
            evidenceIds: [],
          } as any,
        ],
      },
      controlReport,
    });
    expect(messages[0].content).toContain('篇幅偏差仅供参考，未因此触发自动 Repair');
    expect(messages[0].content).not.toContain('定向深化扩写');
    const tasks = buildRepairUnifiedTasks({
      artifactText: shortText,
      checkerReport: {
        issues: [
          {
            id: 42,
            category: 'style',
            subtype: 'chapter_length_under_target',
            severity: 'error',
            description: '偏短',
            suggestedFix: '深化扩写',
            generatedStart: null,
            generatedEnd: null,
            generatedExcerpt: '',
          } as any,
        ],
      },
      controlReport,
    });
    expect(tasks.some(t => t.description === '偏短')).toBe(false);
  });

  test('锚点注入/剥离往返一致', () => {
    const text = '前文对峙片段后文收束。';
    const tasks = [
      {
        taskIndex: 1,
        taskId: '1',
        subtype: 'canon_conflict',
        source: 'checker' as const,
        priority: 20,
        contextBefore: '',
        contextAfter: '',
        description: '冲突',
        suggestedFix: '改',
        generatedStart: 2,
        generatedEnd: 6,
        generatedExcerpt: '对峙片段',
        evidenceIds: [1],
        confidence: 0.9,
        forbiddenChanges: [],
        anchorInjected: false,
        issueIndex: 1,
        kind: 'checker' as const,
        id: '1',
      },
    ];
    const anchored = injectRepairAnchors(text, tasks);
    expect(anchored.text).toContain('⟦ISSUE_1_START⟧对峙片段⟦ISSUE_1_END⟧');
    expect(anchored.injectedTaskIndexes).toEqual([1]);
    const stripped = stripRepairAnchors(anchored.text);
    expect(stripped.hadAnchors).toBe(true);
    expect(stripped.text).toBe(text);
    expect(stripRepairAnchors(text).hadAnchors).toBe(false);
  });

  test('混合 Checker+Control 任务合并进同一次 Repair 清单，长度不入卡', () => {
    const tasks = buildRepairUnifiedTasks({
      artifactText: '问题原句模板化心理后文',
      checkerReport: {
        issues: [
          {
            id: 1,
            category: 'plot',
            subtype: 'canon_conflict',
            severity: 'error',
            description: '冲突',
            suggestedFix: '改写',
            generatedStart: 0,
            generatedEnd: 4,
            generatedExcerpt: '问题原句',
            evidenceIds: [1],
          } as any,
          {
            id: 2,
            category: 'style',
            subtype: 'chapter_length_under_target',
            severity: 'error',
            description: '短',
            suggestedFix: '扩',
            generatedStart: null,
            generatedEnd: null,
            generatedExcerpt: '',
          } as any,
        ],
      },
      controlReport: {
        ...controlReport,
        findings: [
          {
            findingId: 'style_1',
            subtype: 'padding',
            severity: 'error',
            location: 'utf16:4-9',
            generatedStart: 4,
            generatedEnd: 9,
            generatedExcerpt: '模板化心理',
            description: '注水',
            suggestedFix: '删水',
            rewriteGoal: '删水',
            preserveMeaning: ['事件'],
            styleEvidenceIds: ['e1'],
            confidence: 0.9,
            bindingStatus: 'bound_by_range',
            repairReady: true,
          },
        ],
      },
    });
    expect(tasks.map(t => t.kind).sort()).toEqual(['checker', 'control'].sort());
    expect(tasks).toHaveLength(2);
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
    expect(messages[0].content).toContain('篇幅偏差仅供参考，未因此触发自动 Repair');
    expect(messages[0].content).toContain('appliedControlFindingIds');
    expect(messages[0].content).not.toContain('最低实质进度');
    expect(messages[0].content).not.toContain('requiredProgress');
    expect(messages[1].content).toContain('完整 Writer 初稿开始');
    expect(messages[0].content).not.toContain('冻结 Canon 审查依据');
  });

  test('protocol skeleton demand is measured, not a stage token constant', () => {
    expect(continuationV4ProtocolSkeletonTokens('writer')).toBeGreaterThan(0);
    expect(continuationV4ProtocolSkeletonTokens('repair')).toBeGreaterThan(0);
    expect(continuationV4ProtocolSkeletonTokens('control')).toBeGreaterThan(0);
  });
});
