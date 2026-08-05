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
    'review',
    'factCheck',
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

describe('determineNextPipelineAction — noReview', () => {
  const mode = 'noReview' as const;

  test('draft succeeded → finalize_from_draft', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: mode, status: 'drafting' }),
      stages({ draft: 'succeeded' }),
    );
    expect(a).toEqual({ type: 'finalize_from_draft' });
  });

  test('finalText present, not completed → complete', () => {
    const a = determineNextPipelineAction(
      task({
        pipelineMode: mode,
        status: 'drafting',
        finalText: 'body',
      }),
      stages({ draft: 'succeeded' }),
    );
    expect(actionType(a)).toBe('complete');
  });
});

describe('determineNextPipelineAction — twoStage', () => {
  const mode = 'twoStage' as const;

  test('draft ok, review pending → run_review', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: mode, status: 'reviewing' }),
      stages({ draft: 'succeeded', review: 'pending' }),
    );
    expect(actionType(a)).toBe('run_review');
  });

  test('review interrupted → run_review (no re-draft)', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: mode, status: 'interrupted' }),
      stages({ draft: 'succeeded', review: 'interrupted' }),
    );
    expect(actionType(a)).toBe('run_review');
  });

  test('review failed → finalize_from_draft degraded', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: mode, status: 'failed' }),
      stages({ draft: 'succeeded', review: 'failed' }),
    );
    expect(a).toEqual({ type: 'finalize_from_draft', degraded: true });
  });

  test('review succeeded, proof pending → run_proof', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: mode, status: 'proofing' }),
      stages({
        draft: 'succeeded',
        review: 'succeeded',
        proof: 'pending',
      }),
    );
    expect(actionType(a)).toBe('run_proof');
  });

  test('PROOF SUCCEEDED without final → finalize_from_proof (never re-proof)', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: mode, status: 'proofing' }),
      stages({
        draft: 'succeeded',
        review: 'succeeded',
        proof: 'succeeded',
      }),
    );
    expect(actionType(a)).toBe('finalize_from_proof');
    expect(actionType(a)).not.toBe('run_proof');
  });

  test('proof succeeded + finalText, status not completed → complete', () => {
    const a = determineNextPipelineAction(
      task({
        pipelineMode: mode,
        status: 'proofing',
        finalText: 'polished',
      }),
      stages({
        draft: 'succeeded',
        review: 'succeeded',
        proof: 'succeeded',
      }),
    );
    expect(actionType(a)).toBe('complete');
  });

  test('proof failed → finalize_from_draft degraded', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: mode, status: 'failed' }),
      stages({
        draft: 'succeeded',
        review: 'succeeded',
        proof: 'failed',
      }),
    );
    expect(a).toEqual({ type: 'finalize_from_draft', degraded: true });
  });
});

describe('determineNextPipelineAction — conditional', () => {
  const mode = 'conditional' as const;

  test('draft ok → run_fact_check', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: mode }),
      stages({ draft: 'succeeded', factCheck: 'pending' }),
    );
    expect(actionType(a)).toBe('run_fact_check');
  });

  test('factCheck succeeded → run_proof', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: mode }),
      stages({
        draft: 'succeeded',
        factCheck: 'succeeded',
        proof: 'pending',
      }),
    );
    expect(actionType(a)).toBe('run_proof');
  });

  test('proof succeeded only finalize', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: mode, status: 'interrupted' }),
      stages({
        draft: 'succeeded',
        factCheck: 'succeeded',
        proof: 'succeeded',
      }),
    );
    expect(actionType(a)).toBe('finalize_from_proof');
  });
});

