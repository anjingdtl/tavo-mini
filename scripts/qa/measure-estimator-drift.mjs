#!/usr/bin/env node

/**
 * Read-only estimator drift report.
 *
 * Usage:
 *   node scripts/qa/measure-estimator-drift.mjs <database> [--out <report.json>]
 *
 * Only numeric usage/trace fields are read. Prompt text, request bodies and
 * credentials are never emitted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const databaseArg = args.find(value => !value.startsWith('--'));
const outIndex = args.indexOf('--out');
const outputArg = outIndex >= 0 ? args[outIndex + 1] : null;
if (!databaseArg || (outIndex >= 0 && !outputArg)) {
  console.error(
    'Usage: node scripts/qa/measure-estimator-drift.mjs <database> [--out <report.json>]',
  );
  process.exit(2);
}

const databasePath = path.resolve(databaseArg);
if (!fs.existsSync(databasePath)) throw new Error(`数据库不存在: ${databasePath}`);

function parseJson(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function estimatedInput(row) {
  const allocation = parseJson(row.allocation_trace_json);
  const frozen = parseJson(row.frozen_request_json);
  const candidates = [
    allocation && !Array.isArray(allocation)
      ? allocation.finalEstimatedInputTokens
      : null,
    frozen?.elasticBudgetTrace?.finalEstimatedInputTokens,
    frozen?.finalEstimatedInputTokens,
    frozen?.estimatedInputTokens,
  ];
  for (const candidate of candidates) {
    const value = finiteNonNegative(candidate);
    if (value != null) return value;
  }
  return null;
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function summarize(rows) {
  const ratios = rows
    .map(row => {
      const actual = finiteNonNegative(row.input_tokens);
      const estimate = estimatedInput(row);
      return actual != null && estimate != null && estimate > 0
        ? actual / estimate
        : null;
    })
    .filter(value => value != null);
  return {
    attempts: rows.length,
    comparableAttempts: ratios.length,
    coverage: rows.length ? ratios.length / rows.length : 0,
    ratioP50: percentile(ratios, 0.5),
    ratioP95: percentile(ratios, 0.95),
    ratioMax: ratios.length ? Math.max(...ratios) : null,
  };
}

const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const rows = db
    .prepare(
      `SELECT stage, status, input_tokens, allocation_trace_json,
              frozen_request_json
         FROM pipeline_stage_attempts
        ORDER BY started_at ASC, id ASC`,
    )
    .all();
  const stages = [...new Set(rows.map(row => String(row.stage || 'unknown')))].sort();
  const report = {
    schema: 'shinewriter.estimator-drift.v1',
    generatedAt: new Date().toISOString(),
    database: databasePath,
    note: '仅统计已有 finalEstimatedInputTokens 的 attempt；未覆盖行不补造估算值。',
    overall: summarize(rows),
    byStage: Object.fromEntries(
      stages.map(stage => [stage, summarize(rows.filter(row => String(row.stage || 'unknown') === stage))]),
    ),
    unmeasuredByStage: Object.fromEntries(
      stages.map(stage => {
        const stageRows = rows.filter(row => String(row.stage || 'unknown') === stage);
        return [
          stage,
          stageRows.filter(row => estimatedInput(row) == null).length,
        ];
      }),
    ),
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputArg) {
    const outputPath = path.resolve(outputArg);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, serialized, 'utf8');
    console.log(`estimator drift report written: ${outputPath}`);
  } else {
    process.stdout.write(serialized);
  }
} finally {
  db.close();
}
