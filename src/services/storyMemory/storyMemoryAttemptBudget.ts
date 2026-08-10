import type { LLMPhysicalRequestHooks } from '../llm';
import {
  completeStoryMemoryRequestAttempt,
  createStoryMemoryRequestAttempt,
} from '../../data/repositories/storyMemoryRequestAttemptRepository';

export const STORY_MEMORY_PHYSICAL_BUDGET_ERROR =
  'STORY_MEMORY_PHYSICAL_REQUEST_BUDGET_EXHAUSTED';

export type StoryMemoryPhysicalRequestKind =
  | 'primary'
  | 'safe_retry'
  | 'format_repair'
  | 'fresh_retry'
  | 'length_retry'
  | 'protocol_fallback'
  | string;

export class StoryMemoryPhysicalRequestBudgetError extends Error {
  readonly code = STORY_MEMORY_PHYSICAL_BUDGET_ERROR;

  constructor(maxRequests: number) {
    super(`Story Memory 单个逻辑批次最多允许 ${maxRequests} 次真实 HTTP 请求。`);
    this.name = 'StoryMemoryPhysicalRequestBudgetError';
  }
}

export interface StoryMemoryAttemptBudgetInput {
  logicalBatchId: string;
  projectId: number;
  fromPosition: number;
  throughPosition: number;
  maxPhysicalRequests: number;
  /** Unit tests and offline callers may opt out of durable writes. */
  durable?: boolean;
}

export class StoryMemoryAttemptBudget {
  readonly logicalBatchId: string;
  readonly maxPhysicalRequests: number;
  private usedPhysicalRequests = 0;
  private observedPhysicalRequest = false;
  private activeAttemptId: string | null = null;

  private readonly input: StoryMemoryAttemptBudgetInput;

  constructor(input: StoryMemoryAttemptBudgetInput) {
    this.input = input;
    this.logicalBatchId = input.logicalBatchId;
    this.maxPhysicalRequests = Math.max(
      1,
      Math.floor(input.maxPhysicalRequests),
    );
  }

  get used(): number {
    return this.usedPhysicalRequests;
  }

  get remaining(): number {
    return Math.max(0, this.maxPhysicalRequests - this.usedPhysicalRequests);
  }

  /** True once the real provider has invoked the lifecycle hook. */
  get hasObservedPhysicalRequest(): boolean {
    return this.observedPhysicalRequest;
  }

  canSend(): boolean {
    return this.usedPhysicalRequests < this.maxPhysicalRequests;
  }

  hooks(): LLMPhysicalRequestHooks {
    return {
      beforeRequest: event => this.beforeRequest(event.kind),
      afterRequest: event =>
        this.afterRequest({
          kind: event.kind,
          outcome: event.outcome,
          httpStatus: event.httpStatus,
          providerRequestId: event.providerRequestId,
          error: event.error,
        }),
    };
  }

  private async beforeRequest(kind: string): Promise<void> {
    if (!this.canSend()) {
      throw new StoryMemoryPhysicalRequestBudgetError(
        this.maxPhysicalRequests,
      );
    }
    this.observedPhysicalRequest = true;
    this.usedPhysicalRequests += 1;
    const attemptNo = this.usedPhysicalRequests;
    const attemptId = `${this.logicalBatchId}:${attemptNo}`;
    this.activeAttemptId = attemptId;
    if (this.input.durable !== false) {
      // This write is intentionally awaited before fetch() is allowed to run.
      // A failure therefore stops safely without making an untracked request.
      await createStoryMemoryRequestAttempt({
        attemptId,
        logicalBatchId: this.logicalBatchId,
        projectId: this.input.projectId,
        fromPosition: this.input.fromPosition,
        throughPosition: this.input.throughPosition,
        requestKind: kind,
        attemptNo,
        status: 'sent',
      });
    }
  }

  private async afterRequest(input: {
    kind: string;
    outcome: 'response' | 'transport_error';
    httpStatus?: number;
    providerRequestId?: string;
    error?: unknown;
  }): Promise<void> {
    const attemptId = this.activeAttemptId;
    if (!attemptId || this.input.durable === false) return;
    const responseKnown = input.outcome === 'response';
    const responseSucceeded =
      responseKnown &&
      input.httpStatus != null &&
      input.httpStatus >= 200 &&
      input.httpStatus < 300;
    const status = responseSucceeded
      ? 'succeeded'
      : responseKnown
        ? 'failed'
        : 'outcome_unknown';
    const errorCode =
      input.error && typeof input.error === 'object'
        ? String((input.error as { code?: unknown }).code || '') || null
        : null;
    await completeStoryMemoryRequestAttempt({
      attemptId,
      status,
      failureClass: responseSucceeded
        ? null
        : responseKnown
          ? input.httpStatus === 429 || (input.httpStatus || 0) >= 500
            ? 'rate_limit_or_server_error'
            : 'provider_error'
          : 'outcome_unknown',
      errorCode:
        errorCode ||
        (responseKnown && !responseSucceeded && input.httpStatus != null
          ? 'HTTP_' + input.httpStatus
          : null),
      httpStatus: input.httpStatus ?? null,
      providerRequestId: input.providerRequestId ?? null,
    });
    this.activeAttemptId = null;
  }
}

export function createStoryMemoryLogicalBatchId(input: {
  projectId: number;
  fromPosition: number;
  throughPosition: number;
  kind?: string;
}): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `story-memory:${input.kind || 'checkpoint'}:${input.projectId}:${
    input.fromPosition
  }:${input.throughPosition}:${Date.now().toString(36)}:${suffix}`;
}
