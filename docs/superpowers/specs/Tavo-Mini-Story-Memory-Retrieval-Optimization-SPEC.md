# Tavo Mini 长篇故事记忆召回优化建设方案 SPEC

> 目标版本：V2.5.8（如仓库版本已前移，由执行 Agent 顺延一个补丁版本）  
> 文档状态：可执行  
> 实施方式：一次性完成改造、测试与发布  
> 适用仓库：`anjingdtl/tavo-mini`  
> 适用前提：仅接入单一 API LLM，不使用本地模型、不增加 Embedding API、不新增第二套模型配置

---

## 1. 背景

Tavo Mini 当前已经具备以下故事记忆链路：

1. 章节定稿后生成 `memory_summary`；
2. 按检查点策略整理长期故事状态；
3. 新章节生成前注入：
   - 长期 Story Memory Checkpoint；
   - Pending Bridge / Seam；
   - 基于章节 `memory_summary` 的 Episodic TF-IDF Top-K；
   - 最近章节正文；
4. 通过单一 API LLM 生成正文。

当前架构已解决检查点过期、旧章节修改后复用旧批次等可靠性问题，但长篇实测仍可能遗漏较早章节中的人物行为和互动细节，例如：

- 某人物曾经对另一人物做过什么；
- 谁向谁作出过承诺；
- 谁隐瞒、欺骗、救援、拒绝或背叛过谁；
- 某件物品曾由谁交给谁；
- 人物关系和信任发生变化的原因；
- 较早章节留下但尚未解决的误会、冲突和约定。

本轮不进行大型故事记忆架构升级，不新增复杂事件系统，只在现有框架上强化：

- 章节摘要的信息密度；
- 当前写作意图形成的检索查询；
- 中文 TF-IDF 分词；
- 人物、物品和人物组合的召回权重；
- Top-K 结果的组成；
- 长期关系信息的可读性。

---

## 2. 建设目标

### 2.1 核心目标

在不增加正常章节生成前 API 调用次数的前提下，提高历史章节事件召回的准确性，重点改善：

1. 人物行为召回；
2. 人物之间交互行为召回；
3. 重要物品流转召回；
4. 承诺、欺骗、秘密、冲突等历史因果召回；
5. 当前章节对较早剧情的回溯能力。

### 2.2 性能目标

普通续写流程必须继续保持：

```text
本地构建上下文
→ 一次正文生成 API 请求
```

本轮不得增加：

- 生成前 LLM 查询扩展；
- 生成前 LLM 重排；
- Embedding API；
- 第二次正文前分析请求；
- 新的远程检索服务。

目标指标：

| 指标 | 目标 |
|---|---:|
| 普通章节正文 API 调用次数 | 保持 1 次 |
| 章节定稿摘要 API 调用次数 | 保持现状 |
| 新增远程 API 调用 | 0 |
| 本地历史摘要检索耗时增幅 | 尽量控制在 100ms 内 |
| 上下文总 Token 明显膨胀 | 不允许 |
| 原有 Story Memory / Dirty rebuild 行为 | 不得破坏 |

---

## 3. 实施边界

### 3.1 本轮必须实施

1. 强化 `memory_summary` 提示词；
2. 将默认记忆摘要目标长度从约 200 字提升到约 300 字；
3. Episodic 检索查询加入用户本次写作要求；
4. Episodic 检索查询加入上一章正文结尾；
5. 中文 tokenizer 增加双字、三字 n-gram；
6. 保留原有单字 Token，确保兼容；
7. 基于现有 Story Memory 识别当前查询中的人物、别名、物品和线索；
8. 在 TF-IDF 基础分上增加实体命中奖励；
9. 增加两名及以上当前相关人物共同出现的“人物组合奖励”；
10. 将 Top-K 改为“相关度 + 当前人物历史 + 最近章节”混合选择；
11. Story Memory 关系渲染使用“人物姓名 + ID”，不再只显示内部 ID；
12. 补齐单元测试、集成测试和回归测试；
13. 一次性完成版本、CHANGELOG、README 或相关进度文档更新。

### 3.2 本轮明确不实施

以下内容禁止纳入本次改造：

