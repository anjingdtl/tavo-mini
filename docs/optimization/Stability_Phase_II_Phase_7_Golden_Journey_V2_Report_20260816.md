# Stability Phase II / Phase 7 Report

## Baseline

- Phase 7 start Local HEAD: `66393b7822d71b777306d4d605e1dccc91506a66`
- Phase 7 start `origin/main`: `66393b7822d71b777306d4d605e1dccc91506a66`
- Protected governance plan: `docs/optimization/ShineWriter_tavo-mini_稳定性治理第二期方案_20260815.md` remained untracked and was not staged.
- Worktree contained no other user modification at Phase 7 entry.

## Scope

Allowed:

1. Preserve the existing 20 Golden Journeys.
2. Upgrade their assertions to the frozen decision contract.
3. Add GJ-21 through GJ-28 from the Phase II plan.
4. Add machine-checkable Golden Journey V2 evidence through the persisted envelope and Generation Trace V2 summary.

Forbidden and unchanged:

- Budget mathematics;
- Story Memory core algorithm;
- Continuation V5 generation core;
- unrelated warning cleanup or refactoring;
- Phase 8 real-device matrix, Phase 9 Generation Stability CI, and Phase 10 Seal.

## Changes

1. Added `__tests__/goldenJourneysV2.test.ts` with GJ-21..GJ-28.
2. Upgraded retained GJ-01..GJ-20 paths in `goldenJourneys.test.ts` and `goldenJourneysMultiChapter.test.ts` to validate Candidate, Selection, Reason, Allocation, Rendered, Fingerprint, and Diagnostic evidence.
3. Every V2 assertion round-trips the real `serializePipelineTaskContext` / `parsePersistedPipelineTaskContext` path and validates a V2 `buildGenerationTraceSummary`.

## Golden Diff

- Candidate: unique ids, source content hash, selected/rejected state, and a non-empty decision reason.
- Selection: mandatory selected-set stability across context-window changes and optional-resource changes.
- Budget: demand/allocation evidence, non-empty allocation reason, and synchronized clipping aliases.
- Render: rendered item identity, token counts, inclusion/clipping flags, message presence, and rendered hash.
- Fingerprint: contract fingerprint recomputed from the persisted semantic contract.
- Diagnostic: diagnostic array and required code/severity/message fields are asserted and frozen.

## Golden Journey V2 Coverage

- GJ-21: same source/settings/input frozen twice → semantic contract identical.
- GJ-22: inactive low-relevance worldbook added → mandatory allocation unchanged.
- GJ-23: 64K → 128K → mandatory selected set unchanged.
- GJ-24: 128K → 1M → sliding window remains bounded by its token budget.
- GJ-25: optional resource doubled → mandatory material is not displaced.
- GJ-26: frozen Writer Style remains on resume; new style affects only new generation.
- GJ-27: frozen worldbook survives resume; a new generation reflects deletion.
- GJ-28: Continuation N=3 → one batch lineage, independent chapter fingerprints, zero future leakage.

The first 20 journeys remain green: GJ-01..GJ-16, GJ-17..GJ-18, and GJ-19..GJ-20.

## Tests

- Golden V2 targeted: 8 tests passed.
- Retained Golden Journeys: 20 tests passed.
- Combined Golden / Replay / Trace / Continuation targeted set: 6 suites, 57 tests passed.
- `npm run lint`: PASS — 0 errors, 202 existing warnings.
- `npm run typecheck`: PASS.
- `npm run test:ci`: PASS — 437 suites passed, 3 skipped; 3441 tests passed, 8 skipped.
- `git diff --check`: PASS.
- Android / Migration: not a Phase 7 local gate; remote Verify is required after the Phase 7 commit. The complete real-device matrix remains Phase 8.

## Trace Evidence

- The V2 tests validate a persisted `generationTraceId` through serialize → parse.
- The derived trace is required to be version 2, with candidate count, selected count, decision reasons, and diagnostics matching the frozen contract.
- GJ-28 validates batch trace lineage and independent chapter fingerprints without serializing a future sibling plan.

## New Defects

```text
New P0 = 0
New P1 = 0
New P2 = 0
```

## Remaining NO-GO

1. Phase 8 complete 20/20 real-device stability matrix is pending.
2. Phase 9 independent Generation Stability CI is pending.
3. Phase 10 independent audit and Final Seal are pending.

## GitHub Actions

- Phase 7 commit Verify Run ID: pending push.
- Required remote JavaScript / Android / Migration results: pending push.
- Generation Stability: intentionally not present until Phase 9.

## Decision

```text
Golden Journey V2 Gate = GO
Overall stability governance = NO-GO
STABILITY ARCHITECTURE — GO / SEALED = NOT AUTHORIZED
```
