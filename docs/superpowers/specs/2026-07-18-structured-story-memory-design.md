# ShineWriter 长篇小说结构化记忆系统改造 — 设计规范

| 字段 | 值 |
|---|---|
| 文档日期 | 2026-07-18 |
| 文档状态 | 待实现 |
| 目标版本 | V2.5.0（建议） |
| 当前基线 | V2.4.6 / Schema 14 |
| 目标 Schema | 15 |
| 优先级 | P0：长篇小说连续性核心能力 |
| 建议仓库路径 | `docs/superpowers/specs/2026-07-18-structured-story-memory-design.md` |
| 主要影响范围 | 章节定稿、摘要生成、上下文构建、上下文自动配置、数据库、备份、故事概览、测试体系 |

---

## 0. Agent 执行契约

本节是实现 Agent 的强制执行规则。除非本 spec 明确允许，不得自行改变架构方向。

### 0.1 工作方式

1. 从当前 `main` 创建独立分支，建议命名：

   ```bash
   git switch -c feat/structured-story-memory
   ```

2. 开始修改前执行并记录基线：

   ```bash
   npm ci
   npm run lint
   npm run typecheck
   npm run test:ci
   ```

3. 采用测试先行或测试同步方式实施。每个 Phase 完成后必须运行该 Phase 的定向测试；全部完成后运行：

   ```bash
   npm run verify
   ```

4. 不得修改与本功能无关的 UI、构建脚本、Android 原生模块和第三方依赖。

5. 不新增 npm 依赖。JSON 校验、哈希、状态合并使用项目现有工具或本地纯 TypeScript 实现。

6. 所有数据库读写继续通过 `services/database.ts` facade 暴露；屏幕组件不得直接 import repository 或执行 SQL。

7. 所有项目级记忆更新必须串行化、可重放、可幂等。不得并行更新同一项目的故事记忆。

8. 任一 LLM 记忆任务失败时：
   - 已保存的章节正文不得回滚或丢失；
   - 已验证的旧故事记忆不得被无效结果覆盖；
   - 对应项目必须进入可诊断、可重建的 `dirty` 或 `failed` 状态。

9. 每个 Phase 单独提交，建议提交顺序见第 18 节。

### 0.2 Agent 禁止事项

- 禁止将“截至本章的完整故事摘要”继续写入每一章的 `memory_summary`。
- 禁止让 LLM 每章自由重写完整项目记忆。
- 禁止使用通用 RFC 6902 JSON Patch 直接修改任意 JSON 路径。
- 禁止在 `contextBuilder` 中临时调用 LLM。
- 禁止为了节省实现量而删除现有 `memory_summary + TF-IDF Top-K` 事件检索。
- 禁止在数据库迁移期间发起网络或本地 LLM 推理。
- 禁止仅通过增加 token 预算掩盖记忆结构问题。
- 禁止在验证失败后“尽量解析”并写入部分未知结构。
- 禁止依赖 LLM 生成稳定数据库主键。

---

## 1. 背景与问题定义

### 1.1 当前机制

V2.4.6 当前存在两套章节摘要：

1. `summary_json`
   - `brief`
   - `plotPoints`
   - `characterStates`
   - `sceneChanges`

2. `memory_summary`
   - 章节定稿时调用 `generateMemorySummary(chapter.id, 200)`；
   - 由 LLM 自由生成约 200 字自然语言摘要；
   - 保存到 `chapters.memory_summary`；
   - 后续写作时，从全部历史章节摘要中按 TF-IDF 余弦相似度选择 Top-K；
   - 在 `summaryBudgetTokens` 范围内注入上下文。

现有方案本质上是“章节事件检索”，但它同时承担了“全书当前状态”的职责。

### 1.2 已确认的问题

1. **摘要格式漂移**

   LLM 只收到“总结核心剧情、人物变化和关键事件”的自然语言要求，具体写法由模型自行决定。不同章节、不同模型、不同温度下输出重点不一致。

2. **缺少项目级当前状态**

   系统没有一份明确回答以下问题的数据：

   - 当前有哪些重要人物？
   - 每个人现在在哪里、知道什么、想做什么？
   - 人物关系当前处于什么状态？
   - 主线当前推进到哪一步？
   - 哪些冲突、承诺、伏笔尚未解决？

3. **Top-K 召回不等于全局连续性**

   与当前章节语义相似的历史事件会被召回，但不相似却仍然必须遵守的事实可能被漏掉。

4. **章节摘要过短且生成规模固定**

   每章约 200 字，与用户配置的模型上下文规模无关；`summaryBudgetTokens` 只约束注入，不约束摘要生成或项目级状态规模。

5. **不能直接改成累计摘要**

   如果每章都保存“截至本章的完整故事状态”，现有 Top-K 会召回多个高度重复的累计快照，造成上下文浪费、检索失真和事实重复。

6. **旧章节修改缺少记忆失效机制**

   修改、删除或重排早期章节后，后续摘要不会自动被判定为过期。

7. **IDF 缓存签名存在同长度修改风险**

   当前缓存签名只使用各章 `memory_summary.length`。摘要内容改变但长度不变时，缓存可能继续复用旧 IDF。

### 1.3 根因

根因不是单纯的 token 不足，而是记忆职责混杂：

- **项目当前状态**应该始终注入；
- **历史章节事件**应该按需检索；
- **最近正文**应该负责语言、动作和场景衔接。

这三类信息必须分层存储、分层更新、分层预算。

---

## 2. 目标与非目标

### 2.1 目标

本改造必须实现以下结果：

1. 新增项目级、固定范式、结构化故事记忆，顶层严格由三部分组成：
   - 登场人物；
   - 人物关系；
   - 故事主线。

2. 每章定稿后，LLM 只生成“本章造成的记忆变更补丁”，由程序确定性合并，不允许 LLM 重写完整记忆。

3. 保留章节级事件记忆，用于 TF-IDF Top-K 历史事件召回。

4. 项目级故事状态在每次章节生成时强制注入，不参与 Top-K 淘汰。

5. 将项目状态预算、章节事件预算、记忆补丁输出上限纳入上下文自动配置。

6. 支持早期章节修改、删除、重排后的失效标记和顺序重建。

7. 支持升级后的旧项目延迟初始化，不在数据库迁移或 App 启动时自动产生 LLM 费用。

8. 故障可诊断、状态可预览、用户可手动重建。

9. 备份和恢复能够完整保存故事记忆、章节补丁和快照。

10. 不破坏现有章节生成、流水线、本地模型、资源注入和旧项目读取。

### 2.2 非目标

本 spec 不包含：

- 向量数据库或 Embedding 检索；
- 云端同步；
- 多人协作；
- 自由写作单文档模式的结构化故事记忆；
- 自动修改角色卡或世界书；
- 让用户直接编辑底层 JSON；
- 跨项目共享故事记忆；
- 自动识别所有模型厂商的真实上下文；
- 用 LLM 判断整部小说的文学质量；
- 完整因果图、知识图谱数据库或图数据库；
- 自动回写已生成正文。

---

## 3. 核心架构

### 3.1 三层上下文模型

```text
┌──────────────────────────────────────────────────────┐
│ 第一层：项目级故事状态 Story Memory                  │
│ 人物当前状态 + 人物关系 + 故事主线                   │
│ 每次生成强制注入，不参与 Top-K                       │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│ 第二层：章节级事件记忆 Episodic Memory               │
│ 每章独立事件摘要，按 TF-IDF + Top-K 召回              │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│ 第三层：最近正文 Sliding Window                      │
│ 负责语气、对话、动作、场景和上一章结尾衔接           │
└──────────────────────────────────────────────────────┘
```

### 3.2 更新模型

```text
上一章已验证的 StoryMemoryState
             +
当前章节正文、标题、概要
             ↓
LLM 输出 ChapterMemoryPatch（严格 JSON）
             ↓
结构校验 + 证据校验 + 引用解析
             ↓
纯函数 applyStoryMemoryPatch()
             ↓
新 StoryMemoryState + 本章 episodic summary
             ↓
单事务持久化
```

### 3.3 设计原则

1. **LLM 负责理解，程序负责状态更新。**
2. **全局状态保存“现在是什么”，章节记忆保存“过去发生过什么”。**
3. **关键事实必须有来源章节和正文证据。**
4. **所有更新按章节 position 串行执行。**
5. **同一补丁重复应用结果不变。**
6. **无效输出不得污染已验证状态。**
7. **主线未解决信息优先于已解决历史。**
8. **token 裁剪只影响上下文渲染，不得破坏数据库中的有效当前状态。**
9. **项目级状态允许有界压缩；完整历史仍可从章节补丁和正文重放。**

---

## 4. 术语

