# ShineWriter DeepSeek V4 Flash 终稿推理强度与流水线容错优化建设方案

> 文档性质：施工前技术方案、兼容基线与验收标准
> 适用版本：ShineWriter V2.11.39 / Schema 46 及后续版本
> 适用范围：大纲写作 Outline Workflow V2 的四个调用节点（Draft / Review / FactCheck / Proof）的思考强度、弹性预算与交付阶段
> 明确排除：锚点正文拼接、分段并行写作、增加正常路径 LLM 节点、修改 Continuation V5 语义
> 官方能力依据：[DeepSeek Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion/)（2026-08-09 核对）
> 核心结论：保留完整初稿输入、完整终稿输出和 Thinking，为 DeepSeek V4 Flash V2 四节点接入并冻结产品档位 `low|medium|high`；终稿门禁只判断“是否正确返回可交付正文”，不再用主观质量、改动幅度、长度比例或重复启发式阻止交付；Review V2 改为宽容解析和本地归一化，能提取出有效文学意见就继续，不再因非关键 JSON 结构差异浪费一次格式修复请求。

---

## 1. 背景与问题定义

Outline Workflow V2 已将 Legacy Proof 从“重新读取完整大纲、原始 Review/FactCheck、Story Memory、人物卡、世界书、Notes 等资料并重新判断”收敛为：

```text
Revision Contract
+ 一次完整 Canonical Draft
+ 最小章节目标 / 用户要求 / 上一章接缝 / 精简文风 / 硬约束
→ Final Reviser
→ 完整终稿正文
→ Local Final Artifact Validator
```

该改造已经减少重复上下文，但没有改变一个更重要的延迟事实：Thinking 模型在 Final Reviser 中仍需先生成隐藏推理 Token，再自回归生成完整正文。输入收敛不能直接消除这部分输出延迟。

最近一次设备侧 V2 twoStage 样本如下：

| 阶段 | request version | 输入 Token | completion Token | 可见内容字符 | 耗时 |
|---|---:|---:|---:|---:|---:|
| Draft | 1 | 1,143 | 1,520 | 1,792 | 20.45s |
| Review | 2 | 2,752 | 1,092 | 1,956 | 8.27s |
| Final Reviser / Proof | 2 | 3,546 | 20,245 | 2,046 | 161.38s |

任务与快照均冻结：

```text
outline_workflow_version = 2
context_budget_version = 2
execution.outlineWorkflowVersion = 2
proof request_version = 2
```

因此该样本不是误走 Legacy V1。终稿可见正文只有约 2,000 字符，但 completion 达到约 20,000 Token，说明主要瓶颈位于服务端生成阶段，而不是 3,546 Token 的输入预填充。

本方案不通过以下方式规避问题：

- 不关闭 Thinking；
- 不把完整终稿改成 anchor patch；
- 不按段并发写作后本地拼接；
- 不用多个相同终稿请求竞速浪费 Token；
- 不依赖进一步删除必要上下文换取不确定收益。

本方案只使用 DeepSeek V4 Flash 官方已经提供的推理强度控制能力，在保持完整章节连贯性的前提下压缩不必要的隐藏推理长度。

同时，本方案修复两个会抵消加速收益的现有控制面问题：

1. Final Reviser 已正确返回正文，却被启发式软件门禁拒绝，导致用户重试并重复消耗 Thinking 与正文 Token；
2. Review 已返回可理解的文学评估，却因为 JSON 白名单、必填字段、scope/anchor 或 outlineExecution 结构不完全匹配而整体失败，并触发一次额外格式修复请求。

---

## 2. 官方 API 能力与本地缺口

### 2.1 DeepSeek V4 Flash 官方能力

官方 Chat Completion API 当前支持：

```json
{
  "model": "deepseek-v4-flash",
  "thinking": { "type": "enabled" },
  "reasoning_effort": "low"
}
```

`reasoning_effort` 可取：

```text
low
high
max
```

官方文档说明：

- `thinking.type` 控制 Thinking 开关；
- `reasoning_effort` 控制推理强度；
- 默认推理强度为 `high`；
- `deepseek-v4-flash` 支持 `low / high / max` 三档；
- usage 可返回 `completion_tokens_details.reasoning_tokens`，用于区分隐藏推理 Token。

### 2.2 ShineWriter 当前实现缺口

当前类型只支持：

```ts
thinking?: { type: 'enabled' | 'disabled' };
```

当前 OpenAI-compatible Provider 只会写入：

```ts
requestBody.thinking = options.thinking;
```

没有类型、配置或请求体字段承载 `reasoning_effort`。因此 Final Reviser 开启 Thinking 时使用服务商默认档位，即官方 DeepSeek V4 Flash 的 `high`。

当前 Provider 虽然保留 `rawUsage`，但类型只声明：

```ts
prompt_tokens
completion_tokens
total_tokens
```

没有解析或持久化：

```text
completion_tokens_details.reasoning_tokens
```

这导致运行记录只能看到总 completion Token，无法区分：

```text
隐藏推理 Token
可见终稿 Token
```

---

## 3. 建设目标

### 3.1 核心目标

1. 保留 DeepSeek V4 Flash Thinking；
2. 保留完整 Canonical Draft 输入；
3. 保留完整终稿正文输出；
4. 不改变 Revision Contract、Local Final Validator 和 adoption 语义；
5. 为 Final Reviser 接入 `reasoning_effort`；
6. 新 V2 任务正常路径优先使用 `low`；
7. 复杂任务或明确失败恢复确定性升级为 `high`；
8. 旧任务 Resume 不改变既有请求语义；
9. 独立记录 reasoning Token，建立真实 A/B 证据；
10. 不增加正常 happy path 的物理 LLM 请求数；
11. `low / high / max` 三档使用相同的宽松终稿交付门禁；
12. Final Reviser 只要正确返回小说正文就进入成功，不因启发式质量判断自动重试；
13. Review V2 对可恢复 JSON 和非 JSON 文学评估执行本地归一化，减少“格式无效”失败；
14. Review 的额外 LLM format repair 从默认路径移除，只保留为空、纯正文回显等不可恢复场景的失败语义。

