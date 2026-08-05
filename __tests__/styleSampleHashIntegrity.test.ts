/**
 * Style-sample hash integrity — real sql.js SQLite path.
 *
 * Proves chapter.content.slice vs readBoundedEvidenceRange agreement for
 * healthy multi-chunk sources past the 65536 boundary, and that corrupt
 * sources fail integrity / SourceReader before any style LLM work.
 */
import { createCanonInMemoryDb, type InMemorySqliteDb } from './helpers/canonInMemoryDb';
import { sha256Hex } from '../src/services/continuation/hashUtils';
import {
  adjustUtf16ChunkEnd,
  assertSourceIntegrityQuick,
  checkSourceIntegrityQuick,
  ContinuationSourceIntegrityError,
} from '../src/services/continuation/sourceIntegrity';
import { sampleForStyleAnalysis } from '../src/services/continuation/styleProfile/styleSampler';
import { asUtf16Offset } from '../src/services/continuation/continuationSourceRepository';

jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: jest.fn(),
}));

import { openDatabase } from '../src/data/connection/openDatabase';
import { continuationSourceReader } from '../src/services/continuation/continuationSourceReader';

const TARGET = 65536;

async function seedSource(
  db: InMemorySqliteDb,
  opts: {
    fullText: string;
    mode: 'safe' | 'length_corrupt' | 'hash_corrupt' | 'gap' | 'overlap';
  },
): Promise<{ projectId: number; sourceId: number }> {
  const projectId = 1;
  const sourceId = 1;
  const text = opts.fullText;
  const ncc = text.length;
  const hash = sha256Hex(text);

  await db.executeSql(
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (?, 'integrity', 'continuation', 't', 't')`,
    [projectId],
  );
  await db.executeSql(
    `INSERT INTO continuation_sources
      (id, project_id, version, status, display_name, original_file_name,
       detected_encoding, raw_sha256, normalized_sha256,
       normalized_char_count, normalized_byte_count, file_size_bytes,
       chapter_count, parser_version, normalization_version, created_at, updated_at)
     VALUES (?, ?, 1, 'ready', 'src', 'src.txt', 'UTF-8', ?, ?, ?, ?, ?,
             2, 'v2', 'v1', 't', 't')`,
    [sourceId, projectId, hash, hash, ncc, ncc * 3, ncc],
  );

  // Build chunks according to mode
  if (opts.mode === 'gap') {
    const mid = Math.floor(ncc / 2);
    await putChunk(db, sourceId, 0, 0, mid - 10, text.slice(0, mid - 10));
    await putChunk(db, sourceId, 1, mid + 10, ncc, text.slice(mid + 10));
  } else if (opts.mode === 'overlap') {
    const mid = Math.floor(ncc / 2);
    await putChunk(db, sourceId, 0, 0, mid + 20, text.slice(0, mid + 20));
    // Use a different char_start to satisfy UNIQUE(source_id, char_start_offset)
    // while overlapping the previous end.
    await putChunk(db, sourceId, 1, mid, ncc, text.slice(mid));
  } else if (opts.mode === 'length_corrupt') {
    // First chunk claims TARGET length but stores TARGET-1 content units.
    const stored0 = text.slice(0, TARGET - 1);
    await putChunk(db, sourceId, 0, 0, TARGET, stored0);
    const rest = text.slice(TARGET);
    if (rest.length > 0) {
      await putChunk(db, sourceId, 1, TARGET, ncc, rest);
    }
  } else if (opts.mode === 'hash_corrupt') {
    await putChunk(db, sourceId, 0, 0, ncc, text, true);
  } else {
    // safe band flush with surrogate-aware cuts
    let start = 0;
    let idx = 0;
    while (start < ncc) {
      const cut = Math.min(
        start + adjustUtf16ChunkEnd(text.slice(start), TARGET),
        ncc,
      );
      const end = cut <= start ? Math.min(start + 1, ncc) : cut;
      await putChunk(db, sourceId, idx, start, end, text.slice(start, end));
      start = end;
      idx += 1;
    }
  }

  // Two chapters: first body ends around mid, second to EOF.
  const midChapter = Math.min(Math.floor(ncc * 0.6), Math.max(TARGET + 500, 1000));
  const ch1End = Math.min(midChapter, ncc);
  const ch1Start = 0;
  const ch2Start = ch1End;
  await db.executeSql(
    `INSERT INTO continuation_source_chapters
      (id, source_id, position, detected_title, title, content_sha256,
       char_count, paragraph_count, source_start_offset,
       content_start_offset, source_end_offset, created_at, updated_at)
     VALUES (1, ?, 0, '第一章', '第一章', ?, ?, 1, 0, ?, ?, 't', 't')`,
    [
      sourceId,
      sha256Hex(text.slice(ch1Start, ch1End)),
      ch1End - ch1Start,
      ch1Start,
      ch1End,
    ],
  );
  if (ch2Start < ncc) {
    await db.executeSql(
      `INSERT INTO continuation_source_chapters
        (id, source_id, position, detected_title, title, content_sha256,
         char_count, paragraph_count, source_start_offset,
         content_start_offset, source_end_offset, created_at, updated_at)
       VALUES (2, ?, 1, '第二章', '第二章', ?, ?, 1, ?, ?, ?, 't', 't')`,
      [
        sourceId,
        sha256Hex(text.slice(ch2Start, ncc)),
        ncc - ch2Start,
        ch2Start,
        ch2Start,
        ncc,
      ],
    );
  }

  const boundaryChapterId = ch2Start < ncc ? 2 : 1;
  await db.executeSql(
    `INSERT INTO continuation_settings
      (project_id, active_source_id, boundary_source_id, boundary_chapter_id,
       boundary_char_offset_global, boundary_mode, import_completed,
       analysis_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'end_of_source', 1, 'ready', 't', 't')`,
    [projectId, sourceId, sourceId, boundaryChapterId, ncc],
  );

  return { projectId, sourceId };
}

async function putChunk(
  db: InMemorySqliteDb,
  sourceId: number,
  chunkIndex: number,
  start: number,
  end: number,
  content: string,
  corruptHash = false,
) {
  await db.executeSql(
    `INSERT INTO continuation_source_text_chunks
      (source_id, chunk_index, char_start_offset, char_end_offset,
       content, content_sha256, file_index)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [
      sourceId,
      chunkIndex,
      start,
      end,
      content,
      corruptHash ? '0'.repeat(64) : sha256Hex(content),
    ],
  );
}

