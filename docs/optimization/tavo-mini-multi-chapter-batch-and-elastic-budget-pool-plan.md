# Tavo Mini“批量写 N 章”与弹性上下文预算池分步建设方案

> 本地仓库：`F:\ClaudeWorkSpace\projects\TAVO-MINI`  
> 远端审计基线：`anjingdtl/tavo-mini main @ 7969a6fcc5a6fb43f2fb06a5c4a20d4f44c479ae`  
> 基线版本：V2.11.31  
> 基线数据库：Schema 40  
> 建设目标：不改变现有单章 Pipeline 的阶段逻辑，以独立批次编排器实现“一次写 N 章”；同时把所有 Pipeline 阶段升级为支持 80% 软上限、跨模块回收、弹性突破和冻结重试的统一上下文预算池。

---

## 1. 产品目标

在“大纲创作”项目中增加独立入口：

```text
批量写章
```

用户流程：

1. 输入较长的局部剧情摘要、阶段目标或故事弧提示词；
2. 指定拆分为 N 章；
3. 指定每章目标字数、Pipeline 模式和可选批次消耗上限；
4. 由 LLM 生成 N 份章纲；
5. 用户预览并编辑标题、梗概、关键节拍和章节交接点；
6. 用户确认后启动批次；
7. 软件严格串行执行 N 个现有单章 Pipeline；
8. 每章成功后自动保存为章节草稿并创建修订记录；
9. 下一章只在上一章真实正文落库后开始；
10. 超时、额度不足、上下文不足、服务异常或应用退出后，批次停在当前章并可安全继续；
11. 完成后保留每章 Pipeline 结果、调用轨迹、预算轨迹和完成质量。

本功能的本质是：

```text
批次编排器
+ 当前稳定的单章 Pipeline
+ 通用弹性预算编译器
+ 通用持久化 LLM Attempt
```

不是：

```text
第二套 Pipeline
内存 for 循环
N 个并发生成任务
恢复旧 batchChapterPipeline
```

---

## 2. 最新代码基线

当前远端已经具备：

- `pipeline_tasks` 与四个阶段 checkpoint 原子创建；
- 首次运行和恢复统一进入 `reconcilePipelineTask()`；
- Draft 请求冻结；
- Review、Fact Check、Proof 由统一编译器生成；
- `ReadyStageRequest` 门禁；
- 最终窗口收缩只裁剪 optional；
- LLM 请求队列及手动/后台优先级；
- Pipeline 前台服务；
- 连接、普通、章节、构建和 Canon 场景的分类超时；
- Schema 40 数据召回及漂移修复；
- 大备份流式校验。

当前预算器仍然是：

```text
模型窗口
- 输出预留
- Safety Margin
- 固定消息
- 完整大纲
- 必需正文
= optional 总容量

optional 按 weight 分配，并尽量把剩余容量重新分完
```

它还不具备：

- 80% 常规软上限；
- 20% 弹性突破区；
- 95% 高风险水位；
- 模块 `min / target / max`；
- 模块相关度和 requirement；
- 预算回收、借入和风险轨迹；
- 同一冻结请求的 allocation 版本。

当前 LLM 层能够区分：

```text
cancelled
connect_timeout
idle_timeout
total_timeout
network_error
provider_error
```

但尚未持久化区分：

```text
safe_retry
outcome_unknown
rate_limit
account_quota
config_error
context_error
batch_budget_exhausted
```

因此施工顺序必须先建设通用预算与 Attempt，再增加批次编排。

---

## 3. 核心不变量

### 3.1 单章 Pipeline 是唯一生成执行器

批次中的每一章仍然调用现有：

```ts
createTask('chapter', chapterId)
runChapterPipeline(taskId, chapter, ...)
resumePipeline(taskId, chapter, ...)
```

禁止复制 Draft、Review、Fact Check、Proof、冻结上下文、checkpoint、CAS 或结果采用逻辑。

### 3.2 批次只负责外层编排

批次只负责：

```text
拆分章纲
创建批次条目
创建当前章节
创建当前 Pipeline Task
等待当前章终态
采用当前结果
推进下一章
暂停/恢复/取消
整体进度与报告
```

### 3.3 严格串行

```text
第 1 章正文落库
→ 第 2 章创建上下文快照
→ 第 2 章正文落库
→ 第 3 章开始
```

禁止提前冻结后续章节上下文，禁止并行启动 N 个单章任务。

### 3.4 一次只创建当前章的 Pipeline Task

批次开始时可以创建 N 个“批次条目”，但只能为当前 item 创建 `pipeline_tasks`。

### 3.5 每章自动保存为草稿，不自动定稿

自动采用必须调用与手动“接受结果”相同的领域服务，保存正文、修订和副作用，但章节保持 `draft`。

### 3.6 失败只能暂停当前章

```text
当前章没有形成可用且已落库的正文
→ 下一章绝不能启动
```

### 3.7 普通重试必须复用冻结请求

同一阶段因网络或可重试服务错误重试时，必须保持消息、模型配置、token 参数、allocation trace 和 request fingerprint 不变。

---

## 4. 第一版范围

### 支持

```text
仅大纲创作模式
独立入口
追加到项目末尾
默认 3 章
最多 10 章
先规划后确认
严格串行
自动保存为 draft
失败即暂停
冷启动恢复
超时和限流重试
额度不足后继续
80%弹性预算
批次消耗上限
独立进度页
```

### 暂不支持

```text
原著续写模式
并行生成
插入现有章节中间
覆盖已有正文
自动跳过失败章节
跨项目批量
运行中修改已启动 item
自动定稿
自动删除已完成章节
```

