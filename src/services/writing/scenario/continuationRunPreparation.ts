/**
 * PRE-FREEZE continuation run preparation (plan §4.2 / §8.1).
 *
 * Scenario-layer module: collects canon/boundary/seam/anchor/style/state
 * through the unified source collection, freezes the authoritative kernel
 * contract and shapes the durable run payload. Lives in scenario/ so the
 * kernel execution layer never imports live source collectors.
 */
import {
  ensureGenerationSettings,
} from '../../continuation/generation/generationRepository';
import { buildContinuationV5Context } from './continuationSourceCollection';
import { adaptContinuationWritingSources } from './continuationWritingAdapter';
import type { StartContinuationRunInput } from './continuationWritingTypes';
import { ensureContextAutomationPolicy } from '../../contextAutoAllocator';
import {
  createContinuationGenerationTrace,
} from '../../continuation/generation/continuationGenerationTrace';
import { CONTINUATION_V5_LENGTH_POLICY } from '../../continuation/generation/continuationV5Contracts';
import { resolveV5StageModels } from '../../continuation/generation/continuationV5Models';
import type {
  ContinuationContextSnapshotV5,
  ContinuationContextTrace,
} from '../../continuation/generation/types';
import { buildWritingKernelFreezeTrace } from '../unifiedWritingKernel';
import type { WritingRequest } from '../contracts/writingSource';

export interface PreparedContinuationRun {
  snapshot: ContinuationContextSnapshotV5;
  trace: ContinuationContextTrace;
  unifiedTrace: ReturnType<typeof createContinuationGenerationTrace>;
  kernelRequest: WritingRequest;
  kernelFreeze: ReturnType<typeof buildWritingKernelFreezeTrace>;
  runPayload: {
    projectId: number;
    chapterId: number;
    targetPosition: number;
    userInstruction: string;
  };
}

/** Collect + freeze. The caller inserts the durable run row from this. */
export async function prepareContinuationRun(
  input: StartContinuationRunInput,
): Promise<PreparedContinuationRun> {
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
        Number(
          frozenModel?.contextWindow ||
            snapshot.contextBudget?.modelContextLimit ||
            8192,
        ),
      ),
      maxOutputTokens: Math.max(
        256,
        Number(
          frozenModel?.maxOutputTokens ||
            snapshot.contextBudget?.reservedOutputTokens ||
            1024,
        ),
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
  return {
    snapshot,
    trace,
    unifiedTrace: null as unknown as PreparedContinuationRun['unifiedTrace'],
    kernelRequest,
    kernelFreeze,
    runPayload: {
      projectId: input.projectId,
      chapterId: input.chapterId,
      targetPosition: input.targetPosition,
      userInstruction: input.userInstruction,
    },
  };
}

/** Second half of the preparation: bind the unified generation trace id
 * once a run id exists (called by the driver before inserting the row). */
export function bindPreparedRunTrace(
  prepared: PreparedContinuationRun,
  input: StartContinuationRunInput,
  runId: string,
): {
  snapshotWithTraceId: ContinuationContextSnapshotV5;
  unifiedTrace: ReturnType<typeof createContinuationGenerationTrace>;
  kernelFreeze: ReturnType<typeof buildWritingKernelFreezeTrace>;
} {
  const unifiedTrace = createContinuationGenerationTrace({
    snapshot: prepared.snapshot,
    trace: prepared.trace,
    runId,
    batchTraceId: input.batchTraceId,
    chapterOrdinal: input.chapterOrdinal,
    chapterCount: input.chapterCount,
    state: 'running',
    stage: 'round1',
  });
  const unifiedGenerationTraceId =
    unifiedTrace.generationTraceId ??
    prepared.kernelRequest.generationTraceId;
  const kernelFreeze = buildWritingKernelFreezeTrace({
    request: {
      ...prepared.kernelRequest,
      generationTraceId: unifiedGenerationTraceId,
    },
  });
  const snapshotWithTraceId: ContinuationContextSnapshotV5 = {
    ...prepared.snapshot,
    generationTraceId: unifiedGenerationTraceId,
    writingKernelTrace: kernelFreeze.trace,
  };
  prepared.trace.writingKernelTrace = kernelFreeze.trace;
  return { snapshotWithTraceId, unifiedTrace, kernelFreeze };
}
