/**
 * Final Artifact 数据重建（B1）：从现有持久化真相重建完整
 * FinalWritingArtifact 供 UI 展示。不新增第二持久化真相：
 *
 *  - 大纲：pipeline_tasks.stage_results（draft/brief）+ final_text；
 *  - 续写：continuation_generation_artifacts（draft/revision_1/final）。
 *
 * trace 中已挂 FinalArtifactSummary 时优先复用（保留 qualityProfile 等
 * 运行时信息）；历史任务无 summary 时按现有真相兜底重建。
 * 正文 authority 一律从任务/run 的最终稿字段读取，本模块不写库。
 */
import { sha256Hex } from '../continuation/hashUtils';
import {
  buildFinalArtifactSummary,
  measureWritingCharStats,
  type FinalArtifactSummary,
} from './finalArtifact';
import type { GenerationQualityProfile } from './contracts/generationQualityProfile';

/** 完整用户投影：summary + 正文（正文来自现有真相，非本模块产物）。 */
export interface FinalWritingArtifact {
  summary: FinalArtifactSummary;
  /** 最终正文（authority：task.finalText / persist final artifact）。 */
  body: string;
  /** 初稿正文；不可得时为 null（无法展示「初稿字数」对比）。 */
  draftBody: string | null;
}

export interface OutlineTaskLike {
  id: string;
  chapterId: number;
  finalText?: string | null;
  stageResults?: Array<{
    stage: string;
    status: string;
    text?: string | null;
  }>;
  pipelineContextJson?: {
    draftContext?: { writingKernelTrace?: { finalArtifactSummary?: unknown } };
  } | null;
}

function readOutlineStageText(task: OutlineTaskLike, stage: string): string | null {
  const row = task.stageResults?.find(
    item => item.stage === stage && item.status === 'success' && item.text,
  );
  return row?.text ? String(row.text) : null;
}

function readSummaryFromOutlineTask(task: OutlineTaskLike): FinalArtifactSummary | null {
  const maybe =
    task.pipelineContextJson?.draftContext?.writingKernelTrace
      ?.finalArtifactSummary;
  return isSummaryLike(maybe) ? (maybe as FinalArtifactSummary) : null;
}

function isSummaryLike(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    s.contractVersion === 1 &&
    typeof s.chapterId === 'number' &&
    typeof s.bodyFingerprint === 'string'
  );
}

/**
 * 大纲 Final Artifact 重建。finalText 缺失（未生成/失败）返回 null。
 */
export function buildFinalArtifactFromOutlineTask(
  task: OutlineTaskLike,
): FinalWritingArtifact | null {
  const finalText = String(task.finalText ?? '');
  if (!finalText.trim()) return null;

  const draftText = readOutlineStageText(task, 'draft');
  const traceSummary = readSummaryFromOutlineTask(task);

  const bodyFingerprint = sha256Hex(finalText);
  const draftFingerprint =
    draftText === null ? null : sha256Hex(draftText);
  const sourceKind =
    traceSummary?.sourceKind ??
    (draftText === null
      ? 'unknown'
      : bodyFingerprint === draftFingerprint
      ? 'draft'
      : 'revision');
  const qualityProfile: GenerationQualityProfile | null =
    traceSummary?.qualityProfile ?? null;
  const generationTraceId = traceSummary?.generationTraceId ?? '';

  const summary: FinalArtifactSummary = {
    contractVersion: 1,
    chapterId: Number(task.chapterId),
    generationTraceId,
    qualityProfile,
    bodyFingerprint,
    draftBodyFingerprint: draftFingerprint,
    sourceKind,
    revisionApplied: sourceKind === 'revision' || sourceKind === 'segment_repair',
    charStats: measureWritingCharStats(finalText),
    finalizedAt: traceSummary?.finalizedAt ?? '',
  };

  return { summary, body: finalText, draftBody: draftText };
}

