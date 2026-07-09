# llama.cpp 本地离线模型接入 SPEC

> **日期：** 2026-07-09
> **状态：** Draft
> **作者：** 塔拉 (AI Assistant)
> **目标版本：** V2.4.0

---

## 1. 目标

废弃 LiteRT-LM 引擎，集成 llama.cpp 作为唯一本地离线推理引擎，让用户能导入 GGUF 格式社区模型（Qwen2.5 / Llama-3 / Mistral / Phi 等），在手机上离线完成小说续写。

核心价值：
- 打破 LiteRT-LM 只能跑 Google 官方 `.litertlm` 的格式锁定
- 支持社区 GGUF 生态（Hugging Face 上数万种量化模型）
- 用户真正拥有"一个 APP 跑任意模型"的自由

---

## 2. 范围

### In Scope

- llama.cpp 源码 + CMake 编译集成到现有 Android 工程
- 新增 `LlamaCppModule` Kotlin 原生模块（导入 / 加载 / 流式生成 / 取消 / 卸载 / 删除）
- TS 侧 `LlamaCppProvider` 对接 Provider Registry
- 删除全部 LiteRT-LM 相关代码和依赖
- 数据库 schema v12 → v13 迁移（`provider_engine` 字段 + 清理旧记录）
- UI 调整：LLM 设置页选项改为「在线 API / 本地 GGUF」，本地模型管理页适配 .gguf
- 内存安全：加载前检查可用 RAM

### Out of Scope

- Hugging Face 直连下载或内置热门模型推荐（只支持手动导入 .gguf）
- GPU (Vulkan/OpenCL) 加速——首版仅 CPU（llama.cpp CPU 已足够跑 1-3B Q4 模型）
- iOS 支持（项目纯 Android）
- 多模型并行加载（一次只加载一个）

---

## 3. 架构

### 3.1 总体架构

```
┌──────────────────────────────────────────────┐
│           React Native (TypeScript)          │
│                                              │
│  LLMProviderType: 'openai_compatible'        │
│                 | 'llama_cpp'                │
│                                              │
│  Provider Registry                           │
│   ├─ OpenAICompatibleProvider (现有)         │
│   └─ LlamaCppProvider (新)                   │
│        └─ NativeModules.LlamaCpp             │
└──────────────────────┬───────────────────────┘
                       │ RN Bridge
┌──────────────────────▼───────────────────────┐
│           Android Kotlin                     │
│                                              │
│  LlamaCppModule (ReactMethod 桥)             │
│   ├─ importModel(sourceUri, name)            │
│   ├─ validateModel(modelId, path)            │
│   ├─ loadModel(modelId, path, opts)          │
│   ├─ generate(requestId, modelId, req)       │
│   ├─ cancel(requestId)                       │
│   ├─ unloadModel()                           │
│   ├─ deleteModelFiles(modelId, path)         │
│   └─ modelFileExists(path)                   │
│                                              │
│  LlamaCppEngine (单例)                       │
│   └─ JNI → libllama.so                      │
│                                              │
│  ModelImporter (.gguf 流式复制 + 校验)       │
│  FileManager (路径安全)                       │
│  ForegroundService (导入通知)                 │
└──────────────────────────────────────────────┘
```

### 3.2 Provider Registry 变更

现有 `LLMProviderType`：

```ts
// Before
type LLMProviderType = 'openai_compatible' | 'local_litertlm';

// After
type LLMProviderType = 'openai_compatible' | 'llama_cpp';
```

Provider Registry 路由逻辑：
- `openai_compatible` → `OpenAICompatibleProvider`（不变）
- `llama_cpp` → `LlamaCppProvider`（新）

### 3.3 数据库 Schema 变更 (v12 → v13)

`local_llm_models` 表：

| 字段 | v12 类型 | v13 类型 | 变更说明 |
|------|---------|---------|---------|
| `provider_engine` | TEXT DEFAULT 'litertlm' | TEXT DEFAULT 'llama_cpp' | 默认值改变 |
| `prompt_template` | — | TEXT DEFAULT 'chatml' | 新增，prompt 格式模板 |
| `actual_backend` | — | TEXT DEFAULT NULL | 新增，记录实际推理后端 (cpu) |