### 3.2 非目标

- 不重写 Outline Workflow V2 的四个持久化 Stage；
- 不新增 Planner、Judge 或第二个 Final Reviser 节点；
- 不修改 FactCheck 的硬事实绑定与安全语义；
- Review 的持久化结果仍归一化为现有 `PipelineReviewReportV2`，不新增数据库 Stage；
- 不修改 Continuation V4/V5；
- 不修改 Story Memory；
- 不改变 Pipeline Mode：`noReview / twoStage / conditional / full`；
- 不承诺 `low` 一定比 `high` 快固定百分比，必须以真实 usage 和耗时验收；
- 不根据模型名以外的猜测向所有 OpenAI-compatible 服务商发送非标准字段。

---

## 4. 核心设计原则

### 4.1 Thinking 与 reasoning effort 是两个独立决策

本方案明确区分：

```text
thinking = enabled
```

和：

```text
reasoning_effort = low | high | max
```

`low` 不等于关闭 Thinking。它表示模型仍执行推理，但减少不必要的推理展开。

### 4.2 终稿仍然是全章模型调用

Final Reviser 继续：

- 通读完整初稿；
- 读取完整修订义务；
- 统一处理跨段节奏、语气、伏笔和衔接；
- 输出完整终稿正文；
- 通过现有 Local Final Artifact Validator。

不得引入：

- patch/diff；
- anchor replacement envelope；
- 分段并行生成；
- 本地拼接多个模型正文。

### 4.3 先冻结策略，再执行请求

reasoning effort 属于模型请求语义。它必须像 Workflow Version、Context Budget Version、模型和 Stage max tokens 一样冻结，不能在 Resume 时读取实时设置后悄然变化。

### 4.4 历史任务 fail-closed

历史 execution snapshot 缺少 reasoning policy 字段时：

```text
不得推断为 low
不得按新默认自动切换
保持旧行为：不发送 reasoning_effort，由服务商使用历史默认
```

对 DeepSeek V4 Flash 而言，这等价于既有 `high` 行为，但实现上应保持“省略字段”，而不是擅自改写历史请求。

### 4.5 不用总 max_tokens 粗暴替代 reasoning effort

`max_tokens` 同时约束隐藏推理与可见正文。直接降低它可能造成：

```text
Thinking 耗尽预算
→ reasoning-only
→ 正文为空
```

或：

```text
Thinking 后剩余预算不足
→ 完整终稿被截断
→ finish_reason = length
```

第一阶段保持现有 `proofMaxTokens` 不变，只改变官方的 reasoning effort 档位。

---

## 5. 目标运行策略

### 5.1 第一阶段最小策略

只对满足以下全部条件的新任务启用：

```text
Outline Workflow Version = 2
AND stage = proof / Final Reviser
AND provider_type = openai_compatible
AND model_name 精确归一化后 = deepseek-v4-flash
AND reasoning policy 已冻结为 V2
```

Final Reviser 始终发送：

```json
{
  "thinking": { "type": "enabled" },
  "reasoning_effort": "low | high | max"
}
```

三档由纯函数根据已经持久化的 Revision Contract 决定，不再调用 LLM 分类：

| 档位 | 适用条件 | 目标 |
|---|---|---|
| `low` | 0–5 个有效 workItem，均为局部 anchor/insertion/boundary 修订，无 missing beat、无 hard 冲突 | 保留必要 Thinking，快速完成整章统一修订 |
| `high` | 6 个以上 workItem，或包含 range、跨段节奏调整、missing beat、明显章末目标修正 | 为跨段一致性保留更充分推理 |
| `max` | 存在 chapter scope、多个 hard constraint 冲突、全章结构重排或严重知识/时间线矛盾 | 仅用于真正需要全局重构的少数终稿 |

推荐确定性分类顺序：

```text
命中 max 条件 → max
否则命中 high 条件 → high
否则 → low
```

分类只能读取已经冻结/持久化的：

```text
Revision Contract
成功 Review / FactCheck 归一化结果
Pipeline Mode
```

不得读取运行时全局设置、当前时间、随机数或未持久化 UI 状态。

以下路径保持不变：

| 路径 | 行为 |
|---|---|
| Outline V1 | 省略 `reasoning_effort` |
| 历史冻结 Outline V2 | 省略 `reasoning_effort` |
| noReview | 没有 Proof，不发送 |
| Continuation | 不受影响 |
| 非 DeepSeek V4 Flash | 省略 `reasoning_effort` |
| 不可确认能力的自定义模型 | 省略 `reasoning_effort` |

### 5.2 推荐的冻结字段

在 `PipelineExecutionSnapshot` 增加：

```ts
export type FinalReviserReasoningPolicyVersion = 1 | 2;

interface PipelineExecutionSnapshot {
  // existing fields...
  finalReviserReasoningPolicyVersion?: FinalReviserReasoningPolicyVersion;
}
```

语义：

```text
undefined / 1
→ Legacy：不发送 reasoning_effort

2
→ DeepSeek V4 Flash Final Reviser：Thinking enabled + effort policy V2
```

新 Outline V2 execution snapshot 显式冻结：

```ts
finalReviserReasoningPolicyVersion: 2
```

历史快照缺失字段时按 1 解析。

### 5.3 Policy V2 的确定性规则

正常第一次 Proof attempt 直接使用本地复杂度分类器结果：

```text
simple contract  → low
complex contract → high
global rewrite   → max
```

网络类 safe retry：

```text
effort 保持与原 attempt 相同
```

