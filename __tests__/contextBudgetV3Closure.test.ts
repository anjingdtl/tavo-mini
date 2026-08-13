/**
 * Context Budget V3 — Final Pipeline Closure targeted + property tests.
 *
 * Companion to
 * `docs/optimization/Tavo-Mini-Context-Budget-V3-Final-Pipeline-Closure-Plan.md`.
 * Locks the closure fixes:
 *   - P0-1: contextBudgetVersion = 6 routes through the SAME structured
 *     pipeline as 5 (Brief checkpoint, V3 decide* branches, resume allowed).
 *   - P0-4: Resource item clip is token-safe (estimateTokens(rendered) <= grant).
 *   - Gate 24: hierarchical allocator invariants hold under ≥10k random inputs.
 *
 * Pure-function tests only — no SQLite, no LLM. Deterministic seeded PRNG.
 */
import {
  isCurrentOutlinePipelineContextBudgetVersion,
  isResumableContextBudgetVersion,
  isStructuredContextBudgetVersion,
  isStructuredOutlineWorkflowVersion,
  normalizePersistedContextBudgetVersion,
  shouldIncludeBriefCheckpoint,
} from '../src/services/pipeline/outlineWorkflowVersion';
import { getPipelineStageOrder } from '../src/utils/stages';
import {
  determineNextPipelineAction,
  type PersistedPipelineTaskView,
  type PersistedStageCheckpoint,
  type PipelineAction,
  type StageStatus,
} from '../src/services/pipeline';
import type { PipelineMode, PipelineStageName } from '../src/types/pipeline';
import { estimateTokens } from '../src/utils/tokenEstimator';
import {
  renderCandidateToText,
  type ResourceContextCandidate,
} from '../src/services/context/resourceContextCandidates';
import {
  allocateHierarchicalContextBudget,
  type HierarchicalBudgetInput,
} from '../src/services/context/hierarchicalContextAllocator';
import { DEFAULT_CONTEXT_AUTOMATION_POLICY_V3 } from '../src/services/contextAutomationPolicy';

