# Tavo Mini

> **当前版本：V1.6.3**（versionCode 52）· 最后更新 2026-06-14

基于 React Native 的安卓个人小说写作工作台。为长篇小说作者设计，提供数据安全、AI 可控和高效写作流程——全部离线、全部本地。

## 最新更新（V1.6.3）

- **可关闭的流水线结果提示框**。"流水线已完成 / 流水线失败" 改用受控的 React Modal（`src/components/PipelineResultPrompt.tsx`），不再用原生 `Alert.alert`。点"查看结果"会**与导航同步**关闭提示框，不再像之前那样残留在结果页上像"反复弹出"。
- **严格的一次性提示**。`src/main/index.tsx` 的根订阅现在会跳过 `resolvedAt` 非空的任务——这是批量生成的关键守卫（`batchChapterPipeline` 在 `completeTask` 后立即 `resolveTask`）。"AI 写 N 章" 完成后**不再**为每章各弹一次全局提示，章节总览的"批量生成完成"汇总提示保持权威。
- **110/110 测试通过**，25 个测试套件（`npm test`）；`npm run lint` 0 错。

## 功能特性

### 写作与编辑
- 多项目管理，支持章节式和自由文档编辑
- 可 flush 的异步防抖自动保存——最后一次输入永不丢失
- 正文版本历史，一键恢复，可逆快照链
- 专注模式，无干扰写作
- 章节排序，上移/下移控制

### AI 驱动生成
- 多阶段 AI 管线：草稿 → 审查 → 事实核查 → 校对
- 实时进度 UI（`PipelineProgress`），展示当前阶段、阶段名和已用时长
- 生成草稿——AI 输出先进预览，绝不直接覆盖正文
- 管线断点续跑——中断任务从最后成功阶段继续
- 全局完成提示：无论用户身处哪一屏，流水线跑完都会弹出结果提示；**明确**防止重复弹出和批量回放
- 兼容 OpenAI API，支持流式输出和自动回退

### 数据安全
- 备份中心，格式 v2 校验、校验和、事务恢复
- 分类保留策略：3 份自动 / 10 份手动 / 3 份恢复前备份
- 项目包导入导出（v2 格式，兼容 v1 读取）
- 所有关键操作（清空、AI 替换、恢复）均创建可恢复快照

### 资料与组织
- 角色卡导入（CCv1/v2/v3）、世界书（lorebook_v3）、PNG 角色卡
- 故事概览：章节数、字数、每章统计
- 项目内搜索：章节、笔记、世界书、角色
- LLM 用量统计：按时间范围、模型和场景聚合

### 安全
- API Key 通过 Android Keystore 安全存储（react-native-keychain）
- 数据库绝不存储明文凭据

## 技术栈

| 层级 | 技术 |
|---|---|
| 框架 | React Native 0.85（仅 Android） |
| 语言 | TypeScript 5.8 |
| 状态管理 | Zustand 5（4 个 store） |
| 数据库 | SQLite（react-native-sqlite-storage），16 张表，schema v8 |
| 导航 | React Navigation 7（底部 Tab + Native Stack） |
| AI | 兼容 OpenAI API（流式 + 非流式） |
| 安全 | Android Keystore（react-native-keychain） |
| 测试 | Jest + React Native Testing Library（110 个测试，25 个套件） |

## 环境要求

- **Node.js** >= 22.11.0
- **Android SDK**：minSdk 24，compileSdk/targetSdk 36
- **Kotlin** 2.1.20
- **Java** 17+

## 快速开始

### 安装依赖

```sh
npm install
```

postinstall 脚本会自动 patch `react-native-sqlite-storage` 的 Gradle 配置（将 `jcenter()` 替换为 `mavenCentral()`）。

### 启动 Metro

```sh
npm start
```

### 运行 Android

```sh
npm run android
```

### 构建 APK

```sh
# 测试 APK
npm run apk:debug

# 正式 APK
npm run apk:release
```

APK 产物路径：`dist/apk/{debug|release}/TavoMini-V<版本号>-{debug|release}.apk`

> Gradle 原生输出 `android/app/build/outputs/apk/` 只是中间产物，请只使用 `dist/apk/` 下的 APK。

`prebuild` 步骤还会从 `package.json` 和当前 `git rev-list --count HEAD` 自动生成 `src/constants/version.json`（commit 数作为 `versionCode`）。

### Release 签名

Release 签名 keystore 位于 `android/keystores/tavo-mini-release.keystore`。可通过环境变量覆盖密码：

```
TAVO_MINI_RELEASE_STORE_PASSWORD
TAVO_MINI_RELEASE_KEY_ALIAS
TAVO_MINI_RELEASE_KEY_PASSWORD
```

## 测试与检查

```sh
# 运行全部测试（110 个测试 / 25 个套件）
npm test

# 运行单个测试文件
npx jest __tests__/llm.test.ts

# ESLint 检查
npm run lint
```

## 项目结构

