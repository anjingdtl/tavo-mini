# Tavo Mini V2.5.9 故事记忆召回收尾修复 SPEC

> 适用仓库：`F:\ClaudeWorkSpace\projects\TAVO-MINI`  
> 基线版本：V2.5.8  
> 建议目标版本：V2.5.9  
> 实施方式：一次性修复、测试、发布  
> 原始建设依据：`docs/superpowers/specs/Tavo-Mini-Story-Memory-Retrieval-Optimization-SPEC.md`

---

## 1. 目标

在不改变现有 Story Memory 架构、不增加远程 API 调用、不修改数据库 Schema 和备份格式的前提下，完成 V2.5.8 长篇故事记忆召回优化的四项收尾修复：

1. 默认智能 Checkpoint 主路径的章节摘要同步获得高密度人物行为抽取能力；
2. Dirty、empty、failed、rebuilding 等不可用 Story Memory 不再参与实体加权；
3. Token 预算先按召回优先级筛选，再按章节时间顺序展示；
4. 多人物共用别名按歧义处理，不再错误归属。

---

## 2. 实施边界

### 必须保持不变

- 单一 API LLM；
- 普通正文生成前仍只有一次正文 API 请求；
- Checkpoint 默认三章策略；
- Pending Bridge / Seam；
- Dirty rebuild 主逻辑；
- Episodic TF-IDF + 中文 n-gram；
- 数据库 Schema；
- 备份格式；
- 默认上下文 Token 预算；
- 旧 `memory_summary` 兼容性。

### 禁止新增

- Embedding；
- 向量数据库；
- 第二模型；
- LLM rerank；
- 生成前额外 API；
- 生成后检查 API；
- 新事件数据库；
- 新设置页面；
- 大规模框架重构。

---

## 3. 修复一：强化默认 Checkpoint 的逐章摘要

### 3.1 问题

V2.5.8 强化了 `generateMemorySummary()`，但默认 smart Checkpoint 路径中，每章 `memory_summary` 主要来自批量 Checkpoint 的 `chapterSummaries`。

因此默认主路径还没有完整执行以下摘要要求：

- 谁对谁做了什么；
- 承诺、欺骗、冲突、合作、救援、拒绝、背叛；
- 物品由谁获得、失去、使用、转交；
- 人物新得知、误解、隐瞒、泄露的信息；
- 关系和信任变化原因；
- 未解决的线索、秘密、误会、承诺和矛盾；
- 避免“他们、二人、双方”等模糊代词。

### 3.2 修改文件

```text
src/services/storyMemory/storyMemoryPrompts.ts
```

重点修改：

```ts
STORY_MEMORY_CHECKPOINT_SYSTEM_PROMPT
BATCH_ITEM_CONTRACT
buildStoryMemoryCheckpointMessages()
```

### 3.3 提示词要求

在 Checkpoint 系统提示词中新增“逐章检索摘要要求”：

```text
chapterSummaries 将直接用于后续长篇章节的历史事件检索。

每章摘要必须优先保留：
1. 本章重要人物的完整姓名及必要别名；
2. 谁对谁实施了什么行为，以及行为结果；
3. 人物之间的重要承诺、欺骗、冲突、合作、救援、拒绝或背叛；
4. 重要物品由谁获得、失去、使用或交给谁；
5. 人物新得知、误解、隐瞒或泄露的信息；
6. 人物关系、信任、态度、目标或立场变化及原因；
7. 本章产生但尚未解决的线索、秘密、误会、承诺和矛盾；
8. 对后续连续性有约束的时间、地点和状态。

必须明确写出行为主体和对象，避免使用“二人”“他们”“双方”“有人”等模糊代词。
不得只写空泛主线概括，不得添加正文中没有发生的事实。
```

### 3.4 字段契约要求

在 `BATCH_ITEM_CONTRACT` 中补充：

- `brief`：必须包含最重要的主体、行为、对象和结果；
- `events`：优先采用“人物A 对人物B 做了某事，造成某结果”；
- `characterChanges`：写明人物姓名、具体变化和原因；
- `relationshipChanges`：写明双方姓名、变化内容和原因；
- `newThreads`：写明涉及人物、物品、秘密或误会。

不得修改 JSON Schema，不新增字段。

### 3.5 长度要求

普通章节最终渲染后的摘要建议约 180～320 个中文字符。

- 简单章节可以更短；
- 关键章节可以更长；
- 不要求固定 300 字；
- 不得因摘要增强显著提高 Checkpoint JSON 截断和 repair 率。

---

## 4. 修复二：不可用 Story Memory 禁止参与实体加权

### 4.1 问题

`prepareStoryMemoryForGeneration()` 已经排除 Dirty Checkpoint，但 `contextBuilder.ts` 又独立读取 Story Memory，并可能将 Dirty 状态中的人物、物品和线索用于 Episodic 加权。

这会导致过期实体影响历史摘要排名。

### 4.2 修改文件

```text
src/services/contextBuilder.ts
```

### 4.3 正确实现

优先直接复用：

