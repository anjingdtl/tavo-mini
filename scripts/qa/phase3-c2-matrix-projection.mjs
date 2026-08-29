#!/usr/bin/env node
/**
 * Produce a safe, read-only Phase III-C C2 Android matrix projection.
 *
 * The source database contains stage artifacts, so this script deliberately
 * projects only scalar batch/stage/receipt/governor metadata. It never emits
 * prompts, generated text, request/response bodies, or credentials.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2];
const outputPath =
  process.argv[3] ||
  'test-logs/phase3-c-v2/c2-governor-shadow/c2-corrected-matrix-safe-projection.json';

if (!dbPath) {
  console.error(
    'Usage: node phase3-c2-matrix-projection.mjs <stable-sqlite> [output-json]',
  );
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const safeShadowFields = [
  'version',
  'mode',
  'stage',
  'profileKey',
  'coldStart',
  'learned',
  'profileSampleCount',
  'providerAdapterId',
  'modelName',
  'qualityProfile',
  'executionProfile',
  'outputContract',
  'thinkingEnabled',
  'reasoningEffort',
  'reasoningSeedVersion',
  'contextCapability',
  'completionCapability',
  'providerWireCeiling',
  'actualPromptTokens',
  'targetChars',
  'visibleDemand',
  'visibleOutputFloor',
  'demandFloor',
  'reasoningEnvelope',
  'protocolReserve',
  'contextSafetyReserve',
  'outputSafetyReserve',
  'safetyReserve',
  'recommendedSoftBudget',
  'hardCeiling',
  'recommendedWireMax',
  'legacyWireMax',
  'pressure',
  'preflightBlocked',
  'recommendationMeetsDemandFloor',
  'actualCompletionUsage',
  'visibleOutput',
  'reasoningUsage',
  'finishReason',
  'latencyMs',
];

const safeReceiptFields = [
  'version',
  'stage',
  'qualityProfile',
  'executionProfile',
  'provider',
  'providerAdapterId',
  'llmConfigId',
  'model',
  'thinking',
  'reasoningEffort',
  'promptCompilerVersion',
  'completionCapability',
  'wireMaxTokens',
  'providerCompletionLimit',
  'configuredContextWindow',
  'targetChars',
  'actualPromptTokens',
  'responseFormat',
  'finishReason',
  'emptyReason',
  'failureClass',
  'requestMayHaveExecuted',
  'physicalRequestCount',
  'protocolFallbackCount',
  'outcome',
  'kind',
];

const safeUsageFields = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'reasoningTokens',
  'visibleOutputTokens',
];

const safeTimingFields = [
  'queueWaitMs',
  'providerElapsedMs',
  'parseMs',
  'persistMs',
  'totalMs',
];

const matrixSpecs = [
  { targetChars: 500, quality: 'fast', sourcePrompt: 'C2_matrix_500_fast' },
  {
    targetChars: 500,
    quality: 'standard',
    sourcePrompt: 'C2_matrix_500_standard',
  },
  {
    targetChars: 500,
    quality: 'quality',
    sourcePrompt: 'C2_500_quality_feedback_d',
    evidenceKind: 'same-process-feedback-latest',
  },
  { targetChars: 1000, quality: 'fast', sourcePrompt: 'C2_matrix_1000_fast' },
  {
    targetChars: 1000,
    quality: 'standard',
    sourcePrompt: 'C2_matrix_1000_standard',
  },
  {
    targetChars: 1000,
    quality: 'quality',
    sourcePrompt: 'C2_1000_quality_probe',
  },
  {
    targetChars: 3000,
    quality: 'fast',
    sourcePrompt: 'C2_matrix_3000_fast',
  },
  {
    targetChars: 3000,
    quality: 'standard',
    sourcePrompt: 'C2_matrix_3000_standard',
  },
  {
    targetChars: 3000,
    quality: 'quality',
    sourcePrompt: 'C2_matrix_3000_quality',
  },
];

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function projectFields(source, fields) {
  const result = {};
  for (const field of fields) {
    result[field] = source?.[field] ?? null;
  }
  return result;
}

function projectReceipt(receipt, shadow) {
  const projected = projectFields(receipt, safeReceiptFields);
  projected.usage = projectFields(receipt?.usage, safeUsageFields);
  projected.timings = projectFields(receipt?.timings, safeTimingFields);
  projected.governorShadow = projectFields(shadow, safeShadowFields);
  projected.wireUnchanged =
    shadow?.legacyWireMax != null &&
    receipt?.wireMaxTokens != null &&
    Number(shadow.legacyWireMax) === Number(receipt.wireMaxTokens);
  projected.recommendationNotSent = true;
  return projected;
}

function findReceiptShadowPairs(value, result = []) {
  if (!value || typeof value !== 'object') return result;
  if (Array.isArray(value)) {
    for (const item of value) findReceiptShadowPairs(item, result);
    return result;
  }
  if (value.governorShadow && typeof value.governorShadow === 'object') {
    result.push({ receipt: value, shadow: value.governorShadow });
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      findReceiptShadowPairs(child, result);
    }
  }
  return result;
}

function projectStage(row) {
  const output = parseJson(row.output_json);
  const pairs = findReceiptShadowPairs(output);
  return {
    stage: row.stage,
    status: row.status,
    requestReserved: row.request_reserved,
    requestCount: row.request_count,
    modelConfigId: row.model_config_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    minOutputTokens: row.min_output_tokens,
    maxOutputTokens: row.max_output_tokens,
    errorCode: row.error_code,
    receiptCount: pairs.length,
    receipts: pairs.map(({ receipt, shadow }) =>
      projectReceipt(receipt, shadow),
    ),
  };
}

function selectBatch(sourcePrompt) {
  return db
    .prepare(
      `SELECT id, status, reasoning_effort, execution_profile,
              target_words_per_chapter, chapter_count, completed_count,
              current_ordinal, used_llm_calls, used_input_tokens,
              used_output_tokens, error_code, created_at, completed_at
         FROM multi_chapter_batches
        WHERE source_prompt = ?
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(sourcePrompt);
}

function projectCell(spec) {
  const batch = selectBatch(spec.sourcePrompt);
  if (!batch) {
    return {
      ...spec,
      status: 'missing',
      missing: ['batch'],
    };
  }
  const item = db
    .prepare(
      `SELECT ordinal, status, chapter_id, active_continuation_run_id,
              retry_count, error_code
         FROM multi_chapter_batch_items
        WHERE batch_id = ?
        ORDER BY ordinal
        LIMIT 1`,
    )
    .get(batch.id);
  const run = item?.active_continuation_run_id
    ? db
        .prepare(
          `SELECT id, state, stage, target_position, completion_reason,
                  error_code, created_at, completed_at
             FROM continuation_generation_runs
            WHERE id = ?`,
        )
        .get(item.active_continuation_run_id)
    : item?.chapter_id
    ? db
        .prepare(
          `SELECT id, state, stage, target_position, completion_reason,
                  error_code, created_at, completed_at
             FROM continuation_generation_runs
            WHERE chapter_id = ? AND created_at >= ?
            ORDER BY created_at DESC
            LIMIT 1`,
        )
        .get(item.chapter_id, batch.created_at)
    : null;
  const stages = run
    ? db
        .prepare(
          `SELECT stage, status, request_reserved, request_count,
                  model_config_id, input_tokens, output_tokens,
                  min_output_tokens, max_output_tokens, error_code,
                  output_json
             FROM continuation_generation_stage_results
            WHERE run_id = ?
            ORDER BY created_at`,
        )
        .all(run.id)
        .map(projectStage)
    : [];

  const missing = [];
  if (!item) missing.push('batch_item');
  if (!run) missing.push('generation_run');
  if (stages.length === 0) missing.push('stage_results');
  if (
    !stages.some(stage =>
      stage.receipts.some(
        receipt => receipt.governorShadow && typeof receipt.governorShadow === 'object',
      ),
    )
  ) {
    missing.push('governor_shadow');
  }

  return {
    ...spec,
    batch: {
      id: batch.id,
      status: batch.status,
      reasoningEffort: batch.reasoning_effort,
      executionProfile: batch.execution_profile,
      targetWordsPerChapter: batch.target_words_per_chapter,
      chapterCount: batch.chapter_count,
      completedCount: batch.completed_count,
      currentOrdinal: batch.current_ordinal,
      usedLlmCalls: batch.used_llm_calls,
      usedInputTokens: batch.used_input_tokens,
      usedOutputTokens: batch.used_output_tokens,
      errorCode: batch.error_code,
    },
    item: item
      ? {
          ordinal: item.ordinal,
          status: item.status,
          chapterId: item.chapter_id,
          retryCount: item.retry_count,
          errorCode: item.error_code,
        }
      : null,
    run: run
      ? {
          id: run.id,
          state: run.state,
          stage: run.stage,
          targetPosition: run.target_position,
          completionReason: run.completion_reason,
          errorCode: run.error_code,
        }
      : null,
    stages,
    missing,
  };
}

const cells = matrixSpecs.map(projectCell);
const allReceipts = cells.flatMap(cell =>
  (cell.stages || []).flatMap(stage => stage.receipts || []),
);
const shadowVersions = [...new Set(allReceipts.map(r => r.governorShadow.version))];
const profileKeys = [...new Set(allReceipts.map(r => r.governorShadow.profileKey))];
const missingCells = cells.filter(cell => cell.status === 'missing' || cell.missing?.length);

const sensitiveKeyCounts = {
  apiKey: db
    .prepare(
      `SELECT COUNT(*) AS n FROM continuation_generation_stage_results
        WHERE lower(COALESCE(output_json, '')) LIKE '%api_key%'`,
    )
    .get().n,
  authorization: db
    .prepare(
      `SELECT COUNT(*) AS n FROM continuation_generation_stage_results
        WHERE lower(COALESCE(output_json, '')) LIKE '%authorization%'`,
    )
    .get().n,
  bearer: db
    .prepare(
      `SELECT COUNT(*) AS n FROM continuation_generation_stage_results
        WHERE lower(COALESCE(output_json, '')) LIKE '%bearer%'`,
    )
    .get().n,
};

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: 'stable-read-only-sqlite',
  governorContract: {
    version: 'writing-governor-shadow-v2',
    shadowOnly: true,
    recommendationNotSent: true,
    rawPromptOrBodyStoredInProjection: false,
  },
  dbIntegrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
  coverage: {
    expectedCells: 9,
    projectedCells: cells.length,
    complete: missingCells.length === 0,
    missingCells: missingCells.map(cell => ({
      targetChars: cell.targetChars,
      quality: cell.quality,
      sourcePrompt: cell.sourcePrompt,
      missing: cell.missing,
    })),
  },
  correctedShadowVersions: shadowVersions,
  distinctProfileKeys: profileKeys.length,
  sensitiveKeyCounts,
  cells,
  feedbackPair: {
    targetChars: 500,
    quality: 'quality',
    runs: ['C2_500_quality_feedback_c', 'C2_500_quality_feedback_d']
      .map(selectBatch)
      .filter(Boolean)
      .map(batch => ({
        id: batch.id,
        sourcePrompt: undefined,
        status: batch.status,
        usedLlmCalls: batch.used_llm_calls,
        usedInputTokens: batch.used_input_tokens,
        usedOutputTokens: batch.used_output_tokens,
      })),
  },
};

fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  outputPath,
  dbIntegrity: result.dbIntegrity,
  coverage: result.coverage,
  correctedShadowVersions: result.correctedShadowVersions,
  sensitiveKeyCounts: result.sensitiveKeyCounts,
}, null, 2));
db.close();
