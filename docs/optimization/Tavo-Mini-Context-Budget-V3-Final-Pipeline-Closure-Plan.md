# Tavo-Mini Context Budget V3 最终收尾修复与流水线接驳验收方案

> 方案定位：Context Budget V3 最终封板 / Pipeline Integration Closure  
> 适用项目：Tavo-Mini  
> 实施原则：**以 Agent 当前所在开发机的本地 Git 仓实际代码为唯一实施真相，不写死任何本地目录。**  
> 远端参考基线：上一次独立验收时 `main` 为 `f73b91362f0b0cc6a47399cc754d832fe5f9ba6f`，但执行时不得假设该 SHA 仍为最新。  
> 日期：2026-08-12

---

# 1. 本轮目标

本轮不再扩建 Context Budget V3 架构，不重做已经完成的 Board / Item Allocator，而是对现有实现进行**最后一次接驳收口**。

当前主体方向已经成立：

```text
Model Context Window
  ↓
Soft / Burst / Hard Envelope
  ↓
Board-level Elastic Allocation
  ↓
Resources Candidate-first
  ↓
Item-level Elastic Allocation
  ↓
Final Context Assembly
```

本轮只解决最后几个阻塞发版的问题：

1. `contextBudgetVersion = 6` 与现有 Outline Pipeline 状态机接驳不完整；
2. V3 自动配置仍会把所有 LLM Config 的 `context_window` 改成统一值；
3. Story State / Sliding / Episodic 仍把旧静态预算当成 actual demand；
4. Resource Item 的最终字符串裁剪与 allocator grant 不严格同构；
5. Worldbook V3 激活时机与 V2 存在语义偏差；
6. V3 Policy 的读取、冻结、首次 Draft、Preview、Resume 没完全统一；
7. Android 端还没有真正完成用户最初问题场景和完整流水线的穿测。

最终目标不是“代码能跑”，而是：

> **V3 的预算语义、任务版本、真实模型容量、最终消息、Preview、Resume、批次与 Android 实机行为全部一致。**

---

# 2. 总原则

## 2.1 Local Repository Is Truth

Agent 开始后，先自行定位仓库根目录：

```bash
git rev-parse --show-toplevel
```

如果当前目录不是仓库，使用本机实际可用方式定位 tavo-mini 仓。

找到仓库后：

```bash
cd <repo-root>

git status
git fetch --all --prune
git rev-parse HEAD
git rev-parse origin/main
git rev-list --left-right --count HEAD...origin/main
git log -10 --oneline
```

要求：

- 本地仓是实现依据；
- 不得覆盖本地未提交修改；
- 不得为了“和远端一致”直接 reset；
- 若本地领先远端，以本地实际实现做修复；
- 若远端领先，先明确差异，再决定是否同步；
- 所有修复必须基于当前实际调用链，而不是仅按本方案中的历史文件名机械修改。

---

# 3. 本轮严格修复边界

## 3.1 允许修改

```text
Context Budget V3 Policy
Context Budget Version / Freeze / Resume
Outline Pipeline State Machine version predicates
Pipeline Task checkpoint creation
Multi-Chapter Batch version freeze/resume
Context Auto Config
Context Builder
Resource Candidate rendering
Story State demand collection
Sliding demand collection
Episodic demand collection
Worldbook activation integration
Pipeline Context Snapshot
Context Preview
相关 unit / integration / property / Android QA
docs/optimization
```

## 3.2 原则上禁止修改

```text
Story Memory Protocol V2 Observation / Compiler / Merger
Story Memory physical request protocol
Continuation V4/V5 allocator
Canon
LLM provider transport
DeepSeek Prompt Cache 业务逻辑
Review / FactCheck / Brief / Final 的业务协议
输出 token reservation 规则
自动重试次数
Batch physical request budget
数据库中已有用户内容
```

如 Agent 发现确实必须修改上述区域，必须先用真实调用链证明：

```text
A 接口
→ B 接口
→ 当前 bug
```

并只做最小接驳修复，不允许顺手重构。

---

# 4. 开工前必须完成的调用链审计

