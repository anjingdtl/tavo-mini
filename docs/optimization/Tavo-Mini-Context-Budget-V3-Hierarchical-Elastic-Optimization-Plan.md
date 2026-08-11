# Tavo-Mini 上下文自动化配置 V3：分层弹性预算优化改造方案

> 项目：`anjingdtl/tavo-mini`  
> 本地实施仓：`F:\ClaudeWorkSpace\projects\TAVO-MINI`  
> 远端审计基线：`7dc4fb6746fb42b8f0787278e862aecce0cacd4b`  
> 当前应用版本：`V2.11.49 / versionCode=2114900`  
> 当前数据库：Schema 51  
> 方案定位：**Context Budget V3 / Hierarchical Elastic Context Budget**  
> 日期：2026-08-12

## 0. 目标

将当前“固定比例 + 固定单资源上限”的上下文配置升级为三级弹性体系：

```text
模型真实输入容量
  ↓
板块级 Soft Target + Global Borrow Pool
  ↓
板块内部 Item Demand Allocation
  ↓
最终消息重估 / Optional Shrink / Hard Guard
```

核心原则：

> **比例定基线、真实需求定实际、空闲可回收、板块可借调、用户选择优先、总窗口兜底。**

本轮不是把 `resourceBudget=6000` 改成 10000，也不是把 Character/Note/Worldbook 的固定比例换成另一组数字，而是取消“固定额度本身作为 Hard Cap”的设计。

---

# 1. 远端当前真实问题

## 1.1 自动配置顶层仍是固定比例

当前 `ContextAutomationPolicyV2 / allocateContextBudget()`：

```text
模型 Context
├─ Input 80%
└─ Output 20%

Input 内：
├─ Sliding Window 45%
├─ Resources      20%
├─ Story State    25%
└─ Episodic       10%
```

这些比例被换算成绝对 token 后写入 ContextConfig。

此外当前还有：

```text
MAX_STORY_STATE_BUDGET      = 32000
MAX_EPISODIC_MEMORY_BUDGET = 16000
```

因此 128K → 1M 模型增长后，部分板块仍会被旧绝对值封顶。

## 1.2 Resources 内部又固定拆分

`contextAutoAllocator.ts` 与 `contextBuilder.ts` 当前都保留：

```text
Character = Resources × 35%
Note      = Resources × 20%
Worldbook = Resources × 45%
```

这意味着 Resources 即使拿到更多预算，三类资料仍不是按真实需求竞争。

## 1.3 单资源额度按“数量平均”

当前自动配置：

```text
characterMaxTokens =
  characterTotal / max(characterCount,1)

noteMaxTokens =
  noteTotal / max(noteCount,1)

worldbookEntryMaxTokens =
  worldbookTotal / max(worldbookEntryCount,1)
```

而不是按：

```text
资源实际 tokens
是否用户显式启用
当前章节相关度
当前模型剩余容量
```

决定。

## 1.4 资源数量甚至来自全数据库所有项目

当前 `countAllResources()`：

```sql
SELECT COUNT(*) FROM characters
SELECT COUNT(*) FROM notes
SELECT COUNT(*) FROM worldbook_entries
SELECT COUNT(*) FROM worldbook_collections
```

没有 `WHERE project_id = ?`。

结果是：

> 项目 B/C/D 的资源数量会降低当前项目 A 的单资源额度。

这属于 P0 级错误依赖。

## 1.5 自动配置会批量改写所有资源 max_tokens

当前 `applyContextAutoAllocation()` 会：

```sql
UPDATE characters SET max_tokens = ?
UPDATE notes SET max_tokens = ?
UPDATE worldbook_entries SET max_tokens = ?
UPDATE worldbook_collections SET max_tokens = ?
```

一次自动配置会把某个模型对应的估算结果固化成全数据库资源的长期静态硬上限。

## 1.6 运行期 Elastic V2 也借不出静态 resourceBudget

当前 `contextBuilder.ts` 把 Resources 注册成：

