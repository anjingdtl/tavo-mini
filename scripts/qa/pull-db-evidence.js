/**
 * Pull shine_writer.db [+ wal/shm] for evidence.
 * Default: force-stop first (clean snapshot).
 * --live: do not force-stop (best-effort mid-run snapshot).
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const adb =
  process.env.SHINE_ADB ||
  `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const serial = process.env.SHINE_SERIAL || 'emulator-5554';
const pkg = process.env.SHINE_PACKAGE || 'com.shinewriter';

const args = process.argv.slice(2);
const live = args.includes('--live');
const dest = args.find(a => !a.startsWith('--')) || 'test-logs/evidence.sqlite';

function run(cmd, cmdArgs) {
  return spawnSync(cmd, cmdArgs, {
    encoding: null,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

if (!live) {
  const stop = run(adb, ['-s', serial, 'shell', 'am', 'force-stop', pkg]);
  if (stop.status !== 0) {
    console.error('force-stop failed', stop.stderr?.toString());
  }
}

fs.mkdirSync(path.dirname(dest), { recursive: true });

function pullFile(remoteName, localPath) {
  const r = run(adb, [
    '-s',
    serial,
    'exec-out',
    'run-as',
    pkg,
    'cat',
    `databases/${remoteName}`,
  ]);
  if (r.status !== 0 || !r.stdout || r.stdout.length < 64) {
    return { ok: false, bytes: r.stdout?.length || 0, err: r.stderr?.toString() };
  }
  fs.writeFileSync(localPath, r.stdout);
  return { ok: true, bytes: r.stdout.length };
}

const main = pullFile('shine_writer.db', dest);
console.log(JSON.stringify({ dest, live, main }, null, 2));
if (!main.ok) process.exit(2);

const wal = pullFile('shine_writer.db-wal', `${dest}-wal`);
const shm = pullFile('shine_writer.db-shm', `${dest}-shm`);
console.log(JSON.stringify({ wal, shm }, null, 2));
