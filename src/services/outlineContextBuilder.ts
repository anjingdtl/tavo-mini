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
 *  4. A stable fingerprint captures ids + positions + content hashes so the
 *     pipeline snapshot can detect mid-task outline edits at adoption time.
 */
import type { ProjectMode } from '../types/novel';
import type { Outline } from '../types/outline';
import { getEnabledOutlinesByProject } from '../data/repositories/outlineRepository';
import { estimateTokens } from '../utils/tokenEstimator';
import { sha256Hex } from './continuation/hashUtils';

/** A single outline's identifying info used to build the snapshot fingerprint. */
export interface OutlineVersionEntry {
  id: number;
  updatedAt: number;
  hash: string;
  position: number;
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
  /** Stable content fingerprint (ids + positions + hashes). */
  fingerprint: string;
  /**
   * Per-outline token estimates (content only, no header) in stitch order.
   * Used by the management UI and the preview blocking panel to show exactly
   * which outlines are heaviest and to suggest which to disable first.
   */
  perOutlineTokens: number[];
  /** The budget that was checked against, or 0 when budget is unknown. */
  outlineBudgetTokens: number;
}

/**
 * Budget guidance for the outline management UI and blocking panels. Tells the
 * user how much they are over budget and suggests the lowest-priority enabled
 * outlines to disable so the full set fits without silent truncation.
 */
