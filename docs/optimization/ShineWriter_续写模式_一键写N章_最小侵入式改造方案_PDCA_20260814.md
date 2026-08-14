# ShineWriter 续写模式「一键写 N 章」改造方案
## —— 基于现有 MultiChapterBatch 外层编排能力的最小侵入式接驳方案

> 文档性质：可执行工程方案 / PDCA 实施计划  
> 目标范围：仅为「原著续写」模式增加“一键写 N 章”能力  
> 核心约束：**优先复用现有大纲模式 MultiChapterBatch 的批次外壳，不轻易改动大纲创作模块；续写模式继续使用自身 Continuation Generation / Canon / Source / State 体系作为单章执行权威。**  
> 路径约定：本文全部使用**仓库相对路径**，不得依赖任何固定盘符、用户名或本机绝对路径。  
> 停止条件：全部 GO Gate 通过，且独立自审无新增 P0/P1，剩余 NO-GO = 0。

---

# 0. 执行摘要

本次改造不是“复制一份大纲模式的一键写 N 章”，也不是“让续写模式调用普通 `runChapterPipeline()`”。

正确架构：

```text
                    MultiChapterBatch Core
                           │
             ┌─────────────┴─────────────┐
             │                           │
     Outline Existing Path      Continuation Batch Adapter
             │                           │
      Outline Planner           Continuation Batch Planner
             │                           │
   runChapterPipeline()       startContinuationRun()
             │                           │
    Pipeline Adoption       Continuation Final Adoption
             │                           │
         下一章             Finalize + State Freshness Gate
                                         │
                                      下一章
```

本期原则：

1. **复用 Batch 外壳，不复用错误的单章执行内核。**
2. **Continuation V5 继续是续写单章生成权威。**
3. **Outline 现有路径默认保持原样，只做必要接驳。**
4. **每章只消费当前章计划，不注入未来章节详细计划。**
5. **上一章完成 eligible → adoption → finalize → state ready 后，才允许启动下一章。**

---

# 1. 背景与现状

## 1.1 大纲模式现有一键写 N 章

当前主要模块：

```text
src/screens/MultiChapterBatchScreen.tsx
src/store/multiChapterBatchStore.ts
src/services/multiChapterBatch/*
src/data/repositories/multiChapterBatchRepository.ts
src/types/multiChapterBatch.ts
```

现有 MultiChapterBatch 已具备可靠的外层 Orchestrator：

```text
Planner
→ 用户确认 N 章计划
→ 严格串行 Item 1..N
→ 创建 Chapter
→ 创建单章 Pipeline Task
→ 运行单章 Pipeline
→ Adoption
→ durable commit
→ 下一章
```

可直接复用的能力：

- SQLite 作为批次状态权威；
- Batch / Item 持久化；
- Lease 防重复执行；
- Pause / Resume / Cancel；
- 冷启动恢复；
- Retry；
- 批次预算；
- 前台通知；
- 进度页 / 报告页；
- 项目尾部漂移保护；
- 每章完成后才推进 ordinal 的串行原则。

## 1.2 续写模式现有单章执行链

续写模式当前不是 Outline Pipeline，而是独立链路：

```text
startContinuationRun()
→ Continuation Context Freeze
→ Continuation V5
→ Final Artifact
→ awaiting_user / awaiting_regeneration / failed / outdated
→ adoptArtifactAsDraft()
→ finalizeContinuationChapter()
→ State Extraction Outbox
→ Story Memory rebuild
```

续写还具有 Outline 没有的约束：

- Source Boundary；
- Future Source 禁止泄漏；
- Canon Snapshot / Revision；
- Continuation State；
- Story Memory；
- Continuation Chapter Position 与显示章节号分离；
- 上一续写章节作为下一章正文接缝；
- V5 Final `eligible / rejected`；
- Adoption CAS / optimistic concurrency；
- Finalize 后状态提取；
- Source / Canon 变化导致 Run outdated。

因此续写多章能力必须建立专用 Adapter，不能直接走普通 Pipeline。

---

# 2. 本期目标

本期只完成：

1. 续写工作台增加“一键续写 N 章”入口；
2. 复用现有 MultiChapterBatch 外层批次能力；
3. 增加 Continuation 专用 Batch Planner；
4. 增加 Continuation 专用 Batch Execution Adapter；
5. 每章继续使用现有 Continuation V5；
6. 每章只注入当前章 Plan Projection；
7. eligible Final 支持安全自动 Adoption；
8. Adoption 后自动 Finalize；
9. State Extraction / Story Memory 达到安全条件后才进入下一章；
10. 支持 Pause / Resume / Cancel / Cold Start；
11. 保持现有 Outline 一键写 N 章行为不变；
12. 保持旧 Batch、旧 Continuation Run 可读可恢复。

---

# 3. 非目标

明确不做：

- 不重构 `runChapterPipeline()`；
- 不统一 Outline Pipeline 与 Continuation V5；
- 不修改 Continuation V5 阶段设计；
- 不重写 Canon；
- 不重写 Source Reader；
- 不重写 Story Memory；
- 不重写 Continuation State Extraction；
- 不做多章并行生成；
- 不扩展 Freeform 批量写作；
- 不改变单章续写默认交互；
- 不改变旧 Outline Batch 数据语义；
- 不为了“代码统一”而重构大纲创作主链；
- 不新增与本功能无关的资源、RAG、Memory 架构。

