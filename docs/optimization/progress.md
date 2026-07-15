# Optimization Construction Progress

## Execution scope

- Plan source: `docs/superpowers/specs/Tavo-Mini-Agent-Optimization-Plan.md` (user-provided; tracked in baseline commit `67063bdb8bc493608fec4c6ae51b6555e78c1d71`)
- Approved scope: Phase 0 through Phase 3
- Branch: `main`
- Started: 2026-07-15
- Design commit: `bf4bee1 docs: add data reliability phase design`
- Implementation plan: `docs/superpowers/plans/2026-07-15-data-reliability-phase-0-1.md`

## Status legend

- `planned`: agreed but not started
- `in progress`: actively being implemented
- `blocked`: requires a decision or external input
- `verified`: implementation and required checks completed

## Phase 0 — Baseline and quality gates

### 0.1 Optimization branch — verified

- Outcome: Created `codex/data-reliability-optimization` from `main`.
- Evidence: branch switch completed on 2026-07-15.
- Risk: The source optimization plan is a user-provided tracked input; its scope remains outside this baseline documentation commit.
- Commit: none required.

### 0.2 Baseline capture — blocked

- Evidence captured: `2026-07-15T17:09:18+08:00` in `docs/optimization/baseline.md`.
- Start state: commit `67063bdb8bc493608fec4c6ae51b6555e78c1d71`; branch `codex/data-reliability-optimization`; initial worktree clean.
- Outcomes: `npm install` and Jest passed (64 suites / 293 tests); `npm run lint`, `npx tsc --noEmit`, and `npm run apk:debug` failed. TypeScript was deterministically re-verified at `2026-07-15T17:22:43+08:00`: exit `2`, 1,588 diagnostics across 1,641 output lines.
- Blocking commands: `npm run lint`; `npx tsc --noEmit`; `npm run apk:debug`.
- APK evidence: V2.4.3 debug delivery APK was not produced because Ninja hit the Windows 260-character filename limit.

### 0.3 Unified verification commands — verified with recorded baseline exception

- Implemented `typecheck`, `test:ci`, and `verify` in `package.json` without changing the existing `test`, `lint`, or Android scripts.
- `npm run typecheck`: exit `2`; the pre-existing project-wide TypeScript boundary and application/test diagnostics remain.
- `npm run lint`: exit `0`; five pre-existing warnings remain and no errors.
- `npm run test:ci`: exit `0`; 68 suites / 324 tests passed after the Phase 1 regression additions.
- `npm run typecheck`: exit `2`; the pre-existing project-wide TypeScript boundary and application/test diagnostics remain.
- `npm run verify`: exit `2` at the known typecheck baseline after lint and test stages pass.
- Gate decision: continue with the explicitly authorized Phase 0–1 work while preserving these failures as a tracked quality-gate item; the final phase gate must re-run the commands after the relevant repairs.
- Commit: `ed3466e` (`chore: add unified verification commands`).

## Phase 1 — Database transaction and migration safety

### 1.1 Safe transaction executor — verified

- Root cause: business code had a local transaction helper while migration and one LLM-config deletion path still bypassed the synchronous callback contract.
- Changed files: `src/services/database/transaction.ts`, `src/services/database.ts`.
- Added regression coverage: `__tests__/databaseTransaction.test.ts` (empty batch, ordering/parameters, statement and transaction errors, synchronous callback, default parameters, single completion).
- Focused verification: `npx jest __tests__/databaseTransaction.test.ts __tests__/databaseMigration.test.ts __tests__/createProjectNoAsyncTransaction.test.ts --runInBand` — passed, 3 suites / 13 tests.
- Remaining risk: initialization order and runtime schema validation are handled by Tasks 1.3 and 1.4.
- Commit: `f5c354b` (`refactor(database): add safe transaction executor`).

### 1.2 Transaction-safe migration runner and migration matrix — verified

