# Tavo-Mini Story Memory Protocol V2 收尾修复与稳定性封板方案

> 项目：`anjingdtl/tavo-mini`  
> 远端验收基线：`main@b76a43bf35f27e9c08d634bf3d7434c856d06e7c`  
> 当前版本：`V2.11.45 / versionCode=2114500`  
> Schema：`50`  
> Protocol：`Story Memory Protocol V2`  
> 建议收尾版本：`V2.11.46`  
> 本方案定位：**Protocol V2 最终 Closure，不再扩架构，只修复 Local Compiler、Evidence 边界、Whole-item Budget 和长状态压力验证。**

---

## 0. 最终目标

V2.11.45 已经完成 Story Memory 的主体架构重构：

```text
Evidence Anchor + Entity Handle + Semantic Observation
  → Local Normalizer
  → Local Resolver / Deterministic Compiler
  → Existing Batch Patch / Merger / CAS / DB
```

并已通过真实 LLM 的复杂长篇、Formatter、Fresh Retry、64K Split、force-stop、自动 maintenance、锁屏后台等关键穿测。

本轮不再重构主链，而是完成最后一轮稳定性封板，消除以下风险：

1. 被判定为无效的 Observation 仍可能污染 Episodic Memory。
2. 同批次 `N1/N2...` 临时实体在尚未真正通过 Evidence 校验前就被引用。
3. Observation 可以跨章节引用其他 CH 的 Evidence Anchor。
4. Active Mainline 被包装成单一大型 Preferred High 模块，长篇时可能整块丢弃。
5. `packWholeItems()` 遇到一个放不下的大 item 后直接 `break`，造成后续小 item 饥饿。
6. Fresh Retry 没有重新进行 Whole-item Elastic packing。
7. 当前 100/300/1000 章测试使用空状态，未真正验证 accumulated state 随长篇增长后的预算稳定性。

最终目标是：

> **坏 Observation 只能局部失败，不能污染 Episodic Memory、不能制造悬空引用、不能升级为整批失败；长篇状态再大，当前 Arc/Objective 和相关人物仍有稳定保护，输入必须在 Burst/Hard 边界内完成 whole-item 收缩或预拆分。**

---

# 1. 本轮严格边界

## 1.1 必须保留，不得重做

以下能力已经验收通过，只做回归验证：

- Story Memory Protocol V2 Prompt 结构
- Evidence Anchor 主协议
- C/R/T/F/P/A / CH Handle
- Observation JSON
- Local Normalizer
- Existing Batch Patch schema
- Merger / CAS / Fingerprint
- Partial Success
- `outcome_unknown`
- Durable request ledger
- Foreground / WakeLock
- Task Store / Progress
- 3→2→1 Split
- Physical HTTP ≤ 3
- Debug QA Harness
- Schema 50
- 默认 Batch Size = 3

## 1.2 禁止事项

本轮禁止：

- 不得恢复“LLM 直接生成 DB Patch”。
- 不得恢复 Summary ↔ Mainline 双写。
- 不得放宽 Evidence 到“模型自由复制 quote”。
- 不得新建第二套 Budget Allocator。
- 不得新建第二套 Story Memory Request Runner。
- 不得扩大 Batch > 3。
- 不得修改 Outline Pipeline、Continuation、Canon 的生产实现。
- 不得推进 P2。
- 不得通过增加重试次数掩盖问题。
- 不得修改 Schema 50，除非出现无法绕开的持久化需求；本轮预计不需要。
- 不得卸载 App、`pm clear` 或清数据库来完成真实穿测。
- V2.11.46 版本号只能在全部 Gate 通过后提升。

---

# 2. P0-1：无效 Observation 不得进入 Episodic Summary

## 2.1 当前问题

当前 Compiler 的执行顺序存在风险：

```text
Evidence resolve
→ 生成 statement
→ 写入 summary.events
→ 标记 accepted
→ 再进行 Ref / Endpoint / Entity 校验
```

因此：

