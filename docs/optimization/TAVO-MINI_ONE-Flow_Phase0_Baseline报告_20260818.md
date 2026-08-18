# TAVO-MINI ONE Flow Phase 0 Baseline 报告

**日期：** 2026-08-18  
**仓库：** `E:\AiWorkSpace\tavo-mini`  
**总路线：** `docs/optimization/TAVO-MINI_ONE-Pipeline_ONE-Context_ONE-Memory_流程治理与流水线提速总路线方案_V1.0.md`  
**代码起点：** `e390bdd`  
**本 Phase 目标：** 先观测，不改生产写作行为。

**结论：** Phase 0 **GO — 可进入 Phase 1**。  
**不得宣布** `ONE FLOW FINAL SEALED / GO`。

---

## 0. 口径（必须先读）

本轮禁止再把下面四件事统称为“API 调用次数”：

| 字段 | 含义 |
|---|---|
| `logicalStageCallCount` | 正文 Stage 主调用（Draft/Review/Audit/FactCheck/Revision/Proof 各一次成功主请求） |
| `formatterCallCount` | thinking-disabled Formatter 挽救调用 |
| `physicalRequestCount` | 真实 HTTP 发出次数（含 protocol_fallback） |
| `protocolFallbackCount` | provider 因 JSON/thinking 扩展被拒后的协议回退请求 |

另外：

| 字段 | 含义 |
|---|---|
| `chapterWritingPaidCallCount` | `logical + formatter`。One-Shot 正文硬上限看这个，必须 ≤ 1 |
| `postWritingAuxiliaryCallCount` | Story Memory / Continuity State Extraction。**不算**正文 Paid Call |

`chapterE2EMs` 从 Freeze 构建开始计到 Persist 完成。后台 PostWriting 不计入 E2E，单独记 `postWritingBlockingMs`。

P50 / P95 用线性插值。`n=1` 时 P50 = P95 = 该样本；空集返回 null，不编造。

---

## 1. 当前生产调用图（Phase 0 实测，未改）

```text
UI / Single / Batch / Resume
        ↓
ONE Production Writing Entry
        ↓
Outline Adapter / Continuation Adapter     ← 仍负责 Source Collection
        ↓
Collect → Normalize → Plan → Allocate → Render → Requirements → Policy
        ↓
ONE Freeze                                 ← freezeFingerprint 权威
        ↓
runWritingStages                           ← 串行 for + await
  Draft → Review → Audit/FactCheck → Revision → Proof
  → Local FinalValidate → Persist
        ↓
Shared Writer Core
  → compileSharedWritingPrompt             ← 每个 Stage 都带完整【冻结上下文】
  → callWritingStageLLM                    ← 主调用；必要时 +1 Formatter
        ↓
Durable Artifacts / Ledger / Attempts
        ↓
PostWriting
  Outline: finalizeChapterMemory（本地定稿 + 后台整理）
  Continuation: State Extraction Outbox（后台）
```

场景侧仍可做 Source Collection。最终 Budget 决策仍是 `allocateWritingContextBudget`（一份）。本轮没有新增第二套 Planner / Writer / Memory。

---

## 2. 样本 A：结构基线（可重复，无 LLM）

由 `measureStructuralChapterObservability()` 冻结真实 `WritingRequest` 并编译冻结策略会派出的付费 Stage。证据：`test-logs/phase0-structural-baseline.json`（本地生成，不入库）。

### 2.1 Outline 标准

| 指标 | 值 |
|---|---|
| generationTraceId | `gt-one-shot-outline` |
| freezeFingerprint | `9ca34ac9…122e7ebf` |
| Paid stages | Draft, Review, FactCheck, Revision, Proof |
| Formal skip | Audit / `policy.outline.review_covers_audit` |
| logical / physical / formatter | 5 / 5 / 0 |
| chapterWritingPaidCallCount | **5** |
| candidate / allocated / rendered | 130 / 130 / 193 |
| frozenContextTokens | 193 |
| stageProjectedContextTokens | 4031 |
| duplicateContextTokens | 916 |
| duplicateContextRatio | **0.2272** |
| contextBuildMs / freezeMs | 2 / 0（fixture 本机） |

小 fixture 里协议/指令/输出契约占比高，所以重复率看起来不高。这 **不是** 大项目的真实重复率，见 §4。

### 2.2 Continuation 标准

| 指标 | 值 |
|---|---|
| generationTraceId | `gt-one-shot-continuation` |
| freezeFingerprint | `fc18baaf…1cf64a7` |
| Paid stages | Draft, Review, Audit, Revision, Proof |
| Formal skip | FactCheck / `policy.continuation.audit_covers_factcheck` |
| chapterWritingPaidCallCount | **5** |
| frozenContextTokens | 81 |
| stageProjectedContextTokens | 2138 |
| duplicateContextTokens | 544 |
| duplicateContextRatio | **0.2544** |

Canon / Boundary / Seam / Anchor / Story Memory 都作为 Source 进入同一 Freeze。Continuation 没有第二套 Writer。

### 2.3 One-Shot

