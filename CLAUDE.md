# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# shinewriter

基于 tavo-maker 小说家工作台的 **Android-only** React Native 应用（不支持 iOS 构建）。核心能力：多章节长篇写作、多阶段 AI 生成管线、角色卡/世界书注入、TTS 朗读、增量故事记忆（Checkpoint 架构），以及基于 Canon/原著画风的“原著续写”工作流。

当前工作树版本为 **V2.11.8**（以 `package.json` 与 `src/constants/version.json` 为准）；数据库 **Schema 29**（以 `src/services/migrations/index.ts` 的 `SCHEMA_VERSION` 为准，`MIN_COMPATIBLE_SCHEMA_VERSION = 3`）。

> Agent 跑命令、构建、测试陷阱等操作细节见 `AGENTS.md`；本文件专注代码事实与架构，不要重复。

## 常用命令

```bash
npm install              # postinstall 自动跑 patch-sqlite-storage-gradle.js + patch-deps.js
npm start                # Metro
npm run android          # 运行 Android 开发版（需已连接设备/模拟器）
# 等价：npx react-native run-android

# 构建 APK（prebuild 按语义版本生成 versionCode：major*1e6+minor*1e4+patch*100，可加 SHINE_WRITER_BUILD_NUMBER 0-99 后缀；写入 src/constants/version.json）
npm run apk:debug                 # → dist/apk/debug/ShineWriter-V<版本>-debug.apk
npm run apk:release               # → dist/apk/release/ShineWriter-V<版本>-release.apk
npm run apk:release:minified      # 压缩混淆版正式包（R8 评估用，正式发布默认不用）

# 质量门禁（提 PR 前跑这个）
npm run verify            # = lint + typecheck + verify:version + test:ci，CI 跑的是同一条链
npm run lint              # eslint .
npm run typecheck         # tsc --noEmit
npm run verify:version    # 校验 package.json / version.json / 构建产物版本号一致

# 测试（Jest，用例位于 __tests__/）
npm test                  # 全部
npm run test:ci           # --runInBand --ci（CI 用）
npm run test:coverage     # 带覆盖率（见 jest.config.js 的 coverageThreshold）
npx jest __tests__/chapterNavigation.test.ts          # 单文件
npx jest __tests__/migrations-v15-v16   # 按文件名前缀跑相关用例
npx jest <relative-test-path> -t "测试名称"          # 按名称筛选

# WebDAV 同步（坚果云 zspace，可选）
npm run zspace:probe      # 探测连接
npm run zspace:list       # 列远端
npm run zspace:put        # 上传
```

环境要求：Node `>=24.3.0`（见 `package.json` engines）、JDK 17、Android SDK。

### Release APK（必读）

生成正式 APK 前必须阅读 `docs/RELEASE_APK_BUILD.md`，并按其中的标准构建步骤与构建后验收执行。主构建机的四项 `SHINE_WRITER_RELEASE_*` 已保存在 Windows 用户环境中；若当前进程读不到，先用该指南里的 PowerShell 片段把 User 级变量加载到 Process 级，再运行 `npm run apk:release`。

- 正式 keystore：本地忽略文件 `android/keystores/tavo-mini-release.keystore`，alias `tavo-mini-release`
- 证书 SHA-256 必须为 `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`
- **不得**创建新 keystore、改用 Debug 签名、从 Git 历史传播密码或把密码写入仓库/日志
- 发版验收清单见 `docs/RELEASE_CHECKLIST.md`

### APK 产物管理

统一只从项目根目录的 `dist/apk/{debug|release}/` 取 APK。Gradle 自己的 `android/app/build/outputs/apk/` 只是中间产物，不作为对外交付路径。`scripts/build-apk.js` 负责构建并复制到 `dist/apk/`，并强校验 `src/constants/version.json` 与 `package.json` 的 version 元数据一致。**不要手改 `version.json`**（由 `npm run prebuild` / `scripts/generate-version-json.js` 生成）。

## 架构

