# TAVO-MINI 第二期 Final-Seal 最终收尾工程方案 V1.0

**项目：** TAVO-MINI / ShineWriter  
**工程性质：** 第二期最终封板后的证据闭环与收尾工程  
**本地施工基线：** `F:\ClaudeWorkSpace\projects\TAVO-MINI`  
**当前远端 main：** `ac0555c3856989a2aace56b1bb98547e9767d38a`  
**当前 Final Production Code HEAD：** `d9b603df81006e417a24890a3665911fe196d135`  
**当前版本：** `V2.11.54`

---

# 0. 当前状态

当前已完成：

```text
Phase 4R = SEALED
Phase 5  = SEALED
Phase 6  = SEALED
Phase 7 CI Wiring = SEALED

Final HEAD Clean Standard live = PASS
Final HEAD One-Shot live = PASS
Generation Stability workflow wiring = PASS
Local workflow-equivalent = PASS
Android Debug / adb install -r = PASS
```

当前只剩 3 个真正未闭环项：

```text
1. Final Production HEAD 的 Needs-Revision 真实 LLM 路径尚未实机跑通
2. Remote GitHub Actions 的 Verify / Generation Stability 尚未独立确认 SUCCESS
3. Final-Seal 报告中的 finalRepositoryHead 与最终证据字段需要修正
```

因此当前工程状态：

```text
PHASE 2 = PRE-SEAL
```

本方案完成后，才允许正式改为：

```text
PHASE 2 FINAL SEALED / GO
```

---

# 1. 本工程边界

## 1.1 绝对禁止继续修改的区域

本轮不再建设流水线。

以下全部冻结：

```text
ONE Production Entry
ONE Writing Kernel
ONE Shared Writer Core
ONE Shared Prompt Compiler
ONE QA
ONE Context
ONE Memory
ONE Flow

Final Candidate Contract
Compact Standard Topology
Revision Trigger Contract
QA Output Contract
Compact Ledger
UI Compact Mapping
One-Shot
Legacy Resume
Elastic Context Budget
Semantic Apply
Story Memory
```

禁止：

```text
新增 Stage
新增 LLM 调用
新增 QA2 / FinalQA / Proof2
重做 Prompt
重做 Revision Trigger
修改 Context Budget
修改 Memory
修改 Pipeline DAG
修改 One-Shot
修改 Legacy topology
优化模型参数
顺手重构
```

---

## 1.2 本轮允许修改的范围

正常情况下只允许：

```text
测试/证据脚本
CI 查询与证据采集
Final-Seal 报告
CHANGELOG（仅如确有必要）
docs/optimization
test-logs
```

只有真实 LLM 穿测发现明确生产 Bug 时，才允许进入：

```text
Red Test
→ Root Cause
→ Minimal Fix
→ Focused Green
→ Full Verify
→ 重新冻结 Production HEAD
```

且修复范围必须严格限定到该 Bug。

---

# 2. 最终目标

完成后必须形成一条不可争议的证据链：

```text
Final Production SHA
↓
Needs-Revision live PASS
↓
Verify Remote CI SUCCESS
↓
Generation Stability Remote CI SUCCESS
↓
Final Report HEAD 修正
↓
Final Evidence Index
↓
PHASE 2 FINAL SEALED / GO
```

---

# 3. 统一 PDCA 纪律

每个阶段必须：

```text
PLAN
→ 明确目标
→ 明确证据
→ 明确失败条件

DO
→ 最小动作
→ 不扩大范围

CHECK
→ 真实证据
→ 独立核验

ACT
→ GO / NO-GO
→ 未 GO 禁止进入下一阶段
```

---

# 4. Phase C0 — Final Production HEAD 身份锁定

## 4.1 目的

正式确认：

```text
finalRepositoryHead
finalProductionCodeHead
realLlmValidatedHead
ciValidatedHead
```

四个字段的真实关系。

## 4.2 当前预期

当前：

```text
main = ac0555c3856989a2aace56b1bb98547e9767d38a
ac0555c = docs-only Final-Seal report commit
parent = d9b603df81006e417a24890a3665911fe196d135
```

所以当前正确关系应为：

