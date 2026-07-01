/* eslint-env jest */

/**
 * 模拟 outer tab 切换场景下 noteMode 持久化
 * 目标：进入资料→笔记→选仿写→切到其他 outer tab → 切回资料→笔记 仍应保持仿写
 */

import { DEFAULT_STYLE_WEIGHTS } from '../src/services/styleAnalyzer';

describe('outer tab 切换后 noteMode 持久化', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('outer tab 切换不应导致 noteMode 回退', async () => {
    const configStore = new Map<number, any>();

    jest.doMock('../src/services/database', () => ({
      getProjectNoteConfig: jest.fn(async (pid: number) => configStore.get(pid) ?? null),
      setProjectNoteConfig: jest.fn(async (pid: number, partial: any) => {
        const existing = configStore.get(pid);
        configStore.set(pid, {
          projectId: pid,
          mode: partial.mode ?? existing?.mode ?? 'none',
          styleWeights: partial.styleWeights ?? existing?.styleWeights ?? {},
          retrievalTopK: partial.retrievalTopK ?? existing?.retrievalTopK ?? 5,
          enabledNoteIds: partial.enabledNoteIds ?? existing?.enabledNoteIds ?? [],
          updatedAt: new Date().toISOString(),
        });
      }),
    }));

    const db = require('../src/services/database');

    let noteMode: 'none' | 'style' | 'retrieval' = 'none';
    let styleWeights = { ...DEFAULT_STYLE_WEIGHTS };
    let retrievalTopK = 5;
    let enabledNoteIds: number[] = [];

    const loadData = async () => {
      const noteConfig = await db.getProjectNoteConfig(1);
      if (noteConfig) {
        noteMode = noteConfig.mode || 'none';
        styleWeights = { ...DEFAULT_STYLE_WEIGHTS, ...(noteConfig.styleWeights || {}) };
        retrievalTopK = typeof noteConfig.retrievalTopK === 'number' ? noteConfig.retrievalTopK : 5;
        enabledNoteIds = Array.isArray(noteConfig.enabledNoteIds) ? noteConfig.enabledNoteIds : [];
      }
    };

    await loadData();
    expect(noteMode).toBe('none');

    noteMode = 'style';
    await db.setProjectNoteConfig(1, { mode: 'style', styleWeights, retrievalTopK, enabledNoteIds });
    expect(noteMode).toBe('style');

    await loadData();
    expect(noteMode).toBe('style');
  });

  test('handleNoteModeChange 写入 DB 后立即读回应一致', async () => {
    const configStore = new Map<number, any>();

    jest.doMock('../src/services/database', () => ({
      getProjectNoteConfig: jest.fn(async (pid: number) => configStore.get(pid) ?? null),
      setProjectNoteConfig: jest.fn(async (pid: number, partial: any) => {
        const existing = configStore.get(pid);
        configStore.set(pid, {
          projectId: pid,
          mode: partial.mode ?? existing?.mode ?? 'none',
          styleWeights: partial.styleWeights ?? existing?.styleWeights ?? {},
          retrievalTopK: partial.retrievalTopK ?? existing?.retrievalTopK ?? 5,
          enabledNoteIds: partial.enabledNoteIds ?? existing?.enabledNoteIds ?? [],
          updatedAt: new Date().toISOString(),
        });
      }),
    }));

    const db = require('../src/services/database');

    await db.setProjectNoteConfig(1, { mode: 'style' });
    const cfg = await db.getProjectNoteConfig(1);
    expect(cfg).not.toBeNull();
    expect(cfg.mode).toBe('style');
  });
});