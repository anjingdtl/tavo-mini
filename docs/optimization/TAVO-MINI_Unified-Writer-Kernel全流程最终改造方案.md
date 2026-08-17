# TAVO-MINI Unified Writer Kernel 全流程最终改造方案

> 文档定位：Writing Kernel Ultimate Convergence / Final Shared Writer Core  
> 执行对象：本地 Agent  
> 本地仓执行基线：`F:\ClaudeWorkSpace\projects\TAVO-MINI`  
> 最终目标：**ONE Production Writing Kernel + ONE Shared Writer Stage Implementation**  
> 数据兼容：YES  
> 旧执行兼容：NO  
> 最终真实 LLM 验收：Outline 3 章 + Continuation 3 章  
> 收口判定：只有“共享 Writer Stage 真正唯一”才允许 FINAL SEALED

---

# 0. 本轮为什么必须继续改

上一轮收口已经完成了大量正确工作：

- 单一 `runWritingKernel()`；
- 单一 Production Writing Entry；
- 旧 `runChapterPipeline()` Production Caller 清零；
- 旧 `startContinuationRun()` Production Caller 清零；
- 单一权威 Freeze；
- 旧 Continuation Context Builder / Budget 原位置退为 shim；
- Semantic Apply 硬门禁；
- Generation Stability；
- Continuation 两轮真实 LLM 实测与恢复验证。

但当前架构仍然停留在：

```text
ONE Kernel Scheduler
+
TWO Post-Freeze Writer Implementations
```

当前本质结构仍然近似：

```text
                    runWritingKernel()
                           │
             ┌─────────────┴─────────────┐
             │                           │
      OutlineStageDriver        ContinuationStageDriver
             │                           │
    pipeline/reconcile        continuationV5StageMachine
             │                           │
   Outline Draft/Review/...   Continuation Draft/Architect/
                              Revision/Auditor/Final Reviser
```

因此：

> **统一了“调度权”，还没有统一“写作执行权”。**

本轮最终目标必须从：

```text
ONE Kernel Scheduler
```

升级为：

```text
ONE Kernel Scheduler
+
ONE Shared Writer Core
+
ONE Shared Stage Set
```

---

# 1. 最终架构定义

## 1.1 最终唯一调用链

```text
Outline Source Adapter ──────┐
                             │
Continuation Source Adapter ─┤
                             ▼
                      WritingRequest
                             ↓
                  Unified Source Contract
                             ↓
            Collect → Normalize → Plan
                             ↓
                Allocate → Render → Freeze
                             ↓
                 ONE FrozenWritingContext
                             ↓
                  ONE Writer Kernel
                             ↓
                       Draft
                             ↓
                    Review / Audit
                             ↓
                     Fact Check
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

# 2. 最严格的架构原则

## 2.1 Freeze 前允许 Scenario 差异

允许：

```text
outlineWritingAdapter
continuationWritingAdapter
outline source policy
continuation source policy
Canon
Boundary
Seam
Anchor
Style
Story Memory
Outline
Character
Worldbook
Note
```

这些都属于：

```text
Source / Requirement / Policy
```

## 2.2 Freeze 后禁止拥有第二套 Writer Core

Freeze 后禁止存在：

```text
Outline Writer Core
Continuation Writer Core
Continuation V5 Stage Machine
Outline reconcile writer pipeline
```

作为完整执行核心。

最终必须只有：

```text
sharedDraftStage
sharedReviewStage
sharedAuditStage
sharedFactCheckStage
sharedRevisionStage
sharedProofStage
sharedFinalValidateStage
sharedPersistStage
```

---

# 3. 最终目录目标

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
│  ├─ writingArtifact.ts
│  └─ writingResult.ts
│
├─ scenario/
│  ├─ outlineWritingAdapter.ts
│  ├─ continuationWritingAdapter.ts
│  ├─ outlinePolicy.ts
│  └─ continuationPolicy.ts
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
│  ├─ audit.ts
│  ├─ factCheck.ts
│  ├─ revision.ts
│  ├─ proof.ts
│  ├─ semanticApply.ts
│  ├─ finalValidate.ts
│  ├─ persist.ts
│  └─ postWritingUpdate.ts
│
├─ prompt/
│  ├─ buildDraftPrompt.ts
│  ├─ buildReviewPrompt.ts
│  ├─ buildAuditPrompt.ts
│  ├─ buildRevisionPrompt.ts
│  ├─ buildProofPrompt.ts
│  └─ buildFinalPrompt.ts
│
├─ execution/
│  ├─ writingStageRunner.ts
│  └─ writingKernelDriver.ts
│
├─ trace/
│  └─ writingTrace.ts
│
├─ replay/
│  └─ writingReplay.ts
│
├─ persist/
│  └─ writingPersistence.ts
│
├─ productionWritingEntry.ts
└─ unifiedWritingKernel.ts
```

