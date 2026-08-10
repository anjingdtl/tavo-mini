# Tavo Mini / ShineWriter — Story Memory P1 无阻滞 + P2 保守并发收束方案 V3（Remote HEAD Aligned）

> 文档定位：交本地 Agent 直接执行代码审计、改造、回归、真实 LLM 穿测与发版收口。  
> 目标模块：Story Memory / 长期记忆初始化、增量整理、Coverage Gate、Dirty Rebuild、Full Rebuild、Legacy Bootstrap。  
> 优先级：**P1 无阻滞与正确性 > P2 保守提速**。  
> 远端核查时间：2026-08-10。  
> 核查基线：`origin/main@90a6564ac21637ef0f30b3f0cabeeecec79694fb`。  
> 应用版本：`V2.11.40 / versionCode 2114000`。  
> 数据库：`SCHEMA_VERSION = 49`。  
>
> **重要：Agent 开工时必须重新 `git fetch --all --prune`，以本地工作区 + 当时真实 `origin/main` 为唯一事实源。本文 HEAD 只表示本次审计基线，不允许为了对齐本文而回退代码。**

---

# 0. 本轮结论

当前 Story Memory 已经完成了相当一部分 P0/P1 修复，但**还不能判定“P1 无阻滞”完成**，P2 也仅完成了进程内 single-flight 去重，尚未实现我们定义的保守并发。

本轮不应推倒重写，而应在现有实现上继续收束。

## 0.1 已经完成、不要重复改造

当前远端已经具备：

1. 最近原文硬上限 `10` 章；
2. Smart 默认约每 `10` 章触发；
3. 内部 Story Memory LLM Batch 默认 `3` 章，与 10 章触发周期解耦；
4. `reasoning_only / empty / length / no_choices / content_filter` 分类；
5. 长输出预算按活动模型 `context_window / max_output_tokens` 收口；
6. 3 章放不下时可 `3 → 2+1 → 1+1` 拆分；
7. Split Batch 第一半成功、第二半失败时，已成功 Checkpoint 不回退；
8. Rebuild 部分成功后不再把整个长期记忆错误回写为 `empty/failed`；
9. `runStoryMemoryTaskOnce()` 已实现同进程、同 key 的 single-flight 去重；
10. Provider 已能区分业务 `content` 与 `reasoning_content`；
11. 最新统一写作流水线已经具备后台运行基础设施。

这些能力应当**保留并补强测试**，不要重新造第二套 Provider、第二套 Story Memory 状态机或第二套并发框架。

---

# 1. 当前远端仍存在的核心问题

## P1-Blocker A：写作主链路仍会同步等待 Story Memory LLM

当前 `prepareStoryMemoryForGeneration(..., mode='generation')` 在 `coverage.hardDue` 时会：

```text
prepare
→ runStoryMemoryTaskOnce
→ withProjectMemoryLock
→ rebuild / advance
→ await Story Memory LLM
→ 成功或失败后才返回
```

这意味着：

> “Memory 最终失败后允许降级” ≠ “写作无阻滞”。

当前 `story_memory_*` 场景沿用长请求超时，单个请求客户端总超时可达到约 300 秒；而 Story Memory 自身又有重试、Repair、Split。即使最后能进入 degraded，用户仍可能在真正开始写作之前长时间等待。

### 本轮必须改成

```text
写作准备
→ 只做本地 DB + Coverage 判定
→ 不在 Context Builder / Prepare 内同步等待 Story Memory 网络请求
```

Story Memory Maintenance 必须与写作主链路解耦。

---

## P1-Blocker B：“最多 3 次物理请求”目前不是事实

当前 Story Memory 外层有：

```text
STORY_MEMORY_MAX_PHYSICAL_REQUESTS = 3
```

但 `requestPatch()` / `requestCheckpoint()` 内部仍各自对 timeout / network / 429 / 5xx 做最多 2 次请求。

此外 OpenAI-compatible Provider 在：

- `response_format` 不支持；
- `thinking: disabled` 扩展不支持；

时还可能执行协议兼容 fallback 请求。

因此目前实际结构可能成为：

```text
外层 Attempt 1
  └─ 内层 HTTP 1 / HTTP 2
外层 Attempt 2
  └─ 内层 HTTP 1 / HTTP 2
外层 Attempt 3
  └─ 内层 HTTP 1 / HTTP 2
```

再叠加 Provider fallback 后，**“3 physical requests”只是注释目标，不是网络层真实上限**。

这直接影响：

