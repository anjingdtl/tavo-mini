# Data Reliability Phase 0–1 Design

## Scope

This design implements only Phase 0 and Phase 1 of `Tavo-Mini-Agent-Optimization-Plan.md`. It establishes measurable quality gates and makes database initialization and migrations transaction-safe. Backup and restore behavior, release signing, CI, and product features are intentionally out of scope.

## Decisions

### Quality baseline and progress records

`docs/optimization/baseline.md` records the environment and unmodified project results for lint, TypeScript, Jest, and the Android debug APK build. It is evidence, not a claim that every existing issue is fixed.

`docs/optimization/progress.md` is the durable execution log. Each task entry records its state, root cause, changed files, targeted and full verification, commit SHA, and remaining risk. The log is updated before each task commit.

`package.json` gains three scripts: `typecheck` (`tsc --noEmit`), `test:ci` (`jest --runInBand --ci`), and `verify` (lint, typecheck, then CI test run). The existing command set remains compatible.

### Transaction boundary

`src/services/database/transaction.ts` becomes the only low-level batch transaction executor for this phase. Callers prepare an ordered list of SQL statements before entering the SQLite transaction. The transaction callback is synchronous and only schedules `executeSql` calls; it never uses `async` or `await`. The promise resolves only through the database transaction success callback and rejects with the original SQLite error.

Migrations use declarative statement builders whenever possible. Each migration’s schema changes, data changes, index changes, and schema-version update are submitted in one batch through the transaction executor. A failed statement rejects the migration and leaves the persisted schema version unchanged.

### Database initialization lifecycle

Initialization distinguishes fresh installs from existing databases. A fresh database creates the current schema directly. An existing database reads its metadata, runs required migrations before normal seeding, validates the resulting schema, then applies only documented historical-defect repairs. Seed data, indexes, and derived-data repair run only after successful migration and validation.

`ensureSchemaCompatibility` is replaced with `repairKnownSchemaDefects`. Each repair has a named historical condition and version range, emits a diagnostic log, and does not act on a healthy current-schema database. It is not a fallback migration mechanism.

### Runtime schema validation

`schemaManifest.ts` is the single definition of required tables, columns, indexes, backup participation, and restore order. `schemaValidator.ts` verifies that manifest plus schema version, foreign-key activation, active LLM configuration integrity, and orphan references. Database initialization runs validation before exposing the database as ready. Failure remains visible to the caller with actionable diagnostic context; it never deletes or resets a user database.

## Test strategy

All behavior changes follow red-green-refactor. New transaction tests cover empty batches, ordering, parameters, statement failures, transaction failures, synchronous callbacks, and single completion. Migration tests cover every supported historic schema version through the current version, atomic failure, repeated runs, and required tables/columns/indexes. Initialization tests cover fresh install, old-schema upgrades, no seeding after a failed migration, and the no-op behavior of known-defect repair for a healthy schema. Schema validation tests cover successful validation and representative failure diagnostics.

Every task runs its focused test first, then `npm run verify`. The phase finishes with `npm run apk:debug` because database TypeScript changes can affect the Android bundle.

## Constraints and non-goals

- No migration uses `transaction(async ...)` or awaits inside a transaction callback.
- No existing database table, field meaning, or user data is deleted or reset.
- No backup or restore code is changed in this phase.
- No release signing configuration is changed in this phase.
- The untracked source optimization plan remains user-owned and is not included in commits.

## Risks

The existing SQLite mock may not expose the same callback ordering as Android. Tests will assert the public promise behavior and callback shape, while the required debug APK build confirms Android compilation. Historic schemas may reveal undocumented variants; such a variant will be recorded in progress and paused for explicit migration design rather than repaired silently.
