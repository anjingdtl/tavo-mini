# llama.cpp 本地离线模型接入 — 实施计划

> **日期：** 2026-07-09
> **目标版本：** V2.4.0
> **基于 SPEC：** `docs/superpowers/specs/2026-07-09-tavo-mini-llama-cpp-local-model-SPEC.md`

---

## 目标

废弃 LiteRT-LM 引擎，集成 llama.cpp 作为唯一本地离线推理引擎，让用户能导入 GGUF 格式社区模型（Qwen2.5 / Llama-3 / Mistral / Phi 等），在手机上离线完成小说续写。

## 架构

```
┌──────────────────────────────────────────────┐
│           React Native (TypeScript)          │
│                                              │
│  LLMProviderType: 'openai_compatible'        │
│                 | 'llama_cpp'                │
│                                              │
│  Provider Registry                           │
│   ├─ OpenAICompatibleProvider (现有不变)     │
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
│   ├─ modelFileExists(path)                   │
│   └─ getCapabilities()                       │
│                                              │
│  LlamaCppEngine (单例)                       │
│   └─ JNI → libllama.so                      │
│                                              │
│  ModelImporter (.gguf 流式复制 + 校验)       │
│  FileManager (路径安全)                       │
│  LlamaCppForegroundService (导入通知)         │
└──────────────────────────────────────────────┘
```

## 技术栈

| 层 | 技术 | 版本 |
|---|---|---|
| 框架 | React Native | 0.85.3 |
| 语言 | TypeScript | 5.8.3 |
| 原生 | Kotlin | 2.1.20 |
| C/C++ | llama.cpp | b5500+ (CPU only) |
| 编译 | CMake | 3.22.1+ |
| NDK | Android NDK | r27+ |
| 目标 ABI | arm64-v8a | — |
| Android | minSdk 24 / targetSdk 36 | — |
| 数据库 | SQLite (schema v12→v13) | — |
| 状态管理 | Zustand | 现有 |

---

## 文件结构总览

### 新增文件

```
android/app/jni/
  CMakeLists.txt                                    # 主 CMake 构建配置
  llamacpp_jni.cpp                                  # JNI 桥接层
  llama.cpp/                                        # llama.cpp 源码（git submodule）
    ggml.c, ggml.h
    ggml-alloc.c, ggml-alloc.h
    ggml-backend.c, ggml-backend.h
    ggml-cpu/
    llama.cpp, llama.h
    unicode.cpp, unicode.h
    unicode-data.cpp
    ...

android/app/src/main/java/com/shinewriter/llamacpp/
  LlamaCppModule.kt                                 # ReactMethod 桥
  LlamaCppPackage.kt                                # ReactPackage 注册
  LlamaCppEngine.kt                                 # JNI 封装单例
  LlamaCppErrors.kt                                 # 错误码常量
  LlamaCppEvents.kt                                 # 事件定义
  GgufValidator.kt                                  # GGUF 文件头校验
  ModelFileManager.kt                               # 路径安全管理（迁移自 localllm）
  ModelImporter.kt                                  # .gguf 流式导入（迁移自 localllm）
  LlamaCppForegroundService.kt                      # 导入前台服务（迁移自 localllm）
  LlamaCppNotification.kt                           # 通知渠道（迁移自 localllm）

src/native/LlamaCppModule.ts                        # TS 桥接类型 + 事件辅助
src/services/llm/llamaCppProvider.ts                # LlamaCppProvider 实现
src/services/llm/llamaCppPromptAdapter.ts           # Prompt 模板适配器
src/services/migrations/v12-to-v13.ts               # 数据库迁移脚本

__tests__/
  llamaCppPromptAdapter.test.ts                     # prompt 模板单测
  v12-to-v13.test.ts                                # 迁移单测
```

### 修改文件

```
android/app/build.gradle                            # 删除 LiteRT-LM 依赖 + 新增 CMake + NDK
android/app/src/main/AndroidManifest.xml            # 删除旧 service/uses-native-library + 新增 service
android/app/src/main/java/com/shinewriter/MainApplication.kt  # 替换 Package 注册
src/types/novel.ts                                  # LLMProviderType 改为 'llama_cpp'
src/types/localModel.ts                             # 新增 PromptTemplate、调整类型
src/services/llm/types.ts                           # LLMProviderType 同步
src/services/llm/providerRegistry.ts                # 替换 local_litertlm → llama_cpp
src/services/localModels.ts                         # 全面重写，对接 LlamaCpp
src/store/localModelStore.ts                        # 对接新模块
src/components/LocalModelSelector.tsx               # 适配新类型
src/screens/LLMSettingsScreen.tsx                   # UI 改为「在线 API / 本地 GGUF」
src/screens/LocalModelManagerScreen.tsx             # 适配 .gguf
src/services/migrations/index.ts                    # 注册 v12→v13 迁移
src/services/llm.ts                                 # resolveLLMRequestConfig 适配
jest.setup.js                                       # 替换 LocalLLM mock → LlamaCpp mock
jest.config.js                                      # transformIgnorePatterns 无需改动（无新RN依赖）
```

### 删除文件

```
android/app/src/main/java/com/shinewriter/localllm/   # 整个目录（10 个文件）
  LiteRtLmEngineManager.kt
  LiteRtLmPromptAdapter.kt
  LocalLLMErrors.kt
  LocalLLMEvents.kt
  LocalLLMModule.kt
  LocalLLMPackage.kt
  LocalModelFileManager.kt
  LocalModelForegroundService.kt
  LocalModelImporter.kt
  LocalModelNotification.kt

src/services/llm/localLiteRtLmProvider.ts
src/native/LocalLLMModule.ts
```

---

## Phase 0: Spike — 验证 llama.cpp 在 Android 工程中可编译

> **目标：** 在不改动任何现有代码的前提下，验证 llama.cpp CMake 编译链路能跑通，`libllama.so` 能被 Kotlin 加载。

### Task 0.1: 下载 llama.cpp 源码到 jni 目录

**操作：**

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini\android\app
mkdir -p jni
cd jni
git clone --depth 1 --branch b5500 https://github.com/ggerganov/llama.cpp.git llama.cpp
```

**验证：** `android/app/jni/llama.cpp/llama.h` 存在。

### Task 0.2: 编写最小 CMakeLists.txt

**文件：** `android/app/jni/CMakeLists.txt`

```cmake
cmake_minimum_required(VERSION 3.22)
project(llamacpp_jni)

