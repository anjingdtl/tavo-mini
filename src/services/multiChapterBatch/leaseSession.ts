/**
 * CL-05: serialized batch lease heartbeat session.
 *
 * A single-chapter LLM pipeline run can take 120–180s while the batch lease
 * TTL is only 60s. Without a heartbeat the lease expires mid-request and a
 * second executor can CAS-claim the batch — two writers, corrupted progress.
 *
 * Contract (plan §8):
 *   - ONLY a BatchLeaseSession writes the lease while a long request runs.
 *   - renew() is SERIALIZED: at most one in-flight CAS at any time; queued
 *     renews reuse the chain (no interleaved CAS on stale rowVersions).
 *   - every renew re-reads the LATEST rowVersion before CAS (never a stale
 *     optimistic value).
 *   - a CAS failure marks `lost=true` immediately — after that no new renew
 *     may write, and the caller must fail closed (no new LLM requests).
 *   - stop() waits for any in-flight renew to settle and cancels the timer;
 *     after stop, renew never writes again.
 *   - the heartbeat ticks at TTL/3 (well inside the 1/3–1/2 window).
 */
import type { MultiChapterBatchRow } from '../../data/repositories/multiChapterBatchRepository';

export interface BatchLeaseSessionDeps {
  owner: string;
  leaseMs: number;
  /** Re-read the current batch row (latest rowVersion). */
  readBatch: () => Promise<MultiChapterBatchRow | null>;
  /** CAS lease claim. Returns false when lost to another owner / stale row. */
  claim: (
    batchId: string,
    owner: string,
    leaseMs: number,
    expectedRowVersion: number,
  ) => Promise<boolean>;
}

export class BatchLeaseSession {
  readonly owner: string;
  readonly leaseMs: number;
  /** True once ANY renew CAS fails — permanent, fail-closed. */
  lost = false;
  /** True after stop() — no further renew writes. */
  private stopped = false;
  private batchId: string;
  private renewChain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    batchId: string,
    private readonly deps: BatchLeaseSessionDeps,
  ) {
    this.batchId = batchId;
    this.owner = deps.owner;
    this.leaseMs = deps.leaseMs;
  }

  /** Start the heartbeat. Caller must await start() before the long run. */
  async start(): Promise<void> {
    if (this.stopped || this.lost) return;
    await this.renew();
    // TTL/3 — comfortably inside the 1/3–1/2 renewal window.
    const tickMs = Math.max(1_000, Math.floor(this.leaseMs / 3));
    this.timer = setInterval(() => {
      void this.renew().catch(() => {
        // lost is set inside renew; the interval observes it on next tick.
      });
    }, tickMs);
    // Do not keep the JS process alive for tests.
    if (typeof (this.timer as unknown as { unref?: () => void }).unref === 'function') {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  /**
   * Serialized renew. Concurrent callers queue on the chain — at most one
   * CAS in flight, always against the latest rowVersion.
   */
  renew(): Promise<void> {
    const next = this.renewChain.then(() => this.doRenew());
    // Keep the chain alive even when a renew rejects.
    this.renewChain = next.catch(() => {});
    return next;
  }

  private async doRenew(): Promise<void> {
    if (this.stopped || this.lost) return;
    const batch = await this.deps.readBatch();
    if (!batch) {
      this.lost = true;
      return;
    }
    try {
      const ok = await this.deps.claim(
        this.batchId,
        this.owner,
        this.leaseMs,
        batch.rowVersion,
      );
      if (!ok) {
        // Another owner won the CAS (or the row vanished) — fail closed.
        this.lost = true;
      }
    } catch {
      // Claim write errors also fail closed: we cannot prove ownership.
      this.lost = true;
    }
  }

  /** Fail-closed guard for the caller before/after the long request. */
  assertOwned(): void {
    if (this.lost) {
      throw new Error('批次租约已丢失，禁止继续发起请求');
    }
  }

  /**
   * Stop the heartbeat and wait for any in-flight renew to settle.
   * After stop, renew() never writes again.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.renewChain;
  }
}