迁移策略：
1. 已有 `provider_engine = 'litertlm'` 的记录 → `status = 'unavailable'` + `error_message = 'LiteRT-LM 引擎已移除，请重新导入 GGUF 模型'`
2. 不删除模型文件（保留在磁盘上，用户可自行备份）
3. 新记录默认 `provider_engine = 'llama_cpp'`

`llm_config` 表：

| 字段 | v12 类型 | v13 类型 | 变更说明 |
|------|---------|---------|---------|
| `provider_type` | TEXT | TEXT | 值从 `'local_litertlm'` 迁移为 `'llama_cpp'` |
| `local_backend` | TEXT | TEXT | 值从 `'auto'/'gpu'/'cpu'` 简化为 `'cpu'`（首版仅 CPU） |

---

## 4. llama.cpp 编译集成

### 4.1 源码引入

从 llama.cpp GitHub 仓库（`ggerganov/llama.cpp`）获取源码，版本锁定 `b5500` 或更新稳定版。

目录结构：

```
android/app/
  jni/
    CMakeLists.txt              # 主 CMake：编译 libllama.so
    llama.cpp/                  # llama.cpp 源码（git submodule 或手动拷贝）
      ggml.c, ggml.h
      ggml-alloc.c, ggml-alloc.h
      ggml-backend.c, ggml-backend.h
      llama.cpp, llama.h
      ggml-cpu/                 # CPU backend
      unicode.cpp, unicode.h
      unicode-data.cpp
      ...
    llamacpp_jni.cpp            # JNI 桥接层
```

### 4.2 CMakeLists.txt 要点

```cmake
cmake_minimum_required(VERSION 3.22)
project(llamacpp_jni)

# 只编译 CPU 后端，不开 Vulkan/OpenCL
set(GGML_CPU ON CACHE BOOL "" FORCE)
set(GGML_VULKAN OFF CACHE BOOL "" FORCE)
set(GGML_OPENCL OFF CACHE BOOL "" FORCE)
set(GGML_METAL OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE)

# 编译目标 ABI：arm64-v8a（必选）、armeabi-v7a（可选）、x86_64（仅调试）
# 由 android/app/build.gradle 的 ndk.abiFilters 控制

add_library(llamacpp_jni SHARED llamacpp_jni.cpp)
target_link_libraries(llamacpp_jni llama ggml cpu log)
```

### 4.3 build.gradle 集成

```gradle
android {
    externalNativeBuild {
        cmake {
            path "jni/CMakeLists.txt"
            version "3.22.1"
        }
    }
    defaultConfig {
        ndk {
            abiFilters 'arm64-v8a'  // 真机
            // 'x86_64'  // 模拟器调试时取消注释
        }
    }
}
```

### 4.4 JNI 桥接层

`llamacpp_jni.cpp` 提供以下函数：

```c
// 初始化：设置线程数等
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeInit(JNIEnv*, jobject, jint numThreads);

// 加载模型：返回 model handle
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeLoadModel(JNIEnv*, jobject, jstring modelPath, jint contextLen);

// 流式生成：通过回调返回 token
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeGenerate(JNIEnv*, jobject, jlong modelHandle, jstring prompt, jint maxTokens, jfloat temperature, jfloat topP, jobject callback);

// 取消生成
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeCancel(JNIEnv*, jobject, jlong modelHandle);

// 卸载模型
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeUnload(JNIEnv*, jobject, jlong modelHandle);
```

---

## 5. Kotlin 原生模块

### 5.1 LlamaCppModule

包名：`com.shinewriter.llamacpp`

ReactMethod 清单：

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `getCapabilities()` | — | `{ available, cpuSupported, freeMemoryMB, totalMemoryMB }` | 检查 CPU 可用性和内存 |
| `importModel(sourceUri, originalFilename, displayName)` | URI 字符串 | `{ importId, originalFilename, displayName, fileSize, sha256, stagingRelativePath }` | 流式复制 + SHA-256 |
| `validateModel(modelId, relativePath)` | 模型 ID + 路径 | `{ backend, loadTimeMs, contextLength }` | 尝试加载验证格式 |
| `loadModel(modelId, relativePath, opts)` | 模型 ID + 路径 + 选项 | `{ backend, loadTimeMs }` | 加载到内存 |
| `generate(requestId, modelId, request)` | 请求 ID + 模型 ID + 请求体 | void（通过事件返回） | 流式生成 |
| `cancel(requestId)` | 请求 ID | void | 取消生成 |
| `unloadModel()` | — | void | 卸载当前模型 |
| `deleteModelFiles(modelId, relativePath)` | 模型 ID + 路径 | void | 删除模型文件 |
| `modelFileExists(relativePath)` | 路径 | boolean | 检查文件存在 |
| `cleanupStagingFiles()` | — | number | 清理临时文件 |

