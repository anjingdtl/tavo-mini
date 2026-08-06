# Test whether a single-line `echo $BASE64 | base64 -d > file` works as
# part of a `run-as com.shinewriter sh -c '...'` invocation.
$ErrorActionPreference = 'Continue'
$b64Path = $args[0]
if (-not $b64Path) {
  Write-Error 'Usage: ps1 <b64Path>'
  exit 2
}
$b64 = (Get-Content -LiteralPath $b64Path -Raw).Trim()
Write-Host "b64 length: $($b64.Length)"
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
$Serial = 'emulator-5554'

# Some shells interpret the trailing backtick; we sanitise to avoid surprises.
# The single b64 string must NOT contain `>` or `<` redirects to avoid command
# substitution. Our payload is sqlite b64 so it will only contain [A-Za-z0-9+/=].
if ($b64 -match '[<>]') {
  Write-Error 'b64 contains shell metacharacters; abort'
  exit 2
}

# Pass the b64 directly.  Long command lines > ~200k may be rejected by adb
# shell; if so we fall back to streaming.
$Command = "run-as com.shinewriter sh -c 'echo $b64 | base64 -d > /data/user/0/com.shinewriter/databases/shine_writer.db && ls -la /data/user/0/com.shinewriter/databases/shine_writer.db'"
& $adb -s $Serial shell $Command
