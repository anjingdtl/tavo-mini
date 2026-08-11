# Tavo-Mini DeepSeek V4 Prompt Cache 保守型优化与穿测方案

> **范围：仅 P0 可观测性 + P1 确定性序列化治理**  
> **远端基线：`anjingdtl/tavo-mini` / `9a032637388353295e6ec14b555bcf6c718fba11`**  
> **基线版本：V2.11.49**  
> **当前 Schema：50**  
> **方案日期：2026-08-11**

---

## 1. 方案目标

本专项的目标不是“最大化缓存命中率”，而是：

> **在 Prompt 语义、上下文完整性、流水线行为、Story Memory 行为、推理档位、API 请求次数和文学质量均不退化的前提下，最大化当前架构可以安全获得的 DeepSeek Prompt Cache 收益。**

本期只建设两类能力：

- **P0：缓存可观测性与基线建设**：先准确回答“哪些调用命中了、哪些没命中、哪个阶段最值得关注”。
- **P1：Prompt Deterministic Serialization 治理**：只处理可证明无业务语义的字节抖动，使“相同业务输入”尽可能生成“相同请求字节”。

本方案不以缓存命中率作为独立发版门槛。**用户体验、文学质量、连续性、稳定性和恢复正确性优先级始终高于缓存收益。**

---

## 2. 当前远端实际基线

### 2.1 最新远端版本

截至本方案编制时，远端最新提交为：

```text
9a032637388353295e6ec14b555bcf6c718fba11
release: V2.11.49 story memory temporal boundary
```

V2.11.45 → V2.11.49 的四个新增版本继续集中在 Story Memory Protocol V2 的最终治理，包括 Evidence 时序边界、Character/Relationship/Foreshadowing 状态生命周期和长篇语义门禁。

**结论：本次缓存专项不得借机重构 Story Memory V2 语义链路。**

### 2.2 当前数据库

当前迁移入口：

```text
src/services/migrations/index.ts
SCHEMA_VERSION = 50
```

Schema 50 新增：

```text
story_memory_request_attempts
```

该表的设计目的非常明确：只记录 Story Memory 真实 HTTP 请求的传输生命周期，用于避免冷启动后静默重复计费；不记录 Prompt、章节正文、推理正文。

**本专项继续保持这一职责边界，不向该表增加缓存字段。**

### 2.3 当前 LLM Provider 已具备的条件

核心文件：

```text
src/services/llm/types.ts
src/services/llm/openAICompatibleProvider.ts
```

当前已经：

- 能读取 `prompt_tokens / completion_tokens / total_tokens`；
- 能读取 `completion_tokens_details.reasoning_tokens`；
- `rawUsage` 原样保留 provider `usage`；
- DeepSeek V4 Flash 官方 endpoint 已有窄能力识别；
- Provider 调用成功后统一进入 `safeLogUsage()`；
- `safeLogUsage()` 失败不会影响生成；
- 当前尚未把 DeepSeek 的缓存 hit/miss 字段提升为一等字段，也没有持久化统计。

### 2.4 当前 Pipeline 已具备的条件

核心文件：

```text
src/services/pipeline/compileStageRequest.ts
src/services/pipelineTaskContext.ts
src/services/pipeline/reconcile.ts
src/data/repositories/pipelineStageAttemptRepository.ts
```

当前已有以下重要稳定性基础：

1. Draft 请求可以冻结为 `FrozenDraftRequest`；
2. `compileDraftFromFrozenRequest()` 重试时直接复用 `frozen.messages`，只在末尾追加 retry user message；
3. `pipeline_stage_attempts` 已保存：
   - `request_fingerprint`
   - input/output/total tokens
   - reasoning tokens
   - finish reason
   - formatter 信息
   - response candidate / validation diagnostics
4. `runStageAttempt()` 是统一阶段 LLM 调用持久化入口，最适合补充缓存统计；
5. 多章节任务已有独立预算与恢复治理，本专项不改变它们。

### 2.5 当前 Prompt 构建已有大量确定性设计

已经确认：

