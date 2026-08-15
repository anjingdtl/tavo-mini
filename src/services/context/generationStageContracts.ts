/**
 * Generation stage contracts (Stability Plan §4 / §21 — Phase 4 layer 1).
 *
 * The context builder is being converged onto a six-stage pipeline:
 *
 *   collect → normalize → plan → allocate → render → freeze
 *
 * Layer 1 (this module + timing wiring in contextBuilder) introduces the
 * NAMED stage boundaries, per-stage timing telemetry (plan §21) and the
 * explicit freeze-time future-leakage guard (plan §4.6) WITHOUT moving or
 * rewriting any budget/render logic — zero semantic drift by construction.
 *
 * Later layers migrate code behind these contracts one stage at a time,
 * each gated by a golden diff against the replay harness.
 */
import type { Chapter } from '../../types/novel';

export type GenerationBuilderStage =
  | 'collect'
  | 'normalize'
  | 'plan'
  | 'allocate'
  | 'render'
  | 'freeze';

export const GENERATION_BUILDER_STAGES: readonly GenerationBuilderStage[] = [
  'collect',
  'normalize',
  'plan',
  'allocate',
  'render',
  'freeze',
];

/** Plan §21 — per-stage wall-clock telemetry (observation only). */
export interface GenerationStageTiming {
  stage: GenerationBuilderStage;
  durationMs: number;
  /** Coarse attribution marker for stages interleaved in the legacy body. */
  note?: string;
}

export type GenerationStageTimings = GenerationStageTiming[];

/**
 * Observational summary of the collect stage (plan §4.1). Counts and
 * identity pointers only — full candidates stay inside the builder until
 * later layers migrate them behind FrozenContextCandidate.
 */
export interface CollectedGenerationMaterialsSummary {
  chapterCount: number;
  previousChapterCount: number;
  episodicCandidateCount: number;
  storyMemoryCheckpointUsable: boolean | null;
  outlineEstimatedTokens: number | null;
  contextBudgetVersion: number;
}

/** Lightweight stopwatch for stage spans inside buildContext. */
export class GenerationStageStopwatch {
  private marks: Array<{ stage: GenerationBuilderStage; at: number }> = [];
  private readonly timings: GenerationStageTimings = [];

  mark(stage: GenerationBuilderStage): void {
    this.marks.push({ stage, at: Date.now() });
  }

  /**
   * Close the span that started at `mark(fromStage)` and record it under
   * `asStage`. Interleaved legacy branches collapse into coarse spans —
   * attribution fidelity improves as stages are migrated out.
   */
  close(fromStage: GenerationBuilderStage, asStage: GenerationBuilderStage, note?: string): void {
    const start = this.marks.find(m => m.stage === fromStage);
    if (!start) return;
    this.timings.push({
      stage: asStage,
      durationMs: Math.max(0, Date.now() - start.at),
      note,
    });
    this.marks = this.marks.filter(m => m.stage !== fromStage);
  }

  result(): GenerationStageTimings {
    return [...this.timings];
  }
}

export interface FutureSourceLeakageInput {
  currentPosition: number;
  /** Chapters that must all strictly precede the current position. */
  previousChapters: Chapter[];
  /** Episodic (memory) candidates — every entry must precede the position. */
  episodicCandidates: Array<{ position?: number }>;
}

/**
 * Plan §4.6 freeze check: future source leakage must be ZERO before the
 * snapshot is assembled. A violation means a chapter at/after the current
 * position leaked into previous-chapter or episodic memory inputs, which
 * would let the draft "see the future" of the book.
 */
export function assertNoFutureSourceLeakage(
  input: FutureSourceLeakageInput,
): void {
  const position = Number(input.currentPosition);
  if (!Number.isFinite(position)) return;
  const leakedPrevious = input.previousChapters.filter(
    chapter => Number(chapter.position) >= position,
  );
  if (leakedPrevious.length > 0) {
    throw new Error(
      `GENERATION_CONTEXT_FUTURE_SOURCE_LEAK：前文章节包含当前位置之后的章节（positions=${leakedPrevious
        .map(c => c.position)
        .join(',')}），已阻止冻结上下文。`,
    );
  }
  const leakedEpisodic = input.episodicCandidates.filter(
    candidate =>
      Number.isFinite(Number(candidate.position)) &&
      Number(candidate.position) >= position,
  );
  if (leakedEpisodic.length > 0) {
    throw new Error(
      `GENERATION_CONTEXT_FUTURE_SOURCE_LEAK：情节记忆候选包含当前位置之后的章节（positions=${leakedEpisodic
        .map(c => c.position)
        .join(',')}），已阻止冻结上下文。`,
    );
  }
}
