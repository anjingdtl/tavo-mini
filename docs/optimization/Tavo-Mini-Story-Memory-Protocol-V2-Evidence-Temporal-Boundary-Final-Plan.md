# Tavo-Mini Story Memory Protocol V2 最终 Evidence Temporal Boundary 收尾方案

> 项目：`anjingdtl/tavo-mini`<br>
> 本地实施仓：`F:\ClaudeWorkSpace\projects\TAVO-MINI`<br>
> 远端参考 HEAD：`9836adda3a9b016c9e99c7523ffacf18b358b747`<br>
> 当前参考版本：`V2.11.48 / versionCode=2114800 / Schema 50`<br>
> 日期：2026-08-11<br>
> 定位：**Story Memory Protocol V2 最后一个 P0 收尾。禁止继续扩架构。**

## 0. 当前状态

V2.11.48 已完成并冻结：Evidence Anchor、Entity Handle、Semantic Observation、Same-CH Evidence、N-key chronology、same-batch lifecycle、accepted-only summary、Whole-item Elastic、Fresh Retry、Batch temporal maps、单 Batch 单 CAS、complex-long `3×18000` production-policy Live Gate、Android temporal/background/outcome_unknown 验收和 `future_ref` diagnostics。

当前只剩最后一个 P0：

> Compiler 中多个 Observation 折叠为同一个 Patch Item 时，`mergeEvidence()` 仍直接 `slice(0,3)`。如果前 3 条 Evidence 都来自前章，最后章节 Evidence 会被裁掉；V2.11.48 Temporal Merger 又依赖 Patch Item 的 Evidence 推导 `firstSeen/opened/lastChanged/resolved`，因此会出现“最终状态是后章事实，但时间元数据仍停在前章”的边界错误。

---

## 1. 根因

当前逻辑类似：

```ts
function mergeEvidence(...groups: BatchEvidenceQuote[][]): BatchEvidenceQuote[] {
  const seen = new Set<string>();
  const merged: BatchEvidenceQuote[] = [];
  groups.flat().forEach(item => {
    const key = `${item.chapterId}\u0000${item.quote}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });
  return merged.slice(0, 3);
}
```

问题不是最大 3 条，而是“保留最前 3 条”而不是“保留最能代表时间边界的 3 条”。

典型失败：

```text
CH1:
Q001 character_new
Q002 state update
Q003 possession update

