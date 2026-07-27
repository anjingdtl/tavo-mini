# ShineWriter 原著续写改造工程 Spec：Phase 2（修订版）

> 文档状态：Ready after Phase 1 Definition of Done  
> 修订日期：2026-07-27  
> 施工基线：Phase 1 完成后的 Schema 19；本阶段目标 Schema 20  
> 工程主题：原著分析、Active Canon Snapshot、证据与人工治理  
> 硬依赖：Phase 1 的 active source、UTF-16 offset、只读 chunks/chapters、严格边界、format v3 备份和 bounded SourceReader 已完成  
> 后续依赖：Phase 3 只能读取本阶段公开的 `CanonQueryService`，不得直接查询 Canon 表

## 1. 背景

原著续写不能只依赖相似段落检索。要维持长篇连贯性，系统必须理解并管理以下五类核心 Canon：

1. 原著世界观。
2. 人物画像。
3. 人物关系链。
4. 主线剧情。
5. 人物个人经历。

五类 Canon 必须共享章节时间、原文证据、置信度、审核状态和有效范围。Phase 2 的目标是让系统“读懂原著”，而不是开始生成续写正文。

## 2. 本阶段目标

1. 建立结构化 Canon 数据模型。
2. 按续写边界分析原著，禁止未来原文泄漏。
3. 提取世界规则、人物画像、人物状态、人物关系、主线/支线、人物经历。
4. 建立人物别名和实体合并机制。
5. 建立人物知识边界，记录已知、未知、怀疑和误解。
6. 每条关键 Canon 都可追溯到原文证据。
7. 提供待确认、确认、锁定、忽略和废弃状态。
8. 支持暂停、恢复、失败重试和局部重建。
9. 提供“原著分析”与五类资料管理 UI。
10. 为 Phase 3 提供按章节位置、人物和剧情检索 Canon 的服务接口。
11. 建立可原子激活、可过期、可审计的 Canon snapshot；未激活 run 不得污染 Phase 3。

## 3. 非目标

本阶段不实现：

- 正文 Planner、Writer、Checker、Repairer。
- 自动把 AI 生成正文写入章节。
- 自动更新原著 Canon。
- 向量数据库作为硬依赖。
- Neo4j 或外部图数据库。
- 全书风格模仿生成。
- 续写章节状态回灌。
- 无人工确认直接锁定全部 AI 结论。
- 读取续写边界之后的原文构建 Canon。

## 4. 核心设计原则

### 4.1 Canon 是事实系统，不是五份长摘要

五类数据必须可互相连接：

```text
世界观规则
  ↓ 约束
剧情事件
  ↓ 形成
人物个人经历
  ↓ 改变
人物画像与当前状态
  ↓ 影响
人物关系
  ↓ 推动
主线剧情
```

### 4.2 所有信息都具有时间位置

关键字段：

- 首次成立章节。
- 有效起始位置。
- 有效终止位置。
- 最后确认章节。
- 续写起点时是否有效。
- 原文证据。

### 4.3 原文证据优先于 AI 总结

没有有效证据的候选：

- 可以保存为低置信度待确认项。
- 不得成为 `locked` 硬约束。
- Phase 3 默认不作为强事实。

### 4.4 原著 Canon 与续写状态分离

本阶段产生的是“原著 Canon”。

Phase 3 产生的续写事件和状态不得覆盖原著 Canon，而应进入独立的续写状态层。

### 4.5 未来剧情零泄漏

分析 snapshot 必须绑定：

- source ID。
- source version。
- normalized hash。
- parser version。
- boundary chapter。
- boundary offset。

任一项变化，分析结果必须标记过期。

### 4.6 两套时间命名空间不可混用

- 本阶段 Canon 的时间只使用 Phase 1 `SourceChapterPosition` 和 `Utf16Offset`。
- 所有 `char_start/char_end` 都是规范化原著全文的全局 UTF-16 offset，范围为 `[start, end)`；不得存章节局部 offset。
- Phase 3 的 `chapters.position` 是 `ContinuationChapterPosition`，不得传给本阶段 `atSourcePosition`。
- Phase 3 查询原著 Canon 时使用 active snapshot 的 boundary；续写后的状态覆盖由 Phase 3 `EffectiveContinuationState` 负责。
- 自定义边界位于章节中间时，分析输入必须来自 `BoundedSourceChapter`，不得读取该章剩余正文。

### 4.7 Active Snapshot 是唯一发布边界

```text
analysis run/batches
  -> staging Canon rows
  -> evidence validation
  -> snapshot awaiting_review
  -> 用户审核/允许的完成策略
  -> 原子激活 snapshot ready
```

- `continuation_settings.active_canon_snapshot_id` 是 Phase 3 可读 Canon 的唯一入口。
- Query Service 不得按最新 run、最新时间或 completed 状态猜测 active snapshot。
- failed/cancelled/outdated/staging snapshot 永远不可进入 Phase 3。
- 同一项目数据库层最多一个 `ready` snapshot。

## 5. Canon 公共字段

所有 Canon 实体应包含以下语义：

```ts
type CanonReviewStatus =
  | 'pending'
  | 'confirmed'
  | 'locked'
  | 'ignored'
  | 'superseded';

type CanonOrigin = 'ai' | 'user';

interface CanonTemporalFields {
  validFromPosition: SourceChapterPosition;
  validToPosition: SourceChapterPosition | null;
  firstObservedPosition: SourceChapterPosition;
  lastObservedPosition: SourceChapterPosition;
}

interface CanonGovernanceFields {
  projectId: number;
  sourceId: number;
  snapshotId: string;
  confidence: number;
  reviewStatus: CanonReviewStatus;
  origin: CanonOrigin;
  extractionVersion: string;
  analysisRunId: string;
  revision: number;
  supersedesId: number | null;
  userReviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
```

约束：

- `confidence` 取值 0 至 1。
- `locked` 只能由用户操作产生。
- 用户修改 AI 结果时创建新 revision，旧记录标记 `superseded`。
- `ignored` 不进入 Phase 3 默认检索。
- Canon 有效期统一为章节 position 半开区间 `[validFromPosition, validToPosition)`；`null` 表示持续有效。非空 `validToPosition` 必须严格大于 `validFromPosition`。
- `firstObservedPosition/lastObservedPosition` 是证据观测点，二者均为包含端点，且 `lastObservedPosition >= firstObservedPosition`。
- 任何有效范围不得超过分析 boundary。
- 每张 Canon 业务表必须落地 `project_id/source_id/snapshot_id/analysis_run_id/revision/supersedes_id/confidence/review_status/origin/extraction_version/created_at/updated_at`。
- 每张表必须对 confidence、review_status、origin、position 建 CHECK，并建立 `(snapshot_id, review_status)` 与核心查询维度索引。
- 用户锁定 AI 记录时 origin 仍保留 `ai`，同时写 `user_reviewed_at`；用户新建事实才使用 origin=`user`。

