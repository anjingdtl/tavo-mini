# ShineWriter V2.11.41 `reasoning_only` 与 Primary Retry 根因专项调查

调查日期：2026-08-10

调查范围：V2.11.41 Budget V5 真实 LLM 穿测中的两个指定事件

事实基线：仅使用本地仓库 `E:\AiWorkSpace\tavo-mini`、仓库内日志/数据库/报告与当前源码

调查原则：只读取证；未修改生产代码；未使用外部资料补齐本地证据

## 1. 结论先行

### 1.1 事件 B 的 attempt 2 身份已经钉死

**Batch ordinal 3 / chapterId 15 / FactCheck 的 attempt 2 是 A：`pipeline_factcheck_formatter`（Contract Formatter，Thinking disabled），不是完整 FactCheck Primary retry。**

证据链不是“看到 attempt 2 就猜 Formatter”，而是：

1. `batch-logcat-final.txt:4378` 记录 attempt 1：`valid=false`、`emptyReason=reasoning_only`、`reasoningLength=453`、`finishReason=stop`。
2. V33 `runV3AuditStage()` 对该状态计算出的 `formatterEligible` 必然为 `true`：有非空 `reasoningText`、不是 `content_filter`、当前尚未执行 Formatter，也不是无可恢复候选的冷启动，见 `src/services/pipeline/reconcile.ts:3632-3675`。
3. 紧随其后的 `attempt=2` 审计日志只在 `runAuditFormatter()` 返回后产生，见 `src/services/pipeline/reconcile.ts:3685-3689、3727-3735`。该调用的 scenario 被写死为 `pipeline_factcheck_formatter`，见 `:3540-3554`。
4. Formatter 的请求语义被写死为 `thinking: disabled`、无 `reasoning_effort`，并持久化 `formatterUsed: true`、`allocationTraceJson={"formatter":true}`、`frozenRequestJson.formatter=true`，见 `:3514-3539`。
5. `runStageAttempt()` 为每次物理请求递增 stage attempt 编号。因此 Formatter 也是 `attemptNo=2`；attempt 编号本身不是调用角色，见 `src/services/pipeline/reconcile.ts:361-378`。
6. `batch-logcat-final.txt:4429` 的 attempt 2 具有 `reasoningLength=0`、`outputTokens=39`、`textLength=116`，与 Thinking-disabled 的短格式化调用完全相符。
7. 当前 V33 同一 checkpoint 内没有“Formatter 之前重跑完整 Primary”的分支。注释还明确规定不能静默重放完整 audit request，见 `src/services/pipeline/reconcile.ts:3561-3566`。

因此，旧详细审计和 CSV 中“Formatter 0 次、完整 Primary retry 1 次”的分类是错误的。正确分类为：

| 项目 | 旧审计 | 本次纠正 |
|---|---:|---:|
| Contract Formatter | 0 | **1** |
| 完整 Primary retry | 1 | **0** |
| Batch 物理调用 | 16 | 16（15 个主阶段 Primary + 1 个 Formatter） |

### 1.2 `reasoning_only` 的根因不是 Budget V5 token 不足

两个事件均为 `finishReason=stop`，且日志均记录 `reasoningBudgetExhausted=false`。当前代码只在 `reasoning_only && finishReason=length` 时认定 reasoning budget exhausted，见 `src/services/pipeline/reconcile.ts:1132-1146`。

本次能观察到的最底层原因是：**DeepSeek 在 Thinking enabled + JSON mode 的请求中，把响应放在 `message.reasoning_content`，同时没有提供非空 `message.content`；`finish_reason=stop` 只表示生成正常结束，并不保证业务 content 通道非空。**

本地证据无法解释 DeepSeek 服务内部为什么选择该通道，因此不能把“模型内部路由算法”写成已证实根因。但真实响应已经证实：`stop`、`response_format=json_object`、甚至 Prompt 明确要求写入 `message.content`，都不能在当前接口上形成 content 通道的硬保证。

### 1.3 两个事件是同一 Provider 现象、两种恢复结果

- 事件 A：reasoning 通道包含可提取、可解析、可通过 Brief V33 Validator 的 JSON；StructuredCandidate 在本地直接采用，**没有额外调用**。
- 事件 B attempt 1：reasoning 通道非空，但没有可由 StructuredCandidate 提取为“完整、可解析、对象根”的 JSON；因此无法本地 salvage，进入一次 bounded Contract Formatter；Formatter 成功，**增加一次物理调用，但不是完整 Primary retry**。

### 1.4 诊断语义存在两个明确缺陷

1. `emptyReason=reasoning_only` 描述的是 Provider 原始业务 content 通道为空；`valid=true` 描述的是 StructuredCandidate/Validator 的最终业务结果。两者可以同时为真，但当前单行日志没有 `candidateChannel`、`adoptionMode`，表面上像自相矛盾。
2. `visibleOutputTokens = completion_tokens - reasoning_tokens` 只是 Provider usage 的算术差值，不是 `message.content` 的实际 token 数。事件 B 已直接反证：`visibleOutputTokens=1496`，但 `textLength=0`。当前命名会误导审计和 UI。