- 新增事件数据库表；
- 修改数据库 Schema；
- 引入向量数据库；
- 引入 Embedding API；
- 接入第二个 LLM；
- 新增生成前 LLM 检索调用；
- 新增 LLM rerank；
- 新增生成后连续性检查 API；
- 重写 Story Memory Checkpoint 架构；
- 修改 Checkpoint 默认三章策略；
- 修改 Dirty rebuild 主逻辑；
- 修改 Pending Bridge / Seam 的覆盖策略；
- 引入 Jieba、HanLP 等大型中文分词依赖；
- 大规模重构 `contextBuilder.ts`；
- 改动与本次召回优化无关的 UI、备份、TTS、模型配置和流水线功能。

---

## 4. 当前流程与目标流程

### 4.1 当前流程

```text
章节定稿
→ API 生成约 200 字 memory_summary
→ 每 3 章 Checkpoint
→ 新章节生成前：
   Checkpoint
   + memory_summary TF-IDF Top-K
   + Pending Bridge / Seam
   + 最近正文
→ 单一 API LLM 生成正文
```

### 4.2 优化后流程

```text
章节定稿
→ 同一次 API 调用生成约 300 字、更适合检索的 memory_summary
→ Checkpoint 机制保持不变
→ 新章节生成前：
   1. 使用标题、概要、用户写作要求、当前正文、上一章结尾构建查询
   2. 本地识别已知人物、别名、持有物和开放线索
   3. 中文单字 + 双字 + 三字 TF-IDF
   4. TF-IDF 基础分 + 实体命中奖励 + 人物组合奖励
   5. 混合选择 Top-K
   6. 注入现有上下文
→ 单一 API LLM 生成正文
```

远程调用次数不变。

---

## 5. 详细设计

# 5.1 强化章节记忆摘要

## 5.1.1 修改文件

```text
src/services/summaryGenerator.ts
```

重点修改：

```ts
generateMemorySummary(chapterId: number, targetChars = 200)
```

建议调整为：

```ts
generateMemorySummary(chapterId: number, targetChars = 300)
```

调用方如果显式传入 `targetChars`，继续尊重调用方参数，不得强制覆盖。

## 5.1.2 新提示词要求

保持输出为普通文本，不改成 JSON，不新增解析器。

系统提示词应明确：

```text
你是长篇小说连续性记忆编辑。请生成一段高信息密度、适合后续章节检索的章节记忆摘要。不要续写，不要评价，不要输出 Markdown。
```

用户提示词必须包含以下要求：

```text
请用约 {targetChars} 字总结本章，供后续长篇小说检索和连续性保持使用。

必须优先保留：
1. 本章重要人物的完整姓名及必要别名；
2. 谁对谁做了什么，以及行为产生的结果；
3. 人物之间的重要对话、承诺、欺骗、冲突、合作、救援、拒绝或背叛；
4. 重要物品由谁获得、失去、使用或交给谁；
5. 人物新得知、误解、隐瞒或泄露的信息；
6. 人物关系、信任、态度、目标或立场的变化及原因；
7. 本章产生但尚未解决的线索、秘密、误会、承诺和矛盾；
8. 对后续剧情可能构成连续性约束的时间、地点和状态。

表达要求：
- 明确写出行为主体和对象；
- 尽量避免“二人”“他们”“双方”“有人”等模糊代词；
- 保留重要人名、地名、物品名和线索名；
- 不要只概括主线，不能遗漏会影响后续人物行为的关键互动；
- 不得添加正文中没有发生的事实。
```

## 5.1.3 输出长度控制

建议最大输出 Token 调整为：

```ts
Math.max(targetChars * 2, 700)
```

不得无限扩大输出。

## 5.1.4 兼容要求

- 保留 `memory_summary` 字段；
- 保留 `memory_summary_tokens` 更新；
- 保留原有调用场景标识；
- 保留摘要生成失败时的现有错误处理；
- 不新增数据库字段；
- 不改变章节定稿保存顺序；
- 不自动批量重写全部旧摘要。

如果项目已经存在手动重新生成记忆摘要的路径，该路径必须自动复用新提示词；不得新增强制全量迁移。

---

# 5.2 扩大 Episodic 检索查询

## 5.2.1 修改文件

```text
src/services/contextBuilder.ts
```

## 5.2.2 当前问题

现有查询主要依赖：

- 当前章节标题；
- 当前章节概要；
- 当前正文开头。

新章节刚创建时正文通常为空，标题和概要可能过于简略，无法准确召回旧人物互动。

## 5.2.3 新查询组成

新增纯函数：

