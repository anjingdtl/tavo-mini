# TAVO-MINI 第二期工程建设方案 V2.0（基于远端实际进度接续版）

**项目：** TAVO-MINI / ShineWriter  
**仓库：** `anjingdtl/tavo-mini`  
**本地施工基线：** `E:\AiWorkSpace\tavo-mini`  
**远端验收基线：** `main @ 7fbefc43c3ac786b284014d624783e21f27f5361`  
**最新生产代码提交：** `c6ef3c360dff8cd45b27eae99b29de61816ad03a`  
**方案版本：** V2.0 / 2026-08-19  
**本方案性质：** 基于第二期当前远端真实代码状态重新编排剩余工程；不重复已经完成的 Phase 0～3，不允许跳过 Phase 4 Closure 直接进入后续优化。

---

# 0. 二期最终目标不变

第二期不是继续给流水线增加能力，而是继续做减法。

最终新 Standard Production DAG 必须稳定为：

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
WritingPersistedEvent
    ↓
ONE Memory
```

最终调用目标：

```text
Clean Standard
Draft ×1
QA ×1
Revision ×0
= 2 次逻辑 LLM

Needs Revision
Draft ×1
QA ×1
Revision ×1
= 3 次逻辑 LLM

One-Shot
Draft ×1
= 1 次正文逻辑 LLM
```

新 Standard Production Path 中必须做到：

```text
Review dispatch = 0
Audit dispatch = 0
FactCheck dispatch = 0
Proof dispatch = 0
```

Legacy Frozen Task 可以继续保留旧 Stage 以完成历史 Resume，但不得重新进入新任务生产路径。

---

# 1. 当前远端真实进度

## 1.1 已完成并冻结的 Phase

```text
Phase 0
e0608fb07964b998a1804b598ab948e984979484
test(writing): baseline standard pipeline cost and call graph

Phase 1
81a27ac9be9791ddb0666de8a8f9ed71378305fd
refactor(writing): establish proof-independent final candidate contract

Phase 2
e6cae5bbb008df717e0b53597c1b320c9ea6897a
feat(writing): freeze compact-standard pipeline topology for new tasks

Phase 3
5abdbe50b19f08930461e8bf6011937268d34551
refactor(writing): remove proof from compact standard production topology

Phase 4 生产施工提交
c6ef3c360dff8cd45b27eae99b29de61816ad03a
refactor(writing): consolidate compact standard checks into one qa stage

Phase 4 进度报告提交
7fbefc43c3ac786b284014d624783e21f27f5361
docs(optimization): track phase 4 one-qa evidence and pending gates
```

## 1.2 当前阶段判定

```text
Phase 0  ✅ GO
Phase 1  ✅ GO
Phase 2  ✅ GO

Phase 3  ✅ 功能完成
         ⚠️ 最终 2+2 真实 LLM 证据延期到 Phase 4/7 合并补齐

Phase 4  🚧 代码施工完成
         ❌ NOT YET GO
         ❌ 存在两个必须先修的 P0
         ❌ Full Verify / Android / Real LLM Gate 尚未闭环

Phase 5  ⬜ 未开始
Phase 6  ⬜ 未开始
Phase 7  ⬜ 未开始
```

因此：

> **当前禁止直接进入 Phase 5。**

必须先完成本方案重新定义的：

```text
Phase 4R — ONE QA Closure / P0 修复与封板
```

---

# 2. 二期全程架构红线

## 2.1 禁止新增自动 LLM Stage

禁止：

```text
QA2
FinalQA
ResidualQA
Proof2
RiskJudge LLM
PostRevisionReview
SecondChecker
```

允许新增 Local Validator / Mapper / Classifier / Compatibility Adapter，但必须：

```text
0 LLM
0 paid API
```

## 2.2 禁止重新拆成 Outline / Continuation 两条流水线

必须只有：

```text
ONE Standard Pipeline
ONE QA implementation
ONE Revision implementation
ONE Final Candidate contract
```

场景差异只能来自：

```text
Source Adapter
Frozen Requirements
Frozen QA Policy
Frozen Context Candidates
```

## 2.3 一期封板区继续冻结

默认禁止重构：

```text
ONE Production Writing Entry
ONE Writing Kernel
ONE Shared Writer Core
ONE Shared Prompt Compiler architecture
ONE Context Planner
allocateWritingContextBudget
ONE Story Memory
WritingPersistedEvent
One-Shot execution profile
Canon / Boundary / Seam authority
Post-Freeze source truth
Elastic / Hierarchical Budget mathematics
```

## 2.4 不得通过固定 Token cap 提速

Token 优化只能来自：

```text
减少 Stage
减少重复 Context
缩短检查输出
减少 Formatter 常态调用
Revision 只带必要材料
```

---

# 3. 统一 PDCA 协议

所有剩余 Phase 必须严格执行：

```text
PLAN
Baseline
→ Root Cause
→ Impact Boundary
→ Red Test
→ Expected Call Graph

