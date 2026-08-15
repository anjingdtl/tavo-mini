/**
 * Construct Gate H materials: one large character on project 7 + 64K window.
 * Does not touch pipeline/batch rows or delete existing user data.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const adb =
  process.env.SHINE_ADB ||
  `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const serial = process.env.SHINE_SERIAL || 'emulator-5554';
const pkg = process.env.SHINE_PACKAGE || 'com.shinewriter';
const dbPath = 'test-logs/final-release-evidence-20260812/H-cross-board-borrow/db-h-seed.sqlite';
const b64Path = 'test-logs/final-release-evidence-20260812/H-cross-board-borrow/db-h-seed.sqlite.b64';

function sh(cmd, args) {
  return spawnSync(cmd, args, {
    encoding: null,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

console.log('force-stop');
sh(adb, ['-s', serial, 'shell', 'am', 'force-stop', pkg]);

console.log('pull db');
const pulled = sh(adb, [
  '-s',
  serial,
  'exec-out',
  'run-as',
  pkg,
  'cat',
  'databases/shine_writer.db',
]);
if (pulled.status !== 0 || !pulled.stdout || pulled.stdout.length < 1000) {
  console.error('pull failed', pulled.stderr?.toString());
  process.exit(2);
}
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.writeFileSync(dbPath, pulled.stdout);
console.log('pulled', pulled.stdout.length);

const db = new DatabaseSync(dbPath);
const before = db
  .prepare('SELECT id, context_window, max_output_tokens FROM llm_config WHERE is_active = 1')
  .get();
console.log('llm before', before);

const description = '设定'.repeat(6000);
const dataJson = JSON.stringify({
  data: {
    name: 'GateH-Borrow-Character',
    description,
    system_prompt: '',
    personality: '',
  },
});
const estimated = 12000;
const now = new Date().toISOString();

const existing = db
  .prepare("SELECT id FROM characters WHERE name = 'GateH-Borrow-Character'")
  .get();
let characterId;
if (existing?.id) {
  characterId = existing.id;
  db.prepare(
    'UPDATE characters SET data_json = ?, estimated_tokens = ?, max_tokens = 50000 WHERE id = ?',
  ).run(dataJson, estimated, characterId);
  console.log('updated existing character', characterId);
} else {
  const result = db
    .prepare(
      'INSERT INTO characters (project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at) VALUES (0, 0, ?, ?, ?, 50000, ?, ?)',
    )
    .run('GateH-Borrow-Character', 'json', dataJson, estimated, now);
  characterId = Number(result.lastInsertRowid);
  console.log('inserted character', characterId);
}

db.prepare(
  'INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (7, ?, ?, 1)',
).run('character', characterId);

db.prepare(
  'UPDATE llm_config SET context_window = 64000, max_output_tokens = 12800 WHERE id = 1',
).run();
const after = db
  .prepare('SELECT id, context_window, max_output_tokens FROM llm_config WHERE id = 1')
  .get();
console.log('llm after', after);
console.log(
  'linked',
  db
    .prepare(
      "SELECT * FROM project_resources WHERE project_id = 7 AND resource_type = 'character'",
    )
    .all(),
);
db.close();

fs.writeFileSync(b64Path, fs.readFileSync(dbPath).toString('base64'));
const sdB64 = '/sdcard/shine-db-gateh.b64';
const appDb = `/data/data/${pkg}/databases/shine_writer_gateh.db`;
const push = sh(adb, ['-s', serial, 'push', b64Path, sdB64]);
if (push.status !== 0) {
  console.error('push b64 failed', push.stderr?.toString());
  process.exit(2);
}

let decoded = false;
for (const decode of ['base64 -d', 'base64 --decode']) {
  const out = sh(adb, [
    '-s',
    serial,
    'shell',
    `run-as ${pkg} sh -c 'cat ${sdB64} | ${decode} > ${appDb}'`,
  ]);
  if (out.status === 0) {
    decoded = true;
    break;
  }
  console.error('decode failed', decode, out.stderr?.toString());
}
if (!decoded) process.exit(2);

const replace = sh(adb, [
  '-s',
  serial,
  'shell',
  `run-as ${pkg} sh -c 'cat ${appDb} > databases/shine_writer.db && rm -f databases/shine_writer.db-wal databases/shine_writer.db-shm ${appDb}'`,
]);
if (replace.status !== 0) {
  console.error('replace failed', replace.stderr?.toString());
  process.exit(2);
}

const verify = sh(adb, [
  '-s',
  serial,
  'exec-out',
  'run-as',
  pkg,
  'cat',
  'databases/shine_writer.db',
]);
const verifyPath =
  'test-logs/final-release-evidence-20260812/H-cross-board-borrow/db-h-seed-verify.sqlite';
fs.writeFileSync(verifyPath, verify.stdout);
const vdb = new DatabaseSync(verifyPath);
console.log(
  'verify llm',
  vdb.prepare('SELECT context_window, max_output_tokens FROM llm_config WHERE id = 1').get(),
);
console.log(
  'verify char',
  vdb
    .prepare(
      "SELECT id, name, estimated_tokens, length(data_json) jlen FROM characters WHERE name = 'GateH-Borrow-Character'",
    )
    .get(),
);
console.log(
  'verify counts',
  vdb.prepare('SELECT COUNT(*) n FROM projects').get(),
  vdb.prepare('SELECT COUNT(*) n FROM chapters').get(),
);
vdb.close();
fs.unlinkSync(b64Path);
console.log('seed done');
