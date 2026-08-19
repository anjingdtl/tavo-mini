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
import {
  freezeContinuationThinking,
  resolveV5StageModels,
} from '../../continuation/generation/continuationV5Models';
import type {
  ContinuationContextSnapshotV5,
  ContinuationContextTrace,
  FrozenContinuationModelConfig,
} from '../../continuation/generation/types';
import { buildWritingKernelFreezeTrace } from '../unifiedWritingKernel';
import { freezeWritingModelConfig } from '../contracts/freezeModelConfig';
import { getStoredWritingExecutionProfile } from '../../../data/repositories/pipelineTaskRepository';
import {
  CURRENT_PIPELINE_TOPOLOGY_VERSION,
  pipelineTopologyLabel,
} from '../../pipeline/outlineWorkflowVersion';
import type {
  FrozenModelConfig,
  WritingRequest,
} from '../contracts/writingSource';

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

/** Freeze the Continuation kernel model, including thinking behavior. */
export function buildContinuationKernelFrozenModel(input: {
  frozenModel: FrozenContinuationModelConfig | null;
  contextWindow?: number;
  maxOutputTokens?: number;
}): FrozenModelConfig {
  const frozenModel = input.frozenModel;
  return freezeWritingModelConfig({
    configId: frozenModel?.configId ?? null,
    provider: frozenModel?.providerType,
    modelName: frozenModel?.modelName,
    url: frozenModel?.url,
    name: frozenModel?.name,
    contextWindow: frozenModel?.contextWindow || input.contextWindow,
    maxOutputTokens: frozenModel?.maxOutputTokens || input.maxOutputTokens,
    allowInsecureLanHttp: frozenModel?.allowInsecureLanHttp,
    thinking: freezeContinuationThinking(
      frozenModel?.modelName,
      frozenModel?.thinking,
    ),
    reasoningEffort: frozenModel?.reasoningEffort,
  });
}

/** Collect + freeze. The caller inserts the durable run row from this. */
export async function prepareContinuationRun(
  input: StartContinuationRunInput,
): Promise<PreparedContinuationRun> {
  const settings = await ensureGenerationSettings(input.projectId);
  const policy = await ensureContextAutomationPolicy();
  const resolved = await resolveV5StageModels(settings);
  // One-Shot (极速) profile: batch-owned runs freeze the batch's profile;
  // standalone runs fall back to the global tier setting. Read strictly
  // PRE-FREEZE — the frozen stage policy is authoritative afterwards, and
  // the profile never skips canon/boundary/seam/anchor collection below.
  const executionProfile =
    input.executionProfile === 'one_shot' ||
    input.executionProfile === 'standard'
      ? input.executionProfile
      : await getStoredWritingExecutionProfile().catch(
          () => 'standard' as const,
        );
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
    model: buildContinuationKernelFrozenModel({
      frozenModel,
      contextWindow: snapshot.contextBudget?.modelContextLimit,
      maxOutputTokens: snapshot.contextBudget?.reservedOutputTokens,
    }),
    policy: {
      version: 1,
      reviewMode: 'continuation-v5',
      strictness: 'fail-closed',
      values: {
        workflowVersion: 5,
        targetPosition: snapshot.targetPosition,
        // Phase 4R: the production Continuation path is frozen onto the SAME
        // compact Standard topology as new Outline tasks (single upstream
        // freeze source). Without this, `finalCandidateModeForPolicy` folds
        // to 'legacy' and the compact ONE-QA [qa,revision] round never runs
        // in production — a legacy continuation would fall back to the old
        // review/audit/factCheck DAG even at the standard execution profile.
        pipelineTopologyVersion: pipelineTopologyLabel(
          CURRENT_PIPELINE_TOPOLOGY_VERSION,
        ),
        ...(executionProfile === 'one_shot'
          ? { executionProfile: 'one_shot' as const }
          : {}),
        requirements: (snapshot.bundles.lockedRules || []).map(
          (text, index) => ({
            id: `obligation:locked-rule:${index + 1}`,
            kind: 'obligation',
            severity: 'blocking',
            validation: 'semantic',
            text,
          }),
        ),
      },
    },
  };
  const kernelFreeze = buildWritingKernelFreezeTrace({ request: kernelRequest });
  snapshot.writingKernelTrace = kernelFreeze.trace;
  snapshot.frozenWritingContext = kernelFreeze.frozenContext;
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
    frozenWritingContext: kernelFreeze.frozenContext,
  };
  prepared.trace.writingKernelTrace = kernelFreeze.trace;
  return { snapshotWithTraceId, unifiedTrace, kernelFreeze };
}
