/**
 * Elastic resource-library budget tests (Context-Budget elastic semantics).
 *
 * Covers the three fixes that put the resource library under the elastic
 * context controller instead of a fixed max-token injection cap:
 *   1. resolveElasticResourceBudget / resolveElasticResourceDemandShape —
 *      the configured resourceBudget is a soft target; plentiful windows
 *      borrow beyond it, tight windows shrink like the historical path.
 *   2. buildCharacterContext / buildWorldbookContext full-fit borrowing —
 *      per-item max_tokens only binds when the section budget is tight.
 *   3. buildContinuationSupplementContext full-fit borrowing — continuation
 *      supplements inject whole when the supplement budget covers demand.
 */
import {
  buildCharacterContext,
  buildWorldbookContext,
} from '../src/services/contextBuilder';
import { buildContinuationSupplementContext } from '../src/services/continuation/generation/continuationSupplementContextBuilder';
import { estimateTokens } from '../src/utils/tokenEstimator';

const LONG_CJK = '风'.repeat(4000); // 4000+ tokens per resource body




describe('buildCharacterContext elastic full-fit borrowing', () => {
  const characters = [
    {
      id: 1,
      name: 'A',
      max_tokens: 100, // soft cap far below natural size
      data_json: JSON.stringify({ data: { description: LONG_CJK } }),
    },
  ];

  it('injects the full card beyond max_tokens when the budget covers demand', async () => {
    const result = await buildCharacterContext(1, 100000, characters);
    expect(result.items[0].clipped).toBe(false);
    expect(result.items[0].included).toBe(true);
    expect(result.text).toContain(LONG_CJK);
    expect(result.items[0].reason).toContain('弹性借调');
  });

  it('falls back to the per-item soft cap when the budget is tight', async () => {
    const result = await buildCharacterContext(1, 200, characters);
    expect(result.items[0].clipped).toBe(true);
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(100);
  });
});

describe('buildWorldbookContext elastic full-fit borrowing', () => {
  const entries = [
    {
      id: 1,
      constant: 1,
      keyword_primary: '旧都',
      content: LONG_CJK,
      max_tokens: 100,
      collection_id: 0,
      collection_max_tokens: 100,
    },
  ];

  it('injects the whole entry beyond entry/collection caps when budget fits', async () => {
    const result = await buildWorldbookContext(1, 100000, '', true, entries);
    expect(result.items[0].clipped).toBe(false);
    expect(result.text).toContain(LONG_CJK);
    expect(result.items[0].reason).toContain('弹性借调');
  });

  it('still clips to the soft caps when the budget is tight', async () => {
    const result = await buildWorldbookContext(1, 200, '', true, entries);
    expect(result.items[0].clipped).toBe(true);
    // 100-token body cap + the 关键词 label prefix (~8 tokens).
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(120);
  });
});

jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: jest.fn(async () => ({
    executeSql: jest.fn(async () => [
      {
        rows: {
          length: 1,
          item: () => ({
            id: 1,
            name: 'A',
            max_tokens: 100,
            data_json: JSON.stringify({
              data: { description: '风'.repeat(4000) },
            }),
          }),
        },
      },
    ]),
  })),
}));

jest.mock('../src/data/repositories/continuationResourceBindingRepository', () => ({
  listContinuationResourceBindings: jest.fn(async () => [
    {
      resource_kind: 'character',
      resource_id: 1,
      continuation_usage: 'external_supplement',
      enabled_for_continuation: 1,
      sort_order: 0,
    },
  ]),
}));

describe('buildContinuationSupplementContext elastic full-fit borrowing', () => {
  it('injects the whole resource beyond max_tokens when budget covers demand', async () => {
    const bundle = await buildContinuationSupplementContext({
      projectId: 1,
      tokenBudget: 100000,
    });
    expect(bundle.selected).toHaveLength(1);
    expect(bundle.selected[0].selectionReason).toBe(
      'external_supplement_elastic_full_fit',
    );
    expect(bundle.characterText).toContain(LONG_CJK);
    expect(bundle.selected[0].estimatedTokens).toBeGreaterThan(4000);
  });

  it('keeps the per-item cap when the supplement budget is tight', async () => {
    const bundle = await buildContinuationSupplementContext({
      projectId: 1,
      tokenBudget: 150,
    });
    expect(bundle.selected[0].selectionReason).toBe(
      'external_supplement_enabled_and_within_stage_budget',
    );
    expect(bundle.selected[0].estimatedTokens).toBeLessThanOrEqual(100);
  });
});