export interface OutlineBudgetGuidance {
  /** Sum of all enabled outlines' content tokens. */
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
  '4. 角色卡、世界书、笔记和预设不得覆盖大纲主线。\n' +
  '5. 不得提前完成属于后续阶段的关键事件。\n' +
  '6. 多份大纲冲突时，按注入顺序采用靠前内容。\n' +
  '7. 如大纲与既有事实冲突，应从当前状态合理拉回，而不是篡改过去。';

/**
 * Default fraction of the model context window reserved for outlines.
 *
 * Outlines are the highest creative constraint, so they get a generous slice,
 * but it is still bounded so an absurdly large outline cannot consume the
 * entire window. The pipeline subtracts this from the input side BEFORE
 * allocating the ordinary resource budget, so characters/notes/worldbook
 * compress first when space is tight.
 */
export const OUTLINE_BUDGET_RATIO = 0.3;

/** Derive the outline token budget from the model context window. */
export function deriveOutlineBudgetTokens(contextWindow: number): number {
  if (!(contextWindow > 0)) return 0;
  return Math.floor(contextWindow * OUTLINE_BUDGET_RATIO);
}

/**
 * Build the outline context block for a project.
 *
 * Returns {@link EMPTY_OUTLINE_CONTEXT} for any non-outline mode, guaranteeing
 * continuation / freeform projects are never injected. For outline-mode
 * projects with enabled outlines, stitches them in position order and checks
 * the full text against the budget WITHOUT truncating.
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

  const outlines = await getEnabledOutlinesByProject(projectId);
  if (outlines.length === 0) {
    return EMPTY_OUTLINE_CONTEXT;
  }

  const perOutlineTokens = outlines.map(o => estimateTokens(o.content || ''));
  const { text, versions } = stitchOutlines(outlines);
  const estimatedTokens = estimateTokens(text);

  const fingerprint = computeOutlineFingerprint(versions);

  // Strict budget check: never truncate. If the complete stitched text does not
  // fit, mark incomplete so the pipeline blocks before calling the model. The
  // blocking message tells the user exactly what to do (segmented enablement:
  // disable the lowest-priority outlines, shorten content, or switch model).
  if (outlineBudgetTokens > 0 && estimatedTokens > outlineBudgetTokens) {
    const guidance = computeOutlineBudgetGuidance(
      perOutlineTokens,
      outlines.map(o => o.id),
      outlineBudgetTokens,
    );
    const suggestText =
      guidance.suggestedDisableIds.length > 0
        ? `建议先关闭靠后的 ${guidance.suggestedDisableIds.length} 份大纲（分段启用），或缩短内容，或更换更大上下文模型。`
        : `建议缩短内容，或更换更大上下文模型。`;
    return {
      text,
      outlineIds: versions.map(v => v.id),
      outlineVersions: versions,
      estimatedTokens,
      enabledCount: outlines.length,
      complete: false,
      blockingReason:
        `已启用大纲 ${outlines.length} 份，大纲总计 ${estimatedTokens.toLocaleString()} tokens，` +
        `超出可用大纲空间 ${outlineBudgetTokens.toLocaleString()} tokens（超 ${guidance.overageTokens.toLocaleString()}）。` +
        `${suggestText}可在「资料 - 大纲」中调整启用与排序。`,
      fingerprint,
      perOutlineTokens,
      outlineBudgetTokens,
    };
  }

  return {
    text,
    outlineIds: versions.map(v => v.id),
    outlineVersions: versions,
    estimatedTokens,
    enabledCount: outlines.length,
    complete: true,
    fingerprint,
    perOutlineTokens,
    outlineBudgetTokens,
  };
}

/** Stitch enabled outlines into a single labeled block with header + contract. */
function stitchOutlines(outlines: Outline[]): {
  text: string;
  versions: OutlineVersionEntry[];
} {
  const sections: string[] = [];
  const versions: OutlineVersionEntry[] = [];

  outlines.forEach((outline, index) => {
    const priority = index === 0 ? '最高优先级' : '补充约束';
    const title = outline.title || `大纲 ${index + 1}`;
    const body = outline.content || '';
    sections.push(
      `【大纲 ${index + 1}｜${priority}】\n标题：${title}\n正文：\n${body}`,
    );
    versions.push({
      id: outline.id,
      updatedAt: outline.updatedAt,
      hash: outline.contentHash,
      position: outline.position,
    });
  });

  const text = [OUTLINE_HEADER, OUTLINE_CONTRACT, ...sections].join('\n\n');
  return { text, versions };
}

/**
 * Stable fingerprint: SHA-256 over the ordered id/position/hash tuple of every
 * included outline. Reordering, editing, enabling/disabling, or adding/removing
 * an outline all change the digest; identical outlines always match.
 */
export function computeOutlineFingerprint(
  versions: OutlineVersionEntry[],
): string {
  if (versions.length === 0) return '';
  // Sort by position then id for determinism (versions are already in stitch
  // order, but be defensive against callers passing unsorted input).
  const ordered = [...versions].sort(
    (a, b) => a.position - b.position || a.id - b.id,
  );
  const payload = ordered
    .map(v => `${v.id}:${v.position}:${v.hash}`)
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
  return computeOutlineFingerprint(
    outlines.map(o => ({
      id: o.id,
      updatedAt: o.updatedAt,
      hash: o.contentHash,
      position: o.position,
    })),
  );
}

/**
 * Compute the full pipeline input fingerprint for a chapter generation task:
 * `hash(projectId | chapterId | chapterUpdatedAt | outlineFingerprint)`.
 *
 * This is the stable baseline persisted at task completion and re-computed at
 * result-adoption time. A change in any component (outline edited/reordered,
 * chapter body rewritten externally, chapter re-saved) produces a different
 * digest, so the adoption flow can warn the user the result is stale.
 *
 * `outlineFingerprint` is optional so callers that already hold the frozen
 * snapshot value can pass it directly instead of re-querying the DB.
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
 * `perOutlineTokens` and `outlineIds` MUST be in the same order (stitch order:
 * position ASC then id ASC). The guidance greedily marks the LOWEST-priority
 * enabled outlines (i.e. the tail of the list) as "suggested to disable" until
 * the remaining prefix fits the budget — this is the "segmented enablement"
 * hint that tells the user exactly which outlines to turn off.
 *
 * Returns overBudget=false when budgetTokens <= 0 (unknown budget) so the UI
 * never shows a false overage warning before the user has configured an LLM.
 */
export function computeOutlineBudgetGuidance(
  perOutlineTokens: number[],
  outlineIds: number[],
  budgetTokens: number,
): OutlineBudgetGuidance {
  const totalTokens = perOutlineTokens.reduce((sum, t) => sum + t, 0);
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
  // Greedily drop the lowest-priority (tail) outlines until the prefix fits.
  // Walk from the end, accumulating the disabled tokens; stop once the
  // remaining head tokens are within budget.
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
    // Reverse so the suggested-disable order matches stitch priority (disable
    // the very last one first, which is what the loop collected in reverse).
    suggestedDisableIds: suggestedDisableIds.reverse(),
  };
}
