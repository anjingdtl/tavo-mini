/**
 * Outbox worker for extract_state / apply_event / rebuild_story_memory.
 * LLM calls happen OUTSIDE SQLite transactions (Spec §11, §4.14).
 */
import { openDatabase } from '../../../data/connection/openDatabase';
import { callLLMResult, resolveLLMRequestConfigById } from '../../llm';
import { rebuildStoryMemory } from '../../storyMemory/storyMemoryRebuild';
import { modelJsonCandidates } from '../canon/canonJsonValidators';
import { compileStateExtractionMessages } from './continuationPromptCompiler';
import {
  casOutboxState,
  contentRevisionHash,
  insertProposals,
  ensureGenerationSettings,
  getOutboxByDedupe,
  listPendingOutbox,
  markRunsInterruptedOnColdStart,
  MAX_OUTBOX_AUTO_RETRY_ATTEMPTS,
} from './generationRepository';
import type { ProposalType } from './types';

/**
 * DeepSeek V4 models enable thinking by default. Background continuation
 * extraction has a JSON-only contract and a deliberately bounded completion
 * budget, so leaving thinking enabled can consume the whole budget without a
 * JSON body. Keep this scoped to the continuation outbox; freeform pipelines
 * retain their existing provider semantics.
 */
function withContinuationJsonThinkingDisabled(
  config: Awaited<ReturnType<typeof resolveLLMRequestConfigById>>,
) {
  if (!config || !/^deepseek-v4-(flash|pro)$/i.test(config.model_name)) {
    return config;
  }
  return {
    ...config,
    thinking: { type: 'disabled' as const },
  };
}

export async function coldStartNormalizeContinuation(): Promise<number> {
  return markRunsInterruptedOnColdStart();
}

/**
 * Process pending outbox items. Safe to call repeatedly (dedupe + CAS).
 *
 * Fix-plan §3: rows that have already exhausted the auto-retry budget
 * (attempt_count >= MAX_OUTBOX_AUTO_RETRY_ATTEMPTS) are NOT claimed by the
 * worker — they stay `failed` and only move back to `pending` via an explicit
 * `retryContinuationOutbox` call. This prevents runaway retry/billing on
 * persistent errors while keeping manual recovery a single user action.
 */
export async function processContinuationOutbox(options?: {
  limit?: number;
  /**
   * Injected LLM for tests; when set, skips resolveLLM. Accepts either a bare
   * string (backward compatible with existing tests) or an object carrying
   * finishReason/emptyReason so truncation and empty-response paths can be
   * exercised without a real provider.
   */
  callExtract?: (
    messages: any[],
  ) => Promise<
    string | { text: string; finishReason?: string | null; emptyReason?: string }
  >;
  /** Injected story memory rebuild for tests. */
  rebuildStoryMemory?: (projectId: number, fromPosition: number) => Promise<void>;
}): Promise<{ processed: number; failed: number }> {
  const items = await listPendingOutbox(options?.limit ?? 10);
  let processed = 0;
  let failed = 0;

  for (const item of items) {
    // Budget guard: a row that already burned through the auto-retry budget
    // must not be auto-claimed again. Leave it `failed` for manual retry.
    if (item.attemptCount >= MAX_OUTBOX_AUTO_RETRY_ATTEMPTS) {
      continue;
    }
    // A finalized chapter's Story Memory rebuild must wait until its state
    // extraction reached a durable terminal success. The dependency lives in
    // payload JSON to keep old outbox rows and backup schema compatible.
    try {
      const dependency = JSON.parse(item.payloadJson)?.dependsOnDedupeKey;
      if (typeof dependency === 'string' && dependency) {
        const upstream = await getOutboxByDedupe(dependency);
        if (!upstream) continue;
        // H2 修复：原仅认 upstream.state === 'completed' 才继续，上游
        // extract_state 耗尽 5 次重试进入 'failed' 终态后，依赖它的
        // rebuild_story_memory 永远 continue 跳过，状态停在 pending 既不
        // failed 也不 completed，outbox 持续堆积且 UI 无提示。Story Memory
        // 重建从 finalized 章节正文重建，不强依赖 proposals 提取成功，
        // 依赖关系设得过强。改为：上游 failed 时直接放行（rebuild 容忍
        // 缺少新 proposals），让 rebuild 跑完进 completed；上游 pending/
        // running/interrupted 时仍 continue 等待。
        if (
          upstream.state !== 'completed' &&
          upstream.state !== 'failed'
        ) {
          continue;
        }
      }
    } catch {
      // Malformed optional payload remains processable for backward
      // compatibility; the operation itself will surface any real error.
    }
    const claimed = await casOutboxState(
      item.id,
      ['pending', 'interrupted'],
      { state: 'running', bumpAttempt: true },
    );
    if (!claimed) continue;

    try {
      if (item.operation === 'extract_state') {
        await handleExtractState(item.payloadJson, options?.callExtract);
      } else if (item.operation === 'apply_event') {
        // Event already created on confirm; mark complete.
      } else if (item.operation === 'rebuild_story_memory') {
        const payload = JSON.parse(item.payloadJson) as {
          fromPosition?: number;
        };
        if (options?.rebuildStoryMemory) {
          await options.rebuildStoryMemory(
            item.projectId,
            payload.fromPosition ?? 0,
          );
        } else {
          await rebuildStoryMemory(item.projectId, {
            fromPosition: payload.fromPosition ?? 0,
            mode: 'auto',
          });
        }
      }

      await casOutboxState(item.id, ['running'], {
        state: 'completed',
        completedAt: new Date().toISOString(),
      });
      processed += 1;
    } catch (e: any) {
      await casOutboxState(item.id, ['running'], {
        state: 'failed',
        lastError: e?.message ?? String(e),
      });
      failed += 1;
    }
  }

  return { processed, failed };
}

