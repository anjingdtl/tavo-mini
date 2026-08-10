# Tavo-Mini Story Memory 最终修复与穿测方案（Final P1 Closure）

> 项目：`anjingdtl/tavo-mini`  
> 远端审计基线：`main@78f8c6ed531b4c22b498ec940436ceb63dd2162c`  
> 当前正式版本：`V2.11.41`  
> 当前数据库：`Schema 50`  
> 当前大纲预算：`ContextBudgetVersion = 5`  
> 建议下一发布版本：`V2.11.42`  
> 本地实施基线：`E:\AiWorkSpace\tavo-mini`（实施时以本地工作树为准，先 fetch/compare，再改）  
> 文档日期：2026-08-10  
> 修复性质：**Story Memory 最终 P1 收束，不推进 P2 并发，不扩大业务边界**

---

# 0. 执行摘要

本轮不是重新设计 Story Memory，而是在现有 `V2.11.41 / Budget V5 / Schema 50` 基础上完成最后一次 P1 收口。

截至远端 `main@78f8c6e`：

- 大纲写作流水线 Budget V5 已完成并已做真实 LLM / Batch 验证。
- Context Auto 已退出旧 `pipeline_*_max_tokens` 四阶段固定配额。
- Story Memory 已完成 Local First / Return First、Safe Coverage / Hard Gap、Non-Thinking、每逻辑批次最多 3 次真实 HTTP、持久化 request ledger、Partial Success 等核心 P1 基础。
- 最新 `78f8c6e` 仅更新 Agent / Release 指南，没有修改 Story Memory、Budget V5、Foreground Service 或 Story Memory UI 业务代码。

因此本轮只解决四类剩余问题：

1. **Story Memory LLM 仍未真正接入 Budget V5 弹性输入/输出预算。**
2. **`outcome_unknown` 缺少用户确认后的恢复闭环，一次强杀可能长期阻塞自动维护。**
3. **Hard Gap 在编辑器真实 Preview 路径下可能只阻塞、不真正启动后台整理。**
4. **Story Memory 缺少完整保活、统一任务进度和简洁用户界面，用户难以判断是否正在工作。**

最终目标：

> Story Memory 的每一次真实 API 请求都使用当前模型的真实 `context_window / max_output_tokens` 和项目统一 Budget V5 语义独立规划；写作流程永不等待 Story Memory；长期整理在后台可保活、可观察、可取消、可恢复；普通用户页面只保留一个主操作，复杂维护能力收进诊断入口。

---

# 1. 最新远端基线核查

## 1.1 最新 HEAD

最新远端：

```text
78f8c6ed531b4c22b498ec940436ceb63dd2162c
Update agent guidance for release builds and schema 50
```

相较 `V2.11.41` 发布提交：

```text
7b360f5cedc9710bcb4be0608ed3a865af7dd9ca
release: v2.11.41 budget v5 repair and QA
```

`78f8c6e` 只修改：

```text
AGENTS.md
CLAUDE.md
docs/RELEASE_APK_BUILD.md
docs/RELEASE_CHECKLIST.md
```

未修改：

```text
src/services/storyMemory/**
src/services/contextAutoAllocator.ts
src/services/pipeline/**
src/screens/StoryMemoryScreen.tsx
src/native/PipelineForegroundModule.ts
android/.../PipelineForegroundService.kt
```

所以 Story Memory 当前行为仍以 `7b360f5` 的业务代码为准。

---

## 1.2 已完成、禁止重复施工的 Budget V5

当前大纲新任务已进入：

```text
ContextBudgetVersion = 5
```

五阶段：

```text
Draft
Review
FactCheck
Brief
Final
```

每次请求均独立使用：

```ts
resolveElasticStageOutputReservation({
  contextWindow,
  modelMaxOutputTokens,
})
```

当前正式语义：

```text
requestMaxTokens =
min(context_window × 20%, model.max_output_tokens)
```

已验证基准：

```text
Context 1,000,000 / Model 200,000
→ 每阶段 200,000

Context 1,000,000 / Model 64,000
→ 每阶段 64,000

Context 128,000 / Model 32,000
→ 每阶段 25,600
```

Context Auto 同时已经：

- 不再把输出预算拆成旧 50/15/15/20；
- 不再写 `pipeline_draft_max_tokens`；
- 不再写 `pipeline_review_max_tokens`；
- 不再写 `pipeline_factcheck_max_tokens`；
- 不再写 `pipeline_proof_max_tokens`；
- Pipeline Config 已退出旧四阶段手工 Max Tokens 控件。

### 本轮禁止

**不要再次修改上述 Budget V5 写作流水线。**

禁止为了 Story Memory：

- 再改 `CURRENT_CONTEXT_BUDGET_VERSION`；
- 再改五阶段 20% reservation；
- 恢复旧 pipeline max token；
- 修改现有 Pipeline Config；
- 修改现有 Outline Prompt；
- 重造第三套 Elastic Allocator。

---

# 2. Story Memory 当前已完成能力

当前 Story Memory P1 已经具备以下基础，必须保留。

## 2.1 写作流程无阻滞

章节定稿已改为：

```text
正文先本地持久化
→ 返回写作流程
→ Story Memory maintenance 后台 enqueue
```

Story Memory LLM 不再同步阻塞章节定稿。

---

## 2.2 Safe Coverage / Hard Gap

当前设计已区分：

```text
Safe Coverage
→ 允许写作继续
→ Story Memory 可后台维护

Hard Gap
→ 本地立即 fail-closed
→ 禁止在缺少必要连续性状态时继续生成
```

这一语义不要改变。

---

