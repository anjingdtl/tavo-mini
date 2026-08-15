import { sha256Hex } from '../../continuation/hashUtils';
import type {
  ContinuationContextSnapshot,
  ContinuationContextSnapshotV3,
  ContinuationContextSnapshotV5,
} from '../../continuation/generation/types';
import type { WritingSource, WritingSourceBundle } from '../contracts/writingSource';
import { assertValidWritingSourceBundle } from '../contracts/writingSourceValidation';
import { createWritingSourceTrace } from '../trace/writingSourceTrace';

type AnyContinuationSnapshot =
  | ContinuationContextSnapshot
  | ContinuationContextSnapshotV3
  | ContinuationContextSnapshotV5;

function source(input: {
  candidateId: string;
  kind: WritingSource['kind'];
  sourceId?: string | number | null;
  revision?: string | null;
  content: string;
  requirement: WritingSource['requirement'];
  activation?: WritingSource['activation'];
  metadata?: Record<string, unknown>;
}): WritingSource {
  const content = String(input.content ?? '');
  return {
    candidateId: input.candidateId,
    kind: input.kind,
    sourceId: input.sourceId ?? null,
    revision: input.revision ?? null,
    content,
    contentHash: sha256Hex(content),
    requirement: input.requirement,
    activation: input.activation ?? 'automatic',
    metadata: input.metadata,
  };
}

function listText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map(item => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      const row = item as Record<string, unknown>;
      return [row.title, row.name, row.description, row.summary, row.text]
        .filter(fieldValue => typeof fieldValue === 'string' && fieldValue.trim())
        .join('：');
    })
    .filter(Boolean)
    .join('\n');
}

function renderCanon(snapshot: AnyContinuationSnapshot): string {
  const canon = snapshot.bundles?.canon as unknown as Record<string, unknown> | undefined;
  if (!canon) return '';
  const labels: Array<[string, string]> = [
    ['世界规则', listText(canon.worldRules)],
    ['人物', listText(canon.characters)],
    ['人物状态', listText(canon.characterStates)],
    ['关系', listText(canon.relationships)],
    ['经历', listText(canon.experiences)],
    ['知识边界', listText(canon.knowledge)],
    ['情节线', listText(canon.plotThreads)],
    ['时间线', listText(canon.timelineEvents)],
  ];
  return labels
    .filter(([, text]) => text.trim())
    .map(([label, text]) => `【${label}】\n${text}`)
    .join('\n\n');
}

function styleText(snapshot: AnyContinuationSnapshot): string {
  const views = ('stageViews' in snapshot
    ? snapshot.stageViews
    : undefined) as Record<string, any> | undefined;
  const viewStyle =
    views?.draft_writer?.style?.text || views?.writer?.style?.text || '';
  if (viewStyle) return String(viewStyle);
  const frozen = snapshot.style?.frozenProfile;
  return frozen ? JSON.stringify(frozen) : '';
}

