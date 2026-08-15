/**
 * Write context_auto_policy_v3 via pull → edit → stdin restore.
 * Does not truncate the live DB.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { defaultPolicy, hashPolicy } = require('./policy-hash');

const adb =
  process.env.SHINE_ADB ||
  `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const serial = process.env.SHINE_SERIAL || 'emulator-5554';
const pkg = process.env.SHINE_PACKAGE || 'com.shinewriter';
const mode = process.argv[2] || 'A';
const workDir = 'test-logs/final-release-evidence-20260812/J-batch-policy-freeze';
const dbPath = path.join(workDir, `db-policy-${mode}.sqlite`);
const b64Path = dbPath + '.b64';

function sh(args) {
  return spawnSync(adb, ['-s', serial, ...args], {
    encoding: null,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

const policy = defaultPolicy();
if (mode === 'A') policy.boards.resources.priority = 11;
if (mode === 'B') policy.boards.resources.priority = 9;

sh(['shell', 'am', 'force-stop', pkg]);
const pulled = sh(['exec-out', 'run-as', pkg, 'cat', 'databases/shine_writer.db']);
if (!pulled.stdout || pulled.stdout.length < 1000) {
  console.error('pull failed');
  process.exit(2);
}
fs.mkdirSync(workDir, { recursive: true });
fs.writeFileSync(dbPath, pulled.stdout);
const db = new DatabaseSync(dbPath);
db.prepare(
  "INSERT OR REPLACE INTO settings (key, value) VALUES ('context_auto_mode', 'v3')",
).run();
db.prepare(
  "INSERT OR REPLACE INTO settings (key, value) VALUES ('context_auto_policy_v3', ?)",
).run(JSON.stringify(policy));
const stored = db
  .prepare("SELECT value FROM settings WHERE key='context_auto_policy_v3'")
  .get();
console.log({
  mode,
  resourcesPriority: policy.boards.resources.priority,
  hash: hashPolicy(JSON.parse(stored.value)),
  projects: db.prepare('SELECT COUNT(*) n FROM projects').get(),
  chapters: db.prepare('SELECT COUNT(*) n FROM chapters').get(),
});
db.close();

fs.writeFileSync(b64Path, fs.readFileSync(dbPath).toString('base64'));
const child = spawn(
  adb,
  [
    '-s',
    serial,
    'shell',
    `run-as ${pkg} sh -c 'base64 -d > /data/user/0/${pkg}/databases/shine_writer.db'`,
  ],
  { stdio: ['pipe', 'inherit', 'inherit'] },
);
child.stdin.write(fs.readFileSync(b64Path, 'utf8'));
child.stdin.end();
child.on('exit', code => {
  const ls = sh(['shell', `run-as ${pkg} ls -l databases/shine_writer.db`]);
  console.log(String(ls.stdout || ls.stderr), 'exit', code);
});
