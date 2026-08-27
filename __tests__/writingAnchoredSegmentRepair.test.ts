import { sha256Hex } from '../src/services/continuation/hashUtils';
import {
  buildAnchoredSegmentRepairPlan,
  formatAnchoredSegmentRepairPlan,
  resolveAnchoredRevisionOutput,
} from '../src/services/writing/revision/anchoredSegmentRepair';

const draft = '第一段保持不变。\n\n第二段需要修复。';
const findings = [
  {
    findingId: 'qa-1',
    sourceStage: 'qa' as const,
    severity: 'blocking' as const,
    target: '第二段需要修复',
    issue: '段落事实表述不准确',
    instruction: '改为明确的安全表述',
    requirementIds: [],
    evidence: '',
  },
];

describe('B7 — Anchored Segment Repair', () => {
  test('builds a unique anchor plan and exposes no model offsets in output contract', () => {
    const plan = buildAnchoredSegmentRepairPlan({ draftBody: draft, findings });
    expect(plan.eligible).toBe(true);
    expect(plan.findings[0].anchorId).toBe('draft-p-002');
    expect(plan.findings[0].paragraphHash).toBe(
      sha256Hex(plan.findings[0].anchorText),
    );
    const prompt = formatAnchoredSegmentRepairPlan(plan);
    expect(prompt).toContain('anchorId=draft-p-002');
    expect(prompt).toContain('不得输出数字 offset');
  });

  test('applies a valid segment repair deterministically in the existing Revision stage', () => {
    const plan = buildAnchoredSegmentRepairPlan({ draftBody: draft, findings });
    const resolved = resolveAnchoredRevisionOutput({
      draftBody: draft,
      findings,
      structured: {
        schemaVersion: 1,
        strategy: 'segment_repair',
        segmentRepairs: [
          {
            anchorId: plan.findings[0].anchorId,
            paragraphHash: plan.findings[0].paragraphHash,
            replacementText: '第二段已完成安全修复。',
            findingIds: ['qa-1'],
            reason: '纠正事实表述',
          },
        ],
      },
    });
    expect(resolved.status).toBe('segment_repair');
    if (resolved.status !== 'segment_repair') throw new Error('expected segment repair');
    expect(resolved.body).toBe('第一段保持不变。\n\n第二段已完成安全修复。');
    expect(resolved.metadata.coverage).toBe(1);
  });

  test('invalid anchor/hash falls back to the same response full Revision', () => {
    const resolved = resolveAnchoredRevisionOutput({
      draftBody: draft,
      findings,
      structured: {
        schemaVersion: 1,
        strategy: 'segment_repair',
        segmentRepairs: [
          {
            anchorId: 'draft-p-002',
            paragraphHash: 'wrong',
            replacementText: '不应直接应用。',
            findingIds: ['qa-1'],
            reason: '测试回退',
          },
        ],
        content: '完整 Revision 回退正文。',
      },
    });
    expect(resolved.status).toBe('full_revision_fallback');
    if (resolved.status !== 'full_revision_fallback') throw new Error('expected full fallback');
    expect(resolved.body).toBe('完整 Revision 回退正文。');
    expect(resolved.metadata.fallback).toBe('full_revision');
  });

  test('invalid segment response without full content fails closed without another call', () => {
    const resolved = resolveAnchoredRevisionOutput({
      draftBody: draft,
      findings,
      structured: {
        schemaVersion: 1,
        strategy: 'segment_repair',
        segmentRepairs: [
          {
            anchorId: 'draft-p-999',
            paragraphHash: 'wrong',
            replacementText: '不应应用。',
            findingIds: ['qa-1'],
            reason: '测试失败',
          },
        ],
      },
    });
    expect(resolved.status).toBe('invalid');
    expect(resolved.body).toBeNull();
  });
});
