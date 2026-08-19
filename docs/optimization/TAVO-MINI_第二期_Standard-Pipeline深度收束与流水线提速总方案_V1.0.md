# TAVO-MINI 第二期 Standard Pipeline 深度收束与流水线提速总方案 V1.0

**项目：** TAVO-MINI / ShineWriter  
**阶段：** 第二期流程治理 + 流水线提速  
**目标对象：** Standard Production Writing Pipeline  
**当前前提：** ONE Pipeline / ONE Context / ONE Memory / ONE Flow 已 FINAL SEALED / GO  
**本期性质：** 在不破坏一期封板架构的前提下，继续减少默认 Standard 的 LLM API 次数、自动检验环节、正文级重复生成与 Token 消耗  
**核心原则：** 只允许删除、合并、条件化；禁止新增新的自动 LLM Stage

## 最终目标拓扑

```text
Source Adapter
     ↓
ONE Context
     ↓
Freeze
     ↓
Draft                  LLM ×1
     ↓
ONE QA                 LLM ×1
     ↓
需要 Revision？
  ┌──┴──┐
 NO    YES
 │      ↓
 │   Revision           LLM ×1
 │      │
 └──┬───┘
    ↓
Local FinalValidate
    ↓
Persist
    ↓
ONE Flow / PostWriting
```

目标调用：

```text
正常 Standard：2 次逻辑 LLM
有明确问题：3 次逻辑 LLM
One-Shot：1 次正文逻辑 LLM（保持封板不变）
```

---

# 0. 二期总目标

一期已经完成：

```text
ONE Pipeline
ONE Context
ONE Memory
ONE Flow
```

二期不再治理“有没有第二套架构”，而是治理：

> **同一套 Standard Pipeline 内部仍然存在过多自动 LLM Stage。**

当前 Standard 主路径仍包含历史阶段：

```text
Draft
↓
Review / Audit / FactCheck
↓
Conditional Revision
↓
Proof
↓
FinalValidate
↓
Persist
```

二期最终必须收束为：

```text
Draft
↓
ONE QA
↓
Conditional Revision
↓
Local FinalValidate
↓
Persist
```

其中：

- `Review`
- `Audit`
- `FactCheck`
- `Proof`

全部退出 **新 Standard Production DAG**。

它们可以保留为：

```text
Legacy Resume Compatibility
Deprecated Capability
Historical Artifact Reader
```

但不得继续出现在新 Standard 生产调用图。

---

# 1. 二期架构红线

## 1.1 禁止新增自动 LLM Stage

禁止出现：

```text
ResidualCheck
FinalQA
SecondQA
PostRevisionQA
Proof2
RiskJudge LLM
```

允许新增：

```text
Local Validator
Local Deterministic Classifier
Local Contract Mapper
Local Compatibility Adapter
```

但必须：

```text
0 LLM
0 paid API
```

## 1.2 ONE Pipeline 不得再次分叉

生产 DAG 中禁止：

```text
OutlineStandardPipeline
ContinuationStandardPipeline
```

禁止：

```ts
if (scenario === 'outline') {
  runOutlineQA()
} else {
  runContinuationQA()
}
```

正确方式：

```text
ONE runQaStage()
+
Frozen Requirements
+
Frozen QA Policy
+
Deterministic Context Projection
```

场景差异只能存在：

```text
Source Adapter
Requirements
Frozen Policy
Context Candidates
```

不能存在：

```text
第二套 QA Writer
第二套 QA Prompt Compiler
第二套 Pipeline Driver
```

## 1.3 一期封板区冻结

默认禁止修改：

```text
ONE Production Writing Entry
ONE Writing Kernel
ONE Shared Writer Core
ONE Shared Prompt Compiler architecture
ONE Context Planner
allocateWritingContextBudget
Elastic / Hierarchical Budget mathematics
ONE Story Memory architecture
WritingPersistedEvent contract
One-Shot execution profile
Canon / Boundary / Seam authority model
Post-Freeze source truth contract
```

只有 Red Test 证明二期必须修改时才允许最小变更。

## 1.4 禁止新增固定 Token 上限

不能为了提速加入：

```text
Standard Context <= 50K
QA Context <= 20K
Draft Context <= 80K
```

