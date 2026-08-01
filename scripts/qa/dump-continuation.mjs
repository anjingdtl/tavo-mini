#!/usr/bin/env node
// Dump continuation module state from a SQLite file for emulator QA.
import sqlite3 from 'better-sqlite3';

const db = process.argv[2];
if (!db) {
  console.error('usage: dump-continuation.mjs <db-file>');
  process.exit(2);
}

const conn = new sqlite3(db, { readonly: true });
const show = (label, sql) => {
  console.log(`\n=== ${label} ===`);
  try {
    const rows = conn.prepare(sql).all();
    if (!rows.length) {
      console.log('(empty)');
      return;
    }
    for (const r of rows) console.log(JSON.stringify(r));
  } catch (e) {
    console.log('ERR', e.message);
  }
};

show('projects', 'SELECT id, name, mode, current_work_project, created_at FROM projects ORDER BY id');
show(
  'continuation_sources',
  'SELECT id, project_id, status, original_filename, display_name, chapter_count, is_multi_file, file_count, activated_at FROM continuation_sources ORDER BY project_id, id',
);
show(
  'continuation_settings',
  'SELECT project_id, active_source_id, boundary_chapter_id, analysis_status, style_profile_status, pending_style_retry_count FROM continuation_settings',
);
show(
  'continuation_analysis_runs',
  'SELECT id, project_id, state, scope, style_analysis_state, created_at FROM continuation_analysis_runs ORDER BY id DESC LIMIT 10',
);
show(
  'style_profile_v2',
  'SELECT id, project_id, status, version, created_at FROM style_profile_v2 ORDER BY id DESC LIMIT 5',
);
show(
  'import_jobs_latest',
  'SELECT id, project_id, state, source_id, attempt, last_error, updated_at FROM continuation_import_jobs ORDER BY id DESC LIMIT 10',
);