## 2. 仓库与证据基线

### 2.1 Git 基线

调查开始与报告生成前均确认：

```text
branch: main
HEAD:        78f8c6ed531b4c22b498ec940436ceb63dd2162c
origin/main: 78f8c6ed531b4c22b498ec940436ceb63dd2162c
merge-base:  78f8c6ed531b4c22b498ec940436ceb63dd2162c
```

工作区原有 Story Memory 相关 modified/untracked 文件，以及本轮输入的两份审计文件；本次调查未覆盖、回滚或修改这些文件。

真实穿测报告说明：穿测使用与 V2.11.41 相同源码的 V2.11.40 正式签名 APK，随后升版并构建 V2.11.41；三次单章均使用设备真实 DeepSeek 配置，无 mock/fallback，见 `docs/optimization/ShineWriter_大纲流水线BudgetV5定向修复真实LLM测试报告-20260810.md:5、26`。

从穿测前实现基线 `c2f51a1` 到当前 `HEAD`，Provider、Reasoning Policy、StructuredCandidate、Validator、Formatter 与 attempt persistence 没有行为性差异；相关差异集中在 Budget V5 reservation/contextBudgetVersion 接入。故当前执行路径可用于还原这两个事件。

### 2.2 直接证据

| 证据 | 可证明内容 | 限制 |
|---|---|---|
| `test-logs/outline-budget-v5-qa-20260810/batch-logcat-final.txt:691` | 事件 A 的原始通道长度、usage、finishReason、emptyReason、Validator 结果 | 不含原始响应正文、scenario、candidateChannel |
| 同文件 `:4378、4429` | 事件 B 两次调用的时间顺序、通道长度、usage 与 valid | `attempt=2` 未打印调用角色 |
| `batch-planning.xml` | Batch 冻结档位为“平衡” | XML 为单行，未含 wire request |
| `batch-complete.xml` | Batch 成功 3/3、总调用 16 | 未区分 Primary/Formatter |
| 当前 V33 源码 | 从 observed state 唯一还原控制流与请求语义 | 不能还原 Provider 内部实现或已被清理的 raw body |
| 本地 SQLite 全量只读扫描 | 当前保存的 DB 不含两个目标 taskId，也没有 outputTokens=66/1774 的目标 usage 行 | 无法读取目标 attempt 的 `frozen_request_json`、`validation_details_json`、scenario 行 |
| 本地保留配置 DB | 活跃配置样本为 `openai_compatible`、`https://api.deepseek.com`、`deepseek-v4-flash`、context 1,000,000、max output 200,000 | 不是与目标 attempt 绑定的冻结配置行 |

旧审计在 `docs/optimization/ShineWriter-V2.11.41-BudgetV5-流水线一次通过率详细审计-20260810.md:15-16、90、152` 和 CSV 第 30 行把 attempt 2 标成完整 Primary retry；该结论只由 attempt 次数和总调用数推导，没有 scenario/formatterUsed/request fingerprint 证据。

## 3. 当前请求语义

Batch UI 冻结值为“平衡”。当前产品映射中，“平衡”对应 requested tier `high`；V33 profile 让 Brief 跟随 `high`，Review/FactCheck 固定为 `low`，见 `src/services/pipeline/reasoningPolicy.ts:234-259、379-407`。

| 调用 | 应用层实际参数 | Provider wire body | 证据强度 |
|---|---|---|---|
| Brief Primary | scenario=`pipeline_brief`; responseFormat=`json_object`; thinking=`enabled`; reasoningEffort=`high`; temperature=0.1; top_p=1 | `response_format:{type:'json_object'}`、`thinking:{type:'enabled'}`；在 official host + `deepseek-v4-flash` 时发送 `reasoning_effort:'high'` | **已证实**应用层；wire effort 为**高概率/条件唯一**，但目标 frozen request 缺失 |
| FactCheck Primary | scenario=`pipeline_factcheck`; responseFormat=`json_object`; thinking=`enabled`; reasoningEffort=`low`; temperature=0.2; top_p=1 | 同上，effort=`low` | 同上 |
| FactCheck Formatter | scenario=`pipeline_factcheck_formatter`; responseFormat=`json_object`; thinking=`disabled`; reasoningEffort omitted; temperature=0.2; top_p=1 | `thinking:{type:'disabled'}`，无 `reasoning_effort` | **已证实**代码分支；目标 DB 行缺失 |

Provider 只有在 provider=`openai_compatible`、model 精确为 `deepseek-v4-flash` 且 hostname=`api.deepseek.com` 时才发送 `reasoning_effort`，见 `src/services/llm/openAICompatibleProvider.ts:49-69、376-385`。本地活跃配置满足这三个条件，但因目标 task 的 `llm_config_snapshot_json` 未保存，报告不把目标 wire body 抓包冒充为现存直接证据。

