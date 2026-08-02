import {
  planStageCapacity,
} from '../src/services/continuation/generation/continuationContextBudget';
import {
  bindIssuesToArtifact,
  runDeterministicChecks,
} from '../src/services/continuation/generation/continuationChecker';

const mockState: {
  run: any;
  artifacts: any[];
  plans: any[];
  checks: any[];
} = { run: null, artifacts: [], plans: [], checks: [] };

const mockGetRunById = jest.fn(async (..._args: any[]) => mockState.run);
const mockCasUpdateRunState = jest.fn(async (_id: string, expected: string[], patch: any) => {
  if (!mockState.run || !expected.includes(mockState.run.state)) return false;
  if (patch.state) mockState.run.state = patch.state;
  if (patch.stage) mockState.run.stage = patch.stage;
  if (patch.tokenUsageJson) mockState.run.tokenUsageJson = patch.tokenUsageJson;
  if (patch.errorCode !== undefined) mockState.run.errorCode = patch.errorCode;
  if (patch.errorMessage !== undefined) mockState.run.errorMessage = patch.errorMessage;
  return true;
});
const mockGetLatestArtifact = jest.fn(async (..._args: any[]) =>
  mockState.artifacts.at(-1) ?? null,
);
const mockInsertArtifact = jest.fn(async (input: any) => {
  const artifact = {
    id: `artifact-${mockState.artifacts.length + 1}`,
    runId: input.runId,
    stage: input.stage,
    repairRound: input.repairRound ?? 0,
    parentArtifactId: input.parentArtifactId ?? null,
    content: input.content,
    contentHash: `hash-${mockState.artifacts.length + 1}`,
    createdAt: 'now',
  };
  mockState.artifacts.push(artifact);
  return artifact;
});
const mockSavePlan = jest.fn(async (_runId: string, plan: any, ..._args: any[]) => {
  mockState.plans.push(plan);
  return { planHash: 'plan-hash' };
});
const mockInsertCheckResults = jest.fn(async (rows: any[], ..._args: any[]) => {
  rows.forEach(row => {
    mockState.checks.push({
      ...row,
      id: mockState.checks.length + 1,
      resolutionStatus: 'open',
    });
  });
});
const mockListChecksForArtifact = jest.fn(async (_runId: string, artifactId: string, ..._args: any[]) =>
  mockState.checks.filter(row => row.artifactId === artifactId),
);
const mockMarkChecksAutoRepaired = jest.fn(async (_runId: string, artifactId: string, ..._args: any[]) => {
  mockState.checks
    .filter(row => row.artifactId === artifactId && row.resolutionStatus === 'open')
    .forEach(row => {
      row.resolutionStatus = 'auto_repaired';
    });
});

jest.mock('../src/services/continuation/generation/generationRepository', () => {
  const actual = jest.requireActual(
    '../src/services/continuation/generation/generationRepository',
  );
  return {
    ...actual,
    getRunById: (...args: any[]) => (mockGetRunById as any)(...args),
    casUpdateRunState: (...args: any[]) => (mockCasUpdateRunState as any)(...args),
    getLatestArtifact: (...args: any[]) => (mockGetLatestArtifact as any)(...args),
    insertArtifact: (...args: any[]) => (mockInsertArtifact as any)(...args),
    savePlan: (...args: any[]) => (mockSavePlan as any)(...args),
    insertCheckResults: (...args: any[]) => (mockInsertCheckResults as any)(...args),
    listChecksForArtifact: (...args: any[]) => (mockListChecksForArtifact as any)(...args),
    markChecksAutoRepaired: (...args: any[]) => (mockMarkChecksAutoRepaired as any)(...args),
  };
});

import {
  repairContinuationArtifactOnce,
  resumeInterruptedRun,
} from '../src/services/continuation/generation/continuationGenerationRunner';

