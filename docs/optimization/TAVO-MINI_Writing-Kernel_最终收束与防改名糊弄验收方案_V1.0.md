# TAVO-MINI Writing Kernel 最终收束与防“改名糊弄”验收方案

**文档版本：V1.0 Final Closure**  
**适用项目：** `tavo-mini` / ShineWriter  
**适用场景：** 更换开发机后的最终架构收束、远端验收、真实 LLM 穿测与封版  
**目标：** 将“大纲创作模式”与“原著续写模式”真正收敛为 **ONE Production Writing Kernel + ONE Shared Writer Core + ONE Shared Stage Implementation**，禁止通过改文件名、改导出名、增加 Facade、Capability 包装或空 Stage 伪装完成统一。

---

## 1. 最终目标

最终生产架构必须达到：

```text
Outline Source Adapter ─────┐
                            ├──> WritingRequest
Continuation Source Adapter ┘
                                 ↓
                        ONE Writing Kernel
                                 ↓
Collect → Normalize → Plan → Allocate → Render → Freeze
                                 ↓
Draft → Review → Audit / FactCheck → Revision → Proof
                                 ↓
Final Validate → Persist → Post-writing Update
```

Outline 与 Continuation 只允许在 **Freeze 前**存在 Source Adapter / Requirement Provider / Policy / Scenario Metadata 差异。

Freeze 之后的 Writer Core 必须完全统一：

```text
ONE Draft
ONE Review
ONE Audit
ONE FactCheck
ONE Revision
ONE Proof
ONE Final Validate
ONE Persist
```

不接受：

```text
ONE Stage Facade
    ↓
execute()
    ↓
Outline Writer Core / Continuation Writer Core
```

---

# 2. 本轮远端验收发现的核心问题

当前代码虽然已经存在：

- `runWritingKernel()`
- `runWritingStages()`
- `runDraftStage()`
- `runReviewStage()`
- `runAuditStage()`
- `runFactCheckStage()`
- `runRevisionStage()`
- `runProofStage()`
- `runFinalValidateStage()`
- `runPersistStage()`

但目前仍存在“共享 Stage 外壳 + 场景专属真实实现”的结构。

典型问题：

```ts
runDraftStage(...)
  -> runSharedStage(...)
      -> stageInput.execute()
```

然后：

```text
Outline:
execute()
  -> runOutlineStageOperation()
  -> runOutlineWritingCapability()
  -> pipeline/outlineStageRuntime.ts

Continuation:
execute()
  -> runContinuationDraftCapability()
  -> runContinuationRevisionAndAuditCapability()
  -> runContinuationProofCapability()
```

这不属于真正统一。

当前实质仍是：

```text
ONE Kernel
+
ONE Shared Stage Facade
+
TWO Scenario Writer Cores
```

而最终目标必须是：

```text
ONE Kernel
+
ONE Shared Writer Core
+
ONE Concrete Shared Stage Implementation
```

---

# 3. P0：禁止 Agent 通过“改名”制造假收束

这是本轮最重要的治理要求。

## 3.1 禁止以下行为

以下任意情况都视为 **NO-GO**：

### A. 旧 Core 只改文件名

例如：

```text
continuationV5StageMachine.ts
        ↓
continuationStageCapabilities.ts
```

但内部仍然保留：

- Draft Writer
- Revision Writer
- Adversarial Auditor
- Final Reviser
- Final Artifact Validator
- Continuation 专属 Prompt Compiler
- Continuation 专属 Writer 流程调度

则判定：

> **仅改名，Writer Core 未消失。**

### B. 旧 Core 只改 export 名

例如：

```ts
runLegacyContinuationPipeline()
```

改为：

```ts
runContinuationCapability()
```

如果仍然一次调用完成完整 Draft / Revision / Audit / Proof / Finalize，则依然属于 Scenario Writer Core。

### C. 增加 Shared Facade，但真实执行继续走两套实现

禁止：

```ts
runDraftStage({
  execute: () => runOutlineDraft(...)
})
```

和：

```ts
runDraftStage({
  execute: () => runContinuationDraft(...)
})
```

这只是统一函数入口，不是统一实现。

### D. 空 Stage / 假 Stage

禁止：

```ts
{ stage: 'review', execute: async () => undefined }
{ stage: 'audit', execute: async () => undefined }
{ stage: 'factCheck', execute: async () => undefined }
{ stage: 'persist', execute: async () => undefined }
```

