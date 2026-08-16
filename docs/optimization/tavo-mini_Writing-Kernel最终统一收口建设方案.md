# tavo-mini Writing Kernel 最终统一收口建设方案

> 文档定位：Writing Pipeline Unification Final Closure  
> 目标：实现**真正唯一的一套 Production Writing Kernel**，彻底退出旧 Continuation Writer Core  
> 验收基线：以 Agent 执行时的**本地工作仓最新有效状态为准**，远端仅用于对照与最终提交  
> 本方案生成时远端参考：`main@843b275d7d47dfae8b6c17ee328c0d7ffb2d8e52`  
> 已有阶段基线：Phase I `b8d3f5b`；Phase II `36e7757`  
> 核心原则：**Data Compatibility = YES；Old Execution Compatibility = NO**

---

## 0. 最终结论先行

本轮不是继续完善“统一入口 + 双旧核心”的过渡结构，而是完成最后一次架构收口：

```text
Outline Writing Adapter ──────┐
                              │
Continuation Writing Adapter ─┤
                              ▼
                       WritingRequest
                              ↓
                 Unified Source Contract
                              ↓
                  Collect / Normalize
                              ↓
                     Plan / Allocate
                              ↓
                       Render / Freeze
                              ↓
              ONE FrozenWritingContext
                              ↓
                   ONE Writing Kernel
                              ↓
 Draft → Review/Audit → FactCheck → Revision → Proof
                              ↓
                    Final Validate
                              ↓
                         Persist
                              ↓
                 Post Writing Update
```

最终项目中只能保留**一个 Production Writing Kernel**。

“大纲创作”和“原著续写”只能是：

```text
WritingScenario = outline | continuation
```

它们的差异必须在 **Freeze 前**通过 Source Adapter / Policy Adapter 完成。

一旦进入 `FrozenWritingContext`：

> **后续 Writer / Reviewer / Auditor / Reviser / Proof / Finalize 不得再根据 scenario 选择两套不同流水线。**

旧 Continuation Writer Core 必须完全退出生产调用链。

---

# 1. 本轮治理目标

## 1.1 P0 总目标

完成以下四项，否则整轮直接判定 **NO-GO**：

1. `runWritingKernel()` 成为真正唯一的生产写作执行核心；
2. Outline 与 Continuation 共用同一套：
   - Context
   - Budget
   - Freeze
   - Draft
   - Review
   - FactCheck/Audit
   - Revision
   - Proof
   - Final Validate
   - Persist
3. 旧 Continuation 生产执行核心彻底退出；
4. 真机真实 LLM 完成：
   - Outline：两轮 × 5 章；
   - Continuation：两轮 × 5 章；
   - 合计至少 20 章。

---

## 1.2 本轮禁止出现的伪统一

以下任一情况存在，都不能称为“统一 Writing Kernel”：

```text
runWritingKernel()
  ├─ outline → runChapterPipeline()
  └─ continuation → startContinuationRun()
```

或者：

```text
Unified Kernel
   ↓
Facade Freeze
   ↓
Old Outline Freeze / Old Continuation Freeze
```

或者：

```text
Unified Trace
但实际 Prompt / Budget / Context / Runner 仍各跑各的
```

或者：

```text
scenario === continuation
  ? continuationWriterCore()
  : outlineWriterCore()
```

出现在 Freeze 之后。

本轮必须解决的是**执行权威归属**，不是 API 名称统一。

---

# 2. 当前已确认的架构缺口

基于本轮远端验收，当前工程已经有较完整的 Writing Contract、Source Adapter、Context 六阶段、Trace/Replay、Semantic Apply、Generation Stability，但仍存在以下关键问题。

## 2.1 `runWritingKernel()` 当前仍主要是 Facade

当前 Kernel 已经负责：

```text
Collect
Normalize
Plan
Allocate
Render
Freeze
```

但 Freeze 后真正执行仍通过传入的 executor 委托旧逻辑。

当前生产入口实质上仍存在：

```text
Outline
→ runChapterPipeline(...)

Continuation
→ startContinuationRun(...)
```

因此：

> 当前只是统一了“入口与追踪外壳”，没有统一真正的 Writer Engine。

---

