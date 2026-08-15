/**
 * Fill empty synopsis/keyBeats on a draft batch so start validation can pass.
 * Does not change item/batch status.
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
const workDir = 'test-logs/final-release-evidence-20260812/J-batch-policy-freeze';
const dbPath = path.join(workDir, 'db-j-fill-plan.sqlite');
const b64Path = dbPath + '.b64';

const plans = [
  {
    title: '旧钟楼的第一把锁',
    synopsis: '齐衡与林澈带着北门铜钥匙进入旧钟楼，确认封锁来源并约定互守。',
    keyBeats: ['进入旧钟楼', '确认城门封锁来源', '盟友互守'],
  },
  {
    title: '铜铃被取下之前',
    synopsis: '两人在钟楼上层找到蓝色铜铃，追查其信号来历，但尚未取下。',
    keyBeats: ['发现蓝色铜铃', '追查信号来历', '暂不取铃'],
  },
  {
    title: '北门重新打开',
    synopsis: '齐衡打开北门解除封锁，铜铃用途被查明，当前目标转为调查来历。',
    keyBeats: ['打开北门', '查明铜铃用途', '目标转向调查来历'],
  },
];

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
    `SELECT id, status FROM multi_chapter_batches
     WHERE status IN ('draft','ready','planning')
     ORDER BY updated_at DESC LIMIT 1`,
  )
  .get();
console.log('batch', batch);
if (!batch) process.exit(2);
const upd = db.prepare(
  `UPDATE multi_chapter_batch_items
   SET title = ?, synopsis = ?, key_beats_json = ?, target_words = 800
   WHERE batch_id = ? AND ordinal = ?`,
);
for (let i = 0; i < plans.length; i += 1) {
  upd.run(
    plans[i].title,
    plans[i].synopsis,
    JSON.stringify(plans[i].keyBeats),
    batch.id,
    i + 1,
  );
}
console.log(
  db
    .prepare(
      `SELECT ordinal, title, length(synopsis) slen, key_beats_json, target_words, status
       FROM multi_chapter_batch_items WHERE batch_id = ? ORDER BY ordinal`,
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