必须先运行类似：

```bash
rg -n "contextBudgetVersion|CURRENT_CONTEXT_BUDGET_VERSION|V3_HIERARCHICAL_CONTEXT_BUDGET_VERSION|isV3|includeBrief|createTask|createBatch|replaceLegacyBatch|resume|determineNextPipelineAction" src __tests__

rg -n "applyContextAutoAllocationV3|context_window|max_output_tokens|context_auto_mode|context_auto_policy_v3" src __tests__

rg -n "allocateHierarchicalContextBudget|collectAllResourceCandidates|renderCandidateToText|storyStateDemand|episodicDemand|slidingDemand|MAX_STORY_STATE_BUDGET|MAX_EPISODIC_MEMORY_BUDGET" src __tests__

rg -n "buildWorldbookContext|collectWorldbookCandidates|scanText|provisionalScanText|memoryText|worldbookScanContent" src __tests__

rg -n "contextBudgetV3Summary|policyHash|PipelineContextSnapshot|serializePipelineTaskContext|parsePersistedPipelineTaskContext" src __tests__
```

至少形成下面的真实调用链：

```text
Context Auto Config
  ↓
Mode / Policy persistence
  ↓
Task / Batch version freeze
  ↓
Pipeline execution snapshot
  ↓
compileDraft
  ↓
buildContext
  ↓
V3 hierarchical allocator
  ↓
resource/item rendering
  ↓
final message fit check
  ↓
pipeline snapshot
  ↓
Review / FactCheck / Brief / Final
  ↓
resume / cold-start / batch resume
```

未完成调用链审计前，不允许直接开始改代码。

---

# 5. P0-1：`contextBudgetVersion = 6` 必须完整接入 Pipeline 状态机

## 5.1 当前风险

当前 V3 新任务可能冻结：

```text
outlineWorkflowVersion = 4
contextBudgetVersion   = 6
```

但部分核心代码仍可能使用：

```ts
[3, 4, 5].includes(contextBudgetVersion)
```

判断“是否是当前新流水线”。

这会导致：

```text
V3 Budget Task
→ 被 State Machine 当成旧 Pipeline
→ Brief checkpoint 不创建
→ full/twoStage/conditional 进入旧分支
```

这是本轮最高优先级。

## 5.2 禁止继续散落 magic array

不要把：

```ts
[3,4,5]
```

简单全部替换成：

```ts
[3,4,5,6]
```

后就结束。

应该抽取统一语义函数，例如：

```ts
isCurrentOutlinePipelineContextBudgetVersion(version)
isResumableContextBudgetVersion(version)
shouldIncludeBriefCheckpoint(outlineWorkflowVersion, contextBudgetVersion)
```

或使用本地已经存在的同义 helper。

目标：

> 所有 Task Store、State Machine、Runner、Batch、Reconcile 使用同一版本语义来源。

## 5.3 必查接驳点

至少检查：

```text
pipelineTaskStore
determineNextPipelineAction
pipelineRunner
reconcile
pipelineTaskContext
taskView
projectStageCheckpoints
multiChapterBatchStore
multiChapterBatchRepository
determineNextBatchAction
batch resume / replan
checkpoint stage creation
```

## 5.4 必须测试

### 单章 full

```text
outlineWorkflowVersion=4
contextBudgetVersion=6
pipelineMode=full
```

应走：

```text
draft
→ review
→ factCheck
→ brief
→ proof/final
```

### twoStage

必须走当前 V4 语义，而不是 legacy。

### conditional

必须走当前 V4 语义。

### noReview

保持原语义。

### Resume

任务在：

```text
draft success
review success
factCheck failed
```

中断后 Resume：

- 不重跑 draft；
- 不重跑 review；
- 从失败节点继续；
- version 6 不被拒绝；
- version 6 不被自动转换成 5。

---

# 6. P0-2：V3 自动配置不得再篡改每个模型的真实 Context Window

## 6.1 当前错误语义

V3 自动配置如果执行：

```sql
UPDATE llm_config
SET context_window = ?, max_output_tokens = ?
```

且没有模型级条件，就会把：