| 术语 | 含义 |
|---|---|
| Story Memory | 项目级当前故事状态 |
| Episodic Memory | 每章独立的历史事件记忆 |
| Memory Patch | 当前章节对故事状态造成的增量变化 |
| Snapshot | 某一章节之后的项目级完整状态快照 |
| Dirty Position | 从该章节 position 起，现有状态可能失效 |
| Rebuild | 从有效快照开始，按章节顺序重新生成或重放补丁 |
| Evidence Quote | 补丁中用于证明事实来自正文的短原文 |
| Source Fingerprint | 标题、概要、正文的稳定指纹 |
| Base Memory Fingerprint | 生成补丁时所依赖的上一版故事状态指纹 |
| Canonical ID | 由程序分配的稳定人物、关系、线索 ID |

---

## 5. 项目级固定范式

项目级故事记忆顶层只能包含以下三类业务信息：

```ts
export interface StoryMemoryState {
  schemaVersion: 1;
  projectId: number;

  throughChapterId: number | null;
  throughChapterPosition: number;

  characters: Record<string, StoryCharacter>;
  relationships: Record<string, StoryRelationship>;
  mainline: StoryMainline;

  metadata: StoryMemoryMetadata;
}
```

### 5.1 登场人物

```ts
export type StoryCharacterStatus =
  | 'active'
  | 'inactive'
  | 'missing'
  | 'dead'
  | 'unknown';

export interface StoryCharacter {
  id: string;
  canonicalName: string;
  aliases: string[];

  role: string;
  immutableProfile: {
    identity: string;
    stableTraits: string[];
    affiliations: string[];
  };

  currentState: {
    location: string;
    physicalState: string;
    emotionalState: string;
    currentGoal: string;
    knowledge: string[];
    possessions: string[];
    secrets: string[];
  };

  status: StoryCharacterStatus;

  firstSeenChapterId: number;
  firstSeenPosition: number;
  lastChangedChapterId: number;
  lastChangedPosition: number;
  evidenceChapterIds: number[];
}
```

规则：

1. `id` 由程序生成，LLM 不得生成最终 ID。
2. `canonicalName` 是当前主名称。
3. 改名或称呼变化进入 `aliases`，不得创建重复人物。
4. `immutableProfile` 只允许：
   - 初次补充空字段；
   - 有明确更正证据时修正。
5. `currentState` 可以随章节更新。
6. `knowledge` 表示人物本人已知事实，不等于读者已知事实。
7. `secrets` 表示人物主动隐瞒或尚未公开的信息。
8. `evidenceChapterIds` 去重并限制为最近 20 个；更早来源保留在章节补丁中。

### 5.2 人物关系

```ts
export type RelationshipDirection =
  | 'directed'
  | 'bidirectional';

export interface StoryRelationship {
  id: string;

  fromCharacterId: string;
  toCharacterId: string;
  direction: RelationshipDirection;

  relationType: string;
  currentState: string;
  trustLevel: 'hostile' | 'low' | 'uncertain' | 'medium' | 'high' | 'absolute' | 'unknown';
  publicStatus: string;
  hiddenStatus: string;
  reason: string;

  firstSeenChapterId: number;
  lastChangedChapterId: number;
  lastChangedPosition: number;
  evidenceChapterIds: number[];
}
```

规则：

1. 关系必须引用已解析的人物 ID。
2. 同一对人物可以存在不同 `relationType`，例如“亲属”和“政治盟友”。
3. `currentState` 保存当前关系，不保存完整变化史。
4. 变化史由章节补丁承担。
5. 双向关系必须统一规范化人物 ID 排序，避免 A→B 与 B→A 重复。
6. 隐藏关系和公开关系分开保存。

### 5.3 故事主线

```ts
export interface StoryMainline {
  currentArc: {
    id: string;
    name: string;
    summary: string;
    startedChapterId: number | null;
  } | null;

  currentObjective: string;

  activeConflicts: Record<string, StoryConflict>;
  openThreads: Record<string, StoryThread>;
  foreshadowing: Record<string, StoryForeshadowing>;
  timelineAnchors: Record<string, StoryTimelineAnchor>;

  recentCompletedBeats: StoryCompletedBeat[];
  recentResolvedThreads: StoryResolvedThread[];

  archiveDigest: string;
}
```

建议子类型：

```ts
export interface StoryConflict {
  id: string;
  title: string;
  parties: string[];
  state: string;
  stakes: string;
  openedChapterId: number;
  lastChangedChapterId: number;
  evidenceChapterIds: number[];
}

export interface StoryThread {
  id: string;
  title: string;
  description: string;
  ownerCharacterIds: string[];
  priority: 'critical' | 'high' | 'normal' | 'low';
  openedChapterId: number;
  lastChangedChapterId: number;
  deadlineOrTrigger: string;
  evidenceChapterIds: number[];
}

export interface StoryForeshadowing {
  id: string;
  setup: string;
  expectedPayoff: string;
  status: 'open' | 'partially_paid' | 'paid';
  openedChapterId: number;
  lastChangedChapterId: number;
  evidenceChapterIds: number[];
}

export interface StoryTimelineAnchor {
  id: string;
  label: string;
  timeDescription: string;
  event: string;
  chapterId: number;
  pinned: boolean;
}

export interface StoryCompletedBeat {
  id: string;
  summary: string;
  chapterId: number;
}

export interface StoryResolvedThread {
  id: string;
  title: string;
  resolution: string;
  openedChapterId: number;
  resolvedChapterId: number;
}
```

主线规则：

1. `activeConflicts`、`openThreads`、未兑现 `foreshadowing` 不得因 token 压缩被删除。
2. 解决后的线索移动到 `recentResolvedThreads`，不继续占据活跃区。
3. `recentCompletedBeats` 默认保留最近 20 条。
4. `recentResolvedThreads` 默认保留最近 30 条。
5. 超出保留数量的已解决内容可以进入 `archiveDigest`，完整证据仍存在章节补丁。
6. `timelineAnchors.pinned === true` 的条目不得自动删除。
7. 当前目标必须是单一、明确、可执行的叙述；不存在时允许空字符串。

### 5.4 元信息

```ts
export type StoryMemoryBuildStatus =
  | 'empty'
  | 'clean'
  | 'dirty'
  | 'rebuilding'
  | 'failed';

export interface StoryMemoryMetadata {
  status: StoryMemoryBuildStatus;
  source: 'native' | 'legacy_bootstrap';

  stateFingerprint: string;
  lastAppliedPatchId: string | null;

  estimatedTokens: number;
  dirtyFromPosition: number | null;

  lastError: string;
  updatedAt: string;
}
```

---

## 6. 章节记忆补丁

### 6.1 补丁结构

LLM 返回结构不得直接包含完整 `StoryMemoryState`，只能返回领域补丁。

```ts
export interface ChapterMemoryPatchDraft {
  schemaVersion: 1;

  chapterRef: {
    chapterId: number;
    chapterPosition: number;
    title: string;
  };

  episodicSummary: {
    brief: string;
    keywords: string[];
    events: string[];
    characterChanges: string[];
    relationshipChanges: string[];
    mainlineChanges: string[];
    newThreads: string[];
    resolvedThreads: string[];
  };

  newCharacters: NewCharacterPatch[];
  characterUpdates: CharacterUpdatePatch[];

  newRelationships: NewRelationshipPatch[];
  relationshipUpdates: RelationshipUpdatePatch[];

  mainlinePatch: MainlinePatch;
}
```

### 6.2 新人物临时引用

LLM 只能输出临时引用：

```ts
export interface NewCharacterPatch {
  tempRef: string; // 例如 "new_char_1"
  canonicalName: string;
  aliases: string[];
  role: string;
  identity: string;
  stableTraits: string[];
  initialState: Partial<StoryCharacter['currentState']>;
  status: StoryCharacterStatus;
  evidenceQuote: string;
}
```

应用补丁时由程序分配稳定 ID：

```text
char_<projectId>_<stableHash(normalizedName|firstChapterId)>
```

发生碰撞时追加稳定序号，不得使用随机 ID 导致重建结果变化。

### 6.3 已有人物更新

```ts
export interface CharacterUpdatePatch {
  characterRef: string; // 必须是系统提示中提供的已有人物 ID
  addAliases: string[];

  profileCorrections: Partial<StoryCharacter['immutableProfile']>;
  stateChanges: Partial<StoryCharacter['currentState']>;
  status?: StoryCharacterStatus;

  correctionReason: string;
  evidenceQuote: string;
}
```

规则：

- LLM 必须使用输入中给出的精确人物 ID。
- `profileCorrections` 非空时，`correctionReason` 必填。
- 不得通过空字符串清除旧字段；明确清除使用专门的 `clearFields` 列表。
- `knowledge`、`possessions`、`secrets` 使用集合合并和显式移除，不允许整数组覆盖。

建议扩展：

```ts
addKnowledge: string[];
removeKnowledge: string[];
addPossessions: string[];
removePossessions: string[];
addSecrets: string[];
removeSecrets: string[];
clearFields: string[];
```

### 6.4 关系补丁