```ts
const storyStateForRetrieval =
  prepared?.checkpoint?.state ?? null;
```

只有经过 `prepareStoryMemoryForGeneration()` 判定可用的 Checkpoint 才能参与：

- 人物姓名奖励；
- 别名奖励；
- 物品奖励；
- 线索奖励；
- 人物组合奖励。

不得再次无状态判断地使用：

```ts
storyRecord?.state
```

### 4.4 回退

以下状态必须使用 `storyState = null`：

```text
dirty
empty
failed
rebuilding
数据库异常
状态不可解析
```

此时继续使用：

```text
中文 n-gram TF-IDF
+ 当前写作要求
+ 上一章结尾
+ 最近章节桶
```

不得阻止正文生成。

---

## 5. 修复三：Token 预算先按优先级筛选

### 5.1 问题

当前候选先按章节时间升序，再按 Token 预算依次写入。

当预算不足时，较早但次要的摘要可能挤掉分数更高、位置更晚的关键人物互动。

### 5.2 修改文件

```text
src/services/contextBuilder.ts
src/services/episodicMemoryRetriever.ts
```

### 5.3 正确流程

必须调整为：

```text
混合 Top-K 按召回优先顺序选出候选
→ 按优先顺序执行 Token 预算筛选
→ 将最终保留候选按 chapter.position 升序展示
```

### 5.4 推荐函数

```ts
export function selectCandidatesWithinTokenBudget(
  selectedByPriority: ScoredMemoryCandidate[],
  budgetTokens: number,
): ScoredMemoryCandidate[]
```

### 5.5 预算规则

每个候选先构造完整行：

```ts
第 N 章「标题」摘要：正文
```

再计算 Token。

规则：

1. 能完整放入则加入；
2. 某条过长放不下时，继续尝试后续更短候选；
3. 不得因为一条过长候选直接 `break`；
4. 如果尚无任何候选进入，允许将最高优先候选按预算截断；
5. 最终总 Token 不得超过预算；
6. 完成预算筛选后，再调用 `orderCandidatesForDisplay()`。

### 5.6 不得修改

- `episodicMemoryBudgetTokens` 默认值；
- Story State Budget；
- Pending Bridge Budget；
- 资源注入预算。

---

## 6. 修复四：共用别名按歧义处理

### 6.1 问题

当前别名是一对一映射：

```ts
aliasToCanonical: Record<string, string>
```

多个人物共用“队长、师父、殿下、老板”等称呼时，后加入人物会覆盖前一个人物，导致错误实体奖励和人物组合奖励。

### 6.2 修改文件

```text
src/services/episodicMemoryRetriever.ts
```

### 6.3 数据结构

改为一对多：

```ts
aliasToCanonicalNames: Record<string, string[]>
```

可同时增加：

```ts
ambiguousAliases: string[]
```

### 6.4 规则

#### 唯一别名

```text
小岚 → 林岚
```

正常参与：

- 人物激活；
- 别名奖励；
- 人物组合奖励；
- 人物历史桶。

#### 歧义别名

```text
队长 → 林岚、周恪
```

必须：

- 记录为歧义别名；
- 不自动激活任何 canonical character；
- 不给予人物奖励；
- 不参与人物组合奖励；
- 只有查询同时明确出现 canonical name 时，才激活对应人物。

例如：

```text
队长下令调查
```

不得激活林岚或周恪。

```text
林岚队长下令调查
```

只由 canonical name 激活林岚，不得额外激活周恪。

---

## 7. 生产路径验收

必须核对以下路径。

### 路径 A：smart Checkpoint 未到期

```text
章节定稿
→ 不生成 Checkpoint 摘要
→ Pending Bridge / raw 正文覆盖近期章节
```

此路径允许本章 `memory_summary` 暂为空，但下一章必须能获取完整近期正文。

### 路径 B：smart Checkpoint 到期

```text
多个 Pending 章节
→ 一次 Checkpoint API
→ chapterSummaries 写入各章 memory_summary
```

必须确认使用本 SPEC 强化后的提示词。

### 路径 C：关闭结构化故事记忆

继续使用：

```text
generateMemorySummary()
```

默认约 300 字高密度摘要。

### 路径 D：every_chapter / legacy

不得破坏单章 patch 和 `renderEpisodicMemoryText()`。

### 路径 E：批量章节生成

继续使用默认强化后的 `generateMemorySummary()`，不得恢复显式 200 字参数。

---

## 8. 测试要求

### 8.1 Checkpoint 提示词测试

断言提示词和契约包含：

- 谁对谁做了什么；
- 主体和对象；
- 承诺；
- 欺骗；
- 冲突；
- 合作；
- 救援；
- 拒绝；
- 背叛；
- 物品获得、失去、使用和转交；
- 信息得知、误解、隐瞒和泄露；
- 关系变化原因；
- 未解决线索、秘密、误会和矛盾；
- 避免模糊代词。

### 8.2 Checkpoint 主路径集成测试

构造三章：

1. 林岚把银钥匙交给周恪；
2. 周恪答应林岚不告诉白薇；
3. 周恪把银钥匙交给白薇。