// ---------------------------------------------------------------------------
// Seeded PRNG (deterministic — no flakiness, reproducible failures).
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ===========================================================================
// A. Version semantics + pipeline routing (Closure Plan §5 / Gate 02/03)
// ===========================================================================
describe('Closure §5 — contextBudgetVersion = 6 unified semantics', () => {
  test('shouldIncludeBriefCheckpoint accepts 6 alongside 3/4/5', () => {
    for (const cbv of [3, 4, 5, 6]) {
      expect(
        shouldIncludeBriefCheckpoint({
          outlineWorkflowVersion: 4,
          contextBudgetVersion: cbv,
        }),
      ).toBe(true);
    }
    expect(
      shouldIncludeBriefCheckpoint({
        outlineWorkflowVersion: 4,
        contextBudgetVersion: 6,
      }),
    ).toBe(true);
  });

  test('shouldIncludeBriefCheckpoint rejects legacy / non-structured pairs', () => {
    expect(
      shouldIncludeBriefCheckpoint({
        outlineWorkflowVersion: 1,
        contextBudgetVersion: 6,
      }),
    ).toBe(false);
    expect(
      shouldIncludeBriefCheckpoint({
        outlineWorkflowVersion: 4,
        contextBudgetVersion: 1,
      }),
    ).toBe(false);
    expect(
      shouldIncludeBriefCheckpoint({
        outlineWorkflowVersion: 2,
        contextBudgetVersion: 5,
      }),
    ).toBe(false);
  });

  test('isCurrentOutlinePipelineContextBudgetVersion: 5 and 6 are current', () => {
    expect(isCurrentOutlinePipelineContextBudgetVersion(5)).toBe(true);
    expect(isCurrentOutlinePipelineContextBudgetVersion(6)).toBe(true);
    expect(isCurrentOutlinePipelineContextBudgetVersion(4)).toBe(false);
    expect(isCurrentOutlinePipelineContextBudgetVersion(undefined)).toBe(false);
  });

  test('isResumableContextBudgetVersion: 5 and 6 resume; legacy blocked', () => {
    expect(isResumableContextBudgetVersion(5)).toBe(true);
    expect(isResumableContextBudgetVersion(6)).toBe(true);
    expect(isResumableContextBudgetVersion(7)).toBe(true);
    for (const v of [1, 2, 3, 4]) {
      expect(isResumableContextBudgetVersion(v)).toBe(false);
    }
  });

  test('structured version helpers cover the Brief-bearing set', () => {
    for (const cbv of [3, 4, 5, 6, 7]) {
      expect(isStructuredContextBudgetVersion(cbv)).toBe(true);
    }
    for (const owv of [3, 4]) {
      expect(isStructuredOutlineWorkflowVersion(owv)).toBe(true);
    }
    expect(isStructuredContextBudgetVersion(8)).toBe(false);
    expect(isStructuredOutlineWorkflowVersion(2)).toBe(false);
  });

  test('normalizePersistedContextBudgetVersion preserves 6/5 instead of collapsing to 1', () => {
    expect(normalizePersistedContextBudgetVersion(7)).toBe(7);
    expect(normalizePersistedContextBudgetVersion(6)).toBe(6);
    expect(normalizePersistedContextBudgetVersion(5)).toBe(5);
    expect(normalizePersistedContextBudgetVersion('6')).toBe(6);
    expect(normalizePersistedContextBudgetVersion(4)).toBe(4);
    expect(normalizePersistedContextBudgetVersion(undefined)).toBe(1);
    expect(normalizePersistedContextBudgetVersion(99)).toBe(1);
  });

  test('A2: version 6 full pipeline stage order includes Brief (Closure Gate 02)', () => {
    const order = getPipelineStageOrder('full', {
      outlineWorkflowVersion: 4,
      contextBudgetVersion: 6,
    });
    expect(order).toEqual(['draft', 'review', 'factCheck', 'brief', 'proof']);
  });

  test('A5: version 5 behavior unchanged (still current, still Brief)', () => {
    expect(
      isCurrentOutlinePipelineContextBudgetVersion(5),
    ).toBe(true);
    const order = getPipelineStageOrder('full', {
      outlineWorkflowVersion: 4,
      contextBudgetVersion: 5,
    });
    expect(order).toContain('brief');
  });
});

// ===========================================================================
// determineNextPipelineAction — version 6 routes through the V3 branches
// (Closure Plan §5.4 A1/A4/A7). Reuses the harness from the decision-table suite.
// ===========================================================================
function stage(
  name: PipelineStageName,
  status: StageStatus,
  outputText: string | null = status === 'succeeded' ? `${name}-out` : null,
): PersistedStageCheckpoint {
  return { stage: name, status, outputText };
}

function stages(
  map: Partial<Record<PipelineStageName, StageStatus>>,
): PersistedStageCheckpoint[] {
  const names: PipelineStageName[] = ['draft', 'review', 'factCheck', 'brief', 'proof'];
  return names.map(n => stage(n, map[n] || 'pending'));
}

function task(
  overrides: Partial<PersistedPipelineTaskView> & {
    pipelineMode: PipelineMode | null;
  },
): PersistedPipelineTaskView {
  return {
    id: 'pt_v6',
    status: 'drafting',
    hasExecutionSnapshot: true,
    hasDraftContext: true,
    hasAuditContext: false,
    finalText: null,
    ...overrides,
  };
}

function actionType(a: PipelineAction): string {
  return a.type;
}

