# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# shinewriter

基于 tavo-maker 小说家工作台的 **Android-only** React Native 应用（不支持 iOS 构建）。核心能力：多章节长篇写作、多阶段 AI 生成管线、角色卡/世界书注入、TTS 朗读、增量故事记忆（Checkpoint 架构），以及基于 Canon/原著画风的"原著续写"工作流。

当前工作树版本为 **V2.11.33**（以 `package.json` 与 `src/constants/version.json` 为准）；数据库 **Schema 42**（`src/services/migrations/index.ts` 的 `SCHEMA_VERSION`，`MIN_COMPATIBLE_SCHEMA_VERSION = 3`）。

> 本文件专注代码事实与架构。Agent 跑命令、构建、测试陷阱、Release 键盘等操作细节见 `AGENTS.md`，不要重复。

## 常用命令

```bash
npm install              # postinstall 自动跑 patch-sqlite-storage-gradle.js + patch-deps.js
npm start                # Metro
npm run android          # 运行 Android 开发版（需已连接设备/模拟器）
# 等价：npx react-native run-android

# 构建 APK（prebuild 按语义版本生成 versionCode：major*1e6+minor*1e4+patch*100，可加 SHINE_WRITER_BUILD_NUMBER 0-99 后缀；写入 src/constants/version.json）
npm run apk:debug                 # → dist/apk/debug/ShineWriter-V<版本>-debug.apk
npm run apk:release               # → dist/apk/release/ShineWriter-V<版本>-release.apk
npm run apk:release:minified      # 压缩混淆版（R8 评估用，正式发布默认不用）

# 质量门禁（提 PR 前跑这个）
npm run verify            # = lint + typecheck + verify:version + test:ci，CI 跑的是同一条链
npm run lint              # eslint .
npm run typecheck         # tsc --noEmit
npm run verify:version    # 校验 package.json / version.json / 构建产物版本号一致

# 测试（Jest，用例位于 __tests__/；约 297 个 suite / 2447 用例）
npm test                  # 全部
npm run test:ci           # --runInBand --ci（CI 用）
npm run test:coverage     # 带覆盖率（jest.config.js 的 coverageThreshold）
npx jest __tests__/chapterNavigation.test.ts          # 单文件
npx jest __tests__/migrations-v15-v16   # 按文件名前缀跑相关用例
npx jest <relative-test-path> -t "测试名称"            # 按名称筛选

# WebDAV 同步（坚果云 zspace，可选）
npm run zspace:probe      # 探测连接
npm run zspace:list       # 列远端
npm run zspace:put        # 上传
```

环境要求：Node `>=24.3.0`（`package.json` engines）、JDK 17、Android SDK。React Native 0.85.3 + React 19.2.3。

### Release APK（必读）

生成正式 APK 前必须阅读 `docs/RELEASE_APK_BUILD.md`，并按其中的标准构建步骤与构建后验收执行。四项 `SHINE_WRITER_RELEASE_*` 环境变量（本地保存在 Windows 用户环境）；若当前进程读不到，先用该指南里的 PowerShell 片段把 User 级变量加载到 Process 级，再运行 `npm run apk:release`。

- 正式 keystore：本地忽略文件 `android/keystores/tavo-mini-release.keystore`，alias `tavo-mini-release`
- 证书 SHA-256 必须为 `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`
- **不得**创建新 keystore、改用 Debug 签名、从 Git 历史传播密码或把密码写入仓库/日志
- 发版验收清单见 `docs/RELEASE_CHECKLIST.md`

### APK 产物管理

统一只从项目根目录的 `dist/apk/{debug|release}/` 取 APK。Gradle 自己的 `android/app/build/outputs/apk/` 只是中间产物，不作为对外交付路径。`scripts/build-apk.js` 负责构建并复制到 `dist/apk/`，并强校验 `src/constants/version.json` 与 `package.json` 的 version 元数据一致。**不要手改 `version.json`**（由 `npm run prebuild` / `scripts/generate-version-json.js` 生成）。

