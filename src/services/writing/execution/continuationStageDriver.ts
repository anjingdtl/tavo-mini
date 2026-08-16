/**
 * Continuation durable stage driver for the one Writing Kernel (plan §8).
 *
 * Phase 1 (inside createDriver, PRE-FREEZE): scenario adaptation collects
 * canon/boundary/seam/anchor/style/state through the unified source
 * collection, freezes the authoritative kernel context and persists the
 * continuation run row (the durable substrate for adoption/state review).
 *
 * Phase 2 (steps, POST-FREEZE): the kernel engine drives the V5 stage
 * machine one round at a time — Stage ledger → Draft(V1∥A1) →
 * Revision(V2)+Audit(C2) → Proof/Final Reviser(V3)+Final Validate →
 * settlement. Every round consumes the frozen snapshot; no live source
 * reads occur after Freeze.
 */
import {
  getRunById,
  insertRun,
  newContinuationRunId,
} from '../../continuation/generation/generationRepository';
import {
  bindPreparedRunTrace,
  prepareContinuationRun,
} from '../scenario/continuationRunPreparation';
import type { StartContinuationRunInput } from '../scenario/continuationWritingTypes';
import {
  ensureV5StageLedger,
  finalizeV5OnError,
  runRound1,
  runRound2,
  runRound3AndValidate,
  type V5PipelineOptions,
} from './continuationV5StageMachine';
import { activeContinuationControllers } from '../../continuation/generation/continuationRunControllers';
import type {
  ContinuationContextTrace,
  ContinuationGenerationRun,
} from '../../continuation/generation/types';
import type { WritingKernelStage } from '../contracts/frozenWritingContext';
import type {
  WritingStageDriver,
  WritingStepOutcome,
} from '../contracts/writingStage';

export interface ContinuationStageDriver extends WritingStageDriver {
  /** Resolves once the durable run row exists (entry handoff point). */
  handoff: Promise<ContinuationGenerationRun>;
}

type RoundName = 'ledger' | 'round1' | 'round2' | 'round3' | 'settle';

function stageOutcome(
  stage: WritingKernelStage,
  status: 'started' | 'completed',
  action: string,
): WritingStepOutcome {
  return { kind: 'stage', stage, action, status };
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
      maxPhysicalRequests: 5,
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

  type Round1Result = Awaited<ReturnType<typeof runRound1>>;
  type Round2Result = Awaited<ReturnType<typeof runRound2>>;

  let round: RoundName = 'ledger';
  let armed: RoundName | null = null;
  let round1: Round1Result | null = null;
  let round2: Round2Result | null = null;
  let freezeEmitted = false;
  let done = false;
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
      if (done) {
        return terminal ?? { kind: 'stop' };
      }
      if (!freezeEmitted) {
        freezeEmitted = true;
        return { kind: 'freeze', ...freezeBinding };
      }
      if (pendingOutcomes.length > 0) {
        return pendingOutcomes.shift()!;
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
          round1 = await runRound1(run, snapshotWithTraceId, options);
          round = 'round2';
          pendingOutcomes = [stageOutcome('draft', 'completed', 'round1')];
          return pendingOutcomes.shift()!;
        }
        if (armed === 'round2') {
          armed = null;
          if (!round1) {
            throw new Error('round2 requires round1 artifacts');
          }
          round2 = await runRound2(
            run,
            snapshotWithTraceId,
            options,
            round1.draftArtifact,
            round1.architecture,
            round1.architectureHash,
          );
          round = 'round3';
          pendingOutcomes = [
            stageOutcome('revision', 'completed', 'round2'),
            stageOutcome('audit', 'completed', 'round2'),
          ];
          return pendingOutcomes.shift()!;
        }
        if (armed === 'round3') {
          armed = null;
          if (!round1 || !round2) {
            throw new Error('round3 requires round1/round2 artifacts');
          }
          await runRound3AndValidate(
            run,
            snapshotWithTraceId,
            unifiedTrace as ContinuationContextTrace,
            options,
            round2.revisionArtifact,
            round1.architecture,
            round1.architectureHash,
            round2.audit,
            round2.auditContractHash,
            round1.architectureDegraded,
            round2.auditorDegraded,
          );
          round = 'settle';
          pendingOutcomes = [
            stageOutcome('proof', 'completed', 'round3'),
            stageOutcome('finalValidate', 'completed', 'round3'),
            stageOutcome('persist', 'completed', 'settlement'),
          ];
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
            await ensureV5StageLedger(snapshotWithTraceId, runId);
            round = 'round1';
            return { kind: 'progress', detail: 'stage-ledger' };
          }
          case 'round1': {
            armed = 'round1';
            return stageOutcome('draft', 'started', 'round1');
          }
          case 'round2': {
            armed = 'round2';
            return stageOutcome('revision', 'started', 'round2');
          }
          case 'round3': {
            armed = 'round3';
            return stageOutcome('proof', 'started', 'round3');
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
        await finalizeV5OnError(
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
