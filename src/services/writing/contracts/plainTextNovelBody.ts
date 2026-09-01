/**
 * Final plain-text novel body contract.
 *
 * This is deliberately a small, pure, zero-request gate.  Structured model
 * envelopes may be normalized by an explicitly owning adapter before this
 * boundary, but an object/array/protocol wrapper must never be persisted as
 * the user's manuscript body.
 */

export type PlainTextNovelBodyCode =
  | 'ok'
  | 'empty'
  | 'json_wrapper'
  | 'markdown_fence'
  | 'protocol_leak'
  | 'reasoning_leak'
  | 'prompt_leak'
  | 'patch_leak'
  | 'contract_json_leak'
  | 'anchor_marker_leak'
  | 'duplicate_title_wrapper'
  | 'unclosed_protocol';

export interface PlainTextNovelBodyResult {
  valid: boolean;
  code: PlainTextNovelBodyCode;
  details?: string;
}

export interface PlainTextNovelBodyOptions {
  /** Serialized request contract used only to detect direct response echo. */
  contractJson?: string | null;
}

const PROTOCOL_KEYS =
  '(?:schemaVersion|compilerVersion|response_format|responseFormat|patches|operations|ops|finalObligations|appliedObligationIds|appliedRequirementIds|unappliedItems|declaredNewCoreFacts|usedArchitectSceneIds|content|body|report|text|result|output|answer|final|finishReason|requestId|taskId|reasoning|diagnostics|diff|changes|replacement|start|end)';

/** A protocol field may be the first token of a line or the first member of
 * a malformed JSON-like object. Both are wrappers, not manuscript prose. */
const PROTOCOL_KEY_RE = new RegExp(
  `^\\s*["']?${PROTOCOL_KEYS}["']?\\s*:`,
  'im',
);

const MALFORMED_JSON_WRAPPER_RE = new RegExp(
  `^\\s*[\\[{]\\s*["']?${PROTOCOL_KEYS}["']?\\s*:`,
  'i',
);