```text
32K Model
128K Model
1M Model
```

全部改成同一能力。

这与 V3 的根本目标冲突。

## 6.2 正确职责划分

### LLM Config

保存：

```text
该模型真实 context_window
该模型真实/配置 max_output_tokens
provider
model name
reasoning capability
```

### Context Automation V3

保存：

```text
Mode
Policy
Soft/Burst ratios
Board ratios
Item rules
```

### Request

运行时：

```text
Frozen Request Model
→ context_window
→ reservedOutput
→ safety
→ hierarchical allocation
```

## 6.3 修复要求

`applyContextAutoAllocationV3()`：

必须停止无条件全量：

```sql
UPDATE llm_config SET context_window = ...
```

也不要通过其他函数间接覆盖全部模型。

是否允许更新 `max_output_tokens`：

- 以本地模型配置语义为准；
- 若该字段代表模型真实能力，也不得被 V3 global apply 批量覆盖；
- 若只是用户全局运行配置，必须有明确证据；
- 默认建议两者都不由 V3 全局 apply 修改。

V3 apply 应聚焦：

```text
context_auto_mode
context_auto_policy_v3
必要的 V3 管理元数据
```

## 6.4 测试

准备：

```text
Model A = 32768
Model B = 131072
Model C = 1048576
```

应用 V3 后：

```text
A = 32768
B = 131072
C = 1048576
```

全部保持。

分别冻结请求后：

```text
A 的 board soft target < B < C
```

---

# 7. P0-3：四大 Board 都必须使用真实 Demand

当前 Resources 已经是：

```text
full content
→ actualTokens
→ allocator
```

本轮必须让：

```text
Story State
Resources
Sliding
Episodic
```

全部具备相同 demand semantics。

---

# 8. Story State Demand Collector

V3 自动模式下禁止：

```ts
actualDemand =
  min(MAX_STORY_STATE_BUDGET,
      config.storyStateBudgetTokens)
```

把配置上限当实际需求。

正确流程建议：

```text
Prepared Story Memory Snapshot
→ render/estimate without destructive clipping
→ actualTokens
→ Board Allocator
→ final render with granted budget
```

必须保证：

```text
Story Memory missing / dirty / unusable / empty
→ actualDemand = 0
```

这里只改变 Context consumption demand，不得修改 Story Memory Protocol V2 的 Observation / Checkpoint / Compiler / Merger / Maintenance / Attempt Ledger。

---

# 9. Sliding / Recent Bridge Demand Collector

继续保留：

> 最近 raw 最多 10 章。

禁止因模型 1M 又恢复 20、50、100 章原文注入。

候选 raw bridge 选完以后：

```text
selected raw chapters
→ exact text
→ estimate actual tokens
→ board actualDemand
```

不要再：

```text
min(config.slidingWindowSize, actual)
```

把旧 V2 静态值当硬上限。

V3 的最终 grant 才是裁剪依据。

---

# 10. Episodic Demand Collector

若仍把：

```text
MAX_EPISODIC_MEMORY_BUDGET
config.episodicMemoryBudgetTokens
```

作为 actualDemand，空候选或少量候选也会虚占预算。

正确流程：

```text
Episodic retrieval
→ candidate list
→ relevance order
→ estimate actual candidate total
→ Board allocator
→ select/render to exact Board grant
```

若当前 retrieval 架构要求先给 budget 才能选 TopK，优先拆成：

```text
retrieve candidates
→ estimate full demand
→ allocate
→ final selectWithinBudget
```

---

# 11. Board 层必须真正支持 Reclaim

示例：

```text
Story State Soft = 16K, actual = 0
Episodic Soft    = 12K, actual = 2K
Sliding Soft     = 20K, actual = 5K
Resources actual = 60K
```

则：

```text
Story State 释放 16K
Episodic 释放 10K
Sliding 释放 15K
```

Resources 在 ceiling 和全局窗口允许时应继续借入。

必须有测试证明：

```text
resources.allocatedTokens >
resources.softTargetTokens
```

且 borrowed trace 数字正确。

---

