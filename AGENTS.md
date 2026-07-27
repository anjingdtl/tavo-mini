# shinewriter

基于 tavo-maker 小说家工作台的 **Android-only** React Native 应用。React Native CLI + TypeScript。

## 常用命令

- `npm install` — 安装依赖（自动触发 postinstall patch）
- `npm start` — 启动 Metro
- `npm run android` — 运行 Android 开发版
- `npm run apk:debug` / `apk:release` / `apk:release:minified` — 构建 APK 并复制到统一产物目录
- `npm test` — 运行全部 Jest 测试
- `npm run test:ci` — Jest CI 模式（`--runInBand --ci`）
- `npm run test:coverage` — Jest 带覆盖率（见 `jest.config.js` 的 `coverageThreshold`，全局 + database/schema/migrations/backup 分层阈值）
- `npx jest __tests__/llm.test.ts` — 运行单个测试文件
- `npm run lint` — ESLint 检查
- `npm run typecheck` — `tsc --noEmit`
- `npm run verify` — 一次性跑 `lint && typecheck && test:ci`，是 PR 前的门禁
- `npm run zspace:probe|list|put` — ZSpace WebDAV 产物上传辅助脚本

### Release APK（Agent 必读）

生成正式 APK 前必须阅读 `docs/RELEASE_APK_BUILD.md`，并按其中的“标准构建步骤”和“构建后验收”执行。主构建机的四项 `SHINE_WRITER_RELEASE_*` 已保存在 Windows 用户环境中；若当前 Agent/终端进程读取不到，先用指南里的 PowerShell 片段把 User 级变量加载到 Process 级，再运行 `npm run apk:release`。

正式 keystore 是本地忽略文件 `android/keystores/tavo-mini-release.keystore`，alias 为 `tavo-mini-release`，证书 SHA-256 必须为 `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`。不得创建新 keystore、改用 Debug 签名、从 Git 历史传播密码或把密码写入仓库/日志。

### APK 产物目录

`dist/apk/{debug|release}/ShineWriter-V<ver>-{debug|release}.apk` 是唯一交付路径。Gradle 原生 `android/app/build/outputs/apk/` 只是中间产物，不要手动复制 APK 到项目其他目录。

`scripts/build-apk.js` 会强校验 `src/constants/version.json` 与 `package.json` 的 `version`/`versionName`/`versionCode`/`releaseTitle` 必须一致，否则构建直接失败。`npm run prebuild`（`scripts/generate-version-json.js`）负责生成这份元数据，`apk:*` 命令都已内嵌 `prebuild`，**不要手改 `version.json`**。

## 架构要点

### 入口
- `index.js` → `src/main/index.tsx`（ThemeProvider + NavigationContainer）
- `src/navigation/TabNavigator.tsx` — 底部 4 Tab（项目/写作/资料/设置）+ Stack 嵌套

### 状态管理
6 个 Zustand store：
- `projectStore` — 项目列表、当前项目、CRUD
- `settingsStore` — LLM 配置
- `themeStore` — 主题模式（亮色/暗色/护眼）
- `pipelineTaskStore` — 多阶段 AI 管线任务状态
- `localModelStore` — 本地 GGUF 模型
- `voiceStore` — TTS 朗读状态/配置

### 数据层
SQLite 数据库 `shine_writer.db`，**Schema version 19**（`src/services/migrations/index.ts` 的 `SCHEMA_VERSION`，`MIN_COMPATIBLE_SCHEMA_VERSION = 3`）。当前 Schema 在 `src/data/schema/createCurrentSchema.ts` 创建，迁移在 `src/services/migrations/vN-to-vN+1.ts` 按版本递增。Schema 19 新增 5 张「原著续写」表（`continuation_sources` / `continuation_source_text_chunks` / `continuation_source_chapters` / `continuation_settings` / `continuation_import_jobs`），其中 `continuation_import_jobs` 是首张 `backup:false` 表；续写领域服务在 `src/services/continuation/`。

