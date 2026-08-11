# Tavo-Mini Story Memory Protocol V2 最终封板收尾方案

> 项目：`anjingdtl/tavo-mini`  
> 本地实施仓：`F:\ClaudeWorkSpace\projects\TAVO-MINI`  
> 远端参考 HEAD：`cdcab413a055e1bfb6ce4e98fcf855177a989634`  
> 远端参考版本：`V2.11.47 / versionCode=2114700 / Schema 50`  
> 方案日期：2026-08-11  
> 定位：**Story Memory Protocol V2 最终封板，不再扩架构，只关闭最后两个 P0 与一个 P1。**

---

# 0. 当前验收结论

V2.11.47 已经完成并通过：

- N-key 跨章节未来引用拦截；
- N-key 同章向未来引用拦截；
- Character new → update；
- Relationship open → update；
- Conflict open → update → resolve；
- Thread open → update → resolve；
- Foreshadowing open → partial → resolve；
- Compiler → Hard Validator → Merger → Final State；
- Live QA 改用 production Request Policy / Provider Adapter；
- Android M1～M6 真实 App 路径基础穿测；
- `outcome_unknown`、Foreground、上下文消费未见明显回归。

当前仍有：

## P0-1：Batch → Merger 时间元数据被压平

**Batch Patch → Chapter Merger 接驳会把整个 3 章 Batch 的时间元数据压成 through chapter。**

导致：

- Relationship `firstSeenChapterId` 错到 CH3；
- Conflict `openedChapterId` 错到 CH3；
- Thread `openedChapterId` 错到 CH3；
- Foreshadowing `openedChapterId` 错到 CH3；
- Character 虽可取 first evidence chapterId，但 `firstSeenPosition` 仍可能取 Batch 终点；
- Timeline / lastChanged 也存在同类风险。

## P0-2：known-change complex-long 的真实语义 Gate 尚未跑实

原 known-change complex-long `3 × 18000` 的真实 production-policy 语义 Gate 代码已写，但因 Live Jest 环境没有 API Key 被 skip，尚未真实证明：

```text
observationsReceived > 0
observationsAccepted >= 3
semanticCategories 非空
```

## P1：Future Ref Diagnostics 分类

`OBS_FUTURE_REF` 目前 Diagnostics 没有独立归类，落入 generic `invalid_observation`。

---

# 1. 本轮唯一目标

本轮只做三件事：

1. **保住 Batch 内真实章节时间。**
2. **把 complex-long production-policy 真实语义 Gate 跑实。**
3. **修正 Future Ref diagnostics 分类。**

最终做到：

> **模型事实发生在哪一章，Compiler、Patch、Merger、最终 StoryMemoryState 就必须一致保留在哪一章。**

并且：

> **Known-change 长篇真实请求不能再只靠 HTTP 200 / JSON valid / checkpoint clean 判成功，必须证明实际提取并持久化了连续性语义。**

---

# 2. 严格修复边界

## 2.1 必须保留

不得重做：

```text
Evidence Anchor
Entity Handle
Semantic Observation
Local Normalizer
Chronology Resolver
Observation Compiler
Whole-item Elastic
Fresh Retry
Physical HTTP <= 3
CAS / Fingerprint
Durable ledger
outcome_unknown
Foreground / WakeLock
Task Store
3→2→1 Split
Partial Success
Schema 50
```

## 2.2 禁止事项

本轮禁止：

- 不得重构 Story Memory Protocol V2；
- 不得修改 Outline Pipeline；
- 不得修改 Continuation；
- 不得修改 Canon；
- 不得扩大 Batch > 3；
- 不得新建第二套 Merger；
- 不得新建第二套 Request Runner；
- 不得新建第二套 Elastic Allocator；
- 不得增加物理 HTTP 请求次数；
- 不得因为时间字段问题改 Schema；
- 不得把 QA semantic gate 变成生产全局 `0 observation => hard fail`；
- 不得用 uninstall / `pm clear` 绕过模拟器问题；
- 不得提前升版本。

---

# 3. 开工前：以本地实际代码为唯一真相

Agent 先执行：

```powershell
cd F:\ClaudeWorkSpace\projects\TAVO-MINI

git status
git fetch --all --prune
git rev-parse HEAD
git rev-parse origin/main
git rev-list --left-right --count HEAD...origin/main
git log -10 --oneline
```