async function handleExtractState(
  payloadJson: string,
  callExtract?: (
    messages: any[],
  ) => Promise<
    string | { text: string; finishReason?: string | null; emptyReason?: string }
  >,
): Promise<void> {
  const payload = JSON.parse(payloadJson) as {
    projectId: number;
    chapterId: number;
    chapterRevisionHash: string;
    sourceRunId?: string | null;
    llmConfigId?: number;
  };

  const db = await openDatabase();
  const [ch] = await db.executeSql(
    'SELECT content, position FROM chapters WHERE id = ?',
    [payload.chapterId],
  );
  if (ch.rows.length === 0) {
    throw new Error('章节不存在，无法状态提取');
  }
  const content = String(ch.rows.item(0).content ?? '');
  const hash = contentRevisionHash(content);
  if (hash !== payload.chapterRevisionHash) {
    throw new Error('章节正文已变更，与定稿 hash 不一致');
  }

  const messages = compileStateExtractionMessages(content, '[]');
  let raw: string;
  let finishReason: string | null | undefined = undefined;
  let emptyReason: string | undefined = undefined;
  if (callExtract) {
    const out = await callExtract(messages);
    if (typeof out === 'string') {
      raw = out;
    } else {
      raw = out.text ?? '';
      finishReason = out.finishReason;
      emptyReason = out.emptyReason;
    }
  } else {
    const settings = await ensureGenerationSettings(payload.projectId);
    const configId =
      payload.llmConfigId ?? settings.stateExtractionLlmConfigId;
    const requestConfig = configId
      ? await resolveLLMRequestConfigById(configId)
      : undefined;
    const continuationRequestConfig = requestConfig
      ? withContinuationJsonThinkingDisabled(requestConfig)
      : requestConfig;
    const result = await callLLMResult(messages, 2048, {
      queueClass: 'background',
      queuePriority: 'background',
      projectId: payload.projectId,
      taskId: `extract_${payload.chapterId}`,
      scenario: 'continuation_state_extraction',
      responseFormat: 'json_object',
      requestConfig: continuationRequestConfig,
    });
    raw = result.text ?? '';
    finishReason = result.finishReason;
    emptyReason = result.emptyReason;
  }

  const proposals = parseExtraction(raw, content.length, {
    finishReason: finishReason ?? null,
    emptyReason: emptyReason ?? null,
  });
  await insertProposals(
    proposals.map(p => ({
      projectId: payload.projectId,
      chapterId: payload.chapterId,
      sourceRunId: payload.sourceRunId ?? null,
      extractionContentHash: hash,
      chapterRevisionHash: hash,
      proposalType: p.proposalType,
      subjectRefType: p.subjectRefType,
      subjectRefId: p.subjectRefId,
      payloadJson: JSON.stringify(p.payload),
      evidenceStart: p.evidenceStart,
      evidenceEnd: p.evidenceEnd,
    })),
  );
}

/** Diagnostic metadata for parseExtraction error messages. */
export interface ExtractionParseMeta {
  finishReason: string | null;
  emptyReason: string | null;
}

/**
 * Parse the LLM's state-extraction response into validated proposals.
 *
 * Multi-candidate JSON recovery (mirrors `parseExtractionResultJson`): tries
 * every balanced JSON value found in the raw text, so markdown fences, leading
 * prose ("Here is the JSON:"), and trailing usage notes no longer cause a hard
 * failure. When every candidate fails, the error message records the response
 * length, finish_reason and empty_reason so the outbox `last_error` column can
 * distinguish truncation (`finish_reason=length`) from a genuine format error
 * without ever storing the response preview (Spec §6.16 / failure-repair-plan).
 */
