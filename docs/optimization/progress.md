# Optimization Construction Progress

## Execution scope

- Plan source: `docs/superpowers/specs/Tavo-Mini-Agent-Optimization-Plan.md` (user-provided; tracked in baseline commit `67063bdb8bc493608fec4c6ae51b6555e78c1d71`)
- Approved scope: Phase 0 through Phase 8
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
- The branch work was merged into `main`; it is now retired as part of the 2026-07-16 mainline cleanup, leaving `main` as the only canonical branch.
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
- With the existing keystore supplied only through the process environment, `npm run apk:release` passed; `apksigner verify --verbose` confirmed one signer and APK Signature Scheme v2. Final delivery artifact: `dist/apk/release/ShineWriter-V2.4.3-release.apk` (31,651,955 bytes; SHA-256 `F65796AAF8281275376F084E28ED315DB4602B2A104267113929AAD8420826E7`). No signing secret is stored in the working tree.

### 3.2 Release minification preparation — verified with runtime hold recorded

- Added keep rules for the app's React Native bridge modules, SQLite, Keychain, RNFS, annotations, and existing local-model/JNI paths in `android/app/proguard-rules.pro`.
- `minifyEnabled` and `shrinkResources` are controlled together by `-PenableReleaseMinification=true`; `npm run apk:release:minified` now exposes the same evaluation path and minification remains disabled by default.
- `npm run apk:release:minified` passed through R8 and resource shrinking, producing a 25.88 MB evaluation APK. The current emulator already holds a Debug-signed install, and Android rejected the differently signed minified Release package with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`; no uninstall or database reset was performed. The optimized package remains evaluation-only until a clean device or physical-device matrix covers startup, new-project, chapter-edit, online LLM, local-model, TTS, backup, and restore.

### 3.3 Unified version generation — verified

- `package.json.version` is the source of truth. `prebuild` generates `src/constants/version.json`; Gradle and `build-apk.js` consume that same file.
- Git commit count is no longer used. The current `V2.4.3` metadata is `versionCode=2040300` (`build=0`) and `releaseTitle=ShineWriter V2.4.3`, using `major * 1,000,000 + minor * 10,000 + patch * 100 + build`.
- The generator enforces a 0–99 build component, prevents version-code regression, supports `SHINE_WRITER_BUILD_NUMBER` / `GITHUB_RUN_NUMBER`, and preserves metadata when the inputs are unchanged.
- The generator also updates the README Version badge; README and CHANGELOG now describe V2.4.3, the current 381-test suite, and GGUF + llama.cpp rather than the removed LiteRT-LM path.

### 3.4 Phase 3 verification — verified with external-input exceptions recorded

- `npm run lint` — passed with 0 errors and 5 pre-existing warnings.
- `npm run test:ci` — passed, 68 suites / 320 tests.
- Focused backup regression suite — passed, 4 suites / 18 tests.
- `npm run apk:debug` — passed after the runtime-index fix; delivery artifact: `dist/apk/debug/ShineWriter-V2.4.3-debug.apk`, 53,781,471 bytes; SHA-256 `A1C6821E0216A6429F00A314FEC73011BDB083D960AA13EC4C5CB7E59A0C8602`.
- `npm run apk:release` without signing variables — failed as required by the new security guard.
- `npm run apk:release` with process-only signing variables — passed and produced the final signature-verified Release artifact: 31,651,955 bytes; SHA-256 `F65796AAF8281275376F084E28ED315DB4602B2A104267113929AAD8420826E7`.
- `npm run apk:release:minified` with process-only signing variables — passed through `minifyReleaseWithR8` and resource shrinking; the package was not installed over the existing Debug-signed emulator app to preserve its database.
- `npm run verify` — stops at the known project-wide TypeScript baseline (`exit 2`); changed-surface filtering shows no diagnostics in the Phase 2 database/backup/store files. The baseline remains explicitly recorded rather than hidden.

### 3.5 Runtime audit correction — verified

- The first emulator launch of the Phase 3 release-evidence build exposed a real startup defect: an existing Schema 14 database could be missing `idx_llm_usage_logs_config`, while strict validation ran before the idempotent index repair and blocked initialization.
- `src/services/database.ts` now retries startup validation only when every issue is one of the two explicitly repairable deterministic `llm_usage_logs` indexes; tables, columns, foreign keys, and data-integrity issues still fail loudly. `__tests__/databaseMigration.test.ts` reproduces the missing-index database and verifies repair happens before seeding.
- On `Pixel_10_Pro_XL` (`emulator-5554`), `adb install -r` preserved the existing project database; the repaired Debug APK launched into “小说项目”, and UI-tree navigation entered the existing project’s “写作” chapter page. No database initialization error or fatal app exception was observed.

## Phase 4 — CI and quality gates

### 4.1 GitHub Actions workflow — implemented, local quality gate verified

- Added `.github/workflows/verify.yml` for `main` pushes and pull requests with three independent jobs: JavaScript validation (`lint`, `typecheck`, `test:ci`), Android Debug build (`prebuild`, `assembleDebug`), and migration matrix (`npm test -- migration --runInBand`).
- All jobs use npm caching, Node.js `22.11.0`, and JDK 17; the workflow requests read-only repository permissions and does not print or require Release secrets.
- Local workflow-format validation passed with `npx prettier --check .github/workflows/verify.yml`; the migration command passed locally. The JavaScript quality gate is now green after narrowing `tsconfig.json` to the owned app/test surface, adding the Node type declarations required by the test runtime, and repairing the real application/test type errors exposed by the gate.
- Clean-install verification passed with `npm ci`, `npm run lint` (four pre-existing warnings only), `npm run typecheck`, and `npm run test:ci`. Remote confirmation remains tracked separately because the JavaScript Jest job has repeatedly exceeded the GitHub Actions timeout after reporting passing suites.

### 4.2 覆盖率报告与阈值门禁 — 已完成

- `jest.config.js` now collects coverage from `src/services/**/*.ts`, `src/store/**/*.ts`, and `src/utils/**/*.ts` while excluding declaration files, and emits text summary, JSON summary, and LCOV reports.
- Global thresholds are branches 55%, functions 65%, lines 65%, and statements 65%. Database, database helpers, migrations, and backup service keep higher targeted gates of branches 70% and lines 80% where applicable.
- Added `npm run test:coverage` to the JavaScript GitHub Actions job. Generated `coverage/` output is ignored by ESLint and Git because it is a verification artifact rather than source.
- The local gate passed with 75 suites / 360 tests: total lines 79.91%, statements 78.42%, functions 86.30%, branches 60.82%; `database.ts` reached 89.62% lines / 70.37% branches, and all migration files passed their targeted thresholds.
- Added branch tests for backup filesystem failures, database CRUD doubles, migration paths, project/settings/pipeline/local-model stores, secure storage, local-model lifecycle, and voice playback failure/event paths. Phase 4.2 exit criteria are met locally; the remote timeout is recorded in the final gate follow-up.

### 4.3 核心用户流程 E2E — 已实现，写作主链路已实机验证

- Added six portable Maestro flows under `e2e/maestro/`, covering all 16 required checkpoints: first launch, project/chapter/content lifecycle, character collection and character, worldbook, backup/restore, online LLM connection testing, and pipeline cancellation/failure feedback.
- Added stable semantic `testID` selectors for project creation, chapter fields, resource editors, and online LLM configuration fields. The flows are ordered so the first disposable-state flow can seed the state used by the remaining flows.
- Added the Jest timer `unref()` compatibility guards in `navigationRef` and `appState`; `npx jest --runInBand --ci --detectOpenHandles --forceExit --silent` now passes all 75 suites / 360 tests without an open-handle report.
- Built and installed `dist/apk/debug/ShineWriter-V2.4.3-debug.apk` on `emulator-5554`; adb/UI-tree evidence verified launch, project creation, chapter editing, autosave, exit, re-entry, and persisted正文 (`21 字`, `已保存`). No crash-buffer or React Native fatal error was observed.
- The current Windows QA environment has adb and an emulator but no Maestro binary, so the YAML flows are committed as the portable runner and the writing lifecycle has an actual-device fallback proof. A complete execution of all six flows remains a release-environment follow-up once Maestro is available.

## Phase 5 — 核心代码架构拆分

### 5.1 database.ts → data connection/schema/repositories — 已完成

- Added `src/data/connection/` for the SQLite opener, execute/query helpers, and the transaction compatibility boundary. `openDatabase` retains the existing single-flight initialization and test injection hooks.
- Added `src/data/schema/` for fresh-schema creation and initialization/migration validation, with the existing schema manifest and validator exposed through the new data-layer path. Added `src/data/migrations/` compatibility exports so migration ownership remains versioned and unchanged.
- Extracted the database contract into domain repositories under `src/data/repositories/`: project/chapter, character, worldbook, note, preset, online LLM configuration, local model, settings, usage, content revisions/drafts, pipeline tasks, and note-mode configuration.
- Reduced `src/services/database.ts` to a 23-line compatibility export entry point, while every new repository and schema file remains below the 500-line target; the largest repository files are 349 lines.
- Extended coverage collection to `src/data/**/*.ts`. The local gate passed with 75 suites / 360 tests and total coverage 79.91% lines, 78.42% statements, 86.30% functions, and 60.82% branches; the new Schema layer reached 96.47% lines / 90% branches.
- `npm run typecheck`, `npm run lint` (0 errors, five existing warnings), `npm run test:ci`, `npm run test:coverage -- --silent`, and `git diff --check` passed after the extraction. The compatibility contract tests for migration, CRUD, and transaction safety passed separately before the full run.

### 5.2 ChapterEditor 职责拆分 — 已完成

- Added `src/screens/chapter-editor/ChapterEditorScreen.tsx` as the 264-line orchestration screen, with separate `ChapterFields`, `ChapterToolbar`, `ChapterPipelinePanel`, and `ChapterTtsControls` components.
- Added `useChapterDocument`, `useChapterAutoSave`, `useUnsavedChangesGuard`, `useChapterPipeline`, and `useChapterTts` hooks. Loading, debounced persistence, background/exit flushing, pipeline state, and TTS range playback now have explicit ownership boundaries.
- Kept `src/screens/ChapterEditor.tsx` as the one-line compatibility export used by navigation. The refactor removes the old `@ts-ignore` navigation calls and keeps page-exit persistence, pipeline continuation/cancellation, TTS completion feedback, and autosave behavior covered.
- `npx jest --runInBand --ci __tests__/chapterEditorToolbar.test.tsx` passed 9/9 tests; `npm run typecheck`, `npm run lint` (0 errors, four existing bitwise warnings), and `git diff --check` passed after the split.

## Phase 6 — AI 与后台任务可靠性

### 6.1 移动端 LLM 并发调度 — 已完成

- Added `src/services/llm/requestScheduler.ts` with mobile-safe limits: normal online requests 3, same-project pipeline requests 1, cross-project background work 2, connection tests 1, and local model generation 1.
- Queue entries carry `taskId`, support cancellation before network/native work starts, prioritize manual actions over background work, and expose `queued`/`running`/`cancelled` states to the UI.
- Android memory-pressure events pause new work; returning to the foreground resumes queued work. Pipeline and chapter screens now display the queue state instead of appearing stuck.

### 6.2 集中式超时与取消策略 — 已完成

- Added `src/services/llm/requestPolicy.ts` for the documented 20-second connection, 60-second normal, 180-second chapter/pipeline, and local no-progress timeout tiers.
- Online and local providers now share cancellation/error mapping, record request start/first-token/last-progress timestamps, and preserve user cancellation precedence over timeout errors.
- Reliability tests cover queue cancellation, same-project serialization, low-memory pause/resume, timeout tiers, timing metrics, and cancellation precedence.

### 6.3 HTTP/HTTPS 安全策略 — 已完成

- Added `src/services/llm/networkPolicy.ts`; HTTPS remains the default, while opt-in HTTP is restricted to IPv4 loopback/private-LAN ranges and never permits public HTTP endpoints.
- Added the persisted `允许不安全的局域网 HTTP 服务` switch with an explicit unencrypted-traffic warning. Online connection tests and generation use the same endpoint validator.
- Added the Android Network Security Config and aligned Debug/Release manifest placeholders so the signed build follows the same JavaScript policy.
- Focused reliability/provider tests passed; `npm run typecheck` passed; the debug APK built and was installed/launched on `emulator-5554`, with the LLM settings screen and network policy switch verified through the UI tree.

## Phase 7 — 文档与发布规范

### 7.1 README — 已完成

- Rewrote `README.md` around the current Android-only React Native 0.85.3 architecture, Schema 14 storage layer, online OpenAI-compatible APIs, GGUF/llama.cpp local models, secure API-key handling, backup/privacy boundaries, build/test commands, release download path, screenshots, and known limitations.
- Corrected the stale 68-suite/320-test claims, updated the current 78-suite/381-test baseline, and removed obsolete model/runtime wording from the product README.

### 7.2 CHANGELOG — 已完成

- Rebuilt `CHANGELOG.md` with Keep a Changelog sections for Unreleased and 2.4.0–2.4.3.
- Each release records functional changes, Schema/upgrade risk, local-model/API compatibility, fixes, and security notes.

### 7.3 发布清单 — 已完成

- Added `docs/RELEASE_CHECKLIST.md` covering version metadata, npm/Jest/coverage/migration gates, Debug/Release APKs, signing and SHA-256, clean install/upgrade, backup/restore, online/local model, TTS/background, the 12 fault-injection scenarios, GitHub Release, and `main` parity.
- The checklist is intentionally an evidence template; no GitHub Release is claimed until an actual release URL and artifact checksum are recorded.

## Phase 8 — 产品级可靠性验证

### 8.1 历史数据库升级矩阵 — 已完成

- Added `scripts/generate-migration-fixtures.py` and 11 committed SQLite fixtures for Schema 3 through Schema 13.
- Fixtures cover multi-project data, long and empty text, Chinese/English/special characters, references across content tables, local-model configuration, usage logs, revisions, drafts, note profiles, and pipeline tasks.
- The validator upgrades a copy in memory, checks Schema 14, row counts, current-project state, foreign keys, required columns, duplicate constraints, and representative edge-case content without mutating the committed source fixture.
- Fixed the Schema 10→11 fallback collection migration so an existing character collection cannot trigger a project-zero foreign-key failure; the regression is covered by `migrationCoverage.test.ts`.

### 8.2 故障注入测试 — 已完成

- Added `__tests__/faultInjectionMatrix.test.ts` and `docs/FAULT_INJECTION_MATRIX.md` for 12 release scenarios: migration/restore interruption, disk-full and backup corruption, checksum mismatch, autosave or migration kill, GGUF import kill, local OOM, offline network, and background TTS.
- Jest locks the expected recovery contract for user messaging, database state, retry behavior, backup/orphan cleanup, stuck-task prevention, and diagnostics fields. Real-device long-kill, disk, and memory runs remain release-checklist evidence items.
- Full local validation reached 78 suites / 381 tests with 78.21% statements, 60.30% branches, 85.92% functions, and 79.82% lines.

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
- Phase 3 implementation: `fef5196` (`build(android): complete phase 3 release pipeline`); follow-up release-evidence, documentation hardening, and runtime-index correction are included in the current mainline follow-up commit. `.zcode/` is untracked user state and is intentionally preserved.

### Current quality-gate evidence

- `npm run lint`: exit `0`, four pre-existing warnings only.
- `npm run test:ci`: exit `0`, 78 suites / 381 tests.
- `npx tsc --noEmit`: exit `0` after narrowing the TypeScript project boundary and fixing the exposed app/test type errors.
- `npm run apk:debug`: exit `0`; Gradle/CMake succeeded and produced `dist/apk/debug/ShineWriter-V2.4.3-debug.apk` (53,781,471 bytes / 51.29 MB); the emulator startup and writing-tab smoke path passed.
- `npm run apk:release`: exit `0` with process-only signing variables; APK Signature Scheme v2 verification passed for one signer.
- `npm run apk:release:minified`: exit `0`; R8 and resource shrinking completed, but the optimized artifact remains evaluation-only until it can be installed on a clean/physical device without discarding the current emulator database.
- `rg "transaction\\(async" src android __tests__`: no matches.

### Final gate follow-up

- `npm run verify` passes locally: lint, typecheck, and Jest all pass. GitHub Actions run `29432014007` confirms the Android Debug and migration jobs, while JavaScript validation remains stuck in Jest; earlier runs `29430303072`, `29429011388`, and `29426412122` were cancelled after the same timeout pattern. No remote green Verify result is claimed.
- The final Debug and signed Release builds passed; their prebuild generated the intentionally tracked `V2.4.3` metadata and `ShineWriter V2.4.3` release title. The Debug APK was also launched against the preserved emulator database after the runtime-index correction.
- Do not reset `shine_writer.db`, restore the deleted broad compatibility migration, or add `async`/`await` inside a SQLite transaction callback.

### Mainline cleanup and documentation sync — 2026-07-16

- `main` is the canonical branch. The merged `codex/data-reliability-optimization` branch is retired locally, and the remote branch set is kept to `main` (with `origin/HEAD -> origin/main` as the symbolic default-branch ref).
- `README.md`, `CHANGELOG.md`, `docs/RELEASE_CHECKLIST.md`, and this progress record share the 78-suite / 381-test local baseline and the current remote CI caveat.
- The final sync is verified with `git fetch origin --prune` and `git rev-list --left-right --count main...origin/main` returning `0 0` after the documentation commit is pushed.

### Generated metadata during final build

- The final debug build used the normal `prebuild` generator and produced the ignored delivery artifact at `dist/apk/debug/ShineWriter-V2.4.3-debug.apk`.
- The final signed Release build produced `dist/apk/release/ShineWriter-V2.4.3-release.apk`; the optimized build remains a separate evaluation result because the emulator's installed Debug certificate must not be replaced by uninstalling the app and resetting its test database.
- `src/constants/version.json` is the committed generated metadata for the current package version; rerunning the generator is idempotent and keeps the README Version badge aligned.

## V2.4.4 reliability tag closure — 2026-07-16

- Version metadata advanced to `V2.4.4` / `versionCode=2040400`; database Schema remains 14 and no data migration was added.
- Autosave failures now propagate to navigation guards, retryable debounce state is preserved, and chapter clearing waits for pending autosave before snapshot/write/reload.
- Jest runs naturally on Node 24.14.1 without `--forceExit`. Final local gates: lint 0 errors / 4 existing warnings, typecheck exit 0, 82 suites / 401 tests, coverage 78.33% statements / 60.37% branches / 86.05% functions / 79.95% lines, and migration 7 suites / 37 tests.
- Final branch-head GitHub Actions [Run 29504809163](https://github.com/anjingdtl/tavo-mini/actions/runs/29504809163) passed JavaScript validation, Android Debug build, and Migration matrix.
- The V2.4.4 tag gate produced `dist/apk/debug/ShineWriter-V2.4.4-debug.apk` (50,106,550 bytes; SHA-256 `69D99F8D0900E87F90636AE83B109BA2D6438003C166270EFF74168411DCEB28`). AAPT and the installed package both report `versionName=V2.4.4`, `versionCode=2040400`; `adb install -r` preserved app data and `MainActivity` resumed on `emulator-5556`. The implementation-equivalent V2.4.3 artifact had already passed all six Maestro flows on the same emulator in 4m24s.
- Fault execution status is 7 PASS / 1 PARTIAL / 4 BLOCKED. Detailed methods and evidence live in `docs/FAULT_INJECTION_MATRIX.md`; contract-only Jest tests are not counted as real device injection.
- `V2.4.4` is intentionally a Tag-only engineering release. No signed Release/Minified APK or GitHub Release asset is claimed; signing credentials, ARM64 physical-device evidence, controllable GGUF/OOM inputs, and complete TTS background verification remain outstanding.
- The canonical branch is `main`. After the tag commit passes local gates, it is pushed to `origin/main`, annotated tag `V2.4.4` is pushed, the merged diagnostic branch is deleted locally/remotely, and parity/branch inventory is rechecked.
- The V2.4.4 release-preparation commit passed mainline GitHub Actions [Run 29506345363](https://github.com/anjingdtl/tavo-mini/actions/runs/29506345363): JavaScript validation 67s, Migration matrix 28s, Android Debug build 9m13s. This final evidence-only update uses `[skip ci]`; the annotated tag is created on the resulting documentation-complete commit.



## V2.4.6 上下文自动化配置 tag closure — 2026-07-18

- 版本元数据推进到 V2.4.6，versionCode=2040600；数据库 Schema 仍为 14，不引入新迁移。
- 新增"上下文自动化配置"模块：用户在设置页填入模型支持的最大上下文（如 200000），按比例（输入 65/20/15、输出 50/15/15/20、资源级 R1 + 单项下限兜底）自动分配到 ContextConfig、PipelineConfig、llm_config、presets 和资源级 max_tokens，共 5 个配置点。
- 应用过程走单一 executeTransaction 原子事务，写入失败整体回滚；本地 GGUF 模型的 context_window 不被覆写；记录"上次应用"卡片供回显。
- Jest 全量基线：84 套件 / 432 测试通过（新增 contextAutoAllocator 19 个、contextAutoRepository 12 个）。
- emulator-5554（Android 17 / x86_64）端到端穿测 8 模块（项目列表 / 写作 Tab / 资料库 / 设置 / 上下文自动化 / 备份中心 / LLM 设置 / 语音设置）全部通过，0 崩溃 / 0 ANR；备份 pre_restore 自动快照、900ms 章节自动保存 + 数据回流均验证通过。完整穿测报告见 ../V2.4.6-TEST-REPORT.md（含 6 张关键截图 docs/e2e-screenshots/V2.4.6-*.png）。
- 已知阻塞（与 V2.4.4 相同）：第三方 .so（libllamacpp_jni、libreactnative、libhermesvm、libllama、libggml-xxx、libsqliteJni）16KB 页大小 / RELRO 对齐未满足，Android 15+ 真机无法启动；需升级 RN 0.85.x 16KB 兼容 patch + llama.cpp 重编后才能用于 Play Store 发布。本次 Tag 与 V2.4.4 一样不含签名 Release APK（SHINE_WRITER_RELEASE_xxx 环境变量未配置，签名 keystore 路径为 android/keystores/shine-writer-release.keystore，必须在 CI 注入）。

## V2.5.1 structured story memory release closure — 2026-07-18

- Version metadata advanced to V2.5.1 / versionCode 2050100; Schema remains 15 and no new migration is introduced from V2.5.0.
- Structured story memory phases 0–9 are complete. Chapter episodic summaries and TF-IDF Top-K retrieval remain in place alongside project-level deterministic story state.
- Emulator validation covered 29 non-empty chapter rebuilds, valid/repair/invalid model output, in-flight cancellation, checkpoint continuation, snapshot replay, clean context injection, and non-empty three-table backup restore with API-key exclusion.
- An emulator-discovered cancellation bug was fixed in `f8218df`: an aborted in-flight provider request now restores `dirty`, preserves completed checkpoints, and does not persist a false failure.
- Final local gates: `npm ci` PASS with both Android postinstall patches replayed (`npm audit`: 3 moderate dependency findings); `npm run verify` PASS, 98 suites / 489 tests; coverage 78.77% statements / 61.38% branches / 85.56% functions / 80.33% lines.
- Signed Release APK: `dist/apk/release/ShineWriter-V2.5.1-release.apk`, 37,190,635 bytes, SHA-256 `41BE102B8499869118B2B83ABC0E22E3072CA2650A22F98F8E42637BB30BC13A`.
- Release acceptance: official certificate SHA-256 matched, APK Signature Scheme v2 passed with one signer, 16 KB zipalign verification passed, and AAPT reported `com.shinewriter` / `V2.5.1` / `2050100` / compileSdk 36.
- Remaining release risks: real external-model semantics and provider behavior, arm64 physical-device llama.cpp performance, vendor-ROM background/TTS/SAF behavior, and the compatibility dialog's third-party native-library 16 KB alignment findings.
