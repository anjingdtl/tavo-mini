# TAVO-MINI Production Writing Governance V1.0
## 流程治理与流水线提速总路线方案 —— ONE Pipeline / ONE Context / ONE Memory

**项目：** TAVO-MINI  
**文档定位：** 总路线方案 / 架构治理蓝图  
**远端基线：** `main` HEAD `8eaf4b7faf58b4caf05a0cb0b3429d58725849de`  
**核心方向：** 从“Writing Kernel 已统一”继续收束到“生产流程唯一、上下文真相唯一、长期叙事记忆唯一”，在不牺牲正文质量、Canon、Freeze、Resume 与 Story Memory 稳定性的前提下，实现流程治理、API 调用收敛、Token 重复运输下降和章节端到端提速。

---

# 0. 总纲

TAVO-MINI 当前已经完成第一阶段核心收束：

```text
ONE Production Writing Entry
+
ONE Writing Kernel
+
ONE Shared Writer Core
+
ONE Shared Prompt Compiler
+
ONE Shared Stage Set
```

下一阶段不再继续改造 Writer Core，而是治理上下游长期迭代遗留的重复能力。

本轮目标：

```text
ONE Pipeline
+
ONE Context
+
ONE Memory
```

最终闭环：

```text
Source / User Intent
        ↓
     ONE Context
        ↓
     ONE Freeze
        ↓
    ONE Pipeline
        ↓
 Shared Writer Core
        ↓
       Persist
        ↓
     ONE Memory
        ↓
  Next Chapter Freeze
```

核心原则：

> **只有一个生产写作流程、只有一个上下文预算与冻结真相、只有一个长期叙事记忆系统。**

Canon、Boundary、Seam、Continuity State 不属于第二套长期记忆，而属于事实权威、场景约束或结构化运行状态。

---

# 1. 当前基线与治理对象

## 1.1 当前生产链路

```text
UI / Single Chapter / Batch / Resume
                ↓
      Production Writing Entry
                ↓
         Outline / Continuation
                ↓
           PRE-FREEZE
                ↓
        WritingSourceBundle
                ↓
Collect → Normalize → Plan
→ Allocate → Render
→ Requirements → StagePolicy
                ↓
             ONE Freeze
                ↓
══════════════════════════════════
            POST-FREEZE
                ↓
        ONE Writing Kernel
                ↓
       Shared Stage Runner
                ↓
        Shared Writer Core
                ↓
     Shared Prompt Compiler
                ↓
        LLM Request Layer
                ↓
       Provider / Scheduler
                ↓
       Durable Artifacts
                ↓
 Local FinalValidate → Persist
                ↓
 Story Memory / Continuation State
```

这条主结构必须保留。

---

## 1.2 当前四类主要治理问题

### A. Pipeline 仍偏固定串行

标准 Outline / Continuation 都存在约 5 个主要模型 Stage，而 Shared Stage Runner 当前按 `for + await` 顺序执行。底层 Scheduler 已支持同项目 Pipeline 并发，但单章流水线基本没有充分利用。

### B. Context 存在双层治理

当前更接近：

```text
场景级 Context Governance
        ↓
WritingSourceBundle
        ↓
Kernel Generic Context Governance
        ↓
Freeze
```

需要厘清第一层与第二层之间哪些是必要标准化，哪些是重复预算、重复估算、重复裁剪和重复渲染。

### C. 多 Stage 反复运输 Frozen Context

当前每个模型 Stage 都会收到 Frozen Context，同时逐步叠加 Draft / Review / Audit / FactCheck / Revision 等 Previous Artifacts，可能造成明显重复 Token 运输。

### D. Memory 存在模式分叉

Continuation 同时使用 Story Memory、Canon、Continuation State，并保留独立续写状态/记忆确认逻辑。需要收束为：

```text
ONE Story Memory
+
Canon
+
Structured Continuity State
```

---

# 2. 总体目标架构

