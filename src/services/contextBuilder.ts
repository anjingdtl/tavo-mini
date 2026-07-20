import * as db from './database';
import { processMacros } from './macroReplace';
import { clipTextToTokenBudget, estimateTokens } from '../utils/tokenEstimator';
import type { Chapter, ContextConfig, Preset } from '../types/novel';
import type { ChatMessage } from './llm';
import type { ContextTraceItem } from '../types/contextTrace';
import {
  getOrAnalyzeNoteStyle,
  mergeStyleProfiles,
  DEFAULT_STYLE_WEIGHTS,
  type StyleWeights,
} from './styleAnalyzer';
import { retrieveNoteFragments, type RetrievalQuery } from './noteRetriever';
import {
  buildPendingBridgeText,
  excludeRawFromEpisodicCandidates,
} from './storyMemory/storyMemoryCoverage';
import { renderStoryMemoryForContext } from './storyMemory/storyMemoryRenderer';
import { prepareStoryMemoryForGeneration } from './storyMemory/storyMemoryPrepare';
import {
  EPISODIC_RETRIEVAL_V2_ENABLED,
  buildEpisodicRetrievalQuery,
  collectStoryRetrievalTerms,
  findActiveStoryTerms,
  formatMemoryCandidateLine,
  orderCandidatesForDisplay,
  resolvePreviousChapterForQuery,
  scoreMemoryCandidates,
  selectCandidatesWithinTokenBudget,
  selectMemoryCandidates,
  tokenizeForMemoryRetrieval,
  type MemoryRetrievalOptions,
} from './episodicMemoryRetriever';

const DEFAULT_SYSTEM_PROMPT =
  '你是一位经验丰富的中文小说作者。请根据既有设定、人物状态、章节概要和前文内容，继续创作自然、连贯、有画面感的中文小说。';

type PartialContextConfig = Partial<ContextConfig>;

export interface BuildContextResult {
  messages: ChatMessage[];
  chapters: Chapter[];
  trace: ContextTraceItem[];
  estimatedInputTokens: number;
}

export interface BuildContextOptions {
  retrievalUserPrompt?: string;
  storyMemoryMode?: 'generation' | 'preview';
}

export async function buildStoryMemoryContext(
  projectId: number,
  currentChapter: Chapter,
  budgetTokens: number,
): Promise<{ text: string; traceItems: ContextTraceItem[] }> {
  if (typeof (db as any).getProjectStoryMemory !== 'function') {
    return { text: '', traceItems: [] };
  }
  const record = await (db as any).getProjectStoryMemory(projectId);
  // Checkpoint may lag behind the previous chapter; still inject when clean.
  // Dirty checkpoints must never be injected.
  const usable =
    record &&
    record.status === 'clean' &&
    record.state.throughChapterPosition >= 0;
  if (!usable) {
    return {
      text: '',
      traceItems: record
        ? [{
            kind: 'story_memory',
            sourceId: projectId,
            title: '全局故事状态',
            reason:
              record.status === 'empty'
                ? '故事记忆尚未初始化'
                : record.status === 'dirty'
                  ? '不注入已失效的检查点'
                  : '检查点不可用',
            estimatedTokens: 0,
            included: false,
            clipped: false,
            preview: record.lastError || '',
          }]
        : [],
    };
  }
  const rendered = renderStoryMemoryForContext(record.state, {
    currentChapter,
    budgetTokens,
  });
  return {
    text: rendered.text,
    traceItems: [{
      kind: 'story_memory',
      sourceId: projectId,
      title: '长期故事检查点',
      reason: `检查点截至第 ${record.state.throughChapterPosition + 1} 章`,
      estimatedTokens: rendered.estimatedTokens,
      included: true,
      clipped: rendered.clipped,
      preview: rendered.text.slice(0, 500),
    }],
  };
}