三个调用的 `max_tokens` 均来自各自编译后的 reservation。Budget V5 对主阶段采用独立 reservation，Formatter 则固定在 1,024–4,096 的小窗口，见 `src/services/pipeline/reconcile.ts:3498-3501`。目标 attempt 的精确 `max_tokens` 因冻结行缺失而**无法确认**，不得用当前模型配置上限 200,000 代替实际 request 值。

## 4. 事件 A：Brief reasoning-only 但本地一次通过

### 4.1 逐调用时序

```text
06:18:46.339  Brief Primary 返回
  content 长度=0
  reasoning_content 长度=128
  completion_tokens=66
  reasoning_tokens=66
  finish_reason=stop
  classifyEmptyResponse => reasoning_only
  StructuredCandidate => 从 reasoning 提取 JSON 对象
  Brief V33 Validator => valid=true
  本地 adopt/persist => success
  Formatter => 未调用
  Primary retry => 未调用
```

### 4.2 完整执行链

| 节点 | 实际值 | 代码位置 | 判断条件 | 是否符合设计 |
|---|---|---|---|---|
| Stage Reasoning Policy | Batch requested=`high`；Brief effective=`high`；Thinking enabled | `reasoningPolicy.ts:246-251、379-407` | V33 Brief 跟随用户档位 | 是 |
| build request config | scenario=`pipeline_brief`; JSON mode; high effort; temp=0.1; top_p=1 | `reconcile.ts:4682-4709、4815-4860` | V33 非 V31 | 是 |
| Provider request body | JSON mode、Thinking enabled；official DeepSeek 条件满足时带 `reasoning_effort=high` | `openAICompatibleProvider.ts:362-385` | capability 三条件 | 应用设计是；目标 wire 抓包缺失 |
| Provider raw response channel | `content` 空；`reasoning_content` 128 chars；`stop` | logcat `:691`；Provider 映射 `:490-506` | Provider 返回 | Provider 兼容现象；不是理想主通道结果 |
| LLMResult | `text=null/空`；`reasoningText` 非空；output=66；reasoning=66；visible arithmetic=0 | `openAICompatibleProvider.ts:507-540` | 严格分离两个通道 | 是 |
| classifyEmptyResponse | `reasoning_only` | `openAICompatibleProvider.ts:123-149` | text 空且 reasoning 非空 | 是；它只描述 transport channel |
| StructuredCandidate | content rejected=`empty_channel`；reasoning candidate 被选中 | `structuredCandidate.ts:34-103、112-162` | reasoning 中有完整可解析对象根 | 是；由后续 valid=true 反推 |
| schema/semantic validator | Brief V33 `valid=true` | `reconcile.ts:4870-4929`; `briefResultValidator.ts:705-830` | reasoning candidate 满足 Brief 合同与 required coverage | 是 |
| Formatter eligibility | 不进入判断结果分支；`!validation.valid` 为 false | `reconcile.ts:4938-4965` | 仅 invalid 才 Formatter | 是 |
| Formatter / Primary retry / local adoption | 直接本地 adopt；无额外 LLM 调用 | `reconcile.ts:4995-5015` | validation valid | 是 |
| attempt persistence | Primary attempt 保存 responseChannel=`reasoning`、candidateChannel=`reasoning`，随后清理临时正文；formatterUsed=false | `reconcile.ts:430-506、4967-4994`; repository `pipelineStageAttemptRepository.ts:116-251` | structured candidate persistence | 设计正确；目标行未保留供本次读取 |
| pipeline-audit | 同时打印 `valid=true` 和 `emptyReason=reasoning_only` | `pipelineAuditValidator.ts:895-944` | 两套不同层次语义混在一行 | 数据真实，但可观测性不合格 |

### 4.3 StructuredCandidate 为什么能通过

StructuredCandidate 对 content/reasoning 两个通道是中立的：分别提取平衡 JSON，`JSON.parse`，要求根为非数组对象，再按 root key/coverage/finding 数量评分。只有 content 与 reasoning 同分时才偏好 content。

事件 A 中 content 为空，所以理论 rejectedChannels 为：

```json
[{"channel":"content","reason":"empty_channel"}]
```

reasoning 未进入 rejectedChannels，而是成为 `candidate.channel=reasoning`。因为 V33 Brief 最终 `valid=true`，可排除“只有自然语言”“截断 JSON”“JSON parse 失败”“根为数组”“Brief semantic validator 拒绝”。原始 JSON 内容和 rootKeys 没有保留，不能进一步复原字段值。

## 5. 事件 B：FactCheck Primary 失败，Formatter 恢复

### 5.1 逐调用时序

