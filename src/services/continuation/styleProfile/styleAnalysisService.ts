/**
 * Style analysis runner (Spec §5.1, §5.2, §5.6).
 *
 * Runs the `style_analysis` → `style_validation` stages after Canon evidence
 * validation succeeds and BEFORE the Canon snapshot is activated. Produces a
 * versioned, injectable {@link OriginalStyleProfileV2} stored via the style
 * profile repository.
 *
 * Invariants (Spec §4):
 *  - Reads source ONLY through `continuationSourceReader` (bounded). Samples
 *    never cross `boundary.charOffsetExclusive`.
 *  - Stores ONLY {@link StyleSampleRef}s; no long original passages for copy.
 *  - Never retries infinitely: at most ONE structural-repair LLM call.
 *  - On failure the Canon snapshot stays `awaiting_review` (NOT activated) and
 *    the caller marks the run `failed` so the user can retry or skip.
 *  - The number of LLM calls is derived from the frozen model config's ACTUAL
 *    `context_window` — no hardcoded chapter counts or fixed token budgets.
 */
import { continuationSourceReader } from '../continuationSourceReader';
import {
  ContinuationSnapshotOutdatedError,
  type ContinuationSourceSnapshot,
} from '../types';
import {
  getActiveSnapshot,
  listRunsForProject,
} from '../canon/canonRepository';
import { callLLMResult, resolveLLMRequestConfigById } from '../../llm';
import type { ChatMessage, LLMRequestConfig } from '../../llm';
import { estimateMessagesTokens, estimateTokens } from '../../../utils/tokenEstimator';
import { v4 } from '../../uuidBridge';
import { now } from '../../../data/repositories/shared';
import {
  insertStyleProfile,
  listStyleProfilesForProject,
  updateStyleProfilePayload,
  updateStyleProfileState,
  type StyleProfileFingerprint,
} from './styleProfileRepository';
import { computeStyleMetrics, type StyleMetrics } from './styleStatistics';
import {
  sampleForStyleAnalysis,
  type StyleSampleRef,
} from './styleSampler';
import {
  validateStyleProfileV2,
  type OriginalStyleProfileV2,
} from './styleProfileV2Schema';
import {
  STYLE_ANALYZER_VERSION,
  buildStyleAnalysisSystemPrompt,
  buildStyleAnalysisUserPrompt,
  buildStyleRepairInstruction,
} from './styleAnalysisPrompt';
import { sha256Hex } from '../hashUtils';

const PROFILE_SCHEMA_VERSION = 2;
/** Safety margin subtracted from the input budget (Spec §7.1). */
const INPUT_BUDGET_SAFETY_FRACTION = 0.1;
/** Minimum tokens reserved for the system prompt + framework overhead. */
const PROMPT_FRAMEWORK_RESERVE_TOKENS = 2048;

export interface RunStyleAnalysisInput {
  projectId: number;
  runId: string;
  canonSnapshotId: string;
  sourceSnapshot: ContinuationSourceSnapshot;
  modelConfigId: number | null;
  signal: AbortSignal;
}

/**
 * Run the full style-analysis pipeline for one Canon analysis run.
 *
 * Returns `{ profileId, success }`. On failure the profile row is marked
 * `failed` and `success` is false; the caller must NOT activate Canon.
 */
