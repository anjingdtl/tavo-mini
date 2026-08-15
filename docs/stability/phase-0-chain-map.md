# Stability Phase 0 Report — Baseline 与链路地图

**基线：** Local HEAD `c3cfe0d6` == origin/main（已 fetch，同步）；Worktree 干净（仅本治理方案文档未跟踪）
**日期：** 2026-08-15
**方案依据：** `docs/optimization/ShineWriter_tavo-mini_写作资料上下文弹性预算稳定性治理方案_20260815.md`

---

## 1. Generation Chain Map（链路地图）

三条主链共享 `src/services/llm.ts`：

| 链路 | 入口 | 状态机 |
|---|---|---|
| A. 单章写作流水线 | `useChapterPipeline.ts:275 executeRunPipeline` → `pipelineRunner.ts:197 runChapterPipeline` | `pipeline/reconcile.ts:1561 reconcilePipelineTask`（Draft→Review→FactCheck→Brief→Proof） |
| B. Continuation V5 续写 | `useChapterPipeline.ts:468 runContinuation` → `continuationGenerationRunner.ts:422` | `continuationV5Runner.ts:2186 startContinuationV5Run`（三轮五调用） |
| C. 一键 N 章批量 | `MultiChapterBatchScreen.tsx:289` | `multiChapterBatch/reconcileMultiChapterBatch.ts:197`（编排 A/B） |

### 链路 A 关键节点

- 冻结点：`reconcile.ts:2068 actionPersistInitialSnapshot` → `buildExecutionSnapshot`(:743) → `compileDraftStageRequest`(compileStageRequest.ts:234) → `contextBuilder.ts:405 buildContext` → `store.persistTaskPipelineContext`（pipelineContextJson + hash）
- Draft 只消费冻结请求：`compileDraftFromFrozenRequest`（compileStageRequest.ts:361）
- Audit Context：`actionBuildAuditContext`(:2555) 只在冻结候选池内重打分（"Never re-query live DB"）
- Review/FactCheck/Brief/Proof：全部 `compilePipelineStageRequest`(:2941) 从冻结快照组装
- Resume：`pipelineRunner.ts:284`（含旧协议 fail-closed 拒绝）；Cold Start：`main/index.tsx:143 init()`

### Context Builder 数据源（collect 范围）

章节(`contextBuilder.ts:413`)、Story Memory(`:426`)、大纲(`:462`→outlineContextBuilder)、Preset/Writer Style(`:1667/:567`)、世界书扫描(`:472/:1068`)、Episodic Memory(`:1046`)、人物/笔记/世界书资源（V7 `:644` / V6 `:711` / legacy `:1316`）、宏替换(`:1087`)、Context Auto(`contextAutoAllocator.ts`)。

### 预算实现（不重写数学，仅收口边界）

- 弹性 80%/95%/hard：`pipeline/elasticBudgetAllocator.ts:443`（SOFT_RATIO 0.8 :128）
- 分层看板（V6/V7）：`context/hierarchicalContextAllocator.ts:480`
- 共享纯函数核心：`allocateDemandsWithinCapacity`（elasticBudgetAllocator.ts:269）
- 每阶段弹性编译：`pipeline/elasticStageCompiler.ts:82`

## 2. Silent Fallback Inventory（静默降级清单，影响生成语义）

高优先级（P0 治理对象）：

| 位置 | 后果 |
|---|---|
| `pipeline/reconcile.ts:1999` loadRuntime | **冻结上下文解析失败 → parsed=null → 静默走 live DB 重读分支**（Freeze 契约唯一隐式通道） |
| `contextBuilder.ts:722` | V6 资源收集失败 → candidates=[] demand=0（资源整体静默丢失） |
| `contextBuilder.ts:608 / :194` | storyState/episodic 需求探测失败按 0 计 |
| `contextBuilder.ts:2085 / :2147` | 风格分析失败回退全量注入；LLM 笔记检索失败 → 空 |
| `context/resourceContextCandidates.ts:244/:286/:172/:303` | 风格候选失败回退全量；检索候选整体为空；config=null |
| `noteRetriever.ts:115` | LLM 检索失败静默降级关键词预筛 |
| `episodicMemoryRetriever.ts:441` | 故事状态词条丢失，角色/线程加权失效 |
| `postDraftRetrieval.ts:78/:99/:103/:146/:175` | 冻结候选池为空时无诊断 |
| `pipeline/reconcile.ts:6096` saveDraftBody | 草稿落库失败 best-effort 吞掉 |
| `pipeline/reconcile.ts:4543/:5257/:5482` | 审核/brief 解析失败静默为"无报告" |
| `continuationV5ContextViews.ts:181` | 冻结风格渲染失败 text='' 但 omittedReason 用旧值 |