然后真实 Review / Audit / Persist 被隐藏在其它 Capability 内。

这种做法属于：

> **Trace / Stage 名义统一，业务实现未统一。**

必须直接阻断。

### E. 旧 Core 搬目录

禁止将：

```text
pipeline/reconcile.ts
```

中的 Writer Core 搬到：

```text
pipeline/outlineStageRuntime.ts
```

然后宣称旧 Core 已清除。

验收关注的是：

> **生产调用图、职责和业务能力是否消失**

不是文件名。

---

# 4. 最关键的结构性修复

## P0-1：删除通用 Stage 的 `execute()` 逃生口

建议最终从共享阶段输入中移除：

```ts
SharedWritingStageInput.execute
```

或至少严格禁止 Production Stage 使用通用 `execute()` 注入 Scenario Writer。

最终应类似：

```ts
runDraftStage({
  frozenContext,
  artifacts,
  requirements,
  stagePolicy,
  modelConfig,
  trace,
})
```

由 `runDraftStage()` 内部统一完成：

1. 读取 FrozenWritingContext
2. 生成 Shared Draft Plan
3. 选择 Scenario Requirement / Policy
4. 统一 Prompt / Message 编排
5. 调用 LLM
6. 解析结果
7. 验证 Artifact
8. 写入共享 Artifact Contract
9. 记录 Trace

而不是通过：

```ts
execute()
```

把 Writer 实现重新交还给 Outline / Continuation。

---

# 5. Shared Stage 最终职责

## 5.1 Draft

必须只有一套真实 Draft Stage。

允许场景差异：

- Requirement 内容不同
- Canon / Outline Source 类型不同
- Continuation 有 Boundary / Seam / Anchor
- Outline 有 Outline / Synopsis / Story Memory

不允许：

```text
OutlineDraftWriter
ContinuationDraftWriter
```

两套独立 Writer。

应为：

```text
Shared Draft
 ├─ Outline requirements
 └─ Continuation requirements
```

## 5.2 Review

必须统一 Review contract、调用入口、Artifact Schema。

允许：

- Policy 决定是否启用某些检查项
- Requirement 决定检查重点

禁止：

```text
Outline Review Core
Continuation Architect / Reviewer disguised in Round1
```

## 5.3 Audit / FactCheck

必须成为真实独立 Shared Stage。

如果 Continuation 需要：

- Canon consistency
- Boundary consistency
- Seam continuity
- Anchor satisfaction

应通过：

```text
WritingRequirement
AuditRule
ValidatorPlugin
```

表达。

不得将整个 Auditor 藏在：

```text
runContinuationRevisionAndAuditCapability()
```

## 5.4 Revision

必须是一套 Shared Revision Engine。

输入：

```text
Draft Artifact
Review Artifact
Audit Artifact
FactCheck Artifact
Requirements
Policy
Frozen Context
```

输出统一 Revision Artifact。

不得保留：

```text
Outline Brief / Revision Core
Continuation V2 Revision Writer
```

两套 Writer Pipeline。

如果 Outline 的 Brief 机制仍有价值，应降级为：

```text
Revision Planning Strategy
```

而不是独立 Writer Core。

## 5.5 Proof / Final Reviser

必须统一为 Shared Proof / Final Revision Stage。

Continuation 的：

```text
Final Reviser
```

不得作为隐藏独立 Pipeline。

Outline 的：

```text
Proof / Final Reviser
```

也不得保留独立 Core。

可存在不同：

```text
Proof Policy
Validation Rule
Requirement Projection
```

但 Writer 实现必须统一。

## 5.6 Final Validate

必须统一，并继续保留 Semantic Apply P1 硬门禁：

```text
identified
→ accepted
→ applied | waived | already_satisfied
→ verified
```

如声明：

```text
appliedRequirementIds > 0
```

但最终正文相对 Revision Body 无有效语义变化，同时又不存在合法 No-op Reason：

```text
BLOCK
SEMANTIC_APPLY_FAILED
```

禁止 Soft Gate 绕过。

## 5.7 Persist

Persist 必须是真实 Shared Stage。

禁止：

```ts
stage: 'persist',
execute: async () => undefined
```

而实际落库已经在 Continuation Capability 或 Outline Runtime 里完成。