```text
06:22:57.706  FactCheck Primary（pipeline_factcheck）返回
  thinking=enabled, reasoning_effort=low, JSON mode
  content 长度=0
  reasoning_content 长度=453
  completion_tokens=1774
  reasoning_tokens=278
  arithmetic visibleOutputTokens=1496
  finish_reason=stop
  classifyEmptyResponse => reasoning_only
  StructuredCandidate => 无完整可解析对象候选
  validation => valid=false, reason=reasoning_only
  formatterEligible => true

06:22:57.706 ~ 06:22:59.474
  进入 runAuditFormatter
  scenario=pipeline_factcheck_formatter
  body-free，仅输入 bounded candidate/receipts
  thinking=disabled, no reasoning_effort, JSON mode

06:22:59.474  Formatter 返回
  content 长度=116
  reasoning_content 长度=0
  outputTokens=39
  finish_reason=stop
  FactCheck V33 semantic validator => valid=true
  本地 persist/adopt => success
  完整 FactCheck Primary retry => 未发生
```

### 5.2 完整执行链

| 节点 | 实际值 | 代码位置 | 判断条件 | 是否符合设计 |
|---|---|---|---|---|
| Stage Reasoning Policy | Batch requested=`high`；FactCheck effective=`low`；Thinking enabled | `reasoningPolicy.ts:246-251、379-407` | V33 audit stage 固定 low | 是 |
| build request config | scenario=`pipeline_factcheck`; JSON mode; low effort; temp=0.2; top_p=1 | `reconcile.ts:3378-3448、3619-3630` | Primary `disableThinking=false` | 是 |
| Provider request body | Thinking enabled、JSON mode、official config 时 `reasoning_effort=low` | `openAICompatibleProvider.ts:362-385` | capability 三条件 | 应用设计是；目标 wire 抓包缺失 |
| Prompt | 明确要求最终 JSON 写入 `message.content` | `src/services/pipelineMessages.ts:1122-1135` | V33 FactCheck | 是；但 Provider 未遵守通道期望 |
| Provider raw response channel | content=0；reasoning=453；stop；usage 1774/278 | logcat `:4378` | Provider 返回 | 兼容异常/随机落点，不是 length |
| LLMResult | text 空、reasoningText 非空、emptyReason=`reasoning_only` | Provider `:490-540` | 严格通道分离 | 是 |
| classifyEmptyResponse | `reasoning_only` | Provider `:131-148` | text 空且 reasoning 非空 | 是 |
| StructuredCandidate | 无 candidate | `reconcile.ts:3180-3199`; `structuredCandidate.ts:34-57` | 两通道都未形成可接受的对象根 | 是 |
| semantic/schema validator | 没有进入 FactCheck semantic validator；直接 `valid=false, reason=reasoning_only` | `reconcile.ts:3188-3212` | `selection.candidate` 为空 | 是 |
| Formatter eligibility | `true` | `reconcile.ts:3632-3675` | reasoningText 非空、非 filter、未 format、非 cold-start 空候选 | 是 |
| Formatter request | scenario=`pipeline_factcheck_formatter`; thinking disabled；无 effort；1,024–4,096 tokens | `reconcile.ts:3451-3558` | invalid + eligible | 是 |
| Formatter validation | attempt 2 `valid=true` | logcat `:4429`; `reconcile.ts:3685-3735` | Formatter content 通过 V33 validator | 是 |
| local adoption | 保存标准化 FactCheck；warning 明确“未重跑完整主审” | `reconcile.ts:3739-3775` | valid normalizedText | 是 |
| attempt persistence | Primary `formatterUsed=false`；Formatter `formatterUsed=true`，独立 fingerprint/frozen request | `reconcile.ts:361-378、3518-3539` | 每个物理请求一行 | 是；目标 DB 未保留 |
| pipeline-audit | 只打印 attempt/valid/token，不打印 scenario/role/formatterUsed | `pipelineAuditValidator.ts:895-944` | logger schema 缺字段 | **不符合审计需求** |

### 5.3 attempt 1 的 reasoning 内容能确认到什么程度

**已证实：** reasoningText 非空（453 chars），但 StructuredCandidate 没有候选；否则代码会进入 `validateFactCheckSemanticPayloadV33()`，失败原因会是 FactCheck semantic failure，而不会是 `reasoning_only`。

**可以排除：**

- 完整可解析 JSON 对象但缺字段；这种情况会进入 semantic validator。
- 完整可解析 JSON 对象、字段完整但 semantic validator 拒绝；日志 reason 不会是 `reasoning_only`。
- token 截断已经由 `finishReason=stop` 排除，但这不等于文本内部一定没有不闭合 JSON。

**无法确认：** reasoningText 究竟属于以下哪一种：

1. 完全自然语言，无 JSON；
2. 含不平衡/未闭合 JSON，`truncated_json`；
3. 含平衡但语法错误 JSON，`json_parse_failed`；
4. 未找到可提取 JSON，`invalid_json`；
5. JSON 根是数组/非对象，`root_not_object`。

按当前选择器，理论 `rejectedChannels` 应为：

```json
[
  {"channel":"content","reason":"empty_channel"},
  {"channel":"reasoning","reason":"invalid_json | truncated_json | json_parse_failed | root_not_object"}
]
```

