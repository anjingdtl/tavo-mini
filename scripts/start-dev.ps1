# ShineWriter 一键启动（Windows）
# 文件编码：UTF-8 with BOM。由根目录「一键启动.bat」双击调用。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
try { $null = cmd /c "chcp 65001 >nul" } catch { }

$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $Root 'package.json'))) {
  throw "找不到仓库根目录 package.json：$Root"
}
Set-Location -LiteralPath $Root

function Import-DevEnvironment {
  $machineJava = [Environment]::GetEnvironmentVariable('JAVA_HOME', 'Machine')
  $userJava = [Environment]::GetEnvironmentVariable('JAVA_HOME', 'User')
  if ($userJava) { $env:JAVA_HOME = $userJava }
  elseif ($machineJava) { $env:JAVA_HOME = $machineJava }

  $sdk = [Environment]::GetEnvironmentVariable('ANDROID_HOME', 'User')
  if (-not $sdk) { $sdk = [Environment]::GetEnvironmentVariable('ANDROID_HOME', 'Machine') }
  if (-not $sdk) { $sdk = [Environment]::GetEnvironmentVariable('ANDROID_SDK_ROOT', 'User') }
  if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
  $env:ANDROID_HOME = $sdk
  $env:ANDROID_SDK_ROOT = $sdk

  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $extra = @(
    (Join-Path $env:JAVA_HOME 'bin'),
    (Join-Path $sdk 'platform-tools'),
    (Join-Path $sdk 'emulator'),
    'C:\Program Files\nodejs',
    (Join-Path $env:APPDATA 'npm')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $env:Path = (@($extra + $machinePath + $userPath + $env:Path) -join ';')
}

function Get-AdbPath {
  $candidate = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
  if (Test-Path -LiteralPath $candidate) { return $candidate }
  $fromPath = Get-Command adb -ErrorAction SilentlyContinue
  if ($fromPath) { return $fromPath.Source }
  throw "找不到 adb。请确认 ANDROID_HOME=$env:ANDROID_HOME"
}

function Get-EmulatorPath {
  $candidate = Join-Path $env:ANDROID_HOME 'emulator\emulator.exe'
  if (Test-Path -LiteralPath $candidate) { return $candidate }
  throw "找不到 emulator.exe"
}

function Get-DeviceSerial {
  param($Adb)
  $lines = & $Adb devices | Where-Object { $_ -match "`tdevice$" }
  if (-not $lines) { return $null }
  return (($lines | Select-Object -First 1) -split "`t")[0].Trim()
}

function Test-LocalPort {
  param([int]$Port)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $client.Connect('127.0.0.1', $Port)
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Wait-Port {
  param([int]$Port, [int]$TimeoutSec = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    if (Test-LocalPort -Port $Port) { return $true }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Ensure-Emulator {
  param($Adb)
  $serial = Get-DeviceSerial -Adb $Adb
  if ($serial) {
    Write-Host "已连接设备：$serial"
    return $serial
  }

  $emu = Get-EmulatorPath
  $avds = & $emu -list-avds
  if (-not $avds) { throw "没有可用的 Android 模拟器（AVD）。请先在 Android Studio 里创建一个。" }
  $avd = ($avds | Where-Object { $_ -eq 'Medium_Phone' } | Select-Object -First 1)
  if (-not $avd) { $avd = ($avds | Select-Object -First 1).Trim() }
  Write-Host "正在启动模拟器：$avd"
  Start-Process -FilePath $emu -ArgumentList @('-avd', $avd, '-netdelay', 'none', '-netspeed', 'full') -WindowStyle Normal | Out-Null

  Write-Host "等待设备接入..."
  & $Adb wait-for-device
  $deadline = (Get-Date).AddMinutes(4)
  do {
    $boot = (& $Adb shell getprop sys.boot_completed 2>$null | Out-String).Trim()
    if ($boot -eq '1') { break }
    Start-Sleep -Seconds 3
  } while ((Get-Date) -lt $deadline)
  $serial = Get-DeviceSerial -Adb $Adb
  if (-not $serial) { throw "模拟器已启动，但 adb 没有看到 device 状态。" }
  Write-Host "模拟器就绪：$serial"
  return $serial
}

function Ensure-Metro {
  if (Wait-Port -Port 8081 -TimeoutSec 2) {
    Write-Host "Metro 已在 8081 端口运行。"
    return
  }
  Write-Host "正在新窗口启动 Metro..."
  $cmd = @"
Set-Location -LiteralPath '$Root'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
cmd /c "chcp 65001 >nul"
Write-Host 'ShineWriter Metro'
npm start
"@
  Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoExit', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd
  ) | Out-Null
  if (-not (Wait-Port -Port 8081 -TimeoutSec 90)) {
    throw "Metro 在 90 秒内没有监听 8081。请查看新打开的 Metro 窗口。"
  }
  Write-Host "Metro 已就绪（8081）。"
}

function Start-ShineWriter {
  param($Adb, $Serial)
  $pkg = 'com.shinewriter'
  $path = (& $Adb -s $Serial shell pm path $pkg 2>$null | Out-String).Trim()
  if ($path -match 'package:') {
    Write-Host "已安装 $pkg，正在拉起主界面（不卸载、不清数据）..."
    & $Adb -s $Serial shell am start -n "$pkg/.MainActivity" | Out-Host
  } else {
    Write-Host "设备上还没有安装应用，正在执行 npm run android..."
    npm run android
  }
  Start-Sleep -Seconds 8
  $appPid = (& $Adb -s $Serial shell pidof $pkg 2>$null | Out-String).Trim()
  if (-not $appPid) {
    throw "应用进程没有起来。请查看 Metro 窗口和 logcat。"
  }
  Write-Host "ShineWriter 已启动。pid=$appPid"
}

Import-DevEnvironment
Write-Host "仓库：$Root"
Write-Host "JAVA_HOME=$env:JAVA_HOME"
Write-Host "ANDROID_HOME=$env:ANDROID_HOME"

if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules'))) {
  throw "还没有 node_modules。请先在仓库根目录执行 npm install。"
}

$adb = Get-AdbPath
$serial = Ensure-Emulator -Adb $adb
Ensure-Metro
Start-ShineWriter -Adb $adb -Serial $serial
Write-Host "一键启动完成。请保持 Metro 窗口开着。"
