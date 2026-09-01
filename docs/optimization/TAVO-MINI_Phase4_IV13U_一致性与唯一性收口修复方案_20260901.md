# TAVO-MINI Phase IV-13U 一致性与唯一性收口修复方案
## Uniqueness & Consistency Closure Repair Plan
### Candidate Identity、ONE Receipt、ONE Final Contract、Current Authority 与 Final Seal

> 版本：v1.0  
> 日期：2026-09-01  
> 本地施工仓：`E:\AiWorkSpace\tavo-mini`  
> 远端仓：`anjingdtl/tavo-mini`  
> 编制时远端最新已知 HEAD：`0b1f6c87a8bd767a057cc39c1ff9bf572cb419df`  
> 编制时基线阶段：`PHASE IV FINAL SEAL HOLD / NO-GO`  
> Agent 开工后必须先 `git fetch origin` 并重新确认真实 `origin/main`。若远端 HEAD 已变化，以实际代码为准重建基线，不得机械套用本文中的历史 SHA。
> 执行后当前状态以 [`phase4-iv13u-progress.md`](phase4-iv13u-progress.md) 为唯一 SSOT；本轮闭环结果为 `PHASE IV FINAL SEALED / GO`。

---

# 0. 本轮定位

Phase IV 的核心 Writing Pipeline 不再扩建。

当前已完成并已有真实 Android / deterministic 证据的能力包括：

- Final Plain-Text Integrity 主体建设；
- 大纲创作精准修订；
- 大纲创作整章重写；
- 原著续写精准修订；
- 原著续写整章重写；
- Pre-Adoption Candidate Revision；
- Post-Adoption Revision；
- Targeted Patch 的 UTF-16 范围保护；
- Unselected Text Preservation；
- Thinking Always On；
- Governor 旁路；
- User Revision 后重新进入既有 PostWriting / ONE Memory；
- 大纲 3 章批量已通过；
- 原著续写 B1/B2 已通过；
- 编制时原著续写 B3 3章批量仍未完成 Final Seal；执行闭环后已由独立 continuation 批次完成。

在此基础上，对当前实现按照“唯一性原则”进行对抗性审查后，发现仍存在几个必须在正式封板前消除的结构性不一致：

1. **Result Page 显示对象与 Revision Candidate 可能不是同一个对象**  
   当前某些 Pre-Adoption Revision 路径仍会根据 `chapterId` 再查询 `latest task/run`，而不是使用当前结果页明确持有的 `taskId/runId`。

2. **模型物理请求存在第二套 Receipt / Observability Authority**  
   Writing Kernel 已有 `WritingRequestReceipt`，User Revision 又维护 `UserRevisionReceipt`；且用户 Discard Preview 或 App 中断时，付费请求事实存在不能 durable 落账的风险。

3. **Final Body Legality 仍存在双重技术规则 Authority**  
   `plainTextNovelBody` 已是共享正文合同，但 Outline 的 `finalArtifactValidator` 仍独立维护部分 prompt/patch/anchor 技术泄漏规则，导致不同写入路径可能对同一正文给出不同结论。

4. **Continuation 一个 Run 内可能存在多个“eligible final”**  
   历史版本应保留，但 Current Final Authority 不能依赖“所有 eligible 中取 latest”这种隐式推导。

5. **Generation History 与 Current Chapter Revision 的语义边界还不够显式**  
   原始 `WritingPersistedEvent` 是不可变历史，新修订正文 fingerprint 才是当前正文 authority；必须防止未来代码重新把历史事件当成 current-state source。

6. **Phase IV 当前状态、Final Seal 文档与验收分母还未收敛为唯一口径**  
   旧 IV-12 GO 与新 IV-13 HOLD 不能同时以“当前状态”存在；混合统计口径不得与 B3 pending 并存。

本轮目标不是继续优化文学质量、Prompt、Context 或 Provider，而是：

> **把“当前正在操作谁、当前正文是谁、当前 Final 是谁、一次模型调用由谁记账、最终正文由谁判合法、Phase IV 当前到底是什么状态”全部收敛成唯一 Authority。**

---

# 1. 总体治理原则

## 1.1 一致性原则