规则：

1. 不得覆盖本地未提交修改。
2. 不得 `reset --hard`。
3. 不得 `git clean`。
4. 如果本地已经领先远端：
   - 先审计本地最新实现；
   - 已解决问题只补测试，不重复修改。
5. 本方案里的函数名仅为参考。
6. 最终实现必须以本地真实调用链为准。

---

# 4. 开工前必须重新确认接驳链

使用：

```powershell
rg -n "applyStoryMemoryBatchPatch|batchPatchToChapterDraft|applyStoryMemoryPatch|compileStoryMemoryObservations|saveStoryMemoryBatchUpdate|StoryMemoryState|firstSeenChapterId|openedChapterId|lastChangedChapterId|timelineAnchors" src __tests__
```

确认真实链：

```text
Observation
→ Compiler
→ StoryMemoryBatchPatchDraft
→ validateCompiledStoryMemoryBatchPatch
→ batchPatchToChapterDraft
→ applyStoryMemoryPatch / applyStoryMemoryBatchPatch
→ StoryMemoryState
→ saveStoryMemoryBatchUpdate
→ Context Consumer
```

本轮重点修：

```text
BatchPatch
→ ChapterPatch adapter
→ Merger
```

这一层。

---

# 5. P0-1：修复 Batch 内时间元数据压平

## 5.1 根因

当前整个 Batch 最终使用：

```text
rangeRef.throughChapterId
rangeRef.throughPosition
```

作为 Merger context。

因此：

```text
CH1 open
CH2 update
CH3 resolve
```

最终很多实体被记成：

```text
CH3 open
CH3 update
CH3 resolve
```

最终状态值虽然正确，但时间语义错误。

## 5.2 设计原则

**状态 Mutation 可以按 Batch 一次性应用，但时间元数据必须按每个 Patch Item 自己的 Evidence chapter 恢复。**

不要把 Batch 拆成三次 DB transaction。

继续保持：

```text
一个逻辑 Batch
→ 一次 Merger
→ 一次 CAS / DB
```

只把时间信息补全。

## 5.3 推荐最小实现

优先增加一个 Batch 内部的时间上下文：

```ts
interface StoryMemoryBatchTemporalContext {
  chapterPositionById: Map<number, number>;
}
```

在：

```text
applyStoryMemoryBatchPatch()
```

中根据：

```text
draft.chapterSummaries
draft.rangeRef
```

建立：

```text
chapterId -> chapterPosition
```

并向 Merger 传入。

不要新增 DB Schema。

## 5.4 时间解析工具

优先复用/补齐：

```ts
firstEvidenceChapterId(...)
lastEvidenceChapterId(...)
evidencePosition(...)
```

定义：

### first/open time

```text
first / earliest Evidence chapter
```

### last changed time

```text
latest Evidence chapter
```

不要默认 through chapter。

## 5.5 Character

新人物：

```text
firstSeenChapterId
firstSeenPosition
```

必须来自该人物 `newCharacters[].evidence` 的最早章节。

例如：

```text
CH1 character_new
CH2 character_state
CH3 character_state
```

最终：

```text
firstSeenChapterId = CH1
firstSeenPosition = CH1.position
lastChangedChapterId = CH3
lastChangedPosition = CH3.position
```

如果 new character 后续 update 已 fold 进同一 `newCharacters[]`，必须区分 first evidence 与 latest evidence。

## 5.6 Relationship

对于：

```text
newRelationships[]
```

应：

```text
firstSeenChapterId = earliest evidence chapter
lastChangedChapterId = latest evidence chapter
lastChangedPosition = latest evidence position
```

同批：

```text
CH1 open
CH2 update
```

最终必须：

```text
firstSeen = CH1
lastChanged = CH2
```

不能全部 CH3。

## 5.7 Conflict

对于：

```text
conflictUpserts[]
```

应：

```text
openedChapterId = earliest evidence chapter
lastChangedChapterId = latest evidence chapter
```

对于：

```text
conflictResolutions[]
```

resolve 的 completed beat / resolution 时间应取：

```text
resolution evidence chapter
```

不能默认 Batch through chapter。

例如：

