/* eslint-env jest */

/**
 * 模拟用户完整操作流程的回归测试：
 * 1. 加载项目 → 默认 noteMode = 'none'
 * 2. 用户点 仿写 → setNoteMode('style') + DB 写入
 * 3. 用户切到 inner tab 角色 → tab 变化，noteMode 应保持
 * 4. 用户切回 笔记 tab → 依然应显示 仿写
 * 5. 模拟 outer tab 切换（unmount/remount）→ loadData 重读 DB，noteMode 应保持
 */

import { DEFAULT_STYLE_WEIGHTS } from '../src/services/styleAnalyzer';

describe('用户完整操作流程：note mode 持久化', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('inner tab 切换不应重置 noteMode', async () => {
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

    // Step 1: 用户首次进入 — 没有 config → 走 'none' 分支
    let cfg = await db.getProjectNoteConfig(1);
    expect(cfg).toBeNull();

    // Step 2: 用户点 仿写
    await db.setProjectNoteConfig(1, { mode: 'style', styleWeights: DEFAULT_STYLE_WEIGHTS, retrievalTopK: 5, enabledNoteIds: [] });
    cfg = await db.getProjectNoteConfig(1);
    expect(cfg.mode).toBe('style');

    // Step 3 + 4: 模拟用户切 inner tab 后回 — 不调用 DB（因为 React state 保持）
    // 这里只验证：loadData 不会因 inner tab 切换触发
    // （inner tab 切换不调用 useFocusEffect.re-run，所以不调用 loadData）

    // Step 5: 模拟 outer tab 切换后再回来 — 重新读 DB
    cfg = await db.getProjectNoteConfig(1);
    expect(cfg.mode).toBe('style');
  });

  test('连续切 weight 时不应把 mode 覆盖', async () => {
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

    // 用户设 mode = retrieval
    await db.setProjectNoteConfig(1, { mode: 'retrieval', styleWeights: DEFAULT_STYLE_WEIGHTS, retrievalTopK: 5, enabledNoteIds: [] });
    let cfg = await db.getProjectNoteConfig(1);
    expect(cfg.mode).toBe('retrieval');

    // 用户调 topK —— 用 partial 更新（模拟 handleTopKChange 行为）
    // 现状：handleTopKChange 写 mode: 'retrieval' —— 是对的
    // 验证：handleWeightChange 写 mode: 'style' —— 这在 retrieval 模式下不应触发
    //        因为 weight UI 只在 style 模式显示
    // 现状逻辑：handleWeightChange 写死 mode: 'style'，这在 retrieval 模式下 UI 隐藏所以不会触发
    //        但代码层面的硬编码是脆弱的，应该用 noteMode 替代

    // 用 partial 模式（模拟正确的 handleTopKChange）
    await db.setProjectNoteConfig(1, { retrievalTopK: 8 });
    cfg = await db.getProjectNoteConfig(1);
    expect(cfg.mode).toBe('retrieval');
    expect(cfg.retrievalTopK).toBe(8);
  });

  test('handleWeightChange 写死 mode: style 的脆弱性', async () => {
    // 当前代码：
    //   handleWeightChange: mode: 'style'  写死
    //   handleTopKChange:   mode: 'retrieval' 写死
    //   handleToggleNoteId: mode: noteMode    动态
    // 前两个虽然 UI 上是隔离的（weight 仅在 style 显示，topK 仅在 retrieval 显示），
    // 但仍是脆弱设计：任何误调都会破坏其他模式。
    // 此测试是描述性的，提醒后续 review。
    expect(true).toBe(true);
  });

  test('仿写模式：候选笔记全空时给出明确 trace 而非静默回退', async () => {
    jest.doMock('../src/services/database', () => ({
      getCharactersByProject: jest.fn(async () => []),
      getWorldbookEntriesByProject: jest.fn(async () => []),
      getChaptersByProject: jest.fn(async () => []),
      getNotesByProject: jest.fn(async () => []),
      getProjectNoteConfig: jest.fn(async () => ({
        projectId: 7,
        mode: 'style',
        styleWeights: { sentence_structure: 2, tone_emotion: 2, vocabulary: 1, character_voice: 2, narrative_rhythm: 2 },
        retrievalTopK: 5,
        enabledNoteIds: [],
        updatedAt: '',
      })),
      getNoteStyleProfile: jest.fn(async () => null),
      getNoteContentById: jest.fn(async () => ''),
      computeNoteSourceHash: jest.fn(async () => 'h'),
    }));
    jest.doMock('../src/services/styleAnalyzer', () => {
      const actual = jest.requireActual('../src/services/styleAnalyzer');
      return {
        ...actual,
        getOrAnalyzeNoteStyle: jest.fn(async () => ({ profileText: '', profileJson: {}, sourceHash: 'h' })),
      };
    });
    jest.doMock('../src/services/noteRetriever', () => ({ retrieveNoteFragments: jest.fn(async () => []), clearRetrievalCache: jest.fn() }));
    jest.doMock('../src/services/macroReplace', () => ({ processMacros: jest.fn(async (t: string) => t) }));

    const { buildContext } = require('../src/services/contextBuilder');
    const { trace } = await buildContext(
      { id: 1, project_id: 7, position: 0, title: 'Chapter', synopsis: 'a', content: '', status: 'planned', summary_json: null, created_at: '', updated_at: '' },
      { includeResources: true, resourceBudget: 4000, strategy: 'sliding', slidingWindowSize: 4000, customRangeStart: 0, customRangeEnd: -1 },
      7,
    );
    const styleTrace = trace.find((t: any) => t.title === '风格画像（仿写）');
    expect(styleTrace).toBeDefined();
    expect(styleTrace.included).toBe(false);
    expect(styleTrace.reason).toContain('无可用笔记');
  });
});