## 架构

React Native CLI + TypeScript。Zustand 状态管理（**7 个 store**），SQLite 本地持久化（**schema 42**）。底部 **5 Tab** 导航（项目/资料/写作/构建/设置），三色主题系统，多阶段 AI 管线 + 前台服务保活 + 阶段 Checkpoint 持久状态机 + 弹性上下文预算池。

入口：`index.js` → `src/main/index.tsx`（ThemeProvider + NavigationContainer）→ `src/navigation/TabNavigator.tsx`。Tab 顺序为 `1 项目 → 2 资料/续写资料 → 3 写作/续写 → 构建 → 设置`；原著续写模式下"资料"和"写作"两个 Tab 文案切换为"续写资料"/"续写"，前 3 步之间显示箭头提示。**资料 Tab 在 Stack 内是一个五段 SegmentedControl**（续写 / 大纲 / 角色 / 世界书 / 笔记 / 预设），原 ResourceHome 中转层已移除，续写页直接嵌入。

### 数据层（两层 + 强分层）

数据访问的**唯一对外入口是 `src/services/database.ts`**，它是一个 barrel —— 真正实现在 `src/data/` 分层中：

- `src/data/connection/` — 底层连接：`openDatabase.ts`（单例 + Promise 去重）、`execute.ts`、`query.ts`（`all`/`one`）、`transaction.ts`（`executeTransaction` 批量事务）
- `src/data/repositories/` — 按领域拆分的 Repository（project / character / worldbook / note / preset / llmConfig / settings / usage / content / pipelineTask / **pipelineStageCheckpoint** / **pipelineStageAttempt** / **multiChapterBatch** / noteConfig / contextAuto / storyMemory / **continuationResourceBinding** / **outline**） + `shared.ts`
- `src/data/schema/` — `createCurrentSchema.ts`（**全新安装**的建表语句）、`initializeDatabase.ts`（安装类型检测 + 破坏性迁移检测 + 已知缺陷修复 + **schemaDriftInspector** 启动期漂移检查）、`schemaManifest.ts`、`schemaValidator.ts`
- `src/services/database/` — 迁移/事务辅助与 schema 校验相关实现（`transaction.ts` 等），由 migrations 与 database 层共用
- `src/services/schemaRecoveryBackup.ts` + `src/services/recall/dataRecallService.ts` — Schema 40+ 引入：物理缺列时自动写 schema-recovery 备份，用户可从设置 → "资料召回"页恢复 `userDataRecallSnapshot`

**页面绝不直接写 SQL**，一律调 `services/database.ts` 导出的 Repository 函数。

主要表（Schema 42）：projects、chapters、fragments、plotlines、project_plotlines、characters、character_collections、worldbook_collections、worldbook_entries、note_collections、notes、project_note_config、note_style_profiles、presets、llm_config、settings、project_resources、llm_usage_logs、pipeline_tasks、**pipeline_stage_checkpoints**（Schema 39，每 task+stage 一行，CAS 持久化，支撑 fail-closed 恢复）、**pipeline_stage_attempts**（Schema 42，持久化 LLM Attempt 重试轨迹）、**multi_chapter_batches** / **multi_chapter_batch_items**（Schema 41+42，批量写章批次表）、freeform_documents、content_revisions、generation_drafts、**outlines**（Schema 36，独立项目级资源，与 `project_resources` 分离）、project_story_memory、chapter_memory_patches、story_memory_snapshots、project_story_memory_policy、story_memory_batches，以及续写域的导入、Canon、风格画像、状态和生成表（见下文）。

#### 数据库迁移（schema 3 → 42）

