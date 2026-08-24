/**
 * Chapter Truth Projection — fingerprint-level facts inside ONE Frozen Context.
 *
 * Reconstructable from FrozenWritingContext. Not a second budget, not a live
 * database read, and not a duplicate of the rendered chapter body.
 */
import { sha256Hex } from '../../continuation/hashUtils';
import type { FrozenWritingContext } from './frozenWritingContext';
import type { SharedWritingStageName } from './writingPolicy';
import { stableWritingJson } from './writingFingerprint';
import type { WritingSource, WritingSourceKind } from './writingSource';

export const CHAPTER_TRUTH_PROJECTION_VERSION = 1 as const;

export interface ChapterTruthSourceRef {
  kind: WritingSourceKind;
  candidateId: string;
  contentHash: string;
  revision: string | null;
}

export interface ChapterTruthProjection {
  version: 1;
  fingerprint: string;
  requirementFingerprint: string;
  outlineFingerprint: string | null;
  canonSnapshotFingerprint: string | null;
  hardFactsFingerprint: string | null;
  sourceBoundaryFingerprint: string | null;
  previousChapterFingerprint: string | null;
  seamFingerprint: string | null;
  anchorFingerprint: string | null;
  storyMemoryFingerprint: string | null;
  structuredContinuityStateFingerprint: string | null;
  writerStyleFingerprint: string | null;
  sourceFingerprints: ChapterTruthSourceRef[];
}

const KIND_FIELDS: Array<{
  field: keyof Pick<
    ChapterTruthProjection,
    | 'outlineFingerprint'
    | 'canonSnapshotFingerprint'
    | 'sourceBoundaryFingerprint'
    | 'previousChapterFingerprint'
    | 'seamFingerprint'
    | 'anchorFingerprint'
    | 'storyMemoryFingerprint'
    | 'structuredContinuityStateFingerprint'
    | 'writerStyleFingerprint'
  >;
  kind: WritingSourceKind;
}> = [
  { field: 'outlineFingerprint', kind: 'outline' },
  { field: 'canonSnapshotFingerprint', kind: 'canon' },
  { field: 'sourceBoundaryFingerprint', kind: 'source_boundary' },
  { field: 'previousChapterFingerprint', kind: 'chapter' },
  { field: 'seamFingerprint', kind: 'seam' },
  { field: 'anchorFingerprint', kind: 'primary_anchor' },
  { field: 'storyMemoryFingerprint', kind: 'story_memory' },
  {
    field: 'structuredContinuityStateFingerprint',
    kind: 'structured_continuity_state',
  },
  { field: 'writerStyleFingerprint', kind: 'writer_style' },
];

export function flattenedFrozenSources(
  frozen: FrozenWritingContext,
): WritingSource[] {
  if (frozen.materials?.length) {
    return frozen.materials.map(item => item.source);
  }
  const bundle = frozen.sourceBundle;
  if (!bundle) return [];
  return [
    ...(bundle.mandatory || []),
    ...(bundle.preferred || []),
    ...(bundle.optional || []),
  ];
}

function refsForKind(
  sources: WritingSource[],
  kind: WritingSourceKind,
): ChapterTruthSourceRef[] {
  return sources
    .filter(source => source.kind === kind)
    .map(toSourceRef)
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}

function toSourceRef(source: WritingSource): ChapterTruthSourceRef {
  return {
    kind: source.kind,
    candidateId: source.candidateId,
    contentHash: source.contentHash,
    revision: source.revision,
  };
}

function fingerprintRefs(refs: ChapterTruthSourceRef[]): string | null {
  if (refs.length === 0) return null;
  return sha256Hex(stableWritingJson(refs));
}

export function buildChapterTruthProjection(
  frozen: FrozenWritingContext,
): ChapterTruthProjection {
  const sources = flattenedFrozenSources(frozen);
  const sourceFingerprints = sources
    .map(toSourceRef)
    .sort((left, right) =>
      `${left.kind}|${left.candidateId}`.localeCompare(
        `${right.kind}|${right.candidateId}`,
      ),
    );
  const projection: Omit<ChapterTruthProjection, 'fingerprint'> = {
    version: CHAPTER_TRUTH_PROJECTION_VERSION,
    requirementFingerprint: frozen.requirements?.fingerprint || '',
    outlineFingerprint: null,
    canonSnapshotFingerprint: null,
    hardFactsFingerprint: null,
    sourceBoundaryFingerprint: null,
    previousChapterFingerprint: null,
    seamFingerprint: null,
    anchorFingerprint: null,
    storyMemoryFingerprint: null,
    structuredContinuityStateFingerprint: null,
    writerStyleFingerprint: null,
    sourceFingerprints,
  };
  for (const item of KIND_FIELDS) {
    projection[item.field] = fingerprintRefs(refsForKind(sources, item.kind));
  }
  const factRefs = (frozen.requirements?.items || [])
    .filter(item => item.kind === 'fact' || item.kind === 'canon')
    .map(item => ({
      id: item.id,
      kind: item.kind,
      textHash: sha256Hex(item.text || ''),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  projection.hardFactsFingerprint =
    factRefs.length > 0
      ? sha256Hex(stableWritingJson(factRefs))
      : projection.canonSnapshotFingerprint;
  const fingerprint = sha256Hex(
    stableWritingJson({
      version: projection.version,
      requirementFingerprint: projection.requirementFingerprint,
      outlineFingerprint: projection.outlineFingerprint,
      canonSnapshotFingerprint: projection.canonSnapshotFingerprint,
      hardFactsFingerprint: projection.hardFactsFingerprint,
      sourceBoundaryFingerprint: projection.sourceBoundaryFingerprint,
      previousChapterFingerprint: projection.previousChapterFingerprint,
      seamFingerprint: projection.seamFingerprint,
      anchorFingerprint: projection.anchorFingerprint,
      storyMemoryFingerprint: projection.storyMemoryFingerprint,
      structuredContinuityStateFingerprint:
        projection.structuredContinuityStateFingerprint,
      writerStyleFingerprint: projection.writerStyleFingerprint,
      sourceFingerprints: projection.sourceFingerprints,
    }),
  );
  return { ...projection, fingerprint };
}

export function resolveChapterTruthProjection(
  frozen: FrozenWritingContext,
  _stage?: SharedWritingStageName,
): ChapterTruthProjection {
  const rebuilt = buildChapterTruthProjection(frozen);
  if (
    frozen.truthProjection &&
    frozen.truthProjection.fingerprint !== rebuilt.fingerprint
  ) {
    const error = Object.assign(new Error('WRITING_TRUTH_PROJECTION_DRIFT'), {
      code: 'WRITING_TRUTH_PROJECTION_DRIFT',
    });
    throw error;
  }
  return frozen.truthProjection || rebuilt;
}

export function chapterTruthProjectionDriftCode(
  frozen: FrozenWritingContext,
): string | null {
  if (!frozen.truthProjection) return null;
  const rebuilt = buildChapterTruthProjection(frozen);
  return frozen.truthProjection.fingerprint === rebuilt.fingerprint
    ? null
    : 'WRITING_TRUTH_PROJECTION_DRIFT';
}
