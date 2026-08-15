const { DatabaseSync } = require('node:sqlite');
const { hashPolicy } = require('./policy-hash');
const db = new DatabaseSync(process.argv[2]);
const liveRow = db
  .prepare("SELECT value FROM settings WHERE key='context_auto_policy_v3'")
  .get();
const live = liveRow?.value ? JSON.parse(liveRow.value) : null;
const batch = db
  .prepare(
    `SELECT id, status, completed_count, current_ordinal, used_llm_calls,
            planner_request_json
     FROM multi_chapter_batches
     ORDER BY updated_at DESC LIMIT 1`,
  )
  .get();
let frozenHash = null;
if (batch?.planner_request_json) {
  try {
    const parsed = JSON.parse(batch.planner_request_json);
    frozenHash =
      parsed.contextAutomationPolicyHash ||
      parsed.envelope?.contextAutomationPolicyHash ||
      parsed.policyHash ||
      null;
    if (!frozenHash && parsed.contextAutomationPolicySnapshot) {
      frozenHash = hashPolicy(parsed.contextAutomationPolicySnapshot);
    }
  } catch {
    frozenHash = null;
  }
}
const items = batch
  ? db
      .prepare(
        `SELECT ordinal, status, title, chapter_id, active_pipeline_task_id
         FROM multi_chapter_batch_items WHERE batch_id = ? ORDER BY ordinal`,
      )
      .all(batch.id)
  : [];
const cps = [];
for (const item of items) {
  if (!item.active_pipeline_task_id) continue;
  const rows = db
    .prepare(
      `SELECT stage, status, attempt_count FROM pipeline_stage_checkpoints WHERE task_id = ?`,
    )
    .all(item.active_pipeline_task_id);
  cps.push({ ordinal: item.ordinal, task: item.active_pipeline_task_id, rows });
}
console.log(
  JSON.stringify(
    {
      livePriority: live?.boards?.resources?.priority,
      liveHash: live ? hashPolicy(live) : null,
      batchId: batch?.id,
      batchStatus: batch?.status,
      completed: batch?.completed_count,
      current: batch?.current_ordinal,
      usedCalls: batch?.used_llm_calls,
      frozenHash,
      items,
      checkpoints: cps,
    },
    null,
    2,
  ),
);
db.close();
