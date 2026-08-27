import {
  novelPresetDraftToPreset,
  parseNovelPresetDraft,
  parseShineWriterPresetV1,
} from '../src/services/construction/presetDraftAdapter';

describe('preset construction adapter', () => {
  it('keeps only literary fields from the model and fills local metadata', () => {
    const draft = parseNovelPresetDraft({
      name: '限知悬疑',
      system_prompt: '保持受限视角与可回溯因果。',
      writing_style: '用物件、停顿和空间阻力推进场景。',
      extra_instructions: '伏笔必须公平，禁止凭空反转。',
      spec: 'model-must-not-control-this',
      temperature: 1.9,
      top_p: 0.1,
      max_tokens: 99,
      is_default: true,
    });

    expect(draft).toEqual({
      name: '限知悬疑',
      system_prompt: '保持受限视角与可回溯因果。',
      writing_style: '用物件、停顿和空间阻力推进场景。',
      extra_instructions: '伏笔必须公平，禁止凭空反转。',
    });
    expect(novelPresetDraftToPreset(draft)).toEqual({
      spec: 'shinewriter-preset-v1',
      ...draft,
      temperature: 0.8,
      top_p: 0.9,
      max_tokens: 0,
    });
  });

  it('round-trips the existing v1 export envelope', () => {
    const preset = {
      spec: 'shinewriter-preset-v1' as const,
      name: '旧预设',
      system_prompt: '作者身份。',
      writing_style: '写法。',
      extra_instructions: '约束。',
      temperature: 0.72,
      top_p: 0.91,
      max_tokens: 2400,
    };
    expect(parseShineWriterPresetV1(JSON.parse(JSON.stringify(preset)))).toEqual(
      preset,
    );
  });

  it('hard-fails an incomplete preset contract', () => {
    expect(() =>
      parseNovelPresetDraft({
        name: '缺字段',
        system_prompt: '作者。',
        writing_style: '',
        extra_instructions: '约束。',
      }),
    ).toThrow('writing_style');
  });
});
