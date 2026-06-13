import type { ContentRevision, RevisionSource, RevisionTargetType } from '../types/revision';
import {
  createContentRevision,
  getContentRevisions,
  getLatestContentRevision,
  trimContentRevisions,
} from './database';

export async function createRevision(input: {
  projectId: number;
  targetType: RevisionTargetType;
  targetId: number;
  title: string;
  content: string;
  source: RevisionSource;
  sourceRef?: string | null;
}): Promise<number> {
  const latest = await getLatestContentRevision(input.targetType, input.targetId);
  if (latest && latest.content === input.content) {
    return latest.id;
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
): Promise<void> {
  await createRevision({
    projectId: revision.projectId,
    targetType: revision.targetType as RevisionTargetType,
    targetId: revision.targetId,
    title: revision.title,
    content: revision.content,
    source: 'before_restore' as RevisionSource,
    sourceRef: `restoring-from-${revision.id}`,
  });
  await updateFn(revision.content);
}
