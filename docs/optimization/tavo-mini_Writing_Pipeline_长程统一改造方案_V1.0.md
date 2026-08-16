# tavo-mini Writing Pipeline 长程统一改造方案
## —— Phase I 写作资料接口统一 + Phase II Writing Kernel 重塑

**项目**：`anjingdtl/tavo-mini`  
**工程性质**：写作主链架构重构 / 长程治理工程  
**目标版本**：以实施时本地仓最新代码为唯一改造基线  
**文档版本**：V1.0  
**编制日期**：2026-08-16  

---

# 1. 工程背景

`tavo-mini` 当前已经完成一轮稳定性治理，并在 Candidate、Budget、Render、Freeze、Trace、Replay、Golden Journey 等方向建立了较完整的治理基础。

但现状仍存在两个根本问题：

1. **大纲创作与原著续写仍然保留两套生产级写作路径。**
2. **上下文构建与写作执行职责没有真正完成结构级收束。**

现有代码虽然已经出现：

- Collect
- Normalize
- Plan
- Allocate
- Render
- Freeze

等阶段模块，但生产链路仍有部分上下文决策、预算编排、资源渲染、Prompt 组装、Continuation 专用逻辑残留在旧 Builder / Runner 中。

尤其原著续写仍然存在独立的：

- `continuationContextBuilder`
- `continuationContextBudget`
- `continuationPromptCompiler`
- `continuationGenerationRunner`

等生产级核心。

这意味着当前状态本质上仍然是：

```text
Outline Writing Pipeline
+
Continuation Writing Pipeline
+
部分共享 Stability Infrastructure
```

而本次长程改造的最终目标是：

```text
Outline Scenario ─────┐
                      ├─> Unified Writing Input ─> Writing Kernel
Continuation Scenario ┘
```

也就是说：

> **整个项目只保留一条生产级 Writing Pipeline。**

“大纲创作”和“原著续写”只作为 Writing Kernel 之前的资料输入场景，而不再拥有各自独立的写作流水线。

---

# 2. 最终架构原则

本次工程必须遵守以下原则。

---

## 2.1 单一生产级 Writing Kernel

最终生产代码中只允许存在一个真正负责正文生成的 Kernel。

禁止继续形成：

```text
Outline Runner
Continuation Runner
```

这种双核心结构。

目标必须收束为：

```text
WritingScenarioAdapter
        ↓
Unified Writing Input
        ↓
Writing Kernel
```

---

## 2.2 场景差异必须在进入 Writing Kernel 前消化

大纲模式与原著续写模式的差异，只允许存在于资料采集和输入适配阶段。

允许：

```text
OutlineSourceAdapter
ContinuationSourceAdapter
```

不允许在 Writing Kernel 深层逻辑中大量出现：

```ts
if (scenario === 'outline') { ... }

if (scenario === 'continuation') { ... }
```

Kernel 应理解的是：

```text
outline
canon
story_memory
writer_style
chapter
worldbook
note
instruction
```

等“资料语义”，而不是“产品模式”。

---

## 2.3 Data Compatibility = YES

必须继续兼容和保留：

- 项目
- 已保存正文
- 原著源资料
- 大纲
- 角色
- 世界书
- 笔记
- Writer Style
- Story Memory
- Episodic Memory
- 用户设置
- 模型配置
- 已完成章节
- 已持久化业务数据

任何重构不得以清空、破坏或强制迁移用户内容为代价。

---

## 2.4 Execution Compatibility = NO

本次改造明确：

> **不兼容旧 Writing Pipeline 的未完成执行状态。**

包括但不限于：

- 旧 Pipeline Stage
- 旧 Resume Checkpoint
- 旧 Frozen Runtime State
- 旧 Pending Review State
- 旧 Continuation Runtime State
- 旧中间产物链路
- 旧执行期 Context Snapshot
- 旧 Runner 内部状态

新版本发现旧未完成任务时：

```text
读取用户项目与章节
        ↓
恢复必要用户输入
        ↓
废弃旧 Runtime State
        ↓
重新创建 WritingRequest
        ↓
重新 Collect
        ↓
重新 Freeze
        ↓
从新 Writing Kernel 开始
```

禁止投入工程量编写：

```text
Old Pipeline State → New Pipeline State
```

的复杂运行态迁移器。

---

## 2.5 新旧执行状态必须严格隔离

旧任务重新进入新 Kernel 时必须创建：

- 新 `generationTraceId`
- 新 `writingRunId`
- 新 `generationFingerprint`
- 新 `FrozenWritingContext`

允许仅保留：

```text
restartedFromLegacyTaskId
```

用于追踪来源。

不得复用旧运行态的 Trace / Frozen Snapshot / Resume Token。

---

## 2.6 两阶段独立实施

整个工程拆为：

### Phase I

**Writing Input / Source Interface Unification**

只解决：

> Writing Kernel 之前，“写什么、参考什么”。

---

### Phase II