const PROMPT_PREFIX_RE =
  /^(?:好的[，,。\s]*)?(?:以下(?:是|为)(?:重写后的?)?(?:完整)?(?:本章)?正文|正文(?:如下|如下所示)|下面(?:是|为)(?:重写后的?)?(?:完整)?(?:本章)?正文|(?:重写|修改|修订)(?:后的?)?(?:完整)?(?:正文|章节)(?:如下)?|Here(?: is|'s) the (?:complete |rewritten |revised )?(?:novel )?(?:chapter |text)|(?:rewritten|revised)\s+(?:chapter|text))(?:[ \t]*[:：][ \t]*|[ \t]*\r?\n)/i;

const JSON_WRAPPER_PREFIX_RE =
  /^(?:JSON|JSON\s*Patch|Result|Response|Output|Final(?:\s+Answer)?|Answer|Payload|Data|结果(?:如下)?|返回结果|输出结果|以下(?:是|为)\s*JSON)\s*[:：]?\s*/i;

/**
 * Patch/Diff leakage is only a hard failure in STRUCTURAL shapes: a line that
 * consists of the patch note, or a line-initial "修改说明：" style label, or
 * deterministic diff/patch syntax. The same words inside a natural sentence
 * (e.g. 「他反复交代，其余内容不变，只把最后一句压低。」) are ordinary prose and
 * must not be rejected — this gate blocks protocol pollution, not vocabulary.
 */
const PATCH_MARKER_RE =
  /JSON\s*Patch|diff\s+--git|^@@\s|^[ \t]*(?:[-*•][ \t]*)?(?:【修改说明】|修改说明\s*[：:]|以上为修改[^。！？\r\n]{0,16}[。！？]|仅修改以下\s*[：:]?|以下为修改部分|其余内容(?:不变|保持不变)(?:[。！]|$))/im;

/** Prompt scaffolds are structural protocol, not ordinary novel vocabulary. */
const PROMPT_SCAFFOLD_RE =
  /你是\s*(?:终稿修订员|Continuation\s+V5|TAVO-MINI(?:的)?用户(?:精准|整章)修订执行器)|(?:修订合同\s*[（(]Edit\s*Work\s*Packet|不可违背的项目约束|输出契约)|Edit\s*Work\s*Packet|system\s+prompt|finalObligations|applied(?:Obligation|CanonRequirement|StyleRequirement)Ids|FROZEN_CONTEXT_(?:BEGIN|END)/i;

/** Generated anchors are stripped before persistence; any remaining marker is
 * technical leakage. Natural bracket/quote prose remains valid. */
const ANCHOR_MARKER_RE =
  /\[draft-p-\d{3}(?:-[a-z]\d{3})?\b|⟦ISSUE_\d+_(?:START|END)⟧|<<REPAIR_[A-Z0-9_]+>>|\bANCHOR_[A-Z0-9_]+\b/i;

function isTitleLine(line: string): boolean {
  return /^(?:第\s*[0-9０-９一二三四五六七八九十百千]+\s*章|Chapter\s+\d+|卷\s*[0-9０-９一二三四五六七八九十百千]+)(?:\s|[:：.。\-—]|$)/i.test(
    line,
  );
}

function hasDuplicateTitleWrapper(body: string): boolean {
  const lines = body
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (lines.length < 2 || !isTitleLine(lines[0])) return false;
  const normalized = lines[0].replace(/[：:。.!！？\s]+$/g, '');
  return lines
    .slice(1)
    .some(
      line =>
        isTitleLine(line) &&
        line.replace(/[：:。.!！？\s]+$/g, '') === normalized,
    );
}

function isUnclosedProtocolTail(body: string): boolean {
  return (
    /<\/?(?:think|system|user|assistant)$/i.test(body) ||
    body.endsWith('【') ||
    (/【[^】]*$/.test(body) && !body.endsWith('】'))
  );
}

function isWholeJsonWrapper(body: string): boolean {
  const first = body[0];
  if (first !== '{' && first !== '[' && first !== '"') return false;
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      Array.isArray(parsed) ||
      (parsed !== null && typeof parsed === 'object') ||
      (first === '"' && typeof parsed === 'string')
    );
  } catch {
    // A malformed JSON-looking root is handled by the protocol-key guard
    // below. Ordinary prose containing a brace is not rejected here.
    return false;
  }
}

function isJsonAfterWrapperPrefix(body: string): boolean {
  const prefixed = body.replace(JSON_WRAPPER_PREFIX_RE, '').trim();
  if (prefixed === body) return false;
  return isWholeJsonWrapper(prefixed);
}

/** Reject a short explanatory label followed by a JSON root, e.g.
 * "结果如下：\\n{...}". This does not reject JSON quoted inside prose because
 * the JSON root must begin immediately after the label and parse completely. */
function isJsonAfterGenericLabel(body: string): boolean {
  const match = body.match(/^[^\r\n]{1,48}?[：:]\s*(?=[\[{])/);
  if (!match) return false;
  const remainder = body.slice(match[0].length).trim();
  return remainder !== body && isWholeJsonWrapper(remainder);
}

function isContractJsonEcho(
  body: string,
  contractJson: string | null | undefined,
): boolean {
  const compactContract = String(contractJson || '').replace(/\s+/g, '');
  if (!compactContract) return false;
  const compactBody = body.replace(/\s+/g, '');
  const sample = compactContract.slice(0, 400);
  return (
    sample.length >= 24 &&
    compactBody.includes(sample.slice(0, 80)) &&
    compactBody.length < compactContract.length * 2 + 200
  );
}

/** Validate a candidate body at the final persistence boundary. */
export function validatePlainTextNovelBody(
  value: unknown,
  options?: PlainTextNovelBodyOptions,
): PlainTextNovelBodyResult {
  const body = typeof value === 'string' ? value.trim() : '';
  if (!body) return { valid: false, code: 'empty', details: '正文为空' };

  if (/<think[\s\S]*?<\/think>/i.test(body) || /^<think\b/i.test(body)) {
    return {
      valid: false,
      code: 'reasoning_leak',
      details: '正文含模型推理标签',
    };
  }

  if (/```/.test(body)) {
    return {
      valid: false,
      code: 'markdown_fence',
      details: '正文含 Markdown 代码围栏',
    };
  }

  if (isContractJsonEcho(body, options?.contractJson)) {
    return {
      valid: false,
      code: 'contract_json_leak',
      details: '输出疑似直接回显修订合同 JSON',
    };
  }

  if (isWholeJsonWrapper(body)) {
    return {
      valid: false,
      code: 'json_wrapper',
      details: '正文整体是 JSON 对象、数组或 JSON 字符串包装',
    };
  }

  if (MALFORMED_JSON_WRAPPER_RE.test(body)) {
    return {
      valid: false,
      code: 'protocol_leak',
      details: '正文是非标准 JSON-like 协议对象包装',
    };
  }

  if (isJsonAfterWrapperPrefix(body) || isJsonAfterGenericLabel(body)) {
    return {
      valid: false,
      code: 'json_wrapper',
      details: '正文前含模型说明并跟随 JSON 对象、数组或 JSON 字符串包装',
    };
  }

  if (PROTOCOL_KEY_RE.test(body)) {
    return {
      valid: false,
      code: 'protocol_leak',
      details: '正文含协议字段包装',
    };
  }

  if (PROMPT_PREFIX_RE.test(body)) {
    return {
      valid: false,
      code: 'prompt_leak',
      details: '正文前含模型说明前缀',
    };
  }

  if (PROMPT_SCAFFOLD_RE.test(body)) {
    return {
      valid: false,
      code: 'prompt_leak',
      details: '正文含模型提示词脚手架',
    };
  }

  if (PATCH_MARKER_RE.test(body)) {
    return {
      valid: false,
      code: 'patch_leak',
      details: '正文含 Patch/Diff/修改说明',
    };
  }

  if (ANCHOR_MARKER_RE.test(body)) {
    return {
      valid: false,
      code: 'anchor_marker_leak',
      details: '正文含生成锚点标记',
    };
  }

  if (hasDuplicateTitleWrapper(body)) {
    return {
      valid: false,
      code: 'duplicate_title_wrapper',
      details: '正文开头重复了章节标题包装',
    };
  }

  if (isUnclosedProtocolTail(body)) {
    return {
      valid: false,
      code: 'unclosed_protocol',
      details: '正文尾部停在未闭合的协议标记',
    };
  }

  return { valid: true, code: 'ok' };
}

export function assertPlainTextNovelBody(value: unknown): string {
  const result = validatePlainTextNovelBody(value);
  if (!result.valid) {
    throw Object.assign(new Error(result.details || '最终正文不是纯文本'), {
      code: `FINAL_PLAIN_TEXT_${result.code.toUpperCase()}`,
    });
  }
  return String(value).trim();
}
