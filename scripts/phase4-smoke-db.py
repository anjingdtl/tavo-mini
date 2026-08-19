"""
Phase 4 real-LLM smoke: prepare a fresh on-device DB.

Base: DB pulled from the emulator (schema 55, DeepSeek llm_config id=1 with
the API key held in Android Keystore keyed by configId).

Every table is emptied EXCEPT the whitelist below (system tables + the
DeepSeek config + the global workspace project). Then a fresh outline
project and one compact Standard batch (topology=2, ready) with a single
batch item (chapter_id=NULL so the reconciler creates the chapter) are
injected. PRAGMA foreign_key_check must be empty afterwards.

The app's first launch after installing the Phase 4 APK migrates Schema
55 -> 56 (live smoke of the `unified_qa` CHECK rebuild).
"""
import shutil
import sqlite3
import time

SRC = r"C:\Users\anjin\AppData\Local\Temp\emu-shine2.db"
DST = r"C:\Users\anjin\AppData\Local\Temp\emu-phase4.db"

# Tables kept untouched (system + credentials + global workspace).
KEEP = {'settings', 'llm_config', 'projects', 'sqlite_sequence'}

NOW_MS = int(time.time() * 1000)
NOW_ISO = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())


def build():
    shutil.copyfile(SRC, DST)
    c = sqlite3.connect(DST)
    c.execute('PRAGMA foreign_keys = OFF')
    cur = c.cursor()
    tables = [
        row[0] for row in cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    ]
    for table in tables:
        if table in KEEP:
            continue
        try:
            cur.execute(f'DELETE FROM "{table}"')
        except sqlite3.OperationalError:
            pass
    cur.execute('DELETE FROM projects WHERE id != 0')
    cur.execute('DELETE FROM llm_config WHERE id != 1')

    cur.execute(
        "INSERT INTO projects (id, name, mode, created_at, updated_at) "
        "VALUES (?, ?, 'outline', ?, ?)",
        (90, 'PHASE4_SMOKE', NOW_ISO, NOW_ISO),
    )
    cur.execute(
        """INSERT INTO multi_chapter_batches
           (id, project_id, status, source_prompt, chapter_count,
            target_words_per_chapter, pipeline_mode, start_position,
            outline_workflow_version, context_budget_version,
            pipeline_topology_version, execution_profile, writing_mode,
            created_at, updated_at)
           VALUES (?, ?, 'ready', ?, 1, 3000, 'full', 0, 4, 5, 2,
                   'standard', 'outline', ?, ?)""",
        ('batch_p4u_1', 90, 'Phase 4 ONE QA smoke', NOW_MS, NOW_MS),
    )
    cur.execute(
        """INSERT INTO multi_chapter_batch_items
           (batch_id, ordinal, title, synopsis, key_beats_json,
            target_words, status, created_at, updated_at)
           VALUES (?, 1, '第一章', '主角在雨夜收到一封匿名信。', '[]', 3000,
                   'pending', ?, ?)""",
        ('batch_p4u_1', NOW_MS, NOW_MS),
    )
    c.commit()
    c.execute('PRAGMA foreign_keys = ON')
    orphans = cur.execute('PRAGMA foreign_key_check').fetchall()
    c.close()
    if orphans:
        print('FK_ORPHANS', len(orphans), orphans[:5])
        raise SystemExit(1)
    print('ok', DST)


if __name__ == '__main__':
    build()
