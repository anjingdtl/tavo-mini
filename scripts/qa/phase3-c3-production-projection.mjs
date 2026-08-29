#!/usr/bin/env node
/**
 * Produce a safe read-only projection for a real Phase III-C Governor run.
 *
 * The source database contains prompts, plans, and generated artifacts. This
 * projection intentionally exposes only bounded batch/stage/receipt/shadow
 * metadata and aggregate Governor rows; it never prints or writes content,
 * prompts, response bodies, or credentials.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2];
const outputPath =
  process.argv[3] ||
  'test-logs/phase3-c-c3-android/c3-production-safe-projection.json';

if (!dbPath) {
  console.error(
    'Usage: node phase3-c3-production-projection.mjs <stable-sqlite> [output-json]',
  );
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });

const safeShadowFields = [
  'version',
  'policyVersion',
  'mode',
  'stage',
  'hydrated',
  'productionEnabled',
  'productionState',
  'productionReady',
  'profileKey',
  'coldStart',
  'learned',
  'profileSampleCount',
  'completeStopCount',
  'reasoningExactSampleCount',
  'counterfactualSafeCount',
  'counterfactualUnsafeCount',
  'bootstrapPriorVersion',
  'bootstrapPriorSource',
  'bootstrapPriorMatch',
  'bootstrapDemandRatio',
  'bootstrapPromptRatio',
  'bootstrapWeight',
  'localProfileWeight',
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

const safeProfileFields = [
  'profile_key',
  'policy_version',
  'sample_count',
  'known_result_count',
  'low_utilization_count',
  'length_signal_count',
  'recommended_scale',
  'average_completion_ratio',
  'average_latency_ms',
  'reasoning_sample_count',
  'reasoning_ratio_ewma',
  'reasoning_ratio_high_water',
  'reasoning_prompt_ratio_ewma',
  'reasoning_prompt_ratio_high_water',
  'last_finish_reason',
  'updated_at',
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
  for (const field of fields) result[field] = source?.[field] ?? null;
  return result;
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
    if (child && typeof child === 'object') findReceiptShadowPairs(child, result);
  }
  return result;
}

function projectReceipt(receipt, shadow) {
  const projected = projectFields(receipt, safeReceiptFields);
  projected.usage = projectFields(receipt?.usage, safeUsageFields);
  projected.timings = projectFields(receipt?.timings, safeTimingFields);
  projected.governorShadow = projectFields(shadow, safeShadowFields);
  projected.productionWireDelta =
    shadow?.legacyWireMax != null && receipt?.wireMaxTokens != null
      ? Number(shadow.legacyWireMax) - Number(receipt.wireMaxTokens)
      : null;
  return projected;
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

const schemaVersion = db
  .prepare('SELECT value FROM settings WHERE key = ?')
  .get('schema_version')?.value;
const latestBatch = db
  .prepare(
    `SELECT id, status, reasoning_effort, execution_profile,
            target_words_per_chapter, chapter_count, completed_count,
            current_ordinal, used_llm_calls, used_input_tokens,
            used_output_tokens, error_code, created_at, completed_at
       FROM multi_chapter_batches
      ORDER BY created_at DESC
      LIMIT 1`,
  )
  .get();
const latestRun = db
  .prepare(
    `SELECT id, state, stage, target_position, completion_reason,
            error_code, created_at, completed_at
       FROM continuation_generation_runs
      ORDER BY created_at DESC
      LIMIT 1`,
  )
  .get();
const stages = latestRun
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
      .all(latestRun.id)
      .map(projectStage)
  : [];
const profiles = db
  .prepare(
    `SELECT profile_key, policy_version, sample_count, known_result_count,
            low_utilization_count, length_signal_count, recommended_scale,
            average_completion_ratio, average_latency_ms,
            reasoning_sample_count, reasoning_ratio_ewma,
            reasoning_ratio_high_water, reasoning_prompt_ratio_ewma,
            reasoning_prompt_ratio_high_water, last_finish_reason, updated_at
       FROM writing_governor_profiles
      ORDER BY profile_key`,
  )
  .all()
  .map(row => projectFields(row, safeProfileFields));

const sensitiveTerms = ['api_key', 'authorization', 'bearer'];
const sensitiveKeyCounts = Object.fromEntries(
  sensitiveTerms.map(term => [
    term,
    Number(
      db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM continuation_generation_stage_results
            WHERE lower(COALESCE(output_json, ?)) LIKE ?`,
        )
        .get('', `%${term}%`).n,
    ),
  ]),
);

const allReceipts = stages.flatMap(stage =>
  stage.receipts.map(receipt => ({
    receipt,
    shadow: receipt.governorShadow,
  })),
);
const productionReceipts = allReceipts.filter(
  ({ shadow }) => shadow?.productionEnabled === true,
);
const hasDraftProduction = productionReceipts.some(
  ({ receipt }) => receipt.stage === 'draft',
);
const qaProductionReceipts = productionReceipts.filter(
  ({ receipt }) => receipt.stage === 'qa',
);
const hasQaProduction = qaProductionReceipts.length > 0;
const hasQaReadyProfile = qaProductionReceipts.some(
  ({ shadow }) => shadow?.productionReady === true,
);
const revisionProductionReceipts = productionReceipts.filter(
  ({ receipt }) => receipt.stage === 'revision',
);
const hasRevisionProduction = revisionProductionReceipts.length > 0;
const hasRevisionReadyProfile = revisionProductionReceipts.some(
  ({ shadow }) => shadow?.productionReady === true,
);
const productionStageParts = [];
if (hasDraftProduction) productionStageParts.push('draft');
if (hasQaProduction) {
  productionStageParts.push(
    `qa${hasQaReadyProfile ? '' : '-exact-safe-warm-start'}`,
  );
}
if (hasRevisionProduction) {
  productionStageParts.push(
    `revision${hasRevisionReadyProfile ? '' : '-exact-safe-warm-start'}`,
  );
}
const productionStage =
  productionStageParts.length === 1 && hasDraftProduction
    ? 'draft-only'
    : productionStageParts.join('+') || 'none';
const projection = {
  schemaVersion: schemaVersion == null ? null : Number(schemaVersion),
  generatedAt: new Date().toISOString(),
  source: 'stable-read-only-sqlite',
  dbIntegrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
  governorContract: {
    version: 'writing-governor-production-v3',
    productionStage,
    rawPromptOrBodyStoredInProjection: false,
  },
  latestBatch: latestBatch
    ? {
        id: latestBatch.id,
        status: latestBatch.status,
        reasoningEffort: latestBatch.reasoning_effort,
        executionProfile: latestBatch.execution_profile,
        targetWordsPerChapter: latestBatch.target_words_per_chapter,
        chapterCount: latestBatch.chapter_count,
        completedCount: latestBatch.completed_count,
        currentOrdinal: latestBatch.current_ordinal,
        usedLlmCalls: latestBatch.used_llm_calls,
        usedInputTokens: latestBatch.used_input_tokens,
        usedOutputTokens: latestBatch.used_output_tokens,
        errorCode: latestBatch.error_code,
      }
    : null,
  latestRun: latestRun
    ? {
        id: latestRun.id,
        state: latestRun.state,
        stage: latestRun.stage,
        targetPosition: latestRun.target_position,
        completionReason: latestRun.completion_reason,
        errorCode: latestRun.error_code,
      }
    : null,
  stages,
  productionWire: allReceipts.map(({ receipt, shadow }) => ({
    stage: receipt.stage,
    legacyWireMax: shadow.legacyWireMax,
    wireMaxTokens: receipt.wireMaxTokens,
    recommendedWireMax: shadow.recommendedWireMax,
    productionWireDelta: receipt.productionWireDelta,
    physicalRequestCount: receipt.physicalRequestCount,
    finishReason: receipt.finishReason,
    outcome: receipt.outcome,
  })),
  governorProfiles: profiles,
  sensitiveKeyCounts,
};

fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(projection, null, 2)}\n`, 'utf8');
console.log(
  JSON.stringify(
    {
      outputPath,
      schemaVersion: projection.schemaVersion,
      dbIntegrity: projection.dbIntegrity,
      latestBatch: projection.latestBatch,
      latestRun: projection.latestRun,
      stageCount: projection.stages.length,
      receiptCount: allReceipts.length,
      profileCount: profiles.length,
      sensitiveKeyCounts,
    },
    null,
    2,
  ),
);
db.close();
