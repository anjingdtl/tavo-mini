import type { ChatMessage } from './llm';
import {
  clipTextToTokenBudget,
  estimateTokens,
} from '../utils/tokenEstimator';
import type {
  FactCheckContext,
  ProofConstraints,
  ReviewContext,
} from '../types/pipelineContext';

export function buildDraftMessages(
  baseMessages: ChatMessage[],
  chapterTitle: string,
  existingContent: string,
  userPrompt: string,
  previousChapterEnding?: string,
  chapterSynopsis?: string,
  outlineText?: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [...baseMessages];
  const hasOutline = !!(outlineText && outlineText.trim());
  const roleInstruction = hasOutline
    ? [
        `【任务】你是初稿作者。请为小说章节「${chapterTitle}」创作内容。`,
        '本项目已有项目大纲，它是尚未发生剧情的最高创作约束。',
        '本章必须服务于项目大纲的主线推进，不得擅自建立与主线冲突的新主线。',
        '不得提前完成属于后续章节的关键事件。',
        '必须承接已经写成的前文；如前文与大纲存在偏差，应从当前状态逐步拉回，不得篡改历史。',
        '不得为了服从旧大纲而回滚既有事实（人物记忆、死亡状态、已完成事件等）。',
      ].join('\n')
    : [
        `【任务】你是初稿作者。请为小说章节「${chapterTitle}」快速创作内容。`,
        '专注于创造力和流畅性，释放想象力，避免陷入空白页焦虑。',
        '不要担心细节问题，后续会有专门的编辑处理。',
      ].join('\n');

  let content = roleInstruction;
  if (previousChapterEnding) {
    content += `\n\n【前章衔接】上一章结尾：\n${previousChapterEnding}\n请确保本章开头自然承接上一章结尾的场景、情节和情绪，保持叙事连贯。`;
  }
  if (chapterSynopsis) {
    // When a project outline exists, the chapter synopsis is downgraded to a
    // local execution goal that may only refine the outline — it must not
    // change the main line. Without an outline the synopsis keeps its original
    // "must follow" semantics.
    if (hasOutline) {
      content += `\n\n【当前章节执行目标】${chapterSynopsis}\n这是项目大纲在当前章节的局部执行目标，只能细化大纲，不得改变主线。`;
    } else {
      content += `\n\n【章节大纲（必须遵循）】${chapterSynopsis}\n请严格按此大纲创作本章内容。`;
    }
  }
  if (existingContent.trim()) {
    const tail = existingContent.slice(-1500);
    content += `\n\n当前已有正文末尾：\n${tail}\n\n请自然续写，不要重复前文内容。`;
  }
  content += `\n\n${userPrompt}`;

  messages.push({ role: 'user', content });
  return messages;
}

/**
 * Per-section token budgets for downstream stages. Each partition keeps its own
 * budget so an oversized preset cannot starve the worldbook or episodic events.
 * Budgets are conservative defaults in tokens; SPEC §9.3 says internal constants
 * are acceptable for this pass (no settings page wiring required).
 */
const REVIEW_BUDGET = {
  preset: 1500,
  character: 2000,
  note: 1200,
  worldbook: 2000,
  storyMemory: 1500,
  episodic: 1500,
  recentBridge: 2500,
  instruction: 600,
  userPrompt: 600,
  outline: 6000,
};

const FACTCHECK_BUDGET = {
  preset: 1200,
  instruction: 800,
  userPrompt: 600,
  recentBridge: 3000,
  storyMemory: 2500,
  episodic: 3000,
  worldbook: 3000,
  character: 2000,
  note: 1500,
  outline: 6000,
};

const PROOF_BUDGET = {
  preset: 1200,
  instruction: 600,
  userPrompt: 500,
  character: 1500,
  worldRules: 2000,
  storyState: 2000,
  episodic: 1800,
  note: 1000,
  recentBridge: 2500,
  outline: 6000,
};