React Native CLI + TypeScript。Zustand 状态管理（**5 个 store**），SQLite 本地持久化（**schema version 29**）。底部 **5 Tab** 导航（项目/资料/写作/构建/设置），三色主题系统，多阶段 AI 管线 + 前台服务保活。

入口：`index.js` → `src/main/index.tsx`（ThemeProvider + NavigationContainer）→ `src/navigation/TabNavigator.tsx`。Tab 顺序为 `1 项目 → 2 资料/续写资料 → 3 写作/续写 → 构建 → 设置`；原著续写模式下"资料"和"写作"两个 Tab 文案切换为"续写资料"/"续写"，前 3 步之间显示箭头提示。

### 数据层（关键：两层结构）

数据访问的**唯一对外入口是 `src/services/database.ts`**，它是一个 barrel —— 真正实现在 `src/data/` 分层中：

- `src/data/connection/` — 底层连接：`openDatabase.ts`（单例 + Promise 去重）、`execute.ts`、`query.ts`（`all`/`one`）、`transaction.ts`（`executeTransaction` 批量事务）
- `src/data/repositories/` — 按领域拆分的 Repository（project / character / worldbook / note / preset / llmConfig / settings / usage / content / pipelineTask / noteConfig / contextAuto / storyMemory / **continuationResourceBinding**）+ `shared.ts`（`Row`/`now`/`touchProject` 等公共工具）
- `src/data/schema/` — `createCurrentSchema.ts`（**全新安装**的建表语句）、`initializeDatabase.ts`（安装类型检测 + 破坏性迁移检测 + 已知缺陷修复）、`schemaManifest.ts`、`schemaValidator.ts`
- `src/services/database/` — 迁移/事务辅助与 schema 校验相关实现（`transaction.ts` 等），由 migrations 与 database 层共用

**页面绝不直接写 SQL**，一律调 `services/database.ts` 导出的 Repository 函数。

主要表：projects、chapters、fragments、plotlines、project_plotlines、characters、character_collections、worldbook_collections、worldbook_entries、note_collections、notes、project_note_config、note_style_profiles、presets、llm_config、settings、project_resources、llm_usage_logs、pipeline_tasks、freeform_documents、content_revisions、generation_drafts、project_story_memory、chapter_memory_patches、story_memory_snapshots、project_story_memory_policy、story_memory_batches，以及续写域的导入、Canon、风格画像、状态和生成表（见下文）。

#### 数据库迁移（schema 3 → 29）

增量迁移引擎在 `src/services/migrations/`：`index.ts` 定义 `SCHEMA_VERSION = 29` 与 `MIN_COMPATIBLE_SCHEMA_VERSION = 3`，`MIGRATIONS` 数组串联 `v3-to-v4.ts` … `v28-to-v29.ts`。`runMigrations()` 只跑 `from >= 当前版本` 的迁移；标 `breaking: true` 的迁移会先触发备份（`backupService.ts`，存 `{ExternalDirectoryPath}/backups/`，最多保留 3 份）。v25→v26 因逻辑非纯 SQL，单独走 `migrateV25ToV26(db)`；v26→v27 是移除本地模型相关数据的破坏性迁移。

**新增表或字段时必须两处都改**（极易遗漏）：
1. 写一个新的 `vN-to-vN+1.ts` 并注册进 `MIGRATIONS`，同时把 `SCHEMA_VERSION` +1；
2. **同时把同样的建表/加列语句镜像进 `src/data/schema/createCurrentSchema.ts`** —— 全新安装会跳过所有迁移，只跑 `createCurrentSchema`，两边不一致就会导致"升级用户有表、新装用户没表"。

迁移测试用真实 SQLite 文件：`__tests__/fixtures/databases/schema-N.db`（schema-3 到 schema-13 已固化），`scripts/generate-migration-fixtures.py` 生成新 fixture。公共工具在 `__tests__/migrationTestUtils.ts`（被 `testPathIgnorePatterns` 排除，不是测试入口）。

### 启动流程

