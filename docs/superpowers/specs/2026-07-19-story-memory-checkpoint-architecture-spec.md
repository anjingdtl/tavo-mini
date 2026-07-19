# ShineWriter 故事记忆检查点架构调整 — Agent 落地执行 Spec

| 字段 | 值 |
|---|---|
| 文档日期 | 2026-07-19 |
| 文档状态 | 待实现 |
| 当前基线 | V2.5.6 / Schema 15 |
| 目标版本 | 下一功能版本（实施时由维护者确定） |
| 目标 Schema | 16 |
| 优先级 | P0：长篇写作成本、延迟与连续性优化 |
| 前置设计 | `docs/superpowers/specs/2026-07-18-structured-story-memory-design.md` |
| 主要影响范围 | 章节定稿、故事记忆生成、上下文构建、数据库、设置、备份、诊断与测试 |

---

## 0. 文档用途

本 Spec 用于指导编程 Agent 将当前“每章定稿都生成结构化记忆补丁、下一次写作前强制追平到上一章”的机制，调整为：

> **最近正文负责短期连续性；结构化故事记忆作为长期检查点，每 N 章或按智能阈值批量更新。**

本次调整不是关闭故事记忆，也不是简单延迟原有逐章请求。最终实现必须真正减少 LLM 请求次数、重复状态输入和定稿等待，同时保证检查点之后的章节始终能由短期上下文完整承接。

本文是对既有结构化故事记忆设计的增量修订。未被本文明确覆盖的实体模型、证据校验、稳定 ID、状态指纹、项目锁、快照、备份和安全要求继续有效。

---

## 1. Agent 执行契约

### 1.1 开始前必须执行

1. 阅读：

   ```text
   AGENTS.md
   README.md
   CHANGELOG.md
   docs/superpowers/specs/2026-07-18-structured-story-memory-design.md
   docs/V2.5.1-STORY-MEMORY-TEST-REPORT.md
   ```

2. 检查工作区，保留用户已有改动，不得清理历史调试产物：

   ```bash
   git status --short
   ```

3. 从当前分支创建独立分支，默认建议：

   ```bash
   git switch -c codex/story-memory-checkpoints
   ```

4. 记录基线：

   ```bash
   npm ci
   npm run verify
   npm run test:coverage
   ```

### 1.2 强制实现原则

1. 章节正文保存和“章节定稿”不得依赖长期记忆请求成功。
2. 同一项目的检查点生成必须串行；不同项目可以并行。
3. LLM 负责批量章节语义提取，程序负责校验、稳定 ID 分配、确定性合并和持久化。
4. 检查点失败不得覆盖最后一份已验证状态。
5. 检查点后的未整理章节必须在上下文中形成可证明的连续桥接，不能静默遗漏。
6. 所有数据访问继续经过 `src/services/database.ts` facade 或 repository，屏幕不得直接执行 SQL。
7. Schema 变更必须同时修改迁移、fresh schema、manifest、备份恢复和迁移测试。
8. 不新增 npm 依赖，不新增 Android 原生模块，不修改 iOS 内容。
9. 每个 Phase 独立提交；不得夹带无关重构。

### 1.3 明确禁止

- 禁止仅把逐章请求积压到第 N 章，然后连续补跑 N 次 `story_memory_patch` 并宣称完成优化。
- 禁止生成下一章前无条件执行 `ensureStoryMemoryReady(projectId, currentPosition - 1)`。
- 禁止让检查点之后存在未被长期记忆、最近正文或降级桥接覆盖的章节空洞。
- 禁止用 `dirty` 同时表示“历史检查点失效”和“存在尚未归档的新章节”。两者语义必须分离。
- 禁止将 LLM 返回的完整 `StoryMemoryState` 不经领域校验直接写库。
- 禁止删除 Schema 15 的逐章补丁、快照或旧项目数据。
- 禁止因检查点失败把已经定稿的章节改回草稿。
- 禁止在数据库迁移、App 冷启动或普通页面打开时自动产生 LLM 费用。

---

## 2. 当前基线与问题

### 2.1 当前行为

V2.5.6 的关键路径如下：

```text
章节定稿
  → 保存正文
  → finalizeChapterMemory(chapterId)
  → 每章一次 story_memory_patch LLM 请求
  → 校验并应用 ChapterMemoryPatch
  → 写 chapter_memory_patches + project_story_memory

生成下一章
  → buildContext()
  → ensureStoryMemoryReady(projectId, 上一章位置)
  → 如未追平则同步重建
  → 注入全局故事状态
  → 注入资源、Episodic Top-K、最近正文
```

当前默认最近正文配置为 3 章、`slidingWindowSize = 4000`。因此刚定稿的章节通常同时存在于：

1. 已更新的结构化故事状态；
2. Episodic Memory；
3. 最近正文。

### 2.2 已确认问题

1. **请求频率过高**：每章至少一次结构化补丁请求，非法 JSON 时还可能 repair/retry。
2. **重复输入旧状态**：每章补丁请求都会再次携带上一版完整状态。
3. **定稿延迟过高**：用户必须等待记忆请求后才能收到完整成功反馈。
4. **短期信息重复**：最近一至三章既作为正文注入，又已被长期状态吸收。
5. **生成前强制追平抵消任何频率设置**：只增加“每 N 章更新”配置但不移除强制追平，实际请求数不会下降。
6. **状态语义混乱风险**：尚未进入检查点的新章节是正常 pending，不应被视为 dirty/failed。

### 2.3 根因

当前实现把“实时逐章日志”和“长期状态检查点”视为同一更新频率。正确分层应为：

```text
长期层：Story Memory Checkpoint
  - 截至某章的已验证人物、关系和主线状态
  - 低频批量更新

桥接层：Pending Chapter Bridge
  - 检查点之后、当前章之前的未整理章节
  - 直接使用正文，必要时使用章节事件摘要降级

衔接层：Seam Context
  - 紧邻当前章的上一章正文/尾部
  - 始终保留，负责语气、动作和场景衔接
```