继续继承：

```text
model contextWindow
reservedOutputTokens
safetyMargin
soft / burst / hard envelope
mandatory / preferred / optional
dynamic allocation
```

二期 Token 优化必须来自：

```text
减少 Stage
减少重复 Context
减少检查 Stage 输出
减少 Formatter 常态化
```

而不是强行砍有效上下文。

---

# 2. 二期统一 PDCA 协议

每个 Phase 都必须严格执行：

```text
P — PLAN
Baseline
Root Cause
Impact Boundary
Red Tests
Expected Call Graph

D — DO
Minimal Change
No Opportunistic Refactor
Independent Commit

C — CHECK
Focused Tests
Architecture Gates
Full Regression
Android Build
Required E2E

A — ACT
GO / NO-GO
Evidence Report
Freeze Phase Result
```

每个 Phase 必须形成：

```text
docs/optimization/
TAVO-MINI_Phase2_<PhaseName>_验收报告_<date>.md
```

上一 Phase：

```text
NO-GO
```

则禁止进入下一 Phase。

---

# 3. Phase 0 — 第二期 Baseline 与调用成本固化

## 3.1 目的

本阶段：

```text
只观察
不改变生产行为
```

必须先把当前 Standard 的真实调用、Token、关键路径固定下来。

## 3.2 Baseline 采集对象

至少：

```text
Outline Source Adapter → Standard 2 章
Continuation Source Adapter → Standard 2 章
One-Shot 回归 1+1（只验证未受影响）
```

这里不是建立两条流水线 Baseline，而是同一个 Standard Pipeline 在两个 Source Adapter 输入下的行为样本。

## 3.3 必须记录

每章：

```text
generationTraceId
freezeFingerprint
pipelineTopologyVersion
executionProfile

logicalStageCallCount
formatterCallCount
physicalRequestCount
protocolFallbackCount

draftInputTokens
draftOutputTokens
reviewInputTokens
reviewOutputTokens
auditInputTokens
auditOutputTokens
factCheckInputTokens
factCheckOutputTokens
revisionInputTokens
revisionOutputTokens
proofInputTokens
proofOutputTokens

chapterE2EMs
stageExecutionMs
stageDependencyWaitMs
stagePersistMs

Revision triggered/skipped
Proof call count
Resume duplicate paid call
```

## 3.4 必须输出 Current Production Call Graph

必须从真实代码生成：

```text
New Standard
Legacy Resume
One-Shot
Batch
Single Chapter
```

分别确认实际节点。

## 3.5 Phase 0 GO Gate

```text
Baseline 数据可读取
Logical / Formatter / Physical / Fallback 四口径可区分
Stage Token 可按章聚合
Stage latency 可按章聚合
Current DAG 明确
One-Shot 基线仍为 1-call
Full Jest = PASS
Typecheck = PASS
Lint = PASS
```

未满足不得进入 Phase 1。

---

# 4. Phase 1 — Final Candidate Contract 收束

## 4.1 为什么 Phase 1 必须最先做

删除 Proof 前，系统必须先明确：

> **没有 Proof 时，谁是最终正文？**

目标：

```text
Revision exists
→ Revision is Final Candidate

Revision absent
→ Draft is Final Candidate
```

不能再依赖 `Proof Artifact` 来承担最终正文与 Requirement Metadata 的隐式桥接。

## 4.2 当前风险

现有 FinalValidate 虽能：

```text
proof.body
→ revision.body
→ draft.body
```

选择正文，但部分最终 metadata 仍主要来自：

```text
proof
revision
```

如果：

```text
Draft
→ QA PASS
→ Revision SKIP
→ Proof removed
```

则可能发生：

```text
finalBody 正确
但
appliedRequirementIds 丢失
structured 丢失
validNoOpRequirementIds 丢失
```

最终导致：

```text
Semantic Apply false fail
Requirement Result 漂移
```

## 4.3 建立 ONE Final Candidate Contract

建议统一接口：

```ts
interface FinalWritingCandidate {
  sourceStage: 'draft' | 'revision'
  body: string
  structured?: unknown
  appliedRequirementIds: string[]
  validNoOpRequirementIds?: string[]
  validNoOpReasons?: Record<string, string>
}
```

