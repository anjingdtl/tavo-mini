import { estimateTokens } from '../src/utils/tokenEstimator';
import { compileWriterStyleProjections, freezeWriterStyle } from '../src/services/writerStyle/compiler';
import { normalizeWriterStyleSemantic, semanticToRuntimeText } from '../src/services/writerStyle/semantic';

describe('Writer Style Semantic V1', () => {
  const semantic = normalizeWriterStyleSemantic({
    name: '限知悬念推进',
    applicability: { genres: ['悬疑'], audience: '成人', tone: '冷静' },
    narration: { pointOfView: '第三人称限知', narratorDistance: '中近距离' },
    language: { texture: '具体克制', syntax: '短句推进动作' },
    narrativeMechanics: {
      informationReveal: '先细节后因果',
      continuity: '事实不可漂移',
      foreshadowing: '伏笔可回溯',
    },
    prohibitions: ['禁止凭空出现关键证据'],
  });

  it('normalizes semantic fields and compiles legacy runtime text', () => {
    expect(semantic.version).toBe(1);
    const runtime = semanticToRuntimeText(semantic);
    expect(runtime.writingStyle).toContain('第三人称限知');
    expect(runtime.extraInstructions).toContain('禁止凭空出现关键证据');
  });

  it('creates distinct protected stage projections without tail clipping', () => {
    const projections = compileWriterStyleProjections(semantic, {
      system: '',
      style: '',
      extra: '',
    });
    expect(projections.draft.mode).toBe('FULL');
    expect(projections.review.mode).toBe('EVALUATION');
    expect(projections.factCheck.mode).toBe('HARD');
    expect(projections.brief.mode).toBe('MINIMAL');
    expect(projections.proof.mode).toBe('FULL');
    expect(projections.proof.text).toBe(projections.draft.text);
    expect(projections.draft.protected).toBe(true);
    expect(projections.draft.estimatedTokens).toBe(
      estimateTokens(projections.draft.text),
    );
  });

  it('freezes legacy rows as compatible Writer Style assets', () => {
    const frozen = freezeWriterStyle({
      id: 7,
      project_id: 1,
      name: '旧风格',
      is_default: 0,
      system_prompt: '系统',
      writing_style: '风格',
      extra_instructions: '约束',
      temperature: 0.8,
      top_p: 0.9,
      max_tokens: 4000,
      source_format: 'legacy_shinewriter',
    });
    expect(frozen.sourceFormat).toBe('legacy_shinewriter');
    expect(frozen.stageProjections.draft.text).toContain('风格');
    expect(frozen.samplerResolution.ignoredAtPipeline).toContain('max_tokens');
  });
});