```text
                   User Intent / Source
                           ↓
                       ONE CONTEXT
                           ↓
          Source → Normalize → Retrieve
          → Budget → Allocate → Render
                           ↓
                         FREEZE
                           ↓
                       ONE PIPELINE
                           ↓
           Stage Policy / Dependency DAG
                           ↓
                  Shared Writer Core
                           ↓
                 FinalValidate / Persist
                           ↓
                       ONE MEMORY
                           ↓
          Story Memory + Structured State
                           ↓
                  Next Chapter Context
```

---

# 3. 板块一：ONE Pipeline

## 3.1 定义

ONE Pipeline 不等于所有模式执行完全相同的 Stage。

它的准确含义是：

> 所有生产写作进入同一 Pipeline Orchestrator、同一 Stage Contract、同一 Dependency DAG 和同一执行策略编译器；不同场景与档位只能通过 Policy 决定 Stage Required / Conditional / Skipped / Parallel。

禁止重新出现独立的：

```text
Outline Pipeline
Continuation Pipeline
Fast Pipeline
Extreme Pipeline
```

允许差异存在于：

```text
Source Adapter
Durable Adapter
Stage Policy
Validator Plugin
PostWriting Plugin
```

---

## 3.2 从固定流程升级为 Policy-Driven Pipeline

当前：

```text
Stage 存在
→ 默认执行
```

目标：

```text
Stage 存在
→ Policy 判断
→ Required / Conditional / Skipped
```

建议语义：

```text
Draft           Required
Review          Required / Conditional / Skipped
Audit           Required / Conditional / Skipped
FactCheck       Required / Conditional / Skipped
Revision        Conditional
Proof           Conditional / Required
FinalValidate   Local Required
Persist         Required
```

所有 Skip 必须正式持久化：

```text
status = skipped
skipReason
policyRuleId
```

不得 Fake Completed。

---

## 3.3 建立真正的 Pipeline DAG

目标依赖图：

```text
Draft
  │
  ├──────► Review
  │
  └──────► Audit / FactCheck
              │
              ▼
       Findings Aggregator
              │
              ▼
           Revision
              │
              ▼
            Proof
              │
              ▼
       FinalValidate
              │
              ▼
           Persist
```

DAG 必须明确：

- 谁依赖 Draft；
- 谁互相独立；
- 谁依赖 Aggregated Findings；
- 谁可并行；
- 谁可条件跳过。

---

## 3.4 条件 Revision

目标：

```text
Review / Audit / FactCheck
        ↓
Findings Aggregator
        ↓
存在明确可执行问题？
   ├─ YES → Revision
   └─ NO  → Revision SKIPPED
```

Revision 不应仅因为“流水线里有这个 Stage”就必跑。

---

## 3.5 条件 Proof

Proof 是否必跑必须由真实 A/B 长测决定。

候选策略：

```text
Quality Profile   → Proof Required
Balanced Profile  → Proof Conditional
Fast Profile      → Proof Conditional / Skipped
One-Shot          → Proof Skipped
```

不能凭感觉直接删掉。

---

## 3.6 保守并发

只并发依赖明确独立的 Stage。

Outline 候选：

```text
Draft
  ↓
Review ─────┐
            ├─ conservative parallel
FactCheck ──┘
     ↓
Findings Aggregator
```

Continuation 的 Review / Audit 是否可并发，需要通过输入依赖和真实长测验证后再决定。

禁止无脑并发所有 Stage。

---

## 3.7 Critical Path 与 API 调用口径

必须观测：

```text
stageQueuedMs
stageExecutionMs
stageDependencyWaitMs
stagePersistMs
chapterE2EMs
```

同时区分三种调用：

```text
Logical Stage Call
Recovery / Formatter Call
Physical HTTP Request
```

建议统一指标：

```text
logicalStageCallCount
formatterCallCount
physicalRequestCount
protocolFallbackCount
```

不得再用一个“API Calls”字段混合统计。

---

## 3.8 Resume / Retry 红线

继续保持：

```text
成功 Stage 不重跑
Existing Artifact 直接恢复
Outcome Unknown Fail Closed
Resume Duplicate Paid Call = 0
```

批量创作中 App crash 后，只能从最后 durable checkpoint 继续。

---

## 3.9 ONE Pipeline 终态