```ts
{
  id: 'resources',
  availableTokens: config.resourceBudget,
  targetTokens: config.resourceBudget,
  maxTokens: config.resourceBudget,
}
```

因此虽然外层已经有 80% Soft / 95% Burst：

```text
Resources 仍然最多只能拿到 config.resourceBudget
```

剩余几十万 token 也无法借给它。

## 1.7 Resource Builder 还会再次预裁剪

当前链路：

```text
Global Resources Budget
  ↓
35 / 20 / 45
  ↓
character/note/worldbook max_tokens
  ↓
remaining 顺序消费
  ↓
clipTextToTokenBudget
```

因此真正的全局 Elastic Allocator 看不到完整资源的 actual demand。

---

# 2. V3 总体架构

```text
Model Capability
  │
  ├─ context_window
  ├─ reserved output
  └─ safety margin
  │
  ▼
Mandatory Collector
  ├─ System / Preset
  ├─ Outline
  ├─ Current Instruction
  └─ Protocol Scaffold
  │
  ▼
Soft / Burst / Hard Envelope
  │
  ▼
Board Demand Collector
  ├─ Story State
  ├─ Resources
  ├─ Sliding / Recent Bridge
  └─ Episodic
  │
  ▼
Board Allocator
  ├─ Soft Target
  ├─ Reclaim
  └─ Cross-board Borrow
  │
  ├──────── Resources Grant
  │              │
  │              ▼
  │      Resource Candidate Collector
  │              │
  │              ▼
  │        Item Allocator
  │              │
  │              ▼
  │      Final Resource Bodies
  │
  ▼
Final Context Assembly
  │
  ▼
Re-estimate
  ├─ <= Soft   Normal
  ├─ <= Burst  Elevated
  ├─ <= Hard   Optional shrink / final guard
  └─ > Hard    Block
```


# 3. Level 0：模型真实容量

保留现有水位思想：

```text
W = context_window
O = reserved output tokens
S = safety margin

H = W - O - S

SoftLine  = floor(H × 0.80)
BurstLine = floor(H × 0.95)
HardLine  = H
```

但 V3 要改进 Mandatory 计算。

当前 `contextBuilder` 的 Elastic Planning 使用近似：

```text
fixedProtocol = 256
```

V3 应尽量在分配前获得真实：

```text
System / Preset
Outline
Current Chapter Instruction
Protocol Scaffold
```

计算：

```text
M = Mandatory Actual Tokens
```

再得到：

```text
SoftElasticPool  = max(0, SoftLine - M)
BurstElasticPool = max(0, BurstLine - max(SoftLine, M))
HardRemaining    = max(0, HardLine - M)
```

这样减少“Allocator 认为能放，最终 assemble 才发现超限”的二次误差。

---

# 4. Level 1：板块级比例 Soft Target

建议 Balanced V3 默认：

| 板块 | Soft Target | Elastic Ceiling | 优先级 |
|---|---:|---:|---:|
| Story State / Story Memory | 20% | 30% | 高 |
| Resources | 30% | 50% | 高 |
| Sliding / Recent Bridge | 25% | 40% | 中高 |
| Episodic | 15% | 30% | 中 |
| Global Reserve | 10% | — | 公共借调池 |

这里的比例针对：

```text
SoftElasticPool
```

而不是直接针对整个 `context_window`。

关键语义：

```text
Soft Target ≠ Hard Cap
```

例如 Resources：

```text
actual demand    = 42K
soft target      = 21K
elastic ceiling = 35K
```

其他板块空闲时：

```text
Resources 可由 21K 借到 35K
```

如果 total 仍安全，不能在 21K 处裁掉。

每个 Board 应形成：

```ts
interface ContextBoardDemand {
  id: string;
  availableTokens: number;      // 真实总需求
  minTokens: number;
  softTargetTokens: number;
  elasticMaxTokens: number;
  priority: number;
  relevance: number;
  requirement: 'preferred' | 'optional';
}
```

运行时：

