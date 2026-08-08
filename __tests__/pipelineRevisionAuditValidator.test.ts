/**
 * Revision audit validator V2 — Review V2 / FactCheck V2 contracts
 * (V5-Lite Phase 2). Scope/anchor/hash validation, leak detection,
 * normalized stable output (§18.4 / §18.5).
 */
import {
  validateFactCheckV2Result,
  validateReviewV2Result,
} from '../src/services/pipeline/revisionAuditValidator';
import {
  buildRevisionAnchors,
  canonicalizeDraft,
  computeDraftHash,
} from '../src/services/pipeline/revisionAnchors';
import type { LLMResult } from '../src/services/llm/types';

const DRAFT = '主角走进了森林。\n\n他在溪边遇到了老者。';
const CANONICAL = canonicalizeDraft(DRAFT);
const HASH = computeDraftHash(CANONICAL);
const ANCHORS = buildRevisionAnchors(CANONICAL);

function llm(json: unknown, finishReason: string = 'stop'): LLMResult {
  return {
    text: JSON.stringify(json),
    reasoningText: null,
    finishReason,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function validReview(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    draftHash: HASH,
    requiredCorrections: [
      {
        id: 'r1',
        scope: 'anchor',
        anchorId: 'draft-p-002',
        dimension: '人物表现',
        severity: 'required',
        diagnosis: '老者语气生硬',
        rewriteGoal: '让老者语气更温和',
        preserveMeaning: ['老者身份不变'],
      },
      {
        id: 'r2',
        scope: 'chapter',
        dimension: '大纲执行',
        severity: 'hard',
        diagnosis: '缺少相遇节点',
        rewriteGoal: '补上相遇节点',
        preserveMeaning: [],
      },
      {
        id: 'r3',
        scope: 'insertion',
        insertionAfterAnchorId: 'draft-p-001',
        dimension: '情绪递进',
        severity: 'warning',
        diagnosis: '可补充环境描写',
        rewriteGoal: '加入风吹树叶的描写',
        preserveMeaning: [],
      },
    ],
    protectedAnchorIds: ['draft-p-001'],
    outlineExecution: {
      fulfilledBeats: ['抵达溪边'],
      missingBeats: [],
      deviations: [],
      prematureBeats: [],
      mustPreserve: ['老者身份'],
      endingGoal: '达成相遇',
      mustNotAdvance: ['不得提前揭示身份'],
    },
  };
}

/** Test helper: cast the corrections array for mutation. */
function correctionsOf(
  report: Record<string, unknown>,
): Array<Record<string, any>> {
  return report.requiredCorrections as Array<Record<string, any>>;
}

function validFactCheck(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    draftHash: HASH,
    requiredCorrections: [
      {
        id: 'f1',
        scope: 'anchor',
        anchorId: 'draft-p-001',
        dimension: '连续性',
        severity: 'hard',
        diagnosis: '主角此前未带水壶',
        rewriteGoal: '改为不喝水或补上水壶伏笔',
        preserveMeaning: [],
      },
    ],
    protectedFacts: ['老者是守林人'],
    hardConstraints: ['森林里没有城市'],
  };
}