实际命名按代码风格调整。

必须由纯本地函数：

```text
resolveFinalWritingCandidate()
```

确定：

```text
revision
↓
draft
```

不读取 live DB。

## 4.4 FinalValidate 必须只消费 Final Candidate

目标：

```text
Artifacts
↓
resolveFinalWritingCandidate()
↓
FinalValidate
↓
Persist
```

不能再：

```text
FinalValidate 自己拼 proof/revision/draft 多套优先级
Persist 再自己拼一遍
```

否则仍有双真相。

## 4.5 Persist 也必须消费同一最终结果

最终：

```text
Final Candidate
↓
FinalValidate Artifact
↓
Persist FinalValidate.body
```

新 Standard 下：

```text
Persist 不再读取 proof
```

Legacy Resume 可在 compatibility adapter 中映射。

## 4.6 Phase 1 Red Tests

### Case 1
```text
Draft only
Revision absent
Proof absent
```

→ FinalValidate PASS

### Case 2
Draft 有：

```text
appliedRequirementIds
validNoOpRequirementIds
```

→ FinalValidate 必须完整继承

### Case 3
Revision exists

→ Revision 覆盖 Draft 成为 Final Candidate

### Case 4
Revision body 空

→ fail-closed，不能偷偷 fallback 到 Draft 伪装 Revision 成功

### Case 5
Final Candidate body 空

→ `FINAL_BODY_MISSING`

### Case 6
Semantic Apply failed

→ 不得 Persist

## 4.7 Phase 1 GO Gate

```text
Final Candidate Truth = 1
Draft-only final path = PASS
Revision final path = PASS
Requirement metadata preserved
Semantic Apply unchanged
Persist consumes validated candidate
Proof dependency in new final contract = 0
Post-Freeze live read = 0
Full Jest = PASS
Generation Stability = PASS
Android Debug = PASS
```

完成后独立 Commit：

```text
refactor(writing): establish proof-independent final candidate contract
```

只有 Phase 1 GO 后才能进入 Phase 2。

---

# 5. Phase 2 — Pipeline Topology Version + Resume Contract

## 5.1 目的

本阶段不是减少 Stage，而是确保：

> **未来删除 Stage 后，历史已经冻结的任务仍可按旧拓扑安全 Resume。**

## 5.2 新增冻结的 Topology Version

建议：

```text
pipelineTopologyVersion
```

例如：

```text
1 = legacy_standard
2 = compact_standard
```

或其他符合现有 version contract 的命名。

必须：

```text
task creation Freeze once
batch creation Freeze once
all child chapters inherit batch topology
Resume never re-read live default
```

## 5.3 新旧任务行为

### 历史任务

```text
legacy topology
Draft
Review/Audit/FactCheck
Revision
Proof
FinalValidate
Persist
```

Resume 必须保持。

### 新任务

Phase 2 暂时可以仍走现有 Stage，但已经冻结：

```text
compact_standard
```

为后续 Phase 3/4 切 DAG 做准备。

## 5.4 ONE Pipeline 的正确解释

正确是：

```text
ONE Orchestrator
+
Frozen Topology Version
```

而不是：

```text
所有历史任务强制升级 DAG
```

## 5.5 Resume Contract

必须保证：

```text
Freeze fingerprint byte-identical
Succeeded stage artifact reused
Succeeded paid stage not recalled
Failed stage only rerun when allowed
```

## 5.6 Phase 2 Red Tests

### Case 1
Legacy：

```text
Draft succeeded
Review succeeded
Proof failed
```

升级后 Resume：

```text
Draft call = 0
Review call = 0
旧 Proof 按旧 topology Resume
```

### Case 2
新 topology：

```text
Draft succeeded
QA future checkpoint fixture succeeded
Crash
```

Resume：

```text
Draft = 0
QA = 0
```

先建立 durable semantics fixture，即使 QA 生产 Stage Phase 4 才上线。

### Case 3
Batch：

```text
chapter 1 compact
chapter 2 compact
```

整个 batch topology 一致。

### Case 4
用户升级 APP 后修改默认档位

旧任务 Resume 不变。

### Case 5
Frozen topology field corrupt

→ fail-closed，不得猜当前默认。

