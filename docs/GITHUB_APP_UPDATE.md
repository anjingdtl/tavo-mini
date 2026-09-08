# GitHub Releases 应用内更新规范

本文档定义 ShineWriter 从 V3.0.0 开始使用的 Android 应用内更新协议和发布流程。更新只面向公开仓库 `anjingdtl/tavo-mini`，客户端不内置 GitHub Token，也不执行静默安装。

## 架构与安全边界

应用进入主界面后才会异步检查 GitHub `releases/latest`，不会阻塞 Splash、SQLite 初始化、迁移或本地写作。自动检查成功结果缓存 24 小时；“设置 → 关于 → 检查更新”始终强制发起检查。网络异常、HTTP 403/404/5xx、超时和无效 Release 只会显示失败提示。

JS 更新服务负责：

- 请求 `https://api.github.com/repos/anjingdtl/tavo-mini/releases/latest`；
- 过滤 Draft/Prerelease，并校验 tag、`update.json` 和 APK asset；
- 只在 `remoteVersionCode > localVersionCode` 时提示更新；
- 将 APK 下载到应用 cache 的 `updates/` 子目录，先写 `.apk.part`，完成并校验后再原子移动为正式 APK；
- 处理重复检查、重复下载、生命周期和重试。

Android `AppUpdate` 原生模块负责：

- 读取当前安装包 versionName/versionCode；
- 流式计算下载 APK 的 SHA-256；
- 用 PackageManager 校验包名、versionCode 和 signing certificate；
- 检查/打开 Android 8+ “允许安装未知来源应用”设置；
- 通过受限 `content://` FileProvider 调起系统安装器。

正式证书指纹沿用 [正式 APK 构建指南](RELEASE_APK_BUILD.md) 的唯一规则：

`017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`

## update.json 协议

每个正式 GitHub Release 必须包含 `update.json` 和同版本正式 APK：

```json
{
  "versionName": "3.0.0",
  "versionCode": 3000000,
  "apkName": "ShineWriter-V3.0.0-release.apk",
  "apkUrl": "",
  "sha256": "<64 位小写 SHA-256>",
  "forceUpdate": false,
  "minimumVersionCode": 0,
  "title": "ShineWriter V3.0.0",
  "notes": ["用户可读更新说明"],
  "apkSizeBytes": 112233445
}
```

`versionName` 不带 `V`，展示时统一显示 `V3.0.0`。`apkUrl` 可以留空，客户端会使用同一 Release 的 APK asset 下载地址；如果填写，必须与该 asset 的 GitHub HTTPS 地址完全一致。`apkSizeBytes` 由脚本生成，便于 UI 展示和发布前比对。

客户端拒绝以下情况：字段缺失或类型错误、版本号非法、tag 与版本不一致、APK 文件名不符合 `ShineWriter-V<version>-release.apk`、缺少 APK/update.json asset、非 GitHub HTTPS URL、SHA-256 不匹配、包名不是 `com.shinewriter`、签名证书不匹配或 APK versionCode 不等于 metadata。

## 正式发布步骤

在主构建机上完成质量门禁和正式签名：

```powershell
npm run verify
.\scripts\build-release-apk.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-release-apk.ps1
npm run release:metadata
npm run release:verify
```

产物位于：

```text
dist/apk/release/ShineWriter-V3.0.0-release.apk
dist/apk/release/update.json
```

上传前确认 `update.json` 中的 `sha256` 等于 Release APK 实际 SHA-256。GitHub Release 使用：

- Tag：`V3.0.0`
- Title：`ShineWriter V3.0.0`
- Assets：上述 APK 和 `update.json`
- Body：从 CHANGELOG 的 `[3.0.0]` 条目整理用户可读更新说明

本仓库默认不由 Agent 执行 `git push`、创建 tag、创建 GitHub Release 或上传 APK；这些步骤由发布人明确确认后操作。

## 手工测试

1. 在已安装正式签名旧版本的设备上创建测试作品、章节正文、人物/设定，并修改一项设置。
2. 使用 `adb install -r` 安装新正式 APK；不得先卸载应用、`pm clear` 或删除数据目录。
3. 冷启动应用，确认项目、正文、资料库、设置和数据库仍可读取。
4. 在设置页点击“检查更新”，分别验证已是最新、发现新版、HTTP/网络失败状态。
5. 在测试 Release 上验证下载进度、断网重试、SHA-256 失败、签名失败、包名/版本失败和未知来源授权。
6. 授权后返回应用，确认系统安装器被打开；最终安装确认由 Android 系统完成。
7. 采集 `adb logcat`，确认没有新增 `FATAL EXCEPTION`。

覆盖升级的核心命令是：

```powershell
adb install -r dist/apk/release/ShineWriter-V3.0.0-release.apk
adb shell dumpsys package com.shinewriter | Select-String 'versionName|versionCode'
```

## 回滚策略

如果 V3.x 发布后发现问题，优先修复并发布更高 versionCode 的正式版本。不要复用旧 versionCode，也不要让 latest 指向低于已安装版本的 APK；客户端会主动拒绝降级。若必须暂时停止更新，可暂停/撤下有问题的 Release asset，并保留现有安装包的本地使用能力。

## 常见故障

- **没有更新提示**：检查 Release 是否为 published stable、tag 是否为 `Vx.y.z`、是否同时上传 `update.json` 和同名 APK。
- **提示 metadata 无效**：重新运行 `npm run release:metadata` 和 `npm run release:verify`，不要手改 SHA-256、版本码或 APK 文件名。
- **完整性校验失败**：重新计算 APK SHA-256，确认上传文件未被替换或截断。
- **签名校验失败**：停止发布，确认使用 `android/keystores/tavo-mini-release.keystore` 和既有 alias；禁止改用 Debug key 或新建 keystore。
- **HTTP 403**：GitHub API 可能触发公开 API rate limit；等待限流窗口恢复，或使用设置页手动稍后重试。客户端不内置 Token。
- **未知来源未授权**：只在 Android 设置中允许 ShineWriter 安装未知来源应用；拒绝授权不会循环打开设置。

## 发版 checklist

- [ ] `package.json`、`package-lock.json`、`version.json`、README、CHANGELOG 版本一致。
- [ ] `npm run verify`、正式 APK 硬验收和 signer 指纹验收通过。
- [ ] APK 为 `com.shinewriter`，版本码高于已发布版本，未更换正式证书。
- [ ] `npm run release:metadata` 生成的 `update.json` 与 APK SHA-256/大小一致。
- [ ] GitHub Release 仅包含正式 APK 与 `update.json`，不是 Draft/Prerelease。
- [ ] 覆盖安装、冷启动、数据保留和更新 UI 手工回归通过。