| 指标 | 值 |
|---|---|
| executionProfile | `one_shot` |
| Paid stages | Draft only |
| Formal skip | Review / Audit / FactCheck / Revision / Proof（`profile.one_shot.skip_*`） |
| chapterWritingPaidCallCount | **1** |
| formatter / protocolFallback | 0 / 0 |
| duplicateContextRatio | **0** |
| stageProjectedContextTokens | 1073（单次携带完整 Frozen Context，无跨 Stage 重复） |

PostWriting Auxiliary 单独计数；测试锁定它 **不会** 并入 `chapterWritingPaidCallCount`。

### 2.4 Batch

3 章 Outline 标准结构样本：每章 Paid=5，duplicateContextRatio=0.2272。批次规划器（`batch_planner`）是编排调用，**不计入**章节正文 Paid。

---

## 3. 样本 B：历史真实 LLM（重建，不是本轮新跑）

本 Phase **没有**再跑 10 章真实 LLM。下列数字来自仓库已封口报告与上一轮实测，作为 Before 对照。仪器就绪后，下一轮必须用 `generationTraceId` 重采。

### 3.1 Outline 标准 · 单章墙钟（n=1）

来源：`5b1eb00` Debug 覆盖安装；项目 `qa-outline-pdca-20260817`；批次 `batch_msx1n2c3_mm7ymo`；第 1 章「夜雨码头」。

| 指标 | 值 |
|---|---|
| chapterE2EMs | **437000** |
| P50 / P95 | 437000 / 437000（n=1，不得外推） |
| Formatter / Fatal / Silent Context Loss / Live Read / False Applied | 全 0 |
| Draft | 129s / 12793 output tokens |
| Review | 39s / 4156 output |
| FactCheck | ~40s / 4478 output |
| Revision | 7.2s / 640 output（正文 5634 字复用初稿） |
| Proof | **217s / 31197 output**（约 50% 墙钟） |
| Draft + Proof | ≈ **79%** 墙钟 |

根因线索（历史）：UI「平衡」但库字段 `reasoning_effort=high`，Proof 思考+重写输出极大。本轮 **不改** reasoning 策略，只记下这是最大单 Stage 时间洞。

### 3.2 Outline / Continuation 3/3 穿测

来源：`TAVO-MINI_Writing-Kernel_V1.0_验收报告_2026-08-17.md`。

- Outline 3/3 成功，五主阶段 attempt 1。
- Continuation 3/3（章 72/73/74）finalized；18 个物理 Stage success；Story Memory / outbox completed。

该报告未按本轮四分口径拆 physical / formatter / protocol_fallback。只能确认当时没有把 Formatter 当主路径。

### 3.3 One-Shot 5+5（已封口）

来源：`TAVO-MINI_极速档_One-Shot_验收报告_20260818.md` / 最终封口报告。

| 样本 | Paid / 章 | Formatter | 非 Draft 付费 Stage | 典型 input |
|---|---|---|---|---|
| Outline 5 章 `batch_msxge8k6_wjw1po` | 1 | 0 | 0（正式 skip） | ~1.5K（小项目弹性预算） |
| Continuation 5 章 `batch_msxtwf9x_5jecza` | 1 | 0 | 0 | **25.7K–27.7K**（Canon/Seam/Style/Memory） |

同一套 Elastic Budget，无 32K/100K 固定上限。One-Shot 正文 Paid≤1 继续视为已封板红线。

---

## 4. Duplicate Context：结构样本 vs 大上下文外推

当前 `compileSharedWritingPrompt` 对每个付费 Stage 都写入完整 `【冻结上下文】`，再叠加 `previousArtifactBlock`（Draft+Review+Audit+FactCheck+Revision 全文）。

| 场景 | frozen | 付费 Stage 数 | 结构重复率 | 说明 |
|---|---|---|---|---|
| Outline 小 fixture | 193 | 5 | 0.2272 | 协议开销主导 |
| Continuation 小 fixture | 81 | 5 | 0.2544 | 同上 |
| One-Shot | 193 | 1 | 0 | 没有跨 Stage 重复 |
| Continuation 真实 One-Shot input 26K，若换成标准 5 Stage 且每 Stage 都带满 Frozen | ~26000 | 5 | **约 0.75–0.80** | `4 × frozen / (5 × frozen + 协议 + 前序 Artifact)` |

叠加完整检查报告后，Revision/Proof 的输入还会再涨。这是 Phase 2 Stage Projection / Findings Aggregator 的主攻点。**不是**本轮已实现的优化。

---

## 5. Stage / 并发 / PostWriting

| 观测 | 现状 |
|---|---|
| stageQueuedMs | 串行交接，fixture 上接近 0 |
| stageExecutionMs | 真实 LLM 上 ≈ Stage 墙钟（见 §3.1） |
| stageDependencyWaitMs | **恒为 0**。还没有 DAG，也没有 Review∥FactCheck |
| stagePersistMs | Durable adapter 写入时间；相对 LLM 可忽略 |
| Proof | 历史最大洞（217s / 50%） |
| Revision | 历史已收回为 Brief（7.2s）；无问题时应在 Phase 3 变 formal skip |
| PostWriting blocking | Outline `finalizeChapterMemory` 本地定稿后排队后台；Continuation extract_state 走 Outbox。`postWritingBlockingMs` 基线 ≈ 本地 SQLite，不是第二次正文 LLM |
| 正常用户确认 Barrier | 续写状态确认仍存在，**本轮未收**。这是 Phase 1 第一优先级 |

