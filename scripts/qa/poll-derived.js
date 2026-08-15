const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
const parentId = process.argv[3] || 'pt_msqcxuep_145';
const derived = db
  .prepare(
    `SELECT id, status, derived_kind, parent_task_id, target_id,
            outline_workflow_version, context_budget_version,
            length(final_text) AS flen, substr(error,1,160) AS err,
            derived_instruction, updated_at
     FROM pipeline_tasks
     WHERE parent_task_id = ? OR derived_kind = 'final_rewrite'
     ORDER BY updated_at DESC
     LIMIT 5`,
  )
  .all(parentId);
const parent = db
  .prepare(
    `SELECT id, status, length(final_text) AS flen FROM pipeline_tasks WHERE id = ?`,
  )
  .get(parentId);
const latest = derived[0];
const cps = latest
  ? db
      .prepare(
        'SELECT stage, status, attempt_count FROM pipeline_stage_checkpoints WHERE task_id = ?',
      )
      .all(latest.id)
  : [];
console.log(JSON.stringify({ parent, derived, checkpoints: cps }, null, 2));
db.close();
