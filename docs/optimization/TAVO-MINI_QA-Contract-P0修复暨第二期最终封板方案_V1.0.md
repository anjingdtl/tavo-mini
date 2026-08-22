# TAVO-MINI QA Contract P0 修复暨第二期最终封板方案 V1.0

**项目：** TAVO-MINI / ShineWriter  
**本地施工基线：** `F:\ClaudeWorkSpace\projects\TAVO-MINI`  
**当前远端 main：** `2b2973902e198f440f61b914d1a3d6b3c1520290`  
**当前生产代码基线：** `d9b603df81006e417a24890a3665911fe196d135`  
**当前版本：** `V2.11.54`  
**工程性质：** QA Contract P0 修复 + 第二期最终封板收束  

---

# 0. 当前状态

上一版 C1 要求持续跑真实 Standard，直到自然出现：

```text
QA executable finding
→ Revision=1
```

该 Gate 已被实际验证为不合理。

最新实机结果：

```text
15 个真实 Standard 章节
Draft = 1
QA = 1
Revision = 0
```

其中多次 QA 已明确指出硬约束问题，但实际没有形成符合 Revision Trigger Contract 的结构化 findings，所以 Revision 全部跳过。

结论：

```text
C1 CANCELLED
原因：概率型 live gate 设计错误

新发现 P0：
QA Structured Contract Admission Gap

当前状态：
PHASE 2 PRE-SEAL / BUG FOUND
```

---

# 1. 根因

## 1.1 Prompt Contract 已经严格

QA Prompt 要求：

```text
verdict = pass | needs_revision
findings 必须存在
pass → findings=[]
每条 finding 应有：
severity
target / requirementIds
issue
instruction
```

## 1.2 Admission Contract 却过于宽松

当前 QA 即使只返回：

```json
{
  "verdict": "needs_revision",
  "content": "发现一个阻塞性问题……"
}
```

也可能被判定为结构化报告有效。

但它缺少：

```text
findings[]
severity
target
instruction
requirementIds
```

## 1.3 Aggregator 会把普通文本降级成 info

找不到 structured.findings 时，普通 body/content 最终会被归一化成：

```text
issue = QA 普通文本
severity = info
target = ""
instruction = ""
requirementIds = []
```

而 Compact Revision Trigger 要求：

```text
severity = blocking | warning
AND
可定位
AND
可执行
```

所以 Revision 必然跳过。

---

# 2. 本轮正确目标

建立严格一致的 QA Structured Contract：

```text
Prompt Contract
=
Admission Contract
=
Persistence Contract
=
Aggregator Contract
=
Revision Trigger Contract
```

不得再出现：

```text
Prompt 说 findings 必须有
但 Admission 认为 content/verdict 就够
```

---

# 3. 架构红线

以下全部冻结：

```text
ONE Production Entry
ONE Writing Kernel
ONE Shared Writer Core
ONE Shared Prompt Compiler architecture
ONE Context
ONE Memory
ONE Flow
Compact Standard DAG
Final Candidate Contract
Revision Trigger semantics
Compact Ledger
One-Shot
Legacy Resume
Elastic Context Budget
Semantic Apply
Story Memory
```

禁止：

```text
新增第二 QA
新增 FinalQA / Proof / AI Judge
新增 LLM Classifier
新增固定 Token cap
修改 One-Shot
修改 Legacy topology
大规模重构 Writer Core
放松 Revision Trigger
```

---

# 4. Strict QA Admission Contract

Compact Standard 的 QA 必须满足：

## 4.1 verdict

只能是：

```text
pass
needs_revision
```

其他值一律 invalid。

## 4.2 findings

必须是数组。

### pass

```text
verdict = pass
findings = []
```

如果 pass + 非空 findings：

```text
invalid
```

### needs_revision

必须：

```text
verdict = needs_revision
findings.length >= 1
```

且每条 finding 必须：

```text
issue 非空
severity ∈ {blocking, warning}

target 非空
OR
requirementIds 至少一个

instruction 非空
OR
target 非空
```

不满足则整份 QA invalid。

---

# 5. 禁止自然语言启发式补 Finding

不得新增：

```text
文本含“阻塞性问题”
→ 自动 severity=blocking
```

不得新增：

```text
正则自动抽 target
自动生成 instruction
自动补 requirementIds
```

Revision 必须依赖结构化合同，而不是自然语言猜测。

---

# 6. QA Invalid 的唯一恢复路径

只允许复用现有 Formatter，最多一次：

```text
QA Primary
↓
Strict QA Validate
│
├─ VALID
│   → Persist QA
│   → Revision Trigger
│
└─ INVALID
    ↓
 Existing QA Formatter ×1
    ↓
 Strict QA Validate Again
    │
    ├─ VALID
    │   → Persist QA
    │   → Revision Trigger
    │
    └─ INVALID
        → FAIL CLOSED
```