```ts
export interface NewRelationshipPatch {
  tempRef: string;
  fromRef: string;
  toRef: string;
  direction: RelationshipDirection;
  relationType: string;
  currentState: string;
  trustLevel: StoryRelationship['trustLevel'];
  publicStatus: string;
  hiddenStatus: string;
  reason: string;
  evidenceQuote: string;
}

export interface RelationshipUpdatePatch {
  relationshipRef: string;
  currentState?: string;
  trustLevel?: StoryRelationship['trustLevel'];
  publicStatus?: string;
  hiddenStatus?: string;
  reason?: string;
  evidenceQuote: string;
}
```

`fromRef`、`toRef` 可以引用已有 ID 或同一补丁中的 `tempRef`。

### 6.5 主线补丁

```ts
export interface MainlinePatch {
  currentArcUpdate: {
    action: 'none' | 'start' | 'update' | 'complete';
    arcRef: string;
    name: string;
    summary: string;
    evidenceQuote: string;
  };

  currentObjective?: {
    value: string;
    evidenceQuote: string;
  };

  conflictUpserts: ConflictPatch[];
  threadOpens: ThreadOpenPatch[];
  threadUpdates: ThreadUpdatePatch[];
  threadResolutions: ThreadResolutionPatch[];
  foreshadowingUpserts: ForeshadowingPatch[];
  timelineAnchors: TimelineAnchorPatch[];
  completedBeats: CompletedBeatPatch[];
}
```

### 6.6 持久化后的补丁

通过校验、引用解析和 ID 分配后保存：

```ts
export interface StoredChapterMemoryPatch {
  patchId: string;
  schemaVersion: 1;

  projectId: number;
  chapterId: number;
  chapterPosition: number;

  sourceFingerprint: string;
  baseMemoryFingerprint: string;
  resultMemoryFingerprint: string;

  episodicSummary: ChapterMemoryPatchDraft['episodicSummary'];
  normalizedPatch: NormalizedStoryMemoryPatch;

  generatedAt: string;
  appliedAt: string | null;
}
```

`patchId` 必须稳定：

```text
patch_<chapterId>_<sourceFingerprint>_<schemaVersion>
```

同一个 `patchId` 重复应用必须直接返回已有结果或 no-op。

---

## 7. LLM 提取约束

### 7.1 输入

生成本章补丁时传入：

1. 固定系统提示词；
2. 当前有效故事记忆的紧凑视图；
3. 已有人物 ID、别名；
4. 已有关系 ID；
5. 活跃主线条目 ID；
6. 当前章节标题；
7. 当前章节概要；
8. 当前章节完整正文；
9. 输出 JSON 范式；
10. `memoryPatchMaxTokens`。

### 7.2 系统提示词要求

新增：

```text
src/services/storyMemory/storyMemoryPrompts.ts
```

系统提示词必须包含以下不可变规则：

```text
你是小说连续性记录器，不是小说作者。

任务：只提取“本章明确发生并会影响后续连续性”的变化。
你不得续写、猜测、补全、评价或美化。
你不得输出完整故事摘要，只能输出指定的增量 JSON。
所有事实必须来自当前章节正文。
每个更新必须提供一段可在正文中找到的简短原文 evidenceQuote。
已有实体必须使用输入中给出的精确 ID。
新实体只能使用 new_char_*、new_rel_*、new_thread_* 等临时引用。
未发生变化的字段不要输出。
无法确认时保留为空数组，不得猜测。
只输出一个 JSON 对象，不要输出 Markdown、解释或代码围栏。
```

### 7.3 证据校验

每个业务更新必须带 `evidenceQuote`。

校验函数：

```ts
export function validateEvidenceQuote(
  chapterContent: string,
  evidenceQuote: string,
): boolean;
```

规则：

1. 去除连续空白差异后，`evidenceQuote` 必须是正文子串。
2. 长度建议 4—80 个字符。
3. 纯标点、章节标题或概要中的内容不算正文证据。
4. 证据不存在时，整条操作拒绝。
5. 单条拒绝不应导致其余合法操作被静默写入；默认策略是整份补丁失败并重试一次，避免部分状态。

### 7.4 输出解析

流程：

```text
LLM result
  → extractJSON
  → JSON.parse
  → validatePatchShape
  → validateEntityReferences
  → validateEvidenceQuotes
  → normalizePatch
```

不得使用 `as any` 绕过运行时校验。

### 7.5 修复重试

第一次输出无效时，允许一次修复重试：

- 输入原始无效 JSON；
- 输入具体校验错误；
- 不重新要求理解整章；
- 使用同一 `memoryPatchMaxTokens`；
- 第二次失败后停止，不允许无限重试。

使用场景：

```ts
scenario: 'story_memory_patch'
projectId: chapter.project_id
```

修复调用可使用：

```ts
scenario: 'story_memory_patch_repair'
```

---

## 8. 确定性合并引擎

新增目录：

```text
src/services/storyMemory/
  storyMemoryTypes.ts
  storyMemoryDefaults.ts
  storyMemoryValidator.ts
  storyMemoryMerger.ts
  storyMemoryRenderer.ts
  storyMemoryPrompts.ts
  storyMemoryService.ts
  storyMemoryRebuild.ts
  storyMemoryFingerprint.ts
```

### 8.1 纯函数签名

```ts
export interface ApplyPatchResult {
  state: StoryMemoryState;
  resolvedPatch: StoredChapterMemoryPatch;
  warnings: StoryMemoryWarning[];
}

export function applyStoryMemoryPatch(
  previous: StoryMemoryState,
  draft: ChapterMemoryPatchDraft,
  context: {
    projectId: number;
    chapterId: number;
    chapterPosition: number;
    sourceFingerprint: string;
  },
): ApplyPatchResult;
```

### 8.2 合并顺序

必须严格按以下顺序：

1. 验证章节 position 等于或晚于 `throughChapterPosition`；
2. 验证 `baseMemoryFingerprint`；
3. 解析新人物临时引用并分配稳定 ID；
4. 更新已有人物；
5. 创建新关系；
6. 更新已有关系；
7. 更新当前剧情弧；
8. 更新当前目标；
9. 更新冲突；
10. 开启、更新、解决线索；
11. 更新伏笔；
12. 添加时间锚点；
13. 添加已完成节拍；
14. 执行有界归档；
15. 更新 `throughChapter*`；
16. 重新计算 `stateFingerprint`；
17. 更新 token 估算；
18. 返回不可变新对象。

### 8.3 幂等性

满足任一条件时不得重复变更：

- 数据库已有相同 `patchId` 且状态为 `applied`；
- `previous.metadata.lastAppliedPatchId === patchId`；
- 新实体稳定 ID 已存在且首见章节一致；
- 新线索稳定 ID 已存在且来源章节一致。

### 8.4 冲突处理

| 冲突 | 处理 |
|---|---|
| LLM 引用不存在的人物 ID | 补丁失败 |
| 新人物名称与现有 alias 命中 | 合并到现有人物，记录 warning |
| 同名但证据显示不同人物 | 创建新 ID，追加稳定序号 |
| 修改 immutableProfile 且无 correctionReason | 拒绝该补丁 |
| 关系引用自身且 relationType 不允许 | 拒绝 |
| 解决不存在的 thread ID | 补丁失败或转 warning，默认补丁失败 |
| 重复解决已解决线索 | no-op + warning |
| 章节 position 早于当前状态且未处于 rebuild | 拒绝并标记 dirty |
| baseMemoryFingerprint 不匹配 | 不直接应用，进入 rebuild/rebase |

### 8.5 有界归档

项目状态只保留“当前状态 + 有限近期历史”。

归档不得移除：

- active characters；
- 当前人物状态；
- active relationships；
- active conflicts；
- open threads；
- 未兑现 foreshadowing；
- pinned timeline anchors；
- current arc；
- current objective。

可归档：

- 超过 20 条的 completed beats；
- 超过 30 条的 resolved threads；
- inactive 且超过 50 章未出现的人物的非关键详细状态；
- 非 pinned 且超过 100 章的时间锚点。

归档动作：

1. 从活跃 JSON 移出；
2. 生成确定性短文本条目追加到 `archiveDigest`；
3. `archiveDigest` 最大建议 3000 字符；
4. 超出时保留最近内容和重大剧情弧摘要；
5. 完整历史仍保留在 `chapter_memory_patches`，因此不丢失可重建性。

初版不使用 LLM 压缩 `archiveDigest`，避免再次引入自由摘要漂移。

---

## 9. 数据库设计

### 9.1 Schema 版本

- `SCHEMA_VERSION`：14 → 15
- 迁移：非 breaking
- 新增 migration：

```text
src/services/migrations/v14-to-v15.ts
```

- 注册到：

```text
src/services/migrations/index.ts
```

### 9.2 表一：项目当前故事记忆