```text
finalRepositoryHead
= ac0555c3856989a2aace56b1bb98547e9767d38a

finalProductionCodeHead
= d9b603df81006e417a24890a3665911fe196d135
```

## 4.3 CHECK

必须执行：

```text
git fetch --all --prune
git status
git rev-parse HEAD
git rev-parse origin/main
git log -3 --oneline
git diff d9b603d..ac0555c --name-only
```

必须证明：

```text
ac0555c 相对 d9b603d 仅 docs 变化
```

## 4.4 C0 GO Gate

```text
Worktree clean
origin/main = ac0555c
ac0555c only docs
Production code truth = d9b603d
No new remote code commit
```

如果远端已经出现新的生产代码 commit：

```text
STOP
→ 重新审计
→ 新 SHA 成为新的候选 Production HEAD
```

不得继续使用旧 live 证据。

---

# 5. Phase C1 — Final HEAD Needs-Revision 真实 LLM 路径穿透

这是本轮最重要的业务 Gate。

## 5.1 当前缺口

现有 Final HEAD live 证据已经覆盖：

```text
Clean Standard
Draft=1
QA=1
Revision=0
```

以及：

```text
One-Shot
Draft=1
```

但还没有在 Final Production HEAD 上真实跑到：

```text
QA
→ executable finding
→ Revision=1
```

## 5.2 目标

至少获得 1 个真实 Standard 章节：

```text
QA verdict != pass
AND
存在 blocking/warning executable finding
↓
Revision exactly 1
↓
FinalValidate PASS
↓
Persist PASS
```

最终调用必须：

```text
Draft = 1
QA = 1
Revision = 1

Review = 0
Audit = 0
FactCheck = 0
Proof = 0

Logical paid calls <= 3
Formatter = 0 ideally
No hidden retry
```

## 5.3 如何获取 Needs-Revision 样本

允许：

```text
继续创建新的 Standard 测试章节
使用正常真实写作输入
使用现有模型配置
正常触发 QA
```

禁止：

```text
人工改数据库 QA 结果
人工插入 finding
修改 Prompt 强迫模型报错
修改 Revision Trigger
修改 severity
伪造日志
复用旧 HEAD 样本冒充 Final HEAD
```

需要的是真实模型在自然运行中产生 executable finding。

## 5.4 可接受的 executable finding

必须满足当前正式 Contract：

```text
verdict 非 pass
severity ∈ {blocking, warning}
issue 非空
target 或 requirementIds 可定位
instruction 或 target 可执行
```

## 5.5 每个候选样本必须记录

```text
chapterId
batchId
generationTraceId
freezeFingerprint
pipelineTopologyVersion
executionProfile

QA verdict
QA findings
Revision trigger reason

Draft logical/physical
QA logical/physical
Revision logical/physical

formatterCallCount
protocolFallbackCount

Draft input/output tokens
QA input/output tokens
Revision input/output tokens

FinalValidate
Persist
PostWriting
Story Memory
Continuity State
```

## 5.6 Continuation 样本额外检查

如果 Needs-Revision 样本来自 Continuation：

Ledger 必须只有：

```text
draft_writer
unified_qa
revision_writer
final_validate
```

并且：

```text
revision_writer = success
request_count = 1
```

禁止出现：

```text
narrative_architect
adversarial_auditor
final_reviser
```

## 5.7 Outline 样本额外检查

如果来自 Outline：

必须证明：

```text
QA artifact 已 durable persist
Revision action 能正确 preload QA
QA 不重复调用
Revision exactly 1
```

---

# 6. C1 异常处理

## 6.1 网络 outcome_unknown

如果出现：

```text
outcome_unknown
timeout
connection reset
```

且系统按现有 fail-closed 停止：

```text
不计为成功样本
不 resume 强行重复付费
不修改架构
```

可重新创建新章节继续测试。

## 6.2 Formatter

如果 QA 正常首次输出需要 Formatter：

必须记录：

```text
logical
formatter
physical
```

但不得把 Formatter 隐藏。

如果 Formatter 变成稳定常态：

```text
C1 NO-GO
```

需要单独 Root Cause。

