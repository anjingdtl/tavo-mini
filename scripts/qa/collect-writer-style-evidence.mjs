#!/usr/bin/env node

/**
 * Read-only IV-12A Writer Style / narrative acceptance collector.
 *
 * This script reads clean SQLite snapshots from a real Android run and emits
 * only scalar metadata plus evaluator annotations. It never writes prompts,
 * plans, synopsis text, titles, chapter bodies, reasoning, response bodies,
 * API keys, or error messages to the evidence JSON. The body is held in
 * memory only long enough for deterministic checks and its hash/length.
 *
 * Run with:
 *   node --experimental-strip-types \
 *     --experimental-loader ./scripts/qa/resolve-typescript-imports.mjs \
 *     ./scripts/qa/collect-writer-style-evidence.mjs \
 *     --input fast=fast-final.sqlite --input standard=standard-final.sqlite \
 *     --input quality=quality-final.sqlite --annotations annotations.json \
 *     --out writer-style-evidence.json
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assessWriterStyleAcceptance,
  buildNarrativeQualityEvidence,
  evaluateWriterStyleSample,
  fingerprintStyleRequirementProjection,
  projectWriterStyleRequirements,
  redactWriterStyleEvidence,
  WRITER_STYLE_ADHERENCE_CONTRACT_VERSION,
  WRITER_STYLE_ADHERENCE_SCHEMA,
  WRITER_STYLE_EVIDENCE_BODY_POLICY,
} from './writerStyleAdherence.ts';

const BODY_POLICY = WRITER_STYLE_EVIDENCE_BODY_POLICY;
const PROFILE_ORDER = ['fast', 'standard', 'quality'];
const NARRATIVE_DIMENSIONS = [
  'sceneCompletion',
  'beatRealization',
  'characterConsistency',
  'causalContinuity',
  'endingEffectiveness',
];
const COMPLETION_BOUNDARY_CHECKS = [
  'investigationSummary',
  'emotionTooFast',
  'actionChainTruncated',
  'slowPaceChecklisting',
  'templateEnding',
];

function usage(message = null) {
  if (message) console.error(message);
  console.error(
    'Usage: collect-writer-style-evidence.mjs --input profile=database.sqlite [--input ...] --annotations annotations.json --out evidence.json',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const inputs = [];
  let annotationsPath = null;
  let outputPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--input') {
      const value = argv[++index];
      const separator = value?.indexOf('=') ?? -1;
      if (!value || separator <= 0 || separator === value.length - 1) {
        usage(`Input must be profile=database.sqlite: ${value || ''}`);
      }
      inputs.push({
        profile: value.slice(0, separator),
        databasePath: path.resolve(value.slice(separator + 1)),
      });
    } else if (argument === '--annotations') {
      annotationsPath = argv[++index];
    } else if (argument === '--out') {
      outputPath = argv[++index];
    } else {
      usage(`Unknown argument: ${argument}`);
    }
  }
  if (inputs.length === 0) usage('At least one --input is required');
  if (!annotationsPath) usage('--annotations is required');
  if (!outputPath) usage('--out is required');
  return {
    inputs,
    annotationsPath: path.resolve(annotationsPath),
    outputPath: path.resolve(outputPath),
  };
}

function parseJson(value, fallback = null) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function stablePlanFingerprint(items) {
  return sha256(
    JSON.stringify(
      items.map(item => ({
        ordinal: item.ordinal,
        title: item.title,
        synopsis: item.synopsis,
        keyBeatsJson: item.key_beats_json,
        targetWords: item.target_words,
      })),
    ),
  );
}

function getNested(root, keys) {
  let current = root;
  for (const key of keys) {
    current = asRecord(current)?.[key];
    if (current === undefined) return null;
  }
  return current;
}

function makeBlindAnnotation(projection, annotation) {
  const source = annotation?.source === 'human' ? 'human' : 'independent_evaluator';
  const inputRules = asRecord(annotation?.rules) || {};
  const rules = {};
  let complete = true;
  for (const requirement of projection.requirements) {
    const value = inputRules[requirement.id];
    if (!value || !['satisfied', 'violated', 'not_applicable', 'unknown'].includes(value.assessment)) {
      complete = false;
      rules[requirement.id] = { assessment: 'unknown' };
      continue;
    }
    rules[requirement.id] = {
      assessment: value.assessment,
      evidenceCodes: Array.isArray(value.evidenceCodes)
        ? value.evidenceCodes.filter(code => typeof code === 'string').slice(0, 4)
        : [],
    };
  }
  return {
    source,
    status: complete ? 'complete' : annotation ? 'partial' : 'not_collected',
    rules,
  };
}

function narrativeEvidence(annotation) {
  const dimensions = {};
  const inputDimensions = asRecord(annotation?.narrative) || {};
  for (const dimension of NARRATIVE_DIMENSIONS) {
    const value = asRecord(inputDimensions[dimension]);
    if (!value) continue;
    dimensions[dimension] = {
      status: value.status === 'pass' ? 'pass' : value.status === 'fail' ? 'fail' : 'not_collected',
      score: asNumber(value.score),
      evidenceCodes: Array.isArray(value.evidenceCodes)
        ? value.evidenceCodes.filter(code => typeof code === 'string').slice(0, 4)
        : [],
    };
  }
  return buildNarrativeQualityEvidence({
    rubricVersion: asText(annotation?.rubricVersion) || 'phase4-narrative-quality-v1',
    minimumScore: asNumber(annotation?.minimumScore) ?? 3,
    dimensions,
  });
}

function completionBoundaryEvidence(annotation) {
  const input = asRecord(annotation?.completionBoundary);
  const checks = {};
  for (const check of COMPLETION_BOUNDARY_CHECKS) {
    const value = asRecord(input?.[check]);
    checks[check] = {
      status: value?.status === 'pass' ? 'pass' : value?.status === 'fail' ? 'fail' : 'not_collected',
      evidenceCodes: Array.isArray(value?.evidenceCodes)
        ? value.evidenceCodes.filter(code => typeof code === 'string').slice(0, 4)
        : [],
    };
  }
  const statuses = Object.values(checks).map(value => value.status);
  const status = statuses.includes('fail')
    ? 'fail'
    : statuses.every(value => value === 'pass')
      ? 'pass'
      : 'not_collected';
  return { rubricVersion: 'phase4-completion-boundary-v1', status, checks };
}

function extractStyle(context) {
  return (
    getNested(context, ['execution', 'writerStyle']) ||
    context?.writerStyleSnapshot ||
    getNested(context, ['draftContext', 'writerStyleSnapshot']) ||
    null
  );
}

function extractStaticContext(context) {
  const execution = asRecord(context?.execution);
  const draftContext = asRecord(context?.draftContext);
  const policy =
    getNested(context, ['execution', 'contextAutomationPolicyHash']) ||
    getNested(context, ['execution', 'contextBudgetV3Summary', 'contextAutomationPolicyHash']) ||
    getNested(draftContext, ['contextAutomationPolicyHash']) ||
    null;
  return {
    contextVersion: asNumber(context?.version),
    contextPolicyHash: typeof policy === 'string' ? policy : null,
    executionProfile: asText(execution?.executionProfile) || null,
    reasoningEffort: asText(execution?.reasoningEffort) || null,
    writerStyleFingerprint: asText(extractStyle(context)?.sourceFingerprint) || null,
  };
}

function readSnapshot(input, annotations) {
  const db = new DatabaseSync(input.databasePath, { readOnly: true });
  try {
    const batch = db
      .prepare(
        `SELECT id, project_id, status, chapter_count, completed_count,
                current_ordinal, used_llm_calls, reasoning_effort,
                execution_profile, outline_workflow_version,
                context_budget_version, pipeline_topology_version
         FROM multi_chapter_batches ORDER BY updated_at DESC LIMIT 1`,
      )
      .get();
    if (!batch) throw new Error(`No batch found in ${input.databasePath}`);
    const items = db
      .prepare(
        `SELECT ordinal, title, synopsis, key_beats_json, target_words, status,
                chapter_id, active_pipeline_task_id
         FROM multi_chapter_batch_items WHERE batch_id = ? ORDER BY ordinal`,
      )
      .all(batch.id);
    const planFingerprint = stablePlanFingerprint(items);
    const samples = [];
    for (const item of items) {
      if (!item.active_pipeline_task_id) {
        samples.push({
          profile: input.profile,
          ordinal: item.ordinal,
          status: 'missing_task',
          planFingerprint,
        });
        continue;
      }
      const task = db
        .prepare(
          `SELECT id, status, final_text, pipeline_context_json,
                  input_fingerprint, pipeline_context_hash, created_at,
                  updated_at
           FROM pipeline_tasks WHERE id = ?`,
        )
        .get(item.active_pipeline_task_id);
      const context = parseJson(task?.pipeline_context_json, {});
      const style = extractStyle(context);
      const projection = projectWriterStyleRequirements(style);
      const annotation = asRecord(annotations?.[input.profile]?.[String(item.ordinal)]) || null;
      const blind = makeBlindAnnotation(projection, annotation);
      const body = asText(task?.final_text);
      const sample = evaluateWriterStyleSample({
        projection,
        text: body,
        blindAnnotation: blind,
      });
      const narrative = narrativeEvidence(annotation);
      const acceptance = assessWriterStyleAcceptance({
        sample,
        narrativeQuality: narrative,
      });
      const contextStatic = extractStaticContext(context);
      const boundary = completionBoundaryEvidence(annotation);
      const checkpoints = db
        .prepare(
          `SELECT stage, status, attempt_count FROM pipeline_stage_checkpoints
           WHERE task_id = ? ORDER BY stage`,
        )
        .all(item.active_pipeline_task_id);
      const attempts = db
        .prepare(
          `SELECT stage, status, attempt_no, output_tokens,
                  visible_output_tokens, reasoning_tokens, finish_reason
           FROM pipeline_stage_attempts WHERE pipeline_task_id = ?
           ORDER BY stage, attempt_no`,
        )
        .all(item.active_pipeline_task_id);
      const redacted = redactWriterStyleEvidence(sample);
      samples.push({
        sampleId: `${input.profile}:${item.ordinal}`,
        profile: input.profile,
        ordinal: item.ordinal,
        batch: {
          id: batch.id,
          status: batch.status,
          chapterCount: batch.chapter_count,
          completedCount: batch.completed_count,
          reasoningEffort: batch.reasoning_effort,
          executionProfile: batch.execution_profile,
          outlineWorkflowVersion: batch.outline_workflow_version,
          contextBudgetVersion: batch.context_budget_version,
          pipelineTopologyVersion: batch.pipeline_topology_version,
          usedLlmCalls: batch.used_llm_calls,
        },
        task: {
          status: task?.status || null,
          inputFingerprint: task?.input_fingerprint || null,
          pipelineContextHash: task?.pipeline_context_hash || null,
          contextChars: asText(task?.pipeline_context_json).length,
          bodyChars: body.length,
          bodySha256: sha256(body),
          createdAt: task?.created_at || null,
          updatedAt: task?.updated_at || null,
        },
        comparability: {
          planFingerprint,
          styleFingerprint: redacted.writerStyle.styleFingerprint,
          styleProjectionFingerprint: fingerprintStyleRequirementProjection(projection),
          contextStatic,
        },
        checkpoints,
        attempts,
        writerStyle: redacted,
        narrativeQuality: narrative,
        completionBoundary: boundary,
        acceptance,
      });
    }
    return { profile: input.profile, batch, planFingerprint, samples };
  } finally {
    db.close();
  }
}

function buildComparability(runs) {
  const planFingerprints = [...new Set(runs.map(run => run.planFingerprint))];
  const styleFingerprints = [
    ...new Set(
      runs.flatMap(run =>
        run.samples.map(sample => sample.comparability?.styleFingerprint).filter(Boolean),
      ),
    ),
  ];
  const projectionFingerprints = [
    ...new Set(
      runs.flatMap(run =>
        run.samples.map(sample => sample.comparability?.styleProjectionFingerprint).filter(Boolean),
      ),
    ),
  ];
  return {
    matrix: runs.map(run => run.profile),
    samePlan: planFingerprints.length === 1,
    sameWriterStyle: styleFingerprints.length === 1,
    sameStyleRequirementProjection: projectionFingerprints.length === 1,
    planFingerprint: planFingerprints.length === 1 ? planFingerprints[0] : null,
    writerStyleFingerprints: styleFingerprints,
    styleProjectionFingerprints: projectionFingerprints,
    contextIsolatedPerSample: true,
  };
}

const args = parseArgs(process.argv.slice(2));
const annotations = parseJson(fs.readFileSync(args.annotationsPath, 'utf8'), {});
const annotationPayload =
  asRecord(annotations?.annotations) || annotations;
const runs = args.inputs.map(input => readSnapshot(input, annotationPayload));
runs.sort((left, right) => PROFILE_ORDER.indexOf(left.profile) - PROFILE_ORDER.indexOf(right.profile));

const evidence = {
  schema: WRITER_STYLE_ADHERENCE_SCHEMA,
  contractVersion: WRITER_STYLE_ADHERENCE_CONTRACT_VERSION,
  bodyPolicy: BODY_POLICY,
  evidenceLayer: 'test-evidence-acceptance-only',
  productionJudgeLlm: false,
  productionLiteraryGate: false,
  productionRetryOrReplan: false,
  matrix: {
    sampleCount: runs.reduce((sum, run) => sum + run.samples.length, 0),
    profiles: runs.map(run => run.profile),
    comparability: buildComparability(runs),
  },
  runs,
};

fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
fs.writeFileSync(args.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(
  JSON.stringify(
    {
      out: args.outputPath,
      schema: evidence.schema,
      profiles: evidence.matrix.profiles,
      samples: evidence.matrix.sampleCount,
      samePlan: evidence.matrix.comparability.samePlan,
      sameWriterStyle: evidence.matrix.comparability.sameWriterStyle,
    },
    null,
    2,
  ),
);
