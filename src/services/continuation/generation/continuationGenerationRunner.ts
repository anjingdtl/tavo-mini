/**
 * Independent continuation generation runner (Spec §5, §9).
 * Does not reuse freeform PipelineStageName or pipeline_tasks as authority.
 */
import type { ChatMessage } from '../../llm/types';
import {
  callLLMResult,
  resolveLLMRequestConfig,
  resolveLLMRequestConfigById,
} from '../../llm';
import { stripModelJson } from '../canon/canonJsonValidators';
import { buildContinuationContext } from './continuationContextBuilder';
import {
  bindIssuesToArtifact,
  filterBySettings,
  parseCheckerLlmJson,
  runDeterministicChecks,
} from './continuationChecker';
import {
  compileCheckerMessages,
  compilePlannerMessages,
  compileRepairMessages,
  compileWriterMessages,
} from './continuationPromptCompiler';
import { shouldRunRepair, tryDeterministicRepair } from './continuationRepairService';
import {
  buildOutboxInsertStatement,
  casUpdateRunState,
  contentRevisionHash,
  getArtifactForRun,
  getLatestArtifact,
  getPlan,
  getRunById,
  insertArtifact,
  insertCheckResults,
  insertRun,
  listChecksForArtifact,
  markChecksObsolete,
  markRunsOutdatedForProject,
  newContinuationRunId,
  savePlan,
} from './generationRepository';
import type {
  ContinuationArtifact,
  ContinuationContextSnapshot,
  ContinuationGenerationRun,
  ContinuationPlan,
  ContinuationRunState,
} from './types';
import {
  ContinuationCapabilityBlockedError,
  ContinuationConflictError,
  ContinuationOutdatedError,
} from './types';
import { openDatabase } from '../../../data/connection/openDatabase';
import { executeTransaction } from '../../database/transaction';
import { v4 } from '../../uuidBridge';
import { processContinuationOutbox } from './continuationStateOutboxWorker';


export type StageLlmCaller = (input: {
  stage: string;
  messages: ChatMessage[];
  maxTokens: number;
  configId: number | null;
  responseFormat?: 'json_object' | 'text';
}) => Promise<{ text: string; usage?: { prompt?: number; completion?: number } }>;

export interface StartContinuationRunInput {
  projectId: number;
  chapterId: number;
  targetPosition: number;
  userInstruction: string;
  currentChapterContent: string;
  modelContextLimit?: number;
  maxOutputTokens?: number;
  outputReservePercent?: number;
  /** Test injector — skips real LLM. */
  callStage?: StageLlmCaller;
  /** Skip checker LLM (deterministic only). */
  deterministicOnly?: boolean;
}

const activeControllers = new Map<string, AbortController>();

function defaultPlan(instruction: string): ContinuationPlan {
  return {
    schemaVersion: 1,
    chapterGoal: instruction.slice(0, 200) || '推进主线',
    centralConflict: '延续上一章冲突',
    beats: [
      { order: 1, summary: '承接上一章' },
      { order: 2, summary: '发展冲突' },
      { order: 3, summary: '章末钩子' },
    ],
    participatingCharacterIds: [],
    characterActions: [],
    plotAdvances: [],
    foreshadowingActions: [],
    proposedStateChanges: [],
    risks: [],
  };
}

function parsePlan(raw: string, fallbackInstruction: string): ContinuationPlan {
  try {
    const parsed = JSON.parse(stripModelJson(raw));
    if (parsed && parsed.schemaVersion === 1 && parsed.chapterGoal) {
      return {
        schemaVersion: 1,
        chapterGoal: String(parsed.chapterGoal),
        centralConflict: String(parsed.centralConflict ?? ''),
        beats: Array.isArray(parsed.beats) ? parsed.beats : [],
        participatingCharacterIds: Array.isArray(parsed.participatingCharacterIds)
          ? parsed.participatingCharacterIds
          : [],
        characterActions: Array.isArray(parsed.characterActions)
          ? parsed.characterActions
          : [],
        plotAdvances: Array.isArray(parsed.plotAdvances) ? parsed.plotAdvances : [],
        foreshadowingActions: Array.isArray(parsed.foreshadowingActions)
          ? parsed.foreshadowingActions
          : [],
        proposedStateChanges: Array.isArray(parsed.proposedStateChanges)
          ? parsed.proposedStateChanges
          : [],
        risks: Array.isArray(parsed.risks) ? parsed.risks : [],
      };
    }
  } catch {
    // fall through
  }
  return defaultPlan(fallbackInstruction);
}

async function defaultStageCaller(input: {
  stage: string;
  messages: ChatMessage[];
  maxTokens: number;
  configId: number | null;
  responseFormat?: 'json_object' | 'text';
  signal?: AbortSignal;
  projectId: number;
  runId: string;
}): Promise<{ text: string; usage?: { prompt?: number; completion?: number } }> {
  const requestConfig = input.configId
    ? await resolveLLMRequestConfigById(input.configId)
    : await resolveLLMRequestConfig();
  const result = await callLLMResult(
    input.messages,
    input.maxTokens,
    {
      queueClass: 'pipeline',
      queuePriority: 'normal',
      projectId: input.projectId,
      taskId: input.runId,
      scenario: `continuation_${input.stage}`,
      responseFormat:
        input.responseFormat === 'json_object' ? 'json_object' : undefined,
      requestConfig,
    },
    input.signal,
  );
  return {
    text: result.text ?? '',
    usage: {
      prompt: (result as any).usage?.prompt_tokens,
      completion: (result as any).usage?.completion_tokens,
    },
  };
}