export async function buildContext(
  currentChapter: Chapter,
  config: ContextConfig,
  projectId: number,
  preset?: Preset | string,
  options: BuildContextOptions = {},
): Promise<BuildContextResult> {
  const trace: ContextTraceItem[] = [];
  let chapters = await db.getChaptersByProject(projectId);

  // Checkpoint / pending bridge / seam preparation. Never force catch-up to
  // previous chapter; only hard-due may spend LLM tokens (generation mode).
  let prepared: Awaited<
    ReturnType<typeof prepareStoryMemoryForGeneration>
  > | null = null;
  if (typeof (db as any).getProjectStoryMemory === 'function' || true) {
    prepared = await prepareStoryMemoryForGeneration(
      projectId,
      currentChapter,
      config,
      {
        mode: options.storyMemoryMode === 'preview' ? 'preview' : 'generation',
      },
    );
    if (prepared.blocked) {
      throw new Error(
        prepared.blockReason || '故事记忆覆盖不足，无法安全生成。',
      );
    }
    if (prepared.checkpointUpdated) {
      chapters = await db.getChaptersByProject(projectId);
    }
  }

  const coverage = prepared?.coverage;
  const rawChapterIds = coverage?.rawChapterIds || [];
  const previousChapters = chapters.filter(
    chapter => chapter.position < currentChapter.position,
  );
  const episodicCandidates = excludeRawFromEpisodicCandidates(
    previousChapters,
    rawChapterIds,
  );

  // Episodic query: title + synopsis + user prompt + content head + previous tail.
  // Entity boosts only from prepare()-usable checkpoints (never dirty/empty/failed/rebuilding).
  const previousForQuery = resolvePreviousChapterForQuery(
    previousChapters,
    currentChapter,
  );
  const episodicQuery = buildEpisodicRetrievalQuery({
    currentChapter,
    previousChapter: previousForQuery,
    retrievalUserPrompt: options.retrievalUserPrompt,
  });
  const storyStateForRetrieval = resolveStoryStateForRetrieval(prepared);
  const retrievalOptions: MemoryRetrievalOptions = {
    queryText: episodicQuery,
    storyState: storyStateForRetrieval,
  };

  // V2.2.0：IDF 缓存——同项目 memory_summary 不变时复用，避免每次 tokenize+buildIdf
  let memoryText: string;
  try {
    const idfCache = await import('../utils/idfCache');
    const signature = idfCache.computeMemorySummarySignature(episodicCandidates);
    let idf = idfCache.getCachedIdf(projectId, signature);
    if (!idf) {
      idf = buildIdf(
        episodicCandidates
          .map(c => String((c as any).memory_summary || ''))
          .filter(Boolean),
      );
      idfCache.setCachedIdf(projectId, signature, idf);
    }
    memoryText = buildMemoryContextWithIdf(
      episodicCandidates,
      currentChapter,
      idf,
      config.memoryTopK ?? 10,
      config.episodicMemoryBudgetTokens ?? config.summaryBudgetTokens ?? 20000,
      retrievalOptions,
    );
  } catch {
    // idfCache 不可用或失败时回退原始 buildMemoryContext（O(N²) 但保证正确性）
    memoryText = buildMemoryContext(
      episodicCandidates,
      currentChapter,
      config.memoryTopK ?? 10,
      config.episodicMemoryBudgetTokens ?? config.summaryBudgetTokens ?? 20000,
      retrievalOptions,
    );
  }
  const worldbookScanContent = selectPreviousChapters(
    currentChapter,
    { strategy: 'sliding', recentChapterCount: config.worldbookScanDepth ?? 4 },
    chapters,
  )
    .map(chapter => chapter.content)
    .join('\n\n');
  const scanText = [
    currentChapter.title,
    currentChapter.synopsis,
    currentChapter.content,
    worldbookScanContent,
    memoryText,
  ]
    .filter(Boolean)
    .join('\n\n');

  const systemPrompt =
    typeof preset === 'string' ? preset : buildPresetPrompt(preset);
  const rawSystemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
  // 宏替换覆盖系统提示词修复：preset.system_prompt / writing_style / extra_instructions
  // 里的 {{char}}/{{user}}/{{chapter}}/{{synopsis}} 也需要替换，否则以字面量进入 LLM
  const resolvedSystemPrompt = await processMacros(rawSystemPrompt, {
    projectId,
    chapterTitle: currentChapter.title,
    chapterSynopsis: currentChapter.synopsis,
  });
  const messages: ChatMessage[] = [
    { role: 'system', content: resolvedSystemPrompt },
  ];

  trace.push({
    kind: 'preset',
    sourceId:
      typeof preset !== 'string' && preset ? (preset as any).id ?? null : null,
    title:
      typeof preset !== 'string' && preset
        ? preset.name || '预设'
        : '系统提示词',
    reason: '系统提示词和预设配置',
    estimatedTokens: estimateTokens(resolvedSystemPrompt),
    included: true,
    clipped: false,
    preview: resolvedSystemPrompt.slice(0, 500),
  });

  // Story Memory Checkpoint (may lag behind previous chapter).
  const storyMemory = await buildStoryMemoryContext(
    projectId,
    currentChapter,
    config.storyStateBudgetTokens ?? 8000,
  );
  if (storyMemory.text) {
    messages.push({ role: 'system', content: storyMemory.text });
  }
  if (coverage) {
    const checkpointPos = coverage.checkpointThroughPosition;
    trace.push({
      kind: 'story_memory',
      sourceId: projectId,
      title: '长期故事检查点',
      reason: [
        checkpointPos >= 0
          ? `检查点截至第 ${checkpointPos + 1} 章`
          : '尚无检查点',
        coverage.hardDue ? 'hardDue' : 'coverage完整',
        coverage.uncoveredChapterIds.length
          ? `未覆盖:${coverage.uncoveredChapterIds.join(',')}`
          : '无空洞',
        rawChapterIds.length
          ? `Episodic排除raw:${rawChapterIds.join(',')}`
          : '',
      ]
        .filter(Boolean)
        .join('；'),
      estimatedTokens: storyMemory.traceItems[0]?.estimatedTokens || 0,
      included: Boolean(storyMemory.text),
      clipped: storyMemory.traceItems[0]?.clipped || false,
      preview: storyMemory.text.slice(0, 500),
    });
  } else {
    trace.push(...storyMemory.traceItems);
  }

  if (config.includeResources && config.resourceBudget > 0) {
    const { text: resourceText, traceItems: resourceTrace } =
      await buildResourceContext(
        projectId,
        config.resourceBudget,
        scanText,
        config.worldbookRecursive !== false,
        currentChapter,
        options.retrievalUserPrompt || '',
      );
    if (resourceText) {
      const resourceMessage = `以下是本次写作必须参考的设定资料：\n\n${resourceText}`;
      messages.push({ role: 'system', content: resourceMessage });
    }
    trace.push(...resourceTrace);
  }

  if (memoryText) {
    const memoryMessage = `以下是相关历史章节事件：\n\n${memoryText}`;
    messages.push({ role: 'system', content: memoryMessage });
    trace.push({
      kind: 'memory',
      sourceId: null,
      title: '相关历史章节事件',
      reason: '章节事件记忆 TF-IDF 检索（已排除 raw bridge 章节）',
      estimatedTokens: estimateTokens(memoryMessage),
      included: true,
      clipped: false,
      preview: memoryMessage.slice(0, 500),
    });
  }

  // Pending bridge + seam: prefer coverage plan; fall back to sliding window.
  let previousContent = '';
  if (coverage && coverage.pendingChapters.length > 0) {
    const byId = new Map(chapters.map(chapter => [chapter.id, chapter]));
    previousContent = buildPendingBridgeText(coverage, byId);
    if (
      coverage.seamChapter &&
      !coverage.rawChapterIds.includes(coverage.seamChapter.id)
    ) {
      const seam = coverage.seamChapter;
      const seamBlock = `【衔接章｜第 ${seam.position + 1} 章｜${
        seam.title || ''
      }】\n${seam.content}`;
      previousContent = previousContent
        ? `${previousContent}\n\n${seamBlock}`
        : seamBlock;
    }
  } else {
    previousContent = buildPreviousContentText(
      currentChapter,
      config,
      chapters,
    );
  }

  if (previousContent) {
    const processed = await processMacros(previousContent, {
      projectId,
      chapterTitle: currentChapter.title,
      chapterSynopsis: currentChapter.synopsis,
    });
    const prevMessage = `以下是检查点之后的近期正文/桥接内容，请重点承接最后发生的事件；若与长期状态冲突，以位置更晚的近期正文为准：\n\n${processed}`;
    messages.push({ role: 'user', content: prevMessage });
    trace.push({
      kind: coverage?.pendingChapters.length
        ? 'story_memory_bridge'
        : 'chapter',
      sourceId: currentChapter.id ?? null,
      title: coverage?.pendingChapters.length
        ? 'Pending Bridge / Seam'
        : '前文滑动窗口',
      reason: coverage
        ? `raw:${coverage.rawChapterIds.join(',') || '无'}; episodicFallback:${
            coverage.episodicFallbackChapterIds.join(',') || '无'
          }; tokens≈${coverage.estimatedRawTokens}`
        : '前文滑动窗口',
      estimatedTokens: estimateTokens(prevMessage),
      included: true,
      clipped: false,
      preview: prevMessage.slice(0, 500),
    });
  }

  const instructionContent = [
    `当前章节：「${
      currentChapter.title || `第 ${currentChapter.position + 1} 章`
    }」`,
    `章节概要：${
      currentChapter.synopsis || '无明确概要，请自然承接前文推进剧情。'
    }`,
  ].join('\n');
  messages.push({
    role: 'user',
    content: instructionContent,
  });
  trace.push({
    kind: 'instruction',
    sourceId: currentChapter.id ?? null,
    title: currentChapter.title || `第 ${currentChapter.position + 1} 章`,
    reason: '当前章节指令',
    estimatedTokens: estimateTokens(instructionContent),
    included: true,
    clipped: false,
    preview: instructionContent.slice(0, 500),
  });

  const estimatedInputTokens = trace.reduce(
    (sum, item) => sum + item.estimatedTokens,
    0,
  );
  return { messages, chapters, trace, estimatedInputTokens };
}

