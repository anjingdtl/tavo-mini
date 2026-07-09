# llama.cpp 本地离线模型接入 — 进度报告

> **最后更新：** 2026-07-09 (Asia/Shanghai)
> **状态：** Phase 0/1/2/3/4/5/6 已完成，仅剩 Phase 7 真机验收
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
| **Phase 2** | JNI + CMake + 源码集成（正式版） | ✅ 完成 | llamacpp_jni.cpp 完整流式生成（294 行），含采样/取消/资源释放 |
| **Phase 3** | Kotlin LlamaCppModule + Engine | ✅ 完成 | 10 文件包：Module/Package/Engine/Errors/Events/Validator/FileManager/Importer/ForegroundService/Notification |
| **Phase 4** | 数据库迁移 v12→v13 | ✅ 完成 | 迁移脚本+类型更新+9/9 测试通过 |
| **Phase 5** | TS LlamaCppProvider + Prompt 适配 | ✅ 完成 | 3 新文件 + 6 修改文件，249/249 测试通过 |
| **Phase 6** | UI 适配 | ✅ 完成 | LLMSettings/LocalModelManager/LocalModelSelector 三处适配 |
| **Phase 7** | 真机验收测试 | ⏳ 待执行 | 沙箱无法跑，需世恒哥本地构建 APK + 真机验收 |

**完成度：约 90%（仅剩真机验收）**

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

### Phase 2: JNI 正式版 ✅

**重写文件：** `android/app/jni/llamacpp_jni.cpp`（294 行，从 stub 替换为完整版）

**核心实现：**
- `nativeInit` / `nativeLoadModel` / `nativeGenerate` / `nativeCancel` / `nativeUnload` 五个 JNI 函数
- 使用 `llama_model_load_from_file` + `llama_init_from_model` 加载模型
- `llama_sampler_chain` 采样（temp + top_p + dist）
- `llama_decode` 循环 + `llama_token_to_piece` 流式输出
- `std::atomic<bool> g_cancelled` 支持取消
- 通过 JNI callback 对象回传 token/completed/error
- 对照 `llama.cpp/include/llama.h` 实际 API 签名编写

### Phase 3: Kotlin 完整模块 ✅

**新建 10 文件包** `android/app/src/main/java/com/shinewriter/llamacpp/`：

| 文件 | 行数 | 说明 |
|------|------|------|
| LlamaCppModule.kt | 339 | ReactMethod 桥（10 个方法 + 事件发射） |
| LlamaCppEngine.kt | 196 | JNI 封装单例，含内存安全检查 |
| LlamaCppEvents.kt | 84 | 事件常量 + 数据类 |
| LlamaCppErrors.kt | — | 20 个错误码常量 |
| GgufValidator.kt | — | GGUF magic 0x46475547 + version 2/3 校验 |
| ModelFileManager.kt | — | 路径安全（canonicalPath 越界检查）+ SHA-256 |
| ModelImporter.kt | — | 流式复制 + 哈希同步计算 + GGUF 头校验 |
| LlamaCppForegroundService.kt | — | 前台服务（type=dataTransfer） |
| LlamaCppNotification.kt | — | 通知渠道 `llamacpp_import` |
| LlamaCppPackage.kt | — | ReactPackage 注册 |

**同时修改：** `MainApplication.kt`（注册 LlamaCppPackage + 内存回调）、`AndroidManifest.xml`（声明 ForegroundService）

### Phase 5: TS Provider 层 ✅

**新建 3 文件：**

| 文件 | 行数 | 说明 |
|------|------|------|
| src/native/LlamaCppModule.ts | 253 | TS 桥接：10 个 async 方法 + observeGeneration/observeImport/subscribeImportEvents 事件辅助 |
| src/services/llm/llamaCppPromptAdapter.ts | 136 | 6 模板：chatml/llama3/alpaca/qwen(=chatml)/phi/mistral/custom |
| src/services/llm/llamaCppProvider.ts | 255 | LLMProvider 实现，模块级 currentLoadedModelId 缓存 + 取消处理 + safeLogUsage |