describe('determineNextPipelineAction — full', () => {
  const mode = 'full' as const;

  test('draft ok, no auditContext → build_audit_context', () => {
    const a = determineNextPipelineAction(
      task({
        pipelineMode: mode,
        hasAuditContext: false,
        status: 'reviewing',
      }),
      stages({ draft: 'succeeded' }),
    );
    expect(actionType(a)).toBe('build_audit_context');
  });

  test('audit ready, both open → run_review_and_fact_check', () => {
    const a = determineNextPipelineAction(
      task({
        pipelineMode: mode,
        hasAuditContext: true,
      }),
      stages({
        draft: 'succeeded',
        review: 'pending',
        factCheck: 'pending',
      }),
    );
    expect(actionType(a)).toBe('run_review_and_fact_check');
  });

  test('only review missing → run_review', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: mode, hasAuditContext: true }),
      stages({
        draft: 'succeeded',
        review: 'interrupted',
        factCheck: 'succeeded',
      }),
    );
    expect(actionType(a)).toBe('run_review');
  });

  test('only factCheck missing → run_fact_check', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: mode, hasAuditContext: true }),
      stages({
        draft: 'succeeded',
        review: 'succeeded',
        factCheck: 'pending',
      }),
    );
    expect(actionType(a)).toBe('run_fact_check');
  });

  test('both audits failed → finalize_from_draft degraded', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: mode, hasAuditContext: true }),
      stages({
        draft: 'succeeded',
        review: 'failed',
        factCheck: 'failed',
      }),
    );
    expect(a).toEqual({ type: 'finalize_from_draft', degraded: true });
  });

  test('one audit ok → run_proof', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: mode, hasAuditContext: true }),
      stages({
        draft: 'succeeded',
        review: 'succeeded',
        factCheck: 'failed',
        proof: 'pending',
      }),
    );
    expect(actionType(a)).toBe('run_proof');
  });

  test('PROOF SUCCEEDED after full path → finalize_from_proof only', () => {
    const a = determineNextPipelineAction(
      task({
        pipelineMode: mode,
        hasAuditContext: true,
        status: 'interrupted',
      }),
      stages({
        draft: 'succeeded',
        review: 'succeeded',
        factCheck: 'succeeded',
        proof: 'succeeded',
      }),
    );
    expect(actionType(a)).toBe('finalize_from_proof');
  });

  test('finalText after proof, status not completed → complete', () => {
    const a = determineNextPipelineAction(
      task({
        pipelineMode: mode,
        hasAuditContext: true,
        status: 'proofing',
        finalText: 'done body',
      }),
      stages({
        draft: 'succeeded',
        review: 'succeeded',
        factCheck: 'succeeded',
        proof: 'succeeded',
      }),
    );
    expect(actionType(a)).toBe('complete');
  });
});

describe('determineNextPipelineAction — recovery matrix (no re-LLM of succeeded)', () => {
  const cases: Array<{
    name: string;
    mode: PipelineMode;
    map: Partial<Record<PipelineStageName, StageStatus>>;
    hasAudit?: boolean;
    finalText?: string | null;
    status?: string;
    expect: PipelineAction['type'];
  }> = [
    {
      name: 'twoStage: stop after draft success',
      mode: 'twoStage',
      map: { draft: 'succeeded' },
      expect: 'run_review',
    },
    {
      name: 'twoStage: stop after review success',
      mode: 'twoStage',
      map: { draft: 'succeeded', review: 'succeeded' },
      expect: 'run_proof',
    },
    {
      name: 'twoStage: stop after proof success',
      mode: 'twoStage',
      map: {
        draft: 'succeeded',
        review: 'succeeded',
        proof: 'succeeded',
      },
      expect: 'finalize_from_proof',
    },
    {
      name: 'twoStage: stop after final text save',
      mode: 'twoStage',
      map: {
        draft: 'succeeded',
        review: 'succeeded',
        proof: 'succeeded',
      },
      finalText: 'x',
      status: 'proofing',
      expect: 'complete',
    },
    {
      name: 'full: stop after draft before audit',
      mode: 'full',
      map: { draft: 'succeeded' },
      hasAudit: false,
      expect: 'build_audit_context',
    },
    {
      name: 'full: stop after audit context',
      mode: 'full',
      map: { draft: 'succeeded' },
      hasAudit: true,
      expect: 'run_review_and_fact_check',
    },
    {
      name: 'noReview: never re-draft',
      mode: 'noReview',
      map: { draft: 'succeeded' },
      expect: 'finalize_from_draft',
    },
    {
      name: 'conditional: never re-draft after factCheck',
      mode: 'conditional',
      map: { draft: 'succeeded', factCheck: 'succeeded' },
      expect: 'run_proof',
    },
  ];

  test.each(cases)('$name → $expect', c => {
    const a = determineNextPipelineAction(
      task({
        pipelineMode: c.mode,
        hasAuditContext: c.hasAudit ?? c.mode !== 'full',
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
      review: 'succeeded',
      proof: 'pending',
    });
    const first = determineNextPipelineAction(
      task({ pipelineMode: 'twoStage', status: 'proofing' }),
      s,
    );
    const resume = determineNextPipelineAction(
      task({ pipelineMode: 'twoStage', status: 'interrupted' }),
      s,
    );
    expect(first).toEqual(resume);
    expect(actionType(first)).toBe('run_proof');
  });
});
