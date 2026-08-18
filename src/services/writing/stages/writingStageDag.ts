/**
 * Explicit production Stage DAG.
 *
 * Stage arrays on drivers are execution batches, not the dependency source.
 * Revision never runs in the same wave as Review / Audit / FactCheck.
 */
import type { SharedWritingStageName } from '../contracts/writingPolicy';

export interface WritingStageDagNode {
  stage: SharedWritingStageName;
  dependsOn: SharedWritingStageName[];
  parallelGroup: 'qa' | null;
}

export const WRITING_STAGE_DAG: readonly WritingStageDagNode[] = [
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

const NODE_BY_STAGE = new Map(
  WRITING_STAGE_DAG.map(node => [node.stage, node]),
);

export function writingStageDagNode(
  stage: SharedWritingStageName,
): WritingStageDagNode {
  const node = NODE_BY_STAGE.get(stage);
  if (!node) {
    throw new Error(`Unknown writing stage in DAG: ${stage}`);
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
 */
export function readyWritingStages(input: {
  remaining: SharedWritingStageName[];
  stageOrder: SharedWritingStageName[];
}): SharedWritingStageName[] {
  const remaining = new Set(input.remaining);
  const ready = input.remaining.filter(stage =>
    writingStageDependencies(stage).every(dep => !remaining.has(dep)),
  );
  return ready.sort(
    (left, right) =>
      input.stageOrder.indexOf(left) - input.stageOrder.indexOf(right),
  );
}

/**
 * Conservative wave: only QA stages that are all ready may run together.
 * Never mix Revision with Review/Audit/FactCheck.
 */
export function nextWritingStageWave(
  ready: SharedWritingStageName[],
): SharedWritingStageName[] {
  if (ready.length === 0) return [];
  const qa = ready.filter(
    stage => writingStageDagNode(stage).parallelGroup === 'qa',
  );
  if (qa.length >= 2) return qa;
  return [ready[0]];
}