---

# 4. 改造边界

## 4.1 总原则

采用：

> **Additive Adapter，而不是 Rewrite Core。**

如果可以通过新文件、新字段、小型条件分流解决，则不得为了抽象统一去大面积改已有 Outline 代码。

## 4.2 推荐新增模块

建议新增：

```text
src/services/multiChapterBatch/
  batchMode.ts
  continuationBatchAdapter.ts
  continuationBatchPlanner.ts
  continuationBatchPlannerCompiler.ts
  continuationBatchStateGate.ts
  continuationBatchUsage.ts

src/types/
  continuationMultiChapterBatch.ts   # 仅在确实需要独立类型时新增
```

也可以放在：

```text
src/services/continuation/batch/
```

但依赖方向必须保持：

```text
MultiChapterBatch Core
→ Continuation Batch Adapter
→ Existing Continuation Services
```

禁止让 Continuation Generation 反向依赖 Batch Screen / Store。

## 4.3 允许小幅修改的模块

### `src/types/multiChapterBatch.ts`

允许：

- 新增 `writingMode`；
- 新增 Continuation Batch 错误码；
- 新增通用 execution reference 类型。

禁止：

- 删除旧字段；
- 改变旧 Outline 状态语义；
- 强制迁移旧 Batch 到新执行结构。

### `src/data/repositories/multiChapterBatchRepository.ts`

允许：

- 新字段映射；
- Continuation Run Binding；
- Batch Anchor / Execution Policy 读写；
- Continuation Item 的原子提交 API。

禁止：

- 改变旧 `active_pipeline_task_id` 语义；
- 将 Continuation Run ID 写入 `active_pipeline_task_id`；
- 降低已有事务原子性。

### `src/store/multiChapterBatchStore.ts`

允许：

- 新 Batch 创建时接收 `writingMode`；
- Planner 按模式分流；
- Continuation 模式 Start / Resume / Cancel 调用 Adapter。

禁止：

- 复制第二套完整 Store；
- 修改 Outline 默认 Planner 行为；
- 修改 Outline 默认 pipeline mode / workflow 语义。

### `src/services/multiChapterBatch/reconcileMultiChapterBatch.ts`

这是最敏感接驳点。

允许：

- 在必要 action 上按 `writingMode` 增加 Continuation 分支；
- Continuation 分支委托给 Adapter。

建议优先：

```ts
if (batch.writingMode === 'continuation') {
  return continuationBatchAdapter.handle(...)
}

// 旧 Outline 分支尽量原样保留
return existingOutlineBehavior(...)
```

禁止：

- 为本功能重写整个 Reconciler；
- 把现有 Outline action 全量迁移到新抽象；
- 修改 `runChapterPipeline()` 语义；
- 让 Continuation 强行使用 Pipeline Task。

### `src/screens/MultiChapterBatchScreen.tsx`

允许：

- route mode；
- 模式文案；
- Continuation Anchor 展示；
- Continuation 暂停原因；
- 状态同步阶段展示。

禁止：

- 拆掉或重做 Outline UI；
- 改变 Outline 原创建 / 预览 / 运行 / 暂停 / 报告交互。

### `src/screens/continuation/ContinuationWorkspaceScreen.tsx`

只做必要入口：

```text
[新建续写章节] [一键续写 N 章]
```

除入口外，不做无关重构。

### `src/navigation/TabNavigator.tsx`

只允许给 Route 增加可选参数：

```ts
MultiChapterBatch:
  | { writingMode?: 'outline' | 'continuation' }
  | undefined;
```

Outline 旧入口不传参数时必须默认 `outline`。

## 4.4 原则上禁止改动的模块

除非接驳时发现现有明确 Bug，否则以下模块只调用、不重构：

```text
src/services/pipeline/*
src/services/pipelineRunner*
src/services/contextBuilder*
src/services/storyMemory/*
src/services/continuation/canon/*
src/services/continuation/continuationSourceReader.ts
src/services/continuation/generation/continuationV5Runner.ts
src/services/continuation/generation/continuationV5PromptCompiler.ts
src/services/continuation/generation/finalArtifactValidator.ts
src/services/writerStyle/*
```

尤其禁止为了 Batch 改 Continuation V5 Prompt。

Batch 当前章计划必须通过现有 `userInstruction` 接入。

---

# 5. Batch Mode 数据模型

定义：

```ts
export type MultiChapterWritingMode =
  | 'outline'
  | 'continuation';
```

本期不要求把 Outline 全量抽成 Adapter。优先保持：

```text
outline      → existing path
continuation → new adapter
```

未来若验证稳定，再另立任务抽取通用 Outline Adapter。

---

# 6. Schema 方案

采用 Additive Migration。

## 6.1 `multi_chapter_batches`

建议新增：

```text
writing_mode TEXT NOT NULL DEFAULT 'outline'
continuation_anchor_json TEXT NULL
continuation_execution_policy_json TEXT NULL
```

