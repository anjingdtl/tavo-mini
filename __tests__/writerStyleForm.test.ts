import { compileWriterStyleProjections } from '../src/services/writerStyle/compiler';
import { semanticToRuntimeText } from '../src/services/writerStyle/semantic';
import {
  formFromWriterStyleAsset,
  formToWriterStyleSemantic,
  writerStyleFormSnapshot,
} from '../src/screens/writer-style/writerStyleForm';

const asset = {
  name: '限知悬疑',
  semantic_json: JSON.stringify({
    version: 1,
    name: '限知悬疑',
    description: '公平线索',
    applicability: { genres: ['悬疑'], audience: '成人', tone: '克制' },
    narration: { pointOfView: '第三人称限知' },
    language: { texture: '冷色调' },
    sceneAndCharacter: { dialogue: '少解释' },
    narrativeMechanics: { pacing: '快节奏' },
    literaryTexture: { imagery: '灯与锁' },
    prohibitions: ['作者旁白'],
  }),
  system_prompt: '旧系统',
  writing_style: '旧文风',
  extra_instructions: '旧约束',
  temperature: 0.74,
  top_p: 0.88,
  max_tokens: 4000,
  is_default: 0,
};

describe('writer style form model', () => {
  it('round-trips Semantic V1 groups without creating a second schema', () => {
    const form = formFromWriterStyleAsset(asset);
    expect(form.genresText).toBe('悬疑');
    expect(form.pointOfView).toBe('第三人称限知');
    expect(form.prohibitions).toEqual(['作者旁白']);
    const semantic = formToWriterStyleSemantic({
      ...form,
      texture: '长短句交替',
      prohibitions: [...form.prohibitions, '禁止金句堆叠'],
    });
    expect(semantic.version).toBe(1);
    expect(semantic.language.texture).toBe('长短句交替');
    expect(semantic.prohibitions).toEqual(['作者旁白', '禁止金句堆叠']);
    const runtime = semanticToRuntimeText(semantic);
    const projections = compileWriterStyleProjections(semantic, {
      system: runtime.systemPrompt,
      style: runtime.writingStyle,
      extra: runtime.extraInstructions,
    });
    expect(projections.draft.mode).toBe('FULL');
    expect(projections.review.mode).toBe('EVALUATION');
    expect(projections.factCheck.mode).toBe('HARD');
    expect(projections.brief.mode).toBe('MINIMAL');
    expect(projections.proof.mode).toBe('FULL');
    expect(projections.draft.text).toContain('长短句交替');
  });

  it('marks dirty when the form snapshot changes', () => {
    const form = formFromWriterStyleAsset(asset);
    const baseline = writerStyleFormSnapshot(form);
    expect(writerStyleFormSnapshot({ ...form, tone: '更冷' })).not.toBe(baseline);
  });
});
