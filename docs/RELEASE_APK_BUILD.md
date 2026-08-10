# ShineWriter 正式 APK 构建与验收指南

本文件是 ShineWriter 正式签名 APK 的唯一操作指南。发版前必须先阅读本文件，并同步执行 [正式 APK 发版检查清单](RELEASE_CHECKLIST.md)。

## 1. 固定约束

- 项目是 Android-only；正式构建要求 Node `>=24.3.0`、JDK 17、Android SDK 和可用的 Android Build Tools。
- 正式 keystore 是仓库内的本地忽略文件：
  - 当前工作机绝对路径：`E:\AiWorkSpace\tavo-mini\android\keystores\tavo-mini-release.keystore`
  - 仓库相对路径：`android/keystores/tavo-mini-release.keystore`
  - alias：`tavo-mini-release`
  - 证书 SHA-256：`017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`
- 不得创建新 keystore、改用 Debug 签名、提交或复制 keystore、从 Git 历史传播密码，也不得把密码写入仓库或构建日志。
- Release 构建必须提供以下四个环境变量；Gradle 不使用默认密码：
  - `SHINE_WRITER_RELEASE_STORE_FILE`
  - `SHINE_WRITER_RELEASE_STORE_PASSWORD`
  - `SHINE_WRITER_RELEASE_KEY_ALIAS`
  - `SHINE_WRITER_RELEASE_KEY_PASSWORD`
- 对外交付 APK 只能取自 `dist/apk/release/ShineWriter-V<版本>-release.apk`。`android/app/build/outputs/apk/` 只是 Gradle 中间产物，不能作为交付路径。
- `src/constants/version.json` 是生成文件，不能手工编辑；它由 `npm run prebuild` 生成。

## 2. 发版前准备

从仓库根目录执行：

```powershell
git status --short --branch
git fetch origin
git rev-list --left-right --count HEAD...origin/main
node --version
java -version
```

确认工作区中的改动均属于本次发版，并确认没有把本地测试数据库、截图、日志或其他调试产物带入提交。

### 2.1 一次性修正 keystore 路径

如果 Windows 用户级变量仍保留旧的 `D:\...` 路径，先在仓库根目录执行下面的迁移命令。它只更新 keystore 文件路径，不会读取、打印或修改任何密码：

```powershell
$repoRoot = (Resolve-Path -LiteralPath '.').Path
$keystorePath = Join-Path $repoRoot 'android\keystores\tavo-mini-release.keystore'
if (-not (Test-Path -LiteralPath $keystorePath)) {
  throw "Release keystore missing: $keystorePath"
}

[Environment]::SetEnvironmentVariable(
  'SHINE_WRITER_RELEASE_STORE_FILE',
  $keystorePath,
  'User'
)
# 当前 PowerShell 进程不会自动读取刚写入的 User 变量，因此同时设置 Process 变量。
$env:SHINE_WRITER_RELEASE_STORE_FILE = $keystorePath
```

四项变量均只做“是否存在”检查，不要用 `echo`、`Write-Host` 或日志输出密码：

```powershell
$releaseVariableNames = @(
  'SHINE_WRITER_RELEASE_STORE_FILE',
  'SHINE_WRITER_RELEASE_STORE_PASSWORD',
  'SHINE_WRITER_RELEASE_KEY_ALIAS',
  'SHINE_WRITER_RELEASE_KEY_PASSWORD'
)
$missing = @(
  $releaseVariableNames | Where-Object {
    [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_, 'Process')) -and
    [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_, 'User'))
  }
)
if ($missing.Count -gt 0) {
  throw "Missing release vars: $($missing -join ', ')"
}
```

也可以直接使用仓库内的辅助脚本 `scripts/build-release-apk.ps1`；它会把 User 级变量加载到当前进程，并在构建前检查 keystore 是否存在。路径迁移完成后，User 级变量必须指向上述 `android\keystores` 文件。

## 3. 升版本号并同步锁文件

不要只修改 `package.json`。版本发布必须用 `npm version`，这样会同时更新 `package.json` 和 `package-lock.json`：

```powershell
# 示例：将下面的值替换为实际的 major.minor.patch，不要带 V 前缀
$nextVersion = '2.11.42'
npm version $nextVersion --no-git-tag-version --ignore-scripts
```

随后执行：

```powershell
npm run prebuild
```

该命令会根据 `package.json` 生成 `src/constants/version.json`，并刷新 README 的版本徽章。发版前还必须：

1. 在 `CHANGELOG.md` 顶部增加当前版本的正式条目。
2. 更新 `README.md` 中的当前版本、目标正式 APK 文件名、`versionName` 和 `versionCode`。
3. 检查以下文件必须同时出现在变更中：`package.json`、`package-lock.json`、`src/constants/version.json`、`README.md`、`CHANGELOG.md`。
4. 不要手工修改 `src/constants/version.json`；如果版本元数据不一致，重新运行 `npm run prebuild`。

版本关系由脚本统一校验：

```powershell
npm run verify:version
```

