#!/usr/bin/env node

/**
 * Read-only batch evidence collector for literary-quality proxies and
 * pipeline stability.
 *
 * This is deliberately an evidence-layer tool, not a product data migration:
 * it reads an existing SQLite snapshot and writes only scalar metadata. It
 * never emits prompts, source plans, titles, synopsis text, chapter bodies,
 * reasoning content, response bodies, API keys, or error messages.
 *
 * Literary quality is represented by deterministic text-shape evidence plus
 * nullable annotation slots. The deterministic values are proxies, not a
 * subjective literary score. A later human or evaluator pass can fill the
 * annotation slots without changing the batch/stability key.
 *
 * Usage:
 *   node scripts/qa/collect-writing-quality-matrix.mjs \
 *     --input <label=database.sqlite> [--input <label=database.sqlite> ...] \
 *     [--batch-id <label=batchId>] \
 *     --out <matrix.json>
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = 'shinewriter.writing-quality-stability-matrix.v1';
const BODY_POLICY =
  'metadata-only: no prompts, plans, synopsis, titles, chapter bodies, reasoning content, response bodies, API keys, or error messages';

const TERMINAL_PUNCTUATION = new Set(['。', '！', '？', '.', '!', '?', '…']);
const EMOTIONAL_TERMINAL = new Set(['！', '？', '!', '?']);
const QUOTE_OPEN = new Set(['“', '「', '『', '"']);
const QUOTE_CLOSE = new Set(['”', '」', '』', '"']);
const TRANSITION_CUES = [
  '随后',
  '不久',
  '第二天',
  '几天后',
  '数日后',
  '一夜过去',
  '这时',
  '此时',
  '与此同时',
  '转眼',
  '后来',
  '翌日',
];
const PROTOCOL_LEAK_MARKERS = [
  '<think>',
  'schemaVersion',
  'sourceId',
  'sourceHash',
  'mustFix',
  'mustNotAdvance',
];

function usage(message = null) {
  if (message) console.error(message);
  console.error(
    'Usage: node scripts/qa/collect-writing-quality-matrix.mjs --input <label=database.sqlite> [--input <label=database.sqlite> ...] --out <matrix.json>',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const inputs = [];
  const batchIds = new Map();
  let outputPath = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      const spec = argv[++i];
      if (!spec) usage('Missing value for --input');
      const separator = spec.indexOf('=');
      if (separator <= 0 || separator === spec.length - 1) {
        usage(`Input must be label=database.sqlite: ${spec}`);
      }
      inputs.push({
        label: spec.slice(0, separator),
        databasePath: path.resolve(spec.slice(separator + 1)),
      });
    } else if (arg === '--out') {
      outputPath = argv[++i];
      if (!outputPath) usage('Missing value for --out');
    } else if (arg === '--batch-id') {
      const spec = argv[++i];
      if (!spec) usage('Missing value for --batch-id');
      const separator = spec.indexOf('=');
      if (separator <= 0 || separator === spec.length - 1) {
        usage(`Batch selector must be label=batchId: ${spec}`);
      }
      batchIds.set(spec.slice(0, separator), spec.slice(separator + 1));
    } else {
      usage(`Unknown argument: ${arg}`);
    }
  }
  if (inputs.length === 0) usage('At least one --input is required');
  if (!outputPath) usage('An --out path is required');
  return {
    inputs: inputs.map(input => ({
      ...input,
      batchId: batchIds.get(input.label) || null,
    })),
    outputPath: path.resolve(outputPath),
  };
}

function parseJson(value, fallback = null) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstDefined(...values) {
  return values.find(value => value !== null && value !== undefined);
}

function firstNumber(...values) {
  for (const value of values) {
    const number = asNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function unique(values) {
  return [
    ...new Set(
      values.filter(
        value => value !== null && value !== undefined && value !== '',
      ),
    ),
  ];
}

function countValues(values) {
  const counts = {};
  for (const value of values) {
    const key =
      value === null || value === undefined || value === ''
        ? 'unknown'
        : String(value);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function quantile(sorted, ratio) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  return sorted[
    Math.min(sorted.length - 1, Math.floor(ratio * (sorted.length - 1)))
  ];
}

function distribution(values) {
  const sorted = values
    .map(asNumber)
    .filter(value => value !== null)
    .sort((left, right) => left - right);
  if (sorted.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      median: null,
      p95: null,
    };
  }
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: round(mean),
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
  };
}

function splitParagraphs(text) {
  return text
    .split(/\r?\n+/u)
    .map(value => value.trim())
    .filter(Boolean);
}

function splitSentences(text) {
  const sentences = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    if (!TERMINAL_PUNCTUATION.has(text[index])) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < text.length && TERMINAL_PUNCTUATION.has(text[end])) end += 1;
    const sentence = text.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
    index = end;
  }
  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

function countRepeated(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.values()]
    .filter(count => count > 1)
    .reduce((sum, count) => sum + count - 1, 0);
}

function countDuplicateGroups(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.values()].filter(count => count > 1).length;
}

function dialogueMetrics(text, paragraphs) {
  let inQuote = false;
  let quoteStart = -1;
  let quotedChars = 0;
  let quotePairs = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (QUOTE_OPEN.has(character) && !inQuote) {
      inQuote = true;
      quoteStart = index;
    } else if (QUOTE_CLOSE.has(character) && inQuote) {
      inQuote = false;
      if (quoteStart >= 0) {
        quotedChars += index - quoteStart + 1;
        quotePairs += 1;
      }
      quoteStart = -1;
    }
  }

  const dialogueParagraphs = paragraphs.filter(paragraph =>
    [...QUOTE_OPEN, ...QUOTE_CLOSE].some(quote => paragraph.includes(quote)),
  ).length;

  return {
    ratio: text.length === 0 ? 0 : round(quotedChars / text.length),
    quotedChars,
    quotePairs,
    dialogueParagraphs,
  };
}

function endingKind(text) {
  const trimmed = text.trimEnd();
  if (!trimmed) return 'empty';
  if (
    trimmed.endsWith('…') ||
    trimmed.endsWith('……') ||
    trimmed.endsWith('...')
  ) {
    return 'ellipsis';
  }
  if (trimmed.endsWith('？') || trimmed.endsWith('?')) return 'question';
  if (trimmed.endsWith('！') || trimmed.endsWith('!')) return 'exclamation';
  if (trimmed.endsWith('。') || trimmed.endsWith('.')) return 'closed';
  return 'non_terminal';
}

function countTerminalPunctuation(text) {
  const counts = {};
  for (const character of text) {
    if (TERMINAL_PUNCTUATION.has(character)) {
      counts[character] = (counts[character] || 0) + 1;
    }
  }
  return counts;
}

function countTransitionCues(paragraphs) {
  return paragraphs.reduce(
    (count, paragraph) =>
      count + TRANSITION_CUES.filter(cue => paragraph.startsWith(cue)).length,
    0,
  );
}

/**
 * Objective, body-free literary-quality proxy metrics. Lengths intentionally
 * use UTF-16 code units to match the existing style-statistics contract.
 */