export async function runStyleAnalysis(
  input: RunStyleAnalysisInput,
): Promise<{ profileId: string; success: boolean }> {
  const { projectId, runId, canonSnapshotId, sourceSnapshot, signal } = input;
  const modelConfigId = input.modelConfigId;
  const profileId = v4();

  const fingerprint: StyleProfileFingerprint = {
    sourceId: sourceSnapshot.sourceId,
    sourceVersion: sourceSnapshot.sourceVersion,
    sourceSha256: sourceSnapshot.normalizedSha256,
    parserVersion: sourceSnapshot.parserVersion,
    normalizationVersion: sourceSnapshot.normalizationVersion,
    boundaryChapterId: sourceSnapshot.boundary.chapterId,
    boundaryPosition: sourceSnapshot.boundary.chapterPosition,
    boundaryCharOffsetExclusive: sourceSnapshot.boundary.charOffsetExclusive,
  };

  // Carry forward prior user overrides so re-analysis never loses the user's
  // manual corrections (Spec §5.7). The auto profile_json will be replaced by
  // the new analyzer output; only the overrides survive. We read the project's
  // existing profiles and pick the most recent non-empty overrides set. A
  // read failure must not block analysis — fall back to no overrides.
  const priorOverrides = await readPriorUserOverrides(projectId);

  // Insert a queued placeholder so the UI/tracer can observe the attempt even
  // before the first LLM call. state moves to running once chapters are read.
  await insertStyleProfile({
    id: profileId,
    projectId,
    fingerprint,
    analysisRunId: runId,
    canonSnapshotId,
    profileSchemaVersion: PROFILE_SCHEMA_VERSION,
    analyzerVersion: STYLE_ANALYZER_VERSION,
    profileHash: '',
    confidence: 0,
    state: 'queued',
    userOverridesJson: priorOverrides,
  });
  await updateStyleProfileState(profileId, 'running');

  const fail = async (
    errorCode: string,
    errorMessage: string,
  ): Promise<{ profileId: string; success: boolean }> => {
    await updateStyleProfileState(profileId, 'failed', {
      errorCode,
      errorMessage,
      completedAt: now(),
    });
    return { profileId, success: false };
  };

  try {
    // Re-check source validity on (re)entry: a paused/retried run must refuse
    // to mix two source versions (Spec §5.2).
    await assertSourceStillValid(projectId, sourceSnapshot);

    if (!modelConfigId) {
      return fail(
        'style_analysis_failed',
        '风格分析缺少 LLM 配置，请重新发起原著分析。',
      );
    }

    // Read bounded chapters (invariant: only through the bounded reader).
    const chapters = await continuationSourceReader.listBoundedSourceChapters(
      sourceSnapshot,
    );
    if (chapters.length === 0) {
      return fail(
        'style_analysis_failed',
        '续写边界内没有可分析的章节。',
      );
    }

    if (signal.aborted) throw new Error('cancelled');

    // Whole-book local statistics (no LLM).
    const metrics = computeStyleMetrics(chapters);

    // Deterministic stratified sampling, seeded by the source fingerprint.
    const seed = buildSeed(sourceSnapshot);
    const sampleRefs = sampleForStyleAnalysis(chapters, seed);

    // Resolve the frozen model config to learn the ACTUAL context window.
    const requestConfig = await resolveLLMRequestConfigById(modelConfigId);
    const contextWindow =
      requestConfig.context_window && requestConfig.context_window > 0
        ? requestConfig.context_window
        : 8192;
    const maxOutputTokens =
      requestConfig.max_output_tokens && requestConfig.max_output_tokens > 0
        ? requestConfig.max_output_tokens
        : 4096;

    // Re-read the sample passages (bounded) to embed short reference spans in
    // the prompt. We pass ONLY bounded, pre-clipped spans — never long copies.
    const sampleSpans = await readSampleSpans(sourceSnapshot, sampleRefs);

    const outcome = await analyzeWithLlm({
      metrics,
      sampleSpans,
      requestConfig,
      contextWindow,
      maxOutputTokens,
      coverage: {
        sourceChapterCount: chapters.length,
        sampledChapterCount: new Set(sampleRefs.map(r => r.sourceChapterId)).size,
      },
      signal,
    });

    if (!outcome.profile) {
      return fail('style_analysis_failed', outcome.errorMessage ?? '风格分析失败');
    }

    // Compute the canonical profile hash over profile + metrics + sampleRefs.
    const profileHash = computeProfileHash(
      outcome.profile,
      metrics,
      sampleRefs,
    );

    await updateStyleProfilePayload(
      profileId,
      {
        profileJson: outcome.profile as unknown as Record<string, unknown>,
        metricsJson: metrics as unknown as Record<string, unknown>,
        sampleRefsJson: sampleRefs,
        profileHash,
        confidence: outcome.profile.confidence,
      },
      { state: 'ready', completedAt: now() },
    );

    return { profileId, success: true };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : '风格分析过程中发生未知错误。';
    if (err instanceof ContinuationSnapshotOutdatedError) {
      // Source/boundary drifted mid-analysis: the profile is outdated, not
      // merely failed, so it can never be injected.
      await updateStyleProfileState(profileId, 'outdated', {
        errorCode: 'source_outdated',
        errorMessage: '原著源或边界已变化，风格画像已失效。',
        completedAt: now(),
      });
      return { profileId, success: false };
    }
    return fail('style_analysis_failed', friendlyFailure(message));
  }
}

