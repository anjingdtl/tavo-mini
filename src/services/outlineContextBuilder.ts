/**
 * Outline context builder (大纲创作模式升级).
 *
 * Stitches the enabled outlines of an outline-mode project into a single
 * high-priority context block with its OWN token budget, independent from the
 * ordinary `resourceBudget` (characters/worldbook/notes).
 *
 * Core invariants (see optimization plan §3 / §5):
 *  1. Only `project.mode === 'outline'` projects get outline context. Any other
 *     mode (continuation / freeform) returns the empty context — they must never
 *     be silently injected.
 *  2. Only enabled outlines are stitched, in deterministic position order.
 *  3. Outlines are NEVER silently truncated. If the full set does not fit the
 *     budget, `complete` is false and a `blockingReason` explains the gap; the
 *     pipeline must block before calling the model rather than clipping.
 *  4. A stable fingerprint covers contract version + full stitched text so
 *     title / content / order / enable set / format changes are all detected.
 *
 * Single authority: {@link computeOutlinePacking} is the pure packing function
 * used by Pipeline, Context Preview, and Outline Management UI.
 */
import type { ProjectMode } from '../types/novel';
import type { Outline } from '../types/outline';
import { getEnabledOutlinesByProject } from '../data/repositories/outlineRepository';
import { estimateTokens } from '../utils/tokenEstimator';
import { sha256Hex } from './continuation/hashUtils';

/** Bump when the outline contract header/rules text changes. */
export const OUTLINE_CONTRACT_VERSION = 1;

/** A single outline's identifying info used to build the snapshot fingerprint. */
export interface OutlineVersionEntry {
  id: number;
  updatedAt: number;
  hash: string;
  position: number;
  title?: string;
}

/** Per-outline packing detail shared by UI / preview / pipeline. */
export interface OutlinePackingItem {
  id: number;
  title: string;
  position: number;
  contentTokens: number;
  /** Tokens of the rendered section (title + body labels included). */
  renderedTokens: number;
  renderedText: string;
  contentHash: string;
  enabled: boolean;
}

/** Result of the pure outline packing function. */
export interface OutlinePackingResult {
  stitchedText: string;
  totalTokens: number;
  sharedOverheadTokens: number;
  items: OutlinePackingItem[];
  fingerprint: string;
  complete: boolean;
  overageTokens: number;
  suggestedDisableIds: number[];
  outlineIds: number[];
  outlineVersions: OutlineVersionEntry[];
  /** Per-outline rendered tokens in stitch order (UI-compatible). */
  perOutlineTokens: number[];
}

/** Result of stitching the enabled outlines into one context block. */
export interface BuiltOutlineContext {
  /** Fully stitched outline text (complete, never truncated). */
  text: string;
  /** Ids of the outlines actually included, in stitch order. */
  outlineIds: number[];
  /** Per-outline identity info for the snapshot fingerprint. */
  outlineVersions: OutlineVersionEntry[];
  /** Token estimate of the stitched text (header included). */
  estimatedTokens: number;
  /** Number of enabled outlines that were stitched. */
  enabledCount: number;
  /** True iff the full text fits the budget. False → pipeline must block. */
  complete: boolean;
  /** Human-readable reason when `complete` is false. */
  blockingReason?: string;
  /** Stable content fingerprint (contract + stitched text). */
  fingerprint: string;
  /**
   * Per-outline token estimates (rendered section) in stitch order.
   * Used by the management UI and the preview blocking panel.
   */
  perOutlineTokens: number[];
  /** The budget that was checked against, or 0 when budget is unknown. */
  outlineBudgetTokens: number;
  /** Structured packing detail for UI/trace. */
  packingItems?: OutlinePackingItem[];
  sharedOverheadTokens?: number;
}

/**
 * Budget guidance for the outline management UI and blocking panels. Tells the
 * user how much they are over budget and suggests the lowest-priority enabled
 * outlines to disable so the full set fits without silent truncation.
 */
export interface OutlineBudgetGuidance {
  /** Sum of all enabled outlines' tokens (matches packing total). */
  totalTokens: number;
  /** Budget derived from the model context window (0 if unknown). */
  budgetTokens: number;
  /** True when totalTokens exceeds budgetTokens (and budget > 0). */
  overBudget: boolean;
  /** How many tokens over budget (0 if not over). */
  overageTokens: number;
  /**
   * Ids of enabled outlines to disable (lowest priority first) so the remaining
   * set fits the budget. Empty when not over budget or budget unknown.
   */
  suggestedDisableIds: number[];
}

