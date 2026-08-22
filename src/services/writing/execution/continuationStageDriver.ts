/**
 * Continuation durable stage driver for the one Writing Kernel (plan §8).
 *
 * Phase 1 (inside createDriver, PRE-FREEZE): scenario adaptation collects
 * canon/boundary/seam/anchor/style/state through the unified source
 * collection, freezes the authoritative kernel context and persists the
 * continuation run row (the durable substrate for adoption/state review).
 *
 * Phase 2 (steps, POST-FREEZE): the kernel engine drives the continuation
 * capabilities through the shared stage set and the ONE Stage DAG —
 * Draft → (Review ∥ Audit) → Conditional Revision → Proof → Final Validate.
 * Driver batches remain for durable UI rounds; the runner owns dependencies.
 * Every round consumes the frozen snapshot; no live source reads occur
 * after Freeze.
 */
import {
  getRunById,
  insertRun,
  newContinuationRunId,
  getLatestArtifactForStage,
  getStageResult,
} from '../../continuation/generation/generationRepository';
import {
  bindPreparedRunTrace,
  prepareContinuationRun,
} from '../scenario/continuationRunPreparation';
import type { StartContinuationRunInput } from '../scenario/continuationWritingTypes';
import {
  ensureContinuationStageLedger,
  finalizeContinuationCapabilityError,
  type V5PipelineOptions,
} from '../stages/continuationStageCapabilities';
import { createContinuationDurableAdapter } from '../persistence/continuationDurableAdapter';
import { activeContinuationControllers } from '../../continuation/generation/continuationRunControllers';
import type {
  ContinuationContextTrace,
  ContinuationGenerationRun,
} from '../../continuation/generation/types';
import type { WritingKernelStage } from '../contracts/frozenWritingContext';
import type {
  SharedWritingStage,
  SharedWritingStageResult,
  WritingStageDriver,
  WritingStepOutcome,
} from '../contracts/writingStage';
import { runWritingStages } from '../stages/writingStageRunner';
import { finalCandidateModeForPolicy } from '../stages/finalCandidate';

export interface ContinuationStageDriver extends WritingStageDriver {
  /** Resolves once the durable run row exists (entry handoff point). */
  handoff: Promise<ContinuationGenerationRun>;
}

type RoundName = 'ledger' | 'round1' | 'round2' | 'round3' | 'settle';

/** Minimal projection of a durable continuation stage result used to resolve
 * the Compact Standard Semantic Apply metadata (Phase 4R P0-2). */
export interface CompactCandidateRow {
  status?: string | null;
  outputJson?: string | null;
}

export interface CompactSemanticApplySource {
  source: 'revision' | 'draft';
  beforeRevisionBody: string;
  appliedRequirementIds: string[];
  validNoOpRequirementIds: string[];
  validNoOpReasons: Record<string, string>;
}

function readCandidateEnvelope(
  row: CompactCandidateRow | null,
): Record<string, unknown> {
  if (!row?.outputJson) return {};
  try {
    const output = JSON.parse(row.outputJson);
    const envelope = output?.envelope ?? output;
    return envelope && typeof envelope === 'object' ? envelope : {};
  } catch {
    return {};
  }
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map(item => String(item || '').trim())
        .filter(Boolean),
    ),
  );
}

function toReasons(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const text = String(val ?? '').trim();
    if (text) out[key] = text;
  }
  return out;
}

/**
 * Phase 4R P0-2: resolve the ONE Final Candidate metadata for the Compact
 * (new-Standard) Continuation Semantic Apply from the REAL durable stage
 * results. `revision_writer` succeeded → revision metadata; otherwise
 * `draft_writer` metadata. There is NO proof / `final_reviser` input, so the
 * compact contract structurally cannot derive evidence from the Proof node
 * this DAG does not run — an empty-proof fallback would silently auto-PASS.
 */