## 5.7 Phase 2 GO Gate

```text
Topology frozen per task = YES
Topology frozen per batch = YES
Legacy Resume = PASS
New topology durable contract = PASS
Resume Duplicate Paid Call = 0
Freeze Drift = 0
No live topology read post-Freeze
Migration idempotent
Backup/manifest updated if schema changed
Full Jest = PASS
Migration = PASS
Android upgrade install = PASS
```

独立 Commit：

```text
feat(writing): freeze compact-standard pipeline topology for new tasks
```

Phase 2 GO 后才能进入 Phase 3。

---

# 6. Phase 3 — Proof 从新 Standard Production Path 删除

## 6.1 核心目标

不是：

```text
Proof = skipped
```

而是：

```text
New Compact Standard DAG
不包含 Proof 节点
```

## 6.2 新 DAG 第一阶段

暂时仍保留旧 QA stages：

```text
Draft
↓
Review / Audit / FactCheck
↓
Conditional Revision
↓
FinalValidate
↓
Persist
```

此阶段只做一件事：

> **彻底移除新 Standard 自动 Proof。**

这样一次只改一个变量。

## 6.3 为什么先单独删除 Proof

Proof 是：

- 串行关键路径尾部；
- 正文级输出；
- Token 高；
- 用户等待明显；
- 删除后不需要先解决 QA 合并。

先单独验证：

```text
没有 Proof
是否质量/FinalValidate/Persist/Resume 均稳定
```

## 6.4 Legacy Proof 保留

禁止删除：

```text
runProofStage
proof historical artifacts
proof checkpoint readers
legacy resume
```

此 Phase 只保证：

```text
pipelineTopologyVersion=compact
→ Stage DAG 无 proof
```

## 6.5 Phase 3 Red Tests

### Case 1
新 Standard：

```text
proof dispatch count = 0
proof physical request = 0
proof ledger row = 0
```

### Case 2
Legacy task：

仍能 Resume Proof。

### Case 3
Revision absent：

Draft → FinalValidate → Persist

### Case 4
Revision present：

Revision → FinalValidate → Persist

### Case 5
Crash after Revision before FinalValidate

Resume：

```text
Draft = 0
Review/Audit/FactCheck = 0
Revision = 0
```

只继续 Local FinalValidate/Persist。

### Case 6
One-Shot

行为不变。

## 6.6 Phase 3 真实 LLM 验收

同一个新 Compact Standard：

```text
Outline Source Adapter 2 章
Continuation Source Adapter 2 章
```

重点：

```text
Proof Calls = 0
正文成功 Persist
FinalValidate PASS
Story Memory / Continuity 后处理正常
```

不做大样本统计。

## 6.7 Phase 3 GO Gate

```text
New Standard Proof Stage Count = 0
New Standard Proof Logical Calls = 0
New Standard Proof Physical Calls = 0
Legacy Proof Resume = PASS
Draft-only final = PASS
Revision final = PASS
Semantic Apply = PASS
Resume Duplicate Paid Call = 0
Outline source 2/2
Continuation source 2/2
Full Jest = PASS
Generation Stability = PASS
Android Debug = PASS
```

独立 Commit：

```text
refactor(writing): remove proof from compact standard production topology
```

---

# 7. Phase 4 — Review / Audit / FactCheck 合并为 ONE QA

## 7.1 目标

把：

```text
Review
Audit
FactCheck
```

合并为：

```text
QA
```

生产实现必须只有一个。

## 7.2 ONE QA 的定义

唯一：

```text
runQaStage()
```

唯一：

```text
compileSharedWritingPrompt('qa')
```

唯一：

```text
executeSharedWriterStage(stage='qa')
```

唯一 QA Artifact Contract。

## 7.3 场景差异不能变成不同实现

### Outline Source Adapter 提供

Frozen Requirements 可能包括：

```text
outline obligation
plot requirement
character rule
world rule
user instruction
style
story memory constraints
```

### Continuation Source Adapter 提供

Frozen Requirements 可能包括：

```text
Canon
Boundary
Seam
Anchor
Continuity State
Knowledge Boundary
user instruction
```

但：

```text
QA Stage = same
QA compiler = same
QA writer = same
```

## 7.4 Unified QA Contract

