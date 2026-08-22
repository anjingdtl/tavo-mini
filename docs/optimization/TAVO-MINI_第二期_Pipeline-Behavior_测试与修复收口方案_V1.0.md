# TAVO-MINI 第二期流水线行为一致性测试＋修复收口方案 V1.0

**项目：** TAVO-MINI / ShineWriter  
**方案定位：** Phase 2 最终封板前的“真实流水线行为一致性（Behavior Conformance）＋异常修复闭环”  
**本地唯一施工基线：** `F:\ClaudeWorkSpace\projects\TAVO-MINI`  
**当前远端 main：** `0148c4a25145e1876d9387bd936d5f3d8e5910b0`  
**当前生产代码 HEAD：** `2ab07dd7a2b2d85588d2735528ad438181294b67`  
**当前版本：** `V2.11.54`  
**日期：** 2026-08-21

---

# 0. 本方案为什么存在

第二期已经完成 ONE QA、Proof Removal、Revision Trigger、Compact Ledger、QA Structured Admission、Generation Stability 等关键收束，但“代码具备能力”与“真实生产流水线每次都按设计运行”不是一回事。

本轮最终目标不是只看：

```text
任务 completed
章节有正文
CI 全绿
```

而是证明：

> 用户发起写作后，从 Source Adapter、ONE Context、Freeze、Draft、ONE QA、条件 Revision、FinalValidate、Persist、PostWriting 到 ONE Memory，每一条真实生产路径都严格按照设计拓扑运行；若实际行为偏离设计，Agent 必须继续修复，直到“设计 DAG = 实际 DAG”。

因此本方案的验收对象是：

```text
PIPELINE BEHAVIOR
```

而不是单纯：

```text
OUTPUT SUCCESS
```

---

# 1. 当前权威设计拓扑

## 1.1 Standard

Outline 与 Continuation 必须共享同一条 Post-Freeze Standard Pipeline：

```text
Writing Request
    ↓
Source Adapter
    ↓
ONE Context
    ↓
Freeze
    ↓
Draft
    ↓
ONE QA
    ↓
QA verdict / findings
    │
    ├── Clean
    │      ↓
    │   Revision = SKIP
    │
    └── Executable Finding
           ↓
       Revision ×1
           ↓
      ONE Final Candidate
           ↓
   Local FinalValidate
           ↓
        Persist
           ↓
 WritingPersistedEvent
           ↓
 PostWriting / ONE Memory
```

唯一允许的场景差异：

```text
Outline Source Adapter
Continuation Source Adapter
Frozen Requirements
Frozen Policy
Validator Plugin
PostWriting Plugin
```

Post-Freeze 不允许出现：

```text
Outline Pipeline
Continuation Pipeline
Outline QA
Continuation QA
scenario-specific writer
scenario-specific prompt compiler
scenario-specific final candidate
```

---

## 1.2 One-Shot / 极速

One-Shot 必须使用同一个 Kernel / Context / Freeze，只减少付费 AI Stage：

```text
Source Adapter
→ ONE Context
→ Freeze
→ Draft ×1
→ QA = formal skip
→ Revision = formal skip
→ Local FinalValidate
→ Persist
→ PostWriting / ONE Memory
```

硬要求：

```text
Draft logical call = 1
QA = 0
Revision = 0
Review = 0
Audit = 0
FactCheck = 0
Proof = 0
Formatter = 0
Primary Retry = 0
```

One-Shot 不是第二条流水线。

---

# 2. 最核心验收原则

## 2.1 “生成成功”不等于 PASS

以下情况即使章节最终有正文，也必须判 NO-GO：

```text
QA 没跑
QA 多跑
Revision 应跑但没跑
Revision 不应跑却跑了
旧 Review/Audit/FactCheck/Proof 偷跑
Formatter 未计入调用
Protocol Fallback 未计入
Resume 重复 Draft/QA
FinalValidate 校验 Draft 但 Persist 保存 Revision
Persist 完成但 WritingPersistedEvent 丢失
PostWriting 没执行
Story Memory 没更新
Freeze 后重新读取 live config / live source
Compact 任务生成 Legacy fake ledger rows
```