`continuation_anchor_json` 示例：

```json
{
  "schemaVersion": 1,
  "sourceId": 1,
  "sourceVersion": 3,
  "sourceSha256": "...",
  "boundaryChapterId": 120,
  "boundaryPosition": 119,
  "boundaryCharOffsetExclusive": 123456,
  "canonSnapshotId": "...",
  "canonRevision": 8,
  "startingContinuationTailChapterId": 42,
  "startingContinuationTailPosition": 3,
  "startingContinuationTailRevisionHash": "..."
}
```

用途：

- 记录本批规划时的 Source / Canon / 续写尾部；
- 检测批次启动前和运行中的外部漂移；
- 不是每章 V5 Snapshot；
- 不替代 Continuation 自身 Freeze。

## 6.2 `multi_chapter_batch_items`

新增：

```text
active_continuation_run_id TEXT NULL
```

禁止：

```text
active_pipeline_task_id = 'ct_xxx'
```

两个执行系统必须保持语义独立。

## 6.3 可选字段

只有测试证明必要时再加：

```text
finalized_revision_hash TEXT NULL
state_sync_status TEXT NULL
state_sync_fingerprint TEXT NULL
```

本期优先最小字段集，避免过度建模。

---

# 7. Continuation Batch Planner

## 7.1 必须独立于 Outline Planner

新增：

```text
continuationBatchPlanner.ts
continuationBatchPlannerCompiler.ts
```

禁止直接改当前 Outline Planner Prompt 让其“兼容两种模式”。

原因：

```text
Outline Planner authority
= Project Outline

Continuation Planner authority
= Source Boundary + Canon + Current Continuation State
```

两者不是同一语义。

## 7.2 Planner Materials

建议：

```ts
interface ContinuationBatchPlannerMaterials {
  sourceBoundary: string;
  canonHardFacts: string;
  continuationState: string;
  recentContinuation: string;
  storyMemory: string;
  styleSummary?: string;
}
```

优先级：

```text
Protected
- Source Boundary identity / seam
- Canon Hard Constraints
- 用户本批续写目标
- N
- Output Protocol

Preferred
- 当前 Continuation State
- 最近续写摘要 / 关键状态

Elastic
- Story Memory
- Style summary
- Supplement
```

## 7.3 原著读取边界

Planner 的原著内容只能通过：

```text
continuationSourceReader
```

禁止：

- 直接查 Source chunks；
- 调用 UI future browsing 接口；
- 读取 Boundary 之后正文；
- 为 Batch Planner 开 Future Source 特例。

硬合同：

> **未来原著不可进入批量续写 Planner，也不可进入当前章生成。**

## 7.4 Planner 输出

继续使用现有 `BatchChapterPlanItem`：

```json
{
  "ordinal": 1,
  "title": "夜访旧宅",
  "synopsis": "...",
  "keyBeats": ["...", "..."],
  "carryIn": "...",
  "carryOut": "...",
  "targetWords": 3000
}
```

本期不新增长期 Plan Schema。

---

# 8. Future Plan Leakage 防护

这是 P0 不变量。

假设：

```text
Item 1：发现密室
Item 2：确认凶手是 A
Item 3：A 将伏击主角
```

执行 Item 1 时，传给 `startContinuationRun()` 的 `userInstruction`：

必须包含：

```text
本批目标
Item 1 title
Item 1 synopsis
Item 1 keyBeats
Item 1 carryIn
Item 1 carryOut
Item 1 targetWords
```

必须不包含：

```text
Item 2 详细计划
Item 3 详细计划
```

建议 Builder：

```ts
buildContinuationBatchChapterInstruction(batch, currentItem)
```

禁止把 `plannerOutputJson` 整体拼入单章 Prompt。

---

# 9. 两级冻结

## 9.1 Batch Freeze

计划确认时冻结：

- N 章 Plan；
- Planner Hash；
- Batch Anchor；
- Execution Policy；
- reasoning / generation policy；
- Batch Budget；
- writingMode。

## 9.2 Per-Chapter Freeze

每章真正开始时调用：

```text
startContinuationRun()
```

由 Continuation V5 为该章重新创建自己的冻结 Snapshot。

禁止在 Batch 创建时提前冻结 N 章全部 Continuation Context。

原因：第 N+1 章必须看到第 N 章真实定稿后的 Continuation State、Story Memory 和正文接缝。

---

# 10. Chapter 创建与编号

Continuation Batch 创建章节必须调用：

```text
getNextContinuationChapterPosition()
getContinuationChapterNumbering()
```

不能用 Batch `ordinal` 作为真实显示章节号。

示例：

```text
原著边界：第 120 章
已有续写：第 121～124 章

Batch ordinal=1
→ continuation position=4
→ 显示第 125 章
```

Title 规则：

1. Planner 自定义标题保留；
2. 纯自动标题走 Continuation Numbering；
3. 用户自定义标题不得被重编号覆盖。

---

# 11. Continuation Execution Adapter

建议新增：

```text
continuationBatchAdapter.ts
```

核心启动：

```ts
startContinuationRun({
  projectId,
  chapterId,
  targetPosition,
  userInstruction: buildContinuationBatchChapterInstruction(...),
  currentChapterContent: '',
})
```

