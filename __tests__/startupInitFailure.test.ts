/**
 * RB-20 / Phase 6.8 of V2.11.34 blocker plan:
 *
 * Database initialization failure MUST NOT silently enter the main UI with
 * empty project lists. The user's data may still be intact in the database
 * file; an empty list masquerading as "no projects" can cause them to wipe
 * the app data and lose everything.
 *
 * Contract: when openDatabase() (or initializeDatabase()) throws a
 * non-schema-recovery error, the App must NOT call setReady(true) and must
 * not render NavigationContainer. It must surface a safe error UI.
 */
/* eslint-env jest */
import * as fs from 'fs';
import * as path from 'path';

const APP_SOURCE_PATH = path.resolve(__dirname, '../src/main/index.tsx');

describe('RB-20 init failure safe screen (V2.11.34 blocker)', () => {
  test('App/index.tsx does not call setReady(true) on non-recovery init failure', () => {
    const source = fs.readFileSync(APP_SOURCE_PATH, 'utf8');

    // Find the catch block for the init() try. Within it, the non-recovery
    // branch MUST NOT call setReady(true). It must surface a structured
    // error and leave ready=false so the safe error UI renders instead of
    // NavigationContainer.
    const catchBlock = source.match(
      /catch\s*\(error: any\)\s*\{[\s\S]*?\}\s*\}\s*;/,
    );
    expect(catchBlock).not.toBeNull();
    const body = catchBlock?.[0] ?? '';

    // Inside the catch: if the error is NOT a schema-recovery error, the
    // App must not mark ready=true. The legacy pattern was:
    //   else { setReady(true); Toast.show(...); }
    // which incorrectly entered the main UI.
    const nonRecoveryReady = /else\s*\{[^}]*setReady\s*\(\s*true\s*\)/m.test(body);

    // The fix: the else branch must either:
    //   1. be removed entirely (so non-recovery failures fall through to a
    //      safe error UI without setReady(true)), OR
    //   2. set a structured error state instead of setReady(true).
    expect(nonRecoveryReady).toBe(false);
  });

  test('App/index.tsx surfaces a non-recovery error via databaseRecoveryStore.setError', () => {
    const source = fs.readFileSync(APP_SOURCE_PATH, 'utf8');

    const catchBlock = source.match(
      /catch\s*\(error: any\)\s*\{[\s\S]*?\}\s*\}\s*;/,
    );
    const body = catchBlock?.[0] ?? '';

    // The non-recovery branch must call setError on the recovery store
    // so the safe error UI can render. The recovery store hook is
    // `useDatabaseRecoveryStore`.
    const usesSetError = /useDatabaseRecoveryStore[\s\S]*?\.setError\s*\(/.test(body);
    expect(usesSetError).toBe(true);
  });
});