DO
Minimal Fix
→ No Opportunistic Refactor
→ No Cross-Phase Expansion

CHECK
Focused Green
→ Architecture Gate
→ Resume Gate
→ Full Regression
→ Android Gate
→ Required Real-LLM Gate

ACT
GO / NO-GO
→ Evidence Report
→ Independent Commit
```

任何 Phase `NO-GO` 都必须停留当前 Phase，禁止带病进入下一阶段。

---

# 4. Phase 4R — ONE QA Closure / P0 修复与正式封板

**本 Phase 是当前唯一允许施工的阶段。**

目标：不再扩展 ONE QA，只修当前远端已经暴露的闭环缺陷，并补齐原 Phase 4 缺失的硬 Gate。

## 4.1 P0-1：Outline QA Artifact 跨 Action / Resume 必须可恢复

当前 Outline Compact：

```text
run_draft
↓
run_qa
↓
run_brief
```

其中 `run_brief → revision`。

Revision 是否执行依赖：

```text
artifacts.qa
↓
aggregateStageFindings()
↓
hasExecutableFindings()
```

但当前 `runWritingStages()` 的 durable preload 列表遗漏 `qa`，可能出现：

```text
QA succeeded
↓
下一 action 进入 Revision
↓
artifacts.qa 丢失
↓
Revision 错误认为无 findings
↓
Revision skipped
```

### 修复边界

优先最小修：

```text
runWritingStages durable preload
+ qa
```

并确认 `OutlineDurableAdapter.loadExisting('qa')` 可恢复 QA 的完整结构化 artifact，不得重新调用 QA。

### Red Tests

```text
Case A
QA succeeded + blocking finding
→ action/resume boundary
→ QA duplicate call = 0
→ Revision call = 1

Case B
QA pass + []
→ action/resume boundary
→ QA duplicate call = 0
→ Revision = skipped

Case C
QA succeeded → App crash → Resume
→ Draft duplicate call = 0
→ QA duplicate call = 0
```

---

## 4.2 P0-2：Continuation Compact Semantic Apply 不得依赖已退出生产路径的 final_reviser

当前 Continuation Compact：

```text
round1 = draft
round2 = qa + revision
round3 = finalValidate + persist
```

Proof 已退出 Compact。

但当前 `round3.semanticApply()` 仍尝试从 `final_reviser` 获取：

```text
appliedRequirementIds
validNoOpRequirementIds
validNoOpReasons
```

而 `proof → final_reviser`，Compact 不再运行 Proof。

风险：

```text
finalReviser = null
↓
appliedRequirementIds = []
↓
Semantic Apply 空证据
↓
错误地自动 PASS
```

这属于 `False Applied / Empty Evidence Pass`。

### 正确目标

Compact Continuation 的 Semantic Apply 必须消费真实 `ONE Final Candidate`，即：

```text
Revision exists → Revision metadata
Revision skipped → Draft metadata
```

Legacy Resume 仍可保留旧 Proof / final_reviser 行为。

### Red Tests

```text
Case A
Compact + Revision succeeded + appliedRequirementIds=[R1]
→ FinalValidate 必须看到 R1

Case B
Compact + Revision skipped
→ FinalValidate 必须继承 Draft metadata

Case C
Legacy topology + Proof succeeded
→ Legacy proof metadata 仍可使用

Case D
Compact 不得 query final_reviser → empty → silently PASS
```

---

## 4.3 Phase 4R 还必须补齐原 Phase 4 三个硬 Gate

### Gate 1 — Full Verify

必须完整跑：

```text
npm run verify
```

要求：

```text
lint PASS
typecheck PASS
verify:version PASS
Full Jest PASS
0 failed
0 hanging
```

此前“相关套件单独绿”不能替代最终封板。

### Gate 2 — Android Debug

Exact HEAD：

```text
npm run apk:debug
adb install -r <debug.apk>
```

有数据的设备禁止：

```text
adb uninstall
pm clear
```

### Gate 3 — 当前 HEAD 真实 LLM 2+2

同时补齐 Phase 3 延期证据与 Phase 4 证据：

```text
Outline Source Adapter Standard 2章
Continuation Source Adapter Standard 2章
```

每章必须记录：

```text
generationTraceId
freezeFingerprint
pipelineTopologyVersion