```json
{
  "kind": "character_state",
  "ref": "C99",
  "field": "location",
  "op": "set",
  "value": "地下密室",
  "evidence": ["Q001"]
}
```

如果 `Q001` 合法、`C99` 不存在：

- State Mutation 会被正确丢弃；
- 但 derived summary 可能已经写入；
- 最终 Episodic Memory 会把错误事件保存并参与后续检索。

这与 V2 的“局部降级”定义不一致。

## 2.2 修复原则

**只有成功编译成有效状态语义的 Observation，才算 accepted。**

统一改成：

```text
Normalize
→ Evidence validate
→ Ref / Endpoint / Required semantic validate
→ Build local patch mutation
→ ACCEPT
→ Derived Summary
→ accepted stats
```

任何 Observation 只要在本地校验失败：

```text
warning
→ drop observation
→ 不写 patch
→ 不写 chapterSummary.*
→ 不增加 acceptedObservations
```

## 2.3 建议实现方式

在：

```text
src/services/storyMemory/storyMemoryObservationCompiler.ts
```

中将当前：

```text
const label = statement(...)
addSummaryValue(summary.events, label)
accepted.add(...)
```

从通用前置逻辑移出。

建议封装：

```ts
function acceptObservation(
  entry,
  summary,
  accepted,
  evidenceByObservation,
  evidence,
  semanticBucket,
): void
```

或者更简单：每个 kind 分支真正完成 Patch 写入后，再统一写 summary / accepted / diagnostics。

重点是保证：

> **任何 `continue` 之前都不能提前污染 summary。**

## 2.4 Summary 的权威关系

继续坚持：

```text
Structured Observation / Compiled Patch
        ↓
Local Derived Summary
```

禁止：

```text
LLM Summary
→ 反向制造 State
```

`brief/events/keywords` 中模型直接返回的非状态性摘要仍可保留，但：

- `characterChanges`
- `relationshipChanges`
- `mainlineChanges`
- `newThreads`
- `resolvedThreads`

必须只由 **accepted compiled observation** 派生。

对于 `events`：

- 模型原始 `chapter.events[]` 可视为低风险 Retrieval Annotation；
- Compiler 自动生成的 semantic event 只能来自 accepted observation。

建议在代码层区分 `source.events` 与 `derived events`，最终 merge 即可，但 rejected observation 绝不能贡献 derived event。

## 2.5 回归测试

必须新增：

### Case A：Evidence 合法、Ref 非法

断言：

```text
patch 无该 mutation
summary.events 不含该 observation
characterChanges 不含
acceptedObservations 不增加
warning = OBS_INVALID_REF
batch 仍成功
```

### Case B：relationship endpoint 非法

同样要求 summary 完全不被污染。

### Case C：invalid evidence

同样不能进入任何 derived summary。

---

# 3. P0-2：N-key 改为 Two-pass Accepted Entity Resolver

## 3.1 当前问题

当前 `prepareKeyRefs()` 在真正 Evidence 验证之前就为：

```text
character_new N1
thread open N2
conflict open N3
foreshadowing open N4
relationship open N5
```

生成 local temp ref。

风险示例：

### Observation A

```json
{
  "kind": "character_new",
  "key": "N1",
  "name": "陈叔",
  "evidence": ["Q999"]
}
```

A Evidence 无效。

### Observation B

```json
{
  "kind": "relationship",
  "op": "open",
  "key": "N2",
  "from": "C01",
  "to": "N1",
  "evidence": ["Q020"]
}
```

B Evidence 合法。

如果 `N1` 已被 provisional map：

```text
N1 → new_char_obs_N1
```

B endpoint 会“看起来可解析”。最后可能形成悬空 Patch，再被本地 Hard Validator 升级为整批失败。

## 3.2 正确模型

改为真正两阶段：