export async function startContinuationRun(
  input: StartContinuationRunInput,
): Promise<ContinuationGenerationRun> {
  const activeCfg = await resolveLLMRequestConfig().catch(() => null);
  const activeId = (activeCfg as any)?.id ?? 0;
  const modelLimit = input.modelContextLimit ?? activeCfg?.context_window ?? 8192;
  const maxOut = input.maxOutputTokens ?? 2048;

  // Context stage (no LLM for SM)
  const { snapshot, trace } = await buildContinuationContext({
    projectId: input.projectId,
    targetChapterId: input.chapterId,
    targetPosition: input.targetPosition as any,
    currentChapterContent: input.currentChapterContent,
    userInstruction: input.userInstruction,
    modelContextLimit: modelLimit,
    maxOutputTokens: maxOut,
    outputReservePercent: 15,
    activeLlmConfigId: activeId || 1,
  });

  const runId = newContinuationRunId();
  const run = await insertRun({
    id: runId,
    projectId: input.projectId,
    chapterId: input.chapterId,
    targetPosition: input.targetPosition as any,
    sourceId: snapshot.source.sourceId,
    sourceSnapshotJson: JSON.stringify({
      schemaVersion: 1,
      ...snapshot.source,
    }),
    canonSnapshotId: snapshot.canon.snapshotId,
    canonRevision: snapshot.canon.revision,
    storyMemoryFingerprint: snapshot.storyMemory.stateFingerprint,
    storyMemoryThroughPosition: snapshot.storyMemory.throughPosition,
    inputRevisionHash: snapshot.inputRevisionHash,
    userInstruction: input.userInstruction,
    settingsSnapshotJson: JSON.stringify(snapshot.settingsSnapshot),
    contextSnapshotJson: JSON.stringify(snapshot),
    contextTraceJson: JSON.stringify(trace),
    tokenUsageJson: JSON.stringify({ stages: {} }),
    state: 'running',
    stage: 'planner',
    completionReason: null,
    adoptedRevisionHash: null,
    finalizedRevisionHash: null,
    errorCode: null,
    errorMessage: null,
  });

  const controller = new AbortController();
  activeControllers.set(runId, controller);

  // Fire-and-forget stage pipeline
  void runStages(runId, snapshot, {
    callStage: input.callStage,
    deterministicOnly: input.deterministicOnly,
    signal: controller.signal,
    projectId: input.projectId,
  }).catch(async err => {
    if (controller.signal.aborted) {
      await casUpdateRunState(runId, ['running', 'awaiting_user'], {
        state: 'cancelled',
        errorCode: 'cancelled',
        errorMessage: '用户取消',
        completedAt: new Date().toISOString(),
      });
    } else {
      await casUpdateRunState(runId, ['running', 'awaiting_user', 'queued'], {
        state: 'failed',
        errorCode:
          err instanceof ContinuationCapabilityBlockedError
            ? err.code
            : 'stage_failed',
        errorMessage: err?.message ?? String(err),
        completedAt: new Date().toISOString(),
      });
    }
    activeControllers.delete(runId);
  });

  return run;
}

async function runStages(
  runId: string,
  snapshot: ContinuationContextSnapshot,
  opts: {
    callStage?: StageLlmCaller;
    deterministicOnly?: boolean;
    signal: AbortSignal;
    projectId: number;
  },
): Promise<void> {
  const tokenUsage: Record<string, { prompt?: number; completion?: number }> =
    {};
  const call = async (
    stage: string,
    messages: ChatMessage[],
    maxTokens: number,
    configId: number | null,
    responseFormat?: 'json_object' | 'text',
  ) => {
    if (opts.signal.aborted) throw new Error('cancelled');
    if (opts.callStage) {
      const r = await opts.callStage({
        stage,
        messages,
        maxTokens,
        configId,
        responseFormat,
      });
      tokenUsage[stage] = r.usage ?? {};
      return r.text;
    }
    const r = await defaultStageCaller({
      stage,
      messages,
      maxTokens,
      configId,
      responseFormat,
      signal: opts.signal,
      projectId: opts.projectId,
      runId,
    });
    tokenUsage[stage] = r.usage ?? {};
    return r.text;
  };

  const persistUsage = async (stage: string) => {
    await casUpdateRunState(runId, ['running'], {
      stage: stage as any,
      tokenUsageJson: JSON.stringify({ stages: tokenUsage }),
    });
  };

  // Planner
  await persistUsage('planner');
  const plannerMsgs = compilePlannerMessages(snapshot);
  let plan: ContinuationPlan;
  try {
    const raw = await call(
      'planner',
      plannerMsgs,
      1024,
      snapshot.settingsSnapshot.resolvedModelConfigIds.planner,
      'json_object',
    );
    plan = parsePlan(raw, snapshot.bundles.userInstruction);
  } catch {
    plan = defaultPlan(snapshot.bundles.userInstruction);
  }

  const needsConfirm =
    snapshot.settingsSnapshot.values.plannerConfirmationPolicy === 'always' ||
    (snapshot.settingsSnapshot.values.plannerConfirmationPolicy === 'risk_only' &&
      plan.risks.some(r => r.severity === 'blocking' || r.severity === 'error'));

  await savePlan(
    runId,
    plan,
    needsConfirm ? 'pending' : 'not_required',
  );

  if (needsConfirm) {
    await casUpdateRunState(runId, ['running'], {
      state: 'awaiting_user',
      stage: 'awaiting_user',
      tokenUsageJson: JSON.stringify({ stages: tokenUsage }),
    });
    return;
  }

  await continueFromWriter(runId, snapshot, plan, {
    call,
    persistUsage,
    tokenUsage,
    deterministicOnly: opts.deterministicOnly,
    signal: opts.signal,
  });
}

