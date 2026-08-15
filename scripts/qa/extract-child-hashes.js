const { DatabaseSync } = require('node:sqlite');
const { hashPolicy } = require('./policy-hash');
const db = new DatabaseSync(process.argv[2]);
const batchId = process.argv[3] || 'batch_msqbqwix_xksu40';
const liveRow = db
  .prepare("SELECT value FROM settings WHERE key='context_auto_policy_v3'")
  .get();
const live = liveRow?.value ? JSON.parse(liveRow.value) : null;
const batch = db
  .prepare('SELECT id, status, planner_request_json FROM multi_chapter_batches WHERE id = ?')
  .get(batchId);
let frozenHash = null;
if (batch?.planner_request_json) {
  const parsed = JSON.parse(batch.planner_request_json);
  frozenHash = parsed.contextAutomationPolicyHash || null;
}
const items = db
  .prepare(
    `SELECT ordinal, status, active_pipeline_task_id FROM multi_chapter_batch_items
     WHERE batch_id = ? ORDER BY ordinal`,
  )
  .all(batchId);
const children = [];
for (const item of items) {
  const task = item.active_pipeline_task_id
    ? db
        .prepare(
          `SELECT id, status, pipeline_context_json FROM pipeline_tasks WHERE id = ?`,
        )
        .get(item.active_pipeline_task_id)
    : null;
  let childHash = null;
  if (task?.pipeline_context_json) {
    try {
      const ctx = JSON.parse(task.pipeline_context_json);
      childHash =
        ctx.contextBudgetV3Summary?.contextAutomationPolicyHash ||
        ctx.contextAutomationPolicyHash ||
        ctx.execution?.contextAutomationPolicyHash ||
        null;
    } catch {
      childHash = 'parse_error';
    }
  }
  children.push({
    ordinal: item.ordinal,
    itemStatus: item.status,
    taskId: item.active_pipeline_task_id,
    taskStatus: task?.status,
    hash: childHash,
  });
}
console.log(
  JSON.stringify(
    {
      liveHash: live ? hashPolicy(live) : null,
      livePriority: live?.boards?.resources?.priority,
      frozenHash,
      batchStatus: batch?.status,
      children,
    },
    null,
    2,
  ),
);
db.close();
