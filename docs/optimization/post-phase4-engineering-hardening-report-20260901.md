# POST-PHASE-IV ENGINEERING HARDENING

日期：2026-09-01
仓库：`anjingdtl/tavo-mini`
分支：`main`
最终代码 commit SHA（本次 Release/回归验证对应的远端 `main` 基线）：`1acf1b14d70857ad1b5b8b101f917850cfad4e0a`
最终判定：**GO**

## 1. 范围与基线

本次仅完成 Android Release/AAB 产物验收、16 KB page-size AVD 验收、Dependabot failure 定位、现有 required checks/regression 复核以及本报告归档。

- 已先执行 `git fetch origin main`；验收基线为远端 `main` 的 `1acf1b14d70857ad1b5b8b101f917850cfad4e0a`。
- 未修改 Phase IV 写作链核心逻辑，未触碰 `src/services/writing`、续写生成内核或 Canon 领域。
- 本次收尾未添加新的产品代码；报告是唯一计划提交的工作区文件。
- 既有未跟踪目录 `scripts/qa/__pycache__/` 未纳入提交。
- Release 签名使用正式 keystore：`android/keystores/tavo-mini-release.keystore`，alias `tavo-mini-release`；未创建新 keystore、未使用 Debug 签名、未把密码写入仓库或日志。

## 2. Release APK/AAB 构建结果

执行的标准流程：

```text
npm ci --ignore-scripts
npm run postinstall
./scripts/build-release-apk.ps1
android/gradlew.bat bundleRelease --no-daemon --console=plain
./scripts/verify-release-apk.ps1
```

结果：

| 产物 | 结果 | 大小 | SHA-256 |
|---|---|---:|---|
| `dist/apk/release/ShineWriter-V2.30.0-release.apk` | PASS | 59,256,425 bytes | `41B6EBC210A874F1FD4FCA5F8CABCDBBB09C59A14BF559CD8F441F539A8C41E0` |
| `android/app/build/outputs/bundle/release/app-release.aab` | PASS | 42,490,512 bytes | `FA990FB8FF55ACB1D70228FFF86CC072803B7307B6AB9DD7165059A10742824E` |

APK 元数据：

- package：`com.shinewriter`
- versionName：`V2.30.0`
- versionCode：`2300000`
- Release 构建成功，正式 APK 已复制到唯一交付路径 `dist/apk/release/`。

### 2.1 Signing / zipalign

- `apksigner verify --verbose --print-certs`：PASS。
- APK v1：false；v2：true；v3/v3.1/v4：false；signer 数量：1。
- 证书 DN：`CN=TAVO MINI, OU=TAVO, O=TAVO, L=Local, ST=Local, C=CN`。
- 证书 SHA-256：`017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`，与正式 keystore 预期指纹一致。
- `zipalign -c -P 16 -v 4 ShineWriter-V2.30.0-release.apk`：`Verification successful`。
- AAB 使用 `jarsigner -verify -certs` 非 strict 校验，退出码 0；`keytool -printcert -jarfile` 读取到同一正式证书指纹。
- AAB 的 `jarsigner -strict` 退出码为 4，输出为标准的 `signed in JarFile but is not signed in JarInputStream` 条目警告；该结果已记录，不将其误报为 APK 签名失败。设备安装和 Android 签名门禁以已签名 APK 为准。
- `bundletool 1.18.3 validate --bundle=app-release.aab`：退出码 0。

## 3. Native `.so` 与 16 KB 对齐

扫描证据：`test-logs/post-phase4-engineering-hardening-20260901/native-16k-summary.log`。

扫描同时检查 ELF class、所有 `PT_LOAD` 的 `p_align`、`p_offset` 与 `p_vaddr` 的对齐关系，以及 APK 未压缩 native entry 的 ZIP data offset。结果：

- APK 共 32 个 `.so`：`arm64-v8a` 16 个、`x86_64` 16 个。
- APK 全部 `.so` 为 stored/uncompressed；32/32 的 ZIP data offset 满足 16 KB 对齐。
- APK 全部 32/32 为 ELF64；全部 `PT_LOAD p_align=0x4000`；对齐关系全部通过。
- AAB 共 32 个 `.so`，32/32 的 ELF `PT_LOAD` 16 KB 检查通过；AAB 原始 bundle entry 为 deflated，原始 ZIP offset 不作为最终 APK 对齐判据。
- 未发现 4 KB-only native library；`libsqliteJni.so` 在两个 ABI 下均通过。

