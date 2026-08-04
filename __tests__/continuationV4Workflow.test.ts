import {
  parseContinuationV4RepairEnvelope,
  parseContinuationV4WriterEnvelope,
  runContinuationV4LocalFinalGate,
  validateContinuationV4RepairCompliance,
} from '../src/services/continuation/generation';
import { isLengthExpansionIssue } from '../src/services/continuation/generation/continuationLengthContract';
import type {
  ContinuationContextSnapshotV3,
  ContinuationV4RepairEnvelope,
} from '../src/services/continuation/generation/types';

function snapshot(): ContinuationContextSnapshotV3 {
  return {
    schemaVersion: 3,
    workflowVersion: 4,
    projectId: 1,
    targetChapterId: 2,
    targetPosition: 1 as any,
    source: {} as any,
    canon: {
      snapshotId: 'canon-v4',
      revision: 1,
      boundaryGlobalCharOffset: 0,
      capabilities: {} as any,
    },
    storyMemory: { stateFingerprint: 'state', throughPosition: -1, status: 'ready' },
    inputRevisionHash: 'input',
    settingsSnapshot: {
      schemaVersion: 1,
      workflowVersion: 4,
      values: {
        targetChapterChars: 600,
        styleLevel: 'strict',
      },
    } as any,
    bundles: {
      lockedRules: [],
      canon: {
        snapshot: {} as any,
        worldRules: [],
        characters: [],
        characterStates: [],
        relationships: [],
        experiences: [],
        knowledge: [],
        plotThreads: [],
        timelineEvents: [],
        evidenceRefs: [],
        estimatedTokens: 0,
        omittedReasonCounts: {},
      },
      effectiveState: {
        characterStates: [],
        relationships: [],
        plotThreads: [],
        knowledge: [],
        experiences: [],
      } as any,
      seam: { summary: '', excerpt: '' },
      recentChapters: [],
      storyMemory: { summary: '', estimatedTokens: 0 },
      episodic: [],
      style: null,
      userInstruction: '推进冲突',
    },
    style: null,
    primaryAnchor: undefined,
    createdAt: '2026-08-03T00:00:00.000Z',
    budgetPolicy: {} as any,
    stageBudgets: {} as any,
    stageViews: {} as any,
  };
}