增量迁移引擎在 `src/services/migrations/`：`index.ts` 定义 `SCHEMA_VERSION = 42` 与 `MIN_COMPATIBLE_SCHEMA_VERSION = 3`，`MIGRATIONS` 数组串联 `v3-to-v4.ts` … `v41-to-v42.ts`。`runMigrations()` 只跑 `from >= 当前版本` 的迁移；标 `breaking: true` 的迁移会先触发备份（`backupService.ts`，存 `{ExternalDirectoryPath}/backups/`，最多保留 3 份）。v25→v26 因逻辑非纯 SQL，单独走 `migrateV25ToV26(db)`；v26→v27 是移除本地模型相关数据的破坏性迁移；v32→v33 给 Canon evidence 加 `source_origin` / `rescan_operation_id` 列 + 五个业务唯一索引（迁移中按 `review_status != superseded` 去重清理）；v39→v40 把 v32→v33 的 `canon_evidence` provenance 补列改为**幂等逻辑迁移** `ensureCanonEvidenceProvenanceSchema`，修复 recorded-39 但物理缺列的漂移库，并增加启动期漂移检查、用户资料召回快照、schema-recovery 备份。

> **新增表或字段时必须两处都改**（极易遗漏）：
> 1. 写一个新的 `vN-to-vN+1.ts` 并注册进 `MIGRATIONS`，同时把 `SCHEMA_VERSION` +1；
> 2. **同时把同样的建表/加列语句镜像进 `src/data/schema/createCurrentSchema.ts`** —— 全新安装会跳过所有迁移，只跑 `createCurrentSchema`，两边不一致就会导致"升级用户有表、新装用户没表"。

迁移测试用真实 SQLite 文件：`__tests__/fixtures/databases/schema-N.db`（schema-3 到 schema-13 已固化），`scripts/generate-migration-fixtures.py` 生成新 fixture。公共工具在 `__tests__/migrationTestUtils.ts`（被 `testPathIgnorePatterns` 排除，不是测试入口）。

### 启动流程

`src/main/index.tsx` 的 `App` 启动序列：splash（≥1.2s）→ `openDatabase()` → `initializeDatabase()`（内含 `schemaDriftInspector`）→ `loadSettings()`（必须在写作入口前同步后台开关）→ `pipelineTaskStore.loadFromDB()` 并立即把 active 流水线任务标记为 interrupted/failed → **归一化多章节批次**（running + 租约过期 → 标记 pending；DB 缺列时走 schema-recovery 备份）→ 恢复中断的续写 TXT 导入任务 → 规范化续写 generation/outbox 状态并异步排空 outbox → 暂停中断的 Canon 分析 → 安装类型检测。若 `upgrade` 且 `hasBreakingMigration(schemaVersion)` 为真则展示 `UpgradeScreen`（备份+迁移+状态机），否则进入主界面。回前台时（`AppState` → `active`）跑 `markStaleTasksAsFailed()`：updatedAt 在 10 分钟内不判死，超时才标 failed（静默自愈）。

### 状态管理（7 个 Zustand store）

| Store | 职责 |
|---|---|
| `projectStore` | 项目列表、当前项目、CRUD、`workspaceMode` |
| `settingsStore` | LLM 配置、**后台流水线开关**（驱动前台服务） |
| `themeStore` | 主题模式（亮色/暗色/护眼） |
| `pipelineTaskStore` | 多阶段生成任务状态（草稿→审查→事实核查→校对），含 `markActiveTasksAsInterrupted` / `markStaleTasksAsFailed` / `batchResolved` 语义 |
| `voiceStore` | TTS 语音与朗读状态 |
| `multiChapterBatchStore` | 多章节批量写章的状态机（feature flag：`multi_chapter_batch_enabled`，默认 OFF） |
| `databaseRecoveryStore` | Schema 40+ 启动期漂移提示 / schema-recovery 备份状态 |

### LLM 集成（OpenAI 兼容 provider + 调度器）

`src/services/llm.ts` 是对外入口，实现在 `src/services/llm/`：

