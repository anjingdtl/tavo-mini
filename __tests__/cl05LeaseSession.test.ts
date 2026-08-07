/**
 * CL-05: 串行 LeaseSession 续租（修复前稳定失败测试）。
 *
 * 修复前：batch lease（TTL 60s）只在主循环每步续租；单章 LLM 请求可长达
 * 120–180s，期间无心跳 → lease 过期 → 第二 executor 可抢占，双写损坏进度。
 *
 * 本测试用真实 in-memory SQLite + 真实 claim/release + fake timers 证明：
 *   1. 120s 长请求期间心跳持续续租（TTL 不过期，第二 executor 无法抢占）
 *   2. 第二 executor 抢占成功后 renew CAS 失败 → lost=true（fail-closed）
 *   3. stop() 后 renew 绝不回写
 *   4. renew 串行化（同一时间最多一个 CAS）
 *   5. 集成：reconcileMultiChapterBatch 的 run_pipeline 长请求期间 lease 存活
 */
import { __setDatabaseForTest, __resetForTest } from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { openDatabase } from '../src/data/connection/openDatabase';
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  createBatch,
  createBatchItem,
  createBatchChapterForItem,
  createPipelineTaskForBatchItem,
  getBatchById,
  claimBatchLease,
  releaseBatchLease,
  updateBatchStatus,
} from '../src/data/repositories/multiChapterBatchRepository';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import { reconcileMultiChapterBatch } from '../src/services/multiChapterBatch/reconcileMultiChapterBatch';
import { BatchLeaseSession } from '../src/services/multiChapterBatch/leaseSession';

let testDb: InMemorySqliteDb | null = null;

async function resetDb() {
  __resetForTest();
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
}

afterEach(async () => {
  __resetForTest();
  if (testDb) {
    try {
      testDb.close();
    } catch {
      /* ignore */
    }
    testDb = null;
  }
});

async function seedProject(id = 1): Promise<void> {
  await execute(
    await openDatabase(),
    `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (?, 'p', 'outline', 't', 't')`,
    [id],
  );
}

async function seedBatch(batchId = 'b1') {
  await seedProject();
  await createBatch({
    id: batchId,
    projectId: 1,
    sourcePrompt: 's',
    chapterCount: 1,
    targetWordsPerChapter: 3000,
    pipelineMode: 'full',
  });
  await createBatchItem({
    batchId,
    ordinal: 1,
    title: '第1章',
    synopsis: 's',
    keyBeatsJson: '[]',
    targetWords: 3000,
  });
  await updateBatchStatus(batchId, 'ready');
}

function leaseExpiry(batchId: string): Promise<number | null> {
  return getBatchById(batchId).then(b => b?.leaseExpiresAt ?? null);
}

describe('BatchLeaseSession（真实 SQLite CAS）', () => {
  jest.useFakeTimers();

  it('120s 长请求：心跳按 TTL/3 续租，lease 永不过期', async () => {
    await resetDb();
    await seedBatch('b1');
    const leaseMs = 60_000;

    const session = new BatchLeaseSession('b1', {
      owner: 'o1',
      leaseMs,
      readBatch: () => getBatchById('b1'),
      claim: claimBatchLease,
    });
    await session.start();

    const firstExpiry = await leaseExpiry('b1');
    expect(firstExpiry).not.toBeNull();
    expect(firstExpiry!).toBeGreaterThan(Date.now() + leaseMs - 1000);

    // 模拟 120s 长请求：每次推进 20s 后由心跳 renew（真实 CAS 链，每次
    // 基于最新 rowVersion）。interval 已由 start() 注册、stop() 清理。
    for (let elapsed = 0; elapsed < 120_000; elapsed += 20_000) {
      jest.advanceTimersByTime(20_000);
      await session.renew();
      const expiry = await leaseExpiry('b1');
      expect(expiry).not.toBeNull();
      // lease 必须始终覆盖「未来至少一个心跳周期」，绝不出现过期窗口。
      expect(expiry!).toBeGreaterThan(Date.now() + leaseMs / 2);
    }

    // 第二 executor 尝试抢占（lease 仍在 → 必须失败）。
    const batch = await getBatchById('b1');
    const stolen = await claimBatchLease('b1', 'o2', leaseMs, batch!.rowVersion);
    expect(stolen).toBe(false);

    await session.stop();
  });

  it('第二 executor 抢占成功（先释放）后 renew CAS 失败 → lost', async () => {
    await resetDb();
    await seedBatch('b1');
    const leaseMs = 60_000;

    const session = new BatchLeaseSession('b1', {
      owner: 'o1',
      leaseMs,
      readBatch: () => getBatchById('b1'),
      claim: claimBatchLease,
    });
    await session.start();
    expect(session.lost).toBe(false);

    // 另一 executor 强制抢占（模拟先 release 再 claim，使用最新 rowVersion）。
    const before = await getBatchById('b1');
    await releaseBatchLease('b1', 'o1');
    const afterRelease = await getBatchById('b1');
    const stolen = await claimBatchLease(
      'b1',
      'o2',
      leaseMs,
      afterRelease!.rowVersion,
    );
    expect(stolen).toBe(true);
    void before;

    // 下一次心跳 renew CAS 失败 → lost=true（fail-closed）。
    await session.renew();
    expect(session.lost).toBe(true);
    expect(() => session.assertOwned()).toThrow(/租约已丢失/);

    await session.stop();
  });

  it('stop() 后 renew 绝不回写 lease', async () => {
    await resetDb();
    await seedBatch('b1');
    const leaseMs = 60_000;

    const session = new BatchLeaseSession('b1', {
      owner: 'o1',
      leaseMs,
      readBatch: () => getBatchById('b1'),
      claim: claimBatchLease,
    });
    await session.start();
    await session.stop();

    // stop 之后：先把 lease 释放掉，再尝试 renew —— 不得重新写入。
    await releaseBatchLease('b1', 'o1');
    await session.renew();
    const batch = await getBatchById('b1');
    expect(batch?.leaseOwner ?? null).toBeNull();
    expect(batch?.leaseExpiresAt ?? null).toBeNull();
  });

  it('renew 串行化：并发调用同一时间最多一个 CAS', async () => {
    await resetDb();
    await seedBatch('b1');
    const leaseMs = 60_000;

    let inFlight = 0;
    let maxInFlight = 0;
    const wrappedClaim = async (
      batchId: string,
      owner: string,
      ms: number,
      rowVersion: number,
    ) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // 微任务让异步交错（fake timers 下不能用 setTimeout）。
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      const ok = await claimBatchLease(batchId, owner, ms, rowVersion);
      inFlight -= 1;
      return ok;
    };

    const session = new BatchLeaseSession('b1', {
      owner: 'o1',
      leaseMs,
      readBatch: () => getBatchById('b1'),
      claim: wrappedClaim,
    });

    // 并发触发 5 次 renew —— 必须串行（maxInFlight === 1）。
    await Promise.all([
      session.renew(),
      session.renew(),
      session.renew(),
      session.renew(),
      session.renew(),
    ]);
    expect(maxInFlight).toBe(1);
    expect(session.lost).toBe(false);

    await session.stop();
  });

  it('renew 使用最新 rowVersion：主循环步进后心跳仍 CAS 成功', async () => {
    await resetDb();
    await seedBatch('b1');
    const leaseMs = 60_000;

    const session = new BatchLeaseSession('b1', {
      owner: 'o1',
      leaseMs,
      readBatch: () => getBatchById('b1'),
      claim: claimBatchLease,
    });
    await session.start();

    // 模拟主循环步进也续租了一次（rowVersion 变化）。
    const batch = await getBatchById('b1');
    await claimBatchLease('b1', 'o1', leaseMs, batch!.rowVersion);

    // 心跳 renew 用最新 rowVersion → 成功，不误判 lost。
    await session.renew();
    expect(session.lost).toBe(false);

    await session.stop();
  });
});

