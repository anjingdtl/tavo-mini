import {
  compileCheckerMessages,
  compileRepairMessages,
} from '../src/services/continuation/generation/continuationPromptCompiler';

describe('续写原著事实复核提示词', () => {
  it('将五类原著事实和其可追溯证据一并交给复核器', () => {
    const snapshot: any = {
      targetPosition: 9,
      bundles: {
        lockedRules: [],
        canon: {
          worldRules: [
            {
              id: 1,
              title: '死亡不可逆',
              description: '已死亡角色不可复活',
              constraintLevel: 'hard',
              reviewStatus: 'confirmed',
            },
          ],
          characters: [
            { id: 2, canonicalName: '沈青', description: '剑客' },
          ],
          relationships: [
            {
              id: 3,
              sourceCharacterId: 2,
              targetCharacterId: 4,
              relationType: '师徒',
              attitude: '信任',
              publicStatus: 'public',
              description: '沈青是陆川的师父',
            },
          ],
          experiences: [
            {
              id: 5,
              characterId: 2,
              title: '雁门受伤',
              description: '左臂负伤',
            },
          ],
          knowledge: [
            {
              id: 6,
              characterId: 2,
              factKey: '密令',
              factSummary: '尚未知晓密令内容',
              knowledgeState: 'unknown',
            },
          ],
          timelineEvents: [
            { id: 7, title: '雁门之战', summary: '发生在入城之前' },
          ],
          characterStates: [
            {
              id: 8,
              characterId: 2,
              summary: '沈青在城外养伤',
              aliveState: 'alive',
            },
          ],
          plotThreads: [
            { id: 9, title: '密令下落', description: '线索未解', status: 'active' },
          ],
          evidenceRefs: [11, 12, 13],
          evidenceRefsByOwner: {
            world_rule: { 1: [11] },
            relationship: { 3: [12] },
            experience: { 5: [13] },
          },
        },
        effectiveState: {
          characterStates: [],
          plotThreads: [],
          targetPosition: 9,
        },
      },
    };

    const system = compileCheckerMessages(snapshot, '陆川令沈青复活。')[0]
      .content;

    expect(system).toContain('【原著事实复核依据】');
    expect(system).toContain('沈青是陆川的师父');
    expect(system).toContain('雁门受伤');
    expect(system).toContain('尚未知晓密令内容');
    expect(system).toContain('雁门之战');
    expect(system).toContain('密令下落');
    expect(system).toContain('证据:11');
    expect(system).toContain('证据:12');
    expect(system).toContain('证据:13');
    expect(system).toContain('原著事实与正文冲突');

    const repairSystem = compileRepairMessages(
      snapshot,
      '陆川令沈青复活。',
      [
        {
          severity: 'blocking',
          category: 'relationship',
          description: '人物关系冲突',
          generatedStart: 0,
          generatedEnd: 3,
          suggestedFix: '按师徒关系修改',
        } as any,
      ],
    )[0].content;
    expect(repairSystem).toContain('【原著事实复核依据】');
    expect(repairSystem).toContain('沈青是陆川的师父');
  });
});
