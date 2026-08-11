# Tavo-Mini Story Memory Protocol V2 最终收尾治理与流水线接驳验收方案

> 项目：`anjingdtl/tavo-mini`  
> 本地实施仓：`F:\ClaudeWorkSpace\projects\TAVO-MINI`  
> 远端参考基线：`main@bff1243941ffb35bc3daf85551a55b67986d438d`  
> 远端参考版本：`V2.11.46 / versionCode=2114600 / Schema 50`  
> 方案日期：2026-08-11  
> 定位：**最终收尾治理，不再扩展 Story Memory Protocol V2 架构。**  
> 实施原则：**以本地实际代码、实际调用链、实际测试结果为唯一真相；本文和远端仓仅作审计参考。**

---

# 0. 本轮目标

V2.11.46 已完成 Story Memory Protocol V2 主体：

```text
章节正文
→ Evidence Anchor
→ Entity Handle
→ Semantic Observation
→ Local Normalizer
→ Local Compiler
→ StoryMemoryBatchPatchDraft
→ Merger / CAS / DB
```

上一轮 Closure 已完成 rejected Observation 不污染 derived summary、Same-CH Evidence、accepted 后注册 N-key、Arc/Objective mandatory、主线 whole-item、packing starvation、Fresh Retry Elastic re-plan、accumulated-state 压测等收束。

本轮只处理最终验收发现的 **3 个 P0 + 1 个 P1 证据增强项**：

1. **禁止 same-batch N-key 向未来引用。**
2. **补齐 same-batch entity lifecycle，重点 Relationship / Conflict。**
3. **消除 known-change complex-long 出现 `observationsAccepted=0` 却被判成功的“假成功/静默漏记”风险，并让 Live QA 与生产请求完全同构。**
4. **加强 100/300/1000 accumulated-state 的增长曲线证据。**

同时必须重点检查 Story Memory 与外围流水线的接驳，避免局部 Compiler 修复导致：

- Merger 不识别 temp ref；
- checkpoint 与 single chapter / rebuild 行为不一致；
- maintenance 错误推进；
- chapter summary 与长期状态不一致；
- 下一章写作上下文读取到旧/空 Story Memory；
- Debug QA 与生产请求参数不一致；
- CAS / outcome_unknown / Foreground 回归。

---

# 1. 第一原则：本地实际代码优先

Agent 开始前必须执行：

```powershell
cd F:\ClaudeWorkSpace\projects\TAVO-MINI

git status
git fetch --all --prune
git rev-parse HEAD
git rev-parse origin/main
git log -10 --oneline
```

规则：

1. 本地工作树是唯一实施真相。
2. 不得 `reset --hard`。
3. 不得 `git clean`。
4. 不得覆盖用户已有未提交修改。
5. 如果本地 HEAD 已比远端更新，先阅读本地差异；已经解决的问题只验证，不重复施工。
6. 如果本地函数名、模块边界与本文不同，以本地真实调用链为准，并在最终报告记录差异。
7. 不允许为了“让方案对得上”而反向改造本地架构。

---

# 2. 开工前必须建立真实 Story Memory 调用图

先运行类似：

```powershell
rg -n "compileStoryMemoryObservations|runObservationCheckpointAttemptLoop|advanceStoryMemory|requestStoryMemoryMaintenance|generateValidatedChapterMemoryPatch|saveStoryMemoryBatchUpdate|StoryMemoryState|memory_summary|storyMemory" src android __tests__
```

如果本地符号已变化，则继续根据命中结果追踪。

至少要确认本地真实链路：

```text
【入口】
章节定稿 / 自动维护 / 手动整理 / Rebuild
        │
        ▼
Story Memory maintenance / checkpoint scheduler
        │
        ▼
Protocol V2 Materials + Request Policy
        │
        ▼
Primary / Formatter / Fresh Retry
        │
        ▼
Normalizer
        │
        ▼
Observation Compiler
        │
        ▼
Compiled Batch Patch Validator
        │
        ▼
Merger
        │
        ▼
CAS / saveStoryMemoryBatchUpdate
        │
        ├── StoryMemoryState
        ├── chapter episodic summary
        ├── snapshot
        └── request ledger
        │
        ▼
【消费端】
写作上下文 / Story Memory UI / 后续 maintenance / Rebuild
```

