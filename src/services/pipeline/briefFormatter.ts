import type { ChatMessage } from '../llm';
import type {
  FinalWritingBriefImmutableEnvelopeV31,
  FinalWritingBriefImmutableEnvelopeV32,
  FinalWritingBriefImmutableEnvelopeV33,
} from './briefCompilerTypes';

export interface BriefContractFormatterInput {
  candidate: string;
  envelope:
    | FinalWritingBriefImmutableEnvelopeV31
    | FinalWritingBriefImmutableEnvelopeV32
    | FinalWritingBriefImmutableEnvelopeV33;
  contractVersion?: 31 | 32 | 33;
}

export interface BriefContractFormatterPrompt {
  messages: ChatMessage[];
  legalSourceIds: string[];
}

/**
 * Build a one-shot Brief formatter prompt.  It receives only the failed
 * response, semantic schema, local envelope and source manifest.
 */
export function buildBriefContractFormatterPrompt(
  input: BriefContractFormatterInput,
): BriefContractFormatterPrompt {
  const candidate = String(input.candidate || '').trim().slice(0, 12000);
  const legalSourceIds = [
    ...new Set(
      ('allowedSourceIds' in input.envelope
        ? input.envelope.allowedSourceIds
        : input.envelope.requiredSourceIds)
        .map(id => String(id).trim())
        .filter(Boolean),
    ),
  ];
  const v33 = input.contractVersion === 33;
  const v32 = input.contractVersion === 32;
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        v33
          ? '你是一次性的当前协议 Brief Formatter，只整理候选中已有的 Brief 语义。'
          : v32
          ? '你是一次性的 ShineWriter V3.2 Brief Formatter，只整理候选中已有的 Brief 语义。'
          : '你是一次性的 ShineWriter V3.1 Contract Formatter，只整理已有 Brief 判断。',
        '不得重新审阅 Draft，不得读取或假设大纲、人物、世界书、上下文、记忆或任何长材料，不得新增剧情和事实。',
        '只把候选响应中已经出现的语义整理成可验证 JSON；没有依据的字段必须保持空数组或空字符串。',
        '不可变信封由本地覆盖，是最终权威；不要改写其中的 sourceHash、requiredSourceIds、protectedFacts、hardConstraints、mustNotAdvance、outlineObligations、endingBoundary。',
        '必须输出 message.content，禁止只输出 reasoning_content、Markdown 或解释。',
        v33
          ? '当前协议只输出 strategy、actions、preserve、ending；actions 使用 covers 短 ID 和 instruction，不要输出 schema、hash、sourceId 白名单或本地信封。'
          : v32
          ? '输出 verdict、instructions、openingContinuity、styleAdvisories；instruction.sourceIds 只能从合法清单选择。'
          : '输出 schemaVersion=2，并包含 coveredRequiredIds、openingContinuity、mustFix、mustPreserve、endingState、styleAdvisories。',
        '合法 sourceId：' + JSON.stringify(legalSourceIds),
        v33
          ? '每个 required/hard 短 ID 必须被 action.covers 覆盖；不得创造短 ID 或新的修复语义。'
          : v32
          ? '每个 hard/required 合法 sourceId 最多出现在一条逻辑 instruction 中；同一 sourceId 的重复语义只能合并，不能保留相互矛盾的两条 hard/required 指令。不得创造 sourceId 或新的修复语义。'
          : '每个合法 sourceId 最多出现在一条 mustFix 中；同一 sourceId 的重复语义只能合并，不能保留相互矛盾的两条必改指令。',
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
