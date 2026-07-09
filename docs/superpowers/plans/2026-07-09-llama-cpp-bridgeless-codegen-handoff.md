# LlamaCpp bridgeless TurboModule 修复 — 接力 Agent 提示词

> 复制以下内容作为新会话的 User Message，交给下一个 agent 使用。
> 上一个 agent（TRAE 会话，2026-07-09 晚间）已完成 UI 反馈层修复 + 4 个回归测试 + 全部 push 到 main 分支（commit `72ec531`），但 LlamaCpp TurboModule 真正的桥接问题仍未解决，需你来收尾。

---

你是一个高级 Android + React Native 开发者，**接力**完成 tavo-mini 项目的 **llama.cpp 本地离线模型集成**最后一个关键问题：**LlamaCpp TurboModule 在 RN 0.85 bridgeless 模式下 JS 端调不到 native**。

## 你的起点

请先按顺序阅读以下三份文档：

1. **进度报告（最重要，必读第三节）：** `F:\ClaudeWorkSpace\projects\TAVO-MINI\docs\superpowers\plans\2026-07-09-llama-cpp-local-model-progress.md`
   - 第三节「2026-07-09 晚间追加：UI 反馈层修复 + 根本问题交接」是本次会话全部上下文。
2. **设计规范：** `F:\ClaudeWorkSpace\projects\TAVO-MINI\docs\superpowers\specs\2026-07-09-tavo-mini-llama-cpp-local-model-SPEC.md`
3. **实施计划：** `F:\ClaudeWorkSpace\projects\TAVO-MINI\docs\superpowers\plans\2026-07-09-llama-cpp-local-model.md`

进度报告中详细记录了：
- 哪些文件已修改、已新增（commit `72ec531`）
- 当前真机表现：UI 反馈层已修，但导入仍因 JS 端调不到 native 而失败
- 三个候选修复方案（A/B/C）的具体操作步骤

## 你需要完成的工作

### 优先级 P0：让 JS 端能调到 LlamaCpp native（核心任务）

**根因**：`LlamaCpp` 这个 TurboModule 没有 codegen spec，所以 RN 0.85 bridgeless 模式下 JS 端通过 `NativeModules.LlamaCpp` / `global.__turboModuleProxy('LlamaCpp')` / `TurboModuleRegistry.get('LlamaCpp')` **任何路径都拿不到**这个模块。

**首选方案 A：加 codegen spec（RN 0.85 bridgeless 标准路径）**

1. 新建 `src/native/specs/NativeLlamaCpp.ts`，定义 `TurboModuleRegistry.getEnforcing<Spec>('LlamaCpp')` 的 TypeScript interface，覆盖现有 LlamaCppModule.ts 暴露的所有方法（importModel / validateModel / loadModel / generate / cancel / unloadModel / deleteModelFiles / modelFileExists / cleanupStagingFiles / getCapabilities + 三个 subscribe 事件）。
2. 在 `android/app/src/main/java/com/shinewriter/llamacpp/LlamaCppModule.kt` 加上 `@ReactModule(name = "LlamaCpp")` 注解（V2.4.0 当前只有 `implements TurboModule`，没有这个注解）。
3. 在 `android/app/build.gradle` 启用 codegen：
   - 检查 `react { autolinkLibrariesFromCommand() }` 是否存在
   - 必要时加 `react { enableSeparateBuildPerCpuArchitecture = true }` 或 codegen 相关配置
4. 跑 `npx react-native codegen` 生成 cpp spec + Java spec
5. 重新构建 debug APK：`npm run apk:debug`
6. 验证 `global.__turboModuleProxy('LlamaCpp')` 在 JS 端返回非 null：
   - 在 `src/native/LlamaCppModule.ts` 的 `findNative()` 里加临时 `console.log` 看探测结果
   - 装到模拟器跑一遍完整路径
7. 跑全套测试 + lint，确认 253+ 个测试不回归

**备选方案 B：退回 legacy module**（如果方案 A 跑不通）

⚠️ **风险**：撤销 V2.3.1 → V2.4.0 的 P0-#1 fix，需要在测试机上跑完整路径确认 TurboModuleManager 解析不崩溃。

1. 去掉 `LlamaCppModule(reactContext) : ..., TurboModule` 中的 `TurboModule` 实现
2. `LlamaCppPackage.getReactModuleInfoProvider()` 里 `ReactModuleInfo.isTurboModule` 改成 `false`
3. 重新构建、验证 `NativeModules.LlamaCpp` 在 JS 端不为 undefined

