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
  casUpdateRunState,
  contentRevisionHash,
  enqueueOutbox,
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
  const call = async (
    stage: string,
    messages: ChatMessage[],
    maxTokens: number,
    configId: number | null,
    responseFormat?: 'json_object' | 'text',
  ) => {
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
      projectId: run.projectId,
      runId,
    });
    tokenUsage[stage] = r.usage ?? {};
    return r.text;
  };

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
  },
): Promise<void> {
  await opts.persistUsage('writer');
  const writerMsgs = compileWriterMessages(snapshot, plan);
  let body = await opts.call(
    'writer',
    writerMsgs,
    Math.min(4096, snapshot.settingsSnapshot.values.targetChapterChars * 2),
    snapshot.settingsSnapshot.resolvedModelConfigIds.writer,
    'text',
  );
  if (!body.trim()) {
    throw new Error('Writer 未返回正文');
  }
  let artifact = await insertArtifact({
    runId,
    stage: 'writer',
    content: body,
  });

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

  const artifact =
    (input.artifactId
      ? await (async () => {
          const { getArtifactById } = await import('./generationRepository');
          return getArtifactById(input.artifactId!);
        })()
      : await getLatestArtifact(run.id)) ?? null;
  if (!artifact) throw new Error('没有可采纳的正文');

  const db = await openDatabase();
  const [ch] = await db.executeSql(
    'SELECT content, title, status FROM chapters WHERE id = ?',
    [run.chapterId],
  );
  if (ch.rows.length === 0) throw new Error('章节不存在');
  const currentContent = String(ch.rows.item(0).content ?? '');
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
  const chapter = ch.rows.item(0);

  // Single local transaction: revision snapshot + write draft content + mark run.
  // Never call LLM here.
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
      sql: `UPDATE chapters SET content = ?, status = CASE WHEN status = 'finalized' THEN status ELSE 'draft' END, updated_at = ? WHERE id = ?`,
      params: [artifact.content, ts, run.chapterId],
    },
    {
      sql: `UPDATE continuation_generation_runs
        SET state = 'completed', completion_reason = 'adopted',
            adopted_revision_hash = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND state IN ('awaiting_user', 'interrupted')`,
      params: [adoptedHash, ts, ts, run.id],
    },
  ];
  await executeTransaction(db, statements);

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
 * Finalize chapter: mark finalized, dirty SM, enqueue extract_state outbox.
 * Does NOT call LLM in the transaction (Spec §11.1).
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

  let frozenStateExtractionConfigId: number | null = null;
  if (input.sourceRunId) {
    const sourceRun = await getRunById(input.sourceRunId);
    if (sourceRun) {
      try {
        frozenStateExtractionConfigId = JSON.parse(
          sourceRun.settingsSnapshotJson,
        ).resolvedLlmConfigIds?.stateExtraction ?? null;
      } catch {
        frozenStateExtractionConfigId = null;
      }
    }
  }

  await executeTransaction(
    db,
    [
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
    ],
  );

  if (input.sourceRunId) {
    await casUpdateRunState(input.sourceRunId, ['completed', 'awaiting_user'], {
      finalizedRevisionHash: revisionHash,
    });
  }

  const dedupeKey = `extract_state:${input.chapterId}:${revisionHash}`;
  await enqueueOutbox({
    projectId: input.projectId,
    chapterId: input.chapterId,
    operation: 'extract_state',
    payload: {
      projectId: input.projectId,
      chapterId: input.chapterId,
      chapterRevisionHash: revisionHash,
      sourceRunId: input.sourceRunId ?? null,
      llmConfigId: frozenStateExtractionConfigId,
    },
    dedupeKey,
  });

  // The worker claims items with CAS, so this is safe on repeated finalize
  // taps and complements the cold-start recovery path.
  processContinuationOutbox({ limit: 1 }).catch(() => {});

  return { revisionHash, outboxDedupeKey: dedupeKey };
}

export async function resumeInterruptedRun(
  runId: string,
  callStage?: StageLlmCaller,
  deterministicOnly?: boolean,
): Promise<void> {
  const run = await getRunById(runId);
  if (!run) throw new Error('run 不存在');
  if (run.state !== 'interrupted') throw new Error('仅 interrupted 可恢复');
  if (!run.contextSnapshotJson) {
    throw new Error('缺少冻结 context，请重新发起');
  }
  // Resume only from last persisted stage boundary.
  if (run.stage === 'planner' || run.stage === 'context') {
    // re-run from planner
    await casUpdateRunState(runId, ['interrupted'], {
      state: 'running',
      stage: 'planner',
    });
    const snapshot = JSON.parse(
      run.contextSnapshotJson,
    ) as ContinuationContextSnapshot;
    const controller = new AbortController();
    activeControllers.set(runId, controller);
    await runStages(runId, snapshot, {
      callStage,
      deterministicOnly,
      signal: controller.signal,
      projectId: run.projectId,
    });
    return;
  }
  // If writer already produced artifact, jump to awaiting_user
  const art = await getLatestArtifact(runId);
  if (art) {
    await casUpdateRunState(runId, ['interrupted'], {
      state: 'awaiting_user',
      stage: 'awaiting_user',
    });
    return;
  }
  await confirmPlanAndContinue(runId, callStage, deterministicOnly);
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
