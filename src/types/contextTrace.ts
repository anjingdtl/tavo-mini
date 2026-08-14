export type ContextSourceKind =
  | 'preset'
  | 'chapter'
  | 'memory'
  | 'story_memory'
  | 'story_memory_bridge'
  | 'character'
  | 'note'
  | 'worldbook'
  | 'instruction'
  | 'outline'
  | 'writer_style'
  | 'writer_style_projection'
  | 'writer_style_compat'
  | 'writer_style_sampler';

/**
 * Allocation reason codes for the Context Budget V3 hierarchical allocator
 * (Plan §15). Surfaced in `ContextTraceItem.allocationReason` so the Preview
 * screen can explain WHY each section/item got the budget it did.
 */
export type ContextAllocationReason =
  | 'full_fit'
  | 'soft_target'
  | 'global_borrow'
  | 'item_competition'
  | 'burst_limit'
  | 'hard_limit'
  | 'manual_cap'
  | 'not_activated';

export type ResourcePreviewStatus =
  | 'AWARENESS_ONLY'
  | 'DETAIL_FULL'
  | 'DETAIL_CLIPPED'
  | 'NOT_SELECTED'
  | 'DISABLED'
  | 'ERROR';

export interface ContextTraceItem {
  kind: ContextSourceKind;
  sourceId: number | null;
  title: string;
  reason: string;
  estimatedTokens: number;
  included: boolean;
  clipped: boolean;
  /** No eligible source exists for this category (not a context-budget trim). */
  empty?: boolean;
  preview: string;
  /**
   * Context Budget V3 diagnostics (Plan §15). Optional — absent for V1/V2
   * builds and for sections that don't participate in the hierarchical
   * allocator (preset / outline / instruction).
   */
  demandTokens?: number;
  softTargetTokens?: number;
  allocatedTokens?: number;
  borrowedTokens?: number;
  allocationReason?: ContextAllocationReason;
  /** Phase-2 Preview: distinguish awareness-only from unused/disabled. */
  resourcePreviewStatus?: ResourcePreviewStatus;
  sourceFingerprint?: string;
  awarenessMode?: 'global_awareness' | 'detail' | 'preset';
  /** Non-blocking resource read/compile warning surfaced in Preview. */
  warning?: string;
  warningCode?: string;
  warningAction?: 'open_resources' | 'retry' | 'none';
}