/** Structured fail-closed errors for outline context building. */
export type OutlineContextErrorCode =
  | 'OUTLINE_READ_FAILED'
  | 'OUTLINE_BUDGET_UNKNOWN'
  | 'OUTLINE_OVER_BUDGET'
  | 'OUTLINE_CONTEXT_WINDOW_EXCEEDED'
  | 'OUTLINE_SNAPSHOT_INVALID'
  | 'OUTLINE_MODEL_UNAVAILABLE'
  | 'OUTLINE_SNAPSHOT_PERSIST_FAILED'
  | 'OUTLINE_EXECUTION_CONFIG_INVALID'
  | 'ACTIVE_WRITER_STYLE_MISSING'
  | 'WRITER_STYLE_OVER_BUDGET'
  // Stability Plan §14 — snapshot domain error codes.
  | 'SNAPSHOT_FINGERPRINT_MISMATCH'
  | 'SNAPSHOT_PARSE_FAILED';

export class OutlineContextError extends Error {
  readonly code: OutlineContextErrorCode;
  readonly userAction?:
    | 'open_outlines'
    | 'open_llm_settings'
    | 'restart_task'
    | 'open_writer_style'
    | 'open_task_center';

  constructor(
    code: OutlineContextErrorCode,
    message: string,
    userAction?: OutlineContextError['userAction'],
  ) {
    super(message);
    this.name = 'OutlineContextError';
    this.code = code;
    this.userAction = userAction;
  }
}

/** The empty context returned for non-outline modes / no enabled outlines. */
export const EMPTY_OUTLINE_CONTEXT: BuiltOutlineContext = {
  text: '',
  outlineIds: [],
  outlineVersions: [],
  estimatedTokens: 0,
  enabledCount: 0,
  complete: true,
  fingerprint: '',
  perOutlineTokens: [],
  outlineBudgetTokens: 0,
  packingItems: [],
  sharedOverheadTokens: 0,
};

/** Header prefix explaining the semantics of the outline block. */
const OUTLINE_HEADER =
  '【项目大纲｜最高创作约束】\n' +
  '以下内容用于约束尚未发生的剧情走向。' +
  '它不是当前已发生事实，也不代表人物已经知道未来事件。';

/** Outline contract rules prepended to the stitched block. */
const OUTLINE_CONTRACT =
  '大纲约束规则：\n' +
  '1. 已写成的历史事实不可回滚。\n' +
  '2. 对尚未发生的剧情，必须服从项目大纲。\n' +
  '3. 当前章节目标只能细化大纲，不得改变主线。\n' +
  '4. 角色卡、世界书、笔记和作家风格不得覆盖大纲主线。\n' +
  '5. 不得提前完成属于后续阶段的关键事件。\n' +
  '6. 多份大纲冲突时，按注入顺序采用靠前内容。\n' +
  '7. 如大纲与既有事实冲突，应从当前状态合理拉回，而不是篡改过去。';

/**
 * Management-page suggestion: fraction of the model context window recommended
 * for outlines. This is NOT a hard generation block.
 *
 * Actual generation uses the conservation budget (full outline + fixed prompt +
 * mandatory body + output reserve + safety margin vs window). Soft materials
 * compress first; only true total overflow blocks the call.
 */
export const OUTLINE_BUDGET_RATIO = 0.3;

/**
 * Soft management suggestion budget (30% of window).
 * Do not use this alone to block generation — see
 * `deriveGenerationOutlineBudgetTokens` in contextBuilder.
 */
export function deriveOutlineBudgetTokens(contextWindow: number): number {
  if (!(contextWindow > 0)) return 0;
  return Math.floor(contextWindow * OUTLINE_BUDGET_RATIO);
}

/**
 * Provider / tokenizer safety margin for final request window checks.
 * max(512, ~4% of context window).
 */
export function deriveContextSafetyMargin(contextWindow: number): number {
  if (!(contextWindow > 0)) return 512;
  return Math.max(512, Math.floor(contextWindow * 0.04));
}

/**
 * Final compiled-request window check used by every pipeline stage (and
 * retries). Returns null when the request fits; otherwise a user-facing
 * Chinese error message.
 */
