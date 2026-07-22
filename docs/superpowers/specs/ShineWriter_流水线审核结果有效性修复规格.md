# ShineWriter 流水线审核结果有效性修复规格（SPEC）

> 文档状态：可执行  
> 目标项目：TAVO-MINI / ShineWriter  
> 适用范围：API 单 LLM 流水线  
> 建议版本：V2.5.18 或后续修复版本  
> 文档版本：1.0  
> 日期：2026-07-22

---

## 1. 目的

本规格用于修复 ShineWriter 流水线中以下问题：

> 文学评估或事实核查阶段返回完整正文、初稿回显、推理过程、截断 JSON 或其他无效内容时，系统仍将其标记为审核成功，并把该内容交给终审。

目标链路：

```text
LLM 原始响应
  ↓
正式 content 与 reasoning_content 分离
  ↓
阶段专属格式解析与校验
  ↓
空内容、正文回显、截断、错误结构检测
  ↓
必要时执行一次格式修复重试
  ↓
只有有效审核报告才能进入终审
```

现有正确的流水线顺序必须保持：

```text
noReview:
上下文 → 初稿

twoStage:
上下文 → 初稿 → 文学评估 → 终审

conditional:
上下文 → 初稿 → 事实核查 → 终审

full:
上下文 → 初稿
       → 文学评估与事实核查并行
       → 等待有效报告
       → 综合终审
```

---

## 2. 已确认根因

当前 OpenAI 兼容 Provider 存在类似逻辑：

```ts
const text = message.content || message.reasoning_content || null;
```

这会把推理模型的 `reasoning_content` 兜底当作正式输出。随后流水线阶段只要拿到非空字符串，就可能直接保存为 `review` 或 `factCheck` 成功结果。

因此以下内容都可能被错误保存为审核报告：

- 模型推理过程；
- 完整初稿；
- 改写后的完整正文；
- 被截断的 JSON；
- Markdown 解释；
- 正文复述；
- 空 `content` 下的 `reasoning_content`。

提高 Max Tokens 只能缓解输出截断，不能解决该问题。

---

## 3. 总体目标

完成后必须满足：

1. `reasoning_content` 不得作为任何业务正式文本。
2. 文学评估必须通过文学评估报告结构校验。
3. 事实核查必须通过事实核查报告结构校验。
4. 完整正文、初稿回显、推理过程、截断 JSON、空内容不得标记成功。
5. 审核无效时最多执行一次格式修复重试。
6. 第二次仍无效时，该审核阶段标记失败。
7. `full` 模式只把通过校验的报告传给终审。
8. `full` 单侧有效时使用有效侧报告继续终审。
9. `full` 两侧均无效时不执行终审，保留初稿。
10. 终审不得使用 `reasoning_content` 兜底。
11. UI 和任务详情只能显示经过验证的审核结果。
12. 所有异常状态必须有自动化测试和 Android 模拟器验证。

---

## 4. 非目标

本次不实施：

- 不修改 Story Memory Schema；
- 不新增 Event Atom；
- 不新增向量数据库；
- 不重构 Checkpoint；
- 不修改初稿后二次召回主体；
- 不引入多模型路由；
- 不修改本地 GGUF；
- 不增加无限重试；
- 不新增终审后二次 LLM 复核；
- 不通过单纯提高 Max Tokens 替代结果校验。

---

## 5. Provider 响应分离

### 5.1 目标文件

至少检查：

```text
src/services/llm/types.ts
src/services/llm/openAICompatibleProvider.ts
src/services/llm.ts
```

### 5.2 修改 `LLMResult`

```ts
export interface LLMResult {
  text: string | null;
  reasoningText?: string | null;

  inputTokens: number;
  outputTokens: number;
  totalTokens: number;

  metrics?: LLMRequestMetrics;
  errorCode?: string;
  finishReason?: string | null;

  rawUsage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}
```

### 5.3 正确解析

