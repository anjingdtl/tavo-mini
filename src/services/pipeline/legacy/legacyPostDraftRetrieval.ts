/**
 * Legacy post-draft retrieval adapters (Stability Plan §10 / Phase 8).
 *
 * These wrappers re-freeze from live DB before rebuilding the audit context.
 * Production reconcile consumes `buildPostDraftAuditContextFromFrozen`
 * directly on the task-start frozen pool; the wrappers below are retained
 * ONLY for tests that intentionally exercise live-read scenarios. Keeping
 * them in this edge module stops the legacy path from being importable as
 * if it were part of the current main chain.
 */
import {
  buildContext,
} from '../../contextBuilder';
import {
  captureFrozenAuditCandidates,
  buildPostDraftAuditContextFromFrozen,
} from '../../postDraftRetrieval';
import type { PostDraftRetrievalResult } from '../../postDraftRetrieval';
import type { Chapter, ContextConfig } from '../../../types/novel';
import type { PipelineContextSnapshot } from '../../../types/pipelineContext';

/**
 * Legacy live-DB path. Prefer buildPostDraftAuditContextFromFrozen for
 * pipeline reconcile. Kept for tests that intentionally exercise live reads.
 */
export async function buildPostDraftAuditContext(
  original: PipelineContextSnapshot,
  draftText: string,
  projectId: number,
  chapter: Chapter,
  contextConfig: ContextConfig,
): Promise<PostDraftRetrievalResult> {
  if (!draftText || !draftText.trim()) {
    return {
      snapshot: original,
      episodicHitsAdded: 0,
      worldbookHitsAdded: 0,
      characterHitsAdded: 0,
      fellBack: true,
      fallbackReason: 'empty draft',
    };
  }
  if (!chapter || typeof chapter.position !== 'number') {
    return {
      snapshot: original,
      episodicHitsAdded: 0,
      worldbookHitsAdded: 0,
      characterHitsAdded: 0,
      fellBack: true,
      fallbackReason: 'invalid chapter',
    };
  }
  // Capture then pure rebuild so even the legacy entry freezes one snapshot.
  try {
    const frozen = await captureFrozenAuditCandidates(
      chapter,
      projectId,
      contextConfig,
    );
    return buildPostDraftAuditContextFromFrozen(original, draftText, frozen);
  } catch (error: any) {
    return {
      snapshot: original,
      episodicHitsAdded: 0,
      worldbookHitsAdded: 0,
      characterHitsAdded: 0,
      fellBack: true,
      fallbackReason: error?.message
        ? String(error.message)
        : 'post-draft retrieval error',
    };
  }
}

/** Legacy convenience: buildContext + legacy audit rebuild in one call. */
export async function buildSnapshotWithPostDraftRetrieval(
  chapter: Chapter,
  config: ContextConfig,
  projectId: number,
  preset: Parameters<typeof buildContext>[3],
  options: Parameters<typeof buildContext>[4],
  draftText: string,
): Promise<{
  baseSnapshot: PipelineContextSnapshot;
  auditSnapshot: PipelineContextSnapshot;
  retrieval: PostDraftRetrievalResult;
}> {
  const built = await buildContext(chapter, config, projectId, preset, options);
  const baseSnapshot = built.pipelineContext;
  const retrieval = await buildPostDraftAuditContext(
    baseSnapshot,
    draftText,
    projectId,
    chapter,
    config,
  );
  return {
    baseSnapshot,
    auditSnapshot: retrieval.snapshot,
    retrieval,
  };
}
