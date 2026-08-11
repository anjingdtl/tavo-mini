# Tavo-Mini Story Memory Protocol V2 长期稳定性重构方案
## ——基于 V2/V3 大纲流水线 Prompt/JSON 治理经验的最终架构收束

> 项目：`anjingdtl/tavo-mini`
> 本地实施工作树：`F:\ClaudeWorkSpace\projects\TAVO-MINI`
> 远端审计基线：`main@ccd5f67874b43e89b96db384c618af26d74e08b8`
> 当前版本：`V2.11.44`
> 当前数据库：`Schema 50`
> 当前 Story Memory State：`schemaVersion = 1`
> 当前 Story Memory Batch Patch：`schemaVersion = 2`
> 当前 Story Memory 默认 LLM Batch：`3`
> 当前大纲 Context Budget：`V5`
> 建议后续正式发布版本：`V2.11.45`（仅在全部 Gate 通过后升版）
> 方案日期：2026-08-11

---

# 0. 方案定位

本方案不是继续在当前 Story Memory 巨型 JSON Patch Prompt 上追加更多校验、更多 Repair 或更多容错。

重新审视 V2 以后大纲流水线的演进后，可以确认一个核心经验：

> **大模型适合做语义判断，不适合同时承担数据库 Patch 编译、ID 分配、Evidence 原文复制、跨字段一致性和持久状态事务。**

大纲流水线从 V2 Anchored Contract、V3.1 Fail-Closed 到 V3.2/当前统一协议，真正稳定下来的关键不是 JSON 越来越复杂，而是逐步把：

- schema；
- hash；
- machine-owned ID；
- source envelope；
- deterministic compiler；
- final validation；
- retry/recovery；

从 LLM 手中收回到本地程序。

当前 Story Memory 仍处在相对早期的模式：

```text
LLM
同时负责：
阅读正文
+ 人物抽取
+ 人物状态
+ 关系状态
+ 主线状态
+ thread/conflict/foreshadowing
+ DB ID / tempRef
+ evidenceQuote
+ chapterSummaries
+ Summary↔Patch 一致性
+ JSON Schema
        ↓
StoryMemoryBatchPatchDraft
        ↓
Validator
        ↓
Merger
```

真实长篇已经证明：

```text
HTTP 200
→ 内容大体正确
→ 某个跨字段契约不完全一致
→ Repair
→ Retry
→ 仍失败
```

这不是单纯 Prompt 写得不够好，而是**协议职责分配错误**。

本方案的目标是将 Story Memory 升级为：

# **Story Memory Protocol V2**

新主链：

```text
章节正文
  ↓
Local Evidence Anchoring
  ↓
Local Request Handles
  ↓
LLM Semantic Observer
  ↓
Minimal Observation JSON
  ↓
Local Normalizer
  ↓
Local Evidence Resolver
  ↓
Local Handle Resolver
  ↓
Deterministic Observation Compiler
  ↓
现有 StoryMemoryBatchPatchDraft
  ↓
现有 Validator / Merger / CAS / DB
```

核心变化只有一句话：

> **LLM 只负责说“发生了什么”；程序负责决定“数据库应该怎么变”。**

---

# 1. 当前远端实际状态

## 1.1 HEAD

当前远端最新：

```text
ccd5f67874b43e89b96db384c618af26d74e08b8
chore: 添加 Android UI 层级导出文件
```

该提交相对 Story Memory V2.11.44 merge：

```text
1f1c60bd43a4affc5771f680a3d150f0dbf3c2bf
```

只增加根目录临时 QA 文件：

```text
--out
```

本轮开始时应删除该误提交产物。

---

# 1.2 当前已完成且必须保留的能力

以下能力已经是可靠基础，本轮禁止推倒重做：

### Durable / 请求安全

- `story_memory_request_attempts`
- `prepared / sent / succeeded / failed / outcome_unknown / cancelled`
- force-stop 后 `sent → outcome_unknown`
- 禁止自动重发 unknown
- 用户显式确认恢复
- 真实 HTTP request budget

### Foreground

- 复用 `PipelineForegroundService`
- WakeLock
- Notification
- Task Store
- 页面退出后后台继续

### Checkpoint

- 默认 LLM batch = 3
- 3→2→1 preflight split
- Partial Success
- split child progress
- batch reuse
- snapshot
- dirty rebuild

### 数据一致性

- state fingerprint
- source fingerprint
- base fingerprint
- CAS
- stable ID
- duplicate character merge
- archive overflow
- batch replay

### Mainline

当前已经加入：

```text
storyMemoryMainlineReconciler.ts
```

用于 V1 巨型 Patch 输出下：

```text
Summary ↔ Structured Patch
```

的本地收束。

Protocol V2 生效后该组件主要保留为：

```text
Legacy Protocol compatibility
```

不再是新主链的核心。

---

# 1.3 当前仍存在的结构性问题

当前 V2.11.44 仍有以下问题：

### A. LLM 输出合同过重

`storyMemoryPrompts.ts` 当前让模型输出：

```text
newCharacters
characterUpdates
newRelationships
relationshipUpdates
mainlinePatch
chapterSummaries
evidenceQuote
tempRef
existing precise ID
assessment
...
```

模型承担过多机器职责。

---

### B. 同一事实重复表达

同一个 thread 可能同时写：

```text
chapterSummaries.newThreads
```

和：

```text
mainlinePatch.threadOpens
```

然后程序要求两者严格对应。

这类一致性问题本质上是协议自己制造出来的。

---

### C. Evidence 让模型逐字复制

当前要求：

```text
evidenceQuote
= 正文连续 4～80 字原句
```

模型只要：

- 改一个词；
- 改标点；
- 少一个字；
- 概括一句；

就可能触发 Evidence Failure。

---

### D. 模型直接操作机器 ID

当前模型需要：

```text
已有实体必须使用精确 ID
新实体必须创建 new_char_xxx / new_thread_xxx
```

这是 Machine-owned responsibility。

---

### E. Input Compact 仍存在 serialized JSON 截断风险

当前 `storyMemoryPromptMaterials.ts` 中多个状态模块：

```text
canonicalStringify(...)
```

后再通过：

```text
clipTextToTokenBudget(...)
```

裁剪。

预算紧张时可能产生半截 JSON。

---

### F. Elastic 目前仍未覆盖完整 request lifecycle

当前 Checkpoint：

```text
Primary
→ Elastic Planner

Repair/Fresh Retry
→ legacy planStoryMemoryRequest
```

单章 Patch：

```text
Primary/Repair/Retry
→ legacy planner
```

仍不是统一协议。

---

### G. Output 预算仍沿用写作型 V5 reservation

当前：

```text
1M / 200K
→ Story Memory max_tokens 200K
```

对于“结构化抽取”任务明显过大。

Story Memory 不需要与 Draft/Final 使用同一种输出策略。

---

# 2. 从大纲流水线 V2→V3 得出的硬性设计原则

本方案必须遵守以下经验。

---

## Principle 1：模型只输出 Semantic Payload

Machine Envelope 不再要求模型提供：

```text
schemaVersion
database ID
hash
fingerprint
rangeRef
source ID
CAS
state fingerprint
```

这些全部本地生成。

---

## Principle 2：Evidence 使用 Anchor

不再要求：

```text
模型复制原文
```

改为：

```text
模型返回 Evidence Anchor ID
→ 客户端回填真实原文
```

---

## Principle 3：同一事实只表达一次

禁止：

```text
Summary 一份
State Patch 再写一份
```

新协议中：

```text
Observation
```

是唯一语义事实源。

然后本地派生：

```text
State Patch
+
Episodic Summary 分类
```

---

## Principle 4：本地 Compiler 是事实落库唯一入口

