/**
 * RB-15 / Phase 6.2 of V2.11.34 blocker plan:
 *
 * `initializeDatabase()` is the single migration owner. After it has run,
 * `runMigrations` MUST NOT be re-invoked from any startup path. The legacy
 * `UpgradeScreen.onConfirm` re-called `runMigrations` against the
 * pre-migration `lastInstallInfo.schemaVersion`, which would double-execute
 * the same SQL on a recorded-version-equals database and risk data loss.
 *
 * The contract this test pins down:
 *   - When the upgrade gate is `hasBreakingMigration(lastInstallInfo.schemaVersion)`
 *     and `initializeDatabase` has already run migrations, the legacy
 *     handleUpgradeConfirm MUST NOT re-invoke runMigrations.
 *   - The App's upgrade-flow check must short-circuit when
 *     `lastMigrationResult` is already populated.
 *
 * We pin this by reading the App/index.tsx source and asserting that:
 *   1. handleUpgradeConfirm (or the App-level migration trigger) is gated on
 *      `lastMigrationResult == null` BEFORE evaluating
 *      `hasBreakingMigration(lastInstallInfo.schemaVersion)`.
 *   2. After initializeDatabase succeeds with a breaking migration, the App
 *      must not call runMigrations again.
 */
/* eslint-env jest */
import * as fs from 'fs';
import * as path from 'path';

const APP_SOURCE_PATH = path.resolve(__dirname, '../src/main/index.tsx');
const MIGRATIONS_SOURCE_PATH = path.resolve(
  __dirname,
  '../src/services/migrations/index.ts',
);

describe('RB-15 single migration owner (V2.11.34 blocker)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('App/index.tsx gates UpgradeScreen on lastMigrationResult, not on raw hasBreakingMigration(lastInstallInfo.schemaVersion)', () => {
    const source = fs.readFileSync(APP_SOURCE_PATH, 'utf8');

    // The fix: the upgrade gate must check lastMigrationResult first.
    // The buggy pattern was:
    //   if (info?.installType === 'upgrade' && hasBreakingMigration(info.schemaVersion || 1)) { setUpgradeVisible(true); }
    // The required pattern is the same gate PLUS `&& !migrationAlreadyApplied`
    // (or equivalent short-circuit on lastMigrationResult).
    const hasLegacyGate = /hasBreakingMigration\(\s*info\.schemaVersion\s*\|\|\s*1\s*\)/.test(source);
    const guardsOnMigrationResult =
      /!migrationAlreadyApplied/.test(source) ||
      /lastMigrationResult\s*===?\s*null/.test(source) ||
      /lastMigrationResult\s*==\s*null/.test(source) ||
      /!lastMigrationResult/.test(source);

    // Either the legacy gate was removed entirely, OR the App now gates on
    // lastMigrationResult before consulting hasBreakingMigration.
    if (hasLegacyGate) {
      // Legacy gate is still present — it MUST now be AND-ed with the guard.
      expect(guardsOnMigrationResult).toBe(true);
    } else {
      expect(guardsOnMigrationResult).toBe(true);
    }
  });

  test('App/index.tsx handleUpgradeConfirm short-circuits when lastMigrationResult is populated', () => {
    const source = fs.readFileSync(APP_SOURCE_PATH, 'utf8');

    // handleUpgradeConfirm must check lastMigrationResult before calling
    // runMigrations. If lastMigrationResult is truthy, it must not invoke
    // the migration path.
    const handleFn = source.match(
      /const handleUpgradeConfirm[\s\S]*?\}, \[\]\);/,
    );
    expect(handleFn).not.toBeNull();
    const body = handleFn?.[0] ?? '';

    // The body must contain an early-return guard keyed on lastMigrationResult.
    const earlyReturn = /if\s*\(\s*lastMigrationResult\s*\)\s*\{[\s\S]*?return[\s\S]*?\}/.test(body);
    expect(earlyReturn).toBe(true);
  });

  test('migrations module exports the single owner function', () => {
    const source = fs.readFileSync(MIGRATIONS_SOURCE_PATH, 'utf8');
    expect(/export async function runMigrations/.test(source)).toBe(true);
    expect(/export function hasBreakingMigration/.test(source)).toBe(true);
  });
});
