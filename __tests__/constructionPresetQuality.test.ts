import { assessConstructionArtifact } from '../src/services/construction/quality';
import type { PresetArtifact } from '../src/services/construction/targets';

function presetArtifact(overrides: Partial<PresetArtifact['preset']> = {}): PresetArtifact {
  return {
    kind: 'preset',
    name: '完整风格',
    preset: {
      spec: 'shinewriter-preset-v1',
      name: '完整风格',
      system_prompt:
        '叙述视角与叙述距离明确，作者身份稳定。'.repeat(80),
      writing_style:
        '句法词汇、段落组织、场景环境、人物对白、节奏冲突、信息悬念伏笔、章节结构、意象感官。'.repeat(80),
      extra_instructions:
        '禁止项与反模式清晰，适用特殊机制明确。'.repeat(80),
      temperature: 0.8,
      top_p: 0.9,
      max_tokens: 4000,
      ...overrides,
    },
  };
}

describe('preset construction quality', () => {
  it('accepts a structurally valid mechanism-rich preset', () => {
    const report = assessConstructionArtifact(presetArtifact(), 'deep', 4000);
    expect(report.hardPassed).toBe(true);
    expect(report.preset?.mechanismCoverage.length).toBeGreaterThanOrEqual(6);
    expect(report.providerOutputTokens).toBe(4000);
  });

  it('keeps short but valid content as a soft warning', () => {
    const report = assessConstructionArtifact(
      presetArtifact({
        system_prompt: '作者。',
        writing_style: '视角与对白。',
        extra_instructions: '禁止流水账。',
      }),
      'deep',
    );
    expect(report.hardPassed).toBe(true);
    expect(report.warnings.some(item => item.code === 'preset_content_short')).toBe(
      true,
    );
  });

  it('hard-fails prompt/protocol leakage', () => {
    const report = assessConstructionArtifact(
      presetArtifact({
        extra_instructions: 'temperature: 0.2; max_tokens: 4000',
      }),
      'full',
    );
    expect(report.hardPassed).toBe(false);
    expect(report.failures.some(item => item.code === 'preset_contract_leakage')).toBe(
      true,
    );
  });
});
