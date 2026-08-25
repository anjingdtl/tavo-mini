/**
 * Outline durable stage driver for the one Writing Kernel (plan §7).
 *
 * The kernel engine advances this driver one durable action at a time. The
 * loop-body semantics are the verbatim continuation of the legacy reconcile
 * loop (retry dispositions, blocked handling, budget gates, interrupts) —
 * the difference is ownership: the ENGINE drives; this driver executes one
 * durable step and surfaces unified stage notifications plus the single
 * authoritative Freeze binding loaded from the durable envelope.
 *
 * After Freeze this driver never reads live source data: every action reads
 * the frozen snapshot through the shared pipeline machinery.
 */
import type { Chapter } from '../../../types/novel';
import type { PipelineTask } from '../../../types/pipeline';
import type { PipelineRunOptions, StageInfo } from '../../pipelineRunner';
import {
  forgetCancelledTask,
  isPipelineCancelled,
  registerTaskAbort,
  releaseTaskAbort,
} from '../../pipelineRunner';
import {
  clearLLMTaskQueueDefaults,
  setLLMTaskQueueDefaults,
} from '../../llm/requestScheduler';
import { PipelineForeground } from '../../../native/PipelineForegroundModule';
import { sha256Hex } from '../../continuation/hashUtils';
import * as db from '../../database';
import { usePipelineTaskStore } from '../../../store/pipelineTaskStore';
import {
  getPipelineTaskById,
  getPipelineTaskResumePayload,
  updatePipelineTaskContext,
} from '../../../data/repositories/pipelineTaskRepository';
import { createGenerationTraceId } from '../../pipeline/generationTrace';
import { determineNextPipelineAction } from '../../pipeline/determineNextPipelineAction';
import {
  buildPersistedTaskView,
  resolveStageCheckpoints,
  stageNamesForPipelineTopology,
} from '../../pipeline/taskView';
import {
  checkPipelineResumeContract,
  pipelineTopologyLabel,
  shouldIncludeBriefCheckpoint,
} from '../../pipeline/outlineWorkflowVersion';
import { mapOutlineErrorToPipelineError } from '../../pipeline/errors';
import {
  adaptOutlineWritingSources,
  resolveOutlineWritingSourceContext,
} from '../scenario/outlineWritingAdapter';
import { buildWritingKernelFreezeTrace } from '../unifiedWritingKernel';
import { freezeWritingModelConfig } from '../contracts/freezeModelConfig';
import { buildSharedStageMaxOutputTokens } from '../../contextAutoAllocator';
import type { WritingRequest } from '../contracts/writingSource';
import {
  BatchBudgetExceededError,
  acquireReconcileLock,
  cancelled as isTaskCancelled,
  consumeFailedStageRetryDisposition,
  handleBlocked,
  maybeAutoRetryStage,
  releaseReconcileLock,
  settleInterruptedTask,
  type ReconcileOptions,
} from '../reconcileOrchestration';
import { runOutlineDurableOperation } from '../../pipeline/outlineStageRuntime';
import { runWritingStages } from '../stages/writingStageRunner';
import { createOutlineDurableAdapter } from '../persistence/outlineDurableAdapter';
import type { PipelineAction } from '../../pipeline/types';
import type {
  FrozenWritingContext,
  WritingKernelStage,
} from '../contracts/frozenWritingContext';
import type {
  WritingStageDriver,
  WritingStageNotification,
  WritingStepOutcome,
} from '../contracts/writingStage';
import type { SharedWritingStageResult } from '../contracts/writingStage';

/** Same iteration bound as the legacy loop. */
const MAX_STEPS = 32;

