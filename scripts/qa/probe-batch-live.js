const { DatabaseSync } = require('node:sqlite');
const { hashPolicy } = require('./policy-hash');

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('Usage: node probe-batch-live.js <db>');
  process.exit(2);
}
const db = new DatabaseSync(dbPath);

function extractHash(json) {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return (
      parsed.contextBudgetV3Summary?.contextAutomationPolicyHash ||
      parsed.contextAutomationPolicyHash ||
      parsed.execution?.contextAutomationPolicyHash ||
      parsed.policyHash ||
      null
    );
  } catch {
    return null;
  }
}

const liveRow = db
  .prepare("SELECT value FROM settings WHERE key='context_auto_policy_v3'")
  .get();
const live = liveRow?.value ? JSON.parse(liveRow.value) : null;
console.log('== live policy ==');
console.log({
  resourcesPriority: live?.boards?.resources?.priority,
  hash: live ? hashPolicy(live) : null,
});

console.log('== latest batches ==');
for (const r of db
  .prepare(
    `SELECT id, project_id, status, chapter_count, completed_count, current_ordinal,
            context_budget_version, outline_workflow_version, used_llm_calls,
            length(planner_request_json) planner_len
     FROM multi_chapter_batches
     ORDER BY updated_at DESC
     LIMIT 3`,
  )
  .all()) {
  console.log(r);
}

console.log('== latest items ==');
const latest = db
  .prepare(
    `SELECT id FROM multi_chapter_batches ORDER BY updated_at DESC LIMIT 1`,
  )
  .get();
if (latest) {
  for (const item of db
    .prepare(
      `SELECT ordinal, status, title, chapter_id, active_pipeline_task_id, error_code
       FROM multi_chapter_batch_items WHERE batch_id = ? ORDER BY ordinal`,
    )
    .all(latest.id)) {
    console.log(item);
  }
}

console.log('== child hashes / attempts ==');
const items = latest
  ? db
      .prepare(
        `SELECT ordinal, status, active_pipeline_task_id
         FROM multi_chapter_batch_items WHERE batch_id = ? ORDER BY ordinal`,
      )
      .all(latest.id)
  : [];
for (const item of items) {
  if (!item.active_pipeline_task_id) continue;
  const task = db
    .prepare(
      `SELECT id, status, length(pipeline_context_json) ctx_len, pipeline_context_json
       FROM pipeline_tasks WHERE id = ?`,
    )
    .get(item.active_pipeline_task_id);
  const cps = db
    .prepare(
      `SELECT stage, status, attempt_count FROM pipeline_stage_checkpoints WHERE task_id = ?`,
    )
    .all(item.active_pipeline_task_id);
  console.log({
    ordinal: item.ordinal,
    itemStatus: item.status,
    taskId: item.active_pipeline_task_id,
    taskStatus: task?.status,
    ctxHash: extractHash(task?.pipeline_context_json),
    checkpoints: cps,
  });
}

try {
  console.log('== attempt cols ==');
  console.log(
    db.prepare('PRAGMA table_info(pipeline_stage_attempts)').all().map(c => c.name),
  );
} catch (e) {
  console.log(e.message);
}

console.log(
  'counts',
  db.prepare('SELECT COUNT(*) n FROM projects').get(),
  db.prepare('SELECT COUNT(*) n FROM chapters').get(),
);
console.log('integrity', db.prepare('PRAGMA integrity_check').get());
db.close();