目标 `pipeline_stage_attempts.validation_details_json` 和 raw/scratch candidate 不在现存 DB 中，故第二项不能再细分。任何把它写成确定的 `invalid_json`、truncated JSON 或自然语言 reasoning 都属于补造。

### 5.4 为什么旧审计会误判 Primary retry

旧审计采用了两个不成立的推断：

1. `attempt=2` 被当作“第二次 Primary”；实际上 `attemptNo` 统计同 stage 的所有物理请求，Formatter 同样占一个 attempt。
2. Batch 总调用 `16 = 15 + 1` 只能证明多了一次物理调用，不能证明这次调用的角色。

当前 pipeline-audit 缺少以下足以直接定性的字段：

- `scenario`
- `attemptRole` / `requestKind`（primary、formatter、manual_retry、protocol_fallback）
- `formatterUsed`
- `requestVersion`
- `thinking` / `reasoningEffort`
- `requestFingerprint` 前缀或 `clientRequestId`
- `responseChannel` / `candidateChannel`
- `formatterEligible` / `formatterDecision`
- `rejectedChannels`

持久化层其实已有 `request_fingerprint`、`frozen_request_json`、`response_channel`、`response_candidate_channel`、`formatter_used`、`validation_details_json`，见 `pipelineStageAttemptRepository.ts:116-251`；但目标 DB 快照未保留，且这些字段未进入 logcat。与此同时，`llm_usage_logs` 有 scenario，却没有 taskId/attemptId，见 `usageRepository.ts:5-29`，无法稳定与 stage attempt 关联。这是本次身份判断困难的直接原因。

## 6. Provider、分类、token 统计与恢复语义

### 6.1 `finishReason=stop` 为什么仍可 reasoning-only

当前 Provider 显式、严格地把：

- `message.content` 映射为 `LLMResult.text`
- `message.reasoning_content` 映射为 `LLMResult.reasoningText`
- `finish_reason` 独立映射为 `finishReason`

见 `openAICompatibleProvider.ts:490-506`。代码没有也不应把 reasoning 隐式塞进 text。`stop` 只说明 Provider 正常结束这个 choice；本地没有任何协议字段能据此推导 content 非空。

事件 A 是“最终可用 JSON 落在 reasoning 通道”；事件 B 是“reasoning 非空但不构成可本地采用的 JSON 对象”。这两次真实响应共同证明通道落点不能仅靠 `response_format=json_object` 或 Prompt 保证。

### 6.2 `visibleOutputTokens` 与 `message.content` 不一致

当前实现：

```text
reasoningTokens = usage.completion_tokens_details.reasoning_tokens
visibleOutputTokens = max(0, completion_tokens - reasoningTokens)
```

见 `openAICompatibleProvider.ts:514-529`，attempt persistence 还会重复这一 fallback，见 `reconcile.ts:487-493`。

事件 B：

```text
completion_tokens=1774
reasoning_tokens=278
visibleOutputTokens=1496
message.content chars=0
```

这是对“visibleOutputTokens 等于实际 content tokens”的直接反证。更准确的含义应是 `providerReportedNonReasoningTokens`。差值可能包含 Provider 统计口径中的隐藏/非 reasoning 项，也可能是 usage 明细与消息通道口径不同；本地证据无法继续解释 DeepSeek usage 内部计费语义。

因此：

- `classifyEmptyResponse()` 的 channel 判断是正确的；
- `visibleOutputTokens` 的命名和诊断解释是错误/误导性的；
- `textLength` 才是本次可直接证明 `message.content` 是否为空的字段；
- 不能因为 arithmetic visible > 0 就把 content 判为非空，也不能据此诊断 JSON 去向。

### 6.3 `reasoning_only + valid=true` 不是 Validator 自相矛盾

`emptyReason` 是 Provider transport 层状态；`valid` 是 StructuredCandidate + semantic validator 层状态。事件 A 的真实语义应表达为：

```text
transportOutcome=content_empty_reasoning_present
candidateChannel=reasoning
adoptionMode=local_reasoning_candidate
contractValid=true
physicalCalls=1
```

当前日志把第一层和最后一层打印出来，却省略中间两层，才造成“empty 但 valid”的歧义。

## 7. 假设验证矩阵

