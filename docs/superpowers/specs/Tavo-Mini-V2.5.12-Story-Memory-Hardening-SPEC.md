# Tavo Mini V2.5.12 故事记忆召回补漏与防回归 SPEC

> 仓库：`F:\ClaudeWorkSpace\projects\TAVO-MINI`  
> 当前基线：V2.5.11  
> 建议目标版本：V2.5.12  
> 施工原则：一次性补漏、统一根因、建立防回归门禁，不再按单点症状连续打补丁  
> 适用模块：Checkpoint、Pending Bridge、Seam、Story Memory Renderer、Episodic Retrieval、版本与发布文档

---

## 1. 背景

V2.5.8～V2.5.11 已完成长篇故事记忆召回的主要建设：

- 高密度章节摘要；
- Checkpoint + Pending Bridge + Seam；
- 中文 n-gram TF-IDF；
- 用户写作要求和上一章结尾进入查询；
- Story Memory 人物、别名、物品、线索加权；
- 人物组合奖励；
- 混合 Top-K；
- Token 安全预算；
- Dirty 状态隔离；
- 歧义别名；
- Story Memory 人物关系优先；
- 空 IDF 回退；
- 真实 GitHub Actions 验证。

继续验收后发现，剩余问题不再是单个功能缺失，而是若干跨模块契约尚未完全统一：

1. Checkpoint 是否适用于目标章节，缺少唯一判断入口；
2. 人物统一命名空间只覆盖查询解析，候选摘要仍使用简单字符串匹配；
3. 人物 ID 与姓名之间仍通过平行数组间接恢复；
4. Story Memory 人物关系虽已提前，但多相关人物时仍可能把关系挤出预算；
5. 测试存在“看似覆盖、实际没有进入目标分支”的情况；
6. 版本号在多个文件重复维护，容易再次不一致。

本 SPEC 的核心不是继续增加条件判断，而是把这些重复逻辑收敛成少量唯一入口，并用系统不变量、测试矩阵和发布门禁防止同类问题再次出现。

---

# 2. 本轮目标

一次性完成以下工作：

1. 禁止任何目标章节使用未来 Checkpoint；
2. 查询文本与候选摘要使用同一套人物实体解析器；
3. 人物激活、匹配、去重和组合奖励全程使用 `characterId`；
4. 删除依赖平行数组位置恢复 ID—姓名映射的设计；
5. 为当前相关人物关系建立确定性的预算保障；
6. 补齐真实空查询和跨路径契约测试；
7. 建立版本元数据一致性自动门禁；
8. 建立可长期执行的“故事记忆系统不变量测试集”；
9. 保持现有 API 次数、数据库 Schema、备份格式和主体架构不变。

---

# 3. 非目标与禁止事项

本轮不得引入：

- Embedding；
- 向量数据库；
- 第二模型；
- LLM rerank；
- 新远程 API；
- 新事件数据库；
- 新数据库 Schema；
- 多 Agent 运行时；
- 大规模 UI 重构；
- 与故事记忆无关的代码清理；
- 为了测试方便而改变生产逻辑语义；
- 隐式吞掉覆盖缺口后继续生成。

明确不处理但必须在文档中保留的项目级风险：

- Android 16KB page-size 原生库对齐；
- ARM64 真机专项验收；
- 本地 GGUF 长上下文专项验收；
- 进程强杀后 `rebuilding` 恢复；
- 中文 IME 全链路录制。

不得将以上项目级风险误写为本轮已解决。

---

# 4. 设计总原则

## 4.1 单一事实来源

以下判断必须分别只有一个生产入口：

| 领域 | 唯一入口 |
| --- | --- |
| Checkpoint 是否可用于目标章节 | `resolveUsableCheckpointForTarget()` |
| 文本中出现了哪些人物 | `resolveCharacterMentionsInText()` |
| 当前查询激活哪些人物 | 复用 `resolveCharacterMentionsInText()` |
| 候选摘要出现哪些人物 | 复用 `resolveCharacterMentionsInText()` |
| Episodic Token 预算 | `selectCandidatesWithinTokenBudget()` |
| Story Memory Token 预算 | Renderer 内统一预算分配器 |
| 应用版本号 | `src/constants/version.json` 或单一版本源生成 |

