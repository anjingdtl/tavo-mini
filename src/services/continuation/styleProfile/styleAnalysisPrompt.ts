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
import type { StyleMetrics } from './styleStatistics';

/** Analyzer version. Bumped when the prompt or schema materially changes so
 * cached profiles can be invalidated against the new analyzer. */
export const STYLE_ANALYZER_VERSION = 'style-v2-1';

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
  "sceneVariants": [ { "sceneType": "action|dialogue|emotion|description|transition", "instructions": [], "avoid": [], "confidence": 0.0 } ],
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
    '你是严谨的原著写作风格分析器。你的输出将作为续写 Writer / Checker / Repair 的可操作风格契约，'
      + '因此每一条都必须是明确的写作指令，而不是“语言优美”“节奏紧凑”这类空泛结论。',
    '只允许依据下面给出的全书客观统计与有界风格样本来判断风格，禁止利用外部知识或补写原文。',
    '要求：',
    '1. 必须只返回一个完整、可 JSON.parse 的 JSON 对象，不要 Markdown、思考过程、解释或任何前后缀。',
    '2. schemaVersion 必须为 2；所有字段都必须出现，缺失的字符串字段用空字符串、缺失的数组用空数组。',
    '3. 每个字符串字段都要写成“应当如何写”的指令，例如“短句为主，平均 12-18 字，主谓宾结构，少用从句”，'
      + '而不是“句式简洁”。',
    '4. sceneVariants 至少覆盖 action / dialogue / emotion / description / transition 中实际存在的场景，'
      + '每个给出该场景下的写作指令与禁忌。',
    '5. characterVoices 只描述人物的抽象语言习惯（用词偏好、句式、互动方式），'
      + '禁止要求复现或抄写角色的长原句；canonCharacterId 暂时填 null，sourceName 用样本中可识别的称呼。',
    '6. confidence 与各条目的 confidence 必须在 [0, 1] 区间，反映样本对该判断的支持程度。',
    '7. coverage 必须如实填写给出的章节数、抽样章节数与抽样种类。',
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
    '请基于以上材料输出完整的 V2 风格画像 JSON。',
  ].join('\n');
}

/**
 * Repair instruction for the ONE allowed structural-repair retry (Spec §5.6).
 * Carries the validator's aggregated errors so the model can fix the specific
 * fields it got wrong instead of guessing.
 */
export function buildStyleRepairInstruction(errorText: string): string {
  return [
    '上一轮输出无法解析或不符合 V2 schema。请重新生成完整 JSON；不要复用上轮文本，'
      + '也不要输出任何解释、Markdown 或思考过程。',
    '上一轮校验发现的问题如下，请逐条修正：',
    errorText,
    '再次提醒：每个字段必须是可操作的写作指令，confidence 必须在 [0, 1] 区间，schemaVersion 必须为 2。',
    STYLE_PROFILE_JSON_SKELETON,
  ].join('\n');
}
