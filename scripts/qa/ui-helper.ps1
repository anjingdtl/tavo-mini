param(
  [Parameter(Mandatory=$true)][string]$Op,
  [string]$Needle = '',
  [string]$Xml = 'ui-now.xml',
  [int]$WaitMs = 1500
)

$ErrorActionPreference = 'Continue'
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
$adbDir = Split-Path -Parent $adb
$env:Path = "$adbDir;$env:Path"
$Serial = 'emulator-5554'
$RunDir = 'test-logs\emulator-qa-run'
New-Item -ItemType Directory -Path $RunDir -Force | Out-Null

function Dump-Now([string]$Name) {
  & $adb -s $Serial shell uiautomator dump /sdcard/$Name | Out-Null
  & $adb -s $Serial exec-out cat /sdcard/$Name > (Join-Path $RunDir $Name)
  & $adb -s $Serial exec-out screencap -p > (Join-Path $RunDir ($Name -replace '\.xml$', '.png'))
  return (Join-Path $RunDir $Name)
}

function List-Texts([string]$xml) {
  $txt = Join-Path $RunDir ($xml -replace '\.xml$', '-texts.txt')
  node scripts/qa/ui-list-texts.mjs $Serial (Join-Path $RunDir $xml) 2>&1 | Tee-Object -FilePath $txt
}

switch ($Op) {
  'list' {
    $x = Dump-Now $Xml
    List-Texts $Xml
  }
  'find' {
    if (-not $Needle) { Write-Error 'find requires -Needle'; exit 2 }
    $x = Dump-Now $Xml
    node scripts/qa/ui-find.mjs $Serial $Needle (Join-Path $RunDir $Xml) 2>&1
  }
  'tap' {
    if (-not $Needle) { Write-Error 'tap requires -Needle'; exit 2 }
    $x = Dump-Now $Xml
    $args = @('--serial', $Serial, '--match', $Needle, '--partial', '--dump', $x)
    node scripts/qa/ui-tap.mjs @args 2>&1
    Start-Sleep -Milliseconds $WaitMs
    $next = $Xml -replace '\.xml$','-after.xml'
    $x2 = Dump-Now $next
    List-Texts $next
  }
  default {
    Write-Error "Op must be: list | find | tap"
    exit 2
  }
}
