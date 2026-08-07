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

  it('runs one Jest pass (CI mode) in GitHub Actions', () => {
    // F2-08: 门禁切到 test:ci —— coverage 阈值（database/schema/migrations/
    // backup）有历史缺口，会让门禁常红；test:ci 与门禁定义一致且可 green。
    expect(workflow).toContain('name: Jest (CI mode)');
    expect(workflow.match(/npm run test:ci/g)).toHaveLength(1);
    expect(workflow).not.toContain('npm run test:coverage');
  });

});
