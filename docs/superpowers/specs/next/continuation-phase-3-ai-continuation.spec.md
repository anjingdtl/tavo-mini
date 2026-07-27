# ShineWriter 原著续写改造工程 Spec：Phase 3（修订版）

> 文档状态：Ready after Phase 2 Definition of Done  
> 修订日期：2026-07-27  
> 施工基线：Phase 2 完成后的 Schema 20；本阶段目标 Schema 21  
> 工程主题：Canon 驱动续写、连续性检查、用户定稿与可审计状态回灌  
> 硬依赖：Phase 1 bounded SourceReader 与 Phase 2 active `CanonQueryService` 已达到 Definition of Done  
> 核心原则：原著 Canon 不被自动改写；采纳只写草稿，只有用户定稿且确认的 proposal 才能进入续写结构化状态

## 1. 背景

Phase 1 解决原著导入和只读边界，Phase 2 解决原著结构化理解。Phase 3 负责将这些资料接入现有章节编辑器、Story Memory 和四阶段 AI 流水线，形成可长期运行的续写闭环：

```text
Canon 检索
→ 章节规划
→ 正文生成
→ 一致性检查
→ 局部修复
→ 用户采纳为草稿并编辑
→ 用户定稿
→ 提取、确认续写状态并异步更新记忆
```

本阶段不追求“模型一次生成就绝对正确”，而是通过结构化上下文、可解释检查和确认后回灌降低长期漂移。

## 2. 本阶段目标

1. 为 continuation 项目增加独立 AI 续写流程，不修改历史 `freeform` 的现有流水线语义。
2. 构建 `ContinuationContextBuilder`，统一编排 Canon、原著接缝、最近正文和 Story Memory。
3. 复用现有 provider、调度、取消、前台服务和 token 预算基础能力；为续写建立独立 runner、任务状态与持久化。
4. 实现 Planner、Writer、Checker、Repair 四阶段。
5. 检查世界观、人物画像、人物关系、主线剧情和人物经历一致性。
6. 增加人物知识边界、时间线和文风辅助检查。
7. 一致性问题必须给出原著证据和生成文本定位。
8. 采纳只写章节草稿；只有用户定稿后的正文才能提取 proposal，只有已确认 proposal 才能更新结构化状态。
9. 章节修改、删除和版本回退必须使后续续写状态失效并可重建。
10. 支持连续多章续写，不增加无必要的远程调用。
11. 明确记录 Planner、Writer、Checker、Repair 和定稿状态提取的实际调用次数、模型与费用。

## 3. 非目标

本阶段不实现：

- 修改或重写原著章节。
- 自动将续写新设定写入原著 Canon。
- 完全自主无人审核整本续写。
- 为所有项目强制启用续写管线。
- 依赖云端向量库。
- 复制大段原著文本来模仿文风。
- 自动绕过用户锁定的世界规则。
- Checker 判定有问题就静默覆盖用户正文。
- 将未定稿草稿写入 Story Memory。
- 把 Phase 2 pending 低置信度候选当成硬事实。

## 4. 核心不变量

1. 原著 Canon 是只读事实层。
2. 用户锁定 Canon 优先级最高。
3. 只有从定稿正文提取并经策略/用户确认的续写事实，才能存入独立续写状态层。
4. 未定稿、失败、取消和被拒绝的生成不得污染记忆。
5. 目标章节不得读取未来续写章节和原著边界之后的内容。
6. Context 构建必须遵守 token 预算，禁止静默截断硬规则。
7. Checker 的每项冲突必须包含证据或明确标记“无法取得证据的推测”。
8. Repair 默认只改冲突片段，不无理由整章重写。
9. 用户手动编辑后，最终回灌基于当前保存正文，而不是旧 AI 草稿。
10. 章节删除、回退、改序必须遵循现有 Story Memory dirty/失效契约。
11. 原著 `SourceChapterPosition` 与续写 `ContinuationChapterPosition` 不得互传。
12. 现有 `draft/review/factCheck/proof` 流水线继续服务 outline/freeform；本阶段不得改名或复用其 stage 枚举表达不同语义。
13. Context、Planner、Writer、Checker、Repair 必须共享一次冻结的 source/canon/story-memory/settings snapshot。
14. LLM 请求不能位于 SQLite 事务中；事务只提交事实、状态、dirty 标记和 outbox。

## 5. 现有流水线复用边界

当前仓库既有阶段是：

```ts
type PipelineStageName = 'draft' | 'review' | 'factCheck' | 'proof';
```

本阶段新增独立类型：

```ts
type ContinuationStageName =
  | 'context'
  | 'planner'
  | 'writer'
  | 'checker'
  | 'repair'
  | 'awaiting_user';
```

允许复用：

- `callLLMResult`、Provider Registry、网络策略和 Keychain。
- `requestScheduler`，使用 `queueClass='pipeline'` 和 projectId 串行约束。
- AbortSignal、超时策略、Token 统计、用量日志。
- `PipelineForeground` 的 start/update/stop/通知能力。
- Story Memory prepare/eligibility/renderer、Episodic 检索算法。
- 当前 Context trace UI 组件的通用展示能力。

禁止直接复用：

- 旧 `PipelineStageName`、`PipelineTaskStatus` 和固定 stage label。
- 旧 `pipeline_tasks.stage_results` 作为 continuation 权威运行记录。
- 旧 `PipelineResultScreen` 的直接 `updateChapter()` 采纳实现。
- 旧 `buildContext()` 的完整调用路径，因为 generation mode 可能隐式触发 Story Memory LLM 更新。

实现方式：

- 新建 `continuationGenerationRunner` 和 continuation run repository/store。
- continuation run id 使用 `ct_` 前缀。
- 前台服务通知仍携带 taskId；JS 深链解析先按 `ct_` 查询 continuation run，再回退旧 pipeline task。
- 冷启动把遗留 running continuation run 标记 `interrupted`；只有用户点击继续才从最后一个已持久化阶段边界恢复，不恢复中途网络流。

## 6. 续写状态分层

生成上下文的权威层级：

```text
用户锁定规则
>
用户确认的原著 Canon
>
用户明确修改的续写规则
>
已确认续写状态
>
原著 AI 高置信度候选
>
现有 Story Memory
>
Episodic 检索
>
模型推测
```

数据层：

```text
原著 Source（只读）
原著 Canon（只读，用户可治理）
续写结构化状态（由定稿章节的已确认 proposal 产生）
Story Memory Checkpoint（现有）
最近续写正文（现有 chapters）
当前用户要求
```

## 7. 数据模型

Phase 3 迁移目标为 **Schema 21**。本节 SQL 是权威定义；实现时必须同步更新 `createCurrentSchema.ts`、`v20-to-v21.ts`、`schemaValidator.ts`、repository、备份 manifest 和迁移夹具，不得只在业务代码中动态建表。

### 7.1 `continuation_generation_settings`

项目级设置：

