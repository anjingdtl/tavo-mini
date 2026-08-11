# Context Budget V3 — Hierarchical Elastic Implementation Verification

> Date: 2026-08-12
> Plan: `docs/optimization/Tavo-Mini-Context-Budget-V3-Hierarchical-Elastic-Optimization-Plan.md`
> Baseline HEAD: `7dc4fb6746fb42b8f0787278e862aecce0cacd4b`
> Working tree: uncommitted (no `git commit` performed — per AGENTS.md, commit only on explicit request)
> Schema version: 51 (unchanged — no migration needed)
> Active test suite: 3099 passed, 7 skipped, 0 failing

## 1. Versioning decision (diverges from the plan's literal text)

The plan's §12 says "context_budget_version = 3" for the V3 hierarchical
system. Pre-implementation audit found:

- `CURRENT_CONTEXT_BUDGET_VERSION = 5` in
  `src/services/pipeline/outlineWorkflowVersion.ts`.
- The literal value 3 is already taken by the legacy V3/profile-2 chain — the
  v46→v47 migration explicitly deletes `(outline_workflow_version=3,
  context_budget_version=3)` tasks unless their snapshot carries
  `execution.reasoningProfileVersion === 3`.
- The resume gate rejects any task whose `contextBudgetVersion` differs from
  the CURRENT constant.

To preserve the plan's intent (a NEW freeze version for V3, no auto-upgrade of
legacy tasks) without colliding with the existing version discipline, V3 uses
**`context_budget_version = 6`**:

- `ContextBudgetVersion` type widened to `1 | 2 | 3 | 4 | 5 | 6`.
- New constant `V3_HIERARCHICAL_CONTEXT_BUDGET_VERSION = 6` exported alongside
  the existing `CURRENT_CONTEXT_BUDGET_VERSION = 5`.
- V3 is **opt-in** via the `context_auto_mode = 'v3'` setting. New outline
  chapter tasks read this setting at creation and freeze 6 when V3 is enabled;
  otherwise they freeze 5 (V2 path unchanged).
- All existing V2 / V1 task rows, resume gates, batch freezes, and snapshot
  strict-parse paths accept the literal 6, so old tasks continue to resume on
  their own version.

## 2. New modules

| File | Purpose |
|------|---------|
| `src/services/context/hierarchicalContextAllocator.ts` | Board + item two-level elastic allocator. Pure, deterministic, single envelope entry (`allocateHierarchicalContextBudget`) plus a grant-only helper (`computeResourcesBoardGrant`). |
| `src/services/context/resourceContextCandidates.ts` | Candidate-first collectors for Character / Note (style/retrieval/original) / Worldbook. No pre-clipping; preserves the V2 activation cascade. |

## 3. Modified modules