APK 全部 native 路径如下：

```text
lib/arm64-v8a/libappmodules.so
lib/arm64-v8a/libc++_shared.so
lib/arm64-v8a/libdatastore_shared_counter.so
lib/arm64-v8a/libfbjni.so
lib/arm64-v8a/libhermestooling.so
lib/arm64-v8a/libhermesvm.so
lib/arm64-v8a/libimagepipeline.so
lib/arm64-v8a/libjsi.so
lib/arm64-v8a/libnative-filters.so
lib/arm64-v8a/libnative-imagetranscoder.so
lib/arm64-v8a/libreact_codegen_rnscreens.so
lib/arm64-v8a/libreact_codegen_rnsvg.so
lib/arm64-v8a/libreact_codegen_safeareacontext.so
lib/arm64-v8a/libreactnative.so
lib/arm64-v8a/librnscreens.so
lib/arm64-v8a/libsqliteJni.so
lib/x86_64/libappmodules.so
lib/x86_64/libc++_shared.so
lib/x86_64/libdatastore_shared_counter.so
lib/x86_64/libfbjni.so
lib/x86_64/libhermestooling.so
lib/x86_64/libhermesvm.so
lib/x86_64/libimagepipeline.so
lib/x86_64/libjsi.so
lib/x86_64/libnative-filters.so
lib/x86_64/libnative-imagetranscoder.so
lib/x86_64/libreact_codegen_rnscreens.so
lib/x86_64/libreact_codegen_rnsvg.so
lib/x86_64/libreact_codegen_safeareacontext.so
lib/x86_64/libreactnative.so
lib/x86_64/librnscreens.so
lib/x86_64/libsqliteJni.so
```

## 4. 16 KB AVD 安装、冷启动与 UI smoke

AVD 配置与设备证据：

- AVD 名称：`Medium_Phone`
- emulator serial：`emulator-5554`
- product：`sdk_gphone16k_x86_64`
- Android SDK：37
- ABI：`x86_64`
- `adb shell getconf PAGE_SIZE`：`16384`
- 最终 APK 包属性：`extractNativeLibs=false`、`pageSizeCompat=0`、`primaryCpuAbi=x86_64`、`targetSdk=36`。

安装与启动：

```text
adb -s emulator-5554 install -r dist/apk/release/ShineWriter-V2.30.0-release.apk
Success

adb shell am force-stop com.shinewriter
adb logcat -c
adb shell am start -n com.shinewriter/.MainActivity
```

安装返回 `Success`。冷启动后 `com.shinewriter/.MainActivity` 处于 `Resumed`，未出现 Android Compatibility/16 KB 兼容性弹窗。

UI hierarchy smoke 覆盖：

- 作品库首页：显示 `作品库`、导入/新建/批量按钮、临时 smoke 项目 `PostPhase4QA`。
- 资料库：成功切换到 `resource-library`，显示 `资料库`。
- 写作：成功切换到 `writing-home`，显示 `章节 · 大纲 · 摘要 · 上下文`、`创建章节`、`一键写 N 章`。
- 构建：成功进入构建页，LLM 未配置提示符合空配置预期。
- 设置：成功进入设置页，LLM、管线、语音和主题设置可见。

日志与证据：

- `app-cold-launch.log` 坏模式扫描：`badCount=0`。
- `app-ui-smoke.log` 坏模式扫描：`uiSmokeBadCount=0`。
- crash buffer：0 条相关异常。
- native load 记录 17 条，均为 `Load ... : ok`。
- 未发现 `FATAL EXCEPTION`、`AndroidRuntime`、`UnsatisfiedLinkError`、`SIGSEGV`、`SIGABRT`、ANR、`SQLiteException`、`no such table`、linker/dlopen failure、OOM 或 page-size failure。
- 日志中仅有预期的未配置 API key 查找信息和既有 React Native ViewManager warning，不影响启动或本次 smoke。

截图、UI XML、命令输出均保存在：

```text
E:\AiWorkSpace\tavo-mini\test-logs\post-phase4-engineering-hardening-20260901\
```

本次 AVD smoke 使用的 `PostPhase4QA` 是临时测试项目，不在仓库和提交中。

## 5. Dependabot check failure 调查

失败运行：

- Workflow run：`33484759457`
- URL：https://github.com/anjingdtl/tavo-mini/actions/runs/33484759457
- 标题：`npm_and_yarn in /. for decode-uri-component - Update #1549086405`

准确根因：

