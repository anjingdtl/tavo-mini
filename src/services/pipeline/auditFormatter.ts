import type { ChatMessage } from '../llm';

export type AuditFormatterStage = 'review' | 'factCheck';

export interface AuditFormatterInput {
  stage: AuditFormatterStage;
  candidate: string;
}

export interface AuditFormatterPrompt {
  messages: ChatMessage[];
  legalSourceIds: string[];
}

/**
 * Build the one-shot, body-free formatter prompt required by V3.1.
 * Only the candidate reasoning/text, the contract schema, and source ids
 * extracted from that candidate are allowed into this request.
 */
export function buildAuditFormatterPrompt(
  input: AuditFormatterInput,
): AuditFormatterPrompt {
  const candidate = String(input.candidate || '').trim().slice(0, 12000);
  const legalSourceIds = [
    ...new Set(
      [...candidate.matchAll(/"id"\s*:\s*"([^"\n]{1,120})"/g)].map(
        match => match[1].trim(),
      ),
    ),
  ];
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        '你是一次性的 Audit Formatter，只整理已有判断，不新增审核意见；把候选审核结果整理成 V3.1 合同。',
        '不得重新分析，不得引入初稿、大纲、上下文、人物、世界书或任何长材料；不得创造新的 sourceId。',
        `只输出 schemaVersion=3 的 ${input.stage} JSON；sourceId 只能使用以下合法列表：${JSON.stringify(legalSourceIds)}。`,
        input.stage === 'review'
          ? 'Review 合同必须包含 corrections 数组、outlineExecution 对象和 protectedFacts 数组。'
          : 'FactCheck 合同必须包含 corrections、protectedFacts、hardConstraints 三个数组；corrections 可为空。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        schemaVersion: 3,
        legalSourceIds,
        candidate,
      }),
    },
  ];
  return { messages, legalSourceIds };
}