**Writing Kernel Reconstruction**

只解决：

> 输入资料冻结之后，“正文到底如何生成”。

---

## 2.7 每个 Phase 必须独立完成 PDCA

每个阶段完成编码后不得直接进入下一阶段。

必须完整执行：

```text
Plan
↓
Do
↓
Check
↓
Act
```

只有 PDCA 闭环后，才能进行该阶段最终 Commit。

---

## 2.8 两个阶段必须独立 Commit

禁止把两个阶段混入同一个最终 Commit。

建议最终形成：

```text
Commit A
refactor(writing): unify pre-kernel writing source interfaces
```

以及：

```text
Commit B
refactor(writing): rebuild unified production writing kernel
```

若开发过程中产生 WIP Commit，阶段结束前应整理，使最终历史至少能清楚看到两个独立里程碑 Commit。

不得：

- Phase I 与 Phase II 交叉提交
- Phase II 顺手修改 Phase I 尚未验收的内容
- 一个 Commit 同时删除 Source Adapter 和重写 Kernel
- 为了“顺手优化”扩大修复边界

---

# 3. 总体目标架构

最终架构：

```text
┌──────────────────────────────┐
│        Product Layer         │
│                              │
│  大纲创作      原著续写      │
└───────┬───────────┬──────────┘
        │           │
        ▼           ▼
┌────────────┐ ┌──────────────────┐
│ Outline    │ │ Continuation     │
│ Adapter    │ │ Adapter          │
└─────┬──────┘ └─────────┬────────┘
      │                  │
      └────────┬─────────┘
               ▼
┌──────────────────────────────┐
│ Unified Writing Source Model │
│                              │
│ WritingRequest               │
│ WritingSourceBundle          │
│ WritingInstruction           │
│ WritingPolicySnapshot        │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│       Writing Kernel         │
│                              │
│ Collect                      │
│ Normalize                    │
│ Plan                         │
│ Allocate                     │
│ Render                       │
│ Freeze                       │
│ ───────────────────────────  │
│ Draft                        │
│ Review                       │
│ Audit / FactCheck            │
│ Revision                     │
│ Proof                        │
│ Final Validate               │
│ Persist                      │
│ Post Writing Update          │
└──────────────────────────────┘
```

---

# 4. 核心领域模型

## 4.1 WritingScenario

场景只服务于 Kernel 之前的资料适配。

```ts
export type WritingScenario =
  | 'outline'
  | 'continuation';
```

---

## 4.2 WritingRequest

```ts
export interface WritingRequest {
  writingRunId: string;

  projectId: number;
  chapterId: number;

  scenario: WritingScenario;

  instruction: WritingInstruction;

  sourceBundle: WritingSourceBundle;

  model: FrozenModelConfig;

  policy: WritingPolicySnapshot;

  legacyRestart?: {
    restartedFromLegacyTaskId: string;
  };
}
```

---

## 4.3 WritingSource

建议统一定义：

```ts
export type WritingSourceKind =
  | 'outline'
  | 'canon'
  | 'source_boundary'
  | 'seam'
  | 'primary_anchor'
  | 'chapter'
  | 'character'
  | 'worldbook'
  | 'note'
  | 'story_memory'
  | 'episodic_memory'
  | 'writer_style'
  | 'preset'
  | 'instruction'
  | 'other';
```

统一资料：

```ts
export interface WritingSource {
  candidateId: string;

  kind: WritingSourceKind;

  sourceId: string | number | null;

  revision: string | null;

  contentHash: string;

  content: string;

  requirement:
    | 'mandatory'
    | 'preferred'
    | 'optional';

  activation:
    | 'explicit'
    | 'automatic'
    | 'system';

  metadata?: Record<string, unknown>;
}
```

---

## 4.4 WritingSourceBundle

```ts
export interface WritingSourceBundle {
  mandatory: WritingSource[];
  preferred: WritingSource[];
  optional: WritingSource[];
}
```

---

# 5. Phase I：Writing Source Interface Unification

# 5.1 Phase I 核心目标

Phase I 只做一件事：

> **彻底统一进入 Writing Kernel 之前的大纲模式 / 原著续写模式资料接口。**

Phase I 完成后：

```text
Outline Mode
       ↓
OutlineSourceAdapter
       ↓
WritingSourceBundle
```

与：

```text
Continuation Mode
       ↓
ContinuationSourceAdapter
       ↓
WritingSourceBundle
```

必须输出相同的数据结构。

Writing Kernel 不再直接访问：

- Outline 专用数据库结构
- Continuation 专用数据库结构
- 原著专用 Context Builder
- 大纲专用 Context Builder

Kernel 只消费统一 Writing Source Contract。

---

# 5.2 Phase I 非目标

Phase I 明确不做：

- 不重写 Draft
- 不重写 Review
- 不重写 Finalize
- 不改模型调用策略
- 不大规模优化 Story Memory 算法
- 不重写正文质量控制
- 不重写 Length Control
- 不改 Writer / Reviewer 角色定义
- 不删除全部 Continuation Runtime
- 不提前重构整个 Generation Runner

