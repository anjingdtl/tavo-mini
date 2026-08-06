// Diagnostic snapshot: pipeline state, batch state, story memory state.
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('test-logs/cur.db');

console.log('== llm_config ==');
for (const r of db
  .prepare('SELECT id, name, base_url, model_name, context_window, is_active FROM llm_config')
  .all()) {
  console.log(`  id=${r.id} active=${r.is_active} name=${r.name}`);
  console.log(`    base=${r.base_url} model=${r.model_name} ctx=${r.context_window}`);
}

console.log('\n== projects ==');
for (const r of db.prepare('SELECT * FROM projects LIMIT 0').all().concat(db.prepare('SELECT id, name FROM projects').all())) {
  console.log(`  id=${r.id} mode=${r.mode} current=${r.current} name=${r.name}`);
}

console.log('\n== pipeline_tasks ==');
for (const r of db.prepare(
  `SELECT id, target_type, target_id, status, error, length(stage_results) as sr_len,
          length(final_text) as ft_len, length(input_fingerprint) as fp_len,
          length(pipeline_context_json) as ctx_len, updated_at, resolved_at, resolved_action
   FROM pipeline_tasks ORDER BY id`
).all()) {
  console.log(`  id=${r.id} tgt=${r.target_type}:${r.target_id} status=${r.status} err=${r.error || '-'} ftlen=${r.ft_len}`);
}

console.log('\n== chapters ==');
for (const r of db.prepare(
  `SELECT id, project_id, title, status, finalize_status, length(content) as clen, position FROM chapters`
).all()) {
  console.log(`  id=${r.id} proj=${r.project_id} pos=${r.position} title='${r.title}' status=${r.status} finalize=${r.finalize_status || '-'} clen=${r.clen}`);
}

console.log('\n== multi_chapter_batches ==');
for (const r of db.prepare(`SELECT id, project_id, status, chapter_count, current_ordinal, completed_count, error_code, error_message FROM multi_chapter_batches`).all()) {
  console.log(`  ${JSON.stringify(r)}`);
}

console.log('\n== multi_chapter_batch_items ==');
for (const r of db.prepare(`SELECT batch_id, ordinal, status, title, chapter_id, active_pipeline_task_id, error_code, error_message FROM multi_chapter_batch_items ORDER BY ordinal`).all()) {
  console.log(`  ${JSON.stringify(r).slice(0,200)}`);
}

console.log('\n== pipeline_stage_checkpoints ==');
for (const r of db.prepare(`SELECT task_id, stage, status, attempt_count, error_code, length(output_text) as olen FROM pipeline_stage_checkpoints`).all()) {
  console.log(`  task=${r.task_id.slice(0,8)} stage=${r.stage} attempt=${r.attempt_count} status=${r.status} err=${r.error_code} olen=${r.olen}`);
}

console.log('\n== project_story_memory ==');
for (const r of db.prepare(`SELECT * FROM project_story_memory`).all()) {
  console.log(`  ${JSON.stringify(r).slice(0,200)}`);
}

console.log('\n== story_memory_snapshots ==');
for (const r of db.prepare(`SELECT id, project_id, through_chapter_id, length(memory_json) as mjlen, state_fingerprint FROM story_memory_snapshots`).all()) {
  console.log(`  id=${r.id} proj=${r.project_id} thru=${r.through_chapter_id} fp=${r.state_fingerprint || '-'} mjlen=${r.mjlen}`);
}

console.log('\n== chapter_memory_patches ==');
for (const r of db.prepare(`SELECT chapter_id, length(chapter_summary) as slen, length(memory_patch_json) as plen FROM chapter_memory_patches`).all()) {
  console.log(`  ${JSON.stringify(r)}`);
}

console.log('\n== story_memory_batches ==');
for (const r of db.prepare(`SELECT * FROM story_memory_batches`).all()) {
  console.log(`  ${JSON.stringify(r).slice(0,200)}`);
}

db.close();