```ts
interface EpisodicRetrievalQueryInput {
  currentChapter: Chapter;
  previousChapter?: Chapter | null;
  retrievalUserPrompt?: string;
}

function buildEpisodicRetrievalQuery(
  input: EpisodicRetrievalQueryInput,
): string
```

查询按以下顺序拼装：

```ts
const query = [
  currentChapter.title,
  currentChapter.synopsis,
  retrievalUserPrompt,
  currentChapter.content?.slice(0, 800),
  previousChapter?.content?.slice(-800),
]
  .filter(Boolean)
  .join('\n');
```

要求：

- `retrievalUserPrompt` 必须进入 Episodic 检索；
- 上一章必须是 `position < currentChapter.position` 中位置最大的有效章节；
- 上一章结尾最多 800 字；
- 当前正文最多取前 800 字；
- 不得把整章正文放入查询；
- 不得改变 Pending Bridge / Seam 的正文注入逻辑。

## 5.2.4 函数签名调整

现有：

```ts
buildMemoryContext(...)
buildMemoryContextWithIdf(...)
assembleMemoryContextFromIdf(...)
```

需增加可选查询参数，避免函数内部重复拼接旧查询。

建议：

```ts
interface MemoryRetrievalOptions {
  queryText?: string;
  storyState?: StoryMemoryState | null;
}

buildMemoryContext(
  previousChapters,
  currentChapter,
  topK,
  budgetTokens,
  options?: MemoryRetrievalOptions,
)

buildMemoryContextWithIdf(
  previousChapters,
  currentChapter,
  idf,
  topK,
  budgetTokens,
  options?: MemoryRetrievalOptions,
)
```

兼容要求：

- `options` 缺失时保留旧行为；
- 不得破坏现有测试调用；
- 不得将数据库查询下沉到纯排序函数；
- Story Memory 获取失败时仍可使用纯 TF-IDF。

---

# 5.3 中文 tokenizer 优化

## 5.3.1 修改范围

继续使用现有 tokenizer，不引入第三方中文分词库。

## 5.3.2 新规则

英文、数字、下划线词：

- 保留完整 Token；
- 转小写；
- 使用原有停用词过滤。

连续中文片段：

- 保留单字 Token；
- 增加相邻双字 Token；
- 增加相邻三字 Token；
- 不添加过长整句作为完整 Token；
- 过滤空字符；
- 保持确定性输出。

示例：

```text
林岚发现银钥匙
```

至少应产生：

```text
林
岚
发
现
银
钥
匙
林岚
岚发
发现
现银
银钥
钥匙
林岚发
岚发现
发现银
现银钥
银钥匙
```

## 5.3.3 建议实现

```ts
function tokenizeChineseRun(run: string): string[] {
  const chars = Array.from(run);
  const tokens: string[] = [];

  for (let index = 0; index < chars.length; index += 1) {
    tokens.push(chars[index]);

    if (index + 1 < chars.length) {
      tokens.push(chars[index] + chars[index + 1]);
    }

    if (index + 2 < chars.length) {
      tokens.push(
        chars[index] + chars[index + 1] + chars[index + 2],
      );
    }
  }

  return tokens;
}
```

主 tokenizer 应先将文本拆分为：

- 连续中文片段；
- 英文/数字/下划线片段。

## 5.3.4 性能约束

- 复杂度保持 O(n)；
- 不得生成四字及以上滑窗；
- 不得对全文做嵌套两两组合；
- 不得显著增加 IDF 构建耗时；
- 保留现有 IDF 缓存机制；
- 摘要修改后缓存签名失效逻辑必须继续有效。

---

# 5.4 从现有 Story Memory 获取实体词

## 5.4.1 数据来源

仅使用现有 `StoryMemoryState`：

### 人物词

```ts
character.canonicalName
character.aliases
```

### 物品词

```ts
character.currentState.possessions
```

### 线索词

```ts
state.mainline.openThreads[*].title
state.mainline.foreshadowing[*].setup
```

不得新增实体抽取 API。

## 5.4.2 新类型

```ts
interface StoryRetrievalTerms {
  canonicalCharacterNames: string[];
  aliases: string[];
  objectTerms: string[];
  threadTerms: string[];
}
```

新增纯函数：

```ts
function collectStoryRetrievalTerms(
  state?: StoryMemoryState | null,
): StoryRetrievalTerms
```

要求：

- 去重；
- trim；
- 过滤空字符串；
- 对过短或明显无意义的物品/线索词可跳过；
- 不修改 Story Memory；
- 不抛出异常；
- state 不可用时返回空数组。