const ACTION_STAGES: Partial<Record<PipelineAction['type'], WritingKernelStage[]>> = {
  run_draft: ['draft'],
  build_audit_context: ['audit'],
  run_review: ['review'],
  run_fact_check: ['factCheck'],
  run_review_and_fact_check: ['review', 'factCheck'],
  // Phase 4 (二 §7.2): the unified `qa` action maps to a single qa kernel
  // stage. Legacy run_review / run_fact_check are unchanged for historical
  // resume.
  run_qa: ['qa'],
  run_brief: ['revision'],
  run_proof: ['proof'],
  finalize_from_draft: ['finalValidate', 'persist'],
  finalize_from_proof: ['finalValidate', 'persist'],
  // Outline PostWriting starts at the persisted chapter-finalize boundary
  // (adoption/editor finalization), not when the draft task merely reaches
  // completed. The durable closure appends this stage later.
  complete: [],
};

function isOneShotFrozenContext(
  frozenContext: FrozenWritingContext | null | undefined,
): boolean {
  return frozenContext?.stagePolicy?.values?.executionProfile === 'one_shot';
}

function notificationStagesForAction(
  action: PipelineAction,
  frozenContext: FrozenWritingContext | null | undefined,
): WritingKernelStage[] {
  if (
    (action.type === 'finalize_from_draft' ||
      action.type === 'finalize_from_proof') &&
    isOneShotFrozenContext(frozenContext)
  ) {
    // One-Shot uses the same Kernel with formal QA / Revision skips. Do not
    // manufacture legacy Review/Audit/FactCheck/Proof rows for a compact task.
    return ['qa', 'revision', 'finalValidate', 'persist'];
  }
  return ACTION_STAGES[action.type] ?? [];
}

export interface OutlineStageDriverInput {
  taskId: string;
  chapter: Chapter;
  mode: 'first-run' | 'resume';
  onStageUpdate?: (info: StageInfo | string) => void;
  options?: PipelineRunOptions;
}

interface EnvelopeKernelFreeze {
  trace: import('../contracts/frozenWritingContext').WritingKernelTrace;
  frozenContext: FrozenWritingContext | null;
}

/** Read-only projection of the durable envelope's kernel freeze. */
function readEnvelopeKernelFreeze(task: {
  pipelineContextJson?: string | null;
} | null | undefined): EnvelopeKernelFreeze | null {
  if (!task?.pipelineContextJson) return null;
  try {
    const envelope = JSON.parse(task.pipelineContextJson) as {
      draftContext?: {
        writingKernelTrace?: import('../contracts/frozenWritingContext').WritingKernelTrace;
        frozenWritingContext?: FrozenWritingContext;
      };
    };
    const trace = envelope.draftContext?.writingKernelTrace;
    if (!trace || !trace.freezeFingerprint) return null;
    const frozen = envelope.draftContext?.frozenWritingContext;
    return {
      trace,
      frozenContext:
        frozen && frozen.requirements && frozen.stagePolicy ? frozen : null,
    };
  } catch {
    return null;
  }
}

/**
 * Kernel Final Closure — freeze backfill for envelopes persisted by builds
 * before the unified kernel (no writingKernelTrace yet). Derives the
 * authoritative freeze DETERMINISTICALLY from the already-frozen envelope
 * (never live DB) and persists it once, before any stage executes.
 */
