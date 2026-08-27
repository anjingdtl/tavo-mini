import {
  callLLMResult,
  resolveLLMRequestConfigById,
} from '../llm';
import { modelJsonCandidates } from './canon/canonJsonValidators';

/**
 * Input file for ordering. `index` is the original selection order (0-based).
 */
export interface OrderingInputFile {
  index: number;
  fileName: string;
  fileSizeBytes: number;
  headSample: string;
  tailSample: string;
}

/**
 * Ordering result. `orderedFileIndexes` are original indexes in the new order.
 */
export interface OrderingResult {
  orderedFileIndexes: number[];
  confidence: number;
  reasoning: string;
  method: 'llm' | 'fallback_filename';
}

interface LlmOrderResponse {
  order: number[];
  confidence: number;
  reasoning: string;
}

/**
 * Order multiple TXT files by analyzing head/tail samples with an LLM.
 * Falls back to filename sort on any LLM failure or invalid response.
 *
 * Use the configuration selected by the caller. This matters while the
 * settings store is refreshing: silently resolving a different active config
 * can make the ordering request fail even though the screen showed one as
 * configured.
 */
export async function orderSourceFiles(
  files: OrderingInputFile[],
  modelConfigId: number,
): Promise<OrderingResult> {
  if (files.length <= 1) {
    return {
      orderedFileIndexes: files.map(f => f.index),
      confidence: 1,
      reasoning: '单个文件无需排序',
      method: 'fallback_filename',
    };
  }

  try {
    const prompt = buildOrderingPrompt(files);
    const requestConfig = await resolveLLMRequestConfigById(modelConfigId);
    const response = await callLLMResult(
      [{ role: 'user', content: prompt }],
      undefined,
      {
        responseFormat: 'json_object',
        temperature: 0.1,
        queueClass: 'normal',
        queuePriority: 'normal',
        scenario: 'continuation_source_ordering',
        requestConfig,
      },
    );

    const parsed = parseOrderResponse(response.text, files.length);
    if (!parsed) {
      return filenameFallback(files, 'LLM 返回结果无法解析');
    }

    return {
      orderedFileIndexes: parsed.order,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      method: 'llm',
    };
  } catch (e: any) {
    return filenameFallback(files, e?.message || 'LLM 调用失败');
  }
}

function buildOrderingPrompt(files: OrderingInputFile[]): string {
  const fileDescriptions = files
    .map(
      f => `【文件索引 ${f.index}】
文件名: ${f.fileName}
文件大小: ${f.fileSizeBytes} 字节
头部采样:
${f.headSample}
---
尾部采样:
${f.tailSample}`,
    )
    .join('\n\n================\n\n');

  return `你是一个小说编辑助手。用户要把多个 TXT 文件按原著阅读顺序拼接成一本完整的小说。请根据以下信息判断正确的阅读顺序。

${fileDescriptions}

排序规则（按优先级）:
1. 如果文件名或内容中存在明确的卷/部标记（如"第一卷""第二部""卷一""卷二"），优先按卷标记排序
2. 关注"承接关系"：文件 N 的尾部与文件 M 的开头是否能拼上（剧情连续性、人物对话中断、场景衔接、时间线推进）
3. 综合文件名和内容采样判断

请输出严格 JSON，格式如下:
{
  "order": [索引数组，按正确阅读顺序排列],
  "confidence": 0到1之间的置信度,
  "reasoning": "简要说明排序理由"
}

注意:
- order 数组必须包含所有 ${files.length} 个文件索引（0到${files.length - 1}），不能遗漏或重复
- 索引值是上面【文件索引 N】中的 N
- 只输出 JSON，不要其他文字`;
}

export function parseOrderResponse(
  text: string | null,
  expectedCount: number,
): LlmOrderResponse | null {
  if (!text) return null;
  // Reuse the Canon parser's production-hardened candidate extraction. A
  // number of OpenAI-compatible gateways add prose / fences or serialize the
  // JSON content as a JSON string a second time. The previous greedy regexp
  // rejected all of those otherwise valid ordering responses.
  for (const candidate of modelJsonCandidates(text)) {
    try {
      let parsed: unknown = JSON.parse(candidate);
      for (let depth = 0; typeof parsed === 'string' && depth < 2; depth += 1) {
        parsed = JSON.parse(parsed.trim());
      }
      const valid = validateOrderResponse(parsed, expectedCount);
      if (valid) return valid;
    } catch {
      // Try the next balanced JSON candidate, if any.
    }
  }
  return null;
}

function validateOrderResponse(
  parsed: unknown,
  expectedCount: number,
): LlmOrderResponse | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  // `orderedFileIndexes` is accepted for models that mirror the TypeScript
  // result name instead of the prompt's shorter `order` field.
  const rawOrder = obj.order ?? obj.orderedFileIndexes;
  if (!Array.isArray(rawOrder) || rawOrder.length !== expectedCount) return null;

  const order = rawOrder.map(value => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
      return Number(value);
    }
    return Number.NaN;
  });
  if (order.some(index => !Number.isInteger(index))) return null;
  const sorted = [...order].sort((a, b) => a - b);
  if (sorted.some((index, expected) => index !== expected)) return null;

  const rawConfidence = obj.confidence;
  const confidence =
    typeof rawConfidence === 'number' &&
    Number.isFinite(rawConfidence) &&
    rawConfidence >= 0 &&
    rawConfidence <= 1
      ? rawConfidence
      : 0.5;
  const reasoning =
    typeof obj.reasoning === 'string' && obj.reasoning.trim()
      ? obj.reasoning.trim()
      : '已根据文件名和原著片段分析排序';

  return { order, confidence, reasoning };
}

function filenameFallback(
  files: OrderingInputFile[],
  reason: string,
): OrderingResult {
  const sorted = [...files].sort((a, b) =>
    a.fileName.localeCompare(b.fileName, 'zh-CN'),
  );
  return {
    orderedFileIndexes: sorted.map(f => f.index),
    confidence: 0,
    reasoning: `LLM 排序失败（${reason}），已按文件名排序`,
    method: 'fallback_filename',
  };
}