这些工作属于 Phase II。

---

# 5.3 Outline Source Adapter

新增：

```text
src/services/writing/scenario/
    outlineWritingAdapter.ts
```

负责将大纲创作所需资料转换为统一 WritingSource。

建议至少包括：

### Mandatory

- Writing Instruction
- Current Outline / Chapter Outline
- 当前章节定义
- Preset
- 必需 Writer Style 约束

### Preferred

- Story Memory
- Relevant Characters
- Worldbook
- Recent Chapters
- Episodic Memory

### Optional

- Note
- Extra Reference
- Auxiliary Metadata

输出：

```ts
WritingSourceBundle
```

---

# 5.4 Continuation Source Adapter

新增：

```text
src/services/writing/scenario/
    continuationWritingAdapter.ts
```

负责吸收当前 continuation 领域中的资料准备能力。

必须重点抽离：

- Canon
- Source Boundary
- Primary Anchor
- Seam
- Continuation Source Chapter
- Original Work Chapter Index
- 原著来源定位
- 必要 Continuation Control Metadata

建议：

### Mandatory

- Writing Instruction
- Canon
- Source Boundary
- Primary Anchor / Seam
- Writer Style / Preset

### Preferred

- Story Memory
- Character
- Worldbook
- Recent Generated Chapters
- Episodic Memory

### Optional

- Note
- Additional Canon
- Auxiliary Reference

最终仍输出：

```ts
WritingSourceBundle
```

---

# 5.5 Continuation 领域拆分原则

当前 continuation 模块中的能力需要分成两类。

---

## A. 保留为 Domain Capability

保留：

```text
canon parsing
source parsing
source navigation
source boundary
anchor
seam
original chapter resolver
continuation source locator
import / normalize utilities
```

这些属于：

> “原著资料是什么”。

---

## B. 不再作为 Continuation 私有 Writing Core

以下能力必须在 Phase II 前标记为待淘汰：

```text
continuationContextBuilder
continuationContextBudget
continuationPromptCompiler
continuationGenerationRunner
continuationFinalPipeline
```

这些属于：

> “怎么写”。

最终必须进入统一 Writing Kernel。

---

# 5.6 统一 Source Validation

新增：

```text
validateWritingSourceBundle()
```

必须检查：

- mandatory 是否完整
- contentHash 是否稳定
- candidateId 是否唯一
- sourceId 与 revision 是否合理
- 空内容资料是否被错误标记 mandatory
- Continuation Canon 是否存在
- Outline 模式大纲是否存在
- Seam / Boundary 是否满足场景条件
- 无效资料是否进入 Bundle
- 重复资料是否去重

输出标准化错误：

```text
MISSING_MANDATORY_SOURCE
EMPTY_MANDATORY_SOURCE
INVALID_SOURCE_HASH
DUPLICATE_CANDIDATE
INVALID_SOURCE_REVISION
INVALID_SCENARIO_SOURCE
```

---

# 5.7 Source Fingerprint

Phase I 必须建立稳定的资料级指纹。

建议：

```text
WritingSourceFingerprint
```

至少覆盖：

- kind
- sourceId
- revision
- contentHash
- requirement
- activation

并生成：

```text
WritingSourceBundleFingerprint
```

用于：

- Replay
- Golden Diff
- Runtime Trace
- Regression
- Kernel 输入稳定性判断

---

# 5.8 Source Trace

Trace 至少记录：

```text
scenario
sourceAdapter
sourceCandidateCount
mandatoryCount
preferredCount
optionalCount
sourceFingerprint
rejectedSources
missingSources
legacyRestart
```

注意：

`scenario` 可以存在于 Trace。

但进入 Kernel 后：

> scenario 不得作为控制 Kernel 分支的核心条件。

---

# 5.9 旧未完成任务处理

Phase I 必须同时建立统一的 Legacy Restart 入口。

建议：

```text
restartLegacyWritingTask()
```

行为：

```text
检测旧任务
↓
读取 projectId
↓
读取 chapterId
↓
恢复用户 instruction
↓
废弃旧 execution state
↓
生成新 writingRunId
↓
重新调用 Scenario Adapter
↓
创建 WritingRequest
```

不得恢复：

- old freeze
- old context
- old stage
- old review
- old runner checkpoint

---

# 5.10 Phase I 生产边界验收

Phase I 完成后必须满足：

### Gate I-01

Outline 与 Continuation 都能生成相同类型：

```text
WritingRequest
```

---

### Gate I-02

两种模式都统一生成：

```text
WritingSourceBundle
```

---

### Gate I-03

Kernel 输入层不得直接依赖：

```text
continuationContextBuilder
continuationContextBudget
continuationPromptCompiler
```

作为资料获取接口。

---

### Gate I-04

