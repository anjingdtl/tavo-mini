# llama.cpp 本地离线模型接入 — 进度报告

> **最后更新：** 2026-07-10 (Asia/Shanghai)
> **状态：** Phase 0/1/2/3/4/5/6 已完成；Phase 7 模拟器端到端验收已打通，真机复测待执行
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
| **Phase 7** | 真机/模拟器验收测试 | ✅ 模拟器通过 / ⏳ 真机待复测 | 模拟器已验证 qwen3 GGUF 加载与生成链路；真机仍建议按验收清单复测 |

**完成度：约 96%（核心链路已通，仅剩真机复测与输出质量调优）**

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

---

## 三、2026-07-09 晚间追加：UI 反馈层修复 + 根本问题交接

> **最后更新：** 2026-07-09 (Asia/Shanghai)
> **负责人：** TRAE 会话（接到世恒哥反馈"点完导入没反应"开始）
> **状态：** UI 反馈修复已完成；**真正的根因（JS 端调不到 LlamaCpp TurboModule）已于 2026-07-10 接手修复**

### 3.1 问题表象

用户在 V2.4.0 debug APK 上：
- 进入「设置 → LLM 设置 → 本地 GGUF → 管理本地模型 → 导入 .gguf 模型」
- 选完 GGUF 文件后，**Modal 没出来 / 看上去卡住**
- 多次重试都没反应，必须手动重启 App

### 3.2 已做的调查（按时间顺序）

1. **V2.3.1 release 复现失败** → 设备跑的是 release 产物，源码已是 V2.4.0，行为不一致，**改用 V2.4.0 debug APK 复现**。
2. **抓 logcat** 发现关键日志：
   ```
   LlamaCppPackage.getModule: name='LlamaCpp' (BEFORE ROUTING)
   LlamaCppPackage: instantiating LlamaCppModule
   LlamaCppPackage.getModule: name='LlamaCpp' AFTER ROUTING (result=LlamaCppModule)
   ```
   **模块在 native 侧成功实例化**，但之后**没有 `importModel` 之类的调用日志**——说明 JS 端没有真正调到 native。
3. **对比 RN 0.85 bridgeless 模式下 TurboModule 解析流程**（参考 `ReactAndroid/src/main/java/com/facebook/react/internal/turbomodule/core/TurboModuleManager.kt` 与 `node_modules/react-native/Libraries/TurboModule/TurboModuleRegistry.js`）：
   - `TurboModuleRegistry.get('LlamaCpp')` 内部走 `global.__turboModuleProxy('LlamaCpp')` → `NativeModules[name]`
   - **只有 codegen 注册过的 TurboModule 才会被 `__turboModuleProxy` 暴露**（看 `react-native-codegen` 文档）
   - 我们 `LlamaCpp` 没有 codegen spec，所以 JS 端**根本拿不到**这个模块
   - `NativeModules.LlamaCpp` 也永远是 `undefined`

### 3.3 本次会话已实施的修复（已在 main 分支，commit + push 完毕）

1. **JS 端状态机改进**（`src/store/localModelStore.ts`）
   - `startImport` 一开始就把状态切到 `'preparing'`，避免原生层挂起时 UI 永远停在 `'idle'` 让人误以为"没反应"
   - 加 90 秒 `Promise.race` 兜底，防止永远卡在 preparing
   - 引擎不可用时（`isLlamaCppAvailable()` 同步或异步探测都返回 false）直接 `set state='error'` + 抛 `ENGINE_UNAVAILABLE` 中文消息（"本地模型引擎初始化失败，请重启 App 后再试。"）
   - 错误消息中文化：包含 `llama.cpp` 字样的原生错误自动翻译为"本地模型引擎尚未就绪，请检查应用安装或重新启动。"

2. **JS 端引擎探测加强**（`src/native/LlamaCppModule.ts`）
   - `isLlamaCppAvailable()` 不再只看 `NativeModules.LlamaCpp`，额外探测 `global.__turboModuleProxy('LlamaCpp')` 和 `TurboModuleRegistry.get('LlamaCpp')`
   - 新增 `probeLlamaCppAvailable(timeoutMs)` 异步探测，给 TurboModule 异步注入留 2 秒时间窗