`src/main/index.tsx` 的 `App` 启动序列：splash（≥1.2s）→ `openDatabase()` → `loadSettings()`（必须在写作入口前同步后台开关）→ `pipelineTaskStore.loadFromDB()` 并立即把 active 流水线任务标记为 interrupted/failed → 恢复中断的续写 TXT 导入任务 → 规范化续写 generation/outbox 状态并异步排空 outbox → 暂停中断的 Canon 分析 → 安装类型检测。若 `upgrade` 且 `hasBreakingMigration(schemaVersion)` 为真则展示 `UpgradeScreen`（备份+迁移+状态机），否则进入主界面。回前台时（`AppState` → `active`）跑 `markStaleTasksAsFailed()`：updatedAt 在 10 分钟内不判死，超时才标 failed（静默自愈）。

### 状态管理（5 个 Zustand store）

- `projectStore` — 项目列表、当前项目、CRUD
- `settingsStore` — LLM 配置、**后台流水线开关**（驱动前台服务）
- `themeStore` — 主题模式（亮色/暗色/护眼）
- `pipelineTaskStore` — 多阶段生成任务状态（草稿→审查→事实核查→校对），含 `markActiveTasksAsInterrupted` / `markStaleTasksAsFailed` / `batchResolved` 语义
- `voiceStore` — TTS 语音与朗读状态

### LLM 集成（OpenAI 兼容 provider + 调度器）

`src/services/llm.ts` 是对外入口，实现在 `src/services/llm/`：

- `providerRegistry.ts` — 当前仅注册 `openai_compatible`；`openAICompatibleProvider.ts` 支持流式与非流式请求，流式中断可回退非流式
- `requestScheduler.ts` — 请求队列，分 `queueClass`（`normal` / `pipeline` / `background` / `canon_analysis` / `connection`）与 `queuePriority`（`manual` / `normal` / `background`），并限制各类并发与同项目流水线冲撞
- `requestPolicy.ts` / `networkPolicy.ts` — 请求策略与网络安全（HTTPS 默认；局域网 HTTP 限 `127.0.0.1`/`10/8`/`172.16/12`/`192.168/16`，须显式 `allow_insecure_lan_http`；公网 HTTP 永远拒绝）

`llm_config` 表存在线 provider 配置（含 `provider_type`、`context_window`、`max_output_tokens` 等）；API Key 经 Android Keystore 按 config id 安全存储（`secureStorage.ts`），表中不落密钥。

上下文构建：`contextBuilder.ts`（滑动窗口/完整/自定义三策略）+ `contextAutoAllocator.ts`（按 token 预算自动分配资源配额）+ `noteRetriever.ts`（笔记双模式检索）+ `episodicMemoryRetriever.ts` + `macroReplace.ts`（`{{char}}`/`{{user}}`/`{{chapter}}`/`{{synopsis}}`）。续写域有独立的 `services/continuation/generation/continuationContextBuilder.ts` 与 `continuationContextBudget.ts` / `continuationAnchor.ts` / `continuationContextTrace.ts` / `continuationSupplementContextBuilder.ts`。

### 多阶段 AI 管线

`pipelineRunner.ts`（草稿→审查→事实核查→校对，支持取消与分步回退）+ `pipelineMessages.ts`（各阶段 prompt）+ `batchChapterPipeline.ts`（"AI 写 N 章"逐章建任务并跑管线）。任务持久化在 `pipeline_tasks` 表，结果页 `PipelineResultScreen`。**前台服务保活**：切后台时由原生 `PipelineForegroundModule` 起前台服务 + 通知，通知点击通过 deep-link（taskId 经 `MainActivity` 写入原生模块）在启动/回前台时导航到结果页。续写有独立 runner：`continuationGenerationRunner.ts`（不复用 freeform stage 枚举），结果页 `ContinuationResultScreen`（折叠阶段卡片 + "放弃/采纳"）。

### 故事记忆系统（schema 8 起，Checkpoint 架构）