---

## 2.2 每个样本必须生成“设计 DAG vs 实际 DAG”

示例：

```text
Expected:
Freeze
→ Draft
→ QA
→ Revision(SKIP)
→ FinalValidate
→ Persist
→ PostWriting

Actual:
Freeze
→ Draft
→ QA
→ Revision(SKIP)
→ FinalValidate
→ Persist
→ PostWriting

RESULT: MATCH
```

若：

```text
Actual:
Freeze
→ Draft
→ QA
→ Proof
→ Persist
```

即使正文保存成功：

```text
RESULT: PIPELINE DIVERGENCE / NO-GO
```

---

# 3. 生产流水线不可破坏的 12 条 Invariant

## INV-01 — ONE Production Entry

所有用户写作入口最终必须进入同一个 Production Writing Kernel。

禁止：

```text
Outline 专用 Writer Core
Continuation 专用 Writer Core
旧 V5 快速路由绕过 Kernel
```

## INV-02 — ONE Context

所有正文生成 Stage 只能消费同一个 Frozen Context 的 stage projection。

不得出现：

```text
Draft 一个 Context Builder
QA 再 build 一次
Revision 再读 live DB
```

## INV-03 — Freeze 唯一且稳定

每章必须只有一个权威 Freeze：

```text
freezeFingerprint
requirementsFingerprint
pipelineTopologyVersion
executionProfile
frozenModelConfig
stageReasoning
```

Post-Freeze：

```text
Freeze Drift = 0
Live Behavior Config Read = 0
```

允许仅通过 `credentialRef` 读取凭证。

## INV-04 — Draft Exactly Once

新任务正常路径：

```text
Draft logical call = 1
```

Resume：

```text
Draft 已成功
→ 不得再次付费调用 Draft
```

## INV-05 — ONE QA Exactly Once

Standard：

```text
QA logical call = 1
```

禁止：

```text
Review + QA
QA + FactCheck
QA1 + QA2
隐藏 Judge
```

如果 Primary QA 结构非法：

```text
Formatter <= 1
```

但必须记录：

```text
logical QA = 1
formatter = 1
physical QA requests = 2
```

不能把它伪装成一次 HTTP。

## INV-06 — QA Structured Admission

Compact QA 合法输出必须：

```text
verdict = pass | needs_revision
findings = []
或 executable findings
```

Needs-Revision finding 必须：

```text
severity = blocking | warning
issue 非空
target 或 requirementIds 可定位
instruction 或 target 可执行
```

非法 Primary：

```text
→ Formatter <=1
→ strict revalidate
→ 仍非法则 fail-closed
```

禁止从普通自然语言正文用正则自动制造 blocking finding。

## INV-07 — Revision 只能条件执行

Clean：

```text
QA pass
findings=[]
→ Revision = 0
```

Needs Revision：

```text
QA needs_revision
+ executable finding
→ Revision = 1
```

禁止：

```text
generic suggestion → Revision
info → Revision
pass + finding → Revision
Revision 重复两次
```

## INV-08 — Legacy AI Stage 新生产调用必须为 0

新 Compact Standard：

```text
Review = 0
Audit = 0
FactCheck = 0
Proof = 0
```

Legacy Resume 可保留历史拓扑，但必须由 Frozen Topology 明确识别。

## INV-09 — ONE Final Candidate

```text
Revision completed
→ Final Candidate = Revision

Revision skipped
→ Final Candidate = Draft
```

FinalValidate 和 Persist 必须消费同一个 Candidate。

不得：

```text
FinalValidate 校验 Draft
Persist 保存 Revision
```

## INV-10 — Local Tail 不允许偷偷 LLM

```text
FinalValidate = local
Persist = local
```

不得新增：

```text
post-revision validator LLM
final judge
proof 2.0
AI quality gate
```

## INV-11 — Compact Ledger 必须是真实调用图

Continuation Compact 新任务只允许真实节点：

```text
draft_writer
unified_qa
revision_writer
final_validate
```

不得预建：

```text
narrative_architect
adversarial_auditor
final_reviser
```

