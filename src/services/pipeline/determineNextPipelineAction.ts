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

function anyRunning(stages: PersistedStageCheckpoint[]): PersistedStageCheckpoint | null {
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
  const review = getCheckpoint(stages, 'review');
  const factCheck = getCheckpoint(stages, 'factCheck');
  const proof = getCheckpoint(stages, 'proof');

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

  // --- Mode branches -------------------------------------------------
  if (mode === 'noReview') {
    return decideNoReview(task, proof);
  }
  if (mode === 'twoStage') {
    return decideTwoStage(task, review, proof);
  }
  if (mode === 'conditional') {
    return decideConditional(task, factCheck, proof);
  }
  if (mode === 'full') {
    return decideFull(task, review, factCheck, proof);
  }

  return blocked('UNKNOWN_STATE', `未知流水线模式: ${String(mode)}`, {
    userAction: 'restart_task',
  });
}

function decideTerminalOrComplete(
  task: PersistedPipelineTaskView,
): PipelineAction {
  if (statusIsFailedWithFinal(task)) {
    return blocked('TASK_TERMINAL', task.finalText
      ? '任务已失败并保留正文'
      : '任务已失败', {
      userAction: 'none',
    });
  }
  if (hasUsableFinalText(task)) {
    if (String(task.status) === 'completed') {
      return blocked('TASK_TERMINAL', '任务已完成', { userAction: 'none' });
    }
    return { type: 'complete' };
  }
  return blocked('UNKNOWN_STATE', '无法确定下一步', {
    userAction: 'restart_task',
  });
}

function statusIsFailedWithFinal(task: PersistedPipelineTaskView): boolean {
  return String(task.status) === 'failed' && hasUsableFinalText(task);
}

function decideNoReview(
  task: PersistedPipelineTaskView,
  proof: PersistedStageCheckpoint,
): PipelineAction {
  // noReview marks other stages skipped during finalize orchestration;
  // decision only needs draft → finalize → complete.
  if (hasUsableFinalText(task)) {
    if (String(task.status) === 'failed') {
      return blocked('TASK_TERMINAL', '任务已失败并保留正文', {
        userAction: 'none',
      });
    }
    if (String(task.status) === 'completed') {
      return blocked('TASK_TERMINAL', '任务已完成', { userAction: 'none' });
    }
    return { type: 'complete' };
  }
  // Proof should be skipped in this mode; if somehow open, ignore for finalize.
  void proof;
  return { type: 'finalize_from_draft' };
}

function decideAfterProof(
  task: PersistedPipelineTaskView,
  proof: PersistedStageCheckpoint,
): PipelineAction {
  if (proof.status === 'succeeded') {
    if (!hasUsableFinalText(task)) {
      return { type: 'finalize_from_proof' };
    }
    if (String(task.status) === 'completed') {
      return blocked('TASK_TERMINAL', '任务已完成', { userAction: 'none' });
    }
    // final present but status not completed (crash after save, before complete)
    return { type: 'complete' };
  }
  if (proof.status === 'failed') {
    if (!hasUsableFinalText(task)) {
      return { type: 'finalize_from_draft', degraded: true };
    }
    return blocked('TASK_TERMINAL', '终审失败，已保留初稿', {
      stage: 'proof',
      userAction: 'none',
    });
  }
  if (isOpen(proof.status)) {
    return { type: 'run_proof' };
  }
  if (proof.status === 'skipped') {
    // Skipped because audit failed — degraded finalize from draft.
    if (!hasUsableFinalText(task)) {
      return { type: 'finalize_from_draft', degraded: true };
    }
    return decideTerminalOrComplete(task);
  }
  return blocked('UNKNOWN_STATE', `终审阶段状态非法: ${proof.status}`, {
    stage: 'proof',
    userAction: 'restart_task',
  });
}

