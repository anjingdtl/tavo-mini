# Tavo-Mini Story Memory 长期稳定性最终治理方案

> 项目：`anjingdtl/tavo-mini`  
> 当前远端审计基线：`main@a1810b4c3fd498c646d8ff13e7cf2a060ad1799a`  
> 当前应用版本：`V2.11.41`  
> 当前数据库：`Schema 50`  
> 当前大纲预算：`ContextBudgetVersion = 5`  
> 本地实施工作树：`E:\AiWorkSpace\tavo-mini`  
> 方案定位：**Story Memory 稳定性最终治理，不再以“能跑通一次”为验收，而以“长篇持续运行、异常可恢复、不同模型可适配”为目标**  
> 建议最终发布版本：`V2.11.42`（全部 Gate 通过后再升版）  
> 日期：2026-08-10

---

# 0. 最终目标

Story Memory 当前已经具备较完整的工程骨架，但真实长篇使用仍存在“偶尔成功、复杂场景失败、一次异常可能消耗多次请求、不同上下文模型表现不一致”等问题。

本方案的目标不是继续叠加功能，而是完成一次**可靠性收束**：

```text
用户持续写 100章 / 300章 / 1000章
        ↓
Story Memory 自动增量维护
        ↓
模型输出存在合理格式差异也能安全落地
        ↓
大上下文模型充分利用能力
小上下文模型主动压缩/拆批
        ↓
单次失败不污染已成功状态
        ↓
网络异常 / App 强杀 / 后台切换后可恢复
        ↓
用户始终知道任务是否正在运行
        ↓
不会无限重试、不会静默重复付费
```

最终要求：

> **长期记忆应成为一个稳定后台基础设施，而不是一个需要用户经常手工救火的 AI 功能。**

---

# 1. 当前已经完成的基础能力

以下能力在当前远端代码中已经落地，本轮原则上**不重复重构**，只做回归验证。

## 1.1 Local First / Return First

章节定稿：

```text
先本地保存正文
→ 写作流程返回
→ Story Memory 后台维护
```

长期记忆 LLM 不再同步阻塞章节保存。

## 1.2 Safe Coverage / Hard Gap

当前已有：

```text
Safe Coverage
→ 写作继续
→ Story Memory 后台补齐

Hard Gap
→ 本地 fail-closed
→ 后台 enqueue maintenance
→ 不等待 LLM
```

该设计必须保留。

## 1.3 Durable Request Ledger

Schema 50 已有：

```text
story_memory_request_attempts
```

并支持：

```text
prepared
sent
succeeded
failed
outcome_unknown
cancelled
```

用于避免冷启动后静默重复请求。

## 1.4 outcome_unknown 用户恢复

当前已经实现：

```text
sent
→ force-stop
→ cold start
→ outcome_unknown
→ 自动 maintenance 阻断
→ 用户确认
→ ledger 保留并终态化
→ 手动恢复
```

并已有回归测试证明后续 interval maintenance 不再永久锁死。

## 1.5 Foreground / WakeLock / Progress

当前已经：

- 复用 Pipeline Foreground Service；
- Story Memory Task ID：`story-memory:<projectId>`；
- Foreground notification；
- Partial WakeLock；
- Task Store；
- 页面进度；
- 页面退出不取消后台任务；
- 可停止整理。

这一块当前作为稳定基础，不应再次大规模重写。

## 1.6 UI 收束

当前 Story Memory 页面已经从“开发者控制面板”收束：

- 单 Primary CTA；
- 更新设置折叠；
- 维护与诊断折叠；
- 人物 / 关系 / 主线折叠；
- duplicate rebuild buttons 已移除。

本轮不再做 UI 结构大改。

## 1.7 Story Memory Output Budget V5

当前 Output 已接入：

```ts
resolveElasticStageOutputReservation()
```

因此：

```text
1M / 200K → max_tokens 200K
1M / 64K  → 64K
128K / 32K → 25.6K
```

有效模型 capability 存在时，不再由：

```text
memoryPatchMaxTokens
MAX_CHECKPOINT_OUTPUT_TOKENS=16000
```

限制主路径。

这一部分保留。

---

# 2. 当前仍然导致“长期记忆不稳定”的核心问题

现阶段真正影响长期稳定性的，不再是单一 Bug，而是以下几类问题叠加。