/**
 * Build the per-stage LLM caller used by continueFromWriter. Shared by
 * confirmPlanAndContinue and resumeInterruptedRun so both resolve config ids
 * from the FROZEN snapshot (resolvedModelConfigIds) via the injected caller or
 * the default caller, never from the live active config mid-run.
 */
function buildStageCaller(
  callStage: StageLlmCaller | undefined,
  controller: AbortController,
  projectId: number,
  runId: string,
  tokenUsage: Record<string, any>,
) {
  return async (
    stage: string,
    messages: ChatMessage[],
    maxTokens: number,
    configId: number | null,
    responseFormat?: 'json_object' | 'text',
  ): Promise<string> => {
    if (callStage) {
      const r = await callStage({
        stage,
        messages,
        maxTokens,
        configId,
        responseFormat,
      });
      tokenUsage[stage] = r.usage ?? {};
      return r.text;
    }
    const r = await defaultStageCaller({
      stage,
      messages,
      maxTokens,
      configId,
      responseFormat,
      signal: controller.signal,
      projectId,
      runId,
    });
    tokenUsage[stage] = r.usage ?? {};
    return r.text;
  };
}

/**
 * Terminalize a run after a stage exception (fix-plan §5.2). Mirrors the
 * startContinuationRun catch: abort → cancelled, anything else → failed. The
 * run must never be left in `running`. Safe to call from finally-less contexts
 * because it only transitions out of running/awaiting_user.
 */
async function finalizeRunOnError(
  runId: string,
  controller: AbortController,
  err: unknown,
): Promise<void> {
  try {
    if (controller.signal.aborted) {
      await casUpdateRunState(runId, ['running', 'awaiting_user'], {
        state: 'cancelled',
        errorCode: 'cancelled',
        errorMessage: '用户取消',
        completedAt: new Date().toISOString(),
      });
    } else {
      await casUpdateRunState(runId, ['running', 'awaiting_user', 'queued'], {
        state: 'failed',
        errorCode:
          err instanceof ContinuationCapabilityBlockedError
            ? err.code
            : 'stage_failed',
        errorMessage: err instanceof Error ? err.message : String(err),
        completedAt: new Date().toISOString(),
      });
    }
  } catch {
    // best-effort; the run may already be in a terminal state from a parallel
    // cancel/abandon. Never throw out of error finalization.
  }
}

export async function confirmPlanAndContinue(
  runId: string,
  callStage?: StageLlmCaller,
  deterministicOnly?: boolean,
): Promise<void> {
  const run = await getRunById(runId);
  if (!run) throw new Error('run 不存在');
  if (run.state === 'outdated') throw new ContinuationOutdatedError();
  if (run.state !== 'awaiting_user' || run.stage !== 'awaiting_user') {
    throw new Error('当前不在等待 Planner 确认状态');
  }
  const planRow = await getPlan(runId);
  if (!planRow) throw new Error('缺少 plan');
  await savePlan(runId, planRow.plan, 'confirmed');
  const snapshot = JSON.parse(
    run.contextSnapshotJson!,
  ) as ContinuationContextSnapshot;
  const controller = new AbortController();
  activeControllers.set(runId, controller);
  await casUpdateRunState(runId, ['awaiting_user'], {
    state: 'running',
    stage: 'writer',
  });

  const tokenUsage: Record<string, any> = {};
  const call = buildStageCaller(callStage, controller, run.projectId, runId, tokenUsage);

  // Fix-plan §5.2: wrap the stage execution in the same try/catch/finally as
  // startContinuationRun so an exception cannot leave the controller dangling
  // or the run stuck in `running`. Cancellation → cancelled; other errors →
  // failed. The run must always reach a terminal/recoverable state.
  try {
    await continueFromWriter(runId, snapshot, planRow.plan, {
      call,
      persistUsage: async stage => {
        await casUpdateRunState(runId, ['running'], {
          stage: stage as any,
          tokenUsageJson: JSON.stringify({ stages: tokenUsage }),
        });
      },
      tokenUsage,
      deterministicOnly,
      signal: controller.signal,
    });
  } catch (err) {
    await finalizeRunOnError(runId, controller, err);
    throw err;
  } finally {
    activeControllers.delete(runId);
  }
}

