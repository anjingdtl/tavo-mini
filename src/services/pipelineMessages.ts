import type { ChatMessage } from './llm';
import { clipTextToTokenBudget, estimateTokens } from '../utils/tokenEstimator';
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
/**
 * Soft upper bounds used only when the caller has not already budget-clipped
 * context fields. The conservation allocator in compileStageRequest is the
 * authority for optional-section sizes; these defaults prevent runaway fields
 * when builders are used outside the compiler.
 */
const REVIEW_BUDGET = {
  preset: 8000,
  character: 8000,
  note: 6000,
  worldbook: 8000,
  storyMemory: 8000,
  episodic: 8000,
  recentBridge: 10000,
  instruction: 2000,
  userPrompt: 2000,
  // Outline is NEVER clipped: the frozen full text from the pipeline snapshot
  // is required for cross-stage consistency. Stage-level window checks block
  // the call when the complete outline + required body cannot fit.
};

const FACTCHECK_BUDGET = {
  preset: 8000,
  instruction: 2000,
  userPrompt: 2000,
  recentBridge: 10000,
  storyMemory: 10000,
  episodic: 10000,
  worldbook: 10000,
  character: 8000,
  note: 6000,
  // Outline is never clipped (see REVIEW_BUDGET note).
};

const PROOF_BUDGET = {
  preset: 8000,
  instruction: 2000,
  userPrompt: 2000,
  character: 8000,
  worldRules: 8000,
  storyState: 8000,
  episodic: 8000,
  note: 6000,
  recentBridge: 10000,
  // Outline is never clipped (see REVIEW_BUDGET note).
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
    // Full frozen outline — never silently truncated across stages.
    outlineText: context.outlineText ? String(context.outlineText) : '',
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
      ? [
          '- outlineAssessment 仅在提供了项目大纲时输出，没有发现问题时对应数组返回空数组；',
        ]
      : []),
    '- 不要输出完整修订稿；',
    '- 没有发现问题时，对应数组返回空数组，不要编造。',
  );

  const userLines = [contextBlock, '【需要审阅的初稿】', draftText].filter(
    Boolean,
  );

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
    storyMemoryText: clip(
      context.storyMemoryText,
      FACTCHECK_BUDGET.storyMemory,
    ),
    episodicMemoryText: clip(
      context.episodicMemoryText,
      FACTCHECK_BUDGET.episodic,
    ),
    worldbookText: clip(context.worldbookText, FACTCHECK_BUDGET.worldbook),
    characterText: clip(context.characterText, FACTCHECK_BUDGET.character),
    noteText: clip(context.noteText, FACTCHECK_BUDGET.note),
    // Full frozen outline — never silently truncated across stages.
    outlineText: context.outlineText ? String(context.outlineText) : '',
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

  const userLines = [contextBlock, '【需要核查的初稿】', draftText].filter(
    Boolean,
  );

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
    // Full frozen outline — never silently truncated across stages.
    outlineText: constraints.outlineText ? String(constraints.outlineText) : '',
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
  const hasOutline = !!(context.outlineText && context.outlineText.trim());
  const reasonLabel = failureReason
    ? `上一轮错误类型：${failureReason}`
    : '上一轮输出格式无效';
  const schemaLines = hasOutline
    ? [
        '请只输出：',
        '{',
        '  "strengths": [],',
        '  "issues": [],',
        '  "suggestions": [],',
        '  "outlineAssessment": {',
        '    "status": "aligned|partial|deviated|over_advanced",',
        '    "fulfilledBeats": [],',
        '    "missingBeats": [],',
        '    "deviations": [],',
        '    "prematureBeats": [],',
        '    "factRollbackRisks": []',
        '  }',
        '}',
      ]
    : [
        '请只输出：',
        '{',
        '  "strengths": [],',
        '  "issues": [],',
        '  "suggestions": []',
        '}',
      ];
  const repair = [
    '你上一轮输出不是有效的文学评估 JSON。',
    '不要重写、续写、润色或复述小说正文。',
    '不要输出推理过程。',
    '不要使用 Markdown 代码块。',
    reasonLabel,
    '',
    ...schemaLines,
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

// ---------------------------------------------------------------------------
// V5-Lite workflow version 2: anchored Review / FactCheck messages.
// Draft body is injected EXACTLY ONCE in tagged form (§5.5). Audit reports are
// structured contracts (§6–§8); the client backfills real anchor text.
// ---------------------------------------------------------------------------

/** Shared correction schema doc used by both V2 audit prompts. */
const V2_CORRECTION_SCHEMA_LINES = [
  '"requiredCorrections": 数组中每条修正项必须符合：',
  '  {',
  '    "id": "唯一短 id，如 r1 / f2",',
  '    "scope": "anchor | range | insertion | chapter | boundary",',
  '    "dimension": "问题维度（如 人物表现 / 连续性 / 大纲执行）",',
  '    "severity": "required | hard | warning",',
  '    "diagnosis": "问题诊断（简洁）",',
  '    "rewriteGoal": "期望的修订目标（简洁、可执行）",',
  '    "preserveMeaning": ["修订时必须保留的原意（可为空数组）"]',
  '  }',
  'scope 定位字段规则：',
  '  - anchor：anchorId（单段问题）；',
  '  - range：anchorIds（至少两个，跨段/顺序问题）；',
  '  - insertion：insertionBeforeAnchorId 或 insertionAfterAnchorId（缺段/插入点）；',
  '  - chapter：整个章节层面，不填任何 anchor 字段；',
  '  - boundary：boundary 取 "opening" | "ending"（开头承接/章末落点），可附邻近 anchorId。',
  '禁止输出 excerpt、start、end 或任何原文摘录——所有原文由客户端根据 anchor 回填。',
  '禁止把 [draft-p-xxx] 标记写进诊断或任何报告文本。',
];

const V2_COMMON_RULES = [
  '你只会得到本次写作实际使用的上下文资料。不要假设、不要补全未提供的设定。',
  '不得用现实常识否定世界书或故事状态中明确建立的设定。',
  '只输出 JSON，不要输出 Markdown 围栏、解释或推理过程。',
  'Thinking/Reasoning 是内部思考通道；最终合同必须写入 message.content，不能只停留在 reasoning_content。',
  '没有问题时，对应数组返回空数组，不要编造。',
  '不得输出完整修订稿或整段正文重述。',
];

/**
 * Literary review V2 (anchored). Review judges literature, outline execution
 * and chapter structure — NOT canon hard-fact adjudication (§7).
 */
export function buildReviewV2Messages(params: {
  taggedDraft: string;
  context: ReviewContext;
  draftHash: string;
  /** Anchor count for the tagged draft; used to bound id validity. */
  anchorCount?: number;
}): ChatMessage[] {
  const ctx: ReviewContext = {
    presetText: clip(params.context.presetText, REVIEW_BUDGET.preset),
    characterText: clip(params.context.characterText, REVIEW_BUDGET.character),
    noteText: clip(params.context.noteText, REVIEW_BUDGET.note),
    worldbookText: clip(params.context.worldbookText, REVIEW_BUDGET.worldbook),
    storyMemoryText: clip(
      params.context.storyMemoryText,
      REVIEW_BUDGET.storyMemory,
    ),
    episodicMemoryText: clip(
      params.context.episodicMemoryText,
      REVIEW_BUDGET.episodic,
    ),
    recentBridgeText: clip(
      params.context.recentBridgeText,
      REVIEW_BUDGET.recentBridge,
    ),
    currentInstructionText: clip(
      params.context.currentInstructionText,
      REVIEW_BUDGET.instruction,
    ),
    retrievalUserPrompt: clip(
      params.context.retrievalUserPrompt,
      REVIEW_BUDGET.userPrompt,
    ),
    outlineText: params.context.outlineText
      ? String(params.context.outlineText)
      : '',
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

  const systemLines = [
    '你是小说终审前的审阅编辑。你的职责是执行“修订合同”的第一步：',
    '对带锚点的初稿做文学、大纲执行与章节结构评估，把判断转成可定位、可执行的修正合同。',
    '',
    '关注范围（仅文学与结构，不裁决事实对错）：',
    '1. 本章大纲节点落实情况——是否完成应承担的主线推进；',
    '2. 缺失 Beat 与后续剧情是否提前（premature）；',
    '3. 场景顺序、节奏、人物表现、对话与情绪递进；',
    '4. 开头承接上一章、章末落点是否得当；',
    '5. 冗余、重复、Show/Tell、机械总结；',
    '6. 已正确完成且终稿必须保护的内容（列入 protectedAnchorIds）。',
    '',
    '正文以锚点形式给出，每个 [draft-p-xxx] 是一次定位：',
    '- 锚点标记只用于定位，禁止写入报告或小说；',
    '- 输出必须紧凑，不得重复整段正文，不得输出完整修订稿。',
    '',
    '请按以下 JSON 合同输出（schemaVersion 固定 2，draftHash 必须与给定值一致）：',
    '{',
    '  "schemaVersion": 2,',
    '  "draftHash": "' + params.draftHash + '",',
    '  "requiredCorrections": [],',
    '  "protectedAnchorIds": [],',
    '  "outlineExecution": {',
    '    "fulfilledBeats": [],',
    '    "missingBeats": [],',
    '    "deviations": [],',
    '    "prematureBeats": [],',
    '    "mustPreserve": [],',
    '    "endingGoal": "",',
    '    "mustNotAdvance": []',
    '  }',
    '}',
    '',
    ...V2_CORRECTION_SCHEMA_LINES,
    'outlineExecution 语义：',
    '  - fulfilledBeats：本章已正确完成的大纲节点；',
    '  - missingBeats：应当完成但缺失的节点；',
    '  - deviations：偏离主线的情节；',
    '  - prematureBeats：过早发生的后续剧情；',
    '  - mustPreserve：终稿必须保留的内容（与 protectedAnchorIds 互补）；',
    '  - endingGoal：本章应落到的结尾状态（无则空字符串）；',
    '  - mustNotAdvance：不得提前写成的未来内容。',
    '',
    ...V2_COMMON_RULES,
  ];

  const userLines = [
    contextBlock,
    '【带锚点的初稿｜正文只出现这一次】',
    params.taggedDraft,
  ].filter(Boolean);

  return [
    { role: 'system', content: systemLines.join('\n') },
    { role: 'user', content: userLines.join('\n\n') },
  ];
}

/**
 * Fact-check V2 (anchored). Facts / state / continuity / knowledge boundary;
 * never overrides established world rules with real-world common sense (§8).
 */
export function buildFactCheckV2Messages(params: {
  taggedDraft: string;
  context: FactCheckContext;
  draftHash: string;
}): ChatMessage[] {
  const ctx: FactCheckContext = {
    presetText: clip(params.context.presetText, FACTCHECK_BUDGET.preset),
    currentInstructionText: clip(
      params.context.currentInstructionText,
      FACTCHECK_BUDGET.instruction,
    ),
    retrievalUserPrompt: clip(
      params.context.retrievalUserPrompt,
      FACTCHECK_BUDGET.userPrompt,
    ),
    recentBridgeText: clip(
      params.context.recentBridgeText,
      FACTCHECK_BUDGET.recentBridge,
    ),
    storyMemoryText: clip(
      params.context.storyMemoryText,
      FACTCHECK_BUDGET.storyMemory,
    ),
    episodicMemoryText: clip(
      params.context.episodicMemoryText,
      FACTCHECK_BUDGET.episodic,
    ),
    worldbookText: clip(
      params.context.worldbookText,
      FACTCHECK_BUDGET.worldbook,
    ),
    characterText: clip(
      params.context.characterText,
      FACTCHECK_BUDGET.character,
    ),
    noteText: clip(params.context.noteText, FACTCHECK_BUDGET.note),
    outlineText: params.context.outlineText
      ? String(params.context.outlineText)
      : '',
  };

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
    '你是小说事实核查员。你的职责是把初稿中的事实性问题转成可定位、可执行的修正合同。',
    '',
    '检查范围：',
    '1. 人物位置、身体和情绪状态；',
    '2. 人物已知 / 未知信息（信息边界）；',
    '3. 关系、时间、地点和物品归属；',
    '4. 能力与世界规则；',
    '5. 已发生事件、Story Memory、Episodic Memory、Recent Bridge 连续性；',
    '6. 不得提前发生或提前得知的硬事实；',
    '7. 用户明确确认的事实。',
    '',
    '纪律：',
    '- 大纲中的未来事件不能被当作已经发生；',
    '- 当近期正文与较旧的 Story Memory 冲突时，以位置更晚的近期正文为准；',
    '- 不负责纯文学偏好，不得用现实常识覆盖已建立的世界规则；',
    '- 锚点标记只用于定位，禁止写入报告或小说；',
    '- 输出必须紧凑，不得重复整段正文。',
    '',
    '请按以下 JSON 合同输出（schemaVersion 固定 2，draftHash 必须与给定值一致）：',
    '{',
    '  "schemaVersion": 2,',
    '  "draftHash": "' + params.draftHash + '",',
    '  "requiredCorrections": [],',
    '  "protectedFacts": [],',
    '  "hardConstraints": []',
    '}',
    '',
    ...V2_CORRECTION_SCHEMA_LINES,
    'protectedFacts：已确认正确且终稿必须保持的事实；',
    'hardConstraints：任何修订都不得违反的硬约束。',
    '',
    ...V2_COMMON_RULES,
  ];

  const userLines = [
    contextBlock,
    '【带锚点的初稿｜正文只出现这一次】',
    params.taggedDraft,
  ].filter(Boolean);

  return [
    { role: 'system', content: systemLines.join('\n') },
    { role: 'user', content: userLines.join('\n\n') },
  ];
}

/** V3.1 semantic audit contracts. Anchor text may remain as reading context,
 * but the contract never requires an anchor locator to be valid. */
export function buildReviewV31Messages(params: {
  canonicalDraft: string;
  context: ReviewContext;
  draftHash: string;
}): ChatMessage[] {
  const base = buildReviewV2Messages({
    taggedDraft: params.canonicalDraft,
    context: params.context,
    draftHash: params.draftHash,
  });
  return [
    {
      role: 'system',
      content: [
        '你是 ShineWriter V3.1 的文学评估器。只输出结构化评估，不输出正文、推理或 Markdown。',
        '位置使用 target.kind：opening、scene、middle、ending、global；不要依赖锚点 ID 才能成立。',
        '每条 correction 必须包含 id、severity（hard/required/advisory；warning 也可作为 advisory 别名）、category、target、finding、instruction；preserve 可选，evidenceQuote、sceneHint、sourceRefs 可选。',
        'category 使用 opening_continuity、outline_execution、character、world_rule、timeline、space、causality、style 或 ending_boundary。',
        '必须提供 outlineExecution 的 fulfilledBeats、missingBeats、deviations、prematureBeats、mustPreserve、endingGoal、mustNotAdvance 数组/字段。',
        '顶层只能输出 schemaVersion、draftHash、corrections、protectedFacts、outlineExecution 这五个字段，不得添加其他字段。',
        'schemaVersion 必须是数字 3；draftHash 必须与给定值完全一致。',
        JSON.stringify({
          schemaVersion: 3,
          draftHash: params.draftHash,
          corrections: [],
          protectedFacts: [],
          outlineExecution: {
            fulfilledBeats: [],
            missingBeats: [],
            deviations: [],
            prematureBeats: [],
            mustPreserve: [],
            endingGoal: '',
            mustNotAdvance: [],
          },
        }),
      ].join('\n'),
    },
    { role: 'user', content: base[1].content },
  ];
}

export function buildFactCheckV31Messages(params: {
  canonicalDraft: string;
  context: FactCheckContext;
  draftHash: string;
}): ChatMessage[] {
  const base = buildFactCheckV2Messages({
    taggedDraft: params.canonicalDraft,
    context: params.context,
    draftHash: params.draftHash,
  });
  return [
    {
      role: 'system',
      content: [
        '你是 ShineWriter V3.1 的事实核查器。只输出结构化核查，不输出正文、推理或 Markdown。',
        '位置使用 target.kind：opening、scene、middle、ending、global；不要依赖锚点 ID 才能成立。',
        '每条 correction 必须包含 id、severity（hard/required/advisory；warning 也可作为 advisory 别名）、category、target、finding、instruction；preserve 可选，evidenceQuote、sceneHint、sourceRefs 可选。',
        'category 使用 timeline、character_state、object_state、world_rule、spatial_logic、knowledge_boundary 或 outline_boundary 等已知事实维度。',
        'corrections 可以是空数组，表示没有事实修正；hardConstraints 必须始终提供数组，缺失即为无效合同。',
        '顶层只能输出 schemaVersion、draftHash、corrections、protectedFacts、hardConstraints 这五个字段，不得添加其他字段。',
        'schemaVersion 必须是数字 3；draftHash 必须与给定值完全一致。',
        JSON.stringify({
          schemaVersion: 3,
          draftHash: params.draftHash,
          corrections: [],
          protectedFacts: [],
          hardConstraints: [],
        }),
      ].join('\n'),
    },
    { role: 'user', content: base[1].content },
  ];
}

/** V3.2 semantic payload prompts.  Machine-owned envelope fields are omitted
 * from the model contract and are filled locally after semantic validation. */
export function buildReviewV32Messages(params: {
  canonicalDraft: string;
  context: ReviewContext;
}): ChatMessage[] {
  const base = buildReviewV2Messages({
    taggedDraft: params.canonicalDraft,
    context: params.context,
    draftHash: '',
  });
  return [
    {
      role: 'system',
      content: [
        '你是 ShineWriter V3.2 的文学评估器。正式审阅调用启用 low Thinking，但最终语义 JSON 必须写入 message.content。',
        '只输出语义载荷，不输出 schema、draftHash、protectedFacts、hardConstraints、mustNotAdvance 或其他本地信封字段。',
        '顶层必须包含 verdict（pass/needs_revision）、findings、outlineAssessment、coverage。',
        'findings 每项包含 severity（hard/required/advisory）、category、target、finding、instruction；target.kind 为 opening/scene/middle/ending/global；preserve 可选。',
        'category 只能使用 opening_continuity、outline_execution、character、prose、spatial_logic、causality、ending_boundary。',
        'coverage.checkedDimensions 必须至少包含 opening_continuity、outline_execution、character、prose、ending_boundary，即使没有发现问题也必须明确写出已检查范围。',
        'needs_revision 必须有 hard 或 required finding；pass 可以 findings=[]，但不得省略 coverage receipt。',
        JSON.stringify({
          verdict: 'pass',
          findings: [],
          outlineAssessment: {
            fulfilled: [],
            missing: [],
            deviations: [],
            premature: [],
            endingAssessment: '',
          },
          coverage: {
            checkedDimensions: [
              'opening_continuity',
              'outline_execution',
              'character',
              'prose',
              'ending_boundary',
            ],
          },
        }),
      ].join('\n'),
    },
    { role: 'user', content: base[1].content },
  ];
}

export function buildFactCheckV32Messages(params: {
  canonicalDraft: string;
  context: FactCheckContext;
  inputFactRefs?: readonly string[];
  inputDimensions?: readonly string[];
}): ChatMessage[] {
  const base = buildFactCheckV2Messages({
    taggedDraft: params.canonicalDraft,
    context: params.context,
    draftHash: '',
  });
  return [
    {
      role: 'system',
      content: [
        '你是 ShineWriter V3.2 的事实核查器。正式核查调用启用 low Thinking，但最终语义 JSON 必须写入 message.content。',
        '只输出语义载荷，不输出 schema、draftHash、protectedFacts、hardConstraints 或事实数据库正文。',
        '顶层必须包含 verdict（pass/needs_revision/not_applicable）、findings、confirmedFactRefs、coverage。',
        'findings 每项包含 severity（hard/required/advisory）、category、target、finding、instruction；category 只能使用 timeline、character_state、object_state、world_rule、spatial_logic、knowledge_boundary、outline_boundary。',
        'coverage 必须包含 checkedDimensions 与 checkedFactRefs。findings=[] 只有在 pass 且 coverage 证明完成核查时才有效；只有当冻结输入事实 ID 和可核查维度都为空时才允许使用 not_applicable，客户端会记录 FACT_CONTEXT_EMPTY warning。',
        '只要存在任意冻结输入事实 ID 或可核查维度，verdict 必须是 pass 或 needs_revision，不能使用 not_applicable；无冲突时使用 pass，并把实际检查过的输入维度写入 checkedDimensions，至少把一个实际输入事实 ID 写入 checkedFactRefs 或 confirmedFactRefs。',
        'verdict=needs_revision 时，findings 至少包含一条完整的 hard 或 required finding；每条 finding 的五个字段都必须非空，target 必须是 kind 为 opening/scene/middle/ending/global 的对象或字符串。无法完整填写的 finding 必须删除，不要输出半条 finding，也不要用 warning/advisory finding 单独触发 needs_revision。',
        '如果没有能够完整描述的事实冲突，使用 verdict=pass 与 findings=[]；不要为了表达不确定性输出 needs_revision 加空数组或不完整 finding。',
        `本次冻结可核查维度（必须全部覆盖；只能使用这些值）：${JSON.stringify([
          ...new Set(
            (params.inputDimensions || []).map(String).filter(Boolean),
          ),
        ])}`,
        `本次冻结输入事实 ID（只能从中选择 checkedFactRefs/confirmedFactRefs，不得创造新 ID）：${JSON.stringify(
          [
            ...new Set(
              (params.inputFactRefs || []).map(String).filter(Boolean),
            ),
          ],
        )}`,
        JSON.stringify({
          verdict:
            params.inputFactRefs?.length || params.inputDimensions?.length
              ? 'pass'
              : 'not_applicable',
          findings: [],
          confirmedFactRefs: [
            ...new Set(
              (params.inputFactRefs || []).map(String).filter(Boolean),
            ),
          ],
          coverage: {
            checkedDimensions: [
              ...new Set(
                (params.inputDimensions || []).map(String).filter(Boolean),
              ),
            ],
            checkedFactRefs: [
              ...new Set(
                (params.inputFactRefs || []).map(String).filter(Boolean),
              ),
            ],
          },
        }),
      ].join('\n'),
    },
    { role: 'user', content: base[1].content },
  ];
}

/** Current compact semantic contract. Machine IDs/envelopes are local. */
export function buildReviewV33Messages(params: {
  canonicalDraft: string;
  context: ReviewContext;
}): ChatMessage[] {
  const base = buildReviewV2Messages({
    taggedDraft: params.canonicalDraft,
    context: params.context,
    draftHash: '',
  });
  return [
    {
      role: 'system',
      content: [
        '你是 ShineWriter 当前统一流水线的 Review 评估器。保持 low Thinking；最终 JSON 必须写入 message.content。',
        '只做语义判断，不输出正文、Markdown、推理过程、schema、hash、sourceId 或本地信封。',
        '顶层只输出 verdict、checked、findings，可选 preserve、ending。',
        'verdict 只能是 pass 或 needs_revision；checked 必须原样包含这五个已检查维度：opening_continuity、outline_execution、character、prose、ending_boundary。',
        'findings 可为空；每项只写 target（必须是 Draft 中的 anchor，如 draft-p-001）、level（hard/required/advisory）、issue、instruction，可选 preserve。不得创造 Draft 中不存在的 anchor。',
        'needs_revision 必须至少有一条 hard 或 required finding；没有完整判断时使用 pass 与空 findings。',
        JSON.stringify({
          verdict: 'pass',
          checked: [
            'opening_continuity',
            'outline_execution',
            'character',
            'prose',
            'ending_boundary',
          ],
          findings: [],
          preserve: [],
          ending: '',
        }),
      ].join('\n'),
    },
    { role: 'user', content: base[1].content },
  ];
}

export function buildFactCheckV33Messages(params: {
  canonicalDraft: string;
  context: FactCheckContext;
  inputFactRefs?: readonly string[];
  inputDimensions?: readonly string[];
}): ChatMessage[] {
  const base = buildFactCheckV2Messages({
    taggedDraft: params.canonicalDraft,
    context: params.context,
    draftHash: '',
  });
  const checked = [
    ...(params.inputDimensions || []).map(String),
    ...(params.inputFactRefs || []).map(String),
  ];
  return [
    {
      role: 'system',
      content: [
        '你是 ShineWriter 当前统一流水线的 FactCheck 事实核查器。保持 low Thinking；最终 JSON 必须写入 message.content。',
        '只做语义判断，不输出正文、Markdown、推理过程、schema、hash、sourceId 或事实数据库正文。',
        '顶层只输出 verdict、checked、findings，可选 preserve。',
        'checked 是必须保留的核查收据，必须逐字包含本次冻结输入的全部维度和事实 ID；不能新增或改写 ID。',
        'verdict 只能是 pass、needs_revision、not_applicable；存在任何 checked 输入时不得使用 not_applicable。',
        'findings 可为空；每项只写 target（必须是 Draft 中的 anchor，如 draft-p-001）、level（hard/required/advisory）、issue、instruction，可选 preserve。不得创造 Draft 中不存在的 anchor。',
        'needs_revision 必须至少有一条 hard 或 required finding；没有完整事实冲突时使用 pass 与空 findings。',
        `本次必须写入 checked 的收据：${JSON.stringify([...new Set(checked)])}`,
        JSON.stringify({
          verdict: checked.length ? 'pass' : 'not_applicable',
          checked: [...new Set(checked)],
          findings: [],
          preserve: [],
        }),
      ].join('\n'),
    },
    { role: 'user', content: base[1].content },
  ];
}

/** One-shot format repair for Review V2 (same policy as V1). */
export function buildReviewV2RepairMessages(params: {
  taggedDraft: string;
  context: ReviewContext;
  draftHash: string;
  failureReason?: string;
}): ChatMessage[] {
  const base = buildReviewV2Messages(params);
  const reasonLabel = params.failureReason
    ? `上一轮错误类型：${params.failureReason}`
    : '上一轮输出格式无效';
  const repair = [
    '你上一轮输出不是有效的 V2 文学评估合同。',
    '不要重写、续写、润色或复述小说正文。',
    '不要输出推理过程。',
    '不要使用 Markdown 代码块。',
    reasonLabel,
    '',
    '请只输出：',
    '{',
    '  "schemaVersion": 2,',
    '  "draftHash": "' + params.draftHash + '",',
    '  "requiredCorrections": [],',
    '  "protectedAnchorIds": [],',
    '  "outlineExecution": {',
    '    "fulfilledBeats": [],',
    '    "missingBeats": [],',
    '    "deviations": [],',
    '    "prematureBeats": [],',
    '    "mustPreserve": [],',
    '    "endingGoal": "",',
    '    "mustNotAdvance": []',
    '  }',
    '}',
  ].join('\n');
  return [...base, { role: 'user', content: repair }];
}

/** One-shot format repair for FactCheck V2 (same policy as V1). */
export function buildFactCheckV2RepairMessages(params: {
  taggedDraft: string;
  context: FactCheckContext;
  draftHash: string;
  failureReason?: string;
}): ChatMessage[] {
  const base = buildFactCheckV2Messages(params);
  const reasonLabel = params.failureReason
    ? `上一轮错误类型：${params.failureReason}`
    : '上一轮输出格式无效';
  const repair = [
    '你上一轮输出不是有效的 V2 事实核查合同。',
    '不要重写、续写、润色或复述小说正文。',
    '不要输出推理过程。',
    '不要使用 Markdown 代码块。',
    reasonLabel,
    '',
    '请只输出：',
    '{',
    '  "schemaVersion": 2,',
    '  "draftHash": "' + params.draftHash + '",',
    '  "requiredCorrections": [],',
    '  "protectedFacts": [],',
    '  "hardConstraints": []',
    '}',
  ].join('\n');
  return [...base, { role: 'user', content: repair }];
}

// ---------------------------------------------------------------------------
// Final Reviser (V2 Proof) — executes the revision contract, does NOT re-study
// every source. Contract first, full canonical draft second, minimal chapter
// goal / seam / style / hard constraints after (§11).
// ---------------------------------------------------------------------------

const FINAL_REVISER_BUDGET = {
  preset: 3000,
  instruction: 1500,
  userPrompt: 1500,
  recentBridge: 6000,
  hardConstraints: 4000,
};

/**
 * V2 Final Reviser messages (§11). The revision contract is the single
 * "edit work packet"; the draft is injected once; the whole outline, raw
 * audit JSON, full character/worldbook/story-memory blobs are NOT re-injected.
 *
 * Output protocol (§11.5): complete novel body only. No patch/diff, no
 * "其余内容不变", no contract JSON, no change notes, no anchor markers,
 * no reasoning, no prompt echoes.
 */
export function buildFinalReviserMessages(params: {
  /** Serialized revision contract JSON (compact). */
  contractJson: string;
  /** Contract work-item count for the prompt (observability-friendly). */
  workItemCount: number;
  /** Full canonical draft (single injection). */
  canonicalDraft: string;
  currentInstructionText?: string;
  retrievalUserPrompt?: string;
  recentBridgeText?: string;
  /** Slimmed preset (writing style essentials). */
  presetText?: string;
  /** Contract-derived hard constraints (may duplicate contract JSON). */
  hardConstraints?: string[];
}): ChatMessage[] {
  const instruction = clip(
    params.currentInstructionText,
    FINAL_REVISER_BUDGET.instruction,
  );
  const userPrompt = clip(
    params.retrievalUserPrompt,
    FINAL_REVISER_BUDGET.userPrompt,
  );
  const bridge = clip(
    params.recentBridgeText,
    FINAL_REVISER_BUDGET.recentBridge,
  );
  const preset = clip(params.presetText, FINAL_REVISER_BUDGET.preset);
  const hardList = (params.hardConstraints || [])
    .filter(h => h && h.trim())
    .map(h => `- ${h.trim()}`)
    .join('\n');

  const hasContract =
    typeof params.contractJson === 'string' &&
    params.contractJson.trim().length > 0;

  const systemLines = [
    '你是终稿修订员（Final Reviser）。你的任务不是重新创作，也不是重新研究全部资料，',
    '而是严格按给定的“修订合同”对初稿做定向修订。',
    '',
    '必须遵守：',
    '1. 逐条执行修订合同中的 workItems；',
    '2. 只对合同要求的位置做必要修改，其余内容保持原样；',
    '3. 优先保证事实与硬约束正确（合同顺序已按优先级排好）；',
    '4. 不得引入新人物、新地点、新物品、新能力或新世界规则；',
    '5. 不得擅自改变大纲节点和用户本轮要求；',
    '6. 必须保留合同列出的 protectedAnchorIds / protectedFacts / outlineObligations.mustPreserve；',
    '7. 不得提前写出 outlineObligations.mustNotAdvance 中的未来内容；',
    '8. 修订必须满足合同 outlineObligations.endingGoal 要求的章末状态（如提供）；',
    '9. 保持原文有价值的创意和叙事风格，采用最小必要修改；',
    '10. 合同没有要求修改的部分，不要动。',
    '',
    '输出要求：',
    '- 直接输出完整的终稿正文；',
    '- 禁止输出 patch / diff / “其余内容不变”等说明；',
    '- 禁止输出修订合同 JSON 或任何修改说明；',
    '- 禁止输出 [draft-p-xxx] 之类的锚点标记；',
    '- 禁止输出推理过程（<think> 等）；',
    '- 禁止复述提示词内容。',
  ];

  const userParts: string[] = [];
  if (hasContract) {
    userParts.push('【修订合同（Edit Work Packet）｜最高执行优先级】');
    userParts.push(params.contractJson);
    if (params.workItemCount >= 0) {
      userParts.push(`合同包含 ${params.workItemCount} 条修订项。`);
    }
  }
  userParts.push('【初稿｜正文只出现这一次】');
  userParts.push(params.canonicalDraft);

  const extraBlock = partition([
    ['【当前章节目标】', instruction],
    ['【用户本轮要求】', userPrompt],
    ['【上一章接缝 / 近期正文】', bridge],
    ['【精简文风参考】', preset],
  ]);
  if (extraBlock) {
    userParts.push('【上下文（辅助）】');
    userParts.push(extraBlock);
  }
  if (hardList) {
    userParts.push('【硬约束】');
    userParts.push(hardList);
  }
  userParts.push('请根据修订合同完成定向修订，并直接输出完整终稿正文。');

  return [
    { role: 'system', content: systemLines.join('\n') },
    { role: 'user', content: userParts.join('\n\n') },
  ];
}

const FINAL_V3_BUDGET = {
  previousChapter: 12000,
  storyMemory: 8000,
  characters: 6000,
  worldRules: 6000,
  note: 4000,
  recentBridge: 6000,
  episodic: 5000,
  instruction: 1800,
  userPrompt: 1800,
  preset: 2200,
};

/**
 * V3 Final messages: plain writing brief + canonical draft + continuity
 * capsule. No Revision Contract JSON, source IDs or anchor protocol.
 */
export function buildFinalReviserV3Messages(params: {
  writingBrief: string;
  canonicalDraft: string;
  capsule: {
    fullOutlineText: string;
    immediatePreviousChapterText: string;
    immediatePreviousEnding: string;
    recentBridgeText: string;
    storyMemoryText: string;
    episodicMemoryText: string;
    relevantCharacterText: string;
    relevantWorldRules: string;
    noteText: string;
    currentInstructionText: string;
    retrievalUserPrompt: string;
    presetText: string;
  };
}): ChatMessage[] {
  const c = params.capsule;
  const system = [
    '你是小说终稿编辑（Final Reviser）。根据简短修订要求完善本章。',
    '保持未涉及内容的事实、叙事视角、剧情方向与文风稳定；不得改变既有剧情方向。',
    '必须自然承接上一章即时状态和本章当前目标，不得把未来大纲内容提前写成已发生事实。',
    'Final Writing Brief 中的“必须修改”“不得提前推进”“结尾状态”是硬性执行边界，优先于 canonical draft；canonical draft 是待修材料，其中若含被禁止的后续剧情，必须删除或后移，不能原样保留。',
    '输出前逐项复核 Brief 的硬性边界；不得只改一个词而保留同一段提前推进的事实或任务。',
    '完整输出修订后的正文，不输出分析、推理、JSON、提示词、修改说明、patch 或 diff。',
  ].join('\n');
  const parts: string[] = [
    '【Final Writing Brief｜只作为写作要求，不要复述】',
    params.writingBrief,
    '【canonical draft｜正文完整注入一次】',
    params.canonicalDraft,
    '【项目完整大纲｜未来计划，不是已发生事实】',
    c.fullOutlineText,
    '【上一章完整正文｜用于即时衔接】',
    clip(c.immediatePreviousChapterText, FINAL_V3_BUDGET.previousChapter),
    '【上一章结尾】',
    c.immediatePreviousEnding,
  ];
  const optional = partition([
    ['【故事状态】', clip(c.storyMemoryText, FINAL_V3_BUDGET.storyMemory)],
    [
      '【相关人物状态】',
      clip(c.relevantCharacterText, FINAL_V3_BUDGET.characters),
    ],
    [
      '【相关世界规则】',
      clip(c.relevantWorldRules, FINAL_V3_BUDGET.worldRules),
    ],
    ['【相关项目笔记】', clip(c.noteText, FINAL_V3_BUDGET.note)],
    [
      '【近期桥接正文】',
      clip(c.recentBridgeText, FINAL_V3_BUDGET.recentBridge),
    ],
    ['【历史事件】', clip(c.episodicMemoryText, FINAL_V3_BUDGET.episodic)],
    [
      '【当前章节目标】',
      clip(c.currentInstructionText, FINAL_V3_BUDGET.instruction),
    ],
    [
      '【用户本轮要求】',
      clip(c.retrievalUserPrompt, FINAL_V3_BUDGET.userPrompt),
    ],
    ['【精简文风】', clip(c.presetText, FINAL_V3_BUDGET.preset)],
  ]);
  if (optional) parts.push('【连续性与写作上下文】', optional);
  parts.push('请直接输出完整终稿正文。');
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.filter(Boolean).join('\n\n') },
  ];
}