3. **UI 改进**（`src/screens/LocalModelManagerScreen.tsx`）
   - 进度 Modal 加 `'preparing' 正在准备模型文件…` 文案
   - 导入按钮 `disabled` 条件：`importing || importState.state !== 'idle'`，避免重复点击

4. **Native 日志增强**（`android/app/src/main/java/com/shinewriter/llamacpp/LlamaCppPackage.kt`）
   - `getModule` 加 try-catch + AFTER_ROUTING 日志，方便下次复现排查

5. **回归测试**（`__tests__/localModelImportRegression.test.tsx`）
   - 4 个测试全部覆盖：
     1. 选完文件后 import 状态立刻变非 idle（即使原生层永远不 resolve）
     2. 引擎不可用时弹 Alert + state 落 error
     3. 错误消息中文化（含"本地模型引擎"/"llama.cpp"/"重启"）
     4. RN 0.85 bridgeless 异步探测场景：sync 判定 false 但 async probe 成功时正确恢复

### 3.4 当前真机表现（交接前）

V2.4.0 debug APK 装到模拟器，选完 GGUF 文件后：

```
正在导入模型
导入失败：本地模型引擎初始化失败，请重启 App 后再试。
[关闭]
```

- ✅ Modal 出来了
- ✅ 用户看到明确反馈
- ✅ 不再"点完没反应"
- ❌ 但**导入本身还是失败**（因为 LlamaCpp JS 端拿不到）

### 3.5 给下一个 agent 的交接清单（已完成）

> **真正的根因**：`LlamaCpp` 这个 TurboModule 没有 codegen spec，所以 RN 0.85 bridgeless 模式下 JS 端通过任何路径（`NativeModules.LlamaCpp` / `global.__turboModuleProxy` / `TurboModuleRegistry.get`）都拿不到，调用永远走不进去 native。
>
> **下一步必须做的事（任选其一）：**

**方案 A：加 codegen spec（RN 0.85 bridgeless 标准路径，推荐，已采用）**
1. 新建 `src/native/specs/NativeLlamaCpp.ts`，定义 `TurboModuleRegistry.getEnforcing<Spec>('LlamaCpp')` 的 TypeScript interface
2. 写 `@ReactModule(name = "LlamaCpp")` 注解到 `LlamaCppModule.kt`（注意 V2.4.0 当前只有 `implements TurboModule`，没 codegen）
3. 在 `android/app/build.gradle` 启用 codegen（`react { autolinkLibrariesFromCommand() }` + `enableSeparateBuildPerCpuArchitecture` 等）
4. 跑 `npx react-native codegen` 生成 cpp spec + Java spec
5. 重新构建 APK，验证 `global.__turboModuleProxy('LlamaCpp')` 返回非空

**方案 B：退回 legacy module 路径（风险更高，但工作量小）**
1. 去掉 `LlamaCppModule(reactContext) : ..., TurboModule` 中的 `TurboModule` 实现（V2.3.1 时代是 legacy，但因为 P0-#1 崩溃才改成 TurboModule）
2. `LlamaCppPackage.getReactModuleInfoProvider()` 里 `ReactModuleInfo.isTurboModule` 改成 `false`
3. 重新构建、验证 `NativeModules.LlamaCpp` 在 JS 端不再为 undefined
4. ⚠️ **风险**：V2.3.1 → V2.4.0 的 P0-#1 fix 会被撤销，需要在测试机上跑一遍 LlamaCpp 完整路径确认

**方案 C：bridge hybrid 模块（中间路线）**
1. 保留 TurboModule marker，但在 `MainApplication.kt` 里手动把 LlamaCpp module 实例注入到 JS 的 `global.LlamaCpp` 命名空间
2. JS 端直接走 `global.LlamaCpp.importModel(...)`，绕过 TurboModuleRegistry
3. 这种方法比较 hack，不推荐走生产