```sql
CREATE TABLE IF NOT EXISTS project_story_memory (
  project_id INTEGER PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,

  through_chapter_id INTEGER,
  through_chapter_position INTEGER NOT NULL DEFAULT -1,

  memory_json TEXT NOT NULL DEFAULT '{}',
  estimated_tokens INTEGER NOT NULL DEFAULT 0,

  state_fingerprint TEXT NOT NULL DEFAULT '',
  last_applied_patch_id TEXT,

  status TEXT NOT NULL DEFAULT 'empty',
  source TEXT NOT NULL DEFAULT 'native',

  dirty_from_position INTEGER,
  last_error TEXT NOT NULL DEFAULT '',

  updated_at TEXT NOT NULL,

  FOREIGN KEY (project_id)
    REFERENCES projects(id)
    ON DELETE CASCADE,

  FOREIGN KEY (through_chapter_id)
    REFERENCES chapters(id)
    ON DELETE SET NULL
);
```

索引：

```sql
CREATE INDEX IF NOT EXISTS idx_project_story_memory_status
ON project_story_memory(status);

CREATE INDEX IF NOT EXISTS idx_project_story_memory_dirty
ON project_story_memory(dirty_from_position);
```

### 9.3 表二：章节补丁

```sql
CREATE TABLE IF NOT EXISTS chapter_memory_patches (
  chapter_id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  chapter_position INTEGER NOT NULL,

  patch_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL DEFAULT 1,

  source_fingerprint TEXT NOT NULL,
  base_memory_fingerprint TEXT NOT NULL DEFAULT '',
  result_memory_fingerprint TEXT NOT NULL DEFAULT '',

  episodic_summary_json TEXT NOT NULL DEFAULT '{}',
  patch_json TEXT NOT NULL DEFAULT '{}',
  estimated_tokens INTEGER NOT NULL DEFAULT 0,

  status TEXT NOT NULL DEFAULT 'generated',
  last_error TEXT NOT NULL DEFAULT '',

  generated_at TEXT NOT NULL,
  applied_at TEXT,

  FOREIGN KEY (chapter_id)
    REFERENCES chapters(id)
    ON DELETE CASCADE,

  FOREIGN KEY (project_id)
    REFERENCES projects(id)
    ON DELETE CASCADE
);
```

索引：

```sql
CREATE INDEX IF NOT EXISTS idx_chapter_memory_patches_project_position
ON chapter_memory_patches(project_id, chapter_position);

CREATE INDEX IF NOT EXISTS idx_chapter_memory_patches_status
ON chapter_memory_patches(status);
```

### 9.4 表三：故事记忆快照

```sql
CREATE TABLE IF NOT EXISTS story_memory_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,

  through_chapter_id INTEGER NOT NULL,
  through_chapter_position INTEGER NOT NULL,

  memory_json TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  state_fingerprint TEXT NOT NULL,

  created_at TEXT NOT NULL,

  UNIQUE(project_id, through_chapter_position),

  FOREIGN KEY (project_id)
    REFERENCES projects(id)
    ON DELETE CASCADE,

  FOREIGN KEY (through_chapter_id)
    REFERENCES chapters(id)
    ON DELETE CASCADE
);
```

索引：

```sql
CREATE INDEX IF NOT EXISTS idx_story_memory_snapshots_project_position
ON story_memory_snapshots(project_id, through_chapter_position DESC);
```

### 9.5 快照策略

默认：

```ts
export const STORY_MEMORY_SNAPSHOT_INTERVAL = 10;
export const STORY_MEMORY_MAX_SNAPSHOTS_PER_PROJECT = 20;
```

创建条件：

- `chapter.position % 10 === 9`；
- 剧情弧完成；
- 用户手动执行完整重建结束；
- 即将从 dirty 状态进入大范围重建前，可保留当前 clean 状态。

清理规则：

- 每项目最多保留 20 个自动快照；
- 永远保留最新一个；
- 手动重建完成快照优先保留；
- 删除旧快照使用单事务。

### 9.6 Fresh install

修改：

```text
src/data/schema/createCurrentSchema.ts
```

全新安装必须直接创建三张新表和索引。Fresh install 会跳过迁移，因此不能只写 migration。

### 9.7 Schema manifest

修改：

```text
src/services/database/schemaManifest.ts
```

新增三张表，建议 restoreOrder：

| 表 | restoreOrder |
|---|---:|
| `project_story_memory` | 35 |
| `chapter_memory_patches` | 36 |
| `story_memory_snapshots` | 37 |

它们必须在 `projects`、`chapters` 之后恢复，在其他无关表之前或之后均可，但顺序必须满足外键。

### 9.8 升级初始化

迁移只创建表，不发起 LLM。

升级后：

- 不为每个项目立即生成完整记忆；
- 首次读取某项目时，如果没有 `project_story_memory`：
  - 创建 `status='empty'` 的空记录；
  - 检查是否存在已定稿或有正文的章节；
  - 有则设置 `dirty_from_position` 为最早有效章节 position；
  - UI 显示“故事记忆尚未初始化”。

### 9.9 Backup / restore

三张表 `backup: true`。

恢复后必须验证：

- `project_story_memory.project_id` 不孤立；
- `chapter_memory_patches.chapter_id` 与 `project_id` 对应；
- snapshot 章节属于同项目；
- `through_chapter_position` 不晚于项目最新章节；
- JSON 可以解析；
- 无效记录进入 `failed/dirty`，不得导致整个 App 无法启动。

---

## 10. Repository 设计

新增：

```text
src/data/repositories/storyMemoryRepository.ts
```

通过 `src/services/database.ts` re-export。

### 10.1 必需 API

```ts
export async function getProjectStoryMemory(
  projectId: number,
): Promise<ProjectStoryMemoryRow | null>;

export async function ensureProjectStoryMemoryRow(
  projectId: number,
): Promise<ProjectStoryMemoryRow>;

export async function getChapterMemoryPatch(
  chapterId: number,
): Promise<ChapterMemoryPatchRow | null>;

export async function getChapterMemoryPatchesByProject(
  projectId: number,
  fromPosition?: number,
  toPosition?: number,
): Promise<ChapterMemoryPatchRow[]>;

export async function getNearestStoryMemorySnapshot(
  projectId: number,
  beforePosition: number,
): Promise<StoryMemorySnapshotRow | null>;

export async function listStoryMemorySnapshots(
  projectId: number,
): Promise<StoryMemorySnapshotRow[]>;

export async function markStoryMemoryDirty(
  projectId: number,
  fromPosition: number,
  reason?: string,
): Promise<void>;

export async function clearStoryMemory(
  projectId: number,
): Promise<void>;

export async function saveStoryMemoryUpdate(
  input: SaveStoryMemoryUpdateInput,
): Promise<void>;
```

### 10.2 原子保存

`saveStoryMemoryUpdate` 必须在一个 `executeTransaction` 中完成：

1. upsert `chapter_memory_patches`；
2. upsert `project_story_memory`；
3. 更新 `chapters.memory_summary`；
4. 更新 `chapters.memory_summary_tokens`；
5. 更新 `chapters.finalized_at`；
6. 条件满足时插入 snapshot；
7. 清理超量 snapshot。

不得先写 patch、后写 state，避免半成功状态。

### 10.3 JSON 映射

Repository 层负责：

- DB snake_case ↔ TypeScript camelCase；
- JSON.parse try/catch；
- 非法 JSON 返回可识别错误；
- 不在 UI 层解析 JSON；
- 写入前 canonical stringify。

---

## 11. 指纹与 canonical serialization

新增：

```text
src/services/storyMemory/storyMemoryFingerprint.ts
```

### 11.1 Source fingerprint

来源：

```text
chapter.title + "\n" +
chapter.synopsis + "\n" +
chapter.content
```

必须检测同长度内容修改，不能只使用字符串长度。

建议实现：

```ts
export function stableTextFingerprint(text: string): string;
```

要求：

- 纯 TypeScript；
- 同输入稳定；
- Android Hermes 可运行；
- 不使用 Node-only `crypto`；
- 至少组合两个 32 位哈希或复用项目现有纯 JS SHA-256；
- 测试覆盖同长度不同文本。

如果复用 `backupService` 内 SHA-256，应先抽取为共享工具，不能反向 import 整个 backupService。

### 11.2 State fingerprint

对 StoryMemoryState 进行 canonical serialization：

- object key 排序；
- Record 按 key 排序；
- Set 型数组去重并排序；
- 不包含 `metadata.updatedAt`、`lastError` 等非业务字段；
- 然后计算 fingerprint。

### 11.3 IDF 缓存修复

修改：

```text
src/utils/idfCache.ts
```

`computeMemorySummarySignature` 不得继续只拼接长度。

最低实现：

```ts
return previousChapters
  .map(c => `${c.id}:${c.memory_summary_tokens}:${stableTextFingerprint(c.memory_summary || '')}`)
  .join('|');
```

同时在以下路径显式调用：

```ts
invalidateIdf(projectId)
```

- 章节事件摘要写入后；
- 章节事件摘要删除后；
- 章节补丁重建后；
- 项目删除时。

---

## 12. 章节定稿流程改造

### 12.1 当前入口

主要入口：

```text
src/screens/chapter-editor/ChapterEditorScreen.tsx
```

当前定稿流程中的 `generateMemorySummary(chapter.id, 200)` 必须替换。

### 12.2 新服务

新增：

