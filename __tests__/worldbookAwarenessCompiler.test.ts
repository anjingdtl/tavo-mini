import { compileWorldbookAwareness } from '../src/services/context/resources/worldbookAwarenessCompiler';

const QINGXIU = {
  id: 8,
  comment: '青秀路雨夜风险',
  category: '地点',
  keyword_primary: '青秀路',
  keyword_secondary: '雨夜',
  content:
    '青秀路存在雨夜杀人狂。居民避免雨夜独行。警方夜间加强巡逻，凶手尚未落网。',
  constant: 0,
};

test('P0 worldbook awareness uses full source when no reliable capsule exists', () => {
  const capsule = compileWorldbookAwareness(QINGXIU);
  expect(capsule.fallbackMode).toBe('full_source_protected');
  expect(capsule.awarenessText).toContain('青秀路存在雨夜杀人狂');
  expect(capsule.awarenessText).toContain('居民避免雨夜独行');
  expect(capsule.constraintClasses).toEqual(
    expect.arrayContaining(['persistent_fact']),
  );
});

test('constant=false entries still produce global awareness', () => {
  const capsule = compileWorldbookAwareness({ ...QINGXIU, constant: false });
  expect(capsule.awarenessText).toContain('青秀路');
  expect(capsule.estimatedTokens).toBeGreaterThan(0);
});

test('stale awareness_hint is ignored after content changes', () => {
  const stale = compileWorldbookAwareness({
    ...QINGXIU,
    awareness_hint: '这里只是一条过期摘要，完全没提到杀人狂',
    hint_content_fingerprint: 'not-the-current-hash',
  });
  expect(stale.fallbackMode).toBe('full_source_protected');
  expect(stale.awarenessText).toContain('杀人狂');
});

test('matching awareness_hint may be used as cached summary', () => {
  const first = compileWorldbookAwareness(QINGXIU);
  const hinted = compileWorldbookAwareness({
    ...QINGXIU,
    awareness_hint: '青秀路雨夜存在连环杀人风险，居民避免独行。',
    hint_content_fingerprint: first.sourceFingerprint,
  });
  expect(hinted.fallbackMode).toBe('cached_summary');
  expect(hinted.awarenessText).toContain('连环杀人风险');
});

test('world-rule language is classified', () => {
  const capsule = compileWorldbookAwareness({
    id: 2,
    comment: '魔法规则',
    content: '魔法不能真正复活死亡者。这是硬性规则。',
  });
  expect(capsule.constraintClasses).toContain('world_rule');
});
