import { planStageCapacity } from '../src/services/continuation/generation/continuationContextBudget';
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
const mockCasUpdateRunState = jest.fn(
  async (_id: string, expected: string[], patch: any) => {
    if (!mockState.run || !expected.includes(mockState.run.state)) return false;
    if (patch.state) mockState.run.state = patch.state;
    if (patch.stage) mockState.run.stage = patch.stage;
    if (patch.tokenUsageJson)
      mockState.run.tokenUsageJson = patch.tokenUsageJson;
    if (patch.errorCode !== undefined)
      mockState.run.errorCode = patch.errorCode;
    if (patch.errorMessage !== undefined)
      mockState.run.errorMessage = patch.errorMessage;
    return true;
  },
);
const mockGetLatestArtifact = jest.fn(
  async (..._args: any[]) => mockState.artifacts.at(-1) ?? null,
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
const mockSavePlan = jest.fn(
  async (_runId: string, plan: any, ..._args: any[]) => {
    mockState.plans.push(plan);
    return { planHash: 'plan-hash' };
  },
);
const mockInsertCheckResults = jest.fn(async (rows: any[], ..._args: any[]) => {
  rows.forEach(row => {
    mockState.checks.push({
      ...row,
      id: mockState.checks.length + 1,
      resolutionStatus: 'open',
    });
  });
});
const mockListChecksForArtifact = jest.fn(
  async (_runId: string, artifactId: string, ..._args: any[]) =>
    mockState.checks.filter(row => row.artifactId === artifactId),
);
const mockMarkChecksAutoRepaired = jest.fn(
  async (_runId: string, artifactId: string, checkIds: number[] = []) => {
    mockState.checks
      .filter(
        row =>
          row.artifactId === artifactId &&
          row.resolutionStatus === 'open' &&
          checkIds.includes(row.id),
      )
      .forEach(row => {
        row.resolutionStatus = 'auto_repaired';
      });
  },
);

jest.mock(
  '../src/services/continuation/generation/generationRepository',
  () => {
    const actual = jest.requireActual(
      '../src/services/continuation/generation/generationRepository',
    );
    return {
      ...actual,
      getRunById: (...args: any[]) => (mockGetRunById as any)(...args),
      casUpdateRunState: (...args: any[]) =>
        (mockCasUpdateRunState as any)(...args),
      getLatestArtifact: (...args: any[]) =>
        (mockGetLatestArtifact as any)(...args),
      insertArtifact: (...args: any[]) => (mockInsertArtifact as any)(...args),
      savePlan: (...args: any[]) => (mockSavePlan as any)(...args),
      insertCheckResults: (...args: any[]) =>
        (mockInsertCheckResults as any)(...args),
      listChecksForArtifact: (...args: any[]) =>
        (mockListChecksForArtifact as any)(...args),
      markChecksAutoRepaired: (...args: any[]) =>
        (mockMarkChecksAutoRepaired as any)(...args),
    };
  },
);

import {
  applyRepairPatches,
  repairContinuationArtifactOnce,
  resumeInterruptedRun,
  isWriterTransientRequestError,
} from '../src/services/continuation/generation/legacy/continuationGenerationRunner';

function snapshot(workflowVersion?: 2, targetChapterChars = 100): any {
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
    targetChapterChars,
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
    storyMemory: {
      stateFingerprint: 'memory',
      throughPosition: 1,
      status: 'ready',
    },
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

function seedRun(
  options: {
    workflowVersion?: 2;
    stage?: string;
    targetChapterChars?: number;
  } = {},
) {
  const snap = snapshot(options.workflowVersion, options.targetChapterChars);
  mockState.run = {
    id: 'ct_standard',
    workflowVersion: options.workflowVersion,
    projectId: 1,
    chapterId: 10,
    state: 'interrupted',
    stage: options.stage ?? 'writer',
    contextSnapshotJson: JSON.stringify(snap),
    tokenUsageJson: JSON.stringify({
      workflowVersion: options.workflowVersion,
      stages: {},
    }),
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
      beats: [
        { order: 1, summary: '升级' },
        { order: 2, summary: '钩子' },
      ],
      participatingCharacterIds: [12, 18],
      characterActions: [],
      plotAdvances: [],
      foreshadowingActions: [],
      proposedStateChanges: [],
      risks: [],
    },
    content,
  });

/**
 * Default seedRun target is 100 Han (legacy fixed ±500 → 1–600). Pad short fixtures so
 * non-length tests do not accidentally open a chapter_length Repair path.
 */
function inDefaultLengthBand(label: string): string {
  const pad = Math.max(0, 80 - label.length);
  return '甲'.repeat(pad) + label;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.run = null;
  mockState.artifacts = [];
  mockState.plans = [];
  mockState.checks = [];
});

