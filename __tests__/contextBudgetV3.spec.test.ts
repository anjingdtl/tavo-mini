/**
 * Context Budget V3 — Hierarchical Elastic spec tests.
 *
 * Drives the implementation of the V3 hierarchical board/item elastic budget
 * system described in
 * `docs/optimization/Tavo-Mini-Context-Budget-V3-Hierarchical-Elastic-Optimization-Plan.md`.
 *
 * These tests initially fail; they turn green as the V3 modules land:
 *   - src/services/context/hierarchicalContextAllocator.ts
 *   - src/services/context/resourceContextCandidates.ts
 *   - src/services/contextAutomationPolicy.ts (ContextAutomationPolicyV3)
 *
 * Versioning note: the new V3 hierarchical system uses `context_budget_version
 * = 6`. The literal value 3 is already taken by the legacy V3/profile-2 chain
 * that v46→v47 deletes; bumping to 6 preserves the existing version discipline
 * (resume gate, freeze-on-create, no auto-upgrade) while delivering the plan's
 * "V3 hierarchical elastic" semantics.
 */

import {
  DEFAULT_CONTEXT_AUTOMATION_POLICY_V3,
  isContextAutomationPolicyV3,
} from '../src/services/contextAutomationPolicy';
import {
  allocateDemandsWithinCapacity,
  type DemandAllocationInput,
} from '../src/services/pipeline/elasticBudgetAllocator';
import {
  allocateHierarchicalContextBudget,
  type HierarchicalBudgetInput,
} from '../src/services/context/hierarchicalContextAllocator';

describe('Context Budget V3 — policy preset', () => {
  test('default policy is valid V3', () => {
    expect(DEFAULT_CONTEXT_AUTOMATION_POLICY_V3.schemaVersion).toBe(3);
    expect(DEFAULT_CONTEXT_AUTOMATION_POLICY_V3.allocatorVersion).toBe(
      'context-automation-v3',
    );
    expect(
      isContextAutomationPolicyV3(DEFAULT_CONTEXT_AUTOMATION_POLICY_V3),
    ).toBe(true);
  });

  test('softRatio + elasticCeilingRatio per board respects soft <= ceiling', () => {
    const p = DEFAULT_CONTEXT_AUTOMATION_POLICY_V3;
    for (const key of Object.keys(p.boards) as Array<keyof typeof p.boards>) {
      const board = p.boards[key];
      expect(board.softRatio).toBeGreaterThan(0);
      expect(board.softRatio).toBeLessThanOrEqual(board.elasticCeilingRatio);
    }
  });

  test('board ratios fit inside the elastic pool with a global reserve', () => {
    const p = DEFAULT_CONTEXT_AUTOMATION_POLICY_V3;
    const softSum =
      p.boards.storyState.softRatio +
      p.boards.resources.softRatio +
      p.boards.slidingWindow.softRatio +
      p.boards.episodic.softRatio +
      p.globalReserveRatio;
    // Soft targets collectively must not exceed 1.0 of the elastic pool.
    expect(softSum).toBeLessThanOrEqual(1.0 + 1e-9);
  });
});

