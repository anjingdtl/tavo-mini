/**
 * Final-seal message integrity: when the assembled stage request slightly
 * overshoots the context window (label / role / protocol overhead), the
 * compiler must ONLY shrink OPTIONAL context sections and rebuild. It must
 * never clip the assembled system/user message string — doing so would
 * truncate the full outline, the mandatory draft body, the system protocol,
 * or repair instructions.
 *
 * Covers plan Case 6 / 7 / 8 / 9 / 10 / 11.
 */
import {
  compileReviewStageRequest,
  compileFactCheckStageRequest,
  compileProofStageRequest,
  type ContextAllocationTrace,
} from '../src/services/pipeline/compileStageRequest';
import { shrinkOptionalAllocations } from '../src/services/pipeline/compileStageRequest';
import type {
  FactCheckContext,
  ProofConstraints,
  ReviewContext,
} from '../src/types/pipelineContext';

// CJK chars each count as 1 token under estimateTokens — this lets us
// construct fixtures with precise token counts.
function cjk(n: number): string {
  return '字'.repeat(n);
}

function fullReviewContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    presetText: '',
    characterText: '',
    noteText: '',
    worldbookText: '',
    storyMemoryText: '',
    episodicMemoryText: '',
    recentBridgeText: '',
    currentInstructionText: '',
    retrievalUserPrompt: '',
    outlineText: '',
    ...overrides,
  };
}

function fullFactCheckContext(
  overrides: Partial<FactCheckContext> = {},
): FactCheckContext {
  return {
    presetText: '',
    currentInstructionText: '',
    retrievalUserPrompt: '',
    recentBridgeText: '',
    storyMemoryText: '',
    episodicMemoryText: '',
    worldbookText: '',
    characterText: '',
    noteText: '',
    outlineText: '',
    ...overrides,
  };
}

function fullProofConstraints(
  overrides: Partial<ProofConstraints> = {},
): ProofConstraints {
  return {
    presetText: '',
    currentInstructionText: '',
    retrievalUserPrompt: '',
    relevantCharacterConstraints: '',
    relevantWorldRules: '',
    currentStoryState: '',
    episodicMemoryText: '',
    noteText: '',
    recentBridgeText: '',
    outlineText: '',
    ...overrides,
  };
}

/** Concatenate all message contents for substring assertions. */
function joinedContent(messages: { content: string }[]): string {
  return messages.map(m => m.content).join('\n');
}

