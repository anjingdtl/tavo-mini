#!/usr/bin/env node

/**
 * Phase III-C C1 long-horizon baseline collector.
 *
 * This is a read-only evidence tool. It never calls an LLM, mutates the
 * application database, or fills missing observations with zeros. The caller
 * must supply proof that the measured run used the emulator's existing real
 * LLM configuration; this tool only records that proof reference alongside
 * the DB-derived evidence.
 *
 * Usage:
 *   node scripts/qa/collect-phase3-c-baseline.js \
 *     --db <sqlite> --project-id <id> [--batch-id <id[,id...]>] \
 *     [--target-counts 5,20,50,100] --exact-head <sha> \
 *     --real-llm-proof <path[,path...]> --model <model> --out <report.json>
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Buffer } = require('node:buffer');

const BASELINE_SCHEMA = 'shinewriter.phase3-c.long-horizon-baseline.v1';
const DEFAULT_TARGET_COUNTS = [5, 20, 50, 100];
const REQUIRED_CHAPTER_FIELDS = [
  'chapterIndex',
  'generationTraceId',
  'qualityProfile',
  'writerPhysicalCalls',
  'totalPaidLlmCalls',
  'draftTokens',
  'qaTokens',
  'revisionTokens',
  'plannerCalls',
  'observerCalls',
  'storyMemoryCalls',
  'contextInputTokens',
  'finalCharCount',
  'storyMemorySize',
  'dbPayloadSize',
  'finalFingerprint',
  'finalBodyProposalFingerprint',
  'seamFingerprint',
  'canonBoundary',
  'stateProposalCount',
  'retryFallback',
  'latencyMs',
];

function parseJson(value, fallback = null) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number != null && number >= 0 ? number : null;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function bytes(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function finalCharCount(value) {
  return Array.from(String(value || ''))
    .filter(character => !/^\s$/u.test(character))
    .length;
}

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (value && typeof value === 'object' && value.status === 'not_observed') {
    return false;
  }
  return true;
}

function readTrace(context) {
  return (
    context?.draftContext?.writingKernelTrace ||
    context?.auditContext?.writingKernelTrace ||
    context?.writingKernelTrace ||
    context?.trace ||
    null
  );
}

function readFrozen(context, trace) {
  return (
    context?.draftContext?.frozenWritingContext ||
    context?.auditContext?.frozenWritingContext ||
    context?.frozenWritingContext ||
    trace?.frozenWritingContext ||
    null
  );
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function tokenRow(input, source) {
  const inputTokens = nonNegativeNumber(input?.input_tokens ?? input?.inputTokens);
  const outputTokens = nonNegativeNumber(input?.output_tokens ?? input?.outputTokens);
  const totalTokens = nonNegativeNumber(input?.total_tokens ?? input?.totalTokens);
  if (inputTokens == null && outputTokens == null && totalTokens == null) {
    return { input: null, output: null, total: null, source };
  }
  return {
    input: inputTokens ?? 0,
    output: outputTokens ?? 0,
    total: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    source,
  };
}

function sumTokenRows(rows, source) {
  if (!rows.length) return tokenRow(null, source);
  const inputValues = rows.map(row => nonNegativeNumber(row.input_tokens)).filter(value => value != null);
  const outputValues = rows.map(row => nonNegativeNumber(row.output_tokens)).filter(value => value != null);
  const totalValues = rows.map(row => nonNegativeNumber(row.total_tokens)).filter(value => value != null);
  const input = inputValues.length ? inputValues.reduce((sum, value) => sum + value, 0) : null;
  const output = outputValues.length ? outputValues.reduce((sum, value) => sum + value, 0) : null;
  const total = totalValues.length
    ? totalValues.reduce((sum, value) => sum + value, 0)
    : input != null && output != null
    ? input + output
    : null;
  if (input == null && output == null && total == null) return tokenRow(null, source);
  return { input, output, total, source };
}

function stageTokenEvidence(stage, checkpoints, observability) {
  const rows = checkpoints.filter(row => row.stage === stage);
  if (rows.length) return sumTokenRows(rows, 'pipeline_stage_checkpoints');
  const calls = Array.isArray(observability?.llm?.calls)
    ? observability.llm.calls.filter(row => row.stage === stage)
    : [];
  if (calls.length) {
    const input = calls.reduce((sum, row) => sum + (nonNegativeNumber(row.inputTokens) ?? 0), 0);
    const output = calls.reduce((sum, row) => sum + (nonNegativeNumber(row.outputTokens) ?? 0), 0);
    return { input, output, total: input + output, source: 'writing_observability' };
  }
  return tokenRow(null, 'not_observed');
}

function countPhysicalCalls(trace, observability) {
  const observed = nonNegativeNumber(observability?.llm?.physicalRequestCount);
  if (observed != null) return { value: observed, source: 'writing_observability' };
  const receipts = Array.isArray(trace?.requestReceipts) ? trace.requestReceipts : [];
  if (receipts.length) {
    const value = receipts.reduce(
      (sum, receipt) => sum + (nonNegativeNumber(receipt.physicalRequestCount) ?? 0),
      0,
    );
    return { value, source: 'writing_request_receipts' };
  }
  return { value: null, source: 'not_observed' };
}

function countFallbacks(trace, observability) {
  const observed = nonNegativeNumber(observability?.llm?.protocolFallbackCount);
  if (observed != null) return { value: observed, source: 'writing_observability' };
  const receipts = Array.isArray(trace?.requestReceipts) ? trace.requestReceipts : [];
  if (receipts.length) {
    return {
      value: receipts.reduce(
        (sum, receipt) => sum + (nonNegativeNumber(receipt.protocolFallbackCount) ?? 0),
        0,
      ),
      source: 'writing_request_receipts',
    };
  }
  return { value: null, source: 'not_observed' };
}

function countRetries(attempts) {
  const byStage = new Map();
  for (const attempt of attempts) {
    const number = nonNegativeNumber(attempt.attempt_no);
    if (number == null) continue;
    byStage.set(attempt.stage, Math.max(byStage.get(attempt.stage) || 0, number));
  }
  let retryCount = 0;
  for (const maxAttempt of byStage.values()) retryCount += Math.max(0, maxAttempt - 1);
  return retryCount;
}

function classifyUsageScenario(scenario) {
  const value = String(scenario || '').toLowerCase();
  if (value === 'batch_planner' || value.includes('planner')) return 'planner';
  if (value.includes('observer') || value.includes('observe')) return 'observer';
  if (value.includes('story_memory') || value.includes('memory') || value.includes('state_extraction')) {
    return 'story_memory';
  }
  if (value.startsWith('pipeline_')) return 'writer';
  return 'other';
}

function inTimeWindow(row, start, end) {
  const time = timestampMs(row.created_at);
  return time != null && start != null && end != null && time >= start && time <= end;
}

function missingFields(chapter) {
  return REQUIRED_CHAPTER_FIELDS.filter(field => !hasValue(chapter[field]));
}

function buildMatrix(chapters, targetCounts) {
  return targetCounts.map(targetChapterCount => {
    const targetIndices = Array.from({ length: targetChapterCount }, (_, index) => index + 1);
    const selected = chapters
      .filter(chapter => Number(chapter.chapterIndex) <= targetChapterCount)
      .sort((left, right) => Number(left.chapterIndex) - Number(right.chapterIndex));
    const byIndex = new Map(selected.map(chapter => [Number(chapter.chapterIndex), chapter]));
    const missingChapterIndices = targetIndices.filter(index => !byIndex.has(index));
    const selectedChapters = targetIndices.map(index => byIndex.get(index)).filter(Boolean);
    const missingEvidenceByChapter = selectedChapters
      .map(chapter => ({ chapterIndex: chapter.chapterIndex, missing: chapter.evidence?.missing || missingFields(chapter) }))
      .filter(item => item.missing.length > 0);
    const completedChapterCount = selectedChapters.filter(chapter => chapter.status === 'completed').length;
    const status =
      missingChapterIndices.length === 0 &&
      completedChapterCount === targetChapterCount &&
      missingEvidenceByChapter.length === 0
        ? 'PASS'
        : 'NO-GO';
    return {
      targetChapterCount,
      observedChapterCount: selected.length,
      completedChapterCount,
      missingChapterIndices,
      missingEvidenceByChapter,
      chapterIndices: selected.map(chapter => chapter.chapterIndex),
      status,
    };
  });
}

function buildLongHorizonBaselineReport(input) {
  const targetCounts = [...(input.targetCounts || DEFAULT_TARGET_COUNTS)]
    .map(Number)
    .filter(value => Number.isInteger(value) && value > 0);
  const chapters = (input.chapters || []).map(chapter => ({
    ...chapter,
    evidence: {
      source: chapter.evidence?.source || 'device-db',
      missing: chapter.evidence?.missing || missingFields(chapter),
    },
  }));
  const matrix = buildMatrix(chapters, targetCounts);
  const realLlmEvidence = input.realLlmEvidence || {
    mode: 'android-existing-config',
    modelName: null,
    proof: [],
  };
  const realEvidenceReady =
    realLlmEvidence.mode === 'android-existing-config' &&
    Boolean(String(realLlmEvidence.modelName || '').trim()) &&
    Array.isArray(realLlmEvidence.proof) &&
    realLlmEvidence.proof.length > 0;
  return {
    schema: BASELINE_SCHEMA,
    capturedAt: input.capturedAt || new Date().toISOString(),
    exactHead: input.exactHead || null,
    project: input.project || null,
    database: input.database || null,
    realLlmEvidence: {
      required: true,
      mode: realLlmEvidence.mode || null,
      modelName: realLlmEvidence.modelName || null,
      proof: [...(realLlmEvidence.proof || [])],
    },
    batches: input.batches || [],
    targetCounts,
    chapterFieldContract: [...REQUIRED_CHAPTER_FIELDS],
    chapters,
    matrix,
    decision: realEvidenceReady && matrix.every(item => item.status === 'PASS') ? 'PASS' : 'NO-GO',
    decisionNote:
      'PASS 仅表示四个目标规模的 DB/Receipt/Final Artifact 证据齐全且真实 LLM 证明已引用；连续性语义检查仍须由 reviewer 按 continuousChecks 人工复核。',
  };
}

function validateLongHorizonBaselineReport(report) {
  const errors = [];
  if (!report || report.schema !== BASELINE_SCHEMA) errors.push('schema_invalid');
  if (!report?.realLlmEvidence?.required) errors.push('real_llm_evidence_not_required');
  if (report?.realLlmEvidence?.mode !== 'android-existing-config') errors.push('real_llm_evidence_mode_invalid');
  if (!String(report?.realLlmEvidence?.modelName || '').trim()) errors.push('real_llm_model_missing');
  if (!Array.isArray(report?.realLlmEvidence?.proof) || report.realLlmEvidence.proof.length === 0) {
    errors.push('real_llm_proof_missing');
  }
  const targets = JSON.stringify(report?.targetCounts || []);
  if (targets !== JSON.stringify(DEFAULT_TARGET_COUNTS)) errors.push('target_matrix_invalid');
  for (const chapter of report?.chapters || []) {
    for (const field of REQUIRED_CHAPTER_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(chapter, field)) {
        errors.push(`chapter_${chapter.chapterIndex || 'unknown'}_${field}_missing`);
      } else if (!hasValue(chapter[field])) {
        errors.push(`chapter_${chapter.chapterIndex || 'unknown'}_${field}_not_observed`);
      }
    }
  }
  for (const matrix of report?.matrix || []) {
    if (matrix.status !== 'PASS') errors.push(`matrix_${matrix.targetChapterCount}_not_pass`);
  }
  return { ok: errors.length === 0, errors };
}

function getDatabaseInfo(db, databasePath) {
  const pageCount = db.prepare('PRAGMA page_count').get()?.page_count ?? null;
  const pageSize = db.prepare('PRAGMA page_size').get()?.page_size ?? null;
  const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check ?? null;
  return {
    path: databasePath,
    bytes: fs.statSync(databasePath).size,
    pageCount: finiteNumber(pageCount),
    pageSize: finiteNumber(pageSize),
    integrityCheck: integrity,
  };
}

function tableExists(db, table) {
  return Boolean(
    db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(table),
  );
}

function readStateProposals(db, projectId, chapterId) {
  if (!tableExists(db, 'continuation_state_proposals')) {
    return { count: null, latestProposalFingerprint: null, finalBodyProposalFingerprint: null, status: 'not_observed' };
  }
  const rows = db
    .prepare(
      `SELECT proposal_fingerprint, chapter_revision_hash, extraction_content_hash
         FROM continuation_state_proposals
        WHERE project_id = ? AND chapter_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(projectId, chapterId);
  const latest = rows[rows.length - 1] || null;
  return {
    count: rows.length,
    latestProposalFingerprint: readString(latest?.proposal_fingerprint),
    finalBodyProposalFingerprint: readString(latest?.chapter_revision_hash),
    extractionContentHash: readString(latest?.extraction_content_hash),
    status: 'observed',
  };
}

function readCanonBoundary(db, projectId) {
  if (!tableExists(db, 'continuation_settings')) {
    return { status: 'not_applicable', reason: 'continuation_settings_absent' };
  }
  const row = db
    .prepare(
      `SELECT active_source_id, boundary_source_id, boundary_chapter_id,
              boundary_char_offset_global, boundary_mode, analysis_status
         FROM continuation_settings WHERE project_id = ?`,
    )
    .get(projectId);
  if (!row) return { status: 'not_applicable', reason: 'no_continuation_settings' };
  return {
    status: row.boundary_source_id || row.active_source_id ? 'configured' : 'not_applicable',
    activeSourceId: row.active_source_id ?? null,
    boundarySourceId: row.boundary_source_id ?? null,
    boundaryChapterId: row.boundary_chapter_id ?? null,
    boundaryCharOffsetGlobal: row.boundary_char_offset_global ?? null,
    boundaryMode: row.boundary_mode ?? null,
    analysisStatus: row.analysis_status ?? null,
  };
}

function buildContinuousChecks({ truth, frozen, memory, canonBoundary, finalBodyProposalFingerprint }) {
  const hasCanon = Boolean(truth?.canonSnapshotFingerprint || canonBoundary?.status === 'configured');
  const hasBoundary = Boolean(truth?.sourceBoundaryFingerprint || canonBoundary?.status === 'configured');
  const hasSeam = Boolean(truth?.seamFingerprint);
  const hasStyle = Boolean(truth?.writerStyleFingerprint || frozen?.stagePolicy?.values?.qualityProfile);
  const memoryThrough = finiteNumber(memory?.through_chapter_position);
  return {
    canonHardConflict: hasCanon ? 'manual_review_required' : 'not_applicable',
    sourceBoundary: hasBoundary ? 'manual_review_required' : 'not_applicable',
    futureLeakage: 'manual_review_required',
    seam: hasSeam ? 'evidence_present_manual_review' : 'not_observed',
    knowledgeState: 'manual_review_required',
    positionLifeRelations: 'manual_review_required',
    worldRules: hasCanon ? 'manual_review_required' : 'not_applicable',
    timeline: hasCanon ? 'manual_review_required' : 'not_applicable',
    writerStyle: hasStyle ? 'evidence_present_manual_review' : 'not_observed',
    storyMemoryThroughPosition: memoryThrough != null ? memoryThrough : 'not_observed',
    finalBodyProposalFingerprint:
      finalBodyProposalFingerprint && typeof finalBodyProposalFingerprint === 'string'
        ? 'evidence_present_manual_review'
        : 'not_applicable',
  };
}

function readChapterEvidence({ db, item, batch, usageRows, memoryRow, canonBoundary }) {
  const chapter = item.chapter_id == null
    ? null
    : db
        .prepare(
          `SELECT id, project_id, position, title, status, content, updated_at
             FROM chapters WHERE id = ? AND project_id = ?`,
        )
        .get(item.chapter_id, batch.project_id);
  const task = item.active_pipeline_task_id
    ? db
        .prepare(
          `SELECT id, target_type, target_id, status, final_text,
                  pipeline_context_json, stage_results, created_at, updated_at
             FROM pipeline_tasks WHERE id = ?`,
        )
        .get(item.active_pipeline_task_id)
    : null;
  const context = parseJson(task?.pipeline_context_json, null);
  const trace = readTrace(context);
  const frozen = readFrozen(context, trace);
  const observability = trace?.observability || null;
  const checkpoints = task
    ? db
        .prepare(
          `SELECT stage, status, input_tokens, output_tokens, total_tokens,
                  duration_ms, attempt_count, started_at, completed_at,
                  length(output_text) AS output_length
             FROM pipeline_stage_checkpoints WHERE task_id = ? ORDER BY stage`,
        )
        .all(task.id)
    : [];
  const attempts = task
    ? db
        .prepare(
          `SELECT stage, attempt_no, status, input_tokens, output_tokens,
                  total_tokens, finish_reason, started_at, completed_at
             FROM pipeline_stage_attempts WHERE pipeline_task_id = ? ORDER BY started_at, id`,
        )
        .all(task.id)
    : [];
  const body = chapter?.content == null ? '' : String(chapter.content);
  const bodyFingerprint = body ? sha256(body) : null;
  const finalSummary = trace?.finalArtifactSummary;
  const finalBodyEvent = trace?.writingPersistedEvent;
  const physical = countPhysicalCalls(trace, observability);
  const fallback = countFallbacks(trace, observability);
  const stageTokens = {
    draft: stageTokenEvidence('draft', checkpoints, observability),
    qa: stageTokenEvidence('qa', checkpoints, observability),
    revision: stageTokenEvidence('revision', checkpoints, observability),
  };
  const start = timestampMs(item.created_at) ?? timestampMs(task?.created_at);
  const end = timestampMs(item.completed_at) ?? timestampMs(task?.updated_at) ?? timestampMs(batch.updated_at);
  const itemUsage = usageRows.filter(row => inTimeWindow(row, start, end));
  const itemUsageKinds = itemUsage.map(row => ({ row, kind: classifyUsageScenario(row.scenario) }));
  const directAuxiliaryCalls = itemUsageKinds.filter(entry => entry.kind !== 'writer' && entry.kind !== 'planner').length;
  const observerCalls = itemUsageKinds.filter(entry => entry.kind === 'observer').length;
  const storyMemoryCalls = itemUsageKinds.filter(entry => entry.kind === 'story_memory').length;
  const plannerRows = usageRows.filter(row => {
    if (classifyUsageScenario(row.scenario) !== 'planner') return false;
    const time = timestampMs(row.created_at);
    const batchStart = timestampMs(batch.started_at) ?? timestampMs(batch.created_at);
    const batchEnd = timestampMs(batch.completed_at) ?? timestampMs(batch.updated_at);
    return time != null && batchStart != null && batchEnd != null && time >= batchStart && time <= batchEnd;
  });
  const isFirstItem = item.isFirstItem === true;
  const plannerCalls = isFirstItem ? plannerRows.length : 0;
  const totalPaid = physical.value == null ? null : physical.value + directAuxiliaryCalls + plannerCalls;
  const contextInputTokens =
    nonNegativeNumber(observability?.context?.stageProjectedContextTokens) ??
    nonNegativeNumber(observability?.context?.renderedTokens) ??
    null;
  const proposal = readStateProposals(db, batch.project_id, chapter?.id ?? item.chapter_id);
  const finalBodyProposalFingerprint =
    proposal.finalBodyProposalFingerprint ||
    (proposal.status === 'not_observed'
      ? { status: 'not_applicable', reason: 'state_proposal_table_absent' }
      : { status: 'not_applicable', reason: 'no_final_body_proposal' });
  const truth = frozen?.truthProjection || null;
  const memory = memoryRow || null;
  const bodyBytes = body ? bytes(body) : null;
  const contextBytes = task?.pipeline_context_json ? bytes(task.pipeline_context_json) : null;
  const stageOutputBytes = checkpoints.reduce((sum, row) => sum + (nonNegativeNumber(row.output_length) ?? 0), 0);
  const dbPayloadSize =
    bodyBytes == null && contextBytes == null && !checkpoints.length
      ? { bytes: null, source: 'not_observed' }
      : {
          bytes: (bodyBytes ?? 0) + (contextBytes ?? 0) + stageOutputBytes,
          source: 'chapter_content+pipeline_context+checkpoint_output_lengths',
        };
  const finalFingerprint =
    readString(finalSummary?.bodyFingerprint) ||
    readString(finalBodyEvent?.finalBodyFingerprint) ||
    bodyFingerprint;
  const latencyMs =
    nonNegativeNumber(observability?.chapterE2EMs) ??
    (start != null && end != null ? Math.max(0, end - start) : null);
  const chapterPosition = finiteNumber(chapter?.position);
  const storyMemorySize = memory
    ? {
        estimatedTokens: nonNegativeNumber(memory.estimated_tokens),
        payloadBytes: bytes(memory.memory_json),
        throughChapterPosition: finiteNumber(memory.through_chapter_position),
        stateFingerprint: readString(memory.state_fingerprint),
        status: memory.status || null,
      }
    : { status: 'not_observed' };
  const qualityProfile =
    readString(frozen?.stagePolicy?.values?.qualityProfile) ||
    readString(finalSummary?.qualityProfile) ||
    null;
  // Batch ordinals restart at 1 for every batch. The project chapter position
  // is the stable global index, so use it whenever the chapter row exists.
  const chapterIndex = chapterPosition == null ? finiteNumber(item.ordinal) : chapterPosition + 1;
  const status = item.status === 'completed' && task?.status === 'completed' && Boolean(body.trim()) ? 'completed' : item.status || task?.status || 'not_observed';
  const evidence = {
    source: 'device-db',
    missing: [],
    physicalCallsSource: physical.source,
    totalPaidCallsAttribution: 'writer physical + non-writer usage rows in item window + planner allocated to first item',
    contextInputTokensSource: contextInputTokens == null ? 'not_observed' : 'writing_observability.context',
    finalFingerprintSource: finalSummary?.bodyFingerprint ? 'final_artifact_summary' : bodyFingerprint ? 'computed_from_chapter_content' : 'not_observed',
    dbPayloadSizeSource: dbPayloadSize.source,
  };
  const result = {
    chapterIndex,
    chapterPosition,
    chapterId: chapter?.id ?? item.chapter_id ?? null,
    batchId: batch.id,
    batchOrdinal: item.ordinal,
    pipelineTaskId: task?.id ?? item.active_pipeline_task_id ?? null,
    generationTraceId:
      readString(trace?.generationTraceId) ||
      readString(observability?.generationTraceId) ||
      readString(frozen?.generationTraceId),
    qualityProfile,
    writerPhysicalCalls: physical.value,
    totalPaidLlmCalls: totalPaid,
    totalPaidLlmCallBreakdown: {
      writerPhysicalCalls: physical.value,
      directAuxiliaryCalls,
      plannerCalls,
      usageRowsInItemWindow: itemUsage.length,
    },
    draftTokens: stageTokens.draft,
    qaTokens: stageTokens.qa,
    revisionTokens: stageTokens.revision,
    plannerCalls,
    observerCalls,
    storyMemoryCalls,
    contextInputTokens,
    contextInputTokenSource: contextInputTokens == null ? 'not_observed' : 'writing_observability.context',
    finalCharCount: body ? finalCharCount(body) : null,
    storyMemorySize,
    dbPayloadSize,
    finalFingerprint,
    finalFingerprintSource: evidence.finalFingerprintSource,
    finalBodyProposalFingerprint,
    stateProposalFingerprint: proposal.latestProposalFingerprint,
    seamFingerprint:
      readString(truth?.seamFingerprint) ||
      { status: 'not_applicable', reason: 'no_frozen_seam_source' },
    canonBoundary,
    stateProposalCount: proposal.count,
    retryFallback: {
      retryCount: countRetries(attempts),
      fallbackCount: fallback.value,
      fallbackSource: fallback.source,
    },
    latencyMs,
    status,
    continuousChecks: buildContinuousChecks({
      truth,
      frozen,
      memory,
      canonBoundary,
      finalBodyProposalFingerprint,
    }),
    stageCheckpoints: checkpoints.map(row => ({
      stage: row.stage,
      status: row.status,
      inputTokens: nonNegativeNumber(row.input_tokens),
      outputTokens: nonNegativeNumber(row.output_tokens),
      totalTokens: nonNegativeNumber(row.total_tokens),
      durationMs: nonNegativeNumber(row.duration_ms),
      attemptCount: nonNegativeNumber(row.attempt_count),
    })),
    evidence,
  };
  evidence.missing = missingFields(result);
  return result;
}

function collectLongHorizonBaseline(options) {
  const { DatabaseSync } = require('node:sqlite');
  const databasePath = path.resolve(options.databasePath);
  if (!fs.existsSync(databasePath)) throw new Error(`数据库不存在: ${databasePath}`);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const projectId = Number(options.projectId);
    if (!Number.isInteger(projectId)) throw new Error('projectId 必须是整数');
    const project = db.prepare('SELECT id, name, mode, created_at, updated_at FROM projects WHERE id = ?').get(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    const database = getDatabaseInfo(db, databasePath);
    const requestedBatchIds = (options.batchIds || []).filter(Boolean);
    let batches = [];
    if (tableExists(db, 'multi_chapter_batches')) {
      const rows = db
        .prepare(
          `SELECT id, project_id, status, chapter_count, target_words_per_chapter,
                  start_position, completed_count, used_llm_calls, used_input_tokens,
                  used_output_tokens, created_at, updated_at, started_at, completed_at
             FROM multi_chapter_batches WHERE project_id = ? ORDER BY created_at ASC, id ASC`,
        )
        .all(projectId);
      batches = requestedBatchIds.length ? rows.filter(row => requestedBatchIds.includes(String(row.id))) : rows;
    }
    const items = tableExists(db, 'multi_chapter_batch_items') && batches.length
      ? db
          .prepare(
            `SELECT batch_id, ordinal, status, chapter_id, active_pipeline_task_id,
                    created_at, completed_at, error_code
               FROM multi_chapter_batch_items
              WHERE batch_id IN (${batches.map(() => '?').join(',')})
              ORDER BY batch_id ASC, ordinal ASC`,
          )
          .all(...batches.map(batch => batch.id))
      : [];
    const usageRows = tableExists(db, 'llm_usage_logs')
      ? db
          .prepare(
            `SELECT scenario, input_tokens, output_tokens, total_tokens,
                    status, error_code, created_at
               FROM llm_usage_logs WHERE project_id = ? ORDER BY created_at ASC, id ASC`,
          )
          .all(projectId)
      : [];
    const memoryRow = tableExists(db, 'project_story_memory')
      ? db
          .prepare(
            `SELECT estimated_tokens, memory_json, through_chapter_position,
                    state_fingerprint, status, updated_at
               FROM project_story_memory WHERE project_id = ?`,
          )
          .get(projectId)
      : null;
    const canonBoundary = readCanonBoundary(db, projectId);
    const chapters = [];
    for (const item of items) {
      const batch = batches.find(row => String(row.id) === String(item.batch_id));
      if (!batch) continue;
      const batchItems = items.filter(candidate => String(candidate.batch_id) === String(batch.id));
      const firstOrdinal = Math.min(
        ...batchItems
          .map(candidate => Number(candidate.ordinal))
          .filter(Number.isFinite),
      );
      chapters.push(
        readChapterEvidence({
          db,
          item: { ...item, isFirstItem: Number(item.ordinal) === firstOrdinal },
          batch,
          usageRows,
          memoryRow,
          canonBoundary,
        }),
      );
    }
    const deduped = new Map();
    for (const chapter of chapters) {
      const key = `${chapter.batchId}:${chapter.batchOrdinal}`;
      deduped.set(key, chapter);
    }
    return buildLongHorizonBaselineReport({
      exactHead: options.exactHead || null,
      project: { id: project.id, name: project.name, mode: project.mode },
      database,
      batches: batches.map(batch => ({
        id: batch.id,
        projectId: batch.project_id,
        status: batch.status,
        chapterCount: batch.chapter_count,
        targetWordsPerChapter: batch.target_words_per_chapter,
        completedCount: batch.completed_count,
        usedLlmCalls: batch.used_llm_calls,
        usedInputTokens: batch.used_input_tokens,
        usedOutputTokens: batch.used_output_tokens,
        createdAt: batch.created_at,
        updatedAt: batch.updated_at,
        startedAt: batch.started_at,
        completedAt: batch.completed_at,
      })),
      chapters: [...deduped.values()],
      targetCounts: options.targetCounts || DEFAULT_TARGET_COUNTS,
      realLlmEvidence: {
        mode: 'android-existing-config',
        modelName: options.modelName || null,
        proof: options.realLlmProof || [],
      },
    });
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const result = { realLlmProof: [], batchIds: [], targetCounts: DEFAULT_TARGET_COUNTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--db') result.databasePath = next;
    else if (arg === '--project-id') result.projectId = next;
    else if (arg === '--batch-id') result.batchIds = String(next || '').split(',').filter(Boolean);
    else if (arg === '--target-counts') result.targetCounts = String(next || '').split(',').map(Number);
    else if (arg === '--exact-head') result.exactHead = next;
    else if (arg === '--real-llm-proof') result.realLlmProof = String(next || '').split(',').filter(Boolean);
    else if (arg === '--model') result.modelName = next;
    else if (arg === '--out') result.outputPath = next;
  }
  return result;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.databasePath || options.projectId == null || !options.outputPath) {
    throw new Error('用法：必须提供 --db、--project-id、--out；真实 LLM 证据需另提供 --model 与 --real-llm-proof。');
  }
  const report = collectLongHorizonBaseline(options);
  const outputPath = path.resolve(options.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ outputPath, decision: report.decision, matrix: report.matrix }, null, 2));
  if (report.decision !== 'PASS') process.exitCode = 3;
}

module.exports = {
  BASELINE_SCHEMA,
  DEFAULT_TARGET_COUNTS,
  REQUIRED_CHAPTER_FIELDS,
  buildLongHorizonBaselineReport,
  validateLongHorizonBaselineReport,
  collectLongHorizonBaseline,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