的 queued/0 假行。

## INV-12 — Persist 后链路必须完整

正文保存后：

```text
Persist
→ WritingPersistedEvent
→ PostWriting
→ Continuity State / Story Memory
```

不得出现正文已保存但 Memory/State 静默失败。

---

# 4. 三层测试证据体系

本轮必须同时使用：

```text
Layer A — Deterministic Production-Path Test
Layer B — Android Full-Flow Test
Layer C — Real LLM Test
```

三层解决不同问题，任何一层都不能替代其它层。

---

# 5. Layer A — Deterministic Production-Path 行为契约

目的：不依赖真实模型随机性，确定性验证每个 DAG 分支。

必须穿透真实 Kernel / Stage Runner / Durable Adapter / Final Candidate / Persist 生产代码，不允许只测纯函数。

## A1 — Standard Clean

输入：

```text
Draft valid
QA = pass + []
```

Expected：

```text
Draft 1
QA 1
Revision 0
FinalValidate 1 local
Persist 1 local
Review/Audit/FactCheck/Proof 0
```

## A2 — Standard Needs Revision

输入：

```text
QA = needs_revision + blocking executable finding
```

Expected：

```text
Draft 1
QA 1
Revision 1
FinalValidate 1
Persist 1
```

## A3 — QA Invalid → Formatter → Valid

输入：

```text
Primary QA = content-only / invalid
Formatter = valid needs_revision
```

Expected：

```text
Logical QA = 1
Formatter = 1
Physical QA Requests = 2
Revision = 1
```

## A4 — QA Invalid → Formatter Invalid

Expected：

```text
QA persistence = 0
Revision = 0
Pipeline = fail-closed
error = SHARED_WRITER_INVALID_REPORT
```

## A5 — One-Shot

Expected：

```text
Draft 1
QA 0
Revision 0
Formatter 0
old stages 0
FinalValidate/Persist local
```

## A6 — Legacy Resume

历史 topology 仅验证：

```text
历史 Stage 可恢复
不被强制迁移成 Compact
已付费 Stage 不重复
```

---

# 6. Layer B — Android 真实 App Full-Flow

必须使用：

```text
npm run apk:debug
adb install -r
```

禁止：

```text
adb uninstall
pm clear
```

目的：验证

```text
UI
→ Store
→ DB
→ Kernel
→ Stage DAG
→ Ledger
→ Persist
→ UI Final
```

是同一条真实链路。

---

# 7. Android 行为矩阵

## Outline

至少覆盖：

```text
极速 / One-Shot
低
中
高
```

低/中/高必须拓扑相同，只允许模型、reasoning、QA strictness、context richness 等策略差异。

禁止：

```text
低 = 少 Stage
高 = 多 Stage
```

## Continuation

如果当前 UI 仍使用：

```text
loose / balanced / strict / custom
```

就按当前实际配置测试。

原则仍是：

> 不同质量/严格度配置只能改变 Policy / Model / Context Projection，不得改变 Standard 核心拓扑。

---

# 8. Layer C — Real LLM 最终行为样本

最终真实在线模型必须运行：

```text
Outline Standard ×2
Continuation Standard ×2
Outline One-Shot ×1
Continuation One-Shot ×1
```

即：

```text
2 + 2 + 1 + 1
```

这 6 章用于证明：

```text
Provider integration
真实 responseFormat
真实 reasoning behavior
真实 Formatter
真实 Token
真实 physical call
真实 fallback/retry
真实 Persist/PostWriting
```

---

# 9. Real LLM 分支规则

至少有真实 Clean：

```text
QA pass
Revision = 0
```

优先取得真实 Needs-Revision：

```text
QA needs_revision
Revision = 1
```

如果 6 章内自然没有 Needs-Revision：

```text
不得无限刷章节
```

此时：

- Layer A 的 A2/A3 作为分支正确性硬证据；
- Real LLM 仍必须完成 2+2+1+1；
- 报告记录真实 6 章实际 branch 分布；
- 禁止人工篡改 QA。

---

# 10. 每章必须采集 Pipeline Trace Evidence

