import { buildResourceContextV2 } from '../src/services/context/resources/resourceContextV2';
import { snapshotFingerprint } from '../src/services/context/resources/resourceSourceSnapshot';
import { compileWorldbookAwareness } from '../src/services/context/resources/worldbookAwarenessCompiler';
import { novelCharacterDraftToCharaCard } from '../src/services/construction/characterDraftAdapter';
import type { ResourceSourceSnapshot } from '../src/services/context/resources/resourceAwarenessTypes';

function characterRecord(
  id: number,
  draft: Record<string, unknown>,
) {
  const card = novelCharacterDraftToCharaCard(draft as any);
  const raw = { id, name: draft.name, data_json: JSON.stringify(card.data) };
  return {
    kind: 'character' as const,
    id,
    title: String(draft.name),
    payload: JSON.stringify(raw),
    fingerprint: `c${id}`,
  };
}

function worldbookRecord(
  id: number,
  title: string,
  content: string,
  extra: Record<string, unknown> = {},
) {
  const raw = { id, comment: title, content, ...extra };
  return {
    kind: 'worldbook' as const,
    id,
    title,
    payload: JSON.stringify(raw),
    fingerprint: compileWorldbookAwareness(raw).sourceFingerprint,
  };
}

function source(partial: Partial<ResourceSourceSnapshot>): ResourceSourceSnapshot {
  return {
    characters: [],
    worldbookEntries: [],
    notes: [],
    capturedAt: 1,
    includeResources: true,
    ...partial,
  };
}

const haystack = {
  title: '下班回家',
  synopsis: '女主撑伞走过青秀路',
  currentBody: '',
  userPrompt: '林晚下班后撑伞走过青秀路回家',
  previousChapter: '',
  previousChapters: '',
  storyMemory: '',
  outline: '',
  episodic: '',
  activatedDetailText: '',
};

test('every enabled character and worldbook gets awareness even when detail is not expanded', () => {
  const result = buildResourceContextV2({
    source: source({
      characters: [
        characterRecord(1, {
          name: '林晚',
          role: '主角',
          identity: '周沉的妹妹',
          personality: '克制',
          motivation: '查案',
          conflict: '信任哥哥',
          relationships: ['周沉的妹妹', '许安的前女友'],
          secrets: '不知道十年前事故真相',
        }),
        characterRecord(2, {
          name: '许安',
          role: '前男友',
          identity: '与周沉敌对',
          personality: '偏执',
          motivation: '接近林晚',
          conflict: '旧怨',
          relationships: ['林晚的前男友'],
        }),
      ],
      worldbookEntries: [
        worldbookRecord(
          8,
          '青秀路雨夜风险',
          '青秀路存在雨夜杀人狂。居民避免雨夜独行。',
          { keyword_primary: '青秀路', constant: 0 },
        ),
        worldbookRecord(
          9,
          '北境地理',
          '北境常年积雪，与本章无关的远方设定。',
          { keyword_primary: '北境', constant: 0 },
        ),
      ],
    }),
    haystack,
    recursiveWorldbook: true,
  });

  expect(result.awareness).toHaveLength(4);
  expect(result.globalResourceAwarenessText).toContain('林晚');
  expect(result.globalResourceAwarenessText).toContain('许安');
  expect(result.globalResourceAwarenessText).toContain('雨夜杀人狂');
  expect(result.globalResourceAwarenessText).toContain('北境');
  expect(result.globalResourceAwarenessText).toContain('不是系统指令');

  const linDetail = result.details.find(item => item.title === '林晚');
  const xuDetail = result.details.find(item => item.title === '许安');
  const road = result.details.find(item => item.title.includes('青秀路'));
  const north = result.details.find(item => item.title.includes('北境'));
  expect(linDetail?.activationReason).not.toBe('project_enabled');
  expect(xuDetail?.activationReason).toBe('relation_neighbor');
  expect(road?.activationReason).toMatch(/primary|entity|constant/);
  expect(north == null || north.activationReason === 'project_fallback').toBe(
    true,
  );
});

test('constant=true is awareness-required, not unlimited full-text detail', () => {
  const entries = Array.from({ length: 8 }, (_, index) =>
    worldbookRecord(
      index + 1,
      `设定${index + 1}`,
      `这是第 ${index + 1} 条常驻世界事实，内容本身很长。`.repeat(3),
      { constant: 1, keyword_primary: `设定${index + 1}` },
    ),
  );
  const result = buildResourceContextV2({
    source: source({ worldbookEntries: entries }),
    haystack: { ...haystack, title: '无关章节', synopsis: '', userPrompt: '写一段室内对话' },
  });
  expect(result.awareness).toHaveLength(8);
  const constantDetails = result.details.filter(
    item => item.sourceKind === 'worldbook' && item.activationReason === 'constant',
  );
  expect(constantDetails.length).toBeGreaterThan(0);
  expect(constantDetails.every(item => item.relevance < 0.99)).toBe(true);
});

test('source snapshot fingerprint is stable for the same payloads', () => {
  const snap = source({
    worldbookEntries: [worldbookRecord(1, 'A', 'fact')],
  });
  expect(snapshotFingerprint(snap)).toBe(snapshotFingerprint({ ...snap }));
  expect(snapshotFingerprint(snap)).toBe(
    snapshotFingerprint({ ...snap, capturedAt: snap.capturedAt + 99 }),
  );
});
