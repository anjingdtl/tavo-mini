# ShineWriter Stability Governance Phase II — Phase 1 Evidence

Date: 2026-08-15  
Repository authority: `F:\ClaudeWorkSpace\projects\TAVO-MINI`  
Governance source: `docs/optimization/ShineWriter_tavo-mini_稳定性治理第二期方案_20260815.md`

## Scope

Phase 1 only: complete the real generation-stage boundary
`Collect → Normalize → Plan → Allocate → Render → Freeze`.

The existing fixed/elastic/hierarchical budget implementations were retained.
No Story Memory algorithm, Continuation V5 generation algorithm, schema, or
provider behavior was rewritten.

## Evidence

- `collectGenerationMaterials` now owns chapter/checkpoint/outline/query capture,
  raw resource capture, note-mode source capture, and V3/V7 resource candidate
  capture. The collector no longer imports `contextBuilder`, avoiding a runtime
  stage cycle.
- `normalizeGenerationMaterials` is pure and applies stable ordering, source
  identity/hash defaults, empty semantics, and future-source rejection.
- `buildGenerationContextPlan` exposes candidate identity, activation,
  selection/rejection reason, requirement, relevance, priority, boost, and
  demand. Raw legacy resources and V3/V7 resource facts are represented in the
  same candidate set.
- `allocateGenerationContextBudget` is the only generation-facing allocation
  entrypoint. It adapts legacy fixed grants, elastic allocation, and hierarchical
  allocation without changing their underlying mathematics.
- `renderGenerationContext` owns final message ordering and emits per-candidate
  actual-token/clipping/hash evidence. The build path requires captured resource
  sources, so resource rendering cannot silently reopen the repository.
- `freezeGenerationContext` is the sole V2 contract assembler and now checks
  future leakage, hard-limit overflow when a finite limit exists, mandatory
  contract presence, and message payload integrity before calculating the
  fingerprint.

## Verification

Targeted Phase 1 suites:

```text
contextBuilderV3.integration.test.ts
contextBuilderV7.integration.test.ts
contextBuilderElasticBudget.test.ts
contextBuilderNoteMode.test.ts
contextBuilderStoryMemory.test.ts
generationPhase2StageContracts.test.ts
frozenGenerationContext.test.ts
goldenJourneys.test.ts
```

Result: PASS (60 tests). Additional context, replay, trace, and snapshot
regressions were also run and passed before the Phase 1 full gate.

The Phase 1 gate is permitted to close only after the final post-change run of
`npm run lint`, `npm run typecheck`, and `npm run test:ci` is recorded in the
commit handoff.

## Findings

New P0: 0  
New P1: 0  
Current Phase 1 blocking NO-GO: 0

