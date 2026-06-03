import { summarizePipelineTokens } from '../src/screens/PipelineResultScreen';

test('summarizes total tokens and input context tokens separately', () => {
  const summary = summarizePipelineTokens([
    { stage: 'draft', status: 'success', text: 'draft', tokens: { input: 100, output: 20, total: 120 }, durationMs: 1000 },
    { stage: 'review', status: 'skipped', text: '', durationMs: 0 },
    { stage: 'factCheck', status: 'success', text: 'fact', tokens: { input: 80, output: 10, total: 90 }, durationMs: 1000 },
  ]);

  expect(summary).toEqual({ inputTokens: 180, totalTokens: 210 });
});
