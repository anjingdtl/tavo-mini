# tavo-mini

基于 tavo-maker 小说家工作台的安卓手机应用。React Native 纯安卓实现。

## 常用命令

- `npm install` — 安装依赖
- `npx react-native run-android` — 运行 Android 开发版
- `npm run apk:debug` — 构建测试 APK 并复制到统一产物目录
- `npm run apk:release` — 构建正式 APK 并复制到统一产物目录
- `npm test` — Jest 全部测试
- `npx jest __tests__/llm.test.ts` — 运行单个测试文件
- `npm run lint` — ESLint 检查

## APK 产物管理

统一只从项目根目录的 `dist/apk/` 取 APK。Gradle 自己的 `android/app/build/outputs/apk/` 只是中间产物，不作为对外交付路径；不要再手工复制 APK 到项目其他目录。

- 测试 APK：运行 `npm run apk:debug`，产物为 `dist/apk/debug/TavoMini-V<版本号>-debug.apk`
- 正式 APK：运行 `npm run apk:release`，产物为 `dist/apk/release/TavoMini-V<版本号>-release.apk`
- 当前版本示例：`dist/apk/debug/TavoMini-V1.3.1-debug.apk`、`dist/apk/release/TavoMini-V1.3.1-release.apk`
- 直接运行 `cd android && ./gradlew assembleDebug|assembleRelease` 仍会在 Gradle 默认目录生成 APK，但这不是项目规范交付目录。

## 架构

React Native CLI + TypeScript。Zustand 状态管理（4 个 store），SQLite 本地持久化（16 张表，schema version 5）。底部 4 Tab 导航（项目/编辑/资料/设置），三色主题系统，多阶段 AI 管线。

### 文件结构

```
tavo-mini/
  android/                           -- Android 原生工程
  src/
    main/index.tsx                    -- App 入口（ThemeProvider + NavigationContainer）
    navigation/TabNavigator.tsx       -- 底部 Tab + Stack 导航
    screens/                          -- 18 个页面组件（含 3 个 pipeline 页面）
    components/                       -- ChapterCard, AIStreamText, ThemeProvider, ui
    services/                         -- database, llm, contextBuilder, macroReplace,
                                        summaryGenerator, chapterGeneration,
                                        batchChapterPipeline, fileImport,
                                        exportService, secureStorage,
                                        pipelineMessages, pipelineRunner
    store/                            -- projectStore, settingsStore, themeStore,
                                        pipelineTaskStore
    native/PngMetadataModule.ts       -- PNG tEXt 块解析桥接
    types/                            -- novel, character, worldbook, theme, pipeline
    utils/                            -- debounce, jsonExtractor, tokenEstimator
  index.js                            -- RN 入口
```

### 数据层

SQLite 数据库 `tavo_mini.db`，16 张表（schema version 5）：projects、chapters、fragments、plotlines、project_plotlines、characters、worldbook_collections、worldbook_entries、notes、presets、llm_config、settings、project_resources、llm_usage_logs、freeform_documents、pipeline_tasks。

服务层 `src/services/database.ts` 提供全部 CRUD 操作。

### 状态管理

四个 Zustand store：
- `projectStore` — 项目列表、当前项目、CRUD
- `settingsStore` — LLM 配置
- `themeStore` — 主题模式（亮色/暗色/护眼）
- `pipelineTaskStore` — 多阶段生成任务状态（草稿→审查→事实核查→校对）

### 主题配色

基准三色：`#439EA6`（主色）/ `#B0E0E3`（辅助）/ `#D7F1F4`（底色）

三个主题通过 `ThemeProvider` 全局注入，所有屏幕通过 `useThemeStore` 读取颜色。

### AI 集成

- `services/llm.ts` — OpenAI 兼容 API，流式 + 非流式调用，流式中断回退非流式
- `services/contextBuilder.ts` — 三种上下文策略（滑动窗口/完整/自定义），角色+世界书注入
- `services/macroReplace.ts` — `{{char}}`/`{{user}}`/`{{chapter}}`/`{{synopsis}}` 宏替换
- `services/summaryGenerator.ts` — LLM 生成结构化章节摘要
- `services/chapterGeneration.ts` — LLM 驱动的章节续写生成
- `services/batchChapterPipeline.ts` — “AI 写 N 章”逐章创建并执行多角色流水线任务
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
- 错误信息中文显示，使用 Toast 通知

## 安全

- API Key 通过 Android Keystore 按 LLM 配置 id 安全存储（`secureStorage.ts` + react-native-keychain），SQLite `llm_config` 表仅存 name、base_url、model_name、is_active 等非密钥字段
- 无 WebView、无远程代码执行