Formatter 只能整理 Primary 已经表达的语义，不得重新审阅、重新读长上下文或新增问题。

---

# 7. 代码修改边界

优先最小修改：

```text
src/services/writing/stages/writerRecovery.ts
src/services/writing/stages/writerCore.ts
```

如确有必要，可新增纯本地函数：

```text
validateQaStructuredContract()
```

职责建议：

```text
writerRecovery
→ 候选选择 / adoption

writerCore
→ 最终 strict QA validation

findingsAggregator
→ 只消费合法 structured findings
```

不得让 Aggregator 负责“修复”非法 QA。

---

# 8. 必须先写 Red Tests

## Case 1 — pass 正常

```json
{
  "verdict": "pass",
  "content": "未发现必须修改的问题",
  "findings": []
}
```

期望：

```text
Primary accepted
Formatter=0
Revision=0
```

## Case 2 — needs_revision 完整

```json
{
  "verdict": "needs_revision",
  "content": "发现硬约束问题",
  "findings": [{
    "severity": "blocking",
    "target": "交付动作",
    "issue": "交付发生过晚",
    "instruction": "把交付提前",
    "requirementIds": ["R1"]
  }]
}
```

期望：

```text
Primary accepted
Formatter=0
Revision=1
```

## Case 3 — 真实失败 fixture：只有 content

```json
{
  "verdict": "needs_revision",
  "content": "发现一个阻塞性问题：水漫上第一步后才完成交付……"
}
```

旧行为：

```text
accepted → Revision skip
```

新行为：

```text
Primary invalid → Formatter once
```

## Case 4 — Formatter 修复成功

Formatter 返回完整 findings。

期望：

```text
QA completed
formatterUsed=true
QA physical=2
Revision=1
```

## Case 5 — Formatter 仍非法

期望：

```text
QA failed
Revision=0
Persist final chapter=0
Fail Closed
```

## Case 6 — pass + findings 非空

期望：

```text
invalid
```

## Case 7 — needs_revision + info

期望：

```text
invalid
```

## Case 8 — needs_revision + 无 target/requirementIds

期望：

```text
invalid
```

## Case 9 — needs_revision + 无 instruction 且无 target

期望：

```text
invalid
```

---

# 9. Cross-Action / Durable 回归

必须证明：

```text
QA Primary/Formatter
→ 合法 structured findings
→ durable persist
→ action/resume boundary
→ Revision preload QA
→ Revision exactly once
```

要求：

```text
Duplicate QA=0
Duplicate Formatter=0
Duplicate Revision=0
```

---

# 10. Continuation 回归

Compact Continuation 仍只能有：

```text
draft_writer
unified_qa
revision_writer
final_validate
```

Needs-Revision 时：

```text
revision_writer=success
request_count=1
```

不得出现：

```text
narrative_architect
adversarial_auditor
final_reviser
```

---

# 11. One-Shot 回归

必须保持：

```text
Draft=1
QA=0
Formatter=0
Revision=0
```

One-Shot 不得进入 strict QA validator。

---

# 12. 正式废弃概率型 C1

禁止再执行：

```text
继续跑章节
直到自然出现 Revision
```

原因：

```text
非确定
无成本上限
不能证明代码正确
会诱发人为操纵 Prompt/输入
```

---

# 13. 新封板验证模型

只保留两层：

```text
A. Deterministic Contract Integration
B. Real LLM Smoke
```

---

# 14. A — Deterministic Contract Integration

这是 Needs-Revision 的主要封板证据。

必须用：

```text
15 次 live 中的真实失败 QA fixture
+
production code path
```

证明：

```text
invalid Primary
→ Formatter once
→ valid QA
→ durable persist
→ Revision exactly once
→ FinalValidate
→ Persist
```

尽量穿透生产函数，不只测试孤立 helper。

关键断言：

```text
Primary logical QA=1
Formatter=1
Revision logical=1

QA physical=2
Revision physical=1

Review=0
Audit=0
FactCheck=0
Proof=0

No duplicate paid call
```

---

# 15. B — Real LLM Smoke 调用预算

真实 LLM 最多：

```text
Outline Standard ×1
Continuation Standard ×1
```

总计最多：

```text
2 个 Standard 章节
```

禁止再跑 3、5、10、15 章撞概率。

Smoke 只证明：

```text
严格 QA Contract
+
真实模型
+
Final HEAD
```

可以正常完成生产流程。

每章记录：

```text
Draft
QA
Formatter
Revision
physical calls
tokens
FinalValidate
Persist
PostWriting
```

如果自然触发 Revision：

```text
作为 bonus live evidence
```

