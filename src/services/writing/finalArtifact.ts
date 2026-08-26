/**
 * Final Artifact（B1）：最终稿成为一等公民的稳定用户投影。
 *
 * 硬约束：
 *  - 不新增 Final Writer LLM Stage（Final 由现有 Draft/Revision 产物决定）；
 *  - 不新增第二持久化真相（正文仍以 persisted body / final_text / artifact
 *    为 authority，本模块只投影统计与指纹，不携带正文）；
 *  - Final = Draft 时 revisionApplied=false，绝不向用户谎报「已修订」。
 *
 * FinalArtifactSummary 挂载到 WritingKernelTrace（随 trace 落盘），UI 侧由
 * finalArtifactData 从现有持久化真相（大纲 stage_results+final_text；续写
 * continuation_generation_artifacts）重建完整 FinalWritingArtifact。
 */
import { sha256Hex } from '../continuation/hashUtils';
import type { WritingKernelTrace } from './contracts/frozenWritingContext';
import type { GenerationQualityProfile } from './contracts/generationQualityProfile';

/** 统一字数口径（B3 全 App 主指标）。 */
export interface WritingCharStats {
  /** 总字符数（含空白，UTF-16 长度）。 */
  charCount: number;
  /** 正文非空白字符数（统一口径：主显示数字）。 */
  nonWhitespaceCharCount: number;
  /** 非空段落数。 */
  paragraphCount: number;
}

/** 非空白字符判定：全角空格 \u3000 与普通空白统一处理。 */
function isWhitespace(ch: string): boolean {
  return /^\s$/u.test(ch);
}

export function measureWritingCharStats(text: string): WritingCharStats {
  const body = String(text ?? '');
  let nonWhitespaceCharCount = 0;
  for (let i = 0; i < body.length; i += 1) {
    if (!isWhitespace(body[i])) nonWhitespaceCharCount += 1;
  }
  const paragraphs = body
    .split(/\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
  return {
    charCount: body.length,
    nonWhitespaceCharCount,
    paragraphCount: paragraphs.length,
  };
}

export type FinalArtifactSourceKind = 'draft' | 'revision' | 'segment_repair' | 'unknown';

/**
 * Final 来源判定：
 *  - Final == Draft → 'draft'（QA Pass，0 次额外 LLM）；
 *  - Final != Draft → 'revision'（B6 引入 segment repair 后在此扩展）；
 *  - draftBody 不可得 → 'unknown'（无法断言是否修改过）。
 */
export function resolveFinalSourceKind(draftBody: string | null, finalBody: string): FinalArtifactSourceKind {
  if (draftBody === null) return 'unknown';
  return sha256Hex(draftBody) === sha256Hex(finalBody) ? 'draft' : 'revision';
}

export interface FinalArtifactSummary {
  contractVersion: 1;
  chapterId: number;
  generationTraceId: string;
  qualityProfile: GenerationQualityProfile | null;
  /** 最终正文指纹（sha256Hex(finalBody)）。 */
  bodyFingerprint: string;
  /** 初稿指纹；draft 不可得时为 null。 */
  draftBodyFingerprint: string | null;
  sourceKind: FinalArtifactSourceKind;
  /** 正文是否真的被修改过（Final != Draft）。 */
  revisionApplied: boolean;
  charStats: WritingCharStats;
  finalizedAt: string;
}

export interface BuildFinalArtifactSummaryInput {
  chapterId: number;
  generationTraceId: string;
  qualityProfile?: GenerationQualityProfile | string | null;
  draftBody: string | null;
  finalBody: string;
  finalizedAt?: string;
}

export function buildFinalArtifactSummary(
  input: BuildFinalArtifactSummaryInput,
): FinalArtifactSummary {
  const finalBody = String(input.finalBody ?? '');
  const draftBody = input.draftBody === null ? null : String(input.draftBody ?? '');
  const sourceKind = resolveFinalSourceKind(draftBody, finalBody);
  const qp = input.qualityProfile;
  return {
    contractVersion: 1,
    chapterId: Number(input.chapterId),
    generationTraceId: String(input.generationTraceId || '').trim(),
    qualityProfile:
      qp === 'fast' || qp === 'standard' || qp === 'quality'
        ? qp
        : null,
    bodyFingerprint: sha256Hex(finalBody),
    draftBodyFingerprint: draftBody === null ? null : sha256Hex(draftBody),
    sourceKind,
    revisionApplied: sourceKind === 'revision' || sourceKind === 'segment_repair',
    charStats: measureWritingCharStats(finalBody),
    finalizedAt: input.finalizedAt || new Date().toISOString(),
  };
}

/**
 * 把 Final summary 挂到 WritingKernelTrace。幂等：已存在则不再覆盖。
 * summary 不携带正文，避免形成第二持久化真相。
 */
export function attachWritingFinalArtifact(
  trace: WritingKernelTrace,
  input: BuildFinalArtifactSummaryInput,
): void {
  if (trace.finalArtifactSummary) return;
  if (!String(input.finalBody ?? '').trim()) {
    throw new Error('FINAL_ARTIFACT_EMPTY_BODY：最终稿为空，拒绝挂载。');
  }
  trace.finalArtifactSummary = buildFinalArtifactSummary(input);
}

/**
 * 从 trace 提取已挂载的 summary（无则 null）。
 */
export function readFinalArtifactSummaryFromTrace(
  trace: WritingKernelTrace | null | undefined,
): FinalArtifactSummary | null {
  return trace?.finalArtifactSummary ?? null;
}

/** 仅构造阶段用：确认 summary 形状的函数（测试/审计锚点）。 */
export function isFinalArtifactSummary(value: unknown): value is FinalArtifactSummary {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    s.contractVersion === 1 &&
    typeof s.chapterId === 'number' &&
    typeof s.bodyFingerprint === 'string' &&
    typeof s.sourceKind === 'string' &&
    /^[a-f0-9]{64}$/i.test(String(s.bodyFingerprint))
  );
}