---

## 5. 总体架构

```text
MultiChapterBatchScreen
        │
        ├─ Batch Chapter Planner
        │      └─ 长摘要 → N 份可编辑章纲
        │
        ├─ Plan Preview / Edit
        │
        └─ Multi-Chapter Batch Reconciler
               ├─ 创建当前章节
               ├─ 原子创建当前 Pipeline Task + checkpoints
               ├─ runChapterPipeline / resumePipeline
               ├─ 自动采用结果为草稿
               ├─ 校验正文与 revision
               └─ 推进下一条 item

所有 Pipeline Stage
        │
        └─ Elastic Stage Request Compiler
               ├─ Mandatory
               ├─ 80% Soft Pool
               ├─ 跨模块回收
               ├─ 80%～95% Burst Pool
               ├─ 95%～100% Emergency Headroom
               ├─ Hard Safety Margin
               └─ Ready / Blocked
```

---

## 6. Schema 41

当前基线 Schema 为 40。本功能建议升级为：

```text
Schema 41
```

新增迁移：

```text
src/services/migrations/v40-to-v41.ts
```

新增四张表：

```text
multi_chapter_batches
multi_chapter_batch_items
multi_chapter_batch_item_runs
pipeline_stage_attempts
```

### 6.1 `multi_chapter_batches`

```sql
CREATE TABLE multi_chapter_batches (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,

  status TEXT NOT NULL,
  source_prompt TEXT NOT NULL,
  chapter_count INTEGER NOT NULL,
  target_words_per_chapter INTEGER NOT NULL,
  pipeline_mode TEXT NOT NULL,

  planner_output_json TEXT,
  planner_hash TEXT,
  planner_request_json TEXT,
  planner_request_fingerprint TEXT,

  start_position INTEGER,
  expected_tail_chapter_id INTEGER,
  current_ordinal INTEGER NOT NULL DEFAULT 1,
  completed_count INTEGER NOT NULL DEFAULT 0,
  active_item_ordinal INTEGER,

  max_llm_calls INTEGER,
  max_input_tokens INTEGER,
  max_output_tokens INTEGER,
  used_llm_calls INTEGER NOT NULL DEFAULT 0,
  used_input_tokens INTEGER NOT NULL DEFAULT 0,
  used_output_tokens INTEGER NOT NULL DEFAULT 0,

  pause_reason TEXT,
  error_code TEXT,
  error_message TEXT,

  lease_owner TEXT,
  lease_expires_at INTEGER,
  row_version INTEGER NOT NULL DEFAULT 0,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  cancelled_at INTEGER,

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

建议状态：

```ts
type MultiChapterBatchStatus =
  | 'draft'
  | 'planning'
  | 'ready'
  | 'running'
  | 'waiting_retry'
  | 'paused_user'
  | 'paused_timeout_unknown'
  | 'paused_account_quota'
  | 'paused_context_budget'
  | 'paused_batch_budget'
  | 'paused_project_changed'
  | 'failed'
  | 'cancelled'
  | 'completed';
```

### 6.2 `multi_chapter_batch_items`

```sql
CREATE TABLE multi_chapter_batch_items (
  batch_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,

  title TEXT NOT NULL,
  synopsis TEXT NOT NULL,
  key_beats_json TEXT NOT NULL,
  carry_in TEXT,
  carry_out TEXT,
  target_words INTEGER NOT NULL,

  status TEXT NOT NULL,
  chapter_id INTEGER,
  active_pipeline_task_id TEXT,
  active_run_no INTEGER NOT NULL DEFAULT 0,

  completion_quality TEXT,
  adoption_fingerprint TEXT,
  adopted_revision_id INTEGER,

  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  error_code TEXT,
  error_message TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,

  PRIMARY KEY (batch_id, ordinal),
  FOREIGN KEY (batch_id)
    REFERENCES multi_chapter_batches(id)
    ON DELETE CASCADE,
  FOREIGN KEY (chapter_id)
    REFERENCES chapters(id)
    ON DELETE SET NULL,
  FOREIGN KEY (active_pipeline_task_id)
    REFERENCES pipeline_tasks(id)
    ON DELETE SET NULL
);
```

建议状态：

```ts
type MultiChapterBatchItemStatus =
  | 'pending'
  | 'creating_chapter'
  | 'chapter_ready'
  | 'creating_pipeline_task'
  | 'running_pipeline'
  | 'waiting_retry'
  | 'outcome_unknown'
  | 'blocked_context_budget'
  | 'blocked_account_quota'
  | 'blocked_batch_budget'
  | 'adopting'
  | 'succeeded'
  | 'succeeded_with_draft'
  | 'succeeded_with_user_text'
  | 'failed'
  | 'cancelled';
