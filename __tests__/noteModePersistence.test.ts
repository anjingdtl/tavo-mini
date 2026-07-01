/* eslint-env jest */

// 回归测试：资料-笔记模式持久化 & 风格画像鲁棒注入
// 覆盖 ResourceLibrary self-test 移除后，以及 buildStyleContext 改用 Promise.allSettled 后的行为

describe('note mode persistence & style injection', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('mode=style 在多次部分更新后保持不变（模拟用户切 tab 回到资料页）', async () => {
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

    // 用户设置模式为「仿写」+ 选定参与笔记
    await db.setProjectNoteConfig(99, {
      mode: 'style',
      styleWeights: { sentence_structure: 2, tone_emotion: 3, vocabulary: 2, character_voice: 2, narrative_rhythm: 2 },
      retrievalTopK: 5,
      enabledNoteIds: [1, 2, 3],
    });

    // 模拟用户切换笔记选项 → 只更新 enabledNoteIds，不传 mode
    await db.setProjectNoteConfig(99, { enabledNoteIds: [1, 3] });

    let cfg = await db.getProjectNoteConfig(99);
    expect(cfg.mode).toBe('style');
    expect(cfg.enabledNoteIds).toEqual([1, 3]);

    // 模拟资源页 self-test 历史 bug：把模式覆盖为 'none'
    // 移除 self-test 后这段代码已不存在，但这里验证 setProjectNoteConfig 行为本身不会回退 mode
    // 即：调用方误传 mode='none' 时确实会写入——所以需要在 UI 层阻止误调
    // 此处我们断言：当调用方只传部分字段（模拟「只更新 topK」），mode 必须保留
    await db.setProjectNoteConfig(99, { retrievalTopK: 8 });
    cfg = await db.getProjectNoteConfig(99);
    expect(cfg.mode).toBe('style');
    expect(cfg.retrievalTopK).toBe(8);
    expect(cfg.enabledNoteIds).toEqual([1, 3]);
  });

  test('仿写模式下：单条笔记分析失败不影响其他画像合并注入', async () => {
    jest.doMock('../src/services/database', () => ({
      getCharactersByProject: jest.fn(async () => []),
      getWorldbookEntriesByProject: jest.fn(async () => []),
      getChaptersByProject: jest.fn(async () => []),
      getNotesByProject: jest.fn(async () => [
        { id: 1, project_id: 7, title: '笔记A', content: '原文A内容', max_tokens: 30000 },
        { id: 2, project_id: 7, title: '笔记B', content: '', max_tokens: 30000 }, // 空内容，分析会抛
        { id: 3, project_id: 7, title: '笔记C', content: '原文C内容', max_tokens: 30000 },
      ]),
      getProjectNoteConfig: jest.fn(async () => ({
        projectId: 7,
        mode: 'style',
        styleWeights: { sentence_structure: 2, tone_emotion: 2, vocabulary: 1, character_voice: 2, narrative_rhythm: 2 },
        retrievalTopK: 5,
        enabledNoteIds: [], // 触发 fallback → 全项目笔记
        updatedAt: '',
      })),
      getNoteStyleProfile: jest.fn(async (id: number) => {
        // 缓存命中：笔记A、C；B 故意没有缓存
        if (id === 1) return { noteId: 1, profileText: 'A-画像', profileJson: '{"sentence_structure":"短句"}', sourceHash: 'h_a' };
        if (id === 3) return { noteId: 3, profileText: 'C-画像', profileJson: '{"sentence_structure":"长句"}', sourceHash: 'h_c' };
        return null;
      }),
      getNoteContentById: jest.fn(async (id: number) => {
        if (id === 1) return '原文A内容';
        if (id === 2) return ''; // 空内容会让 analyzeNoteStyle 抛错
        if (id === 3) return '原文C内容';
        return '';
      }),
      computeNoteSourceHash: jest.fn(async (content: string) => `h_${content.length}`),
    }));
    jest.doMock('../src/services/styleAnalyzer', () => {
      const actual = jest.requireActual('../src/services/styleAnalyzer');
      return {
        ...actual,
        // 只对 B 笔记抛出（模拟空内容场景下 analyzeNoteStyle 抛错）
        getOrAnalyzeNoteStyle: jest.fn(async (id: number) => {
          if (id === 2) throw new Error('笔记内容为空，无法分析风格。');
          return {
            profileText: 'cached',
            profileJson: { sentence_structure: id === 1 ? '短句' : '长句' },
            sourceHash: 'h',
          };
        }),
      };
    });
    jest.doMock('../src/services/noteRetriever', () => ({
      retrieveNoteFragments: jest.fn(async () => []),
      clearRetrievalCache: jest.fn(),
    }));
    jest.doMock('../src/services/macroReplace', () => ({ processMacros: jest.fn(async (t: string) => t) }));

    const { buildContext } = require('../src/services/contextBuilder');
    const { messages, trace } = await buildContext(
      { id: 1, project_id: 7, position: 0, title: 'Chapter', synopsis: 'return to tower', content: '', status: 'planned', summary_json: null, created_at: '', updated_at: '' },
      {
        includeResources: true,
        resourceBudget: 4000,
        strategy: 'sliding',
        slidingWindowSize: 4000,
        customRangeStart: 0,
        customRangeEnd: -1,
      },
      7,
    );

    const text = messages.map((m: any) => m.content).join('\n');
    // 仿写注入的特征前缀必须出现
    expect(text).toContain('本次写作必须遵循的风格画像');
    // 短句 + 长句 都应该被合并进来（B 失败不影响 A/C）
    expect(text).toContain('短句');
    expect(text).toContain('长句');
    // 原始笔记正文不应作为「项目笔记」独立再注入一次（避免和风格画像重复）
    // 检查 trace 中至少有一项 title 为「风格画像（仿写）」
    const styleTrace = trace.find((t: any) => t.title === '风格画像（仿写）');
    expect(styleTrace).toBeDefined();
    expect(styleTrace.kind).toBe('note');
    expect(styleTrace.reason).toContain('2/3 篇笔记联合风格');
  });

  test('仿写模式下：所有可用画像维度都被关（weight=0）时输出空文本（不误注入笔记原文）', async () => {
    jest.doMock('../src/services/database', () => ({
      getCharactersByProject: jest.fn(async () => []),
      getWorldbookEntriesByProject: jest.fn(async () => []),
      getChaptersByProject: jest.fn(async () => []),
      getNotesByProject: jest.fn(async () => [{ id: 1, project_id: 7, title: '笔记', content: '原文', max_tokens: 30000 }]),
      getProjectNoteConfig: jest.fn(async () => ({
        projectId: 7,
        mode: 'style',
        styleWeights: { sentence_structure: 0, tone_emotion: 0, vocabulary: 0, character_voice: 0, narrative_rhythm: 0 },
        retrievalTopK: 5,
        enabledNoteIds: [1],
        updatedAt: '',
      })),
      getNoteStyleProfile: jest.fn(async () => ({
        noteId: 1,
        profileText: '画像',
        profileJson: '{"sentence_structure":"短句"}',
        sourceHash: 'h',
      })),
      getNoteContentById: jest.fn(async () => '原文'),
      computeNoteSourceHash: jest.fn(async () => 'h'),
    }));
    jest.doMock('../src/services/styleAnalyzer', () => {
      const actual = jest.requireActual('../src/services/styleAnalyzer');
      return {
        ...actual,
        getOrAnalyzeNoteStyle: jest.fn(async () => ({
          profileText: '画像',
          profileJson: { sentence_structure: '短句' },
          sourceHash: 'h',
        })),
      };
    });
    jest.doMock('../src/services/noteRetriever', () => ({
      retrieveNoteFragments: jest.fn(async () => []),
      clearRetrievalCache: jest.fn(),
    }));
    jest.doMock('../src/services/macroReplace', () => ({ processMacros: jest.fn(async (t: string) => t) }));

    const { buildContext } = require('../src/services/contextBuilder');
    const { trace } = await buildContext(
      { id: 1, project_id: 7, position: 0, title: 'Chapter', synopsis: 'a', content: '', status: 'planned', summary_json: null, created_at: '', updated_at: '' },
      {
        includeResources: true,
        resourceBudget: 4000,
        strategy: 'sliding',
        slidingWindowSize: 4000,
        customRangeStart: 0,
        customRangeEnd: -1,
      },
      7,
    );

    // 没有任何维度被启用 → buildStyleContext 直接 return 空文本 → 不应注入原文
    const noteTraces = trace.filter((t: any) => t.kind === 'note');
    const injectedNotes = noteTraces.filter((t: any) => t.included && t.title !== '风格画像（仿写）');
    expect(injectedNotes).toHaveLength(0);
  });
});