如果本次发版同时变更依赖，应在修改 `package.json` 后执行 `npm install --package-lock-only`，再重新执行 `npm run verify:version`；版本号变更本身优先使用上面的 `npm version`，不要手改 lock 文件的局部字段。

## 4. 质量门禁

正式 APK 构建前必须跑完整门禁：

```powershell
npm run verify
```

它会依次执行 lint、TypeScript 类型检查、版本一致性检查和 Jest CI。任何一项失败都不能继续发版。修复或确认改动后重新执行，不能用旧日志代替当前提交的结果。

## 5. 构建正式 APK

推荐使用项目辅助脚本：

```powershell
.\scripts\build-release-apk.ps1
```

该脚本最终执行 `npm run apk:release`。也可以在四项环境变量已经注入当前进程、且 keystore 路径已确认后直接执行：

```powershell
npm run apk:release
```

构建脚本会先运行 `prebuild`，再由 Gradle 强制校验 Release 签名变量和 keystore 文件，最后把产物复制到：

```text
dist/apk/release/ShineWriter-V<当前版本>-release.apk
```

正式发布默认使用非混淆 Release。`npm run apk:release:minified` 仅用于明确安排过完整真机矩阵后的 R8 评估，不得未经额外验收直接替代正式包。

## 6. 构建后硬验收

构建成功不等于可以发版。必须在仓库根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-release-apk.ps1
```

`scripts/verify-release-apk.ps1` 会对当前版本目标 APK 做硬断言：

- APK 路径和文件名与当前版本一致。
- `apksigner` 成功，明确启用 v2 签名，且 signer 数量为 1。
- 证书 SHA-256 严格等于 `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`。
- `zipalign -c -P 16 -v 4` 返回成功。
- 包名为 `com.shinewriter`，`versionName` 和 `versionCode` 与 `src/constants/version.json` 一致。
- 计算并输出 APK 文件 SHA-256。

脚本不读取签名密码、不创建 keystore，也不接受 Debug 签名兜底。任一断言失败都必须停止发版。

## 7. 设备安装与启动验收

在可用 Android 设备或模拟器上至少完成覆盖安装和冷启动：

```powershell
$versionName = (Get-Content -Raw 'src/constants/version.json' | ConvertFrom-Json).versionName
$apk = "dist/apk/release/ShineWriter-$versionName-release.apk"

adb install -r $apk
adb shell dumpsys package com.shinewriter | Select-String 'versionName|versionCode'
adb shell monkey -p com.shinewriter 1
```

验收要求：

- `adb install -r` 成功，设备显示当前 `versionName`/`versionCode`。
- 应用可以冷启动进入主界面，无 `FATAL EXCEPTION` 或启动崩溃。
- 覆盖安装验收不得执行 `adb uninstall`、`pm clear` 或其他清空应用数据操作；用户已保存的章节正文必须保留。
- 如本轮包含数据库、迁移、备份、LLM 或关键写作流程改动，按 `docs/EMULATOR_QA_PLAYBOOK.md` 和对应专项测试报告补做功能回归。

## 8. 提交与推送前复核

正式 APK、`dist/`、Gradle 中间产物和签名文件均不提交。提交前执行：

```powershell
git status --short
git diff --stat
git diff --check
git add <本次确认过的源码、测试和文档>
git diff --cached --name-status
git diff --cached --check
```

重点确认版本发布至少包含：

```text
package.json
package-lock.json
src/constants/version.json
README.md
CHANGELOG.md
docs/RELEASE_APK_BUILD.md（如本文件本次有更新）
测试报告（如本次发版要求提交）
```

提交信息应包含版本号和变更主题。只有在明确要求时才执行 `git push origin main`；推送后核对：

```powershell
git status --short
git rev-parse HEAD
git rev-parse origin/main
git rev-list --left-right --count HEAD...origin/main
```

最后一个计数应为 `0  0`，并把 APK 路径、版本元数据、验收结果、APK SHA-256、提交号和仍存在的 warning/限制写入发版记录。

## 9. 常见阻断项

| 现象 | 处理 |
| --- | --- |
| `package-lock.json !== package.json` | 重新使用 `npm version`；若是依赖变更，再运行 `npm install --package-lock-only`，随后 `npm run prebuild` 和 `npm run verify:version`。 |
| `version.json` 或 README 版本不一致 | 运行 `npm run prebuild`，不要手改 `version.json`。 |
| keystore 指向旧的 `D:\...` 或文件不存在 | 将 `SHINE_WRITER_RELEASE_STORE_FILE` 更新为仓库 `android\keystores\tavo-mini-release.keystore`，同时更新 User 和当前 Process 变量。 |
| Release signing 环境变量缺失 | 只补齐 User/Process 环境变量，不把密码写入脚本、仓库或日志。 |
| 证书、v2、signer、zipalign 或版本验收失败 | 停止发版，禁止改用 Debug 签名或新建 keystore 规避。 |
| `versionCode` 回退 | 提升 `package.json` 版本，或在明确的 CI 构建场景使用合法的 `SHINE_WRITER_BUILD_NUMBER`（0–99）；不要手改 `version.json`。 |
