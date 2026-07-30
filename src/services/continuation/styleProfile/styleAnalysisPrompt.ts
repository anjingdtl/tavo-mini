/**
 * V2 style-analysis prompt spec (Spec §5.5, §5.6).
 *
 * Builds the system prompt that instructs the analyzer LLM to extract an
 * operational, structured {@link OriginalStyleProfileV2} from the supplied
 * whole-book statistics + stratified samples. The skeleton matches the V2
 * schema exactly so the model's JSON output can be validated by
 * `validateStyleProfileV2`.
 *
 * Invariants encoded in the prompt (Spec §5.5):
 *  - Every field must be an actionable writing instruction, not a vague
 *    critique like "语言优美".
 *  - Character voices describe abstract habits only; the model must never be
 *    asked to reproduce long original character sentences.
 *  - No long original passages are stored; samples are passed in only as
 *    short, bounded reference spans.
 */
/** Analyzer version. Bumped when the prompt or schema materially changes so
 * cached profiles can be invalidated against the new analyzer. */
export const STYLE_ANALYZER_VERSION = 'style-v2-2';

/**
 * The JSON skeleton the model must fill. Field names MUST stay in lockstep
 * with {@link OriginalStyleProfileV2} and `validateStyleProfileV2`.
 */
export const STYLE_PROFILE_JSON_SKELETON = `JSON 结构（schemaVersion 必须为 2，所有字段都必须出现，缺失字段用空字符串或空数组填充）：
{
  "schemaVersion": 2,
  "summary": "一句话全书风格概要，必须可操作",
  "global": {
    "narrative": { "person": "", "focalization": "", "narrativeDistance": "", "tenseAndTimeHandling": "", "perspectiveSwitchRules": [] },
    "syntax": { "sentenceLengthPattern": "", "sentenceStructures": [], "punctuationHabits": [], "paragraphPattern": "" },
    "diction": { "register": "", "concreteness": "", "lexicalPreferences": [], "expressionsToAvoid": [] },
    "tone": { "baseline": "", "emotionalAmplitude": "", "humorAndRestraint": "" },
    "rhythm": { "scenePacing": "", "expositionDensity": "", "transitionMethods": [], "chapterEndingPatterns": [] },
    "description": { "sensoryPriorities": [], "environmentUsage": "", "actionVsInteriorBalance": "", "imageryHabits": [] },
    "dialogue": { "dialogueDensity": "", "turnLength": "", "attributionStyle": "", "subtextStyle": "", "expositionAvoidance": [] },
    "informationReveal": { "setupMethod": "", "foreshadowingMethod": "", "suspenseMethod": "" }
  },
  "boundaryLocalDelta": { "tone": "", "pacing": "", "sentenceAndParagraphShift": "", "activeNarrativePatterns": [] },
  "sceneVariants": [ { "sceneType": "action", "instructions": ["以短促动词链推进，少用长篇静态描写"], "avoid": ["感叹句堆叠"], "confidence": 0.0 } ],
  "characterVoices": [ { "canonCharacterId": null, "sourceName": "", "speechRegister": "", "sentenceHabits": [], "interactionHabits": [], "avoid": [], "confidence": 0.0 } ],
  "globalAvoid": [],
  "confidence": 0.0,
  "coverage": { "sourceChapterCount": 0, "sampledChapterCount": 0, "sampledKinds": [] }
}`;

/**
 * System prompt for the structured style-extraction call (Spec §5.5).
 * Tells the model to produce operational instructions and reject vague phrasing.
 */