- `providerRegistry.ts` — 当前仅注册 `openai_compatible`；`openAICompatibleProvider.ts` 支持流式与非流式请求，流式中断可回退非流式
- `requestScheduler.ts` — 请求队列，分 `queueClass`（`normal` / `pipeline` / `background` / `canon_analysis` / `connection`）与 `queuePriority`（`manual` / `normal` / `background`），并限制各类并发与同项目流水线冲撞
- `requestPolicy.ts` / `networkPolicy.ts` — 请求策略与网络安全（HTTPS 默认；局域网 HTTP 限 `127.0.0.1`/`10/8`/`172.16/12`/`192.168/16`，须显式 `allow_insecure_lan_http`；公网 HTTP 永远拒绝）；`llmFailureClassification` 把失败拆成可重试 / 不可重试 / 用户可重试

`llm_config` 表存在线 provider 配置（`provider_type`、`context_window`、`max_output_tokens` 等）；API Key 经 Android Keystore 按 config id 安全存储（`secureStorage.ts`），表中不落密钥。

上下文构建：`contextBuilder.ts`（滑动窗口/完整/自定义三策略）+ `contextAutoAllocator.ts`（按 token 预算自动分配资源配额）+ `noteRetriever.ts`（笔记双模式检索）+ `episodicMemoryRetriever.ts` + `macroReplace.ts`（`{{char}}`/`{{user}}`/`{{chapter}}`/`{{synopsis}}`）。**弹性上下文预算池 V2**（feature flag `elastic_budget_v2_enabled`，默认 OFF）在 `src/services/pipeline/elasticBudgetAllocator.ts` + `elasticStageCompiler.ts` 实现 80% / 95% 双阈值的跨阶段分配；窗口更大时获得更多有价值的前文，而不是机械截断。续写域有独立的 `services/continuation/generation/continuationContextBuilder.ts` 与 `continuationContextBudget.ts` / `continuationAnchor.ts` / `continuationContextTrace.ts` / `continuationSupplementContextBuilder.ts`。

### 多阶段 AI 管线（phase 1–6 收敛后）

`src/services/pipelineRunner.ts` 仍是运行时入口，但状态机判定 / CAS / 预算 / 编译 / 弹性池已拆到 `src/services/pipeline/`（`reconcile.ts` / `compileStageRequest.ts` / `budgetAllocator.ts` / `elasticBudgetAllocator.ts` / `elasticStageCompiler.ts` / `executeClaimedStage.ts` / `determineNextPipelineAction.ts` / `taskView.ts` / `projectStageCheckpoints.ts` / `types.ts` / `errors.ts` / `index.ts`）。**不要再把这些当 `pipelineRunner` 内联逻辑改**。阶段：草稿 → 审查 → 事实核查 → 校对，支持取消 / 分步回退 / 从失败阶段续写。

任务持久化在 `pipeline_tasks` 表 + `pipeline_stage_checkpoints`（Schema 39，CAS 持久化状态机，fail-closed 恢复）+ `pipeline_stage_attempts`（Schema 42，Attempt 重试轨迹）。结果页 `PipelineResultScreen`。**前台服务保活**：切后台时由原生 `PipelineForegroundModule` 起 `PipelineForegroundService` + 通知，通知点击通过 deep-link（taskId 经 `MainActivity` 写入原生模块）在启动/回前台时导航到结果页。

**多章节批量写章**（feature flag `multi_chapter_batch_enabled`，默认 OFF，仅在 outline 模式可用）：`src/services/multiChapterBatch/`（`batchAdoption.ts` / `batchTask.ts` / `determineNextBatchAction.ts` / `reconcileMultiChapterBatch.ts` / `planner.ts` / `plannerCompiler.ts` / `errors.ts` / `index.ts`） + `multiChapterBatchStore` + `multiChapterBatchRepository` + `MultiChapterBatchScreen`（独立模式选择：仅草稿 / 快速 / 完整，独立于 `pipeline_mode` 全局设置）。批次状态机：create → ready → running → waiting_retry → completed / failed / abandoned；冷启动归一化（running + 租约过期 → pending）；60s 租约 + `reconciling Set` 防双写；批次进度实时显示已开始/已完成/失败；Pause 立刻生效、超时尊重 `wait_until`、Resume 不丢租约。

