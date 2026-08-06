param(
  [int]$WaitSeconds = 0,
  [string]$RunDir = 'test-logs\emulator-qa-run',
  [string]$XmlName = 'ui-now.xml'
)

$ErrorActionPreference = 'Continue'
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
$adbDir = Split-Path -Parent $adb
$env:Path = "$adbDir;$env:Path"
$Serial = 'emulator-5554'
New-Item -ItemType Directory -Path $RunDir -Force | Out-Null

if ($WaitSeconds -gt 0) { Start-Sleep -Seconds $WaitSeconds }

& $adb -s $Serial shell uiautomator dump /sdcard/$XmlName | Out-Null
& $adb -s $Serial exec-out cat /sdcard/$XmlName > (Join-Path $RunDir $XmlName)
& $adb -s $Serial exec-out screencap -p > (Join-Path $RunDir ($XmlName -replace '\.xml$', '.png'))

$TextsOut = Join-Path $RunDir ($XmlName -replace '\.xml$', '-texts.txt')
node scripts/qa/ui-list-texts.mjs $Serial (Join-Path $RunDir $XmlName) 2>&1 | Tee-Object -FilePath $TextsOut