```sql
CREATE TABLE continuation_generation_settings (
  project_id INTEGER PRIMARY KEY,
  strictness_profile TEXT NOT NULL DEFAULT 'balanced',
  world_rule_level TEXT NOT NULL DEFAULT 'strict',
  character_level TEXT NOT NULL DEFAULT 'strict',
  relationship_level TEXT NOT NULL DEFAULT 'strict',
  plot_level TEXT NOT NULL DEFAULT 'balanced',
  experience_level TEXT NOT NULL DEFAULT 'strict',
  knowledge_level TEXT NOT NULL DEFAULT 'strict',
  style_level TEXT NOT NULL DEFAULT 'balanced',
  allow_new_characters INTEGER NOT NULL DEFAULT 1,
  allow_new_locations INTEGER NOT NULL DEFAULT 1,
  allow_new_organizations INTEGER NOT NULL DEFAULT 1,
  major_relationship_change_policy TEXT NOT NULL DEFAULT 'require_confirmation',
  major_power_change_policy TEXT NOT NULL DEFAULT 'require_confirmation',
  character_death_policy TEXT NOT NULL DEFAULT 'require_confirmation',
  resurrection_policy TEXT NOT NULL DEFAULT 'forbid',
  planner_llm_config_id INTEGER,
  writer_llm_config_id INTEGER,
  checker_llm_config_id INTEGER,
  repair_llm_config_id INTEGER,
  state_extraction_llm_config_id INTEGER,
  planner_confirmation_policy TEXT NOT NULL DEFAULT 'risk_only',
  checker_enabled INTEGER NOT NULL DEFAULT 1,
  max_repair_rounds INTEGER NOT NULL DEFAULT 1,
  target_chapter_chars INTEGER NOT NULL DEFAULT 3000,
  custom_rules_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(strictness_profile IN ('loose', 'balanced', 'strict', 'custom')),
  CHECK(world_rule_level IN ('off', 'balanced', 'strict')),
  CHECK(character_level IN ('off', 'balanced', 'strict')),
  CHECK(relationship_level IN ('off', 'balanced', 'strict')),
  CHECK(plot_level IN ('off', 'balanced', 'strict')),
  CHECK(experience_level IN ('off', 'balanced', 'strict')),
  CHECK(knowledge_level IN ('off', 'balanced', 'strict')),
  CHECK(style_level IN ('off', 'balanced', 'strict')),
  CHECK(allow_new_characters IN (0, 1)),
  CHECK(allow_new_locations IN (0, 1)),
  CHECK(allow_new_organizations IN (0, 1)),
  CHECK(major_relationship_change_policy IN ('allow', 'require_confirmation', 'forbid')),
  CHECK(major_power_change_policy IN ('allow', 'require_confirmation', 'forbid')),
  CHECK(character_death_policy IN ('allow', 'require_confirmation', 'forbid')),
  CHECK(resurrection_policy IN ('allow', 'require_confirmation', 'forbid')),
  CHECK(planner_confirmation_policy IN ('never', 'risk_only', 'always')),
  CHECK(checker_enabled IN (0, 1)),
  CHECK(max_repair_rounds BETWEEN 0 AND 3),
  CHECK(target_chapter_chars BETWEEN 200 AND 30000),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(planner_llm_config_id) REFERENCES llm_config(id) ON DELETE SET NULL,
  FOREIGN KEY(writer_llm_config_id) REFERENCES llm_config(id) ON DELETE SET NULL,
  FOREIGN KEY(checker_llm_config_id) REFERENCES llm_config(id) ON DELETE SET NULL,
  FOREIGN KEY(repair_llm_config_id) REFERENCES llm_config(id) ON DELETE SET NULL,
  FOREIGN KEY(state_extraction_llm_config_id) REFERENCES llm_config(id) ON DELETE SET NULL
);
```

`strictness_profile`：

- `loose`
- `balanced`
- `strict`
- `custom`

策略枚举：

- `allow`
- `require_confirmation`
- `forbid`

类别 level=`off` 只关闭该类别的普通注入/检查，不能绕过用户 locked 规则、future leakage 或安全约束。

某阶段配置为空时，在 run 创建事务内解析当前 active LLM 配置，并把最终选择写入 `settings_snapshot_json`。运行中修改项目设置或 active LLM，不得改变已创建 run。

### 7.2 `continuation_generation_runs`

记录每次续写流水线及其不可变输入：

```sql
CREATE TABLE continuation_generation_runs (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  chapter_id INTEGER NOT NULL,
  target_position INTEGER NOT NULL,
  source_id INTEGER,
  source_snapshot_json TEXT NOT NULL,
  canon_snapshot_id TEXT,
  canon_revision INTEGER NOT NULL,
  story_memory_fingerprint TEXT NOT NULL,
  story_memory_through_position INTEGER NOT NULL,
  input_revision_hash TEXT NOT NULL,
  user_instruction TEXT NOT NULL,
  settings_snapshot_json TEXT NOT NULL,
  context_snapshot_json TEXT,
  context_trace_json TEXT,
  token_usage_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL,
  stage TEXT NOT NULL,
  completion_reason TEXT,
  adopted_revision_hash TEXT,
  finalized_revision_hash TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK(id LIKE 'ct_%'),
  CHECK(target_position >= 0),
  CHECK(canon_revision >= 1),
  CHECK(story_memory_through_position >= -1),
  CHECK(state IN (
    'queued', 'running', 'awaiting_user', 'completed',
    'failed', 'cancelled', 'interrupted', 'outdated'
  )),
  CHECK(stage IN (
    'context', 'planner', 'writer', 'checker', 'repair',
    'awaiting_user'
  )),
  CHECK(completion_reason IS NULL OR completion_reason IN ('adopted', 'abandoned')),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
  FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE SET NULL,
  FOREIGN KEY(canon_snapshot_id) REFERENCES continuation_canon_snapshots(id) ON DELETE SET NULL
);

CREATE INDEX idx_continuation_runs_project_created
  ON continuation_generation_runs(project_id, created_at DESC);
CREATE INDEX idx_continuation_runs_chapter_created
  ON continuation_generation_runs(chapter_id, created_at DESC);
CREATE INDEX idx_continuation_runs_state
  ON continuation_generation_runs(state, updated_at);
```

`source_snapshot_json`、`settings_snapshot_json`、`context_snapshot_json` 都必须带 `schemaVersion`。`source_id/canon_snapshot_id` 允许在用户删除原著后被 `SET NULL`，审计信息仍由冻结 JSON 保留；此类 run 必须标为 `outdated`，不可恢复生成。`context_snapshot_json` 是一次 run 的冻结输入，Planner、Writer、Checker、Repair 只能从它派生各阶段 prompt，不得在阶段间重新读取“最新” Canon、Story Memory 或项目设置。

`state`：

```ts
type ContinuationRunState =
  | 'queued'
  | 'running'
  | 'awaiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'outdated';
```

### 7.3 生成产物与 Planner

Writer/Repair 的正文不能只存在 store 中：

```sql
CREATE TABLE continuation_generation_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  repair_round INTEGER NOT NULL DEFAULT 0,
  parent_artifact_id TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(stage IN ('writer', 'repair', 'user_edit')),
  CHECK(repair_round BETWEEN 0 AND 3),
  UNIQUE(run_id, content_hash),
  FOREIGN KEY(run_id) REFERENCES continuation_generation_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(parent_artifact_id) REFERENCES continuation_generation_artifacts(id) ON DELETE SET NULL
);

CREATE INDEX idx_continuation_artifacts_run_created
  ON continuation_generation_artifacts(run_id, created_at);

CREATE TABLE continuation_plans (
  run_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  plan_json TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  confirmation_status TEXT NOT NULL DEFAULT 'not_required',
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  CHECK(schema_version >= 1),
  CHECK(confirmation_status IN ('not_required', 'pending', 'confirmed', 'rejected')),
  FOREIGN KEY(run_id) REFERENCES continuation_generation_runs(id) ON DELETE CASCADE
);
```