# CPU-only 构建
set(GGML_CPU ON CACHE BOOL "" FORCE)
set(GGML_VULKAN OFF CACHE BOOL "" FORCE)
set(GGML_OPENCL OFF CACHE BOOL "" FORCE)
set(GGML_METAL OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(GGML_BUILD_TESTS OFF CACHE BOOL "" FORCE)

# llama.cpp 核心源码（CPU-only 精简列表）
set(LLAMA_CORE_SOURCES
    ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/ggml/src/ggml.c
    ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/ggml/src/ggml-alloc.c
    ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/ggml/src/ggml-backend.c
    ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/ggml/src/ggml-cpu/ggml-cpu.c
    ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/src/llama.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/src/unicode.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/src/unicode-data.cpp
)

add_library(llama SHARED ${LLAMA_CORE_SOURCES})
target_include_directories(llama PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/include
    ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/ggml/include
    ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/ggml/src
    ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/ggml/src/ggml-cpu
    ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/src
)
target_link_libraries(llama log)

# JNI 桥接库
add_library(llamacpp_jni SHARED llamacpp_jni.cpp)
target_include_directories(llamacpp_jni PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/include
    ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/ggml/include
)
target_link_libraries(llamacpp_jni llama log)
```

**注意：** 上面的源文件路径基于 llama.cpp b5500 的目录结构。实际操作时需检查 `llama.cpp/` 下的目录布局，可能需要微调路径。Spike 阶段的目标是确认编译能通过，路径可以后续调整。

### Task 0.3: 编写最小 llamacpp_jni.cpp（空壳）

**文件：** `android/app/jni/llamacpp_jni.cpp`

```cpp
#include <jni.h>
#include <android/log.h>

#define LOG_TAG "LlamaCppJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)

extern "C" JNIEXPORT jint JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeInit(
    JNIEnv *env, jobject thiz, jint num_threads) {
    LOGI("nativeInit called with numThreads=%d", num_threads);
    return 0;
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeLoadModel(
    JNIEnv *env, jobject thiz, jstring model_path, jint context_len) {
    LOGI("nativeLoadModel called (stub)");
    return 0;
}

extern "C" JNIEXPORT void JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeGenerate(
    JNIEnv *env, jobject thiz, jlong model_handle, jstring prompt,
    jint max_tokens, jfloat temperature, jfloat top_p, jobject callback) {
    LOGI("nativeGenerate called (stub)");
}

extern "C" JNIEXPORT void JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeCancel(
    JNIEnv *env, jobject thiz, jlong model_handle) {
    LOGI("nativeCancel called (stub)");
}

extern "C" JNIEXPORT void JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeUnload(
    JNIEnv *env, jobject thiz, jlong model_handle) {
    LOGI("nativeUnload called (stub)");
}
```

### Task 0.4: 修改 build.gradle 添加 CMake 配置

**文件：** `android/app/build.gradle`

在 `android { ... }` 块内添加：

```gradle
    externalNativeBuild {
        cmake {
            path "jni/CMakeLists.txt"
            version "3.22.1"
        }
    }
    defaultConfig {
        // ... 现有内容 ...
        ndk {
            abiFilters 'arm64-v8a'
        }
    }
```

**注意：** `ndk.abiFilters` 要加在 `defaultConfig` 内，与现有的 `applicationId`/`minSdkVersion` 同级。`externalNativeBuild` 加在 `android {}` 块内与 `buildTypes` 同级。

### Task 0.5: 执行编译验证

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini
cd android && .\gradlew :app:externalNativeBuildDebug
```

**验收标准：** 编译无错误，`android/app/build/.cxx/` 下生成 `libllama.so` 和 `libllamacpp_jni.so`。

**如果失败：** 检查 llama.cpp 源码路径是否匹配 b5500 版本结构，调整 CMakeLists.txt 中的源文件列表。如果 NDK 版本不兼容，确认 `android/build.gradle` 中 `ndkVersion` 设置。

### Task 0.6: 编写最小 Kotlin 类验证 JNI 调用

**文件：** `android/app/src/main/java/com/shinewriter/llamacpp/LlamaCppEngine.kt`

```kotlin
package com.shinewriter.llamacpp

import android.content.Context
import android.util.Log

class LlamaCppEngine(private val context: Context) {
    companion object {
        private const val TAG = "LlamaCppEngine"
        init {
            System.loadLibrary("llamacpp_jni")
            Log.i(TAG, "llamacpp_jni library loaded")
        }
    }

    private var modelHandle: Long = 0

    fun init(numThreads: Int): Int {
        return nativeInit(numThreads)
    }

    private external fun nativeInit(numThreads: Int): Int
    private external fun nativeLoadModel(modelPath: String, contextLen: Int): Long
    private external fun nativeGenerate(
        modelHandle: Long, prompt: String, maxTokens: Int,
        temperature: Float, topP: Float, callback: Any
    )
    private external fun nativeCancel(modelHandle: Long)
    private external fun nativeUnload(modelHandle: Long)
}
```

**验证：** 编译 + 安装 APK 不崩溃。

### Task 0.7: Spike 提交

```bash
git add android/app/jni/ android/app/src/main/java/com/shinewriter/llamacpp/LlamaCppEngine.kt
git commit -m "spike: verify llama.cpp compiles in Android project"
```

**Spike 完成后可选择性 revert 此提交**，或在此基础上继续后续 Phase。

---

## Phase 1: 清除 LiteRT-LM

> **目标：** 删除所有 LiteRT-LM 相关代码和依赖，确保项目仍可编译通过（部分功能会暂时不可用，这是预期的）。

### Task 1.1: 删除 localllm 包目录

**删除：** 整个 `android/app/src/main/java/com/shinewriter/localllm/` 目录（10 个文件）

```bash
rm -rf android/app/src/main/java/com/shinewriter/localllm/
```

### Task 1.2: 删除 TS 侧 LiteRT-LM 文件

**删除：**
- `src/services/llm/localLiteRtLmProvider.ts`
- `src/native/LocalLLMModule.ts`

### Task 1.3: 修改 MainApplication.kt — 移除 LocalLLM 引用

**文件：** `android/app/src/main/java/com/shinewriter/MainApplication.kt`

```kotlin
package com.shinewriter

import android.app.Application
import android.content.ComponentCallbacks2
import android.content.res.Configuration
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(TtsAudioPackage())
          add(PipelineForegroundPackage())
          add(PngMetadataPackage())
          // LocalLLMPackage removed — will be replaced by LlamaCppPackage
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    registerComponentCallbacks(object : ComponentCallbacks2 {
      override fun onTrimMemory(level: Int) {
        // LlamaCpp memory management will be handled by LlamaCppModule
      }

      override fun onConfigurationChanged(newConfig: Configuration) {
        // No-op.
      }

      override fun onLowMemory() {
        // LlamaCpp memory management will be handled by LlamaCppModule
      }
    })
  }
}
```

### Task 1.4: 修改 build.gradle — 移除 LiteRT-LM 依赖

**文件：** `android/app/build.gradle`

删除以下行：
```gradle
    // LiteRT-LM local model runtime (pinned to the version validated in Spike).
    def liteRtLmVersion = "0.14.0"
    implementation("com.google.ai.edge.litertlm:litertlm-android:${liteRtLmVersion}")
```

删除 `-Xskip-metadata-version-check` 临时 workaround（这是专门为 LiteRT-LM 加的）：
```gradle
    tasks.withType(org.jetbrains.kotlin.gradle.tasks.KotlinCompile).configureEach {
        compilerOptions {
            freeCompilerArgs.add("-Xskip-metadata-version-check")
        }
    }
```

保留 `kotlinx-coroutines-android`（llamacpp 模块仍需要）。

### Task 1.5: 修改 AndroidManifest.xml — 移除 LiteRT-LM 声明

**文件：** `android/app/src/main/AndroidManifest.xml`

删除：
```xml
    <!-- LiteRT-LM GPU native library hints (optional, fail-open) -->
    <uses-native-library
        android:name="libvndksupport.so"
        android:required="false" />
    <uses-native-library
        android:name="libOpenCL.so"
        android:required="false" />
```

删除：
```xml
      <service
        android:name=".localllm.LocalModelForegroundService"
        android:exported="false"
        android:foregroundServiceType="dataSync" />
```

### Task 1.6: 修改 providerRegistry.ts — 临时移除 local_litertlm

**文件：** `src/services/llm/providerRegistry.ts`

```ts
import { openAICompatibleProvider } from './openAICompatibleProvider';
import type { LLMProvider } from '../../types/llmProvider';
import type { LLMProviderType } from './types';

// llama_cpp provider will be added in Phase 5
const providers: Partial<Record<LLMProviderType, LLMProvider>> = {
  openai_compatible: openAICompatibleProvider,
};

export function getProvider(type: LLMProviderType): LLMProvider {
  const provider = providers[type];
  if (!provider) {
    throw new Error(`不支持的 LLM 提供者类型：${type}`);
  }
  return provider;
}
```

### Task 1.7: 更新 jest.setup.js — 移除 LocalLLM mock

**文件：** `jest.setup.js`

删除 `RN.NativeModules.LocalLLM = { ... }` 整个块（约 30 行）。

### Task 1.8: 验证编译

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini
npx jest --passWithNoTests  # TS 侧测试
cd android && .\gradlew :app:assembleDebug  # Android 编译
```

**预期：** Android 编译通过（因为 localllm 包已删除），Jest 可能因 TS 类型不匹配报错——这些在后续 Phase 修复。

### Task 1.9: Phase 1 提交

```bash
git add -A
git commit -m "chore: remove LiteRT-LM engine and all references

- Delete android/app/src/main/java/com/shinewriter/localllm/ (10 files)
- Delete src/services/llm/localLiteRtLmProvider.ts
- Delete src/native/LocalLLMModule.ts
- Remove litertlm dependency from build.gradle
- Remove LocalLLMPackage from MainApplication.kt
- Remove LiteRT-LM entries from AndroidManifest.xml
- Remove LocalLLM mock from jest.setup.js
- Temporarily stub providerRegistry (llama_cpp to be added)"
```

---

## Phase 2: JNI 桥接 + CMake + llama.cpp 源码集成

> **目标：** 将 Spike 阶段验证通过的 CMake + JNI 基础设施正式整合，实现完整的 JNI 桥接层（含流式生成回调）。

### Task 2.1: 确认 llama.cpp 源码目录结构

如果 Phase 0 的 Spike 已完成，源码已在 `android/app/jni/llama.cpp/`。否则执行：

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini\android\app
mkdir -p jni
cd jni
git clone --depth 1 --branch b5500 https://github.com/ggerganov/llama.cpp.git llama.cpp
```

然后检查 `llama.cpp/` 下实际文件结构，确认以下关键文件路径：
- `ggml/src/ggml.c` 或 `ggml.c`
- `ggml/src/ggml-alloc.c` 或 `ggml-alloc.c`
- `ggml/src/ggml-backend.c` 或 `ggml-backend.c`
- `ggml/src/ggml-cpu/ggml-cpu.c` 或 `ggml-cpu.c`
- `src/llama.cpp` 或 `llama.cpp`
- `src/unicode.cpp`
- `src/unicode-data.cpp`
- `include/llama.h` 或 `llama.h`

**根据实际结构调整 CMakeLists.txt 中的路径。**

### Task 2.2: 编写正式 CMakeLists.txt

**文件：** `android/app/jni/CMakeLists.txt`

```cmake
cmake_minimum_required(VERSION 3.22)
project(llamacpp_jni)

# ── 编译选项 ──────────────────────────────────
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

# CPU-only 构建
set(GGML_CPU ON CACHE BOOL "" FORCE)
set(GGML_VULKAN OFF CACHE BOOL "" FORCE)
set(GGML_OPENCL OFF CACHE BOOL "" FORCE)
set(GGML_METAL OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(GGML_BUILD_TESTS OFF CACHE BOOL "" FORCE)

# ── llama.cpp 核心库 ──────────────────────────
# 注意：以下路径基于 llama.cpp b5500 目录结构
# 如果实际结构不同，请根据 Task 2.1 的检查结果调整
set(LLAMA_DIR ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp)

# 查找所有需要的源文件
file(GLOB GGML_CORE_SOURCES
    "${LLAMA_DIR}/ggml/src/*.c"
)
file(GLOB GGML_CPU_SOURCES
    "${LLAMA_DIR}/ggml/src/ggml-cpu/*.c"
)
file(GLOB LLAMA_SOURCES
    "${LLAMA_DIR}/src/*.cpp"
)

add_library(llama SHARED
    ${GGML_CORE_SOURCES}
    ${GGML_CPU_SOURCES}
    ${LLAMA_SOURCES}
)

target_include_directories(llama PUBLIC
    ${LLAMA_DIR}/include
    ${LLAMA_DIR}/ggml/include
    ${LLAMA_DIR}/ggml/src
    ${LLAMA_DIR}/ggml/src/ggml-cpu
    ${LLAMA_DIR}/src
)

target_compile_definitions(llama PRIVATE
    GGML_USE_CPU
)

target_link_libraries(llama log android)

# ── JNI 桥接库 ────────────────────────────────
add_library(llamacpp_jni SHARED llamacpp_jni.cpp)

target_include_directories(llamacpp_jni PRIVATE
    ${LLAMA_DIR}/include
    ${LLAMA_DIR}/ggml/include
)

target_link_libraries(llamacpp_jni llama log)
```

### Task 2.3: 编写完整 llamacpp_jni.cpp

**文件：** `android/app/jni/llamacpp_jni.cpp`

```cpp
#include <jni.h>
#include <android/log.h>
#include <string>
#include <cstring>
#include <atomic>
#include <thread>

#include "llama.h"

#define LOG_TAG "LlamaCppJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// ── 全局状态 ──────────────────────────────────
static llama_model *g_model = nullptr;
static llama_context *g_ctx = nullptr;
static std::atomic<bool> g_cancelled{false};

// ── JNI 回调辅助 ──────────────────────────────
static void emitToken(JNIEnv *env, jobject callback, const char *token, int sequence) {
    jclass cbClass = env->GetObjectClass(callback);
    jmethodID onToken = env->GetMethodID(cbClass, "onToken", "(Ljava/lang/String;I)V");
    if (onToken) {
        jstring jToken = env->NewStringUTF(token);
        env->CallVoidMethod(callback, onToken, jToken, sequence);
        env->DeleteLocalRef(jToken);
    }
}

static void emitCompleted(JNIEnv *env, jobject callback, const char *fullText,
                          int outputTokens, float tokensPerSecond, int elapsedMs) {
    jclass cbClass = env->GetObjectClass(callback);
    jmethodID onCompleted = env->GetMethodID(cbClass, "onCompleted",
        "(Ljava/lang/String;IFI)V");
    if (onCompleted) {
        jstring jText = env->NewStringUTF(fullText);
        env->CallVoidMethod(callback, onCompleted, jText, outputTokens, tokensPerSecond, elapsedMs);
        env->DeleteLocalRef(jText);
    }
}

static void emitError(JNIEnv *env, jobject callback, const char *message) {
    jclass cbClass = env->GetObjectClass(callback);
    jmethodID onError = env->GetMethodID(cbClass, "onError", "(Ljava/lang/String;)V");
    if (onError) {
        jstring jMsg = env->NewStringUTF(message);
        env->CallVoidMethod(callback, onError, jMsg);
        env->DeleteLocalRef(jMsg);
    }
}

// ── JNI 函数实现 ──────────────────────────────

extern "C" JNIEXPORT jint JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeInit(
    JNIEnv *env, jobject thiz, jint num_threads) {
    LOGI("nativeInit: numThreads=%d", num_threads);
    // llama.cpp 全局初始化（b5500+ 不再需要 llama_init_backend）
    return 0;
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeLoadModel(
    JNIEnv *env, jobject thiz, jstring model_path, jint context_len) {
    if (g_model) {
        LOGE("nativeLoadModel: model already loaded, unload first");
        return 0;
    }

    const char *path = env->GetStringUTFChars(model_path, nullptr);
    LOGI("nativeLoadModel: path=%s, contextLen=%d", path, context_len);

    auto model_params = llama_model_default_params();
    model_params.n_gpu_layers = 0; // CPU-only

    g_model = llama_model_load_from_file(path, model_params);
    env->ReleaseStringUTFChars(model_path, path);

    if (!g_model) {
        LOGE("nativeLoadModel: failed to load model");
        return 0;
    }

    auto ctx_params = llama_context_default_params();
    ctx_params.n_ctx = context_len;
    ctx_params.n_batch = 512;
    ctx_params.n_threads = 4;
    ctx_params.n_threads_batch = 4;

    g_ctx = llama_init_from_model(g_model, ctx_params);
    if (!g_ctx) {
        LOGE("nativeLoadModel: failed to create context");
        llama_model_free(g_model);
        g_model = nullptr;
        return 0;
    }

    LOGI("nativeLoadModel: success");
    return reinterpret_cast<jlong>(g_model);
}

extern "C" JNIEXPORT void JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeGenerate(
    JNIEnv *env, jobject thiz, jlong model_handle, jstring prompt,
    jint max_tokens, jfloat temperature, jfloat top_p, jobject callback) {
    LOGI("nativeGenerate: maxTokens=%d, temp=%.2f, topP=%.2f", max_tokens, temperature, top_p);

    if (!g_ctx) {
        emitError(env, callback, "模型未加载");
        return;
    }

    const char *prompt_str = env->GetStringUTFChars(prompt, nullptr);
    std::string input(prompt_str);
    env->ReleaseStringUTFChars(prompt, prompt_str);

    // Tokenize
    const int n_prompt_max = llama_n_ctx(g_ctx);
    auto tokens = llama_tokenize(g_ctx, input, true, true);

    if (tokens.size() > n_prompt_max - 4) {
        tokens.resize(n_prompt_max - 4);
    }

    // Process prompt
    llama_batch batch = llama_batch_get_one(tokens.data(), tokens.size());
    if (llama_decode(g_ctx, batch) != 0) {
        emitError(env, callback, "Prompt 处理失败");
        return;
    }

    // Generation loop
    g_cancelled.store(false);
    std::string full_text;
    int n_output = 0;
    auto start_time = std::chrono::steady_clock::now();

    llama_sampler *sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(sampler, llama_sampler_init_temp(temperature));
    llama_sampler_chain_add(sampler, llama_sampler_init_top_p(top_p, 1));
    llama_sampler_chain_add(sampler, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));

    int last_token = tokens.back();

    while (n_output < max_tokens && !g_cancelled.load()) {
        auto new_token_id = llama_sampler_sample(sampler, g_ctx, -1);

        if (llama_token_is_eog(llama_model_get_vocab(g_model), new_token_id)) {
            break;
        }

        const char *token_str = llama_token_to_piece(g_ctx, new_token_id);
        if (token_str) {
            full_text += token_str;
            emitToken(env, callback, token_str, n_output);
        }

        n_output++;

        // Prepare next batch
        batch = llama_batch_get_one(&new_token_id, 1);
        if (llama_decode(g_ctx, batch) != 0) {
            emitError(env, callback, "生成解码失败");
            break;
        }
    }

    auto end_time = std::chrono::steady_clock::now();
    float elapsed_sec = std::chrono::duration<float>(end_time - start_time).count();
    float tps = n_output > 0 ? n_output / elapsed_sec : 0.0f;
    int elapsed_ms = static_cast<int>(elapsed_sec * 1000);

    if (!g_cancelled.load()) {
        emitCompleted(env, callback, full_text.c_str(), n_output, tps, elapsed_ms);
    } else {
        emitCompleted(env, callback, full_text.c_str(), n_output, tps, elapsed_ms);
    }

    llama_sampler_free(sampler);
    LOGI("nativeGenerate: done, %d tokens, %.1f t/s", n_output, tps);
}

extern "C" JNIEXPORT void JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeCancel(
    JNIEnv *env, jobject thiz, jlong model_handle) {
    LOGI("nativeCancel");
    g_cancelled.store(true);
}

extern "C" JNIEXPORT void JNICALL
Java_com_shinewriter_llamacpp_LlamaCppEngine_nativeUnload(
    JNIEnv *env, jobject thiz, jlong model_handle) {
    LOGI("nativeUnload");
    g_cancelled.store(true);
    if (g_ctx) {
        llama_free(g_ctx);
        g_ctx = nullptr;
    }
    if (g_model) {
        llama_model_free(g_model);
        g_model = nullptr;
    }
}
```

**注意：** 上述代码基于 llama.cpp b5500 的 API。关键 API 包括 `llama_model_load_from_file`、`llama_init_from_model`、`llama_tokenize`、`llama_batch_get_one`、`llama_decode`、`llama_sampler_*` 等。如果 b5500 版本的 API 有差异，需在 Spike 阶段确认并调整。

### Task 2.4: 确认 build.gradle 中 CMake 配置

**文件：** `android/app/build.gradle`

确认 `android {}` 块内包含：

```gradle
    externalNativeBuild {
        cmake {
            path "jni/CMakeLists.txt"
            version "3.22.1"
        }
    }
```

确认 `defaultConfig` 内包含：

```gradle
        ndk {
            abiFilters 'arm64-v8a'
        }
```

### Task 2.5: 编译验证

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini\android
.\gradlew :app:externalNativeBuildDebug
```

**验收标准：** 编译无错误，生成 `libllama.so` 和 `libllamacpp_jni.so`。

### Task 2.6: Phase 2 提交

```bash
git add android/app/jni/
git commit -m "feat: add llama.cpp CMake build + JNI bridge layer (CPU-only, arm64-v8a)"
```

---

## Phase 3: Kotlin LlamaCppModule + LlamaCppEngine

> **目标：** 实现完整的 Kotlin 原生模块，替换原来的 LocalLLMModule。

### Task 3.1: 编写 LlamaCppErrors.kt

**文件：** `android/app/src/main/java/com/shinewriter/llamacpp/LlamaCppErrors.kt`

```kotlin
package com.shinewriter.llamacpp

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

### Task 3.2: 编写 LlamaCppEvents.kt

**文件：** `android/app/src/main/java/com/shinewriter/llamacpp/LlamaCppEvents.kt`

```kotlin
package com.shinewriter.llamacpp

object LlamaCppEvents {
    const val TOKEN = "LlamaCppToken"
    const val COMPLETED = "LlamaCppCompleted"
    const val ERROR = "LlamaCppError"
    const val IMPORT_PROGRESS = "LlamaCppImportProgress"
    const val IMPORT_STATE = "LlamaCppImportState"
}
```

### Task 3.3: 编写 GgufValidator.kt

**文件：** `android/app/src/main/java/com/shinewriter/llamacpp/GgufValidator.kt`

```kotlin
package com.shinewriter.llamacpp

import android.util.Log
import java.io.File

object GgufValidator {
    private const val TAG = "GgufValidator"
    private const val GGUF_MAGIC: Long = 0x46475547L // "GGUF" as uint32 little-endian

    fun validateHeader(file: File): Boolean {
        try {
            file.inputStream().buffered(12).use { input ->
                val buf = ByteArray(4)
                if (input.read(buf) != 4) return false
                val magic = (buf[0].toLong() and 0xFF)
                    or ((buf[1].toLong() and 0xFF) shl 8)
                    or ((buf[2].toLong() and 0xFF) shl 16)
                    or ((buf[3].toLong() and 0xFF) shl 24)
                if (magic != GGUF_MAGIC) {
                    Log.w(TAG, "Invalid GGUF magic: 0x${magic.toString(16)}")
                    return false
                }
                val vBuf = ByteArray(4)
                if (input.read(vBuf) != 4) return false
                val version = (vBuf[0].toInt() and 0xFF)
                    or ((vBuf[1].toInt() and 0xFF) shl 8)
                    or ((vBuf[2].toInt() and 0xFF) shl 16)
                    or ((vBuf[3].toInt() and 0xFF) shl 24)
                if (version < 2 || version > 3) {
                    Log.w(TAG, "Unsupported GGUF version: $version")
                    return false
                }
                Log.i(TAG, "Valid GGUF v$version file: ${file.name}")
                return true
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error validating GGUF header", e)
            return false
        }
    }
}
```

### Task 3.4: 编写 ModelFileManager.kt

**文件：** `android/app/src/main/java/com/shinewriter/llamacpp/ModelFileManager.kt`

```kotlin
package com.shinewriter.llamacpp

import android.content.Context
import android.util.Log
import java.io.File
import java.security.MessageDigest

class ModelFileManager(private val context: Context) {
    companion object {
        private const val TAG = "ModelFileManager"
        private const val MODELS_DIR = "local_models"
        private const val STAGING_DIR = ".staging"
    }

    val modelsRoot: File
        get() = File(context.filesDir, MODELS_DIR).also { it.mkdirs() }

    val stagingRoot: File
        get() = File(modelsRoot, STAGING_DIR).also { it.mkdirs() }

    fun resolveModelPath(relativePath: String): File {
        val target = File(modelsRoot, relativePath)
        // 路径遍历安全检查
        if (!target.canonicalPath.startsWith(modelsRoot.canonicalPath)) {
            throw SecurityException("模型文件路径越界：$relativePath")
        }
        return target
    }

    fun getStagingFile(importId: String, filename: String): File {
        return File(stagingRoot, "$importId.${filename.substringAfterLast(".", "gguf")}.tmp")
    }

    fun moveFromStagingToFinal(stagingFile: File, importId: String, extension: String = "gguf"): File {
        val finalDir = File(modelsRoot, importId)
        finalDir.mkdirs()
        val finalFile = File(finalDir, "model.$extension")
        if (stagingFile.renameTo(finalFile)) {
            return finalFile
        }
        // Fallback: copy then delete
        stagingFile.inputStream().use { input ->
            finalFile.outputStream().use { output ->
                input.copyTo(output, 8192)
            }
        }
        stagingFile.delete()
        return finalFile
    }

    fun getRelativePath(absoluteFile: File): String {
        return absoluteFile.absolutePath.removePrefix(modelsRoot.absolutePath)
            .removePrefix("/")
    }

    fun deleteModelFiles(relativePath: String): Boolean {
        val target = resolveModelPath(relativePath)
        if (!target.exists()) return true
        val parent = target.parentFile
        return target.delete() && parent?.let {
            if (it.listFiles()?.isEmpty() == true) it.delete() else true
        } ?: true
    }

    fun modelFileExists(relativePath: String): Boolean {
        return resolveModelPath(relativePath).exists()
    }

    fun computeSha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered(65536).use { input ->
            val buffer = ByteArray(8192)
            var read: Int
            while (input.read(buffer).also { read = it } != -1) {
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun cleanupStagingFiles(): Int {
        var count = 0
        stagingRoot.listFiles()?.forEach { file ->
            if (file.isFile && file.name.endsWith(".tmp")) {
                if (file.delete()) count++
            }
        }
        Log.i(TAG, "Cleaned up $count staging files")
        return count
    }
}
```

### Task 3.5: 编写 ModelImporter.kt

**文件：** `android/app/src/main/java/com/shinewriter/llamacpp/ModelImporter.kt`

```kotlin
package com.shinewriter.llamacpp

import android.content.Context
import android.net.Uri
import android.util.Log
import kotlinx.coroutines.*
import java.io.File
import java.security.MessageDigest
import java.util.UUID

data class ImportResult(
    val importId: String,
    val originalFilename: String,
    val displayName: String,
    val fileSize: Long,
    val sha256: String,
    val stagingRelativePath: String,
)

class ModelImporter(
    private val context: Context,
    private val fileManager: ModelFileManager,
) {
    companion object {
        private const val TAG = "ModelImporter"
        private const val BUFFER_SIZE = 65536
    }

    private val activeJobs = mutableMapOf<String, Job>()
    private val cancelledImports = mutableSetOf<String>()

    fun importModel(
        sourceUri: String,
        originalFilename: String,
        displayName: String,
        onProgress: (importId: String, bytesCopied: Long, totalBytes: Long) -> Unit,
        onStateChanged: (importId: String, state: String) -> Unit,
        onComplete: (result: ImportResult) -> Unit,
        onError: (importId: String, code: String, message: String) -> Unit,
    ): String {
        val importId = "import-${UUID.randomUUID()}"
        val stagingFile = fileManager.getStagingFile(importId, originalFilename)

        val job = CoroutineScope(Dispatchers.IO).launch {
            try {
                onStateChanged(importId, "copying")
                val uri = Uri.parse(sourceUri)
                val inputStream = context.contentResolver.openInputStream(uri)
                    ?: throw Exception("无法读取源文件")

                val digest = MessageDigest.getInstance("SHA-256")
                var bytesCopied = 0L

                inputStream.use { input ->
                    stagingFile.outputStream().buffered(BUFFER_SIZE).use { output ->
                        val buffer = ByteArray(BUFFER_SIZE)
                        var read: Int
                        while (input.read(buffer).also { read = it } != -1) {
                            if (cancelledImports.contains(importId)) {
                                stagingFile.delete()
                                onError(importId, LlamaCppErrors.IMPORT_CANCELLED, "导入已取消")
                                return@launch
                            }
                            output.write(buffer, 0, read)
                            digest.update(buffer, 0, read)
                            bytesCopied += read
                            onProgress(importId, bytesCopied, -1L)
                        }
                    }
                }

                if (bytesCopied == 0L) {
                    stagingFile.delete()
                    onError(importId, LlamaCppErrors.SOURCE_FILE_EMPTY, "源文件为空")
                    return@launch
                }

                // GGUF 文件头校验
                if (!GgufValidator.validateHeader(stagingFile)) {
                    stagingFile.delete()
                    onError(importId, LlamaCppErrors.GGUF_HEADER_INVALID, "文件格式不正确，请选择有效的 .gguf 模型文件")
                    return@launch
                }

                val sha256 = digest.digest().joinToString("") { "%02x".format(it) }
                val finalFile = fileManager.moveFromStagingToFinal(stagingFile, importId)
                val relativePath = fileManager.getRelativePath(finalFile)

                onComplete(ImportResult(
                    importId = importId,
                    originalFilename = originalFilename,
                    displayName = displayName,
                    fileSize = bytesCopied,
                    sha256 = sha256,
                    stagingRelativePath = relativePath,
                ))
            } catch (e: CancellationException) {
                stagingFile.delete()
                onError(importId, LlamaCppErrors.IMPORT_CANCELLED, "导入已取消")
            } catch (e: Exception) {
                Log.e(TAG, "Import failed", e)
                stagingFile.delete()
                onError(importId, LlamaCppErrors.IMPORT_COPY_FAILED, e.message ?: "导入失败")
            } finally {
                activeJobs.remove(importId)
                cancelledImports.remove(importId)
            }
        }

        activeJobs[importId] = job
        return importId
    }

    fun cancelImport(importId: String) {
        cancelledImports.add(importId)
        activeJobs[importId]?.cancel()
    }
}
```

### Task 3.6: 编写 LlamaCppForegroundService.kt

**文件：** `android/app/src/main/java/com/shinewriter/llamacpp/LlamaCppForegroundService.kt`

```kotlin
package com.shinewriter.llamacpp

import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

class LlamaCppForegroundService : Service() {
    companion object {
        private const val TAG = "LlamaCppForegroundSvc"
        var isRunning = false
            private set
    }

    override fun onCreate() {
        super.onCreate()
        val notification = NotificationCompat.Builder(this, LlamaCppNotification.CHANNEL_ID)
            .setContentTitle("正在导入模型")
            .setContentText("请勿关闭应用")
            .setSmallIcon(android.R.drawable.ic_menu_upload)
            .setOngoing(true)
            .build()
        startForeground(LlamaCppNotification.NOTIFICATION_ID, notification)
        isRunning = true
        Log.i(TAG, "Foreground service started")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        isRunning = false
        Log.i(TAG, "Foreground service destroyed")
    }
}
```

### Task 3.7: 编写 LlamaCppNotification.kt

**文件：** `android/app/src/main/java/com/shinewriter/llamacpp/LlamaCppNotification.kt`

```kotlin
package com.shinewriter.llamacpp

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build

object LlamaCppNotification {
    const val CHANNEL_ID = "llamacpp_import"
    const val NOTIFICATION_ID = 2001

    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "模型导入",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "本地 GGUF 模型导入进度通知"
                setShowBadge(false)
            }
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }
}
```

### Task 3.8: 编写 LlamaCppEngine.kt（完整版）

**文件：** `android/app/src/main/java/com/shinewriter/llamacpp/LlamaCppEngine.kt`

```kotlin
package com.shinewriter.llamacpp

import android.app.ActivityManager
import android.content.Context
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap

data class MemoryInfo(
    val availableMB: Long,
    val totalMB: Long,
    val lowMemory: Boolean,
)

data class LoadResult(
    val backend: String,
    val loadTimeMs: Long,
)

data class GenerateOptions(
    val maxTokens: Int = 512,
    val temperature: Float = 0.8f,
    val topP: Float = 0.9f,
)

class LlamaCppEngine(private val context: Context) {
    companion object {
        private const val TAG = "LlamaCppEngine"
        private const val MEMORY_SAFETY_FACTOR = 1.5

        @Volatile
        private var instance: LlamaCppEngine? = null

        fun getInstance(context: Context): LlamaCppEngine {
            return instance ?: synchronized(this) {
                instance ?: LlamaCppEngine(context.applicationContext).also { instance = it }
            }
        }
    }

    private var modelHandle: Long = 0
    private var isLoaded: Boolean = false
    private var currentModelId: String? = null
    private var currentModelPath: String? = null

    fun load(modelId: String, absolutePath: String, contextLength: Int = 4096): Result<LoadResult> {
        if (isLoaded) {
            Log.w(TAG, "Model already loaded, unloading first")
            unload()
        }

        // 内存安全检查
        val memoryInfo = checkAvailableMemory()
        val file = java.io.File(absolutePath)
        if (file.exists()) {
            val requiredMB = (file.length() * MEMORY_SAFETY_FACTOR) / (1024 * 1024)
            if (memoryInfo.availableMB < requiredMB) {
                return Result.failure(
                    Exception("内存不足：需要约 ${requiredMB}MB，当前可用 ${memoryInfo.availableMB}MB")
                )
            }
        }

        val startTime = System.currentTimeMillis()
        try {
            nativeInit(4)
            modelHandle = nativeLoadModel(absolutePath, contextLength)
            if (modelHandle == 0L) {
                return Result.failure(Exception("模型加载失败，请确认文件格式正确"))
            }
            isLoaded = true
            currentModelId = modelId
            currentModelPath = absolutePath
            val loadTime = System.currentTimeMillis() - startTime
            Log.i(TAG, "Model loaded in ${loadTime}ms")
            return Result.success(LoadResult(backend = "cpu", loadTimeMs = loadTime))
        } catch (e: Exception) {
            Log.e(TAG, "Model load failed", e)
            return Result.failure(e)
        }
    }

    fun generate(
        requestId: String,
        prompt: String,
        opts: GenerateOptions,
        onToken: (requestId: String, delta: String, sequence: Int) -> Unit,
        onComplete: (requestId: String, text: String, outputTokens: Int, tokensPerSecond: Float, elapsedMs: Int) -> Unit,
        onError: (requestId: String, message: String) -> Unit,
    ) {
        if (!isLoaded || modelHandle == 0L) {
            onError(requestId, "模型未加载")
            return
        }

        val callback = object : GenerationCallback {
            override fun onToken(token: String, sequence: Int) {
                onToken(requestId, token, sequence)
            }
            override fun onCompleted(text: String, outputTokens: Int, tokensPerSecond: Float, elapsedMs: Int) {
                onComplete(requestId, text, outputTokens, tokensPerSecond, elapsedMs)
            }
            override fun onError(message: String) {
                onError(requestId, message)
            }
        }

        Thread {
            nativeGenerate(modelHandle, prompt, opts.maxTokens, opts.temperature, opts.topP, callback)
        }.start()
    }

    fun cancel() {
        if (modelHandle != 0L) {
            nativeCancel(modelHandle)
        }
    }

    fun unload() {
        if (modelHandle != 0L) {
            nativeUnload(modelHandle)
            modelHandle = 0
            isLoaded = false
            currentModelId = null
            currentModelPath = null
            Log.i(TAG, "Model unloaded")
        }
    }

    fun trimMemory(level: Int) {
        if (level >= android.content.ComponentCallbacks2.TRIM_MEMORY_MODERATE) {
            unload()
        }
    }

    fun checkAvailableMemory(): MemoryInfo {
        val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memoryInfo = ActivityManager.MemoryInfo()
        activityManager.getMemoryInfo(memoryInfo)
        return MemoryInfo(
            availableMB = memoryInfo.availMem / (1024 * 1024),
            totalMB = memoryInfo.totalMem / (1024 * 1024),
            lowMemory = memoryInfo.lowMemory,
        )
    }

    // ── JNI native 方法 ──────────────────────────
    private external fun nativeInit(numThreads: Int): Int
    private external fun nativeLoadModel(modelPath: String, contextLen: Int): Long
    private external fun nativeGenerate(
        modelHandle: Long, prompt: String, maxTokens: Int,
        temperature: Float, topP: Float, callback: GenerationCallback
    )
    private external fun nativeCancel(modelHandle: Long)
    private external fun nativeUnload(modelHandle: Long)

    // ── 初始化 ────────────────────────────────────
    init {
        System.loadLibrary("llamacpp_jni")
        Log.i(TAG, "llamacpp_jni library loaded")
    }
}

// JNI 回调接口
interface GenerationCallback {
    fun onToken(token: String, sequence: Int)
    fun onCompleted(text: String, outputTokens: Int, tokensPerSecond: Float, elapsedMs: Int)
    fun onError(message: String)
}
```

### Task 3.9: 编写 LlamaCppModule.kt

**文件：** `android/app/src/main/java/com/shinewriter/llamacpp/LlamaCppModule.kt`

```kotlin
package com.shinewriter.llamacpp

import android.content.ComponentCallbacks2
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

class LlamaCppModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "LlamaCppModule"
        @Volatile
        private var engine: LlamaCppEngine? = null
        private var fileManager: ModelFileManager? = null
        private var importer: ModelImporter? = null

        fun onTrimMemory(level: Int) {
            engine?.trimMemory(level)
        }

        fun onLowMemory() {
            engine?.unload()
        }
    }

    private val engineInstance: LlamaCppEngine
        get() = engine ?: synchronized(this) {
            engine ?: LlamaCppEngine.getInstance(reactApplicationContext).also { engine = it }
        }

    private val fileManagerInstance: ModelFileManager
        get() = fileManager ?: synchronized(this) {
            fileManager ?: ModelFileManager(reactApplicationContext).also { fileManager = it }
        }

    private val importerInstance: ModelImporter
        get() = importer ?: synchronized(this) {
            importer ?: ModelImporter(reactApplicationContext, fileManagerInstance).also { importer = it }
        }

    override fun getName(): String = "LlamaCpp"

    // ── ReactMethod ──────────────────────────────

    @ReactMethod
    fun getCapabilities(promise: Promise) {
        try {
            val memoryInfo = engineInstance.checkAvailableMemory()
            val result = Arguments.createMap().apply {
                putBoolean("available", true)
                putBoolean("cpuSupported", true)
                putDouble("freeMemoryMB", memoryInfo.availableMB.toDouble())
                putDouble("totalMemoryMB", memoryInfo.totalMB.toDouble())
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject(LlamaCppErrors.ENGINE_UNAVAILABLE, e.message, e)
        }
    }

    @ReactMethod
    fun importModel(sourceUri: String, originalFilename: String, displayName: String, promise: Promise) {
        try {
            LlamaCppNotification.createChannel(reactApplicationContext)
            val importId = importerInstance.importModel(
                sourceUri = sourceUri,
                originalFilename = originalFilename,
                displayName = displayName,
                onProgress = { id, bytesCopied, totalBytes ->
                    sendEvent(LlamaCppEvents.IMPORT_PROGRESS, Arguments.createMap().apply {
                        putString("importId", id)
                        putDouble("bytesCopied", bytesCopied.toDouble())
                        putDouble("totalBytes", totalBytes.toDouble())
                        putInt("percent", if (totalBytes > 0) (bytesCopied * 100 / totalBytes).toInt() else 0)
                    })
                },
                onStateChanged = { id, state ->
                    sendEvent(LlamaCppEvents.IMPORT_STATE, Arguments.createMap().apply {
                        putString("importId", id)
                        putString("state", state)
                    })
                },
                onComplete = { result ->
                    val map = Arguments.createMap().apply {
                        putString("importId", result.importId)
                        putString("originalFilename", result.originalFilename)
                        putString("displayName", result.displayName)
                        putDouble("fileSize", result.fileSize.toDouble())
                        putString("sha256", result.sha256)
                        putString("stagingRelativePath", result.stagingRelativePath)
                    }
                    promise.resolve(map)
                },
                onError = { id, code, message ->
                    promise.reject(code, message)
                },
            )
        } catch (e: Exception) {
            promise.reject(LlamaCppErrors.IMPORT_COPY_FAILED, e.message, e)
        }
    }

    @ReactMethod
    fun validateModel(modelId: String, relativePath: String, promise: Promise) {
        try {
            val absolutePath = fileManagerInstance.resolveModelPath(relativePath).absolutePath
            val result = engineInstance.load(modelId, absolutePath)
            if (result.isSuccess) {
                val loadResult = result.getOrNull()!!
                val map = Arguments.createMap().apply {
                    putString("backend", loadResult.backend)
                    putDouble("loadTimeMs", loadResult.loadTimeMs.toDouble())
                }
                engineInstance.unload()
                promise.resolve(map)
            } else {
                promise.reject(LlamaCppErrors.MODEL_LOAD_FAILED, result.exceptionOrNull()?.message)
            }
        } catch (e: Exception) {
            promise.reject(LlamaCppErrors.MODEL_LOAD_FAILED, e.message, e)
        }
    }

    @ReactMethod
    fun loadModel(modelId: String, relativePath: String, promise: Promise) {
        try {
            val absolutePath = fileManagerInstance.resolveModelPath(relativePath).absolutePath
            val result = engineInstance.load(modelId, absolutePath)
            if (result.isSuccess) {
                val loadResult = result.getOrNull()!!
                val map = Arguments.createMap().apply {
                    putString("backend", loadResult.backend)
                    putDouble("loadTimeMs", loadResult.loadTimeMs.toDouble())
                }
                promise.resolve(map)
            } else {
                promise.reject(LlamaCppErrors.MODEL_LOAD_FAILED, result.exceptionOrNull()?.message)
            }
        } catch (e: Exception) {
            promise.reject(LlamaCppErrors.MODEL_LOAD_FAILED, e.message, e)
        }
    }

    @ReactMethod
    fun generate(requestId: String, modelId: String, request: ReadableMap, promise: Promise) {
        try {
            val messagesArray = request.getArray("messages") ?: throw Exception("缺少 messages 参数")
            val prompt = buildPromptFromMessages(messagesArray)
            val maxTokens = if (request.hasKey("max_tokens")) request.getInt("max_tokens") else 512
            val temperature = if (request.hasKey("temperature")) request.getDouble("temperature").toFloat() else 0.8f
            val topP = if (request.hasKey("top_p")) request.getDouble("top_p").toFloat() else 0.9f

            engineInstance.generate(
                requestId = requestId,
                prompt = prompt,
                opts = GenerateOptions(maxTokens = maxTokens, temperature = temperature, topP = topP),
                onToken = { reqId, delta, sequence ->
                    sendEvent(LlamaCppEvents.TOKEN, Arguments.createMap().apply {
                        putString("requestId", reqId)
                        putString("delta", delta)
                        putInt("sequence", sequence)
                    })
                },
                onComplete = { reqId, text, outputTokens, tokensPerSecond, elapsedMs ->
                    sendEvent(LlamaCppEvents.COMPLETED, Arguments.createMap().apply {
                        putString("requestId", reqId)
                        putString("text", text)
                        putInt("outputTokens", outputTokens)
                        putDouble("tokensPerSecond", tokensPerSecond.toDouble())
                        putInt("elapsedMs", elapsedMs)
                    })
                },
                onError = { reqId, message ->
                    sendEvent(LlamaCppEvents.ERROR, Arguments.createMap().apply {
                        putString("requestId", reqId)
                        putString("code", LlamaCppErrors.GENERATION_FAILED)
                        putString("message", message)
                    })
                },
            )
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject(LlamaCppErrors.GENERATION_FAILED, e.message, e)
        }
    }

    @ReactMethod
    fun cancel(requestId: String, promise: Promise) {
        engineInstance.cancel()
        promise.resolve(null)
    }

    @ReactMethod
    fun unloadModel(promise: Promise) {
        engineInstance.unload()
        promise.resolve(null)
    }

    @ReactMethod
    fun deleteModelFiles(modelId: String, relativePath: String, promise: Promise) {
        try {
            val deleted = fileManagerInstance.deleteModelFiles(relativePath)
            if (deleted) {
                promise.resolve(null)
            } else {
                promise.reject(LlamaCppErrors.DELETE_FAILED, "删除模型文件失败")
            }
        } catch (e: Exception) {
            promise.reject(LlamaCppErrors.DELETE_FAILED, e.message, e)
        }
    }

    @ReactMethod
    fun modelFileExists(relativePath: String, promise: Promise) {
        promise.resolve(fileManagerInstance.modelFileExists(relativePath))
    }

    @ReactMethod
    fun cleanupStagingFiles(promise: Promise) {
        promise.resolve(fileManagerInstance.cleanupStagingFiles())
    }

    // ── RN 事件发射 ──────────────────────────────
    private fun sendEvent(eventName: String, params: WritableMap?) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required for RN event emitter
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required for RN event emitter
    }

    // ── 辅助方法 ─────────────────────────────────
    private fun buildPromptFromMessages(messagesArray: ReadableArray): String {
        val sb = StringBuilder()
        for (i in 0 until messagesArray.size()) {
            val msg = messagesArray.getMap(i)
            val role = msg.getString("role") ?: "user"
            val content = msg.getString("content") ?: ""
            when (role) {
                "system" -> sb.append("<|im_start|>system\n$content<|im_end|>\n")
                "user" -> sb.append("<|im_start|>user\n$content<|im_end|>\n")
                "assistant" -> sb.append("<|im_start|>assistant\n$content<|im_end|>\n")
            }
        }
        sb.append("<|im_start|>assistant\n")
        return sb.toString()
    }
}
```

**注意：** `buildPromptFromMessages` 默认使用 chatml 格式。在 Phase 5 中，TS 侧会根据 `prompt_template` 类型预先格式化 prompt，Kotlin 侧只需要将格式化后的字符串直接传给 llama.cpp。但为了简单起见，这里保留一个基本的 chatml 回退逻辑。最终版本中，TS 侧格式化后的 prompt 将直接传入 `generate()`，Kotlin 侧不再做二次格式化。

### Task 3.10: 编写 LlamaCppPackage.kt

**文件：** `android/app/src/main/java/com/shinewriter/llamacpp/LlamaCppPackage.kt`

```kotlin
package com.shinewriter.llamacpp

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class LlamaCppPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(LlamaCppModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
```

### Task 3.11: 修改 MainApplication.kt — 注册 LlamaCppPackage

**文件：** `android/app/src/main/java/com/shinewriter/MainApplication.kt`

```kotlin
package com.shinewriter

import android.app.Application
import android.content.ComponentCallbacks2
import android.content.res.Configuration
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.shinewriter.llamacpp.LlamaCppModule
import com.shinewriter.llamacpp.LlamaCppPackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(TtsAudioPackage())
          add(PipelineForegroundPackage())
          add(PngMetadataPackage())
          add(LlamaCppPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    registerComponentCallbacks(object : ComponentCallbacks2 {
      override fun onTrimMemory(level: Int) {
        if (level >= ComponentCallbacks2.TRIM_MEMORY_MODERATE) {
          LlamaCppModule.onTrimMemory(level)
        }
      }

      override fun onConfigurationChanged(newConfig: Configuration) {
        // No-op.
      }

      override fun onLowMemory() {
        LlamaCppModule.onLowMemory()
      }
    })
  }
}
```

### Task 3.12: 修改 AndroidManifest.xml — 新增 LlamaCppForegroundService

**文件：** `android/app/src/main/AndroidManifest.xml`

在 `<application>` 内添加：

```xml
      <service
        android:name=".llamacpp.LlamaCppForegroundService"
        android:exported="false"
        android:foregroundServiceType="dataSync" />
```

### Task 3.13: 编译验证

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini\android
.\gradlew :app:assembleDebug
```

**注意：** JNI 层的 `GenerationCallback` 接口需要在 `llamacpp_jni.cpp` 中通过 JNI 调用。由于 JNI 的复杂性，Kotlin 接口和 C++ 回调之间的桥接可能需要调整。一个简化方案是：C++ 层直接通过 `DeviceEventEmitter` 发送事件，而不是通过 JNI callback 对象。这需要在 `llamacpp_jni.cpp` 中获取 `ReactApplicationContext` 的引用。

**替代方案：** 将 `nativeGenerate` 的回调参数改为纯事件模式，C++ 生成完成后直接通过 JNI 调用 Java 方法来 emit RN 事件。这样可以避免复杂的 JNI callback 桥接。具体实现根据 Spike 结果调整。

### Task 3.14: Phase 3 提交

```bash
git add android/app/src/main/java/com/shinewriter/llamacpp/ android/app/src/main/java/com/shinewriter/MainApplication.kt android/app/src/main/AndroidManifest.xml
git commit -m "feat: add Kotlin LlamaCppModule + LlamaCppEngine native module

- LlamaCppModule: ReactMethod bridge (import/validate/load/generate/cancel/unload/delete)
- LlamaCppEngine: JNI wrapper with memory safety check
- GgufValidator: GGUF file header validation
- ModelFileManager: path-safe file management
- ModelImporter: streaming .gguf import with SHA-256
- LlamaCppForegroundService: import notification
- LlamaCppNotification: notification channel"
```

---

## Phase 4: 数据库迁移 v12→v13

> **目标：** 新增 `prompt_template` 和 `actual_backend` 字段，迁移旧 litertlm 记录。

### Task 4.1: 编写迁移脚本

**文件：** `src/services/migrations/v12-to-v13.ts`

```ts
import type SQLite from 'react-native-sqlite-storage';

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

async function tableColumns(db: SQLite.SQLiteDatabase, table: string): Promise<Set<string>> {
  const result = await execute(db, `PRAGMA table_info(${table})`);
  const columns = new Set<string>();
  for (let i = 0; i < result.rows.length; i += 1) {
    columns.add(result.rows.item(i).name);
  }
  return columns;
}

export async function migrateV12toV13(db: SQLite.SQLiteDatabase): Promise<void> {
  // 1. local_llm_models 表新增 prompt_template 列
  const modelColumns = await tableColumns(db, 'local_llm_models');
  if (!modelColumns.has('prompt_template')) {
    await execute(db, "ALTER TABLE local_llm_models ADD COLUMN prompt_template TEXT DEFAULT 'chatml'");
  }

  // 2. local_llm_models 表新增 actual_backend 列
  if (!modelColumns.has('actual_backend')) {
    await execute(db, 'ALTER TABLE local_llm_models ADD COLUMN actual_backend TEXT DEFAULT NULL');
  }

  // 3. 旧 litertlm 记录标记为不可用
  await execute(db, `
    UPDATE local_llm_models
    SET status = 'unavailable',
        error_message = 'LiteRT-LM 引擎已移除，请重新导入 GGUF 模型'
    WHERE provider_engine = 'litertlm' AND status != 'unavailable'
  `);

  // 4. llm_config 表中 provider_type 迁移
  await execute(db, `
    UPDATE llm_config SET provider_type = 'llama_cpp' WHERE provider_type = 'local_litertlm'
  `);

  // 5. llm_config 表中 local_backend 简化为 cpu
  await execute(db, `
    UPDATE llm_config SET local_backend = 'cpu' WHERE provider_type = 'llama_cpp'
  `);

  // 6. 更新 local_llm_models 的 provider_engine 默认值逻辑
  // SQLite 不支持 ALTER COLUMN，所以新记录默认值通过 TS 层保证
  // 已有的非 litertlm 记录（理论上不存在）保持不变
}
```

### Task 4.2: 更新迁移注册

**文件：** `src/services/migrations/index.ts`

在现有 import 后添加：

```ts
import { migrateV12toV13 } from './v12-to-v13';
```

修改：

```ts
export const SCHEMA_VERSION = 13;
```

在 `MIGRATIONS` 数组末尾添加：

```ts
  { from: 12, to: 13, breaking: false, migrate: migrateV12toV13 },
```

### Task 4.3: 更新 localModel.ts 类型定义

**文件：** `src/types/localModel.ts`

```ts
export type LocalModelProviderEngine = 'llama_cpp';

export type LocalModelStatus =
  | 'importing'
  | 'copying'
  | 'hashing'
  | 'validating'
  | 'ready'
  | 'error'
  | 'missing'
  | 'unavailable';

export type PromptTemplate = 'chatml' | 'llama3' | 'alpaca' | 'qwen' | 'phi' | 'mistral' | 'custom';

export interface LocalModel {
  id: string;
  display_name: string;
  original_filename: string;
  relative_path: string;
  file_size: number;
  sha256: string;
  provider_engine: LocalModelProviderEngine;
  status: LocalModelStatus;
  validated_backend: string | null;
  context_length: number | null;
  max_output_tokens: number | null;
  load_time_ms: number | null;
  prompt_template: PromptTemplate;
  actual_backend: string | null;
  imported_at: string;
  last_used_at: string | null;
  last_validated_at: string | null;
  error_code: string | null;
  error_message: string | null;
}
```

### Task 4.4: 更新 novel.ts 类型定义

**文件：** `src/types/novel.ts`

修改 `LLMProviderType`：

```ts
export type LLMProviderType = 'openai_compatible' | 'llama_cpp';
```

修改 `LLMConfig.local_backend`：

```ts
export interface LLMConfig {
  id: number;
  name: string;
  provider_type: LLMProviderType;
  base_url: string;
  api_key: string;
  model_name: string;
  is_active: number;
  local_model_id: string | null;
  local_backend: 'cpu' | null;
  context_window: number;
  max_output_tokens: number;
}
```

### Task 4.5: 更新 llm/types.ts

**文件：** `src/services/llm/types.ts`

```ts
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResult {
  text: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  errorCode?: string;
  rawUsage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface LLMGenerateOptions {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  scenario?: string;
  projectId?: number;
  requestConfig?: LLMRequestConfig;
}

export type LLMProviderType = 'openai_compatible' | 'llama_cpp';

export interface LLMRequestConfig {
  id?: number;
  name?: string;
  provider_type: LLMProviderType;
  api_key: string;
  model_name: string;
  url: string;
  local_model_id?: string;
  local_model_path?: string;
  local_backend?: 'cpu';
  context_window?: number;
  max_output_tokens?: number;
  prompt_template?: string;
}
```

### Task 4.6: 编写迁移单测

**文件：** `__tests__/v12-to-v13.test.ts`

```ts
import { migrateV12toV13 } from '../src/services/migrations/v12-to-v13';

// 手动 mock SQLite
function createMockDb(tables: Record<string, any[]> = {}) {
  const sqlLog: string[] = [];
  const mockDb = {
    executeSql: jest.fn(async (sql: string, params: any[] = []) => {
      sqlLog.push(sql);
      // PRAGMA table_info
      if (sql.includes('PRAGMA table_info')) {
        const table = sql.match(/table_info\((\w+)\)/)?.[1] || '';
        const columns = tables[table] || [];
        return [{
          rows: {
            length: columns.length,
            item: (i: number) => columns[i],
          },
        }];
      }
      return [{ rows: { length: 0, item: () => ({}) }, insertId: 0 }];
    }),
    transaction: jest.fn(async (fn: Function) => {
      await fn(mockDb);
    }),
    _sqlLog: sqlLog,
  };
  return mockDb;
}

describe('migrateV12toV13', () => {
  it('should add prompt_template and actual_backend columns if missing', async () => {
    const db = createMockDb({
      local_llm_models: [
        { name: 'id' },
        { name: 'display_name' },
        // prompt_template and actual_backend are missing
      ],
    });

    await migrateV12toV13(db as any);

    const alterCalls = db._sqlLog.filter(s => s.includes('ALTER TABLE'));
    expect(alterCalls).toHaveLength(2);
    expect(alterCalls[0]).toContain('prompt_template');
    expect(alterCalls[1]).toContain('actual_backend');
  });

  it('should not add columns if they already exist', async () => {
    const db = createMockDb({
      local_llm_models: [
        { name: 'id' },
        { name: 'display_name' },
        { name: 'prompt_template' },
        { name: 'actual_backend' },
      ],
    });

    await migrateV12toV13(db as any);

    const alterCalls = db._sqlLog.filter(s => s.includes('ALTER TABLE'));
    expect(alterCalls).toHaveLength(0);
  });

  it('should mark litertlm models as unavailable', async () => {
    const db = createMockDb({
      local_llm_models: [{ name: 'prompt_template' }, { name: 'actual_backend' }],
    });

    await migrateV12toV13(db as any);

    const updateCalls = db._sqlLog.filter(s => s.includes("provider_engine = 'litertlm'"));
    expect(updateCalls.length).toBeGreaterThan(0);
  });

  it('should migrate llm_config provider_type from local_litertlm to llama_cpp', async () => {
    const db = createMockDb({
      local_llm_models: [{ name: 'prompt_template' }, { name: 'actual_backend' }],
    });

    await migrateV12toV13(db as any);

    const updateCalls = db._sqlLog.filter(s => s.includes("provider_type = 'llama_cpp'"));
    expect(updateCalls.length).toBeGreaterThan(0);
  });
});
```

### Task 4.7: 运行迁移单测

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini
npx jest __tests__/v12-to-v13.test.ts
```

### Task 4.8: Phase 4 提交

```bash
git add src/services/migrations/ src/types/localModel.ts src/types/novel.ts src/services/llm/types.ts __tests__/v12-to-v13.test.ts
git commit -m "feat: database migration v12→v13 for llama.cpp

- Add prompt_template and actual_backend columns to local_llm_models
- Mark litertlm models as unavailable
- Migrate llm_config provider_type from local_litertlm to llama_cpp
- Simplify local_backend to 'cpu' only
- Update TypeScript type definitions
- Add migration unit tests"
```

---

## Phase 5: TypeScript LlamaCppProvider + prompt adapter

> **目标：** 实现完整的 TS 侧 LLM 提供者和 prompt 模板系统。

### Task 5.1: 编写 LlamaCppModule.ts（TS 桥接）

**文件：** `src/native/LlamaCppModule.ts`

```ts
import {
  NativeModules,
  DeviceEventEmitter,
  type EmitterSubscription,
} from 'react-native';

export interface LlamaCppCapabilities {
  available: boolean;
  cpuSupported: boolean;
  freeMemoryMB: number;
  totalMemoryMB: number;
}

export interface NativeImportResult {
  importId: string;
  originalFilename: string;
  displayName: string;
  fileSize: number;
  sha256: string;
  stagingRelativePath: string;
}

export interface NativeValidationResult {
  backend: string;
  loadTimeMs: number;
}

export interface NativeLoadResult {
  backend: string;
  loadTimeMs: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface NativeGenerationRequest {
  messages: ChatMessage[];
  max_tokens: number;
  temperature: number;
  top_p: number;
}

export interface LlamaCppTokenEvent {
  requestId: string;
  delta: string;
  sequence: number;
}

export interface LlamaCppCompletedEvent {
  requestId: string;
  text: string;
  outputTokens: number;
  tokensPerSecond: number;
  elapsedMs: number;
}

export interface LlamaCppErrorEvent {
  requestId: string;
  code: string;
  message: string;
}

export interface LlamaCppImportProgressEvent {
  importId: string;
  bytesCopied: number;
  totalBytes: number;
  percent: number;
}

export interface LlamaCppImportStateEvent {
  importId: string;
  state: string;
}

interface LlamaCppNative {
  getCapabilities(): Promise<LlamaCppCapabilities>;
  importModel(
    sourceUri: string,
    originalFilename: string,
    displayName: string,
  ): Promise<NativeImportResult>;
  validateModel(
    modelId: string,
    relativePath: string,
  ): Promise<NativeValidationResult>;
  loadModel(
    modelId: string,
    relativePath: string,
  ): Promise<NativeLoadResult>;
  generate(
    requestId: string,
    modelId: string,
    request: NativeGenerationRequest,
  ): Promise<void>;
  cancel(requestId: string): Promise<void>;
  unloadModel(): Promise<void>;
  deleteModelFiles(modelId: string, relativePath: string): Promise<void>;
  modelFileExists(relativePath: string): Promise<boolean>;
  cleanupStagingFiles(): Promise<number>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export const LlamaCpp = NativeModules.LlamaCpp as LlamaCppNative | undefined;

const globalListeners = new Map<string, EmitterSubscription>();
const requestCallbacks = new Map<string, (event: any) => void>();
const importObservers = new Map<string, (event: any) => void>();

export function ensureGlobalEventListener(eventName: string) {
  if (globalListeners.has(eventName)) return;
  const sub = DeviceEventEmitter.addListener(eventName, (event: any) => {
    const importId = event?.importId;
    if (importId) {
      importObservers.get(importId)?.(event);
      return;
    }
    const requestId = event?.requestId;
    if (requestId) {
      requestCallbacks.get(requestId)?.(event);
    }
  });
  globalListeners.set(eventName, sub);
}

export function registerRequestCallback(key: string, callback: (event: any) => void) {
  requestCallbacks.set(key, callback);
}

export function unregisterRequestCallback(key: string) {
  requestCallbacks.delete(key);
}

export function observeImport(importId: string, callback: (event: any) => void) {
  importObservers.set(importId, callback);
}

export function unobserveImport(importId: string) {
  importObservers.delete(importId);
}

export function removeGlobalEventListener(eventName: string) {
  const sub = globalListeners.get(eventName);
  if (sub) {
    sub.remove();
    globalListeners.delete(eventName);
  }
}
```

### Task 5.2: 编写 llamaCppPromptAdapter.ts

**文件：** `src/services/llm/llamaCppPromptAdapter.ts`

```ts
import type { PromptTemplate } from '../../types/localModel';
import type { ChatMessage } from './types';

export function applyPromptTemplate(
  template: PromptTemplate,
  messages: ChatMessage[],
): string {
  switch (template) {
    case 'chatml':
      return formatChatML(messages);
    case 'llama3':
      return formatLlama3(messages);
    case 'qwen':
      return formatChatML(messages); // Qwen uses ChatML
    case 'alpaca':
      return formatAlpaca(messages);
    case 'phi':
      return formatPhi(messages);
    case 'mistral':
      return formatMistral(messages);
    case 'custom':
      return formatChatML(messages); // fallback to ChatML
    default:
      return formatChatML(messages);
  }
}

function formatChatML(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    parts.push(`<|im_start|>${msg.role}\n${msg.content}<|im_end|>\n`);
  }
  parts.push('<|im_start|>assistant\n');
  return parts.join('');
}

function formatLlama3(messages: ChatMessage[]): string {
  const parts: string[] = ['<|begin_of_text|>'];
  for (const msg of messages) {
    parts.push(`<|start_header_id|>${msg.role}<|end_header_id|>\n\n${msg.content}<|eot_id|>`);
  }
  parts.push('<|start_header_id|>assistant<|end_header_id|>\n\n');
  return parts.join('');
}

function formatAlpaca(messages: ChatMessage[]): string {
  const system = messages.find(m => m.role === 'system')?.content || '';
  const nonSystem = messages.filter(m => m.role !== 'system');

  let prompt = '';
  if (system) {
    prompt += `### Instruction:\n${system}\n\n`;
  }

  for (const msg of nonSystem) {
    if (msg.role === 'user') {
      prompt += `### Input:\n${msg.content}\n\n`;
    } else if (msg.role === 'assistant') {
      prompt += `### Response:\n${msg.content}\n\n`;
    }
  }

  prompt += '### Response:\n';
  return prompt;
}

function formatPhi(messages: ChatMessage[]): string {
  const system = messages.find(m => m.role === 'system')?.content || '';
  const nonSystem = messages.filter(m => m.role !== 'system');

  let prompt = '';
  if (system) {
    prompt += `<|system|>\n${system}<|end|>\n`;
  }

  for (const msg of nonSystem) {
    prompt += `<|${msg.role}|>\n${msg.content}<|end|>\n`;
  }

  prompt += '<|assistant|>\n';
  return prompt;
}

function formatMistral(messages: ChatMessage[]): string {
  const system = messages.find(m => m.role === 'system')?.content || '';
  const nonSystem = messages.filter(m => m.role !== 'system');

  let prompt = '<s>';
  if (system) {
    prompt += `[INST] ${system}\n\n`;
  }

  for (let i = 0; i < nonSystem.length; i++) {
    const msg = nonSystem[i];
    if (msg.role === 'user') {
      prompt += `${msg.content} [/INST] `;
    } else if (msg.role === 'assistant') {
      prompt += `${msg.content}</s> `;
      if (i < nonSystem.length - 1) {
        prompt += '<s>[INST] ';
      }
    }
  }

  return prompt;
}
```

### Task 5.3: 编写 prompt 模板单测

**文件：** `__tests__/llamaCppPromptAdapter.test.ts`

```ts
import { applyPromptTemplate } from '../src/services/llm/llamaCppPromptAdapter';
import type { ChatMessage } from '../src/services/llm/types';

const sampleMessages: ChatMessage[] = [
  { role: 'system', content: '你是一个小说写作助手。' },
  { role: 'user', content: '请续写以下内容' },
  { role: 'assistant', content: '好的，我来续写。' },
  { role: 'user', content: '继续' },
];

describe('applyPromptTemplate', () => {
  it('should format ChatML correctly', () => {
    const result = applyPromptTemplate('chatml', sampleMessages);
    expect(result).toContain('<|im_start|>system');
    expect(result).toContain('<|im_start|>user');
    expect(result).toContain('<|im_start|>assistant');
    expect(result).toContain('<|im_end|>');
    expect(result).toMatch(/<\|im_start\|>assistant\n$/);
  });

  it('should format Llama3 correctly', () => {
    const result = applyPromptTemplate('llama3', sampleMessages);
    expect(result).toContain('<|begin_of_text|>');
    expect(result).toContain('<|start_header_id|>system<|end_header_id|>');
    expect(result).toContain('<|eot_id|>');
    expect(result).toMatch(/<\|start_header_id\|>assistant<\|end_header_id\|>/);
  });

  it('should format Alpaca correctly', () => {
    const result = applyPromptTemplate('alpaca', sampleMessages);
    expect(result).toContain('### Instruction:');
    expect(result).toContain('### Input:');
    expect(result).toContain('### Response:');
  });

  it('should format Phi correctly', () => {
    const result = applyPromptTemplate('phi', sampleMessages);
    expect(result).toContain('<|system|>');
    expect(result).toContain('<|user|>');
    expect(result).toContain('<|assistant|>');
    expect(result).toContain('<|end|>');
  });

  it('should format Mistral correctly', () => {
    const result = applyPromptTemplate('mistral', sampleMessages);
    expect(result).toContain('<s>');
    expect(result).toContain('[INST]');
    expect(result).toContain('[/INST]');
  });

  it('should use ChatML for qwen template', () => {
    const result = applyPromptTemplate('qwen', sampleMessages);
    expect(result).toContain('<|im_start|>');
  });

  it('should use ChatML for custom template (fallback)', () => {
    const result = applyPromptTemplate('custom', sampleMessages);
    expect(result).toContain('<|im_start|>');
  });

  it('should handle empty messages', () => {
    const result = applyPromptTemplate('chatml', []);
    expect(result).toBe('<|im_start|>assistant\n');
  });

  it('should handle messages without system prompt', () => {
    const noSystem: ChatMessage[] = [
      { role: 'user', content: '你好' },
    ];
    const result = applyPromptTemplate('chatml', noSystem);
    expect(result).toContain('<|im_start|>user\n你好<|im_end|>');
    expect(result).not.toContain('<|im_start|>system');
  });
});
```

### Task 5.4: 运行 prompt 模板单测

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini
npx jest __tests__/llamaCppPromptAdapter.test.ts
```

### Task 5.5: 编写 LlamaCppProvider

**文件：** `src/services/llm/llamaCppProvider.ts`

```ts
import {
  LlamaCpp,
  ensureGlobalEventListener,
  registerRequestCallback,
  unregisterRequestCallback,
} from '../../native/LlamaCppModule';
import { getLocalModelById, updateLocalModel } from '../localModels';
import { applyPromptTemplate } from './llamaCppPromptAdapter';
import { adaptMessagesForLocalModel } from './promptAdapter';
import type { LLMProvider } from '../../types/llmProvider';
import type { ChatMessage, LLMGenerateOptions, LLMRequestConfig, LLMResult } from './types';
import * as db from '../database';
import { estimateMessagesTokens, estimateTokens } from '../../utils/tokenEstimator';
import type { PromptTemplate } from '../../types/localModel';

export const llamaCppProvider: LLMProvider = {
  type: 'llama_cpp',

  async test(config: LLMRequestConfig): Promise<string> {
    if (!config.local_model_id) {
      throw new Error('请选择一个已经导入且验证可用的本地模型。');
    }
    const model = await getLocalModelById(config.local_model_id);
    if (!model || model.status !== 'ready') {
      throw new Error('本地模型不可用。');
    }
    if (!LlamaCpp) {
      throw new Error('本地模型引擎尚未就绪，请检查应用安装或系统兼容性。');
    }
    await LlamaCpp.loadModel(model.id, model.relative_path);
    return '本地模型已就绪';
  },

  async generate(
    messages: ChatMessage[],
    options: LLMGenerateOptions,
    signal?: AbortSignal,
  ): Promise<LLMResult> {
    const config = options.requestConfig as LLMRequestConfig | undefined;
    if (!config) {
      throw new Error('缺少 LLM 请求配置');
    }
    if (!config.local_model_id) {
      throw new Error('缺少本地模型');
    }
    const model = await getLocalModelById(config.local_model_id);
    if (!model || model.status !== 'ready') {
      throw new Error('本地模型不可用');
    }
    if (!LlamaCpp) {
      throw new Error('本地模型引擎尚未就绪，请检查应用安装或系统兼容性。');
    }

    const contextWindow = config.context_window ?? 4096;
    const maxOutputTokens = Math.min(config.max_output_tokens ?? 512, 4096);
    const promptTemplate = (config.prompt_template || model.prompt_template || 'chatml') as PromptTemplate;
    const adapted = adaptMessagesForLocalModel(messages, contextWindow, maxOutputTokens);

    // 应用 prompt 模板
    const prompt = applyPromptTemplate(promptTemplate, adapted);

    await LlamaCpp.loadModel(model.id, model.relative_path);
    const requestId = `llama-${Date.now()}`;

    ensureGlobalEventListener('LlamaCppToken');
    ensureGlobalEventListener('LlamaCppCompleted');
    ensureGlobalEventListener('LlamaCppError');

    return new Promise((resolve, reject) => {
      let text = '';
      let completed = false;

      const finish = (result: LLMResult) => {
        if (completed) return;
        completed = true;
        unregisterRequestCallback(requestId);
        resolve(result);
      };

      const fail = (error: Error) => {
        if (completed) return;
        completed = true;
        unregisterRequestCallback(requestId);
        reject(error);
      };

      registerRequestCallback(requestId, (event: any) => {
        if (event?.delta !== undefined) {
          text += event.delta;
          return;
        }
        if (event?.text !== undefined && event.outputTokens !== undefined) {
          const finalText = event.text ?? text;
          const inputTokens = estimateMessagesTokens(adapted);
          const outputTokens = event.outputTokens ?? estimateTokens(finalText);
          const totalTokens = inputTokens + outputTokens;

          db.logLLMUsage({
            scenario: options.scenario || 'local_chat',
            inputTokens,
            outputTokens,
            totalTokens,
            status: 'success',
            modelName: config.model_name,
            projectId: options.projectId,
            llmConfigId: config.id,
            llmConfigName: config.name,
          }).catch(() => {});
          updateLocalModel(model.id, { last_used_at: new Date().toISOString() }).catch(() => {});

          finish({
            text: finalText,
            inputTokens,
            outputTokens,
            totalTokens,
            rawUsage: {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: totalTokens,
            },
          });
          return;
        }
        if (event?.code !== undefined) {
          fail(new Error(event.message || '本地模型生成失败'));
        }
      });

      const onAbort = () => {
        LlamaCpp?.cancel(requestId).catch(() => {});
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      LlamaCpp.generate(requestId, model.id, {
        messages: adapted,
        max_tokens: maxOutputTokens,
        temperature: options.temperature ?? 0.8,
        top_p: options.top_p ?? 0.9,
      }).catch((error: any) => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
  },
};
```

### Task 5.6: 更新 providerRegistry.ts

**文件：** `src/services/llm/providerRegistry.ts`

```ts
import { openAICompatibleProvider } from './openAICompatibleProvider';
import { llamaCppProvider } from './llamaCppProvider';
import type { LLMProvider } from '../../types/llmProvider';
import type { LLMProviderType } from './types';

const providers: Record<LLMProviderType, LLMProvider> = {
  openai_compatible: openAICompatibleProvider,
  llama_cpp: llamaCppProvider,
};

export function getProvider(type: LLMProviderType): LLMProvider {
  return providers[type];
}
```

### Task 5.7: 更新 localModels.ts

**文件：** `src/services/localModels.ts`

```ts
import { LlamaCpp } from '../native/LlamaCppModule';
import type { LocalModel, LocalModelStatus, PromptTemplate } from '../types/localModel';
import {
  listLocalModels as dbListLocalModels,
  getLocalModelById as dbGetLocalModelById,
  getLocalModelBySha256 as dbGetLocalModelBySha256,
  createLocalModel as dbCreateLocalModel,
  updateLocalModel as dbUpdateLocalModel,
  deleteLocalModelRecord as dbDeleteLocalModelRecord,
  countLLMConfigsUsingModel as dbCountLLMConfigsUsingModel,
} from './database';

export type { LocalModel, LocalModelStatus };
export type { PromptTemplate };

export const listLocalModels = dbListLocalModels;
export const getLocalModelById = dbGetLocalModelById;
export const getLocalModelBySha256 = dbGetLocalModelBySha256;
export const createLocalModel = dbCreateLocalModel;
export const updateLocalModel = dbUpdateLocalModel;
export const deleteLocalModelRecord = dbDeleteLocalModelRecord;
export const countLLMConfigsUsingModel = dbCountLLMConfigsUsingModel;

function now(): string {
  return new Date().toISOString();
}

function ensureModule() {
  if (!LlamaCpp) {
    throw new Error('本地模型引擎尚未就绪，请检查应用安装或重新启动。');
  }
}

export async function importLocalModel(
  sourceUri: string,
  originalFilename: string,
  displayName?: string,
): Promise<LocalModel> {
  ensureModule();
  const name = (displayName || originalFilename).replace(/\.gguf$/i, '');
  const result = await LlamaCpp!.importModel(sourceUri, originalFilename, name);

  const existing = await dbGetLocalModelBySha256(result.sha256);
  if (existing) {
    throw new Error('该模型文件已导入，请勿重复导入。');
  }

  const model: LocalModel = {
    id: result.importId,
    display_name: result.displayName || name,
    original_filename: result.originalFilename,
    relative_path: result.stagingRelativePath,
    file_size: result.fileSize,
    sha256: result.sha256,
    provider_engine: 'llama_cpp',
    status: 'validating',
    validated_backend: null,
    context_length: null,
    max_output_tokens: null,
    load_time_ms: null,
    prompt_template: 'chatml',
    actual_backend: null,
    imported_at: now(),
    last_used_at: null,
    last_validated_at: null,
    error_code: null,
    error_message: null,
  };
  await dbCreateLocalModel(model);
  return model;
}

export async function validateLocalModel(model: LocalModel): Promise<void> {
  ensureModule();
  try {
    const result = await LlamaCpp!.validateModel(model.id, model.relative_path);
    await dbUpdateLocalModel(model.id, {
      status: 'ready',
      validated_backend: result.backend,
      context_length: null,
      max_output_tokens: null,
      load_time_ms: result.loadTimeMs,
      actual_backend: 'cpu',
      last_validated_at: now(),
      error_code: null,
      error_message: null,
    });
  } catch (error: any) {
    await dbUpdateLocalModel(model.id, {
      status: 'error',
      error_code: error?.code || 'VALIDATION_FAILED',
      error_message: error?.message || '模型验证失败',
    });
    throw error;
  }
}

export async function loadLocalModel(model: LocalModel) {
  ensureModule();
  return LlamaCpp!.loadModel(model.id, model.relative_path);
}

export async function deleteLocalModel(model: LocalModel): Promise<void> {
  ensureModule();
  const usageCount = await dbCountLLMConfigsUsingModel(model.id);
  if (usageCount > 0) {
    throw new Error('该模型正被 LLM 配置使用，请先删除相关配置。');
  }
  await LlamaCpp!.deleteModelFiles(model.id, model.relative_path);
  await dbDeleteLocalModelRecord(model.id);
}

export async function cleanupOrphanedModels(): Promise<void> {
  const models = await dbListLocalModels();
  for (const model of models) {
    const exists = await LlamaCpp?.modelFileExists(model.relative_path);
    if (!exists && model.status !== 'missing' && model.status !== 'unavailable') {
      await dbUpdateLocalModel(model.id, {
        status: 'missing',
        error_code: 'MODEL_FILE_MISSING',
        error_message: '模型文件已丢失或已被移除',
      });
    }
  }
}

export async function cleanupStagingFiles(): Promise<number> {
  return LlamaCpp?.cleanupStagingFiles() ?? Promise.resolve(0);
}
```

### Task 5.8: 更新 localModelStore.ts

**文件：** `src/store/localModelStore.ts`

```ts
import { create } from 'zustand';
import {
  listLocalModels,
  getLocalModelById,
  importLocalModel,
  validateLocalModel,
  loadLocalModel,
  deleteLocalModel,
} from '../services/localModels';
import type { LocalModel } from '../services/localModels';
import { LlamaCpp, observeImport, unobserveImport } from '../native/LlamaCppModule';

interface ImportState {
  importId: string | null;
  state: 'idle' | 'selecting' | 'copying' | 'validating' | 'ready' | 'error';
  bytesCopied: number;
  totalBytes: number;
  errorCode: string | null;
  errorMessage: string | null;
}

interface LocalModelState {
  models: LocalModel[];
  import: ImportState;
  loadingModelId: string | null;
  loadModel: (modelId: string) => Promise<void>;
  startImport: (sourceUri: string, originalFilename: string, displayName?: string) => Promise<void>;
  cancelImport: () => Promise<void>;
  deleteModel: (modelId: string) => Promise<void>;
  refreshModels: () => Promise<void>;
}

const initialImportState: ImportState = {
  importId: null,
  state: 'idle',
  bytesCopied: 0,
  totalBytes: 0,
  errorCode: null,
  errorMessage: null,
};

export const useLocalModelStore = create<LocalModelState>((set, get) => ({
  models: [],
  import: initialImportState,
  loadingModelId: null,

  refreshModels: async () => {
    const models = await listLocalModels();
    set({ models });
  },

  loadModel: async (modelId) => {
    const model = await getLocalModelById(modelId);
    if (!model) throw new Error('模型不存在');
    set({ loadingModelId: modelId });
    try {
      await loadLocalModel(model);
    } finally {
      set({ loadingModelId: null });
    }
  },

  startImport: async (sourceUri, originalFilename, displayName) => {
    if (!LlamaCpp) {
      throw new Error('本地模型引擎尚未就绪，请检查应用安装或重新启动。');
    }

    set({
      import: {
        ...initialImportState,
        importId: '',
        state: 'selecting',
      },
    });

    let importId = '';
    let observerSet = false;

    try {
      const model = await importLocalModel(sourceUri, originalFilename, displayName);
      importId = model.id;
      observerSet = true;

      observeImport(importId, (event) => {
        if ('bytesCopied' in event) {
          set({
            import: {
              ...get().import,
              importId,
              bytesCopied: event.bytesCopied,
              totalBytes: event.totalBytes,
              state: 'copying',
            },
          });
        } else if ('state' in event) {
          set({
            import: {
              ...get().import,
              importId,
              state: event.state,
            },
          });
        }
      });

      set({
        import: {
          ...get().import,
          importId,
          state: 'validating',
          errorCode: null,
          errorMessage: null,
        },
      });

      await validateLocalModel(model);

      set({
        import: {
          ...get().import,
          importId,
          state: 'ready',
        },
      });

      await get().refreshModels();
    } catch (error: any) {
      set({
        import: {
          ...get().import,
          importId,
          state: 'error',
          errorCode: error?.code || 'IMPORT_FAILED',
          errorMessage: error?.message || '模型导入失败',
        },
      });
      throw error;
    } finally {
      if (observerSet && importId) {
        unobserveImport(importId);
      }
    }
  },

  cancelImport: async () => {
    const { import: importState } = get();
    if (importState.importId && LlamaCpp) {
      try {
        await LlamaCpp.cancel(importState.importId);
      } catch {
        // Cancel best-effort
      }
    }
    set({ import: initialImportState });
  },

  deleteModel: async (modelId) => {
    const model = await getLocalModelById(modelId);
    if (!model) throw new Error('模型不存在');
    await deleteLocalModel(model);
    await get().refreshModels();
  },
}));
```

### Task 5.9: 更新 llm.ts — resolveLLMRequestConfig

**文件：** `src/services/llm.ts`

修改 `resolveLLMRequestConfig`，移除对 `'local_litertlm'` 的特殊处理：

```ts
export async function resolveLLMRequestConfig(): Promise<LLMRequestConfig> {
  const config = await db.getLLMConfig();
  const raw = config as LLMRequestConfig & { base_url?: string };
  const providerType = raw.provider_type || 'openai_compatible';
  return {
    id: config.id,
    name: config.name,
    provider_type: providerType,
    api_key: providerType === 'openai_compatible' ? config.api_key : '',
    model_name: config.model_name,
    url: normalizeChatCompletionUrl(config.base_url),
    local_model_id: raw.local_model_id,
    local_backend: raw.local_backend,
    context_window: raw.context_window,
    max_output_tokens: raw.max_output_tokens,
    prompt_template: (raw as any).prompt_template,
  };
}
```

### Task 5.10: 更新 jest.setup.js — 新增 LlamaCpp mock

**文件：** `jest.setup.js`

在 `RN.NativeModules.PngMetadata = { ... }` 之后添加：

```js
  // Phase 5: LlamaCpp native module mock
  RN.NativeModules.LlamaCpp = {
    getCapabilities: jest.fn(() => Promise.resolve({
      available: true,
      cpuSupported: true,
      freeMemoryMB: 4096,
      totalMemoryMB: 8192,
    })),
    importModel: jest.fn(() => Promise.resolve({
      importId: 'import-1',
      originalFilename: 'model.gguf',
      displayName: 'Test Model',
      fileSize: 1024,
      sha256: 'abc123',
      stagingRelativePath: 'import-1/model.gguf',
    })),
    validateModel: jest.fn(() => Promise.resolve({ backend: 'cpu', loadTimeMs: 100 })),
    loadModel: jest.fn(() => Promise.resolve({ backend: 'cpu', loadTimeMs: 100 })),
    generate: jest.fn(() => Promise.resolve()),
    cancel: jest.fn(() => Promise.resolve()),
    unloadModel: jest.fn(() => Promise.resolve()),
    deleteModelFiles: jest.fn(() => Promise.resolve()),
    modelFileExists: jest.fn(() => Promise.resolve(false)),
    cleanupStagingFiles: jest.fn(() => Promise.resolve(0)),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
```

确认已删除 `RN.NativeModules.LocalLLM` 块（Phase 1 已完成）。

### Task 5.11: 运行全部测试

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini
npm test
```

**预期：** 所有现有测试 + 新增的 prompt 模板测试和迁移测试通过。

### Task 5.12: Phase 5 提交

```bash
git add src/native/LlamaCppModule.ts src/services/llm/llamaCppProvider.ts src/services/llm/llamaCppPromptAdapter.ts src/services/llm/providerRegistry.ts src/services/localModels.ts src/store/localModelStore.ts src/services/llm.ts src/services/llm/types.ts jest.setup.js __tests__/
git commit -m "feat: add LlamaCppProvider + prompt template adapter

- New LlamaCppModule.ts bridge with event handling
- LlamaCppProvider implementing LLMProvider interface
- Prompt template adapter (chatml/llama3/qwen/alpaca/phi/mistral)
- Update localModels.ts to use LlamaCpp native module
- Update localModelStore.ts for GGUF workflow
- Update providerRegistry.ts: local_litertlm → llama_cpp
- Add Jest mock for LlamaCpp module
- Unit tests for prompt adapter + migration"
```

---

## Phase 6: UI 适配

> **目标：** 修改 LLM 设置页和本地模型管理页，适配 GGUF 格式和新的 provider 类型。

### Task 6.1: 更新 LLMSettingsScreen.tsx

**文件：** `src/screens/LLMSettingsScreen.tsx`

主要变更点：

1. SegmentedControl 选项从 `'本地离线模型'` → `'本地 GGUF'`
2. `local_litertlm` → `llama_cpp`
3. `local_backend` 选项从 `auto/gpu/cpu` → 仅 `cpu`
4. 新增 `prompt_template` 下拉选择

```ts
// 修改 emptyDraft
const emptyDraft: LLMConfig = {
  id: 0,
  name: '新配置',
  base_url: '',
  api_key: '',
  model_name: '',
  is_active: 0,
  provider_type: 'openai_compatible',
  local_model_id: null,
  local_backend: null,
  context_window: 4096,
  max_output_tokens: 4000,
};
```

在 SegmentedControl 部分：

```tsx
<SegmentedControl
  value={draft.provider_type}
  options={[
    { value: 'openai_compatible', label: '在线 API' },
    { value: 'llama_cpp', label: '本地 GGUF' },
  ]}
  onChange={(provider_type) => updateDraft({
    provider_type,
    local_backend: provider_type === 'llama_cpp' ? 'cpu' : null,
  })}
/>
```

在本地模式字段区域，移除 `auto`/`gpu` 选项，改为：

```tsx
<View style={styles.section}>
  <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>Prompt 模板</Text>
  <SegmentedControl
    value={(draft as any).prompt_template || 'chatml'}
    options={[
      { value: 'chatml', label: 'ChatML' },
      { value: 'llama3', label: 'Llama 3' },
      { value: 'qwen', label: 'Qwen' },
      { value: 'alpaca', label: 'Alpaca' },
      { value: 'phi', label: 'Phi' },
      { value: 'mistral', label: 'Mistral' },
    ]}
    onChange={(prompt_template) => updateDraft({ prompt_template } as any)}
  />
</View>
```

移除运行后端 SegmentedControl（auto/gpu/cpu），因为只有 CPU。

在 Header subtitle 中：

```tsx
subtitle={`${activeProvider === 'llama_cpp' ? '本地 GGUF 离线模型' : 'OpenAI 兼容 API'} · 当前：${activeName}`}
```

在 `saveAndTest` 中：

```ts
const modelLabel = draft.provider_type === 'llama_cpp'
  ? draft.name || '本地模型'
  : draft.model_name || '当前模型';
```

### Task 6.2: 更新 LocalModelManagerScreen.tsx

**文件：** `src/screens/LocalModelManagerScreen.tsx`

主要变更点：

1. 标题改为「导入并管理 GGUF 离线模型」
2. 导入按钮改为「导入 .gguf 模型」
3. 文件选择过滤器改为 `.gguf`
4. 说明文字更新
5. 模型卡片显示 `prompt_template` 标签
6. `formatStatusLabel` 增加 `unavailable` 状态

```ts
function formatStatusLabel(status: LocalModel['status']): string {
  const labels: Record<LocalModel['status'], string> = {
    importing: '导入中',
    copying: '复制中',
    hashing: '校验中',
    validating: '验证中',
    ready: '可用',
    error: '错误',
    missing: '文件缺失',
    unavailable: '不可用',
  };
  return labels[status] || status;
}
```

Header 修改：

```tsx
<Header
  title="本地模型管理"
  subtitle="导入并管理 GGUF 离线模型"
  action={...}
/>
```

说明卡片：

```tsx
<Card style={styles.noticeCard}>
  <Text style={[styles.noticeText, { color: theme.colors.textSecondary }]}>
    支持 Qwen2.5 / Llama-3 / Mistral / Phi 等 GGUF 量化模型。推荐 Q4_K_M 量化，1-3B 参数模型约需 1.5-3GB 存储空间。模型文件保存在应用私有目录，卸载应用会删除这些文件。
  </Text>
</Card>
```

导入按钮：

```tsx
<Button
  label="导入 .gguf 模型"
  icon={Plus}
  onPress={handleImport}
  disabled={importing || importState.state !== 'idle'}
/>
```

文件选择过滤器修改：

```ts
const handleImport = async () => {
  try {
    const [result] = await pick({
      mode: 'open',
      type: types.allFiles,
    });
    if (!result.name?.toLowerCase().endsWith('.gguf')) {
      Alert.alert('无法导入', '请选择扩展名为 .gguf 的模型文件。');
      return;
    }
    setImporting(true);
    await startImport(result.uri, result.name);
    Toast.show({ type: 'success', text1: '模型导入成功' });
  } catch (error: any) {
    if (isCancel(error)) return;
    Alert.alert('导入失败', error?.message || '请重试');
  } finally {
    setImporting(false);
  }
};
```

创建配置时的 provider_type 修改：

```ts
const handleCreateConfig = async (model: LocalModel) => {
  try {
    const name = `本地：${model.display_name}`;
    await saveLLMConfig({
      name,
      provider_type: 'llama_cpp',
      base_url: '',
      api_key: '',
      model_name: model.display_name,
      local_model_id: model.id,
      local_backend: 'cpu',
      context_window: model.context_length ?? 4096,
      max_output_tokens: model.max_output_tokens ?? 4000,
    });
    Toast.show({ type: 'success', text1: '已创建本地模型配置' });
    navigation.navigate('LLMSettings');
  } catch (error: any) {
    Alert.alert('创建配置失败', error?.message || '请重试');
  }
};
```

模型卡片中增加 prompt_template 标签：

```tsx
<View style={styles.statsRow}>
  <Stat label="大小" value={formatBytes(model.file_size)} theme={theme.colors.textSecondary} />
  <Stat label="后端" value={model.validated_backend || model.actual_backend || 'cpu'} theme={theme.colors.textSecondary} />
  <Stat label="模板" value={model.prompt_template || 'chatml'} theme={theme.colors.textSecondary} />
  <Stat
    label="加载耗时"
    value={model.load_time_ms ? `${model.load_time_ms}ms` : '-'}
    theme={theme.colors.textSecondary}
  />
</View>
```

空状态描述更新：

```tsx
<Text style={[styles.emptyDesc, { color: theme.colors.textSecondary }]}>
  点击上方按钮导入 .gguf 模型文件。
</Text>
```

### Task 6.3: 更新 LocalModelSelector.tsx

**文件：** `src/components/LocalModelSelector.tsx`

主要变更：过滤掉 `unavailable` 状态的模型。

```ts
const readyModels = models.filter((m) => m.status === 'ready');
```

无需额外修改，因为选择器已经只显示 `ready` 状态的模型。但可以添加对 `unavailable` 模型的提示：

```tsx
const unavailableModels = models.filter((m) => m.status === 'unavailable');
```

在 `readyModels.length === 0` 的空状态中增加提示：

```tsx
if (readyModels.length === 0) {
  return (
    <Card style={styles.emptyCard}>
      <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
        {unavailableModels.length > 0
          ? `${unavailableModels.length} 个旧模型已不可用（LiteRT-LM 已移除），请重新导入 GGUF 模型。`
          : '暂无可用的本地模型，请先到「管理本地模型」页面导入。'}
      </Text>
    </Card>
  );
}
```

### Task 6.4: 更新 database.ts 中的相关函数

检查 `src/services/database.ts` 中涉及 `local_llm_models` 表的 CRUD 函数，确保新增的 `prompt_template` 和 `actual_backend` 字段被正确处理。

需要检查的函数：
- `createLocalModel` — 插入时包含 `prompt_template` 和 `actual_backend`
- `updateLocalModel` — 更新时可能包含这两个字段
- `listLocalModels` / `getLocalModelById` — 查询结果映射

**注意：** 由于 `v11-to-v12` 创建了 `local_llm_models` 表（不含 `prompt_template` 和 `actual_backend`），而 `v12-to-v13` 通过 `ALTER TABLE` 添加了这两个字段，所以 `database.ts` 中的查询和插入语句需要同步更新。

在 `createLocalModel` 函数的 INSERT 语句中添加 `prompt_template` 和 `actual_backend` 字段。

在 `listLocalModels` / `getLocalModelById` 的结果映射中添加：

```ts
prompt_template: row.prompt_template || 'chatml',
actual_backend: row.actual_backend || null,
```

### Task 6.5: 运行测试

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini
npm test
```

### Task 6.6: Phase 6 提交

```bash
git add src/screens/LLMSettingsScreen.tsx src/screens/LocalModelManagerScreen.tsx src/components/LocalModelSelector.tsx src/services/database.ts
git commit -m "feat: UI adaptation for llama.cpp GGUF model support

- LLMSettingsScreen: '在线 API / 本地 GGUF' + prompt template selector
- LocalModelManagerScreen: .gguf file import + updated descriptions
- LocalModelSelector: filter unavailable models + show hint
- database.ts: add prompt_template + actual_backend field handling"
```

---

## Phase 7: 真机集成测试

> **目标：** 在 Vivo V2405A (10AEAF31XQ000UQ) 真机上完整验证。

### Task 7.1: 构建 debug APK

```bash
cd d:\ClaudeCodeWorkSpace\projects\tavo-mini
npm run apk:debug
```

### Task 7.2: 安装到真机

```bash
"C:\Users\Administrator\AppData\Local\Android\Sdk\platform-tools\adb.exe" -s 10AEAF31XQ000UQ install -r dist/apk/debug/ShineWriter-V*.apk
```

### Task 7.3: 验收测试清单

按 SPEC 第 11 节的验收标准逐项检查：

1. **安装后**：设置 → LLM 设置 → 可见「在线 API / 本地 GGUF」切换 ✅
2. **导入**：导入 `qwen2.5-1.5b-instruct-q4_k_m.gguf`（约 1GB），进度通知正常 ✅
3. **续写**：选择模型 → 设为当前 → 切到写作 Tab → AI 续写输出中文 ✅
4. **流式**：流式输出，Vivo V2405A 上 ≥ 5 token/sec ✅
5. **取消**：取消按钮即时终止生成 ✅
6. **持久化**：卸装重装后，已导入模型仍在列表 ✅
7. **旧模型**：旧 LiteRT-LM 模型记录标记为 unavailable，不崩溃 ✅
8. **内存安全**：内存不足时拒绝加载并给出中文提示 ✅
9. **无效文件**：无效文件（非 GGUF 头）导入时提示"文件格式不正确" ✅

### Task 7.4: 修复集成问题

根据真机测试结果修复问题。常见可能问题：

- **libllama.so 加载失败**：检查 CMakeLists.txt 中源文件路径
- **模型加载 OOM**：调整内存安全检查的阈值
- **流式 token 乱码**：检查 `llama_token_to_piece` 编码处理
- **生成速度过慢**：调整线程数 (`n_threads`)

### Task 7.5: Phase 7 提交

```bash
git add -A
git commit -m "fix: integration test fixes for llama.cpp on real device

- Adjustments based on Vivo V2405A testing
- Memory safety threshold tuning
- Thread count optimization
- Token encoding fixes"
```

---

## 最终提交

```bash
git tag v2.4.0-llama-cpp
```

---

## 关键技术风险与缓解

| 风险 | 缓解措施 |
|---|---|
| llama.cpp 编译失败 / 体积爆炸 | 默认只编译 arm64-v8a；关闭 Vulkan/OpenCL；CPU-only .so 约 5-8MB |
| GGUF 文件超大（4-8GB），导入慢 | 复用前台服务 + 进度通知；实时显示 MB/s |
| 推理内存峰值（2B Q4 ~1.5GB RAM） | 启动前查 `ActivityManager.getMemoryInfo`，可用 < 模型文件 × 1.5 时拒绝 |
| Prompt 模板不匹配致输出乱码 | 默认 chatml（Qwen 系）；UI 提供 prompt 模板下拉 |
| 旧 LiteRT-LM 用户模型残留 | 数据库标记 unavailable；文件不删 |
| CMake NDK 兼容性 | 锁定 NDK r27+；CMake 3.22.1+ |
| llama.cpp API 变更 | Spike 阶段确认 b5500 版本 API，如有差异及时调整 |
| JNI 回调复杂度 | 优先使用 DeviceEventEmitter 事件模式，避免复杂 JNI callback |