### 故事记忆系统（schema 8 起，Checkpoint 架构）

`src/services/storyMemory/` 子模块群：按章节增量更新项目记忆，支持 checkpoint 快照、batch 批量回填、patch 指纹比对（`storyMemoryFingerprint`）、覆盖度计算（`storyMemoryCoverage`）、合并（`storyMemoryMerger`）、批量校验（`storyMemoryBatchValidator`）、生成前准备（`storyMemoryPrepare` / `storyMemoryCheckpointEligibility`）、人物提及解析（`characterMentionResolver`）、重建（`storyMemoryRebuild`）、状态策略（`storyMemoryPolicy`）、渲染（`storyMemoryRenderer`）、校验（`storyMemoryValidator`）。落库表：`project_story_memory`、`chapter_memory_patches`、`story_memory_snapshots`、`project_story_memory_policy`、`story_memory_batches`。`finalize` 章节时触发记忆更新；续写定稿事务（V2.10.7+）会同步排队依赖型 Story Memory 重建。

生成前默认智能更新、目标约每 3 章一次批量整理；最近正文负责短期连续性。Episodic 检索含中文 n-gram、实体/人物组合加权、混合 Top-K。相关验收与硬化报告在 `docs/V2.5.*-STORY-MEMORY-*.md` 与 `docs/optimization/`（其中带 TEST-REPORT 字样的报告已被 `.gitignore` 移出仓库）。

### 原著续写域（Canon + 画风画像 + Generation，schema 19 → 42）

独立子域，**自顶向下三层**：

- **导入与项目**：`services/continuation/continuationImportService.ts` / `continuationParser.ts` / `continuationNormalizer.ts` / `continuationSourceReader.ts` / `continuationSourceRepository.ts` / `continuationProjectService.ts` / `continuationSettingsService.ts` / `continuationSourceBrowserService.ts` / `continuationEditLog.ts` / `projectMode.ts` / `chapterNumbering/` / `sourceIntegrity/` / `continuationOrderingService.ts` / `continuationChapterRecoveryService.ts` / `continuationPickerTempLifecycle.ts`。Schema 19 引入 5 张表（`continuation_sources` / `continuation_source_text_chunks` / `continuation_source_chapters` / `continuation_settings` / `continuation_import_jobs`），其中 `continuation_import_jobs` 是首张 `backup:false` 表。
- **Canon 分析（schema 20）**：`services/continuation/canon/`：`canonAnalysisService` 编排、`canonRepository` 落库、`canonQueryService` 只读访问（**唯一合法 Canon 入口**，UI/生成代码禁止直查 Canon 表）、`canonEvidenceService` / `canonEntityResolver` / `canonInvalidationService` / `canonReviewService` / `canonJsonValidators` / `analysisScopePlanner` / `adaptiveBatchPlanner` / `deterministicExtractor` / `extractionPromptSpec` / `historicalDigestService` / `canonBudgetPolicy`（30% 切块 / 缩块阶梯 / max_tokens 与 thinking 不被压缩） / `canonFiveDimensionGate`（五维硬验收 + 缺失维度定向补扫） / `activateSnapshotAndStyleProfile`。Schema 20 新增 Canon snapshot / analysis run-batch / evidence / 五类 Canon 与时间线表；Schema 33 给 Canon evidence 加 `source_origin` / `rescan_operation_id` 列与五个业务唯一索引（迁移中按 `review_status != superseded` 去重清理）；Schema 40 把 v32→v33 的 provenance 补列改为幂等逻辑迁移。
- **原著写作风格（schema 26）**：`services/continuation/styleProfile/`：`styleAnalysisService`（最高强度 V2 仿写规格；旧版画像自动过期）、`styleProfileRenderer`（按阶段窗口动态预算，Planner/Writer/Checker/Repair 分级注入）、`styleProfileRepository` / `styleProfileHash` / `styleProfileV2Schema` / `styleStatistics` / `styleSampler` / `styleAnalysisPrompt`。画风**强制严格遵循**，无启用画像会阻断续写；单独重试风格分析成功后原子成为当前注入画像。
- **续写 Generation**：`services/continuation/generation/`：`continuationGenerationRunner`（独立 runner，legacy 路径） + `continuationV4Runner`（V4 FULL-Control：Writer 初稿 → Checker / Control 并行 → Repair 完整终稿 → Local Final Gate，最多 4 次物理请求）+ `continuationV5Runner`（V5 三稿五次串行：V1 + A1 并行 → V2 → C2 对抗式审阅 → V3 定点润色；C2 只能从客户端切的稳定锚点 `v2-p-xxx` 中选 ID，杜绝模型转述伪锚点） + `continuationV4PromptCompiler` / `continuationV4ContextViews` / `continuationContextBuilder` / `continuationContextBudget` / `continuationAnchor` / `continuationContextTrace` / `continuationSupplementContextBuilder` / `continuationChecker`（含 `writerArtifactHash` 校验 + 稳定 fingerprint 匹配）/ `continuationControl`（本地决策权威 + 实质进展门）/ `continuationLengthContract`（±30% 长度契约，V4 / legacy 共用）/ `repairCompletenessPolicy` / `continuationRepairService` / `continuationStyleService` / `continuationStateService` / `continuationStateOutboxWorker` / `generationRepository`。用户可见章节号接续原著边界（边界第 20 章 → 首篇续写"第 21 章"）；内部 `ContinuationChapterPosition` 仍从 0 起。