## 6. 数据模型

本阶段权威迁移为 **Schema 19→20**。若施工分支的实际基线已前移，只能整体顺延版本号，不能跳过这些表、约束、备份和迁移夹具。

### 6.1 `continuation_canon_snapshots`

```sql
CREATE TABLE continuation_canon_snapshots (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  source_id INTEGER NOT NULL,
  analysis_run_id TEXT,
  source_version INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  boundary_chapter_id INTEGER NOT NULL,
  boundary_position INTEGER NOT NULL,
  boundary_char_offset_exclusive INTEGER NOT NULL,
  extraction_version TEXT NOT NULL,
  profile TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK(
    status IN (
      'staging', 'awaiting_review', 'ready',
      'outdated', 'failed'
    )
  ),
  capabilities_json TEXT NOT NULL,
  coverage_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  activated_at TEXT,
  CHECK(source_version >= 1),
  CHECK(boundary_position >= 0),
  CHECK(boundary_char_offset_exclusive >= 0),
  CHECK(profile IN ('quick', 'standard', 'deep')),
  CHECK(revision >= 1),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
  FOREIGN KEY(boundary_chapter_id)
    REFERENCES continuation_source_chapters(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_canon_snapshots_one_ready
  ON continuation_canon_snapshots(project_id)
  WHERE status = 'ready';

CREATE INDEX idx_canon_snapshots_source
  ON continuation_canon_snapshots(project_id, source_id, status);
```

Schema 20 在创建 snapshot 表后执行：

```sql
ALTER TABLE continuation_settings
  ADD COLUMN active_canon_snapshot_id TEXT
    REFERENCES continuation_canon_snapshots(id);
```

激活必须在一个事务中：

1. 再次比对 Phase 1 source snapshot 的 source id/version/hash、parser/normalizer 和 boundary 全部字段。
2. 校验所有正式 Canon 行均绑定候选 snapshot。
3. 校验 future evidence/orphan evidence 为零。
4. 旧 ready snapshot 标记 outdated。
5. 新 snapshot 标记 ready。
6. 更新 `continuation_settings.active_canon_snapshot_id`、`analysis_status='ready'`。

`capabilities_json` 使用版本化 Schema，至少包含：

```ts
interface CanonCapabilities {
  worldRules: boolean;
  characterProfiles: boolean;
  characterStates: boolean;
  relationships: boolean;
  plotThreads: boolean;
  experiences: boolean;
  knowledgeBoundaries: boolean;
  timelineEvents: boolean;
  evidenceValidated: boolean;
}

interface CanonCoverage {
  schemaVersion: 1;
  sourceChapterCount: number;
  analyzedChapterCount: number;
  analyzedThroughPosition: SourceChapterPosition;
  categoryCounts: Record<keyof CanonCapabilities, number>;
  incompleteReasons: string[];
}
```

### 6.2 `continuation_analysis_runs`

```sql
CREATE TABLE continuation_analysis_runs (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  source_id INTEGER NOT NULL,
  source_version INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  boundary_chapter_id INTEGER NOT NULL,
  boundary_position INTEGER NOT NULL,
  boundary_char_offset_exclusive INTEGER NOT NULL,
  canon_snapshot_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  model_config_id INTEGER,
  state TEXT NOT NULL,
  stage TEXT NOT NULL,
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  extraction_version TEXT NOT NULL,
  checkpoint_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK(source_version >= 1),
  CHECK(boundary_position >= 0),
  CHECK(boundary_char_offset_exclusive >= 0),
  CHECK(profile IN ('quick', 'standard', 'deep')),
  CHECK(state IN (
    'queued', 'running', 'paused', 'awaiting_review',
    'completed', 'failed', 'cancelled', 'outdated'
  )),
  CHECK(stage IN (
    'snapshot', 'chapter_extraction', 'entity_resolution',
    'temporal_merge', 'global_synthesis', 'evidence_validation',
    'indexing', 'finalizing'
  )),
  CHECK(progress_current >= 0),
  CHECK(progress_total >= 0),
  CHECK(progress_total = 0 OR progress_current <= progress_total),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
  FOREIGN KEY(model_config_id) REFERENCES llm_config(id) ON DELETE SET NULL,
  FOREIGN KEY(canon_snapshot_id)
    REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE
);
```

`profile`：

```ts
type AnalysisProfile = 'quick' | 'standard' | 'deep';
```

`state`：

```ts
type AnalysisRunState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'awaiting_review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outdated';
```

`stage`：

```ts
type AnalysisStage =
  | 'snapshot'
  | 'chapter_extraction'
  | 'entity_resolution'
  | 'temporal_merge'
  | 'global_synthesis'
  | 'evidence_validation'
  | 'indexing'
  | 'finalizing';
```

### 6.3 `continuation_analysis_batches`

保存可恢复批次：

```sql
CREATE TABLE continuation_analysis_batches (
  run_id TEXT NOT NULL,
  canon_snapshot_id TEXT NOT NULL,
  batch_index INTEGER NOT NULL,
  start_position INTEGER NOT NULL,
  end_position INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'queued',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(run_id, batch_index),
  CHECK(batch_index >= 0),
  CHECK(start_position >= 0 AND end_position > start_position),
  CHECK(state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  CHECK(attempt_count >= 0),
  FOREIGN KEY(run_id) REFERENCES continuation_analysis_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(canon_snapshot_id)
    REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE
);

CREATE INDEX idx_continuation_analysis_batches_state
  ON continuation_analysis_batches(run_id, state, batch_index);
```

批次结果必须经过 Schema 校验后才能进入正式 Canon 表。
`start_position/end_position` 为 `SourceChapterPosition` 半开区间 `[start, end)`。

### 6.4 `canon_evidence`