describe('validateReviewV2Result', () => {
  test('accepts a well-formed anchored report', () => {
    const v = validateReviewV2Result({
      result: llm(validReview()),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(true);
    expect(v.report?.schemaVersion).toBe(2);
    expect(v.report?.requiredCorrections).toHaveLength(3);
    expect(v.report?.outlineExecution.mustNotAdvance).toEqual([
      '不得提前揭示身份',
    ]);
  });

  test('rejects wrong draftHash', () => {
    const report = validReview();
    report.draftHash = 'deadbeef';
    const v = validateReviewV2Result({
      result: llm(report),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('missing_required_fields');
  });

  test('rejects schemaVersion !== 2', () => {
    const report = validReview();
    report.schemaVersion = 1;
    const v = validateReviewV2Result({
      result: llm(report),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
  });

  test('rejects unknown top-level fields', () => {
    const report = validReview();
    (report as any).extraField = 'x';
    const v = validateReviewV2Result({
      result: llm(report),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
    expect(v.details).toContain('不允许的顶层字段');
  });

  test('rejects anchor scope without existing anchorId', () => {
    const report = validReview();
    (correctionsOf(report)[0] as any).anchorId = 'draft-p-999';
    const v = validateReviewV2Result({
      result: llm(report),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
    expect(v.details).toContain('需要存在的 anchorId');
  });

  test('rejects range scope with a single anchorId', () => {
    const report = validReview();
    report.requiredCorrections = [
      {
        id: 'r9',
        scope: 'range',
        anchorIds: ['draft-p-001'],
        dimension: '顺序',
        severity: 'required',
        diagnosis: '顺序问题',
        rewriteGoal: '调整顺序',
        preserveMeaning: [],
      },
    ];
    const v = validateReviewV2Result({
      result: llm(report),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
    expect(v.details).toContain('至少两个');
  });

  test('rejects insertion scope without locators', () => {
    const report = validReview();
    report.requiredCorrections = [
      {
        id: 'r10',
        scope: 'insertion',
        dimension: '插入',
        severity: 'required',
        diagnosis: '缺插入点',
        rewriteGoal: '插入',
        preserveMeaning: [],
      },
    ];
    const v = validateReviewV2Result({
      result: llm(report),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
    expect(v.details).toContain('before/after');
  });

  test('rejects chapter scope carrying anchors', () => {
    const report = validReview();
    (correctionsOf(report)[1] as any).anchorId = 'draft-p-001';
    const v = validateReviewV2Result({
      result: llm(report),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
    expect(v.details).toContain('不得携带 anchor');
  });

  test('rejects boundary scope with wrong boundary value', () => {
    const report = validReview();
    report.requiredCorrections = [
      {
        id: 'r11',
        scope: 'boundary',
        boundary: 'middle',
        dimension: '边界',
        severity: 'required',
        diagnosis: '边界问题',
        rewriteGoal: '修正边界',
        preserveMeaning: [],
      },
    ];
    const v = validateReviewV2Result({
      result: llm(report),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
    expect(v.details).toContain('boundary');
  });

  test('rejects required correction with empty rewriteGoal', () => {
    const report = validReview();
    const bad = {
      id: 'r12',
      scope: 'chapter',
      dimension: '大纲',
      severity: 'hard',
      diagnosis: '问题',
      rewriteGoal: '   ',
      preserveMeaning: [],
    };
    report.requiredCorrections = [bad];
    const v = validateReviewV2Result({
      result: llm(report),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
    expect(v.details).toContain('缺少 rewriteGoal');
  });

  test('rejects unknown correction fields (excerpt / offsets)', () => {
    const report = validReview();
    (correctionsOf(report)[0] as any).excerpt = '整段正文';
    (correctionsOf(report)[0] as any).start = 0;
    const v = validateReviewV2Result({
      result: llm(report),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
    expect(v.details).toContain('含未知字段');
  });

  test('rejects protectedAnchorIds referencing missing anchors', () => {
    const report = validReview();
    report.protectedAnchorIds = ['draft-p-999'];
    const v = validateReviewV2Result({
      result: llm(report),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
  });

  test('rejects full draft echo in a string leaf', () => {
    const report = validReview();
    (correctionsOf(report)[0] as any).diagnosis = DRAFT;
    const v = validateReviewV2Result({
      result: llm(report),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('draft_echo');
  });

  test('rejects anchor-marker leak', () => {
    const report = validReview();
    (correctionsOf(report)[0] as any).diagnosis = '请看[draft-p-001]处';
    const v = validateReviewV2Result({
      result: llm(report),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
    expect(v.details).toContain('锚点标记');
  });

  test('rejects prompt leak', () => {
    const report = validReview();
    (correctionsOf(report)[0] as any).diagnosis = '你是终审校对员吗？';
    const v = validateReviewV2Result({
      result: llm(report),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
    expect(v.details).toContain('提示词');
  });

  test('rejects reasoning-only output', () => {
    const v = validateReviewV2Result({
      result: {
        text: '',
        reasoningText: '思考了很久',
        finishReason: 'stop',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('reasoning_only');
  });

  test('rejects <think> leak inside text', () => {
    const v = validateReviewV2Result({
      result: {
        text: '<think>内部推理</think>' + JSON.stringify(validReview()),
        reasoningText: null,
        finishReason: 'stop',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
    expect(v.details).toContain('<think>');
  });

  test('normalized output has stable field order', () => {
    const v1 = validateReviewV2Result({
      result: llm(validReview()),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    const v2 = validateReviewV2Result({
      result: llm(validReview()),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v1.normalizedText).toBe(v2.normalizedText);
    expect(v1.normalizedText).toBe(JSON.stringify(v1.report));
  });
});

describe('validateFactCheckV2Result', () => {
  test('accepts a well-formed report', () => {
    const v = validateFactCheckV2Result({
      result: llm(validFactCheck()),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(true);
    expect(v.report?.hardConstraints).toEqual(['森林里没有城市']);
    expect(v.report?.requiredCorrections[0].anchorId).toBe('draft-p-001');
  });

  test('rejects wrong hash', () => {
    const report = validFactCheck();
    report.draftHash = 'nope';
    const v = validateFactCheckV2Result({
      result: llm(report),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
  });

  test('rejects unknown top-level field', () => {
    const report = validFactCheck();
    (report as any).confirmed = [];
    const v = validateFactCheckV2Result({
      result: llm(report),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
  });

  test('rejects oversized corrections array', () => {
    const report = validFactCheck();
    const one = correctionsOf(report)[0];
    report.requiredCorrections = Array(61).fill(one);
    const v = validateFactCheckV2Result({
      result: llm(report),
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('oversized_report');
  });

  test('rejects pure prose (no JSON)', () => {
    const v = validateFactCheckV2Result({
      result: {
        text: '这段正文完全复述了主角走进了森林的故事内容……'.repeat(20),
        reasoningText: null,
        finishReason: 'stop',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      canonicalDraft: CANONICAL,
      expectedHash: HASH,
      anchors: ANCHORS,
    });
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('novel_output');
  });
});
