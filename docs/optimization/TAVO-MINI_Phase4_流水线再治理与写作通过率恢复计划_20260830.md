# TAVO-MINI Phase IV：流水线再治理与写作通过率恢复计划
## Gate 减法、JSON 协议瘦身、Governor 旁路化与 Context 阻滞治理

> 方案版本：Phase-IV v1.0  
> 编制日期：2026-08-30  
> 施工仓：`F:\ClaudeWorkSpace\projects\TAVO-MINI`  
> 远端仓：`anjingdtl/tavo-mini`  
> 编制时远端基线 HEAD：`64b88580c134f67e3fb73d1951ef6bc972da5552`  
> 基线提交：`feat(phase3-c): checkpoint c10 runtime stability gate`  
> Agent 开工时必须重新 `git fetch` 并以真实 `origin/main` 为准。  
> C8 Durable Resume 与 C9 Observability 作为已验证底层能力保留；旧 C10 不继续施工、不删除，作为历史 checkpoint 保留。

---

# 0. 背景与问题定义

A/B/C 三轮提高了上下文一致性、数据安全、可观测性、失败分类、Resume、Provider Capability 与运行时学习能力，但也出现复杂度反噬：

1. **Gate 与 JSON Contract 堆叠**
   - 模型承担过多非写作协议任务；
   - QA/Revision 结构化输出和校验成本上升；
   - 单个 Gate 正确，但 E2E 一次通过率下降；
   - 文学质量问题与状态安全问题混在同一 fail-closed 体系。

2. **Context 控制过度**
   - Stage 输入持续膨胀；
   - Mandatory / Optional 边界不足；
   - Context / Budget / Governor 多层控制形成额外阻滞；
   - 大章节容易 preflight block、length 或超长耗时。

3. **Governor 偏离旁路定位**
   - Production Ready、Bootstrap、Counterfactual、Preflight 等逐渐进入当前请求决策；
   - 调优器拥有当前请求否决权。

4. **验收重心偏移**
   - 从“用户一次发起能否拿到可采纳正文”，变成“失败是否安全、协议是否完整”。

Phase IV 专门治理上述复杂度反噬。

---

# 1. 总目标

> **后台能力可以复杂，正常写作主链必须重新简单、高通过率、高效率。**

目标优先级：

```text
1. End-to-End First-Pass Adoptable Rate
2. 正文质量与一致性
3. 状态 / 数据 / 付费安全
4. 流水线总耗时
5. Physical Call 稳定
6. Token / Budget 效率
```

安全 P0 不退让，但不再允许为了工程协议完整而牺牲正常写作通过率。

---

# 2. 当前远端基线

编制时远端状态：

```text
C0-C7  已有成果保留
C8     Durable Resume GO
C9     Cost / Latency / Observability GO
C10    IN PROGRESS / user-directed stop
C Final Seal 未完成
```

Phase IV 开始后：

```text
冻结旧 C10
不继续扩展旧 C10
不删除历史证据
不宣告 C Final GO
```

C8 Resume 与 C9 Observability 直接继承。

---

# 3. Phase IV Benchmark

C9 当前真实聚合：

```text
paid request denominator = 38
length = 5 / 38 = 13.16%
outcome_unknown = 1 / 38 = 2.63%

provider latency:
p50 ≈ 187.7s
p95 ≈ 337.8s
```

代表性 Standard Clean：

```text
Final ≈ 2006 字

Draft:
input = 42081
output = 17851
reasoning = 15534
visible = 2317
provider ≈ 299.5s

QA:
input = 24349
output = 1455
reasoning = 1324
visible = 131
provider ≈ 25.7s

Total:
physical calls = 2
total tokens = 85736
```

Phase IV 必须证明：

```text
通过率提高
+ 总耗时下降
+ 无效协议成本下降
+ Context 输入下降
+ P0 安全不退化
```

---

# 4. 目标写作主链

## Clean Path

```text
Freeze
  ↓
Draft
  ↓
Compact QA
  ↓
Persist
```

## Revision Path

```text
Freeze
  ↓
Draft
  ↓
Compact QA
  ↓ Issue
Revision
  ↓
Persist
```

Final Validate 可保留，但应成为本地轻量 `Persistence Boundary`，不得发展成新的复杂 LLM Stage。

---

# 5. 核心原则

## 5.1 正文优先

模型最重要的产物：

```text
Draft = 正文
Revision = 完整修订正文
QA = clean / revise + 最小 findings
```

本地程序能完成的工作不得强迫模型输出。

## 5.2 安全问题与质量问题分离

