param(
  [Parameter(Mandatory=$true)][string]$FeatureKey,
  [Parameter(Mandatory=$true)][string]$Value
)

$ErrorActionPreference = 'Continue'
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
$Serial = 'emulator-5554'
$Package = 'com.shinewriter'
$Tmp = Join-Path $env:TEMP "shinewriter-settings.db"

if (Test-Path $Tmp) { Remove-Item $Tmp -Force }

# Stop the app so SQLite file is not actively written (WAL flush happens on close).
& $adb -s $Serial shell am force-stop $Package
Start-Sleep -Seconds 1

Write-Host "== pulling db ==" -ForegroundColor Cyan
& $adb -s $Serial exec-out run-as $Package cat databases/shine_writer.db > $Tmp
if (-not (Test-Path $Tmp) -or (Get-Item $Tmp).Length -lt 1024) {
  Write-Error "Failed to pull database"; exit 2
}
Write-Host "size=$([math]::Round((Get-Item $Tmp).Length/1KB,1)) KB" -ForegroundColor Yellow

# Use Python's bundled sqlite3 to update settings (no system sqlite3 needed on emulator).
$python = Join-Path $env:LOCALAPPDATA 'Python\Pythoncore-3.14-64\python.exe'
if (-not (Test-Path $python)) {
  $python = (Get-Command python.exe).Source
}

$sql = @"
import sqlite3, sys, json
path = sys.argv[1]
key = sys.argv[2]
value = sys.argv[3]
con = sqlite3.connect(path)
cur = con.cursor()
# Verify table exists.
tables = [r[0] for r in cur.execute(\"SELECT name FROM sqlite_master WHERE type='table'\").fetchall()]
if 'settings' not in tables:
  print('settings table missing, available tables: ' + ','.join(tables))
  sys.exit(2)
cur.execute('SELECT key, value FROM settings WHERE key=?', (key,))
row = cur.fetchone()
if row:
  print(f'before key={row[0]} value={row[1]}')
else:
  print(f'before (missing) key={key}')
cur.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', (key, value))
con.commit()
cur.execute('SELECT key, value FROM settings WHERE key=?', (key,))
row = cur.fetchone()
print(f'after key={row[0]} value={row[1]}')
con.close()
"@
$SqlPath = Join-Path $env:TEMP "shine-toggle-flag.py"
Set-Content -LiteralPath $SqlPath -Value $sql -Encoding UTF8

Write-Host "== updating via python ==" -ForegroundColor Cyan
& $python $SqlPath $Tmp $FeatureKey $Value

Write-Host "== pushing db back ==" -ForegroundColor Cyan
# Push requires app data dir accessible via run-as; pipe via exec-out.
$Bytes = [IO.File]::ReadAllBytes($Tmp)
$Encoded = [Convert]::ToBase64String($Bytes)
# write base64 in chunks: smaller chunks are more reliable.
$TmpB64 = Join-Path $env:TEMP "shine-db-push.b64"
[Convert]::ToBase64String($Bytes) | Out-File $TmpB64 -Encoding ascii -NoNewline
& $adb -s $Serial push $TmpB64 /data/local/tmp/shine-db-push.b64 2>&1 | Out-Null
& $adb -s $Serial shell "run-as $Package sh -c 'base64 -d /data/local/tmp/shine-db-push.b64 > /data/local/tmp/shine_writer.db'" 2>&1
& $adb -s $Serial shell "run-as $Package cp /data/local/tmp/shine_writer.db databases/shine_writer.db" 2>&1
& $adb -s $Serial shell "run-as $Package rm -f /data/local/tmp/shine_writer.db /data/local/tmp/shine-db-push.b64" 2>&1

Write-Host "== verifying ==" -ForegroundColor Cyan
$Verify = Join-Path $env:TEMP "shineverify.db"
& $adb -s $Serial exec-out run-as $Package cat databases/shine_writer.db > $Verify
& $python $SqlPath $Verify $FeatureKey $Value

Remove-Item $Tmp, $TmpB64, $SqlPath, $Verify -ErrorAction SilentlyContinue
Write-Host "== done ==" -ForegroundColor Green
