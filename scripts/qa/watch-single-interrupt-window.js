/**
 * Poll a live device DB until a single-chapter pipeline reaches the Gate K
 * interrupt window: draft/review/factCheck succeeded and proof (or brief)
 * is running. Does not force-stop.
 *
 * Usage: node scripts/qa/watch-single-interrupt-window.js <dest.sqlite> [chapterId]
 * Exit 0 = window reached; 2 = completed/past window; 3 = failed; 1 = still waiting
 */
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const dest = process.argv[2] || 'test-logs/final-release-evidence-20260812/K-single-resume/db-k-poll.sqlite';
const targetId = Number(process.argv[3] || 70);
const adb =
  process.env.SHINE_ADB ||
  `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const serial = process.env.SHINE_SERIAL || 'emulator-5554';
const pkg = process.env.SHINE_PACKAGE || 'com.shinewriter';

function pull(remoteName, localPath) {
  const r = spawnSync(
    adb,
    ['-s', serial, 'exec-out', 'run-as', pkg, 'cat', `databases/${remoteName}`],
    { encoding: null, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length < 64) {
    return { ok: false, bytes: r.stdout?.length || 0 };
  }
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, r.stdout);
  return { ok: true, bytes: r.stdout.length };
}

const main = pull('shine_writer.db', dest);
if (!main.ok) {
  console.log(JSON.stringify({ ok: false, reason: 'pull_failed', main }));
  process.exit(1);
}
pull('shine_writer.db-wal', `${dest}-wal`);
pull('shine_writer.db-shm', `${dest}-shm`);

let db;
try {
  db = new DatabaseSync(dest);
} catch (error) {
  console.log(JSON.stringify({ ok: false, reason: 'open_failed', error: String(error) }));
  process.exit(1);
}

const task = db
  .prepare(
    `SELECT id, target_id, status, derived_kind, outline_workflow_version,
            context_budget_version, updated_at
     FROM pipeline_tasks
     WHERE target_id = ? AND (derived_kind IS NULL OR derived_kind = '')
     ORDER BY updated_at DESC
     LIMIT 1`,
  )
  .get(targetId);

if (!task) {
  console.log(JSON.stringify({ ok: false, reason: 'no_task', targetId }));
  db.close();
  process.exit(1);
}

const cps = db
  .prepare(
    'SELECT stage, status, attempt_count FROM pipeline_stage_checkpoints WHERE task_id = ?',
  )
  .all(task.id);
const byStage = Object.fromEntries(cps.map(row => [row.stage, row]));
const succeeded = stage => byStage[stage]?.status === 'succeeded';
const running = stage =>
  byStage[stage]?.status === 'running' || byStage[stage]?.status === 'claimed';

const windowReady =
  succeeded('draft') &&
  succeeded('review') &&
  succeeded('factCheck') &&
  (running('proof') || running('brief') || (succeeded('brief') && running('proof')));

const pastWindow =
  task.status === 'completed' ||
  (succeeded('draft') &&
    succeeded('review') &&
    succeeded('factCheck') &&
    succeeded('proof'));

const failed = task.status === 'failed' || task.status === 'cancelled';

const out = {
  ok: true,
  task,
  checkpoints: cps,
  windowReady,
  pastWindow,
  failed,
};
console.log(JSON.stringify(out, null, 2));
db.close();

if (failed) process.exit(3);
if (windowReady) process.exit(0);
if (pastWindow) process.exit(2);
process.exit(1);