export function resolveCompactSemanticApplyMetadata(
  revisionRow: CompactCandidateRow | null,
  draftRow: CompactCandidateRow | null,
  revisionBody: string,
  draftBody: string,
): CompactSemanticApplySource {
  const revisionOk = revisionRow?.status === 'success';
  const envelope = readCandidateEnvelope(revisionOk ? revisionRow : draftRow);
  const applied = asStrings([
    ...asStrings(envelope.appliedObligationIds),
    ...asStrings(envelope.appliedRequirementIds),
    ...asStrings(envelope.appliedCanonRequirementIds),
  ]);
  return {
    source: revisionOk ? 'revision' : 'draft',
    beforeRevisionBody: revisionOk ? draftBody : revisionBody || draftBody,
    appliedRequirementIds: applied,
    validNoOpRequirementIds: asStrings(envelope.validNoOpRequirementIds),
    validNoOpReasons: toReasons(envelope.validNoOpReasons),
  };
}

function stageOutcome(
  stage: WritingKernelStage,
  status: 'started' | 'completed',
  action: string,
): WritingStepOutcome {
  return { kind: 'stage', stage, action, status };
}

/** Compact round2 exposes one Kernel boundary per shared stage. */
export function continuationRound2StageForIndex(input: {
  compactTopology: boolean;
  stages: readonly SharedWritingStage[];
  index: number;
}): SharedWritingStage | undefined {
  if (!input.compactTopology) return undefined;
  return input.stages[input.index];
}

/**
 * Derive the durable step outcomes from the REAL shared stage results so a
 * formally skipped stage (One-Shot profile) surfaces `skipped` with its
 * frozen skip provenance — never a fake `completed`. Local settlement stages
 * (finalValidate / persist) always complete.
 */
function outcomesFromResults(
  results: SharedWritingStageResult[],
  action: string,
  settlementActions: Partial<Record<string, string>> = {},
): WritingStepOutcome[] {
  return results.map(result =>
    result.status === 'skipped'
      ? {
          kind: 'stage' as const,
          stage: result.stage as WritingKernelStage,
          action: settlementActions[result.stage] || action,
          status: 'skipped' as const,
          skipReason: result.skipReason,
          policyRuleId: result.policyRuleId,
          detail: result.skipReason,
        }
      : {
          kind: 'stage' as const,
          stage: result.stage as WritingKernelStage,
          action: settlementActions[result.stage] || action,
          status: 'completed' as const,
        },
  );
}

/**
 * Creates the continuation driver. Performs the whole pre-Freeze adaptation
 * and the durable freeze (run row insert) before returning; the first
 * `step()` surfaces that freeze to the kernel engine exactly once.
 */