# 12. P0-4：Resource Item 最终裁剪必须与 Token Estimator 同构

禁止继续使用：

```text
grant / actualTokens
→ 字符串长度比例
→ slice()
```

项目已有 token-budget-safe 裁剪能力时优先复用。

如果 Resource 需要 tail-biased，应复用或完善：

```text
clipTextTailToTokenBudget()
```

硬约束：

```text
estimateTokens(renderedText) <= grantedTokens
```

Property Test 至少覆盖：

```text
纯中文
纯英文
中英混合
标点密集
数字
emoji
换行
长 ASCII run
```

并断言：

```text
renderedTokens <= grant
grant >= actual → full original bytes
grant <= 0 → empty
same input → same output
```

建议随机 ≥10,000 case。

---

# 13. P1：Worldbook 激活必须恢复完整扫描语义

V3 若在 `memoryText` 尚未构建时仅使用 provisional scan 激活 Worldbook，会丢失由 Episodic / 历史事件关键词触发世界书的能力。

不能制造：

```text
Worldbook → Episodic → Worldbook
```

循环依赖。

建议两阶段：

### Phase A

构建与 Worldbook 无关的上下文候选：

```text
title
synopsis
current content
user prompt
recent bridge
episodic relevant text
```

### Phase B

形成最终 Worldbook scan haystack，再进行：

```text
constant
primary
primary+secondary
recursive
fallback
```

要求 V3 至少保持 V2 的触发能力。

---

# 14. P1：ContextAutomationPolicyV3 必须真正 Freeze

V3 Policy 不能只是 settings 里存一份，运行时却一直使用 default。

新 Task / Batch 创建时必须冻结：

```text
contextBudgetVersion = 6
policyVersion
policyHash
必要时 policy snapshot
```

首次 Draft 使用冻结 Policy。

Preview：

- 预览下一次新任务：使用当前设置 Policy；
- 查看已存在任务：使用任务冻结 Policy。

Resume：

```text
Task A freeze Policy P1
用户后来把设置改为 P2
Task A resume
```

必须继续 P1。

---

# 15. Pipeline Snapshot 接驳

必须验证：

```text
Draft 看到的资料
=
Frozen PipelineContext 中保存的资料
```

Review / FactCheck / Brief / Final：

- 不重新读取 Character；
- 不重新读取 Note；
- 不重新读取 Worldbook；
- 不重新按新 Policy 分配；
- 不因用户中途修改 Context 设置而漂移。

允许后续 Stage 针对 frozen text 按自身预算再次裁剪，但 source material 必须来自同一个 Frozen Snapshot。

---

# 16. Preview 必须等于真实 Draft

必须比较：

```text
Preview Compile
vs
Actual Draft Compile
```

在同一：

```text
Model
Context Config
V3 Policy
Project
Chapter
```

条件下：

```text
messages / relevant resource bytes
allocation trace
board trace
policyHash
```

一致。

允许差异仅限：

```text
createdAt
taskId
非 prompt 业务元数据
```

---

# 17. Context Preview 展示要求

Board 层显示：

```text
需求
Soft Target
Elastic Ceiling
实际分配
回收
借调
状态
```

Item 层显示：

```text
实际需求
实际分配
是否完整
来源
激活原因
裁剪原因
```

用户最初问题场景中，如果两个 Character 的真实需求分别约 7K 和 12K，空间足够时应显示完整载入，而不是把旧约 2~3K 固定 cap 换成另一组固定数值。

---

# 18. 多模型切换测试

至少模拟：

```text
32K
64K
128K
1M
```

相同项目、相同资料。

应满足：

```text
模型窗口越大
→ Soft Pool 越大
→ Board Soft Target 越大
→ 可借调空间越大
→ 裁剪不应反而增加
```

实际需求完全满足后 allocated 不必继续增长。

---

# 19. Multi-Chapter Batch

Batch 创建必须读取当前 `context_auto_mode`。

若为 V3：

```text
parent batch contextBudgetVersion = 6
child task = 6
policy hash/snapshot 一致
```

Resume / replan 仍保持 6。

禁止：

```text
parent 6 / child 5
first child 6 / next child 5
```