## 5.4.3 当前相关实体识别

新增：

```ts
interface ActiveStoryTerms {
  canonicalCharacterNames: string[];
  aliases: string[];
  objectTerms: string[];
  threadTerms: string[];
}

function findActiveStoryTerms(
  queryText: string,
  terms: StoryRetrievalTerms,
): ActiveStoryTerms
```

规则：

- 使用大小写不敏感字符串包含匹配；
- 中文直接匹配；
- canonical name 和 alias 分开记录；
- 同一个人物的姓名和别名同时命中时，人物只计算一次主要奖励；
- 不进行模糊编辑距离；
- 不调用 API。

---

# 5.5 实体感知评分

## 5.5.1 基础分

保留现有：

```ts
cosineSimilarity(queryVector, documentVector)
```

## 5.5.2 新增最终分

新增候选类型：

```ts
interface ScoredMemoryCandidate {
  chapter: Chapter;
  text: string;
  cosineScore: number;
  entityBoost: number;
  pairBoost: number;
  finalScore: number;
  matchedCharacters: string[];
  matchedObjects: string[];
  matchedThreads: string[];
}
```

建议奖励常量：

```ts
const CHARACTER_NAME_BOOST = 0.22;
const CHARACTER_ALIAS_BOOST = 0.12;
const OBJECT_OR_THREAD_BOOST = 0.10;
const CHARACTER_PAIR_BOOST = 0.28;

const MAX_CHARACTER_BOOST = 0.44;
const MAX_ALIAS_BOOST = 0.24;
const MAX_OBJECT_THREAD_BOOST = 0.20;
```

最终分：

```ts
finalScore =
  cosineScore +
  characterNameBoost +
  aliasBoost +
  objectThreadBoost +
  pairBoost;
```

## 5.5.3 人物姓名奖励

只有同时满足时加分：

1. 查询中命中该人物；
2. 候选摘要中也出现该人物姓名。

每名人物增加 `CHARACTER_NAME_BOOST`，总额不超过 `MAX_CHARACTER_BOOST`。

## 5.5.4 别名奖励

只有当前查询使用别名，候选摘要也包含该别名或对应 canonical name 时加分。

总额不超过 `MAX_ALIAS_BOOST`。

## 5.5.5 物品和线索奖励

当前查询与候选摘要共同包含同一个：

- 持有物；
- 开放线索标题；
- 伏笔 setup；

每项增加 `OBJECT_OR_THREAD_BOOST`，总额不超过 `MAX_OBJECT_THREAD_BOOST`。

## 5.5.6 人物组合奖励

当：

- 当前查询命中至少两名已知人物；
- 同一候选摘要同时包含其中至少两名人物；

增加一次 `CHARACTER_PAIR_BOOST`。

不得按人物两两组合无限累计。

此奖励是本轮改善人物交互召回的关键。

## 5.5.7 排序稳定性

排序顺序：

1. `finalScore` 降序；
2. `cosineScore` 降序；
3. `chapter.position` 降序；
4. `chapter.id` 升序。

确保测试可重复。

---

# 5.6 Top-K 混合选择

## 5.6.1 目标

避免 Top-K 全部被主线相似摘要占满，同时确保：

- 高相关摘要；
- 当前人物历史；
- 最近剧情；

都能进入上下文。

## 5.6.2 选择策略

当 `topK >= 5` 时：

```text
相关度桶：约 60%
当前人物桶：约 20%
最近章节桶：剩余约 20%
```

推荐计算：

```ts
const semanticQuota = Math.max(1, Math.floor(topK * 0.6));
const characterQuota = Math.max(1, Math.floor(topK * 0.2));
const recentQuota = Math.max(
  1,
  topK - semanticQuota - characterQuota,
);
```

当 `topK < 5` 时：

- 直接按 `finalScore` 排序；
- 但至少保留一个最近章节候选；
- 去重后不足 `topK` 再按 `finalScore` 补齐。

## 5.6.3 相关度桶

- 按 `finalScore` 降序；
- 优先选择 `finalScore > 0`；
- 不因零分强行填满；
- 若有实体命中，即使 cosine 较低也可进入。

## 5.6.4 当前人物桶

候选摘要至少包含一个当前查询命中的 canonical character name 或对应 alias。

优先顺序：

1. 同时包含两名当前人物；
2. 包含一名当前人物；
3. `finalScore`；
4. 章节位置较新。