UI 在 `src/screens/continuation/`：项目 Tab 下的 `ContinuationHomeScreen` / `ContinuationSourceChaptersScreen` / `ContinuationSourceOrderingScreen` / `ContinuationBoundaryScreen` / `ContinuationWorkspaceScreen` / `ContinuationResultScreen` / `ContinuationStateReviewScreen` / `ContinuationGenerationConfigScreen` / `StyleProfileDetailScreen`，Canon 子目录 `canon/CanonAnalysisOverviewScreen.tsx` / `CanonCategoryListScreen.tsx` / `CanonAnalysisTasksScreen.tsx`。

### 构建模块（Build / 构建）

第五个底部 Tab，独立 AI 构建流程：基于在线 OpenAI 兼容 LLM 生成可移植角色卡 / 世界书文件，写入手机存储的 JSON；用户需到"资料"模块手动导入才能进入项目。**不**写入资料库/项目表，**不**与写作上下文共享 token 预算。详见 `SPEC.MD` 与 `src/screens/BuildScreen.tsx`、服务在 `src/services/construction/`（`budget.ts` / `quality.ts` / `targets.ts` / `textSourceParser.ts` + `constructionAiGenerator.ts` + `constructionFileService.ts` + `chapterGeneration.ts`）。

### 草稿与版本

`draftService.ts`（管线生成草稿，`generation_drafts` 表，`DraftPreviewScreen`）+ `revisionService.ts`（章节/自由文档内容快照，`content_revisions` 表，`RevisionHistoryScreen`）+ `utils/draftAdoptGuard.ts`（采用草稿前的一致性守卫）。

### 备份 / Schema 恢复 / 资料召回

- `backupService.ts` — Manifest 驱动的 v3 备份、SHA-256 校验、原子恢复；API Key **不进入备份**，恢复后需重新填写。备份写入应用专属外部目录的 `backups/`。UI 在 `BackupCenterScreen`。
- `services/schemaRecoveryBackup.ts` + `services/recall/dataRecallService.ts`（Schema 40+） — 启动期 `schemaDriftInspector` 检测到物理缺列（recorded-39 但实际缺的迁移）时，先写一份 schema-recovery 备份到外部目录，Settings → "资料召回"页（`RecallScreen`）可读 `userDataRecallSnapshot`（用户资料的 JSON 快照）并选择恢复。
- `src/store/databaseRecoveryStore.ts` — 管理恢复提示状态。