function clip(text: string | undefined | null, budget: number): string {
  const value = text ? String(text) : '';
  if (!value.trim() || budget <= 0) return '';
  return clipTextToTokenBudget(value, budget);
}

/**
 * Build a labeled partition: only non-empty sections appear, so the model never
 * sees an empty "【世界书】\n\n" block that could be mistaken for "no worldbook".
 */
function partition(blocks: Array<[string, string]>): string {
  return blocks
    .filter(([, body]) => body && body.trim())
    .map(([label, body]) => `${label}\n${body}`)
    .join('\n\n');
}

/**
 * Literary review messages. Review receives every enabled draft source so it
 * judges style and continuity against the same project view as the author.
 */
export function buildReviewMessages(
  draftText: string,
  context: ReviewContext = {
    presetText: '',
    characterText: '',
    noteText: '',
    worldbookText: '',
    storyMemoryText: '',
    episodicMemoryText: '',
    recentBridgeText: '',
    currentInstructionText: '',
    retrievalUserPrompt: '',
    outlineText: '',
  },
): ChatMessage[] {
  const ctx: ReviewContext = {
    presetText: clip(context.presetText, REVIEW_BUDGET.preset),
    characterText: clip(context.characterText, REVIEW_BUDGET.character),
    noteText: clip(context.noteText, REVIEW_BUDGET.note),
    worldbookText: clip(context.worldbookText, REVIEW_BUDGET.worldbook),
    storyMemoryText: clip(context.storyMemoryText, REVIEW_BUDGET.storyMemory),
    episodicMemoryText: clip(
      context.episodicMemoryText,
      REVIEW_BUDGET.episodic,
    ),
    recentBridgeText: clip(
      context.recentBridgeText,
      REVIEW_BUDGET.recentBridge,
    ),
    currentInstructionText: clip(
      context.currentInstructionText,
      REVIEW_BUDGET.instruction,
    ),
    retrievalUserPrompt: clip(
      context.retrievalUserPrompt,
      REVIEW_BUDGET.userPrompt,
    ),
    outlineText: clip(context.outlineText, REVIEW_BUDGET.outline),
  };

  const contextBlock = partition([
    ['【项目大纲｜未来规划，最高创作约束】', ctx.outlineText],
    ['【写作预设与文风】', ctx.presetText],
    ['【人物设定】', ctx.characterText],
    ['【项目笔记 / 仿写资料】', ctx.noteText],
    ['【世界书 / 世界规则】', ctx.worldbookText],
    ['【当前故事状态】', ctx.storyMemoryText],
    ['【历史章节事件】', ctx.episodicMemoryText],
    ['【近期正文 / 衔接】', ctx.recentBridgeText],
    ['【当前章节目标】', ctx.currentInstructionText],
    ['【用户本轮要求】', ctx.retrievalUserPrompt],
  ]);

  const hasOutline = !!ctx.outlineText.trim();
  const systemLines = [
    '你是一位资深小说审阅编辑。你的职责是从宏观视角审阅初稿，关注：',
    '1. 情节逻辑——发展是否合理，有无矛盾或断裂',
    '2. 结构和节奏——叙事节奏、场景转换是否得当',
    '3. 文风与预设一致性——是否符合写作预设、风格是否前后统一',
    '4. 人物行为与人物卡一致性——角色言行是否符合其设定和性格',
    '5. 人物关系表现——关系推进是否合理',
    '6. 场景衔接——是否自然承接近期正文',
    '7. 章节概要完成度——是否完成当前章节目标',
    '8. 展示而非讲述(show not tell)',
    '9. 重复、空泛、跳跃、机械总结',
  ];
  if (hasOutline) {
    systemLines.push(
      '',
      '当提供了【项目大纲｜未来规划】时，你还必须额外审阅大纲一致性：',
      '10. 本章是否完成了应承担的主线推进；',
      '11. 是否遗漏了必要的剧情节点；',
      '12. 是否擅自改变了关键事件或主线方向；',
      '13. 是否过早消耗了属于后续章节的剧情；',
      '14. 新增支线是否压制或破坏主线；',
      '15. 人物关键选择是否仍然服务于大纲；',
      '16. 是否为了服从旧大纲而回滚了已发生的事实；',
      '17. 是否把大纲中的未来信息写成了当前人物已知或已发生的内容。',
      '',
      '大纲是未来规划，不是已发生事实。已写成的事实不可被旧大纲回滚。',
      '多份大纲冲突时，按注入顺序采用靠前内容。',
    );
  }
  systemLines.push(
    '',
    '你只会得到本次写作实际使用的上下文资料。不要假设、不要补全未提供的设定。',
    '不得用现实常识否定世界书或故事状态中明确建立的设定。',
    '',
    '请按以下 JSON 格式输出审阅意见，只输出 JSON，不要输出 Markdown 围栏或解释：',
    hasOutline
      ? '{"strengths": [...], "issues": [...], "suggestions": [...], "outlineAssessment": {"status": "aligned|partial|deviated|over_advanced", "fulfilledBeats": [...], "missingBeats": [...], "deviations": [...], "prematureBeats": [...], "factRollbackRisks": [...]}}'
      : '{"strengths": [...], "issues": [...], "suggestions": [...]}',
    '',
    '要求：',
    '- issues 必须具体，尽量引用初稿中的原句作为定位；',
    '- suggestions 尽量与 issues 一一对应；',
    ...(hasOutline
      ? ['- outlineAssessment 仅在提供了项目大纲时输出，没有发现问题时对应数组返回空数组；']
      : []),
    '- 不要输出完整修订稿；',
    '- 没有发现问题时，对应数组返回空数组，不要编造。',
  );

  const userLines = [
    contextBlock,
    '【需要审阅的初稿】',
    draftText,
  ].filter(Boolean);

  return [
    { role: 'system', content: systemLines.join('\n') },
    { role: 'user', content: userLines.join('\n\n') },
  ];
}

