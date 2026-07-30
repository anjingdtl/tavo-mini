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
export const STYLE_ANALYZER_VERSION = 'style-v2-3';

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
    '你是原著写作风格分析器。输出作为续写 Writer/Checker/Repair 的可操作风格契约。只依据下方统计与样本判断，禁止外部知识或补写。',
    '必须只返回完整 JSON，不要 Markdown/解释。schemaVersion=2，所有字段必须出现，缺失的用空字符串或空数组。',
    '每个字段写成"如何写+频率/范围+触发场景+禁忌"的可执行指令（如"常态12-18字短句；紧张时连续2-4短句"），禁止"语言优美""节奏紧凑"等空泛结论。',
    '五项核心维度各≥2条独立约束：①句式（句长/段长/标点组合）；②语气（基调/情绪递进/克制方式）；③用词（语域/偏好/禁忌词）；④视角（叙事距离/对白句式/互动习惯）；⑤节奏（场景推进/信息揭示/转场/章末）。',
    '禁止"维持原样""无变化""视情况""风格自然"等无执行信息的表述。样本不足时写明保守可操作默认约束并降低 confidence。',
    'sceneVariants 覆盖 action/dialogue/emotion/description/transition 中实际存在的类型，各≥2条指令+1条禁忌。',
    'characterVoices 只描述抽象语言习惯（用词偏好/句式/互动方式），禁止复现或抄写角色原句；canonCharacterId 填 null。',
    'confidence∈[0,1]；coverage 如实填写给出的章节数与抽样数。',
    STYLE_PROFILE_JSON_SKELETON,
  ].join('\n');
}

/**
 * User-message body: embeds the compact style-metrics summary and the bounded
 * sample spans. The summary replaces the former full JSON metrics (~tens of KB)
 * with key statistical anchors (~1 KB) to cut prompt tokens.
 *
 * @param metricsSummary compact textual summary from {@link summarizeStyleMetrics}.
 * @param sampleBlocks human-readable, bounded sample spans keyed by kind.
 * @param coverage sourceChapterCount / sampledChapterCount for the model.
 */
export function buildStyleAnalysisUserPrompt(input: {
  metricsSummary: string;
  sampleBlocks: string;
  coverage: { sourceChapterCount: number; sampledChapterCount: number };
}): string {
  return [
    '全书客观风格统计（已摘要为关键锚点，不要复述）：',
    input.metricsSummary,
    '',
    '有界风格样本（按场景种类分层，已裁剪到续写边界内，禁止越界引用）：',
    input.sampleBlocks,
    '',
    `覆盖范围：原著共 ${input.coverage.sourceChapterCount} 章，本次抽样覆盖 ${input.coverage.sampledChapterCount} 章。`,
    '请以"最高强度仿写"标准输出完整的 V2 风格画像 JSON：让另一位作者无需看到原文，也能按字段稳定复现句段、语气、词汇、人物对白与章节节奏；只模仿抽象特征，禁止复制原句。',
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