建议极简：

```json
{
  "verdict": "pass | revise",
  "findings": [
    {
      "severity": "blocking | warning",
      "target": "...",
      "issue": "...",
      "instruction": "...",
      "requirementIds": []
    }
  ]
}
```

禁止长篇：

```text
优点分析
写作点评
大段思维过程
长篇总结
```

## 7.5 Revision 触发规则

必须：

```text
verdict = revise
AND
存在 executable finding
```

才触发 Revision。

以下不得触发：

```text
“可以更生动”
“建议加强”
“总体不错”
“略显平淡”
info finding
```

避免：

```text
QA 为了显得有用
→ 每章都输出小建议
→ Revision 固定变成第三次 API
```

## 7.6 QA Context Projection

不得把：

```text
Review Context
+
Audit Context
+
FactCheck Context
```

简单拼接。

必须从 ONE Frozen Context：

```text
deterministic projection
```

生成一次 QA Context。

目标：

```text
去重
权限/事实优先
只保留检查当前 Draft 必要的信息
```

## 7.7 QA 模型行为必须 Freeze

必须在 Freeze 中确定：

```text
qaThinking
qaReasoningEffort
qaResponseFormat
qaOutputContract
qaModelConfig
```

禁止：

```text
runQaStage() 内动态判断 DeepSeek
runQaStage() 内读取 live setting
runQaStage() 内按 scenario 重新选模型
```

## 7.8 Formatter 风险

历史 Shared Writer Formatter 能力保留。

但 QA 必须设 Gate：

```text
正常 first-pass QA adoptability 高
Formatter 只能异常使用
```

禁止把：

```text
QA Primary + Formatter
```

变成事实上的默认双调用。

## 7.9 新 Production DAG

本 Phase 结束后：

```text
Draft
↓
QA
↓
Conditional Revision
↓
FinalValidate
↓
Persist
```

新 Standard 中：

```text
Review dispatch = 0
Audit dispatch = 0
FactCheck dispatch = 0
Proof dispatch = 0
```

## 7.10 Phase 4 Red Tests

### Architecture

```text
Production QA implementation = 1
Outline QA implementation = 0
Continuation QA implementation = 0
```

### Call Graph

```text
compact standard:
Draft
QA
Revision?
FinalValidate
Persist
```

### Resume

```text
Draft succeeded
QA succeeded
Crash
Resume
→ Draft call = 0
→ QA call = 0
```

### Legacy

旧 Review/Audit/FactCheck artifact Resume 可继续。

### Freeze

QA 配置 post-Freeze live read = 0。

### Output

`pass + []` 可直接进入 FinalValidate。

### Failure

reasoning-only / malformed：

按 Shared Writer recovery 合同处理，不能无限重试。

## 7.11 Phase 4 真实 LLM 验收

```text
Outline Source Adapter 2 章
Continuation Source Adapter 2 章
```

每章记录：

```text
Draft logical calls
QA logical calls
Formatter calls
Physical requests
Revision trigger
```

目标：

```text
Review/Audit/FactCheck = 0
ONE QA = 1
```

## 7.12 Phase 4 GO Gate

```text
Production QA implementation = 1
Production QA logical stage = 1
Outline/Continuation production QA branch = 0

Review Production Dispatch = 0
Audit Production Dispatch = 0
FactCheck Production Dispatch = 0
Proof Production Dispatch = 0

Normal Standard Logical Calls <= 2
QA formatter not default path
Physical calls observable

Resume Duplicate Paid Call = 0
Freeze Drift = 0
Semantic Apply PASS

Outline 2/2
Continuation 2/2
Full Jest PASS
Generation Stability PASS
Android Debug PASS
```

独立 Commit：

```text
refactor(writing): consolidate compact standard checks into one qa stage
```

---

# 8. Phase 5 — Revision Trigger、API 次数与 Token 成本治理

## 8.1 Phase 5 才开始做 Token 微调

此前 Phase 的优先级：

```text
先砍调用
再砍 Token
```

本阶段目标：

> 保证 2-call Standard 成为正常情况，而不是理论情况。

## 8.2 Revision Trigger 治理

目标：

```text
QA pass
→ Revision 0

QA revise + executable blocking/warning
→ Revision 1
```

