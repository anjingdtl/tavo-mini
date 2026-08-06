// Dump key schema details
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('test-logs/cur.db');
console.log('pipeline_tasks cols:', db.prepare('PRAGMA table_info(pipeline_tasks)').all().map(c=>c.name).join(','));
console.log('pipeline_stage_checkpoints cols:', db.prepare('PRAGMA table_info(pipeline_stage_checkpoints)').all().map(c=>c.name).join(','));
console.log('pipeline_stage_attempts cols:', db.prepare('PRAGMA table_info(pipeline_stage_attempts)').all().map(c=>c.name).join(','));
console.log('multi_chapter_batches cols:', db.prepare('PRAGMA table_info(multi_chapter_batches)').all().map(c=>c.name).join(','));
console.log('multi_chapter_batch_items cols:', db.prepare('PRAGMA table_info(multi_chapter_batch_items)').all().map(c=>c.name).join(','));
console.log('outline cols:', db.prepare('PRAGMA table_info(outlines)').all().map(c=>c.name).join(','));
console.log('story_memory_snapshots cols:', db.prepare('PRAGMA table_info(story_memory_snapshots)').all().map(c=>c.name).join(','));
console.log('chapter_finalize cols:', db.prepare('SELECT * FROM chapters LIMIT 0').columns.map(c=>c.name).join(','));
db.close();
