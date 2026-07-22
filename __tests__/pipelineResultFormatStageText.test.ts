import { formatStageText } from '../src/screens/PipelineResultScreen';
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