## 2.3 Story Memory 全部 Non-Thinking

现有 Story Memory Structured Policy 已明确：

```text
thinking = disabled
response_format = json_object
queueClass = background
```

本轮继续保持。

---

## 2.4 真实物理请求预算

现有 `StoryMemoryAttemptBudget` 已将真正的 provider `fetch()` 纳入统一预算：

```text
单逻辑 Child Batch
真实 HTTP fetch <= 3
```

其中包括 Provider protocol fallback。

本轮弹性预算改造不得破坏这个上限。

---

## 2.5 Request Ledger

Schema 50 已新增：

```text
story_memory_request_attempts
```

用于记录：

```text
prepared
sent
succeeded
failed
outcome_unknown
cancelled
```

以及范围、attempt、HTTP/Provider 诊断。

该账本不保存正文、Prompt、API Key 或 reasoning。

本轮应继续使用，不另建第二套请求账本。

---

## 2.6 Partial Success

Story Memory Batch 拆分已经支持：

```text
第一半成功持久化
第二半失败
→ 第一半结果继续有效
→ 不回滚已经成功的 Checkpoint
```

本轮禁止破坏。

---

# 3. 当前仍存在的关键缺口

## 3.1 缺口 A：Story Memory 仍使用独立旧预算体系

当前 Story Memory 仍存在类似：

```text
memoryPatchMaxTokens
MIN_CHECKPOINT_OUTPUT_TOKENS
MAX_CHECKPOINT_OUTPUT_TOKENS
2400 → 4800 → 9600
length 后再 split
```

且当前构建路径仍会将：

```ts
memoryPatchMaxTokens: config.memoryPatchMaxTokens || 1200
```

传入 Checkpoint / Patch。

这与已经正式落地的 Budget V5 形成两套预算语义。

### 风险

对于长篇小说：

- Previous Story State 持续膨胀；
- 人物、关系、主线、伏笔越来越多；
- 当前 Batch 又包含完整正文；
- 输入不断增大；
- 输出仍受到 Story Memory 私有上限限制；
- 容易先产生 length / JSON incomplete；
- 再依靠 retry / split 补救；
- 浪费真实 HTTP 请求额度；
- 对 1M Context 模型能力利用不足。

---

## 3.2 缺口 B：`outcome_unknown` 无恢复闭环

当前流程：

```text
request ledger = sent
→ App 在请求已发出后被强杀
→ 冷启动
→ sent 标记为 outcome_unknown
```

为了避免重复付费和重复应用，自动 maintenance 会看到：

```text
prepared
sent
outcome_unknown
```

后 fail-closed。

这是正确的安全行为。

问题是：

> 用户没有一条明确的“我理解可能重复调用，继续恢复”的确认路径。

如果用户手动绕过 coordinator 重建，旧的 `outcome_unknown` 仍然可能保留。

最终可能出现：

```text
一次强杀
→ 永久阻塞后续自动 Story Memory maintenance
```

这是 P1 发版阻断项。

---

## 3.3 缺口 C：Hard Gap 真实编辑器路径可能不启动维护

当前编辑器生成前首先走 Preview。

如果 Preview 判断 Hard Gap：

```text
立即阻止生成
```

但 Preview 本身不 enqueue maintenance。

因为生成已经被阻止：

```text
generation-mode prepare
```

也不会再运行。

所以可能出现：

```text
UI：故事记忆正在整理
实际：没有 Story Memory maintenance task
```

必须修复。

---

## 3.4 缺口 D：长期记忆任务缺少统一保活与完整进度

当前：

- `rebuildStoryMemory()` 已经有 `onProgress`；
- Progress 有 `completedChapters / totalChapters / reusedPatches / regeneratedPatches`；
- 页面只展示文字；
- 没有真正的进度条；
- 最常用的普通 Checkpoint `advanceStoryMemoryCheckpointsUnlocked()` 没有对 UI 暴露 progress；
- 页面本地 `progress` state 不能代表所有自动/后台任务；
- Story Memory 没有接入 Foreground Service 生命周期。

结果：

> 用户点“立即整理长期记忆”以后，可能几十秒甚至数分钟都不知道应用是否还在工作。

---

## 3.5 缺口 E：Story Memory UI 认知负担过高

当前页面同时暴露：

更新策略：

```text
智能更新
固定间隔
每章更新
仅手动
```

操作按钮：

```text
立即整理长期记忆
高级操作
从上次失败处继续
从有效检查点重建
快速初始化
清空并重建
```

而：

```text
从上次失败处继续
从有效检查点重建
```

当前实际都走：

```ts
runRebuild('auto')
```

属于重复按钮。

此外首页还直接展示：

```text
上下文覆盖
dirtyFromPosition
整理来源
更新时间
lastError
大量人物
大量关系
大量主线信息
```

页面更像开发者诊断面板，不像普通用户功能页。

---

# 4. 本轮最终目标

本轮完成后必须满足：

## 4.1 写作体验

```text
Story Memory 永远不能成为 Safe Coverage 写作的同步 LLM 阻塞点。
```

## 4.2 Budget

```text
每一次 Story Memory API 调用
独立读取/冻结本次真实模型能力
独立计算 Input + Output Elastic Budget
```

不得再被 Story Memory 自有小窗口限制。

## 4.3 长篇能力

对于：

```text
context_window = 1,000,000
max_output_tokens = 200,000
```

Story Memory 应可真实利用：

```text
~800K input capability
~200K output reservation
```

而不是仍被：

```text
memoryPatchMaxTokens
16000
32000
```

等历史字段限制。

## 4.4 可恢复性

