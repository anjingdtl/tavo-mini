# Release APK acceptance per docs/RELEASE_APK_BUILD.md "构建后验收".
# Runs apksigner / zipalign / aapt / Get-FileHash without exposing signing secrets.
$version = (Get-Content -Raw package.json | ConvertFrom-Json).version
$apk = Resolve-Path -LiteralPath "dist/apk/release/ShineWriter-V$version-release.apk"
$buildTools = Get-ChildItem "$env:LOCALAPPDATA/Android/Sdk/build-tools" -Directory |
  Sort-Object { [version]$_.Name } -Descending |
  Select-Object -First 1

Write-Host "=== APK path ==="
Get-Item $apk | Select-Object FullName, Length, LastWriteTime | Format-List

Write-Host "=== apksigner ==="
& "$($buildTools.FullName)/apksigner.bat" verify --verbose --print-certs $apk
$signerExit = $LASTEXITCODE
Write-Host "apksigner exit: $signerExit"

Write-Host "=== zipalign ==="
& "$($buildTools.FullName)/zipalign.exe" -c -P 16 -v 4 $apk | Select-Object -Last 3
$zipExit = $LASTEXITCODE
Write-Host "zipalign exit: $zipExit"

Write-Host "=== aapt badging ==="
& "$($buildTools.FullName)/aapt.exe" dump badging $apk |
  Select-String '^package:'

Write-Host "=== SHA-256 ==="
Get-FileHash -Algorithm SHA256 $apk | Format-List

if ($signerExit -ne 0) { throw "apksigner verify failed" }
if ($zipExit -ne 0) { throw "zipalign verify failed" }