## 6.3 如果真实发现生产 Bug

必须：

```text
STOP C1
↓
建立 Red Test
↓
Minimal Fix
↓
Focused Green
↓
npm run verify
↓
Generation Stability
↓
Android Debug
↓
产生新的 Production HEAD
↓
C0 重新开始
```

禁止直接在原 SHA 上继续封板。

---

# 7. C1 GO Gate

必须全部满足：

```text
Final Production HEAD live sample = exact SHA

QA executable finding = real
Revision exactly 1

Draft = 1
QA = 1
Revision = 1

Review = 0
Audit = 0
FactCheck = 0
Proof = 0

Logical paid calls <= 3
No duplicate Draft
No duplicate QA
No duplicate Revision

FinalValidate PASS
Persist PASS
PostWriting PASS

Freeze Drift = 0
False Applied = 0
Story Memory regression = 0
```

---

# 8. Phase C2 — Remote GitHub CI Final Verification

## 8.1 目标

最终不再只写：

```text
local workflow-equivalent PASS
```

而要实际确认 GitHub 上：

```text
Verify
Generation Stability
```

对 Final Production SHA 或其 docs-only child：

```text
SUCCESS
```

## 8.2 正确 SHA 关系

理想：

```text
Production HEAD = d9b603d
CI validated SHA = d9b603d
```

如果 GitHub Actions 因 docs-only commit `ac0555c` 重新触发，也允许：

```text
Verify(ac0555c) = SUCCESS
Generation Stability(ac0555c) = SUCCESS
```

因为：

```text
ac0555c 与 d9b603d 生产代码一致
```

但报告必须分别写清楚：

```text
finalRepositoryHead
finalProductionCodeHead
ciValidatedHead
realLlmValidatedHead
```

不能混写。

## 8.3 必须检查的远端 Workflow

### Verify

至少：

```text
Version consistency
Lint
TypeScript
Jest CI
Android Debug
Migration matrix
```

### Generation Stability

必须看到新增的：

```text
Phase 2 Final Seal generation stability gates
```

并实际 SUCCESS。

## 8.4 C2 GO Gate

```text
Verify remote = SUCCESS
Generation Stability remote = SUCCESS
Phase2 Final Seal step = SUCCESS

No continue-on-error
No allow-failure
No skipped phase2 suite
```

---

# 9. Remote CI 异常处理

## 9.1 GitHub 未产生 workflow run

不能写：

```text
CI PASS
```

只能写：

```text
Remote CI not observed
```

需要确认 Actions trigger、workflow branch、push SHA。

## 9.2 Workflow 红

必须：

```text
NO-GO
```

如果只是 infra/transient，允许重新运行 CI。

如果是代码/测试失败：

```text
必须修复
→ 新 Production HEAD
→ C0/C1/C2 重跑
```

---

# 10. Phase C3 — Final-Seal 报告修正与证据闭环

## 10.1 报告文件

更新：

```text
docs/optimization/TAVO-MINI_第二期_Final-Seal_最终封板报告_20260820.md
```

## 10.2 必须修正 HEAD 字段

至少：

```text
finalRepositoryHead
= 当前 main docs-only HEAD

finalProductionCodeHead
= 实际生产代码 HEAD

realLlmValidatedHead
= Needs-Revision live 所在生产 SHA

ciValidatedHead
= GitHub Actions 实际 SUCCESS SHA
```

## 10.3 必须补 Needs-Revision Live 小节

至少包含：

```text
chapter
batch
generationTraceId
freezeFingerprint
QA verdict
finding
Draft calls
QA calls
Revision calls
physical calls
formatter
fallback
tokens
FinalValidate
Persist
PostWriting
```

并明确：

```text
Final HEAD Needs-Revision live = PASS
```

## 10.4 必须补 Remote CI 证据

写明：

```text
Verify workflow run
Generation Stability workflow run
validated SHA
result
```

禁止再写：

```text
workflow-equivalent
```

作为最终 CI 终态。

本地 workflow-equivalent 可以保留作为补充证据。

## 10.5 报告不得修改历史事实

例如：

```text
Clean 2+2
One-Shot 1+1
```