```text
强杀
→ outcome_unknown
→ 自动任务禁止静默重发
→ 用户看到明确提示
→ 用户确认
→ 恢复整理
→ 后续自动 maintenance 正常恢复
```

## 4.5 可感知性

Story Memory 任务必须：

- 有真实任务状态；
- 有动态进度；
- 有当前批次；
- 有当前章节范围；
- 有已完成 / 总数；
- 有耗时；
- 可取消；
- 切后台保活；
- 回到页面仍能看到当前进度。

## 4.6 UI

普通用户首页最多保留：

```text
一个主操作按钮
一个更新设置入口
一个维护与诊断入口
```

---

# 5. 最终架构

```text
                  Context Auto / LLM Settings
                           │
                           ▼
                 Frozen LLM Capability
              context_window / max_output_tokens
                           │
                           ▼
             StoryMemoryRequestBudgetAdapter
                           │
        ┌──────────────────┴───────────────────┐
        ▼                                      ▼
resolveElasticStageOutputReservation   Elastic Input Allocation
        │                                      │
        ▼                                      ▼
   Output Reservation              Mandatory / Preferred / Optional
        │                                      │
        └──────────────────┬───────────────────┘
                           ▼
                  Preflight Request Plan
                           │
               ┌───────────┴───────────┐
               ▼                       ▼
              Fit                    Not Fit
               │                       │
               ▼                       ▼
            fetch()                3 → 2 → 1
               │                  pre-split
               ▼
        StoryMemoryAttemptBudget
               │
               ▼
             Ledger
               │
               ▼
       Validate / Apply / CAS
               │
               ▼
      StoryMemoryMaintenanceCoordinator
               │
      ┌────────┼─────────┐
      ▼        ▼         ▼
  TaskStore  UI进度   Foreground/WakeLock
```

---

# 6. P1.1：Story Memory 接入 Budget V5

这是本轮最高优先级技术改造之一。

## 6.1 新增薄适配器

建议新增：

```text
src/services/storyMemory/storyMemoryRequestBudget.ts
```

职责仅限：

1. 获取本次请求冻结后的模型能力；
2. 调用项目已有 Budget V5 resolver；
3. 根据当前 Story Memory request materials 生成 input plan；
4. 判断当前 Batch 能否在发 HTTP 前安全容纳；
5. 返回该次请求的最终 `maxTokens` 和 Prompt Plan。

### 禁止

不要在此文件：

- 再实现 80/20；
- 再实现一个新的 Soft/Burst 算法；
- 再保存一套 model capability；
- 再造 Provider。

---

## 6.2 输出预算必须复用现有 resolver

Story Memory V5 路径：

```ts
const requestMaxTokens =
  resolveElasticStageOutputReservation({
    contextWindow,
    modelMaxOutputTokens,
  });
```

预期：

```text
1M / 200K → 200K
1M / 64K  → 64K
128K / 32K → 25.6K
```

### 关键原则

`max_tokens` 是输出能力上限，不是实际消耗。

Structured JSON 在完成对象后正常 `stop` 即结束，不会因为上限给 200K 就自动消耗 200K。

---

## 6.3 退出 Story Memory 私有 2400～16000 主路径

以下历史机制不得继续作为 V5 Story Memory 主预算：

```text
MIN_CHECKPOINT_OUTPUT_TOKENS
MAX_CHECKPOINT_OUTPUT_TOKENS
2400 → 4800 → 9600
memoryPatchMaxTokens 作为硬 max
```

### 兼容策略

`memoryPatchMaxTokens` 可以继续保留：

- DB 兼容；
- 老版本数据；
- Legacy fallback；
- capability 不可用时的兜底；
- 诊断显示。

但在有效 V5 model capability 存在时：

```text
memoryPatchMaxTokens 不得截断最终 max_tokens
```

---

## 6.4 每一次 API 调用必须重新独立预算

以下调用均必须重新预算：

```text
Primary
JSON Repair
Fresh Retry
Split Child Batch
Legacy Bootstrap
Patch Request
Patch Repair
Rebuild Child Request
```

原因：Repair 会新增原错误输出、repair 指令和 validation error，所以其 input tokens 与 Primary 不同。

禁止：

```text
Primary 预算一次
→ Repair / Retry 继续沿用旧 input estimate
```

---

## 6.5 Provider Protocol Fallback

Provider compatibility fallback：

```text
response_format unsupported
thinking=disabled unsupported
```

如果业务 messages 没变化，可以复用同一个 Request Envelope。

但：

```text
每一次真实 fetch
仍必须消耗 StoryMemoryAttemptBudget
```

---

## 6.6 必须冻结同一个 LLM Config Snapshot

当前风险：

```text
预算器先 getActiveLLMConfig()
→ 用户切换模型
→ callLLMResult() 又读取另一个 active config
```

可能导致：

```text
按模型 A 预算
用模型 B 发请求
```

### 要求

预算器与 Provider 必须使用同一个：

```text
FrozenStoryMemoryLLMConfig
```

至少包含：

```ts
{
  configId
  providerType
  modelName
  contextWindow
  maxOutputTokens
}
```

优先复用现有 LLM resolved request config 能力，不建立第二套配置系统。

---

# 7. P1.1：Story Memory 输入弹性规划

仅扩大 output 不够，必须同时解决 input。

## 7.1 Full Prompt Fast Path

这是默认路径。

先按当前 Story Memory 语义构造完整输入材料。

如果完整内容能安全进入 Soft/Burst：

```text
100% 保留现有 Prompt 语义
不裁剪
不摘要
不改变人物/关系输入
```

对于 1M 模型，这应该是绝大多数普通场景。

---