- 重复收费；
- 429；
- 超时尾延迟；
- outcome_unknown；
- 用户对“一次整理”的真实成本预期。

---

## P1-Blocker C：Story Memory 并没有在所有请求分支强制 Non-Thinking

当前主请求初始化时：

```ts
thinking = undefined
```

只有遇到 `reasoning_only` 后，下一次 fresh retry 才设置：

```ts
{ type: 'disabled' }
```

而以下路径仍可能以 `thinking: undefined` 发出：

- Primary；
- 普通 empty retry；
- length retry；
- invalid JSON Repair；
- fresh retry after parse failure；
- checkpoint；
- legacy bootstrap；
- dirty rebuild。

这与我们此前定义的目标不一致：

> **Story Memory 是结构化抽取任务，不应继承或依赖创作型 Thinking 行为；所有 Story Memory 逻辑请求都应统一走 Non-Thinking structured policy。**

---

## P1-Blocker D：当前 Coverage 语义与此前安全边界发生偏移

此前我们已确定：

```text
安全 Coverage 完整
→ Memory 故障可以降级继续写

存在 hard coverage gap
→ 仍然安全阻断
```

当前远端 P0 修复则把 coverage gap 也改成 degraded，并允许用户确认“继续生成”。

这虽然减少了“卡死”，但会产生另一种风险：

```text
较早章节既没有可用 Checkpoint
也没有 Episodic Summary
又超出 Recent Raw 10 章
→ 系统仍可能继续生成
```

这等价于用“不卡”换取历史断层。

### V3 明确恢复原安全原则

> **无阻滞不是无条件绕过长期记忆。真正的 Gate 是 Coverage Completeness，而不是 Memory API 成败。**

---

## P1-Blocker E：single-flight 只是进程内去重，不是 Durable Resume

当前：

```ts
const inflightTasks = new Map<string, Promise<unknown>>();
```

只能解决同一进程中的重复调用。

App 被强杀后：

```text
inflight map = 丢失
```

现有 Checkpoint / Batch 可以保证“已成功的数据不会丢”，这是好事；但仍缺少一个可靠的“请求已发出但结果未知”的持久化事实。

因此对于：

```text
HTTP 已送出
→ App force-stop
→ Provider 可能已经计费并执行
→ 冷启动
```

系统目前无法仅凭进程内 single-flight 判断是否应自动重发。

P1 必须把：

```text
safe retry
vs
outcome unknown
```

在持久层也区分开。

---

# 2. V3 的总体架构

```text
                         Story Memory
                              │
              ┌───────────────┴────────────────┐
              │                                │
              ▼                                ▼
     Readiness / Coverage Gate          Maintenance Coordinator
       纯本地、零 LLM                    后台、可恢复、有界
              │                                │
       ┌──────┴──────┐                         ▼
       │             │                Structured LLM Policy
       ▼             ▼                  Thinking Disabled
 Safe Coverage    Hard Gap                      │
       │             │                         ▼
       │             │                 Attempt Budget Ledger
       │             │                   真正物理请求计数
       │             │                         │
       │             │             ┌───────────┴───────────┐
       │             │             │                       │
       ▼             ▼             ▼                       ▼
 立即继续写作     立即安全阻断      P1 Stateful Serial      P2 Observation Pool
 后台补 Memory    不暗等 LLM       Checkpoint/Reducer       concurrency <= 2
                                                    │
                                                    ▼
                                             Ordered Reduce = 1
```

核心原则：

```text
写作主链路不暗等 Memory
+
Hard Gap 不冒险
+
Story Memory 全部 Non-Thinking
+
所有 HTTP 真正有界
+
成功 Checkpoint 永不回退
+
outcome_unknown 不静默重发
+
P2 只并发 Stateless Extraction
+
State Reduce 永远有序串行
```

---

# 3. P1-01：拆开 Readiness 与 Maintenance

## 3.1 新的 Readiness 必须是纯本地函数

建议将当前 `prepareStoryMemoryForGeneration()` 的职责拆分。

推荐形态：

```ts
analyzeStoryMemoryReadiness(...)
```

只允许读取：

- chapters；
- project_story_memory；
- memory_summary；
- policy；
- Coverage Planner。

**禁止：**

- callLLM；
- rebuild；
- advance；
- 等待 project memory lock 中的网络任务；
- 在 Context Builder 内产生 Story Memory 网络副作用。

返回建议：