不得在不同模块复制状态判断、人物匹配或 Token 截断规则。

## 4.2 显式数据优先于位置推断

禁止使用两个数组的相同索引推断实体对应关系，例如：

```ts
activeCharacterIds[index] -> activeCharacterNames[index]
```

必须使用显式映射或结构化对象。

## 4.3 所有降级路径保持同一安全契约

正常路径、空查询、legacy、IDF 空、Checkpoint 不可用、数据库异常等路径可以改变召回策略，但必须保持：

- 不使用未来状态；
- 不使用 Dirty 状态；
- 不超过预算；
- 不增加远程 API；
- 不阻止安全回退；
- 覆盖不足时不虚构连续性。

## 4.4 测试验证实际分支，而不是只验证结果

测试必须证明目标分支真的执行，例如：

- 空查询测试必须保证标题、概要、正文和显式 query 都为空；
- legacy 测试必须证明开关已进入 legacy 分支；
- 空 IDF 测试必须证明实际传入 `idf.size === 0`；
- 未来 Checkpoint 测试必须证明目标章节位置小于或等于 Checkpoint through。

允许增加可测试的纯函数，但不得为了测试引入生产环境全局状态。

---

# 5. 修复一：目标章节感知的 Checkpoint 可用性

## 5.1 问题

当前 Checkpoint 通常只检查状态是否 clean，没有统一检查：

```ts
checkpoint.state.throughChapterPosition < currentChapter.position
```

当用户回到旧章节生成时，可能注入未来章节形成的人物状态、秘密、关系和物品变化。

这属于时间穿越污染，严重程度高于普通召回偏差。

## 5.2 新增唯一入口

建议新增：

```text
src/services/storyMemory/storyMemoryCheckpointEligibility.ts
```

接口：

```ts
export interface CheckpointEligibilityResult {
  usable: boolean;
  reason:
    | 'usable'
    | 'missing'
    | 'not_clean'
    | 'empty_state'
    | 'future_or_same_position'
    | 'invalid_position';
  checkpoint: ProjectStoryMemoryRecord | null;
}

export function resolveUsableCheckpointForTarget(
  checkpoint: ProjectStoryMemoryRecord | null,
  targetChapterPosition: number,
): CheckpointEligibilityResult
```

## 5.3 判定规则

只有同时满足以下条件才可用：

```ts
checkpoint !== null
checkpoint.status === 'clean'
checkpoint.state exists
Number.isInteger(checkpoint.state.throughChapterPosition)
checkpoint.state.throughChapterPosition >= 0
checkpoint.state.throughChapterPosition < targetChapterPosition
```

以下情况均不可用：

```text
missing
dirty
empty
failed
rebuilding
状态不可解析
through < 0
through >= targetChapterPosition
```

## 5.4 所有调用方必须复用

至少修改：

```text
src/services/contextBuilder.ts
src/services/storyMemory/storyMemoryPrepare.ts
```

并检查其他直接使用 Checkpoint 的生成和预览入口。

必须统一用于：

- Story Memory Renderer 注入；
- Episodic 实体加权；
- Coverage 规划起点；
- preview；
- generation；
- hardDue 失败回退；
- Checkpoint 刷新后的重新规划。

不得再出现：

```ts
record.status === 'clean'
```

后直接使用状态而不检查目标章节位置。

## 5.5 不可用时的处理

当 Checkpoint 位于目标章节之后或等于目标章节：

```text
checkpointThroughPosition = -1
storyStateForRetrieval = null
不注入 Story Memory
重新规划目标章节之前的 raw / episodic 覆盖
```

如果覆盖不足：

- generation 必须阻止并给出明确错误；
- preview 必须明确显示覆盖不足；
- 不得使用未来 Checkpoint 兜底。

## 5.6 不要求本轮实现历史快照数据库

如果当前数据库只保留最新 Checkpoint，本轮不新增 Schema 保存多历史快照。

但代码结构必须允许未来提供：

```ts
getLatestCheckpointBeforePosition(projectId, targetPosition)
```