```
tavo-mini/
  android/                           # Android 原生工程
  scripts/                           # 构建脚本（build-apk, generate-version-json, patch-sqlite）
  src/
    main/index.tsx                    # 应用入口（splash → 升级检测 → ThemeProvider + 导航，
                                      #   根流水线任务订阅，可关闭的结果提示框）
    navigation/
      TabNavigator.tsx                # 底部 Tab + Stack 导航
      navigationRef.ts                # 根导航 ref + 全局流水线提示调用
                                      #   （navigateToPipelineResult 等）
    screens/                          # 24 个页面组件
    components/                       # ChapterCard, AIStreamText, ThemeProvider, ui,
                                      #   PipelineProgress, GenerationResultModal,
                                      #   PipelineResultPrompt
    services/                         # database, llm, contextBuilder, macroReplace,
                                       summaryGenerator, chapterGeneration,
                                       batchChapterPipeline, fileImport,
                                       exportService, secureStorage,
                                       pipelineMessages, pipelineRunner,
                                       backupService, revisionService,
                                       draftService, projectImport,
                                       migrations/
    services/migrations/              # 增量迁移引擎（v3→v4→v5→v6→v7→v8）
    store/                            # projectStore, settingsStore, themeStore,
                                       pipelineTaskStore
    constants/                        # defaults.ts, version.json（自动生成）
    native/PngMetadataModule.ts       # PNG tEXt 块解析桥接
    types/                            # novel, character, worldbook, theme, pipeline,
                                       revision, draft, contextTrace
    utils/                            # debounce, jsonExtractor, tokenEstimator
  index.js                            # RN 入口
```

## 数据库结构

SQLite 数据库 `tavo_mini.db`，schema version 8，16 张表：

| 表名 | 用途 |
|---|---|
| `projects` | 小说项目 |
| `chapters` | 章节内容和元数据 |
| `fragments` | 章节文本片段 |
| `plotlines` | 情节线定义 |
| `project_plotlines` | 情节线 ↔ 项目关联 |
| `characters` | 角色卡 |
| `worldbook_collections` | 世界书分组 |
| `worldbook_entries` | 世界书条目 |
| `notes` | 项目笔记 |
| `presets` | AI 预设 |
| `llm_config` | LLM 配置（不含 API Key） |
| `settings` | 应用设置 |
| `project_resources` | 项目资源链接 |
| `llm_usage_logs` | LLM 调用日志（含模型和耗时） |
| `freeform_documents` | 自由写作文档 |
| `pipeline_tasks` | 多阶段 AI 管线任务 |
| `content_revisions` | 正文版本历史（v6+） |
| `generation_drafts` | AI 生成草稿（v7+） |

## 主题配色

基准三色：`#439EA6`（主色）/ `#B0E0E3`（辅助）/ `#D7F1F4`（底色）

三种主题通过 `useThemeStore` 切换：亮色 / 暗色 / 护眼。不硬编码颜色。

## 导入导出

| 方向 | 格式 |
|---|---|
| 导入 | JSON 角色卡（CCv1/v2/v3）、世界书（lorebook_v3）、PNG 角色卡 |
| 导出 | Markdown、纯文本（UTF-8 BOM）、`.tavo-novel.json`（兼容 tavo-maker） |

## 数据安全说明

- 编辑器自动保存使用可 flush 防抖 + AppState 监控——切后台或返回前内容必定保存
- 所有破坏性操作（清空、AI 替换、恢复）均创建版本快照
- 备份使用格式 v2，带校验和验证；恢复在事务中执行
- 数据库迁移为非破坏性增量升级
- 恢复操作前自动创建安全备份
- AI 生成绝不直接覆盖正文：结果先进 `generation_drafts`，必须由用户显式采纳

## 更新日志

### V1.6.3 — 2026-06-14
- 可关闭的流水线结果提示框（受控 React Modal）替换原生 `Alert.alert`，导航后不再残留在结果页上
- 根订阅加 `resolvedAt === null` 守卫，确保每个任务最多弹一次，批量子任务不会触发全局提示
- 测试覆盖：`__tests__/pipelineResultPrompt.test.tsx`、在 `__tests__/pipelineAutoPrompt.test.tsx` 增加批量自动 resolve 用例
- 110/110 测试通过，ESLint 0 错

### V1.6.2 — 2026-06-14
- 新增 `PipelineProgress` 组件，展示当前阶段、阶段名和已用时长
- 新增 `GenerationResultModal`，用户无需离开编辑器即可预览流水线输出
- 修复 `BackupCenterScreen` create-row 布局（z 序 + elevation 解决与 FlatList 的视觉重叠）

### V1.6.1 — 2026-06-14
- 修复 `DraftPreviewScreen` 采纳/删除/清空时的稳定性问题（Alert 套嵌 + 已卸载组件 setState 导致崩溃）
- 章节编辑器工具栏从一字排开重排为 4×4 网格，按钮 label 缩短
- 新增 11 个测试，93/93 通过

## 许可

私有项目，保留所有权利。