## 5.6.5 最近章节桶

按章节位置倒序选择最近有效 `memory_summary`。

不得选择：

- 当前章节；
- Pending Bridge 已作为 raw 正文注入并被现有逻辑排除的章节；
- 空摘要章节。

## 5.6.6 去重与补齐

按 `chapter.id` 去重。

选择顺序建议：

```ts
semanticBucket
→ characterBucket
→ recentBucket
→ remainingByFinalScore
```

最终：

```ts
selected.slice(0, topK)
```

## 5.6.7 输出顺序

选中后注入上下文时，建议按章节位置升序排列，以便模型按故事时间阅读。

评分只负责选择，不负责最终展示顺序。

---

# 5.7 Token 预算保持不变

继续使用：

```ts
episodicMemoryBudgetTokens
?? summaryBudgetTokens
?? 20000
```

本轮不得提高默认 Episodic 预算。

`memory_summary` 由约 200 字提升至约 300 字后，应由现有：

```ts
clipTextToTokenBudget()
```

继续控制总量。

要求：

- 选中摘要超过预算时按现有行为截取；
- 不得为了新算法扩大上下文窗口；
- 不得改变 Story State Budget；
- 不得改变 Pending Bridge Token 策略。

---

# 5.8 Story Memory 关系渲染优化

## 5.8.1 修改文件

```text
src/services/storyMemory/storyMemoryRenderer.ts
```

## 5.8.2 当前问题

关系信息使用内部 ID：

```text
char_lan ↔ char_other
```

对正文模型可读性不够。

## 5.8.3 新格式

新增辅助函数：

```ts
function characterLabel(
  state: StoryMemoryState,
  characterId: string,
): string
```

返回：

```text
林岚[char_lan]
```

人物不存在时回退：

```text
char_lan
```

关系行改为：

```text
- [rel_1] 林岚[char_lan] ↔ 周恪[char_other]：盟友；暂时合作；信任：medium；……
```

## 5.8.4 关系排序小幅优化

保留“最近变化优先”，但当关系任一人物在当前章节标题、概要或当前正文中被提及时，优先级应更高。

排序规则：

1. 当前章节命中人物的关系；
2. `lastChangedPosition` 倒序；
3. relationship id 稳定排序。

不新增关系历史字段。

---

## 6. 推荐代码结构

为了避免继续膨胀 `contextBuilder.ts`，允许在同目录新增一个轻量纯函数文件：

```text
src/services/episodicMemoryRetriever.ts
```

推荐迁移以下纯逻辑：

- `buildEpisodicRetrievalQuery`
- `collectStoryRetrievalTerms`
- `findActiveStoryTerms`
- 中文 tokenizer 辅助函数
- 候选评分
- 混合 Top-K 选择

但不得把数据库访问、Story Memory 准备、Pending Bridge 或消息拼装迁入该文件。

推荐导出：

```ts
export interface EpisodicRetrievalOptions {
  queryText: string;
  storyState?: StoryMemoryState | null;
  topK: number;
}

export function tokenizeForMemoryRetrieval(text: string): string[];

export function scoreMemoryCandidates(...): ScoredMemoryCandidate[];

export function selectMemoryCandidates(
  candidates: ScoredMemoryCandidate[],
  activeTerms: ActiveStoryTerms,
  topK: number,
): ScoredMemoryCandidate[];
```

如果执行 Agent 判断新增文件会导致改动面反而更大，可以保留在 `contextBuilder.ts` 内部，但必须保持函数拆分和单元测试可访问性。

---

## 7. 数据流要求

在 `buildContext()` 中：

1. 完成 `prepareStoryMemoryForGeneration()`；
2. 获取当前可用 Story Memory record；
3. 构建 `queryText`；
4. 构建/复用 IDF；
5. 使用 `queryText + StoryMemoryState` 召回章节摘要；
6. 后续资源、Checkpoint、Bridge、正文消息顺序保持现有语义。

伪代码：

```ts
const previousChapter = previousChapters
  .filter(chapter => chapter.content)
  .sort((a, b) => b.position - a.position)[0] ?? null;

const episodicQuery = buildEpisodicRetrievalQuery({
  currentChapter,
  previousChapter,
  retrievalUserPrompt: options.retrievalUserPrompt,
});

const storyRecord = await safeGetProjectStoryMemory(projectId);

memoryText = buildMemoryContextWithIdf(
  episodicCandidates,
  currentChapter,
  idf,
  config.memoryTopK ?? 10,
  config.episodicMemoryBudgetTokens
    ?? config.summaryBudgetTokens
    ?? 20000,
  {
    queryText: episodicQuery,
    storyState: storyRecord?.state ?? null,
  },
);
```