function buildPresetPrompt(preset?: Preset): string {
  if (!preset) return DEFAULT_SYSTEM_PROMPT;
  const parts = [preset.system_prompt || DEFAULT_SYSTEM_PROMPT];
  if (preset.writing_style) parts.push(`写作风格：${preset.writing_style}`);
  if (preset.extra_instructions)
    parts.push(`附加要求：${preset.extra_instructions}`);
  return parts.join('\n\n');
}

async function buildResourceContext(
  projectId: number,
  budget: number,
  scanText: string,
  recursiveWorldbook: boolean,
  currentChapter?: Chapter,
  retrievalUserPrompt = '',
): Promise<{ text: string; traceItems: ContextTraceItem[] }> {
  const parts: string[] = [];
  const allTraceItems: ContextTraceItem[] = [];
  const characterBudget = Math.floor(budget * 0.35);
  const noteBudget = Math.floor(budget * 0.2);
  const worldbookBudget = Math.max(0, budget - characterBudget - noteBudget);
  const addPart = (title: string, text: string, sectionBudget: number) => {
    if (!text || sectionBudget <= 0) return;
    const clipped = clipTextToTokenBudget(text, sectionBudget);
    if (!clipped) return;
    parts.push(`${title}：\n${clipped}`);
  };

  const [charSettled, noteSettled, wbSettled] = await Promise.allSettled([
    buildCharacterContext(projectId, characterBudget),
    buildNoteContext(
      projectId,
      noteBudget,
      scanText,
      currentChapter?.title || '',
      currentChapter?.synopsis || '',
      retrievalUserPrompt,
    ),
    buildWorldbookContext(
      projectId,
      worldbookBudget,
      scanText,
      recursiveWorldbook,
    ),
  ]);

  if (charSettled.status === 'fulfilled') {
    addPart('人物设定', charSettled.value.text, characterBudget);
    allTraceItems.push(...charSettled.value.items);
  }
  if (noteSettled.status === 'fulfilled') {
    addPart('项目笔记', noteSettled.value.text, noteBudget);
    allTraceItems.push(...noteSettled.value.items);
  }
  if (wbSettled.status === 'fulfilled') {
    addPart('世界书', wbSettled.value.text, worldbookBudget);
    allTraceItems.push(...wbSettled.value.items);
  }

  return { text: parts.join('\n\n'), traceItems: allTraceItems };
}

