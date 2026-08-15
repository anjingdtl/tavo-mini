const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
const targetId = Number(process.argv[3] || 70);
const task = db
  .prepare(
    `SELECT id, target_id, status, derived_kind, outline_workflow_version,
            context_budget_version, updated_at
     FROM pipeline_tasks
     WHERE target_id = ?
     ORDER BY updated_at DESC
     LIMIT 1`,
  )
  .get(targetId);
if (!task) {
  console.log(JSON.stringify({ targetId, task: null }, null, 2));
  db.close();
  process.exit(0);
}
const cps = db
  .prepare(
    'SELECT stage, status, attempt_count FROM pipeline_stage_checkpoints WHERE task_id = ?',
  )
  .all(task.id);
const attempts = db
  .prepare(
    `SELECT stage, attempt_no, status
     FROM pipeline_stage_attempts
     WHERE pipeline_task_id = ?
     ORDER BY stage, attempt_no`,
  )
  .all(task.id);
console.log(JSON.stringify({ task, checkpoints: cps, attempts }, null, 2));
db.close();