```text
CH1 open
CH2 update
CH3 resolve
```

最终：

```text
openedChapterId = CH1
resolve chapter = CH3
```

如果最终 Conflict 被删除，只保留 completed beat，则 completed beat 的 `chapterId` 必须为 resolve evidence chapter。

## 5.8 Thread

对于：

```text
threadOpens[]
```

应：

```text
openedChapterId = earliest evidence chapter
lastChangedChapterId = latest open/update evidence chapter
```

对于：

```text
threadResolutions[]
```

应：

```text
resolvedChapterId = resolution evidence chapter
```

典型：

```text
CH1 open
CH2 update
CH3 resolve
```

最终：

```text
recentResolvedThreads.openedChapterId = CH1
recentResolvedThreads.resolvedChapterId = CH3
```

这是本轮最关键断言之一。

## 5.9 Foreshadowing

对于：

```text
foreshadowingUpserts[]
```

应：

```text
openedChapterId = earliest evidence chapter
lastChangedChapterId = latest evidence chapter
```

例如：

```text
CH1 open
CH2 update
CH3 partial
CH3 resolve
```

最终：

```text
openedChapterId = CH1
lastChangedChapterId = CH3
status = paid
```

## 5.10 Timeline Anchor

Timeline 本身有：

```text
chapterId
```

必须来自：

```text
timeline item evidence chapter
```

而不是 Batch through chapter。

## 5.11 Current Arc / Objective

如果这些状态有：

```text
startedChapterId
```

则 start 必须使用对应 Evidence chapter。

Completed Beat 应使用对应 Evidence chapter。

## 5.12 Existing Entity Update

对于已有 Character / Relationship：

```text
lastChangedChapterId
lastChangedPosition
```

应取该 update 的 Evidence chapter，而不是 Batch through。

如果同一个实体本 Batch 被多个 update：

```text
latest accepted evidence chapter
```

作为最终 lastChanged。

---

# 6. 不修改 LLM/Observation Schema

优先利用现有：

```text
BatchEvidenceQuote {
  chapterId
  quote
}
```

推导。

不要新增：

```text
firstSeenChapterId
openedChapterId
lastChangedChapterId
```

到 LLM / Observation contract。

原则继续保持：

> **模型只输出 Evidence；本地代码从 Evidence 推导时间。**

---

# 7. P0-1 自动化测试

新增独立 integration test：

```text
Story Memory batch temporal metadata
```

必须：

```text
compile
→ hard validate
→ applyStoryMemoryBatchPatch
→ final StoryMemoryState
```

## Case 1：Character

```text
CH1 new character
CH2 state update
CH3 state update
```

断言：

```text
firstSeenChapterId = CH1
firstSeenPosition = CH1.position
lastChangedChapterId = CH3
lastChangedPosition = CH3.position
```

## Case 2：Relationship

```text
CH1 open
CH2 update
```

断言：

```text
firstSeenChapterId = CH1
lastChangedChapterId = CH2
lastChangedPosition = CH2.position
```

## Case 3：Conflict

```text
CH1 open
CH2 update
CH3 resolve
```

断言：

```text
activeConflicts = empty
completedBeat.chapterId = CH3
```

## Case 4：Thread

```text
CH1 open
CH2 update
CH3 resolve
```

断言：

```text
recentResolvedThreads.openedChapterId = CH1
recentResolvedThreads.resolvedChapterId = CH3
```

## Case 5：Foreshadowing

```text
CH1 open
CH2 update
CH3 resolve
```

断言：

```text
openedChapterId = CH1
lastChangedChapterId = CH3
status = paid
```

## Case 6：Timeline

```text
CH2 timeline add
```

断言：

```text
timeline.chapterId = CH2
```

---

# 8. P0-2：把 known-change complex-long Gate 真正跑实

## 8.1 当前状态

代码已经正确改成：

```text
callLLMResult
→ buildStoryMemoryLLMConfig
→ STORY_MEMORY_V2_REQUEST_KINDS.primary
→ Provider Adapter
```

并已存在：

```text
evaluateStoryMemoryKnownChangeSemanticGate()
```

问题只剩：

> **真实 Live Jest 因没有 API Key 被 skip。**

## 8.2 本轮硬要求

必须在本地实际环境使用已有真实 LLM 配置完成一次：

