/**
 * Seal 3: budget controls final messages; outline 30% is suggestion only.
 */
import {
  allocateStageContextBudget,
} from '../src/services/pipeline/budgetAllocator';
import {
  compileReviewStageRequest,
  compileFactCheckStageRequest,
  compileProofStageRequest,
  compileDraftFromFrozenRequest,
} from '../src/services/pipeline/compileStageRequest';
import {
  deriveOutlineBudgetTokens,
  OUTLINE_BUDGET_RATIO,
} from '../src/services/outlineContextBuilder';
import { deriveGenerationOutlineBudgetTokens } from '../src/services/contextBuilder';
import type { FrozenDraftRequest } from '../src/types/pipelineFrozen';

describe('outline 30% suggestion vs generation budget', () => {
  test('management suggest remains 30%', () => {
    expect(OUTLINE_BUDGET_RATIO).toBe(0.3);
    expect(deriveOutlineBudgetTokens(10000)).toBe(3000);
  });

  test('generation budget allows outline at 40% of window when total can fit', () => {
    const window = 10000;
    const reserved = 1000;
    const genBudget = deriveGenerationOutlineBudgetTokens(window, reserved);
    // 40% of window = 4000 — must be within generation budget.
    expect(genBudget).toBeGreaterThan(4000);
    expect(genBudget).toBeGreaterThan(deriveOutlineBudgetTokens(window));
  });
});

describe('optional allocation conservation + redistribution', () => {
  test('sum of optional allocations never exceeds remaining', () => {
    const result = allocateStageContextBudget({
      contextWindow: 10000,
      reservedOutputTokens: 1000,
      safetyMargin: 500,
      fixedMessagesTokens: 500,
      fullOutlineTokens: 1000,
      mandatoryBodyTokens: 500,
      optionalSections: [
        { id: 'a', tokens: 8000, weight: 50 },
        { id: 'b', tokens: 8000, weight: 50 },
      ],
    });
    const sum = result.optionalAllocations.reduce((s, a) => s + a.allocated, 0);
    expect(sum).toBeLessThanOrEqual(result.remainingForOptional);
  });

  test('short section frees budget for hungry section (multi-round)', () => {
    const result = allocateStageContextBudget({
      contextWindow: 10000,
      reservedOutputTokens: 0,
      safetyMargin: 0,
      fixedMessagesTokens: 0,
      fullOutlineTokens: 0,
      mandatoryBodyTokens: 0,
      optionalSections: [
        { id: 'short', tokens: 100, weight: 50 },
        { id: 'long', tokens: 9000, weight: 50 },
      ],
    });
    const short = result.optionalAllocations.find(a => a.id === 'short')!;
    const long = result.optionalAllocations.find(a => a.id === 'long')!;
    expect(short.allocated).toBe(100);
    // Without redistribution long would only get ~5000; leftover from short should help.
    expect(long.allocated).toBeGreaterThan(5000);
    expect(short.allocated + long.allocated).toBeLessThanOrEqual(
      result.remainingForOptional,
    );
  });
});