---

## 3. 目标与非目标

### 3.1 必须达成的目标

1. 支持 `smart`、`fixed`、`every_chapter`、`manual` 四种项目级更新策略。
2. 默认使用 `smart`，目标间隔 3 章。
3. `fixed(N)` 在通常情况下每 N 个新定稿章节产生一次批量检查点请求。
4. 一次批量请求处理 1～N 章，生成一个**净变化批量补丁**和每章独立事件摘要。
5. 章节定稿先本地成功；仅当到达检查点阈值时才进入长期记忆整理。
6. 生成上下文不再要求 Story Memory 追平上一章，而是注入：
   - 最后有效检查点；
   - 检查点后的 pending bridge；
   - 最近一章 seam context。
7. 如果 pending bridge 无法完整放入预算，必须提前生成检查点或明确降级，不能静默裁掉中间章节。
8. 修改检查点之后的 pending 章节不使旧检查点 dirty；修改检查点覆盖范围内的章节才使其 dirty。
9. 旧 Schema 15 项目可无损升级，原逐章补丁和快照继续可读、可回放。
10. UI 能解释“长期记忆整理到第几章、还有几章待整理、何时下次更新”。
11. 自动化证明请求次数下降，而连续性覆盖不下降。

### 3.2 非目标

本轮不实现：

- 向量数据库或 Embedding；
- 用户直接编辑底层 JSON；
- 自动修改角色卡/世界书；
- 多模型交叉校验；
- Android 后台常驻定时整理；
- 云同步；
- 自由写作单文档模式；
- 以“估计节省百分比”代替真实用量日志对比。

---

## 4. 术语与核心不变量

| 术语 | 定义 |
|---|---|
| Checkpoint | 截至某章的最后一份已验证全局故事状态 |
| Checkpoint Through | 检查点覆盖到的章节 position |
| Pending Chapter | 已定稿但 position 大于 Checkpoint Through 的章节 |
| Pending Bridge | 本次生成时用于覆盖所有 pending 章节的上下文文本 |
| Seam Chapter | 紧邻当前章的上一章，负责直接文风和场景衔接 |
| Soft Due | 已达到期望 N 章，但 pending 仍能完整放入上下文 |
| Hard Due | pending 无法完整放入上下文，再不整理将出现连续性空洞 |
| Batch Patch | 一次请求对一组连续章节产生的最终净变化领域补丁 |
| Dirty | 检查点覆盖范围内的源章节被修改、删除或重排，检查点失效 |

必须始终满足：

```text
checkpointThrough < currentChapter.position

每一个 position ∈ (checkpointThrough, currentChapter.position)
必须被以下至少一种来源覆盖：
  A. Pending Bridge 正文；
  B. 已验证 Episodic Summary 降级桥接。

Seam Chapter 必须始终注入；即使它已被最新 Checkpoint 覆盖也不例外。
```

Story Memory 与上一章正文允许存在**职责重叠**，但不得出现大段文本重复：Story Memory 表达结构化当前状态，Seam Context 表达原始叙事和结尾。新近正文中的明确变化优先级高于较早检查点。

---

## 5. 目标上下文架构

### 5.1 消息顺序

建议保持资源层相对顺序，调整为：

```text
1. 系统提示词 / 写作预设
2. Story Memory Checkpoint（截至第 M 章）
3. 项目资料 / 世界书 / 人物卡 / 笔记
4. Episodic Top-K（排除已进入 raw bridge/seam 的章节）
5. Pending Bridge（第 M+1 章至当前章前）
6. Seam Context（若已在 bridge 中则不重复；至少保留上一章尾部）
7. 当前写作指令
```

实际实现可以继续使用现有 message 结构，但 trace 必须能区分上述来源。

### 5.2 检查点提示语

`storyMemoryRenderer` 的前缀必须从“截至上一已定稿章节”改为明确位置：

```text
以下是截至第 M 章整理并验证的长期故事状态。
第 M+1 章之后的近期正文可能包含更新；若两者冲突，以章节位置更晚的近期正文为准。
除非近期正文或当前写作要求明确改变，否则不得违背该长期状态。
```

禁止在检查点落后于上一章时仍声称“截至上一章”。

### 5.3 Pending Bridge 选择算法

新增纯函数，建议接口：

```ts
export interface StoryMemoryCoveragePlan {
  checkpointThroughPosition: number;
  pendingChapters: Chapter[];
  seamChapter: Chapter | null;
  rawChapterIds: number[];
  episodicFallbackChapterIds: number[];
  uncoveredChapterIds: number[];
  estimatedRawTokens: number;
  hardDue: boolean;
  reason: string;
}

export function planStoryMemoryCoverage(input: {
  currentChapter: Chapter;
  chapters: Chapter[];
  checkpointThroughPosition: number;
  slidingBudgetTokens: number;
}): StoryMemoryCoveragePlan;
```

算法要求：

1. pending 范围为 `(checkpointThroughPosition, currentChapter.position)` 内有正文的章节。
2. 优先按章节顺序完整放入 pending 正文，不得只保留尾部而静默丢掉最早 pending 章。
3. 上一章始终作为 seam 保留；如果已在 pending raw 中，不重复。
4. raw 超预算时，从最早 pending 章开始尝试使用已验证 `memory_summary` 降级；不得使用空摘要冒充覆盖。
5. raw + episodic 仍无法覆盖全部 pending 时，`hardDue = true` 并列出 `uncoveredChapterIds`。
6. Episodic Top-K 必须排除 `rawChapterIds`，避免同一章节既以正文又以事件摘要注入。
7. 所有桥接文本按 position 升序排列。

### 5.4 生成前准备

用以下服务替代当前无条件追平：

```ts
export async function prepareStoryMemoryForGeneration(
  projectId: number,
  currentChapter: Chapter,
  config: ContextConfig,
  signal?: AbortSignal,
): Promise<{
  checkpoint: ProjectStoryMemoryRecord | null;
  coverage: StoryMemoryCoveragePlan;
  checkpointUpdated: boolean;
}>;
```

