/* eslint-env jest */

import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');

describe('JavaScript CI configuration', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  it('uses a Linux runtime supported by React Native 0.85', () => {
    expect(packageJson.engines.node).toBe('>=24.3.0');
  });

  it('lets Jest and coverage terminate naturally', () => {
    expect(packageJson.scripts['test:ci']).toBe('jest --runInBand --ci');
    expect(packageJson.scripts['test:coverage']).toBe(
      'jest --runInBand --ci --coverage',
    );
    expect(packageJson.scripts['test:ci']).not.toContain('--forceExit');
    expect(packageJson.scripts['test:coverage']).not.toContain('--forceExit');
  });

});
