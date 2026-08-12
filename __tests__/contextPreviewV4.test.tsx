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

  test('V3 分层预算卡只展示分层预算摘要，不展示 board 明细', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/screens/ContextPreviewScreen.tsx'),
      'utf8',
    );
    expect(source).toContain('上下文预算 V3 分层弹性');
    expect(source).toContain('强制输入上限');
    expect(source).toContain('风险等级');
    for (const field of ['contextWindow', 'softInputLimit', 'burstInputLimit', 'totalEstimatedInputTokens']) {
      expect(source).toContain(field);
    }
    expect(source).not.toContain('V3_BOARD_ORDER');
    expect(source).not.toContain('Story State：需求');
    expect(source).not.toContain('Resources：需求');
    expect(source).not.toContain('Sliding Window：需求');
    expect(source).not.toContain('Episodic：需求');
    expect(source).not.toContain('弹性上限');
  });
});