## Identity

```text
repositoryHead
productionCodeHead
appVersion
projectId
chapterId
taskId / runId
generationTraceId
scenario
```

## Freeze

```text
freezeFingerprint
requirementsFingerprint
pipelineTopologyVersion
executionProfile
modelName
reasoningTier
```

## Actual DAG

```text
stage
status
attempt
start
end
skipReason
policyRuleId
```

## LLM Calls

```text
logicalStageCallCount
formatterCallCount
physicalRequestCount
protocolFallbackCount
primaryRetryCount
```

## Token

```text
inputTokens
outputTokens
totalTokens
cacheHit
cacheMiss
```

## Durable

```text
stage ledger rows
pipeline checkpoints
final candidate source
persisted chapter hash
```

## PostWriting

```text
WritingPersistedEvent
outbox
continuity state
story memory
ready gate
```

---

# 11. 设计 DAG vs 实际 DAG 自动对照

建议新增只读诊断脚本，例如：

```text
scripts/inspect-writing-run.*
```

输入：

```text
taskId / runId
```

输出：

```text
Expected DAG
Actual DAG
Diff
Paid Calls
Physical Calls
Ledger
Final Candidate
PostWriting
Verdict
```

示例：

```text
EXPECTED:
freeze
draft
qa
revision(skip)
finalValidate
persist
postWriting

ACTUAL:
freeze
draft
qa
revision(skip)
finalValidate
persist
postWriting

DAG_MATCH=true
```

异常：

```text
DAG_MATCH=false
EXTRA_STAGE=proof
MISSING_STAGE=finalValidate
```

脚本只允许读取证据，不得修改数据库。

---

# 12. Resume / Crash Matrix

## R1 — Draft 成功后 Crash

恢复：

```text
Draft 不重复
QA 从下一 Stage 开始
```

## R2 — QA 成功后 Crash

Clean：

```text
QA 不重复
Revision 仍 skip
```

Needs Revision：

```text
QA 不重复
Revision 正确执行 1 次
```

重点防止 QA artifact preload 丢失导致 Revision 错跳。

## R3 — Revision 成功后 Crash

```text
Revision 不重复
Final Candidate = durable Revision
FinalValidate → Persist
```

## R4 — Persist 前 Crash

```text
Paid LLM duplicate = 0
FinalValidate/Persist 幂等继续
```

## R5 — Persist 后、PostWriting 前 Crash

```text
正文不重复写
LLM 不重复
WritingPersistedEvent/outbox 继续
Memory 最终一致
```

---

# 13. Pipeline Divergence 分类与排查方向

## D1 — Missing Stage

例如 Standard QA=0。

查：

```text
topology freeze
action mapping
stage driver
skip rules
profile leakage
resume checkpoint
```

## D2 — Extra Stage

例如 Proof>0、Review>0。

查：

```text
legacy topology leakage
old action mapping
old V5 route
fake ledger coupling
```

## D3 — Wrong Conditional Branch

例如：

```text
QA pass → Revision=1
needs_revision executable → Revision=0
```

查：

```text
QA admission
findingsAggregator
revision trigger
durable QA preload
verdict normalization
```

## D4 — Duplicate Paid Call

查：

```text
checkpoint persistence
UPSERT clobber
loadExisting
resume state
crash recovery
```

## D5 — Hidden Physical Call

例如 UI 显示 QA1，但实际 QA+Formatter=2。

查：

```text
observability
usage ledger
formatter accounting
protocol fallback
retry accounting
```

## D6 — Final Candidate Divergence

查：

```text
finalCandidate
durable metadata
revision artifact hydration
persist candidate source
```

## D7 — Persist / PostWriting Break

查：

```text
WritingPersistedEvent
outbox
extract_state priority
ready gate
cold-start interrupted rows
```

## D8 — Freeze Drift / Live Read

查：

```text
post-Freeze getSettings
live source read
live reasoning config
model config reconstruction
```

---

# 14. 修复纪律

一旦发现任何 Pipeline Divergence：

```text
STOP CURRENT SEAL
```

不得继续用更多成功样本稀释失败。

