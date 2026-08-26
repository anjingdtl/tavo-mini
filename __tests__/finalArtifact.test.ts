/* eslint-env jest */
/**
 * Red Test：Final Artifact 一等公民（B1）。
 *
 * 不新增 LLM Stage、不新增第二持久化真相：Final 由现有 Stage Artifact /
 * Persisted Chapter 重建。本测试锁定：
 *
 *  1. 统一字数口径 measureWritingCharStats（B3 全 App 使用）；
 *  2. FinalArtifactSummary 构建规则：QA Pass → sourceKind=draft 且
 *     revisionApplied=false；Revision 生效 → sourceKind=revision 且
 *     revisionApplied=true；draft 不可得 → unknown；
 *  3. 指纹：draftBodyFingerprint / bodyFingerprint；
 *  4. attachWritingFinalArtifact 挂载到 trace（幂等，无正文冗余）。
 */
import { sha256Hex } from '../src/services/continuation/hashUtils';
import {
  measureWritingCharStats,
  buildFinalArtifactSummary,
  attachWritingFinalArtifact,
  resolveFinalSourceKind,
  type FinalArtifactSummary,
} from '../src/services/writing/finalArtifact';
import type { WritingKernelTrace } from '../src/services/writing/contracts/frozenWritingContext';

describe('measureWritingCharStats：统一字数口径', () => {
  it('中文按字符计：含空白与去空白分开统计', () => {
    const stats = measureWritingCharStats('第一章 甲\n正文甲。\n\n正文乙。  ');
    // 字符：第一章(3) 空格(1) 甲(1) \n(1) 正文甲。(4) \n(1) \n(1) 正文乙。(4) 空格(2) = 18
    expect(stats.charCount).toBe(18);
    // 去空白：第一章甲正文甲。正文乙。 = 12
    expect(stats.nonWhitespaceCharCount).toBe(12);
    // 非空段落：第一章 甲 / 正文甲。 / 正文乙。 = 3
    expect(stats.paragraphCount).toBe(3);
  });

  it('空串与纯空白', () => {
    const empty = measureWritingCharStats('');
    expect(empty.charCount).toBe(0);
    expect(empty.nonWhitespaceCharCount).toBe(0);
    expect(empty.paragraphCount).toBe(0);
    const ws = measureWritingCharStats('   \n  \n');
    expect(ws.nonWhitespaceCharCount).toBe(0);
    expect(ws.paragraphCount).toBe(0);
  });

  it('全角空格与标点不误计', () => {
    const stats = measureWritingCharStats('　　段落开头的全角空。\n第二段。');
    const joined = '　　段落开头的全角空。\n第二段。';
    const nonWs = (joined.match(/\S/g) || []).length;
    expect(stats.nonWhitespaceCharCount).toBe(nonWs);
  });
});

describe('resolveFinalSourceKind：最终稿来源判定', () => {
  it('Final == Draft → draft（QA Pass，0 次额外 LLM）', () => {
    const body = '第一章 正文。\n第二段。';
    expect(resolveFinalSourceKind(body, body)).toBe('draft');
  });

  it('Final != Draft → revision（QA Needs Revision 已应用）', () => {
    const draft = '正文甲。';
    const final = '正文甲，并补充关键信息。';
    expect(resolveFinalSourceKind(draft, final)).toBe('revision');
  });
});