---

# 4. 本轮核心改造目标

## P0-1：真正共享 Draft

Outline 与 Continuation 最终必须调用同一个：

```ts
runDraftStage()
```

输入只能是：

```ts
FrozenWritingContext
WritingStagePolicy
PreviousArtifacts
```

禁止：

```text
OutlineDraftRunner
ContinuationDraftWriter
Continuation V5 Draft Writer
```

继续作为完整独立实现。

## P0-2：真正共享 Review / Audit

最终必须使用：

```ts
runReviewStage()
runAuditStage()
```

Continuation 原有：

```text
Adversarial Auditor
Canon checks
Seam checks
Style checks
Obligations
```

必须转成：

```text
Review Requirement
Audit Requirement
Validation Rule
```

不能继续因为 Continuation 场景而拥有独立 Auditor pipeline。

## P0-3：真正共享 Revision

最终统一：

```ts
runRevisionStage()
```

Continuation V5 的：

```text
Revision Writer
Final Reviser
```

不能继续构成独立 Writer Core。

其优秀能力必须拆成：

```text
Revision Requirement
Applied Obligation
Canon Correction
Style Correction
Protected Passage
Semantic Apply Contract
```

传入共享 Revision。

## P0-4：真正共享 Proof / Finalize

最终统一：

```ts
runProofStage()
runFinalValidateStage()
runPersistStage()
```

Continuation 的 Final Artifact Validator 可以继续存在为：

```text
shared validator plugin
```

但不得继续绑定一个独立 Continuation Final Reviser Runner。

---

# 5. Shared Writer Stage Contract

## 5.1 统一输入

```ts
interface WritingStageInput {
  frozenContext: FrozenWritingContext;
  artifacts: WritingStageArtifacts;
  stagePolicy: WritingStagePolicy;
  requirements: WritingRequirements;
  modelConfig: FrozenStageModelConfig;
  trace: WritingKernelTrace;
}
```

## 5.2 统一输出

```ts
interface WritingStageResult<TArtifact> {
  status: 'completed' | 'blocked' | 'failed';
  artifact?: TArtifact;
  diagnostics: WritingDiagnostics[];
  usage?: WritingUsage;
  requirementResult?: WritingRequirementResult;
}
```

---

# 6. 统一 Requirement Model

这是本轮最关键的抽象。

不要再通过：

```text
scenario === continuation
```

决定 Writer 怎么写。

改为所有场景都使用统一 Requirement。

```ts
interface WritingRequirement {
  id: string;
  kind:
    | 'outline'
    | 'canon'
    | 'boundary'
    | 'seam'
    | 'anchor'
    | 'style'
    | 'character'
    | 'world-rule'
    | 'plot'
    | 'length'
    | 'protected-passage'
    | 'user-instruction'
    | 'fact'
    | 'continuity';

  severity:
    | 'mandatory'
    | 'blocking'
    | 'preferred'
    | 'advisory';

  text: string;
  sourceCandidateId?: string;

  validation:
    | 'semantic'
    | 'literal'
    | 'hash'
    | 'structured'
    | 'local-only';
}
```

Outline 可以拥有：

```text
outline goals
chapter synopsis
character continuity
world rules
style
story memory
```

Continuation 可以拥有：

```text
canon facts
boundary
seam
anchor
style
continuity
obligations
```

但进入 Writer Stage 后全部统一为：

```text
WritingRequirement[]
```

---

# 7. 统一 Prompt Compiler

当前 Continuation V5 Prompt Compiler 仍然是独立体系。

本轮必须拆掉完整场景 Prompt Compiler。

最终改为：

```text
Shared Prompt Template
+
Rendered Frozen Context
+
Writing Requirements
+
Stage Policy
+
Previous Artifact
```

例如：

```ts
buildDraftPrompt({
  frozenContext,
  requirements,
  policy
})
```

而不是继续以：

```ts
compileContinuationV5DraftWriterMessages()
```

作为生产唯一实现。

---

# 8. Continuation V5 能力怎么保留

不能简单删除 V5 成熟能力。

必须“拆能力，不保留完整核心”。

保留：

- Architecture planning；
- Canon hard constraints；
- Seam continuity；
- Anchor continuity；
- Style requirements；
- Edit Work Packet；
- Obligations；
- Semantic Apply；
- Hash binding；
- Final Artifact Validator；
- no-op validation。

