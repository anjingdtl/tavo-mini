// Stream a base64-encoded SQLite database into the device's app-private
// databases/ directory via run-as.
//
// Why this approach:
//   - adb shell command lines are limited to ~8 KB on Windows.
//   - run-as cannot read /sdcard or /data/local/tmp under scoped storage.
//   - adb push cannot write into /data/data/<pkg>/ directly.
// So we pipe b64 into `run-as com.shinewriter sh` via stdin, where the shell
// decodes with `base64 -d` and writes via redirect. The redirect opens AFTER
// base64 has produced its first byte, so we never truncate to zero-length.
const fs = require('node:fs');
const { spawnSync, spawn } = require('node:child_process');

const adb = process.env.SHINE_ADB
  || `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const serial = process.env.SHINE_SERIAL || 'emulator-5554';
const pkg = process.env.SHINE_PACKAGE || 'com.shinewriter';

const [, , b64Path] = process.argv;
if (!b64Path) {
  console.error('Usage: node restore-db-stream.js <b64-file>');
  process.exit(2);
}

const b64 = fs.readFileSync(b64Path, 'utf8').trim();
console.log('b64 bytes:', b64.length);

// Make sure the app is dead so SQLite is not actively writing.
spawnSync(adb, ['-s', serial, 'shell', 'am', 'force-stop', pkg]);

// Stream stdin into run-as sh -c 'base64 -d > /data/user/0/<pkg>/databases/<name>'
const child = spawn(
  adb,
  [
    '-s', serial, 'shell',
    `run-as ${pkg} sh -c 'base64 -d > /data/user/0/${pkg}/databases/shine_writer.db'`,
  ],
  { stdio: ['pipe', 'inherit', 'inherit'] }
);

// base64 -d consumes and emits synchronously; backpressure is fine.
child.stdin.on('error', err => {
  console.error('stdin error', err.message);
});
child.stdin.write(b64);
child.stdin.end();
child.on('exit', code => {
  console.log('adb exit', code);
  const ls = spawnSync(adb, [
    '-s', serial, 'shell',
    `run-as ${pkg} sh -c 'ls -la /data/user/0/${pkg}/databases/'`,
  ]);
  console.log(String(ls.stdout || ls.stderr).trim());
});