async function continueFromWriter(
  runId: string,
  snapshot: ContinuationContextSnapshot,
  plan: ContinuationPlan,
  opts: {
    call: (
      stage: string,
      messages: ChatMessage[],
      maxTokens: number,
      configId: number | null,
      responseFormat?: 'json_object' | 'text',
    ) => Promise<string>;
    persistUsage: (stage: string) => Promise<void>;
    tokenUsage: Record<string, any>;
    deterministicOnly?: boolean;
    signal: AbortSignal;
    /** When resuming an interrupted checker/repair, skip writer regeneration
     * and re-check the existing artifact instead (fix-plan §5.2: never treat a
     * half-finished stream as complete; a persisted artifact is always whole). */
    existingArtifact?: ContinuationArtifact | null;
  },
): Promise<void> {
  let artifact: ContinuationArtifact;
  let body: string;
  if (opts.existingArtifact) {
    // Resume into the checker/repair loop with the already-persisted artifact.
    artifact = opts.existingArtifact;
    body = artifact.content;
  } else {
    await opts.persistUsage('writer');
    const writerMsgs = compileWriterMessages(snapshot, plan);
    body = await opts.call(
      'writer',
      writerMsgs,
      Math.min(4096, snapshot.settingsSnapshot.values.targetChapterChars * 2),
      snapshot.settingsSnapshot.resolvedModelConfigIds.writer,
      'text',
    );
    if (!body.trim()) {
      throw new Error('Writer 未返回正文');
    }
    artifact = await insertArtifact({
      runId,
      stage: 'writer',
      content: body,
    });
  }

  const settings = snapshot.settingsSnapshot.values;
  let repairRound = 0;
  const maxRounds = settings.maxRepairRounds;

  while (true) {
    if (opts.signal.aborted) throw new Error('cancelled');
    if (!settings.checkerEnabled) break;

    await opts.persistUsage('checker');
    let issues = runDeterministicChecks(artifact.content, snapshot);
    if (!opts.deterministicOnly) {
      try {
        const raw = await opts.call(
          'checker',
          compileCheckerMessages(snapshot, artifact.content),
          1500,
          snapshot.settingsSnapshot.resolvedModelConfigIds.checker,
          'json_object',
        );
        issues = issues.concat(parseCheckerLlmJson(raw));
      } catch {
        // keep deterministic only
      }
    }
    const allowed = new Set(snapshot.bundles.canon.evidenceRefs);
    issues = filterBySettings(
      bindIssuesToArtifact(issues, artifact.content, allowed),
      settings,
    );
    await insertCheckResults(
      issues.map(i => ({
        runId,
        chapterId: snapshot.targetChapterId,
        artifactId: artifact.id,
        artifactHash: artifact.contentHash,
        ...i,
      })),
    );

    const openChecks = (await listChecksForArtifact(runId, artifact.id)).filter(
      c => c.resolutionStatus === 'open',
    );
    if (!shouldRunRepair(openChecks, maxRounds, repairRound)) break;

    await opts.persistUsage('repair');
    repairRound += 1;
    let repaired = tryDeterministicRepair(artifact.content, openChecks);
    if (!repaired && !opts.deterministicOnly) {
      repaired = await opts.call(
        'repair',
        compileRepairMessages(snapshot, artifact.content, openChecks),
        Math.min(4096, artifact.content.length + 500),
        snapshot.settingsSnapshot.resolvedModelConfigIds.repair,
        'text',
      );
    }
    if (!repaired || repaired === artifact.content) break;

    await markChecksObsolete(runId, artifact.id);
    artifact = await insertArtifact({
      runId,
      stage: 'repair',
      content: repaired,
      repairRound,
      parentArtifactId: artifact.id,
    });
    body = repaired;
  }

  await casUpdateRunState(runId, ['running'], {
    state: 'awaiting_user',
    stage: 'awaiting_user',
    tokenUsageJson: JSON.stringify({ stages: opts.tokenUsage }),
  });
  activeControllers.delete(runId);
}

export async function cancelContinuationRun(runId: string): Promise<void> {
  const c = activeControllers.get(runId);
  c?.abort();
  activeControllers.delete(runId);
  await casUpdateRunState(runId, ['queued', 'running', 'awaiting_user'], {
    state: 'cancelled',
    errorCode: 'cancelled',
    errorMessage: '用户取消',
    completedAt: new Date().toISOString(),
  });
}

/**
 * Verify the run's frozen Source/Canon snapshot still matches the project's
 * current active Source/Canon (fix-plan §6.1). If they diverge, atomically mark
 * the run `outdated` and throw so adoption is refused — defense-in-depth on top
 * of the change-time invalidation calls (which can race). The run's sourceId /
 * canonSnapshotId / canonRevision were captured at creation; we compare them
 * against the live continuation_settings + active Canon snapshot.
 */