---

## 6. Before 对照表（后续 Phase 必须回填 After）

| 指标 | Outline 标准 | Continuation 标准 | One-Shot | Batch |
|---|---|---|---|---|
| Chapter E2E P50 | 437s（n=1 历史） | 未按新口径重采 | 未按新口径重采 | 未按新口径重采 |
| Chapter E2E P95 | = P50（n=1） | — | — | — |
| Paid Logical Stage Calls | 5 | 5 | 1 | 5 / 章 |
| Physical HTTP Requests | ≥5（+formatter/fallback 另计） | ≥5 | 1 | 5 / 章 + 1 次 batch_planner |
| Formatter Rate | 历史该章 0；契约上标准档允许 1 次挽救 | 同左 | **0**（硬门禁） | 同标准档 |
| Protocol Fallback Rate | 本轮仪器新建，历史未拆 | 同左 | 同左 | 同左 |
| Input Tokens / Chapter | 历史未按新字段固化 | One-Shot 实测 25.7K–27.7K | Outline 小项目 ~1.5K | 随资料规模 |
| Duplicate Context Ratio | 小 fixture 0.2272；大上下文外推 ~0.75+ | 小 fixture 0.2544 | 0 | 同 Outline 标准 |
| Revision Trigger Rate | 当前策略=必跑 | 必跑 | formal skip | 必跑 |
| Proof Trigger Rate | 当前策略=必跑 | 必跑 | formal skip | 必跑 |
| PostWriting Blocking Ms | 本地定稿级，LLM 后台 | Outbox 后台 | 不得计入正文 Paid | 同左 |

After 列留空，等 Phase 1–4 用同一仪器填写。禁止现在写“提速 x%”。

---

## 7. 生产调用图审计（Root Cause）

1. **钱花在 5 次付费 Stage。** One-Shot 已经证明 1 次能落库；标准档仍无条件跑 Review/Audit/FactCheck/Revision/Proof。
2. **Token 花在重复运输 Frozen Context。** Prompt 编译器对每个 Stage 嵌入完整 `rendered.text`。这不是五套 Budget，但是五次同一份真相的拷贝。
3. **Token 还花在无脑叠加检查报告全文。** `previousArtifactBlock` 没有 Findings Aggregator。
4. **墙钟花在 Draft 和 Proof。** 历史单章 79%。条件 Proof / 条件 Revision 必须靠 A/B，不能先砍。
5. **时间不花在串行等待 DAG。** 现在根本没有 DAG。`stageDependencyWaitMs=0` 是基线，不是优化成果。
6. **正文 Persist 之后的 Memory/State 已大部分离开关键路径。** 真正堵批量的是续写正常确认 Barrier（Phase 1）。

---

## 8. 本轮改动边界（确认没有越权）

做了：

- `src/services/writing/observability/*` 观测契约与收集器
- Freeze / Writer / Stage Runner / Trace persist 挂采集
- Outbox extract_state、`finalizeChapterMemory` 可选 `generationTraceId` 记 PostWriting Auxiliary
- Durable parse 接受 `skipped` + 可选 observability（观测字段损坏时 fail-soft，不阻断 Resume）
- 新门禁与 Generation Stability 接入

没做：

- 没有新 Writer / Compiler / Context Builder / Memory 系统
- 没有改 Elastic / Hierarchical Budget 公式
- 没有改 Canon / Boundary / Seam
- 没有改 One-Shot 封板契约
- 没有条件 Revision / 条件 Proof / 并发 Stage
- 没有取消续写确认 Barrier

---

## 9. 验证

| 项 | 结果 |
|---|---|
| `npm run lint` | PASS，0 errors / 203 warnings（存量） |
| `npm run typecheck` | PASS |
| `npm run verify:version` | PASS，V2.11.53 / 2115300 |
| Full Jest | PASS，465 passed / 4 skipped suites；3592 passed / 9 skipped tests |
| Generation Stability 同款命令 + 新 2 个文件 | PASS，28 suites / 150 tests |
| 本轮新 10 章真实 LLM | 未执行。仪器已挂上，Phase 1 起按同一口径采 |
| Android Debug | PASS，`dist/apk/debug/ShineWriter-V2.11.53-debug.apk`（56.51 MB），`BUILD SUCCESSFUL in 1m 14s`。Phase 0 无 UI 行为变化 |

---

## 10. 决策

**GO — proceed to Phase 1 ONE Memory。**

Phase 1 入口条件已满足：能区分四种调用、能算 duplicate ratio、能把 PostWriting Auxiliary 从正文 Paid 里拆开、有 Outline / Continuation / One-Shot / Batch 四类样本。

下一轮仍禁止宣布 `ONE FLOW FINAL SEALED / GO`，直到 Phase 4 集成长测的 Before/After 表填完。
