# TAVO-MINI ONE Flow 收尾建设与最终封板方案 V1.0

**文档定位：** Closure PDCA / 最终收尾，不再进行主架构重塑  
**适用仓库：** `anjingdtl/tavo-mini`  
**适用阶段：** ONE Memory / ONE Context / ONE Pipeline / ONE Flow 主体改造完成后的最终收尾  
**执行环境：** 新开发机，本地仓为实际施工基线；远端 `main` 仅用于开工前同步与完工后独立验收  
**当前已知远端基线：** `ca00918c2a773db606238f7488d8006b3439d5a8`  
**当前状态：** `PRE-SEAL / RC`，暂不得宣布 `ONE FLOW FINAL SEALED / GO`

---

## 0. 本轮结论先行

本轮不是继续“优化架构”，而是把已经完成的 ONE Flow 收口到可正式封板状态。

当前已经通过的主体方向：

- ONE Production Writing Entry
- ONE Writing Kernel
- ONE Shared Writer Core
- ONE Shared Prompt Compiler
- ONE Memory
- ONE Context Planner / Final Budget
- ONE Frozen Context Truth
- ONE Pipeline DAG
- Conditional Revision
- Conservative QA Parallel Wave
- WritingPersistedEvent
- Memory → Context → Freeze → Pipeline → Persist → Memory 闭环

**以上主体默认视为冻结区。**

本轮只允许解决以下收尾问题：

1. 历史 `failed outbox` 对未来 Continuation Batch 的错误全局阻塞。
2. Phase 1 以前遗留 `pending proposal` 的自动 replay / 分类闭环。
3. 最新补丁必须使用 Exact HEAD Debug APK 实机/模拟器复验。
4. Exact Final HEAD 必须完成完整静态与自动化门禁。
5. 真实 LLM 穿测缩减为每类 2 章，用于发现生产问题，不做大样本性能统计。
6. 最终验收报告补齐真实证据后，才允许宣布 `ONE FLOW FINAL SEALED / GO`。

---

# 1. 修复边界

## 1.1 本轮允许修改

优先限制在以下边界内：

```text
src/services/multiChapterBatch/
src/services/writing/memory/
src/services/writing/flow/
src/services/continuation/generation/
__tests__/writingOneFlow*
__tests__/continuation*
.github/workflows/
docs/optimization/
```

如确有必要，可最小范围修改：

```text
src/services/storyMemory/
src/data/repositories/
src/services/database/
```

但必须证明修改直接服务于：

- Outbox relevance / coverage 判断；
- Story Memory Ready Gate；
- pending replay；
- Final Closure observability / evidence。

## 1.2 冻结区：原则上禁止修改

除非发现明确 P0 回归并有 Red Test 证明，否则禁止重构：

```text
Writing Kernel
Shared Writer Core
Shared Prompt Compiler
Context Planner
allocateWritingContextBudget
Stage Context Projection
Findings Aggregator
Writing Stage DAG
One-Shot Execution Profile
Canon 主算法
Elastic / Hierarchical Context Budget 数学模型
低 / 中 / 高现有执行策略
```

特别禁止：

- 新建第二套 Writer；
- 新建第二套 Prompt Compiler；
- 新建第二套 Context Builder；
- 新建第二套 Long-Term Memory；
- 新增极速专属 Memory / Context / Writer；
- 恢复 Outline / Continuation 场景专属 Writer Core；
- 为了测试变绿放宽 Canon / Semantic Apply / Freeze / Persist 约束；
- 用 silent fallback 掩盖真正失败；
- 删除历史失败记录来“解决”阻塞；
- 把 `failedCount > 0` 简单改成永不阻塞；
- 为提速默认删除 Proof；
- 改写 Elastic Context Budget；
- 增加固定输入 Token 上限。

---

# 2. 开工前新开发机基线

新机器不得直接假设旧开发机状态。

开工必须先完成：

```text
git fetch --all --prune
git checkout main
git pull --ff-only
git status
git rev-parse HEAD
```

