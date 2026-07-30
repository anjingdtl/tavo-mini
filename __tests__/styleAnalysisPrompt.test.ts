import {
  STYLE_ANALYZER_VERSION,
  buildStyleAnalysisSystemPrompt,
  buildStyleAnalysisUserPrompt,
} from '../src/services/continuation/styleProfile/styleAnalysisPrompt';

describe('high-fidelity continuation style analysis prompt', () => {
  it('requires concrete highest-strength imitation constraints', () => {
    const prompt = buildStyleAnalysisSystemPrompt();
    expect(STYLE_ANALYZER_VERSION).toBe('style-v2-3');
    expect(prompt).toContain('可操作风格契约');
    expect(prompt).toContain('频率/范围');
    expect(prompt).toContain('句长/段长/标点组合');
    expect(prompt).toContain('基调/情绪递进');
    expect(prompt).toContain('语域/偏好/禁忌词');
    expect(prompt).toContain('叙事距离/对白句式');
    expect(prompt).toContain('场景推进/信息揭示/转场');
    expect(prompt).toContain('维持原样');
  });

  it('tells the model that the output drives high-fidelity continuation', () => {
    const prompt = buildStyleAnalysisUserPrompt({
      metricsSummary: '{}',
      sampleBlocks: '样本',
      coverage: { sourceChapterCount: 12, sampledChapterCount: 8 },
    });
    expect(prompt).toContain('最高强度仿写');
    expect(prompt).toContain('稳定复现句段、语气、词汇、人物对白与章节节奏');
  });
});
