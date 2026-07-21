# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# shinewriter

基于 tavo-maker 小说家工作台的安卓手机应用。React Native 纯安卓实现（不支持 iOS 构建）。核心能力：多章节长篇写作、多阶段 AI 生成管线、角色卡/世界书注入、可选的本地 llama.cpp 离线推理、TTS 朗读、增量故事记忆。

## 常用命令

```bash
npm install              # postinstall 会自动 patch sqlite-storage 的 Gradle + patch-deps.js
npx react-native run-android   # 运行 Android 开发版（需已连接设备/模拟器）

# 构建 APK（prebuild 自动用 git commit count 生成 versionCode 写入 src/constants/version.json）
npm run apk:debug                 # → dist/apk/debug/ShineWriter-V<版本>-debug.apk
npm run apk:release               # → dist/apk/release/ShineWriter-V<版本>-release.apk
npm run apk:release:minified      # 压缩混淆版正式包

# 质量门禁（提 PR 前跑这个）
npm run verify            # = lint + typecheck + verify:version + test:ci，CI 跑的是同一条链
npm run lint              # eslint .
npm run typecheck         # tsc --noEmit
npm run verify:version    # 校验 package.json / version.json / 构建产物版本号一致

# 测试（Jest，133+ 个用例，位于 __tests__/）
npm test                  # 全部
npm run test:ci           # --runInBand --ci（CI 用）
npm run test:coverage     # 带覆盖率
npx jest __tests__/llm.test.ts          # 单文件
npx jest __tests__/migrations-v15-v16   # 按文件名前缀跑相关用例

# WebDAV 同步（坚果云 zspace，可选）
npm run zspace:probe      # 探测连接
npm run zspace:list       # 列远端
npm run zspace:put        # 上传
```

环境要求：Node `>=24.3.0`（见 `package.json` engines）。

## APK 产物管理

统一只从项目根目录的 `dist/apk/` 取 APK。Gradle 自己的 `android/app/build/outputs/apk/` 只是中间产物，不作为对外交付路径。`scripts/build-apk.js` 负责构建并复制到 `dist/apk/`。

## 架构

React Native CLI + TypeScript。Zustand 状态管理（6 个 store），SQLite 本地持久化（**schema version 16**，27 张表）。底部 Tab 导航，三色主题系统，多阶段 AI 管线 + 前台服务保活。

### 数据层（关键：两层结构）

数据访问的**唯一对外入口是 `src/services/database.ts`**，但它只是一个 barrel —— 真正实现在 `src/data/` 分层中：

- `src/data/connection/` — 底层连接：`openDatabase.ts`（单例 + Promise 去重）、`execute.ts`、`query.ts`（`all`/`one`）、`transaction.ts`（`executeTransaction` 批量事务）
- `src/data/repositories/` — 按领域拆分的 Repository（project / character / worldbook / note / preset / llmConfig / localModel / settings / usage / content / pipelineTask / noteConfig / contextAuto / storyMemory）+ `shared.ts`（`Row`/`now`/`touchProject` 等公共工具）
- `src/data/schema/` — `createCurrentSchema.ts`（**全新安装**的建表语句）、`initializeDatabase.ts`（安装类型检测 + 破坏性迁移检测 + 已知缺陷修复）、`schemaManifest.ts`、`schemaValidator.ts`
- `src/data/migrations/` — 仅 re-export `src/services/migrations/`（迁移逻辑的真身在后者）

**页面绝不直接写 SQL**，一律调 `services/database.ts` 导出的 Repository 函数。

#### 数据库迁移（schema 3 → 16）

增量迁移引擎在 `src/services/migrations/`：`index.ts` 定义 `SCHEMA_VERSION = 16` 与 `MIN_COMPATIBLE_SCHEMA_VERSION = 3`，`MIGRATIONS` 数组串联 `v3-to-v4.ts` … `v15-to-v16.ts`。`runMigrations()` 只跑 `from >= 当前版本` 的迁移；标 `breaking: true` 的迁移会先触发备份（`backupService.ts`，存 `{ExternalDirectoryPath}/backups/`，最多保留 3 份）。

