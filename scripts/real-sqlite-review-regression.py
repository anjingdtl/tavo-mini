"""Real SQLite regressions for the Schema 26 review remediation.

This intentionally uses Python's sqlite3 engine, not a JS executeSql mock. It
exercises the same v25->v26 DDL shape, immediate foreign keys, restore pointer
ordering, rollback, and source/style lifecycle rules.
"""

from __future__ import annotations

import sqlite3


def rows(conn: sqlite3.Connection, sql: str, args=()):
    return conn.execute(sql, args).fetchall()


def create_v25(conn: sqlite3.Connection):
    conn.executescript(
        """
        PRAGMA foreign_keys = ON;
        CREATE TABLE projects(id INTEGER PRIMARY KEY);
        CREATE TABLE continuation_sources(
          id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, version INTEGER NOT NULL,
          normalized_sha256 TEXT NOT NULL, parser_version TEXT NOT NULL,
          normalization_version TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE TABLE continuation_source_chapters(
          id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, position INTEGER NOT NULL,
          FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE
        );
        CREATE TABLE continuation_canon_snapshots(
          id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, source_id INTEGER NOT NULL,
          boundary_chapter_id INTEGER NOT NULL, boundary_position INTEGER NOT NULL,
          boundary_char_offset_exclusive INTEGER NOT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE
        );
        CREATE TABLE llm_config(id INTEGER PRIMARY KEY);
        CREATE TABLE continuation_analysis_runs(
          id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, source_id INTEGER NOT NULL,
          canon_snapshot_id TEXT NOT NULL, stage TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
          FOREIGN KEY(canon_snapshot_id) REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_analysis_runs_project_state
          ON continuation_analysis_runs(project_id, stage);
        CREATE TABLE continuation_analysis_batches(
          run_id TEXT NOT NULL, batch_index INTEGER NOT NULL,
          PRIMARY KEY(run_id, batch_index),
          FOREIGN KEY(run_id) REFERENCES continuation_analysis_runs(id) ON DELETE CASCADE
        );
        CREATE TABLE continuation_analysis_work_items(
          run_id TEXT NOT NULL, batch_index INTEGER NOT NULL, material_type TEXT NOT NULL,
          FOREIGN KEY(run_id, batch_index)
            REFERENCES continuation_analysis_batches(run_id, batch_index) ON DELETE CASCADE
        );
        CREATE TABLE canon_evidence(
          id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, source_id INTEGER NOT NULL,
          snapshot_id TEXT NOT NULL, chapter_id INTEGER NOT NULL, analysis_run_id TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
          FOREIGN KEY(snapshot_id) REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE,
          FOREIGN KEY(chapter_id) REFERENCES continuation_source_chapters(id) ON DELETE CASCADE,
          FOREIGN KEY(analysis_run_id) REFERENCES continuation_analysis_runs(id) ON DELETE CASCADE
        );
        CREATE TABLE canon_evidence_links(
          evidence_id INTEGER NOT NULL, snapshot_id TEXT NOT NULL,
          FOREIGN KEY(evidence_id) REFERENCES canon_evidence(id) ON DELETE CASCADE,
          FOREIGN KEY(snapshot_id) REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE
        );
        CREATE TABLE canon_characters(
          id INTEGER PRIMARY KEY, snapshot_id TEXT NOT NULL, analysis_run_id TEXT NOT NULL,
          FOREIGN KEY(snapshot_id) REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE,
          FOREIGN KEY(analysis_run_id) REFERENCES continuation_analysis_runs(id) ON DELETE CASCADE
        );
        CREATE TABLE canon_world_rules(
          id INTEGER PRIMARY KEY, snapshot_id TEXT NOT NULL, analysis_run_id TEXT NOT NULL,
          FOREIGN KEY(snapshot_id) REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE,
          FOREIGN KEY(analysis_run_id) REFERENCES continuation_analysis_runs(id) ON DELETE CASCADE
        );
        CREATE TABLE canon_relationships(
          id INTEGER PRIMARY KEY, snapshot_id TEXT NOT NULL, analysis_run_id TEXT NOT NULL,
          FOREIGN KEY(snapshot_id) REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE,
          FOREIGN KEY(analysis_run_id) REFERENCES continuation_analysis_runs(id) ON DELETE CASCADE
        );
        CREATE TABLE canon_plot_threads(
          id INTEGER PRIMARY KEY, snapshot_id TEXT NOT NULL, analysis_run_id TEXT NOT NULL,
          FOREIGN KEY(snapshot_id) REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE,
          FOREIGN KEY(analysis_run_id) REFERENCES continuation_analysis_runs(id) ON DELETE CASCADE
        );
        CREATE TABLE canon_character_experiences(
          id INTEGER PRIMARY KEY, snapshot_id TEXT NOT NULL, analysis_run_id TEXT NOT NULL,
          FOREIGN KEY(snapshot_id) REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE,
          FOREIGN KEY(analysis_run_id) REFERENCES continuation_analysis_runs(id) ON DELETE CASCADE
        );
        CREATE TABLE canon_timeline_events(
          id INTEGER PRIMARY KEY, snapshot_id TEXT NOT NULL, analysis_run_id TEXT NOT NULL,
          FOREIGN KEY(snapshot_id) REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE,
          FOREIGN KEY(analysis_run_id) REFERENCES continuation_analysis_runs(id) ON DELETE CASCADE
        );
        CREATE TABLE continuation_settings(
          project_id INTEGER PRIMARY KEY, active_source_id INTEGER,
          boundary_chapter_id INTEGER, boundary_char_offset_global INTEGER,
          active_canon_snapshot_id TEXT,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY(active_source_id) REFERENCES continuation_sources(id),
          FOREIGN KEY(active_canon_snapshot_id) REFERENCES continuation_canon_snapshots(id)
        );
        CREATE TABLE continuation_style_profiles(
          project_id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL,
          canon_snapshot_id TEXT NOT NULL, created_at TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
          FOREIGN KEY(canon_snapshot_id) REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE
        );
        """
    )


