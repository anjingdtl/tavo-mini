# tavo-mini LiteRT-LM 本地离线模型接入开发 SPEC

> 文档状态：可执行开发规格  
> 版本：1.0  
> 日期：2026-07-09  
> 目标仓库：`anjingdtl/tavo-mini`  
> 目标平台：Android  
> 目标版本建议：V2.4.x  
> 主要目标设备：vivo X200 Pro  
> 读者：负责实施的编码 Agent、开发者、测试人员

---

## 1. 背景

`tavo-mini` 是一个基于 React Native + TypeScript 的移动端小说创作工作台，当前 AI 能力通过 OpenAI 兼容 HTTP API 调用。项目已经具备：

- 多 LLM 配置；
- OpenAI 兼容接口；
- 多阶段小说生成流水线；
- 流式展示与任务取消；
- SQLite 本地数据库；
- Kotlin 原生模块；
- Android 前台服务与 Wake Lock；
- 文档选择器；
- 本地优先的数据架构。

当前 LLM 配置结构只支持：

- Base URL；
- API Key；
-模型名称；
- 当前启用状态。

本次开发需要增加 LiteRT-LM 本地推理能力，使用户可以：

1. 自行下载 `.litertlm` 模型；
2. 在 tavo-mini 中选择该模型文件；
3. 由 Android 原生模块将模型复制到应用指定私有目录；
4. 校验并注册模型；
5. 通过 LiteRT-LM 直接离线推理；
6. 在现有 AI 流水线中选择并使用该本地模型。

---

## 2. 核心产品决策

### 2.1 本期采用的方案

用户自行获取 `.litertlm` 文件，tavo-mini 负责：

- 文件选择；
- 文件复制；
- 文件完整性校验；
- 模型加载验证；
- 本地模型注册；
- 模型切换；
- 模型推理；
- 模型删除；
- 运行状态和错误展示。

模型保存位置：

```text
/data/user/0/com.shinewriter/no_backup/models/
```

Kotlin 中必须通过以下方式动态获取，禁止硬编码绝对路径：

```kotlin
File(context.noBackupFilesDir, "models")
```

### 2.2 本期不建设模型商店

本期不实现：

- Hugging Face 登录；
- 应用内模型下载；
- 国内 CDN 模型分发；
- 在线模型目录；
- 自动更新模型；
- 模型许可证授权流程。

未来增加模型商店时，下载完成的文件必须复用本 SPEC 的统一导入流程。

### 2.3 只支持 `.litertlm`

第一版只允许导入：

```text
*.litertlm
```

明确不支持直接导入：

- `.gguf`
- `.safetensors`
- `.onnx`
- `.pth`
- `.pt`
- `.bin`
- 单独的 `.tflite`
- PyTorch 模型目录
- 压缩包

手机端不进行模型转换。

### 2.4 模型必须复制到应用私有目录

不允许 LiteRT-LM 长期直接使用文件选择器返回的 `content://` URI，也不允许依赖用户下载目录中的原始文件。

原因：

- URI 权限可能失效；
- 用户可能移动或删除原文件；
- 不同厂商文件管理器行为不一致；
- 云盘可能返回临时流；
- LiteRT-LM 使用稳定本地文件路径更可靠；
- 应用必须能够统一管理模型生命周期。

### 2.5 大文件不得经过 JavaScript 内存

禁止：

```ts
readFile(uri, 'base64')
```

禁止通过 React Native Bridge 传递模型二进制。

正确边界：

```text
React Native：只传递 content URI、文件名和用户操作
Kotlin：读取 URI、流式复制、SHA-256、加载模型、执行推理
```

---

## 3. 目标

### 3.1 功能目标

用户能够在没有网络的情况下：

- 导入合法 `.litertlm` 模型；
- 查看已导入模型列表；
- 测试模型是否能在当前手机运行；
- 将本地模型设为当前 AI 模型；
- 使用本地模型执行现有小说生成任务；
- 查看加载状态、首字延迟、生成速度和错误；
- 取消生成任务；
- 删除不再使用的模型。

### 3.2 兼容性目标

必须保证：

- 现有在线 OpenAI 兼容 API 不受影响；
- 原有数据库可无损升级；
- 原有 LLM 配置继续正常工作；
- 原有流水线调用方式尽量不改；
- 本地模型不可用时不影响 App 启动；
- LiteRT-LM 原生模块缺失或初始化失败时，在线模型仍可正常使用。

### 3.3 性能目标

首版参考目标，不作为所有机型的绝对保证：

- 1～3GB 模型导入过程不得 OOM；
- 导入期间 UI 不冻结；
- 导入进度更新间隔不高于 500ms 或每 8MB 一次；
- 已加载模型的生成 Token 能流式显示；
- 单次本地推理只允许一个活跃请求；
- 用户点击取消后，UI 应在 500ms 内停止接收和展示新 Token；
- 模型引擎、Conversation 和文件流必须可释放；
- App 重启后无需重新导入模型。

---

## 4. 非目标

本期明确不做：

1. vivo 系统内置大模型调用；
2. Android AICore / Gemini Nano；
3. 任意模型自动转换；
4. GGUF / llama.cpp 运行时；
5. 多本地模型同时驻留内存；
6. 本地模型并发生成；
7. NPU 通用自动适配；
8. 多模态输入；
9. Tool Calling；
10. 本地 Embedding；
11. 后台无限时长模型生成；
12. 自动判断模型真实参数规模；
13. 从模型文件中强依赖解析所有元数据；
14. iOS LiteRT-LM 集成。

---

## 5. 当前项目基线

实施前 Agent 必须确认仓库当前状态，不能基于旧版文件盲目修改。

截至本 SPEC 编写时，已确认：

- React Native：`0.85.3`
- React：`19.2.3`
- TypeScript：`5.8.x`
- Android minSdk：24
- Android compileSdk / targetSdk：36
- Kotlin：2.1.20
- 当前 App 包名：`com.shinewriter`
- 当前数据库 Schema：11
- 当前 LLM 服务：`src/services/llm.ts`
- 当前 LLM 设置页：`src/screens/LLMSettingsScreen.tsx`
- 当前 LLM 类型：`src/types/novel.ts`
- 当前设置 Store：`src/store/settingsStore.ts`
- 当前数据库入口：`src/services/database.ts`
- 当前迁移入口：`src/services/migrations/index.ts`
- 当前原生包注册：`android/app/src/main/java/com/shinewriter/MainApplication.kt`
- 已有原生模块模式：
  - `PipelineForegroundModule`
  - `PipelineForegroundPackage`
  - `TtsAudioPackage`
  - `PngMetadataPackage`
- 已安装文件选择器：
  - `@react-native-documents/picker`

Agent 开始开发前必须重新读取以上文件，若仓库已经变化，以当前代码为准调整实现。

---

## 6. 用户故事

### US-01 导入本地模型

作为用户，我可以在“AI 配置 → 本地离线模型”中点击“导入模型”，从手机存储中选择 `.litertlm` 文件。