export function checkRequestFitsContextWindow(params: {
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  contextWindow: number;
  stageLabel?: string;
}): string | null {
  const {
    estimatedInputTokens,
    reservedOutputTokens,
    contextWindow,
    stageLabel,
  } = params;
  if (!(contextWindow > 0)) {
    return '未配置有效的模型上下文窗口，无法安全发起生成。请先在设置中配置活动模型的 context window。';
  }
  const safety = deriveContextSafetyMargin(contextWindow);
  const total =
    estimatedInputTokens + Math.max(0, reservedOutputTokens) + safety;
  if (total <= contextWindow) return null;
  const stage = stageLabel ? `（${stageLabel}）` : '';
  const deficit = total - contextWindow;
  return (
    `请求超出模型上下文窗口${stage}：输入约 ${estimatedInputTokens.toLocaleString()} + ` +
    `输出预留 ${reservedOutputTokens.toLocaleString()} + 安全余量 ${safety.toLocaleString()} ` +
    `= ${total.toLocaleString()}，超过窗口 ${contextWindow.toLocaleString()} ` +
    `（超 ${deficit.toLocaleString()} tokens）。请关闭部分大纲、缩短正文资料，或更换更大上下文模型。`
  );
}

/**
 * Pure packing function — single authority for stitch text, tokens, fingerprint,
 * completeness and disable suggestions. Used by Pipeline / Preview / Outline UI.
 */
export function computeOutlinePacking(params: {
  outlines: Array<
    Pick<
      Outline,
      | 'id'
      | 'title'
      | 'content'
      | 'position'
      | 'contentHash'
      | 'enabled'
      | 'updatedAt'
    >
  >;
  budgetTokens: number;
  contractVersion?: number;
}): OutlinePackingResult {
  const contractVersion = params.contractVersion ?? OUTLINE_CONTRACT_VERSION;
  // Only enabled outlines participate; preserve caller order (expected position ASC).
  const enabled = params.outlines.filter(o => o.enabled !== false);
  if (enabled.length === 0) {
    return {
      stitchedText: '',
      totalTokens: 0,
      sharedOverheadTokens: 0,
      items: [],
      fingerprint: '',
      complete: true,
      overageTokens: 0,
      suggestedDisableIds: [],
      outlineIds: [],
      outlineVersions: [],
      perOutlineTokens: [],
    };
  }

  const sharedHeader = [OUTLINE_HEADER, OUTLINE_CONTRACT].join('\n\n');
  const sharedOverheadTokens = estimateTokens(sharedHeader);

  const items: OutlinePackingItem[] = enabled.map((outline, index) => {
    const priority = index === 0 ? '最高优先级' : '补充约束';
    const title = outline.title || `大纲 ${index + 1}`;
    const body = outline.content || '';
    const renderedText = `【大纲 ${index + 1}｜${priority}】\n标题：${title}\n正文：\n${body}`;
    return {
      id: outline.id,
      title,
      position: outline.position,
      contentTokens: estimateTokens(body),
      renderedTokens: estimateTokens(renderedText),
      renderedText,
      contentHash: outline.contentHash || '',
      enabled: true,
    };
  });

  const stitchedText = [sharedHeader, ...items.map(i => i.renderedText)].join(
    '\n\n',
  );
  const totalTokens = estimateTokens(stitchedText);
  const fingerprint = computeStitchedOutlineFingerprint(
    stitchedText,
    contractVersion,
  );

  const perOutlineTokens = items.map(i => i.renderedTokens);
  const outlineIds = items.map(i => i.id);
  const outlineVersions: OutlineVersionEntry[] = enabled.map((o, index) => ({
    id: o.id,
    updatedAt: o.updatedAt ?? 0,
    hash: o.contentHash || '',
    position: o.position,
    title: items[index].title,
  }));

  const complete =
    !(params.budgetTokens > 0) || totalTokens <= params.budgetTokens;
  const overageTokens =
    params.budgetTokens > 0 ? Math.max(0, totalTokens - params.budgetTokens) : 0;

  // Suggest disabling lowest-priority (tail) sections by re-packing each
  // candidate prefix and re-estimating tokens — never approximate by subtraction.
  const suggestedDisableIds: number[] = [];
  if (overageTokens > 0 && items.length > 0) {
    let keepCount = items.length;
    while (keepCount > 0) {
      const prefixItems = items.slice(0, keepCount);
      const prefixText = [
        sharedHeader,
        ...prefixItems.map(i => i.renderedText),
      ].join('\n\n');
      const prefixTokens = estimateTokens(prefixText);
      if (prefixTokens <= params.budgetTokens) break;
      keepCount -= 1;
    }
    for (let i = keepCount; i < items.length; i += 1) {
      suggestedDisableIds.push(items[i].id);
    }
  }

  return {
    stitchedText,
    totalTokens,
    sharedOverheadTokens,
    items,
    fingerprint,
    complete,
    overageTokens,
    suggestedDisableIds,
    outlineIds,
    outlineVersions,
    perOutlineTokens,
  };
}