- `outlineContextBuilder.ts` 明确要求 enabled outline 按 position 顺序拼装，并生成稳定 fingerprint；
- 完整大纲不允许静默截断；
- `characterRepository.getCharactersByProject()` 已 `ORDER BY c.id ASC`；
- `worldbookRepository.getWorldbookEntriesByProject()` 已 `ORDER BY w.position ASC, w.id ASC`；
- Pipeline Context Snapshot 会冻结当前大纲、Story Memory、资源、近期正文和章节指令；
- Story Memory Protocol V2 的 Observer System Prompt / Contract 当前属于成熟生产协议。

**因此 P1 不应对已经确定性的路径做“重新排序式优化”。**

---

## 3. DeepSeek Cache 事实约束

DeepSeek 当前缓存为自动启用的前缀缓存。应用侧无需额外发起“缓存创建请求”。Provider 的 `usage` 会返回：

```text
prompt_cache_hit_tokens
prompt_cache_miss_tokens
```

并且：

```text
prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens
```

缓存是 best-effort，不保证每次命中。因此：

1. **禁止增加 warm-up API 请求；**
2. **禁止因为一次未命中就触发额外重试；**
3. **缓存 miss 不属于业务失败；**
4. **缓存 hit/miss 只能做观测和成本统计，不得进入 Pipeline 分支条件。**

---

# 4. 总体改造边界

## 4.1 本期允许修改

仅允许：

- Provider usage 字段解析；
- nullable 缓存 telemetry 持久化；
- 缓存统计查询；
- 诊断日志；
- 稳定 fingerprint / snapshot 测试；
- 可证明无语义的 machine-generated serialization 修复；
- 对无序集合增加确定性排序，但必须先证明该集合的顺序不承载业务语义；
- machine-generated scaffold 的无语义格式统一，但必须有 before/after 语义等价证明。

## 4.2 本期硬性禁止

以下任何一项出现，直接判定越界：

- 改 system / user / assistant 角色；
- 调整 Prompt 信息块顺序；
- 把动态内容从 system 移到 user，或反向移动；
- 删除、摘要或压缩完整大纲来换缓存；
- 修改 Final 的上下文顺序；
- 减少上一章正文、近期正文或连续性上下文；
- 修改“最近最多 10 章”原则；
- 修改 Story Memory 智能更新节奏；
- 修改 Story Memory 内部 3 章 batch / 3→2→1 split；
- 修改 Mandatory / Preferred High / Preferred Low / Optional 的业务优先级；
- 修改 relevantCharacter / relationship / archive 选择逻辑；
- 修改 Story Memory Observer Protocol V2 的语义、字段、角色或输出合同；
- 修改 Story Memory Normalizer / Resolver / Compiler / Merger 的业务规则；
- 修改 Evidence Anchor 时序边界；
- 修改 Pipeline 五阶段拓扑；
- 修改 Validator / Formatter / Retry / fail-closed 规则；
- 修改用户选择的 reasoning tier；
- 修改 FactCheck 固定低推理策略；
- 增加任何缓存预热 HTTP 请求；
- 因缓存 miss 增加任何 API 调用；
- 将缓存命中率作为是否继续写作、是否重试、是否运行 Story Memory 的条件；
- 为统计方便持久化 Prompt、章节正文、reasoning_content 或 API Key；
- 为统计新增大字段，重新引入 Android CursorWindow 大行风险。

---

# 5. P0：缓存可观测性与基线建设

## 5.1 P0 目标

P0 必须做到：

> **业务请求内容 0 改动、请求次数 0 增量、模型参数 0 改动、Pipeline 行为 0 改动，只增加“看得见”的能力。**

P0 完成后必须可以回答：

- DeepSeek V4 Flash 总体缓存命中率是多少；
- Draft / Review / FactCheck / Brief / Final 各自命中多少；
- Story Memory 各 scenario 命中多少；
- 哪些调用根本没有 provider cache telemetry；
- 同一批长篇生成中，缓存命中率如何随章节演进；
- input tokens 中有多少按 hit / miss 计费。

---

## 5.2 P0-1：扩展 LLMResult

### 修改文件

```text
src/services/llm/types.ts
```

### 新增字段

建议在 `LLMResult` 增加：

```ts
promptCacheHitTokens?: number | null;
promptCacheMissTokens?: number | null;
```

并扩展 `rawUsage`：

```ts
rawUsage?: {
  prompt_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
};
```

### 不建议新增持久化 ratio 字段

`cacheHitRatio` 应在查询层派生：

```text
hit / (hit + miss)
```

原因：避免冗余字段和数据不一致。