最终验证报告必须列出本地真实文件和真实函数名。

---

# 3. 修复边界

## 3.1 允许修改

优先限制在：

```text
src/services/storyMemory/storyMemoryObservationCompiler.ts
src/services/storyMemory/storyMemoryEvidenceAnchors.ts
src/services/storyMemory/storyMemoryRequestBudget.ts
src/services/storyMemory/storyMemoryCheckpointService.ts
src/services/storyMemory/storyMemoryObservationPrompts.ts
src/services/storyMemory/storyMemoryRequestPolicy.ts
Story Memory tests / live QA / debug QA
```

如果本地实际调用链证明需要，可最小修改：

```text
storyMemoryMerger.ts
storyMemoryService.ts
storyMemoryRebuild.ts
Story Memory diagnostics
共享 LLM request adapter
Android Debug QA seam
```

任何越过初始边界的修改必须在报告中说明根因。

## 3.2 禁止事项

没有明确根因证据时，不得修改：

```text
Outline Pipeline
Continuation
Canon
通用 Draft / Review / FactCheck / Brief / Final 协议
Schema 50
Foreground Service 架构
Task Store 架构
CAS / Fingerprint 核心语义
request ledger / outcome_unknown 核心语义
Batch Size > 3
P2
```

同时禁止：

- 新建第二套 LLM Request Runner；
- 新建第二套 Elastic Allocator；
- 增加物理 HTTP 上限；
- 用多重试掩盖语义漏记；
- 用全局放宽 Validator 解决局部 Compiler Bug；
- 恢复 V1 巨型 DB Patch Prompt 为生产主路径。

---

# 4. P0-1：禁止 N-key 向未来引用

## 4.1 当前风险

V2.11.46 Two-pass 思路正确：

```text
Pass 1：定义型 Observation
Pass 2：引用/更新型 Observation
```

但如果 Pass 1 先注册整个 3 章 Batch 的全部定义：

```text
CH01
relationship open C01 -> N1

CH02
character_new N1
```

那么 Pass 2 处理 CH01 时，N1 已因 CH02 定义而存在，导致第 8 章可以引用第 9 章才首次出现的人物。

Thread / Conflict / Foreshadowing 同样存在时间语义风险。

## 4.2 正确治理模型

Accepted N-key registry 不应只保存：

```ts
N1 -> ref
```

至少应保留定义位置元数据：

```ts
interface AcceptedLocalRef {
  ref: string;
  definedChapterId: number;
  definedChapterPosition: number;
  definedEvidenceOffset: number;
  kind: 'character' | 'relationship' | 'conflict' | 'thread' | 'foreshadowing';
}
```

实际类型名称以本地风格为准。

## 4.3 Chronology Rule

引用 N-key 时：

### 跨章

```text
reference.chapterPosition > definition.chapterPosition
→ 允许

reference.chapterPosition < definition.chapterPosition
→ OBS_FUTURE_REF / OBS_INVALID_REF
→ 当前 Observation 局部 drop
```

### 同章

使用 Evidence offset：

```text
reference earliestEvidenceOffset >= definition earliestEvidenceOffset
→ 允许

reference earliestEvidenceOffset < definition earliestEvidenceOffset
→ 局部 drop
```

如果 Observation Evidence 本身无效，先按 `OBS_INVALID_EVIDENCE` drop，不绕过 chronology。

Existing Handle（C/R/F/T/P/A）来自 Previous State，不受本批 chronology 限制。

## 4.4 回归测试

至少：

```text
future character ref
future relationship ref
future conflict ref
future thread ref
future foreshadow ref
same-chapter earlier ref
same-chapter later valid ref
```

所有 future ref：

```text
仅当前 Observation drop
不污染 summary
不 hard-fail batch
```

---

# 5. P0-2：补齐 Same-batch Entity Lifecycle

