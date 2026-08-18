import { waitFor } from '@testing-library/react-native';
import { cloneDefaultContextAutomationPolicy } from '../src/services/contextAutomationPolicy';
import {
  buildContinuationV4StageViews,
} from '../src/services/continuation/generation/continuationV4ContextViews';
import {
  resolveContinuationV4BudgetPreview,
} from '../src/services/continuation/generation/continuationV4Budget';

jest.mock('../src/services/contextAutoAllocator', () => ({
  ensureContextAutomationPolicy: jest.fn(async () =>
    require('../src/services/contextAutomationPolicy').cloneDefaultContextAutomationPolicy(),
  ),
}));

jest.mock('../src/services/llm', () => ({
  callLLMResult: jest.fn(),
  resolveLLMRequestConfig: jest.fn(async () => ({
    id: 1,
    name: '测试模型',
    provider_type: 'openai_compatible',
    api_key: 'test',
    model_name: 'test-model',
    url: 'https://example.test/v1',
    context_window: 128000,
    max_output_tokens: 32000,
  })),
  resolveLLMRequestConfigById: jest.fn(async () => ({
    id: 1,
    name: '测试模型',
    provider_type: 'openai_compatible',
    api_key: 'test',
    model_name: 'test-model',
    url: 'https://example.test/v1',
    context_window: 128000,
    max_output_tokens: 32000,
  })),
}));

jest.mock('../src/services/continuation/generation/continuationContextBuilder', () => ({
  buildContinuationV4Context: jest.fn(),
}));

jest.mock('../src/services/continuation/generation/generationRepository', () => ({
  casUpdateRunState: jest.fn(),
  contentRevisionHash: jest.fn(() => 'content-hash'),
  ensureContinuationV4StageResults: jest.fn(),
  ensureGenerationSettings: jest.fn(),
  finalizeContinuationV4LocalGate: jest.fn(),
  finalizeContinuationV4Repair: jest.fn(),
  getLatestArtifactForStage: jest.fn(),
  getPlan: jest.fn(),
  getRunById: jest.fn(),
  getRunContextSnapshotJson: jest.fn(),
  getStageResult: jest.fn(),
  insertArtifact: jest.fn(),
  insertCheckResults: jest.fn(),
  insertRun: jest.fn(),
  listChecksForArtifact: jest.fn(),
  listStageResults: jest.fn(),
  newContinuationRunId: jest.fn(),
  reserveContinuationStage: jest.fn(),
  savePlan: jest.fn(),
  updateStageResult: jest.fn(),
}));

import { buildContinuationV4Context } from '../src/services/continuation/generation/continuationContextBuilder';
import * as repository from '../src/services/continuation/generation/generationRepository';
import { cancelContinuationRun } from '../src/services/continuation/generation/legacy/continuationGenerationRunner';
import {
  resumeContinuationV4Run,
  startContinuationV4Run,
} from '../src/services/continuation/generation/legacy/continuationV4Runner';

const mockBuildContext = buildContinuationV4Context as jest.Mock;
const mockRepository = repository as jest.Mocked<typeof repository>;
let rows: any[] = [];
let activeRun: any;
let artifacts: any[] = [];
let checks: any[] = [];
let plan: any;

const settings: any = {
  projectId: 1,
  strictnessProfile: 'balanced',
  worldRuleLevel: 'strict',
  characterLevel: 'strict',
  relationshipLevel: 'strict',
  plotLevel: 'balanced',
  experienceLevel: 'strict',
  knowledgeLevel: 'strict',
  styleLevel: 'strict',
  allowNewCharacters: true,
  allowNewLocations: true,
  allowNewOrganizations: true,
  majorRelationshipChangePolicy: 'require_confirmation',
  majorPowerChangePolicy: 'require_confirmation',
  characterDeathPolicy: 'require_confirmation',
  resurrectionPolicy: 'forbid',
  plannerLlmConfigId: null,
  writerLlmConfigId: null,
  checkerLlmConfigId: null,
  repairLlmConfigId: null,
  stateExtractionLlmConfigId: null,
  controlLlmConfigId: null,
  plannerConfirmationPolicy: 'never',
  checkerEnabled: true,
  maxRepairRounds: 1,
  targetChapterChars: 600,
  customRulesJson: '[]',
  createdAt: '',
  updatedAt: '',
};