---

# 20. Version Compatibility

历史任务不得被迁移到 6。

当前 V2 version 5 行为不得回归。

V3 version 6 必须能 Resume。

旧任务具体允许 Resume 的范围以本地当前产品策略为准，但新增 6 不能改变 5 的既有行为。

---

# 21. Final Window Hard Guard

最终消息 assemble 后必须重新 estimate，并满足：

```text
estimatedInput
+ reservedOutput
+ safety
<= contextWindow
```

若超限：

1. 优先收缩 optional；
2. 必要时收缩 preferred；
3. Mandatory 不裁；
4. 仍不满足则 Block；
5. 不得把超窗口请求送给 provider。

---

# 22. 不增加 LLM 请求

Context Budget V3 是纯本地调度。

本轮修复后：

```text
预算计算
demand collection
preview
policy freeze
```

都不得增加 LLM 请求。

必须有 call-count / attempt-count 回归证据。

---

# 23. 自动化测试要求

至少覆盖：

## A. Version Integration

```text
A1 version6 creates Brief checkpoint
A2 full uses current V4 pipeline
A3 twoStage current path
A4 conditional current path
A5 noReview unchanged
A6 version5 unchanged
A7 version6 resume
A8 version6 batch
```

## B. LLM Model Capability

```text
B1 V3 apply doesn't overwrite context_window
B2 32K/128K/1M configs remain distinct
B3 request uses frozen model window
```

## C. Board Demand

```text
C1 empty Story State demand=0
C2 small Story State actual demand
C3 empty Episodic demand=0
C4 small Episodic actual demand
C5 Sliding demand = selected raw content
C6 Resources true demand
C7 cross-board reclaim
```

## D. Resource Item

```text
D1 two large characters full-fit
D2 non-equal split
D3 explicit > fallback
D4 Worldbook relevance
D5 renderedTokens <= grant
D6 mixed-language property
```

## E. Policy Freeze

```text
E1 new task freezes V3 policy
E2 live policy change doesn't affect resume
E3 batch children inherit same policy
E4 preview/new-run uses current policy
E5 existing task preview uses frozen policy
```

## F. Preview

```text
F1 Preview = Draft allocation
F2 Preview = Draft resource bytes
F3 board trace accurate
F4 item trace accurate
```

## G. Window

```text
G1 32K
G2 64K
G3 128K
G4 1M
G5 near-hard-limit
G6 mandatory overflow
```

---

# 24. Property Test

建议至少 10,000 组随机输入：

```text
contextWindow: 8K ~ 1M
reservedOutput: 512 ~ 200K
mandatory: 0 ~ window
4 board demand: 0 ~ 500K
resource items: 0 ~ 100
mixed content
```

不变量：

```text
allocation >= 0
allocation <= actual demand
item total <= resources grant
board total + mandatory <= allocator capacity
renderedTokens <= item grant
empty demand consumes 0
unused budget reclaimable
same input deterministic
no NaN
no Infinity
no negative
```

---

# 25. Android 模拟器测试要求

必须在 Agent 当前开发机已经存在的 Android 模拟器上实测。

先：

```bash
adb devices -l
```

选择在线 emulator。

记录：

```bash
adb -s <serial> shell getprop ro.build.version.release
adb -s <serial> shell getprop ro.build.version.sdk
adb -s <serial> shell dumpsys package <actual-package-name>
```

安装必须使用：

```bash
adb -s <serial> install -r <debug-apk>
```

禁止：

```text
adb uninstall
pm clear
删除 app data
清空数据库
```

必须保护用户现有：

```text
API Key
Projects
Chapters
Characters
Notes
Worldbook
Story Memory
Pipeline tasks
Attempt ledger
```

---

# 26. Android M1：用户原始问题复现

创建或复用一个测试项目：

```text
两个已启用大 Character
```

目标复现旧问题：

```text
每个 Character 固定约 2~3K
导致被裁剪
```

然后 V3 + 大模型，在两份资料总需求可承受时必须：

```text
两份资料均完整
allocated = demand
clipped = false
```

保留：