Shared Persist 必须明确拥有：

- final artifact 落库
- chapter content 更新
- generation trace
- run/task status
- fingerprint
- completion record

Scenario 只允许提供 Durable Storage Adapter。

---

# 6. Scenario 层允许保留什么

最终允许：

```text
OutlineSourceAdapter
ContinuationSourceAdapter

OutlineRequirementProvider
ContinuationRequirementProvider

OutlinePolicy
ContinuationPolicy

ScenarioValidatorPlugin
ScenarioPlanningPlugin

OutlineDurableStoreAdapter
ContinuationDurableStoreAdapter

PostWritingUpdatePlugin
```

禁止存在：

```text
OutlineWriterCore
ContinuationWriterCore
OutlineStageRuntime that owns all stages
ContinuationStageCapabilities that own multiple stages
ContinuationV5StageMachine
ScenarioDraftWriter
ScenarioRevisionWriter
ScenarioProofWriter
ScenarioFinalReviser
```

---

# 7. 唯一 Freeze 标准

必须只有一个权威：

```text
FrozenWritingContext
```

Freeze 前：

```text
DB / Story Memory / Canon / Outline / Characters / Worldbook / Notes
```

可以读取。

Freeze 后：

```text
Draft
Review
Audit
FactCheck
Revision
Proof
FinalValidate
```

全部只能读取：

```text
FrozenWritingContext
+
Stage Artifacts
```

禁止重新读取：

- live chapter
- live story memory
- live canon
- live character
- live worldbook
- live note
- active writer style
- live model settings

除明确属于：

```text
Persistence / CAS / cancellation / UI task state
```

的 durable control 数据。

---

# 8. 架构自动门禁必须升级

当前仅检查：

```text
runDraftStage() definition count == 1
```

是不够的。

必须新增以下测试。

## Gate A：禁止 Shared Stage 使用通用 Scenario Executor

建议 `SharedWritingStageInput` 中不存在：

```ts
execute: () => Promise<unknown>
```

Production code 中 `writing/stages/*` 不得接受能够运行完整 Scenario Writer 的 Callback。

## Gate B：Scenario Writer Core Caller = 0

必须自动扫描 `src/` Production code。

以下类型函数 caller 必须为 0：

```text
runOutlineWritingCapability
runContinuationDraftCapability
runContinuationRevisionAndAuditCapability
runContinuationProofCapability
startContinuationRun
runChapterPipeline
resumePipeline
```

如果为了兼容 API 必须保留 wrapper：

```text
wrapper -> ONE Kernel
```

而不能：

```text
ONE Kernel -> wrapper -> old core
```

## Gate C：跨 Stage Capability 禁止存在

Production 中禁止函数同时拥有多个 Writer Stage 业务：

```text
Draft + Review
Revision + Audit
Proof + FinalValidate
Finalize + Persist
```

出现：

```text
runSomethingRevisionAndAudit()
```

原则上直接列为架构告警，必须人工解释。

## Gate D：空 Stage 禁止

Shared Stage 调用不得：

```ts
execute: async () => undefined
```

架构测试应扫描此类模式。

如果某 Scenario 根据 Policy 跳过 Stage，必须产生正式：

```text
status = skipped
skipReason
policyRuleId
```

而不是 Completed + no-op。

## Gate E：LLM Writer 调用只能来自 Shared Stage 层

所有正文生成类：

```text
callWritingStageLLM
LLM draft/revision/proof/final
```

必须能够追溯到：

```text
src/services/writing/stages/
```

不得从：

```text
pipeline/outline*
continuation/generation/*
writing/stages/continuationStageCapabilities.ts
```

直接成为最终 Writer 调用权威。

## Gate F：Prompt 编译职责收束

最终允许：

```text
shared prompt compiler
+
scenario requirement projection
```

禁止保留：

```text
Outline full prompt compiler
ContinuationV5 full prompt compiler
```

两套完整 Writer Prompt 系统并行存在。

---

# 9. 生产调用图验收

最终 Agent 必须输出真实 Production Call Graph。

必须能够证明：

```text
Product Entry
   ↓
runWritingKernel
   ↓
ONE Freeze
   ↓
runWritingStages
   ↓
runDraftStage
runReviewStage
runAuditStage
runFactCheckStage
runRevisionStage
runProofStage
runFinalValidateStage
runPersistStage
```