低危（登记不阻断）：contextBuilder.ts:1054/:1743/:1954/:2168/:2604/:2766、writerStyle/editor.ts:31/:47、continuationSupplementContextBuilder.ts:82、compileStageRequest.ts:2021、draftPipelineCompiler.ts:298/:317、summaryGenerator.ts:81、reconcile.ts:588/:1433/:1476/:2180、storyMemoryService.ts:83、storyMemoryRebuild.ts:384/:519。

## 3. Legacy Branch Inventory

- 版本总枢：`pipeline/outlineWorkflowVersion.ts`（OutlineWorkflowVersion 1-4 / ContextBudgetVersion 1-7，未知折叠为 1）
- 双轨阶段实现：reconcile.ts:4009（V3/V2/legacy review 三叉）、:5220/:5450（V2/V3 终稿改写双轨）、v31/v32AuditCompatibility、stageResourceContextV4/V5、compileStageRequest.ts:162 asLegacy
- 字段猜版本：pipelineTaskContext.ts:560/:628/:663/:823、reconcile.ts:2052（snapshotVersion===5 || writerStyleSnapshot 存在性猜版本）、:2652-2692（五个版本判别函数）
- contextBuilder 三路预算分支（:414 useV7 / :1253 V6 / V6-无手动）+ 笔记三代模式（:2092）
- postDraftRetrieval.ts:264 `buildPostDraftAuditContext` legacy live-DB 路径（生产 reconcile 已不调用，仍导出）
- Continuation V4/V5 双协议并存（设计内）

## 4. DB Re-read Inventory（Draft 之后）

- **合规**：生成语义数据（章节/人物/大纲/世界书）Draft 后不重读，走冻结快照 ✓
- checkpoint 正文重读（设计内，每阶段 getStageCheckpoint）：reconcile.ts:1621/:2613/:2626、executeClaimedStage.ts:42/:78
- 配置重读：reconcile.ts:2005（**有**冻结 execution 时仍重读 live LLM 配置）、:2021-2032（**无**冻结时每阶段 loadRuntime 重读配置/预设/作家风格 —— 与清单 2 的 :1999 静默回退联动，是 Freeze 契约缺口）
- 保存路径：reconcile.ts:6088→draftService、:6108 输入指纹重算
- 用量聚合：reconcile.ts:1429/:1475

## 5. Gap 分析（对照治理方案）

| 治理要求 | 现状 | 缺口 |
|---|---|---|
| generationTraceId 贯穿 | 有 stage attempt 行 + fingerprint，无统一 trace id | **缺**（Phase 1） |
| FrozenGenerationContextV1 版本化对象 | 有 pipelineContextJson V2 信封 + hash | 缺统一 version=1 冻结对象与 generationFingerprint（Phase 2） |
| Freeze 后下游不重读 | 语义数据达标 | :1999 静默回退通道 + :2005 配置重读（Phase 3） |
| 六阶段 Builder | buildContext 单体 2600 行 | 缺阶段化边界（Phase 4，仅收口不重写） |
| 静默降级→诊断 | 约 40 处 | **缺 GenerationDiagnostic 体系**（Phase 5） |
| Replay Harness | 无 | 缺（Phase 6） |
| Golden Journey ~20 | 无专门套件 | 缺（Phase 7） |
| Legacy 边缘化 | 深嵌 reconcile/contextBuilder | Phase 8 逐步 |
| 错误码统一 | 有部分（LEGACY_PIPELINE_RESUME_BLOCKED 等） | 随 Phase 5 补充 |

## 6. Decision

**GO** — 进入 Phase 1（Trace First）。本轮明确不做：重写预算数学、重写 reconcile 状态机、升级 Schema（除非治理必需）、动模型 Provider/Prompt 文风。