## 5.1 原则

一个 3 章 Batch 里实体可能：

```text
open/create
→ update
→ resolve/partial
```

不能因为 Batch 开始前不存在就漏掉后续变化。

但同样不能为了支持 lifecycle 就让 temp ref 无条件穿透到 Merger。

**施工前必须先检查本地 Merger 对每种 tempRef 的真实支持能力。**

## 5.2 接驳专项审计

在本地搜索：

```powershell
rg -n "tempRef|new_rel|new_conflict|new_thread|new_foreshadow|relationshipUpdates|conflictResolutions|threadResolutions|foreshadowingUpserts" src/services/storyMemory
```

逐项确认：

- new character temp ref 如何映射 stable ID；
- new relationship temp ref 是否可被 relationshipUpdates 引用；
- new conflict ref 是否可被 conflictResolutions 引用；
- new thread ref 是否可被 update/resolution 引用；
- new foreshadow ref 是否支持 partial/resolve。

不得凭假设修改。

## 5.3 Relationship Closure

目标：

```text
relationship open N2
→ same-batch update N2
```

如果现有 `relationshipUpdates` 只接受 Previous State stable ID，则**不要扩 Merger**，优先在 Compiler 内把 update 折叠进 `BatchNewRelationshipPatch`：

- currentState；
- trustLevel；
- publicStatus；
- hiddenStatus；
- reason；
- evidence。

最终只输出 `newRelationships[]`，避免 temp relationship ref 进入不支持的更新结构。

## 5.4 Conflict Closure

目标：

```text
open → update → resolve
```

### Open + Update

优先折叠进 `conflictUpserts`。

### Open + Resolve

先检查本地 Merger 是否已拥有通用 same-batch temp-ref resolver。

如果 Thread 已有通用机制而 Conflict 只是漏接映射，可以最小复用该 resolver。

如果 Merger 不支持，不得直接放宽 Validator。优先：

1. Compiler net-effect fold；或
2. 仅在有明确测试证据时做最小 Merger adapter。

不得建立第二套 ref resolver。

## 5.5 Thread Closure

即使当前已支持，也必须完整回归：

```text
open N
→ update N
→ resolve N
```

防止 chronology 修复造成回归。

## 5.6 Foreshadowing Closure

覆盖：

```text
open
→ update
→ partial
→ resolve
```

验证：

- 同批 N-key update；
- partially_paid；
- paid/resolved；
- Evidence 合并；
- chronology。

## 5.7 Lifecycle 测试必须走到最终 State

至少覆盖：

| Entity | Test |
|---|---|
| Character | new → state update |
| Relationship | open → update |
| Conflict | open → update |
| Conflict | open → resolve |
| Thread | open → update |
| Thread | open → resolve |
| Foreshadowing | open → update |
| Foreshadowing | open → partial |
| Foreshadowing | open → resolve |

**每个测试必须：**

```text
compile
→ validateCompiledPatch
→ actual merger/apply
→ assert final StoryMemoryState
```

不能只证明 `compile()` 成功。

---

# 6. P0-3：Known-change Fixture 禁止“0 Observation 假成功”

## 6.1 风险定义

上一轮真实 complex-long Fixture 中，章节明确包含：

- 银钥匙出现和使用；
- 进入地下室；
- 守门人退开；
- 三角刻痕；
- 铁门打开；
- 机关启动；
- 祭坛触发；
- 更深通道出现。

真实模型曾出现：

```text
HTTP 200
JSON valid
coverage valid
observationsReceived = 0
```

技术协议因此 PASS，但 known-change QA 语义不合格。

风险是：

> checkpoint 被推进，但长期 State 没真正记住关键变化。

## 6.2 不得采用的修法

禁止在生产代码直接：

```ts
if (observations.length === 0) throw
```

因为确实存在没有持续性变化的章节。

也禁止：

- 每章强制固定 N 个 Observation；
- 从 events/brief 反编译 DB Patch；
- 全局开启高 Thinking；
- 增加第四、第五次 HTTP。

## 6.3 正确方案：QA Semantic Gate