数据访问分层，**不要绕过**：
- `src/data/connection/` — SQLite 连接、查询、事务边界
- `src/data/schema/` — Schema 创建、初始化（`initializeDatabase.ts`）与运行时校验（`schemaValidator.ts`）
- `src/data/repositories/` — 按领域拆分的仓储
- `src/services/database.ts` + `src/services/database/` — 对上层暴露的 CRUD facade

主要表（约 22 张）：projects、chapters、fragments、plotlines、project_plotlines、characters、character_collections、worldbook_collections、worldbook_entries、notes、project_note_config、note_style_profiles、presets、llm_config、local_llm_models、settings、project_resources、llm_usage_logs、pipeline_tasks、freeform_documents、content_revisions、generation_drafts。

### 主题配色
基准三色：`#439EA6`（主色）/ `#B0E0E3`（辅助）/ `#D7F1F4`（底色）。所有屏幕通过 `useThemeStore` 读取颜色，不硬编码。

### AI 管线
- `services/llm/` — Provider 抽象（`openAICompatibleProvider.ts`、`llamaCppProvider.ts` + `llamaCppPromptAdapter.ts`）、`providerRegistry.ts`、`requestScheduler.ts`（并发/串行）、`requestPolicy.ts`、`networkPolicy.ts`（HTTPS 默认；局域网 HTTP 限 `127.0.0.1`/`10/8`/`172.16/12`/`192.168/16`，公网 HTTP 永远拒绝）、`types.ts`
- `services/llm.ts` — OpenAI 兼容 API 入口，流式 + 非流式，流式中断回退非流式
- `services/contextBuilder.ts` — 三种上下文策略（滑动窗口/完整/自定义）
- `services/macroReplace.ts` — `{{char}}`/`{{user}}`/`{{chapter}}`/`{{synopsis}}` 宏替换
- `services/pipelineRunner.ts` — 多阶段 AI 管线（草稿→审查→事实核查→校对），支持取消和分步回退
- `services/secureStorage.ts` — API Key 按 LLM 配置 id 走 Android Keystore（react-native-keychain），`llm_config` 表只存 name、base_url、model_name、is_active 等非密钥字段
- `services/localModels.ts` — 本地 GGUF 模型加载/卸载，走 Android `llama.cpp` JNI（`android/app/src/main/java/com/shinewriter/llamacpp/`）
- `services/tts.ts` + 原生 `TtsAudioModule`（前台服务 `TtsForegroundService`）— 系统 TTS 与可配置语音服务，前后台保活
- `services/backupService.ts` — Manifest 驱动的 v3 备份、SHA-256 校验、原子恢复；API Key 不进入备份

## Native 与构建

### 纯 Android
- 没有 iOS 工程，不要添加 iOS 相关代码或 CocoaPods
- Android 配置：minSdk 24，compileSdk/targetSdk 36，buildTools 36.0.0，NDK 27.1.12297006，Kotlin 2.1.20，ABI `arm64-v8a` + `x86_64`
- Node **>= 24.3.0**（`package.json` engines 要求，README 也写 `>= 24.3.0`，旧文档的 `>= 22.11.0` 已作废）
- JDK 17

### Gradle 与签名
- `android/build.gradle` 和 `settings.gradle` 使用阿里云 Maven 镜像，修改时不要删掉
- Release 签名 keystore 在 `android/keystores/tavo-mini-release.keystore`（本地忽略文件），Release 构建必须显式提供环境变量，**不会用默认密码**：`SHINE_WRITER_RELEASE_STORE_FILE` / `SHINE_WRITER_RELEASE_STORE_PASSWORD` / `SHINE_WRITER_RELEASE_KEY_ALIAS` / `SHINE_WRITER_RELEASE_KEY_PASSWORD`
- `--minify`（`-PenableReleaseMinification=true`）是 R8/资源压缩评估开关，正式发布仍需在真机验证

### postinstall 补丁
`npm install` 后 `scripts/patch-sqlite-storage-gradle.js` 和 `scripts/patch-deps.js` 都会自动跑：
- `patch-sqlite-storage-gradle.js`：把 `react-native-sqlite-storage` 的 Android `build.gradle` 中 `jcenter()` 替换为 `mavenCentral()`
- `patch-deps.js`：把若干 RN 三方库的 `compileSdkVersion safeExtGet(...)` 改写成 `compileSdk safeExtGet(...)`（AGP 9.x 移除了旧 getter）
- 升级相关依赖后若 patch 失效，手动检查并修复

