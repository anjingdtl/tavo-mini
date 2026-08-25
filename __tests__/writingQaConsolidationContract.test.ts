/**
 * Phase 4 (二 §7) — ONE QA implementation contract.
 *
 * The compact Standard pipeline has exactly one QA implementation. The legacy
 * Review / Audit / FactCheck adapters remain for historical resume, but the
 * active path dispatches only `qa`. Architecture-level invariants:
 *
 *   - Production QA implementation count = 1
 *   - compact DAG = { draft, qa, brief } | { draft, qa }
 *   - compact decision returns `run_qa` for the qa open state
 *   - legacy task resume still goes through run_review / run_fact_check
 *   - run_qa maps to the qa stage in ACTION_STAGES / ACTION_TO_STAGES
 *   - continuation round2 for compact = ['qa', 'revision'] (legacy unchanged)
 */
import {
  COMPACT_PIPELINE_TOPOLOGY_VERSION,
  LEGACY_PIPELINE_TOPOLOGY_VERSION,
} from '../src/services/pipeline/outlineWorkflowVersion';
import { determineNextPipelineAction } from '../src/services/pipeline/determineNextPipelineAction';
import type { PersistedPipelineTaskView, PersistedStageCheckpoint } from '../src/services/pipeline/types';
import {
  COMPACT_WRITING_STAGE_DAG,
  LEGACY_WRITING_STAGE_DAG,
  getWritingStageDagForTopology,
} from '../src/services/writing/stages/writingStageDag';
import { stageNamesForPipelineTopology } from '../src/services/pipeline/taskView';
import { runQaStage } from '../src/services/writing/stages/qa';
import {
  runReviewStage,
  runAuditStage,
  runFactCheckStage,
} from '../src/services/writing/stages';
import {
  compileKernelStageReasoning,
  resolveFrozenStageReasoning,
} from '../src/services/writing/contracts/stageReasoning';

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

describe('Phase 4 — ONE QA Architecture', () => {
  test('runQaStage exists as the production QA implementation', () => {
    expect(typeof runQaStage).toBe('function');
  });

  test('legacy runReviewStage / runAuditStage / runFactCheckStage remain exported (resume)', () => {
    expect(typeof runReviewStage).toBe('function');
    expect(typeof runAuditStage).toBe('function');
    expect(typeof runFactCheckStage).toBe('function');
  });

  test('compact DAG contains a single qa node; no review / audit / factCheck', () => {
    const compactStages = new Set(
      COMPACT_WRITING_STAGE_DAG.map(node => node.stage),
    );
    expect(compactStages.has('qa')).toBe(true);
    expect(compactStages.has('review')).toBe(false);
    expect(compactStages.has('audit')).toBe(false);
    expect(compactStages.has('factCheck')).toBe(false);
    // Phase 3 already dropped proof from compact.
    expect(compactStages.has('proof')).toBe(false);
    // Compact DAG must keep draft + revision + finalize + persist.
    expect(compactStages.has('draft')).toBe(true);
    expect(compactStages.has('revision')).toBe(true);
    expect(compactStages.has('finalValidate')).toBe(true);
    expect(compactStages.has('persist')).toBe(true);
  });

  test('legacy DAG still has the trio review + audit + factCheck', () => {
    const legacyStages = new Set(
      LEGACY_WRITING_STAGE_DAG.map(node => node.stage),
    );
    expect(legacyStages.has('review')).toBe(true);
    expect(legacyStages.has('audit')).toBe(true);
    expect(legacyStages.has('factCheck')).toBe(true);
    expect(legacyStages.has('proof')).toBe(true);
    // Legacy DAG does NOT contain `qa` (it predates Phase 4).
    expect(legacyStages.has('qa')).toBe(false);
  });

  test('getWritingStageDagForTopology selects compact DAG when topology=compact', () => {
    const { nodeByStage } = getWritingStageDagForTopology(
      COMPACT_PIPELINE_TOPOLOGY_VERSION,
    );
    expect(nodeByStage.has('qa')).toBe(true);
    expect(nodeByStage.has('review')).toBe(false);
  });

  test('getWritingStageDagForTopology selects legacy DAG when topology=legacy', () => {
    const { nodeByStage } = getWritingStageDagForTopology(
      LEGACY_PIPELINE_TOPOLOGY_VERSION,
    );
    expect(nodeByStage.has('review')).toBe(true);
    expect(nodeByStage.has('qa')).toBe(false);
  });

  test('kernel-freeze label string normalizes to the same topology (regression)', () => {
    // The durable columns persist numeric 1|2, but the kernel freeze writes
    // the STRING label into stagePolicy.values. Both must resolve to the
    // same DAG — otherwise a compact task resumed through the shared writer
    // consults the LEGACY DAG and deadlocks on `qa` (WRITING_STAGE_DAG_DEADLOCK).
    const { nodeByStage: compactLabel } = getWritingStageDagForTopology(
      'compact_standard',
    );
    expect(compactLabel.has('qa')).toBe(true);
    expect(compactLabel.has('review')).toBe(false);
    const { nodeByStage: legacyLabel } = getWritingStageDagForTopology(
      'legacy_standard',
    );
    expect(legacyLabel.has('review')).toBe(true);
    expect(legacyLabel.has('qa')).toBe(false);
    // Numeric + label forms must be interchangeable for the same topology.
    const { nodeByStage: compactNumber } = getWritingStageDagForTopology(
      COMPACT_PIPELINE_TOPOLOGY_VERSION,
    );
    expect(compactNumber.has('qa')).toBe(compactLabel.has('qa'));
  });
});

