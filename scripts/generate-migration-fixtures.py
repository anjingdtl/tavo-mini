"""Generate and validate data-rich SQLite fixtures for Schema 3..31.

The app's Jest migration matrix already covers creation of missing tables with
mocked react-native-sqlite-storage. These fixtures add a second, file-backed
check: every historical version carries representative user data, then the
same migration SQL contract is applied with Python's SQLite implementation.

Optional tables introduced by later versions are intentionally present in the
data-rich fixtures so every fixture contains the same user-facing entities.
Their version-specific columns are still removed and restored where the
production migration owns those changes. This keeps the fixtures useful for
data-preservation testing without replacing the focused missing-table tests.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import subprocess
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = ROOT / "__tests__" / "fixtures" / "databases"
VERSIONS = range(3, 33)
CURRENT_SCHEMA = 33
NOW = "2026-07-15T00:00:00.000Z"
LONG_TEXT = ("这是一段用于迁移验证的超长正文。Long migration content. " * 900).strip()
SPECIAL_TEXT = '特殊字符：中文 / English — emoji 😀 <tag> & quote "quoted"'


def migration_statements() -> dict[int, list[dict[str, object]]]:
    """Load the real TS migration builders once for fixture generation/checks."""
    emitter = ROOT / "scripts" / "emit-migration-fixture-sql.js"
    result = subprocess.run(
        ["node", str(emitter)],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    payload = json.loads(result.stdout)
    return {int(item["from"]): item["statements"] for item in payload}


BASE_TABLES: dict[str, str] = {
    "projects": """
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'outline',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
    """,
    "chapters": """
        CREATE TABLE chapters (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          title TEXT NOT NULL DEFAULT '',
          synopsis TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'planned',
          summary_json TEXT,
          memory_summary TEXT NOT NULL DEFAULT '',
          memory_summary_tokens INTEGER NOT NULL DEFAULT 0,
          finalized_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    """,
    "fragments": """
        CREATE TABLE fragments (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          type TEXT NOT NULL DEFAULT 'seed',
          content TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    """,
    "plotlines": """
        CREATE TABLE plotlines (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT '#2563EB',
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    """,
    "project_plotlines": """
        CREATE TABLE project_plotlines (
          chapter_id INTEGER NOT NULL,
          plotline_id INTEGER NOT NULL,
          PRIMARY KEY (chapter_id, plotline_id),
          FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
          FOREIGN KEY (plotline_id) REFERENCES plotlines(id) ON DELETE CASCADE
        )
    """,
    "characters": """
        CREATE TABLE characters (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          {collection_column}
          name TEXT NOT NULL DEFAULT '',
          source_type TEXT NOT NULL DEFAULT 'json',
          data_json TEXT NOT NULL DEFAULT '{{}}',
          max_tokens INTEGER NOT NULL DEFAULT 50000,
          estimated_tokens INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    """,
    "character_collections": """
        CREATE TABLE character_collections (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          max_tokens INTEGER NOT NULL DEFAULT 50000,
          estimated_tokens INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    """,
    "worldbook_collections": """
        CREATE TABLE worldbook_collections (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          max_tokens INTEGER NOT NULL DEFAULT 50000,
          estimated_tokens INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    """,
    "worldbook_entries": """
        CREATE TABLE worldbook_entries (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          collection_id INTEGER NOT NULL DEFAULT 0,
          keyword_primary TEXT NOT NULL DEFAULT '',
          keyword_secondary TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '',
          comment TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          constant INTEGER NOT NULL DEFAULT 0,
          max_tokens INTEGER NOT NULL DEFAULT 2000,
          estimated_tokens INTEGER NOT NULL DEFAULT 0,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    """,
    "notes": """
        CREATE TABLE notes (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '',
          max_tokens INTEGER NOT NULL DEFAULT 30000,
          estimated_tokens INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    """,
    "presets": """
        CREATE TABLE presets (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          is_default INTEGER NOT NULL DEFAULT 0,
          system_prompt TEXT NOT NULL DEFAULT '',
          writing_style TEXT NOT NULL DEFAULT '',
          temperature REAL NOT NULL DEFAULT 0.8,
          top_p REAL NOT NULL DEFAULT 0.9,
          max_tokens INTEGER NOT NULL DEFAULT 4000,
          extra_instructions TEXT NOT NULL DEFAULT ''
        )
    """,
    "llm_config": """
        CREATE TABLE llm_config (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL DEFAULT '',
          base_url TEXT NOT NULL DEFAULT '',
          api_key TEXT NOT NULL DEFAULT '',
          model_name TEXT NOT NULL DEFAULT '',
          is_active INTEGER NOT NULL DEFAULT 0{llm_columns}
        )
    """,
    "local_llm_models": """
        CREATE TABLE local_llm_models (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          original_filename TEXT NOT NULL,
          relative_path TEXT NOT NULL UNIQUE,
          file_size INTEGER NOT NULL DEFAULT 0,
          sha256 TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'importing',
          backend_preference TEXT NOT NULL DEFAULT 'auto',
          validated_backend TEXT,
          context_length INTEGER,
          max_output_tokens INTEGER,
          load_time_ms INTEGER,
          first_token_ms INTEGER,
          tokens_per_second REAL,
          imported_at TEXT NOT NULL,
          last_used_at TEXT,
          last_validated_at TEXT,
          error_code TEXT,
          error_message TEXT{local_columns}
        )
    """,
    "settings": """
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL DEFAULT ''
        )
    """,
    "project_resources": """
        CREATE TABLE project_resources (
          project_id INTEGER NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id INTEGER NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (project_id, resource_type, resource_id),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    """,
    "llm_usage_logs": """
        CREATE TABLE llm_usage_logs (
          id INTEGER PRIMARY KEY,
          scenario TEXT NOT NULL DEFAULT '',
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT '',
          error_code TEXT NOT NULL DEFAULT '',
          {usage_columns}
          created_at TEXT NOT NULL
        )
    """,
    "pipeline_tasks": """
        CREATE TABLE pipeline_tasks (
          id TEXT PRIMARY KEY,
          target_type TEXT NOT NULL,
          target_id INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'idle',
          stage_results TEXT NOT NULL DEFAULT '[]',
          final_text TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          resolved_at INTEGER,
          resolved_action TEXT
        )
    """,
    "freeform_documents": """
        CREATE TABLE freeform_documents (
          project_id INTEGER PRIMARY KEY,
          content TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    """,
    "content_revisions": """
        CREATE TABLE content_revisions (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          target_type TEXT NOT NULL,
          target_id INTEGER NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL,
          source_ref TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    """,
    "generation_drafts": """
        CREATE TABLE generation_drafts (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          target_type TEXT NOT NULL,
          target_id INTEGER NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL,
          pipeline_task_id TEXT,
          token_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    """,
    "project_note_config": """
        CREATE TABLE project_note_config (
          project_id INTEGER PRIMARY KEY,
          mode TEXT NOT NULL DEFAULT 'none',
          style_weights TEXT NOT NULL DEFAULT '{{}}',
          retrieval_top_k INTEGER NOT NULL DEFAULT 5,
          {retrieval_column}
          enabled_note_ids TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    """,
    "note_style_profiles": """
        CREATE TABLE note_style_profiles (
          note_id INTEGER PRIMARY KEY,
          profile_text TEXT NOT NULL DEFAULT '',
          profile_json TEXT NOT NULL DEFAULT '{{}}',
          analyzed_at TEXT NOT NULL,
          source_hash TEXT NOT NULL DEFAULT '',
          FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        )
    """,
}


def table_sql(name: str, version: int) -> str:
    collection_column = (
        "collection_id INTEGER NOT NULL DEFAULT 0,"
        if version >= 11
        else ""
    )
    llm_columns = (
        ", provider_type TEXT NOT NULL DEFAULT 'openai_compatible',"
        "local_model_id TEXT,"
        "local_backend TEXT,"
        "context_window INTEGER NOT NULL DEFAULT 4096,"
        "max_output_tokens INTEGER NOT NULL DEFAULT 4000"
        if version >= 12
        else ""
    )
    local_columns = (
        ", prompt_template TEXT NOT NULL DEFAULT 'chatml',"
        "actual_backend TEXT"
        if version >= 13
        else ""
    )
    usage_columns = ""
    if version >= 8:
        usage_columns += "model_name TEXT NOT NULL DEFAULT '', project_id INTEGER NOT NULL DEFAULT 0,"
    if version >= 10:
        usage_columns += "llm_config_id INTEGER NOT NULL DEFAULT 0, llm_config_name TEXT NOT NULL DEFAULT '',"
    retrieval_column = (
        "retrieval_fragment_chars INTEGER NOT NULL DEFAULT 1000,"
        if version != 13
        else ""
    )
    return BASE_TABLES[name].format(
        collection_column=collection_column,
        llm_columns=llm_columns,
        local_columns=local_columns,
        usage_columns=usage_columns,
        retrieval_column=retrieval_column,
    )


def columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def insert_row(conn: sqlite3.Connection, table: str, row: dict[str, object]) -> None:
    available = columns(conn, table)
    selected = [(key, value) for key, value in row.items() if key in available]
    names = ", ".join(key for key, _ in selected)
    placeholders = ", ".join("?" for _ in selected)
    conn.execute(
        f"INSERT INTO {table} ({names}) VALUES ({placeholders})",
        [value for _, value in selected],
    )


def seed_fixture(conn: sqlite3.Connection, version: int) -> None:
    conn.execute("PRAGMA foreign_keys = ON")
    for name in BASE_TABLES:
        try:
            conn.execute(table_sql(name, version))
        except sqlite3.OperationalError as error:
            raise RuntimeError(f"unable to create {name} for schema {version}") from error

    conn.execute("CREATE INDEX idx_local_llm_models_status ON local_llm_models(status)")
    conn.execute("CREATE INDEX idx_local_llm_models_last_used ON local_llm_models(last_used_at)")
    if "project_id" in columns(conn, "llm_usage_logs"):
        conn.execute("CREATE INDEX idx_llm_usage_logs_month ON llm_usage_logs(project_id, created_at)")
    if "llm_config_id" in columns(conn, "llm_usage_logs"):
        conn.execute("CREATE INDEX idx_llm_usage_logs_config ON llm_usage_logs(llm_config_id, created_at)")
    conn.execute("CREATE INDEX idx_content_revisions_target ON content_revisions(target_type, target_id, created_at)")
    conn.execute("CREATE INDEX idx_generation_drafts_target ON generation_drafts(target_type, target_id, created_at)")

    insert_row(conn, "projects", {"id": 0, "name": "全局资源", "mode": "outline", "created_at": NOW, "updated_at": NOW})
    insert_row(conn, "projects", {"id": 1, "name": "星河 Project α", "mode": "outline", "created_at": NOW, "updated_at": NOW})
    insert_row(conn, "projects", {"id": 2, "name": "Empty-field / 第二项目", "mode": "freeform", "created_at": NOW, "updated_at": NOW})

    chapters = [
        (1, 1, "第一章 · 起点", "序章 synopsis", "这是第一章。English mixed text.", "draft"),
        (2, 1, "第二章 — 长文本", "", LONG_TEXT, "revision"),
        (3, 2, "Chapter Two / 第二项目", "", SPECIAL_TEXT, "planned"),
        (4, 2, "", "empty title is allowed", "", "planned"),
    ]
    for chapter_id, project_id, title, synopsis, content, status in chapters:
        insert_row(
            conn,
            "chapters",
            {
                "id": chapter_id,
                "project_id": project_id,
                "position": chapter_id - 1,
                "title": title,
                "synopsis": synopsis,
                "content": content,
                "status": status,
                "summary_json": "",
                "memory_summary": "",
                "memory_summary_tokens": 0,
                "created_at": NOW,
                "updated_at": NOW,
            },
        )

    for fragment_id, project_id in ((1, 1), (2, 2)):
        insert_row(conn, "fragments", {"id": fragment_id, "project_id": project_id, "position": 0, "type": "seed", "content": SPECIAL_TEXT, "created_at": NOW})
    for plotline_id, project_id in ((1, 1), (2, 2)):
        insert_row(conn, "plotlines", {"id": plotline_id, "project_id": project_id, "name": f"主线 {project_id}", "description": "English plotline", "color": "#439EA6"})
    insert_row(conn, "project_plotlines", {"chapter_id": 1, "plotline_id": 1})
    insert_row(conn, "project_plotlines", {"chapter_id": 3, "plotline_id": 2})

    for collection_id, project_id in ((1, 1), (2, 2)):
        insert_row(conn, "character_collections", {"id": collection_id, "project_id": project_id, "name": f"角色集合 {project_id}", "enabled": 1, "max_tokens": 50000, "estimated_tokens": 42, "created_at": NOW})
        insert_row(conn, "worldbook_collections", {"id": collection_id, "project_id": project_id, "name": f"世界书集合 {project_id}", "enabled": 1, "max_tokens": 50000, "estimated_tokens": 42, "created_at": NOW})
    for character_id, project_id, collection_id in ((1, 1, 1), (2, 1, 1), (3, 2, 2), (4, 2, 2)):
        insert_row(conn, "characters", {"id": character_id, "project_id": project_id, "collection_id": collection_id, "name": f"角色 {character_id}", "source_type": "json", "data_json": '{"name":"角色"}', "max_tokens": 50000, "estimated_tokens": 42, "created_at": NOW})
    for entry_id, project_id, collection_id in ((1, 1, 1), (2, 1, 1), (3, 2, 2), (4, 2, 2)):
        insert_row(conn, "worldbook_entries", {"id": entry_id, "project_id": project_id, "collection_id": collection_id, "keyword_primary": f"keyword-{entry_id}", "keyword_secondary": "中文 English", "content": SPECIAL_TEXT if entry_id == 1 else "", "comment": "", "enabled": 1, "constant": 0, "max_tokens": 2000, "estimated_tokens": 16, "position": entry_id, "created_at": NOW})

    for note_id, project_id, title, content in ((1, 1, "设定笔记", SPECIAL_TEXT), (2, 1, "空笔记", ""), (3, 2, "English Note", LONG_TEXT[:4000]), (4, 2, "第二项目资料", SPECIAL_TEXT)):
        insert_row(conn, "notes", {"id": note_id, "project_id": project_id, "title": title, "content": content, "max_tokens": 30000, "estimated_tokens": 20, "created_at": NOW, "updated_at": NOW})
    for preset_id, project_id in ((1, 1), (2, 2)):
        insert_row(conn, "presets", {"id": preset_id, "project_id": project_id, "name": f"预设 {project_id}", "is_default": 1, "system_prompt": "", "writing_style": "", "temperature": 0.8, "top_p": 0.9, "max_tokens": 4000, "extra_instructions": ""})

    insert_row(conn, "llm_config", {"id": 1, "name": "Online API", "base_url": "https://api.example.com/v1", "api_key": "", "model_name": "model-en-1", "is_active": 1, "provider_type": "openai_compatible", "local_model_id": None, "local_backend": None, "context_window": 4096, "max_output_tokens": 4000})
    local_provider = "local_litertlm" if version <= 12 else "llama_cpp"
    insert_row(conn, "llm_config", {"id": 2, "name": "Local GGUF", "base_url": "", "api_key": "", "model_name": "fixture-model", "is_active": 0, "provider_type": local_provider, "local_model_id": "fixture-model", "local_backend": "cpu", "context_window": 2048, "max_output_tokens": 512})
    insert_row(conn, "local_llm_models", {"id": "fixture-model", "display_name": "Fixture Qwen", "original_filename": "fixture.gguf", "relative_path": "models/fixture.gguf", "file_size": 1234, "sha256": "fixture-sha256", "status": "ready", "backend_preference": "cpu", "validated_backend": "cpu", "context_length": 2048, "max_output_tokens": 512, "load_time_ms": 10, "first_token_ms": 20, "tokens_per_second": 3.5, "imported_at": NOW, "last_used_at": NOW, "last_validated_at": NOW, "error_code": "", "error_message": "", "prompt_template": "chatml", "actual_backend": "cpu"})

    for project_id, chapter_id in ((1, 1), (2, 3)):
        for resource_type, resource_id in (("character", project_id * 2 - 1), ("worldbook", project_id * 2 - 1), ("note", project_id * 2 - 1), ("preset", project_id)):
            insert_row(conn, "project_resources", {"project_id": project_id, "resource_type": resource_type, "resource_id": resource_id, "enabled": 1})
        insert_row(conn, "freeform_documents", {"project_id": project_id, "content": SPECIAL_TEXT, "updated_at": NOW})
        insert_row(conn, "content_revisions", {"id": project_id, "project_id": project_id, "target_type": "chapter", "target_id": chapter_id, "title": "Revision", "content": SPECIAL_TEXT, "source": "manual", "source_ref": "fixture", "created_at": NOW})
        insert_row(conn, "generation_drafts", {"id": project_id, "project_id": project_id, "target_type": "chapter", "target_id": chapter_id, "content": LONG_TEXT[:2000], "source": "pipeline", "pipeline_task_id": f"fixture-task-{project_id}", "token_count": 120, "created_at": NOW})
        insert_row(conn, "project_note_config", {"project_id": project_id, "mode": "library", "style_weights": "{}", "retrieval_top_k": 5, "retrieval_fragment_chars": 1000, "enabled_note_ids": "[]", "updated_at": NOW})
        insert_row(conn, "note_style_profiles", {"note_id": project_id, "profile_text": "", "profile_json": "{}", "analyzed_at": NOW, "source_hash": "fixture"})
        insert_row(conn, "pipeline_tasks", {"id": f"fixture-task-{project_id}", "target_type": "chapter", "target_id": chapter_id, "status": "completed", "stage_results": "[]", "final_text": SPECIAL_TEXT, "error": "", "created_at": 1, "updated_at": 2, "resolved_at": 3, "resolved_action": "completed"})

    insert_row(conn, "llm_usage_logs", {"id": 1, "scenario": "chapter_draft", "input_tokens": 10, "output_tokens": 20, "total_tokens": 30, "status": "success", "error_code": "", "model_name": "model-en-1", "project_id": 1, "llm_config_id": 1, "llm_config_name": "Online API", "created_at": NOW})
    insert_row(conn, "settings", {"key": "schema_version", "value": str(version)})
    insert_row(conn, "settings", {"key": "current_project_id", "value": "2"})
    insert_row(conn, "settings", {"key": "allow_insecure_lan_http", "value": "false"})
    conn.commit()


def add_column_if_missing(conn: sqlite3.Connection, table: str, definition: str) -> None:
    name = definition.split()[0]
    if name not in columns(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {definition}")


def apply_migrations(
    conn: sqlite3.Connection,
    from_version: int,
    to_version: int = CURRENT_SCHEMA,
    migrations: dict[int, list[dict[str, object]]] | None = None,
) -> None:
    migrations = migrations or migration_statements()

    def execute_statement(statement: dict[str, object]) -> None:
        sql = str(statement["sql"])
        normalized = " ".join(sql.split())
        alter = re.match(r"ALTER TABLE (\w+) ADD COLUMN (\w+)", normalized, re.IGNORECASE)
        if alter and alter.group(2) in columns(conn, alter.group(1)):
            return
        conn.execute(sql, tuple(statement.get("params", [])))

    for version in range(from_version, to_version):
        statements = migrations[version]
        needs_parent_rebuild_flags = version == 31
        if needs_parent_rebuild_flags:
            conn.execute("PRAGMA foreign_keys = OFF")
            conn.execute("PRAGMA legacy_alter_table = ON")
        try:
            with conn:
                for statement in statements:
                    execute_statement(statement)
                conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?)",
                    (str(version + 1),),
                )
        finally:
            if needs_parent_rebuild_flags:
                conn.execute("PRAGMA legacy_alter_table = OFF")
                conn.execute("PRAGMA foreign_keys = ON")


def assert_no_duplicates(conn: sqlite3.Connection, table: str) -> None:
    primary_key = "id" if "id" in columns(conn, table) else None
    if primary_key:
        total, distinct = conn.execute(f"SELECT COUNT(*), COUNT(DISTINCT {primary_key}) FROM {table}").fetchone()
        assert total == distinct, f"duplicate primary keys in {table}"


def validate_fixture(
    path: Path,
    migrations: dict[int, list[dict[str, object]]],
) -> None:
    version = int(path.stem.split("-")[1])
    source = sqlite3.connect(path)
    conn = sqlite3.connect(":memory:")
    source.backup(conn)
    source.close()
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        apply_migrations(conn, version, CURRENT_SCHEMA, migrations)
    except Exception as error:
        raise RuntimeError(f"migration failed for {path.name}") from error
    assert conn.execute("SELECT value FROM settings WHERE key = 'schema_version'").fetchone()[0] == str(CURRENT_SCHEMA)
    expected_counts = {
        "projects": 3,
        "chapters": 4,
        "characters": 4,
        "character_collections": 2,
        "worldbook_collections": 2,
        "worldbook_entries": 4,
        "notes": 4,
        "llm_config": 2,
        "content_revisions": 2,
        "generation_drafts": 2,
        "pipeline_tasks": 2,
    }
    for table, expected in expected_counts.items():
        actual = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        assert actual == expected, f"{path.name}: {table} expected {expected}, got {actual}"
        assert_no_duplicates(conn, table)
    assert conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'local_llm_models'"
    ).fetchone()[0] == 0
    assert conn.execute("SELECT value FROM settings WHERE key = 'current_project_id'").fetchone()[0] == "2"
    assert conn.execute("SELECT COUNT(*) FROM chapters WHERE length(content) > 10000").fetchone()[0] >= 1
    assert conn.execute("SELECT COUNT(*) FROM chapters WHERE content = '' OR synopsis = ''").fetchone()[0] >= 1
    assert conn.execute("SELECT COUNT(*) FROM chapters WHERE content LIKE '%English%' AND content LIKE '%中文%'").fetchone()[0] >= 1
    assert conn.execute("SELECT COUNT(*) FROM projects WHERE name LIKE '%α%'").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM projects WHERE id > 0").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM chapters WHERE project_id NOT IN (SELECT id FROM projects)").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM project_resources WHERE project_id NOT IN (SELECT id FROM projects)").fetchone()[0] == 0
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    required_columns = {
        "project_note_config": {"retrieval_fragment_chars"},
        "llm_config": {"provider_type", "context_window", "max_output_tokens"},
        "llm_usage_logs": {"model_name", "project_id", "llm_config_id", "llm_config_name"},
    }
    for table, required in required_columns.items():
        assert required <= columns(conn, table), f"{path.name}: missing columns in {table}"
    conn.close()


def generate() -> None:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    migrations = migration_statements()
    for version in VERSIONS:
        path = FIXTURE_DIR / f"schema-{version}.db"
        if path.exists():
            path.unlink()
        conn = sqlite3.connect(path)
        seed_fixture(conn, 3)
        apply_migrations(conn, 3, version, migrations)
        conn.close()


def check(migrations: dict[int, list[dict[str, object]]] | None = None) -> None:
    migrations = migrations or migration_statements()
    missing = [str(FIXTURE_DIR / f"schema-{version}.db") for version in VERSIONS if not (FIXTURE_DIR / f"schema-{version}.db").exists()]
    assert not missing, "missing fixtures: " + ", ".join(missing)
    for version in VERSIONS:
        validate_fixture(FIXTURE_DIR / f"schema-{version}.db", migrations)
    print(f"validated {len(list(VERSIONS))} migration fixtures to Schema {CURRENT_SCHEMA}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="validate committed fixtures without rewriting them")
    args = parser.parse_args()
    if args.check:
        check()
    else:
        generate()
        check()


if __name__ == "__main__":
    main()
