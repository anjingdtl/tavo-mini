#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

async function main() {
  const dbPath = process.argv[2] || 'test-logs/a4-live.db';
  const SQL = await initSqlJs();
  const file = fs.readFileSync(dbPath);
  const db = new SQL.Database(file);
  const out = [];

  function all(sql) {
    const stmt = db.prepare(sql);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  const tasks = all(
    `SELECT id, target_id, status, created_at, updated_at, pipeline_context_json
     FROM pipeline_tasks ORDER BY created_at DESC LIMIT 40`,
  );
  for (const task of tasks) {
    let ctx = null;
    try {
      ctx = JSON.parse(task.pipeline_context_json || 'null');
    } catch {
      ctx = null;
    }
    const trace =
      ctx?.draftContext?.writingKernelTrace ||
      ctx?.writingKernelTrace ||
      ctx?.trace ||
      null;
    const obs = trace?.observability || null;
    const receipts = trace?.requestReceipts || [];
    const frozen = ctx?.draftContext?.frozenWritingContext || ctx?.frozenWritingContext;
    out.push({
      taskId: task.id,
      targetId: task.target_id,
      status: task.status,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      executionProfile:
        frozen?.stagePolicy?.values?.executionProfile ||
        obs?.executionProfile ||
        null,
      qualityProfile: frozen?.stagePolicy?.values?.qualityProfile || null,
      freezeFingerprint: frozen?.freezeFingerprint || obs?.freezeFingerprint || null,
      observability: obs,
      receipts: receipts.map(r => ({
        requestId: r.requestId,
        requestFingerprint: r.requestFingerprint,
        stage: r.stage,
        outcome: r.outcome,
        usage: r.usage,
        kind: r.kind,
      })),
    });
  }

  const attempts = all(
    `SELECT pipeline_task_id, stage, status, input_tokens, output_tokens, total_tokens,
            finish_reason, frozen_request_json, started_at, completed_at
     FROM pipeline_stage_attempts ORDER BY started_at DESC LIMIT 80`,
  );

  const runs = all(
    `SELECT id, project_id, chapter_id, state, stage, created_at, updated_at, context_snapshot_json
     FROM continuation_generation_runs ORDER BY created_at DESC LIMIT 20`,
  );

  const payload = { tasks: out, attempts, continuationRuns: runs };
  const dest = path.join('test-logs', 'phase3-a-live-baseline-db.json');
  fs.writeFileSync(dest, JSON.stringify(payload, null, 2));
  console.log('wrote', dest, 'tasks', out.length, 'attempts', attempts.length);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
