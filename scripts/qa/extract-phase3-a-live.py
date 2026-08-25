#!/usr/bin/env python3
import json, sqlite3, sys
from pathlib import Path

db_path = sys.argv[1] if len(sys.argv) > 1 else "test-logs/a4-live.db"
con = sqlite3.connect(db_path)
con.row_factory = sqlite3.Row

def rows(sql):
    return [dict(r) for r in con.execute(sql)]

tasks = []
for task in rows(
    "SELECT id, target_id, status, created_at, updated_at, pipeline_context_json FROM pipeline_tasks ORDER BY created_at DESC LIMIT 40"
):
    ctx = None
    raw = task.get("pipeline_context_json")
    if raw:
        try:
            ctx = json.loads(raw)
        except Exception:
            ctx = None
    trace = None
    if isinstance(ctx, dict):
        trace = (
            (ctx.get("draftContext") or {}).get("writingKernelTrace")
            or ctx.get("writingKernelTrace")
            or ctx.get("trace")
        )
    obs = (trace or {}).get("observability") if isinstance(trace, dict) else None
    frozen = None
    if isinstance(ctx, dict):
        frozen = (ctx.get("draftContext") or {}).get("frozenWritingContext") or ctx.get(
            "frozenWritingContext"
        )
    values = ((frozen or {}).get("stagePolicy") or {}).get("values") or {}
    receipts = (trace or {}).get("requestReceipts") if isinstance(trace, dict) else []
    tasks.append(
        {
            "taskId": task["id"],
            "targetId": task["target_id"],
            "status": task["status"],
            "createdAt": task["created_at"],
            "updatedAt": task["updated_at"],
            "executionProfile": values.get("executionProfile")
            or (obs or {}).get("executionProfile"),
            "qualityProfile": values.get("qualityProfile"),
            "freezeFingerprint": (frozen or {}).get("freezeFingerprint")
            or (obs or {}).get("freezeFingerprint"),
            "observability": obs,
            "receipts": receipts or [],
        }
    )

attempts = rows(
    """SELECT pipeline_task_id, stage, status, input_tokens, output_tokens, total_tokens,
              finish_reason, frozen_request_json, started_at, completed_at
       FROM pipeline_stage_attempts ORDER BY started_at DESC LIMIT 80"""
)
try:
    runs = rows(
        """SELECT id, project_id, chapter_id, state, stage, created_at, updated_at
           FROM continuation_generation_runs ORDER BY created_at DESC LIMIT 20"""
    )
except Exception:
    runs = []

dest = Path("test-logs/phase3-a-live-baseline-db.json")
dest.write_text(
    json.dumps({"tasks": tasks, "attempts": attempts, "continuationRuns": runs}, indent=2, ensure_ascii=False),
    encoding="utf-8",
)
print("wrote", dest, "tasks", len(tasks), "attempts", len(attempts))