```

### 6.3 `multi_chapter_batch_item_runs`

用户更换模型或主动重新开始当前章时，不篡改旧 Pipeline Task，而是新增 run。

```sql
CREATE TABLE multi_chapter_batch_item_runs (
  batch_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  run_no INTEGER NOT NULL,

  pipeline_task_id TEXT NOT NULL,
  llm_config_snapshot_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,

  created_at INTEGER NOT NULL,
  completed_at INTEGER,

  PRIMARY KEY (batch_id, ordinal, run_no),
  UNIQUE (pipeline_task_id),

  FOREIGN KEY (batch_id, ordinal)
    REFERENCES multi_chapter_batch_items(batch_id, ordinal)
    ON DELETE CASCADE,
  FOREIGN KEY (pipeline_task_id)
    REFERENCES pipeline_tasks(id)
    ON DELETE CASCADE
);
```

### 6.4 `pipeline_stage_attempts`

这是通用 Pipeline 基础设施，普通单章和批次共用。

```sql
CREATE TABLE pipeline_stage_attempts (
  id TEXT PRIMARY KEY,
  pipeline_task_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,

  request_version INTEGER NOT NULL,
  request_fingerprint TEXT NOT NULL,
  allocation_trace_json TEXT,
  frozen_request_json TEXT,

  llm_config_id INTEGER,
  llm_config_snapshot_json TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  provider_request_id TEXT,

  status TEXT NOT NULL,
  failure_class TEXT,
  error_code TEXT,
  error_message TEXT,
  http_status INTEGER,
  retry_after_ms INTEGER,

  started_at INTEGER NOT NULL,
  last_progress_at INTEGER,
  deadline_at INTEGER,
  next_retry_at INTEGER,
  completed_at INTEGER,

  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,

  UNIQUE (pipeline_task_id, stage, attempt_no),
  FOREIGN KEY (pipeline_task_id)
    REFERENCES pipeline_tasks(id)
    ON DELETE CASCADE
);
```

Attempt 状态：

```ts
type PipelineAttemptStatus =
  | 'started'
  | 'succeeded'
  | 'safe_to_retry'
  | 'outcome_unknown'
  | 'blocked'
  | 'failed'
  | 'cancelled';
```

### 6.5 索引与备份

```sql
CREATE INDEX idx_multi_batches_project_status
ON multi_chapter_batches(project_id, status, updated_at);

CREATE INDEX idx_multi_items_status
ON multi_chapter_batch_items(batch_id, status, ordinal);

CREATE INDEX idx_multi_items_retry
ON multi_chapter_batch_items(status, next_retry_at);

CREATE INDEX idx_pipeline_stage_attempts_task_stage
ON pipeline_stage_attempts(pipeline_task_id, stage, attempt_no);

CREATE INDEX idx_pipeline_stage_attempts_retry
ON pipeline_stage_attempts(status, next_retry_at);
```

四张表必须加入：

```text
createCurrentSchema
schemaManifest
schemaValidator
backup manifest
restore order
migration fixtures
```

---

## 7. 批次章纲规划器

### 7.1 输入

```ts
interface CreateBatchChapterPlanInput {
  projectId: number;
  sourcePrompt: string;
  chapterCount: number;
  targetWordsPerChapter: number;
  pipelineMode: 'draft_only' | 'fast' | 'full';
  optionalInstruction?: string;
}
```

限制：

```text
chapterCount：1～10
sourcePrompt：不能为空
仅 outline 项目
项目和 LLM 配置必须可用
```

### 7.2 输出

```ts
interface BatchChapterPlanItem {
  ordinal: number;
  title: string;
  synopsis: string;
  keyBeats: string[];
  carryIn: string;
  carryOut: string;
  targetWords: number;
}
```

严格 JSON：

```json
{
  "chapters": [
    {
      "ordinal": 1,
      "title": "第一章标题",
      "synopsis": "本章梗概",
      "keyBeats": ["节拍1", "节拍2"],
      "carryIn": "从已有前文承接什么",
      "carryOut": "留给下一章什么",
      "targetWords": 3000
    }
  ]
}
```

### 7.3 本地验证

```text
chapters.length === N
ordinal 为 1..N 且无重复
title 非空
synopsis 非空
keyBeats 至少一个
targetWords 合法
JSON 可解析
```

结构错误时最多允许一次“仅修 JSON 结构”的修复请求。修复请求必须使用冻结原始输出，不重新读取项目资料。

### 7.4 用户确认

规划完成：

```text
planning → ready
```

用户可编辑标题、梗概、关键节拍、carryIn、carryOut 和目标字数。点击“开始批量写作”后冻结计划和 `planner_hash`。

---

## 8. 章纲如何进入现有单章 Pipeline

第一版优先复用 `Chapter` 字段：

```text
chapter.title = plan.title
chapter.synopsis = 结构化本章指令
chapter.content = ''
chapter.status = 'draft'
```

推荐 synopsis：

```text
【批次总目标】
<用户总剧情目标>

【本章目标】
<plan.synopsis>

【必须发生】
- <keyBeat 1>
- <keyBeat 2>

【承接前文】
<carryIn>

【交给下一章】
<carryOut>

【目标字数】
约 <targetWords> 字
```

用户长摘要不得被静默裁剪；若 Planner 的 mandatory 输入本身超出硬上限，应在调用模型前阻断。

---

## 9. 批次持久化状态机

建议目录：

```text
src/services/multiChapterBatch/
  types.ts
  determineNextBatchAction.ts
  reconcileMultiChapterBatch.ts
  planner.ts
  plannerCompiler.ts
  batchChapterInstruction.ts
  batchAdoption.ts
  retryPolicy.ts
  errors.ts
  index.ts
```

唯一入口：

```ts
reconcileMultiChapterBatch(batchId)
```

纯动作类型：

```ts
type MultiChapterBatchAction =
  | { type: 'plan_batch' }
  | { type: 'wait_for_plan_confirmation' }
  | { type: 'create_chapter'; ordinal: number }
  | { type: 'create_pipeline_task'; ordinal: number }
  | { type: 'run_pipeline'; ordinal: number }
  | { type: 'resume_pipeline'; ordinal: number }
  | { type: 'wait_until'; timestamp: number }
  | { type: 'pause_unknown_outcome'; ordinal: number }
  | { type: 'pause_account_quota'; ordinal: number }
  | { type: 'pause_context_budget'; ordinal: number }
  | { type: 'pause_batch_budget'; ordinal: number }
  | { type: 'adopt_full_result'; ordinal: number }
  | { type: 'adopt_draft_result'; ordinal: number }
  | { type: 'verify_adoption'; ordinal: number }
  | { type: 'advance'; ordinal: number }
  | { type: 'complete_batch' }
  | { type: 'no_op'; reason: string };