describe('Phase 4 — QA model behavior is frozen (§7.7)', () => {
  test('compileKernelStageReasoning covers qa (freeze-time + runtime table)', () => {
    const table = compileKernelStageReasoning({
      scenario: 'outline',
      modelName: 'model-a',
      requestedEffort: 'high',
    });
    expect(table.qa).toBeDefined();
    expect(table.qa.thinking.type).toBe('enabled');
    // QA is a structured report stage like factCheck/audit → low effort.
    expect(table.qa.reasoningEffort).toBe('low');
  });

  test('resolveFrozenStageReasoning(qa) never returns undefined (regression)', () => {
    // Bug found during Phase 4 hand-over: LLM_STAGES omitted `qa`, so
    // resolveFrozenStageReasoning('qa') was undefined and the shared writer
    // threw "Cannot read properties of undefined (reading 'thinking')".
    const reasoning = resolveFrozenStageReasoning('qa', {
      stagePolicy: { values: {} },
      modelConfig: {
        modelName: 'model-a',
        reasoningEffort: 'high',
        thinking: { type: 'enabled' },
      },
    });
    expect(reasoning).toBeDefined();
    expect(reasoning.thinking).toBeDefined();
  });
});

describe('Phase 4 — compact decision dispatches run_qa, not run_review', () => {
  test('compact: draft succeeded, qa open → run_qa', () => {
    const view = taskView({});
    const stages: PersistedStageCheckpoint[] = [
      checkpoint('draft', 'succeeded'),
      checkpoint('qa', 'pending'),
    ];
    const action = determineNextPipelineAction(view, stages);
    expect(action.type).toBe('run_qa');
  });

  test('compact: qa succeeded, brief open → run_brief (Conditional Revision)', () => {
    const view = taskView({});
    const stages: PersistedStageCheckpoint[] = [
      checkpoint('draft', 'succeeded'),
      checkpoint('qa', 'succeeded'),
      checkpoint('brief', 'pending'),
    ];
    expect(determineNextPipelineAction(view, stages).type).toBe('run_brief');
  });

  test('compact: qa + brief succeeded, no finalText → finalize_from_draft', () => {
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

  test('compact: stray proof checkpoint is ignored; resume only finalizes', () => {
    const view = taskView({});
    const stages: PersistedStageCheckpoint[] = [
      checkpoint('draft', 'succeeded'),
      checkpoint('qa', 'succeeded'),
      checkpoint('brief', 'succeeded'),
      // Phase 3 §6.5: a leftover proof row from a legacy batch must be
      // ignored for compact topology.
      checkpoint('proof', 'interrupted'),
    ];
    expect(determineNextPipelineAction(view, stages).type).toBe(
      'finalize_from_draft',
    );
  });

  test('compact: stray review / factCheck checkpoints are ignored', () => {
    const view = taskView({});
    const stages: PersistedStageCheckpoint[] = [
      checkpoint('draft', 'succeeded'),
      checkpoint('qa', 'succeeded'),
      checkpoint('brief', 'succeeded'),
      checkpoint('review', 'interrupted'),
      checkpoint('factCheck', 'interrupted'),
    ];
    expect(determineNextPipelineAction(view, stages).type).toBe(
      'finalize_from_draft',
    );
  });
});

describe('Phase 4 — legacy topology fails closed post-release', () => {
  test('legacy: legacy DAG task is blocked for recreation, never dispatches run_review', () => {
    const view = taskView({
      pipelineTopologyVersion: LEGACY_PIPELINE_TOPOLOGY_VERSION,
    });
    const stages: PersistedStageCheckpoint[] = [
      checkpoint('draft', 'succeeded'),
      checkpoint('review', 'interrupted'),
      checkpoint('factCheck', 'succeeded'),
      checkpoint('brief', 'succeeded'),
      checkpoint('proof', 'succeeded'),
    ];
    const action = determineNextPipelineAction(view, stages);
    expect(action.type).toBe('blocked');
    if (action.type === 'blocked') {
      expect(action.reason.code).toBe('LEGACY_PIPELINE_BLOCKED');
    }
  });

  test('legacy: long review/factCheck chains never dispatch run_fact_check', () => {
    const view = taskView({
      pipelineTopologyVersion: LEGACY_PIPELINE_TOPOLOGY_VERSION,
    });
    const stages: PersistedStageCheckpoint[] = [
      checkpoint('draft', 'succeeded'),
      checkpoint('review', 'succeeded'),
      checkpoint('factCheck', 'interrupted'),
      checkpoint('brief', 'succeeded'),
      checkpoint('proof', 'succeeded'),
    ];
    const action = determineNextPipelineAction(view, stages);
    expect(action.type).toBe('blocked');
    if (action.type === 'blocked') {
      expect(action.reason.code).toBe('LEGACY_PIPELINE_BLOCKED');
    }
  });
});

describe('Phase 4 — checkpoint name set is topology-aware', () => {
  test('compact: stageNamesForPipelineTopology returns {draft, qa, brief}', () => {
    expect(
      stageNamesForPipelineTopology({
        hasBrief: true,
        pipelineTopologyVersion: COMPACT_PIPELINE_TOPOLOGY_VERSION,
      }),
    ).toEqual(['draft', 'qa', 'brief']);
  });

  test('compact: no-brief variant returns {draft, qa}', () => {
    expect(
      stageNamesForPipelineTopology({
        hasBrief: false,
        pipelineTopologyVersion: COMPACT_PIPELINE_TOPOLOGY_VERSION,
      }),
    ).toEqual(['draft', 'qa']);
  });

  test('legacy: stageNamesForPipelineTopology returns {draft, review, factCheck, brief, proof}', () => {
    expect(
      stageNamesForPipelineTopology({
        hasBrief: true,
        pipelineTopologyVersion: LEGACY_PIPELINE_TOPOLOGY_VERSION,
      }),
    ).toEqual(['draft', 'review', 'factCheck', 'brief', 'proof']);
  });
});