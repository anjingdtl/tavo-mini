# ShineWriter 发布清单

本清单用于每个 Android 发布版本。勾选前把命令输出、APK 路径、设备型号或 GitHub Actions URL 写入对应的证据栏；无法执行的项目必须注明原因和替代验证，不得默认为通过。

当前主线同步基线（2026-07-16）：本地 `npm run test:ci` 为 78 个 suite / 381 个测试通过；GitHub Actions `Verify` 的迁移矩阵和 Android Debug 已通过，但 JavaScript Jest 步骤仍有超时记录，因此本清单不把远端质量门禁默认为通过。

## 版本与文档

- [ ] `package.json` 的 `version` 已更新
- [ ] `src/constants/version.json` 已由 `npm run prebuild` 生成并与版本一致
- [ ] Android `versionCode` 已递增且没有回退
- [ ] `CHANGELOG.md` 已更新
- [ ] `README.md` 与当前功能、测试数量、模型支持和隐私边界一致
- [ ] 发布说明包含升级风险、已知限制和兼容性变化

证据：

```text
Version:
versionCode:
CHANGELOG / README commit:
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
- [ ] lint 通过（仅允许已记录的非阻断 warning）
- [ ] typecheck 通过
- [ ] Jest 通过
- [ ] coverage 通过全局和定向阈值
- [ ] migration matrix 通过
- [ ] GitHub Actions `Verify` 的 JavaScript、Android Debug、Migration jobs 全部成功

证据：

```text
Local commands / logs:
GitHub Actions run URL:
```

## Android 构建与签名

```powershell
npm run apk:debug
npm run apk:release
Get-FileHash -Algorithm SHA256 dist/apk/release/ShineWriter-V<version>-release.apk
```

- [ ] Android Debug 构建成功
- [ ] Android Release 构建成功
- [ ] Release APK 位于 `dist/apk/release/ShineWriter-V{version}-release.apk`
- [ ] Release 使用外部签名变量：`SHINE_WRITER_RELEASE_STORE_FILE`、`SHINE_WRITER_RELEASE_STORE_PASSWORD`、`SHINE_WRITER_RELEASE_KEY_ALIAS`、`SHINE_WRITER_RELEASE_KEY_PASSWORD`
- [ ] APK 签名证书正确：`apksigner verify --verbose --print-certs <apk>`
- [ ] APK SHA-256 已生成并复制到发布说明
- [ ] 未把密码、Keychain 内容或本地数据库提交到 Git

证据：

```text
Debug APK:
Release APK:
Signer certificate digest:
SHA-256:
```

## 新安装与升级

- [ ] 新安装测试通过
- [ ] 老版本升级测试通过
- [ ] Schema 3 到当前 Schema 的历史数据库矩阵通过
- [ ] 启动后 Schema 版本正确、外键检查通过、无重复或孤儿记录
- [ ] 备份恢复测试通过
- [ ] 恢复失败时原数据库和保护性备份均可用

证据：

```text
Clean-install device:
Upgrade source version / device:
Migration matrix result:
Backup/restore result:
```

## 核心功能实机验证

- [ ] 项目创建、切换和删除通过
- [ ] 章节创建、编辑、2 秒自动保存、退出再进入持久化通过
- [ ] 在线模型测试通过
- [ ] 本地 GGUF 模型导入、校验、加载、生成、取消通过
- [ ] TTS 配置、播放、停止和完成回收通过
- [ ] 前台/后台切换后写作和流水线状态正确
- [ ] 流水线排队、取消、失败反馈和恢复通过
- [ ] 低内存或内存压力后不会启动新的 LLM 请求，回到前台后队列可恢复
- [ ] 局域网 HTTP 开关默认关闭；开启后只允许私有 IPv4，公网 HTTP 仍被阻止

证据：

```text
Device model / Android version:
ADB or Maestro evidence:
Online provider:
Local GGUF model:
TTS engine:
```

## 故障注入回归

- [ ] migration 第三条 SQL 失败
- [ ] 恢复中途失败
- [ ] 磁盘空间不足
- [ ] 备份文件损坏
- [ ] 备份 checksum 错误
- [ ] 自动保存时杀死 App
- [ ] 迁移时杀死 App
- [ ] 恢复时杀死 App
- [ ] GGUF 导入中杀死 App
- [ ] 本地模型生成时内存不足
- [ ] 在线模型请求中断网
- [ ] TTS 播放中切后台

每个故障场景都要记录：用户可见反馈、数据库状态、是否可重试、是否需要恢复备份、孤儿文件、卡死任务和诊断日志。

证据：

```text
Fault-injection report:
Logcat / app diagnostics:
Open issues:
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
Release URL:
Previous release / rollback artifact:
main parity:
```