模拟 Checkpoint 返回并验证写入的 `memory_summary` 包含：

- 林岚；
- 周恪；
- 白薇；
- 银钥匙；
- 转交关系；
- 保密承诺。

### 8.3 Dirty 状态测试

构造 Dirty 状态中存在旧人物和旧物品。

断言：

- Dirty state 不参与实体奖励；
- 不产生旧物品奖励；
- 不产生人物组合奖励；
- TF-IDF 和最近章节回退正常；
- buildContext 不报错。

至少覆盖：

```text
dirty
empty
failed
rebuilding
```

### 8.4 Token 预算测试

构造：

- A：较早、分数较低、摘要很长；
- B：较晚、分数最高、关键承诺；
- C：最近章节、摘要较短。

预算只能容纳 B+C。

断言：

- 最终包含 B；
- 最终包含 C；
- A 不得因位置最早挤掉 B；
- 展示顺序仍按 position 升序；
- 总 Token 不超预算；
- 中间长候选放不下时继续尝试后续候选；
- 第一候选单条超预算时可截断进入。

### 8.5 歧义别名测试

人物：

```text
林岚 aliases=["队长"]
周恪 aliases=["队长"]
白薇 aliases=["小薇"]
```

断言：

- 查询“队长下令”不激活林岚或周恪；
- 不产生人物组合奖励；
- 查询“林岚队长下令”只激活林岚；
- 查询“小薇调查”正常激活白薇。

### 8.6 30 章回归

原固定场景必须继续召回：

- 第 3 章；
- 第 8 章；
- 第 15 章；
- 第 29 章或近期相关章。

增加小 Token 预算版本，确认关键互动章不会因时间升序而丢失。

### 8.7 既有回归

必须继续通过：

- Pending Bridge；
- Seam；
- raw 章节从 Episodic 排除；
- preview 不调用 LLM；
- Dirty rebuild；
- IDF 缓存；
- 旧摘要兼容；
- Story Memory Renderer；
- Context Preview；
- 批量章节生成；
- 章节定稿失败保护；
- 数据库和备份测试。

---

## 9. 性能要求

重新测试：

```text
30 章
100 章
300 章
```

记录：

- IDF 构建耗时；
- 缓存命中耗时；
- 候选评分耗时；
- Top-K 选择耗时；
- Token 预算选择耗时；
- 最终上下文 Token。

要求：

- 算法保持近似 O(N)；
- 别名一对多不得引入人物数量平方级计算；
- 每次检索只收集一次 Story Memory 实体并复用；
- 不增加远程 API；
- Android 端无可感知检索卡顿。

---

## 10. 版本与发布

建议版本：

```text
V2.5.9
versionCode 2050900
```

如果仓库版本已前移，则顺延补丁号。

更新：

```text
package.json
src/constants/version.json
CHANGELOG.md
README.md
docs/optimization/progress.md
docs/V2.5.9-STORY-MEMORY-RETRIEVAL-FIX-REPORT.md
```

修复报告必须明确：

- Checkpoint 默认主路径摘要已增强；
- Dirty 状态不再参与实体加权；
- Token 预算先按优先级筛选、后按时间展示；
- 共用别名按歧义处理；
- API 调用次数不变；
- Schema 和备份格式不变。

执行门禁：

```bash
npm run lint
npm run typecheck
npm run test:ci
npm run test:coverage
npm run verify
```

完成 Android 模拟器冒烟测试：

- 正确安装补丁版本；
- 主界面和章节编辑页可达；
- 上下文预览可达；
- 定稿路径无崩溃；
- 无 AndroidRuntime FATAL；
- 版本号正确。

正式 APK：

```text
dist/apk/release/ShineWriter-V{version}-release.apk
```

必须继续使用现有正式签名流程，不得新建 keystore 或使用 Debug 签名。

---

## 11. 完成定义

只有同时满足以下条件才可交付：

- [ ] Checkpoint 主路径摘要提示词已强化；
- [ ] Dirty 等不可用状态不参与实体加权；
- [ ] Token 预算按召回优先级筛选；
- [ ] 最终展示保持章节时间顺序；
- [ ] 歧义别名不错误映射人物；
- [ ] 原 30 章召回回归继续通过；
- [ ] 小预算召回测试通过；
- [ ] 所有既有 Story Memory 回归通过；
- [ ] API 调用次数未增加；
- [ ] Schema 和备份格式未改变；
- [ ] 全部门禁通过；
- [ ] 模拟器冒烟通过；
- [ ] 正式 APK 构建与签名校验通过；
- [ ] 修复报告确认本轮无剩余已知问题。

---

## 12. Agent 施工纪律

- 开始前检查 Git 状态、分支、最新提交和未提交文件；
- 不覆盖用户未提交内容；
- 不格式化无关文件；
- 不夹带无关重构；
- 每项生产修改必须有对应测试；
- 不得只修测试或只更新文档；
- 如发现与以上四项直接相关的缺陷，可一并修复并在报告中说明；
- 不得扩展到 Embedding、多模型、事件数据库或新记忆框架。
