/* eslint-env jest */

import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');

describe('JavaScript CI configuration', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'verify.yml'),
    'utf8',
  );
  it('uses a Linux runtime supported by React Native 0.85', () => {
    expect(packageJson.engines.node).toBe('>=24.3.0');
    expect(workflow).toContain('node-version: 24.14.1');
  });

  it('lets Jest and coverage terminate naturally', () => {
    expect(packageJson.scripts['test:ci']).toBe('jest --runInBand --ci');
    expect(packageJson.scripts['test:coverage']).toBe(
      'jest --runInBand --ci --coverage',
    );
    expect(packageJson.scripts['test:ci']).not.toContain('--forceExit');
    expect(packageJson.scripts['test:coverage']).not.toContain('--forceExit');
  });

  it('runs one coverage-enabled Jest pass in GitHub Actions', () => {
    expect(workflow).toContain('name: Jest with coverage');
    expect(workflow.match(/npm run test:coverage/g)).toHaveLength(1);
    expect(workflow).not.toContain('run: npm run test:ci');
  });

});