```ts
export async function finalizeChapterMemory(
  chapterId: number,
  options?: {
    forceRegenerate?: boolean;
    createSnapshot?: boolean;
  },
): Promise<FinalizeChapterMemoryResult>;
```

位置：

```text
src/services/storyMemory/storyMemoryService.ts
```

### 12.3 定稿步骤

```text
1. flush 编辑器自动保存
2. 再次读取数据库中的最新章节
3. 验证正文非空
4. 获取 project-level mutex
5. ensureStoryMemoryReady(projectId, chapter.position - 1)
6. 计算 sourceFingerprint
7. 若已有 applied patch 且 sourceFingerprint 相同：
      直接返回已有结果
8. 构造 LLM 输入
9. 调用 story_memory_patch
10. 解析和验证
11. applyStoryMemoryPatch 纯函数合并
12. renderEpisodicMemoryText
13. 单事务保存 patch + state + chapter memory_summary
14. invalidateIdf(projectId)
15. 释放 mutex
```

### 12.4 正文保存与记忆失败分离

定稿按钮语义：

1. 正文保存成功；
2. 记忆更新成功后才设置新的 `finalized_at`；
3. 记忆失败时：
   - 正文仍保留；
   - 旧 `finalized_at` 不伪装成新状态；
   - 项目 `status='failed'` 或 `dirty`；
   - UI 提示“章节已保存，但故事记忆更新失败”。

不得因 LLM 失败撤销正文。

### 12.5 章节事件文本

`chapters.memory_summary` 不再由 LLM 自由写一段文字，而是由已验证的 `episodicSummary` 确定性渲染：

```text
核心事件：……
人物变化：……
关系变化：……
主线变化：……
新增悬念：……
已解决事项：……
关键词：……
```

空项不输出。

这样可继续兼容现有 TF-IDF 检索、编辑器显示和上下文预览。

### 12.6 结构化章节摘要 UI

现有 `summary_json` 和 `ChapterSummaryScreen` 本期保留，避免与故事记忆改造绑定。

但文案必须明确：

- `summary_json` 是用户可编辑的章节笔记；
- `memory_summary` 是系统生成的章节事件记忆；
- 项目级三要素记忆在新 Story Memory 页面查看。

后续版本可以合并 UI，但不属于本 spec。

---

## 13. 章节变更与失效

### 13.1 必须标记 dirty 的操作

以下操作影响已应用补丁时，调用：

```ts
markStoryMemoryDirty(projectId, affectedPosition)
```

场景：

- 修改已定稿章节的 `title`；
- 修改已定稿章节的 `synopsis`；
- 修改已定稿章节的 `content`；
- 清空正文；
- 删除章节；
- 重排章节；
- 导入覆盖章节；
- 还原历史版本；
- 批量生成覆盖已有章节。

### 13.2 Dirty position 合并

```ts
newDirty = currentDirty == null
  ? affectedPosition
  : Math.min(currentDirty, affectedPosition);
```

不得把 dirty position 向后移动。

### 13.3 自动保存策略

900ms 自动保存不能每次按键都启动重建。

建议：

- 自动保存只更新章节；
- 如果章节已有 applied patch 且 sourceFingerprint 将变化，则轻量设置 dirty；
- 不调用 LLM；
- 用户再次定稿、运行 AI 生成或手动重建时处理。

### 13.4 删除与重排

- 删除章节：dirty 从被删除 position 开始；
- 重排：dirty 从 `min(oldPosition, newPosition)` 开始；
- 删除对应 `chapter_memory_patches` 由外键级联；
- 删除后的现有 `project_story_memory` 不立即覆盖，只标记 dirty；
- 下次 rebuild 从有效 snapshot 恢复。

---

## 14. 重建机制

### 14.1 服务接口

```ts
export async function ensureStoryMemoryReady(
  projectId: number,
  throughPosition: number,
): Promise<StoryMemoryState>;

export async function rebuildStoryMemory(
  projectId: number,
  options?: {
    fromPosition?: number;
    throughPosition?: number;
    mode?: 'auto' | 'full' | 'legacy_bootstrap';
    onProgress?: (progress: StoryMemoryRebuildProgress) => void;
    signal?: AbortSignal;
  },
): Promise<StoryMemoryRebuildResult>;
```

### 14.2 起点选择

```text
dirtyFromPosition
      ↓
查找 before dirtyFromPosition 的最近 snapshot
      ↓
有 snapshot：从 snapshot + 1 开始
无 snapshot：从项目第一章空状态开始
```

### 14.3 补丁复用

对每章按 position 顺序处理：

1. 计算当前 sourceFingerprint；
2. 检查已有 patch；
3. 同时满足以下条件时可复用：
   - sourceFingerprint 相同；
   - schemaVersion 相同；
   - patch.baseMemoryFingerprint 等于当前 state fingerprint；
   - patch.status 为 `applied` 或 `generated`；
4. 不满足则重新调用 LLM 生成；
5. 应用补丁；
6. 更新进度；
7. 每 10 章写一次 checkpoint/snapshot。

### 14.4 为什么 base fingerprint 必须匹配

早期章节变化后，即使后续章节正文未变，后续 patch 也可能依赖旧人物 ID、旧关系或旧未解决线索。

因此不能只凭“本章正文没变”直接复用；必须确认生成补丁时依赖的上一版记忆一致。

### 14.5 失败处理

重建中某章失败：

- 停止在该章；
- 保留最后一个成功 state；
- `dirty_from_position` 设置为失败章 position；
- `status='failed'`；
- 保存中文 `last_error`；
- 不删除后续旧 patch，但它们不得视为有效；
- 用户可从失败章重试。

### 14.6 取消

用户取消：

- 当前 LLM 调用使用 AbortSignal；
- 已提交的 checkpoint 保留；
- status 回到 `dirty`；
- dirty position 指向下一个未完成章节；
- 不标记 failed。

### 14.7 升级旧项目

模式 `legacy_bootstrap`：

1. 收集已有：
   - `memory_summary`
   - `summary_json`
   - 章节标题和概要
2. 按 token 预算分批；
3. 让 LLM 输出同一 ChapterMemoryPatch 范式；
4. 按章节顺序应用；
5. 状态 `source='legacy_bootstrap'`；
6. 不读取完整正文，速度和费用低于 full rebuild；
7. UI 明确显示“由旧摘要快速初始化”。

完整重建模式：

- 使用全部章节正文；
- `source='native'`；
- 准确性最高；
- 用户主动触发，不在升级时自动执行。

初版默认策略：

- 首次需要项目故事记忆时，若有旧 `memory_summary`，提示并默认执行快速初始化；
- 若用户取消，仍可继续使用旧事件检索，但 Story Memory 不注入；
- 不得静默产生大量 LLM 调用。

---

## 15. 上下文构建改造

修改：

```text
src/services/contextBuilder.ts
```

### 15.1 新增构建函数

```ts
export async function buildStoryMemoryContext(
  projectId: number,
  currentChapter: Chapter,
  budgetTokens: number,
): Promise<{
  text: string;
  traceItems: ContextTraceItem[];
}>;
```

### 15.2 消息顺序

最终消息顺序必须为：

```text
1. system：预设 / 系统提示词
2. system：项目级故事状态（强制）
3. system：角色卡 / 世界书 / 笔记资料
4. system：相关历史章节事件 Top-K
5. user：最近正文滑动窗口
6. user：当前章节标题、概要和任务
```

项目级故事状态优先于普通资源和事件召回。

### 15.3 故事状态渲染

不得直接把完整 JSON 原样发送给模型。

新增：

```ts
export function renderStoryMemoryForContext(
  state: StoryMemoryState,
  options: {
    currentChapter: Chapter;
    budgetTokens: number;
  },
): RenderStoryMemoryResult;
```

固定输出范式：

```text
【故事全局状态｜截至第 N 章】

一、登场人物
- [ID] 姓名（别名）：身份；当前位置；身体/情绪；当前目标；已知信息；持有物；秘密；状态

二、人物关系
- [关系ID] A → B：关系类型；当前状态；信任；公开状态；隐藏状态；原因

三、故事主线
- 当前剧情弧：
- 当前目标：
- 活跃冲突：
- 未解决线索：
- 未兑现伏笔：
- 关键时间锚点：
- 最近完成节点：
```

### 15.4 预算内优先级

当超过 `storyStateBudgetTokens`：

1. 当前剧情弧；
2. 当前目标；
3. active conflicts；
4. open threads；
5. 未兑现 foreshadowing；
6. 当前章节标题、概要、正文开头中提及的人物；
7. 上述人物的当前状态；
8. 上述人物之间的关系；
9. 其他 active characters；
10. 其他关系；
11. timeline anchors；
12. recent completed/resolved；
13. archiveDigest。

每个顶层三要素必须至少输出标题和“无”状态，禁止整个分类消失。

### 15.5 当前状态不可被 Top-K 淘汰

Story Memory 是固定 system message：

```text
以下是截至上一已定稿章节的全局故事状态，属于连续性约束。
除非当前章节明确改变它，否则不得违背。
```