Continuation 专用资料能力必须被抽离为 Domain / Source Adapter 能力。

---

### Gate I-05

Outline 专用资料也不得直接泄漏 UI / DB 原始结构到 Writing Kernel。

---

### Gate I-06

旧未完成任务可以：

```text
Restart Through New Input Layer
```

但不能尝试旧执行状态 Resume。

---

### Gate I-07

Source Fingerprint x10 构建必须稳定。

相同输入：

```text
fingerprint_1
=
fingerprint_2
=
...
=
fingerprint_10
```

---

### Gate I-08

大纲和续写资料都必须具备 Golden Fixtures。

至少：

```text
OUTLINE_BASIC
OUTLINE_WITH_STORY_MEMORY
OUTLINE_WITH_NOTE_NONE
OUTLINE_1M_CONTEXT

CONTINUATION_BASIC
CONTINUATION_WITH_CANON
CONTINUATION_WITH_SEAM
CONTINUATION_WITH_STORY_MEMORY
CONTINUATION_1M_CONTEXT
```

---

# 6. Phase I PDCA

Phase I 编码完成后必须立即进入独立 PDCA。

---

## P — Plan

复核 Phase I 设计目标：

- 是否只改资料接口
- 是否避免提前侵入 Kernel
- 是否已经明确 Source Contract
- 是否明确旧任务 Restart
- 是否明确 Data / Execution Compatibility
- 是否定义 Golden Fixtures

输出：

```text
Phase_I_PDCA_Plan.md
```

---

## D — Do

执行：

- Adapter 实现
- Source Contract
- Source Validation
- Fingerprint
- Trace
- Legacy Restart
- Fixtures
- 单元测试
- Integration Test

---

## C — Check

必须完成以下验证。

### 1. Static

```text
lint
typecheck
test
```

---

### 2. Source Contract Regression

校验：

```text
Outline → WritingSourceBundle
Continuation → WritingSourceBundle
```

结构一致。

---

### 3. Determinism

每个 Golden Fixture：

```text
x10
```

Fingerprint 不漂移。

---

### 4. No Hidden Context Read

Writing Kernel 的入口不得绕过统一 Source Adapter 再读：

- DB
- Canon Repository
- Outline Repository
- Story Memory Repository
- Note Repository

资料读取必须在 Phase I 明确边界内完成。

---

### 5. Legacy Restart

验证旧任务：

```text
Legacy Task
→ New WritingRequest
→ New Trace
→ New Fingerprint
```

不得复用旧 Runtime State。

---

### 6. Real Data Smoke

至少选择：

- 1 个大纲项目
- 1 个原著续写项目

验证 Source Bundle 完整性。

---

## A — Act

根据 Check：

- 修复 Source Contract 漂移
- 修复 Missing Mandatory Source
- 修复重复 Candidate
- 修复不稳定 Fingerprint
- 修复旧任务 Restart 边界
- 补 Golden Fixture

必须做到：

```text
New P0 = 0
New P1 = 0
Phase I NO-GO = 0
```

才能 Commit。

---

# 7. Phase I Commit

Phase I 完成 PDCA 后，独立 Commit：

```text
refactor(writing): unify pre-kernel writing source interfaces
```

该 Commit 只能包含：

- Writing Scenario Adapter
- Writing Source Contract
- Writing Source Validation
- Source Fingerprint
- Legacy Restart Input Layer
- Phase I Tests
- Phase I Docs

不得混入 Writing Kernel 重塑。

建议 Tag：

```text
writing-unification-phase1
```

---

# 8. Phase II：Writing Kernel Reconstruction

# 8.1 Phase II 启动前置条件

只有 Phase I：

```text
PDCA = PASS
Commit = DONE
```

才允许开始 Phase II。

---

# 8.2 Phase II 核心目标

Phase II 的目标：

> **建立唯一 Production Writing Kernel。**

最终删除 Outline / Continuation 双写作核心。

生产执行链统一为：

```text
WritingRequest
      ↓
Collect
      ↓
Normalize
      ↓
Plan
      ↓
Allocate
      ↓
Render
      ↓
Freeze
      ↓
Draft
      ↓
Review
      ↓
Audit / FactCheck
      ↓
Revision
      ↓
Proof
      ↓
Final Validate
      ↓
Persist
      ↓
Post Writing Update
```

---

# 8.3 Kernel 目录建议

```text
src/services/writing/

  unifiedWritingPipeline.ts

  scenario/
    outlineWritingAdapter.ts
    continuationWritingAdapter.ts

  contracts/
    writingRequest.ts
    writingSource.ts
    writingContext.ts
    frozenWritingContext.ts

  context/
    collectWritingMaterials.ts
    normalizeWritingMaterials.ts
    buildWritingContextPlan.ts
    allocateWritingContextBudget.ts
    renderWritingContext.ts
    freezeWritingContext.ts

  stages/
    draft.ts
    review.ts
    audit.ts
    factCheck.ts
    revise.ts
    proof.ts
    finalize.ts
    persist.ts

  trace/
    writingTrace.ts
    writingTraceV2.ts

  replay/
    writingReplay.ts

  regression/
    writingGoldenJourney.ts
```