Planner 结果可展示给用户，但是否必须确认由产品设置决定。默认“平衡”模式可直接进入 Writer，用户仍可在结果页查看。

### 7.4 `continuation_check_results`

```sql
CREATE TABLE continuation_check_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  chapter_id INTEGER NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  category TEXT NOT NULL,
  subtype TEXT NOT NULL,
  severity TEXT NOT NULL,
  confidence REAL NOT NULL,
  generated_start INTEGER,
  generated_end INTEGER,
  generated_excerpt TEXT NOT NULL,
  description TEXT NOT NULL,
  entity_ref_type TEXT,
  entity_ref_id TEXT,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  suggested_fix TEXT,
  resolution_status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(category IN (
    'world', 'character', 'relationship', 'plot',
    'experience', 'knowledge', 'timeline', 'style'
  )),
  CHECK(severity IN ('info', 'warning', 'error', 'blocking')),
  CHECK(confidence BETWEEN 0 AND 1),
  CHECK(entity_ref_type IS NULL OR entity_ref_type IN (
    'canon_character', 'continuation_entity', 'plotline', 'world'
  )),
  CHECK(
    (entity_ref_type IS NULL AND entity_ref_id IS NULL)
    OR
    (entity_ref_type IS NOT NULL AND entity_ref_id IS NOT NULL)
  ),
  CHECK(
    (generated_start IS NULL AND generated_end IS NULL) OR
    (generated_start >= 0 AND generated_end > generated_start)
  ),
  CHECK(resolution_status IN (
    'open', 'auto_repaired', 'accepted_by_user',
    'dismissed_by_user', 'obsolete'
  )),
  FOREIGN KEY(run_id) REFERENCES continuation_generation_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
  FOREIGN KEY(artifact_id) REFERENCES continuation_generation_artifacts(id) ON DELETE CASCADE
);

CREATE INDEX idx_continuation_checks_run_artifact
  ON continuation_check_results(run_id, artifact_id, severity);
```

`generated_start/generated_end` 使用 `Utf16Offset`、半开区间 `[start, end)`；`artifact_hash` 必须与 `artifact_id` 对应内容相同。`evidence_ids_json` 中每个 ID 必须属于该 run 冻结的 Canon snapshot 且在 boundary 内。Repair 后旧结果标为 `obsolete`，不可错挂到新正文。

`category`：

- `world`
- `character`
- `relationship`
- `plot`
- `experience`
- `knowledge`
- `timeline`
- `style`

`severity`：

- `info`
- `warning`
- `error`
- `blocking`

`resolution_status`：

- `open`
- `auto_repaired`
- `accepted_by_user`
- `dismissed_by_user`
- `obsolete`

### 7.5 `continuation_state_proposals`

从最终正文提取但尚未确认的变化：

```sql
CREATE TABLE continuation_state_proposals (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  chapter_id INTEGER NOT NULL,
  source_run_id TEXT,
  extraction_content_hash TEXT NOT NULL,
  chapter_revision_hash TEXT NOT NULL,
  proposal_type TEXT NOT NULL,
  subject_ref_type TEXT,
  subject_ref_id TEXT,
  payload_json TEXT NOT NULL,
  proposal_fingerprint TEXT NOT NULL,
  evidence_start INTEGER NOT NULL,
  evidence_end INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decision_note TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(proposal_type IN (
    'character_state', 'relationship_change', 'plot_advance',
    'character_experience', 'knowledge_change', 'new_world_fact',
    'new_character', 'new_location', 'new_organization',
    'foreshadowing', 'other'
  )),
  CHECK(subject_ref_type IS NULL OR subject_ref_type IN (
    'canon_character', 'continuation_entity', 'plotline', 'world'
  )),
  CHECK(evidence_start >= 0 AND evidence_end > evidence_start),
  CHECK(status IN ('pending', 'accepted', 'rejected', 'superseded', 'invalidated')),
  UNIQUE(project_id, chapter_id, chapter_revision_hash, proposal_fingerprint),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
  FOREIGN KEY(source_run_id) REFERENCES continuation_generation_runs(id) ON DELETE SET NULL
);

CREATE INDEX idx_continuation_proposals_project_status
  ON continuation_state_proposals(project_id, status, chapter_id);
```

`proposal_fingerprint` 是规范化后的 `proposal_type + subject ref + payload + evidence range` 的 SHA-256，用于保证 State Extraction 重试幂等。

`proposal_type`：

- `character_state`
- `relationship_change`
- `plot_advance`
- `character_experience`
- `knowledge_change`
- `new_world_fact`
- `new_character`
- `new_location`
- `new_organization`
- `foreshadowing`
- `other`

`status`：

- `pending`
- `accepted`
- `rejected`
- `superseded`
- `invalidated`

### 7.6 `continuation_state_events`

只保存用户确认 proposal 后的续写结构化事实：

```sql
CREATE TABLE continuation_state_events (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE,
  project_id INTEGER NOT NULL,
  chapter_id INTEGER NOT NULL,
  chapter_position INTEGER NOT NULL,
  chapter_revision_hash TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity_refs_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  valid_from_position INTEGER NOT NULL,
  valid_to_position INTEGER,
  created_at TEXT NOT NULL,
  invalidated_at TEXT,
  invalidation_reason TEXT,
  CHECK(chapter_position >= 0),
  CHECK(valid_from_position >= 0),
  CHECK(valid_to_position IS NULL OR valid_to_position > valid_from_position),
  FOREIGN KEY(proposal_id) REFERENCES continuation_state_proposals(id) ON DELETE CASCADE,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
);

CREATE INDEX idx_continuation_events_project_position
  ON continuation_state_events(project_id, valid_from_position, invalidated_at);
CREATE INDEX idx_continuation_events_chapter
  ON continuation_state_events(chapter_id, invalidated_at);
```

规则：

- Source Canon 不被更新。
- State event 可以覆盖续写阶段的“当前状态”，但保留历史。
- 章节修改、删除和回退时按 revision hash 失效。
- 位置字段使用 `ContinuationChapterPosition`，不是原著字符 offset。
- 由 position=`p` 的定稿章节产生的 event 写 `chapter_position=p`、`valid_from_position=p`；查询目标章节 `t` 时只应用 `valid_from_position < t`，因此不会把本章结尾状态倒灌到本章开头。
- `entity_refs_json` 中每个引用必须显式带 `refType`，不得让 Canon character id 与续写实体 id 共用无类型数字。
- Story Memory 重建通过持久化 outbox 编排，不把 LLM 调用塞进 SQLite 事务。

### 7.7 续写新增实体

跨 Canon 与续写实体统一使用：