**修改 6 文件：** providerRegistry.ts（注册 llama_cpp）、database.ts（CREATE TABLE + createLocalModel 补两列）、localModels.ts（重写对接 LlamaCpp）、localModelStore.ts（重写 + 'hashing' 态）、LocalModelSelector.tsx、jest.setup.js（LlamaCpp mock）、jest.config.js（忽略 llama.cpp 子目录）

**验证结果：** 249/249 测试全部通过（51 个 test suite）

### Phase 6: UI 适配 ✅

**修改 3 文件：**

| 文件 | 改动 |
|------|------|
| LLMSettingsScreen.tsx | subtitle「本地 GGUF 离线模型」+ SegmentedControl label「本地 GGUF」+ 切到 llama_cpp 时锁 local_backend='cpu' + 移除运行后端 SegmentedControl（仅 CPU） |
| LocalModelManagerScreen.tsx | formatStatusLabel 补 'unavailable' + 按钮文案「导入 .gguf 模型」+ 说明文字更新 + statsRow 改为大小/后端/模板/加载耗时 + Modal 补 'hashing' 文案 + handleCreateConfig local_backend='cpu' |
| LocalModelSelector.tsx | 空状态增强：有 unavailable 模型时提示「旧模型已不可用，请重新导入 GGUF」 |

**设计决策：** prompt_template 选择器未放 LLMSettingsScreen（因 LLMConfig 表无此字段），改为在模型卡片显示模板标签（model.prompt_template）。如需编辑模板可在后续迭代加。

**验证结果：** 249/249 测试全部通过

---

## 三、当前代码状态（全部就绪，待真机验收）

### 关键文件清单

```
✅ JNI 层（Phase 0/2）：
├── android/app/jni/CMakeLists.txt              ← CPU-only add_subdirectory(llama.cpp)
├── android/app/jni/llamacpp_jni.cpp            ← 完整流式生成（294 行）
└── android/app/jni/llama.cpp/                  ← 最新 master 分支源码

✅ Kotlin 原生层（Phase 3，10 文件）：
└── android/app/src/main/java/com/shinewriter/llamacpp/
    ├── LlamaCppModule.kt          (339 行)   ← ReactMethod 桥
    ├── LlamaCppEngine.kt          (196 行)   ← JNI 单例 + 内存安全
    ├── LlamaCppEvents.kt          (84 行)    ← 事件常量 + 数据类
    ├── LlamaCppErrors.kt                     ← 20 错误码
    ├── GgufValidator.kt                      ← GGUF magic 校验
    ├── ModelFileManager.kt                   ← 路径安全 + SHA-256
    ├── ModelImporter.kt                      ← 流式导入
    ├── LlamaCppForegroundService.kt          ← 前台服务
    ├── LlamaCppNotification.kt               ← 通知渠道
    └── LlamaCppPackage.kt                    ← ReactPackage

✅ 数据库迁移（Phase 4）：
├── src/services/migrations/v12-to-v13.ts      ← ALTER + UPDATE
└── src/services/migrations/index.ts           ← SCHEMA_VERSION=13

✅ TS Provider 层（Phase 5）：
├── src/native/LlamaCppModule.ts               (253 行) ← TS 桥接 + 事件辅助
├── src/services/llm/llamaCppPromptAdapter.ts  (136 行) ← 6 模板
├── src/services/llm/llamaCppProvider.ts       (255 行) ← LLMProvider 实现
├── src/services/llm/providerRegistry.ts       ← 注册 llama_cpp
├── src/services/localModels.ts                ← 重写对接 LlamaCpp
├── src/store/localModelStore.ts               ← 重写 + 'hashing' 态
└── src/services/database.ts                   ← CREATE TABLE + createLocalModel 补两列

✅ UI 层（Phase 6）：
├── src/screens/LLMSettingsScreen.tsx          ← 「在线 API / 本地 GGUF」
├── src/screens/LocalModelManagerScreen.tsx    ← .gguf 适配 + 模板显示
└── src/components/LocalModelSelector.tsx      ← unavailable 提示

✅ 测试基础设施：
├── jest.setup.js                              ← LlamaCpp mock
└── jest.config.js                             ← 忽略 llama.cpp 子目录

✅ 类型定义：
├── src/types/localModel.ts                    ← PromptTemplate + actual_backend
├── src/types/novel.ts                         ← LLMProviderType 含 llama_cpp
└── src/services/llm/types.ts                  ← 同步
```

