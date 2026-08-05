/**
 * Fault-injection matrix for durable pipeline state machine.
 *
 * Each case freezes a persisted task+checkpoint snapshot as if the process
 * died at that boundary, then asserts determineNextPipelineAction never
 * re-runs a succeeded LLM stage.
 */
import {
  determineNextPipelineAction,
  type PersistedPipelineTaskView,
  type PersistedStageCheckpoint,
  type StageStatus,
} from '../src/services/pipeline';
import type { PipelineMode, PipelineStageName } from '../src/types/pipeline';

function stages(
  map: Partial<Record<PipelineStageName, StageStatus>>,
): PersistedStageCheckpoint[] {
  return (['draft', 'review', 'factCheck', 'proof'] as const).map(stage => ({
    stage,
    status: map[stage] || 'pending',
    outputText: map[stage] === 'succeeded' ? `${stage}-out` : null,
  }));
}

function task(
  mode: PipelineMode,
  overrides: Partial<PersistedPipelineTaskView> = {},
): PersistedPipelineTaskView {
  return {
    id: 'fault',
    status: 'interrupted',
    pipelineMode: mode,
    hasExecutionSnapshot: true,
    hasDraftContext: true,
    hasAuditContext: mode === 'full',
    finalText: null,
    ...overrides,
  };
}

const matrix: Array<{
  name: string;
  mode: PipelineMode;
  map: Partial<Record<PipelineStageName, StageStatus>>;
  hasAudit?: boolean;
  finalText?: string | null;
  expect: string;
  never?: string[];
}> = [
  {
    name: 'die before snapshot',
    mode: 'twoStage',
    map: {},
    // no snapshot flags
    expect: 'blocked',
    never: ['run_draft', 'run_review', 'run_proof'],
  },
  {
    name: 'die after snapshot before draft LLM',
    mode: 'twoStage',
    map: { draft: 'pending' },
    expect: 'run_draft',
    never: ['run_review', 'run_proof'],
  },
  {
    name: 'die after draft LLM before checkpoint',
    mode: 'twoStage',
    map: { draft: 'interrupted' },
    expect: 'run_draft',
  },
  {
    name: 'die after draft checkpoint',
    mode: 'twoStage',
    map: { draft: 'succeeded' },
    expect: 'run_review',
    never: ['run_draft'],
  },
  {
    name: 'die after audit context (full)',
    mode: 'full',
    map: { draft: 'succeeded' },
    hasAudit: true,
    expect: 'run_review_and_fact_check',
    never: ['run_draft', 'build_audit_context'],
  },
  {
    name: 'die after review success before proof',
    mode: 'twoStage',
    map: { draft: 'succeeded', review: 'succeeded' },
    expect: 'run_proof',
    never: ['run_draft', 'run_review'],
  },
  {
    name: 'die after factCheck success',
    mode: 'conditional',
    map: { draft: 'succeeded', factCheck: 'succeeded' },
    expect: 'run_proof',
    never: ['run_draft', 'run_fact_check'],
  },
  {
    name: 'die after proof success before final text',
    mode: 'twoStage',
    map: {
      draft: 'succeeded',
      review: 'succeeded',
      proof: 'succeeded',
    },
    expect: 'finalize_from_proof',
    never: ['run_proof', 'run_draft', 'run_review'],
  },
  {
    name: 'die after final text before complete',
    mode: 'twoStage',
    map: {
      draft: 'succeeded',
      review: 'succeeded',
      proof: 'succeeded',
    },
    finalText: 'done',
    expect: 'complete',
    never: ['run_proof', 'finalize_from_proof'],
  },
  {
    name: 'die with running stage (another executor)',
    mode: 'twoStage',
    map: { draft: 'succeeded', review: 'running' },
    expect: 'blocked',
    never: ['run_review'],
  },
];

describe('pipeline fault injection matrix', () => {
  test.each(matrix)('$name → $expect', c => {
    const view =
      c.name === 'die before snapshot'
        ? task(c.mode, {
            hasExecutionSnapshot: false,
            hasDraftContext: false,
            pipelineMode: null,
            status: 'interrupted',
          })
        : task(c.mode, {
            hasAuditContext: c.hasAudit ?? c.mode === 'full',
            finalText: c.finalText ?? null,
          });

    // Special case for die before snapshot blocked
    if (c.name === 'die before snapshot') {
      const a = determineNextPipelineAction(view, stages(c.map));
      expect(a.type).toBe('blocked');
      if (a.type === 'blocked') {
        expect(a.reason.code).toBe('TASK_NOT_RECOVERABLE');
      }
      return;
    }

    const a = determineNextPipelineAction(view, stages(c.map));
    expect(a.type).toBe(c.expect);
    for (const n of c.never || []) {
      expect(a.type).not.toBe(n);
    }
  });
});