def seed_canon(conn: sqlite3.Connection):
    conn.execute("INSERT INTO projects VALUES (1)")
    conn.execute(
        "INSERT INTO continuation_sources VALUES (10,1,1,'source-hash','parser-1','normalizer-1')"
    )
    conn.execute("INSERT INTO continuation_source_chapters VALUES (100,10,19)")
    conn.execute("INSERT INTO continuation_canon_snapshots VALUES ('snap-1',1,10,100,19,2000)")
    conn.execute("INSERT INTO continuation_settings VALUES (1,10,100,2000,'snap-1')")
    conn.execute("INSERT INTO continuation_analysis_runs VALUES ('run-1',1,10,'snap-1','style_analysis')")
    conn.execute("INSERT INTO continuation_analysis_batches VALUES ('run-1',0)")
    conn.execute("INSERT INTO continuation_analysis_work_items VALUES ('run-1',0,'characters')")
    conn.execute("INSERT INTO canon_evidence VALUES (1,1,10,'snap-1',100,'run-1')")
    conn.execute("INSERT INTO canon_evidence_links VALUES (1,'snap-1')")
    for table in (
        'canon_characters', 'canon_world_rules', 'canon_relationships',
        'canon_plot_threads', 'canon_character_experiences', 'canon_timeline_events',
    ):
        conn.execute(f"INSERT INTO {table} VALUES (1,'snap-1','run-1')")
    conn.execute("INSERT INTO continuation_style_profiles VALUES (1,10,'snap-1','now')")
    conn.commit()


