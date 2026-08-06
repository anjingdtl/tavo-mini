// Pull ShineWriter SQLite database to disk via exec-out, which sends ONLY the
// file bytes back through stdout (no shell prompt echoed).
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const adb = process.env.SHINE_ADB
  || `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const serial = process.env.SHINE_SERIAL || 'emulator-5554';
const pkg = process.env.SHINE_PACKAGE || 'com.shinewriter';

const dst = process.argv[2] || 'test-logs/restored.db';

spawnSync(adb, ['-s', serial, 'shell', 'am', 'force-stop', pkg]);
const r = spawnSync(adb, [
  '-s', serial,
  'exec-out',
  `run-as ${pkg} cat databases/shine_writer.db`,
]);
const bytes = r.stdout;
fs.mkdirSync('test-logs', { recursive: true });
fs.writeFileSync(dst, bytes);
console.log('pulled', bytes.length, 'bytes ->', dst);
