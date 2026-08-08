/**
 * Revision Contract Compiler tests (V5-Lite Phase 4).
 * Deterministic priority, dedup, fail-closed, anchor backfill, contract hash.
 */
import {
  compileRevisionContract,
  REVISION_CONTRACT_COMPILER_VERSION,
  REVISION_CONTRACT_SCHEMA_VERSION,
} from '../src/services/pipeline/revisionContract';
import {
  buildRevisionAnchors,
  canonicalizeDraft,
  computeDraftHash,
} from '../src/services/pipeline/revisionAnchors';
import type {
  PipelineAuditCorrectionV2,
  PipelineFactCheckReportV2,
  PipelineReviewReportV2,
} from '../src/types/pipelineRevision';

const DRAFT = '主角走进了森林。\n\n他在溪边遇到了老者。\n\n老者警告他不要靠近古井。';
const CANONICAL = canonicalizeDraft(DRAFT);
const HASH = computeDraftHash(CANONICAL);
const ANCHORS = buildRevisionAnchors(CANONICAL);

function correction(partial: Partial<PipelineAuditCorrectionV2> & Pick<PipelineAuditCorrectionV2, 'id' | 'scope' | 'severity'>): PipelineAuditCorrectionV2 {
  return {
    dimension: '大纲执行',
    diagnosis: '诊断',
    rewriteGoal: '目标',
    preserveMeaning: [],
    ...partial,
  };
}

function review(overrides?: Partial<PipelineReviewReportV2>): PipelineReviewReportV2 {
  return {
    schemaVersion: 2,
    draftHash: HASH,
    requiredCorrections: [
      correction({
        id: 'r1',
        scope: 'chapter',
        severity: 'hard',
        dimension: '大纲执行',
        diagnosis: '缺少相遇节点',
        rewriteGoal: '补上相遇',
      }),
      correction({
        id: 'r2',
        scope: 'anchor',
        anchorId: 'draft-p-002',
        severity: 'required',
        dimension: '文学',
        diagnosis: '老者语气生硬',
        rewriteGoal: '语气温和',
      }),
    ],
    protectedAnchorIds: ['draft-p-001'],
    outlineExecution: {
      fulfilledBeats: ['抵达溪边'],
      missingBeats: ['相遇'],
      deviations: [],
      prematureBeats: [],
      mustPreserve: ['老者身份'],
      endingGoal: '达成警告',
      mustNotAdvance: ['不得揭示古井秘密'],
    },
    ...overrides,
  };
}

function factCheck(overrides?: Partial<PipelineFactCheckReportV2>): PipelineFactCheckReportV2 {
  return {
    schemaVersion: 2,
    draftHash: HASH,
    requiredCorrections: [
      correction({
        id: 'f1',
        scope: 'anchor',
        anchorId: 'draft-p-003',
        severity: 'hard',
        dimension: '连续性',
        diagnosis: '古井位置与前面不符',
        rewriteGoal: '统一位置',
      }),
    ],
    protectedFacts: ['老者是守林人'],
    hardConstraints: ['古井在森林深处'],
    ...overrides,
  };
}