记录：

```text
baselineHead
baselineVersion
nodeVersion
javaVersion
androidSdk
adb devices
```

若远端 `main` 已高于 `ca00918c2a773db606238f7488d8006b3439d5a8`，则以最新 `main` 为基线重新审计，不允许强行退回旧 SHA。

同时运行：

```text
npm ci
npm run verify:version
npm run typecheck
npm run lint
```

并先跑 ONE Flow 相关 Gate，确认新开发机基线不是红的。

---

# 3. P0-1：历史 failed Outbox 不得污染未来 Batch

## 3.1 当前问题

当前 Batch Ready 逻辑已经正确检查当前章节精确任务：

```text
extract_state:<chapterId>:<revisionHash>

rebuild_story_memory:auto:<projectId>:<position>:<revisionHash>
```

但之后仍存在项目级判断：

```text
getOutboxSummary(projectId)

failedCount > 0
→ BLOCK
```

因此：

```text
任意历史失败
↓
即使已经过时 / 被覆盖 / 与当前章节无关
↓
仍阻断未来 Continuation Batch
```

这已经在真实穿测中出现：

```text
旧 chapter 72 rebuild_story_memory failed
↓
新章节正文已经成功 Persist
↓
新批次仍无法正常 2/2 completed
```

## 3.2 修复原则

绝对禁止：

```text
if (failedCount > 0) ignore all
```

正确目标是：

> **只阻断“当前下一章 Freeze 所依赖的、仍然相关且尚未被覆盖的硬失败”。**

历史失败可以保留用于诊断，但不能永久成为全项目 Barrier。

## 3.3 建议判定模型

建议引入一个清晰、可测试的领域判断，例如：

```ts
getBlockingPostWritingFailures(...)
```

或：

```ts
evaluateRelevantOutboxFailures(...)
```

名称可按现有代码风格调整，不强制新增 API。

判断至少考虑：

```text
projectId
completedChapterId
completedPosition
current revisionHash
Story Memory throughPosition
Story Memory dirtyFromPosition
latest successful rebuild coverage
outbox dedupe key
operation
state
target position / fromPosition
```

## 3.4 必须 BLOCK 的情况

### A. 当前章节精确 extract_state 失败

```text
extract_state:<currentChapter>:<currentRevision>
state = failed
```

→ BLOCK

### B. 当前章节所需 rebuild 失败

且 Story Memory 尚未被后续成功 checkpoint / rebuild 覆盖。

→ BLOCK

### C. Story Memory 当前仍处于：

```text
dirty
rebuilding
failed
```

且：

```text
dirtyFromPosition <= completedPosition
```

→ BLOCK / WAIT，按现有语义处理。

### D. 当前正文 hash 已漂移

→ BLOCK

### E. 当前 Canon / Source / Boundary 与冻结 Anchor 漂移

→ BLOCK

## 3.5 不应该 BLOCK 的历史失败

### A. 失败位置已被后续成功 Story Memory checkpoint 覆盖

例如：

```text
failed rebuild @ position 72
latest Story Memory throughPosition >= 80
且当前 Memory status = ready
```

→ NON-BLOCKING

### B. 失败属于旧 revision

正文已重新定稿并生成新的成功 revision task。

→ NON-BLOCKING

### C. 失败 row 已不覆盖当前 required range

→ NON-BLOCKING

### D. 失败属于历史旧流程遗留，但当前 ONE Memory 状态已完整收束

→ NON-BLOCKING

## 3.6 不得自动删除历史失败

历史失败记录仍然保留用于：

```text
diagnostics
migration audit
user support
```

允许增加运行时分类：

```text
blocking
stale
covered
superseded
historical
```

但不要求改 Schema；如可通过运行时计算完成，优先不改 Schema。

---

# 4. P0-2：旧 pending proposal Replay 必须真正闭环

当前已经有：

```text
replayPendingContinuityProposals(projectId)
```

本轮重点不是重写它，而是证明它在真实生产路径有效。