```text
3 × 18000 chars
production Story Memory request policy
```

硬 Gate：

```text
HTTP 200
finishReason != length
JSON valid
coverage complete
observationsReceived > 0
observationsAccepted >= 3
semanticCategories.length > 0
compile PASS
hard validator PASS
applyStoryMemoryBatchPatch PASS
```

## 8.3 Live Jest 优先方案

如果本地已有：

```text
DEEPSEEK_API_KEY
```

直接：

```powershell
$env:LIVE_STORY_MEMORY="1"
$env:DEEPSEEK_API_KEY="..."
npx jest --runInBand __tests__/storyMemoryProtocolV2.live.test.ts
```

不得把 Key 写进：

- repo；
- markdown；
- log；
- test fixture。

## 8.4 如果环境变量不可用

不允许再手写一个临时 `fetch()`。

备选：

### A

通过 App 的已保存 LLM 配置运行真实测试。

### B

如果已有 Debug QA bridge 能调用 production request path，使用该 bridge。

但最终必须能拿到脱敏：

```text
observationsReceived
observationsAccepted
semanticCategories
finishReason
physicalAttemptCount
```

## 8.5 Android App known-change Gate

必须增加一轮比 M1 更强的真实 App 验证。

不是只看：

```text
state clean
checkpoint advanced
```

而是必须记录：

```text
observationsReceived > 0
observationsAccepted >= 3
semanticCategories 非空
```

再验证 DB：

```text
至少一个 Character / Objective / Thread / Conflict / Foreshadow / Timeline 实际发生变化
```

## 8.6 known-change 仍为 0 时

直接：

```text
NO-GO
```

不要增加重试次数。

按顺序检查：

1. Prompt 是否允许只写 brief/events。
2. Production Request Policy 是否实际传到 provider。
3. thinking=disabled 是否真正进入 outbound config。
4. provider content/reasoning extraction。
5. response_format 行为。
6. 章节正文 / Evidence Anchor 是否把事实切碎。
7. Output contract 是否被模型忽略。

只有确认 Prompt 问题时才做最小 Prompt 修改。

---

# 9. Prompt 修改边界

只有真实 known-change Gate 再次 `0 Observation` 时才允许改。

最多补充：

```text
若正文明确出现会影响后续连续性的变化，包括人物状态、持有物、关系、当前目标、冲突、线索、伏笔或关键时间线，必须输出对应 observation。
brief/events 不能替代应该存在的 observation。
只有确实不存在持续性变化时 observations 才可为空。
```

不得：

- 增加 DB schema；
- 增加 patch 字段；
- 要求模型输出 stable ID；
- 恢复 evidenceQuote；
- 恢复巨型 Patch Prompt。

---

# 10. P1：Future Ref Diagnostics

当前：

```text
OBS_FUTURE_REF
```

不应继续归到：

```text
invalid_observation
```

推荐新增：

```ts
StoryMemoryV2DropReason =
  ...
  | 'future_ref'
```

并：

```ts
case 'OBS_FUTURE_REF':
  return 'future_ref'
```

若不想扩 diagnostics union，也至少：

```text
OBS_FUTURE_REF → invalid_ref
```

优先独立 `future_ref`，方便后续 QA。

---

# 11. 100/300/1000 压测

本轮不再重写。

只做回归：

```text
100
300
1000
```

确认：

```text
Arc retained
Objective retained
Relevant entities retained
Final <= Burst 或 preflight split
```

并确保时间治理没有增加 Prompt 内容。

---

# 12. 流水线接驳 Gate

## Gate A：Compiler → Validator

不变。

模型错误局部 drop；本地结构错误 hard fail。

## Gate B：Validator → Merger

重点：

```text
时间元数据从 Evidence 推导
```

不得靠 through chapter。

## Gate C：Merger → CAS / DB

保持单次 Batch transaction。

不得拆成：

```text
CH1 apply
CH2 apply
CH3 apply
```

否则会破坏现有 Batch atomic / CAS / partial success 语义。

## Gate D：Merger → Context Consumer

验证下一章上下文：

- resolved Thread 不作为 open；
- paid Foreshadow 不作为 unfulfilled；
- currentObjective 正确；
- temporal metadata 没导致排序异常。