```ts
interface StoryMemoryReadiness {
  fatal: boolean;
  degraded: boolean;
  hardGap: boolean;

  checkpointUsable: boolean;
  coverage: StoryMemoryCoveragePlan;

  maintenanceDue: boolean;
  maintenanceReason:
    | 'none'
    | 'interval'
    | 'dirty'
    | 'coverage_gap'
    | 'manual';

  warnings: StoryMemoryPrepareWarning[];
}
```

---

# 4. P1-02：恢复正确 Coverage Gate

生成 Chapter T 时，本地先判断：

```text
最后可用 Checkpoint = C
目标章节 = T
```

系统必须证明：

```text
Checkpoint C
+
C+1 ... T-1 的 Episodic / Pending Bridge
+
Recent Raw <= 10
```

形成连续 Coverage。

## 4.1 Safe Coverage

例如：

```text
Checkpoint through = 6
第7～13章有可用 Episodic Summary
第14～23章属于最近10章 Raw Window
目标 = 第24章
```

即使后台 Memory 更新失败：

```text
Coverage 仍完整
```

则：

```text
立即允许写作
+
后台触发 Maintenance
+
只显示非阻塞状态提示
```

**不得弹阻塞式确认框要求用户每次手动选择“继续生成”。**

建议 UI：

> 长期记忆正在后台补全，本次写作已使用已整理记忆、章节摘要和近期正文。

---

## 4.2 Hard Coverage Gap

例如：

```text
Checkpoint through = 6
第7章无 Episodic
第7章又已超出 Recent Raw 10
```

则：

```text
hardGap = true
```

必须：

```text
立即安全阻断写作
```

但注意：

> **“阻断”必须是一个立即返回的本地安全判定，不允许通过同步等待 300 秒 Story Memory LLM 来实现。**

UI：

> 第7～X章存在未覆盖的历史信息，暂不能安全生成。长期记忆正在整理；你可以进入「故事记忆」查看进度。

可同时启动后台 Maintenance。

Maintenance 完成后：

```text
重新本地评估 Coverage
→ Gap 关闭
→ 用户再次生成即可直接通过
```

---

# 5. P1-03：章节定稿必须 Local First + Return First

当前已经做到：

```text
Step A：先本地 finalize
```

这一点必须保留。

但之后不应继续在用户定稿调用链中同步：

```text
await rebuild
await advance
```

正式目标：

```text
用户点定稿
→ 本地章节状态/正文原子落库
→ 计算 Memory due
→ enqueue / signal Story Memory Maintenance
→ 立即返回“章节已定稿”
```

后台再：

```text
advance / rebuild
```

因此普通网络错误永远不能让：

```text
“章节定稿按钮”
```

表现成等待 Memory 完成。

### 例外

用户主动在 Story Memory 页面点击：

```text
立即整理长期记忆
完整重建
```

这是显式 Maintenance 操作，可以展示前台进度并等待；但必须：

- 可取消；
- 可后台运行；
- 可从最后成功 Checkpoint/Observation 恢复；
- 不影响章节正文安全。

---

# 6. P1-04：Story Memory 统一 Structured Non-Thinking Policy

必须建立**唯一** Story Memory 请求策略入口。

优先复用现有 LLM `thinking` / `responseFormat` 能力，不新增 Provider。

建议：

```ts
const STORY_MEMORY_STRUCTURED_POLICY = {
  temperature: 0.1,
  responseFormat: 'json_object',
  thinking: { type: 'disabled' as const },
  queueClass: 'background',
};
```

或现有公共 resolver 的等价实现。

覆盖全部逻辑请求：

```text
Primary
Fresh Retry
Invalid JSON Repair
Length Retry
Split Child
Checkpoint
Legacy Bootstrap
Dirty Rebuild
Full Rebuild
Retry after restart
P2 Observation Extraction
```

全部：

```text
Thinking disabled
```

### Provider Compatibility Fallback

如果兼容网关明确 400 拒绝：

```text
thinking: disabled
```

Provider 可以按现有兼容策略删除扩展字段后重发。

但：

1. 这仍然算一次新的 **physical HTTP request**；
2. 必须进入 Attempt Budget；
3. 删除字段不允许自动加入 `reasoning_effort`；
4. 若 fallback 后再次出现 reasoning-only，仍按 Story Memory Response Policy 处理；
5. 不得把“请用户自己关闭 Thinking”作为首要恢复方式。

---

# 7. P1-05：真正统一 Physical Request Budget

本轮必须消灭：

```text
外层 retry
+
requestCheckpoint/requestPatch 内层 retry
+
Provider fallback retry
```

三个互不知情的重试层。

## 7.1 唯一计数器

建议建立：