## 4.1 Replay 语义

Phase 1 以前遗留：

```text
status = pending
```

不能一律理解为“冲突”。

必须重新经过 ONE Memory classifier：

```text
legacy pending
↓
same classifier
├─ routine → auto commit
└─ real conflict → remain pending
```

## 4.2 Replay 硬要求

Replay 必须：

- 无额外 LLM 调用；
- 幂等；
- 可重复执行；
- 已 auto-commit 的 proposal 再执行不重复写 event；
- 已确认的 proposal 不重新变 pending；
- 真 Canon hard conflict 保持 pending；
- unmergeable 保持 pending；
- low-confidence + affects later 保持 pending；
- routine location / physical state / ordinary progress 自动提交；
- 不修改 Story Memory / Canon 的权威顺序。

## 4.3 必测老数据案例

构造或迁移至少：

```text
1. ordinary character_state pending
2. ordinary plot_advance pending
3. ordinary new_character pending
4. Canon aliveState conflict pending
5. unmergeable pending
6. low-confidence relationship change affecting later
```

预期：

```text
前三项自动提交
后三项保留人工冲突
```

再执行 replay 第二遍：

```text
新增 commit = 0
新增 event = 0
```

证明幂等。

---

# 5. P0-3：Story Memory 历史失败覆盖语义

本轮重点不是改写 Story Memory，而是把 Ready Gate 与 Story Memory 当前事实统一。

## 5.1 Authority

仍保持：

```text
Canon
>
Frozen Source Boundary
>
Structured Continuity State
>
Story Memory
>
Recent Prose
```

不得修改。

## 5.2 Ready Gate 应相信当前有效 Memory 状态

如果：

```text
历史 rebuild failed @ old position
```

但当前：

```text
Story Memory status = ready
throughPosition >= requiredPosition
dirtyFromPosition = null
```

并有后续成功重建 / checkpoint 证据，

则旧失败不得再次推翻当前 Memory Ready Truth。

## 5.3 反例

如果：

```text
Story Memory status = failed
```

或：

```text
dirtyFromPosition <= completedPosition
```

则不得仅因为“历史失败可能过期”而跳过。

---

# 6. P1：Exact HEAD APK 实机/模拟器复验

上一轮 Phase 4 的明确缺口是：pending replay 补丁已进入代码，但当时安装到模拟器的 APK 早于该补丁。

本轮必须补齐。

## 6.1 Build

在最终代码 HEAD：

```text
npm run verify:version
npm run typecheck
npm run lint
npm run test:ci
```

然后：

```text
cd android
gradlew assembleDebug
```

记录：

```text
finalHead
APK path
APK version
build time
```

## 6.2 安装方式

如果测试设备 / 模拟器已有有效用户数据：

```bash
adb install -r <debug.apk>
```

禁止：

```text
adb uninstall
pm clear
清数据库
重新初始化项目
```

除非单独建立专用空白测试设备。

必须确认升级后原有：

- LLM 配置；
- API Key；
- 模型设置；
- Writer Style；
- Story Memory；
- 项目数据；
- Continuation Source；
- Canon；
- 历史 pending / failed outbox；

没有因为安装测试被人为清掉。

## 6.3 新开发机特别要求

因为换了机器，如果无法直接继承旧模拟器数据：

优先顺序：

### 方案 A

连接原测试真机 / 原模拟器数据镜像。

### 方案 B

导入已有应用备份 / DB fixture，保留历史 outbox / pending 问题。

### 方案 C

通过测试 fixture 在本地数据库构造等价历史状态。

不得因为换机就跳过：

```text
legacy pending replay
historical failed outbox coverage
```

这两个才是本轮真正要验的 P0。

---

# 7. 自动化 Red / Green 门禁

至少补充以下行为 Gate。

建议文件：

```text
__tests__/writingOneFlowClosureOutbox.test.ts
__tests__/writingOneFlowClosurePendingReplay.test.ts
__tests__/writingOneFlowClosureReadyGate.test.ts
```