/** Convert the frozen continuation domain snapshot into the shared source contract. */
export function buildContinuationWritingSourceBundle(input: {
  snapshot: AnyContinuationSnapshot;
  userInstruction?: string;
}): WritingSourceBundle {
  const snapshot = input.snapshot;
  const userInstruction =
    input.userInstruction?.trim() || snapshot.bundles.userInstruction;
  const sourceSnapshot = snapshot.source;
  const sourceRevision = [
    sourceSnapshot.sourceVersion,
    sourceSnapshot.normalizedSha256,
    sourceSnapshot.boundary.charOffsetExclusive,
  ].join(':');
  const canonRevision = `${snapshot.canon.snapshotId}:${snapshot.canon.revision}`;
  const anchor = snapshot.primaryAnchor || {
    kind: 'source_seam' as const,
    chapterId: snapshot.source.boundary.chapterId,
    position: snapshot.source.boundary.chapterPosition,
    summary: snapshot.bundles.seam.summary,
    excerpt: snapshot.bundles.seam.excerpt,
  };
  const seamText = String(anchor.excerpt || snapshot.bundles.seam.excerpt || '');
  const canonText = renderCanon(snapshot);
  const bundle: WritingSourceBundle = {
    mandatory: [
      source({
        candidateId: 'instruction:current',
        kind: 'instruction',
        sourceId: snapshot.targetChapterId,
        revision: snapshot.inputRevisionHash,
        content: userInstruction,
        requirement: 'mandatory',
        activation: 'explicit',
      }),
      source({
        candidateId: `canon:${snapshot.canon.snapshotId}`,
        kind: 'canon',
        sourceId: snapshot.canon.snapshotId,
        revision: canonRevision,
        content: canonText,
        requirement: 'mandatory',
        activation: 'automatic',
        metadata: { canonRevision: snapshot.canon.revision },
      }),
      source({
        candidateId: `source-boundary:${sourceSnapshot.sourceId}`,
        kind: 'source_boundary',
        sourceId: sourceSnapshot.sourceId,
        revision: sourceRevision,
        content: `source=${sourceSnapshot.sourceId}; version=${sourceSnapshot.sourceVersion}; boundaryChapter=${sourceSnapshot.boundary.chapterId}; boundaryPosition=${sourceSnapshot.boundary.chapterPosition}; boundaryOffset=${sourceSnapshot.boundary.charOffsetExclusive}`,
        requirement: 'mandatory',
        activation: 'automatic',
        metadata: { boundary: sourceSnapshot.boundary },
      }),
      source({
        candidateId: `seam:${anchor.chapterId ?? sourceSnapshot.boundary.chapterId}`,
        kind: 'seam',
        sourceId: anchor.chapterId ?? sourceSnapshot.boundary.chapterId,
        revision: snapshot.inputRevisionHash,
        content: seamText,
        requirement: 'mandatory',
        activation: 'automatic',
        metadata: { anchorKind: anchor.kind, position: anchor.position },
      }),
    ],
    preferred: [],
    optional: [],
  };

  const style = styleText(snapshot);
  if (style.trim()) {
    bundle.mandatory.push(
      source({
        candidateId: `writer-style:${snapshot.style?.profileId || snapshot.projectId}`,
        kind: 'writer_style',
        sourceId: snapshot.style?.profileId || snapshot.projectId,
        revision: snapshot.style?.profileHash || snapshot.inputRevisionHash,
        content: style,
        requirement: 'mandatory',
        activation: 'system',
      }),
    );
  }

  const supplements = snapshot.bundles.supplements;
  const preferred: Array<[WritingSource['kind'], string, string, string]> = [
    ['story_memory', 'story-memory:current', snapshot.bundles.storyMemory.summary, snapshot.storyMemory.stateFingerprint],
    ['character', 'characters:active', supplements?.characterText || '', canonRevision],
    ['worldbook', 'worldbook:active', supplements?.worldbookText || '', canonRevision],
    ['note', 'notes:active', supplements?.noteText || '', snapshot.inputRevisionHash],
    ['chapter', 'chapters:recent', snapshot.bundles.recentChapters.map(item => item.excerpt).join('\n'), snapshot.inputRevisionHash],
    ['episodic_memory', 'episodic:active', snapshot.bundles.episodic.map(item => item.summary).join('\n'), snapshot.storyMemory.stateFingerprint],
  ];
  for (const [kind, candidateId, content, revision] of preferred) {
    if (!content.trim()) continue;
    bundle.preferred.push(
      source({
        candidateId,
        kind,
        sourceId: snapshot.projectId,
        revision,
        content,
        requirement: 'preferred',
        activation: 'automatic',
      }),
    );
  }
  if (supplements?.presetText?.trim()) {
    bundle.optional.push(
      source({
        candidateId: 'preset:continuation',
        kind: 'preset',
        sourceId: snapshot.projectId,
        revision: snapshot.inputRevisionHash,
        content: supplements.presetText,
        requirement: 'optional',
        activation: 'system',
      }),
    );
  }
  if (snapshot.bundles.historicalDigests?.length) {
    bundle.optional.push(
      source({
        candidateId: 'episodic-digest:historical',
        kind: 'episodic_memory',
        sourceId: snapshot.projectId,
        revision: canonRevision,
        content: snapshot.bundles.historicalDigests.map(item => item.summary).join('\n'),
        requirement: 'optional',
        activation: 'automatic',
      }),
    );
  }
  return bundle;
}

export function adaptContinuationWritingSources(input: {
  snapshot: AnyContinuationSnapshot;
  userInstruction?: string;
}): {
  bundle: WritingSourceBundle;
  trace: ReturnType<typeof createWritingSourceTrace>;
} {
  const bundle = buildContinuationWritingSourceBundle(input);
  assertValidWritingSourceBundle('continuation', bundle);
  return {
    bundle,
    trace: createWritingSourceTrace({
      scenario: 'continuation',
      sourceAdapter: 'ContinuationWritingAdapter',
      bundle,
    }),
  };
}
