/**
 * Continuation chapter recovery — always into a **separate** recovery project.
 *
 * Use when the accident timeline (old ~40 chapters) and the post-accident
 * rewrite (~10 chapters from the original's end) have diverged and must not
 * be linearly spliced into one position stream (product decision: 找回项目).
 *
 * Sources (read-only against the source project):
 *  1. content_revisions for chapter targets (latest non-empty body per target_id)
 *  2. continuation_generation_artifacts (writer/repair/user_edit) as fallback
 *
 * Never mutates the source project's `chapters` rows.
 */
import { openDatabase } from '../../data/connection/openDatabase';
import {
  createChapter,
  getChaptersByProject,
  getProjectById,
  updateChapter,
} from '../../data/repositories/projectRepository';
import { createContinuationProject } from './continuationProjectService';

const MIN_BODY_CHARS = 20;

export type RecoverableChapterSource =
  | 'orphan_revision'
  | 'revision'
  | 'generation_artifact';

export interface RecoverableChapterBody {
  /** Stable key for dedupe (target_id or artifact hash). */
  key: string;
  source: RecoverableChapterSource;
  title: string;
  content: string;
  contentLength: number;
  /** Best-effort ordering hint (chapter id / target_position / created_at). */
  sortKey: string;
  createdAt: string;
  /** Original chapter id when known; null for pure artifact recoveries. */
  originalChapterId: number | null;
}

export interface ChapterRecoveryDiagnosis {
  projectId: number;
  projectName: string;
  liveChapterCount: number;
  liveChaptersWithContent: number;
  recoverableCount: number;
  orphanRevisionTargets: number;
  revisionTargets: number;
  artifactBodies: number;
  samples: Array<{ title: string; contentLength: number; source: string }>;
}

function nonEmpty(text: string | null | undefined): boolean {
  return String(text ?? '').trim().length >= MIN_BODY_CHARS;
}

/**
 * Collect candidate bodies from revisions + generation artifacts for a project.
 * Does not write anything.
 */
export async function collectRecoverableChapterBodies(
  projectId: number,
): Promise<RecoverableChapterBody[]> {
  const db = await openDatabase();
  const liveIds = new Set(
    (await getChaptersByProject(projectId)).map(c => c.id),
  );

  // Latest non-empty revision per target_id (chapter).
  const [revRes] = await db.executeSql(
    `SELECT id, target_id, title, content, created_at
     FROM content_revisions
     WHERE project_id = ? AND target_type = 'chapter'
       AND length(trim(content)) >= ?
     ORDER BY target_id ASC, created_at DESC, id DESC`,
    [projectId, MIN_BODY_CHARS],
  );
  const byTarget = new Map<number, RecoverableChapterBody>();
  for (let i = 0; i < revRes.rows.length; i++) {
    const row = revRes.rows.item(i) as {
      id: number;
      target_id: number;
      title: string;
      content: string;
      created_at: string;
    };
    if (byTarget.has(row.target_id)) continue;
    const orphan = !liveIds.has(row.target_id);
    byTarget.set(row.target_id, {
      key: `rev:${row.target_id}`,
      source: orphan ? 'orphan_revision' : 'revision',
      title: String(row.title || '').trim() || `找回章节 ${row.target_id}`,
      content: String(row.content ?? ''),
      contentLength: String(row.content ?? '').length,
      sortKey: `${String(row.target_id).padStart(10, '0')}`,
      createdAt: String(row.created_at ?? ''),
      originalChapterId: row.target_id,
    });
  }

  // Generation artifacts as fallback when no revision for that chapter.
  // Prefer newer artifacts; skip if content already covered by a revision body.
  const seenContent = new Set(
    [...byTarget.values()].map(b => b.content.trim()),
  );
  try {
    const [artRes] = await db.executeSql(
      `SELECT a.id AS artifact_id, a.content, a.content_hash, a.created_at AS art_created,
              r.chapter_id, r.target_position, r.completion_reason, r.state
       FROM continuation_generation_artifacts a
       JOIN continuation_generation_runs r ON r.id = a.run_id
       WHERE r.project_id = ?
         AND a.stage IN ('writer', 'repair', 'user_edit')
         AND length(trim(a.content)) >= ?
       ORDER BY r.target_position ASC, a.created_at DESC, a.id DESC`,
      [projectId, MIN_BODY_CHARS],
    );
    for (let i = 0; i < artRes.rows.length; i++) {
      const row = artRes.rows.item(i) as {
        artifact_id: string;
        content: string;
        content_hash: string;
        art_created: string;
        chapter_id: number;
        target_position: number;
        completion_reason: string | null;
        state: string;
      };
      const content = String(row.content ?? '');
      if (!nonEmpty(content) || seenContent.has(content.trim())) continue;
      const chapterId = Number(row.chapter_id);
      // Prefer revision for the same chapter when we already have one.
      if (byTarget.has(chapterId)) continue;
      const key = `art:${row.content_hash || row.artifact_id}`;
      if ([...byTarget.values()].some(b => b.key === key)) continue;
      byTarget.set(
        // Use negative synthetic ids so artifact-only bodies don't collide
        // with real chapter target_ids in the map.
        -Math.abs(Number(String(row.artifact_id).replace(/\D/g, '').slice(-9)) || i + 1),
        {
          key,
          source: 'generation_artifact',
          title: `找回生成章 (pos ${Number(row.target_position) + 1})`,
          content,
          contentLength: content.length,
          sortKey: `a${String(Number(row.target_position)).padStart(10, '0')}`,
          createdAt: String(row.art_created ?? ''),
          originalChapterId: Number.isFinite(chapterId) ? chapterId : null,
        },
      );
      seenContent.add(content.trim());
    }
  } catch {
    // generation tables may be absent on very old DBs — revisions alone still work
  }

  return [...byTarget.values()].sort((a, b) =>
    a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0,
  );
}