决策规则：

1. 检查点 `clean` 且 coverage 完整：直接使用，不发 LLM 请求。
2. `softDue` 但 coverage 完整：允许生成；检查点更新由定稿流程或用户手动触发，生成路径不强制付费。
3. `hardDue`：在生成前尝试一次批量检查点更新。
4. hard due 更新失败后重新规划：
   - 若 raw/episodic fallback 已能完整覆盖，允许继续并写 trace 警告；
   - 若仍存在 uncovered chapter，阻止 AI 生成并显示中文可恢复错误，不得静默继续。
5. 检查点 `dirty`：不得注入；先从最近有效快照重建至一个能使 coverage 完整的位置。失败时遵循上一条。
6. `manual` 模式也不能绕过 hard due；manual 表示不做 soft due 自动整理，不表示允许连续性空洞。

---

## 6. 更新策略

### 6.1 配置类型

新增：

```ts
export type StoryMemoryUpdateMode =
  | 'smart'
  | 'fixed'
  | 'every_chapter'
  | 'manual';

export interface StoryMemoryPolicy {
  projectId: number;
  mode: StoryMemoryUpdateMode;
  intervalChapters: number;       // 2～10；默认 3
  pendingTokenSoftLimit: number; // 默认取 slidingWindowSize 的 60%
  updateOnKeyChapter: boolean;
  updatedAt: string;
}
```

UI 含义：

| 模式 | 行为 |
|---|---|
| 智能更新（默认） | 达到 3 章、pending token 接近预算或关键章节时更新 |
| 固定间隔 | 通常每 N 章更新，预算不足时允许提前 |
| 每章更新 | 兼容旧行为；使用 batch size 1 |
| 手动更新 | 仅用户触发或 hard due 时更新 |

### 6.2 Due 判定

新增纯函数：

```ts
export interface StoryMemoryDueDecision {
  due: boolean;
  hard: boolean;
  reason:
    | 'none'
    | 'interval_reached'
    | 'pending_token_limit'
    | 'coverage_gap'
    | 'key_chapter'
    | 'manual'
    | 'dirty_rebuild';
  fromPosition: number | null;
  throughPosition: number | null;
}
```

规则：

- `every_chapter`：pendingCount >= 1 即 soft due。
- `fixed`：pendingCount >= intervalChapters 即 soft due。
- `smart`：以下任一成立即 soft due：
  - pendingCount >= intervalChapters；
  - pending token >= `pendingTokenSoftLimit`；
  - 章节被用户标记为关键章节。
- 任意模式：coverage 存在 uncovered chapter 即 hard due。
- 每批最多 10 章；超过时拆成多个检查点批次，批次之间更新 base fingerprint。
- `intervalChapters` 不得被错误配置为 0、负数、NaN 或大于 10；读取时钳制，保存时校验。

### 6.3 章节定稿语义

定稿拆成两步：

```text
Step A：本地定稿（必须快速且不依赖 LLM）
  - flush 自动保存
  - fresh-read 章节
  - status = final
  - finalized_at = now
  - 提交成功后即可提示“章节已定稿”

Step B：按策略整理长期记忆
  - 未 due：显示“长期记忆待整理 X 章”
  - soft due：发起一次 batch checkpoint 请求
  - 请求失败：章节仍保持 final，保留旧 checkpoint，记录可重试错误
```

不得继续由 `saveStoryMemoryUpdate()` 顺带决定章节是否定稿。新增独立 repository 操作，例如：

```ts
finalizeChapterLocally(chapterId: number, finalizedAt: string): Promise<void>
```

如果本地定稿后尚未生成事件摘要，允许 `memory_summary` 暂时为空；Pending Bridge 必须用正文覆盖该章。检查点批量成功时再原子回写每章独立 `memory_summary`。

---

## 7. 批量检查点协议

### 7.1 为什么不能复用 N 次逐章补丁

如果第 N 章触发后仍逐章调用 LLM：

- 请求次数没有下降；
- 旧状态仍重复输入 N 次；
- repair/retry 风险仍按章节累积；
- 只是把等待从每章移动到第 N 章。

因此新路径必须使用一个批量输入和一个批量输出。

### 7.2 Batch Patch 结构

新增领域类型，复用现有 `NewCharacterPatch`、`CharacterUpdatePatch`、关系与主线 patch 子类型：

```ts
export interface BatchEvidenceQuote {
  chapterId: number;
  quote: string;
}

export interface BatchChapterSummary {
  chapterId: number;
  chapterPosition: number;
  brief: string;
  keywords: string[];
  events: string[];
  characterChanges: string[];
  relationshipChanges: string[];
  mainlineChanges: string[];
  newThreads: string[];
  resolvedThreads: string[];
}

export interface StoryMemoryBatchPatchDraft {
  schemaVersion: 2;
  rangeRef: {
    fromChapterId: number;
    fromPosition: number;
    throughChapterId: number;
    throughPosition: number;
  };
  chapterSummaries: BatchChapterSummary[];
  newCharacters: BatchNewCharacterPatch[];
  characterUpdates: BatchCharacterUpdatePatch[];
  newRelationships: BatchNewRelationshipPatch[];
  relationshipUpdates: BatchRelationshipUpdatePatch[];
  mainlinePatch: BatchMainlinePatch;
}
```

所有会改变状态的 batch item 使用：

```ts
evidence: BatchEvidenceQuote[];
```

替代单章 `evidenceQuote`。每条 evidence 必须引用本批次章节，并能在对应章节正文中找到。

### 7.3 净变化语义

Batch Patch 表达“从上一检查点到批次末尾的最终净变化”，而不是逐章操作日志。例如人物在第 7 章到达车站、第 8 章离开车站、第 9 章到达旅馆，批量 patch 的最终位置应为旅馆，同时 evidence 可以引用第 9 章。