## 2.1 模型输出契约过于刚性

真实复杂长篇测试已经出现：

```text
HTTP 200
HTTP 200
HTTP 200
```

但三次全部因为：

```text
chapterSummaries
↕
mainlinePatch
```

结构化主线一致性校验失败。

这说明网络、Provider、Context Budget 基本正常，主要失败来自“自然语言摘要分类”和“持久结构状态”之间要求过于严格。

如果不解决：

> 长篇越复杂，模型越容易出现合理但不完全一致的表达，从而导致整个 Batch 失败。

这是当前第一稳定性问题。

## 2.2 Story Memory Input 尚未真正进入 Elastic Budget

当前 Output 使用 Budget V5，但 Input 目前主要是：

```text
contextWindow
- outputReservation
- 256
```

进行 Hard Window Preflight。

即：

```text
完整 Prompt 能放下
→ 全量发

放不下
→ 直接 Split
```

没有真正调用已有：

```text
allocateElasticStageContextBudget()
```

因此没有充分利用项目现有：

```text
Soft 80%
Burst 95%
Hard 100%
Mandatory / Preferred / Optional
priority / relevance / reclaim / burst / shrink
```

这导致：

- 大 Context 没有细粒度管理；
- 小 Context 过早 Split；
- Previous State 持续膨胀时缺少分层收缩；
- 自动任务可能靠近 Hard Limit；
- 未来 300/1000 章项目风险持续增加。

## 2.3 Previous State 长篇持续膨胀

当前长期状态会持续包含：

```text
characters
relationships
currentArc
currentObjective
activeConflicts
openThreads
foreshadowing
timelineAnchors
recentCompletedBeats
recentResolvedThreads
archiveDigest
```

其中人物、关系、活跃状态会随小说持续增长。

即使 `context_window=1M`，也不意味着应该无限把整个历史状态全部塞进每一次维护请求。

稳定性目标应该从：

```text
“放得下就全部塞”
```

升级为：

```text
“关键连续性信息完整保留，无关历史按相关性收缩”
```

## 2.4 Repair / Retry 仍需要完整真实验证

当前代码已有：

```text
Primary
→ Repair
→ Fresh Retry
```

最多：

```text
<= 3 physical HTTP
```

但真实模型下 invalid JSON Repair、Schema Repair、Evidence Repair、Repair Prompt 过大等场景尚未全部形成真机通过证据。

## 2.5 当前 Mainline Retry 可能浪费真实请求

对于仅仅是：

```text
Summary 认为“主线变化”
Structured State 认为“不需要持久化”
```

这样的分类差异，现在可能走：

```text
Primary失败
→ Repair
→ Retry
```

这类问题理论上完全可以本地 deterministic reconcile，不应消耗 2~3 次付费 API。

## 2.6 小模型已有 Split，但 Input 不够精细

当前已有真实：

```text
3 → 2 → 1
```

发送前 Split。

这是正确的，但理想流程应该是：

```text
Full Prompt
↓
Elastic shrink optional/history
↓
仍不够
↓
3→2→1
```

而不是直接从 Full Prompt 进入 Split。

## 2.7 Split 子批次进度不够细

当前百分比按：

```text
completedChapters / totalChapters
```

但递归 `3→2→1` 发生在内部，可能出现范围变化但百分比不动，最后突然跳到完成。

这不会导致数据错误，但会影响用户判断任务是否卡死。

## 2.8 自动 maintenance 真实连续运行证据仍不足

已经验证：

```text
force-stop
→ unknown
→ 用户确认
→ 手动恢复
```

还需要证明：

```text
恢复之后
→ 新章节继续产生 pending
→ interval 自动触发
→ 后台 maintenance
→ 成功推进
→ 下一轮继续正常
```

真正形成完整生命周期。

---

# 3. 稳定性治理总原则

## 3.1 Structured State 是唯一持久事实权威

Story Memory 有两类输出：

### 检索层

```text
chapterSummaries
episodic text
```

主要供后续历史检索。

### 持久状态层

```text
characters
relationships
mainline
threads
foreshadowing
timeline
```

用于后续生成连续性。

必须定义：

```text
Structured State = authoritative
Summary = retrieval annotation
```

Summary 不允许反向凭空创造持久 State。

## 3.2 能本地确定修复的，不再消耗 LLM Repair