```ts
interface StoryMemoryAttemptBudget {
  logicalBatchId: string;
  maxPhysicalRequests: number;
  usedPhysicalRequests: number;

  consume(kind: StoryMemoryPhysicalRequestKind): void;
}
```

每一次真正执行：

```ts
fetch(...)
```

前都必须 consume。

必须统计：

```text
primary
safe_retry
format_repair
fresh_retry
length_retry
protocol_fallback
split_child request
```

## 7.2 Child Batch 上限

一个 logical child batch：

```text
最多 3 次真实 HTTP
```

这 3 次已经包含：

- 网络 safe retry；
- Repair；
- provider protocol fallback；
- fresh retry。

不得再在下层偷偷加请求。

## 7.3 Split

Split 后：

```text
Parent 不再消耗请求
Child A 有自己的 <=3
Child B 有自己的 <=3
```

但整个 Rebuild Job 必须能计算：

```text
planned logical units
实际 physical calls
retry calls
split-generated units
```

保证没有无限裂变。

## 7.4 outcome_unknown

如果：

```text
请求可能已执行
但客户端不知道最终结果
```

必须：

```text
停止静默自动重发
```

不能把 outcome_unknown 当 safe_retry。

---

# 8. P1-06：Response Recovery Matrix

保持现有分类能力，但收束动作。

| Response | 动作 |
|---|---|
| valid JSON | validate → apply |
| fenced / extra prose / format drift | structured repair，最多占用一次物理预算 |
| reasoning_only | fresh retry；仍 Non-Thinking；不把 reasoning 当业务 JSON |
| empty | bounded fresh retry |
| length | 先扩容到模型安全上限；无余量则 split |
| no_choices | provider/gateway failure，停止当前 child |
| content_filter | 不盲重试 |
| safe_retry network | 在统一 Attempt Budget 内重试 |
| rate_limit | Retry-After / 降并发；仍计物理预算 |
| outcome_unknown | 不自动重发 |
| config/account quota | 直接可诊断失败 |

---

# 9. P1-07：保持当前 Batch Size = 3

当前：

```text
Trigger Interval = 10
LLM Checkpoint Batch = 3
```

这个设计正确，继续保留。

不要重新绑定为：

```text
每10章 → 一次把10章塞进一个 JSON 请求
```

长度不足时：

```text
3 → 2 + 1
2 → 1 + 1
1 仍不满足 → model capability error
```

不允许无限扩 `max_tokens`。

---

# 10. P1-08：Partial Success / CAS 语义保持不变

当前远端已经修复此问题，本轮必须加防回归测试。

例如：

```text
1～3 success
4～6 success
7～9 first-half success
9 fail
```

最终必须持久化：

```text
through = 最新真正成功位置
status = 最新成功 State 的合法状态
lastError = 最后失败原因
```

下一次：

```text
从第一个未完成位置继续
```

严禁：

```text
回退 empty
回退旧 fingerprint
从第1章重新收费
把 partial success 覆盖成 failed
```

---

# 11. P1-09：Durable Attempt / Cold Start 语义

## 11.1 先检查能否复用现有基础设施

Agent 必须先核查：

- `llm_usage_logs`；
- pipeline attempt infrastructure；
- `story_memory_batches`；
- checkpoint metadata。

目标是找到能否表达：

```text
prepared
sent
succeeded
failed
outcome_unknown
cancelled
```

并且在 HTTP 发送前就持久化 `sent`。

## 11.2 当前审计倾向

当前 `llm_usage_logs` 更偏“用量结果日志”，`story_memory_batches` 更偏“成功/应用后的 Stateful Batch”，都不天然等价于一个发送前持久化的 Story Memory Request Attempt。

因此：

> 如果真实代码审计确认不存在可安全复用的 durable attempt ledger，则 P1 允许新增最小表，而不是用错误语义硬塞进旧表。

建议：

```text
story_memory_request_attempts
```

最小字段：

```text
attempt_id
logical_batch_id
project_id
from_position
through_position
request_kind
attempt_no
status
failure_class
provider_request_id
started_at
finished_at
```

严禁存：

- API Key；
- Authorization；
- 完整正文；
- 完整 reasoning。

## 11.3 Cold Start

若发现：

```text
status = sent
没有 terminal result
```

冷启动转：

```text
outcome_unknown
```

不得自动重发。

已成功 Checkpoint 继续可用。

---

# 12. P1-10：后台 Maintenance Coordinator

当前 `runStoryMemoryTaskOnce()` 保留，但明确它只负责：

```text
同进程 duplicate suppression
```