```text
Pass 0
Normalize + order observations

Pass 1
验证所有“定义型 Observation”
- character_new
- relationship open
- conflict open
- thread open
- foreshadowing open

Evidence 必须先过
必要字段必须先过
existing collision / duplicate 必须先处理

只有 ACCEPTED definition 才注册 N-key

Pass 2
处理所有引用型 Observation
- character_state / set
- relationship update
- conflict update/resolve
- thread update/resolve
- foreshadowing update/partial/resolve
- parties / owners / endpoint
```

引用 rejected / missing N-key：

```text
当前 observation → OBS_INVALID_REF / OBS_INVALID_ENDPOINT
局部 drop
batch 继续
```

## 3.3 进一步要求

### Existing Entity 合并

如果 `character_new N1` 通过名字/alias 识别到已有 `Cxx`，可以继续：

```text
N1 → existing character id
```

但前提是该 `character_new` Observation 自身 Evidence 已合法，否则不能建立 N1 alias map。

### Same-batch dependency

合法：

```text
N1 character_new
N2 relationship open C01 ↔ N1
N3 thread open owners=[N1]
```

必须 deterministic 成功。

非法：

```text
N1 rejected
N2 references N1
N3 references N1
```

必须：

```text
N1 drop
N2 drop
N3 drop
其他 Observation 继续
```

## 3.4 建议文件

优先只改：

```text
storyMemoryObservationCompiler.ts
```

如逻辑过长，可新增：

```text
storyMemoryObservationResolver.ts
```

只负责 accepted new-key registry / dependency resolve，不要引入新持久化模型。

## 3.5 回归测试

至少覆盖：

1. invalid `character_new N1` + valid evidence relation→N1
2. invalid `character_new N1` + valid thread owner=N1
3. valid N1 + relation→N1
4. 同批 duplicate N1
5. N1 实际命中 existing character
6. rejected thread N2 + later update N2
7. rejected conflict N3 + later resolve N3
8. rejected foreshadow N4 + later partial N4

所有 rejected dependency 都必须局部丢弃，不能触发 Compiler Hard Fail。

---

# 4. P0-3：Evidence Anchor 必须与当前 CH 同章

## 4.1 当前问题

当前 Evidence Resolver 只验证：

```text
Qxxx 是否存在
```

但没有要求：

```text
anchor.chapterId === observation 所属 chapterId
```

于是：

```text
CH01 observation
evidence = Q023
Q023 实际属于 CH02
```

仍可能被接受。

这会污染：

- chapter summary 时间归属
- firstSeen / lastChanged chapter
- timeline 顺序
- Episodic Memory
- downstream retrieval

## 4.2 修复规则

默认协议：

> **一个 Observation 的所有 Evidence Anchor 必须属于该 Observation 所在 CH。**

建议修改：

```ts
resolveObservationEvidence(
  ids,
  envelope,
  expectedChapterId?
)
```

或在 Compiler 的 `evidenceFor(entry)` 里判断：

```ts
anchor.chapterId === entry.chapter.id
```

只要存在跨章 Anchor：

```text
OBS_INVALID_EVIDENCE
→ 当前 Observation 整条 drop
```

不要只删除错误 Q 后继续保留剩余 Evidence，避免模型把关键事实锚错章节。

## 4.3 Chapter-level brief/events

Evidence 章节约束针对 `observations[]`。

模型直接返回的：

```text
brief
events
keywords
```

本身没有 Evidence Contract，不需要额外验证。

但 State / relationship / mainline 等结构化语义必须严格同章。

## 4.4 回归测试

### Case A

```text
CH01 observation → CH02 Q
```

必须：

```text
drop
OBS_INVALID_EVIDENCE
batch continue
```

### Case B

同一 Observation：

```text
Q001(CH01) + Q020(CH02)
```

整条 drop。

### Case C

正常 CH01 → Q001(CH01) 保持通过。

---

# 5. P0-4：拆解 Active Mainline，保护 Arc / Objective

## 5.1 当前问题

当前 `renderActiveMainline()` 将：

- currentArc
- currentObjective
- all active conflicts
- all open threads
- all foreshadowing

组合成一个 `v2_active_mainline / preferred_high` 模块。