```sql
CREATE TABLE canon_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  source_id INTEGER NOT NULL,
  snapshot_id TEXT NOT NULL,
  chapter_id INTEGER NOT NULL,
  chapter_position INTEGER NOT NULL,
  paragraph_start INTEGER,
  paragraph_end INTEGER,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  quote_preview TEXT NOT NULL,
  quote_sha256 TEXT NOT NULL,
  analysis_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
  FOREIGN KEY(snapshot_id)
    REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE,
  FOREIGN KEY(chapter_id)
    REFERENCES continuation_source_chapters(id) ON DELETE CASCADE,
  CHECK(char_start >= 0),
  CHECK(char_end > char_start),
  CHECK(
    (paragraph_start IS NULL AND paragraph_end IS NULL)
    OR
    (paragraph_start >= 0 AND paragraph_end >= paragraph_start)
  )
);

CREATE TABLE canon_evidence_links (
  evidence_id INTEGER NOT NULL,
  snapshot_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(evidence_id, owner_type, owner_id),
  FOREIGN KEY(evidence_id) REFERENCES canon_evidence(id) ON DELETE CASCADE,
  FOREIGN KEY(snapshot_id)
    REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE
);

CREATE INDEX idx_canon_evidence_range
  ON canon_evidence(snapshot_id, chapter_position, char_start, char_end);
CREATE INDEX idx_canon_evidence_links_owner
  ON canon_evidence_links(snapshot_id, owner_type, owner_id);
```

由于 link 中 `owner_type + owner_id` 仍是多态引用，服务层必须：

- 在同一事务创建/删除实体、evidence 和 link。
- 提供孤儿证据扫描测试。
- 项目启动或诊断工具可以检测 orphan evidence。
- 禁止 UI 直接删除 Canon 行。

`quote_preview` 最多 160 个 UTF-16 code units；完整原文通过 Phase 1 `readBoundedEvidenceRange` 按需读取。证据范围必须完全小于等于 snapshot 的 exclusive boundary。

### 6.5 `canon_world_rules`

字段：

- `category`
- `title`
- `description`
- `constraint_level`
- 公共时间和治理字段

`category` 至少支持：

- `fundamental`
- `power_system`
- `geography`
- `society`
- `organization`
- `history`
- `technology`
- `economy`
- `custom`
- `other`

`constraint_level`：

```ts
type CanonConstraintLevel = 'hard' | 'strong' | 'reference';
```

语义：

- `hard`：违反即构成世界观冲突。
- `strong`：原则上保持，用户可明确允许突破。
- `reference`：背景参考，不保证每次注入。

### 6.6 `canon_characters`

保存相对稳定的人物画像：

- `canonical_name`
- `description`
- `background`
- `appearance_json`
- `personality_json`
- `values_json`
- `behavior_patterns_json`
- `speech_style_json`
- `abilities_json`
- `weaknesses_json`
- `goals_json`
- `fears_json`
- `secrets_json`
- `first_appearance_position`
- `importance`
- 公共治理字段

`importance`：

```ts
type CharacterImportance = 'primary' | 'major' | 'supporting' | 'minor';
```

### 6.7 `canon_character_aliases`

字段：

- `character_id`
- `alias`
- `alias_normalized`
- `alias_type`
- `valid_from_position`
- `valid_to_position`
- `is_ambiguous`
- `confidence`
- `review_status`

别名类型：

- 本名
- 称号
- 乳名
- 化名
- 职务称谓
- 代词或上下文称呼
- 其他

要求：

- 一个别名可关联多个候选人物，但必须标记歧义。
- 不得用简单 `includes` 作为最终人物识别。
- 应复用项目现有最长匹配、歧义占位和 character ID 命名空间经验。
- Phase 3 查询以 character ID 为主，不以姓名字符串为主。

### 6.8 `canon_character_state_snapshots`

保存人物在章节位置的动态状态：

- `character_id`
- `chapter_position`
- `location`
- `physical_state`
- `emotional_state`
- `identity_state`
- `organization_state`
- `current_goal`
- `possessions_json`
- `abilities_state_json`
- `alive_state`
- `summary`
- 公共治理字段

规则：

- 不覆盖历史 snapshot。
- 相同人物、相同位置允许 revision，但只有一条 active revision。
- Phase 3 查询“续写起点状态”时取 boundary 前最后一条有效 snapshot。

### 6.9 `canon_relationships`

关系固定采用“每条记录表达一个方向”的模型：

- `source_character_id`
- `target_character_id`
- `relation_type`
- `attitude`
- `public_status`
- `description`
- `causes_json`
- 公共时间和治理字段

`public_status`：

```ts
type RelationshipPublicStatus =
  | 'public'
  | 'secret'
  | 'misunderstood'
  | 'one_sided';
```

规则：

- 甲信任乙不等于乙信任甲；需要双向信息时创建两条有向记录。
- 禁止一条记录同时保存 source/target 两种态度，避免与反向记录冲突。
- 关系变化创建新时间段，不能覆盖旧记录。
- 时间段不得交叉产生两个 active 关系；确有多重关系时用不同 `relation_type`。

### 6.10 `canon_plot_threads`

字段：

- `title`
- `description`
- `level`
- `status`
- `importance`
- `start_position`
- `last_advanced_position`
- `resolved_position`
- `established_facts_json`
- `unresolved_questions_json`
- `expected_directions_json`
- 公共治理字段

`level`：

```ts
type PlotThreadLevel =
  | 'main'
  | 'volume'
  | 'arc'
  | 'subplot'
  | 'foreshadowing';
```

`status`：

```ts
type PlotThreadStatus =
  | 'active'
  | 'paused'
  | 'resolved'
  | 'abandoned'
  | 'unknown';
```

### 6.11 `canon_plot_thread_characters`

多对多关联：

- `plot_thread_id`
- `character_id`
- `role`
- `created_at`

### 6.12 `canon_character_experiences`

字段：

- `character_id`
- `chapter_position`
- `event_type`
- `title`
- `description`
- `involved_character_ids_json`
- `impact_on_personality`
- `impact_on_goal`
- `impact_on_relationship`
- `knowledge_gained_json`
- `secrets_learned_json`
- `importance`
- 公共治理字段

`event_type`：

- `background`
- `relationship`
- `achievement`
- `failure`
- `trauma`
- `discovery`
- `betrayal`
- `loss`
- `growth`
- `identity_change`
- `power_change`
- `other`

### 6.13 `canon_character_knowledge`

用于人物知识边界：

- `character_id`
- `fact_key`
- `fact_summary`
- `knowledge_state`
- `learned_position`
- `learned_from_character_id`
- `misunderstanding_summary`
- 公共治理字段

`knowledge_state`：

```ts
type CharacterKnowledgeState =
  | 'unknown'
  | 'suspected'
  | 'known'
  | 'misunderstood';
```

规则：

- `unknown` 项可以由系统为了关键秘密主动建立。
- Phase 3 检查人物台词和行动时优先使用该表。
- AI 不得把未被任何证据支持的“未知”当成确定事实。

