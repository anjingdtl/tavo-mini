import type { Chapter } from '../../types/novel';
import { estimateTokens } from '../../utils/tokenEstimator';
import { invalidateIdf } from '../../utils/idfCache';
import * as db from '../database';
import { callLLMResult, type LLMResult } from '../llm';
import { extractJSON } from '../../utils/jsonExtractor';
import {
  fingerprintChapterSource,
  fingerprintStoryMemoryState,
  stableTextFingerprint,
} from './storyMemoryFingerprint';
import { applyStoryMemoryBatchPatch } from './storyMemoryMerger';
import {
  buildStoryMemoryCheckpointMessages,
  buildStoryMemoryCheckpointRepairMessages,
  buildStoryMemoryCheckpointRetryMessages,
} from './storyMemoryPrompts';
import { validateStoryMemoryBatchPatch } from './storyMemoryBatchValidator';
import type {
  EpisodicSummary,
  StoryMemoryBatchPatchDraft,
  StoryMemoryPartialSuccess,
  StoryMemoryState,
  StoredStoryMemoryBatch,
} from './storyMemoryTypes';
import { StoryMemoryError } from './storyMemoryTypes';
import {
  splitCheckpointBatches,
  STORY_MEMORY_DEFAULT_BATCH_SIZE,
} from './storyMemoryPolicy';
import { getContinuationChapterNumbering } from '../continuation/chapterNumbering/continuationChapterNumbering';
import {
  checkpointMaxTokens as planCheckpointMaxTokens,
} from './storyMemoryBudget';
import {
  decideEmptyResponseAction,
  isSafeStoryMemoryRetryError,
  STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
} from './storyMemoryAttemptPolicy';
import {
  StoryMemoryAttemptBudget,
  createStoryMemoryLogicalBatchId,
} from './storyMemoryAttemptBudget';
import { buildStoryMemoryLLMConfig } from './storyMemoryRequestPolicy';
import {
  freezeStoryMemoryLLMConfig,
  planStoryMemoryRequest,
  planStoryMemoryElasticRequest,
  type FrozenStoryMemoryLLMConfig,
} from './storyMemoryRequestBudget';
import {
  buildStoryMemoryCheckpointMaterials,
  type StoryMemoryCheckpointMaterials,
} from './storyMemoryPromptMaterials';

function renderBatchEpisodicText(
  summary: EpisodicSummary,
  chapter?: Pick<Chapter, 'synopsis' | 'content'>,
): string {
  const sections: Array<[string, string[]]> = [
    ['核心事件', [summary.brief, ...summary.events]],
    ['人物变化', summary.characterChanges],
    ['关系变化', summary.relationshipChanges],
    ['主线变化', summary.mainlineChanges],
    ['新增悬念', summary.newThreads],
    ['已解决事项', summary.resolvedThreads],
    ['关键词', summary.keywords],
  ];
  const rendered = sections
    .map(([label, values]) =>
      [...new Set(values.map(value => value.trim()).filter(Boolean))].length
        ? `${label}：${[
            ...new Set(values.map(value => value.trim()).filter(Boolean)),
          ].join('；')}`
        : '',
    )
    .filter(Boolean)
    .join('\n');
  if (rendered || !chapter) return rendered;
  const synopsis = chapter.synopsis.replace(/\s+/g, ' ').trim();
  if (synopsis) return `核心事件：${synopsis.slice(0, 240)}`;
  const contentExcerpt = chapter.content
    .replace(/^\s*#{1,6}[^\n]*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return contentExcerpt ? `核心事件：${contentExcerpt}` : '';
}

/**
 * Model-capability-aware checkpoint output budget.
 *
 * Legacy two-arg signature retained for compatibility; the optional third
 * argument carries the ACTIVE model capabilities (repair plan P1 §6.3) so the
 * budget never exceeds what the model window / max_output_tokens can accept.
 */
export function checkpointMaxTokens(
  memoryPatchMaxTokens: number,
  batchSize: number,
  model?: {
    contextWindow?: number;
    maxOutputTokens?: number;
    estimatedInputTokens?: number;
  },
): number {
  return planCheckpointMaxTokens({
    memoryPatchMaxTokens,
    batchSize,
    contextWindow: model?.contextWindow,
    maxOutputTokens: model?.maxOutputTokens,
    estimatedInputTokens: model?.estimatedInputTokens,
  });
}

function fingerprintBatchSource(chapters: Chapter[]): string {
  const ordered = [...chapters].sort((a, b) => a.position - b.position);
  return stableTextFingerprint(
    ordered
      .map(
        chapter =>
          `${chapter.id}:${chapter.position}:${fingerprintChapterSource(
            chapter,
          )}`,
      )
      .join('|'),
  );
}

async function requestCheckpoint(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  maxTokens: number,
  projectId: number,
  scenario: string,
  signal?: AbortSignal,
  attemptBudget?: StoryMemoryAttemptBudget,
  frozenConfig?: FrozenStoryMemoryLLMConfig,
): Promise<LLMResult> {
  // Exactly one call enters the coordinator. Transport retries and protocol
  // fallbacks are accounted by the shared physical-request hook instead of a
  // hidden retry loop in this lower-level request helper.
  const result = await callLLMResult(
    messages,
    maxTokens,
    buildStoryMemoryLLMConfig({
      scenario,
      projectId,
      physicalRequestHooks: attemptBudget?.hooks(),
      requestConfig: frozenConfig?.requestConfig,
    }),
    signal,
  );
  if (!result) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_FAILED',
      '检查点请求未能返回结果，请重试。',
    );
  }
  return result;
}

