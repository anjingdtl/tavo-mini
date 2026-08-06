// Restore shine_writer.db from b64 backup safely:
//   1. read b64 file
//   2. push bytes (full db) to /sdcard
//   3. run-as cat the decoded bytes into databases/shine_writer.db
// We never `>` overwrite an in-use db file with empty content; we always push
// the full content up first and only then run-as into place.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const adb = process.env.SHINE_ADB
  || `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const serial = process.env.SHINE_SERIAL || 'emulator-5554';
const pkg = process.env.SHINE_PACKAGE || 'com.shinewriter';

const [, , b64Path, dstName = 'shine_writer.db'] = process.argv;
if (!b64Path) {
  console.error('Usage: node restore-db.js <b64-file> [dst-name-in-databases]');
  process.exit(2);
}

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
function adbShell(args) {
  return sh(adb, ['-s', serial, ...args]);
}

// Stage on sdcard.
const sdDb = `/sdcard/shine-restored.db`;
const push = spawnSync(adb, ['-s', serial, 'push', b64Path, sdDb]);
if (push.status !== 0) {
  console.error('adb push failed', push.stderr?.toString());
  process.exit(2);
}
console.log('pushed bytes to', sdDb);

// Replace the live databases file via run-as.
// Use sh -c with both rm + cat, but echo progress so we can see partial state.
const replace = spawnSync(adb, [
  '-s', serial, 'shell',
  `run-as ${pkg} sh -c 'cat ${sdDb} > databases/${dstName} && rm -f ${sdDb}'`,
]);
if (replace.status !== 0) {
  console.error('replace failed', replace.stderr?.toString());
  process.exit(2);
}

// Confirm size.
const ls = spawnSync(adb, [
  '-s', serial, 'shell',
  `run-as ${pkg} sh -c 'ls -l databases/${dstName}'`,
]);
console.log(ls.stdout?.toString() || ls.stderr?.toString());
console.log('restored');
