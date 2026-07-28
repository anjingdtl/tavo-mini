# ShineWriter 发布清单

## V2.10.2 Canon 分析输出恢复与任务进度固化

- [x] 升级 `package.json` / `package-lock.json` 至 `2.10.2`，`npm run prebuild` 生成 `V2.10.2` / `2100200`
- [x] `CHANGELOG.md` 和 `README.md` 同步本轮变更、正式 APK 名称和验收结果
- [x] `npm run verify` 通过（ESLint 0 error；保留仓库既有 warning）
- [x] `npm run apk:release` 使用正式签名构建成功，交付路径唯一为 `dist/apk/release/ShineWriter-V2.10.2-release.apk`
- [x] `scripts/verify-release-apk.ps1` 硬断言通过：单 signer、v2、固定证书 SHA-256、16 KB zipalign、`com.shinewriter`、`V2.10.2` / `2100200`
- [ ] 本轮未执行真机或模拟器回归；仅完成自动化和 APK 签名/元数据验收

证据：APK 38,140,759 bytes，SHA-256 `705C7DB5F5A2FE59A238F13440B494E53D39034C9FD4CA3FC527BAE0F67FAD01`，正式证书 SHA-256 `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`。

## V2.5.6 长篇定稿证据恢复与保存竞态修复

- [x] OpenAI 兼容结构化请求发送 `response_format: json_object`
- [x] 不支持 JSON Object 的兼容端点自动移除参数并重试
- [x] 读取 `finish_reason=length`，输出预算从配置值逐级翻倍，最高 16000 tokens
- [x] 第三次请求不携带被截断 assistant 输出，避免续写残缺 JSON
- [x] 无效证据错误指出具体引文，repair 按正文原语言逐字修正
- [x] 故事记忆使用 180 秒长任务超时；超时、网络错误、429/5xx 自动重试一次
- [x] 自动化连续 20 章定稿，含每逢第 3 章连续两次截断故障注入
- [x] 正式签名 V2.5.5 release 在模拟器使用 在线 OpenAI 兼容推理模型 连续定稿 20 章（基础回归）
- [x] 最终故事记忆状态正常、构建到第 20 章、Dirty 起点无、登场人物与关系均正确落库
- [x] 第 9 章证据意译故障注入后精确 repair 成功；第 10 章慢响应使用长超时成功
- [x] 正式签名 V2.5.6 release 安装到 Android 模拟器，StoryMemoryTest 连续定稿第 1、2 章并生成非空章节摘要；第 2 章状态注入正常
- [x] V2.5.6 APK 签名、zipalign、版本元数据和 SHA-256 验收

V2.5.6 APK：37,268,911 bytes，SHA-256 `（APK SHA-256 已记录）`，versionCode `2050600`，正式证书 SHA-256 `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`，APK Signature Scheme v2 / 单 signer / 16 KB zipalign 验证成功。

模拟器证据：`test-logs/chapter20-rootcause-20260718/`（逐章 UI 树和 logcat）；最终 APK 37,264,135 bytes，SHA-256 `（APK SHA-256 已记录）`。

## V2.5.4 章节空摘要热修复

- [x] 定位结构化补丁成功但 `episodicSummary` 全空仍写入空 `memory_summary`
- [x] 章节概要兜底、正文兜底和已应用补丁修复自动化覆盖
- [x] 正式签名 V2.5.4 release 第二章定稿后显示非空记忆摘要
- [x] 摘要按钮从数据库读取同一非空摘要；第三章上下文已构建到第 2 章并包含 183 tok 章节事件记忆
- [x] 已定稿空摘要章节再次定稿后自动补写（确定性服务测试）
- [x] V2.5.4 APK 签名、zipalign、版本元数据和 SHA-256 验收

证据：`test-logs/empty-summary-v254-20260718/`；在线 OpenAI 兼容推理模型 在线 API + 1M 上下文，Android API 37 x86_64 模拟器；APK 37,260,427 bytes，SHA-256 `（APK SHA-256 已记录）`，versionCode `2050400`，正式证书 SHA-256 `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`，APK Signature Scheme v2 / 单 signer / 16 KB zipalign 验证成功。`npm run verify`：98 suites / 500 tests。

## V2.5.3 在线 OpenAI 兼容推理模型 多人物引用热修复