也可以并入现有 Phase 4 文件，但不要让一个测试文件无限膨胀。

## 7.1 Outbox Gate

### Case 1
当前章节 `extract_state` failed → BLOCK

### Case 2
当前章节 rebuild failed 且未被覆盖 → BLOCK

### Case 3
旧章节 rebuild failed，但后续成功 Memory coverage 已覆盖、当前 Memory ready → NOT BLOCK

### Case 4
旧 failed row，当前 exact revision tasks 全 completed、Memory ready → NOT BLOCK

### Case 5
`memory.dirtyFromPosition <= completedPosition` → BLOCK

### Case 6
Memory ready，`dirtyFromPosition = null` → NOT BLOCK

## 7.2 Pending Replay Gate

### Case 1
routine legacy pending → auto commit

### Case 2
Canon conflict → remain pending

### Case 3
replay twice → no duplicate commit/event

### Case 4
replay then Batch Ready → routine leftover 不再造成 `BATCH_CONTINUATION_STATE_CONFLICT`

### Case 5
real conflict remains → Batch 继续 fail-closed

## 7.3 No Architecture Regression Gate

继续保持：

```text
Writer Core Count = 1
Prompt Compiler Count = 1
Final Budget Decision = 1
Narrative Long-Term Memory = Story Memory only
Post-Freeze Live Source Read = 0
Post-Freeze Live Model Behavior Read = 0
One-Shot automatic paid calls <= 1
Fast/extreme context builder = 0
Fast/extreme writer core = 0
```

---

# 8. Full Regression

最终代码必须运行：

```text
npm run verify:version
npm run lint
npm run typecheck
npm run test:ci
```

并重点确认：

```text
writingFinalSeal*
writingOneShot*
writingOneFlowPhase0*
writingOneFlowPhase1*
writingOneFlowPhase2*
writingOneFlowPhase3*
writingOneFlowPhase4*
writingOneFlowClosure*
continuationBatch*
continuationOutbox*
storyMemory*
replay*
migration*
```

不得使用：

```text
.only
.skip
allow-failure
临时注释断言
缩弱断言
```

---

# 9. GitHub Actions 最终门禁

最终提交推送到远端后，必须以**同一个 Exact Final HEAD SHA**确认：

```text
Verify
Generation Stability
```

均为 Green。

Verify 至少包含：

```text
verify:version
lint
typecheck
Full Jest
Android Debug build
migration matrix
```

Generation Stability 必须继续包含：

```text
Writing Kernel
Freeze
Replay
Semantic Apply
Shared Writer
One-Shot
ONE Memory
ONE Context
ONE Pipeline
ONE Flow
Closure Gate
```

如果 CI 因环境原因未触发，必须说明原因并提供本地等价执行记录；但最终封板优先要求远端 CI Green。

---

# 10. 真实 LLM 最终穿测：缩减为每类 2 章

## 10.1 原则

本轮真实 LLM 的目的：

> **发现生产问题、证明流程闭环。**

不是建立统计学性能样本。

因此不再要求：

```text
Outline 10
Continuation 10
One-Shot 5
```

统一缩减。

## 10.2 最终真实样本

### A. Outline 标准档

连续：

```text
2 章
```

优先使用批量入口连续写 2 章。

必须验证：

```text
两章 completed
正文 Persist
Freeze fingerprint
Generation Trace
Review / FactCheck QA wave
Revision conditional
Proof
FinalValidate
PostWriting
Story Memory
无 duplicate paid stage
```

### B. Continuation 标准档

必须使用连续 Batch：

```text
2 章
```

这是本轮最重要的真实测试。

第 1 章完成后必须自动经历：

```text
Persist
→ WritingPersistedEvent
→ extract_state
→ proposal classify / auto commit
→ Story Memory update / rebuild
→ Ready Gate
→ 第 2 章 Freeze
```

验收：

```text
2/2 completed
第 2 章不得被历史无关 failed outbox 阻断
普通旧 pending 不得人工挡住
真冲突仍可 fail-closed
Story Memory throughPosition 正常前进
Continuation State 正常
无重复正文 paid call
```