async function backfillKernelFreezeFromEnvelope(input: {
  taskId: string;
  chapter: Chapter;
  generationTraceId: string;
  persistLegacyEnvelope?: boolean;
}): Promise<EnvelopeKernelFreeze | null> {
  const projectedTask = usePipelineTaskStore
    .getState()
    .tasks.find(task => task.id === input.taskId);
  const task =
    projectedTask?.pipelineContextJson
      ? projectedTask
      : projectedTask
      ? projectedTask
      : await getPipelineTaskById(input.taskId).catch(() => null);
  if (!task?.pipelineContextJson) return null;
  let envelope: any;
  try {
    envelope = JSON.parse(task.pipelineContextJson);
  } catch {
    return null;
  }
  const draftContext = envelope?.draftContext;
  const execution = envelope?.execution;
  if (!draftContext || !execution?.model) return null;
  const hadDurableKernelFreeze = Boolean(
    draftContext.writingKernelTrace?.freezeFingerprint &&
      draftContext.frozenWritingContext?.requirements &&
      draftContext.frozenWritingContext?.stagePolicy,
  );
  if (
    hadDurableKernelFreeze
  ) {
    // Present already — reading it back keeps a single authority.
    return readEnvelopeKernelFreeze(task);
  }
  const sourceContext = resolveOutlineWritingSourceContext({
    chapter: input.chapter,
    context: {
      presetText: draftContext.presetText || '',
      storyMemoryText: draftContext.storyMemoryText || '',
      characterText: draftContext.characterText || '',
      noteText: draftContext.noteText || '',
      worldbookText: draftContext.worldbookText || '',
      episodicMemoryText: draftContext.episodicMemoryText || '',
      recentBridgeText: draftContext.recentBridgeText || '',
      outlineText: draftContext.outlineText || '',
      outlineFingerprint: draftContext.outlineFingerprint || '',
      outlineIds: draftContext.outlineIds || [],
      outlineComplete: Boolean(draftContext.outlineComplete),
      writerStyleText: draftContext.writerStyleSnapshot
        ? JSON.stringify(draftContext.writerStyleSnapshot)
        : undefined,
    },
  });
  const adapted = adaptOutlineWritingSources({
    projectId: input.chapter.project_id,
    chapter: input.chapter,
    context: sourceContext,
  });
  draftContext.writingSourceTrace = adapted.trace;
  const kernelRequest: WritingRequest = {
    writingRunId: `wr_${input.taskId}`,
    generationTraceId:
      envelope?.trace?.generationTraceId || input.generationTraceId,
    projectId: input.chapter.project_id,
    chapterId: input.chapter.id,
    scenario: 'outline',
    instruction: {
      title: input.chapter.title || '',
      synopsis: input.chapter.synopsis || '',
      userInstruction: input.chapter.synopsis || input.chapter.title || '完成本章写作。',
      currentContent: input.chapter.content || '',
      targetPosition: input.chapter.position,
    },
    sourceBundle: adapted.bundle,
    model: freezeWritingModelConfig({
      configId: execution.model.llmConfigId ?? null,
      provider: execution.model.provider,
      modelName: execution.model.modelName,
      url: execution.model.url,
      name: execution.model.name,
      contextWindow: execution.model.contextWindow,
      maxOutputTokens: execution.model.maxOutputTokens,
      allowInsecureLanHttp: execution.model.allowInsecureLanHttp,
      thinking: execution.model.thinking,
      reasoningEffort: execution.reasoningEffort,
    }),
    policy: {
      version: 1,
      reviewMode: execution.pipelineMode,
      strictness: 'fail-closed',
      values: {
        contextBudgetVersion: execution.contextBudgetVersion,
        outlineStageReasoning: execution.stageReasoning,
        ...(execution.executionProfile === 'one_shot'
          ? { executionProfile: 'one_shot' as const }
          : {}),
        ...(execution.generationQualityProfile
          ? { qualityProfile: execution.generationQualityProfile }
          : {}),
        // §5.2: the frozen topology label joins the kernel freeze so
        // post-Freeze stages (Final Candidate / future DAG switches) read the
        // frozen value, never the live default.
        pipelineTopologyVersion: pipelineTopologyLabel(
          task?.pipelineTopologyVersion,
        ),
        sharedStageMaxOutputTokens: buildSharedStageMaxOutputTokens({
          contextWindow: execution.model.contextWindow,
          modelMaxOutputTokens: execution.model.maxOutputTokens,
          outlineStageBudgets: execution.stageBudgets,
        }),
      },
    },
  };
  const kernelFreeze = buildWritingKernelFreezeTrace({ request: kernelRequest });
  draftContext.writingKernelTrace = kernelFreeze.trace;
  draftContext.frozenWritingContext = kernelFreeze.frozenContext;
  // Historical V1/V2 tasks predate the Kernel trace fields. They are allowed
  // to resume against the exact original frozen envelope; the in-memory
  // adapter still supplies the shared Kernel with a deterministic Freeze, but
  // migration compatibility must not rewrite the user's old context JSON.
  if (!hadDurableKernelFreeze && !input.persistLegacyEnvelope) {
    return { trace: kernelFreeze.trace, frozenContext: kernelFreeze.frozenContext };
  }
  const json = JSON.stringify(envelope);
  await updatePipelineTaskContext(input.taskId, {
    json,
    version: Number(task.pipelineContextVersion || envelope.version || 4),
    hash: sha256Hex(json).slice(0, 32),
  });
  usePipelineTaskStore.getState().syncTaskPipelineContext?.(input.taskId, {
    pipelineContextJson: json,
    pipelineContextVersion: Number(task.pipelineContextVersion || envelope.version || 4),
    pipelineContextHash: sha256Hex(json).slice(0, 32),
  });
  return { trace: kernelFreeze.trace, frozenContext: kernelFreeze.frozenContext };
}

