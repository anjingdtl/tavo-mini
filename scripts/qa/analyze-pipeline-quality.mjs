#!/usr/bin/env node

/**
 * Read-only Draft -> Review -> Brief -> Final quality evidence report.
 *
 * This tool deliberately does not assign a subjective literary score. It
 * produces the evidence and conservative warnings that a reviewer must use
 * to decide whether the final prose improved over the draft.
 *
 * Usage:
 *   node scripts/qa/analyze-pipeline-quality.mjs <database> <taskId>
 *   node scripts/qa/analyze-pipeline-quality.mjs <database> <taskId> --out <report.json>
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STAGE_ORDER = ['draft', 'review', 'factCheck', 'brief', 'proof'];
const MAX_PREVIEW_LENGTH = 180;

function usage() {
  console.error(
    'Usage: node scripts/qa/analyze-pipeline-quality.mjs <database> <taskId> [--out <report.json>]',
  );
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length < 2) usage();

const databasePath = path.resolve(args[0]);
const taskId = args[1];
const outIndex = args.indexOf('--out');
const outputPath = outIndex >= 0 ? args[outIndex + 1] : null;
if (outIndex >= 0 && !outputPath) usage();

function parseJson(value, fallback = null) {
  if (!value || typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function preview(value) {
  const text = asText(value).replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_PREVIEW_LENGTH) return text;
  return `${text.slice(0, MAX_PREVIEW_LENGTH)}…`;
}

function tailPreview(value) {
  const text = asText(value).replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_PREVIEW_LENGTH) return text;
  return `…${text.slice(-MAX_PREVIEW_LENGTH)}`;
}

function paragraphs(value) {
  return asText(value)
    .split(/\n\s*\n/)
    .map(item => item.trim())
    .filter(Boolean);
}

function textMetrics(value) {
  const text = asText(value);
  const paragraphList = paragraphs(text);
  const paragraphCounts = new Map();
  for (const paragraph of paragraphList) {
    paragraphCounts.set(paragraph, (paragraphCounts.get(paragraph) || 0) + 1);
  }
  const duplicateParagraphs = [...paragraphCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([paragraph, count]) => ({count, preview: preview(paragraph)}));

  return {
    chars: text.length,
    paragraphs: paragraphList.length,
    sentences: (text.match(/[。！？!?]/g) || []).length,
    dialogueQuotes: (text.match(/[“”「」『』]/g) || []).length,
    duplicateParagraphs,
    startsWithProtocol: /^\s*(?:```|\{\s*["']?(?:schemaVersion|sourceId)|<think>)/i.test(
      text,
    ),
    protocolLeakMarkers: unique(
      ['<think>', 'schemaVersion', 'sourceId', 'sourceHash', 'mustFix', 'mustNotAdvance'].filter(
        marker => text.includes(marker),
      ),
    ),
  };
}

function stageMap(rows) {
  return new Map(rows.map(row => [row.stage, row]));
}

function extractReviewItems(review) {
  if (!review || typeof review !== 'object') return [];
  const executable = Array.isArray(review.executableCorrections)
    ? review.executableCorrections
    : [];
  const unlocated = Array.isArray(review.unlocatedRequired)
    ? review.unlocatedRequired
    : [];
  const legacy = Array.isArray(review.required) ? review.required : [];
  return [...executable, ...unlocated, ...legacy].map((item, index) => ({
    sourceId: item?.sourceId || item?.id || `review-item-${index + 1}`,
    severity: item?.severity || (unlocated.includes(item) ? 'required' : 'unknown'),
    dimension: item?.dimension || '',
    diagnosis: asText(item?.diagnosis || item?.problem || item?.description),
    rewriteGoal: asText(item?.rewriteGoal || item?.instruction || item?.suggestion),
    locationHint: asText(item?.locationHint || item?.location),
    evidenceStatus: 'manual_review_required',
  }));
}

function quotedMarkers(value) {
  const text = asText(value);
  const matches = [];
  const patterns = [
    /[“「『](.{2,40})[”」』]/g,
    /["'](.{2,40})["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1].replace(/[，。；：、,.!?！？\s]+$/g, '').trim();
      if (candidate.length >= 2) matches.push(candidate);
    }
  }
  return matches;
}

function briefBoundaryEvidence(brief, draftText, finalText) {
  const mustNotAdvance = Array.isArray(brief?.mustNotAdvance)
    ? brief.mustNotAdvance.map(asText).filter(Boolean)
    : [];
  const mustFix = Array.isArray(brief?.mustFix) ? brief.mustFix : [];
  const candidates = unique([
    ...mustNotAdvance.flatMap(quotedMarkers),
    ...mustNotAdvance
      .map(item => item.match(/[A-Za-z0-9][A-Za-z0-9 _-]{1,40}/g) || [])
      .flat(),
  ]).filter(marker => marker.length >= 2);
  const toHints = text =>
    candidates
      .filter(marker => text.includes(marker))
      .map(marker => ({marker, note: '命中 Brief 边界词面，需人工判断是否只是继承事实、否定或回顾语境'}));
  const draftHints = toHints(draftText);
  const finalHints = toHints(finalText);
  const draftMarkers = new Set(draftHints.map(item => item.marker));
  const newHints = finalHints.filter(item => !draftMarkers.has(item.marker));

  return {
    mustNotAdvanceCount: mustNotAdvance.length,
    mustFixCount: mustFix.length,
    mustNotAdvance,
    draftLexicalHints: draftHints,
    finalLexicalHints: finalHints,
    newLexicalHints: newHints,
    status: newHints.length === 0 ? 'no_new_lexical_hint' : 'manual_review_required',
  };
}

function correctionCoverageEvidence(reviewItems, finalText) {
  return reviewItems.map(item => ({
    sourceId: item.sourceId,
    severity: item.severity,
    dimension: item.dimension,
    diagnosis: item.diagnosis,
    rewriteGoal: item.rewriteGoal,
    locationHint: item.locationHint,
    evidenceStatus: item.evidenceStatus,
    finalTextContainsGoalTerms: unique(
      (item.rewriteGoal.match(/[A-Za-z0-9]{3,}|[\u4e00-\u9fff]{3,}/g) || []).filter(
        term => finalText.includes(term),
      ),
    ).slice(0, 12),
  }));
}

function technicalEvidence(task, stages, finalText) {
  const requiredStages = ['draft', 'review', 'brief', 'proof'];
  const missingOrFailed = requiredStages.filter(stage => {
    const row = stages.get(stage);
    return !row || row.status !== 'succeeded' || !asText(row.output_text).trim();
  });
  const metrics = textMetrics(finalText);
  return {
    taskStatus: task.status,
    finalTextPresent: Boolean(finalText.trim()),
    requiredStages,
    missingOrFailed,
    technicalPass: task.status === 'completed' && missingOrFailed.length === 0,
    protocolLeakMarkers: metrics.protocolLeakMarkers,
  };
}

if (!fs.existsSync(databasePath)) {
  throw new Error(`数据库不存在: ${databasePath}`);
}

const db = new DatabaseSync(databasePath, {readOnly: true});
try {
  const task = db
    .prepare(
      `SELECT id, target_type, target_id, status, final_text,
              outline_workflow_version, context_budget_version
         FROM pipeline_tasks
        WHERE id = ?`,
    )
    .get(taskId);
  if (!task) throw new Error(`任务不存在: ${taskId}`);

  const rows = db
    .prepare(
      `SELECT task_id, stage, status, output_text, error_code, error_message,
              input_tokens, output_tokens, total_tokens, duration_ms,
              attempt_count, started_at, completed_at, updated_at
         FROM pipeline_stage_checkpoints
        WHERE task_id = ?`,
    )
    .all(taskId)
    .sort((left, right) => STAGE_ORDER.indexOf(left.stage) - STAGE_ORDER.indexOf(right.stage));
  const stages = stageMap(rows);
  const draftText = asText(stages.get('draft')?.output_text);
  const reviewText = asText(stages.get('review')?.output_text);
  const briefText = asText(stages.get('brief')?.output_text);
  const finalText = asText(stages.get('proof')?.output_text || task.final_text);
  const review = parseJson(reviewText, {});
  const brief = parseJson(briefText, {});
  const reviewItems = extractReviewItems(review);

  const chapter = db
    .prepare('SELECT id, project_id, position, title, content FROM chapters WHERE id = ?')
    .get(task.target_id);
  const previousChapter = chapter
    ? db
        .prepare(
          'SELECT id, position, title, content FROM chapters WHERE project_id = ? AND position < ? ORDER BY position DESC LIMIT 1',
        )
        .get(chapter.project_id, chapter.position)
    : null;

  const draftMetrics = textMetrics(draftText);
  const finalMetrics = textMetrics(finalText);
  const report = {
    schema: 'shinewriter.pipeline-quality-audit.v1',
    generatedAt: new Date().toISOString(),
    database: databasePath,
    task: {
      id: task.id,
      targetType: task.target_type,
      targetId: task.target_id,
      status: task.status,
      workflowVersion: task.outline_workflow_version,
      contextBudgetVersion: task.context_budget_version,
    },
    stages: rows.map(row => ({
      stage: row.stage,
      status: row.status,
      attemptCount: row.attempt_count,
      durationMs: row.duration_ms,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      textLength: asText(row.output_text).length,
      errorCode: row.error_code,
    })),
    draftFinalDelta: {
      draft: draftMetrics,
      final: finalMetrics,
      chars: finalMetrics.chars - draftMetrics.chars,
      paragraphs: finalMetrics.paragraphs - draftMetrics.paragraphs,
      sentences: finalMetrics.sentences - draftMetrics.sentences,
    },
    review: {
      requiredItemCount: reviewItems.filter(item => item.severity === 'required' || item.severity === 'hard').length,
      unlocatedRequiredCount: Array.isArray(review.unlocatedRequired) ? review.unlocatedRequired.length : 0,
      items: correctionCoverageEvidence(reviewItems, finalText),
    },
    briefBoundary: briefBoundaryEvidence(brief, draftText, finalText),
    continuitySeams: {
      previousChapter: previousChapter
        ? {
            id: previousChapter.id,
            position: previousChapter.position,
            title: previousChapter.title,
            openingPreview: preview(previousChapter.content),
            endingPreview: tailPreview(previousChapter.content),
          }
        : null,
      draft: {openingPreview: preview(draftText), endingPreview: tailPreview(draftText)},
      final: {openingPreview: preview(finalText), endingPreview: tailPreview(finalText)},
      status: 'manual_review_required',
    },
    technical: technicalEvidence(task, stages, finalText),
    qualityAudit: {
      status: 'manual_review_required',
      acceptanceRule:
        '必须逐条证明 Review required/hard 已落地、Brief 禁止提前项未推进、前后文和剧情因果无关键回归；仅状态 succeeded 不等于质量通过。',
      reviewerDecision: '未自动判定；请依据上述证据填写 applied/partially_applied/not_applied/not_applicable。',
    },
  };

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    const resolvedOutput = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolvedOutput), {recursive: true});
    fs.writeFileSync(resolvedOutput, serialized, 'utf8');
    console.log(`quality report written: ${resolvedOutput}`);
  } else {
    process.stdout.write(serialized);
  }
} finally {
  db.close();
}