建立 known-change fixture 的最低质量合同，例如：

```ts
expectedSemanticSignals = {
  minAcceptedObservations: 3,
  anyOf: [
    'possession',
    'objective',
    'thread',
    'foreshadowing',
    'timeline'
  ]
}
```

不死匹配模型具体文字，但必须证明关键连续性状态被抽取。

## 6.4 Live QA 必须复用生产 Request Path

本轮硬要求：

**不得再在 Live test 自己写一套 `fetch()` + 独立 temperature / response_format。**

Live QA 必须沿用本地实际生产使用的：

```text
Story Memory request policy
LLM config builder
provider adapter
callLLM / callLLMResult
response extraction
thinking policy
temperature
response_format
request hooks
```

当前远端参考意图为：

```text
temperature = 0.1
thinking = disabled
responseFormat = json_object
```

如果本地实际代码已变化，以本地真实 outbound policy 为准。

## 6.5 实现优先级

### 优先 A

Live test 直接调用真实 production request adapter。

### 备选 B

如果生产函数无法从测试调用，只抽取一个**真正共享**的低层 request function：

```text
Production
Live QA
   ↓
same shared request adapter
```

禁止形成 Production adapter / Live adapter 两套语义。

## 6.6 Known-change 真正硬 Gate

最终真实模型测试必须满足：

```text
3 × 18000 complex-long
production request policy
HTTP 200
finishReason != length
JSON valid
coverage complete
observationsReceived > 0
observationsAccepted > 0
```

并至少有若干实际 Patch 类别：

```text
character possession/state
objective
conflict/thread
foreshadowing
timeline
relationship
```

不要求固定 wording。

## 6.7 如果仍是 0 Observation

不得宣称 GO。按顺序排查：

### A. Prompt

是否过度允许“只写 brief/events，observations=[]”。

必要时只做最小增强：

```text
若正文明确产生会影响后续连续性的事实变化（人物状态、持有物、关系、当前目标、冲突、线索、伏笔或关键时间线），必须输出对应 observation。
只有确实不存在持续性变化时，observations 才可为空。
brief/events 不能替代应有的 observation。
```

### B. Prompt 注意力

检查 system protocol、contract、Mandatory state、正文规模和 schema 长度。

### C. Provider channel

检查 production response 中：

```text
contentChars
reasoningChars
finishReason
```

不要记录 reasoning 原文。

如果 reasoning 很长而 content 只有空 Observation，应处理 provider response/request policy，不要改 Compiler。

### D. thinking=disabled 是否真的进入 outbound request

不能只看常量，要查实际 provider adapter。

### E. response_format 兼容性

确认实际 DeepSeek/OpenAI-compatible 生产调用。

## 6.8 默认不增加“零 Observation 自动付费重试”

零变化章节合法，不能用启发式制造成本。若真实数据证明某 provider 长期语义漏记，应作为新问题单独设计，不在本轮偷加全局 retry。

---

# 7. P1：100/300/1000 accumulated-state 证据增强

保留已有真实增长 fixture，同时统一记录：

```text
100章：
  totalStateEntities
  fullInputTokens
  finalInputTokens64K
  includedCount
  droppedCount

300章：...
1000章：...
```

关键硬条件：

```text
finalInputTokens <= burstInputLimit
或发送前 preflight_split

currentArc retained
currentObjective retained
current chapter anchors retained
relevant character(s) retained
whole-item complete
```

不强行设置“1000章必须小于100章1.5倍”之类脆弱比例。

重点证明 Final Prompt 受 Context Budget + relevance 控制，而不是随历史实体无界膨胀。

---

# 8. 流水线接驳点治理

## 8.1 Compiler → Batch Patch Validator

边界必须保持：

```text
模型数据质量错误
→ Local Drop / Warning

本地 Compiler 生成非法结构
→ Hard Fail
```

不得为 lifecycle 放宽 Hard Validator。

## 8.2 Compiler → Merger

这是最高风险接点。

所有新增 same-batch temp ref 都必须证明 Merger 可消费。

