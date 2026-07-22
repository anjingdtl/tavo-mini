/**
 * Live DeepSeek verification for pipeline audit validity fix.
 * Uses env DEEPSEEK_API_KEY (do not commit keys).
 *
 * Covers:
 * - content / reasoning_content separation (same rules as Provider)
 * - real review / factCheck calls with JSON mode
 * - classification: reasoning_only, valid JSON, prose, etc.
 *
 * Writes: test-logs/deepseek-live-probe.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Load validator via babel-jest path is hard; mirror separation + light structure checks,
// and optionally require compiled JS if present. Prefer dynamic import of TS via jiti if available.
let validateReviewResult;
let validateFactCheckResult;
try {
  // Prefer project's jest/babel transform is not available here.
  // Use a minimal inline re-export by spawning is overkill — load via jiti if installed.
  const jitiPath = require.resolve('jiti', { paths: [process.cwd()] });
  const jiti = require(jitiPath)(fileURLToPath(import.meta.url));
  const mod = jiti('./src/services/pipelineAuditValidator.ts');
  validateReviewResult = mod.validateReviewResult;
  validateFactCheckResult = mod.validateFactCheckResult;
} catch {
  // Fallback: structure-only checks below.
}

const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.SHINE_DEEPSEEK_KEY || '';
const BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

if (!API_KEY) {
  console.error('Missing DEEPSEEK_API_KEY');
  process.exit(2);
}

function separate(message) {
  const rawContent = message?.content;
  const rawReasoning = message?.reasoning_content;
  const text =
    typeof rawContent === 'string' && rawContent.trim().length > 0
      ? rawContent
      : null;
  const reasoningText =
    typeof rawReasoning === 'string' && rawReasoning.trim().length > 0
      ? rawReasoning
      : null;
  return { text, reasoningText };
}

async function callLLM(messages, maxTokens, jsonMode) {
  const body = {
    model: MODEL,
    messages,
    max_tokens: maxTokens,
    temperature: 0.3,
    stream: false,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 400)}`);
  }
  const message = data.choices?.[0]?.message || {};
  const sep = separate(message);
  return {
    finishReason: data.choices?.[0]?.finish_reason ?? null,
    usage: data.usage,
    text: sep.text,
    reasoningText: sep.reasoningText,
    textLen: sep.text?.length || 0,
    reasoningLen: sep.reasoningText?.length || 0,
    // Never log full secrets; previews only.
    textPreview: (sep.text || '').slice(0, 240),
    reasoningPreview: (sep.reasoningText || '').slice(0, 160),
    // Prove old bug path would have accepted reasoning:
    oldBugWouldAccept: Boolean(
      (message.content || message.reasoning_content || null) &&
        !(typeof message.content === 'string' && message.content.trim()),
    ),
  };
}

const draft =
  '夜色笼罩古城。林深把银钥匙塞进怀里，沿东城墙走向钟楼。他记得上章钥匙本已交给阿乙，此刻却仍在自己口袋里。风沙扑面，远处钟声敲了三下。';

function fallbackValidate(kind, result) {
  if (!result.text && result.reasoningText) {
    return { valid: false, reason: 'reasoning_only' };
  }
  if (!result.text) return { valid: false, reason: 'empty_content' };
  try {
    let t = result.text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) t = fence[1].trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end <= start) return { valid: false, reason: 'invalid_json' };
    const obj = JSON.parse(t.slice(start, end + 1));
    if (kind === 'review') {
      const ok =
        Array.isArray(obj.strengths) &&
        Array.isArray(obj.issues) &&
        Array.isArray(obj.suggestions);
      return ok
        ? { valid: true, reason: null, normalizedText: JSON.stringify(obj) }
        : { valid: false, reason: 'missing_required_fields' };
    }
    const ok =
      Array.isArray(obj.errors) &&
      Array.isArray(obj.warnings) &&
      Array.isArray(obj.confirmed);
    return ok
      ? { valid: true, reason: null, normalizedText: JSON.stringify(obj) }
      : { valid: false, reason: 'missing_required_fields' };
  } catch {
    return {
      valid: false,
      reason: result.finishReason === 'length' ? 'truncated_output' : 'invalid_json',
    };
  }
}

function validate(kind, result) {
  const llmResult = {
    text: result.text,
    reasoningText: result.reasoningText,
    inputTokens: result.usage?.prompt_tokens || 0,
    outputTokens: result.usage?.completion_tokens || 0,
    totalTokens: result.usage?.total_tokens || 0,
    finishReason: result.finishReason,
  };
  if (kind === 'review' && validateReviewResult) {
    return validateReviewResult(llmResult, draft);
  }
  if (kind === 'factCheck' && validateFactCheckResult) {
    return validateFactCheckResult(llmResult, draft);
  }
  return fallbackValidate(kind, result);
}

async function main() {
  const results = {};

  console.log('[live] A: short prompt (often reasoning-only on deepseek-v4-flash)...');
  results.A_short_ping = await callLLM(
    [{ role: 'user', content: '只回复：pong' }],
    64,
    false,
  );
  results.A_short_ping.validation = validate('review', results.A_short_ping);

  console.log('[live] B: literary review + json_object...');
  results.B_review_json = await callLLM(
    [
      {
        role: 'system',
        content:
          '你是小说审阅编辑。只输出 JSON：{"strengths":[],"issues":[],"suggestions":[]}。不要输出正文、不要 Markdown。',
      },
      { role: 'user', content: `【初稿】\n${draft}\n请审阅。` },
    ],
    1200,
    true,
  );
  results.B_review_json.validation = validate('review', results.B_review_json);

  console.log('[live] C: fact-check + json_object...');
  results.C_factcheck_json = await callLLM(
    [
      {
        role: 'system',
        content:
          '你是事实核查员。只输出 JSON：{"errors":[],"warnings":[],"confirmed":[]}。不要输出正文、不要 Markdown。',
      },
      {
        role: 'user',
        content: `【设定】上章银钥匙已交给阿乙。\n【初稿】\n${draft}\n请核查。`,
      },
    ],
    1200,
    true,
  );
  results.C_factcheck_json.validation = validate(
    'factCheck',
    results.C_factcheck_json,
  );

  console.log('[live] D: review without json mode...');
  results.D_review_no_json_mode = await callLLM(
    [
      {
        role: 'system',
        content:
          '你是小说审阅编辑。请用 JSON 输出 strengths/issues/suggestions，不要输出完整正文。',
      },
      { role: 'user', content: `审阅：${draft}` },
    ],
    900,
    false,
  );
  results.D_review_no_json_mode.validation = validate(
    'review',
    results.D_review_no_json_mode,
  );

  // Simulated pipeline decisions with our new rules
  const decisions = {
    if_short_ping_used_as_review: results.A_short_ping.validation.valid
      ? 'would_wrongly_succeed'
      : 'correctly_rejected',
    review_json: results.B_review_json.validation.valid
      ? 'accepted_for_proof'
      : `rejected:${results.B_review_json.validation.reason}`,
    factcheck_json: results.C_factcheck_json.validation.valid
      ? 'accepted_for_proof'
      : `rejected:${results.C_factcheck_json.validation.reason}`,
    old_bug_path_would_accept_reasoning:
      results.A_short_ping.oldBugWouldAccept === true,
    new_path_never_uses_reasoning_as_text:
      results.A_short_ping.text === null ||
      !String(results.A_short_ping.text).includes(
        results.A_short_ping.reasoningPreview || '___none___',
      ),
  };

  const report = {
    at: new Date().toISOString(),
    model: MODEL,
    base: BASE.replace(/\/\/.*@/, '//'),
    validatorBackend: validateReviewResult ? 'pipelineAuditValidator.ts' : 'fallback',
    results: Object.fromEntries(
      Object.entries(results).map(([k, v]) => [
        k,
        {
          finishReason: v.finishReason,
          textLen: v.textLen,
          reasoningLen: v.reasoningLen,
          textPreview: v.textPreview,
          reasoningPreview: v.reasoningPreview,
          oldBugWouldAccept: v.oldBugWouldAccept,
          validation: {
            valid: v.validation.valid,
            reason: v.validation.reason || null,
            details: v.validation.details || null,
          },
        },
      ]),
    ),
    decisions,
  };

  const outDir = path.join(process.cwd(), 'test-logs');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'deepseek-live-probe.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  const md = [
    '# DeepSeek Live Audit Validity Probe',
    '',
    `Time: ${report.at}`,
    `Model: ${report.model}`,
    `Validator: ${report.validatorBackend}`,
    '',
    '## Results',
    '',
    ...Object.entries(report.results).map(
      ([k, v]) =>
        `- **${k}**: textLen=${v.textLen}, reasoningLen=${v.reasoningLen}, finish=${v.finishReason}, valid=${v.validation.valid}, reason=${v.validation.reason}, oldBugWouldAccept=${v.oldBugWouldAccept}`,
    ),
    '',
    '## Pipeline decisions under new rules',
    '',
    ...Object.entries(decisions).map(([k, v]) => `- ${k}: **${v}**`),
    '',
    '## Pass criteria',
    '',
    `- reasoning-only rejected: ${decisions.if_short_ping_used_as_review === 'correctly_rejected' ? 'PASS' : 'FAIL'}`,
    `- old bug path detected on short call: ${decisions.old_bug_path_would_accept_reasoning ? 'YES (expected for this model)' : 'NO'}`,
    `- new path never puts reasoning into text: ${decisions.new_path_never_uses_reasoning_as_text ? 'PASS' : 'FAIL'}`,
    '',
  ].join('\n');
  const mdPath = path.join(outDir, 'deepseek-live-probe.md');
  fs.writeFileSync(mdPath, md, 'utf8');
  console.log(md);
  console.log(`Wrote ${outPath}`);
  console.log(`Wrote ${mdPath}`);

  const criticalOk =
    decisions.if_short_ping_used_as_review === 'correctly_rejected' &&
    decisions.new_path_never_uses_reasoning_as_text;
  process.exit(criticalOk ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