### 5.2 LlamaCppEngine

单例模式，封装 JNI 调用：

```kotlin
class LlamaCppEngine(private val context: Context) {
    private var modelHandle: Long = 0
    private var isLoaded: Boolean = false
    private var currentModelId: String? = null

    fun load(modelId: String, absolutePath: String, contextLength: Int = 4096): Result<LoadResult>
    fun generate(requestId: String, prompt: String, opts: GenerateOptions, onToken: (TokenEvent) -> Unit, onComplete: (CompletedEvent) -> Unit, onError: (ErrorEvent) -> Unit)
    fun cancel(requestId: String)
    fun unload()
    fun trimMemory(level: Int)
    fun unloadAll()

    // 内存安全
    fun checkAvailableMemory(): MemoryInfo
}
```

### 5.3 内存安全

加载模型前必须检查：

```kotlin
val memoryInfo = engine.checkAvailableMemory()
if (memoryInfo.availableMB < minRequiredMB) {
    // 拒绝加载，返回错误
    // minRequiredMB = fileSize * 1.5（GGUF 文件大小的 1.5 倍作为 RAM 估算）
}
```

### 5.4 ForegroundService

复用现有的前台服务模式，仅包名和通知渠道改名：
- `LlamaCppForegroundService` — 导入进度通知
- `LlamaCppNotification` — 通知渠道 ID 改为 `llamacpp_import`

---

## 6. TypeScript 层

### 6.1 类型定义

```ts
// src/types/localModel.ts
export type LocalModelProviderEngine = 'llama_cpp';
export type LocalModelStatus = 'importing' | 'copying' | 'hashing' | 'validating' | 'ready' | 'error' | 'missing' | 'unavailable';
export type PromptTemplate = 'chatml' | 'llama3' | 'alpaca' | 'qwen' | 'phi' | 'mistral' | 'custom';

export interface LocalModel {
  id: string;
  original_filename: string;
  display_name: string;
  file_size: number;
  sha256: string;
  relative_path: string;
  provider_engine: LocalModelProviderEngine;
  status: LocalModelStatus;
  validated_backend: string | null;
  context_length: number | null;
  max_output_tokens: number | null;
  load_time_ms: number | null;
  prompt_template: PromptTemplate;
  imported_at: string;
  last_used_at: string | null;
  last_validated_at: string | null;
  error_code: string | null;
  error_message: string | null;
}
```

### 6.2 LlamaCppProvider

```ts
// src/services/llm/llamaCppProvider.ts
export class LlamaCppProvider implements LLMProvider {
  async generate(messages: ChatMessage[], options: LLMGenerateOptions): Promise<LLMResult> {
    // 1. 从 localModelStore 获取当前激活模型
    // 2. 调 NativeModules.LlamaCpp.generate()
    // 3. 监听 DeviceEventEmitter 事件，流式收集 token
    // 4. 返回 LLMResult
  }

  async testConnection(): Promise<string> {
    // 调 loadModel + generate("你好") + unloadModel
  }
}
```

### 6.3 Prompt 模板适配

```ts
// src/services/llm/llamaCppPromptAdapter.ts
export function applyPromptTemplate(
  template: PromptTemplate,
  messages: ChatMessage[],
  systemPrompt?: string,
): string {
  switch (template) {
    case 'chatml':
      // <|im_start|>system\n{sys}<|im_end|>\n<|im_start|>user\n{msg}<|im_end|>\n<|im_start|>assistant\n
    case 'llama3':
      // <|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n{sys}<|eot_id|>...
    case 'qwen':
      // 同 chatml 但有细微差异
    // ...
  }
}
```

### 6.4 UI 变更

**LLMSettingsScreen.tsx：**
- SegmentedControl 选项：`在线 API` / `本地 GGUF`
- 本地模式下字段：
  - LocalModelSelector（选择已导入的 GGUF 模型）
  - Prompt 模板下拉（chatml / llama3 / qwen / alpaca / phi / mistral / custom）
  - 上下文长度
  - 最大输出 Token
  - 「管理本地模型」按钮

