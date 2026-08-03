import fs from 'fs';
import path from 'path';

describe('Context Preview V4 UI contract', () => {
  test('预览显示四节点预算和冻结追溯信息，不在界面写死 token fallback', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/screens/ContextPreviewScreen.tsx'),
      'utf8',
    );
    for (const stage of ['writer', 'checker', 'control', 'repair']) {
      expect(source).toContain(`'${stage}'`);
    }
    expect(source).toContain('policyHash');
    expect(source).toContain('canonSnapshotId');
    expect(source).toContain('styleProfileHash');
    expect(source).toContain('supplementHashes');
    expect(source).toContain('预览不发送请求、不创建 run');
    expect(source).not.toContain('|| 8192');
    expect(source).not.toContain('Math.max(256');
  });
});