当前无历史快照时按 `-1` 规划即可。

---

# 6. 修复二：查询和候选摘要共用人物解析器

## 6.1 问题

查询侧已有：

- canonical 与 alias 统一命名空间；
- ASCII 大小写归一；
- 歧义词；
- 最长词优先；
- 区间占用；
- characterId 激活。

但候选摘要评分、人物历史桶和组合奖励仍依赖简单字符串包含。

这会导致：

- 查询用正式姓名，摘要用别名时漏召回；
- 查询用别名 A，摘要用同人物别名 B 时漏召回；
- 单字姓名在长姓名中误命中；
- 歧义词在候选摘要中错误触发；
- 人物组合奖励与查询解析规则不一致。

## 6.2 新增通用解析结果

在：

```text
src/services/episodicMemoryRetriever.ts
```

或独立：

```text
src/services/storyMemory/characterMentionResolver.ts
```

新增：

```ts
export interface CharacterMention {
  characterId: string;
  canonicalName: string;
  matchedTerm: string;
  normalizedTerm: string;
  type: 'canonical' | 'alias';
  start: number;
  end: number;
}

export interface CharacterMentionResolution {
  characterIds: string[];
  mentions: CharacterMention[];
  canonicalNameByCharacterId: Record<string, string>;
  ambiguousTermsEncountered: string[];
}

export function resolveCharacterMentionsInText(
  text: string,
  terms: StoryRetrievalTerms,
): CharacterMentionResolution
```

## 6.3 解析规则

必须和当前统一命名空间保持一致：

1. ASCII 标准化为小写；
2. canonical 和 alias 进入同一命名空间；
3. 多 characterId 共享的词为歧义词，不激活；
4. 所有唯一人物词按长度降序匹配；
5. 长词占用区间后，重叠短词不得再激活；
6. 同一人物多个词命中时人物 ID 只出现一次；
7. 可以保留多个 mention 用于调试，但奖励按人物 ID 去重；
8. 不使用编辑距离；
9. 不调用 API；
10. 解析异常返回空结果，不阻止生成。

## 6.4 查询侧改造

`findActiveStoryTerms()` 不再维护独立的人物匹配算法，应调用：

```ts
resolveCharacterMentionsInText(queryText, terms)
```

再补充物品和线索识别。

## 6.5 候选摘要侧改造

每个候选摘要调用同一个解析器，得到：

```ts
candidateCharacterIds
```

随后使用集合交集：

```ts
matchedCharacterIds =
  activeCharacterIds ∩ candidateCharacterIds
```

用于：

- 人物姓名/别名奖励；
- `matchedCharacters`；
- 人物组合奖励；
- character history bucket；
- 当前人物计数；
- pair boost。

## 6.6 跨别名召回

以下必须有效：

```text
人物：林岚
aliases：小岚、岚姐
```

| 查询 | 摘要 | 结果 |
| --- | --- | --- |
| 林岚追问钥匙 | 小岚交出钥匙 | 同一人物命中 |
| 小岚追问钥匙 | 岚姐交出钥匙 | 同一人物命中 |
| 岚姐追问钥匙 | 林岚交出钥匙 | 同一人物命中 |

人物奖励类型可按查询激活来源决定，但人物身份必须通过 ID 统一。

## 6.7 性能要求

不得对每个候选重新构建 Story Retrieval Terms。

必须：

```text
单次检索 collect terms 一次
查询解析一次
每个候选只做文本解析
```

300 章场景仍保持近似 O(N × M)，其中 M 为受控的人物词数量。

如需优化，可预先编译有序词表，但不得引入全局可变缓存。

---

# 7. 修复三：移除平行数组 ID—姓名映射

## 7.1 问题

当前仍可能通过：

```ts
activeCharacterIds[index]
activeCharacterNames[index]
```

恢复 ID—姓名映射。

当多个人物正式姓名相同，姓名数组去重后会破坏位置对应关系。

## 7.2 修改结构

`ActiveStoryTerms` 改为显式结构：