```text
available = 实际内容
target    = Soft Target
max       = Elastic Ceiling
```

禁止再出现：

```text
available = target = max = static config value
```

---

# 5. Global Borrow Pool

顶层规则：

1. Mandatory 全量保护。
2. 每个 Board 先满足真实需求中的基础份额。
3. Board 实际需求小于 Soft Target 时，未用预算立即回收。
4. 回收预算进入 Global Elastic Pool。
5. 有缺口的 Board 按：
   - requirement
   - priority
   - relevance
   - unmet demand
   继续借调。
6. 高价值 Board 可进入现有 Burst 区。
7. 最终任何组合不得超过 Hard。

例：

```text
Story State Soft 14K，实际只要 3K → 回收 11K
Episodic Soft 10K，实际只要 2K → 回收 8K
Resources Soft 21K，实际要 40K
```

则 Resources 可以吃掉回收的 19K，达到 40K full，而不是固定停在 21K。

---

# 6. Level 2：Resources 内部 Item Elastic

## 6.1 Candidate-first

V3 必须将：

```text
读取 → clip → allocator
```

改成：

```text
读取完整内容
→ 构建 Candidate
→ estimate actualTokens
→ Item Allocator
→ 最后 clip/render
```

建议新增：

```text
src/services/context/resourceContextCandidates.ts
```

统一结构：

```ts
interface ResourceContextCandidate {
  id: string;
  sourceKind: 'character' | 'note' | 'worldbook';
  sourceId: number | null;
  title: string;
  content: string;

  actualTokens: number;

  explicitSelected: boolean;
  activated: boolean;
  activationReason?: string;

  priority: number;
  relevance: number;
  requirement: 'preferred' | 'optional';

  sourceOrder: number;

  // 仅 Legacy / Manual 使用
  legacyMaxTokens?: number;
}
```

## 6.2 Character

当前：

```text
buildCharacterContext(projectId, characterBudget)
```

改为 V3：

```text
collectCharacterCandidates(projectId)
```

只做：

```text
读取完整 Character Card
格式化
estimateTokens
记录启用/显式选择状态
```

不做 `remaining` 和 `max_tokens` 裁剪。

## 6.3 Note

按模式生成 Candidate：

```text
Full/Original:
  每份已启用 Note = 一个 Candidate

Retrieval:
  每个命中 Fragment = 一个 Candidate
  relevance = retrieval score

Style:
  合并后的 Style Profile = 一个 Candidate
```

不要先把整段 Note Text 按固定 `noteBudget` 裁掉。

## 6.4 Worldbook

保留现有激活逻辑：

```text
constant
主关键词命中
主+次关键词命中
递归命中
项目启用兜底
```

但激活后不再立即：

```text
entry.max_tokens → clip
```

而是形成 Candidate。

建议 relevance：

```text
主+次命中   1.00
constant     0.95
主关键词     0.90
递归命中     0.75
项目兜底     0.45
```

具体值集中写入 V3 Policy，不散落 magic number。

---

# 7. Item-level 分配原则

每个 Item：

```text
availableTokens = actualTokens
maxTokens       = actualTokens
```

内容本身就是天然 Hard Max。

不再：

```text
板块总额 / 资源数量
```

作为 max。

推荐内部流程：

```text
1. requirement floor
2. 小需求 full-fit
3. priority × relevance × selectionBoost water filling
4. reclaim
5. redistribute
```

例如：

```text
A = 700
B = 1500
C = 12000
Board Grant = 8000
```

不要：

```text
2666 / 2666 / 2666
```

更合理：

```text
A = 700 full
B = 1500 full
C = 剩余额度
```

在价值相近时优先消灭小缺口，提高“完整资料数”。

用户显式选择建议：

```text
selectionBoost = 1.5 ~ 2.0
```

但不要直接变成 Mandatory，防止一份 500K 资料挤掉系统约束。

---

# 8. 复用现有 Elastic Core

不能简单：