describe('buildFinalArtifactSummary', () => {
  const base = {
    chapterId: 7,
    generationTraceId: 'gt-b1-test-0001',
    qualityProfile: 'standard' as const,
  };

  it('QA Pass：Final = Draft，revisionApplied=false，双指纹一致', () => {
    const body = '第一章 正文。\n第二段。';
    const summary = buildFinalArtifactSummary({
      ...base,
      draftBody: body,
      finalBody: body,
      finalizedAt: '2026-08-26T00:00:00.000Z',
    });

    expect(summary.sourceKind).toBe('draft');
    expect(summary.revisionApplied).toBe(false);
    expect(summary.bodyFingerprint).toBe(sha256Hex(body));
    expect(summary.draftBodyFingerprint).toBe(sha256Hex(body));
    expect(summary.bodyFingerprint).toBe(summary.draftBodyFingerprint);
    expect(summary.charStats.charCount).toBe(body.length);
    expect(summary.qualityProfile).toBe('standard');
    expect(summary.chapterId).toBe(7);
  });

  it('Revision 已应用：Final != Draft，revisionApplied=true', () => {
    const draft = '正文甲。';
    const final = '正文甲，修正时间线。';
    const summary = buildFinalArtifactSummary({
      ...base,
      draftBody: draft,
      finalBody: final,
      finalizedAt: '2026-08-26T00:00:00.000Z',
    });

    expect(summary.sourceKind).toBe('revision');
    expect(summary.revisionApplied).toBe(true);
    expect(summary.bodyFingerprint).toBe(sha256Hex(final));
    expect(summary.draftBodyFingerprint).toBe(sha256Hex(draft));
    expect(summary.bodyFingerprint).not.toBe(summary.draftBodyFingerprint);
  });

  it('draft 不可得时 sourceKind=unknown、revisionApplied=false', () => {
    const final = '只有最终稿。';
    const summary = buildFinalArtifactSummary({
      ...base,
      draftBody: null,
      finalBody: final,
      finalizedAt: '2026-08-26T00:00:00.000Z',
    });
    expect(summary.sourceKind).toBe('unknown');
    expect(summary.draftBodyFingerprint).toBeNull();
  });

  it('qualityProfile 透传（fast/quality）且 finalizedAt 默认取当前时间', () => {
    const s1 = buildFinalArtifactSummary({
      ...base,
      qualityProfile: 'fast',
      draftBody: 'x',
      finalBody: 'x',
      finalizedAt: '2026-08-26T00:00:00.000Z',
    });
    expect(s1.qualityProfile).toBe('fast');
    const s2 = buildFinalArtifactSummary({
      ...base,
      qualityProfile: 'quality',
      draftBody: 'x',
      finalBody: 'y',
      finalizedAt: '2026-08-26T00:00:00.000Z',
    });
    expect(s2.qualityProfile).toBe('quality');
    expect(s2.sourceKind).toBe('revision');
    expect(typeof s2.finalizedAt).toBe('string');
  });
});

describe('attachWritingFinalArtifact：挂载到 WritingKernelTrace', () => {
  function makeTrace(): WritingKernelTrace {
    return {
      version: 1,
      writingRunId: 'wr-b1',
      generationTraceId: 'gt-b1',
      scenario: 'outline',
      events: [],
    } as unknown as WritingKernelTrace;
  }

  it('挂载 summary 且不携带 body（无第二真相）', () => {
    const trace = makeTrace();
    const body = '最终稿正文。';
    attachWritingFinalArtifact(trace, {
      chapterId: 3,
      generationTraceId: 'gt-b1',
      qualityProfile: 'standard',
      draftBody: body,
      finalBody: body,
      finalizedAt: '2026-08-26T00:00:00.000Z',
    });

    const summary = trace.finalArtifactSummary;
    expect(summary).not.toBeNull();
    expect(summary!.sourceKind).toBe('draft');
    expect(summary!.bodyFingerprint).toBe(sha256Hex(body));
    // summary 绝不包含正文本身
    expect(JSON.stringify(summary)).not.toContain('最终稿正文');
    expect(JSON.stringify(summary)).not.toContain(body);
  });

  it('重复挂载幂等：第二次不覆盖第一次', () => {
    const trace = makeTrace();
    attachWritingFinalArtifact(trace, {
      chapterId: 1,
      generationTraceId: 'gt-b1',
      qualityProfile: 'fast',
      draftBody: 'a',
      finalBody: 'a',
      finalizedAt: '2026-08-26T00:00:00.000Z',
    });
    const first = trace.finalArtifactSummary as FinalArtifactSummary;
    attachWritingFinalArtifact(trace, {
      chapterId: 1,
      generationTraceId: 'gt-b1',
      qualityProfile: 'fast',
      draftBody: 'a',
      finalBody: 'a',
      finalizedAt: '2026-08-26T00:00:00.000Z',
    });
    expect(trace.finalArtifactSummary).toBe(first);
  });

  it('finalBody 为空时拒绝挂载（fail-closed）', () => {
    const trace = makeTrace();
    expect(() =>
      attachWritingFinalArtifact(trace, {
        chapterId: 1,
        generationTraceId: 'gt-b1',
        qualityProfile: 'standard',
        draftBody: 'x',
        finalBody: '   ',
        finalizedAt: '2026-08-26T00:00:00.000Z',
      }),
    ).toThrow(/最终稿/);
  });
});