- [x] 真机复现同章多名新人物共享 `tempRef` 导致定稿失败
- [x] 任意数量人物引用确定性消歧、关系两端同步改写和同名重复抽取合并自动化覆盖
- [x] 四人物、三条交叉关系、两条并行故事线自动化覆盖
- [x] 正式签名 V2.5.3 release 双人物第一章定稿成功，人物 2、关系 1
- [x] 第二章上下文包含非空全局故事状态（293 tok，已构建到第 1 章）
- [x] V2.5.3 APK 签名、zipalign、版本元数据和 SHA-256 验收

证据：`test-logs/deepseek-duplicate-ref-v253-20260718/`；在线 OpenAI 兼容推理模型 在线 API + 1M 上下文，Android API 37 x86_64 模拟器；APK 37,259,951 bytes，SHA-256 `（APK SHA-256 已记录）`，versionCode `2050300`，正式证书 SHA-256 `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`，APK Signature Scheme v2 / 单 signer / 16 KB zipalign 验证成功。`npm run verify`：98 suites / 498 tests。

## V2.5.2 在线 OpenAI 兼容推理模型 故事记忆热修复

- [x] 正式签名 V2.5.1 release + 在线 OpenAI 兼容推理模型 在线 API + 1M 上下文复现第一章定稿失败
- [x] 复现后确认第二章全局故事状态为 0 tok / 未包含
- [x] Unicode、非法标点、重复新人物临时引用自动化覆盖
- [x] 正式签名 V2.5.2 release 第一章定稿成功
- [x] 第二章上下文预览包含非空全局故事状态（209 tok，已包含，消息截至第 1 章）
- [x] V2.5.2 APK 签名、zipalign、版本元数据和 SHA-256 验收

证据：`test-logs/deepseek-story-memory-20260718/`；APK 37,235,295 bytes，SHA-256 `（APK SHA-256 已记录）`，正式证书 SHA-256 `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`，16 KB zipalign 验证成功。

## V2.5.1 结构化故事记忆专项

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

模拟器补充证据：`test-logs/story-memory-v2.5.0-Android 模拟器0718/FINAL-REPORT.md`。
该结果不替代真实外部模型和 arm64 真机；16 KB 对话框列出的 21 个未对齐原生库仍为 P1 风险。

专项自动化与未完成矩阵见本地测试报告。

本清单用于每个 Android 发布版本。勾选前把命令输出、APK 路径、设备型号或 GitHub Actions URL 写入对应的证据栏；无法执行的项目必须注明原因和替代验证，不得默认为通过。

当前发布基线（2026-07-18）：V2.5.1 本地自动化和 x86_64 模拟器结构化故事记忆专项通过；本轮生成并验收正式签名 Release APK。真实外部模型、arm64 真机、厂商后台策略与 16 KB 原生库对齐仍保留风险，不将模拟器结果表述为完整真机验收。

## 版本与文档

- [x] `package.json` 的 `version` 已更新
- [x] `src/constants/version.json` 已由 `npm run prebuild` 生成并与版本一致
- [x] Android `versionCode` 已递增且没有回退
- [x] `CHANGELOG.md` 已更新
- [x] `README.md` 与当前功能、测试数量、模型支持和隐私边界一致
- [x] Tag 发布说明包含升级风险、已知限制和兼容性变化

证据：

