# TAVO-MINI QA helper v2: more defensive adb usage.
$ErrorActionPreference = 'Continue'
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
$Serial = 'emulator-5554'
$Package = 'com.shinewriter'
$RunDir = 'test-logs\emulator-qa-start'
New-Item -ItemType Directory -Path $RunDir -Force | Out-Null

function AdbShell([string]$cmd) {
  & $adb -s $Serial shell $cmd
}

Write-Host '== restart adb server ==' -ForegroundColor Cyan
& $adb kill-server 2>$null
Start-Sleep -Seconds 1
& $adb start-server 2>$null
Start-Sleep -Seconds 2

Write-Host '== wait-for-device ==' -ForegroundColor Cyan
& $adb -s $Serial wait-for-device

Write-Host '== devices ==' -ForegroundColor Cyan
& $adb devices

Write-Host '== device props ==' -ForegroundColor Cyan
Write-Host "release=$(AdbShell 'getprop ro.build.version.release')"
Write-Host "sdk=$(AdbShell 'getprop ro.build.version.sdk')"
Write-Host "model=$(AdbShell 'getprop ro.product.model')"
Write-Host "abi=$(AdbShell 'getprop ro.product.cpu.abi')"

Write-Host '== package info ==' -ForegroundColor Cyan
Write-Host "activity=$(AdbShell 'cmd package resolve-activity --brief $Package')"
$dump = AdbShell 'dumpsys package $Package'
$dump | Select-String 'versionName|versionCode' | ForEach-Object { Write-Host $_.Line }

Write-Host '== start MainActivity (state-aware) ==' -ForegroundColor Cyan
& $adb -s $Serial logcat -c
& $adb -s $Serial shell am force-stop $Package
Start-Sleep -Seconds 1
& $adb -s $Serial shell am start -n "$Package/.MainActivity"
Start-Sleep -Seconds 5

Write-Host '== ui dump ==' -ForegroundColor Cyan
& $adb -s $Serial shell uiautomator dump /sdcard/tavo-mini-qa-start.xml | Out-Null
& $adb -s $Serial exec-out cat /sdcard/tavo-mini-qa-start.xml > (Join-Path $RunDir 'ui-start.xml')
& $adb -s $Serial exec-out screencap -p > (Join-Path $RunDir 'screen-start.png')

Write-Host '== node ui-list-texts ==' -ForegroundColor Cyan
$adbDir = Split-Path -Parent $adb
$env:Path = "$adbDir;$env:Path"
node scripts/qa/ui-list-texts.mjs $Serial (Join-Path $RunDir 'ui-start.xml') > (Join-Path $RunDir 'ui-start-texts.txt') 2>&1
Get-Content (Join-Path $RunDir 'ui-start-texts.txt')
