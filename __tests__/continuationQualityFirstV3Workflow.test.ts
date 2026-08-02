/**
 * V3 quality-first workflow tests (Implementation plan §11.2).
 *
 * Mocks generationRepository at the module boundary and drives the V3 Runner
 * through its four-stage state machine with an injected `callStage`.
 */
import { planStageCapacity } from '../src/services/continuation/generation/continuationContextBudget';

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
const mockMarkChecksObsolete = jest.fn(
  async (_runId: string, artifactId: string) => {
    mockState.checks
      .filter(
        row =>
          row.artifactId === artifactId && row.resolutionStatus === 'open',
      )
      .forEach(row => {
        row.resolutionStatus = 'obsolete';
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
      markChecksObsolete: (...args: any[]) =>
        (mockMarkChecksObsolete as any)(...args),
    };
  },
);

import { runQualityFirstV3Stages } from '../src/services/continuation/generation/continuationGenerationRunner';
import type { ContinuationContextSnapshot } from '../src/services/continuation/generation/types';

/**
 * Generate `n` Han characters with NO repeated n-grams, so the duplicate
 * detector stays `within`. Stays within the BMP CJK Unified Ideographs range
 * (U+4E00–U+9FFF) so countHanCharacters counts every char. '甲'.repeat(n) has
 * 100% n-gram repetition and is correctly blocked; tests need this generator
 * to exercise the length gate without tripping the dup gate.
 */
function PROSE(n: number): string {
  let out = '';
  const span = 0x9fff - 0x4e00; // 20991 distinct BMP Han code points
  for (let i = 0; i < n; i += 1) {
    // Step by 7 (coprime with span) so the sequence covers the range without
    // short cycles; every 8–12 char window is therefore unique.
    out += String.fromCodePoint(0x4e00 + ((i * 7) % span));
  }
  return out;
}

function buildSnapshot(targetChapterChars: number): ContinuationContextSnapshot {
  const settings: any = {
    targetChapterChars,
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
    resurrectionPolicy: 'forbid',
    allowNewCharacters: false,
    allowNewLocations: false,
    allowNewOrganizations: false,
    majorRelationshipChangePolicy: 'require_confirmation',
    majorPowerChangePolicy: 'require_confirmation',
    characterDeathPolicy: 'require_confirmation',
    plannerLlmConfigId: null,
    writerLlmConfigId: null,
    checkerLlmConfigId: null,
    repairLlmConfigId: null,
    stateExtractionLlmConfigId: null,
    plannerConfirmationPolicy: 'risk_only',
    customRulesJson: '[]',
    createdAt: '',
    updatedAt: '',
  };
  const capacity = (id: number) =>
    planStageCapacity({
      llmConfigId: id,
      contextWindow: 1_000_000,
      maxOutputTokens: 200_000,
    });
  const thinkingPolicy = {
    required: true,
    type: 'enabled' as const,
    reasoningEffort: 'high' as const,
  };
  return {
    schemaVersion: 2,
    workflowVersion: 3,
    projectId: 1,
    targetChapterId: 10,
    targetPosition: 2 as any,
    source: {
      sourceId: 1,
      sourceVersion: 1,
      normalizedSha256: 'source-hash',
      boundary: { chapterId: 1, chapterPosition: 1, charOffsetExclusive: 10 },
    } as any,
    canon: {
      snapshotId: 'canon-1',
      revision: 1,
      boundaryGlobalCharOffset: 10,
      capabilities: {} as any,
    },
    storyMemory: { stateFingerprint: 'memory', throughPosition: 1, status: 'ready' },
    inputRevisionHash: 'input',
    settingsSnapshot: {
      schemaVersion: 1,
      workflowVersion: 3,
      values: settings,
      resolvedModelConfigIds: { planner: 11, writer: 22, checker: 33, repair: 44, stateExtraction: 55 },
      frozenModelConfigs: {
        planner: null,
        writer: { configId: 22, name: 'w', providerType: 'openai_compatible', url: 'https://example.com', modelName: 'deepseek-v4-pro', contextWindow: 1_000_000, maxOutputTokens: 200_000, thinkingPolicy },
        checker: { configId: 33, name: 'c', providerType: 'openai_compatible', url: 'https://example.com', modelName: 'deepseek-v4-pro', contextWindow: 1_000_000, maxOutputTokens: 200_000, thinkingPolicy },
        repair: { configId: 44, name: 'r', providerType: 'openai_compatible', url: 'https://example.com', modelName: 'deepseek-v4-pro', contextWindow: 1_000_000, maxOutputTokens: 200_000, thinkingPolicy },
        stateExtraction: null,
      },
    },
    stageBudgets: { planner: capacity(11), writer: capacity(22), checker: capacity(33), repair: capacity(44) },
    bundles: {
      lockedRules: [],
      canon: { worldRules: [], characters: [], characterStates: [], relationships: [], experiences: [], knowledge: [], plotThreads: [], timelineEvents: [], evidenceRefs: [], evidenceRefsByOwner: {} } as any,
      effectiveState: { characterStates: [], relationships: [], plotThreads: [], knowledge: [], experiences: [], freshness: { canonReady: true, storyMemoryStatus: 'ready', pendingStateExtractionCount: 0, pendingMajorProposalCount: 0, dirtyFromPosition: null }, appliedEventIds: [], omittedReasons: [] } as any,
      seam: { summary: 'seam', excerpt: 'seam' },
      recentChapters: [],
      storyMemory: { summary: '', estimatedTokens: 0 },
      episodic: [],
      style: null,
      userInstruction: '推进冲突',
    } as any,
    primaryAnchor: null,
    createdAt: '',
  } as unknown as ContinuationContextSnapshot;
}

async function runV3(input: {
  callStage: any;
  targetChapterChars: number;
}): Promise<{
  run: any;
  artifacts: any[];
  physicalRequestCount: number;
}> {
  const snapshot = buildSnapshot(input.targetChapterChars);
  const controller = new AbortController();
  mockState.run = { id: 'ct_test', state: 'running', stage: 'writer', tokenUsageJson: '{}', errorCode: null, errorMessage: null, projectId: 1 };
  try {
    await runQualityFirstV3Stages('ct_test', snapshot, {
      callStage: input.callStage,
      signal: controller.signal,
      projectId: 1,
    });
  } finally {
    controller.abort();
  }
  let physicalRequestCount = 0;
  try {
    const parsed = JSON.parse(mockState.run.tokenUsageJson || '{}');
    physicalRequestCount = parsed.physicalRequestCount ?? 0;
  } catch {
    physicalRequestCount = 0;
  }
  return { run: mockState.run, artifacts: [...mockState.artifacts], physicalRequestCount };
}

function writerResponse(target: number, content: string) {
  return {
    text: JSON.stringify({
      schemaVersion: 2,
      plan: {
        targetHanCharacters: target,
        chapterGoal: 'g',
        centralConflict: 'c',
        beats: [{ order: 1, summary: 'b', targetHanCharacters: target }],
        participatingCharacterIds: [],
      },
      content,
    }),
    usage: { prompt: 100, completion: 200 },
    finishReason: 'stop',
  };
}

function checkerResponse() {
  return { text: '{"issues":[]}', usage: { prompt: 50, completion: 10 }, finishReason: 'stop' };
}

function reviserResponse(content: string) {
  return { text: JSON.stringify({ schemaVersion: 1, content }), usage: { prompt: 200, completion: 300 }, finishReason: 'stop' };
}

describe('V3 quality-first workflow (plan §11.2)', () => {
  beforeEach(() => {
    mockState.run = null;
    mockState.artifacts = [];
    mockState.plans = [];
    mockState.checks = [];
    jest.clearAllMocks();
  });

  it('normal path: Writer + Initial Checker both clean → exactly 2 physical requests → awaiting_user', async () => {
    const target = 3000;
    const callStage = jest.fn(async (input: any) => {
      if (input.stage === 'writer') return writerResponse(target, PROSE(3000));
      if (input.stage === 'checker') return checkerResponse();
      throw new Error(`unexpected ${input.stage}`);
    });
    const result = await runV3({ callStage, targetChapterChars: target });
    expect(result.run.state).toBe('awaiting_user');
    expect(result.physicalRequestCount).toBe(2);
    expect(callStage).toHaveBeenCalledTimes(2);
    expect(result.artifacts.filter(a => a.stage === 'repair')).toHaveLength(0);
  });

  it('revision path: Writer length under target → Reviser + Final Checker → 4 requests → awaiting_user', async () => {
    const target = 3000;
    const callStage = jest.fn(async (input: any) => {
      if (input.stage === 'writer') return writerResponse(target, PROSE(1000));
      if (input.stage === 'checker') return checkerResponse();
      if (input.stage === 'repair') return reviserResponse(PROSE(3000));
      throw new Error(`unexpected ${input.stage}`);
    });
    const result = await runV3({ callStage, targetChapterChars: target });
    expect(result.run.state).toBe('awaiting_user');
    expect(result.physicalRequestCount).toBe(4);
    expect(callStage).toHaveBeenCalledTimes(4);
    expect(result.artifacts.filter(a => a.stage === 'repair')).toHaveLength(1);
  });

  it('revision still fails length → failed, not adoptable', async () => {
    const target = 3000;
    const callStage = jest.fn(async (input: any) => {
      if (input.stage === 'writer') return writerResponse(target, PROSE(1000));
      if (input.stage === 'checker') return checkerResponse();
      if (input.stage === 'repair') return reviserResponse(PROSE(1500));
      throw new Error(`unexpected ${input.stage}`);
    });
    const result = await runV3({ callStage, targetChapterChars: target });
    expect(result.run.state).toBe('failed');
    expect(result.run.errorCode).toBe('v3_quality_gate_failed');
    expect(result.physicalRequestCount).toBe(4);
  });

  it('writer self-duplication triggers Reviser; clean revision → awaiting_user', async () => {
    const target = 60;
    // Writer returns duplicated prose (triggers dup gate) → Reviser runs and
    // returns genuinely different clean prose → awaiting_user.
    const callStage = jest.fn(async (input: any) => {
      if (input.stage === 'writer') return writerResponse(target, PROSE(30) + PROSE(30));
      if (input.stage === 'checker') return checkerResponse();
      if (input.stage === 'repair') return reviserResponse(PROSE(60));
      throw new Error(`unexpected ${input.stage}`);
    });
    const result = await runV3({ callStage, targetChapterChars: target });
    expect(result.run.state).toBe('awaiting_user');
    expect(result.physicalRequestCount).toBe(4);
  });

  it('repair that returns writer+writer is blocked by final gate → failed', async () => {
    const target = 1000;
    // Writer is short (length gate fails) → Reviser runs and returns
    // writer+writer duplication → final gate blocks → failed.
    const writerContent = PROSE(100);
    const callStage = jest.fn(async (input: any) => {
      if (input.stage === 'writer') return writerResponse(target, writerContent);
      if (input.stage === 'checker') return checkerResponse();
      if (input.stage === 'repair') return reviserResponse(writerContent + writerContent);
      throw new Error(`unexpected ${input.stage}`);
    });
    const result = await runV3({ callStage, targetChapterChars: target });
    expect(result.run.state).toBe('failed');
    expect(result.run.errorCode).toBe('v3_quality_gate_failed');
  });

  it('never exceeds 4 physical requests (budget cap holds)', async () => {
    const target = 1000;
    const callStage = jest.fn(async (input: any) => {
      if (input.stage === 'writer') return writerResponse(target, PROSE(100));
      if (input.stage === 'checker') return checkerResponse();
      if (input.stage === 'repair') return reviserResponse(PROSE(110));
      throw new Error(`unexpected ${input.stage}`);
    });
    const result = await runV3({ callStage, targetChapterChars: target });
    expect(result.physicalRequestCount).toBeLessThanOrEqual(4);
    expect(callStage).toHaveBeenCalledTimes(4);
  });

  it('Final Checker network failure → run fails, not awaiting_user', async () => {
    const target = 1000;
    let checkerCalls = 0;
    const callStage = jest.fn(async (input: any) => {
      if (input.stage === 'writer') return writerResponse(target, PROSE(100));
      if (input.stage === 'checker') {
        checkerCalls += 1;
        if (checkerCalls === 2) throw new Error('Final Checker timeout');
        return checkerResponse();
      }
      if (input.stage === 'repair') return reviserResponse(PROSE(110));
      throw new Error(`unexpected ${input.stage}`);
    });
    await expect(runV3({ callStage, targetChapterChars: target })).rejects.toThrow(
      /Final Checker timeout|cancelled/,
    );
  });

  it('Writer artifact plan is saved with V2-compatible schemaVersion 1', async () => {
    const target = 3000;
    const callStage = jest.fn(async (input: any) => {
      if (input.stage === 'writer') return writerResponse(target, PROSE(3000));
      if (input.stage === 'checker') return checkerResponse();
      throw new Error(`unexpected ${input.stage}`);
    });
    await runV3({ callStage, targetChapterChars: target });
    expect(mockState.plans).toHaveLength(1);
    expect(mockState.plans[0].schemaVersion).toBe(1);
  });

  it('Writer checks are marked obsolete after repair artifact is created', async () => {
    const target = 3000;
    const callStage = jest.fn(async (input: any) => {
      if (input.stage === 'writer') return writerResponse(target, PROSE(1000));
      if (input.stage === 'checker') return checkerResponse();
      if (input.stage === 'repair') return reviserResponse(PROSE(3000));
      throw new Error(`unexpected ${input.stage}`);
    });
    await runV3({ callStage, targetChapterChars: target });
    expect(mockMarkChecksObsolete).toHaveBeenCalled();
  });
});