如果 Merger 不支持：

> 优先 Compiler fold，不让 temp ref 穿透。

专项测试必须：

```text
compile
→ hard validate
→ applyStoryMemoryBatchPatch / 本地实际 merger
→ assert final StoryMemoryState
```

## 8.3 Merger → CAS / DB

保留：

```text
base fingerprint
source fingerprint
state fingerprint
CAS
saveStoryMemoryBatchUpdate
```

不得拆成多个非事务写入模拟生命周期。

## 8.4 State → Episodic Summary

Rejected/future Observation 不得进入：

- derived events；
- characterChanges；
- relationshipChanges；
- mainlineChanges；
- newThreads；
- resolvedThreads。

同 Batch open→resolve 可以在 Episodic Memory 记录“发生过并已解决”，但 Hot State 最终不能残留 open。

## 8.5 Checkpoint → Maintenance Scheduler

不要全局把 `observations=0` 改成失败。

Known-change 0 Observation 只作为 QA Gate。

回归：

- split child progress；
- partial success；
- automatic maintenance；
- pending remaining。

## 8.6 Checkpoint → Single Chapter / Rebuild

搜索本地实际代码，确认：

```text
checkpoint
single-chapter patch
full rebuild
legacy bootstrap
```

仍统一走 Protocol V2 新请求或共享 Compiler。

避免出现 checkpoint 修好了，而 rebuild 仍使用旧时间语义。

## 8.7 Story Memory → 下一章写作上下文

必须找出所有读取：

```text
StoryMemoryState
memory_summary
chapter episodic summary
mainline
```

进入写作/上下文的地方。

验证：

- resolved thread 不再作为 open 注入；
- currentObjective 正确；
- 新人物/关系可被后续章节消费；
- rejected/future ref 不进入上下文；
- Story Memory 为空时 Pipeline 不崩。

**只验证接驳，不重构写作 Pipeline。**

## 8.8 Request Policy → Provider

Live QA 与生产必须共享：

- model；
- provider；
- URL；
- temperature；
- thinking；
- response_format；
- max_tokens；
- timeout；
- physical request hooks。

## 8.9 Foreground / outcome_unknown

本轮理论上不修改，只做 smoke：

```text
后台运行仍继续
force-stop sent → outcome_unknown
不自动重发
```

如果 Agent 改到了这些模块，则恢复完整长测 Gate。

---

# 9. 自动化测试矩阵

## Gate A — Chronology

```text
future character ref
future relationship ref
future conflict ref
future thread ref
future foreshadow ref
same-chapter earlier ref
same-chapter later valid ref
```

## Gate B — Same-batch Lifecycle

```text
character new → update
relationship open → update
conflict open → update
conflict open → resolve
thread open → update
thread open → resolve
foreshadow open → update
foreshadow open → partial
foreshadow open → resolve
```

每项必须跑至 final State。

## Gate C — Summary Integrity

所有 rejected/future ref：

```text
State 无污染
Episodic Summary 无污染
```

## Gate D — Existing State Regression

已有 C/R/F/T/P update/resolve 行为保持不变。

## Gate E — Attempt Budget

```text
physical HTTP <= 3
```

## Gate F — 100/300/1000

输出真实指标。

## Gate G — Full Regression

```powershell
npm run verify
```

必须 PASS。

---

# 10. 本地 Android 模拟器真实测试

本轮必须加入模拟器实际 App 测试。

## 10.1 环境发现

```powershell
adb devices -l
```

如果有多个设备，固定 `adb -s <serial>`。

记录：

```powershell
adb -s <serial> shell getprop ro.build.version.release
adb -s <serial> shell getprop ro.build.version.sdk
adb -s <serial> shell getprop ro.product.cpu.abi
```

## 10.2 覆盖安装前快照

禁止卸载和清数据。

```powershell
adb -s <serial> shell dumpsys package com.shinewriter
```

保存：

```text
firstInstallTime
lastUpdateTime
versionName
versionCode
```

并通过现有 UI/Debug 诊断确认：