如果这组不能干净 2/2：

> 不得封板，继续 PDCA。

### C. One-Shot 极速档

总共：

```text
2 章
```

为覆盖两个场景，建议：

```text
Outline One-Shot 1 章
Continuation One-Shot 1 章
```

两章分别必须：

```text
chapterWritingPaidCallCount = 1
formatter = 0
retry = 0
review = 0
audit = 0
factCheck = 0
revision = 0
proof = 0
正文 Persist
PostWriting 正常
```

不得为了通过测试给 One-Shot 加第二次自动模型调用。

## 10.3 真实 LLM 样本总量

```text
Outline Standard       2
Continuation Standard  2
One-Shot               2
-------------------------
合计                    6 章
```

无需追加到 10/10/5。

若 6 章全部干净通过，即满足本轮真实 LLM Closure Gate。

---

# 11. 性能记录：只记录，不强行做统计

由于每类只有 2 章，本轮禁止编造：

```text
稳定 P50
稳定 P95
平均提速 XX%
显著性结论
```

每章只记录真实值：

```text
generationTraceId
freezeFingerprint
scenario
executionProfile
chapterE2EMs
logicalStageCallCount
formatterCallCount
physicalRequestCount
protocolFallbackCount
chapterWritingPaidCallCount
postWritingAuxiliaryCallCount
inputTokens
outputTokens
Revision triggered/skipped
Proof triggered
Story Memory update status
State extraction status
Resume duplicate paid call
```

可以做 Before 单章历史样本 vs After 本轮两个真实样本，但只陈述事实，不外推百分比。

---

# 12. Resume / Crash 收尾测试

真实 LLM 不必专门烧大量 Token 做故障注入。

自动化至少覆盖：

### A. Draft 已成功，Persist 前退出

Resume：

```text
load durable Draft
不得再次调用 Draft LLM
```

### B. QA 某阶段已完成后退出

Resume：

```text
已完成 Stage 不重复付费
```

### C. One-Shot Draft 成功后退出

Resume：

```text
Paid LLM count 仍 <= 1
```

### D. pending replay 执行中重复进入

结果：

```text
idempotent
```

### E. historical outbox failure

重启后：

```text
relevance 判定稳定
```

---

# 13. Final Seal 必须满足

以下全部满足才允许：

```text
ONE Pipeline = PASS
ONE Context = PASS
ONE Memory = PASS
ONE Flow = PASS

Historical irrelevant failed outbox does not block future batch
Current relevant failed outbox still fail-closed

Legacy routine pending auto-replay = PASS
Real conflict remains gated = PASS
Replay idempotency = PASS

Exact Final HEAD APK installed with adb install -r
Latest replay/outbox fix verified on device

Outline Standard 2/2
Continuation Standard 2/2
One-Shot 2/2

Continuation Batch clean 2/2
No historical SM failure pollution

One-Shot Paid <= 1
Formatter = 0
Auto Retry = 0
Non-Draft paid stages = 0

Resume Duplicate Paid Call = 0
Freeze Drift = 0
Memory Drift = 0
Canon Regression = 0
Fatal Context Loss = 0
False Applied = 0

Full Jest = PASS
Typecheck = PASS
Lint = PASS
Migration = PASS
Android Debug Build = PASS
Generation Stability = PASS
Verify = PASS

Second Writer Core = 0
Second Prompt Compiler = 0
Second Final Budget = 0
Second Long-Term Memory = 0
New Hard Input Token Cap = 0
```

完成后最终状态才可改为：

```text
ONE FLOW FINAL SEALED / GO
```

---

# 14. 建议 PDCA 顺序

## PDCA-0：Baseline

记录新开发机：

```text
HEAD
环境
现有 Gate
现有 failed outbox / pending fixture
```

不得改代码。

## PDCA-1：Historical Outbox Relevance

```text
Root Cause
→ Red Test
→ Minimal Fix
→ Focused Green
→ Regression
```