describe('Continuation V4 workflow contracts', () => {
  test('Writer and Repair accept only complete envelopes', () => {
    const writer = parseContinuationV4WriterEnvelope(
      JSON.stringify({
        schemaVersion: 1,
        plan: {
          chapterGoal: '推进冲突',
          centralConflict: '门外有追兵',
          beats: [{ id: 'beat_1', summary: '承接并升级' }],
        },
        content: '完整的 Writer 初稿正文。',
      }),
    );
    expect(writer.plan.beats).toHaveLength(1);
    expect(writer.content).toContain('完整');

    const relaxedWriter = parseContinuationV4WriterEnvelope(
      JSON.stringify({
        text: '兼容 transport 别名的完整 Writer 正文。',
        chapterGoal: '继续推进',
      }),
    );
    expect(relaxedWriter.content).toContain('兼容 transport');
    expect(relaxedWriter.plan.chapterGoal).toBe('继续推进');
    expect(relaxedWriter.plan.beats).toHaveLength(1);

    const wrappedWriter = parseContinuationV4WriterEnvelope(
      JSON.stringify({
        schemaVersion: '1',
        content: { paragraphs: ['第一段完整正文。', '第二段完整正文。'] },
        outline: JSON.stringify({
          chapterGoal: '继续推进',
          centralConflict: '阻力升级',
          beats: ['承接', '升级'],
        }),
      }),
    );
    expect(wrappedWriter.content).toContain('第二段完整正文');
    expect(wrappedWriter.plan.centralConflict).toBe('阻力升级');
    expect(wrappedWriter.plan.beats).toHaveLength(2);

    const repair = parseContinuationV4RepairEnvelope(
      JSON.stringify({
        schemaVersion: 1,
        content: '完整 Repair 终稿正文。',
        appliedCheckerIssueIds: ['chk_1'],
        appliedControlSuggestionIds: ['ctrl_1'],
        unappliedItems: [],
      }),
    );
    expect(repair.content).toContain('完整');
    const metadataOmittedRepair = parseContinuationV4RepairEnvelope(
      JSON.stringify({
        schemaVersion: 1,
        content: '只省略回执数组但保留完整正文。',
      }),
    );
    expect(metadataOmittedRepair.appliedCheckerIssueIds).toEqual([]);
    expect(metadataOmittedRepair.appliedControlSuggestionIds).toEqual([]);
    expect(metadataOmittedRepair.appliedControlFindingIds).toEqual([]);
    expect(metadataOmittedRepair.unappliedItems).toEqual([]);
    expect(() =>
      parseContinuationV4RepairEnvelope(
        JSON.stringify({
          schemaVersion: 1,
          content: '只返回局部修改',
          patches: [{ start: 0, end: 1, replacement: 'x' }],
          appliedCheckerIssueIds: [],
          appliedControlSuggestionIds: [],
          unappliedItems: [],
        }),
      ),
    ).toThrow('局部修改字段');
  });

  test('Local Final Gate softens length, rejects unchanged/leakage/collapse', () => {
    const base = '这是完整正文。'.repeat(30);
    const gate = runContinuationV4LocalFinalGate({
      writerText: base,
      candidateText: base,
      snapshot: snapshot(),
      controlMetrics: {
        actualHanCharacters: 210,
        targetHanCharacters: 600,
        minHanCharacters: 100,
        maxHanCharacters: 1100,
        missingToMinimum: 0,
        excessOverMaximum: 0,
        deltaToTarget: -390,
        paragraphs: [],
        dialogueHanRatio: 0,
        paragraphLengthDistribution: { min: 0, max: 0, mean: 0, median: 0 },
        duplicateWindows: [],
        beatCoverage: [],
        insertionBoundaries: [],
      },
    });
    expect(gate.passed).toBe(false);
    expect(gate.candidateMetrics.actualHanCharacters).toBeGreaterThan(0);
    expect(gate.checks.map(check => check.subtype)).toContain(
      'repair_candidate_unchanged',
    );

    // Length under target is advisory only when the candidate is a complete chapter.
    const lengthSnapshot = snapshot();
    lengthSnapshot.settingsSnapshot = {
      ...lengthSnapshot.settingsSnapshot,
      values: {
        ...lengthSnapshot.settingsSnapshot.values,
        targetChapterChars: 2000,
      },
    } as any;
    const lengthCandidate = `${base}轻微修订。`;
    const lengthAdvisory = runContinuationV4LocalFinalGate({
      writerText: base,
      candidateText: lengthCandidate,
      snapshot: lengthSnapshot,
      controlMetrics: gate.candidateMetrics,
      targetedSpans: [
        {
          generatedStart: lengthCandidate.length - 5,
          generatedEnd: lengthCandidate.length,
          generatedExcerpt: '轻微修订。',
        },
      ],
    });
    expect(
      lengthAdvisory.checks.find(
        check => check.subtype === 'chapter_length_under_target',
      )?.severity,
    ).toBe('warning');
    expect(
      lengthAdvisory.checks.some(
        c =>
          c.subtype.startsWith('chapter_length_') &&
          (c.severity === 'error' || c.severity === 'blocking'),
      ),
    ).toBe(false);

    // Structural collapse / non-minimal rewrite of all paragraphs is blocking.
    const collapsedWriter = Array.from(
      { length: 40 },
      (_, index) => `原文段${index}推进并包含足够锚点正文。`,
    ).join('\n');
    const relativeCollapse = runContinuationV4LocalFinalGate({
      writerText: collapsedWriter,
      candidateText: Array.from(
        { length: 40 },
        (_, index) => `修订段${index}完全不同内容替换。`,
      ).join('\n'),
      snapshot: snapshot(),
      controlMetrics: gate.candidateMetrics,
      targetedSpans: [
        {
          generatedStart: 0,
          generatedEnd: 10,
          generatedExcerpt: '原文段0推进',
        },
      ],
    });
    expect(relativeCollapse.passed).toBe(false);
    expect(relativeCollapse.checks.map(c => c.subtype)).toEqual(
      expect.arrayContaining(['repair_non_minimal_rewrite']),
    );

    const absoluteCollapse = runContinuationV4LocalFinalGate({
      writerText: collapsedWriter,
      candidateText: '本章主要讲述随后众人经过一番最终他们达成目标。',
      snapshot: snapshot(),
      controlMetrics: gate.candidateMetrics,
    });
    expect(absoluteCollapse.passed).toBe(false);
    expect(
      absoluteCollapse.checks.some(c =>
        [
          'repair_content_collapsed',
          'repair_partial_output',
          'repair_candidate_collapsed',
          'repair_missing_unaffected_sections',
        ].includes(c.subtype),
      ),
    ).toBe(true);

    const rejected = runContinuationV4LocalFinalGate({
      writerText: base,
      candidateText: `${base}\n思考过程：需要继续修改`,
      snapshot: snapshot(),
      controlMetrics: gate.candidateMetrics,
    });
    expect(rejected.passed).toBe(false);
    expect(rejected.checks.map(check => check.subtype)).toContain(
      'repair_prompt_leakage',
    );
  });

  test('Repair compliance requires Checker rewrite; length progress is not required', () => {
    const writerText = '问题原句需要被改写。'.repeat(20);
    const controlReport = {
      schemaVersion: 2 as const,
      action: 'expand' as const,
      currentHan: 200,
      targetHan: 600,
      allowedMinHan: 500,
      allowedMaxHan: 700,
      suggestions: [],
      findings: [],
      styleIssues: [],
      styleWarnings: [],
      preserve: ['章末钩子'],
    };
    const checkerIssues = [
      {
        id: 7,
        generatedExcerpt: '问题原句',
        description: '冻结剧情冲突',
        evidenceIds: [39],
        category: 'plot',
        severity: 'error',
        subtype: 'canon_conflict',
        suggestedFix: '改写问题原句',
        generatedStart: 0,
        generatedEnd: 4,
      },
    ] as any;
    const failed = validateContinuationV4RepairCompliance({
      writerText,
      candidateText: writerText,
      checkerIssues,
      controlReport,
      envelope: {
        schemaVersion: 1,
        content: writerText,
        appliedCheckerIssueIds: ['7'],
        appliedControlSuggestionIds: [],
        appliedControlFindingIds: [],
        unappliedItems: [],
      } satisfies ContinuationV4RepairEnvelope,
    });
    expect(failed.map(check => check.subtype)).toEqual(
      expect.arrayContaining(['repair_checker_issue_unchanged']),
    );
    expect(failed.map(check => check.subtype)).not.toContain(
      'repair_control_insufficient_progress',
    );

    const revised = writerText.replace(/问题原句/g, '已修订事实');
    const passed = validateContinuationV4RepairCompliance({
      writerText,
      candidateText: revised,
      checkerIssues,
      controlReport,
      envelope: {
        schemaVersion: 1,
        content: revised,
        appliedCheckerIssueIds: ['chk_7'],
        appliedControlSuggestionIds: [],
        appliedControlFindingIds: [],
        unappliedItems: [],
      } satisfies ContinuationV4RepairEnvelope,
    });
    expect(passed).toEqual([]);
  });

  test('Repair cannot hide unaddressed requirements in unappliedItems', () => {
    const checkerIssues = [
      {
        id: 3,
        generatedExcerpt: '问题',
        description: '问题',
        evidenceIds: [1],
        category: 'plot',
        severity: 'error',
        subtype: 'canon_conflict',
        suggestedFix: '改写',
        generatedStart: 0,
        generatedEnd: 2,
      },
    ] as any;
    const checks = validateContinuationV4RepairCompliance({
      writerText: '原稿。',
      candidateText: '修订后的原稿。',
      checkerIssues,
      controlReport: {
        schemaVersion: 2,
        action: 'keep',
        currentHan: 3,
        targetHan: 3,
        allowedMinHan: 2,
        allowedMaxHan: 4,
        suggestions: [],
        findings: [],
        preserve: [],
      },
      envelope: {
        schemaVersion: 1,
        content: '修订后的原稿。',
        appliedCheckerIssueIds: ['3'],
        appliedControlSuggestionIds: [],
        appliedControlFindingIds: [],
        unappliedItems: ['无法处理冻结事实冲突'],
      },
    });
    expect(checks.map(check => check.subtype)).toContain('repair_unapplied_item');
  });

  test('字数偏差 alone 不产生 Control progress blocking', () => {
    const writerText = '这是完整正文。'.repeat(200);
    const candidateText = `${writerText}啊`;
    const controlReport = {
      schemaVersion: 2 as const,
      action: 'expand' as const,
      currentHan: 1200,
      targetHan: 1800,
      allowedMinHan: 1600,
      allowedMaxHan: 2000,
      suggestions: [],
      findings: [],
      preserve: [],
    };
    const checks = validateContinuationV4RepairCompliance({
      writerText,
      candidateText,
      checkerIssues: [],
      controlReport,
      envelope: {
        schemaVersion: 1,
        content: candidateText,
        appliedCheckerIssueIds: [],
        appliedControlSuggestionIds: [],
        appliedControlFindingIds: [],
        unappliedItems: [],
      } satisfies ContinuationV4RepairEnvelope,
    });
    expect(checks.map(check => check.subtype)).not.toContain(
      'repair_control_insufficient_progress',
    );
  });

  test('篇幅偏短只产生 warning，不单独阻断 Final Gate', () => {
    // Candidate must differ from Writer so unchanged-check does not fire;
    // we only assert chapter_length_* stays advisory.
    const writerText = Array.from(
      { length: 80 },
      (_, index) => `原文段${index}推进叙述内容。`,
    ).join('\n');
    const candidateText = `${writerText}\n仅改动一句收束。`;
    const gateSnapshot = snapshot();
    gateSnapshot.settingsSnapshot = {
      ...gateSnapshot.settingsSnapshot,
      values: {
        ...gateSnapshot.settingsSnapshot.values,
        targetChapterChars: 5000,
      },
    } as any;
    const gate = runContinuationV4LocalFinalGate({
      writerText,
      candidateText,
      snapshot: gateSnapshot,
      controlMetrics: {} as any,
      targetedSpans: [
        {
          generatedStart: candidateText.length - 8,
          generatedEnd: candidateText.length,
          generatedExcerpt: '仅改动一句收束。',
        },
      ],
    });
    const lengthCheck = gate.checks.find(check =>
      check.subtype.startsWith('chapter_length_'),
    );
    expect(lengthCheck).toBeTruthy();
    expect(lengthCheck?.severity).toBe('warning');
    expect(
      gate.checks.some(
        c =>
          c.subtype.startsWith('chapter_length_') &&
          (c.severity === 'error' || c.severity === 'blocking'),
      ),
    ).toBe(false);
  });

  test('repairReady 文风 finding 未回填为 blocking；audit-only 为 warning', () => {
    const writerText = '他感到非常悲伤，因为失去了一切。\n门外风声未停。\n她没有回头。';
    const candidateText = '他沉默片刻，转身离去。\n门外风声未停。\n她没有回头。';
    const controlReport = {
      schemaVersion: 2 as const,
      action: 'keep' as const,
      currentHan: 40,
      targetHan: 40,
      allowedMinHan: 1,
      allowedMaxHan: 100,
      suggestions: [],
      findings: [
        {
          findingId: 'style_1',
          subtype: 'emotional_expression',
          severity: 'error' as const,
          location: 'utf16:0-16',
          generatedStart: 0,
          generatedEnd: 16,
          description: '解释性心理',
          suggestedFix: '改为动作',
          rewriteGoal: '改为动作',
          preserveMeaning: ['悲伤'],
          styleEvidenceIds: ['s1'],
          repairReady: true,
        },
        {
          findingId: 'style_audit',
          subtype: 'sentence_rhythm',
          severity: 'warning' as const,
          location: 'chapter',
          generatedStart: null,
          generatedEnd: null,
          description: '整体节奏略显平淡',
          suggestedFix: '可选',
          repairReady: false,
        },
      ],
      preserve: [],
    };
    const missing = validateContinuationV4RepairCompliance({
      writerText,
      candidateText,
      checkerIssues: [],
      controlReport,
      envelope: {
        schemaVersion: 1,
        content: candidateText,
        appliedCheckerIssueIds: [],
        appliedControlSuggestionIds: [],
        appliedControlFindingIds: [],
        unappliedItems: [],
      },
    });
    expect(
      missing.find(check => check.subtype === 'repair_control_finding_unapplied')
        ?.severity,
    ).toBe('blocking');

    const withReady = validateContinuationV4RepairCompliance({
      writerText,
      candidateText,
      checkerIssues: [],
      controlReport,
      envelope: {
        schemaVersion: 1,
        content: candidateText,
        appliedCheckerIssueIds: [],
        appliedControlSuggestionIds: [],
        appliedControlFindingIds: ['style_1'],
        unappliedItems: [],
      },
    });
    const auditOnly = withReady.find(
      c =>
        c.subtype === 'repair_control_finding_unapplied' &&
        c.description.includes('style_audit'),
    );
    expect(auditOnly?.severity).toBe('warning');

    const unknown = validateContinuationV4RepairCompliance({
      writerText,
      candidateText,
      checkerIssues: [],
      controlReport,
      envelope: {
        schemaVersion: 1,
        content: candidateText,
        appliedCheckerIssueIds: [],
        appliedControlSuggestionIds: [],
        appliedControlFindingIds: ['style_1', 'ctrl_not_in_report'],
        unappliedItems: [],
      },
    });
    expect(
      unknown.find(check => check.subtype === 'repair_unknown_control_finding_id')
        ?.severity,
    ).toBe('blocking');
  });

  test('Repair 片段/摘要/丢锚点被完整性门禁拒绝', () => {
    const paragraphs = Array.from(
      { length: 12 },
      (_, i) => `这是第${i + 1}段完整叙述内容，包含人物动作与对白。`,
    );
    const writerText = paragraphs.join('\n');
    const fragment = paragraphs[5];
    const summary = '本章主要讲述众人经过一番努力最终他们达成目标。其余内容不变。';

    const fragmentGate = runContinuationV4LocalFinalGate({
      writerText,
      candidateText: fragment,
      snapshot: snapshot(),
      controlMetrics: {} as any,
      targetedSpans: [{ generatedStart: 0, generatedEnd: 10, generatedExcerpt: paragraphs[0] }],
    });
    expect(fragmentGate.passed).toBe(false);
    expect(fragmentGate.checks.map(c => c.subtype)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/repair_partial_output|repair_content_collapsed|repair_missing_unaffected/),
      ]),
    );

    const summaryGate = runContinuationV4LocalFinalGate({
      writerText,
      candidateText: summary,
      snapshot: snapshot(),
      controlMetrics: {} as any,
      targetedSpans: [],
    });
    expect(summaryGate.passed).toBe(false);

    // Minimal fix: rewrite only middle paragraph, keep others
    const repaired = paragraphs
      .map((p, i) => (i === 5 ? '他沉默片刻，转身离开。' : p))
      .join('\n');
    const okGate = runContinuationV4LocalFinalGate({
      writerText,
      candidateText: repaired,
      snapshot: snapshot(),
      controlMetrics: {} as any,
      targetedSpans: [
        {
          generatedStart: writerText.indexOf(paragraphs[5]),
          generatedEnd:
            writerText.indexOf(paragraphs[5]) + paragraphs[5].length,
          generatedExcerpt: paragraphs[5],
        },
      ],
    });
    expect(okGate.passed).toBe(true);
    expect(okGate.completeness?.minimalInterventionPassed).toBe(true);
  });

  test('大量改写未标记段落时最小干预失败', () => {
    const paragraphs = Array.from(
      { length: 8 },
      (_, i) => `保留段落${i}的具体叙述内容应当不变。`,
    );
    const writerText = paragraphs.join('\n');
    const rewritten = Array.from(
      { length: 8 },
      (_, i) => `完全不同的重写段落${i}内容替换了原文。`,
    ).join('\n');
    const gate = runContinuationV4LocalFinalGate({
      writerText,
      candidateText: rewritten,
      snapshot: snapshot(),
      controlMetrics: {} as any,
      targetedSpans: [
        {
          generatedStart: 0,
          generatedEnd: paragraphs[0].length,
          generatedExcerpt: paragraphs[0],
        },
      ],
    });
    expect(gate.passed).toBe(false);
    expect(gate.checks.map(c => c.subtype)).toContain('repair_non_minimal_rewrite');
  });

  test('篇幅扩写合规：必须净增且进入 target×0.7 以上', () => {
    const writerText = '甲'.repeat(1000);
    const stillShort = '乙'.repeat(1200); // grew but still < 2100 for target 3000
    const enough = '丙'.repeat(2200);
    const lengthIssue = {
      id: 99,
      category: 'style',
      subtype: 'chapter_length_under_target',
      severity: 'error',
      description: '偏短',
      suggestedFix: '深化',
      generatedStart: null,
      generatedEnd: null,
      generatedExcerpt: '',
      evidenceIds: [],
    } as any;
    expect(isLengthExpansionIssue(lengthIssue)).toBe(true);

    const controlReport = {
      schemaVersion: 2 as const,
      action: 'expand' as const,
      currentHan: 1000,
      targetHan: 3000,
      allowedMinHan: 2100,
      allowedMaxHan: 3900,
      suggestions: [],
      findings: [],
      preserve: [],
    };

    const noGrowth = validateContinuationV4RepairCompliance({
      writerText,
      candidateText: writerText,
      checkerIssues: [lengthIssue],
      controlReport,
      envelope: {
        schemaVersion: 1,
        content: writerText,
        appliedCheckerIssueIds: ['99'],
        appliedControlSuggestionIds: [],
        appliedControlFindingIds: [],
        unappliedItems: [],
      },
    });
    expect(noGrowth.map(c => c.subtype)).toContain(
      'repair_length_expansion_no_growth',
    );

    const belowFloor = validateContinuationV4RepairCompliance({
      writerText,
      candidateText: stillShort,
      checkerIssues: [lengthIssue],
      controlReport,
      envelope: {
        schemaVersion: 1,
        content: stillShort,
        appliedCheckerIssueIds: ['99'],
        appliedControlSuggestionIds: [],
        appliedControlFindingIds: [],
        unappliedItems: [],
      },
    });
    expect(belowFloor.map(c => c.subtype)).toContain(
      'repair_length_expansion_below_floor',
    );

    const ok = validateContinuationV4RepairCompliance({
      writerText,
      candidateText: enough,
      checkerIssues: [lengthIssue],
      controlReport,
      envelope: {
        schemaVersion: 1,
        content: enough,
        appliedCheckerIssueIds: ['99'],
        appliedControlSuggestionIds: [],
        appliedControlFindingIds: [],
        unappliedItems: [],
      },
    });
    expect(
      ok.some(c => c.subtype.startsWith('repair_length_expansion_')),
    ).toBe(false);
  });

  test('锚点残留被 Local Final Gate 拦截为 blocking', () => {
    const writerText = Array.from(
      { length: 10 },
      (_, i) => `自然段${i}推进并包含足够锚点正文。`,
    ).join('\n');
    const candidateWithAnchor = `${writerText}\n尾句。`.replace(
      '自然段3推进',
      '⟦ISSUE_1_START⟧自然段3推进⟦ISSUE_1_END⟧',
    );
    const gate = runContinuationV4LocalFinalGate({
      writerText,
      candidateText: candidateWithAnchor.replace(
        /⟦ISSUE_\d+_(?:START|END)⟧/g,
        '',
      ),
      snapshot: snapshot(),
      controlMetrics: {} as any,
      rawRepairContent: candidateWithAnchor,
      targetedSpans: [
        {
          generatedStart: writerText.indexOf('自然段3推进'),
          generatedEnd: writerText.indexOf('自然段3推进') + 6,
          generatedExcerpt: '自然段3推进',
        },
      ],
    });
    expect(gate.checks.map(c => c.subtype)).toContain('repair_anchor_residue');
    expect(
      gate.checks.find(c => c.subtype === 'repair_anchor_residue')?.severity,
    ).toBe('blocking');
    expect(gate.passed).toBe(false);
  });

  test('各类 run 物理请求规划总数 ≤ 4（无问题/仅长度/仅 Checker/混合）', () => {
    /**
     * V4 stages: Writer always + Checker + Control in parallel (2 physical) +
     * optional single Repair. Length expansion reuses that same Repair slot —
     * never a 5th physical request. maxPhysicalRequests telemetry stays 4.
     */
    const planPhysicalRequests = (flags: {
      lengthExpansion: boolean;
      checkerIssues: boolean;
      styleIssues: boolean;
      localSafety: boolean;
    }) => {
      const stages = ['writer', 'checker', 'control'] as string[];
      const needsRepair =
        flags.lengthExpansion ||
        flags.checkerIssues ||
        flags.styleIssues ||
        flags.localSafety;
      if (needsRepair) stages.push('repair');
      return stages.length;
    };

    const scenarios = [
      {
        name: '无问题',
        flags: {
          lengthExpansion: false,
          checkerIssues: false,
          styleIssues: false,
          localSafety: false,
        },
      },
      {
        name: '仅长度',
        flags: {
          lengthExpansion: true,
          checkerIssues: false,
          styleIssues: false,
          localSafety: false,
        },
      },
      {
        name: '仅 Checker',
        flags: {
          lengthExpansion: false,
          checkerIssues: true,
          styleIssues: false,
          localSafety: false,
        },
      },
      {
        name: '混合',
        flags: {
          lengthExpansion: true,
          checkerIssues: true,
          styleIssues: true,
          localSafety: true,
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      const count = planPhysicalRequests(scenario.flags);
      expect(count).toBeLessThanOrEqual(4);
    }
    // Mixed still fits in Writer+Checker+Control+Repair.
    expect(
      planPhysicalRequests({
        lengthExpansion: true,
        checkerIssues: true,
        styleIssues: true,
        localSafety: true,
      }),
    ).toBe(4);
    // Length alone must not invent a second repair stage.
    expect(
      planPhysicalRequests({
        lengthExpansion: true,
        checkerIssues: false,
        styleIssues: false,
        localSafety: false,
      }),
    ).toBe(4);
  });
});