可根据现有目录适度调整，但职责必须等价。

---

# 8.4 Context Builder 真正瘦身

当前历史问题之一，是 Context Builder 虽然调用六阶段模块，但仍承担大量业务决策。

Phase II 必须完成：

> Builder → Thin Orchestrator

最终 Builder / Pipeline 不应自己：

- 查 Story Memory
- 计算 Story Memory Demand
- 重新分配 Budget
- 构建 Resource Text
- Render Candidate
- 拼宏
- 拼桥接上下文
- 手工组 Prompt
- 决定 Candidate Selection
- 决定 Candidate Allocation
- 做二次 Budget Reconcile
- 手工构建 Frozen Contract

而应只负责：

```ts
collect()
normalize()
plan()
allocate()
render()
freeze()
```

顺序编排。

---

# 8.5 Collect

Collect 只负责：

> 收集 Phase I 已经归一化后的 Source / Material。

禁止：

- Budget
- Rank
- Render
- Prompt 拼装

输出：

```text
CollectedWritingMaterials
```

---

# 8.6 Normalize

负责：

- Canonical ID
- 去重
- revision 规范
- hash 规范
- source metadata 统一
- 空内容过滤
- mandatory 检查
- legacy 数据归一化

输出：

```text
NormalizedWritingMaterials
```

---

# 8.7 Plan

Plan 只决定：

> 哪些 Candidate 应该参与本次写作上下文。

输出：

```text
WritingContextPlan
```

包括：

- candidate
- priority
- requirement
- selection reason
- exclusion reason
- demand estimate

不得直接 Render。

---

# 8.8 Allocate

只负责 Token / Context Budget。

输入：

```text
WritingContextPlan
```

输出：

```text
WritingBudgetAllocation
```

必须成为唯一预算决策源。

禁止：

- Builder 二次偷算
- Renderer 自己重分配
- Continuation 专用 Budget
- Outline 专用 Budget

---

# 8.9 Render

只负责：

```text
Candidate + Allocation → Rendered Context
```

不得：

- 重新 Select
- 重新 Rank
- 重新 Allocate
- 重新读 DB

Legacy Render Block 仅可作为过渡实现。

最终 Production 必须走统一 Candidate Renderer。

---

# 8.10 Freeze

Freeze 生成唯一：

```text
FrozenWritingContext
```

Freeze 后：

> 所有写作阶段不得再次读取会改变生成语义的 Live Data。

必须冻结：

- Source
- Candidate
- Allocation
- Rendered Prompt Context
- Writing Instruction
- Writer Style
- Model Config
- Policy Snapshot
- Fingerprint
- Trace Identity

---

# 8.11 Freeze 是架构分水岭

必须建立硬规则：

```text
Before Freeze:
允许资料适配和输入差异

After Freeze:
禁止 Scenario-specific Pipeline
```

即：

```text
Outline
Continuation
```

在 Freeze 后必须完全走同一条 Writer Core。

---

# 8.12 Draft

Draft 只接受：

```text
FrozenWritingContext
```

不再接受：

```text
ContinuationContext
OutlineContext
```

不得再调用旧专用 Prompt Compiler。

---

# 8.13 Review

Review 统一：

- Narrative Review
- Style Review
- Continuity Review
- Factual / Canon Review
- Constraint Review

允许通过：

```text
ReviewStrategy
```

实现不同资料约束。

不允许另起：

```text
ContinuationReviewerPipeline
```

---

# 8.14 Audit / FactCheck

统一处理：

- Canon 冲突
- Outline 冲突
- Character 冲突
- Worldbook 冲突
- Story Memory 冲突
- Style Requirement
- Structural Requirement
- Narrative Consistency

检查器面向“约束类型”，而不是产品模式。

---

# 8.15 Revision

Revision 必须建立：

```text
RevisionObligation[]
```

每个修改要求必须有：

- requirementId
- source
- reason
- severity
- expectedEffect

Revision 输出必须记录：

```text
appliedRequirementIds
unappliedRequirementIds
```

---

# 8.16 解决 Continuation P1：虚假应用问题

当前续写真实设备审计暴露了一个关键风险：

> Pipeline 声称已经应用 Style / Revision Obligations，但最终正文语义上仍然与原 Draft 完全相同。

Phase II 必须把这个问题升级为统一 Kernel 的 Red Regression。

新增 Regression：

```text
REG-WRITING-SEMANTIC-APPLY-001
```

规则：

若：

```text
appliedRequirementIds.length > 0
```

则至少必须满足：

### Case A

Final Body Hash 与 Revision 前正文发生变化。

或：

### Case B

系统明确证明该 Requirement 为：

```text
VALID_NO_OP
```

并记录原因。

否则：

```text
Final Validate = BLOCK
```

