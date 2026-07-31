/**
 * Continuation domain types — the public cross-phase contract (Spec §6, §12.3, §23).
 *
 * These types are fixed from Phase 1 onward. Phase 2 (Canon analysis) and
 * Phase 3 (generation) MUST consume continuation source text exclusively
 * through {@link ContinuationSourceReader} with a {@link ContinuationSourceSnapshot}
 * bound per call. Anything outside this file is private to the continuation
 * service implementation.
 */
import type {
  SourceChapterPosition,
  Utf16Offset,
} from '../../types/novel';

/** Persisted status of a continuation source row (Spec §9.2). */
export type ContinuationSourceStatus =
  | 'staging'
  | 'needs_review'
  | 'ready'
  | 'failed'
  | 'superseded';

/** Boundary mode persisted in continuation_settings (Spec §9.5). */
export type ContinuationBoundaryMode =
  | 'end_of_source'
  | 'end_of_chapter'
  | 'custom_offset';

/**
 * Phase 2 analysis status. Phase 1 only persists and invalidates this field;
 * the analysis pipeline itself is Phase 2 work (Spec §9.5, §5.9).
 */
export type ContinuationAnalysisStatus =
  | 'not_started'
  | 'running'
  | 'ready'
  | 'outdated'
  | 'failed';

/** Import job lifecycle state (Spec §9.6). */
export type ImportJobState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'awaiting_review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** Import job stage within the `running` state (Spec §9.6). */
export type ImportJobStage =
  | 'reading'
  | 'decoding'
  | 'normalizing'
  | 'detecting_chapters'
  | 'persisting'
  | 'validating'
  | 'awaiting_review'
  | 'activating';

/** Row shape of `continuation_sources` (Spec §9.2). */
export interface ContinuationSource {
  id: number;
  projectId: number;
  version: number;
  status: ContinuationSourceStatus;
  displayName: string;
  originalFileName: string;
  mimeType: string;
  detectedEncoding: string;
  fileSizeBytes: number;
  rawSha256: string;
  normalizedSha256: string;
  normalizedCharCount: number;
  normalizedByteCount: number;
  chapterCount: number;
  parserVersion: string;
  normalizationVersion: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
}