原因：网络错误没有提供质量证据，不得改变模型语义。

终稿成功返回小说正文后，不因以下软件启发式升级或重试：

```text
终稿比初稿短
终稿与初稿改动比例小
终稿存在重复措辞或重复段落
模型没有覆盖每一个 warning workItem
模型修改幅度未达到客户端预期
章节字数没有落入建议区间
```

这些信息只记录 warning，结果仍按成功终稿交付。

只有没有正确返回可交付正文时，Proof 才失败：

```text
content 为空
只有 reasoning_content、没有正文
输出是 JSON 合同 / patch / diff / 修改说明而非小说正文
明显泄漏系统提示、修订合同或 <think>
finish_reason=length 且正文尾部有确定性未闭合技术结构
```

失败后的显式 Resume 默认保持原 complexity effort，不因质量启发式自动升级。只有错误明确属于 reasoning budget 不足，例如 reasoning-only 或确定性截断时，才允许：

```text
low → high
high → max
max → max
```

升级必须满足：

- 前一次物理请求已真实记录；
- 不自动重跑已成功 Draft / Review / FactCheck；
- 不在同一个 Provider 内部隐藏第二次 HTTP 请求；
- 新请求创建新的 `pipeline_stage_attempts` 行；
- request fingerprint 包含实际 reasoning effort；
- UI 明确显示“上一轮未正确返回正文，已提高终稿推理强度后重试”；
- 已正确返回正文的任务不得出现该升级入口。

---

## 6. Provider 接入设计

### 6.1 类型扩展

建议新增统一类型：

```ts
export type ReasoningEffort = 'low' | 'high' | 'max';
```

扩展 `LLMCallConfig`：

```ts
reasoningEffort?: ReasoningEffort;
```

扩展 `LLMGenerateOptions`：

```ts
reasoningEffort?: ReasoningEffort;
```

扩展 `LLMResult`：

```ts
reasoningTokens?: number | null;
visibleOutputTokens?: number | null;
```

扩展 `rawUsage`：

```ts
rawUsage?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
};
```

### 6.2 请求体规则

OpenAI-compatible Provider 只有在以下条件同时满足时才写字段：

```text
options.thinking?.type === 'enabled'
AND options.reasoningEffort 有效
AND capability resolver 确认支持
```

请求体：

```ts
requestBody.thinking = { type: 'enabled' };
requestBody.reasoning_effort = options.reasoningEffort;
```

禁止组合：

```json
{
  "thinking": { "type": "disabled" },
  "reasoning_effort": "low"
}
```

当 Thinking disabled 时必须省略 `reasoning_effort`。

### 6.3 Capability Resolver

第一轮只对明确能力集启用：

```ts
supportsReasoningEffort({ providerType, modelName, baseUrl })
```

建议规则：

```text
provider_type = openai_compatible
model_name normalized = deepseek-v4-flash
base_url host = api.deepseek.com
→ true

其他
→ false
```

不得仅因为模型名中包含 `deepseek` 就向任意第三方网关发送扩展字段。

若未来需要支持兼容网关，应增加显式 capability 配置或经过独立连接测试确认，不能静默猜测。

### 6.4 不允许 Provider 内部静默降级

若服务端返回明确的 `reasoning_effort unsupported/unknown parameter`：

- 当前物理请求必须记录失败；
- 不得在 Provider 内部直接删除参数并偷偷再发一次；
- 错误映射为可识别的 capability/config error；
- Pipeline 决定是否显式创建兼容降级 attempt；
- 正式默认启用前，官方 DeepSeek 端点必须通过连接与真机验证。

这样可保持“一次 HTTP = 一行 attempt”的计费与审计语义。

---

## 7. Final Reviser 接入设计

### 7.1 请求编译器保持不变

以下内容第一阶段不得修改：

- `compileFinalReviserStageRequest()`；
- `buildFinalReviserMessages()`；
- Revision Contract JSON；
- Canonical Draft；
- Proof Context Budget；
- `proofMaxTokens`。

原因：本轮只验证 reasoning effort 的单变量效果，不能同时改 Prompt、上下文和输出协议，否则无法归因。

Local Final Artifact Validator 只调整“阻断/告警”分级，不改变终稿文本、Prompt 或模型请求，因此可以与本轮一起施工；其目的不是提高模型质量，而是避免已经正确返回的终稿因软件启发式被拒绝后再次消耗 API 时间和 Token。

### 7.2 调用配置

`runFinalReviserV2Stage()` 构建调用配置时增加：

```ts
const reasoning = resolveFinalReviserReasoning({
  execution: runtime.parsed.execution,
  model: runtime.requestConfig,
  previousAttempts,
  previousCheckpoint,
});
```

返回：

```ts
{
  thinking: { type: 'enabled' },
  reasoningEffort: 'low'
}
```

Legacy 返回：

```ts
{}
```

不得返回：

```ts
{ reasoningEffort: 'high' }
```

来模拟历史行为。历史行为应继续省略字段，避免网关默认语义发生变化时篡改已冻结任务。

### 7.3 Fingerprint 与冻结请求

当前非 Draft stage fingerprint 主要包含：

```text
stage
messages
maxTokens
contextWindow
```

接入 reasoning effort 后必须增加：

```text
thinking.type
reasoning_effort
reasoning policy version
```

建议 fingerprint 输入：

```ts
{
  stage,
  messages,
  maxTokens,
  contextWindow,
  thinking,
  reasoningEffort,
  reasoningPolicyVersion,
}
```

否则 `low` 与 `high` 请求可能产生相同 fingerprint，破坏 attempt 审计和 Resume 判断。

Proof attempt 的 `frozen_request_json` 至少应记录非敏感请求元数据：

```json
{
  "requestVersion": 2,
  "reasoningPolicyVersion": 2,
  "thinking": "enabled",
  "reasoningEffort": "low",
  "messagesHash": "...",
  "maxTokens": 40000,
  "contextWindow": 1000000
}
```

