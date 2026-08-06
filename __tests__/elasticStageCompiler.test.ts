/**
 * Phase 2: elastic budget integration across stage compilers.
 * Covers: empty-module reclaim, character→bridge spillover, high-relevance
 * worldbook burst (80%~95%), optional never borrowing burst, mandatory over
 * soft line still Ready, mandatory over hard line → Blocked (LLM call 0),
 * label overhead shrinks optional only, retry trace stability, verbatim
 * mandatory content, ReadyStageRequest gate.
 */
import {
  compileReviewStageRequest,
  compileFactCheckStageRequest,
  compileProofStageRequest,
  requireReadyStageRequest,
} from '../src/services/pipeline/compileStageRequest';
import { compileStageRequestWithElasticBudget } from '../src/services/pipeline/elasticStageCompiler';
import type { ReviewContext, FactCheckContext, ProofConstraints } from '../src/types/pipelineContext';

// W=16000, maxTokens=2000, safety=320 → C=13680, soft=10944, burst=12996, hard=13680
const WINDOW = 16_000;
const MAX_TOKENS = 2_000;
const safety = Math.min(1024, Math.max(256, Math.floor(WINDOW * 0.02))); // 320

function reviewContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
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

const txt = (ch: string, n: number) => ch.repeat(n);

describe('elastic budget stage integration — normal band (≤80%)', () => {
  it('compiles Ready with a normal risk level and keeps mandatory verbatim', () => {
    const outline = txt('纲', 800);
    const draft = txt('正', 800);
    const compiled = compileReviewStageRequest({
      draftText: draft,
      context: reviewContext({
        outlineText: outline,
        storyMemoryText: txt('忆', 500),
        recentBridgeText: txt('桥', 400),
      }),
      maxTokens: MAX_TOKENS,
      contextWindow: WINDOW,
      elasticBudget: true,
    });
    expect(compiled.ready).toBe(true);
    if (!compiled.ready) return;
    const ready = requireReadyStageRequest(compiled);
    expect(ready.elasticBudgetTrace?.riskLevel).toBe('normal');
    // mandatory content verbatim inside the assembled messages
    const allText = ready.messages.map(m => m.content).join('\n');
    expect(allText).toContain(outline);
    expect(allText).toContain(draft);
  });

  it('releases budget from empty modules to hungry ones', () => {
    const outline = txt('纲', 800);
    const draft = txt('正', 800);
    const compiled = compileReviewStageRequest({
      draftText: draft,
      context: reviewContext({
        outlineText: outline,
        // empty modules: no note, no preset, no episodic content
        noteText: '',
        presetText: '',
        episodicMemoryText: '',
        storyMemoryText: txt('忆', 2_000),
        recentBridgeText: txt('桥', 2_000),
      }),
      maxTokens: MAX_TOKENS,
      contextWindow: WINDOW,
      elasticBudget: true,
    });
    expect(compiled.ready).toBe(true);
    if (!compiled.ready) return;
    const alloc = new Map(compiled.allocations.map(a => [a.id, a.allocated]));
    expect(alloc.get('note')).toBe(0);
    expect(alloc.get('preset')).toBe(0);
    expect(alloc.get('episodic')).toBe(0);
    // spilled budget reaches high-value modules
    expect(alloc.get('recentBridge')).toBeGreaterThan(0);
    expect(alloc.get('storyMemory')).toBeGreaterThan(0);
  });

  it('transfers short character-card surplus to recent bridge', () => {
    const outline = txt('纲', 800);
    const draft = txt('正', 800);
    const compiled = compileReviewStageRequest({
      draftText: draft,
      context: reviewContext({
        outlineText: outline,
        characterText: txt('角', 50), // content far below min
        recentBridgeText: txt('桥', 3_000),
      }),
      maxTokens: MAX_TOKENS,
      contextWindow: WINDOW,
      elasticBudget: true,
    });
    expect(compiled.ready).toBe(true);
    if (!compiled.ready) return;
    const alloc = new Map(compiled.allocations.map(a => [a.id, a.allocated]));
    expect(alloc.get('character')).toBeLessThanOrEqual(50);
    expect(alloc.get('recentBridge')).toBeGreaterThan(alloc.get('character')!);
  });
});