### US-02 自动复制和校验

选择文件后，App 自动将模型复制到应用私有模型目录，显示进度，计算 SHA-256，并验证文件是否可被 LiteRT-LM 加载。

### US-03 后端自动检测

App 优先尝试 GPU；GPU 不可用或加载失败时自动尝试 CPU，并保存最终可用后端。

### US-04 本地模型配置

我可以使用已导入模型创建一个 LLM 配置，并将其设为当前配置，不需要填写 Base URL 和 API Key。

### US-05 离线生成

断网后，我仍可以使用本地模型执行支持的小说生成任务。

### US-06 模型管理

我可以查看模型名称、文件大小、校验状态、运行后端、加载耗时、生成速度和错误信息。

### US-07 删除模型

未在运行中的模型可以被删除；当前正在使用或已加载的模型必须先卸载或切换后再删除。

### US-08 错误提示

当用户选择 GGUF、损坏文件、NPU 专用不兼容模型或存储不足时，App 给出明确原因和处理建议。

---

## 7. 总体架构

```text
┌──────────────────────────────────────────────┐
│ React Native UI                              │
│ LLMSettingsScreen / LocalModelManagerScreen  │
└──────────────────────┬───────────────────────┘
                       │ URI / 配置 / 控制命令
┌──────────────────────▼───────────────────────┐
│ TypeScript 业务层                            │
│ localModelService / settingsStore            │
│ providerRegistry / localLiteRtLmProvider      │
└──────────────────────┬───────────────────────┘
                       │ NativeModules + Events
┌──────────────────────▼───────────────────────┐
│ Android Kotlin 原生层                        │
│ LocalLLMModule / ModelImporter / EngineManager│
└──────────────┬──────────────────┬────────────┘
               │                  │
┌──────────────▼──────────┐ ┌─────▼────────────┐
│ noBackupFilesDir/models │ │ LiteRT-LM Engine │
│ model.litertlm          │ │ GPU / CPU        │
└─────────────────────────┘ └──────────────────┘
```

### 7.1 设计原则

1. 在线模型和本地模型都实现统一 Provider 接口；
2. `callLLM()`、`callLLMResult()` 对上层调用方保持兼容；
3. 本地文件管理由 Kotlin 负责；
4. 模型业务记录由 SQLite 负责；
5. 本地引擎同一时间只加载一个模型；
6. 本地推理同一时间只运行一个任务；
7. 模型路径在数据库中保存相对路径，不保存写死的 `/data/user/0/...`；
8. 所有删除操作必须做目录边界校验；
9. 本地模型功能失败不得阻塞在线模型；
10. 本地 Provider 不使用 API Key。

---

## 8. 目录与文件规划

### 8.1 新增 TypeScript 文件

建议新增：

```text
src/
├── native/
│   └── LocalLLMModule.ts
├── services/
│   ├── localModels.ts
│   └── llm/
│       ├── types.ts
│       ├── providerRegistry.ts
│       ├── openAICompatibleProvider.ts
│       ├── localLiteRtLmProvider.ts
│       └── promptAdapter.ts
├── store/
│   └── localModelStore.ts
├── screens/
│   └── LocalModelManagerScreen.tsx
└── types/
    └── localModel.ts
```

可以继续保留 `src/services/llm.ts` 作为兼容门面，避免一次性修改所有调用方。

### 8.2 新增 Android 文件

建议新增：

```text
android/app/src/main/java/com/shinewriter/localllm/
├── LocalLLMPackage.kt
├── LocalLLMModule.kt
├── LocalModelImporter.kt
├── LocalModelFileManager.kt
├── LiteRtLmEngineManager.kt
├── LiteRtLmPromptAdapter.kt
├── LocalLLMEvents.kt
├── LocalLLMErrors.kt
├── LocalModelForegroundService.kt
└── LocalModelNotification.kt
```

如项目当前原生模块都位于 `com.shinewriter` 根包，也可以保持现有习惯，但建议使用 `com.shinewriter.localllm` 子包降低耦合。

### 8.3 模型目录

```text
noBackupFilesDir/
└── models/
    ├── .staging/
    │   └── <importId>.litertlm.tmp
    ├── <modelId>/
    │   ├── model.litertlm
    │   └── metadata.json
    └── <modelId>/
        ├── model.litertlm
        └── metadata.json
```

约束：

- `<modelId>` 使用 UUID；
- 正式模型文件统一命名为 `model.litertlm`；
- 原始文件名只写入数据库和 metadata；
- 导入中的文件只能位于 `.staging`；
- App 冷启动时清理超过 24 小时的 `.tmp` 文件；
- 任何文件操作都必须验证 canonical path 位于模型根目录内。

---

## 9. Android 依赖与构建

### 9.1 LiteRT-LM Gradle 依赖

在 `android/app/build.gradle` 增加 LiteRT-LM Android 依赖。

官方文档示例：

```gradle
implementation("com.google.ai.edge.litertlm:litertlm-android:latest.release")
```

项目中禁止长期使用 `latest.release`。

实施要求：

1. PoC 阶段可以临时解析最新版本；
2. 真机验证通过后必须锁定准确版本；
3. 在构建文件中定义单一版本常量；
4. SPEC 实施 PR 中记录最终锁定版本；
5. CI 必须使用同一版本；
6. 升级 LiteRT-LM 必须单独开 PR。

示例：

```gradle
def liteRtLmVersion = "经过真机验证的固定版本"
implementation("com.google.ai.edge.litertlm:litertlm-android:${liteRtLmVersion}")
```

### 9.2 GPU 原生库声明

在 `AndroidManifest.xml` 的 `<application>` 内增加：

```xml
<uses-native-library
    android:name="libvndksupport.so"
    android:required="false" />

<uses-native-library
    android:name="libOpenCL.so"
    android:required="false" />
```

禁止设置 `required="true"`，否则没有对应库的设备可能无法安装。

### 9.3 ABI

第一阶段必须至少验证：

```text
arm64-v8a
```

运行时能力检查：

```kotlin
Build.SUPPORTED_ABIS.contains("arm64-v8a")
```

不支持的 ABI：

- App 仍能安装和使用在线模型；
- 本地模型入口显示“当前设备架构暂不支持”；
- 不允许崩溃。

### 9.4 R8 / ProGuard

当前 release 构建未启用混淆，但仍应：

- 检查 LiteRT-LM 官方是否要求 keep 规则；
- 将必要规则写入 `proguard-rules.pro`；
- 不要只验证 debug 包；
- release APK 必须完成一次真机导入和推理测试。

---

## 10. 数据模型

### 10.1 LLM Provider 类型

新增：

```ts
export type LLMProviderType =
  | 'openai_compatible'
  | 'local_litertlm';
```

### 10.2 扩展 LLMConfig

建议修改为：