export async function buildCharacterContext(
  projectId: number,
  budget: number,
): Promise<{ text: string; items: ContextTraceItem[] }> {
  const characters = await db.getCharactersByProject(projectId);
  const parts: string[] = [];
  const items: ContextTraceItem[] = [];
  let remaining = budget;

  for (const character of characters as any[]) {
    const data = safeJson(character.data_json);
    const card = data.data || data;
    const charName = character.name || card.name || '未命名角色';
    const text = [
      `角色「${charName}」`,
      card.system_prompt && `角色系统提示：${card.system_prompt}`,
      card.description && `描述：${card.description}`,
      card.personality && `性格：${card.personality}`,
      card.scenario && `场景：${card.scenario}`,
      card.first_mes && `开场消息：${card.first_mes}`,
      card.mes_example && `对话示例：${card.mes_example}`,
      card.post_history_instructions &&
        `后置指令：${card.post_history_instructions}`,
    ]
      .filter(Boolean)
      .join('\n');
    const charBudget = Math.min(
      remaining,
      Number(character.max_tokens ?? 50000),
    );
    const clipped = clipTextToTokenBudget(text, charBudget);
    const wasClipped = clipped !== text && clipped.length < text.length;
    const included = clipped.length > 0;

    if (included) {
      parts.push(clipped);
      remaining -= estimateTokens(clipped);
    }

    items.push({
      kind: 'character',
      sourceId: Number(character.id) || null,
      title: charName,
      reason: `角色设定：${charName}`,
      estimatedTokens: included
        ? estimateTokens(clipped)
        : estimateTokens(text),
      included,
      clipped: wasClipped,
      preview: text.slice(0, 500),
    });

    if (remaining <= 0) break;
  }

  // Mark characters that weren't processed due to budget as clipped
  for (let i = 0; i < (characters as any[]).length; i++) {
    const character = (characters as any[])[i];
    const existingItem = items.find(it => it.sourceId === Number(character.id));
    if (!existingItem) {
      const data = safeJson(character.data_json);
      const card = data.data || data;
      const charName = character.name || card.name || '未命名角色';
      const text = [
        `角色「${charName}」`,
        card.system_prompt && `角色系统提示：${card.system_prompt}`,
        card.description && `描述：${card.description}`,
        card.personality && `性格：${card.personality}`,
        card.scenario && `场景：${card.scenario}`,
        card.first_mes && `开场消息：${card.first_mes}`,
        card.mes_example && `对话示例：${card.mes_example}`,
        card.post_history_instructions &&
          `后置指令：${card.post_history_instructions}`,
      ]
        .filter(Boolean)
        .join('\n');
      items.push({
        kind: 'character',
        sourceId: Number(character.id) || null,
        title: charName,
        reason: `角色设定：${charName}`,
        estimatedTokens: estimateTokens(text),
        included: false,
        clipped: true,
        preview: text.slice(0, 500),
      });
    }
  }

  return { text: parts.join('\n\n'), items };
}

async function buildNoteContext(
  projectId: number,
  budget: number,
  scanText: string,
  chapterTitle = '',
  chapterSynopsis = '',
  userPrompt = '',
): Promise<{ text: string; items: ContextTraceItem[] }> {
  let config;
  try {
    config = await db.getProjectNoteConfig(projectId);
  } catch {
    config = null;
  }
  const mode = config?.mode || 'none';

  if (mode === 'style') {
    return buildStyleContext(projectId, budget, config);
  }
  if (mode === 'retrieval') {
    return buildRetrievedNoteContext(
      projectId,
      budget,
      scanText,
      config,
      chapterTitle,
      chapterSynopsis,
      userPrompt,
    );
  }
  return buildNoteContextOriginal(projectId, budget);
}