长篇后，这个单块可能变成巨大材料，一旦整体放不下，Arc / Objective 也会跟着全部丢弃。

## 5.2 新的材料拆分

### Mandatory / Protected

```text
v2_current_arc
v2_current_objective
```

其中：

```text
currentArc:
A01 | name | bounded summary

currentObjective:
OBJECTIVE | value
```

如果不存在，也保留极短状态：

```text
A01 | none
OBJECTIVE | none
```

这两个模块不得在普通自动请求中被丢弃。

### Preferred High — Whole Item

每个实体独立模块：

```text
v2_conflict_F01
v2_conflict_F02
v2_thread_T01
v2_thread_T02
v2_foreshadow_P01
...
```

每个 module 都是完整 item，禁止字符串切半。

## 5.3 Relevance 排序

### Conflict

以下命中提高 relevance：

- 正文出现 party character
- title/state keyword 命中正文
- 最近 changed

### Thread

- owner character 命中
- title/description keyword 命中
- priority critical/high
- recent changed

### Foreshadowing

- setup/payoff keyword 命中当前正文
- status=open/partially_paid
- recent changed

## 5.4 Bounded fields

每个单 item 内部可以做字段级 bounded clean，例如：

- thread description
- archive digest
- arc summary

可以使用明确字符/Token 上限裁剪字段，但必须保持整条 module 语义完整。

Current Chapter Body / Anchor 不得裁剪。

---

# 6. P1-1：修复 `packWholeItems()` starvation

## 6.1 当前问题

当前逻辑：

```ts
if (used + cost > budget) break;
```

这意味着：

```text
候选1 = 8000 tokens，放不下
候选2 = 500 tokens，放得下
候选3 = 200 tokens，放得下
```

遇到候选1后直接结束，后面全部饿死。

## 6.2 修复

改为：

```ts
if (used + cost > budget) continue;
```

继续尝试后续完整 item。

## 6.3 补充要求

排序仍按：

```text
priority × relevance
burstPriority
stable id
```

但 `continue` 后必须保证 deterministic。

建议 diagnostics 增加：

```text
skippedTooLargeItemIds
includedItemIds
remainingBudget
```

正式日志仍只记录 ID/统计，不记录正文。

## 6.4 测试

```text
budget = 1000
item A = 1200
item B = 600
item C = 300

预期：
A skip
B include
C include
```

并验证同优先级下 stable id 排序 deterministic。

---

# 7. P1-2：Fresh Retry 重新执行 Elastic Whole-item Packing

## 7.1 当前问题

Primary：

```text
materials
→ planStoryMemoryObservationRequest()
→ whole-item compact
```

但 Fresh Retry 使用：

```text
baseMessages = Full Materials
→ append retry instruction
→ planStoryMemoryObservationMessages()
```

后者只做完整输入是否 <= Burst 的判断，不会重新进行材料压缩。

于是可能出现：

```text
Primary 能 compact 成功
Primary 输出坏
Formatter 失败
Fresh Retry 又恢复 Full State
→ 超 Burst
→ Split / 单章 infeasible
```

## 7.2 正确设计

Fresh Retry 应重新从原始 `StoryMemoryObservationMaterials` 规划。

建议新增：

```ts
planStoryMemoryFreshRetryRequest({
  config,
  materials,
  batchSize,
  failureCode
})
```

内部：

1. 先复用 `planStoryMemoryObservationRequest()` 的 whole-item selection。
2. 使用同一 frozen config。
3. 保留同一 chapter handles / entity handles / evidence anchors。
4. 在 compact 后的 messages 追加 Fresh Retry instruction。
5. 再重新估算最终 Message Token。
6. 超 Burst：
   - multi chapter → preflight split
   - single chapter → actionable infeasible

## 7.3 Formatter 保持 body-free

Formatter 不改当前原则：

```text
candidate
+ handle list
+ evidence id list
+ contract
```

Formatter 不重新带正文。

如果 Formatter 本身超窗口：

```text
skip Formatter
→ Fresh Retry
```