不得：

```text
info finding
style suggestion
generic improvement
```

自动触发 Revision。

## 8.3 QA 输出 Token 治理

QA 是检查 Stage，不是写文章。

目标：

```text
max useful output
=
verdict + concise findings
```

QA Prompt 必须要求：

```text
无问题 → 极短 JSON
有问题 → 只列可执行问题
```

## 8.4 QA 输入 Token 治理

不得固定 cap。

但必须测：

```text
qaProjectedContextTokens
duplicateContextTokens
qaInputTokens
```

对比一期：

```text
Review + Audit/FactCheck 累计 Input
vs
Unified QA Input
```

必须显著下降或至少不恶化。

## 8.5 Revision Context

Revision 只需要：

```text
Draft
QA Findings
Relevant Requirements
必要 Canon / Style projection
```

禁止再次注入：

```text
完整 QA 长报告
完整 Frozen Context
旧 Review/Audit/FactCheck artifacts
```

## 8.6 Physical Request Gate

正式区分：

```text
Logical Call
Formatter Call
Physical HTTP
Protocol Fallback
```

### Normal Clean Chapter

```text
logical = 2
formatter = 0
physical = 2（理想）
```

允许 provider 协议异常时 `physical > 2`，但必须诊断，不能隐藏。

### Revision Chapter

```text
logical = 3
formatter = 0 ideally
physical = 3 ideally
```

## 8.7 Phase 5 Red Tests

### Case 1

QA：

```json
{"verdict":"pass","findings":[]}
```

→ Revision = 0

### Case 2

只有 info finding

→ Revision = 0

### Case 3

blocking executable finding

→ Revision = 1

### Case 4

Revision success

→ 不再执行 QA2 / Proof

### Case 5

QA malformed

→ 最多一次既有 Formatter

### Case 6

QA formatter 仍失败

→ fail-closed，禁止 primary replay loop。

## 8.8 Phase 5 GO Gate

```text
Clean Standard Logical Calls <= 2
Revision Standard Logical Calls <= 3
Proof calls = 0
Legacy QA stage production calls = 0

QA output compact
QA input duplication reduced
Revision input excludes stacked old reports

Formatter Rate observable
Protocol Fallback observable
No hidden auto retry loop

Full Jest PASS
Generation Stability PASS
Android Debug PASS
```

---

# 9. Phase 6 — Batch / Single / Resume / UI / Ledger 全链路收束

## 9.1 目的

防止后端 DAG 已经变成：

```text
Draft → QA → Revision? → FinalValidate → Persist
```

但：

```text
UI
Batch
Ledger
Trace
Progress
Result Page
Resume
```

仍然写死：

```text
reviewing
auditing
factchecking
proofing
```

## 9.2 全链路 Stage Name Audit

必须扫描：

```text
review
audit
factCheck
proof
brief
proofing
reviewing
factchecking
```

分类：

```text
Legacy compatibility
New production
UI copy
Test fixture
Migration
Historical report
```

新 Production 不得再依赖旧 Stage。

## 9.3 UI 新状态

建议用户看到：

```text
正在生成
正在检查
正在修订
正在校验
正在保存
```

避免内部复杂实现暴露。

## 9.4 Durable Ledger

新 Standard：

```text
draft
qa
revision (optional)
finalValidate
persist
```

不存在 fake skipped legacy rows。

Legacy Resume 仍支持旧 ledger。

## 9.5 Batch

多章连续：

```text
chapter N Persist
↓
PostWriting Ready
↓
chapter N+1 Freeze
```

不得因 QA 合并破坏：

```text
Resume Duplicate Paid = 0
Story Memory readiness
Continuation State readiness
```

## 9.6 Phase 6 GO Gate

```text
Single Chapter = PASS
Batch = PASS
Resume = PASS
Cold Start = PASS
UI status = PASS
Ledger = PASS
Trace = PASS

New Standard fake legacy skip rows = 0
New Standard old stage UI state = 0
Resume Duplicate Paid Call = 0
Story Memory regression = 0
Continuation State regression = 0
```

独立 Commit：

```text
refactor(writing): align batch ui ledger and resume with compact standard topology
```

---

# 10. Phase 7 — 第二期真实 LLM 穿测与最终封板

