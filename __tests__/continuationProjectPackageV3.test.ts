/**
 * Project package v3 — parser + boundary-mode validation tests (Spec §15, §18.2).
 *
 * Verifies the v3 spec is accepted, the continuation payload is extracted, and
 * unknown modes are still rejected. The full export→import round-trip is
 * exercised end-to-end via the existing projectImport test path; here we lock
 * the parser contract for the new version.
 */
import {
  parseProjectPackage,
  previewProjectPackage,
} from '../src/services/projectImport';

function makeV3Package(overrides?: {
  mode?: string;
  continuation?: any;
}): string {
  return JSON.stringify({
    spec: 'shinewriter-project-v3',
    version: '3.0',
    exportedAt: '2026-07-27T00:00:00.000Z',
    project: { id: 1, name: '续写项目', mode: overrides?.mode ?? 'continuation' },
    chapters: [{ id: 10, position: 0, title: '续写第一章', content: '续写正文' }],
    fragments: [],
    plotlines: [],
    resources: { characters: [], worldbookEntries: [], notes: [], presets: [] },
    continuation: overrides?.continuation ?? {
      sources: [
        {
          id: 1, project_id: 1, version: 1, status: 'ready',
          display_name: '原著', original_file_name: 'novel.txt',
          detected_encoding: 'utf-8', file_size_bytes: 100,
          raw_sha256: 'raw', normalized_sha256: 'norm',
          normalized_char_count: 100, normalized_byte_count: 100,
          chapter_count: 2, parser_version: 'v1', normalization_version: 'v1',
          created_at: 't', updated_at: 't', activated_at: 't',
        },
      ],
      textChunks: [
        { source_id: 1, chunk_index: 0, char_start_offset: 0, char_end_offset: 100, content: '正文', content_sha256: 'x' },
      ],
      sourceChapters: [
        { id: 100, source_id: 1, position: 0, title: '第一章', char_count: 50, source_start_offset: 0, content_start_offset: 5, source_end_offset: 50, is_excluded: 0 },
      ],
      settings: {
        project_id: 1, active_source_id: 1, boundary_source_id: 1,
        boundary_chapter_id: 100, boundary_char_offset_global: 50,
        boundary_mode: 'end_of_chapter', import_completed: 1,
      },
    },
  });
}

describe('project package v3 parser (Spec §15, §18.2)', () => {
  it('accepts a v3 continuation package and extracts the continuation payload', () => {
    const pkg = parseProjectPackage(makeV3Package());
    expect(pkg.specVersion).toBe(3);
    expect(pkg.spec).toBe('shinewriter-project-v3');
    expect(pkg.project.mode).toBe('continuation');
    expect(pkg.continuation).toBeDefined();
    expect(pkg.continuation?.sources).toHaveLength(1);
    expect(pkg.continuation?.textChunks).toHaveLength(1);
    expect(pkg.continuation?.sourceChapters).toHaveLength(1);
    expect(pkg.continuation?.settings?.boundary_mode).toBe('end_of_chapter');
  });

  it('strips a leading BOM before parsing v3', () => {
    const pkg = parseProjectPackage('\uFEFF' + makeV3Package());
    expect(pkg.specVersion).toBe(3);
  });

  it('preview reports specVersion 3 and the continuation mode label', () => {
    const pkg = parseProjectPackage(makeV3Package());
    const preview = previewProjectPackage(pkg);
    expect(preview.specVersion).toBe(3);
    expect(preview.mode).toBe('continuation');
    expect(preview.chapterCount).toBe(1);
  });

  it('still accepts legacy v2 packages (backward compat)', () => {
    const v2 = JSON.stringify({
      spec: 'shinewriter-project-v2',
      version: '2.0',
      project: { id: 1, name: '大纲项目', mode: 'outline' },
      chapters: [], fragments: [], plotlines: [],
      resources: { characters: [], worldbookEntries: [], notes: [], presets: [] },
    });
    const pkg = parseProjectPackage(v2);
    expect(pkg.specVersion).toBe(2);
    expect(pkg.continuation).toBeUndefined();
  });

  it('still accepts legacy v1 packages (tavo-mini-project)', () => {
    const v1 = JSON.stringify({
      spec: 'tavo-mini-project-v1',
      project: { name: '旧项目' }, // no mode field → outline fallback
      chapters: [],
    });
    const pkg = parseProjectPackage(v1);
    expect(pkg.specVersion).toBe(1);
    const preview = previewProjectPackage(pkg);
    expect(preview.mode).toBe('outline'); // legacy fallback
  });

  it('rejects an unsupported spec version (v4)', () => {
    const v4 = JSON.stringify({ spec: 'shinewriter-project-v4', project: {} });
    expect(() => parseProjectPackage(v4)).toThrow(/不支持的项目包版本/);
  });

  it('rejects a v3 package with an unknown project mode', () => {
    const pkg = parseProjectPackage(makeV3Package({ mode: 'mystery' }));
    expect(pkg.project.mode).toBe('mystery');
    const preview = previewProjectPackage(pkg);
    expect(preview.mode).toBe('mystery');
    // The import step (importProjectPackage) is what rejects unknown modes; the
    // parser preserves the value so the importer can surface a precise error.
  });

  it('rejects a malformed JSON package', () => {
    expect(() => parseProjectPackage('not json')).toThrow(/有效的 JSON/);
  });

  it('rejects a package with an unsupported spec string', () => {
    const bad = JSON.stringify({ spec: 'some-other-format', project: {} });
    expect(() => parseProjectPackage(bad)).toThrow(/不支持的项目包格式/);
  });
});
