import {
  buildFrozenPresetContext,
  renderPresetForStage,
} from '../src/services/context/resources/presetContextCompiler';
import { ResourceContextError } from '../src/services/context/resources/resourceContextErrors';

const preset = {
  id: 12,
  project_id: 1,
  name: '悬疑调查推进',
  is_default: 0,
  system_prompt: '用中文写悬疑小说，禁止全知视角泄露凶手。',
  writing_style: '冷峻短句，环境先于心理。',
  extra_instructions: '不要出现超自然解释。',
  temperature: 0.7,
  top_p: 0.9,
  max_tokens: 2000,
  enabled_for_project: 1,
};

test('Draft and Proof receive full preset parts', () => {
  const frozen = buildFrozenPresetContext({
    requestedPresetId: 12,
    preset,
  });
  const draft = renderPresetForStage(frozen, 'draft');
  const proof = renderPresetForStage(frozen, 'proof');
  expect(draft.policy).toBe('full');
  expect(proof.policy).toBe('full');
  expect(draft.combinedText).toContain('悬疑小说');
  expect(draft.combinedText).toContain('冷峻短句');
  expect(draft.combinedText).toContain('超自然');
  expect(proof.combinedText).toBe(draft.combinedText);
});

test('Review treats preset as evaluation target, not a style to imitate', () => {
  const frozen = buildFrozenPresetContext({ requestedPresetId: 12, preset });
  const review = renderPresetForStage(frozen, 'review');
  expect(review.policy).toBe('evaluation_target');
  expect(review.combinedText).toContain('评判目标');
  expect(review.combinedText).toContain('不要模仿该文风写审稿');
});

test('FactCheck keeps hard constraints and demotes aesthetic style', () => {
  const frozen = buildFrozenPresetContext({ requestedPresetId: 12, preset });
  const fact = renderPresetForStage(frozen, 'factCheck');
  expect(fact.policy).toBe('hard_constraints');
  expect(fact.combinedText).toContain('禁止全知视角');
  expect(fact.combinedText).toContain('事实判断不受审美偏好影响');
});

test('Brief keeps only hard constraints', () => {
  const frozen = buildFrozenPresetContext({ requestedPresetId: 12, preset });
  const brief = renderPresetForStage(frozen, 'brief');
  expect(brief.policy).toBe('minimal_hard');
  expect(brief.combinedText).toContain('禁止全知视角');
  expect(brief.writingStyleText).toBe('');
});

test('preset id 0 is treated as no explicit selection', () => {
  const frozen = buildFrozenPresetContext({ requestedPresetId: 0 as any });
  expect(frozen.presetSource).toBe('default_runtime_baseline');
});

test('missing explicit preset fails closed', () => {
  expect(() =>
    buildFrozenPresetContext({ requestedPresetId: 12, preset: null }),
  ).toThrow(ResourceContextError);
});

test('preset is not a resource item competing with characters', () => {
  const frozen = buildFrozenPresetContext({ requestedPresetId: 12, preset });
  expect(frozen.presetSource).toBe('user_selected');
  expect(frozen.sourceFingerprint.length).toBeGreaterThan(16);
});