原记录可保留。

Needs-Revision 新样本应作为：

```text
Final-Seal supplementary live evidence
```

追加，而不是重写旧证据。

---

# 11. Phase C3 GO Gate

```text
HEAD fields correct
Needs-Revision live added
Remote CI run IDs/results added
No stale PRE-SEAL text
No contradictory SHA
No old HEAD masquerading as final
```

---

# 12. Phase C4 — Final Repository Seal

完成 C3 后，如果仅修改 docs，建议：

```text
docs(writing): finalize phase-two final-seal evidence
```

最终 SHA 结构允许：

```text
finalProductionCodeHead
= <production SHA>

realLlmValidatedHead
= <same production SHA>

ciValidatedHead
= <production SHA or docs-only child>

finalRepositoryHead
= <docs-only child>
```

只要生产代码未变化即可。

---

# 13. 最终硬门禁矩阵

## Architecture

```text
ONE Production Entry = 1
ONE Kernel = 1
ONE Writer = 1
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

## Clean

```text
Draft=1
QA=1
Revision=0
Logical<=2
```

## Needs Revision

```text
Draft=1
QA=1
Revision=1
Logical<=3
```

## One-Shot

```text
Draft=1
QA=0
Revision=0
Logical=1
```

## Old Stages

```text
Review=0
Audit=0
FactCheck=0
Proof=0
```

## Runtime

```text
Formatter not default
No hidden retry
Resume Duplicate Paid Call=0
Freeze Drift=0
False Applied=0
```

## Persistence

```text
FinalValidate PASS
Persist PASS
WritingPersistedEvent PASS
PostWriting PASS
Story Memory PASS
```

## Ledger

```text
No narrative_architect
No adversarial_auditor
No final_reviser
```

## CI

```text
Verify remote SUCCESS
Generation Stability remote SUCCESS
Phase2 final gate SUCCESS
```

## Evidence

```text
Clean live PASS
Needs-Revision live PASS
One-Shot live PASS
HEAD fields correct
```

---

# 14. 最终 GO / NO-GO

只有全部通过，才允许：

```text
PHASE 2 FINAL SEALED / GO
```

任一未完成：

```text
PHASE 2 PRE-SEAL / NO-GO
```

---

# 15. 本轮不允许继续做的事情

特别禁止：

```text
“顺便再优化 QA”
“顺便把 Token 再砍一点”
“顺便改 Revision prompt”
“顺便整理旧 stage enum”
“顺便删除 Legacy code”
“顺便优化 Story Memory”
“顺便升级 schema”
“顺便改模型配置”
```

这些都属于下一期工程，不得混入 Final-Seal 收尾。

---

# 16. 推荐执行顺序

```text
C0
锁定 Final Production HEAD
↓ GO

C1
Final HEAD Needs-Revision live
↓ GO

C2
Remote Verify + Generation Stability SUCCESS
↓ GO

C3
Final-Seal 报告修正
↓ GO

C4
docs-only final commit
↓
PHASE 2 FINAL SEALED / GO
```

---

# 17. Agent 执行纪律

Agent 必须：

- 以 `F:\ClaudeWorkSpace\projects\TAVO-MINI` 为唯一施工基线；
- 开工先 fetch 最新远端；
- 不动主流水线；
- 不人为制造 QA finding；
- 不改数据库伪造 Revision；
- 不清 App 数据；
- 只使用 `adb install -r`；
- 实机 Bug 必须先 Red Test；
- 生产代码一旦变化，所有 Final HEAD 证据全部作废并重跑；
- Remote CI 未 SUCCESS 不得写 PASS；
- 报告 SHA 必须逐字段准确；
- 未覆盖 Needs-Revision live 不得宣布 GO。

---

# 18. 最终目标

这一轮结束后应该得到：

```text
Production Code
= 不再修改

Needs-Revision Path
= Final HEAD 实机闭环

Remote CI
= 双 Workflow SUCCESS

Final Report
= SHA / Live / CI 三线一致

PHASE 2
= FINAL SEALED / GO
```

> **本轮不是继续改产品，而是把最后一个真实执行分支和最后一层远端证据补齐。**