describe('allocateDemandsWithinCapacity — shared core', () => {
  const baseDemand = (
    overrides: Partial<DemandAllocationInput['demands'][number]> = {},
  ): DemandAllocationInput['demands'][number] => ({
    id: 'a',
    availableTokens: 1000,
    minTokens: 0,
    targetTokens: 1000,
    maxTokens: 1000,
    priority: 1,
    relevance: 1,
    requirement: 'optional',
    ...overrides,
  });

  test('full-fit small demands before watering large demands', () => {
    // Plan §7 example: A=700, B=1500, C=12000, grant=8000 → A and B full, C gets remainder.
    const result = allocateDemandsWithinCapacity({
      capacity: 8000,
      demands: [
        baseDemand({ id: 'A', availableTokens: 700, targetTokens: 700, maxTokens: 700 }),
        baseDemand({ id: 'B', availableTokens: 1500, targetTokens: 1500, maxTokens: 1500 }),
        baseDemand({ id: 'C', availableTokens: 12000, targetTokens: 12000, maxTokens: 12000 }),
      ],
    });
    expect(result.allocations.get('A')).toBe(700);
    expect(result.allocations.get('B')).toBe(1500);
    expect(result.allocations.get('C')).toBe(8000 - 700 - 1500);
  });

  test('total never exceeds capacity', () => {
    const result = allocateDemandsWithinCapacity({
      capacity: 5000,
      demands: [
        baseDemand({ id: 'x', availableTokens: 4000 }),
        baseDemand({ id: 'y', availableTokens: 4000 }),
      ],
    });
    const total =
      (result.allocations.get('x') ?? 0) + (result.allocations.get('y') ?? 0);
    expect(total).toBeLessThanOrEqual(5000);
  });

  test('deterministic under identical input', () => {
    const input: DemandAllocationInput = {
      capacity: 10000,
      demands: [
        baseDemand({ id: 'a', availableTokens: 5000, priority: 5, relevance: 0.5 }),
        baseDemand({ id: 'b', availableTokens: 5000, priority: 5, relevance: 0.5 }),
        baseDemand({ id: 'c', availableTokens: 5000, priority: 3, relevance: 0.9 }),
      ],
    };
    const r1 = allocateDemandsWithinCapacity(input);
    const r2 = allocateDemandsWithinCapacity(input);
    expect(JSON.stringify(r1)).toEqual(JSON.stringify(r2));
  });

  test('mandatory protected over preferred/optional', () => {
    const result = allocateDemandsWithinCapacity({
      capacity: 1000,
      demands: [
        baseDemand({
          id: 'mand',
          availableTokens: 800,
          targetTokens: 800,
          maxTokens: 800,
          requirement: 'mandatory',
        }),
        baseDemand({ id: 'opt', availableTokens: 500, targetTokens: 500 }),
      ],
    });
    expect(result.allocations.get('mand')).toBe(800);
    expect(result.allocations.get('opt')).toBe(200);
  });

  test('NaN/Infinity rejected defensively', () => {
    expect(() =>
      allocateDemandsWithinCapacity({
        capacity: NaN,
        demands: [baseDemand()],
      }),
    ).toThrow();
    expect(() =>
      allocateDemandsWithinCapacity({
        capacity: 1000,
        demands: [baseDemand({ availableTokens: Infinity })],
      }),
    ).toThrow();
  });

  test('property: random allocations never violate invariants', () => {
    // Seeded Lehmer PRNG — deterministic despite "random" inputs.
    let seed = 42;
    const rnd = () => {
      seed = (seed * 48271) % 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let trial = 0; trial < 500; trial += 1) {
      const capacity = Math.floor(rnd() * 100000) + 1;
      const n = Math.floor(rnd() * 20);
      const demands = Array.from({ length: n }, (_, i) => {
        const avail = Math.floor(rnd() * 50000);
        const requirement = rnd() < 0.2 ? 'mandatory' : rnd() < 0.5 ? 'preferred' : 'optional';
        return baseDemand({
          id: `d${i}`,
          availableTokens: avail,
          targetTokens: avail,
          maxTokens: avail,
          minTokens: Math.floor(avail * 0.1),
          priority: Math.floor(rnd() * 10) + 1,
          relevance: rnd(),
          requirement: requirement as DemandAllocationInput['demands'][number]['requirement'],
        });
      });
      const result = allocateDemandsWithinCapacity({ capacity, demands });
      let total = 0;
      for (const d of demands) {
        const a = result.allocations.get(d.id) ?? 0;
        expect(Number.isFinite(a)).toBe(true);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(d.maxTokens);
        total += a;
      }
      expect(total).toBeLessThanOrEqual(capacity);
    }
  });
});

