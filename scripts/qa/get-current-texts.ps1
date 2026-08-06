param()
$ErrorActionPreference = 'Continue'
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
$Serial = 'emulator-5554'
& $adb -s $Serial shell uiautomator dump /sdcard/now.xml | Out-Null
& $adb -s $Serial exec-out cat /sdcard/now.xml > test-logs/now.xml
$matches = Select-String -LiteralPath test-logs/now.xml -Pattern 'text="([^"]*)"' -AllMatches
$texts = @()
foreach ($m in $matches.Matches) {
  if ($m.Groups[1].Value) { $texts += $m.Groups[1].Value }
}
$texts | Select-Object -Unique