```ts
const rawContent = message.content;
const rawReasoning = message.reasoning_content;

const text =
  typeof rawContent === 'string' && rawContent.trim().length > 0
    ? rawContent
    : null;

const reasoningText =
  typeof rawReasoning === 'string' && rawReasoning.trim().length > 0
    ? rawReasoning
    : null;
```

返回：

```ts
return {
  text,
  reasoningText,
  inputTokens,
  outputTokens,
  totalTokens,
  finishReason,
  metrics,
  rawUsage,
};
```

### 5.4 严禁

必须删除：

```ts
message.content || message.reasoning_content || null
```

`reasoningText` 不得进入：

- 初稿；
- 文学评估；
- 事实核查；
- 终审稿；
- Story Memory；
- 章节摘要；
- 任务详情；
- 自动保存正文。

连接测试可以保留独立兜底，但不得复用到生成接口。

---

## 6. 审核报告类型

建议新增：

```text
src/types/pipelineAudit.ts
```

### 6.1 文学评估

```ts
export interface ReviewReport {
  strengths: string[];
  issues: string[];
  suggestions: string[];
}
```

### 6.2 事实核查

第一版需兼容字符串数组与对象数组：

```ts
export interface FactCheckItem {
  category?: string;
  description: string;
  draftQuote?: string;
  evidenceType?: string;
  evidence?: string;
  suggestedAction?: string;
}

export interface FactCheckReport {
  errors: Array<string | FactCheckItem>;
  warnings: Array<string | FactCheckItem>;
  confirmed: Array<string | FactCheckItem>;
}
```

不得因为现有合法旧格式是字符串数组而全部判定失败。

---

## 7. 审核结果验证器

建议新增：

```text
src/services/pipelineAuditValidator.ts
```

### 7.1 类型

```ts
export type AuditValidationFailureReason =
  | 'empty_content'
  | 'reasoning_only'
  | 'invalid_json'
  | 'missing_required_fields'
  | 'draft_echo'
  | 'truncated_output'
  | 'oversized_report'
  | 'unexpected_shape';

export interface AuditValidationResult<T> {
  valid: boolean;
  report?: T;
  normalizedText?: string;
  reason?: AuditValidationFailureReason;
  details?: string;
}
```

### 7.2 导出函数

```ts
export function validateReviewResult(
  result: LLMResult,
  draftText: string,
): AuditValidationResult<ReviewReport>;

export function validateFactCheckResult(
  result: LLMResult,
  draftText: string,
): AuditValidationResult<FactCheckReport>;
```

---

## 8. 文学评估校验规则

文学评估必须满足：

1. `result.text` 存在且非空；
2. 可解析为 JSON；
3. 包含 `strengths`、`issues`、`suggestions`；
4. 三个字段均为数组；
5. 数组元素可规范化为字符串；
6. 不得大段回显初稿；
7. 输出不得接近完整正文；
8. `finishReason = "length"` 且 JSON 不完整时必须失败；
9. 不得把 `reasoningText` 当报告；
10. Markdown JSON 围栏可清理，但围栏外不得有长篇正文。

允许清理：

```text
```json
{...}
```
```

不得从一篇长正文中任意截取第一个 `{...}` 后直接判定合法。

---

## 9. 事实核查校验规则

事实核查必须满足：

1. `result.text` 非空；
2. 可解析为 JSON；
3. 包含 `errors`、`warnings`、`confirmed`；
4. 三个字段均为数组；
5. 允许字符串数组或对象数组；
6. 对象项至少包含可读描述；
7. 不得输出完整正文；
8. 不得把整篇初稿塞进某个字段；
9. 不得使用 `reasoningText`；
10. 截断 JSON 必须失败；
11. 超长且与初稿高度相似时判定正文回显；
12. 只有合法报告才能进入终审。

---

## 10. 正文回显检测

建议新增：