### 未提交状态

**所有 Phase 2/3/5/6 的改动均未 git commit**（本地工作区有 14 个 modified + 12 个 untracked 文件）。建议世恒哥 review 后按 Phase 拆分提交，或一次性提交。

---

## 四、后续工作：Phase 7 真机验收（仅剩此项）

### 验收标准（12 项）

| # | 测试项 | 验收标准 |
|---|---|---|
| 1 | 安装启动 | 设置 → LLM 设置 → 可见「在线 API / 本地 GGUF」切换，不崩溃 |
| 2 | 导入 GGUF | 导入 `qwen2.5-1.5b-instruct-q4_k_m.gguf`（约 1GB），进度通知正常，Modal 显示「复制中→计算哈希→验证中→完成」 |
| 3 | 模型卡片 | 卡片显示 大小 / 后端(cpu) / 模板(chatml) / 加载耗时 |
| 4 | 创建配置 | 点「创建 AI 配置」→ 跳转 LLM 设置，provider_type=llama_cpp，local_backend=cpu |
| 5 | 设为当前 | 选中本地配置 → 设为当前 → subtitle 显示「本地 GGUF 离线模型」 |
| 6 | AI 续写 | 切到写作 Tab → AI 续写 → 输出中文，Vivo V2405A 上 ≥ 5 token/sec |
| 7 | 流式 | 流式输出 token（如启用） |
| 8 | 取消 | 取消按钮即时终止生成 |
| 9 | 持久化 | 卸装重装后，已导入模型仍在列表 |
| 10 | 旧模型 | 旧 LiteRT-LM 模型记录标记为 unavailable，不崩溃，LocalModelSelector 提示重新导入 |
| 11 | 内存安全 | 内存不足时拒绝加载并给出中文提示 |
| 12 | 无效文件 | 非 GGUF 头文件导入时提示「文件格式不正确」 |

### 操作命令备忘录

```bash
# 1. 构建 debug APK
npm run apk:debug

# 2. 安装到真机（Vivo V2405A）
& 'C:\Users\Administrator\AppData\Local\Android\Sdk\platform-tools\adb.exe' -s 10AEAF31XQ000UQ install -r dist/apk/debug/ShineWriter-V*.apk

# 3. Metro 端口转发 + 启动
& adb -s 10AEAF31XQ000UQ reverse tcp:8081 tcp:8081
npm start

# 4. 启动 APP
& adb -s 10AEAF31XQ000UQ shell am start -n com.shinewriter/.MainActivity

# 5. 截图
& adb -s 10AEAF31XQ000UQ shell screencap -p /sdcard/s.png; & adb pull /sdcard/s.png screen.png

# 6. 抓日志（排查崩溃）
& adb logcat -d > logcat.txt
```

### 常见问题排查

| 现象 | 排查方向 |
|---|---|
| `libllama.so` 加载失败 | 检查 CMakeLists.txt 源文件路径是否匹配 llama.cpp master 实际结构；确认 `.so` 在 `android/app/build/.cxx/arm64-v8a/` 生成 |
| 模型加载 OOM | 调整 `LlamaCppEngine.kt` 的 `MEMORY_SAFETY_FACTOR`（当前 1.5） |
| 流式 token 乱码 | 检查 `llamacpp_jni.cpp` 的 `llama_token_to_piece` 编码处理 |
| 生成速度慢 | 调整 `ctx_params.n_threads`（当前 4） |
| JNI 函数签名不匹配 | 对照 `android/app/jni/llama.cpp/include/llama.h` 实际 API |
| 导入卡在 'hashing' | ModelImporter 在 copy 完成后发 progress(bytesCopied>=totalBytes)，store 据此切 'hashing'；如未切，检查 native 事件发射 |
| APP 红屏（无法加载脚本） | 未做 `adb reverse tcp:8081 tcp:8081` |

### 完成后

```bash
git add -A
git commit -m "fix: integration test fixes for llama.cpp on real device"
git tag v2.4.0-llama-cpp
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
