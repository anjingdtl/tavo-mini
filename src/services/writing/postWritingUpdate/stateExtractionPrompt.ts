/**
 * State-extraction prompt compiler for the post-writing update worker
 * (Writing Kernel unification step).
 *
 * Verbatim copy of the legacy `compileStateExtractionMessages` so the
 * production outbox worker no longer depends on the legacy continuation
 * prompt-compiler module. The legacy module keeps its original for
 * historical scope.
 */
import type { ChatMessage } from '../../llm/types';

export function compileStateExtractionMessages(
  finalizedText: string,
  entityIndex: string,
): ChatMessage[] {
  const utf16Length = finalizedText.length;
  return [
    {
      role: 'system',
      content: [
        '你从已定稿续写正文提取状态 proposal。只输出 JSON：{ proposals: [...] }。',
        '每项：proposalType, subjectRefType?, subjectRefId?, payload, evidenceStart, evidenceEnd, risk(normal|major)。',
        'proposalType ∈ character_state|relationship_change|plot_advance|character_experience|knowledge_change|new_world_fact|new_character|new_location|new_organization|foreshadowing|other。',
        `本次正文的 UTF-16 长度为 ${utf16Length}。evidenceStart/evidenceEnd 必须是正文的 0-based UTF-16 半开区间，且满足 0 <= evidenceStart < evidenceEnd <= ${utf16Length}；换行也计入长度。`,
        'evidence 区间必须能在本次正文中定位到对应事实。如果无法定位可验证区间，跳过该 proposal，不要猜测或填写越界坐标；可以返回 {"proposals":[]}。不得编造原著未来情节。',
        '格式示例（仅示范字段，不代表正文事实）：{"proposals":[{"proposalType":"plot_advance","payload":{"summary":"可验证的剧情变化"},"evidenceStart":0,"evidenceEnd":1,"risk":"normal"}]}。',
        `【实体索引】\n${entityIndex}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: `定稿正文：\n---\n${finalizedText}\n---`,
    },
  ];
}
