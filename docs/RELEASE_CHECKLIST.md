# ShineWriter 发布清单

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
Local commands / logs: Node 24.14.1；82 suites / 401 tests
Coverage: Statements 78.33%, Branches 60.37%, Functions 86.05%, Lines 79.95%
Jest natural exit: 82 suites / 401 tests，exit 0，无 --forceExit/open handles/timeout
GitHub Actions run URL: https://github.com/anjingdtl/tavo-mini/actions/runs/29504809163
Jobs: JavaScript validation success 64s；Migration matrix success 27s；Android Debug success 9m43s
```

## Android 构建与签名

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
Debug APK: dist/apk/debug/ShineWriter-V2.4.4-debug.apk（50,106,550 bytes）
Debug SHA-256: 69D99F8D0900E87F90636AE83B109BA2D6438003C166270EFF74168411DCEB28
Release APK: BLOCKED；四项 SHINE_WRITER_RELEASE_* 环境变量未设置
Minified Release APK: BLOCKED；同上
Signer certificate digest: BLOCKED；未生成签名 Release，不复用历史值
SHA-256: BLOCKED for Release / Minified Release
```

## 新安装与升级

- [x] 新安装测试通过（专用 Debug AVD）
- [ ] 老版本升级测试通过
- [x] Schema 3 到当前 Schema 的历史数据库自动化矩阵通过
- [ ] 启动后 Schema 版本正确、外键检查通过、无重复或孤儿记录
- [x] 备份恢复测试通过
- [x] 恢复失败时原数据库和保护性备份均可用（statement 注入）

证据：

```text
Clean-install device: ShineWriter_RC_API37 / emulator-5556 / sdk_gphone16k_x86_64 / Android 17 API 37 / x86_64
Upgrade source version / device: 真实老版 APK 升级 BLOCKED；历史 Schema 3-13 fixtures 自动化通过
Migration matrix result: 7 suites / 36 tests PASS；GitHub Migration matrix success
Backup/restore result: Maestro flow 04 PASS；D2 restore failure rollback PASS
```

## 核心功能实机验证

- [x] 项目创建与切换通过（删除未列入本轮 Maestro flow）
- [x] 章节创建、编辑、2 秒自动保存、退出再进入持久化通过
- [ ] 在线模型测试通过
- [ ] 本地 GGUF 模型导入、校验、加载、生成、取消通过
- [ ] TTS 配置、播放、停止和完成回收通过
- [ ] 前台/后台切换后写作和流水线状态正确
- [x] 流水线取消与断网失败反馈通过；成功生成需真实服务，BLOCKED
- [ ] 低内存或内存压力后不会启动新的 LLM 请求，回到前台后队列可恢复
- [x] 局域网 HTTP 开关默认关闭；开启后只允许私有 IPv4，公网 HTTP 仍被阻止

证据：

```text
Device model / Android version: sdk_gphone16k_x86_64 / Android 17 API 37 / emulator-5556
ADB or Maestro evidence: docs/optimization/evidence/maestro-debug/final-artifact-emulator-5556/01-06-junit.xml（最终 APK，6/6 PASS, 4m24s）
Online provider: BLOCKED for success；D11 仅使用无密钥 hanging server 验证断网失败
Local GGUF model: BLOCKED；无可控 GGUF 资产
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
Release URL: 不创建 GitHub Release；源码 Tag URL 为 https://github.com/anjingdtl/tavo-mini/releases/tag/V2.4.4
Previous release / rollback artifact: BLOCKED；本轮未验证历史签名 APK
main parity: 发布后执行 `git rev-list --left-right --count main...origin/main`，目标 `0 0`
```
