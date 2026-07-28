/**
 * Shared prompt building blocks for Canon extraction (Spec §3, change 1).
 *
 * Both the grouped request path (`extractMaterialWithLlm`) and the legacy
 * single-request path (`extractWithLlm`) must teach the model the exact
 * element-level field names. Centralising the spec here prevents the two
 * paths from drifting apart again — which was the S3 root cause: the grouped
 * prompt only listed array names, so the model guessed field names and the
 * validator silently dropped everything except `plotThreads`.
 */

/**
 * Element-level field specification, one line per array. The field names MUST
 * stay in sync with `canonJsonValidators.ts` (canonical column names) and with
 * `materializeBatchResult` column mappings.
 */
export const EXTRACTION_FIELD_SPEC =
  '数组元素字段必须严格使用对应名称：' +
  'worldRules(category,title,description,constraintLevel,confidence,evidence)；' +
  'characters(canonicalName,aliases,description,importance,confidence,evidence)；' +
  'relationships(sourceName,targetName,relationType,attitude,publicStatus,description,confidence,evidence)；' +
  'plotThreads(title,description,level,status,characterNames,confidence,evidence)；' +
  'experiences(characterName,eventType,title,description,importance,confidence,evidence)；' +
  'knowledge(characterName,factKey,factSummary,knowledgeState,confidence,evidence)；' +
  'states(characterName,location,physicalState,emotionalState,aliveState,summary,confidence,evidence)；' +
  'timelineEvents(eventKey,title,summary,eventType,characterNames,importance,confidence,evidence)。';

/**
 * Evidence element field spec. `charStart`/`charEnd` are whole-book UTF-16
 * absolute offsets derived from the per-chapter `bodyStart`/`bodyEnd` metadata.
 */
export const EVIDENCE_FIELD_SPEC =
  'evidence 元素字段：chapterId、chapterPosition、charStart、charEnd、quotePreview。' +
  '不确定的偏移量请根据该章正文给出可定位的相对估计值，不要省略 evidence。';

/**
 * The JSON skeleton every extraction request must conform to.
 */
export const EXTRACTION_JSON_SKELETON =
  'JSON 结构：{"schemaVersion":1,"worldRules":[],"characters":[],"relationships":[],"plotThreads":[],"experiences":[],"knowledge":[],"states":[],"timelineEvents":[]}。';

/**
 * Builds the retry instruction suffix for the Nth attempt.
 *
 * When `droppedStats` is provided (from `validateExtractionResultWithStats`),
 * the instruction carries the per-category received/accepted/dropped counts so
 * the model can correct the specific field name it got wrong — far more
 * effective than the generic "regenerate" instruction.
 */
export function buildExtractionRetryInstruction(
  droppedStats?: Record<
    string,
    { received: number; accepted: number; dropped: number; firstDropReason?: string }
  >,
): string {
  const base =
    '上一轮输出无法解析或不符合 schema。请重新生成完整 JSON；不要复用上轮文本，也不要输出任何解释、Markdown 或思考过程。';
  if (!droppedStats) return `\n${base}`;
  const meaningful = Object.entries(droppedStats).filter(
    ([, s]) => s.dropped > 0,
  );
  if (meaningful.length === 0) return `\n${base}`;
  const lines = meaningful.map(
    ([category, s]) =>
      `${category}: received=${s.received}, accepted=${s.accepted}, dropped=${s.dropped}${
        s.firstDropReason ? `（首个丢弃原因：${s.firstDropReason}）` : ''
      }`,
  );
  return (
    `\n${base}\n` +
    '上一轮各分类的接受/丢弃统计如下，请据此修正字段名（字段必须使用规范名称，详见下方规范），不要再次返回被丢弃的格式：\n' +
    lines.join('\n')
  );
}
