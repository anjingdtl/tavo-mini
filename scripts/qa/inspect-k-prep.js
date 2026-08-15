const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
const settings = db
  .prepare(
    "SELECT key, value FROM settings WHERE key IN ('pipeline_mode','pipeline_thinking_intensity')",
  )
  .all();
const tasks = db
  .prepare(
    `SELECT id, target_id, status, derived_kind, length(final_text) AS flen, updated_at
     FROM pipeline_tasks
     WHERE target_id IN (70, 72, 75)
     ORDER BY updated_at DESC
     LIMIT 20`,
  )
  .all();
console.log(
  JSON.stringify(
    {
      settings,
      tasks,
    },
    null,
    2,
  ),
);
db.close();