不得出现：

```text
declared applied = true
body unchanged
validator passed
```

这种假绿状态。

---

# 8.17 Proof

Proof 统一负责：

- 最终格式
- Markdown / Text 清理
- Protocol Leak
- 截断
- 空白
- 重复段落
- 乱码
- 不完整结尾

---

# 8.18 Final Validate

Final Validate 必须成为真正 Gate。

检查：

- Frozen Contract 一致性
- Requirement Application
- Output Completeness
- No Protocol Leak
- No Silent Context Loss
- No Unexpected Re-read
- Trace Completeness
- Fingerprint Integrity
- Semantic Apply Validity

---

# 8.19 Persist

Persist 统一负责：

- 保存正文
- 写入章节
- 写 Generation Result
- 写 Trace
- 写 Status

禁止：

```text
Continuation Persist
Outline Persist
```

两套写回语义长期并存。

---

# 8.20 Post Writing State Update

统一进入后置状态更新。

包括：

- Story Memory 更新
- Chapter State
- Generation History
- Writing Statistics
- Project State

Story Memory 算法本身本轮不强制重写。

重点是：

> 更新入口统一。

---

# 9. Production Legacy Core 淘汰计划

Phase II 过程中应建立 Legacy Inventory。

重点对象：

```text
continuationContextBuilder
continuationContextBudget
continuationPromptCompiler
continuationGenerationRunner
```

以及旧 Outline Writer Core。

按顺序：

```text
Shadow
↓
Redirect
↓
No Production Caller
↓
Mark Legacy
↓
Delete / Archive
```

严禁一开始直接删除。

---

# 10. Shadow 模式

正式切换前建议：

```text
Legacy Pipeline
New Writing Kernel
```

在测试环境进行 Shadow。

同一个 fixture 生成：

- Context Plan
- Allocation
- Render
- Freeze
- Trace

进行结构 Diff。

大纲模式第一阶段要求：

> 尽量保持 Zero Semantic Drift。

续写模式则允许因旧逻辑修复产生可解释变化。

---

# 11. Golden Diff

必须建立：

```text
Golden Writing Journey
```

至少覆盖：

### Outline

```text
GJ-O-01 Basic
GJ-O-02 Writer Style
GJ-O-03 Story Memory
GJ-O-04 Note None
GJ-O-05 Large Context
GJ-O-06 Recent 10 Chapters
GJ-O-07 Kill / Resume New Kernel
```

### Continuation

```text
GJ-C-01 Basic Canon
GJ-C-02 Seam
GJ-C-03 Primary Anchor
GJ-C-04 Writer Style
GJ-C-05 Story Memory
GJ-C-06 Large Context
GJ-C-07 Semantic Revision Apply
GJ-C-08 Batch N=3
GJ-C-09 Kill / Restart
```

---

# 12. Decision Replay

统一 Replay 必须支持：

```text
Collect
Normalize
Plan
Allocate
Render
Freeze
Draft Decision Metadata
Review Decision Metadata
Revision Obligations
Finalize Validation
```

至少结构化 Diff：

- selectionDiff
- allocationDiff
- renderDiff
- fingerprintDiff
- obligationDiff
- finalValidationDiff

每个核心 Fixture：

```text
x10 determinism
```

---

# 13. Trace

统一：

```text
WritingTrace
```

包含：

```text
writingRunId
generationTraceId
scenario
sourceFingerprint
contextPlanFingerprint
allocationFingerprint
renderFingerprint
freezeFingerprint
draftHash
revisionHash
finalHash
obligations
validation
legacyRestart
```

Scenario 只作为：

> Trace Metadata。

不能作为 Post-Freeze Pipeline 分支驱动字段。

---

# 14. Real Device Matrix

Phase II 必须执行真实设备 / Emulator 穿测。

建议最低矩阵：

| Scenario | Case |
|---|---|
| Outline | Basic |
| Outline | Story Memory |
| Outline | Writer Style |
| Outline | 64K |
| Outline | 128K |
| Outline | 1M |
| Outline | Kill / Restart |
| Continuation | Basic |
| Continuation | Canon |
| Continuation | Seam |
| Continuation | Writer Style |
| Continuation | Story Memory |
| Continuation | 64K |
| Continuation | 128K |
| Continuation | 1M |
| Continuation | Batch N=3 |
| Continuation | Kill / Restart |
| Continuation | Semantic Revision Apply |

要求：

```text
Fatal = 0
Silent Context Loss = 0
Unexpected Live DB Re-read = 0
Fingerprint Drift = 0
False Applied Requirement = 0
```

---

# 15. Independent Generation Stability CI

Phase II 必须补齐独立 CI Job：

```text
generation-stability
```

显示名称建议：

```text
Generation Stability
```

必须独立于：

- JavaScript validation
- Android build
- Migration matrix

不得：

```text
allow-failure
```

必须至少运行：