LLM 永远不直接决定：

```text
stable DB ID
temp DB ID
StoryMemoryState mutation
```

本地 Compiler 决定。

---

## Principle 5：格式错误和语义错误分开

```text
JSON 格式错误
→ Formatter

语义读取失败
→ Fresh Semantic Retry

单条 Observation 错误
→ Local Drop / Warning
```

禁止所有问题都走“大 Prompt Repair”。

---

## Principle 6：Fail Closed 只保护真正事务边界

必须 Hard Fail：

```text
章节范围错误
State Fingerprint 错
CAS 错
整个 Payload 无法识别
数据库事务失败
outcome_unknown
```

不应该因为：

```text
某个 Evidence 错
某个 handle 错
某条 thread 字段错
```

导致整个 Batch 作废。

---

# 3. 本轮目标架构

```text
┌───────────────────────────┐
│ 当前待整理章节 1～3 章       │
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│ EvidenceAnchorBuilder      │
│ Q001/Q002/Q003...          │
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│ EntityHandleBuilder        │
│ C01/R01/T01/F01/P01/A01   │
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│ Prompt Material Builder    │
│ Mandatory/Preferred/...    │
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│ Elastic Input Planner      │
│ whole-item packing         │
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│ Semantic Observer LLM      │
│ Thinking disabled          │
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│ Observation Normalizer     │
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│ Evidence / Handle Resolver │
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│ Deterministic Compiler     │
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│ StoryMemoryBatchPatchDraft │
│ schemaVersion=2            │
└─────────────┬─────────────┘
              │
              ▼
       Existing Merger
       Existing CAS
       Existing DB
```

---

# 4. Protocol Version 策略

新增代码常量：

```ts
export type StoryMemoryProtocolVersion = 1 | 2;

export const CURRENT_STORY_MEMORY_PROTOCOL_VERSION:
  StoryMemoryProtocolVersion = 2;
```

建议文件：

```text
src/services/storyMemory/storyMemoryProtocolVersion.ts
```

---

## 4.1 不升 DB Schema

默认：

```text
Schema 50 保持不变
```

原因：

- `StoryMemoryState` 不变；
- `StoryMemoryBatchPatchDraft schemaVersion=2` 不变；
- batch 表不变；
- request ledger 不变；
- snapshot 不变。

Protocol V2 最终仍编译成现有 Batch Patch。

---

## 4.2 Ledger 中记录协议

无需新字段。

通过：

```text
requestKind
scenario
logicalBatchId.kind
```

记录：

```text
story_memory_v2_primary
story_memory_v2_formatter
story_memory_v2_fresh_retry
story_memory_v2_legacy_bootstrap
```

这样已有：

```text
story_memory_request_attempts.request_kind
```

即可审计。

---

## 4.3 Legacy Protocol V1 保留一个发布周期

现有：

```text
storyMemoryPrompts.ts
storyMemoryBatchValidator.ts
storyMemoryMainlineReconciler.ts
```

不要立刻删除。

它们保留为：

```text
legacy compatibility / rollback
```

但：

> **所有新生产 LLM 请求默认必须走 Protocol V2。**

---

# 5. Evidence Anchor 体系

这是本轮最重要的架构改造之一。

---

# 5.1 目标

将：

```text
evidenceQuote = 模型复制原文
```

替换成：

```text
evidence = ["Q017"]
```

然后客户端：

```text
Q017
→ chapterId
→ start/end offset
→ exact source text
→ BatchEvidenceQuote
```

---

# 5.2 新增

建议：

```text
src/services/storyMemory/storyMemoryEvidenceAnchors.ts
```

类型：

```ts
export interface StoryMemoryEvidenceAnchor {
  id: string;
  chapterHandle: string;
  chapterId: number;
  chapterPosition: number;
  startOffset: number;
  endOffset: number;
  text: string;
}

export interface StoryMemoryEvidenceEnvelope {
  anchors: StoryMemoryEvidenceAnchor[];
  byId: Map<string, StoryMemoryEvidenceAnchor>;
}
```

---

# 5.3 Anchor ID

一个 Batch 全局顺序：

```text
Q001
Q002
Q003
...
```

不要使用 DB ID。

---

# 5.4 分句规则

Anchor 必须是正文真实连续 substring。

建议：

1. 保留原始正文 offset；
2. 按段落分割；
3. 优先按：

```text
。！？!?；;
```

切句；
4. 超长句再按：

```text
，,:：
```

切；
5. 极短 fragment 与相邻 fragment 合并；
6. 单 Anchor 目标：

```text
4～80 字
```

7. 超过 80 字仍无法自然切分时，按 Unicode code point 安全切分；
8. 不能改写文本；
9. 不能 trim 中间内容；
10. Anchor text 必须能 `source.includes(anchor.text)`。

---

# 5.5 输入示例

模型看到：

```text
【CH01｜第91章】
Q001 王瓯推开旧仓库生锈的铁门。
Q002 一股潮湿的霉味迎面扑来。
Q003 王瓯在木柜底层找到一把银钥匙。
Q004 老何提醒众人不要继续深入地下室。
```

模型只需：

```json
{
  "evidence": ["Q003"]
}
```

---

# 5.6 Evidence Resolver

新增纯函数：

```ts
resolveObservationEvidence(
  ids: string[],
  envelope: StoryMemoryEvidenceEnvelope,
): BatchEvidenceQuote[]
```

规则：

- 去重；
- 最多保留 3 个；
- 不存在 Anchor → 当前 Observation invalid；
- 不触发整批 Repair；
- 返回：

```ts
{
  chapterId,
  quote: exactAnchorText
}
```

---

# 6. Request-local Entity Handle

模型不再看到数据库长 ID。

---

# 6.1 新增

建议：

```text
src/services/storyMemory/storyMemoryEntityHandles.ts
```

类型：

```ts
export interface StoryMemoryEntityHandleMap {
  characterByHandle: Map<string, string>;
  relationshipByHandle: Map<string, string>;
  conflictByHandle: Map<string, string>;
  threadByHandle: Map<string, string>;
  foreshadowingByHandle: Map<string, string>;
  arcHandle: string | null;

  reverseCharacter: Map<string, string>;
  reverseRelationship: Map<string, string>;
  reverseConflict: Map<string, string>;
  reverseThread: Map<string, string>;
  reverseForeshadowing: Map<string, string>;
}
```

---

# 6.2 Handle 形式

```text
Character      C01 / C02 / C03
Relationship   R01 / R02
Conflict       F01 / F02
Thread         T01 / T02
Foreshadowing  P01 / P02
Arc            A01
```

---

# 6.3 稳定排序

每次 logical request：

```text
按真实 ID 排序
→ 分配 handle
```

Primary / Formatter / Fresh Retry：

> 必须复用同一个 frozen handle envelope。

---

# 6.4 输入示例

```text
【人物】
C01 王瓯 | aliases=王姐 | active
C02 老何 | active
C03 上尉 | active

【关系】
R01 C01↔C02 | 同伴
R02 C02↔C03 | 高中同学

【未解决线索】
T01 地下室真正用途未知
T02 银钥匙来源未知

【活跃冲突】
F01 众人与守墓人之间的冲突
```

---

# 6.5 新实体局部 key

新实体允许模型使用极简 Request-local key：

```text
N1
N2
N3
```

例如：

```json
{
  "kind": "character_new",
  "key": "N1",
  "name": "陈叔",
  "role": "旧仓库管理员",
  "evidence": ["Q012"]
}
```

后续同一 Payload 可以：

```json
{
  "kind": "relationship",
  "op": "open",
  "from": "C01",
  "to": "N1",
  "type": "询问者与知情人",
  "evidence": ["Q015"]
}
```