Fresh Retry 再重新 whole-item plan。

---

# 8. P0-5：重写 100 / 300 / 1000 章 Accumulated State 压力测试

## 8.1 当前测试无效点

当前压力测试每一轮都使用：

```ts
createEmptyStoryMemory(1)
```

state 不增长。

它只能证明固定三章正文反复请求不会增长，不能证明 1000 章后数百人物/关系/主线实体仍稳定。

## 8.2 新测试模型

需要构造随章节增长的真实状态。

### 100 章状态

至少：

```text
characters: 40~60
relationships: 30~50
activeConflicts: 5~10
openThreads: 10~20
foreshadowing: 10~20
timelineAnchors: 50+
recentResolvedThreads: 20+
archiveDigest: 非空
```

### 300 章状态

至少：

```text
characters: 120~180
relationships: 100+
activeConflicts: 10~20
openThreads: 30~60
foreshadowing: 30~60
timelineAnchors: 150+
archiveDigest: 1000+ chars
```

### 1000 章状态

至少：

```text
characters: 300~500
relationships: 250~500
activeConflicts: 20~40
openThreads: 80~150
foreshadowing: 80~150
timelineAnchors: 500+
recentResolvedThreads: 100+
archiveDigest: 1600 chars bounded
```

不要求真实模拟每章 LLM，只需要构造符合真实 DB State 形状的 accumulated fixture。

## 8.3 Relevant vs Unrelated

当前 Batch 必须故意提到：

```text
2~4 个相关人物
1~2 个相关关系
1 个 thread keyword
1 个 conflict keyword
```

同时保留大量无关历史人物/关系。

验证：

```text
currentArc retained
currentObjective retained
relevant rich character retained
relevant relationship 优先
相关 thread/conflict 优先
unrelated old state 可丢
archive 最先丢
```

## 8.4 预算场景

必须跑：

### 1M / 200K

应基本 Full 或轻量 compact。

### 128K / 32K

必须：

```text
<= Burst
或 preflight split
```

### 64K / 32K

必须证明：

```text
whole-item compact
→ 3→2→1（必要时）
```

### 单章极限

如果 Mandatory 本身超过 Hard：

```text
zero HTTP
actionable infeasible
```

## 8.5 Gate 定义

100/300/1000 章每档必须满足：

```text
Prompt 不随总 State 近似线性增长
Arc/Object protected
Current chapter anchors retained
Relevant character retained
No half item
No half JSON
No chapter body clipping
Final Input <= Burst
或发送前 Split
```

建议记录：

```text
totalStateEntities
fullInputTokens
finalInputTokens
soft/burst/hard
included modules
dropped modules
relevant retained count
```

---

# 9. Compiler Hard Validation 保持严格

本轮修复不是“放宽 Validator”。

以下继续 Hard Fail：

- Local Compiler 生成错误 range
- chapter coverage 错误
- Local Compiler 生成 invalid tempRef
- Local Compiler 生成悬空 ref
- CAS mismatch
- fingerprint mismatch
- DB persistence failure
- impossible local invariant

区别在于：

> **模型 Observation 的引用/Evidence错误，应在进入 Hard Validator 前就被局部过滤掉。**

也就是：

```text
LLM data quality issue
→ warning/drop

Local compiler bug
→ hard fail
```

---

# 10. accepted / dropped / warning 统计修正

定义：

## observationsReceived

模型原始：

```text
chapters[].observations.length
```

## observationsNormalized

通过 Kind/Field/Op/Required Field 的数量。

## observationsAccepted

真正完成：

```text
Evidence OK
Ref OK
Endpoint OK
Dependency OK
Compiled OK
```

并进入 Patch/Summary 的数量。

## observationsDropped

建议：

```text
observationsNormalized - observationsAccepted
```

不要简单统计 warnings 数，因为一个 Observation 可能产生多个 warning。

---

# 11. Diagnostics 建议

继续维持隐私边界。

禁止记录：