```ts
type TypedEntityRef =
  | { refType: 'canon_character'; id: number }
  | { refType: 'continuation_entity'; id: string }
  | { refType: 'plotline'; id: number }
  | { refType: 'world'; id: 'world' };
```

```sql
CREATE TABLE continuation_entities (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  profile_json TEXT NOT NULL DEFAULT '{}',
  created_from_proposal_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(entity_type IN ('character', 'location', 'organization')),
  CHECK(status IN ('active', 'merged', 'invalidated')),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(created_from_proposal_id) REFERENCES continuation_state_proposals(id) ON DELETE CASCADE
);

CREATE TABLE continuation_entity_aliases (
  entity_id TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  display_alias TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(entity_id, normalized_alias),
  FOREIGN KEY(entity_id) REFERENCES continuation_entities(id) ON DELETE CASCADE
);
```

确认“新人物/地点/组织”proposal 时创建 `continuation_entity`；若用户映射到现有 Canon entity，则 event 直接引用 `canon_*`，不得复制 Canon 记录。

### 7.8 状态同步 outbox

```sql
CREATE TABLE continuation_state_sync_outbox (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  chapter_id INTEGER,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK(operation IN ('extract_state', 'apply_event', 'rebuild_story_memory')),
  CHECK(state IN ('pending', 'running', 'completed', 'failed', 'interrupted', 'cancelled')),
  CHECK(attempt_count >= 0),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
);

CREATE INDEX idx_continuation_outbox_state
  ON continuation_state_sync_outbox(state, created_at);
```

冷启动把遗留 `running` 项标为 `interrupted` 后重试。`dedupe_key` 至少包含 operation、chapter id、revision hash；重复点击定稿/确认不得产生重复事件或重复记忆更新。

### 7.9 `continuation_style_profiles`

Phase 3 增加轻量文风资料：

```sql
CREATE TABLE continuation_style_profiles (
  project_id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL,
  canon_snapshot_id TEXT NOT NULL,
  canon_revision INTEGER NOT NULL,
  narrative_person TEXT NOT NULL DEFAULT '',
  tense TEXT NOT NULL DEFAULT '',
  average_sentence_length REAL NOT NULL DEFAULT 0,
  average_paragraph_length REAL NOT NULL DEFAULT 0,
  dialogue_ratio REAL NOT NULL DEFAULT 0,
  description_ratio REAL NOT NULL DEFAULT 0,
  pacing_notes TEXT NOT NULL DEFAULT '',
  lexical_notes TEXT NOT NULL DEFAULT '',
  sample_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  review_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(canon_revision >= 1),
  CHECK(average_sentence_length >= 0),
  CHECK(average_paragraph_length >= 0),
  CHECK(dialogue_ratio BETWEEN 0 AND 1),
  CHECK(description_ratio BETWEEN 0 AND 1),
  CHECK(review_status IN ('pending', 'confirmed', 'ignored')),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
  FOREIGN KEY(canon_snapshot_id)
    REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE
);
```

只保存统计和短样本引用，不保存用于大段复制的原文集合。

### 7.10 备份归属

上述所有 Phase 3 表均为用户业务数据，必须加入现有 **backup format v3** manifest；不得再写“按历史策略决定”。运行历史正文可被用户删除，但备份语义必须确定：

- settings、artifacts、plans、checks、proposals、events、entities、aliases、style profiles：`backup: true`。
- runs：`backup: true`，并保存恢复审计所需的冻结快照。
- state sync outbox：`backup: true`；恢复时将 `running` 归一为 `interrupted`。
- 恢复顺序遵循 FK：settings/runs → artifacts/plans/checks → proposals/entities/events → outbox/style。

## 8. Context 构建

### 8.1 服务结构

必须新增：

```text
src/services/continuation/generation/
├── continuationContextBuilder.ts
├── continuationGenerationRunner.ts
├── continuationPromptCompiler.ts
├── continuationChecker.ts
├── continuationRepairService.ts
├── continuationStateService.ts
├── continuationStateOutboxWorker.ts
└── continuationContextTrace.ts
```

必须复用现有 Story Memory 的 checkpoint 读取、eligible/due 计算、token 估算和失效算法，不能复制另一套算法；但不得直接调用当前 generation-mode `buildContext()`，因为它在 hard-due 时可能隐式发起 Story Memory LLM 请求。

Context 预检只能：

1. 读取现有 checkpoint 和 pending 摘要；
2. 计算 memory 是否 soft/hard due；
3. hard due 时阻断 strict 生成并显示“先更新故事记忆”，或由用户显式启动独立 memory task；
4. 独立 task 的 token/失败/取消单独记账；
5. 禁止把该调用隐藏在“构建上下文”进度中。

### 8.2 输入

```ts
interface BuildContinuationContextInput {
  projectId: number;
  targetChapterId: number;
  targetPosition: ContinuationChapterPosition;
  currentChapterContent: string;
  userInstruction: string;
  modelContextLimit: number;
  maxOutputTokens: number;
  outputReservePercent: number;
}
```

构建成功后持久化：

```ts
interface ContinuationContextSnapshot {
  schemaVersion: 1;
  projectId: number;
  targetChapterId: number;
  targetPosition: ContinuationChapterPosition;
  source: ContinuationSourceSnapshot;
  canon: {
    snapshotId: string;
    revision: number;
    boundaryGlobalCharOffset: Utf16Offset;
    capabilities: CanonCapabilities;
  };
  storyMemory: {
    stateFingerprint: string;
    throughPosition: ContinuationChapterPosition | -1;
    status: string;
  };
  inputRevisionHash: string;
  settingsSnapshot: ContinuationGenerationSettingsSnapshot;
  bundles: ContinuationContextBundles;
  createdAt: string;
}

interface ContinuationGenerationSettingsSnapshot {
  schemaVersion: 1;
  values: ContinuationGenerationSettings;
  resolvedModelConfigIds: {
    planner: number;
    writer: number;
    checker: number | null;
    repair: number | null;
    stateExtraction: number;
  };
}

interface ContinuationContextBundles {
  lockedRules: string[];
  canon: CanonContextBundle;
  effectiveState: EffectiveContinuationState;
  seam: { summary: string; excerpt: string };
  recentChapters: Array<{
    chapterId: number;
    position: ContinuationChapterPosition;
    revisionHash: string;
    excerpt: string;
  }>;
  storyMemory: { summary: string; estimatedTokens: number };
  episodic: Array<{ chapterId: number; summary: string }>;
  style: ContinuationStyleProfile | null;
  userInstruction: string;
}
```

同一 run 的所有阶段必须使用同一份 snapshot。Source 被替换、active Canon 改变、Canon revision 增加、目标章节 hash 改变时，尚未采纳的 run 标为 `outdated`。

### 8.3 分阶段编译与优先级

不要构造一份通用 prompt 再给四个阶段复用。Context Builder 先产生无 Planner 内容的基础 bundles，Prompt Compiler 再按阶段选择：