不要把它当 durable task。

推荐新入口：

```ts
requestStoryMemoryMaintenance({
  projectId,
  throughPosition,
  reason,
  priority
})
```

职责：

1. 同进程 single-flight；
2. 读取当前 DB state；
3. 检查是否已有更晚 Checkpoint；
4. 串行 acquire project memory apply lock；
5. 执行有界 Story Memory child；
6. 写 durable attempt / batch；
7. 更新 progress；
8. App 冷启动时可 reconcile。

优先复用当前后台/前台通知基础设施；**不要为了 Story Memory 再造一套全局后台服务**。

---

# 13. P1-11：UI 收束

## 安全 Coverage

不要 Modal：

```text
长期记忆正在后台补全，本次写作已使用安全的历史上下文。
```

## Hard Gap

才阻断：

```text
第X～Y章缺少可安全覆盖的历史信息，暂不能继续生成。
```

按钮：

```text
查看故事记忆
稍后重试
```

## Manual Rebuild

显示：

```text
已完成：6 / 23章
当前：第7～9章
并发：1 / 2
缓存命中：N
最近状态：...
```

不要再把：

```text
“请关闭 Thinking 模式”
```

当成主要用户动作。

---

# 14. P1 验收矩阵

## 14.1 必测真实场景：23章

固定回归：

```text
V2.11.40/后续版本
23章
Checkpoint through=6
pending=7～23
Smart≈10
DeepSeek / reasoning-capable model
```

验证：

### Case A：安全 Coverage 完整

```text
7～13 episodic 可用
14～23 recent raw
```

Story Memory LLM 故障：

```text
写作必须立即进入主流水线
不等待 Memory 网络请求
```

### Case B：Hard Gap

```text
7～13 中存在无 summary 且已超出 recent raw 的章节
```

必须：

```text
本地快速判定 hardGap
立即安全阻断
不暗等 Memory 300s
```

### Case C：Reasoning Only

断言：

```text
Primary 就是 Non-Thinking
如果 Provider 仍 reasoning-only
→ bounded fresh retry
→ 不 formatter reasoning
```

### Case D：Physical Calls

用最外层 HTTP mock/spy 统计真实发送次数。

必须证明：

```text
单 child <= 3 real HTTP calls
```

不是只检查函数 attempt 变量。

### Case E：Partial Success

真实 SQLite：

```text
前半成功
后半失败
```

断言成功 through/fingerprint 不回退。

### Case F：Force-stop

```text
发送请求
→ kill
→ cold start
```

验证：

- 已成功 Checkpoint 保留；
- nonterminal sent → outcome_unknown；
- 不静默重复收费；
- safe retry 场景可继续。

---

# 15. P1 发版 Gate

P1 必须全部通过：

```text
[ ] Context/Prepare 不再同步调用 Story Memory LLM
[ ] Safe Coverage 可无弹窗继续写
[ ] Hard Gap 立即安全阻断
[ ] 所有 Story Memory logical request 默认 Non-Thinking
[ ] 每个 child 真实 HTTP <= 3
[ ] safe_retry / outcome_unknown 明确分离
[ ] partial success 永不回退
[ ] force-stop 冷启动语义正确
[ ] 23章真实场景通过
[ ] Story Memory 真实 LLM 测试通过
```

**P1 可以独立发版；P2 未完成不得阻止 P1 正确性发版。**

---

# 16. P2 总原则：绝不并发当前 Stateful Patch

当前 Stateful Checkpoint 依赖：

```text
previousState
baseStateFingerprint
resultStateFingerprint
CAS
```

所以：

```text
State@6 → Patch7-9 → State@9 → Patch10-12
```

不能直接：

```text
Promise.all([
  statefulPatch7_9(State@6),
  statefulPatch10_12(State@6)
])
```

后者天然产生 stale base。

因此：

> **P2 只能并发 Stateless Extraction，Reducer / Apply / Checkpoint 仍 concurrency=1。**

---

# 17. P2 V3 调整：Observation Unit 改为“最多3章的小批次”

旧方案偏向每章一个 `ChapterMemoryObservation`。

但当前远端已经把 Story Memory 主路径优化成：

```text
每次 Stateful LLM Batch 默认 3章
```

如果 P2 又退回：

```text
1章 = 1个 LLM Extraction
```

可能出现：

```text
并发变快了
但调用次数与 Token 成本反而明显增加
```

这违背本轮“提速不增耗”的目标。

因此 V3 推荐：

