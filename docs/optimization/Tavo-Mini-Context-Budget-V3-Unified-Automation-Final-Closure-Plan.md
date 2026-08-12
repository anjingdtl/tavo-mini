# Tavo-Mini Context Budget V3 全链路自动弹性预算最终收束与修复改造方案

> 项目：Tavo-Mini  
> 方案定位：**Context Budget V3 全链路最终收束 / Unified Automatic Context Closure**  
> 远端审计参考基线：`bc464f537ecd4e1676c3cb6c92b0a4dea1dc3429`  
> 注意：该 SHA 仅是本方案编制时的远端参考。实施时必须以 Agent 当前开发机上的本地仓实际代码、当前 HEAD 和 `origin/main` 为准，不得假设远端基线未变化。  
> 日期：2026-08-12

---

# 0. 执行摘要

经过 Context Budget V3 前几轮建设，目前项目已经具备：

```text
Model Context Window
    ↓
Soft / Burst / Hard Envelope
    ↓
Story State / Resources / Sliding / Episodic
Board-level Hierarchical Allocation
    ↓
Resources Candidate-first
    ↓
Item-level Elastic Allocation
    ↓
Preview / Frozen Draft Context
    ↓
Review / FactCheck / Brief / Final
```

但本轮重新从远端代码、上一轮独立验收、用户真实 Android 报错和章节 UI 反查后，确认仍有若干“表面接入弹性，实际仍被旧配置或固定上限控制”的残留点：

1. **Recent Bridge / Sliding Coverage 仍受旧 `slidingWindowSize` 先验约束**，V3 allocator 运行前就可能裁剪或产生 Hard Gap。
2. **Derived Final Rewrite（仅重写终稿）仍走大行 `SELECT *` 和大字段复制**，Android 可直接触发 `CursorWindow`，Final API 尚未发出。
3. **Final Reviser V3 内部仍存在 12K/8K/6K/4K/5K 等静态单模块 `maxTokens`**，1M 模型也无法充分借调空闲上下文。
4. **章节页仍存在手动“上下文配置”入口**，用户可设置滑动窗口 / 完整前文 / 自定义及固定 token，与 V3 自动预算形成双重控制。
5. **Batch 必须补齐 V3 Policy/hash 整批冻结**，避免同一批次子任务在 live Policy 修改后发生预算漂移。
6. **高负载数据库读取、Snapshot 膨胀、Continuation 分类预算等旁路仍需全链路审计**，确保没有再次绕过统一弹性分配。

本轮目标不是继续增加新的预算体系，而是：

> **把所有新 V3 写作路径统一到“模型真实能力 → Story Coverage → Actual Demand → 全局弹性借调 → 最终 Token-safe 渲染”的单一规则上；旧手动 ContextConfig 只保留 Legacy 兼容，不再影响新 V3 任务。**

最终用户体验：

```text
用户负责：
选择模型
启用资料
填写章节要求
查看上下文预览

系统负责：
决定读哪些前文
决定 Story Memory / Episodic / Resources 各占多少
自动回收空闲预算
跨板块借调
根据模型窗口动态扩张/收缩
保证最终请求不超窗口
```

---

# 1. 实施基本原则

## 1.1 Local Repository Is Truth

Agent 不得依赖任何写死路径。开始时先定位当前仓库：

```bash
git rev-parse --show-toplevel
```

进入实际 repo root 后执行：

```bash
git status
git fetch --all --prune
git rev-parse HEAD
git rev-parse origin/main
git rev-list --left-right --count HEAD...origin/main
git log -10 --oneline
```

要求：

- 保留所有本地未提交修改；
- 禁止直接 `reset --hard`；
- 本地领先远端时以本地实现为主；
- 远端领先时先核差异，再决定是否同步；
- 本方案中的文件名、函数名仅作为审计线索；
- 最终实现必须依据本地当前真实调用链。

---

# 2. 开工前必须完成的全链路扫描

## 2.1 Legacy ContextConfig

```bash
rg -n "ContextConfig|ContextStrategy|context_strategy|slidingWindowSize|sliding_window_size|recentChapterCount|customRangeStart|customRangeEnd|resourceBudget|summaryBudgetTokens|storyStateBudgetTokens|episodicMemoryBudgetTokens|memoryTopK|worldbookScanDepth|includeResources|worldbookRecursive" src __tests__
```

## 2.2 固定 token / 静态 cap

```bash
rg -n "maxTokens:\s*[0-9]|minTokens:\s*[0-9]|targetTokens:\s*[0-9]|MAX_.*BUDGET|DEFAULT_.*BUDGET|allocateStageContextBudget|allocateElasticStageContextBudget|allocateHierarchicalContextBudget|compileStageRequestWithElasticBudget" src/services src/screens __tests__
```

必须覆盖：

```text
Draft
Review
FactCheck
Brief
Final / Proof
Repair
Derived Final Rewrite
Continuation
Context Preview
Story Memory Coverage
```

## 2.3 CursorWindow / 大字段

```bash
rg -n "SELECT \* FROM pipeline_tasks|SELECT \* FROM pipeline_stage_checkpoints|getPipelineTaskById|getAllPipelineTasks|getUnresolvedPipelineTasks|getStageCheckpoints|pipeline_context_json|output_text|final_text" src __tests__
```

## 2.4 Version / Policy Freeze / Batch