function getErrorMessage(error: any, fallback: string): string {
  return error?.message ? String(error.message) : fallback;
}

/**
 * Creates the durable outline driver: same pre-loop setup as the legacy
 * public entries (queue defaults, abort registration, foreground ownership,
 * checkpoint provisioning) plus the shared single-flight lock.
 */
export async function createOutlineStageDriver(
  input: OutlineStageDriverInput,
): Promise<WritingStageDriver> {
  const taskId = input.taskId;
  const chapter = input.chapter;
  const options = input.options || {};
  const onStageUpdate = input.onStageUpdate;

  if (!acquireReconcileLock(taskId)) {
    const err = new Error('任务已在运行') as Error & { code?: string };
    err.code = 'TASK_ALREADY_RUNNING';
    throw err;
  }

  setLLMTaskQueueDefaults(taskId, {
    queueClass: options.queueClass || 'pipeline',
    queuePriority: options.queuePriority || 'manual',
  });
  const abortSignal = registerTaskAbort(taskId);
  const ownsForeground = (options.foregroundOwner ?? 'task') === 'task';
  const reconcileOptions: ReconcileOptions = {
    onStageUpdate,
    abortSignal,
    isCancelled: isPipelineCancelled,
    pipelineModeOverride: options.pipelineModeOverride,
    pipelineReasoningEffortOverride: options.pipelineReasoningEffortOverride,
    pipelineExecutionProfileOverride: options.pipelineExecutionProfileOverride,
    contextAutomationPolicyV3: options.contextAutomationPolicyV3,
    batchBudgetGate: options.batchBudgetGate,
    foregroundOwner: options.foregroundOwner,
    generationTraceId: options.generationTraceId ?? createGenerationTraceId(),
  };

  let steps = 0;
  let done = false;
  let terminal: WritingStepOutcome | null = null;
  let pendingFreeze: EnvelopeKernelFreeze | null = null;
  let authoritativeFreeze: EnvelopeKernelFreeze | null = null;
  let armed: { action: PipelineAction; stage: WritingKernelStage } | null = null;
  let pendingOutcomes: WritingStepOutcome[] = [];

  try {
    // Keep the public entry responsive: the store's synchronous status setter
    // enqueues the durable write, and stage persistence waits on that queue.
    // Awaiting this bookkeeping write here needlessly delays the first shared
    // Draft request and breaks the historical cancellation/foreground timing
    // contract.
    usePipelineTaskStore.getState().setTaskStatus(taskId, 'queued');
  } catch (error) {
    console.warn('[writing-kernel] failed to mark task queued:', taskId, error);
  }

  if (input.mode === 'resume') {
    const inMemoryTask = usePipelineTaskStore
      .getState()
      .tasks.find(task => task.id === taskId);
    const incompleteStatuses = new Set([
      'idle',
      'queued',
      'drafting',
      'reviewing',
      'factChecking',
      'briefing',
      'proofing',
      'failed',
      'interrupted',
    ]);
    const persistedTask = inMemoryTask?.pipelineContextJson
      ? inMemoryTask
      : (await getPipelineTaskResumePayload(taskId).then(r => {
            return r;
      })) || inMemoryTask;
    if (persistedTask && persistedTask !== inMemoryTask) {
      usePipelineTaskStore
        .getState()
        .registerPersistedTask(persistedTask as PipelineTask);
    }
    if (
      persistedTask &&
      incompleteStatuses.has(String(persistedTask.status))
    ) {
      // §5.5/§5.6 (H4/H6): resume checks ONLY the frozen contract — the
      // frozen topology must be valid (corrupt → fail-closed) and the frozen
      // budget protocol must be resumable. Legacy tasks with a compatible
      // budget resume under their FROZEN old topology, never the compact
      // Standard topology, and never the live default.
      const contract = checkPipelineResumeContract({
        status: persistedTask.status,
        contextBudgetVersion: persistedTask.contextBudgetVersion,
        pipelineTopologyVersion: persistedTask.pipelineTopologyVersion,
      });
      if (!contract.ok) {
        releaseReconcileLock(taskId);
        releaseTaskAbort(taskId);
        clearLLMTaskQueueDefaults(taskId);
        throw Object.assign(
          new Error(
            contract.errorMessage || '该任务无法继续，请按新版重新生成。',
          ),
          { code: contract.errorCode },
        );
      }
    }
    onStageUpdate?.({
      stage: 'idle',
      label: '正在恢复任务上下文',
      startedAt: Date.now(),
    });
    if (ownsForeground) {
      PipelineForeground.start(
        taskId,
        chapter.title || '流水线',
        '正在恢复任务',
        0,
      ).catch(() => {});
    }
    // A resumed task already owns its authoritative Freeze: surface it before
    // any stage executes so the engine can enforce the single-freeze rule.
    const existing = readEnvelopeKernelFreeze(persistedTask);
    if (existing?.frozenContext) {
      pendingFreeze = existing;
    } else {
      pendingFreeze = await backfillKernelFreezeFromEnvelope({
        taskId,
        chapter,
        generationTraceId: reconcileOptions.generationTraceId!,
        persistLegacyEnvelope: options.foregroundOwner === 'batch',
      });
    }
  } else {
    onStageUpdate?.({
      stage: 'idle',
      label: '正在整理上下文（不等待长期记忆）',
      startedAt: Date.now(),
    });
    if (ownsForeground) {
      PipelineForeground.start(taskId, chapter.title || '流水线', '正在准备写作', 0).catch(
        error => {
          console.warn(
            '[writing-kernel] early foreground start failed (non-fatal):',
            error,
          );
        },
      );
    }
    // A task frozen by a pre-closure build resumes with a backfilled freeze.
    const firstRunTask = usePipelineTaskStore
      .getState()
      .tasks.find(task => task.id === taskId);
    if (firstRunTask?.pipelineContextJson) {
      try {
        pendingFreeze = await backfillKernelFreezeFromEnvelope({
          taskId,
          chapter,
          generationTraceId: reconcileOptions.generationTraceId!,
          persistLegacyEnvelope: options.foregroundOwner === 'batch',
        });
      } catch (backfillError) {
        console.warn('[writing-kernel] freeze backfill failed:', taskId, backfillError);
      }
    }
  }

  // Schema 39+: checkpoint rows are required. Fail-closed on DB errors.
  const initialTask = usePipelineTaskStore
    .getState()
    .tasks.find(t => t.id === taskId);
  // Compact Standard (二 Phase §6) omits the proof checkpoint; legacy keeps it.
  const initialStages = stageNamesForPipelineTopology({
    hasBrief: shouldIncludeBriefCheckpoint({
      outlineWorkflowVersion: initialTask?.outlineWorkflowVersion,
      contextBudgetVersion: initialTask?.contextBudgetVersion,
    }),
    pipelineTopologyVersion: initialTask?.pipelineTopologyVersion,
  });
  await db.ensurePendingCheckpoints(taskId, initialStages as any);


  async function handleLoopError(error: any): Promise<WritingStepOutcome> {
    console.warn('[writing-kernel] outline stage step failed:', taskId, error);
    if (abortSignal.aborted || isTaskCancelled(taskId, reconcileOptions)) {
      await settleInterruptedTask(taskId, reconcileOptions);
      await PipelineForeground.stop(taskId);
      return { kind: 'terminal', reason: 'cancelled' };
    }
    if (error instanceof BatchBudgetExceededError) {
      return { kind: 'terminal', reason: 'budget-paused', error };
    }
    const store = usePipelineTaskStore.getState();
    const mapped = mapOutlineErrorToPipelineError(error);
    const message = mapped?.message || getErrorMessage(error, '流水线执行失败');
    if (store.persistFailTask) {
      await store.persistFailTask(taskId, message);
    } else {
      store.failTask(taskId, message);
    }
    if (ownsForeground) {
      await PipelineForeground.notifyFailed(
        taskId,
        chapter.title || '流水线',
        mapped?.message || '执行失败',
      );
    }
    await PipelineForeground.stop(taskId);
    return { kind: 'terminal', reason: 'failed' };
  }

  async function buildNotifications(
    action: PipelineAction,
    sharedResults?: SharedWritingStageResult[],
  ): Promise<WritingStageNotification[]> {
    const task = usePipelineTaskStore.getState().tasks.find(t => t.id === taskId);
    const stages = notificationStagesForAction(
      action,
      authoritativeFreeze?.frozenContext,
    );
    const checkpointRows = await db.getStageCheckpoints(taskId);
    return Promise.all(
      stages.map(async (stage, index) => {
        const shared = sharedResults?.[index];
        if (shared?.status === 'skipped') {
          return {
            stage,
            action: action.type,
            status: 'skipped' as const,
            detail: shared.skipReason,
            skipReason: shared.skipReason,
            policyRuleId: shared.policyRuleId,
          };
        }
        if (shared) {
          return {
            stage,
            action: action.type,
            status: shared.status === 'failed' ? ('blocked' as const) : ('completed' as const),
          };
        }
        const persistedStage = stage === 'revision' ? 'brief' : stage;
        const row = checkpointRows.find(item => item.stage === persistedStage);
        if (row?.status === 'skipped') {
          return {
            stage,
            action: action.type,
            status: 'skipped' as const,
            detail: row.errorMessage || 'policy_skipped',
            skipReason: row.errorMessage || 'policy_skipped',
            policyRuleId: row.errorCode || undefined,
          };
        }
        void task;
        return {
          stage,
          action: action.type,
          status: 'completed' as const,
        };
      }),
    );
  }

  interface RunOneActionResult {
    outcome: WritingStepOutcome;
    notifications: WritingStageNotification[];
  }

  async function runOneAction(action: PipelineAction): Promise<RunOneActionResult> {
    const task = usePipelineTaskStore.getState().tasks.find(t => t.id === taskId);
    if (!task) {
      throw new Error('找不到管线任务');
    }
    const checkpointRows = await db.getStageCheckpoints(taskId);
    const stages = resolveStageCheckpoints({
      checkpointRows,
      stageResults: task.stageResults,
      outlineWorkflowVersion: task.outlineWorkflowVersion,
      contextBudgetVersion: task.contextBudgetVersion,
      pipelineTopologyVersion: task.pipelineTopologyVersion,
    });
    const isFinalize =
      action.type === 'finalize_from_draft' ||
      action.type === 'finalize_from_proof';
    let sharedResults: SharedWritingStageResult[] | undefined;
    reconcileOptions.frozenWritingContext =
      authoritativeFreeze?.frozenContext || null;
    reconcileOptions.writingKernelTrace = authoritativeFreeze?.trace;
    if (isFinalize && authoritativeFreeze?.frozenContext) {
      const frozenContext = authoritativeFreeze.frozenContext;
      const finalizeStages = isOneShotFrozenContext(frozenContext)
        ? (['qa', 'revision', 'finalValidate', 'persist'] as const)
        : (['finalValidate', 'persist'] as const);
      sharedResults = await runWritingStages({
        frozenContext,
        trace: authoritativeFreeze.trace,
        stages: [...finalizeStages],
        persistAdapter: createOutlineDurableAdapter({ taskId, chapter }),
        abortSignal,
        semanticApply: async () => {
          const projected = usePipelineTaskStore
            .getState()
            .tasks.find(item => item.id === taskId);
          const persisted = projected || (await getPipelineTaskById(taskId));
          const chapterRow =
            typeof db.getChapterById === 'function'
              ? await db.getChapterById(chapter.id)
              : null;
          const finalBody = persisted?.finalText || chapterRow?.content || '';
          return {
            beforeRevisionBody:
              frozenContext.instruction.currentContent || '',
            finalBody,
            appliedRequirementIds: [],
          };
        },
      });
    }
    await runOutlineDurableOperation({
      taskId,
      chapter,
      action,
      stages,
      onStageUpdate,
      abortSignal,
      options: reconcileOptions,
    });
    if (action.type === 'complete') {
      return {
        outcome: { kind: 'terminal', reason: 'completed' },
        notifications: [],
      };
    }
    return {
      outcome: { kind: 'progress', detail: action.type },
      notifications: await buildNotifications(action, sharedResults),
    };
  }

  return {
    durableBinding: 'outline-pipeline-tasks',
    async step(): Promise<WritingStepOutcome> {
      if (done) {
        return terminal ?? { kind: 'stop' };
      }
      if (pendingFreeze) {
        const freeze = pendingFreeze;
        pendingFreeze = null;
        authoritativeFreeze = freeze;
        // Surface the authoritative freeze to the reconcile options BEFORE
        // any stage runs, so profile-scoped gates (one_shot no-retry) can
        // consult the frozen policy from the first step of a resumed run.
        reconcileOptions.frozenWritingContext =
          reconcileOptions.frozenWritingContext || freeze.frozenContext;
        reconcileOptions.writingKernelTrace =
          reconcileOptions.writingKernelTrace || freeze.trace;
        return { kind: 'freeze', ...freeze };
      }
      if (pendingOutcomes.length > 0) {
        return pendingOutcomes.shift()!;
      }
      if (armed) {
        const { action, stage } = armed;
        armed = null;
        try {
          const actionResult = await runOneAction(action);
          pendingOutcomes = actionResult.notifications.map(notification => ({
            kind: 'stage' as const,
            ...notification,
          }));
          if (actionResult.outcome.kind === 'terminal') {
            done = true;
            terminal = actionResult.outcome;
          }
          void stage;
          if (pendingOutcomes.length > 0) {
            return pendingOutcomes.shift()!;
          }
          return actionResult.outcome.kind === 'terminal'
            ? actionResult.outcome
            : { kind: 'progress', detail: action.type };
        } catch (error) {
          const outcome = await handleLoopError(error);
          done = true;
          terminal = outcome;
          return outcome;
        }
      }
      if (steps >= MAX_STEPS) {
        const store = usePipelineTaskStore.getState();
        store.failTask(taskId, '流水线状态机步数超限，已停止以防死循环');
        await PipelineForeground.stop(taskId);
        done = true;
        terminal = { kind: 'terminal', reason: 'failed' };
        return terminal;
      }
      steps += 1;

      try {
        if (isTaskCancelled(taskId, reconcileOptions)) {
          await PipelineForeground.stop(taskId);
          done = true;
          terminal = { kind: 'terminal', reason: 'cancelled' };
          return terminal;
        }

        const task = usePipelineTaskStore
          .getState()
          .tasks.find(t => t.id === taskId);
        if (!task) {
          throw new Error('找不到管线任务');
        }
        const checkpointRows = await db.getStageCheckpoints(taskId);
        const stages = resolveStageCheckpoints({
          checkpointRows,
          stageResults: task.stageResults,
          outlineWorkflowVersion: task.outlineWorkflowVersion,
          contextBudgetVersion: task.contextBudgetVersion,
          pipelineTopologyVersion: task.pipelineTopologyVersion,
        });
        const view = buildPersistedTaskView(task);
        const action = determineNextPipelineAction(view, stages);

        if (
          action.type === 'blocked' &&
          action.reason.code === 'STAGE_FAILED'
        ) {
          const retry = await consumeFailedStageRetryDisposition({
            taskId,
            stage: action.reason.stage,
            options: reconcileOptions,
          });
          if (retry.outcome === 'waiting') {
            done = true;
            terminal = { kind: 'terminal', reason: 'waiting' };
            return terminal;
          }
          if (retry.outcome === 'retried') {
            return { kind: 'progress', detail: 'stage-retry' };
          }
          await handleBlocked(
            taskId,
            chapter,
            action,
            stages,
            retry.message,
            ownsForeground,
          );
          done = true;
          terminal = { kind: 'terminal', reason: 'blocked' };
          return terminal;
        }

        if (action.type === 'blocked') {
          await handleBlocked(taskId, chapter, action, stages, undefined, ownsForeground);
          done = true;
          terminal = { kind: 'terminal', reason: 'blocked' };
          return terminal;
        }

        const retryResult = await maybeAutoRetryStage({
          taskId,
          stages,
          action,
          options: reconcileOptions,
        });
        if (retryResult === 'stop') {
          done = true;
          terminal = { kind: 'terminal', reason: 'waiting' };
          return terminal;
        }

        if (action.type === 'finalize_from_draft' && action.degraded === true) {
          const proofRetry = await consumeFailedStageRetryDisposition({
            taskId,
            stage: 'proof',
            options: reconcileOptions,
          });
          if (proofRetry.outcome === 'retried') {
            return { kind: 'progress', detail: 'proof-retry' };
          }
          if (proofRetry.outcome === 'waiting') {
            done = true;
            terminal = { kind: 'terminal', reason: 'waiting' };
            return terminal;
          }
        }

        if (action.type === 'persist_initial_snapshot') {
          await runOneAction(action);
          const freeze = readEnvelopeKernelFreeze(
            usePipelineTaskStore.getState().tasks.find(t => t.id === taskId),
          );
          if (!freeze) {
            throw new Error(
              'WRITING_FROZEN_CONTEXT_MISSING: no kernel freeze in the durable envelope after the initial snapshot',
            );
          }
          authoritativeFreeze = freeze;
          return { kind: 'freeze', ...freeze };
        }

        const notifications = notificationStagesForAction(
          action,
          authoritativeFreeze?.frozenContext,
        );
        if (notifications.length > 0) {
          armed = { action, stage: notifications[0] };
          return {
            kind: 'stage',
            stage: notifications[0],
            action: action.type,
            status: 'started',
          };
        }
        const actionResult = await runOneAction(action);
        if (actionResult.outcome.kind === 'terminal') {
          done = true;
          terminal = actionResult.outcome;
        }
        return actionResult.outcome;
      } catch (error) {
        const outcome = await handleLoopError(error);
        done = true;
        terminal = outcome;
        return outcome;
      }
    },
    async finalize(): Promise<void> {
      releaseReconcileLock(taskId);
      releaseTaskAbort(taskId);
      clearLLMTaskQueueDefaults(taskId);
      forgetCancelledTask(taskId);
    },
  };
}