例如：

```text
assessment=unchanged
但 Structured Patch 有真实 mutation
```

可以本地修正标签，无需第二次 API。

## 3.3 真正事实错误仍严格 Fail Closed

以下继续硬失败：

- Range 不一致；
- chapter ID/position 不一致；
- JSON 无法解析且 Repair 失败；
- 引用不存在实体；
- 真实状态变更缺失证据；
- CAS fingerprint mismatch；
- 单章 Mandatory 无法进入模型 Context；
- Provider outcome unknown。

## 3.4 不允许静默截断当前章节正文

正文始终属于 Mandatory。

如果无法容纳：

```text
3→2→1
```

单章仍无法容纳：

```text
0 HTTP + actionable error
```

## 3.5 不允许无限扩大 Batch

默认仍：

```text
STORY_MEMORY_DEFAULT_BATCH_SIZE = 3
```

本轮不因为 1M Context 改成 10 章一批。

## 3.6 P2 继续关闭

不做：

- 多 Worker；
- 并行 Reducer；
- speculative maintenance；
- 多 Provider 并行。

先把单链路做到稳定。

---

# 4. 改造一：Mainline Summary ↔ Structured Patch 契约收束

这是第一优先级。

## 4.1 当前失败模式

模型可能输出：

```text
chapterSummaries.mainlineChanges:
“调查方向转向地下室”
```

但：

```text
mainlinePatch.currentArcUpdate.action = none
threadOpens=[]
conflictUpserts=[]
...
```

当前 Validator 会将其判为 Schema Invalid。

## 4.2 新增 Mainline Reconciler

建议新增：

```text
src/services/storyMemory/storyMemoryMainlineReconciler.ts
```

纯函数：

```ts
reconcileStoryMemoryMainlineDraft(...)
```

输出：

```text
reconciledDraft
diagnostics
```

## 4.3 核心规则

### Rule A：Summary mainlineChanges 无 Structured Mutation

如果 Summary 有 `mainlineChanges`，但 `hasMainlineStateMutation(mainlinePatch)=false`：

```text
mainlineChanges
→ 转为普通 events
→ mainlineChanges=[]
```

信息仍保留用于检索，但不写入长期结构化主线。

### Rule B：Summary newThreads 无 Structured Thread Op

如果：

```text
summary.newThreads != []
threadOpens=[]
threadUpdates=[]
```

则：

```text
newThreads → events
newThreads=[]
```

禁止自动创建 `new_thread_xxx`。

### Rule C：Summary resolvedThreads 无 Structured Closure

如果 Summary 有 resolvedThreads，但没有：

```text
threadResolutions
conflictResolutions
currentArc complete/replace
foreshadow paid
```

则：

```text
resolvedThreads → events
resolvedThreads=[]
```

### Rule D：Structured 有 Mutation，assessment=unchanged

本地归一化：

```text
assessment.result = changed
```

这是修改标签，不是创造事实。

### Rule E：Structured 无 Mutation，assessment=changed

归一化：

```text
assessment.result = unchanged
```

## 4.4 禁止反向制造 State

绝对禁止：

```text
Summary.newThreads → 自动 new thread
Summary.mainlineChanges → 自动 currentObjective
Summary.resolvedThreads → 自动 close thread
```

## 4.5 Reconcile 必须发生在 Paid Repair 之前

新流程：

```text
HTTP 200
↓
Parse
↓
Basic Normalize
↓
Local Mainline Reconcile
↓
Strict Structured Validation
↓
PASS
```

如果只是分类差异，应做到 1 次 HTTP 成功，而不是 3 次 HTTP 全失败。

## 4.6 Reconcile Diagnostics

建议记录：

```ts
{
  downgradedMainlineChanges,
  downgradedNewThreads,
  downgradedResolvedThreads,
  normalizedAssessment
}
```

只用于 log / QA / tests，不进 DB Schema。

---

# 5. 改造二：Story Memory Input 真正接入 Elastic Allocator

## 5.1 必须直接复用现有实现

使用：

```ts
allocateElasticStageContextBudget()
```

禁止创建第二套 Story Memory Elastic 算法。

## 5.2 Output 继续使用现有 V5

```ts
resolveElasticStageOutputReservation()
```

保持不变。

## 5.3 Safety Margin 统一

