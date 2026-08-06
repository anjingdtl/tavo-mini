// Set pt_msg1it5t_2 unresolved and pt_msg1hcso_1 resolved for testing
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('test-logs/cur.db');
db.prepare(
  "UPDATE pipeline_tasks SET resolved_at = NULL, resolved_action = NULL WHERE id='pt_msg1it5t_2'",
).run();
db.prepare(
  "UPDATE pipeline_tasks SET resolved_at = 1, resolved_action='reject' WHERE id='pt_msg1hcso_1'",
).run();
console.log('set pt_msg1it5t_2 unresolved, pt_msg1hcso_1 resolved');
db.close();