- Dependabot 尝试处理 `decode-uri-component` 安全更新时，当前导航依赖族仍通过 `query-string@7.1.3` 约束 `decode-uri-component@^0.2.2`。
- 约束来源包括 `@react-navigation/bottom-tabs`、`@react-navigation/native`、`@react-navigation/native-stack`。
- 当前安装树为 `decode-uri-component@0.2.2` / `query-string@7.1.3`。
- 注册表中较新的 `decode-uri-component@0.5.0` 与现有 CJS `query-string@7.1.3` 并不兼容：在隔离项目中仅加入 npm override 后，`require('query-string')` 运行失败并报 `TypeError: decodeComponent is not a function`。

处理结论：

- 这是上游依赖族和 CJS/ESM 兼容性造成的自动升级阻塞，不是 Android 构建、测试 runner 或本次 Release 修复失败。
- 本次没有加入不安全的 npm override，没有运行宽范围 `npm audit fix`，也没有 dismiss 安全告警。
- 在“不扩大范围、不修改 Phase IV 核心逻辑”的约束下，没有安全的最小代码修复可提交；该 Dependabot check 保持已知失败并已明确记录。

建议单独建立依赖安全修复批次：同步升级 React Navigation/query-string/decode-uri-component 依赖族，验证 CJS/ESM 运行时和 React Native bundling，再完整运行 JavaScript、Android、migration、generation stability 及设备回归。

## 6. Required checks / regression 最终状态

本地最终执行结果全部绿色：

| 检查 | 命令/范围 | 结果 |
|---|---|---|
| JavaScript validation | `npm run verify` | PASS；lint 0 errors/261 warnings，typecheck、elastic、version 全通过；Jest 543 passed suites、4 skipped；3824 passed tests、9 skipped |
| Android Debug build | `npm run prebuild` + `android/gradlew.bat assembleDebug --no-daemon --console=plain` | PASS；`BUILD SUCCESSFUL` |
| Migration matrix | `npm test -- migration --runInBand` | PASS；47 suites、217 tests |
| Generation Stability group 1 | workflow 当前精确 36 suite 路径 | PASS；36 suites、245 tests |
| Generation Stability group 2 | workflow 当前精确 21 suite 路径 | PASS；21 suites、107 tests |

关键命令日志保存在：

```text
E:\AiWorkSpace\tavo-mini\test-logs\post-phase4-engineering-hardening-20260901\check-javascript-validation.log
E:\AiWorkSpace\tavo-mini\test-logs\post-phase4-engineering-hardening-20260901\check-debug-build.log
E:\AiWorkSpace\tavo-mini\test-logs\post-phase4-engineering-hardening-20260901\check-migration-matrix.log
E:\AiWorkSpace\tavo-mini\test-logs\post-phase4-engineering-hardening-20260901\check-generation-stability-group1.log
E:\AiWorkSpace\tavo-mini\test-logs\post-phase4-engineering-hardening-20260901\check-generation-stability-group2.log
```

同一代码基线的远端 Actions 结果也为绿色：

- `Verify` run `33484745682`：success；`JavaScript validation`、`Android Debug build`、`Migration matrix` 均 success。
- `Generation Stability` run `33484745709`：success。
- 仅 Dependabot run `33484759457` 失败，根因和处置见上一节。

## 7. Remaining Risks

1. Dependabot 的 `decode-uri-component` 自动更新仍失败，安全告警需要单独的依赖族升级批次处理。
2. 本次设备验证覆盖 16 KB `x86_64` AVD；尚未替代真实 16 KB `arm64-v8a` 物理设备的最终兼容性验证。
3. lint 的 261 条 warning、Android SDK XML/deprecation 等既有工具链 warning 仍存在，但没有 error 或 regression failure。
4. AAB 已完成 bundletool 结构校验和 ELF 检查；AAB 原始压缩容器不直接等同于设备 split APK，设备级对齐结论以已签名 APK 的 `zipalign -P 16`、native 扫描和 16 KB AVD 安装结果为准。

## 8. Final Verdict

Release APK/AAB 构建、正式签名、APK zipalign、全部 native `.so` 的 16 KB ELF/page alignment、16 KB AVD 安装/冷启动/UI/logcat，以及 JavaScript validation、Android Debug build、Migration matrix、Generation Stability 均通过。

Dependabot failure 已定位为上游依赖兼容性导致的非代码阻塞，并已记录影响与后续处置建议，没有被忽略或伪装成绿色。

**POST-PHASE-IV ENGINEERING HARDENING：GO**