注意：

- 不得重复触发 Story Memory rebuild；
- 不得因为 Story Memory 获取失败导致整个上下文构建失败；
- Story Memory 不可用时应回退为增强中文 TF-IDF + 最近章节混合选择；
- `preview` 模式不得产生新增 API 调用；
- 当前已有异常回退路径必须保留。

---

## 8. 测试要求

# 8.1 `summaryGenerator` 测试

新增或修改测试，验证：

1. 默认目标长度为 300；
2. 提示词包含“谁对谁做了什么”；
3. 提示词包含承诺、欺骗、冲突、合作、救援、拒绝或背叛；
4. 提示词包含物品获得、失去和转移；
5. 提示词要求避免模糊代词；
6. 提示词要求保留未解决线索；
7. 调用次数仍为一次；
8. `memory_summary` 和 token 数仍正常保存；
9. API 返回空内容时行为不变；
10. 显式传入其他 `targetChars` 时仍有效。

# 8.2 tokenizer 测试

至少覆盖：

```text
林岚发现银钥匙
```

断言包含：

```text
林
林岚
发现
银钥
钥匙
银钥匙
```

同时验证：

- 英文单词保持完整；
- 数字保持完整；
- 标点不进入 Token；
- 停用词仍过滤；
- 空文本返回空数组；
- 长中文片段复杂度不会出现平方级爆炸。

# 8.3 查询构建测试

输入：

```text
当前标题：夜探档案馆
当前概要：林岚与周恪再次交锋
用户要求：写林岚追问周恪银钥匙的去向
当前正文：空
上一章结尾：白薇将钥匙收入外套
```

查询必须包含：

- 夜探档案馆；
- 林岚；
- 周恪；
- 银钥匙；
- 白薇；
- 上一章结尾。

不得包含上一章全部正文。

# 8.4 实体评分测试

构造摘要：

A：

```text
林岚发现钟楼暗门。
```

B：

```text
周恪曾答应林岚隐瞒银钥匙的来源。
```

C：

```text
白薇调查档案馆。
```

当前查询：

```text
林岚追问周恪银钥匙的承诺
```

预期：

```text
B.finalScore > A.finalScore
B.finalScore > C.finalScore
```

并验证 B 获得：

- 林岚命中；
- 周恪命中；
- 银钥匙命中；
- 人物组合奖励。

# 8.5 Top-K 混合选择测试

构造 20 个章节摘要：

- 6 个主线相似摘要；
- 3 个含当前人物的较早摘要；
- 3 个最近章节摘要；
- 其余无关摘要。

当 `topK = 10` 时必须：

- 包含高分主线摘要；
- 至少包含当前人物历史摘要；
- 至少包含最近章节摘要；
- 不重复章节；
- 最终展示按章节位置升序；
- 不超过 Top-K；
- 不超过 Token 预算。

# 8.6 低信息查询回退测试

当前章节标题和概要非常短，用户要求为空，当前正文为空。

预期：

- 不崩溃；
- 不随机选取最早章节；
- 至少保留最近有效摘要；
- Story Memory 可用时仍可使用当前人物相关历史；
- Story Memory 不可用时正常回退。

# 8.7 Pending Bridge 回归

验证：

- raw bridge 章节仍从 Episodic 候选中排除；
- 不会出现同一章节同时以全文和摘要重复注入；
- Seam 逻辑不变；
- hard due 行为不变；
- preview 不调用故事记忆 LLM。

# 8.8 Renderer 测试

验证关系输出包含：

```text
林岚[char_lan]
周恪[char_other]
```

而不是只有：

```text
char_lan
char_other
```

验证当前章节提及人物的关系优先于无关关系。

# 8.9 端到端场景

建立固定 30 章测试场景：

- 第 3 章：林岚把银钥匙交给周恪；
- 第 8 章：周恪答应林岚不告诉白薇；
- 第 15 章：周恪把银钥匙交给白薇；
- 第 29 章：白薇暗示自己知道钥匙来源；
- 第 30 章：当前要求“林岚再次追问周恪银钥匙和保密承诺”。

预期历史召回至少包含：