V5 capability 已知时，不再固定使用 256 作为 Story Memory 主安全边界，而由通用：

```ts
deriveDefaultSafetyMargin(contextWindow)
```

决定。

## 5.4 Input 模块拆分

建议新增：

```text
src/services/storyMemory/storyMemoryPromptMaterials.ts
```

### Mandatory

绝不裁剪：

```text
System Protocol
JSON Schema / Contract
Batch Range
Chapter ID / position / title
当前 Batch 完整正文
完整轻量人物名册
Repair instruction（如有）
```

### Preferred High

高优先：

```text
currentArc
currentObjective
activeConflicts
openThreads
foreshadowing
当前 Batch 涉及人物 rich state
当前 Batch 涉及人物 relationships
```

### Preferred Low

次优：

```text
recent timelineAnchors
recentCompletedBeats
recentResolvedThreads
Batch 未涉及人物的 currentState
Batch 未涉及关系
```

### Optional

最先压缩：

```text
archiveDigest
旧 timeline
非活跃历史
与当前 Batch 无关的历史详情
```

## 5.5 人物相关性使用 deterministic resolver

不新增 LLM 请求。

相关人物判断：

```text
canonicalName 出现在当前 Batch 正文
alias 出现在当前 Batch 正文
```

关系：

```text
from/to 任一为 relevantCharacter
```

## 5.6 Full Prompt Fast Path

先构造现有完整 Prompt。

如果所有材料能完整进入弹性预算：

```text
strategy = full_prompt
```

必须保持现有 Prompt 语义不变。

特别是 1M/200K 普通三章，通常应走 Full Prompt。

## 5.7 Elastic Compact Path

当完整 Prompt 过大：

```text
allocateElasticStageContextBudget()
```

优先压：

```text
Optional ↓
Preferred Low ↓
```

不动 Mandatory 和 critical Preferred High。

## 5.8 不允许 JSON 字符串直接 slice

禁止：

```ts
compactState(state).slice(...)
```

必须从 `StoryMemoryState` 对象按实体/数组级选择后再 stringify。

## 5.9 Final Re-estimate

最终 Prompt 重构后：

```ts
estimateMessagesTokens(finalMessages)
```

重新检查 Soft / Burst / Hard。

## 5.10 自动发送边界

正常自动任务：

```text
final input <= Burst Limit
```

若超出：

```text
继续压 Optional
→ 再压 Preferred Low
→ 仍超则 Split
```

Mandatory > Hard：立即 Split。

---

# 6. 改造三：长期状态规模治理

只靠 Elastic Allocator 仍不够，需要控制 State 随章节增长。

## 6.1 人物

Prompt 始终保留完整轻量 roster：

```text
id / name / alias
```

保证模型不会重复创建旧人物。

rich state：

```text
location
goal
knowledge
possessions
secrets
...
```

优先给当前 Batch relevant characters + 关键活跃人物。

## 6.2 关系

完整 relationships 不再无条件进入每个 Prompt。

优先：

```text
relevant character relationships
active mainline related relationships
recent changed relationships
```

## 6.3 Timeline

优先保留：

```text
recent / pinned / active
```

老 Timeline 进入 archiveDigest 或低优先级。

## 6.4 Open 状态

这些保持高优先：

```text
activeConflicts
openThreads
open foreshadowing
currentObjective
currentArc
```

## 6.5 Closed 状态

已解决的 threads/conflicts/beats 主要进入 recent history / archiveDigest，不永久占高优先 Prompt。

---

# 7. 改造四：Repair / Retry 稳定化

## 7.1 每次请求独立规划

以下每次都重新预算：

```text
Primary
Repair
Fresh Retry
Split Child
Legacy Bootstrap
Patch
Checkpoint
Rebuild
```

## 7.2 Repair 输入不能沿用 Primary estimate

Repair：

```text
Original Prompt
+
Invalid Output
+
Validation Error
+
Repair Instruction
```

必须重新 Build Materials → Elastic Plan → Re-estimate。

## 7.3 Repair 不可行时不要硬发

若 invalid output 本身过大导致 Repair 超窗口：

禁止截断 invalid JSON，应：

```text
Skip Repair
→ Fresh Retry
```

## 7.4 Mainline 分类差异不再进入 Repair

经过 Reconciler 后，只有真正 JSON / Schema / Reference / Evidence / Range 问题才进入 Repair。