```ts
export interface ActiveCharacter {
  characterId: string;
  canonicalName: string;
  activatedBy: 'canonical' | 'alias';
  matchedTerm: string;
}

export interface ActiveStoryTerms {
  activeCharacters: ActiveCharacter[];
  activeCharacterIds: string[];
  canonicalNameByCharacterId: Record<string, string>;
  canonicalCharacterNames: string[];
  aliases: string[];
  objectTerms: string[];
  threadTerms: string[];
  aliasHits: Array<{
    alias: string;
    canonicalName: string;
    characterId: string;
  }>;
}
```

兼容字段可暂时保留，但生产评分逻辑必须只依赖：

```ts
activeCharacters
canonicalNameByCharacterId
```

## 7.3 删除间接恢复

删除或停止使用：

```ts
buildActiveIdToCanonical()
```

不得再通过数组长度、索引或首个姓名兜底。

## 7.4 重复姓名支持

以下情况必须稳定：

```text
char_reporter canonical=李明 alias=记者
char_doctor canonical=李明 alias=医生
char_wang canonical=王芳
```

查询：

```text
记者和医生去找王芳
```

必须激活三个不同 ID，姓名映射分别正确，人物组合奖励按 ID 计算。

---

# 8. 修复四：人物关系预算保障

## 8.1 问题

当前顺序是：

```text
所有当前相关人物
→ 当前相关人物之间的关系
```

当用户要求同时出现大量人物时，相关人物卡本身仍可能占满预算，关键关系无法进入。

## 8.2 设计目标

Story Memory Renderer 必须保证：

- 最关键的当前关系不会被所有人物卡挤掉；
- 关系双方人物卡优先；
- 不相关人物不能抢占关键关系预算；
- 最终仍严格不超预算。

## 8.3 推荐分配策略

### 第一步：确定关系优先级

关系评分建议：

```text
双方均为当前人物：最高
一方为当前人物：次高
lastChangedPosition 更新：次序依据
关系 ID：稳定兜底
```

### 第二步：形成优先单元

将高优先关系视为一个关系单元：

```ts
interface RelationshipBundle {
  relationshipId: string;
  requiredCharacterIds: string[];
  relationshipLine: string;
}
```

### 第三步：预算顺序

推荐：

```text
1. 最高优先关系的双方人物卡
2. 最高优先关系
3. 其他高优先关系需要补充的人物卡
4. 其他高优先关系
5. 剩余当前人物
6. 其他最近人物
7. 其他关系
8. 主线条目
```

不得先加入全部当前人物。

## 8.4 原子加入建议

对关系 bundle 尝试整体加入：

```text
缺失的人物卡 + 关系行
```

只有整体能放入时才加入，避免只加入人物却没有关系。

如果完整人物卡过长，可考虑使用已有简版人物行，但本轮不得新增复杂多级 Renderer。优先采用“能放则整体放，不能放则尝试下一关系”。

## 8.5 测试场景

构造：

- 8 名人物全部在用户要求中出现；
- 其中林岚—周恪关系最近且关键；
- 其他人物关系较旧；
- 预算只能容纳约 3 张人物卡和 1 条关系。

必须：

```text
包含林岚
包含周恪
包含 rel_lan_zhou
不超预算
```

---

# 9. 修复五：真实空查询测试与路径证明

## 9.1 空查询定义

只有以下全部为空才算真正空查询：

```text
options.queryText
currentChapter.title
currentChapter.synopsis
currentChapter.content
previousChapter tail
retrievalUserPrompt
```

## 9.2 必须新增测试

创建完全空的当前章节：

```ts
title: ''
synopsis: ''
content: ''
```

显式传入：

```ts
queryText: ''
```

断言：

- 进入空查询最近摘要分支；
- 最近摘要优先；
- 预算 1/5/10 不超限；
- 最终展示按时间顺序；
- 不调用 Story Memory 实体匹配。

## 9.3 分支可观测性

推荐新增纯函数：

```ts
export function resolveEpisodicRetrievalMode(...):
  | 'v2_query'
  | 'empty_query_recent'
  | 'legacy'
  | 'empty_idf_recent'
```

或在测试中 spy 目标函数。

不得新增生产日志噪音或 UI。