- 第 3 章；
- 第 8 章；
- 第 15 章；
- 第 29 章或最相关近期章节。

必须证明：

- 修改前结果作为基线记录；
- 修改后第 8、15 章召回优先级明显提升；
- API 调用次数未增加；
- 上下文预算未扩大。

---

## 9. 性能测试

至少准备：

- 30 章；
- 100 章；
- 300 章；

每章均有约 300 字 `memory_summary`。

记录：

```text
IDF 缓存未命中构建耗时
IDF 缓存命中召回耗时
候选评分耗时
Top-K 选择耗时
最终 memoryText token 数
```

验收要求：

- 算法复杂度保持近似 O(N)；
- 不出现明显 O(N²) 新逻辑；
- 100 章缓存命中召回应保持毫秒级；
- 300 章不得造成可感知卡顿；
- 不得阻塞 Android UI 线程执行大量同步循环；
- 如现有构建本就在异步服务层，保持原执行方式。

---

## 10. 错误处理与回退

### 10.1 Story Memory 不可用

回退到：

```text
增强中文 TF-IDF
+ 当前查询
+ 最近章节混合 Top-K
```

不得阻止正文生成。

### 10.2 实体词为空

只使用：

```text
TF-IDF finalScore
+ 最近章节桶
```

### 10.3 查询为空

使用：

```text
当前章节标题
+ 当前章节概要
```

仍为空时，直接选择最近有效摘要，不执行无意义向量计算。

### 10.4 IDF 缓存异常

保留当前：

```text
buildMemoryContextWithIdf()
失败
→ buildMemoryContext()
```

的回退语义。

### 10.5 摘要过长

继续使用现有 Token 截断，不得抛出异常。

---

## 11. 兼容性要求

必须保证：

- 不修改数据库 Schema；
- 不需要数据迁移；
- 旧项目可直接打开；
- 旧 `memory_summary` 可继续参与检索；
- 新旧摘要可以混合使用；
- 备份格式不变；
- 恢复格式不变；
- Checkpoint 数据不变；
- App 升级后不强制重建故事记忆；
- 关闭或回退新排序逻辑时，旧 TF-IDF 路径仍可恢复。

建议增加内部特性常量：

```ts
const EPISODIC_RETRIEVAL_V2_ENABLED = true;
```

如项目已有 feature flag 系统，应使用现有方式；否则只需模块级常量，不新增设置页面。

回滚时可将其设为 `false`，回退旧选择逻辑。

---

## 12. Agent 执行顺序

执行 Agent 必须按以下顺序施工：

### Step 1：建立基线

1. 拉取并确认当前 `main`；
2. 运行现有测试；
3. 记录当前版本；
4. 运行现有故事记忆相关测试；
5. 使用固定交互场景记录当前 Top-K 结果；
6. 不修改用户未提交内容。

### Step 2：摘要提示词

1. 修改 `summaryGenerator.ts`；
2. 更新摘要默认长度；
3. 补测试；
4. 单独运行摘要测试。

### Step 3：查询与 tokenizer

1. 新增查询构建函数；
2. 加入用户要求和上一章结尾；
3. 修改中文 tokenizer；
4. 保留单字；
5. 补查询和 tokenizer 测试。

### Step 4：实体评分

1. 从现有 Story Memory 收集实体；
2. 识别当前活跃实体；
3. 加入人物、别名、物品、线索奖励；
4. 加入人物组合奖励；
5. 保持排序稳定；
6. 补评分测试。

### Step 5：混合 Top-K

1. 实现三个桶；
2. 去重；
3. 不足补齐；
4. 最终按章节位置展示；
5. 保持预算；
6. 补混合选择和低信息回退测试。

### Step 6：关系渲染

1. ID 转人物名；
2. 当前相关关系优先；
3. 补 Renderer 测试。

### Step 7：完整回归

至少运行：

```bash
npm run lint
npm run typecheck
npm run test:ci
npm run test:coverage
npm run verify
```

另需运行故事记忆、上下文构建、摘要、IDF 缓存和 Android 相关定向测试。

### Step 8：模拟器验收

验证：

- 项目正常打开；
- 创建章节；
- 定稿并生成摘要；
- 新建后续章节；
- 上下文预览包含正确历史章节；
- 正文生成调用正常；
- 无崩溃、无 ANR；
- API 请求次数未增加；
- Dirty rebuild 场景仍正常。

### Step 9：一次性发布