```text
Global allocateElasticStageContextBudget()
  ↓
Resources 再调用一次 allocateElasticStageContextBudget()
```

否则 Resources 内部会再次套：

```text
80% / 95%
```

形成二次缩水。

推荐从：

```text
src/services/pipeline/elasticBudgetAllocator.ts
```

抽取共享纯核心：

```ts
allocateDemandsWithinCapacity({
  capacity,
  demands,
  ...
})
```

该 core 只处理：

```text
min
target
priority/relevance
reclaim
redistribute
deterministic tie-break
```

然后：

```text
Top-level =
  water-level envelope
  + shared demand core

Item-level =
  exact board grant
  + shared demand core
```

仍然是一套预算算法，不新建并行体系。

---

# 9. ContextAutomationPolicy V3

新增，不覆盖 V2：

```ts
interface ContextAutomationPolicyV3 {
  schemaVersion: 3;
  allocatorVersion: 'context-automation-v3';
  profile: 'balanced';

  waterLevels: {
    softRatio: 0.80;
    burstRatio: 0.95;
  };

  boards: {
    storyState: {
      softRatio: 0.20;
      elasticCeilingRatio: 0.30;
      priority: 8;
    };
    resources: {
      softRatio: 0.30;
      elasticCeilingRatio: 0.50;
      priority: 9;
    };
    slidingWindow: {
      softRatio: 0.25;
      elasticCeilingRatio: 0.40;
      priority: 8;
    };
    episodic: {
      softRatio: 0.15;
      elasticCeilingRatio: 0.30;
      priority: 6;
    };
  };

  globalReserveRatio: 0.10;

  resourceItems: {
    explicitSelectionBoost: number;
    smallDemandFullFitBias: number;
    activationWeights: Record<string, number>;
  };
}
```

V2 继续原样保留。

---

# 10. 自动配置语义重构

当前自动配置把：

```text
某一次 maxContextTokens
```

计算出来的结果写成：

```text
sliding_window_size
resource_budget
story_state_budget
episodic_budget
resource max_tokens
```

V3 自动模式应改为：

> **持久化 Policy，而不是持久化某次模型的动态运行结果。**

建议只持久化：

```text
context_auto_mode = v3
context_auto_policy_v3 = {...}
profile = balanced
```

真正请求时按：

```text
该任务冻结模型的 context_window
reserved output
当前章节
当前项目真实资源需求
```

实时分配。

这样：

```text
Model A 32K
Model B 128K
Model C 1M
```

不再共享同一个 `resourceBudget=6000`。

---

# 11. 停止 Auto V3 批量 UPDATE 资源 max_tokens

V3 自动模式必须停止：

```sql
UPDATE characters SET max_tokens = ?
UPDATE notes SET max_tokens = ?
UPDATE worldbook_entries SET max_tokens = ?
UPDATE worldbook_collections SET max_tokens = ?
```

旧值不删除、不迁移。

用途继续保留给：

```text
V1/V2 Legacy
Manual Mode
旧任务恢复
```

这样不需要猜测“这个 max_tokens 是用户手工改的还是旧自动配置写的”。

语义明确分开：

```text
Manual:
  尊重 resourceBudget / row max_tokens

Auto V3:
  真实 Demand + Model-relative Policy
  不以旧绝对值作为自动 Hard Cap
```

---

# 12. Context Budget Version Freeze

当前仓库已有：

```text
context_budget_version
```

继续直接使用：

```text
V1 = Legacy fixed
V2 = current elastic single-level
V3 = hierarchical board/item elastic
```

新任务、新批次：

```text
context_budget_version = 3
```

旧任务：

```text
1 永远 V1
2 永远 V2
```

禁止升级 App 后把旧任务 Resume 自动切 V3。

Multi-Chapter Batch 必须父批次一次冻结 V3，全部 Child 继承，单批次禁止混用版本。

---

# 13. Pipeline Snapshot

继续保持现有正确原则：

```text
Draft build once
→ Review / FactCheck / Proof 消费 frozen snapshot
→ 不重新读 DB
```

