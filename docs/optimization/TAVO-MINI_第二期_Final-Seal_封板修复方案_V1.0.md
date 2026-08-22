# TAVO-MINI 第二期 Final-Seal 最终封板修复方案 V1.0

**项目：** TAVO-MINI / ShineWriter  
**阶段：** Phase 2 最终封板修复  
**本地施工基线：** `F:\ClaudeWorkSpace\projects\TAVO-MINI`  
**当前远端 main：** `31e86b3e206ff508255e1e16d1ca8e09e252f5f1`  
**当前最终生产代码父提交：** `97f54175702bf9f9a654af27e7611e49db85347a`  
**当前版本：** `V2.11.54`

当前判定：

```text
Phase 4R = SEALED
Phase 5  = FUNCTIONALLY GO
Phase 6  = FUNCTIONALLY GO
Phase 7  = NO-GO

PHASE 2 = PRE-SEAL
```

---

# 1. 本次封板修复范围

本轮不再修改主流水线架构。

冻结目标：

```text
Draft
↓
ONE QA
↓
Conditional Revision
↓
FinalValidate
↓
Persist
```

以下全部冻结：

```text
ONE Production Entry
ONE Writing Kernel
ONE Shared Writer Core
ONE Shared Prompt Compiler
ONE Context
ONE Memory
ONE Flow
Final Candidate Contract
Compact Standard Topology
One-Shot
Legacy Resume Compatibility
```

本轮只允许处理两个剩余封板缺口：

```text
A. Phase 7 Dedicated Generation Stability 真正落地
B. Final HEAD 真实 LLM 2+2+1+1 重新穿测
```

不得借封板之名继续扩展功能、重构架构、优化 Prompt 或修改 Stage 行为。

---

# 2. 当前剩余两个硬缺口

## 2.1 缺口 A：二期关键 Gate 尚未真正显式写入 Generation Stability Workflow

当前已经存在：

```text
__tests__/phaseTwoGenerationStabilityGate.test.ts
```

它能够检查关键测试存在、没有 `.skip/.only/xdescribe/xit/allow-failure`。

但当前：

```text
.github/workflows/generation-stability.yml
```

仍主要运行一期 ONE Flow / One-Shot 旧 Gate。

当前只是：

```text
Verify
→ npm run test:ci
→ 间接覆盖二期测试
```

目标必须变成：

```text
Generation Stability
→ 明确运行二期 Final Gate 套件
```

---

## 2.2 缺口 B：Final HEAD 未重新跑真实 LLM 2+2+1+1

当前 live 证据来自较早 HEAD：

```text
7fbefc43
```

之后又发生：

```text
Phase 4R  df36ae0
Phase 5   5746c3c
Phase 6   6d44ce4
Phase 7   97f5417
Final docs 31e86b3
```

其中 Phase 5 改变了 Revision Trigger / QA Output Contract / Revision Dispatch；Phase 6 改变了 Compact Ledger / UI。

因此旧 live 证据不能作为最终生产代码的 Exact HEAD 真实运行证据。

---

# 3. 封板修复总原则

```text
NO ARCHITECTURE CHANGE
NO NEW LLM STAGE
NO PIPELINE BRANCH
NO NEW WRITER
NO NEW QA
NO NEW CONTEXT BUILDER
NO NEW MEMORY
NO FIXED TOKEN CAP
NO ONE-SHOT CHANGE
NO LEGACY RESUME CHANGE
```

允许：

```text
CI workflow 追加测试项
封板测试修补
测试脚本
证据采集脚本
日志/DB读取
文档更新
```

真实 LLM 若发现生产 Bug：

```text
Red Test
↓
Minimal Fix
↓
Focused Green
↓
Full Verify
↓
重新开始 Final HEAD 穿测
```

---

# 4. Phase F1 — Dedicated Generation Stability Final Lock

## 4.1 目标

让：

```text
.github/workflows/generation-stability.yml
```

真正显式包含二期关键契约测试。

## 4.2 必须显式加入

```text
__tests__/writingPhase2Baseline.test.ts
__tests__/writingFinalCandidateContract.test.ts
__tests__/outlineWorkflowVersion.test.ts
__tests__/writingProofRemovalContract.test.ts
__tests__/writingQaConsolidationContract.test.ts
__tests__/outlineStageRuntimeRunQaDispatch.test.ts

__tests__/writingQaDurablePreloadContract.test.ts
__tests__/writingCompactSemanticApplyContract.test.ts
__tests__/writingOneShotCompactQaSkip.test.ts

__tests__/writingRevisionTriggerContract.test.ts
__tests__/continuationCompactLedgerContract.test.ts
__tests__/phaseTwoGenerationStabilityGate.test.ts
```

建议保持：

```text
--runInBand
--runTestsByPath
```

## 4.3 Workflow 禁止