describe('elastic budget stage integration — burst band (80%~95%)', () => {
  it('lets a high-relevance worldbook borrow burst into 80%~95%', () => {
    const outline = txt('纲', 9_000); // mandatory 9000 > soft 10944? No: 9000 < 10944
    const draft = txt('正', 800);
    const compiled = compileReviewStageRequest({
      draftText: draft,
      context: reviewContext({
        outlineText: outline,
        worldbookText: txt('界', 4_000),
      }),
      maxTokens: MAX_TOKENS,
      contextWindow: WINDOW,
      elasticBudget: true,
    });
    expect(compiled.ready).toBe(true);
    if (!compiled.ready) return;
    const trace = compiled.elasticBudgetTrace!;
    // mandatory 9800, soft pool = 10944-9800 = 1144; worldbook takes soft
    // then borrows burst (75% cap) → final between soft and burst lines.
    expect(trace.finalEstimatedInputTokens).toBeGreaterThan(trace.softInputLimit);
    expect(trace.finalEstimatedInputTokens).toBeLessThanOrEqual(trace.burstInputLimit);
    expect(trace.riskLevel).toBe('elevated');
    const wb = trace.modules.find(m => m.id === 'worldbook')!;
    expect(wb.burstBorrowedTokens).toBeGreaterThan(0);
  });

  it('never lets ordinary optional modules borrow burst while soft pool has room', () => {
    const outline = txt('纲', 800);
    const draft = txt('正', 800);
    const compiled = compileReviewStageRequest({
      draftText: draft,
      context: reviewContext({
        outlineText: outline,
        noteText: txt('笔', 3_000),
      }),
      maxTokens: MAX_TOKENS,
      contextWindow: WINDOW,
      elasticBudget: true,
    });
    expect(compiled.ready).toBe(true);
    if (!compiled.ready) return;
    const trace = compiled.elasticBudgetTrace!;
    const note = trace.modules.find(m => m.id === 'note')!;
    expect(note.burstBorrowedTokens).toBe(0);
    expect(trace.finalEstimatedInputTokens).toBeLessThanOrEqual(
      trace.softInputLimit,
    );
  });
});

describe('elastic budget stage integration — mandatory protection', () => {
  it('stays Ready when mandatory exceeds 80% but is under the hard limit', () => {
    const outline = txt('纲', 11_000); // > soft 10944, < hard 13680
    const draft = txt('正', 100);
    const compiled = compileReviewStageRequest({
      draftText: draft,
      context: reviewContext({
        outlineText: outline,
        storyMemoryText: txt('忆', 2_000),
      }),
      maxTokens: MAX_TOKENS,
      contextWindow: WINDOW,
      elasticBudget: true,
    });
    expect(compiled.ready).toBe(true);
    if (!compiled.ready) return;
    const trace = compiled.elasticBudgetTrace!;
    expect(trace.mandatoryTokens).toBeGreaterThan(trace.softInputLimit);
    expect(trace.mandatoryTokens).toBeLessThanOrEqual(trace.hardInputLimit);
    expect(trace.riskLevel).toBe('high');
    // optional still competes in the elastic band, never past the 95% line
    expect(trace.finalEstimatedInputTokens).toBeLessThanOrEqual(
      trace.burstInputLimit,
    );
  });

  it('blocks (LLM call count 0) when mandatory exceeds the hard limit', () => {
    const outline = txt('纲', 12_000);
    const draft = txt('正', 2_000); // 14000 > hard 13680
    const compiled = compileReviewStageRequest({
      draftText: draft,
      context: reviewContext({
        outlineText: outline,
        storyMemoryText: txt('忆', 500),
      }),
      maxTokens: MAX_TOKENS,
      contextWindow: WINDOW,
      elasticBudget: true,
    });
    expect(compiled.ready).toBe(false);
    if (compiled.ready) return;
    expect(compiled.error.code).toBe('CONTEXT_WINDOW_EXCEEDED');
    // gate stays closed: requireReadyStageRequest must throw
    expect(() => requireReadyStageRequest(compiled)).toThrow();
  });
});