建议将：

```text
PIPELINE_CONTEXT_SNAPSHOT_VERSION
```

升级到 4（如果本地实际需要新增元数据），加入：

```ts
contextBudgetVersion: 3
contextBudgetPolicyHash: string
```

可选保存精简摘要：

```ts
contextBudgetSummary: {
  boardDemand: ...
  boardSoftTarget: ...
  boardAllocated: ...
  boardBorrowed: ...
}
```

不需要把所有 Candidate 重复写进 Snapshot。

Snapshot 内容必须是：

```text
最终实际注入 Draft 的
characterText
noteText
worldbookText
storyMemoryText
episodicMemoryText
recentBridgeText
```

---

# 14. 其他板块边界

## Story Memory

Story Memory Protocol V2 已封板。

本轮只改：

```text
renderStoryMemoryForContext(budget)
```

传入的 budget 来源为：

```text
boardGrant.storyState
```

不改 Observation / Evidence / Compiler / Merger / Checkpoint / Attempt Ledger。

## Sliding

继续保留：

```text
最近 raw 最多 10 章
```

模型变成 1M 也不得恢复“几十章 raw 全量注入”。

V3 只改变：

```text
10章以内能获得多少 token
```

## Episodic

保留 retrieval / TopK / summary 逻辑。

旧：

```text
MAX_EPISODIC_MEMORY_BUDGET = 16000
```

只作为 Legacy/Manual 兼容，不作为 V3 自动永久 Hard Cap。

## Outline

仍是 Mandatory、完整、禁止 silent truncate。

继续保留 `OUTLINE_OVER_BUDGET`。

---

# 15. Context Preview 改造

当前：

```text
2947 tokens
已裁剪
```

信息不够。

V3 每项建议显示：

```text
林莉

实际需求：7,180
实际分配：7,180
状态：完整载入
来源：用户显式选择
```

或：

```text
云希

实际需求：12,400
板块软目标：8,000
跨板块借调：+3,600
实际分配：9,100
状态：弹性裁剪
原因：总输入已接近 Burst
```

顶部增加 Board Summary：

```text
Hard Input: xxx
Soft: xxx
Burst: xxx

Story State
需求 8K / 分配 8K

Resources
需求 42K / Soft 20K / 借调 15K / 分配 35K

Sliding
需求 10K / 分配 10K

Episodic
需求 7K / 分配 4K
```

建议扩展 `ContextTraceItem`：

```ts
demandTokens?: number;
softTargetTokens?: number;
allocatedTokens?: number;
borrowedTokens?: number;

allocationReason?:
  | 'full_fit'
  | 'soft_target'
  | 'global_borrow'
  | 'item_competition'
  | 'burst_limit'
  | 'hard_limit'
  | 'manual_cap'
  | 'not_activated';
```

---

# 16. Prompt Cache / Determinism

当前最新 HEAD 已增加 DeepSeek V4 Prompt Cache 可观测性和 Prompt Byte Stability。

V3 必须 deterministic。

禁止：

```text
随机排序
Date.now 参与排序
未排序 DB row
浮点 tie 不稳定
Map 来源顺序不明确
```

稳定排序建议：

```text
requirement
→ priority
→ relevance
→ explicitSelected
→ sourceOrder
→ sourceId
```

同样输入必须产生：

```text
同样 allocation
同样 final context bytes
```

---

# 17. 建议修改文件

核心：

```text
src/services/pipeline/elasticBudgetAllocator.ts
src/services/contextAutomationPolicy.ts
src/services/contextAutoAllocator.ts
src/services/contextBuilder.ts
src/screens/ContextPreviewScreen.tsx
src/types/contextTrace.ts
src/types/pipelineContext.ts
```

建议新增：

```text
src/services/context/hierarchicalContextAllocator.ts
src/services/context/resourceContextCandidates.ts
```

不要新增 Character/Note/Worldbook 各自独立 allocator。

---

# 18. 测试矩阵