```ts
interface StoryMemoryObservationBatch {
  projectId: number;

  fromPosition: number;
  throughPosition: number;
  chapterIds: number[];

  sourceFingerprint: string;
  extractorVersion: number;

  chapterObservations: ChapterMemoryObservation[];
}
```

约束：

```text
1 <= observationBatch chapters <= 3
```

Observation 只能回答：

```text
这一批章节各自发生了什么
```

不得根据 global previousState 决定：

- 最终全局人物状态；
- 删除哪条旧 unresolved thread；
- 最终关系状态；
- 当前 StoryMemoryState 应该变成什么。

---

# 18. P2-01：先串行做 Observation Parity，再谈并发

第一阶段必须：

```text
Observation Extraction = 1
Ordered Reducer = 1
```

与当前 Stateful 基线比较：

```text
当前 Stateful Batch 最终 State
vs
ObservationBatch → Ordered Reducer 最终 State
```

Fixture 至少：

```text
10章
23章
50章
```

比较：

- characters；
- aliases；
- relationships；
- world state；
- items；
- locations；
- mainline；
- open/resolved threads；
- foreshadowing；
- secret/commitments；
- episodic summary；
- evidence binding；
- throughPosition；
- fingerprint consistency。

若明显语义退化：

```text
停止 P2
保持现有串行 Stateful Batch
```

不得为了性能牺牲长期记忆质量。

---

# 19. P2-02：Ordered Reducer 永远串行

无论完成顺序：

```text
Obs 10～12 先返回
Obs 7～9 后返回
```

都必须：

```text
等待 7～9
Reduce 7～9
持久化 State@9
Reduce 10～12
持久化 State@12
```

禁止：

```text
谁先完成谁先写 State
```

Reducer：

```text
concurrency = 1
```

---

# 20. P2-03：Reducer 优先确定性本地逻辑

优先本地完成：

```text
entity canonicalization
alias resolve
dedup
evidence binding
position ordering
append/update
resolved marking
fingerprint
```

不要新增：

```text
Observation → Merge LLM → State
```

作为默认架构，否则：

- 多一次 LLM；
- 性能收益被抵消；
- 又引入结构化失败点；
- Token 增加。

如果某些 state-dependent 业务无法本地化，必须通过 Parity Proof 决定是否继续 P2。

---

# 21. P2-04：只在历史维护场景开并发

第一版只允许：

```text
Manual Full Rebuild
Dirty Rebuild
明显历史 backlog 的后台 Maintenance
```

默认不进入：

```text
正常单章定稿
当前章节写作
AI 写 N 章的章节生成
```

Legacy Bootstrap：

```text
默认 concurrency=1
```

只有独立 parity + cost 测试通过后再纳入。

---

# 22. P2-05：Worker Pool 固定 MAX_CONCURRENCY = 2

第一版：

```text
MAX_CONCURRENCY = 2
```

普通用户不配置。

调度：

```text
Worker A
Worker B
```

完成一个 unit 后才领取下一个。

不要上：

```text
3 / 4 / 5 路
```

---

# 23. P2-06：自动退化 2 → 1

任一出现：

```text
429
连续5xx
Provider capability unknown
网络错误率升高
本地模型 / local GGUF
内存压力异常
in-flight token budget 不足
```

立即：

```text
2 → 1
```

当前任务无需用户决定。

恢复到 2 必须是后续健康窗口，不在当前故障抖动期反复升降。

---

# 24. P2-07：Token Concurrency Budget

不能只控制：

```text
workers <= 2
```

还要控制：

```text
estimatedInFlightInputTokens
estimatedInFlightOutputBudget
```

只有：

```text
worker slot 可用
AND
inflight token budget 足够
```

才发第二个 Observation Batch。

避免两个超长 3 章 Batch 同时压爆 Gateway。

---

# 25. P2-08：Observation Cache 是上线并发的前置条件

Cache Key：

```text
projectId
fromPosition
throughPosition
sourceFingerprint
extractorVersion
```

正文没变：

```text
直接复用 Observation
```

正文变化：

```text
cache miss
```

## 25.1 当前 HEAD 后的 V3 判断

当前 `story_memory_batches` 本质是：

```text
Stateful applied batch
+
base_state_fingerprint
+
result_state_fingerprint
+
patch
```

它不适合直接伪装成“与 State 无关的 Observation”。

因此：

> **不要把 stateless observation 生硬塞入 `story_memory_batches`。**

P2 串行 Parity 阶段可以先只做内存 Observation。

但一旦要正式发布：

```text
concurrency=2
+
force-stop resume
+
不重复收费
```