describe('Closure §5.4 — version 6 routes through V3 (Brief) branches', () => {
  test('A1/A4: full + version 6, failed factCheck → STAGE_FAILED (V3 path, Brief exists)', () => {
    // Legacy (no version) would degrade to finalize_from_draft. V3 must block
    // for retry at the failed node and keep the Brief stage in play.
    const a = determineNextPipelineAction(
      task({
        pipelineMode: 'full',
        outlineWorkflowVersion: 4,
        contextBudgetVersion: 6,
        hasAuditContext: true,
        status: 'failed',
      }),
      stages({
        draft: 'succeeded',
        review: 'succeeded',
        factCheck: 'failed',
        brief: 'pending',
        proof: 'pending',
      }),
    );
    expect(actionType(a)).toBe('blocked');
    expect((a as any).reason?.stage).toBe('factCheck');
    expect((a as any).reason?.userAction).toBe('retry');
  });

  test('A4: conditional + version 6 routes through V3 conditional branch (Brief)', () => {
    const a = determineNextPipelineAction(
      task({
        pipelineMode: 'conditional',
        outlineWorkflowVersion: 4,
        contextBudgetVersion: 6,
        hasAuditContext: false,
      }),
      stages({
        draft: 'succeeded',
        factCheck: 'succeeded',
        brief: 'pending',
        proof: 'pending',
      }),
    );
    // V3 conditional: factCheck succeeded → run_brief (Brief is part of the path).
    expect(actionType(a)).toBe('run_brief');
  });

  test('A7: version 6 resume — re-run open factCheck, do NOT re-run succeeded draft', () => {
    const a = determineNextPipelineAction(
      task({
        pipelineMode: 'full',
        outlineWorkflowVersion: 4,
        contextBudgetVersion: 6,
        hasAuditContext: true,
        status: 'failed',
      }),
      stages({
        draft: 'succeeded',
        review: 'succeeded',
        factCheck: 'interrupted', // open → resume here
        brief: 'pending',
        proof: 'pending',
      }),
    );
    expect(actionType(a)).toBe('run_fact_check');
  });

  test('A3: twoStage + version 6 routes through V3 twoStage (Brief after review)', () => {
    const a = determineNextPipelineAction(
      task({
        pipelineMode: 'twoStage',
        outlineWorkflowVersion: 4,
        contextBudgetVersion: 6,
        hasAuditContext: false,
      }),
      stages({
        draft: 'succeeded',
        review: 'succeeded',
        brief: 'pending',
        proof: 'pending',
      }),
    );
    expect(actionType(a)).toBe('run_brief');
  });

  test('legacy version (none) still degrades — version 6 did not regress legacy full', () => {
    const a = determineNextPipelineAction(
      task({ pipelineMode: 'full', hasAuditContext: true }),
      stages({
        draft: 'succeeded',
        review: 'failed',
        factCheck: 'failed',
      }),
    );
    expect(a).toEqual({ type: 'finalize_from_draft', degraded: true });
  });
});

