import type { Chapter } from '../../types/novel';
import { estimateTokens } from '../../utils/tokenEstimator';
import type { StoryMemoryState } from './storyMemoryTypes';

export interface RenderStoryMemoryResult {
  text: string;
  estimatedTokens: number;
  clipped: boolean;
  includedCharacterIds: string[];
  includedRelationshipIds: string[];
}

const list = (values: string[]) => values.filter(Boolean).join('、') || '无';

export function renderStoryMemoryForContext(
  state: StoryMemoryState,
  options: { currentChapter: Chapter; budgetTokens: number },
): RenderStoryMemoryResult {
  const scan = `${options.currentChapter.title}\n${options.currentChapter.synopsis}\n${options.currentChapter.content.slice(0, 2000)}`;
  const characters = Object.values(state.characters).sort((a, b) => {
    const aMention = [a.canonicalName, ...a.aliases].some(name => scan.includes(name));
    const bMention = [b.canonicalName, ...b.aliases].some(name => scan.includes(name));
    return Number(bMention) - Number(aMention) || b.lastChangedPosition - a.lastChangedPosition;
  });
  const characterItems = characters.map(item => ({
    id: item.id,
    line: `- [${item.id}] ${item.canonicalName}（别名：${list(item.aliases)}）：${item.role || '身份未知'}；位置：${item.currentState.location || '未知'}；身体/情绪：${item.currentState.physicalState || '未知'}/${item.currentState.emotionalState || '未知'}；目标：${item.currentState.currentGoal || '无'}；已知：${list(item.currentState.knowledge)}；持有：${list(item.currentState.possessions)}；秘密：${list(item.currentState.secrets)}；状态：${item.status}`,
  }));
  const relationshipItems = Object.values(state.relationships)
    .sort((a, b) => b.lastChangedPosition - a.lastChangedPosition)
    .map(item => ({
      id: item.id,
      from: item.fromCharacterId,
      to: item.toCharacterId,
      line: `- [${item.id}] ${item.fromCharacterId} ${item.direction === 'bidirectional' ? '↔' : '→'} ${item.toCharacterId}：${item.relationType}；${item.currentState}；信任：${item.trustLevel}；公开：${item.publicStatus || '无'}；隐藏：${item.hiddenStatus || '无'}；原因：${item.reason || '无'}`,
    }));
  const mainline = state.mainline;
  const mainlineLines = [
    `- 当前剧情弧：${mainline.currentArc ? `[${mainline.currentArc.id}] ${mainline.currentArc.name}：${mainline.currentArc.summary}` : '无'}`,
    `- 当前目标：${mainline.currentObjective || '无'}`,
    `- 活跃冲突：${Object.values(mainline.activeConflicts).map(item => `[${item.id}] ${item.title}：${item.state}（代价：${item.stakes}）`).join('；') || '无'}`,
    `- 未解决线索：${Object.values(mainline.openThreads).sort((a, b) => ({ critical: 0, high: 1, normal: 2, low: 3 })[a.priority] - ({ critical: 0, high: 1, normal: 2, low: 3 })[b.priority]).map(item => `[${item.id}] ${item.title}：${item.description}`).join('；') || '无'}`,
    `- 未兑现伏笔：${Object.values(mainline.foreshadowing).filter(item => item.status !== 'paid').map(item => `[${item.id}] ${item.setup}→${item.expectedPayoff}`).join('；') || '无'}`,
    `- 关键时间锚点：${Object.values(mainline.timelineAnchors).filter(item => item.pinned).map(item => `[${item.id}] ${item.timeDescription}：${item.event}`).join('；') || '无'}`,
    `- 最近完成节点：${mainline.recentCompletedBeats.map(item => item.summary).join('；') || '无'}`,
  ];
  const throughLabel =
    state.throughChapterPosition >= 0
      ? `第 ${state.throughChapterPosition + 1} 章`
      : '开篇前';
  const prefix = `以下是截至${throughLabel}整理并验证的长期故事状态。\n${throughLabel}之后的近期正文可能包含更新；若两者冲突，以章节位置更晚的近期正文为准。\n除非近期正文或当前写作要求明确改变，否则不得违背该长期状态。\n\n【故事全局状态｜截至${throughLabel}】`;
  const selectedCharacters: typeof characterItems = [];
  const selectedRelationships: typeof relationshipItems = [];
  const render = () => [
    prefix, '', '一、登场人物',
    ...(selectedCharacters.length ? selectedCharacters.map(item => item.line) : ['无']),
    '', '二、人物关系',
    ...(selectedRelationships.length ? selectedRelationships.map(item => item.line) : ['无']),
    '', '三、故事主线', ...mainlineLines,
  ].join('\n');
  let clipped = estimateTokens(render()) > Math.max(1, options.budgetTokens);
  for (const item of characterItems) {
    selectedCharacters.push(item);
    if (estimateTokens(render()) > options.budgetTokens) {
      selectedCharacters.pop();
      clipped = true;
    }
  }
  const included = new Set(selectedCharacters.map(item => item.id));
  for (const item of relationshipItems) {
    if (!included.has(item.from) && !included.has(item.to)) {
      clipped = true;
      continue;
    }
    selectedRelationships.push(item);
    if (estimateTokens(render()) > options.budgetTokens) {
      selectedRelationships.pop();
      clipped = true;
    }
  }
  const text = render();
  return {
    text,
    estimatedTokens: estimateTokens(text),
    clipped,
    includedCharacterIds: selectedCharacters.map(item => item.id),
    includedRelationshipIds: selectedRelationships.map(item => item.id),
  };
}