### 3.6 测试 + 验证状态（交接前）

- ✅ 全套测试：**253 passed / 253 total**（新增 4 个）
- ✅ ESLint：**0 errors**（6 warnings 全是历史文件）
- ✅ V2.4.0 debug APK 构建成功（51.18 MB）
- ✅ 模拟器实测：UI 反馈层修复生效（弹 Modal + 中文提示）
- ⏳ 真机端到端导入测试：因 LlamaCpp 桥问题仍未通过

### 3.7 关键文件清单（给下一个 agent）

| 文件 | 状态 | 说明 |
|---|---|---|
| `src/store/localModelStore.ts` | 已修改 | 加 `preparing` 状态 + 90s 兜底 + 中文错误消息 |
| `src/native/LlamaCppModule.ts` | 已修改 | `isLlamaCppAvailable()` + `probeLlamaCppAvailable()` 多路探测 |
| `src/screens/LocalModelManagerScreen.tsx` | 已修改 | Modal 加 preparing 文案 |
| `android/app/src/main/java/com/shinewriter/llamacpp/LlamaCppPackage.kt` | 已修改 | `getModule` 加 try-catch + 日志 |
| `__tests__/localModelImportRegression.test.tsx` | 新增 | 4 个回归测试 |
| `src/constants/version.json` | 已 bump | V2.4.0 versionCode=145（构建产物） |
| `android/app/jni/llama.cpp/` | 已存在 | JNI + CMake 构建产物（不动） |
| `src/native/specs/` | **不存在** | codegen spec 缺失（**核心交接**） |

### 3.8 下一步任务建议优先级

1. **P0** 走方案 A 加 codegen spec（这是 RN 0.85 bridgeless 的官方推荐）
2. **P1** 如果方案 A 困难，先把 `LlamaCppModule.kt` 的 codegen 走通后回退 legacy module
3. **P2** 给 LlamaCppEngine 的 `nativeInit` 加更详细的日志（目前 `System.loadLibrary("llamacpp_jni")` 成功但内部异常吃掉了），把真机 OOM / libllama 缺失的错误暴露给 JS
4. **P3** 在本地模型管理页加「重新探测引擎」按钮，让用户在重启 App 前可以重试一次 TurboModule 探测
5. **P4** V2.4.0 真机验收（联调 P0/P1/P2/P3 全部修完后跑一遍完整 GGUF 导入 → 加载 → 生成链路）

### 3.9 后续 agent 接手前请务必阅读

- `docs/superpowers/specs/2026-07-09-tavo-mini-llama-cpp-local-model-SPEC.md` — 完整设计
- `docs/superpowers/plans/2026-07-09-llama-cpp-local-model.md` — 实施计划
- `node_modules/react-native/Libraries/TurboModule/TurboModuleRegistry.js` — TurboModule 解析机制
- `node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/internal/turbomodule/core/TurboModuleManager.kt` — bridgeless 模式下 TurboModule 加载流程

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

---

## 七、2026-07-10 接手修复结果：bridgeless codegen + qwen3 模拟器验收

> **负责人：** 寇蒂斯
> **状态：** 核心桥接与模拟器端到端生成已打通；qwen3-0.6B-Q2_K 输出质量偏弱，建议作为后续模型选择/模板调优项继续优化。

### 7.1 已完成的关键修复

1. **RN 0.85 bridgeless TurboModule codegen 修复**
   - 新增 `src/native/specs/NativeLlamaCpp.ts`，为 `LlamaCpp` 提供 codegen TurboModule spec。
   - `package.json` 新增 `codegenConfig`，生成 `com.shinewriter.specs.NativeLlamaCppSpec`。
   - `LlamaCppModule.kt` 改为继承 `NativeLlamaCppSpec(reactContext)`，并保留 `@ReactModule` 注册。
   - `src/native/LlamaCppModule.ts` 保留三路探测：`NativeModules`、`global.__turboModuleProxy`、`TurboModuleRegistry.get`。
   - 模拟器日志确认：
     - `LlamaCppPackage.getModule: name='LlamaCpp' AFTER ROUTING (result=LlamaCppModule)`
     - JS 端可实际调用 native `loadModel` / `generate`。