| 假设 | 结论 | 证据等级 | 说明 |
|---|---|---|---|
| Budget V5 token 不足导致两个事件 | **已排除** | 已证实 | 两次均 stop，非 length；reasoningBudgetExhausted=false |
| 增加 max_tokens 能修复本次问题 | **已排除** | 已证实 | 没有预算耗尽信号；会扩大成本而不改变通道保证 |
| DeepSeek Thinking + JSON mode 可能把最终 JSON留在 reasoning | **已证实** | 已证实 | 事件 A reasoning candidate 直接通过 Brief Validator |
| Brief high/max 增加 reasoning-only 概率 | **待验证** | 弱 | 本次 Brief=high 命中一次，但没有同 Prompt/同输入的 low 对照；样本过小 |
| Review/FactCheck 固定 low 可消除通道随机性 | **已排除** | 已证实 | 事件 B FactCheck=low 仍 reasoning-only |
| V33 Brief Prompt 未明确 `message.content` 是唯一根因 | **已排除** | 已证实 | FactCheck Prompt 明确要求 `message.content`，仍发生同类事件 |
| Brief Prompt 的通道措辞缺失可能提高概率 | **待验证** | 弱 | 仅是非必要 trigger 候选；无对照实验 |
| Event B attempt 1 是 semantic validator 拒绝 | **已排除** | 已证实 | 没有 StructuredCandidate 时提前返回 reasoning_only，未进入 semantic validator |
| Event B attempt 1 reasoning 中有完整可解析 JSON 对象 | **已排除** | 已证实 | 若有对象根，selectStructuredCandidate 必产生 candidate |
| Event B attempt 2 是完整 Primary retry | **已排除** | 已证实 | attempt=2 日志只在 Formatter 分支发出；scenario 固定 formatter |
| Event B attempt 2 是 Contract Formatter | **已证实** | 已证实 | 控制流、时间序列、Thinking-disabled 响应特征交叉一致 |
| `visibleOutputTokens` 等于 content token | **已排除** | 已证实 | Event B 1496 vs content chars 0 |
| Provider reasoning token 明细与实际通道完全同义 | **已排除** | 已证实 | 同上；具体 Provider 统计口径仍无法确认 |

## 8. 分级根因

### 8.1 Root Cause

1. **Provider Behavior / Expected Compatibility Behavior（P2）**：DeepSeek 在 Thinking enabled 的结构化请求中没有稳定兑现“最终业务 JSON 位于 `message.content`”这一通道约束。`finish_reason=stop` 和 JSON mode 不构成 content 非空保证。
2. **Observability Code Defect（P1）**：pipeline-audit 未记录调用角色和已持久化的 formatter/candidate/fingerprint 信息，导致真实 Formatter 被错误审计为完整 Primary retry。
3. **Diagnostic Semantics Code Defect（P1）**：把 usage 算术差值命名为 `visibleOutputTokens`，与实际 `message.content` 不一致；事件 B 已产生 1496“可见 token”但 content 为零的误导诊断。
4. **Layering/Terminology Gap（P2）**：`emptyReason=reasoning_only` 与 `valid=true` 分属 transport 与 business contract，却没有 transportOutcome/candidateChannel/adoptionMode 分层输出。

**P0：无。** 两个目标任务最终都成功，未发现数据损坏、错误采用或无限重试；最高优先级是 P1 的审计与诊断可信度问题。

### 8.2 Trigger

- 必要触发条件：Thinking enabled，Provider 返回 content 空、reasoning 非空。
- 事件 A 的 observed trigger：Brief effective high + JSON mode；但 high 相对 low 的增幅未证实。
- 事件 B 证明 low Thinking 仍可能触发，Prompt 明确要求 content 也不能消除。
- V33 Brief Prompt 未明确 `message.content` 可能是弱诱因，但不是必要原因，也不是当前证据支持的首修点。

### 8.3 Recovery Behavior

- 完整 reasoning JSON：StructuredCandidate channel-neutral salvage，Validator 通过后本地采用；0 额外调用。
- 非结构化/不完整 reasoning：V33 audit stage 一次 Contract Formatter，Thinking disabled，bounded 1,024–4,096 output；成功后本地采用。
- Formatter 不合格：阶段 fail-closed；不会在同一 checkpoint 静默重放完整 Primary。之后只有显式重试/新 checkpoint 才可能发起新的 Primary。

### 8.4 Observability Gap

- logcat 无 scenario/attemptRole/formatterUsed。
- attempt 编号混合统计 Primary 和 Formatter。
- usage 表有 scenario 无 taskId，attempt 表有 taskId/role 信息但本次 DB 未保存。
- Provider 对不支持的 `response_format`/Thinking 参数还存在一次协议降级 fetch 路径，但该 HTTP 级 fallback 未形成独立 stage attempt；本次日志没有其发生证据，因此不能计入或排除目标请求的原始 HTTP 往返数。
- rejectedChannels/formatterDecision 已能写入 validation details，却未打印到安全审计日志。
- raw reasoning 出于安全/隐私不应直接打日志，但必须保存 hash、chars、rootKeys、rejection code 等 bounded metadata。

### 8.5 是否与 Budget V5 有关

**现象与 Budget V5 没有因果关系。** Budget V5 决定 reservation；这两个响应正常 stop，没有 length/budget exhaustion。V5 只是本次穿测所处的配置背景。修复不应增加 max_tokens、修改 V5 reservation、调整全局 Reasoning 档位或牵连 Story Memory。

### 8.6 成本与失败风险