CH2:
Q006 final state update
```

最终 State 已包含 CH2 修改，但 Evidence 可能只剩 Q001/Q002/Q003，于是 Temporal Merger 得到：

```text
first = CH1
last  = CH1   // 错
```

Relationship、Foreshadowing 等同批 fold 同样存在。

---

## 2. 本轮唯一目标

把 Evidence 压缩规则改成：

> **最多仍为 3 条，但必须保住 Batch 时间边界。**

硬规则：

1. 最早 Evidence chapter 至少保留 1 条；
2. 最晚 Evidence chapter 至少保留 1 条；
3. 若一个 Patch Item 横跨 3 个 Batch chapter，则 3 章各保留至少 1 条；
4. Evidence 总量仍 `<=3`；
5. 不改 LLM contract；
6. 不改 DB Schema；
7. 不增加 HTTP；
8. 不拆 Batch；
9. 不改 Temporal Merger 总体架构；
10. 不放宽 Evidence grounding。

---

## 3. 本地实施原则

开始前：

```powershell
cd F:\ClaudeWorkSpace\projects\TAVO-MINI
git status
git fetch --all --prune
git rev-parse HEAD
git rev-parse origin/main
git rev-list --left-right --count HEAD...origin/main
git log -10 --oneline
```

要求：

- 本地代码是唯一实施真相；
- 不覆盖未提交修改；
- 不 `reset --hard`；
- 不 `git clean`；
- 如果本地已领先远端，先检查实际代码；已解决则只补 Gate。

---

## 4. 修复边界

优先只允许修改：

```text
src/services/storyMemory/storyMemoryObservationCompiler.ts
__tests__/storyMemoryBatchTemporalMetadata.test.ts
__tests__/storyMemoryFinalGovernance.test.ts
docs/optimization/Story-Memory-Protocol-V2-Evidence-Temporal-Boundary-Verification-YYYYMMDD.md
```

无新根因证据时禁止改：

```text
storyMemoryMerger.ts
storyMemoryObservationPrompts.ts
storyMemoryRequestBudget.ts
storyMemoryCheckpointService.ts
storyMemoryRequestPolicy.ts
DB Schema
Outline Pipeline
Continuation
Canon
Foreground/WakeLock
Task Store
CAS/Fingerprint
attempt ledger
outcome_unknown
```

---

## 5. 推荐实现：Temporal-Boundary Evidence Compaction

### 5.1 不扩大 Evidence 上限

禁止简单改成：

```ts
merged.slice(0, 6)
```

因为 Temporal Merger需要的是 first/last chapter，不是更多 Quote。

### 5.2 显式建立 chapter position map

在 `compileStoryMemoryObservations()` 内基于 ordered chapters：

```ts
const chapterPositionById = new Map(
  ordered.map(chapter => [chapter.id, chapter.position]),
);
```

不要假设 chapterId 数值顺序等于剧情顺序。

### 5.3 新 helper

建议：

```ts
mergeEvidencePreservingTemporalBoundary(
  chapterPositionById,
  ...groups
)
```

命名以本地代码风格为准。

### 5.4 算法

1. `groups.flat()`；
2. 按 `chapterId + quote` 去重；
3. 按 `chapterPositionById` 分组并排序；
4. 最多保留 3 条。

只有 1 个章节：

```text
普通保留最多 3 条
```

有 2 个章节：

```text
必须包含 earliest chapter
必须包含 latest chapter
第三条优先 latest chapter 的最后一条变化 Evidence
```

例如：

```text
CH1: Q001 Q002 Q003
CH2: Q006
```

不能再保留：

```text
Q001 Q002 Q003
```

应类似：

```text
Q001 Q003 Q006
```

有 3 个章节：

```text
[CH1 representative, CH2 representative, CH3 representative]
```

每章 1 条。

Representative 建议：

```text
earliest chapter：第一条
middle chapter：最后一条
latest chapter：最后一条
```

输出必须 deterministic：

```text
chapter position → chapter 内 accepted 顺序
```

---

## 6. 不要扩展时间 Schema

当前 StoryMemoryState 记录的是章节级：

```text
firstSeenChapterId
firstSeenPosition
lastChangedChapterId
lastChangedPosition
```

不需要新增 Evidence offset 到 DB。

模型继续只提供：

```text
Qxxx Evidence
```

本地代码负责推导时间。

---

## 7. 必须先补失败测试

### Case A：Character >3 Evidence

```text
CH1:
new
state
possession

CH2:
final state
```

断言：

```text
compiled newCharacter evidence 至少包含 CH1 + CH2
firstSeenChapterId = CH1
firstSeenPosition = CH1.position
lastChangedChapterId = CH2
lastChangedPosition = CH2.position
```

### Case B：Relationship >3 Evidence

```text
CH1:
open
update A
update B

CH2:
final update C
```

断言：

```text
firstSeen = CH1
lastChanged = CH2
currentState = final C
```

### Case C：Foreshadowing >3 Evidence

刻意构造前三条全在 CH1：

```text
CH1:
open
update
partial