如果没有：

```text
不继续追加章节
```

---

# 16. Formatter 成本门禁

2 个 smoke 中：

```text
0 次 Formatter
→ 最理想

偶发 1 次
→ 可接受，必须记录

2/2 都用 Formatter
→ NO-GO
```

说明 Primary QA schema 遵从性仍过低。

---

# 17. Full Regression Gate

必须：

```text
npm run verify
Phase 2 Generation Stability
Migration
Android Debug
```

要求全部 PASS。

Android 安装：

```text
adb install -r
```

禁止：

```text
adb uninstall
pm clear
```

---

# 18. Remote CI Gate

Push 后必须确认：

```text
Verify = SUCCESS
Generation Stability = SUCCESS
```

不得再用：

```text
local workflow-equivalent
```

代替最终远端 CI。

---

# 19. Final HEAD 重新冻结

本轮只要生产代码发生变化：

```text
d9b603d
```

即不再是 Final Production HEAD。

必须记录新的：

```text
finalProductionCodeHead=<new sha>
```

后续：

```text
verify
android
smoke
remote CI
```

全部绑定新 SHA。

---

# 20. Final Report 更新

更新：

```text
docs/optimization/TAVO-MINI_第二期_Final-Seal_最终封板报告_20260820.md
```

必须明确：

```text
旧 C1 cancelled
原因：概率型 Gate 设计错误

新发现：
QA Structured Contract Admission Gap

修复：
Strict QA Contract + one Formatter + fail closed

Needs-Revision：
Deterministic production-path integration PASS

Real LLM：
最多 2 个 smoke
```

---

# 21. 最终封板矩阵

## Architecture

```text
ONE Production Entry=1
ONE Kernel=1
ONE Writer=1
ONE QA=1
ONE Context=1
ONE Memory=1
```

## Clean Standard

```text
Draft=1
QA=1
Revision=0
```

## Needs Revision — Deterministic

```text
QA invalid Primary
→ Formatter<=1
→ valid executable findings
→ Revision=1
```

或：

```text
QA valid Primary
→ Revision=1
```

## One-Shot

```text
Draft=1
QA=0
Revision=0
```

## Old Stages

```text
Review=0
Audit=0
FactCheck=0
Proof=0
```

## Contract

```text
Prompt Contract
=
Admission Contract
=
Revision Contract
```

## Runtime

```text
No duplicate paid call
No hidden retry
Formatter<=1
Formatter not default
Invalid QA → fail closed
```

## Persistence

```text
FinalValidate PASS
Persist PASS
PostWriting PASS
Story Memory PASS
```

## CI

```text
Verify remote SUCCESS
Generation Stability remote SUCCESS
```

## Real LLM Budget

```text
Outline Standard<=1
Continuation Standard<=1
Total<=2
```

---

# 22. 最终 GO / NO-GO

只有全部满足才允许：

```text
PHASE 2 FINAL SEALED / GO
```

以下任一出现：

```text
非法 QA 仍直接 accepted
非法 QA 被当 Clean
Formatter 重复调用
Formatter 成为默认路径
Revision 重复付费
One-Shot 被引入 QA
Remote CI 未成功
```

则：

```text
NO-GO
```

---

# 23. 推荐 Commit

生产修复：

```text
fix(writing): enforce strict compact qa structured contract
```

测试可同 commit 或单独：

```text
test(writing): lock strict qa admission and revision dispatch
```

最终文档：

```text
docs(writing): seal phase-two after qa contract closure
```

---

# 24. Agent 执行纪律

- 以 `F:\ClaudeWorkSpace\projects\TAVO-MINI` 为唯一施工基线；
- 开工先 fetch 最新 main；
- 停止所有“继续跑直到 Revision 出现”的测试；
- 优先使用 15 次真实失败产物构造 Red fixture；
- 先 Red Test 再修；
- 只修 QA Structured Contract Admission；
- 不放松 Revision Trigger；
- 不用自然语言 regex 自动制造 blocking finding；
- Formatter 最多一次；
- Formatter 失败必须 fail closed；
- One-Shot 不受影响；
- 生产代码变化后重新冻结 Final Production HEAD；
- 真实 LLM 最多 2 个 Standard smoke；
- 不得超预算继续刷章节；
- Remote CI 必须真实 SUCCESS；
- 最终报告必须如实记录旧 C1 被取消及原因。

---

# 25. 最终原则

> **这次不再用概率证明代码。**

> **Needs-Revision 是否正确，由确定性的契约测试和生产路径 integration test 证明。**

> **真实 LLM 只做兼容性 smoke，不再承担“直到碰到某随机结果”为止的封板责任。**

> **修复的是 QA 契约闭环，不是为了测试通过而放宽 Revision Trigger。**
