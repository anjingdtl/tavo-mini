/**
 * Outline v4 export/import round-trip tests (大纲创作模式升级, 阶段 13).
 *
 * Verifies the v4 spec carries outlines (title/content/source/enable/order),
 * that the parser reads them back, and that older v2 packages without outlines
 * import without error (graceful upgrade).
 */
import {
  parseProjectPackage,
  previewProjectPackage,
} from '../src/services/projectImport';

function v4PackageWithOutlines(outlines: any[]) {
  return JSON.stringify({
    spec: 'shinewriter-project-v4',
    version: '4.0',
    project: { name: '大纲项目', mode: 'outline' },
    chapters: [],
    fragments: [],
    plotlines: [],
    resources: {
      characters: [],
      worldbookEntries: [],
      notes: [],
      presets: [],
      outlines,
    },
    contextConfig: { strategy: 'sliding' },
  });
}

describe('v4 outline package parsing', () => {
  test('parses outlines with title/content/source/enable/order', () => {
    const pkg = parseProjectPackage(
      v4PackageWithOutlines([
        {
          title: '第一卷主线',
          content: '主角踏上旅程。',
          source_type: 'manual',
          source_file_name: null,
          enabled: 1,
          position: 0,
        },
        {
          title: '人物暗线',
          content: '导师身份暗线。',
          source_type: 'txt',
          source_file_name: '暗线.txt',
          enabled: 0,
          position: 1,
        },
      ]),
    );
    expect(pkg.specVersion).toBe(4);
    expect(pkg.resources.outlines).toHaveLength(2);
    expect(pkg.resources.outlines![0].title).toBe('第一卷主线');
    expect(pkg.resources.outlines![0].enabled).toBe(1);
    expect(pkg.resources.outlines![1].source_type).toBe('txt');
    expect(pkg.resources.outlines![1].enabled).toBe(0);
  });

  test('preview counts outlines in resourceCount', () => {
    const pkg = parseProjectPackage(
      v4PackageWithOutlines([
        { title: 'A', content: 'a', enabled: 1, position: 0 },
        { title: 'B', content: 'b', enabled: 0, position: 1 },
      ]),
    );
    const preview = previewProjectPackage(pkg);
    expect(preview.specVersion).toBe(4);
    expect(preview.mode).toBe('outline');
    // resourceCount includes characters + worldbook + notes + presets + outlines
    expect(preview.resourceCount).toBe(2);
  });

  test('v2 package without outlines imports without error (graceful upgrade)', () => {
    const v2 = JSON.stringify({
      spec: 'shinewriter-project-v2',
      version: '2.0',
      project: { name: '旧项目', mode: 'outline' },
      chapters: [],
      fragments: [],
      plotlines: [],
      resources: {
        characters: [],
        worldbookEntries: [],
        notes: [],
        presets: [],
      },
    });
    const pkg = parseProjectPackage(v2);
    expect(pkg.specVersion).toBe(2);
    // No outlines field on v2 → treated as empty array.
    expect(pkg.resources.outlines).toEqual([]);
  });

  test('v4 package with empty outlines array is valid', () => {
    const pkg = parseProjectPackage(v4PackageWithOutlines([]));
    expect(pkg.specVersion).toBe(4);
    expect(pkg.resources.outlines).toEqual([]);
  });

  test('v4 spec string is recognized by the version regex', () => {
    const pkg = parseProjectPackage(v4PackageWithOutlines([]));
    expect(pkg.spec).toBe('shinewriter-project-v4');
    expect(pkg.specVersion).toBe(4);
  });

  test('outlines preserve enabled state through parsing', () => {
    const pkg = parseProjectPackage(
      v4PackageWithOutlines([
        { title: 'on', content: 'x', enabled: 1, position: 0 },
        { title: 'off', content: 'y', enabled: 0, position: 1 },
      ]),
    );
    const outlines = pkg.resources.outlines!;
    expect(Number(outlines[0].enabled)).toBe(1);
    expect(Number(outlines[1].enabled)).toBe(0);
  });

  test('outlines preserve position order through parsing', () => {
    const pkg = parseProjectPackage(
      v4PackageWithOutlines([
        { title: 'second', content: 'b', enabled: 1, position: 1 },
        { title: 'first', content: 'a', enabled: 1, position: 0 },
      ]),
    );
    // The parser preserves array order as-is; importProjectPackage sorts.
    expect(pkg.resources.outlines).toHaveLength(2);
    expect(pkg.resources.outlines![0].position).toBe(1);
    expect(pkg.resources.outlines![1].position).toBe(0);
  });
});