## Gate E：Maintenance / Rebuild

回归：

```text
auto maintenance
manual rebuild
single chapter
split child
```

至少 smoke。

## Gate F：Durable

不改。

只做：

```text
outcome_unknown smoke
```

---

# 13. Android 模拟器最终穿测

本地路径：

```text
F:\ClaudeWorkSpace\projects\TAVO-MINI
```

## 13.1 环境

```powershell
adb devices -l
```

记录：

```text
serial
Android release
API
ABI
```

## 13.2 覆盖安装

构建：

```powershell
npm run apk:debug
```

安装：

```powershell
adb -s <serial> install -r <apk>
```

禁止：

```text
adb uninstall
pm clear
```

## 13.3 M1：三章 Temporal Lifecycle

使用三章 QA：

### CH1

```text
守门人首次出现
建立关系
Conflict open
Thread open
Foreshadow open
```

### CH2

```text
人物状态变化
Relationship update
Conflict update
Thread update
Foreshadow update
Timeline add
```

### CH3

```text
Conflict resolve
Thread resolve
Foreshadow paid
```

通过 App 真实 Story Memory。

最终 DB 断言：

```text
character.firstSeen = CH1
relationship.firstSeen = CH1
relationship.lastChanged = CH2
resolvedThread.opened = CH1
resolvedThread.resolved = CH3
foreshadow.opened = CH1
foreshadow.lastChanged = CH3
timeline.chapterId = CH2
```

## 13.4 M2：Known-change Complex-long

使用：

```text
3 × 18000
```

真实 App 生产路径。

要求：

```text
observationsReceived > 0
observationsAccepted >= 3
semanticCategories > 0
```

同时 DB 有真实 state mutation。

## 13.5 M3：下一章 Context Preview

在 M1/M2 完成后：

```text
进入下一章 Context Preview
```

检查：

```text
current objective
relationship
open/resolved thread
foreshadow status
```

与 DB 一致。

## 13.6 M4：后台/锁屏 Smoke

Story Memory 执行中：

```text
Home
Lock
Wake
Resume
```

确认任务继续。

## 13.7 M5：Force-stop Smoke

只需一次：

```text
sent
→ force-stop
→ cold start
```

必须：

```text
outcome_unknown
无自动重发
```

---

# 14. 自动化测试

建议顺序：

```powershell
npx jest --runInBand __tests__/storyMemoryFinalGovernance.test.ts
```

再：

```powershell
npx jest --runInBand storyMemory
```

再：

```powershell
npm run verify
```

最后 Live：

```powershell
$env:LIVE_STORY_MEMORY="1"
npx jest --runInBand __tests__/storyMemoryProtocolV2.live.test.ts
```

若 Live 通过 App 路径完成，也必须把 production semantic metrics 写入报告。

---

# 15. 版本策略

当前远端：

```text
V2.11.47
```

## 如果 V2.11.47 尚未对外正式发布

允许：

> 保持 V2.11.47，不额外升版，只增加最终修复提交。

前提：

- Release APK 重新构建；
- 原 V2.11.47 APK 不再作为最终交付。

## 如果 V2.11.47 已经正式分发

必须：

```text
V2.11.48
```

不要重写已经发布的版本历史。

Agent 必须先确认本地实际发布状态。

---

# 16. Release Gate

全部通过后：

```text
verify:version
npm run verify
apk:debug
apk:release
```

Release APK 检查：

```text
package
versionName
versionCode
signer
zipalign
SHA256
```

---

# 17. 最终 GO Gate

## Gate 1

Batch 内 temporal metadata 全部真实。

## Gate 2

Character：

```text
firstSeenChapterId / Position
lastChangedChapterId / Position
```

正确。

## Gate 3

Relationship：

```text
firstSeen != through chapter
lastChanged = actual update chapter
```

正确。

## Gate 4

Thread：

```text
opened = CH1
resolved = CH3
```

正确。

## Gate 5

Foreshadow：

```text
opened = CH1
lastChanged = CH3
paid
```

正确。

## Gate 6

Timeline chapterId 正确。

## Gate 7

known-change complex-long：

```text
received > 0
accepted >= 3
semantic category > 0
```

真实跑通。

## Gate 8

production Request Path 同构。