/** Row shape of `continuation_source_chapters` (Spec §9.4). */
export interface ContinuationSourceChapter {
  id: number;
  sourceId: number;
  position: SourceChapterPosition;
  volumeTitle: string | null;
  detectedTitle: string;
  title: string;
  contentSha256: string;
  charCount: number;
  paragraphCount: number;
  /** UTF-16 global offset where the chapter begins (includes title line). */
  sourceStartOffset: Utf16Offset;
  /** UTF-16 global offset where chapter body begins (excludes title). */
  contentStartOffset: Utf16Offset;
  /** UTF-16 global exclusive offset where the chapter ends. */
  sourceEndOffset: Utf16Offset;
  isExcluded: boolean;
  exclusionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Row shape of `continuation_settings` (Spec §9.5 / Phase 2 §6.1). */
export interface ContinuationSettings {
  projectId: number;
  activeSourceId: number | null;
  boundarySourceId: number | null;
  boundaryChapterId: number | null;
  boundaryCharOffsetGlobal: Utf16Offset | null;
  boundaryMode: ContinuationBoundaryMode;
  importCompleted: boolean;
  analysisStatus: ContinuationAnalysisStatus;
  /** Phase 2: only ready snapshot id; Phase 3 reads Canon only via this pointer. */
  activeCanonSnapshotId: string | null;
  /** Phase 3 style profile published with the active Canon snapshot. */
  activeStyleProfileId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Immutable snapshot of the active source + boundary at a point in time.
 *
 * Phase 2/3 callers capture one snapshot per generation/analysis run and pass
 * it to every reader call. The reader verifies the snapshot still matches the
 * live source/settings inside the same DB read transaction; if anything
 * changed it throws `continuation_source_snapshot_outdated` (Spec §12.3, §23).
 */
export interface ContinuationSourceSnapshot {
  projectId: number;
  sourceId: number;
  sourceVersion: number;
  normalizedSha256: string;
  parserVersion: string;
  normalizationVersion: string;
  boundary: {
    chapterId: number;
    chapterPosition: SourceChapterPosition;
    /** Exclusive UTF-16 offset of the boundary in normalized full text. */
    charOffsetExclusive: Utf16Offset;
  };
}

/** A source chapter bounded by the snapshot's boundary (Spec §12.3). */
export interface BoundedSourceChapter {
  id: number;
  sourceId: number;
  position: SourceChapterPosition;
  title: string;
  content: string;
  range: { start: Utf16Offset; end: Utf16Offset };
  /** True when this chapter extends past the boundary and was clipped. */
  clippedByBoundary: boolean;
}

/**
 * Phase 2 reads source text only through this interface. Every method binds
 * the supplied snapshot within one DB read transaction and clips results to
 * `boundary.charOffsetExclusive`. Phase 2 MUST NOT reach into the repository
 * or chunks table directly (Spec §12.3, §13, §23).
 */
export interface ContinuationSourceReader {
  getSnapshot(projectId: number): Promise<ContinuationSourceSnapshot>;
  listBoundedSourceChapters(
    snapshot: ContinuationSourceSnapshot,
  ): Promise<BoundedSourceChapter[]>;
  /**
   * H1 修复：按 position 区间流式读取章节正文，避免 2000+ 章长篇网文
   * 全量加载导致 OOM。half-open `[startPosition, endPosition)`，与 batch
   * range 语义一致；boundary 仍然强制裁剪。
   */
  listBoundedSourceChaptersForRange(
    snapshot: ContinuationSourceSnapshot,
    startPosition: SourceChapterPosition,
    endPosition: SourceChapterPosition,
  ): Promise<BoundedSourceChapter[]>;
  /**
   * H1 修复：轻量级章节元数据查询，不加载 content 正文。用于 startAnalysis
   * 阶段 planAnalysisScope 和 token 估算（只需 position/length），避免
   * 全量加载正文到内存。
   */
  listBoundedSourceChapterMetas(
    snapshot: ContinuationSourceSnapshot,
  ): Promise<BoundedSourceChapterMeta[]>;
  readBoundedEvidenceRange(input: {
    snapshot: ContinuationSourceSnapshot;
    start: Utf16Offset;
    end: Utf16Offset;
  }): Promise<string>;
}

/**
 * H1 修复：章节轻量元数据，不含 content 正文。用于 plan 阶段避免 OOM。
 */
export interface BoundedSourceChapterMeta {
  id: number;
  sourceId: number;
  position: SourceChapterPosition;
  title: string;
  /** Full content length in UTF-16 units (before boundary clipping). */
  contentLength: number;
  range: { start: Utf16Offset; end: Utf16Offset };
  clippedByBoundary: boolean;
}

/** Error codes surfaced to the UI (Spec §19). */
export type ContinuationErrorCode =
  | 'unsupported_file'
  | 'unsupported_encoding'
  | 'decode_failed'
  | 'file_too_large'
  | 'parse_failed'
  | 'storage_full'
  | 'database_error'
  | 'cancelled'
  | 'source_changed'
  | 'invalid_boundary'
  | 'job_interrupted'
  | 'chunk_integrity_failed';

/**
 * Thrown when a snapshot no longer matches the live source/settings — Phase 2
 * must abort the in-flight run, not mix two source versions (Spec §12.3, §23).
 */
export const CONTINUATION_SNAPSHOT_OUTDATED = 'continuation_source_snapshot_outdated';
export const CONTINUATION_SNAPSHOT_CHANGED = 'source_snapshot_changed';

export class ContinuationSnapshotOutdatedError extends Error {
  readonly code = CONTINUATION_SNAPSHOT_OUTDATED;
  constructor(message = '续写源快照已过期，请重新获取后重试。') {
    super(message);
    this.name = 'ContinuationSnapshotOutdatedError';
  }
}
