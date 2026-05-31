# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# tavo-mini

基于 tavo-maker 小说家工作台的安卓手机应用。React Native 纯安卓实现。

## 常用命令

- `npm install` — 安装依赖（postinstall 会自动 patch sqlite-storage 的 Gradle）
- `npx react-native run-android` — 运行 Android 开发版
- `npm run apk:debug` — 构建测试 APK 并复制到统一产物目录
- `npm run apk:release` — 构建正式 APK 并复制到统一产物目录
- `npm test` — Jest 全部测试
- `npx jest __tests__/llm.test.ts` — 运行单个测试文件
- `npm run lint` — ESLint 检查

## APK 产物管理

统一只从项目根目录的 `dist/apk/` 取 APK。Gradle 自己的 `android/app/build/outputs/apk/` 只是中间产物，不作为对外交付路径。

- 测试 APK：`npm run apk:debug` → `dist/apk/debug/TavoMini-V<版本号>-debug.apk`
- 正式 APK：`npm run apk:release` → `dist/apk/release/TavoMini-V<版本号>-release.apk`

构建前会自动执行 `prebuild`（`scripts/generate-version-json.js`），用 git commit count 生成 versionCode，写入 `src/constants/version.json`。

## 架构

React Native CLI + TypeScript。Zustand 状态管理（4 个 store），SQLite 本地持久化（16 张表，schema version 5）。底部 4 Tab 导航（项目/编辑/资料/设置），三色主题系统，多阶段 AI 管线。

### 文件结构

```
tavo-mini/
  android/                           -- Android 原生工程
  scripts/                           -- 构建脚本（build-apk, generate-version-json, patch-sqlite）
  src/
    main/index.tsx                    -- App 入口（splash → 升级检测 → ThemeProvider + NavigationContainer）
    navigation/TabNavigator.tsx       -- 底部 Tab + Stack 导航
    screens/                          -- 19 个页面组件（含 3 个 pipeline 页面 + UpgradeScreen）
    components/                       -- ChapterCard, AIStreamText, ThemeProvider, ui
    services/                         -- database, llm, contextBuilder, macroReplace,
                                        summaryGenerator, chapterGeneration,
                                        batchChapterPipeline, fileImport,
                                        exportService, secureStorage,
                                        pipelineMessages, pipelineRunner,
                                        backupService, migrations/
    services/migrations/              -- 增量迁移引擎（types, index, v3-to-v4, v4-to-v5）
    store/                            -- projectStore, settingsStore, themeStore,
                                        pipelineTaskStore
    constants/                        -- defaults.ts（集中常量）, version.json（自动生成）
    native/PngMetadataModule.ts       -- PNG tEXt 块解析桥接
    types/                            -- novel, character, worldbook, theme, pipeline
    utils/                            -- debounce, jsonExtractor, tokenEstimator
  index.js                            -- RN 入口
```

### 启动流程

`src/main/index.tsx` 启动序列：splash 屏（≥1.2s）→ 数据库初始化 → 安装类型检测（fresh/upgrade/same）→ 破坏性迁移检测 → 如需升级则展示 UpgradeScreen（含备份+迁移+回滚）→ 进入主界面。

### 数据层

SQLite 数据库 `tavo_mini.db`，16 张表（schema version 5）：projects、chapters、fragments、plotlines、project_plotlines、characters、worldbook_collections、worldbook_entries、notes、presets、llm_config、settings、project_resources、llm_usage_logs、freeform_documents、pipeline_tasks。

服务层 `src/services/database.ts` 提供全部 CRUD 操作。

#### 数据库迁移

增量迁移引擎在 `src/services/migrations/`：
- `index.ts` — 编排迁移链，定义 `SCHEMA_VERSION` 和 `MIN_COMPATIBLE_SCHEMA_VERSION`
- `v3-to-v4.ts` / `v4-to-v5.ts` — 各版本具体迁移逻辑
- 迁移前自动备份（`backupService.ts`），失败可回滚
- 备份存储在 `{ExternalDirectoryPath}/backups/`，最多保留 3 份

### 状态管理

四个 Zustand store：
- `projectStore` — 项目列表、当前项目、CRUD
- `settingsStore` — LLM 配置
- `themeStore` — 主题模式（亮色/暗色/护眼）
- `pipelineTaskStore` — 多阶段生成任务状态（草稿→审查→事实核查→校对）

### 主题配色

基准三色：`#439EA6`（主色）/ `#B0E0E3`（辅助）/ `#D7F1F4`（底色）

三个主题通过 `ThemeProvider` 全局注入，所有屏幕通过 `useThemeStore` 读取颜色。默认值集中在 `src/constants/defaults.ts`。

### AI 集成

- `services/llm.ts` — OpenAI 兼容 API，流式 + 非流式调用，流式中断回退非流式
- `services/contextBuilder.ts` — 三种上下文策略（滑动窗口/完整/自定义），角色+世界书注入
- `services/macroReplace.ts` — `{{char}}`/`{{user}}`/`{{chapter}}`/`{{synopsis}}` 宏替换
- `services/summaryGenerator.ts` — LLM 生成结构化章节摘要
- `services/chapterGeneration.ts` — LLM 驱动的章节续写生成
- `services/batchChapterPipeline.ts` — "AI 写 N 章"逐章创建并执行多角色流水线任务
- `services/pipelineRunner.ts` — 多阶段 AI 管线（草稿→审查→事实核查→校对），支持取消和分步回退
- `services/pipelineMessages.ts` — 管线各阶段的 prompt 构建
- `services/secureStorage.ts` — Android Keystore 安全存储（react-native-keychain）

### 文件导入导出

- 导入：JSON 角色卡（CCv1/v2/v3） + 世界书（lorebook_v3）；PNG 角色卡通过原生模块解析 tEXt 块
- 导出：Markdown、纯文本（UTF-8 BOM）、`.tavo-novel.json`（兼容 tavo-maker）

### 关键模式

- 所有数据操作通过 `services/database.ts` 的导出函数，不在页面中直接操作 SQL
- 自动保存：章节编辑 2 秒防抖（`utils/debounce.ts`）
- 主题颜色统一从 `useThemeStore` 获取，不硬编码颜色值
- 常量默认值集中在 `src/constants/defaults.ts`，不在各处散落
- 错误信息中文显示，使用 Toast 通知
- 新增数据库表或字段时，必须同步写迁移脚本到 `services/migrations/`，更新 `SCHEMA_VERSION`

## 安全

- API Key 通过 Android Keystore 按 LLM 配置 id 安全存储（`secureStorage.ts` + react-native-keychain），SQLite `llm_config` 表仅存 name、base_url、model_name、is_active 等非密钥字段
- 无 WebView、无远程代码执行