- Root cause: every migration mutated the database through an async transaction callback; several historical migrations also used pre-migration compatibility repairs instead of atomic version steps.
- Changed files: `src/services/migrations/types.ts`, `src/services/migrations/index.ts`, `src/services/migrations/helpers.ts`, and `v3-to-v4.ts` through `v13-to-v14.ts`.
- Migration builders now perform required PRAGMA reads before the transaction, return ordered SQL batches, and append the `schema_version` write as the final statement in the same transaction.
- v7→v8, v9→v10, v10→v11, v11→v12, v12→v13, and v13→v14 conditionally build historical column repairs from preflight metadata; data conversions are idempotent SQL.
- Added `__tests__/migrationMatrix.test.ts`, `__tests__/migrationAtomicity.test.ts`, and the transactional migration test double `__tests__/migrationTestUtils.ts`.
- Focused verification: migration matrix, atomicity, engine, v11→v12, v12→v13, v8→v9, and backup regression tests passed; the matrix covers schema 3–13 to 14, rollback, and rerun behavior.
- Repository invariant: `rg "transaction\\(async" src android __tests__` returns no matches after the restore path was converted to the shared executor.
- Commit: `35e0815` (`refactor(database): make migrations transaction-safe`).
- Supplemental restore transaction containment: `src/services/backupService.ts` now prepares one statement batch and uses the shared executor; focused backup tests pass. Commit: `558608b` (`refactor(backup): use safe transaction executor`).

### 1.3 Initialization order and known-defect repair — verified

- `openDatabase` now follows metadata bootstrap → install/schema detection → fresh-schema creation or strict migrations → validation → known-defect diagnostic hook → defaults → indexes → derived-note repair → final validation → metadata finalization.
- Fresh installs create Schema 14 directly; existing installs below Schema 3 or above the supported version fail visibly instead of receiving broad compatibility `ALTER TABLE` repairs.
- `detectInstallType` is now read-only; app version, install metadata, and the successful source-schema state are finalized only after initialization succeeds. The original source schema is retained for upgrade/backup callers.
- Focused verification: `npx jest __tests__/databaseMigration.test.ts __tests__/installTypeDetection.test.ts __tests__/createProjectNoAsyncTransaction.test.ts --runInBand` — passed, 3 suites / 13 tests before validator integration.
- Commit: `b757082` (`refactor(database): reorder initialization and schema repair`).

### 1.4 Runtime schema manifest and validator — verified

- Added the current table/column/index/backup/restore-order manifest and a side-effect-free validator covering required schema objects, schema version, foreign keys, active local-model references, and orphan project references.
- Initialization validates once before defaults and again after defaults/index/derived repair; failures throw a structured Chinese error and never delete or reset the database.
- Added validator coverage for valid state, missing table/column/index, schema/FK mismatch, invalid local model reference, and orphan references.
- Focused verification: `npx jest __tests__/databaseMigration.test.ts __tests__/schemaValidator.test.ts __tests__/createProjectNoAsyncTransaction.test.ts __tests__/installTypeDetection.test.ts --runInBand` — passed, 4 suites / 18 tests.
- Commit: `0dd6d51` (`feat(database): add runtime schema validation`).

## Phase 2 — Backup and recovery safety

### 2.1 Manifest-driven v3 backups — verified

- Backup and restore table selection now comes directly from `SCHEMA_MANIFEST`, covering the current 22 persisted tables including `character_collections` and `local_llm_models`.
- Local GGUF files are never embedded in JSON. Each model is represented in `external_assets[].local_model_reference` with filename, SHA-256, size, and `included: false`.
- v1 and v2 files remain read-compatible; new files are generated only as format v3 with SHA-256 over format, metadata, table data, and external asset references.

### 2.2 Credential isolation and privacy notice — verified

- Credentials are removed before backup JSON is assembled, including LLM API keys, setting rows containing passwords/tokens, authorization headers, WebDAV credentials, sync credentials, and nested credential-shaped fields.
- The Backup Center explicitly warns that novel content, characters, world-building, and notes are included and that unencrypted files must not be uploaded to untrusted locations.

### 2.3 Atomic and verifiable restore — verified