function snapshot(workflowVersion?: 2): any {
  const settings = {
    strictnessProfile: 'balanced',
    worldRuleLevel: 'strict',
    characterLevel: 'strict',
    relationshipLevel: 'strict',
    plotLevel: 'balanced',
    experienceLevel: 'strict',
    knowledgeLevel: 'strict',
    styleLevel: 'strict',
    checkerEnabled: true,
    maxRepairRounds: 1,
    targetChapterChars: 100,
    resurrectionPolicy: 'forbid',
  };
  const capacity = (id: number) =>
    planStageCapacity({
      llmConfigId: id,
      contextWindow: 1_000_000,
      maxOutputTokens: 10_000,
    });
  return {
    schemaVersion: 2,
    ...(workflowVersion ? { workflowVersion } : {}),
    projectId: 1,
    targetChapterId: 10,
    targetPosition: 2,
    source: {
      sourceId: 1,
      sourceVersion: 1,
      normalizedSha256: 'source-hash',
      boundary: { chapterId: 1, chapterPosition: 1, charOffsetExclusive: 10 },
    },
    canon: {
      snapshotId: 'canon-1',
      revision: 1,
      boundaryGlobalCharOffset: 10,
      capabilities: {},
    },
    storyMemory: { stateFingerprint: 'memory', throughPosition: 1, status: 'ready' },
    inputRevisionHash: 'input',
    settingsSnapshot: {
      schemaVersion: 1,
      ...(workflowVersion ? { workflowVersion } : {}),
      values: settings,
      resolvedModelConfigIds: {
        planner: 11,
        writer: 22,
        checker: 33,
        repair: 44,
        stateExtraction: 55,
      },
    },
    stageBudgets: {
      planner: capacity(11),
      writer: capacity(22),
      checker: capacity(33),
      repair: capacity(44),
    },
    bundles: {
      lockedRules: [],
      canon: {
        worldRules: [],
        characters: [],
        characterStates: [],
        relationships: [],
        experiences: [],
        knowledge: [],
        plotThreads: [],
        timelineEvents: [],
        evidenceRefs: [42],
        evidenceRefsByOwner: {},
      },
      effectiveState: {
        characterStates: [],
        relationships: [],
        plotThreads: [],
        knowledge: [],
        experiences: [],
        freshness: {
          canonReady: true,
          storyMemoryStatus: 'ready',
          pendingStateExtractionCount: 0,
          pendingMajorProposalCount: 0,
          dirtyFromPosition: null,
        },
        appliedEventIds: [],
        omittedReasons: [],
      },
      seam: { summary: 'seam', excerpt: 'seam' },
      recentChapters: [],
      storyMemory: { summary: '', estimatedTokens: 0 },
      episodic: [],
      style: null,
      userInstruction: '推进冲突',
    },
    primaryAnchor: {
      kind: 'continuation_chapter',
      summary: 'previous continuation',
      excerpt: 'previous ending',
      chapterId: 9,
      position: 1,
    },
  };
}

function seedRun(options: { workflowVersion?: 2; stage?: string } = {}) {
  const snap = snapshot(options.workflowVersion);
  mockState.run = {
    id: 'ct_standard',
    workflowVersion: options.workflowVersion,
    projectId: 1,
    chapterId: 10,
    state: 'interrupted',
    stage: options.stage ?? 'writer',
    contextSnapshotJson: JSON.stringify(snap),
    tokenUsageJson: JSON.stringify({ workflowVersion: options.workflowVersion, stages: {} }),
  };
  mockState.artifacts = [];
  mockState.plans = [];
  mockState.checks = [];
}

const writerJson = (content: string) =>
  JSON.stringify({
    schemaVersion: 1,
    plan: {
      chapterGoal: '推进目标',
      centralConflict: '核心冲突',
      beats: [{ order: 1, summary: '升级' }, { order: 2, summary: '钩子' }],
      participatingCharacterIds: [12, 18],
      characterActions: [],
      plotAdvances: [],
      foreshadowingActions: [],
      proposedStateChanges: [],
      risks: [],
    },
    content,
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockState.run = null;
  mockState.artifacts = [];
  mockState.plans = [];
  mockState.checks = [];
});

