import { v4 } from '../../uuidBridge';
import { sha256Hex } from '../../continuation/hashUtils';
import type {
  OutlineWritingSourceInput,
  WritingSource,
  WritingSourceBundle,
} from '../contracts/writingSource';
import { assertValidWritingSourceBundle } from '../contracts/writingSourceValidation';
import { createWritingSourceTrace } from '../trace/writingSourceTrace';

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
  return {
    candidateId: input.candidateId,
    kind: input.kind,
    sourceId: input.sourceId ?? null,
    revision: input.revision ?? null,
    content: String(input.content ?? ''),
    contentHash: sha256Hex(String(input.content ?? '')),
    requirement: input.requirement,
    activation: input.activation ?? 'automatic',
    metadata: input.metadata,
  };
}

/**
 * Adapt the already-captured outline context. The adapter accepts semantic
 * strings only; DB rows and UI state never cross the Kernel boundary.
 */
export function buildOutlineWritingSourceBundle(
  input: OutlineWritingSourceInput,
): WritingSourceBundle {
  const chapterRevision = String(input.chapter.updated_at || input.chapter.id || input.chapter.position);
  const userInstruction =
    input.userInstruction?.trim() ||
    [input.chapter.title, input.chapter.synopsis].filter(Boolean).join('\n');
  const outlineRevision =
    input.context.outlineFingerprint ||
    sha256Hex(input.context.outlineText || '');
  const presetText = input.context.presetText || '默认中文小说写作基线';
  const bundle: WritingSourceBundle = {
    mandatory: [
      source({
        candidateId: 'instruction:current',
        kind: 'instruction',
        content: userInstruction || '请按当前章节定义继续创作。',
        requirement: 'mandatory',
        activation: 'explicit',
        metadata: { projectId: input.projectId, chapterId: input.chapter.id },
      }),
      source({
        candidateId: `chapter:${input.chapter.id ?? input.chapter.position}`,
        kind: 'chapter',
        sourceId: input.chapter.id ?? input.chapter.position,
        revision: chapterRevision,
        content: [input.chapter.title, input.chapter.synopsis]
          .filter(Boolean)
          .join('\n'),
        requirement: 'mandatory',
        activation: 'explicit',
      }),
      source({
        candidateId: 'outline:current',
        kind: 'outline',
        sourceId: input.context.outlineIds[0] ?? input.projectId,
        revision: outlineRevision,
        content: input.context.outlineText,
        requirement: 'mandatory',
        activation: 'automatic',
        metadata: {
          outlineIds: input.context.outlineIds,
          complete: input.context.outlineComplete,
        },
      }),
      source({
        candidateId: 'preset:writing',
        kind: 'preset',
        sourceId: input.projectId,
        revision: chapterRevision,
        content: presetText,
        requirement: 'mandatory',
        activation: 'system',
      }),
    ],
    preferred: [],
    optional: [],
  };

  const preferredFields: Array<[
    WritingSource['kind'],
    string,
    string,
    string
  ]> = [
    ['story_memory', 'story-memory:current', input.context.storyMemoryText, 'story-memory'],
    ['character', 'characters:active', input.context.characterText, 'characters'],
    ['worldbook', 'worldbook:active', input.context.worldbookText, 'worldbook'],
    ['episodic_memory', 'episodic:active', input.context.episodicMemoryText, 'episodic'],
    ['chapter', 'chapters:recent', input.context.recentBridgeText, 'recent-bridge'],
  ];
  for (const [kind, candidateId, content, revision] of preferredFields) {
    if (!content.trim()) continue;
    bundle.preferred.push(
      source({
        candidateId,
        kind,
        sourceId: input.projectId,
        revision,
        content,
        requirement: 'preferred',
        activation: 'automatic',
      }),
    );
  }
  if (input.context.writerStyleText?.trim()) {
    bundle.preferred.push(
      source({
        candidateId: 'writer-style:active',
        kind: 'writer_style',
        sourceId: input.projectId,
        revision: chapterRevision,
        content: input.context.writerStyleText,
        requirement: 'preferred',
        activation: 'system',
      }),
    );
  }
  if (input.context.noteText?.trim()) {
    bundle.optional.push(
      source({
        candidateId: 'note:active',
        kind: 'note',
        sourceId: input.projectId,
        revision: chapterRevision,
        content: input.context.noteText,
        requirement: 'optional',
      }),
    );
  }
  return bundle;
}

export function adaptOutlineWritingSources(input: OutlineWritingSourceInput): {
  bundle: WritingSourceBundle;
  trace: ReturnType<typeof createWritingSourceTrace>;
  writingRunId: string;
} {
  const bundle = buildOutlineWritingSourceBundle(input);
  assertValidWritingSourceBundle('outline', bundle);
  return {
    bundle,
    trace: createWritingSourceTrace({
      scenario: 'outline',
      sourceAdapter: 'OutlineWritingAdapter',
    bundle,
    }),
    writingRunId: `wr_${v4()}`,
  };
}