## 2.2 Continuation 仍然拥有完整独立执行核心

当前旧 Continuation 体系仍存在并参与生产逻辑：

```text
continuationGenerationRunner.ts
continuationContextBuilder.ts
continuationContextBudget.ts
continuationPromptCompiler.ts
continuationV4Runner.ts
continuationV5Runner.ts
```

其中旧 Context Builder 仍然直接掌握：

- Database；
- Canon；
- Story Memory；
- Style；
- Source Reader；
- Anchor；
- Continuation Budget；
- Continuation Snapshot。

这意味着当前存在第二个真实 Context Authority。

---

## 2.3 当前存在双 Freeze 风险

当前 Writing Facade 会创建统一 FrozenWritingContext。

但旧 Outline / Continuation 执行器内部仍有自己的：

- Pipeline Context Snapshot；
- Continuation Context Snapshot；
- Budget；
- Prompt；
- Stage Contract。

因此当前不是：

```text
ONE Freeze
```

而更接近：

```text
Facade Freeze
      ↓
Legacy Durable Freeze
```

这会带来：

- Source Fingerprint 不同；
- Context Budget 双重决策；
- Trace 与真实 LLM 输入不完全一致；
- Replay 只能重放 Facade 决策，不能完整重放真实生产决策；
- 后续修复时可能继续出现两个模式行为漂移。

---

# 3. 最终目标架构

## 3.1 最终目录建议

建议最终生产结构收敛为：

```text
src/services/writing/
│
├─ contracts/
│  ├─ writingRequest.ts
│  ├─ writingSource.ts
│  ├─ writingPolicy.ts
│  ├─ frozenWritingContext.ts
│  ├─ writingStage.ts
│  └─ writingResult.ts
│
├─ scenario/
│  ├─ outlineWritingAdapter.ts
│  └─ continuationWritingAdapter.ts
│
├─ context/
│  ├─ collectWritingMaterials.ts
│  ├─ normalizeWritingMaterials.ts
│  ├─ buildWritingContextPlan.ts
│  ├─ allocateWritingContextBudget.ts
│  ├─ renderWritingContext.ts
│  └─ freezeWritingContext.ts
│
├─ stages/
│  ├─ draft.ts
│  ├─ review.ts
│  ├─ factCheck.ts
│  ├─ audit.ts
│  ├─ revision.ts
│  ├─ proof.ts
│  ├─ semanticApply.ts
│  ├─ finalValidate.ts
│  ├─ persist.ts
│  └─ postWritingUpdate.ts
│
├─ trace/
│  ├─ writingTrace.ts
│  └─ writingStageTrace.ts
│
├─ replay/
│  └─ writingReplay.ts
│
├─ regression/
│  └─ writingGoldenFixtures.ts
│
├─ productionWritingEntry.ts
└─ unifiedWritingKernel.ts
```

---

## 3.2 唯一生产调用链

最终必须变成：

```text
UI / Batch / Background / Resume
              ↓
      productionWritingEntry
              ↓
        runWritingKernel()
              ↓
        build/fetch Freeze
              ↓
          runDraft()
              ↓
     runReview / runFactCheck
              ↓
         runRevision()
              ↓
           runProof()
              ↓
      runFinalValidate()
              ↓
          runPersist()
              ↓
     runPostWritingUpdate()
```

任何 Production UI、Batch、Background Worker 都不得绕过该入口。

---

# 4. Scenario 的最终边界

## 4.1 Outline 模式

Outline Adapter 负责把以下资料转换成统一 Writing Source：

### Mandatory

- Writing Instruction
- Current Chapter Definition
- Outline
- Preset / Writing Baseline

### Preferred

- Writer Style
- Story Memory
- Character
- Worldbook
- Recent Chapters
- Episodic Memory

### Optional

- Note
- Supplemental Resources

最终输出：

```ts
WritingSourceBundle
```

之后不再有 Outline 专属 Writer Core。

---

## 4.2 Continuation 模式

Continuation Adapter 负责把以下资料转换成同样的 Writing Source：

### Mandatory

- Writing Instruction
- Canon
- Source Boundary
- Seam
- Primary Anchor
- Writer Style（若项目要求硬绑定）

### Preferred