随后原子绑定：

```text
active_continuation_run_id
```

Batch 层不得自己编译 Continuation V5 Prompt。

---

# 12. Continuation Run 状态映射

建议内部观察类型：

```ts
type BatchExecutionObservation =
  | { status: 'running' }
  | { status: 'awaiting_adoption'; runId: string }
  | { status: 'awaiting_regeneration'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'outdated'; reason: string }
  | { status: 'cancelled' }
  | { status: 'interrupted' };
```

映射：

```text
Continuation running
→ 当前 Item 运行中

awaiting_user + eligible final
→ adoption

awaiting_regeneration
→ Batch pause

failed
→ Batch pause / retry classification

outdated
→ Batch pause

interrupted
→ Resume candidate
```

不要求本期重命名全部旧 Batch Item 状态；可以 mode-aware 复用旧状态并通过 errorCode / pauseReason 区分。

---

# 13. Auto Adoption

一键 N 章必须允许安全自动 Adoption，否则每章都会等待手工操作。

只有全部满足才允许自动采用：

```text
run.state == awaiting_user
AND final artifact exists
AND artifact 可被当前 workflow adoption
AND artifact.eligibilityStatus == eligible
AND Source / Canon freshness pass
AND chapter 无并发编辑冲突
AND Batch policy.autoAdoptEligibleFinal == true
```

实际采用必须调用：

```text
adoptArtifactAsDraft()
```

禁止：

- Batch 直接 UPDATE chapter content；
- 绕过 Run CAS；
- 绕过 eligible；
- 绕过 freshness；
- 绕过 optimistic concurrency。

---

# 14. Soft Warning 策略

第一版默认保守：

```text
eligible + 无需人工确认的 warning
→ 自动采用

eligible + 需要人工确认的 soft warning
→ Pause

rejected
→ Pause

awaiting_regeneration
→ Pause
```

建议冻结：

```ts
interface ContinuationBatchExecutionPolicyV1 {
  schemaVersion: 1;
  autoAdoptEligibleFinal: true;
  pauseOnSoftWarning: true;
}
```

第一期不要给用户暴露“关闭所有安全暂停”的开关。

---

# 15. Finalize Gate

Adoption 完成不等于 Item 成功。

必须继续调用：

```text
finalizeContinuationChapter()
```

Finalize 成功后才进入 State Sync Gate。

理由：Finalize 会完成续写模式自己的 finalized / state extraction / Story Memory 链。

---

# 16. State Freshness Gate

这是本期最关键的新模块之一：

```text
continuationBatchStateGate.ts
```

执行顺序：

```text
第 N 章 Final eligible
→ Auto Adopt
→ Finalize
→ State Extraction
→ Story Memory rebuild
→ Freshness Check
→ Item succeeded
→ ordinal + 1
→ 第 N+1 章
```

建议接口：

```ts
checkNextChapterReady({
  projectId,
  completedChapterId,
  completedPosition,
  policy,
}): Promise<
  | { ready: true }
  | { ready: false; status: 'waiting'; reason: string }
  | { ready: false; status: 'blocked'; reason: string }
>
```

至少确认：

1. 本章已 finalized；
2. extract_state 未失败；
3. 必要 Continuation State 可读取；
4. Story Memory 无 hard gap；
5. Source 未变化；
6. Canon Snapshot / Revision 未变化；
7. 尾章没有用户并发修改。

硬 Gate：

> **State 未 ready 时，下一章 LLM call 必须为 0。**

---

# 17. State Gate 等待策略

禁止无限 busy loop。

采用：

- 有界 polling；
- 可取消；
- 有 deadline；
- 超过时间进入 pause；
- 冷启动后可以恢复检查。

可以第一期复用 `waiting_retry`，通过专用 errorCode 表明是 state sync wait，避免为了一个状态大改全状态机。

---

# 18. Item 成功定义

Outline 旧语义不改。

Continuation 新语义：

```text
Item succeeded
=
Final eligible
+ Adoption committed
+ Chapter finalized
+ Required state synchronization satisfied
```

不是：

```text
LLM 返回正文
```

也不是：

```text
Run awaiting_user
```

---

# 19. 下一章 Anchor

Batch 不自行保存或拼接上章全文。

下一章仍由 Continuation Context Builder 决定正文接缝：

```text
第 1 章 → Source Seam
第 2 章 → 第 1 章续写正文
第 3 章 → 第 2 章续写正文
```

禁止新增 Batch 级正文缓存作为生成权威。

---

# 20. Drift Guard

Continuation Batch 需要检测：

- 用户新增 / 删除尾章；
- 用户修改尾章正文；
- Source 换源；
- Boundary 改变；
- Canon Snapshot 改变；
- Canon Revision 改变。

发生变化时 fail closed：

```text
Batch → paused_project_changed
```

第一期优先复用已有 pause status，再通过新 errorCode 区分，避免扩展状态枚举造成大范围修改。

---

# 21. Error Code

建议新增：

