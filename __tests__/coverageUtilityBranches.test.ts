/* eslint-env jest */

const mockGetCharactersByProject = jest.fn();
const mockCreateGenerationDraft = jest.fn();
const mockGetGenerationDrafts = jest.fn();
const mockDeleteGenerationDraft = jest.fn();
const mockDeleteGenerationDraftsByTarget = jest.fn();
const mockGetChapterById = jest.fn();
const mockGetChaptersByProject = jest.fn();
const mockUpdateChapter = jest.fn();
const mockCallLLM = jest.fn();

jest.mock('../src/services/database', () => ({
  getCharactersByProject: (...args: any[]) => mockGetCharactersByProject(...args),
  createGenerationDraft: (...args: any[]) => mockCreateGenerationDraft(...args),
  getGenerationDrafts: (...args: any[]) => mockGetGenerationDrafts(...args),
  deleteGenerationDraft: (...args: any[]) => mockDeleteGenerationDraft(...args),
  deleteGenerationDraftsByTarget: (...args: any[]) => mockDeleteGenerationDraftsByTarget(...args),
  getChapterById: (...args: any[]) => mockGetChapterById(...args),
  getChaptersByProject: (...args: any[]) => mockGetChaptersByProject(...args),
  updateChapter: (...args: any[]) => mockUpdateChapter(...args),
}));

jest.mock('../src/services/llm', () => ({
  callLLM: (...args: any[]) => mockCallLLM(...args),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 34 },
  PermissionsAndroid: {
    PERMISSIONS: { POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS' },
    RESULTS: { GRANTED: 'granted', DENIED: 'denied' },
    check: jest.fn(),
    request: jest.fn(),
  },
}));

import { applyPromptTemplate } from '../src/services/llm/llamaCppPromptAdapter';
import { adaptMessagesForLocalModel } from '../src/services/llm/promptAdapter';
import { processMacros } from '../src/services/macroReplace';
import { saveDraft, getDrafts, removeDraft, clearDrafts } from '../src/services/draftService';
import { batchGenerateSummaries, generateMemorySummary, generateSummary } from '../src/services/summaryGenerator';
import { useThemeStore } from '../src/store/themeStore';
import {
  clearAllIdf,
  computeMemorySummarySignature,
  getCachedIdf,
  invalidateIdf,
  setCachedIdf,
} from '../src/utils/idfCache';
import { requestNotificationPermission } from '../src/utils/notificationPermission';
import { PermissionsAndroid, Platform } from 'react-native';

const messages: any[] = [
  { role: 'system', content: '你是编辑。' },
  { role: 'user', content: '写一段。' },
  { role: 'assistant', content: '好的。' },
  { role: 'user', content: '继续。' },
];