async function assertContextFreshOrMarkOutdated(
  run: ContinuationGenerationRun,
): Promise<void> {
  // Only runs that captured a Source/Canon snapshot need a freshness check.
  // A run with neither was created outside the full continuation flow (e.g. a
  // test fixture) and should not be blocked here.
  if (run.sourceId == null && !run.canonSnapshotId) return;

  const db = await openDatabase();
  const [settingsRes] = await db.executeSql(
    'SELECT active_source_id, active_canon_snapshot_id FROM continuation_settings WHERE project_id = ?',
    [run.projectId],
  );
  if (settingsRes.rows.length === 0) {
    // No settings row means the source was deleted; mark outdated.
    await casUpdateRunState(run.id, ['awaiting_user', 'interrupted'], {
      state: 'outdated',
      errorCode: 'outdated',
      errorMessage: 'source_missing',
      completedAt: new Date().toISOString(),
    });
    throw new ContinuationOutdatedError();
  }
  const settings = settingsRes.rows.item(0);
  const activeSourceId = settings.active_source_id;
  // Source mismatch (run frozen a source that is no longer active).
  if (
    run.sourceId != null &&
    Number(activeSourceId) !== Number(run.sourceId)
  ) {
    await casUpdateRunState(run.id, ['awaiting_user', 'interrupted'], {
      state: 'outdated',
      errorCode: 'outdated',
      errorMessage: 'source_changed',
      completedAt: new Date().toISOString(),
    });
    throw new ContinuationOutdatedError();
  }
  // Canon snapshot mismatch: compare active snapshot id + revision.
  const activeCanonId = settings.active_canon_snapshot_id;
  if (run.canonSnapshotId || activeCanonId) {
    if (
      !activeCanonId ||
      !run.canonSnapshotId ||
      String(activeCanonId) !== String(run.canonSnapshotId)
    ) {
      await casUpdateRunState(run.id, ['awaiting_user', 'interrupted'], {
        state: 'outdated',
        errorCode: 'outdated',
        errorMessage: 'canon_snapshot_changed',
        completedAt: new Date().toISOString(),
      });
      throw new ContinuationOutdatedError();
    }
    // Same snapshot id — verify its revision hasn't been bumped since the run.
    const [snapRes] = await db.executeSql(
      'SELECT revision FROM continuation_canon_snapshots WHERE id = ?',
      [activeCanonId],
    );
    if (snapRes.rows.length === 0) {
      await casUpdateRunState(run.id, ['awaiting_user', 'interrupted'], {
        state: 'outdated',
        errorCode: 'outdated',
        errorMessage: 'canon_snapshot_deleted',
        completedAt: new Date().toISOString(),
      });
      throw new ContinuationOutdatedError();
    }
    const currentRevision = Number(snapRes.rows.item(0).revision);
    if (currentRevision !== Number(run.canonRevision)) {
      await casUpdateRunState(run.id, ['awaiting_user', 'interrupted'], {
        state: 'outdated',
        errorCode: 'outdated',
        errorMessage: 'canon_revision_changed',
        completedAt: new Date().toISOString(),
      });
      throw new ContinuationOutdatedError();
    }
  }
}

/**
 * Adopt selected artifact as chapter draft only.
 * No proposal/event/Story Memory LLM (Spec §10.3).
 */