## 7.2 输入分级

### Mandatory

无论如何必须保留：

- System 指令；
- JSON Schema / protocol；
- 当前 Batch 完整章节正文；
- 章节 ID / position / title；
- 全量轻量人物 ID + canonicalName + aliases；
- 当前 Story Memory 基础 identity；
- CAS / state fingerprint 所需信息。

### Preferred High

优先保留：

- 当前主线；
- 当前目标；
- 活跃冲突；
- 未解决线索；
- 未兑现伏笔；
- 当前 Batch 涉及人物完整状态；
- 当前 Batch 涉及人物之间的关系；
- 最近 timeline anchors。

### Preferred Low

空间不足时可逐步收缩：

- 当前 Batch 未涉及人物的详细状态；
- 非相关关系详情；
- 较旧的 timeline；
- 已完成/已关闭的历史事项。

### Optional

最先裁剪：

- 老 archive detail；
- 与当前 Batch 无关的已闭合历史；
- 重复诊断文本；
- 可通过轻量摘要替代的历史详情。

---

## 7.3 不允许直接截断当前章节正文

当前 Batch 正文属于 Mandatory。

如果：

```text
Mandatory + Output Reservation
```

无法安全容纳，必须：

```text
3章 → 2章 → 1章
```

在 HTTP 发送前拆分。

禁止对当前章节正文直接 `.slice()` 做静默截断。

---

# 8. P1.1：发送前 Preflight Split

当前逻辑偏向：

```text
先请求
→ MEMORY_CHECKPOINT_BATCH_TOO_LARGE / length
→ 再 split
```

本轮改为：

```text
构造 Request Materials
→ Estimate
→ Elastic Plan
→ Not Fit
→ 发送前 split
```

默认仍：

```text
STORY_MEMORY_DEFAULT_BATCH_SIZE = 3
```

### 不扩大 Batch

即使 1M Context 很大，也不要在本轮自动：

```text
3 → 10
```

原因：

- 会改变语义密度；
- 会改变费用；
- 会改变提取质量；
- 会扩大风险面。

本轮只解决“能安全装下”，不是追求吞吐。

---

# 9. P1.1：Length / JSON Recovery 新策略

当 V5 已经给了完整模型 Output Reservation：

## 多章 Batch

若仍然：

```text
finish_reason = length
```

应优先：

```text
split child batch
```

而不是：

```text
2400 → 4800 → 9600
```

## 单章

如果：

```text
1章
+ Mandatory input
+ full output reservation
```

仍无法完成，应返回明确错误：

```text
当前模型输出能力不足以完成该章长期记忆结构化整理
```

不要无限探测。

## JSON Invalid

JSON 格式错误仍可进入 Repair，Repair 需要重新预算。

---

# 10. P1.2：`outcome_unknown` 用户恢复闭环

## 10.1 自动行为继续 Fail Closed

自动 maintenance 看到：

```text
prepared
sent
outcome_unknown
```

继续：

```text
拒绝自动重发
```

禁止任何后台任务自动 acknowledge unknown。

---

## 10.2 UI 必须可感知

Story Memory 页面发现当前项目存在 unresolved unknown 时显示：

```text
上一次长期记忆请求结果无法确认

应用在请求发送后中断，服务端可能已完成并计费。
为避免重复请求，自动整理已暂停。
```

主按钮变为：

```text
[ 处理未确认任务 ]
```

---

## 10.3 用户确认

点击后弹确认：

```text
继续整理可能再次调用模型 API。

如果上一请求实际上已经由服务端处理，可能产生重复调用费用。
是否继续？
```

按钮：

```text
取消
继续恢复
```

---

## 10.4 Ledger 处理

原则：

- 不删除旧 ledger row；
- 保留审计；
- 将旧 unknown 终态化；
- 后续 coordinator 不再把它视为 unresolved。

优先避免 Schema 51。

如果现有 `cancelled` 语义允许，可以使用：

```text
status = cancelled
failure_class = user_acknowledged_outcome_unknown
error_code = USER_ACKNOWLEDGED_OUTCOME_UNKNOWN
finished_at = now
```

如果代码审计发现该语义会污染其他业务判断，再升 Schema。

### 禁止

直接：

```text
DELETE outcome_unknown
```

---

## 10.5 手动整理必须统一走 Coordinator

当前 StoryMemoryScreen 不应再直接：

```text
withProjectMemoryLock(...)
advanceStoryMemoryCheckpointsUnlocked(...)
rebuildStoryMemory(...)
```

绕过 durable coordinator。

建议统一入口：

```ts
requestStoryMemoryMaintenance({
  projectId,
  throughPosition,
  reason: 'manual',
  userAcknowledgedUnknown?: true,
})
```

内部自行判断：

```text
dirty → rebuild
clean + pending → checkpoint
empty → init/full
unknown → require acknowledgement
```

---

# 11. P1.3：Hard Gap 真正启动后台维护

当前真实编辑器流程：

```text
Preview readiness
→ Hard Gap
→ 阻止生成
```

必须改为：

```text
Preview 判定 Hard Gap
→ 本地立即 fail-closed
→ enqueueStoryMemoryMaintenance()
→ 不 await
→ UI 提示
```

提示建议：

```text
故事长期记忆覆盖不足，已在后台开始整理。
整理完成后可重新生成。
```

## 11.1 去重

继续使用现有：

```text
runStoryMemoryTaskOnce
withProjectMemoryLock
```

避免用户连续点击生成造成重复 Story Memory 请求。

---

# 12. P1.4：统一 Story Memory Task Runtime

建议新增：

```text
src/store/storyMemoryTaskStore.ts
```

