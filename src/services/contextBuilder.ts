import * as db from './database';
import { processMacros } from './macroReplace';
import { clipTextToTokenBudget, estimateTokens } from '../utils/tokenEstimator';
import type { Chapter, ContextConfig, Preset } from '../types/novel';
import type { ChatMessage } from './llm';
import type { ContextTraceItem } from '../types/contextTrace';
import { getOrAnalyzeNoteStyle, mergeStyleProfiles, DEFAULT_STYLE_WEIGHTS, type StyleWeights } from './styleAnalyzer';
import { retrieveNoteFragments, type RetrievalQuery } from './noteRetriever';

const DEFAULT_SYSTEM_PROMPT =
  '你是一位经验丰富的中文小说作者。请根据既有设定、人物状态、章节概要和前文内容，继续创作自然、连贯、有画面感的中文小说。';

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'chapter',
  'return',
  '以下',
  '当前',
  '章节',
  '概要',
  '一个',
  '以及',
  '他们',
  '她们',
]);

type PartialContextConfig = Partial<ContextConfig>;

export interface BuildContextResult {
  messages: ChatMessage[];
  chapters: Chapter[];
  trace: ContextTraceItem[];
  estimatedInputTokens: number;
}

export async function buildContext(
  currentChapter: Chapter,
  config: ContextConfig,
  projectId: number,
  preset?: Preset | string,
): Promise<BuildContextResult> {
  const trace: ContextTraceItem[] = [];
  const chapters = await db.getChaptersByProject(projectId);
  const previousContent = buildPreviousContentText(currentChapter, config, chapters);
  const memoryText = buildMemoryContext(
    chapters.filter((chapter) => chapter.position < currentChapter.position),
    currentChapter,
    config.memoryTopK ?? 10,
    config.summaryBudgetTokens ?? 20000,
  );
  const worldbookScanContent = selectPreviousChapters(
    currentChapter,
    { strategy: 'sliding', recentChapterCount: config.worldbookScanDepth ?? 4 },
    chapters,
  )
    .map((chapter) => chapter.content)
    .join('\n\n');
  const scanText = [currentChapter.title, currentChapter.synopsis, currentChapter.content, worldbookScanContent, memoryText]
    .filter(Boolean)
    .join('\n\n');

  const systemPrompt = typeof preset === 'string' ? preset : buildPresetPrompt(preset);
  const rawSystemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
  // 宏替换覆盖系统提示词修复：preset.system_prompt / writing_style / extra_instructions
  // 里的 {{char}}/{{user}}/{{chapter}}/{{synopsis}} 也需要替换，否则以字面量进入 LLM
  const resolvedSystemPrompt = await processMacros(rawSystemPrompt, {
    projectId,
    chapterTitle: currentChapter.title,
    chapterSynopsis: currentChapter.synopsis,
  });
  const messages: ChatMessage[] = [{ role: 'system', content: resolvedSystemPrompt }];

  trace.push({
    kind: 'preset',
    sourceId: typeof preset !== 'string' && preset ? (preset as any).id ?? null : null,
    title: typeof preset !== 'string' && preset ? preset.name || '预设' : '系统提示词',
    reason: '系统提示词和预设配置',
    estimatedTokens: estimateTokens(resolvedSystemPrompt),
    included: true,
    clipped: false,
    preview: resolvedSystemPrompt.slice(0, 500),
  });

  if (config.includeResources && config.resourceBudget > 0) {
    const { text: resourceText, traceItems: resourceTrace } = await buildResourceContext(projectId, config.resourceBudget, scanText, config.worldbookRecursive !== false, currentChapter);
    if (resourceText) {
      const resourceMessage = `以下是本次写作必须参考的设定资料：\n\n${resourceText}`;
      messages.push({ role: 'system', content: resourceMessage });
    }
    trace.push(...resourceTrace);
  }

  if (memoryText) {
    const memoryMessage = `以下是历史记忆摘要：\n\n${memoryText}`;
    messages.push({ role: 'system', content: memoryMessage });
    trace.push({
      kind: 'memory',
      sourceId: null,
      title: '历史记忆摘要',
      reason: '记忆摘要检索',
      estimatedTokens: estimateTokens(memoryMessage),
      included: true,
      clipped: false,
      preview: memoryMessage.slice(0, 500),
    });
  }

  if (previousContent) {
    const processed = await processMacros(previousContent, {
      projectId,
      chapterTitle: currentChapter.title,
      chapterSynopsis: currentChapter.synopsis,
    });
    const prevMessage = `以下是最近前文正文，请重点承接最后发生的事件：\n\n${processed}`;
    messages.push({ role: 'user', content: prevMessage });
    trace.push({
      kind: 'chapter',
      sourceId: currentChapter.id ?? null,
      title: '前文滑动窗口',
      reason: '前文滑动窗口',
      estimatedTokens: estimateTokens(prevMessage),
      included: true,
      clipped: false,
      preview: prevMessage.slice(0, 500),
    });
  }

  const instructionContent = [
    `当前章节：「${currentChapter.title || `第 ${currentChapter.position + 1} 章`}」`,
    `章节概要：${currentChapter.synopsis || '无明确概要，请自然承接前文推进剧情。'}`,
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

  const estimatedInputTokens = trace.reduce((sum, item) => sum + item.estimatedTokens, 0);
  return { messages, chapters, trace, estimatedInputTokens };
}

function buildPresetPrompt(preset?: Preset): string {
  if (!preset) return DEFAULT_SYSTEM_PROMPT;
  const parts = [preset.system_prompt || DEFAULT_SYSTEM_PROMPT];
  if (preset.writing_style) parts.push(`写作风格：${preset.writing_style}`);
  if (preset.extra_instructions) parts.push(`附加要求：${preset.extra_instructions}`);
  return parts.join('\n\n');
}

async function buildResourceContext(
  projectId: number,
  budget: number,
  scanText: string,
  recursiveWorldbook: boolean,
  currentChapter?: Chapter,
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

  const charResult = await buildCharacterContext(projectId, characterBudget);
  addPart('人物设定', charResult.text, characterBudget);
  allTraceItems.push(...charResult.items);

  const noteResult = await buildNoteContext(projectId, noteBudget, scanText, currentChapter?.title || '', currentChapter?.synopsis || '', '');
  addPart('项目笔记', noteResult.text, noteBudget);
  allTraceItems.push(...noteResult.items);

  const wbResult = await buildWorldbookContext(projectId, worldbookBudget, scanText, recursiveWorldbook);
  addPart('世界书', wbResult.text, worldbookBudget);
  allTraceItems.push(...wbResult.items);

  return { text: parts.join('\n\n'), traceItems: allTraceItems };
}

export async function buildCharacterContext(projectId: number, budget: number): Promise<{ text: string; items: ContextTraceItem[] }> {
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
      card.post_history_instructions && `后置指令：${card.post_history_instructions}`,
    ]
      .filter(Boolean)
      .join('\n');
    const charBudget = Math.min(remaining, Number(character.max_tokens ?? 50000));
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
      estimatedTokens: included ? estimateTokens(clipped) : estimateTokens(text),
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
        card.post_history_instructions && `后置指令：${card.post_history_instructions}`,
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
    return buildRetrievedNoteContext(projectId, budget, scanText, config, chapterTitle, chapterSynopsis, userPrompt);
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
    let noteIds: number[] = config?.enabledNoteIds ?? [];
    if (noteIds.length === 0) {
      const notes = await db.getNotesByProject(projectId);
      noteIds = notes.map((n: any) => n.id);
    }
    if (noteIds.length === 0) return { text: '', items: [] };

    // 用 allSettled：单条笔记风格分析失败（空内容 / LLM 报错）不影响整体注入，
    // 避免整个仿写被一条坏数据拉回到原始笔记注入
    const settled = await Promise.allSettled(noteIds.map((id: number) => getOrAnalyzeNoteStyle(id)));
    const profiles = settled
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof getOrAnalyzeNoteStyle>>> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((p) => p && p.profileJson && Object.keys(p.profileJson).length > 0);

    const weights: StyleWeights = { ...DEFAULT_STYLE_WEIGHTS, ...(config?.styleWeights || {}) };
    const mergedText = mergeStyleProfiles(profiles, weights);
    if (!mergedText) return { text: '', items: [] };

    const fullText = `以下是本次写作必须遵循的风格画像，请严格按照对应权重的维度进行仿写：\n${mergedText}`;
    const clipped = clipTextToTokenBudget(fullText, budget);
    const failedCount = noteIds.length - profiles.length;
    const reason = failedCount > 0
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
    if (fragments.length === 0) return { text: '', items: [] };

    const parts = fragments.map((f) => `[笔记「${f.noteTitle}」] ${f.fragment}`);
    const fullText = `以下是本次写作可参考的资料片段，请结合上下文合理引用：\n${parts.join('\n')}`;
    const clipped = clipTextToTokenBudget(fullText, budget);
    return {
      text: clipped,
      items: fragments.map((f) => ({
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

async function buildNoteContextOriginal(projectId: number, budget: number): Promise<{ text: string; items: ContextTraceItem[] }> {
  const notes = await db.getNotesByProject(projectId);
  const parts: string[] = [];
  const items: ContextTraceItem[] = [];
  let remaining = budget;

  for (const note of notes) {
    const content = await db.getNoteContentById(note.id);
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
      estimatedTokens: included ? estimateTokens(clipped) : estimateTokens(text),
      included,
      clipped: wasClipped,
      preview: text.slice(0, 500),
    });

    if (remaining <= 0) break;
  }

  // Mark notes that weren't processed due to budget as clipped
  for (const note of notes) {
    const existingItem = items.find(it => it.sourceId === Number(note.id));
    if (!existingItem) {
      const content = await db.getNoteContentById(note.id);
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
    .filter((entry) => entry.enabled !== 0 && entry.collection_enabled !== 0)
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0) || Number(a.id || 0) - Number(b.id || 0));

  const activated = new Map<number, any>();
  const activationReason = new Map<number, string>();

  const determineReason = (entry: any, haystack: string): string => {
    if (entry.constant === 1 || entry.constant === true) return '常驻';
    const primaryKeys = normalizeKeys(entry.keyword_primary ?? entry.key ?? entry.keys ?? entry.keyword);
    if (primaryKeys.length === 0) return '常驻';
    const primaryHit = primaryKeys.some((key) => includesKey(haystack, key));
    if (!primaryHit) return '';
    const secondaryKeys = normalizeKeys(entry.keyword_secondary ?? entry.keysecondary ?? entry.secondary_keys);
    if (secondaryKeys.length === 0) return '主关键词命中';
    const secondaryHit = secondaryKeys.some((key) => includesKey(haystack, key));
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
    activatePass(`${scanText}\n\n${Array.from(activated.values()).map((entry) => entry.content || '').join('\n')}`, true);
  }

  const collectionUsage = new Map<number, number>();
  const lines: string[] = [];
  const items: ContextTraceItem[] = [];
  let remaining = budget;
  for (const entry of activated.values()) {
    const id = Number(entry.id);
    const entryContent = String(entry.content || '');
    const label = normalizeKeys(entry.keyword_primary ?? entry.key ?? entry.keys ?? entry.keyword)[0];
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
    const wasClipped = body !== entryContent && body.length < entryContent.length;
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
      estimatedTokens: included ? estimateTokens(body) : estimateTokens(entryContent),
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
      const label = normalizeKeys(entry.keyword_primary ?? entry.key ?? entry.keys ?? entry.keyword)[0];
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
  if (Array.isArray(raw)) return raw.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof raw === 'string') return raw.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

export function selectPreviousChapters(
  currentChapter: Chapter,
  config: PartialContextConfig,
  chapters: Chapter[],
): Chapter[] {
  const previous = chapters
    .filter((chapter) => chapter.position < currentChapter.position && Boolean(chapter.content))
    .sort((a, b) => a.position - b.position);

  if (config.strategy === 'full') return previous;

  if (config.strategy === 'custom') {
    const start = Math.max(0, Number(config.customRangeStart ?? 0));
    const end = Number(config.customRangeEnd ?? -1);
    return previous.filter((chapter) => chapter.position >= start && (end < 0 || chapter.position <= end));
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
    .map((chapter) => `第 ${chapter.position + 1} 章「${chapter.title || '未命名'}」\n${chapter.content}`)
    .join('\n\n');
  return clipTextTailToTokenBudget(text, Number(config.slidingWindowSize || 50000));
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
): string {
  const docs = previousChapters
    .map((chapter) => ({
      chapter,
      text: String((chapter as any).memory_summary || ''),
    }))
    .filter((item) => item.text.trim());

  if (docs.length === 0 || topK <= 0 || budgetTokens <= 0) return '';

  const idf = buildIdf(docs.map((doc) => doc.text));
  const query = `${currentChapter.title}\n${currentChapter.synopsis}\n${currentChapter.content?.slice(0, 500) || ''}`;
  const queryVector = vectorize(query, idf);
  const scored = docs
    .map((doc) => ({
      ...doc,
      score: cosineSimilarity(queryVector, vectorize(doc.text, idf)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const lines: string[] = [];
  let remaining = budgetTokens;
  for (const item of scored) {
    const line = `第 ${item.chapter.position + 1} 章「${item.chapter.title}」摘要：${item.text}`;
    const clipped = clipTextToTokenBudget(line, remaining);
    if (!clipped) break;
    lines.push(clipped);
    remaining -= estimateTokens(clipped);
  }

  return lines.join('\n');
}

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^\u4e00-\u9fffa-z0-9_\s]/gi, ' ')
    .split(/\s+/)
    .flatMap((token) => {
      if (/^[\u4e00-\u9fff]+$/.test(token)) return Array.from(token);
      return token;
    })
    .filter((token) => token.length >= 1 && !STOP_WORDS.has(token));
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

function vectorize(text: string, idf: Map<string, number>): Map<string, number> {
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

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
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