- Story Memory
- Character
- Worldbook
- Recent Chapters
- Episodic Memory
- Accepted Continuation State

### Optional

- Preset
- Note
- Historical Digest
- Other Supplements

最终仍然输出：

```ts
WritingSourceBundle
```

之后不再进入 Continuation 专属 Context Builder、Budget、Prompt Compiler 或 Runner。

---

# 5. 关键架构铁律

## 5.1 Freeze 前允许 Scenario 差异

允许：

```text
Outline Adapter
Continuation Adapter

Outline mandatory source policy
Continuation mandatory source policy

Canon
Boundary
Seam
Anchor
```

这些都是输入层差异。

---

## 5.2 Freeze 后禁止 Scenario 决策流水线

Freeze 后禁止：

```ts
if (scenario === 'continuation') {
  ...
}

switch (scenario) {
  case 'outline':
  case 'continuation':
}
```

用于决定：

- 调哪个 Writer；
- 调哪个 Reviewer；
- 调哪个 Budget；
- 用哪个 Prompt Compiler；
- 用哪个 Revision；
- 用哪个 Finalize。

Freeze 后最多允许 Scenario 用于：

- Trace metadata；
- UI label；
- analytics；
- diagnostic copy。

不得影响核心生成算法。

---

# 6. Work Package A — 建立真正的 Unified Stage Contract

## 6.1 新增统一 Stage 输入

每个阶段只能接受：

```ts
interface WritingStageInput {
  frozenContext: FrozenWritingContext;
  previousArtifacts: WritingStageArtifacts;
  model: FrozenModelConfig;
  policy: WritingPolicySnapshot;
  trace: WritingKernelTrace;
}
```

禁止 Stage 自己重新查询：

- project；
- chapter；
- Canon；
- Story Memory；
- Outline；
- preset；
- writer style；
- note；
- worldbook。

---

## 6.2 Stage 不得拥有二次 Context Builder

必须保证：

```text
Draft
Review
FactCheck
Audit
Revision
Proof
FinalValidate
```

只消费 Frozen Context。

不得在 Stage 内：

```text
read DB
rebuild context
reselect canon
recalculate scenario resources
```

如果确需动态内容，必须在 Freeze 前显式进入候选，或者通过**受控 post-draft local retrieval plugin**进入统一契约，并记录到 Trace。

---

# 7. Work Package B — 把 Outline 真正迁入 Unified Kernel

当前大纲链路仍调用：

```text
runChapterPipeline()
resumePipeline()
```

本轮需要把其中仍有价值的逻辑拆成共享 Stage。

## 7.1 拆迁内容

从旧 Pipeline Runner 中提取：

- Draft request build；
- Review；
- FactCheck；
- Revision；
- Proof；
- Final Validator；
- Persist；
- Stage checkpoint；
- Retry；
- Resume；
- Usage accounting。

迁移到：

```text
src/services/writing/stages/*
```

---

## 7.2 大纲模式迁移原则

第一步必须保持 Outline 行为稳定：

> **先等价迁移，再做清理。**

通过 Golden Diff 保证：

```text
Source decision
Allocation
Rendered Context
Prompt semantics
Stage order
Retry semantics
Final result persistence
```

不发生无计划漂移。

---

## 7.3 迁移完成标准

Production Call Graph 中：

```text
runChapterPipeline()
```

调用者必须为：

```text
0
```

或者仅存在于：

```text
legacy/
test/
migration compatibility
```

不得存在于生产 UI / Batch / Background。

---

# 8. Work Package C — 把 Continuation 真正迁入 Unified Kernel

这是本轮最重要部分。

## 8.1 旧 Continuation Context Builder 退场

必须把：

```text
continuationContextBuilder.ts
```

中的有效资料转换逻辑迁移到：

```text
ContinuationWritingAdapter
+
Shared Writing Context Layer
```

其中：

```text
Canon
Boundary
Seam
Anchor
Story Memory
Style
Continuation State
```

都只作为：

```text
WritingSource
```

存在。

---

## 8.2 Continuation Budget 退场

旧：

```text
continuationContextBudget.ts
```

不得再成为独立预算核心。

所有 Candidate 必须经过统一：

