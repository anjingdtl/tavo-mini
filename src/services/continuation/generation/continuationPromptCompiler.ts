/**
 * Stage-specific prompt compiler (Spec §8.3).
 * Never rebuilds live Canon/Story Memory — only uses frozen snapshot.
 */
import type { ChatMessage } from '../../llm/types';
import type {
  ContinuationContextSnapshot,
  ContinuationPlan,
  ContinuationCheckResult,
} from './types';

function lockedBlock(s: ContinuationContextSnapshot): string {
  return s.bundles.lockedRules.length
    ? `【用户锁定/硬规则】\n${s.bundles.lockedRules.join('\n')}`
    : '【用户锁定/硬规则】（无）';
}

function canonHardBlock(s: ContinuationContextSnapshot): string {
  const rules = s.bundles.canon.worldRules
    .slice(0, 20)
    .map(r => `- [${r.constraintLevel}] ${r.title}: ${r.description}`)
    .join('\n');
  const chars = s.bundles.canon.characters
    .slice(0, 15)
    .map(c => `- ${c.canonicalName}: ${c.description.slice(0, 200)}`)
    .join('\n');
  return `【原著 Canon】\n世界观:\n${rules || '（无）'}\n人物:\n${chars || '（无）'}`;
}

function stateBlock(s: ContinuationContextSnapshot): string {
  const st = s.bundles.effectiveState;
  const chars = st.characterStates
    .slice(0, 20)
    .map(c => `- ${JSON.stringify(c.ref)}: ${c.summary}`)
    .join('\n');
  const plots = st.plotThreads
    .slice(0, 10)
    .map(p => `- ${p.title} (${p.status}): ${p.summary}`)
    .join('\n');
  return `【目标位置有效续写状态 position=${s.targetPosition}】\n人物状态:\n${chars || '（无）'}\n剧情:\n${plots || '（无）'}`;
}

function seamBlock(s: ContinuationContextSnapshot): string {
  return `【原著接缝】${s.bundles.seam.summary}\n${s.bundles.seam.excerpt}`;
}

function recentBlock(s: ContinuationContextSnapshot): string {
  if (!s.bundles.recentChapters.length) return '【最近续写正文】（无）';
  return (
    '【最近续写正文】\n' +
    s.bundles.recentChapters
      .map(
        c =>
          `--- 章 position=${c.position} (hash=${c.revisionHash.slice(0, 8)}) ---\n${c.excerpt}`,
      )
      .join('\n')
  );
}

function memoryBlock(s: ContinuationContextSnapshot): string {
  return `【Story Memory 摘要 status=${s.storyMemory.status}】\n${s.bundles.storyMemory.summary || '（无）'}`;
}

function styleBlock(s: ContinuationContextSnapshot): string {
  const st = s.bundles.style;
  if (!st || s.settingsSnapshot.values.styleLevel === 'off') {
    return '【文风】（关闭或不存在）';
  }
  return `【文风特征】人称=${st.narrativePerson} 时态=${st.tense} 均句长=${st.averageSentenceLength} 对话比=${st.dialogueRatio}\n${st.pacingNotes}\n${st.lexicalNotes}`;
}

export function compilePlannerMessages(
  snapshot: ContinuationContextSnapshot,
): ChatMessage[] {
  const system = [
    '你是长篇小说续写规划助手。只输出 JSON，不要写完整正文。',
    'schemaVersion 必须为 1。字段：chapterGoal, centralConflict, beats[], participatingCharacterIds[], characterActions[], plotAdvances[], foreshadowingActions[], proposedStateChanges[], risks[]。',
    '不得违反用户锁定规则与原著 hard Canon。不得读取或编造 boundary 之后的原著情节。',
    lockedBlock(snapshot),
    canonHardBlock(snapshot),
    stateBlock(snapshot),
    seamBlock(snapshot),
    recentBlock(snapshot),
    memoryBlock(snapshot),
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `请为第 position=${snapshot.targetPosition} 章规划续写。用户要求：\n${snapshot.bundles.userInstruction}\n目标字数约 ${snapshot.settingsSnapshot.values.targetChapterChars}。`,
    },
  ];
}

export function compileWriterMessages(
  snapshot: ContinuationContextSnapshot,
  plan: ContinuationPlan,
): ChatMessage[] {
  const system = [
    '你是长篇小说续写写手。只输出本章正文，不要分析说明、不要标题行。',
    '遵守人物知识边界；不复制大段原著原文；不引入被策略禁止的死亡/复活/新体系。',
    lockedBlock(snapshot),
    `【规划（已确认版本）】\n目标：${plan.chapterGoal}\n冲突：${plan.centralConflict}\n节拍：${plan.beats.map(b => b.summary).join(' / ')}`,
    stateBlock(snapshot),
    seamBlock(snapshot),
    recentBlock(snapshot),
    styleBlock(snapshot),
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `写 position=${snapshot.targetPosition} 章正文，约 ${snapshot.settingsSnapshot.values.targetChapterChars} 字。用户要求：\n${snapshot.bundles.userInstruction}`,
    },
  ];
}

export function compileCheckerMessages(
  snapshot: ContinuationContextSnapshot,
  artifactText: string,
): ChatMessage[] {
  const system = [
    '你是续写一致性检查器。只输出 JSON 数组 issues[]，每项含 category, subtype, severity, confidence, generatedStart, generatedEnd, generatedExcerpt, description, evidenceIds, suggestedFix。',
    'category ∈ world|character|relationship|plot|experience|knowledge|timeline|style；severity ∈ info|warning|error|blocking。',
    '没有证据时只能 warning 并说明是推测。位置使用 UTF-16 半开区间。',
    lockedBlock(snapshot),
    canonHardBlock(snapshot),
    stateBlock(snapshot),
    `【可引用证据 id】${JSON.stringify(snapshot.bundles.canon.evidenceRefs.slice(0, 50))}`,
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `检查以下正文：\n---\n${artifactText}\n---`,
    },
  ];
}

export function compileRepairMessages(
  snapshot: ContinuationContextSnapshot,
  artifactText: string,
  openChecks: ContinuationCheckResult[],
): ChatMessage[] {
  const issues = openChecks
    .filter(c => c.severity === 'error' || c.severity === 'blocking')
    .map(
      c =>
        `- [${c.severity}/${c.category}] ${c.description} @${c.generatedStart}-${c.generatedEnd} 建议:${c.suggestedFix ?? ''}`,
    )
    .join('\n');
  const system = [
    '你是续写局部修复助手。只修改冲突片段，保留无问题段落。只输出修复后的完整正文。',
    lockedBlock(snapshot),
    stateBlock(snapshot),
    `【待修复问题】\n${issues || '（无 blocking/error）'}`,
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `原文：\n---\n${artifactText}\n---\n请输出修复后正文。`,
    },
  ];
}

export function compileStateExtractionMessages(
  finalizedText: string,
  entityIndex: string,
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你从已定稿续写正文提取状态 proposal。只输出 JSON：{ proposals: [...] }。',
        '每项：proposalType, subjectRefType?, subjectRefId?, payload, evidenceStart, evidenceEnd, risk(normal|major)。',
        'proposalType ∈ character_state|relationship_change|plot_advance|character_experience|knowledge_change|new_world_fact|new_character|new_location|new_organization|foreshadowing|other。',
        'evidence offset 必须在正文 UTF-16 范围内。不得编造原著未来情节。',
        `【实体索引】\n${entityIndex}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: `定稿正文：\n---\n${finalizedText}\n---`,
    },
  ];
}