2. **GGUF 文件头校验修复**
   - `GgufValidator.kt` 中 GGUF magic 从错误的 `0x46475547L` 修为小端读取后的正确值 `0x46554747L`。
   - 根因：GGUF 文件头字节为 `47 47 55 46`，以 little-endian 读取应为 `0x46554747`；旧值会误拒绝有效 GGUF。

3. **本地模型输出 token 上限修复**
   - 新增 `src/constants/llmDefaults.ts`，本地 llama.cpp 默认/安全上限统一为 512。
   - `LocalModelManagerScreen.tsx` 创建本地配置时不再默认写入 4000。
   - `LLMSettingsScreen.tsx` 切到本地 GGUF 时自动锁定 `local_backend='cpu'`，并把异常大的 `max_output_tokens` 收敛到 512。
   - `llamaCppProvider.ts` 修复调用方 `options.max_tokens` 覆盖本地配置的问题；现在取“调用方、配置、安全上限”三者中合理的较小值。

4. **Qwen3 思考块与空章节提示修复**
   - `llamaCppProvider.ts` 对 Qwen3 模型自动追加 `/no_think`，并清理返回文本中的 `<think>...</think>`。
   - `chapterGeneration.ts` 对空章节单独生成“从零创作正文”的提示，不再把空内容写成 `(空)` 传给模型，降低模型复述说明文字的概率。

5. **JNI 中文 token 崩溃修复**
   - `llamacpp_jni.cpp` 不再用 `NewStringUTF` 直接传 token piece。
   - 新增 UTF-8 bytes → UTF-16 转换后调用 `NewString`，避免 llama.cpp 分片输出中文/半个 UTF-8 字符时触发 CheckJNI：
     - `JNI DETECTED ERROR IN APPLICATION: input is not valid Modified UTF-8`

### 7.2 模拟器端到端证据

测试设备：`emulator-5554`

测试模型：

| 字段 | 值 |
|---|---|
| 模型 ID | `import-e5e9f544-4953-405c-b107-37a476cd4f09` |
| 模型名 | `Qwen3-0.6B-Q2_K` |
| 文件路径 | `/data/user/0/com.shinewriter/files/local_models/import-e5e9f544-4953-405c-b107-37a476cd4f09/model.gguf` |
| 文件大小 | `296238784` bytes |
| 状态 | `ready` |

关键 logcat 证据：

```text
load: enter, modelId=import-e5e9f544-4953-405c-b107-37a476cd4f09 path=/data/user/0/com.shinewriter/files/local_models/import-e5e9f544-4953-405c-b107-37a476cd4f09/model.gguf ctx=4096
file exists, size=296238784 bytes
nativeLoadModel: success, n_ctx=4096
nativeGenerate: maxTokens=256, temp=0.80, topP=0.90, promptLen=1412
nativeGenerate: done, 256 tokens, 0.8 t/s, cancelled=0
```

当前 debug APK 安装后，又通过「LLM 设置 → 本地 Qwen3 配置 → 保存并测试」做了 16 token 短连接测试，确认 codegen 桥不是旧日志残留：

```text
LlamaCppPackage.getModule: name='LlamaCpp' AFTER ROUTING (result=LlamaCppModule)
load: file exists, size=296238784 bytes
nativeLoadModel: success, n_ctx=4096
nativeGenerate: maxTokens=16, temp=0.00, topP=0.90, promptLen=63
nativeGenerate: done, 16 tokens, 1.0 t/s, cancelled=0
```

UI 同步弹出「测试通过」，回复内容来自本地 Qwen3 连接测试。

生成后数据库证据：