export function parseAndValidateBatchPatch(
  output: string,
  previousState: StoryMemoryState,
  chapters: Chapter[],
  options: {
    recoverEvidence?: boolean;
    getDisplayNumber?: (position: number) => number;
  } = {},
): StoryMemoryBatchPatchDraft {
  const json = extractJSON(output);
  if (!json) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_INVALID_JSON',
      '模型没有返回完整的检查点 JSON 对象。',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_INVALID_JSON',
      '模型返回的检查点 JSON 无法解析。',
    );
  }
  return validateStoryMemoryBatchPatch(parsed, previousState, chapters, {
    ...options,
    requireMainlineAssessment: true,
  });
}

export async function generateValidatedCheckpointBatch(input: {
  chapters: Chapter[];
  previousState: StoryMemoryState;
  memoryPatchMaxTokens: number;
  frozenConfig?: FrozenStoryMemoryLLMConfig;
  signal?: AbortSignal;
  scenario?:
    | 'story_memory_checkpoint'
    | 'story_memory_checkpoint_legacy_bootstrap';
  attemptBudget?: StoryMemoryAttemptBudget;
  onProgress?: (progress: StoryMemoryCheckpointProgressEvent) => void;
}): Promise<StoryMemoryBatchPatchDraft> {
  if (input.signal?.aborted) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_CANCELLED',
      '故事记忆检查点任务已取消。',
    );
  }
  if (!input.chapters.length) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_RANGE_MISMATCH',
      '检查点批次不能为空。',
    );
  }
  const messages = buildStoryMemoryCheckpointMessages(
    input.chapters,
    input.previousState,
  );
  // Tiered materials for the elastic allocator path (governance §5). Built
  // unconditionally — the loop decides whether to use them based on whether
  // the frozen config exposes a real capability.
  const materials = buildStoryMemoryCheckpointMaterials(
    input.chapters,
    input.previousState,
  );
  const scenario = input.scenario || 'story_memory_checkpoint';
  const projectId = input.chapters[0].project_id;
  let getDisplayNumber: ((position: number) => number) | undefined;
  try {
    const numbering = await getContinuationChapterNumbering(projectId);
    getDisplayNumber = position => numbering.getDisplayNumber(position as any);
  } catch {
    getDisplayNumber = undefined;
  }
  // Freeze the provider config together with the capability snapshot. Every
  // retry/repair for this logical batch must use this same model.
  const frozenConfig = input.frozenConfig || (await freezeStoryMemoryLLMConfig());

  const attemptBudget =
    input.attemptBudget ||
    new StoryMemoryAttemptBudget({
      logicalBatchId: createStoryMemoryLogicalBatchId({
        projectId,
        fromPosition: input.chapters[0].position,
        throughPosition: input.chapters.at(-1)!.position,
        kind: input.scenario || 'checkpoint',
      }),
      projectId,
      fromPosition: input.chapters[0].position,
      throughPosition: input.chapters.at(-1)!.position,
      maxPhysicalRequests: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
      durable: false,
    });

  return runCheckpointAttemptLoop({
    chapters: input.chapters,
    previousState: input.previousState,
    memoryPatchMaxTokens: input.memoryPatchMaxTokens,
    scenario,
    projectId,
    signal: input.signal,
    getDisplayNumber,
    baseMessages: messages,
    materials,
    frozenConfig,
    attemptBudget,
    onProgress: input.onProgress,
  });
}

