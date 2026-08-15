/**
 * Safely rewrite only llm_config context_window / max_output_tokens.
 * Restores via stdin base64 so the live DB is never truncated.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const adb =
  process.env.SHINE_ADB ||
  `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const serial = process.env.SHINE_SERIAL || 'emulator-5554';
const pkg = process.env.SHINE_PACKAGE || 'com.shinewriter';
const window = Number(process.argv[2] || 128000);
const maxOut = Number(process.argv[3] || 20000);
const workDir = 'test-logs/final-release-evidence-20260812/H-cross-board-borrow';
const dbPath = path.join(workDir, 'db-h-window.sqlite');
const b64Path = path.join(workDir, 'db-h-window.sqlite.b64');

function sh(args) {
  return spawnSync(adb, ['-s', serial, ...args], {
    encoding: null,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

sh(['shell', 'am', 'force-stop', pkg]);
const pulled = sh(['exec-out', 'run-as', pkg, 'cat', 'databases/shine_writer.db']);
if (!pulled.stdout || pulled.stdout.length < 1000) {
  console.error('pull failed', pulled.stderr?.toString());
  process.exit(2);
}
fs.mkdirSync(workDir, { recursive: true });
fs.writeFileSync(dbPath, pulled.stdout);
const db = new DatabaseSync(dbPath);
const before = db
  .prepare('SELECT id, context_window, max_output_tokens FROM llm_config WHERE id = 1')
  .get();
console.log('before', before);
db.prepare(
  'UPDATE llm_config SET context_window = ?, max_output_tokens = ? WHERE id = 1',
).run(window, maxOut);
console.log(
  'after',
  db.prepare('SELECT context_window, max_output_tokens FROM llm_config WHERE id = 1').get(),
);
console.log('projects', db.prepare('SELECT COUNT(*) n FROM projects').get());
console.log('chapters', db.prepare('SELECT COUNT(*) n FROM chapters').get());
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
  console.log(String(ls.stdout || ls.stderr));
  console.log('exit', code);
});