### 6.14 `canon_timeline_events`

Phase 3 若要执行强时间线检查，本阶段必须提供最小事件时间线：

- `id`
- 公共 governance 字段
- 公共 temporal 字段
- `event_key`
- `title`
- `summary`
- `event_type`
- `chapter_position`
- `char_start`
- `char_end`
- `participant_character_ids_json`
- `location_before`
- `location_after`
- `relative_time_json`
- `causes_event_ids_json`
- `consequences_event_ids_json`
- `importance`

规则：

- 只记录原著明确或有证据支持的时间/位置/因果信息。
- 无法确定时字段为 null 并降低 confidence，不得编造绝对日期或时长。
- Phase 3 的 timeline blocking 问题必须引用 confirmed/locked timeline event；只有推测时最多 warning。

### 6.15 可选检索索引

本阶段默认不引入外部向量数据库。

允许：

- SQLite FTS。
- 现有中文 n-gram/TF-IDF 复用。
- Canon 字段关键词索引。
- 按 character ID、plot thread ID、chapter position 建立普通索引。

Embedding 可作为可选增强，不能成为 Phase 2 完成条件。

### 6.16 Canon 表落库硬约束

本文的字段清单不是“可选建议”。施工时每张 Canon 业务表必须满足：

- `id INTEGER PRIMARY KEY AUTOINCREMENT`，关联表使用复合主键。
- 包含第 5 节要求的全部 governance 列，并外键到 project/source/snapshot/run。
- snapshot 删除时级联删除该 snapshot 的 Canon；项目删除依赖 project 级联。
- `supersedes_id` 指向同表旧 revision；服务层验证同 project、同业务实体。
- AI 行默认 `pending`；用户创建行可为 `confirmed`，只有显式锁定操作可为 `locked`。
- 每张表至少建立 `(snapshot_id, review_status)`、时间位置和主要外键索引。
- `canon_character_aliases` 建立 `(snapshot_id, alias_normalized, valid_from_position, valid_to_position)` 索引，但不得建立 alias 全局唯一约束。
- relationship 建立 `(snapshot_id, source_character_id, target_character_id, relation_type, valid_from_position)` 索引。
- state/experience/knowledge/event 建立 `(snapshot_id, character_id, chapter_position)` 或等价索引。
- plot thread 关联表必须外键并级联到 thread 和 character。
- fresh schema、Schema 19→20 migration、`SCHEMA_MANIFEST` 三者列名必须完全一致；新增 Canon 表均 `backup:true`，analysis batches/runs 也备份以支持显式恢复。
- migration test 必须读取 `PRAGMA foreign_key_check`、`PRAGMA integrity_check` 并证明所有 CHECK/partial index 生效。

为避免施工 Agent 自行猜列类型，除关联表外，`canon_world_rules`、`canon_characters`、`canon_character_aliases`、`canon_character_state_snapshots`、`canon_relationships`、`canon_plot_threads`、`canon_character_experiences`、`canon_character_knowledge`、`canon_timeline_events` 必须统一落地以下列模板：

```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
project_id INTEGER NOT NULL,
source_id INTEGER NOT NULL,
snapshot_id TEXT NOT NULL,
analysis_run_id TEXT NOT NULL,
valid_from_position INTEGER NOT NULL,
valid_to_position INTEGER,
first_observed_position INTEGER NOT NULL,
last_observed_position INTEGER NOT NULL,
confidence REAL NOT NULL,
review_status TEXT NOT NULL DEFAULT 'pending',
origin TEXT NOT NULL DEFAULT 'ai',
extraction_version TEXT NOT NULL,
revision INTEGER NOT NULL DEFAULT 1,
supersedes_id INTEGER,
user_reviewed_at TEXT,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL,
CHECK(valid_from_position >= 0),
CHECK(valid_to_position IS NULL OR valid_to_position > valid_from_position),
CHECK(first_observed_position >= 0),
CHECK(last_observed_position >= first_observed_position),
CHECK(confidence BETWEEN 0 AND 1),
CHECK(review_status IN ('pending', 'confirmed', 'locked', 'ignored', 'superseded')),
CHECK(origin IN ('ai', 'user')),
CHECK(revision >= 1),
FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
FOREIGN KEY(snapshot_id) REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE,
FOREIGN KEY(analysis_run_id) REFERENCES continuation_analysis_runs(id) ON DELETE CASCADE
```

每张表的 `supersedes_id` 再增加指向本表 `id` 的 `ON DELETE SET NULL` 外键。所有位置还必须由 repository 校验不超过 snapshot boundary。

表专属列使用以下确定类型和默认值：