```text
BATCH_PROJECT_MODE_MISMATCH
BATCH_CONTINUATION_SOURCE_CHANGED
BATCH_CONTINUATION_BOUNDARY_CHANGED
BATCH_CONTINUATION_CANON_CHANGED
BATCH_CONTINUATION_RUN_FAILED
BATCH_CONTINUATION_RUN_OUTDATED
BATCH_CONTINUATION_FINAL_REJECTED
BATCH_CONTINUATION_ADOPTION_FAILED
BATCH_CONTINUATION_FINALIZE_FAILED
BATCH_CONTINUATION_STATE_SYNC_FAILED
BATCH_CONTINUATION_STATE_SYNC_TIMEOUT
BATCH_CONTINUATION_CHAPTER_CONFLICT
```

已有 `BATCH_PROJECT_NOT_OUTLINE` 不必删除，可保留旧兼容；新批次创建入口用 `writingMode` 做模式匹配。

---

# 22. Resume 设计

Continuation Batch Resume 必须识别：

```text
A. Chapter 未创建
→ 创建

B. Chapter 已创建，Run 未创建
→ startContinuationRun

C. Run running
→ attach / observe

D. Run interrupted
→ resumeInterruptedRun

E. Run awaiting_user + eligible
→ 继续 adoption

F. Run 已 adopted，但未 finalize
→ finalize

G. 已 finalize，但 state sync 未 ready
→ 继续 state gate

H. awaiting_regeneration
→ pause 等用户

I. outdated
→ pause
```

禁止已有 `active_continuation_run_id` 时再创建新的 Run。

---

# 23. Idempotency

必须满足：

```text
chapterId present
→ 不重复创建 Chapter

activeContinuationRunId present
→ 不重复 startContinuationRun

run 已 adoption
→ 不重复 Adoption

chapter 已 finalized
→ 不重复破坏性 Finalize

outbox dedupe 已存在
→ 不重复创建语义任务

item succeeded
→ 不再执行
```

---

# 24. Cancel

Continuation Batch Cancel：

1. 当前 active Run 调 `cancelContinuationRun()`；
2. 未开始 Item 标 cancelled；
3. 已完成章节保留；
4. 已采用正文不得删除；
5. cancel 后不得自动进入下一章；
6. Cancel 必须幂等。

---

# 25. Retry

Batch 层不得绕过 Continuation V5 自身 Reservation / Request Cap。

禁止：

- `awaiting_regeneration` 自动创建新 Run；
- output contract failure 自动开始第二个 V5；
- Batch 为了“重试”绕过 V5 物理请求上限。

Batch 自动恢复只用于现有 Run 的 resumable / interrupted 状态。

新 Run 必须由显式用户操作触发。

---

# 26. Batch Usage / Budget

Outline 统计保持原样。

Continuation Adapter 从现有 Run telemetry / `tokenUsageJson` 汇总：

```text
usedLlmCalls
usedInputTokens
usedOutputTokens
```

不得要求 Continuation V5 写入 Pipeline Attempt 表。

---

# 27. Planner Budget

Continuation Batch Planner 采用弹性预算思想。

Protected：

```text
Source Boundary identity / seam
Canon Hard Facts
用户本批续写目标
N
Output Protocol
```

Elastic：

```text
Continuation State detail
Recent continuation
Story Memory
Style summary
Supplement
```

Protected Overflow：

```text
0 LLM call
+ 显式 block
```

禁止 silently clip 用户本批目标。

---

# 28. UI

## 28.1 ContinuationWorkspace

增加：

```text
[新建续写章节] [一键续写 N 章]
```

不改现有章节列表主结构。

## 28.2 Batch Create View

续写模式显示：

```text
一键续写 N 章

当前承接：原著第 X 章
当前已续写到：第 Y 章

生成章数：N
每章目标字数：...

本批续写目标：
[ multiline ]

[生成续写计划]
```

## 28.3 Preview

复用：

- title；
- synopsis；
- keyBeats；
- carryIn；
- carryOut；
- targetWords。

显示真实章节号，例如：

```text
第 125 章
批次 1 / 3
```

## 28.4 Running

允许显示：

```text
第 2 / 3 章 · 第 126 章
当前阶段：Final Reviser
随后：采纳 → 定稿 → 状态同步
```

State Gate 时：

```text
正在同步人物状态与故事记忆…
```

## 28.5 Pause

原因至少包括：

```text
Canon 已变化
Source / Boundary 已变化
最终稿需人工确认
状态同步失败
续写 Run 失败
章节被手动修改
```

操作按原因展示，不得所有暂停状态都显示同一组无脑按钮。

---

# 29. Navigation / Store 兼容

Route：

```ts
MultiChapterBatch:
  | { writingMode?: 'outline' | 'continuation' }
  | undefined;
```

Outline 入口保持：

```ts
navigate('MultiChapterBatch')
```

Continuation：

```ts
navigate('MultiChapterBatch', {
  writingMode: 'continuation',
})
```

若项目已有 active Batch：

- 以 SQLite 的 `batch.writingMode` 为准；
- route mode 只决定新建模式；
- route 与已有 Batch 冲突时不得创建第二个 active Batch。

---

# 30. Migration

Additive Migration 要求：

```text
旧 batch
→ writing_mode = outline

旧 item
→ active_continuation_run_id = NULL
```

