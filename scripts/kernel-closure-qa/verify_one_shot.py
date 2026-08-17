# -*- coding: utf-8 -*-
"""
One-Shot (极速) 极速档取证脚本。

对一次多章批次做逐章硬门禁验证（方案 §16）：
  - 每章 pipeline_stage_attempts 中 LLM stage 只有 draft 且恰好 1 次 attempt
  - formatter_used = 0
  - review/factCheck/brief/proof 无 attempt 行（或状态为 skipped 的 stageResults）
  - 每章任务 freeze 正常（pipeline_context_json 含 executionProfile=one_shot
    且 freezeFingerprint 存在）
  - 章节正文已落库（chapters.content 非空）

用法：
  python verify_one_shot.py LOCAL_DB BATCH_ID
"""
import json
import sqlite3
import sys

LLM_STAGES = ('draft', 'review', 'factCheck', 'brief', 'proof')


def main(db_path: str, batch_id: str) -> int:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    items = conn.execute(
        """
        SELECT i.ordinal, i.chapter_id, i.status AS item_status,
               i.active_pipeline_task_id, i.completion_quality,
               i.error_code, i.error_message
        FROM multi_chapter_batch_items i
        WHERE i.batch_id = ?
        ORDER BY i.ordinal
        """,
        (batch_id,),
    ).fetchall()
    if not items:
        print(json.dumps({'ok': False, 'error': 'batch items not found',
                          'batchId': batch_id}, ensure_ascii=False))
        return 2

    batch = conn.execute(
        """
        SELECT status, reasoning_effort, execution_profile,
               chapter_count, used_llm_calls
        FROM multi_chapter_batches WHERE id = ?
        """,
        (batch_id,),
    ).fetchone()

    chapter_report = []
    ok = True
    for item in items:
        task_id = item['active_pipeline_task_id']
        entry = {
            'ordinal': item['ordinal'],
            'chapterId': item['chapter_id'],
            'itemStatus': item['item_status'],
            'taskId': task_id,
        }
        if not task_id:
            entry['ok'] = False
            entry['error'] = 'no pipeline task bound'
            ok = False
            chapter_report.append(entry)
            continue

        attempts = conn.execute(
            """
            SELECT stage, attempt_no, status, formatter_used,
                   input_tokens, output_tokens
            FROM pipeline_stage_attempts
            WHERE pipeline_task_id = ?
            ORDER BY stage, attempt_no
            """,
            (task_id,),
        ).fetchall()

        paid_attempts = [a for a in attempts if a['stage'] in LLM_STAGES]
        draft_attempts = [a for a in attempts if a['stage'] == 'draft']
        non_draft_paid = [a for a in paid_attempts if a['stage'] != 'draft']
        formatter_used = any(bool(a['formatter_used']) for a in attempts)

        # freeze / profile evidence
        task_row = conn.execute(
            'SELECT pipeline_context_json FROM pipeline_tasks WHERE id = ?',
            (task_id,),
        ).fetchone()

        freeze_ok = False
        profile_one_shot = False
        if task_row and task_row['pipeline_context_json']:
            try:
                env = json.loads(task_row['pipeline_context_json'])
                frozen = (env.get('draftContext') or {}).get(
                    'frozenWritingContext') or {}
                trace = (env.get('draftContext') or {}).get(
                    'writingKernelTrace') or {}
                values = ((frozen.get('stagePolicy') or {}).get('values') or {})
                profile_one_shot = (
                    (env.get('execution') or {}).get('executionProfile')
                    == 'one_shot'
                    or values.get('executionProfile') == 'one_shot'
                )
                freeze_ok = bool(
                    frozen.get('freezeFingerprint')
                    and trace.get('freezeFingerprint')
                    and frozen.get('freezeFingerprint')
                    == trace.get('freezeFingerprint')
                )
            except Exception as exc:  # noqa: BLE001
                entry['parseError'] = str(exc)

        # skipped stage checkpoints evidence (review/factCheck/brief/proof
        # must be terminal 'skipped', never 'succeeded')
        checkpoints = conn.execute(
            """
            SELECT stage, status FROM pipeline_stage_checkpoints
            WHERE task_id = ?
            """,
            (task_id,),
        ).fetchall()
        skip_evidence = {}
        for row in checkpoints:
            if row['stage'] in ('review', 'factCheck', 'brief', 'proof'):
                skip_evidence[row['stage']] = row['status']

        content_len = 0
        if item['chapter_id']:
            row = conn.execute(
                'SELECT length(content) AS n FROM chapters WHERE id = ?',
                (item['chapter_id'],),
            ).fetchone()
            content_len = (row['n'] or 0) if row else 0

        checks = {
            'paidCallCount': len(paid_attempts),
            'draftAttemptCount': len(draft_attempts),
            'nonDraftPaidStages': sorted({a['stage'] for a in non_draft_paid}),
            'formatterUsed': formatter_used,
            'freezeFingerprintOk': freeze_ok,
            'executionProfileOneShot': profile_one_shot,
            'chapterContentChars': content_len,
        }
        entry['checks'] = checks
        entry['ok'] = (
            len(paid_attempts) == 1
            and len(draft_attempts) == 1
            and not non_draft_paid
            and not formatter_used
            and freeze_ok
            and profile_one_shot
            and content_len > 0
        )
        ok = ok and entry['ok']
        chapter_report.append(entry)

    print(json.dumps({
        'ok': ok,
        'batch': {
            'id': batch_id,
            'status': batch['status'] if batch else None,
            'executionProfile': batch['execution_profile'] if batch else None,
            'reasoningEffort': batch['reasoning_effort'] if batch else None,
            'chapterCount': batch['chapter_count'] if batch else None,
            'usedLlmCalls': batch['used_llm_calls'] if batch else None,
        },
        'chapters': chapter_report,
    }, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('usage: python verify_one_shot.py LOCAL_DB BATCH_ID')
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