要求：

1. 新人物可以在同一 batch 内被关系和主线条目引用，使用唯一 `new_char_*` 临时引用。
2. 已有人物必须使用输入检查点中的精确稳定 ID。
3. 新人物的最终 current state 应反映批次末尾，而非首次出场瞬间。
4. `chapterSummaries` 必须与输入章节一一对应、顺序一致，不得缺章或重复。
5. 中间发生后又撤销、且不影响批次末尾状态的事件仍应出现在对应章节摘要，但不应污染最终全局状态。
6. 不允许 LLM 返回完整 `StoryMemoryState`。

### 7.4 Prompt 输入

单次请求包含：

```text
1. 固定 system prompt
2. 上一检查点 compact state
3. 按 position 升序的 1～10 个章节：ID、position、标题、概要、正文
4. 严格 JSON 范式
5. evidence 与引用契约
```

场景名：

```text
story_memory_checkpoint
story_memory_checkpoint_repair
story_memory_checkpoint_retry
story_memory_checkpoint_legacy_bootstrap
```

请求继续使用：

- `temperature: 0.1`；
- `responseFormat: 'json_object'`；
- `queueClass: 'background'`；
- 同项目互斥锁；
- 现有 transient retry 与 AbortSignal 语义。

输出预算不能继续简单使用单章 `memoryPatchMaxTokens`。新增按批次计算：

```ts
checkpointMaxTokens = clamp(
  memoryPatchMaxTokens * max(1, sqrt(batchSize)),
  2400,
  16000,
);
```

实施 Agent可在测试证明更稳定后调整公式，但必须有上限、测试和自动预算配置说明。

### 7.5 校验

新增 `validateStoryMemoryBatchPatch()`，至少验证：

1. range 与输入首尾章节完全一致；
2. 章节连续且按 position 升序；
3. summaries 一章一条；
4. evidence 的 chapterId 属于批次；
5. quote 可在对应正文找到，继续复用现有轻微意译恢复策略；
6. existing ID、temp ref、关系双方和主线引用合法；
7. 不允许同一人物同时出现互斥最终状态；
8. 不允许引用未来或批次外章节；
9. 最终 through position 必须等于批次末章；
10. 无效结果不得部分写库。

### 7.6 确定性合并

新增纯函数：

```ts
applyStoryMemoryBatchPatch(
  previous: StoryMemoryState,
  draft: StoryMemoryBatchPatchDraft,
  context: BatchApplyContext,
): ApplyBatchPatchResult;
```

尽量抽取并复用现有 `storyMemoryMerger.ts` 的领域操作，禁止复制两套人物/关系/主线合并规则后长期漂移。

稳定 ID 的 seed 使用首次证据章节，而不是批次末章：

```text
char_<projectId>_<hash(normalizedName|firstEvidenceChapterId)>
```

这保证不同 batch size 或从头重建时产生相同 ID。

---

## 8. Schema 16 与持久化

### 8.1 新表：项目策略

