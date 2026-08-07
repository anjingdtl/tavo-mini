/**
 * RB-16 / Phase 6.4 of V2.11.34 blocker plan:
 *
 * `repairOversizedNotes` is destructive — it splits oversized notes into
 * chunks and DELETES the original note. Running this on EVERY startup is
 * dangerous:
 *   - Crashes during the operation leave the user's data in an inconsistent
 *     state.
 *   - Silent failures (the existing try/catch just warns) hide data loss.
 *   - There is no user confirmation, no preview, no rollback path.
 *
 * Contract: the startup main path MUST NOT call `repairOversizedNotes`. It
 * must only run as an explicit user action (Settings → 数据维护 → 优化超大笔记)
 * that creates a safety backup and offers cancellation.
 *
 * This test pins down the contract by reading the source of
 * `initializeDatabase.ts` and asserting that the startup path no longer
 * invokes `repairOversizedNotes` at all.
 */
/* eslint-env jest */
import * as fs from 'fs';
import * as path from 'path';

const INIT_DB_PATH = path.resolve(
  __dirname,
  '../src/data/schema/initializeDatabase.ts',
);
const FEATURE_FLAGS_PATH = path.resolve(
  __dirname,
  '../src/services/featureFlags.ts',
);

describe('RB-16 startup note repair gate (V2.11.34 blocker)', () => {
  test('initializeDatabase does not call repairOversizedNotes on the startup path', () => {
    const source = fs.readFileSync(INIT_DB_PATH, 'utf8');

    // Locate the body of `initializeDatabase` by index of braces after
    // the export. Any call to `repairOversizedNotes(...)` inside it
    // would be a startup-time mutation; only the export of the helper
    // from noteRepository.ts is allowed.
    const start = source.indexOf('export async function initializeDatabase');
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = start;
    let foundFirstBrace = false;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') {
        depth++;
        foundFirstBrace = true;
      } else if (ch === '}') {
        depth--;
        if (foundFirstBrace && depth === 0) {
          end = i;
          break;
        }
      }
    }
    // Strip line comments and block comments so we don't false-positive
    // on the documentation we left in place explaining WHY the call is
    // gone.
    const body = source.slice(start, end + 1);
    const stripped = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const calls = stripped.match(/repairOversizedNotes\s*\(/g) || [];
    expect(calls).toEqual([]);
  });

  test('featureFlags module defines the startup note repair gate key', () => {
    const source = fs.readFileSync(FEATURE_FLAGS_PATH, 'utf8');
    // The fix introduces a new feature flag key,
    // `startup_note_repair_enabled`. The Settings → 实验功能 surface
    // will flip this when the user explicitly invokes the data
    // maintenance action. It MUST stay OFF by default so a future
    // maintenance button never runs automatically on cold start.
    const hasGate = /startup_note_repair/.test(source);
    expect(hasGate).toBe(true);
  });
});
