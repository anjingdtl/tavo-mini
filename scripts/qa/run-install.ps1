# TAVO-MINI QA helper v3: install + launch + dump.
$ErrorActionPreference = 'Continue'
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
$Serial = 'emulator-5554'
$Package = 'com.shinewriter'
$RunDir = 'test-logs\emulator-qa-run'
New-Item -ItemType Directory -Path $RunDir -Force | Out-Null

function AdbShell([string]$cmd) {
  & $adb -s $Serial shell $cmd
}

Write-Host '== ensure device ==' -ForegroundColor Cyan
& $adb devices | Out-Null
& $adb -s $Serial wait-for-device

$Apk = Get-ChildItem -Path 'dist\apk\debug' -Filter 'ShineWriter-V*-debug.apk' |
  Sort-Object { [version]($_.BaseName -replace 'ShineWriter-V','' -replace '-debug','') } -Descending |
  Select-Object -First 1
if (-not $Apk) { Write-Error 'No debug APK in dist/apk/debug'; exit 2 }
$ApkPath = $Apk.FullName
Write-Host "apk=$ApkPath size=$([math]::Round($Apk.Length/1MB,2)) MB" -ForegroundColor Yellow

Write-Host '== install -r ==' -ForegroundColor Cyan
& $adb -s $Serial install -r $ApkPath

Write-Host '== stop + start ==' -ForegroundColor Cyan
& $adb -s $Serial shell am force-stop $Package
Start-Sleep -Seconds 1
& $adb -s $Serial logcat -c
& $adb -s $Serial shell am start -n "$Package/.MainActivity"
Start-Sleep -Seconds 6

Write-Host '== ui-dump current screen ==' -ForegroundColor Cyan
& $adb -s $Serial shell uiautomator dump /sdcard/tavo-mini-qa-current.xml | Out-Null
& $adb -s $Serial exec-out cat /sdcard/tavo-mini-qa-current.xml > (Join-Path $RunDir 'ui-current.xml')
& $adb -s $Serial exec-out screencap -p > (Join-Path $RunDir 'screen-current.png')

$adbDir = Split-Path -Parent $adb
$env:Path = "$adbDir;$env:Path"
node scripts/qa/ui-list-texts.mjs $Serial (Join-Path $RunDir 'ui-current.xml') > (Join-Path $RunDir 'ui-current-texts.txt') 2>&1
Get-Content (Join-Path $RunDir 'ui-current-texts.txt')
