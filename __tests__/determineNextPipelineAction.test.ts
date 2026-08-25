/**
 * Decision-table tests for determineNextPipelineAction.
 *
 * These lock the single state-machine plan shared by first-run and resume.
 * No runner / SQLite side effects.
 */
import {
  determineNextPipelineAction,
  projectStageResultsToCheckpoints,
  type PersistedPipelineTaskView,
  type PersistedStageCheckpoint,
  type PipelineAction,
  type StageStatus,
} from '../src/services/pipeline';
import type { PipelineMode, PipelineStageName } from '../src/types/pipeline';

function stage(
  name: PipelineStageName,
  status: StageStatus,
  outputText: string | null = status === 'succeeded' ? `${name}-out` : null,
): PersistedStageCheckpoint {
  return { stage: name, status, outputText };
}

function stages(
  map: Partial<Record<PipelineStageName, StageStatus>>,
): PersistedStageCheckpoint[] {
  const names: PipelineStageName[] = [
    'draft',
    'qa',
    'review',
    'factCheck',
    'brief',
    'proof',
  ];
  return names.map(n => stage(n, map[n] || 'pending'));
}

function task(
  overrides: Partial<PersistedPipelineTaskView> & {
    pipelineMode: PipelineMode | null;
  },
): PersistedPipelineTaskView {
  return {
    id: 'pt_test',
    status: 'drafting',
    hasExecutionSnapshot: true,
    hasDraftContext: true,
    hasAuditContext: false,
    finalText: null,
    pipelineTopologyVersion: 2,
    ...overrides,
  };
}

function actionType(a: PipelineAction): string {
  return a.type;
}

describe('projectStageResultsToCheckpoints', () => {
  test('collapses append-only results; prefers succeeded over failed', () => {
    const projected = projectStageResultsToCheckpoints([
      { stage: 'draft', status: 'failed', text: '', error: 'boom' },
      { stage: 'draft', status: 'success', text: 'ok' },
      { stage: 'review', status: 'skipped', text: 'skip' },
    ]);
    expect(projected.find(s => s.stage === 'draft')?.status).toBe('succeeded');
    expect(projected.find(s => s.stage === 'draft')?.outputText).toBe('ok');
    expect(projected.find(s => s.stage === 'review')?.status).toBe('skipped');
    expect(projected.find(s => s.stage === 'factCheck')?.status).toBe(
      'pending',
    );
  });

  test('preserves a stage error code for recovery planning', () => {
    const projected = projectStageResultsToCheckpoints([
      {
        stage: 'proof',
        status: 'failed',
        text: '',
        error: '终稿失败',
        errorCode: 'FINAL_PROOF_RETRY_REQUIRED',
      },
    ]);
    expect(projected.find(s => s.stage === 'proof')?.errorCode).toBe(
      'FINAL_PROOF_RETRY_REQUIRED',
    );
  });
});

describe('determineNextPipelineAction — terminal / concurrency', () => {
  test('cancelled → blocked TASK_TERMINAL', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: 'twoStage', status: 'cancelled' }),
      stages({ draft: 'succeeded' }),
    );
    expect(a).toMatchObject({
      type: 'blocked',
      reason: { code: 'TASK_TERMINAL' },
    });
  });

  test('completed → blocked TASK_TERMINAL', () => {
    const a = determineNextPipelineAction(
      task({
        pipelineMode: 'noReview',
        status: 'completed',
        finalText: 'done',
      }),
      stages({ draft: 'succeeded' }),
    );
    expect(a).toMatchObject({
      type: 'blocked',
      reason: { code: 'TASK_TERMINAL' },
    });
  });

  test('any stage running → TASK_ALREADY_RUNNING', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: 'twoStage', status: 'reviewing' }),
      stages({ draft: 'succeeded', review: 'running' }),
    );
    expect(a).toMatchObject({
      type: 'blocked',
      reason: { code: 'TASK_ALREADY_RUNNING', stage: 'review' },
    });
  });
});