```text
allocateWritingContextBudget()
```

Continuation 若有特殊保护，只能通过：

```text
requirement: 'mandatory'
priority
minimumReservation
protectedGroup
```

等统一 Candidate / Policy 元数据表达。

禁止继续保留：

```text
Continuation-specific whole second allocator
```

---

## 8.3 Continuation Prompt Compiler 退场

旧：

```text
continuationPromptCompiler.ts
continuationV5PromptCompiler.ts
```

不得继续掌握完整 Writer/Reviewer/Reviser Prompt。

其中仍有价值的 Prompt 规则要拆成：

```text
shared stage prompt
+
frozen source blocks
+
writing policy
```

如果 Continuation 需要：

```text
Canon constraint
Seam continuity
Anchor continuity
Style requirement
```

这些必须由 Frozen Context 里的结构化 Source/Requirement 提供。

而不是：

```ts
if continuation:
  use completely different prompt compiler
```

---

## 8.4 Continuation Runner 退场

最终：

```text
continuationGenerationRunner.ts
continuationV4Runner.ts
continuationV5Runner.ts
```

不得继续承担 Production Writer Core。

可以短期保留以下用途：

- Legacy data parser；
- history display；
- old result migration；
- compatibility reader；
- test fixture。

但不得：

```text
start new production writing
resume new production writing
call LLM for new writing
```

---

# 9. Work Package D — 单一 FrozenWritingContext

## 9.1 一个写作任务只能有一个权威 Freeze

必须满足：

```text
Writing Request
→ one sourceFingerprint
→ one contextPlanFingerprint
→ one allocationFingerprint
→ one renderFingerprint
→ one freezeFingerprint
```

后续所有 Stage 共享。

---

## 9.2 禁止二次 Freeze

任何代码发现以下情况都必须 fail closed：

```text
existing freeze exists
but stage attempts to rebuild from live DB
```

错误建议：

```text
WRITING_FROZEN_CONTEXT_MISSING
WRITING_FROZEN_CONTEXT_CORRUPT
WRITING_LIVE_REREAD_BLOCKED
WRITING_FREEZE_FINGERPRINT_DRIFT
```

---

# 10. Work Package E — 真正统一 Draft → Finalize

## 10.1 推荐统一 Stage 顺序

标准 Full 模式：