export async function adoptArtifactAsDraft(input: {
  runId: string;
  artifactId?: string;
  /** Force overwrite when chapter content hash differs from input_revision_hash. */
  forceOverwrite?: boolean;
}): Promise<{ contentHash: string }> {
  const run = await getRunById(input.runId);
  if (!run) throw new Error('run 不存在');
  if (run.state === 'outdated') throw new ContinuationOutdatedError();
  if (run.state !== 'awaiting_user' && run.state !== 'interrupted') {
    throw new Error(`run 状态 ${run.state} 不可采纳`);
  }

  // Fix-plan §6.1: re-check that the active Source and Canon snapshot still
  // match the run's frozen snapshot before adopting. If Source/Canon changed
  // since this run was created, atomically mark the run outdated and refuse
  // adoption — the user must re-launch against the latest context. This is a
  // defense-in-depth check on top of the invalidation calls fired at change
  // time (which are best-effort and can race).
  await assertContextFreshOrMarkOutdated(run);

  // Fix-plan §7.1: when an explicit artifactId is given, the artifact MUST
  // belong to this run. getArtifactForRun matches both id AND run_id, so a
  // swapped or foreign artifact id is rejected at the data layer. Ownership is
  // never relaxed by forceOverwrite.
  const artifact =
    (input.artifactId
      ? await getArtifactForRun(run.id, input.artifactId)
      : await getLatestArtifact(run.id)) ?? null;
  if (!artifact) {
    throw new Error(
      input.artifactId
        ? '指定的正文不属于本次续写，无法采纳'
        : '没有可采纳的正文',
    );
  }

  const db = await openDatabase();
  // Read content + updated_at for optimistic concurrency (fix-plan §7.3). The
  // chapter UPDATE below re-checks updated_at in its WHERE clause so a
  // concurrent edit between this read and the transaction is detected and the
  // whole adopt is refused rather than silently overwriting the user's edit.
  const [ch] = await db.executeSql(
    'SELECT content, title, status, updated_at FROM chapters WHERE id = ?',
    [run.chapterId],
  );
  if (ch.rows.length === 0) throw new Error('章节不存在');
  const chapter = ch.rows.item(0);
  const currentContent = String(chapter.content ?? '');
  const currentUpdatedAt = String(chapter.updated_at ?? '');
  const currentHash = contentRevisionHash(currentContent);
  if (
    currentContent.trim().length > 0 &&
    currentHash !== run.inputRevisionHash &&
    !input.forceOverwrite
  ) {
    throw new ContinuationConflictError(
      '章节在生成期间已被编辑，请确认覆盖后再采纳',
    );
  }

  const adoptedHash = artifact.contentHash;
  const ts = new Date().toISOString();

  // Fix-plan §7.2: claim the run first via CAS. If the run was concurrently
  // cancelled/abandoned/outdated (no longer awaiting_user/interrupted), the CAS
  // fails and we refuse to write the chapter — the adopt cannot succeed against
  // a run that is no longer adoptable.
  const claimed = await casUpdateRunState(
    run.id,
    ['awaiting_user', 'interrupted'],
    {
      state: 'completed',
      completionReason: 'adopted',
      adoptedRevisionHash: adoptedHash,
      completedAt: ts,
    },
  );
  if (!claimed) {
    // Re-read to give a precise error; the run may now be outdated/completed.
    const fresh = await getRunById(run.id);
    if (fresh?.state === 'outdated') throw new ContinuationOutdatedError();
    throw new ContinuationConflictError('续写状态已变更，无法采纳');
  }

  // Single local transaction: revision snapshot + write draft content with
  // optimistic concurrency. Never call LLM here. If the chapter was edited
  // concurrently (updated_at changed), the UPDATE affects 0 rows and we surface
  // a conflict. The provisional run claim is reverted below so the user can
  // retry instead of being stranded behind a false adopted state.
  let chapterRowsAffected = 0;
  const statements: Array<{ sql: string; params?: any[] }> = [
    {
      sql: `INSERT INTO content_revisions (
        project_id, target_type, target_id, title, content, source, source_ref, created_at
      ) VALUES (?, 'chapter', ?, ?, ?, 'before_pipeline_accept', ?, ?)`,
      params: [
        run.projectId,
        run.chapterId,
        String(chapter.title ?? ''),
        currentContent,
        run.id,
        ts,
      ],
    },
    {
      sql: `UPDATE chapters SET content = ?, status = CASE WHEN status = 'finalized' THEN status ELSE 'draft' END, updated_at = ?
        WHERE id = ? AND updated_at = ?`,
      params: [artifact.content, ts, run.chapterId, currentUpdatedAt],
    },
  ];
  await executeTransaction(db, statements, {
    onStatementComplete: (idx, rowsAffected) => {
      // Statement 2 (1-based) is the chapter UPDATE with the optimistic lock.
      if (idx === 2) chapterRowsAffected = rowsAffected;
    },
  });

  if (chapterRowsAffected === 0) {
    // The chapter changed under us. Restore an adoptable state only if this
    // invocation still owns the provisional adoption.
    await casUpdateRunState(run.id, ['completed'], {
      state: 'awaiting_user',
      completionReason: null,
      adoptedRevisionHash: null,
      completedAt: null,
      errorCode: 'adoption_conflict',
      errorMessage: '章节在采纳期间被并发编辑，请重试',
    });
    throw new ContinuationConflictError(
      '章节在采纳期间被并发编辑，正文未覆盖，请重试',
    );
  }

  return { contentHash: adoptedHash };
}

export async function abandonRun(runId: string): Promise<void> {
  const ok = await casUpdateRunState(
    runId,
    ['awaiting_user', 'interrupted', 'running', 'queued'],
    {
      state: 'completed',
      completionReason: 'abandoned',
      completedAt: new Date().toISOString(),
    },
  );
  if (!ok) {
    const run = await getRunById(runId);
    if (run?.state === 'completed') return;
    throw new Error('无法放弃该 run');
  }
  activeControllers.get(runId)?.abort();
  activeControllers.delete(runId);
}

/**
 * Finalize chapter: mark finalized, dirty SM, link source run and enqueue
 * extract_state outbox — all in ONE local transaction (Spec §11.1, fix-plan §2).
 *
 * Previously the outbox INSERT and the run linkage update ran after the
 * chapters/story-memory transaction committed. If the app was killed in that
 * window the chapter was finalized but no state-extraction task was ever
 * enqueued, silently dropping Story Memory rebuild. They now share a single
 * atomic commit so the chapter cannot reach `finalized` without its
 * extraction task. The post-commit `processContinuationOutbox({ limit: 1 })`
 * call is best-effort acceleration only; reliable delivery is the outbox +
 * cold-start path, never this fire-and-forget trigger.
 *
 * Does NOT call LLM in the transaction.
 */