```

### 9.1 持久化 lease

不能只使用进程内 Set。使用 `lease_owner / lease_expires_at / row_version` 进行 CAS。数据库异常必须 fail-closed。

### 9.2 章节创建原子化

实现：

```ts
createBatchChapterForItem(batchId, ordinal)
```

同一事务：

```text
确认 item.chapter_id IS NULL
→ 读取项目当前末尾
→ 检查尾部漂移
→ INSERT chapter
→ UPDATE item.chapter_id/status
→ COMMIT
```

### 9.3 Pipeline Task 创建原子关联

新增：

```ts
createPipelineTaskForBatchItem({
  batchId,
  ordinal,
  chapterId,
  task,
  stages,
  configSnapshot,
})
```

同一事务：

```text
INSERT pipeline_tasks
INSERT 四条 checkpoints
INSERT batch_item_run
UPDATE item.active_pipeline_task_id/status
COMMIT
```

### 9.4 推进条件

只有满足：

```text
正文已落库
revision 已创建
adoption fingerprint 已保存
item.status 为 succeeded*
```

才能推进 `current_ordinal`。

---

## 10. 自动采用 Pipeline 结果

不要复制结果页中的接受逻辑。若采用逻辑仍在 Screen 内，应先抽取：

```ts
adoptPipelineTaskResult({
  taskId,
  chapterId,
  source: 'manual' | 'multi_chapter_batch',
})
```

该服务必须覆盖：

```text
chapter.content
chapter.updated_at
content revision
旧正文修订
Pipeline Task resolved 状态
Story Memory 更新或待更新标记
上下文失效标记
Store 刷新
```

采用幂等指纹：

```text
hash(batchId + ordinal + chapterId + pipelineTaskId + finalTextHash)
```

完成质量：

```ts
type BatchItemCompletionQuality =
  | 'full_pipeline'
  | 'draft_only'
  | 'user_supplied';
```

`draft_only` 只能由用户明确选择。

---

## 11. 超时、额度与结果未知

扩展 LLM 错误元数据：

```ts
interface LLMFailureMetadata {
  failureClass:
    | 'safe_retry'
    | 'outcome_unknown'
    | 'rate_limit'
    | 'account_quota'
    | 'config_error'
    | 'context_error'
    | 'content_filter'
    | 'fatal';

  httpStatus?: number;
  providerCode?: string;
  retryAfterMs?: number;
  providerRequestId?: string;
  requestMayHaveExecuted: boolean;
}
```

建议分类：

### 安全自动重试

```text
HTTP 429 / Retry-After
明确 rate_limit
HTTP 502 / 503 / 504
队列失败且请求尚未开始
```

### 结果未知

```text
请求发出后的 total_timeout
请求发出后的 network_error
收到部分响应后中断
无法确认服务端是否已执行
```

### 账户阻断

```text
insufficient_quota
billing_limit
balance_not_enough
credit_exhausted
```

### 配置阻断

```text
模型不存在
API Key 无效
URL 错误
不支持的参数且无法兼容降级
```

`outcome_unknown` 不得自动立即重试。用户必须看到“重新请求可能重复计费”的提示。

---

## 12. 持久化重试

禁止仅使用：

```ts
await sleep(60000)
```

必须保存：

```text
retry_count
next_retry_at
failure_class
attempt status
request fingerprint
```

建议退避：

```text
第1次：30秒
第2次：2分钟
第3次：5分钟
```

加 10%～20% jitter；供应商有 `Retry-After` 时优先使用。

自动重试默认最多 3 次。冷启动后重新读取批次、item、Pipeline Task、checkpoint 和 Attempt，再由状态机决定下一动作。

---

## 13. 冻结请求与重试版本

普通网络重试必须保持：

```text
messages 不变
allocation trace 不变
request fingerprint 不变
模型配置不变
maxTokens 不变
temperature/top_p 不变
```

以下情况才产生新的 `requestVersion`：

```text
用户更换模型
用户修改当前章章纲
用户修改目标字数
用户明确点击“重新编译上下文”
原请求在模型调用前被本地预算阻断
```

新版本保留旧 Attempt，不覆盖历史。

---

## 14. 批次消耗预算

必须区分三类预算：

```text
上下文窗口预算
供应商账户额度
用户设置的批次总消耗上限
```

用户可选设置：

```text
最大 LLM 调用次数
最大输入 tokens
最大输出 tokens
```

启动前显示估算：

```text
计划章节：8
预计调用：25～33 次
预计输入：约 180K tokens
预计输出：约 48K tokens
```

每章开始前重新检查剩余硬上限。达到上限时进入 `paused_batch_budget`，提供增加预算、减少剩余章数、降低后续字数或结束批次。

---

## 15. 弹性预算池目标

所有 Pipeline 阶段统一采用：

```text
Mandatory 保真
80% Soft Limit
跨模块回收
高价值模块突破
95% 高风险水位
最终硬上限
不可借用 Safety Margin
```

该能力同时服务：

```text
普通单章 Pipeline
批量 N 章 Pipeline
Draft
Review
Fact Check
Proof
Repair
批次 Planner
```

不得为批量模式另写预算器。

---

## 16. 容量定义

设：

```text
W = 模型 context_window
O = 输出预留
H = 当前不可借用 safety margin
C = W - O - H
```

定义：

```text
SoftInputLimit  = floor(C × 0.80)
BurstInputLimit = floor(C × 0.95)
HardInputLimit  = C
```

水位语义：

```text
0%～80%：正常区
80%～95%：高价值模块弹性突破区
95%～100%：mandatory 或最终包装估算偏差区
H：始终不可借用
```

当前 `deriveDefaultSafetyMargin()` 可先保留为 H，避免同时修改过多变量。

---

## 17. Mandatory 与弹性模块

### Mandatory

永不因弹性分配被裁剪：

```text
System Prompt
协议和输出格式
Repair 指令
完整项目大纲
当前章必需章纲
当前阶段正文
必要 Review 报告
必要 Fact Check 报告
用户显式标记的少量必用资料
```

Mandatory 超过 `HardInputLimit` 时直接 Blocked，LLM 调用次数为 0。

### 弹性模块

```text
Story Memory
Episodic Memory
近期章节衔接
角色卡
世界书
笔记
Preset
风格资料
批次总目标补充
用户补充说明
检索提示
```

需求模型：

```ts
interface ElasticContextDemand {
  id: string;
  availableTokens: number;

