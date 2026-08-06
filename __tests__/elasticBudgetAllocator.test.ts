/**
 * Phase 1: elastic budget pure allocator.
 * Scenario coverage + deterministic property/invariant tests.
 */
import {
  allocateElasticStageContextBudget,
  type ElasticContextDemand,
} from '../src/services/pipeline/elasticBudgetAllocator';

function demand(partial: Partial<ElasticContextDemand> & { id: string }): ElasticContextDemand {
  return {
    availableTokens: 0,
    minTokens: 0,
    targetTokens: 0,
    maxTokens: 0,
    priority: 1,
    relevance: 0.5,
    requirement: 'optional',
    reclaimable: true,
    shrinkPriority: 0,
    burstPriority: 0,
    ...partial,
  };
}

const baseInput = {
  contextWindow: 16_000,
  reservedOutputTokens: 2_000,
  safetyMargin: 800,
  // C = 16000 - 2000 - 800 = 13200; soft = 10560; burst = 12540; hard = 13200
};

describe('allocateElasticStageContextBudget — water levels', () => {
  it('computes 80% soft / 95% burst / hard limits from C', () => {
    const result = allocateElasticStageContextBudget({
      ...baseInput,
      demands: [
        demand({
          id: 'story',
          availableTokens: 500,
          minTokens: 100,
          targetTokens: 500,
          maxTokens: 500,
          priority: 3,
          relevance: 0.9,
          requirement: 'preferred',
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.hardInputLimit).toBe(13_200);
    expect(result.trace.softInputLimit).toBe(10_560);
    expect(result.trace.burstInputLimit).toBe(12_540);
  });

  it('keeps final allocation under the soft limit in the normal case', () => {
    const result = allocateElasticStageContextBudget({
      ...baseInput,
      demands: [
        demand({
          id: 'storyMemory',
          availableTokens: 3_000,
          minTokens: 300,
          targetTokens: 2_000,
          maxTokens: 3_000,
          priority: 5,
          relevance: 0.8,
          requirement: 'preferred',
        }),
        demand({
          id: 'worldbook',
          availableTokens: 2_000,
          minTokens: 200,
          targetTokens: 1_200,
          maxTokens: 2_000,
          priority: 3,
          relevance: 0.6,
          requirement: 'optional',
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.finalEstimatedInputTokens).toBeLessThanOrEqual(
      result.trace.softInputLimit,
    );
    expect(result.trace.riskLevel).toBe('normal');
  });
});

describe('allocateElasticStageContextBudget — empty module reclaim', () => {
  it('gives zero to empty modules and reuses the budget elsewhere', () => {
    const result = allocateElasticStageContextBudget({
      ...baseInput,
      demands: [
        demand({
          id: 'note', // empty note: no content
          availableTokens: 0,
          minTokens: 500,
          targetTokens: 500,
          maxTokens: 500,
          priority: 2,
          relevance: 0.5,
          requirement: 'optional',
        }),
        demand({
          id: 'recentBridge',
          availableTokens: 4_000,
          minTokens: 400,
          targetTokens: 4_000,
          maxTokens: 4_000,
          priority: 8,
          relevance: 0.9,
          requirement: 'preferred',
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allocations.get('note')).toBe(0);
    expect(result.allocations.get('recentBridge')).toBe(4_000);
    const note = result.trace.modules.find(m => m.id === 'note')!;
    expect(note.finalAllocatedTokens).toBe(0);
  });

  it('does not allocate more than the module actually contains', () => {
    const result = allocateElasticStageContextBudget({
      ...baseInput,
      demands: [
        demand({
          id: 'character',
          availableTokens: 200, // content shorter than min
          minTokens: 800,
          targetTokens: 800,
          maxTokens: 800,
          priority: 4,
          relevance: 0.7,
          requirement: 'preferred',
        }),
        demand({
          id: 'storyMemory',
          availableTokens: 2_000,
          minTokens: 300,
          targetTokens: 2_000,
          maxTokens: 2_000,
          priority: 5,
          relevance: 0.8,
          requirement: 'preferred',
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // reclaimed gap goes to the hungry storyMemory module
    expect(result.allocations.get('character')).toBeLessThanOrEqual(200);
    expect(result.allocations.get('storyMemory')).toBe(2_000);
  });
});

describe('allocateElasticStageContextBudget — burst borrowing', () => {
  it('lets a high-relevance preferred module enter 80%~95%', () => {
    const result = allocateElasticStageContextBudget({
      ...baseInput,
      demands: [
        demand({
          id: 'outline', // mandatory
          availableTokens: 9_000,
          minTokens: 9_000,
          targetTokens: 9_000,
          maxTokens: 9_000,
          priority: 10,
          relevance: 1,
          requirement: 'mandatory',
        }),
        demand({
          id: 'worldbook',
          availableTokens: 4_000,
          minTokens: 200,
          targetTokens: 4_000,
          maxTokens: 4_000,
          priority: 4,
          relevance: 0.95,
          requirement: 'preferred',
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // mandatory 9000 > soft 10560? No — 9000 < 10560, soft pool = 1560.
    // worldbook takes soft 1560 then borrows burst (1560 + burst*0.75).
    const final = result.trace.finalEstimatedInputTokens;
    expect(final).toBeGreaterThan(result.trace.softInputLimit);
    expect(final).toBeLessThanOrEqual(result.trace.burstInputLimit);
    const wb = result.trace.modules.find(m => m.id === 'worldbook')!;
    expect(wb.burstBorrowedTokens).toBeGreaterThan(0);
    expect(result.trace.riskLevel).toBe('elevated');
  });

  it('never lets an ordinary optional module borrow burst while soft pool has room', () => {
    const result = allocateElasticStageContextBudget({
      ...baseInput,
      demands: [
        demand({
          id: 'optionalNote',
          availableTokens: 3_000,
          minTokens: 100,
          targetTokens: 3_000,
          maxTokens: 3_000,
          priority: 1,
          relevance: 0.9,
          requirement: 'optional',
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const note = result.trace.modules.find(m => m.id === 'optionalNote')!;
    expect(note.burstBorrowedTokens).toBe(0);
    expect(result.trace.finalEstimatedInputTokens).toBeLessThanOrEqual(
      result.trace.softInputLimit,
    );
  });

  it('caps automatic burst use at 75% of the burst pool', () => {
    const result = allocateElasticStageContextBudget({
      ...baseInput,
      demands: [
        demand({
          id: 'storyMemory',
          availableTokens: 20_000,
          minTokens: 1_000,
          targetTokens: 20_000,
          maxTokens: 20_000,
          priority: 10,
          relevance: 1,
          requirement: 'preferred',
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const burstTotal = result.trace.burstPoolTotal; // 13200 - 10560 = 2640
    const burstUsed = result.trace.burstPoolUsed;
    expect(burstUsed).toBeLessThanOrEqual(Math.floor(burstTotal * 0.75));
  });
});

describe('allocateElasticStageContextBudget — mandatory protection', () => {
  it('allows running when mandatory exceeds 80% but stays under the hard limit', () => {
    const result = allocateElasticStageContextBudget({
      ...baseInput,
      demands: [
        demand({
          id: 'outline',
          availableTokens: 11_000,
          minTokens: 11_000,
          targetTokens: 11_000,
          maxTokens: 11_000,
          priority: 10,
          relevance: 1,
          requirement: 'mandatory',
        }),
        demand({
          id: 'optionalNote',
          availableTokens: 3_000,
          minTokens: 100,
          targetTokens: 3_000,
          maxTokens: 3_000,
          priority: 1,
          relevance: 0.9,
          requirement: 'optional',
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.mandatoryTokens).toBe(11_000); // > soft 10560
    expect(result.trace.mandatoryTokens).toBeLessThanOrEqual(
      result.trace.hardInputLimit,
    );
    expect(result.trace.riskLevel).toBe('high');
    // optional competes inside the elastic band (doc §18.2) but ≤ 95% line
    expect(result.trace.finalEstimatedInputTokens).toBeLessThanOrEqual(
      result.trace.burstInputLimit,
    );
  });

  it('blocks with zero allocations when mandatory exceeds the hard limit', () => {
    const result = allocateElasticStageContextBudget({
      ...baseInput,
      demands: [
        demand({
          id: 'outline',
          availableTokens: 14_000, // > hard 13200
          minTokens: 14_000,
          targetTokens: 14_000,
          maxTokens: 14_000,
          priority: 10,
          relevance: 1,
          requirement: 'mandatory',
        }),
        demand({
          id: 'storyMemory',
          availableTokens: 1_000,
          minTokens: 100,
          targetTokens: 1_000,
          maxTokens: 1_000,
          priority: 5,
          relevance: 0.8,
          requirement: 'preferred',
        }),
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('mandatory_overflow');
    expect(result.allocations.get('storyMemory')).toBe(0);
  });

  it('never reduces mandatory allocations', () => {
    const result = allocateElasticStageContextBudget({
      ...baseInput,
      demands: [
        demand({
          id: 'system',
          availableTokens: 1_500,
          minTokens: 1_500,
          targetTokens: 1_500,
          maxTokens: 1_500,
          priority: 10,
          relevance: 1,
          requirement: 'mandatory',
        }),
        demand({
          id: 'body',
          availableTokens: 5_000,
          minTokens: 5_000,
          targetTokens: 5_000,
          maxTokens: 5_000,
          priority: 10,
          relevance: 1,
          requirement: 'mandatory',
        }),
        demand({
          id: 'worldbook',
          availableTokens: 20_000,
          minTokens: 100,
          targetTokens: 20_000,
          maxTokens: 20_000,
          priority: 5,
          relevance: 0.9,
          requirement: 'optional',
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allocations.get('system')).toBe(1_500);
    expect(result.allocations.get('body')).toBe(5_000);
  });
});

describe('allocateElasticStageContextBudget — safety margin', () => {
  it('never borrows the hard safety margin', () => {
    const result = allocateElasticStageContextBudget({
      ...baseInput,
      demands: [
        demand({
          id: 'storyMemory',
          availableTokens: 100_000,
          minTokens: 1_000,
          targetTokens: 100_000,
          maxTokens: 100_000,
          priority: 10,
          relevance: 1,
          requirement: 'preferred',
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // final ≤ soft + 75% burst = 95% of C; never reaches C + safety margin
    expect(result.trace.finalEstimatedInputTokens).toBeLessThanOrEqual(
      result.trace.burstInputLimit,
    );
    expect(result.trace.finalEstimatedInputTokens).toBeLessThanOrEqual(
      result.trace.contextWindow -
        result.trace.reservedOutputTokens -
        result.trace.safetyMargin,
    );
  });
});

describe('allocateElasticStageContextBudget — determinism', () => {
  const build = () => ({
    ...baseInput,
    demands: [
      demand({
        id: 'a_storyMemory',
        availableTokens: 3_200,
        minTokens: 300,
        targetTokens: 2_400,
        maxTokens: 3_200,
        priority: 6,
        relevance: 0.85,
        requirement: 'preferred',
      }),
      demand({
        id: 'b_worldbook',
        availableTokens: 1_800,
        minTokens: 150,
        targetTokens: 1_500,
        maxTokens: 1_800,
        priority: 4,
        relevance: 0.72,
        requirement: 'preferred',
      }),
      demand({
        id: 'c_note',
        availableTokens: 900,
        minTokens: 80,
        targetTokens: 600,
        maxTokens: 900,
        priority: 2,
        relevance: 0.4,
        requirement: 'optional',
      }),
      demand({
        id: 'd_episodic',
        availableTokens: 2_700,
        minTokens: 250,
        targetTokens: 2_000,
        maxTokens: 2_700,
        priority: 5,
        relevance: 0.6,
        requirement: 'optional',
      }),
    ],
  });

  it('produces identical results for identical input', () => {
    const r1 = allocateElasticStageContextBudget(build());
    const r2 = allocateElasticStageContextBudget(build());
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('keeps the trace stable across replays (retry reuse)', () => {
    const r1 = allocateElasticStageContextBudget(build());
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const traceJson = JSON.stringify(r1.trace);
    const r2 = allocateElasticStageContextBudget(build());
    expect(JSON.stringify(r2.trace)).toBe(traceJson);
  });
});

describe('allocateElasticStageContextBudget — conservation properties', () => {
  // Deterministic PRNG so property tests are reproducible (Lehmer, no bitops).
  function seededRandom(seed: number): () => number {
    let s = Math.abs(seed) % 2147483647;
    if (s === 0) s = 1;
    return () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }

  it('holds all invariants across randomized inputs', () => {
    const rand = seededRandom(42);
    for (let trial = 0; trial < 200; trial += 1) {
      const count = 3 + Math.floor(rand() * 6); // 3..8 modules
      const demands: ElasticContextDemand[] = [];
      for (let i = 0; i < count; i += 1) {
        const req =
          i === 0
            ? 'mandatory'
            : rand() < 0.4
              ? 'preferred'
              : 'optional';
        const available = Math.floor(rand() * 8_000);
        const maxTokens = Math.floor(available * (0.5 + rand() * 0.5));
        const minTokens =
          req === 'mandatory'
            ? maxTokens
            : Math.floor(maxTokens * (rand() * 0.3));
        const targetTokens = Math.min(
          maxTokens,
          Math.max(minTokens, Math.floor(maxTokens * (0.4 + rand() * 0.6))),
        );
        demands.push(
          demand({
            id: `m${i}`,
            availableTokens: available,
            minTokens,
            targetTokens,
            maxTokens,
            priority: 1 + Math.floor(rand() * 9),
            relevance: rand(),
            requirement: req,
            reclaimable: req !== 'mandatory',
            shrinkPriority: Math.floor(rand() * 10),
            burstPriority: Math.floor(rand() * 10),
          }),
        );
      }
      const window = 8_000 + Math.floor(rand() * 24_000);
      const reserved = Math.floor(rand() * 3_000);
      const safety = 256 + Math.floor(rand() * 1_000);
      const result = allocateElasticStageContextBudget({
        contextWindow: window,
        reservedOutputTokens: reserved,
        safetyMargin: safety,
        demands,
      });

      const hard =
        window - reserved - safety - (window - reserved - safety < 0 ? window - reserved - safety : 0);
      for (const d of demands) {
        const allocated = result.allocations.get(d.id) ?? 0;
        expect(allocated).toBeGreaterThanOrEqual(0);
        expect(allocated).toBeLessThanOrEqual(d.availableTokens);
        expect(allocated).toBeLessThanOrEqual(d.maxTokens);
        if (d.availableTokens === 0) expect(allocated).toBe(0);
        if (d.requirement === 'mandatory') {
          expect(allocated).toBe(Math.min(d.availableTokens, d.maxTokens));
        }
      }
      if (result.ok) {
        let sum = 0;
        for (const d of demands) sum += result.allocations.get(d.id) ?? 0;
        expect(sum).toBeLessThanOrEqual(hard);
        expect(result.trace.finalEstimatedInputTokens).toBe(sum);
      }
    }
  });

  it('is deterministic under repeated randomized trials', () => {
    const rand = seededRandom(7);
    for (let trial = 0; trial < 50; trial += 1) {
      const demands = Array.from({ length: 5 }, (_, i) => {
        const available = Math.floor(rand() * 6_000);
        const maxTokens = Math.floor(available * (0.5 + rand() * 0.5));
        return demand({
          id: `m${i}`,
          availableTokens: available,
          minTokens: Math.floor(maxTokens * 0.2),
          targetTokens: maxTokens,
          maxTokens,
          priority: 1 + Math.floor(rand() * 9),
          relevance: rand(),
          requirement: rand() < 0.3 ? 'preferred' : 'optional',
        });
      });
      const input = {
        contextWindow: 12_000 + Math.floor(rand() * 12_000),
        reservedOutputTokens: 1_000 + Math.floor(rand() * 2_000),
        safetyMargin: 400 + Math.floor(rand() * 800),
        demands,
      };
      const a = allocateElasticStageContextBudget(input);
      const b = allocateElasticStageContextBudget(input);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});
