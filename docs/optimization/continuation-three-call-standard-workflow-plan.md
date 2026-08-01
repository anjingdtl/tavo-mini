# 原著续写三次调用标准工作流改造方案

> 状态：待实施
> 日期：2026-08-02
> 范围：原著续写的生成链路、上下文预算、结果展示和自动化回归；不改 Canon 分析、定稿后的状态提取 / Story Memory outbox，也不改大纲创作流水线。

## 1. 决策与目标

续写生成统一为一条产品工作流，且一次发起最多使用三次在线 LLM 调用：

```text
冻结上下文（本地，无 LLM）
  → Writer（第 1 次）
  → Checker（第 2 次）
  → 仅有 error / blocking 时 Repair（第 3 次）
  → 本地确定性复核（无 LLM）
```

具体决策：

1. 新 run 不再调用独立 Planner，也不再等待“规划确认”。一次 Writer 调用同时生成结构化章节计划和正文：先确定章节目标、核心冲突、节拍、参与人物，再据此写正文。
2. Checker 是标准链路的一部分；其 LLM 检查结果仍与既有确定性检查合并、绑定证据并展示给用户。
3. Repair 最多一次；Repair 后不再发起第二次 LLM Checker。替代为本地确定性复核，并明确向用户标示“修复稿未经过第二次 LLM 复检”。
4. Writer 出现 reasoning-only / length 空正文时不再自动重试，避免调用数越界；本次 run 明确失败并提示换非推理模型或调整该模型的输出上限。
5. 新 run 以 Writer 的实际冻结窗口为唯一生成上下文布局依据；不以模型标称的大窗口无限增加导入资料。

目标是把常规章节从当前的 3 次调用降为 2 次，把触发自动修复的章节从 5 次降为 3 次，同时压缩 Writer 的输入预填充量。不是以牺牲 Canon 边界、原著文风、接缝或已确认状态为代价。

## 2. 已确认的当前行为与问题

| 当前行为 | 后果 | 本轮处理 |
| --- | --- | --- |
| `startContinuationRun()` 总会先发 Planner，再发 Writer | Planner 与 Writer 接收同一大部分上下文；Writer 仅使用 Planner 的目标、冲突和节拍 | 新 Writer 在同一响应中返回 plan + content，跳过独立 Planner 请求 |
| `checkerEnabled=true`、`maxRepairRounds=1` 是默认，但 UI 可把修复轮数设至 3 | 一次 run 可超出用户可忍耐的 3 次调用 | 新标准工作流强制最多一个 Repair |
| `while (true)` 在 Repair 后重回 Checker | Repair 成功时仍可能额外发一次 LLM Checker | 新 run 改成线性 Writer → Checker → Repair 状态机 |
| Writer 空正文会用更大额度重试 | Retry 加上检查/修复时会超过 3 次 | 新 run 不自动重试；失败保留明确原因 |
| 上下文按 Writer 窗口比例增长，1M 窗口可得到极大的类别预算 | 大窗口模型会收到远超单章需要的资料，增加预填充延迟和成本 | 改为由模型窗口、输出配置、章节需求和硬资料压力共同决定的弹性比例 |
| Canon 在用户要求未点名人物时可加入最多 30 位重要人物 | 每章都可能带入无关人物资料 | 用“指令 + 当前正文接缝”解析人物；主角兜底只消耗剩余 Canon 比例预算 |

必须保留的既有不变量：

- Context Builder 不为挑选上下文而额外调用 LLM。
- Canon 仍只能通过 `CanonQueryService` 读取；原著正文仍只能通过 bounded `continuationSourceReader` 读取。
- Source / Canon / 风格 / 状态快照在 run 创建时冻结；不允许中途改用活动模型或最新 Canon。
- 原著边界、未来章节隔离、前一续写章优先接缝、strict 模式门禁、采纳零回灌、定稿 outbox 和冷启动恢复行为不变。
- 不在数据库 transaction 内调用 LLM。

## 3. 新工作流的精确契约

### 3.1 调用数与状态