  minTokens: number;
  targetTokens: number;
  maxTokens: number;

  priority: number;
  relevance: number;

  requirement: 'mandatory' | 'preferred' | 'optional';
  reclaimable: boolean;
  shrinkPriority: number;
  burstPriority: number;
}
```

必须满足：

```text
0 ≤ allocated ≤ availableTokens
allocated ≤ maxTokens
availableTokens=0 → allocated=0
```

---

## 18. 80% 软预算算法

### 18.1 软池

```ts
softOptionalPool = Math.max(
  0,
  SoftInputLimit - mandatoryInputTokens,
);
```

### 18.2 突发池

```ts
burstPool = Math.max(
  0,
  HardInputLimit
    - Math.max(SoftInputLimit, mandatoryInputTokens),
);
```

Mandatory 已超过 80% 时，optional 自然从弹性区开始竞争，但仍不能突破硬上限。

### 18.3 第一轮：最低额度

只给有实际内容的模块分配 `minTokens`。若最低需求超出软池：

```text
mandatory demand 优先
preferred 按阶段优先级
optional 可降为 0
```

### 18.4 第二轮：目标额度

剩余软池按综合分数分配：

```ts
score =
  priority
  * relevance
  * Math.log1p(targetTokens - allocatedTokens);
```

正式实现应使用确定性整数算法，避免浮点细微差异影响测试。

### 18.5 第三轮：回收

出现以下情况时立即回收：

```text
模块实际内容少于 allocation
模块为空
模块未启用
检索相关性低于阈值
```

### 18.6 第四轮：软池内重新分配

回收额度优先给未达到 target、相关度高、阶段优先级高的模块。

### 18.7 第五轮：申请突发预算

只有满足以下条件才允许突破 80%：

```text
软池没有可回收空间
模块仍有真实缺口
requirement 为 mandatory 或高相关 preferred
相关度达到阈值
最终消息低于 BurstInputLimit
```

普通 optional 默认不能借用突发池。

### 18.8 自动使用上限

建议正常自动调配最多使用突发池的 75%，剩余 25% 用于标签、换行、role wrapper、`response_format` 和 tokenizer 估算误差。

### 18.9 最终组装

```text
分配
→ 按 allocation 裁剪 optional 原始字段
→ 构建 messages
→ 估算最终输入
```

超过 95% 时按 `shrinkPriority` 回收 optional 并重建；超过硬上限则 Blocked。禁止裁剪整条 system/user message。

---

## 19. 阶段优先级

### Draft

```text
近期章节衔接
Story Memory
批次当前目标
高相关角色
高相关世界书
Episodic
笔记
Preset
```

### Review

Mandatory：完整 Draft、完整大纲、Review 协议。

弹性优先：

```text
关键角色状态
关键世界规则
Story Memory
近期章节
Episodic
笔记
```

### Fact Check

Mandatory：完整 Draft、Fact Check 协议。

弹性优先：

```text
角色事实
世界规则
时间线
Story Memory
近期章节
笔记
风格资料
```

### Proof

Mandatory：完整 Draft、必要 Review 报告、必要 Fact Check 报告、Proof 协议。

Proof 默认不主动吃满突发池，只引入少量高相关设定。

### Planner

Mandatory：用户总剧情摘要、N、输出结构协议。

弹性：完整项目大纲、最近章节摘要、关键角色、关键世界规则、Story Memory。

---

## 20. 统一预算编译器接口

```ts
compileStageRequestWithElasticBudget({
  stage,
  contextWindow,
  reservedOutputTokens,
  safetyMargin,
  mandatorySections,
  elasticDemands,
  buildMessages,
}): ReadyStageRequest | BlockedStageRequest
```

预算轨迹：

```ts
interface ElasticBudgetTrace {
  contextWindow: number;
  reservedOutputTokens: number;
  safetyMargin: number;

  hardInputLimit: number;
  softInputLimit: number;
  burstInputLimit: number;

  mandatoryTokens: number;
  softPoolTotal: number;
  softPoolUsed: number;
  burstPoolTotal: number;
  burstPoolUsed: number;

  finalEstimatedInputTokens: number;
  utilizationRatio: number;
  riskLevel: 'normal' | 'elevated' | 'high';