describe('determineNextPipelineAction — snapshot gate', () => {
  test('missing execution or draft context → persist_initial_snapshot (fresh)', () => {
    const a = determineNextPipelineAction(
      task({
        pipelineMode: null,
        status: 'idle',
        hasExecutionSnapshot: false,
        hasDraftContext: false,
      }),
      stages({}),
    );
    expect(actionType(a)).toBe('persist_initial_snapshot');
  });

  test('interrupted without snapshot → TASK_NOT_RECOVERABLE', () => {
    const a = determineNextPipelineAction(
      task({
        pipelineMode: null,
        status: 'interrupted',
        hasExecutionSnapshot: false,
        hasDraftContext: false,
      }),
      stages({}),
    );
    expect(a).toMatchObject({
      type: 'blocked',
      reason: { code: 'TASK_NOT_RECOVERABLE' },
    });
  });
});

describe('determineNextPipelineAction — draft', () => {
  test('draft pending → run_draft', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: 'full', status: 'drafting' }),
      stages({ draft: 'pending' }),
    );
    expect(actionType(a)).toBe('run_draft');
  });

  test('draft interrupted → run_draft (resume)', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: 'full', status: 'interrupted' }),
      stages({ draft: 'interrupted' }),
    );
    expect(actionType(a)).toBe('run_draft');
  });

  test('draft failed → blocked STAGE_FAILED', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: 'twoStage', status: 'failed' }),
      [
        {
          stage: 'draft',
          status: 'failed',
          errorMessage: 'timeout',
          outputText: null,
        },
        stage('review', 'pending'),
        stage('factCheck', 'pending'),
        stage('proof', 'pending'),
      ],
    );
    expect(a).toMatchObject({
      type: 'blocked',
      reason: { code: 'STAGE_FAILED', stage: 'draft' },
    });
  });
});


describe('determineNextPipelineAction — recovery matrix (no re-LLM of succeeded)', () => {
  const cases: Array<{
    name: string;
    map: Partial<Record<PipelineStageName, StageStatus>>;
    finalText?: string | null;
    status?: string;
    expect: PipelineAction['type'];
  }> = [
    {
      name: 'compact: stop after draft success → run_qa',
      map: { draft: 'succeeded' },
      expect: 'run_qa',
    },
    {
      name: 'compact: stop after qa success → run_brief',
      map: { draft: 'succeeded', qa: 'succeeded' },
      expect: 'run_brief',
    },
    {
      name: 'compact: stop after brief success → finalize_from_draft',
      map: { draft: 'succeeded', qa: 'succeeded', brief: 'succeeded' },
      expect: 'finalize_from_draft',
    },
    {
      name: 'compact: stop after final text save → complete',
      map: { draft: 'succeeded', qa: 'succeeded', brief: 'succeeded' },
      finalText: 'x',
      status: 'briefing',
      expect: 'complete',
    },
    {
      name: 'compact: formally skipped qa → draft is final',
      map: { draft: 'succeeded', qa: 'skipped' },
      expect: 'finalize_from_draft',
    },
    {
      name: 'compact: qa failure stays blocked, never degrades to draft',
      map: { draft: 'succeeded', qa: 'failed' },
      expect: 'blocked',
    },
  ];

  test.each(cases)('$name → $expect', c => {
    const a = determineNextPipelineAction(
      task({
        pipelineMode: 'full',
        finalText: c.finalText ?? null,
        status: c.status || 'interrupted',
      }),
      stages(c.map),
    );
    expect(actionType(a)).toBe(c.expect);
  });
});

describe('determineNextPipelineAction — first-run and resume share plan', () => {
  test('identical durable state yields identical action regardless of task.status label', () => {
    const s = stages({
      draft: 'succeeded',
      qa: 'succeeded',
      brief: 'pending',
    });
    const first = determineNextPipelineAction(
      task({ pipelineMode: 'full', status: 'briefing' }),
      s,
    );
    const resume = determineNextPipelineAction(
      task({ pipelineMode: 'full', status: 'interrupted' }),
      s,
    );
    expect(first).toEqual(resume);
    expect(actionType(first)).toBe('run_brief');
  });
});