// 仿写模式：注入缓存的风格画像 + 项目级要素权重
async function buildStyleContext(
  projectId: number,
  budget: number,
  config: any,
): Promise<{ text: string; items: ContextTraceItem[] }> {
  try {
    let noteIds: number[] = Array.isArray(config?.enabledNoteIds)
      ? config.enabledNoteIds
      : [];
    if (noteIds.length === 0) {
      const notes = await db.getNotesByProject(projectId);
      noteIds = notes.map((n: any) => n.id);
    }
    if (noteIds.length === 0) {
      // 没有任何候选笔记 → 不回退到原始注入（用户选的是仿写），但要明确告知
      return {
        text: '',
        items: [
          {
            kind: 'note',
            sourceId: null,
            title: '风格画像（仿写）',
            reason:
              '仿写模式已启用，但当前项目暂无可用笔记，无法生成风格画像。',
            estimatedTokens: 0,
            included: false,
            clipped: false,
            preview: '',
          },
        ],
      };
    }

    // 用 allSettled：单条笔记风格分析失败（空内容 / LLM 报错）不影响整体注入，
    // 避免整个仿写被一条坏数据拉回到原始笔记注入
    const settled = await Promise.allSettled(
      noteIds.map((id: number) => getOrAnalyzeNoteStyle(id)),
    );
    const profiles = settled
      .filter(
        (
          r,
        ): r is PromiseFulfilledResult<
          Awaited<ReturnType<typeof getOrAnalyzeNoteStyle>>
        > => r.status === 'fulfilled',
      )
      .map(r => r.value)
      .filter(p => p && p.profileJson && Object.keys(p.profileJson).length > 0);

    const weights: StyleWeights = {
      ...DEFAULT_STYLE_WEIGHTS,
      ...(config?.styleWeights || {}),
    };
    const mergedText = mergeStyleProfiles(profiles, weights);
    if (!mergedText) {
      // 有候选笔记但都没拿到可用画像（可能都为空、LLM 失败、权重全 0）
      const reasonText =
        profiles.length === 0
          ? `仿写模式：${noteIds.length} 篇候选笔记均未生成可用画像，请检查笔记内容或点击"重新分析风格"。`
          : `仿写模式：所有画像维度权重均为 0，未生成风格指令。`;
      return {
        text: '',
        items: [
          {
            kind: 'note',
            sourceId: null,
            title: '风格画像（仿写）',
            reason: reasonText,
            estimatedTokens: 0,
            included: false,
            clipped: false,
            preview: '',
          },
        ],
      };
    }

    const fullText = `以下是本次写作必须遵循的风格画像，请严格按照对应权重的维度进行仿写：\n${mergedText}`;
    const clipped = clipTextToTokenBudget(fullText, budget);
    const failedCount = noteIds.length - profiles.length;
    const reason =
      failedCount > 0
        ? `仿写模式：${profiles.length}/${noteIds.length} 篇笔记联合风格（${failedCount} 篇未生成画像）`
        : `仿写模式：${noteIds.length} 篇笔记联合风格`;
    return {
      text: clipped,
      items: [
        {
          kind: 'note',
          sourceId: null,
          title: '风格画像（仿写）',
          reason,
          estimatedTokens: estimateTokens(clipped),
          included: clipped.length > 0,
          clipped: clipped.length < fullText.length,
          preview: mergedText.slice(0, 500),
        },
      ],
    };
  } catch {
    // 风格分析失败，回退到原始全量注入
    return buildNoteContextOriginal(projectId, budget);
  }
}

// 资料库模式：LLM 检索 → 注入命中片段
async function buildRetrievedNoteContext(
  projectId: number,
  budget: number,
  scanText: string,
  config: any,
  chapterTitle = '',
  chapterSynopsis = '',
  userPrompt = '',
): Promise<{ text: string; items: ContextTraceItem[] }> {
  try {
    const topK = config?.retrievalTopK ?? 5;
    const query: RetrievalQuery = {
      chapterTitle,
      chapterSynopsis,
      previousEnding: scanText.slice(-500),
      userPrompt,
    };
    const fragments = await retrieveNoteFragments(projectId, query, topK);
    if (fragments.length === 0) {
      return {
        text: '',
        items: [
          {
            kind: 'note',
            sourceId: null,
            title: '资料库检索',
            reason:
              '未在已选笔记中找到与本章标题、概要、前文结尾或写作指令相关的内容。',
            estimatedTokens: 0,
            included: false,
            clipped: false,
            preview: '',
          },
        ],
      };
    }

    const parts = fragments.map(f => `[笔记「${f.noteTitle}」] ${f.fragment}`);
    const fullText = `以下是本次写作可参考的资料片段，请结合上下文合理引用：\n${parts.join(
      '\n',
    )}`;
    const clipped = clipTextToTokenBudget(fullText, budget);
    return {
      text: clipped,
      items: fragments.map(f => ({
        kind: 'note' as const,
        sourceId: f.noteId,
        title: f.noteTitle,
        reason: `资料库检索：${f.relevance}`,
        estimatedTokens: estimateTokens(f.fragment),
        included: true,
        clipped: false,
        preview: f.fragment.slice(0, 500),
      })),
    };
  } catch {
    return { text: '', items: [] };
  }
}