| 阶段 | 必须输入 | 明确排除 |
|---|---|---|
| Planner | 锁定规则、Canon hard facts、有效续写状态、人物经历/知识、活跃剧情、接缝、最近正文、用户要求 | Planner 自身输出、Checker 结果 |
| Writer | Planner 已确认版本、人物/关系/知识、接缝、最近正文、文风、用户要求 | 无关 Canon 证据全文 |
| Checker | 待检 artifact、全部约束类别、可引用 evidence 索引 | Writer 的隐藏推理 |
| Repair | 待修 artifact、仍 open 的 check、对应证据和局部上下文 | 无问题段落的大量重复上下文 |
| State extraction | 已定稿正文、定稿 hash、有效实体索引、提取 schema | 未定稿 artifact、未来章节 |

各阶段内部固定优先级：

```text
系统安全/输出 Schema
> 用户 locked 规则
> Canon hard/confirmed
> 目标位置有效状态、人物知识与关系
> 活跃剧情和关键经历
> 接缝与最近正文
> Story Memory / Episodic
> 文风样本
> 模型推测
```

Planner 输出只能在 Writer 及其后阶段注入，不属于基础 Context snapshot 的 Canon 数据。

### 8.4 参与人物识别

来源：

- 用户要求中的人物。
- 章节概要。
- 当前正文。
- 上一章末尾。
- Planner 候选。
- Story Memory 实体。
- 活跃主线参与人物。

实体识别必须调用 Phase 2 resolver，并复用冻结的 snapshot id/revision，不得在 Context 构建中二次读取不同 Canon snapshot。续写新增实体通过 `continuation_entity` typed ref 解析。

### 8.5 Token 预算

预算原则：

```text
硬规则与关键状态
> 人物关系与知识边界
> 主线剧情
> 最近正文
> 关键经历
> Episodic 证据
> 风格样本
```

要求：

- 先按优先级裁剪，再按时间排序。
- 世界规则 hard 和用户 locked 不得被弱资料挤出。
- 极小预算使用 token-safe 截断。
- 每个 bundle 有独立上限。
- trace 记录每类候选数、选中数、token 和丢弃原因。
- 超预算或输出预留不足时遵循现有显式阻断契约。
- 不新增“为了选择上下文而先调用一次远程 LLM”的前置调用。
- 每个阶段分别计算输入预算；不得用 Planner 的预算假装 Writer/Checker 也不会超限。
- `modelContextLimit` 和 `maxOutputTokens` 取该阶段已冻结的 LLM config，而不是统一 active config。
- local model 必须考虑已加载模型的实际 context length；配置超出实际值时按较小者阻断/裁剪。

### 8.6 原著接缝

第一次续写必须重点提供：

- 原著边界章节摘要。
- 最后一段或若干段原文。
- 续写点人物状态。
- 活跃主线。
- 未解决伏笔。

后续章节逐渐降低原著末尾原文权重，提高最近续写正文和已确认状态权重，但原著硬规则始终有效。

### 8.7 Canon 能力门禁

- strict：active Canon 必须具备 Phase 2 handoff 声明的完整能力，且目标章节之前不得存在失败的 state extraction 或待确认重大 proposal；否则阻断并给出明确修复入口。
- balanced：允许降级，但必须在结果页列出缺失能力、pending proposal 和 Story Memory stale 状态。
- loose：允许继续，但不得把缺失类别显示成“检查通过”。
- Quick Canon 只拥有其真实 capabilities，不能以空数组冒充“无冲突”。

## 9. 四阶段流水线

四阶段只描述“生成正文”链路；定稿后的 State Extraction 是独立、可失败、可重试的第五次模型任务，不得伪装成采纳事务的一部分。

运行状态机：

```text
queued
→ context
→ planner
→ [awaiting_user]
→ writer
→ checker
→ repair ↔ checker（最多 max_repair_rounds）
→ awaiting_user
→ completed（用户采纳或放弃）
```

任一阶段可进入 `failed/cancelled/interrupted/outdated`。阶段开始前写 `running + stage`，阶段产物落库后才推进下一阶段；不得只靠 Zustand 内存状态。每阶段按 `settings_snapshot_json` 中的 config id 独立路由，调用统一 `providerRegistry`、`requestScheduler`、`requestPolicy`、`networkPolicy` 和 abort signal。

Planner、Checker、State Extraction 要求结构化输出：

- 在线 provider 可请求 `json_object`，但仍必须运行本地 schema validator。
- `llama.cpp` 当前忽略 `responseFormat`，必须采用提示词 JSON + 容错提取 + schema 校验。
- 使用 Phase 2 的 capability probe；不满足可靠结构化输出时 strict 阻断，balanced/loose 显式降级或跳过该能力。
- schema 校验失败允许至多一次“仅修复 JSON”重试，并计入 token；仍失败即阶段失败，不得用空对象继续。

### 9.1 Planner

输入：

- Canon bundle。
- Story Memory。
- 最近正文。
- 用户要求。

输出必须结构化：

```ts
interface ContinuationPlan {
  schemaVersion: 1;
  chapterGoal: string;
  centralConflict: string;
  beats: StoryBeat[];
  participatingCharacterIds: number[];
  characterActions: CharacterAction[];
  plotAdvances: PlotAdvance[];
  foreshadowingActions: ForeshadowingAction[];
  proposedStateChanges: ProposedStateChange[];
  risks: ContinuationRisk[];
}
```

Planner 要求：

- 不直接写完整正文。
- 不提出违反 hard/locked 规则的计划。
- 明确哪些主线会推进。
- 标记重大关系、死亡、复活和能力变化。
- 高风险变更根据设置要求用户确认。
- 结果规范化后计算 SHA-256，保存到 `continuation_plans`；用户编辑/确认后重新计算 hash，Writer 只读取已选定 hash。

### 9.2 Writer

输入：

- 已编译上下文。
- Planner 结果。
- 章节目标字数。
- 文风特征。
- 用户要求。

要求：

- 输出正文，不混入分析说明。
- 不复制大段原文。
- 保持叙事视角和人物语气。
- 遵循人物知识边界。
- 对新增人物、地点和组织遵循项目策略。
- 保留可定位的段落/字符索引供 Checker 使用。
- 完整正文先写入 `continuation_generation_artifacts`，计算 canonical UTF-8 SHA-256，再进入 Checker。
- 流式 token 只用于预览；中断流不能成为有效 artifact。沿用现有流式中断回退非流式策略，但两次请求都必须计费和可取消。

### 9.3 Checker

检查维度：

#### 世界观

- 力量规则。
- 地理。
- 社会规则。
- 历史事实。
- 死亡/复活等特殊限制。

#### 人物画像

- 核心性格。
- 价值观。
- 能力和弱点。
- 语言风格。
- 行为动机。

#### 人物关系

- 当前关系状态。
- 单向认知。
- 秘密关系。
- 关系变化是否有铺垫。

#### 主线剧情

- 是否偏离当前目标。
- 是否无故解决重要伏笔。
- 是否破坏因果。
- 是否遗忘重要活跃剧情线。

#### 人物个人经历

- 是否忽略创伤、损失、成长和关键发现。
- 行为是否与经历矛盾。
- 情绪反应是否合理。

#### 人物知识

- 人物是否知道不该知道的信息。
- 是否忘记已经知道的核心事实。
- 是否把误解当真相。

#### 时间线

- 时间顺序。
- 时长。
- 位置移动。
- 事件因果。
- 人物生死。

#### 文风

- 视角突变。
- 时态突变。
- 对话和描述比例明显失衡。
- 模板化和解释腔。