| 条件 | 阶段序列 | LLM 调用数 |
| --- | --- | ---: |
| Writer 正常、无严重问题 | `writer → checker → awaiting_user` | 2 |
| Checker 发现 `error` / `blocking`，本地修复无效 | `writer → checker → repair → local_verify → awaiting_user` | 3 |
| Checker 发现问题且本地修复成功 | `writer → checker → local_verify → awaiting_user` | 2 |
| Writer、Checker 或 Repair 网络/格式失败 | 在失败阶段终止；已有 Writer artifact 仍可采纳（Checker/Repair 失败降级规则沿用） | 不超过 3 |

只有 Writer 成功才落正文 artifact。Checker 失败时保留 Writer artifact 和既有“仅确定性检查”降级提示；Repair 失败时保留修复前 Writer artifact 和初次检查结果。两种情况都不得重发任何阶段。

### 3.2 合并到 Writer 的章节计划

不能用本地占位节拍替代真实章节计划，否则 Writer 在复杂场景中会失去“先收束目标、再展开正文”的约束。新 Writer 请求必须要求模型先生成可持久化的微计划，再输出按该计划完成的正文；两者属于**同一次** completion。

Writer 的唯一输出契约为 JSON object（通过已有 `responseFormat: 'json_object'` 请求），示意如下：

```json
{
  "schemaVersion": 1,
  "plan": {
    "chapterGoal": "本章要达成的推进",
    "centralConflict": "本章主要冲突",
    "beats": [{ "order": 1, "summary": "承接" }, { "order": 2, "summary": "升级" }, { "order": 3, "summary": "章末钩子" }],
    "participatingCharacterIds": [12, 18],
    "characterActions": [],
    "plotAdvances": [],
    "foreshadowingActions": [],
    "proposedStateChanges": [],
    "risks": []
  },
  "content": "只包含本章正文，不含标题或解释"
}
```

要求：

- Prompt 明确要求模型按 `plan` 的节拍完成正文，而不是先写正文、事后编一个计划；计划只服务本次写作和结果展示，不进入下一章的事实状态。
- `parseWriterResult()` 复用现有 JSON 候选恢复思路，校验 `plan` 与非空 `content`。成功后先 `savePlan(runId, plan, 'not_required')`，再以 `content` 落 Writer artifact。
- JSON 不可解析、缺少正文、或正文为空时，本次 Writer 失败且不重试；不能把 JSON 包装、计划字段或模型解释误采纳为章节正文。
- 结果页可以展示“本次生成计划”，但文案须说明其与正文由一次 Writer 调用共同生成、没有单独 Planner 或用户确认步骤。

这保留章节目标、核心冲突、节拍与参与人物的真实模型判断，同时消除独立 Planner 发送一遍完整上下文的网络往返。

### 3.3 Repair 后的结果与安全门槛

Repair 仍接收冻结 Canon、状态、风格和初次 `open` 的 error / blocking 问题，输出完整替换正文。成功后：

1. 新 repair artifact 仍按既有 parent artifact / hash 关系持久化；
2. 对 repair artifact 运行 `runDeterministicChecks()`，并写入该 artifact 的检查结果；不调用 Checker LLM；
3. 原 artifact 的检查结果保留为修复依据，并标为 `auto_repaired` 或 `obsolete`（仅在确认无对应修复时使用）；结果页能查看“修复前问题”；
4. repair artifact 的本地检查仍含 `source_overlap` 或 `continuation_anchor_overlap` error 时，继续禁止采纳；其他问题沿用当前“可查看、由用户决定”的审核策略；
5. 结果页显示“已自动修复 1 轮；已完成本地复核，未进行第二次 LLM 复检”。

不得把 Repair 自己的“已修复”文字当作独立事实验证，也不得把它标示为“检查完全通过”。

## 4. 上下文与自动预算重设计

### 4.1 完全由模型容量驱动的预算

本轮**不新增任何绝对 token 上限、保留量或章节长度分段阈值**。所有 Writer 输入 / 输出预算均由冻结 Writer LLM 配置、目标章节长度和实际硬资料体积推导：