```text
Context Preview 截图
UI tree / log
相关 trace
```

---

# 27. Android M2：跨 Board 借调

构造：

```text
Story State 很小/为空
Episodic 很小
Sliding 很小
Resources 很大
```

Preview 必须显示：

```text
Resources allocated > soft target
borrowed > 0
```

---

# 28. Android M3：真实小窗口裁剪

切换真实配置的 32K / 64K 模型。

同样资料必须：

```text
不会 overflow
会有可解释裁剪
Preview 数字与真实发送一致
```

---

# 29. Android M4：1M 模型动态扩张

切换真实 1M context 模型。

不得重新“应用一个 1M 固定配置”才能生效。

仅切换模型后：

```text
Task freeze 当前模型 window
→ V3 board target 自动增大
→ 裁剪减少
```

---

# 30. Android M5：真实 Full Pipeline

必须真实运行至少一章：

```text
Draft
→ Review
→ FactCheck
→ Brief
→ Final/Proof
```

确认：

```text
contextBudgetVersion = 6
Brief checkpoint 存在
State Machine 使用当前分支
最终完成
```

---

# 31. Android M6：Resume / Background

真实操作：

```text
开始任务
→ Home / 切后台
→ 回前台
```

并至少一次：

```text
中间阶段可控中断/失败
→ Resume
```

确认：

```text
version=6
冻结 Policy 不变
已成功 Stage 不重复请求
Frozen Context 不重建漂移
```

---

# 32. Android M7：Batch Smoke

若本机测试数据允许，创建至少 2 章批次。

确认：

```text
parent=6
child=6
Brief stage 正常
batch resume 正常
```

---

# 33. 性能验证

Candidate-first / real-demand 不得引入明显性能退化。

至少测：

```text
10 resources
50 resources
100 resources
500 resources
```

要求：

- 无明显 N+1 DB；
- 同一内容只 tokenize 一次或有缓存；
- Preview 不卡死；
- allocator 本身近似线性或可接受；
- 不进行 O(N²) 大字符串重复拼接。

---

# 34. 数据安全

测试前后记录：

```text
project count
chapter count
character count
note count
worldbook count
pipeline task count
```

Android 覆盖安装后应保持不变，除测试主动创建的数据。

---

# 35. 完整验证命令

以本地 `package.json` 为准，典型：

```bash
npm run typecheck
npm run lint
npm run verify
```

不得只跑新增 test 文件后宣称 GO。

---

# 36. 版本策略

本轮开始时：

```text
不要先升版本
不要先改 CHANGELOG
不要先生成 release APK
```

只有所有验收 Gate 全通过后，才允许按项目当前版本策略升版、更新 CHANGELOG、生成 Release APK。

具体下一个版本号以实施时本地仓当前版本为准，不写死。

---

# 37. 最终验证报告

完成后必须生成：

```text
docs/optimization/
Context-Budget-V3-Final-Pipeline-Closure-Verification-YYYYMMDD.md
```

必须包含：

```text
初始 local HEAD
初始 origin/main
最终 HEAD
修改文件清单
P0/P1 每项根因
修复方式
测试文件
typecheck
lint
full verify
Android serial
Android API
Debug APK
install -r
数据保留
M1~M7
GO / NO-GO
仍知晓的非阻塞问题
```

禁止只写：

```text
tests pass
GO
```

---

# 38. 最终验收标准（Agent 必须逐项核对）

> **本节是本方案最终交付标准。任何一项未满足，都不得宣称完成。**

## Gate 01 — Repo Preflight

- [ ] Agent 自行定位实际 repo root；
- [ ] 已执行 `git status`；
- [ ] 已 fetch 远端；
- [ ] 已记录 local HEAD / origin/main；
- [ ] 未覆盖任何本地未提交内容。

## Gate 02 — Version 6 Pipeline

- [ ] `contextBudgetVersion=6` 被当前 Outline Pipeline State Machine 正确识别；
- [ ] full/twoStage/conditional/noReview 均走正确业务分支；
- [ ] version 6 创建正确 stage checkpoints；
- [ ] Brief 不再因 version 6 被遗漏。

