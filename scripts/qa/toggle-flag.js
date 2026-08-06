// Toggle a settings row on the ShineWriter device database via the pull/modify/push
// pattern. Settings rows are app-controlled single key/value pairs, so this is the
// same as API-setSetting('foo', 'bar').
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const adb = process.env.SHINE_ADB
  || `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const serial = process.env.SHINE_SERIAL || 'emulator-5554';
const pkg = process.env.SHINE_PACKAGE || 'com.shinewriter';
const [, , key, value] = process.argv;

if (!key || value == null) {
  console.error('Usage: node toggle-flag.js <key> <value>');
  process.exit(2);
}

const dbPath = 'test-logs/qa-toggle.db';
const b64Path = 'test-logs/qa-toggle.db.b64';

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function adbShell(args) {
  return sh(adb, ['-s', serial, ...args]);
}

// 1. Force-stop so WAL is flushed.
console.log('force-stop app');
adbShell(['shell', 'am', 'force-stop', pkg]);

// 2. Pull DB.
console.log('pull db');
const r = spawnSync(adb, ['-s', serial, 'exec-out', 'run-as', pkg, 'cat', 'databases/shine_writer.db']);
if (r.status !== 0) {
  console.error('adb pull failed', r.stderr?.toString());
  process.exit(2);
}
fs.mkdirSync('test-logs', { recursive: true });
fs.writeFileSync(dbPath, r.stdout);
console.log('size=', fs.statSync(dbPath).size, 'bytes');

// 3. Edit using Node's experimental sqlite (Node 22+).
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('node:sqlite unavailable, falling back to better-sqlite3');
  ({ DatabaseSync } = require('better-sqlite3'));
}
const db = new DatabaseSync(dbPath);
const before = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
console.log('before:', before ? before.value : '(missing)');
db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
const after = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
console.log('after:', after.value);
db.close();

// 4. Push to /sdcard (public), then run-as cat into app private files/.
// adb push cannot write into /data/data directly without root, but can write to
// /sdcard. run-as can then move it across the storage boundary.
console.log('push db');
const buf = fs.readFileSync(dbPath);
fs.writeFileSync(b64Path, buf.toString('base64'));
const sdB64 = '/sdcard/shine-db-toggle.b64';
const appDb = `/data/data/${pkg}/databases/shine_writer_toggle.db`;
const push = spawnSync(adb, ['-s', serial, 'push', b64Path, sdB64]);
if (push.status !== 0) {
  console.error('adb push b64 failed', push.stderr?.toString());
  process.exit(2);
}

const scripts = [
  // base64 variants; toybox/busybox differ.
  `run-as ${pkg} sh -c 'cat ${sdB64} | base64 -d > ${appDb}'`,
  `run-as ${pkg} sh -c 'cat ${sdB64} | base64 --decode > ${appDb}'`,
];
let pushed = false;
for (const cmd of scripts) {
  const out = spawnSync(adb, ['-s', serial, 'shell', cmd]);
  if (out.status === 0) { pushed = true; break; }
  console.error('cmd failed', cmd, out.stderr?.toString());
}
if (!pushed) process.exit(2);

// Sanity: database replace must keep file size coherent.  We use cat
// rather than cp so a missing tool surfaces as an error.
// cat the decoded db into the live database file. The /sdcard staging is fine
// to leave behind (it's the user's own storage) and rm may be blocked because
// run-as is app-uid, not shell.
const replace = spawnSync(adb, [
  '-s', serial, 'shell',
  `run-as ${pkg} sh -c 'cat ${appDb} > databases/shine_writer.db && rm -f ${appDb}'`,
]);
if (replace.status !== 0) {
  console.error('replace failed', replace.stderr?.toString());
  process.exit(2);
}

// 5. Verify via pull.
const verify = spawnSync(adb, [
  '-s', serial, 'exec-out', 'run-as', pkg, 'cat', 'databases/shine_writer.db',
]);
const verifyPath = 'test-logs/qa-toggle-verify.db';
fs.writeFileSync(verifyPath, verify.stdout);
const vdb = new DatabaseSync(verifyPath);
const row = vdb.prepare('SELECT value FROM settings WHERE key=?').get(key);
console.log('verify:', row.value);
vdb.close();

fs.unlinkSync(b64Path);
console.log('done');