  modules: Array<{
    id: string;
    availableTokens: number;
    minTokens: number;
    targetTokens: number;
    maxTokens: number;
    initialSoftAllocation: number;
    reclaimedTokens: number;
    redistributedTokens: number;
    burstBorrowedTokens: number;
    finalAllocatedTokens: number;
    priority: number;
    relevance: number;
    requirement: string;
    reason: string;
  }>;
}
```

---

## 21. 当前预算代码改造

重点：

```text
src/services/pipeline/budgetAllocator.ts
src/services/pipeline/compileStageRequest.ts
src/services/draftPipelineCompiler.ts
src/services/outlineContextBuilder.ts
src/types/pipelineFrozen.ts
src/types/pipelineContext.ts
```

第一阶段可保留旧 `allocateStageContextBudget()` 作为兼容包装，内部转调新 `allocateElasticStageContextBudget()`；所有调用点迁移后再删除旧权重接口。

扩展 `ContextAllocationTrace`：

```text
id
available
min
target
max
softAllocated
reclaimed
redistributed
burstBorrowed
allocated
truncated
requirement
priority
relevance
reason
```

Frozen Draft 必须保存最终 messages、完整 trace、requestVersion、requestFingerprint、三条水位和模型配置快照。

---

## 22. 上下文不足的自动处理顺序

```text
1. 释放空模块
2. 释放实际内容不足模块
3. 回收 target 以上额度
4. 回收低相关 optional
5. 在 80%软池内重新调配
6. 高价值 preferred 借用弹性池
7. 回收低优先级模块到 min
8. 重建 messages
9. 最终窗口检查
10. mandatory 仍不适配才 Blocked
```

禁止自动：

```text
裁剪完整大纲
裁剪必需正文
降低输出预留到不安全值
临时增加摘要 LLM 调用
删除用户显式必用资料
```

---

## 23. 预算阻断后的用户操作

`blocked_context_budget` 时应明确说明模型尚未调用。

操作：

```text
重新使用弹性预算编译
更换更大上下文模型
降低本章目标字数
编辑本章章纲
减少显式必用资料
采用已有 Draft
结束批次
```

只有 mandatory 无法适配才打断用户；普通 optional 不足必须自动调配。

---

## 24. 更换模型

### 同配置充值或服务恢复

复用原冻结请求和原 Pipeline Task，从当前阶段继续。

### 更换模型、URL、context window 或输出预算

```text
旧 task 保留
→ 新增 batch item run
→ 创建新 Pipeline Task
→ requestVersion + 1
→ 重新编译当前章
```

第一版建议更换模型后从当前章 Draft 重新开始；后续再支持复用旧 Draft 进入审核阶段。

---

## 25. 项目变化和章节尾部漂移

### 修改已完成正文

下一章上下文在执行时重新构建，可读取最新正文；记录前文章节指纹变化即可。

### 项目末尾发生插入或重排

进入：

```text
paused_project_changed
```

用户选择：继续追加到当前最新章节之后，或停止批次。不得静默覆盖错误 position。

### 删除批次已生成章节

暂停并要求用户处理，不得自动重新创建。

---

## 26. 前台服务和请求队列

批次单章使用：

```ts
{
  queueClass: 'pipeline',
  queuePriority: 'background',
}
```

手动单章保持 `manual`，排队优先；已开始的请求不强制抢占。

建议批次拥有一个整体前台通知：

```text
正在生成第 3 / 8 章
当前阶段：事实核查
```

可给 `runChapterPipeline` 增加纯显示选项：

```ts
foregroundOwner?: 'task' | 'batch'
```

子 Pipeline 抑制全局完成提示，批次结束只提示一次。

---

## 27. UI

### 入口

只在 outline 项目显示“批量写章”，放在章节列表页或项目工具菜单，不放进单章编辑器工具栏。

### 创建页

```text
剧情摘要
生成章数
每章目标字数
Pipeline 模式
最大调用次数（可选）
最大输入 tokens（可选）
最大输出 tokens（可选）
```

显示预计调用和 token 消耗。

### 规划预览页

每章可编辑标题、梗概、关键节拍、承接、交接点和目标字数。

### 运行页

```text
批次：3 / 8
当前章：第三章 夜探禁地
阶段：Review
尝试：2 / 3
上下文使用率：87%
弹性预算：700 / 2,000
```

操作：暂停、取消、查看当前章节、查看当前 Pipeline、查看预算调配。

### 暂停页

按 `outcome_unknown`、quota、context budget、batch budget、project changed 显示不同操作。

### 完成页

```text
成功：8
完整流水线：7
采用 Draft：1
总调用：29
输入 tokens：...
输出 tokens：...
```

---

## 28. Store

新增：

```text
src/store/multiChapterBatchStore.ts
```

职责：加载批次、创建规划草案、保存编辑计划、启动/暂停/恢复/取消、订阅数据库状态、暴露 UI loading/error。

禁止把批次状态塞入 `pipelineTaskStore`。后者只增加“注册已原子持久化任务”和“批次子任务提示抑制”等必要能力。

---

## 29. 错误码

```ts
type MultiChapterBatchErrorCode =
  | 'BATCH_NOT_FOUND'
  | 'BATCH_ALREADY_RUNNING'
  | 'BATCH_LEASE_CONFLICT'
  | 'BATCH_PLAN_INVALID'
  | 'BATCH_PLAN_COUNT_MISMATCH'
  | 'BATCH_PROJECT_NOT_OUTLINE'
  | 'BATCH_PROJECT_CHANGED'
  | 'BATCH_CHAPTER_CREATE_FAILED'
  | 'BATCH_PIPELINE_TASK_CREATE_FAILED'
  | 'BATCH_PIPELINE_FAILED'
  | 'BATCH_ADOPTION_FAILED'
  | 'BATCH_ADOPTION_MISMATCH'
  | 'BATCH_CONTEXT_BUDGET_BLOCKED'
  | 'BATCH_ACCOUNT_QUOTA_BLOCKED'
  | 'BATCH_SPEND_BUDGET_BLOCKED'
  | 'BATCH_LLM_OUTCOME_UNKNOWN'
  | 'BATCH_RETRY_EXHAUSTED'
  | 'BATCH_CANCELLED';