```text
同一个业务对象
→ 同一个显式身份

同一个当前状态
→ 同一个 Current Authority

同一次物理模型请求
→ 同一个 Durable Receipt Authority

同一份最终正文
→ 同一个 Technical Legality Contract

同一个章节当前正文
→ 同一个 Revision Fingerprint Authority

同一个 Phase IV 当前结论
→ 同一个 Status SSOT

同一个验收指标
→ 同一个分子 / 分母 / 计算公式
```

## 1.2 唯一性原则

任何地方一旦出现：

```text
UI 显示 A，但后台重新 latest 得到 B
多个对象都叫 current / eligible
两个模块分别判断“最终正文是否合法”
两个 Receipt 都声称自己记录物理请求
旧状态和新状态都声称是 Current
```

一律视为架构缺陷，而不是普通代码风格问题。

---

# 2. 不得破坏的既有边界

正常 Writing Pipeline 保持：

```text
Freeze
→ Draft
→ ONE QA
→ optional Revision
→ FinalValidate
→ Persist
→ PostWriting / ONE Memory
```

本轮禁止新增：

- 第二 Writer；
- 第二 QA；
- 第二 Context Builder；
- 第二 Memory；
- 第二 Prompt Compiler；
- 第二 Final Validator Authority；
- 第二 Request Receipt Authority；
- Agent Loop；
- hidden retry；
- 自动 re-plan；
- Formatter LLM；
- Governor 当前请求 Gate；
- 新正常生产 LLM Stage；
- 固定业务 `maxTokens`；
- `outcome_unknown` 自动重发。

继续保持：

```text
Thinking Always On
Governor physical call = 0
Android 只 adb install -r
禁止 adb uninstall
禁止 pm clear
```

---

# 3. 本轮阶段拆分

本轮定义为：

# `Phase IV-13U — Uniqueness & Consistency Closure`

按以下板块分别执行完整 PDCA：

```text
IV-13U-0  Baseline / Authority Inventory
IV-13U-1  Candidate Identity SSOT
IV-13U-2  ONE Durable Request Receipt
IV-13U-3  ONE Final Body Legality Contract
IV-13U-4  Current Final Candidate Authority
IV-13U-5  Current Revision / PostWriting Authority
IV-13U-6  Status / Metrics / Evidence SSOT
IV-13U-7  Minimal Android Regression + B3 Final Seal
```

每一个板块必须单独完成：

```text
PLAN
→ RED
→ DO
→ CHECK-A
→ CHECK-B（该板块需要真机时）
→ ACT
→ GO / NO-GO
```

任何阶段 NO-GO：

```text
保留失败证据
→ Root Cause
→ 最小修正
→ 重跑该阶段
```

不得跳过 RED，不得用“看起来没问题”代替证明。

---

# 4. IV-13U-0 — Baseline / Authority Inventory

## PLAN

开工先执行：

```text
cd /d E:\AiWorkSpace\tavo-mini
git fetch origin --prune
git status
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
```

记录：

- local HEAD；
- origin/main；
- ahead/behind；
- tracked / untracked；
- 当前 APK / device 状态；
- 当前 Phase IV 收尾报告。

禁止：

```text
git reset --hard
git clean
覆盖未知用户文件
删除旧 test-logs
```

然后建立 Authority Inventory：

| 概念 | 当前实现 Authority | 是否唯一 | 风险 |
|---|---|---:|---|
| Outline Pre-Adoption Candidate | task.finalText / latest task query | 待审 | result taskId 是否直达 |
| Continuation Pre-Adoption Candidate | artifact / latest pending run | 待审 | result runId 是否直达 |
| Current Chapter Body | chapters.content | 应唯一 | Revision 后 Memory 是否同步 |
| Current Final Artifact | eligible final latest | 待修 | 多 eligible |
| Physical LLM Request | WritingRequestReceipt + UserRevisionReceipt | FAIL | 双账本 |
| Final Body Legality | PlainText + FinalArtifactValidator rules | FAIL | 双规则 |
| Memory Authority | existing PostWriting / outbox | 应唯一 | revision advanced |
| Phase IV Current Status | 多份 docs | FAIL | GO/HOLD 并存 |
| Acceptance Denominator | 多口径 | FAIL | 统计口径冲突 |

## RED

必须先写/补一份确定性 Authority Inventory 测试或脚本，暴露至少：