注意：

```text
N1
```

只是模型 Payload 内的短 key。

不是：

```text
DB ID
temp DB ID
```

本地 Compiler 再映射成：

```text
new_char_obs_N1
```

或现有真实 ID。

---

# 7. Semantic Observation JSON

Protocol V2 顶层必须大幅缩减。

---

# 7.1 顶层

模型只输出：

```json
{
  "chapters": []
}
```

不要求模型输出：

```text
schemaVersion
rangeRef
fingerprint
hash
projectId
```

---

# 7.2 Chapter

```json
{
  "chapter": "CH01",
  "brief": "王瓯进入旧仓库并发现银钥匙。",
  "events": [
    "王瓯进入旧仓库。",
    "王瓯在木柜底层发现银钥匙。"
  ],
  "keywords": ["旧仓库", "银钥匙"],
  "observations": []
}
```

---

# 7.3 Chapter Handle

本地：

```text
CH01
CH02
CH03
```

映射真实：

```text
chapterId
position
```

Payload 必须每个输入 Chapter 恰好出现一条。

---

# 8. Observation Vocabulary

统一使用：

```text
observations[]
```

而不是几十个顶层数组。

---

## 8.1 character_new

```json
{
  "kind": "character_new",
  "key": "N1",
  "name": "陈叔",
  "aliases": [],
  "role": "旧仓库管理员",
  "evidence": ["Q012"]
}
```

### 必需

```text
key
name
evidence
```

---

## 8.2 character_state

```json
{
  "kind": "character_state",
  "ref": "C01",
  "field": "location",
  "op": "set",
  "value": "旧仓库地下室",
  "evidence": ["Q021"]
}
```

允许 field：

```text
location
physicalState
emotionalState
currentGoal
status
```

允许 op：

```text
set
clear
```

---

## 8.3 character_set

用于集合型状态：

```json
{
  "kind": "character_set",
  "ref": "C01",
  "field": "possession",
  "op": "add",
  "value": "银钥匙",
  "evidence": ["Q003"]
}
```

field：

```text
alias
knowledge
possession
secret
```

op：

```text
add
remove
```

---

## 8.4 relationship

### 新关系

```json
{
  "kind": "relationship",
  "key": "N2",
  "op": "open",
  "from": "C01",
  "to": "N1",
  "direction": "directed",
  "type": "调查者与知情人",
  "state": "陈叔开始向王瓯透露旧仓库历史",
  "evidence": ["Q015"]
}
```

### 更新

```json
{
  "kind": "relationship",
  "ref": "R01",
  "op": "update",
  "state": "双方信任进一步加深",
  "trust": "high",
  "reason": "老何主动掩护王瓯",
  "evidence": ["Q028"]
}
```

---

## 8.5 arc

```json
{
  "kind": "arc",
  "ref": "A01",
  "op": "update",
  "name": "旧仓库调查",
  "summary": "调查从钥匙来源转向地下室秘密。",
  "evidence": ["Q030"]
}
```

op：

```text
start
update
complete
replace
```

---

## 8.6 objective

```json
{
  "kind": "objective",
  "op": "set",
  "value": "进入地下室确认银钥匙对应的房间",
  "evidence": ["Q031"]
}
```

op：

```text
set
clear
```

---

## 8.7 conflict

### open

```json
{
  "kind": "conflict",
  "key": "N3",
  "op": "open",
  "title": "众人与守墓人的阻拦冲突",
  "state": "守墓人禁止众人进入地下室",
  "stakes": "无法继续调查钥匙来源",
  "parties": ["C01", "C02"],
  "evidence": ["Q041"]
}
```

### update

```json
{
  "kind": "conflict",
  "ref": "F01",
  "op": "update",
  "state": "冲突升级为正面对峙",
  "evidence": ["Q050"]
}
```

### resolve

```json
{
  "kind": "conflict",
  "ref": "F01",
  "op": "resolve",
  "resolution": "陈叔出面证明众人获得进入许可",
  "evidence": ["Q058"]
}
```

---

## 8.8 thread

### open

```json
{
  "kind": "thread",
  "key": "N4",
  "op": "open",
  "title": "银钥匙真正对应的房间是什么",
  "description": "钥匙明显属于地下室某道旧门，但具体目标未知。",
  "priority": "high",
  "owners": ["C01"],
  "evidence": ["Q003", "Q031"]
}
```

### update

```json
{
  "kind": "thread",
  "ref": "T02",
  "op": "update",
  "description": "钥匙被确认来自旧仓库地下层。",
  "evidence": ["Q044"]
}
```

### resolve

```json
{
  "kind": "thread",
  "ref": "T02",
  "op": "resolve",
  "resolution": "银钥匙对应地下室档案室。",
  "evidence": ["Q067"]
}
```

---

## 8.9 foreshadowing

```json
{
  "kind": "foreshadowing",
  "key": "N5",
  "op": "open",
  "setup": "档案室墙上反复出现三角刻痕。",
  "payoff": "未知",
  "evidence": ["Q071"]
}
```

更新：

```text
update
partial
resolve
```

本地映射：

```text
partial → partially_paid
resolve → paid
```

---

## 8.10 timeline

```json
{
  "kind": "timeline",
  "op": "add",
  "label": "进入旧仓库地下室",
  "time": "当晚十一点后",
  "event": "众人首次进入旧仓库地下区域。",
  "pinned": false,
  "evidence": ["Q080"]
}
```

---

# 9. 不再由模型输出的字段

Protocol V2 明确删除：

```text
assessment
rangeRef
schemaVersion
database entity id
new_char_*
new_thread_*
evidenceQuote
chapterSummaries.characterChanges
chapterSummaries.relationshipChanges
chapterSummaries.mainlineChanges
chapterSummaries.newThreads
chapterSummaries.resolvedThreads
completedBeats
```

其中：

```text
completedBeats
```

继续由 Merger 在：

```text
arc complete
conflict resolve
```

等状态变化中派生。

---

# 10. Episodic Summary 改为本地派生

模型只提供：

```text
brief
events
keywords
observations
```

本地 Compiler 派生当前 DB 需要的：

```ts
BatchChapterSummary
```

---

## 10.1 characterChanges

由：

```text
character_new
character_state
character_set
```

生成。

---

## 10.2 relationshipChanges

由：

```text
relationship
```

生成。

---

## 10.3 mainlineChanges

由：

```text
arc
objective
conflict
foreshadowing
```

生成。

---

## 10.4 newThreads

由：

```text
thread.op=open
```

生成。

---

## 10.5 resolvedThreads

由：

```text
thread.op=resolve
```

生成。

---

## 10.6 结果

因此从协议结构上消除：

```text
chapterSummaries
↔
mainlinePatch
```

双写矛盾。

Protocol V2 新请求理论上不再需要 Mainline Reconciler。

---

# 11. Observation Normalizer

建议新增：

```text
src/services/storyMemory/storyMemoryObservationNormalizer.ts
```

---

# 11.1 原则

不要把模型当严格数据库客户端。

Normalizer 负责：

```text
字段 alias
空值
未知字段
重复 observation
数组默认值
字符串 trim
枚举 normalize
```

---

# 11.2 Root Wrapper

允许本地 deterministic unwrap：

```json
{"chapters":[...]}
```

也允许常见：

```json
{"result":{"chapters":[...]}}
```

前提：

```text
root 只有一个 object child
且 child.chapters 为 array
```

不需要因此 Repair。

---

# 11.3 Chapter Coverage

必须：

```text
输入3章
→ 输出必须最终得到3个 chapter records
```

如果只是：

```text
chapter handle 重复
```

本地按第一有效/信息更完整项 merge。

