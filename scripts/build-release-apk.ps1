# Single-use helper to load release signing vars and build the APK.
# Reads User-scope vars into Process scope. Never prints values.
$releaseVariableNames = @(
  'SHINE_WRITER_RELEASE_STORE_FILE',
  'SHINE_WRITER_RELEASE_STORE_PASSWORD',
  'SHINE_WRITER_RELEASE_KEY_ALIAS',
  'SHINE_WRITER_RELEASE_KEY_PASSWORD'
)
foreach ($name in $releaseVariableNames) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process'))) {
    $userValue = [Environment]::GetEnvironmentVariable($name, 'User')
    if (-not [string]::IsNullOrWhiteSpace($userValue)) {
      [Environment]::SetEnvironmentVariable($name, $userValue, 'Process')
    }
  }
}
$missing = @(
  $releaseVariableNames | Where-Object {
    [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_, 'Process'))
  }
)
if ($missing.Count -gt 0) {
  throw "Missing release vars: $($missing -join ', ')"
}
if (-not (Test-Path -LiteralPath $env:SHINE_WRITER_RELEASE_STORE_FILE)) {
  throw "Release keystore missing at $env:SHINE_WRITER_RELEASE_STORE_FILE"
}
npm run apk:release
if ($LASTEXITCODE -ne 0) {
  throw "npm run apk:release failed with exit code $LASTEXITCODE"
}