1. 更新版本；
2. 更新 CHANGELOG；
3. 更新 README 中当前版本和记忆能力描述；
4. 更新优化进度文档；
5. 生成正式发布说明；
6. 按仓库既有 Release APK 指南构建；
7. 不得新建签名文件；
8. 完成签名、SHA-256、版本元数据和 APK 校验；
9. 一次性发布，不拆分为两个版本。

---

## 13. 建议新增测试文件

可根据现有测试组织方式调整名称：

```text
__tests__/episodicMemoryRetriever.test.ts
__tests__/episodicMemoryQuery.test.ts
__tests__/memorySummaryPrompt.test.ts
__tests__/storyMemoryRendererRetrieval.test.ts
__tests__/longStoryRecallRegression.test.ts
```

若项目倾向减少文件数量，可合并到现有：

```text
__tests__/structuredStoryMemoryBaseline.test.ts
__tests__/storyMemoryPrompts.test.ts
__tests__/contextBuilder*.test.ts
```

但测试意图必须清晰。

---

## 14. 发布说明建议

### Added

- Episodic 历史摘要检索现支持当前写作要求和上一章结尾；
- 中文章节记忆检索新增单字、双字、三字联合匹配；
- 当前人物、人物组合、重要物品和开放线索获得召回加权；
- Top-K 同时兼顾高相关事件、人物历史和近期章节；
- Story Memory 关系上下文显示人物姓名与内部 ID。

### Improved

- 章节记忆摘要强化人物行为、互动、承诺、物品流转和未解决矛盾；
- 长篇写作对较早人物交互细节的回溯精度提升；
- 不增加普通章节生成前 API 调用；
- 不改变现有 Checkpoint、Pending Bridge 和 Dirty rebuild 架构。

---

## 15. 验收标准

只有同时满足以下条件才允许交付：

### 功能

- [ ] 摘要提示词已强化；
- [ ] 默认摘要长度调整为约 300 字；
- [ ] 用户写作要求进入 Episodic 查询；
- [ ] 上一章结尾进入 Episodic 查询；
- [ ] 中文单字、双字、三字 Token 生效；
- [ ] 人物姓名奖励生效；
- [ ] 人物组合奖励生效；
- [ ] 物品和线索奖励生效；
- [ ] 混合 Top-K 生效；
- [ ] 关系使用人物姓名展示；
- [ ] 固定 30 章交互场景通过。

### 稳定性

- [ ] 不修改数据库 Schema；
- [ ] 不新增远程 API 调用；
- [ ] Checkpoint 策略不变；
- [ ] Pending Bridge / Seam 不变；
- [ ] Dirty rebuild 回归通过；
- [ ] preview 模式不产生 API 调用；
- [ ] 旧项目和旧摘要兼容；
- [ ] 备份恢复不受影响。

### 性能

- [ ] IDF 缓存继续生效；
- [ ] 100 章检索无可感知延迟；
- [ ] 300 章测试无明显卡顿；
- [ ] 上下文 Token 默认预算未提高；
- [ ] 正文生成 API 次数保持 1 次。

### 工程

- [ ] lint 通过；
- [ ] typecheck 通过；
- [ ] test:ci 通过；
- [ ] coverage 通过；
- [ ] verify 通过；
- [ ] 模拟器端到端通过；
- [ ] CHANGELOG、README、进度文档已更新；
- [ ] Release APK 按现有签名流程验收。

---

## 16. 完成定义

本项目改造完成的最终定义是：

> 在保持单一 API LLM、现有 Checkpoint 架构、现有数据库和正常正文生成调用次数不变的情况下，Tavo Mini 可以通过更高信息密度的章节摘要、更完整的检索查询、更适合中文的 TF-IDF 和轻量实体加权，更稳定地召回较早章节中的人物行为、人物互动、物品流转、承诺和未解决矛盾，并完成一次性版本发布。

---

## 17. Agent 禁止自行扩展的事项

执行 Agent 不得以“效果更好”为由自行追加：

- 事件知识图谱；
- 向量数据库；
- Embedding；
- 第二模型；
- 多 Agent 流程；
- 新数据库 Schema；
- 新设置页面；
- 云端索引；
- 生成前额外 API；
- 生成后额外 API；
- 大规模 UI 重构；
- 与故事记忆召回无关的性能重构。

如实施中发现必须突破本 SPEC 边界的问题，应停止该项扩展，在交付报告中单独列为后续建议，不得混入本次版本。