- Writing Contract
- Source Adapter
- Frozen Context
- Decision Replay
- Golden Journey
- Semantic Apply Regression
- Determinism
- Legacy Restart

---

# 16. Phase II 验收 Gate

---

## Gate II-01

生产入口只剩一个：

```text
runWritingKernel()
```

---

## Gate II-02

Outline / Continuation 不再拥有独立 Writer Runner。

---

## Gate II-03

Kernel 不包含：

```ts
if (scenario === 'continuation')
```

式深层核心分支。

---

## Gate II-04

唯一 Budget：

```text
allocateWritingContextBudget
```

---

## Gate II-05

唯一 Renderer：

```text
renderWritingContext
```

---

## Gate II-06

唯一 Freeze Contract：

```text
FrozenWritingContext
```

---

## Gate II-07

Freeze 后禁止 Live DB Re-read。

---

## Gate II-08

旧：

```text
continuationContextBuilder
continuationContextBudget
continuationPromptCompiler
continuationGenerationRunner
```

不得再出现在 Production Call Graph。

---

## Gate II-09

Continuation Semantic Apply P1 必须关闭。

---

## Gate II-10

Decision Replay x10 稳定。

---

## Gate II-11

Golden Journey 全绿。

---

## Gate II-12

Real Device Matrix 全绿。

---

## Gate II-13

Generation Stability CI 独立存在并阻断失败提交。

---

# 17. Phase II PDCA

---

## P — Plan

Phase II 正式编码前重新确认：

- Phase I 已 Seal
- Source Contract 不再变化
- Frozen Contract 设计完成
- Kernel Stages 明确
- Legacy Removal Inventory 完成
- Regression Fixture 完成
- Continuation Semantic P1 已先建立 Red Test

输出：

```text
Phase_II_PDCA_Plan.md
```

---

## D — Do

按严格顺序：

```text
1. Red Regression
2. Context Layer2+
3. Unified Frozen Contract
4. Unified Draft
5. Unified Review
6. Unified Revision
7. Unified Finalize
8. Unified Persist
9. Outline Cutover
10. Continuation Cutover
11. Remove Production Legacy Caller
12. Generation Stability CI
```

---

## C — Check

必须执行：

### Static

```text
lint
typecheck
test
```

### Unit

- context stages
- budget
- render
- freeze
- review
- revision
- final validator

### Replay

```text
x10
```

### Golden

全部 Golden Journey。

### Regression

重点：

```text
REG-WRITING-SEMANTIC-APPLY-001
```

### Real Device

完整 Matrix。

### Production Call Graph Audit

检查：

```text
continuationContextBuilder
continuationContextBudget
continuationPromptCompiler
continuationGenerationRunner
```

是否仍被生产入口调用。

### Silent Fallback Audit

必须：

```text
0
```

---

## A — Act

所有问题必须按：

```text
Finding
→ Root Cause
→ Fix
→ Regression
→ Re-run
```

闭环。

最终：

```text
New P0 = 0
New P1 = 0
Remaining Architecture NO-GO = 0
Generation Stability = GREEN
```

才能进入 Commit。

---

# 18. Phase II Commit

Phase II 完成 PDCA 后独立 Commit：

```text
refactor(writing): rebuild unified production writing kernel
```

建议 Tag：

```text
writing-unification-phase2
```

不得再混入 Phase I 大规模 Source Contract 变更。

如果 Phase II 发现 Phase I 确有缺陷：

1. 先停止 Phase II；
2. 修复 Phase I；
3. 独立形成 Phase I Fix Commit；
4. 重新跑 Phase I PDCA；
5. 再继续 Phase II。

禁止偷偷在 Phase II Commit 中顺手改变 Phase I 根契约。

---

# 19. 推荐执行顺序

完整长程顺序：

```text
Baseline Freeze

↓
Phase I Plan

↓
Phase I Do
  WritingScenario
  WritingSource
  OutlineAdapter
  ContinuationAdapter
  Source Validation
  Fingerprint
  Legacy Restart

↓
Phase I Check

↓
Phase I Act

↓
Phase I Seal

↓
Commit A

============================

↓
Phase II Plan

↓
先建立 Red Regression

↓
Context True Stage Migration

↓
Unified Frozen Contract

↓
Unified Draft

↓
Unified Review / Audit

↓
Unified Revision

↓
Unified Proof / Finalize

↓
Unified Persist / State Update

↓
Outline Cutover

↓
Continuation Cutover

↓
Legacy Production Core Removal

↓
Generation Stability CI

↓
Phase II Check

↓
Phase II Act

↓
Phase II Seal

↓
Commit B
```

---

# 20. 禁止的大爆炸式重构

本工程禁止：

```text
一边改 Source
一边改 Kernel
一边改 DB
一边改 Story Memory
一边改模型策略
一边删除 Legacy
```

这种 Big Bang Refactor。

必须坚守：

```text
Phase I = Input Boundary

Phase II = Execution Kernel
```

---