这不是把 80% / 20% 误称为供应商的固定要求，而是本应用的容量安全策略。DeepSeek 官方说明 `input + generated tokens` 受模型 context length 共同限制，并要求 JSON 输出设置合理的 `max_tokens`，否则可能截断；其 V4 模型页当前标称 1M context 和最高 384K output，仍不表示客户端应填满窗口。[Chat Completion 文档](https://api-docs.deepseek.com/api/create-chat-completion) · [模型规格](https://api-docs.deepseek.com/quick_start/pricing/?article_id=article_1779470751466_8) · [JSON Output 注意事项](https://api-docs.deepseek.com/guides/json_mode/)

```ts
window = writerConfig.context_window;
declaredOutput = writerConfig.max_output_tokens ?? window;
// 产品安全窗口：永不把供应商标称上下文 100% 填满。
effectiveWindow = floor(window * policy.contextUtilizationRatio); // 80%
outputShareCap = floor(window * policy.maxOutputRatio); // 20%
chapterDemand = estimateTargetChapterTokens(targetChapterChars);

// 全部是比例；比例随“章节需求占模型窗口的压力”连续变化。
pressure = clamp(chapterDemand / window, 0, 1);
planShare = interpolate(policy.minPlanShare, policy.maxPlanShare, pressure);
minimumProseShare = interpolate(
  policy.minProseCompletionShare,
  policy.maxProseCompletionShare,
  pressure,
);

desiredOutput = chapterDemand / (1 - planShare);
minimumOutput = chapterDemand * minimumProseShare / (1 - planShare);
```

`policy.*` 仅是版本化的**比例策略**，不包含 token 常量；其和、单调性和边界由纯函数测试固定。`planShare` 是同次 JSON 中章节目标 / 冲突 / 节拍 / 人物计划占 Writer completion 的比例预留，剩余为正文。它随章节相对模型窗口的压力上升而提高，避免小窗口时计划吞掉正文，也避免大窗口时计划被压缩得不可用。

预算以如下顺序收敛：

1. 先按当前 source / Canon / locked rules 的实际内容计算 `hardContextTokens`；这些资料不可被软资料挤掉。
2. 对 Writer、Checker、Repair 分别以各自冻结模型的 `context_window × 80%` 作为 `effectiveWindow`，再把它传入既有 `planStageCapacity()`；不能把任一供应商标称窗口 100% 当作可用窗口。
3. 根据 `effectiveWindow`、既有 `planStageCapacity()` 的 safety / skeleton、`hardContextTokens`，计算当前请求可用的 `windowOutputCapacity`。
4. `requestedMaxTokens = min(desiredOutput, declaredOutput, outputShareCap, windowOutputCapacity)`；因此单次输出始终不超过原始模型窗口的约 20%。没有配置 `max_output_tokens` 时，`declaredOutput` 仅表示窗口可允许的输出容量，而非假定的固定默认值。
5. `effectiveInputBudget = effectiveWindow - requestedMaxTokens - safety - skeleton`；扣除 hardContext 后的剩余才分配给 Canon、接缝、记忆、文风和补充资料。
6. 编译 Writer messages 后执行最终 preflight，使用真实 `estimateMessagesTokens(messages)` 再计算一次可用 completion，并把 `requestedMaxTokens` 收紧到该值；`promptTokens + requestedMaxTokens` 必须始终不超过 `effectiveWindow`。
7. 若最终 completion 小于由 `chapterDemand` 和 `minimumProseShare` 推出的 `minimumOutput`，则在网络请求前显式阻断，提示用户调整目标字数或选择具有更大 `context_window` / `max_output_tokens` 的 Writer 配置；不截断计划、不静默砍正文、不增加 Retry。

因此 8K、32K、128K、1M 模型会得到不同但可解释的 Writer 输入 / 输出比例：每个请求最多使用模型标称窗口的 80%，其中输出最多占原窗口约 20%，其余安全余量不参与拼接。大窗口会自然增加有效资料容量，但不会因为标称窗口变大而绕过每类资料的比例权重；小窗口则先保证硬事实、计划和最低正文完成能力。

`ContinuationContextTrace` 需记录 `window`、`effectiveWindow`、`contextUtilizationRatio`、`maxOutputRatio`、`declaredOutput`、`chapterDemand`、`pressure`、`planShare`、`hardContextTokens`、`desiredOutput`、`requestedMaxTokens`、`effectiveInputBudget`、`minimumOutput` 与受限原因，使“模型能装多少”和“本章为何这样分配”可区分。

### 4.2 Writer 类别弹性比例

先从 `effectiveInputBudget` 装入用户锁定规则和 hard Canon；二者超出可用预算时维持现有显式阻断，不进行静默裁剪。下表的基础权重作用于扣除这两类硬资料后的 `residualContextBudget`，不代表固定 token 数。

每类最终份额由 `normalize(baseWeight × dynamicMultiplier)` 得到：`dynamicMultiplier` 读取本章 `pressure`、`declaredOutput / window` 和是否存在续写 primary anchor。它使小窗口 / 高输出压力时优先当前接缝、硬相关 Canon 和文风，自动压缩 supplements / historical digest；窗口富余时才渐进增加 Story Memory、recent bridge 与 episodic。所有份额每次重新归一，合计恒为 100%。

| 类别 | 基础权重 | 弹性取舍规则 |
| --- | --- | --- |
| 用户锁定规则 + hard Canon | 硬性优先 | 先装入；不足即阻断 |
| 相关 Canon（人物、关系、状态、知识、剧情、时间线） | 30% | 先相关、后主角兜底；按重要性和与 query 的匹配排序；压力高时提高权重 |
| 当前正文接缝 | 25% | 始终从章末裁取；存在续写 anchor 或压力高时提高权重，优先于最近桥接 |
| Story Memory | 15% | 仅使用 eligible checkpoint；窗口富余时渐进扩展 |
| 最近续写桥接 | 10% | 排除 primary anchor，按新到旧取尾段；窗口富余时渐进扩展 |
| 原著风格画像 | 10% | 保持 strict 必注入；不足时按现有 renderer 降至 compact，不允许关闭 |
| episodic 和记忆补充 | 7% | 与 primary anchor / recent 去重；低压力时才扩大 |
| 外部补充资料 | 3% | 最先被裁剪，且仅显式 external supplement |

实现时硬资料加上 `residualContextBudget` 必须小于等于有效输入预算；`planStageCapacity()` 已为系统提示骨架和安全余量预留空间，编译后的最终 preflight 再处理消息格式和 token 估算误差。历史 digest 属于最弱资料，从 episodic / supplement 共享软预算中扣除；不要再额外占用未记账的比例。

### 4.3 Canon 收敛策略

`buildContinuationContext()` 调整顺序：

1. 读取最近续写章节，选定并冻结 `primaryAnchor`；只有不存在前序正文时才读取原著边界尾段。
2. 将“用户要求 + 当前接缝尾段 + 当前章 synopsis”组成实体解析 query；通过 `CanonQueryService` 解析人物，不能在 UI / Generation 层直查 Canon 表。Writer 产出的参与人物是计划结果，不能倒灌为本次请求的前置 LLM 调用。
3. `CanonQueryService.getContextBundle()` 新增相关性 query 和预算策略参数；不再以固定人物数量作为主角兜底，而是由剩余 Canon 比例预算决定可装入多少完整人物条目。
4. 优先装入命中人物及其有效关系、状态、知识、经历和关联剧情；未命中人物只在剩余 Canon 预算内按重要性逐项补入。
5. Canon service 内部的 token packing 必须先锁定 hard world rules，再做相关条目的优先队列，不能让主角资料挤掉世界硬规则。

这一步是上下文压缩的核心。不能只在最终字符串上截断，否则会破坏 Canon 条目完整性、证据编号与 Checker 的引用关系。

### 4.4 Checker / Repair 的独立预算

- Checker 不需要 Writer 的接缝、recent、Story Memory 和 episodic；继续只编译 Canon、有效状态、风格、锁定规则、外部补充和待检正文。
- Checker 的实际消息必须先按其冻结模型窗口的 80% 计算 `effectiveWindow`，再使用 `planStageCapacity()` 预检；若 Checker 窗口不足，走“确定性检查降级”，不缩小 Writer 上下文，也不重新生成正文。
- Repair 只携带 open error / blocking、对应事实依据、风格约束和完整待修正文；不重新注入接缝、recent、长期记忆、历史摘要或外部补充。
- Writer / Checker / Repair 的 `estimateMessagesTokens(messages) + maxTokens + safety` 都必须在发请求前验证实际冻结窗口。不能以 Writer 的预览预算代替 Checker / Repair 的安全检查。

## 5. 代码改造分解

### P1：定义新 run 协议与兼容分流

涉及：

- `src/services/continuation/generation/types.ts`
- `src/services/continuation/generation/continuationGenerationRunner.ts`
- `src/services/continuation/generation/generationRepository.ts`

实施：

1. 为新冻结 snapshot 增加 `workflowVersion: 2`（或等价的明确字段），不修改数据库 schema；已有 snapshot 按 legacy 路径处理。
2. 新 run 的 settings snapshot 保留 planner 字段以兼容旧备份 / 旧类型，但标记为不参与调用；只解析并冻结 Writer、Checker、Repair、State Extraction 的实际模型配置。
3. 新 run 持久化阶段初值为 `writer`，不进入 `planner`；Writer 返回有效 JSON 后才 `savePlan(runId, plan, 'not_required')`，再落正文 artifact。
4. 新 run 的 `runStages` 改为明确的线性函数，禁止 `while (true)` 形成重复 LLM Checker；以一个请求计数守卫断言任何新 run 的 LLM stage call 不超过 3。
5. schemaVersion ≤ 2 / 没有 `workflowVersion` 的历史 run 保留旧 Planner、确认和 Repair 后复检恢复路径，确保冷启动 resume、已在等待确认的 run、已持久化 artifact 都不会改变语义。

不迁移、不删除现有 `planner_*`、`planner_confirmation_policy`、`checker_enabled` 或 `max_repair_rounds` 数据列，避免备份、恢复和历史 run 发生破坏性变化；新 UI 不再暴露 Planner 和“多轮 Repair”控制。

### P2：重写新标准编排

涉及：

- `src/services/continuation/generation/continuationGenerationRunner.ts`
- `src/services/continuation/generation/continuationRepairService.ts`
- `src/services/continuation/generation/generationRepository.ts`

实施：

1. Writer 使用新的 JSON 输出契约；先解析并持久化 plan，再立即持久化 `content` artifact。Writer JSON 不可解析、空正文 / reasoning-only / length 不再 retry，终止为 `failed`，保留准确的 `emptyReason`。
2. 运行本地确定性 Checker，然后最多调用一次 LLM Checker；保留当前 LLM Checker 异常降级，不让网络波动废弃 Writer artifact。
3. 仅当合并后的 open issue 中存在 error / blocking 时，先尝试 `tryDeterministicRepair()`；无本地修复才发一次 Repair LLM。
4. Repair 后仅执行本地确定性检查；不再进入 LLM Checker。Repair 异常继续保留 Writer artifact 和初检结果。
5. 增加批量更新检查状态的 repository 方法（例如 `markChecksAutoRepaired`），并新增按 run 获取检查历史的只读查询，供结果页展示修复依据与 repair artifact 的本地复核结果。
6. 采纳前的 `source_overlap` / `continuation_anchor_overlap` 硬门槛必须基于最终 artifact 的本地复核结果，不能因取消第二次 LLM Checker 而失效。

### P3：上下文预算与 Canon 检索收敛

涉及：

- `src/services/continuation/generation/continuationContextBudget.ts`
- `src/services/continuation/generation/continuationContextBuilder.ts`
- `src/services/continuation/canon/canonQueryService.ts`
- 必要时 `src/services/continuation/canon/canonRepository.ts`
- `src/services/continuation/generation/continuationContextTrace.ts` / `types.ts`

实施：

1. 在纯函数预算层实现上述 Writer 输出推导和类别弹性比例，覆盖 8K、32K、128K、1M 的单元测试。
2. Context Builder 先选 anchor 再构造 Canon query；保持第二篇及以后绝不读取 / 注入原著正文接缝的现有优化。
3. 通过 CanonQueryService 实现相关人物 + 6 名主角兜底、hard rule 优先和条目完整的 budget pack；不得将 30 名人物硬编码搬到 Generation 层。
4. 对 Style 保留 strict 注入、profile hash / analyzer version 校验和 compact 降级；不得因“快速”目标关闭或绕过风格画像。
5. 明确 trace 中每类的候选数、选中数、token、丢弃原因和有效总预算；其总数必须与最终 Writer messages 的估算值交叉校验。

### P4：提示、设置和结果页

涉及：

- `src/services/continuation/generation/continuationPromptCompiler.ts`
- `src/screens/continuation/ContinuationGenerationConfigScreen.tsx`
- `src/screens/continuation/ContinuationResultScreen.tsx`
- `src/screens/ContextPreviewScreen.tsx`

实施：

1. 新 Writer prompt 将用户本章要求作为最高优先级任务，并要求“先在 `plan` 中确定目标、冲突和节拍，再在 `content` 中严格落实”；保留 Canon、接缝、状态、文风和禁止复制原著等硬规则。
2. Planner prompt / UI 入口不再用于新 run，但保留编译函数供 legacy run resume；不删除旧历史数据的展示能力。
3. 续写配置页移除 Planner 模型、规划确认和最大修复轮次；保留 Writer、Checker、Repair、State Extraction 的模型选择，并说明“一次续写最多 3 次模型调用”。
4. 结果页删除新 run 的“独立 Planner”成功卡，改为展示“Writer 同次生成的章节计划”；同时展示 Writer、Checker、Repair（若发生）、本地复核以及每阶段耗时 / input / output token / 调用次数。
5. 上下文预览仅展示新链路实际会发送的 Writer 请求；可在有占位正文时预览 Checker 模板，但不得继续把 Planner 请求当作实际请求展示。

### P5：可观测性与真实验收

在现有 `tokenUsageJson` 中增加非敏感阶段遥测，无需 schema migration：

```ts
stages: {
  writer?: { requestCount, startedAt, finishedAt, durationMs, estimatedPromptTokens, requestedMaxTokens, chapterDemandTokens, planShare, minimumOutputTokens, prompt?, completion?, emptyReason? },
  checker?: { requestCount, startedAt, finishedAt, durationMs, estimatedPromptTokens, requestedMaxTokens, prompt?, completion?, warning? },
  repair?: { requestCount, startedAt, finishedAt, durationMs, estimatedPromptTokens, requestedMaxTokens, prompt?, completion?, skippedReason? }
}
```

不得记录 prompt、正文、API key 或完整错误响应。现有 `contextTraceJson` 继续只保存类别摘要，不保存敏感原文。

## 6. 回归风险清单（此前续写改动的坑必须覆盖）

| 风险 | 强制防线 |
| --- | --- |
| 继续从原著末章而非上一续写章起笔 | Builder 先选 `primaryAnchor`；后续章不读取 source boundary 正文；沿用 anchor 测试 |
| 超大 context 引发 Android 内存峰值 / 卡顿 | 不在 run insert 时同时 stringify 大 trace；按有效容量弹性分配；不读取全项目章节正文 |
| Planner / Writer / Checker 不同模型窗口混用 | 每次调用都按该阶段冻结 config preflight；Writer 布局不错误取全阶段最小窗口 |
| 严格文风被优化开关关闭 | style profile 仍为 required，compact 是降级级别而非关闭 |
| Repair 后正文与检查结果错挂 | artifact hash、parent artifact、UTF-16 位置绑定不变；初检历史与最终本地复核分开显示 |
| 自动修复把可采纳正文变为 failed | Repair 网络失败时退回 Writer artifact；不丢弃已有结果 |
| 冷启动恢复重跑或重复计费 | 新 snapshot workflowVersion 决定恢复分支；已成功 artifact 不重发 Writer；调用数守卫计入 resume |
| 旧 run 无法确认 / 恢复 | 未标记 workflowVersion 的 run 完整保留 legacy Planner 流程 |
| 合并 Writer 后计划/正文混入章节 | 严格 JSON schema、`content` 单独落 artifact、解析失败不做文本兜底；计划永不写入章节正文 |
| 删除 Planner 后状态提取模型丢失 | `resolvedModelConfigIds.stateExtraction` 继续冻结在 run snapshot；定稿 outbox 行为不动 |
| 直接采纳大段重复接缝 | 最终 artifact 的本地 overlap 检查仍是硬门槛 |

## 7. 测试与验收计划

### 7.1 单元 / 集成测试

新增或更新以下测试：

1. `continuationStandardWorkflow.test.ts`：
   - 正常 Writer + Checker 恰好 2 次 `callStage`，从不调用 planner；Writer 单次 JSON 同时保存有效 plan 与纯正文 artifact；
   - 章节需求、计划份额、模型上限和最终 preflight 均按冻结配置弹性推导；小于 minimumOutput 时不发请求；
   - Checker 出现严重问题时恰好调用 Writer、Checker、Repair 各一次；
   - Repair 后只运行本地检查，不再请求 Checker；
   - Writer reasoning-only / length 不发 retry，调用数为 1；
   - Checker / Repair 失败保留已有 artifact，且调用数不超限；
   - resume 新 run 仍遵守 3 次上限。
2. `continuationLegacyWorkflowResume.test.ts`：已有 schemaVersion 1 / 2 snapshot 的 planner confirm、writer、checker/repair 中断恢复仍走旧兼容路径。
3. `continuationContextBudget.test.ts` 与 `continuationStageBudgets.test.ts`：
   - 8K、32K、128K、1M 的每个阶段均满足 `prompt + completion ≤ context_window × 80%`，且 `completion ≤ context_window × 20%`；
   - 8K / 3000 字配置以及不同输出上限配置均能按比例同时分配上下文和 Writer completion；若模型配置无法同时容纳计划与最低正文，则在请求前给出可操作的阻断原因；
   - 大窗口下，同一章节的类别份额按压力连续变化、总和严格不超实际 Writer input budget，且不使用绝对 token 上限；
   - hard Canon / locked 超预算显式阻断；
   - 类别和、style compact、输出预留和 preflight 均正确。
4. `canonQueryService.test.ts`：
   - 命名人物 / anchor 人物优先；
   - 未命名场景的主角兜底随剩余 Canon 比例预算增减，不使用固定人数；
   - 世界 hard rule 不被角色资料挤出；
   - 所有条目仍来自同一个 snapshot / boundary，证据索引正确。
5. `continuationAnchor.test.ts`、`continuationSequentialGeneration.test.ts`：连续 30 章仍只使用上一续写接缝、无未来原著泄漏、上下文有界。
6. `continuationResultScreen.test.tsx`、`continuationGenerationConfigScreen.test.tsx`、`ContextPreview` 相关测试：不展示 Planner；Repair 后的“本地复核 / 未二次 LLM 复检”与阶段指标正确。
7. 既有 Phase 3、repository、outbox、style injection、fact check、迁移矩阵测试全部回归，尤其验证无 schema migration 时的 backup / legacy 读取。

### 7.2 设备验收

同一项目、同一模型、同一 3000 字续写要求，在 8K 和至少一个大窗口模型各跑一次：

| 验收项 | 通过标准 |
| --- | --- |
| 正常章调用数 | Writer + Checker，恰好 2 次 |
| 触发修复的章调用数 | Writer + Checker + Repair，恰好 3 次 |
| 上下文 | 预览和结果 trace 显示弹性分配依据；大窗口不随标称窗口无界注入 |
| 接缝 | 第二章开始只出现最近续写章末，不出现原著末章正文 |
| 文风 / Canon | 文风画像仍注入；hard Canon 和锁定规则不丢失 |
| 失败恢复 | 杀进程后恢复不重复已成功阶段，且不突破调用上限 |
| 定稿闭环 | 采纳、编辑、定稿、extract_state / Story Memory outbox 与冻结 state-extraction 模型均正常 |

### 7.3 工程门禁

按顺序执行：

```powershell
npx jest __tests__/continuationStandardWorkflow.test.ts --runInBand
npx jest __tests__/continuationContextBudget.test.ts __tests__/continuationStageBudgets.test.ts __tests__/canonQueryService.test.ts --runInBand
npm run lint
npm run typecheck
npm run test:ci
npm run apk:debug
```

正式 Release APK 不属于本轮计划；若后续明确要求构建，先遵循 `docs/RELEASE_APK_BUILD.md`。

## 8. 实施顺序与提交边界

1. P1 + P2：先落地 workflowVersion、线性三次调用守卫、旧 run 兼容和核心测试；此时先不压缩上下文，确保调用语义正确。
2. P3：加入弹性上下文比例、Canon 收敛与输出 preflight；补全 8K 至 1M 的预算及 future-leakage 回归。
3. P4 + P5：更新设置页、结果页、上下文预览和阶段遥测；完成真实设备调用数核验。
4. 每个阶段独立提交，避免把 runner 状态机、Canon 检索和 UI 文案混在不可回滚的大改动中。

## 9. 非目标

- 不引入新的“快速 / 标准 / 严谨”多模式界面；产品只有本方案定义的一条标准生成链路。
- 不删除历史 Planner 数据，也不破坏已经在等待 Planner 确认的 run。
- 不并行 Writer 与 Checker；Checker 必须检查实际 Writer artifact。
- 不在本轮重写 Canon 分析、风格分析、State Extraction 或 Story Memory 算法。
- 不为了三次上限偷偷跳过 hard Canon、原著风格、接缝、future-leakage 或采纳前 overlap 门槛。