| 表 | 专属列（SQL 片段） |
|---|---|
| `canon_world_rules` | `category TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, constraint_level TEXT NOT NULL CHECK(constraint_level IN ('hard','strong','reference'))` |
| `canon_characters` | `canonical_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', background TEXT NOT NULL DEFAULT '', appearance_json TEXT NOT NULL DEFAULT '{}', personality_json TEXT NOT NULL DEFAULT '{}', values_json TEXT NOT NULL DEFAULT '[]', behavior_patterns_json TEXT NOT NULL DEFAULT '[]', speech_style_json TEXT NOT NULL DEFAULT '{}', abilities_json TEXT NOT NULL DEFAULT '[]', weaknesses_json TEXT NOT NULL DEFAULT '[]', goals_json TEXT NOT NULL DEFAULT '[]', fears_json TEXT NOT NULL DEFAULT '[]', secrets_json TEXT NOT NULL DEFAULT '[]', first_appearance_position INTEGER NOT NULL, importance TEXT NOT NULL CHECK(importance IN ('primary','major','supporting','minor'))` |
| `canon_character_aliases` | `character_id INTEGER NOT NULL, alias TEXT NOT NULL, alias_normalized TEXT NOT NULL, alias_type TEXT NOT NULL, is_ambiguous INTEGER NOT NULL DEFAULT 0 CHECK(is_ambiguous IN (0,1)), FOREIGN KEY(character_id) REFERENCES canon_characters(id) ON DELETE CASCADE` |
| `canon_character_state_snapshots` | `character_id INTEGER NOT NULL, chapter_position INTEGER NOT NULL, location TEXT, physical_state TEXT, emotional_state TEXT, identity_state TEXT, organization_state TEXT, current_goal TEXT, possessions_json TEXT NOT NULL DEFAULT '[]', abilities_state_json TEXT NOT NULL DEFAULT '{}', alive_state TEXT NOT NULL DEFAULT 'unknown' CHECK(alive_state IN ('alive','dead','unknown')), summary TEXT NOT NULL DEFAULT '', FOREIGN KEY(character_id) REFERENCES canon_characters(id) ON DELETE CASCADE` |
| `canon_relationships` | `source_character_id INTEGER NOT NULL, target_character_id INTEGER NOT NULL, relation_type TEXT NOT NULL, attitude TEXT NOT NULL DEFAULT '', public_status TEXT NOT NULL CHECK(public_status IN ('public','secret','misunderstood','one_sided')), description TEXT NOT NULL DEFAULT '', causes_json TEXT NOT NULL DEFAULT '[]', CHECK(source_character_id <> target_character_id), FOREIGN KEY(source_character_id) REFERENCES canon_characters(id) ON DELETE CASCADE, FOREIGN KEY(target_character_id) REFERENCES canon_characters(id) ON DELETE CASCADE` |
| `canon_plot_threads` | `title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', level TEXT NOT NULL CHECK(level IN ('main','volume','arc','subplot','foreshadowing')), status TEXT NOT NULL CHECK(status IN ('active','paused','resolved','abandoned','unknown')), importance INTEGER NOT NULL DEFAULT 0, start_position INTEGER NOT NULL, last_advanced_position INTEGER NOT NULL, resolved_position INTEGER, established_facts_json TEXT NOT NULL DEFAULT '[]', unresolved_questions_json TEXT NOT NULL DEFAULT '[]', expected_directions_json TEXT NOT NULL DEFAULT '[]'` |
| `canon_character_experiences` | `character_id INTEGER NOT NULL, chapter_position INTEGER NOT NULL, event_type TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', involved_character_ids_json TEXT NOT NULL DEFAULT '[]', impact_on_personality TEXT, impact_on_goal TEXT, impact_on_relationship TEXT, knowledge_gained_json TEXT NOT NULL DEFAULT '[]', secrets_learned_json TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(character_id) REFERENCES canon_characters(id) ON DELETE CASCADE` |
| `canon_character_knowledge` | `character_id INTEGER NOT NULL, fact_key TEXT NOT NULL, fact_summary TEXT NOT NULL, knowledge_state TEXT NOT NULL CHECK(knowledge_state IN ('unknown','suspected','known','misunderstood')), learned_position INTEGER, learned_from_character_id INTEGER, misunderstanding_summary TEXT, FOREIGN KEY(character_id) REFERENCES canon_characters(id) ON DELETE CASCADE, FOREIGN KEY(learned_from_character_id) REFERENCES canon_characters(id) ON DELETE SET NULL` |
| `canon_timeline_events` | `event_key TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', event_type TEXT NOT NULL, chapter_position INTEGER NOT NULL, char_start INTEGER, char_end INTEGER, participant_character_ids_json TEXT NOT NULL DEFAULT '[]', location_before TEXT, location_after TEXT, relative_time_json TEXT NOT NULL DEFAULT '{}', causes_event_ids_json TEXT NOT NULL DEFAULT '[]', consequences_event_ids_json TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 0, CHECK((char_start IS NULL AND char_end IS NULL) OR (char_start >= 0 AND char_end > char_start))` |

`canon_plot_thread_characters` 是唯一不使用上述模板的业务关联表，权威定义为：

```sql
CREATE TABLE canon_plot_thread_characters (
  snapshot_id TEXT NOT NULL,
  plot_thread_id INTEGER NOT NULL,
  character_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, plot_thread_id, character_id),
  FOREIGN KEY(snapshot_id)
    REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE,
  FOREIGN KEY(plot_thread_id) REFERENCES canon_plot_threads(id) ON DELETE CASCADE,
  FOREIGN KEY(character_id) REFERENCES canon_characters(id) ON DELETE CASCADE
);
```

JSON 列必须经过对应版本化 validator 后才能写入；不能把无法解析的模型文本原样塞进 JSON 列。

## 7. 分析档位

### 7.1 Quick

目标：

- 全书概览。
- 主要人物。
- 基础世界规则。
- 主线剧情。
- 关键人物经历。

不要求：

- 完整关系时间线。
- 所有人物知识边界。
- 全量证据覆盖。

Quick snapshot 必须把缺失项写入 `capabilities_json/coverage_json`。Phase 3 仅可在 loose 模式降级使用 Quick，并显示“关系、知识或时间线检查不完整”；strict 模式必须阻断并要求 Standard/Deep。

### 7.2 Standard

默认档位：

- 五类 Canon。
- 主要人物状态快照。
- 主要关系变化。
- 活跃剧情线和伏笔。
- 关键知识边界。
- 证据完整性检查。

Standard 是 Phase 3 balanced/strict 模式的最低推荐档位；只有当 capabilities 中对应能力为 true 且覆盖率达到项目门槛时才可开启 blocking 检查。

### 7.3 Deep

增加：

- 次要人物。
- 关系细粒度时间段。
- 人物成长阶段。
- 地点、组织、物品对人物经历的影响。
- 更高密度证据回溯。
- 多轮实体消歧。
- 原著内部疑似矛盾标记。

Deep 不能默认开启，UI 必须提示时间、Token 和在线模型成本。

## 8. AI 分析流程

### 8.1 Snapshot

开始分析时固定：

```ts
interface AnalysisSnapshot {
  canonSnapshotId: string;
  sourceId: number;
  sourceVersion: number;
  sourceSha256: string;
  parserVersion: string;
  normalizationVersion: string;
  boundaryChapterId: number;
  boundaryPosition: SourceChapterPosition;
  boundaryCharOffsetExclusive: Utf16Offset;
  profile: AnalysisProfile;
  extractionVersion: string;
}
```

创建 run 的顺序固定为：`ContinuationSourceReader.getSnapshot(projectId)` → 持久化 `AnalysisSnapshot` → `listBoundedSourceChapters(sourceSnapshot)`。后续 evidence 读取也必须传同一 source snapshot；收到 `continuation_source_snapshot_outdated` 时立即把 run 标为 `outdated`。

运行中 source 或 boundary 变化：

- 当前 run 立即标记 `outdated`。
- 不允许继续写正式 Canon。
- 已产生的候选可保留为诊断，但不能激活。

### 8.2 Chapter Extraction

按章节或小批次提取：

- 世界规则候选。
- 人物和别名候选。
- 人物状态变化。
- 人物关系变化。
- 剧情线推进。
- 人物经历。
- 知识变化。
- 对应证据范围。

LLM 输出必须是版本化 JSON Schema。解析失败：