describe('coverage branch contracts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCharactersByProject.mockResolvedValue([{ name: '林墨' }]);
    mockCreateGenerationDraft.mockResolvedValue(42);
    mockGetGenerationDrafts.mockResolvedValue([
      {
        id: 1,
        project_id: 2,
        target_type: 'chapter',
        target_id: 3,
        content: null,
        source: 'pipeline',
        pipeline_task_id: null,
        token_count: 'not-number',
        created_at: '2026-01-01',
      },
    ]);
    mockDeleteGenerationDraft.mockResolvedValue(undefined);
    mockDeleteGenerationDraftsByTarget.mockResolvedValue(undefined);
    mockGetChapterById.mockResolvedValue({
      id: 1,
      project_id: 2,
      title: '第一章',
      synopsis: '开端',
      content: '正文内容',
    });
    mockGetChaptersByProject.mockResolvedValue([]);
    mockUpdateChapter.mockResolvedValue(undefined);
    mockCallLLM.mockResolvedValue(
      JSON.stringify({
        brief: '摘要',
        plotPoints: ['事件'],
        characterStates: ['状态'],
        sceneChanges: ['场景'],
      }),
    );
    clearAllIdf();
    (PermissionsAndroid.check as jest.Mock).mockResolvedValue(false);
    (PermissionsAndroid.request as jest.Mock).mockResolvedValue(
      PermissionsAndroid.RESULTS.GRANTED,
    );
  });

  test('formats every local-model prompt family and budget branch', () => {
    const expectedTemplates = ['chatml', 'qwen', 'llama3', 'alpaca', 'phi', 'mistral', 'custom'];
    for (const template of expectedTemplates) {
      const output = applyPromptTemplate(template as any, messages);
      expect(output).toContain('继续');
    }
    expect(applyPromptTemplate('unknown' as any, messages)).toContain('assistant');
    expect(applyPromptTemplate('custom' as any, [{ role: 'user', content: '仅用户' }])).toContain('user');

    const selected = adaptMessagesForLocalModel(messages, 2000, 100);
    expect(selected.some(message => message.role === 'system')).toBe(true);
    expect(adaptMessagesForLocalModel([{ role: 'assistant', content: '历史' }], 100, 100)).toEqual([]);
    expect(adaptMessagesForLocalModel([{ role: 'user', content: '很长'.repeat(1000) }], 128, 128)).toEqual([]);
  });

  test('replaces macros, persists drafts, and maps legacy draft rows', async () => {
    await expect(
      processMacros('{{char}}/{{user}}/{{chapter}}/{{synopsis}}', {
        projectId: 1,
        chapterTitle: '第一章',
        chapterSynopsis: '开端',
        userName: '世恒哥',
      }),
    ).resolves.toBe('林墨/世恒哥/第一章/开端');
    mockGetCharactersByProject.mockResolvedValueOnce([]);
    await expect(processMacros('{{char}} {{user}}', { projectId: 1 })).resolves.toBe('角色 读者');

    await expect(saveDraft({
      projectId: 1,
      targetType: 'chapter',
      targetId: 2,
      content: '草稿',
      source: 'manual',
    })).resolves.toBe(42);
    await expect(getDrafts('chapter', 2)).resolves.toEqual([
      expect.objectContaining({ content: '', tokenCount: 0, pipelineTaskId: null }),
    ]);
    await removeDraft(42);
    await clearDrafts('chapter', 2);
    expect(mockDeleteGenerationDraft).toHaveBeenCalledWith(42);
    expect(mockDeleteGenerationDraftsByTarget).toHaveBeenCalledWith('chapter', 2);
  });

  test('covers summary success, empty response, parse errors, and batch isolation', async () => {
    await expect(generateSummary(1)).resolves.toBe(true);
    expect(mockUpdateChapter).toHaveBeenCalledWith(1, expect.objectContaining({ summary_json: expect.any(Object) }));

    mockCallLLM.mockResolvedValueOnce(null);
    await expect(generateSummary(1)).resolves.toBe(false);
    mockCallLLM.mockResolvedValueOnce('不是 JSON');
    await expect(generateSummary(1)).rejects.toThrow('有效 JSON');
    mockGetChapterById.mockResolvedValueOnce(null);
    await expect(generateSummary(1)).rejects.toThrow('章节不存在');
    mockGetChapterById.mockResolvedValueOnce({ ...mockGetChapterById.mock.results[0]?.value, content: ' ' });
    await expect(generateSummary(1)).rejects.toThrow('正文为空');

    mockGetChapterById.mockResolvedValue({ id: 1, project_id: 2, title: '第一章', synopsis: '', content: '正文' });
    mockCallLLM.mockResolvedValueOnce('{"brief":}');
    await expect(generateSummary(1)).rejects.toThrow('解析摘要 JSON 失败');

    mockCallLLM.mockResolvedValueOnce('   ');
    await expect(generateMemorySummary(1)).rejects.toThrow('记忆摘要');
    mockCallLLM.mockResolvedValueOnce('记忆摘要');
    await expect(generateMemorySummary(1, 100)).resolves.toBe('记忆摘要');
    mockGetChapterById.mockResolvedValueOnce(null);
    await expect(generateMemorySummary(1)).rejects.toThrow('章节不存在');

    mockGetChapterById.mockResolvedValue({ id: 1, project_id: 2, title: '第一章', synopsis: '', content: 'x'.repeat(120) });
    mockGetChaptersByProject.mockResolvedValue([
      { id: 1, project_id: 2, title: '第一章', synopsis: '', content: 'x'.repeat(120) },
    ]);
    mockCallLLM.mockResolvedValue('');
    await expect(batchGenerateSummaries(2)).resolves.toEqual({ success: 0, total: 1 });
    mockCallLLM.mockResolvedValue(JSON.stringify({ brief: '成功' }));
    await expect(batchGenerateSummaries(2)).resolves.toEqual({ success: 1, total: 1 });
  });

  test('covers IDF cache hit, miss, expiry, eviction, and invalidation', () => {
    const chapters: any[] = [{ memory_summary: 'abc' }, {}, { memory_summary: null }];
    expect(computeMemorySummarySignature(chapters)).toBe('3|0|0');
    expect(getCachedIdf(1, '3|0|0')).toBeNull();
    const idf = new Map([['词', 1]]);
    setCachedIdf(1, 'sig', idf);
    expect(getCachedIdf(1, 'sig')).toBe(idf);
    expect(getCachedIdf(1, 'other')).toBeNull();
    for (let projectId = 2; projectId <= 18; projectId += 1) {
      setCachedIdf(projectId, `sig-${projectId}`, new Map());
    }
    expect(getCachedIdf(1, 'sig')).toBeNull();
    setCachedIdf(99, 'expired', new Map());
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000);
    expect(getCachedIdf(99, 'expired')).toBeNull();
    nowSpy.mockRestore();
    setCachedIdf(100, 'remove', new Map());
    invalidateIdf(100);
    expect(getCachedIdf(100, 'remove')).toBeNull();
  });

  test('covers Android notification permission policy and failure paths', async () => {
    (Platform as any).OS = 'ios';
    await expect(requestNotificationPermission()).resolves.toBe(true);
    (Platform as any).OS = 'android';
    (Platform as any).Version = 32;
    await expect(requestNotificationPermission()).resolves.toBe(true);
    (Platform as any).Version = 34;
    (PermissionsAndroid.check as jest.Mock).mockResolvedValueOnce(true);
    await expect(requestNotificationPermission()).resolves.toBe(true);
    (PermissionsAndroid.check as jest.Mock).mockResolvedValueOnce(false);
    (PermissionsAndroid.request as jest.Mock).mockResolvedValueOnce(PermissionsAndroid.RESULTS.DENIED);
    await expect(requestNotificationPermission()).resolves.toBe(false);
    (PermissionsAndroid.check as jest.Mock).mockRejectedValueOnce(new Error('permission failure'));
    await expect(requestNotificationPermission()).resolves.toBe(false);
    (Platform as any).OS = 'android';
    (Platform as any).Version = 34;
  });

  test('switches theme palettes through all supported modes', () => {
    const store = useThemeStore.getState();
    store.setMode('dark');
    expect(useThemeStore.getState().theme.colors.background).toBe('#111916');
    store.setMode('eyecare');
    expect(useThemeStore.getState().theme.colors.background).toBe('#EDF2E7');
    store.setMode('light');
    expect(useThemeStore.getState().theme.colors.background).toBe('#F5F0E6');
  });
});