export interface StoryMemoryCheckpointProgressEvent {
  phase:
    | 'planning'
    | 'requesting'
    | 'validating'
    | 'applying'
    | 'saving';
  fromPosition: number;
  throughPosition: number;
  attempt: number | null;
  maxAttempts: number;
}

interface CheckpointAttemptLoopInput {
  chapters: Chapter[];
  previousState: StoryMemoryState;
  memoryPatchMaxTokens: number;
  scenario: string;
  projectId: number;
  signal?: AbortSignal;
  getDisplayNumber?: (position: number) => number;
  baseMessages: Array<{ role: 'system' | 'user'; content: string }>;
  /**
   * Tiered prompt materials (governance §5). When present and the frozen
   * config carries a known capability, the loop plans each attempt through
   * the elastic allocator instead of the legacy hard-window planner. Repair /
   * fresh-retry append their own messages after the base, so the elastic plan
   * is only the source of the primary plan + the split decision.
   */
  materials?: StoryMemoryCheckpointMaterials;
  frozenConfig: FrozenStoryMemoryLLMConfig;
  attemptBudget: StoryMemoryAttemptBudget;
  onProgress?: (progress: StoryMemoryCheckpointProgressEvent) => void;
}

/**
 * Decide whether a paid Repair round can safely fit the model window
 * (governance plan §7.3).
 *
 * A Repair echoes the invalid assistant output plus a repair instruction on
 * top of the original prompt. If the invalid output itself is so large that
 * adding it would push the request past the hard input limit, we must NOT
 * truncate the invalid JSON (that would corrupt the repair signal). Instead
 * the caller skips Repair and falls through to a Fresh Retry.
 *
 * `invalidOutputTokens` is the estimated token cost of the model's previous
 * (invalid) JSON output. `baseInputTokens` is the original prompt's estimated
 * input tokens. `repairInstructionTokens` is the repair directive cost.
 * `hardInputLimit` is the model's hard input ceiling.
 */
export function shouldSkipRepairForInfeasibleSize(input: {
  invalidOutputTokens: number;
  baseInputTokens: number;
  repairInstructionTokens: number;
  hardInputLimit: number;
  contextWindow: number;
}): boolean {
  // Unknown capability → keep the legacy behaviour (attempt the repair).
  if (input.contextWindow <= 0 || input.hardInputLimit <= 0) return false;
  const repairInputEstimate =
    input.baseInputTokens + input.invalidOutputTokens + input.repairInstructionTokens;
  return repairInputEstimate > input.hardInputLimit;
}

/**
 * Bounded checkpoint attempt coordinator (repair plan P1 §6.2).
 *
 * - At most STORY_MEMORY_MAX_PHYSICAL_REQUESTS physical LLM calls per batch.
 * - Empty responses are classified by `emptyReason`/`finishReason`:
 *   reasoning_only → fresh retry with thinking disabled; length → raise
 *   budget within model caps; empty → one fresh retry; no_choices /
 *   content_filter → actionable failure without blind retries.
 * - An empty output NEVER constructs an `assistant: ''` repair dialogue.
 * - When the budget hits the model cap while the output is still truncated
 *   (or the window cannot fit even one chapter), the batch is split by
 *   MEMORY_CHECKPOINT_BATCH_TOO_LARGE — runStoryMemoryCheckpointBatch
 *   re-runs the sub-batches sequentially, keeping partial success.
 */