describe('allocateHierarchicalContextBudget — board/item elastic', () => {
  const buildInput = (
    overrides: Partial<HierarchicalBudgetInput>,
  ): HierarchicalBudgetInput => ({
    contextWindow: 200_000,
    reservedOutputTokens: 40_000,
    mandatoryTokens: 5_000,
    policy: DEFAULT_CONTEXT_AUTOMATION_POLICY_V3,
    boards: {
      storyState: { actualDemandTokens: 3_000 },
      resources: { actualDemandTokens: 42_000 },
      slidingWindow: { actualDemandTokens: 10_000 },
      episodic: { actualDemandTokens: 2_000 },
    },
    ...overrides,
  });

  test('board grant grows when other boards are under soft target (T5 reclaim)', () => {
    // Story/episodic are tiny — their unused soft budget should flow to Resources.
    const result = allocateHierarchicalContextBudget(buildInput({}));
    const resources = result.boardAllocations.resources;
    expect(resources.allocatedTokens).toBeGreaterThan(resources.softTargetTokens);
    expect(resources.borrowedTokens).toBeGreaterThan(0);
  });

  test('board grant never exceeds elastic ceiling', () => {
    const result = allocateHierarchicalContextBudget(buildInput({}));
    for (const key of Object.keys(result.boardAllocations) as Array<
      keyof typeof result.boardAllocations
    >) {
      const b = result.boardAllocations[key];
      expect(b.allocatedTokens).toBeLessThanOrEqual(b.elasticMaxTokens);
    }
  });

  test('total allocated never exceeds Hard envelope', () => {
    const result = allocateHierarchicalContextBudget(
      buildInput({
        contextWindow: 32_000,
        reservedOutputTokens: 6_400,
      }),
    );
    const totalBoard = Object.values(result.boardAllocations).reduce(
      (sum, b) => sum + b.allocatedTokens,
      0,
    );
    expect(totalBoard + result.envelope.mandatoryTokens).toBeLessThanOrEqual(
      result.envelope.hardInputLimit,
    );
  });

  test('1M model is not locked to a static resourceBudget (T1/T2)', () => {
    // With a 1M window and 42K resource demand, Resources must get the full 42K
    // (well below ceiling), not be capped by some legacy absolute number.
    const result = allocateHierarchicalContextBudget(
      buildInput({
        contextWindow: 1_000_000,
        reservedOutputTokens: 200_000,
      }),
    );
    const resources = result.boardAllocations.resources;
    expect(resources.allocatedTokens).toBe(42_000);
  });

  test('soft targets scale linearly with model window (T1)', () => {
    const small = allocateHierarchicalContextBudget(
      buildInput({ contextWindow: 32_000, reservedOutputTokens: 6_400 }),
    );
    const large = allocateHierarchicalContextBudget(
      buildInput({ contextWindow: 1_000_000, reservedOutputTokens: 200_000 }),
    );
    expect(large.boardAllocations.resources.softTargetTokens).toBeGreaterThan(
      small.boardAllocations.resources.softTargetTokens,
    );
  });

  test('deterministic — same input byte-identical allocation', () => {
    const input = buildInput({});
    const r1 = allocateHierarchicalContextBudget(input);
    const r2 = allocateHierarchicalContextBudget(input);
    expect(JSON.stringify(r1)).toEqual(JSON.stringify(r2));
  });

  test('explicit resource candidates beat fallback in item allocator (T7)', () => {
    // Resources board is given an item-level allocation; explicit candidates
    // must outrank auto-activated ones when budget is short.
    const result = allocateHierarchicalContextBudget(
      buildInput({
        contextWindow: 32_000,
        reservedOutputTokens: 6_400,
        resourceItems: [
          {
            id: 'char-explicit',
            sourceKind: 'character',
            actualTokens: 8000,
            explicitSelected: true,
            activated: true,
            priority: 5,
            relevance: 0.6,
            requirement: 'preferred',
            sourceOrder: 0,
          },
          {
            id: 'wb-fallback',
            sourceKind: 'worldbook',
            actualTokens: 8000,
            explicitSelected: false,
            activated: true,
            activationReason: 'project_fallback',
            priority: 5,
            relevance: 0.45,
            requirement: 'optional',
            sourceOrder: 1,
          },
        ],
      }),
    );
    const explicit = result.resourceItemAllocations?.get('char-explicit');
    const fallback = result.resourceItemAllocations?.get('wb-fallback');
    expect((explicit ?? 0)).toBeGreaterThanOrEqual((fallback ?? 0));
  });
});
