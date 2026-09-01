# Post-Phase-IV Engineering Hardening Report

日期：2026-09-01
分支：`main`
结论：**GO**（本次工程硬化验收项全部通过；Dependabot 安全告警仍保留为后续专项）

## 1. 基线与交付

- 开工 HEAD：`28abff8b515a0596da21e53d9e2192dea49a81f3`
- 开工时 `origin/main`：同上；已执行 `git fetch origin --prune`
- 代码修复提交：`1acf1b14d70857ad1b5b8b101f917850cfad4e0a`
- 代码修复提交已成功推送至 `origin/main`，并完成远端 Actions 验证
- 报告文档提交在开启 branch protection 后直推被 GitHub `GH006` 拒绝（4 个必需检查尚未在该新 SHA 上运行），状态：`BLOCKED_BY_PERMISSION`；未绕过保护或强推，报告仍保存在本地提交中
- 工作区只保留既有未跟踪 `scripts/qa/__pycache__/`，未纳入提交；构建产物、数据库、截图和日志均未纳入提交

## 2. P0：Generation Stability 根因与修复

### 复现

原工作流第一组的精确 Jest 路径运行结果为 34 个 suite、225 个测试通过，但 suite 在加载阶段失败：

```text
ENOENT: no such file or directory, open
'E:\\AiWorkSpace\\tavo-mini\\__tests__\\goldenJourneysV2.test.ts'
```

这不是测试逻辑失败，而是工作流仍引用已删除的测试文件。历史提交 `a13c74d7` 已有意删除 `goldenJourneysV2.test.ts`；当前对应测试已拆为 `goldenJourneys.test.ts` 与 `goldenJourneysMultiChapter.test.ts`。

### 修复与证据

仅更新 `.github/workflows/generation-stability.yml` 的路径清单，将失效路径替换为当前两套 Golden Journey 测试，未删除测试、未放宽断言、未屏蔽失败。

最终精确运行结果：

- 第一组：36 suites / 245 tests 全部通过
- 第二组：21 suites / 107 tests 全部通过
- GitHub Actions `Generation Stability` run `33484745709`：成功（45 秒）

## 3. P1：Android 16 KB page-size hardening

### 根因

旧 Release APK 的所有 ELF `PT_LOAD` 已是 16 KB 对齐，`zipalign -c -P 16` 也通过，但在 16 KB AVD 安装后仍出现 Android Compatibility dialog：`libsqliteJni.so` 的 RELRO segment 未对齐；旧包同时使用了 `extractNativeLibs=true`、legacy JNI packaging，系统记录 `pageSizeCompat=256`。

### 最小修复

- 将 AsyncStorage / Keychain 引入的 AndroidX native 依赖族统一约束到 `androidx.sqlite:2.7.0` 与 `androidx.datastore:1.2.1`，避免仅替换单个 native artifact 造成族版本漂移。
- 设置 `packagingOptions.jniLibs.useLegacyPackaging = false`，移除 manifest 的 `android:extractNativeLibs="true"`，让 APK/AAB 遵循非 legacy native packaging。
- 对 app-owned `libappmodules.so` 添加 NDK r27 所需的 `-z max-page-size=16384` 与 `-z common-page-size=16384` 链接参数。