function measureLiteraryQuality(content) {
  const text = asText(content);
  const paragraphs = splitParagraphs(text);
  const sentences = splitSentences(text);
  const normalizedSentences = sentences
    .map(sentence => sentence.replace(/\s+/gu, '').trim())
    .filter(Boolean);
  const normalizedParagraphs = paragraphs
    .map(paragraph => paragraph.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  const terminalCounts = countTerminalPunctuation(text);
  const emotionalTerminalCount = [...EMOTIONAL_TERMINAL].reduce(
    (sum, mark) => sum + (terminalCounts[mark] || 0),
    0,
  );
  const terminalCount = Object.values(terminalCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  const dialogue = dialogueMetrics(text, paragraphs);
  const sentenceLengths = sentences.map(sentence => sentence.length);
  const paragraphLengths = paragraphs.map(paragraph => paragraph.length);
  const duplicateSentenceCount = countRepeated(normalizedSentences);
  const duplicateParagraphCount = countDuplicateGroups(normalizedParagraphs);
  let adjacentRepeatedSentenceCount = 0;
  for (let index = 1; index < normalizedSentences.length; index += 1) {
    if (normalizedSentences[index] === normalizedSentences[index - 1]) {
      adjacentRepeatedSentenceCount += 1;
    }
  }
  const protocolLeakMarkers = PROTOCOL_LEAK_MARKERS.filter(marker =>
    text.includes(marker),
  );

  return {
    measurementStatus: text.trim()
      ? 'deterministic_proxy_collected'
      : 'missing_content',
    method: [
      'utf16_text_length',
      'cjk_sentence_shape',
      'paragraph_shape',
      'dialogue_quote_ratio',
      'repetition_signals',
      'terminal_punctuation_shape',
      'chapter_boundary_signals',
    ],
    bodyChars: text.length,
    bodyCharsNoWhitespace: text.replace(/\s+/gu, '').length,
    paragraphCount: paragraphs.length,
    sentenceCount: sentences.length,
    sentenceLength: distribution(sentenceLengths),
    paragraphLength: distribution(paragraphLengths),
    dialogue,
    repetition: {
      uniqueSentenceRatio:
        normalizedSentences.length === 0
          ? null
          : round(
              new Set(normalizedSentences).size / normalizedSentences.length,
            ),
      duplicateSentenceCount,
      adjacentRepeatedSentenceCount,
      duplicateParagraphGroupCount: duplicateParagraphCount,
    },
    punctuation: {
      terminalCounts,
      terminalDiversity: Object.keys(terminalCounts).length,
      emotionalTerminalRatio:
        terminalCount === 0
          ? null
          : round(emotionalTerminalCount / terminalCount),
    },
    chapterBoundary: {
      endingKind: endingKind(text),
      transitionCueCount: countTransitionCues(paragraphs),
      startsWithProtocol:
        /^\s*(?:```|\{\s*["']?(?:schemaVersion|sourceId)|<think>)/iu.test(text),
      protocolLeakMarkers,
    },
    // Deliberately nullable: no subjective literary score is invented here.
    literaryQualityAnnotation: {
      status: 'not_collected',
      source: null,
      rubricVersion: null,
      overall: null,
      dimensions: {
        proseNaturalness: null,
        sceneCoherence: null,
        causalContinuity: null,
        characterConsistency: null,
        styleFit: null,
        endingEffectiveness: null,
      },
    },
  };
}

function aggregateQuality(measurements) {
  const available = measurements.filter(
    measurement =>
      measurement.measurementStatus === 'deterministic_proxy_collected',
  );
  const mean = values => {
    const numeric = values.filter(
      value => typeof value === 'number' && Number.isFinite(value),
    );
    return numeric.length === 0
      ? null
      : round(numeric.reduce((sum, value) => sum + value, 0) / numeric.length);
  };
  const quality = {
    measurementMethod: 'deterministic_proxy_only; no subjective score',
    expectedChapterCount: measurements.length,
    chapterCountWithContent: available.length,
    contentAvailabilityRate:
      measurements.length === 0
        ? null
        : round(available.length / measurements.length),
    bodyChars: distribution(
      available.map(measurement => measurement.bodyChars),
    ),
    bodyCharsNoWhitespace: distribution(
      available.map(measurement => measurement.bodyCharsNoWhitespace),
    ),
    paragraphCount: distribution(
      available.map(measurement => measurement.paragraphCount),
    ),
    sentenceCount: distribution(
      available.map(measurement => measurement.sentenceCount),
    ),
    sentenceLengthMean: mean(
      available
        .map(measurement => measurement.sentenceLength.mean)
        .filter(value => value !== null),
    ),
    paragraphLengthMean: mean(
      available
        .map(measurement => measurement.paragraphLength.mean)
        .filter(value => value !== null),
    ),
    dialogueRatioMean: mean(
      available.map(measurement => measurement.dialogue.ratio),
    ),
    uniqueSentenceRatioMean: mean(
      available
        .map(measurement => measurement.repetition.uniqueSentenceRatio)
        .filter(value => value !== null),
    ),
    duplicateSentenceCountTotal: available.reduce(
      (sum, measurement) => sum + measurement.repetition.duplicateSentenceCount,
      0,
    ),
    adjacentRepeatedSentenceCountTotal: available.reduce(
      (sum, measurement) =>
        sum + measurement.repetition.adjacentRepeatedSentenceCount,
      0,
    ),
    terminalDiversityMean: mean(
      available.map(measurement => measurement.punctuation.terminalDiversity),
    ),
    endingKindCounts: countValues(
      available.map(measurement => measurement.chapterBoundary.endingKind),
    ),
    protocolLeakChapterCount: available.filter(
      measurement => measurement.chapterBoundary.protocolLeakMarkers.length > 0,
    ).length,
    humanOrEvaluatorAnnotation: {
      status: 'not_collected',
      score: null,
      dimensions: {
        proseNaturalness: null,
        sceneCoherence: null,
        causalContinuity: null,
        characterConsistency: null,
        styleFit: null,
        endingEffectiveness: null,
      },
    },
  };
  return quality;
}

function normalizeThinking(value) {
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (normalized === 'enabled' || normalized === 'disabled')
      return normalized;
  }
  if (value && typeof value === 'object') return normalizeThinking(value.type);
  return 'unknown';
}

function extractReceipts(frozenRequestJson) {
  const parsed = parseJson(frozenRequestJson);
  if (Array.isArray(parsed))
    return parsed.filter(value => value && typeof value === 'object');
  if (parsed && Array.isArray(parsed.receipts)) {
    return parsed.receipts.filter(value => value && typeof value === 'object');
  }
  return [];
}

function extractRuntimeObservation(validationDetailsJson) {
  const parsed = parseJson(validationDetailsJson);
  if (!parsed || typeof parsed !== 'object') return {};
  return Array.isArray(parsed.runtimeObservability)
    ? parsed.runtimeObservability[0] || {}
    : {};
}

function normalizeAttempt(row, ordinal) {
  const receipts = extractReceipts(row.frozen_request_json);
  const receipt = receipts[receipts.length - 1] || {};
  const observation = extractRuntimeObservation(row.validation_details_json);
  const governorShadow =
    receipt.governorShadow && typeof receipt.governorShadow === 'object'
      ? receipt.governorShadow
      : observation.governorShadow &&
        typeof observation.governorShadow === 'object'
      ? observation.governorShadow
      : {};
  const usage =
    receipt.usage && typeof receipt.usage === 'object'
      ? receipt.usage
      : observation.usage && typeof observation.usage === 'object'
      ? observation.usage
      : {};
  const timings =
    receipt.timings && typeof receipt.timings === 'object'
      ? receipt.timings
      : observation.timings && typeof observation.timings === 'object'
      ? observation.timings
      : {};
  const durationMs = firstNumber(
    timings.totalMs,
    row.completed_at !== null && row.started_at !== null
      ? Number(row.completed_at) - Number(row.started_at)
      : null,
  );

  return {
    ordinal,
    stage: row.stage,
    attemptNo: asNumber(row.attempt_no),
    status: row.status || 'unknown',
    failureClass: row.failure_class || null,
    errorCode: row.error_code || null,
    inputTokens: firstNumber(row.input_tokens, usage.inputTokens),
    outputTokens: firstNumber(row.output_tokens, usage.outputTokens),
    totalTokens: firstNumber(row.total_tokens, usage.totalTokens),
    reasoningTokens: firstNumber(row.reasoning_tokens, usage.reasoningTokens),
    visibleOutputTokens: firstNumber(
      row.visible_output_tokens,
      usage.visibleOutputTokens,
    ),
    finishReason:
      firstDefined(
        row.finish_reason,
        receipt.finishReason,
        observation.finishReason,
      ) || null,
    emptyReason:
      row.empty_reason ||
      receipt.emptyReason ||
      observation.emptyReason ||
      null,
    responseChannel: row.response_channel || receipt.responseChannel || null,
    formatterUsed: asNumber(row.formatter_used),
    durationMs,
    model:
      firstDefined(
        receipt.model,
        observation.model,
        governorShadow.modelName,
      ) || null,
    providerAdapterId:
      firstDefined(
        receipt.providerAdapterId,
        observation.providerAdapterId,
        governorShadow.providerAdapterId,
      ) || null,
    qualityProfile:
      firstDefined(
        receipt.qualityProfile,
        observation.qualityProfile,
        governorShadow.qualityProfile,
      ) || null,
    executionProfile:
      firstDefined(
        receipt.executionProfile,
        observation.executionProfile,
        governorShadow.executionProfile,
      ) || null,
    thinking: normalizeThinking(
      firstDefined(receipt.thinking, observation.thinking),
    ),
    reasoningEffort:
      firstDefined(
        receipt.reasoningEffort,
        observation.reasoningEffort,
        governorShadow.reasoningEffort,
      ) || null,
    responseFormat:
      firstDefined(receipt.responseFormat, observation.responseFormat) || null,
    configuredContextWindow: firstNumber(
      receipt.configuredContextWindow,
      observation.configuredContextWindow,
    ),
    completionCapability: firstNumber(
      receipt.completionCapability,
      observation.completionCapability,
    ),
    wireMaxTokens: firstNumber(
      receipt.wireMaxTokens,
      observation.wireMaxTokens,
    ),
    physicalRequestCount: firstNumber(
      receipt.physicalRequestCount,
      observation.physicalRequestCount,
    ),
    protocolFallbackCount: firstNumber(
      receipt.protocolFallbackCount,
      observation.protocolFallbackCount,
    ),
    receiptCount: receipts.length,
  };
}

function aggregateStability(batch, items, attempts) {
  const itemStatuses = items.map(item => item.status);
  const itemFullPipelineCount = items.filter(
    item => item.completion_quality === 'full_pipeline',
  ).length;
  const itemFirstPassCount = items.filter(
    item => item.status === 'succeeded' && item.retry_count === 0,
  ).length;
  const physicalRequests = attempts
    .map(attempt => attempt.physicalRequestCount)
    .filter(value => value !== null);
  const protocolFallbacks = attempts
    .map(attempt => attempt.protocolFallbackCount)
    .filter(value => value !== null);
  const formatterCalls = attempts.filter(
    attempt => attempt.formatterUsed > 0,
  ).length;
  const retryCountByAttempts = attempts.reduce(
    (sum, attempt) => sum + Math.max(0, (attempt.attemptNo || 1) - 1),
    0,
  );
  const attemptInputTokens = sumNullable(
    attempts.map(attempt => attempt.inputTokens),
  );
  const attemptOutputTokens = sumNullable(
    attempts.map(attempt => attempt.outputTokens),
  );
  const attemptReasoningTokens = sumNullable(
    attempts.map(attempt => attempt.reasoningTokens),
  );
  const attemptVisibleOutputTokens = sumNullable(
    attempts.map(attempt => attempt.visibleOutputTokens),
  );

  return {
    batchStatus: batch.status,
    expectedChapterCount: asNumber(batch.chapter_count),
    observedItemCount: items.length,
    itemStatusCounts: countValues(itemStatuses),
    fullPipelineCount: itemFullPipelineCount,
    firstPassSuccessCount: itemFirstPassCount,
    firstPassSuccessRate:
      items.length === 0 ? null : round(itemFirstPassCount / items.length),
    failedCount: items.filter(item => item.status === 'failed').length,
    outcomeUnknownCount: items.filter(item => item.status === 'outcome_unknown')
      .length,
    pendingCount: items.filter(item => item.status === 'pending').length,
    retryCountFromItems: items.reduce(
      (sum, item) => sum + (asNumber(item.retry_count) || 0),
      0,
    ),
    retryCountFromAttempts: retryCountByAttempts,
    stageAttemptCount: attempts.length,
    succeededStageAttemptCount: attempts.filter(
      attempt => attempt.status === 'succeeded',
    ).length,
    failedStageAttemptCount: attempts.filter(
      attempt => attempt.status === 'failed',
    ).length,
    physicalRequestCount:
      physicalRequests.length === 0
        ? null
        : physicalRequests.reduce((sum, value) => sum + value, 0),
    protocolFallbackCount:
      protocolFallbacks.length === 0
        ? null
        : protocolFallbacks.reduce((sum, value) => sum + value, 0),
    formatterCallCount: formatterCalls,
    finishReasonCounts: countValues(
      attempts.map(attempt => attempt.finishReason),
    ),
    emptyReasonCounts: countValues(
      attempts.map(attempt => attempt.emptyReason),
    ),
    responseChannelCounts: countValues(
      attempts.map(attempt => attempt.responseChannel),
    ),
    failureClassCounts: countValues(
      attempts.map(attempt => attempt.failureClass),
    ),
    errorCodeCounts: countValues(
      attempts.map(attempt => attempt.errorCode).filter(Boolean),
    ),
    stageLatencyMs: distribution(attempts.map(attempt => attempt.durationMs)),
    usage: {
      batchInputTokens: asNumber(batch.used_input_tokens),
      batchOutputTokens: asNumber(batch.used_output_tokens),
      batchLlmCalls: asNumber(batch.used_llm_calls),
      attemptInputTokens,
      attemptOutputTokens,
      attemptReasoningTokens,
      attemptVisibleOutputTokens,
      reasoningToOutputRatio:
        attemptOutputTokens && attemptReasoningTokens !== null
          ? round(attemptReasoningTokens / attemptOutputTokens)
          : null,
    },
    batchWallTimeMs:
      batch.started_at !== null && batch.completed_at !== null
        ? Number(batch.completed_at) - Number(batch.started_at)
        : null,
  };
}

function sumNullable(values) {
  const numeric = values.filter(
    value => value !== null && Number.isFinite(value),
  );
  return numeric.length === 0
    ? null
    : numeric.reduce((sum, value) => sum + value, 0);
}

function queryBatch(db, batchId = null) {
  if (batchId) {
    return db
      .prepare(
        `SELECT id, project_id, status, chapter_count, target_words_per_chapter,
                pipeline_mode, reasoning_effort, execution_profile, writing_mode,
                used_llm_calls, used_input_tokens, used_output_tokens,
                max_llm_calls, max_input_tokens, max_output_tokens,
                started_at, completed_at, created_at, updated_at, error_code
           FROM multi_chapter_batches
          WHERE id = ?`,
      )
      .get(batchId);
  }
  return db
    .prepare(
      `SELECT id, project_id, status, chapter_count, target_words_per_chapter,
              pipeline_mode, reasoning_effort, execution_profile, writing_mode,
              used_llm_calls, used_input_tokens, used_output_tokens,
              max_llm_calls, max_input_tokens, max_output_tokens,
              started_at, completed_at, created_at, updated_at, error_code
         FROM multi_chapter_batches
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get();
}

function readBatchReport(input) {
  if (!fs.existsSync(input.databasePath)) {
    throw new Error(`数据库不存在: ${input.databasePath}`);
  }

  const db = new DatabaseSync(input.databasePath, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const integrityStatus =
      integrity?.integrity_check || integrity?.[0] || null;
    const batch = queryBatch(db, input.batchId);
    if (!batch)
      throw new Error(
        `数据库没有 multi_chapter_batches: ${input.databasePath}`,
      );

    const items = db
      .prepare(
        `SELECT batch_id, ordinal, status, completion_quality, retry_count,
                chapter_id, active_pipeline_task_id, error_code
           FROM multi_chapter_batch_items
          WHERE batch_id = ?
          ORDER BY ordinal`,
      )
      .all(batch.id);

    const attempts = [];
    const itemReports = [];
    for (const item of items) {
      let task = item.active_pipeline_task_id
        ? db
            .prepare(
              'SELECT id, target_type, target_id, status FROM pipeline_tasks WHERE id = ?',
            )
            .get(item.active_pipeline_task_id)
        : null;
      if (!task && item.chapter_id !== null) {
        task = db
          .prepare(
            `SELECT id, target_type, target_id, status
               FROM pipeline_tasks
              WHERE target_type = 'chapter' AND target_id = ?
              ORDER BY created_at DESC
              LIMIT 1`,
          )
          .get(item.chapter_id);
      }

      const rawAttempts = task
        ? db
            .prepare(
              `SELECT stage, attempt_no, status, failure_class, error_code,
                      input_tokens, output_tokens, total_tokens, reasoning_tokens,
                      finish_reason, empty_reason, response_channel,
                      visible_output_tokens, formatter_used, started_at, completed_at,
                      frozen_request_json, validation_details_json
                 FROM pipeline_stage_attempts
                WHERE pipeline_task_id = ?
                ORDER BY stage, attempt_no`,
            )
            .all(task.id)
        : [];
      const normalizedAttempts = rawAttempts.map(row =>
        normalizeAttempt(row, item.ordinal),
      );
      attempts.push(...normalizedAttempts);

      const chapter =
        item.chapter_id === null
          ? null
          : db
              .prepare(
                'SELECT id, position, content FROM chapters WHERE id = ?',
              )
              .get(item.chapter_id);
      const quality = measureLiteraryQuality(chapter?.content || '');
      const itemInputTokens = sumNullable(
        normalizedAttempts.map(attempt => attempt.inputTokens),
      );
      const itemOutputTokens = sumNullable(
        normalizedAttempts.map(attempt => attempt.outputTokens),
      );
      const itemReasoningTokens = sumNullable(
        normalizedAttempts.map(attempt => attempt.reasoningTokens),
      );
      itemReports.push({
        ordinal: asNumber(item.ordinal),
        chapterId: item.chapter_id === null ? null : asNumber(item.chapter_id),
        status: item.status || 'unknown',
        completionQuality: item.completion_quality || null,
        retryCount: asNumber(item.retry_count),
        errorCode: item.error_code || null,
        taskStatus: task?.status || null,
        literaryQualityProxy: quality,
        stability: {
          stageAttemptCount: normalizedAttempts.length,
          succeededStageAttemptCount: normalizedAttempts.filter(
            attempt => attempt.status === 'succeeded',
          ).length,
          failedStageAttemptCount: normalizedAttempts.filter(
            attempt => attempt.status === 'failed',
          ).length,
          retryCount: normalizedAttempts.reduce(
            (sum, attempt) => sum + Math.max(0, (attempt.attemptNo || 1) - 1),
            0,
          ),
          physicalRequestCount: sumNullable(
            normalizedAttempts.map(attempt => attempt.physicalRequestCount),
          ),
          protocolFallbackCount: sumNullable(
            normalizedAttempts.map(attempt => attempt.protocolFallbackCount),
          ),
          latencyMs: sumNullable(
            normalizedAttempts.map(attempt => attempt.durationMs),
          ),
          inputTokens: itemInputTokens,
          outputTokens: itemOutputTokens,
          reasoningTokens: itemReasoningTokens,
          visibleOutputTokens: sumNullable(
            normalizedAttempts.map(attempt => attempt.visibleOutputTokens),
          ),
          reasoningToOutputRatio:
            itemOutputTokens && itemReasoningTokens !== null
              ? round(itemReasoningTokens / itemOutputTokens)
              : null,
          finishReasons: unique(
            normalizedAttempts.map(attempt => attempt.finishReason),
          ),
          emptyReasons: unique(
            normalizedAttempts.map(attempt => attempt.emptyReason),
          ),
          responseChannels: unique(
            normalizedAttempts.map(attempt => attempt.responseChannel),
          ),
          failureClasses: unique(
            normalizedAttempts.map(attempt => attempt.failureClass),
          ),
          errorCodes: unique(
            [
              item.error_code,
              ...normalizedAttempts.map(attempt => attempt.errorCode),
            ].filter(Boolean),
          ),
        },
      });
    }

    const quality = aggregateQuality(
      itemReports.map(item => item.literaryQualityProxy),
    );
    const stability = aggregateStability(batch, items, attempts);
    const modelValues = unique(attempts.map(attempt => attempt.model));
    const providerValues = unique(
      attempts.map(attempt => attempt.providerAdapterId),
    );
    const qualityProfileValues = unique(
      attempts.map(attempt => attempt.qualityProfile),
    );
    const executionProfileValues = unique([
      batch.execution_profile,
      ...attempts.map(attempt => attempt.executionProfile),
    ]);
    const thinkingValues = unique(attempts.map(attempt => attempt.thinking));
    const reasoningEffortValues = unique([
      batch.reasoning_effort,
      ...attempts.map(attempt => attempt.reasoningEffort),
    ]);
    const responseFormatValues = unique(
      attempts.map(attempt => attempt.responseFormat),
    );
    const contextWindowValues = unique(
      attempts
        .map(attempt => attempt.configuredContextWindow)
        .filter(value => value !== null),
    );
    const completionCapabilityValues = unique(
      attempts
        .map(attempt => attempt.completionCapability)
        .filter(value => value !== null),
    );
    const wireMaxValues = unique(
      attempts
        .map(attempt => attempt.wireMaxTokens)
        .filter(value => value !== null),
    );
    const physicalRequestValues = unique(
      attempts
        .map(attempt => attempt.physicalRequestCount)
        .filter(value => value !== null),
    );

    const conditionKey = [
      modelValues.join(','),
      `thinking=${thinkingValues.join(',') || 'unknown'}`,
      `effort=${reasoningEffortValues.join(',') || 'unknown'}`,
      `quality=${qualityProfileValues.join(',') || 'unknown'}`,
      `execution=${executionProfileValues.join(',') || 'unknown'}`,
    ].join('|');
    const correlationKey = `${batch.id}|${conditionKey}`;

    return {
      label: input.label,
      sourceArtifact: path.basename(input.databasePath),
      databaseIntegrity: integrityStatus,
      correlationKey,
      batch: {
        id: batch.id,
        projectId: asNumber(batch.project_id),
        status: batch.status,
        chapterCount: asNumber(batch.chapter_count),
        targetWordsPerChapter: asNumber(batch.target_words_per_chapter),
        pipelineMode: batch.pipeline_mode || null,
        writingMode: batch.writing_mode || null,
        reasoningEffort: batch.reasoning_effort || null,
        executionProfile: batch.execution_profile || null,
        createdAt: asNumber(batch.created_at),
        startedAt: asNumber(batch.started_at),
        completedAt: asNumber(batch.completed_at),
        errorCode: batch.error_code || null,
      },
      condition: {
        key: conditionKey,
        model: modelValues,
        providerAdapterId: providerValues,
        thinking: thinkingValues,
        reasoningEffort: reasoningEffortValues,
        qualityProfile: qualityProfileValues,
        executionProfile: executionProfileValues,
        responseFormat: responseFormatValues,
        configuredContextWindow: contextWindowValues,
        completionCapability: completionCapabilityValues,
        wireMaxTokens: wireMaxValues,
        physicalRequestValues,
        consistent: {
          model: modelValues.length <= 1,
          thinking:
            thinkingValues.length <= 1 && thinkingValues[0] === 'enabled',
          reasoningEffort: reasoningEffortValues.length <= 1,
          qualityProfile: qualityProfileValues.length <= 1,
          executionProfile: executionProfileValues.length <= 1,
        },
      },
      literaryQuality: quality,
      pipelineStability: stability,
      chapters: itemReports,
      observations: itemReports.map(item => ({
        batchId: batch.id,
        ordinal: item.ordinal,
        correlationKey,
        conditionKey,
        thinking: thinkingValues.length === 1 ? thinkingValues[0] : 'mixed',
        reasoningEffort:
          reasoningEffortValues.length === 1
            ? reasoningEffortValues[0]
            : 'mixed',
        qualityProfile:
          qualityProfileValues.length === 1 ? qualityProfileValues[0] : 'mixed',
        model: modelValues.length === 1 ? modelValues[0] : 'mixed',
        literaryQualityProxy: {
          measurementStatus: item.literaryQualityProxy.measurementStatus,
          bodyChars: item.literaryQualityProxy.bodyChars,
          paragraphCount: item.literaryQualityProxy.paragraphCount,
          sentenceCount: item.literaryQualityProxy.sentenceCount,
          dialogueRatio: item.literaryQualityProxy.dialogue.ratio,
          uniqueSentenceRatio:
            item.literaryQualityProxy.repetition.uniqueSentenceRatio,
          duplicateSentenceCount:
            item.literaryQualityProxy.repetition.duplicateSentenceCount,
          endingKind: item.literaryQualityProxy.chapterBoundary.endingKind,
          protocolLeak:
            item.literaryQualityProxy.chapterBoundary.protocolLeakMarkers
              .length > 0,
        },
        pipelineStability: item.stability,
        deliveryStatus: item.status,
        completionQuality: item.completionQuality,
      })),
    };
  } finally {
    db.close();
  }
}

const { inputs, outputPath } = parseArgs(process.argv.slice(2));
const reports = inputs.map(readBatchReport);
const matrix = {
  schema: SCHEMA,
  generatedAt: new Date().toISOString(),
  bodyPolicy: BODY_POLICY,
  interpretation: {
    literaryQuality:
      'deterministic proxies and nullable annotations; not an automatic literary score',
    pipelineStability: 'descriptive batch/attempt outcome evidence',
    correlationUnit:
      'one batch condition key shared by every chapter observation',
  },
  dimensions: [
    'thinking',
    'reasoningEffort',
    'qualityProfile',
    'executionProfile',
    'model',
    'literaryQualityProxy',
    'pipelineStability',
  ],
  batchCount: reports.length,
  batches: reports,
  observations: reports.flatMap(report => report.observations),
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
console.log(`writing quality matrix written: ${outputPath}`);
console.log(
  reports
    .map(
      report =>
        `${report.label}|${report.batch.id}|${report.batch.status}|chapters=${
          report.batch.chapterCount
        }|content=${report.literaryQuality.chapterCountWithContent}|firstPass=${
          report.pipelineStability.firstPassSuccessCount
        }/${report.pipelineStability.observedItemCount}|thinking=${
          report.condition.thinking.join(',') || 'unknown'
        }|effort=${report.condition.reasoningEffort.join(',') || 'unknown'}`,
    )
    .join('\n'),
);