export async function finalizeContinuationChapter(input: {
  projectId: number;
  chapterId: number;
  content: string;
  sourceRunId?: string | null;
}): Promise<{ revisionHash: string; outboxDedupeKey: string }> {
  const revisionHash = contentRevisionHash(input.content);
  const db = await openDatabase();
  const [ch] = await db.executeSql(
    'SELECT position FROM chapters WHERE id = ?',
    [input.chapterId],
  );
  if (ch.rows.length === 0) throw new Error('章节不存在');
  const position = ch.rows.item(0).position as number;
  const ts = new Date().toISOString();

  // Spec §5.1 / fix-plan §5.1: the authoritative frozen field is
  // `resolvedModelConfigIds` (built by continuationContextBuilder). The legacy
  // `resolvedLlmConfigIds` key was never written, so it silently read as null
  // and State Extraction fell back to the live active config on every run.
  let frozenStateExtractionConfigId: number | null = null;
  let missingFrozenConfigReason: string | null = null;
  if (input.sourceRunId) {
    const sourceRun = await getRunById(input.sourceRunId);
    if (sourceRun) {
      try {
        const snapshot = JSON.parse(sourceRun.settingsSnapshotJson);
        const resolved = snapshot?.resolvedModelConfigIds?.stateExtraction;
        if (typeof resolved === 'number') {
          frozenStateExtractionConfigId = resolved;
        } else {
          // Old / corrupt snapshot: stay safe (null) but record the reason in
          // the outbox payload so the worker and UI can surface it without
          // logging the prompt or chapter body.
          missingFrozenConfigReason =
            snapshot?.resolvedModelConfigIds == null
              ? 'snapshot_missing_resolved_model_config_ids'
              : 'snapshot_state_extraction_not_number';
        }
      } catch {
        frozenStateExtractionConfigId = null;
        missingFrozenConfigReason = 'settings_snapshot_json_unparseable';
      }
    }
  }

  const dedupeKey = `extract_state:${input.chapterId}:${revisionHash}`;
  const outboxId = `co_${v4().replace(/-/g, '')}`;

  const statements: Array<{ sql: string; params?: any[] }> = [
    {
      sql: 'INSERT OR IGNORE INTO project_story_memory (project_id, updated_at) VALUES (?, ?)',
      params: [input.projectId, ts],
    },
    {
      sql: `UPDATE chapters SET content = ?, status = 'finalized',
        finalized_at = ?, updated_at = ? WHERE id = ?`,
      params: [input.content, ts, ts, input.chapterId],
    },
    {
      sql: `UPDATE project_story_memory SET status = 'dirty',
        dirty_from_position = CASE
          WHEN dirty_from_position IS NULL THEN ?
          WHEN dirty_from_position > ? THEN ?
          ELSE dirty_from_position
        END,
        updated_at = ?
      WHERE project_id = ?`,
      params: [position, position, position, ts, input.projectId],
    },
  ];

  // Link the finalized hash onto the source run inside the same tx so the
  // chapter and its run linkage commit or roll back together.
  if (input.sourceRunId) {
    statements.push({
      sql: `UPDATE continuation_generation_runs
        SET finalized_revision_hash = ?, updated_at = ?
        WHERE id = ? AND state IN ('completed', 'awaiting_user', 'interrupted')`,
      params: [revisionHash, ts, input.sourceRunId],
    });
  }

  // INSERT OR IGNORE: re-tapping finalize for an unchanged chapter never
  // duplicates the extract_state task (UNIQUE(dedupe_key)).
  statements.push(
    buildOutboxInsertStatement({
      id: outboxId,
      projectId: input.projectId,
      chapterId: input.chapterId,
      operation: 'extract_state',
      payload: {
        projectId: input.projectId,
        chapterId: input.chapterId,
        chapterRevisionHash: revisionHash,
        sourceRunId: input.sourceRunId ?? null,
        llmConfigId: frozenStateExtractionConfigId,
        // Visible audit hint only — never the prompt or chapter body.
        configNote: missingFrozenConfigReason,
      },
      dedupeKey,
      ts,
    }),
  );

  await executeTransaction(db, statements);

  // Best-effort acceleration only. Reliable delivery is the outbox + cold
  // start path (markRunsInterruptedOnColdStart + processContinuationOutbox),
  // never this fire-and-forget trigger.
  processContinuationOutbox({ limit: 1 }).catch(() => {});

  return { revisionHash, outboxDedupeKey: dedupeKey };
}

/**
 * Resume an interrupted run from its last persisted stage boundary
 * (fix-plan §5.2). Every branch is wrapped in try/catch/finally so the run can
 * never be left in `running` after a resume attempt.
 *
 * Branch table (last persisted stage):
 *  - context / planner           → CAS interrupted→running, re-run from planner
 *  - writer, has plan, no artifact → CAS then continue directly from writer
 *  - checker / repair, has artifact → CAS then continue from writer (which
 *      re-checks/repairs the existing artifact; a half-finished network stream
 *      is never treated as a completed artifact)
 *  - awaiting_user (artifact present) → CAS interrupted→awaiting_user, no model
 *
 * The old implementation called confirmPlanAndContinue() for the Writer-paused
 * case, but that function only accepts awaiting_user, so it always threw —
 * leaving the run interrupted with no way forward. We now resume from the
 * Writer directly using the frozen snapshot + confirmed/available plan.
 */
