import type { ChatMessage } from './llm';

export function buildDraftMessages(
  baseMessages: ChatMessage[],
  chapterTitle: string,
  existingContent: string,
  userPrompt: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [...baseMessages];
  const roleInstruction = [
    `【任务】你是初稿作者。请为小说章节「${chapterTitle}」快速创作内容。`,
    '专注于创造力和流畅性，释放想象力，避免陷入空白页焦虑。',
    '不要担心细节问题，后续会有专门的编辑处理。',
  ].join('\n');

  let content = roleInstruction;
  if (existingContent.trim()) {
    const tail = existingContent.slice(-1500);
    content += `\n\n当前已有正文末尾：\n${tail}\n\n请自然续写，不要重复前文内容。`;
  }
  content += `\n\n${userPrompt}`;

  messages.push({ role: 'user', content });
  return messages;
}

export function buildReviewMessages(draftText: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是一位资深小说审阅编辑。你的职责是从宏观视角审阅文本，关注：',
        '1. 逻辑一致性——情节发展是否合理，有无矛盾',
        '2. 结构完整性——叙事节奏是否得当，场景转换是否自然',
        '3. 基调统一性——文风和情感基调是否前后一致',
        '4. 人物表现——角色言行是否符合其设定和性格',
        '5. 叙事技巧——是否有效运用了展示而非讲述(show not tell)',
        '',
        '请按以下 JSON 格式输出审阅意见，不要输出其他内容：',
        '{"strengths": [...], "issues": [...], "suggestions": [...]}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `请审阅以下小说初稿：\n\n${draftText}`,
    },
  ];
}

export function buildFactCheckMessages(draftText: string, contextText: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是小说事实核查员。你的职责是验证文本中的事实性内容：',
        '1. 世界观一致性——是否违反已建立的世界规则',
        '2. 角色设定匹配——角色能力、性格、外貌是否与设定一致',
        '3. 时间线逻辑——事件顺序和时间跨度是否合理',
        '4. 前文衔接——是否与前文内容存在矛盾',
        '5. 地理/空间逻辑——场景描述和位置关系是否合理',
        '',
        '请按以下 JSON 格式输出核查结果：',
        '{"errors": [...], "warnings": [...], "confirmed": [...]}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '以下是小说的上下文设定（供参考）：',
        contextText.slice(0, 3000),
        '',
        '请核查以下小说初稿：',
        draftText,
      ].join('\n\n'),
    },
  ];
}

export function buildAssessmentMessages(draftText: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是小说流水线的快速质检编辑。请先给出可展示给作者的短评，再判断这份草稿是否必须进入终审润色。',
        '只检查会明显影响读者体验的问题：严重逻辑矛盾、角色行为明显不一致、前后衔接断裂、语言可读性很差。',
        '如果只是轻微措辞或标点问题，needsProof 应为 false，但仍要给出简短评价。',
        '必须输出严格 JSON，不要使用 Markdown，不要输出解释。',
        '格式固定为：{"needsProof": boolean, "shortReview": "一句话短评", "issues": string[], "suggestions": string[], "reasons": string[]}',
        'issues 写主要问题，没有问题则为空数组；suggestions 写可执行修改意见，没有必要修改则为空数组；reasons 写 needsProof 判断依据。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `请快速评估以下小说草稿，并输出短评与修改意见：\n\n${draftText}`,
    },
  ];
}

export function buildLightProofMessages(draftText: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是小说流水线的轻量终审校对员。',
        '请只做必要润色：修正明显错别字、病句、衔接断裂、重复表达和轻微一致性问题。',
        '不要重写剧情，不要增加分析，不要输出标题或修改说明。',
        '如果原稿已经通顺，也必须输出完整正文，而不是说明无需修改。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `请对以下小说草稿进行轻量终审，并直接输出完整正文：\n\n${draftText}`,
    },
  ];
}

export function buildProofMessages(
  draftText: string,
  reviewText: string,
  factCheckText: string,
): ChatMessage[] {
  const reviewAvailable = reviewText && !reviewText.includes('未能完成');
  const factAvailable = factCheckText && !factCheckText.includes('未能完成');

  return [
    {
      role: 'system',
      content: [
        '你是终审校对员。你将收到一份初稿、审阅编辑的意见和事实核查的结果。',
        '请完成以下工作：',
        '1. 根据审阅编辑的建议修改结构性问题',
        '2. 修正事实核查中发现的所有错误',
        '3. 校对字词、标点、格式等微观层面的问题',
        '4. 保持原文的创意优点和叙事风格',
        '5. 确保修改后的文本整体流畅、连贯',
        '',
        '请直接输出修改后的完整文本，不要输出解释说明。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '【初稿】',
        draftText,
        '',
        '【审阅意见】',
        reviewAvailable ? reviewText : '审阅编辑未能完成审阅，请自行判断结构性问题。',
        '',
        '【事实核查结果】',
        factAvailable ? factCheckText : '事实核查员未能完成核查，请自行检查事实一致性。',
      ].join('\n\n'),
    },
  ];
}
