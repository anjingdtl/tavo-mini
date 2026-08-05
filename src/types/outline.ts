/**
 * Outline resource types (大纲创作模式升级, Schema 36).
 *
 * An Outline is a project-level first-class resource describing future plot
 * direction. It is distinct from:
 *  - `chapters.synopsis` (per-chapter execution goal, not project planning);
 *  - `project_resources` (polymorphic character/worldbook/note/preset links);
 *  - Story Memory / Canon (already-happened facts, not future plans).
 *
 * Outlines carry their own enable flag, deterministic position and independent
 * token budget, so they never compete with ordinary resources for context space.
 */

/** How an outline entered the system. */
export type OutlineSourceType = 'manual' | 'txt';

/** A single outline row in the `outlines` table. */
export interface Outline {
  id: number;
  projectId: number;
  title: string;
  content: string;
  sourceType: OutlineSourceType;
  sourceFileName?: string;
  /** Whether this outline is injected into the generation context. */
  enabled: boolean;
  /** Deterministic ordering inside one project (ascending = higher priority). */
  position: number;
  estimatedTokens: number;
  /** SHA-256 of `content`, used by the pipeline snapshot fingerprint. */
  contentHash: string;
  createdAt: number;
  updatedAt: number;
}

/** Patch accepted by {@link updateOutline}. */
export interface OutlineUpdatePatch {
  title?: string;
  content?: string;
}