禁止写入：

- 完整正文；
- 完整 Prompt；
- API Key；
- reasoning_content；
- Revision Contract 原文。

### 7.4 Final Artifact Gate 收敛

终稿门禁的职责调整为：

> 只判断 Provider 是否返回了可作为小说正文交付的文本，不再评价模型是否“改得足够多”或文学质量是否达到某个启发式阈值。

#### Hard Fail：仅保留确定性技术错误

```text
正文为空
仅有 reasoning_content、没有 content
正文含明确 <think> 推理泄漏
正文是完整 Revision Contract / Audit JSON，而不是小说
正文是 patch/diff/“其余内容不变”等非完整交付形式
正文大段复述系统提示或用户 Prompt
正文含客户端 anchor 协议标记并明显属于协议泄漏
finish_reason=length 且尾部存在未闭合 JSON/Markdown/代码块等确定性技术截断
```

#### Warning：不得阻断交付

```text
终稿比初稿短
终稿与初稿几乎一致
终稿修改比例过低或过高
存在重复段落或重复措辞
章节字数偏离目标区间
finish_reason=length 但正文仍是完整自然语言章节
未执行某条 warning 修订项
文学节奏、情绪、文风等主观质量疑虑
```

现有 `whole_paragraph_duplicate` 与 `catastrophic_collapse` 从 Hard Fail 降为 warning。长度坍缩、重复和改动幅度可以用于结果页提示和 A/B 统计，但不得触发 Draft fallback 或额外 Final Reviser 请求。

#### 成功定义

满足以下全部条件即成功：

```text
content.trim() 非空
内容形态是小说正文
没有确定性协议/推理/Prompt 泄漏
没有确定性技术截断
```

成功后：

- Proof checkpoint 保存模型返回的完整正文；
- Pipeline 完成；
- warning 随结果保存并展示；
- 不自动重试；
- 不因为 effort=low 而使用更严格门禁；
- `low / high / max` 三档门禁完全一致。

### 7.5 Review V2 宽容解析与归一化

当前 Review V2 validator 对以下结构执行整体 Hard Fail：

```text
未知顶层字段
schemaVersion 缺失或不等于 2
draftHash 缺失或不完全匹配
requiredCorrections 缺失
protectedAnchorIds 非法
outlineExecution 缺失
outlineExecution 出现未知字段
任一 correction 缺 id/dimension/diagnosis/rewriteGoal
scope 与定位字段不完全匹配
任一可选 anchor 不存在
```

这对协议审计很严格，但对文学评估过于脆弱。模型已经返回可理解的评价时，整体失败和一次 LLM format repair 会同时浪费时间、Token 和有效意见。

目标解析链改为：

```text
1. 提取 content
2. 移除 Markdown JSON fence
3. 提取第一个平衡 JSON 对象
4. JSON.parse
5. 宽容字段映射
6. 逐项保留可用 correction
7. 缺失字段本地确定性补全
8. 归一化为现有 PipelineReviewReportV2
9. 只有完全不可恢复时才失败
```

#### 顶层字段归一化

| 模型输出 | 本地处理 |
|---|---|
| `schemaVersion` 缺失/错误 | 写入客户端 `2`，记录 warning |
| `draftHash` 缺失 | 写入当前请求的 expectedHash |
| `draftHash` 不匹配 | 若没有 Draft echo/正文替换迹象，改写为 expectedHash 并 warning；存在错稿证据才失败 |
| `requiredCorrections` 缺失 | 默认 `[]` |
| `protectedAnchorIds` 缺失 | 默认 `[]` |
| `outlineExecution` 缺失 | 创建全空结构 |
| 未知字段 | 忽略并 warning，不整体失败 |

#### Correction 归一化

| 缺陷 | 本地处理 |
|---|---|
| `id` 缺失 | 按原顺序生成 `review-normalized-001` |
| `dimension` 缺失 | 默认 `literary` |
| `severity` 缺失/非法 | 默认 `warning`；明确“必须/错误/冲突”语义可映射 `required` |
| `diagnosis` 缺失但有 `rewriteGoal` | 使用 rewriteGoal 作为简要 diagnosis |
| `rewriteGoal` 缺失但有 diagnosis | 生成固定目标“根据该评估修订对应内容” |
| `preserveMeaning` 缺失 | 默认 `[]` |
| scope 缺失但 anchorId 合法 | 推断 `anchor` |
| scope 缺失且没有 locator | 推断 `chapter` |
| 非法可选 anchor | 删除 locator；warning 项降为 chapter scope |
| 单个 correction 完全为空 | 丢弃该项，不影响其他项 |

本地补全必须是确定性模板，不得用规则引擎创作新的文学判断。

#### 非 JSON 文学评估兜底

若 content 不是 JSON，但满足：

```text
非空
不是 Draft 全文回显
不是连续小说正文
不是 Prompt/reasoning 泄漏
具有明显评估/建议文本形态
```

则不再发送一次格式修复请求，而是归一化成一条 chapter-scope 文学修订意见：

```ts
{
  id: 'review-narrative-fallback-001',
  scope: 'chapter',
  dimension: 'literary',
  severity: 'warning',
  diagnosis: normalizedReviewText,
  rewriteGoal: '结合该文学评估统一修订本章，同时保持既有事实与大纲边界。',
  preserveMeaning: [],
}
```

`normalizedReviewText` 必须有字符上限、移除 Prompt 标记并禁止包含完整 Draft。

#### 仍然 Hard Fail 的 Review 输出

```text
content 为空
reasoning-only
完整 Draft/小说正文回显
明显 Prompt 或 <think> 泄漏
截断到无法提取任何完整评价
既无法解析 JSON，也不具备文学评估文本形态
```

#### Format Repair 调整

