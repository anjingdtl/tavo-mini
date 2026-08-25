/**
 * Pure pipeline state-machine decision function.
 *
 * Single source of truth for "what should happen next" on first run and resume.
 * Must not read live settings, call LLM, or touch SQLite.
 *
 * Invariant: given the same persisted task + checkpoints, always returns the
 * same action (idempotent plan). Execution CAS lives outside this function.
 */

import type { PipelineMode, PipelineStageName } from '../../types/pipeline';
import { getCheckpoint } from './projectStageCheckpoints';
import { isCompactPipelineTopology } from './outlineWorkflowVersion';
import { MAX_AUTO_RETRY_ATTEMPTS } from '../llm/requestPolicy';
import type {
  PersistedPipelineTaskView,
  PersistedStageCheckpoint,
  PipelineAction,
  PipelineError,
  StageStatus,
} from './types';

/**
 * CL-01: retry disposition for a FAILED stage checkpoint, decided BEFORE any
 * terminal `blocked(STAGE_FAILED)` is emitted.
 *
 * Pure decision — reads only the latest persisted attempt row:
 *   - safe_to_retry / rate_limit, not due      → wait_retry
 *   - safe_to_retry / rate_limit, due, in-limit → retry_now
 *   - safe_to_retry / rate_limit, over limit    → manual_pause
 *   - outcome_unknown                           → manual_confirm (never auto-retry)
 *   - anything else                             → fail (STAGE_FAILED as before)
 */
export type RetryDisposition =
  | { kind: 'wait_retry'; retryAt: number }
  | { kind: 'retry_now' }
  | { kind: 'manual_pause'; message: string }
  | { kind: 'manual_confirm'; message: string }
  | { kind: 'fail' };

export function determineRetryDisposition(attempt: {
  status?: string | null;
  failureClass?: string | null;
  attemptNo?: number | null;
  nextRetryAt?: number | null;
}): RetryDisposition {
  const status = String(attempt.status ?? '');
  const failureClass = String(attempt.failureClass ?? '');
  const attemptNo = Number(attempt.attemptNo ?? 0);

  if (status === 'outcome_unknown' || failureClass === 'outcome_unknown') {
    return {
      kind: 'manual_confirm',
      message: '请求可能已执行但结果未知，请确认后重新执行或更换模型',
    };
  }
  if (
    status === 'safe_to_retry' &&
    (failureClass === 'safe_retry' || failureClass === 'rate_limit')
  ) {
    if (attemptNo > MAX_AUTO_RETRY_ATTEMPTS) {
      return {
        kind: 'manual_pause',
        message: `已超过自动重试上限（${MAX_AUTO_RETRY_ATTEMPTS} 次），请稍后手动重试`,
      };
    }
    const retryAt = attempt.nextRetryAt ?? Date.now();
    if (retryAt > Date.now()) return { kind: 'wait_retry', retryAt };
    return { kind: 'retry_now' };
  }
  if (failureClass === 'response_invalid') {
    return {
      kind: 'manual_pause',
      message:
        '模型已返回，但结构化合同无效；已阻断该阶段，请从失败节点重试，不会按“结果未知”重复请求',
    };
  }
  return { kind: 'fail' };
}

function blocked(
  code: PipelineError['code'],
  message: string,
  extra?: Partial<PipelineError>,
): PipelineAction {
  return {
    type: 'blocked',
    reason: {
      code,
      message,
      userAction: extra?.userAction ?? 'none',
      stage: extra?.stage,
      diagnostics: extra?.diagnostics,
    },
  };
}

function isOpen(status: StageStatus): boolean {
  return status === 'pending' || status === 'interrupted';
}

function hasUsableFinalText(task: PersistedPipelineTaskView): boolean {
  return typeof task.finalText === 'string' && task.finalText.length > 0;
}

