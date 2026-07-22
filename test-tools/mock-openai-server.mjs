/**
 * Deterministic OpenAI Compatible Mock API for ShineWriter pipeline validation.
 *
 * Listens: 0.0.0.0:18080
 * Endpoint: POST /v1/chat/completions
 *
 * Stage identification (by message content keywords):
 *   draft           - "你是初稿作者"
 *   review          - "你是一位资深小说审阅编辑"
 *   reviewRepair    - "你上一轮输出不是有效的文学评估 JSON"
 *   factCheck       - "你是小说事实核查员"
 *   factCheckRepair - "你上一轮输出不是有效的事实核查 JSON"
 *   proof           - "你是终审校对员"
 *
 * Scenario is selected via SCENARIO env var or test-logs/mock-scenario.json.
 * Each scenario defines per-stage behavior on 1st and 2nd call.
 *
 * Logs to test-logs/mock-api-requests.jsonl (Authorization header redacted).
 *
 * Usage:
 *   node test-tools/mock-openai-server.mjs                       # default scenario
 *   $env:MOCK_SCENARIO="review_prose_then_valid"; node ...mjs    # override
 *   curl http://127.0.0.1:18080/__scenario                       # inspect
 *   curl -X PUT http://127.0.0.1:18080/__scenario -d '{"name":"..."}'
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const LOG_PATH = path.join(PROJECT_ROOT, 'test-logs', 'mock-api-requests.jsonl');
const SCENARIO_FILE = path.join(PROJECT_ROOT, 'test-logs', 'mock-scenario.json');

const PORT = Number(process.env.MOCK_PORT || 18080);
const HOST = '0.0.0.0';

// ---------------- Standard content snippets ----------------

const DRAFT_TEXT = `林深沿着东城墙的石阶缓步而行，夜风卷起衣角。远处钟楼的轮廓在月色下若隐若现。

他记得阿乙说过，钟楼午夜只响两次。可当他走到城墙转角，迎面看见的却是多年未见的顾寒。

"阿深？"顾寒微微一怔，左腿微跛地走近，"想不到在这里遇见你。"

林深没有立即回答。他注意到顾寒走路的姿态与记忆中略有不同——那条左腿似乎比从前更不利索了。

"寒叔，"林深终于开口，"你怎么会在这里？"

顾寒苦笑了一下，望向钟楼方向："等着看一场不该发生的事。"`

const REVIEW_JSON = JSON.stringify({
  strengths: ['开篇氛围营造得当', '人物登场自然'],
  issues: ['顾寒登场稍显突兀', '可补充顾寒多年未见的原因'],
  suggestions: ['在顾寒开口前增加林深的心理描写', '通过环境细节暗示时间流逝'],
});

const FACTCHECK_JSON_OBJECT_ARRAY = JSON.stringify({
  errors: [
    {
      category: 'character_state',
      description: '顾寒左腿微跛的描述与第1章一致',
      draftQuote: '左腿微跛地走近',
      evidence: '第1章明确顾寒左腿微跛',
      evidenceType: 'episodic',
      suggestedAction: '保持现状',
    },
  ],
  warnings: [],
  confirmed: ['钟楼午夜响两次的设定与世界书一致', '林深未持有银钥匙符合第11章交接'],
});

const FACTCHECK_JSON_STRING_ARRAY = JSON.stringify({
  errors: [],
  warnings: ['顾寒多年未见的背景未充分铺垫'],
  confirmed: ['林深沿东城墙走向钟楼符合地理规则'],
});

const PROOF_TEXT = `林深沿着东城墙的石阶缓步而行，夜风卷起衣角，远处钟楼的轮廓在月色下若隐若现。

他记得阿乙说过，黑沙城东钟楼午夜只响两次。可当他走到城墙转角，迎面看见的却是多年未见的顾寒。

"阿深？"顾寒微微一怔，左腿微跛地走近，"想不到在这里遇见你。"

林深没有立即回答。他注意到顾寒走路的姿态与记忆中略有不同——那条左腿似乎比从前更不利索了，左脚落地时总微微偏向外侧。

"寒叔，"林深终于开口，目光扫过顾寒略显疲惫的脸，"你怎么会在这里？这许多年不见，我以为你早已离开黑沙城。"

顾寒苦笑了一下，望向钟楼方向："等着看一场不该发生的事。"`

// Long body that should be rejected as novel_output / draft_echo
const FULL_BODY = DRAFT_TEXT;
const DRAFT_ECHO = `【需要审阅的初稿】\n${DRAFT_TEXT}`;

// Truncated JSON (no closing brace)
const TRUNCATED_REVIEW_JSON = `{"strengths":["节奏清晰"],"issues":["结尾过快"],"suggestions":["补充收束`

// Markdown-fenced JSON
const FENCED_REVIEW_JSON = '```json\n' + REVIEW_JSON + '\n```';

// JSON with extra top-level field containing body
const EXTRA_BODY_FIELD_REVIEW = JSON.stringify({
  strengths: ['节奏清晰'],
  issues: [],
  suggestions: [],
  novel_output: FULL_BODY,
});

// Nested unknown field containing body
const NESTED_BODY_FIELD_REVIEW = JSON.stringify({
  strengths: ['节奏清晰'],
  issues: [],
  suggestions: [],
  metadata: { draft_body: FULL_BODY },
});

// Empty string array element
const EMPTY_ITEM_REVIEW = JSON.stringify({
  strengths: [''],
  issues: ['结尾过快'],
  suggestions: ['补充收束'],
});

// Whitespace string array element
const WHITESPACE_ITEM_REVIEW = JSON.stringify({
  strengths: ['   '],
  issues: ['结尾过快'],
  suggestions: ['补充收束'],
});

// Invalid array item types
const INVALID_ITEM_NUMBER_REVIEW = JSON.stringify({
  strengths: [1, 2],
  issues: ['结尾过快'],
  suggestions: ['补充收束'],
});
const INVALID_ITEM_BOOL_REVIEW = JSON.stringify({
  strengths: [true],
  issues: ['结尾过快'],
  suggestions: ['补充收束'],
});
const INVALID_ITEM_NULL_REVIEW = JSON.stringify({
  strengths: [null],
  issues: ['结尾过快'],
  suggestions: ['补充收束'],
});
const INVALID_ITEM_OBJECT_REVIEW = JSON.stringify({
  strengths: [{}],
  issues: ['结尾过快'],
  suggestions: ['补充收束'],
});

// Missing required fields
const MISSING_FIELDS_REVIEW = JSON.stringify({
  strengths: ['节奏清晰'],
  // no issues / suggestions
});

// Legitimate empty arrays (allowed)
const EMPTY_ARRAYS_REVIEW = JSON.stringify({
  strengths: [],
  issues: [],
  suggestions: [],
});

// Single oversized item (>50% of draft length)
const OVERSIZED_ITEM_REVIEW = JSON.stringify({
  strengths: [DRAFT_TEXT.slice(0, 2500)],
  issues: [],
  suggestions: [],
});

// JSON fence + extra prose outside fence
const FENCE_PLUS_PROSE = `我会按照要求输出。

\`\`\`json
${REVIEW_JSON}
\`\`\`

希望这能帮助你。`;

// ---------------- Scenario library ----------------
// Each scenario maps a stage to a list of responses.
// Index 0 = first call, index 1 = second call (repair retry).
// If a stage has only 1 entry, that response is returned for all calls.
// Special: scenario "json_mode_unsupported" returns 400 on first call with
//          response_format, then 200 on second call without it.

const SCENARIOS = {
  // ---- Normal ----
  all_valid: {
    description: '所有阶段正常',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },

  // ---- Repair retry success ----
  review_prose_then_valid: {
    description: 'Review 第一次正文，修复重试返回合法 JSON',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: FULL_BODY, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  fact_prose_then_valid: {
    description: 'FactCheck 第一次正文，修复重试返回合法 JSON',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FULL_BODY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },

  // ---- Always invalid (no repair success) ----
  review_always_prose: {
    description: 'Review 两次均返回完整正文',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: FULL_BODY, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: FULL_BODY, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  fact_always_prose: {
    description: 'FactCheck 两次均返回完整正文',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FULL_BODY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FULL_BODY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  both_audits_invalid: {
    description: '两侧两次都无效',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: FULL_BODY, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: FULL_BODY, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FULL_BODY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FULL_BODY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },

  // ---- Reasoning-only ----
  reasoning_only_review: {
    description: 'Review content 为空，只有 reasoning',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: '', reasoning: 'Review reasoning only', finish: 'stop' }],
    reviewRepair: [{ content: '', reasoning: 'Review repair reasoning only', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  reasoning_only_fact: {
    description: 'FactCheck content 为空，只有 reasoning',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: '', reasoning: 'FactCheck reasoning only', finish: 'stop' }],
    factCheckRepair: [{ content: '', reasoning: 'FactCheck repair reasoning only', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  proof_reasoning_only: {
    description: 'Proof content 为空，只有 reasoning',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: '', reasoning: 'Proof reasoning only', finish: 'stop' }],
  },
  proof_empty: {
    description: 'Proof content 和 reasoning 都为空',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: '', reasoning: '', finish: 'stop' }],
  },

  // ---- Truncation ----
  truncated_review: {
    description: 'Review 不完整 JSON + finish_reason=length',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: TRUNCATED_REVIEW_JSON, reasoning: '', finish: 'length' }],
    reviewRepair: [{ content: TRUNCATED_REVIEW_JSON, reasoning: '', finish: 'length' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  truncated_fact: {
    description: 'FactCheck 不完整 JSON + finish_reason=length',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: TRUNCATED_REVIEW_JSON.replace('strengths', 'errors').replace('issues', 'warnings').replace('suggestions', 'confirmed'), reasoning: '', finish: 'length' }],
    factCheckRepair: [{ content: TRUNCATED_REVIEW_JSON.replace('strengths', 'errors').replace('issues', 'warnings').replace('suggestions', 'confirmed'), reasoning: '', finish: 'length' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  complete_json_length: {
    description: '合法完整 JSON + finish_reason=length',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: REVIEW_JSON, reasoning: '', finish: 'length' }],
    reviewRepair: [{ content: REVIEW_JSON, reasoning: '', finish: 'length' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'length' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'length' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'length' }],
  },

  // ---- Extra fields / shape violations ----
  extra_body_field: {
    description: '额外顶层字段包含整篇正文',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: EXTRA_BODY_FIELD_REVIEW, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: EXTRA_BODY_FIELD_REVIEW, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  nested_body_field: {
    description: '嵌套未知字段包含整篇正文',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: NESTED_BODY_FIELD_REVIEW, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: NESTED_BODY_FIELD_REVIEW, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },

  // ---- Empty / whitespace array items ----
  empty_array_item: {
    description: '数组中包含 ""',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: EMPTY_ITEM_REVIEW, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: EMPTY_ITEM_REVIEW, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  whitespace_array_item: {
    description: '数组中包含 "   "',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: WHITESPACE_ITEM_REVIEW, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: WHITESPACE_ITEM_REVIEW, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  invalid_array_item: {
    description: '数组中包含数字、布尔、null、空对象',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: INVALID_ITEM_NUMBER_REVIEW, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: INVALID_ITEM_BOOL_REVIEW, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },

  // ---- Empty draft ----
  empty_draft: {
    description: 'Draft content 为空',
    draft: [{ content: '', reasoning: '', finish: 'stop' }],
    review: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  draft_reasoning_only: {
    description: 'Draft content 为空，reasoning 有内容',
    draft: [{ content: '', reasoning: 'Draft reasoning only', finish: 'stop' }],
    review: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },

  // ---- Audit variations (for A group) ----
  a04_markdown_fence: {
    description: 'Markdown JSON 围栏',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: FENCED_REVIEW_JSON, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  a05_full_body: {
    description: '完整正文 (novel_output)',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: FULL_BODY, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: FULL_BODY, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  a06_draft_echo: {
    description: '初稿大段回显 (draft_echo)',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: DRAFT_ECHO, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: DRAFT_ECHO, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  a09_missing_fields: {
    description: '缺少必要字段',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: MISSING_FIELDS_REVIEW, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: MISSING_FIELDS_REVIEW, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  a16_empty_arrays: {
    description: '合法空数组',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: EMPTY_ARRAYS_REVIEW, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: EMPTY_ARRAYS_REVIEW, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: JSON.stringify({ errors: [], warnings: [], confirmed: [] }), reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: JSON.stringify({ errors: [], warnings: [], confirmed: [] }), reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  a17_oversized_item: {
    description: '单项过长',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: OVERSIZED_ITEM_REVIEW, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: OVERSIZED_ITEM_REVIEW, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  a18_fence_plus_prose: {
    description: 'JSON 围栏外存在长篇正文',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: FENCE_PLUS_PROSE, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: FENCE_PLUS_PROSE, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  a03_factcheck_object_array: {
    description: '合法 FactCheck 对象数组',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  a02_factcheck_string_array: {
    description: '合法 FactCheck 字符串数组',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_STRING_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_STRING_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },

  // ---- Empty content with reasoning (P04) ----
  empty_content_with_reasoning: {
    description: 'content 空字符串、reasoning 有值',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: '', reasoning: '内部推理', finish: 'stop' }],
    reviewRepair: [{ content: '', reasoning: '内部推理', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },

  // ---- HTTP errors (handled in handler, not response body) ----
  http_401: { description: '鉴权失败', httpStatus: 401, body: { error: 'invalid api key' } },
  http_429: { description: '限流', httpStatus: 429, body: { error: 'rate limit' } },
  http_500: { description: '服务端失败', httpStatus: 500, body: { error: 'internal' } },

  // ---- Network behaviors ----
  slow_response: {
    description: '延迟 30 秒响应',
    delayMs: 30000,
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
  },
  connection_drop: {
    description: '请求中断 (connection drop)',
    dropConnection: true,
  },

  // ---- JSON Mode 400 ----
  json_mode_unsupported: {
    description: '第一次带 response_format 返回 400，第二次成功',
    // Special: handler returns 400 when response_format is present AND first call
    // On retry (no response_format), returns normal JSON
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    reviewRepair: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    factCheckRepair: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
    // Flag: first call with response_format returns 400
    jsonMode400OnFirst: true,
  },

  // ---- Malformed response (N09) ----
  malformed_empty_choices: {
    description: 'malformed: {"choices":[]}',
    draft: [{ content: DRAFT_TEXT, reasoning: '', finish: 'stop' }],
    review: [{ content: REVIEW_JSON, reasoning: '', finish: 'stop' }],
    factCheck: [{ content: FACTCHECK_JSON_OBJECT_ARRAY, reasoning: '', finish: 'stop' }],
    proof: [{ content: PROOF_TEXT, reasoning: '', finish: 'stop' }],
    // For all calls: return empty choices array
    emptyChoices: true,
  },
};

// ---------------- Runtime state ----------------

let currentScenarioName = process.env.MOCK_SCENARIO || 'all_valid';
const stageCallCounts = { draft: 0, review: 0, reviewRepair: 0, factCheck: 0, factCheckRepair: 0, proof: 0 };
let jsonModeFirstCallSeen = false;

function loadScenarioOverride() {
  try {
    if (fs.existsSync(SCENARIO_FILE)) {
      const data = JSON.parse(fs.readFileSync(SCENARIO_FILE, 'utf8'));
      if (data && data.name && SCENARIOS[data.name]) {
        currentScenarioName = data.name;
      }
    }
  } catch {
    // ignore
  }
}

function saveScenarioOverride(name) {
  fs.writeFileSync(SCENARIO_FILE, JSON.stringify({ name, setAt: new Date().toISOString() }, null, 2));
}

function resetCounts() {
  for (const k of Object.keys(stageCallCounts)) stageCallCounts[k] = 0;
  jsonModeFirstCallSeen = false;
}

// ---------------- Stage identification ----------------

function identifyStage(body) {
  const messages = body.messages || [];
  // Inspect last few messages for stage keywords.
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const lastMsg = messages[messages.length - 1];
  const sysMsg = messages.find(m => m.role === 'system');
  const sysContent = sysMsg?.content || '';
  const lastUserContent = lastUserMsg?.content || '';
  const lastMsgContent = lastMsg?.content || '';

  // Repair messages: appends a final user message with "你上一轮输出不是有效的..."
  if (typeof lastMsgContent === 'string' && lastMsgContent.includes('你上一轮输出不是有效的文学评估 JSON')) {
    return 'reviewRepair';
  }
  if (typeof lastMsgContent === 'string' && lastMsgContent.includes('你上一轮输出不是有效的事实核查 JSON')) {
    return 'factCheckRepair';
  }
  if (sysContent.includes('你是一位资深小说审阅编辑')) return 'review';
  if (sysContent.includes('你是小说事实核查员')) return 'factCheck';
  if (sysContent.includes('你是终审校对员')) return 'proof';
  if (sysContent.includes('你是初稿作者') || lastUserContent.includes('你是初稿作者')) return 'draft';
  // Fallback heuristic
  if (body.max_tokens && body.max_tokens <= 800) {
    return body.response_format ? 'review' : 'draft';
  }
  return 'draft';
}

// ---------------- Logging ----------------

function logRequest(stage, body, responseStatus) {
  const entry = {
    ts: new Date().toISOString(),
    stage,
    callIndex: stageCallCounts[stage] || 0,
    scenario: currentScenarioName,
    response_format: body.response_format || null,
    max_tokens: body.max_tokens || null,
    temperature: body.temperature ?? null,
    top_p: body.top_p ?? null,
    stream: body.stream || false,
    model: body.model || null,
    message_count: (body.messages || []).length,
    auth_redacted: '<redacted>',
    response_status: responseStatus,
  };
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
}

// ---------------- HTTP handler ----------------

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function buildChoiceResponse(scenario, stage, callIdx) {
  const stageResponses = scenario[stage] || [];
  if (stageResponses.length === 0) {
    // Default: return a minimal valid response
    return {
      choices: [{
        message: { content: '', reasoning_content: '' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
    };
  }
  const resp = stageResponses[Math.min(callIdx, stageResponses.length - 1)];
  return {
    choices: [{
      message: { content: resp.content, reasoning_content: resp.reasoning || '' },
      finish_reason: resp.finish || 'stop',
    }],
    usage: { prompt_tokens: 200, completion_tokens: (resp.content || '').length + (resp.reasoning || '').length, total_tokens: 200 + (resp.content || '').length },
  };
}

function handleChatCompletions(req, res, body) {
  const scenario = SCENARIOS[currentScenarioName];
  if (!scenario) {
    sendJSON(res, 500, { error: { message: `Unknown scenario: ${currentScenarioName}` } });
    return;
  }

  // HTTP error scenarios
  if (scenario.httpStatus) {
    logRequest('unknown', body, scenario.httpStatus);
    sendJSON(res, scenario.httpStatus, scenario.body || { error: 'mock error' });
    return;
  }

  // Connection drop
  if (scenario.dropConnection) {
    logRequest('unknown', body, 0);
    req.destroy();
    res.destroy();
    return;
  }

  // Slow response
  const delayMs = scenario.delayMs || 0;

  const stage = identifyStage(body);
  stageCallCounts[stage] = (stageCallCounts[stage] || 0) + 1;
  const callIdx = stageCallCounts[stage] - 1;

  // JSON mode 400 first call
  if (scenario.jsonMode400OnFirst && body.response_format && !jsonModeFirstCallSeen) {
    jsonModeFirstCallSeen = true;
    logRequest(stage, body, 400);
    sendJSON(res, 400, {
      error: {
        message: 'response_format json_object is not supported',
        type: 'invalid_request_error',
      },
    });
    return;
  }

  // Empty choices malformed
  if (scenario.emptyChoices) {
    logRequest(stage, body, 200);
    setTimeout(() => {
      sendJSON(res, 200, {
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
      });
    }, delayMs);
    return;
  }

  const responseBody = buildChoiceResponse(scenario, stage, callIdx);
  logRequest(stage, body, 200);
  setTimeout(() => {
    sendJSON(res, 200, responseBody);
  }, delayMs);
}

function handleControl(req, res, pathname, method) {
  if (pathname === '/__scenario' && method === 'GET') {
    sendJSON(res, 200, {
      current: currentScenarioName,
      description: SCENARIOS[currentScenarioName]?.description || '',
      stageCallCounts,
      available: Object.keys(SCENARIOS),
    });
    return true;
  }
  if (pathname === '/__scenario' && method === 'PUT') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.name || !SCENARIOS[data.name]) {
          sendJSON(res, 400, { error: `Unknown scenario: ${data.name}` });
          return;
        }
        currentScenarioName = data.name;
        saveScenarioOverride(data.name);
        resetCounts();
        sendJSON(res, 200, { ok: true, current: currentScenarioName });
      } catch (e) {
        sendJSON(res, 400, { error: String(e) });
      }
    });
    return true;
  }
  if (pathname === '/__reset' && method === 'POST') {
    resetCounts();
    sendJSON(res, 200, { ok: true, stageCallCounts });
    return true;
  }
  if (pathname === '/__counts' && method === 'GET') {
    sendJSON(res, 200, { stageCallCounts });
    return true;
  }
  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (handleControl(req, res, pathname, method)) return;

  if (pathname === '/v1/chat/completions' && method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        // Reload scenario override before each call (allows test scripts to change scenarios)
        loadScenarioOverride();
        handleChatCompletions(req, res, parsed);
      } catch (e) {
        sendJSON(res, 400, { error: { message: 'invalid JSON: ' + String(e) } });
      }
    });
    return;
  }

  if (pathname === '/v1/models' && method === 'GET') {
    sendJSON(res, 200, {
      object: 'list',
      data: [{ id: 'mock-model', object: 'model', created: 0, owned_by: 'mock' }],
    });
    return;
  }

  sendJSON(res, 404, { error: { message: `not found: ${method} ${pathname}` } });
});

// Initialize: load override if exists, reset log
loadScenarioOverride();
resetCounts();
// Truncate log file at startup
fs.writeFileSync(LOG_PATH, '');

server.listen(PORT, HOST, () => {
  console.log(`[mock-openai-server] listening on http://${HOST}:${PORT}`);
  console.log(`[mock-openai-server] scenario=${currentScenarioName} (${SCENARIOS[currentScenarioName]?.description || ''})`);
  console.log(`[mock-openai-server] log=${LOG_PATH}`);
  console.log(`[mock-openai-server] control: GET/PUT /__scenario, POST /__reset, GET /__counts`);
});
