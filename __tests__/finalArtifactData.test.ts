/* eslint-env jest */
/**
 * Red Test：Final Artifact 数据重建（B1）——从现有持久化真相（大纲
 * stage_results + final_text；续写 continuation_generation_artifacts）
 * 重建完整 FinalWritingArtifact，历史任务（无 summary）也能兜底重建。
 */
import { sha256Hex } from '../src/services/continuation/hashUtils';

jest.mock('../src/services/continuation/generation/generationRepository', () => ({
  getLatestArtifactForStage: jest.fn(),
  getCurrentEligibleArtifact: jest.fn(),
}));

import {
  buildFinalArtifactFromOutlineTask,
  buildFinalArtifactFromContinuationRun,
} from '../src/services/writing/finalArtifactData';
import {
  getCurrentEligibleArtifact,
  getLatestArtifactForStage,
} from '../src/services/continuation/generation/generationRepository';

const mockGetLatestArtifactForStage = getLatestArtifactForStage as jest.Mock;
const mockGetCurrentEligibleArtifact = getCurrentEligibleArtifact as jest.Mock;

interface OutlineTaskLike {
  id: string;
  chapterId: number;
  finalText?: string;
  stageResults?: Array<{
    stage: string;
    status: string;
    text?: string;
  }>;
  pipelineContextJson?: { draftContext?: { writingKernelTrace?: any } };
}

describe('buildFinalArtifactFromOutlineTask：大纲重建', () => {
  it('QA Pass：final_text == draft，sourceKind=draft，revisionApplied=false', () => {
    const draft = '第一章 正文。\n第二段。';
    const task: OutlineTaskLike = {
      id: 't1',
      chapterId: 11,
      finalText: draft,
      stageResults: [
        { stage: 'draft', status: 'success', text: draft },
        { stage: 'qa', status: 'success', text: JSON.stringify({ verdict: 'pass', findings: [] }) },
      ],
    };

    const artifact = buildFinalArtifactFromOutlineTask(task);
    expect(artifact).not.toBeNull();
    expect(artifact!.body).toBe(draft);
    expect(artifact!.draftBody).toBe(draft);
    expect(artifact!.summary.sourceKind).toBe('draft');
    expect(artifact!.summary.revisionApplied).toBe(false);
    expect(artifact!.summary.bodyFingerprint).toBe(sha256Hex(draft));
    expect(artifact!.summary.chapterId).toBe(11);
  });

  it('Revision 已应用：final_text != draft，sourceKind=revision', () => {
    const draft = '正文甲。';
    const final = '正文甲，修正人物一致性问题。';
    const task: OutlineTaskLike = {
      id: 't2',
      chapterId: 12,
      finalText: final,
      stageResults: [
        { stage: 'draft', status: 'success', text: draft },
        {
          stage: 'brief',
          status: 'success',
          text: final,
        },
      ],
    };

    const artifact = buildFinalArtifactFromOutlineTask(task);
    expect(artifact!.summary.sourceKind).toBe('revision');
    expect(artifact!.summary.revisionApplied).toBe(true);
    expect(artifact!.body).toBe(final);
    expect(artifact!.summary.bodyFingerprint).toBe(sha256Hex(final));
  });

  it('历史任务无 summary 也可重建（fallback summary）', () => {
    const draft = '历史草稿。';
    const task: OutlineTaskLike = {
      id: 't3',
      chapterId: 13,
      finalText: draft,
      stageResults: [{ stage: 'draft', status: 'success', text: draft }],
      // 无 pipelineContextJson → 无 trace summary
    };

    const artifact = buildFinalArtifactFromOutlineTask(task);
    expect(artifact!.summary.sourceKind).toBe('draft');
    expect(artifact!.summary.qualityProfile).toBeNull();
  });

  it('finalText 缺失时返回 null（fail-closed，不伪造最终稿）', () => {
    const task: OutlineTaskLike = {
      id: 't4',
      chapterId: 14,
      stageResults: [{ stage: 'draft', status: 'success', text: 'x' }],
    };
    expect(buildFinalArtifactFromOutlineTask(task)).toBeNull();
  });

  it('trace 携带 qualityProfile 时透传', () => {
    const task: OutlineTaskLike = {
      id: 't5',
      chapterId: 15,
      finalText: '正文。',
      stageResults: [{ stage: 'draft', status: 'success', text: '正文。' }],
      pipelineContextJson: {
        draftContext: {
          writingKernelTrace: {
            generationTraceId: 'gt-t5',
            finalArtifactSummary: {
              contractVersion: 1,
              chapterId: 15,
              generationTraceId: 'gt-t5',
              qualityProfile: 'quality',
              bodyFingerprint: sha256Hex('正文。'),
              draftBodyFingerprint: sha256Hex('正文。'),
              sourceKind: 'draft',
              revisionApplied: false,
              charStats: { charCount: 3, nonWhitespaceCharCount: 3, paragraphCount: 1 },
              finalizedAt: '2026-08-26T00:00:00.000Z',
            },
          },
        },
      },
    };

    const artifact = buildFinalArtifactFromOutlineTask(task);
    expect(artifact!.summary.qualityProfile).toBe('quality');
    expect(artifact!.summary.generationTraceId).toBe('gt-t5');
  });
});

