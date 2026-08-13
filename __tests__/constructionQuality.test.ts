import {
  assessConstructionArtifact,
  getDetailConstraints,
  requiredConstructionOutput,
} from '../src/services/construction/quality';
import type { ConstructionArtifact } from '../src/services/construction/targets';

function richCharacter(): Extract<ConstructionArtifact, { kind: 'character' }> {
  return {
    kind: 'character',
    name: '沈砚',
    card: {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: '沈砚',
        description: '人物设定。'.repeat(700),
        personality: '克制与执念。'.repeat(70),
        scenario: '雾港工坊中的选择与冲突。'.repeat(40),
        first_mes: '你推门而入，沈砚抬眼确认你的来意。'.repeat(12),
        mes_example: '{{char}}: 先说明来意。\n{{user}}: 我需要图纸。\n{{char}}: 代价是什么？\n{{user}}: 我愿意承担。'.repeat(10),
        system_prompt: '保持克制、敏锐、带条件的善意和机关师的风险意识。'.repeat(10),
        post_history_instructions: '保持角色声音、关系边界和对承诺的持续记忆。'.repeat(6),
        tags: ['机关师', '雾港', '克制', '反派'],
        alternate_greetings: [],
        creator: 'test',
        character_version: '1.0',
      },
    },
  };
}

function richWorldbook(): Extract<ConstructionArtifact, { kind: 'worldbook' }> {
  return {
    kind: 'worldbook',
    name: '雾港纪事',
    entryCount: 4,
    lorebook: {
      spec: 'lorebook_v3',
      spec_version: '1.0',
      data: {
        name: '雾港纪事',
        entries: Array.from({ length: 4 }, (_, index) => ({
          keys: [`条目${index}`],
          secondary_keys: ['关联词'],
          content: '世界设定、历史、场景与后果。'.repeat(50),
          comment: `说明${index}`,
          enabled: true,
          constant: true,
          insertion_order: index,
        })),
      },
    },
  };
}

describe('construction quality', () => {
  test('full-detail bounds are explicit and include worldbook collection overhead', () => {
    expect(getDetailConstraints('full').character.minOutputTokens).toBe(2800);
    expect(requiredConstructionOutput('worldbook', 4, 'full')).toBe(2800);
    expect(requiredConstructionOutput('worldbook', 4, 'deep')).toBe(3800);
  });

  test('accepts a rich full-detail character and reports visible token size', () => {
    const report = assessConstructionArtifact(richCharacter(), 'full', 9999);
    expect(report.passed).toBe(true);
    expect(report.actualOutputTokens).toBeGreaterThanOrEqual(2800);
    expect(report.providerOutputTokens).toBe(9999);
    expect(report.character?.dialogueTurns).toBeGreaterThanOrEqual(3);
  });

  test('reports short characters even when a provider reports large hidden usage', () => {
    const artifact = richCharacter();
    artifact.card.data.description = '很短';
    const report = assessConstructionArtifact(artifact, 'full', 100000);
    expect(report.passed).toBe(false);
    expect(report.warnings.some(item => item.code === 'output_tokens_short')).toBe(true);
    expect(report.failures.some(item => item.code === 'character_description_short')).toBe(false);
  });

  test('worldbook content remains a hard always-on invariant', () => {
    const artifact = richWorldbook();
    artifact.lorebook.data.entries[2].constant = false;
    const report = assessConstructionArtifact(artifact, 'full');
    expect(report.passed).toBe(false);
    expect(report.failures.some(item => item.code === 'worldbook_not_constant')).toBe(true);
  });
});