**LocalModelManagerScreen.tsx：**
- 标题改为「导入并管理 GGUF 离线模型」
- 导入按钮改为「导入 .gguf 模型」
- 说明文字改为「支持 Qwen2.5 / Llama-3 / Mistral / Phi 等 GGUF 量化模型。推荐 Q4_K_M 量化，1-3B 参数模型约需 1.5-3GB 存储空间。」
- 每个模型卡片显示 prompt_template 标签

---

## 7. 删除清单

### Android Kotlin（整个 `localllm/` 包删除）

- `LiteRtLmEngineManager.kt`
- `LiteRtLmPromptAdapter.kt`
- `LocalLLMErrors.kt`
- `LocalLLMEvents.kt`
- `LocalLLMModule.kt`
- `LocalLLMPackage.kt`
- `LocalModelFileManager.kt` → 迁移到 `llamacpp/` 包
- `LocalModelImporter.kt` → 迁移到 `llamacpp/` 包
- `LocalModelForegroundService.kt` → 迁移到 `llamacpp/` 包
- `LocalModelNotification.kt` → 迁移到 `llamacpp/` 包

### build.gradle

- 删除 `implementation("com.google.ai.edge.litertlm:litertlm-android:0.14.0")`
- 新增 `externalNativeBuild { cmake { ... } }` 配置

### AndroidManifest.xml

- 删除 `libvndksupport.so` 和 `libOpenCL.so` 的 `uses-native-library` 声明
- 删除 `LocalModelForegroundService` 的 `<service>` 声明
- 新增 `LlamaCppForegroundService` 的 `<service>` 声明

### TypeScript

- 删除 `src/services/llm/localLiteRtLmProvider.ts`
- 删除 `src/native/LocalLLMModule.ts`
- 删除 `src/components/LocalModelSelector.tsx` 中 litertlm 相关分支
- 修改 `src/types/novel.ts`：`LLMProviderType` 去掉 `'local_litertlm'`
- 修改 `src/types/localModel.ts`：`LocalModelProviderEngine` 去掉 `'litertlm'`

### jest.setup.js

- 删除 `LocalLLM` mock
- 新增 `LlamaCpp` mock

---

## 8. 迁移策略

### 数据库 v12 → v13

```ts
// src/services/migrations/v12-to-v13.ts

export async function migrateV12ToV13(db: SQLiteDatabase): Promise<void> {
  // 1. local_llm_models 表新增 prompt_template 列
  await db.executeSql(
    'ALTER TABLE local_llm_models ADD COLUMN prompt_template TEXT DEFAULT "chatml"'
  );

  // 2. local_llm_models 表新增 actual_backend 列
  await db.executeSql(
    'ALTER TABLE local_llm_models ADD COLUMN actual_backend TEXT DEFAULT NULL'
  );

  // 3. 旧 litertlm 记录标记为不可用
  await db.executeSql(
    `UPDATE local_llm_models SET status = 'unavailable',
     error_message = 'LiteRT-LM 引擎已移除，请重新导入 GGUF 模型'
     WHERE provider_engine = 'litertlm' AND status != 'unavailable'`
  );

  // 4. llm_config 表中 provider_type 迁移
  await db.executeSql(
    `UPDATE llm_config SET provider_type = 'llama_cpp' WHERE provider_type = 'local_litertlm'`
  );

  // 5. llm_config 表中 local_backend 简化
  await db.executeSql(
    `UPDATE llm_config SET local_backend = 'cpu' WHERE provider_type = 'llama_cpp'`
  );
}
```

### MainApplication.kt

```kotlin
// 删除
add(LocalLLMPackage())

// 新增
add(LlamaCppPackage())
```

---

## 9. 错误码

