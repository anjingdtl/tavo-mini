// Verify a ShineWriter SQLite database by listing schema and key rows.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = process.argv[2] || 'test-logs/restored-db-pulled.db';
const db = new DatabaseSync(path);

console.log('== tables ==');
console.log(
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name)
    .join(', '),
);

console.log('\n== settings (feature flags) ==');
for (const row of db
  .prepare(
    "SELECT key, value FROM settings WHERE key IN ('multi_chapter_batch_enabled','elastic_budget_v2_enabled','theme_mode','background_pipeline_enabled','allow_insecure_lan_http','structured_story_memory_enabled','story_memory_checkpoint_scheduler_enabled')",
  )
  .all()) {
  console.log(`  ${row.key} = ${row.value}`);
}

console.log('\n== row counts ==');
const counts = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  )
  .all()
  .map((r) => r.name);
for (const t of counts) {
  try {
    const c = db.prepare(`SELECT COUNT(*) AS n FROM \`${t}\``).get().n;
    console.log(`  ${t}: ${c}`);
  } catch (e) {
    console.log(`  ${t}: ERROR ${e.message}`);
  }
}

db.close();