必须至少覆盖：

### T1 模型比例缩放

同一项目：

```text
32K / 64K / 128K / 1M
```

Board Soft Target 应随冻结 Request Model 扩张。

### T2 单大资料

```text
一个显式 Character = 35K
```

空间足够时完整，不受旧单项 cap。

### T3 截图复现

两个大 Character：

```text
林莉
云希
```

总需求可放下时：

```text
两个都 full
```

不得继续固定约 `2947 / 2947`。

### T4 不等分

```text
A=800
B=1800
C=12000
```

不得 `board/3`。

### T5 空闲回收

Story/Episodic 实际需求明显小于 Soft Target，差额必须可被 Resources 借走。

### T6 跨项目隔离

```text
Project A = 2 resources
Project B = 100 resources
```

B 不得影响 A。

### T7 显式资料优先

预算不足时：

```text
显式 Character/Note
>
自动 fallback Worldbook
```

### T8 Worldbook relevance

```text
主+次关键词命中
>
主关键词
>
递归
>
项目兜底
```

### T9 Auto V3 不改 max_tokens

应用自动配置前后：

```text
characters.max_tokens
notes.max_tokens
worldbook_entries.max_tokens
worldbook_collections.max_tokens
```

保持不变。

### T10 Manual 兼容

Manual 仍尊重旧绝对 cap。

### T11 V2 Frozen Resume

`context_budget_version=2` 升级后仍 V2。

### T12 V3 Frozen Resume

全局 Policy 修改后 Resume 不漂移、已完成 Stage 不重新计费。

### T13 Multi-Chapter Freeze

父 Batch 和所有 Child 均 V3。

### T14 Preview = Actual Send

Candidate 与 allocation 必须一致。

### T15 Final Window

```text
finalInput + outputReserve + safety <= contextWindow
```

### T16 Determinism

同输入重复 100 次，allocation/context bytes 完全相同。

### T17 Property

随机至少 10,000 组：

```text
context 8K~1M
0~100 item
0~500K demand
```

不变量：

```text
allocation >= 0
allocation <= actual demand
item total <= board grant
board total <= global capacity
mandatory unchanged
same input => same result
empty board => 0
unused budget reclaimable
无 NaN/Infinity
```

---

# 19. Android 模拟器验收

本地：

```text
F:\ClaudeWorkSpace\projects\TAVO-MINI
```

安装：

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

## M1 当前截图场景

两个已启用大 Character，旧版发生裁剪。

V3 在大模型空间足够时：

```text
A full
B full
```

Preview 截图留证。

## M2 Cross-board Borrow

Story/Episodic 小、Resources 大。

Preview 必须显示：

```text
Resources Soft
Borrowed
Allocated
```

## M3 真正空间不足

切 32K/64K 测试模型。

同样资料应发生“可解释裁剪”，而不是 overflow。

## M4 切换 1M 模型

无需重新“应用自动配置”或重写资源 `max_tokens`。

同一项目 Preview 应自动：

```text
Soft Target 变大
Grant 变大
裁剪减少
```

## M5 真实一章流水线

跑 Draft / Review / FactCheck / Proof。

确认所有阶段使用同一个 Frozen Snapshot。

## M6 Background / Resume Smoke

Home / Lock / App switch / resume，确认无生命周期回归。

---

# 20. 性能 Gate

Candidate-first 会读更完整内容，必须避免性能回退：

- 保留 bulk read。
- 一个 Candidate 的 token estimate 只算一次。
- 禁止 N+1 DB。
- 避免同一正文多次 tokenize。
- 10/50/100/500 资源规模做 Preview benchmark。

---

# 21. 修改边界

允许：

```text
Context Automation Policy
Context Auto Allocator
Elastic Budget Allocator
Context Builder
Resource Candidate Collection
Context Trace / Preview
Context Budget Version
Pipeline Snapshot metadata
tests/docs
```

默认禁止：