但全部改为：

```text
Shared Writing Kernel Capability
```

例如：

```text
ArchitecturePlanningPlugin
CanonRequirementProvider
SeamRequirementProvider
StyleRequirementProvider
SemanticApplyValidator
FinalArtifactValidator
```

禁止：

```text
ContinuationV5StageMachine
```

继续执行完整 Draft→Revision→Audit→Final Reviser。

---

# 9. Outline 旧 reconcile 怎么处理

当前 Outline 的：

```text
pipeline/reconcile
executeAction
determineNextPipelineAction
```

仍然实际拥有 Draft / Review / FactCheck / Proof。

本轮不能继续让其成为 Writer Core。

## 保留

```text
checkpoint
retry
lock
foreground
task state
budget gate
cancel
resume
```

这些属于：

```text
Durable Orchestration
```

## 迁出

```text
run draft
run review
run fact check
run brief/revision
run proof
finalize
```

这些必须迁入：

```text
writing/stages/*
```

---

# 10. Continuation Stage Machine 怎么处理

当前：

```text
writing/execution/continuationV5StageMachine.ts
```

必须最终退场。

拆分方式：

```text
runRound1 Draft
→ shared draft stage

Narrative Architect
→ planning plugin / optional parallel planning capability

runRound2 Revision
→ shared revision stage

Adversarial Auditor
→ shared audit stage

Final Reviser
→ shared revision/final stage

Final Validator
→ shared final validator
```

最终：

```text
ContinuationV5StageMachine Production Caller = 0
```

然后删除或移动到：

```text
legacy/
```

---

# 11. Writer Stage Runner

新增唯一执行器：

```ts
runWritingStages()
```

建议：

```text
Draft
↓
Review + Audit + FactCheck
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

# 12. Stage Policy 而不是 Scenario Pipeline

允许不同场景拥有不同：

```text
WritingStagePolicy
```

例如：

```ts
{
  draft: {
    architecturePlanning: true
  },
  audit: {
    canonStrictness: 'hard',
    seamStrictness: 'hard'
  },
  revision: {
    semanticApplyRequired: true
  }
}
```

这是合法的。

禁止：

```text
Continuation gets another writer pipeline
```

---

# 13. Model 配置也必须共享结构

Continuation 当前拥有大量：

```text
FrozenContinuationModelConfig
```

最终应升级为：

```ts
FrozenStageModelConfig
```

统一支持：

```text
draft
review
audit
factCheck
revision
proof
final
```

场景只决定：

```text
选择哪个 config
```

不能决定：

```text
使用哪个执行核心
```

---

# 14. Persist 必须彻底统一

最终只允许：

```ts
runPersistStage()
```

Outline / Continuation 的差异通过：

```text
PersistencePolicy
PostWritingUpdatePlugin
```

表达。

---

# 15. Post Writing Update

允许场景差异存在于：

```text
写完以后
```

Outline：

```text
Story Memory Update
Chapter Summary
Project Memory
```

Continuation：

```text
Continuation State Extraction
State Proposal
Outbox
Story Memory rebuild
```

这些必须是：

```text
PostWritingUpdatePlugin
```

不是第二 Writer Core。

---

# 16. 最终必须清零的 Production Core

最终以下模块不得继续作为生产写作核心：

```text
pipelineRunner full writer path
pipeline/reconcile writer execution path

continuationV5StageMachine
continuationV5Runner
continuationGenerationRunner
continuationV4Runner