```ts
export interface DraftEchoCheckResult {
  isEcho: boolean;
  similarity: number;
  longestSharedSegment?: number;
  reason?: string;
}

export function detectDraftEcho(
  auditText: string,
  draftText: string,
): DraftEchoCheckResult;
```

### 10.1 本地轻量规则

组合以下信号：

1. 审核文本长度与初稿长度比例；
2. 审核文本开头与初稿开头高度一致；
3. 包含初稿中超过一定长度的连续片段；
4. 输出呈现连续小说叙事而非报告结构；
5. 单个 JSON 项长度接近整篇初稿。

建议初始常量：

```ts
const AUDIT_TO_DRAFT_LENGTH_RATIO = 0.65;
const LONG_SHARED_SEGMENT_CHARS = 400;
const MAX_SINGLE_AUDIT_ITEM_CHARS = 2000;
```

常量集中定义，便于测试调整。

### 10.2 避免误判

以下不应判定为回显：

- 引用初稿中的一句话；
- 数个短证据片段；
- 结构正确但内容稍长的报告；
- 很短的初稿。

初稿较短时，应降低长度比例权重，以结构校验为主。

---

## 11. 审核请求启用 JSON 模式

文学评估和事实核查调用时设置：

```ts
responseFormat: 'json_object'
```

例如：

```ts
await callLLMResult(
  messages,
  maxTokens,
  {
    scenario: 'pipeline_factcheck',
    responseFormat: 'json_object',
    ...
  },
  signal,
);
```

现有 Provider 若检测服务商不支持，可移除 `response_format` 后重试一次；但无论是否支持 JSON Mode，返回内容仍必须经过本地校验。

终审不得使用 JSON Mode。

---

## 12. 格式修复重试

### 12.1 次数

每个审核阶段最多重试一次：

```text
第一次调用
  ↓
有效 → 使用
  ↓
无效 → 修复重试一次
  ↓
有效 → 使用
  ↓
仍无效 → 阶段失败
```

不得无限重试。

### 12.2 可重试原因

- `empty_content`
- `reasoning_only`
- `invalid_json`
- `missing_required_fields`
- `draft_echo`
- `truncated_output`
- `unexpected_shape`

### 12.3 修复提示词

建议新增：

```ts
buildReviewRepairMessages(...)
buildFactCheckRepairMessages(...)
```

文学评估修复提示：

```text
你上一轮输出不是有效的文学评估 JSON。
不要重写、续写、润色或复述小说正文。
不要输出推理过程。
不要使用 Markdown 代码块。

请只输出：
{
  "strengths": [],
  "issues": [],
  "suggestions": []
}
```

事实核查修复提示：

```text
你上一轮输出不是有效的事实核查 JSON。
不要重写、续写、润色或复述小说正文。
不要输出推理过程。
不要使用 Markdown 代码块。

请只输出：
{
  "errors": [],
  "warnings": [],
  "confirmed": []
}
```

### 12.4 重试上下文

继续提供原审核上下文和初稿，但不要把完整无效响应再次注入。只需说明错误类型，例如：

```text
上一轮错误类型：输出了完整正文
```

重试使用原审核 Max Tokens，不得临时提高到初稿级别。

---

## 13. 流水线阶段接入

主要检查：

```text
src/services/pipelineRunner.ts
```

### 13.1 `runReviewStage`

```ts
const first = await callReviewLLM(...);
const firstValidation = validateReviewResult(first, draftText);

if (firstValidation.valid) {
  markSuccess(firstValidation.normalizedText!);
  return firstValidation.normalizedText!;
}

const retry = await callReviewRepairLLM(...);
const retryValidation = validateReviewResult(retry, draftText);

if (retryValidation.valid) {
  markSuccess(retryValidation.normalizedText!);
  return retryValidation.normalizedText!;
}

markFailed(retryValidation.reason);
return '';
```

### 13.2 `runFactCheckStage`

同样执行：

```text
首次请求 → 验证 → 修复重试 → 再验证 → 成功/失败
```