function decideTwoStage(
  task: PersistedPipelineTaskView,
  review: PersistedStageCheckpoint,
  proof: PersistedStageCheckpoint,
): PipelineAction {
  if (isOpen(review.status)) {
    return { type: 'run_review' };
  }
  if (review.status === 'failed') {
    if (!hasUsableFinalText(task)) {
      return { type: 'finalize_from_draft', degraded: true };
    }
    return blocked('TASK_TERMINAL', '文学评估失败，已保留初稿', {
      stage: 'review',
      userAction: 'none',
    });
  }
  if (review.status === 'skipped') {
    // Unexpected in twoStage primary path; treat as audit absent.
    if (!hasUsableFinalText(task)) {
      return { type: 'finalize_from_draft', degraded: true };
    }
    return decideTerminalOrComplete(task);
  }
  if (review.status !== 'succeeded') {
    return blocked('UNKNOWN_STATE', `评估阶段状态非法: ${review.status}`, {
      stage: 'review',
      userAction: 'restart_task',
    });
  }
  return decideAfterProof(task, proof);
}

function decideConditional(
  task: PersistedPipelineTaskView,
  factCheck: PersistedStageCheckpoint,
  proof: PersistedStageCheckpoint,
): PipelineAction {
  if (isOpen(factCheck.status)) {
    return { type: 'run_fact_check' };
  }
  if (factCheck.status === 'failed') {
    if (!hasUsableFinalText(task)) {
      return { type: 'finalize_from_draft', degraded: true };
    }
    return blocked('TASK_TERMINAL', '事实核查失败，已保留初稿', {
      stage: 'factCheck',
      userAction: 'none',
    });
  }
  if (factCheck.status === 'skipped') {
    if (!hasUsableFinalText(task)) {
      return { type: 'finalize_from_draft', degraded: true };
    }
    return decideTerminalOrComplete(task);
  }
  if (factCheck.status !== 'succeeded') {
    return blocked(
      'UNKNOWN_STATE',
      `事实核查阶段状态非法: ${factCheck.status}`,
      { stage: 'factCheck', userAction: 'restart_task' },
    );
  }
  return decideAfterProof(task, proof);
}

function auditResolved(status: StageStatus): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'skipped'
  );
}

function decideFull(
  task: PersistedPipelineTaskView,
  review: PersistedStageCheckpoint,
  factCheck: PersistedStageCheckpoint,
  proof: PersistedStageCheckpoint,
): PipelineAction {
  // Audit context must exist before any review/factCheck LLM (invariant 4/5).
  // If draft succeeded but audit never frozen, do not silent-rebuild from live data
  // inside this pure function — action is build_audit_context (reconciler implements
  // freeze-candidates or marks non-recoverable).
  if (!task.hasAuditContext) {
    // If both audits already succeeded/failed from a partial write path, still
    // require audit context for proof fidelity when re-running audits.
    const auditsAllResolved =
      auditResolved(review.status) && auditResolved(factCheck.status);
    if (!auditsAllResolved) {
      return { type: 'build_audit_context' };
    }
    // Audits already done without stored auditContext (legacy): allow proof/finalize
    // using whatever text is on checkpoints; do not rebuild.
  }

  const reviewOpen = isOpen(review.status);
  const factOpen = isOpen(factCheck.status);

  if (reviewOpen && factOpen) {
    return { type: 'run_review_and_fact_check' };
  }
  if (reviewOpen) {
    return { type: 'run_review' };
  }
  if (factOpen) {
    return { type: 'run_fact_check' };
  }

  // Both resolved.
  const reviewOk = review.status === 'succeeded';
  const factOk = factCheck.status === 'succeeded';
  if (!reviewOk && !factOk) {
    if (!hasUsableFinalText(task)) {
      return { type: 'finalize_from_draft', degraded: true };
    }
    return blocked(
      'TASK_TERMINAL',
      '文学评估与事实核查均失败，已保留初稿',
      { userAction: 'none' },
    );
  }

  return decideAfterProof(task, proof);
}