如果确实缺一章：

```text
Fresh Semantic Retry
```

而不是 Local Drop。

---

# 11.4 Brief 容错

如果：

```text
brief 为空
events 非空
```

本地：

```text
brief = events[0]
```

如果：

```text
brief/events 都为空
```

但章节正文非空：

使用 Anchor：

```text
Q001
```

生成本地最小 fallback brief。

不得为了 brief 缺失使整个 Batch 失败。

---

# 11.5 Unknown Observation

例如：

```json
{"kind":"mystery_magic_state"}
```

行为：

```text
drop observation
+ warning
```

不 Repair。

---

# 12. Local Observation Compiler

建议新增：

```text
src/services/storyMemory/storyMemoryObservationCompiler.ts
```

输入：

```text
normalized observation payload
previous StoryMemoryState
entity handles
evidence anchors
chapter handles
```

输出：

```text
StoryMemoryBatchPatchDraft
```

---

# 12.1 编译顺序

必须按：

```text
chapterPosition
→ earliest evidence anchor offset
→ original observation order
```

保证状态时间顺序。

---

# 12.2 两阶段 Reference Resolution

### Pass A

先收集：

```text
character_new key
relationship open key
conflict open key
thread open key
foreshadowing open key
```

建立：

```text
N1 → local tempRef
```

---

### Pass B

再解析所有：

```text
ref
from
to
parties
owners
```

允许引用：

```text
existing handle
+
N-key
```

---

# 12.3 Character Mapping

### character_new

编译：

```text
BatchNewCharacterPatch
```

tempRef：

```text
obs_char_N1
```

如果与 existing：

```text
canonicalName / alias
```

匹配：

```text
不要创建重复人物
→ N1 映射到 existing real ID
```

必要时生成：

```text
addAliases
```

---

### character_state

映射：

```text
location       → stateChanges.location
physicalState  → stateChanges.physicalState
emotionalState → stateChanges.emotionalState
currentGoal    → stateChanges.currentGoal
status         → status
```

clear：

```text
clearFields
```

---

### character_set

```text
alias      → addAliases
knowledge  → add/removeKnowledge
possession → add/removePossessions
secret     → add/removeSecrets
```

---

# 12.4 Relationship Mapping

open：

```text
BatchNewRelationshipPatch
```

update：

```text
BatchRelationshipUpdatePatch
```

endpoint 无法解析：

```text
drop 当前 observation
```

禁止整个 Batch fail。

---

# 12.5 Mainline Mapping

### arc

```text
BatchMainlinePatch.currentArcUpdate
```

### objective

```text
currentObjective
```

### conflict

```text
conflictUpserts
conflictResolutions
```

### thread

```text
threadOpens
threadUpdates
threadResolutions
```

### foreshadowing

```text
foreshadowingUpserts
```

### timeline

```text
timelineAnchors
```

---

# 12.6 Assessment 本地生成

完全删除模型 assessment。

编译完成后：

```ts
assessment.result =
  hasPersistentMainlineMutation
    ? 'changed'
    : 'unchanged'
```

reason 本地：

```text
检测到结构化主线变化
```

或：

```text
本批未形成持续主线状态变化
```

---

# 12.7 Compiler 生成的 Patch 再做本地 Safety Validation

建议：

```text
compile
↓
validateCompiledStoryMemoryBatchPatch
↓
Merger
```

Compiled Validation 只检查：

```text
内部引用
范围
字段类型
evidence 已解析
tempRef 唯一
关系端点
```

如果这里失败：

> 这是客户端 Compiler Bug，不允许调用 LLM Repair。

---

# 13. 局部降级策略

这是长期稳定性关键。

---

# 13.1 单条 Evidence Anchor 不存在

```text
drop observation
warning=OBS_EVIDENCE_INVALID
```

---

# 13.2 Entity Handle 不存在

```text
drop observation
warning=OBS_REF_INVALID
```

---

# 13.3 Relationship endpoint 不完整

```text
drop observation
```

---

# 13.4 Thread resolve 找不到 thread

```text
drop observation
```

或由 Compiler 转成：

```text
episodic event
```

不得自动创造 thread。

---

# 13.5 Ambiguous New Character

如果同批：

```text
两个 N-key
canonicalName 完全相同
```

本地 merge。

如果：

```text
同名但明显不同实体
```

无法可靠判定：

```text
保留第一个可验证人物
其余 observation 降级 episodic event
warning
```

禁止瞎造两个稳定 ID。

---

# 13.6 整个 Batch 仍可成功

即使：

```text
30 observations
其中3条 invalid
```

只要：

```text
chapter coverage 正常
payload 可解析
State CAS 正常
```

应该：

```text
27 条 accepted
3 条 warning
Batch Applied
```

而不是全部回滚。

---

# 14. 什么仍然 Hard Fail

只保留真正事务级错误。

---

## Hard 1：Payload 整体无法恢复

```text
Primary
Formatter
Fresh Retry
```

均无法得到 chapters payload。

---

## Hard 2：Chapter Coverage 无法确认

连续 Retry 后仍：

```text
缺章
错误 chapter handle
```

---

## Hard 3：Base Fingerprint mismatch

保持当前：

```text
MEMORY_BASE_FINGERPRINT_MISMATCH
```

---

## Hard 4：CAS / transaction

保持。

---

## Hard 5：outcome_unknown

保持。

---

## Hard 6：单章 Mandatory Context 无法容纳

```text
0 HTTP
```

---

# 15. Prompt 输入重构：不要再把 State 当大 JSON

新增建议：

```text
src/services/storyMemory/storyMemoryObservationMaterials.ts
```

---

# 15.1 输入采用紧凑文本

例如：

```text
【人物名册】
C01 | 王瓯 | aliases=王姐 | active
C02 | 老何 | active
C03 | 上尉 | active

【相关人物状态】
C01 | location=旧仓库 | goal=调查银钥匙
C02 | location=旧仓库

【关系】
R01 | C01↔C02 | 同伴 | trust=high

【当前主线】
A01 | 旧仓库调查 | 调查钥匙与地下室之间的关系
OBJECTIVE | 找到银钥匙对应的门

【未解决线索】
T01 | 地下室用途未知
T02 | 银钥匙来源未知
```

不要序列化成巨大 JSON。

---

# 15.2 Mandatory

绝不丢：

```text
system observer protocol
output observation contract
chapter handles
anchored current chapter bodies
full lightweight character roster:
  handle / canonicalName / aliases / status
current arc/objective
```

注意：

> 模型不看真实 DB ID，但本地 handle map 保存真实 ID。

---

# 15.3 Preferred High

```text
relevant character rich state
relevant relationships
active conflict details
active thread details
active foreshadowing details
```

---

# 15.4 Preferred Low

```text
non-relevant character lightweight state
non-relevant relationships
recent timeline
recent resolved history
```

---

# 15.5 Optional

```text
archiveDigest
older timeline
older resolved items
```

---

# 16. Relevant Entity Resolver

当前已有：

```text
canonicalName/alias
appears in batch body
```

可继续复用。

但 Protocol V2 扩展到：

```text
characters
relationships
threads
conflicts
foreshadowing
```

---

# 16.1 Character

当前正文命中：

```text
canonicalName / alias
```

→ relevant。

---

# 16.2 Relationship

任一 endpoint relevant：

→ relevant。

---

# 16.3 Thread / Conflict / Foreshadowing

使用本地轻量 keyword match：

```text
title/setup 中 2字以上关键词
出现在当前正文
```

或：

```text
ownerCharacterIds 命中 relevant character
```

→ relevant。

不调用 LLM。

---

# 17. Elastic Input 改为 Whole-item Packing

当前最大错误之一是：