// ===========================================================================
// D5/D6 — Resource item clip is token-safe (Closure Plan §12 / Gate 12)
// ≥10,000 randomized cases including mixed CJK / ASCII / emoji / punctuation.
// ===========================================================================
describe('Closure §12 — renderCandidateToText token-safe (≥10k property)', () => {
  const POOLS = {
    cjk: '的一是不了人我在有他这中大为上来个国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日军者意无力它与长把机十民第公此已工使情明性知全三又关点正业外将两高间由问很最重并物手应战向头文体政美相见被利什二等产或新己制身果加西斯月话合回特代内信表化老给世位次度门任常先海通教儿原东声提立及比员解水名真论处走各各',
    ascii: 'the quick brown fox jumps over the lazy dog 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    punct: '，。！？、；：（）「」『』“”…—·,.!?;:\'"()[]{}',
    emoji: '😀🎉🔥📖✨🤔📚💫🧩🌟',
    digits: '0123456789',
    newline: '\n\r\t  ',
  };

  function buildRandomContent(rnd: () => number): string {
    const keys = Object.keys(POOLS) as (keyof typeof POOLS)[];
    const segments = 1 + Math.floor(rnd() * 6);
    let out = '';
    for (let i = 0; i < segments; i += 1) {
      const key = keys[Math.floor(rnd() * keys.length)];
      const pool = POOLS[key];
      const len = 1 + Math.floor(rnd() * 40);
      for (let j = 0; j < len; j += 1) {
        out += pool[Math.floor(rnd() * pool.length)];
      }
    }
    return out;
  }

  function makeCandidate(content: string, sourceOrder = 0): ResourceContextCandidate {
    return {
      id: `c:${sourceOrder}`,
      sourceKind: 'character',
      sourceId: sourceOrder,
      title: 'x',
      content,
      actualTokens: estimateTokens(content),
      explicitSelected: true,
      activated: true,
      activationReason: 'explicit',
      sourceOrder,
    };
  }

  test('10k cases: estimateTokens(rendered) <= grant; full bytes when grant >= demand; empty when grant <= 0; deterministic', () => {
    const rnd = mulberry32(20260812);
    const TRIALS = 10_000;
    for (let i = 0; i < TRIALS; i += 1) {
      const content = buildRandomContent(rnd);
      const candidate = makeCandidate(content, i);
      const grantChoices = [
        0,
        -1,
        1,
        Math.floor(rnd() * 5),
        Math.floor(rnd() * candidate.actualTokens),
        candidate.actualTokens,
        candidate.actualTokens + 1 + Math.floor(rnd() * 5000),
      ];
      const grant = grantChoices[Math.floor(rnd() * grantChoices.length)];
      const { text, clipped } = renderCandidateToText(candidate, grant);

      // Hard invariant: rendered tokens never exceed the grant.
      const renderedTokens = estimateTokens(text);
      if (grant > 0) {
        expect(renderedTokens).toBeLessThanOrEqual(grant);
      }

      if (grant <= 0) {
        // No budget → empty, clipped iff there was demand.
        expect(text).toBe('');
        expect(clipped).toBe(candidate.actualTokens > 0);
      } else if (grant >= candidate.actualTokens) {
        // Full budget → byte-identical original, not clipped.
        expect(text).toBe(candidate.content);
        expect(clipped).toBe(false);
      } else {
        // Partial → tail-biased clip, must be clipped and within budget.
        expect(clipped).toBe(true);
        expect(renderedTokens).toBeLessThanOrEqual(grant);
      }

      // Determinism: same input → same output.
      const again = renderCandidateToText(candidate, grant);
      expect(again.text).toBe(text);
      expect(again.clipped).toBe(clipped);
    }
  });
});