- 允许有限重试。
- 尝试修复格式但不得篡改语义。
- 最终失败记录 batch error，可跳过后在 UI 重试。

### 8.3 Entity Resolution

合并规则：

- 规范化姓名。
- 别名最长匹配。
- 明确身份线索。
- 章节共现。
- 关系和称谓证据。
- 用户已有角色卡可作为弱参考，但不能覆盖原著证据。
- 歧义项保留为候选，不强行合并。

用户必须能够：

- 合并两个人物。
- 拆分错误合并。
- 指定别名归属。
- 查看受影响关系、经历和剧情线。

### 8.4 Temporal Merge

将章节候选合并成时间范围：

- 不变事实合并为较长有效区间。
- 发生变化时关闭旧区间并创建新区间。
- 矛盾但无法确定时保留两个 pending 候选并标记 conflict。
- 不允许“最后一次模型输出”静默覆盖早期事实。

### 8.5 Global Synthesis

生成：

- 故事概览。
- 全书主线。
- 主要人物画像。
- 续写点人物当前状态。
- 活跃剧情线。
- 核心世界规则。
- 关系网络摘要。

全局摘要只是派生视图，不能替代结构化记录和证据。

### 8.6 Evidence Validation

至少检查：

- chapter ID 属于分析 source。
- position 不超过 boundary。
- char range 合法。
- quote hash 与原文一致。
- 证据文本确实包含支持信息。
- `locked` 记录至少有一条证据或明确标记为用户自定义规则。
- orphan evidence 为零。

### 8.7 Finalizing

成功完成后：

- run 进入 `awaiting_review` 或 `completed`。
- `continuation_settings.analysis_status` 更新。
- 保存 extraction version。
- 建立查询索引。
- 不自动把全部 pending 项设为 confirmed。
- 生成 capabilities/coverage。
- 进入 `awaiting_review` 后不得自动成为 active；用户完成审核或显式接受当前覆盖状态后，调用 snapshot 激活事务。

## 9. 模型调用与隐私

### 9.1 模型来源

支持：

- 当前在线 OpenAI 兼容模型。
- 当前 Android llama.cpp 本地 GGUF，但必须先通过结构化输出能力探测。

施工要求：

- 当前在线 Provider 只提供可选 `json_object`，不是 JSON Schema 强约束；所有结果仍必须在本地进行版本化 Schema 校验。
- Provider 不支持 `response_format` 时允许回退普通文本，但仍走同一提取/修复/有限重试路径。
- 当前 llama.cpp Provider 不消费 `responseFormat`；必须通过 prompt + 本地 parser/validator 验证，不得假设原生 grammar 已存在。
- 开始分析前执行小型 capability probe，记录 `json_valid/schema_valid/context_sufficient`，不保存 probe 正文。
- probe 不通过时 UI 阻断该模型用于 Standard/Deep；Quick 是否允许由明确降级策略决定。
- capability 结果绑定 model id、文件 sha256、prompt template 和 extraction version，任一变化重新探测。

### 9.2 在线分析披露

发起在线分析前必须显示：

- 将发送的章节范围。
- 服务商配置名称。
- 分析档位。
- 预计批次数。
- 原著内容会按服务商协议传输。
- 暂停和取消入口。

### 9.3 数据最小化

- 每批只发送必要章节。
- 不发送 future source。
- 不发送 API Key 到日志或 DB。
- Prompt 日志默认不保存原著全文。
- 诊断只保存 token、模型、耗时、batch ID、错误分类。

## 10. 人工审核与治理

### 10.1 审核状态

| 状态 | 含义 | Phase 3 默认使用 |
| --- | --- | --- |
| pending | AI 候选，未确认 | 低权重或不使用 |
| confirmed | 用户确认 | 强约束 |
| locked | 用户锁定，不允许自动修改 | 最高优先级 |
| ignored | 用户忽略 | 不使用 |
| superseded | 已被新 revision 替代 | 不使用 |

### 10.2 编辑规则

- 修改创建 revision。
- 锁定操作记录时间。
- 解锁需要二次确认。
- 批量确认只允许高置信度且证据有效的记录。
- 删除优先使用 ignored/superseded，避免破坏审计链。
- 用户可创建无原文证据的自定义 Canon，origin 为 user，并显示“用户设定”。
- 任何确认、锁定、忽略、新建、编辑、合并或冲突裁决，都必须在同一事务将 active snapshot 的 `revision + 1`；Phase 3 缓存和 run 绑定 `snapshotId + revision`。

### 10.3 冲突处理

冲突类型：

- 同一人物两个身份。
- 世界规则互斥。
- 关系有效期重叠。
- 人物状态无法同时成立。
- 主线状态不一致。
- 证据指向不同人物。

UI 提供：

- 保留 A。
- 保留 B。
- 合并。
- 限定不同时间段。
- 标记原著自身存在矛盾。
- 暂不处理。

## 11. UI 信息架构

资料 > 续写：

```text
续写资料
├── 原著管理
├── 分析概览
├── 世界观
├── 人物画像
├── 人物关系
├── 主线剧情
├── 人物经历
└── 分析任务
```

### 11.1 分析概览

显示：

- source 版本和续写边界。
- 分析档位。
- 章节覆盖率。
- 五类 Canon 数量。
- pending/confirmed/locked/ignored 数量。
- 证据覆盖率。
- 冲突数。
- 失败批次数。
- 重新分析和继续分析入口。

### 11.2 世界观

支持：

- 类别筛选。
- 硬/强/参考等级。
- 时间范围。
- 状态筛选。
- 查看证据。
- 修改、确认、锁定、忽略。

### 11.3 人物画像

人物详情页包含：

- 稳定画像。
- 别名。
- 状态时间线。
- 关系。
- 个人经历。
- 知识边界。
- 参与剧情线。
- 原文证据。

### 11.4 人物关系

最低可交付为方向关系列表和人物中心视图。

可选图形化关系图不作为本阶段硬验收，但数据模型必须支持。

### 11.5 主线剧情

按层级和状态展示：

- 主线。
- 卷线。
- 阶段线。
- 支线。
- 伏笔。

显示最后推进章节和未解决问题。

### 11.6 人物经历

按人物、重要性和时间排序，点击可跳转证据。

## 12. 与现有角色卡和世界书的关系

Canon 是原著事实层，角色卡/世界书是现有创作资料层，二者不能静默双向同步。

允许用户显式操作：