### Feature Flags

`src/services/featureFlags.ts` 集中管两个 OFF-by-default 的开关（默认保持既有行为，开启是发版决策）：

- `elastic_budget_v2_enabled` — 弹性上下文预算池 V2（80% / 95% 双阈值跨阶段分配）
- `multi_chapter_batch_enabled` — 多章节批量写章（仅 outline 模式）

写新开关时把 key 放进 `FEATURE_FLAG_KEYS`，并在 `featureFlags.ts` 头部注释里写明开启前置条件（参考 `docs/optimization/tavo-mini-multi-chapter-batch-and-elastic-budget-pool-plan.md` §5）。

### 文件导入导出

导入：JSON 角色卡（CCv1/v2/v3）+ 世界书（lorebook_v3）；PNG 角色卡经原生 `PngMetadataModule` 解析 tEXt 块；原著文本经 `ContinuationTextImportModule`（支持 URI 解析与大文件流式读取）。导出：Markdown、纯文本（UTF-8 BOM）、`.tavo-novel.json`（兼容 tavo-maker）。

### 原生模块（4 个）

TS 桥接在 `src/native/`，Android 实现在 `android/app/src/main/java/com/shinewriter/`，Codegen spec 在 `src/native/specs/`（`ShineWriterSpec`，`package.json` 的 `codegenConfig` 指定 `com.shinewriter.specs` 包名，Gradle 插件自动生成）：

- `PngMetadataModule` — PNG tEXt 块解析（角色卡）
- `PipelineForegroundModule` + `PipelineForegroundService` — 管线前台服务保活 + 通知 deep-link
- `TtsAudioModule` + `TtsForegroundService` + `TtsTextChunker` — TTS 朗读与后台保活
- `ContinuationTextImportModule` — 原著文本导入（URI 解析 + 大文件流式读取）

### Android / 构建约束

- **纯 Android**：没有 iOS 工程，不要添加 iOS 相关代码或 CocoaPods
- minSdk 24，compileSdk/targetSdk 36，NDK 27.1.12297006，Kotlin 2.1.20，ABI `arm64-v8a` + `x86_64`
- `android/build.gradle` 与 `settings.gradle` 使用阿里云 Maven 镜像，修改时不要删掉
- `postinstall`：`patch-sqlite-storage-gradle.js`（jcenter→mavenCentral）+ `patch-deps.js`（AGP 9.x 的 `compileSdk` 写法）；升级相关依赖后若 patch 失效需手动检查

### 主题配色

基准三色：`#439EA6`（主色）/ `#B0E0E3`（辅助）/ `#D7F1F4`（底色）。三个主题经 `ThemeProvider` 全局注入，所有屏幕通过 `useThemeStore` 读取，默认值集中在 `src/constants/defaults.ts`。**不硬编码颜色值。**

### 关键模式

- 所有数据操作走 `services/database.ts`（→ `src/data/repositories/`），页面不直接写 SQL
- 自动保存：章节编辑 **900ms** 防抖（`utils/debounce.ts` + `useChapterAutoSave`），含未保存变更守卫（`useUnsavedChangesGuard`）
- 主题颜色统一从 `useThemeStore` 取
- 常量默认值集中在 `src/constants/`（`defaults.ts`、`llmDefaults.ts`、`voice.ts`、`version.json` 自动生成）
- 错误信息中文显示，使用 `react-native-toast-message` 通知
- 章节编辑器已拆分：`src/screens/chapter-editor/` 下是 `ChapterEditorScreen` + 子组件（`ChapterFields`/`ChapterToolbar`/`ChapterPipelinePanel`/`ChapterTtsControls`）+ hooks（`useChapterAutoSave`/`useChapterDocument`/`useChapterPipeline`/`useChapterTts`/`useUnsavedChangesGuard`）
- Prettier：`arrowParens: 'avoid'`、`singleQuote: true`、`trailingComma: 'all'`