### 原生模块（`src/native/` + `android/app/src/main/java/com/shinewriter/`）
- `PngMetadataModule` — 解析 PNG tEXt 块（角色卡导入）
- `LlamaCppModule` — 绑定 Android `llama.cpp` JNI（`llamacpp/`），加载/卸载 GGUF 模型
- `PipelineForegroundModule` + `PipelineForegroundService` — AI 管线前台服务保活
- `TtsAudioModule` + `TtsForegroundService` + `TtsTextChunker` — TTS 朗读与后台保活
- TS 侧 spec 在 `src/native/specs/`（Codegen：`ShineWriterSpec`）

## 测试

- Jest + `@testing-library/react-native`，配置见 `jest.config.js`、`jest.setup.js`
- `jest.setup.js` 已 mock 所有原生模块：sqlite-storage、fs、document picker、keychain、toast、safe-area-context、lucide-react-native 等
- **添加新的原生依赖时，若测试报错缺少 mock，优先在 `jest.setup.js` 中补充 mock**
- **`transformIgnorePatterns` 陷阱**：新增 RN 原生模块依赖时，还需在 `jest.config.js` 的 `transformIgnorePatterns` 正则白名单（当前白名单：`react-native`、`@react-native`、`@react-navigation`、`react-native-screens`、`react-native-safe-area-context`、`lucide-react-native`、`react-native-svg`、`react-native-keychain`、`@react-native-documents/picker`）中加入包名，否则 ESM 转换失败
- 迁移测试夹具由 `scripts/generate-migration-fixtures.py` 生成，集中在 `__tests__/migrationTestUtils.ts`（已被 `testPathIgnorePatterns` 排除，不是测试入口）
- E2E：`e2e/maestro/` 6 个核心流程 YAML（首启/写作生命周期/资料库/备份恢复/LLM 配置/管线取消），`e2e/fault-injection/` 是故障注入定义
- 覆盖率门禁见 `jest.config.js`：全局 `branches 55 / functions 65 / lines 65 / statements 65`；`database.ts`、`database/**`、`schema/**`、`migrations/**`、`backupService.ts` 有更高阈值（`branches 70 / lines 80`）

## 代码风格

- Prettier：`arrowParens: 'avoid'`、`singleQuote: true`、`trailingComma: 'all'`
- 所有数据操作通过 `services/database.ts` 或 `src/data/repositories/`，不在页面中直接写 SQL
- 自动保存：章节编辑 2 秒防抖（`utils/debounce.ts`）
- 错误信息用中文，通过 Toast 通知
- 导出格式：Markdown、纯文本（UTF-8 BOM）、`.tavo-novel.json`（兼容 tavo-maker）
- 导入格式：JSON 角色卡（CCv1/v2/v3）、世界书（lorebook_v3）、PNG 角色卡

## 改动敏感区域前先读的文档

- `README.md` — 当前版本、Schema 版本、平台/隐私基线（事实来源）
- `CHANGELOG.md` — 版本变更，发版前对齐
- `docs/RELEASE_CHECKLIST.md` — Release APK 发版前验收清单
- `docs/FAULT_INJECTION_MATRIX.md` — 故障注入场景矩阵
- `docs/superpowers/specs/Tavo-Mini-Agent-Optimization-Plan.md` — 优化路线（当前在改的就是这份）
- `docs/optimization/`、`docs/pipeline-perf/` — AI 管线性能与调优记录

## 工作目录卫生

仓库根目录有大量历史调试产物（`*.png`、`*.b64`、`shine_writer*.db`、`ui_*.xml`、`window_dump*.xml`、`logcat_*.log`、`emulator_*` 等），这些不是源码，不要误删或纳入提交；新增产物请写到 `test-logs/` 等已存在的临时目录，不要污染根目录。