状态 / 数据安全不确定：

```text
Fail Closed
```

文学质量不确定：

```text
Advisory / 保留正文
```

轻微文风、重复、字数偏差、非关键 QA 不确定，不得轻易让整章失败。

## 5.3 Hard Gate 只保护真正安全边界

只有可能造成以下后果时才允许 Hard Block：

- 数据损坏；
- 重复付费；
- 截断正文落库；
- `outcome_unknown` 重发；
- Mandatory Truth 丢失；
- Canon / 长期状态明确污染；
- Provider / Context 硬能力数学上无法完成；
- DB transaction 失败。

其他 Gate 默认：

```text
DOWNGRADE TO ADVISORY
MERGE
LOCAL NORMALIZE
REMOVE
```

## 5.4 Governor Never Blocks Current Request

Governor 是旁路后管理与下一轮调优器。

可以：

```text
observe
aggregate
learn
recommend-next
slow-tighten-next
fast-expand-next
```

不可以：

```text
block current request
reject current request
create LLM call
retry
change pipeline stage
judge body
judge JSON
judge persistence
```

---

# 6. JSON Contract 再治理

## Draft

保持纯正文，禁止新增 JSON Envelope。

## QA

目标压缩为：

```json
{"decision":"clean"}
```

或：

```json
{
  "decision":"revise",
  "findings":[
    {"type":"continuity","target":"第三段"}
  ]
}
```

以下默认退出正常必填协议：

```text
analysis
confidence
evidence
explanation
diagnostics
stateProposal
```

仅服务工程诊断的信息进入 Receipt / Telemetry。

## Revision

首要输出：

```text
完整修订正文
```

Optional Sidecar 只在必要状态变化时存在。

以下全部本地计算：

- Hash；
- Fingerprint；
- Diff；
- ChangeSet；
- 长度；
- 默认字段；
- 版本信息；
- Profile 状态。

若 State Proposal 非法但正文完整，优先丢弃状态变化并保留正文候选；只有明确会污染 Canon / 持久状态时才阻断正文。

---

# 7. Gate Inventory

全量盘点 A/B/C 新增 Gate。

每个 Gate 必须记录：

```text
名称
Stage
触发位置
业务目的
是否阻断
失败后果
保护对象
是否重复
是否需要 LLM
是否需要 JSON
是否能本地归一化
移除后的最坏风险
```

最终只能分类：

```text
KEEP HARD BLOCK
DOWNGRADE TO ADVISORY
MERGE
REMOVE
```

---

# 8. Context Throughput 再治理

统一为：

```text
Mandatory Context
+
Elastic Optional Context
```

## Mandatory

必须完整：

- 当前任务；
- 当前章节目标；
- 核心 Outline；
- 必要 Canon；
- 必要 Story State；
- Seam / Continuity Anchor；
- Writer Style 核心约束；
- 必要 Source Boundary。

## Optional

允许动态压缩：

- 历史章节；
- 扩展人物资料；
- 扩展世界书；
- 笔记；
- Episodic；
- 辅助检索；
- 重复摘要；
- 低相关资源。

Context 不足时必须：

```text
先压 Optional
↓
去重复
↓
缩低相关资源
↓
保留 Mandatory
↓
尽量发请求
```

真正允许 Hard Block 的 Context 条件只有：

```text
Mandatory Context
+
最低可见正文需求
+
合理 reasoning 空间
>
Provider / Model Hard Capability
```

## Stage-Specific Context

Draft 获取完整写作真相，但删除重复和低相关资料。

QA 重点只需要：

- Draft 正文；
- 当前任务；
- 必要 Outline；
- 必要 Canon / Continuity；
- 少量关键上下文。

Revision 重点只需要：

- Draft；
- QA findings；
- Mandatory Truth；
- 必要 Context。

禁止把 Draft 的 Optional Context 无脑复制到 QA / Revision。

---

# 9. Governor 旁路化

```text
Current Request
↓
Safe Runtime Baseline
↓
Hard Capability Clamp
↓
LLM
↓
Receipt
     │
     └── Governor Observe
                ↓
          Next Request Recommendation
```

Governor 状态 `BOOTSTRAP_SAFE / PROBATION / ACTIVE / TRIPPED` 可以保留，但只影响下一轮调节速度与方向，不影响当前请求能否发送。

---

# 10. 核心 KPI

至少统计：

