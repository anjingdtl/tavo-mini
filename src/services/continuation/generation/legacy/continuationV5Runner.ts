/**
 * LEGACY (Kernel Final Closure §8.4): V5 run-entry wrappers. Production
 * writing goes through the Writing Kernel (writing/execution). Test/
 * compatibility only.
 *
 * The V5 capability provider (round functions, stage ledger, error finalizer,
 * contracts re-exports) lives in the shared writing stage set. This module
 * keeps the historical run-entry API surface (start/resume/cancel wrappers)
 * and the parse/hash re-exports that targeted unit tests rely on.
 */
import {
  finalizeContinuationCapabilityError,
} from '../../../writing/stages/continuationStageCapabilities';
import {
  CONTINUATION_V5_LENGTH_POLICY,
} from '../continuationV5Contracts';
import { runContinuationCapabilityChain } from './continuationV5Pipeline';
import {
  casUpdateRunState,
  ensureGenerationSettings,
  getRunById,
  insertRun,
  newContinuationRunId,
} from '../generationRepository';
import {
  appendContinuationGenerationTraceEvent,
  createContinuationGenerationTrace,
  ensureContinuationGenerationTrace,
} from '../continuationGenerationTrace';
import { activeContinuationControllers } from '../continuationRunControllers';
import { buildContinuationV5Context } from '../../../writing/scenario/continuationSourceCollection';
import { adaptContinuationWritingSources } from '../../../writing/scenario/continuationWritingAdapter';
import { buildWritingKernelFreezeTrace } from '../../../writing/unifiedWritingKernel';
import type {
  StageLlmCaller,
  StartContinuationRunInput,
} from '../../../writing/scenario/continuationWritingTypes';
import type { WritingRequest } from '../../../writing/contracts/writingSource';
import type {
  ContinuationContextSnapshotV5,
  ContinuationContextTrace,
  ContinuationGenerationRun,
} from '../types';
import {
  CONTINUATION_V5_MAX_PHYSICAL_REQUESTS,
  ContinuationOutdatedError,
} from '../types';
import { resolveV5StageModels } from '../continuationV5Models';
import { ensureContextAutomationPolicy } from '../../../contextAutoAllocator';

export async function startContinuationV5Run(
  input: StartContinuationRunInput,
): Promise<ContinuationGenerationRun> {
  const settings = await ensureGenerationSettings(input.projectId);
  const policy = await ensureContextAutomationPolicy();
  const resolved = await resolveV5StageModels(settings);
  const { snapshot, trace } = await buildContinuationV5Context({
    projectId: input.projectId,
    targetChapterId: input.chapterId,
    targetPosition: input.targetPosition as any,
    currentChapterContent: input.currentChapterContent,
    userInstruction: input.userInstruction,
    activeLlmConfigId: resolved.activeConfigId,
    policy,
    stageModels: resolved.stageModels,
    frozenModelConfigs: resolved.frozenModelConfigs,
    lengthPolicy: CONTINUATION_V5_LENGTH_POLICY,
  });
  const sourceAdapter = adaptContinuationWritingSources({
    snapshot,
    userInstruction: input.userInstruction,
  });
  snapshot.writingSourceTrace = sourceAdapter.trace;
  trace.writingSourceTrace = sourceAdapter.trace;
  const frozenModel =
    snapshot.settingsSnapshot.frozenModelConfigs?.finalReviser ||
    snapshot.settingsSnapshot.frozenModelConfigs?.writer ||
    snapshot.settingsSnapshot.frozenModelConfigs?.draftWriter ||
    null;
  const kernelRequest: WritingRequest = {
    writingRunId: `wr_${snapshot.projectId}_${snapshot.targetChapterId}_${snapshot.inputRevisionHash.slice(0, 12)}`,
    generationTraceId:
      snapshot.generationTraceId ||
      `gt_${snapshot.inputRevisionHash.slice(0, 24)}`,
    projectId: snapshot.projectId,
    chapterId: snapshot.targetChapterId,
    scenario: 'continuation',
    instruction: {
      title: `Continuation chapter ${snapshot.targetPosition}`,
      synopsis: snapshot.bundles.userInstruction,
      userInstruction: snapshot.bundles.userInstruction,
      currentContent: snapshot.bundles.seam.excerpt,
      targetPosition: Number(snapshot.targetPosition),
    },
    sourceBundle: sourceAdapter.bundle,
    model: {
      configId: frozenModel?.configId ?? null,
      provider: frozenModel?.providerType || 'openai_compatible',
      modelName: frozenModel?.modelName || 'runtime-selected',
      contextWindow: Math.max(
        1024,
        Number(frozenModel?.contextWindow || snapshot.contextBudget?.modelContextLimit || 8192),
      ),
      maxOutputTokens: Math.max(
        256,
        Number(frozenModel?.maxOutputTokens || snapshot.contextBudget?.reservedOutputTokens || 1024),
      ),
    },
    policy: {
      version: 1,
      reviewMode: 'continuation-v5',
      strictness: 'fail-closed',
      values: { workflowVersion: 5, targetPosition: snapshot.targetPosition },
    },
  };
  const kernelFreeze = buildWritingKernelFreezeTrace({ request: kernelRequest });
  snapshot.writingKernelTrace = kernelFreeze.trace;
  trace.writingKernelTrace = kernelFreeze.trace;
  const runId = newContinuationRunId();
  const unifiedTrace = createContinuationGenerationTrace({
    snapshot,
    trace,
    runId,
    batchTraceId: input.batchTraceId,
    chapterOrdinal: input.chapterOrdinal,
    chapterCount: input.chapterCount,
    state: 'running',
    stage: 'round1',
  });
  const unifiedGenerationTraceId =
    unifiedTrace.generationTraceId ?? kernelRequest.generationTraceId;
  const kernelFreezeWithTrace = buildWritingKernelFreezeTrace({
    request: {
      ...kernelRequest,
      generationTraceId: unifiedGenerationTraceId,
    },
  });
  const snapshotWithTraceId: ContinuationContextSnapshotV5 = {
    ...snapshot,
    generationTraceId: unifiedGenerationTraceId,
    writingKernelTrace: kernelFreezeWithTrace.trace,
  };
  trace.writingKernelTrace = kernelFreezeWithTrace.trace;
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
      maxPhysicalRequests: CONTINUATION_V5_MAX_PHYSICAL_REQUESTS,
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
  void (async () => {
    try {
      await runContinuationCapabilityChain(run, snapshotWithTraceId, unifiedTrace, {
        callStage: input.callStage,
        deterministicOnly: input.deterministicOnly,
        signal: controller.signal,
        projectId: input.projectId,
      });
    } catch (error) {
      try {
            await finalizeContinuationCapabilityError(runId, error, unifiedTrace);
      } catch (finalizeError) {
        console.warn(
          '[continuation-v5] pipeline finalizer failed:',
          finalizeError,
        );
      }
    } finally {
      activeContinuationControllers.delete(runId);
    }
  })().catch(error => {
    console.warn('[continuation-v5] pipeline task failed:', error);
  });
  return run;
}

