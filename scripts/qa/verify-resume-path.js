// Verify that the resume path works: find failed/interrupted tasks and their
// checkpoints, and print which stage would be retried.
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('test-logs/cur.db');

const rows = db
  .prepare(
    "SELECT id, status, updated_at FROM pipeline_tasks WHERE target_type='chapter' AND target_id=1 AND resolved_at IS NULL AND status IN ('failed','interrupted') ORDER BY updated_at DESC",
  )
  .all();

console.log('== resumable candidates ==');
for (const r of rows) console.log(' ', r);

if (rows.length === 0) {
  console.log('none');
  process.exit(0);
}
const latest = rows[0];
console.log('\n== latest:', latest.id, 'status:', latest.status);

const cps = db
  .prepare(
    'SELECT stage, status, attempt_count, error_code, length(output_text) as olen FROM pipeline_stage_checkpoints WHERE task_id=?',
  )
  .all(latest.id);

console.log('== stage checkpoints ==');
for (const cp of cps) console.log(' ', cp);

const failedStages = cps.filter(c => c.status === 'failed');
const succeededStages = cps.filter(c => c.status === 'succeeded');
console.log(
  '\nsucceeded stages:',
  succeededStages.map(c => c.stage).join(', ') || '(none)',
);
console.log(
  'failed stages (would be retried):',
  failedStages.map(c => c.stage).join(', ') || '(none)',
);
db.close();