默认 V2 Review 路径取消自动 LLM format repair：

```text
可本地归一化 → 直接成功
不可本地归一化 → Review 失败，沿用现有降级语义
```

不得为了补齐 `schemaVersion`、`draftHash`、空数组、optional outline 字段或 correction id 再调用一次 LLM。

FactCheck 涉及硬事实与知识边界，本轮暂时保持严格 validator；如后续放宽，必须单独设计，不能直接复用文学 Review 的 narrative fallback。

---

## 8. Reasoning Token 可观测性

### 8.1 解析规则

Provider 从官方 usage 读取：

```ts
const reasoningTokens = Number(
  usage.completion_tokens_details?.reasoning_tokens,
);
```

只有非负有限数才接受，否则记为 `null`。

可见输出 Token：

```ts
visibleOutputTokens =
  reasoningTokens != null
    ? Math.max(0, outputTokens - reasoningTokens)
    : null;
```

不得使用字符估算冒充官方 reasoning Token。

### 8.2 持久化建议

为 `pipeline_stage_attempts` 增加 nullable 列：

```sql
reasoning_tokens INTEGER
```

可见输出 Token 可由：

```text
output_tokens - reasoning_tokens
```

派生，不必新增第二列。

若实施该列，Schema 必须从 44 升级到 45，并同步修改：

- `createCurrentSchema.ts`；
- 新增 `v44-to-v45.ts`；
- `migrations/index.ts`；
- `schemaManifest.ts`；
- repository row mapping；
- migration fixtures；
- drift / startup / backup 回归。

迁移要求：

```sql
ALTER TABLE pipeline_stage_attempts
ADD COLUMN reasoning_tokens INTEGER;
```

必须做幂等列检查，不能假定物理列一定与 recorded schema 一致。

如第一轮仅做开发 A/B、尚不准备提升 Schema，可先在测试 harness 中从 `LLMResult.rawUsage` 输出非正文 JSON 证据；但正式默认启用前必须完成持久化，否则无法在真实设备上验证收益与回归。

### 8.3 允许记录

```text
task hash / task id
stage
request version
reasoning policy version
reasoning effort
input tokens
reasoning tokens
visible output tokens
total output tokens
duration
finish reason
validator code
```

禁止记录：

```text
reasoning_content 原文
小说正文
完整 Prompt
API Key
角色卡 / 世界书 / Notes 原文
```

---

## 9. 兼容、恢复与回滚

### 9.1 历史冻结任务

```text
execution.finalReviserReasoningPolicyVersion 缺失
→ Legacy
→ 不发送 reasoning_effort
```

升级前已完成 Draft/Review、Proof 尚未执行的任务仍按旧请求语义恢复。

### 9.2 新 V2 任务

```text
execution.finalReviserReasoningPolicyVersion = 2
→ Final Reviser Thinking enabled
→ first attempt effort = low
```

Resume 不读取实时默认值。

### 9.3 Batch

Batch 不新增自己的 Final Reviser 实现，继续委托单章 Pipeline。

同一批次必须冻结一致的 reasoning policy version。建议在批次 execution/version snapshot 中复制：

```text
final_reviser_reasoning_policy_version
```

如果坚持第一轮无 Schema 迁移，至少在创建每个子任务时从批次内存冻结值复制到 task execution snapshot，禁止运行中读取当前全局默认。

本轮已在 Schema 46 为 `multi_chapter_batches` 增加可空 `reasoning_effort` 快照列；新批次显式写入产品档位，历史批次保持 NULL，子任务首次执行时继承批次值。

### 9.4 热回滚

提供代码级默认：

```ts
CURRENT_FINAL_REVISER_REASONING_POLICY_VERSION: 1 | 2 = 2;
```

回滚为 1 后：

- 未来新任务恢复 Legacy；
- 已冻结 policy 2 的任务继续 low 语义；
- 不修改历史行；
- 不删除 Schema 列；
- 不在 Resume 中强制覆盖。

如果线上发现明显质量问题，应先停止给新任务冻结 V2 policy，而不是把正在恢复的任务中途改成 `high`。

---

## 10. 代码影响面

### 10.1 必改文件

| 文件 | 修改 |
|---|---|
| `src/services/llm.ts` | `LLMCallConfig` 增加 `reasoningEffort` 并透传 |
| `src/services/llm/types.ts` | 新增 `ReasoningEffort`、扩展 options/result/rawUsage |
| `src/services/llm/openAICompatibleProvider.ts` | capability gate、请求体字段、usage reasoning tokens 解析 |
| `src/types/pipelineExecution.ts` | 增加 frozen reasoning policy version |
| `src/services/pipelineTaskContext.ts` | serialize/parse/legacy fallback |
| `src/services/pipeline/reconcile.ts` | Final Reviser effort 解析、attempt 元数据、fingerprint；Review 移除默认 format repair |
| `src/services/pipeline/finalArtifactValidator.ts` | Hard Fail 收敛为技术交付错误，其余降为 warning |
| `src/services/pipeline/revisionAuditValidator.ts` | Review 宽容解析、逐项归一化、narrative fallback |
| `src/data/repositories/pipelineStageAttemptRepository.ts` | reasoning tokens 映射与更新 |

### 10.2 若提升 Schema

| 文件 | 修改 |
|---|---|
| `src/data/schema/createCurrentSchema.ts` | attempts 新列 |
| `src/services/migrations/v44-to-v45.ts` | 幂等迁移 |
| `src/services/migrations/index.ts` | Schema 45/46 注册 |
| `src/services/database/schemaManifest.ts` | attempts 与 batch 快照新列 |
| `scripts/generate-migration-fixtures.py` | fixture 链更新 |
| 相关 migration/drift/backup 测试 | Schema 44→45→46 验收 |

### 10.3 原则上不改