function makeContext() {
  const policy = cloneDefaultContextAutomationPolicy();
  const stages = {
    writer: { configId: 1, contextWindow: 128000, maxOutputTokens: 32000 },
    checker: { configId: 1, contextWindow: 128000, maxOutputTokens: 32000 },
    control: { configId: 1, contextWindow: 128000, maxOutputTokens: 32000 },
    repair: { configId: 1, contextWindow: 128000, maxOutputTokens: 32000 },
  } as const;
  const stageBudgets = resolveContinuationV4BudgetPreview({
    frozenPolicy: policy,
    stages,
    targetChapterChars: 600,
    compiledPromptTokens: 100,
    protocolSkeletonTokens: 20,
  }).stages;
  const snapshot: any = {
    schemaVersion: 3,
    workflowVersion: 4,
    projectId: 1,
    targetChapterId: 2,
    targetPosition: 1,
    source: { sourceId: 1 },
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
      values: settings,
      resolvedModelConfigIds: {
        planner: 1,
        writer: 1,
        checker: 1,
        control: 1,
        repair: 1,
        stateExtraction: 1,
      },
      frozenModelConfigs: {
        planner: null,
        writer: {
          configId: 1,
          name: '测试模型',
          providerType: 'openai_compatible',
          url: 'https://example.test/v1',
          modelName: 'test-model',
          contextWindow: 128000,
          maxOutputTokens: 32000,
        },
        checker: {
          configId: 1,
          name: '测试模型',
          providerType: 'openai_compatible',
          url: 'https://example.test/v1',
          modelName: 'test-model',
          contextWindow: 128000,
          maxOutputTokens: 32000,
        },
        control: {
          configId: 1,
          name: '测试模型',
          providerType: 'openai_compatible',
          url: 'https://example.test/v1',
          modelName: 'test-model',
          contextWindow: 128000,
          maxOutputTokens: 32000,
        },
        repair: {
          configId: 1,
          name: '测试模型',
          providerType: 'openai_compatible',
          url: 'https://example.test/v1',
          modelName: 'test-model',
          contextWindow: 128000,
          maxOutputTokens: 32000,
        },
        stateExtraction: null,
      },
    },
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
        evidenceRefs: [1],
        estimatedTokens: 0,
        omittedReasonCounts: {},
      },
      effectiveState: {
        characterStates: [],
        relationships: [],
        plotThreads: [],
        knowledge: [],
        experiences: [],
      },
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
    budgetPolicy: {
      schemaVersion: policy.schemaVersion,
      allocatorVersion: policy.allocatorVersion,
      policyHash: 'policy-hash',
      policy,
    },
    stageBudgets,
  };
  snapshot.stageViews = buildContinuationV4StageViews({ snapshot, stageBudgets });
  return {
    snapshot,
    trace: {
      sourceId: 1,
      canonSnapshotId: 'canon-v4',
      canonRevision: 1,
      targetPosition: 1,
      entityRefs: [],
      storyMemoryFingerprint: 'state',
      freshness: {
        canonReady: true,
        storyMemoryStatus: 'ready',
        pendingStateExtractionCount: 0,
        pendingMajorProposalCount: 0,
      },
      categories: [],
      totalInputTokens: 0,
      reservedOutputTokens: 0,
      omittedCapabilities: [],
    },
  };
}