```bash
rg -n "getContextAutoMode|getContextAutomationPolicyV3|contextBudgetVersion|context_budget_version|policyHash|policySnapshot|multi_chapter_batches|parent_task_id|derivedKind|final_rewrite" src __tests__
```

## 2.5 Story Coverage

```bash
rg -n "planStoryMemoryCoverage|prepareStoryMemoryForGeneration|buildPendingBridgeText|STORY_MEMORY_MAX_RAW_CHAPTERS|recentBridge|episodicFallbackChapterIds|hardGap" src __tests__
```

## 2.6 Continuation

```bash
rg -n "ContinuationContextBudget|categoryShares|recentBridgeTokens|storyMemoryTokens|episodicTokens|supplementTokens|canonTokens|allocateDemandsWithinCapacity" src/services/continuation __tests__
```

---

# 3. 本轮目标架构

新 V3 Outline Writing 最终统一为：

```text
Frozen Model Capability
context_window / max_output_tokens
        ↓
Frozen Context Automation Policy V3
        ↓
Mandatory
System / Preset / Outline / Current Instruction
        ↓
Story Coverage Candidate Planner
        │
        ├─ Story Memory Checkpoint
        ├─ ≤10 Recent Raw Chapter Candidates
        ├─ Immediate Seam
        └─ Episodic Fallback Candidates
        ↓
Actual Demand Collector
┌────────────────────────────────────┐
│ Story State                        │
│ Recent Bridge / Sliding            │
│ Resources                          │
│ Episodic                           │
└────────────────────────────────────┘
        ↓
Global Hierarchical Board Allocator
Soft → Reclaim → Borrow → Burst → Hard
        ↓
Board-specific Item Resolver
        │
        ├─ Resource Item Allocator
        └─ Recent Bridge Coverage Resolver
        ↓
Final Token-safe Rendering
        ↓
Frozen Draft Context
        ↓
Review / FactCheck
Stage-level Elastic Compiler
        ↓
Brief
Compact Semantic Contract
        ↓
Final Reviser
Stage-level Elastic Allocation
NO absolute module caps
        ↓
Final Hard Window Guard
```

---

# 4. P0-1：Recent Bridge / Sliding Coverage 脱离旧静态预算

## 4.1 根因

Story Memory readiness / coverage 仍可能在 V3 allocator 运行前使用：

```text
config.slidingWindowSize
```

作为 `planStoryMemoryCoverage()` 的 `slidingBudgetTokens`。

错误顺序：

```text
旧 4000 / 用户手动值
    ↓
先规划 raw / summary / uncovered
    ↓
可能产生 hardGap
    ↓
V3 allocator 才开始
```

即使冻结模型是 128K / 1M，也可能因旧 4K 值先被判断为覆盖不足。

## 4.2 拆成两阶段

### Phase A：Budget-neutral Coverage Candidates

只负责：

```text
Checkpoint through position
Pending chapters
Immediate seam
最近最多10个 raw candidate
更老 pending chapter
哪些 chapter 有可用 memory_summary
```

不根据 token budget 决定 raw / summary / uncovered。

建议结构：

```ts
interface StoryCoverageCandidates {
  checkpointThroughPosition: number;
  pendingChapters: Chapter[];
  seamChapter: Chapter | null;
  rawEligibleChapters: Chapter[];
  episodicEligibleChapters: Chapter[];
}
```

### Phase B：V3 Grant-driven Coverage Resolution

等 V3 Board Allocator 给出：

```text
slidingWindow.allocatedTokens
episodic.allocatedTokens
```

再决定：

```text
哪些 pending chapter full raw
哪些转 summary
哪些只保 seam tail
哪些确实无法覆盖
```

## 4.3 最近正文 Hard Guard 保留

继续：

```text
STORY_MEMORY_MAX_RAW_CHAPTERS = 10
```

这是产品 Hard Guard，不是用户配置。

```text
32K → 最多10章 raw
1M  → 仍最多10章 raw
```

模型变大只意味着这 10 章更有机会完整，不意味着恢复全历史 raw。

## 4.4 Immediate Previous / Seam

直接上一章作为 Recent Bridge 的最高优先 Candidate。

预算充分：

```text
完整上一章
```

预算不足：

```text
至少保结尾 Seam
```

不得在 Snapshot 层再偷塞一份无预算全文。

## 4.5 硬不变量

```text
estimateTokens(finalRecentBridgeText)
<=
boardAllocations.slidingWindow.allocatedTokens
```

不得出现 allocator 记 8K、实际 Pending Bridge 20K。

---

# 5. P0-2：消除 Snapshot 中无预算的上一章全文第二份复制

当前 Draft 编译后可能额外写入：

```text
pipelineContext.immediatePreviousChapterText = 上一章完整正文
```

即使 `recentBridgeText` 已存在。

风险：

1. `pipeline_context_json` 膨胀；
2. CursorWindow 风险增大；
3. Final Reviser 拿到未受 Board grant 的全文；
4. 连续性信息重复。

新 V6 建议：

```text
recentBridgeText
```

作为近期正文统一载体。

另保留：

```text
immediatePreviousChapterEnding
immediatePreviousChapterId
immediatePreviousChapterPosition
```

如果 Final 确需更多上一章正文，只能从已冻结、已预算授权的 Recent Bridge 派生。