```text
ONE Orchestrator
+
ONE Stage DAG
+
ONE Stage Policy
+
ONE Shared Writer Core
+
ONE Retry/Resume Contract
+
ONE Telemetry Contract
```

---

# 4. 板块二：ONE Context

## 4.1 定义

ONE Context 不等于把所有资料拼成一个大字符串。

定义：

> 整个 Production Writing 生命周期只存在一套权威上下文候选模型、一套最终预算决策、一套 Frozen Context 真相。场景模块只负责提供 Source，不再各自拥有独立的最终 Context Budget。

---

## 4.2 目标收束

当前：

```text
Outline / Continuation Context Builder
        ↓
Retrieval / Ranking / Budget / Clip
        ↓
WritingSourceBundle
        ↓
Collect / Normalize / Plan
        ↓
Allocate / Render
        ↓
Freeze
```

目标：

```text
Source Adapters
        ↓
Canonical Context Candidates
        ↓
ONE Context Planner
        ↓
ONE Elastic / Hierarchical Budget
        ↓
ONE Render
        ↓
ONE Freeze
```

---

## 4.3 Source Adapter 与 Context Planner 分离

场景 Adapter 只负责提供：

```text
资料是什么
类型是什么
authority 是什么
mandatory / preferred / optional
relevance
source fingerprint
content
```

Outline Adapter 可提供：

```text
Outline
Story Memory
Recent Chapters
Characters
World Rules
Notes
Writer Style
User Instruction
```

Continuation Adapter 可提供：

```text
Source Boundary
Canon
Seam
Anchor
Story Memory
Continuity State
Recent Continuation
Writer Style
User Instruction
```

Adapter 不再做第二套最终 Budget 决策。

---

## 4.4 Canonical Context Candidate

统一候选 Contract 建议包含：

```text
candidateId
kind
authority
requirement
priority
relevance
availableTokens
minTokens
targetTokens
maxTokens
protected
sourceFingerprint
content
```

这样 Outline / Canon / Memory / State / Style / Recent Chapter 都进入同一治理体系。

---

## 4.5 保留现有弹性预算

本轮不重写已成熟的 Elastic / Hierarchical Budget 数学模型，只统一调用入口和真相来源。

必须继续遵守：

```text
real contextWindow
reservedOutputTokens
safetyMargin
mandatory / preferred / optional
soft / burst / hard
protected source
dynamic clipping
```

禁止为任何档位新增固定输入 Token 上限。

---

## 4.6 Context Authority

建议权威级别：

```text
Level 0  User Explicit Instruction
Level 1  Canon / Source Boundary / Protected Rule
Level 2  Structured Continuity State
Level 3  Current Outline / Plot Obligation
Level 4  Story Memory
Level 5  Recent Chapters / Episodic Retrieval
Level 6  Style / Notes / Reference
```

预算不能只看相关性，也必须尊重 authority。

---

## 4.7 ONE Freeze

最终只有一次：

```text
Candidates
→ Budget
→ Allocation
→ Render
→ Requirements
→ Policy
→ Freeze
```

Freeze 后禁止：

```text
重新查 Canon
重新查 Story Memory
重新读取用户设置
重新预算 Context
重新读取 live model config
```

---

## 4.8 Stage Context Projection

关键原则：

> Frozen Context 是唯一真相，但每个 Stage 不必都携带完整 Frozen Context。

目标：

```text
ONE Frozen Context
        ↓
Deterministic Stage Projection
        ↓
该 Stage 真正需要的 Slice
```

例如：

```text
Draft:
几乎完整 Context

Review:
Draft + Plot/Outline + User Instruction + Style + Obligations

FactCheck/Audit:
Draft + Canon + Boundary + Continuity + Character/World Rules

Revision:
Draft + Aggregated Findings + Relevant Requirements + 必要 Canon/Style

Proof:
Final Candidate + Style + Protected Passage + Length + Residual Findings
```

Stage Projection 不得变成五套独立预算系统，只能是 Frozen Context 上的确定性投影。

---

## 4.9 Previous Artifacts 收束

当前后续 Stage 会反复带完整：

