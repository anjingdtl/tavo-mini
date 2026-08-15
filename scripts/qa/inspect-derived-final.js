const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
const derivedId = process.argv[3] || 'pt_rewrite_msqdl5wx_ub6kelu';
const parentId = 'pt_msqcxuep_145';
const derived = db
  .prepare(
    `SELECT id, status, derived_kind, parent_task_id, target_id,
            outline_workflow_version, context_budget_version,
            length(final_text) AS flen, resolved_at, resolved_action,
            derived_instruction
     FROM pipeline_tasks WHERE id = ?`,
  )
  .get(derivedId);
const parent = db
  .prepare(
    `SELECT id, status, length(final_text) AS flen, resolved_at, resolved_action
     FROM pipeline_tasks WHERE id = ?`,
  )
  .get(parentId);
const chapter = db
  .prepare(
    'SELECT id, title, length(content) AS clen, substr(content,1,80) AS head FROM chapters WHERE id = 70',
  )
  .get();
const revisions = db
  .prepare(
    `SELECT id, target_type, target_id, length(content) AS clen, created_at
     FROM content_revisions
     WHERE target_type = 'chapter' AND target_id = 70
     ORDER BY created_at DESC LIMIT 5`,
  )
  .all();
let drafts = [];
try {
  drafts = db
    .prepare(
      `SELECT id, task_id, length(content) AS clen, created_at
       FROM generation_drafts
       WHERE task_id IN (?, ?)
       ORDER BY created_at DESC LIMIT 5`,
    )
    .all(derivedId, parentId);
} catch {
  drafts = [];
}
console.log(
  JSON.stringify({ derived, parent, chapter, revisions, drafts }, null, 2),
);
db.close();