```text
continue-on-error: true
allow-failure
|| true
SKIP_PHASE2
conditional ignore
```

失败必须让 Workflow 失败。

## 4.4 Red Test

先增强 `phaseTwoGenerationStabilityGate`：

```text
除了检查测试文件存在
还必须断言 generation-stability.yml 真正列入全部二期 suite
```

## 4.5 CHECK

执行：

```text
npm test -- phaseTwoGenerationStabilityGate --runInBand

npm test -- --runInBand --runTestsByPath <全部二期 suite>

npm run verify
```

要求：

```text
Phase2 Gate PASS
Generation Stability suite PASS
Full Jest PASS
Lint PASS
Typecheck PASS
verify:version PASS
```

## 4.6 GO Gate

```text
Generation Stability 显式列入全部二期 Gate
无 .skip/.only
无 allow-failure
Phase2 stability suite 全绿
Full Verify 全绿
```

建议 Commit：

```text
ci(writing): wire phase-two gates into generation stability workflow
```

---

# 5. Phase F2 — Exact Final HEAD Build / Install Freeze

完成 F1 commit 后：

```text
git status = clean
git rev-parse HEAD
```

记录：

```text
FINAL_PRODUCTION_HEAD=<sha>
```

后续所有穿测、Android、日志、DB、报告必须引用该 SHA。

## Android Debug

```text
npm run apk:debug
adb install -r <debug.apk>
```

禁止：

```text
adb uninstall
pm clear
```

必须保留 API Key、模型配置、项目、Story Memory。

记录：

```text
HEAD
APK path
APK size
BUILD SUCCESSFUL
adb install -r Success
cold boot PASS
无新增 fatal
```

---

# 6. Phase F3 — Final HEAD 真实 LLM 2+2+1+1

## 6.1 样本

```text
Outline Standard ×2
Continuation Standard ×2
Outline One-Shot ×1
Continuation One-Shot ×1
```

总计 6 章。

## 6.2 必须覆盖两类 Standard

尽量获得：

```text
至少 1 个 Clean Standard
至少 1 个 Needs Revision Standard
```

如果自然样本没有 Clean，可继续新增章节，直到真实出现：

```text
QA pass → Revision 0
```

禁止人工篡改 QA 输出。

---

# 7. 每章必须采集的证据

## Freeze

```text
generationTraceId
freezeFingerprint
pipelineTopologyVersion
executionProfile
sourceAdapter/scenario
```

要求：

```text
Standard = compact_standard
One-Shot = compact_standard + one_shot
```

## Logical Calls

```text
Draft
QA
Revision
Review
Audit
FactCheck
Proof
```

## Physical Calls

```text
logicalStageCallCount
formatterCallCount
physicalRequestCount
protocolFallbackCount
```

## Token

```text
Draft input/output
QA input/output
Revision input/output
chapter total input/output
```

## Ledger

Continuation Compact 必须只有：

```text
draft_writer
unified_qa
revision_writer
final_validate
```

不得出现：

```text
narrative_architect
adversarial_auditor
final_reviser
```

即使 queued=0 也不允许。

## Final Path

```text
FinalValidate PASS
Persist PASS
WritingPersistedEvent PASS
PostWriting PASS
Story Memory / Continuity State 正常
```

---

# 8. Standard Final Call Graph Gate

## Clean Standard

```text
Draft = 1
QA = 1
Revision = 0
Review = 0
Audit = 0
FactCheck = 0
Proof = 0
Logical paid calls <= 2
```

## Needs Revision

```text
Draft = 1
QA = 1
Revision = 1
Review = 0
Audit = 0
FactCheck = 0
Proof = 0
Logical paid calls <= 3
```

## One-Shot

```text
Draft = 1
QA = 0
Revision = 0
Review = 0
Audit = 0
FactCheck = 0
Proof = 0
Formatter = 0
Primary Retry = 0
Logical paid calls = 1
```

---

# 9. Revision Trigger 实机专项检查

## Case A — Clean

```text
QA verdict = pass
findings = []
→ Revision = 0
```

## Case B — Executable Finding

```text
severity = blocking / warning
target 或 requirementIds 可定位
instruction 可执行
→ Revision = 1
```

## Case C — Generic / Info

如果真实出现：

```text
info
generic suggestion
```

必须：

```text
Revision = 0
```

若 6 章未自然出现，可由现有 Red Test 作为正式证据，不强行诱导 LLM。

---

# 10. Token / API 最终验收口径

不要求统计显著性。

允许：

```text
Before Baseline vs Final HEAD 单章
```

重点验证结构性变化：

```text
Standard paid stage 5 → 2/3
Proof 1 → 0
Review/Audit/FactCheck → ONE QA
Clean Revision 1 → 0
```

不得只记录 Logical Calls 而隐藏 Formatter / Retry / Protocol Fallback。

---

# 11. Phase F3 GO Gate