---

## 5.3 P0-2：Provider 解析 DeepSeek cache usage

### 修改文件

```text
src/services/llm/openAICompatibleProvider.ts
```

### 建议新增纯函数

```ts
export function parsePromptCacheUsage(usage: unknown): {
  hitTokens: number | null;
  missTokens: number | null;
}
```

规则：

1. 仅接受有限、非负数字；
2. 不存在字段时返回 `null`，不要伪造成 `0`；
3. 不因第三方 OpenAI-compatible gateway 未返回字段而报错；
4. 不因 `hit + miss != prompt_tokens` 阻止生成；
5. 不改变 `inputTokens` 当前 fallback 行为；
6. 不改变 `reasoningTokens` 解析；
7. 不改变协议 fallback 行为。

### Provider 返回

在现有：

```ts
return {
  text,
  reasoningText,
  reasoningTokens,
  visibleOutputTokens,
  inputTokens,
  outputTokens,
  totalTokens,
  ...
}
```

追加：

```ts
promptCacheHitTokens,
promptCacheMissTokens,
```

仅增加 metadata。

---

## 5.4 P0-3：Schema 50 → 51 纯增量迁移

### 新增文件

```text
src/services/migrations/v50-to-v51.ts
```

### 修改文件

```text
src/services/migrations/index.ts
src/data/schema/createCurrentSchema.ts
src/data/schema/schemaValidator.ts   // 仅当当前 validator 对列集合有显式要求时更新
```

### SCHEMA_VERSION

```ts
SCHEMA_VERSION = 51;
```

### 仅新增 4 个 nullable INTEGER 列

#### llm_usage_logs

```sql
prompt_cache_hit_tokens INTEGER;
prompt_cache_miss_tokens INTEGER;
```

#### pipeline_stage_attempts

```sql
prompt_cache_hit_tokens INTEGER;
prompt_cache_miss_tokens INTEGER;
```

### 明确不新增

本期禁止给以下表增加缓存列：

```text
story_memory_request_attempts
multi_chapter_batches
multi_chapter_batch_items
pipeline_tasks
chapters
project_story_memory
```

### 不新增缓存索引

缓存字段只用于聚合统计，不作为高频定位条件。本期不增加 hit/miss 索引，避免无意义写放大和 schema 复杂化。

### 迁移实现要求

遵循项目近版本迁移风格：

- additive；
- idempotent；
- 检查 column 是否已存在后再 ALTER；
- fresh install 与 50→51 upgrade 结果必须一致；
- 不 backfill 历史行；
- 历史行保持 `NULL`，表示“当时没有采集能力”，不能写成 0。

---

## 5.5 P0-4：扩展全局 usage 日志

### 修改文件

```text
src/data/repositories/usageRepository.ts
src/services/llm/openAICompatibleProvider.ts
```

### logLLMUsage 入参新增

```ts
promptCacheHitTokens?: number | null;
promptCacheMissTokens?: number | null;
```

### 写入规则

- Provider 成功且返回字段：写真实值；
- Provider 成功但未返回：写 NULL；
- Provider error：写 NULL；
- 禁止根据 inputTokens 猜 hit/miss；
- 禁止使用估算 token 替代 provider cache token。

### 保持 safeLogUsage 语义

现有约束：

```text
Usage logging must never break generation.
```

必须保持。

任何 cache telemetry DB 写失败都不得导致：

- 章节生成失败；
- Stage 重试；
- Story Memory 重试；
- 用户看到额外错误。

---

## 5.6 P0-5：Pipeline Stage 级缓存统计

### 修改文件

```text
src/data/repositories/pipelineStageAttemptRepository.ts
src/services/pipeline/reconcile.ts
```

### PipelineStageAttemptRow 新增

```ts
promptCacheHitTokens: number | null;
promptCacheMissTokens: number | null;
```

同步更新：

```text
UpdateStageAttemptInput
mapRow()
updateStageAttempt()
```

### runStageAttempt 成功路径

当前成功路径已写入：

```text
inputTokens
outputTokens
totalTokens
reasoningTokens
finishReason
visibleOutputTokens
...
```

在同一 `updateStageAttempt()` 中追加：

```ts
promptCacheHitTokens: result.promptCacheHitTokens ?? null,
promptCacheMissTokens: result.promptCacheMissTokens ?? null,
```

