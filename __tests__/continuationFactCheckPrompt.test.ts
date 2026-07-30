import {
  compileCheckerMessages,
  compilePlannerMessages,
  compileRepairMessages,
  compileWriterMessages,
} from '../src/services/continuation/generation/continuationPromptCompiler';

describe('续写原著事实复核提示词', () => {
  it('将五类原著事实和其可追溯证据一并交给复核器', () => {
    const snapshot: any = {
      targetPosition: 9,
      primaryAnchor: {
        kind: 'source_seam',
        summary: '原著边界',
        excerpt: '边界尾句',
        chapterId: null,
        position: null,
      },
      settingsSnapshot: { values: { targetChapterChars: 3000 } },
      storyMemory: { status: 'ready' },
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
          characters: [{ id: 2, canonicalName: '沈青', description: '剑客' }],
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
            { id: 10, title: '密令下落', summary: '线索未解' },
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
            {
              id: 9,
              title: '密令下落',
              description: '线索未解',
              status: 'active',
            },
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
          // Effective state keeps the Canon baseline for state fusion; it must
          // not make the writer receive this same fact a second time.
          plotThreads: [
            {
              id: 9,
              title: '密令下落',
              status: 'active',
              summary: '线索未解',
              sourceLayer: 'canon',
            },
          ],
          targetPosition: 9,
        },
        seam: { summary: '原著边界', excerpt: '边界尾句' },
        recentChapters: [],
        storyMemory: { summary: '', estimatedTokens: 0 },
        episodic: [],
        historicalDigests: [],
        style: null,
        supplements: [],
        userInstruction: '承接雁门之战',
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

    const plan: any = {
      chapterGoal: '承接雁门之战',
      centralConflict: '密令争夺',
      beats: [],
    };
    const planner = compilePlannerMessages(snapshot)[0].content;
    const writer = compileWriterMessages(snapshot, plan)[0].content;
    for (const prompt of [planner, writer]) {
      expect(prompt).toContain('【原著事实复核依据】');
      expect(prompt).toContain('沈青是陆川的师父');
      expect(prompt).toContain('雁门受伤');
      expect(prompt).toContain('尚未知晓密令内容');
      expect(prompt).toContain('雁门之战');
      expect(prompt).toContain('密令下落');
    }
    expect(writer.match(/密令下落/g)).toHaveLength(1);

    const repairSystem = compileRepairMessages(snapshot, '陆川令沈青复活。', [
      {
        severity: 'blocking',
        category: 'relationship',
        description: '人物关系冲突',
        generatedStart: 0,
        generatedEnd: 3,
        suggestedFix: '按师徒关系修改',
      } as any,
    ])[0].content;
    expect(repairSystem).toContain('【原著事实复核依据】');
    expect(repairSystem).toContain('沈青是陆川的师父');
  });
});