```text
JSON.stringify
→ char clipping
```

Protocol V2 禁止。

---

# 17.1 Generic Allocator 继续复用

必须继续调用：

```ts
allocateElasticStageContextBudget()
```

禁止新建第二套 Elastic 算法。

---

# 17.2 Demand 层级

Allocator 仍分配：

```text
Mandatory
Preferred
Optional
```

但分配到一个 group 后：

> **按照完整 item 打包，而不是截断字符串。**

---

# 17.3 packWholeItems

新增纯函数：

```ts
packWholeItems<T>(
  items: T[],
  tokenBudget: number,
  render: (item:T)=>string,
): T[]
```

规则：

```text
逐 item estimate
完整 item 能放才加入
不能放则跳过/停止
```

不允许：

```text
半个人物
半个 relationship
半个 JSON
```

---

# 17.4 Plain Text 可安全 clipping 的范围

只有：

```text
archiveDigest
很长的自然语言 description
```

可以使用普通 text clipping。

但不能用于：

```text
JSON
entity line
handle line
schema contract
chapter body
```

---

# 17.5 Burst Gate 必须严格

最终 build 后：

```text
estimateMessagesTokens()
```

如果：

```text
<= Soft
```

正常发送。

如果：

```text
Soft < input <= Burst
```

允许发送。

如果：

```text
> Burst
```

必须：

```text
drop Optional whole items
↓
drop Preferred Low whole items
↓
re-estimate
```

仍：

```text
> Burst
```

→ 3→2→1 Split。

禁止当前 V2.11.44 的：

```text
> Burst
但 <= Hard
仍然直接 send
```

---

# 18. Story Memory Output Budget V2

Generic Elastic Allocator 保留。

但：

> **Story Memory 不再复用写作型 `20% context` 输出 reservation。**

---

# 18.1 新策略

新增：

```text
StoryMemoryObservationOutputBudget
```

建议初始：

```ts
const STORY_MEMORY_V2_OUTPUT_BASE_TOKENS = 2048;
const STORY_MEMORY_V2_OUTPUT_PER_CHAPTER = 6144;
const STORY_MEMORY_V2_OUTPUT_HARD_CAP = 24576;
```

计算：

```ts
target =
  min(
    HARD_CAP,
    BASE + PER_CHAPTER * batchSize
  );
```

得到：

```text
1章 → 8192
2章 → 14336
3章 → 20480
```

再：

```text
maxTokens = min(target, modelMaxOutputTokens)
```

---

# 18.2 最小输出能力

建议：

```text
单章最低 4096
两章最低 8192
三章最低 12288
```

如果模型上限达不到：

```text
batch>1
→ preflight split

batch=1
→ actionable capability failure
```

---

# 18.3 为什么这样更合理

Story Memory V2 输出是：

```text
brief
events
keywords
observation handles
```

不再输出：

```text
完整 DB Patch
大量 evidenceQuote
重复 chapterSummary 分类
巨大 machine envelope
```

所以不需要 200K 输出。

---

# 18.4 Length 处理

如果：

```text
finishReason=length
```

多章：

```text
Split
```

单章：

```text
Fresh semantic retry 可有一次“只保留后续连续性必要变化”的压缩提示
```

仍 length：

```text
actionable failure
```

禁止无限增大 maxTokens。

---

# 19. Request Policy

当前：

```text
temperature=0.1
responseFormat=json_object
thinking=disabled
```

方向正确。

Protocol V2 保持。

不新增用户 Thinking 配置。

---

# 20. Primary / Formatter / Fresh Retry

统一新的三阶段恢复策略。

---

# 20.1 Primary

```text
anchored chapters
+ handles
+ selected hot state
→ Semantic Observer
```

---

# 20.2 Formatter

仅用于：

```text
JSON syntax / shape
```

Formatter 输入：

```text
candidate
+
最小 Observation schema
+
合法 chapter handles
+
合法 existing handles
+
合法 evidence anchor ids
+
failure code
```

绝对不包含：

```text
章节全文
Previous State 全量
大纲
世界书
```

Formatter 职责：

> **只整理候选已有语义，不重新分析小说。**

---

# 20.3 Formatter Prompt

建议新增：

```text
storyMemoryObservationFormatter.ts
```

明确写：

```text
不得新增人物
不得新增事件
不得新增 Evidence Anchor
不得新增 Entity Handle
不得重新阅读/推测剧情
只整理 candidate 中已经存在的信息
```

---

# 20.4 Fresh Semantic Retry

如果：

```text
Formatter 仍失败
```

或：

```text
Payload 可解析但 Chapter Coverage 严重错误
```

执行：

```text
Fresh Retry
```

重新使用：

```text
同一 frozen model config
同一 evidence anchors
同一 entity handles
同一 input materials
```

不回显 invalid output。

---

# 20.5 Attempt Budget

保持：

```text
<=3 physical HTTP / logical child batch
```

典型：

```text
Primary = 1
```

格式错误：

```text
Primary
→ Formatter
```

最坏：

```text
Primary
→ Formatter
→ Fresh Retry
```

---

# 21. 不再进行“语义 Repair”

以下错误禁止 paid Repair：

```text
unknown handle
invalid evidence id
unknown observation kind
optional field 不完整
thread resolve 不存在
relationship optional state 缺失
```

这些全部：

```text
Local Normalize / Drop / Warning
```

---

# 22. Structured Candidate 经验复用

大纲流水线已有：

```text
structuredCandidate
```

本轮可以借鉴其：

- 提取 JSON candidate；
- 识别 truncated JSON；
- content/reasoning channel；
- candidate hash；
- root key 诊断；

但不要为了复用而让 Story Memory 强依赖 Pipeline Domain。

建议：

### 方案 A

如果可以在不影响大纲测试的前提下，把通用部分抽成：

```text
src/services/llm/structuredJsonCandidate.ts
```

Pipeline 和 Story Memory 共用。

### 方案 B

如果抽取会扩大风险：

在 Story Memory 内实现薄 adapter。

优先：

> **最小影响范围。**

---

# 23. Checkpoint 主链接入

重点修改：

```text
storyMemoryCheckpointService.ts
```

---

# 23.1 当前

```text
buildStoryMemoryCheckpointMessages
↓
planStoryMemoryElasticRequest
↓
LLM returns StoryMemoryBatchPatchDraft
↓
parseAndValidateBatchPatch
```

---

# 23.2 新

```text
buildObservationEnvelope
↓
planObservationRequest
↓
requestObservationPrimary
↓
normalizeObservationPayload
↓
resolveEvidence/handles
↓
compileObservationBatchPatch
↓
validateCompiledPatch
↓
applyStoryMemoryBatchPatch
```

---

# 23.3 Split

必须继续保留当前：

```text
runStoryMemoryCheckpointBatchWithShrink
```

以及：

```text
Partial Success
onChildBatchComplete
```

不要重写。

只替换 child batch 的：

```text
LLM generation layer
```

---

# 24. Single Chapter Patch 主链统一

当前：

```text
generateValidatedChapterMemoryPatch()
```

仍是一套独立巨型 Patch LLM 协议。

Protocol V2 必须消除这套重复。

---

# 24.1 新策略

`generateValidatedChapterMemoryPatch()` 保留函数签名，内部改为：

```text
1 chapter
↓
build Protocol V2 observation envelope
↓
Semantic Observer
↓
Observation Compiler
↓
ChapterMemoryPatchDraft adapter
```

---

# 24.2 不再使用

生产新请求不再走：

```text
buildStoryMemoryPatchMessages
buildStoryMemoryRepairMessages
buildStoryMemoryFreshRetryMessages
```

这些保留 legacy。

---

# 25. Rebuild 统一

