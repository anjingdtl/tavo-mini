/**
 * Parsing edit log — preview-time chapter edits (Spec §11.2).
 *
 * During the import preview the user can rename, merge, split, exclude and
 * reset chapters. These edits are captured as a small replayable log so the
 * underlying source/chunks are never rewritten during preview — only chapter
 * metadata is transformed. The final confirm transaction persists the edited
 * metadata in one go (Spec §11.2).
 *
 * Edits are pure functions over `ParsedChapter[]`; offsets are recomputed
 * for merge/split so the bounded reader still slices the right ranges later.
 */
import type { SourceChapterPosition } from '../../types/novel';
import type { Utf16Offset } from '../../types/novel';
import type { ParsedChapter } from './continuationParser';
import { sha256Hex } from './hashUtils';

export type ParsingEdit =
  | { kind: 'rename'; position: number; newTitle: string }
  | { kind: 'merge_with_previous'; position: number }
  | {
      kind: 'split';
      position: number;
      atOffset: Utf16Offset;
      firstTitle: string;
      secondTitle: string;
    }
  | {
      kind: 'toggle_exclusion';
      position: number;
      excluded: boolean;
      reason?: string;
    }
  | { kind: 'reset_to_detected' };

export function renameChapter(
  position: number,
  newTitle: string,
): ParsingEdit {
  return { kind: 'rename', position, newTitle };
}

export function mergeWithPrevious(position: number): ParsingEdit {
  return { kind: 'merge_with_previous', position };
}

export function splitChapter(
  position: number,
  atOffset: Utf16Offset,
  firstTitle: string,
  secondTitle: string,
): ParsingEdit {
  return { kind: 'split', position, atOffset, firstTitle, secondTitle };
}

export function toggleExclusion(
  position: number,
  excluded: boolean,
  reason?: string,
): ParsingEdit {
  return { kind: 'toggle_exclusion', position, excluded, reason };
}

export function resetToDetected(): ParsingEdit {
  return { kind: 'reset_to_detected' };
}

function renumber(chapters: ParsedChapter[]): ParsedChapter[] {
  return chapters.map((c, i) => ({
    ...c,
    position: i as SourceChapterPosition,
  }));
}

/** Apply a sequence of edits, returning the transformed chapter list. */
export function applyParsingEdits(
  chapters: ParsedChapter[],
  edits: ParsingEdit[],
): ParsedChapter[] {
  let current = chapters.map(c => ({ ...c }));

  for (const edit of edits) {
    switch (edit.kind) {
      case 'rename': {
        const idx = current.findIndex(c => c.position === edit.position);
        if (idx >= 0) {
          current[idx] = { ...current[idx], title: edit.newTitle };
        }
        break;
      }
      case 'merge_with_previous': {
        if (edit.position <= 0) break; // nothing before position 0
        const idx = current.findIndex(c => c.position === edit.position);
        if (idx <= 0) break;
        const prev = current[idx - 1];
        const cur = current[idx];
        const merged: ParsedChapter = {
          ...prev,
          sourceEndOffset: cur.sourceEndOffset,
          charCount: cur.sourceEndOffset - prev.sourceStartOffset,
          contentSha256: sha256Hex('merged'),
        };
        current.splice(idx - 1, 2, merged);
        current = renumber(current);
        break;
      }
      case 'split': {
        const idx = current.findIndex(c => c.position === edit.position);
        if (idx < 0) break;
        const ch = current[idx];
        if (
          edit.atOffset <= ch.sourceStartOffset ||
          edit.atOffset > ch.sourceEndOffset
        ) {
          throw new Error(
            `拆分偏移 ${edit.atOffset} 超出章节范围 [${ch.sourceStartOffset}, ${ch.sourceEndOffset})`,
          );
        }
        const first: ParsedChapter = {
          ...ch,
          title: edit.firstTitle,
          sourceEndOffset: edit.atOffset,
          charCount: edit.atOffset - ch.sourceStartOffset,
          contentSha256: sha256Hex('split-first'),
        };
        const second: ParsedChapter = {
          ...ch,
          title: edit.secondTitle,
          detectedTitle: edit.secondTitle,
          sourceStartOffset: edit.atOffset,
          contentStartOffset: edit.atOffset,
          charCount: ch.sourceEndOffset - edit.atOffset,
          contentSha256: sha256Hex('split-second'),
        };
        current.splice(idx, 1, first, second);
        current = renumber(current);
        break;
      }
      case 'toggle_exclusion': {
        const idx = current.findIndex(c => c.position === edit.position);
        if (idx >= 0) {
          current[idx] = {
            ...current[idx],
            isExcluded: edit.excluded,
            exclusionReason: edit.excluded ? edit.reason ?? null : null,
          };
        }
        break;
      }
      case 'reset_to_detected': {
        current = chapters.map(c => ({
          ...c,
          title: c.detectedTitle,
          isExcluded: false,
          exclusionReason: null,
        }));
        current = renumber(current);
        break;
      }
    }
  }
  return current;
}