`src/services/storyMemory/` 子模块群：按章节增量更新项目记忆，支持 checkpoint 快照、batch 批量回填、patch 指纹比对（`storyMemoryFingerprint`）、覆盖度计算（`storyMemoryCoverage`）、合并（`storyMemoryMerger`）、批量校验（`storyMemoryBatchValidator`）、生成前准备（`storyMemoryPrepare` / `storyMemoryCheckpointEligibility`）、人物提及解析（`characterMentionResolver`）、重建（`storyMemoryRebuild`）、状态策略（`storyMemoryPolicy`）、渲染（`storyMemoryRenderer`）、校验（`storyMemoryValidator`）。落库表：`project_story_memory`、`chapter_memory_patches`、`story_memory_snapshots`、`project_story_memory_policy`、`story_memory_batches`。`finalize` 章节时触发记忆更新；续写定稿事务（V2.10.7+）会同步排队依赖型 Story Memory 重建。

生成前默认智能更新、目标约每 3 章一次批量整理；最近正文负责短期连续性。Episodic 检索含中文 n-gram、实体/人物组合加权、混合 Top-K。相关验收与硬化报告在 `docs/V2.5.*-STORY-MEMORY-*.md` 与 `docs/optimization/`（其中带 TEST-REPORT 字样的报告已被 `.gitignore` 移出仓库）。

### 原著续写域（Canon + 画风画像 + Generation，schema 19 → 29）

独立子域，**自顶向下三层**：

- **导入与项目**：`services/continuation/continuationImportService.ts` / `continuationParser.ts` / `continuationNormalizer.ts` / `continuationSourceReader.ts` / `continuationSourceRepository.ts` / `continuationProjectService.ts` / `continuationSettingsService.ts` / `continuationSourceBrowserService.ts` / `continuationEditLog.ts` / `projectMode.ts` / `chapterNumbering/`。Schema 19 引入 5 张表（`continuation_sources` / `continuation_source_text_chunks` / `continuation_source_chapters` / `continuation_settings` / `continuation_import_jobs`），其中 `continuation_import_jobs` 是首张 `backup:false` 表。
- **Canon 分析（schema 20）**：`services/continuation/canon/`：`canonAnalysisService` 编排、`canonRepository` 落库、`canonQueryService` 只读访问（**Phase 3 唯一合法 Canon 入口**，UI/生成代码禁止直查 Canon 表）、`canonEvidenceService` / `canonEntityResolver` / `canonInvalidationService` / `canonReviewService` / `canonJsonValidators` / `analysisScopePlanner` / `deterministicExtractor` / `extractionPromptSpec` / `historicalDigestService` / `activateSnapshotAndStyleProfile`。Schema 20 新增 Canon snapshot / analysis run-batch / evidence / 五类 Canon 与时间线表。
- **原著写作风格（schema 26）**：`services/continuation/styleProfile/`：`styleAnalysisService`（最高强度 V2 仿写规格；旧版画像自动过期）、`styleProfileRenderer`（按阶段窗口动态预算，Planner/Writer/Checker/Repair 分级注入）、`styleProfileRepository` / `styleProfileHash` / `styleProfileV2Schema` / `styleStatistics` / `styleSampler` / `styleAnalysisPrompt`。画风**强制严格遵循**，无启用画像会阻断续写；单独重试风格分析成功后原子成为当前注入画像。
- **续写 Generation**：`services/continuation/generation/`：`continuationGenerationRunner`（独立 runner）+ `continuationPromptCompiler` / `continuationContextBuilder` / `continuationContextBudget` / `continuationAnchor` / `continuationContextTrace` / `continuationSupplementContextBuilder` / `continuationChecker` / `continuationRepairService` / `continuationStyleService` / `continuationStateService` / `continuationStateOutboxWorker` / `generationRepository`。用户可见章节号接续原著边界（边界第 20 章 → 首篇续写"第 21 章"）；内部 `ContinuationChapterPosition` 仍从 0 起。

UI 在 `src/screens/continuation/`：项目 Tab 下的 `ContinuationHomeScreen` / `ContinuationSourceChaptersScreen` / `ContinuationBoundaryScreen` / `ContinuationWorkspaceScreen` / `ContinuationResultScreen` / `ContinuationStateReviewScreen` / `ContinuationGenerationConfigScreen` / `StyleProfileDetailScreen`，Canon 子目录 `canon/CanonAnalysisOverviewScreen.tsx` / `CanonCategoryListScreen.tsx` / `CanonAnalysisTasksScreen.tsx`。

