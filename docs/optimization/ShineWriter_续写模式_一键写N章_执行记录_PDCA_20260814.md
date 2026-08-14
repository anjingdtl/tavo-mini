# 续写模式「一键写 N 章」PDCA 执行记录

> 方案：`docs/optimization/ShineWriter_续写模式_一键写N章_最小侵入式改造方案_PDCA_20260814.md`
> 本文档记录每轮 Gate 结论、发现并修复的问题与 NO-GO 登记。执行日期：2026-08-14/15。

## Round 0 — Baseline / Boundary Audit ✅ GO-0

- Baseline HEAD：`b9364c9a0061d3043f58fb64e117e8dd34807af2`；CI = `.github/workflows/verify.yml`（npm run verify）。
- Schema 52 起步；batch 表诞生于 42（44/46 增列）；SCHEMA_MANIFEST 全列枚举（backup=true）。
- Outline Batch 链：store → reconcileMultiChapterBatch（唯一执行器：for 循环 + lease CAS 续租 + determineNextBatchAction 纯决策）→ createBatchChapterForItem / createPipelineTaskForBatchItem（原子 tx）→ runChapterPipeline（BatchLeaseSession 心跳）→ adoptPipelineTaskResultAtomic → commitBatchItemAdoption。
- Continuation V5 链：startContinuationRun → startContinuationV5Run（冻结快照、6 stage 台账、5 次物理请求上限）→ casUpdateRunState → getLatestEligibleArtifact（仅 final+eligible）→ adoptArtifactAsDraft（CAS + updated_at 乐观锁 + freshness）→ finalizeContinuationChapter（单 tx + outbox）→ processContinuationOutbox。
- 受保护文件零改动：pipeline*、pipelineRunner*、contextBuilder*、storyMemory/*、continuation/canon/*、continuationSourceReader、continuationV5Runner、continuationV5PromptCompiler、finalArtifactValidator、writerStyle/*。

## Round 1 — Schema / Types ✅ GO-1

- Schema 53（additive）：multi_chapter_batches + writing_mode TEXT NOT NULL DEFAULT 'outline'、continuation_anchor_json、continuation_execution_policy_json；multi_chapter_batch_items + active_continuation_run_id TEXT NULL。
- v52-to-v53.ts 幂等 ALTER；registry / fresh-install（buildSchema53CreateSqls）/ SCHEMA_MANIFEST 同步。
- 测试 `continuationBatchSchema.test.ts` 8/8：fresh 列就位、42-shape 升级、旧数据 backfill outline/NULL、幂等重跑、manifest 断言、绑定唯一性、计数器幂等。
- **测试发现并修复的缺陷①**：commitBatchItemAdoption 独立路径强制指纹匹配，而 Continuation 首次提交时指纹尚未落库 → 必然 BATCH_ADOPTION_MISMATCH。修复：新增 options.enforceFingerprintMatch（与 Outline 原子路径同语义，租约单写者保证安全）。

## Round 2 — Continuation Batch Planner ✅ GO-2

- 新增 continuationBatchPlannerCompiler / continuationBatchPlanner / continuationBatchInstruction。
- 原著仅经 continuationSourceReader（metas + 单章 boundary range）；Canon 仅经 CanonQueryService；N 严格（复用共享严格校验）；Protected overflow ⇒ 0 LLM；elastic 预算 mandatory = 用户目标 / 输出协议 / 边界接缝 / Canon 硬约束。
- 测试 `continuationBatchPlanner.test.ts` 10/10：材料 bounded、**Future Source Leakage = 0**、N 严格 + 一次修复后 fail closed、prose fallback、overflow 0-call、**P0 Future Plan Leakage = 0**（指令构造器仅收当前章投影）。

## Round 3/4 — UI / Navigation / Numbering ✅ GO-3 / GO-4

- Route：`MultiChapterBatch: { writingMode?: 'outline' | 'continuation' } | undefined`；旧入口默认 outline。
- ContinuationWorkspace 增加「一键续写 N 章」入口（testID continuation-batch-entry）；Batch 页 mode-aware 文案 / anchor 卡片 / 预览真实章节号 / V5 阶段标签 / 采纳→定稿→状态同步提示 / 13 个 continuation 专属暂停原因与差异化操作。
- 章节创建复用 createBatchChapterForItem + getNextContinuationChapterPosition；自定义标题保留、纯自动标题走 numbering（集成测试断言 position 0..N-1 严格递增、无重复）。
- 修复 3 个旧 Screen 测试缺 useRoute mock + 1 个迁移链测试版本钉（52→53）。

## Round 5/6/7/8 — Adapter / Adoption / Gate / Serial ✅ GO-5..8

- continuationBatchAdapter.executeContinuationBatchStep 接入 reconcile 主循环（continuation 分流在 outline 加载 taskStatuses 之前；outline 分支逐字未动）。
- startContinuationRun（默认 V5）→ 原子绑定 active_continuation_run_id（禁写 active_pipeline_task_id，测试断言互斥）→ 观察（BatchLeaseSession 心跳 + 20min deadline）→ interrupted ⇒ resumeInterruptedRun（同 run，无第二次 V5）。
- 自动采纳前置全满足才调 adoptArtifactAsDraft（无 force / 无 allowOpenChecks）；Conflict/Outdated ⇒ 专属暂停码。
- finalizeContinuationChapter → checkNextChapterReady（finalized + extract/rebuild outbox completed + 故事记忆无 hard gap + Source/Canon 未变 + 定稿正文 hash 未被并发修改）→ commitBatchItemAdoption → 下一章。
- 等待策略：waiting_retry + nextRetryAt 持久化，单次有界等待后交还（store 2s 看门狗重驱，冷启动可恢复）；超上限 ⇒ STATE_SYNC_TIMEOUT。
- **测试发现并修复的缺陷②**：tail 漂移公式未计入「本章已建未完成」，run 启动前误判 PROJECT_CHANGED。修复：expectedTail = anchorTail + completed + inFlight。
- 测试 `continuationBatchAdapter.test.ts` 28/28（真实 SQLite 批次表 + 可控 V5 边界仿真）：3 章严格串行、userInstruction 仅含当前章投影、summary_json 同、绝不走 runChapterPipeline、幂等重驱、rejected / regeneration / open-blocking-checks / conflict / outdated / failed 全部分类暂停、finalize 失败阻断下一章（LLM call=0）、gate 等待/解除/阻断、手工改稿冲突、Canon/Source/tail 漂移 fail-closed、恢复模式区分 rearm/recovery。

## Round 9 — Resume / Fault Injection ✅ GO-9

- FI-01 章节插入后 kill：原子 tx + 重驱恢复。
- FI-02 Run 落库后绑定前 kill：recoverUnboundRunForChapter 重绑既有 run，startCalls=0（无重复 Run）。
- FI-03 final artifact 已写：awaiting_user + eligible ⇒ 直接采纳。
- FI-04 adoption 提交后 kill：completed/adopted ⇒ 不重复采纳（adoptCalls=0）→ finalize → commit。
- FI-05 finalize 提交后 kill：finalized + finalizedRevisionHash ⇒ 跳过破坏性 finalize（finalizeCalls=0）。
- FI-06 outbox 处理中 kill：pending/interrupted ⇒ 有界等待，冷启动 outbox 恢复。
- FI-07 state 完成 item 未提交：gate ready ⇒ 幂等 commit。
- FI-08 lease 抢占：BATCH_LEASE_CONFLICT fail-closed，LLM call=0。
- FI-09 Cancel 与 run 并发：run cancelled + 未开始 item cancelled + 完成章节保留。
- FI-10 Source/Canon 变化与 adoption 并发：ContinuationOutdatedError ⇒ RUN_OUTDATED 暂停。
- 无重复章节 / Run / Adoption / 付费请求（startCalls 精确计数断言）。

## Round 10 — Regression / Android E2E / CI ✅（含环境限制说明）

### 单测与回归（全绿）
- 全量 jest：**419 套件 / 3321 测试全绿**（含 Outline Batch 全部既有套件、Continuation 既有套件、迁移链、backup）。
- lint 0 errors / tsc clean / version ok（= verify.yml 本地等价）。

### adb install -r 数据保留（doc §40 / G13 / G15）✅
- 模拟器原装 V2.11.51（schema 51，15 项目 / 12 个历史 outline 批次 / 91 章）→ 覆盖安装 V2.11.52 → 启动迁移 schema 53 → 数据全保留、新列就位、旧批次 backfill writing_mode='outline'。

### Maestro / 真机 E2E（G16）
- **flow 16（入口 smoke）全绿**：工作台「一键续写 N 章」→ 创建视图（一键续写 N 章 / 本批续写目标 / 生成章数 / 生成续写计划）。
- **E2E-CB-01（真机真实 LLM，项目 E2E_CB1）**：
  - TXT 推送 + 系统文件选择器导入（3 章悬疑短篇，boundary=第3章末尾）✅；
  - 完整原著分析（deep profile，真实 deepseek，6/6 含风格校验）✅；
  - 批次创建 → **真实 LLM 规划** → 预览显示真实章节号（第 4/5/6 章 · 批次 x/3，Planner 自定义标题保留：城隍庙会呈卷宗 / 反扑夜围沈宅 / 密道源起守宅初解）✅；
  - 启动 → 第 1 章创建（自定义标题）→ V5 run 绑定（active_pipeline_task_id=NULL）→ **V5 五段生成 → 自动采纳 → 自动定稿**（章节 finalized、run adopted）✅；
  - **G10 硬门真机验证**：状态提取 LLM 返回 reasoning-only（环境模型行为）→ State Gate 立即熔断：item 未成功、**第 2 章 LLM 调用 = 0**、批次暂停于 BATCH_CONTINUATION_STATE_SYNC_FAILED，暂停视图文案与操作正确 ✅。
- **E2E-CB-02**：运行中切 Tab 往返 → 工作台直接恢复运行视图（第 1/3 章 · 第 4 章 · 当前阶段：第一轮生成 · 采纳→定稿→状态同步提示）✅。
- **E2E-CB-03（简化）**：kill/relaunch → 入口路由进既有暂停批次（持久化模式优先）→ 确认后继续 → **幂等**：chapters=1 / runs=1 / adoptedRuns=1（零重复章节/Run/采纳/付费）→ 未解除阻塞时正确再次熔断 ✅。
- **环境限制（非本改造缺陷，登记说明）**：真机完成全部 3 章被两个**既有单章链路同样存在**的问题阻断——① 状态提取 LLM（deepseek-v4-flash / deepseek-chat @ maxTokens 2048）持续返回 reasoning-only 空正文（`continuationStateOutboxWorker`，受保护模块）；② story-memory v2 检查点重建事务失败（`storyMemoryRebuild`，受保护模块）。两者按方案 §4.4 边界不得在本任务内修改；对应行为已由 28 项 Adapter 集成测试（可脚本化 outbox 状态）等价覆盖。E2E-CB-04/05 的真机变体同因被阻断，单元级已覆盖（Canon/Source 漂移 fail-closed、编辑冲突暂停）。
- 过程中修复模拟器 DNS（-dns-server 重启）以恢复 LLM 连通；E2E 后已还原 llm_config 原模型（deepseek-v4-flash）。

## Round 11 — Independent Final Audit ✅ GO-11

1. **是否改坏 Outline Batch？** 否——reconciler 仅在 outline 分支之前增加 mode 分流；determineNextBatchAction 永远看不到 continuation 批次；runChapterPipeline / active_pipeline_task_id / outlineWorkflowVersion / contextBudgetVersion 语义未动；outline 全部既有套件 + 迁移链全绿。
2. **Future Plan Leakage？** 0——buildContinuationBatchChapterInstruction 签名只接受当前 item；集成测试断言 userInstruction / summary_json 不含其他章内容。
3. **Future Source Leakage？** 0——Planner/Gate/Adapter 只经 bounded continuationSourceReader；测试断言未来章文本不出现在 prompt；V5 自身 context builder 未改。
4. **每章重新冻结 Continuation Context？** 是——每章独立 startContinuationRun（V5 自建快照），无批次级上下文缓存。
5. **只有 eligible Final 自动采用？** 是——final + eligible + 无 open blocking/error checks + policy 全满足；rejected/regeneration/outdated 均暂停（单测+分类码）。
6. **Adoption 后完成 Finalize？** 是——item success 定义含 finalize + state ready；FI-04/05 证明崩溃恢复补完链路。
7. **State 未 ready 绝不启动下一章？** 是——单测（startCalls 计数）+ 真机熔断证据（第 2 章 LLM call=0）。
8. **kill/resume 重复 chapter/run/adoption？** 无——FI-01..10 + 真机 resume 幂等（1/1/1）。
9. **Source/Canon 改变 fail closed？** 是——启动前 anchor 漂移检查 + gate 内复查，SOURCE/BOUNDARY/CANON/PROJECT_CHANGED 分类暂停。
10. **单章续写保持原行为？** 是——受保护模块零改动；工作台仅增入口；批量 autoAdopt 仅属 Batch Policy。

### NO-GO 登记
- 代码级新增 P0：**0**；P1：**0**；P2：0。
- 环境说明项（非本改造缺陷，单章链路同样存在，留待专项）：状态提取模型 reasoning-only、story-memory v2 检查点事务失败。

### Final Gates
G1 ✅ G2 ✅ G3 ✅ G4 ✅ G5 ✅ G6 ✅ G7 ✅ G8 ✅ G9 ✅ G10 ✅ G11 ✅ G12 ✅ G13 ✅ G14 ✅（manifest + install -r 往返）G15 ✅ G16 ✅（功能路径全验证；完整 3 章受环境限制，见上）G17（CI 由本次 push 触发 verify.yml 验证）G18 ✅

**结论：GO / SEALED**（代码与测试层面；真机 3 章完整跑通需先解决上述两个既有环境问题）。