Draft calls
QA calls
Revision calls

Review calls
Audit calls
FactCheck calls
Proof calls

Formatter calls
Physical requests
Protocol fallback
Input tokens
Output tokens

FinalValidate
Persist
PostWriting
```

必须：

```text
Review = 0
Audit = 0
FactCheck = 0
Proof = 0
QA = 1
```

## 4.4 Phase 4R GO Gate

全部满足才允许进入 Phase 5：

```text
P0-1 QA durable preload = PASS
P0-2 Compact Semantic Apply source = PASS

Outline QA→Revision boundary = PASS
Continuation Final Candidate metadata = PASS

Resume Duplicate Draft Call = 0
Resume Duplicate QA Call = 0

Review Production Dispatch = 0
Audit Production Dispatch = 0
FactCheck Production Dispatch = 0
Proof Production Dispatch = 0

Outline Standard 2/2
Continuation Standard 2/2

Full npm run verify = PASS
Android Debug = PASS
Migration 55→56 = PASS

Freeze Drift = 0
False Applied = 0
Fatal Context Loss = 0
```

建议 Commit：

```text
fix(writing): seal compact one-qa resume and semantic apply contracts
```

完成后才可宣布：

```text
PHASE 4 GO
```

---

# 5. Phase 5 — Revision Trigger / API / Token 深度治理

**只有 Phase 4R GO 后才能开始。**

目标：让 2-call Standard 真正成为常态。

## 5.1 Revision Trigger Contract

Revision 只有同时满足：

```text
verdict = revise
AND
存在 executable finding
AND
severity ∈ {blocking, warning}
```

才允许调用。

以下不得触发：

```text
info
generic suggestion
style preference
“可以更生动”
“建议加强”
“总体不错”
“略显平淡”
```

## 5.2 Executable Finding Contract

至少要求：

```text
issue 非空
severity 非 info
target 或 requirementIds 至少一项可定位
instruction 非空或存在明确纠正目标
```

## 5.3 QA 输出 Token 治理

目标：

```json
{"verdict":"pass","findings":[]}
```

或极简可执行 findings。

禁止默认输出：

```text
strengths
长篇摘要
文学点评
正文复述
大段 suggestions
思维过程
```

## 5.4 QA Input Context 治理

Phase 4 的 QA Context 是旧三套检查 allowlist 的去重并集；Phase 5 必须用真实 Token 继续收窄。

不得建立第二套 Context Builder。

## 5.5 Revision Context 治理

Revision 主要消费：

```text
Draft
QA executable findings
Relevant Requirements
必要 Style / Canon projection
```

禁止再次堆入：

```text
完整 Frozen Context
完整 QA 长报告
旧 Review/Audit/FactCheck 报告
```

## 5.6 API 四口径继续保留

```text
Logical Stage Call
Formatter Call
Physical HTTP Request
Protocol Fallback
```

Clean 目标：

```text
logical = 2
formatter = 0
physical ≈ 2
```

Revision 目标：

```text
logical <= 3
formatter = 0 ideally
physical ≈ 3
```

## 5.7 Phase 5 GO Gate

```text
QA pass + [] → Revision 0
info-only findings → Revision 0
blocking executable finding → Revision 1
warning executable finding → Revision 1

Clean Standard Logical Calls <= 2
Revision Standard Logical Calls <= 3

Proof = 0
Review/Audit/FactCheck = 0

Formatter not default
No hidden primary retry loop

QA output compact
QA input duplication not worse than Phase 4
Revision context no stacked old reports