- 从确认的人物画像创建角色卡。
- 从确认的世界规则创建世界书条目。
- 更新已有资料前显示 diff。
- 记录来源 Canon ID。
- 后续修改角色卡不反向修改 Canon。
- 后续修改 Canon 不自动覆盖用户资料。

Phase 2 不要求批量自动同步，但必须保留映射字段或来源元数据。

## 13. Canon 查询服务

必须新增以下领域服务（允许按职责拆文件，但不得让 UI 直接查询 Canon 表）：

```text
src/services/continuation/canon/
├── canonAnalysisService.ts
├── canonRepository.ts
├── canonEvidenceService.ts
├── canonEntityResolver.ts
├── canonReviewService.ts
├── canonQueryService.ts
└── canonInvalidationService.ts
```

Phase 3 只能通过 `CanonQueryService` 读取。

必须提供：

```ts
interface CanonQueryService {
  getActiveSnapshot(projectId: number): Promise<CanonSnapshot>;

  getWorldRules(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    atSourcePosition: SourceChapterPosition;
    levels?: CanonConstraintLevel[];
    reviewStatuses?: CanonReviewStatus[];
    query?: string;
    limit?: number;
  }): Promise<WorldRule[]>;

  resolveCharacters(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    text: string;
    atSourcePosition: SourceChapterPosition;
  }): Promise<ResolvedCharacterMention[]>;

  getCharacterProfiles(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    characterIds: number[];
  }): Promise<CharacterProfile[]>;

  getCharacterStates(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    characterIds: number[];
    atSourcePosition: SourceChapterPosition;
  }): Promise<CharacterStateSnapshot[]>;

  getRelationships(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    characterIds: number[];
    atSourcePosition: SourceChapterPosition;
    maxDepth: 1 | 2;
  }): Promise<CharacterRelationship[]>;

  getCharacterExperiences(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    characterIds: number[];
    atSourcePosition: SourceChapterPosition;
    query?: string;
    limit: number;
  }): Promise<CharacterExperience[]>;

  getCharacterKnowledge(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    characterIds: number[];
    atSourcePosition: SourceChapterPosition;
  }): Promise<CharacterKnowledge[]>;

  getPlotThreads(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    atSourcePosition: SourceChapterPosition;
    characterIds?: number[];
    statuses?: PlotThreadStatus[];
    limit: number;
  }): Promise<PlotThread[]>;

  getTimelineEvents(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    atSourcePosition: SourceChapterPosition;
    characterIds?: number[];
    limit: number;
  }): Promise<CanonTimelineEvent[]>;

  readEvidence(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    evidenceId: number;
  }): Promise<CanonEvidenceView>;

  getContextBundle(input: {
    projectId: number;
    snapshotId: string;
    snapshotRevision: number;
    atSourcePosition: SourceChapterPosition;
    queryText: string;
    characterIds: number[];
    tokenBudget: number;
    reviewPolicy: 'strict' | 'balanced' | 'loose';
  }): Promise<CanonContextBundle>;
}
```

所有查询必须：

- 只返回 active source 对应 Canon。
- `snapshotId` 必须等于当前 `active_canon_snapshot_id`，`snapshotRevision` 必须等于 snapshot 当前 revision；否则抛出 `canon_snapshot_outdated`。
- 每个公开查询在单个 SQLite read transaction 中完成 snapshot 校验和数据读取，避免审核操作与 Context 构建交错产生混合 revision。
- 只返回 `atSourcePosition` 有效的数据，且位置不得超过 snapshot boundary。
- 默认排除 ignored、superseded 和过期 run。
- strict 默认只使用 confirmed/locked；balanced 可把高置信 pending 作为明确标记的弱参考；loose 仍不得把 pending 当 hard。
- 明确排序和 limit。
- 提供 token 预算前可估算的紧凑摘要。

## 14. 分析失效与重建

以下事件必须使当前 Canon snapshot 过期：

- 替换 active source。
- 修改原著分章。
- 修改续写边界。
- source normalized hash 变化。
- parser version 变化且声明不兼容。
- extraction version 重大升级。
- 用户选择完全重建。

失效策略：

- 旧 Canon 保留只读审计。
- 在统一事务中把旧 snapshot 标记 outdated、清空 `active_canon_snapshot_id`、更新 `analysis_status='outdated'`。
- Phase 3 禁止使用 outdated snapshot。
- UI 显示需要重新分析。
- 可复用 hash 未变化且仍在 boundary 内的 batch，但必须有明确缓存契约。
- 不允许仅凭 `updated_at` 判断缓存有效。

## 15. 原子性与恢复

- 每个 batch 结果先写 staging JSON。
- Schema 校验通过后在事务中写候选。
- run finalizing 失败不能把分析状态标记 completed。
- 用户确认/修改和证据写入同一事务。
- 合并人物时相关关系、经历、知识和剧情参与表必须原子更新。
- 冷启动将遗留 running run 转为 paused；只有用户点击继续才重新排队，不重复提交已完成 batch。
- 重试同一 batch 使用 idempotency key，避免重复 Canon。
- 删除 source 通过项目级事务/级联清理分析 run 和 Canon。

## 16. 性能与上下文预算

- 不能把整本原著一次发送给模型。
- Batch 大小由上下文窗口、预留输出和章节长度共同决定。
- 使用现有自动预算能力；超预算必须显式阻断或拆分，禁止静默截断。
- UI 显示已处理章节和预计剩余批次。
- 列表查询必须分页。
- 人物详情不一次加载全书所有证据正文。
- 30 章夹具和至少一部大文本夹具需要记录分析时间、峰值内存和失败恢复结果。

## 17. 测试要求

### 17.1 结构化输出测试

- 合法 JSON。
- 缺字段。
- 多余字段。
- 错误枚举。
- 引用不存在章节。
- evidence 越界。
- 自定义 boundary 位于章节中间时末章后半段输出。
- future source evidence。
- 重复实体。
- 模型输出 Markdown code fence。
- 部分截断输出。
- 本地模型非标准 JSON 降级。

### 17.2 Canon 规则测试

- 世界规则时间有效性。
- 人物画像 revision。
- 人物状态按位置取最新。
- 有向关系。
- 关系变化关闭旧区间。
- 主线 active/resolved。
- 经历与人物绑定。
- 知识 unknown/known 转换。
- locked 不能被自动替换。
- ignored 不进入默认查询。
- orphan evidence 为零。
- snapshot 未激活不可查询。
- active snapshot 指针与 ready partial unique index。
- Quick capabilities 导致 strict generation gate。
- timeline event 的证据、参与人物和因果引用。

### 17.3 未来泄漏测试

必须有专门夹具：