---

# 10. 修复六：版本元数据单一来源与自动校验

## 10.1 当前问题

版本存在于：

- `package.json`
- `package-lock.json`
- `src/constants/version.json`
- README 中文摘要
- README 英文摘要
- APK 元数据
- 发布文档

人工同步容易遗漏。

## 10.2 单一版本源

建议以：

```text
src/constants/version.json
```

为发布版本源，至少包含：

```json
{
  "versionName": "V2.5.12",
  "versionCode": 2051200,
  "releaseTitle": "ShineWriter V2.5.12"
}
```

构建脚本负责生成或校验其他机器字段。

## 10.3 新增校验脚本

新增：

```text
scripts/check-version-consistency.js
```

检查：

1. `package.json.version === 2.5.12`
2. `package-lock.json.version === 2.5.12`
3. `package-lock.json.packages[""].version === 2.5.12`
4. `version.json.versionName === V2.5.12`
5. README 中文“当前版本”包含 V2.5.12
6. README English summary 包含 V2.5.12
7. CHANGELOG 顶部版本为 V2.5.12
8. 版本号与 `versionCode` 规则一致

失败必须 exit 1。

加入：

```json
"verify:version": "node scripts/check-version-consistency.js"
```

并让：

```text
npm run verify
```

包含版本一致性检查。

## 10.4 发布时更新 lockfile

执行：

```bash
npm install --package-lock-only
```

不得手工只改 lockfile 某一处。

---

# 11. 防止“修 A 冒 B”的系统不变量

新增专门测试文件：

```text
__tests__/storyMemorySystemInvariants.test.ts
```

以下不变量必须长期保留。

## 11.1 时间不变量

```text
任何注入或实体加权使用的 Checkpoint through
必须严格小于目标章节 position。
```

覆盖：

- 当前章之后；
- 当前章相同位置；
- 当前章之前；
- 第 0 章；
- 回写旧章节；
- preview；
- generation；
- hardDue 成功/失败。

## 11.2 状态不变量

以下状态永远不能注入或加权：

```text
dirty
empty
failed
rebuilding
missing
invalid
```

## 11.3 人物身份不变量

```text
人物身份以 characterId 为准；
姓名和别名只作为文本表面形式。
```

必须覆盖：

- 重名；
- 多别名；
- alias 与 canonical 冲突；
- 英文大小写；
- 长短姓名包含；
- 共用称呼；
- 同一人物多个词同时命中。

## 11.4 查询—候选一致性不变量

同一文本解析器必须同时用于：

```text
query
candidate memory summary
Story Memory relevance scan
```

不能出现三套不同人物匹配规则。

## 11.5 Token 不变量

任何记忆上下文函数返回后：

```ts
estimateTokens(result) <= budgetTokens
```

适用：

- Episodic V2；
- 空查询；
- legacy；
- 空 IDF；
- Story Memory；
- 极小预算；
- 超长标题；
- 超长人物卡；
- 超长主线条目。

## 11.6 连续性不变量

每个 Pending 章节必须属于且只属于：

```text
raw
episodicFallback
uncovered
```

不得重复、遗漏或虚构覆盖。

## 11.7 API 不变量

以下情况不得新增远程 API：

- 普通召回；
- 空查询；
- 空 IDF；
- preview；
- Dirty 回退；
- 未来 Checkpoint 回退；
- 候选人物解析。

---

# 12. 路径矩阵测试

建立参数化矩阵，不要只写单个示例。

## 12.1 Checkpoint 矩阵

| status | through vs target | 可注入 | 可实体加权 | coverage 起点 |
| --- | --- | --- | --- | --- |
| clean | `< target` | 是 | 是 | through |
| clean | `= target` | 否 | 否 | -1 |
| clean | `> target` | 否 | 否 | -1 |
| dirty | 任意 | 否 | 否 | -1 |
| empty | 任意 | 否 | 否 | -1 |
| failed | 任意 | 否 | 否 | -1 |
| rebuilding | 任意 | 否 | 否 | -1 |

## 12.2 人物匹配矩阵