```ts
export interface LLMConfig {
  id: number;
  name: string;
  provider_type: LLMProviderType;

  // 在线 Provider
  base_url: string;
  api_key: string;

  // 通用字段
  model_name: string;
  is_active: number;

  // 本地 Provider
  local_model_id: string | null;
  local_backend: 'auto' | 'gpu' | 'cpu' | null;
  context_window: number;
  max_output_tokens: number;
}
```

兼容原则：

- 历史配置迁移后 `provider_type='openai_compatible'`；
- 历史 `base_url/api_key/model_name` 不改变；
- 本地配置 `base_url=''`、`api_key=''`；
- 本地配置必须绑定 `local_model_id`；
- `model_name` 对本地配置保存用户显示名称或模型标识；
- 本地配置验证不能要求 Base URL 和 API Key。

### 10.3 新增 LocalModel 类型

```ts
export type LocalModelStatus =
  | 'importing'
  | 'validating'
  | 'ready'
  | 'incompatible'
  | 'corrupted'
  | 'missing'
  | 'error';

export type LocalModelBackend =
  | 'auto'
  | 'gpu'
  | 'cpu'
  | 'npu';

export interface LocalModel {
  id: string;
  display_name: string;
  original_filename: string;
  relative_path: string;
  file_size: number;
  sha256: string;

  status: LocalModelStatus;
  backend_preference: LocalModelBackend;
  validated_backend: 'gpu' | 'cpu' | null;

  context_length: number | null;
  max_output_tokens: number | null;

  load_time_ms: number | null;
  first_token_ms: number | null;
  tokens_per_second: number | null;

  imported_at: string;
  last_used_at: string | null;
  last_validated_at: string | null;
  error_code: string | null;
  error_message: string | null;
}
```

### 10.4 SQLite 表

新增：

```sql
CREATE TABLE IF NOT EXISTS local_llm_models (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  file_size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL UNIQUE,

  status TEXT NOT NULL DEFAULT 'importing',
  backend_preference TEXT NOT NULL DEFAULT 'auto',
  validated_backend TEXT,

  context_length INTEGER,
  max_output_tokens INTEGER,

  load_time_ms INTEGER,
  first_token_ms INTEGER,
  tokens_per_second REAL,

  imported_at TEXT NOT NULL,
  last_used_at TEXT,
  last_validated_at TEXT,
  error_code TEXT,
  error_message TEXT
);
```

索引：

```sql
CREATE INDEX IF NOT EXISTS idx_local_llm_models_status
ON local_llm_models(status);

CREATE INDEX IF NOT EXISTS idx_local_llm_models_last_used
ON local_llm_models(last_used_at);
```

### 10.5 llm_config 表新增字段

```sql
ALTER TABLE llm_config
ADD COLUMN provider_type TEXT NOT NULL DEFAULT 'openai_compatible';

ALTER TABLE llm_config
ADD COLUMN local_model_id TEXT;

ALTER TABLE llm_config
ADD COLUMN local_backend TEXT;

ALTER TABLE llm_config
ADD COLUMN context_window INTEGER NOT NULL DEFAULT 4096;

ALTER TABLE llm_config
ADD COLUMN max_output_tokens INTEGER NOT NULL DEFAULT 4000;
```

注意：

- SQLite 对新增外键约束支持有限，本期不强制给 `local_model_id` 加物理外键；
- 删除模型前必须在业务层查询引用它的 LLM 配置；
- 在线配置默认 `max_output_tokens=4000`；
- 新建本地配置默认 `context_window=2048`、`max_output_tokens=512`。

### 10.6 Schema 迁移

新增：

```text
src/services/migrations/v11-to-v12.ts
```

修改：

```ts
export const SCHEMA_VERSION = 12;
```

迁移必须：

1. 创建 `local_llm_models`；
2. 给 `llm_config` 增加新字段；
3. 保证全部历史配置设为 `openai_compatible`；
4. 保留 API Key 的现有安全存储逻辑；
5. 新增 fresh install 的 `createTables()` 同步结构；
6. 新增迁移测试；
7. 新增从 Schema 11 升级的真实 SQLite 测试；
8. 遵守项目已有的 SQLite 事务限制，不得在 `transaction(async callback)` 中穿插不受控 `await`。

---

## 11. 原生模块接口

### 11.1 React Native 模块名

```text
LocalLLM
```

在 `MainApplication.kt` 中注册：

```kotlin
add(LocalLLMPackage())
```

### 11.2 TypeScript 接口

```ts
interface LocalLLMNative {
  getCapabilities(): Promise<LocalLLMCapabilities>;

  importModel(
    sourceUri: string,
    originalFilename: string,
    displayName: string,
  ): Promise<NativeImportResult>;

  validateModel(
    modelId: string,
    relativePath: string,
    backend: 'auto' | 'gpu' | 'cpu',
  ): Promise<NativeValidationResult>;

  loadModel(
    modelId: string,
    relativePath: string,
    backend: 'auto' | 'gpu' | 'cpu',
  ): Promise<NativeLoadResult>;

  generate(
    requestId: string,
    modelId: string,
    request: NativeGenerationRequest,
  ): Promise<void>;

  cancel(requestId: string): Promise<void>;

  unloadModel(): Promise<void>;

  deleteModelFiles(
    modelId: string,
    relativePath: string,
  ): Promise<void>;

  modelFileExists(relativePath: string): Promise<boolean>;

  cleanupStagingFiles(): Promise<number>;
}
```

### 11.3 能力返回值

```ts
interface LocalLLMCapabilities {
  available: boolean;
  androidApi: number;
  supportedAbis: string[];
  arm64Supported: boolean;
  gpuCandidate: boolean;
  cpuSupported: boolean;
  npuSupported: false;
  modelRootPath?: string;
  freeBytes: number;
  totalBytes: number;
  runtimeVersion?: string;
  unavailableReason?: string;
}
```

首版 `npuSupported` 固定为 `false`，避免给用户错误预期。

### 11.4 事件

使用 `DeviceEventEmitter` 或当前 RN 推荐事件方式发出：

```text
LocalLLMImportProgress
LocalLLMImportState
LocalLLMLoadState
LocalLLMToken
LocalLLMCompleted
LocalLLMError
LocalLLMBenchmark
```

事件结构：

```ts
interface LocalLLMTokenEvent {
  requestId: string;
  delta: string;
  sequence: number;
}

interface LocalLLMCompletedEvent {
  requestId: string;
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  elapsedMs: number;
  firstTokenMs?: number;
  tokensPerSecond?: number;
}

interface LocalLLMErrorEvent {
  requestId?: string;
  operation: 'import' | 'validate' | 'load' | 'generate' | 'delete';
  code: string;
  message: string;
  recoverable: boolean;
}
```

### 11.5 监听器生命周期

TypeScript Bridge 必须：

- 只注册一次全局监听；
- 按 `requestId/importId` 路由事件；
- Promise 完成后移除请求级回调；
- App 热重载时避免重复监听；
- 组件卸载时清理 UI 监听；
- 原生模块实现 `addListener/removeListeners`，避免 RN 警告。

---

## 12. 模型导入流程