### 15.6 Dirty 状态处理

构建上下文前：

```ts
const readiness = await getStoryMemoryReadiness(projectId, targetPosition);
```

- clean 且 throughPosition 足够：注入；
- empty：跳过并在 trace 标记；
- dirty 且 dirtyPosition 晚于目标章节：可使用前段 clean state；
- dirty 且会影响目标章节：
  - 普通预览：显示“不注入过期全局记忆”；
  - AI 生成：先调用 `ensureStoryMemoryReady`；
  - 重建失败：阻止 AI 自动生成并提示用户处理，避免继续在错误状态上写作。

不得把已知过期的全局状态静默注入。

### 15.7 事件记忆保留

现有 `buildMemoryContextWithIdf` 继续工作，但变量和文案重命名为 episodic memory。

建议兼容别名：

```ts
summaryBudgetTokens // deprecated
episodicMemoryBudgetTokens // 新字段
```

在一个过渡版本内允许旧字段 fallback。

---

## 16. 上下文自动配置改造

修改：

```text
src/services/contextAutoAllocator.ts
src/data/repositories/settingsRepository.ts
src/types/novel.ts
src/constants/defaults.ts
src/screens/ContextAutoConfigScreen.tsx
```

### 16.1 ContextConfig

```ts
export interface ContextConfig {
  strategy: ContextStrategy;
  slidingWindowSize: number;
  customRangeStart: number;
  customRangeEnd: number;

  resourceBudget: number;
  includeResources: boolean;

  storyStateBudgetTokens?: number;
  episodicMemoryBudgetTokens?: number;
  memoryPatchMaxTokens?: number;

  /** @deprecated 仅用于读取旧配置 */
  summaryBudgetTokens?: number;

  memoryTopK?: number;
  recentChapterCount?: number;
  worldbookRecursive?: boolean;
  worldbookScanDepth?: number;
}
```

### 16.2 新 settings key

```text
story_state_budget_tokens
episodic_memory_budget_tokens
memory_patch_max_tokens
```

兼容策略：

- 读取新 key；
- 新 key 不存在时，从旧 `summary_budget_tokens` 推导；
- 保存新配置时同时写：
  - `story_state_budget_tokens`
  - `episodic_memory_budget_tokens`
  - `memory_patch_max_tokens`
  - `summary_budget_tokens = story + episodic`（兼容一个版本）
- 后续大版本再删除旧 key。

### 16.3 输入预算比例

顶层继续：

```text
总上下文
  ├── 80% 输入
  └── 20% 输出
```

输入侧目标比例：

| 项目 | 占 inputBudget |
|---|---:|
| 最近正文滑动窗口 | 45%（实际取剩余） |
| 角色/笔记/世界书 | 20% |
| 项目级故事状态 | 25% |
| 章节事件记忆 | 10% |

### 16.4 上限和下限

```ts
MIN_SLIDING_WINDOW = 1000;
MIN_RESOURCE_BUDGET = 500;
MIN_STORY_STATE_BUDGET = 2000;
MAX_STORY_STATE_BUDGET = 32000;
MIN_EPISODIC_MEMORY_BUDGET = 1000;
MAX_EPISODIC_MEMORY_BUDGET = 16000;
MIN_MEMORY_PATCH_TOKENS = 800;
MAX_MEMORY_PATCH_TOKENS = 4000;
```

### 16.5 算法

正常输入预算（`inputBudget >= 5000`）：

```ts
resourceBudget = floor(inputBudget * 0.20, MIN_RESOURCE_BUDGET);

storyStateBudgetTokens = clamp(
  Math.round(inputBudget * 0.25),
  MIN_STORY_STATE_BUDGET,
  MAX_STORY_STATE_BUDGET,
);

episodicMemoryBudgetTokens = clamp(
  Math.round(inputBudget * 0.10),
  MIN_EPISODIC_MEMORY_BUDGET,
  MAX_EPISODIC_MEMORY_BUDGET,
);

slidingWindowSize =
  inputBudget
  - resourceBudget
  - storyStateBudgetTokens
  - episodicMemoryBudgetTokens;
```

如果 `slidingWindowSize < MIN_SLIDING_WINDOW`：

依次削减：

1. episodic memory，最低可降到 500；
2. story state，最低可降到 1000；
3. resource，最低可降到 0；
4. 保证 sliding 至少为可用剩余值。

极小输入预算 `< 5000`：

- 按 45/20/25/10 纯比例分配；
- 每项最少 1；
- UI 强警告；
- 不使用会导致总额超过 inputBudget 的固定 floor。

记忆补丁输出：

```ts
memoryPatchMaxTokens = clamp(
  Math.round(storyStateBudgetTokens * 0.10),
  MIN_MEMORY_PATCH_TOKENS,
  MAX_MEMORY_PATCH_TOKENS,
);
```

达到 story/episodic 上限后，多余输入预算自动回到 sliding window。

### 16.6 200K 示例

```text
maxContextTokens = 200,000
inputBudget       = 160,000
outputBudget      =  40,000

resourceBudget              = 32,000
storyStateBudgetTokens      = 32,000（命中上限）
episodicMemoryBudgetTokens  = 16,000（命中上限）
slidingWindowSize           = 80,000
memoryPatchMaxTokens        = 3,200
```

### 16.7 UI 预览

输入侧改为：

```text
输入侧 160,000
- 最近正文：80,000
- 资料：32,000
- 全局故事状态：32,000
- 历史章节事件：16,000
- 每章记忆补丁输出上限：3,200
```

旧“摘要预算”文案全部改为更明确的两层记忆文案。

---

## 17. UI 与可观测性

### 17.1 新 Story Memory 页面

新增：

```text
src/screens/StoryMemoryScreen.tsx
```

入口建议放在 `StoryOverview`，按钮文案：

```text
故事记忆
```

页面包含：

1. 状态卡：
   - clean / dirty / rebuilding / failed / empty；
   - 已构建到第几章；
   - dirty 起点；
   - 当前 token；
   - 最近更新时间；
   - 来源 native / legacy bootstrap。

2. 三个只读区：
   - 登场人物；
   - 人物关系；
   - 故事主线。

3. 操作：
   - 快速初始化；
   - 完整重建；
   - 从失败章继续；
   - 取消重建；
   - 清空并重建；
   - 查看最近错误。

4. 不提供直接 JSON 编辑。

### 17.2 ChapterEditor

定稿按钮状态：

```text
定稿中…
  ├── 保存正文
  ├── 分析章节记忆
  └── 更新故事状态
```

成功提示：

```text
章节已定稿，故事记忆已更新到第 N 章。
```

失败提示：

```text
章节正文已保存，但故事记忆更新失败。
后续 AI 写作前需要重试或重建。
```

### 17.3 ContextPreview

新增 trace kind：

```ts
kind: 'story_memory'
```

展示：

- 是否注入；
- estimatedTokens；
- 是否裁剪；
- through chapter；
- 状态；
- 未注入原因。

事件摘要 trace 文案从“历史记忆摘要”改为：

```text
相关历史章节事件
```

### 17.4 重建进度

进度结构：

```ts
export interface StoryMemoryRebuildProgress {
  projectId: number;
  currentPosition: number;
  totalChapters: number;
  completedChapters: number;
  reusedPatches: number;
  regeneratedPatches: number;
  status: 'preparing' | 'running' | 'saving' | 'completed';
}
```

初版可使用屏幕内进度条；如果重建超过前台生命周期，再复用现有 PipelineForeground 能力，但不得在 Android Service 内执行 LLM 或数据库业务。

---

## 18. 实现 Phase 与提交计划

### Phase 0：基线和保护测试

目标：在修改前锁定现有行为。

新增/补充测试：

- `summaryGenerator` 当前事件摘要；
- `contextBuilder` 消息顺序；
- `idfCache` 同长度修改回归；
- `ChapterEditor` 定稿失败不丢正文。

建议提交：

```text
test(story-memory): lock current summary and context behavior
```

退出条件：

```bash
npm run test:ci -- --runInBand
```

全绿。

---

### Phase 1：类型、默认状态、指纹、纯合并器

新增：

```text
src/services/storyMemory/storyMemoryTypes.ts
src/services/storyMemory/storyMemoryDefaults.ts
src/services/storyMemory/storyMemoryFingerprint.ts
src/services/storyMemory/storyMemoryValidator.ts
src/services/storyMemory/storyMemoryMerger.ts
```

测试：

```text
__tests__/storyMemoryFingerprint.test.ts
__tests__/storyMemoryValidator.test.ts
__tests__/storyMemoryMerger.test.ts
```

必须覆盖：

- 新人物创建；
- alias 去重；
- 人物状态更新；
- 关系临时引用；
- open/resolve thread；
- 幂等；
- 同长度正文指纹不同；
- base fingerprint 冲突；
- 无证据拒绝；
- immutable profile 非法覆盖；
- deterministic rebuild 结果一致。

建议提交：

```text
feat(story-memory): add deterministic memory domain model
```