## Gate 9

Android M1～M5 PASS。

## Gate 10

`npm run verify` PASS。

---

# 18. NO-GO 条件

以下任一出现：

```text
firstSeen/opened 仍取 Batch through chapter
resolvedThread.opened == resolved chapter
timeline 被写到 through chapter
known-change Live 仍 skip
known-change accepted = 0
semantic categories = empty
为修时间元数据新增 DB Schema
拆 Batch 成多次 CAS/DB apply
物理 HTTP > 3
需要 uninstall/pm clear 才能测试
npm run verify fail
```

直接：

```text
NO-GO
```

---

# 19. 最终验收报告

Agent 完成后生成：

```text
docs/optimization/Story-Memory-Protocol-V2-Final-Seal-Verification-YYYYMMDD.md
```

必须包含：

1. 本地初始 HEAD；
2. origin/main；
3. 最终 HEAD；
4. 修复文件；
5. Batch→Merger temporal root cause；
6. temporal helper / context 设计；
7. Character temporal tests；
8. Relationship temporal tests；
9. Conflict temporal tests；
10. Thread temporal tests；
11. Foreshadow temporal tests；
12. Timeline test；
13. complex-long production Live 数据；
14. observationsReceived；
15. observationsAccepted；
16. semanticCategories；
17. physical attempts；
18. Android M1～M5；
19. `npm run verify`；
20. APK 信息；
21. 最终 GO / NO-GO。

---

# 20. 可直接交给 Agent 的简短执行提示词

```text
以 `F:\ClaudeWorkSpace\projects\TAVO-MINI` 本地实际代码为唯一实施真相。先执行 git status、git fetch --all --prune，核对 HEAD/origin/main 并保留所有未提交修改；完整阅读 docs\optimization 下最新的 Story Memory Protocol V2 最终封板方案，并先用 rg 复核实际 `Compiler → Batch Patch → Validator → batchPatchToChapterDraft → Merger → CAS/DB → Context Consumer` 接驳链。

本轮禁止继续扩架构，只关闭两个 P0：① 修复 3 章 Batch 被旧 Merger 用 through chapter 压平时间元数据的问题。所有 Character/Relationship/Conflict/Thread/Foreshadow/Timeline 的 firstSeen/opened/lastChanged/resolved chapter/position 必须从各自 BatchEvidenceQuote 的真实章节本地推导；保持单 Batch 单次 CAS/DB，禁止拆成逐章 apply、禁止改 Schema。② 真正跑通原 complex-long 3×18000 的 production-policy known-change Gate，必须走生产 callLLMResult / Story Memory Request Policy / Provider Adapter，要求 observationsReceived>0、observationsAccepted>=3、semanticCategories 非空，并实际 compile/validate/apply 成功；不能再用 HTTP200、state clean 或被 skip 的 Live test 宣称通过。顺手将 OBS_FUTURE_REF diagnostics 单独归类。

所有问题先补失败测试，再最小修复。Temporal lifecycle 测试必须走 compile→hard validate→applyStoryMemoryBatchPatch→final State，并断言 CH1 open、CH2 update、CH3 resolve 的真实时间字段。完成后跑 Story Memory 专项、npm run verify，并在现有 Android 模拟器用 adb install -r 覆盖 Debug APK，禁止 uninstall/pm clear，完成 temporal lifecycle、complex-long known-change、下一章 context preview、后台/锁屏、force-stop outcome_unknown smoke。

全部 Gate 通过前不得升版或宣称 GO；若 V2.11.47 尚未对外发布可保持版本并重构最终 APK，若已对外发布则顺延 V2.11.48。最后生成 Story-Memory-Protocol-V2-Final-Seal-Verification-YYYYMMDD.md，给出真实证据与最终 GO/NO-GO。
```

---

# 21. 最终期望

完成本轮后，Story Memory V2 应真正达到：

```text
模型事实在哪章发生
→ Evidence 指向那章
→ Compiler 保留那章
→ Merger 写入那章
→ DB 时间元数据仍是那章
→ 后续 Context 消费保持一致

known-change 长篇
→ 不允许 0 Observation 假成功
→ 必须真实提取连续性状态
```

如果这两个 P0 关闭，Story Memory Protocol V2 可进入最终封板状态。