| 问题 | 调用数 | token 成本 | 失败概率 |
|---|---:|---:|---:|
| 事件 A reasoning 本地采用 | 不增加 | 不增加额外请求 | 未增加；日志易误判 |
| 事件 B reasoning 无候选 | +1 Formatter | 增加 formatter input + 39 output tokens；目标 input usage 未保存 | Formatter 若失败会令 stage fail-closed |
| 若误改为完整 Primary retry | 将 +1 大调用 | 显著高于 Formatter | 可能重复大上下文且增加非确定性；当前没有发生 |

## 9. 证据强度总表

### 已证实

- 两次 `reasoning_only` 都是 content 空、reasoning 非空、finish stop。
- 事件 A reasoning 通道存在可通过 Brief V33 Validator 的 JSON 对象。
- 事件 B attempt 1 没有可由 StructuredCandidate 接受的完整对象根。
- 事件 B Formatter eligibility 成立，attempt 2 是 `pipeline_factcheck_formatter`。
- 本轮没有完整 FactCheck Primary retry。
- token budget exhaustion 不是这两个事件的原因。
- `visibleOutputTokens` 与实际 content 可不一致。

### 高概率

- 目标请求使用 official DeepSeek `deepseek-v4-flash`，因此 wire body 实际发送 high/low `reasoning_effort`。穿测报告和现存活跃配置一致，但缺目标 frozen config 行。
- DeepSeek 的响应通道落点具有一定非确定性；Brief high 与 FactCheck low 都发生，支持“并非档位单点问题”，但样本仍小。

### 待验证

- Event B reasoning 的准确 rejection code。
- DeepSeek `completion_tokens_details.reasoning_tokens` 中 278 与剩余 1496 的 Provider 内部统计含义。
- Brief high/max 相比 low 是否显著增加 reasoning-only 概率。
- V33 Brief 增加一条 `message.content` 指令是否能降低概率；FactCheck 反例说明它不可能成为硬保证。

### 已排除

- 两个事件由 Budget V5 token 不足引起。
- Event B 是完整 Primary retry。
- Event B 是完整 JSON 被 semantic validator 拒绝。
- 全局降低 Reasoning、增加 max_tokens、删除 Formatter是有证据支撑的修复。

## 10. 最小边界修复方案

本节是基于根因推导的建议，**本轮未实施**。

### P1：先修审计身份与 token 命名

1. 给每次 LLM 物理请求引入/输出稳定的 `attemptRole`：
   - `primary`
   - `contract_formatter`
   - `manual_primary_retry`
   - `provider_protocol_fallback`
2. pipeline-audit 至少增加：`scenario`、`attemptRole`、`formatterUsed`、`requestVersion`、`thinking`、`reasoningEffort`、`responseChannel`、`candidateChannel`、`formatterEligible`、`formatterDecision`、短 fingerprint。
3. 将 `visibleOutputTokens` 重命名为 `providerReportedNonReasoningTokens`，保留兼容迁移；同时输出 `contentChars`。若需要 token 估算，另建 `estimatedContentTokens`，不得混用 Provider usage 差值。
4. 更新一次通过率审计规则：只有 `attemptRole=manual_primary_retry` 才算完整 Primary retry；Formatter 单独统计。

### P2：分离 transport 与 business outcome

1. 保留严格通道分离和 `classifyEmptyResponse()`，不要把 reasoning 隐式复制进 `text`。
2. 新增清晰 outcome：
   - `transportOutcome=content|reasoning_only|empty|...`
   - `candidateChannel=content|reasoning|...`
   - `adoptionMode=primary_content|local_reasoning_candidate|formatter|failed`
3. 安全记录 `rejectedChannels`、candidate chars/hash/rootKeys，不记录完整 reasoning 正文。

### 暂不修改

- 不增加 `max_tokens`。
- 不修改 Budget V5。
- 不调整全局或各 stage Reasoning 档位。
- 不重写 Prompt；若后续对照实验显示 V33 Brief 的 content 指令有显著收益，再做一行级一致性修订。
- 不修改 StructuredCandidate salvage 和 Formatter eligibility：本次它们均按设计工作。
- 不删除 Formatter；它正是事件 B 的低成本恢复路径。
- 不触碰 Story Memory 或无关模块。

## 11. 完整修复与穿测方案

### 11.1 单元/集成测试

1. Provider fixture：`content=''`、reasoning 为完整 Brief JSON、stop、reasoning tokens=completion tokens；断言 transport reasoning-only，但 Brief 一次本地采用，调用数=1。
2. Provider fixture：`content=''`、reasoning 为自然语言或不完整 JSON、stop，且 `completion-reasoning > 0`；断言 content 仍为空，不能用 token 差值改判。
3. V33 FactCheck 集成：Primary reasoning 无 candidate；断言第二调用：
   - scenario=`pipeline_factcheck_formatter`
   - attemptRole=`contract_formatter`
   - thinking disabled
   - no reasoning_effort
   - `formatterUsed=true`
   - 没有第二个 `pipeline_factcheck` Primary