## 7.5 真实物理请求仍 <=3

保持 `StoryMemoryAttemptBudget`，所有 Provider protocol fallback 都必须计数。

---

# 8. 改造五：Preflight Split 最终规则

## 8.1 正常顺序

```text
Full Prompt
↓
Elastic Compact
↓
Re-estimate
↓
仍超窗口
↓
3→2→1
```

## 8.2 Parent Split 不消耗 HTTP

三章 preflight 不可行：

```text
3章 Parent fetch=0
```

直接拆。

## 8.3 单章仍无法容纳

返回明确模型能力错误，且：

```text
fetch=0
```

## 8.4 Length

如果已经使用模型完整 Output Reservation：

多章：

```text
length → split
```

单章：

```text
length → actionable failure
```

不要恢复历史 `2400→4800→9600` 模式。

---

# 9. 改造六：Split 子批进度

当前内部 Split 应将真实完成章节反馈到 Task Store。

例如：

```text
原计划 3章
→ 2 + 1
```

第一部分完成后：

```text
completedChapters += 2
```

而不是等待全部三章结束才推进。

LLM 请求期间仍不做假百分比，只显示正在分析的章节范围和等待时长。

---

# 10. 改造七：Automatic Maintenance 生命周期闭环

当前 durable 结构已有，本轮重点补真实连续生命周期。

完整链：

```text
章节持续定稿
↓
pending 达到 interval
↓
自动 enqueue
↓
Foreground
↓
Checkpoint
↓
成功
↓
下一批章节继续产生
↓
再次 interval
↓
再次自动成功
```

必须验证至少连续 2 个自动 interval 周期。

---

# 11. 改造八：失败分类与用户行为

最终错误应明确分类。

## 可自动重试

```text
temporary network
provider transient
empty response
reasoning_only
```

受 `<=3 HTTP` 约束。

## 可 Repair

```text
invalid JSON
schema field mismatch
evidence formatting
```

## 应 Split

```text
input capacity
output length multi-chapter
```

## 必须人工处理

```text
outcome_unknown
```

## 必须修改模型配置

```text
单章 context 不足
单章 output ceiling 不足
```

## 数据一致性故障

```text
CAS mismatch
invalid reference after Repair
```

进入诊断，不无限重试。

---

# 12. 改造九：日志与可观测性

每个逻辑 Story Memory Batch 建议记录：

```text
logicalBatchId
projectId
range
requestKind
model
contextWindow
maxOutputTokens
outputReservation
inputFullTokens
inputFinalTokens
softInput
burstInput
hardInput
strategy
physicalAttempt
finishReason
validationCode
mainlineReconcile counts
applied / failed
```

禁止记录：

```text
API Key
完整正文
完整 Prompt
完整模型输出
reasoning
```

---

# 13. 建议最终文件结构

预计新增：

```text
src/services/storyMemory/storyMemoryMainlineReconciler.ts
src/services/storyMemory/storyMemoryPromptMaterials.ts
```

预计重点修改：

```text
src/services/storyMemory/storyMemoryRequestBudget.ts
src/services/storyMemory/storyMemoryPrompts.ts
src/services/storyMemory/storyMemoryBatchValidator.ts
src/services/storyMemory/storyMemoryCheckpointService.ts
src/services/storyMemory/storyMemoryService.ts
src/store/storyMemoryTaskStore.ts
```

可能小改：

```text
storyMemoryRebuild.ts
storyMemoryRequestPolicy.ts
```

原则上不动：

```text
pipeline Budget V5
Context Auto 核心算法
Foreground Android Service
Schema 50
Continuation
```

除非真实根因证明必须。

---

# 14. Schema 策略

默认：

```text
Schema 50 保持
```

Mainline Reconcile、Input Budget、Progress 都不需要新表。

只有发现现有 ledger 无法表达必要 durable 状态时才能升 Schema。

---

# 15. 自动化测试体系

本轮需要建立 Story Memory Stability Matrix。

## 15.1 Mainline Reconcile

必须覆盖：

- Summary Mainline 有、Structured 无 → PASS，信息转 events，不创建 State；
- newThreads 有、Structured 无 → PASS，降级检索信息；
- resolvedThreads 有、Structured 无 → 同上；
- Structured mutation 有、assessment unchanged → 本地改 changed；
- 非法 entity ref → FAIL；
- State mutation 无 evidence → FAIL。