Checker 输出：

- 问题类别和子类。
- 严重级别。
- 生成正文位置。
- 冲突说明。
- Canon entity。
- 原著证据 ID。
- 建议修复。

没有证据时只能输出 warning，并明确是推测。

每条结果必须绑定 `artifact_id + artifact_hash`，位置为 JS 字符串语义的 UTF-16 半开区间。Checker 未覆盖的 capability 显示“未检查”，不能显示“通过”。

### 9.4 Repair

策略：

- 只修复 Checker 标记片段。
- 保留无问题段落。
- 修复后重新检查相关类别。
- 最大自动修复轮数可配置，默认有限。
- 连续失败进入用户决策，不无限重试。
- blocking 问题未解决时不能标记“通过”，但用户仍可选择保留并记录接受风险。
- 每次 repair 生成独立 revision，便于比较和回退。
- Repair 产生新 artifact；只对新 artifact 重新检查受影响类别和所有 blocking 类别，旧 check 标为 `obsolete`。
- 用户“保留 blocking 风险”必须逐项落 `accepted_by_user` 并保存 decision note，不能用一个全局按钮抹掉审计。

## 10. 用户交互

### 10.1 写作页面

续写项目的 AI 入口统一显示“续写”或“AI 续写”，不再使用容易混淆的“自由写作”文案。

发起流程：

1. 输入本章要求。
2. 选择目标字数和严格程度。
3. 可选查看/编辑 Planner。
4. 运行 Writer、Checker 和 Repair。
5. 查看正文和一致性报告。
6. 采纳为章节草稿、重新生成或放弃。
7. 用户在编辑器中继续修改后，使用现有“定稿”动作完成最终正文。

### 10.2 结果页

显示：

- 使用的 Canon snapshot。
- Context token 总量。
- 各类 Context 使用量。
- Planner 摘要。
- 正文版本。
- 一致性评分。
- blocking/error/warning 数量。
- 每条问题的原著证据。
- Repair 前后 diff。
- “采纳为草稿”和“放弃”操作。
- 缺失 Canon capability、未更新 Story Memory、待确认重大 proposal 的明确状态。

### 10.3 用户决策

- 采纳为草稿：在单个 SQLite 事务中创建采纳前 revision、写入选中 artifact 正文、保持章节非 finalized、保存 `adopted_revision_hash`。不得创建 proposal/event，不得触发 Story Memory LLM。
- 编辑后定稿：先 flush 2 秒防抖队列，再对规范化正文计算 SHA-256；调用现有章节定稿入口，并在同一**本地事务**中写 `finalized_revision_hash`、标记 Story Memory dirty、插入 `extract_state` outbox。
- 放弃：run 标记 `completed` 且 `completion_reason='abandoned'`，不得改章节、产生 proposal/event 或触发记忆。
- 忽略 Checker 问题：记录用户 decision。
- 重新生成：旧 run 保留审计，不进入状态层。
- 回退章节 revision：对应 state event 失效并触发后续 dirty。

若采纳时章节正文 hash 已不同于 run 的 `input_revision_hash`，必须弹出 diff/覆盖确认；不得静默覆盖用户在生成期间的编辑。

## 11. 状态回灌

### 11.1 触发时机

State Extraction 只在以下条件同时满足时由 outbox worker 触发：

- 章节正文已保存。
- 用户明确定稿，而非仅采纳草稿。
- 当前正文 hash 与 `finalized_revision_hash` 一致。
- 章节不是原著章节。
- run 未 outdated。
- 没有未处理的保存失败。

定稿事务不等待模型。State Extraction 是用户可见的独立任务，失败时章节仍保持已定稿，outbox 保留失败原因和“重试状态提取”入口。

### 11.2 提取内容

从最终正文提取：

- 人物状态变化。
- 人物关系变化。
- 主线/支线推进。
- 新人物经历。
- 人物知识变化。
- 新世界事实候选。
- 新人物、地点、组织候选。
- 新伏笔和已解决伏笔。

所有 proposal 绑定 `chapter_revision_hash` 和 State Extraction 实际读取的 `extraction_content_hash`；两者必须等于当前定稿正文 SHA-256。提取结果的 evidence offset 必须在当前定稿正文范围内，否则整批拒绝落库。

### 11.3 预览与确认

默认策略：

- 普通状态变化可批量确认。
- 重大关系变化必须确认。
- 能力体系改变必须确认。
- 人物死亡必须确认。
- 复活按策略阻断或确认。
- 新世界硬规则不能自动进入原著 Canon，只进入续写状态候选。
- 用户拒绝的 proposal 不应用。
- 即使策略为 `allow`，也必须先生成 proposal；可在同一 worker 中自动确认普通 proposal，但仍保留审计。
- 重大 proposal 未确认前不进入 Effective State；strict 模式下会阻断后续章节生成，balanced 模式显式警告。

### 11.4 与 Story Memory 集成

确认 state proposal 时，单个本地 SQLite 事务：

1. 创建 `continuation_state_event`。
2. 标记 proposal accepted。
3. 必要时创建/映射 `continuation_entity`。
4. 调用现有原子失效 helper，将相关章节及后续 Story Memory 标记 dirty。
5. 插入幂等的 `apply_event`/`rebuild_story_memory` outbox。

事务提交后，worker 才按现有 checkpoint policy 调用 LLM 批量整理。模型调用绝不能处于 SQLite transaction 内。

失败时：

- event、proposal decision、dirty 标记、outbox 必须一起提交或一起回滚。
- Story Memory LLM 失败不回滚已确认 event；保持 dirty + failed outbox，可重试。
- outbox 使用 dedupe key，重复确认或重试不得创建重复 event/checkpoint。
- state extraction token 单独记录到现有 `llm_usage_logs`，不混入四阶段生成总额。

### 11.5 修改、删除、回退和改序

章节修改：

- 已定稿章节再次保存时比较 hash；hash 改变即清除/更新 finalized 状态，并在同一事务中把该章 proposal/event/check 失效。
- 当前及后续 Story Memory batch dirty，并插入重建 outbox。
- 后续 state event 按目标位置重新评估；在重建完成前 strict 生成阻断。
- 不影响原著 Canon。

章节删除：

- 利用现有 `ON DELETE` 清理 run/artifact/check；需要审计的 decision 先写删除审计，不得留下悬空 FK。
- 同一事务失效/删除该章 state event 并标记后续记忆 dirty。
- 触发后续 checkpoint 重建。
- 保留必要审计记录，遵循现有删除契约。

章节回退或改序：

- 必须扩展当前统一的 revision/reorder 原子 helper，而不是只在 UI handler 中补逻辑。
- 失效范围从最早受影响 `ContinuationChapterPosition` 开始。
- position 变化后重写仍有效 event 的 `chapter_position/valid_from_position`，或全部失效后重提取；实现只能选择一种并写测试，默认采用“失效后重提取”以降低错序风险。

## 12. 连续性查询融合

Phase 3 目标位置不再等于原著 boundary。查询时需融合：

```text
active Canon snapshot 在原著 boundary 的最终状态
+
boundary 后已确认 continuation_state_events
+
目标章节之前的现有 Story Memory（作为摘要补充，不覆盖结构化事实）
```

