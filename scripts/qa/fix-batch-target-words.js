/**
 * Set pending batch item target_words to a legal value (>=500).
 * Does not change batch/item status or pipeline rows.
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
const words = Number(process.argv[2] || 800);
const workDir = 'test-logs/final-release-evidence-20260812/J-batch-policy-freeze';
const dbPath = path.join(workDir, 'db-j-fix-words.sqlite');
const b64Path = dbPath + '.b64';

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
  console.error('pull failed');
  process.exit(2);
}
fs.mkdirSync(workDir, { recursive: true });
fs.writeFileSync(dbPath, pulled.stdout);
const db = new DatabaseSync(dbPath);
const batch = db
  .prepare(
    `SELECT id, status, chapter_count, length(planner_request_json) planner_len
     FROM multi_chapter_batches
     WHERE status IN ('draft','ready','planning')
     ORDER BY updated_at DESC LIMIT 1`,
  )
  .get();
console.log('batch', batch);
if (!batch) {
  db.close();
  process.exit(2);
}
const before = db
  .prepare(
    'SELECT ordinal, status, target_words FROM multi_chapter_batch_items WHERE batch_id = ? ORDER BY ordinal',
  )
  .all(batch.id);
console.log('before', before);
db.prepare(
  'UPDATE multi_chapter_batch_items SET target_words = ? WHERE batch_id = ?',
).run(words, batch.id);
db.prepare(
  'UPDATE multi_chapter_batches SET target_words_per_chapter = ? WHERE id = ?',
).run(words, batch.id);
console.log(
  'after',
  db
    .prepare(
      'SELECT ordinal, status, target_words FROM multi_chapter_batch_items WHERE batch_id = ? ORDER BY ordinal',
    )
    .all(batch.id),
);
console.log(
  'counts',
  db.prepare('SELECT COUNT(*) n FROM projects').get(),
  db.prepare('SELECT COUNT(*) n FROM chapters').get(),
);
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