CH3:
resolve
```

最终必须：

```text
status = paid
openedChapterId = CH1
lastChangedChapterId = CH3
```

这是本轮最关键 regression。

### Case D：3章 coverage

同一个 Patch Item 分别在 CH1/CH2/CH3 有 accepted Observation。

最终 `evidence.length <= 3` 且：

```text
chapterIds 覆盖 CH1、CH2、CH3
```

---

## 8. 测试必须走完整接驳链

不能只测 helper。

至少走：

```text
normalize
→ compileStoryMemoryObservations
→ validateCompiledStoryMemoryBatchPatch
→ applyStoryMemoryBatchPatch
→ final StoryMemoryState
```

目的是证明：

```text
Evidence 压缩正确
→ Temporal Maps 正确
→ Merger 时间正确
```

---

## 9. Evidence Validator 不能放宽

所有保留 Evidence 仍必须：

- 来自真实 Anchor；
- 同章；
- exact grounding；
- 不生成 synthetic quote；
- 不用 summary 替代 Anchor；
- 不重写 quote；
- 不降低 validator 严格度。

本轮只是从合法 Evidence 中选择最多 3 条。

---

## 10. Same-batch Lifecycle 回归

必须确认以下最终 State 不回归：

```text
Character new→update
Relationship open→update
Conflict open→update→resolve
Thread open→update→resolve
Foreshadow open→partial→resolve
```

原则：

> 只修 temporal metadata，不改变最终业务状态。

---

## 11. complex-long Live smoke

V2.11.48 已真实通过 `3×18000`，本轮只修改 Evidence retention，无需再做完整长测矩阵，但最终至少再跑一次 production-policy live smoke：

```powershell
$env:LIVE_STORY_MEMORY="1"
npx jest --runInBand __tests__/storyMemoryProtocolV2.live.test.ts
```

Gate：

```text
HTTP 200
finishReason != length
received > 0
accepted >= 3
semanticCategories > 0
compile PASS
validate PASS
apply PASS
```

不要求再次恰好 18/18，因为真实 LLM 输出可合理波动。

---

## 12. Android 模拟器 smoke

本轮不必重复之前全部 M1～M5，只需一个高价值 temporal stress。

环境：

```powershell
adb devices -l
npm run apk:debug
adb -s <serial> install -r <debug-apk>
```

禁止：

```text
adb uninstall
pm clear
```

### Temporal Stress Fixture

推荐 Foreshadow：

```text
CH1:
open
update
partial

CH3:
resolve
```

让同一 Patch Item 的原始 Evidence 数量 >3。

真实 App 整理后验证：

```text
status = paid
opened = CH1
lastChanged = CH3
```

同时进入下一章 Context / Story Memory UI 做 smoke：

- paid Foreshadow 不再作为 open/unfulfilled；
- resolved Thread 不再作为 open；
- Context 状态与 DB 一致。

本轮未改 durable/foreground，因此无需完整 force-stop 长测；如果实际修改触及 checkpoint/foreground/ledger，再恢复 M4/M5。

---

## 13. 建议测试顺序

```powershell
npx jest --runInBand __tests__/storyMemoryBatchTemporalMetadata.test.ts
npx jest --runInBand __tests__/storyMemoryFinalGovernance.test.ts
npx jest --runInBand storyMemory
npm run verify
$env:LIVE_STORY_MEMORY="1"
npx jest --runInBand __tests__/storyMemoryProtocolV2.live.test.ts
```

最后做 Android temporal stress smoke。

---

## 14. 版本策略

当前参考版本：`V2.11.48`。

如果 V2.11.48 尚未正式外部分发：

```text
可保持 V2.11.48，增加最终修复提交并重新构建 APK
```

如果 V2.11.48 已正式发布/分发：

```text
必须顺延 V2.11.49
```

以本地实际发布状态为准，禁止覆盖已对外版本历史。

---

## 15. 最终 GO Gate

全部满足才允许最终封板：

1. `mergeEvidence` 不再用简单 `slice(0,3)` 丢失 latest chapter；
2. 两章 Evidence 必须同时保住 earliest/latest；
3. 三章 Evidence 必须每章至少保留一条；
4. Character firstSeen/lastChanged 正确；
5. Relationship firstSeen/lastChanged 正确；
6. Foreshadow opened/lastChanged/paid 正确；
7. 完整 `compile→validate→apply→State` integration PASS；
8. Same-batch lifecycle regression PASS；
9. complex-long Live semantic smoke PASS；
10. `npm run verify` PASS；
11. Android >3 Evidence temporal stress PASS。

---

## 16. NO-GO 条件

以下任一发生即 NO-GO：

- 仍可能裁掉 final chapter Evidence；
- Final State 已更新但 `lastChangedChapterId` 停在前章；
- 为解决问题扩大 Evidence 上限；
- 修改 DB Schema；
- 修改 LLM Observation contract；
- 拆 Batch 为逐章 apply；
- 大范围重构 Merger/Request Pipeline；
- `npm run verify` fail；
- Live semantic Gate fail；
- Android temporal stress 仍复现时间错误。

---

## 17. 最终验收报告

完成后生成：

```text
docs/optimization/Story-Memory-Protocol-V2-Evidence-Temporal-Boundary-Verification-YYYYMMDD.md
```

必须包含：

1. 初始 HEAD / origin/main / 最终 HEAD；
2. 本地实际版本；
3. 原 `slice(0,3)` 根因；
4. 新 Evidence compaction 算法；
5. 是否继续保持 max=3；
6. Character regression；
7. Relationship regression；
8. Foreshadow regression；
9. 3-chapter coverage；
10. Temporal integration；
11. Story Memory suite；
12. `npm run verify`；
13. Live semantic smoke；
14. Android temporal stress；
15. 版本/APK；
16. 最终 GO / NO-GO。

---

## 18. 可直接交给 Agent 的提示词

```text
以 `F:\ClaudeWorkSpace\projects\TAVO-MINI` 本地实际代码为唯一实施真相。先执行 git status、git fetch --all --prune，核对 HEAD/origin/main 并保留全部未提交修改；完整阅读 docs\optimization 下最新的 Story Memory Protocol V2 Evidence Temporal Boundary 收尾方案。