```

禁止依赖中文错误文案正则。

---

## 30. 分步施工计划

### Phase 0：基线保护

1. 记录 Git、版本、Schema 和测试数量；
2. 运行现有 Pipeline、迁移、召回、备份测试；
3. 增加 feature flags：

```text
multi_chapter_batch_enabled=false
elastic_budget_v2_enabled=false
```

4. 锁定单章行为。

### Phase 1：弹性预算纯函数

1. `ElasticContextDemand`；
2. `ElasticBudgetTrace`；
3. 80/95/100 水位；
4. min/target/max；
5. 回收；
6. 重新分配；
7. burst；
8. optional shrink；
9. 守恒和确定性测试。

暂不接生产调用。

### Phase 2：接入单章 Pipeline

顺序建议：

```text
Review → Fact Check → Proof → Repair → Draft
```

保留 feature flag 回退。更新 Frozen Draft、Preview 和 `ReadyStageRequest` 诊断。

### Phase 3：通用 Attempt 与错误分类

1. Schema 41 Attempt 表；
2. 扩展 `LLMRequestError`；
3. HTTP status/provider code/Retry-After；
4. request fingerprint；
5. provider request id；
6. safe_retry/outcome_unknown/quota/config；
7. 持久化 `next_retry_at`；
8. 现有 Pipeline Stage 接入 Attempt。

### Phase 4：批次 Schema 与 Repository

1. 三张批次表；
2. manifest/backup；
3. Repository；
4. lease CAS；
5. 章节原子创建；
6. Task 原子关联；
7. 统计更新；
8. 迁移和回滚测试。

### Phase 5：Planner

1. Planner compiler；
2. 弹性预算；
3. 严格 JSON；
4. 本地验证；
5. 一次结构修复；
6. 冻结 request；
7. editable plan；
8. 规划 UI。

### Phase 6：批次状态机

1. 纯决策函数；
2. reconcile；
3. 串行推进；
4. 冷启动恢复；
5. pause/resume/cancel；
6. waiting_retry；
7. outcome_unknown；
8. batch budget；
9. project drift。

### Phase 7：自动采用和衔接

1. 抽取/复用采用服务；
2. 幂等 adoption；
3. revision；
4. Story Memory/失效副作用；
5. fingerprint；
6. 下一章读取前章验证；
7. Draft-only 用户降级。

### Phase 8：运行 UI 与前台服务

1. 运行页；
2. 单一通知；
3. 子任务提示抑制；
4. 原因化暂停；
5. 预算轨迹；
6. 批次报告；
7. Task Center 分组。

### Phase 9：故障矩阵与实机

SQLite 故障、断网、429、quota、timeout、杀进程、锁屏、通知权限、模型切换、覆盖安装和 release APK。

---

## 31. 测试矩阵

### 31.1 弹性预算

1. **正常低使用率**：最终输入低于 80%。
2. **空笔记释放预算**：预算重新分给近期章节或 Story Memory。
3. **角色卡实际内容不足**：差额被回收。
4. **高相关世界书借用 burst**：最终位于 80%～95%。
5. **普通 optional 禁止借用 burst**。
6. **Mandatory 超过 80%但低于硬上限**：可运行，风险 elevated/high。
7. **Mandatory 超过硬上限**：Blocked，LLM 调用为 0。
8. **标签开销超出 95%**：只收缩 optional 并重建消息。
9. **Safety Margin 不可借用**。
10. **确定性**：相同输入多次分配结果相同。
11. **重试冻结**：allocation 和 request fingerprint 不变。
12. **相关度变化**：只影响当前请求。
13. **所有 allocation 守恒**：总和不超过硬容量。
14. **完整大纲、正文和协议逐字存在**。

### 31.2 Planner

```text
N=1
N=10
长摘要
JSON 缺章
ordinal 重复
空标题
结构修复成功
结构修复失败
Planner timeout
Planner quota
Planner 上下文硬阻断
```

### 31.3 批次状态机

```text
创建批次
规划未确认
创建第一章
创建 Pipeline Task
Pipeline 完成
自动采用
推进下一章
完成批次
```

### 31.4 崩溃点

```text
章节 INSERT 前
章节 INSERT 后/item 更新前
Task INSERT 后/checkpoint 前
Task commit 后/item 关联前
Draft 成功后
Pipeline completed 后
正文保存后/revision 前
revision 后/item success 前
最后一章后/batch complete 前
```

每个崩溃点都必须验证恢复后不重复章节、不重复 Task、不重复正文和 revision。

### 31.5 重试

```text
429 + Retry-After
503
connect timeout
total timeout
network error
outcome unknown
自动重试 3 次
重试耗尽
冷启动等待重试
供应商无 request id
供应商有 request id
```

### 31.6 额度

```text
账户额度不足
充值后继续
更换模型
批次最大调用数
批次输入 token 上限
批次输出 token 上限
```

### 31.7 自动采用

```text
完整结果采用
重复 reconcile
Draft-only
用户手写正文继续
revision 创建
Store 刷新
下一章读取前章
采用中数据库失败
```

### 31.8 并发

```text
两个 reconcile 同时启动
lease 过期
同项目两个活动批次
手动 Pipeline 排队优先
运行中用户新建章节
运行中用户删除章节
```

### 31.9 数据库和备份

```text
Schema 40→41
fresh Schema 41
批次表备份/恢复
旧备份缺批次表
外键检查
删除项目级联
恢复后等待重试状态不丢失
```

### 31.10 Android 实机

```text
前台连续生成 10 章
切后台后继续
锁屏后继续
关闭通知权限
杀进程后重启
网络切换
低内存事件
应用升级覆盖安装
```

---

## 32. 性能和资源限制

第一版限制：

```text
N ≤ 10
```

禁止一次加载：

```text
N 章完整正文
所有冻结 Pipeline 请求
所有 LLM 原始响应
所有 Attempt 详情
```

运行页只加载批次摘要和当前 item；Attempt 历史分页读取。

批次表主要是元数据，备份继续沿用现有流式 checksum，避免重新出现大 JSON 多份内存副本。

---

## 33. 安全和隐私

日志不得记录：

```text
API Key
完整角色卡正文
完整世界书正文
完整章节正文
用户长摘要全文
```

可记录：

```text
hash
token 数
错误码
模型配置 ID
provider request ID
状态时间
预算水位
```

冻结请求属于本地业务数据，必须进入备份和敏感数据保护范围。

---

## 34. 禁止事项

```text
恢复旧 batchChapterPipeline
内存 for 循环作为状态真相
并行运行 N 章
一次创建 N 个 Pipeline Task
在单章 Pipeline 内增加大量 batch 特殊分支
直接 UPDATE chapters 绕过采用服务
自动定稿
失败后自动跳过
timeout 后盲目重发
sleep 作为唯一重试机制
Retry 时重新编译上下文
20%弹性池在初始分配阶段全部用尽
借用 Hard Safety Margin
裁剪 Mandatory
裁剪完整 system/user message
关闭外键
用 UI 空态吞数据库错误
```

---

## 35. 发布策略

建议分两个内部里程碑。

### Milestone A：弹性预算与通用 Attempt

```text
Schema 41 可先包含 Attempt 表
批次 UI feature flag 关闭
验证普通单章 Pipeline
```

### Milestone B：批量写 N 章

```text
打开批次 feature flag
最多 10 章
先测试版/灰度
```

正式版前验证：

```text
版本号/versionCode
Schema 41
完整 verify
Android debug/release
签名
zipalign
覆盖安装
冷启动恢复
后台运行
10 章长批次
```

---

## 36. 完成定义

### 弹性预算完成

- 所有 Pipeline 阶段走唯一弹性预算器；
- 正常模块以 80% 为软上限；
- 空余预算可跨模块回收；
- 高价值模块可进入 80%～95% 区间；
- 95%～100% 只用于 Mandatory 或包装误差；
- Hard Safety Margin 永不借用；
- Mandatory 永不裁剪；
- 最终超窗只缩 Optional；
- Allocation Trace 可持久化；
- Retry 复用冻结 Trace；
- Blocked 时不调用模型。

### 批量 N 章完成

- 大纲创作模式独立入口；
- 用户可规划和编辑 N 章；
- 最多 10 章；
- 严格串行；
- 一次只创建当前 Pipeline Task；
- 每章复用现有单章 Pipeline；
- 前章正文落库后才开始后章；
- 自动保存为 draft 并创建 revision；
- 中断可恢复；
- 超时可分类；
- Quota 恢复后可继续；
- Outcome Unknown 不盲目重试；
- 批次预算可暂停；
- 更换模型保留旧历史；
- 取消不删除已完成章节；
- 完成后提供质量和消耗报告；
- Schema、备份和恢复完整。

---

## 37. Agent 最终报告模板

### Git

```text
起始分支
起始 HEAD
结束 HEAD
开工前/后 git status
```

### 基线

```text
版本
Schema
测试数量
Pipeline 基线
```

### 弹性预算

```text
80% Soft
95% Burst
Hard Safety
模块回收
模块借用
Trace
各阶段接入
```

### LLM Attempt

```text
错误分类
重试策略
Outcome Unknown
Quota
Retry-After
冻结请求复用
```

### 批次

```text
Schema 41
批次表
Planner
状态机
Lease
章节原子创建
Task 原子关联
自动采用
恢复
UI
```

### 测试

```text
预算纯函数
Pipeline 回归
Planner
状态机决策表
SQLite 崩溃点
重试/额度
采用
备份恢复
完整 Jest
TypeScript
Lint
Android debug
Android release
实机 10 章
```

### 发布

```text
版本
versionCode
APK
签名
是否推送
提交 SHA
```

---

## 38. 最终建设结论

正确落地方式不是重新加入一个“AI 写 N 章”的循环，而是建设两个可长期复用的能力：

```text
一、所有写作模块共享的弹性上下文预算编译器
二、基于 SQLite 持久化状态机的多章批次编排器
```

单章 Pipeline 保持唯一事实来源；批次只负责编排。

任何时候都必须保持：

```text
当前章形成可用正文
+ 正文已落库
+ 修订已创建
+ 条目已成功
→ 才能开始下一章
```

预算必须保持：

```text
正常只使用 80% 输入容量
→ 回收空闲模块
→ 高价值模块有条件借用弹性池
→ 95%以上保持保守
→ Hard Safety 永不借用
```

该方案能够同时实现：

- 多章自动衔接；
- 低频人工干预；
- 超时后可靠恢复；
- 额度恢复后继续；
- 上下文利用率提高；
- 请求失败率降低；
- 不破坏现有单章 Pipeline。
