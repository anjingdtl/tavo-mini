/**
 * Fault-injection matrix for durable pipeline state machine.
 *
 * Each case freezes a persisted task+checkpoint snapshot as if the process
 * died at that boundary, then asserts determineNextPipelineAction never
 * re-runs a succeeded LLM stage. Compact topology only (unified pipeline).
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
  return (['draft', 'qa', 'brief'] as const).map(stage => ({
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
    pipelineTopologyVersion: 2,
    hasExecutionSnapshot: true,
    hasDraftContext: true,
    hasAuditContext: true,
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
  never: string[];
}> = [
  {
    name: 'die before snapshot',
    mode: 'full',
    map: {},
    expect: 'blocked',
    never: ['run_draft'],
  },
  {
    name: 'die after draft success before qa',
    mode: 'full',
    map: { draft: 'succeeded' },
    expect: 'run_qa',
    never: ['run_draft'],
  },
  {
    name: 'die after qa success before brief',
    mode: 'full',
    map: { draft: 'succeeded', qa: 'succeeded' },
    expect: 'run_brief',
    never: ['run_draft', 'run_qa'],
  },
  {
    name: 'die after brief success before final text',
    mode: 'full',
    map: { draft: 'succeeded', qa: 'succeeded', brief: 'succeeded' },
    expect: 'finalize_from_draft',
    never: ['run_brief', 'run_draft', 'run_qa'],
  },
  {
    name: 'die after final text before complete',
    mode: 'full',
    map: { draft: 'succeeded', qa: 'succeeded', brief: 'succeeded' },
    finalText: 'done',
    expect: 'complete',
    never: ['run_brief', 'finalize_from_draft'],
  },
  {
    name: 'die with running stage (another executor)',
    mode: 'full',
    map: { draft: 'succeeded', qa: 'running' },
    expect: 'blocked',
    never: ['run_qa'],
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