function anyRunning(
  stages: PersistedStageCheckpoint[],
): PersistedStageCheckpoint | null {
  return stages.find(s => s.status === 'running') || null;
}

function requireMode(task: PersistedPipelineTaskView): PipelineMode | null {
  return task.pipelineMode;
}

/**
 * Decide the next durable action for a pipeline task.
 *
 * Preconditions expected from the reconciler (not enforced here as hard throw):
 * - Cold-start has already rewritten process-dead `running` → `interrupted`
 *   before calling this for a *user* resume. If `running` is still present,
 *   we treat it as another executor owning the work.
 */
export function determineNextPipelineAction(
  task: PersistedPipelineTaskView,
  stages: PersistedStageCheckpoint[],
): PipelineAction {
  const status = String(task.status || '');

  if (status === 'cancelled') {
    return blocked('TASK_TERMINAL', '任务已取消', {
      userAction: 'none',
    });
  }

  if (status === 'completed') {
    // Idempotent: nothing left. If finalText missing, still terminal.
    return blocked('TASK_TERMINAL', '任务已完成', { userAction: 'none' });
  }

  const running = anyRunning(stages);
  if (running) {
    return blocked(
      'TASK_ALREADY_RUNNING',
      `阶段 ${running.stage} 正在执行，请勿重复启动`,
      {
        stage: running.stage as PipelineStageName,
        userAction: 'wait',
        diagnostics: { stage: running.stage },
      },
    );
  }

  // --- Snapshot / draft context gate ---------------------------------
  // First durable step: freeze execution + draft context before any LLM.
  if (!task.hasExecutionSnapshot || !task.hasDraftContext) {
    // Interrupted mid-start with no snapshot is not recoverable as resume;
    // reconciler may still call persist_initial_snapshot on a fresh run.
    if (status === 'interrupted' || status === 'failed') {
      // Resume path without snapshot: cannot safely continue.
      if (!task.hasDraftContext && !task.hasExecutionSnapshot) {
        return blocked(
          'TASK_NOT_RECOVERABLE',
          '任务缺少冻结执行配置或草稿上下文，无法安全恢复。请重新开始生成。',
          { userAction: 'restart_task' },
        );
      }
    }
    return { type: 'persist_initial_snapshot' };
  }

  const mode = requireMode(task);
  if (!mode) {
    return blocked(
      'MISSING_EXECUTION_SNAPSHOT',
      '冻结执行配置缺少流水线模式，无法继续。',
      { userAction: 'restart_task' },
    );
  }

  const draft = getCheckpoint(stages, 'draft');
  // Phase 4 (二 §7.2): the unified `qa` stage for the compact Standard. The
  // checkpoint row is named 'qa' for new runs.
  const qaStage = getCheckpoint(stages, 'qa');
  const brief = getCheckpoint(stages, 'brief');
  // Compact Standard (二 Phase §6): the frozen topology omits the Proof node.
  // The final body is the Revision (or Draft) candidate.
  const compact = isCompactPipelineTopology(task.pipelineTopologyVersion);

  // --- Draft ---------------------------------------------------------
  if (isOpen(draft.status)) {
    return { type: 'run_draft' };
  }
  if (draft.status === 'failed') {
    return blocked('STAGE_FAILED', draft.errorMessage || '初稿生成失败', {
      stage: 'draft',
      userAction: 'restart_task',
    });
  }
  if (draft.status !== 'succeeded') {
    // e.g. skipped draft is illegal
    return blocked('UNKNOWN_STATE', `初稿阶段状态非法: ${draft.status}`, {
      stage: 'draft',
      userAction: 'restart_task',
    });
  }

  // --- One-Shot (极速) execution profile --------------------------------
  // The frozen one_shot profile caps the chapter at ONE paid Draft call:
  // review / factCheck / brief / proof are formally skipped during
  // finalize_from_draft, and local FinalValidate + Persist still run. The
  // paid audit stages must never dispatch under this profile.
  if (task.executionProfile === 'one_shot') {
    return decideOneShot(task);
  }

  // --- Topology branches ---------------------------------------------
  // Phase 4 (二 §7.2): compact Standard dispatches ONE QA regardless of
  // pipelineMode. Legacy topologies are offline post-release: any non-compact
  // task fails closed so the UI prompts the user to re-create the task with
  // the unified pipeline.
  if (compact) {
    return decideCompactFull(task, qaStage, brief);
  }
  return blocked(
    'LEGACY_PIPELINE_BLOCKED',
    '该任务使用已下线旧版流水线，不能继续；请按新版流程重新开始生成。',
    { userAction: 'restart_task' },
  );
}