### 13.3 成功状态时机

只有通过验证后才能写：

```ts
status: 'success'
```

禁止先保存 success，再判断内容是否合法。

### 13.4 保存内容

只保存 `normalizedText`。

不得保存：

- reasoningText；
- 第一次无效输出；
- 截断 JSON；
- 完整正文回显；
- Provider 原始响应。

日志仅记录错误类型、长度、相似度和重试次数。

---

## 14. full 模式降级

### 两侧有效

```text
review valid + factCheck valid
→ proof 接收两份报告
```

### 只有文学评估有效

```text
review valid + factCheck invalid
→ factCheck = failed
→ proof 只接收 reviewText
```

### 只有事实核查有效

```text
review invalid + factCheck valid
→ review = failed
→ proof 只接收 factCheckText
```

### 两侧均无效

```text
review invalid + factCheck invalid
→ proof 不调用
→ 保留初稿
→ 明确审核失败
```

不得把无效正文交给终审。

---

## 15. twoStage 与 conditional

### twoStage

文学评估返回完整正文：

```text
首次验证失败
→ 修复重试
→ 仍失败
→ review = failed
→ proof = skipped
→ 保留初稿
```

### conditional

事实核查返回完整正文：

```text
首次验证失败
→ 修复重试
→ 仍失败
→ factCheck = failed
→ proof = skipped
→ 保留初稿
```

---

## 16. 空内容、reasoning-only 与终审

### 审核阶段

- `content` 为空、`reasoning_content` 有值：`reasoning_only`
- 两者都为空：`empty_content`

均不得标记成功。

### 终审阶段

终审不得使用 reasoning 兜底。

若：

```text
content 为空
reasoning_content 有值
```

必须：

```text
proof = failed
回退初稿
```

终审不执行 JSON 修复重试。

---

## 17. finishReason

若：

```ts
finishReason === 'length'
```

则：

```text
JSON 完整且通过结构校验 → 可接受
JSON 不完整 → truncated_output
```

`stop` 或 `null` 通常可接受，但最终仍以内容校验为准。

---

## 18. UI 与任务详情

必须检查阶段结果展示组件和任务详情页。

要求：

1. 只显示验证通过的 review / factCheck 报告。
2. 第一次无效输出不得显示。
3. 重试时可显示：
   ```text
   审核格式异常，正在重试
   ```
4. 最终失败显示：
   ```text
   文学评估返回格式无效
   事实核查返回格式无效
   ```
5. 不得在事实核查卡片中显示完整正文。
6. 不得显示 reasoning_content。
7. full 单侧失败必须显示部分失败。
8. 双侧失败不得显示终审成功。

---

## 19. 日志与可观测性

建议日志：

```text
[pipeline-audit] stage=factCheck attempt=1 valid=false reason=draft_echo
[pipeline-audit] stage=factCheck retry=true
[pipeline-audit] stage=factCheck attempt=2 valid=true
```

可记录：

- taskId；
- stage；
- attempt；
- textLength；
- reasoningLength；
- finishReason；
- validation reason；
- similarity；
- elapsedMs。

不得记录：

- 完整正文；
- 完整 reasoning；
- API Key；
- 完整人物卡；
- 完整世界书。

---

## 20. 主要修改范围

至少检查：

```text
src/services/llm/types.ts
src/services/llm/openAICompatibleProvider.ts
src/services/llm.ts

src/services/pipelineRunner.ts
src/services/pipelineMessages.ts
src/store/pipelineTaskStore.ts

src/types/pipelineAudit.ts
src/services/pipelineAuditValidator.ts
```

以及：

```text
任务详情页面
流水线阶段结果组件
通知栏状态组件
```

全仓搜索：

```text
reasoning_content
message.content
LLMResult
runReviewStage
runFactCheckStage
runProofStage
pipeline_review
pipeline_factcheck
responseFormat
stageResults
updateTaskStage
reviewText
factCheckText
finishReason
```