**新增表或字段时必须两处都改**（极易遗漏、非显而易见）：
1. 写一个新的 `vN-to-vN+1.ts` 并注册进 `MIGRATIONS`，同时把 `SCHEMA_VERSION` +1；
2. **同时把同样的建表/加列语句镜像进 `src/data/schema/createCurrentSchema.ts`** —— 全新安装会跳过所有迁移，只跑 `createCurrentSchema`，两边不一致就会导致"升级用户有表、新装用户没表"。

迁移测试用真实 SQLite 文件：`__tests__/fixtures/databases/schema-N.db`（schema-3 到 schema-13 已固化），`scripts/generate-migration-fixtures.py` 生成新 fixture。

### 启动流程

`src/main/index.tsx` 的 `App` 启动序列：splash（≥1.2s）→ `openDatabase()` → `loadSettings()`（必须在写作入口前同步后台开关，否则前台服务桥接保持 false）→ `pipelineTaskStore.loadFromDB()` 并**立即把所有 active 任务标记为 failed**（冷启动时任何 active 都是上次中断的残留，不等 10 分钟 stale 窗口）→ 安装类型检测 → 若 `upgrade` 且 `hasBreakingMigration(schemaVersion)` 为真则展示 `UpgradeScreen`（备份+迁移+状态机）→ 进入主界面。回前台时（`AppState` → `active`）跑 `markStaleTasksAsFailed()`：updatedAt 在 10 分钟内不判死，超时才标 failed（静默自愈）。

### 状态管理（6 个 Zustand store）

- `projectStore` — 项目列表、当前项目、CRUD
- `settingsStore` — LLM 配置、**后台流水线开关**（驱动前台服务）
- `themeStore` — 主题模式（亮色/暗色/护眼）
- `pipelineTaskStore` — 多阶段生成任务状态（草稿→审查→事实核查→校对），含 `markActiveTasksAsInterrupted` / `markStaleTasksAsFailed` / `batchResolved` 语义
- `localModelStore` — 本地 GGUF 模型导入/校验/状态
- `voiceStore` — TTS 语音与朗读状态

### LLM 集成（双 provider + 调度器）

`src/services/llm.ts` 是对外入口，实现在 `src/services/llm/`：

- `providerRegistry.ts` — 按 `provider_type` 分发：`openai_compatible`（OpenAI 兼容 API，流式 + 非流式，流式中断回退非流式）或 `llama_cpp`（**本地离线**推理，经原生 `LlamaCppModule`）
- `openAICompatibleProvider.ts` / `llamaCppProvider.ts` + `promptAdapter.ts` / `llamaCppPromptAdapter.ts`
- `requestScheduler.ts` — 请求队列，分 `queueClass`（`normal` / `pipeline` / `background` / `connection` / `local`）与 `queuePriority`（`manual` / `normal` / `background`），避免并发冲撞与限流
- `requestPolicy.ts` / `networkPolicy.ts` — 请求策略与网络安全（如 `allow_insecure_lan_http` 控制局域网 HTTP）

`llm_config` 表存 provider 配置（含 `provider_type`、`local_model_id`、`context_window` 等）；API Key 经 Android Keystore 按 config id 安全存储，表中不落密钥。

上下文构建：`contextBuilder.ts`（滑动窗口/完整/自定义三策略）+ `contextAutoAllocator.ts`（按 token 预算自动分配资源配额）+ `noteRetriever.ts`（笔记双模式检索）+ `episodicMemoryRetriever.ts` + `macroReplacement.ts`（`{{char}}`/`{{user}}`/`{{chapter}}`/`{{synopsis}}`）。

### 多阶段 AI 管线