---

### Phase 2：Schema 15 和 repository

新增：

```text
src/services/migrations/v14-to-v15.ts
src/data/repositories/storyMemoryRepository.ts
```

修改：

```text
src/services/migrations/index.ts
src/data/schema/createCurrentSchema.ts
src/services/database/schemaManifest.ts
src/services/database.ts
```

测试：

```text
__tests__/migrations-v14-v15.test.ts
__tests__/storyMemoryRepository.test.ts
__tests__/schemaManifest.test.ts
__tests__/backupService.test.ts
```

必须覆盖：

- 14 → 15；
- 重复迁移 no-op；
- fresh schema 三表存在；
- 外键；
- manifest；
- round-trip；
- transaction rollback；
- 级联删除；
- backup/restore。

建议提交：

```text
feat(database): add schema 15 story memory persistence
```

---

### Phase 3：LLM 补丁生成和验证

新增：

```text
src/services/storyMemory/storyMemoryPrompts.ts
src/services/storyMemory/storyMemoryService.ts
```

可复用：

```text
extractJSON
callLLM
estimateTokens
```

测试：

```text
__tests__/storyMemoryPrompts.test.ts
__tests__/storyMemoryService.test.ts
```

必须 mock：

- 合法 JSON；
- Markdown 围栏 JSON；
- 无效 JSON；
- evidence 不存在；
- 引用未知 ID；
- 首次失败、修复成功；
- 两次失败；
- 本地模型返回截断 JSON；
- AbortSignal。

建议提交：

```text
feat(story-memory): generate validated chapter memory patches
```

---

### Phase 4：章节定稿接线

修改：

```text
src/screens/chapter-editor/ChapterEditorScreen.tsx
src/screens/chapter-editor/ChapterFields.tsx
src/services/summaryGenerator.ts
src/data/repositories/projectRepository.ts
```

要求：

- 移除定稿路径中固定 `generateMemorySummary(chapter.id, 200)`；
- 旧函数保留兼容或标记 deprecated；
- 事件文本由结构化补丁渲染；
- 正文保存和记忆失败分离；
- 更新 IDF cache；
- 修改已定稿章节标 dirty。

测试：

```text
__tests__/chapterFinalizeStoryMemory.test.ts
__tests__/chapterEditorMemoryFlow.test.tsx
```

建议提交：

```text
feat(editor): integrate structured memory into chapter finalization
```

---

### Phase 5：重建和旧项目初始化

新增：

```text
src/services/storyMemory/storyMemoryRebuild.ts
```

测试：

```text
__tests__/storyMemoryRebuild.test.ts
```

必须覆盖：

- 从空状态完整重建；
- 从 snapshot 重建；
- patch 复用；
- base fingerprint 不同重新生成；
- 失败停在正确章节；
- 取消；
- dirty position 不向后移动；
- legacy bootstrap；
- 100 章模拟回放；
- incremental 结果与 full replay canonical JSON 完全一致。

建议提交：

```text
feat(story-memory): add snapshots dirty tracking and rebuild
```

---

### Phase 6：上下文构建

新增：

```text
src/services/storyMemory/storyMemoryRenderer.ts
```

修改：

```text
src/services/contextBuilder.ts
src/types/contextTrace.ts
src/utils/idfCache.ts
```

测试：

```text
__tests__/storyMemoryRenderer.test.ts
__tests__/contextBuilderStoryMemory.test.ts
__tests__/idfCache.test.ts
```

必须覆盖：

- 固定三段输出；
- 强制注入顺序；
- token 裁剪优先级；
- open thread 不被裁掉；
- 当前人物优先；
- dirty 不注入；
- ensure ready；
- episodic Top-K 保留；
- 同长度摘要缓存失效。

建议提交：

```text
feat(context): inject global story state before episodic memory
```

---

### Phase 7：自动预算配置

修改：

```text
src/services/contextAutoAllocator.ts
src/data/repositories/settingsRepository.ts
src/types/novel.ts
src/constants/defaults.ts
src/screens/ContextAutoConfigScreen.tsx
```

测试：

```text
__tests__/contextAutoAllocator.test.ts
__tests__/settingsRepository.test.ts
```

必须覆盖：

- 128K；
- 200K；
- 512K；
- 1M；
- 8000；
- 小于 5000 的比例 fallback；
- story 32K cap；
- episodic 16K cap；
- 余量回到 sliding；
- 总和不超过 inputBudget；
- legacy summary key fallback；
- memoryPatchMaxTokens 上下限。

建议提交：

```text
feat(context-auto): allocate budgets for two-layer story memory
```

---

### Phase 8：UI 和诊断

新增：

```text
src/screens/StoryMemoryScreen.tsx
```

修改：

```text
src/navigation/TabNavigator.tsx
src/screens/StoryOverviewScreen.tsx
src/screens/ContextPreviewScreen.tsx
```

测试：

```text
__tests__/StoryMemoryScreen.test.tsx
__tests__/ContextPreviewStoryMemory.test.tsx
```

建议提交：

```text
feat(ui): add story memory status preview and rebuild controls
```

---

### Phase 9：全量回归和文档

修改：

```text
README.md
CHANGELOG.md
docs/CODE_WIKI.md
docs/RELEASE_CHECKLIST.md
```

新增测试报告：

```text
docs/V2.5.0-STORY-MEMORY-TEST-REPORT.md
```

执行：

```bash
npm run verify
```

建议提交：

```text
docs(release): document structured story memory system
```

---

## 19. 测试矩阵

### 19.1 纯函数

| 类别 | 用例 |
|---|---|
| 指纹 | 同文本一致、同长度不同文本不一致、canonical key 顺序不影响 |
| 校验 | 缺字段、未知 ref、无证据、非法枚举、超长 quote |
| 人物 | 新增、更新、alias、死亡、失踪、知识增删、物品增删 |
| 关系 | 新增、双向规范化、更新、重复关系、自引用 |
| 主线 | 新 arc、目标更新、冲突、线索开启/解决、伏笔兑现 |
| 幂等 | 同补丁应用两次 |
| 归档 | active 不丢、resolved 有界、pinned anchor 保留 |

### 19.2 数据层

| 类别 | 用例 |
|---|---|
| Migration | v14 → v15、重复执行 |
| Fresh | 三表、索引、外键 |
| Repository | row mapping、非法 JSON、事务回滚 |
| Cascade | 删除项目、删除章节 |
| Snapshot | 最近快照、数量清理 |
| Backup | 导出、恢复、校验 |

### 19.3 服务层

| 类别 | 用例 |
|---|---|
| LLM | 合法、无效、repair、abort |
| Finalize | 新章节、重复定稿、正文变化 |
| Dirty | 修改、删除、重排、版本还原 |
| Rebuild | 空、snapshot、复用、失败、取消 |
| Legacy | 快速初始化 |
| Mutex | 同项目串行、不同项目可并行 |

### 19.4 上下文

| 类别 | 用例 |
|---|---|
| 顺序 | story → resources → episodic → recent |
| 预算 | 各部分不超预算 |
| 裁剪 | 主线和 open threads 优先 |
| Dirty | 过期状态不注入 |
| Trace | included/clipped/reason 正确 |
| TF-IDF | 现有召回无回归 |

### 19.5 端到端场景

至少准备一个 30 章测试小说，包含：

- 8 名人物；
- 12 条关系；
- 3 个剧情弧；
- 人物改名；
- 一次假死；
- 一次背叛；
- 5 个伏笔；
- 3 个线索解决；
- 第 8 章后修改；
- 第 15、16 章重排；
- 第 20 章删除后重建。

验收：

1. 第 30 章上下文中的人物状态正确；
2. 已解决线索不再显示为 open；
3. 未兑现伏笔仍存在；
4. 修改第 8 章后从正确位置重建；
5. 重建结果与从头重放一致；
6. 不出现重复人物；
7. 不出现多个累计摘要重复注入。

---

## 20. 性能与资源约束

### 20.1 不允许的复杂度

- 每次上下文构建不得重新 LLM 总结全书；
- 每次定稿不得扫描并重写全部章节摘要；
- 正常上下文构建不得写数据库；
- 不得在 UI render 中 JSON.parse 大型状态。

### 20.2 目标

- 单章 patch 合并：O(当前状态实体数) 或更优；
- 事件检索保持当前级别；
- Story Memory 读取：单项目单行；
- snapshot 查找：索引查询；
- 100 章重建可分段持久化；
- App 被杀后可从最后 checkpoint 继续；
- `memory_json` 目标控制在 storyStateBudget 的约 2 倍以内；
- 上下文渲染严格不超过 `storyStateBudgetTokens`。

### 20.3 内存

- 不同时加载所有章节完整正文；
- 重建按章读取或使用分页；
- legacy bootstrap 分批；
- JSON canonical stringify 避免保留多份大对象；
- 快照清理及时执行。

---

## 21. 错误码与诊断

建议新增：