则推荐新增独立：

```text
story_memory_observations
```

若 Agent 能证明已有通用持久层完全满足同等语义，才可以不加表。

---

# 26. P2-09：建议 Observation Table（若 P2 正式启用）

若新增，下一 Schema 建议顺延：

```text
Schema 49 → 50
```

字段：

```text
id
project_id
from_position
through_position
source_fingerprint
extractor_version
payload_json
status
last_error
created_at
updated_at
```

唯一约束：

```text
(project_id, from_position, through_position, source_fingerprint, extractor_version)
```

要求：

- lazy population；
- 不全量回填；
- migration idempotent；
- fresh install / 49→50 / backup / restore 全覆盖；
- 不修改正文；
- 不修改旧 Checkpoint；
- 不复用错误的 baseStateFingerprint 语义。

---

# 27. P2-10：Failure Hole

例如：

```text
Obs 7～9 success
Obs 10～12 fail
Obs 13～15 success
```

正确：

```text
缓存 7～9
缓存 13～15
Reducer through 9
等待 10～12
```

重试：

```text
只重新调用 10～12
```

随后：

```text
Reduce 10～12
Reduce cached 13～15
```

禁止：

```text
再次收费调用 13～15
```

---

# 28. P2-11：Cancel / Force-stop

Cancel：

```text
abort 未完成 in-flight
保留成功 Observation
保留已 Reduce State
```

Cold Start：

```text
读取最后成功 Checkpoint
读取 observation cache
找到最早 hole
从 hole 继续
```

如果某 Observation 请求处于：

```text
sent but nonterminal
```

按 P1 outcome_unknown 规则处理，不静默重发。

---

# 29. P2 性能与成本验收

规模：

```text
10章
23章
50章
100章
```

同模型、同网络、同输入比较：

```text
当前 Remote 串行 Stateful baseline
vs
新 Observation concurrency=2
```

记录：

- wall time；
- time-to-first-progress；
- logical LLM calls；
- physical HTTP calls；
- retry；
- 429 / 5xx；
- cache hit；
- input/output/reasoning token；
- concurrency peak；
- memory；
- ANR；
- final state parity。

## 29.1 第一版目标

20章以上：

```text
总耗时 <= 当前串行基线 75%
```

优秀：

```text
<= 65%
```

但不接受：

```text
为了快
→ logical call 数显著增加
→ Token 成本显著增加
→ Memory State 语义退化
```

正常无故障测试中：

```text
Observation logical unit 数不得高于当前 3章 Batch 基线所需数量
```

除非 Agent 提供明确数据证明额外调用换来了必要正确性收益。

---

# 30. P2 上线 Gate

必须全部满足：

```text
[ ] Observation 语义独立于 previousState
[ ] 串行 Observation + Reducer parity 通过
[ ] Reducer concurrency=1
[ ] Worker MAX_CONCURRENCY=2
[ ] 429/5xx 可自动降为1
[ ] Token in-flight budget 生效
[ ] Observation cache 可 durable reuse
[ ] Failure hole 只补 hole
[ ] Force-stop 不重复已成功 Observation
[ ] 20+章 <= 当前基线75%
[ ] HTTP/Token 成本无明显恶化
```

任何一项不满足：

```text
P2 feature disabled
继续使用当前串行 Stateful Batch
```

P1 不受影响。

---

# 31. 最新远端专项测试要求

当前 HEAD 最新真实 LLM 报告重点验证的是：

```text
单章 / Batch 统一写作流水线
Draft → Review → FactCheck → Brief → Proof
```

它不能替代 Story Memory 专项验收。

必须新增真实 Story Memory LLM 报告，例如：

```text
docs/optimization/ShineWriter_StoryMemory_P1_P2_真实LLM测试报告-YYYYMMDD.md
```

至少覆盖：

1. 23章 through=6 场景；
2. Primary Non-Thinking request payload；
3. reasoning-only recovery；
4. invalid JSON repair；
5. length → split；
6. partial success；
7. hard gap；
8. safe coverage no-stall；
9. force-stop/cold start；
10. P2 23/50章性能对照（若启用 P2）。

---

# 32. 自动化测试建议

新增/补强：

```text
storyMemoryNoStallGeneration.test.ts
storyMemoryPhysicalRequestBudget.test.ts
storyMemoryStructuredThinkingPolicy.test.ts
storyMemoryHardGapGate.test.ts
storyMemoryFinalizeReturnFirst.test.ts
storyMemoryOutcomeUnknownResume.test.ts
storyMemoryObservationParity.test.ts
storyMemoryObservationPool.test.ts
storyMemoryObservationHoleResume.test.ts
```