describe('elastic budget stage integration — final window shrink', () => {
  it('shrinks optional modules only when label overhead overshoots', () => {
    const outline = txt('纲', 11_000); // mandatory 11000 (draft empty)
    const compiled = compileStageRequestWithElasticBudget({
      stage: 'review',
      contextWindow: WINDOW,
      reservedOutputTokens: MAX_TOKENS,
      safetyMargin: safety,
      mandatoryModules: [
        { id: 'outline', text: outline, requirement: 'mandatory', priority: 10, relevance: 1 },
      ],
      elasticModules: [
        { id: 'worldbook', text: txt('界', 4_000), requirement: 'optional', priority: 5, relevance: 0.7 },
      ],
      // deliberate heavy wrapping overhead that the allocator cannot see
      buildMessages: clipped => [
        {
          role: 'system',
          content: `【协议头】${'包'.repeat(2_000)}${clipped.get('outline') || ''}`,
        },
        { role: 'system', content: `【设定】${clipped.get('worldbook') || ''}` },
      ],
    });
    expect(compiled.ready).toBe(true);
    if (!compiled.ready) return;
    const allText = compiled.messages.map(m => m.content).join('\n');
    // mandatory outline stays verbatim
    expect(allText).toContain(outline);
    // optional worldbook was shrunk to fit (below its full 4000 content)
    const wb = compiled.allocations.find(a => a.id === 'worldbook')!;
    expect(wb.allocated).toBeLessThan(wb.requested);
  });

  it('blocks when even full optional shrink cannot fit', () => {
    const compiled = compileStageRequestWithElasticBudget({
      stage: 'review',
      contextWindow: WINDOW,
      reservedOutputTokens: MAX_TOKENS,
      safetyMargin: safety,
      mandatoryModules: [
        { id: 'outline', text: txt('纲', 13_500), requirement: 'mandatory', priority: 10, relevance: 1 },
      ],
      elasticModules: [
        { id: 'worldbook', text: txt('界', 1_000), requirement: 'optional', priority: 5, relevance: 0.7 },
      ],
      buildMessages: clipped => [
        { role: 'system', content: `【协议头】${'包'.repeat(200)}${clipped.get('outline') || ''}` },
        { role: 'system', content: `【设定】${clipped.get('worldbook') || ''}` },
      ],
    });
    expect(compiled.ready).toBe(false);
  });
});

describe('elastic budget stage integration — determinism / retry', () => {
  it('keeps trace + allocations identical across replays (retry reuse)', () => {
    const outline = txt('纲', 9_000);
    const draft = txt('正', 800);
    const build = () =>
      compileReviewStageRequest({
        draftText: draft,
        context: reviewContext({
          outlineText: outline,
          storyMemoryText: txt('忆', 2_000),
          worldbookText: txt('界', 3_000),
          recentBridgeText: txt('桥', 1_500),
        }),
        maxTokens: MAX_TOKENS,
        contextWindow: WINDOW,
        elasticBudget: true,
      });
    const a = build();
    const b = build();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a.elasticBudgetTrace)).toBe(
      JSON.stringify(b.elasticBudgetTrace),
    );
  });
});

describe('elastic budget stage integration — all stages share the compiler', () => {
  it('compiles FactCheck and Proof with the same trace shape', () => {
    const outline = txt('纲', 1_000);
    const draft = txt('正', 1_000);
    const fc: FactCheckContext = {
      presetText: '',
      currentInstructionText: '',
      retrievalUserPrompt: '',
      recentBridgeText: '',
      storyMemoryText: txt('忆', 300),
      episodicMemoryText: '',
      worldbookText: '',
      characterText: '',
      noteText: '',
      outlineText: outline,
    };
    const fcCompiled = compileFactCheckStageRequest({
      draftText: draft,
      context: fc,
      maxTokens: MAX_TOKENS,
      contextWindow: WINDOW,
      elasticBudget: true,
    });
    expect(fcCompiled.ready).toBe(true);
    if (!fcCompiled.ready) return;
    expect(fcCompiled.elasticBudgetTrace?.riskLevel).toBe('normal');

    const proofConstraints: ProofConstraints = {
      presetText: '',
      currentInstructionText: '',
      retrievalUserPrompt: '',
      relevantCharacterConstraints: txt('角', 200),
      relevantWorldRules: '',
      currentStoryState: '',
      episodicMemoryText: '',
      noteText: '',
      recentBridgeText: '',
      outlineText: outline,
    };
    const proofCompiled = compileProofStageRequest({
      draftText: draft,
      reviewText: txt('审', 200),
      factCheckText: txt('核', 200),
      constraints: proofConstraints,
      maxTokens: MAX_TOKENS,
      contextWindow: WINDOW,
      elasticBudget: true,
    });
    expect(proofCompiled.ready).toBe(true);
    if (!proofCompiled.ready) return;
    expect(proofCompiled.elasticBudgetTrace).toBeDefined();
    // proof does not actively consume the burst band: all elastic modules are
    // optional → no burst borrowing while the soft pool has room
    const burst = proofCompiled.elasticBudgetTrace!.modules.reduce(
      (s, m) => s + m.burstBorrowedTokens,
      0,
    );
    expect(burst).toBe(0);
  });
});
