/* eslint-env jest */

describe('audit regression fixes', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('exports through the Android document save flow instead of writing Downloads directly', async () => {
    jest.doMock('../src/services/database', () => ({
      getProjectById: jest.fn(async () => ({ id: 7, name: '雨城纪事' })),
      getChaptersByProject: jest.fn(async () => [{ id: 1, title: '第一章', position: 0, synopsis: '', content: '正文' }]),
    }));
    const picker = require('@react-native-documents/picker');
    const RNFS = require('react-native-fs');
    picker.saveDocuments.mockResolvedValue([{ uri: 'content://exports/rain.md', name: 'rain.md', error: null }]);

    const { exportToMarkdown } = require('../src/services/exportService');
    const result = await exportToMarkdown(7);

    expect(RNFS.writeFile).toHaveBeenCalledWith(expect.stringContaining('/tmp/cache/'), expect.any(String), 'utf8');
    expect(picker.saveDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: '雨城纪事.md',
        mimeType: 'text/markdown',
      }),
    );
    expect(result).toBe('content://exports/rain.md');
    // Cleanup: cache file should be unlinked after save
    expect(RNFS.unlink).toHaveBeenCalled();
  });

  test('includes project-enabled notes in AI resource context', async () => {
    jest.doMock('../src/services/database', () => ({
      getCharactersByProject: jest.fn(async () => []),
      getWorldbookEntriesByProject: jest.fn(async () => []),
      getNotesByProject: jest.fn(async () => [{ id: 1, title: '时间线', content: '主角必须在雨夜抵达钟楼。' }]),
      getNotesContentByIds: jest.fn(async () => ({ 1: '主角必须在雨夜抵达钟楼。' })),
      getNoteContentById: jest.fn(async () => '主角必须在雨夜抵达钟楼。'),
      getChaptersByProject: jest.fn(async () => []),
    }));
    jest.doMock('../src/services/macroReplace', () => ({ processMacros: jest.fn(async (text: string) => text) }));

    const { buildContext } = require('../src/services/contextBuilder');
    const { messages } = await buildContext(
      { id: 1, project_id: 7, position: 0, title: '第一章', synopsis: '', content: '', status: 'planned' },
      { includeResources: true, resourceBudget: 2000, strategy: 'sliding', slidingWindowSize: 4000, customRangeStart: 0, customRangeEnd: -1 },
      7,
    );

    expect(messages.map((message: any) => message.content).join('\n')).toContain('主角必须在雨夜抵达钟楼。');
  });
});
