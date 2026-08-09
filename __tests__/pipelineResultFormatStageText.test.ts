import {
  formatStageText,
  splitStageWarnings,
} from '../src/screens/PipelineResultScreen';
import type { PipelineStageResult } from '../src/types/pipeline';

function stage(partial: Partial<PipelineStageResult>): PipelineStageResult {
  return {
    stage: 'factCheck',
    text: '',
    status: 'success',
    durationMs: 1000,
    ...partial,
  };
}

test('failed empty audit stage shows error, not blank', () => {
  expect(
    formatStageText(
      stage({
        status: 'failed',
        text: '',
        error: '事实核查返回格式无效（初稿回显）',
      }),
    ),
  ).toBe('事实核查返回格式无效（初稿回显）');
});

test('pretty-prints validated JSON reports', () => {
  const text = formatStageText(
    stage({
      stage: 'review',
      text: '{"strengths":[],"issues":["节奏慢"],"suggestions":[]}',
      status: 'success',
    }),
  );
  expect(text).toContain('"issues"');
  expect(text).toContain('节奏慢');
});

test('hides oversized non-JSON audit body', () => {
  const text = formatStageText(
    stage({
      stage: 'factCheck',
      text: 'A'.repeat(600),
      status: 'success',
    }),
  );
  expect(text).not.toContain('AAAA');
  expect(text).toContain('无效内容');
});

test('skipped stage has a clear message', () => {
  expect(
    formatStageText(stage({ stage: 'proof', status: 'skipped', text: '' })),
  ).toContain('跳过');
});

test('Brief envelope normalization is a neutral notice, not a red warning', () => {
  const result = splitStageWarnings(
    stage({
      stage: 'brief',
      warnings: [
        'Brief Compiler（Thinking disabled，优先输出 content 合同）',
        'Brief sourceHash 已由本地不可变信封覆盖',
        'Brief hardConstraints 已由本地不可变信封覆盖',
        'Brief mustFix 缺少 target/instruction',
      ],
    }),
  );

  expect(result.notices).toHaveLength(3);
  expect(result.warnings).toEqual(['Brief mustFix 缺少 target/instruction']);
});