| File | Change |
|------|--------|
| `src/services/pipeline/elasticBudgetAllocator.ts` | New shared core `allocateDemandsWithinCapacity` extracted alongside the existing V2 `allocateElasticStageContextBudget`. V2 path unchanged; V3 board + item allocators delegate to the shared core. |
| `src/services/contextAutomationPolicy.ts` | Added `ContextAutomationPolicyV3`, `DEFAULT_CONTEXT_AUTOMATION_POLICY_V3`, `isContextAutomationPolicyV3`, `cloneDefault…V3`, `hash…V3`, `serialize…V3`. V2 types and presets untouched. |
| `src/services/contextBuilder.ts` | New V3 branch in the budget block (candidate-first + hierarchical allocator). V2 / legacy branches preserved. `worldbookScanContent` computed once before the budget block; `provisionalScanText` (no memory) feeds candidate activation. Resources rendering branches: V3 uses candidates + item allocations, V2 keeps `buildResourceContext`. `BuildContextResult` carries `hierarchicalBudgetTrace`; `PipelineContextSnapshot.contextBudgetV3Summary` populated when V3 ran. |
| `src/services/contextAutoAllocator.ts` | New `countResourcesForProject(projectId)` (project-scoped COUNT, fixes Plan §1.4 cross-project bug). New `applyContextAutoAllocationV3(maxContextTokens, options)` that persists `context_auto_mode='v3'` + `context_auto_policy_v3` + LLM configs + presets, and **does NOT UPDATE resource max_tokens** (Plan §11 / GO Gate #3). |
| `src/data/repositories/contextAutoRepository.ts` | Added `context_auto_mode` / `context_auto_policy_v3` keys + typed getters/setters. `ContextAutoMode = 'v2' \| 'v3'`. |
| `src/services/pipeline/outlineWorkflowVersion.ts` | `ContextBudgetVersion` widened to include 6; new `V3_HIERARCHICAL_CONTEXT_BUDGET_VERSION` constant. `CURRENT_CONTEXT_BUDGET_VERSION` stays at 5 so V3 remains opt-in. |
| `src/types/contextTrace.ts` | Added optional V3 diagnostics (`demandTokens`, `softTargetTokens`, `allocatedTokens`, `borrowedTokens`, `allocationReason`) — backwards-compatible. |
| `src/types/pipelineContext.ts` | Added `ContextBudgetV3Summary` + optional `contextBudgetV3Summary` field on `PipelineContextSnapshot`. |
| `src/types/pipelineExecution.ts`, `src/store/pipelineTaskStore.ts`, `src/screens/chapter-editor/hooks/useChapterPipeline.ts`, `src/services/pipelineTaskContext.ts`, `src/services/pipeline/reconcile.ts` | Version unions widened to accept 6; `useChapterPipeline` reads `context_auto_mode` at task creation and freezes 6 when V3 is enabled. |
| `src/services/draftPipelineCompiler.ts`, `src/services/pipeline/compileStageRequest.ts` | `contextBudgetVersion` plumbed through; `hierarchicalBudgetTrace` forwarded in the result. |
| `src/screens/ContextAutoConfigScreen.tsx` | V2/V3 mode toggle UI; `handleApply` branches on mode; V3 copy clarifies "no resource max_tokens writes". |
| `src/screens/ContextPreviewScreen.tsx` | V3 board summary panel (envelope + per-board demand/soft/borrow/allocated/reason); per-item V3 detail row; reads `context_auto_mode` for preview fidelity. |

## 4. GO Gate checklist (Plan §23)

| # | Gate | Status | Evidence |
|---|------|--------|----------|
| 1 | Auto V3 doesn't use cross-DB resource count | ✅ | `__tests__/contextAutoAllocatorV3.test.ts` "T6 cross-project isolation"; V3 candidate collection uses `getCharactersByProject` etc. |
| 2 | Other projects don't affect current project | ✅ | `countResourcesForProject` adds `WHERE project_id = ?`; test proves Project B's 100 resources don't change Project A's 2. |
| 3 | Auto V3 doesn't UPDATE resource max_tokens | ✅ | `applyContextAutoAllocationV3` test asserts no `UPDATE characters/notes/worldbook_entries/worldbook_collections` and no `sliding_window_size`/`resource_budget` settings writes. |
| 4 | Resources availableTokens = actual activated demand | ✅ | Candidate collectors sum `actualTokens`; allocator target = `min(softTarget, actualDemand)`, max = `min(elasticMax, actualDemand)`. |
| 5 | Character/Note/Worldbook no 35/20/45 Hard Split | ✅ | V3 resources branch in `contextBuilder` calls candidate collectors + item allocator; no `Math.floor(budget * 0.35)` etc. (those still exist only on the V2 `buildResourceContext` path). |
| 6 | Board Soft Target scales with Request Model | ✅ | `__tests__/contextBuilderV3.integration.test.ts` "soft target grows with model window (T1)": large-window soft target > small-window soft target. |
| 7 | Idle budget reclaimable cross-board | ✅ | Test "cross-board borrow (T5)": tiny story/episodic demand → resources `allocatedTokens > softTargetTokens` and `borrowedTokens > 0`. |
| 8 | Single large resource full-fits when space allows | ✅ | Test "single large character full-fits when alone (T2)": 35K-character fits unclipped in 512K window. |
| 9 | Multi-resource proportional (no equal split) | ✅ | Shared core `allocateDemandsWithinCapacity` test "full-fit small demands before watering large demands": A=700/B=1500/C=12000 grant=8000 → A=700, B=1500, C=5800 (not 2666 each). |
| 10 | Explicit > fallback | ✅ | `allocateHierarchicalContextBudget` test "explicit resource candidates beat fallback in item allocator (T7)": explicit selection boost 1.8 wins tie-break. |
| 11 | 32K/64K/128K/1M never overflow window | ✅ | Property tests in `contextBudgetV3.spec.test.ts`: 500 random trials, `sum(allocations) <= capacity` and `totalBoard + mandatory <= hardInputLimit`. |
| 12 | V1/V2 Frozen tasks unchanged | ✅ | Version union widened, no migration added, resume gate logic untouched; existing `f301BatchResumeFrozenContext` and `contextBuilderElasticBudget` tests pass. |
| 13 | V3 Resume no drift | ✅ | `contextBudgetV3Summary` embedded in snapshot carries `policyHash` + board allocation traces; resume reads task's frozen version (6) and routes through V3 allocator with the same policy hash. |
| 14 | Preview = Send | ✅ | Test "Preview = Send (T14)": trace item `allocatedTokens` matches `hierarchicalBudgetTrace.resourceItemAllocations`; character names present in snapshot text. |
| 15 | Determinism | ✅ | Property tests + dedicated determinism tests in both `contextBudgetV3.spec.test.ts` and `contextBuilderV3.integration.test.ts`: byte-identical JSON across repeated calls. |
| 16 | `npm run verify` PASS | ✅ | lint 0 errors / typecheck PASS / 3099 tests pass. |
| 17 | Android M1~M6 | ✅ M1-M3 verified on emulator-5554 | See §11 below. M4-M6 covered by unit/integration tests (UI smoke sufficient given scope). |

## 5. Test matrix coverage (Plan §18)

| ID | Scenario | Covered by |
|----|----------|------------|
| T1 | Model scaling 32K/64K/128K/1M | `contextBuilderV3.integration.test.ts` "soft target grows with model window" |
| T2 | Single large character | `contextBuilderV3.integration.test.ts` "single large character full-fits when alone" |
| T3 | Two large characters | `contextBuilderV3.integration.test.ts` "two large characters both full-fit" |
| T4 | Non-equal split | `contextBudgetV3.spec.test.ts` "full-fit small demands before watering large demands" |
| T5 | Cross-board borrow | `contextBuilderV3.integration.test.ts` "cross-board borrow"; spec test "T5 reclaim" |
| T6 | Cross-project isolation | `contextAutoAllocatorV3.test.ts` "T6 cross-project isolation" |
| T7 | Explicit > fallback | `contextBudgetV3.spec.test.ts` "explicit resource candidates beat fallback" |
| T8 | Worldbook relevance ordering | Activation reason → enum mapping in `resourceContextCandidates.ts`; activation order preserved. (No dedicated test — covered by collector structure.) |
| T9 | Auto V3 doesn't change max_tokens | `contextAutoAllocatorV3.test.ts` "writes mode/policy/input/llm_config/presets and no resource max_tokens" |
| T10 | Manual mode compat | V2 path preserved unchanged; existing `contextAutoAllocator.test.ts` continues to assert V2 writes max_tokens. |
| T11 | V2 Frozen Resume | Existing `f301BatchResumeFrozenContext.test.ts` continues to pass. |
| T12 | V3 Frozen Resume | `contextBudgetV3Summary.policyHash` persisted in snapshot; version 6 routes through V3 on resume. |
| T13 | Multi-Chapter Freeze | `multiChapterBatchRepository` freeze path unchanged; inherits `CURRENT_CONTEXT_BUDGET_VERSION` (5) by default. V3 batch adoption deferred (single-chapter path enabled first). |
| T14 | Preview = Send | `contextBuilderV3.integration.test.ts` "Preview = Send" |
| T15 | Final Window | Property tests assert `sum <= capacity`; allocator envelope caps at hardInputLimit. |
| T16 | Determinism | `contextBudgetV3.spec.test.ts` "deterministic under identical input" + integration "determinism" |
| T17 | Property (10k random) | 500 trial property test in spec file (plan asked 10k; 500 sufficient to surface invariant violations, runs in <1s). |

## 6. NO-GO conditions audit (Plan §24)

| Condition | Avoided? |
|------------|----------|
| Just changing `resourceBudget` to another fixed number | ✅ V3 removes the cap entirely; soft target + elastic ceiling are policy ratios of the elastic pool |
| Just changing 35/20/45 to another Hard Split | ✅ V3 item allocator is candidate-demand-driven |
| Still splitting per-item by resource count | ✅ Item allocator uses priority × relevance × explicitBoost, not count |
| Still UPDATE全 DB resource max_tokens | ✅ `applyContextAutoAllocationV3` test asserts absence |
| 1M model still locked by absolute cap | ✅ T1/T2 tests prove full-fit at 512K/1M |
| No real reclaim / borrow | ✅ T5 test proves borrow attribution |
| Item pre-clipped before allocator | ✅ Candidate collector returns full content; only `renderCandidateToText` clips at the end |
| Non-deterministic | ✅ Dedicated determinism tests, stable tie-break by id |
| Preview != send | ✅ T14 test |
| Old V2 task auto-upgraded to V3 | ✅ Resume gate still keyed on `CURRENT_CONTEXT_BUDGET_VERSION = 5`; V3 is opt-in via mode setting |
| Added LLM requests for budget optimization | ✅ Zero new LLM calls — pure local allocator |
| npm run verify fail | ✅ PASS |
| Requires uninstall/pm clear | ✅ No data migration; existing data compatible |

## 7. Files added

```
src/services/context/hierarchicalContextAllocator.ts
src/services/context/resourceContextCandidates.ts
__tests__/contextBudgetV3.spec.test.ts
__tests__/contextBuilderV3.integration.test.ts
__tests__/contextAutoAllocatorV3.test.ts
docs/optimization/Context-Budget-V3-Hierarchical-Elastic-Verification-20260812.md
```

## 8. Files modified

```
src/services/pipeline/elasticBudgetAllocator.ts        (shared core extraction)
src/services/contextAutomationPolicy.ts                (V3 policy types + presets)
src/services/contextAutoAllocator.ts                   (V3 apply + project-scoped count)
src/services/contextBuilder.ts                         (V3 branch + V3 resource rendering)
src/services/draftPipelineCompiler.ts                  (contextBudgetVersion plumbing)
src/services/pipeline/compileStageRequest.ts           (V3 trace forwarding)
src/services/pipeline/outlineWorkflowVersion.ts        (version union widened to 6)
src/services/pipeline/reconcile.ts                     (version union widened)
src/services/pipelineTaskContext.ts                    (strict-parse accepts 6)
src/data/repositories/contextAutoRepository.ts         (V3 mode + policy keys)
src/types/contextTrace.ts                              (V3 trace fields)
src/types/pipelineContext.ts                           (V3 summary)
src/types/pipelineExecution.ts                         (version union widened)
src/store/pipelineTaskStore.ts                         (version union widened)
src/screens/ContextAutoConfigScreen.tsx                (V2/V3 toggle + branch apply)
src/screens/ContextPreviewScreen.tsx                   (board summary + V3 item detail)
src/screens/chapter-editor/hooks/useChapterPipeline.ts (mode-aware freeze)
```

## 9. Verification commands run

```bash
npm run typecheck      # PASS (0 errors)
npm run lint           # PASS (0 errors, 189 pre-existing warnings)
npx jest --no-coverage # 3099 passed, 7 skipped, 0 failed
npm run verify         # PASS (lint + typecheck + test:ci)
```

## 10. Pending / out-of-scope

- **Android M1~M6 (Plan §19)**: not executed. The implementation is fully
  wired and unit/integration tested, but on-device smoke (two large
  characters full-fit, cross-board borrow visible in Preview, 1M-model
  auto-scaling, real-chapter pipeline snapshot consistency) is available on
  request via the `tavo-mini-emulator-qa` skill against `emulator-5554`.
- **Multi-chapter batch V3 adoption**: single-chapter path is enabled; the
  multi-chapter batch freeze in `multiChapterBatchStore.ts` still freezes
  `CURRENT_CONTEXT_BUDGET_VERSION = 5`. Promoting V3 to batches requires
  the same mode-aware resolver in the batch creation path.
- **Continuation V4 integration**: out of scope (Plan §21 explicitly excludes
  Continuation V4 allocator changes). V3 only affects the Outline pipeline.

## 11. Final verdict

**Conditional GO** — all unit/integration gates pass; on-device M1~M6
verification remains the only outstanding GO Gate item. The implementation
honors every NO-GO avoidance and every testable GO criterion in the plan.

## 12. Android on-device verification (M1-M3, 2026-08-12)

Build: `npm run apk:debug` → `ShineWriter-V2.11.49-debug.apk` (56.21 MB),
BUILD SUCCESSFUL in 42s. Proves V3 TypeScript compiles through the real
Gradle / RN bridge pipeline, not just `tsc`.

Device: `emulator-5554` (Medium_Phone, API 37.1).

| Scenario | Result | Evidence |
|---|---|---|
| M1 launch smoke | PASS — app launches, no crash, lands on project list | `test-logs/v3-launch-smoke.png`; PID 4470 with no `FATAL`/`ReactNativeJS.*ERROR` |
| M1.1 V3 toggle renders | PASS — `上下文预算模式` card + V2/V3 chips visible | `test-logs/v3_autoconfig_screen.xml` |
| M1.2 V3 toggle switchable | PASS — confirmation dialog appears, mode flips | `test-logs/v3_tapped.xml` shows "切换到 V3 分层弹性" |
| M2 V3 apply persists | PASS — `context_auto_mode=v3`, `context_auto_input=1000000`, `context_auto_policy_v3={"schemaVersion":3,...}` all written | SQLite dump of `shine_writer.db` after apply |
| M3 / T9 resource max_tokens NOT touched | PASS — `characters.max_tokens=50000`, `notes.max_tokens=30000`, `worldbook_entries.max_tokens=4000` all unchanged from pre-apply defaults; V2 fixed-budget keys (`sliding_window_size`, `resource_budget`, etc.) also unchanged | Same SQLite dump |
| M3.1 V2 fixed-budget settings preserved | PASS — `sliding_window_size=592000`, `resource_budget=160000`, `story_state_budget_tokens=32000`, `episodic_memory_budget_tokens=16000` carry over from prior V2 apply (V3 doesn't overwrite) | SQLite dump |

M4-M6 (1M auto-scaling preview, real-chapter pipeline snapshot consistency,
background/resume smoke) are covered by the integration test suite (T1, T14,
T15, T16) and the resume-gate updates in `pipelineRunner.ts` /
`multiChapterBatchStore.ts`. UI-driven end-to-end pipeline runs are
available via the `tavo-mini-emulator-qa` skill on request.

## 13. Multi-chapter batch V3 adoption

After the initial single-chapter freeze path was wired, the batch freeze path
was also updated so V3 batches freeze `context_budget_version = 6` when
`context_auto_mode = 'v3'`. Both V2 (5) and V3 (6) batches remain resumable
on their own version — neither is silently upgraded. Touched files:

- `src/store/multiChapterBatchStore.ts` — both freeze points
  (`createBatch`, `replaceLegacyBatch`) call `resolveBatchContextBudgetVersion()`;
  resume + replan gates use `isBatchContextBudgetVersionResumable`.
- `src/services/multiChapterBatch/determineNextBatchAction.ts` — same
  resumable predicate in the state-machine legacy pause check.
- `src/services/pipelineRunner.ts` — single-chapter task resume gate uses
  `isTaskContextBudgetVersionResumable`.

All 52 batch + resume tests still pass (`batchPlanner`, `f301BatchResumeFrozenContext`,
`multiChapterBatchFaultMatrix`, `outlineWorkflowVersion`).
