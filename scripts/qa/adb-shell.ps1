param(
  [Parameter(Mandatory=$true)][string]$Cmd
)
$ErrorActionPreference = 'Continue'
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
$Serial = 'emulator-5554'

& $adb -s $Serial shell $Cmd
