import * as db from './database';
import { callLLM } from './llm';
import { extractJSON } from '../utils/jsonExtractor';
import { estimateTokens } from '../utils/tokenEstimator';
import type { ChapterSummary } from '../types/novel';

const EMPTY_SUMMARY: ChapterSummary = {
  brief: '',
  plotPoints: [],
  characterStates: [],
  sceneChanges: [],
};

export async function generateSummary(chapterId: number): Promise<boolean> {
  const chapter = await db.getChapterById(chapterId);
  if (!chapter) throw new Error('章节不存在。');
  if (!chapter.content.trim()) throw new Error('章节正文为空，无法生成摘要。');

  const result = await callLLM(
    [
      {
        role: 'system',
        content:
          '你是小说编辑。请把章节内容总结为严格 JSON，不要输出 Markdown。字段：brief、plotPoints、characterStates、sceneChanges。',
      },
      {
        role: 'user',
        content: `章节标题：${chapter.title}\n章节概要：${chapter.synopsis || '无'}\n\n正文：\n${chapter.content}`,
      },
    ],
    1200,
  );
  if (!result) return false;

  const json = extractJSON(result);
  if (!json) throw new Error('模型没有返回有效 JSON 摘要。');
  const parsed = JSON.parse(json);
  const summary: ChapterSummary = {
    brief: String(parsed.brief || ''),
    plotPoints: Array.isArray(parsed.plotPoints) ? parsed.plotPoints.map(String) : [],
    characterStates: Array.isArray(parsed.characterStates) ? parsed.characterStates.map(String) : [],
    sceneChanges: Array.isArray(parsed.sceneChanges) ? parsed.sceneChanges.map(String) : [],
  };
  await db.updateChapter(chapterId, { summary_json: { ...EMPTY_SUMMARY, ...summary } as any });
  return true;
}

export async function batchGenerateSummaries(projectId: number): Promise<{ success: number; total: number }> {
  const chapters = (await db.getChaptersByProject(projectId)).filter((chapter) => chapter.content.trim().length >= 100);
  let success = 0;
  for (const chapter of chapters) {
    try {
      if (await generateSummary(chapter.id)) success++;
    } catch {
      // Keep batch generation moving; individual failures are reflected in the count.
    }
  }
  return { success, total: chapters.length };
}

export async function generateMemorySummary(chapterId: number, targetChars = 200): Promise<string> {
  const chapter = await db.getChapterById(chapterId);
  if (!chapter) throw new Error('章节不存在。');
  if (!chapter.content.trim()) throw new Error('章节正文为空，无法生成记忆摘要。');

  const result = await callLLM(
    [
      {
        role: 'system',
        content: '你是小说编辑助手。请生成一段简洁的章节记忆摘要，用于后续章节检索上下文。',
      },
      {
        role: 'user',
        content: `请用约 ${targetChars} 字总结以下章节的核心剧情、人物变化和关键事件，保留重要人名、地名、物品名。\n\n章节标题：${chapter.title}\n章节概要：${chapter.synopsis || '无'}\n\n正文：\n${chapter.content}`,
      },
    ],
    Math.max(targetChars * 2, 500),
    { scenario: 'memory_summary' },
  );

  const memorySummary = (result || '').trim();
  if (!memorySummary) throw new Error('模型没有返回记忆摘要。');

  await db.updateChapter(chapterId, {
    memory_summary: memorySummary,
    memory_summary_tokens: estimateTokens(memorySummary),
  } as any);
  return memorySummary;
}
