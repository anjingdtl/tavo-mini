# ShineWriter Stability Governance Phase II — Phase 4 Evidence

Date: 2026-08-15
Repository authority: `F:\ClaudeWorkSpace\projects\TAVO-MINI`
Governance source: `docs/optimization/ShineWriter_tavo-mini_稳定性治理第二期方案_20260815.md`

## Scope

Phase 4 only: Decision Replay V2. Continuation and Golden Journey V2 changes
remain outside this phase.

## Evidence

- Added `GenerationReplayFixtureV2` with project/chapter/outline/resource/
  story-memory/context/preset/writer-style/model/policy/expected-snapshot
  inputs.
- Replay executes the explicit sequence:
  `Collect → Normalize → Plan → Allocate → Render → Freeze → Compare`.
  Fixture collection is an isolated replay adapter; later stages do not reopen
  repository state or call an LLM.
- Expected snapshots are compared at decision level, with structured diff kinds:
  `candidate_mismatch`, `selection_mismatch`, `allocation_mismatch`,
  `render_mismatch`, `fingerprint_mismatch`, and `diagnostics_mismatch`.
- Determinism records independent signatures for candidate set, selected set,
  allocation, render, and final fingerprint; the REG-001 fixture was replayed
  10 times with all five signatures identical.
- Required fixture variants are covered: `REG-001`, `GJ-07 Writer Style`,
  `Note None`, `Story Memory Dirty`, and `1M Context`.
- Existing persisted-envelope Replay V1 and fingerprint fail-closed behavior
  remain unchanged.

## Verification

Targeted Phase 4 suites: 12 suites, 98 tests — PASS.

Global gate:

- `npm run lint` — PASS, 0 errors / 202 existing warnings
- `npm run typecheck` — PASS
- `npm run test:ci` — PASS, 433 suites passed / 3 skipped; 3,421 tests passed / 8 skipped

## Findings

New P0: 0
New P1: 0
New P2: 0
Current Phase 4 blocking NO-GO: 0