- 项目存在；
- 章节存在；
- LLM provider 配置存在；
- Story Memory State 存在；
- ledger 存在。

不得输出 API Key。

## 10.3 构建 Debug APK

```powershell
npm run apk:debug
```

确认产物来自当前本地代码。

## 10.4 覆盖安装

```powershell
adb -s <serial> install -r <debug-apk>
```

如项目既有 QA 规则要求其它兼容参数，可按本地规范处理，但禁止：

```text
adb uninstall
pm clear
rm app data
```

安装后重新确认 firstInstallTime 不变、版本更新、数据保留。

---

# 11. 模拟器 Test M1：Known-change 真实生产路径

准备专门测试项目，3 章至少包含：

- 人物状态变化；
- 物品变化；
- thread/conflict；
- objective/timeline。

通过 App 实际入口触发：

```text
立即整理长期记忆
或实际 maintenance
```

禁止用 host-side 自建 fetch 替代。

验收：

```text
任务成功
observationsReceived > 0
observationsAccepted > 0
最终 StoryMemoryState 有实际变化
Episodic Summary 有对应变化
```

**HTTP 200 / 进度100% 不能单独算 PASS。**

---

# 12. 模拟器 Test M2：Same-batch Lifecycle

构造 3 章：

### CH1

```text
守门人首次出现；
与主角建立对峙关系；
开启“守门人阻拦”冲突。
```

### CH2

```text
关系缓和；
冲突状态变化；
开启地下室线索。
```

### CH3

```text
守门人放行；
冲突解决；
线索确认/解决；
伏笔部分或完成回收。
```

触发真实 Story Memory。

最终 State 必须：

- 新人物存在；
- Relationship 为最终更新状态；
- Conflict 不错误残留 open；
- Thread 最终状态正确；
- Foreshadowing 状态正确；
- Summary 时间顺序正确。

---

# 13. 模拟器 Test M3：防未来引用

优先由自动化单测覆盖。

如确需模拟器可控验证，可扩展**已有 Debug QA seam**，但必须满足：

- `BuildConfig.DEBUG` 门禁；
- Release 永远不可触发；
- 只注入模型结果；
- 仍经过真实 Normalizer → Compiler → Merger；
- 不直接制造成功 Patch。

注入：

```text
CH1 ref=N1
CH2 defines N1
```

期望：

```text
CH1 ref drop
CH2 definition accepted
batch applied
```

---

# 14. 模拟器 Test M4：后台 Smoke

Story Memory 整理中：

```text
Home
切换 App
锁屏
```

确认：

- Foreground Service 保持；
- task progress 正常；
- 回 App 状态正确。

如果本轮未修改 Foreground 层，无需重复超长稳定性测试。

---

# 15. 模拟器 Test M5：Force-stop Smoke

如本轮未修改 durable 层，只做一次 smoke：

```text
request sent
→ force-stop
→ cold start
```

要求：

```text
outcome_unknown
不静默自动重发
```

---

# 16. 模拟器 Test M6：写作流水线接驳

Story Memory 更新完成后，进入下一章写作/上下文预览。

检查：

```text
currentArc
currentObjective
相关人物
关系
未解决 thread
```

应来自最新状态。

已解决 Conflict/Thread 不应继续作为 Hot State 注入。

本 Gate 只验证消费，不修改 Outline/Continuation/Canon 架构。

---

# 17. 模拟器证据目录

保存到：

```text
test-logs/android-qa/story-memory-v2-final-governance-YYYYMMDD/
```

建议包含：

```text
adb-device.txt
package-before.txt
package-after.txt
install-r.txt
logcat-known-change.txt
logcat-lifecycle.txt
logcat-background.txt
logcat-force-stop.txt
story-memory-state-before.json   # 脱敏
story-memory-state-after.json    # 脱敏
```

不得保存：

- API Key；
- Authorization Header；
- 用户真实隐私正文；
- reasoning 原文。

统一使用专门 QA 小说 Fixture。

---

# 18. Host Live 与 Emulator 的职责

Host-side Live test 可以保留，但必须使用生产 Request Adapter。