- API Key
- 完整正文
- 完整 Prompt
- 完整模型响应
- 完整 Evidence 文本

可增加：

```text
protocolVersion
logicalBatchId
batchRange
observationsReceived
observationsNormalized
observationsAccepted
observationsDropped
crossChapterEvidenceDrops
unresolvedDependencyDrops
invalidRefDrops
includedModuleIds
droppedModuleIds
tooLargeSkippedModuleIds
fullInputTokens
finalInputTokens
soft/burst/hard
splitUsed
physicalAttemptCount
formatterUsed
freshRetryUsed
```

---

# 12. 代码修改建议

## 12.1 高概率修改

```text
src/services/storyMemory/storyMemoryObservationCompiler.ts
src/services/storyMemory/storyMemoryEvidenceAnchors.ts
src/services/storyMemory/storyMemoryObservationMaterials.ts
src/services/storyMemory/storyMemoryRequestBudget.ts
src/services/storyMemory/storyMemoryCheckpointService.ts
src/services/storyMemory/storyMemoryV2Diagnostics.ts
__tests__/storyMemoryProtocolV2.test.ts
```

## 12.2 可选新增

如果 Compiler 继续膨胀，可新增：

```text
src/services/storyMemory/storyMemoryObservationResolver.ts
```

只负责：

```text
accepted new-key registry
dependency resolve
```

不要新增持久化模型。

---

# 13. 实施顺序

## Phase 0 — 固定基线

Agent 先：

```text
git status
git fetch --all --prune
git rev-parse HEAD
git rev-parse origin/main
```

记录当前基线，不得覆盖用户未提交修改。

## Phase 1 — 先写失败测试

先补 4 类当前应该失败的回归：

1. invalid ref 污染 summary
2. rejected N1 dependency
3. cross-CH evidence
4. oversized item starvation

确保旧代码能稳定复现。

## Phase 2 — Compiler Accepted Boundary

修：

```text
validate → compile → accept → summary
```

同步修 accepted/dropped stats。

## Phase 3 — Two-pass N-key Resolver

收束：

```text
definition acceptance
→ register N key
→ dependent observations
```

## Phase 4 — Same-CH Evidence

加入 expected chapter boundary。

## Phase 5 — Active Mainline Whole-item 拆分

拆：

```text
Arc
Objective
Conflict item
Thread item
Foreshadow item
```

Arc/Object protected。

## Phase 6 — Whole-item starvation

`break → continue`，补 deterministic test。

## Phase 7 — Fresh Retry Elastic Re-plan

Fresh Retry 不再直接 Full `baseMessages`。

## Phase 8 — Accumulated State Stress Tests

重写 100/300/1000 章测试。

## Phase 9 — Targeted + Full Regression

先跑：

```bash
npx jest __tests__/storyMemoryProtocolV2.test.ts --runInBand --ci
```

再跑所有 Story Memory tests，最后：

```bash
npm run verify
```

---

# 14. 真实 LLM 穿测范围

本轮不需要把上一轮所有 Android Gate 从头重做。

## 14.1 必须重新真实测

### Test 1 — 原复杂长篇 Fixture smoke

使用上一轮：

```text
complex-long-1m-fixture
3 × 18000 chars
```

验证仍：

```text
V2 primary
→ HTTP 200
→ compile
→ applied
```

确保本轮 Compiler 改动没有回归主问题。

### Test 2 — 64K + 大 accumulated state

这是本轮最重要的新真实测试。

准备：

```text
64K/32K capability
大人物/关系/Thread state
当前 3 章正文
```

验证：

```text
Arc/Object retained
相关人物 retained
whole-item compact
必要时 3→2→1
所有 child applied
```

### Test 3 — Invalid Observation local degradation

Debug seam 可继续使用，但建议把注入场景升级成两类。

#### A

```text
valid evidence + invalid handle
```

确认：

```text
warning
state 不变
episodic summary 不含 debug-invalid
batch applied
```

#### B

```text
invalid new N1
+ relation referencing N1
```

确认：

