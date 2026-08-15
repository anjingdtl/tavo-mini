const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(
  'test-logs/final-release-evidence-20260812/H-cross-board-borrow/db-h-restored.sqlite',
);
console.log(db.prepare('PRAGMA integrity_check').get());
console.log('projects', db.prepare('SELECT COUNT(*) n FROM projects').get());
console.log('chapters', db.prepare('SELECT COUNT(*) n FROM chapters').get());
console.log(
  'llm',
  db.prepare('SELECT context_window,max_output_tokens FROM llm_config WHERE id=1').get(),
);
console.log(
  'char',
  db
    .prepare(
      "SELECT id,name,estimated_tokens,length(data_json) jlen FROM characters WHERE name='GateH-Borrow-Character'",
    )
    .get(),
);
console.log(
  'link',
  db.prepare('SELECT * FROM project_resources WHERE resource_id=4').all(),
);
