import * as db from './database';
import { callLLM } from './llm';
import { extractJSON } from '../utils/jsonExtractor';
import { estimateTokens } from '../utils/tokenEstimator';
import type { ChapterSummary } from '../types/novel';
import {
  StoryMemoryAttemptBudget,
  createStoryMemoryLogicalBatchId,
} from './storyMemory/storyMemoryAttemptBudget';
import { STORY_MEMORY_MAX_PHYSICAL_REQUESTS } from './storyMemory/storyMemoryAttemptPolicy';

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
        content: `章节标题：${chapter.title}\n章节概要：${
          chapter.synopsis || '无'
        }\n\n正文：\n${chapter.content}`,
      },
    ],
    1200,
    // scenario/projectId 修复：原调用未传 config，scenario 回退 'chat'，
    // 用量统计面板混入 chat 类别且无项目归属
    { scenario: 'chapter_summary', projectId: chapter.project_id },
  );
  if (!result) return false;

  const json = extractJSON(result);
  if (!json) throw new Error('模型没有返回有效 JSON 摘要。');
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch (e: any) {
    throw new Error(`解析摘要 JSON 失败：${e?.message || '未知错误'}`);
  }
  const summary: ChapterSummary = {
    brief: String(parsed.brief || ''),
    plotPoints: Array.isArray(parsed.plotPoints)
      ? parsed.plotPoints.map(String)
      : [],
    characterStates: Array.isArray(parsed.characterStates)
      ? parsed.characterStates.map(String)
      : [],
    sceneChanges: Array.isArray(parsed.sceneChanges)
      ? parsed.sceneChanges.map(String)
      : [],
  };
  await db.updateChapter(chapterId, {
    summary_json: { ...EMPTY_SUMMARY, ...summary } as any,
  });
  return true;
}

export async function batchGenerateSummaries(
  projectId: number,
): Promise<{ success: number; total: number }> {
  const chapters = (await db.getChaptersByProject(projectId)).filter(
    chapter => chapter.content.trim().length >= 100,
  );
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

export async function generateMemorySummary(
  chapterId: number,
  targetChars = 300,
): Promise<string> {
  const chapter = await db.getChapterById(chapterId);
  if (!chapter) throw new Error('章节不存在。');
  if (!chapter.content.trim())
    throw new Error('章节正文为空，无法生成记忆摘要。');

  const attemptBudget = new StoryMemoryAttemptBudget({
    logicalBatchId: createStoryMemoryLogicalBatchId({
      projectId: chapter.project_id,
      fromPosition: chapter.position,
      throughPosition: chapter.position,
      kind: 'summary',
    }),
    projectId: chapter.project_id,
    fromPosition: chapter.position,
    throughPosition: chapter.position,
    maxPhysicalRequests: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
  });
  const result = await callLLM(
    [
      {
        role: 'system',
        content:
          '你是长篇小说连续性记忆编辑。请生成一段高信息密度、适合后续章节检索的章节记忆摘要。不要续写，不要评价，不要输出 Markdown。',
      },
      {
        role: 'user',
        content: `请用约 ${targetChars} 字总结本章，供后续长篇小说检索和连续性保持使用。

必须优先保留：
1. 本章重要人物的完整姓名及必要别名；
2. 谁对谁做了什么，以及行为产生的结果；
3. 人物之间的重要对话、承诺、欺骗、冲突、合作、救援、拒绝或背叛；
4. 重要物品由谁获得、失去、使用或交给谁；
5. 人物新得知、误解、隐瞒或泄露的信息；
6. 人物关系、信任、态度、目标或立场的变化及原因；
7. 本章产生但尚未解决的线索、秘密、误会、承诺和矛盾；
8. 对后续剧情可能构成连续性约束的时间、地点和状态。

表达要求：
- 明确写出行为主体和对象；
- 尽量避免“二人”“他们”“双方”“有人”等模糊代词；
- 保留重要人名、地名、物品名和线索名；
- 不要只概括主线，不能遗漏会影响后续人物行为的关键互动；
- 不得添加正文中没有发生的事实。

章节标题：${chapter.title}
章节概要：${chapter.synopsis || '无'}

正文：
${chapter.content}`,
      },
    ],
    Math.max(targetChars * 2, 700),
    {
      scenario: 'memory_summary',
      projectId: chapter.project_id,
      queueClass: 'background',
      thinking: { type: 'disabled' },
      physicalRequestHooks: attemptBudget.hooks(),
    },
  );

  const memorySummary = (result || '').trim();
  if (!memorySummary) throw new Error('模型没有返回记忆摘要。');

  await db.updateChapter(chapterId, {
    memory_summary: memorySummary,
    memory_summary_tokens: estimateTokens(memorySummary),
  } as any);
  return memorySummary;
}