```text
Draft
Review
Audit
FactCheck
Revision
```

目标增加统一：

```text
Findings Aggregator
```

结构化：

```text
findingId
sourceStage
severity
target
issue
instruction
requirementIds
evidence
```

Revision 消费 Aggregated Findings，而不是重复携带所有检查报告全文。

---

## 4.10 Context Telemetry

每章必须能回答：

```text
候选总 Token
实际分配 Token
实际 Render Token
每 Candidate allocation
每 Stage projected tokens
duplicate context ratio
mandatory retention rate
clipping reason
```

建议：

```text
frozenContextTokens
stageProjectedContextTokens
artifactTokens
duplicateContextTokens
duplicateContextRatio
```

---

## 4.11 ONE Context 终态

```text
ONE Candidate Contract
+
ONE Context Planner
+
ONE Elastic/Hierarchical Budget
+
ONE Render
+
ONE Freeze
+
Deterministic Stage Projection
```


---

# 5. 板块三：ONE Memory

## 5.1 定义

ONE Memory 的核心定义：

> **TAVO-MINI 全项目只保留一套“长期叙事记忆系统”——Story Memory。Outline 与 Continuation 共用同一套 checkpoint / bridge / episodic / long-term narrative memory。**

Continuation 不再拥有第二套需要用户确认的长期记忆。

---

## 5.2 严格区分三类信息

### A. Story Memory

回答：

```text
故事到目前为止发生了什么？
哪些人物、事件、伏笔和变化值得长期记住？
哪些历史信息与当前章节相关？
```

它是：

```text
Narrative Long-Term Memory
```

Outline 与 Continuation 共用。

### B. Canon

回答：

```text
哪些事实绝对不能被写错？
```

包括：

```text
原著角色设定
世界规则
既定事实
死亡状态
知识边界
人物关系
```

Canon 是事实权威，不是长期记忆摘要。

### C. Structured Continuity State

回答：

```text
当前时刻人物和剧情处于什么状态？
```

例如：

```text
location
physicalState
emotionalState
currentGoal
aliveState
relationship
knowledgeBoundary
activePlotThread
```

它属于：

```text
Derived Runtime State
```

不是第二套长期记忆。

---

## 5.3 目标 Memory 架构

```text
                     ONE MEMORY
                         │
                 Story Memory
                         │
             checkpoint / bridge
             episodic retrieval
             long-term summary
                         │
       ┌─────────────────┴─────────────────┐
       │                                   │
    Outline                           Continuation
       │                                   │
       │                          Canon / Boundary
       │                          Continuity State
       │                                   │
       └─────────────────┬─────────────────┘
                         │
                     ONE Context
```

---

## 5.4 取消 Continuation 正常确认 Barrier

当前续写如果存在：

```text
生成
↓
状态抽取
↓
用户确认
↓
下一章
```

会直接阻塞批量创作和自动流水线。

目标：

```text
生成
↓
Persist
↓
PostWriting Update
├─ Story Memory
└─ Continuity State
↓
Auto Validate / Commit
↓
下一章
```

只有以下情况要求用户确认：

```text
Canon Conflict
重大状态冲突
低置信度且会影响后续剧情
无法自动合并
```

正常 State Extraction 不再要求人工确认。

---

## 5.5 Memory Authority 与冲突规则

建议统一为：

```text
Canon
    ↓
Frozen Source Boundary
    ↓
Structured Continuity State
    ↓
Story Memory
    ↓
Recent Prose
```

冲突处理：

```text
Story Memory ≠ Canon
→ Canon 胜

Story Memory ≠ Continuity State
→ State 胜

Continuity State ≠ Canon
→ Conflict Gate
```

Story Memory 不承担硬事实最终裁决职责。

---

## 5.6 Story Memory 更新路径统一

目标：

```text
Chapter Persist
        ↓
Story Memory Update Contract
        ↓
同一套：
checkpoint eligibility
pending bridge
rolling summary
episodic entry
```

无论：

```text
Outline
Continuation
One-Shot
Standard
Batch
Single Chapter
```

都通过同一个 Memory Update Contract。

---