### 12.1 文件选择器

使用现有：

```text
@react-native-documents/picker
```

要求：

- 单文件；
- 优先筛选 `.litertlm`；
- Android MIME 兼容性不足时允许 `application/octet-stream` 或 `*/*`；
- 选择后再次检查文件名扩展名；
- 用户取消不显示错误。

### 12.2 导入状态机

```text
idle
  ↓
selecting
  ↓
checking
  ↓
copying
  ↓
hashing（与复制同步）
  ↓
finalizing
  ↓
validating_gpu
  ↓ 失败
validating_cpu
  ↓
ready / incompatible / corrupted / error
```

### 12.3 导入前检查

Kotlin 层读取：

- `OpenableColumns.DISPLAY_NAME`
- `OpenableColumns.SIZE`
- 可读性
- 当前可用空间

规则：

1. 文件扩展名必须为 `.litertlm`，不区分大小写；
2. 文件大小为 0 时拒绝；
3. 大小未知时允许导入，但显示“文件大小未知”；
4. 已知大小时必须检查空间；
5. 建议保留空间：

```text
requiredFreeBytes = fileSize + max(512MB, fileSize * 20%)
```

6. 如果空间不足，导入前直接拒绝；
7. 不得根据用户提供的文件名创建目录；
8. 目录名只能使用应用生成的 UUID。

### 12.4 复制和 SHA-256

复制必须使用：

- `ContentResolver.openInputStream(uri)`
- 1MB 左右缓冲区；
- `Dispatchers.IO`
- 流式 `MessageDigest`
- 临时文件；
- 周期性进度事件。

禁止：

- `readBytes()`
- Base64
- 一次性分配文件大小内存
- JS 侧复制

复制伪代码：

```kotlin
val importId = UUID.randomUUID().toString()
val staging = File(stagingDir, "$importId.litertlm.tmp")
val digest = MessageDigest.getInstance("SHA-256")

resolver.openInputStream(uri).use { input ->
  requireNotNull(input)
  staging.outputStream().buffered(BUFFER_SIZE).use { output ->
    while (true) {
      ensureActive()
      val read = input.read(buffer)
      if (read < 0) break
      output.write(buffer, 0, read)
      digest.update(buffer, 0, read)
      emitProgress(...)
    }
    output.flush()
  }
}
```

建议对文件描述符执行同步写入，确保重命名前数据落盘。

### 12.5 去重

复制完成并得到 SHA-256 后：

- 查询 SQLite 是否已有同 SHA-256；
- 若已有：
  - 删除 staging 文件；
  - 返回现有模型；
  - UI 提示“该模型已经导入”；
- 若没有：
  - 创建 `<modelId>/`；
  - 将 staging 文件移动为 `model.litertlm`；
  - 写 metadata；
  - 插入数据库。

由于 Kotlin 原生层不直接访问 JS SQLite，推荐流程：

1. Native 完成复制并返回 SHA-256、临时/正式相对路径；
2. TS 查询数据库是否重复；
3. 若重复，调用 Native 删除新副本；
4. 若不重复，写入数据库；
5. 然后调用 Native 验证。

为了减少跨层复杂度，也允许在 Native 内维护轻量 manifest 去重，但 SQLite 仍必须作为业务真相源。

### 12.6 原子性

正式模型不得直接边复制边写。

必须：

```text
.staging/<importId>.tmp
       ↓ 完整复制 + flush + SHA-256
models/<modelId>/model.litertlm
```

失败时：

- 删除临时文件；
- 不写 ready 状态；
- 保留错误日志；
- App 下次启动清理孤儿 staging 文件。

### 12.7 metadata.json

示例：

```json
{
  "schemaVersion": 1,
  "id": "UUID",
  "displayName": "Qwen3 0.6B",
  "originalFilename": "qwen3_0_6b_mixed_int4.litertlm",
  "relativePath": "models/UUID/model.litertlm",
  "fileSize": 497664000,
  "sha256": "...",
  "importedAt": "2026-07-09T12:00:00.000Z"
}
```

metadata 只用于：

- 文件恢复；
- SQLite 丢失时重新扫描；
- 人工诊断。

SQLite 是模型状态的正式数据源。

---

## 13. LiteRT-LM 引擎管理

### 13.1 单例 Engine Manager

实现：

```text
LiteRtLmEngineManager
```

职责：

- 当前加载模型；
- 当前 Engine；
- 当前 Conversation；
- 当前生成 Job；
- 引擎 Mutex；
- 模型切换；
- 资源释放；
- 内存压力处理；
- 运行指标。

状态：

```kotlin
sealed interface EngineState {
  data object Unloaded
  data class Loading(val modelId: String)
  data class Ready(val modelId: String, val backend: String)
  data class Generating(val modelId: String, val requestId: String)
  data class Error(val modelId: String?, val code: String)
}
```

### 13.2 后端策略

首版支持：

```text
auto
gpu
cpu
```

`auto`：

1. 尝试 GPU；
2. GPU 初始化失败，记录完整错误；
3. 释放失败引擎；
4. 尝试 CPU；
5. CPU 成功后保存 `validated_backend=cpu`；
6. 两者都失败，模型标记 incompatible。

不得自动尝试 NPU。

### 13.3 Engine 初始化

官方 Kotlin API的核心方式：

```kotlin
val engineConfig = EngineConfig(
  modelPath = absoluteModelPath,
  backend = Backend.GPU(),
  cacheDir = context.cacheDir.path,
)

val engine = Engine(engineConfig)
engine.initialize()
```

要求：

- 初始化必须在后台协程；
- 初始化最长时间不能使用过短的 HTTP 风格超时；
- UI 显示“模型加载中”；
- 初始化失败必须关闭 Engine；
- 切换模型前必须关闭旧 Engine；
- App 退出或原生模块销毁时必须关闭 Engine；
- 不得在 Activity 中持有 Engine；
- 使用 Application Context。

### 13.4 缓存目录

使用：

```kotlin
File(context.cacheDir, "litertlm")
```

允许系统清理缓存。

模型本体不得存入 `cacheDir`。

### 13.5 Conversation

每次业务请求建议创建独立 Conversation：

```kotlin
engine.createConversation(config).use { conversation ->
  ...
}
```

原因：

- 避免不同小说任务串上下文；
- 方便取消；
- 方便释放；
- 与现有每次请求独立的 HTTP 模型语义一致。

首版不做跨请求持久对话。

### 13.6 消息映射

现有消息：

```ts
type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};
```

映射要求：

- 第一条或全部 system 消息合并为 `systemInstruction`；
- 历史 user/assistant 消息转换为 `initialMessages`；
- 最后一条 user 消息作为当前发送内容；
- 若最后一条不是 user，Prompt Adapter 必须构造明确输入；
- 保留消息顺序；
- 不把 JSON 对象直接 `toString()`；
- 中文文本保持 UTF-8；
- 对不支持复杂历史格式的模型，提供纯文本 fallback Prompt。