### 关键边界

缓存字段：

- 只记录；
- 不参与 attempt 状态；
- 不参与 retry disposition；
- 不参与 batch budget；
- 不参与 checkpoint；
- 不参与 validator；
- 不参与用户错误提示。

---

## 5.7 P0-6：Story Memory 统计走 llm_usage_logs，不动物理请求账本

当前：

```text
storyMemoryCheckpointService.requestCheckpoint()
    → callLLMResult()
    → buildStoryMemoryLLMConfig({ scenario, projectId, ... })
```

Story Memory 已经给 LLM 调用传入独立 scenario。

因此本期直接通过：

```text
llm_usage_logs.scenario
```

统计：

```text
story_memory_*
```

对应 cache hit/miss。

### 不修改

```text
src/data/repositories/storyMemoryRequestAttemptRepository.ts
src/services/storyMemory/storyMemoryAttemptBudget.ts
```

原因：这两处承担的是“真实物理 HTTP 请求去重/恢复/未知结果治理”，不是费用分析表。

这样可以避免：

- request hook 与 response body usage 关联复杂化；
- protocol fallback 导致物理 attempt 与最终 usage 归属错位；
- 再次扰动 V2.11.49 刚完成的 Story Memory 稳定性治理。

---

## 5.8 P0-7：增加只读缓存统计查询

### 修改文件

```text
src/data/repositories/usageRepository.ts
```

建议增加：

```ts
getLLMCacheUsageSummary(projectId)
getLLMCacheUsageByScenario(projectId)
getLLMCacheUsageByConfig(projectId)
```

### 统计字段

至少返回：

```text
reported_call_count
cache_hit_tokens
cache_miss_tokens
cache_total_input_tokens
cache_hit_ratio
```

其中：

```sql
cache_hit_ratio =
  SUM(prompt_cache_hit_tokens) /
  NULLIF(
    SUM(prompt_cache_hit_tokens) + SUM(prompt_cache_miss_tokens),
    0
  )
```

### 不修改普通用户 UI

P0 首轮仅提供 repository 查询、测试和 debug/验收报告能力。

原因：

- 先验证数据可靠；
- 避免为缓存专项改动主界面；
- 避免用户把 best-effort cache hit ratio 当成质量指标。

---

## 5.9 P0-8：Frozen Request 稳定性回归门禁

重点文件：

```text
src/services/pipeline/compileStageRequest.ts
src/services/pipelineTaskContext.ts
```

当前 Draft 已具备非常重要的缓存友好行为：

```ts
messages = frozen.messages
```

重试时：

```ts
messages = [
  ...frozen.messages,
  { role: 'user', content: retryInstruction },
]
```

本期不改实现，只增加强回归测试。

### 必须新增断言

1. 无 retry 时：

```text
compiled.messages === frozen.messages 的内容完全一致
```

2. retry 时：

```text
messages[0..N-1] 与 frozen.messages 字节完全一致
```

3. retry 只能多一个末尾 user message；

4. frozen base request fingerprint 不得变化；

5. retry 不重新读取：

```text
SQLite
Preset
Outline
Story Memory
Worldbook
Characters
Notes
```

来重编 Draft base context。

### 失败条件

如果为了缓存 telemetry 导致任何 Frozen Request 重新编译，P0 直接 NO-GO。

---

# 6. P1：Prompt Deterministic Serialization 治理

## 6.1 P1 核心原则

P1 不是“重写 Prompt”。

P1 只解决：

> **相同业务状态、相同冻结快照、相同模型配置，本来应该生成相同请求，但由于非业务性的序列化抖动而产生不同字节。**

必须采用：

> **先复现 → 再定位 → 最小修复 → byte equality test → 业务回归**

没有复现证据，不允许修改。

---

## 6.2 P1-1：建立 Prompt Byte Stability 测试工具

### 建议新增

```text
src/services/llm/promptByteStability.ts
__tests__/promptByteStability.test.ts
```

仅提供测试/诊断纯函数：

```ts
serializeChatMessagesForFingerprint(messages)
fingerprintChatMessages(messages)
```

建议算法：

```text
JSON.stringify(messages)
→ SHA-256
```

这里的 fingerprint 只用于诊断：

- 不进入请求 body；
- 不进入模型 Prompt；
- 不影响业务分支；
- 不代表 DeepSeek 内部真实 cache key。