async function buildNoteContextOriginal(
  projectId: number,
  budget: number,
): Promise<{ text: string; items: ContextTraceItem[] }> {
  const notes = await db.getNotesByProject(projectId);
  const parts: string[] = [];
  const items: ContextTraceItem[] = [];
  let remaining = budget;

  // V2.2.0：bulk fetch 一次拿回所有笔记内容，避免对每条 getNoteContentById 的 N 次 round-trip。
  // 单条实现里每条笔记还会按 120k chunk 分块拉多次，所以 60 条笔记 = 上百次往返；
  // 现在统一 1 次往返 + 仅对超大笔记追加 chunk。
  let contents: Record<number, string> = {};
  if (notes.length > 0) {
    try {
      contents = await db.getNotesContentByIds(notes.map(n => Number(n.id)));
    } catch {
      // bulk 失败时回退单条，最坏情况是性能回退到老路径
      contents = {};
    }
  }

  for (const note of notes) {
    const content = contents[Number(note.id)] ?? '';
    const noteTitle = note.title || '无标题';
    const text = `笔记「${noteTitle}」：${content}`;
    const noteBudget = Math.min(remaining, note.max_tokens ?? 30000);
    const clipped = clipTextToTokenBudget(text, noteBudget);
    const wasClipped = clipped !== text && clipped.length < text.length;
    const included = clipped.length > 0;

    if (included) {
      parts.push(clipped);
      remaining -= estimateTokens(clipped);
    }

    items.push({
      kind: 'note',
      sourceId: Number(note.id) || null,
      title: noteTitle,
      reason: `项目笔记：${noteTitle}`,
      estimatedTokens: included
        ? estimateTokens(clipped)
        : estimateTokens(text),
      included,
      clipped: wasClipped,
      preview: text.slice(0, 500),
    });

    if (remaining <= 0) break;
  }

  // Mark notes that weren't processed due to budget as clipped
  const processedIds = new Set(items.map(it => it.sourceId));
  for (const note of notes) {
    if (processedIds.has(Number(note.id))) continue;
    const content = contents[Number(note.id)] ?? '';
    const noteTitle = note.title || '无标题';
    const text = `笔记「${noteTitle}」：${content}`;
    items.push({
      kind: 'note',
      sourceId: Number(note.id) || null,
      title: noteTitle,
      reason: `项目笔记：${noteTitle}`,
      estimatedTokens: estimateTokens(text),
      included: false,
      clipped: true,
      preview: text.slice(0, 500),
    });
  }

  return { text: parts.join('\n\n'), items };
}

export async function buildWorldbookContext(
  projectId: number,
  budget: number,
  scanText: string,
  recursive = true,
): Promise<{ text: string; items: ContextTraceItem[] }> {
  if (budget <= 0) return { text: '', items: [] };
  const entries = ((await db.getWorldbookEntriesByProject(projectId)) as any[])
    .filter(entry => entry.enabled !== 0 && entry.collection_enabled !== 0)
    .sort(
      (a, b) =>
        Number(a.position || 0) - Number(b.position || 0) ||
        Number(a.id || 0) - Number(b.id || 0),
    );

  const activated = new Map<number | null, any>();
  const activationReason = new Map<number | null, string>();

  const determineReason = (entry: any, haystack: string): string => {
    if (entry.constant === 1 || entry.constant === true) return '常驻';
    const primaryKeys = normalizeKeys(
      entry.keyword_primary ?? entry.key ?? entry.keys ?? entry.keyword,
    );
    if (primaryKeys.length === 0) return '常驻';
    const primaryHit = primaryKeys.some(key => includesKey(haystack, key));
    if (!primaryHit) return '';
    const secondaryKeys = normalizeKeys(
      entry.keyword_secondary ?? entry.keysecondary ?? entry.secondary_keys,
    );
    if (secondaryKeys.length === 0) return '主关键词命中';
    const secondaryHit = secondaryKeys.some(key => includesKey(haystack, key));
    return secondaryHit ? '主+次关键词命中' : '主关键词命中';
  };

  const activatePass = (haystack: string, isRecursive = false) => {
    for (const entry of entries) {
      // entry.id=0 回退 indexOf 修复：id=0 时 indexOf 当 id，可能与其他条目 id 撞号。
      // 直接取 Number(entry.id)，0 当作无效统一回退 null（activated Map 用 null key 不会撞）
      const id = Number(entry.id) || null;
      if (activated.has(id)) continue;
      const reason = determineReason(entry, haystack);
      if (reason) {
        activated.set(id, entry);
        activationReason.set(id, isRecursive ? '递归命中' : reason);
      }
    }
  };

  activatePass(scanText);
  if (recursive && activated.size > 0) {
    activatePass(
      `${scanText}\n\n${Array.from(activated.values())
        .map(entry => entry.content || '')
        .join('\n')}`,
      true,
    );
  }

  const collectionUsage = new Map<number, number>();
  const lines: string[] = [];
  const items: ContextTraceItem[] = [];
  let remaining = budget;
  for (const entry of activated.values()) {
    const id = Number(entry.id);
    const entryContent = String(entry.content || '');
    const label = normalizeKeys(
      entry.keyword_primary ?? entry.key ?? entry.keys ?? entry.keyword,
    )[0];
    const reason = activationReason.get(id) || '主关键词命中';
    const entryBudget = Math.min(remaining, Number(entry.max_tokens ?? 2000));

    const collectionId = Number(entry.collection_id || 0);
    const collectionBudget = Number(entry.collection_max_tokens ?? 50000);
    const used = collectionUsage.get(collectionId) || 0;
    const remainingForCollection = Math.max(0, collectionBudget - used);

    if (remainingForCollection <= 0 || entryBudget <= 0) {
      items.push({
        kind: 'worldbook',
        sourceId: id || null,
        title: label || `条目#${id}`,
        reason,
        estimatedTokens: estimateTokens(entryContent),
        included: false,
        clipped: true,
        preview: entryContent.slice(0, 500),
      });
      continue;
    }

    const effectiveBudget = Math.min(entryBudget, remainingForCollection);
    const body = clipTextToTokenBudget(entryContent, effectiveBudget);
    const wasClipped =
      body !== entryContent && body.length < entryContent.length;
    const included = body.length > 0;

    if (included) {
      const line = label ? `关键词「${label}」：${body}` : body;
      lines.push(line);
      const tokenCost = estimateTokens(body);
      collectionUsage.set(collectionId, used + tokenCost);
      remaining -= tokenCost;
    }

    items.push({
      kind: 'worldbook',
      sourceId: id || null,
      title: label || `条目#${id}`,
      reason,
      estimatedTokens: included
        ? estimateTokens(body)
        : estimateTokens(entryContent),
      included,
      clipped: wasClipped || !included,
      preview: entryContent.slice(0, 500),
    });

    if (remaining <= 0) break;
  }

  // Mark entries that were activated but not processed due to budget
  for (const [id, entry] of activated) {
    const existingItem = items.find(it => it.sourceId === id);
    if (!existingItem) {
      const entryContent = String(entry.content || '');
      const label = normalizeKeys(
        entry.keyword_primary ?? entry.key ?? entry.keys ?? entry.keyword,
      )[0];
      const reason = activationReason.get(id) || '主关键词命中';
      items.push({
        kind: 'worldbook',
        sourceId: id || null,
        title: label || `条目#${id}`,
        reason,
        estimatedTokens: estimateTokens(entryContent),
        included: false,
        clipped: true,
        preview: entryContent.slice(0, 500),
      });
    }
  }

  return { text: lines.join('\n'), items };
}