Legacy V1~V5 可保持旧字段；V6 不再冻结无预算完整上一章，或仅保存经过 grant 的 bounded text。

---

# 6. P0-3：Derived Final Rewrite CursorWindow

## 6.1 用户真实链路

```text
流水线结果
→ 仅重写终稿
→ 确认并执行
→ 无法创建派生任务
→ Row too big to fit into CursorWindow
```

错误发生在 Final API 之前。

## 6.2 根因链

典型：

```text
PipelineResultScreen
→ createDerivedFinalRewriteTask()
→ getPipelineTaskById(parentTaskId)
→ SELECT * FROM pipeline_tasks
```

一行同时可能包含：

```text
stage_results
final_text
pipeline_context_json
```

Android CursorWindow 直接失败。

## 6.3 专用窄读取

新增或复用：

```ts
getPipelineTaskForDerivedFinalRewrite()
```

只读必要 metadata：

```text
id
target_type
target_id
status
outline_workflow_version
context_budget_version
pipeline_context_version
pipeline_context_hash
parent_task_id
derived_kind
```

禁止该路径 `SELECT *`。

## 6.4 大字段 Lazy / Chunk Read

需要 `pipeline_context_json / final_text / checkpoint.output_text` 时：

- 单列读取；
- bounded `substr` chunk；
- 不允许一次 SQLite row 返回多个大 TEXT。

## 6.5 Child 不应复制全部大 Blob

优先：

```text
Derived Child
  parent_task_id
  derived_instruction
  proof pending
```

上游 Frozen Evidence 引用 Parent。

若本轮不适合改持久化模型，可以安全 Chunk Copy，但必须证明不再 CursorWindow。

## 6.6 调用次数硬约束

```text
Draft        +0
Review       +0
FactCheck    +0
Brief        +0
Final        +1
```

用户新终稿要求低于 Brief hard requirement、事实、世界规则、大纲边界。

## 6.7 类型

禁止 stale：

```ts
as 3 | 4 | 5
```

统一共享 `ContextBudgetVersion`，必须包含 6。

---

# 7. P0-4：高 Payload `SELECT *` 全项目审计

不仅 Derived Final。

必须审计：

```text
getPipelineTaskById
getAllPipelineTasks
getUnresolvedPipelineTasks
getStageCheckpoints
cold-start resume
task result
batch resume
derived rewrite
adoption
```

建议 Repository 分层：

```text
PipelineTaskSummary
PipelineTaskMetadata
PipelineTaskFrozenContextPayload
PipelineTaskFinalTextPayload
PipelineCheckpointSummary
PipelineCheckpointOutputPayload
```

对：

```text
pipeline_tasks
pipeline_stage_checkpoints
```

新的用户关键路径禁止万能 `SELECT *`。

回归测试可主动规定：

```text
SELECT * FROM pipeline_tasks
→ throw CursorWindow error
```

验证 Task list / Adoption / Derived / Resume / Batch Resume 正常。

---

# 8. P0-5：Final Reviser V3 移除静态单模块 Hard Cap

远端当前 Final elastic module 仍可见类似：

```text
Immediate Previous  max 12K
Story Memory        max 8K
Characters          max 6K
World Rules         max 6K
Note                max 4K
Recent Bridge       max 6K
Episodic            max 5K
Preset              max 2.2K
User Prompt         max 1.8K
```

这会导致 1M 模型也无法借到这些固定上限以上。

## 8.1 正确规则

Final 同样：

```text
availableTokens = actualTokens
maxTokens       = actualTokens
```

Hard Cap 只来自：

```text
模型窗口
stage envelope
内容真实大小
```

如需 shaping，只能使用：

```text
soft target
priority
relevance
stage-relative ratio
```

不能使用绝对 token hard cap。

## 8.2 优先级

Mandatory：

```text
Final Brief
Canonical Draft
Full Outline
Current Revision Instruction
Immediate Previous Ending
```

Preferred High：

```text
Immediate Previous / Recent Continuity
Story Memory
Relevant Character Facts
World Rules
```

Preferred：

```text
Notes
```

Optional：

```text
Recent Bridge
Episodic
Preset
Retrieval User Prompt
```

Recent Bridge 与 Immediate Previous 收束后避免重复。

## 8.3 模型缩放

相同 Final Payload：

```text
32K
64K
128K
1M
```

高价值辅助模块 grant 应随模型增长，直到 actual demand 满足，不得在固定 6K/8K/12K 停止。

---

# 9. P0-6：删除章节“上下文配置”，统一自动化

当前章节上下文页仍允许用户设置：

```text
滑动窗口
完整前文
自定义
前文预算
最近正文章数
摘要预算
Memory Top K
资料预算
世界书扫描深度
Include Resources
Worldbook Recursive
```

这与 V3 的 Actual Demand / Soft / Borrow / Ceiling 双重控制。

## 9.1 UI

章节写作页只保留：

```text
上下文预览
```

删除：

```text
上下文配置
```

不再让用户决定上下文算法。

## 9.2 新版前文统一规则

```text
Story Memory Checkpoint
    ↓
未被 checkpoint 覆盖的近期章节
    ↓
Recent Bridge（≤10 raw）
    ↓
更老/相关历史
    ↓
Episodic Retrieval
```

## 9.3 自定义能力

不再是全局 Context Strategy。

未来如需要，改成：

```text
本次额外参考章节：
✓ 第12章
✓ 第18章
✓ 第27章
```