新增：

```text
LiteRtLmPromptAdapter.kt
src/services/llm/promptAdapter.ts
```

TS 负责业务级上下文裁剪；Kotlin 负责 LiteRT-LM 对象转换。

### 13.7 采样参数

从现有配置映射：

- temperature
- top_p
- max_tokens

本地模型安全默认：

```text
temperature = 0.8
topP = 0.9
maxOutputTokens = 512
contextWindow = 2048
```

首版强制上限建议：

```text
maxOutputTokens <= 2048
```

用户配置超过上限时：

- UI 阻止；
- Provider 再次 clamp；
- Native 层第三次防御。

### 13.8 上下文裁剪

本地模型不能照搬在线大上下文。

在请求进入 Native 前：

1. 根据配置的 `context_window` 计算预算；
2. 使用项目现有 Token 估算器；
3. 预留输出 Token；
4. 优先保留：
   - system 指令；
   - 最新用户请求；
   - 最近上下文；
   - 必要人物/世界书资料；
5. 超预算时调用现有上下文策略裁剪；
6. 不允许把明显超预算请求直接交给本地模型。

公式：

```text
inputBudget =
contextWindow
- maxOutputTokens
- safetyMargin
```

建议：

```text
safetyMargin = max(128, contextWindow * 5%)
```

### 13.9 流式生成

使用 LiteRT-LM Coroutine Flow 异步接口。

逻辑：

```kotlin
conversation.sendMessageAsync(input)
  .catch { emitError(...) }
  .collect { message ->
    emitTokenDelta(...)
  }
```

需要先确认当前锁定版本返回的是增量 Token 还是累计 Message。

如果返回累计文本：

- Native 必须计算 delta；
- 只把新增文本发给 JS；
- 防止 UI 重复拼接。

### 13.10 取消

取消策略：

1. 每个 requestId 对应一个 Coroutine Job；
2. `cancel(requestId)` 执行 Job.cancel；
3. 立即把 requestId 标记 cancelled；
4. 后续 Native Token 全部丢弃；
5. 关闭当前 Conversation；
6. 若当前 LiteRT-LM 版本不能真正中断底层推理：
   - UI 仍立即停止；
   - 底层完成后清理；
   - 不把结果写入业务；
   - 日志记录 `soft_cancel`；
7. 不允许取消一个请求影响另一个 requestId；
8. 首版只有一个本地并发请求。

PoC 阶段必须验证 LiteRT-LM 当前版本的真实取消语义，并将结果写入 PR 说明。

### 13.11 并发

本地 Provider：

```text
concurrency = 1
```

当已有本地任务运行时，新任务：

- 进入 FIFO 队列，或
- 返回 `LOCAL_MODEL_BUSY`。

为了与现有流水线兼容，推荐 FIFO 队列，最大排队数量建议为 4。

如果用户主动从 UI 发起第二个大型任务，应显示：

```text
本地模型正在处理其他任务，已加入队列。
```

---

## 14. Provider 层改造

### 14.1 目标

现有上层继续调用：

```ts
callLLM()
callLLMResult()
testLLMConnection()
resolveLLMRequestConfig()
```

内部根据 `provider_type` 路由。

### 14.2 Provider 接口

```ts
export interface LLMProvider {
  readonly type: LLMProviderType;

  test(config: ResolvedLLMConfig): Promise<string>;

  generate(
    messages: ChatMessage[],
    options: LLMGenerateOptions,
    signal?: AbortSignal,
  ): Promise<LLMResult>;
}
```

### 14.3 Online Provider

把当前 `src/services/llm.ts` 中：

- URL 规范化；
- fetch；
- HTTP 错误格式化；
- usage 解析；
- DeepSeek reasoning_content 兼容；

移动到：

```text
openAICompatibleProvider.ts
```

行为必须不变。

### 14.4 Local Provider

`localLiteRtLmProvider.ts` 负责：

1. 检查模型记录；
2. 检查模型文件存在；
3. 检查 status=ready；
4. 处理本地配置；
5. 进行上下文裁剪；
6. 调用 Native load；
7. 发起 generate；
8. 收集 Token；
9. 映射取消信号；
10. 生成 `LLMResult`；
11. 写 usage 日志；
12. 更新模型 `last_used_at`；
13. 记录性能。

### 14.5 RequestConfig

扩展：

```ts
export interface LLMRequestConfig {
  id?: number;
  name?: string;
  provider_type: LLMProviderType;

  api_key: string;
  model_name: string;
  url: string;

  local_model_id?: string;
  local_model_path?: string;
  local_backend?: 'auto' | 'gpu' | 'cpu';
  context_window?: number;
  max_output_tokens?: number;
}
```

在线配置仍使用 `url`；本地配置不读取 `url`。

### 14.6 配置错误

在线配置缺失提示：

```text
请填写 API 地址、API Key 和模型名称。
```

本地配置缺失提示：

```text
请选择一个已经导入且验证可用的本地模型。
```

不得继续统一要求 API Key。

---

## 15. UI 设计

### 15.1 LLM 设置页

在现有 LLM 配置编辑区域增加模型来源：

```text
模型来源

[ 在线 API ] [ 本地离线模型 ]
```

在线 API 时显示：

- 配置名称；
- Base URL；
- API Key；
- 模型名称。

本地离线模型时显示：

- 配置名称；
- 已导入模型选择器；
- 后端：自动 / GPU / CPU；
- 上下文长度；
- 最大输出 Token；
- “管理本地模型”入口；
- “保存并测试”。

### 15.2 本地模型管理页

新增页面：

```text
本地离线模型
```

顶部：

```text
模型保存在应用私有目录。
卸载应用或清除应用数据会删除已导入模型。

[ 导入 .litertlm 模型 ]
```

模型卡片：

```text
Qwen3 0.6B
qwen3_0_6b_mixed_int4.litertlm

大小：475 MB
状态：可用
运行后端：GPU
加载耗时：6.8 秒
速度：22.4 Token/s

[测试] [创建 AI 配置] [删除]
```

### 15.3 导入进度

```text
正在导入模型

Qwen3 0.6B
842 MB / 1.58 GB
53%

[取消导入]
```

状态文案：

- 正在检查文件；
- 正在复制；
- 正在校验完整性；
- 正在尝试 GPU；
- GPU 不可用，正在尝试 CPU；
- 模型可用；
- 模型与当前设备不兼容。

### 15.4 格式错误

用户选择 `.gguf`：

```text
无法导入该模型

你选择的是 GGUF 模型，LiteRT-LM 无法直接运行。

请选择扩展名为 .litertlm 的模型文件。
```

### 15.5 存储不足

```text
存储空间不足

模型大小：1.58 GB
导入所需可用空间：2.09 GB
当前可用空间：1.12 GB

请释放空间后重试。
```

### 15.6 删除确认

```text
删除本地模型？

删除后需要重新导入才能使用。
原始下载文件不会被删除。

[取消] [删除]
```

如果存在配置引用：