```ts
export type StoryMemoryErrorCode =
  | 'MEMORY_NOT_INITIALIZED'
  | 'MEMORY_DIRTY'
  | 'MEMORY_PATCH_INVALID_JSON'
  | 'MEMORY_PATCH_SCHEMA_INVALID'
  | 'MEMORY_EVIDENCE_NOT_FOUND'
  | 'MEMORY_ENTITY_REFERENCE_INVALID'
  | 'MEMORY_BASE_FINGERPRINT_MISMATCH'
  | 'MEMORY_TRANSACTION_FAILED'
  | 'MEMORY_REBUILD_CANCELLED'
  | 'MEMORY_REBUILD_FAILED'
  | 'MEMORY_STATE_CORRUPTED';
```

错误必须写入：

- `project_story_memory.last_error`；
- LLM usage log 的 scenario/status；
- UI Toast / Alert；
- 开发日志。

不得记录 API Key；正文证据日志最多保留前 120 字符。

---

## 22. 验收标准

### 22.1 功能验收

- [ ] 项目级记忆严格显示人物、关系、主线三部分。
- [ ] 每章定稿生成增量 patch，而不是完整累计摘要。
- [ ] `memory_summary` 变为确定性章节事件文本。
- [ ] Story Memory 每次生成强制注入。
- [ ] Episodic Memory 继续 Top-K 召回。
- [ ] 两层记忆各有独立 token 预算。
- [ ] 自动配置能正确计算 128K/200K/512K/1M。
- [ ] 修改旧章节会标记 dirty。
- [ ] AI 生成不会静默使用已过期 Story Memory。
- [ ] 可从 snapshot 重建。
- [ ] 可取消并继续重建。
- [ ] 升级不自动发起 LLM。
- [ ] 旧项目可快速初始化。
- [ ] 备份恢复包含新表。
- [ ] 本地 GGUF 调用仍可生成和解析补丁。
- [ ] 失败不会丢失正文或覆盖旧有效状态。

### 22.2 数据一致性验收

- [ ] 一个项目最多一条 `project_story_memory`。
- [ ] 一个章节最多一个当前 patch。
- [ ] patch ID 唯一。
- [ ] through chapter 与 state fingerprint 一致。
- [ ] dirty position 不晚于首个无效 patch。
- [ ] 重建结果与顺序重放一致。
- [ ] 删除项目无孤儿记录。
- [ ] 同一补丁重复应用 no-op。

### 22.3 质量门禁

```bash
npm run lint
npm run typecheck
npm run test:ci
npm run test:coverage
npm run verify
```

全部通过。

新增文件建议覆盖率：

- storyMemoryMerger：branches ≥ 90%，lines ≥ 95%；
- storyMemoryValidator：branches ≥ 90%，lines ≥ 95%；
- storyMemoryRepository：branches ≥ 80%，lines ≥ 90%；
- storyMemoryRebuild：branches ≥ 80%，lines ≥ 90%；
- contextAutoAllocator：保持或提高现有覆盖率。

### 22.4 手动 Android 验收

- [ ] 真机创建 10 章测试小说；
- [ ] 逐章定稿后 Story Memory 正确推进；
- [ ] 强杀 App 后状态完整；
- [ ] 修改第 3 章后显示 dirty；
- [ ] 下一次 AI 写作前触发重建；
- [ ] 重建进度可见；
- [ ] 取消后可继续；
- [ ] ContextPreview 可见 story memory trace；
- [ ] 备份、清空 App 数据、恢复后状态一致；
- [ ] 无崩溃、ANR、数据库锁死；
- [ ] 本地模型和在线模型各验证一次。

---

## 23. 风险与缓解

| 风险 | 缓解 |
|---|---|
| LLM 仍可能提取错误 | evidenceQuote、严格 ID 引用、结构校验、用户可查看和完整重建 |
| 旧项目完整重建费用高 | legacy bootstrap、延迟初始化、snapshot、patch 复用 |
| 早期章节修改导致大量补丁失效 | base fingerprint、最近快照、checkpoint |
| 结构过大 | 当前状态化、resolved 有界归档、渲染预算裁剪 |
| 小模型 JSON 稳定性差 | 简化范式、一次 repair、清晰错误提示 |
| 人物同名 | canonical alias resolver + 首见章节稳定 ID |
| 用户误以为章节摘要就是全局记忆 | UI 文案分离 |
| Dirty 状态阻断写作 | 可手动重建；失败时仍保留正文和旧事件检索 |
| 自动保存频繁触发 dirty | 只轻量标记，不自动 LLM |
| 并发定稿污染状态 | project mutex + position 顺序校验 |
| 新表影响恢复 | manifest、迁移测试、孤儿校验 |
| IDF 缓存继续读旧内容 | 内容指纹签名 + 显式 invalidate |

---

## 24. 回滚方案

如果 V2.5.0 上线后需要关闭新功能：

1. 增加 feature flag：

   ```text
   structured_story_memory_enabled
   ```

2. 关闭后：
   - 不注入 project story memory；
   - 定稿退回现有 `memory_summary` 事件摘要生成；
   - 新表保留，不删除；
   - 不降级 Schema；
   - 用户数据不丢失。

3. 不执行破坏性 migration。

4. 后续修复后重新开启，可从已有 patch/state 继续。

初版可默认开启，但 feature flag 必须由 settings 支持，便于故障隔离。

---

## 25. 最终交付物清单

### 新增文件

```text
src/services/storyMemory/storyMemoryTypes.ts
src/services/storyMemory/storyMemoryDefaults.ts
src/services/storyMemory/storyMemoryFingerprint.ts
src/services/storyMemory/storyMemoryValidator.ts
src/services/storyMemory/storyMemoryMerger.ts
src/services/storyMemory/storyMemoryRenderer.ts
src/services/storyMemory/storyMemoryPrompts.ts
src/services/storyMemory/storyMemoryService.ts
src/services/storyMemory/storyMemoryRebuild.ts
src/data/repositories/storyMemoryRepository.ts
src/services/migrations/v14-to-v15.ts
src/screens/StoryMemoryScreen.tsx

__tests__/storyMemoryFingerprint.test.ts
__tests__/storyMemoryValidator.test.ts
__tests__/storyMemoryMerger.test.ts
__tests__/storyMemoryRepository.test.ts
__tests__/storyMemoryPrompts.test.ts
__tests__/storyMemoryService.test.ts
__tests__/storyMemoryRebuild.test.ts
__tests__/storyMemoryRenderer.test.ts
__tests__/contextBuilderStoryMemory.test.ts
__tests__/chapterFinalizeStoryMemory.test.ts
__tests__/StoryMemoryScreen.test.tsx
__tests__/migrations-v14-v15.test.ts

docs/V2.5.0-STORY-MEMORY-TEST-REPORT.md
```

### 修改文件

```text
src/services/migrations/index.ts
src/data/schema/createCurrentSchema.ts
src/services/database/schemaManifest.ts
src/services/database.ts
src/types/novel.ts
src/types/contextTrace.ts
src/constants/defaults.ts
src/utils/idfCache.ts
src/services/contextBuilder.ts
src/services/contextAutoAllocator.ts
src/services/summaryGenerator.ts
src/data/repositories/settingsRepository.ts
src/data/repositories/projectRepository.ts
src/screens/chapter-editor/ChapterEditorScreen.tsx
src/screens/chapter-editor/ChapterFields.tsx
src/screens/ContextAutoConfigScreen.tsx
src/screens/ContextPreviewScreen.tsx
src/screens/StoryOverviewScreen.tsx
src/navigation/TabNavigator.tsx
README.md
CHANGELOG.md
docs/CODE_WIKI.md
docs/RELEASE_CHECKLIST.md
```

---

## 26. Definition of Done

只有同时满足以下条件，Agent 才能声明完成：

1. 全部代码、迁移、测试和文档已落地；
2. `npm run verify` 全绿；
3. Schema 14 升级到 15 成功；
4. Fresh install Schema 与升级后 Schema 一致；
5. 30 章端到端测试小说验收通过；
6. 旧项目未初始化时不崩溃、不静默产生费用；
7. 修改早期章节后不会继续注入过期状态；
8. incremental apply 与 full replay 结果一致；
9. Android 真机完成在线模型和本地模型各一次验证；
10. 备份恢复验证通过；
11. 无新增依赖；
12. 无与本功能无关的改动；
13. 提交历史按 Phase 清晰可审查；
14. 测试报告包含：
    - 测试环境；
    - 测试命令；
    - 自动测试结果；
    - Android 手动验证；
    - 已知限制；
    - 剩余风险；
    - 后续建议。

---

## 27. 后续工作（不属于本 spec）

- 用户可视化编辑人物状态和关系；
- 记忆差异对比；
- 以剧情弧为单位的独立快照；
- 向量检索替代 TF-IDF；
- 自由写作模式支持；
- 多模型交叉校验记忆补丁；
- 自动识别章节时间线矛盾；
- 角色卡与 Story Memory 的双向建议更新；
- 云端同步和多设备冲突合并；
- 记忆质量评分与回归基准集。