/**
 * Re-run style analysis for the project's latest canon snapshot (Spec §10.1:
 * "单独重试风格分析"). Reuses the same source snapshot + model config that the
 * originating Canon run captured.
 */
export async function retryStyleAnalysis(projectId: number): Promise<void> {
  // Static imports: canonRepository depends only on types/db helpers, so there
  // is no cycle with the style module.
  const snap = await getActiveSnapshot(projectId);
  // Retry targets the latest canon snapshot (active if already activated via a
  // skip, otherwise the most recent awaiting_review snapshot's run).
  let canonSnapshotId: string | null = snap?.id ?? null;
  let modelConfigId: number | null = null;
  let runId: string | null = null;

  if (!canonSnapshotId) {
    const runs = await listRunsForProject(projectId);
    const latest = runs[0];
    if (!latest) {
      throw new Error('该项目尚无可重试的原著分析任务。');
    }
    canonSnapshotId = latest.canonSnapshotId;
    modelConfigId = latest.modelConfigId;
    runId = latest.id;
  } else {
    // Find the run that produced the active snapshot to reuse its model config.
    const runs = await listRunsForProject(projectId);
    const match = runs.find(r => r.canonSnapshotId === canonSnapshotId);
    modelConfigId = match?.modelConfigId ?? null;
    runId = match?.id ?? `retry-${canonSnapshotId}`;
  }

  if (!runId) runId = `retry-${canonSnapshotId}`;

  const sourceSnapshot = await continuationSourceReader.getSnapshot(projectId);
  const result = await runStyleAnalysis({
    projectId,
    runId,
    canonSnapshotId: canonSnapshotId!,
    sourceSnapshot,
    modelConfigId,
    signal: new AbortController().signal,
  });
  if (!result.success) {
    throw new Error('风格分析重试失败，请稍后再试或显式跳过文风。');
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Read the project's most recent non-empty user overrides so re-analysis can
 * carry them forward (Spec §5.7: 重新分析原著时自动画像可以替换，用户修正不得丢失).
 * Returns an empty object when there are no prior overrides. A read failure is
 * swallowed (returns {}) so a transient DB error cannot block analysis; the
 * worst case is the user re-applies their overrides, never data loss in the
 * auto profile.
 */
async function readPriorUserOverrides(
  projectId: number,
): Promise<Record<string, unknown>> {
  try {
    const profiles = await listStyleProfilesForProject(projectId);
    // listStyleProfilesForProject orders by updated_at DESC, so the first
    // non-empty overrides set is the most recent user correction.
    for (const p of profiles) {
      if (
        p.userOverridesJson &&
        typeof p.userOverridesJson === 'object' &&
        Object.keys(p.userOverridesJson).length > 0
      ) {
        return p.userOverridesJson;
      }
    }
  } catch {
    // Fall through to empty overrides.
  }
  return {};
}

/**
 * Verify the supplied snapshot still matches the live active source. Throws
 * `ContinuationSnapshotOutdatedError` on any drift (Spec §5.2, §12.3).
 */
async function assertSourceStillValid(
  projectId: number,
  snapshot: ContinuationSourceSnapshot,
): Promise<void> {
  const live = await continuationSourceReader.getSnapshot(projectId);
  if (
    live.sourceId !== snapshot.sourceId ||
    live.sourceVersion !== snapshot.sourceVersion ||
    live.normalizedSha256 !== snapshot.normalizedSha256 ||
    live.parserVersion !== snapshot.parserVersion ||
    live.normalizationVersion !== snapshot.normalizationVersion ||
    live.boundary.chapterId !== snapshot.boundary.chapterId ||
    live.boundary.charOffsetExclusive !==
      snapshot.boundary.charOffsetExclusive
  ) {
    throw new ContinuationSnapshotOutdatedError();
  }
}

/** Build the deterministic sampling seed from the source fingerprint. */
function buildSeed(snapshot: ContinuationSourceSnapshot): string {
  return [
    snapshot.sourceId,
    snapshot.sourceVersion,
    snapshot.normalizedSha256,
    snapshot.parserVersion,
    snapshot.normalizationVersion,
    snapshot.boundary.chapterId,
    snapshot.boundary.charOffsetExclusive,
    STYLE_ANALYZER_VERSION,
  ].join('|');
}

/**
 * Read the bounded sample passages via the bounded source reader. Returns the
 * passage text for each ref so the prompt can embed short reference spans.
 * The passages are re-clipped to the boundary by the reader (invariant).
 */
async function readSampleSpans(
  snapshot: ContinuationSourceSnapshot,
  refs: StyleSampleRef[],
): Promise<Array<{ ref: StyleSampleRef; text: string }>> {
  const out: Array<{ ref: StyleSampleRef; text: string }> = [];
  for (const ref of refs) {
    const text = await continuationSourceReader.readBoundedEvidenceRange({
      snapshot,
      start: ref.charStart,
      end: ref.charEnd,
    });
    // Re-verify the hash on read so a drifted store cannot silently feed the
    // LLM altered text (Spec §5.4: evidence is hash-verified on every read).
    if (sha256Hex(text) !== ref.contentHash) {
      throw new Error(
        `风格样本 hash 校验失败：chapter ${ref.sourceChapterId} ` +
          `[${ref.charStart}, ${ref.charEnd})`,
      );
    }
    out.push({ ref, text });
  }
  return out;
}

interface AnalyzeOutcome {
  profile: OriginalStyleProfileV2 | null;
  errorMessage?: string;
}

/**
 * Drive the LLM analysis, deciding dynamically between a single structured
 * call and a map/reduce split based on the ACTUAL context window (Spec §5.6).
 * Allows at most ONE structural-repair retry; never retries infinitely.
 */
async function analyzeWithLlm(args: {
  metrics: StyleMetrics;
  sampleSpans: Array<{ ref: StyleSampleRef; text: string }>;
  requestConfig: LLMRequestConfig;
  contextWindow: number;
  maxOutputTokens: number;
  coverage: { sourceChapterCount: number; sampledChapterCount: number };
  signal: AbortSignal;
}): Promise<AnalyzeOutcome> {
  const {
    metrics,
    sampleSpans,
    requestConfig,
    contextWindow,
    maxOutputTokens,
    coverage,
    signal,
  } = args;

  const systemPrompt = buildStyleAnalysisSystemPrompt();
  const systemTokens = estimateTokens(systemPrompt);

  // Input budget = context window minus output reservation, minus prompt
  // framework overhead, minus a proportional safety margin (Spec §7.1).
  const afterOutput = Math.max(0, contextWindow - maxOutputTokens);
  const afterFramework = Math.max(0, afterOutput - PROMPT_FRAMEWORK_RESERVE_TOKENS);
  const inputBudget = Math.max(
    0,
    Math.floor(afterFramework * (1 - INPUT_BUDGET_SAFETY_FRACTION)),
  );

  const metricsBlock = JSON.stringify(metrics);
  const sampleBlocks = renderSampleBlocks(sampleSpans);
  const userPrompt = buildStyleAnalysisUserPrompt({
    metricsJson: metricsBlock,
    sampleBlocks,
    coverage,
  });
  const userTokens = estimateTokens(userPrompt);
  const totalInputTokens = systemTokens + userTokens;

  // Decide split purely from the actual budget (Spec §5.6: no hardcoded
  // chapter counts). If everything fits → one call. Otherwise → map/reduce.
  if (totalInputTokens <= inputBudget) {
    return singleCall({
      systemPrompt,
      userPrompt,
      requestConfig,
      maxOutputTokens,
      signal,
    });
  }
  return mapReduceCall({
    systemPrompt,
    metricsBlock,
    sampleSpans,
    coverage,
    requestConfig,
    maxOutputTokens,
    inputBudget,
    systemTokens,
    signal,
  });
}

/** Render sample spans into labelled, bounded blocks for the prompt. */
function renderSampleBlocks(
  spans: Array<{ ref: StyleSampleRef; text: string }>,
): string {
  if (spans.length === 0) return '（本次抽样未产生可用样本，请仅依据统计输出保守画像。）';
  return spans
    .map(
      (s, i) =>
        `### 样本${i + 1} [${s.ref.sampleKind}] chapter=${s.ref.sourceChapterId}\n` +
        s.text,
    )
    .join('\n\n');
}

/**
 * Single structured analysis call with one allowed repair retry.
 */
async function singleCall(args: {
  systemPrompt: string;
  userPrompt: string;
  requestConfig: LLMRequestConfig;
  maxOutputTokens: number;
  signal: AbortSignal;
}): Promise<AnalyzeOutcome> {
  const messages: ChatMessage[] = [
    { role: 'system', content: args.systemPrompt },
    { role: 'user', content: args.userPrompt },
  ];
  return runValidatedCall(messages, args.requestConfig, args.maxOutputTokens, args.signal);
}

/**
 * Map/reduce split: partition sample spans into batches that each fit the input
 * budget, run a map call per batch producing a partial style summary, then a
 * single reduce call merges the partials + the global metrics into the final
 * V2 profile. The number of map calls is derived from the budget and the
 * actual sample material size — never a fixed count (Spec §5.6).
 */
async function mapReduceCall(args: {
  systemPrompt: string;
  metricsBlock: string;
  sampleSpans: Array<{ ref: StyleSampleRef; text: string }>;
  coverage: { sourceChapterCount: number; sampledChapterCount: number };
  requestConfig: LLMRequestConfig;
  maxOutputTokens: number;
  inputBudget: number;
  systemTokens: number;
  signal: AbortSignal;
}): Promise<AnalyzeOutcome> {
  const {
    systemPrompt,
    metricsBlock,
    sampleSpans,
    coverage,
    requestConfig,
    maxOutputTokens,
    inputBudget,
    systemTokens,
    signal,
  } = args;

  // Per-map budget for sample text = inputBudget minus the system prompt and a
  // small per-batch framework cost.
  const perMapTextBudget = Math.max(
    512,
    inputBudget - systemTokens - 512,
  );

  // Greedily pack spans into batches whose estimated token cost fits the budget.
  const batches: Array<Array<{ ref: StyleSampleRef; text: string }>> = [];
  let current: Array<{ ref: StyleSampleRef; text: string }> = [];
  let currentTokens = 0;
  for (const span of sampleSpans) {
    const cost = estimateTokens(span.text) + 32; // label overhead
    if (currentTokens + cost > perMapTextBudget && current.length > 0) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(span);
    currentTokens += cost;
  }
  if (current.length > 0) batches.push(current);

  if (batches.length === 0) {
    return {
      profile: null,
      errorMessage: '没有可供分析的样本材料。',
    };
  }

  const mapSystem =
    systemPrompt +
    '\n本轮为 map 阶段：只针对给出的样本批次，输出该批次观察到的局部风格要点（自由结构 JSON），不要输出完整 V2 画像。';

  const partials: string[] = [];
  for (const [i, batch] of batches.entries()) {
    if (signal.aborted) throw new Error('cancelled');
    const userPrompt = buildStyleAnalysisUserPrompt({
      metricsJson: metricsBlock,
      sampleBlocks: renderSampleBlocks(batch),
      coverage,
    });
    const response = await callLLMResult(
      [
        { role: 'system', content: mapSystem },
        { role: 'user', content: userPrompt },
      ],
      Math.max(1024, Math.floor(maxOutputTokens / 2)),
      {
        responseFormat: 'json_object',
        temperature: 0.1,
        queueClass: 'canon_analysis',
        queuePriority: 'background',
        scenario: 'continuation_style_analysis',
        requestConfig,
      },
      signal,
    );
    const text = (response?.text ?? '').trim();
    if (text) {
      partials.push(`### 局部要点（批次 ${i + 1}）\n${text}`);
    }
  }

  // Reduce: merge partials + global metrics into the final V2 profile.
  const reduceUserPrompt = buildStyleAnalysisUserPrompt({
    metricsJson: metricsBlock,
    sampleBlocks: partials.join('\n\n'),
    coverage,
  });
  const reduceMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content:
        reduceUserPrompt +
        '\n以上局部要点来自 map 阶段，请据此汇总输出完整的 V2 风格画像 JSON。',
    },
  ];
  return runValidatedCall(
    reduceMessages,
    requestConfig,
    maxOutputTokens,
    signal,
  );
}