## Gate 03 — Resume

- [ ] version 5 历史/当前任务行为不回归；
- [ ] version 6 可 Resume；
- [ ] Resume 不自动把 6 改成 5；
- [ ] 已成功 Stage 不重复执行。

## Gate 04 — Batch

- [ ] V3 batch parent freeze 6；
- [ ] V3 child freeze 6；
- [ ] 一个 Batch 内不混用 5/6；
- [ ] Batch Resume / Replan 保持 6。

## Gate 05 — Model Context Window

- [ ] V3 apply 不再全量覆盖 `llm_config.context_window`；
- [ ] 32K / 128K / 1M 模型仍保持各自真实值；
- [ ] 每次 Request 使用冻结模型自己的 window。

## Gate 06 — V3 Policy Freeze

- [ ] 持久化 Policy 被真实读取；
- [ ] 新 Task 冻结 Policy/hash；
- [ ] 新 Batch 冻结同一 Policy/hash；
- [ ] Resume 不重新读取 live Policy 导致漂移。

## Gate 07 — Story State Demand

- [ ] Story State `actualDemand` 来自真实可注入内容；
- [ ] missing/empty 不虚占预算；
- [ ] 未修改 Story Memory Protocol V2 核心业务。

## Gate 08 — Sliding Demand

- [ ] 最近 raw 仍最多 10 章；
- [ ] V3 不再把旧 `slidingWindowSize` 当 actual Hard Cap；
- [ ] demand 来自真实选中 bridge 内容。

## Gate 09 — Episodic Demand

- [ ] Episodic demand 来自真实 retrieval candidates；
- [ ] 空 retrieval 不虚占预算；
- [ ] 小 retrieval 只占真实需求。

## Gate 10 — Resources Demand

- [ ] Candidate-first 保留；
- [ ] 不回退 35/20/45；
- [ ] 不按资源数量平均；
- [ ] 不使用 legacy row `max_tokens` 作为 Auto V3 Hard Cap。

## Gate 11 — Cross-board Borrow

- [ ] 空板块预算可回收；
- [ ] Resources 可跨板块借调；
- [ ] Borrow 受 ceiling / Burst / Hard 约束；
- [ ] 测试明确证明 `allocated > softTarget`。

## Gate 12 — Resource Item Clip

- [ ] 不再按字符长度比例裁剪；
- [ ] `estimateTokens(rendered) <= grant`；
- [ ] mixed-language property test PASS；
- [ ] grant >= demand 时原文 byte-identical。

## Gate 13 — Worldbook Activation

- [ ] V3 保留 constant；
- [ ] primary；
- [ ] primary+secondary；
- [ ] recursive；
- [ ] fallback；
- [ ] Episodic / 历史关键词触发能力不低于旧路径。

## Gate 14 — Preview = Send

- [ ] Preview 与真实 Draft 使用同一 Policy；
- [ ] 同一 Model；
- [ ] 同一 allocator；
- [ ] 同一 Candidate；
- [ ] 同一 Resource bytes；
- [ ] 同一 Board/Item trace。

## Gate 15 — Final Window

- [ ] 32K PASS；
- [ ] 64K PASS；
- [ ] 128K PASS；
- [ ] 1M PASS；
- [ ] near-hard-limit PASS；
- [ ] mandatory overflow 正确阻断；
- [ ] 不发送超窗口请求。

## Gate 16 — LLM Request Count

- [ ] V3 budget/demand/preview 没有新增 LLM 请求；
- [ ] Pipeline 物理请求数量无预算系统额外增量。

## Gate 17 — Determinism

- [ ] 同输入 allocation 一致；
- [ ] 同输入 rendered resource bytes 一致；
- [ ] Policy hash 一致；
- [ ] 无随机排序 / 时间戳参与 prompt bytes。

## Gate 18 — Automated Tests

- [ ] 新增 targeted tests 全 PASS；
- [ ] property tests PASS；
- [ ] typecheck PASS；
- [ ] lint 无新增 error；
- [ ] full `npm run verify` PASS。

## Gate 19 — Android M1