```text
E2E First-Pass Adoptable Rate
Draft Success Rate
QA Clean Rate
Revision Success Rate
Context Block Rate
Local Gate Reject Rate
JSON / Parse Reject Rate
length Rate
outcome_unknown Rate
Manual Recovery Rate

physical calls
input tokens
output tokens
reasoning tokens
visible tokens

queue p50/p95
provider p50/p95
total p50/p95
```

最高优先指标：

# End-to-End First-Pass Adoptable Rate

定义：

> 用户发起一次正常写作，不改设置、不重开任务、不手动 retry，最终得到可采纳正文。

---

# 11. Throughput Regression Gate

所有主链改动必须跑：

```text
500
1000
3000
较大章节

× Fast
× Standard
× Quality
```

每格标记：

```text
一次完成
Draft
QA
Revision
JSON failure
Context block
length
unknown
总耗时
physical calls
```

若安全指标改善但 First-Pass Success 明显下降，默认 `NO-GO`，除非修复的是数据损坏、重复收费、截断正文持久化、Canon 污染等 P0。

---

# 12. Phase IV 分阶段

## IV-0 — Baseline & Blocking Pareto

目标：不改生产逻辑，先把当前阻滞拆清楚。

工作：

1. 冻结 Phase IV Baseline；
2. 聚合已有 C3-C9 Receipt；
3. 建立 Gate / JSON / Context / Failure 分类；
4. 做 Blocking Pareto；
5. 找到历史通过率治理后的稳定版本作为对照。

输出：

```text
docs/optimization/phase4-baseline-and-blocking-pareto.md
```

GO：根因分布可解释、历史证据无篡改、无生产逻辑改动。

---

## IV-1 — Gate Inventory & Simplification

目标：显著减少主链 Hard Gate。

工作：

- 删除重复 Gate；
- 质量类 Gate 降级 Advisory；
- 合并最终 Persistence Safety；
- 正常 Clean Path 只保留少数安全 Gate。

GO：

- Hard Gate 数量显著下降；
- P0 Gate 保留；
- E2E 不下降；
- Physical Calls 不增加。

---

## IV-2 — JSON Contract Reduction

目标：让模型重新主要负责写作。

工作：

- QA Contract 极简化；
- Revision 正文优先；
- 本地计算 Hash/Fingerprint/Diff/ChangeSet；
- 非必要 State Proposal 退出正常 Contract。

GO：

- QA / Revision JSON 明显缩小；
- JSON/parse failure 下降；
- reasoning/visible 比例改善；
- QA / Revision latency 下降；
- E2E 提高或持平。

---

## IV-3 — Governor Bypass Refactor

目标：Governor 完全退出当前请求阻断链。

工作：

- 移除 Governor 对当前请求的 `preflightBlocked` 否决；
- `productionReady` 等只保留为调优状态；
- Prior 只影响 next-request recommendation；
- 当前请求使用 Safe Baseline + Hard Capability；
- length 只影响下一轮 Fast Expand；
- unknown 不学习。

GO：

```text
Governor current-request blocking = 0
Governor physical calls = 0
无固定业务 maxTokens
First-Pass 不下降
length 不升高
```

---

## IV-4 — Context Throughput Re-governance

目标：Context Controller 从 Gate 变回资源管理器。

工作：

- Mandatory / Optional 正式分层；
- Stage-specific Context；
- 去重；
- QA / Revision 不复制无关 Optional；
- 增加 Input Composition Receipt；
- Optional 压缩优先于 block。

重点 Benchmark：

```text
当前 Draft input ≈ 42K
当前 QA input ≈ 24K
```

GO：

- Context block rate 下降；
- Draft / QA input 显著下降；
- Mandatory Truth 完整；
- E2E success 提升；
- latency 改善。

---

## IV-5 — Persistence Boundary Consolidation

目标：把分散的状态安全 Gate 收拢到最终落库边界。

工作：

- 统一 Final Candidate；
- 正文完整性；
- Canon / State mutation 安全；
- DB transaction；
- Idempotency；
- 继承 C8 Resume。

GO：

- 不重复 Persist；
- 不持久化截断正文；
- State Sidecar 非法时可安全舍弃；
- 正文与状态更新解耦；
- 不新增 LLM 调用。

---

## IV-6 — Historical A/B Throughput Recovery

对比：

```text
历史通过率治理稳定版本
vs
Phase IV Baseline
vs
Phase IV 当前版本
```

比较：

- E2E First-Pass；
- latency；
- input/output/reasoning；
- JSON failure；
- Context block；
- length；
- unknown；
- physical calls。

GO：

```text
Phase IV ≥ 历史稳定版本通过率
且
显著优于 Phase IV Baseline 的效率/阻滞指标
```

---