```text
src/services/pipeline/compileStageRequest.ts
src/services/pipelineMessages.ts
src/services/pipeline/revisionContract.ts
src/services/continuation/**
src/services/storyMemory/**
src/services/contextBuilder.ts
```

如果实施过程中必须修改上述 Prompt/Contract 文件，应停止当前施工并拆分为另一项优化，避免 A/B 无法归因。

---

## 11. 分阶段施工计划

### Phase 0：基线冻结

- 保存至少 10–20 个真实 Outline V2 Proof 样本；
- 记录当前默认 high 的 input/output/total/duration/final chars；
- 保存 validator 结果、finish reason、采用情况；
- 不记录正文和 reasoning 原文；
- 锁定当前 Prompt fingerprint。

### Phase 1：Provider 能力接入，行为不变

- 增加 `ReasoningEffort` 类型；
- Provider 支持请求体 `reasoning_effort`；
- 解析 `reasoning_tokens`；
- 所有生产调用暂不传该字段；
- 回归确认请求字节与当前版本一致。

### Phase 2：冻结策略与 V2 Final Reviser 接入

- 新 snapshot 冻结 reasoning policy version；
- 历史缺失字段走 Legacy；
- 仅 DeepSeek V4 Flash 官方端点的 V2 Proof 使用本地 `low/high/max` 分类；
- fingerprint 和非敏感 frozen request metadata 纳入 effort；
- 不实现自动 high retry；
- 不改变其他 Stage。

### Phase 2A：终稿门禁收敛

- Hard Fail 只保留空正文、reasoning-only、协议/Prompt 泄漏、非正文输出和确定性技术截断；
- 重复、坍缩、长度比例、改动幅度全部降为 warning；
- 正确返回正文后无论 effort 档位均直接完成；
- warning 不触发自动重试或 Draft fallback；
- 锁定 `low/high/max` 三档完全相同的交付门禁。

### Phase 2B：Review 宽容归一化

- 保留现有严格解析作为 fast path；
- strict 失败后进入 tolerant normalization；
- 缺省 optional 字段由客户端补全；
- correction 逐项保留，不因单项非法整体失败；
- 非 JSON 文学意见转换为单条 chapter-scope warning；
- 移除默认一次性 LLM format repair；
- FactCheck 暂不放宽。

### Phase 3：真实 A/B

- 同一冻结 Prompt 分别运行 high 与 low；
- 调用顺序随机化，避免服务端时段偏差；
- 使用相同 model、temperature、top_p、max_tokens；
- 每个样本只改变 reasoning effort；
- 同时统计 Review 本地归一化率、narrative fallback 率和节省的 format repair 请求数；
- Final Gate 分别统计 hard fail 与 warning，warning 不计作失败；
- 人工盲评时隐藏档位和耗时。

### Phase 4：显式恢复升级

- 仅在终稿没有正确返回正文且用户显式 Resume 时提高一个 effort 档位；
- 已正确返回正文但带 warning 时不得升级或重试；
- 网络 safe retry 保持原 effort；
- 每个 HTTP 请求独立 attempt；
- UI 展示“提高推理强度后重试”；
- 不重跑成功上游 Stage。

### Phase 5：默认启用与观察

- 新 Outline V2 任务默认冻结 policy 2；
- 先灰度开发/内部构建，再进入正式构建；
- 连续观察 p50/p95、reasoning tokens、validator 通过率和用户采用率；
- 达到停止条件立即回滚新任务默认。

---

## 12. A/B 设计与验收指标

### 12.1 样本分层

至少覆盖：

| 维度 | 样本 |
|---|---|
| 章节长度 | 短 / 中 / 长 |
| Pipeline Mode | twoStage / conditional / full |
| 修订项 | 0–2 / 3–5 / 6+ |
| 修订范围 | 局部语言 / 跨段节奏 / 全章边界 |
| 事实复杂度 | 低 / 高 |
| 前章衔接 | 普通 / 强连续动作 |

### 12.2 主性能指标

```text
Proof duration p50
Proof duration p95
reasoning tokens p50/p95
visible output tokens
completion tokens
time to first visible content（若后续启用 streaming）
```

### 12.3 质量与安全指标

```text
Local Final Validator pass rate
Final Gate hard-fail rate
Final Gate warning rate（不阻断）
finish_reason = length rate
reasoning-only / empty response rate
Review strict-parse success rate
Review tolerant-normalization success rate
Review narrative-fallback rate
Review format-repair request count
终稿完整性
大纲节点遗漏率
事实错误率
前后章衔接错误率
相对 Draft 的异常坍缩率
直接采用 / 小改 / 放弃比例
人工盲评得分
```

### 12.4 建议验收门槛

性能：

- low 相比 high 的 Proof p50 至少下降 25%；
- p95 不劣于 high，目标下降至少 15%；
- reasoning tokens p50 至少下降 30%；
- Review 自动 format-repair 请求数下降到 0；
- 可恢复文学评估不得再出现“返回格式无效，结构不符合要求”失败；
- input tokens 与 visible output 目标长度保持同一量级，不允许通过缩短正文伪造加速。

稳定性：

- `length` / reasoning-only / empty rate 不高于 high 基线 + 2 个百分点；
- 正确返回小说正文的 Final Gate 通过率应接近 100%；
- `whole_paragraph_duplicate`、`catastrophic_collapse` 等 warning 不得计入失败率；
- Review 本地归一化后的报告必须能够稳定编译 Revision Contract；
- 不新增 outcome_unknown 或重复计费缺陷。

质量：

- 盲评平均分不低于 high 基线的非劣界限；
- 硬事实错误不得增加；
- 大纲边界与前后章衔接不得出现系统性退化；
- 用户直接采用率不应显著下降。

任何性能收益若主要来自终稿明显变短，均判定失败。

### 12.5 停止条件

出现以下任一情况，停止默认启用：