---

## 21. 自动化测试

### 21.1 Provider

1. 同时有 `content` 和 `reasoning_content`：分别保存。
2. 只有 `reasoning_content`：`text = null`。
3. 只有 `content`：正常返回。
4. 两者都为空：`text = null`。
5. reasoning 不得出现在 text。

### 21.2 文学评估验证

1. 合法 JSON 通过。
2. JSON 代码围栏可清理后通过。
3. 缺字段失败。
4. 字段非数组失败。
5. 完整正文失败。
6. 推理过程失败。
7. 空内容失败。
8. 截断 JSON 失败。
9. 超长单项失败。
10. 短引用不得误判。

### 21.3 事实核查验证

1. 合法字符串数组通过。
2. 合法对象数组通过。
3. 缺字段失败。
4. 完整正文失败。
5. 初稿回显失败。
6. JSON 字段塞整篇正文失败。
7. `finishReason = length` 且 JSON 不完整失败。
8. reasoning-only 失败。

### 21.4 修复重试

1. 第一次正文、第二次合法 JSON → 成功。
2. 第一次截断、第二次合法 JSON → 成功。
3. 两次正文 → 阶段失败。
4. 两次空内容 → 阶段失败。
5. 不得超过一次重试。
6. retry 继续使用 JSON Mode。
7. retry 不注入完整无效输出。

### 21.5 full 模式

1. 两侧有效 → proof 收到两份报告。
2. review 有效、factCheck 正文 → 只用 review。
3. review 正文、factCheck 有效 → 只用 factCheck。
4. 两侧均正文 → proof 不调用。
5. 一侧 reasoning-only → 该侧失败。
6. proof 不得收到 reasoningText。
7. success 只在验证后写入。

### 21.6 twoStage / conditional

1. only review 返回正文 → proof 不调用。
2. only factCheck 返回正文 → proof 不调用。
3. retry 成功后 proof 正常调用。
4. retry 失败后保留初稿。

### 21.7 终审

1. content 为空、reasoning 有值 → proof failed。
2. content 正常 → 使用 content。
3. 不使用 reasoning 兜底。
4. 空输出回退初稿。
5. UI 不得显示终审成功。

---

## 22. Android 模拟器验收

自动测试完成后，必须使用 Android 模拟器专项验证。

优先使用真机发现问题时的相同模型与配置。

### 场景 1：正常事实核查 JSON

预期：

- factCheck 显示报告；
- 不显示正文；
- proof 收到核查结果；
- 终稿按问题修订。

### 场景 2：第一次返回完整正文

通过 Mock Server、测试 Provider 或可控提示，让 factCheck 第一次返回正文。

预期：

```text
首次验证失败
→ 显示重试
→ 第二次合法则成功
```

### 场景 3：两次都返回正文

预期：

- factCheck 失败；
- review 有效时只按 review 终审；
- 不显示正文为核查结果。

### 场景 4：只有 reasoning_content

预期：

- reasoning 不展示；
- 审核失败或触发重试；
- 不保存为报告。

### 场景 5：截断 JSON

降低审核 Max Tokens，制造截断。

预期：

- 不标记成功；
- 重试一次；
- 重试失败则降级。

### 场景 6：两侧均无效

预期：

- proof 不调用；
- 保留初稿；
- UI 明确审核失败；
- 不显示终审完成。

保存证据：

- 阶段截图；
- 任务详情截图；
- logcat；
- stage_results 数据；
- Mock API 响应；
- 最终任务状态；
- proof 输入摘要日志。

---

## 23. 验收清单

### Provider

- [ ] `text` 与 `reasoningText` 分离。
- [ ] 删除 reasoning 兜底。
- [ ] 终审不使用 reasoning。

### 审核验证

- [ ] 文学评估结构校验完成。
- [ ] 事实核查结构校验完成。
- [ ] 完整正文被拒绝。
- [ ] 初稿回显被拒绝。
- [ ] 截断 JSON 被拒绝。
- [ ] 空内容被拒绝。
- [ ] reasoning-only 被拒绝。

