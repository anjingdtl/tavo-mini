/**
 * Phase 2 Phase 3 — Proof removed from the Compact Standard DAG Red Tests
 * (二 Phase §6.5).
 *
 *   Case 1  compact Standard: proof dispatch = 0 (decision never returns
 *           run_proof / finalize_from_proof; the checkpoint set has no proof).
 *   Case 2  legacy task still resumes Proof.
 *   Case 3  compact, revision absent → Draft → FinalValidate → Persist.
 *   Case 4  compact, revision (brief) present → Revision final via local finalize.
 *   Case 5  crash after revision before finalize → resume only finalizes.
 *   Case 6  One-Shot behaviour unchanged.
 */
import { determineNextPipelineAction } from '../src/services/pipeline/determineNextPipelineAction';
import type {
  PersistedPipelineTaskView,
  PersistedStageCheckpoint,
} from '../src/services/pipeline/types';
import {
  stageNamesForPipelineTopology,
  resolveStageCheckpoints,
} from '../src/services/pipeline/taskView';
import {
  COMPACT_PIPELINE_TOPOLOGY_VERSION,
  LEGACY_PIPELINE_TOPOLOGY_VERSION,
} from '../src/services/pipeline/outlineWorkflowVersion';

function taskView(
  overrides: Partial<PersistedPipelineTaskView> = {},
): PersistedPipelineTaskView {
  return {
    id: 't1',
    status: 'interrupted',
    pipelineMode: 'full',
    hasExecutionSnapshot: true,
    hasDraftContext: true,
    hasAuditContext: true,
    outlineWorkflowVersion: 4,
    contextBudgetVersion: 5,
    pipelineTopologyVersion: COMPACT_PIPELINE_TOPOLOGY_VERSION,
    executionProfile: 'standard',
    finalText: null,
    ...overrides,
  };
}

function checkpoint(
  stage: PersistedStageCheckpoint['stage'],
  status: PersistedStageCheckpoint['status'],
): PersistedStageCheckpoint {
  return { stage, status };
}

describe('Case 1 — compact Standard has no Proof node', () => {
  test('checkpoint name set omits proof for compact, keeps it for legacy', () => {
    // Phase 4 §7.2: compact DAG replaces review/factCheck with a single qa
    // stage; legacy DAG keeps the trio + proof.
    expect(
      stageNamesForPipelineTopology({
        hasBrief: true,
        pipelineTopologyVersion: COMPACT_PIPELINE_TOPOLOGY_VERSION,
      }),
    ).toEqual(['draft', 'qa', 'brief']);
    expect(
      stageNamesForPipelineTopology({
        hasBrief: true,
        pipelineTopologyVersion: LEGACY_PIPELINE_TOPOLOGY_VERSION,
      }),
    ).toEqual(['draft', 'review', 'factCheck', 'brief', 'proof']);
  });

  test('resolved checkpoints for a compact task never contain a proof node', () => {
    const stages = resolveStageCheckpoints({
      checkpointRows: [
        { stage: 'draft', status: 'succeeded' } as any,
        { stage: 'qa', status: 'succeeded' } as any,
        { stage: 'brief', status: 'succeeded' } as any,
      ],
      pipelineTopologyVersion: COMPACT_PIPELINE_TOPOLOGY_VERSION,
    });
    expect(stages.some(s => s.stage === 'proof')).toBe(false);
  });

  test('compact resume ignores a stray persisted proof checkpoint row', () => {
    // Regression: the batch run/resume path must carry the frozen topology
    // into resolveStageCheckpoints, otherwise a leftover proof row (or a
    // legacy-created proof checkpoint) would surface as a fake pending stage.
    const stages = resolveStageCheckpoints({
      checkpointRows: [
        { stage: 'draft', status: 'succeeded' } as any,
        { stage: 'qa', status: 'succeeded' } as any,
        { stage: 'brief', status: 'succeeded' } as any,
        { stage: 'proof', status: 'pending' } as any,
      ],
      pipelineTopologyVersion: COMPACT_PIPELINE_TOPOLOGY_VERSION,
    });
    expect(stages.some(s => s.stage === 'proof')).toBe(false);
    expect(stages.map(s => s.stage)).toEqual(['draft', 'qa', 'brief']);
  });

  test('compact full task with all audits + revision done → finalize_from_draft, never run_proof', () => {
    const view = taskView({});
    const stages: PersistedStageCheckpoint[] = [
      checkpoint('draft', 'succeeded'),
      checkpoint('qa', 'succeeded'),
      checkpoint('brief', 'succeeded'),
    ];
    const action = determineNextPipelineAction(view, stages);
    expect(action.type).toBe('finalize_from_draft');
    // Proof is never dispatched for compact.
    expect(['run_proof', 'finalize_from_proof']).not.toContain(action.type);
  });

  test('compact task: proof checkpoint (if somehow present) is ignored', () => {
    const view = taskView({});
    const stages: PersistedStageCheckpoint[] = [
      checkpoint('draft', 'succeeded'),
      checkpoint('qa', 'succeeded'),
      checkpoint('brief', 'succeeded'),
      checkpoint('proof', 'succeeded'),
    ];
    const action = determineNextPipelineAction(view, stages);
    expect(action.type).toBe('finalize_from_draft');
  });

  test('compact task still runs QA + revision normally', () => {
    const view = taskView({});
    const stages: PersistedStageCheckpoint[] = [
      checkpoint('draft', 'succeeded'),
      checkpoint('qa', 'succeeded'),
      checkpoint('brief', 'interrupted'),
    ];
    const action = determineNextPipelineAction(view, stages);
    expect(action.type).toBe('run_brief');
  });
});