- Restore validates structure/checksum before mutation, creates a pre-restore v3 backup, builds all reads and SQL outside the SQLite transaction callback, and submits one batch through the shared executor.
- Insert failures roll back the transaction. Post-commit foreign-key/Schema verification failures trigger a rollback batch from the captured pre-restore state.
- Old backups may omit optional tables without deleting current data; missing core tables or unsupported row types reject before the transaction.
- Restored local model records are marked `missing`, local configs referencing them are deactivated, secure LLM credentials are not restored, and settings keep the current schema version. Store reload and a re-import prompt are wired into the Backup Center.

### 2.4 Phase 2 focused verification — verified

- `npx jest __tests__/backupService.test.ts __tests__/backupCenterLayout.test.tsx __tests__/settingsStoreBackgroundPipeline.test.ts __tests__/llmConfigResolution.test.ts --runInBand --no-cache` — passed, 4 suites / 18 tests.
- `npx eslint src/services/backupService.ts src/services/database.ts src/store/settingsStore.ts src/screens/BackupCenterScreen.tsx __tests__/backupService.test.ts` — passed with the two pre-existing bitwise warnings in `database.ts`.
- The full repository test suite and Android Debug build are recorded under the Phase 3 final gates below.

## Phase 3 — Release delivery and build safety

### 3.1 Release signing boundary — verified

- `android/app/build.gradle` no longer contains a keystore path, signing password, alias, or key-password default.
- Release tasks require `SHINE_WRITER_RELEASE_STORE_FILE`, `SHINE_WRITER_RELEASE_STORE_PASSWORD`, `SHINE_WRITER_RELEASE_KEY_ALIAS`, and `SHINE_WRITER_RELEASE_KEY_PASSWORD`; the error lists missing variable names without printing secret values.
- `npm run apk:debug` passed without release signing variables.
- `npm run apk:release` without signing variables failed during Gradle configuration with the intended explicit guard.
- With the existing keystore supplied only through the process environment, `npm run apk:release` passed; `apksigner verify --verbose` confirmed one signer and APK Signature Scheme v2. Delivery artifact: `dist/apk/release/ShineWriter-V2.4.3-release.apk` (31,650,475 bytes; SHA-256 `C4F44A8633CB93FD80B1F902566BF667AC983C41E5737D680198734184E69EFC`). No signing secret is stored in the working tree.

### 3.2 Release minification preparation — verified with device-matrix hold

- Added keep rules for the app's React Native bridge modules, SQLite, Keychain, RNFS, annotations, and existing local-model/JNI paths in `android/app/proguard-rules.pro`.
- `minifyEnabled` and `shrinkResources` are controlled together by `-PenableReleaseMinification=true`; `npm run apk:release:minified` now exposes the same evaluation path and minification remains disabled by default.
- `npm run apk:release:minified` passed through R8 and resource shrinking, producing a 27,138,356-byte evaluation APK (25.88 MB). The ADB daemon reports no attached devices, so the required startup, new-project, chapter-edit, online LLM, local-model, TTS, backup, and restore matrix is still a recorded external validation hold; the optimized package is not marked as the shipping artifact.

### 3.3 Unified version generation — verified

- `package.json.version` is the source of truth. `prebuild` generates `src/constants/version.json`; Gradle and `build-apk.js` consume that same file.
- Git commit count is no longer used. The current `V2.4.3` metadata is `versionCode=2040300` (`build=0`) and `releaseTitle=ShineWriter V2.4.3`, using `major * 1,000,000 + minor * 10,000 + patch * 100 + build`.
- The generator enforces a 0–99 build component, prevents version-code regression, supports `SHINE_WRITER_BUILD_NUMBER` / `GITHUB_RUN_NUMBER`, and preserves metadata when the inputs are unchanged.
- The generator also updates the README Version badge; README and CHANGELOG now describe V2.4.3, the current 319-test suite, and GGUF + llama.cpp rather than the removed LiteRT-LM path.

### 3.4 Phase 3 verification — verified with external-input exceptions recorded