def migrate_v25_to_v26(conn: sqlite3.Connection, fail_at: int | None = None):
    statements = [
        "ALTER TABLE continuation_style_profiles RENAME TO continuation_style_profiles_v25",
        """CREATE TABLE continuation_style_profiles(
          id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, source_id INTEGER NOT NULL,
          source_version INTEGER NOT NULL, source_sha256 TEXT NOT NULL,
          parser_version TEXT NOT NULL, normalization_version TEXT NOT NULL,
          boundary_chapter_id INTEGER NOT NULL, boundary_position INTEGER NOT NULL,
          boundary_char_offset_exclusive INTEGER NOT NULL, analysis_run_id TEXT NOT NULL,
          canon_snapshot_id TEXT NOT NULL, profile_schema_version INTEGER NOT NULL,
          analyzer_version TEXT NOT NULL, profile_json TEXT NOT NULL DEFAULT '{}',
          metrics_json TEXT NOT NULL DEFAULT '{}', sample_refs_json TEXT NOT NULL DEFAULT '[]',
          user_overrides_json TEXT NOT NULL DEFAULT '{}', profile_hash TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'queued',
          review_status TEXT NOT NULL DEFAULT 'pending', error_code TEXT, error_message TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
          FOREIGN KEY(canon_snapshot_id) REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE
        )""",
        """INSERT INTO continuation_style_profiles(
          id,project_id,source_id,source_version,source_sha256,parser_version,
          normalization_version,boundary_chapter_id,boundary_position,
          boundary_char_offset_exclusive,analysis_run_id,canon_snapshot_id,
          profile_schema_version,analyzer_version,profile_json,metrics_json,
          sample_refs_json,user_overrides_json,profile_hash,confidence,state,
          review_status,error_code,error_message,created_at,updated_at,completed_at
        ) SELECT 'legacy_'||project_id,project_id,source_id,1,'','','',0,0,0,'',
          canon_snapshot_id,1,'legacy-v25','{}','{}','[]','{}','',0,'outdated',
          'pending','legacy_pre_v26','legacy','created_at','created_at','created_at'
          FROM continuation_style_profiles_v25""",
        "DROP TABLE continuation_style_profiles_v25",
        "ALTER TABLE continuation_settings ADD COLUMN active_style_profile_id TEXT REFERENCES continuation_style_profiles(id)",
    ]
    try:
        conn.execute("BEGIN")
        for index, statement in enumerate(statements, 1):
            if fail_at == index:
                raise RuntimeError(f"fault at migration statement {index}")
            conn.execute(statement)
        assert not rows(conn, "PRAGMA foreign_key_check")
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def test_migration_preserves_canon_and_rolls_back():
    with sqlite3.connect(":memory:") as conn:
        create_v25(conn)
        seed_canon(conn)
        expected = {
            table: rows(conn, f"SELECT * FROM {table}")
            for table in (
                'continuation_analysis_runs', 'continuation_analysis_batches',
                'continuation_analysis_work_items', 'canon_evidence',
                'canon_evidence_links', 'canon_characters', 'canon_world_rules',
                'canon_relationships', 'canon_plot_threads',
                'canon_character_experiences', 'canon_timeline_events',
            )
        }
        migrate_v25_to_v26(conn)
        for table, values in expected.items():
            assert rows(conn, f"SELECT * FROM {table}") == values, table
        assert rows(conn, "PRAGMA foreign_key_check") == []
        assert all(
            row[2] == 'continuation_analysis_runs'
            for table in ('continuation_analysis_batches', 'canon_evidence')
            for row in rows(conn, f"PRAGMA foreign_key_list({table})")
            if row[3] in ('run_id', 'analysis_run_id')
        )
        assert all(
            row[2] == 'continuation_analysis_batches'
            for row in rows(conn, "PRAGMA foreign_key_list(continuation_analysis_work_items)")
        )
        conn.execute("INSERT INTO continuation_analysis_batches VALUES ('run-1',1)")
        conn.execute("INSERT INTO continuation_analysis_work_items VALUES ('run-1',1,'timeline')")
        conn.commit()

    with sqlite3.connect(":memory:") as conn:
        create_v25(conn)
        seed_canon(conn)
        try:
            migrate_v25_to_v26(conn, fail_at=3)
        except RuntimeError:
            pass
        assert rows(conn, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%v25'") == []
        assert rows(conn, "PRAGMA table_info(continuation_settings)")[-1][1] != 'active_style_profile_id'
        assert rows(conn, "SELECT id FROM continuation_analysis_runs") == [('run-1',)]


def test_two_phase_restore_lifecycle_and_atomic_activation():
    with sqlite3.connect(":memory:") as conn:
        create_v25(conn)
        seed_canon(conn)
        migrate_v25_to_v26(conn)
        conn.execute("UPDATE continuation_settings SET active_style_profile_id='legacy_1'")
        conn.commit()
        # Target already has a different active pointer. Restore clears it,
        # inserts parents first, writes settings with NULL pointers, then links.
        conn.execute("UPDATE continuation_settings SET active_source_id=NULL, active_canon_snapshot_id=NULL, active_style_profile_id=NULL")
        conn.execute("DELETE FROM continuation_style_profiles")
        conn.execute("DELETE FROM continuation_canon_snapshots")
        conn.execute("INSERT INTO continuation_canon_snapshots VALUES ('snap-1',1,10,100,19,2000)")
        conn.execute(
            """INSERT INTO continuation_style_profiles(
              id,project_id,source_id,source_version,source_sha256,parser_version,
              normalization_version,boundary_chapter_id,boundary_position,
              boundary_char_offset_exclusive,analysis_run_id,canon_snapshot_id,
              profile_schema_version,analyzer_version,profile_json,metrics_json,
              sample_refs_json,user_overrides_json,profile_hash,confidence,state,
              review_status,error_code,error_message,created_at,updated_at,completed_at
            ) VALUES ('style-1',1,10,1,'source-hash','parser-1','normalizer-1',100,19,2000,
              'run-1','snap-1',2,'analyzer-1','{}','{}','[]','{}','valid-hash',1,
              'ready','confirmed',NULL,NULL,'now','now','now')"""
        )
        conn.execute("UPDATE continuation_settings SET active_canon_snapshot_id='snap-1', active_style_profile_id='style-1'")
        conn.commit()
        assert rows(conn, "PRAGMA foreign_key_check") == []
        assert rows(conn, "SELECT active_canon_snapshot_id,active_style_profile_id FROM continuation_settings") == [('snap-1','style-1')]

        # Activation is one transaction: a failure after the Canon/Style
        # writes must leave both ready records and both pointers untouched.
        before_activation = rows(
            conn,
            "SELECT active_canon_snapshot_id,active_style_profile_id FROM continuation_settings",
        )
        try:
            conn.execute("BEGIN")
            conn.execute("UPDATE continuation_style_profiles SET state='outdated'")
            conn.execute("UPDATE continuation_settings SET active_canon_snapshot_id=NULL,active_style_profile_id=NULL")
            raise RuntimeError("fault after activation writes")
        except RuntimeError:
            conn.rollback()
        assert rows(
            conn,
            "SELECT active_canon_snapshot_id,active_style_profile_id FROM continuation_settings",
        ) == before_activation
        assert rows(conn, "SELECT state FROM continuation_style_profiles") == [('ready',)]

        # Source/boundary invalidation clears both pointers before deletion.
        conn.execute("UPDATE continuation_style_profiles SET project_id=1")
        conn.execute("UPDATE continuation_settings SET active_source_id=NULL, active_canon_snapshot_id=NULL, active_style_profile_id=NULL")
        conn.execute("DELETE FROM continuation_sources WHERE id=10")
        conn.commit()
        assert rows(conn, "PRAGMA foreign_key_check") == []


if __name__ == '__main__':
    test_migration_preserves_canon_and_rolls_back()
    test_two_phase_restore_lifecycle_and_atomic_activation()
    print('REAL_SQLITE_REVIEW_REGRESSION: PASS')