Full Verify PASS
Android Debug PASS
Real LLM PASS
```

建议 Commit：

```text
perf(writing): tighten qa revision triggers and stage token costs
```

---

# 6. Phase 6 — Batch / Single / Resume / UI / Ledger / Trace 全链路收束

目标：外围系统和后端 Compact DAG 完全一致。

## 6.1 Stage Name 全仓审计

扫描：

```text
review
audit
factCheck
proof
reviewing
auditing
factchecking
proofing
narrative_architect
adversarial_auditor
final_reviser
```

逐项分类为 Legacy / Migration / Historical / New Production / UI / Trace / Test。

新 Production 不允许依赖旧 Stage 名。

## 6.2 新 Standard Durable Ledger

新 Standard 只应出现：

```text
draft
qa
revision (optional)
finalValidate
persist
```

Continuation 新生产 ledger 不得继续生成：

```text
narrative_architect
adversarial_auditor
final_reviser
```

fake skipped row。

## 6.3 UI 产品语义

新 Standard 用户态只显示：

```text
准备上下文
生成
检查
修订（有需要时）
校验
保存
```

## 6.4 Batch / Single / Resume 一致

必须证明：

```text
Single Chapter
Batch Chapter
Resume
Cold Start
```

全部进入同一 Compact Standard Production Graph。

## 6.5 历史坑回归

```text
Draft success → crash → no duplicate Draft
QA success → crash → no duplicate QA
Revision success → crash → no duplicate Revision

failed → resume → completed
UI 必须重新感知 completed

running zombie → cold-start normalize
```

任何新 SQL 禁止：

```text
UPDATE ... ORDER BY ... LIMIT
SELECT * materialize huge context JSON
```

## 6.6 Phase 6 GO Gate

```text
Single = PASS
Batch = PASS
Resume = PASS
Cold Start = PASS

New Standard old dispatch = 0
New Standard fake legacy skip rows = 0
UI old-stage leak = 0

Resume Duplicate Paid Call = 0
Story Memory regression = 0
Continuity State regression = 0
Freeze Drift = 0

Full Verify PASS
Android Debug PASS
```

建议 Commit：

```text
refactor(writing): align batch ui ledger resume with compact standard
```

---

# 7. Phase 7 — 第二期最终穿测、CI 锁定与 Final Seal

## 7.1 Generation Stability 必须加入二期 Gate

至少包括：

```text
writingPhase2Baseline
writingFinalCandidateContract
pipelineTopologyContract
writingProofRemovalContract
writingQaConsolidationContract
outlineStageRuntimeRunQaDispatch

Phase4R:
qa durable preload / resume contract
compact continuation semantic apply contract

Phase5:
revision trigger / cost contract

Phase6:
compact UI / ledger / resume contract
```

禁止：

```text
allow-failure
.skip
.only
```

## 7.2 Exact Final HEAD 全门禁

同一 Final SHA：

```text
verify:version PASS
lint PASS
typecheck PASS
Full Jest PASS
Migration PASS
Generation Stability PASS
Verify workflow PASS
Android Debug PASS
```

## 7.3 最终真实 LLM 穿测

```text
Outline Standard 2章
Continuation Standard 2章
Outline One-Shot 1章
Continuation One-Shot 1章
```

总计 6 章。

## 7.4 Final Call Graph Gate

### Clean Standard

```text
Draft = 1
QA = 1
Revision = 0
Review = 0
Audit = 0
FactCheck = 0
Proof = 0
Logical Paid Calls <= 2
```

### Needs Revision

```text
Draft = 1
QA = 1
Revision = 1
Review = 0
Audit = 0
FactCheck = 0
Proof = 0
Logical Paid Calls <= 3
```

### One-Shot

```text
Draft = 1
QA = 0
Revision = 0
Proof = 0
Formatter = 0
Auto Retry = 0
```

## 7.5 最终历史坑专项回归

必须重新证明：

```text
H1 Shared Writer Recovery
H2 Frozen Thinking / DeepSeek QA
H3 Frozen Envelope Corruption fail-closed
H4 Resume Frozen Context preserved
H5 Duplicate Paid Call = 0
H6 Legacy Topology not auto-upgraded
H7 New Standard no fake legacy skips
H8 Logical/Formatter/Physical/Fallback observable
H9 Android SQLite no UPDATE-LIMIT dependency
H10 CursorWindow no SELECT * giant JSON
H11 Cold Start zombie recovery
H12 Same Task failed→resume→completed UI recovery
```

---

# 8. 二期最终 Seal Gate

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
→ QA
→ Conditional Revision
→ FinalValidate
→ Persist
```

严格：

```text
Review Production Dispatch = 0
Audit Production Dispatch = 0
FactCheck Production Dispatch = 0
Proof Production Dispatch = 0
```

## API