Android 官方 16 KB 指南要求关注 ELF segment、ZIP alignment、RELRO 以及真实 16 KB 设备/模拟器验证，见：[Support 16 KB page sizes](https://developer.android.com/guide/practices/page-sizes)。

### Release APK 证据

产物：`dist/apk/release/ShineWriter-V2.30.0-release.apk`

- 32 个 `.so`：全部 stored/uncompressed；全部 ELF 最小 `PT_LOAD p_align = 16384`；全部 ZIP data offset 为 16 KB 对齐
- 自定义 ELF/ZIP 扫描：`ELF_LOAD_ALIGNMENT_BAD=0`、`ZIP_ALIGNMENT_BAD_UNCOMPRESSED=0`
- 直接安装包属性：`extractNativeLibs=false`、`pageSizeCompat=0`、`primaryCpuAbi=x86_64`
- 包名：`com.shinewriter`
- 版本：`V2.30.0` / `versionCode=2300000`
- 最新强制重建时间：`2026-09-01 16:20:29 +08:00`
- 文件大小：`59,256,425` bytes
- APK SHA-256：`41B6EBC210A874F1FD4FCA5F8CABCDBBB09C59A14BF559CD8F441F539A8C41E0`
- 证书 SHA-256：`017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`
- signer 数量：1；APK v2 签名：通过；`zipalign`：Verification successful

### Release AAB 证据与限制

- 构建成功：`android/app/build/outputs/bundle/release/app-release.aab`
- AAB SHA-256：`FA990FB8FF55ACB1D70228FFF86CC072803B7307B6AB9DD7165059A10742824E`
- AAB 内含 32 个 native `.so`，所有 ELF 最小 `PT_LOAD` 对齐均为 16 KB
- AAB 使用 jarsigner 非 strict 校验通过，证书 SHA-256 与正式 keystore 一致
- AAB 原始 ZIP entry 显示 deflated/未对齐；这属于 bundle 容器输入，不等同于最终 device APK split 的布局。由于 Bundletool 下载在本机网络环境中未完整取得，本次不宣称已完成 bundletool split 级验证；最终 device APK 已通过真实 16 KB AVD 验证。

## 4. 构建、测试与模拟器验收

### 本地门禁

- `npm ci`：成功（926 packages）
- `npm run verify`：成功
  - ESLint：0 errors，261 warnings
  - TypeScript：通过
  - `verify:elastic`：通过
  - `verify:version`：通过，V2.30.0 / 2300000
  - Jest：543 suites passed、4 skipped；3824 tests passed、9 skipped
- `assembleDebug`：成功（8m53s）
- Release APK 标准构建：成功（13m12s）
- `bundleRelease`：成功（1m54s）
- `scripts/verify-release-apk.ps1`：所有 hard assertions 通过

### 16 KB AVD

- 设备：`sdk_gphone16k_x86_64` / `emulator-5554`
- `adb shell getconf PAGE_SIZE`：`16384`
- 通过 `adb install -r` 安装新 Release APK 后，包属性为 `pageSizeCompat=0`
- 冷启动流程：`force-stop` → 清空 logcat → 启动 `com.shinewriter/.MainActivity` → 等待 5 秒
- UI hierarchy 证据：作品库显示 `PostPhase4QA`，进入项目后切换“写作”，出现 `writing-home`、`章节 · 大纲 · 摘要 · 上下文`、`创建章节`
- 全流程未出现 `Android App Compatibility`、`16 KB compatible` 或 `Don't Show Again`
- app PID 过滤后的 logcat 未发现 FATAL EXCEPTION、ANR、SIGSEGV、SQLiteException、`no such table`、UnsatisfiedLinkError、linker 或 OOM

模拟器中为本次 smoke test 创建了临时项目 `PostPhase4QA`；它不在仓库、不在提交内容中。

## 5. CI 治理与远端验证

### GitHub Actions

提交 `1acf1b14d70857ad1b5b8b101f917850cfad4e0a` 的远端结果：

- `Generation Stability` run `33484745709`：success
- `Verify` run `33484745682`：success
  - `JavaScript validation`：success
  - `Android Debug build`：success（9m32s）
  - `Migration matrix`：success

远端仅报告既有 warning：GitHub Actions 的 Node.js 20 runtime deprecation、lint warning 以及 Android 构建的既有兼容性提示；没有失败项。

### `main` branch protection

已成功配置并 API read-back 验证，不是 `BLOCKED_BY_PERMISSION`：

- required status checks：`JavaScript validation`、`Android Debug build`、`Migration matrix`、`Generation Stability`
- strict status checks：开启
- enforce admins：开启
- force push：禁止
- branch deletion：禁止
- conversation resolution：开启
- required pull request reviews：保持未配置（本次未擅自引入 reviewer 流程）

## 6. P2：Dependabot 失败与安全告警分类

### 失败 PR 根因

- PR25（Gradle wrapper 9.3.1 → 9.7.1）：Generation Stability 叠加旧失效路径；Android Debug build 则因 Kotlin metadata 2.4.0/2.3.0 与项目 Kotlin compiler 2.1.0 不兼容而失败。本次不升级 Gradle wrapper。
- PR24（`actions/setup-java` 4 → 6）：仅受旧 Generation Stability 失效路径影响。
- PR21（React / `@types/react`）：`react-test-renderer` 版本落后于测试期望，导致 37 个 suite 无法加载；属于依赖族冲突，不是 runner 不稳定。
- PR17（`@testing-library/react-native` 13.3.3 → 14.0.1）：async render API 类型变化导致 `getByText` / `findByText` / `queryByText` 等从 Promise 结果上直接读取而触发 TS2339；属于升级适配问题。

### 当前 open alerts

GitHub push 回执显示默认分支仍有 12 个告警：6 high、4 moderate、2 low。其中 npm 侧包含 `decode-uri-component`、`nanoid`、`image-size`、`js-yaml`；RubyGems 侧包含 `concurrent-ruby`、`activesupport`。已存在补丁版本的告警（如 nanoid、js-yaml、concurrent-ruby、activesupport）仍需单独确认 lockfile、依赖树和升级兼容性；`image-size` 当前没有 patched version。此次没有 dismiss 告警，也没有用宽范围 `npm audit fix` 或无证据的 Dependabot 升级制造假绿。

本次 push 后自动触发的 Dependabot security run `33484759457` 仍失败，但根因已明确：`decode-uri-component` 无法自动升级，因为 `@react-navigation/bottom-tabs`、`@react-navigation/native` 与 `@react-navigation/native-stack` 经由 `query-string@7.1.3` 仍要求 `decode-uri-component@^0.2.2`。这属于上游依赖族约束/无 patched version 的安全升级阻塞，不是 runner 或本次 Android/CI 修复失败。

后续建议是单独建立依赖安全修复批次：先锁定 npm 依赖树和 `image-size` 引入链，再分别处理 React Native 测试 API、Kotlin/Gradle 工具链和 RubyGems 扫描项。

## 7. Phase IV 封存边界与最终判定

本次功能代码未触碰 `src/services/writing`、续写生成内核、Canon 领域或 Phase IV 封存逻辑；变更仅限 Generation Stability 路径、Android native packaging/链接与依赖解析。完整 `npm run verify`、两组精确 generation stability、Debug/Release/AAB 构建、Release APK 签名/对齐检查、16 KB AVD 安装及冷启动 UI/logcat 均通过。

因此本次 Post-Phase-IV engineering hardening 判定为 **GO**。Dependabot 安全告警和第三方 action deprecation 是已记录的后续治理项，不在本次硬化提交中伪装为已解决。