作为 Preferred High Candidate，仍接受统一 V3 allocation。

## 9.4 Legacy 字段暂不删除

保留：

```text
context_strategy
sliding_window_size
custom_range_start/end
resource_budget
summary_budget_tokens
story_state_budget_tokens
episodic_memory_budget_tokens
memory_top_k
recent_chapter_count
...
```

供旧任务 Resume / 导入 / 备份兼容。

新 `contextBudgetVersion=6` 必须完全忽略这些字段作为预算决策。

## 9.5 Poison Legacy Test

设置：

```text
strategy=custom
customRange 不包含最近章
slidingWindowSize=1
recentChapterCount=1
resourceBudget=1
storyStateBudget=1
episodicBudget=1
```

运行 V6。

断言分配与合理 Legacy 值情况下完全一致，除非字段被明确归类为非预算 Feature Semantics。

---

# 10. `includeResources / worldbookRecursive / worldbookScanDepth` 收束

## includeResources

V6 不应由 global `includeResources=false` 关闭整个资料 Board。

应由：

```text
资源自身 enabled
项目绑定
激活/命中
```

决定 Candidate。

旧 `includeResources` 留给 Legacy。

## worldbookRecursive

这是 Retrieval Feature，不是 Budget。

建议固定安全默认或移动到 Worldbook 高级设置，不再放 Context Budget 页面。

## worldbookScanDepth

V3 应优先统一扫描 haystack：

```text
当前 synopsis
用户 instruction
Recent Bridge candidate
Episodic relevant text
Story active terms
```

若仍需安全深度，作为内部 policy，不作为用户手调上下文参数。

---

# 11. P0-7：Batch 冻结 V3 Policy/hash

风险：

```text
Batch 创建时 P1
CH1 freeze P1
用户改 live policy = P2
CH2 freeze P2
```

同一 Batch 漂移。

修复：Batch header 或已有 JSON snapshot 冻结：

```text
contextBudgetVersion
contextAutomationPolicyVersion
contextAutomationPolicyHash
contextAutomationPolicySnapshot
```

所有 child 继承同一 Policy。

Resume / Replan 不重新读取 live Policy。

优先复用现有 JSON 字段；只有无合适字段时才 Schema bump，并补 migration/data-preservation tests。

---

# 12. Context Automation Settings 页面收束

## 12.1 新任务只暴露 V3

隐藏“V2 固定比例”新用户切换。

V2 runtime 只保留历史任务兼容。

## 12.2 不再把一个“全局上下文大小”当模型真实能力

真实能力来自：

```text
LLMConfig.context_window
LLMConfig.max_output_tokens
```

Settings 应展示当前模型真实能力和 V3 Policy。

## 12.3 如果保留数字输入

只能作为：

```text
预算模拟窗口（仅预览，不修改模型能力）
```

## 12.4 清理错误文案

扫描并修正：

```text
“将覆盖所有 LLM context_window”
“将覆盖所有 Preset max_tokens”
“填一个数字自动分配所有 token”
```

V3 文案必须与真实写入行为一致。

---

# 13. Context Preview 成为唯一章节上下文入口

Board Summary 显示：

```text
Model Window
Soft / Burst / Hard
Output Reservation
Mandatory

Story State      Demand / Soft / Allocated / Borrowed
Recent Bridge    Demand / Soft / Allocated / Borrowed
Resources        Demand / Soft / Allocated / Borrowed
Episodic         Demand / Soft / Allocated / Borrowed
```

Story Coverage 显示：

```text
长期检查点截至第 X 章
Recent Raw：第 A~B 章
Episodic Fallback：第 C/D 章
Immediate Seam：第 B 章结尾
未覆盖：0
```

Resource Item 继续显示：

```text
actual demand
allocated
borrowed
full/clipped
activation reason
```

Preview 与真实 Draft 必须 same Model / Policy / Coverage / Board / Item / rendered bytes。

---

# 14. Review / FactCheck / Brief / Proof 再审计

## Review / FactCheck

继续使用 shared Elastic Stage Compiler，不新增绝对 module cap。

## Brief

保持 compact semantic contract，不改成大上下文重新审阅。

只验 output reservation 和 final-window safety。

## Generic Proof

继续 shared elastic。

结构化当前流水线重点修 Final Reviser V3 静态 module cap。

---

# 15. Tail Clip / Token Utilization P1

当前 Resource Tail Clip 已能保证：

```text
renderedTokens <= grant
```

但必须检查 ASCII / 英文连续 run 是否因为逐字符估算而严重欠填 grant。

建议 estimator-parity tail clip：

```text
Binary Search suffix boundary
→ estimateTokens(text.slice(mid))
```

或同等方法。

测试：

```text
中文
英文
ASCII run
中英混排
emoji
标点
CRLF
```

除安全上限外，还要验证预算利用率合理。

---

# 16. Continuation V4 条件审计

Continuation V4 已使用：

```text
Frozen Stage Model
model-relative ratios
dynamic output demand
category share curves
```

本轮先验证，不默认重构。

重点证明：

```text
某 Category actual demand = 0
```

其额度是否会回收给其它有需求 Category。

如果当前已回收，只加测试和报告。

如果没有，使用共享 demand core 做最小 reclaim/redistribute，保留 Canon / Locked Rules hard semantics 和 Primary Anchor 高优先。