4. V33 complete reasoning candidate：断言 local adoption、无 Formatter。
5. Formatter failure：断言 fail-closed、无静默 Primary replay。
6. audit serialization：断言新字段出现，且不泄露 Prompt/reasoning/API key。
7. usage semantics：断言 `providerReportedNonReasoningTokens=1496` 与 `contentChars=0` 可以同时存在，字段名不再宣称“visible”。

本次调查已执行现有定向测试：

```text
npx jest __tests__/llm.test.ts __tests__/pipelineV32WorkflowIntegration.test.ts --runInBand
Test Suites: 2 passed, 2 total
Tests: 40 passed, 40 total
```

其中现有集成测试已验证“完整 reasoning candidate 本地采用”和“不可解析 reasoning-only 只走一次 Formatter、不 replay Primary”；测试日志也复现了 `attempt=2` 实际为 Formatter 但单行审计看不出角色的问题。

### 11.2 真实 LLM 最小穿测

完成 P1/P2 可观测性修复后，不必先重跑完整六章；先做最小受控采样：

1. 同一 DeepSeek config、同一冻结 input，FactCheck low 连续 3 次；Brief high 连续 3 次。
2. 每次保留：安全化 request semantics、scenario、attemptRole、taskId/attemptId、Provider request id、response channel lengths、usage 明细、candidate/rejection metadata、formatter decision。
3. 立即导出与 taskId 绑定的 `pipeline_stage_attempts` 和 `llm_usage_logs`；不要等 scratch/测试 DB 被覆盖。
4. 验收：
   - 所有额外调用身份可由一个字段确定；
   - reasoning JSON 本地采用不增加调用；
   - reasoning 非 JSON 最多一次 bounded Formatter；
   - 不发生隐式完整 Primary replay；
   - `finishReason=stop` 不被错误归因于预算；
   - UI/报告不再把 arithmetic non-reasoning tokens 称为实际可见输出。
5. 只有需要判断“high 是否提高概率”时，才增加 Brief low/high 的同输入配对样本；单次命中不能用于改 Reasoning Policy。

## 12. 尚无法确认的数据与下一步最小取证

| 无法确认项 | 缺失原因 | 下一步最小取证 |
|---|---|---|
| Event B reasoning 的具体内容/准确 rejection code | 目标 task DB 与 raw response 未保存；logcat 只记长度 | 将 `rejectedChannels` 写入安全 audit；保存目标 `validation_details_json` |
| 目标两次 Primary 的精确 `max_tokens` | 无目标 `frozen_request_json` | 在 audit 打印 `reservedOutputTokens/maxTokens`，或运行后立即导出 attempt 行 |
| 目标 wire body 是否确实发出 `reasoning_effort` | 无抓包/target config snapshot | 记录 capability decision 与安全化 request semantics，不记录 key/body |
| Event B usage 中 1496 个“非 reasoning”token 的 Provider 内部含义 | 本地只有聚合 usage；无 Provider 计费明细定义 | 记录原始 usage 字段结构和 request id；不要从差值推断 content |
| Brief high 是否提高 reasoning-only 概率 | 只有一个命中，无受控对照 | 同输入 low/high 各至少 3 次，仅用于策略评估 |

## 13. 最终交付结论（对应必答项）

1. **两个事件逐调用时序**：见第 4.1、5.1 节。
2. **FactCheck attempt 2 的真实身份**：`pipeline_factcheck_formatter`，Thinking disabled；不是完整 Primary retry。
3. **reasoning_only 根因**：DeepSeek Thinking 请求的业务结果通道不稳定，可能 content 为空而 reasoning 非空；本地 `stop`/JSON mode/Prompt 不能形成通道硬保证。
4. **Primary retry 是否真实存在**：本轮指定事件中不存在；旧审计误分类。实际是一次 Formatter。
5. **已排除假设**：Budget/token 不足、length truncation、FactCheck semantic validator 拒绝完整 JSON、attempt 2 为完整 Primary、visible token 等于 content token。
6. **严重级别**：Provider 兼容现象 P2；调用身份审计缺陷 P1；visible token 命名/诊断缺陷 P1；层级语义缺失 P2。
7. **推荐修复范围**：Provider/diagnostic semantics、attempt observability、审计分类；保留 StructuredCandidate 与 Formatter 当前恢复设计。
8. **完整修复与穿测方案**：见第 10、11 节；先可观测性与确定性测试，再做最小真实 DeepSeek 受控采样。
9. **尚无法确认及最小取证**：见第 12 节；最关键是持久化/输出 `attemptRole + rejectedChannels + request semantics + task-bound usage`。

---

本次专项调查的核心纠偏是：**V2.11.41 Budget V5 并没有在该 FactCheck 上发生一次昂贵的完整 Primary retry；系统按设计用一次 Thinking-disabled Contract Formatter 恢复了不可直接解析的 reasoning-only 候选。真正需要优先修的是审计身份和 token/通道诊断语义，而不是 Budget、Reasoning 档位或 Formatter 本身。**