本轮禁止继续扩 Story Memory 架构，只关闭最后一个 P0：当前 Compiler 的 mergeEvidence 最终直接 slice(0,3)，同一 Character/Relationship/Foreshadow 等实体在 3 章 Batch 内发生超过 3 次 accepted Observation 时，可能把最后章节 Evidence 裁掉，导致 V2.11.48 Temporal Merger 虽然最终状态正确，但 lastChanged/opened/resolved 时间错误。

先写失败测试，再最小修复。Evidence 上限仍必须保持最多 3 条，但压缩策略必须保住时间边界：至少保留 earliest chapter 1 条、latest chapter 1 条；若同一 Patch Item 横跨 3 个 Batch chapter，则每章至少保留 1 条。必须根据 ordered chapters 的 chapterId→position 排序，不得假设 chapterId 数值顺序，不得新增 DB Schema、不得修改 LLM contract、不得扩大 Evidence 上限、不得拆 Batch、不得修改 CAS/Request Runner。

重点补 4 类 regression：① CH1 character new+多次 update，CH2 final update，最终 firstSeen=CH1、lastChanged=CH2；② CH1 relationship open+多次 update，CH2 final update，最终 firstSeen=CH1、lastChanged=CH2；③ CH1 foreshadow open+update+partial，CH3 resolve，最终 opened=CH1、lastChanged=CH3、status=paid；④ 一个 Patch Item 横跨 CH1/CH2/CH3 时 Evidence 最大3条仍必须覆盖三章。测试必须走 normalize→compile→hard validate→applyStoryMemoryBatchPatch→final StoryMemoryState，不能只测 helper。

完成后跑 temporal/final-governance targeted、完整 Story Memory tests、npm run verify，并再跑一次 production-policy complex-long Live semantic smoke；在现有 Android 模拟器通过 adb install -r 覆盖 Debug APK，禁止 uninstall/pm clear，只做一次 >3 Evidence temporal stress 和下一章 Context smoke。全部 Gate 通过前不得宣称 GO；若 V2.11.48 已正式分发则顺延 V2.11.49，否则可保持当前版本并重构最终 APK。最后生成 Evidence Temporal Boundary Verification 报告并给出最终 GO/NO-GO。
```

---

## 19. 最终期望

完成后必须满足：

```text
同一 Patch Item 不论 fold 多少 accepted Observation
→ Evidence 仍最多 3 条
→ first chapter 永远可见
→ final chapter 永远可见
→ 3 章均有变化时每章至少留 1 条
→ Temporal Merger 始终得到正确 first/last chapter
→ Final State 与时间元数据一致
```

本轮通过后，Story Memory Protocol V2 应正式结束连续封板，不再继续增加协议复杂度。