### 目的

验证：

```text
同一 fixture 构建两次 → exact bytes 相同
```

而不是尝试仿造 DeepSeek cache key。

---

## 6.3 P1-2：对现有 Prompt Builder 做“只审计不默认修改”

审计范围：

```text
src/services/contextBuilder.ts
src/services/outlineContextBuilder.ts
src/services/pipelineMessages.ts
src/services/pipeline/compileStageRequest.ts
src/services/pipeline/compileBriefStageRequest.ts
src/services/pipelineTaskContext.ts
src/services/storyMemory/storyMemoryObservationMaterials.ts
src/services/storyMemory/storyMemoryObservationPrompts.ts
src/services/storyMemory/storyMemoryRequestBudget.ts
```

对每个 Builder 使用固定 fixture 连续构建多次，比较：

```text
role
message count
message order
content exact bytes
JSON.stringify(messages)
fingerprint
```

### 只有发现实际抖动才进入修复

例如：

- 同一 Map 因来源顺序不同输出不同；
- 同一 Set 因插入路径不同输出不同；
- machine-generated JSON object key 顺序不稳定；
- 同一空 section 有时省略、有时输出空标题；
- machine scaffold 出现 CRLF/LF 不一致；
- 同一内部集合没有显式稳定 comparator。

如果没有复现，记录“已稳定”，不改代码。

---

## 6.4 P1-3：保留当前已经稳定的顺序

以下路径当前已经具备明确顺序，不应为了缓存重新排序：

### Outline

```text
enabled outlines
→ position 顺序
→ 按注入顺序处理优先级
```

**严禁改为 title / id / hash 排序。**

### Character

当前项目资源查询：

```sql
ORDER BY c.id ASC
```

只加稳定性测试，不主动改顺序。

### Worldbook

当前：

```sql
ORDER BY w.position ASC, w.id ASC
```

只加稳定性测试，不主动改顺序。

### Story Memory

Character、Relationship、Foreshadowing、Timeline、Evidence 的顺序可能承载：

- firstSeen；
- lastChanged；
- opened；
- resolved；
- 时间边界；
- evidence earliest/latest；
- relevance 优先级。

**不得使用“统一 sort”覆盖现有业务顺序。**

---

## 6.5 P1-4：稳定 JSON 只允许用于“无序机器对象”

如实际审计发现 machine-generated JSON key 顺序抖动，可新增：

```text
src/utils/stableJsonStringify.ts
```

### 允许排序

仅允许递归排序：

```text
plain object keys
```

### 默认禁止排序

```text
Array
Outline list
Chapter list
Character list
Worldbook list
Evidence list
Timeline list
Finding list
Action list
Story Memory observation list
```

数组顺序一律视为可能承载业务语义，除非有明确测试和代码合同证明其为 set semantics。

---

## 6.6 P1-5：换行治理必须区分“机器 scaffold”和“用户正文”

### 可以规范化

仅对应用自己生成的固定 scaffold，例如：

```text
固定标题
固定标签
固定 contract
固定 JSON pretty-print
固定 separator
```

可以统一：

```text
CRLF → LF
```

### 禁止全局规范化

不得对以下内容做全局 replace：

```text
章节正文
大纲正文
用户笔记
角色卡原文
世界书原文
Preset 自定义文本
用户自定义指令
```

原因：

即使 CRLF/LF 通常不改变文学语义，也不应在缓存专项中修改用户原始内容表示。

---

## 6.7 P1-6：空字段/空段落稳定化

如果审计确认同一业务空值在不同路径出现：

```text
undefined
null
''
[]
省略段落
输出空标题
```

导致 Prompt 字节抖动，可以在**对应单一 Builder 内**统一表现形式。

但必须满足：

1. 该字段为空时模型原本就得不到任何业务信息；
2. 不能新增 Prompt 语义；
3. 不能改变 role；
4. 不能改变相邻业务段落顺序；
5. 不能把“无数据”误写成“数据为空”这类新的模型指令。

---

## 6.8 P1-7：禁止随机运行时信息进入 Prompt

审计所有生成消息，重点搜索：

```text
Date.now()
Math.random()
UUID
clientRequestId
attemptId
providerRequestId
runtime timestamp
```

如果只用于：

```text
日志
DB 主键
attempt ledger
trace
```