describe('finalizeCompiled optional-only shrink (Fix A)', () => {
  describe('Case 6 — Review slight overshoot keeps outline + draft verbatim', () => {
    test('ready === true, full outline + draft present, only optional shortened', () => {
      const OUTLINE_MARKER = '大纲唯一标记' + cjk(400);
      const DRAFT_MARKER = '初稿唯一标记' + cjk(600);
      const OPTIONAL = cjk(4000);

      const compiled = compileReviewStageRequest({
        draftText: DRAFT_MARKER,
        context: fullReviewContext({
          outlineText: OUTLINE_MARKER,
          presetText: OPTIONAL,
          worldbookText: OPTIONAL,
          characterText: OPTIONAL,
        }),
        // Tight window so the assembled messages overshoot by a small margin
        // after label overhead — but mandatory content clearly fits.
        maxTokens: 200,
        contextWindow: 6000,
      });

      expect(compiled.ready).toBe(true);
      if (!compiled.ready) return;
      const content = joinedContent(compiled.messages);
      // Outline and draft must be present verbatim.
      expect(content).toContain(OUTLINE_MARKER);
      expect(content).toContain(DRAFT_MARKER);
      // System protocol line must survive.
      expect(content).toContain('资深小说审阅编辑');
      // At least one optional allocation got truncated.
      const truncatedOptional = compiled.allocations.filter(
        a =>
          a.id !== 'outline' &&
          a.id !== 'mandatory_body' &&
          (a.truncated || a.allocated < a.requested),
      );
      expect(truncatedOptional.length).toBeGreaterThan(0);
    });
  });

  describe('Case 7 — Proof integrity (draft + reports + outline verbatim)', () => {
    test('full draft, review, factCheck, outline survive; optional constraints shorten', () => {
      const OUTLINE = '大纲标记' + cjk(300);
      const DRAFT = '初稿标记' + cjk(800);
      const REVIEW_REPORT = '审阅报告标记' + cjk(400);
      const FACTCHECK_REPORT = '事实核查标记' + cjk(400);
      const OPTIONAL = cjk(3000);

      const compiled = compileProofStageRequest({
        draftText: DRAFT,
        reviewText: REVIEW_REPORT,
        factCheckText: FACTCHECK_REPORT,
        constraints: fullProofConstraints({
          outlineText: OUTLINE,
          presetText: OPTIONAL,
          relevantWorldRules: OPTIONAL,
          currentStoryState: OPTIONAL,
        }),
        maxTokens: 300,
        contextWindow: 7000,
      });

      expect(compiled.ready).toBe(true);
      if (!compiled.ready) return;
      const content = joinedContent(compiled.messages);
      expect(content).toContain(OUTLINE);
      expect(content).toContain(DRAFT);
      expect(content).toContain(REVIEW_REPORT);
      expect(content).toContain(FACTCHECK_REPORT);
      // Protocol survives.
      expect(content).toMatch(/校对|润色|终稿|审阅/);
      // Some optional section was shrunk.
      const truncatedOptional = compiled.allocations.filter(
        a =>
          a.id !== 'outline' &&
          a.id !== 'mandatory_body' &&
          (a.truncated || a.allocated < a.requested),
      );
      expect(truncatedOptional.length).toBeGreaterThan(0);
    });
  });

  describe('Case 8 — mandatory truly cannot fit → not ready', () => {
    test('oversized draft with small window → ready === false', () => {
      const compiled = compileReviewStageRequest({
        draftText: cjk(20000),
        context: fullReviewContext({ outlineText: cjk(1000) }),
        maxTokens: 1000,
        contextWindow: 4000,
      });
      expect(compiled.ready).toBe(false);
    });
  });

  describe('Case 9 — repair path keeps repairReason + body verbatim', () => {
    test('Review repair: repair instruction and draft survive, optional shortens', () => {
      const REPAIR = '修复指令唯一标记' + cjk(120);
      const DRAFT = '初稿修复标记' + cjk(500);
      const OPTIONAL = cjk(3000);

      const compiled = compileReviewStageRequest({
        draftText: DRAFT,
        context: fullReviewContext({
          outlineText: '大纲' + cjk(200),
          presetText: OPTIONAL,
          worldbookText: OPTIONAL,
        }),
        repairReason: REPAIR,
        maxTokens: 200,
        contextWindow: 6500,
      });

      expect(compiled.ready).toBe(true);
      if (!compiled.ready) return;
      const content = joinedContent(compiled.messages);
      expect(content).toContain(REPAIR);
      expect(content).toContain(DRAFT);
    });

    test('FactCheck repair: repair instruction and draft survive', () => {
      const REPAIR = '事实修复指令标记' + cjk(120);
      const DRAFT = '初稿事实修复' + cjk(500);
      const OPTIONAL = cjk(3000);

      const compiled = compileFactCheckStageRequest({
        draftText: DRAFT,
        context: fullFactCheckContext({
          outlineText: '大纲' + cjk(200),
          presetText: OPTIONAL,
          worldbookText: OPTIONAL,
        }),
        repairReason: REPAIR,
        maxTokens: 200,
        contextWindow: 6500,
      });

      expect(compiled.ready).toBe(true);
      if (!compiled.ready) return;
      const content = joinedContent(compiled.messages);
      expect(content).toContain(REPAIR);
      expect(content).toContain(DRAFT);
    });
  });

  describe('Case 10 — outline alone too large → OUTLINE_TOO_LARGE', () => {
    test('full outline + fixed + output + safety > window → OUTLINE_TOO_LARGE', () => {
      const compiled = compileReviewStageRequest({
        draftText: '',
        context: fullReviewContext({ outlineText: cjk(5000) }),
        maxTokens: 500,
        contextWindow: 3000,
      });
      expect(compiled.ready).toBe(false);
      if (compiled.ready) return;
      expect(compiled.error.code).toBe('OUTLINE_TOO_LARGE');
    });
  });

  describe('Case 11 — body (not outline) causes overflow → CONTEXT_WINDOW_EXCEEDED', () => {
    test('oversized draft with no outline → CONTEXT_WINDOW_EXCEEDED (not OUTLINE_TOO_LARGE)', () => {
      const compiled = compileReviewStageRequest({
        draftText: cjk(8000),
        context: fullReviewContext({ outlineText: '' }),
        maxTokens: 500,
        contextWindow: 5000,
      });
      expect(compiled.ready).toBe(false);
      if (compiled.ready) return;
      expect(compiled.error.code).toBe('CONTEXT_WINDOW_EXCEEDED');
    });
  });
});

describe('shrinkOptionalAllocations unit invariants', () => {
  function allocs(
    entries: Array<{ id: string; allocated: number; requested?: number }>,
  ): ContextAllocationTrace[] {
    return entries.map(e => ({
      id: e.id,
      requested: e.requested ?? e.allocated,
      allocated: e.allocated,
      truncated: false,
    }));
  }

  test('never reduces mandatory (outline / mandatory_body)', () => {
    const a = allocs([
      { id: 'outline', allocated: 500 },
      { id: 'mandatory_body', allocated: 300 },
      { id: 'preset', allocated: 400 },
    ]);
    const changed = shrinkOptionalAllocations(a, 200);
    expect(changed).toBe(true);
    const outline = a.find(x => x.id === 'outline')!;
    const body = a.find(x => x.id === 'mandatory_body')!;
    expect(outline.allocated).toBe(500);
    expect(body.allocated).toBe(300);
    expect(a.find(x => x.id === 'preset')!.allocated).toBe(200);
  });

  test('keeps allocated >= 0 and <= requested', () => {
    const a = allocs([
      { id: 'preset', allocated: 100, requested: 100 },
      { id: 'worldbook', allocated: 50, requested: 50 },
    ]);
    shrinkOptionalAllocations(a, 9999);
    for (const e of a) {
      expect(e.allocated).toBeGreaterThanOrEqual(0);
      expect(e.allocated).toBeLessThanOrEqual(e.requested);
    }
  });

  test('returns false when nothing left to reclaim', () => {
    const a = allocs([
      { id: 'outline', allocated: 500 },
      { id: 'mandatory_body', allocated: 300 },
    ]);
    expect(shrinkOptionalAllocations(a, 100)).toBe(false);
  });

  test('reclaims from largest optional section first', () => {
    const a = allocs([
      { id: 'small', allocated: 50 },
      { id: 'big', allocated: 400 },
    ]);
    shrinkOptionalAllocations(a, 100);
    // The big section should bear most of the reduction.
    const big = a.find(x => x.id === 'big')!;
    const small = a.find(x => x.id === 'small')!;
    expect(big.allocated).toBeLessThan(400);
    expect(small.allocated).toBe(50);
  });
});