Legacy compatibility 中存在的 fallback window 可以保留，但必须证明当前 V4 正式 run 只使用真实 Frozen Model capability。

---

# 17. 自动预算不得增加 LLM 调用

以下必须 0 LLM：

```text
Context Planning
Coverage Planning
Board Allocation
Item Allocation
Policy Freeze
Preview
Derived Final metadata loading
```

改造前后相同业务流水线不得因预算系统新增模型请求。

---

# 18. Frozen Snapshot / Resume

首次 Freeze：

```text
Frozen Model
Frozen Policy
Frozen Context
Frozen Draft Request
```

Resume：

```text
不重新读取 live policy
不重新读取 live ContextConfig
不重新查资料重新分配
```

Review / FactCheck / Brief / Final 只消费 frozen source view。

可以针对 Stage 自己的窗口做 stage-local elastic allocation，但不能重新查 DB 换资料。

---

# 19. 推荐实施顺序

1. **Derived Final CursorWindow Crash P0**
2. **Sliding / Story Coverage P0**
3. **V6 完全绕开 Legacy manual Context budget**
4. **Snapshot 去重上一章全文**
5. **Final Reviser 静态 cap 清除**
6. **Batch Policy Freeze**
7. **Task/Checkpoint 高 Payload narrow read**
8. **UI：删除章节手动 Context Config、简化 Settings Auto**
9. **Tail clip utilization**
10. **Continuation reclaim 条件修复**
11. **全测 + Android**
12. **全部 Gate 后再升版**

建议拆成多个可定位 commit，不要压成一个超大提交。

---

# 20. 自动化测试矩阵

### T01 Legacy Poison
V6 不受极端 Legacy 配置影响。

### T02 32K / 64K / 128K / 1M
Model Window 增长 → Board grant 单调不减、clipping 不反向增加。

### T03 Sliding Natural Demand
最近 10 章总 20K、旧 sliding=4K，1M 下 V6 demand 仍为真实需求。

### T04 Recent Bridge Grant
`estimateTokens(renderedRecentBridge) <= slidingGrant`。

### T05 Empty Board Reclaim
Story/Episodic 空，Resources/Sliding 能借调。

### T06 Resource Large Item
单大 Character 30K，空间足够可完整进入。

### T07 Final Large Character
Final Character 20K，不再被 6K cap。

### T08 Final Model Scaling
32K/128K/1M Final grant 动态增长。

### T09 Derived Final CursorWindow
巨大 parent row 且 `SELECT *` 主动抛 CursorWindow，Derived 仍成功。

### T10 Derived Final Call Count
Draft/Review/FactCheck/Brief 不增，Final +1。

### T11 Derived Final Version 6
类型与 runtime 都保留 6。

### T12 Task Summary Narrow Read
巨大 task row 下 Task list / unresolved restore 正常。

### T13 Checkpoint Narrow Read
巨大 output_text 下 resume / derived 安全。

### T14 Batch Policy Freeze
live Policy 改变后所有 child hash 仍等于 parent frozen hash。

### T15 Resume Policy Freeze
单任务 resume 仍旧 frozen policy。

### T16 Preview = Draft
Context bytes / allocation trace 一致。

### T17 Snapshot Size
V6 不额外保存未预算上一章全文。

### T18 Review Elastic
不越窗口，高价值模块优先。

### T19 FactCheck Elastic
同上。

### T20 Brief
保持 compact semantic contract。

### T21 Final Hard Guard
`input + output + safety <= window`。

### T22 Tail Clip Property
至少 10,000 随机 case。

### T23 Continuation Empty Category
证明 reclaim；缺失则修后 PASS。

### T24 No Extra LLM
预算/Preview 不增加请求。

### T25 Determinism
同输入同 Policy Hash / Allocation / Prompt Bytes。

---

# 21. Android 验收

使用当前开发机真实在线 emulator：

```bash
adb devices -l
adb -s <serial> install -r <debug-apk>
```

禁止：

```text
adb uninstall
pm clear
删除数据库
```

### M1 UI 收束
章节页无“上下文配置”，保留“上下文预览”。

### M2 两个大资料
复现旧 2~3K 裁剪场景；1M 空间足够时两份均 full。

### M3 Poison Legacy
设备旧配置改到极小，V6 Preview/Send 仍自动正确。

### M4 Cross-board Borrow
真实 `allocated > softTarget`、`borrowed > 0`。

### M5 32K → 1M
先小窗口合理裁剪，只切模型到 1M，无需重新 Apply，自动扩张。

### M6 Derived Final CursorWindow
大 Frozen Context 任务 → 仅重写终稿 → 无 CursorWindow → 只新增 Final API → completed。

### M7 Full Pipeline
Draft → Review → FactCheck → Brief → Final 全成功。

### M8 Resume
Home/App switch/可控中断，已成功 Stage 不重复，Policy/Context 不漂移。

### M9 Batch
至少 2 章，parent/child version=6 且 policyHash 全一致。

### M10 大 Task 冷启动
保留巨大历史 task，App 重启恢复列表/状态不爆 CursorWindow。

---

# 22. 性能 Gate

至少测试：

```text
10
50
100
500
```

资源规模。

要求：

- 无 N+1 DB；
- 同一文本尽量只 estimate 一次；
- Chunk reader 有上限；
- Preview 不卡死；
- Task list 不加载大 Blob；
- Derived Final 不复制无意义大字段。

