# ShineWriter Code Wiki

> 版本：V2.5.0 ｜ Schema v15 ｜ 平台：Android-only
> 本文档由代码静态分析自动整理，最后更新：2026-07-18

---

## 目录

- [1. 项目概览](#1-项目概览)
- [2. 技术栈与依赖](#2-技术栈与依赖)
- [3. 项目结构](#3-项目结构)
- [4. 整体架构](#4-整体架构)
- [5. 启动流程](#5-启动流程)
- [6. 导航体系](#6-导航体系)
- [7. 主题与 UI 基础](#7-主题与-ui-基础)
- [8. 状态管理（Zustand Stores）](#8-状态管理zustand-stores)
- [9. 数据层](#9-数据层)
- [10. 业务服务层](#10-业务服务层)
- [11. LLM 子系统](#11-llm-子系统)
- [12. AI 多阶段管线](#12-ai-多阶段管线)
- [13. 屏幕组件](#13-屏幕组件)
- [14. 业务组件库](#14-业务组件库)
- [15. 原生模块与 Android 工程](#15-原生模块与-android-工程)
- [16. 数据库 Schema（22 张表）](#16-数据库-schema22-张表)
- [17. 安全机制](#17-安全机制)
- [18. 构建与发布](#18-构建与发布)
- [19. 测试体系](#19-测试体系)
- [20. 关键设计模式与陷阱](#20-关键设计模式与陷阱)

---

## 1. 项目概览

**ShineWriter（小说家工作台）** 是基于 tavo-maker 衍生的纯 Android React Native 应用，面向小说作者，核心能力：

- 大纲/自由双写作模式
- 多阶段 AI 管线（草稿 → 审阅 → 事实核查 → 校对）
- 多套 LLM 配置切换（OpenAI 兼容云端 API + 本地 GGUF）
- 角色卡 / 世界书 / 笔记 / 预设四类资料库
- 系统 TTS + 云端 TTS 双引擎朗读
- Manifest 驱动的 v3 备份/恢复
- 人物 / 关系 / 故事主线三层结构化记忆，章节增量补丁与快照重建
- Android 前台服务保活（管线/TTS/本地模型导入）

**关键常量**：

| 项 | 值 |
|---|---|
| 应用名 | ShineWriter |
| 当前版本 | V2.5.0 |
| Schema 版本 | 15（`MIN_COMPATIBLE_SCHEMA_VERSION = 3`） |
| 基准三色 | `#439EA6`（主）/ `#B0E0E3`（辅）/ `#D7F1F4`（底） |
| Node 要求 | `>= 24.3.0` |
| JDK | 17 |

---

## 2. 技术栈与依赖

### 2.1 核心依赖

| 类别 | 依赖 | 用途 |
|---|---|---|
| 框架 | `react@19.2.3` / `react-native@0.85.3` | RN 0.85 Bridgeless 架构 |
| 导航 | `@react-navigation/native`、`bottom-tabs`、`native-stack` | 4 Tab + 嵌套 Stack |
| 状态 | `zustand@5.0.13` | 6 个 store，无 persist 中间件 |
| 存储 | `react-native-sqlite-storage@6.0.1` | SQLite 本地数据库（25 张表） |
| 文件 | `react-native-fs@2.20.0` | 文件读写、备份落盘 |
| 安全 | `react-native-keychain@10.0.0` | Android Keystore（API Key） |
| 选择器 | `@react-native-documents/picker@12.0.1` | 文件/文件夹 SAF |
| 压缩 | `pako@2.1.0` | PNG zTXt 解压 |
| 图标 | `lucide-react-native@1.16.0` | 统一图标库 |
| Toast | `react-native-toast-message@2.3.3` | 全局通知 |
| SVG | `react-native-svg@15.15.5` | 矢量图 |
| SafeArea | `react-native-safe-area-context@5.8.0` | 刘海适配 |

### 2.2 开发依赖

- `typescript@5.8.3` + `@react-native/typescript-config`
- `jest@29.6.3` + `@testing-library/react-native@13.3.3`
- `eslint@8.19.0` + `@react-native/eslint-config`
- `prettier@2.8.8`（`arrowParens: 'avoid'`、`singleQuote: true`、`trailingComma: 'all'`）

### 2.3 工具链

- Android：compileSdk/targetSdk 36、minSdk 24、buildTools 36.0.0、NDK 27.1.12297006、Kotlin 2.1.20
- ABI：`arm64-v8a` + `x86_64`
- Hermes：强制开启（RN 0.85+ JSC 已移除）
- New Architecture：默认开启（无需 flag）

---

## 3. 项目结构

```
shinewriter/
├── android/                          # Android 原生工程
│   ├── app/
│   │   ├── jni/                      # CMake + llama.cpp 源码 + JNI 绑定
│   │   ├── src/main/java/com/shinewriter/
│   │   │   ├── MainActivity.kt
│   │   │   ├── MainApplication.kt
│   │   │   ├── PngMetadataModule.kt + Package
│   │   │   ├── PipelineForegroundModule.kt + Package + Service
│   │   │   ├── TtsAudioModule.kt + Package + ForegroundService + TextChunker
│   │   │   ├── llamacpp/              # 本地推理核心（12 个文件）
│   │   │   └── react/CoreTurboModuleBridge.kt
│   │   ├── build.gradle
│   │   └── keystores/                 # 签名
│   ├── build.gradle / settings.gradle # 阿里云 Maven 镜像
│   └── gradle.properties
├── scripts/                           # 构建脚本
│   ├── build-apk.js
│   ├── generate-version-json.js
│   ├── patch-sqlite-storage-gradle.js
│   ├── patch-deps.js
│   └── zspace-webdav.mjs
├── src/
│   ├── main/index.tsx                 # App 根组件
│   ├── navigation/                    # 导航
│   ├── screens/                       # 27 个屏幕
│   ├── components/                    # UI 原语 + 业务组件
│   ├── services/                      # 业务服务层
│   │   ├── llm/                       # LLM Provider 子模块
│   │   ├── migrations/                # DB 迁移链
│   │   ├── database/                  # 事务/Schema/校验
│   │   ├── llm.ts、database.ts、contextBuilder.ts、pipelineRunner.ts 等
│   ├── store/                         # 6 个 Zustand store
│   ├── data/                          # 数据层（分层架构）
│   │   ├── connection/                # SQLite 连接原语
│   │   ├── schema/                    # Schema 创建/初始化/校验
│   │   ├── repositories/              # 13 个领域仓储
│   │   └── migrations/                # re-export services/migrations
│   ├── native/                        # JS 侧原生桥接
│   ├── types/                         # TypeScript 类型定义（11 个）
│   ├── utils/                         # 工具函数（9 个）
│   ├── constants/                     # 常量与版本元数据
│   └── assets/                        # 主题背景图
├── __tests__/                         # Jest 测试
├── e2e/                               # Maestro E2E + 故障注入
├── docs/                              # 文档
├── index.js                           # RN 注册入口
├── package.json
└── [配置文件] babel/metro/jest/eslint/prettier/tsconfig
```

---

## 4. 整体架构

### 4.1 分层架构图

```
┌─────────────────────────────────────────────────────┐
│  UI 层  (screens × 27 / components × 9)              │
└─────────────────┬───────────────────────────────────┘
                  │ 订阅
┌─────────────────▼───────────────────────────────────┐
│  状态层  Zustand Stores × 6                          │
│  project / settings / theme / pipelineTask /         │
│  localModel / voice                                  │
└─────────────────┬───────────────────────────────────┘
                  │ 调用
┌─────────────────▼───────────────────────────────────┐
│  业务服务层  services/*                              │
│  pipelineRunner / contextBuilder / llm /             │
│  backupService / secureStorage / tts / fileImport 等 │
└─────────────────┬───────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────────┐
│  Facade  services/database.ts (纯 re-export)        │
└─────────────────┬───────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────────┐
│  仓储层  data/repositories/* (13 个 + shared)        │
└─────────────────┬───────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────────┐
│  Schema 层  createCurrentSchema / initializeDatabase │
│             schemaManifest / schemaValidator         │
└─────────────────┬───────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────────┐
│  连接层  openDatabase / execute / query / transaction│
└─────────────────┬───────────────────────────────────┘
                  │
       react-native-sqlite-storage (Native)
                  │
            shine_writer.db
```

### 4.2 原生层

```
┌──────────────────────────────────────────────────────┐
│  Kotlin Native Modules                                │
│  ├─ PngMetadataModule    (PNG tEXt 解析)              │
│  ├─ PipelineForeground   (前台服务 + deep link)       │
│  ├─ TtsAudio             (MediaPlayer + TextToSpeech) │
│  └─ LlamaCpp             (本地 GGUF 推理 JNI)         │
└─────────────────┬────────────────────────────────────┘
                  │ JNI / ReactMethod
┌─────────────────▼────────────────────────────────────┐
│  C/C++ 层                                            │
│  ├─ llama.cpp (第三方源码)                           │
│  └─ llamacpp_jni.cpp (5 个 external 方法)            │
└──────────────────────────────────────────────────────┘
```

---

## 5. 启动流程

### 5.1 入口链路

```
index.js
  └─ AppRegistry.registerComponent('ShineWriter', () => App)
     └─ App from src/main/index.tsx
```

- `__DEV__` 模式下 `LogBox.ignoreAllLogs(true)`（BUG-5 修复：LogBox 警告条会盖住 Tab 栏）
- `App.tsx` 是兼容入口，仅 re-export

### 5.2 App 启动序列（`src/main/index.tsx`）

```
1. 首帧渲染：SafeAreaProvider > ThemeProvider > ImageBackground(splash.png)
2. SPLASH_VISIBLE_MS = 1200ms 后触发 init()：
   ├─ openDatabase()                   # 失败也继续，避免白屏
   ├─ settingsStore.loadSettings()     # 必须先于写作入口同步原生开关
   ├─ pipelineTaskStore.loadFromDB()
   └─ pipelineTaskStore.markActiveTasksAsInterrupted()   # 冷启动自愈
3. 升级判定：
   ├─ lastInstallInfo.installType === 'upgrade'
   └─ hasBreakingMigration(schemaVersion) → 弹 UpgradeScreen
       否则 setReady(true)
4. ready=true 后渲染 NavigationContainer(TabNavigator)
5. 第二个 useEffect：订阅 pipelineTaskStore，终态任务弹全局 Modal
6. 第三个 useEffect：消费 deep link → navigateToPipelineResult
```

### 5.3 数据库初始化（`data/schema/initializeDatabase.ts`，329 行）

```
PRAGMA foreign_keys=ON
  → ensureMetadataTable
  → detectInstallType (fresh/upgrade/same)
  → [fresh] createCurrentSchema
  → [upgrade] runMigrations
  → validateSchemaBeforeStartup
  → repairKnownSchemaDefects
  → seedDefaults (全局项目 id=0 / 默认 LLM 配置 / 默认预设)
  → ensureCurrentIndexes
  → repairOversizedNotes
  → assertValidSchema
```

---

## 6. 导航体系

### 6.1 Tab 结构（`src/navigation/TabNavigator.tsx`）

| Tab | 主屏 | 说明 |
|---|---|---|
| 项目 | `ProjectListScreen` | 项目 CRUD / 导入导出 |
| 写作 | `EditorMainScreen` | 按 `project.mode` 切 `OutlineEditor` / `FreeformEditor` |
| 资料 | `ResourceLibrary` | 角色 / 世界书 / 笔记 / 预设 4 Tab |
| 设置 | `SettingsScreen` | 所有配置入口 |

底部 Tab 用 `useSafeAreaInsets()` 计算 padding，图标用 lucide（FolderKanban / BookOpen / Boxes / Settings）。

### 6.2 三个嵌套 Stack

**EditorStackParamList**：
- `EditorMain` / `ChapterEditor{chapterId}` / `ChapterSummary{chapterId}`
- `PlotlineManager` / `StoryOverview` / `ContextConfig`
- `PipelineResult{taskId}`
- `RevisionHistory{targetType, targetId, projectId}`
- `ContextPreview{chapterId}` / `DraftPreview{...}`

**SettingsStackParamList**：
- `SettingsMain` / `LLMSettings` / `VoiceSettings`
- `PipelineConfig` / `PipelineTask` / `PipelineResult{taskId}`
- `BackupCenter` / `UsageStats` / `LocalModelManager` / `ContextAutoConfig`

### 6.3 全局导航工具（`navigation/navigationRef.ts`）

- `navigationRef`：`createNavigationContainerRef<RootStackParamList>()`
- `navigateToPipelineResult(taskId)`：未就绪时缓存 + 200ms 轮询（5 秒超时）
- `doNavigateToPipelineResult`：嵌套 navigate fallback（Settings → Editor → PipelineTaskCenter）

### 6.4 全局 Prompt 抑制（`pipelinePromptSuppression.ts`）

单例 Set，记录 batch 流程已处理的 taskId，避免全局 Modal 重复弹。

---

## 7. 主题与 UI 基础

### 7.1 主题（`src/types/theme.ts` + `store/themeStore.ts`）

```typescript
type ThemeMode = 'light' | 'dark' | 'eyecare';
interface ThemeColors {
  background / surface / card
  textPrimary / textSecondary / textMuted
  accent / accentSoft / danger / success / warning / border
}
interface AppTheme { mode: ThemeMode; colors: ThemeColors; }
```

- 三套硬编码颜色，基准三色 `#439EA6 / #B0E0E3 / #D7F1F4`
- `ThemeProvider` 挂载时从 DB `settings.theme_mode` 同步到 store
- `themeStore` 不持久化，依赖 ThemeProvider 启动加载

### 7.2 UI Primitives（`src/components/ui.tsx`）

| 组件 | 说明 |
|---|---|
| `Screen` | 屏幕容器，按 mode 切书纸背景图（bookish-paper/dark/eyecare-bg） |
| `Header` | 标题 + 副标题 + 可选 action |
| `Section` | 区块容器 |
| `Card` | 卡片 |
| `Button` | 4 variant（primary/secondary/danger/ghost），支持 icon |
| `IconButton` | 图标按钮 |
| `Field` | TextInput 包装，placeholderTextColor 走主题 |
| `SegmentedControl<T>` | 泛型分段控件 |
| `EmptyState` | 空状态 |
| `LoadingState` | 加载中 |

所有组件统一从 `useThemeStore` 取色，**不硬编码**。

### 7.3 关键常量（`src/constants/`）

- `defaults.ts`：LLM/上下文默认值（temperature 0.8、top_p 0.9、max_tokens 4000、slidingWindowSize 4000、resourceBudget 2000、summaryBudget 20000）+ `DEFAULT_CONTEXT_CONFIG` + `PLOTLINE_COLORS` + `THEME_COLORS`
- `llmDefaults.ts`：`LOCAL_LLM_DEFAULT_MAX_OUTPUT_TOKENS = 512`、`LOCAL_LLM_SAFE_MAX_OUTPUT_TOKENS = 512`
- `voice.ts`：`MAX_TTS_CHARS`、13 个 `VOICE_PRESETS`、`DEFAULT_VOICE_CONFIG`、TTS 错误码映射

---

## 8. 状态管理（Zustand Stores）

6 个 store，全部 `create<T>((set, get) => ({...}))` API，**无中间件、无 persist**（持久化由 services/database 显式完成）。

### 8.1 `projectStore`

```typescript
{
  projects: Project[];
  currentProject: Project | null;
  loading: boolean;
  loadProjects(): Promise<void>;
  createProject(name, mode): Promise<number>;
  deleteProject(id): Promise<void>;
  renameProject(id, name): Promise<void>;
  setCurrentProject(project): Promise<void>;
}
```

`loadProjects` 会从 settings 读 `current_project_id` 并自动回退 `projects[0]`。

### 8.2 `settingsStore`

```typescript
{
  llmConfig: LLMConfig;          // 当前激活配置
  llmConfigs: LLMConfig[];
  contextConfig: ContextConfig;
  backgroundPipelineEnabled: boolean;
  allowInsecureLanHttp: boolean;
  loadSettings(): Promise<void>;
  saveLLMConfig / setActiveLLMConfig / deleteLLMConfig
  setContextConfig / setBackgroundPipelineEnabled / setAllowInsecureLanHttp
}
```

**自愈**：所有 usableConfigs 都没 `is_active=1` 时自动激活第一个。

### 8.3 `themeStore`

```typescript
{
  mode: ThemeMode;
  theme: AppTheme;
  setMode(mode): void;
}
```

三套硬编码颜色，`getThemeColors(mode)` 纯函数映射。

### 8.4 `pipelineTaskStore`（最复杂）

```typescript
{
  tasks: PipelineTask[];
  _loaded: boolean;
  loadFromDB / createTask / updateTaskStage / setTaskStatus
  completeTask / failTask / cancelTask / resolveTask / clearResolved
  getActiveTaskForTarget / getUnresolvedCount
  markStaleTasksAsFailed(staleMs=10min)   # 前台→后台→前台场景
  markActiveTasksAsInterrupted            # 冷启动自愈
}
```

- `taskIdCounter` 模块级变量防碰撞
- 每次 state 变更都 fire-and-forget 写 DB

### 8.5 `localModelStore`

```typescript
{
  models: LocalModel[];
  import: ImportState;   // {state, bytesCopied, totalBytes, errorCode, ...}
  loadingModelId: string | null;
  refreshModels / loadModel / startImport / validateModel / cancelImport / deleteModel
}
```

`startImport` 包含：双层可用性探测、动态超时（90s + 250ms/MB）、Promise.race 防挂起。

### 8.6 `voiceStore`

```typescript
{
  engine: 'system' | 'cloud' | 'builtin';
  config: VoiceConfig;
  apiKey: string;
  systemConfig: SystemTtsConfig;
  isSynthesizing / isPlaying / playbackState
  activeTtsSessionId: string | null;   # 会话过滤
  loadVoiceConfig / saveVoiceConfig / saveSystemTtsConfig
  setEngine / setVoiceApiKey / playChapter / stop
}
```

三引擎分发 + `activeTtsSessionId` 防老会话事件污染。

---

## 9. 数据层

### 9.1 Connection 层（4 个原语）

| 文件 | 职责 |
|---|---|
| `openDatabase.ts` | 单例 `SQLiteDatabase`，`SQLite.enablePromise(true)`；`opening` Promise 去重；失败清空让下次重试；打开后立即 `initializeDatabase` |
| `execute.ts` | 唯一 `executeSql` 包装，导出 `Row` 类型 |
| `query.ts` | `all<T>()` / `one<T>()` 读助手 |
| `transaction.ts` | re-export → `services/database/transaction.ts`，要求 scope 内**同步** push SQL |

### 9.2 Schema 层

| 文件 | 职责 |
|---|---|
| `createCurrentSchema.ts` | 全新安装时一次性 CREATE 22 张表 + 索引（fresh 跳过所有迁移） |
| `initializeDatabase.ts` | 启动总编排（详见 5.3） |
| `schemaManifest.ts` | re-export，`SCHEMA_MANIFEST` 是 schema 唯一事实来源 |
| `schemaValidator.ts` | 运行时校验：表/列/索引存在 + 外键 + 17 条孤儿检查 + LLM 配置合法性 |

### 9.3 Repositories 层（13 个仓储 + shared.ts）

| 仓储 | 领域 | 关键特性 |
|---|---|---|
| `projectRepository` | 项目/章节/片段/情节线 | `usageJoin` 动态子查询；全局项目 id=0；`setProjectResourceEnabled` 跨项目映射 |
| `characterRepository` | 角色卡 + 合集 | 创建自动估 token + 链接项目；合集级联删；合集 token 重算 |
| `contentRepository` | 自由文档 + 版本 + 草稿 | `content_revisions` 自动 trim（手动 20 / 自动 50 条上限） |
| `contextAutoRepository` | 上下文自动配置 | 仅 2 个 settings key |
| `llmConfigRepository` | LLM 配置 | **最复杂**：`hydrateLLMConfig` 从 Keystore 读 key + legacy 迁移 + 清空 DB api_key 字段；`insertId` 用 `last_insert_rowid()` 兜底 |
| `localModelRepository` | 本地 GGUF 模型 | 21 列；sha256 去重；删除前检查依赖 |
| `noteConfigRepository` | 笔记双模式配置 | mode: none/style/retrieval；风格画像 hash 校验 |
| `noteRepository` | 笔记 CRUD | 大文本切分（NOTE_TEXT_CHUNK_CHARS=120000）；分块读取；运行时 repairOversizedNotes |
| `pipelineTaskRepository` | 管线配置 + 任务 | `getPipelineConfig` 用 `SELECT WHERE key IN (...)` 一次拉 9 字段 |
| `presetRepository` | 预设 | `is_default` 单例；`ensureDefaultPreset` 启动种子 |
| `settingsRepository` | KV 设置 | JSON 配置 try-catch + 默认值兜底 |
| `usageRepository` | LLM 用量日志 | 按日聚合 / 总量 / 按配置分组（V2.2.0） |
| `worldbookRepository` | 世界书 + 合集 | 与 characterRepository 对称；`setAllProjectResourcesEnabled` 批量 |

### 9.4 Facade 模式

`services/database.ts` 是 32 行纯 re-export，聚合所有 repositories + connection + schema 入口。

**硬规则**：所有数据操作必须通过 `services/database.ts`，**不允许页面直接 import repositories**。

### 9.5 全局资源池机制

`project_resources` 表是核心枢纽表：

- 三元组 `(project_id, resource_type, resource_id)` + `enabled`
- 所有 character/worldbook/note/preset 创建时 `project_id` 都写 0（全局）
- 通过 `project_resources` 表显式映射到具体项目
- `deleteProject(id)` 显式 `if (id <= 0) return` 防误删全局资源

---

## 10. 业务服务层

### 10.1 服务清单

| 服务 | 一句话职责 |
|---|---|
| `llm.ts` | LLM 调用入口 facade（resolveLLMRequestConfig → provider → schedule） |
| `database.ts` | 纯 re-export facade |
| `contextBuilder.ts` | 三种前文策略 + IDF 召回 + 资源组装 |
| `contextAutoAllocator.ts` | 用户输入总预算 → 按比例拆 13 字段 → 原子事务写回 |
| `macroReplace.ts` | `{{char}} / {{user}} / {{chapter}} / {{synopsis}}` 替换 |
| `chapterGeneration.ts` | 章节续写请求构造（纯函数） |
| `summaryGenerator.ts` | 结构化 JSON 摘要 + 自然语言 memory_summary |
| `batchChapterPipeline.ts` | 大纲驱动批量生成 N 章 |
| `pipelineRunner.ts` | 多阶段 AI 管线运行器 ★ |
| `pipelineMessages.ts` | 4 阶段 prompt 构建（纯函数） |
| `draftService.ts` | `generation_drafts` CRUD + 字段映射 |
| `revisionService.ts` | `content_revisions` + 去重 + trim + 还原快照 |
| `styleAnalyzer.ts` | LLM 5 维度风格画像 + 缓存 + 多笔记合并 |
| `noteRetriever.ts` | 关键词预筛 + LLM 精选 + LRU 缓存 |
| `backupService.ts` | Manifest 驱动 v3 备份 + SHA-256 + 原子恢复 ★ |
| `secureStorage.ts` | Keystore 按 configId 分隔 ★ |
| `localModels.ts` | GGUF 导入/校验/加载/卸载/删除 |
| `tts.ts` | MiniMax 语音 API 合成到文件 |
| `fileImport.ts` | JSON/PNG 角色卡 + lorebook + TXT 笔记 |
| `projectImport.ts` | shinewriter-project-v1/v2 项目包导入 |
| `exportService.ts` | Markdown / TXT(UTF-8 BOM) / JSON 导出 |

### 10.2 上下文构建（`contextBuilder.ts`）

**三种前文策略**（`selectPreviousChapters`）：
- `full`：全取
- `custom`：按 position 范围
- `sliding`：默认，取最近 N 章（slidingWindowSize）

**三种笔记模式**（按 `project_note_config.mode`）：
- `none`：全量分块注入（V2.2.0 用 `getNotesContentByIds` 批量拉取）
- `style`：调用 `styleAnalyzer.mergeStyleProfiles` 注入仿写指令
- `retrieval`：调用 `noteRetriever.retrieveNoteFragments` 做 LLM 检索

**记忆摘要召回（TF-IDF + 余弦相似度）**：
- `tokenize`：中文按字 / 英文按词 / 过滤停用词
- `buildIdf`：`log((N+1)/(df+1)) + 1`
- V2.2.0 IDF 缓存（`utils/idfCache`）：按项目签名缓存，30 分钟 TTL，LRU 上限 16

**资源预算分配**（`buildResourceContext`）：
- 固定比例 角色 35% / 笔记 20% / 世界书 45%
- 三者 `Promise.allSettled` 并行，单个失败不拖全局

**世界书激活算法**：
1. 第一轮：常驻条目直接激活；主关键词命中后看次关键词
2. 第二轮：递归激活（已激活条目 content 作为新 haystack）
3. 按 collection 预算和 entry 预算双重裁剪

### 10.3 上下文自动分配（`contextAutoAllocator.ts`）

**比例常量**：
- 输入/输出 = 80% / 20%
- 输入内：滑动窗口 65% / 资料预算 20% / 摘要预算 15%
- 输出内：草稿 50% / 审阅 15% / 事实 15% / 校对 20%
- 资源内：角色 35% / 笔记 20% / 世界书 45%

**纯函数 + 应用函数分离**：纯函数可单测，应用函数 `executeTransaction` 一次性原子提交。

**本地 llama_cpp 配置不覆写**（`WHERE provider_type IS NOT 'llama_cpp'`）。

### 10.4 备份 v3 格式（`backupService.ts`）★

```typescript
interface BackupV3 {
  format: 'shinewriter-backup';
  format_version: 3;
  meta: {
    app_version, schema_version, created_at, kind,
    checksum_algorithm: 'sha256',
    checksum: string
  };
  tables: Record<string, Row[]>;
  external_assets: [{ local_model_reference: { id, filename, sha256, file_size, included: false } }];
}
```

**核心机制**：
1. Manifest 驱动：`SCHEMA_MANIFEST` 定义每张表的 columns/backup/restoreOrder
2. 三层校验：格式 + 结构 + SHA-256 checksum
3. SHA-256 纯 JS 实现（手写，每 512 块 yield 事件循环避免阻塞 UI）
4. 敏感字段三层脱敏：写入前 `sanitizeBackupRow` + 恢复时 redact + 恢复后 `clearSecureLLMApiKey`
5. 原子恢复 + 失败回滚：单事务提交 + `assertRestoredSchema` 失败用快照重放
6. 本地模型不打包：`external_assets` 只记录 reference（sha256 + filename）
7. 保留数：automatic=3 / manual=10 / pre_restore=3

**敏感字段识别**（normalize 后比较）：`api_key / apikey / password / *_password / secret / authorization / bearer / token / *_token / credential / webdav_* / sync_*`

### 10.5 安全存储（`secureStorage.ts`）★

**按配置 id 分隔**：

```typescript
const LLM_API_KEY_SERVICE = 'com.shinewriter.llm.api-key';
function serviceForConfig(configId?) {
  return configId == null ? LLM_API_KEY_SERVICE : `${LLM_API_KEY_SERVICE}.${configId}`;
}
function accountForConfig(configId?) {
  return configId == null ? 'llm-api-key' : `llm-api-key-${configId}`;
}
```

- 每条 LLM 配置（`llm_config.id`）对应独立 Keychain service + account
- `accessible: ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY`（不跨设备同步）
- `migrateLegacyLLMApiKey(configId)`：从全局旧位置迁移到 configId 位置

**三层兜底**：
- 写入：空串自动清理
- 迁移：legacy 全局 key → configId 位置
- 恢复：`backupService.restoreFromBackup` 后批量清理所有恢复配置的 key

**`llm_config` 表只存非密钥字段**：name / base_url / model_name / is_active / provider_type / local_model_id / context_window / max_output_tokens，API Key 永远在 Keystore。

---

## 11. LLM 子系统

### 11.1 Provider 抽象（策略模式 + 工厂注册）

```
LLMProvider 接口 (test + generate)
       ▲
       │ implements
┌──────┴────────────┬─────────────────────┐
│ openAICompatible  │ llamaCppProvider     │
│ Provider          │  └─ llamaCppPromptAdapter (7 模板)
└──────┬────────────┴─────────────────────┘
       │ 调用
       ▼
┌──────────────────────────────────────────┐
│ providerRegistry.getProvider(type)       │
└──────────────────────────────────────────┘
       │ 依赖（横切）
       ▼
┌──────────────┬──────────────┬─────────────┐
│ requestSched.│ requestPolicy│ networkPolicy│
│ (并发/串行)   │ (超时/错误)  │ (HTTP/HTTPS) │
└──────────────┴──────────────┴─────────────┘
```

### 11.2 核心类型（`services/llm/types.ts`）

| 类型 | 说明 |
|---|---|
| `ChatMessage` | `{ role: 'system'\|'user'\|'assistant'; content: string }` |
| `LLMResult` | 生成结果 + token 计数 + metrics + errorCode |
| `LLMGenerateOptions` | 调用参数（scenario / projectId / taskId / queueClass/Priority / onProgress / onQueueState） |
| `LLMQueueClass` | `'normal' \| 'pipeline' \| 'background' \| 'connection' \| 'local'` |
| `LLMQueuePriority` | `'manual' \| 'normal' \| 'background'` |
| `LLMProviderType` | `'openai_compatible' \| 'llama_cpp'` |
| `LLMRequestConfig` | provider_type / api_key / model_name / url / local_model_id / context_window / max_output_tokens / allow_insecure_lan_http |

### 11.3 Provider 实现

#### `openAICompatibleProvider.ts`（315 行）

- `normalizeChatCompletionUrl(baseUrl)`：识别 deepseek、`/vN` 版本号段，补 `/v1/chat/completions`
- `createConcurrencyLimiter(limit)`：通用并发限流器
- `generate`：校验 config → `assertAllowedLLMEndpoint` → 估算 inputTokens → `scheduleLLMRequest` 排队 → fetch → 解析 → `safeLogUsage`

#### `llamaCppProvider.ts`（432 行）

模块级状态（单模型缓存）：`currentLoadedModelId` / `currentLoadedContextLength`

关键函数：
- `ensureModelLoaded(modelId, path, ctx)`：命中缓存跳过，否则 nativeLoadModel
- `resolveLocalMaxTokens(opt, cfg)`：三档候选取最小，封顶 `LOCAL_LLM_SAFE_MAX_OUTPUT_TOKENS`
- `shouldDisableReasoning(name)`：正则匹配 qwen3
- `addNoThinkInstruction(messages)`：注入 `/no_think`
- `stripReasoningBlocks(text)`：清除 `<think>...</think>`
- `runGeneration(requestId, ...)`：把 native 流式事件聚合为 Promise<CompletedEvent>

**关键修复（P1-#8）**：`observeGeneration` 的 onToken 必须在 `nativeGenerate` 之前注册。

### 11.4 Prompt 模板（`llamaCppPromptAdapter.ts`）

| 模板 | 支持模型 |
|---|---|
| `chatml` / `qwen` | Qwen2/2.5、GLM-4、Yi、DeepSeek |
| `llama3` | Llama-3 / 3.1 |
| `alpaca` | Alpaca / 早期指令模型 |
| `phi` | Phi-3 mini |
| `mistral` | Mistral / Mixtral（system 塞入首个 `[INST]`） |
| `custom` | `role: content` 简单拼接兜底 |

### 11.5 请求调度器（`requestScheduler.ts`，267 行）★

子模块最复杂的横切组件，单例 `llmRequestScheduler`。

**并发限额**：
```typescript
LIMITS = { normal: 3, pipeline: 3, background: 2, connection: 1, local: 1 }
PRIORITY = { manual: 0, normal: 1, background: 2 }
```

**双重约束**（pipeline 类别）：
1. 同项目互斥：`activePipelineProjects: Set<string>`
2. 占用 online 总配额：pipeline + normal ≤ LIMITS.normal

**低内存模式**：
- 监听原生 `LLM_MEMORY_PRESSURE_EVENT`
- 监听 AppState，切回前台自动恢复
- 低内存时 `pump()` 完全停摆

**取消路径**：
- 未启动：直接出队 + `LLMQueueError`
- 已启动：`controller.abort()` → Provider 内部监听清理

### 11.6 超时与错误（`requestPolicy.ts`）

```typescript
LLM_TIMEOUTS = {
  connectionMs: 20s,
  normalMs: 60s,
  chapterDraftMs: 180s,
  localIdleMs: 45s
}
```

`createLLMTimeoutController`：组合三种 abort 源（externalSignal + totalTimer + idleTimer）。

`LLMRequestError`：6 种 code（cancelled / connect_timeout / idle_timeout / total_timeout / network_error / provider_error）。

### 11.7 网络策略（`networkPolicy.ts`）

- `isPrivateLanHost(hostname)`：判定 IPv4 私网（127/8、10/8、172.16/12、192.168/16）
- `validateLLMEndpoint`：HTTPS 直接放行；HTTP 须 `allowInsecureLanHttp=true` 且 host 在私网；其余抛 `insecure_http_blocked`

---

## 12. AI 多阶段管线

### 12.1 四种模式（`pipelineRunner.ts`）★

| 模式 | 阶段串 | 说明 |
|---|---|---|
| `noReview` | draft | 只跑草稿，直接完稿 |
| `twoStage` | draft → (review ‖ proof) | proof 只看 draft，与 review 并行 |
| `conditional` | draft → (factCheck ‖ proof) | 跳过 review |
| `full`（默认） | draft → (review ‖ factCheck) → proof | proof 综合 review + factCheck |

### 12.2 完整执行时序（full 模式）

```
1. setLLMTaskQueueDefaults(taskId, {queueClass, queuePriority})
2. registerTaskAbort(taskId) → AbortController
3. PipelineForeground.start(taskId, ...) ← 必须在任何 await 之前
4. 读配置（getPipelineConfig / getContextConfig / getPresetsByProject / resolveLLMRequestConfig）
   └── 若 llama_cpp：自动收紧 contextConfig（1024/1024/512/1）
5. resolvePreset(draft/review/factCheck/proof)
6. 【阶段 1：draft】
   ├── createChapterGenerationRequest(chapter)
   ├── buildContext(chapter, contextConfig, projectId, draftPreset)
   ├── buildDraftMessages(...)
   ├── callLLMResult(..., abortSignal)
   └── store.updateTaskStage({stage:'draft', status:'success', tokens, durationMs})
7. 【阶段 2：review ‖ factCheck 并行】
   ├── Promise.allSettled([reviewPromise, factCheckPromise])
   └── 两者都失败 → saveDraftAndComplete(draftText) 直接结束
8. 【阶段 3：proof 综合】
   ├── runProofStage({draftText, reviewText, factCheckText})
   └── 失败 → 回退 draftText
9. saveDraftAndComplete(finalText)
   ├── saveDraft({...content, source:'pipeline', pipelineTaskId:taskId})
   ├── store.completeTask(taskId, text)
   ├── PipelineForeground.updateProgress(..., 100)
   ├── PipelineForeground.notifyComplete(...)
   └── PipelineForeground.stop(taskId)
10. finally：releaseTaskAbort + clearLLMTaskQueueDefaults + cancelledTasks.delete(taskId)
```

### 12.3 取消机制三件套

- `cancelledTasks: Set<string>`：JS 层快速标记
- `taskAbortControllers: Map<taskId, AbortController>`：传给 `callLLMResult` 作 `externalSignal`
- `usePipelineTaskStore.cancelTask`：立刻把终态写 SQLite

### 12.4 错误恢复策略

- draft 失败 → 整个任务 fail
- review 或 factCheck 失败 → 用空串继续走 proof
- proof 失败 → 回退 draftText
- review + factCheck 都失败 → 直接保存 draftText

### 12.5 Prompt 构建（`pipelineMessages.ts`）

| 阶段 | 关键逻辑 |
|---|---|
| draft | 追加【任务】【前章衔接（-800 字符）】【章节大纲】【已有正文末尾（-1500）】+ userPrompt |
| review | 要求输出严格 JSON `{strengths[], issues[], suggestions[]}` |
| factCheck | 注入上下文设定（截断 3000 字符），输出 `{errors[], warnings[], confirmed[]}` |
| proof | 综合三者输出"修改后的完整文本"，用 `reviewText.trim()` 判空（避免 JSON 内含"未能完成"误判） |

---

## 13. 屏幕组件

`src/screens/` 共 27 个 `.tsx`（含 chapter-editor 子目录 10 个）。

### 13.1 屏幕清单

| Tab | 屏幕 | 职责 |
|---|---|---|
| 项目 | `ProjectListScreen` | 项目 CRUD / 搜索 / 导入导出 |
| 写作 | `OutlineEditor` | 大纲模式（章节卡 / AI 写 N 章） |
| 写作 | `FreeformEditor` | 自由模式（单文档 / 片段管理） |
| 写作 | `ChapterEditor` (chapter-editor/) | 章节编辑（组装 5 个 hook） |
| 资料 | `ResourceLibrary` | 4 Tab：角色/世界书/笔记/预设 |
| 设置 | `SettingsScreen` | 所有配置入口 |
| 设置 | `LLMSettingsScreen` | LLM 配置 CRUD + 测试连通 |
| 设置 | `VoiceSettingsScreen` | TTS 三引擎配置 |
| 设置 | `PipelineConfigScreen` | 管线模式 + 阶段预设 |
| 设置 | `PipelineTaskScreen` | 任务中心 |
| 设置 | `BackupCenterScreen` | 备份列表/创建/恢复/删除 |
| 设置 | `UsageStatsScreen` | LLM 用量统计 |
| 设置 | `ContextAutoConfigScreen` | 上下文自动分配 |
| 设置 | `LocalModelManagerScreen` | 本地 GGUF 管理 |
| Stack | `PipelineResultScreen` | 管线结果详情 + 采纳/放弃 |
| Stack | `DraftPreviewScreen` | AI 草稿预览/采纳/删除 |
| Stack | `RevisionHistoryScreen` | 版本历史 + 还原（带 undo 快照） |
| Stack | `ContextConfig` | 上下文策略配置 |
| Stack | `ContextPreviewScreen` | 实时上下文预览（trace + messages） |
| Stack | `StoryOverview` | 故事概览 + 统计 |
| Stack | `ChapterSummary` | 结构化摘要编辑 + LLM 生成 |
| Stack | `PlotlineManager` | 情节线管理 + LLM 批量生成 |
| Stack | `CharacterDetail` / `WorldbookDetail` | 只读详情页 |
| Modal | `UpgradeScreen` | 升级流程（4 状态机） |

### 13.2 ChapterEditor 组合（`chapter-editor/`）

| 子组件/Hook | 职责 |
|---|---|
| `ChapterEditorScreen` | 主屏幕，组装所有 hook |
| `ChapterFields` | 标题/概要/正文/记忆摘要/Token 统计 |
| `ChapterPipelinePanel` | 顶部进度条 |
| `ChapterToolbar` | 横向滚动的 10 个工具按钮 |
| `ChapterTtsControls` | TTS 朗读范围 Modal |
| `useChapterDocument` | 加载章节 state |
| `useChapterAutoSave` | 900ms 防抖自动保存 |
| `useUnsavedChangesGuard` | beforeRemove + AppState flush 守卫 |
| `useChapterPipeline` | 管线运行 + 任务订阅 + 自动跳转 |
| `useChapterTts` | 朗读控制 + 范围 Modal |

### 13.3 屏幕导航关系

```
ProjectListScreen (Tab) → setCurrentProject 后切 Tab
OutlineEditor → ChapterEditor / StoryOverview / ContextConfig
FreeformEditor → RevisionHistory { targetType:'freeform' }
SettingsScreen → ContextAutoConfig / LLMSettings / PipelineConfig /
                 PipelineTask / VoiceSettings / BackupCenter / UsageStats
LLMSettingsScreen → LocalModelManager
LocalModelManagerScreen → LLMSettings (回跳)
ChapterEditor → ContextPreview / DraftPreview / RevisionHistory / PipelineResult
PipelineTaskScreen → PipelineResult
PipelineResultScreen → closePipelineResult → SettingsMain / EditorMain
```

### 13.4 屏幕共性模式

1. 数据访问统一 facade（`services/database.*`）
2. 错误反馈：`react-native-toast-message` + `Alert.alert`
3. 异步守卫：`isMountedRef` / `isEditingRef` / `adoptingRef` / `acceptedRef`
4. 双形态：Tab 主屏走 Stack；详情/工具屏走 Modal-onClose

---

## 14. 业务组件库

| 组件 | 职责 |
|---|---|
| `AIStreamText` | 流式 AI 输出底部状态条 + 停止按钮 |
| `ChapterCard` | 章节列表卡（plotline 颜色 dot 用 `${color}-${i}` 防 key 复用） |
| `CharacterEditor` | 角色卡 JSON 可视化编辑器（兼容 `{data:{...}}` 信封格式） |
| `LocalModelSelector` | 本地 GGUF 模型选择器 |
| `PipelineProgress` | 管线顶部进度条（1s 更新计时） |
| `PipelineResultPrompt` | 管线完成/失败全局 Modal（替代原生 Alert） |
| `BatchImportResultModal` | 批量导入结果汇总（唯一未接入 themeStore） |

### 14.1 CharacterEditor 关键设计

- `safeParseCard(raw)`：解析 JSON，区分 `hasEnvelope`
- `parseMesExample(text)`：按 `<START>` 拆对话组
- `debounceNotifyFactory(timerRef)`：闭包工厂，debounce timer 存实例 useRef（8.8 修复）
- `fieldsRef.current`：每帧同步所有字段（8.1 修复 emitChange 闭包陷阱）
- JSON 解析失败时降级为纯文本 Field 编辑

---

## 15. 原生模块与 Android 工程

### 15.1 JS 侧原生桥接（`src/native/`）

| 模块 | 类型 | 关键方法 |
|---|---|---|
| `PngMetadataModule` | legacy | `parsePngMetadata(filePath)` |
| `LlamaCppModule` | TurboModule + 三层 fallback | `loadModel / generate / cancel / importModel / validateModel` |
| `PipelineForegroundModule` | 单例 class | `start / updateProgress / notifyComplete / stop / consumeDeepLinkTaskId` |
| `TtsAudioModule` | legacy | MediaPlayer 轨 + 系统 TextToSpeech 轨 |
| `specs/NativeLlamaCpp` | Codegen spec | 定义 `Spec extends TurboModule` |

### 15.2 LlamaCppModule 三层 fallback 探测

1. `NativeModules.LlamaCpp`（legacy + bridgeless shim）
2. `global.__turboModuleProxy('LlamaCpp')`（codegen TurboModule）
3. `TurboModuleRegistry.get('LlamaCpp')`（public API）

### 15.3 Android 原生（`com/shinewriter/`）

#### PngMetadata 模块

PNG tEXt 块解析：8 字节签名校验 → 循环读 chunk（length+type+data+CRC）→ chunk 上限 50MB 防 OOM → 提取 tEXt 按 null 字节分隔。

#### Pipeline 前台服务三件套

- **PipelineForegroundModule**：完成通知发独立 id（`taskId.hashCode()`），PendingIntent 跳 MainActivity 带 `shinewriter.deeplink.task_id`
- **PipelineForegroundService**：`PARTIAL_WAKE_LOCK`（30 分钟超时，每 15 分钟续期），双通知渠道（ongoing低优先级 + done默认），Android 14+ 用 `FOREGROUND_SERVICE_TYPE_DATA_SYNC`
- 不做 LLM 调用、不读写数据库、不触碰密钥

#### TTS 模块四件套

- **TtsAudioModule**（911 行，最复杂）：
  - MediaPlayer 轨（云端 TTS）：`playAudioFile` 本地播放
  - 系统 TextToSpeech 轨：IDLE/INITIALIZING/READY/FAILED 四态机，8 秒初始化超时
  - utteranceId 编码：`shinewriter:{sessionId}:{index}:{total}`
  - 静态方法 `stopActivePlaybackFromForegroundService()`：通知栏"停止"按钮复用
- **TtsForegroundService**（317 行）：双阶段（PHASE_PREPARING → PHASE_PLAYING），AudioFocusRequest（AUDIOFOCUS_LOSS 直接停），MediaSession 注册 ACTION_STOP
- **TtsTextChunker**：切分优先级（连续空行 > 换行 > 中文句末 > 英文句末 > 分号 > 逗号 > 字符硬切，避免 UTF-16 高代理对中间切）

#### llamacpp/ 目录（12 文件）

| 文件 | 职责 |
|---|---|
| `LlamaCppModule.kt`（406 行） | 桥接层，继承 `NativeLlamaCppSpec`；耗时方法 `Thread{}.start()` |
| `LlamaCppEngine.kt`（263 行） | JNI 单例，5 个 external 方法；`MEMORY_SAFETY_FACTOR=1.05`；线程数 coerceIn(2,4)；`unload(timeoutMs=5000)` |
| `LlamaCppGenCallback.kt` | 顶层 class（必须 top-level，否则 R8 内联找不到 GetMethodID） |
| `LlamaCppPackage.kt` | BaseReactPackage，额外路由 `PlatformConstants → AndroidInfoModule`（P0-#1 workaround） |
| `LlamaCppForegroundService.kt` | 导入大文件防杀进程 |
| `LlamaCppEvents.kt` | 事件名常量 + 跨层数据类 |
| `LlamaCppErrors.kt` | 错误码常量（字符串值不可改） |
| `GgufValidator.kt` | 读前 8 字节：magic = `0x46554747`，version 2..3 |
| `ModelFileManager.kt` | 沙箱管理，canonicalPath 校验防穿越，SHA-256 流式计算 |
| `ModelImporter.kt` | 协程导入，64KB buffer，取消机制（cancelledImports set） |
| `LlamaCppNotification.kt` | channel `llamacpp_import` |
| `LlamaCppMemoryPressure.kt` | JS 事件名 `ShineWriterMemoryPressure` |

#### CoreTurboModuleBridge.kt（RN 0.85 Bridgeless + D8 workaround）

继承 `BaseReactPackage`，hard-code 4 个核心 module 的 `ReactModuleInfo`（PlatformConstants/SourceCode/DeviceEventManager/ExceptionsManager），解决 D8 strip `@ReactModule` 注解导致 `CoreReactPackage.fallbackForMissingClass()` 反射失败。

### 15.4 Android 工程配置

**SDK 与工具链**：compileSdk/targetSdk 36、minSdk 24、buildTools 36.0.0、NDK 27.1.12297006、Kotlin 2.1.20、ABI `arm64-v8a` + `x86_64`

**Maven 镜像**：阿里云三处（pluginManagement + buildscript + dependencies），修改时不能删

**签名**：
- Debug：固定 `debug.keystore`，password=`android`
- Release：4 个环境变量强校验（`SHINE_WRITER_RELEASE_STORE_FILE` / `_STORE_PASSWORD` / `_KEY_ALIAS` / `_KEY_PASSWORD`），缺任一 → `GradleException`

**CMake**：`-DANDROID_STL=c++_shared`；Windows MAX_PATH 修复（自动探测 `C:/Users/${user}/.local/bin/ninja.exe`）；顶层 project 必须命名 `appmodules`

**version.json 集成**：app/build.gradle 用 `JsonSlurper` 解析 version.json，`versionCode`/`versionName` 来自这里；`createBundle*JsAndAssets` task 显式 `inputs.file(version.json)` 防 stale JS bundle

**AndroidManifest.xml 关键**：
- 权限：INTERNET / FOREGROUND_SERVICE / FOREGROUND_SERVICE_DATA_SYNC / FOREGROUND_SERVICE_DATA_TRANSFER / FOREGROUND_SERVICE_MEDIA_PLAYBACK / POST_NOTIFICATIONS / WAKE_LOCK
- `READ/WRITE_EXTERNAL_STORAGE` 显式 `tools:node="remove"` 从子库剥离
- `allowBackup="false"`（备份走应用内 backupService）
- `extractNativeLibs="true"`
- MainActivity `launchMode="singleTop"` 配合 deep link
- 3 个前台服务：PipelineForegroundService（dataSync）/ TtsForegroundService（dataSync|mediaPlayback）/ LlamaCppForegroundService（dataSync）

### 15.5 Codegen 机制

1. TS spec：`src/native/specs/NativeLlamaCpp.ts`
2. package.json `codegenConfig`：`jsSrcsDir: "src"`、`android.javaPackageName: "com.shinewriter.specs"`
3. Gradle `autolinkLibrariesWithApp()` 触发 codegen → 生成 `NativeLlamaCppSpec` 抽象类 + C++ `ShineWriterSpec_ModuleProvider`
4. Kotlin 侧继承 `NativeLlamaCppSpec(reactContext)`
5. C++ 链接：`jni/CMakeLists.txt` 顶层 project 命名 `appmodules`

---

## 16. 数据库 Schema（22 张表）

| # | 表名 | 列 | restoreOrder | 职责 |
|---|---|---|---|---|
| 1 | `projects` | 5 | 10 | 项目主表（id=0 是全局工作区，mode: outline/freeform） |
| 2 | `chapters` | 13 | 20 | 章节（status: planned/draft/revision/final；summary_json、memory_summary） |
| 3 | `fragments` | 6 | 30 | 灵感片段（type: seed/generated/user/guided） |
| 4 | `plotlines` | 5 | 40 | 情节线（带颜色） |
| 5 | `project_plotlines` | 2 | 50 | 章节↔情节线多对多 |
| 6 | `characters` | 9 | 60 | 角色卡（source_type: json/png，data_json 存 CCv3） |
| 7 | `character_collections` | 7 | 65 | 角色合集 |
| 8 | `worldbook_collections` | 7 | 70 | 世界书合集 |
| 9 | `worldbook_entries` | 13 | 80 | 世界书条目（keyword_primary/secondary、constant、position） |
| 10 | `notes` | 8 | 90 | 笔记（max_tokens/estimated_tokens） |
| 11 | `presets` | 10 | 100 | 预设（is_default 单例） |
| 12 | `llm_config` | 11 | 110 | LLM 配置（api_key 字段保留但运行时为空，真实 key 在 Keystore） |
| 13 | `local_llm_models` | 21 | 115 | 本地 GGUF 模型（sha256 去重、性能指标、prompt_template） |
| 14 | `settings` | 2 | 120 | KV 设置（schema_version、context_*、pipeline_*、voice_config 等） |
| 15 | `project_resources` | 4 | 130 | **核心枢纽**：三元组 + enabled |
| 16 | `llm_usage_logs` | 12 | 140 | LLM 调用日志（scenario、token 三元组、llm_config_id） |
| 17 | `pipeline_tasks` | 11 | 150 | 管线任务持久化（stage_results JSON、final_text） |
| 18 | `freeform_documents` | 3 | 160 | 自由模式单文档 |
| 19 | `content_revisions` | 9 | 170 | 版本快照（source: manual_checkpoint/before_clear 等） |
| 20 | `generation_drafts` | 9 | 180 | AI 草稿（含 pipeline_task_id） |
| 21 | `project_note_config` | 7 | 190 | 项目级笔记配置（V1.7.0/schema 9） |
| 22 | `note_style_profiles` | 5 | 200 | 笔记风格画像（V1.7.0/schema 9） |

**所有 22 张表都标记 `backup: true`**，restoreOrder 决定恢复写入顺序。

### 16.1 迁移链（v3 → v14）

| 迁移 | 性质 | 关键变更 |
|---|---|---|
| v3→v4 | 数据回填 | characters/worldbook/notes/presets 全量回填到 project_resources |
| v4→v5 | 数据回填 | 默认 worldbook_collections「未分组/手动条目」 |
| v5→v6 | 建表 | content_revisions + 索引 |
| v6→v7 | 建表 | generation_drafts（含 pipeline_task_id） |
| v7→v8 | ALTER | llm_usage_logs 加 model_name/project_id |
| v8→v9 | 建表 | project_note_config + note_style_profiles |
| v9→v10 | ALTER | llm_usage_logs 加 llm_config_id/llm_config_name |
| v10→v11 | 建表+ALTER+回填 | character_collections + characters.collection_id |
| v11→v12 | 建表+多列 ALTER | local_llm_models 表 + llm_config 加 5 列（**重大架构升级**） |
| v12→v13 | ALTER+数据修正 | local_llm_models 加 prompt_template；清理 LiteRT-LM 残留 |
| v13→v14 | 条件 ALTER | project_note_config 加 retrieval_fragment_chars |

**幂等保证**：每条迁移最后固定 `INSERT OR REPLACE INTO settings(key='schema_version')`，配合条件式 ALTER 可断点续跑。

---

## 17. 安全机制

### 17.1 API Key 安全

- API Key 按 LLM 配置 id 分隔存到 Android Keystore（`com.shinewriter.llm.api-key.{configId}`）
- `accessible: ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY`（不跨设备同步）
- `llm_config` 表只存非密钥字段
- 备份不包含 Keystore
- 恢复后批量清理所有恢复配置的 key

### 17.2 网络安全

- HTTPS 默认放行
- HTTP 须 `allowInsecureLanHttp=true` 且 host 在私网白名单（127/8、10/8、172.16/12、192.168/16）
- 公网 HTTP 永远拒绝

### 17.3 路径安全

- `ModelFileManager.resolveModelPath` canonicalPath 校验防目录穿越
- 模型根目录：`context.filesDir/local_models/`

### 17.4 备份安全

- 三层脱敏（写入前 sanitizeBackupRow + 恢复时 redact + 恢复后 clearSecureLLMApiKey）
- 敏感字段识别（normalize 后比较）：`api_key / apikey / password / *_password / secret / authorization / bearer / token / *_token / credential / webdav_* / sync_*`

### 17.5 无 WebView / 无远程代码执行

---

## 18. 构建与发布

### 18.1 npm scripts

```json
{
  "prebuild": "node scripts/generate-version-json.js",
  "apk:debug": "npm run prebuild && node scripts/build-apk.js debug",
  "apk:release": "npm run prebuild && node scripts/build-apk.js release",
  "apk:release:minified": "npm run prebuild && node scripts/build-apk.js release --minify",
  "postinstall": "node scripts/patch-sqlite-storage-gradle.js && node scripts/patch-deps.js",
  "verify": "npm run lint && npm run typecheck && npm run test:ci"
}
```

### 18.2 版本生成（`generate-version-json.js`）

- **versionName**：`V${pkg.version}`（如 `V2.4.6`）
- **versionCode 公式**：`major*1_000_000 + minor*10_000 + patch*100 + build`（build 0..99）
- **build 来源**：`SHINE_WRITER_BUILD_NUMBER` > `GITHUB_RUN_NUMBER` > 同版本 previous > `'0'`
- 输出：`src/constants/version.json`（**不要手改**）

### 18.3 APK 构建（`build-apk.js`）

- 三向对齐校验（package.json + version.json + bundle 内嵌字符串）
- 跨平台 gradle 调用（Windows `cmd /d /c gradlew.bat`，其他 `./gradlew`）
- stale bundle 检测：读 `android/app/build/generated/assets/react/<variant>/index.android.bundle`，必须含 `V<ver>`
- **唯一交付路径**：`dist/apk/{debug|release}/ShineWriter-V<ver>-{debug|release}.apk`

### 18.4 postinstall patch

| 脚本 | 作用 |
|---|---|
| `patch-sqlite-storage-gradle.js` | sqlite-storage 的 `jcenter()` → `mavenCentral()` |
| `patch-deps.js` | keychain / svg 的 `compileSdkVersion safeExtGet` → `compileSdk safeExtGet`（AGP 9.x）；svg 的 `jcenter()` → `mavenCentral()` |

### 18.5 minify 开关

`enableReleaseMinification = project.findProperty("enableReleaseMinification")?.toBoolean() ?: false`（默认关闭，正式发布需真机矩阵验证 R8 反射路径）。

---

## 19. 测试体系

### 19.1 Jest 配置

- `jest.setup.js` mock 所有原生模块（sqlite-storage、fs、document picker、keychain、toast、safe-area-context、lucide 等）
- `transformIgnorePatterns` 白名单（新增 RN 原生依赖必须加包名，否则 ESM 转换失败）
- 当前白名单：react-native、@react-native、@react-navigation、react-native-screens、react-native-safe-area-context、lucide-react-native、react-native-svg、react-native-keychain、@react-native-documents/picker

### 19.2 覆盖率门禁

```
全局：branches 55 / functions 65 / lines 65 / statements 65
高阈值模块：database.ts、database/**、schema/**、migrations/**、backupService.ts
          branches 70 / lines 80
```

### 19.3 测试文件（`__tests__/`）

- 迁移测试夹具：`__tests__/fixtures/databases/schema-{3..13}.db`
- 迁移工具：`__tests__/migrationTestUtils.ts`（由 `scripts/generate-migration-fixtures.py` 生成，被 testPathIgnorePatterns 排除）
- 关键测试覆盖：pipelineRunner、pipelineMessages、contextBuilder、backupService、secureStorage、llm、migrations（全版本矩阵）

### 19.4 E2E

- `e2e/maestro/` 6 个 YAML：首启 / 写作生命周期 / 资料库 / 备份恢复 / LLM 配置 / 管线取消
- `e2e/fault-injection/` 故障注入定义

---

## 20. 关键设计模式与陷阱

### 20.1 设计模式总结

| 模式 | 应用 |
|---|---|
| **Facade** | `services/database.ts` 聚合所有 repositories |
| **Repository** | 13 个领域仓储，隐藏 SQL |
| **Strategy** | LLM Provider（openai_compatible / llama_cpp） |
| **Factory** | `providerRegistry` 静态映射表 |
| **Chain of Responsibility** | 迁移链（v3 → v4 → ... → v14） |
| **Observer** | AppState、pipelineTaskStore.subscribe、native event |
| **Singleton** | DB 连接、LlamaCppEngine、调度器 |
| **Mixin** | useChapter* hooks 组合 |

### 20.2 关键陷阱

#### react-native-sqlite-storage 的 async transaction 陷阱

> transaction 期望 callback **同步**执行所有 SQL，任何 await 都会让 transaction 被 finalize 触发 `InvalidStateError (DOM Exception 11)`。

**应对**：所有事务场景改成"先 async 读 → 收集语句数组 → 一次性同步 push"。

#### insertId 不可靠

> react-native-sqlite-storage 6.0.1 在部分机型/事务场景下 `result.insertId` 可能是 undefined 或 0。

**应对**：`saveLLMConfig` 用 `SELECT last_insert_rowid() AS id` 兜底。

#### setActiveLLMConfig 的非原子性

两个独立 `execute` 而非事务，"最坏情况是短暂的 全 is_active=0，下次 loadSettings 的自愈逻辑会兜底"。

#### Keystore ↔ SQLite 解耦

`hydrateLLMConfig` 流程：
1. 从 Keystore 读 key
2. id=1 且 Keystore 没有 → legacy 迁移（DB→Keystore）
3. DB 还有 api_key 但 Keystore 没有 → 迁移过去
4. **读完后立即清空 DB 的 api_key 字段**
5. 备份不含 Keystore

#### 冷启动自愈机制

多个层级：
- Schema 层：`validateSchemaBeforeStartup` 修复索引
- 数据层：`repairOversizedNotes` 拆分超大笔记
- 配置层：`getActiveLLMConfig` 降级激活
- 状态层：`markActiveTasksAsInterrupted` 中断未完成任务
- Store 层：`settingsStore.loadSettings` 自动激活

### 20.3 代码风格

- Prettier：`arrowParens: 'avoid'`、`singleQuote: true`、`trailingComma: 'all'`
- 所有数据操作通过 `services/database.ts` 或 `src/data/repositories/`
- 自动保存：章节编辑 900ms 防抖（`utils/debounce.ts`）
- 错误信息中文，通过 Toast 通知
- 导出格式：Markdown、纯文本（UTF-8 BOM）、`.tavo-novel.json`
- 导入格式：JSON 角色卡（CCv1/v2/v3）、世界书（lorebook_v3）、PNG 角色卡

### 20.4 工作目录卫生

仓库根目录有大量历史调试产物（`*.png`、`*.b64`、`shine_writer*.db`、`ui_*.xml`、`window_dump*.xml`、`logcat_*.log`、`emulator_*` 等），不是源码，不要误删或纳入提交。新增产物写到 `test-logs/` 等已存在临时目录。

---

## 附录：关键文件路径速查

### 入口与导航
- [index.js](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/index.js)
- [src/main/index.tsx](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/main/index.tsx)
- [src/navigation/TabNavigator.tsx](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/navigation/TabNavigator.tsx)
- [src/navigation/navigationRef.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/navigation/navigationRef.ts)

### 主题与组件
- [src/components/ThemeProvider.tsx](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/components/ThemeProvider.tsx)
- [src/components/ui.tsx](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/components/ui.tsx)
- [src/store/themeStore.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/store/themeStore.ts)
- [src/types/theme.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/types/theme.ts)
- [src/constants/defaults.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/constants/defaults.ts)

### 数据层
- [src/data/connection/openDatabase.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/data/connection/openDatabase.ts)
- [src/data/schema/initializeDatabase.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/data/schema/initializeDatabase.ts)
- [src/data/schema/createCurrentSchema.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/data/schema/createCurrentSchema.ts)
- [src/data/repositories/](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/data/repositories)
- [src/services/database.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/services/database.ts)

### 状态管理
- [src/store/projectStore.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/store/projectStore.ts)
- [src/store/settingsStore.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/store/settingsStore.ts)
- [src/store/pipelineTaskStore.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/store/pipelineTaskStore.ts)
- [src/store/localModelStore.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/store/localModelStore.ts)
- [src/store/voiceStore.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/store/voiceStore.ts)

### 业务服务
- [src/services/llm.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/services/llm.ts)
- [src/services/contextBuilder.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/services/contextBuilder.ts)
- [src/services/pipelineRunner.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/services/pipelineRunner.ts)
- [src/services/backupService.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/services/backupService.ts)
- [src/services/secureStorage.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/services/secureStorage.ts)
- [src/services/migrations/index.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/services/migrations/index.ts)

### LLM 子系统
- [src/services/llm/types.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/services/llm/types.ts)
- [src/services/llm/providerRegistry.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/services/llm/providerRegistry.ts)
- [src/services/llm/openAICompatibleProvider.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/services/llm/openAICompatibleProvider.ts)
- [src/services/llm/llamaCppProvider.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/services/llm/llamaCppProvider.ts)
- [src/services/llm/requestScheduler.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/services/llm/requestScheduler.ts)

### 原生模块
- [src/native/LlamaCppModule.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/native/LlamaCppModule.ts)
- [src/native/PipelineForegroundModule.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/native/PipelineForegroundModule.ts)
- [src/native/TtsAudioModule.ts](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/src/native/TtsAudioModule.ts)
- [android/app/src/main/java/com/shinewriter/](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/android/app/src/main/java/com/shinewriter)

### 构建脚本
- [scripts/build-apk.js](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/scripts/build-apk.js)
- [scripts/generate-version-json.js](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/scripts/generate-version-json.js)
- [package.json](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/package.json)

---

**文档完**

如有疑问或需要深入某个子系统，可参考 [AGENTS.md](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/AGENTS.md) 和 [README.md](file:///f:/ClaudeWorkSpace/projects/TAVO-MINI/README.md)。
