# llama.cpp 本地离线模型接入 — 接力 Agent 提示词

> 复制以下内容作为新会话的 User Message，交给下一个 agent 使用。

---

你是一个高级 Android + React Native 开发者，现在要接力完成 tavo-mini 项目的 **llama.cpp 本地离线模型集成**工作。

## 你的起点

请先阅读以下三份文档（按顺序）：

1. **进度报告（最重要，必读）：** `d:\ClaudeCodeWorkSpace\projects\tavo-mini\docs\superpowers\plans\2026-07-09-llama-cpp-local-model-progress.md`
2. **实施计划：** `d:\ClaudeCodeWorkSpace\projects\tavo-mini\docs\superpowers\plans\2026-07-09-llama-cpp-local-model.md`
3. **设计规范：** `d:\ClaudeCodeWorkSpace\projects\tavo-mini\docs\superpowers\specs\2026-07-09-tavo-mini-llama-cpp-local-model-SPEC.md`

进度报告中详细记录了：
- 哪些 Phase 已完成（Phase 0/1/4 ✅）
- 哪些文件已创建/修改/删除
- 哪些文件尚未创建（按优先级排列）
- 每个 Phase 的具体任务清单和验收标准

## 你需要完成的工作

### 优先级 1：Phase 2 + Phase 3（可并行）

**Phase 2：** 将 `android/app/jni/llamacpp_jni.cpp` 从 stub 替换为完整版（流式生成、采样、取消支持）。务必对照 `android/app/jni/llama.cpp/include/llama.h` 中的实际 API 签名来写，llama.cpp 的 API 版本间差异很大。

**Phase 3：** 创建完整的 `com.shinewriter.llamacpp` Kotlin 包（10 个文件），包括：
- LlamaCppModule.kt（ReactMethod 桥）
- LlamaCppPackage.kt（ReactPackage 注册）
- LlamaCppErrors.kt（错误码）
- LlamaCppEvents.kt（事件数据类）
- GgufValidator.kt（GGUF magic bytes 校验）
- ModelFileManager.kt（路径安全，参考已删除的 localllm 版本逻辑）
- ModelImporter.kt（.gguf 流式导入 + SHA-256）
- LlamaCppEngine.kt（扩展现有最小版为完整单例）
- LlamaCppForegroundService.kt（前台通知服务）
- LlamaCppNotification.kt（通知渠道）

同时修改 MainApplication.kt 注册 LlamaCppPackage，AndroidManifest.xml 新增 ForegroundService 声明。

### 优先级 2：Phase 5（TypeScript Provider 层）

创建 TS 侧的 LlamaCppModule 桥接、llamaCppPromptAdapter（6 种模板）、llamaCppProvider，更新 providerRegistry、localModels、localModelStore、jest.setup.js。

### 优先级 3：Phase 6（UI 适配）

LLMSettingsScreen 改为「在线 API / 本地 GGUF」+ Prompt 模板选择；LocalModelManagerScreen 适配 .gguf。

### 优先级 4：Phase 7（真机验收）

构建 debug APK → 安装到真机 → 导入 GGUF 模型 → 测试续写。

## 关键环境信息

- **项目根目录：** `d:\ClaudeCodeWorkSpace\projects\tavo-mini`
- **ADB 路径：** `C:\Users\Administrator\AppData\Local\Android\Sdk\platform-tools\adb.exe`
- **真机设备 ID：** `10AEAF31XQ000UQ`（Vivo V2405A, Android API 36）
- **React Native：** 0.85.3，Kotlin 2.1.20，TypeScript 5.8.3
- **Android：** minSdk 24, targetSdk 36, NDK r27+
- **llama.cpp 源码位置：** `android/app/jni/llama.cpp/`（最新 master 分支，已 clone）
- **CMake 构建方式：** `add_subdirectory(llama.cpp)` 引入 llama.cpp 自带 CMake 系统
- **Metro 连接：** APP 启动前须 `adb reverse tcp:8081 tcp:8081`，否则红屏
- **构建命令：** `cd d:\ClaudeCodeWorkSpace\projects\tavo-mini\android; .\gradlew :app:assembleDebug`
- **测试命令：** `cd d:\ClaudeCodeWorkSpace\projects\tavo-mini; npx jest`

## 注意事项

1. **llama.cpp API 不稳定**：不同版本函数签名差异很大，务必先读 `android/app/jni/llama.cpp/include/llama.h` 确认实际 API，不要照搬 PLAN 里的示例代码。
2. **每个 Phase 完成后验证编译**：`.\gradlew :app:assembleDebug` 必须通过。
3. **Git 提交**：每个 Phase 完成后独立提交，commit message 用 conventional commits 格式。
4. **不要创建文档文件**（README、md 等），只写代码和测试。
5. **参考已删除的 localllm 包逻辑**：ModelFileManager/ModelImporter/ForegroundService 的核心逻辑可以从 git history 里找回（`git show HEAD:android/app/src/main/java/com/shinewriter/localllm/LocalModelFileManager.kt`），适配到新包名即可。
6. **Jest mock**：新增 LlamaCpp native module 后，必须在 `jest.setup.js` 中添加 mock，否则测试挂。
7. **用户称呼"世恒哥"**，你自称"塔拉"，风格幽默但工作严谨。

开始干活吧！先读进度报告，然后从 Phase 2/3 并行启动。
