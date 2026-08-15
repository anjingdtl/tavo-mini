const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
const integrity = db.prepare('PRAGMA integrity_check').get();
const projects = db.prepare('SELECT count(*) AS n FROM projects').get();
const chapters = db.prepare('SELECT count(*) AS n FROM chapters').get();
let keys = { n: 'no_api_key_column' };
try {
  keys = db
    .prepare(
      "SELECT count(*) AS n FROM llm_config WHERE api_key IS NOT NULL AND trim(api_key) != ''",
    )
    .get();
} catch {
  const cols = db.prepare('PRAGMA table_info(llm_config)').all().map(c => c.name);
  keys = { n: 0, cols };
}
console.log(JSON.stringify({ integrity, projects, chapters, keys }, null, 2));
db.close();