# 21. Git 工作原则

Agent 执行时：

- 以本地仓当前状态为准
- 先检查 worktree
- 不覆盖用户未提交改动
- 不使用 `git reset --hard`
- 不使用 `git clean -fd`
- 不 Force Push
- 不擅自修改无关文件
- 每次修改前确认作用域
- 每个 Phase 自己完成测试
- 每个 Phase 自己完成 PDCA
- 每个 Phase 自己形成独立 Commit

建议：

```text
Phase I Commit
        ↓
Phase II
```

而不是两个 Phase 最后一起提交。

---

# 22. 风险控制

## Risk 1：Source Contract 设计过度

应避免把所有业务对象完整复制进 WritingSource。

原则：

> 只抽象“写作需要的语义”。

---

## Risk 2：场景逻辑重新污染 Kernel

禁止 Kernel 使用 Scenario 分支。

优先使用：

- Source Type
- Requirement
- Constraint
- Policy

驱动。

---

## Risk 3：Continuation Domain 被误删

Canon / Boundary / Seam 等是领域能力，不是 Legacy 垃圾。

应：

```text
抽离
```

而不是：

```text
删除
```

---

## Risk 4：Context Builder 名义瘦身

必须看真实职责。

只拆文件名不算完成。

---

## Risk 5：Silent Fallback

任何资料失败不得静默吞掉 Mandatory Source。

必须显式 Trace / Diagnostic。

---

## Risk 6：假的 Revision Applied

必须由 Semantic Apply Regression 长期阻断。

---

## Risk 7：旧任务恢复复杂化

不做旧 Execution State Migration。

统一 Restart Through New Kernel。

---

# 23. 最终 Definition of Done

只有全部满足，整个长程工程才算完成。

---

## 架构

- [ ] 项目只有一条 Production Writing Kernel
- [ ] Outline / Continuation 仅是 Scenario Adapter
- [ ] Writing Kernel 不依赖产品模式分支
- [ ] Phase I Source Contract 稳定
- [ ] Phase II Frozen Contract 稳定

---

## Context

- [ ] Collect 真拆
- [ ] Normalize 真拆
- [ ] Plan 真拆
- [ ] Allocate 真拆
- [ ] Render 真拆
- [ ] Freeze 真拆
- [ ] Builder 仅做薄编排
- [ ] Freeze 后无 Live Data Read

---

## Continuation

- [ ] Canon 保留为领域能力
- [ ] Boundary 保留
- [ ] Seam 保留
- [ ] Anchor 保留
- [ ] Continuation Writer Core 淘汰
- [ ] Continuation Budget 淘汰
- [ ] Continuation Prompt Compiler 淘汰
- [ ] Continuation独立 Runner 淘汰

---

## Execution

- [ ] Draft 统一
- [ ] Review 统一
- [ ] Audit 统一
- [ ] Revision 统一
- [ ] Proof 统一
- [ ] Final Validate 统一
- [ ] Persist 统一
- [ ] State Update 统一

---

## Legacy

- [ ] 旧未完成任务不 Resume
- [ ] 旧任务可 Restart Through New Kernel
- [ ] 用户内容数据兼容
- [ ] 旧 Runtime State 不兼容
- [ ] 新 Run 使用新 Trace / Fingerprint / Frozen Context

---

## Stability

- [ ] Decision Replay
- [ ] x10 determinism
- [ ] Golden Journey
- [ ] Semantic Apply Regression
- [ ] Real Device Matrix
- [ ] Silent Context Loss = 0
- [ ] False Applied Requirement = 0
- [ ] Generation Stability CI 独立存在

---

## PDCA

- [ ] Phase I PDCA 完成
- [ ] Phase I Commit 独立
- [ ] Phase II PDCA 完成
- [ ] Phase II Commit 独立

---

# 24. 最终工程结论

本次工程不是简单的“共享代码”。

也不是：

> 把 Continuation Pipeline 接到 Outline Pipeline。

真正目标是：

> **删除“双流水线”这个架构概念。**

最终：

```text
大纲创作
原著续写
```

只存在于：

```text
产品层
+
Source Adapter
```

Writing Kernel 只理解：

```text
资料
约束
上下文
预算
正文
审查
修改
验证
持久化
```

而不理解：

```text
这是大纲模式
这是原著续写模式
```

最终系统应形成：

```text
One Writing Input Contract
+
One Frozen Writing Contract
+
One Production Writing Kernel
+
One Trace
+
One Replay
+
One Golden System
+
One Stability CI
```

这是本次长程治理完成后的最终目标。

---

# 25. 最终硬性原则

> **Data Compatibility = YES**

> **Execution Compatibility = NO**

> **Scenario Difference Before Kernel**

> **No Scenario Branch After Freeze**

> **One Production Writing Kernel**

> **Phase I PDCA → Commit**

> **Phase II PDCA → Commit**

只有做到以上七点，才视为本次 Writing Pipeline 统一工程真正完成。