```text
Story Memory Protocol V2
Story Memory Compiler/Merger
Checkpoint request protocol
Continuation V4 allocator
Canon
LLM Provider
Prompt Cache 业务语义
Outline 内容协议
```

除非本地真实调用链证明存在直接接驳。

---

# 22. 实施顺序

1. **失败测试先行**
   - 两个大资源固定约 2947 裁剪；
   - 跨项目资源数量污染；
   - 1M 仍被 static resourceBudget 锁死。
2. 抽共享 `allocateDemandsWithinCapacity()`，确保 V2 老测试不变。
3. 新增 `ContextAutomationPolicyV3` 和 Board Allocator。
4. Character/Note/Worldbook 改为 Candidate-first。
5. `contextBuilder` 增加 V1/V2/V3 分流。
6. Auto V3 停止写资源 `max_tokens`。
7. 接入 Version Freeze / Snapshot。
8. Context Preview 展示 demand/soft/borrow/allocated/reason。
9. Targeted → `npm run verify` → Android。

---

# 23. GO Gate

全部通过才允许 GO：

1. Auto V3 不再按全数据库 resource count 分单项额度。
2. 其他项目资源不影响当前项目。
3. Auto V3 不再批量 UPDATE resource `max_tokens`。
4. Resources `availableTokens = actual activated demand`。
5. Character/Note/Worldbook 不再以 35/20/45 作为 Hard Split。
6. Board Soft Target 随 Request Model 比例缩放。
7. 空闲预算可跨板块借调。
8. 单个大资料空间允许时可完整进入。
9. 多资料不固定均分。
10. 用户显式资料优先于自动兜底资料。
11. 32K/64K/128K/1M 均不越窗口。
12. V1/V2 Frozen task 不改变。
13. V3 Resume 不漂移、不重复计费。
14. Preview 与实际 Send 一致。
15. Prompt byte determinism PASS。
16. `npm run verify` PASS。
17. Android M1~M6 PASS。

---

# 24. NO-GO 条件

以下任一发生即 NO-GO：

```text
只是把 resourceBudget 换成另一个固定数字
只是把 35/20/45 换成另一组固定 Hard Split
仍按 resource count 等分单项 cap
仍 UPDATE 全数据库 resource max_tokens
1M 模型仍被 V2 absolute cap 锁死
板块没有真实 reclaim / borrow
Item 在进入 allocator 前已被 clip
同输入 allocation 不 deterministic
Preview != actual send
旧 V2 task 被自动升级 V3
为预算优化增加 LLM 请求
npm run verify fail
需要 uninstall/pm clear 才能通过 QA
```

---

# 25. 最终验收报告

完成后生成：

```text
docs/optimization/
Context-Budget-V3-Hierarchical-Elastic-Verification-YYYYMMDD.md
```

至少记录：

- 初始 HEAD / origin/main / 最终 HEAD；
- Context Budget Version；
- Policy V3；
- 固定比例/跨项目 count 根因；
- 是否停止 UPDATE max_tokens；
- Board / Item allocator；
- 32K/64K/128K/1M；
- 截图场景；
- Cross-board borrow；
- Explicit priority；
- V1/V2/V3 freeze/resume；
- Preview=Send；
- Prompt byte stability；
- `npm run verify`；
- Android M1~M6；
- 数据保留；
- 最终 GO/NO-GO。

---

# 26. Agent 开工前检查

```powershell
cd F:\ClaudeWorkSpace\projects\TAVO-MINI

git status
git fetch --all --prune
git rev-parse HEAD
git rev-parse origin/main
git rev-list --left-right --count HEAD...origin/main
git log -10 --oneline
```

再：

```powershell
rg -n "allocateContextBudget|applyContextAutoAllocation|countAllResources|resourceBudget|buildResourceContext|buildCharacterContext|buildNoteContext|buildWorldbookContext|allocateElasticStageContextBudget|context_budget_version|elasticBudgetTrace|PipelineContextSnapshot|ContextPreview" src __tests__
```

必须先确认本地真实调用链，再改。