describe('continuation standard three-call workflow', () => {
  it('calls Writer and Checker exactly once and stores plan separately from content', async () => {
    seedRun({ workflowVersion: 2 });
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') return { text: writerJson('纯正文') };
      return { text: JSON.stringify({ issues: [] }), usage: { prompt: 40, completion: 8 } };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual(['writer', 'checker']);
    expect(mockState.run.state).toBe('awaiting_user');
    expect(mockState.plans[0].chapterGoal).toBe('推进目标');
    expect(mockState.artifacts[0].content).toBe('纯正文');
    expect(mockState.artifacts[0].content).not.toContain('核心冲突');
  });

  it('calls Repair exactly once for a severe issue and never calls Checker again', async () => {
    seedRun({ workflowVersion: 2 });
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') return { text: writerJson('待修正文') };
      if (input.stage === 'checker') {
        return {
          text: JSON.stringify({
            issues: [{
              category: 'world',
              subtype: 'manual_block',
              severity: 'blocking',
              confidence: 1,
              generatedStart: 0,
              generatedEnd: 2,
              generatedExcerpt: '待修',
              description: '需要修复',
              evidenceIds: [42],
              suggestedFix: '改写命中片段',
            }],
          }),
        };
      }
      return { text: '修复后正文' };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual(['writer', 'checker', 'repair']);
    expect(calls.filter(call => call.stage === 'checker')).toHaveLength(1);
    expect(mockState.artifacts.map(artifact => artifact.stage)).toEqual(['writer', 'repair']);
    expect(mockState.artifacts.at(-1).content).toBe('修复后正文');
    expect(JSON.parse(mockState.run.tokenUsageJson).stages.localVerify.note).toContain(
      '未进行第二次 LLM 复检',
    );
  });

  it('uses the single Repair call for a local seam failure and verifies the rewritten final candidate locally', async () => {
    seedRun({ workflowVersion: 2 });
    const snap = JSON.parse(mockState.run.contextSnapshotJson);
    snap.primaryAnchor.excerpt = '最近续写接缝'.repeat(8);
    mockState.run.contextSnapshotJson = JSON.stringify(snap);
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') {
        return { text: writerJson(snap.primaryAnchor.excerpt + '继续正文') };
      }
      if (input.stage === 'checker') {
        return { text: JSON.stringify({ issues: [] }) };
      }
      return { text: '改写后的安全终稿，继续推进新的事件。' };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual(['writer', 'checker', 'repair']);
    expect(calls.filter(call => call.stage === 'checker')).toHaveLength(1);
    expect(mockState.artifacts.map(artifact => artifact.stage)).toEqual(['writer', 'repair']);
    expect(mockState.artifacts.at(-1).content).toContain('改写后的安全终稿');
    expect(mockState.checks.some(check => check.subtype === 'continuation_anchor_overlap')).toBe(true);
    expect(JSON.parse(mockState.run.tokenUsageJson).stages.localVerify.note).toContain(
      '未进行第二次 LLM 复检',
    );
  });

  it('allows one user-confirmed extra Repair after failed local verification without a second Checker', async () => {
    seedRun({ workflowVersion: 2 });
    const snap = JSON.parse(mockState.run.contextSnapshotJson);
    snap.primaryAnchor.excerpt = '接缝片段'.repeat(10);
    mockState.run.contextSnapshotJson = JSON.stringify(snap);
    let repairCalls = 0;
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') return { text: writerJson('新的正文') };
      if (input.stage === 'checker') return { text: JSON.stringify({ issues: [{
        category: 'world',
        subtype: 'manual_block',
        severity: 'blocking',
        confidence: 1,
        generatedStart: 0,
        generatedEnd: 2,
        generatedExcerpt: '新的',
        description: '需要修复',
        evidenceIds: [42],
        suggestedFix: '改写命中片段',
      }] }) };
      repairCalls += 1;
      return {
        text:
          repairCalls === 1
            ? `${snap.primaryAnchor.excerpt}修复候选`
            : '完全改写后的终稿'.repeat(10),
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);
    expect(mockState.artifacts.at(-1).stage).toBe('repair');
    expect(mockState.checks.some(c => c.subtype === 'continuation_anchor_overlap')).toBe(true);

    await repairContinuationArtifactOnce('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual([
      'writer',
      'checker',
      'repair',
      'repair',
    ]);
    expect(calls.filter(call => call.stage === 'checker')).toHaveLength(1);
    expect(mockState.artifacts.at(-1).content).toBe('完全改写后的终稿'.repeat(10));
    const usage = JSON.parse(mockState.run.tokenUsageJson).stages;
    expect(usage.repair.requestCount).toBe(2);
    expect(usage.repair.additionalRequestCount).toBe(1);
    expect(usage.localVerify.note).toContain('未进行第二次 LLM Checker');
  });

  it('does not retry Writer for reasoning-only output', async () => {
    seedRun({ workflowVersion: 2 });
    const callStage = jest.fn(async () => ({
      text: '',
      emptyReason: 'reasoning_only',
    }));

    await expect(resumeInterruptedRun('ct_standard', callStage as any)).rejects.toThrow(
      '仅返回推理内容',
    );
    expect(callStage).toHaveBeenCalledTimes(1);
    expect(mockState.run.state).toBe('failed');
    expect(mockState.artifacts).toHaveLength(0);
  });

  it('retains the Writer artifact when Repair fails and does not retry it on resume', async () => {
    seedRun({ workflowVersion: 2 });
    let repairAttempts = 0;
    const callStage = jest.fn(async (input: any) => {
      if (input.stage === 'writer') return { text: writerJson('原始正文') };
      if (input.stage === 'checker') {
        return {
          text: JSON.stringify({
            issues: [{
              category: 'world',
              subtype: 'manual_block',
              severity: 'blocking',
              confidence: 1,
              generatedStart: 0,
              generatedEnd: 2,
              generatedExcerpt: '原始',
              description: '必须修复',
              evidenceIds: [42],
              suggestedFix: '改写命中片段',
            }],
          }),
        };
      }
      repairAttempts += 1;
      throw new Error('Repair 网络错误');
    });

    await resumeInterruptedRun('ct_standard', callStage as any);
    expect(mockState.run.state).toBe('awaiting_user');
    expect(mockState.artifacts).toHaveLength(1);
    expect(mockState.artifacts[0].content).toBe('原始正文');

    mockState.run.state = 'interrupted';
    mockState.run.stage = 'repair';
    await resumeInterruptedRun('ct_standard', callStage as any);
    expect(repairAttempts).toBe(1);
    expect(mockState.artifacts).toHaveLength(1);
  });

  it('retains the full Writer artifact when Repair collapses it into a short summary', async () => {
    seedRun({ workflowVersion: 2 });
    const writerContent = '甲'.repeat(3000);
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') return { text: writerJson(writerContent) };
      if (input.stage === 'checker') {
        return {
          text: JSON.stringify({
            issues: [{
              category: 'plot',
              subtype: 'manual_block',
              severity: 'blocking',
              confidence: 1,
              generatedStart: 0,
              generatedEnd: 1,
              generatedExcerpt: '甲',
              description: '必须修复',
              evidenceIds: [42],
              suggestedFix: '改写命中片段',
            }],
          }),
        };
      }
      return { text: '修复后的摘要'.repeat(20) };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual(['writer', 'checker', 'repair']);
    expect(mockState.artifacts).toHaveLength(1);
    expect(mockState.artifacts[0].stage).toBe('writer');
    expect(mockState.artifacts[0].content).toHaveLength(3000);
    expect(JSON.parse(mockState.run.tokenUsageJson).stages.repair.warning).toBe(
      'repair_candidate_rejected_as_over_contracted',
    );
  });

  it('allows the user-confirmed extra Repair to use the retained Writer artifact', async () => {
    seedRun({ workflowVersion: 2 });
    let repairAttempts = 0;
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') return { text: writerJson('保留的 Writer 正文') };
      if (input.stage === 'checker') {
        return { text: JSON.stringify({ issues: [{
          category: 'world',
          subtype: 'manual_block',
          severity: 'blocking',
          confidence: 1,
          generatedStart: 0,
          generatedEnd: 2,
          generatedExcerpt: '保留',
          description: '必须修复',
          evidenceIds: [42],
          suggestedFix: '改写命中片段',
        }] }) };
      }
      repairAttempts += 1;
      if (repairAttempts === 1) throw new Error('Repair 网络错误');
      return { text: '额外修正后的终稿' };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);
    expect(mockState.artifacts).toHaveLength(1);
    expect(mockState.artifacts[0].stage).toBe('writer');
    expect(JSON.parse(mockState.run.tokenUsageJson).stages.repair.requestCount).toBe(1);

    await repairContinuationArtifactOnce('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual([
      'writer',
      'checker',
      'repair',
      'repair',
    ]);
    expect(calls.filter(call => call.stage === 'checker')).toHaveLength(1);
    expect(mockState.artifacts.at(-1).content).toBe('额外修正后的终稿');
  });

  it('keeps historical Planner confirmation/resume semantics when workflowVersion is absent', async () => {
    seedRun({ stage: 'planner' });
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'planner') {
        return {
          text: JSON.stringify({
            schemaVersion: 1,
            chapterGoal: 'legacy goal',
            centralConflict: 'legacy conflict',
            beats: [],
            participatingCharacterIds: [],
            characterActions: [],
            plotAdvances: [],
            foreshadowingActions: [],
            proposedStateChanges: [],
            risks: [],
          }),
        };
      }
      return { text: 'legacy正文' };
    });

    await resumeInterruptedRun('ct_standard', callStage as any, true);
    expect(calls.map(call => call.stage)).toEqual(['planner', 'writer']);
    expect(mockState.run.state).toBe('awaiting_user');
  });

  it('reports an out-of-range Han character count as a warning without blocking or retrying', () => {
    const issues = runDeterministicChecks('短正文', snapshot(2));
    const lengthIssue = issues.find(issue => issue.subtype === 'target_length');

    expect(lengthIssue?.severity).toBe('warning');
    expect(issues.some(issue => issue.subtype === 'target_length' && issue.severity !== 'warning')).toBe(false);
  });

  it('keeps local source and continuation overlap as a hard gate without Canon evidence', () => {
    const issue = {
      category: 'style' as const,
      subtype: 'continuation_anchor_overlap',
      severity: 'error' as const,
      confidence: 1,
      generatedStart: 0,
      generatedEnd: 8,
      generatedExcerpt: '接缝重合',
      description: 'local overlap',
      evidenceIds: [],
    };

    expect(bindIssuesToArtifact([issue], '接缝重合正文', new Set()).at(0)?.severity).toBe('error');
  });
});
