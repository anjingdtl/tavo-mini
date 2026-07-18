# ShineWriter 发布清单

## V2.5.0 结构化故事记忆专项

- [x] Schema 14 → 15 自动化迁移与 fresh install 三表一致
- [x] 新表进入 manifest 驱动备份/恢复
- [x] 增量补丁、证据校验、稳定 ID、幂等与 base fingerprint 自动化通过
- [x] dirty、snapshot、失败停点、取消和 100 章确定性回放自动化通过
- [x] Story State 优先于资料和 Episodic TF-IDF 注入；dirty 预览不注入
- [x] 128K / 200K / 512K / 1M 双层记忆预算自动化通过
- [x] Android 模拟器 29 个非空章节完整重建与第 14 章修改后 snapshot 重建
- [x] Android 模拟器在途取消、checkpoint 保留与继续（修复 `f8218df` 后）
- [x] 非空 Story Memory 三表备份 → 清空 App 数据 → UI 恢复后逐行一致
- [x] 可控 OpenAI 兼容服务正常生成、首次非法后 repair、二次非法失败
- [ ] 真实外部在线模型生成/repair 各一次
- [ ] arm64 真机本地 GGUF 长上下文生成/截断 repair/取消/unload

模拟器补充证据：`test-logs/story-memory-v2.5.0-emulator-20260718/FINAL-REPORT.md`。
该结果不替代真实外部模型和 arm64 真机；16 KB 对话框列出的 21 个未对齐原生库仍为 P1 风险。

专项自动化与未完成矩阵见 [`V2.5.0-STORY-MEMORY-TEST-REPORT.md`](V2.5.0-STORY-MEMORY-TEST-REPORT.md)。

本清单用于每个 Android 发布版本。勾选前把命令输出、APK 路径、设备型号或 GitHub Actions URL 写入对应的证据栏；无法执行的项目必须注明原因和替代验证，不得默认为通过。

