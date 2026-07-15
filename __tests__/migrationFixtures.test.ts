/* eslint-env jest */

import path from 'path';
import { spawnSync, type SpawnSyncReturns } from 'child_process';

function runFixtureValidator(): SpawnSyncReturns<string> {
  const script = path.resolve(
    __dirname,
    '..',
    'scripts',
    'generate-migration-fixtures.py',
  );
  const candidates =
    process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  for (const command of candidates) {
    const result = spawnSync(command, [script, '--check'], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    });
    const spawnError = result.error as NodeJS.ErrnoException | undefined;
    if (spawnError?.code === 'ENOENT') continue;
    return result;
  }
  throw new Error(
    'Python 3 is required to validate SQLite migration fixtures.',
  );
}

test('upgrades every committed historical SQLite fixture to Schema 14', () => {
  const result = runFixtureValidator();
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;

  expect(result.status).toBe(0);
  expect(output).toContain('validated 11 migration fixtures to Schema 14');
});