例如人物当前位置：

1. 取原著 boundary 前最后 snapshot。
2. 按章节 position 应用已确认状态事件。
3. 只应用目标章节之前事件。
4. 若事件来源章节 dirty/outdated，则不应用并提示重建。

应新增统一 API：

```ts
getEffectiveContinuationState(input: {
  projectId: number;
  canonSnapshotId: string;
  canonRevision: number;
  targetPosition: ContinuationChapterPosition;
  entityRefs?: Array<
    | {refType: 'canon_character'; id: number}
    | {refType: 'continuation_entity'; id: string}
  >;
}): Promise<EffectiveContinuationState>;
```

Context Builder 不得自己拼装状态覆盖逻辑。服务必须：

- 校验 snapshot 是该项目当前 active、ready snapshot。
- 只应用 `valid_from_position < targetPosition` 且未失效的 event。
- 同字段冲突按“用户 locked > 较晚已确认 event > Canon > Story Memory 摘要”处理，并在 trace 留痕。
- 遇到 dirty/failed state extraction 时返回完整 freshness 状态，由 §8.7 决定阻断或降级。

## 13. 文风约束

### 13.1 提取

从 boundary 内原著提取：

- 叙事人称。
- 时态。
- 平均句长。
- 平均段落长度。
- 对话比例。
- 描写比例。
- 节奏特征。
- 场景切换方式。
- 少量代表性证据。

### 13.2 使用

- 以特征说明为主。
- 原文样本严格限长。
- 不连续注入相邻大段原文。
- 提示模型模仿抽象特征而非复制句子。
- Checker 检查明显视角/时态漂移。
- 用户可关闭文风约束，不影响 Canon 一致性。

## 14. 失败、取消和恢复

- 复用现有 `PipelineForegroundService` 的保活能力，不复用旧 `pipelineTaskStore` 作为权威状态；新增 continuation store，从 repository hydrate。
- 每一阶段在开始与成功边界写可恢复状态；网络失败保留已落库 Planner/Context/artifact，不覆盖章节。
- 取消先触发 abort，再持久化 `cancelled`；取消与响应成功竞态通过 repository compare-and-set 保证终态唯一。
- App 重启把 `running` 标记 `interrupted`，显示“从最后完成阶段继续”；不恢复半截流，也不自动重新付费。
- Context snapshot 变化后 run 标记 outdated，不允许继续 repair。
- 自动 repair 达上限后停止。
- 本地模型 OOM 给出降低上下文、输出或模型建议。
- 四阶段生成失败不得更新 state event 或 Story Memory。
- 定稿后的 State Extraction/Story Memory 失败遵循 outbox 规则：不撤销定稿或已确认 event，保持 stale/dirty 并允许幂等重试。
- 前台通知 task id 为 `ct_` 时深链到 continuation 结果；旧 task id 仍走现有结果页。

## 15. 可观测性

Context trace 至少包含：

```ts
interface ContinuationContextTrace {
  sourceId: number;
  canonSnapshotId: string;
  canonRevision: number;
  targetPosition: ContinuationChapterPosition;
  entityRefs: TypedEntityRef[];
  storyMemoryFingerprint: string;
  freshness: {
    canonReady: boolean;
    storyMemoryStatus: string;
    pendingStateExtractionCount: number;
    pendingMajorProposalCount: number;
  };
  categories: Array<{
    name: string;
    candidates: number;
    selected: number;
    tokens: number;
    omittedReasonCounts: Record<string, number>;
  }>;
  totalInputTokens: number;
  reservedOutputTokens: number;
  omittedCapabilities: string[];
}
```

Checker 指标：

- 各类别问题数。
- blocking 率。
- 自动修复成功率。
- 用户忽略率。
- 用户修改率。
- 重新生成率。
- 每章 Context token。
- 每章总 token。
- 连续 30 章状态重建耗时。

禁止记录完整 prompt 和正文到普通日志。现有 LLM 用量日志可记录脱敏元数据。

## 16. 性能和成本

- Context 构建不得发起额外远程模型调用。
- Planner、Writer、Checker、Repair、State Extraction 必须按 §7.1 配置分别路由；为空才回退 run 创建时的 active config。
- Checker 可由用户关闭，但 strict 模式默认开启。
- Repair 只在存在 error/blocking 或用户开启时执行。
- State Extraction 是定稿后的额外调用，UI 在定稿前展示“将产生一次状态提取调用”；失败可重试并单独计费。
- 使用缓存时必须绑定 source snapshot、Canon version、目标 position、章节 hash 和用户要求 hash。
- 缓存不得跨 boundary、source 或 revision 复用。
- 30 章连续续写验收中不得出现 Context 无界增长。
- Context token 必须在模型限制和输出预留内。

## 17. 测试夹具与评测

### 17.1 基础夹具

建立一部仓库自有中文测试小说：

- 30 个原著章节。
- 5 个主要人物。
- 2 个同名/别名歧义。
- 1 套硬力量规则。
- 1 条主线和 3 条支线。
- 4 次关系变化。
- 6 个关键人物经历。
- 3 个角色知识秘密。
- 续写边界在第 20 章。
- 第 21 至 30 章包含未来揭示，必须零泄漏。

建立至少 10 个续写测试任务，故意覆盖：

- 世界规则冲突。
- 人物 OOC。
- 关系跳变。
- 主线跑偏。
- 忽略人物创伤。
- 人物知道未来秘密。
- 时间线矛盾。
- 文风视角突变。
- 合法新增人物。
- 合法推进伏笔。

### 17.2 单元测试

- Context 优先级。
- token 裁剪。
- hard rule 不被裁掉。
- target position 不得读取未来章节。
- effective state 合并。
- dirty state event 不应用。
- Planner Schema。
- Checker Schema。
- llama.cpp 非 JSON/截断 JSON 的校验与一次修复上限。
- evidence 链接。
- UTF-16 半开位置与 emoji/代理对定位。
- Repair 片段范围。
- artifact/hash 绑定，旧 check 不得应用到新正文。
- state proposal 确认。
- 采纳草稿不回灌；只有定稿插入 extraction outbox。
- proposal 确认事务同时写 event、dirty 和 outbox。
- outbox dedupe、冷启动 interrupted 与幂等重试。
- revision hash 失效。
- chapter delete 重建。
- chapter reorder 从最早位置失效。
- strict/balanced/loose 的 capability 与 stale 状态门禁。
- 每阶段 LLM config 冻结和路由。

### 17.3 集成测试

- Phase 2 Canon bundle → Context。
- hard-due Story Memory 预检不隐式调用 LLM。
- Context → pipeline stages。
- Checker → repair → recheck。
- 采纳 → 章节草稿，零 proposal/event/memory 调用。
- 定稿 → extraction outbox → proposal；确认 → event + Story Memory dirty/checkpoint。
- State Extraction/Story Memory 失败不回滚定稿/event，重试不重复。
- 修改 → invalidation → rebuild。
- source 替换 → run outdated。
- Canon 修改 → 缓存失效。
- App kill → run 状态恢复。
- 旧 pipeline task 与 `ct_` continuation run 的通知深链均正常。
- backup/restore → runs、settings、state events 完整。

### 17.4 连续 30 章验收