```text
Clean Standard logical paid calls <= 2
Needs Revision logical paid calls <= 3
One-Shot body paid calls <= 1
Resume Duplicate Paid Call = 0
```

## Freeze / Resume

```text
Topology Frozen = YES
QA Policy Frozen = YES
QA Model Behavior Frozen = YES
Post-Freeze Live Read = 0
Freeze Drift = 0
Legacy Resume = PASS
```

## Semantic / Quality

```text
Semantic Apply = PASS
Compact Semantic Evidence = real Final Candidate
False Applied = 0
Canon Regression = 0
Memory Drift = 0
Fatal Context Loss = 0
```

## Token / Cost

```text
No new hard input token cap
QA output compact
QA context no stacked old reports
Revision context targeted
Formatter not default
Physical request observable
```

## Regression

```text
Full Jest = PASS
Lint = PASS
Typecheck = PASS
Migration = PASS
Generation Stability = PASS
Verify = PASS
Android Debug = PASS
```

## Real LLM

```text
Outline Standard 2/2
Continuation Standard 2/2
One-Shot 2/2
```

---

# 9. 剩余工程严格串行顺序

```text
CURRENT
main @ 7fbefc43
↓
Phase 4R
ONE QA Closure / P0 修复
↓ GO
Phase 5
Revision Trigger / API / Token
↓ GO
Phase 6
Batch / Single / Resume / UI / Ledger
↓ GO
Phase 7
Exact HEAD / CI / Real LLM Final Seal
↓ GO
PHASE 2 FINAL SEALED / GO
```

任何 Phase NO-GO：

```text
禁止进入下一阶段
```

---

# 10. 推荐剩余 Commit 边界

```text
Phase 4R
fix(writing): seal compact one-qa resume and semantic apply contracts

Phase 5
perf(writing): tighten qa revision triggers and stage token costs

Phase 6
refactor(writing): align batch ui ledger resume with compact standard

Phase 7
ci(writing): lock compact standard phase-two final gates

Final report
docs(optimization): seal phase-two compact standard pipeline
```

禁止一个 Commit 横跨多个 Phase。

---

# 11. Agent 执行纪律

Agent 必须：

- 以 `E:\AiWorkSpace\tavo-mini` 为唯一施工基线；
- 开工先 `git fetch --all --prune` 并确认最新远端 `main`；
- 如果远端 HEAD 已高于 `7fbefc43...`，先重新审计新提交；
- 严格停留在当前允许的 Phase；
- 每个 P0 先 Red Test 再修；
- 不顺手重构；
- 不新增 Stage；
- 不重建 Outline / Continuation 双流水线；
- 不修改 One-Shot 封板行为；
- 不增加固定 Token cap；
- 不删除 Legacy Resume 能力；
- 不用清数据库代替 Resume / Migration 修复；
- 不用分批单测替代最终 Full Verify；
- 不用“UI 能生成正文”替代 Call Graph / Ledger / Semantic Apply 验收；
- 不用 Logical Calls 掩盖 Formatter / Physical HTTP / Protocol Fallback；
- 未满足当前 Phase GO Gate 前不得宣布完成。

---

# 12. 本版方案相对 V1.0 的关键调整

```text
Phase 0～2
→ 已完成，冻结，不重复施工

Phase 3
→ Proof 已退出 Compact，功能完成
→ 2+2 E2E 证据并入当前 HEAD 的 Phase 4R 统一补齐

Phase 4
→ ONE QA 已落地
→ 重新判定为 NOT YET GO
→ 增加两个当前代码真实 P0：
   1. Outline QA durable preload / Revision trigger
   2. Continuation Compact Semantic Apply evidence source

Phase 5
→ 仅在 Phase 4R GO 后开始
→ 聚焦 Revision Trigger + QA/API/Token

Phase 6
→ 外围全链路收束

Phase 7
→ CI + Exact Final HEAD + 2+2+1+1 最终封板
```

---

# 13. 最终原则

> **从当前远端开始，二期不再重复建设已经完成的 Phase 0～3。**

> **当前第一任务是把 Phase 4 ONE QA 真正封板，而不是继续向 Phase 5 前冲。**

> **ONE QA 的正确性优先于 Token 优化；Resume 与 Semantic Apply 闭环未稳，禁止继续提速。**

> **Phase 4 GO 后，第二期剩余工程才正式进入 Revision/API/Token 深度治理。**

> **最终 Standard 只允许：写一次、查一次、有问题才改一次。**