// ── 集成：reconcileMultiChapterBatch 长请求期间真实心跳 ──────────────────
describe('集成：batch run_pipeline 长请求期间 lease 心跳（CL-05）', () => {
  it('120s 单章请求期间心跳续租，lease 不过期，第二 executor 无法抢占', async () => {
    jest.useFakeTimers();
    await resetDb();
    await seedBatch('b1');
    const chapterId = await createBatchChapterForItem('b1', 1, {
      projectId: 1,
      position: 0,
      title: 't',
      synopsis: 's',
    });
    await createPipelineTaskForBatchItem({
      batchId: 'b1',
      ordinal: 1,
      chapterId,
      task: {
        id: 't1',
        targetType: 'chapter',
        targetId: chapterId,
        status: 'idle',
        stageResults: [],
        finalText: null,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolvedAt: null,
      },
      stages: ['draft', 'review', 'factCheck', 'proof'],
      runNo: 1,
      llmConfigSnapshotJson: '{}',
      reason: 'batch_start',
    });

    // 长请求 runner：等待 gate 120s 后才完成。
    let releaseRun: (() => void) | null = null;
    const runStarted = new Promise<void>(r => {
      releaseRun = r;
    });
    const runner = {
      calls: 0,
      run: async (taskId: string) => {
        runner.calls += 1;
        await runStarted; // 模拟 120s 长 LLM 请求
        await savePipelineTask({
          id: taskId,
          targetType: 'chapter',
          targetId: 0,
          status: 'completed',
          stageResults: [
            {
              stage: 'draft',
              status: 'success',
              text: '正文',
              tokens: { input: 1, output: 2, total: 3 },
            },
          ],
          finalText: '正文',
          error: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          resolvedAt: null,
        });
      },
    };

    const reconcilePromise = reconcileMultiChapterBatch('b1', {
      owner: 'o1',
      runPipeline: runner.run as any,
      resumePipeline: runner.run as any,
      maxSteps: 8,
    });

    // 等 runner 进入长请求（心跳 session 已 start）。
    await jest.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    // 长请求期间推进 120s（每 20s 心跳必须续租）。
    for (let t = 0; t < 120_000; t += 20_000) {
      jest.advanceTimersByTime(20_000);
      // flush 心跳异步链（readBatch → CAS）。
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      const batch = await getBatchById('b1');
      expect(batch?.leaseExpiresAt ?? 0).toBeGreaterThan(Date.now());
    }

    // 120s 后 lease 仍存活 → 第二 executor 抢占失败。
    const batchNow = await getBatchById('b1');
    expect(batchNow?.leaseOwner).toBe('o1');
    const stolen = await claimBatchLease(
      'b1',
      'o2',
      60_000,
      batchNow!.rowVersion,
    );
    expect(stolen).toBe(false);

    // 放行长请求 → 批次继续完成。
    (releaseRun as (() => void) | null)?.();
    await reconcilePromise;
    expect(runner.calls).toBe(1);
    jest.useRealTimers();
  });
});