export async function resumeContinuationV5Run(
  runId: string,
  callStage?: StageLlmCaller,
  deterministicOnly?: boolean,
): Promise<void> {
  const run = await getRunById(runId);
  if (!run) throw new Error('run 不存在');
  if (run.workflowVersion !== 5) throw new Error('不是 V5 续写运行');
  if (run.state === 'outdated') throw new ContinuationOutdatedError();
  if (run.state === 'awaiting_user' || run.state === 'awaiting_regeneration') {
    return;
  }
  if (run.state !== 'interrupted' && run.state !== 'failed') {
    throw new Error('仅 interrupted/failed V5 运行可恢复');
  }
  if (!run.contextSnapshotJson) throw new Error('缺少冻结 V5 context。');
  const snapshot = JSON.parse(
    run.contextSnapshotJson,
  ) as ContinuationContextSnapshotV5;
  if (snapshot.schemaVersion !== 4 || snapshot.workflowVersion !== 5) {
    throw new Error('V5 context snapshot 版本不匹配。');
  }
  const parsedTrace = run.contextTraceJson
    ? (JSON.parse(run.contextTraceJson) as ContinuationContextTrace)
    : ({
        sourceId: snapshot.source.sourceId,
        canonSnapshotId: snapshot.canon.snapshotId,
        canonRevision: snapshot.canon.revision,
        targetPosition: snapshot.targetPosition,
        entityRefs: [],
        storyMemoryFingerprint: snapshot.storyMemory.stateFingerprint,
        freshness: snapshot.bundles.effectiveState.freshness,
        categories: [],
        totalInputTokens: 0,
        reservedOutputTokens: 0,
        omittedCapabilities: [],
      } satisfies ContinuationContextTrace);
  const trace = ensureContinuationGenerationTrace(parsedTrace, snapshot, {
    runId,
    state: 'interrupted',
    stage: run.stage,
  });
  const resumedTrace = appendContinuationGenerationTraceEvent(trace, {
    event: 'resume',
    state: 'running',
    stage: run.stage === 'round1' ? 'round1' : run.stage,
  });
  const changed = await casUpdateRunState(runId, ['interrupted', 'failed'], {
    state: 'running',
    stage: run.stage === 'round1' ? 'round1' : run.stage,
    errorCode: null,
    errorMessage: null,
    completedAt: null,
    contextTraceJson: JSON.stringify(resumedTrace),
  });
  if (!changed) return;
  const controller = new AbortController();
  activeContinuationControllers.set(runId, controller);
  try {
    await runContinuationCapabilityChain(
      { ...run, state: 'running' },
      snapshot,
      resumedTrace,
      {
      callStage,
      deterministicOnly,
      signal: controller.signal,
      projectId: run.projectId,
      },
    );
  } catch (error) {
    await finalizeContinuationCapabilityError(runId, error, resumedTrace);
    throw error;
  } finally {
    activeContinuationControllers.delete(runId);
  }
}

// Canonical stage-cancel settlement lives in continuationStageCancellation;
// this re-export keeps the historical V5 name importable from the legacy
// runner path (test/compat only).
export { markContinuationV5StagesCancelled } from '../continuationStageCancellation';

// Named re-exports from the contract layer for historical test/compatibility
// callers. Production code imports these from the shared Writing Kernel or
// continuationV5Contracts directly.
export {
  parseContinuationV5DraftEnvelope,
  parseContinuationV5ArchitectureEnvelope,
  parseContinuationV5RevisionEnvelope,
  parseContinuationV5AuditEnvelope,
  parseContinuationV5FinalEnvelope,
  hashArchitectureEnvelope,
  hashAuditEnvelope,
  CONTINUATION_V5_LENGTH_POLICY,
} from '../continuationV5Contracts';
export type { V5PipelineOptions } from '../../../writing/stages/continuationStageCapabilities';