- Result A + newer Result B 时，A Revision 可能错误命中 B；
- User Revision Discard 后没有 Durable Unified Request Receipt；
- 同一正文被不同 Validator 得到不同 technical verdict；
- Continuation 一个 run 能有多个 eligible final。

## GO 条件

Authority Inventory 完成，所有不一致都有：

```text
owner
current behavior
desired authority
repair stage
test case
```

---

# 5. IV-13U-1 — Candidate Identity SSOT

## 5.1 问题

用户在某个明确 Result 页面操作时，Result 本身已经拥有：

```text
Outline: taskId
Continuation: runId
```

后台不得再通过：

```text
chapterId
→ getLatestCompleted...
→ findLatestPending...
```

重新猜“用户想修哪一个结果”。

这是 Write Path 的身份漂移。

## 5.2 目标

定义唯一 CandidateRef，例如：

```ts
type UserRevisionCandidateRef =
  | {
      kind: 'pipeline_task';
      taskId: string;
      chapterId: number;
      projectId: number;
    }
  | {
      kind: 'continuation_run';
      runId: string;
      chapterId: number;
      projectId: number;
    }
  | {
      kind: 'chapter';
      chapterId: number;
      projectId: number;
    };
```

Pre-Adoption Result Page 必须直接传精确身份：

```text
PipelineResultScreen(taskId=A)
→ candidateRef.taskId = A

ContinuationResultScreen(runId=A)
→ candidateRef.runId = A
```

`loadUserRevisionCandidateBase()` 不允许在显式写操作路径里再执行 `getLatest* / findLatest*` 来替换已经知道的 ID。

## 5.3 必须验证

按精确 ID 加载后还必须验证：

```text
ref.projectId == actual.projectId
ref.chapterId == actual.chapterId
task/run state 支持 revision
Final Candidate 存在
Final Candidate fingerprint 与 UI snapshot 一致
```

不一致：

```text
fail-closed
```

不能自动 fallback 到另一个 latest task/run。

## 5.4 RED 对抗案例

### Outline

```text
Chapter X
Task A completed
Task B completed（时间更晚）

打开 Result A
→ 精准修订
```

GREEN：

```text
修改且仅修改 Task A Final Candidate
Task B 完全不变
```

### Continuation

```text
Chapter X
Run A awaiting_user
Run B awaiting_user（更晚）

打开 Run A
→ 整章重写
```

GREEN：

```text
只创建 Run A 的 revised final candidate
Run B 完全不变
```

## 5.5 CHECK-A

至少：

```text
candidate identity targeted tests
typecheck
lint -- --quiet
```

## 5.6 ACT

建立规则：

> **Explicit ID beats latest. Write path never guesses identity.**

`latest` 只能用于 read-only discovery / 最近任务导航，不能用于已明确用户对象的 mutation。

---

# 6. IV-13U-2 — ONE Durable Request Receipt

## 6.1 问题

项目已有统一：

```text
WritingRequestReceipt
```

User Revision 又维护：

```text
UserRevisionReceipt
```

两个结构都记录 provider/model、token、physical request、fallback、duration、finishReason 等。

同时 User Revision Receipt 主要跟随 Preview / Revision Snapshot 保存，会产生：

```text
LLM 已付费成功
→ 用户 Discard Preview
→ 请求事实没有 Durable Unified Ledger
```

以及：

```text
LLM 返回 Preview
→ App force-stop
→ 内存 Preview 消失
```

## 6.2 目标

物理模型调用只能有：

# `ONE Durable WritingRequestReceipt`

User Revision 不再拥有第二套模型调用事实。

业务侧只保留轻量 Action Audit，例如：

```ts
interface UserRevisionActionAudit {
  actionId: string;
  kind: 'targeted_revision' | 'whole_chapter_rewrite';
  scenario: 'outline' | 'continuation';
  candidateRef: UserRevisionCandidateRef;
  baseBodyFingerprint: string;
  candidateBodyFingerprint?: string;
  selectedTextFingerprint?: string;
  instructionFingerprint: string;

  requestId: string;

  previewState:
    | 'requested'
    | 'ready'
    | 'applied'
    | 'discarded'
    | 'stale'
    | 'failed';
}
```

User Revision Action 记录“业务动作”。

WritingRequestReceipt 记录“物理模型请求事实”。

二者不得混淆。

## 6.3 Durability 时点