禁止：

- 重建旧 Batch 语义；
- 重写旧 planner JSON；
- 自动重算旧 hash；
- 自动升级旧 workflow。

Migration Matrix：

```text
fresh install
previous schema → new
old outline batch draft
old outline batch ready
old outline batch running
old outline batch paused
old outline batch completed
```

全部可读。

---

# 31. Backup / Restore

验证新字段进入 Backup / Restore。

恢复后：

```text
Continuation Batch
+ active_continuation_run_id
```

必须仍能绑定对应 Continuation Run。

不得出现 Batch 恢复但 Run 引用丢失。

---

# 32. Foreground Notification

尽量复用 Batch Foreground。

Continuation 子阶段可映射：

```text
Context
Draft Writer
Narrative Architect
Revision Writer
Adversarial Auditor
Final Reviser
Final Validate
Adoption
Finalize
State Sync
```

不得为了通知显示去重构 Continuation V5 Runner。

若现有单章续写通知与 Batch 通知暂时共存，只要不重复启动业务逻辑、不崩溃，可先接受；后续另立 UI 优化任务。

---

# 33. 并发规则

硬规则：

```text
Max concurrent continuation chapter = 1
```

绝不并行第 N 和 N+1 章。

原因：

- Continuation State；
- Story Memory；
- Anchor；
- Canon evolution；
- Adoption；
- API cost；
- chapter numbering；

均要求严格顺序。

---

# 34. 用户编辑冲突

Batch 运行中如果用户修改目标 Chapter / project tail：

```text
Pause
```

不得静默覆盖。

Adoption 必须继续使用现有 optimistic concurrency。

---

# 35. 测试矩阵

## 35.1 Planner

- N 严格；
- JSON contract；
- fallback；
- Protected overflow 0 call；
- Source bounded；
- Future Source 不进入 prompt；
- targetWords；
- carryIn / carryOut。

## 35.2 Future Plan Leakage P0 Test

构造：

```text
Item 1：发现密室
Item 2：确认凶手是 A
Item 3：A 将伏击主角
```

执行 Item 1，检查 `startContinuationRun.userInstruction`：

```text
包含：发现密室
不包含：确认凶手是 A
不包含：A 将伏击主角
```

## 35.3 Snapshot Test

验证：

```text
Batch Planner 时 Source/Canon=A
第 1 章 V5 Snapshot=A
第 1 章完成并改变 State
第 2 章重新冻结 V5 Snapshot
第 2 章能看到第 1 章定稿后的状态
```

禁止复用第 1 章完整 Context Snapshot。

## 35.4 Adoption Test

覆盖：

```text
eligible → auto adopt
rejected → no adopt
awaiting_regeneration → no adopt
outdated → no adopt
manual edit → conflict / pause
foreign artifact → reject
V5 non-final artifact → reject
```

## 35.5 Finalize / State Gate Test

```text
Adopt
→ Finalize
→ Outbox
→ State Extraction
→ Story Memory ready
→ next ordinal
```

并验证：

```text
Finalize failed → item not succeeded
State extraction failed → item not succeeded
Story Memory hard gap → next chapter LLM call = 0
```

---

# 36. Crash / Resume 故障注入

至少：

```text
FI-01 Chapter INSERT 后 kill
FI-02 Run INSERT 后 kill
FI-03 Final Artifact 写入后 kill
FI-04 Adoption commit 后 kill
FI-05 Finalize commit 后 kill
FI-06 Outbox 处理中 kill
FI-07 State sync 完成但 item success 未 commit 前 kill
FI-08 Lease 过期 / 第二执行器抢占
FI-09 Cancel 与 Run stage 并发
FI-10 Source / Canon 变化与 Adoption 并发
```

必须保证：

- 无重复章节；
- 无重复 Run；
- 无重复 Adoption；
- 无静默覆盖；
- 无 Batch 层造成的重复付费请求。

---

# 37. Outline Regression —— 强制 Gate

完整验证现有 Outline 一键写 N 章：

```text
创建
Planner
预览编辑
Start
Draft
Review
FactCheck
Brief
Proof
Adoption
Pause
Resume
Cancel
Cold Start
Report
Budget
Migration
```

必须与改造前一致。

特别审计：

```text
runChapterPipeline
active_pipeline_task_id
outlineWorkflowVersion
contextBudgetVersion
```

确保 Continuation 分支没有改变旧路径。

---

# 38. Continuation 单章 Regression

必须确认：

```text
ChapterEditor
→ AI 续写
→ startContinuationRun
→ V5
→ Result
→ Adoption
→ Finalize
```

原行为保持。

批量 `autoAdopt` 只能属于 Batch Policy，不能改变单章默认交互。

---

# 39. Android E2E

## E2E-CB-01 正常三章

```text
创建 continuation project
导入 source
设置 boundary
Canon ready
进入续写工作台
点击一键续写 N 章
N=3
输入本批目标
生成计划
编辑计划
启动
Chapter 1 V5
自动采用
自动定稿
状态同步
Chapter 2
Chapter 3
完成
检查章节号 / 正文 / 状态
```

## E2E-CB-02 中途退出

