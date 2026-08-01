#!/usr/bin/env python3
"""Dump continuation module state for emulator QA.

Usage: python scripts/qa/dump_continuation.py <db-file>
"""
import sqlite3
import sys

def show(cur, label, sql):
    print(f"\n=== {label} ===")
    try:
        rows = cur.execute(sql).fetchall()
        if not rows:
            print("(empty)")
            return
        for r in rows:
            print(r)
    except Exception as e:
        print(f"ERR: {e}")

def main():
    if len(sys.argv) < 2:
        print("usage: dump_continuation.py <db-file>")
        sys.exit(2)
    db = sys.argv[1]
    conn = sqlite3.connect(db)
    cur = conn.cursor()
    show(cur, "projects",
         "SELECT id, name, mode, current_work_project, created_at FROM projects ORDER BY id")
    show(cur, "continuation_sources",
         "SELECT id, project_id, status, original_filename, display_name, "
         "chapter_count, is_multi_file, file_count, activated_at "
         "FROM continuation_sources ORDER BY project_id, id")
    show(cur, "continuation_settings",
         "SELECT project_id, active_source_id, boundary_chapter_id, analysis_status, "
         "style_profile_status, pending_style_retry_count FROM continuation_settings")
    show(cur, "continuation_analysis_runs",
         "SELECT id, project_id, state, scope, style_analysis_state, created_at "
         "FROM continuation_analysis_runs ORDER BY id DESC LIMIT 10")
    show(cur, "style_profile_v2",
         "SELECT id, project_id, status, version, created_at "
         "FROM style_profile_v2 ORDER BY id DESC LIMIT 5")
    show(cur, "import_jobs_latest",
         "SELECT id, project_id, state, source_id, attempt, last_error, updated_at "
         "FROM continuation_import_jobs ORDER BY id DESC LIMIT 10")
    show(cur, "canon_snapshots_latest",
         "SELECT id, project_id, status, run_id, source_id, version, created_at "
         "FROM canon_snapshots ORDER BY id DESC LIMIT 5")
    show(cur, "import_job_states_by_project",
         "SELECT project_id, state, COUNT(*) AS c "
         "FROM continuation_import_jobs WHERE state IN ('queued','running','paused','awaiting_review','interrupted') "
         "GROUP BY project_id, state ORDER BY project_id")

if __name__ == "__main__":
    main()