统一 Receipt 必须在 Request 生命周期本身 durable：

```text
prepared / started
→ sent
→ succeeded / failed / outcome_unknown
```

不能等到用户 Apply 才持久化。

以下场景都必须存在 Receipt：

```text
Generate → Preview → Apply
Generate → Preview → Discard
Generate → Preview → force-stop
Generate → LLM fail
Generate → outcome_unknown
Generate → invalid patch
Generate → invalid final body
```

“正文未采用”不等于“模型请求没发生”。

## 6.4 Physical Call 唯一计算

以下数据只能来自统一 Receipt：

```text
physicalRequestCount
protocolFallbackCount
providerRequestId
requestMayHaveExecuted
failureClass
failurePhase
input/output/reasoning tokens
timings
model/provider/adapter
thinking
wireMaxTokens
```

User Revision UI 可以展示这些值，但来源只能一个。

## 6.5 RED

至少证明：

1. `Generate Preview → Discard` 时旧实现可能无 durable unified receipt；
2. `Generate Preview → force-stop` 时旧实现内存 receipt 不足；
3. UserRevisionReceipt 与 WritingRequestReceipt 字段语义重复。

## 6.6 CHECK-A

必须覆盖：

```text
receipt persisted on success-before-apply
receipt preserved on discard
receipt preserved on invalid patch/final
outcome_unknown no auto retry
actual wire model == receipt model
physical request count exact
```

以及：

```text
typecheck
lint quiet
verify:elastic
```

---

# 7. IV-13U-3 — ONE Final Body Legality Contract

## 7.1 问题

当前已有 `validatePlainTextNovelBody()`，但 Outline `finalArtifactValidator` 仍自己拥有 anchor marker、prompt fingerprint、patch leak、contract echo、technical tail 等技术正文判断。

这会导致同一正文在不同入口得到不同 verdict。

## 7.2 目标

建立：

# `ONE Shared Final Novel Body Technical Contract`

共享技术合同负责：

```text
empty
whole JSON wrapper
malformed JSON/protocol wrapper
Markdown fence wrapper
reasoning / think leak
prompt scaffold
patch/diff protocol
anchor marker leak
response schema
duplicate technical title wrapper
unclosed technical envelope
```

所有场景统一调用：

```text
Outline normal Final
Continuation normal Final
Targeted Revision candidate
Whole Chapter Rewrite candidate
Pre-Adoption candidate apply
Post-Adoption apply
Batch adoption
```

## 7.3 FinalArtifactValidator 只保留请求态规则

Outline `finalArtifactValidator` 可继续存在，但职责必须变成：

```text
Shared Final Novel Body Contract
+
Request-specific completion evidence
```

只保留：

```text
reasoning-only channel state
finishReason=length + explicit incomplete evidence
canonicalDraft collapse telemetry
request-specific completion evidence
```

凡属于“正文 X 本身是否含技术污染”的判断，一律下沉共享合同。

## 7.4 对抗测试

同一组非法正文必须在所有入口得到一致的 `valid=false + technical code`：

```text
JSON wrapper
Markdown fence
<think>
anchor marker
patch JSON
修改说明协议
prompt scaffold
duplicate technical title wrapper
```

同时保留自然小说负例，避免重建关键词 Gate。

---

# 8. IV-13U-4 — Current Final Candidate Authority

## 8.1 问题

Continuation Pre-Adoption Revision 会保留旧 final 历史，并插入新的 `eligible final`。如果旧 final 仍 eligible，一个 Run 会有多个对象都叫“eligible final”。

Current Authority 不能继续只依赖：

```text
ORDER BY created_at DESC, id DESC LIMIT 1
```

## 8.2 原则

> **History 可以多个，Current Authority 只能一个。**

Agent 必须先审查当前 schema / enum / migration，不要先假设实现方式。

允许两种最小方案：

### 方案 A：显式 Active Pointer

例如：

```text
continuation_generation_runs.active_final_artifact_id
```

每次生成/修订 Final 时原子更新。

### 方案 B：Atomic Supersede

如果现有 eligibility contract 支持明确的 historical/superseded 状态，则：

```text
insert new current final
+
old current final → superseded
```

必须在同一 transaction。

## 8.3 禁止

不要：

```text
多个 final 都保持 eligible
→ 靠 latest 排序推导 current
```