```text
两条局部 drop
batch applied
无悬空 ref
```

### Test 4 — Fresh Retry on compact context

在小窗口或人工压大 Previous State：

```text
Primary invalid JSON
Formatter invalid JSON
Fresh Retry
```

确认 Fresh Retry 仍使用 compact materials，而不是恢复 Full State。

## 14.2 不必完整重做

只做 smoke 即可：

- force-stop
- outcome_unknown
- Lock screen
- Foreground/WakeLock
- overlay install
- automatic maintenance x2

因为本轮不修改这些层。

如 Agent 修改到了这些模块，则必须恢复完整 Gate。

---

# 15. Debug APK 覆盖安装要求

真实穿测继续使用：

```bash
adb install -r <apk>
```

禁止：

```text
adb uninstall
pm clear
清数据库
删除 secure storage
```

目标是继续保留：

- LLM provider
- API Key
- model config
- projects
- chapters
- Story Memory state
- ledger
- existing QA fixture

若 Debug 签名不兼容现有安装包：

> 必须调整测试 APK 到兼容签名，不得卸载绕过。

---

# 16. V2.11.46 发版规则

V2.11.45 已经作为正式 release commit 存在。

本轮修复完成后不要改写 2.11.45。

只有全部 Gate 通过后：

```bash
npm version 2.11.46 --no-git-tag-version --ignore-scripts
npm run prebuild
npm run verify:version
npm run verify
```

再构建：

```bash
npm run apk:debug
npm run apk:release
```

正式 Release 继续按项目 `RELEASE_APK_BUILD.md` / `RELEASE_CHECKLIST.md` 验收：

- package name
- versionName
- versionCode
- signing certificate
- zipalign
- SHA-256
- single signer
- install metadata

---

# 17. 最终 GO / NO-GO Gate

## Gate A — Compiler Local Degradation

必须：

```text
invalid ref
invalid endpoint
invalid evidence
invalid dependency
```

全部做到：

```text
局部 drop
不污染 Summary
不造成悬空 Patch
batch 继续
```

## Gate B — Same-Chapter Evidence

必须：

```text
CH01 → CH02 Q
```

稳定 drop。

## Gate C — Two-pass Dependency

必须证明：

```text
rejected N1
→ 后续所有引用 N1 的 observation 局部 drop
```

不能 Hard Fail 整批。

## Gate D — Summary Integrity

任何 rejected Observation：

```text
不得进入
events
characterChanges
relationshipChanges
mainlineChanges
newThreads
resolvedThreads
```

## Gate E — Active Mainline Protection

长状态压力下：

```text
currentArc retained
currentObjective retained
```

Conflict/Thread/Foreshadowing 按 whole item 筛选。

## Gate F — Whole-item Packing

必须：

```text
oversized item 不阻塞后续 smaller item
```

所有 included item 完整。

## Gate G — Fresh Retry Elastic

Fresh Retry：

```text
重新 compact
final input <= Burst
或 preflight split
```

不能回到 Full State 原子 Prompt。

## Gate H — 100/300/1000 Accumulated State

必须使用真实增长 state fixture。

每档都满足：

```text
bounded
relevant retained
Arc/Object protected
no clipping
<= Burst 或 split
```

## Gate I — Regression

```text
Story Memory targeted all pass
npm run verify pass
原 complex fixture smoke pass
64K large-state real LLM pass
```

## Gate J — Release

全部前置 Gate PASS 后：

```text
V2.11.46
Schema 50
Release APK hard verification PASS
```

才允许：

```text
GO
```

任何一个 P0 Gate 未通过：

```text
NO-GO
```

---

# 18. 最终验收报告

Agent 完成后必须生成：

```text
docs/optimization/Story-Memory-Protocol-V2-Closure-Verification-YYYYMMDD.md
```

报告至少包含：