/**
 * Execute one validated LLM call against the V2 schema, allowing a single
 * structural-repair retry. Never retries infinitely (Spec §5.6).
 */
async function runValidatedCall(
  messages: ChatMessage[],
  requestConfig: LLMRequestConfig,
  maxOutputTokens: number,
  signal: AbortSignal,
): Promise<AnalyzeOutcome> {
  const callOnce = async (
    extraMessages: ChatMessage[],
  ): Promise<{ text: string | null; error: string | null }> => {
    if (signal.aborted) throw new Error('cancelled');
    const response = await callLLMResult(
      [...messages, ...extraMessages],
      maxOutputTokens,
      {
        responseFormat: 'json_object',
        temperature: 0.1,
        queueClass: 'canon_analysis',
        queuePriority: 'background',
        scenario: 'continuation_style_analysis',
        requestConfig,
      },
      signal,
    );
    const text = (response?.text ?? '').trim();
    if (!text) {
      return { text: null, error: 'LLM 未返回风格分析结果。' };
    }
    return { text, error: null };
  };

  // First attempt.
  const first = await callOnce([]);
  if (first.text) {
    const parsed = parseJson(first.text);
    const validation = validateStyleProfileV2(parsed);
    if (validation.ok && validation.profile) {
      return { profile: validation.profile };
    }
    // One repair retry carrying the aggregated structural errors.
    const repairMessages: ChatMessage[] = [
      {
        role: 'assistant',
        content: first.text,
      },
      {
        role: 'user',
        content: buildStyleRepairInstruction(validation.errors.join('\n')),
      },
    ];
    const repaired = await callOnce(repairMessages);
    if (repaired.text) {
      const reparsed = parseJson(repaired.text);
      const revalidation = validateStyleProfileV2(reparsed);
      if (revalidation.ok && revalidation.profile) {
        return { profile: revalidation.profile };
      }
      return {
        profile: null,
        errorMessage:
          '风格画像 JSON 结构校验失败（已用尽一次修复重试）：' +
          revalidation.errors.slice(0, 3).join('；'),
      };
    }
    return {
      profile: null,
      errorMessage: repaired.error ?? '风格画像修复重试未返回结果。',
    };
  }
  return { profile: null, errorMessage: first.error ?? '风格分析失败。' };
}