export function parseExtraction(
  raw: string,
  textLen: number,
  meta?: ExtractionParseMeta,
): Array<{
  proposalType: ProposalType;
  subjectRefType: string | null;
  subjectRefId: string | null;
  payload: Record<string, unknown>;
  evidenceStart: number;
  evidenceEnd: number;
}> {
  const rawLength = raw.length;
  const finishReason = meta?.finishReason ?? null;
  const emptyReason = meta?.emptyReason ?? null;

  // Empty response — surface a distinct, actionable reason so the UI retry
  // hint can point at the model/provider rather than the parser.
  if (rawLength === 0) {
    const parts = [
      'State extraction LLM 返回空响应',
      `finishReason=${finishReason ?? 'unknown'}`,
    ];
    if (emptyReason) parts.push(`emptyReason=${emptyReason}`);
    // reasoning_only is the most actionable signal: the model burned its
    // entire output budget on chain-of-thought and produced no business text.
    // Surface it ahead of the generic length hint.
    if (emptyReason === 'reasoning_only') {
      parts.push('— 模型只输出了思维链，未产生正文，请换模型或提高 max_tokens');
    } else if (finishReason === 'length') {
      parts.push('— 输出预算被截断，请提高 max_tokens 或缩短章节');
    }
    throw new Error(parts.join(' '));
  }

  // Truncation fast-path: finish_reason=length almost always means the JSON is
  // syntactically incomplete. Skip the candidate scan (which will still fail)
  // and give the user the real root cause.
  if (finishReason === 'length') {
    throw new Error(
      `State extraction 输出被 max_tokens 截断 (rawLength=${rawLength}, finishReason=length) — 请提高 max_tokens 或缩短章节`,
    );
  }

  // Multi-candidate recovery: try the whole trimmed text first, then every
  // balanced JSON value. This is the same strategy used by
  // parseExtractionResultJson for Canon extraction.
  let parsed: any;
  let parseFailed = true;
  for (const candidate of modelJsonCandidates(raw)) {
    try {
      parsed = JSON.parse(candidate);
      parseFailed = false;
      break;
    } catch {
      // try next candidate
    }
  }
  if (parseFailed) {
    throw new Error(
      `State extraction JSON 解析失败 (rawLength=${rawLength}, finishReason=${
        finishReason ?? 'unknown'
      }) — 所有 JSON 候选均不可解析`,
    );
  }
  const list = Array.isArray(parsed?.proposals)
    ? parsed.proposals
    : Array.isArray(parsed)
      ? parsed
      : [];
  if (!Array.isArray(list) || list.length === 0) {
    // Empty is allowed (no state change)
    return [];
  }

  const out: Array<{
    proposalType: ProposalType;
    subjectRefType: string | null;
    subjectRefId: string | null;
    payload: Record<string, unknown>;
    evidenceStart: number;
    evidenceEnd: number;
  }> = [];

  const allowed: ProposalType[] = [
    'character_state',
    'relationship_change',
    'plot_advance',
    'character_experience',
    'knowledge_change',
    'new_world_fact',
    'new_character',
    'new_location',
    'new_organization',
    'foreshadowing',
    'other',
  ];

  for (const item of list) {
    if (!allowed.includes(item.proposalType)) continue;
    const es = Number(item.evidenceStart);
    const ee = Number(item.evidenceEnd);
    if (!(es >= 0 && ee > es && ee <= textLen)) {
      // Spec: invalid offset → reject whole batch. Include the count so the
      // user knows how much was dropped.
      throw new Error(
        `State extraction evidence offset 越界，整批拒绝 (rawLength=${rawLength}, proposals=${list.length})`,
      );
    }
    out.push({
      proposalType: item.proposalType,
      subjectRefType: item.subjectRefType ?? null,
      subjectRefId:
        item.subjectRefId != null ? String(item.subjectRefId) : null,
      payload: item.payload ?? { summary: item.summary ?? '' },
      evidenceStart: es,
      evidenceEnd: ee,
    });
  }
  return out;
}

/** Deterministic extract helper for tests / offline. */
export function deterministicExtractFromText(text: string): {
  proposals: Array<{
    proposalType: ProposalType;
    payload: Record<string, unknown>;
    evidenceStart: number;
    evidenceEnd: number;
  }>;
} {
  const proposals: Array<{
    proposalType: ProposalType;
    payload: Record<string, unknown>;
    evidenceStart: number;
    evidenceEnd: number;
  }> = [];
  const m = text.match(/【状态:([^\]]+)】/);
  if (m && m.index != null) {
    proposals.push({
      proposalType: 'character_state',
      payload: { summary: m[1] },
      evidenceStart: m.index,
      evidenceEnd: m.index + m[0].length,
    });
  }
  const n = text.match(/【新人物:([^\]]+)】/);
  if (n && n.index != null) {
    proposals.push({
      proposalType: 'new_character',
      payload: { name: n[1], summary: `新人物 ${n[1]}` },
      evidenceStart: n.index,
      evidenceEnd: n.index + n[0].length,
    });
  }
  return { proposals };
}