或等价的 Story Memory runtime store。

### 不需要新数据库表

进度属于运行态。

请求可恢复性继续由：

```text
story_memory_request_attempts
project_story_memory
story_memory_batches
```

承担。

## 12.1 Task State

建议类型：

```ts
type StoryMemoryTaskKind =
  | 'checkpoint'
  | 'rebuild'
  | 'bootstrap'
  | 'hard_gap_repair'
  | 'manual';

type StoryMemoryTaskPhase =
  | 'preparing'
  | 'planning'
  | 'requesting'
  | 'validating'
  | 'applying'
  | 'saving'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown';

interface StoryMemoryTaskProgress {
  taskId: string;
  projectId: number;
  kind: StoryMemoryTaskKind;
  phase: StoryMemoryTaskPhase;
  totalChapters: number;
  completedChapters: number;
  totalBatches: number;
  completedBatches: number;
  currentFromPosition: number | null;
  currentThroughPosition: number | null;
  currentAttempt: number | null;
  maxAttempts: number;
  percent: number;
  startedAt: number;
  updatedAt: number;
  message: string;
  error?: string;
}
```

## 12.2 Task ID

建议：

```text
story-memory:<projectId>
```

同一项目 Story Memory maintenance 保持单飞。

---

# 13. P1.4：真实进度算法

不要做假的时间百分比。

## 13.1 Batch 进度

例如待整理 10 章：

```text
Batch 1：1–3
Batch 2：4–6
Batch 3：7–9
Batch 4：10
```

进度按真实批次/章节完成推进。

可使用：

```text
percent = completedChapters / totalChapters × 100
```

建议章节数优先。

## 13.2 LLM 请求期间

模型请求本身无法获得真实 token 级进度，所以禁止：

```text
35% → 36% → 37% ...
```

这种假动画。

UI 应：

- 进度条保持真实进度；
- 展示 ActivityIndicator / pulse；
- 动态显示耗时；
- 显示当前章节范围。

例如：

```text
正在分析 第 90～92 章
第 2 / 4 批
已等待 38 秒
```

## 13.3 阶段文案

技术状态映射为普通用户语言：

```text
preparing → 正在准备
planning → 正在规划整理范围
requesting → 正在分析第 X～Y 章
validating → 正在校验长期记忆
applying → 正在合并故事状态
saving → 正在保存
completed → 整理完成
failed → 整理失败
outcome_unknown → 上次请求结果未确认
```

---

# 14. P1.4：普通 Checkpoint 也必须发 Progress

当前 `rebuildStoryMemory()` 已有 `onProgress`。

但普通：

```text
advanceStoryMemoryCheckpointsUnlocked()
```

也必须增加统一 Progress Sink。

建议 coordinator 层统一持有：

```ts
onProgress?: (progress: StoryMemoryTaskProgress) => void
```

底层：

```text
rebuild
checkpoint
split child
repair
```

都通过同一个 emitter 汇报。

---

# 15. P1.4：Foreground Keepalive

现有 Android `PipelineForegroundService` 已经具备：

- `START_STICKY`；
- `PARTIAL_WAKE_LOCK`；
- 30分钟 lock timeout；
- 15分钟检查/续期；
- ongoing notification；
- 0～100% progress bar；
- shared active task semantics。

本轮：

> **直接复用，不新建 StoryMemoryForegroundService。**

## 15.1 JS 适配

建议新增：

```text
src/services/storyMemory/storyMemoryForeground.ts
```

内部薄封装：

```ts
PipelineForeground.start(...)
PipelineForeground.updateProgress(...)
PipelineForeground.stop(...)
```

Title：

```text
ShineWriter · 长期记忆
```

Stage：

```text
正在整理第 90～92 章
```

## 15.2 生命周期

必须由：

```text
StoryMemoryMaintenanceCoordinator
```

管理。

禁止把 Foreground 生命周期绑在 `StoryMemoryScreen`，否则用户退出页面可能错误停止保活。

## 15.3 Start / Stop

```text
maintenance 真正开始
→ foreground start

每次真实 progress
→ update

completed / failed / cancelled / outcome_unknown
→ foreground stop
```

## 15.4 完成通知

现有 `notifyComplete / notifyFailed` 的 deep-link 语义偏 Pipeline Task。

不要直接给：

```text
story-memory:123
```

塞进旧 Pipeline Result 路由。

### 推荐

给通用通知新增：

```text
targetKind
targetId
```

例如：

```text
targetKind = story_memory
targetId = projectId
```

通知点击打开对应项目 Story Memory。

如果实施成本明显增加，可将“完成通知 deep-link”降为次优先，但**Foreground 保活 + 运行中通知必须完成**。

---

# 16. Story Memory 页面最终 UI 收束

## 16.1 第一屏只解决四个问题

用户进入页面首先只需要知道：

1. 长期记忆现在是否健康？
2. 已整理到哪？
3. 还有多少待整理？
4. 现在要不要做什么？

## 16.2 推荐第一屏

```text
长期记忆
────────────────────────
● 正常

已整理至      第 86 章
待整理        第 87～96 章 · 10章
更新方式      智能更新 · 每10章
最后更新      今天 14:32

[ 整理长期记忆 ]

更新设置                         >
维护与诊断                       >
────────────────────────

记忆内容

登场人物          18              >
人物关系          26              >
故事主线                           >
未解决线索         8              >
未兑现伏笔         4              >
```

## 16.3 运行中

```text
● 正在整理

正在分析      第 90～92 章
批次          2 / 4

████████░░░░░░   47%

已完成        5 / 10 章
已用时        01:36

[ 停止整理 ]
```