`pipelineRunner.ts`（草稿→审查→事实核查→校对，支持取消与分步回退）+ `pipelineMessages.ts`（各阶段 prompt）+ `batchChapterPipeline.ts`（"AI 写 N 章"逐章建任务并跑管线）。任务持久化在 `pipeline_tasks` 表，结果页 `PipelineResultScreen`。**前台服务保活**：切后台时由原生 `PipelineForegroundModule` 起前台服务 + 通知，通知点击通过 deep-link（taskId 经 `MainActivity` 写入原生模块）在启动/回前台时导航到结果页。

### 故事记忆系统（schema 8 起，较复杂）

`src/services/storyMemory/` 一个子模块群：按章节增量更新项目记忆，支持 checkpoint 快照、batch 批量回填、patch 指纹比对（`storyMemoryFingerprint`）、覆盖度计算（`storyMemoryCoverage`）、合并（`storyMemoryMerger`）、批量校验（`storyMemoryBatchValidator`）。落库表：`project_story_memory`、`chapter_memory_patches`、`story_memory_snapshots`、`project_story_memory_policy`、`story_memory_batches`。finalize 章节时触发记忆更新。

### 草稿与版本

`draftService.ts`（管线生成草稿，`generation_drafts` 表，`DraftPreviewScreen`）+ `revisionService.ts`（章节/自由文档内容快照，`content_revisions` 表，`RevisionHistoryScreen`）+ `utils/draftAdoptGuard.ts`（采用草稿前的一致性守卫）。

### 文件导入导出

导入：JSON 角色卡（CCv1/v2/v3）+ 世界书（lorebook_v3）；PNG 角色卡经原生 `PngMetadataModule` 解析 tEXt 块；GGUF 本地模型导入（`localModels.ts` + `localModelStore`）。导出：Markdown、纯文本（UTF-8 BOM）、`.tavo-novel.json`（兼容 tavo-maker）。

### 原生模块（4 个，均在 `src/native/`）

- `PngMetadataModule` — PNG tEXt 块解析（角色卡）
- `LlamaCppModule` — 本地 llama.cpp 推理（GGUF 模型，spec 在 `specs/NativeLlamaCpp.ts`）
- `PipelineForegroundModule` — 前台服务桥接（管线保活 + 通知 deep-link）
- `TtsAudioModule` — TTS 朗读

### 主题配色

基准三色：`#439EA6`（主色）/ `#B0E0E3`（辅助）/ `#D7F1F4`（底色）。三个主题经 `ThemeProvider` 全局注入，所有屏幕通过 `useThemeStore` 读取，默认值集中在 `src/constants/defaults.ts`。**不硬编码颜色值。**

### 关键模式

- 所有数据操作走 `services/database.ts`（→ `src/data/repositories/`），页面不直接写 SQL
- 自动保存：章节编辑 2 秒防抖（`utils/debounce.ts`），含未保存变更守卫（`useUnsavedChangesGuard`）
- 主题颜色统一从 `useThemeStore` 取
- 常量默认值集中在 `src/constants/`（`defaults.ts`、`llmDefaults.ts`、`voice.ts`、`version.json` 自动生成）
- 错误信息中文显示，使用 `react-native-toast-message` 通知
- 章节编辑器已拆分：`src/screens/chapter-editor/` 下是 `ChapterEditorScreen` + 子组件（`ChapterFields`/`ChapterToolbar`/`ChapterPipelinePanel`/`ChapterTtsControls`）+ hooks（`useChapterAutoSave`/`useChapterDocument`/`useChapterPipeline`/`useChapterTts`/`useUnsavedChangesGuard`）

## 安全

- API Key 通过 Android Keystore 按 LLM 配置 id 安全存储（`secureStorage.ts` + `react-native-keychain`），SQLite `llm_config` 表仅存 name、base_url、model_name、provider_type、context_window 等非密钥字段
- 本地模型默认走 GPU/CPU 推理，不联网；局域网 HTTP 需显式 `allow_insecure_lan_http` 开关
- 无 WebView、无远程代码执行
