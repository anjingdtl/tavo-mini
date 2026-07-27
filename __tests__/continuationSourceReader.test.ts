/**
 * Bounded SourceReader invariant tests (Spec §12.3, §18.1, §23).
 *
 * These verify the cross-phase contract that Phase 2/3 will rely on:
 *  - snapshot mismatch throws `continuation_source_snapshot_outdated`
 *  - chapters past the boundary are never returned (future-source protection)
 *  - the boundary chapter is physically truncated at charOffsetExclusive
 *  - readBoundedEvidenceRange clips to the boundary
 *  - excluded chapters are skipped
 *
 * The mock DB emulates the four continuation tables with enough fidelity to
 * exercise the reader's SQL without a real SQLite instance.
 */
const tableState: {
  sources: Record<number, any>;
  chunks: any[];
  chapters: any[];
  settings: Record<number, any>;
} = {
  sources: {},
  chunks: [],
  chapters: [],
  settings: {},
};

const mockExecuteSql = jest.fn(async (sql: string, params: any[] = []) => {
  const normalized = sql.replace(/\s+/g, ' ').trim();

  function resultRows(items: any[]) {
    return {
      insertId: 0,
      rowsAffected: items.length,
      rows: {
        length: items.length,
        item: (i: number) => items[i],
      },
    };
  }

  // SELECT s.* FROM continuation_sources s JOIN continuation_settings st ...
  if (/SELECT s\.\* FROM continuation_sources/i.test(normalized)) {
    const [projectId] = params;
    const settings = tableState.settings[projectId];
    if (!settings || settings.active_source_id == null) return [resultRows([])];
    const src = tableState.sources[settings.active_source_id];
    return [resultRows(src ? [src] : [])];
  }
  // SELECT * FROM continuation_settings WHERE project_id = ?
  if (/SELECT \* FROM continuation_settings WHERE project_id/i.test(normalized)) {
    const [projectId] = params;
    const s = tableState.settings[projectId];
    return [resultRows(s ? [s] : [])];
  }
  // SELECT * FROM continuation_source_chapters WHERE source_id = ? ORDER BY position
  if (/SELECT \* FROM continuation_source_chapters WHERE source_id/i.test(normalized)) {
    const [sourceId] = params;
    const rows = tableState.chapters
      .filter(c => c.source_id === sourceId)
      .sort((a, b) => a.position - b.position);
    return [resultRows(rows)];
  }
  // SELECT content, char_start_offset, char_end_offset ... chunks range
  if (/SELECT content, char_start_offset, char_end_offset FROM continuation_source_text_chunks/i.test(normalized)) {
    const [sourceId, end, start] = params;
    const rows = tableState.chunks
      .filter(
        c =>
          c.source_id === sourceId &&
          c.char_start_offset < end &&
          c.char_end_offset > start,
      )
      .sort((a, b) => a.char_start_offset - b.char_start_offset);
    return [resultRows(rows)];
  }
  // UPDATE continuation_settings ... (boundary writes etc.)
  if (/^UPDATE continuation_settings/i.test(normalized)) {
    return [resultRows([])];
  }
  return [resultRows([])];
});

const mockOpenDatabase = jest.fn(async () => ({
  name: 'continuation-reader-test',
  executeSql: mockExecuteSql,
}));

jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: (...args: any[]) => (mockOpenDatabase as any)(...args),
}));

import { continuationSourceReader } from '../src/services/continuation/continuationSourceReader';
import {
  ContinuationSnapshotOutdatedError,
  type ContinuationSourceSnapshot,
} from '../src/services/continuation/types';
import type { Utf16Offset } from '../src/types/novel';

function offset(n: number): Utf16Offset {
  return n as Utf16Offset;
}

/** Seed a source with two chapters and one chunk covering both. */
function seedActiveSource(opts?: {
  boundaryCharOffset?: number;
  boundaryChapterId?: number;
  normalizedSha256?: string;
}): ContinuationSourceSnapshot {
  tableState.sources = {};
  tableState.chunks = [];
  tableState.chapters = [];
  tableState.settings = {};

  // Chunk: one chunk spanning chars [0, 100) with content "AAAA...BBBB...".
  // Chapter 1 occupies [0, 40), chapter 2 occupies [40, 100).
  const text = 'A'.repeat(40) + 'B'.repeat(60);
  tableState.sources[1] = {
    id: 1,
    project_id: 10,
    version: 1,
    status: 'ready',
    normalized_sha256: opts?.normalizedSha256 ?? 'hash-v1',
    parser_version: 'parser-1',
    normalization_version: 'norm-1',
  };
  tableState.chunks = [
    {
      source_id: 1,
      chunk_index: 0,
      char_start_offset: 0,
      char_end_offset: 100,
      content: text,
      content_sha256: 'chunk-hash',
    },
  ];
  tableState.chapters = [
    {
      id: 100,
      source_id: 1,
      position: 0,
      title: '第一章',
      content_start_offset: 5, // body starts after the title line
      source_start_offset: 0,
      source_end_offset: 40,
      is_excluded: 0,
    },
    {
      id: 101,
      source_id: 1,
      position: 1,
      title: '第二章',
      content_start_offset: 45,
      source_start_offset: 40,
      source_end_offset: 100,
      is_excluded: 0,
    },
  ];
  const boundaryChar = opts?.boundaryCharOffset ?? 100;
  const boundaryChapter = opts?.boundaryChapterId ?? 101;
  tableState.settings[10] = {
    project_id: 10,
    active_source_id: 1,
    boundary_source_id: 1,
    boundary_chapter_id: boundaryChapter,
    boundary_char_offset_global: boundaryChar,
    analysis_status: 'ready',
  };

  return {
    projectId: 10,
    sourceId: 1,
    sourceVersion: 1,
    normalizedSha256: 'hash-v1',
    parserVersion: 'parser-1',
    normalizationVersion: 'norm-1',
    boundary: {
      chapterId: boundaryChapter,
      chapterPosition: (boundaryChapter === 100 ? 0 : 1) as any,
      charOffsetExclusive: offset(boundaryChar),
    },
  };
}