```text
Draft
   ↓
Review ─────┐
            ├─→ Revision
FactCheck ──┘
   ↓
Audit / Contract Merge
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

具体并发可以继续沿用当前成熟策略，但不得按 Scenario 分叉。

---

## 10.2 原 Continuation V5 有价值能力的处理

不要简单删除 V5 的优秀能力。

以下能力应迁入共享 Writing Kernel：

- Architecture / scene planning；
- Anchor continuity；
- Style requirement；
- Audit obligations；
- Semantic Apply；
- Final Artifact Validator；
- no-op declaration；
- continuation continuity checks。

但迁移方式必须是：

```text
shared stage capability / plugin / requirement
```

而不是继续保留：

```text
ContinuationV5Runner
```

作为第二套完整流水线。

---

# 11. Work Package F — 统一 Persist 与 Post Writing Update

## 11.1 Persist 必须共享

Outline 和 Continuation 最终正文落库都走：

```text
runPersist()
```

共享：

- revision；
- body hash；
- adoption；
- transaction；
- usage；
- final result；
- trace binding。

---

## 11.2 Continuation State 变成 Post Writing Plugin

原著续写特有：

```text
State Extraction
Proposal
Outbox
Canon/Story Memory dirty/rebuild
```

不应继续是“第二 Writer Core”的理由。

应该变成：

```text
PostWritingUpdatePlugin
```

例如：

```ts
interface PostWritingUpdatePlugin {
  appliesTo(context: FrozenWritingContext): boolean;
  execute(result: PersistedWritingResult): Promise<void>;
}
```

Continuation 可注册：

```text
ContinuationStatePlugin
```

Outline 可注册：

```text
StoryMemoryUpdatePlugin
```

这样差异发生在“写完以后如何更新领域状态”，而不是“用哪套 Writer”。

---

# 12. Work Package G — Resume / Retry 统一

## 12.1 Resume 依据 Stage Checkpoint

统一：

```text
task
generationTraceId
freezeFingerprint
stage checkpoints
stage attempts
```

恢复时不得再次重建资料。

---

## 12.2 Execution Compatibility = NO

旧未完成 Continuation Run：

```text
不得继续使用旧 Runner Resume
```

采用：

```text
recover user/project/chapter/instruction
→ restartLegacyWritingTask()
→ new WritingRunId
→ new generationTraceId
→ new FrozenWritingContext
```

旧执行态仅用于：

- 展示；
- 审计；
- 用户决定放弃/重启。

---

# 13. Work Package H — Production Call Graph 清零

增加自动架构测试。

## 13.1 必须禁止的 Production import

Production 源码不得再 import：

```text
continuationGenerationRunner
continuationContextBuilder
continuationContextBudget
continuationPromptCompiler
continuationV4Runner
continuationV5Runner
runChapterPipeline
resumePipeline
```

例外必须放入明确白名单：

```text
legacy/
migration/
tests/
```

---

## 13.2 新增架构测试

建议：

```text
__tests__/writingProductionCallGraph.test.ts
```

硬断言：

```text
Production direct old continuation runner callers = 0
Production direct old outline runner callers = 0
Production writing entry count = 1
Post-Freeze scenario execution branches = 0
Live DB reads in writing stages = 0
```

---

# 14. Work Package I — Legacy 删除计划

不要第一天直接全删。

按三步：

## Step 1：Disconnect

先让 Production Callers = 0。

## Step 2：Observe

完成：

- full Jest；
- Generation Stability；
- Outline 5 章；
- Continuation 5 章。

## Step 3：Delete

删除已无生产价值的旧核心：

```text
continuationGenerationRunner.ts
continuationContextBuilder.ts
continuationContextBudget.ts
continuationPromptCompiler.ts
```

V4/V5 文件根据剩余兼容用途分类：

```text
delete
或
move to legacy/
```

最终不得留在：

```text
Production Writer Core
```

---

# 15. Semantic Apply 必须继续保留为 P0 Gate

已修复的：

```text
SEMANTIC_APPLY_FAILED
VALID_NO_OP
```

不得因为统一 Kernel 而退化。

必须保证：

如果模型声明：

```text
appliedRequirementIds > 0
```

但最终正文相对 Revision Body 没有语义变化，则：

```text
无明确 VALID_NO_OP reason
→ Final Validate BLOCK
```

不得出现：

```text
declared applied
正文未改变
但最终交付成功
```

---

# 16. Trace / Replay 最终标准

## 16.1 一个 Generation Trace

每次写作：

```text
one generationTraceId
```

必须贯穿：

```text
Source
Collect
Normalize
Plan
Allocate
Render
Freeze
Draft
Review
FactCheck
Audit
Revision
Proof
FinalValidate
Persist
PostWritingUpdate
```

---

## 16.2 Replay 必须能覆盖真实生产决策

Replay 不得只重放 Facade。

至少能够复现：

```text
selected candidates
allocation
rendered block order
freezeFingerprint
stage policy
requirement ids
final validation decision
```

固定 Fixture：

```text
x10
```

必须：

```text
Fingerprint Drift = 0
Decision Drift = 0
```

---

# 17. CI 强制门禁

现有：

```text
Generation Stability
```

必须继续保留。

本轮扩充为：

```text
writingSourceContract
writingKernelReconstruction
writingProductionCallGraph
writingFreezeAuthority
writingReplay
writingSemanticApply
writingResume
outlineGolden
continuationGolden
legacyRestart
```

GitHub Actions：

```text
Generation Stability
```

必须：

```text
required
non allow-failure
```

---

# 18. PDCA 执行顺序

本轮仍执行：

```text
Finding
→ Root Cause
→ Red Regression
→ Minimal Fix
→ Focused Tests
→ Full Regression
→ Device Test
→ Commit
```

禁止：

```text
一次改几十个模块
→ 最后统一测试
```

---

# 19. 推荐实施阶段

## Phase 0 — Baseline Freeze

先执行：

```text
git status
git log -10
git rev-parse HEAD
npm run lint
npm run typecheck
npm test -- --runInBand
Generation Stability
```

记录基线。

严禁：

```text
git reset --hard
git clean -fd
git checkout .
force push
```

用户现有本地工作树优先。

---

## Phase 1 — Unified Stage Contract

新增共享：

```text
WritingStageInput
WritingStageArtifacts
WritingStageResult
```

并完成：

```text
Draft
Review
FactCheck
Revision
Proof
FinalValidate
```

的统一接口。

### Gate

```text
compile PASS
focused tests PASS
no behavior cutover yet
```

---

## Phase 2 — Outline Cutover

把：

```text
runChapterPipeline
```

中的生产功能迁入 Writing Kernel。

### Gate

```text
Outline Product → Writing Kernel only
runChapterPipeline production caller = 0
Outline Golden Diff = PASS
```

---

## Phase 3 — Continuation Context Cutover

把 Continuation：

```text
Canon
Boundary
Seam
Anchor
Style
Story Memory
State
```

全部通过 Adapter 进入统一 Source Contract。

### Gate

```text
Continuation Context Builder production caller = 0
Continuation Budget production caller = 0
one Freeze only
```

---

## Phase 4 — Continuation Writer Cutover

迁移 V5 有价值 Stage 能力到 Shared Stages。

### Gate

```text
startContinuationRun production caller = 0
Continuation V5 Runner production caller = 0
Post-Freeze scenario branch = 0
```

---

## Phase 5 — Persist / State / Resume 收口

统一：

```text
Persist
Usage
Checkpoint
Resume
Retry
Post Writing Update
```

Continuation 状态更新变成 plugin。

### Gate

```text
new production task never enters old continuation run
legacy run can only restart as new Writing Kernel run
```

---

## Phase 6 — Legacy Disconnect + Delete

先静态验证 0 caller，再删除。

### Gate

```text
Old Continuation Production Core = 0
```

---

# 20. 自动化测试矩阵

## 20.1 单元/集成测试

至少覆盖：

### Context

- Outline mandatory sources；
- Continuation mandatory sources；
- missing Canon fail closed；
- missing Seam fail closed；
- Note None；
- Story Memory Dirty；
- 64K；
- 128K；
- 1M Context；
- mandatory cannot be evicted；
- optional elastic shrink；
- deterministic allocation。

### Execution

- Draft failure；
- Review failure；
- FactCheck failure；
- Revision retry；
- Proof retry；
- Semantic Apply failure；
- VALID_NO_OP；
- Persist transaction rollback；
- Retry resumes same freeze；
- Kill/Resume；
- no live DB reread。

### Architecture

- single entry；
- old caller = 0；
- one freeze；
- scenario branch leak；
- duplicate writer core detection。

---

# 21. 真机实测硬门禁

本轮最后必须执行**四组真实 LLM 5章测试**。

不是简单：

```text
Outline 5章 + Continuation 5章
```

而是：

```text
Outline Round A：连续 5 章
Outline Round B：连续 5 章