| 查询 | 候选摘要 | 期望 |
| --- | --- | --- |
| 林岚 | 林岚 | 命中同 ID |
| 林岚 | 小岚 | 命中同 ID |
| 小岚 | 岚姐 | 命中同 ID |
| 林岚 | 仅包含林 | 不命中林岚 |
| 林 | 林岚 | 不命中林 |
| 队长（歧义） | 队长 | 不激活 |
| Captain（多 owner） | captain | 不激活 |
| 记者、医生、王芳 | 对应三个 ID | 三 ID 正确 |

## 12.3 Token 矩阵

预算：

```text
0
1
5
10
刚好等于前缀
前缀+1
普通预算
超大预算
```

输入：

```text
短摘要
超长摘要
超长标题
多个候选
大量人物
大量关系
大量主线条目
```

所有组合至少覆盖代表性参数化测试。

---

# 13. 反例与随机化测试

不要求引入新的 property-testing 依赖。

使用固定种子生成测试数据：

```text
10、50、100 个人物
每人 0～4 个别名
部分重名
部分大小写冲突
部分长短姓名
100～300 章摘要
```

至少验证：

- 不抛异常；
- 结果确定；
- 同一输入多次输出一致；
- 无重复人物 ID；
- 无歧义人物激活；
- Token 不超限；
- 运行时间在软阈值内。

测试随机数据必须使用固定 seed，避免 CI 不稳定。

---

# 14. 模块边界与代码约束

## 14.1 禁止新增重复逻辑

代码审查时搜索以下模式：

```text
record.status === 'clean'
includesInsensitive(doc.text, canonicalName)
activeCharacterIds[index]
activeCharacterNames[index]
clipTextToTokenBudget(line
```

若这些模式用于重复实现核心规则，必须改为调用统一入口。

并非禁止所有字符串 includes，而是禁止用它独立判断人物身份。

## 14.2 纯函数优先

以下应保持纯函数：

- Checkpoint eligibility；
- 人物词收集；
- 人物文本解析；
- 候选评分；
- Top-K；
- Token 预算；
- Renderer 选择顺序；
- 版本一致性解析。

数据库与 UI 只负责提供输入和使用结果。

## 14.3 无隐式 fallback

禁止：

```text
映射失败时拿第一个姓名
状态不明确时默认可用
预算失败后返回未校验文本
覆盖不足时继续生成
```

必须返回明确的不可用、空结果或阻塞原因。

---

# 15. 测试与质量门禁

必须执行：

```bash
npm run lint
npm run typecheck
npm run test:ci
npm run test:coverage
npm run verify:version
npm run verify
```

建议 `verify` 定义为：

```text
lint
→ typecheck
→ verify:version
→ test:ci
```

必须保证：

- 新测试不是只断言字符串存在；
- 关键测试断言具体 ID、具体路径和 Token；
- 不使用 `--forceExit`；
- 无 open handles；
- 不降低覆盖率阈值；
- 不删除原有回归测试来让门禁通过。

---

# 16. 性能门禁

重新测试：

```text
30 章
100 章
300 章
```

并增加人物规模：

```text
10 人
50 人
100 人
```

记录：

- Story terms 收集；
- query mention resolve；
- candidate mention resolve；
- scoring；
- mixed Top-K；
- Episodic budget；
- Story Memory render；
- 总召回时间；
- IDF cache hit。

要求：

- 300 章总召回继续低于现有软阈值；
- 人物解析不得出现明显平方级爆炸；
- 单次检索不重复收集 Story terms；
- 不在 Android UI 线程新增高成本同步数据库或网络工作。

---

# 17. 版本与发布

建议目标：

```text
V2.5.12
versionCode 2051200
```

更新：

```text
src/constants/version.json
package.json
package-lock.json
CHANGELOG.md
README.md
docs/optimization/progress.md
docs/V2.5.12-STORY-MEMORY-HARDENING-REPORT.md
```

README 必须同步：

- 顶部版本；
- 中文当前版本；
- English summary；
- 当前 CI Run；
- 已知限制。

---

# 18. Android 与发布验收

完成：