## 15.2 Elastic Input

覆盖：

```text
1M / 200K
1M / 64K
128K / 32K
64K / 32K
```

### Full Prompt

普通三章：

```text
strategy=full_prompt
```

### Optional shrink

巨大 archive / old timeline：Optional 先缩。

### Relevant character

当前正文涉及人物的 rich state 保留优先级更高。

### 3→2→1

父级：

```text
0 HTTP
```

### Single chapter impossible

```text
0 HTTP
```

## 15.3 Repair

模拟：

```text
Primary invalid JSON
→ Repair success
```

再测：

```text
Repair 太大
→ Skip Repair
→ Fresh Retry
```

## 15.4 Request Budget

任何逻辑 child batch：

```text
physical fetch <=3
```

包括 protocol fallback。

## 15.5 Durable

```text
sent
→ force-stop
→ outcome_unknown
→ no auto retry
→ user acknowledge
→ recovery
→ next interval auto success
```

## 15.6 Partial Success

```text
split first succeeds
second fails
```

确认 first persisted state preserved。

## 15.7 Progress

`3→2→1` 第一 child 成功后即可推进真实百分比。

---

# 16. 长篇压力测试

这是本轮最重要的测试之一。

至少构造：

```text
100章
300章
1000章
```

不需要全部真实 LLM，大部分可以 Mock + 真 token estimate。

## 16.1 100章

验证 State 大小、Prompt tokens、relevant character、Full/Compact Strategy、Mainline、自动 interval。

## 16.2 300章

重点观察 characters / relationships / threads / timeline 增长后是否仍稳定。

## 16.3 1000章

目标不是让模型读1000章，而是证明：

```text
长期状态增长
不会让每次三章 maintenance 无限增长
```

应通过 lightweight roster + relevance + archive + elastic compact 保持请求规模可控。

---

# 17. 真实 LLM 穿测矩阵

## 17.1 普通 1M/200K 三章

必须 PASS。

## 17.2 复杂长篇三章

复用当前失败 Fixture。

当前已知：

```text
3次 HTTP 200
→ Mainline Contract FAIL
```

改造后必须 Applied。

最佳路径：

```text
Primary
→ Local Reconcile
→ PASS
```

不得仍因为 Summary 分类差异连续消耗三次请求。

## 17.3 大 Previous State

加入多人物、多关系、多 threads、timeline、archive，验证 Elastic strategy。

## 17.4 小 Context

真实或可控 Provider：

```text
64K / 32K
128K / 32K
```

验证：

```text
Compact
→ Split
```

顺序正确。

## 17.5 Invalid JSON Repair

真实制造一次 invalid JSON，必须观察：

```text
Primary
→ Repair
→ Success
```

并确认 Repair 独立 Input Plan。

## 17.6 Force Stop

真实：

```text
sent
→ adb force-stop
→ cold start
→ unknown
→ confirm
→ success
```

## 17.7 Auto Interval ×2

连续完成两轮自动周期。

## 17.8 Background

整理过程中 Home / 锁屏 / 切其他 App，任务继续。

---

# 18. 模型兼容矩阵

如果条件允许，至少覆盖两类 OpenAI-compatible 模型：

```text
DeepSeek
另一个不同结构化输出习惯的模型
```

目的不是性能排名，而是验证 Validator 不应只对某一个模型的 JSON 习惯工作。

---

# 19. 回归边界

本轮不得破坏：

```text
Draft / Review / FactCheck / Brief / Final Budget V5
```

不得修改：

```text
ContextBudgetVersion=5
```

不得恢复旧：

```text
pipeline_*_max_tokens
```

---

# 20. 不再建议保留的稳定性误区

## 误区 1：Context 越大就全部塞

错误。大 Context 仍然需要 attention management。

## 误区 2：Validator 越严格越安全

错误。把检索分类差异也视为结构化事实错误，会造成大量 false negative。

## 误区 3：失败多 Retry 就稳定

错误。稳定应该优先：

```text
Local Reconcile
Preflight
Elastic Plan
Split
```

Retry 是最后保护。

## 误区 4：自动 maintenance 只要后台执行就行

错误。还必须 durable、progress、bounded requests、recovery、no silent duplicate。