## 5.7 Continuity State 的新定位

Continuation 仍保留结构化 State Extraction，但它必须降级为：

```text
PostWriting State Update Plugin
```

而不是：

```text
Continuation Memory System
```

输出：

```text
Character State
Relationship Delta
Plot Thread Delta
Knowledge Delta
Location Delta
```

经过 Local Validator / Canon Check 后自动 commit。

---

## 5.8 Post-Writing Update 与关键路径

需要区分：

```text
正文是否已经完成
```

与：

```text
Memory / State 后处理是否已经完成
```

目标：

```text
Critical Path
Draft → QA → Revision → Proof → Persist
                                ↓
                           User sees DONE
```

随后：

```text
Post-Writing Path

Story Memory Update
        ||
Continuity State Extraction
```

但必须满足：

> **下一章 Freeze 前，依赖的 Story Memory / Continuity State 必须达到 Ready。**

可以采用：

```text
Chapter N Persist
→ PostWriting Pending
→ UI 正文完成
→ 后处理并行
→ Chapter N+1 Freeze Gate 等待必要状态 Ready
```

这样减少用户体感等待，但不能让下一章读取旧状态。

---

## 5.9 One-Shot 与 Memory

One-Shot 的“最多 1 次 API”只约束正文写作路径。

它不能破坏：

```text
Story Memory
Continuity State
Persist
```

如果 Story Memory / State Extraction 还需要额外模型调用，应明确计为：

```text
PostWriting Auxiliary Call
```

不能混入：

```text
Chapter Writing Paid Calls
```

未来可继续研究这些后处理是否能本地化、合并或批处理，但本阶段不直接删除。

---

## 5.10 ONE Memory 终态

```text
ONE Story Memory
+
Canon Authority
+
Structured Continuity State
+
ONE PostWriting Update Contract
+
Conflict-Only User Confirmation
```

---

# 6. 三大板块接驳：ONE Pipeline × ONE Context × ONE Memory

三个板块不能分别改完后再临时拼接，必须先定义接驳 Contract。

---

## 6.1 Context → Pipeline

唯一接驳对象：

```text
FrozenWritingContext
```

唯一方向：

```text
ONE Context
↓
Freeze
↓
ONE Pipeline
```

Pipeline 不允许：

```text
重新查 Source
重新预算
重新构建 Context
```

只允许：

```text
Deterministic Stage Projection
```

---

## 6.2 Pipeline → Memory

建议唯一接驳事件：

```text
WritingPersistedEvent
```

至少包含：

```text
generationTraceId
freezeFingerprint
projectId
chapterId
chapterPosition
finalBodyFingerprint
executionProfile
appliedRequirementIds
```

Memory 不读取 Pipeline 中间未完成状态。

只有正文 durable persist 成功后，才进入 Memory Update。

---

## 6.3 Memory → Context

下一章开始时：

```text
Story Memory
Continuity State
Canon
```

全部作为 Context Candidate 进入 ONE Context。

禁止：

```text
Memory 直接拼 Prompt
State 直接绕过 Context Budget
Canon Post-Freeze live injection
```

统一路径：

```text
Memory / Canon / State
↓
Context Candidate
↓
ONE Budget
↓
Freeze
```

---

## 6.4 三者闭环

```text
           ┌────────────────────────┐
           │      ONE MEMORY        │
           │ Story + State + Canon  │
           └────────────┬───────────┘
                        │
                        ▼
                Context Candidates
                        │
                        ▼
                 ONE CONTEXT
                        │
                        ▼
                     Freeze
                        │
                        ▼
                 ONE PIPELINE
                        │
                        ▼
                     Persist
                        │
                        ▼
              PostWriting Update
                        │
                        └───────────→ ONE MEMORY
```

---

# 7. 三板块合并后的最终 Production Flow