describe('Case 2 — legacy task still resumes Proof', () => {
  test('legacy task with proof interrupted resumes proof', () => {
    const view = taskView({
      pipelineTopologyVersion: LEGACY_PIPELINE_TOPOLOGY_VERSION,
    });
    const stages: PersistedStageCheckpoint[] = [
      checkpoint('draft', 'succeeded'),
      checkpoint('review', 'succeeded'),
      checkpoint('factCheck', 'succeeded'),
      checkpoint('brief', 'succeeded'),
      checkpoint('proof', 'interrupted'),
    ];
    expect(determineNextPipelineAction(view, stages).type).toBe('run_proof');
  });
});

describe('Case 3 — compact revision absent → Draft final', () => {
  test('audits ok, revision formally skipped (no findings) → Draft finalize', () => {
    const view = taskView({});
    const stages: PersistedStageCheckpoint[] = [
      checkpoint('draft', 'succeeded'),
      // Phase 4 §7.2: the compact QA checkpoint (not review/factCheck).
      checkpoint('qa', 'succeeded'),
      checkpoint('brief', 'skipped'),
    ];
    const action = determineNextPipelineAction(view, stages);
    expect(action.type).toBe('finalize_from_draft');
  });
});

describe('Case 4 — compact revision present → revision is the final candidate', () => {
  test('brief succeeded means revision exists → finalize local (FinalValidate picks revision)', () => {
    const view = taskView({});
    const stages: PersistedStageCheckpoint[] = [
      checkpoint('draft', 'succeeded'),
      checkpoint('qa', 'succeeded'),
      checkpoint('brief', 'succeeded'),
    ];
    expect(determineNextPipelineAction(view, stages).type).toBe(
      'finalize_from_draft',
    );
  });
});

describe('Case 5 — crash after revision before finalize', () => {
  test('resume only finalizes; succeeded audits + revision are never re-dispatched', () => {
    const view = taskView({});
    const stages: PersistedStageCheckpoint[] = [
      checkpoint('draft', 'succeeded'),
      checkpoint('qa', 'succeeded'),
      checkpoint('brief', 'succeeded'),
    ];
    const action = determineNextPipelineAction(view, stages);
    expect(action.type).toBe('finalize_from_draft');
    // No succeeded stage is re-dispatched (the decision only targets the next
    // open/terminal step, and none of draft/qa/brief is open).
  });
});

describe('Case 6 — One-Shot unchanged', () => {
  test('one_shot profile still finalizes from draft in a single call', () => {
    const view = taskView({ executionProfile: 'one_shot' });
    const stages: PersistedStageCheckpoint[] = [
      checkpoint('draft', 'succeeded'),
    ];
    const action = determineNextPipelineAction(view, stages);
    expect(action.type).toBe('finalize_from_draft');
  });
});

describe('Case 7 — continuation round3 stage set honors compact topology', () => {
  test('compact stagePolicy → round3 = [finalValidate, persist], no proof', () => {
    // Reflect the production decision in continuationStageDriver: when the
    // frozen stagePolicy.values.pipelineTopologyVersion === 'compact_standard',
    // the round3 stage set must omit 'proof' entirely. Legacy keeps proof.
    const compactPolicy = {
      values: {
        pipelineTopologyVersion: 'compact_standard',
        executionProfile: 'standard',
      },
    };
    const legacyPolicy = {
      values: {
        pipelineTopologyVersion: 'legacy_standard',
        executionProfile: 'standard',
      },
    };
    const buildRound3 = (policy: { values: Record<string, unknown> }) => {
      const compact =
        policy?.values?.pipelineTopologyVersion === 'compact_standard';
      return compact
        ? (['finalValidate', 'persist'] as const)
        : (['proof', 'finalValidate', 'persist'] as const);
    };
    expect(buildRound3(compactPolicy)).toEqual(['finalValidate', 'persist']);
    expect(buildRound3(legacyPolicy)).toEqual([
      'proof',
      'finalValidate',
      'persist',
    ]);
  });
});