Continuation Round A：连续 5 章
Continuation Round B：连续 5 章
```

总计：

```text
20 章
```

---

# 22. Outline 真机测试

## 22.1 Outline Round A — 基础连续写作

连续生成：

```text
O-A-01
O-A-02
O-A-03
O-A-04
O-A-05
```

必须检查：

- Source Bundle；
- Outline；
- Story Memory；
- Writer Style；
- Character；
- Worldbook；
- Note；
- recent chapter；
- Frozen Context；
- Budget；
- Draft；
- Review；
- FactCheck；
- Revision；
- Proof；
- Final Validate；
- Persist；
- Story Memory 更新；
- usage；
- trace；
- fingerprint。

---

## 22.2 Outline Round B — 稳定性/恢复

再连续生成 5 章：

```text
O-B-01
O-B-02
O-B-03
O-B-04
O-B-05
```

必须至少包含：

- 1 次后台切换；
- 1 次用户离开编辑页；
- 1 次暂停/恢复；
- 1 次进程重启或冷启动恢复；
- Story Memory 更新跨章节；
- 真实 Batch 或连续单章链路。

要求：

```text
重复付费 Stage = 0
Freeze Drift = 0
Context Loss = 0
```

---

# 23. Continuation 真机测试

## 23.1 Continuation Round A — 连续性基础测试

连续续写：

```text
C-A-01
C-A-02
C-A-03
C-A-04
C-A-05
```

逐章检查：

- Canon；
- Source Boundary；
- Seam；
- Primary Anchor；
- Writer Style；
- Story Memory；
- recent continuation chapters；
- Frozen Context；
- Draft；
- Review；
- Audit；
- Revision；
- Proof；
- Final Validate；
- Semantic Apply；
- adoption；
- state extraction；
- outbox；
- Story Memory update。

重点验证：

> 第 N+1 章必须真正读取第 N 章形成的续写接缝，而不是旧 Runner 内部另一套状态。

---

## 23.2 Continuation Round B — 状态/恢复/批量

再连续 5 章：

```text
C-B-01
C-B-02
C-B-03
C-B-04
C-B-05
```

至少覆盖：

- Batch；
- Pause；
- Resume；
- Kill/Restart；
- state proposal；
- confirm all；
- Story Memory rebuild；
- Canon unchanged；
- Boundary unchanged；
- continuation state update；
- semantic apply。

要求：

```text
False Applied Requirement = 0
Silent State Loss = 0
Duplicate Outbox = 0
Duplicate Paid Call = 0
```

---

# 24. 两轮测试之间必须独立

不得把：

```text
同一次 10 章生成
```

拆成两份 5 章报告冒充两轮。

每一轮都必须单独记录：

```text
start timestamp
project id
chapter ids
generationTraceIds
model config
context window
provider
round result
```

Round B 必须重新检查设备状态和配置。

---

# 25. Debug APK 升级安装验收

两种模式测试开始前必须：

```bash
adb install -r <latest-debug.apk>
```

不得卸载 App。

升级前后核对：

- 项目数量；
- 章节数量；
- Provider；
- Model；
- Endpoint；
- API Key reference；
- context_window；
- max_output_tokens；
- reasoning/thinking；
- Story Memory config；
- preset；
- writing mode；
- continuation source/canon；
- batch state。

要求：

```text
Data Loss = 0
Config Drift = 0
```

---

# 26. 每章实测记录模板

```markdown
## Chapter Test

