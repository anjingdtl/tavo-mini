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
  | 'outline';

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
}