/**
 * Fingerprint over contract version + full stitched text. Title-only edits,
 * content edits, reordering, enable-set changes and contract bumps all change
 * the digest.
 */
export function computeStitchedOutlineFingerprint(
  stitchedText: string,
  contractVersion: number = OUTLINE_CONTRACT_VERSION,
): string {
  if (!stitchedText) return '';
  return sha256Hex(`${contractVersion}\n${stitchedText}`).slice(0, 16);
}

/**
 * Build the outline context block for a project.
 *
 * Returns {@link EMPTY_OUTLINE_CONTEXT} for any non-outline mode, guaranteeing
 * continuation / freeform projects are never injected. For outline-mode
 * projects with enabled outlines, stitches them in position order and checks
 * the full text against the budget WITHOUT truncating.
 *
 * Repository / DB failures throw {@link OutlineContextError} (fail-closed).
 */
export async function buildOutlineContext(params: {
  projectId: number;
  projectMode: ProjectMode;
  outlineBudgetTokens: number;
}): Promise<BuiltOutlineContext> {
  const { projectId, projectMode, outlineBudgetTokens } = params;

  // Non-outline modes never receive outline context.
  if (projectMode !== 'outline') {
    return EMPTY_OUTLINE_CONTEXT;
  }

  let outlines: Outline[];
  try {
    outlines = await getEnabledOutlinesByProject(projectId);
  } catch (error: any) {
    throw new OutlineContextError(
      'OUTLINE_READ_FAILED',
      `读取项目大纲失败：${error?.message ? String(error.message) : '数据库错误'}`,
      'open_outlines',
    );
  }

  if (outlines.length === 0) {
    return EMPTY_OUTLINE_CONTEXT;
  }

  const packing = computeOutlinePacking({
    outlines,
    budgetTokens: outlineBudgetTokens,
  });

  if (!packing.complete) {
    const suggestText =
      packing.suggestedDisableIds.length > 0
        ? `建议先关闭靠后的 ${packing.suggestedDisableIds.length} 份大纲（分段启用），或缩短内容，或更换更大上下文模型。`
        : `建议缩短内容，或更换更大上下文模型。`;
    return {
      text: packing.stitchedText,
      outlineIds: packing.outlineIds,
      outlineVersions: packing.outlineVersions,
      estimatedTokens: packing.totalTokens,
      enabledCount: outlines.length,
      complete: false,
      blockingReason:
        `已启用大纲 ${outlines.length} 份，大纲总计 ${packing.totalTokens.toLocaleString()} tokens，` +
        `超出可用大纲空间 ${outlineBudgetTokens.toLocaleString()} tokens（超 ${packing.overageTokens.toLocaleString()}）。` +
        `${suggestText}可在「资料 - 大纲」中调整启用与排序。`,
      fingerprint: packing.fingerprint,
      perOutlineTokens: packing.perOutlineTokens,
      outlineBudgetTokens,
      packingItems: packing.items,
      sharedOverheadTokens: packing.sharedOverheadTokens,
    };
  }

  return {
    text: packing.stitchedText,
    outlineIds: packing.outlineIds,
    outlineVersions: packing.outlineVersions,
    estimatedTokens: packing.totalTokens,
    enabledCount: outlines.length,
    complete: true,
    fingerprint: packing.fingerprint,
    perOutlineTokens: packing.perOutlineTokens,
    outlineBudgetTokens,
    packingItems: packing.items,
    sharedOverheadTokens: packing.sharedOverheadTokens,
  };
}

/**
 * Legacy version-tuple fingerprint. Prefer
 * {@link computeStitchedOutlineFingerprint} for new code — title-only edits
 * are invisible to content-hash-only digests.
 */
