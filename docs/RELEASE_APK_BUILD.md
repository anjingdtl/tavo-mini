# ShineWriter Release APK 构建指南

本文是本仓库生成 Android Release APK 的唯一操作指南，尤其供自动化 Agent 和新维护者使用。不要绕过 `npm run apk:release` 直接复制 Gradle 中间产物。

## 固定事实

- 唯一构建命令：`npm run apk:release`
- 唯一交付目录：`dist/apk/release/`
- 产物命名：`ShineWriter-V<version>-release.apk`
- 版本来源：`package.json.version`
- `npm run apk:release` 会先运行 `npm run prebuild`，自动生成 `src/constants/version.json`；不要手改该文件。
- Release keystore（主构建机本地文件）：`android/keystores/tavo-mini-release.keystore`
- Key alias：`tavo-mini-release`
- 正式签名证书 SHA-256：`017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`
- Release 默认不启用 R8/资源压缩。只有明确需要评估压缩包时才使用 `npm run apk:release:minified`。

keystore 和 APK 均被 `.gitignore` 排除，不会随仓库克隆。不得新建或替换 keystore 来“解决”缺失凭据；更换签名身份会导致已安装版本无法覆盖升级。

## 环境要求

- Windows PowerShell
- Node.js `>= 24.3.0`
- JDK 17
- Android SDK 及 Build Tools
- 仓库依赖已安装（首次使用运行 `npm ci` 或 `npm install`）
- 主构建机已在 Windows 当前用户环境中保存四项 `SHINE_WRITER_RELEASE_*` 变量

Gradle 只读取当前进程环境。Codex、IDE 或终端如果早于用户环境变量启动，必须先把用户级变量加载到当前 PowerShell 进程。

## 标准构建步骤（Agent 必须照此执行）

在仓库根目录打开 PowerShell，运行以下代码。它只检查和转发变量，不打印变量值：

```powershell
$releaseVariableNames = @(
  'SHINE_WRITER_RELEASE_STORE_FILE',
  'SHINE_WRITER_RELEASE_STORE_PASSWORD',
  'SHINE_WRITER_RELEASE_KEY_ALIAS',
  'SHINE_WRITER_RELEASE_KEY_PASSWORD'
)

foreach ($name in $releaseVariableNames) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process'))) {
    $userValue = [Environment]::GetEnvironmentVariable($name, 'User')
    if (-not [string]::IsNullOrWhiteSpace($userValue)) {
      [Environment]::SetEnvironmentVariable($name, $userValue, 'Process')
    }
  }
}

$missing = @(
  $releaseVariableNames | Where-Object {
    [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_, 'Process'))
  }
)

if ($missing.Count -gt 0) {
  throw "缺少 Release 签名环境变量：$($missing -join ', ')"
}

if (-not (Test-Path -LiteralPath $env:SHINE_WRITER_RELEASE_STORE_FILE)) {
  throw 'Release keystore 不存在，请恢复原始 tavo-mini-release.keystore；不要创建新签名。'
}

npm run apk:release
if ($LASTEXITCODE -ne 0) {
  throw "Release APK 构建失败，退出码：$LASTEXITCODE"
}
```

成功日志必须包含类似内容：

```text
BUILD SUCCESSFUL
APK copied to ...\dist\apk\release\ShineWriter-V<version>-release.apk
```

## 构建后验收

下面的命令不会读取或显示签名密码：

```powershell
$version = (Get-Content -Raw package.json | ConvertFrom-Json).version
$apk = Resolve-Path -LiteralPath "dist/apk/release/ShineWriter-V$version-release.apk"
$buildTools = Get-ChildItem "$env:LOCALAPPDATA/Android/Sdk/build-tools" -Directory |
  Sort-Object { [version]$_.Name } -Descending |
  Select-Object -First 1

& "$($buildTools.FullName)/apksigner.bat" verify --verbose --print-certs $apk
if ($LASTEXITCODE -ne 0) { throw 'APK 签名验证失败' }

& "$($buildTools.FullName)/zipalign.exe" -c -P 16 -v 4 $apk
if ($LASTEXITCODE -ne 0) { throw 'APK zipalign 验证失败' }

& "$($buildTools.FullName)/aapt.exe" dump badging $apk |
  Select-String '^package:'

Get-Item $apk | Select-Object FullName, Length, LastWriteTime
Get-FileHash -Algorithm SHA256 $apk
```

验收结果必须满足：

1. `apksigner` 返回成功，证书 SHA-256 与本文固定值一致。
2. `zipalign` 输出 `Verification successful`。
3. `aapt` 显示的 `versionName` 与 `V<package.json.version>` 一致。
4. `versionCode` 与自动生成的 `src/constants/version.json` 一致。
5. APK 位于 `dist/apk/release/`，并记录文件 SHA-256。

## 常见问题

### Gradle 报缺少 `SHINE_WRITER_RELEASE_*`

通常是当前 Agent/终端进程早于用户环境变量启动。先运行“标准构建步骤”中的加载代码；不要要求用户再次发送密码，也不要把密码写入命令、日志、README、Gradle 文件或 Git。

### keystore 不存在

从受控备份恢复原始 `tavo-mini-release.keystore` 到 `android/keystores/`，或让签名材料管理员安全传递。禁止临时生成新 keystore，因为新证书无法升级旧版应用。

### 密码、alias 或签名验证失败

停止构建并检查用户级环境变量是否属于原始 keystore。禁止反复猜测密码、修改 `android/app/build.gradle` 绕过校验，或退回 Debug 签名。

### CMake 报 SDK XML、重复 `platform-tools` 或长路径警告

这些警告在既有 Windows 构建环境中可能出现。只要 Gradle 最终为 `BUILD SUCCESSFUL` 即不影响交付；若出现实际的 Ninja 长路径错误，检查 `C:/Users/<用户名>/.local/bin/ninja.exe` 是否存在，`android/app/build.gradle` 会自动优先使用它。

## 安全红线

- 不输出、提交或聊天发送 store password / key password。
- 不把签名密码重新硬编码进 `build.gradle` 或脚本。
- 不从 Git 历史恢复或传播旧密码；历史记录不是凭据存储方案。
- 不覆盖、删除或重新生成正式 keystore。
- 不用 `android/app/debug.keystore` 签 Release。
- 不手动把 `android/app/build/outputs/apk/` 中间产物复制到其它交付位置。