```text
运行第 2 章
切 Tab
回 Workspace
重开 Batch
状态恢复
```

## E2E-CB-03 Kill / Relaunch

```text
运行中 kill app
重新打开
进入项目
恢复 Batch
不重复章节 / Run
```

## E2E-CB-04 Canon Drift

```text
第 1 章完成
Canon 改变
下一章 LLM call = 0
Batch paused
```

## E2E-CB-05 Manual Edit Conflict

```text
Run 生成中修改目标 chapter
Adoption
→ conflict
→ Batch pause
```

---

# 40. adb install -r 数据保留

至少验证：

```text
旧版本安装
创建 Outline Batch 历史
创建 Continuation Source / Canon / Chapters
安装新 APK（覆盖安装）
检查旧数据仍在
旧 Outline Batch 可查看
新 Continuation Batch 可创建
```

本文不写任何开发机绝对 adb / SDK 路径；由执行环境自行解析可执行文件。

---

# 41. 日志与隐私

允许：

```text
batchId
ordinal
chapterId
runId
status
stage
token count
error code
hash prefix
```

禁止：

```text
原著全文
章节正文
完整 Prompt
API Key
```

---

# 42. PDCA 执行轮次

## Round 0 — Baseline / Boundary Audit

只读确认：

- 当前 HEAD；
- 当前 Schema；
- MultiChapterBatch 真实链路；
- Continuation V5 真实链路；
- Navigation；
- Backup；
- CI；
- 当前测试。

输出：

```text
Baseline HEAD
Schema
Outline Batch execution chain
Continuation execution chain
Affected files
Protected files
```

Gate：

```text
GO-0 = 接驳面已明确
```

## Round 1 — Schema / Types

只做：

- `writingMode`；
- continuation anchor；
- execution policy；
- activeContinuationRunId；
- migration；
- repo mapping。

Gate：

```text
GO-1 = 旧 Outline 数据可读 + Migration Matrix GO
```

## Round 2 — Continuation Batch Planner

Gate：

```text
GO-2 =
Source bounded
Canon authority correct
N strict
Protected overflow 0 LLM
Future Source Leakage = 0
```

## Round 3 — UI / Navigation 最小接驳

只接：

- Workspace 入口；
- Route mode；
- Batch 文案；
- Preview numbering。

Gate：

```text
GO-3 = Outline UI 无回归 + 无绝对路径
```

## Round 4 — Chapter Creation / Numbering

Gate：

```text
GO-4 =
真实显示章节号正确
Custom title preserved
No duplicate position
```

## Round 5 — Continuation Execution Adapter

接：

```text
startContinuationRun
activeContinuationRunId
status observation
resume
cancel
```

先不做 Auto Adoption。

Gate：

```text
GO-5 =
Batch 可启动单章 V5
Run 不重复
Cold start 可重新绑定
```

## Round 6 — Auto Adoption / Finalize

接：

```text
eligible
→ adoptArtifactAsDraft
→ finalizeContinuationChapter
```

Gate：

```text
GO-6 =
非 eligible 绝不采用
Conflict 绝不覆盖
Finalize 前 Item 不成功
```

## Round 7 — State Freshness Gate

Gate：

```text
GO-7 = 上一章状态未安全落定 → 下一章 LLM call = 0
```

## Round 8 — Full Serial Orchestrator

串联：

```text
Plan
→ Item 1
→ State Gate
→ Item 2
→ State Gate
→ ...
```

Gate：

```text
GO-8 =
严格串行
Future Plan Leakage = 0
Duplicate = 0
```

## Round 9 — Resume / Fault Injection

执行 FI-01..FI-10。

Gate：

```text
GO-9 = Crash-safe + Idempotent + no duplicate billing from batch layer
```

## Round 10 — Regression / Android E2E

执行：

```text
Outline Batch regression
Continuation single chapter regression
Continuation Batch E2E
Migration
Backup
adb install -r
完整 CI
```

Gate：

```text
GO-10 = 全通过
```

## Round 11 — Independent Final Audit

独立重新验证：

```text
1. 是否改坏 Outline Batch？
2. 是否有 Future Plan Leakage？
3. 是否有 Future Source Leakage？
4. 是否每章重新冻结 Continuation Context？
5. 是否只有 eligible Final 能自动采用？
6. Adoption 后是否完成 Finalize？
7. State 未 ready 是否绝不启动下一章？
8. kill/resume 是否可能重复 chapter/run/adoption？
9. Source / Canon 改变是否 fail closed？
10. 单章续写是否保持原行为？
```

Gate：

```text
GO-11 = 无新增 P0/P1 + 剩余 NO-GO = 0
```

---

# 43. NO-GO 分类

## P0

- Future Source 泄漏；
- Future Chapter Plan 泄漏；
- 非 eligible Artifact 自动采用；
- 用户正文被无提示覆盖；
- 重复创建章节；
- 重复创建已存在 Run；
- State 未同步即开始下一章；
- Outline Batch 行为被破坏；
- Migration 丢数据；
- Resume 造成 Batch 层重复付费请求。

## P1

