import {
  STYLE_ANALYZER_VERSION,
  buildStyleAnalysisSystemPrompt,
  buildStyleAnalysisUserPrompt,
} from '../src/services/continuation/styleProfile/styleAnalysisPrompt';

describe('high-fidelity continuation style analysis prompt', () => {
  it('requires concrete highest-strength imitation constraints', () => {
    const prompt = buildStyleAnalysisSystemPrompt();
    expect(STYLE_ANALYZER_VERSION).toBe('style-v2-2');
    expect(prompt).toContain('最高强度仿写');
    expect(prompt).toContain('频率/范围');
    expect(prompt).toContain('句式结构');
    expect(prompt).toContain('语气与情感');
    expect(prompt).toContain('用词与搭配');
    expect(prompt).toContain('叙述视角与人物口吻');
    expect(prompt).toContain('叙事节奏');
    expect(prompt).toContain('维持原样');
  });

  it('tells the model that the output drives high-fidelity continuation', () => {
    const prompt = buildStyleAnalysisUserPrompt({
      metricsJson: '{}',
      sampleBlocks: '样本',
      coverage: { sourceChapterCount: 12, sampledChapterCount: 8 },
    });
    expect(prompt).toContain('最高强度仿写');
    expect(prompt).toContain('稳定复现句段、语气、词汇、人物对白与章节节奏');
  });
});