export function computeOutlineFingerprint(
  versions: OutlineVersionEntry[],
): string {
  if (versions.length === 0) return '';
  const ordered = [...versions].sort(
    (a, b) => a.position - b.position || a.id - b.id,
  );
  const payload = ordered
    .map(v => `${v.id}:${v.position}:${v.hash}:${v.title ?? ''}`)
    .join('|');
  return sha256Hex(payload).slice(0, 16);
}

/**
 * Recompute the live outline fingerprint for a project (used at result-adoption
 * time to detect whether the outlines changed since the task started).
 */
export async function computeLiveOutlineFingerprint(
  projectId: number,
): Promise<string> {
  const outlines = await getEnabledOutlinesByProject(projectId);
  if (outlines.length === 0) return '';
  const packing = computeOutlinePacking({
    outlines,
    budgetTokens: 0,
  });
  return packing.fingerprint;
}

/**
 * Compute the full pipeline input fingerprint for a chapter generation task:
 * `hash(projectId | chapterId | chapterUpdatedAt | outlineFingerprint)`.
 */
export async function computeInputFingerprint(params: {
  projectId: number;
  chapterId: number;
  chapterUpdatedAt: number | string;
  outlineFingerprint?: string;
}): Promise<string> {
  const outlineFp =
    params.outlineFingerprint ??
    (await computeLiveOutlineFingerprint(params.projectId));
  const payload = `proj=${params.projectId}|chapter=${params.chapterId}|updatedAt=${params.chapterUpdatedAt}|outline=${outlineFp}`;
  return sha256Hex(payload).slice(0, 16);
}

/**
 * Compute budget guidance for the outline management UI and blocking panels.
 *
 * `perOutlineTokens` and `outlineIds` MUST be in the same order (stitch order).
 * Guidance greedily marks the LOWEST-priority enabled outlines as suggested
 * to disable until the remaining prefix fits the budget.
 *
 * When using shared overhead (header + contract), pass `sharedOverheadTokens`
 * so the suggestion accounts for fixed cost that cannot be disabled.
 */
export function computeOutlineBudgetGuidance(
  perOutlineTokens: number[],
  outlineIds: number[],
  budgetTokens: number,
  sharedOverheadTokens = 0,
): OutlineBudgetGuidance {
  const outlineSum = perOutlineTokens.reduce((sum, t) => sum + t, 0);
  const totalTokens = outlineSum + Math.max(0, sharedOverheadTokens);
  if (!(budgetTokens > 0)) {
    return {
      totalTokens,
      budgetTokens,
      overBudget: false,
      overageTokens: 0,
      suggestedDisableIds: [],
    };
  }
  const overageTokens = Math.max(0, totalTokens - budgetTokens);
  if (overageTokens === 0) {
    return {
      totalTokens,
      budgetTokens,
      overBudget: false,
      overageTokens: 0,
      suggestedDisableIds: [],
    };
  }
  const suggestedDisableIds: number[] = [];
  let runningTotal = totalTokens;
  for (let i = perOutlineTokens.length - 1; i >= 0; i -= 1) {
    if (runningTotal <= budgetTokens) break;
    suggestedDisableIds.push(outlineIds[i]);
    runningTotal -= perOutlineTokens[i];
  }
  return {
    totalTokens,
    budgetTokens,
    overBudget: true,
    overageTokens,
    suggestedDisableIds: suggestedDisableIds.reverse(),
  };
}

/**
 * Convenience for UI: pack enabled outlines and return budget guidance that
 * matches Pipeline token accounting (title + contract + separators included).
 */
export function computeOutlineBudgetGuidanceFromOutlines(
  outlines: Array<
    Pick<
      Outline,
      | 'id'
      | 'title'
      | 'content'
      | 'position'
      | 'contentHash'
      | 'enabled'
      | 'updatedAt'
    >
  >,
  budgetTokens: number,
): OutlineBudgetGuidance {
  const packing = computeOutlinePacking({ outlines, budgetTokens });
  return {
    totalTokens: packing.totalTokens,
    budgetTokens,
    overBudget: packing.overageTokens > 0 && budgetTokens > 0,
    overageTokens: packing.overageTokens,
    suggestedDisableIds: packing.suggestedDisableIds,
  };
}