describe('compileRevisionContract', () => {
  test('contract carries draftHash + stable schema versions', () => {
    const r = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      review: review(),
      factCheck: factCheck(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contract.draftHash).toBe(HASH);
    expect(r.contract.schemaVersion).toBe(REVISION_CONTRACT_SCHEMA_VERSION);
    expect(r.contract.compilerVersion).toBe(REVISION_CONTRACT_COMPILER_VERSION);
  });

  test('deterministic priority: fact hard constraint before outline before literary', () => {
    const r = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      review: review(),
      factCheck: factCheck({
        requiredCorrections: [
          correction({
            id: 'f1',
            scope: 'anchor',
            anchorId: 'draft-p-003',
            severity: 'hard',
            dimension: '事实硬约束',
            diagnosis: '古井位置与前面不符',
            rewriteGoal: '统一位置',
          }),
        ],
      }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // f1 (hard, 事实) first; r1 (hard, 大纲) next; r2 (required, 文学) last.
    expect(r.contract.workItems.map(w => w.id)).toEqual(['f1', 'r1', 'r2']);
  });

  test('fixed merge order: factCheck before review on equal priority', () => {
    const rev = review({
      requiredCorrections: [
        correction({
          id: 'rA',
          scope: 'anchor',
          anchorId: 'draft-p-001',
          severity: 'hard',
          dimension: '连续性',
          diagnosis: 'x',
          rewriteGoal: 'y',
        }),
      ],
    });
    const fact = factCheck({
      requiredCorrections: [
        correction({
          id: 'fA',
          scope: 'anchor',
          anchorId: 'draft-p-001',
          severity: 'hard',
          dimension: '连续性',
          diagnosis: 'z',
          rewriteGoal: 'w',
        }),
      ],
    });
    const r = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      review: rev,
      factCheck: fact,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contract.workItems.map(w => w.id)).toEqual(['fA', 'rA']);
  });

  test('exact duplicate corrections are deduped', () => {
    const dup = correction({
      id: 'fDup',
      scope: 'anchor',
      anchorId: 'draft-p-003',
      severity: 'hard',
      dimension: '连续性',
      diagnosis: '古井位置与前面不符',
      rewriteGoal: '统一位置',
    });
    const fact = factCheck({
      requiredCorrections: [factCheck().requiredCorrections[0], dup],
    });
    const r = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      factCheck: fact,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // f1 and fDup are structurally identical → single work item.
    expect(r.contract.workItems).toHaveLength(1);
  });

  test('workItems backfill real anchor text/start/end', () => {
    const r = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      review: review(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const anchorItem = r.contract.workItems.find(w => w.id === 'r2');
    expect(anchorItem?.anchors?.[0]).toMatchObject({
      id: 'draft-p-002',
      start: ANCHORS[1].start,
      end: ANCHORS[1].end,
    });
    expect(anchorItem?.anchors?.[0].text).toBe('他在溪边遇到了老者。');
  });

  test('range/insertion scopes preserve locators and backfill', () => {
    const rev = review({
      requiredCorrections: [
        correction({
          id: 'rR',
          scope: 'range',
          anchorIds: ['draft-p-001', 'draft-p-002'],
          severity: 'required',
          dimension: '顺序',
          diagnosis: '顺序颠倒',
          rewriteGoal: '调整顺序',
        }),
        correction({
          id: 'rI',
          scope: 'insertion',
          insertionAfterAnchorId: 'draft-p-002',
          severity: 'warning',
          dimension: '文风',
          diagnosis: '可加描写',
          rewriteGoal: '加一句',
        }),
      ],
    });
    const r = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      review: rev,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rangeItem = r.contract.workItems.find(w => w.id === 'rR');
    expect(rangeItem?.anchors).toHaveLength(2);
    expect(rangeItem?.anchors?.map(a => a.id)).toEqual([
      'draft-p-001',
      'draft-p-002',
    ]);
    const insertItem = r.contract.workItems.find(w => w.id === 'rI');
    expect(insertItem?.insertionAfterAnchorId).toBe('draft-p-002');
    expect(insertItem?.anchors?.[0].id).toBe('draft-p-002');
  });

  test('single-audit compile (twoStage: review only)', () => {
    const r = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      review: review(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contract.workItems.map(w => w.id)).toEqual(['r1', 'r2']);
    expect(r.contract.factCheckHash).toBeUndefined();
    expect(r.contract.protectedFacts).toEqual([]);
  });

  test('single-audit compile (conditional: factCheck only)', () => {
    const r = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      factCheck: factCheck(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contract.workItems.map(w => w.id)).toEqual(['f1']);
    expect(r.contract.reviewHash).toBeUndefined();
    expect(r.contract.protectedFacts).toEqual(['老者是守林人']);
    expect(r.contract.hardConstraints).toEqual(['古井在森林深处']);
  });

  test('protected anchors come ONLY from report-declared protection', () => {
    const r = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      review: review(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // review().protectedAnchorIds = ['draft-p-001']; r2's anchor (draft-p-002)
    // is a revision TARGET and must NOT auto-join the protection set.
    expect(r.contract.protectedAnchorIds).toEqual(['draft-p-001']);
    expect(r.contract.protectedAnchorIds).not.toContain('draft-p-002');
  });

  test('factCheck hard revision overlapping review protection wins (fact-first)', () => {
    const r = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      review: review(),
      factCheck: factCheck({
        requiredCorrections: [
          correction({
            id: 'fA',
            scope: 'anchor',
            anchorId: 'draft-p-001',
            severity: 'hard',
            dimension: '事实硬约束',
            diagnosis: '位置错误',
            rewriteGoal: '修正位置',
          }),
        ],
      }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contract.protectedAnchorIds).not.toContain('draft-p-001');
    expect(
      r.warnings.some(w => w.includes('draft-p-001') && w.includes('事实修订优先')),
    ).toBe(true);
  });

  test('review protection survives when factCheck targets other anchors', () => {
    const r = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      review: review(),
      factCheck: factCheck(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // factCheck() hard-revises draft-p-003; review protects draft-p-001.
    expect(r.contract.protectedAnchorIds).toEqual(['draft-p-001']);
    expect(r.warnings.some(w => w.includes('事实修订优先'))).toBe(false);
  });

  test('factCheck warning-level overlap does NOT drop protection', () => {
    const r = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      review: review(),
      factCheck: factCheck({
        requiredCorrections: [
          correction({
            id: 'fW',
            scope: 'anchor',
            anchorId: 'draft-p-001',
            severity: 'warning',
            dimension: '文风',
            diagnosis: '可润色',
            rewriteGoal: '微调',
          }),
        ],
      }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contract.protectedAnchorIds).toEqual(['draft-p-001']);
  });

  test('outline obligations flow from review', () => {
    const r = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      review: review(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contract.outlineObligations).toMatchObject({
      fulfilledBeats: ['抵达溪边'],
      missingBeats: ['相遇'],
      mustPreserve: ['老者身份'],
      endingGoal: '达成警告',
      mustNotAdvance: ['不得揭示古井秘密'],
    });
  });

  test('fail-closed: invalid required anchor drops the whole audit side', () => {
    const bad = review({
      requiredCorrections: [
        correction({
          id: 'rBad',
          scope: 'anchor',
          anchorId: 'draft-p-999',
          severity: 'required',
          dimension: '文学',
          diagnosis: 'x',
          rewriteGoal: 'y',
        }),
      ],
    });
    // Review side invalid → compile from factCheck side only.
    const r = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      review: bad,
      factCheck: factCheck(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contract.workItems.map(w => w.id)).toEqual(['f1']);
    expect(r.warnings.some(w => w.includes('整侧失效'))).toBe(true);
  });

  test('fail-closed: both sides invalid → no contract', () => {
    const badReview = review({
      requiredCorrections: [
        correction({
          id: 'rBad',
          scope: 'anchor',
          anchorId: 'draft-p-999',
          severity: 'hard',
          dimension: '文学',
          diagnosis: 'x',
          rewriteGoal: 'y',
        }),
      ],
    });
    const badFact = factCheck({
      requiredCorrections: [
        correction({
          id: 'fBad',
          scope: 'range',
          anchorIds: ['draft-p-001'],
          severity: 'required',
          dimension: '连续性',
          diagnosis: 'x',
          rewriteGoal: 'y',
        }),
      ],
    });
    const r = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      review: badReview,
      factCheck: badFact,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no_valid_audit');
  });

  test('warning with invalid locator is dropped, not fatal', () => {
    const rev = review({
      requiredCorrections: [
        correction({
          id: 'rW',
          scope: 'anchor',
          anchorId: 'draft-p-999',
          severity: 'warning',
          dimension: '文风',
          diagnosis: '轻微建议',
          rewriteGoal: '',
        }),
        review().requiredCorrections[0],
      ],
    });
    const r = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      review: rev,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contract.workItems.map(w => w.id)).toEqual(['r1']);
    expect(r.warnings.some(w => w.includes('丢弃非法定位的 warning'))).toBe(true);
  });

  test('same input → identical contract (determinism)', () => {
    const a = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      review: review(),
      factCheck: factCheck(),
    });
    const b = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      review: review(),
      factCheck: factCheck(),
    });
    expect(a).toEqual(b);
    if (!a.ok || !b.ok) return;
    expect(JSON.stringify(a.contract)).toBe(JSON.stringify(b.contract));
  });

  test('contract hash equals sha256 of canonical draft', () => {
    const r = compileRevisionContract({
      canonicalDraft: CANONICAL,
      anchors: ANCHORS,
      factCheck: factCheck(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contract.draftHash).toBe(HASH);
  });
});