```text
Host Live
→ 可重复验证模型/协议

Emulator Production Path
→ 验证真实 App 接驳
```

两者都不能自建另一套 HTTP policy 冒充生产请求。

---

# 19. Prompt 最小修正边界

只有 production-policy known-change 仍 `observations=0` 时才允许改 Prompt。

只允许最小增强，例如：

```text
若正文明确出现会影响后续连续性的事实变化（人物状态、持有物、关系、当前目标、冲突、线索、伏笔或关键时间线），必须输出对应 observation。
只有本章确实不存在任何持续性变化时，observations 才可为空。
brief/events 不能替代应有的 observation。
```

禁止：

- 增加 DB 字段；
- 恢复 schemaVersion/数据库 ID；
- 要求模型复制 evidenceQuote；
- 恢复 Summary 双写；
- 添加新的巨型数据库说明 Prompt。

---

# 20. 版本策略

当前远端参考版本为 V2.11.46。

施工前检查本地：

```text
package.json
src/constants/version.json
CHANGELOG.md
```

如果本地仍是 V2.11.46：

- 修复期间不提前升版；
- 全部 Gate PASS 后按项目 Release Policy 顺延补丁版本，通常为 V2.11.47。

如果本地已有更高版本：

> 以本地实际版本为准，不降版、不覆盖版本历史。

---

# 21. 最终发版 Gate

## Gate 1 — Local Truth

记录本地真实基线、调用图、变更范围。

## Gate 2 — No Future Ref

所有 N-key chronology tests PASS。

## Gate 3 — Same-batch Lifecycle

Relationship / Conflict / Thread / Foreshadowing 全部：

```text
compile → validate → merge → final state
```

PASS。

## Gate 4 — Summary Integrity

Rejected/future observations 不污染 Episodic Memory。

## Gate 5 — Known-change Semantic Quality

真实 production-policy complex fixture：

```text
observationsReceived > 0
observationsAccepted > 0
```

且有实际 Patch 连续性语义。

## Gate 6 — Production Request Parity

Live QA 不再手写独立 HTTP policy。

## Gate 7 — Accumulated State

100/300/1000：

```text
<= Burst 或发送前 Split
Arc/Object retained
relevant context retained
whole-item complete
```

## Gate 8 — Pipeline Junction

至少验证：

```text
Compiler
→ Validator
→ Merger
→ CAS/DB
→ Episodic Summary
→ 下一章 context consumer
```

## Gate 9 — Attempt / Durable

```text
physical HTTP <= 3
outcome_unknown 不回归
```

## Gate 10 — Emulator

M1～M6 按适用范围 PASS。

## Gate 11 — Full Regression

```text
npm run verify PASS
```

## Gate 12 — Release

全部前置 PASS 后才允许：

- 升版；
- 构建 Debug / Release；
- APK hard verification；
- 宣称 GO。

---

# 22. NO-GO 条件

任一情况直接 NO-GO：

1. CH1 能引用 CH2 才定义的 N-key。
2. Relationship open→update 被静默丢失。
3. Conflict open→resolve 被静默丢失或导致整批失败。
4. 为支持 lifecycle 放宽 Compiler Hard Validator。
5. Known-change 真实 Fixture 仍 `observationsAccepted=0`。
6. Live QA 仍使用与生产不同的自建 HTTP 配置。
7. Story Memory 显示成功但最终 State 无应有变化。
8. same-batch resolve 后，下一章上下文仍把实体作为 active/open 注入。
9. 修复导致 physical request >3。
10. 模拟器必须 uninstall/pm clear 才能通过。
11. `npm run verify` 失败。
12. 修改越过 Outline/Continuation/Canon 边界且无根因证据。

---

# 23. 最终验收报告

完成后生成：

```text
docs/optimization/Story-Memory-Protocol-V2-Final-Governance-Verification-YYYYMMDD.md
```

至少包含：