```text
Outline Standard 2/2
Continuation Standard 2/2
One-Shot 2/2

至少 1 Clean Standard
至少 1 Needs Revision Standard

Review=0
Audit=0
FactCheck=0
Proof=0

Clean logical <=2
Revision logical <=3
One-Shot logical=1

Formatter not default
No hidden retry loop

Compact Ledger 无 fake legacy row

FinalValidate PASS
Persist PASS
PostWriting PASS

Freeze Drift = 0
Resume Duplicate Paid Call = 0
False Applied = 0
Memory Drift = 0
```

---

# 12. Phase F4 — Exact Final HEAD Full Regression

真实 LLM 通过后再次执行：

```text
npm run verify
Phase2 Generation Stability workflow-equivalent command
Migration tests
Android Debug build
```

如果 F3 期间没有代码修改：

```text
HEAD 必须与 F2 完全一致
```

若 F3 发现 Bug 并修复：

```text
HEAD 改变
→ F2/F3 全部重跑
```

---

# 13. GitHub CI 终态

推送最终代码后检查：

```text
Verify
Generation Stability
```

必须对同一个 Final SHA：

```text
SUCCESS
```

若 branch protection 未启用，可记录事实，但不得把未运行的 Workflow 写成 PASS。

---

# 14. Final Seal Evidence Report

最终生成：

```text
docs/optimization/TAVO-MINI_第二期_Final-Seal_最终封板报告_20260820.md
```

必须写明：

```text
finalRepositoryHead
finalProductionCodeHead
ciValidatedHead
realLlmValidatedHead
```

理想：

```text
全部相同 SHA
```

若最终只追加 docs-only commit，则允许：

```text
finalProductionCodeHead
= ciValidatedHead
= realLlmValidatedHead

finalRepositoryHead
= docs-only child
```

---

# 15. 最终报告必须包含

## Architecture

```text
ONE Production Entry = 1
ONE Kernel = 1
ONE Writer Core = 1
ONE Prompt Compiler = 1
ONE QA = 1
ONE Context = 1
ONE Memory = 1
```

## Production DAG

```text
Draft
→ QA
→ Conditional Revision
→ FinalValidate
→ Persist
```

## Calls

```text
Clean <=2
Revision <=3
One-Shot =1
```

## Freeze / Resume

```text
Freeze Drift =0
Duplicate Paid Call =0
Post-Freeze Live Read =0
Legacy Resume PASS
```

## Semantic

```text
False Applied =0
Final Candidate PASS
Canon Regression =0
Story Memory Regression =0
```

## CI

```text
Verify PASS
Generation Stability PASS
Full Jest PASS
Lint PASS
Typecheck PASS
Migration PASS
Android Debug PASS
```

## Real LLM

```text
Outline Standard 2/2
Continuation Standard 2/2
One-Shot 2/2
Exact Final Production HEAD
```

---

# 16. 最终 GO / NO-GO

只有全部满足才允许：

```text
PHASE 2 FINAL SEALED / GO
```

否则：

```text
PHASE 2 PRE-SEAL / NO-GO
```

禁止用：

```text
自动化全绿
旧 HEAD live 测试
代码看起来稳定
```

替代 Final HEAD live evidence。

---

# 17. 推荐 Commit 边界

## Commit 1

```text
ci(writing): wire phase-two gates into generation stability workflow
```

## Commit 2

仅真实 LLM 发现生产 Bug 时：

```text
fix(writing): <exact root cause>
```

随后全部重跑。

## Commit 3

```text
docs(optimization): seal phase-two compact standard final head
```

---

# 18. Agent 执行纪律

- 以 `F:\ClaudeWorkSpace\projects\TAVO-MINI` 为唯一施工基线；
- 开工先 fetch 并确认远端最新 main；
- 不再修改已 GO 的 Phase 4R/5/6 架构；
- 先完成 Dedicated Generation Stability；
- 再冻结 Exact Final HEAD；
- 再跑真实 LLM 2+2+1+1；
- 真实 LLM 若发现 Bug，必须 Red Test + Minimal Fix，再从 Final HEAD Gate 重来；
- 禁止清除 App 数据；
- 禁止隐藏 Formatter / retry / fallback；
- 禁止使用旧 HEAD live 证据冒充 final HEAD；
- 禁止跳过 Full Verify；
- 未完成 Final HEAD live 不得宣布 `FINAL SEALED / GO`。

---

# 19. 最终目标

```text
Final Production SHA
↓
Generation Stability PASS
↓
Verify PASS
↓
Android Debug PASS
↓
adb install -r PASS
↓
Outline Standard 2/2
↓
Continuation Standard 2/2
↓
One-Shot 2/2
↓
Logical / Physical / Token / Ledger Evidence
↓
Final Report
↓
PHASE 2 FINAL SEALED / GO
```

> **这一轮不再建设流水线，只建设不可争议的最终证据。**