使用确定性 fake provider 或可重复模型配置：

- 连续创建/生成 30 个续写章节。
- 每章只读取目标位置之前状态。
- 人物 ID 和关系不漂移。
- 世界硬规则无 blocking 违反。
- 活跃主线有可追踪推进。
- state events 与章节 hash 一致。
- 每章定稿后 state extraction 完成或有明确失败状态，重大 proposal 已确认后才生成下一 strict 章节。
- 中途修改第 10 章后，第 11 至 30 章相关状态被正确 dirty/rebuild。
- Context token 不随章节数线性无限增长。
- 无 future source 泄漏。

该验收为 Phase 3 完成阻断项。

### 17.5 E2E

新增：

```text
09-continuation-generate-and-adopt.yaml
10-continuation-check-and-repair.yaml
11-continuation-state-rebuild.yaml
```

覆盖：

- 发起续写。
- 查看 Planner。
- 查看 Context trace 摘要。
- 生成正文。
- 展示一致性问题及证据。
- 自动修复。
- 用户采纳为草稿并定稿。
- 状态 proposal 确认。
- 修改历史章节。
- 后续状态提示重建。
- 重启和备份恢复。

CI 使用 fake provider；真实模型在发布设备矩阵做补充验证。

## 18. 安全与隐私

- 在线生成只发送已选 Context，不发送整本原著。
- UI 显示实际使用的资料类别。
- Prompt/正文不写普通日志。
- 原著证据只在用户展开时显示。
- 用户可关闭在线分析/生成并使用本地模型。
- API Key 仍由 Keychain 管理。
- 备份不包含 API Key。
- 导出或分享一致性报告时默认不附带大段原著。
- 用户放弃的正文可以按现有 revision 策略保留，但不能进入记忆。

## 19. 备份恢复

保持现有 **backup format v3**，按 §7.10 将所有 Phase 3 表加入 manifest、导出顺序和恢复顺序；不得创建“backup v4”或把运行历史留作未决项。

恢复后：

- state events 与章节 revision hash 可校验。
- 不合法或缺失章节的 event 标记 invalidated，不静默应用。
- Story Memory checkpoint 与 state event 不一致时标记 dirty。
- active Canon snapshot 不存在时续写功能阻断并提示重新分析。
- `running` run/outbox 归一成 `interrupted`，用户决定是否重试。
- artifact/check/proposal 的 hash 或 offset 校验失败时隔离该记录并显示恢复报告，不应用到章节状态。
- 旧备份兼容。

## 20. Agent 施工顺序

1. 验证 Phase 1 和 Phase 2 Definition of Done。
2. Schema 21：settings、runs、artifacts、plans、checks、proposal/event/entity、outbox。
3. 迁移、validator、repository、backup format v3 manifest 和恢复校验。
4. 统一 revision/reorder/delete 原子失效 helper 与 Effective State 服务。
5. Context 预检、冻结 snapshot、分阶段 compiler 和 trace。
6. continuation runner/store、冷启动恢复、通知深链和前台服务接入。
7. Planner 与结构化输出 capability 门禁。
8. Writer artifact 持久化。
9. Checker、证据定位和 capability 状态。
10. Repair、artifact diff 和 recheck。
11. 结果页、“采纳为草稿”事务和覆盖冲突处理。
12. 定稿 outbox、State Extraction、proposal 审核和 entity/event 回灌。
13. Story Memory dirty/outbox 重建与失败重试。
14. 文风 profile。
15. 连续 30 章评测。
16. E2E、设备故障注入和性能。
17. README/CHANGELOG/Schema 文档、版本、`npm run verify`、`npm run test:coverage`、`npm run apk:debug` 和设备验证。

不得先接入 Writer 再补 Context 不变量；不得先自动回灌再补 revision 失效。

## 21. 验收标准

### 功能验收

- [ ] 续写项目使用 Canon 驱动的 AI 续写入口。
- [ ] Context 包含五类核心 Canon。
- [ ] Context 包含人物知识边界和目标位置有效状态。
- [ ] 原著边界之后信息零泄漏。
- [ ] Planner 输出可查看。
- [ ] Writer 输出正文。
- [ ] Checker 覆盖五类核心连续性。
- [ ] 问题可跳转原著证据。
- [ ] Repair 局部修复并重新检查。
- [ ] 采纳为草稿不更新 proposal/event/Story Memory。
- [ ] 用户定稿后异步产生可审核 proposal。
- [ ] 确认后更新 state event 和 Story Memory。
- [ ] State Extraction 或 Story Memory 失败不回滚定稿/event，且可幂等重试。
- [ ] 历史章节修改/删除可使后续状态失效并重建。
- [ ] Source Canon 不被自动修改。
- [ ] 支持严格、平衡、宽松和自定义设置。

### 质量验收

- [ ] 连续 30 章测试通过。
- [ ] hard rule 在极小预算下仍优先保留。
- [ ] future source 泄漏为零。
- [ ] 未定稿草稿记忆污染为零。
- [ ] revision hash 不一致的 event 不应用。
- [ ] Checker evidence 链完整。
- [ ] pipeline 取消和失败无永久运行状态。
- [ ] continuation run 与旧 pipeline task 可并存，通知深链不串任务。
- [ ] 每阶段模型路由、冻结配置和本地 JSON capability 门禁通过。
- [ ] Context 构建不会隐式触发 Story Memory LLM。
- [ ] outbox 重试无重复 proposal/event/checkpoint。
- [ ] migration matrix、backup/restore 通过。
- [ ] lint、typecheck、Jest、coverage 通过。
- [ ] Android Debug 和新增 E2E 通过。
- [ ] 本地/在线模型路径均有验证记录。
- [ ] 不记录正文、Prompt 或凭据。

## 22. Definition of Done

Phase 3 只有在以下条件全部满足时完成：

1. Canon 驱动 Context 稳定接入独立 continuation runner，并复用现有 provider/scheduler/foreground 基础能力。
2. 五类核心连续性都可检查并提供证据。
3. 采纳草稿零回灌；定稿后的 State Extraction 和 proposal 决策均可审计、可重试。
4. Story Memory 和结构化 state event 通过原子 dirty + outbox 保持失效/重建一致。
5. 30 章连续验收无 future leakage 和无界 Context 增长。
6. 所有 blocking 问题都有明确用户决策路径。
7. Source 替换、Canon 过期和章节 revision 变化都会阻止错误缓存复用。
8. 完整施工报告包含测试命令、模型配置、Token、耗时、APK、设备和剩余风险。

## 23. 最终产品状态

三阶段完成后，产品应形成以下闭环：

```text
创建原著续写项目
→ 导入 TXT 原著
→ 解析和设置续写边界
→ 分析五类 Canon
→ 用户确认关键设定
→ Canon 驱动章节规划
→ 生成续写正文
→ 连续性检查与局部修复
→ 用户采纳为章节草稿
→ 编辑并定稿
→ 提取并确认续写状态
→ 异步更新 Story Memory
→ 下一章继续
```

最终定位不是“导入全文后找几段相似文本续写”，而是：

> 以原著 Canon 为权威、以章节时间为边界、以用户确认为治理、以结构化状态和 Story Memory 为长期记忆的 Android 长篇续写工作台。