export async function resumeInterruptedRun(
  runId: string,
  callStage?: StageLlmCaller,
  deterministicOnly?: boolean,
): Promise<void> {
  const run = await getRunById(runId);
  if (!run) throw new Error('run 不存在');
  if (run.state === 'outdated') throw new ContinuationOutdatedError();
  if (run.state !== 'interrupted') throw new Error('仅 interrupted 可恢复');
  if (!run.contextSnapshotJson) {
    throw new Error('缺少冻结 context，请重新发起');
  }
  const snapshot = JSON.parse(
    run.contextSnapshotJson,
  ) as ContinuationContextSnapshot;

  // Branch: context / planner → re-run the whole stage pipeline from planner.
  if (run.stage === 'planner' || run.stage === 'context') {
    const ok = await casUpdateRunState(runId, ['interrupted'], {
      state: 'running',
      stage: 'planner',
    });
    if (!ok) return; // someone else already moved this run
    const controller = new AbortController();
    activeControllers.set(runId, controller);
    try {
      await runStages(runId, snapshot, {
        callStage,
        deterministicOnly,
        signal: controller.signal,
        projectId: run.projectId,
      });
    } catch (err) {
      await finalizeRunOnError(runId, controller, err);
      throw err;
    } finally {
      activeControllers.delete(runId);
    }
    return;
  }

  // Branch: awaiting_user with an artifact → hand back to the user without
  // invoking any model.
  const art = await getLatestArtifact(runId);
  if (art && run.stage === 'awaiting_user') {
    await casUpdateRunState(runId, ['interrupted'], {
      state: 'awaiting_user',
      stage: 'awaiting_user',
    });
    return;
  }

  // Branch: checker / repair paused with an existing artifact → re-run the
  // checker/repair loop on the persisted artifact (fix-plan §5.2). We never
  // treat a half-finished network stream as complete; only a persisted artifact
  // (which is always whole) is eligible.
  if (art && (run.stage === 'checker' || run.stage === 'repair')) {
    const planRowCr = await getPlan(runId);
    if (!planRowCr) {
      throw new Error('缺少规划，无法恢复，请重新发起续写');
    }
    const ok = await casUpdateRunState(runId, ['interrupted'], {
      state: 'running',
      stage: 'checker',
    });
    if (!ok) return;
    const controller = new AbortController();
    activeControllers.set(runId, controller);
    const tokenUsage: Record<string, any> = {};
    const call = buildStageCaller(callStage, controller, run.projectId, runId, tokenUsage);
    try {
      await continueFromWriter(runId, snapshot, planRowCr.plan, {
        call,
        persistUsage: async stage => {
          await casUpdateRunState(runId, ['running'], {
            stage: stage as any,
            tokenUsageJson: JSON.stringify({ stages: tokenUsage }),
          });
        },
        tokenUsage,
        deterministicOnly,
        signal: controller.signal,
        existingArtifact: art,
      });
    } catch (err) {
      await finalizeRunOnError(runId, controller, err);
      throw err;
    } finally {
      activeControllers.delete(runId);
    }
    return;
  }

  // Branch: Writer paused with a plan but no/partial artifact → resume directly
  // from the Writer using the frozen snapshot + the stored plan. A pending plan
  // remains subject to explicit user confirmation after recovery.
  const planRow = await getPlan(runId);
  if (!planRow) {
    // No plan at all — cannot resume the Writer; surface to the user.
    throw new Error('缺少规划，无法恢复，请重新发起续写');
  }
  if (planRow.confirmationStatus === 'pending') {
    await casUpdateRunState(runId, ['interrupted'], {
      state: 'awaiting_user',
      stage: 'awaiting_user',
    });
    return;
  }
  const ok = await casUpdateRunState(runId, ['interrupted'], {
    state: 'running',
    stage: run.stage === 'writer' ? 'writer' : 'writer',
  });
  if (!ok) return;
  const controller = new AbortController();
  activeControllers.set(runId, controller);
  const tokenUsage: Record<string, any> = {};
  const call = buildStageCaller(callStage, controller, run.projectId, runId, tokenUsage);
  try {
    await continueFromWriter(runId, snapshot, planRow.plan, {
      call,
      persistUsage: async stage => {
        await casUpdateRunState(runId, ['running'], {
          stage: stage as any,
          tokenUsageJson: JSON.stringify({ stages: tokenUsage }),
        });
      },
      tokenUsage,
      deterministicOnly,
      signal: controller.signal,
    });
  } catch (err) {
    await finalizeRunOnError(runId, controller, err);
    throw err;
  } finally {
    activeControllers.delete(runId);
  }
}

export function isContinuationRunId(id: string): boolean {
  return id.startsWith('ct_');
}

export async function outdatedRunsOnSourceOrCanonChange(
  projectId: number,
  reason: string,
): Promise<void> {
  await markRunsOutdatedForProject(projectId, reason);
}

export type { ContinuationRunState };