- Mode:
- Round:
- Chapter:
- Project ID:
- Chapter ID:
- Generation Trace ID:
- Writing Run ID:
- Provider:
- Model:
- Context Window:

### Source
- sourceFingerprint:
- mandatory candidates:
- preferred candidates:
- optional candidates:

### Freeze
- contextPlanFingerprint:
- allocationFingerprint:
- renderFingerprint:
- freezeFingerprint:

### Stage
- Draft:
- Review:
- FactCheck:
- Audit:
- Revision:
- Proof:
- Final Validate:
- Persist:
- Post Update:

### Result
- final body hash:
- semantic apply:
- usage:
- retry:
- repeated paid stage:
- Story Memory:
- Continuation State:
- Outbox:

### Verdict
PASS / FAIL
```

---

# 27. 最终量化指标

最终必须满足：

```text
Production Writing Kernel Count = 1
Production Writing Entry Count = 1

Old Outline Runner Production Callers = 0
Old Continuation Runner Production Callers = 0
Old Continuation Context Builder Production Callers = 0
Old Continuation Budget Production Callers = 0
Old Continuation Prompt Compiler Production Callers = 0

Authoritative Freeze Count Per Run = 1

Fatal = 0
Silent Context Loss = 0
Unexpected Live DB Read = 0
Fingerprint Drift = 0
False Applied Requirement = 0
Duplicate Paid Stage = 0
Config Loss After adb install -r = 0
```

---

# 28. Final GO / NO-GO Gate

## G1 — Source Contract

```text
Outline PASS
Continuation PASS
```

## G2 — Context

```text
Collect PASS
Normalize PASS
Plan PASS
Allocate PASS
Render PASS
Freeze PASS
```

## G3 — Kernel

```text
single production kernel PASS
```

## G4 — Legacy

```text
old continuation production caller = 0
```

## G5 — Resume

```text
same frozen context
no paid stage duplication
```

## G6 — Semantic Apply

```text
false claim = 0
```

## G7 — Replay

```text
x10 deterministic
```

## G8 — CI

```text
Verify PASS
Generation Stability PASS
```

## G9 — APK

```text
adb install -r PASS
data retained
LLM config retained
```

## G10 — Outline Real LLM

```text
Round A 5/5 PASS
Round B 5/5 PASS
```

## G11 — Continuation Real LLM

```text
Round A 5/5 PASS
Round B 5/5 PASS
```

只有：

```text
G1-G11 全部 PASS
```

才允许：

```text
FINAL SEALED
```

---

# 29. Commit 建议

不要做一个巨型 Commit。

建议：

```text
refactor(writing): establish shared post-freeze stage contracts