function includesKey(text: string, key: string): boolean {
  return text.toLocaleLowerCase().includes(key.toLocaleLowerCase());
}

function normalizeKeys(raw: any): string[] {
  if (Array.isArray(raw))
    return raw
      .map(String)
      .map(item => item.trim())
      .filter(Boolean);
  if (typeof raw === 'string')
    return raw
      .split(/[,，\n]/)
      .map(item => item.trim())
      .filter(Boolean);
  return [];
}

export function selectPreviousChapters(
  currentChapter: Chapter,
  config: PartialContextConfig,
  chapters: Chapter[],
): Chapter[] {
  const previous = chapters
    .filter(
      chapter =>
        chapter.position < currentChapter.position && Boolean(chapter.content),
    )
    .sort((a, b) => a.position - b.position);

  if (config.strategy === 'full') return previous;

  if (config.strategy === 'custom') {
    const start = Math.max(0, Number(config.customRangeStart ?? 0));
    const end = Number(config.customRangeEnd ?? -1);
    return previous.filter(
      chapter =>
        chapter.position >= start && (end < 0 || chapter.position <= end),
    );
  }

  const recentCount = Math.max(1, Number(config.recentChapterCount ?? 3));
  return previous.slice(-recentCount);
}

export function buildPreviousContentText(
  currentChapter: Chapter,
  config: PartialContextConfig,
  chapters: Chapter[],
): string {
  const selected = selectPreviousChapters(currentChapter, config, chapters);
  const text = selected
    .map(
      chapter =>
        `第 ${chapter.position + 1} 章「${chapter.title || '未命名'}」\n${
          chapter.content
        }`,
    )
    .join('\n\n');
  return clipTextTailToTokenBudget(
    text,
    Number(config.slidingWindowSize || 50000),
  );
}

function clipTextTailToTokenBudget(text: string, budget: number): string {
  if (budget <= 0 || !text) return '';
  // O(n²) 拼接修复：先反向遍历累计 token 找到起始下标，最后 slice，整体 O(n)
  let used = 0;
  let startIdx = text.length;
  for (let index = text.length - 1; index >= 0; index--) {
    const char = text[index];
    const nextCost = estimateTokens(char);
    if (used + nextCost > budget) break;
    used += nextCost;
    startIdx = index;
  }
  return text.slice(startIdx).trimStart();
}

export function buildMemoryContext(
  previousChapters: Chapter[],
  currentChapter: Chapter,
  topK: number,
  budgetTokens: number,
  options?: MemoryRetrievalOptions,
): string {
  const docs = previousChapters
    .map(chapter => ({
      chapter,
      text: String((chapter as any).memory_summary || ''),
    }))
    .filter(item => item.text.trim());

  if (docs.length === 0 || topK <= 0 || budgetTokens <= 0) return '';

  const idf = buildIdf(docs.map(doc => doc.text));
  return assembleMemoryContextFromIdf(
    docs,
    currentChapter,
    idf,
    topK,
    budgetTokens,
    options,
  );
}

/**
 * V2.2.0：用预先计算/缓存好的 IDF 直接召回，避免 O(N) tokenize+buildIdf。
 */