---

# 21. 最终施工顺序

严禁大面积同时修改。

## Phase 0：基线与失败样本固定

```bash
git status
git fetch --all --prune
git rev-parse HEAD
git rev-parse origin/main
```

保存当前复杂长篇三次失败的 failure code / validation message / request count / range，形成固定 Fixture。

## Phase 1：Mainline Reconciler

先解决真实三次 HTTP 200 失败。

要求：

```text
旧 Fixture FAIL
新 Fixture PASS
```

完成后先跑 targeted tests。

## Phase 2：Prompt Materials

将 Previous State / Batch / Schema 拆成可预算模块。

此阶段必须证明：

```text
full allocation
→ Prompt 与当前语义一致
```

## Phase 3：Input Elastic Allocator

接入现有 `allocateElasticStageContextBudget()`，完成 Soft/Burst/Hard、Mandatory/Preferred/Optional、Generic safety margin。

## Phase 4：长篇 State Compaction

增加 relevant character / relevant relationship / archive/history priority，不改变 DB State，只改变 Prompt View。

## Phase 5：Repair / Retry

重新审计 Primary / Repair / Fresh Retry / Split，每次独立预算。

## Phase 6：Split Progress

补 child progress。

## Phase 7：全套 Automated Stability Tests

再跑：

```text
npm run verify
```

## Phase 8：真实 LLM / 模拟器

依次：

```text
普通1M
复杂长篇
大State
小窗口
invalid JSON Repair
force-stop
auto interval ×2
background
```

## Phase 9：升级覆盖

不得 uninstall / pm clear，必须覆盖安装现有数据库。

## Phase 10：Release

全部 Gate 通过后：

```bash
npm version 2.11.42 --no-git-tag-version --ignore-scripts
npm run prebuild
npm run verify
npm run apk:release
```

---

# 22. 最终 GO / NO-GO

只有以下全部通过才 GO。

## Gate A：Mainline Stability

- 复杂长篇真实 Fixture PASS；
- Summary mismatch 本地 reconcile；
- 不反向制造 State；
- 真正非法 State 仍 hard fail。

## Gate B：Elastic Input

- 确实调用 Generic Elastic Allocator；
- Generic safety margin；
- Mandatory/Preferred/Optional；
- Full Prompt Fast Path；
- relevant entity；
- final re-estimate；
- 3→2→1。

## Gate C：Repair

- 真实 invalid JSON Repair 成功；
- Repair 独立预算；
- <=3 physical fetch。

## Gate D：Long Novel

100/300/1000章压力下 Prompt 不无限增长，并保持连续性重要状态。

## Gate E：Durable

```text
force-stop
unknown
ack
recover
next automatic interval
```

完整。

## Gate F：Background

后台 / 锁屏持续工作。

## Gate G：Progress

普通、Split、Rebuild 都能真实推进。

## Gate H：Regression

```text
npm run verify PASS
升级安装数据保留
Pipeline Budget V5 无回归
Continuation 无回归
```

## Gate I：Release

```text
V2.11.42
version metadata一致
正式签名正确
```

---

# 23. 最终验收报告

输出：

```text
docs/optimization/Story-Memory-Stability-Final-Verification-YYYYMMDD.md
```

必须包含：

- baseline HEAD；
- final HEAD；
- modified files；
- Mainline Fixture；
- Elastic trace；
- 100/300/1000章压力数据；
- Provider capture；
- real LLM；
- Repair；
- Split；
- force-stop；
- auto interval ×2；
- background；
- upgrade install；
- tests；
- GO/NO-GO。

---

# 24. Agent 执行边界

Agent 必须遵守：

```text
先复现
→ 根因
→ 失败测试
→ 最小修复
→ targeted test
→ integration
→ full verify
→ real QA
```

禁止：

- 看见错误就放松全部 Validator；
- 重写 Story Memory 数据模型；
- 新建第二套 Budget；
- 推进 P2；
- 扩大 Batch；
- 改写大纲 Pipeline；
- 顺手重构 Continuation；
- 修改用户正文；
- 清除数据库规避升级问题；
- 通过增加 Retry 次数掩盖根因。

---

# 25. 最终产品状态定义

治理完成后，Story Memory 应达到：

