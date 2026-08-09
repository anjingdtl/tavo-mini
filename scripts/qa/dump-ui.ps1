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

$XmlPath = Join-Path $RunDir $XmlName
$PngPath = Join-Path $RunDir ($XmlName -replace '\.xml$', '.png')
if (Test-Path -LiteralPath $XmlPath) { Remove-Item -LiteralPath $XmlPath -Force }
if (Test-Path -LiteralPath $PngPath) { Remove-Item -LiteralPath $PngPath -Force }

if ($WaitSeconds -gt 0) { Start-Sleep -Seconds $WaitSeconds }

$dumpOutput = & $adb -s $Serial shell uiautomator dump /sdcard/$XmlName 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "uiautomator dump failed: $dumpOutput"
}
& $adb -s $Serial exec-out cat /sdcard/$XmlName > $XmlPath
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $XmlPath)) {
  throw "unable to read UI XML: $XmlPath"
}
& $adb -s $Serial exec-out screencap -p > $PngPath
if ($LASTEXITCODE -ne 0) {
  throw "unable to capture screenshot: $PngPath"
}

$TextsOut = Join-Path $RunDir ($XmlName -replace '\.xml$', '-texts.txt')
node scripts/qa/ui-list-texts.mjs $Serial (Join-Path $RunDir $XmlName) 2>&1 | Tee-Object -FilePath $TextsOut