1. reasoning-only 明显上升；
2. 完整终稿出现确定性技术截断；
3. 硬事实错误增加；
4. 前后章衔接明显退化；
5. 官方端点拒绝或忽略 effort 字段；
6. 第三方网关被误发送不支持参数；
7. 历史 task Resume 请求语义改变；
8. low/high fingerprint 相同；
9. reasoning Token 无法可靠观测；
10. Review 宽容解析把完整小说正文误当成文学评估；
11. Final Gate 把 JSON/patch/Prompt 泄漏误当成终稿；
12. 全量 `npm run verify` 未通过。

---

## 13. 必测矩阵

### 13.1 Provider

- DeepSeek V4 Flash + enabled + low：发送两个字段；
- DeepSeek V4 Flash + enabled + high/max：发送正确值；
- disabled + 任意 effort：省略 effort；
- DeepSeek V4 Pro：第一轮不启用自动策略；
- 非 DeepSeek 模型：省略 effort；
- 非官方 gateway：省略 effort；
- reasoning token details 缺失：返回 null，不猜测；
- reasoning token 非法/负数：返回 null；
- visible output token 不得为负数。

### 13.2 Snapshot 与 Resume

- 新 V2 snapshot round-trip 保留 policy 2；
- 历史 snapshot 缺字段按 Legacy；
- 非法 policy version fail-closed；
- Resume 不读取当前默认；
- low Proof failed 后只重跑 Proof；
- network retry 保持 low；
- 显式技术失败 Resume 升级 high（Phase 4）；
- old V1/V2 Proof-only Resume 请求 fingerprint 不变。

### 13.3 Pipeline Mode

- noReview：无 Proof 请求；
- twoStage：Final Reviser low；
- conditional：Final Reviser low；
- full：Review/FactCheck 并行保持，Final Reviser low；
- 双审核失败：不调用 Proof；
- 单审核降级：仍可生成 Contract，effort 策略不变。

### 13.4 Final Gate

- 空 content：失败；
- reasoning-only：失败；
- JSON Contract / patch / diff：失败；
- `<think>` / Prompt / anchor 协议泄漏：失败；
- 明确未闭合技术结构：失败；
- 完整短章：成功；
- 相对 Draft 明显缩短：成功 + warning；
- 正文与 Draft 基本一致：成功 + warning；
- 大段重复：成功 + warning；
- `finishReason=length` 但自然语言正文完整：成功 + warning；
- 三种 effort 对相同正文得到完全相同的门禁结果；
- warning 不创建额外 attempt、不触发 fallback。

### 13.5 Review 宽容解析

- 标准 V2 JSON：strict fast path 成功；
- Markdown fenced JSON：本地提取成功；
- 顶层前后有解释文字：平衡对象提取成功；
- 缺 `schemaVersion`：补 2；
- 缺 `draftHash`：补 expectedHash；
- 缺 `outlineExecution`：补空结构；
- 缺 `protectedAnchorIds`：补空数组；
- correction 缺 id/dimension/preserveMeaning：确定性补全；
- 单个非法 correction：丢弃或降级，不影响其他有效项；
- 非 JSON 文学意见：生成 chapter-scope narrative fallback；
- 完整 Draft 回显：失败，不进入 fallback；
- 连续小说正文：失败，不进入 fallback；
- reasoning-only：失败；
- tolerant 成功后不调用 format repair；
- normalized JSON byte-stable，Resume 重建一致；
- normalized result 可被 `compileRevisionContract()` 接受。

### 13.6 Attempt 与计费

- effort 写入 fingerprint；
- effort 写入非敏感 frozen request metadata；
- reasoning tokens 写入 attempt；
- total/output/input 与 Provider usage 对齐；
- capability 错误不被吞成一次 attempt 内的隐藏重发；
- high explicit retry 新增独立 attempt；
- Batch usage 聚合仍以真实 attempt 为准。

### 13.7 Schema（如实施）

- 44→45 空库迁移；
- 44→45 用户数据保留；
- 迁移幂等重跑；
- recorded 45 但物理缺列的 drift 检测；
- manifest 对齐；
- backup/restore 对 nullable 新列兼容；
- 升级前后小说正文与业务表指纹一致。

---

## 14. 验证命令

实现后至少运行：

```bash
npm run lint
npm run typecheck
npm run test:ci
npm run verify
```

建议新增并单独运行：

```bash
npx jest __tests__/deepSeekReasoningEffortProvider.test.ts --runInBand
npx jest __tests__/pipelineFinalReviserReasoningPolicy.test.ts --runInBand
npx jest __tests__/pipelineReasoningUsage.test.ts --runInBand
npx jest __tests__/pipelineFinalArtifactValidator.test.ts --runInBand
npx jest __tests__/pipelineReviewTolerantNormalization.test.ts --runInBand
npx jest __tests__/pipelineRevisionAuditValidator.test.ts --runInBand
npx jest __tests__/pipelineWorkflowVersionPersistence.test.ts --runInBand
npx jest __tests__/pipelineWorkflowV2Integration.test.ts --runInBand
npx jest __tests__/f301BatchResumeFrozenContext.test.ts --runInBand
npx jest __tests__/pipelineRunner.test.ts --runInBand
```

若升级 Schema：

```bash
npx jest __tests__/migrations-v44-v45.test.ts --runInBand
npx jest __tests__/migrations-schema40-to-45-chain.test.ts --runInBand
npx jest __tests__/schema45-drift-matrix.test.ts --runInBand
```

真机验收必须使用：

```text
deepseek-v4-flash
thinking = enabled
reasoning_effort = low
同一冻结 Prompt 的 high 对照
```

验收证据写入 `test-logs/`，不得污染仓库根目录。

---

## 15. 风险与缓解

### P0：历史 Resume 被切换为 low

缓解：snapshot 缺 policy 字段一律 Legacy；不得读取当前默认补写。