严格执行：

```text
Baseline
↓
Root Cause
↓
Red Test
↓
Minimal Fix
↓
Focused Green
↓
Relevant Regression
↓
Full Verify
↓
Android
↓
重跑受影响行为矩阵
```

---

# 15. Minimal Fix 边界

除非 Red Test 证明必要，否则禁止触碰：

```text
ONE Writer Core
ONE Prompt Compiler
ONE Context
ONE Memory
One-Shot architecture
Final Candidate Contract
Topology Version mechanism
```

禁止：

```text
顺手重构
顺手改 Prompt
顺手加 Stage
顺手改数据库 Schema
```

---

# 16. 禁止“为了让测试过”改变产品语义

禁止：

```text
自动伪造 QA finding
把 warning 全升 blocking
QA 非法时默认 pass
QA 非法时默认 revise
失败后偷偷走旧 Review
增加 second QA
增加 Judge
增加 Proof
放宽 Structured Contract
```

修复必须同时守住：

```text
Quality Contract
Call Budget
ONE Pipeline
```

---

# 17. 付费调用硬 Gate

## Standard Clean

```text
Draft logical = 1
QA logical = 1
Revision = 0
Review/Audit/FactCheck/Proof = 0
logical paid <= 2
```

若 QA Primary 结构非法：

```text
formatter may = 1
physical count 必须如实增加
```

## Standard Needs Revision

```text
Draft = 1
QA = 1
Revision = 1
logical paid <= 3
```

## One-Shot

```text
Draft = 1
all other paid stages = 0
formatter = 0
retry = 0
```

---

# 18. Token 验收

不设固定 Token cap。

已有弹性 Context Budget 继续为权威。

重点确认：

```text
没有重复 Context Builder
QA 没堆 Review/Audit/FactCheck 三份报告
Revision 只消费 Draft + executable findings + relevant requirements
Clean 没有 Revision token
One-Shot 没额外检查 token
```

每章记录：

```text
Draft input/output
QA input/output
Formatter input/output
Revision input/output
Total
```

---

# 19. UI 与数据库一致性

UI：

```text
生成
检查
修订
校验
保存
```

必须与 Ledger / Trace 对应。

Revision skip 时必须有正式 skip 语义或当前 Compact 等价表达。

禁止新 Compact UI 继续呈现：

```text
润色 V3
叙事架构 A1
对抗审阅
```

Legacy 历史任务除外。

---

# 20. 自动化 Contract 建议

建议新增：

```text
writingPipelineBehaviorConformance.test.ts
writingPipelineActualDagContract.test.ts
writingPipelineResumeNoDuplicatePaidCall.test.ts
writingPipelinePostWritingClosure.test.ts
```

核心不是增加测试数量，而是锁：

```text
Expected DAG == Actual DAG
```

最终纳入 Generation Stability。

---

# 21. 分阶段施工路线

## Phase C0 — Exact Baseline

记录：

```text
origin/main
production SHA
version
git status
```

运行：

```text
npm run verify
```

## Phase C1 — Deterministic DAG Conformance

完成：

```text
A1 Clean
A2 Needs Revision
A3 QA Formatter Recovery
A4 QA Fail Closed
A5 One-Shot
A6 Legacy Resume
```

每个 Case：

```text
Expected DAG == Actual DAG
```

失败即进入 Fix Loop，禁止进入 C2。

## Phase C2 — Resume / Crash Conformance

执行 R1-R5。

Gate：

```text
Duplicate Paid Call = 0
Freeze Drift = 0
Final Candidate Drift = 0
Memory Drift = 0
```

## Phase C3 — Android Full-Flow

Debug APK + `adb install -r`，运行 Outline / Continuation 各档位。

重点验：

```text
UI → Store → Kernel → DAG → Ledger → Persist → UI Final
```

## Phase C4 — Real LLM 2+2+1+1

```text
Outline Standard 2
Continuation Standard 2
Outline One-Shot 1
Continuation One-Shot 1
```

每章输出完整 Pipeline Trace Evidence。

任何 DAG Divergence：

```text
立即 NO-GO
进入 Fix Loop
```