/**
 * Fact-check messages (SPEC §8.3). Replaces the old `slice(0, 3000)` truncation
 * with per-section token budgets so a long preset can no longer silently drop
 * the worldbook or the bridge body. All continuity sources (worldbook, Story
 * Memory, episodic events, recent body, current instruction) are passed as
 * labeled partitions.
 */
export function buildFactCheckMessages(
  draftText: string,
  context: FactCheckContext = {
    presetText: '',
    currentInstructionText: '',
    retrievalUserPrompt: '',
    recentBridgeText: '',
    storyMemoryText: '',
    episodicMemoryText: '',
    worldbookText: '',
    characterText: '',
    noteText: '',
    outlineText: '',
  },
): ChatMessage[] {
  // Priority order from SPEC §9.3 — each section keeps its own budget.
  const ctx: FactCheckContext = {
    presetText: clip(context.presetText, FACTCHECK_BUDGET.preset),
    currentInstructionText: clip(
      context.currentInstructionText,
      FACTCHECK_BUDGET.instruction,
    ),
    retrievalUserPrompt: clip(
      context.retrievalUserPrompt,
      FACTCHECK_BUDGET.userPrompt,
    ),
    recentBridgeText: clip(
      context.recentBridgeText,
      FACTCHECK_BUDGET.recentBridge,
    ),
    storyMemoryText: clip(context.storyMemoryText, FACTCHECK_BUDGET.storyMemory),
    episodicMemoryText: clip(
      context.episodicMemoryText,
      FACTCHECK_BUDGET.episodic,
    ),
    worldbookText: clip(context.worldbookText, FACTCHECK_BUDGET.worldbook),
    characterText: clip(context.characterText, FACTCHECK_BUDGET.character),
    noteText: clip(context.noteText, FACTCHECK_BUDGET.note),
    outlineText: clip(context.outlineText, FACTCHECK_BUDGET.outline),
  };

  const hasOutline = !!ctx.outlineText.trim();
  const contextBlock = partition([
    ['【项目大纲｜未来规划，非已发生事实】', ctx.outlineText],
    ['【写作预设与文风】', ctx.presetText],
    ['【当前章节目标】', ctx.currentInstructionText],
    ['【用户本轮要求】', ctx.retrievalUserPrompt],
    ['【近期正文 / Pending Bridge】', ctx.recentBridgeText],
    ['【当前故事状态 / Story Memory】', ctx.storyMemoryText],
    ['【历史章节事件 / Episodic Memory】', ctx.episodicMemoryText],
    ['【世界书 / 世界规则】', ctx.worldbookText],
    ['【人物设定】', ctx.characterText],
    ['【项目笔记】', ctx.noteText],
  ]);

  const systemLines = [
    '你是小说事实核查员。你的职责是验证初稿中的事实性内容，重点检查：',
    '1. 人物当前位置——是否与近期正文 / 故事状态一致',
    '2. 人物身体和情绪状态——是否承接前文',
    '3. 人物是否知道某件事——信息边界（秘密 / 已知 / 未知）',
    '4. 物品归属和转移——持有者是否正确',
    '5. 关系状态——是否与已建立的关系一致',
    '6. 承诺、背叛和秘密——是否违反',
    '7. 世界规则和能力边界——是否越界',
    '8. 时间线——事件顺序和时间跨度',
    '9. 地理和空间逻辑——场景描述是否合理',
    '10. “第一次 / 再次”——是否与历史事件冲突',
    '11. 生死状态——已死亡人物不得正常出现',
    '12. 已解决或未解决线索——是否前后矛盾',
    '13. 近期正文是否覆盖旧状态——位置更晚的正文优先',
  ];
  if (hasOutline) {
    systemLines.push(
      '',
      '当提供了【项目大纲｜未来规划】时，必须严格区分“未来规划”和“已经发生的事实”：',
      '14. 大纲中的未来事件不能被当作已经发生——即使大纲写明了结局、死亡、复活或身份揭示；',
      '15. 大纲中的未来人物关系、秘密、知识不能提前生效——人物当前不应知道尚未揭示的秘密；',
      '16. 大纲中的未来死亡、生还、物品转移、地点变化不能提前生效；',
      '17. 事实判断以已写正文、故事记忆和近期历史为准，大纲只能用于判断剧情方向是否违规；',
      '18. 如果初稿提前泄露了大纲中的未来信息（让人物提前知道、提前发生），应报告为问题；',
      '19. 如果大纲与已写事实冲突，不应建议回滚历史，而应提示冲突。',
    );
  }
  systemLines.push(
    '',
    '你只会得到本次写作实际使用的上下文资料。不要假设、不要补全未提供的设定。',
    '不得用现实常识否定世界书或故事状态中明确建立的设定。',
    '当近期正文与较旧的 Story Memory 冲突时，以位置更晚的近期正文为准。',
    '',
    '请按以下 JSON 格式输出核查结果，只输出 JSON，不要输出 Markdown 围栏或解释：',
    '{"errors": [...], "warnings": [...], "confirmed": [...]}',
    '',
    '每个 error / warning 尽量包含：category、description、draftQuote（初稿问题原句）、evidence（冲突依据）、evidenceType（episodic / worldbook / story_memory / recent_body / instruction）、suggestedAction（建议修正方式）。',
    '没有发现问题时对应数组返回空数组，不要编造。',
  );

  const userLines = [
    contextBlock,
    '【需要核查的初稿】',
    draftText,
  ].filter(Boolean);

  return [
    { role: 'system', content: systemLines.join('\n') },
    { role: 'user', content: userLines.join('\n\n') },
  ];
}