必须确保不会进入 Prompt。

注意：

Story Memory 当前 `logicalBatchId` 含 Date.now / Math.random 是**账本身份**，并不等于 Prompt 内容。

**不得为了缓存修改 logicalBatchId 生成规则，只需验证它没有进入模型消息。**

---

# 7. 明确冻结的核心生产链路

## 7.1 Draft

冻结：

- Preset 语义；
- 完整 Outline；
- Story Memory；
- Character / Note / Worldbook；
- Episodic；
- Recent Bridge；
- Current Instruction；
- 当前 budget allocator；
- FrozenDraftRequest；
- retry append-only 行为。

P0/P1 只允许：

- 统计；
- fingerprint；
- byte stability test；
- 已证明无语义的 serialization bug fix。

## 7.2 Review / FactCheck / Brief

冻结：

- 当前协议版本；
- system/user role；
- dynamic contract 信息所在位置；
- validator；
- formatter；
- repair/fresh retry 规则；
- reasoning tier。

本期即使发现这些 Stage 缓存较差，也先记录真实数据，不以此为理由调整 Prompt 结构。

## 7.3 Final / Proof

冻结全部文学质量相关输入结构：

- canonical draft；
- full outline；
- immediate previous chapter；
- story state；
- Final Writing Brief；
- continuity capsule；
- 当前顺序和角色。

Final 是文学质量最敏感节点。本期**只采集 cache telemetry，不做结构优化。**

## 7.4 Story Memory Protocol V2

V2.11.49 后整体冻结：

```text
Evidence Anchor
Entity Handle
Observation Prompt / Contract
Normalizer
Resolver
Compiler
Validator
Merger
CAS
Partial Success
3→2→1 split
Elastic Allocator
Temporal Boundary
Foreground/WakeLock/Task Store
Outcome Unknown Ledger
```

P1 对 Story Memory 的默认动作是：

```text
测试确定性
发现问题才做最小 serialization 修复
```

而不是主动改写 Prompt。

---

# 8. 测试建设

## 8.1 Provider 单测

至少覆盖：

1. DeepSeek 正常返回 hit/miss；
2. hit=0 / miss>0；
3. hit>0 / miss=0；
4. 两字段都缺失；
5. 第三方 gateway 不返回字段；
6. 字段为负数；
7. 字段为字符串数字；
8. 字段为 NaN/Infinity 风格非法值；
9. reasoning_tokens 与 cache usage 同时存在；
10. cache telemetry 不能改变 content / reasoning / finish reason。

---

## 8.2 Migration 测试

必须覆盖：

```text
fresh → Schema 51
Schema 50 → 51
重复执行 50→51 migration
旧 llm_usage_logs 数据保留
旧 pipeline_stage_attempts 数据保留
cache columns 为 NULL
用户项目/章节/Story Memory 数据 fingerprint 不变
```

必须跑项目现有：

```text
schema validation
upgrade install
user data recall snapshot
user content fingerprint
```

相关测试链。

---

## 8.3 Pipeline 回归

至少覆盖：

```text
Draft success
Draft retry
Review success/retry
FactCheck success/retry
Brief success/retry
Final/Proof success/retry
Formatter
cold-start resume
outcome_unknown
batch generation
final-only rewrite
```

新增断言：

- cache fields 只影响 attempt metadata；
- 同一 Stage 的原 requestFingerprint 生成逻辑不变；
- input/output/total token 旧统计不变；
- batch usedInputTokens / usedOutputTokens 旧预算逻辑不变；
- hit/miss 不参与 budget gate。

---

## 8.4 Story Memory 回归

必须覆盖当前最新治理：

```text
Protocol V2 observation
Evidence anchors
temporal boundary
character lifecycle
relationship lifecycle
foreshadow lifecycle
batch split 3→2→1
partial success
fresh retry
format repair
repair feasibility gate
outcome_unknown
background maintenance
non-blocking generation
```

新增缓存 telemetry 后必须证明：

```text
request count 未增加
attempt budget 未变化
logical batch id 未变化
physical request hooks 行为未变化
```

---

# 9. 穿测方案

## 9.1 第一层：纯离线回归

执行：

```text
npm run typecheck
npm run lint
npm test / 项目现有全量测试
npm run verify
```

要求：

