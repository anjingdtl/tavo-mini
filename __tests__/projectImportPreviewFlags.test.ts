/* eslint-env jest */
/**
 * Red Test：JSON 项目包导入预览的「包含清单」标识（B0 §2.5）。
 *
 * 预览必须告诉用户包里有哪些能力：大纲 / 人物 / 世界书 / 笔记 / 作家风格 /
 * Continuation 数据，而不是只有「章节数 / 资料数」两个数字。
 */
import {
  parseProjectPackage,
  previewProjectPackage,
} from '../src/services/projectImport';

function packageJson(overrides: Record<string, any> = {}) {
  return JSON.stringify({
    spec: 'shinewriter-project-v4',
    project: { name: '测试项目', mode: 'outline' },
    chapters: [{ id: 1, position: 0, title: '第一章', content: 'x' }],
    fragments: [],
    plotlines: [],
    resources: {
      characters: [],
      worldbookEntries: [],
      notes: [],
      presets: [],
      outlines: [],
    },
    ...overrides,
  });
}

describe('previewProjectPackage：包含清单标识', () => {
  it('v4 完整包：大纲/人物/世界书/笔记/作家风格全部为 true', () => {
    const pkg = parseProjectPackage(
      packageJson({
        resources: {
          characters: [{ id: 1, name: '甲' }],
          worldbookEntries: [{ id: 1, keyword_primary: 'k' }],
          notes: [{ id: 1, title: '笔记' }],
          presets: [{ id: 1, name: '风格', semantic_json: '{}' }],
          outlines: [{ id: 1, title: '大纲一' }],
        },
      }),
    );
    const preview = previewProjectPackage(pkg);
    expect(preview.hasCharacters).toBe(true);
    expect(preview.hasWorldbook).toBe(true);
    expect(preview.hasNotes).toBe(true);
    expect(preview.hasWriterStyle).toBe(true);
    expect(preview.hasOutlines).toBe(true);
    expect(preview.hasContinuation).toBe(false);
    expect(preview.resourceCount).toBe(5);
    expect(preview.chapterCount).toBe(1);
  });

  it('v2 最小包：全部为 false，模式回退 outline', () => {
    const pkg = parseProjectPackage(
      JSON.stringify({
        spec: 'shinewriter-project-v2',
        project: { name: '旧项目' },
        chapters: [],
        fragments: [],
        plotlines: [],
        resources: { characters: [], worldbookEntries: [], notes: [], presets: [] },
      }),
    );
    const preview = previewProjectPackage(pkg);
    expect(preview.mode).toBe('outline');
    expect(preview.name).toBe('旧项目');
    expect(preview.hasCharacters).toBe(false);
    expect(preview.hasWorldbook).toBe(false);
    expect(preview.hasNotes).toBe(false);
    expect(preview.hasWriterStyle).toBe(false);
    expect(preview.hasOutlines).toBe(false);
    expect(preview.hasContinuation).toBe(false);
  });

  it('v3 续写包：hasContinuation 为 true', () => {
    const pkg = parseProjectPackage(
      JSON.stringify({
        spec: 'shinewriter-project-v3',
        project: { name: '续写项目', mode: 'continuation' },
        chapters: [],
        fragments: [],
        plotlines: [],
        resources: { characters: [], worldbookEntries: [], notes: [], presets: [] },
        continuation: {
          sources: [{ id: 1 }],
          textChunks: [],
          sourceChapters: [],
          settings: null,
        },
      }),
    );
    const preview = previewProjectPackage(pkg);
    expect(preview.hasContinuation).toBe(true);
    expect(preview.mode).toBe('continuation');
  });

  it('普通 preset（无 semantic_json）不算作家风格', () => {
    const pkg = parseProjectPackage(
      packageJson({
        resources: {
          presets: [{ id: 1, name: '普通预设', semantic_json: null }],
        },
      }),
    );
    expect(previewProjectPackage(pkg).hasWriterStyle).toBe(false);
  });
});