当前发布基线（2026-07-16）：实现分支最终 GitHub Actions Run [29504809163](https://github.com/anjingdtl/tavo-mini/actions/runs/29504809163) 的 JavaScript、Migration matrix、Android Debug 均成功。按用户要求发布源码 Tag `V2.4.4`；签名 Release、Minified Release、物理设备和部分故障注入仍 BLOCKED，因此不批准可分发 APK RC。

## 版本与文档

- [x] `package.json` 的 `version` 已更新
- [x] `src/constants/version.json` 已由 `npm run prebuild` 生成并与版本一致
- [x] Android `versionCode` 已递增且没有回退
- [x] `CHANGELOG.md` 已更新
- [x] `README.md` 与当前功能、测试数量、模型支持和隐私边界一致
- [x] Tag 发布说明包含升级风险、已知限制和兼容性变化

证据：

```text
Version: 2.4.4（Tag-only）
versionCode: 2040400
CHANGELOG / README commit: 本轮 V2.4.4 发布提交
```

## 依赖与质量门禁

```powershell
npm ci
npm run lint
npm run typecheck
npm run test:ci
npm run test:coverage
npm test -- migration --runInBand
```

- [ ] `npm ci` 成功
- [x] lint 通过（4 条既有 `no-bitwise` warning，0 error）
- [x] typecheck 通过
- [x] Jest 通过
- [x] coverage 通过全局和定向阈值
- [x] migration matrix 通过
- [x] GitHub Actions `Verify` 的 JavaScript、Android Debug、Migration jobs 全部成功

证据：

```text
Local commands / logs: Node 24.14.1；98 suites / 489 tests（V2.5.0 本地门禁，2026-07-18）
Coverage: Statements 78.77%, Branches 61.38%, Functions 85.56%, Lines 80.33%
Jest natural exit: 98 suites / 489 tests，exit 0，无 --forceExit/open handles/timeout
GitHub Actions run URL: https://github.com/anjingdtl/tavo-mini/actions/runs/29506345363（main / e13c8a0）
Jobs: JavaScript validation success 67s；Migration matrix success 28s；Android Debug success 9m13s
```

## Android 构建与签名

执行前先阅读 [`docs/RELEASE_APK_BUILD.md`](RELEASE_APK_BUILD.md)。若当前 PowerShell 读取不到签名变量，先按指南把 Windows User 级变量安全加载到 Process 级；不要在终端输出密码，也不要重建 keystore。

```powershell
npm run apk:debug
npm run apk:release
Get-FileHash -Algorithm SHA256 dist/apk/release/ShineWriter-V<version>-release.apk
```

- [x] Android Debug 构建成功
- [ ] Android Release 构建成功
- [ ] Release APK 位于 `dist/apk/release/ShineWriter-V{version}-release.apk`
- [ ] Release 使用外部签名变量：`SHINE_WRITER_RELEASE_STORE_FILE`、`SHINE_WRITER_RELEASE_STORE_PASSWORD`、`SHINE_WRITER_RELEASE_KEY_ALIAS`、`SHINE_WRITER_RELEASE_KEY_PASSWORD`
- [ ] APK 签名证书正确：`apksigner verify --verbose --print-certs <apk>`
- [ ] APK SHA-256 已生成并复制到发布说明
- [ ] 未把密码、Keychain 内容或本地数据库提交到 Git

证据：

```text
Debug APK: dist/apk/debug/ShineWriter-V2.5.0-debug.apk（59,946,525 bytes）
Debug SHA-256: 3EC19AD5793DB867BB374B3D3BCBF11CA5F188089FF651C8387B66A0C15958E6
Release APK: BLOCKED；四项 SHINE_WRITER_RELEASE_* 环境变量未设置
Minified Release APK: BLOCKED；同上
Signer certificate digest: BLOCKED；未生成签名 Release，不复用历史值
SHA-256: BLOCKED for Release / Minified Release
```

## 新安装与升级

- [x] 新安装测试通过（专用 Debug AVD）
- [x] V2.4.6 → V2.5.0 模拟器保留数据覆盖升级通过
- [x] Schema 3 到当前 Schema 的历史数据库自动化矩阵通过
- [x] 启动后 Schema 15、`foreign_key_check` 空、`integrity_check=ok`
- [x] 备份恢复测试通过
- [x] 恢复失败时原数据库和保护性备份均可用（statement 注入）

证据：

```text
Clean-install device: emulator-5554 / sdk_gphone16k_x86_64 / Android 17 API 37 / x86_64
Upgrade source version / device: V2.4.6 → V2.5.0 覆盖安装 PASS；历史 Schema fixtures 自动化通过
Migration result: Schema 14 → 15 模拟器 PASS；自动化 migration matrix PASS
Backup/restore result: 非空 Story Memory 1/29/2 行恢复前后完全一致；API Key 未进入备份
```

## 核心功能实机验证

- [x] 项目创建与切换通过（删除未列入本轮 Maestro flow）
- [x] 章节创建、编辑、2 秒自动保存、退出再进入持久化通过
- [x] 可控 OpenAI 兼容服务连接、生成、repair、失败和取消通过；真实外部服务仍 BLOCKED
- [ ] 本地 GGUF 模型导入、校验、加载、生成、取消通过（x86_64 短生成 PASS；ARM/长上下文待测）
- [ ] TTS 配置、播放、停止和完成回收通过
- [ ] 前台/后台切换后写作和流水线状态正确
- [x] 流水线取消与断网失败反馈通过；成功生成需真实服务，BLOCKED
- [ ] 低内存或内存压力后不会启动新的 LLM 请求，回到前台后队列可恢复
- [x] 局域网 HTTP 开关默认关闭；开启后只允许私有 IPv4，公网 HTTP 仍被阻止

证据：

```text
Device model / Android version: sdk_gphone16k_x86_64 / Android 17 API 37 / emulator-5554
ADB or Maestro evidence: docs/optimization/evidence/maestro-debug/final-artifact-emulator-5556/01-06-junit.xml（最终 APK，6/6 PASS, 4m24s）
Online provider: 可控 OpenAI 兼容协议与运行时 PASS；真实外部服务 BLOCKED（无凭据）
Local GGUF model: Qwen3-0.6B-Q2_K x86_64 加载与短生成 PASS；ARM/长上下文/运行时 unload DEVICE-PENDING
TTS engine: 默认系统 TTS；后台 FGS/按钮状态取得证据，但引擎第二段报 -7，PARTIAL
```

## 故障注入回归

- [x] migration 第三条 SQL 失败
- [x] 恢复中途失败
- [x] 磁盘空间不足
- [x] 备份文件损坏
- [x] 备份 checksum 错误
- [x] 自动保存时杀死 App
- [ ] 迁移时杀死 App
- [ ] 恢复时杀死 App
- [ ] GGUF 导入中杀死 App
- [ ] 本地模型生成时内存不足
- [x] 在线模型请求中断网
- [ ] TTS 播放中切后台

每个故障场景都要记录：用户可见反馈、数据库状态、是否可重试、是否需要恢复备份、孤儿文件、卡死任务和诊断日志。

证据：

```text
Fault-injection report: docs/FAULT_INJECTION_MATRIX.md；7 PASS / 1 PARTIAL / 4 BLOCKED
Logcat / app diagnostics: docs/optimization/evidence/fault-injection/
Open issues: D7 migration kill、D8 restore kill、D9 GGUF import kill、D10 native OOM BLOCKED；D12 PARTIAL
```

## 发布与回滚

- [ ] GitHub Release 已创建
- [ ] Release notes 包含功能、升级风险、已知限制、APK SHA-256 和支持范围
- [ ] APK 可从 [GitHub Releases](https://github.com/anjingdtl/tavo-mini/releases) 下载
- [ ] 发布页面没有暴露 API Key、签名密码或用户数据库
- [ ] 已保留上一版 APK、上一版 SHA-256 和回滚说明
- [ ] `main` 与 `origin/main` 已通过 `git rev-list --left-right --count main...origin/main` 确认 `0 0`

证据：

```text
Release URL: 不创建 GitHub Release；源码 Tag URL 为 https://github.com/anjingdtl/tavo-mini/tree/V2.4.4
Previous release / rollback artifact: BLOCKED；本轮未验证历史签名 APK
main parity: 发布后执行 `git rev-list --left-right --count main...origin/main`，目标 `0 0`
```