async function runCheckpointAttemptLoop(
  input: CheckpointAttemptLoopInput,
): Promise<StoryMemoryBatchPatchDraft> {
  const batchSize = input.chapters.length;

  let messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> =
    input.baseMessages;
  let attempt = 0;
  while (attempt < STORY_MEMORY_MAX_PHYSICAL_REQUESTS) {
    attempt += 1;
    if (input.signal?.aborted) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_CANCELLED',
        '故事记忆检查点任务已取消。',
      );
    }
    const scenario =
      attempt === 1
        ? input.scenario
        : attempt === 2
          ? 'story_memory_checkpoint_repair'
          : 'story_memory_checkpoint_retry';
    // Elastic allocator path (governance §5) for the primary attempt when a
    // real capability is known and tiered materials are available. Repair /
    // fresh-retry append their own dialogue, so they keep using the legacy
    // per-message planner (also independently planned — Phase 5).
    const capabilityKnown =
      input.frozenConfig.contextWindow > 0 ||
      input.frozenConfig.maxOutputTokens > 0;
    const useElastic = attempt === 1 && capabilityKnown && Boolean(input.materials);
    const elasticPlan = useElastic
      ? planStoryMemoryElasticRequest({
          config: input.frozenConfig,
          materials: input.materials!,
          batchSize,
          legacyOutputTokens: input.memoryPatchMaxTokens,
        })
      : null;
    const legacyPlan = elasticPlan
      ? null
      : planStoryMemoryRequest({
          config: input.frozenConfig,
          messages,
          legacyOutputTokens: input.memoryPatchMaxTokens,
          batchSize,
        });
    const plan = {
      fits: elasticPlan
        ? elasticPlan.strategy === 'full_prompt'
        : legacyPlan!.fits,
      maxTokens: elasticPlan ? elasticPlan.maxTokens : legacyPlan!.maxTokens,
      reason: elasticPlan ? elasticPlan.reason : legacyPlan!.reason,
      // On the elastic fast path, prefer the allocator-built messages so the
      // compact path's clipped modules are what we actually send.
      messages:
        elasticPlan && elasticPlan.messages.length
          ? elasticPlan.messages
          : messages,
    };
    input.onProgress?.({
      phase: 'planning',
      fromPosition: input.chapters[0].position,
      throughPosition: input.chapters.at(-1)!.position,
      attempt: null,
      maxAttempts: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
    });
    if (!plan.fits) {
      if (batchSize > 1) {
        throw new StoryMemoryError(
          'MEMORY_CHECKPOINT_BATCH_TOO_LARGE',
          `${plan.reason} 已在发送前拆分批次。`,
        );
      }
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_FAILED',
        plan.reason || '当前模型无法容纳单章长期记忆请求。',
      );
    }
    let result: LLMResult;
    try {
      input.onProgress?.({
        phase: 'requesting',
        fromPosition: input.chapters[0].position,
        throughPosition: input.chapters.at(-1)!.position,
        attempt,
        maxAttempts: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
      });
      result = await requestCheckpoint(
        plan.messages,
        plan.maxTokens,
        input.projectId,
        scenario,
        input.signal,
        input.attemptBudget,
        input.frozenConfig,
      );
    } catch (error) {
      if (
        !input.signal?.aborted &&
        isSafeStoryMemoryRetryError(error) &&
        attempt < STORY_MEMORY_MAX_PHYSICAL_REQUESTS &&
        (input.attemptBudget.hasObservedPhysicalRequest
          ? input.attemptBudget.canSend()
          : true)
      ) {
        messages = input.baseMessages;
        continue;
      }
      throw error;
    }
    input.onProgress?.({
      phase: 'validating',
      fromPosition: input.chapters[0].position,
      throughPosition: input.chapters.at(-1)!.position,
      attempt,
      maxAttempts: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
    });
    const text = result?.text?.trim() || '';

    if (text) {
      try {
        return parseAndValidateBatchPatch(
          text,
          input.previousState,
          input.chapters,
          { getDisplayNumber: input.getDisplayNumber },
        );
      } catch (parseError) {
        if (input.signal?.aborted) {
          throw new StoryMemoryError(
            'MEMORY_CHECKPOINT_CANCELLED',
            '故事记忆检查点任务已取消。',
          );
        }
        const physicalAttempt = input.attemptBudget.hasObservedPhysicalRequest
          ? input.attemptBudget.used
          : attempt;
        if (physicalAttempt >= STORY_MEMORY_MAX_PHYSICAL_REQUESTS) {
          if (
            parseError instanceof StoryMemoryError &&
            parseError.code === 'MEMORY_CHECKPOINT_EVIDENCE_NOT_FOUND'
          ) {
            try {
              return parseAndValidateBatchPatch(
                text,
                input.previousState,
                input.chapters,
                { recoverEvidence: true, getDisplayNumber: input.getDisplayNumber },
              );
            } catch {
              // keep precise error below
            }
          }
          if (result.finishReason === 'length') {
            if (batchSize > 1) {
              throw new StoryMemoryError(
                'MEMORY_CHECKPOINT_BATCH_TOO_LARGE',
                `模型连续返回被截断的检查点 JSON（输出 reservation 为 ${plan.maxTokens} tokens），已拆分批次重试。`,
              );
            }
            throw new StoryMemoryError(
              'MEMORY_CHECKPOINT_FAILED',
              `模型单章检查点输出仍被截断（输出 reservation 为 ${plan.maxTokens} tokens）。请提高模型的 max_output_tokens 或 context_window 后重试。`,
            );
          }
          throw parseError;
        }
        const message =
          parseError instanceof Error ? parseError.message : '未知校验错误';
        const budget = plan.maxTokens;
        if (
          !input.frozenConfig.contextWindow &&
          !input.frozenConfig.maxOutputTokens &&
          result.finishReason === 'length'
        ) {
          // Budget cannot grow further while the output is still truncated.
          if (batchSize > 1) {
            throw new StoryMemoryError(
              'MEMORY_CHECKPOINT_BATCH_TOO_LARGE',
              '输出预算已达模型上限而 JSON 仍未完整，已拆分批次重试。',
            );
          }
          throw new StoryMemoryError(
            'MEMORY_CHECKPOINT_FAILED',
            `输出预算已达模型上限（${budget} tokens），模型仍无法返回完整 JSON。请提高 max_output_tokens 后重试。`,
          );
        }
        messages =
          attempt === 1
            ? // Governance §7.3: if the invalid output is so large that echoing
              // it for a paid Repair would exceed the model's hard input limit,
              // skip Repair (never truncate the invalid JSON) and fall through
              // to a Fresh Retry instead.
              shouldSkipRepairForInfeasibleSize({
                invalidOutputTokens: estimateTokens(text),
                baseInputTokens: estimateTokens(
                  input.baseMessages.map(m => m.content).join('\n'),
                ),
                repairInstructionTokens: 200,
                hardInputLimit: input.frozenConfig.contextWindow
                  ? Math.max(
                      0,
                      input.frozenConfig.contextWindow -
                        plan.maxTokens -
                        Math.min(
                          1024,
                          Math.max(256, Math.floor(input.frozenConfig.contextWindow * 0.02)),
                        ),
                    )
                  : 0,
                contextWindow: input.frozenConfig.contextWindow,
              })
              ? buildStoryMemoryCheckpointRetryMessages(
                  input.baseMessages,
                  `${message}（invalid 输出过大，已跳过 Repair 直接 Fresh Retry）`,
                )
              : buildStoryMemoryCheckpointRepairMessages(
                  input.baseMessages,
                  text,
                  `${message}${
                    result.finishReason === 'length'
                      ? '（输出达到长度上限）'
                      : ''
                  }`,
                )
            : // Second consecutive parse failure → fresh retry WITHOUT echoing
              // the invalid assistant output (mirrors the legacy coordinator).
              buildStoryMemoryCheckpointRetryMessages(
                input.baseMessages,
                `${message}${
                  result.finishReason === 'length'
                    ? '（输出达到长度上限）'
                    : ''
                }`,
              );
      }
    } else {
      const action = decideEmptyResponseAction({
        emptyReason: result?.emptyReason,
        finishReason: result?.finishReason,
        attempt: input.attemptBudget.hasObservedPhysicalRequest
          ? input.attemptBudget.used
          : attempt,
        maxAttempts: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
        currentBudget: plan.maxTokens,
        nextBudget: plan.maxTokens,
      });
      if (action.type === 'fail') {
        // Code-review fix 4: an empty LENGTH response at the budget cap means
        // this batch is too big for the model — split instead of failing.
        if (action.shrinkBatch && batchSize > 1) {
          throw new StoryMemoryError(
            'MEMORY_CHECKPOINT_BATCH_TOO_LARGE',
            '模型返回空输出且输出预算已达模型上限，已拆分批次重试。',
          );
        }
        throw new StoryMemoryError(
          action.code as StoryMemoryError['code'],
          action.reason,
        );
      }
      // Fresh retry — never echo an empty assistant message.
      messages = input.baseMessages;
    }
  }
  throw new StoryMemoryError(
    'MEMORY_CHECKPOINT_FAILED',
    '检查点生成失败，已超过最大尝试次数。',
  );
}