不要删除历史 artifact。

## 8.4 RED

构造：

```text
Final A
→ Targeted Revision B
→ Whole Rewrite C
```

GREEN：

```text
History = A/B/C
Current = C only
Adoption = C
Recovery = C
Result UI = C
Revision base = C
```

---

# 9. IV-13U-5 — Current Revision / PostWriting Authority

## 9.1 正式区分三个概念

### Generation History Authority

```text
GenerationPersistedEvent
```

表示当时那次生成真正持久化过什么，保持不可变。

### Current Chapter Revision Authority

```text
chapters.content
+
current revision fingerprint
```

表示用户现在真正认可/保存的正文。

### PostWriting / Memory Authority

必须绑定：

```text
Current Chapter Revision Fingerprint
```

而不是历史 GenerationPersistedEvent 的 body fingerprint。

## 9.2 用户修订 Apply

Post-Adoption：

```text
CAS current body
→ version snapshot
→ persist new body
→ current revision fingerprint
→ existing PostWriting / ONE Memory
```

如果 PostWriting 失败：

必须保持章节正文与 Memory Authority 一致，并验证：

```text
正文回滚成功
revision metadata 不留半提交
outbox 不产生孤儿
current fingerprint 不漂移
```

## 9.3 Pre-Adoption

Pre-Adoption Candidate Revision：

```text
只更新 Candidate Authority
不写 chapters.content
不触发 Current Chapter Memory
```

只有真正 Adoption 后：

```text
Candidate
→ Chapter Current Authority
→ WritingPersistedEvent / PostWriting
```

不得因为 Candidate Preview/Apply 就污染 Story Memory。

---

# 10. IV-13U-6 — Status / Metrics / Evidence SSOT

## 10.1 Phase IV Current Status

最终必须只有一个 Current Status 来源。

在 B3 完成之前统一：

```text
PHASE IV FINAL SEAL HOLD / NO-GO
Reason:
IV-13U consistency closure in progress
+
Continuation B3 3-chapter batch pending
```

旧 IV-12：

```text
Historical Seal Evidence
```

不是当前状态。

## 10.2 Acceptance Denominator

最终只允许：

```text
User Revision:
A1 + A2 + B1 + B2
= 4/4

Outline Batch:
A3
= 3/3

Continuation Batch:
B3
= 0/3 pending

Batch Regression Total:
= 3/6 pending
```

B3 完成后：

```text
Continuation Batch = 3/3
Batch Regression Total = 6/6
```

禁止继续使用含混的 `Normal Generation 6/6`，除非定义与上述固定 denominator 完全等价。

## 10.3 Evidence

只提交 body-free 证据。

允许：

```text
SHA/fingerprint
taskId/runId/actionId/requestId
candidateRef
current artifact id
status transition
selection offsets
outside-selection-preserved boolean
physical request count
provider/model scalar
token/latency scalar
DB integrity
outbox state
receipt outcome
UI hierarchy
脱敏 logcat
```

禁止：

```text
API Key
Authorization
完整小说正文
完整原著
完整 Prompt
reasoning 原文
巨型 SQLite
```

---

# 11. IV-13U-7 — Minimal Regression + B3 Final Seal

本轮不重新跑 20 章，也不重复完整 A1/A2/A3/B1/B2 大矩阵。

代码修复后只做针对唯一性的最小对抗测试。

## 11.1 Deterministic / Integration

### Identity

```text
Outline Task A + Task B
→ 打开 A
→ 修订只能命中 A

Continuation Run A + Run B
→ 打开 A
→ 修订只能命中 A
```

### Receipt

```text
Generate Preview → Apply
→ unified durable receipt exists

Generate Preview → Discard
→ unified durable receipt exists

Generate Preview → invalid patch
→ unified durable receipt exists

Generate Preview → force-stop simulation
→ request ledger survives / can reconcile
```

### Final Contract

同一个非法 body 在：

```text
Outline
Continuation
Targeted Revision
Whole Rewrite
```

必须得到相同 technical rejection。

### Current Final

```text
A → B → C
History 3
Current 1
Adoption C only
```

### Memory

```text
Post-Adoption revision
→ new body fingerprint
→ PostWriting/Memory same fingerprint

Pre-Adoption revision
→ chapter/memory unchanged until adopt
```