describe('continuation standard three-call workflow', () => {
  it('retries Writer once for a transient network failure and records the retry separately', async () => {
    seedRun({ workflowVersion: 2 });
    let writerAttempts = 0;
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') {
        writerAttempts += 1;
        if (writerAttempts === 1) {
          throw Object.assign(new Error('network temporarily unavailable'), {
            code: 'network_error',
          });
        }
        return { text: writerJson(inDefaultLengthBand('重试后正文')) };
      }
      return { text: JSON.stringify({ issues: [] }) };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual([
      'writer',
      'writer',
      'checker',
    ]);
    const usage = JSON.parse(mockState.run.tokenUsageJson).stages;
    expect(usage.writer.requestCount).toBe(2);
    expect(usage.writer.retryCount).toBe(1);
    expect(usage.writer.retryReason).toBe('transient_network_or_server_busy');
    expect(mockState.run.state).toBe('awaiting_user');
  });

  it('does not count the transient Writer retry toward the three logical stages', async () => {
    seedRun({ workflowVersion: 2 });
    let writerAttempts = 0;
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') {
        writerAttempts += 1;
        if (writerAttempts === 1) {
          throw Object.assign(new Error('rate limited'), {
            status: 429,
            code: 'rate_limit_exceeded',
          });
        }
        return {
          text: writerJson(inDefaultLengthBand('重试后的原始正文')),
        };
      }
      if (input.stage === 'checker') {
        const body = inDefaultLengthBand('重试后的原始正文');
        const idx = body.indexOf('重试');
        return {
          text: JSON.stringify({
            issues: [
              {
                category: 'world',
                subtype: 'manual_block',
                severity: 'blocking',
                confidence: 1,
                generatedStart: idx,
                generatedEnd: idx + 2,
                generatedExcerpt: '重试',
                description: '必须修复',
                evidenceIds: [42],
                suggestedFix: '改写命中片段',
              },
            ],
          }),
        };
      }
      const body = inDefaultLengthBand('重试后的原始正文');
      const idx = body.indexOf('重试');
      return {
        text: JSON.stringify({
          patches: [{ start: idx, end: idx + 2, replacement: '修正' }],
        }),
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual([
      'writer',
      'writer',
      'checker',
      'repair',
    ]);
    const usage = JSON.parse(mockState.run.tokenUsageJson).stages;
    expect(usage.writer.requestCount).toBe(2);
    expect(usage.writer.retryCount).toBe(1);
    expect(usage.repair.requestCount).toBe(1);
    expect(mockState.artifacts.at(-1).stage).toBe('repair');
  });

  it('retries only network or busy-server errors, not configuration errors', async () => {
    expect(
      isWriterTransientRequestError(
        Object.assign(new Error('too many requests'), { status: 429 }),
      ),
    ).toBe(true);
    expect(
      isWriterTransientRequestError(
        Object.assign(new Error('invalid api key'), {
          status: 401,
          code: 'invalid_api_key',
        }),
      ),
    ).toBe(false);

    seedRun({ workflowVersion: 2 });
    const callStage = jest.fn(async () => {
      throw Object.assign(new Error('invalid api key'), {
        status: 401,
        code: 'invalid_api_key',
      });
    });

    await expect(
      resumeInterruptedRun('ct_standard', callStage as any),
    ).rejects.toThrow('invalid api key');
    expect(callStage).toHaveBeenCalledTimes(1);
  });

  it('recognizes provider total_timeout as the one allowed Writer transport retry', () => {
    expect(
      isWriterTransientRequestError({
        code: 'total_timeout',
        message: '请求超时，请检查网络或模型服务。',
      }),
    ).toBe(true);
  });

  it('calls Writer and Checker exactly once and stores plan separately from content', async () => {
    seedRun({ workflowVersion: 2 });
    const body = inDefaultLengthBand('纯正文');
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') return { text: writerJson(body) };
      return {
        text: JSON.stringify({ issues: [] }),
        usage: { prompt: 40, completion: 8 },
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual(['writer', 'checker']);
    expect(mockState.run.state).toBe('awaiting_user');
    expect(mockState.plans[0].chapterGoal).toBe('推进目标');
    expect(mockState.artifacts[0].content).toBe(body);
    expect(mockState.artifacts[0].content).toContain('纯正文');
    expect(mockState.artifacts[0].content).not.toContain('核心冲突');
  });

  it('calls Repair exactly once for a severe issue and never calls Checker again', async () => {
    seedRun({ workflowVersion: 2 });
    const body = inDefaultLengthBand('待修正文');
    const hit = body.indexOf('待修');
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') return { text: writerJson(body) };
      if (input.stage === 'checker') {
        return {
          text: JSON.stringify({
            issues: [
              {
                category: 'world',
                subtype: 'manual_block',
                severity: 'blocking',
                confidence: 1,
                generatedStart: hit,
                generatedEnd: hit + 2,
                generatedExcerpt: '待修',
                description: '需要修复',
                evidenceIds: [42],
                suggestedFix: '改写命中片段',
              },
            ],
          }),
        };
      }
      return {
        text: JSON.stringify({
          patches: [
            {
              start: hit,
              end: hit + 4,
              replacement: '修复后正文',
            },
          ],
        }),
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual([
      'writer',
      'checker',
      'repair',
    ]);
    expect(calls.filter(call => call.stage === 'checker')).toHaveLength(1);
    expect(mockState.artifacts.map(artifact => artifact.stage)).toEqual([
      'writer',
      'repair',
    ]);
    expect(mockState.artifacts.at(-1).content).toContain('修复后正文');
    expect(
      JSON.parse(mockState.run.tokenUsageJson).stages.localVerify.note,
    ).toContain('未进行第二次 LLM 复检');
  });

  it('runs LLM Repair after deterministic future-leakage repair and merges length plus semantic issues', async () => {
    seedRun({ workflowVersion: 2, targetChapterChars: 3000 });
    const writerContent =
      '甲'.repeat(1000) + '【未来揭示】' + '知道了秘密' + '乙'.repeat(1000);
    const deterministicContent = writerContent.replace(
      '【未来揭示】',
      '（已删除不当揭示）',
    );
    const knowledgeOffset = writerContent.indexOf('知道了秘密');
    const repairOffset = deterministicContent.indexOf('知道了秘密');
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') return { text: writerJson(writerContent) };
      if (input.stage === 'checker') {
        return {
          text: JSON.stringify({
            issues: [
              {
                category: 'knowledge',
                subtype: 'knowledge_violation',
                severity: 'blocking',
                confidence: 1,
                generatedStart: knowledgeOffset,
                generatedEnd: knowledgeOffset + '知道了秘密'.length,
                generatedExcerpt: '知道了秘密',
                description: '人物越过知识边界',
                evidenceIds: [42],
                suggestedFix: '改为误解或未知状态',
              },
            ],
          }),
        };
      }
      return {
        text: JSON.stringify({
          patches: [
            {
              start: repairOffset,
              end: repairOffset + '知道了秘密'.length,
              replacement: '他暂时没有真正弄清这件事',
            },
          ],
        }),
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual([
      'writer',
      'checker',
      'repair',
    ]);
    expect(calls.filter(call => call.stage === 'checker')).toHaveLength(1);
    const repairPrompt = calls
      .at(-1)
      .messages.map((message: any) => message.content)
      .join('\n');
    expect(repairPrompt).toContain('chapter_length_under_target');
    expect(repairPrompt).toContain('knowledge_violation');
    expect(repairPrompt).not.toContain('【未来揭示】');
    expect(mockState.artifacts.at(-1).content).not.toContain('【未来揭示】');
    expect(mockState.artifacts.at(-1).content).toContain(
      '他暂时没有真正弄清这件事',
    );
    const finalChecks = mockState.checks.filter(
      check => check.artifactId === mockState.artifacts.at(-1).id,
    );
    expect(
      finalChecks.some(
        check =>
          check.subtype === 'chapter_length_under_target' &&
          check.resolutionStatus === 'open',
      ),
    ).toBe(true);
  });

  it('marks only the deterministic issue when deterministic repair leaves semantic and length issues open', async () => {
    seedRun({ workflowVersion: 2, targetChapterChars: 3000 });
    const writerContent =
      '甲'.repeat(1000) + '【未来揭示】' + '乙'.repeat(1000);
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') return { text: writerJson(writerContent) };
      if (input.stage === 'checker') {
        return {
          text: JSON.stringify({
            issues: [
              {
                category: 'world',
                subtype: 'world_conflict',
                severity: 'blocking',
                confidence: 1,
                generatedStart: 100,
                generatedEnd: 102,
                generatedExcerpt: '甲甲',
                description: '世界规则冲突',
                evidenceIds: [42],
                suggestedFix: '改写命中片段',
              },
            ],
          }),
        };
      }
      return {
        text: JSON.stringify({
          patches: [{ start: 0, end: 2, replacement: '改写' }],
        }),
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual([
      'writer',
      'checker',
      'repair',
    ]);
    const writerChecks = mockState.checks.filter(
      check => check.artifactId === mockState.artifacts[0].id,
    );
    expect(
      writerChecks.find(check => check.subtype === 'future_leakage')
        ?.resolutionStatus,
    ).toBe('auto_repaired');
    expect(
      writerChecks.find(check => check.subtype === 'world_conflict')
        ?.resolutionStatus,
    ).toBe('open');
    const finalChecks = mockState.checks.filter(
      check => check.artifactId === mockState.artifacts.at(-1).id,
    );
    expect(
      finalChecks.find(check => check.subtype === 'chapter_length_under_target')
        ?.resolutionStatus,
    ).toBe('open');
  });

  it('keeps an uncovered severe issue open when a valid patch covers only another issue', async () => {
    seedRun({ workflowVersion: 2, targetChapterChars: 3000 });
    const writerContent = '甲'.repeat(3000);
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') return { text: writerJson(writerContent) };
      if (input.stage === 'checker') {
        return {
          text: JSON.stringify({
            issues: [
              {
                category: 'world',
                subtype: 'first_conflict',
                severity: 'blocking',
                confidence: 1,
                generatedStart: 0,
                generatedEnd: 2,
                generatedExcerpt: '甲甲',
                description: '第一项冲突',
                evidenceIds: [42],
                suggestedFix: '改写第一项',
              },
              {
                category: 'knowledge',
                subtype: 'second_conflict',
                severity: 'blocking',
                confidence: 1,
                generatedStart: 10,
                generatedEnd: 12,
                generatedExcerpt: '甲甲',
                description: '第二项冲突',
                evidenceIds: [42],
                suggestedFix: '改写第二项',
              },
            ],
          }),
        };
      }
      return {
        text: JSON.stringify({
          patches: [{ start: 0, end: 2, replacement: '改写' }],
        }),
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    const writerChecks = mockState.checks.filter(
      check => check.artifactId === mockState.artifacts[0].id,
    );
    expect(
      writerChecks.find(check => check.subtype === 'first_conflict')
        ?.resolutionStatus,
    ).toBe('auto_repaired');
    expect(
      writerChecks.find(check => check.subtype === 'second_conflict')
        ?.resolutionStatus,
    ).toBe('open');
    const finalChecks = mockState.checks.filter(
      check => check.artifactId === mockState.artifacts.at(-1).id,
    );
    expect(finalChecks.some(check => check.subtype === 'second_conflict')).toBe(
      true,
    );
    expect(calls.map(call => call.stage)).toEqual([
      'writer',
      'checker',
      'repair',
    ]);
  });

  it('rejects a legal but unrelated Repair patch and retains the safe artifact', async () => {
    seedRun({ workflowVersion: 2, targetChapterChars: 3000 });
    const writerContent = '甲'.repeat(3000);
    const callStage = jest.fn(async (input: any) => {
      if (input.stage === 'writer') return { text: writerJson(writerContent) };
      if (input.stage === 'checker') {
        return {
          text: JSON.stringify({
            issues: [
              {
                category: 'plot',
                subtype: 'unrelated_target',
                severity: 'blocking',
                confidence: 1,
                generatedStart: 0,
                generatedEnd: 2,
                generatedExcerpt: '甲甲',
                description: '必须修复',
                evidenceIds: [42],
                suggestedFix: '改写命中片段',
              },
            ],
          }),
        };
      }
      return {
        text: JSON.stringify({
          patches: [{ start: 100, end: 102, replacement: '乙乙' }],
        }),
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    expect(mockState.artifacts).toHaveLength(1);
    expect(mockState.artifacts[0].content).toBe(writerContent);
    expect(JSON.parse(mockState.run.tokenUsageJson).stages.repair.warning).toBe(
      'repair_patch_coverage_failed_writer_artifact_retained',
    );
    expect(mockState.checks[0].resolutionStatus).toBe('open');
  });

  it('closes a chapter length issue only when the patched candidate enters the band', async () => {
    seedRun({ workflowVersion: 2, targetChapterChars: 3000 });
    const writerContent = '甲'.repeat(2000) + '\n\n乙';
    const callStage = jest.fn(async (input: any) => {
      if (input.stage === 'writer') return { text: writerJson(writerContent) };
      if (input.stage === 'checker') {
        return { text: JSON.stringify({ issues: [] }) };
      }
      return {
        text: JSON.stringify({
          patches: [
            {
              start: writerContent.length,
              end: writerContent.length,
              replacement: '丙'.repeat(600),
            },
          ],
        }),
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    expect(mockState.artifacts).toHaveLength(2);
    expect(
      mockState.checks.find(
        check =>
          check.artifactId === mockState.artifacts[0].id &&
          check.subtype === 'chapter_length_under_target',
      )?.resolutionStatus,
    ).toBe('auto_repaired');
    expect(
      mockState.checks.some(
        check =>
          check.artifactId === mockState.artifacts.at(-1).id &&
          check.subtype === 'chapter_length_under_target',
      ),
    ).toBe(false);
  });

  // Legacy target 3000 → fixed ±500 band 2500–3500. Cases use lengths relative to that band.
  it.each([
    // Both under: partial progress saved, issue stays open.
    ['1500 to 1800 keeps under-target open', 1500, 1800, true, false],
    // Both over but closer: partial compress saved, over-target stays open.
    ['4500 to 4200 keeps over-target open', 4500, 4200, true, false],
    ['1500 to 1500 rejects unchanged length', 1500, 1500, false, false],
    ['1500 to 1200 rejects farther under-target length', 1500, 1200, false, false],
    ['1500 to 2600 closes the under-target issue', 1500, 2600, true, true],
  ])(
    '%s',
    async (
      _name: string,
      writerLength: number,
      candidateLength: number,
      savesRepair: boolean,
      closesLength: boolean,
    ) => {
      seedRun({ workflowVersion: 2, targetChapterChars: 3000 });
      const writerContent = '甲'.repeat(writerLength);
      const delta = candidateLength - writerLength;
      const patch =
        delta > 0
          ? {
              start: writerContent.length,
              end: writerContent.length,
              replacement: '乙'.repeat(delta),
            }
          : delta === 0
          ? { start: 0, end: 1, replacement: '乙' }
          : {
              start: 0,
              end: Math.abs(delta) + 1,
              replacement: '乙',
            };
      const calls: any[] = [];
      const callStage = jest.fn(async (input: any) => {
        calls.push(input);
        if (input.stage === 'writer') return { text: writerJson(writerContent) };
        if (input.stage === 'checker') {
          return { text: JSON.stringify({ issues: [] }) };
        }
        return { text: JSON.stringify({ patches: [patch] }) };
      });

      await resumeInterruptedRun('ct_standard', callStage as any);

      expect(calls.filter(call => call.stage === 'checker')).toHaveLength(1);
      expect(calls.map(call => call.stage)).toEqual([
        'writer',
        'checker',
        'repair',
      ]);
      expect(mockState.run.state).toBe('awaiting_user');
      expect(mockState.artifacts).toHaveLength(savesRepair ? 2 : 1);

      const writerLengthCheck = mockState.checks.find(
        check =>
          check.artifactId === mockState.artifacts[0].id &&
          check.subtype.startsWith('chapter_length_'),
      );
      expect(writerLengthCheck?.resolutionStatus).toBe(
        closesLength ? 'auto_repaired' : 'open',
      );

      if (savesRepair) {
        const finalArtifact = mockState.artifacts.at(-1);
        expect(finalArtifact.stage).toBe('repair');
        const finalLengthCheck = mockState.checks.find(
          check =>
            check.artifactId === finalArtifact.id &&
            check.subtype.startsWith('chapter_length_'),
        );
        expect(finalLengthCheck?.resolutionStatus).toBe(
          closesLength ? undefined : 'open',
        );
      }
    },
  );

  it('allows one extra Repair for a safe partial length improvement and never calls Checker or Repair a third time', async () => {
    seedRun({ workflowVersion: 2, targetChapterChars: 3000 });
    // Start below the legacy 2500 floor; first partial repair stays under, second enters band.
    const writerContent = '甲'.repeat(1500);
    const calls: any[] = [];
    let repairCalls = 0;
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') return { text: writerJson(writerContent) };
      if (input.stage === 'checker') {
        return { text: JSON.stringify({ issues: [] }) };
      }
      repairCalls += 1;
      const currentContent = mockState.artifacts.at(-1)?.content ?? writerContent;
      const expansion = repairCalls === 1 ? 800 : 300;
      return {
        text: JSON.stringify({
          patches: [
            {
              start: currentContent.length,
              end: currentContent.length,
              replacement: '乙'.repeat(expansion),
            },
          ],
        }),
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);
    expect(mockState.artifacts).toHaveLength(2);
    expect(
      mockState.checks.find(
        check =>
          check.artifactId === mockState.artifacts.at(-1).id &&
          check.subtype === 'chapter_length_under_target',
      )?.resolutionStatus,
    ).toBe('open');

    await repairContinuationArtifactOnce('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual([
      'writer',
      'checker',
      'repair',
      'repair',
    ]);
    expect(calls.filter(call => call.stage === 'checker')).toHaveLength(1);
    expect(repairCalls).toBe(2);
    expect(mockState.artifacts).toHaveLength(3);
    expect(
      mockState.checks.find(
        check =>
          check.artifactId === mockState.artifacts[1].id &&
          check.subtype === 'chapter_length_under_target',
      )?.resolutionStatus,
    ).toBe('auto_repaired');
    expect(
      mockState.checks.some(
        check =>
          check.artifactId === mockState.artifacts.at(-1).id &&
          check.subtype.startsWith('chapter_length_'),
      ),
    ).toBe(false);

    await expect(
      repairContinuationArtifactOnce('ct_standard', callStage as any),
    ).rejects.toThrow();
    expect(repairCalls).toBe(2);
    expect(calls.filter(call => call.stage === 'checker')).toHaveLength(1);
  });

  it('applies a bounded Repair patch to the complete Writer artifact instead of accepting a short patch as the chapter', async () => {
    seedRun({ workflowVersion: 2, targetChapterChars: 3000 });
    const writerContent = '甲'.repeat(3000);
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') return { text: writerJson(writerContent) };
      if (input.stage === 'checker') {
        return {
          text: JSON.stringify({
            issues: [
              {
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
              },
            ],
          }),
        };
      }
      return {
        text: JSON.stringify({
          patches: [{ start: 0, end: 1, replacement: '乙' }],
        }),
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual([
      'writer',
      'checker',
      'repair',
    ]);
    expect(calls.at(-1).responseFormat).toBe('json_object');
    expect(mockState.artifacts.map(artifact => artifact.stage)).toEqual([
      'writer',
      'repair',
    ]);
    expect(mockState.artifacts.at(-1).content).toHaveLength(3000);
    expect(mockState.artifacts.at(-1).content.startsWith('乙')).toBe(true);
    expect(
      JSON.parse(mockState.run.tokenUsageJson).stages.localVerify.note,
    ).toContain('未进行第二次 LLM 复检');
  });

  it('rebinds a shifted duplicate excerpt to the nearest unique occurrence', async () => {
    seedRun({ workflowVersion: 2, targetChapterChars: 3000 });
    const excerpt = '重复片段';
    const futureMarker = '【未来揭示】';
    const writerContent =
      '甲'.repeat(500) +
      excerpt +
      '乙'.repeat(500) +
      futureMarker +
      excerpt +
      '丙'.repeat(1980);
    const originalSecondStart = writerContent.lastIndexOf(excerpt);
    const deterministicCandidate = writerContent.replace(
      futureMarker,
      '（已删除不当揭示）',
    );
    const repairStart = deterministicCandidate.lastIndexOf(excerpt);
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') return { text: writerJson(writerContent) };
      if (input.stage === 'checker') {
        return {
          text: JSON.stringify({
            issues: [
              {
                category: 'world',
                subtype: 'duplicate_excerpt_target',
                severity: 'blocking',
                confidence: 1,
                generatedStart: originalSecondStart,
                generatedEnd: originalSecondStart + excerpt.length,
                generatedExcerpt: excerpt,
                description: '必须修复第二处重复片段',
                evidenceIds: [42],
                suggestedFix: '改写第二处片段',
              },
            ],
          }),
        };
      }
      return {
        text: JSON.stringify({
          patches: [
            {
              start: repairStart,
              end: repairStart + excerpt.length,
              replacement: '修复片段',
            },
          ],
        }),
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual([
      'writer',
      'checker',
      'repair',
    ]);
    expect(calls.filter(call => call.stage === 'checker')).toHaveLength(1);
    expect(mockState.artifacts.map(artifact => artifact.stage)).toEqual([
      'writer',
      'repair',
    ]);
    const finalContent = mockState.artifacts.at(-1).content;
    expect(finalContent.slice(500, 500 + excerpt.length)).toBe(excerpt);
    expect(finalContent).toContain('修复片段');
    expect(finalContent).not.toContain(futureMarker);
  });

  it('clears offsets when duplicate excerpt rebinding is tied and keeps the issue open', async () => {
    seedRun({ workflowVersion: 2, targetChapterChars: 3000 });
    const excerpt = '重复片段';
    const filler = '待修改文本'.repeat(2);
    const prefix = '甲'.repeat(100);
    const patchStart = prefix.length + excerpt.length;
    const patchEnd = patchStart + filler.length;
    const originalTargetStart = patchEnd;
    const writerContent =
      prefix +
      excerpt +
      filler +
      excerpt +
      '乙'.repeat(3000 - prefix.length - excerpt.length * 2 - filler.length);
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') return { text: writerJson(writerContent) };
      if (input.stage === 'checker') {
        return {
          text: JSON.stringify({
            issues: [
              {
                category: 'plot',
                subtype: 'ambiguous_duplicate_target',
                severity: 'blocking',
                confidence: 1,
                generatedStart: originalTargetStart,
                generatedEnd: originalTargetStart + excerpt.length,
                generatedExcerpt: excerpt,
                description: '重复片段无法唯一定位',
                evidenceIds: [42],
                suggestedFix: '只修复能够唯一定位的局部问题',
              },
              {
                category: 'world',
                subtype: 'covered_patch_target',
                severity: 'blocking',
                confidence: 1,
                generatedStart: patchStart,
                generatedEnd: patchEnd,
                generatedExcerpt: filler,
                description: '必须覆盖的局部问题',
                evidenceIds: [42],
                suggestedFix: '替换局部片段',
              },
            ],
          }),
        };
      }
      return {
        text: JSON.stringify({
          patches: [
            {
              start: patchStart,
              end: patchEnd,
              replacement: '修复内容'.repeat(6),
            },
          ],
        }),
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual([
      'writer',
      'checker',
      'repair',
    ]);
    expect(calls.filter(call => call.stage === 'checker')).toHaveLength(1);
    expect(mockState.artifacts.map(artifact => artifact.stage)).toEqual([
      'writer',
      'repair',
    ]);
    const finalArtifact = mockState.artifacts.at(-1);
    const unresolved = mockState.checks.find(
      check =>
        check.artifactId === finalArtifact.id &&
        check.subtype === 'ambiguous_duplicate_target',
    );
    expect(unresolved).toEqual(
      expect.objectContaining({
        generatedStart: null,
        generatedEnd: null,
        resolutionStatus: 'open',
      }),
    );
  });

  it('rejects malformed or overlapping Repair patches', () => {
    expect(
      applyRepairPatches(
        'abcdef',
        '{"patches":[{"start":0,"end":2,"replacement":"甲"},{"start":1,"end":3,"replacement":"乙"}]}',
      ),
    ).toBeNull();
    expect(
      applyRepairPatches(
        'abcdef',
        '{"patches":[{"start":0,"end":2,"replacement":"甲"}]}',
      ),
    ).toBe('甲cdef');
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
      return {
        text: JSON.stringify({
          patches: [
            {
              start: 0,
              end: snap.primaryAnchor.excerpt.length + '继续正文'.length,
              replacement:
                '改写后的安全终稿，继续推进新的事件。' + '甲'.repeat(40),
            },
          ],
        }),
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual([
      'writer',
      'checker',
      'repair',
    ]);
    expect(calls.filter(call => call.stage === 'checker')).toHaveLength(1);
    expect(mockState.artifacts.map(artifact => artifact.stage)).toEqual([
      'writer',
      'repair',
    ]);
    expect(mockState.artifacts.at(-1).content).toContain('改写后的安全终稿');
    expect(
      mockState.checks.some(
        check => check.subtype === 'continuation_anchor_overlap',
      ),
    ).toBe(true);
    expect(
      JSON.parse(mockState.run.tokenUsageJson).stages.localVerify.note,
    ).toContain('未进行第二次 LLM 复检');
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
      if (input.stage === 'checker')
        return {
          text: JSON.stringify({
            issues: [
              {
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
              },
            ],
          }),
        };
      repairCalls += 1;
      if (repairCalls === 1) {
        return {
          text: JSON.stringify({
            patches: [
              {
                start: 0,
                end: 4,
                replacement: `${snap.primaryAnchor.excerpt}修复候选`,
              },
            ],
          }),
        };
      }
      return {
        text: JSON.stringify({
          patches: [
            {
              start: 0,
              end: 44,
              replacement: '完全改写后的终稿'.repeat(10),
            },
          ],
        }),
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);
    expect(mockState.artifacts.at(-1).stage).toBe('repair');
    expect(
      mockState.checks.some(c => c.subtype === 'continuation_anchor_overlap'),
    ).toBe(true);

    await repairContinuationArtifactOnce('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual([
      'writer',
      'checker',
      'repair',
      'repair',
    ]);
    expect(calls.filter(call => call.stage === 'checker')).toHaveLength(1);
    expect(mockState.artifacts.at(-1).content).toBe(
      '完全改写后的终稿'.repeat(10),
    );
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

    await expect(
      resumeInterruptedRun('ct_standard', callStage as any),
    ).rejects.toThrow('仅返回推理内容');
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
            issues: [
              {
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
              },
            ],
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
    seedRun({ workflowVersion: 2, targetChapterChars: 3000 });
    const writerContent = '甲'.repeat(3000);
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') return { text: writerJson(writerContent) };
      if (input.stage === 'checker') {
        return {
          text: JSON.stringify({
            issues: [
              {
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
              },
            ],
          }),
        };
      }
      return {
        text: JSON.stringify({
          patches: [
            { start: 0, end: 3000, replacement: '修复后的摘要'.repeat(20) },
          ],
        }),
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual([
      'writer',
      'checker',
      'repair',
    ]);
    expect(mockState.artifacts).toHaveLength(1);
    expect(mockState.artifacts[0].stage).toBe('writer');
    expect(mockState.artifacts[0].content).toHaveLength(3000);
    expect(JSON.parse(mockState.run.tokenUsageJson).stages.repair.warning).toBe(
      'repair_candidate_rejected_as_over_contracted',
    );
  });

  it('rejects an over-contracted Repair candidate when the Writer draft is over the dynamic length band', async () => {
    seedRun({ workflowVersion: 2, targetChapterChars: 3000 });
    const writerContent = '甲'.repeat(5000);
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') return { text: writerJson(writerContent) };
      if (input.stage === 'checker') {
        return {
          text: JSON.stringify({
            issues: [
              {
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
              },
            ],
          }),
        };
      }
      return {
        text: JSON.stringify({
          patches: [{ start: 0, end: 5000, replacement: '乙'.repeat(2400) }],
        }),
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);

    expect(calls.map(call => call.stage)).toEqual([
      'writer',
      'checker',
      'repair',
    ]);
    expect(mockState.artifacts).toHaveLength(1);
    expect(mockState.artifacts[0].content).toHaveLength(5000);
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
      if (input.stage === 'writer')
        return { text: writerJson('保留的 Writer 正文') };
      if (input.stage === 'checker') {
        return {
          text: JSON.stringify({
            issues: [
              {
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
              },
            ],
          }),
        };
      }
      repairAttempts += 1;
      if (repairAttempts === 1) throw new Error('Repair 网络错误');
      return {
        text: JSON.stringify({
          patches: [{ start: 0, end: 13, replacement: '额外修正后的终稿' }],
        }),
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);
    expect(mockState.artifacts).toHaveLength(1);
    expect(mockState.artifacts[0].stage).toBe('writer');
    expect(
      JSON.parse(mockState.run.tokenUsageJson).stages.repair.requestCount,
    ).toBe(1);

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

  it('allows only one extra Repair and rejects a worse additional candidate', async () => {
    seedRun({ workflowVersion: 2, targetChapterChars: 3000 });
    const writerContent = '甲'.repeat(3000);
    const calls: any[] = [];
    const callStage = jest.fn(async (input: any) => {
      calls.push(input);
      if (input.stage === 'writer') return { text: writerJson(writerContent) };
      if (input.stage === 'checker') {
        return {
          text: JSON.stringify({
            issues: [
              {
                category: 'plot',
                subtype: 'manual_block',
                severity: 'blocking',
                confidence: 1,
                generatedStart: 0,
                generatedEnd: 2,
                generatedExcerpt: '甲甲',
                description: '需要修复',
                evidenceIds: [42],
                suggestedFix: '改写命中片段',
              },
            ],
          }),
        };
      }
      if (calls.filter(call => call.stage === 'repair').length === 1) {
        return {
          text: JSON.stringify({
            patches: [{ start: 10, end: 12, replacement: '乙乙' }],
          }),
        };
      }
      return {
        text: JSON.stringify({
          patches: [{ start: 0, end: 2, replacement: '乙' }],
        }),
      };
    });

    await resumeInterruptedRun('ct_standard', callStage as any);
    await expect(
      repairContinuationArtifactOnce('ct_standard', callStage as any),
    ).rejects.toThrow('明显远离目标');

    expect(calls.map(call => call.stage)).toEqual([
      'writer',
      'checker',
      'repair',
      'repair',
    ]);
    expect(calls.filter(call => call.stage === 'checker')).toHaveLength(1);
    expect(mockState.artifacts).toHaveLength(1);
    expect(mockState.artifacts[0].content).toBe(writerContent);
    const callsAfterFailedAdditionalRepair = calls.length;
    await expect(
      repairContinuationArtifactOnce('ct_standard', callStage as any),
    ).rejects.toThrow('已经使用过');
    expect(calls).toHaveLength(callsAfterFailedAdditionalRepair);
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

  it('reports an under-range Han character count as a deterministic length error', () => {
    const issues = runDeterministicChecks('abc 123', snapshot(2));
    const lengthIssue = issues.find(
      issue => issue.subtype === 'chapter_length_under_target',
    );

    expect(lengthIssue?.severity).toBe('error');
    expect(issues.some(issue => issue.subtype === 'target_length')).toBe(false);
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

    expect(
      bindIssuesToArtifact([issue], '接缝重合正文', new Set()).at(0)?.severity,
    ).toBe('error');
  });
});