describe('stage compile Ready/Blocked gates', () => {
  const huge = '字'.repeat(20000);

  test('Review over window → not ready (no model)', () => {
    const compiled = compileReviewStageRequest({
      draftText: huge,
      context: {
        presetText: huge,
        characterText: huge,
        noteText: huge,
        worldbookText: huge,
        storyMemoryText: huge,
        episodicMemoryText: huge,
        recentBridgeText: huge,
        currentInstructionText: huge,
        retrievalUserPrompt: huge,
        outlineText: huge,
      },
      maxTokens: 4000,
      contextWindow: 2000,
    });
    expect(compiled.ready).toBe(false);
    if (compiled.ready) return;
    expect(['OUTLINE_TOO_LARGE', 'CONTEXT_WINDOW_EXCEEDED']).toContain(
      compiled.error.code,
    );
  });

  test('FactCheck over window → not ready', () => {
    const compiled = compileFactCheckStageRequest({
      draftText: huge,
      context: {
        presetText: huge,
        currentInstructionText: huge,
        retrievalUserPrompt: huge,
        recentBridgeText: huge,
        storyMemoryText: huge,
        episodicMemoryText: huge,
        worldbookText: huge,
        characterText: huge,
        noteText: huge,
        outlineText: '',
      },
      maxTokens: 4000,
      contextWindow: 1500,
    });
    expect(compiled.ready).toBe(false);
    if (compiled.ready) return;
    // Non-outline overflow must not be OUTLINE_TOO_LARGE.
    expect(compiled.error.code).toBe('CONTEXT_WINDOW_EXCEEDED');
  });

  test('FactCheck repair over window → not ready', () => {
    const compiled = compileFactCheckStageRequest({
      draftText: huge,
      context: {
        presetText: huge,
        currentInstructionText: huge,
        retrievalUserPrompt: huge,
        recentBridgeText: huge,
        storyMemoryText: huge,
        episodicMemoryText: huge,
        worldbookText: huge,
        characterText: huge,
        noteText: huge,
        outlineText: '',
      },
      maxTokens: 4000,
      contextWindow: 1500,
      repairReason: 'invalid_json',
    });
    expect(compiled.ready).toBe(false);
  });

  test('Proof over window → not ready', () => {
    const compiled = compileProofStageRequest({
      draftText: huge,
      reviewText: huge,
      factCheckText: huge,
      constraints: {
        presetText: huge,
        currentInstructionText: huge,
        retrievalUserPrompt: huge,
        relevantCharacterConstraints: huge,
        relevantWorldRules: huge,
        currentStoryState: huge,
        episodicMemoryText: huge,
        noteText: huge,
        recentBridgeText: huge,
        outlineText: '',
      },
      maxTokens: 4000,
      contextWindow: 1500,
    });
    expect(compiled.ready).toBe(false);
    if (compiled.ready) return;
    expect(compiled.error.code).toBe('CONTEXT_WINDOW_EXCEEDED');
  });

  test('Review optional sections are actually clipped by allocation', () => {
    const longPreset = '预'.repeat(20000);
    const compiled = compileReviewStageRequest({
      draftText: '短草稿',
      context: {
        presetText: longPreset,
        characterText: '',
        noteText: '',
        worldbookText: '',
        storyMemoryText: '',
        episodicMemoryText: '',
        recentBridgeText: '',
        currentInstructionText: '',
        retrievalUserPrompt: '',
        outlineText: '',
      },
      maxTokens: 500,
      contextWindow: 8000,
    });
    if (!compiled.ready) {
      throw new Error(
        `expected ready, got blocked: ${compiled.error.code} ${compiled.error.message} diag=${JSON.stringify(compiled.diagnostics)}`,
      );
    }
    const presetAlloc = compiled.allocations.find(a => a.id === 'preset');
    expect(presetAlloc).toBeDefined();
    expect(presetAlloc!.truncated).toBe(true);
    // Final messages must not contain the full unclipped preset.
    const joined = compiled.messages.map(m => m.content).join('\n');
    expect(joined.length).toBeLessThan(longPreset.length);
  });

  test('Draft retry over window is blocked', () => {
    const frozen: FrozenDraftRequest = {
      messages: [{ role: 'user', content: '字'.repeat(3000) }],
      estimatedInputTokens: 3000,
      reservedOutputTokens: 500,
      safetyMargin: 256,
      contextWindow: 2000,
      allocations: [],
      requestFingerprint: 'x',
      chapterTitle: 't',
      prevEnding: '',
      userPrompt: 'u',
    };
    const retry = compileDraftFromFrozenRequest({
      frozen,
      retryInstruction: '再试 ' + '字'.repeat(1000),
    });
    expect(retry.ready).toBe(false);
  });
});