```text
Version: 2.5.1
versionCode: 2050100
CHANGELOG / README: V2.5.1 发布文档
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

- [x] `npm ci` 成功（postinstall 两类 Android 依赖补丁均重放）
- [x] lint 通过（4 条既有 `no-bitwise` warning，0 error）
- [x] typecheck 通过
- [x] Jest 通过
- [x] coverage 通过全局和定向阈值
- [x] migration matrix 通过
- [ ] V2.5.1 `main` 推送后的 GitHub Actions `Verify` 全部成功（推送后确认）

证据：

```text
Local commands / logs: Node 24.14.1；npm ci PASS（npm audit：3 个 moderate）；98 suites / 489 tests（V2.5.1 本地门禁，2026-07-18）
Coverage: Statements 78.77%, Branches 61.38%, Functions 85.56%, Lines 80.33%
Jest natural exit: 98 suites / 489 tests，exit 0，无 --forceExit/open handles/timeout
GitHub Actions run URL: V2.5.1 推送后生成
Jobs: 本地 verify/coverage 已通过；远端 JavaScript、Migration matrix、Android Debug 待 Actions 完成
```

## Android 构建与签名

执行前先阅读 [`docs/RELEASE_APK_BUILD.md`](RELEASE_APK_BUILD.md)。若当前 PowerShell 读取不到签名变量，先按指南把 Windows User 级变量安全加载到 Process 级；不要在终端输出密码，也不要重建 keystore。

```powershell
npm run apk:debug
npm run apk:release
Get-FileHash -Algorithm SHA256 dist/apk/release/ShineWriter-V<version>-release.apk
```

- [x] Android Debug 构建成功
- [x] Android Release 构建成功
- [x] Release APK 位于 `dist/apk/release/ShineWriter-V2.5.1-release.apk`
- [x] Release 使用外部签名变量：`SHINE_WRITER_RELEASE_STORE_FILE`、`SHINE_WRITER_RELEASE_STORE_PASSWORD`、`SHINE_WRITER_RELEASE_KEY_ALIAS`、`SHINE_WRITER_RELEASE_KEY_PASSWORD`
- [x] APK 签名证书正确：`apksigner verify --verbose --print-certs <apk>`
- [x] APK SHA-256 已生成并复制到发布说明
- [x] 未把密码、Keychain 内容或本地数据库提交到 Git

证据：

```text
Debug APK: V2.5.0 模拟器专项产物，非本轮交付目标
Release APK: dist/apk/release/ShineWriter-V2.5.1-release.apk（37,190,635 bytes）
Release SHA-256: （APK SHA-256 已记录）
Signer certificate SHA-256: 017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a
Signature: APK Signature Scheme v2 / 1 signer / PASS
zipalign: 16 KB page alignment verification successful
AAPT: com.shinewriter / versionName V2.5.1 / versionCode 2050100 / compileSdk 36
Minified Release APK: 未构建；正式交付使用指南规定的非 minified Release
```

## 新安装与升级

- [x] 新安装测试通过（专用 Debug AVD）
- [x] V2.4.6 → V2.5.1 模拟器保留数据覆盖升级通过（Schema 14 → 15）
- [x] Schema 3 到当前 Schema 的历史数据库自动化矩阵通过
- [x] 启动后 Schema 15、`foreign_key_check` 空、`integrity_check=ok`
- [x] 备份恢复测试通过
- [x] 恢复失败时原数据库和保护性备份均可用（statement 注入）

证据：

```text
Clean-install device: Android 模拟器 / x86_64 模拟器 / Android 17 API 37 / x86_64
Upgrade source version / device: V2.4.6 → V2.5.1 的 Schema 路径与 V2.5.0 模拟器覆盖升级证据等价；V2.5.1 仅含取消修复和发布元数据，历史 Schema fixtures 自动化通过
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
Device model / Android version: x86_64 模拟器 / Android 17 API 37 / Android 模拟器
ADB or Maestro evidence: 本地 test-logs/ 证据（最终 APK，6/6 PASS）
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
Logcat / app diagnostics: 本地 test-logs/ 证据
Open issues: D7 migration kill、D8 restore kill、D9 GGUF import kill、D10 native OOM BLOCKED；D12 PARTIAL
```

## 发布与回滚

- [ ] GitHub Release 已创建
- [x] Release notes 包含功能、升级风险、已知限制、APK SHA-256 和支持范围
- [ ] APK 可从 [GitHub Releases](https://github.com/anjingdtl/tavo-mini/releases) 下载
- [ ] 发布页面没有暴露 API Key、签名密码或用户数据库
- [ ] 已保留上一版 APK、上一版 SHA-256 和回滚说明
- [ ] `main` 与 `origin/main` 已通过 `git rev-list --left-right --count main...origin/main` 确认 `0 0`

证据：

```text
Release URL: 本轮发布 annotated source Tag V2.5.1，不创建 GitHub Release；Tag URL 为 https://github.com/anjingdtl/tavo-mini/tree/V2.5.1
Release artifact: dist/apk/release/ShineWriter-V2.5.1-release.apk；SHA-256 （APK SHA-256 已记录）
Previous release / rollback artifact: 历史源码 Tag 保留；本轮未重新验收上一签名 APK
main parity: 发布后执行 `git rev-list --left-right --count main...origin/main`，目标 `0 0`
```