## 16.4 主按钮状态机

只允许一个 Primary CTA。

### empty

```text
[ 初始化长期记忆 ]
```

内部自动决定 legacy bootstrap / full，用户不选择实现细节。

### clean + pending

```text
[ 整理长期记忆 ]
```

### dirty / failed

```text
[ 继续整理 ]
```

### outcome_unknown

```text
[ 处理未确认任务 ]
```

### running

```text
[ 停止整理 ]
```

### clean + no pending

```text
已是最新
```

可不显示按钮。

---

# 17. 更新策略 UI 收束

当前四个大 Button 改为一行：

```text
更新方式     智能更新（推荐） >
```

点入设置页/Modal：

```text
○ 智能更新（推荐）
○ 固定间隔
○ 每章更新
○ 仅手动
```

如果选择智能 / 固定，再展示：

```text
每 [10] 章
```

---

# 18. 维护与诊断

普通用户首页不再直接展示：

```text
dirtyFromPosition
source
lastError
checkpoint
request ledger
outcome_unknown detail
HTTP attempt
budget
```

全部进入：

```text
维护与诊断 >
```

## 18.1 一级维护操作只保留两个

### 重新整理长期记忆

统一替代：

```text
从上次失败处继续
从有效检查点重建
```

系统自己判断最近有效恢复点。

### 清空并重新构建

危险操作，必须二次确认：

```text
将删除现有结构化长期记忆，并重新从章节正文构建。
不会删除章节正文。
```

## 18.2 快速初始化

不要作为常驻按钮。

如果 `state = empty`，由“初始化长期记忆”内部自动决定 bootstrap/full。

---

# 19. 记忆内容折叠

当前人物、关系、主线全部直接展开，长篇项目页面会非常长。

建议默认：

```text
登场人物（18） >
人物关系（26） >
故事主线 >
未解决线索（8） >
未兑现伏笔（4） >
```

点入详情后再展示完整内容。

---

# 20. Coordinator 最终职责

建议把所有 Story Memory maintenance 集中为一个权威入口。

例如：

```ts
requestStoryMemoryMaintenance({
  projectId,
  throughPosition?,
  reason,
  signal?,
  userAcknowledgedUnknown?,
})
```

负责：

1. single-flight；
2. project lock；
3. unresolved attempt gate；
4. dirty/rebuild/checkpoint/bootstrap 决策；
5. frozen LLM config；
6. Elastic Budget；
7. foreground；
8. progress；
9. ledger；
10. completion/failure；
11. cancellation。

UI 不再自己拼这些流程。

---

# 21. 文件级施工建议

## 必查 / 预计修改

```text
src/services/storyMemory/storyMemoryService.ts
src/services/storyMemory/storyMemoryCheckpointService.ts
src/services/storyMemory/storyMemoryRebuild.ts
src/services/storyMemory/storyMemoryBudget.ts
src/services/storyMemory/storyMemoryAttemptBudget.ts
src/services/storyMemory/storyMemoryAttemptPolicy.ts
src/services/storyMemory/storyMemoryRequestPolicy.ts
src/services/storyMemory/storyMemoryPrepare.ts
src/data/repositories/storyMemoryRequestAttemptRepository.ts
src/screens/StoryMemoryScreen.tsx
src/screens/chapter-editor/hooks/useChapterPipeline.ts
src/native/PipelineForegroundModule.ts
android/app/src/main/java/com/shinewriter/PipelineForegroundModule.kt
android/app/src/main/java/com/shinewriter/PipelineForegroundService.kt
```

## 建议新增

```text
src/services/storyMemory/storyMemoryRequestBudget.ts
src/services/storyMemory/storyMemoryProgress.ts
src/services/storyMemory/storyMemoryForeground.ts
src/store/storyMemoryTaskStore.ts
```

如已有等价公共组件，则复用，不机械新增。

---

# 22. Schema 边界

默认目标：

```text
Schema 50 不变
```

只有在：

```text
outcome_unknown 无法用现有 terminal status 安全表达用户确认
```

时才允许 Schema 51。

### 禁止

为了 progress、UI、foreground、budget trace 随意新建数据库表。

运行进度优先放 runtime store。

---

# 23. P2 边界

本轮：

```text
P2 = STOP
```

禁止：

- Stateless Observation 并发；
- 2 Worker；
- 并行 Story Memory Reducer；
- 自动扩大 Batch；
- 多 Provider 并行；
- speculative request。

目标只有：

```text
P1 稳定
P1 可恢复
P1 可观察
P1 用户可理解
```

---

# 24. 必须新增的测试

## 24.1 Budget V5 对齐测试

新增建议：

```text
__tests__/storyMemoryBudgetV5.test.ts
```

### Case 1

```text
context=1,000,000
max_output=200,000
```

Provider 捕获：

```text
max_tokens = 200,000
```

### Case 2

```text
1M / 64K → 64K
```

### Case 3

```text
128K / 32K → 25.6K
```

### Case 4

故意设置：

```text
memoryPatchMaxTokens = 800
memoryPatchMaxTokens = 1200
memoryPatchMaxTokens = 4000
```

有效 V5 capability 存在时不得影响 provider max_tokens。

---

## 24.2 每请求重新预算

Primary：

```text
input = A
```

Repair：

```text
input = A + invalid output + repair instruction
```

验证：

```text
Repair estimate != Primary estimate
```

并且二者各自满足 Context Window。

---

## 24.3 Preflight Split

构造小窗口，3章无法安全容纳。

期望：

```text
3章请求 fetch = 0
```

先 split。

---

## 24.4 Single Chapter Hard Failure