function novelPast65536(): string {
  // Ensure absolute offset TARGET-1 is a high surrogate of an emoji pair.
  return '甲'.repeat(TARGET - 1) + '😀' + '乙'.repeat(12000) + '丙'.repeat(8000);
}

describe('style sample hash integrity (real SQLite)', () => {
  let db: InMemorySqliteDb;

  beforeEach(async () => {
    db = await createCanonInMemoryDb();
    (openDatabase as jest.Mock).mockResolvedValue(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    jest.clearAllMocks();
  });

  it('healthy multi-chunk: sample path === SourceReader path past 65536', async () => {
    const fullText = novelPast65536();
    expect(fullText.length).toBeGreaterThan(TARGET + 1000);
    const { projectId, sourceId } = await seedSource(db, {
      fullText,
      mode: 'safe',
    });

    const report = await checkSourceIntegrityQuick(
      db as any,
      sourceId,
      fullText.length,
    );
    expect(report.ok).toBe(true);
    // Safe cut must not leave unpaired surrogates on chunk edges.
    expect(
      report.issues.some(i => i.code === 'chunk_surrogate_boundary'),
    ).toBe(false);

    const snapshot = await continuationSourceReader.getSnapshot(projectId);
    const chapters = await continuationSourceReader.listBoundedSourceChapters(
      snapshot,
    );
    expect(chapters.length).toBeGreaterThanOrEqual(1);

    for (const ch of chapters) {
      const reread = await continuationSourceReader.readBoundedEvidenceRange({
        snapshot,
        start: ch.range.start,
        end: ch.range.end,
      });
      expect(reread).toBe(ch.content);
      expect(sha256Hex(reread)).toBe(sha256Hex(ch.content));
    }

    // Span entirely in second chunk, classic failure window [65648, 65692)
    const absStart = TARGET + 112;
    const absEnd = absStart + 44;
    const covering = chapters.find(
      c => c.range.start <= absStart && c.range.end >= absEnd,
    );
    expect(covering).toBeTruthy();
    const samplePath = covering!.content.slice(
      absStart - covering!.range.start,
      absEnd - covering!.range.start,
    );
    const readerPath = await continuationSourceReader.readBoundedEvidenceRange({
      snapshot,
      start: asUtf16Offset(absStart),
      end: asUtf16Offset(absEnd),
    });
    expect(samplePath.length).toBe(44);
    expect(readerPath.length).toBe(44);
    expect(samplePath).toBe(readerPath);
    expect(sha256Hex(samplePath)).toBe(sha256Hex(readerPath));

    // Cross-chunk span
    const crossStart = TARGET - 20;
    const crossEnd = TARGET + 20;
    const crossCover = chapters.find(
      c => c.range.start <= crossStart && c.range.end >= crossEnd,
    );
    if (crossCover) {
      const a = crossCover.content.slice(
        crossStart - crossCover.range.start,
        crossEnd - crossCover.range.start,
      );
      const b = await continuationSourceReader.readBoundedEvidenceRange({
        snapshot,
        start: asUtf16Offset(crossStart),
        end: asUtf16Offset(crossEnd),
      });
      expect(a).toBe(b);
    }

    const refs = sampleForStyleAnalysis(chapters, 'seed|integrity|v1');
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const text = await continuationSourceReader.readBoundedEvidenceRange({
        snapshot,
        start: ref.charStart,
        end: ref.charEnd,
      });
      expect(sha256Hex(text)).toBe(ref.contentHash);
    }
  });

  it('length-corrupt chunk fails integrity and SourceReader before any sample hash', async () => {
    const fullText = '甲'.repeat(TARGET + 4000);
    const { sourceId, projectId } = await seedSource(db, {
      fullText,
      mode: 'length_corrupt',
    });
    const report = await checkSourceIntegrityQuick(
      db as any,
      sourceId,
      fullText.length,
    );
    expect(report.ok).toBe(false);
    expect(report.issues.some(i => i.code === 'chunk_length_mismatch')).toBe(
      true,
    );
    await expect(
      assertSourceIntegrityQuick(db as any, sourceId, fullText.length),
    ).rejects.toBeInstanceOf(ContinuationSourceIntegrityError);

    const snapshot = await continuationSourceReader.getSnapshot(projectId);
    await expect(
      continuationSourceReader.listBoundedSourceChapters(snapshot),
    ).rejects.toBeInstanceOf(ContinuationSourceIntegrityError);
  });

  it('hash-corrupt chunk fails integrity precheck', async () => {
    const fullText = '乙'.repeat(2000);
    const { sourceId } = await seedSource(db, {
      fullText,
      mode: 'hash_corrupt',
    });
    const report = await checkSourceIntegrityQuick(db as any, sourceId);
    expect(report.ok).toBe(false);
    expect(report.issues.some(i => i.code === 'chunk_hash_mismatch')).toBe(true);
  });

  it('chunk gap fails integrity; range read throws', async () => {
    const fullText = '丙'.repeat(5000);
    const { sourceId, projectId } = await seedSource(db, {
      fullText,
      mode: 'gap',
    });
    const report = await checkSourceIntegrityQuick(
      db as any,
      sourceId,
      fullText.length,
    );
    expect(report.ok).toBe(false);
    expect(
      report.issues.some(
        i => i.code === 'chunk_offset_gap' || i.code === 'chunk_offset_overlap',
      ),
    ).toBe(true);

    // Range that spans the hole mid-10..mid+10 must fail (not a fully-covered
    // subrange of the first chunk alone).
    const mid = Math.floor(fullText.length / 2);
    const snapshot = await continuationSourceReader.getSnapshot(projectId);
    await expect(
      continuationSourceReader.readBoundedEvidenceRange({
        snapshot,
        start: asUtf16Offset(mid - 20),
        end: asUtf16Offset(mid + 20),
      }),
    ).rejects.toBeInstanceOf(ContinuationSourceIntegrityError);
  });

  it('chunk overlap fails integrity', async () => {
    const fullText = '丁'.repeat(5000);
    const { sourceId } = await seedSource(db, {
      fullText,
      mode: 'overlap',
    });
    const report = await checkSourceIntegrityQuick(
      db as any,
      sourceId,
      fullText.length,
    );
    expect(report.ok).toBe(false);
    expect(
      report.issues.some(
        i => i.code === 'chunk_offset_overlap' || i.code === 'chunk_offset_gap',
      ),
    ).toBe(true);
  });

  it('adjustUtf16ChunkEnd keeps emoji pair intact at 65536 cut', () => {
    const text = '甲'.repeat(TARGET - 1) + '😀' + '乙'.repeat(100);
    const cut = adjustUtf16ChunkEnd(text, TARGET);
    expect(cut).toBe(TARGET - 1);
    const a = text.slice(0, cut);
    const b = text.slice(cut);
    expect(a + b).toBe(text);
    expect(a.endsWith('\uD83D') && b.startsWith('\uDE00')).toBe(false);
    expect(b.startsWith('😀')).toBe(true);
  });

  it('fresh re-seed after close still passes sample hash verification', async () => {
    const fullText = novelPast65536();
    db.close();
    db = await createCanonInMemoryDb();
    (openDatabase as jest.Mock).mockResolvedValue(db);
    const { projectId } = await seedSource(db, { fullText, mode: 'safe' });
    const snapshot = await continuationSourceReader.getSnapshot(projectId);
    const chapters = await continuationSourceReader.listBoundedSourceChapters(
      snapshot,
    );
    const refs = sampleForStyleAnalysis(chapters, 'reopen|seed');
    for (const ref of refs) {
      const text = await continuationSourceReader.readBoundedEvidenceRange({
        snapshot,
        start: ref.charStart,
        end: ref.charEnd,
      });
      expect(sha256Hex(text)).toBe(ref.contentHash);
    }
  });
});