```kotlin
object LlamaCppErrors {
  const val ENGINE_UNAVAILABLE = "ENGINE_UNAVAILABLE"
  const val UNSUPPORTED_FILE_TYPE = "UNSUPPORTED_FILE_TYPE"
  const val SOURCE_URI_UNREADABLE = "SOURCE_URI_UNREADABLE"
  const val SOURCE_FILE_EMPTY = "SOURCE_FILE_EMPTY"
  const val INSUFFICIENT_STORAGE = "INSUFFICIENT_STORAGE"
  const val INSUFFICIENT_MEMORY = "INSUFFICIENT_MEMORY"
  const val IMPORT_CANCELLED = "IMPORT_CANCELLED"
  const val IMPORT_COPY_FAILED = "IMPORT_COPY_FAILED"
  const val IMPORT_INCOMPLETE = "IMPORT_INCOMPLETE"
  const val MODEL_FILE_MISSING = "MODEL_FILE_MISSING"
  const val MODEL_FILE_OUTSIDE_ROOT = "MODEL_FILE_OUTSIDE_ROOT"
  const val MODEL_LOAD_FAILED = "MODEL_LOAD_FAILED"
  const val MODEL_CORRUPTED = "MODEL_CORRUPTED"
  const val ENGINE_NOT_READY = "ENGINE_NOT_READY"
  const val ENGINE_BUSY = "ENGINE_BUSY"
  const val GENERATION_FAILED = "GENERATION_FAILED"
  const val GENERATION_CANCELLED = "GENERATION_CANCELLED"
  const val DELETE_FAILED = "DELETE_FAILED"
  const val GGUF_HEADER_INVALID = "GGUF_HEADER_INVALID"
  const val GGUF_UNSUPPORTED_VERSION = "GGUF_UNSUPPORTED_VERSION"
}
```

---

## 10. GGUF 文件头校验

导入时验证文件头，拒绝无效文件：

```kotlin
// GGUF magic bytes: 0x46475547 ("GGUF" as uint32 little-endian)
private const val GGUF_MAGIC = 0x46475547L

fun validateGgufHeader(file: File): Boolean {
    file.inputStream().buffered(12).use { input ->
        val buf = ByteArray(4)
        if (input.read(buf) != 4) return false
        val magic = (buf[0].toLong() and 0xFF)
            or ((buf[1].toLong() and 0xFF) shl 8)
            or ((buf[2].toLong() and 0xFF) shl 16)
            or ((buf[3].toLong() and 0xFF) shl 24)
        if (magic != GGUF_MAGIC) return false
        // 版本号：uint32 little-endian
        val vBuf = ByteArray(4)
        if (input.read(vBuf) != 4) return false
        val version = (vBuf[0].toInt() and 0xFF)
            or ((vBuf[1].toInt() and 0xFF) shl 8)
            or ((vBuf[2].toInt() and 0xFF) shl 16)
            or ((vBuf[3].toInt() and 0xFF) shl 24)
        if (version < 2 || version > 3) return false  // GGUF v2/v3
        return true
    }
}
```

---

## 11. 验收标准

1. ✅ 安装 debug APK 后，**设置 → LLM 设置** 可见「在线 API / 本地 GGUF」切换
2. ✅ 导入 `qwen2.5-1.5b-instruct-q4_k_m.gguf`（约 1GB）成功，进度通知正常
3. ✅ 在 LLM 设置页选该模型 → 设为当前 → 切到写作 Tab → AI 续写输出中文
4. ✅ 流式输出，Vivo V2405A 上 ≥ 5 token/sec
5. ✅ 取消按钮即时终止生成
6. ✅ 卸装重装后，已导入模型仍在列表
7. ✅ 旧 LiteRT-LM 模型记录标记为 unavailable，不崩溃
8. ✅ 内存不足时拒绝加载并给出中文提示
9. ✅ 无效文件（非 GGUF 头）导入时提示"文件格式不正确"

---

## 12. 技术风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| llama.cpp 编译失败 / 体积爆炸 | 默认只编译 arm64-v8a；关闭 Vulkan/OpenCL；CPU-only 构建 .so 约 5-8MB |
| GGUF 文件超大（4-8GB），导入慢 | 复用前台服务 + 进度通知；实时显示 MB/s |
| 推理内存峰值（2B Q4 模型常驻 ~1.5GB RAM） | 启动前查 `ActivityManager.getMemoryInfo`，可用 < 模型文件 × 1.5 时拒绝 |
| Prompt 模板不匹配致输出乱码 | 默认 chatml（Qwen 系）；UI 提供 prompt 模板下拉；模型卡片显示当前模板 |
| 旧 LiteRT-LM 用户模型残留 | 数据库标记 unavailable；文件不删（留给用户手动备份） |
| CMake NDK 兼容性 | 锁定 NDK r27+；CMake 3.22.1+；测试 CI 环境与本地环境一致 |