- `npm run lint` — passed with 0 errors and 5 pre-existing warnings.
- `npm run test:ci` — passed, 68 suites / 319 tests.
- Focused backup regression suite — passed, 4 suites / 18 tests.
- `npm run apk:debug` — passed; delivery artifact: `dist/apk/debug/ShineWriter-V2.4.3-debug.apk`, 53,779,999 bytes; SHA-256 `B93F007AE6D2C12D2F69A9B90E281A5C97413D8528555B338B98B72DD7B93E91`.
- `npm run apk:release` without signing variables — failed as required by the new security guard.
- `npm run apk:release` with process-only signing variables — passed and produced a signature-verified Release artifact.
- `npm run apk:release:minified` with process-only signing variables — passed through `minifyReleaseWithR8` and resource shrinking.
- `npm run verify` — stops at the known project-wide TypeScript baseline (`exit 2`); changed-surface filtering shows no diagnostics in the Phase 2 database/backup/store files. The baseline remains explicitly recorded rather than hidden.

## Phase exit criteria

- `npm run verify` passes for every committed task, or the pre-existing typecheck failure is explicitly recorded and approved before proceeding.
- `transaction(async` has no matches in `src`, `android`, or `__tests__`.
- `npm run apk:debug` completes after Phase 1 or reproduces the documented Windows Ninja path-length blocker.
- Each independent task has a focused conventional commit and a corresponding progress entry.

## Handoff boundary — 2026-07-15

### Delivered on main

- Design scope and decisions: `bf4bee1 docs: add data reliability phase design`.
- User-provided optimization execution plan: `67063bd docs: add data reliability implementation plan`.
- Baseline evidence: `441ac4c docs: add optimization baseline`.
- Transaction executor and migration safety: `f5c354b`, `35e0815`, and `558608b`.
- Initialization lifecycle and known-defect repair: `b757082`.
- Runtime schema validation: `0dd6d51`.
- Phase 2 implementation: `008c481` (`refactor(backup): complete phase 2 recovery flow`).
- Phase 3 implementation: `fef5196` (`build(android): complete phase 3 release pipeline`); follow-up release-evidence and documentation hardening is pending the next mainline commit. `.zcode/` is untracked user state and is intentionally preserved.

### Current quality-gate evidence

- `npm run lint`: exit `0`, five pre-existing warnings only.
- `npm run test:ci`: exit `0`, 68 suites / 319 tests.
- `npx tsc --noEmit`: exit `2`, 1,588 baseline diagnostics were recorded before this phase and changed-surface filtering found no new database/migration diagnostics.
- `npm run apk:debug`: exit `0`; Gradle/CMake succeeded and produced `dist/apk/debug/ShineWriter-V2.4.3-debug.apk` (53,779,999 bytes / 51.29 MB).
- `npm run apk:release`: exit `0` with process-only signing variables; APK Signature Scheme v2 verification passed for one signer.
- `npm run apk:release:minified`: exit `0`; R8 and resource shrinking completed, but the optimized artifact remains evaluation-only until the real-device matrix is run.
- `rg "transaction\\(async" src android __tests__`: no matches.

### Final gate follow-up

- `npm run verify` was re-run: lint passed, then the known project-wide typecheck baseline failed, so the command exited `2` before the test stage.
- The final Debug and signed Release builds passed; their prebuild generated the intentionally tracked `V2.4.3` metadata and `ShineWriter V2.4.3` release title.
- Do not reset `shine_writer.db`, restore the deleted broad compatibility migration, or add `async`/`await` inside a SQLite transaction callback.

### Generated metadata during final build

- The final debug build used the normal `prebuild` generator and produced the ignored delivery artifact at `dist/apk/debug/ShineWriter-V2.4.3-debug.apk`.
- The final signed Release build produced `dist/apk/release/ShineWriter-V2.4.3-release.apk`; the optimized build remains a separate evaluation result.
- `src/constants/version.json` is the committed generated metadata for the current package version; rerunning the generator is idempotent and keeps the README Version badge aligned.