当前 `storyMemoryRebuild.ts`：

### 默认 scheduler 路径

走 batch checkpoint。

### scheduler off / legacy

走：

```text
generateValidatedChapterMemoryPatch
```

Protocol V2 后两条都必须使用同一 Observation 协议。

---

# 25.1 Legacy Bootstrap

现有：

```text
legacyChapter()
```

生成：

```text
title
synopsis
memory_summary
summary_json
```

Protocol V2 仍可对这份 synthetic chapter 做 Anchoring。

额外 system note：

```text
这是历史摘要型输入，只提取文本明确表达的事实，不补全缺失剧情。
```

---

# 26. Existing Merger 保持不动

当前 `storyMemoryMerger.ts` 已经具备：

```text
stableId
findExistingCharacter
alias merge
set update
relationship merge
arc
conflict
thread
foreshadowing
archive overflow
fingerprint
```

本轮原则：

> **Compiler 适配 Merger，不让 Merger 适配 LLM。**

除非测试证明 Merger 本身存在确定 Bug，否则不改。

---

# 27. Mainline Reconciler 的新定位

Protocol V2：

```text
Summary derived from observations
```

所以新 Batch 理论上不需要：

```text
reconcileStoryMemoryMainlineDraft
```

保留：

```text
Legacy V1 output
旧测试
历史兼容
```

不要删除。

---

# 28. Story Memory Hot / Episodic / Cold 分层

为了真正支持 300～1000 章，明确职责：

---

## Hot State

`StoryMemoryState` 提供未来写作持续约束：

```text
人物当前状态
人物当前持有物
人物当前知识/秘密
当前关系
currentArc
currentObjective
activeConflicts
openThreads
open foreshadowing
pinned/recent timeline
```

---

## Episodic Memory

保存：

```text
每章发生什么
谁对谁做什么
关系为何改变
谁知道了什么
物品如何转移
历史事件
```

由：

```text
chapter summary
```

负责。

---

## Cold Archive

已经：

```text
resolve
complete
close
```

的内容逐步归档。

新 Prompt 不需要反复发送全部 Closed History。

---

# 29. 长篇 Prompt 规模原则

测试 100/300/1000 章时，不要求：

```text
State DB 大小不增长
```

要求：

> **每次 LLM Request Input 不随章节数近似线性增长。**

目标：

```text
Mandatory roster
+
Hot State
+
Relevant rich state
+
Current Batch
```

请求规模趋于稳定。

---

# 30. 新增诊断

每个 V2 logical batch 记录：

```text
protocolVersion=2
range
model
contextWindow
modelMaxOutput

outputReservation

fullInputTokens
finalInputTokens
softLimit
burstLimit
hardLimit

materialCounts:
  mandatory
  preferredHigh
  preferredLow
  optional

includedEntityCounts
droppedMaterialCounts

anchorCount
handleCounts

responseCandidateChars
normalizerWarnings

observationsReceived
observationsAccepted
observationsDropped

dropReasons:
  invalid_anchor
  invalid_ref
  invalid_kind
  invalid_op
  invalid_field
  duplicate

physicalAttemptCount

formatterUsed
freshRetryUsed
splitUsed

applied
```

---

# 30.1 隐私边界

禁止日志：

```text
API Key
完整章节正文
完整 Prompt
完整模型响应
真实 secrets 内容
reasoning
```

---

# 31. 建议新增文件

```text
src/services/storyMemory/
  storyMemoryProtocolVersion.ts
  storyMemoryEvidenceAnchors.ts
  storyMemoryEntityHandles.ts
  storyMemoryObservationTypes.ts
  storyMemoryObservationPrompts.ts
  storyMemoryObservationMaterials.ts
  storyMemoryObservationNormalizer.ts
  storyMemoryObservationCompiler.ts
  storyMemoryObservationFormatter.ts
```

如果 Agent 判断文件过碎，可合并。

但职责必须清晰。

---

# 32. 重点修改文件

```text
src/services/storyMemory/storyMemoryCheckpointService.ts
src/services/storyMemory/storyMemoryService.ts
src/services/storyMemory/storyMemoryRequestBudget.ts
src/services/storyMemory/storyMemoryRebuild.ts
src/services/storyMemory/storyMemoryRequestPolicy.ts
```

小改：

```text
src/services/storyMemory/storyMemoryTypes.ts
```

仅在确有必要暴露通用类型时。

---

# 33. Legacy 文件

以下不应立即删除：

```text
storyMemoryPrompts.ts
storyMemoryPromptMaterials.ts
storyMemoryBatchValidator.ts
storyMemoryMainlineReconciler.ts
storyMemoryValidator.ts
```

其中旧 Prompt Materials：

```text
不得再作为 V2 主路径。
```

---

# 34. 明确禁止修改

本轮禁止：

```text
大纲流水线 Draft/Review/FactCheck/Brief/Final
CURRENT_CONTEXT_BUDGET_VERSION
Continuation
Canon
Foreground Android Service
Schema recovery
用户正文
Batch 默认值 >3
P2 并行
```

---

# 35. Phase 0：施工前基线

Agent 首先：

```bash
git status
git fetch --all --prune
git rev-parse HEAD
git rev-parse origin/main
```

要求：

```text
不得覆盖本地未提交内容
```

并确认远端是否仍为：

```text
ccd5f678
```

如果远端有新提交：

> 先 compare，再把已经解决的内容从施工清单中跳过。

---

# 35.1 清理误提交 QA 文件

确认：

```text
--out
```

只是 UI hierarchy 导出。

删除并加入正确 ignore（如果可能再次生成）。

---

# 36. Phase 1：Evidence Anchors

先只实现：

```text
Anchor Builder
Resolver
Tests
```

不接 LLM。

Gate：

- exact substring；
- offset 正确；
- 中文标点；
- 英文标点；
- 对话；
- 长句；
- 空段；
- CRLF/LF；
- emoji/surrogate；
- 4～80字；
- deterministic。

---

# 37. Phase 2：Entity Handles

实现：

```text
characters
relationships
conflicts
threads
foreshadowing
arc
```

Handle mapping。

Gate：

```text
同一 state
→ 同一 handle map
```

排序稳定。

---

# 38. Phase 3：Observation Types + Normalizer

先不请求 LLM。

使用 Fixture：

```text
valid
unknown root
wrapper
missing optional
unknown kind
invalid ref
duplicate observations
missing chapter
```

确认：

```text
局部错误不炸整批
```

---

# 39. Phase 4：Observation Compiler

这是本轮最核心代码。

建立大量 deterministic fixtures。

必须做到：

```text
Observation
→ 当前 StoryMemoryBatchPatchDraft schemaVersion=2
```

然后：

```text
applyStoryMemoryBatchPatch()
```

得到正确 State。

---

# 39.1 必须覆盖

- 新人物；
- existing 人物；
- alias；
- 状态；
- possession；
- knowledge；
- secret；
- relationship；
- arc；
- objective；
- conflict；
- thread；
- foreshadowing；
- timeline；
- 同 batch 新人物被关系引用；
- 同 batch 新 thread 后续 resolve；
- duplicate；
- invalid handle；
- invalid evidence；
- no state change。

---

# 40. Phase 5：Derived Episodic Summary

证明：

```text
thread open observation
```

同时自动产生：

```text
threadOpens
+
chapterSummary.newThreads
```

而无需模型双写。

---

# 40.1 核心回归

构造过去真实失败模式：

```text
Summary 写主线变化
Patch 无主线变化
```

Protocol V2：

> **此状态在类型和 Compiler 结构上必须无法产生。**

---

# 41. Phase 6：Observation Prompt

Prompt 应保持短、清楚。

System 核心只写：

