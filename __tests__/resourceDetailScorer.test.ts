import {
  applyRelationNeighborBoost,
  scoreCharacterActivation,
  scoreWorldbookActivation,
} from '../src/services/context/resources/resourceDetailScorer';
import { novelCharacterDraftToCharaCard } from '../src/services/construction/characterDraftAdapter';
import type { ResourceDetailCandidate } from '../src/services/context/resources/resourceAwarenessTypes';

function characterRaw(id: number, name: string, extra: Record<string, unknown> = {}) {
  const card = novelCharacterDraftToCharaCard({
    name,
    role: extra.role as string,
    relationships: extra.relationships as string[],
    aliases: extra.aliases as string[],
  } as any);
  return { id, name, data_json: JSON.stringify(card.data) };
}

const emptyHaystack = {
  title: '',
  synopsis: '',
  currentBody: '',
  userPrompt: '',
  previousChapter: '',
  storyMemory: '',
  outline: '',
  episodic: '',
};

test('title / prompt / body hits outrank merely-enabled characters', () => {
  const raw = characterRaw(1, '林晚');
  const enabled = scoreCharacterActivation(raw, emptyHaystack);
  const titled = scoreCharacterActivation(raw, {
    ...emptyHaystack,
    title: '林晚借车',
  });
  const prompted = scoreCharacterActivation(raw, {
    ...emptyHaystack,
    userPrompt: '写林晚下班回家',
  });
  expect(enabled.reason).toBe('project_enabled');
  expect(titled.relevance).toBeGreaterThan(enabled.relevance);
  expect(prompted.relevance).toBeGreaterThan(enabled.relevance);
});

test('relation-neighbor boosts an unmentioned related character without requiring detail', () => {
  const details: ResourceDetailCandidate[] = [
    {
      id: 'character-detail:1',
      sourceKind: 'character',
      sourceId: 1,
      title: '林晚',
      content: '林晚详情',
      actualTokens: 100,
      activationReason: 'user_prompt_hit',
      relevance: 0.97,
      explicitSelected: true,
      sourceOrder: 0,
    },
    {
      id: 'character-detail:2',
      sourceKind: 'character',
      sourceId: 2,
      title: '许安',
      content: '许安详情',
      actualTokens: 80,
      activationReason: 'project_enabled',
      relevance: 0.18,
      explicitSelected: false,
      sourceOrder: 1,
    },
  ];
  const boosted = applyRelationNeighborBoost(
    details,
    new Map([[1, ['许安的前女友']], [2, ['林晚的前男友']]]),
    new Map([
      [1, ['林晚']],
      [2, ['许安']],
    ]),
  );
  const xu = boosted.find(item => item.sourceId === 2)!;
  expect(xu.activationReason).toBe('relation_neighbor');
  expect(xu.relevance).toBeGreaterThan(0.18);
});

test('worldbook reason scores keep zero-hit fallback lowest', () => {
  expect(scoreWorldbookActivation('primary_secondary_hit')).toBeGreaterThan(
    scoreWorldbookActivation('primary_hit'),
  );
  expect(scoreWorldbookActivation('project_fallback')).toBeLessThan(
    scoreWorldbookActivation('recursive_hit'),
  );
});