refactor(writing): cut outline production onto unified kernel

refactor(writing): move continuation context into shared writing sources

refactor(writing): retire continuation writer core from production

refactor(writing): unify persistence resume and post-write state updates

test(writing): enforce single production writing kernel

test(writing): record outline two-round five-chapter device validation

test(writing): record continuation two-round five-chapter device validation

docs(writing): seal unified writing kernel closure
```

---

# 30. Agent 自主执行约束

Agent 可以自主修改、测试、修复、提交，但必须遵守：

1. 本地仓为事实基线；
2. 不覆盖用户未提交工作；
3. 不使用 `reset --hard`；
4. 不使用 `clean -fd`；
5. 不 force push；
6. 发现 bug 先写 Red Regression；
7. 一个根因一组修复；
8. 不为了绿测试删除测试；
9. 不 mock 替代最终真实 LLM 验收；
10. 不以“统一 API 名称”冒充“统一执行核心”；
11. 不保留 Production 双 Runner；
12. 真机发现问题必须继续 PDCA，直到同一轮重新跑绿。

---

# 31. 最终验收报告必须回答的 12 个问题

1. 现在项目中是否只有一个 Production Writing Kernel？
2. Outline 是否还调用 `runChapterPipeline()`？
3. Continuation 是否还调用 `startContinuationRun()`？
4. Continuation Context Builder 是否还有 Production Caller？
5. Continuation Budget 是否还有 Production Caller？
6. Continuation Prompt Compiler 是否还有 Production Caller？
7. 每个写作任务是否只有一个权威 Freeze？
8. Freeze 后是否还存在 scenario 驱动的 Writer Core 分支？
9. Resume 是否复用同一个 Frozen Context？
10. Semantic Apply 是否仍是硬门禁？
11. Outline 两轮 × 5 章是否全部通过？
12. Continuation 两轮 × 5 章是否全部通过？

只要任一答案不符合目标：

```text
NO-GO
```

---

# 32. 最终 Seal 定义

本项目只有在以下状态下才算真正完成本轮统一：

```text
tavo-mini has ONE production-level Writing Pipeline.

Outline Creation and Original-work Continuation
are only two WritingScenario / Source Policies.

They share:
- one source contract
- one context planner
- one allocator
- one renderer
- one freeze
- one draft engine
- one review engine
- one revision engine
- one final validator
- one persistence path
- one trace/replay system
- one resume model

The old Continuation Writer Core is no longer part of Production.
```

中文定义：

> **tavo-mini 只保留一条生产级 Writing Pipeline。大纲创作与原著续写不再拥有各自独立流水线，只作为同一 Writing Kernel 的两种 Scenario/Input Policy。场景差异必须在 Freeze 前完成适配；Freeze 后所有写作、审阅、修订、校验、持久化、恢复流程完全共用。旧 Continuation Writer Core 必须彻底退出 Production。**

---

# 33. 最终执行口令

Agent 执行时以本方案为硬约束：

```text
目标不是让现有 unifiedWritingKernel 看起来更完整，而是让它真正成为唯一 Writer Engine。

先断开旧 Outline / Continuation Runner 的 Production 调用，
再迁移有效能力，
再删除 Legacy Core，
最后用大纲两轮×5章、续写两轮×5章真实 LLM 穿测证明统一架构真实成立。

测试绿但 Production 仍有双 Writer Core，不算完成。
Trace 统一但真实 Prompt/Context/Runner 仍分叉，不算完成。
Facade 统一但旧 Continuation Runner 仍执行新任务，不算完成。

只有 ONE Production Writing Kernel 才允许 Seal。
```
