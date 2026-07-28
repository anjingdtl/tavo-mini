/**
 * S1 local-model preflight (spec §1, change 3): startAnalysis must estimate
 * the per-batch prompt token cost and refuse / downgrade before entering the
 * three-attempt retry loop when the local model's context window is too small.
 *
 * Physical model (matches llama.cpp's window clamping): a request fits when
 *   inputEstimate + outputBaseline + overhead <= effectiveWindow
 * where effectiveWindow = min(contextWindow, 4096) for local models (provider
 * clamps n_ctx to 4096). Online models skip the check entirely.
 */
import {
  planAnalysisTokenBudget,
  CANON_LOCAL_MODEL_MIN_CONTEXT_WINDOW,
} from '../src/services/continuation/canon/canonAnalysisService';

function chapter(position: number, chars = 6000) {
  return {
    id: position + 1,
    sourceId: 1,
    position,
    title: `第${position + 1}章`,
    // Repeated CJK content; the estimator charges ~1 token per CJK char.
    content: '字'.repeat(chars),
    range: { start: position * chars, end: (position + 1) * chars },
    clippedByBoundary: false,
  } as any;
}

describe('planAnalysisTokenBudget (S1 local-model preflight)', () => {
  it('returns ok without downgrade for an online model (no context_window)', () => {
    const plan = planAnalysisTokenBudget({
      chapters: [chapter(0), chapter(1), chapter(2)],
      profile: 'standard',
      perBatch: 3,
      contextWindow: undefined,
    });
    expect(plan.ok).toBe(true);
    expect(plan.downgraded).toBe(false);
    expect(plan.perBatch).toBe(3);
  });

  it('refuses when a 4096 local window cannot reserve the standard output baseline', () => {
    // Standard output baseline is 8192; even with no input it exceeds the
    // 4096 effective window, so the run must be refused up front.
    const plan = planAnalysisTokenBudget({
      chapters: [chapter(0, 100)],
      profile: 'standard',
      perBatch: 1,
      contextWindow: 4096,
    });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/上下文不足|context/i);
  });

  it('downgrades perBatch and shrinks the slice when input is the bottleneck', () => {
    // 20000 effective window, standard output 8192: a 3×6000 batch (~18000
    // input tokens) overflows, but perBatch=1 with a shrunken slice fits.
    const plan = planAnalysisTokenBudget({
      chapters: [chapter(0), chapter(1), chapter(2)],
      profile: 'standard',
      perBatch: 3,
      // Bypass the 4096 clamp by asserting the planner honours a larger window
      // when the provider reports one (some local backends configure n_ctx
      // above 4096). The planner uses min(contextWindow, 4096) only as a
      // conservative default ceiling; here we pass an explicit ceiling.
      contextWindow: 20000,
      contextWindowCeiling: 20000,
    });
    expect(plan.ok).toBe(true);
    expect(plan.downgraded).toBe(true);
    expect(plan.perBatch).toBe(1);
    // perBatch downgrade alone may suffice; slice only shrinks if still tight.
    expect(plan.sliceCharBudget).toBeLessThanOrEqual(6000);
  });

  it('refuses when even perBatch=1 with a minimal slice cannot fit the window', () => {
    const plan = planAnalysisTokenBudget({
      chapters: [chapter(0, 6000)],
      profile: 'standard',
      perBatch: 1,
      contextWindow: 1024,
    });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/上下文不足|context/i);
    // The refusal must surface the numbers so the user knows what to change.
    expect(plan.reason).toMatch(/\d+/);
  });

  it('reserves the deep-profile output baseline (16384) before judging fit', () => {
    const plan = planAnalysisTokenBudget({
      chapters: [chapter(0, 100)],
      profile: 'deep',
      perBatch: 1,
      contextWindow: 4096,
    });
    // Deep needs 16384 output tokens; a 4096 window cannot reserve that.
    expect(plan.ok).toBe(false);
  });

  it('exposes a minimum context window constant for clearer error messages', () => {
    expect(CANON_LOCAL_MODEL_MIN_CONTEXT_WINDOW).toBeGreaterThanOrEqual(4096);
  });
});
