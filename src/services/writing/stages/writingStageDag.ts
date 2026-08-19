/**
 * Explicit production Stage DAG.
 *
 * Stage arrays on drivers are execution batches, not the dependency source.
 * Revision never runs in the same wave as Review / Audit / FactCheck.
 */
import type { SharedWritingStageName } from '../contracts/writingPolicy';
import { isCompactPipelineTopology } from '../../pipeline/outlineWorkflowVersion';

export interface WritingStageDagNode {
  stage: SharedWritingStageName;
  dependsOn: SharedWritingStageName[];
  parallelGroup: 'qa' | null;
}

/**
 * Legacy Standard topology (二 Phase §6/§7): Review/Audit/FactCheck are three
 * independent QA checks that may run as a parallel wave, then Revision, then
 * FinalValidate / Persist. Proof is part of the legacy DAG.
 *
 * Kept as the historical production DAG so legacy tasks / legacy resume
 * continue to honor the same dependency graph.
 */
export const LEGACY_WRITING_STAGE_DAG: readonly WritingStageDagNode[] = [
  { stage: 'draft', dependsOn: [], parallelGroup: null },
  { stage: 'review', dependsOn: ['draft'], parallelGroup: 'qa' },
  { stage: 'audit', dependsOn: ['draft'], parallelGroup: 'qa' },
  { stage: 'factCheck', dependsOn: ['draft'], parallelGroup: 'qa' },
  {
    stage: 'revision',
    dependsOn: ['draft', 'review', 'audit', 'factCheck'],
    parallelGroup: null,
  },
  { stage: 'proof', dependsOn: ['revision'], parallelGroup: null },
  { stage: 'finalValidate', dependsOn: ['proof'], parallelGroup: null },
  { stage: 'persist', dependsOn: ['finalValidate'], parallelGroup: null },
];

/**
 * Compact Standard topology (二 Phase §6/§7): one unified `qa` stage replaces
 * Review/Audit/FactCheck (Phase 4 §7.2 ONE QA). Revision only depends on `qa`
 * (Phase 4 §7.9). Proof is removed from the compact DAG (Phase 3 §6.2).
 */
export const COMPACT_WRITING_STAGE_DAG: readonly WritingStageDagNode[] = [
  { stage: 'draft', dependsOn: [], parallelGroup: null },
  { stage: 'qa', dependsOn: ['draft'], parallelGroup: null },
  { stage: 'revision', dependsOn: ['draft', 'qa'], parallelGroup: null },
  { stage: 'finalValidate', dependsOn: ['revision'], parallelGroup: null },
  { stage: 'persist', dependsOn: ['finalValidate'], parallelGroup: null },
];

/**
 * Back-compat alias. Always returns the LEGACY DAG — callers that want the
 * topology-aware DAG MUST use `getWritingStageDagForTopology()`. Kept so the
 * `WRITING_STAGE_DAG` constant consumers in tests / `writingStageDagNode`
 * still validate the legacy graph.
 */
export const WRITING_STAGE_DAG: readonly WritingStageDagNode[] =
  LEGACY_WRITING_STAGE_DAG;

const COMPACT_NODE_BY_STAGE = new Map(
  COMPACT_WRITING_STAGE_DAG.map(node => [node.stage, node]),
);
const LEGACY_NODE_BY_STAGE = new Map(
  LEGACY_WRITING_STAGE_DAG.map(node => [node.stage, node]),
);

/**
 * Topology-aware DAG lookup. Compact tasks consult ONLY the compact DAG
 * (which has `qa` but NOT `review/audit/factCheck/proof`). Legacy tasks /
 * legacy resume consult the legacy DAG.
 */
export function getWritingStageDagForTopology(
  pipelineTopologyVersion: unknown,
): { nodes: readonly WritingStageDagNode[]; nodeByStage: Map<SharedWritingStageName, WritingStageDagNode> } {
  if (isCompactPipelineTopology(pipelineTopologyVersion)) {
    return {
      nodes: COMPACT_WRITING_STAGE_DAG,
      nodeByStage: COMPACT_NODE_BY_STAGE,
    };
  }
  return {
    nodes: LEGACY_WRITING_STAGE_DAG,
    nodeByStage: LEGACY_NODE_BY_STAGE,
  };
}

export function writingStageDagNode(
  stage: SharedWritingStageName,
): WritingStageDagNode {
  // Back-compat: the untyped overload always consults the LEGACY DAG first
  // so historical callers (and tests) keep observing the pre-Phase-4
  // dependency graph. Topology-aware callers MUST use
  // writingStageDagNodeForTopology(stage, pipelineTopologyVersion).
  const legacyNode = LEGACY_NODE_BY_STAGE.get(stage);
  if (legacyNode) return legacyNode;
  const compactNode = COMPACT_NODE_BY_STAGE.get(stage);
  if (compactNode) return compactNode;
  throw new Error(`Unknown writing stage in DAG: ${stage}`);
}

export function writingStageDagNodeForTopology(
  stage: SharedWritingStageName,
  pipelineTopologyVersion: unknown,
): WritingStageDagNode {
  const { nodeByStage } = getWritingStageDagForTopology(pipelineTopologyVersion);
  const node = nodeByStage.get(stage);
  if (!node) {
    throw new Error(
      `Unknown writing stage ${stage} for topology ${String(pipelineTopologyVersion)}`,
    );
  }
  return node;
}

export function writingStageDependencies(
  stage: SharedWritingStageName,
): SharedWritingStageName[] {
  return [...writingStageDagNode(stage).dependsOn];
}

/**
 * Ready stages whose remaining dependencies are not still queued.
 * Dependencies omitted from this batch are treated as already satisfied.
 *
 * Topology-aware: legacy consults the legacy DAG, compact consults the
 * compact DAG. The `pipelineTopologyVersion` is forwarded by callers that
 * have it; `writingStageDependencies(stage)` is the legacy fallback.
 */
export function readyWritingStages(input: {
  remaining: SharedWritingStageName[];
  stageOrder: SharedWritingStageName[];
  pipelineTopologyVersion?: unknown;
}): SharedWritingStageName[] {
  const { nodeByStage } = getWritingStageDagForTopology(
    input.pipelineTopologyVersion,
  );
  const remaining = new Set(input.remaining);
  const ready = input.remaining.filter(stage => {
    const node = nodeByStage.get(stage);
    if (!node) return false;
    return node.dependsOn.every(dep => !remaining.has(dep));
  });
  return ready.sort(
    (left, right) =>
      input.stageOrder.indexOf(left) - input.stageOrder.indexOf(right),
  );
}

/**
 * Conservative wave: legacy QA stages may run together (parallelGroup 'qa').
 * Compact has only one QA stage (`qa`), so the wave logic naturally returns
 * `[qa]` whenever it is ready. Never mix Revision with QA stages.
 */
export function nextWritingStageWave(
  ready: SharedWritingStageName[],
  pipelineTopologyVersion?: unknown,
): SharedWritingStageName[] {
  if (ready.length === 0) return [];
  const { nodeByStage } = getWritingStageDagForTopology(
    pipelineTopologyVersion,
  );
  const qa = ready.filter(stage => {
    const node = nodeByStage.get(stage);
    return node?.parallelGroup === 'qa';
  });
  if (qa.length >= 2) return qa;
  return [ready[0]];
}