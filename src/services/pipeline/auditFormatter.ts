import type { ChatMessage } from '../llm';

export type AuditFormatterStage = 'review' | 'factCheck';

export interface AuditFormatterInput {
  stage: AuditFormatterStage;
  candidate: string;
  contractVersion?: 31 | 32;
  legalSourceIds?: string[];
  /** Local receipt fields the body-free formatter must preserve. */
  requiredCoverageDimensions?: string[];
  requiredFactRefs?: string[];
}

export interface AuditFormatterPrompt {
  messages: ChatMessage[];
  legalSourceIds: string[];
}

/**
 * Build a one-shot body-free formatter prompt.  V3.2 receives a local source
 * manifest; the legacy V3.1 fallback keeps its historical ID extraction.
 */
export function buildAuditFormatterPrompt(
  input: AuditFormatterInput,
): AuditFormatterPrompt {
  const candidate = String(input.candidate || '').trim().slice(0, 12000);
  const legalSourceIds = input.legalSourceIds?.length
    ? [
        ...new Set(
          input.legalSourceIds.map(id => String(id).trim()).filter(Boolean),
        ),
      ]
    : [
        ...new Set(
          [...candidate.matchAll(/"id"\s*:\s*"([^"\n]{1,120})"/g)].map(
            match => match[1].trim(),
          ),
        ),
      ];
  const v32 = input.contractVersion === 32;
  const requiredCoverageDimensions = [
    ...new Set(
      (input.requiredCoverageDimensions || [])
        .map(value => String(value).trim())
        .filter(Boolean),
    ),
  ];
  const requiredFactRefs = [
    ...new Set(
      (input.requiredFactRefs || [])
        .map(value => String(value).trim())
        .filter(Boolean),
    ),
  ];
  const semanticTemplate =
    input.stage === 'review'
      ? {
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
            checkedDimensions: requiredCoverageDimensions,
          },
        }
      : {
          verdict: requiredCoverageDimensions.length ? 'pass' : 'not_applicable',
          findings: [],
          confirmedFactRefs: requiredFactRefs,
          coverage: {
            checkedDimensions: requiredCoverageDimensions,
            checkedFactRefs: requiredFactRefs,
          },
        };
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        v32
          ? '你是一次性的 V3.2 Audit Formatter，只整理候选中已有的语义判断，不新增审核意见。'
          : '你是一次性的 Audit Formatter，只整理已有判断，不新增审核意见；把候选审核结果整理成 V3.1 合同。',
        '不得重新分析，不得引入初稿、大纲、上下文、人物、世界书或任何长材料；不得创造新的 sourceId。',
        v32
          ? `当前阶段：${input.stage === 'review' ? 'Review' : 'FactCheck'}。只输出当前阶段的单个 JSON 对象，顶层不得出现 review、factCheck、payload、result 或其他包装键；每条保留的 finding 必须带 sourceId，且只能引用候选 manifest 中已有的 ID。Review 必须包含 verdict、findings、outlineAssessment、coverage；FactCheck 必须包含 verdict、findings、confirmedFactRefs、coverage。`
          : '只输出 schemaVersion=3 的 ' +
            input.stage +
            ' JSON；每条 corrections 必须保留候选中已有的 id，不能新造或改写 id；合法 id 列表为：' +
            JSON.stringify(legalSourceIds) +
            '。',
        !v32 && input.stage === 'review'
          ? 'Review 合同必须包含 corrections 数组、outlineExecution 对象和 protectedFacts 数组。'
          : !v32
          ? 'FactCheck 合同必须包含 corrections、protectedFacts、hardConstraints 三个数组；corrections 可为空。'
          : '',
        v32
          ? `coverage.checkedDimensions 必须原样包含这些本地收据：${JSON.stringify(
              requiredCoverageDimensions,
            )}。${
              input.stage === 'factCheck'
                ? `FactCheck 的 coverage.checkedFactRefs 或 confirmedFactRefs 至少原样保留这些 ID：${JSON.stringify(
                    requiredFactRefs,
                  )}。`
                : ''
            }`
          : '',
        v32
          ? '如果候选没有一条完整、可定位、可执行的 finding，只能输出 verdict=pass 与 findings=[]（FactCheck 有本地收据时不得输出 not_applicable）；不要把不完整判断改造成 finding。'
          : '',
        v32 ? `仅允许按照这个顶层模板输出，不得新增包装层：${JSON.stringify(semanticTemplate)}` : '',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '下面是待整理的候选原文。不要复制本段的包装标记，不要输出 candidate、legalSourceIds 或 contractVersion 字段；只输出上面要求的最终合同 JSON。',
        `合法 ID 列表：${JSON.stringify(legalSourceIds)}`,
        '候选原文开始',
        candidate,
        '候选原文结束',
        v32
          ? '再次确认：输出必须是当前阶段的单个顶层 JSON；保留候选中的判断，不能新增判断或 sourceId；缺少完整判断时使用模板中的 pass 空 findings。'
          : '',
      ].join('\n'),
    },
  ];
  return { messages, legalSourceIds };
}