1章仍装不下：

```text
fetch = 0
明确模型能力不足错误
```

---

## 24.5 Outcome Unknown 完整恢复测试

必须完整覆盖：

```text
sent
→ cold start
→ outcome_unknown
→ automatic maintenance blocked
→ user sees warning
→ user cancel
→ no request
→ user confirm
→ old unknown terminalized
→ new manual request exactly once
→ success
→ later automatic maintenance works
```

---

## 24.6 多 unknown

测试：

- 多条 unknown；
- 不同 range；
- 已完成旧范围；
- 当前待整理范围。

确保不会误清除其他仍需人工处理的账本。

---

## 24.7 Hard Gap 编辑器真实路径

不要只测试：

```text
prepare(mode='generation')
```

必须测试实际：

```text
useChapterPipeline
→ Preview
→ Hard Gap
```

期望：

```text
generation blocked
maintenance enqueue once
LLM not awaited
```

---

## 24.8 Progress

测试：

```text
10 chapters / 4 batches
```

依次产生等价真实进度：

```text
0
3/10
6/10
9/10
10/10
```

---

## 24.9 Foreground

Mock：

```text
start once
update per progress
stop on success
stop on fail
stop on cancel
```

切换 StoryMemoryScreen mount/unmount 不得停止后台 task。

---

## 24.10 UI

至少验证：

- 首页同时最多 1 个 primary action；
- duplicate rebuild buttons 不存在；
- running 显示 progress；
- outcome_unknown 显示处理入口；
- clean/no pending 显示最新；
- 更新方式不再四个大按钮常驻；
- 技术诊断默认折叠。

---

# 25. 真实 LLM 穿测

本轮不能只跑 Mock。

## 25.1 普通 1M 三章

配置：

```text
Context 1M
max_output 200K
Batch 3
```

验证：

```text
Full Prompt Fast Path
无无意义裁剪
一次成功
无 2400/16000 clamp
```

## 25.2 复杂长篇三章

构造：

- 长正文；
- 多人物；
- 多关系；
- 多主线；
- 多伏笔；
- 大 Previous State。

验证：

```text
仍可完成
或在 HTTP 前合理 shrink/split
```

## 25.3 小窗口

配置真实或测试模型：

```text
32K / 64K / 128K
```

验证：

```text
3→2→1 preflight
```

不靠第一次 API 失败探测。

## 25.4 Repair

人为制造一次 invalid JSON。

确认：

```text
Repair 独立预算
总 fetch <= 3
```

## 25.5 Force Stop

必须真实执行：

```text
Story Memory HTTP 已发出
→ adb force-stop / kill process
→ 冷启动
```

验证：

```text
outcome_unknown
自动不重发
UI 可见
用户确认
恢复成功
后续自动任务正常
```

## 25.6 Background Keepalive

开始整理后：

```text
Home
切微信/浏览器
锁屏
等待
返回 App
```

验证：

- Foreground notification 存在；
- WakeLock / Service 工作；
- 进度更新；
- JS task 不因切后台直接丢失；
- 返回页面显示同一个 Task；
- 完成后 Service 正确停止。

---

# 26. 升级安装穿测

不得：

```text
uninstall
pm clear
```

从现有 V2.11.41 覆盖安装测试包。

确认保留：

- 小说项目；
- 章节正文；
- LLM Config；
- API Key SecureStorage；
- Story Memory；
- Story Memory ledger；
- Context Auto；
- 其他用户配置。

---

# 27. 全量质量门禁

完成后必须执行：

```text
npm run verify
```

并单独记录：

```text
npm run lint
npm run typecheck
npm run verify:version
npm run test:ci
git diff --check
```

如新增 Schema：

```text
migration tests
fresh install schema
upgrade install schema
backup/restore
```

---

# 28. Release 规则

当前 `V2.11.41` 已存在 release commit。

本轮如果进入正式发布：

```text
建议 V2.11.42
```

必须按最新仓库指南：

```bash
npm version 2.11.42 --no-git-tag-version --ignore-scripts
npm run prebuild
npm run verify:version
npm run verify
npm run apk:release
```

### 禁止

```text
手改 src/constants/version.json
```

必须确认：

```text
package.json
package-lock.json
version.json
APK versionName/versionCode
```

一致。

---

# 29. 发版 GO / NO-GO 门槛

只有以下全部通过，才：

```text
GO
```

## Gate A：Budget V5

- Story Memory 每次请求独立预算；
- Input / Output 都使用统一能力；
- 1M/200K → 200K；
- 不受 16000 / memoryPatchMaxTokens 硬限制；
- Preflight split 生效。

## Gate B：No-Stall

- Safe Coverage 不等待 Story Memory LLM；
- chapter finalize 仍 Local First / Return First；
- Hard Gap 本地立即阻止；
- Hard Gap 自动启动后台 maintenance。

## Gate C：Durable

- 真实 `fetch <= 3`；
- `outcome_unknown` 不静默重发；
- 用户确认后可恢复；
- 后续自动 maintenance 不再永久锁死。

## Gate D：Progress / Keepalive

- 手动整理有进度；
- 自动整理有进度；
- rebuild 有进度；
- 切后台任务继续；
- Foreground notification 更新；
- cancel 正常；
- terminal 正确 stop。

## Gate E：UI

- 首页仅一个 Primary CTA；
- 重复按钮消失；
- 更新策略收进单入口；
- 技术诊断收进维护页；
- 大量人物/关系默认不铺满首页。

## Gate F：真实 LLM

- 普通三章成功；
- 复杂长篇三章成功；
- 小窗口 pre-split；
- Repair；
- Force Stop；
- 后台运行。