export interface RunCheckpointBatchResult {
  state: StoryMemoryState;
  batch: StoredStoryMemoryBatch;
  chapterSummaryTexts: Array<{ chapterId: number; text: string }>;
}

export async function runStoryMemoryCheckpointBatch(input: {
  projectId: number;
  chapters: Chapter[];
  previousState: StoryMemoryState;
  /**
   * Fingerprint currently persisted in project_story_memory. During a rebuild
   * this can differ from previousState because the latter comes from an older
   * snapshot. The repository uses it as the atomic compare-and-swap guard.
   */
  expectedPersistedFingerprint?: string;
  memoryPatchMaxTokens?: number;
  /** One frozen provider/capability snapshot shared by all split children. */
  frozenConfig?: FrozenStoryMemoryLLMConfig;
  createSnapshot?: boolean;
  signal?: AbortSignal;
  scenario?:
    | 'story_memory_checkpoint'
    | 'story_memory_checkpoint_legacy_bootstrap';
  onProgress?: (progress: StoryMemoryCheckpointProgressEvent) => void;
  /**
   * Fired once per persisted split child (governance §9). When a 3-chapter
   * logical batch splits 2+1 and the first half is persisted, this fires
   * before the second half begins, so the task store can advance
   * completedChapters incrementally rather than only at full-batch success.
   */
  onChildBatchComplete?: (range: {
    fromPosition: number;
    throughPosition: number;
  }) => void;
}): Promise<RunCheckpointBatchResult> {
  const ordered = [...input.chapters].sort((a, b) => a.position - b.position);
  if (!ordered.length) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_RANGE_MISMATCH',
      '检查点批次不能为空。',
    );
  }
  const config =
    input.memoryPatchMaxTokens != null
      ? { memoryPatchMaxTokens: input.memoryPatchMaxTokens }
      : await db.getContextConfig();
  const frozenConfig =
    input.frozenConfig || (await freezeStoryMemoryLLMConfig());
  return runStoryMemoryCheckpointBatchWithShrink(
    { ...input, chapters: ordered, frozenConfig },
    config.memoryPatchMaxTokens || 1200,
  );
}