## 10.1 真实 LLM 样本

不做长测大样本。

### Standard

同一个 Compact Standard：

```text
Outline Source Adapter 2 章
Continuation Source Adapter 2 章
```

### One-Shot Regression

```text
Outline One-Shot 1 章
Continuation One-Shot 1 章
```

总计：

```text
6 章
```

足够发现流程问题。

## 10.2 Standard 核心验收

每章记录：

```text
generationTraceId
freezeFingerprint
sourceAdapter
executionProfile
pipelineTopologyVersion

logicalStageCallCount
formatterCallCount
physicalRequestCount
protocolFallbackCount

Draft calls
QA calls
Revision calls

inputTokens
outputTokens
chapterE2EMs

FinalValidate
Persist
PostWriting
Resume duplicate paid
```

## 10.3 封板目标

### Clean Standard

```text
Draft = 1
QA = 1
Revision = 0
Proof = 0
Review = 0
Audit = 0
FactCheck = 0
```

### Revision Standard

```text
Draft = 1
QA = 1
Revision = 1
其他付费 Stage = 0
```

### One-Shot

```text
Draft = 1
QA = 0
Revision = 0
```

## 10.4 不要求统计显著性

2 章样本不得声称：

```text
P50 改善 XX%
P95 改善 XX%
成本下降 XX%
```

可以陈述：

```text
Before 单章实际调用
After 单章实际调用
```

以及：

```text
Call Graph 已结构性减少
```

---

# 11. 第二期最终硬 Gate

只有全部满足才允许：

```text
PHASE 2 FINAL SEALED / GO
```

## Architecture

```text
ONE Production Entry = 1
ONE Writing Kernel = 1
ONE Shared Writer Core = 1
ONE Shared Prompt Compiler = 1
ONE QA implementation = 1
ONE Final Candidate Truth = 1

Second Pipeline = 0
Second QA Writer = 0
Second Context Builder = 0
Second Long-Term Memory = 0
```

## New Standard DAG

```text
Draft
QA
Conditional Revision
FinalValidate
Persist
```

严格：

```text
New Standard Review = 0
New Standard Audit = 0
New Standard FactCheck = 0
New Standard Proof = 0
```

## API

```text
Clean Standard logical paid calls <= 2
Standard with Revision logical paid calls <= 3
One-Shot正文 paid calls <= 1
Resume Duplicate Paid Call = 0
```

## Freeze

```text
Topology Frozen = YES
QA Policy Frozen = YES
QA Model Behavior Frozen = YES
Post-Freeze Live Read = 0
Freeze Drift = 0
```

## Legacy

```text
Legacy Resume = PASS
Legacy artifacts readable
Legacy topology not auto-upgraded
```

## Context

```text
New hard input token cap = 0
Final Context Budget Decision = 1
QA deterministic projection = YES
Duplicate QA context materially lower
```

## Quality

```text
Semantic Apply = PASS
FinalValidate = PASS
Canon Regression = 0
Memory Drift = 0
Fatal Context Loss = 0
False Applied Requirement = 0
```

## Regression

```text
Full Jest = PASS
Lint = PASS
Typecheck = PASS
Migration = PASS
Generation Stability = PASS
Verify = PASS
Android Debug Build = PASS
```

## Real LLM

```text
Outline Source Standard 2/2
Continuation Source Standard 2/2
One-Shot Regression 2/2
```

---

# 12. Phase 串行准入机制

必须严格：

```text
Phase 0 GO
↓
Phase 1

Phase 1 GO
↓
Phase 2

Phase 2 GO
↓
Phase 3

Phase 3 GO
↓
Phase 4

Phase 4 GO
↓
Phase 5

Phase 5 GO
↓
Phase 6

Phase 6 GO
↓
Phase 7

Phase 7 GO
↓
PHASE 2 FINAL SEALED / GO
```

任何 Phase：

```text
NO-GO
```

则：

```text
停留当前 Phase
↓
Root Cause
↓
Red Test
↓
Minimal Fix
↓
重新验收
```

禁止：

```text
带病进入下一 Phase
```

---

# 13. 每 Phase Commit 原则

每 Phase 独立 commit。

推荐：

