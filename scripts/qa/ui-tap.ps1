# Helper: tap node matching text or content-desc from uiautomator dump.
# Usage: .\scripts\qa\ui-tap.ps1 -Serial emulator-5554 -Match "新建" [-Index 0] [-Partial]
param(
  [Parameter(Mandatory=$true)][string]$Serial,
  [Parameter(Mandatory=$true)][string]$Match,
  [int]$Index = 0,
  [switch]$Partial,
  [switch]$LongPress,
  [string]$DumpPath = $null
)
$ErrorActionPreference = 'Stop'
$tmp = if ($DumpPath) { $DumpPath } else { Join-Path $env:TEMP "ui-$Serial.xml" }
adb -s $Serial shell uiautomator dump /sdcard/ui-agent.xml | Out-Null
adb -s $Serial pull /sdcard/ui-agent.xml $tmp | Out-Null
$xml = Get-Content -Raw -Encoding UTF8 $tmp
$nodes = [regex]::Matches($xml, '<node[^>]+>')
$hits = @()
foreach ($m in $nodes) {
  $n = $m.Value
  $text = if ($n -match 'text="([^"]*)"') { $Matches[1] } else { '' }
  $desc = if ($n -match 'content-desc="([^"]*)"') { $Matches[1] } else { '' }
  $bounds = if ($n -match 'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"') {
    @{ l=[int]$Matches[1]; t=[int]$Matches[2]; r=[int]$Matches[3]; b=[int]$Matches[4] }
  } else { $null }
  if (-not $bounds) { continue }
  $hay = "$text`n$desc"
  $ok = if ($Partial) { $hay -like "*$Match*" } else { $text -eq $Match -or $desc -eq $Match }
  if ($ok) {
    $hits += [pscustomobject]@{ text=$text; desc=$desc; bounds=$bounds; cx=[int](($bounds.l+$bounds.r)/2); cy=[int](($bounds.t+$bounds.b)/2) }
  }
}
if ($hits.Count -eq 0) {
  Write-Error "No node matching '$Match' (partial=$Partial). Found $($nodes.Count) nodes."
}
if ($Index -ge $hits.Count) {
  Write-Error "Index $Index out of range; matches=$($hits.Count): $($hits | ForEach-Object { $_.text + '|' + $_.desc } | Out-String)"
}
$h = $hits[$Index]
Write-Output "TAP text='$($h.text)' desc='$($h.desc)' at $($h.cx),$($h.cy) bounds=[$($h.bounds.l),$($h.bounds.t)][$($h.bounds.r),$($h.bounds.b)]"
if ($LongPress) {
  adb -s $Serial shell input swipe $h.cx $h.cy $h.cx $h.cy 800
} else {
  adb -s $Serial shell input tap $h.cx $h.cy
}
return $h
