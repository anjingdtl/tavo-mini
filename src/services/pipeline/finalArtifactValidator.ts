/**
 * Outline pipeline V5-Lite — Local Final Artifact Validator (§12).
 *
 * Runs AFTER the Final Reviser (proof) LLM returns and BEFORE the proof
 * checkpoint is persisted as success. 0 LLM, creates NO attempt.
 *
 * Hard-fails ONLY deterministic technical delivery errors (§12.2):
 *   - empty body;
 *   - finishReason === 'length' with clearly incomplete output;
 *   - reasoning only, no body;
 *   - `<think>` / system prompt / contract / anchor-marker leaks;
 *   - output is a JSON audit contract / patch / change notes;
 *   - whole text is repeated paragraphs;
 *   - catastrophic length collapse relative to the draft, combined with
 *     summary/truncation signals;
 *   - tail stops at an unclosed technical separator / protocol block.
 *
 * Single soft heuristics (short text, normal novel words like 总结/最终,
 * subjective quality, plain length ratio) NEVER block delivery (§12.3).
 */

export type FinalValidatorCode =
  | 'ok'
  | 'empty'
  | 'finish_length_incomplete'
  | 'reasoning_only'
  | 'think_leak'
  | 'prompt_leak'
  | 'contract_json_leak'
  | 'patch_leak'
  | 'anchor_marker_leak'
  | 'whole_paragraph_duplicate'
  | 'catastrophic_collapse';

export interface FinalValidatorResult {
  valid: boolean;
  code: FinalValidatorCode;
  details?: string;
}

const ANCHOR_MARKER_RE = /\[draft-p-\d{3}/;

const PROMPT_LEAK_FINGERPRINTS = [
  '你是终稿修订员',
  '【修订合同（Edit Work Packet）',
  '【不可违背的项目约束】',
  '修订合同中的',
];

/** Whole-text duplicate paragraph detection (≥3 repeats of a large chunk). */
function detectWholeParagraphDuplicate(body: string): boolean {
  const paragraphs = body
    .split('\n')
    .map(p => p.trim())
    .filter(p => p.length >= 40);
  if (paragraphs.length < 3) return false;
  const counts = new Map<string, number>();
  for (const p of paragraphs) {
    counts.set(p, (counts.get(p) || 0) + 1);
  }
  for (const [p, count] of counts) {
    if (count >= 3 && p.length >= 100) return true;
  }
  return false;
}

/**
 * Validate the final artifact. Pure; may be tested directly.
 */
export function validateFinalArtifact(params: {
  /** Final Reviser output text (may be empty). */
  text?: string | null;
  reasoningText?: string | null;
  finishReason?: string | null;
  /** Canonical draft used by the pipeline (collapse heuristic baseline). */
  canonicalDraft?: string;
  /** Serialized revision contract JSON, if any (leak detection). */
  contractJson?: string;
}): FinalValidatorResult {
  const text = typeof params.text === 'string' ? params.text : '';
  const reasoning =
    typeof params.reasoningText === 'string' && params.reasoningText.trim().length > 0
      ? params.reasoningText
      : null;
  const body = text.trim();

  if (!body && reasoning) {
    return { valid: false, code: 'reasoning_only', details: '仅返回推理，无正文' };
  }
  if (!body) {
    return { valid: false, code: 'empty', details: '终稿为空' };
  }

  // Technical leakage checks.
  if (/<think[\s\S]*?<\/think>/i.test(body) || /^<think\b/i.test(body)) {
    return { valid: false, code: 'think_leak', details: '正文含 <think> 推理泄漏' };
  }
  for (const fp of PROMPT_LEAK_FINGERPRINTS) {
    if (body.includes(fp)) {
      return { valid: false, code: 'prompt_leak', details: `泄漏提示词片段: ${fp}` };
    }
  }
  if (ANCHOR_MARKER_RE.test(body)) {
    return { valid: false, code: 'anchor_marker_leak', details: '正文含锚点标记' };
  }
  if (params.contractJson && params.contractJson.trim().length > 0) {
    const contractSample = params.contractJson
      .slice(0, Math.min(params.contractJson.length, 400))
      .replace(/\s+/g, '');
    const bodyCompact = body.replace(/\s+/g, '');
    if (bodyCompact.includes(contractSample.slice(0, 80)) && bodyCompact.length < contractSample.length * 2 + 200) {
      return {
        valid: false,
        code: 'contract_json_leak',
        details: '输出疑似直接回显修订合同 JSON',
      };
    }
  }
  // Patch / change-note fingerprints.
  if (
    body.includes('其余内容不变') ||
    body.includes('修改说明') ||
    body.includes('以上为修改') ||
    /^[-+]{3}\s/m.test(body) ||
    body.startsWith('diff') ||
    body.startsWith('```diff')
  ) {
    return { valid: false, code: 'patch_leak', details: '输出疑似 patch/diff/修改说明' };
  }

  // Whole-paragraph duplicate.
  if (detectWholeParagraphDuplicate(body)) {
    return {
      valid: false,
      code: 'whole_paragraph_duplicate',
      details: '全文由重复段落构成',
    };
  }

  // finishReason === 'length' → likely truncation (technical, hard fail).
  if (params.finishReason === 'length') {
    return {
      valid: false,
      code: 'finish_length_incomplete',
      details: 'finishReason=length，输出可能被截断',
    };
  }

  // Catastrophic collapse vs draft + truncation signals (§12.2).
  // Conservative: ratio must be extreme AND the text must be dominated by
  // explicit summary/omission/continuation markers. Plain novel words like
  // 总结 / 最终 / 摘要 in a normal sentence never block (§12.3).
  const draft = typeof params.canonicalDraft === 'string' ? params.canonicalDraft.trim() : '';
  if (draft.length > 300) {
    const ratio = body.length / draft.length;
    const summaryDominated =
      /^(本章)?(内容)?(以下|以上)?(为)?(摘要|总结|概述)[：:，,.]/.test(body) ||
      /(余略|内容省略|以下省略|未完待续|其余省略|以此类推|后略)/.test(body) ||
      /^省略[。.]/.test(body);
    if (ratio < 0.2 && summaryDominated) {
      return {
        valid: false,
        code: 'catastrophic_collapse',
        details: `相对初稿灾难性坍缩 (ratio=${ratio.toFixed(2)}) 且命中摘要/截断信号`,
      };
    }
  }

  // Unclosed technical separator at tail.
  if (
    /```$/.test(body) ||
    /<\/?(think|system|user|assistant)$/.test(body) ||
    body.endsWith('【') ||
    body.endsWith('】') === false && /【[^】]*$/.test(body)
  ) {
    return {
      valid: false,
      code: 'finish_length_incomplete',
      details: '尾部停在未闭合的技术性分隔符',
    };
  }

  return { valid: true, code: 'ok' };
}