describe('Continuation V4 runner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const context = makeContext();
    mockBuildContext.mockResolvedValue(context);
    mockRepository.ensureGenerationSettings.mockResolvedValue(settings);
    activeRun = {
      id: 'ct_v4_workflow',
      workflowVersion: 4,
      projectId: 1,
      chapterId: 2,
      targetPosition: 1,
      sourceId: 1,
      sourceSnapshotJson: '{}',
      canonSnapshotId: 'canon-v4',
      canonRevision: 1,
      storyMemoryFingerprint: 'state',
      storyMemoryThroughPosition: -1,
      inputRevisionHash: 'input',
      userInstruction: '推进冲突',
      settingsSnapshotJson: JSON.stringify(context.snapshot.settingsSnapshot),
      contextSnapshotJson: JSON.stringify(context.snapshot),
      contextTraceJson: JSON.stringify(context.trace),
      tokenUsageJson: '{}',
      state: 'running',
      stage: 'writer',
      errorCode: null,
      errorMessage: null,
    };
    rows = [];
    artifacts = [];
    checks = [];
    plan = {
      schemaVersion: 1,
      chapterGoal: '推进冲突',
      centralConflict: '门外有追兵',
      beats: [{ order: 1, summary: '承接并升级' }],
      participatingCharacterIds: [],
      characterActions: [],
      plotAdvances: [],
      foreshadowingActions: [],
      proposedStateChanges: [],
      risks: [],
    };
    mockRepository.insertRun.mockResolvedValue(activeRun);
    mockRepository.newContinuationRunId.mockReturnValue('ct_v4_workflow');
    mockRepository.getRunById.mockImplementation(async () => activeRun);
    mockRepository.getRunContextSnapshotJson.mockImplementation(
      async () => activeRun.contextSnapshotJson ?? null,
    );
    mockRepository.listStageResults.mockImplementation(async () => rows);
    mockRepository.getStageResult.mockImplementation(async (_runId, stage) =>
      rows.find(row => row.stage === stage) || null,
    );
    mockRepository.ensureContinuationV4StageResults.mockImplementation(async ({ runId, stages }: any) => {
      for (const stage of ['writer', 'checker', 'control', 'repair']) {
        if (!rows.some(row => row.stage === stage)) {
          rows.push({
            id: `${stage}-result`,
            runId,
            stage,
            status: 'queued',
            requestReserved: false,
            requestCount: 0,
            modelConfigId: stages[stage].configId,
            inputTokens: null,
            minOutputTokens: stages[stage].minimumOutputTokens,
            maxOutputTokens: stages[stage].maximumOutputTokens,
            outputJson: null,
            artifactId: null,
          });
        }
      }
      if (!rows.some(row => row.stage === 'local_verify')) {
        rows.push({
          id: 'local-result',
          runId,
          stage: 'local_verify',
          status: 'queued',
          requestReserved: false,
          requestCount: 0,
          modelConfigId: null,
          inputTokens: null,
          minOutputTokens: null,
          maxOutputTokens: null,
          outputJson: null,
          artifactId: null,
        });
      }
      return rows;
    });
    mockRepository.reserveContinuationStage.mockImplementation(async (input: any) => {
      const row = rows.find(item => item.stage === input.stage);
      if (!row || row.requestReserved) return { reserved: false, result: row };
      Object.assign(row, {
        status: 'running',
        requestReserved: true,
        requestCount: 1,
        modelConfigId: input.modelConfigId,
        inputTokens: input.inputTokens,
        minOutputTokens: input.minOutputTokens,
        maxOutputTokens: input.maxOutputTokens,
      });
      return { reserved: true, result: row };
    });
    mockRepository.updateStageResult.mockImplementation(async (input: any) => {
      const row = rows.find(item => item.stage === input.stage);
      if (row) Object.assign(row, input);
      return row || null;
    });
    mockRepository.getLatestArtifactForStage.mockImplementation(async (_runId, stage) =>
      artifacts.filter(item => item.stage === stage).at(-1) || null,
    );
    mockRepository.insertArtifact.mockImplementation(async (input: any) => {
      const artifact = {
        id: `${input.stage}-artifact`,
        runId: input.runId,
        stage: input.stage,
        repairRound: input.repairRound || 0,
        parentArtifactId: input.parentArtifactId || null,
        content: input.content,
        contentHash: `${input.stage}-hash`,
        eligibilityStatus: input.eligibilityStatus || 'eligible',
        rejectionCode: input.rejectionCode || null,
        createdAt: '2026-08-03T00:00:00.000Z',
      };
      artifacts.push(artifact);
      return artifact;
    });
    mockRepository.savePlan.mockResolvedValue({ planHash: 'plan-hash' });
    mockRepository.getPlan.mockResolvedValue({
      plan,
      planHash: 'plan-hash',
      confirmationStatus: 'not_required',
    });
    mockRepository.listChecksForArtifact.mockImplementation(async (_runId, artifactId) =>
      checks.filter(item => item.artifactId === artifactId),
    );
    mockRepository.insertCheckResults.mockImplementation(async (input: any[]) => {
      for (const item of input) checks.push({ id: checks.length + 1, ...item });
    });
    mockRepository.finalizeContinuationV4Repair.mockImplementation(async (input: any) => {
      const artifact = {
        id: 'repair-artifact',
        runId: input.runId,
        stage: 'repair' as const,
        repairRound: 1,
        parentArtifactId: input.parentArtifactId,
        content: input.content,
        contentHash: 'repair-hash',
        eligibilityStatus: input.eligibilityStatus,
        rejectionCode: input.rejectionCode || null,
        createdAt: '2026-08-03T00:00:00.000Z',
      };
      artifacts.push(artifact);
      const repairRow = rows.find(row => row.stage === 'repair');
      const localRow = rows.find(row => row.stage === 'local_verify');
      Object.assign(repairRow, { status: 'success', artifactId: artifact.id, outputJson: input.repairOutputJson });
      Object.assign(localRow, { status: input.localVerifyStatus || 'success', artifactId: artifact.id, outputJson: input.localVerifyOutputJson });
      activeRun.state = 'awaiting_user';
      activeRun.stage = 'awaiting_user';
      return { artifact, repairStageResult: repairRow, localVerifyStageResult: localRow };
    });
    mockRepository.casUpdateRunState.mockImplementation(async (_id, expected, patch) => {
      if (!expected.includes(activeRun.state)) return false;
      Object.assign(activeRun, patch);
      return true;
    });
  });

  test('calls Writer then parallel Checker/Control then one full Repair, never a fifth request', async () => {
    const order: string[] = [];
    const fullDraft = '这是完整正文。'.repeat(100);
    const callStage = jest.fn(async (input: any) => {
      order.push(input.stage);
      if (input.stage === 'writer') {
        return {
          text: JSON.stringify({
            schemaVersion: 1,
            plan: {
              chapterGoal: '推进冲突',
              centralConflict: '门外有追兵',
              beats: [{ id: 'beat_1', summary: '承接并升级' }],
            },
            content: fullDraft,
          }),
          usage: { completion: 100 },
        };
      }
      if (input.stage === 'checker') {
        return {
          text: JSON.stringify({
            schemaVersion: 1,
            writerArtifactHash: 'writer-hash',
            issues: [
              {
                category: 'plot',
                subtype: 'semantic_conflict',
                severity: 'error',
                confidence: 1,
                generatedExcerpt: fullDraft.slice(0, 4),
                description: '需要处理冻结剧情冲突',
                evidenceIds: [1],
                suggestedFix: '修复冲突',
              },
            ],
            warnings: [],
          }),
          usage: { completion: 80 },
        };
      }
      if (input.stage === 'control') {
        return {
          text: JSON.stringify({
            schemaVersion: 1,
            action: 'keep',
            currentHan: 600,
            targetHan: 600,
            allowedMinHan: 100,
            allowedMaxHan: 1100,
            suggestions: [],
            preserve: ['章末钩子'],
          }),
          usage: { completion: 40 },
        };
      }
      return {
        text: JSON.stringify({
          schemaVersion: 1,
          content: `${fullDraft}终稿`,
          appliedCheckerIssueIds: ['1'],
          appliedControlSuggestionIds: [],
          unappliedItems: [],
        }),
        usage: { completion: 100 },
      };
    });

    await startContinuationV4Run({
      projectId: 1,
      chapterId: 2,
      targetPosition: 1,
      userInstruction: '推进冲突',
      currentChapterContent: '',
      callStage: callStage as any,
    });

    await waitFor(() => expect(callStage).toHaveBeenCalledTimes(4));
    expect(order[0]).toBe('writer');
    expect(order.slice(1, 3).sort()).toEqual(['checker', 'control']);
    expect(order[3]).toBe('repair');
    expect(callStage.mock.calls.map(call => call[0].responseFormat)).toEqual([
      'text',
      'text',
      'text',
      'text',
    ]);
    expect(rows.filter(row => row.requestCount === 1)).toHaveLength(4);
    expect(rows.reduce((sum, row) => sum + row.requestCount, 0)).toBe(4);
  });

  test('resume with persisted Repair only runs Local Final Gate and never re-requests', async () => {
    const context = makeContext();
    activeRun.state = 'interrupted';
    activeRun.stage = 'auditing';
    activeRun.contextSnapshotJson = JSON.stringify(context.snapshot);
    activeRun.contextTraceJson = JSON.stringify(context.trace);
    const writerText = '这是已经落库的完整 Writer 初稿。'.repeat(100);
    const repairText = `${writerText}终稿`;
    const writerArtifact = {
      id: 'writer-artifact-resume',
      runId: activeRun.id,
      stage: 'writer' as const,
      repairRound: 0,
      parentArtifactId: null,
      content: writerText,
      contentHash: 'writer-hash-resume',
      eligibilityStatus: 'eligible' as const,
      rejectionCode: null,
      createdAt: '2026-08-03T00:00:00.000Z',
    };
    const repairArtifact: any = {
      id: 'repair-artifact-resume',
      runId: activeRun.id,
      stage: 'repair' as const,
      repairRound: 1,
      parentArtifactId: writerArtifact.id,
      content: repairText,
      contentHash: 'repair-hash-resume',
      eligibilityStatus: 'eligible' as const,
      rejectionCode: null,
      createdAt: '2026-08-03T00:01:00.000Z',
    };
    artifacts.push(writerArtifact, repairArtifact);
    rows.push(
      ...[
        ['writer', writerArtifact.id],
        ['checker', null],
        ['control', null],
        ['repair', repairArtifact.id],
      ].map(([stage, artifactId]) => ({
        id: `${stage}-resume-result`,
        runId: activeRun.id,
        stage,
        status: 'success',
        requestReserved: stage !== 'local_verify',
        requestCount: stage === 'local_verify' ? 0 : 1,
        modelConfigId: stage === 'local_verify' ? null : 1,
        inputTokens: stage === 'local_verify' ? null : 100,
        minOutputTokens: stage === 'local_verify' ? null : 20,
        maxOutputTokens: stage === 'local_verify' ? null : 200,
        outputJson: stage === 'repair'
          ? JSON.stringify({ schemaVersion: 1, fullFinal: true })
          : null,
        artifactId,
      })),
      {
        id: 'local-resume-result',
        runId: activeRun.id,
        stage: 'local_verify',
        status: 'queued',
        requestReserved: false,
        requestCount: 0,
        modelConfigId: null,
        inputTokens: null,
        minOutputTokens: null,
        maxOutputTokens: null,
        outputJson: null,
        artifactId: null,
      },
    );
    mockRepository.finalizeContinuationV4LocalGate.mockImplementation(async input => {
      const local = rows.find(row => row.stage === 'local_verify');
      Object.assign(local, {
        status: input.localVerifyStatus || 'success',
        artifactId: input.repairArtifactId,
        outputJson: input.localVerifyOutputJson,
      });
      repairArtifact.eligibilityStatus = input.eligibilityStatus;
      repairArtifact.rejectionCode = input.rejectionCode || null;
      activeRun.state = 'awaiting_user';
      activeRun.stage = 'awaiting_user';
      return { artifact: repairArtifact, localVerifyStageResult: local };
    });
    const callStage = jest.fn(async () => ({ text: '', usage: {} }));

    await resumeContinuationV4Run(activeRun.id, callStage as any);

    expect(callStage).not.toHaveBeenCalled();
    expect(activeRun.state).toBe('awaiting_user');
    expect(rows.find(row => row.stage === 'local_verify')?.status).toBe('failed');
    expect(repairArtifact.eligibilityStatus).toBe('rejected');
    expect(repairArtifact.rejectionCode).toBe('repair_resume_compliance_unavailable');
    expect(rows.reduce((sum, row) => sum + row.requestCount, 0)).toBe(4);
    expect(mockRepository.finalizeContinuationV4LocalGate).toHaveBeenCalledTimes(1);
  });

  test('cancel aborts the shared V4 controller and marks pending stages interrupted', async () => {
    let release: (value: { text: string; usage: Record<string, number> }) => void = () => {};
    const pending = new Promise<{ text: string; usage: Record<string, number> }>(resolve => {
      release = resolve;
    });
    const callStage = jest.fn(async () => pending);

    const run = await startContinuationV4Run({
      projectId: 1,
      chapterId: 2,
      targetPosition: 1,
      userInstruction: '推进冲突',
      currentChapterContent: '',
      callStage: callStage as any,
    });
    await waitFor(() => expect(callStage).toHaveBeenCalledTimes(1));
    await cancelContinuationRun(run.id);
    release({ text: '', usage: {} });

    await waitFor(() => expect(activeRun.state).toBe('cancelled'));
    await waitFor(() =>
      expect(rows.filter(row => row.status === 'interrupted')).toHaveLength(5),
    );
    expect(rows.reduce((sum, row) => sum + row.requestCount, 0)).toBe(1);
  });
});