## IV-7 — Continuous Real Android Seal

真实：

```text
5章
10章
```

第一指标：

```text
多少章一次完成
```

同时验证：

- Governor 只旁路；
- Context 不持续膨胀；
- Resume；
- Physical Calls；
- DB integrity；
- no crash/ANR；
- no hidden retry。

---

## IV-8 — Final Simplification Seal

创建：

```text
docs/optimization/phase4-requirement-closure.md
docs/optimization/phase4-final-report.md
```

最终必须回答：

1. Hard Gate 从多少降到多少；
2. JSON Contract 减少多少；
3. Draft / QA / Revision input 降低多少；
4. First-Pass 成功率提升多少；
5. p50/p95 latency 改善多少；
6. length / context block / JSON failure 下降多少；
7. Governor 是否完全旁路；
8. C8 Resume / C9 Observability 是否保持；
9. P0 安全是否全部保留；
10. 是否回到正常写作链而不是工程协议链。

全部 Required Gate PASS 后才允许：

```text
PHASE IV FINAL SEALED / GO
```

---

# 13. P0

任一违反立即 NO-GO。

```text
P0-01 Thinking Always On
P0-02 不新增 Agent / Multi-Agent
P0-03 不新增第二 Writer / Context / Memory / Prompt Compiler
P0-04 Mandatory Truth 不得因 throughput 优化被裁掉
P0-05 finishReason=length 不持久化为 Final
P0-06 outcome_unknown 永不自动 retry
P0-07 Governor 不阻断当前请求
P0-08 Governor physical call = 0
P0-09 禁止固定业务 maxTokens
P0-10 所有 Physical Paid Calls 如实计账
P0-11 Android 只允许 adb install -r，禁止 uninstall / pm clear
P0-12 Resume / Idempotency 不退化
P0-13 不因删除 Gate 而允许 Canon / Story Memory 污染
```

---

# 14. 每阶段 PDCA

IV-0 ~ IV-8 必须：

```text
PLAN
→ RED
→ DO
→ CHECK-A
→ CHECK-B
→ ACT
→ GO / NO-GO
```

PLAN 先写入：

```text
docs/optimization/phase4-progress.md
```

Red-first：先证明当前问题，再最小修复。

CHECK-A：

```text
targeted Jest
typecheck
lint -- --quiet
verify:elastic
verify
```

CHECK-B：

```text
apk:debug
SHA-256
adb install -r
真实 Android LLM
DB
Receipt
UI
logcat
```

阶段 NO-GO：

```text
留在当前阶段
→ root cause
→ 最小纠偏
→ 重跑 PDCA
```

---

# 15. Agent 自主权限

Agent 可自主：

- 修改源码；
- 删除/合并冗余 Gate；
- 瘦身 JSON；
- 重构 Governor 为旁路；
- 重构 Context 组合；
- 修改测试；
- 写 migration；
- 编译 APK；
- `adb install -r`；
- 使用已有真实 Android LLM；
- 收集安全证据；
- commit；
- push；
- 自动进入下一阶段。

不需要每阶段人工确认。

---

# 16. 必须停下请求人工决策的情况

只有：

1. 必须改变成熟 Writing Pipeline 为新 Agent 架构；
2. 必须关闭 Thinking；
3. 必须牺牲 Mandatory Truth；
4. 必须允许 unknown 自动 retry；
5. 必须破坏 Resume / Idempotency；
6. 必须引入长期 Story Memory / Retrieval 新架构；
7. Git / 用户数据存在无法安全判断的冲突；
8. 真实证据证明“主链减法”方向造成不可接受的正文质量退化。

除此之外不得等待人工确认。

---

# 17. Git 纪律

建议：

```text
docs(phase4): establish throughput recovery baseline
refactor(phase4): simplify blocking gates
refactor(phase4): reduce qa revision contracts
refactor(phase4): move governor off request blocking path
refactor(phase4): reduce stage context pressure
refactor(phase4): consolidate persistence safety boundary
test(phase4): seal historical throughput comparison
test(phase4): seal continuous android writing
docs(phase4): final simplification seal
```

---

# 18. 最终执行原则

```text
用户点一次生成，
目标是尽可能一次拿到可采纳正文。

后台复杂度不得转嫁给正常写作主链。

Gate 只保护真正的安全边界。

JSON 只保留机器真正需要的最小协议。

Context 先压 Optional，不是先阻断用户。

Governor 观察这一轮，调优下一轮，
永远不拉当前请求总闸。

正文优先，
状态安全，
通过率优先，
效率恢复。
```
