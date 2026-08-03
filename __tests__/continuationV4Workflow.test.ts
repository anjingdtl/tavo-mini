import {
  parseContinuationV4RepairEnvelope,
  parseContinuationV4WriterEnvelope,
  runContinuationV4LocalFinalGate,
  validateContinuationV4RepairCompliance,
} from '../src/services/continuation/generation';
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

  test('Local Final Gate uses the local Han count and rejects protocol leakage', () => {
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
    const lengthSnapshot = snapshot();
    lengthSnapshot.settingsSnapshot = {
      ...lengthSnapshot.settingsSnapshot,
      values: {
        ...lengthSnapshot.settingsSnapshot.values,
        targetChapterChars: 2000,
      },
    } as any;
    const lengthAdvisory = runContinuationV4LocalFinalGate({
      writerText: base,
      candidateText: Array.from(
        { length: 280 },
        (_, index) => `修订段${index}完成。`,
      ).join(''),
      snapshot: lengthSnapshot,
      controlMetrics: gate.candidateMetrics,
    });
    expect(
      lengthAdvisory.checks.find(
        check => check.subtype === 'chapter_length_under_target',
      )?.severity,
    ).toBe('warning');
    expect(lengthAdvisory.passed).toBe(true);
    expect(gate.checks.map(check => check.subtype)).toContain(
      'repair_candidate_unchanged',
    );

    const collapsedWriter = Array.from(
      { length: 900 },
      (_, index) => `原文段${index}推进。`,
    ).join('');
    const relativeCollapse = runContinuationV4LocalFinalGate({
      writerText: collapsedWriter,
      candidateText: Array.from(
        { length: 300 },
        (_, index) => `修订段${index}完成。`,
      ).join(''),
      snapshot: snapshot(),
      controlMetrics: gate.candidateMetrics,
    });
    expect(
      relativeCollapse.checks.find(
        check => check.subtype === 'repair_candidate_collapsed',
      )?.severity,
    ).toBe('warning');
    expect(relativeCollapse.passed).toBe(true);

    const absoluteCollapse = runContinuationV4LocalFinalGate({
      writerText: collapsedWriter,
      candidateText: Array.from(
        { length: 200 },
        (_, index) => `修订段${index}完成。`,
      ).join(''),
      snapshot: snapshot(),
      controlMetrics: gate.candidateMetrics,
    });
    expect(
      absoluteCollapse.checks.find(
        check => check.subtype === 'repair_candidate_collapsed',
      )?.severity,
    ).toBe('blocking');
    expect(absoluteCollapse.passed).toBe(false);

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

  test('Repair compliance requires actual Checker and Control progress', () => {
    const writerText = '问题原句需要被改写。'.repeat(20);
    const controlReport = {
      schemaVersion: 1 as const,
      action: 'expand' as const,
      currentHan: 200,
      targetHan: 600,
      allowedMinHan: 500,
      allowedMaxHan: 700,
      suggestions: [
        {
          suggestionId: 'ctrl_1',
          type: 'expand_scene',
          location: 'paragraph_1_after',
          expectedDeltaHan: 400,
          instruction: '补充行动阻力和因果推进',
          preserveBeatIds: ['beat_1'],
        },
      ],
      findings: [],
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
        appliedControlSuggestionIds: ['ctrl_1'],
        appliedControlFindingIds: [],
        unappliedItems: [],
      } satisfies ContinuationV4RepairEnvelope,
    });
    expect(failed.map(check => check.subtype)).toEqual(
      expect.arrayContaining([
        'repair_checker_issue_unchanged',
        'repair_control_insufficient_progress',
      ]),
    );
    expect(
      failed.find(
        check => check.subtype === 'repair_control_insufficient_progress',
      )?.severity,
    ).toBe('blocking');

    const passed = validateContinuationV4RepairCompliance({
      writerText,
      candidateText: `${'改写后的行动推进。'.repeat(45)}终稿`,
      checkerIssues,
      controlReport,
      envelope: {
        schemaVersion: 1,
        content: `${'改写后的行动推进。'.repeat(45)}终稿`,
        appliedCheckerIssueIds: ['chk_7'],
        appliedControlSuggestionIds: ['ctrl_1'],
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
      },
    ] as any;
    const checks = validateContinuationV4RepairCompliance({
      writerText: '原稿。',
      candidateText: '修订后的原稿。',
      checkerIssues,
      controlReport: {
        schemaVersion: 1,
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

  test('Repair 只增加 1 个汉字时 Control 进度不足被判定为 blocking', () => {
    const writerText = '这是完整正文。'.repeat(200); // ~1200 han
    // 候选只比 Writer 多 1 个汉字
    const candidateText = `${writerText}啊`;
    const controlReport = {
      schemaVersion: 1 as const,
      action: 'expand' as const,
      currentHan: 1200,
      targetHan: 1800,
      allowedMinHan: 1600,
      allowedMaxHan: 2000,
      suggestions: [
        {
          suggestionId: 'ctrl_local_expand',
          type: 'expand_scene',
          location: 'paragraph_1_after',
          expectedDeltaHan: 600,
          instruction: '扩写',
          preserveBeatIds: [],
        },
      ],
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
        appliedControlSuggestionIds: ['ctrl_local_expand'],
        appliedControlFindingIds: [],
        unappliedItems: [],
      } satisfies ContinuationV4RepairEnvelope,
    });
    expect(checks.map(check => check.subtype)).toContain(
      'repair_control_insufficient_progress',
    );
    expect(
      checks.find(
        check => check.subtype === 'repair_control_insufficient_progress',
      )?.severity,
    ).toBe('blocking');
  });

  test('达到最低实质进度但仍低于 allowedMinHan 时 Control 合规通过，Final Gate 仅长度 warning', () => {
    // Writer 约 1100，Control allowedMin 1600，候选约 1300：
    // 仍低于 Control 下限，但超过绝对 1000 字坍缩线，并且增量达到建议进度。
    const writerText = Array.from(
      { length: 220 },
      (_, index) => `原文段${index}推进。`,
    ).join('');
    const candidateText = Array.from(
      { length: 40 },
      (_, index) => `新增段${index}发展。`,
    ).join('');
    const controlReport = {
      schemaVersion: 1 as const,
      action: 'expand' as const,
      currentHan: 1100,
      targetHan: 1900,
      allowedMinHan: 1600,
      allowedMaxHan: 2100,
      suggestions: [
        {
          suggestionId: 'ctrl_local_expand',
          type: 'expand_scene',
          location: 'paragraph_1_after',
          expectedDeltaHan: 800,
          instruction: '扩写',
          preserveBeatIds: [],
        },
      ],
      findings: [],
      preserve: [],
    };
    const complianceChecks = validateContinuationV4RepairCompliance({
      writerText,
      candidateText: `${writerText}${candidateText}`,
      checkerIssues: [],
      controlReport,
      envelope: {
        schemaVersion: 1,
        content: `${writerText}${candidateText}`,
        appliedCheckerIssueIds: [],
        appliedControlSuggestionIds: ['ctrl_local_expand'],
        appliedControlFindingIds: [],
        unappliedItems: [],
      } satisfies ContinuationV4RepairEnvelope,
    });
    // Control 合规通过：没有 insufficient_progress
    expect(complianceChecks.map(check => check.subtype)).not.toContain(
      'repair_control_insufficient_progress',
    );

    // Local Final Gate：chapter_length 仍只是 warning，不阻断
    const gateSnapshot = snapshot();
    gateSnapshot.settingsSnapshot = {
      ...gateSnapshot.settingsSnapshot,
      values: {
        ...gateSnapshot.settingsSnapshot.values,
        targetChapterChars: 1900,
      },
    } as any;
    const gate = runContinuationV4LocalFinalGate({
      writerText,
      candidateText: `${writerText}${candidateText}`,
      snapshot: gateSnapshot,
      controlMetrics: controlReport as any,
    });
    const lengthCheck = gate.checks.find(check =>
      check.subtype.startsWith('chapter_length_'),
    );
    // 章节篇幅若有，必须是 warning 不是 error/blocking
    if (lengthCheck) {
      expect(lengthCheck.severity).toBe('warning');
    }
    // 软门禁：长度不阻断 gate（其他本地安全问题除外，此处不应有）
    expect(gate.passed).toBe(true);
  });

  test('Repair 未回填本地 Control suggestion ID 但进度达标时仅产生 warning', () => {
    // Writer 约 600 汉字，allowedMin 800，requiredDelta 300，requiredProgress 105。
    // 候选追加约 120 汉字 → actualProgress 120 ≥ 105，Control 实质进度通过；
    // 唯一未满足的是本地强制 suggestion ID 未回填，按当前契约只产生 warning，
    // 不构成 error/blocking，候选在合规层面不被这一条拒绝。
    const writerText = '这是完整正文。'.repeat(100);
    const candidateText = `${writerText}${'扩展内容。'.repeat(30)}`;
    const controlReport = {
      schemaVersion: 1 as const,
      action: 'expand' as const,
      currentHan: 600,
      targetHan: 900,
      allowedMinHan: 800,
      allowedMaxHan: 1000,
      suggestions: [
        {
          suggestionId: 'ctrl_local_expand',
          type: 'expand_scene',
          location: 'paragraph_1_after',
          expectedDeltaHan: 200,
          instruction: '扩写',
          preserveBeatIds: [],
        },
      ],
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
        // 缺少 ctrl_local_expand
        appliedControlSuggestionIds: [],
        appliedControlFindingIds: [],
        unappliedItems: [],
      } satisfies ContinuationV4RepairEnvelope,
    });
    expect(checks.map(check => check.subtype)).toContain(
      'repair_control_suggestion_unapplied',
    );
    expect(
      checks.find(
        check => check.subtype === 'repair_control_suggestion_unapplied',
      )?.severity,
    ).toBe('warning');
    // 进度达标：不应再产生 insufficient_progress
    expect(checks.map(check => check.subtype)).not.toContain(
      'repair_control_insufficient_progress',
    );
    // 合规层面无 error/blocking → 候选不会被这条规则拒绝
    expect(
      checks.filter(
        check => check.severity === 'error' || check.severity === 'blocking',
      ),
    ).toEqual([]);
  });

  test('Control finding 未回填只产生 warning，未知 finding ID 仍属于协议错误', () => {
    const writerText = '这是完整正文。'.repeat(300);
    const candidateText = `${writerText}新增推进。`;
    const controlReport = {
      schemaVersion: 1 as const,
      action: 'keep' as const,
      currentHan: 2400,
      targetHan: 2400,
      allowedMinHan: 2000,
      allowedMaxHan: 2800,
      suggestions: [],
      findings: [
        {
          findingId: 'ctrl_local_ending_hook',
          subtype: 'ending_hook',
          severity: 'warning' as const,
          location: 'chapter_end',
          generatedStart: null,
          generatedEnd: null,
          description: '章末推进不足。',
          suggestedFix: '补足新的行动后果和章末钩子。',
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
    ).toBe('warning');

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
        appliedControlFindingIds: ['ctrl_not_in_report'],
        unappliedItems: [],
      },
    });
    expect(
      unknown.find(check => check.subtype === 'repair_unknown_control_finding_id')
        ?.severity,
    ).toBe('blocking');
  });
});