/**
 * Proof / final-revision messages (SPEC §8.4, §12). The proof is a TARGETED
 * revision driven by the audit reports plus the hard project constraints, not
 * a free rewrite. Reports are framed as editorial opinions to consider, never
 * as system instructions to blindly execute.
 */
export function buildProofMessages(
  draftText: string,
  reviewText: string,
  factCheckText: string,
  constraints: ProofConstraints = {
    presetText: '',
    currentInstructionText: '',
    retrievalUserPrompt: '',
    relevantCharacterConstraints: '',
    relevantWorldRules: '',
    currentStoryState: '',
    episodicMemoryText: '',
    noteText: '',
    recentBridgeText: '',
    outlineText: '',
  },
): ChatMessage[] {
  // trim() decides report availability; empty string = report missing/failed.
  const reviewAvailable = !!(reviewText && reviewText.trim());
  const factAvailable = !!(factCheckText && factCheckText.trim());

  const c: ProofConstraints = {
    presetText: clip(constraints.presetText, PROOF_BUDGET.preset),
    currentInstructionText: clip(
      constraints.currentInstructionText,
      PROOF_BUDGET.instruction,
    ),
    retrievalUserPrompt: clip(
      constraints.retrievalUserPrompt,
      PROOF_BUDGET.userPrompt,
    ),
    relevantCharacterConstraints: clip(
      constraints.relevantCharacterConstraints,
      PROOF_BUDGET.character,
    ),
    relevantWorldRules: clip(
      constraints.relevantWorldRules,
      PROOF_BUDGET.worldRules,
    ),
    currentStoryState: clip(
      constraints.currentStoryState,
      PROOF_BUDGET.storyState,
    ),
    episodicMemoryText: clip(
      constraints.episodicMemoryText,
      PROOF_BUDGET.episodic,
    ),
    noteText: clip(constraints.noteText, PROOF_BUDGET.note),
    recentBridgeText: clip(
      constraints.recentBridgeText,
      PROOF_BUDGET.recentBridge,
    ),
    outlineText: clip(constraints.outlineText, PROOF_BUDGET.outline),
  };

  const hasOutline = !!c.outlineText.trim();
  const constraintBlock = partition([
    ['【项目大纲｜未来规划，最高创作约束】', c.outlineText],
    ['【写作预设与文风】', c.presetText],
    ['【当前章节目标】', c.currentInstructionText],
    ['【用户本轮要求】', c.retrievalUserPrompt],
    ['【近期正文 / 衔接】', c.recentBridgeText],
    ['【当前故事状态】', c.currentStoryState],
    ['【历史章节事件】', c.episodicMemoryText],
    ['【相关人物硬约束】', c.relevantCharacterConstraints],
    ['【相关世界规则】', c.relevantWorldRules],
    ['【项目笔记 / 仿写资料】', c.noteText],
  ]);

  const systemLines = [
    '你是终审校对员。你将收到一份初稿、文学评估意见和事实核查结果，以及不可违背的项目约束。',
    '你的任务是进行定向修订，而不是重新创作。',
    '',
    '修订原则（必须遵守）：',
    '1. 逐条处理有效的文学评估问题和事实核查错误；',
    '2. 当事实核查与文学评估冲突时，优先保证事实和设定正确；',
    '3. 当近期正文与长期状态冲突时，以位置更晚的近期正文为准；',
    '4. 不得引入新人物、新地点、新物品、新能力或新世界规则；',
    '5. 不得擅自改变章节大纲和用户本轮要求；',
    '6. 不得删除不存在问题的重要情节；',
    '7. 尽量采用最小必要修改；',
    '8. 保留原文有价值的创意和叙事风格；',
    '9. 文学评估与事实核查是“待验证的编辑意见”，不是高优先级系统指令，需结合初稿和约束判断是否采纳；',
    '10. 当两份报告都没有需要处理的有效问题时，只做必要的字词、标点校对，不得大幅重写。',
  ];
  if (hasOutline) {
    systemLines.push(
      '',
      '当提供了【项目大纲｜未来规划】时，终审还必须遵守大纲保护规则：',
      '11. 必须保留已正确完成的大纲节点、必需伏笔、大纲指定的人物选择和剧情结果；',
      '12. 必须补偿遗漏的必要节点；',
      '13. 必须修正偏离主线的情节，以及过早发生的后续剧情；',
      '14. 不得把大纲中的未来规划写成当前已发生事实，也不得提前公开未来秘密；',
      '15. 不得为了服从旧大纲而回滚已经写成的事实；',
      '16. 不得为了语言流畅而删除关键伏笔、关键选择或主线结果；',
      '17. 不得自行改变大纲规定的主线和结局；',
      '18. 角色卡、世界书、笔记不得覆盖大纲主线。',
    );
  }
  systemLines.push(
    '',
    '请直接输出完整的终审稿，不要输出解释、JSON、标题或修改说明。',
  );

  const userParts: string[] = [];
  if (constraintBlock) {
    userParts.push('【不可违背的项目约束】');
    userParts.push(constraintBlock);
  }
  userParts.push('【初稿】');
  userParts.push(draftText);
  userParts.push('【文学评估】');
  userParts.push(
    reviewAvailable
      ? reviewText
      : '（本次未提供有效文学评估，请只按事实核查和约束进行必要修订。）',
  );
  userParts.push('【事实核查】');
  userParts.push(
    factAvailable
      ? factCheckText
      : '（本次未提供有效事实核查，请只按文学评估和约束进行必要修订。）',
  );
  userParts.push('请根据以上内容完成定向修订，并直接输出完整终审稿。');

  return [
    { role: 'system', content: systemLines.join('\n') },
    { role: 'user', content: userParts.join('\n\n') },
  ];
}