/**
 * V2.11.38 repair plan P1 §6.2/§8.2: when a batch is too large for the model
 * (MEMORY_CHECKPOINT_BATCH_TOO_LARGE), split it in half and run the halves
 * sequentially. The first half is persisted before the second half starts, so
 * a failure on the second half still keeps the first half's clean checkpoint
 * (partial success semantics). One chapter that still cannot fit surfaces an
 * actionable model-capability error.
 *
 * Code-review fix 1: when the FIRST half succeeded and the SECOND half fails,
 * the thrown error carries `partial` (the latest persisted state, its
 * completed-chapter count and summary texts). Outer coordinators (advance /
 * rebuild) consume it so they write back the newest successful status —
 * never the stale function-entry empty/dirty snapshot, and never 'failed'.
 */
async function runStoryMemoryCheckpointBatchWithShrink(
  input: Parameters<typeof runStoryMemoryCheckpointBatch>[0],
  memoryPatchMaxTokens: number,
): Promise<RunCheckpointBatchResult> {
  try {
    return await runStoryMemoryCheckpointBatchCore(
      input,
      memoryPatchMaxTokens,
    );
  } catch (error) {
    if (
      error instanceof StoryMemoryError &&
      error.code === 'MEMORY_CHECKPOINT_BATCH_TOO_LARGE' &&
      input.chapters.length > 1
    ) {
      const half = Math.ceil(input.chapters.length / 2);
      const firstChapters = input.chapters.slice(0, half);
      const first = await runStoryMemoryCheckpointBatchWithShrink(
        { ...input, chapters: firstChapters },
        memoryPatchMaxTokens,
      );
      // Governance §9: surface the first split child's persistence as
      // incremental progress so the task store's completedChapters reflects
      // real work even if the second child later fails.
      input.onChildBatchComplete?.({
        fromPosition: firstChapters[0].position,
        throughPosition: firstChapters.at(-1)!.position,
      });
      try {
        const second = await runStoryMemoryCheckpointBatchWithShrink(
          {
            ...input,
            chapters: input.chapters.slice(half),
            previousState: first.state,
            expectedPersistedFingerprint:
              first.state.metadata.stateFingerprint,
          },
          memoryPatchMaxTokens,
        );
        return {
          state: second.state,
          batch: second.batch,
          chapterSummaryTexts: [
            ...first.chapterSummaryTexts,
            ...second.chapterSummaryTexts,
          ],
        };
      } catch (secondError) {
        // The first half is already persisted and MUST NOT be rolled back or
        // overwritten by the caller's stale state. Attach the latest
        // successful state to the failure (any error type — a plain network
        // Error must keep its own classification while still carrying the
        // partial success). If the second half itself already carried an
        // inner partial (deeper split), keep that newer state and accumulate
        // its completed chapters.
        const innerPartial = (secondError as {
          partial?: StoryMemoryPartialSuccess;
        }).partial;
        const merged: StoryMemoryPartialSuccess = innerPartial
          ? {
              state: innerPartial.state,
              completedChapters:
                innerPartial.completedChapters +
                first.chapterSummaryTexts.length,
              chapterSummaryTexts: [
                ...first.chapterSummaryTexts,
                ...innerPartial.chapterSummaryTexts,
              ],
            }
          : {
              state: first.state,
              completedChapters: first.chapterSummaryTexts.length,
              chapterSummaryTexts: first.chapterSummaryTexts,
            };
        (secondError as { partial?: StoryMemoryPartialSuccess }).partial =
          merged;
        throw secondError;
      }
    }
    throw error;
  }
}