```sql
CREATE TABLE IF NOT EXISTS project_story_memory_policy (
  project_id INTEGER PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'smart',
  interval_chapters INTEGER NOT NULL DEFAULT 3,
  pending_token_soft_limit INTEGER NOT NULL DEFAULT 2400,
  update_on_key_chapter INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

不依赖 SQLite `CHECK` 作为唯一校验；repository 仍需执行枚举与范围校验。

### 8.2 新表：批量检查点记录

```sql
CREATE TABLE IF NOT EXISTS story_memory_batches (
  batch_id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  from_chapter_id INTEGER NOT NULL,
  from_position INTEGER NOT NULL,
  through_chapter_id INTEGER NOT NULL,
  through_position INTEGER NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 2,
  source_fingerprint TEXT NOT NULL,
  base_state_fingerprint TEXT NOT NULL,
  result_state_fingerprint TEXT NOT NULL DEFAULT '',
  patch_json TEXT NOT NULL DEFAULT '{}',
  chapter_summaries_json TEXT NOT NULL DEFAULT '[]',
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'generated',
  last_error TEXT NOT NULL DEFAULT '',
  generated_at TEXT NOT NULL,
  applied_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (from_chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
  FOREIGN KEY (through_chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_story_memory_batches_project_range
ON story_memory_batches(project_id, from_position, through_position);

CREATE INDEX IF NOT EXISTS idx_story_memory_batches_project_through
ON story_memory_batches(project_id, through_position DESC);

CREATE INDEX IF NOT EXISTS idx_story_memory_batches_status
ON story_memory_batches(status);
```

### 8.3 保留现有表

以下表不得删除或破坏：

```text
project_story_memory
chapter_memory_patches
story_memory_snapshots
```

兼容规则：

1. Schema 15 升级时不生成 LLM 数据、不改写现有 state。
2. 现有 `project_story_memory` 直接视为升级时的最后检查点。
3. 现有 `chapter_memory_patches` 保留为历史 v1 记录和旧范围重建来源。
4. 新批次从 `throughChapterPosition + 1` 开始写入 `story_memory_batches`。
5. `last_applied_patch_id` 可继续保存最后应用单元 ID；v2 batch 使用 `batch_<...>`。
6. snapshot 继续保存完整状态，默认每次成功 batch 至少创建一个 snapshot；原“每 10 章”策略可保留为额外去重条件，但不能导致 batch 完成后完全没有恢复点。

### 8.4 原子保存

新增：

```ts
saveStoryMemoryBatchUpdate(input: {
  previousFingerprint: string;
  state: StoryMemoryState;
  batch: StoredStoryMemoryBatch;
  chapterSummaries: Array<{
    chapterId: number;
    text: string;
    estimatedTokens: number;
  }>;
  createSnapshot: boolean;
}): Promise<void>;
```

同一 SQLite 事务必须完成：

1. 条件检查当前 `project_story_memory.state_fingerprint` 仍等于 `previousFingerprint`；
2. upsert batch applied 记录；
3. upsert project state；
4. 回写批次内各章 `memory_summary`；
5. 写 snapshot；
6. 清理超量 snapshot。

任一步失败必须整体回滚。禁止先写 project state 后逐章更新摘要。

### 8.5 Manifest 与备份

必须更新：

```text
src/data/schema/createCurrentSchema.ts
src/services/migrations/v15-to-v16.ts
src/services/migrations/index.ts
src/services/database/schemaManifest.ts
src/services/database.ts
```

`project_story_memory_policy` 和 `story_memory_batches` 必须 `backup: true`。建议恢复顺序：

```text
projects
chapters
project_story_memory
chapter_memory_patches
story_memory_snapshots
project_story_memory_policy
story_memory_batches
```

恢复后必须校验 batch 首尾章节均存在、project_id 一致、project state fingerprint 可解析。API Key 规则不变。

---

## 9. Dirty、修改、删除与重排

### 9.1 新章节 pending 不等于 dirty

如果新定稿章节 position 大于 checkpoint through：

```text
checkpoint.status 保持 clean
pendingCount 通过章节查询派生
不得设置 dirty_from_position
```

### 9.2 修改章节

保存已定稿章节时：

- `editedPosition <= checkpointThroughPosition`：标记 `dirty`，dirty 起点取最早值。
- `editedPosition > checkpointThroughPosition`：checkpoint 仍有效；使覆盖该范围的 generated/failed batch 失效或删除，但不标记全局 state dirty。
- 修改后章节仍为 final 还是转 draft，保持现有产品语义；无论哪种，coverage 只能使用 fresh-read 内容。

### 9.3 删除与重排

- 删除/重排发生在 checkpoint 覆盖范围内：标 dirty，从最近早于影响位置的 snapshot 重建。
- 仅影响 pending 范围：废弃重叠 batch，重新派生 pending 范围。
- 删除 batch 的首尾章节时不得留下无法映射的 batch；外键级联后 repository 必须能从剩余有效 snapshot 恢复。
- position 不连续时按实际排序处理，但 batch range 必须保存首尾 position，并记录参与 chapterIds 指纹；不得假设 ID 连续。

### 9.4 重建

重建策略：

1. 找到早于 dirty 起点的最近 snapshot。
2. Schema 15 历史范围允许复用 source/base fingerprint 均匹配的 v1 chapter patch。
3. 新范围优先复用完全匹配的 applied batch。
4. 不匹配范围按当前 policy 分批生成 v2 batch。
5. 每个成功 batch 形成恢复点；取消或失败保留最后成功点。
6. 完整重建的 canonical 最终状态必须与按同一 batch 划分顺序重建一致。

注意：不同 batch size 下稳定 ID 必须一致；业务最终状态允许因模型语义差异存在质量波动，因此自动测试使用确定性 fixture/model 响应验证确定性合并，不宣称不同真实模型输出逐字一致。

---

## 10. UI 与交互

### 10.1 Story Memory 页面

状态卡改为作者可理解的两段信息：

```text
长期记忆：正常
已整理到：第 6 章
待整理：第 7～8 章（2章）
更新方式：智能更新（通常每3章）
预计下次：第9章定稿后
上下文覆盖：完整
```

术语替换：

| 当前文案 | 新文案 |
|---|---|
| Dirty 起点 | 需要重新整理的位置 |
| 来源：完整正文 | 整理来源：章节正文 |
| active | 活跃 |
| ISO 时间 | 本地化日期时间 |

关系区必须把 `fromCharacterId/toCharacterId` 映射为 canonical name；找不到时显示“未知人物（短 ID）”，不得直接展示长内部 ID。

### 10.2 设置

在故事记忆页面增加“更新策略”，不必塞入全局设置首页：

```text
更新方式
  ○ 智能更新（推荐）
  ○ 固定间隔
  ○ 每章更新
  ○ 仅手动更新

固定间隔：每 [3] 章
关键章节立即整理：[开]
```

范围 2～10。切换策略不立即发 LLM 请求；保存后显示下次触发条件。

### 10.3 按钮简化

主操作：

```text
立即整理长期记忆
```

高级操作折叠：

```text
从上次失败处继续
从有效检查点重建
清空并重建
```

“快速初始化”仅对旧项目/空状态显示。清空操作继续二次确认。

### 10.4 定稿反馈

未 due：

```text
章节已定稿
长期记忆待整理 2 章，将在第 9 章后更新。
```

due 且成功：

```text
章节已定稿
长期记忆已整理到第 9 章。
```

due 但失败：

```text
章节已定稿，但长期记忆整理失败。
正文已安全保存，可稍后重试。
```

### 10.5 Context Preview

新增/扩展 trace：

```ts
kind: 'story_memory'          // 检查点
kind: 'story_memory_bridge'   // pending bridge
kind: 'recent'                // seam/recent raw
```

至少显示：

- 检查点截至章节；
- pending raw 章节范围；
- episodic fallback 章节范围；
- 是否 hard due；
- 是否存在 uncovered chapter；
- 去重排除了哪些 Episodic Top-K 章节；
- 实际 token 与裁剪状态。

---

## 11. 错误处理与降级

建议新增错误码：

```ts
| 'MEMORY_CHECKPOINT_INVALID_JSON'
| 'MEMORY_CHECKPOINT_SCHEMA_INVALID'
| 'MEMORY_CHECKPOINT_EVIDENCE_NOT_FOUND'
| 'MEMORY_CHECKPOINT_RANGE_MISMATCH'
| 'MEMORY_CHECKPOINT_COVERAGE_GAP'
| 'MEMORY_CHECKPOINT_TRANSACTION_FAILED'
| 'MEMORY_CHECKPOINT_CANCELLED'
| 'MEMORY_CHECKPOINT_FAILED'
```

降级规则：

1. soft due 失败：保留旧 checkpoint，pending 正文继续桥接，不阻止写作。
2. hard due 失败但 coverage 可由摘要补齐：允许写作，Context Preview 显示警告。
3. hard due 失败且存在 uncovered：阻止 AI 生成，提供“重试整理 / 调整上下文预算 / 取消”路径。
4. dirty checkpoint 不得注入；不得用“可能还差不多正确”的旧状态静默降级。
5. 取消请求不记录为数据损坏；状态回到可重试，章节仍 final。
6. 日志不得记录 API Key；evidence/正文日志最多保留 120 字符。

---

## 12. 用量、性能与成功指标

### 12.1 必须记录的 usage scenario

新增 scenario 后，LLM 用量日志应可分别统计：

```text
story_memory_checkpoint
story_memory_checkpoint_repair
story_memory_checkpoint_retry
story_memory_checkpoint_legacy_bootstrap
```

保留旧 `story_memory_patch*` 供兼容模式和历史分析。

### 12.2 可自动验收的指标

使用 30 章确定性测试小说、默认 interval 3：

- 正常增量定稿的主请求数应为 10，而不是 30；
- 无 repair 时 `story_memory_checkpoint*` 总主请求数不得超过 `ceil(30 / 3)`；
- 非 due 章节定稿不得调用 LLM；
- 生成上下文且 coverage 完整时不得调用 LLM；
- 每次上下文构建的 uncovered chapter 数必须为 0；
- 同一 raw 章节不得再次进入 Episodic Top-K；
- 数据库写入失败时旧 checkpoint fingerprint 不变。

### 12.3 真实成本评估

测试报告必须同时记录：

- 主请求次数；
- repair/retry 次数；
- input/output/total tokens；
- 30 章总耗时；
- 平均非 due 定稿耗时；
- 平均 checkpoint 定稿耗时；
- 峰值 batch 输入 tokens；
- 在线模型与本地模型各自结果。

不得在没有真实 usage log 的情况下声称“节省 66% Token”。请求数可按数学证明下降，Token 节省必须由实测给出。

---

## 13. 实施 Phase

### Phase 0：锁定现有行为

新增/补充测试：

```text
__tests__/chapterFinalizeStoryMemory.test.ts
__tests__/contextBuilderStoryMemory.test.ts
__tests__/storyMemoryRebuild.test.ts
__tests__/storyMemoryRepository.test.ts
```

锁定：

- 当前逐章定稿；
- ensure ready 强制追平；
- dirty 与 snapshot 行为；
- 失败不丢正文；
- 备份三表 round-trip。

验收：

```bash
npx jest __tests__/chapterFinalizeStoryMemory.test.ts \
  __tests__/contextBuilderStoryMemory.test.ts \
  __tests__/storyMemoryRebuild.test.ts --runInBand
```

建议提交：

```text
test(story-memory): lock pre-checkpoint behavior
```

### Phase 1：策略与 coverage 纯函数

新增建议：

```text
src/services/storyMemory/storyMemoryPolicy.ts
src/services/storyMemory/storyMemoryCoverage.ts
__tests__/storyMemoryPolicy.test.ts
__tests__/storyMemoryCoverage.test.ts
```

本 Phase 不调用 LLM、不改 UI、不改数据库。

必须覆盖：

- 四种 mode；
- interval clamp；
- soft/hard due；
- pending 0/1/3/10/11 章；
- raw 恰好等于预算；
- raw 超预算但摘要可补；
- raw 和摘要均不足；
- seam 去重；
- Top-K 排除 raw IDs；
- 章节 position 有空洞。

建议提交：

```text
feat(story-memory): plan checkpoint policy and context coverage
```

### Phase 2：Schema 16 与 repository

新增/修改：

```text
src/services/migrations/v15-to-v16.ts
src/services/migrations/index.ts
src/data/schema/createCurrentSchema.ts
src/services/database/schemaManifest.ts
src/data/repositories/storyMemoryRepository.ts
src/services/database.ts
__tests__/migrations-v15-v16.test.ts
__tests__/storyMemoryRepository.test.ts
__tests__/backupService.test.ts
```

必须覆盖：

- v15→v16；
- fresh schema 一致；
- 重复迁移安全；
- policy 默认值与 round-trip；
- batch generated/applied/failed round-trip；
- 原子保存与 rollback；
- 外键级联；
- manifest/backup/restore；
- Schema 15 数据升级后原 state/patch/snapshot 不变。

建议提交：

```text
feat(database): persist story memory checkpoint batches
```

### Phase 3：批量 Prompt、校验和合并

新增/修改：

```text
src/services/storyMemory/storyMemoryTypes.ts
src/services/storyMemory/storyMemoryPrompts.ts
src/services/storyMemory/storyMemoryValidator.ts
src/services/storyMemory/storyMemoryMerger.ts
src/services/storyMemory/storyMemoryCheckpointService.ts
__tests__/storyMemoryCheckpointPrompts.test.ts
__tests__/storyMemoryCheckpointValidator.test.ts
__tests__/storyMemoryCheckpointMerger.test.ts
__tests__/storyMemoryCheckpointService.test.ts
```

必须覆盖：

- 1/3/10 章 batch；
- summaries 一一对应；
- 新人物跨 batch item 引用；
- 最终净状态；
- evidence 归属错误；
- 未知 ID/temp ref；
- JSON 截断；
- repair 成功、retry 成功、三次失败；
- AbortSignal；
- 同项目串行、不同项目并行；
- stable ID 不受 batch size 影响；
- base fingerprint CAS 冲突不覆盖。

建议提交：

```text
feat(story-memory): generate validated checkpoint batches
```

### Phase 4：定稿与调度接线

修改：

```text
src/screens/chapter-editor/ChapterEditorScreen.tsx
src/services/storyMemory/storyMemoryService.ts
src/services/storyMemory/storyMemoryRebuild.ts
src/data/repositories/*chapter*.ts（按实际仓库文件定位）
```

要求：

- 拆出本地定稿；
- 非 due 不调用 LLM；
- due 一次批量请求；
- 失败不回滚定稿；
- pending 编辑不误标 dirty；
- `every_chapter` 可回退旧体验；
- feature flag 关闭时保持既有 fallback。

测试：

```text
__tests__/chapterFinalizeCheckpoint.test.ts
__tests__/chapterEditorCheckpointFlow.test.tsx
__tests__/chapterClearRace.test.tsx
__tests__/chapterAutosaveFailure.test.tsx
```

建议提交：

```text
feat(editor): finalize chapters with scheduled memory checkpoints
```

### Phase 5：上下文分层与强制追平移除

修改：

```text
src/services/contextBuilder.ts
src/services/storyMemory/storyMemoryRenderer.ts
src/types/contextTrace.ts
src/utils/idfCache.ts
```

要求：

- 删除/替换无条件追平逻辑；
- checkpoint/pending/seam 分层；
- 最近正文优先于较早 checkpoint；
- raw 与 Episodic Top-K 去重；
- hard due 才允许生成前触发检查点；
- preview 模式不得发 LLM。

测试：

```text
__tests__/contextBuilderStoryMemory.test.ts
__tests__/storyMemoryRenderer.test.ts
__tests__/contextPreviewStoryMemory.test.tsx
```

建议提交：

```text
feat(context): bridge recent chapters from memory checkpoints
```

### Phase 6：UI 与诊断

修改：

```text
src/screens/StoryMemoryScreen.tsx
src/screens/ContextPreviewScreen.tsx
src/screens/StoryOverview.tsx
相关 UI 测试与 jest.setup.js（仅在新增依赖时）
```

要求：

- 策略配置；
- pending 范围与下次触发；
- 简化按钮；
- 人物 ID 映射；
- 中文状态；
- 本地化时间；
- 无障碍 label、按钮目标尺寸和重建进度播报。

建议提交：

```text
feat(ui): explain and control story memory checkpoints
```

### Phase 7：长篇、备份与发布回归

执行：

```bash
npm run lint
npm run typecheck
npm run test:ci
npm run test:coverage
npm run verify
npm run apk:debug
```

更新：

```text
README.md
CHANGELOG.md
docs/RELEASE_CHECKLIST.md
docs/FAULT_INJECTION_MATRIX.md
新增版本对应 STORY-MEMORY-CHECKPOINT-TEST-REPORT.md
```

建议提交：

```text
docs(story-memory): document checkpoint architecture verification
```

---

## 14. 测试矩阵

### 14.1 策略与覆盖

| 场景 | 预期 |
|---|---|
| 第 1、2 章定稿，interval=3 | 不调用 checkpoint，pending=2 |
| 第 3 章定稿 | 一次 batch 覆盖 1～3 |
| checkpoint 到 6，写第 9 章 | 注入 checkpoint 6 + raw 7/8 |
| checkpoint 到 6，raw 7/8 超预算但摘要齐全 | 摘要降级完整覆盖，hard due 可提前整理 |
| raw/摘要均不能覆盖第 7 章 | hard due；整理失败则阻止生成 |
| manual 且 coverage 完整 | 不自动整理 |
| manual 且存在空洞 | 强制 hard due，不允许静默跳过 |
| 每章模式 | batch size 1，行为兼容 |

### 14.2 数据一致性

| 场景 | 预期 |
|---|---|
| batch 保存中第 2 条摘要写失败 | state/batch/所有摘要全部回滚 |
| base fingerprint 被并发修改 | CAS 失败，旧状态不覆盖新状态 |
| 删除项目 | policy/batch/state/patch/snapshot 全部级联删除 |
| v15 升级 | 旧 state/patch/snapshot 字节语义保持 |
| 备份恢复 | policy/batch 与 checkpoint 指纹一致 |
| 非法 batch JSON | 明确错误，不写部分数据 |

### 14.3 修改与重建

| 场景 | 预期 |
|---|---|
| checkpoint=6，修改第 8 章 | checkpoint 保持 clean，pending fresh-read |
| checkpoint=6，修改第 4 章 | dirty from 4，不注入旧 checkpoint |
| checkpoint=6，删除第 8 章 | pending 重新派生，不误伤 checkpoint |
| checkpoint=6，删除第 4 章 | 从早于 4 的 snapshot 重建 |
| batch 在途取消 | 保留上次 checkpoint，可继续 |
| App 在 batch 响应后、事务前被杀 | 下次仍从旧 checkpoint 重试 |

### 14.4 30 章端到端

测试小说至少包含：

- 8 名人物、12 条关系；
- 3 个剧情弧；
- 改名、假死、背叛；
- 5 个伏笔、3 个线索回收；
- 第 8 章修改；
- 第 15/16 章重排；
- 第 20 章删除后重建。

默认 smart/interval 3 验收：

1. 正常主 checkpoint 请求约 10 次，不是 30 次；
2. 每次生成 coverage 均无空洞；
3. 第 30 章人物最终状态、开放线索和未兑现伏笔正确；
4. 最近正文不会重复进入 Episodic Top-K；
5. 修改第 8 章后从正确 snapshot 重建；
6. 取消、失败、恢复均不丢章节正文；
7. 在线 OpenAI 兼容模型和本地 GGUF 各完成至少一次 3 章 batch；
8. 无崩溃、ANR、SQLite locked、OOM。

---

## 15. 兼容与回滚

### 15.1 Feature Flag

保留现有：

```text
structured_story_memory_enabled
```

新增：

```text
story_memory_checkpoint_scheduler_enabled
```

回滚行为：

- 关闭 scheduler：回到 `every_chapter` 兼容路径；
- 不删除 v2 batch、policy 或 Schema 16 表；
- 不降级数据库；
- 已生成 checkpoint 仍可读取；
- 关闭整个 structured memory：继续使用既有 episodic summary fallback。

### 15.2 灰度建议

1. 开发/测试构建默认开启 scheduler。
2. 首个正式版本保留显式回退开关。
3. 用量日志至少收集一个版本周期后，再考虑删除旧逐章生成路径。
4. 本 Spec 不授权删除 v1 patch 类型、表和测试。

---

## 16. 验收清单

### 16.1 功能

- [ ] 默认智能模式，目标每 3 章整理一次。
- [ ] 非 due 定稿不调用 LLM。
- [ ] due 时一次请求覆盖整批章节。
- [ ] 生成前不再无条件追平到上一章。
- [ ] checkpoint、pending bridge、seam context 职责清晰。
- [ ] raw bridge 与 Episodic Top-K 按 chapterId 去重。
- [ ] hard due 不允许连续性空洞。
- [ ] 新章节 pending 不被标成 dirty。
- [ ] pending 章节修改不使有效 checkpoint 失效。
- [ ] 旧章节修改从正确位置重建。
- [ ] 定稿成功不依赖 checkpoint 成功。
- [ ] UI 显示待整理范围和下次触发。

### 16.2 数据

- [ ] Schema 15→16 成功且幂等。
- [ ] fresh install 与升级 Schema 一致。
- [ ] 新表进入 manifest 和备份恢复。
- [ ] batch/state/summaries/snapshot 单事务提交。
- [ ] base fingerprint 使用 CAS 防止并发覆盖。
- [ ] v1 patch、旧 snapshot 和旧 state 无损保留。
- [ ] 删除项目无孤儿数据。

### 16.3 质量门禁

```bash
npm run lint
npm run typecheck
npm run test:ci
npm run test:coverage
npm run verify
npm run apk:debug
```

全部通过。新增核心文件建议最低覆盖率：

- policy/coverage：branches ≥ 90%，lines ≥ 95%；
- batch validator/merger：branches ≥ 90%，lines ≥ 95%；
- checkpoint service：branches ≥ 80%，lines ≥ 90%；
- repository 新路径：branches ≥ 80%，lines ≥ 90%。

### 16.4 Android 手动验收

- [ ] 新建项目，智能模式下前两章定稿无记忆网络请求。
- [ ] 第三章定稿只产生一次 batch 请求。
- [ ] 强杀 App 后 pending 范围可重新派生。
- [ ] 切换每章/固定/手动策略后重启仍持久化。
- [ ] 修改 pending 章，checkpoint 仍正常。
- [ ] 修改 checkpoint 内章节，页面显示需要重新整理。
- [ ] Context Preview 能看见 checkpoint 和 pending bridge。
- [ ] 清空 App 数据并恢复备份后策略、batch、state 一致。
- [ ] 在线模型、本地 GGUF 各验证一次。
- [ ] 无崩溃、ANR、数据库锁死。

---

## 17. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 单次 batch 输出更大，JSON 更易截断 | batch 上限 10、动态输出预算、repair/retry、严格完整性校验 |
| 批量净变化遗漏中间事件 | 每章独立 chapterSummary；最终状态与事件历史职责分离 |
| 新人物跨章节引用复杂 | batch 级 temp ref；稳定 ID 基于首次 evidence 章节 |
| checkpoint 落后导致旧状态与新正文冲突 | 明确截至章节；新近正文优先；pending bridge 全覆盖 |
| 固定 N 大于短期预算能力 | token soft limit 提前触发；hard due 强制整理 |
| 手动模式长期不整理 | coverage 规划与 hard due 底线不允许空洞 |
| 定稿后记忆失败让用户误以为正文丢失 | 两步反馈；明确“正文已安全保存” |
| Schema 16 增加恢复复杂度 | manifest、迁移矩阵、事务和 backup round-trip 测试 |
| 不同 batch size 导致稳定 ID 变化 | ID seed 使用首次 evidence chapterId，不使用批次末章 |
| 请求数下降但 Token 未显著下降 | 用 usage logs 实测，不提前承诺百分比 |

---

## 18. 建议提交顺序

```text
test(story-memory): lock pre-checkpoint behavior
feat(story-memory): plan checkpoint policy and context coverage
feat(database): persist story memory checkpoint batches
feat(story-memory): generate validated checkpoint batches
feat(editor): finalize chapters with scheduled memory checkpoints
feat(context): bridge recent chapters from memory checkpoints
feat(ui): explain and control story memory checkpoints
docs(story-memory): document checkpoint architecture verification
```

每个提交必须可独立审查。Schema 提交不得与 UI 大改混在一起。

---

## 19. Definition of Done

Agent 只有在以下条件全部满足时才能声明完成：

1. Schema、迁移、fresh install、manifest、备份恢复全部对齐；
2. 批量协议是真正的一次请求，不是 N 次逐章补跑；
3. 默认 3 章策略的 30 章主请求数测试通过；
4. 任意生成上下文的 pending coverage 可证明完整；
5. 非 due 定稿和普通 context build 不产生故事记忆 LLM 请求；
6. 定稿、取消、失败、强杀和事务失败均不丢正文；
7. dirty 与 pending 语义分离并有回归测试；
8. 旧 Schema 15 数据无损升级，v1 patch 可继续回放；
9. `npm run verify`、coverage 和 Android Debug 构建通过；
10. 在线模型与本地 GGUF 的 3 章 batch 手动验证完成；
11. 测试报告记录请求数、Token、耗时、失败与剩余风险；
12. README、CHANGELOG、Release Checklist 和故障注入矩阵已更新；
13. 无新增依赖、无无关改动、无凭据或正文泄漏到日志；
14. 每个 Phase 有独立、清晰的提交记录。

---

## 20. Agent 最终交付格式

完成实现后，Agent 必须输出：

1. 实际采用的策略与偏离本 Spec 的地方；
2. Schema 16 迁移和回滚说明；
3. 修改文件清单；
4. 定向测试、全量测试、coverage、Debug 构建结果；
5. 30 章请求数与 usage token 对比；
6. Android 在线模型/本地模型验证结果；
7. 已知限制和未关闭风险；
8. 各 Phase commit SHA；
9. 是否满足 Definition of Done；如未满足，明确阻塞项，不得模糊宣称完成。