```text
[1] USER / BATCH / RESUME
        ↓
[2] SOURCE ADAPTER
        ↓
[3] CANONICAL CONTEXT CANDIDATES
        ↓
[4] ONE CONTEXT PLANNER
        ↓
[5] ELASTIC / HIERARCHICAL BUDGET
        ↓
[6] RENDER
        ↓
[7] REQUIREMENTS + POLICY
        ↓
[8] ONE FREEZE
        ↓
[9] PIPELINE DAG
        ↓
[10] DRAFT
        ↓
[11] REVIEW / AUDIT / FACTCHECK
        ├─ formal skip
        ├─ conditional
        └─ conservative parallel
        ↓
[12] FINDINGS AGGREGATOR
        ↓
[13] CONDITIONAL REVISION
        ↓
[14] CONDITIONAL / REQUIRED PROOF
        ↓
[15] LOCAL FINAL VALIDATE
        ↓
[16] PERSIST
        ↓
[17] WRITING PERSISTED EVENT
        ↓
[18] POST-WRITING UPDATE
        ├─ ONE Story Memory
        └─ Structured Continuity State
        ↓
[19] NEXT CHAPTER READY
```

---

# 8. Execution Profile 在新架构中的位置

未来：

```text
极速 / 低 / 中 / 高
        ↓
Execution Profile
        ↓
Stage Policy
        ↓
Pipeline DAG Execution
```

Execution Profile 可以决定：

```text
Stage 是否执行
Stage 是否 Conditional
Stage 是否并发
Reasoning Policy
Formatter Policy
Retry Policy
Max Paid Calls
```

但不能决定：

```text
另一套 Context
另一套 Memory
另一套 Writer
另一套 Pipeline
固定 Token 上限
```

One-Shot 现有封板契约必须保留。

---

# 9. 建议实施路线

建议分 5 个 Phase。

## Phase 0：Baseline & Observability

先不改生产行为。

补齐：

```text
Chapter E2E P50 / P95
Context Build Ms
Freeze Ms
Stage Queue Ms
Stage API Ms
Persist Ms

Logical Stage Calls
Formatter Calls
Physical HTTP Requests
Protocol Fallback Calls

Input Tokens / Chapter
Output Tokens / Chapter
Frozen Context Tokens
Stage Projected Tokens
Duplicate Context Ratio

Story Memory Update Ms
State Extraction Ms
PostWriting Blocking Ms
```

目标：

> **先知道时间和钱到底花在哪。**

---

## Phase 1：ONE Memory

优先执行 Memory Governance。

原因：

- 用户实际痛点明确；
- 可取消续写确认 Barrier；
- 风险低于直接改 Pipeline 并发；
- 能减少 Memory Source 重复；
- 为 ONE Context 建立清晰 authority。

目标：

```text
Continuation Narrative Memory
→ ONE Story Memory

Continuation State
→ Structured State

User confirmation
→ Conflict-only
```

---

## Phase 2：ONE Context

完成：

```text
Canonical Candidate Contract
统一 Context Planner 入口
去除双层最终 Budget
Stage Projection
Artifact Findings Aggregator
```

必须保持现有 Elastic / Hierarchical 数学模型与自动预算能力。

---

## Phase 3：ONE Pipeline

Context / Memory 收束后再做：

```text
Stage DAG
Conditional Revision
Conditional Proof
Conservative Parallel Review/Audit
Critical Path
```

避免在旧 Context 结构上直接堆并发。

---

## Phase 4：ONE Flow 集成

完整接驳：

```text
ONE Pipeline
ONE Context
ONE Memory
```

重点验证：

```text
Freeze
Resume
Batch
One-Shot
Outline
Continuation
Story Memory
Canon
Continuity State
```

不存在双真相。

---

# 10. 硬边界

## 10.1 Writer 禁止回退

禁止重新出现：

```text
OutlineWriterCore
ContinuationWriterCore
FastWriter
OneShotWriter
```

## 10.2 Context 禁止回退

禁止：

```text
固定 Token cap
档位专属 Context Builder
Stage 自己重新查数据库
Post-Freeze live retrieval
```

## 10.3 Memory 禁止回退

禁止长期保持：

```text
Outline Story Memory
+
Continuation Long-Term Memory
```

两套叙事长期记忆。

## 10.4 Pipeline 禁止回退

禁止：