---

# 27. 可直接交给 Agent 的执行提示词

```text
以 `F:\ClaudeWorkSpace\projects\TAVO-MINI` 本地实际代码为唯一实施真相。先执行 git status、git fetch --all --prune，核对 HEAD/origin/main 并保留所有未提交修改；完整阅读 docs\optimization 下最新的 Context Budget V3 Hierarchical Elastic 优化方案，并先用 rg 梳理 Context Auto Config → ContextAutomationPolicy → allocateContextBudget/applyContextAutoAllocation → compileDraft → contextBuilder → global elastic allocator → Resource Builder → Character/Note/Worldbook → Pipeline Snapshot → Context Preview → downstream stages 的真实调用链。

本轮不是把 resourceBudget 或 max_tokens 调大，而是升级为三级弹性体系：模型真实输入容量先形成 Soft/Burst/Hard envelope；Story State、Resources、Sliding、Episodic 按模型剩余输入得到比例 Soft Target，但 Soft 不是 Hard Cap，空闲预算全部回收到 Global Elastic Pool，各板块根据真实 demand/priority/relevance 跨板块借调；Resources 内部必须 Candidate-first，Character/Note/Worldbook 先读取完整激活内容并计算 actualTokens，再按 item demand/priority/relevance/explicitSelected 二次弹性分配，最后才 clip。

重点关闭当前实际问题：countAllResources 使用全数据库资源数量；applyContextAutoAllocation 批量 UPDATE 所有 resource max_tokens；resources 在 Elastic V2 中 available/target/max 都等于 static resourceBudget；buildResourceContext 固定 35/20/45；各 Character/Note/Worldbook 在进入全局弹性前已经被单项 max_tokens 和 remaining 预裁剪。Auto V3 不得继续这些行为。

复用现有 elastic allocator，不要另造多套算法；优先抽取共享 capacity-demand allocation core。顶层保留现有 80/95 water levels；板块内部使用 exact board grant，禁止再套一次 80/95 二次缩水。新增 context_budget_version=3，新任务/新批次冻结 V3，历史 V1/V2 永远按原版本 resume。Story Memory Protocol V2、Continuation V4、Canon、LLM Provider、Prompt Cache 语义原则上不动。

先补失败测试再修：至少复现两个大资源被约 2947 固定裁剪、其他项目大量资源污染当前项目额度、1M 模型仍被 absolute resourceBudget 锁死。完成后覆盖 32K/64K/128K/1M、单大资料、多个不同大小资料、空闲回收、跨板块借调、用户显式资料优先、Worldbook hit/fallback、Auto V3 不改 resource max_tokens、Manual 兼容、V2 Frozen Resume、V3 Resume、Multi-Chapter Freeze、Preview=Actual Send、determinism/property tests。

Context Preview 必须展示每板块/每资料的 actual demand、soft target、allocated、borrowed 和裁剪原因。完成后跑 targeted、typecheck/lint、npm run verify，并在现有 Android 模拟器用 adb install -r 覆盖 Debug APK，禁止 uninstall/pm clear，实测两个大资料在大模型下完整载入、跨板块借调、32K 小模型下可解释裁剪、切换 1M 模型后无需重写资源配置即自动扩张、真实一章流水线 snapshot 一致和后台/resume smoke。全部 Gate 通过前不得升版或宣称 GO，最后生成 Context-Budget-V3-Hierarchical-Elastic-Verification-YYYYMMDD.md。
```

---

# 28. 最终用户体验

用户只需要：

```text
选择模型
启用资料
开始写
```

系统应自动做到：

```text
模型大 → 上下文自然扩张
资料少 → 尽量完整
某板块空 → 预算回收
资料大 → 借用其他板块空闲预算
总量真不够 → 按价值弹性裁剪
用户显式选择 → 优先保护
模型小 → 自动收缩
最终永不突破安全窗口
```

最终规则应是：

> **固定的是模型安全边界，不是某个板块或某份资料的 token 数。**