```text
该模型正在被 2 个 AI 配置使用。

请先切换或删除这些配置。
```

### 15.7 当前模型删除

如果模型是当前启用配置：

- 禁止直接删除；
- 提示先切换模型；
- 不自动静默切换。

---

## 16. 前台服务与后台行为

模型导入可能持续较长时间，应新增独立前台服务：

```text
LocalModelForegroundService
```

不要把模型导入语义硬塞进 `PipelineForegroundService`。

可复用：

- 通知 Channel 创建逻辑；
- Wake Lock 封装；
- 通知权限检测；
- 进度通知风格。

通知示例：

```text
正在导入本地模型
842 MB / 1.58 GB · 53%
```

服务要求：

- Android 8+ 使用前台服务；
- Android 13+ 尊重通知权限；
- 没有通知权限时，前台导入仍可执行，但 UI 必须提示不要切后台；
- 导入完成或失败必须停止服务；
- 释放 Wake Lock；
- App 崩溃后不得永久残留通知；
- 服务不持有 React Activity。

第一版本地生成可以继续复用现有流水线前台保活；模型文件导入使用独立服务。

---

## 17. 错误码

统一错误码：

```text
LOCAL_LLM_UNAVAILABLE
UNSUPPORTED_ABI
UNSUPPORTED_FILE_TYPE
SOURCE_URI_UNREADABLE
SOURCE_FILE_EMPTY
SOURCE_SIZE_UNKNOWN
INSUFFICIENT_STORAGE
IMPORT_CANCELLED
IMPORT_COPY_FAILED
IMPORT_INCOMPLETE
HASH_FAILED
DUPLICATE_MODEL
MODEL_FILE_MISSING
MODEL_FILE_OUTSIDE_ROOT
MODEL_CORRUPTED
MODEL_INCOMPATIBLE
GPU_INIT_FAILED
CPU_INIT_FAILED
ENGINE_INIT_FAILED
ENGINE_NOT_READY
ENGINE_BUSY
MODEL_LOAD_CANCELLED
GENERATION_FAILED
GENERATION_CANCELLED
DELETE_BLOCKED
DELETE_FAILED
NATIVE_MODULE_MISSING
RUNTIME_VERSION_MISMATCH
```

要求：

- Native 返回稳定 code；
- TS 根据 code 映射中文文案；
- 日志保留底层异常；
- UI 不直接展示大段 JNI Stack Trace；
- Debug 诊断页可以展示详细错误。

---

## 18. 安全要求

### 18.1 路径安全

删除或加载前：

```kotlin
val root = modelsRoot.canonicalFile
val target = requestedFile.canonicalFile

require(target.path.startsWith(root.path + File.separator))
```

禁止使用来自 JS 的任意绝对路径直接删除文件。

JS 只传：

- modelId；
- relativePath。

Native 重新拼接并校验。

### 18.2 文件安全

- 不执行模型文件；
- 不自动解压；
- 不读取任意外部相邻文件；
- 不信任原始文件名；
- 不根据模型内部元数据创建路径；
- 不把模型上传到网络；
- 不记录模型内容；
- SHA-256 仅用于完整性和去重。

### 18.3 隐私

本地 Provider：

- 不发起网络请求；
- 不要求 API Key；
- UI 显示“完全离线运行”；
- 诊断日志不得记录完整小说正文；
- Token 日志只记录数量和错误，不记录正文。

### 18.4 API Key

现有在线 API Key 安全存储逻辑必须保留。

本地配置不得创建无意义的 Keychain 条目。

---

## 19. 生命周期与恢复

### 19.1 App 启动

启动时：

1. 初始化数据库；
2. 清理过期 staging 文件；
3. 扫描数据库中的本地模型；
4. 检查每个 relativePath 是否存在；
5. 文件缺失则标记 `missing`；
6. 不自动加载模型；
7. 仅在首次调用或用户测试时加载。

### 19.2 App 进入后台

- 正在导入：依赖 LocalModelForegroundService；
- 正在生成：依赖现有 PipelineForegroundService；
- 没有任务时可保留 Engine 一段时间；
- 可配置空闲 5 分钟后自动 unload；
- 收到系统内存压力时立即 unload 非活跃 Engine。

### 19.3 内存压力

Android 侧实现：

- `ComponentCallbacks2`
- `onTrimMemory`
- `onLowMemory`

规则：

- 非生成状态：立即 unload；
- 生成状态：记录内存压力并在完成后 unload；
- `TRIM_MEMORY_COMPLETE` 等高等级压力时允许中止本地任务并返回明确错误；
- 不影响在线模型配置。

### 19.4 App 更新

模型位于 `noBackupFilesDir`：

- 普通 APK 更新保留；
- App 卸载删除；
- 清除应用数据删除；
- 云备份不包含模型。

UI 必须明确提示这一点。

---

## 20. 使用量与诊断

现有 `llm_usage_logs` 继续使用。

本地模型日志：

- `model_name`
- `llm_config_id`
- `llm_config_name`
- input tokens 估算值；
- output tokens 运行时返回或估算值；
- status；
- error_code；
- scenario；
- project_id。

新增诊断字段可存 `local_llm_models`：

- load_time_ms；
- first_token_ms；
- tokens_per_second；
- validated_backend；
- last_validated_at。

诊断页建议显示：

```text
LiteRT-LM Runtime：可用
设备 ABI：arm64-v8a
OpenCL：候选可用
当前模型：Qwen3 0.6B
后端：GPU
Engine：Ready
模型文件：存在
加载耗时：6.8s
首字延迟：1.4s
速度：22.4 tok/s
```

---

## 21. 测试模型

开发和 CI 不应把数 GB 模型提交到 Git。

测试分为：

### 21.1 单元测试

不依赖真实模型：

- Provider 路由；
- 配置验证；
- 数据库迁移；
- 本地模型 CRUD；
- 相对路径校验；
- 错误码映射；
- 状态机；
- Token delta 计算；
- 取消逻辑；
- 上下文裁剪；
- 在线配置回归。

### 21.2 Android JVM 测试

- SHA-256；
- staging 文件命名；
- canonical path 防越界；
- metadata 序列化；
- free space 计算；
- 进度节流；
- 删除目录保护。

### 21.3 Android Instrumentation

使用测试文件或小型有效模型：

- `content://` 输入流复制；
- 取消导入；
- 文件复制完整；
- App 重启后模型仍存在；
- staging 恢复清理；
- 原生事件；
- 前台服务生命周期。

### 21.4 真机测试

至少：

1. vivo X200 Pro；
2. 一台无 OpenCL 或 GPU 初始化失败设备；
3. 一台 6～8GB RAM 中端机；
4. Android 13/14/15/16 中至少两代；
5. Release APK。

模型建议：

- 一个小型通用 `.litertlm`；
- 一个损坏文件；
- 一个改后缀伪装文件；
- 一个不兼容模型；
- 一个 1GB 以上模型。

### 21.5 网络隔离测试

开启飞行模式：