```text
Fake No-op Skip
为了并发删除 Durable Ledger
为了提速关闭 Freeze
为了降低延迟取消 Canon / Boundary / Seam
```

---

# 11. 质量红线

提速不能来自：

```text
删 Canon
删 Story Memory
删 Continuity Gate
降低 Semantic Apply
放宽 Final Validate
吞异常
静默降级
无条件跳过 Revision
无限并发
缩短有效上下文
```

提速必须来自：

```text
减少重复 Context
减少无效 Stage
减少无问题 Revision
减少重复 API
合理并发
减少 Pipeline Barrier
减少用户确认 Barrier
减少重复 Token 运输
更快 Resume
```

---

# 12. 最终验收指标

## 12.1 Pipeline

```text
Duplicate Paid Stage = 0
Resume Duplicate Paid Call = 0
Conditional Stage Skip 可追踪
Critical Path 可观测
Physical Request 可准确计数
```

## 12.2 Context

```text
Production Context Planner = 1
Production Context Budget Decision = 1
Frozen Context Truth = 1
New Hard Token Cap = 0
Post-Freeze Live Read = 0
Stage Context Projection 可追踪
Duplicate Context Ratio 明显下降
```

## 12.3 Memory

```text
Narrative Long-Term Memory System = 1
Outline uses Story Memory = YES
Continuation uses Story Memory = YES
Continuation Second Long-Term Memory = 0
Structured Continuity State = retained
Canon = retained
Normal User Confirmation Barrier = 0
Conflict User Confirmation = retained
```

## 12.4 Integrated

```text
Outline 真实长测
Continuation 真实长测
One-Shot 真实长测
Batch 真实长测
Resume / Crash 长测

Fatal Context Loss = 0
Freeze Drift = 0
Memory Drift = 0
Canon Regression = 0
False Applied Requirement = 0
Duplicate Paid Stage = 0
```

---

# 13. 性能目标制定方式

本总路线暂不写死“提速 30% / 50%”。

先通过 Phase 0 获取：

```text
Chapter E2E P50
Chapter E2E P95
Paid LLM Calls / Chapter
Physical HTTP / Chapter
Input Tokens / Chapter
Duplicate Context Ratio
Revision Trigger Rate
Formatter Rate
Protocol Fallback Rate
PostWriting Blocking Ms
```

再制定真实可达目标。

---

# 14. 总路线原则

> **ONE Pipeline：所有写作只走一套生产流程，差异由 Policy 决定，不再由不同模式各自维护流水线。**

> **ONE Context：所有写作只产生一个权威 Frozen Context，场景只提供 Source，预算、分配、渲染与 Freeze 统一治理。**

> **ONE Memory：整个 TAVO 只保留一套长期叙事记忆 Story Memory，Continuation 只保留 Canon 与 Structured Continuity State，不再维护第二套需要用户确认的长期记忆。**

> **ONE Flow：Memory → Context → Freeze → Pipeline → Persist → Memory，形成唯一闭环。**

---

# 15. 目标终态

```text
                     TAVO WRITING CORE
                           │
                  ┌────────┴────────┐
                  │                 │
             Source Adapters    User Intent
                  │                 │
                  └────────┬────────┘
                           │
                       ONE CONTEXT
                           │
                        FREEZE
                           │
                       ONE PIPELINE
                           │
                  Shared Writer Core
                           │
                        Persist
                           │
                       ONE MEMORY
                           │
                Story Memory + State
                           │
                           └────→ Next Chapter
```

最终目标不是：

```text
更多 Stage
更多 Context
更多 Memory
```

而是：

```text
更少的生产真相
更少的重复计算
更少的重复 Token
更少的无效 API
更少的同步 Barrier
更稳定的 Freeze
更清晰的 Trace
更快的章节完成速度
```

---

# 16. 后续专项拆分

总路线确认后建议继续拆分为：

```text
01_ONE-Memory_治理与迁移方案.md
02_ONE-Context_上下文收束与Stage投影方案.md
03_ONE-Pipeline_流程治理与性能提速方案.md
04_ONE-Flow_三板块接驳与最终穿测方案.md
```

每个专项独立 PDCA，禁止一次性大爆改。