1. 本地初始 HEAD；
2. origin/main；
3. 最终 HEAD；
4. 本地真实 Story Memory 调用图；
5. 修改文件及原因；
6. N-key chronology 修复；
7. same-batch lifecycle 实现方式；
8. 是否修改 Merger及原因；
9. production/live request parity；
10. known-change 真实模型数据；
11. 100/300/1000 指标；
12. Compiler→Merger→DB 接驳测试；
13. 写作上下文消费验证；
14. Android 模拟器环境；
15. `adb install -r` 数据保留证据；
16. M1～M6 结果；
17. `npm run verify`；
18. 最终版本与 APK；
19. 最终 GO / NO-GO。

---

# 24. 可直接交给 Agent 的执行提示词

```text
以本地 `F:\ClaudeWorkSpace\projects\TAVO-MINI` 为唯一实施真相。先执行 `git status`、`git fetch --all --prune`、核对 HEAD/origin/main，并用 rg 建立 Story Memory 从章节入口→Protocol V2 request→Normalizer→Compiler→Validator→Merger/CAS/DB→maintenance/rebuild→下一章写作上下文消费的真实调用图；不得覆盖任何本地未提交修改，本文和远端只作为参考。

完整阅读 `docs/optimization` 下最新的《Story Memory Protocol V2 最终收尾治理与流水线接驳验收方案》，严格控制修复边界。本轮只收束三个 P0：1）N-key registry 增加定义章节/证据 offset，禁止 CH1 引用 CH2 才定义实体以及同章向未来引用；2）按本地 Merger 的真实 temp-ref 能力补齐 same-batch lifecycle，重点 Relationship open→update、Conflict open→update/resolve，并回归 Thread/Foreshadowing；Merger 不支持 temp ref 时优先在 Compiler 折叠，禁止为了测试通过全局放宽 Validator；3）known-change complex-long 真实测试必须使用与 App 完全相同的生产 Story Memory request policy/provider adapter，不再手写独立 fetch，并要求 observationsReceived/Accepted>0 且实际 Patch 包含连续性变化，HTTP200+空 Observation 不得判 PASS。

同步加强 100/300/1000 accumulated-state 指标，但不得扩架构、不得修改 Outline Pipeline/Continuation/Canon、不得新建第二套 Budget/Request Runner、不得扩大 Batch>3、不得增加物理重试上限、不得推进 P2。

所有修改先写失败测试复现，再最小修复。Lifecycle 测试必须走 `compile → hard validate → actual merger → final StoryMemoryState`，不能只测 Compiler。完成后跑 Story Memory 专项和 `npm run verify`。

必须在本地 Android 模拟器做实际 App 穿测：先 `adb devices -l`、记录 package/firstInstallTime/版本和现有数据，构建最终 Debug APK 后只允许 `adb install -r` 覆盖升级，禁止 uninstall/pm clear/清库。至少完成：known-change 真实生产路径、3章 same-batch lifecycle、防未来引用 Debug seam（如需要且仅限 BuildConfig.DEBUG）、后台/锁屏 smoke、force-stop outcome_unknown smoke、Story Memory 更新后下一章上下文消费验证。保留脱敏日志，不记录 API Key、Authorization 或 reasoning 原文。

全部 Gate PASS 前不得升版和宣称 GO；通过后按本地实际版本顺延补丁版本（若当前仍为 V2.11.46，通常升 V2.11.47），按 Release 指南构建/硬验收 APK，并生成 `docs/optimization/Story-Memory-Protocol-V2-Final-Governance-Verification-YYYYMMDD.md`，逐项给出真实证据与最终 GO/NO-GO。
```

---

# 25. 最终期望

完成本轮后，Story Memory 应达到真正的长期稳定状态：

```text
模型负责语义观察
程序负责机器契约

Evidence 不跨章
N-key 不向未来
同批生命周期闭环
坏 Observation 只局部失败
复杂章节不能假成功漏记
QA 与生产请求完全一致
1000章状态仍受预算约束
Merger/CAS/DB 接驳稳定
下一章真实能消费到正确记忆
后台/强杀/自动维护保持原有可靠性
```

此后除非真实长测发现新的确定根因，不再继续扩充 Story Memory 协议层。