- 第 1 至 20 章为边界内。
- 第 21 至 30 章包含重大身份揭示。
- 续写边界设在第 20 章。
- 任何分析结果、证据和 Canon 查询均不得出现第 21 至 30 章信息。
- 再增加一个边界位于第 20 章中段的用例，后半章秘密同样不得出现。

该测试是 Phase 2 发布阻断项。

### 17.4 实体消歧测试

覆盖：

- 同名人物。
- 姓名和称号。
- “队长/长”重叠。
- “老林/林”重叠。
- 多角色共用称谓。
- 化名前后。
- 单向关系。
- 无法确定时保留歧义。

### 17.5 任务恢复测试

- 在线请求失败。
- 本地模型取消。
- Batch 三失败后重试。
- App kill 后恢复。
- source 变化导致 run outdated。
- boundary 变化导致 run outdated。
- finalizing 失败不 completed。
- 幂等重跑无重复行。

### 17.6 E2E

新增：

```text
08-continuation-canon-analysis.yaml
```

至少覆盖：

1. 打开已导入续写项目。
2. 选择 Quick 或使用离线假模型夹具完成可控分析。
3. 查看五类 Canon。
4. 确认一条世界规则。
5. 锁定一条人物画像。
6. 忽略一条候选。
7. 查看原文证据。
8. 重启后状态保留。
9. 备份恢复后 Canon 和证据完整。

真实在线模型测试可作为手工验收，但自动化必须使用确定性 fixture/provider，避免 CI 依赖外部服务。

## 18. 质量指标

施工报告必须统计：

- 章节分析覆盖率。
- 主要人物证据覆盖率。
- 世界规则证据覆盖率。
- 无效证据率。
- 实体歧义率。
- 用户确认率。
- 用户修改率。
- 冲突率。
- Batch 重试率。
- 每万字输入 Token。
- 每个分析档位耗时。

指标只用于诊断，不上传原文。

## 19. Agent 施工顺序

1. 审核 Phase 1 交接契约和测试。
2. Canon branded type、版本化 JSON Schema 和公共治理字段。
3. Schema 20：snapshot、run/batch、evidence/link、全部 Canon 表、timeline、settings active pointer。
4. fresh schema、manifest、19→20、迁移矩阵、备份与删除。
5. Active snapshot 状态机、激活/失效事务和 capabilities/coverage。
6. Evidence 服务和 bounded range 验证。
7. Analysis run/batch 状态机、idempotency 和冷启动 pause。
8. Provider capability probe、章节提取适配器和确定性 fake provider。
9. 实体解析、别名和有向关系。
10. 时间合并、状态快照和 timeline events。
11. 五类 Canon repository/service。
12. 人工审核、revision 和冲突处理。
13. 只读 Query Service 与 context bundle。
14. UI、失效和重建。
15. E2E、性能、故障注入、文档、版本、`npm run verify`、`npm run test:coverage`、`npm run apk:debug` 和设备验证。

禁止先做漂亮关系图再补数据不变量。

## 20. 验收标准

### 功能验收

- [ ] 可按 Quick/Standard/Deep 发起分析。
- [ ] 分析只读取 boundary 内原著。
- [ ] 可生成五类 Canon。
- [ ] 人物画像与状态分离。
- [ ] 人物关系有方向且有时间范围。
- [ ] 人物经历可追溯。
- [ ] 人物知识边界可查询。
- [ ] 每条重要 Canon 有原文证据。
- [ ] 支持确认、锁定、忽略和修改。
- [ ] 支持暂停、恢复、取消和重试。
- [ ] source/boundary 变化会使结果过期。
- [ ] 只有 active ready snapshot 可被 Query Service 读取。
- [ ] Quick/Standard/Deep capabilities 可见，Quick 不得伪装成完整严格检查。
- [ ] timeline blocking 只来自有证据的 confirmed/locked event。
- [ ] Canon 可显式导出到角色卡或世界书，不自动覆盖。

### 质量验收

- [ ] future leakage 测试通过。
- [ ] entity resolution 歧义测试通过。
- [ ] orphan evidence 为零。
- [ ] migration matrix 通过。
- [ ] backup/restore round-trip 通过。
- [ ] lint、typecheck、Jest、coverage 通过。
- [ ] Android Debug 构建通过。
- [ ] 新增 E2E 通过。
- [ ] 本地处理与在线传输提示正确。
- [ ] 不记录原著全文或凭据。

## 21. Definition of Done

Phase 2 只有在以下条件全部满足时完成：

1. 五类 Canon 数据可稳定生成、审核和查询。
2. Canon snapshot 与 source/boundary 强绑定，且由 settings active pointer 原子发布。
3. future source 零泄漏测试为发布阻断项且已通过。
4. Phase 3 无需直接读 Canon 表，只调用 `CanonQueryService`。
5. 至少完成一份 30 章夹具的 Standard 分析和恢复测试。
6. 所有核心 Canon 都能从 UI 跳转到原文证据。
7. 分析失败不会污染 active Canon snapshot。
8. 施工报告记录模型、档位、批次、测试、性能和剩余风险。

## 22. Phase 3 交接契约

Phase 2 必须提供：

```ts
interface CanonSnapshot {
  id: string;
  projectId: number;
  sourceId: number;
  sourceVersion: number;
  sourceSha256: string;
  parserVersion: string;
  normalizationVersion: string;
  boundaryPosition: SourceChapterPosition;
  boundaryCharOffsetExclusive: Utf16Offset;
  extractionVersion: string;
  revision: number;
  capabilities: CanonCapabilities;
  coverage: CanonCoverage;
  status: 'ready' | 'outdated';
}

interface CanonContextBundle {
  snapshot: CanonSnapshot;
  worldRules: WorldRule[];
  characters: CharacterProfile[];
  characterStates: CharacterStateSnapshot[];
  relationships: CharacterRelationship[];
  experiences: CharacterExperience[];
  knowledge: CharacterKnowledge[];
  plotThreads: PlotThread[];
  timelineEvents: CanonTimelineEvent[];
  evidenceRefs: number[];
  estimatedTokens: number;
  omittedReasonCounts: Record<string, number>;
}
```

Phase 3 请求 bundle 时必须提供 active snapshot ID、原著 source boundary、用户要求、参与人物候选、review policy 和 token 预算。不得把 `ContinuationChapterPosition` 作为 `atSourcePosition` 传入。Phase 2 查询服务返回经过排序和裁剪的结构化数据；snapshot 在调用期间变化时抛出 `canon_snapshot_outdated`。