Continuation complete prompt compiler
Continuation independent final reviser runner
```

可以保留：

```text
legacy/
compat/
migration/
tests/
```

---

# 17. 新架构自动门禁

当前 Call Graph 测试只能检查：

```text
旧 symbol caller = 0
```

不够。

必须新增：

```text
Writer Core Count Gate
```

## G-W1：Shared Draft Implementation = 1

```text
Draft LLM stage implementation count = 1
```

## G-W2：Shared Review Implementation = 1

```text
Review/Audit stage implementation count = shared set
```

## G-W3：Shared Revision Implementation = 1

```text
Revision writer implementation = 1
```

## G-W4：Shared Finalize Implementation = 1

```text
Proof/Final Validate/Persist production implementation = 1
```

## G-W5：Continuation V5 Stage Machine caller = 0

## G-W6：Outline reconcile writer execution = 0

reconcile 只能负责：

```text
orchestration
checkpoint
retry
state
```

## G-W7：Post-Freeze LLM caller surface = shared only

所有真正：

```text
callLLM
callLLMResult
```

的 Writer Stage 生产调用必须经过：

```text
writing/stages
writing/prompt
writing/execution shared runner
```

---

# 18. PDCA 总原则

本轮必须严格 PDCA。

每一个 Work Package：

```text
P — Plan
D — Do
C — Check
A — Act
```

禁止：

```text
一次性大迁移
→ 最后才测试
```

---

# 19. PDCA-0：Baseline

## Plan

记录：

```text
HEAD
git status
现有 full Jest
Generation Stability
现有架构调用图
```

## Do

运行：

```text
lint
typecheck
full Jest
Generation Stability
```

## Check

输出：

```text
当前 Writer Core Count
当前 Draft implementation Count
当前 Revision implementation Count
```

## Act

生成：

```text
PDCA-0 Baseline Record
```

---

# 20. PDCA-1：Unified Requirement Model

## Plan

把：

```text
Outline requirement
Canon
Boundary
Seam
Anchor
Style
Obligation
```

统一。

## Do

新增：

```text
WritingRequirement
WritingRequirementSet
WritingRequirementResult
```

## Check

测试：

```text
Outline requirement rendering
Continuation requirement rendering
mandatory preservation
deterministic fingerprint
```

## Act

不改实际 Writer，只先建立 contract。

---

# 21. PDCA-2：Shared Draft

## Plan

抽取 Outline Draft 与 Continuation Draft 共性。

## Do

建立：

```text
writing/stages/draft.ts
writing/prompt/buildDraftPrompt.ts
```

Continuation 架构规划如果需要，作为：

```text
Draft Planning Plugin
```

## Check

至少：

```text
Outline Golden Draft
Continuation Golden Draft
```

对比迁移前输出契约。

## Act

让两个场景都真正调用：

```text
runDraftStage()
```

---

# 22. PDCA-3：Shared Review / Audit

## Plan

合并：

```text
Outline Review
Outline FactCheck
Continuation Auditor
Canon Audit
Seam Audit
Style Audit
```

## Do

建立：

```text
runReviewStage()
runAuditStage()
runFactCheckStage()
```

## Check

必须验证：

```text
Canon violation blocks
Seam break blocks
Outline conflict detected
Style violation detected
```

## Act

移除 Continuation 独立 Auditor production path。

---

# 23. PDCA-4：Shared Revision

## Plan

合并：

```text
Outline brief/revision
Continuation Revision Writer
Continuation Final Reviser
```

## Do

建立：

```text
runRevisionStage()
```

统一 obligation lifecycle：

```text
identified
→ accepted
→ applied | waived | already_satisfied
→ verified
```

## Check

验证：

```text
False Applied Requirement = 0
Semantic Apply hard gate
VALID_NO_OP
hash binding
```

## Act

Continuation Final Reviser 不再是独立 writer core。

---

# 24. PDCA-5：Shared Proof / Final Validate

## Plan

统一：

```text
Proof
Final Artifact Validator
Semantic Apply
Final contract
```

## Do

建立：

```text
runProofStage()
runFinalValidateStage()
```

## Check

验证：

```text
body empty
hash mismatch
semantic apply
canon contradiction
seam break
length severe
```

## Act

所有场景统一 final gate。

---

# 25. PDCA-6：Shared Persist

## Plan

统一 Outline / Continuation 正文持久化。

## Do

建立：

```text
runPersistStage()
```

## Check

验证：

```text
transaction
body hash
trace binding
adoption
retry
no duplicate persist
```

## Act

Continuation adoption 转为 Persistence Policy / plugin。

---

# 26. PDCA-7：Shared Stage Runner

## Plan

建立唯一：

```text
runWritingStages()
```

## Do

Kernel Freeze 后只调用它。

## Check

Production Call Graph：

```text
Outline → same stage runner
Continuation → same stage runner
```

## Act

删除：

```text
Outline full writer action path
ContinuationV5StageMachine production path
```

---

# 27. PDCA-8：Legacy Disconnect

## Plan

确保：

```text
Old Writer Core Caller = 0
```

## Do

移动到：

```text
legacy/
```

或者删除。

## Check

静态测试：

```text
ContinuationV5StageMachine caller = 0
pipeline/reconcile writer execution caller = 0
```

## Act

加入 CI。

---

# 28. PDCA-9：Regression / Replay

必须复跑：

```text
Golden
Replay x10
Semantic Apply
Freeze
Resume
Batch
Story Memory
Canon
Boundary
Seam
Anchor
64K
128K
1M
```

要求：

```text
Fingerprint Drift = 0
Decision Drift = 0
Silent Context Loss = 0
```

---

# 29. PDCA-10：真实 LLM 设备验收

本轮最终实测缩减为：

```text
Outline 3 章
Continuation 3 章
```

总计：

```text
6 章
```

但必须是：

```text
最新代码
最新 Debug APK
真实 LLM
模拟器
```

---

# 30. APK 升级要求

必须：

```bash
adb install -r latest-debug.apk
```

不得：

```text
uninstall
clear data
```

检查：

```text
Provider
Model
API Key ref
Endpoint
context window
max output
reasoning/thinking
Story Memory
Preset
Continuation source
Canon
```

全部保留。

---

# 31. Outline 3章测试

连续：

```text
O-01
O-02
O-03
```

逐章检查：

```text
Source
Requirement Set
Freeze
Shared Draft
Shared Review
Shared FactCheck/Audit
Shared Revision
Shared Proof
Shared Final Validate
Shared Persist
Story Memory
Trace
Fingerprint
```

硬要求：

```text
shared stage implementation = YES
old Outline writer core caller = 0
```

---

# 32. Continuation 3章测试

连续：

```text
C-01
C-02
C-03
```

逐章检查：

```text
Canon
Boundary
Seam
Anchor
Style
Requirement Set
Freeze
Shared Draft
Shared Audit
Shared Revision
Shared Proof
Shared Final Validate
Shared Persist
State Extraction
Story Memory
Trace
Fingerprint
```

硬要求：

```text
ContinuationV5StageMachine production caller = 0
Continuation independent Writer Core = 0
```

---

# 33. 最终指标

必须全部为：

```text
Production Writing Kernel Count = 1