## 11.2 最小真实 Android 回归

### R1 大纲精准修订 ×1

验证：

```text
正确 task identity
physical call = 1
unified receipt durable
选区外 100% 不变
Apply 正确
Memory 对新正文闭环
```

### R2 原著续写整章重写 ×1

验证：

```text
正确 run identity
current final unique
physical call = 1
unified receipt durable
Plain-Text Contract PASS
Canon/Source/Style 无硬 violation
Apply 后 Memory/State 对新正文闭环
```

除非代码变更证明必要，不扩大修订样本。

## 11.3 B3 恢复

上述一致性修复全部 GO 后：

```text
不改 Prompt
不换章节
不重计划
不改 timeout
不加 retry
```

在稳定网络窗口继续现有原著续写 B3 固定批次。

要求：

```text
3/3 E2E First-Pass
3/3 Product-valid Final
3/3 Plain-text Final
Thinking ON
Governor physical call = 0
hidden retry = 0
duplicate paid = 0
outcome_unknown auto retry = 0
Canon hard violation = 0
Source Boundary violation = 0
Future Source Leakage = 0
PostWriting / ONE Memory = 3/3
```

如果稳定网络下再次在同一章持续失败：

```text
保持 NO-GO
重新打开 RCA
```

不得继续直接写“网络环境问题”。

---

# 12. 各板块 PDCA 要求

每个 U 阶段都必须在 progress 中使用以下模板：

```text
## IV-13U-X <Stage Name>

### PLAN
- 当前不一致：
- 唯一 Authority 应该是：
- 改动边界：
- 禁止触碰：
- 预期测试：

### RED
- 失败测试：
- 旧行为：
- 失败证据：

### DO
- 最小代码改动：
- Schema / migration：
- compatibility：
- 未新增的系统：

### CHECK-A
- targeted：
- typecheck：
- lint：
- verify:elastic：
- full verify（需要时）：

### CHECK-B
- APK SHA：
- adb install -r：
- Android case：
- DB：
- Receipt：
- UI：
- logcat：

### ACT
- Root Cause：
- 修正结果：
- 剩余风险：
- 是否扩大回归：

### VERDICT
GO / NO-GO
```

必须一板块一结论，不能代码全部写完后一次性补 PDCA。

---

# 13. 工程验证节奏

## 每个阶段

```text
targeted tests
typecheck
lint -- --quiet
```

涉及 output/capability：

```text
verify:elastic
```

涉及 DB/migration：

```text
migration / repository targeted tests
DB integrity
```

## U1-U6 全部 GO 后

统一跑：

```text
npm run typecheck
npm run lint -- --quiet
npm run verify:elastic
npm run verify:version
npm run verify
npm run apk:debug
```

然后：

```text
adb install -r <APK>
```

禁止清数据。

---

# 14. 数据库 / Migration 原则

如果 U4 需要新增 Current Final Pointer 或 eligibility 状态：

必须：

```text
forward-safe migration
existing rows deterministic backfill
旧历史 artifact 不删除
无 giant BLOB 扩张
metadata query 不重新 materialize 巨型 content
CursorWindow 安全不退化
```

Backfill 必须有唯一规则，例如：

```text
每个 run：
从历史可交付 final 中按既有 deterministic order
选出一个 current
其余标 historical/superseded
```

Migration 完成后，运行时 Current read 不再继续依赖同样的“latest 猜测”。

---

# 15. 最终禁止事项

1. 为解决 Candidate Identity 再增加一个 smart resolver 去猜 latest；
2. 为解决 Receipt 再做第三种 Ledger；
3. 为解决 Final Contract 把 regex 复制到更多地方；
4. 为 Current Final 唯一性删除历史 artifact；
5. 为 B3 通过增加自动 retry；
6. 为 Memory 一致性创建第二 Memory；
7. 为简化实现强迫用户先采纳再修订；
8. 为测试通过绕过真实 selection；
9. 把 User Revision 纳入正常 First-Pass Pipeline；
10. 修改已经稳定的 Writer/QA/Context/Governor 架构。

---

# 16. Final Seal Gate

只有以下全部满足才允许正式封板。

## Authority

```text
Explicit Result Identity = Revision Candidate Identity
Current Final Candidate = exactly one
Current Chapter Body = exactly one authority
PostWriting fingerprint = Current Chapter Revision fingerprint
```

