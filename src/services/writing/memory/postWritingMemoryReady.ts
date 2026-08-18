/**
 * PostWriting Ready Gate (ONE Memory).
 *
 * Chapter N persist may show DONE in UI. Chapter N+1 Freeze must not
 * consume a stale Story Memory / unfinished state extraction.
 *
 * Pending *conflict* confirmation is not a normal Barrier: it is parked
 * for the user and counted separately so Batch does not stall on routine
 * State Update.
 */
export type PostWritingReadyStatus = 'ready' | 'waiting' | 'conflict_parked';

export interface PostWritingMemoryReadyInput {
  pendingStateExtractionCount: number;
  storyMemoryStatus?: string | null;
  dirtyFromPosition?: number | null;
  completedPosition?: number | null;
  pendingConfirmationCount: number;
}

export interface PostWritingMemoryReadyResult {
  ready: boolean;
  status: PostWritingReadyStatus;
  reason: string | null;
  nextChapterMayFreeze: boolean;
}

export function evaluatePostWritingMemoryReady(
  input: PostWritingMemoryReadyInput,
): PostWritingMemoryReadyResult {
  if (input.pendingStateExtractionCount > 0) {
    return {
      ready: false,
      status: 'waiting',
      reason: '状态提取尚未完成',
      nextChapterMayFreeze: false,
    };
  }

  const dirtyFrom =
    input.dirtyFromPosition == null ? null : Number(input.dirtyFromPosition);
  const completed =
    input.completedPosition == null ? null : Number(input.completedPosition);
  const memoryBlocking =
    (input.storyMemoryStatus === 'dirty' ||
      input.storyMemoryStatus === 'rebuilding' ||
      input.storyMemoryStatus === 'failed') &&
    dirtyFrom != null &&
    (completed == null || dirtyFrom <= completed);

  if (memoryBlocking) {
    return {
      ready: false,
      status: 'waiting',
      reason: '故事记忆尚未就绪',
      nextChapterMayFreeze: false,
    };
  }

  if (input.pendingConfirmationCount > 0) {
    return {
      ready: true,
      status: 'conflict_parked',
      reason: `存在 ${input.pendingConfirmationCount} 项需确认的状态冲突`,
      // Batch still pauses so a conflict cannot silently enter the next freeze
      // as committed state. Interactive next-chapter is allowed; the parked
      // proposals stay out of Effective State until the user decides.
      nextChapterMayFreeze: true,
    };
  }

  return {
    ready: true,
    status: 'ready',
    reason: null,
    nextChapterMayFreeze: true,
  };
}