```text
普通用户无需理解 Checkpoint
无需理解 Repair
无需理解 Batch
无需理解 outcome_unknown
无需理解 Context Budget

他只需要看到：
“长期记忆正常”
或
“正在整理 43%”
```

内部则必须保证：

```text
长篇状态受控
Prompt 注意力集中
模型合理差异可兼容
结构化事实仍严格
请求次数有上限
异常不重复付费
成功状态不回滚
强杀可恢复
自动维护可持续
后台可运行
```

这才算长期记忆从“功能可用”进入：

> **长期稳定可用。**

---

# 附录 A：给 Agent 的完整执行提示词

```text
以本地 `E:\AiWorkSpace\tavo-mini` 为唯一实施工作树，开始前执行 `git status`、`git fetch --all --prune`，核对 local HEAD 与最新 origin/main，不得覆盖任何本地未提交修改。

完整阅读 `docs\optimization` 下本方案《Tavo-Mini Story Memory 长期稳定性最终治理方案》，按 Phase 0→10 顺序自主实施。已经在当前代码中完成并有验证的 outcome_unknown、Hard Gap enqueue、Foreground/WakeLock、Task Store、UI 收束、Story Memory Output Budget V5 不得重复重构，只做回归验证。

本轮核心目标不是继续堆功能，而是彻底解决 Story Memory 长篇持续运行不稳定：

1. 先复现并固定当前复杂长篇三次 HTTP 200 仍因 `chapterSummaries ↔ mainlinePatch` 校验失败的真实 Fixture；建立 deterministic Mainline Reconciler，把仅属于检索摘要分类差异的问题在本地降级收束，Structured State 保持唯一事实权威，禁止由 Summary 反向制造 thread/conflict/objective 等长期状态；真正 Range/Reference/Evidence/CAS 错误仍必须 hard fail。

2. Story Memory Input 必须真正接入项目已有 `allocateElasticStageContextBudget()`，不得新造预算算法。Output 继续复用 `resolveElasticStageOutputReservation()`。Prompt 拆为 Mandatory / Preferred High / Preferred Low / Optional；当前 Batch 完整正文、协议、Schema、Range、完整轻量人物名册必须受保护。大 Previous State 通过 relevant character / relationship、timeline/history/archive 分级收缩。Full Prompt 能完整放下时必须保持现有语义不变，只有预算不足才 compact；最终消息必须重新 token estimate，再决定 send / shrink / 3→2→1 split。禁止字符串粗暴 slice JSON，禁止截断当前章节正文。

3. Primary / Repair / Fresh Retry / Split Child / Patch / Checkpoint / Rebuild 每次 API 都重新独立规划 Input + Output，并共享同一个 frozen LLM request config。Repair 如果因为携带 invalid output 无法安全进入窗口，不得截断 invalid JSON，应跳过 paid Repair 转 Fresh Retry。每逻辑 child batch 真实 physical fetch 总数仍 <=3，包括 Provider fallback。

4. 处理长期状态规模增长：完整轻量人物 roster 始终保留，但 rich character state、relationships、timeline/history 按当前 Batch 相关性和活跃状态进入 Prompt，避免100/300/1000章后每次 maintenance Prompt 无限增长。

5. 保持默认 Story Memory LLM Batch=3，不推进 P2、不扩大 Batch、不修改已验收的大纲 Budget V5、不修改用户正文、不做无关架构重构。

6. 完成后必须执行专项测试、100/300/1000章长篇压力测试、`npm run verify`，再执行真实 LLM：普通1M/200K三章、原复杂长篇失败 Fixture、大 Previous State、小窗口 Elastic Compact+3→2→1、人工 invalid JSON Repair、force-stop→outcome_unknown→用户确认恢复→后续自动 interval、连续2轮自动 interval、Home/锁屏后台保活；升级安装不得 uninstall/pm clear，必须证明现有项目/章节/LLM配置/Story Memory/ledger 保留。

全部 Gate 通过前不得宣称 GO，也不要升版。通过后按最新 Release 指南升 `V2.11.42`，运行 `npm version 2.11.42 --no-git-tag-version --ignore-scripts`、`npm run prebuild`、`npm run verify`、正式 APK 构建与覆盖安装验收。

最终生成 `docs/optimization/Story-Memory-Stability-Final-Verification-YYYYMMDD.md`，逐项给出证据与 GO/NO-GO。
```