describe('bounded continuation SourceReader (Spec §12.3, §23)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns both chapters in full when boundary is end-of-source', async () => {
    const snapshot = seedActiveSource({ boundaryCharOffset: 100 });

    const chapters = await continuationSourceReader.listBoundedSourceChapters(
      snapshot,
    );

    expect(chapters).toHaveLength(2);
    expect(chapters[0].id).toBe(100);
    expect(chapters[0].clippedByBoundary).toBe(false);
    // content_start_offset 5 → end 40 ⇒ 35 'A' chars
    expect(chapters[0].content).toBe('A'.repeat(35));
    expect(chapters[1].id).toBe(101);
    expect(chapters[1].clippedByBoundary).toBe(false);
    // content_start_offset 45 → end 100 ⇒ 55 'B' chars
    expect(chapters[1].content).toBe('B'.repeat(55));
  });

  it('truncates the boundary chapter when the boundary falls mid-chapter', async () => {
    // Boundary at char 70 ⇒ chapter 2 (40..100) is clipped to [45, 70) = 25 'B'.
    const snapshot = seedActiveSource({ boundaryCharOffset: 70 });

    const chapters = await continuationSourceReader.listBoundedSourceChapters(
      snapshot,
    );

    expect(chapters).toHaveLength(2);
    expect(chapters[1].clippedByBoundary).toBe(true);
    expect(chapters[1].content).toBe('B'.repeat(25));
    expect(chapters[1].range.end).toBe(70);
  });

  it('never returns future source past the boundary chapter', async () => {
    // Boundary at char 20 ⇒ entirely inside chapter 1 (0..40). Chapter 2 is
    // future source and must NOT be returned at all.
    const snapshot = seedActiveSource({
      boundaryCharOffset: 20,
      boundaryChapterId: 100,
    });

    const chapters = await continuationSourceReader.listBoundedSourceChapters(
      snapshot,
    );

    expect(chapters).toHaveLength(1);
    expect(chapters[0].id).toBe(100);
    expect(chapters[0].clippedByBoundary).toBe(true);
    expect(chapters.find(c => c.id === 101)).toBeUndefined();
  });

  it('throws snapshot-outdated when the live source hash changed', async () => {
    const snapshot = seedActiveSource();
    // Mutate the live source so the snapshot no longer matches.
    tableState.sources[1].normalized_sha256 = 'hash-v2';

    await expect(
      continuationSourceReader.listBoundedSourceChapters(snapshot),
    ).rejects.toBeInstanceOf(ContinuationSnapshotOutdatedError);
  });

  it('throws snapshot-outdated when the boundary moved', async () => {
    const snapshot = seedActiveSource();
    tableState.settings[10].boundary_char_offset_global = 50;

    await expect(
      continuationSourceReader.listBoundedSourceChapters(snapshot),
    ).rejects.toBeInstanceOf(ContinuationSnapshotOutdatedError);
  });

  it('throws snapshot-outdated when the source was superseded', async () => {
    const snapshot = seedActiveSource();
    tableState.settings[10].active_source_id = 999; // different source

    await expect(
      continuationSourceReader.listBoundedSourceChapters(snapshot),
    ).rejects.toBeInstanceOf(ContinuationSnapshotOutdatedError);
  });

  it('clips readBoundedEvidenceRange to the boundary', async () => {
    const snapshot = seedActiveSource({ boundaryCharOffset: 70 });

    // Request [60, 100) but boundary is 70 ⇒ should return [60, 70) = 10 'B'.
    const text = await continuationSourceReader.readBoundedEvidenceRange({
      snapshot,
      start: offset(60),
      end: offset(100),
    });
    expect(text).toBe('B'.repeat(10));
  });

  it('returns empty when the requested range is entirely past the boundary', async () => {
    const snapshot = seedActiveSource({ boundaryCharOffset: 40 });

    const text = await continuationSourceReader.readBoundedEvidenceRange({
      snapshot,
      start: offset(50),
      end: offset(80),
    });
    expect(text).toBe('');
  });

  it('rejects an illegal evidence range', async () => {
    const snapshot = seedActiveSource();
    await expect(
      continuationSourceReader.readBoundedEvidenceRange({
        snapshot,
        start: offset(80),
        end: offset(20),
      }),
    ).rejects.toThrow(/非法的证据范围/);
  });
});