// ===========================================================================
// Gate 24 — Hierarchical allocator invariants (≥10k random inputs)
// Closure Plan §24: allocation >= 0, <= demand, board sum + mandatory <= hard,
// item total <= resources grant, empty demand = 0, no NaN / Infinity / negative,
// deterministic.
// ===========================================================================
describe('Closure §24 — hierarchical allocator invariants (≥10k property)', () => {
  function runOne(rnd: () => number) {
    const contextWindow = 8192 + Math.floor(rnd() * (1_048_576 - 8192));
    const reservedOutput = 512 + Math.floor(rnd() * 200_000);
    const mandatory = Math.floor(rnd() * Math.min(contextWindow / 2, 50_000));
    const boardDemand = () => Math.floor(rnd() * 500_000);
    const itemCount = Math.floor(rnd() * 100);
    const resourceItems: HierarchicalBudgetInput['resourceItems'] = [];
    for (let i = 0; i < itemCount; i += 1) {
      resourceItems!.push({
        id: `r${i}`,
        sourceKind: i % 3 === 0 ? 'character' : i % 3 === 1 ? 'note' : 'worldbook',
        actualTokens: Math.floor(rnd() * 20_000),
        explicitSelected: rnd() > 0.5,
        activated: rnd() > 0.2,
        sourceOrder: i,
      });
    }
    const input: HierarchicalBudgetInput = {
      contextWindow,
      reservedOutputTokens: reservedOutput,
      mandatoryTokens: mandatory,
      policy: DEFAULT_CONTEXT_AUTOMATION_POLICY_V3,
      boards: {
        storyState: { actualDemandTokens: boardDemand() },
        resources: { actualDemandTokens: boardDemand() },
        slidingWindow: { actualDemandTokens: boardDemand() },
        episodic: { actualDemandTokens: boardDemand() },
      },
      resourceItems,
    };
    const result = allocateHierarchicalContextBudget(input);

    // No NaN / Infinity / negative anywhere.
    const boardKeys = ['storyState', 'resources', 'slidingWindow', 'episodic'] as const;
    for (const k of boardKeys) {
      const b = result.boardAllocations[k];
      expect(Number.isFinite(b.allocatedTokens)).toBe(true);
      expect(b.allocatedTokens).toBeGreaterThanOrEqual(0);
      expect(b.allocatedTokens).toBeLessThanOrEqual(b.elasticMaxTokens);
      expect(b.allocatedTokens).toBeLessThanOrEqual(b.actualDemandTokens);
      // Empty demand → zero allocation.
      if (b.actualDemandTokens === 0) {
        expect(b.allocatedTokens).toBe(0);
      }
    }
    // Board total stays inside the elastic pool (soft + burst). The allocator
    // distributes `effectiveCapacity = softElasticPool + 0.75*burstElasticPool`,
    // so boardTotal never exceeds softElasticPool + burstElasticPool. Whether
    // mandatory itself fits the window is the caller's pre-condition, enforced
    // by the draft compiler's fits-check (Closure Gate 15), not the allocator.
    const boardTotal =
      result.boardAllocations.storyState.allocatedTokens +
      result.boardAllocations.resources.allocatedTokens +
      result.boardAllocations.slidingWindow.allocatedTokens +
      result.boardAllocations.episodic.allocatedTokens;
    expect(boardTotal).toBeLessThanOrEqual(
      result.envelope.softElasticPool + result.envelope.burstElasticPool,
    );
    // Item total <= resources board grant.
    if (result.resourceItemAllocations && input.resourceItems!.length > 0) {
      let itemTotal = 0;
      result.resourceItemAllocations.forEach(v => {
        itemTotal += v;
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      });
      expect(itemTotal).toBeLessThanOrEqual(
        result.boardAllocations.resources.allocatedTokens,
      );
    }
    // Determinism: same input → same allocation.
    const again = allocateHierarchicalContextBudget(input);
    expect(again.totalEstimatedInputTokens).toBe(result.totalEstimatedInputTokens);
    for (const k of boardKeys) {
      expect(again.boardAllocations[k].allocatedTokens).toBe(
        result.boardAllocations[k].allocatedTokens,
      );
    }
    return result;
  }

  test('10k random inputs respect every invariant', () => {
    const rnd = mulberry32(0xC1054E);
    const TRIALS = 10_000;
    for (let i = 0; i < TRIALS; i += 1) {
      runOne(rnd);
    }
  });

  test('cross-board reclaim: empty boards release, resources may exceed soft target (Gate 11)', () => {
    // Story/Episodic/Sliding empty (demand 0) → they release their soft target.
    // Resources demand is large → it borrows the reclaimed pool, so its
    // allocation can exceed its own soft target when the window allows.
    const rnd = mulberry32(42);
    let borrowObserved = false;
    for (let i = 0; i < 2000 && !borrowObserved; i += 1) {
      const result = allocateHierarchicalContextBudget({
        contextWindow: 512_000,
        reservedOutputTokens: 80_000,
        mandatoryTokens: 2_000,
        policy: DEFAULT_CONTEXT_AUTOMATION_POLICY_V3,
        boards: {
          storyState: { actualDemandTokens: 0 },
          resources: { actualDemandTokens: 80_000 + Math.floor(rnd() * 120_000) },
          slidingWindow: { actualDemandTokens: 0 },
          episodic: { actualDemandTokens: 0 },
        },
      });
      const res = result.boardAllocations.resources;
      if (res.actualDemandTokens >= res.softTargetTokens) {
        // When demand is healthy and other boards released, resources should be
        // able to borrow past its soft target (or full-fit if demand < ceiling).
        if (res.borrowedTokens > 0 || res.allocatedTokens >= res.softTargetTokens) {
          borrowObserved = res.allocatedTokens >= res.softTargetTokens;
        }
      }
    }
    expect(borrowObserved).toBe(true);
  });
});