---

# 23. 数据安全

覆盖安装前后记录：

```text
project count
chapter count
character count
note count
worldbook count
pipeline task count
story memory row count
attempt row count
```

必须保留：

```text
API Key
项目
章节
资源
Story Memory
Pipeline
Usage
Attempt Ledger
```

---

# 24. 禁止“伪修复”

以下均 NO-GO：

```text
把 slidingWindowSize 4000 改成 20000
把 Final 6K cap 改成 20K
只隐藏 ContextConfig UI，但 V6 后端仍读旧值
只 catch CursorWindow 并提示用户
Derived Final 改成重跑整条流水线
通过清 DB 解决 CursorWindow
1M 仍需手工点“应用1M预算”
删除 Legacy 字段导致旧任务无法 Resume
预算计算新增 LLM
```

---

# 25. 修改边界

允许：

```text
Context Builder
Story Coverage Planner
Hierarchical Allocator integration
Final Reviser elastic modules
Derived Final Repository / Task creation
Pipeline Task / Checkpoint projections
Batch policy freeze
Context Preview
Context Automation UI
Chapter Context entry
Token clipping helper
相关 tests/docs
```

原则上禁止：

```text
Story Memory Protocol V2 Observation/Compiler/Merger
Story Memory physical attempt protocol
Canon semantic contract
Continuation Writer/Checker/Control/Repair 业务协议
Audit semantic contract
Brief semantic contract
LLM provider transport
自动 retry 次数
```

Continuation 只有确认 Category Borrow 缺失时才做最小预算修复。

---

# 26. 版本策略

先修复、先测试、先 Android。

全部 Gate 通过后才能：

```text
升版本
更新 CHANGELOG
构建 Release APK
```

版本号以实施时本地仓实际版本为准。

---

# 27. 最终 Verification 文档

完成后生成：

```text
docs/optimization/
Context-Budget-V3-Unified-Automation-Final-Closure-Verification-YYYYMMDD.md
```

至少包含：

1. local initial HEAD；
2. origin/main initial HEAD；
3. final HEAD；
4. changed files；
5. Legacy ContextConfig 扫描；
6. static token caps 扫描；
7. high-payload SELECT 扫描；
8. Story Coverage root cause/fix；
9. Final fixed-cap root cause/fix；
10. Derived Final CursorWindow root cause/fix；
11. Batch Policy Freeze；
12. Context UI 删除证据；
13. Context Auto UI 收束；
14. 32K/64K/128K/1M；
15. Preview=Send；
16. Derived Final call count；
17. no extra LLM；
18. full verify；
19. Android M1~M10；
20. data preservation；
21. known non-blocking items；
22. final GO/NO-GO。

---

# 28. 最终验收标准

> **任一 Mandatory Gate 未通过，不得宣称完成。**

## Gate 01 — Repo Preflight
- [ ] 自动定位 repo root；
- [ ] `git status`；
- [ ] fetch；
- [ ] 记录 local/origin HEAD；
- [ ] 未覆盖本地未提交修改。

## Gate 02 — Full Scan
- [ ] Legacy ContextConfig；
- [ ] Static token cap；
- [ ] High-payload SELECT；
- [ ] Batch Policy Freeze；
- [ ] Continuation category budget。

## Gate 03 — Manual Context UI
- [ ] 新章节无手动“上下文配置”；
- [ ] 不暴露 sliding/full/custom；
- [ ] 不暴露固定前文/资料/记忆 token；
- [ ] Context Preview 保留。

## Gate 04 — Legacy Compatibility
- [ ] Legacy Settings key 保留；
- [ ] V1~V5 旧任务未迁移；
- [ ] 旧 Resume 不回归。

## Gate 05 — V6 Ignores Legacy Budget
- [ ] strategy 不参与 V6；
- [ ] slidingWindowSize 不参与 V6 actual demand；
- [ ] resourceBudget 不参与 V6 hard cap；
- [ ] Story/Episodic legacy budget 不参与 V6 demand；
- [ ] Poison test PASS。

## Gate 06 — Story Coverage
- [ ] Candidate Planner 不依赖 static sliding budget；
- [ ] raw ≤10；
- [ ] Seam 保护；
- [ ] Episodic fallback 正常；
- [ ] 无旧 4K 虚假 Hard Gap。

## Gate 07 — Recent Bridge Grant
- [ ] `renderedRecentBridgeTokens <= slidingGrant`；
- [ ] Trace 与真实文本一致；
- [ ] Preview=Send。

## Gate 08 — Snapshot Dedup
- [ ] V6 不额外冻结无预算上一章全文；
- [ ] Seam metadata 保留；
- [ ] Final 连续性不回归。

## Gate 09 — Story State Demand
- [ ] actual demand；
- [ ] empty=0；
- [ ] 可释放预算。

## Gate 10 — Resources Demand
- [ ] candidate-first；
- [ ] 无35/20/45；
- [ ] 无 resource-count 等分；
- [ ] 大资源空间够可 full。

## Gate 11 — Episodic Demand
- [ ] actual retrieval demand；
- [ ] empty=0；
- [ ] 可释放。

## Gate 12 — Cross-board Borrow
- [ ] 空闲预算可回收；
- [ ] 有真实 `allocated > softTarget`；
- [ ] Ceiling/Burst/Hard 有效。