- Resume 丢进度；
- 章节号错误；
- Cancel 后继续下一章；
- soft warning 被错误吞掉；
- Outbox 失败仍标 Item success；
- Project drift 未暂停；
- Batch report / usage 严重错误。

## P2

- UI 文案；
- 次要 telemetry；
- 非阻断样式问题。

---

# 44. Final GO Gates

必须全部满足：

```text
G1  Outline Batch regression = GO
G2  Continuation single chapter regression = GO
G3  Continuation Batch Planner = GO
G4  Future Source Leakage = 0
G5  Future Plan Leakage = 0
G6  Continuation numbering = GO
G7  Per-chapter V5 Snapshot = GO
G8  Eligible-only Auto Adoption = GO
G9  Finalize before success = GO
G10 State Freshness before next chapter = GO
G11 Crash / Resume Idempotency = GO
G12 Cancel = GO
G13 Migration Matrix = GO
G14 Backup / Restore = GO
G15 adb install -r data retention = GO
G16 Android E2E = GO
G17 Full CI = GO
G18 Independent Final Audit = GO
```

只有：

```text
新 P0 = 0
新 P1 = 0
剩余 NO-GO = 0
```

才允许 Final Seal：

```text
GO / SEALED
```

---

# 45. Agent 执行约束

执行本文的本地 Agent 必须遵守：

1. 以仓库根目录为工作目录；
2. 不依赖固定盘符；
3. 不依赖固定用户名；
4. 不写绝对开发机路径；
5. 先执行 Round 0，再改代码；
6. 不因为“顺手优化”扩大范围；
7. Protected Files 只有在“必要接驳无法通过外围完成”时才能改；
8. 新问题自动登记 NO-GO；
9. 按 PDCA 自动继续；
10. 不删除旧兼容逻辑；
11. 不复制第二套完整 MultiChapterBatch；
12. 不把 Continuation Run 当 Pipeline Task；
13. 不重新实现 Continuation V5；
14. 所有关键行为必须有测试；
15. 测试通过不等于架构通过，必须做独立 Final Audit。

---

# 46. 推荐最终代码关系

```text
MultiChapterBatch Reconciler
      │
      ├─ writingMode=outline
      │    └─ existing outline path（尽量原样）
      │
      └─ writingMode=continuation
           └─ ContinuationBatchAdapter
                 ├─ Continuation Batch Planner
                 ├─ continuationSourceReader
                 ├─ CanonQueryService
                 ├─ startContinuationRun
                 ├─ resumeInterruptedRun
                 ├─ adoptArtifactAsDraft
                 ├─ finalizeContinuationChapter
                 └─ State / Story Memory readiness gate
```

---

# 47. 自审结论

## 47.1 大纲模块改造边界

**通过。**

方案没有要求把现有 Outline Batch 全量迁移到新 Adapter，优先保留旧 Outline Reconciler 分支，仅在公共 Batch 数据层和必要 action 接口增加 mode-aware 接驳。

## 47.2 Continuation 与普通 Pipeline 混用风险

**通过。**

方案明确：

```text
Continuation Batch → startContinuationRun()
```

而不是：

```text
runChapterPipeline()
```

且明确禁止把 `ct_*` 写进 `active_pipeline_task_id`。

## 47.3 Future Plan Leakage

**已设置 P0 Gate。**

当前章只获得当前 Item Projection，未来 Item 详细计划禁止进入单章 `userInstruction`。

## 47.4 Future Source Leakage

**已 fail closed。**

Batch Planner 与单章续写都只能使用 bounded SourceReader，不增加 Future Source 例外。

## 47.5 N 章 Context 冻结错误

**已避免。**

方案采用：

```text
Batch Plan Freeze
+
Per-Chapter Continuation V5 Freeze
```

不会在 Batch 创建时冻结 N 章全部运行上下文。

## 47.6 State 未同步就继续下一章

**已设置硬 Gate。**

Item Success 包含 Finalize + State Ready；未 ready 时下一章 LLM call 必须为 0。

## 47.7 单章续写回归风险

**已隔离。**

Batch Auto Adoption 只属于 Batch Policy，不改变单章续写默认交互。

## 47.8 开发机路径耦合

**通过。**

全文只使用仓库相对路径；未写死盘符、用户名、Android SDK、adb 或项目绝对路径。

## 47.9 是否存在不必要的大纲创作模块重构

**自审未发现。**

所有建议优先采用 additive schema、new adapter、mode branch；明确禁止以“统一架构”为由重写 Outline Pipeline、Outline Planner 或整个 Batch Reconciler。

---

# 48. 最终实施原则

> **1. 复用 Batch 外壳，不复用错误的单章内核。**

> **2. Continuation V5 继续是续写单章唯一生成权威。**

> **3. 每章只消费当前章 Plan Projection，不消费未来章节详细计划。**

> **4. 上一章必须完成 eligible → adoption → finalize → state ready，下一章才允许启动。**

> **5. 为保护已有大纲创作稳定性，优先新增 Adapter 和模式分支，不进行与本功能无关的大纲模块重构。**

最终能力应是一个：

```text
Canon 驱动
Source 安全
状态连续
严格串行
可暂停
可恢复
可审计
多章自动续写系统
```

而不是简单的“N 次循环调用 AI”。