## Receipt

```text
ONE Durable WritingRequestReceipt
User Revision no second physical-call authority
Apply / Discard / Fail / force-stop 均可审计
physical calls exact
```

## Final Body

```text
ONE Shared Final Novel Body Technical Contract
所有写入路径一致 verdict
JSON/protocol leakage = 0
```

## Revision

```text
Targeted out-of-range accepted = 0
Unselected preservation = 100%
Stale apply = 0
Correct task/run identity = 100%
```

## Safety

```text
Thinking disabled = 0
Governor physical calls = 0
hidden retry = 0
duplicate paid = 0
unsafe outcome_unknown retry = 0
Canon/Source hard violation = 0
Memory stale authority = 0
```

## Regression

```text
R1 Outline targeted revision PASS
R2 Continuation whole rewrite PASS
B3 Continuation batch = 3/3
Batch Regression Total = 6/6
```

## Engineering

```text
typecheck PASS
lint quiet PASS
verify:elastic PASS
verify:version PASS
full verify PASS
APK PASS
adb install -r PASS
DB integrity PASS
Receipt audit PASS
UI PASS
logcat crash/ANR = 0
```

## Docs

只有一个 Current Status：

```text
PHASE IV FINAL SEALED / GO
```

旧 IV-12 / IV-13 HOLD / 历史 NO-GO 全部明确标记 Historical Evidence。

---

# 17. 文档产物

本轮维护：

```text
docs/optimization/TAVO-MINI_Phase4_IV13U_一致性与唯一性收口修复方案_20260901.md
docs/optimization/phase4-iv13u-progress.md
docs/optimization/phase4-iv13u-final-report-20260901.md
```

最终同步更新：

```text
docs/optimization/phase4-final-report.md
docs/optimization/phase4-requirement-closure.md
docs/optimization/phase4-progress.md
```

避免出现多个“当前结论”。

## 17.1 执行后闭环记录（2026-09-01）

本方案已按 IV-13U-0～IV-13U-7 完成 PLAN → RED → DO → CHECK-A → CHECK-B → ACT → GO/NO-GO。误跑批次不删除、不覆盖，按 DB 的 `writing_mode` 作为独立工程样本保留：

| 样本 | 真实身份 | 结果 | 计数边界 |
| --- | --- | --- | --- |
| A3 | `batch_mtgkk3dc_j6pp07`，project 62，`writing_mode=outline`，9243/9244/9245 | 3/3 succeeded，adoption fingerprint 全部存在；第三章一次 network failure 后恢复成功 | 计入大纲 A3 工程/文学质量样本，不替代 continuation B3 |
| B3 | `batch_mti4bayt_zhh5gp`，project 67，`writing_mode=continuation`，9292/9293/9294 | 3/3 succeeded，三项 `full_pipeline`，Current Final/PostWriting/Story Memory 一致 | 唯一 continuation B3 分母 |

A3 的完整执行、DB/Receipt/正文技术合法性、流水线阶段和文学质量记录见 [`phase4-iv13u-final-report-20260901.md`](phase4-iv13u-final-report-20260901.md)。最终封板仍以 continuation B3 `3/3`、一致性/唯一性、工程门禁和真机证据全部通过为条件。

---

# 18. 最终判定原则

本轮不是要证明系统“能跑”。

现有证据已经说明它基本能跑。

本轮要证明：

> **系统对每一个关键概念只有一个答案。**

最终必须回答清楚：

```text
用户现在修改的是谁？
→ 一个精确 taskId/runId

现在真正的 Final 是谁？
→ 一个 Current Final Artifact

现在真正的章节正文是什么？
→ 一个 Current Revision Authority

这一次模型到底请求了什么？
→ 一个 Durable WritingRequestReceipt

这份正文是否合法？
→ 一个 Shared Final Body Contract

Memory 应该相信哪个正文？
→ Current Revision Fingerprint

Phase IV 当前到底是什么状态？
→ 一个 Current Status

验收到底通过了多少？
→ 一个固定 denominator
```

只要其中任何一项仍有两个答案：

```text
PHASE IV FINAL SEAL HOLD / NO-GO
```

全部收敛后，并完成 B3 3/3，才允许：

# `PHASE IV FINAL SEALED / GO`