### 重试

- [ ] 最多重试一次。
- [ ] 重试提示禁止正文输出。
- [ ] 重试有效时正常继续。
- [ ] 重试无效时阶段失败。

### 流水线

- [ ] full 只消费有效报告。
- [ ] full 单侧有效可继续。
- [ ] full 双侧无效不执行 proof。
- [ ] twoStage 无效评估不执行 proof。
- [ ] conditional 无效核查不执行 proof。
- [ ] proof 不收到 reasoning。
- [ ] 任务状态与实际结果一致。

### UI

- [ ] 审核卡片不再显示完整正文。
- [ ] reasoning 不展示。
- [ ] 重试状态可见。
- [ ] 单侧失败可识别。
- [ ] 双侧失败不显示终审成功。

### 工程验证

- [ ] lint 通过。
- [ ] typecheck 通过。
- [ ] 全量测试通过。
- [ ] Debug APK 构建通过。
- [ ] Android 模拟器专项验收通过。

---

## 24. Agent 执行顺序

### Phase 0：复现与基线

1. 阅读本规格。
2. 检查 Git 工作区。
3. 运行现有测试。
4. 用单测或模拟器复现 factCheck 返回正文仍 success。
5. 记录当前行为。

### Phase 1：Provider 响应分离

1. 修改 `LLMResult`。
2. 分离 content / reasoning_content。
3. 删除 reasoning 兜底。
4. 补 Provider 测试。

### Phase 2：审核验证器

1. 新增报告类型。
2. 新增 JSON 清理和解析。
3. 新增结构校验。
4. 新增正文回显检测。
5. 补 Validator 测试。

### Phase 3：流水线接入

1. review 接入验证。
2. factCheck 接入验证。
3. 新增一次修复重试。
4. success 延后到验证通过。
5. full 单侧/双侧降级。
6. proof 禁止 reasoning。
7. 补流水线测试。

### Phase 4：UI 与模拟器

1. 修正阶段结果展示。
2. 显示重试和失败状态。
3. Android 模拟器专项验收。
4. 修复发现的问题。
5. 全量 verify 与 APK 构建。

---

## 25. 完成报告要求

Agent 完成后必须报告：

1. 根因确认；
2. 修改文件列表；
3. Provider 分离方式；
4. 审核校验规则；
5. 正文回显检测规则；
6. 修复重试实现；
7. full 模式降级；
8. twoStage / conditional 行为；
9. 终审 reasoning 防护；
10. UI 修改；
11. 自动化测试结果；
12. 模拟器验证结果；
13. 测试证据路径；
14. `git diff --stat`；
15. 本地提交列表；
16. 未完成事项；
17. 已知风险。

---

## 26. 开发纪律

1. 先复现，再修复。
2. 不覆盖未提交改动。
3. 不执行破坏性 Git 命令。
4. 不直接推送远程，除非明确要求。
5. 不做无关重构。
6. 不修改 Story Memory 主体。
7. 不用提高 Max Tokens 代替校验。
8. 不把 reasoning 作为业务正文。
9. 不接受“只要有返回就成功”。
10. 每个 Phase 后运行相关测试。
11. 最后运行全量测试、类型检查和构建。
12. 使用 Android 模拟器完成专项验收。

---

## 27. 最终目标

修复后必须保证：

```text
事实核查返回完整正文
  ↓
识别为无效
  ↓
格式修复重试一次
  ↓
仍无效则阶段失败
  ↓
绝不把正文当成核查报告
```

以及：

```text
reasoning_content
  ↓
只作为内部可选调试信息
  ↓
不得进入 review / factCheck / proof / 正文 / UI
```

“审核成功”必须代表：

> 模型确实返回了一份结构正确、内容合理、非正文回显、可供终审执行的审核报告。
