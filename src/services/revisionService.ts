import type { ContentRevision, RevisionSource, RevisionTargetType } from '../types/revision';
import {
  createContentRevision,
  getContentRevisions,
  getLatestContentRevision,
  trimContentRevisions,
} from './database';

export async function createRevision(
  input: {
    projectId: number;
    targetType: RevisionTargetType;
    targetId: number;
    title: string;
    content: string;
    source: RevisionSource;
    sourceRef?: string | null;
  },
  options?: {
    /**
     * Audit snapshots (before_*_revision) carry the action receipt inside
     * sourceRef, so an identical body is NOT a duplicate record. Skip the
     * content dedupe for them or the receipt would silently never persist
     * when the snapshot body equals the latest revision's body.
     */
    skipContentDedupe?: boolean;
  },
): Promise<number> {
  if (!options?.skipContentDedupe) {
    const latest = await getLatestContentRevision(input.targetType, input.targetId);
    if (latest && latest.content === input.content) {
      return latest.id;
    }
  }
  const id = await createContentRevision(input);
  trimContentRevisions(input.targetType, input.targetId).catch(() => {});
  return id;
}

export async function getRevisions(
  targetType: RevisionTargetType,
  targetId: number,
): Promise<ContentRevision[]> {
  return getContentRevisions(targetType, targetId);
}

export async function restoreRevision(
  revision: ContentRevision,
  updateFn: (content: string) => Promise<void>,
  getCurrentContent: () => Promise<string>,
): Promise<void> {
  // Snapshot the CURRENT content (not the restore target) so the user can
  // undo a restore. Previously this saved revision.content, which made the
  // "before_restore" snapshot useless (it duplicated the target state).
  const currentContent = await getCurrentContent();
  await createRevision({
    projectId: revision.projectId,
    targetType: revision.targetType as RevisionTargetType,
    targetId: revision.targetId,
    title: revision.title,
    content: currentContent,
    source: 'before_restore' as RevisionSource,
    sourceRef: `restoring-from-${revision.id}`,
  });
  await updateFn(revision.content);
}