```text
你是小说连续性观察器，不是作者。
只记录正文明确发生、会影响后续连续性的事实。
不要续写、猜测、补全。
Evidence 只能引用输入中存在的 Qxxx。
已有实体只能引用输入中的 C/R/T/F/P/A handle。
新实体用 N1/N2... 局部 key。
只输出 chapters JSON。
没有变化时 observations=[]。
```

不要重新写当前 V1 那种超长 DB Patch 字段说明。

---

# 42. Phase 7：Whole-item Elastic Materials

建立：

```text
Protocol V2 material builder
```

验证：

```text
任何 compact 路径
都不存在半截 JSON
```

测试必须直接：

```text
for every entity block:
  parse/line structure complete
```

---

# 43. Phase 8：Output Budget V2

实现 bounded extraction output。

专项测试：

```text
1章 → 8192
2章 → 14336
3章 → 20480
```

并覆盖：

```text
model cap smaller
small context
split
single impossible
```

最终常量可以依据真实 Fixture 微调，但不能退回：

```text
1M → 200K
```

除非真实数据证明必要。

---

# 44. Phase 9：Checkpoint 接入

Protocol V2 Primary 真正上线。

要求：

```text
Primary
→ observations
→ compile
→ existing Merger
```

旧 V1 path 保留内部 fallback。

---

# 45. Phase 10：Formatter / Fresh Retry

实现 body-free Formatter。

真实 attempt 顺序：

```text
Primary
→ Formatter
→ Fresh Retry
```

最多 3 HTTP。

---

# 46. Phase 11：Single Chapter + Rebuild 统一

确保：

```text
checkpoint
single patch
full rebuild
legacy bootstrap
```

所有**新 LLM 请求**都使用 Protocol V2。

禁止出现：

```text
checkpoint=V2
rebuild patch=V1
```

这种混合。

---

# 47. Phase 12：旧路径降级为 Legacy

新增测试证明：

```text
CURRENT_PROTOCOL=2
```

时生产调用链不调用：

```text
buildStoryMemoryCheckpointMessages
buildStoryMemoryPatchMessages
```

Legacy 测试仍可直接调用。

---

# 48. Automated Test Matrix

---

## Gate A：Anchors

至少：

```text
20+ tests
```

---

## Gate B：Handles

至少：

```text
existing character
alias
relationships
thread
conflict
foreshadow
deterministic ordering
```

---

## Gate C：Normalizer

至少：

```text
valid JSON
wrapper
unknown keys
missing optional
bad observation
duplicate
missing chapter
```

---

## Gate D：Compiler

每种 Observation kind 全覆盖。

---

## Gate E：Partial Degradation

一个 Batch：

```text
20 valid
3 invalid
```

要求：

```text
20 accepted
3 warnings
Batch applies
```

---

## Gate F：No Summary Dual-write

验证：

```text
derived summary
```

永远由 Patch Observation 源生成。

---

## Gate G：Budget

```text
1M/200K
128K/32K
64K/32K
```

---

## Gate H：No Broken Structured Input

对所有 compact materials：

```text
禁止半行 entity
禁止半 JSON
禁止 chapter body clip
```

---

## Gate I：Attempt

```text
physical HTTP <=3
```

---

## Gate J：Durable

原：

```text
force-stop outcome_unknown
```

全部回归。

---

# 49. Long Novel 压测

至少：

```text
100章
300章
1000章
```

---

# 49.1 生成模拟 State

包含：

```text
大量 characters
relationships
open/closed threads
conflicts
foreshadowing
timeline
archive
```

---

# 49.2 关键指标

记录：

```text
State serialized size
V2 full material tokens
V2 final material tokens
mandatory tokens
included rich characters
included relationships
included active mainline
```

---

# 49.3 GO 条件

100→300→1000 章：

```text
final request tokens
```

不能近似随总章节数线性增长。

---

# 50. 真实 LLM 穿测

必须使用最终 Debug APK：

> **覆盖升级安装，禁止 uninstall / pm clear。**

这样保留现有：

```text
DeepSeek LLM
API Key
项目
章节
Story Memory
ledger
```

进行真实测试。

---

# 50.1 安装方式

优先：

```bash
adb install -r <V2.11.45-debug.apk>
```

如果签名不一致：

> 修正构建签名，不得通过卸载绕过。

---

# 50.2 Real Test 1：普通三章

真实：

```text
1M/200K
```

期望：

```text
1 HTTP
Observation valid
Compiler applied
```

---

# 50.3 Real Test 2：原复杂长篇失败 Fixture

必须复用曾经出现：

```text
3× HTTP 200
→ Mainline contract failure
```

的长篇条件。

Protocol V2 期望：

```text
Primary
→ Observation
→ Local Compile
→ Applied
```

不再存在 Summary/Mainline 双写问题。

---

# 50.4 Real Test 3：Evidence

构造模型容易改写原句的场景。

期望：

```text
模型只返回 Q Anchor
```

不存在 quote mismatch。

---

# 50.5 Real Test 4：Invalid Observation

人工让模型返回：

```text
1 个 invalid handle
+
其余 valid
```

期望：

```text
invalid one dropped
batch still applied
```

---

# 50.6 Real Test 5：Invalid JSON Formatter

人工/测试注入：

```text
Primary invalid JSON
```

期望：

```text
Formatter
→ valid
→ no chapter body reinjection
→ applied
```

---

# 50.7 Real Test 6：Fresh Retry

Formatter 再失败。

期望：

```text
Fresh Retry
→ same frozen model
→ same anchors
→ same handles
```

---

# 50.8 Real Test 7：小窗口

```text
64K/32K
```

验证：

```text
whole-item compact
→ no broken state block
→ split 3→2→1 when necessary
```

---

# 50.9 Real Test 8：Force Stop

```text
sent
→ force-stop
→ cold start
→ outcome_unknown
→ no auto resend
→ user ack
→ new V2 request success
```

---

# 50.10 Real Test 9：自动维护连续两轮

```text
interval 1
→ success
→ 新章节 pending
→ interval 2
→ success
```

---

# 50.11 Real Test 10：后台

整理中：

```text
Home
锁屏
切换 App
```

必须继续。

---

# 51. 数据升级验证

覆盖安装前后核对：

```text
firstInstallTime
versionName/versionCode
project count
chapter count
LLM config
StoryMemory through position
StoryMemory fingerprint
attempt ledger count
```

---

# 51.1 禁止

```text
uninstall
pm clear
删除数据库
删除 secure storage
```

---

# 52. Regression

必须完整：

```bash
npm run verify
```

同时专项：

```text
Story Memory tests
Pipeline tests
Continuation tests
DB migration tests
```

确保 Protocol V2 不影响：

```text
大纲流水线
Canon
Continuation
```

---

# 53. Release Gate

只有以下全部 PASS 才允许：

```text
V2.11.45
```

---

## Gate 1：Protocol

所有新生产 Story Memory LLM 调用走 V2。

---

## Gate 2：No DB Patch from LLM

生产 Prompt 不再要求：

```text
StoryMemoryBatchPatchDraft
```

由模型直接输出。

---

## Gate 3：Evidence

生产状态变更证据全部来自：

```text
Local Anchor Resolver
```

---

## Gate 4：ID

模型不再看到/生成 DB ID。

---

## Gate 5：No Dual-write

Summary 分类全部本地派生。

---

## Gate 6：Partial Degradation

单 Observation 错误不炸 Batch。

---

## Gate 7：Budget

- Generic Elastic；
- whole-item packing；
- strict Burst；
- bounded output；
- 3→2→1。

---

## Gate 8：Repair

- body-free Formatter；
- Fresh Retry；
- <=3 HTTP。

---

## Gate 9：Long Novel