export async function diagnoseChapterRecovery(
  projectId: number,
): Promise<ChapterRecoveryDiagnosis> {
  const project = await getProjectById(projectId);
  if (!project) throw new Error('项目不存在。');
  const live = await getChaptersByProject(projectId);
  const bodies = await collectRecoverableChapterBodies(projectId);
  return {
    projectId,
    projectName: project.name,
    liveChapterCount: live.length,
    liveChaptersWithContent: live.filter(c => nonEmpty(c.content)).length,
    recoverableCount: bodies.length,
    orphanRevisionTargets: bodies.filter(b => b.source === 'orphan_revision')
      .length,
    revisionTargets: bodies.filter(
      b => b.source === 'orphan_revision' || b.source === 'revision',
    ).length,
    artifactBodies: bodies.filter(b => b.source === 'generation_artifact')
      .length,
    samples: bodies.slice(0, 5).map(b => ({
      title: b.title,
      contentLength: b.contentLength,
      source: b.source,
    })),
  };
}

export interface CreateRecoveryProjectResult {
  projectId: number;
  name: string;
  chapterCount: number;
  sources: { orphan: number; revision: number; artifact: number };
}

/**
 * Create a new continuation project and fill it with recovered chapter bodies.
 * Source project is never modified.
 */
export async function createRecoveryProject(input: {
  sourceProjectId: number;
  /** Default: 「{原名}（找回）」 */
  name?: string;
  /**
   * When true, only orphan revisions + artifacts not tied to a live chapter.
   * Use this when the live project already holds the post-accident rewrite
   * and must stay untouched as a separate timeline.
   * Default true (separate-timeline safe).
   */
  orphansAndArtifactsOnly?: boolean;
}): Promise<CreateRecoveryProjectResult> {
  const source = await getProjectById(input.sourceProjectId);
  if (!source) throw new Error('源项目不存在。');
  if (source.mode !== 'continuation') {
    throw new Error('找回章节目前仅支持原著续写项目。');
  }

  let bodies = await collectRecoverableChapterBodies(input.sourceProjectId);
  // Default true: keep post-accident rewrite in the source project only.
  const orphansOnly = input.orphansAndArtifactsOnly !== false;
  if (orphansOnly) {
    const liveIds = new Set(
      (await getChaptersByProject(input.sourceProjectId)).map(c => c.id),
    );
    bodies = bodies.filter(b => {
      if (b.source === 'orphan_revision') return true;
      if (b.source === 'generation_artifact') {
        // Artifact only if its chapter is gone (or never mapped).
        return (
          b.originalChapterId == null || !liveIds.has(b.originalChapterId)
        );
      }
      // revision for a still-live chapter belongs to the current timeline —
      // do not copy into the recovery project when isolating timelines.
      return false;
    });
  }

  if (bodies.length === 0) {
    throw new Error(
      orphansOnly
        ? '按「与当前时间线分离」规则没有找到已删除章节的修订/生成物。若旧章修订已被清理，请用备份中心的事故前备份，或导入曾导出的项目 JSON/Markdown 到新项目。当前项目里的章节不会被改动。'
        : '没有可找回的章节正文。请检查备份中心或曾导出的项目 JSON / Markdown。',
    );
  }

  const recoveryName =
    (input.name && input.name.trim()) ||
    `${source.name.replace(/（找回）\s*$/, '').trim()}（找回）`;

  const project = await createContinuationProject({ name: recoveryName });
  const seeded = await getChaptersByProject(project.id);
  // createProject seeds one empty chapter at position 0 — reuse it for the first body.
  const first = bodies[0];
  if (seeded[0]) {
    await updateChapter(seeded[0].id, {
      title: first.title,
      content: first.content,
      status: 'draft',
    });
  } else {
    const id = await createChapter(project.id, 0, first.title);
    await updateChapter(id, { content: first.content, status: 'draft' });
  }

  for (let i = 1; i < bodies.length; i++) {
    const body = bodies[i];
    const id = await createChapter(project.id, i, body.title);
    await updateChapter(id, { content: body.content, status: 'draft' });
  }

  const sources = {
    orphan: bodies.filter(b => b.source === 'orphan_revision').length,
    revision: bodies.filter(b => b.source === 'revision').length,
    artifact: bodies.filter(b => b.source === 'generation_artifact').length,
  };

  return {
    projectId: project.id,
    name: recoveryName,
    chapterCount: bodies.length,
    sources,
  };
}