其中 `storyMemoryPhysicalRequestBudget.test.ts` 必须 spy 到真正 HTTP dispatch 层，而不是只 mock：

```text
requestCheckpoint()
callLLMResult()
```

否则无法发现 Provider fallback 带来的额外物理请求。

---

# 33. Agent 推荐提交顺序

```text
Commit 1
test(story-memory): pin current remote P1 blockers

Commit 2
refactor(story-memory): split local readiness from maintenance side effects

Commit 3
fix(story-memory): make finalize return-first and maintenance background

Commit 4
fix(story-memory): force structured non-thinking policy on every request branch

Commit 5
fix(story-memory): unify real HTTP attempt budget and outcome-unknown semantics

Commit 6
fix(story-memory): restore safe-coverage vs hard-gap gate

Commit 7
test(story-memory): 23-chapter / partial / force-stop P1 acceptance

Commit 8
feat(story-memory): add stateless observation-batch contract (serial only)

Commit 9
test(story-memory): prove old-vs-observation semantic parity

Commit 10
feat(story-memory): durable observation cache if required

Commit 11
perf(story-memory): bounded observation extraction concurrency=2

Commit 12
test(story-memory): 23/50/100 chapter performance and fault matrix

Commit 13
release: version/schema/audit/report
```

每笔提交保持单一职责。

---

# 34. Agent 执行纪律

## 开工前

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git fetch --all --prune
git rev-parse origin/main
git log -15 --oneline --decorate
```

记录：

- local HEAD；
- origin/main；
- worktree；
- version；
- schema；
- test count。

## 工作区

严禁：

```bash
git reset --hard
git clean -fd
git clean -fdx
git checkout -- .
git restore .
```

不得清用户数据库、App Data、章节、旧 Checkpoint、Pipeline History。

## 已修复项

如果当前本地代码已经解决本文某项：

```text
already fixed / no code change required
```

补验证，不重复重构。

## Provider

如果现有 LLM Provider / request policy 已满足：

```text
绝不新增第二套
```

## P2

如果 Observation parity 不能证明：

```text
停止 P2
保持当前串行
```

---

# 35. 发版判断

## P1

属于正式发版必过项。

只要存在以下任一：

```text
写作仍暗等 Story Memory LLM
真实 HTTP retry 无全局上限
Primary/Repair 仍可能 Thinking
Hard Gap 可被无条件跳过
outcome_unknown 会自动重发
partial success 会回退
```

则：

```text
P1 未完成
```

## P2

属于优化项，不应反过来拖慢 P1。

如果：

```text
Parity 未通过
性能收益不足
429 变多
Token 明显增加
Force-stop cache 不可靠
```

则：

```text
P2 默认关闭
按串行发版
```

---

# 36. 最终用户视角验收

用户只应该感知：

```text
正常写作：
点生成 → 立即进入写作
```

如果 Memory 普通故障但 Coverage 安全：

```text
写作继续
后台自动补长期记忆
```

如果真的存在历史断层：

```text
系统立即明确告诉我缺哪一段
而不是转圈几分钟后才告诉我失败
```

点击：

```text
立即整理长期记忆
```

应该：

```text
自动选择正确 Structured 模式
自动有界恢复
成功进度不丢
退出后可继续
无需理解 Thinking / reasoning_content / JSON Mode
```

长历史重建启用 P2 后：

```text
最多2路 Stateless Extraction
Ordered Reduce 永远串行
失败只补洞
不重复收费
速度明显优于当前串行
```

这才算 Story Memory 真正达到：

> **P1 无阻滞、P1 可恢复、P1 不丢断点，P2 保守提速且不牺牲语义正确性。**

---

# 37. 本轮一句话实施指令

```text
以本地仓和最新 origin/main 为准，先复现并修掉 Story Memory “写作主链路同步等 Memory、物理重试上限失真、Non-Thinking 未全覆盖、Hard Gap 被过度降级”四个 P1 问题；保留现有 recent-10、batch=3、split partial-success、预算钳制和 single-flight 能力。P1 验收通过后，再把当前 Stateful Batch 拆为最多3章的 Stateless Observation Batch + Ordered Serial Reducer，只有 Parity 通过才启用 concurrency=2，并实现 durable cache、hole resume、429自动降并发和真实 LLM 性能穿测。禁止并发 Stateful Patch，禁止重造 Provider，禁止破坏用户数据库或已有 Checkpoint。
```
