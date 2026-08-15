const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
const taskId = process.argv[3] || 'pt_msqcxuep_145';
const task = db
  .prepare(
    `SELECT id, status, error, length(pipeline_context_json) AS ctx_len,
            length(pipeline_context_hash) AS hash_len,
            pipeline_context_version, outline_workflow_version,
            context_budget_version, derived_kind, updated_at
     FROM pipeline_tasks WHERE id = ?`,
  )
  .get(taskId);
let hash = null;
let keys = null;
if (task) {
  const row = db
    .prepare('SELECT pipeline_context_json FROM pipeline_tasks WHERE id = ?')
    .get(taskId);
  if (row?.pipeline_context_json) {
    try {
      const ctx = JSON.parse(row.pipeline_context_json);
      keys = Object.keys(ctx);
      hash =
        ctx.contextBudgetV3Summary?.contextAutomationPolicyHash ||
        ctx.contextAutomationPolicyHash ||
        ctx.execution?.contextAutomationPolicyHash ||
        null;
    } catch (error) {
      keys = ['parse_error', String(error)];
    }
  }
}
const recent = db
  .prepare(
    `SELECT id, target_id, status, substr(error,1,120) AS err,
            length(pipeline_context_json) AS ctx_len, updated_at
     FROM pipeline_tasks
     ORDER BY updated_at DESC
     LIMIT 8`,
  )
  .all();
console.log(JSON.stringify({ task, hash, keys, recent }, null, 2));
db.close();
