# llama.cpp 本地离线模型接入 — 进度报告

> **最后更新：** 2026-07-09 17:00 (Asia/Shanghai)
> **状态：** Phase 0/1/4 已完成，Phase 2/3 进行中
> **SPEC:** `docs/superpowers/specs/2026-07-09-tavo-mini-llama-cpp-local-model-SPEC.md`
> **PLAN:** `docs/superpowers/plans/2026-07-09-llama-cpp-local-model.md`
> **ADB 路径:** `C:\Users\Administrator\AppData\Local\Android\Sdk\platform-tools\adb.exe`
> **真机设备 ID:** `10AEAF31XQ000UQ` (Vivo V2405A, API 36)

---

## 一、总体进度

| Phase | 名称 | 状态 | 说明 |
|-------|------|------|------|
| **Phase 0** | Spike — 验证 llama.cpp 编译 | ✅ 完成 | libllama.so + libllamacpp_jni.so 编译成功 |
| **Phase 1** | 清除 LiteRT-LM | ✅ 完成 | 删除 12 个文件，编译通过 |
| **Phase 2** | JNI + CMake + 源码集成（正式版） | ⏳ 待完成 | 当前是 stub 版本，需替换为完整流式生成 JNI |
| **Phase 3** | Kotlin LlamaCppModule + Engine | ⏳ 待完成 | 当前只有最小 Engine 类，缺完整 Module/Package/Importer/Service 等 |
| **Phase 4** | 数据库迁移 v12→v13 | ✅ 完成 | 迁移脚本+类型更新+9/9 测试通过 |
| **Phase 5** | TS LlamaCppProvider + Prompt 适配 | ❌ 未开始 | 需 Phase 3 完成后启动 |
| **Phase 6** | UI 适配 | ❌ 未开始 | LLMSettingsScreen + LocalModelManagerScreen |
| **Phase 7** | 真机验收测试 | ❌ 未开始 | APK 构建 → 安装 → 导入 GGUF → 续写测试 |

**完成度：约 35%**

---

## 二、已完成的详细工作

### Phase 0: Spike ✅

**做了什么：**
1. 从 GitHub clone 了 llama.cpp 最新 master 分支到 `android/app/jni/llama.cpp/`（使用 `add_subdirectory` 方式构建）
2. 编写了 `jni/CMakeLists.txt`：CPU-only 构建，关闭所有 GPU 后端（Vulkan/OpenCL/Metal/CUDA 等），通过 `add_subdirectory(llama.cpp)` 引入源码树
3. 编写了 `llamacpp_jni.cpp` stub 版本（5 个 JNI 函数，仅打日志，无实际逻辑）
4. 在 `build.gradle` 中添加了：
   - `ndk { abiFilters 'arm64-v8a' }`（defaultConfig 内）
   - `externalNativeBuild { cmake { path "jni/CMakeLists.txt"; version "3.22.1" } }`（android 块内）
   - `cmake.arguments "-DANDROID_ABI=arm64-v8a"`（defaultConfig.externalNativeBuild 内）
5. 创建了 `LlamaCppEngine.kt` 最小 Kotlin 类（加载 llamacpp_jni 库 + 声明 external 函数）

**验证结果：**
- `./gradlew :app:assembleDebug` → **BUILD SUCCESSFUL in 24s**
- 53 tasks executed, 189 up-to-date
- `.so` 文件生成在 `android/app/build/.cxx/arm64-v8a/Debug/...`

### Phase 1: 清除 LiteRT-LM ✅

**删除的文件（共 12 个）：**

| 路径 | 说明 |
|------|------|
| `android/app/src/main/java/com/shinewriter/localllm/` | 整个目录（10 个 .kt 文件） |
| `src/services/llm/localLiteRtLmProvider.ts` | LiteRT-LM Provider 实现 |
| `src/native/LocalLLMModule.ts` | RN Native Module 桥接 |

**修改的文件：**

| 文件 | 改动 |
|------|------|
| `MainApplication.kt` | 移除 `add(LocalLLMPackage())` 和 import |
| `build.gradle` | 移除 `litertlm-android:0.14.0` 依赖、`liteRtLmVersion` 变量、`-Xskip-metadata-version-check` |
| `AndroidManifest.xml` | 移除 `libvndksupport.so` / `libOpenCL.so` 的 uses-native-library + LocalModelForegroundService service |
| `jest.setup.js` | 移除 `RN.NativeModules.LocalLLM = {...}` mock 块 |
| `providerRegistry.ts` | 移除 local_litertlm 注册项 |

**验证结果：** Android BUILD SUCCESSFUL（TypeScript 有预期类型错误）