Shared Draft Implementation = 1
Shared Review Implementation = 1
Shared Audit Implementation = 1
Shared FactCheck Implementation = 1
Shared Revision Implementation = 1
Shared Proof Implementation = 1
Shared Final Validate Implementation = 1
Shared Persist Implementation = 1

Continuation V5 Writer Core Production Caller = 0
Outline Old Writer Core Production Caller = 0

Authoritative Freeze Count = 1

Fatal = 0
Silent Context Loss = 0
Unexpected Live Read = 0
Fingerprint Drift = 0
False Applied Requirement = 0
Duplicate Paid Stage = 0
```

---

# 34. 最终 GO / NO-GO

只有以下全部通过才允许 GO：

```text
G1 One Kernel
G2 One Shared Draft
G3 One Shared Review/Audit
G4 One Shared Revision
G5 One Shared Proof/Final
G6 One Shared Persist
G7 Old Outline Writer Core = 0
G8 Continuation V5 Writer Core = 0
G9 One Freeze
G10 Replay x10
G11 Generation Stability
G12 Full Jest
G13 adb install -r
G14 Outline 3/3 real LLM
G15 Continuation 3/3 real LLM
```

否则：

```text
NO-GO
```

---

# 35. 最终定义

真正完成时，系统必须满足：

```text
Outline 和 Continuation 不是两条 Writer Pipeline。

它们只是两个 Source / Requirement Policy。

Freeze 后：
两者进入同一个 Draft，
同一个 Review，
同一个 Audit，
同一个 FactCheck，
同一个 Revision，
同一个 Proof，
同一个 Final Validate，
同一个 Persist。

Continuation 的 Canon / Seam / Anchor / Style / Obligation
只是 Shared Writer Stage 的结构化约束。

不存在独立 Continuation Writer Core。
不存在独立 Outline Writer Core。
```

---

# 36. Agent 最终执行口令

```text
本轮不要继续优化“一个 Kernel 调度两个 Driver”。

真正目标是：

ONE Kernel
+
ONE Shared Writer Stage Set

你必须把 Outline 与 Continuation Freeze 后的 Draft / Review / Audit /
FactCheck / Revision / Proof / Final Validate / Persist 真正收敛到同一套
生产实现。

ContinuationV5StageMachine 不能只是换目录，必须退出 Production。

pipeline/reconcile 可以继续负责 durable orchestration，但不能继续拥有
Outline Writer Stage。

Canon、Boundary、Seam、Anchor、Style、Obligation 等续写能力必须变成
WritingRequirement / WritingPolicy / Validator / Plugin 输入共享 Stage。

全过程严格 PDCA：
Plan → Red Test → Minimal Change → Green → Regression → Commit。

最终构建 Debug APK，adb install -r 保数据升级，真实 LLM：
Outline 连续 3 章，
Continuation 连续 3 章。

只有 Shared Writer Core 真正唯一，并且 3+3 全绿，才允许 FINAL SEALED。
```