## Phase C5 — Final Full Regression

同一 Production SHA：

```text
npm run verify
Generation Stability
Migration
Android Debug
```

远端：

```text
Verify SUCCESS
Generation Stability SUCCESS
```

---

# 22. Fix Loop

任何 C1-C4 失败：

```text
Divergence ID
↓
Root Cause
↓
Red Test
↓
Minimal Fix
↓
Focused Green
↓
Full Verify
↓
Android Build
↓
重跑该 Case
↓
重跑 C4 受影响真实样本
```

只要 Production SHA 改变：

> 旧 SHA 的 Final Live Evidence 自动失效，必须重新绑定新 SHA。

---

# 23. 最终证据报告

生成：

```text
docs/optimization/TAVO-MINI_第二期_Pipeline-Behavior_Final-Seal_验收报告_20260821.md
```

必须包含：

```text
finalRepositoryHead
finalProductionCodeHead
ciValidatedHead
androidValidatedHead
realLlmValidatedHead
```

每章必须列：

```text
Expected DAG
Actual DAG
DAG_MATCH
Logical Calls
Formatter Calls
Physical Calls
Fallback
Retry
Ledger Rows
Final Candidate Source
FinalValidate Hash
Persisted Hash
PostWriting
Memory
```

---

# 24. Final GO Gate

只有同时满足：

```text
C1 Deterministic DAG = PASS
C2 Resume/Crash = PASS
C3 Android Full Flow = PASS
C4 Real LLM 2+2+1+1 = PASS
C5 Full Regression/CI = PASS
```

并且：

```text
Pipeline Divergence = 0
Unexpected LLM Stage = 0
Duplicate Paid Call = 0
Hidden Physical Call = 0
Freeze Drift = 0
Final Candidate Drift = 0
False Applied = 0
Fatal Context Loss = 0
PostWriting Break = 0
Memory Drift = 0
```

才能宣布：

```text
PHASE 2 PIPELINE BEHAVIOR FINAL SEALED / GO
```

否则只能：

```text
PHASE 2 PIPELINE BEHAVIOR NO-GO
```

---

# 25. 推荐 Commit 边界

如果完全无 Bug：

```text
test(writing): lock final pipeline behavior conformance
docs(optimization): seal phase-two pipeline behavior
```

如果发现 Bug：

```text
test(writing): reproduce <exact divergence>
fix(writing): <minimal root-cause fix>
```

修复后重新封板。

---

# 26. Agent 执行纪律

- 以 `F:\ClaudeWorkSpace\projects\TAVO-MINI` 为唯一施工基线；
- 开始前 `fetch origin main`；
- 先验收 DAG，不以“章节成功”作为结论；
- 每个样本必须保存 Expected/Actual DAG；
- 发现偏离立即停止封板并进入 Fix Loop；
- 不允许用更多成功样本覆盖失败；
- 不允许为了测试通过增加新的 LLM Stage；
- 不允许破坏 Legacy Resume；
- 不允许清 App 数据；
- Android 只允许 `adb install -r`；
- 必须分别统计 Logical / Formatter / Physical / Fallback / Retry；
- 必须验证 Final Candidate → FinalValidate → Persist 是同一正文；
- 必须验证 Persist → PostWriting → ONE Memory；
- Production SHA 改变后，旧 live evidence 自动失效；
- 未达到全部 GO Gate，不得写 `FINAL SEALED / GO`。

---

# 27. 最终目标

这轮真正要证明的不是：

```text
“软件能写出一章小说”
```

而是：

```text
用户发起写作
↓
正确 Source Adapter
↓
ONE Context
↓
稳定 Freeze
↓
Draft exactly once
↓
ONE QA exactly once
↓
正确 Conditional Revision
↓
ONE Final Candidate
↓
Local FinalValidate
↓
Persist
↓
PostWriting
↓
ONE Memory
```

并且在：

```text
正常运行
Crash
Resume
Clean
Needs Revision
One-Shot
Outline
Continuation
```

所有路径中都成立。

> **只有“设计流水线 = 真实流水线”，第二期才算真正封板。**