/** Best-effort JSON.parse that strips Markdown fences / prose wrappers. */
function parseJson(text: string): unknown {
  let candidate = text.trim();
  // Strip a surrounding ```json ... ``` fence if present.
  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  }
  // If there's still prose, try to locate the outermost JSON object.
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    candidate = candidate.slice(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/** Canonical, stable JSON used for the profile hash (sorted keys). */
function computeProfileHash(
  profile: OriginalStyleProfileV2,
  metrics: StyleMetrics,
  sampleRefs: StyleSampleRef[],
): string {
  const canonical = JSON.stringify(
    {
      profile,
      metrics,
      sampleRefs: sampleRefs
        .slice()
        .sort((a, b) =>
          a.contentHash < b.contentHash ? -1 : a.contentHash > b.contentHash ? 1 : 0,
        )
        .map(r => ({
          k: r.sampleKind,
          c: r.sourceChapterId,
          s: r.charStart,
          e: r.charEnd,
          h: r.contentHash,
        })),
    },
    Object.keys({ profile: 0, metrics: 0, sampleRefs: 0 }).sort(),
  );
  return sha256Hex(canonical);
}

/** Translate a raw error message into a user-facing retry hint. */
function friendlyFailure(message: string): string {
  if (message === 'cancelled') {
    return '原著风格分析已取消，可单独重试。';
  }
  return `原著风格分析失败，可单独重试：${message}`;
}

// Re-export the analyzer version + estimator so callers can record them in the
// analysis run trace without a second import path.
export { STYLE_ANALYZER_VERSION, estimateMessagesTokens };