100/300/1000 长篇 Request 规模受控。

---

## Gate 10：Durable

Force Stop 完整回归。

---

## Gate 11：Auto

连续两轮 automatic maintenance。

---

## Gate 12：Real Complex LLM

真实复杂长篇成功。

---

## Gate 13：Upgrade

最终 Debug APK 覆盖安装，数据和 LLM 配置保留。

---

## Gate 14：Regression

```text
npm run verify PASS
```

---

# 54. Release

全部 Gate PASS 后：

先完整阅读：

```text
docs/RELEASE_APK_BUILD.md
docs/RELEASE_CHECKLIST.md
```

然后：

```bash
npm version 2.11.45 --no-git-tag-version --ignore-scripts
npm run prebuild
npm run verify:version
npm run verify
npm run apk:release
```

不得手工修改：

```text
src/constants/version.json
```

---

# 55. 最终验收报告

生成：

```text
docs/optimization/
Story-Memory-Protocol-V2-Final-Verification-YYYYMMDD.md
```

必须包含：

```text
baseline HEAD
final HEAD
version
schema
modified files

Protocol V2 architecture
old/new call path

anchor tests
handle tests
compiler tests
partial degradation

budget trace
output reservation
small window split

100/300/1000 metrics

real LLM captures
formatter
fresh retry
force stop
auto interval x2
background

upgrade install evidence
data retention

npm run verify

final GO / NO-GO
```

---

# 56. 失败标准

任何以下情况：

```text
NO-GO
```

---

## Blocker A

仍有生产 LLM Prompt 要求直接生成：

```text
StoryMemoryBatchPatchDraft
```

---

## Blocker B

仍要求模型复制 evidenceQuote。

---

## Blocker C

Compact 后存在半截 JSON / entity block。

---

## Blocker D

Repair 仍重新注入整篇正文 + Previous State + invalid output。

---

## Blocker E

一个 invalid observation 仍导致整个有效 Batch 作废。

---

## Blocker F

Protocol V2 只改 checkpoint，但 rebuild / single patch 仍用 V1。

---

## Blocker G

真实复杂长篇没有跑。

---

## Blocker H

没有用最终 Debug APK 覆盖已有 App 做真实 LLM。

---

# 57. 修复边界

本轮 Agent 必须严格控制范围。

### 允许

```text
Story Memory Protocol
Story Memory Prompt
Story Memory Observation
Story Memory Budget Adapter
Story Memory Validator/Compiler
Story Memory tests
Story Memory diagnostics
```

### 禁止

```text
大纲 Pipeline 重构
Continuation 重构
Canon 重构
新 DB 架构
第二个 Foreground Service
第二套 Elastic Allocator
Batch >3
P2
无关 UI
```

---

# 58. 最终产品状态

完成后，用户应该只感知：

```text
长期记忆：正常
```

内部则达到：

```text
模型只做语义抽取
机器字段本地拥有
Evidence 可验证
ID 可控
JSON 简洁
State Patch deterministic
单条错误局部降级
长篇 Prompt 受控
Repair 不重读小说
请求次数有上限
后台可运行
强杀可恢复
自动维护可持续
```

---

# 59. Agent 实施方法

Agent 必须采用：

```text
复现
→ 测试固定
→ 最小实现
→ targeted test
→ integration
→ real LLM
→ full verify
```

禁止：

```text
先大规模重写再找问题
```

---

# 60. 给 Agent 的执行提示词

```text
以本地 `F:\ClaudeWorkSpace\projects\TAVO-MINI` 为唯一实施工作树。开始前执行 `git status`、`git fetch --all --prune`，核对本地 HEAD 与最新 `origin/main`，不得覆盖任何本地未提交内容；远端仅用于审计和差异参考。

完整阅读并严格执行 `docs\optimization` 下《Tavo-Mini Story Memory Protocol V2 长期稳定性重构方案》。本轮目标不是继续修补旧 Story Memory 巨型 JSON Patch Prompt，而是按照大纲流水线 V2/V3 已验证的经验，把 Story Memory 重构为“LLM Semantic Observation → Local Normalizer/Evidence Resolver/Handle Resolver → Deterministic Compiler → 现有 StoryMemoryBatchPatchDraft → 现有 Merger/CAS/DB”。

必须保留现有 StoryMemoryState、Batch Patch schema、Merger、CAS/Fingerprint、request ledger/outcome_unknown、Foreground/WakeLock、Task Store、3→2→1 Split、Partial Success、batch reuse/snapshot 等已验收能力；不得重复重构这些基础设施。

核心要求：
1. 建立 Evidence Anchor（Qxxx），模型只返回 Anchor ID，本地回填精确原文，生产新协议禁止模型复制 evidenceQuote。
2. 建立 request-local Entity Handles（C/R/T/F/P/A），模型不再看到或生成数据库 ID；新实体只允许 N1/N2 之类 payload-local key。
3. LLM 顶层只输出 chapters + brief/events/keywords/observations，取消 Summary↔Structured Patch 双写；chapterSummary 的 characterChanges/relationshipChanges/mainlineChanges/newThreads/resolvedThreads 全部由本地 Observation Compiler 派生。
4. Observation Compiler 必须 deterministic 地编译为现有 StoryMemoryBatchPatchDraft schemaVersion=2，之后复用现有 Merger/CAS/DB；单条 invalid evidence/ref/kind/op 必须局部 drop+warning，不能让整个 Batch 作废。
5. Input 继续复用现有 `allocateElasticStageContextBudget()`，但状态材料改为紧凑文本和 whole-item packing，禁止 serialized JSON 字符级 clipping；final input >Burst 必须继续 shrink 或 split，不能直接靠近 Hard 发送。
6. Story Memory Output 改为 bounded extraction reservation，不再使用 1M→200K 的写作型 reservation；先按方案的 1章8192/2章14336/3章20480 实现并用真实 fixture 校准。
7. Primary/Formatter/Fresh Retry 使用同一 frozen model config、anchors、handles；Formatter 只接 candidate+最小 schema+合法 handle/anchor 列表，不得重新注入章节正文和 Previous State；每 logical child batch 真实 HTTP 总数仍 <=3。
8. Checkpoint、single chapter patch、full rebuild、legacy bootstrap 的所有新 LLM 请求最终必须统一走 Protocol V2；旧 storyMemoryPrompts/MainlineReconciler 仅作为 legacy compatibility，不能继续作为生产主路径。
9. 不升 Schema 50，除非出现无法用现有持久结构表达的明确硬阻塞；不得推进 P2、不得扩大 Batch>3、不得修改大纲 Pipeline/Continuation/Canon。
10. 删除远端 HEAD 中误提交的根目录 `--out` QA 文件，并防止再次误入仓库。

完成后必须进行专项单元/集成测试、100/300/1000章长篇压力测试、`npm run verify`，并构建最终 Debug APK 对现有 App 执行 `adb install -r` 覆盖升级，禁止 uninstall/pm clear，保留原有 DeepSeek/LLM/API Key/项目/章节/Story Memory/ledger 做真实穿测。真实 Gate 至少包括：普通三章、原复杂长篇失败 Fixture、Evidence Anchor、invalid observation 局部降级、invalid JSON Formatter、Fresh Retry、64K小窗口 whole-item compact+3→2→1、force-stop outcome_unknown 恢复、连续两轮 automatic maintenance、Home/锁屏后台运行。

全部 Gate 通过前不得升版、不得宣称 GO。通过后按 Release 指南升 V2.11.45，构建正式 APK，并生成 `docs/optimization/Story-Memory-Protocol-V2-Final-Verification-YYYYMMDD.md`，逐项给出真实证据和最终 GO/NO-GO。
```