## Gate G：Regression

- `npm run verify` 全过；
- 覆盖安装数据保留；
- 写作 Budget V5 不回归；
- Continuation 不回归；
- Schema / backup 不回归。

---

# 30. 明确禁止的“顺手改造”

Agent 本轮禁止：

- 重写 Story Memory Schema；
- 改人物数据结构；
- 改主线 Schema；
- 改 Story Memory Prompt 业务字段；
- 改写作流水线 Budget V5；
- 改 Continuation Budget；
- 启用 P2；
- 将 Story Memory Batch 提高到 10；
- 修改用户章节正文；
- 修改 Safe Coverage 业务定义；
- 删除 request ledger；
- 新造 LLM Provider；
- 大规模重构 Foreground Service；
- 为 UI 进度引入复杂数据库任务系统。

---

# 31. 推荐施工顺序

必须按顺序，不要并行乱改。

## Phase 0：本地同步与复现

```bash
git status
git fetch --all --prune
git log --oneline --decorate -20
git diff HEAD..origin/main --stat
```

要求：

- 不覆盖本地未提交工作；
- 记录 local HEAD；
- 记录 origin/main；
- 如果本地已有比远端更晚的 Story Memory 修复，先重新审计方案。

先复现：

1. Story Memory 旧 output clamp；
2. outcome_unknown permanent block；
3. Hard Gap Preview 不 enqueue；
4. 普通 checkpoint 无 progress；
5. StoryMemoryScreen 重复按钮。

## Phase 1：Budget V5 Adapter

只改：

```text
request budget
frozen config
preflight
```

先完成测试。

## Phase 2：Outcome Unknown

补：

```text
repository acknowledge
coordinator
manual confirm
```

完成强杀恢复单元/集成测试。

## Phase 3：Hard Gap

补真实编辑器路径 enqueue。

## Phase 4：Task / Progress / Foreground

先做 coordinator runtime，再接 UI。

## Phase 5：UI 收束

只在底层任务状态稳定后调整 StoryMemoryScreen。

## Phase 6：全量穿测

最后才做：

```text
真实 LLM
模拟器后台
force-stop
release APK
```

---

# 32. Agent 最终交付物

完成后必须输出一份新的验收报告：

```text
docs/optimization/Story-Memory-Final-P1-Verification-YYYYMMDD.md
```

内容至少包含：

1. 实施前 local HEAD；
2. 实施前 origin/main；
3. 最终 commit；
4. 修改文件；
5. Budget V5 Provider 捕获；
6. 真实 LLM tokens；
7. Preflight split；
8. outcome_unknown 强杀恢复；
9. Foreground/WakeLock；
10. UI 截图；
11. 全量 tests；
12. APK 覆盖安装；
13. 数据保留；
14. GO / NO-GO。

---

# 33. 最终验收判断

本轮完成后期望状态：

```text
P1：GO
P2：STOP
```

Story Memory 的最终用户体验应为：

```text
写作不卡
长期记忆自己在后台维护
用户能看到它正在做什么
大模型能真正利用大上下文
小模型会在调用前主动缩批
App 强杀后不会静默重复消费
也不会因为一次 unknown 永久坏掉
页面只给普通用户必要按钮
复杂诊断仍然可进入查看
```

这才算 Story Memory P1 完整收束。

---

# 附录 A：给 Agent 的执行约束

```text
以本地 E:\AiWorkSpace\tavo-mini 为唯一实施工作树，远端 origin/main@78f8c6e 仅作为审计基线。开始前必须 git fetch --all --prune，检查本地是否已有更新；如果本地代码已经解决本文某项，不得重复修改，先验证后跳过。

严格执行本文 Story Memory Final P1 范围，不推进 P2，不改已验收的 Budget V5 写作流水线，不做额外重构。所有 BUG 先复现、定位根因、补失败测试，再修复。

重点完成：
1）Story Memory 所有真实 API 请求接入现有 Budget V5：每次 Primary/Repair/Retry/Split 独立冻结同一个真实 LLM config，并按 context_window/max_output_tokens 重新规划 Input + Output；退出 2400～16000 和 memoryPatchMaxTokens 对 V5 主路径的硬限制；3章装不下必须 fetch 前 3→2→1。
2）补 outcome_unknown 用户确认/恢复闭环，自动任务绝不静默重发，保留 ledger 审计，确认恢复成功后后续自动 maintenance 必须重新正常工作。
3）Hard Gap 在编辑器 Preview 真实路径中立即 fail-closed，同时后台 enqueue maintenance，不等待 LLM。
4）建立统一 Story Memory task/progress，手动、自动、rebuild 都可观察；复用现有 PipelineForegroundService 的 Foreground + WakeLock + notification，不新建第二套原生 Service。
5）收束 StoryMemoryScreen：首页最多一个 Primary CTA；更新策略、维护诊断分别一个入口；合并重复 rebuild 按钮；快速初始化由系统自动决策；人物/关系/主线默认折叠。

必须完成 targeted tests、npm run verify、真实 LLM 1M/复杂长篇/小窗口 pre-split/Repair、模拟器后台保活、真实 force-stop→outcome_unknown→用户确认→恢复→自动维护、覆盖安装数据保留。最终输出验收 MD 与 GO/NO-GO。
```

---

# 附录 B：本轮非目标

```text
P2 Story Memory 并发
Stateless Observation
Reducer 并发
2 Worker
自动扩 Batch
Prompt 业务 Schema 重写
知识图谱
长期记忆内容模型重构
Continuation 改造
大纲 Pipeline Budget 再设计
```

以上均不属于本轮。