独立 Commit：

```text
fix(writing): scope continuation ready gate to relevant outbox failures
```

## PDCA-2：Legacy Pending Replay Closure

验证当前实现并只补必要缺口：

```text
Red
→ Minimal Fix
→ Idempotency
→ Batch Gate Integration
```

如有生产修改，独立 Commit：

```text
fix(writing): seal legacy continuity pending replay
```

如果生产代码无需修改，仅补测试，则不要为了制造 Commit 强行改代码。

## PDCA-3：Exact HEAD Full Regression

运行：

```text
verify
generation stability
migration
android debug
```

任何红灯先修完再进入 LLM 测试。

## PDCA-4：Exact HEAD APK

```text
assembleDebug
adb install -r
data preservation check
legacy fixture verification
```

## PDCA-5：真实 LLM 2 + 2 + 2

```text
Outline Standard 2
Continuation Standard 2
One-Shot 2
```

Continuation 必须干净 Batch 2/2。

## PDCA-6：Final Evidence

输出：

```text
TAVO-MINI_ONE-Flow_Closure_最终封板报告_<date>.md
```

记录：

```text
finalHead
commits
CI
APK
device
6章 sample
generationTraceId
Freeze fingerprint
Paid calls
outbox state
Story Memory state
Continuation State
fatal counts
```

最后独立 Commit：

```text
docs(optimization): seal ONE Flow closure report
```

---

# 15. Agent 自主执行要求

Agent 开工后：

- 以新开发机本地仓为执行基线；
- 开工先同步远端最新 `main`；
- 不询问人工确认，除非出现安全/权限/密钥不可恢复问题；
- 严格最小修复；
- 每一刀必须 Red Test 先行；
- 禁止顺便重构；
- 禁止清理历史架构“看起来不漂亮”的代码；
- 禁止改低/中/高策略；
- 禁止新增 Token 硬上限；
- 禁止弱化 One-Shot 单调用硬门禁；
- 禁止为了速度删除 Proof；
- 禁止自动删除 failed outbox；
- 禁止把真实冲突变成自动通过；
- 禁止用人工数据库清理替代生产修复；
- 禁止只根据测试假数据宣布完成；
- 最终必须用 Exact HEAD APK 做实机/模拟器验证；
- 最终真实 LLM 仅需 2 + 2 + 2，不得擅自扩大测试浪费调用时间与费用。

---

# 16. 最终停止条件

如果出现以下任意一项：

```text
Continuation Batch != 2/2
historical failed outbox still blocks unrelated new chapter
legacy routine pending still需要人工清理
real conflict被误自动提交
One-Shot > 1正文付费调用
Resume重复调用已成功Stage
Story Memory未Ready但下一章仍Freeze
Freeze / Canon / Context发生漂移
Full Jest / CI / Android Build红灯
```

则：

```text
NO-GO
→ 继续 Closure PDCA
```

不得通过：

```text
“正文已经生成”
“UI 显示完成”
“多数测试通过”
“问题是旧数据”
“换项目就好了”
```

来宣布封板。

---

# 17. 最终目标状态

收尾完成后，生产写作链路应稳定为：

```text
UI / Batch / Resume
        ↓
ONE Production Writing Entry
        ↓
Source Adapter
        ↓
Context Candidates
        ↓
ONE Context Planner
        ↓
ONE Elastic / Hierarchical Budget
        ↓
ONE Freeze
        ↓
ONE Pipeline DAG
        ↓
ONE Shared Writer Core
        ↓
Persist
        ↓
WritingPersistedEvent
        ↓
ONE Memory
        ↓
Relevant Ready Gate
        ↓
Next Chapter
```

最终原则：

> **历史错误可以被记录，但不能永久污染未来；当前真实错误必须继续 fail-closed。**

> **收尾建设只修闭环，不再重塑已经通过验收的主架构。**

> **真实 LLM 测试以“足够发现生产问题”为目标，本轮每类 2 章即可。**
