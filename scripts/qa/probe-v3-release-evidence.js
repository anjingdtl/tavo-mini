/**
 * Read-only probe for Context Budget V3 release evidence.
 * Does not print API keys or full prompts.
 */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');

const dbPath = process.argv[2];
if (!dbPath || !fs.existsSync(dbPath)) {
  console.error('Usage: node scripts/qa/probe-v3-release-evidence.js <db>');
  process.exit(2);
}

const db = new DatabaseSync(dbPath);

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function safeAll(sql) {
  try {
    return db.prepare(sql).all();
  } catch (e) {
    console.log(`  [query failed] ${e.message}`);
    return [];
  }
}

function safeGet(sql, params = []) {
  try {
    return params.length
      ? db.prepare(sql).get(...params)
      : db.prepare(sql).get();
  } catch (e) {
    console.log(`  [query failed] ${e.message}`);
    return null;
  }
}

console.log('== integrity ==');
console.log(safeGet('PRAGMA integrity_check'));

console.log('\n== counts ==');
console.log({
  projects: safeGet('SELECT COUNT(*) AS n FROM projects')?.n,
  chapters: safeGet('SELECT COUNT(*) AS n FROM chapters')?.n,
  characters: safeGet('SELECT COUNT(*) AS n FROM characters')?.n,
  worldbook: safeGet('SELECT COUNT(*) AS n FROM worldbook_entries')?.n,
  notes: safeGet('SELECT COUNT(*) AS n FROM notes')?.n,
  batches: safeGet('SELECT COUNT(*) AS n FROM multi_chapter_batches')?.n,
  tasks: safeGet('SELECT COUNT(*) AS n FROM pipeline_tasks')?.n,
});

console.log('\n== llm_config (no secrets) ==');
for (const r of safeAll(
  `SELECT id, name, model_name, context_window, max_output_tokens, is_active,
          CASE WHEN api_key IS NULL OR api_key = '' THEN 0 ELSE 1 END AS has_legacy_key
   FROM llm_config`,
)) {
  console.log(r);
}

console.log('\n== settings keys of interest ==');
for (const r of safeAll(
  `SELECT key, length(value) AS value_len, substr(value, 1, 80) AS value_head
   FROM settings
   WHERE key IN (
     'context_auto_mode',
     'context_auto_input',
     'context_auto_policy_v3',
     'pipeline_mode',
     'context_budget_version'
   )
   ORDER BY key`,
)) {
  console.log(r);
}

const policyRow = safeGet(
  `SELECT value FROM settings WHERE key = 'context_auto_policy_v3'`,
);
if (policyRow?.value) {
  let parsed = null;
  try {
    parsed = JSON.parse(policyRow.value);
  } catch {
    parsed = null;
  }
  console.log('\n== live policy v3 ==');
  console.log({
    schemaVersion: parsed?.schemaVersion,
    allocatorVersion: parsed?.allocatorVersion,
    resourcesPriority: parsed?.boards?.resources?.priority,
    resourcesSoftRatio: parsed?.boards?.resources?.softRatio,
    resourcesElasticCeiling: parsed?.boards?.resources?.elasticCeilingRatio,
    hash: sha256(policyRow.value),
    jsonHashNote:
      'hash above is SHA-256 of persisted JSON string; app hash uses stableSerialize',
  });
}

console.log('\n== projects ==');
for (const r of safeAll(
  `SELECT id, name, mode, workspace_mode FROM projects ORDER BY id`,
)) {
  console.log(r);
}

console.log('\n== chapters (title/size only) ==');
for (const r of safeAll(
  `SELECT id, project_id, position, title, length(content) AS content_len,
          status FROM chapters ORDER BY project_id, position`,
)) {
  console.log(r);
}

console.log('\n== resource sizes by project ==');
for (const r of safeAll(
  `SELECT p.id AS project_id, p.name,
          (SELECT COALESCE(SUM(length(description) + length(personality) + length(scenario) + length(first_mes)), 0)
             FROM characters c WHERE c.project_id = p.id) AS char_chars,
          (SELECT COUNT(*) FROM characters c WHERE c.project_id = p.id) AS char_n,
          (SELECT COALESCE(SUM(length(content)), 0) FROM worldbook_entries w
             JOIN project_resources pr ON pr.resource_id = w.id AND pr.resource_type = 'worldbook'
            WHERE pr.project_id = p.id) AS wb_chars,
          (SELECT COALESCE(SUM(length(content)), 0) FROM notes n WHERE n.project_id = p.id) AS note_chars
   FROM projects p`,
)) {
  console.log(r);
}

console.log('\n== recent batches ==');
for (const r of safeAll(
  `SELECT id, project_id, status, chapter_count, completed_count, current_ordinal,
          context_budget_version, outline_workflow_version,
          context_automation_policy_hash, length(planner_output_json) AS planner_len,
          updated_at
   FROM multi_chapter_batches
   ORDER BY updated_at DESC
   LIMIT 8`,
)) {
  console.log(r);
}

console.log('\n== recent batch items ==');
for (const r of safeAll(
  `SELECT batch_id, ordinal, status, title, chapter_id, active_pipeline_task_id,
          error_code
   FROM multi_chapter_batch_items
   ORDER BY batch_id, ordinal`,
)) {
  console.log(r);
}

console.log('\n== recent pipeline tasks ==');
for (const r of safeAll(
  `SELECT id, target_type, target_id, status, length(final_text) AS final_len,
          length(pipeline_context_json) AS ctx_len, updated_at, resolved_action
   FROM pipeline_tasks
   ORDER BY updated_at DESC
   LIMIT 12`,
)) {
  console.log(r);
}

console.log('\n== recent checkpoints ==');
for (const r of safeAll(
  `SELECT task_id, stage, status, attempt_count, error_code,
          length(output_text) AS out_len
   FROM pipeline_stage_checkpoints
   ORDER BY updated_at DESC
   LIMIT 30`,
)) {
  console.log(r);
}

console.log('\n== recent attempts ==');
for (const r of safeAll(
  `SELECT task_id, stage, attempt_no, status, request_version
   FROM pipeline_stage_attempts
   ORDER BY id DESC
   LIMIT 30`,
)) {
  console.log(r);
}

db.close();