```text
0 新增失败
0 snapshot 非预期变化
0 schema drift
```

---

## 9.2 第二层：Android 升级安装

使用真实旧版用户数据：

```text
V2.11.49 + Schema 50
→ adb install -r 新构建
→ Schema 51
```

禁止：

```text
uninstall
pm clear
```

验证：

- 项目数；
- 章节数；
- 正文字节 fingerprint；
- Outline；
- Character；
- Worldbook；
- Notes；
- Story Memory；
- Pipeline 历史任务；
- usage 历史数据。

全部保留。

---

## 9.3 第三层：真实 DeepSeek V4 Flash 长篇穿测

建议固定一个测试项目：

- 同一模型；
- 同一 API endpoint；
- 同一 reasoning tier；
- 同一完整大纲；
- 同一 ContextConfig；
- 不修改 Prompt 配置；
- 连续生成 20～50 章。

### 每次调用采集

```text
scenario
stage
model
input_tokens
prompt_cache_hit_tokens
prompt_cache_miss_tokens
output_tokens
reasoning_tokens
formatter_used
retry_count
finish_reason
```

### 汇总

```text
Draft cache hit ratio
Review cache hit ratio
FactCheck cache hit ratio
Brief cache hit ratio
Final/Proof cache hit ratio
Story Memory cache hit ratio
全局 cache hit ratio
```

---

# 10. 文学质量与用户体验验收门禁

缓存收益必须排在以下 Gate 之后。

## Gate A：上下文完整性

必须证明：

- 完整大纲仍完整；
- 最近正文策略不变；
- Story Memory 注入规则不变；
- 上一章连续性不变；
- Character/Worldbook/Note 命中逻辑不变；
- Final 上下文不减少。

任何一项变化：**NO-GO**。

## Gate B：流水线稳定性

对比改造前基线：

```text
成功率不得下降
Formatter 率不得显著上升
Retry 率不得显著上升
Validator reject 不得显著上升
outcome_unknown 不得增加
API 调用次数不得因缓存专项增加
```

出现明显劣化：**NO-GO**。

## Gate C：文学质量

至少抽样检查：

- 人物身份一致性；
- 人物状态连续；
- 时间线；
- 空间逻辑；
- 大纲执行；
- 前章承接；
- 伏笔延续；
- 语言自然度；
- 是否出现因上下文弱化导致的重复解释、角色失忆、剧情跳跃。

如果存在质量下降迹象，即使缓存命中率大幅提升，也判定：**NO-GO**。

## Gate D：缓存收益

前三层全部通过后才评价：

```text
cache_hit_tokens ↑
cache_miss_tokens ↓
cache_hit_ratio ↑
实际输入成本 ↓
TTFT 是否改善
```

**不设置强制命中率目标。**

例如：

```text
30% → 45%，但质量/稳定性完全不变：可以接受
```

而：

```text
30% → 80%，但 Prompt 顺序或文学表现发生风险：不可接受
```

---

# 11. P1 单项改动准入模板

每一个 P1 patch 都必须在 PR/施工记录中填写：

```text
【问题】
同一业务输入出现什么字节差异？

【复现】
提供两次 build 的 fingerprint / diff。

【根因】
属于 Map / Set / JSON key / generated scaffold / empty section 中哪一种？

【业务语义证明】
为什么该顺序/格式不承载业务含义？

【最小修复】
改了哪个函数？为什么不能改更大范围？

【禁止影响】
是否触及用户正文、Prompt role、信息顺序、上下文选择？必须全部为否。

【测试】
修复后 same fixture 是否 byte-identical？

【回归】
Pipeline / Story Memory / Android upgrade 是否通过？
```

缺任一项，不合并。

---

# 12. 建议实施顺序

## Step 1 — 锁定基线

```text
git fetch
记录远端 HEAD
确认施工基线 ≥ 9a032637...
保留本地未提交改动
```

如果远端在施工开始前又更新：

- 先比较新提交；
- 如果只涉及非相关模块，可继续；
- 如果涉及 LLM Provider / Pipeline / Prompt / Story Memory / migration，必须重新做边界核查后再施工。

## Step 2 — P0 Provider telemetry

完成：

```text
LLMResult
rawUsage
parsePromptCacheUsage
safeLogUsage
```

先只跑单测。

## Step 3 — Schema 51

完成：

