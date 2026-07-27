/**
 * Continuation settings + boundary service tests (Spec §9.5, §12.3, §20-9).
 *
 * Covers the boundary-resolution rules and the invalidation hook:
 *   - end_of_source resolves to the last non-excluded chapter's end offset
 *   - end_of_chapter resolves to the chosen chapter's end offset
 *   - custom_offset must lie within [content_start, source_end] of the chapter
 *   - excluded chapters cannot be the boundary
 *   - updateContinuationBoundary marks analysis_status outdated
 */
const tableState: {
  sources: any[];
  chapters: any[];
  settings: Record<number, any>;
} = { sources: [], chapters: [], settings: {} };

const mockExecuteSql = jest.fn(async (sql: string, params: any[] = []) => {
  const n = sql.replace(/\s+/g, ' ').trim();
  const res = (rows: any[]) => [
    { rows: { length: rows.length, item: (i: number) => rows[i] } },
  ];

  if (/SELECT s\.\* FROM continuation_sources/i.test(n)) {
    const [pid] = params;
    const s = tableState.settings[pid];
    const src = s ? tableState.sources.find(x => x.id === s.active_source_id) : null;
    return res(src ? [src] : []);
  }
  if (/SELECT \* FROM continuation_settings WHERE project_id/i.test(n)) {
    const [pid] = params;
    const s = tableState.settings[pid];
    return res(s ? [s] : []);
  }
  if (/SELECT \* FROM continuation_source_chapters WHERE source_id/i.test(n)) {
    const [sid] = params;
    return res(
      tableState.chapters
        .filter(c => c.source_id === sid)
        .sort((a, b) => a.position - b.position),
    );
  }
  if (/INSERT OR IGNORE INTO continuation_settings/i.test(n)) {
    const [pid] = params;
    if (!tableState.settings[pid]) {
      tableState.settings[pid] = {
        project_id: pid,
        active_source_id: 1,
        boundary_mode: 'end_of_source',
        import_completed: 0,
        analysis_status: 'not_started',
      };
    }
    return res([]);
  }
  // UPDATE continuation_settings ... (the boundary write from updateBoundaryInTx)
  if (/UPDATE continuation_settings SET/i.test(n)) {
    const pid = params[params.length - 1];
    const s = tableState.settings[pid];
    if (s) {
      s.active_source_id = params[0];
      s.boundary_source_id = params[1];
      s.boundary_chapter_id = params[2];
      s.boundary_char_offset_global = params[3];
      s.boundary_mode = params[4];
      s.analysis_status = 'outdated';
    }
    return res([]);
  }
  return res([]);
});

const mockOpenDatabase = jest.fn(async () => ({
  name: 'settings-test',
  executeSql: mockExecuteSql,
}));

jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: (...args: any[]) => (mockOpenDatabase as any)(...args),
}));

jest.mock('../src/data/connection/transaction', () => ({
  executeTransaction: jest.fn(async (db: any, statements: any[]) => {
    for (const s of statements) await db.executeSql(s.sql, s.params || []);
  }),
}));

import { updateContinuationBoundary } from '../src/services/continuation/continuationSettingsService';

function seed(opts?: { excludedChapter?: number }) {
  tableState.sources = [
    { id: 1, project_id: 5, status: 'ready', parser_version: 'v1', normalization_version: 'v1', normalized_sha256: 'h' },
  ];
  tableState.chapters = [
    { id: 10, source_id: 1, position: 0, title: '第一章', source_start_offset: 0, content_start_offset: 5, source_end_offset: 40, is_excluded: 0 },
    { id: 11, source_id: 1, position: 1, title: '第二章', source_start_offset: 40, content_start_offset: 45, source_end_offset: 80, is_excluded: opts?.excludedChapter === 1 ? 1 : 0 },
    { id: 12, source_id: 1, position: 2, title: '第三章', source_start_offset: 80, content_start_offset: 85, source_end_offset: 120, is_excluded: opts?.excludedChapter === 2 ? 1 : 0 },
  ];
  tableState.settings = {
    5: { project_id: 5, active_source_id: 1, boundary_mode: 'end_of_source' },
  };
}

describe('continuation settings / boundary service (Spec §9.5, §12.3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seed();
  });

  it('end_of_source resolves to the last non-excluded chapter end', async () => {
    await updateContinuationBoundary(5, { mode: 'end_of_source' });
    const s = tableState.settings[5];
    expect(s.boundary_chapter_id).toBe(12); // last chapter
    expect(s.boundary_char_offset_global).toBe(120);
    expect(s.boundary_mode).toBe('end_of_source');
  });

  it('end_of_source skips excluded chapters', async () => {
    seed({ excludedChapter: 2 });
    await updateContinuationBoundary(5, { mode: 'end_of_source' });
    const s = tableState.settings[5];
    expect(s.boundary_chapter_id).toBe(11); // ch 12 excluded, falls back to ch 11
    expect(s.boundary_char_offset_global).toBe(80);
  });

  it('end_of_chapter resolves to the chosen chapter end', async () => {
    await updateContinuationBoundary(5, { mode: 'end_of_chapter', chapterPosition: 1 });
    const s = tableState.settings[5];
    expect(s.boundary_chapter_id).toBe(11);
    expect(s.boundary_char_offset_global).toBe(80);
  });

  it('rejects an excluded chapter as the boundary', async () => {
    seed({ excludedChapter: 1 });
    await expect(
      updateContinuationBoundary(5, { mode: 'end_of_chapter', chapterPosition: 1 }),
    ).rejects.toThrow(/不存在或已被排除/);
  });

  it('custom_offset within the chapter body is accepted', async () => {
    // chapter 1: start 40, content_start 45, end 80; offset 60 within [45,80]
    await updateContinuationBoundary(5, {
      mode: 'custom_offset',
      chapterPosition: 1,
      charOffsetWithinChapter: 20, // start(40) + 20 = 60
    });
    const s = tableState.settings[5];
    expect(s.boundary_char_offset_global).toBe(60);
    expect(s.boundary_mode).toBe('custom_offset');
  });

  it('custom_offset before content_start is rejected', async () => {
    // 40 + 2 = 42 < content_start 45
    await expect(
      updateContinuationBoundary(5, {
        mode: 'custom_offset',
        chapterPosition: 1,
        charOffsetWithinChapter: 2,
      }),
    ).rejects.toThrow(/正文范围/);
  });

  it('custom_offset after source_end is rejected', async () => {
    // 40 + 100 = 140 > source_end 80
    await expect(
      updateContinuationBoundary(5, {
        mode: 'custom_offset',
        chapterPosition: 1,
        charOffsetWithinChapter: 100,
      }),
    ).rejects.toThrow(/正文范围/);
  });

  it('every boundary update marks analysis_status outdated (Spec §5.9)', async () => {
    await updateContinuationBoundary(5, { mode: 'end_of_source' });
    expect(tableState.settings[5].analysis_status).toBe('outdated');
  });

  it('throws when no active source exists', async () => {
    // Clear both the settings pointer AND the sources so the active-source
    // query returns nothing.
    tableState.settings = {};
    tableState.sources = [];
    await expect(
      updateContinuationBoundary(5, { mode: 'end_of_source' }),
    ).rejects.toThrow(/尚未导入原著/);
  });
});