### Phase 4: 数据库迁移 v12→v13 ✅

**新建文件：**

| 文件 | 说明 |
|------|------|
| `src/services/migrations/v12-to-v13.ts` | 迁移脚本（ALTER TABLE + UPDATE） |
| `__tests__/v12-to-v13.test.ts` | 5 个用例的单元测试 |

**修改文件：**

| 文件 | 改动 |
|------|------|
| `src/services/migrations/index.ts` | SCHEMA_VERSION=13，注册 v12→v13 迁移链 |
| `src/types/localModel.ts` | 新增 PromptTemplate 类型、prompt_template 字段、actual_backend 字段；LocalModelStatus 增加 'unavailable' |
| `src/types/novel.ts` | LLMProviderType 改为 'openai_compatible' \| 'llama_cpp' |
| `src/services/llm/types.ts` | 同步 LLMProviderType 更新 |
| `src/screens/LLMSettingsScreen.tsx` | local_litertlm → llama_cpp（2 处） |
| `src/screens/LocalModelManagerScreen.tsx` | local_litertlm → llama_cpp；文案改为 GGUF |
| `src/services/localModels.ts` | 错误信息改为 llama.cpp |
| `src/store/localModelStore.ts` | 错误信息改为 llama.cpp |

**验证结果：** 9/9 测试全部通过

---

## 三、当前代码状态（接力起点）

### 关键文件清单（供下一个 agent 参考）

```
✅ 已完成可用的文件：
├── android/app/jni/
│   ├── CMakeLists.txt              ← Spike 版本，CPU-only add_subdirectory(llama.cpp)
│   ├── llamacpp_jni.cpp            ← Stub（需替换为完整版）
│   └── llama.cpp/                  ← 最新 master 分支源码（完整）
├── android/app/build.gradle        ← 已含 CMake 配置 + arm64-v8a
├── android/app/src/main/java/com/shinewriter/llamacpp/
│   └── LlamaCppEngine.kt           ← 最小版本（需扩展为完整 Engine）
├── src/services/migrations/v12-to-v13.ts  ← 完成可用
├── src/types/localModel.ts         ← 已含 PromptTemplate 等新字段
└── src/types/novel.ts              ← LLMProviderType = 'openai_compatible' | 'llama_cpp'

❌ 尚未创建的文件（按优先级）：
├── android/app/jni/llamacpp_jni.cpp              ← 需重写完整版（流式生成回调）
├── android/app/src/main/java/com/shinewriter/llamacpp/
│   ├── LlamaCppModule.kt                          ← RN ReactMethod 桥接
│   ├── LlamaCppPackage.kt                         ← ReactPackage 注册
│   ├── LlamaCppErrors.kt                          ← 错误码常量
│   ├── LlamaCppEvents.kt                          ← 事件定义
│   ├── GgufValidator.kt                           ← GGUF 文件头校验
│   ├── ModelFileManager.kt                        ← 路径安全管理
│   ├── ModelImporter.kt                          ← .gguf 流式导入
│   ├── LlamaCppForegroundService.kt               ← 前台服务通知
│   └── LlamaCppNotification.kt                    ← 通知渠道
├── src/native/LlamaCppModule.ts                   ← TS 桥接类型
├── src/services/llm/llamaCppProvider.ts           ← Provider 实现
├── src/services/llm/llamaCppPromptAdapter.ts      ← Prompt 模板适配器
├── android/app/src/main/AndroidManifest.xml       ← 需新增 LlamaCppForegroundService
├── android/app/src/main/java/com/shinewriter/MainApplication.kt  ← 需注册 LlamaCppPackage

❌ 尚未修改的文件：
├── jest.setup.js                                  ← 需新增 LlamaCpp mock
├── src/services/llm/providerRegistry.ts           ← 需注册 llama_cpp provider
├── src/services/localModels.ts                    ← 需全面重写对接 LlamaCpp
├── src/store/localModelStore.ts                  ← 需对接新模块
├── src/components/LocalModelSelector.tsx          ← 适配新类型
├── src/screens/LLMSettingsScreen.tsx              ← UI 改为「在线API/本地GGUF」+ prompt模板选择
├── src/screens/LocalModelManagerScreen.tsx        ← UI 适配 .gguf
└── src/services/llm.ts                            ← resolveLLMRequestConfig 适配
```

---

## 四、后续工作详细任务清单

### 🔴 Phase 2: JNI 正式版（最高优先级）

**目标：** 将 stub `llamacpp_jni.cpp` 替换为包含完整推理逻辑的正式版本。