export function buildStyleAnalysisSystemPrompt(): string {
  return [
    '你是严谨的原著写作风格分析器。你的输出将作为续写 Writer / Checker / Repair 的可操作风格契约，' +
      '因此每一条都必须是明确的写作指令，而不是“语言优美”“节奏紧凑”这类空泛结论。',
    '只允许依据下面给出的全书客观统计与有界风格样本来判断风格，禁止利用外部知识或补写原文。',
    '要求：',
    '1. 必须只返回一个完整、可 JSON.parse 的 JSON 对象，不要 Markdown、思考过程、解释或任何前后缀。',
    '2. schemaVersion 必须为 2；所有字段都必须出现，缺失的字符串字段用空字符串、缺失的数组用空数组。',
    '3. 这是“最高强度仿写”画像：每个字符串字段都要写成可执行的“如何写 + 频率/范围 + 触发场景 + 禁忌”指令。' +
      '尽量使用统计中可支持的范围（如句长、段长、对话密度），例如“常态 12-18 字短句；紧张时连续 2-4 个短句；少用超过两层的从句”，而不是“句式简洁”。',
    '4. 必须把五项高强度仿写维度写具体：' +
      '①句式结构（句长/段长/标点/句式组合）；②语气与情感（基调、情绪递进、克制方式）；' +
      '③用词与搭配（语域、具象名词/动词偏好、应避开的 AI 套话）；' +
      '④叙述视角与人物口吻（聚焦、叙事距离、对白句式/互动习惯）；' +
      '⑤叙事节奏（场景推进、信息揭示、转场、章末悬念）。每项至少给出 2 条相互独立的可执行约束。',
    '5. 不得输出“维持原样”“无变化”“视情况”“风格自然”“语言优美”等没有执行信息的表述；' +
      '样本不足时写明保守但可操作的默认约束，并降低 confidence，禁止编造原著事实或示例原句。',
    '6. sceneVariants 至少覆盖 action / dialogue / emotion / description / transition 中实际存在的场景，' +
      '每个给出至少 2 条写作指令与 1 条禁忌；优先写明动作、对话、描写如何切换句段和信息量。',
    '7. characterVoices 只描述人物的抽象语言习惯（用词偏好、句式、互动方式），' +
      '禁止要求复现或抄写角色的长原句；canonCharacterId 暂时填 null，sourceName 用样本中可识别的称呼。',
    '8. confidence 与各条目的 confidence 必须在 [0, 1] 区间，反映样本对该判断的支持程度。',
    '9. coverage 必须如实填写给出的章节数、抽样章节数与抽样种类。',
    STYLE_PROFILE_JSON_SKELETON,
  ].join('\n');
}

/**
 * User-message body: embeds the whole-book metrics (objective overview) and the
 * bounded sample spans. Samples are kept short (refs were pre-clipped by the
 * sampler); we never send long passages for copy.
 *
 * @param metricsJson serialized {@link StyleMetrics} (the objective overview).
 * @param sampleBlocks human-readable, bounded sample spans keyed by kind.
 * @param coverageHint sourceChapterCount / sampledChapterCount for the model.
 */
export function buildStyleAnalysisUserPrompt(input: {
  metricsJson: string;
  sampleBlocks: string;
  coverage: { sourceChapterCount: number; sampledChapterCount: number };
}): string {
  return [
    '全书客观风格统计（JSON，仅供你参考全局分布，不要原样复述）：',
    input.metricsJson,
    '',
    '有界风格样本（按场景种类分层，已裁剪到续写边界内，禁止越界引用）：',
    input.sampleBlocks,
    '',
    `覆盖范围：原著共 ${input.coverage.sourceChapterCount} 章，本次抽样覆盖 ${input.coverage.sampledChapterCount} 章。`,
    '请以“最高强度仿写”标准输出完整的 V2 风格画像 JSON：让另一位作者无需看到原文，也能按字段稳定复现句段、语气、词汇、人物对白与章节节奏；只模仿抽象特征，禁止复制原句。',
  ].join('\n');
}

/**
 * Repair instruction for the ONE allowed structural-repair retry (Spec §5.6).
 * Carries the validator's aggregated errors so the model can fix the specific
 * fields it got wrong instead of guessing.
 */
export function buildStyleRepairInstruction(errorText: string): string {
  return [
    '上一轮输出无法解析或不符合 V2 schema。请重新生成完整 JSON；不要复用上轮文本，' +
      '也不要输出任何解释、Markdown 或思考过程。',
    '上一轮校验发现的问题如下，请逐条修正：',
    errorText,
    '再次提醒：每个字段必须是最高强度、可操作的写作指令（包含如何写、范围/频率、触发场景与禁忌），不得使用“维持原样”等空泛表述；confidence 必须在 [0, 1] 区间，schemaVersion 必须为 2。',
    STYLE_PROFILE_JSON_SKELETON,
  ].join('\n');
}
