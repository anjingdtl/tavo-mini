/**
 * Phase 3 ONE Pipeline gates: explicit DAG, conservative QA parallel,
 * conditional Revision, formal skip, Proof remains required on standard.
 */
import {
  CONDITIONAL_PROOF_RULE_ID,
  CONDITIONAL_REVISION_RULE_ID,
  evaluateRuntimeStageSkip,
  hasExecutableFindings,
  nextWritingStageWave,
  readyWritingStages,
  runWritingStages,
  WRITING_STAGE_DAG,
  writingStageDependencies,
} from '../src/services/writing';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { continuationRequest, outlineRequest } from './helpers/oneShotFixtures';
import {
  determineNextPipelineAction,
  type PersistedPipelineTaskView,
  type PersistedStageCheckpoint,
} from '../src/services/pipeline';

function passReport(issue?: string) {
  return JSON.stringify({
    schemaVersion: 1,
    content: issue ? '需要修订' : '通过',
    verdict: issue ? 'needs_revision' : 'pass',
    findings: issue
      ? [{ issue, instruction: '改这一处', target: 'p1', severity: 'blocking' }]
      : [],
  });
}

function freezeOutline(values: Record<string, unknown> = {}) {
  return buildWritingKernelFreezeTrace({
    request: outlineRequest(values),
  });
}

describe('ONE Pipeline DAG', () => {
  test('DAG is explicit: Draft then QA, then Revision, then Proof', () => {
    expect(WRITING_STAGE_DAG.map(node => node.stage)).toEqual([
      'draft',
      'review',
      'audit',
      'factCheck',
      'revision',
      'proof',
      'finalValidate',
      'persist',
    ]);
    expect(writingStageDependencies('review')).toEqual(['draft']);
    expect(writingStageDependencies('factCheck')).toEqual(['draft']);
    expect(writingStageDependencies('revision')).toEqual([
      'draft',
      'review',
      'audit',
      'factCheck',
    ]);
    expect(writingStageDependencies('proof')).toEqual(['revision']);
  });

  test('Review and FactCheck may share a wave; Revision never does', () => {
    const ready = readyWritingStages({
      remaining: ['review', 'factCheck', 'revision'],
      stageOrder: ['review', 'factCheck', 'revision'],
    });
    expect(ready).toEqual(['review', 'factCheck']);
    expect(nextWritingStageWave(ready)).toEqual(['review', 'factCheck']);
    expect(nextWritingStageWave(['review', 'revision'])).toEqual(['review']);
  });
});

describe('Conditional Revision / Proof', () => {
  test('empty findings skip Revision; Proof stays required on standard', () => {
    const noFindings = evaluateRuntimeStageSkip({
      stage: 'revision',
      artifacts: {
        review: {
          stage: 'review',
          body: passReport(),
          structured: { findings: [] },
        },
      },
    });
    expect(noFindings).toMatchObject({
      skip: true,
      policyRuleId: CONDITIONAL_REVISION_RULE_ID,
    });
    expect(
      evaluateRuntimeStageSkip({
        stage: 'proof',
        artifacts: {},
      }),
    ).toEqual({ skip: false });
    expect(
      evaluateRuntimeStageSkip({
        stage: 'proof',
        artifacts: {},
        proofPolicy: 'conditional',
      }),
    ).toMatchObject({
      skip: true,
      policyRuleId: CONDITIONAL_PROOF_RULE_ID,
    });
  });

  test('executable findings keep Revision', () => {
    expect(
      hasExecutableFindings({
        review: {
          stage: 'review',
          body: passReport('结尾没有代价'),
        },
      }),
    ).toBe(true);
    expect(
      evaluateRuntimeStageSkip({
        stage: 'revision',
        artifacts: {
          review: { stage: 'review', body: passReport('结尾没有代价') },
        },
      }),
    ).toEqual({ skip: false });
  });
});