describe('buildFinalArtifactFromContinuationRun：续写重建', () => {
  beforeEach(() => {
    mockGetLatestArtifactForStage.mockReset();
    mockGetCurrentEligibleArtifact.mockReset();
  });

  const runLike = {
    id: 'r1',
    chapterId: 21,
    snapshot: (finalArtifactSummary: unknown) => ({
      schemaVersion: 4,
      workflowVersion: 5,
      generationTraceId: 'gt-r1',
      writingKernelTrace: {
        generationTraceId: 'gt-r1',
        finalArtifactSummary,
        events: [],
      },
    }),
  };

  it('final artifact 与 draft artifact 一致 → sourceKind=draft', async () => {
    const body = '续写正文甲。';
    mockGetLatestArtifactForStage.mockResolvedValueOnce({
      content: body,
      content_hash: sha256Hex(body),
    }); // draft
    mockGetCurrentEligibleArtifact.mockResolvedValueOnce({
      content: body,
      content_hash: sha256Hex(body),
    }); // current final
    const artifact = await buildFinalArtifactFromContinuationRun(runLike as any);
    expect(artifact).not.toBeNull();
    expect(artifact!.body).toBe(body);
    expect(artifact!.summary.sourceKind).toBe('draft');
    expect(artifact!.summary.chapterId).toBe(21);
  });

  it('final != draft → sourceKind=revision，指纹不一致', async () => {
    const draft = '续写草稿。';
    const final = '续写草稿，补充设定。';
    mockGetLatestArtifactForStage.mockResolvedValueOnce({
      content: draft,
      content_hash: sha256Hex(draft),
    });
    mockGetCurrentEligibleArtifact.mockResolvedValueOnce({
      content: final,
      content_hash: sha256Hex(final),
    });
    const artifact = await buildFinalArtifactFromContinuationRun(runLike as any);
    expect(artifact!.summary.sourceKind).toBe('revision');
    expect(artifact!.summary.revisionApplied).toBe(true);
    expect(artifact!.body).toBe(final);
  });

  it('final artifact 缺失时返回 null', async () => {
    mockGetLatestArtifactForStage.mockResolvedValueOnce({
      content: 'd',
      content_hash: 'h',
    });
    mockGetCurrentEligibleArtifact.mockResolvedValueOnce(null);
    const artifact = await buildFinalArtifactFromContinuationRun(runLike as any);
    expect(artifact).toBeNull();
  });

  it('历史 run 无 summary 时仍按现有真相兜底重建', async () => {
    const body = '旧版最终稿。';
    mockGetLatestArtifactForStage.mockResolvedValueOnce({
      content: body,
      content_hash: sha256Hex(body),
    });
    mockGetCurrentEligibleArtifact.mockResolvedValueOnce({
      content: body,
      content_hash: sha256Hex(body),
    });
    const legacyRun = { id: 'r2', chapterId: 22, snapshot: () => null };
    const artifact = await buildFinalArtifactFromContinuationRun(legacyRun as any);
    expect(artifact).not.toBeNull();
    expect(artifact!.summary.qualityProfile).toBeNull();
  });
});