### P0：reasoning effort 未进入 fingerprint

缓解：fingerprint 显式包含 thinking/effort/policy version；增加 low/high 不同 hash 回归。

### P0：推理档位不足导致 reasoning-only 或截断

缓解：不降低 `proofMaxTokens`；只在没有正确返回正文时失败；显式 Resume 可提高一个档位。

### P0：第三方网关不支持参数

缓解：第一轮只对白名单官方 DeepSeek host 启用；不按模型名泛化。

### P1：服务端忽略 reasoning_effort

缓解：必须读取 reasoning tokens 做 high/low 对照；若分布没有可验证变化，不默认启用。

### P1：质量下降但技术门禁通过

缓解：这是产品质量观测问题，不应由单次软件启发式阻断交付；通过匹配样本盲评、采用率和事实错误率决定是否继续默认启用某个 effort 档位。

### P1：Review 宽容解析误收正文

缓解：保留 Draft echo、连续小说正文、Prompt 泄漏和 reasoning-only 的硬拒绝；narrative fallback 只接受明显评价/建议文本，并设置长度与内容形态上限。

### P1：Review 本地补全改变模型原意

缓解：只补协议字段和固定默认，不生成新的文学观点；无法确定定位时降为 chapter-scope warning，不提升为 required/hard。

### P1：Schema 扩大最小改动面

缓解：Provider 透传与 Schema observability 分提交；先完成行为不变接入，再单独迁移。

### P2：UI 无法解释档位

缓解：第一轮不开放普通设置项；结果诊断页只显示“Thinking：开启 / 推理强度：低（自动）”。

---

## 16. 提交拆分建议

建议至少拆为四个提交：

```text
1. feat(llm): support DeepSeek reasoning_effort without behavior change
2. feat(pipeline): freeze Final Reviser reasoning policy for new V2 tasks
3. fix(pipeline): accept technically valid Final Reviser bodies with warnings
4. fix(pipeline): normalize recoverable V2 literary review outputs locally
5. feat(metrics): persist per-attempt reasoning token usage
6. feat(pipeline): enable adaptive low/high/max Final Reviser effort
```

显式 Resume 升级 high 单独提交：

```text
7. feat(pipeline): escalate Final Reviser effort on explicit technical retry
```

不得将 Prompt 改写、Context Budget 调整或 Revision Contract 重构混入这些提交。

---

## 17. 最终施工建议

本轮最小可验证闭环应为：

```text
Provider 支持 reasoning_effort
→ 新 Outline V2 snapshot 冻结 policy 2
→ DeepSeek V4 Flash Final Reviser 按合同复杂度发送 thinking=enabled + effort=low/high/max
→ 完整初稿输入保持
→ 完整终稿输出保持
→ proofMaxTokens 保持
→ Final Gate 只拦截非正文/泄漏/确定性技术截断
→ 重复、坍缩、改动幅度等启发式只告警
→ Review 可恢复结构由本地归一化，不再自动请求 format repair
→ 记录 reasoning tokens
→ 与同 Prompt high 做真实 A/B
```

该方案针对的是已经被设备数据证明的真实瓶颈：Final Reviser 的隐藏 completion Token，而不是继续削减已经收敛的输入上下文。

若 A/B 证明自适应 effort 显著降低 reasoning Token 与耗时，并且完整性、事实、大纲边界、衔接和人工质量均不退化，再将 policy 2 设为未来新 V2 任务默认。Review 宽容归一化必须单独证明减少格式失败且没有误收小说正文。若收益不明显，应停止该方向，而不是继续降低总 `max_tokens`、收紧软件门禁或关闭 Thinking。

---

## 18. 补充修订：流水线级三档思考强度与预算联动

在原方案基础上，产品配置页增加 V2 流水线级思考强度选择：

| 产品档位 | 冻结值 | 作用节点 | 预算策略 |
|---|---|---|---|
| 快速 | `low` | Draft / Review / FactCheck / Proof | 四阶段输出预留按低档缩放，优先响应速度 |
| 平衡 | `medium` | Draft / Review / FactCheck / Proof | 使用基准输出预留 |
| 质量 | `high` | Draft / Review / FactCheck / Proof | 四阶段输出预留扩大，可从可选上下文弹性借用预算 |

该选择属于请求语义，必须随 `PipelineExecutionSnapshot` 冻结；Resume、冷启动恢复、批量写章子任务不得重新读取当前设置。四个 V2 节点都使用同一冻结值，Review / FactCheck 不再默认关闭 Thinking。历史快照缺少该字段时保持历史行为并省略厂商扩展字段。

预算联动采用“输出预留先调整、可选上下文再让渡”的顺序：低/中/高档输出预留分别使用 `0.85 / 1.0 / 1.45` 倍基准，所有阶段仍经过 V2 弹性上下文编译器的 soft / burst / hard 水位检查；必需大纲、协议和正文不裁剪，只有可选资料、记忆与检索上下文参与让渡。批次硬预算以编译后的 `reservedOutputTokens` 记账，避免 UI 切档后预算闸门仍按旧值放行。

周边适配包括：设置持久化与旧设置默认值、任务快照/Resume/批量继承（Schema 46 批次快照）、上下文自动配置与 LLM 上下文同步时保留用户档位、请求 fingerprint 与 frozen request metadata、四阶段 attempt 的 reasoning token 观测、结果页软告警展示、非官方网关能力降级、Schema 45/46 迁移与模拟器升级安装验收。

官方 DeepSeek V4 当前接口的有效显式强度为 `high/max`；`low/medium` 属兼容值，会由服务端映射到 `high`。因此产品层仍保留快速/平衡/质量三档，并原样记录和发送 `low/medium/high`，同时在 UI 说明该官方兼容行为，避免将产品档位误解为服务端一定存在三种独立物理推理深度。