## Gate 13 — Final Static Caps
- [ ] Final 不再有业务绝对 12K/8K/6K/4K/5K hard cap；
- [ ] module max 来自 actual/model-relative；
- [ ] 32K→1M 可扩张。

## Gate 14 — Final Mandatory Boundary
- [ ] Brief；
- [ ] Canonical Draft；
- [ ] Full Outline；
- [ ] Revision Instruction；
- [ ] Immediate Ending；
- [ ] 全部不越窗口。

## Gate 15 — Review/FactCheck/Proof
- [ ] shared elastic 保持；
- [ ] 无新增 absolute cap；
- [ ] regressions PASS。

## Gate 16 — Brief
- [ ] compact semantic path 保持；
- [ ] 未改成大上下文重审；
- [ ] output reservation safe。

## Gate 17 — Derived Final Narrow Read
- [ ] 不 `SELECT *` 父 task；
- [ ] 大字段单列/chunk；
- [ ] 无 CursorWindow。

## Gate 18 — Derived Checkpoint Read
- [ ] 不整行加载多个巨大 output_text；
- [ ] 专用 reader 安全。

## Gate 19 — Derived Call Count
- [ ] Draft +0；
- [ ] Review +0；
- [ ] FactCheck +0；
- [ ] Brief +0；
- [ ] Final +1。

## Gate 20 — Derived Frozen Semantics
- [ ] Parent Frozen Model；
- [ ] Parent Frozen Policy；
- [ ] Parent Brief/facts/outline；
- [ ] 新 instruction 不覆盖 hard facts。

## Gate 21 — High Payload Repository
- [ ] Task list 安全；
- [ ] unresolved restore 安全；
- [ ] adoption 回归 PASS；
- [ ] resume 安全。

## Gate 22 — Batch Policy Freeze
- [ ] parent version=6；
- [ ] child version=6；
- [ ] parent policyHash frozen；
- [ ] 所有 child hash 相同；
- [ ] live policy 修改不影响后续 child。

## Gate 23 — Single Resume
- [ ] live policy 修改后仍 frozen；
- [ ] 成功 Stage 不重复；
- [ ] Context 不漂移。

## Gate 24 — Context Automation Settings
- [ ] 新用户不暴露 V2 fixed ratio；
- [ ] 不用全局数字伪装模型真实 window；
- [ ] V3 文案与实际写入一致；
- [ ] 模拟字段若保留明确只模拟。

## Gate 25 — Resources / Worldbook
- [ ] V6 不由 Legacy includeResources 关闭整个 Board；
- [ ] recursion 归类 retrieval feature；
- [ ] scan 不由旧 Context 页控制；
- [ ] Episodic-triggered Worldbook 不回归。

## Gate 26 — Tail Clip
- [ ] `rendered <= grant`；
- [ ] ASCII/CJK/mixed 利用率合理；
- [ ] 10k property PASS。

## Gate 27 — Continuation
- [ ] V4 使用 frozen real model；
- [ ] 空 category reclaim 已证明；
- [ ] 如缺失已最小修复；
- [ ] Canon/Anchor hard semantics 不破坏。

## Gate 28 — 32K/64K/128K/1M
- [ ] 32K；
- [ ] 64K；
- [ ] 128K；
- [ ] 1M；
- [ ] clipping 不反向增加。

## Gate 29 — Preview=Send
- [ ] same model；
- [ ] same policy；
- [ ] same coverage；
- [ ] same board；
- [ ] same item；
- [ ] same bytes。

## Gate 30 — Determinism
- [ ] 同 allocation；
- [ ] 同 prompt bytes；
- [ ] stable policyHash；
- [ ] 无随机/时间戳污染 prompt。

## Gate 31 — No Extra LLM
- [ ] Preview 0；
- [ ] Allocation 0；
- [ ] Coverage 0；
- [ ] Derived metadata 0；
- [ ] 业务请求无预算额外增量。

## Gate 32 — Full Verify
- [ ] targeted；
- [ ] property；
- [ ] typecheck；
- [ ] lint 无新增 error；
- [ ] full `npm run verify`。

## Gate 33 — Android UI
- [ ] 手动 Context Config 消失；
- [ ] Preview 正常；
- [ ] Board/Item 可读。

## Gate 34 — Android Big Resources
- [ ] 两个大 Character；
- [ ] 大模型空间够均 full；
- [ ] 不再固定2~3K。

## Gate 35 — Android Poison Legacy
- [ ] 旧配置极端小；
- [ ] V6 仍自动规划。

## Gate 36 — Android Borrow
- [ ] 真实 `borrowed > 0`。

## Gate 37 — Android Model Switch
- [ ] 小窗口合理裁剪；
- [ ] 只切1M模型；
- [ ] 不重新 Apply；
- [ ] 自动扩张。

## Gate 38 — Android Derived Final
- [ ] 实际“仅重写终稿”；
- [ ] 大 parent 无 CursorWindow；
- [ ] 只新增 Final；
- [ ] completed。

## Gate 39 — Android Full Pipeline/Resume
- [ ] Draft→Review→FactCheck→Brief→Final；
- [ ] Resume；
- [ ] 成功 Stage 不重复。

## Gate 40 — Android Batch
- [ ] ≥2章；
- [ ] parent/child version 一致；
- [ ] policyHash 一致；
- [ ] Batch Resume。