**核心要求（PLAN Task 2.3）：**
```cpp
// 必须实现的函数：
// nativeInit(numThreads) → 初始化 llama.cpp backend
// nativeLoadModel(modelPath, contextLen) → 加载 GGUF 模型，返回 handle
// nativeGenerate(handle, prompt, maxTokens, temperature, topP, callback) → 流式生成
// nativeCancel(handle) → 取消生成（atomic flag）
// nativeUnload(handle) → 释放资源
```

**关键实现点：**
1. 使用 `llama_model_load_from_file()` 加载模型
2. 使用 `llama_init_from_model()` 创建 context
3. 使用 `llama_tokenize()` 做 tokenization
4. 使用 `llama_decode()` 循环解码 + `llama_sampler_chain` 做采样
5. 通过 Java callback interface 回传 token（onToken/onCompleted/onError）
6. `std::atomic<bool>` 支持 cancel
7. 注意：llama.cpp API 可能因版本而异，务必对照 `llama.cpp/include/llama.h` 中的实际函数签名

**参考 PLAN 文件位置：** Phase 2, Task 2.3（有完整示例代码）

**完成后验证：** `./gradlew :app:assembleDebug` 通过

---

### 🔴 Phase 3: Kotlin 完整模块（与 Phase 2 并行或紧随其后）

**目标：** 创建完整的 `com.shinewriter.llamacpp` 包，共 10 个文件。

**文件创建顺序：**

1. **LlamaCppErrors.kt** — 错误码常量对象（20+ 个错误码字符串）
2. **LlamaCppEvents.kt** — 数据类：TokenEvent / CompletedEvent / ErrorEvent / ImportProgressEvent / CapabilitiesResult / ImportResult / ValidationResult / LoadResult
3. **GgufValidator.kt** — validateGgufHeader(file): Boolean，检查 magic bytes 0x46475547 + version 2/3
4. **ModelFileManager.kt** — ensureDirs() / newStagingFile() / newModelDir() / modelFile()，路径安全校验
5. **ModelImporter.kt** — importModel(uri) 流式复制 + SHA-256 校验
6. **LlamaCppEngine.kt** — 扩展现有最小版为完整单例：load/generate/cancel/unload/checkAvailableMemory
7. **LlamaCppForegroundService.kt** — 前台通知服务（导入进度）
8. **LlamaCppNotification.kt** — 通知渠道 ID: `llamacpp_import`
9. **LlamaCppModule.kt** — ReactMethod 桥接（getCapabilities/importModel/validateModel/loadModel/generate/cancel/unload/deleteModelFiles/modelFileExists/cleanupStagingFiles）
10. **LlamaCppPackage.kt** — createNativeModules 返回 LlamaCppModule()

**同时修改：**
- **MainApplication.kt** — `add(LlamaCppPackage())`
- **AndroidManifest.xml** — 新增 LlamaCppForegroundService 的 `<service>` 声明

**完成后验证：** `./gradlew :app:assembleDebug` 通过

---

### 🟡 Phase 5: TypeScript Provider 层（依赖 Phase 3 完成）

**文件列表：**
1. `src/native/LlamaCppModule.ts` — TS 类型声明 + DeviceEventEmitter 辅助
2. `src/services/llm/llamaCppPromptAdapter.ts` — 6 种 prompt 模板（chatml/llama3/alpaca/qwen/phi/mistral/custom）
3. `src/services/llm/llamaCppProvider.ts` — LLMProvider 接口实现
4. `src/services/llm/providerRegistry.ts` — 注册 llama_cpp provider
5. `src/services/localModels.ts` — 重写导入/删除/查询逻辑
6. `src/store/localModelStore.ts` — 对接新模块
7. `src/components/LocalModelSelector.tsx` — 适配新类型
8. `jest.setup.js` — 新增 LlamaCpp mock

**完成后验证：** `npm test` 全部通过

---

### 🟢 Phase 6: UI 适配（依赖 Phase 5 完成）

**修改文件：**
1. `LLMSettingsScreen.tsx`:
   - SegmentedControl 选项：「在线 API」/「本地 GGUF」（替换原来的 local_litertlm）
   - 本地模式下显示：LocalModelSelector + Prompt 模板下拉选择 + 上下文长度 + 最大输出 Token + 「管理本地模型」按钮
2. `LocalModelManagerScreen.tsx`:
   - 标题改为「导入并管理 GGUF 离线模型」
   - 按钮改为「导入 .gguf 模型」
   - 说明文字改为 GGUF 格式说明
   - 模型卡片显示 prompt_template 标签

**完成后验证：** Metro 启动 + APP 加载不报红屏