- 安装 Release APK；
- 版本号正确；
- 项目页、章节编辑页、上下文预览可达；
- 创建至少 12 章测试项目；
- 在较后章节形成 clean Checkpoint；
- 返回较早章节预览/生成，确认未来 Checkpoint 不注入；
- 写作要求使用正式姓名，历史摘要使用别名，确认正确召回；
- 多人物要求下关键关系仍进入 Story Memory；
- 无 AndroidRuntime FATAL。

正式 APK：

```text
dist/apk/release/ShineWriter-V2.5.12-release.apk
```

校验：

- SHA-256；
- 正式证书；
- APK Signature Scheme；
- zipalign；
- aapt versionName/versionCode。

---

# 19. GitHub Actions 证明

发布提交推送后必须运行真实 Verify。

施工报告记录：

- Release commit SHA；
- Run ID；
- workflow head_sha；
- JavaScript validation；
- Android Debug build；
- Migration matrix；
- 结论。

文档 pin 提交可以晚于发布提交，但必须明确：

```text
CI 验证的是 release commit，不是 docs pin commit。
```

---

# 20. 完成定义

只有全部满足才可交付：

- [ ] 未来或同位置 Checkpoint 不注入、不加权；
- [ ] 所有 Checkpoint 调用方复用唯一 eligibility 函数；
- [ ] 查询和候选摘要使用同一人物解析器；
- [ ] 跨别名召回正常；
- [ ] 重名人物按 ID 正确；
- [ ] 不存在平行数组位置恢复映射；
- [ ] 多相关人物下关键关系仍能进入；
- [ ] 真正空查询测试覆盖目标分支；
- [ ] 空查询/legacy/空 IDF/正常 V2 均不超预算；
- [ ] Story Memory 不超预算；
- [ ] 系统不变量测试全部通过；
- [ ] 30/100/300 章和 10/50/100 人性能通过；
- [ ] 版本一致性脚本通过；
- [ ] package-lock 与 package.json 同步；
- [ ] README 中英文版本一致；
- [ ] Schema、备份和 API 次数不变；
- [ ] 模拟器旧章节回写场景通过；
- [ ] 真实 GitHub Actions 对应 release commit；
- [ ] Release APK 校验通过；
- [ ] 报告明确区分本轮已解决与项目级未解决风险。

---

# 21. Agent 施工纪律

开始前：

```bash
git status
git branch --show-current
git log -5 --oneline
git diff
git fetch origin
```

要求：

- 基于最新远端 `main`；
- 不覆盖用户未提交文件；
- 不修改无关模块；
- 不删除原有 SPEC；
- 不通过降低测试标准完成交付；
- 每项生产逻辑必须有对应测试；
- 每个统一入口必须替换旧重复实现；
- 修复后搜索仓库确认不存在遗漏调用点；
- 最后进行一次“反例审查”，不能只报告测试通过。

反例审查至少回答：

1. 目标章节比 Checkpoint 更早会怎样？
2. 查询和摘要使用不同别名会怎样？
3. 两个人同名会怎样？
4. 一个名字是另一个名字子串会怎样？
5. 10 个当前人物同时出现会怎样？
6. Token 预算只有 1 或 10 会怎样？
7. IDF 为空会怎样？
8. 状态为 Dirty/failed/rebuilding 会怎样？
9. preview 是否调用 LLM？
10. 版本号是否在所有文件一致？

---

# 22. 最终施工报告

报告必须包含：

1. 基线和最终提交；
2. 修改文件；
3. 六项补漏实现；
4. 被删除或统一的重复逻辑；
5. 系统不变量列表；
6. 路径矩阵测试结果；
7. 反例和固定种子测试；
8. 30/100/300 章与人物规模性能；
9. 门禁命令；
10. API 次数；
11. Schema、备份、Checkpoint、Bridge、Seam、Dirty 回归；
12. 模拟器旧章节回写测试；
13. 版本一致性结果；
14. GitHub Actions Run；
15. APK 信息；
16. 仍然存在但明确不在本轮范围的项目级风险；
17. 是否还存在任何已知的故事记忆时间污染、人物识别或预算问题。

不得使用“理论上”“应该”“大概率”等措辞代替测试结果。
