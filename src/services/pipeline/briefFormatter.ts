import type { ChatMessage } from '../llm';
import type { FinalWritingBriefImmutableEnvelopeV31 } from './briefCompilerTypes';

export interface BriefContractFormatterInput {
  candidate: string;
  envelope: FinalWritingBriefImmutableEnvelopeV31;
}

export interface BriefContractFormatterPrompt {
  messages: ChatMessage[];
  legalSourceIds: string[];
}

/**
 * Build the one-shot Brief contract formatter prompt.
 *
 * It receives only the failed Brief response, the semantic payload schema,
 * the legal source-id manifest, and the locally authoritative immutable
 * envelope. It never receives Draft, outline text, retrieval context, or
 * project materials, so it cannot silently become a second Brief compiler.
 */
export function buildBriefContractFormatterPrompt(
  input: BriefContractFormatterInput,
): BriefContractFormatterPrompt {
  const candidate = String(input.candidate || '').trim().slice(0, 12000);
  const legalSourceIds = [...new Set(input.envelope.requiredSourceIds.map(id => String(id).trim()).filter(Boolean))];
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        '你是一次性的 ShineWriter V3.1 Contract Formatter，只整理已有 Brief 判断。',
        '不得重新审阅 Draft，不得读取或假设大纲、人物、世界书、上下文、记忆或任何长材料，不得新增剧情和事实。',
        '只把候选响应中已经出现的语义整理成可验证 JSON；没有依据的字段必须保持空数组或空字符串。',
        '不可变信封由本地覆盖，是最终权威；不要改写其中的 sourceHash、requiredSourceIds、protectedFacts、hardConstraints、mustNotAdvance、outlineObligations、endingBoundary。',
        '必须输出 message.content，禁止只输出 reasoning_content、Markdown 或解释。',
        '输出 schemaVersion=2，并包含 coveredRequiredIds、openingContinuity、mustFix、mustPreserve、endingState、styleAdvisories。',
        `mustFix.sourceIds 只能从合法清单选择：${JSON.stringify(legalSourceIds)}。每项必须包含非空 instruction、target.kind（opening/scene/middle/ending/global）和 preserve 数组。`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        legalSourceIds,
        immutableEnvelope: input.envelope,
        candidate,
      }),
    },
  ];
  return { messages, legalSourceIds };
}