async function runStoryMemoryCheckpointBatchCore(
  input: Parameters<typeof runStoryMemoryCheckpointBatch>[0],
  memoryPatchMaxTokens: number,
): Promise<RunCheckpointBatchResult> {
  const ordered = [...input.chapters].sort((a, b) => a.position - b.position);
  const attemptBudget = new StoryMemoryAttemptBudget({
    logicalBatchId: createStoryMemoryLogicalBatchId({
      projectId: input.projectId,
      fromPosition: ordered[0].position,
      throughPosition: ordered.at(-1)!.position,
      kind: input.scenario || 'checkpoint',
    }),
    projectId: input.projectId,
    fromPosition: ordered[0].position,
    throughPosition: ordered.at(-1)!.position,
    maxPhysicalRequests: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
  });
  const draft = await generateValidatedCheckpointBatch({
    chapters: ordered,
    previousState: input.previousState,
    memoryPatchMaxTokens,
    frozenConfig: input.frozenConfig,
    signal: input.signal,
    scenario: input.scenario,
    attemptBudget,
    onProgress: input.onProgress,
  });
  const sourceFingerprint = fingerprintBatchSource(ordered);
  const batchId = `batch_${input.projectId}_${ordered[0].position}_${
    ordered[ordered.length - 1].position
  }_${sourceFingerprint}`;
  const applied = applyStoryMemoryBatchPatch(input.previousState, draft, {
    projectId: input.projectId,
    sourceFingerprint,
    baseMemoryFingerprint: fingerprintStoryMemoryState(input.previousState),
    now: new Date().toISOString(),
    batchId,
    title: ordered[ordered.length - 1].title,
  });
  input.onProgress?.({
    phase: 'applying',
    fromPosition: ordered[0].position,
    throughPosition: ordered.at(-1)!.position,
    attempt: null,
    maxAttempts: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
  });
  const chapterSummaryTexts = draft.chapterSummaries.map(summary => {
    const chapter = ordered.find(item => item.id === summary.chapterId);
    const episodic: EpisodicSummary = {
      brief: summary.brief,
      keywords: summary.keywords,
      events: summary.events,
      characterChanges: summary.characterChanges,
      relationshipChanges: summary.relationshipChanges,
      mainlineChanges: summary.mainlineChanges,
      newThreads: summary.newThreads,
      resolvedThreads: summary.resolvedThreads,
    };
    const text = renderBatchEpisodicText(episodic, chapter);
    return {
      chapterId: summary.chapterId,
      text,
      estimatedTokens: estimateTokens(text),
    };
  });
  input.onProgress?.({
    phase: 'saving',
    fromPosition: ordered[0].position,
    throughPosition: ordered.at(-1)!.position,
    attempt: null,
    maxAttempts: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
  });
  await db.saveStoryMemoryBatchUpdate({
    previousFingerprint:
      input.expectedPersistedFingerprint ||
      input.previousState.metadata.stateFingerprint,
    state: applied.state,
    batch: applied.resolvedBatch,
    chapterSummaries: chapterSummaryTexts,
    createSnapshot: input.createSnapshot !== false,
  });
  invalidateIdf(input.projectId);
  return {
    state: applied.state,
    batch: applied.resolvedBatch,
    chapterSummaryTexts,
  };
}

/**
 * Apply one or more checkpoint batches for pending chapters under project lock.
 * Always uses one LLM request per batch (max 10 chapters), never N per-chapter patches.
 */