describe('runWritingStages DAG execution', () => {
  test('Outline Draft then Review || FactCheck; empty findings skip Revision; Proof still runs', async () => {
    const { frozenContext, trace } = freezeOutline();
    const started: string[] = [];
    const callStage = jest.fn(async (input: { stage: string }) => {
      started.push(input.stage);
      if (input.stage === 'draft') {
        return { text: '初稿正文。', inputTokens: 1, outputTokens: 1 };
      }
      if (input.stage === 'proof') {
        return { text: '终稿正文。', inputTokens: 1, outputTokens: 1 };
      }
      return { text: passReport(), inputTokens: 1, outputTokens: 1 };
    });
    const results = await runWritingStages({
      frozenContext,
      trace,
      stages: ['draft', 'review', 'factCheck', 'revision', 'proof'],
      callStage: callStage as any,
    });
    expect(started[0]).toBe('draft');
    expect(started.slice(1, 3).sort()).toEqual(['factCheck', 'review']);
    expect(started).not.toContain('revision');
    expect(results.map(result => `${result.stage}:${result.status}`)).toEqual([
      'draft:completed',
      'review:completed',
      'factCheck:completed',
      'revision:skipped',
      'proof:completed',
    ]);
    expect(results[3]).toMatchObject({
      skipReason: expect.any(String),
      policyRuleId: CONDITIONAL_REVISION_RULE_ID,
    });
    expect(callStage.mock.calls.map(call => call[0].stage)).not.toContain(
      'revision',
    );
  });

  test('findings keep Revision as a paid stage', async () => {
    const { frozenContext, trace } = freezeOutline();
    const callStage = jest.fn(async (input: { stage: string }) => {
      if (input.stage === 'draft') {
        return { text: '初稿正文。', inputTokens: 1, outputTokens: 1 };
      }
      if (input.stage === 'review') {
        return { text: passReport('节奏偏慢'), inputTokens: 1, outputTokens: 1 };
      }
      if (input.stage === 'revision') {
        return {
          text: JSON.stringify({
            schemaVersion: 1,
            strategy: 'tighten',
            actions: [],
            preserve: [],
            ending: 'keep',
            content: '修订后正文。',
          }),
          inputTokens: 1,
          outputTokens: 1,
        };
      }
      return { text: passReport(), inputTokens: 1, outputTokens: 1 };
    });
    const results = await runWritingStages({
      frozenContext,
      trace,
      stages: ['draft', 'review', 'revision'],
      callStage: callStage as any,
    });
    expect(results.map(result => `${result.stage}:${result.status}`)).toEqual([
      'draft:completed',
      'review:completed',
      'revision:completed',
    ]);
    expect(callStage.mock.calls.map(call => call[0].stage)).toContain('revision');
  });

  test('One-Shot still pays exactly one draft call', async () => {
    const { frozenContext, trace } = buildWritingKernelFreezeTrace({
      request: continuationRequest({ executionProfile: 'one_shot' }),
    });
    const callStage = jest.fn(async (input: { stage: string }) => {
      if (input.stage !== 'draft') {
        throw new Error(`unexpected paid stage ${input.stage}`);
      }
      return { text: '极速正文。', inputTokens: 1, outputTokens: 1 };
    });
    const results = await runWritingStages({
      frozenContext,
      trace,
      stages: ['draft', 'review', 'audit', 'revision', 'proof'],
      callStage: callStage as any,
    });
    expect(results[0].status).toBe('completed');
    expect(
      results.slice(1).every(result => result.status === 'skipped'),
    ).toBe(true);
    expect(callStage).toHaveBeenCalledTimes(1);
  });
});

describe('Outline brief formal skip is not a failed Brief', () => {
  test('skipped brief proceeds to proof', () => {
    const task = {
      id: 'pt_test',
      status: 'briefing',
      pipelineMode: 'full',
      hasExecutionSnapshot: true,
      hasDraftContext: true,
      hasAuditContext: true,
      finalText: '初稿',
      outlineWorkflowVersion: 3,
      contextBudgetVersion: 3,
      executionProfile: 'standard',
    } as PersistedPipelineTaskView;
    const checkpoints: PersistedStageCheckpoint[] = [
      { stage: 'draft', status: 'succeeded', outputText: 'draft' },
      { stage: 'review', status: 'succeeded', outputText: 'review' },
      { stage: 'factCheck', status: 'succeeded', outputText: 'fc' },
      { stage: 'brief', status: 'skipped', outputText: null },
      { stage: 'proof', status: 'pending', outputText: null },
    ];
    const action = determineNextPipelineAction(task, checkpoints);
    expect(action.type).toBe('run_proof');
  });
});