```text
v50-to-v51
createCurrentSchema
usageRepository
pipelineStageAttemptRepository
```

跑 fresh + upgrade + recall/fingerprint 测试。

## Step 4 — Pipeline 接线

仅在 `runStageAttempt()` 成功路径写 cache metadata。

不碰业务分支。

## Step 5 — P0 统计查询

完成：

```text
summary
by scenario
by config
```

不改普通用户主 UI。

## Step 6 — P0 全量穿测

先拿到真实缓存基线。

## Step 7 — P1 byte stability audit

按 Builder 逐个测试。

**没有复现问题的 Builder：不修改。**

## Step 8 — P1 最小修复

每个根因单独 commit，禁止大包重构。

## Step 9 — 完整长篇穿测

20～50 章真实 DeepSeek V4 Flash。

先看质量 Gate，再看缓存数据。

---

# 13. Commit 建议拆分

建议至少拆为：

```text
commit 1: feat(llm): capture provider prompt cache usage
commit 2: feat(db): add nullable cache telemetry schema 51
commit 3: feat(pipeline): persist stage cache telemetry
commit 4: test(cache): add frozen request and prompt byte stability gates
commit 5+: fix(cache): one deterministic serialization root cause per commit
```

不要把 P0/P1 与 Story Memory 业务修复、Pipeline 功能修复混在同一个 commit。

---

# 14. NO-GO 条件

施工或验收期间出现任意一条，应立即停止缓存专项继续扩散：

1. Prompt role 变化；
2. Prompt 业务信息顺序变化；
3. 用户正文被格式化/规范化；
4. 完整大纲发生任何裁剪；
5. Story Memory Observer 合同变化；
6. Story Memory batch/cadence 变化；
7. reasoning tier 变化；
8. Pipeline Stage 数量/顺序变化；
9. API 请求数增加；
10. cache miss 触发 retry；
11. Formatter/Validator 行为变化；
12. 冷启动恢复逻辑变化；
13. Schema 51 导致用户数据 fingerprint 变化；
14. CursorWindow / 大行风险增加；
15. 文学连续性或大纲执行出现下降迹象。

---

# 15. 最终交付物

施工完成至少应产出：

```text
1. Schema 51 迁移代码
2. Cache usage parser + unit tests
3. llm_usage_logs cache telemetry
4. pipeline_stage_attempts cache telemetry
5. Cache summary/by-scenario/by-config 查询
6. Frozen Request byte stability regression tests
7. Prompt Byte Stability audit tests
8. P1 每个实际问题的独立修复 commit
9. Android 覆盖升级验收记录
10. DeepSeek V4 Flash 20～50 章长篇穿测报告
11. 改造前/后 cache hit/miss 对比
12. 文学质量与连续性抽检结论
```

---

# 16. 最终验收结论模板

```text
【基线】
Remote SHA:
App Version:
Schema:
DeepSeek Model:

【P0】
Cache telemetry: PASS / FAIL
Schema upgrade: PASS / FAIL
Pipeline telemetry: PASS / FAIL
Story Memory scenario telemetry: PASS / FAIL
Request count unchanged: PASS / FAIL

【P1】
Byte instability cases found:
Cases fixed:
Semantic order changed: NO / YES
User-authored text changed: NO / YES

【稳定性】
npm run verify:
Android upgrade install:
Pipeline success rate:
Formatter rate:
Retry rate:
Validator reject rate:
Story Memory regressions:

【文学质量】
Outline compliance:
Character continuity:
Timeline continuity:
Previous-chapter continuity:
Prose quality:

【缓存】
Overall hit ratio before:
Overall hit ratio after:
Draft:
Review:
FactCheck:
Brief:
Final/Proof:
Story Memory:

【结论】
GO / NO-GO
```

---

## 17. 本方案最终原则

本项目已经经历多轮 Pipeline 与 Story Memory 稳定性治理。本次缓存专项必须服从现有成熟架构，而不是让成熟架构服从缓存指标。

最终施工原则固定为：

> **先观测，后修复；先证明字节抖动，后允许改动。**

> **只优化非业务序列化差异，不优化文学语义。**

> **不为缓存删上下文、不为缓存调顺序、不为缓存降推理、不为缓存多发一次请求。**

> **缓存收益是结果指标，用户体验、文学质量和恢复正确性才是发版门槛。**