/**
 * Advance checkpoints for pending final chapters.
 * Caller must already hold the project memory lock (or guarantee single-flight).
 */
export async function advanceStoryMemoryCheckpointsUnlocked(input: {
  projectId: number;
  throughPosition?: number;
  signal?: AbortSignal;
  onProgress?: (progress: StoryMemoryCheckpointProgressEvent) => void;
  onBatchComplete?: (range: {
    fromPosition: number;
    throughPosition: number;
  }) => void;
  /**
   * Per persisted split child (governance §9). When a logical batch splits,
   * this fires as each child half is persisted, so the task store advances
   * completedChapters incrementally. If a logical batch does NOT split, only
   * onBatchComplete fires (once, for the whole batch).
   */
  onChildBatchComplete?: (range: {
    fromPosition: number;
    throughPosition: number;
  }) => void;
}): Promise<{
  state: StoryMemoryState;
  batchesApplied: number;
  pendingRemaining: number;
}> {
  const chapters = (await db.getChaptersByProject(input.projectId)).filter(
    chapter =>
      Boolean(chapter.content?.trim()) &&
      (chapter.status === 'final' ||
        chapter.finalized_at != null ||
        Boolean(chapter.memory_summary?.trim())),
  );
  const record = await db.ensureProjectStoryMemoryRow(input.projectId);
  let state = record.state;
  const throughCap =
    input.throughPosition ??
    chapters.at(-1)?.position ??
    state.throughChapterPosition;
  const pending = chapters
    .filter(
      chapter =>
        chapter.position > state.throughChapterPosition &&
        chapter.position <= throughCap,
    )
    .sort((a, b) => a.position - b.position);
  if (!pending.length) {
    return {
      state,
      batchesApplied: 0,
      pendingRemaining: 0,
    };
  }
  // Fixed safe LLM batch size, decoupled from the trigger interval: even when
  // the policy interval is 10 chapters, one extraction call never handles more
  // than STORY_MEMORY_DEFAULT_BATCH_SIZE (3) chapters.
  const batches = splitCheckpointBatches(
    pending,
    STORY_MEMORY_DEFAULT_BATCH_SIZE,
  );
  let batchesApplied = 0;
  for (const batchChapters of batches) {
    if (input.signal?.aborted) {
      throw new StoryMemoryError(
        'MEMORY_CHECKPOINT_CANCELLED',
        '故事记忆检查点任务已取消。',
      );
    }
    try {
      const result = await runStoryMemoryCheckpointBatch({
        projectId: input.projectId,
        chapters: batchChapters,
        previousState: state,
        signal: input.signal,
        onProgress: input.onProgress,
        onChildBatchComplete: input.onChildBatchComplete,
      });
      state = result.state;
      batchesApplied += 1;
      input.onBatchComplete?.({
        fromPosition: batchChapters[0].position,
        throughPosition: batchChapters.at(-1)!.position,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '检查点更新失败';
      if (
        error instanceof StoryMemoryError &&
        error.code === 'MEMORY_BASE_FINGERPRINT_MISMATCH'
      ) {
        await db.markStoryMemoryDirty(
          input.projectId,
          batchChapters[0]?.position ?? state.throughChapterPosition + 1,
          message,
        );
        throw error;
      }
      // Append-only checkpoint advance failure: the previously successful
      // checkpoint remains valid (it is the latest SUCCESSFUL state, still
      // persisted in the row). Preserve the latest persisted status — never
      // flip a clean/empty record to 'failed', and never write back the
      // function-entry status: after batch1 succeeded `state` carries the
      // persisted clean status, while `record` (entry snapshot) still says
      // 'empty' and would clobber the row back to empty. When a split batch
      // persisted its first half and failed on the second, the error carries
      // `partial.state` — the newest persisted state — which is even newer
      // than `state`. `lastError` still records the failed attempt.
      const partial = (error as { partial?: StoryMemoryPartialSuccess } | null)
        ?.partial;
      const latestState = partial?.state ?? state;
      await db.setStoryMemoryBuildStatus(
        input.projectId,
        latestState.metadata.status,
        latestState.metadata.dirtyFromPosition,
        message,
      );
      throw error;
    }
  }
  const remaining = chapters.filter(
    chapter => chapter.position > state.throughChapterPosition,
  ).length;
  return { state, batchesApplied, pendingRemaining: remaining };
}
