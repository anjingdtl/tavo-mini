const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(
  'test-logs/final-release-evidence-20260812/release/db-preflight.sqlite',
);
console.log('== characters ==');
console.log(
  db
    .prepare(
      'SELECT id,project_id,name,length(data_json) jlen,estimated_tokens,max_tokens FROM characters',
    )
    .all(),
);
console.log('== worldbook ==');
console.log(
  db.prepare('PRAGMA table_info(worldbook_entries)').all().map(c => c.name).join(','),
);
console.log(db.prepare('SELECT id,name,length(content) clen FROM worldbook_entries').all());
console.log('== project_resources ==');
console.log(
  db.prepare('PRAGMA table_info(project_resources)').all().map(c => c.name).join(','),
);
console.log(
  db
    .prepare(
      'SELECT project_id,resource_type,count(*) n FROM project_resources GROUP BY 1,2',
    )
    .all(),
);
console.log('== attempts cols ==');
console.log(
  db.prepare('PRAGMA table_info(pipeline_stage_attempts)').all().map(c => c.name).join(','),
);
console.log('== outlines ==');
try {
  console.log(
    db
      .prepare(
        'SELECT id,project_id,title,enabled,length(content) clen FROM outlines',
      )
      .all(),
  );
} catch (e) {
  console.log(e.message);
}
console.log('== project 6/7 chapters ==');
console.log(
  db
    .prepare(
      'SELECT id,project_id,position,title,length(content) clen FROM chapters WHERE project_id IN (6,7) ORDER BY project_id,position',
    )
    .all(),
);
console.log('== recent batch hashes ==');
console.log(
  db
    .prepare(
      'SELECT id,project_id,status,chapter_count,completed_count,context_automation_policy_hash FROM multi_chapter_batches ORDER BY updated_at DESC LIMIT 6',
    )
    .all(),
);