1. 初始 HEAD / origin/main
2. 最终 HEAD
3. 修改文件列表
4. P0/P1 根因和最终修法
5. invalid-ref summary pollution 回归
6. rejected N-key dependency 回归
7. cross-chapter evidence 回归
8. whole-item starvation 回归
9. Fresh Retry compact trace
10. 100/300/1000 accumulated-state 指标
11. 1M/200K、128K/32K、64K/32K trace
12. 原 complex fixture 真实 LLM smoke
13. 64K large-state 真实 LLM
14. Debug APK 覆盖安装
15. 数据保留情况
16. `npm run verify`
17. V2.11.46 Release APK 验证
18. 最终 GO / NO-GO

---

# 19. 本轮最终产品标准

普通用户最终应该只看到：

```text
长期记忆正常
```

或者：

```text
正在整理 43%
```

内部必须保证：

- 模型只做 Semantic Observation。
- Evidence 必须真实、同章。
- Handle 不能悬空。
- 错 Observation 只局部丢弃。
- Episodic Summary 不被 rejected Observation 污染。
- 当前 Arc / Objective 永远受保护。
- 长篇状态按 relevance 进入 Prompt。
- Whole-item 不被字符串截断。
- 大 item 放不下不会饿死小 item。
- Fresh Retry 继续遵守 Elastic Budget。
- 1000 章状态不会让 Prompt 无界增长。
- 单逻辑批次物理 HTTP 仍 ≤3。
- provider outcome unknown 不会静默重发。
- 后台、force-stop、CAS、ledger 保持原有稳定能力。

---

# 20. 可直接交给 Agent 的执行提示词

```text
以本地 tavo-mini 仓库为唯一实施工作树，先执行 git status、git fetch --all --prune，记录 HEAD 与 origin/main，保留所有用户已有未提交修改。完整阅读 docs/optimization 下最新的《Story Memory Protocol V2 收尾修复与稳定性封板方案》，严格按 Phase 0→9 自主实施。

本轮禁止再扩架构，只修 Protocol V2 最后边界：① rejected Observation 必须在通过 Evidence/Ref/Endpoint/Dependency 校验并真正 compile 成功后才能进入 accepted stats 和 derived episodic summary；② N1/N2 等 request-local key 改为 two-pass accepted entity resolver，rejected 新实体不能被后续关系/thread/conflict/foreshadow 引用，依赖错误必须局部 drop 而不是整批失败；③ Observation 的 Q Evidence 必须属于所在 CH，跨章 Evidence 整条 drop；④ 将 Active Mainline 拆为 protected currentArc/currentObjective + 独立 whole-item conflict/thread/foreshadow modules；⑤ 修复 packWholeItems 遇到大 item 直接 break 的 starvation，改为继续尝试后续完整 item；⑥ Fresh Retry 必须重新执行 Elastic whole-item planning，不能恢复 Full State 原子 prompt；⑦ 重写 100/300/1000 章测试，使用真实增长的 accumulated state，而不是 empty state。

先为以上问题补稳定复现的失败测试，再最小范围修改。不得修改 Outline Pipeline、Continuation、Canon，不得新建第二套 Budget/Request Runner，不得扩大 Batch>3，不得推进 P2，不得放宽 CAS/Fingerprint/Compiler hard invariant，不得增加物理请求上限。

完成后跑 Story Memory targeted tests、npm run verify，并使用现有真实 LLM 环境重新做：原 complex-long 3×18000 fixture smoke、64K/32K + 大 accumulated-state、invalid-ref 不污染 episodic summary、rejected N1 dependency 局部降级、Fresh Retry compact。Debug APK 必须对现有 App 使用 adb install -r 覆盖升级，禁止 uninstall、pm clear 或清库，保留原 LLM/API Key/项目/章节/Story Memory/ledger。

全部 Gate 通过前不得升版或宣称 GO。通过后再升 V2.11.46，按 RELEASE_APK_BUILD.md / RELEASE_CHECKLIST.md 构建并硬验收 Release APK，并输出 docs/optimization/Story-Memory-Protocol-V2-Closure-Verification-YYYYMMDD.md，明确给出最终 GO / NO-GO 和完整证据。
```
