import { callLLMResult } from '../llm';

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
    const response = await callLLMResult(
      [{ role: 'user', content: prompt }],
      1024,
      {
        responseFormat: 'json_object',
        temperature: 0.1,
        queueClass: 'normal',
        queuePriority: 'normal',
        scenario: 'continuation_source_ordering',
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

function parseOrderResponse(
  text: string | null,
  expectedCount: number,
): LlmOrderResponse | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 尝试从 markdown fence 或 prose 中剥离
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const order = obj.order;
  const confidence = obj.confidence;
  const reasoning = obj.reasoning;

  if (!Array.isArray(order)) return null;
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) return null;
  if (typeof reasoning !== 'string') return null;

  // 校验索引完整性
  if (order.length !== expectedCount) return null;
  const sorted = [...order].sort((a, b) => a - b);
  for (let i = 0; i < expectedCount; i++) {
    if (sorted[i] !== i) return null;
  }
  // 校验无重复
  const unique = new Set(order);
  if (unique.size !== expectedCount) return null;

  return {
    order: order.map(n => Math.floor(n)),
    confidence,
    reasoning,
  };
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