## Gate 41 — Data Preservation
- [ ] `adb install -r`；
- [ ] 无 uninstall；
- [ ] 无 pm clear；
- [ ] API Key；
- [ ] Projects/Chapters/Resources；
- [ ] Story Memory；
- [ ] Attempts/Usage 保留。

## Gate 42 — Final Report
- [ ] Verification MD；
- [ ] 每 Gate 有证据；
- [ ] Missing Gate = NO-GO；
- [ ] 全部 Mandatory PASS 才 GO。

---

# 29. NO-GO 条件

任一发生即 NO-GO：

```text
V6 仍读手动 strategy 决定前文
V6 仍由 slidingWindowSize 先裁 Coverage
Recent Bridge 实际 > board grant
V6 Snapshot 仍额外冻结无预算上一章全文
Final V3 仍有固定 6K/8K/12K module hard cap
Derived Final 仍 SELECT * 大 task row
Derived Final 重跑 Draft/Review/FactCheck/Brief
Batch child policy 可漂移
Task list/Resume 仍可能 CursorWindow
1M 仍需手工 Apply 才扩大
ContextConfig 只隐藏但后端仍生效
任一模型可能超窗口
Preview != Send
预算系统新增 LLM
full verify fail
Android Derived Final 未实跑
Android Model Switch 未实跑
Android Batch Policy Freeze 未实跑
需要 uninstall / pm clear 才通过
```

---

# 30. GO 定义

只有以下全部成立才 GO：

```text
Manual Context Config 退出新用户路径
Story Coverage 自动化
Board Actual Demand 完整
Cross-board Borrow 完整
Final 无静态 module cap
Derived Final CursorWindow 关闭
Batch Policy Freeze
High Payload Repository 安全
Preview = Send
32K~1M
Full Verify
Android 全链路
Data Preservation
```

> **GO：Context Budget V3 全链路自动弹性上下文完成最终封板。**

---

# 31. Agent 开工提示词

```text
以当前开发机本地 Git 仓实际代码为唯一实施真相，不要假设任何目录。先使用 `git rev-parse --show-toplevel` 定位 repo root，执行 git status、git fetch --all --prune、记录 local HEAD/origin/main，并保护全部未提交修改。完整阅读本方案后，先按“开工前全链路扫描”对 ContextConfig、固定 token/maxTokens、pipeline_tasks/pipeline_stage_checkpoints 大字段查询、Story Coverage、Batch Policy Freeze、Final Reviser、Continuation 做真实调用链审计，先补失败测试再修改。

本轮不是继续调大固定 token，而是把 Context Budget V3 真正收束为单一自动系统：新 contextBudgetVersion=6 不再读取 strategy/slidingWindowSize/resourceBudget/story/episodic legacy 值决定预算；Story Coverage 先生成预算无关 Candidates，再由 V3 Board grant 决定 Recent Raw/Episodic fallback，最多10章 raw 的产品 Hard Guard保留；最终 Recent Bridge 必须 estimateTokens(rendered)<=sliding grant。V6 Snapshot 不得再额外塞一份未预算的上一章全文，只保必要 Seam 和经预算授权的近期文本。

优先修复 Derived Final Rewrite 的 CursorWindow：禁止通过 SELECT * 读取含 pipeline_context_json/final_text 的大 task row，Checkpoint 大 output_text 同样使用专用窄查询/chunk read；“仅重写终稿”必须复用父任务 Frozen Model/Policy/Draft/Review/FactCheck/Brief，仅新增一次 Final API，禁止重跑上游阶段。随后移除 Final Reviser V3 中 12K/8K/6K/4K/5K 等静态 module hard cap，改为 actual demand + model-relative stage elastic allocation。

产品层删除章节里的手动“上下文配置”入口，只保留只读“上下文预览”；不再暴露滑动窗口/完整前文/自定义或固定前文/资料/记忆 token。Legacy ContextConfig/Settings 字段先保留供旧任务兼容，但 V6 必须通过 Poison Legacy test 证明完全不受这些旧值影响。Settings 的上下文自动化页面同步收束为 V3 模型感知模式，不再把一个全局数字当成所有模型真实窗口；V2 仅保留历史运行兼容，不再作为新任务用户选项。

同时补齐 Batch V3 Policy/hash 整批冻结，审计所有 pipeline_tasks / pipeline_stage_checkpoints 的高 Payload SELECT *；Tail clip 做 estimator-parity 利用率验证；Continuation V4 先验证空分类预算是否真实回收，只有确认缺失时才做最小 reclaim/borrow 接驳，不改 Canon/Primary Anchor 业务语义。

完成后必须逐项执行方案尾部 42 项 Gate：targeted/property/typecheck/lint/full npm run verify，并在当前在线 Android 模拟器使用 adb install -r 覆盖安装，禁止 uninstall/pm clear，实跑手动 Context UI 消失、两个大资料、Poison Legacy、Cross-board Borrow、32K→1M 模型切换、Derived Final 大行 CursorWindow、完整 Pipeline/Resume、≥2章 Batch Policy Freeze、大历史 Task 冷启动和数据保留。任何 Mandatory Gate 未通过都只能判 NO-GO，不得用“主体完成”“Conditional GO”收尾。最后生成 Context-Budget-V3-Unified-Automation-Final-Closure-Verification-YYYYMMDD.md，逐 Gate 给出证据和最终 GO/NO-GO。
```
