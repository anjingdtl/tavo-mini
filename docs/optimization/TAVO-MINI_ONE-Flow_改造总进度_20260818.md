# TAVO-MINI ONE Flow 改造总进度

**日期：** 2026-08-18  
**仓库：** `E:\AiWorkSpace\tavo-mini`（唯一执行基线）  
**总路线：** `docs/optimization/TAVO-MINI_ONE-Pipeline_ONE-Context_ONE-Memory_流程治理与流水线提速总路线方案_V1.0.md`  
**代码起点：** `e390bdd`（`main`）  
**封板状态：** **未封。禁止宣布 `ONE FLOW FINAL SEALED / GO`。**

---

## 1. 本轮原则（已封板，禁止回退）

- ONE Production Writing Entry / ONE Writing Kernel / ONE Shared Writer Core / ONE Shared Prompt Compiler / ONE Shared Stage Set / ONE Freeze
- One-Shot / 极速档已 FINAL SEALED：正文 Paid LLM Calls ≤ 1，无 Formatter / Auto Retry / Review / Revision / Proof
- 现有 Elastic / Hierarchical Context Budget 保留；禁止新增固定输入 Token 上限
- Canon / Boundary / Seam / Story Memory / Resume / Durable Ledger 不得削弱
- 减少重复能力，而不是重新造一套能力
- 严禁重新出现 OutlineWriterCore / ContinuationWriterCore / FastWriter / OneShotWriter / fastPromptCompiler / continuationPromptCore / fastContextBuilder / 独立模式专属长期记忆

---

## 2. 阶段状态

| Phase | 目标 | 状态 | 文档 |
|---|---|---|---|
| 0 | Baseline & Observability | **本轮完成（可进入 Phase 1）** | `TAVO-MINI_ONE-Flow_Phase0_Baseline报告_20260818.md` |
| 1 | ONE Memory | 未开始 | `TAVO-MINI_ONE-Flow_Phase1_ONE-Memory_实施与验收_20260818.md` |
| 2 | ONE Context | 未开始 | `TAVO-MINI_ONE-Flow_Phase2_ONE-Context_实施与验收_20260818.md` |
| 3 | ONE Pipeline | 未开始 | `TAVO-MINI_ONE-Flow_Phase3_ONE-Pipeline_实施与验收_20260818.md` |
| 4 | ONE Flow 接驳 + 集成长测 | 未开始 | `TAVO-MINI_ONE-Flow_最终集成验收报告_20260818.md` |

Phase 0 只建立可重复观测，不改生产写作决策、不改 Writer / Prompt / Budget / Canon / Story Memory 算法。

---

## 3. Phase 0 已落地

生产调用图（未改）：

```text
UI / batch / resume
  → runWritingKernel
      → Outline / Continuation Source Adapter
      → ONE Freeze
      → runWritingStages（串行 for + await）
          → Shared Writer Core + Shared Prompt Compiler
      → Persist
      → PostWriting（Story Memory 后台 / Continuation State Outbox）
```

新增观测面（附加在 `WritingKernelTrace.observability`，不参与 freezeFingerprint）：

| 类别 | 字段 |
|---|---|
| 章节 | `chapterE2EMs`，P50 / P95 由多样本 `percentileMs` 计算 |
| 上下文 | `contextBuildMs` / `freezeMs` / `candidateTokens` / `allocatedTokens` / `renderedTokens` / `frozenContextTokens` / `duplicateContextTokens` / `duplicateContextRatio` |
| Stage | `stageQueuedMs` / `stageExecutionMs` / `stageDependencyWaitMs` / `stagePersistMs` |
| LLM | `logicalStageCallCount` / `formatterCallCount` / `physicalRequestCount` / `protocolFallbackCount` |
| Token | 每章 / 每 Stage input/output；provider 有返回时 `promptCacheHit/Miss` |
| PostWriting | `storyMemoryUpdateMs` / `stateExtractionMs` / `postWritingBlockingMs` / `postWritingAuxiliaryCallCount` |

硬口径：

- `chapterWritingPaidCallCount = logicalStageCallCount + formatterCallCount`
- PostWriting Auxiliary **不得**计入 Chapter Writing Paid Call
- Protocol Fallback 是物理请求属性，不是第二套逻辑 Stage

---

## 4. 门禁与验证（Phase 0）

| 项 | 结果 |
|---|---|
| lint | PASS，0 errors；203 warnings 为存量 |
| typecheck | PASS |
| verify:version | PASS，V2.11.53 / versionCode 2115300 |
| Full Jest | PASS，465 suites passed / 4 skipped；3592 tests passed / 9 skipped |
| Generation Stability 同款 + 新门禁 | PASS，28 suites / 150 tests |
| 新硬门禁 | `writingChapterObservability.test.ts`、`writingOneFlowPhase0Baseline.test.ts` |
| 本轮新真实 LLM 10 章长测 | **未跑**。Phase 0 使用结构样本 + 既有封口/穿测报告重建。下一轮有观测仪后再采新数 |
| Android Debug 构建 | PASS，`dist/apk/debug/ShineWriter-V2.11.53-debug.apk`。当时无已连接模拟器，未做 `adb install -r` |

---

## 5. 当前最大开销（基线结论，供后续 Phase 决策）

1. **标准档每章 5 次正文付费 Stage**（Outline：Draft/Review/FactCheck/Revision/Proof；Continuation：Draft/Review/Audit/Revision/Proof）。
2. **每个付费 Stage 都完整携带 Frozen Context**；小 fixture 重复率约 23%，大续写上下文（约 26K input）外推重复率约 75%–80%。
3. **后续 Stage 继续叠加完整 Previous Artifacts**（Draft+Review+Audit/FactCheck+Revision）。
4. **历史真实 Outline 墙钟 437s 中 Draft+Proof ≈ 79%**（Proof 217s / Draft 129s）。
5. **Runner 仍是串行**，`stageDependencyWaitMs = 0`（还没有 DAG 等待，也没有保守并发）。
6. **PostWriting 已基本不堵正文 Persist**（Story Memory 后台排队；续写 State Extraction 走 Outbox）。正常确认 Barrier 仍是 Phase 1 收束对象。

不要提前写死提速百分比。Phase 1 起必须以本基线对比。

---

## 6. 下一 Phase

进入 **Phase 1：ONE Memory**。

只做：

- Outline / Continuation 共用同一套 Story Memory
- 保留 Canon 与 Structured Continuity State
- 正常章节 Auto Commit；只在 Canon Conflict / 重大冲突 / 低置信且影响后续 / 无法自动合并时弹确认
- Memory Authority：Canon > Frozen Boundary > Continuity State > Story Memory > Recent Prose

不做：重写 Story Memory、重写 Canon、重写 Writer、重写 Budget。