任何分支中都不得出现：

```text
Outline Writer Pipeline
Continuation Writer Pipeline
V5 Stage Machine
Scenario multi-stage Capability
```

---

# 10. 旧 Core 清理标准

## Outline

`pipeline/outlineStageRuntime.ts` 如果继续存在，只允许保留：

- checkpoint DB helper
- durable state projection
- CAS
- migration compatibility
- task status
- low-level persistence adapter

不得继续拥有：

- Draft LLM
- Review LLM
- FactCheck LLM
- Brief Writer
- Proof LLM
- Final Reviser
- Prompt Compiler
- Writer-specific Artifact Validation

否则：

**Outline old core != 0 → NO-GO**

## Continuation

`continuationStageCapabilities.ts` 如果继续存在，只允许是：

```text
Validator Plugin
Requirement Builder
Scenario Projection
Durable Repository Adapter
```

不得同时拥有：

```text
Draft Writer
Revision Writer
Auditor
Final Reviser
```

否则：

**Continuation old core != 0 → NO-GO**

---

# 11. 数据兼容原则

继续保持：

```text
Data Compatibility = YES
Execution Compatibility = NO
```

必须保留：

- 项目
- 章节
- 导入原著
- Canon
- 角色
- 世界书
- 笔记
- Writer Style
- Story Memory
- 用户设置
- 已完成正文

不迁移旧：

- pending runtime
- stage state
- checkpoints authority
- incomplete legacy execution
- old frozen envelope authority

旧未完成任务：

```text
Legacy Task
  ↓
读取用户数据
  ↓
废弃旧 Runtime
  ↓
创建新 WritingRequest
  ↓
新 Freeze
  ↓
ONE Kernel
```

---

# 12. 开发换机后的工作要求

新开发机首先执行：

```text
git fetch
git status
git log -10
```

确认：

- 本地仓对应正确远端
- branch 正确
- HEAD 正确
- working tree 无未知修改
- 不覆盖未提交用户工作

若新开发机仓库路径变化，以新机器实际本地仓为唯一执行基线。

Agent 不得直接基于远端网页代码修改；远端用于：

```text
audit / push / acceptance
```

本地仓用于：

```text
implementation / test / build / adb
```

---

# 13. 必须执行 Red → Green → Regression

每一个结构性修复：

```text
Root Cause
↓
新增失败测试 Red
↓
Fix
↓
Green
↓
完整 Regression
```

禁止：

- 改断言让测试通过
- 删除失败测试
- mock 掉真实问题
- catch error 后继续
- silent fallback
- 标记 Completed 但实际没执行
- 用旧实现结果填充 Shared Stage trace

---

# 14. CI 最终要求

Generation Stability 必须纳入至少：

```text
writingSourceContract
writingLegacyRestart
writingKernelReconstruction
writingTracePersistence
writingSemanticApply
writingSharedStageSet
writingRequirement
writingPolicy
writingFreezePersistence
writingSingleWriterImplementation
writingNoScenarioExecutor
writingNoEmptyStage
goldenJourneysV2
replayHarness
```

独立 workflow 必须：

```text
allow-failure = false
```

任何门禁失败：

```text
NO-GO
```

---

# 15. Debug APK 升级安装要求

代码完成后：

```bash
adb install -r app-debug.apk
```

禁止：

```bash
adb uninstall
adb shell pm clear
```

必须验证升级前后以下配置保留：

- LLM Provider
- Model
- API Key
- Endpoint
- Context Window
- Max Output Tokens
- Reasoning / Thinking 设置
- Writer Style
- Story Memory 设置
- Project Data

如果升级导致设置丢失：

**NO-GO**

---

# 16. 最终真实 LLM 验收

最终至少：

```text
Outline >= 3 连续章节
Continuation >= 3 连续章节
Total >= 6
```

如时间允许建议：

```text
5 + 5
```

## Outline 每章检查

- WritingRequest
- Source Bundle
- Requirements
- Policy
- Freeze fingerprint
- Draft
- Review
- Audit / FactCheck
- Revision
- Proof
- Final Validate
- Persist
- Story Memory update
- Chapter content
- Trace
- Continuity

## Continuation 每章检查

除以上内容，还必须验证：