```text
Phase 0
test(writing): baseline standard pipeline cost and call graph

Phase 1
refactor(writing): establish proof-independent final candidate contract

Phase 2
feat(writing): freeze compact-standard pipeline topology for new tasks

Phase 3
refactor(writing): remove proof from compact standard production topology

Phase 4
refactor(writing): consolidate compact standard checks into one qa stage

Phase 5
perf(writing): tighten qa revision triggers and stage token costs

Phase 6
refactor(writing): align batch ui ledger and resume with compact standard topology

Phase 7
docs(optimization): seal phase-two compact standard pipeline
```

不要一个 commit 混多个 Phase。

---

# 14. 历史踩坑专项回归矩阵

二期最终必须重新验证以下历史坑没有复发。

## H1 Shared Writer Recovery

```text
reasoning-only
structured adopt
Formatter at most one
```

不得因删除旧 Stage 误删。

## H2 Frozen Thinking

特别是 DeepSeek：

```text
QA JSON Contract
thinking behavior frozen
```

## H3 Frozen Envelope Corruption

```text
parse failure
→ fail-closed
→ 0 LLM
```

## H4 Resume Frozen Context Preservation

```text
no NULL overwrite
no live refreeze
```

## H5 Duplicate Paid Calls

```text
Draft success → crash → no Draft recall
QA success → crash → no QA recall
Revision success → crash → no Revision recall
```

## H6 Legacy Topology

老 task 不被 Compact Standard 接管。

## H7 Skip Semantics

新 Compact Standard 不用 fake skipped legacy Stage 冒充收束。

## H8 Provider Physical Calls

逻辑 2-call 不得被统计掩盖成：

```text
Formatter
Protocol Fallback
Retry
```

## H9 Android SQLite

任何新 SQL：

```text
禁止依赖 UPDATE ... LIMIT
禁止 SELECT * 巨大 JSON
```

## H10 CursorWindow

新 QA / artifact 元数据读取：

```text
不得 materialize 大型 Frozen Context JSON
```

## H11 Cold Start

running / interrupted 状态恢复正常。

## H12 UI Same Task Completion

同一 task：

```text
failed → resume → completed
```

UI 必须重新感知 completed。

---

# 15. 二期最终产品语义

用户不应该理解成：

```text
极速 = 1 次
标准 = 5 次
```

二期以后：

```text
One-Shot
写一次
→ 直接本地校验保存

Standard
写一次
→ 查一次
→ 有问题才改一次
```

产品语义：

> **Standard 不是“更多流水线”，而是“比极速多一次质量检查，并且仅在确有问题时多一次修订”。**

---

# 16. 二期最终目标状态

```text
                 ONE WRITING SYSTEM

                    Source Adapter
                         ↓
                    ONE Context
                         ↓
                       Freeze
                         ↓
                Pipeline Topology
                         ↓
        ┌────────────────────────────┐
        │ Compact Standard           │
        │                            │
        │ Draft      LLM ×1          │
        │   ↓                        │
        │ QA         LLM ×1          │
        │   ↓                        │
        │ Revision   LLM ×0/1        │
        │   ↓                        │
        │ FinalValidate Local        │
        │   ↓                        │
        │ Persist Local              │
        └────────────────────────────┘
                         ↓
                 WritingPersistedEvent
                         ↓
                    ONE Memory
```

Legacy：

```text
只承担历史 Frozen Task Resume
不承担新 Standard Production
```

One-Shot：

```text
保持一期封板：
Draft ×1
FinalValidate
Persist
```

---

# 17. 最终原则

> **二期不是给流水线继续加能力，而是继续做减法。**

> **先保证最终正文合同稳定，再冻结新拓扑，再删 Proof，再合并 QA，再治理 Revision / Token。**

> **每一个 Phase 必须独立 PDCA、独立验收、独立 GO；未 GO 禁止进入下一阶段。**

> **最终新 Standard 只允许：写一次、查一次、有问题才改一次。**

> **场景差异只存在于 Source / Requirements / Policy，不允许重新演化成 Outline / Continuation 两条生产流水线。**

> **任何为了提速而破坏 Freeze、Resume、Semantic Apply、Canon、ONE Context、ONE Memory 的做法都属于 NO-GO。**