---

### 🟢 Phase 7: 真机验收测试（最终阶段）

**验收标准（9 项）：**
1. ✅ 设置 → LLM 设置 可见「在线 API / 本地 GGUF」切换
2. ✅ 导入 qwen2.5-1.5b-instruct-q4_k_m.gguf 成功，进度通知正常
3. ✅ 选该模型 → 设为当前 → 写作 Tab → AI 续写输出中文
4. ✅ 流式输出 ≥ 5 token/sec（Vivo V2405A 上）
5. ✅ 取消按钮即时终止生成
6. ✅ 卸装重装后已导入模型仍在列表
7. ✅ 旧 LiteRT-LM 模型标记 unavailable 不崩溃
8. ✅ 内存不足时拒绝加载并提示中文
9. ✅ 无效文件（非 GGUF 头）导入时提示格式错误

**操作命令备忘录：**
```bash
# 构建
npm run apk:debug

# 安装到真机
& 'C:\Users\Administrator\AppData\Local\Android\Sdk\platform-tools\adb.exe' -s 10AEAF31XQ000UQ install -r dist/apk/debug/ShineWriter-V*.apk

# 启动 APP
& adb -s 10AEAF31XQ000UQ shell am start -n com.shinewriter/.MainActivity

# 截图
& adb -s 10AEAF31XQ000UQ shell screencap -p /sdcard/s.png; & adb pull /sdcard/s.png screen.png

# 抓日志
& adb logcat -d > logcat.txt

# Metro 连接
& adb reverse tcp:8081 tcp:8081; npm start
```

---

## 五、环境注意事项

### llama.cpp 目录结构（已确认）

SubAgent clone 的是最新 master 分支，关键路径如下：

```
android/app/jni/llama.cpp/
├── include/
│   ├── llama.h            ← 主头文件
│   └── llama-cpp.h
├── ggml/
│   ├── include/            ← ggml.h, ggml-alloc.h, ggml-backend.h, ggml-cpu.h
│   └── src/
│       ├── ggml.c, ggml-alloc.c, ggml-backend.c, ggml-backend-dl.h
│       ├── ggml-opt.cpp, ggml-quants.c, ggml-threading.cpp, gguf.cpp
│       └── ggml-cpu/      ← CPU 后端 ops
├── src/
│   ├── llama.cpp           ← 主源文件
│   ├── unicode.cpp, unicode-data.cpp
│   └── ...
└── CMakeLists.txt          ← llama.cpp 自带的构建配置
```

CMake 使用方式：`add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp llama.cpp-build)` —— 直接引入 llama.cpp 自身的 CMake 构建系统，自动处理所有源文件。

### NDK / Gradle 信息

- NDK 版本：由 `android/build.gradle` 中 `ndkVersion` 控制（检查 rootProject.ext.ndkVersion）
- Gradle 版本：9.3.1
- Kotlin：2.1.20
- compileSdk/targetSdk: 36, minSdk: 24

### Metro Packager

- Metro 默认在 PID ~36556 监听端口 8081
- APP 启动前必须执行 `adb reverse tcp:8081 tcp:8081`
- 否则会出现红屏（Unable to load script）

---

## 六、Git 提交建议

每个 Phase 完成后应独立提交：

```bash
# Phase 0 已完成但尚未提交
git add android/app/jni/CMakeLists.txt android/app/jni/llamacpp_jni.cpp \
    android/app/src/main/java/com/shinewriter/llamacpp/LlamaCppEngine.kt \
    android/app/build.gradle
git commit -m "feat(spike): integrate llama.cpp CMake build chain"

# Phase 1 已完成但尚未提交
git add -u -- android/app/src/main/java/com/shinewriter/localllm/ \
    src/services/llm/localLiteRtLmProvider.ts src/native/LocalLLMModule.ts \
    MainApplication.kt build.gradle AndroidManifest.xml \
    jest.setup.js providerRegistry.ts
git commit -m "refactor: remove LiteRT-LM engine and all references"

# Phase 4 已完成但尚未提交
git add src/services/migrations/v12-to-v13.ts src/services/migrations/index.ts \
    src/types/localModel.ts src/types/novel.ts src/services/llm/types.ts \
    src/screens/LLMSettingsScreen.tsx src/screens/LocalModelManagerScreen.tsx \
    src/services/localModels.ts src/store/localModelStore.ts \
    __tests__/v12-to-v13.test.ts __tests__/migrationEngine.test.ts
git commit -m "feat(db): migrate schema v12→v13 for llama.cpp support"
```

---

*此文档由塔拉编写于 2026-07-09 17:00。*