- App 正常启动；
- 本地模型配置可测试；
- 本地生成成功；
- 不发生 fetch；
- 在线配置显示网络错误；
- 本地生成内容进入现有结果流程。

---

## 22. 测试用例

### TC-01 有效模型导入

前置：

- 有足够空间；
- 有有效 `.litertlm`。

结果：

- 复制成功；
- SHA-256 有值；
- 路径位于 noBackupFilesDir；
- 数据库状态 ready；
- 原始下载文件保持不变。

### TC-02 错误扩展名

选择 `.gguf`。

结果：

- 不开始复制；
- 明确提示只支持 `.litertlm`。

### TC-03 伪装文件

将随机文件重命名为 `.litertlm`。

结果：

- 可以进入复制；
- LiteRT-LM 初始化失败；
- 标记 corrupted 或 incompatible；
- 不允许设为当前模型。

### TC-04 存储不足

结果：

- 复制前拦截；
- 显示所需和当前空间；
- 不产生 staging 残留。

### TC-05 中途取消

结果：

- 500ms 内 UI 停止；
- 临时文件删除；
- 前台服务停止；
- 数据库无 ready 模型。

### TC-06 App 被杀后恢复

导入中强制停止 App。

结果：

- 下次启动识别并清理 staging；
- 不显示残缺模型。

### TC-07 GPU 回退 CPU

GPU 初始化失败，CPU 成功。

结果：

- 状态 ready；
- validated_backend=cpu；
- UI 显示 CPU；
- 可正常生成。

### TC-08 重复模型

再次导入相同文件。

结果：

- SHA-256 去重；
- 不保留第二份文件；
- 返回已有模型。

### TC-09 离线生成

飞行模式使用本地模型。

结果：

- 生成成功；
- 现有流水线正常；
- usage log 正常。

### TC-10 在线模型回归

使用原有 DeepSeek/OpenAI 兼容配置。

结果：

- 保存、测试、激活、生成行为不变。

### TC-11 删除被引用模型

结果：

- 删除被阻止；
- 显示引用配置数量。

### TC-12 模型文件被外部破坏

通过调试手段删除或破坏私有文件。

结果：

- 启动检查标记 missing/corrupted；
- 不崩溃；
- 不允许生成。

---

## 23. 验收标准

以下条件全部满足才可完成：

### 23.1 导入

- [ ] 用户能从 Android 文件选择器选择 `.litertlm`；
- [ ] 文件由 Kotlin 流式复制；
- [ ] 不经过 JS Base64；
- [ ] 导入路径为 `noBackupFilesDir/models`；
- [ ] 使用临时文件和原子完成流程；
- [ ] 有实时进度；
- [ ] 支持取消；
- [ ] 计算 SHA-256；
- [ ] 支持去重；
- [ ] 空间不足可提前拦截；
- [ ] App 异常退出后可清理残留。

### 23.2 模型运行

- [ ] 可从私有目录加载模型；
- [ ] GPU 优先；
- [ ] GPU 失败自动回退 CPU；
- [ ] 模型验证失败不影响 App；
- [ ] Token 可流式显示；
- [ ] 支持取消；
- [ ] 生成完成后资源可释放；
- [ ] 飞行模式下可生成。

### 23.3 Provider

- [ ] `provider_type` 正确路由；
- [ ] 本地配置不需要 URL 和 API Key；
- [ ] 在线 Provider 行为无回归；
- [ ] 现有流水线无需大规模重写；
- [ ] usage 日志可区分本地模型。

### 23.4 数据

- [ ] Schema 11 可升级到 12；
- [ ] 历史 LLM 配置全部保留；
- [ ] 模型列表重启后仍存在；
- [ ] 文件缺失可自愈标记；
- [ ] 删除模型不会越界删除其他文件。

### 23.5 UI

- [ ] LLM 配置可选择在线/本地；
- [ ] 有本地模型管理页；
- [ ] 错误提示明确；
- [ ] 显示大小、状态、后端和性能；
- [ ] 当前被使用模型不能误删；
- [ ] 卸载 App 删除模型的提示清晰。

### 23.6 质量

- [ ] `npm test` 全绿；
- [ ] `npm run lint` 全绿；
- [ ] Android debug 构建成功；
- [ ] Android release 构建成功；
- [ ] vivo X200 Pro 真机验收通过；
- [ ] 不把模型文件提交到 Git；
- [ ] 不使用 `latest.release` 合入正式分支；
- [ ] README 和 CHANGELOG 已更新。

---

## 24. 分阶段实施

## Phase 0：技术验证 Spike

目标：先证明 LiteRT-LM 在当前 RN/Gradle/Kotlin 工程和 vivo X200 Pro 上可运行。

任务：

1. 新建实验分支；
2. 增加 LiteRT-LM 依赖；
3. 增加 GPU native library 声明；
4. 写最小 Kotlin 测试入口；
5. 从固定私有路径加载一个已知有效 `.litertlm`；
6. 完成一次中文生成；
7. 记录：
   - LiteRT-LM 固定版本；
   - APK 增量；
   - ABI；
   - GPU 是否成功；
   - CPU 是否成功；
   - 加载耗时；
   - 首字延迟；
   - Token/s；
   - 取消语义；
   - 内存峰值；
   - Release 包结果。

Go 条件：

- 至少 CPU 可运行；
- Release APK 可运行；
- 无持续崩溃；
- 引擎可关闭；
- 中文生成可返回。

No-Go 条件：

- 当前依赖与项目工具链根本冲突；
- arm64 Release 无法加载；
- 引擎无法释放导致稳定 OOM；
- 可用模型无法运行。

Phase 0 完成前，不进入大规模 UI 和数据库开发。

## Phase 1：Provider 重构

任务：

1. 增加 `provider_type`；
2. 抽取 Online Provider；
3. 保持 `llm.ts` 兼容门面；
4. 增加 Provider Registry；
5. 增加测试；
6. 确保在线模型回归通过。

## Phase 2：数据库和模型管理

任务：

1. Schema 12；
2. `local_llm_models`；
3. 本地模型 Store；
4. CRUD；
5. 文件存在检查；
6. staging 清理；
7. 迁移测试。

## Phase 3：Native Import

任务：

1. LocalLLMPackage；
2. LocalLLMModule；
3. 文件复制；
4. SHA-256；
5. 进度事件；
6. 取消；
7. 空间检查；
8. 路径保护；
9. 前台服务。

## Phase 4：LiteRT-LM Engine

任务：

1. Engine Manager；
2. GPU/CPU；
3. validate；
4. load/unload；
5. Conversation；
6. streaming；
7. cancel；
8. benchmark；
9. 生命周期。

## Phase 5：UI

任务：

1. 模型来源切换；
2. 本地模型管理页；
3. 导入弹窗；
4. 进度；
5. 模型卡片；
6. 错误提示；
7. 删除；
8. 创建本地配置；
9. 保存并测试。

## Phase 6：流水线集成

任务：