export function buildMemoryContextWithIdf(
  previousChapters: Chapter[],
  currentChapter: Chapter,
  idf: Map<string, number>,
  topK: number,
  budgetTokens: number,
  options?: MemoryRetrievalOptions,
): string {
  const docs = previousChapters
    .map(chapter => ({
      chapter,
      text: String((chapter as any).memory_summary || ''),
    }))
    .filter(item => item.text.trim());

  if (docs.length === 0 || topK <= 0 || budgetTokens <= 0 || idf.size === 0)
    return '';
  return assembleMemoryContextFromIdf(
    docs,
    currentChapter,
    idf,
    topK,
    budgetTokens,
    options,
  );
}

/**
 * Only use Story Memory state that prepareStoryMemoryForGeneration marked usable.
 * Dirty / empty / failed / rebuilding / missing / unreadable → null (TF-IDF only).
 */
export function resolveStoryStateForRetrieval(
  prepared: Awaited<ReturnType<typeof prepareStoryMemoryForGeneration>> | null,
): MemoryRetrievalOptions['storyState'] {
  try {
    const record = prepared?.checkpoint;
    if (!record?.state) return null;
    const status = record.status;
    if (
      status === 'dirty' ||
      status === 'empty' ||
      status === 'failed' ||
      status === 'rebuilding'
    ) {
      return null;
    }
    return record.state;
  } catch {
    return null;
  }
}

function assembleMemoryContextFromIdf(
  docs: Array<{ chapter: Chapter; text: string }>,
  currentChapter: Chapter,
  idf: Map<string, number>,
  topK: number,
  budgetTokens: number,
  options?: MemoryRetrievalOptions,
): string {
  const legacyQuery = `${currentChapter.title}\n${currentChapter.synopsis}\n${
    currentChapter.content?.slice(0, 500) || ''
  }`;
  const query =
    (options?.queryText && options.queryText.trim()) ||
    legacyQuery.trim() ||
    `${currentChapter.title || ''}\n${currentChapter.synopsis || ''}`.trim();

  let priorityDocs: Array<{ chapter: Chapter; text: string }>;

  if (EPISODIC_RETRIEVAL_V2_ENABLED) {
    if (!query) {
      // Empty query: most recent valid summaries first (priority), budget later.
      priorityDocs = [...docs]
        .sort((a, b) => {
          if (b.chapter.position !== a.chapter.position) {
            return b.chapter.position - a.chapter.position;
          }
          return a.chapter.id - b.chapter.id;
        })
        .slice(0, topK);
    } else {
      // Collect Story Memory terms once per retrieval; pass into scorer (no recompute).
      const storyTerms = collectStoryRetrievalTerms(options?.storyState ?? null);
      const active = findActiveStoryTerms(query, storyTerms);
      const scored = scoreMemoryCandidates(
        docs,
        query,
        idf,
        options?.storyState ?? null,
        cosineSimilarity,
        vectorize,
        { storyTerms, activeTerms: active },
      );
      const selected = selectMemoryCandidates(scored, active, topK);
      // Budget by hybrid priority first — do not chronological-sort before budget.
      const budgeted = selectCandidatesWithinTokenBudget(selected, budgetTokens);
      const ordered = orderCandidatesForDisplay(budgeted);
      return ordered.map(item => formatMemoryCandidateLine(item)).join('\n');
    }
  } else {
    const queryVector = vectorize(query || legacyQuery, idf);
    priorityDocs = docs
      .map(doc => ({
        ...doc,
        score: cosineSimilarity(queryVector, vectorize(doc.text, idf)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  // Legacy / empty-query path: budget in priority order, then display chronologically.
  const budgeted: Array<{ chapter: Chapter; text: string }> = [];
  let remaining = budgetTokens;
  for (const item of priorityDocs) {
    if (remaining <= 0) break;
    const line = formatMemoryCandidateLine(item);
    const cost = estimateTokens(line);
    if (cost <= remaining) {
      budgeted.push(item);
      remaining -= cost;
      continue;
    }
    if (budgeted.length === 0) {
      const clipped = clipTextToTokenBudget(line, remaining);
      if (!clipped) continue;
      const prefix = `第 ${item.chapter.position + 1} 章「${
        item.chapter.title
      }」摘要：`;
      budgeted.push({
        chapter: item.chapter,
        text: clipped.startsWith(prefix) ? clipped.slice(prefix.length) : clipped,
      });
      remaining -= estimateTokens(clipped);
      continue;
    }
  }
  return budgeted
    .sort((a, b) => {
      if (a.chapter.position !== b.chapter.position) {
        return a.chapter.position - b.chapter.position;
      }
      return a.chapter.id - b.chapter.id;
    })
    .map(item => formatMemoryCandidateLine(item))
    .join('\n');
}

function tokenize(text: string): string[] {
  return tokenizeForMemoryRetrieval(text);
}

function buildIdf(docs: string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(tokenize(doc))) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log((docs.length + 1) / (count + 1)) + 1);
  }
  return idf;
}

function vectorize(
  text: string,
  idf: Map<string, number>,
): Map<string, number> {
  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
  const maxTf = Math.max(1, ...tf.values());
  const vector = new Map<string, number>();
  for (const [term, count] of tf) {
    vector.set(term, (count / maxTf) * (idf.get(term) || 1));
  }
  return vector;
}

function cosineSimilarity(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [key, value] of a) {
    normA += value * value;
    dot += value * (b.get(key) || 0);
  }
  for (const value of b.values()) normB += value * value;
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}
