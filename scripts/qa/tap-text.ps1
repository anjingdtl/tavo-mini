param(
  [Parameter(Mandatory=$true)][string]$Text,
  [Parameter(Mandatory=$true)][string]$DumpOut,
  [int]$WaitMs = 1500
)

$ErrorActionPreference = 'Continue'
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
$env:Path = (Split-Path -Parent $adb) + ';' + $env:Path
$Serial = 'emulator-5554'
$Package = 'com.shinewriter'

function AdbShell([string]$cmd) {
  & $adb -s $Serial shell $cmd
}

# tap text on UI tree
$dump = AdbShell uiautomator dump /sdcard/tap-target.xml
$null = & $adb -s $Serial exec-out cat /sdcard/tap-target.xml
$xmlRaw = (& $adb -s $Serial exec-out cat /sdcard/tap-target.xml)
Set-Content -LiteralPath (Join-Path 'test-logs\emulator-qa-start' $DumpOut) -Value $xmlRaw -Encoding UTF8

$node = node scripts/qa/ui-tap.mjs --serial $Serial --match $Text --partial --dump (Join-Path 'test-logs\emulator-qa-start' $DumpOut) 2>&1
Write-Host $node
Start-Sleep -Milliseconds $WaitMs