1. Local Provider；
2. 消息映射；
3. 上下文裁剪；
4. usage；
5. 流式结果；
6. 取消；
7. 队列；
8. 飞行模式测试。

## Phase 7：稳定性与发布

任务：

1. X200 Pro 真机长测；
2. 内存压力；
3. 后台；
4. Release；
5. 文档；
6. CHANGELOG；
7. 清理调试代码；
8. 固定依赖版本。

---

## 25. 建议提交拆分

```text
chore(android): add pinned LiteRT-LM runtime dependency
refactor(llm): introduce provider registry
feat(db): add local model registry and schema v12
feat(android): add local model streaming importer
feat(android): add LiteRT-LM engine manager
feat(local-llm): add local model provider
feat(ui): add local model management screen
feat(settings): support local LiteRT-LM configs
feat(pipeline): route generation to local provider
test(local-llm): cover import provider and migration
docs: document local model import and limitations
```

禁止一个巨型提交同时完成全部功能。

---

## 26. Agent 实施规则

负责开发的 Agent 必须遵守：

1. 开工前读取当前仓库，不假设文件未变化；
2. 先完成 Phase 0；
3. 每阶段运行测试；
4. 不修改与本功能无关的 UI；
5. 不删除现有在线 LLM 能力；
6. 不重写整个流水线；
7. 不引入第二套数据库；
8. 不在 JS 中处理模型二进制；
9. 不硬编码 `/data/user/0/com.shinewriter`；
10. 不使用用户文件名作为目录；
11. 不默认开启 NPU；
12. 不把模型打入 APK；
13. 不提交模型文件；
14. 不把 `latest.release` 合入正式分支；
15. 所有原生异常映射为稳定错误码；
16. 所有 Engine/Conversation/Stream 必须在 finally 或 use 中释放；
17. 对每个新增 public 方法增加注释；
18. 对关键状态机增加测试；
19. 改数据库时同时维护 fresh install 和 migration；
20. 最终提交一份真机验证报告。

---

## 27. 真机验证报告模板

```markdown
# LiteRT-LM 真机验证报告

## 环境

- 设备：
- SoC：
- RAM：
- Android / OriginOS：
- App 版本：
- LiteRT-LM 版本：
- APK 类型：debug / release
- 模型：
- 模型大小：

## 导入

- 导入耗时：
- 最大内存：
- SHA-256：
- 取消测试：
- 后台测试：

## GPU

- 初始化：成功/失败
- 加载耗时：
- 首字延迟：
- Token/s：
- 错误：

## CPU

- 初始化：成功/失败
- 加载耗时：
- 首字延迟：
- Token/s：
- 错误：

## 生命周期

- 切换模型：
- 取消生成：
- App 切后台：
- App 重启：
- 内存压力：
- 删除模型：

## 结论

- 默认后端：
- 已知问题：
- 是否满足发布条件：
```

---

## 28. README 用户说明

发布后 README 至少增加：

### 支持的模型格式

```text
仅支持 LiteRT-LM 的 .litertlm 模型。
不支持 GGUF、Safetensors、ONNX 或普通 TFLite 文件。
```

### 模型存储

```text
导入后，模型会被复制到 tavo-mini 的应用私有目录。
删除原始下载文件不会影响已导入模型。
卸载 tavo-mini 或清除应用数据会删除已导入模型。
```

### 性能说明

```text
本地模型速度和内存占用取决于手机、模型大小、量化方式和运行后端。
较大的模型可能导致发热、耗电或系统回收。
```

### 隐私说明

```text
使用本地模型时，小说正文和提示词不会发送到在线模型服务。
```

---

## 29. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| LiteRT-LM API快速变化 | 编译或运行异常 | 固定版本，升级单独 PR |
| GPU/OpenCL 厂商差异 | GPU 初始化失败 | 自动回退 CPU |
| 模型格式不兼容 | 无法加载 | 实际初始化验证，明确提示 |
| 大模型 OOM | App 崩溃 | 单引擎、单并发、内存压力卸载 |
| URI 读取失败 | 导入失败 | 原生 InputStream、错误码 |
| 复制中断 | 残缺模型 | staging + 原子完成 + 冷启动清理 |
| JS Bridge 过载 | 卡顿/OOM | 二进制不经过 JS，事件节流 |
| 本地模型上下文较小 | 生成失败/质量下降 | 独立上下文预算和裁剪 |
| 用户误删当前模型 | 配置失效 | 引用检查和删除阻止 |
| Release 与 Debug 行为差异 | 上线崩溃 | Release 真机验收 |
| 模型文件占用空间大 | 用户投诉 | 导入前显示大小与空间 |
| 取消不真正停止底层 | 发热继续 | Job cancel、丢弃 Token、完成后释放 |

---

## 30. 最终交付物

开发 Agent 最终必须交付：

1. 可编译代码；
2. Schema 12 迁移；
3. LiteRT-LM 固定依赖版本；
4. Native Import 模块；
5. Engine Manager；
6. Local Provider；
7. 本地模型管理 UI；
8. LLM 设置页本地模型支持；
9. 现有流水线集成；
10. 自动化测试；
11. X200 Pro 真机报告；
12. README；
13. CHANGELOG；
14. 已知限制列表；
15. Release APK 构建结果。

---

## 31. 官方技术依据

LiteRT-LM Android：

https://developers.google.com/edge/litert-lm/android

关键依据：

- Kotlin Android API；
- `EngineConfig(modelPath=...)`；
- GPU/CPU/NPU Backend；
- Engine 初始化应在后台线程；
- `sendMessageAsync` 流式输出；
- Android GPU native library 声明；
- Engine 和 Conversation 需要关闭。

LiteRT-LM `.litertlm` 容器：

https://developers.google.com/edge/litert-lm/file_builder

关键依据：

- `.litertlm` 是统一容器；
- 包含 TFLite 模型、Tokenizer、外部权重和元数据；
- 原始 PyTorch 模型需要先转换，不属于手机端导入范围。

Android Storage Access Framework：

https://developer.android.com/training/data-storage/shared/documents-files

Android Context / noBackupFilesDir：

https://developer.android.com/reference/android/content/Context#getNoBackupFilesDir()

---

## 32. Definition of Done

本功能只有在以下场景完整跑通后才算完成：

```text
用户在 vivo X200 Pro 下载一个有效 .litertlm
→ 在 tavo-mini 中选择文件
→ App 将文件复制到 noBackupFilesDir/models
→ 显示导入进度
→ 完成 SHA-256
→ GPU 验证，失败则 CPU 验证
→ 模型状态变为可用
→ 创建本地 LLM 配置
→ 设为当前配置
→ 开启飞行模式
→ 执行一次小说文本生成
→ Token 流式显示
→ 生成结果进入现有流水线结果
→ App 重启后模型仍可使用
→ 删除模型时引用和路径保护正常
```

任何只完成“选择文件”但没有复制、验证、Provider 路由、离线生成和生命周期管理的实现，都不视为完成。