**方案 C 不推荐**：bridge hybrid 模块（hacky，不走生产）

### 优先级 P1：真机端到端验收

P0 修完后，跑完整 GGUF 导入 → 加载 → 生成链路：

1. `npm run apk:debug` 构建
2. 装到模拟器：`adb install -r -t dist/apk/debug/ShineWriter-V2.4.0-debug.apk`
3. 测试 `Qwen2.5-0.5B-Instruct-Q4_K_M.gguf`（已在 `test-logs/` 目录）
4. 路径：设置 → LLM 设置 → 本地 GGUF → 管理本地模型 → 导入 .gguf 模型 → 选文件
5. 验证日志中出现：
   - `LlamaCppPackage.getModule AFTER ROUTING (result=LlamaCppModule)` ✓
   - `importModel` 真正被调用（logcat 里 `ModelImporter` 或 `LlamaCppEngine.load`）
   - UI Modal 切到 "复制中 X%" → "验证模型中…" → "导入完成"
6. 在「写作」页用本地模型跑一次续写

### 优先级 P2：清理

如果 P0 方案 A 跑通，把临时 debug log 清掉；最后跑一次 `npm run lint` 确认 0 errors。

## 关键环境信息

- **项目根目录：** `F:\ClaudeWorkSpace\projects\TAVO-MINI`
- **ADB 路径：** `C:\Users\Administrator\AppData\Local\Android\Sdk\platform-tools\adb.exe`
- **测试 GGUF 模型：** `F:\ClaudeWorkSpace\projects\TAVO-MINI\test-logs\Qwen2.5-0.5B-Instruct-Q4_K_M.gguf`
- **真机设备 ID：** `10AEAF31XQ000UQ` (Vivo V2405A, Android API 36)
- **当前分支：** `main`（HEAD: `72ec531`）
- **Node 版本：** Windows + Node 24.14.1 + PowerShell 5

## 关键代码入口（必读）

| 文件 | 看点 |
|---|---|
| `android/app/src/main/java/com/shinewriter/llamacpp/LlamaCppModule.kt` | `@ReactModule` 注解 + `implements TurboModule`（待 P0 修复） |
| `android/app/src/main/java/com/shinewriter/llamacpp/LlamaCppPackage.kt` | `getReactModuleInfoProvider` + `isTurboModule`（已有 AFTER_ROUTING 日志） |
| `src/native/LlamaCppModule.ts` | `findNative()` + `isLlamaCppAvailable()` + `probeLlamaCppAvailable()`（三路探测） |
| `src/store/localModelStore.ts` | `startImport` 状态机（preparing + 90s 兜底） |
| `src/screens/LocalModelManagerScreen.tsx` | Modal 渲染 |
| `__tests__/localModelImportRegression.test.tsx` | 4 个回归测试（不要破坏） |
| `node_modules/react-native/Libraries/TurboModule/TurboModuleRegistry.js` | TurboModule 解析机制（确认 codegen 必要性） |

## 验收标准

P0 完成的标准：

1. ✅ `npm test` 通过（253+ 个测试 + 新增至少 1 个 codegen 路径的测试）
2. ✅ `npm run lint` 0 errors
3. ✅ `npm run apk:debug` 构建成功
4. ✅ 真机/模拟器实测：选完 GGUF 文件后 UI 走完 preparing → selecting → copying → hashing → validating → ready 全流程
5. ✅ 「写作」页能用本地模型续写至少一段文本
6. ✅ 提交 commit 并 push 到 main 分支

## 不要做的事

- ❌ 不要回滚 commit `72ec531`（UI 反馈层修复已经做好，撤了会重新出现"点完没反应"）
- ❌ 不要把 `test-logs/` 提交到 git（已在 `.gitignore`）
- ❌ 不要修改 `android/app/jni/llama.cpp/` 下的 JNI 源码（已经调通）
- ❌ 不要回退到 V2.3.1 release 产物调试（源码已是 V2.4.0，行为不一致）

## 完成后续

完成后：
1. 更新 `docs/superpowers/plans/2026-07-09-llama-cpp-local-model-progress.md`：把第三节「2026-07-09 晚间追加」的「状态」从「待交接」改成「已完成」，记录你选用的方案和实施细节。
2. `git add -A && git commit && git push origin main`
3. 跟世恒哥（项目 owner）同步进展。