- [ ] 真正复现两个大 Character 原问题；
- [ ] 大模型空间足够时两份均完整；
- [ ] 不再固定约 2~3K；
- [ ] 已截图/日志留证。

## Gate 20 — Android M2/M3/M4

- [ ] Cross-board borrow 实机 PASS；
- [ ] 小窗口可解释裁剪 PASS；
- [ ] 1M 模型无需重写资源配置即可自动扩张 PASS。

## Gate 21 — Android Full Pipeline

- [ ] 实机 full pipeline 从 Draft 跑到 Final；
- [ ] version=6；
- [ ] Brief 存在；
- [ ] 最终成功；
- [ ] 无旧分支误路由。

## Gate 22 — Android Resume

- [ ] Home/App switch smoke PASS；
- [ ] 中断/失败 Resume PASS；
- [ ] 已成功 Stage 不重复；
- [ ] Policy/Context 不漂移。

## Gate 23 — Android Batch

- [ ] 至少 2 章 batch smoke PASS；
- [ ] parent/child version 一致；
- [ ] batch resume PASS。

## Gate 24 — Data Preservation

- [ ] APK 使用 `adb install -r`；
- [ ] 无 uninstall；
- [ ] 无 pm clear；
- [ ] 用户数据保持；
- [ ] API Key 保持；
- [ ] 项目/章节/Story Memory/Attempt Ledger 保持。

## Gate 25 — Scope

- [ ] 未重构 Story Memory Protocol V2；
- [ ] 未修改 Continuation 业务架构；
- [ ] 未修改 Canon；
- [ ] 未增加自动重试次数；
- [ ] 未增加 budget LLM 请求；
- [ ] 未进行无关代码清理。

## Gate 26 — Final Report

- [ ] 最终 Verification MD 已生成；
- [ ] 每个 Gate 有证据；
- [ ] 未通过项明确写 NO-GO；
- [ ] 所有 Gate PASS 后才允许 GO。

---

# 39. 最终 NO-GO 条件

出现任一项立即 NO-GO：

```text
version=6 仍走旧 Pipeline 分支
Brief checkpoint 对 version=6 缺失
V3 apply 仍覆盖所有模型 context_window
Story/Episodic/Sliding 仍把旧静态 cap 当 actual demand
空板块仍占预算
Resources 仍有 35/20/45 Hard Split
Item grant 与真实 rendered tokens 不一致
Preview 与实际 Draft 不一致
Resume 重新读取 live policy 导致漂移
Batch parent/child contextBudgetVersion 不一致
32K/64K/128K/1M 任一可能超窗口
Worldbook V3 触发能力明显退化
为了预算优化新增 LLM 请求
full verify fail
Android 没有真正跑用户原始问题场景
Android full pipeline 没有实跑
Android Resume 没有实跑
需要 uninstall / pm clear 才能测试通过
```

---

# 40. 最终 GO 定义

只有同时满足：

```text
代码 Gate PASS
自动化 Gate PASS
版本 Freeze PASS
Preview=Send PASS
真实模型能力 PASS
Android 用户原问题 PASS
Android full pipeline PASS
Android Resume PASS
Android Batch smoke PASS
数据保留 PASS
完整 verify PASS
最终报告齐全
```

才可：

> **GO：Context Budget V3 完成最终封板，可进入版本发布流程。**

否则：

> **NO-GO：继续修复具体失败 Gate，不得用“主体完成”“Conditional GO”“测试基本通过”代替最终验收。**

---

# 41. Agent 执行要求摘要

Agent 应自主完成：

```text
定位本地仓
→ preflight
→ 调用链审计
→ 补失败测试
→ 最小修复
→ targeted tests
→ property tests
→ full verify
→ Android M1~M7
→ 数据保留校验
→ 最终 Verification MD
→ 最终 GO/NO-GO
```

不得中途以“需要人工确认下一步”为由停住，除非：

```text
发现本地未提交修改存在真实覆盖风险
需要不可逆数据库操作
需要用户提供缺失 API Key / 账号凭据
```

除此之外按本方案自主推进至最终验收。