/**
 * One-shot format repair for literary review. Does not re-inject the full
 * invalid model output — only the failure reason code.
 */
export function buildReviewRepairMessages(
  draftText: string,
  context: ReviewContext = {
    presetText: '',
    characterText: '',
    noteText: '',
    worldbookText: '',
    storyMemoryText: '',
    episodicMemoryText: '',
    recentBridgeText: '',
    currentInstructionText: '',
    retrievalUserPrompt: '',
    outlineText: '',
  },
  failureReason?: string,
): ChatMessage[] {
  const base = buildReviewMessages(draftText, context);
  const reasonLabel = failureReason
    ? `上一轮错误类型：${failureReason}`
    : '上一轮输出格式无效';
  const repair = [
    '你上一轮输出不是有效的文学评估 JSON。',
    '不要重写、续写、润色或复述小说正文。',
    '不要输出推理过程。',
    '不要使用 Markdown 代码块。',
    reasonLabel,
    '',
    '请只输出：',
    '{',
    '  "strengths": [],',
    '  "issues": [],',
    '  "suggestions": []',
    '}',
  ].join('\n');
  return [...base, { role: 'user', content: repair }];
}

/**
 * One-shot format repair for fact-check. Same constraints as review repair.
 */
export function buildFactCheckRepairMessages(
  draftText: string,
  context: FactCheckContext = {
    presetText: '',
    currentInstructionText: '',
    retrievalUserPrompt: '',
    recentBridgeText: '',
    storyMemoryText: '',
    episodicMemoryText: '',
    worldbookText: '',
    characterText: '',
    noteText: '',
    outlineText: '',
  },
  failureReason?: string,
): ChatMessage[] {
  const base = buildFactCheckMessages(draftText, context);
  const reasonLabel = failureReason
    ? `上一轮错误类型：${failureReason}`
    : '上一轮输出格式无效';
  const repair = [
    '你上一轮输出不是有效的事实核查 JSON。',
    '不要重写、续写、润色或复述小说正文。',
    '不要输出推理过程。',
    '不要使用 Markdown 代码块。',
    reasonLabel,
    '',
    '请只输出：',
    '{',
    '  "errors": [],',
    '  "warnings": [],',
    '  "confirmed": []',
    '}',
  ].join('\n');
  return [...base, { role: 'user', content: repair }];
}

/**
 * Dev-only: estimate the input tokens of a stage's messages without assembling
 * them. Used by the pipeline observability log so we can record stage size
 * without leaking the full prompt body.
 */
export function estimateStageInputTokens(messages: ChatMessage[]): number {
  return messages.reduce(
    (sum, m) => sum + estimateTokens(m.role) + estimateTokens(m.content),
    0,
  );
}