## 测试

- Jest + `@testing-library/react-native`；配置见 `jest.config.js`、`jest.setup.js`
- `jest.setup.js` 已 mock 原生模块（sqlite-storage、fs、document picker、keychain、toast、safe-area、lucide 等）。**新增原生依赖时优先在 `jest.setup.js` 补 mock**
- **`transformIgnorePatterns` 陷阱**：新增 RN 原生模块依赖时，还需把包名加入 `jest.config.js` 的白名单（当前白名单：`react-native`、`@react-native`、`@react-navigation`、`react-native-screens`、`react-native-safe-area-context`、`lucide-react-native`、`react-native-svg`、`react-native-keychain`、`@react-native-documents/picker`）
- 覆盖率门禁：全局 branches 55 / functions 65 / lines 65 / statements 65；`database.ts`、`database/**`、`schema/**`、`migrations/**`、`backupService.ts` 为 branches 70 / lines 80
- E2E：`e2e/maestro/`（12 个 YAML 覆盖首启、写作生命周期、资料库、备份恢复、LLM 配置、管线取消，以及续写导入/Canon 分析/生成采纳/检查修复/状态重建/画风概览）；`e2e/fault-injection/` 与 `docs/FAULT_INJECTION_MATRIX.md`（配套 `scripts/testing/hanging-http-server.js` 提供网络断连场景）
- QA 脚本：`scripts/qa/`（`adb-shell.ps1` / `dump-schema.js` / `dump-ui.ps1` / `probe-start.ps1` / `pull-db.js` / `push-resume-test-db.js` / `restore-db.js` / `restore-db-stream.js` / `run-install.ps1` / `set-resume-state.js` / `snapshot-db-state.js` / `tap-text.ps1` / `toggle-feature-flag.ps1` / `toggle-flag.js` / `ui-helper.ps1` / `verify-db.js` / `verify-resume-path.js`）—— 设备端漂移修复、批量 QA、UI 自动化用

## 安全

- API Key 通过 Android Keystore 按 LLM 配置 id 安全存储（`secureStorage.ts` + `react-native-keychain`），SQLite `llm_config` 表仅存 name、base_url、model_name、provider_type、context_window、max_output_tokens 等非密钥字段
- 局域网 HTTP 需显式 `allow_insecure_lan_http` 开关；公网 HTTP 永远拒绝
- 备份不含 API Key；无 WebView、无远程代码执行

## 改动敏感区域前先读

- `README.md` — 当前版本、Schema、平台/隐私基线（事实来源）
- `CHANGELOG.md` — 版本变更，发版前对齐
- `AGENTS.md` — 与本文件互补的 Agent 操作备忘（命令/构建/测试陷阱）
- `SPEC.MD` — 构建模块规格说明
- `docs/RELEASE_APK_BUILD.md` / `docs/RELEASE_CHECKLIST.md` — 发版步骤与验收
- `docs/FAULT_INJECTION_MATRIX.md` — 故障注入场景
- `docs/optimization/`、`docs/pipeline-perf/` — 管线与故事记忆调优记录
- `docs/release-audit/V2.11.33-release-blocker-audit.md` — 最近一次发版阻滞审计
- `docs/superpowers/specs/` — 优化路线与施工方案

## 工作目录卫生

仓库根目录有大量历史调试产物（`*.png`、`*.b64`、`shine_writer*.db`、`ui_*.xml`、`window_dump*.xml`、`logcat_*.log`、`emulator_*` 等），这些不是源码，不要误删或纳入提交。新增产物写到 `test-logs/` 等已有临时目录，不要污染根目录。

**API key / 凭据文件**：本地 LLM 穿测用的 key（`docs/LLMTesti.txt` 等）已加入 `.gitignore`，切勿 `git add -f` 强制提交。`llm_config` 表本身不存 API Key（走 Android Keystore），但任何把 key 落到仓库的工作流都属于事故。