export async function createContinuationStageDriver(
  input: StartContinuationRunInput,
): Promise<ContinuationStageDriver> {
  // ---- Pre-Freeze scenario adaptation (plan §4.2 / §8.1) -----------------
  // Delegated to the scenario-layer preparation module: collect sources,
  // freeze the kernel contract, then bind the unified trace id once a run id
  // exists. The execution layer performs no live source reads.
  const prepared = await prepareContinuationRun(input);

  // ---- Durable freeze: the run row owns the authoritative snapshot -------
  const runId = newContinuationRunId();
  const { snapshotWithTraceId, unifiedTrace, kernelFreeze } =
    bindPreparedRunTrace(prepared, input, runId);
  // One-Shot (极速): the run's physical-request budget is the frozen
  // profile's cap (1). Standard continuation keeps the V5 five-request cap.
  // Phase 3 §6: Compact Standard (二) DAG drops the proof node, so the
  // physical-request budget is 4 instead of 5. Legacy Standard keeps 5.
  // Phase 4 §7.2: the compact Standard also collapses Review/Audit/FactCheck
  // into one qa call, so the budget drops from 4 to 3 (draft + qa + revision).
  const oneShotProfile =
    kernelFreeze.frozenContext?.stagePolicy?.values?.executionProfile ===
    'one_shot';
  const isCompactContinuation =
    finalCandidateModeForPolicy(
      kernelFreeze.frozenContext?.stagePolicy || { values: {} },
    ) === 'compact';
  const run = await insertRun({
    id: runId,
    projectId: input.projectId,
    chapterId: input.chapterId,
    targetPosition: input.targetPosition as any,
    sourceId: snapshotWithTraceId.source.sourceId,
    sourceSnapshotJson: JSON.stringify({
      schemaVersion: 1,
      ...snapshotWithTraceId.source,
    }),
    canonSnapshotId: snapshotWithTraceId.canon.snapshotId,
    canonRevision: snapshotWithTraceId.canon.revision,
    storyMemoryFingerprint: snapshotWithTraceId.storyMemory.stateFingerprint,
    storyMemoryThroughPosition: snapshotWithTraceId.storyMemory.throughPosition,
    inputRevisionHash: snapshotWithTraceId.inputRevisionHash,
    userInstruction: input.userInstruction,
    settingsSnapshotJson: JSON.stringify(snapshotWithTraceId.settingsSnapshot),
    contextSnapshotJson: JSON.stringify(snapshotWithTraceId),
    contextTraceJson: JSON.stringify(unifiedTrace),
    tokenUsageJson: JSON.stringify({
      workflowVersion: 5,
      maxPhysicalRequests: oneShotProfile ? 1 : isCompactContinuation ? 3 : 5,
      physicalRequestCount: 0,
      stages: {},
    }),
    state: 'running',
    stage: 'round1',
    completionReason: null,
    adoptedRevisionHash: null,
    finalizedRevisionHash: null,
    errorCode: null,
    errorMessage: null,
  });

  const controller = new AbortController();
  activeContinuationControllers.set(runId, controller);
  const options: V5PipelineOptions = {
    callStage: input.callStage,
    deterministicOnly: input.deterministicOnly,
    signal: controller.signal,
    projectId: input.projectId,
  };

  const freezeBinding = {
    trace: kernelFreeze.trace,
    frozenContext: kernelFreeze.frozenContext,
  };

  // Phase 3 §6: Compact Standard (二) DAG has NO Proof node. The frozen
  // stagePolicy.values.pipelineTopologyVersion==='compact_standard' gates the
  // round3 stage set: compact runs skip proof and go straight to FinalValidate
  // + Persist (the revision IS the final body, via finalCandidate 'compact').
  // Legacy continues to dispatch proof for historical compatibility.
  const compactTopology =
    finalCandidateModeForPolicy(
      kernelFreeze.frozenContext?.stagePolicy || { values: {} },
    ) === 'compact';
  const round3Stages: ('proof' | 'finalValidate' | 'persist')[] = compactTopology
    ? ['finalValidate', 'persist']
    : ['proof', 'finalValidate', 'persist'];
  // Phase 4 §7.2: compact Standard round1 = draft only, round2 = the unified
  // QA + Revision. Legacy keeps round1 = [draft, review] and round2 =
  // [revision, audit, factCheck].
  const round1Stages: ('draft' | 'review')[] = compactTopology
    ? ['draft']
    : ['draft', 'review'];
  const round2Stages: ('revision' | 'qa' | 'audit' | 'factCheck')[] =
    compactTopology ? ['qa', 'revision'] : ['revision', 'audit', 'factCheck'];

  let round: RoundName = 'ledger';
  let armed: RoundName | null = null;
  let freezeEmitted = false;
  let done = false;
  let round2StageIndex = 0;
  let terminal: WritingStepOutcome | null = null;
  let settleResult: ContinuationGenerationRun | null = null;
  let pendingOutcomes: WritingStepOutcome[] = [];

  let resolveHandoff!: (run: ContinuationGenerationRun) => void;
  const handoff = new Promise<ContinuationGenerationRun>(resolve => {
    resolveHandoff = resolve;
  });
  resolveHandoff(run);

  return {
    durableBinding: 'continuation-generation-ledger',
    handoff,
    async step(): Promise<WritingStepOutcome> {
      if (!freezeEmitted) {
        freezeEmitted = true;
        return { kind: 'freeze', ...freezeBinding };
      }
      if (pendingOutcomes.length > 0) {
        return pendingOutcomes.shift()!;
      }
      if (done) {
        return terminal ?? { kind: 'stop' };
      }
      try {
        if (controller.signal.aborted) {
          done = true;
          terminal = { kind: 'terminal', reason: 'cancelled' };
          return terminal;
        }
        // Armed phase: a round's `started` event was already surfaced; the
        // next step executes the durable round and queues completions.
        if (armed === 'round1') {
          armed = null;
          if (!kernelFreeze.frozenContext) {
            throw new Error('WRITING_FROZEN_CONTEXT_MISSING: continuation shared stage input');
          }
          const results = await runWritingStages({
            frozenContext: kernelFreeze.frozenContext,
            trace: kernelFreeze.trace,
            stages: round1Stages,
            persistAdapter: createContinuationDurableAdapter({
              run,
              snapshot: snapshotWithTraceId,
            }),
            callStage: options.callStage,
            abortSignal: options.signal,
          });
          round = 'round2';
          pendingOutcomes = outcomesFromResults(results, 'round1');
          return pendingOutcomes.shift()!;
        }
        if (armed === 'round2') {
          armed = null;
          if (!kernelFreeze.frozenContext) {
            throw new Error('WRITING_FROZEN_CONTEXT_MISSING: continuation shared stage input');
          }
          if (compactTopology) {
            // Compact Standard keeps one shared dispatcher, but each stage
            // gets its own Kernel start/completion boundary. The previous
            // batch call surfaced `revision started` before executing the
            // whole [qa, revision] array, leaving QA without a started event
            // and making the durable DAG claim Revision ran before QA.
            const stage = continuationRound2StageForIndex({
              compactTopology,
              stages: round2Stages,
              index: round2StageIndex,
            });
            if (!stage) {
              throw new Error('WRITING_STAGE_DAG_DEADLOCK: compact round2 exhausted');
            }
            const results = await runWritingStages({
              frozenContext: kernelFreeze.frozenContext,
              trace: kernelFreeze.trace,
              stages: [stage],
              persistAdapter: createContinuationDurableAdapter({
                run,
                snapshot: snapshotWithTraceId,
              }),
              callStage: options.callStage,
              abortSignal: options.signal,
            });
            round2StageIndex += 1;
            if (round2StageIndex >= round2Stages.length) {
              round = 'round3';
            }
            pendingOutcomes = outcomesFromResults(results, 'round2');
            return pendingOutcomes.shift()!;
          }
          const results = await runWritingStages({
            frozenContext: kernelFreeze.frozenContext,
            trace: kernelFreeze.trace,
            stages: round2Stages,
            persistAdapter: createContinuationDurableAdapter({
              run,
              snapshot: snapshotWithTraceId,
            }),
            callStage: options.callStage,
            abortSignal: options.signal,
          });
          round = 'round3';
          pendingOutcomes = outcomesFromResults(results, 'round2');
          return pendingOutcomes.shift()!;
        }
        if (armed === 'round3') {
          armed = null;
          if (!kernelFreeze.frozenContext) {
            throw new Error('WRITING_FROZEN_CONTEXT_MISSING: continuation shared stage input');
          }
          const persistAdapter = createContinuationDurableAdapter({
            run,
            snapshot: snapshotWithTraceId,
          });
          const results = await runWritingStages({
            frozenContext: kernelFreeze.frozenContext,
            trace: kernelFreeze.trace,
            stages: round3Stages,
            persistAdapter,
            callStage: options.callStage,
            abortSignal: options.signal,
            semanticApply: async () => {
              const finalArtifact = await getLatestArtifactForStage(
                run.id,
                'final',
              );
              if (compactTopology) {
                // Phase 4R P0-2: Compact continuation does NOT run Proof, so a
                // `final_reviser` row never exists. Semantic Apply must consume
                // the REAL ONE Final Candidate metadata — `revision_writer`
                // when it succeeded, otherwise `draft_writer`. It must never
                // fall back to an empty `final_reviser` evidence source, which
                // would silently auto-PASS the semantic gate.
                const [revisionRow, draftRow] = await Promise.all([
                  getStageResult(run.id, 'revision_writer'),
                  getStageResult(run.id, 'draft_writer'),
                ]);
                const [revisionArtifact, draftArtifact] = await Promise.all([
                  getLatestArtifactForStage(run.id, 'revision_1'),
                  getLatestArtifactForStage(run.id, 'draft'),
                ]);
                const candidate = resolveCompactSemanticApplyMetadata(
                  revisionRow,
                  draftRow,
                  revisionArtifact?.content || '',
                  draftArtifact?.content || '',
                );
                return {
                  beforeRevisionBody: candidate.beforeRevisionBody,
                  finalBody: finalArtifact?.content || '',
                  appliedRequirementIds: candidate.appliedRequirementIds,
                  validNoOpRequirementIds:
                    candidate.validNoOpRequirementIds,
                  validNoOpReasons: candidate.validNoOpReasons,
                };
              }
              // Legacy resume keeps the historical proof / final_reviser
              // metadata source for tasks frozen under a legacy topology.
              const revision = await getLatestArtifactForStage(
                run.id,
                'revision_1',
              );
              const finalReviser = await getStageResult(
                run.id,
                'final_reviser',
              );
              let appliedRequirementIds: string[] = [];
              let validNoOpRequirementIds: string[] = [];
              let validNoOpReasons: Record<string, string> = {};
              try {
                const output = finalReviser?.outputJson
                  ? JSON.parse(finalReviser.outputJson)
                  : null;
                const envelope = output?.envelope || {};
                appliedRequirementIds = [
                  ...(envelope.appliedObligationIds || []),
                  ...(envelope.appliedCanonRequirementIds || []),
                  ...(envelope.appliedStyleRequirementIds || []),
                ];
                validNoOpRequirementIds = envelope.validNoOpRequirementIds || [];
                validNoOpReasons = envelope.validNoOpReasons || {};
              } catch {
                appliedRequirementIds = [];
              }
              return {
                beforeRevisionBody: revision?.content || '',
                finalBody: finalArtifact?.content || '',
                appliedRequirementIds,
                validNoOpRequirementIds,
                validNoOpReasons,
              };
            },
          });
          round = 'settle';
          pendingOutcomes = outcomesFromResults(results, 'round3', {
            persist: 'settlement',
          });
          done = true;
          const settled = await getRunById(runId);
          settleResult = settled ?? run;
          terminal = {
            kind: 'terminal',
            reason: 'completed',
            result: settleResult,
          };
          return pendingOutcomes.shift()!;
        }
        switch (round) {
          case 'ledger': {
            await ensureContinuationStageLedger(snapshotWithTraceId, runId, {
              compactTopology,
            });
            round = 'round1';
            return { kind: 'progress', detail: 'stage-ledger' };
          }
          case 'round1': {
            armed = 'round1';
            return stageOutcome('draft', 'started', 'round1');
          }
          case 'round2': {
            armed = 'round2';
            const nextStage = compactTopology
              ? continuationRound2StageForIndex({
                  compactTopology,
                  stages: round2Stages,
                  index: round2StageIndex,
                })
              : 'revision';
            return stageOutcome(nextStage as WritingKernelStage, 'started', 'round2');
          }
          case 'round3': {
            armed = 'round3';
            // Phase 3 §6: compact Standard skips the proof stage, so the
            // first settled stage is finalValidate.
            const firstRound3Stage: WritingKernelStage = compactTopology
              ? 'finalValidate'
              : 'proof';
            return stageOutcome(firstRound3Stage, 'started', 'round3');
          }
          case 'settle':
          default: {
            done = true;
            const settled = await getRunById(runId);
            settleResult = settled ?? run;
            terminal = {
              kind: 'terminal',
              reason: 'completed',
              result: settleResult,
            };
            return terminal;
          }
        }
      } catch (error) {
        await finalizeContinuationCapabilityError(
          runId,
          error,
          unifiedTrace as ContinuationContextTrace,
        );
        done = true;
        terminal = { kind: 'terminal', reason: 'failed' };
        return terminal;
      }
    },
    async finalize(): Promise<void> {
      activeContinuationControllers.delete(runId);
    },
  };
}