| 表 | 结果 |
|---|---|
| `chapters` | 第 1 章 `status='draft'`，`content` 长度 319 |
| `chapters` | `has_think=False`，`is_placeholder=False` |
| `llm_usage_logs` | `scenario='pipeline_draft'`，`status='success'`，`model_name='Qwen3-0.6B-Q2_K'`，`output_tokens=256` |

结论：模拟器已确认真实 qwen3 GGUF 模型可以经 JS → TurboModule → JNI → llama.cpp 完整链路加载、生成、回写章节正文，不再是 UI 假成功或占位文本。

### 7.3 当前剩余风险

1. **输出质量风险**
   - `Qwen3-0.6B-Q2_K` 可以生成并回写正文，但实际内容偏弱，存在复述任务说明和重复“好的”的现象。
   - 这更像小尺寸 + 低量化模型能力问题，也可能与 prompt template 仍需针对 Qwen3 继续调优有关。
   - 发布验收建议至少再用更高量化或更大参数的 Qwen3 GGUF 复测。

2. **真机复测风险**
   - 模拟器链路已通，但真机仍需按 Phase 7 清单复测导入、加载、生成、取消、低内存保护和无效文件提示。

3. **性能风险**
   - 当前 qwen3-0.6B-Q2_K 在模拟器约 `0.8 token/s`，真机 CPU 表现需要重新记录。

---

## 八、2026-07-10 流水线误报在线 API 配置修复

### 8.1 根因与修复

- 旧版「创建 AI 配置」只保存 `llama_cpp` 配置，没有将其设为当前配置。流水线继续读取空白的 `openai_compatible` 默认配置，因此误报缺少 API 地址、API Key 和模型名称。
- 新建本地配置后立即调用 `setActiveLLMConfig`，后续创建流程会直接切换到该模型。
- 为已受影响的升级用户增加运行时自愈：仅当当前在线配置完全为空时，寻找指向 `ready` 模型的本地配置并自动激活；已明确填写的在线配置不会被覆盖。

### 8.2 回归与模拟器证据

- Jest：57 个测试套件、267 项测试全部通过，其中新增 3 项历史配置自愈测试。
- 模拟器先手动恢复为「空白默认配置激活、本地 Qwen3 配置未激活」的历史状态，再从 `versionCode 147` 保留数据升级到 `149`。
- 点击「AI 重新生成」后日志直接进入本地链路：

```text
LlamaCppPackage.getModule: name='LlamaCpp' AFTER ROUTING (result=LlamaCppModule)
load: success, modelId=import-e5e9f544-4953-405c-b107-37a476cd4f09, 2337ms
nativeGenerate: maxTokens=256, temp=0.80, topP=0.90, promptLen=1433
```

结论：历史未激活的本地配置可以在流水线首次调用时自动修复，不再落入在线 API 配置校验。

---

## 九、2026-07-10 冷启动结果页返回修复

### 9.1 根因与修复

- 冷启动通知恢复会跨 Tab 直接打开 `Settings → PipelineResult`。旧逻辑未保证 `SettingsMain` 已进入子栈，结果页又只调用 `navigation.goBack()`，在无历史路由时会静默无操作。
- 跨 Tab 导航增加 `initial: false`，确保设置首页或写作首页先进入栈历史。
- 结果页增加确定性关闭策略：有历史时正常返回；无历史时重置到当前子栈首页；Android 系统返回键复用同一策略。

### 9.2 全量回归与模拟器证据

- Jest：58 个测试套件、271 项测试全部通过。
- ESLint：0 errors，保留项目原有 5 条 warnings。
- 模拟器保留既有数据库覆盖安装 `versionCode 150`，通过 Intent extra 冷启动直达结果页：
  - 顶部「返回」：结果页关闭，稳定进入设置首页。
  - Android 系统返回键：`BEFORE_RESULT=True`、`AFTER_RESULT=False`、`AFTER_SETTINGS=True`，应用进程保持运行。
- ADB UI 树和截图均确认结果页、设置首页显示完整，无重叠和黑屏。