export interface ContinuationRunLike {
  id: string;
  chapterId: number;
  snapshot?: () => unknown;
}

type ArtifactRow = {
  content?: string;
  content_hash?: string;
} | null;

export type { ArtifactRow };

interface ArtifactReader {
  getLatestArtifactForStage(
    runId: string,
    stage: string,
  ): Promise<ArtifactRow | null>;
}

export interface ContinuationArtifactReader extends ArtifactReader {}

/**
 * 续写 Final Artifact 重建。最终稿取 stage='final' artifact；初稿取
 * stage='draft'。final artifact 缺失返回 null。
 */
export async function buildFinalArtifactFromContinuationRun(
  run: ContinuationRunLike,
  reader?: ArtifactReader,
): Promise<FinalWritingArtifact | null> {
  const repo = reader ?? defaultContinuationReader();
  const draftRow = await repo.getLatestArtifactForStage(run.id, 'draft');
  const finalRow = await repo.getLatestArtifactForStage(run.id, 'final');
  return assembleContinuationFinalArtifact(run, draftRow, finalRow, run.snapshot?.());
}

/**
 * 接续 UI 已加载的 artifact 行与 kernel trace 组装（无需重复查询仓储）。
 */
export function buildFinalArtifactFromContinuationArtifacts(input: {
  runId: string;
  chapterId: number;
  draftRow: ArtifactRow | null;
  finalRow: ArtifactRow | null;
  kernelTrace?: { finalArtifactSummary?: unknown } | null;
}): FinalWritingArtifact | null {
  const finalBody = String(input.finalRow?.content ?? '');
  if (!finalBody.trim()) return null;
  const draftBody =
    input.draftRow && input.draftRow.content != null
      ? String(input.draftRow.content)
      : null;
  const traceSummary = isSummaryLike(
    input.kernelTrace?.finalArtifactSummary,
  )
    ? (input.kernelTrace!.finalArtifactSummary as FinalArtifactSummary)
    : null;

  const bodyFingerprint = sha256Hex(finalBody);
  const draftFingerprint =
    draftBody === null ? null : sha256Hex(draftBody);
  const sourceKind =
    traceSummary?.sourceKind ??
    (draftBody === null
      ? 'unknown'
      : bodyFingerprint === draftFingerprint
      ? 'draft'
      : 'revision');

  const summary: FinalArtifactSummary = {
    contractVersion: 1,
    chapterId: Number(input.chapterId),
    generationTraceId: traceSummary?.generationTraceId ?? '',
    qualityProfile: traceSummary?.qualityProfile ?? null,
    bodyFingerprint,
    draftBodyFingerprint: draftFingerprint,
    sourceKind,
    revisionApplied: sourceKind === 'revision' || sourceKind === 'segment_repair',
    charStats: measureWritingCharStats(finalBody),
    finalizedAt: traceSummary?.finalizedAt ?? '',
  };

  return { summary, body: finalBody, draftBody };
}

function assembleContinuationFinalArtifact(
  run: ContinuationRunLike,
  draftRow: ArtifactRow | null,
  finalRow: ArtifactRow | null,
  snapshot: unknown,
): FinalWritingArtifact | null {
  const withTrace = snapshot as
    | { writingKernelTrace?: { finalArtifactSummary?: unknown } }
    | null
    | undefined;
  return buildFinalArtifactFromContinuationArtifacts({
    runId: run.id,
    chapterId: Number((run as any).chapterId ?? (run as any).chapter_id ?? 0),
    draftRow,
    finalRow,
    kernelTrace: withTrace?.writingKernelTrace ?? null,
  });
}

function defaultContinuationReader(): ArtifactReader {
  // Lazy require 避免模块级循环依赖（generationRepository 引用 writing 层）。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const repo = require('../continuation/generation/generationRepository');
  return repo as unknown as ArtifactReader;
}

export { buildFinalArtifactSummary }; // re-export 供 UI 组合