- Canon
- Source Boundary
- Seam
- Anchor
- imported source revision
- source snapshot
- Semantic Apply
- continuity
- state extraction
- next-chapter handoff

---

# 17. Final Acceptance Metrics

必须全部满足：

```text
Fatal = 0
Silent Context Loss = 0
False Applied Requirement = 0
Fake Completed Stage = 0
Empty Stage = 0
Scenario Writer Core Caller = 0
Duplicate Freeze = 0
Fingerprint Drift = 0
Post-Freeze Live Source Read = 0
```

---

# 18. GO / NO-GO 判定

## GO

仅当全部满足：

```text
ONE Kernel
ONE Freeze
ONE Shared Stage Runner
ONE concrete Draft implementation
ONE concrete Review implementation
ONE concrete Audit implementation
ONE concrete FactCheck implementation
ONE concrete Revision implementation
ONE concrete Proof implementation
ONE concrete Final Validate implementation
ONE concrete Persist implementation

Outline Writer Core production authority = 0
Continuation Writer Core production authority = 0
Scenario generic execute escape hatch = 0
Fake no-op stages = 0
```

同时：

- lint PASS
- typecheck PASS
- focused tests PASS
- full Jest PASS
- Generation Stability PASS
- Android Debug build PASS
- `adb install -r` PASS
- settings preservation PASS
- Outline 3/3 PASS
- Continuation 3/3 PASS

才允许：

```text
GO
SEAL WRITING KERNEL
```

## NO-GO

出现任一：

```text
改文件名代替架构清除
改 export 名代替 Core 清除
Facade 包装旧 Writer Core
Capability 包装完整 Pipeline
Scenario execute callback 注入 Writer
Shared Stage completed 但 no-op
多 Stage 业务隐藏在一个 Capability
两套 Prompt Writer 并行
两套 Revision Writer 并行
两套 Final Reviser 并行
旧 Runtime 仍掌握 Writer LLM
新改造后未做真实 3+3
```

立即：

```text
NO-GO
```

---

# 19. 对 Agent 的最终指令

> 不要再通过“改名”“搬文件”“增加 wrapper”“增加 facade”“改成 capability”来满足架构测试。  
> 本次验收只认 **生产调用图和实际业务职责**。  
> 如果一个旧模块虽然换了名字，但仍然拥有 Draft/Review/Revision/Proof/Final Writer 能力，它仍然是旧 Writer Core，必须继续拆。  
> 如果 Shared Stage 仍通过 `execute()` 调用 Outline / Continuation 专属 Writer，则视为未统一。  
> 如果 Stage 只是 `async () => undefined`，但真实逻辑被隐藏在其它 Capability 中，则视为假 Stage。  
> 最终标准不是“入口统一”，也不是“文件名统一”，而是 **每个写作阶段的具体生产实现只能有一套**。

---

# 20. 建议最终目标代码形态

```text
src/services/writing/
├─ kernel/
│  └─ writingKernel.ts
│
├─ stages/
│  ├─ draft.ts
│  ├─ review.ts
│  ├─ audit.ts
│  ├─ factCheck.ts
│  ├─ revision.ts
│  ├─ proof.ts
│  ├─ finalValidate.ts
│  └─ persist.ts
│
├─ prompt/
│  ├─ sharedPromptCompiler.ts
│  └─ requirementProjection.ts
│
├─ scenario/
│  ├─ outlineSourceAdapter.ts
│  ├─ continuationSourceAdapter.ts
│  ├─ outlineRequirements.ts
│  ├─ continuationRequirements.ts
│  ├─ outlinePolicy.ts
│  └─ continuationPolicy.ts
│
├─ validators/
│  ├─ semanticApply.ts
│  ├─ canon.ts
│  ├─ continuity.ts
│  └─ finalArtifact.ts
│
└─ persistence/
   ├─ outlineDurableAdapter.ts
   └─ continuationDurableAdapter.ts
```

Scenario 层负责：

```text
What must be written / checked
```

Shared Writer Core 负责：

```text
How every writing stage is actually executed
```

这是最终必须守住的边界。

---

# 21. 最终一句验收原则

> **不要验收“名字”，要验收“生产调用图”；不要验收“Facade”，要验收“实际 Writer 实现”；不要验收“Stage 有几个函数”，要验收“真正写正文的实现到底有几套”。**

只有当答案是：

```text
1 套
```

才算最终收束完成。
