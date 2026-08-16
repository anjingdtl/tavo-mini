/**
 * THE one production Writing Kernel (Final Closure plan §3.2 / §10).
 *
 * The kernel owns the post-Freeze execution chain:
 *   Freeze (authoritative, exactly once)
 *     → Draft → Review → FactCheck/Audit → Revision → Proof
 *     → Final Validate (incl. Semantic Apply hard gate)
 *     → Persist → Post Writing Update
 *
 * It advances one durable step at a time through a `WritingStageDriver`.
 * It NEVER delegates to a whole legacy pipeline and never branches on the
 * writing scenario after Freeze. Fail-closed error codes:
 *   WRITING_FROZEN_CONTEXT_MISSING / WRITING_FREEZE_FINGERPRINT_DRIFT /
 *   WRITING_DUPLICATE_AUTHORITATIVE_FREEZE / WRITING_PRE_FREEZE_STAGE_EXECUTION
 */
import type {
  FrozenWritingContext,
  WritingKernelTrace,
} from './contracts/frozenWritingContext';
import type { WritingRequest } from './contracts/writingSource';
import type {
  WritingStageDriver,
  WritingStepOutcome,
} from './contracts/writingStage';
import { buildFrozenWritingContext } from './context/buildFrozenWritingContext';
import {
  appendWritingKernelStageEvent,
  createWritingKernelTrace,
} from './trace/writingTrace';

/** Hard bound: 5 pre-freeze steps + up to 11 stages with retries. */
const MAX_KERNEL_STEPS = 96;

export interface WritingKernelResult<TResult = unknown> {
  result: TResult;
  request: WritingRequest | null;
  frozenContext: FrozenWritingContext | null;
  trace: WritingKernelTrace | null;
  terminal:
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'blocked'
    | 'waiting'
    | 'budget-paused';
}

/** Build the pre-freeze trace seed for a durable executor that owns the
 * subsequent stage loop. Used by the durable freeze writers only. */
export function buildWritingKernelFreezeTrace(input: {
  request: WritingRequest;
}): { frozenContext: FrozenWritingContext; trace: WritingKernelTrace } {
  const frozenContext = buildFrozenWritingContext(input.request);
  let trace = createWritingKernelTrace({
    request: input.request,
    frozenContext,
  });
  for (const stage of ['collect', 'normalize', 'plan', 'allocate', 'render', 'freeze'] as const) {
    trace = appendWritingKernelStageEvent(trace, stage, 'completed');
  }
  return { frozenContext, trace };
}

function freezeError(code: string, message: string) {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

/**
 * The one production writing entry. `createDriver` performs the pre-Freeze
 * scenario adaptation (source collection + durable freeze) and returns a
 * driver bound to that freeze; the engine below owns everything after.
 */
export async function runWritingKernel<TResult = unknown>(input: {
  createDriver: () => Promise<WritingStageDriver>;
  request?: WritingRequest;
  /** Persist the final unified trace after the loop ends. */
  persistTrace?: (trace: WritingKernelTrace) => Promise<void>;
  onStageEvent?: (event: WritingStepOutcome) => void;
}): Promise<WritingKernelResult<TResult>> {
  const driver = await input.createDriver();
  let frozenContext: FrozenWritingContext | null = null;
  let trace: WritingKernelTrace | null = null;
  let freezeSeen = false;
  let terminal: WritingKernelResult<TResult>['terminal'] = 'waiting';
  let result: unknown;
  let failure: unknown = null;
  let exhausted = true;

  try {
    for (let step = 0; step < MAX_KERNEL_STEPS; step += 1) {
      const outcome = await driver.step();
      input.onStageEvent?.(outcome);

      if (outcome.kind === 'freeze') {
        if (freezeSeen) {
          throw freezeError(
            'WRITING_DUPLICATE_AUTHORITATIVE_FREEZE',
            'Writing Kernel blocked: a second authoritative Freeze was surfaced for one run',
          );
        }
        if (trace && trace.freezeFingerprint !== outcome.trace.freezeFingerprint) {
          throw freezeError(
            'WRITING_FREEZE_FINGERPRINT_DRIFT',
            `Writing Kernel blocked: Freeze fingerprint drift ${trace.freezeFingerprint} != ${outcome.trace.freezeFingerprint}`,
          );
        }
        freezeSeen = true;
        frozenContext = outcome.frozenContext;
        trace = outcome.trace;
        continue;
      }

      if (outcome.kind === 'stage') {
        if (!freezeSeen || !trace) {
          throw freezeError(
            'WRITING_PRE_FREEZE_STAGE_EXECUTION',
            `Writing Kernel blocked: stage ${outcome.stage} executed before the authoritative Freeze`,
          );
        }
        trace = appendWritingKernelStageEvent(
          trace,
          outcome.stage,
          outcome.status,
          outcome.detail,
        );
        continue;
      }

      if (outcome.kind === 'progress') {
        continue;
      }

      if (outcome.kind === 'terminal') {
        terminal = outcome.reason;
        result = outcome.result;
        failure = outcome.error ?? null;
        exhausted = false;
        break;
      }

      if (outcome.kind === 'stop') {
        terminal = 'waiting';
        exhausted = false;
        break;
      }
    }
    if (exhausted) {
      throw freezeError(
        'WRITING_KERNEL_STEP_LIMIT',
        'Writing Kernel blocked: stage loop exceeded the maximum number of durable steps',
      );
    }
  } finally {
    await driver.finalize();
  }

  if (input.persistTrace && trace) {
    await input.persistTrace(trace);
  }

  // Surface a terminal failure after cleanup and trace persistence ran.
  if (failure) {
    throw failure;
  }

  return {
    result: result as TResult,
    request: input.request ?? null,
    frozenContext,
    trace,
    terminal,
  };
}