function decideOneShot(
  task: PersistedPipelineTaskView,
): PipelineAction {
  // Draft already succeeded (caller checked). The single paid call is done:
  // persist the final body through the shared local finalize path, then
  // complete. No audit stage may run, so the audit checkpoints are never
  // consulted here.
  if (hasUsableFinalText(task)) {
    if (String(task.status) === 'completed') {
      return blocked('TASK_TERMINAL', '任务已完成', { userAction: 'none' });
    }
    return { type: 'complete' };
  }
  return { type: 'finalize_from_draft', degraded: false };
}

/**
 * Phase 4 (二 §7.2): compact Standard topology has ONE QA stage. Once
 * Draft succeeds, the path is: run_qa → run_brief (if qa verdict is
 * revise) → finalize_from_draft. Proof is intentionally absent (Phase 3
 * §6.4).
 */
function decideCompactFull(
  task: PersistedPipelineTaskView,
  qa: PersistedStageCheckpoint,
  brief: PersistedStageCheckpoint,
): PipelineAction {
  if (isOpen(qa.status)) {
    return { type: 'run_qa' };
  }
  if (qa.status === 'failed') {
    return blocked('STAGE_FAILED', qa.errorMessage || 'QA 失败，请从失败节点重试', {
      stage: 'qa',
      userAction: 'retry',
    });
  }
  if (qa.status === 'skipped') {
    // Formal skip (One-Shot, no findings, etc.) → treat as no Revision.
    if (hasUsableFinalText(task)) {
      if (String(task.status) === 'completed') {
        return blocked('TASK_TERMINAL', '任务已完成', { userAction: 'none' });
      }
      return { type: 'complete' };
    }
    return { type: 'finalize_from_draft' };
  }
  if (qa.status !== 'succeeded') {
    return blocked('UNKNOWN_STATE', `QA 阶段状态非法: ${qa.status}`, {
      stage: 'qa',
      userAction: 'restart_task',
    });
  }
  // QA succeeded → conditionally run Brief / Revision, then local finalize.
  if (isOpen(brief.status)) {
    return { type: 'run_brief' };
  }
  if (brief.status === 'failed') {
    return blocked('STAGE_FAILED', brief.errorMessage || '修订失败，请从失败节点重试', {
      stage: 'brief',
      userAction: 'retry',
    });
  }
  if (brief.status === 'skipped') {
    // Conditional Revision: no executable findings → Draft IS the final.
    if (hasUsableFinalText(task)) {
      if (String(task.status) === 'completed') {
        return blocked('TASK_TERMINAL', '任务已完成', { userAction: 'none' });
      }
      return { type: 'complete' };
    }
    return { type: 'finalize_from_draft' };
  }
  if (brief.status !== 'succeeded') {
    return blocked('UNKNOWN_STATE', `Brief 阶段状态非法: ${brief.status}`, {
      stage: 'brief',
      userAction: 'restart_task',
    });
  }
  if (hasUsableFinalText(task)) {
    if (String(task.status) === 'completed') {
      return blocked('TASK_TERMINAL', '任务已完成', { userAction: 'none' });
    }
    return { type: 'complete' };
  }
  return { type: 'finalize_from_draft' };
}