### 构建模块（Build / 构建）

第五个底部 Tab，独立 AI 构建流程：基于在线 OpenAI 兼容 LLM 生成可移植角色卡 / 世界书文件，写入手机存储的 JSON；用户需到"资料"模块手动导入才能进入项目。**不**写入资料库/项目表，**不**与写作上下文共享 token 预算。详见 `SPEC.MD` 与 `src/screens/BuildScreen.tsx`、服务在 `src/services/construction/`（`budget.ts` / `quality.ts` / `targets.ts` / `textSourceParser.ts` + `constructionAiGenerator.ts` + `constructionFileService.ts` + `chapterGeneration.ts`）。

### 草稿与版本

`draftService.ts`（管线生成草稿，`generation_drafts` 表，`DraftPreviewScreen`）+ `revisionService.ts`（章节/自由文档内容快照，`content_revisions` 表，`RevisionHistoryScreen`）+ `utils/draftAdoptGuard.ts`（采用草稿前的一致性守卫）。

### 备份

`backupService.ts` — Manifest 驱动的 v3 备份、SHA-256 校验、原子恢复；API Key **不进入备份**，恢复后需重新填写。备份写入应用专属外部目录的 `backups/`。UI 在 `BackupCenterScreen`。

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
- **`transformIgnorePatterns` 陷阱**：新增 RN 原生模块依赖时，还需把包名加入 `jest.config.js` 的白名单，否则 ESM 转换失败（当前白名单：`react-native`、`@react-native`、`@react-navigation`、`react-native-screens`、`react-native-safe-area-context`、`lucide-react-native`、`react-native-svg`、`react-native-keychain`、`@react-native-documents/picker`）
- 覆盖率门禁：全局 branches 55 / functions 65 / lines 65 / statements 65；`database.ts`、`database/**`、`schema/**`、`migrations/**`、`backupService.ts` 为 branches 70 / lines 80
- E2E：`e2e/maestro/`（12 个 YAML 覆盖首启、写作生命周期、资料库、备份恢复、LLM 配置、管线取消，以及续写导入/Canon 分析/生成采纳/检查修复/状态重建/画风概览）；`e2e/fault-injection/` 与 `docs/FAULT_INJECTION_MATRIX.md`（配套 `scripts/testing/hanging-http-server.js` 提供网络断连场景）

## 安全

- API Key 通过 Android Keystore 按 LLM 配置 id 安全存储（`secureStorage.ts` + `react-native-keychain`），SQLite `llm_config` 表仅存 name、base_url、model_name、provider_type、context_window、max_output_tokens 等非密钥字段
- 局域网 HTTP 需显式 `allow_insecure_lan_http` 开关；公网 HTTP 永远拒绝
- 备份不含 API Key；无 WebView、无远程代码执行

## 改动敏感区域前先读

- `README.md` — 当前版本、Schema、平台/隐私基线（事实来源）
- `CHANGELOG.md` — 版本变更，发版前对齐
- `SPEC.MD` — 构建模块规格说明
- `docs/RELEASE_APK_BUILD.md` / `docs/RELEASE_CHECKLIST.md` — 正式 APK
- `docs/FAULT_INJECTION_MATRIX.md` — 故障注入场景
- `docs/optimization/`、`docs/pipeline-perf/` — 管线与故事记忆调优记录
- `docs/superpowers/specs/` — 优化路线与施工方案
- `AGENTS.md` — 与本文件互补的 Agent 操作备忘（命令/构建/测试陷阱）

## 工作目录卫生

仓库根目录有大量历史调试产物（`*.png`、`*.b64`、`shine_writer*.db`、`ui_*.xml`、`window_dump*.xml`、`logcat_*.log`、`emulator_*` 等），这些不是源码，不要误删或纳入提交。新增产物写到 `test-logs/` 等已有临时目录，不要污染根目录。