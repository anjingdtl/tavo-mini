# TAVO-MINI 原著分析第二阶段修复实施方案（远端升级适配修订版）

> 本地项目目录：`D:\AiWorkSpace\tavo-mini`  
> 建议放置路径：`docs/optimization/tavo-mini-canon-analysis-round2-fix-plan.md`  
> 远端比对基线：`anjingdtl/tavo-mini` 默认分支，HEAD `62f4db9cd7e59dbaa41e36f61b850d1477b89c88`  
> 原 Canon 审查基线：`a3711c6527b3930009beb618aa281ff1dd27bd90`  
> 目标：在“30%正文切块 / 最后10章精读 / 五维硬验收”基础上，修复动态补尾、定向补扫、证据物化、唯一索引、事务一致性与历史迁移问题，并与最新续写 V4 调度、取消和恢复基础设施兼容。

---

## 1. 背景

第一阶段改造已经完成以下核心方向：

- 完整分析覆盖全部导入 TXT；
- 快速续写分析覆盖最后 10 章；
- 两种模式独立运行、独立验收；
- 正常正文切块目标为模型 `context_window` 的 30%；
- 不降低模型 `max_output_tokens`；
- 不关闭推理模型思考能力；
- 两路请求并行：
  - `character_state`
  - `world_plot`
- 五维资料最终要求每维至少 3 条有效信息；
- 五维验收按当前运行、当前快照、有效 evidence 和数据库回读结果计算；
- AI 续写统一读取当前激活的原著分析产物，不区分分析模式。

第二轮代码审查发现：当前实现仍存在会导致长篇分析失败、正文尾部未真正处理、定向补扫无效、证据被误删、数据库唯一约束冲突以及历史迁移损坏证据关系的问题。

本方案用于完成第二阶段修复。

---


## 1.1 远端升级比对结论

本方案已经按远端默认分支最新提交重新核对。

从原 Canon 审查基线 `a3711c` 到远端最新 `62f4db9` 共新增 3 次提交，主要涉及：

- 续写 V4 创作与 Repair 规则调整；
- 未采纳续写结果找回；
- 停止、取消和迟到响应稳定性；
- Writer、Checker、Control、Repair 工程修复；
- 请求调度器和 pipeline runner 的取消行为；
- 文档目录清理与重组。

远端这 3 次提交没有修改以下 Canon 核心模块：

- Canon 分析服务；
- Canon 30%预算策略；
- 自适应批次规划器；
- 五维硬验收；
- evidence 服务；
- Schema 33 Canon 去重迁移；
- 原著分析范围规划。

因此，上一轮确认的 P0/P1 Canon 缺陷仍然成立，不能因为续写 V4 已升级而删除本方案中的核心修复项。

远端当前数据库版本仍为：

```text
SCHEMA_VERSION = 33
```

如果本地仓与远端一致，本轮迁移版本应为 Schema 34。  
如果 `D:\AiWorkSpace\tavo-mini` 已存在尚未推送的其他 Schema 升级，则禁止硬编码 34，必须使用：

```text
本地当前 SCHEMA_VERSION + 1
```

文档后文中的“下一 Schema 版本”均按此规则解释。

远端已删除旧的：

```text
docs/tavo-mini-original-analysis-implementation-plan.md
```

因此，本修订版必须自包含，Agent 不得依赖已经从远端删除的旧方案文档。

---

## 1.2 本地仓开工前强制预检

由于本地仓可能包含未推送升级，Agent 开工前必须在：

```text
D:\AiWorkSpace\tavo-mini
```

执行并记录：

```powershell
git status --short
git branch --show-current
git rev-parse HEAD
git log --oneline -10
git remote -v
git fetch origin
git rev-parse origin/main
git diff --stat origin/main...HEAD
```

约束：

1. 不得执行 `git reset --hard`；
2. 不得清理或覆盖用户未提交修改；
3. 不得假设本地 HEAD 等于远端 HEAD；
4. 若本地已修复本方案中的某项，必须先运行对应失败测试确认，再从实施列表中标记为“已解决”；
5. 若本地 Schema 高于 33，迁移编号、fixture 和 manifest 更新必须顺延；
6. 若本地分支包含续写 V4 改动，Canon 修复不得回滚或覆盖这些升级；
7. 最终报告必须同时写明：
   - 开工时本地 HEAD；
   - 对比的远端 HEAD；
   - 本地相对远端的 ahead/behind 状态；
   - 未触碰的用户已有改动。

---

## 2. 总体目标

改造完成后，原著分析必须满足以下系统级保证：

1. 任意章节正文均不会因为缩块重试而静默丢失；
2. 动态创建的补尾子批次可以立即执行，也可以在应用重启后恢复；
3. 正常分析、缩块重试和定向补扫都使用统一的“总输入预算切片器”；
4. 30%、20%、12%、15%均表示单次请求全部原著正文的总预算，而不是每章单独上限；
5. 五类业务事实可以跨批次、跨补扫安全 upsert；
6. upsert 后证据永远链接到真实业务行 ID；
7. 所有五维 evidence 均经过相同的原文回读校验；
8. 定向补扫不会误删正常批次或其他维度的证据；
9. 一次物化要么全部提交，要么全部回滚；
10. Schema 迁移不得删除有效证据关系；
11. 只要仍存在未完成、partial、queued 或 running 的批次，运行就不得进入最终验收和激活；
12. 五维验收通过后，数据库、coverage、capabilities、五维页面与 AI 续写读取结果必须一致。

---

## 3. 非目标

本轮不进行以下改造：

- 不改变完整分析与快速续写分析的产品定义；
- 不改变快速分析“最后10章精读”的范围；
- 不修改五维每维至少 3 条的硬验收标准；
- 不降低 Schema 或 evidence 标准；
- 不通过复制事实、伪造事实或放宽去重来凑够最低数量；
- 不改变 AI 续写的统一读取契约；
- 不关闭模型思考模式；
- 不降低模型配置中的最大输出能力；
- 不进行与 Canon 分析无关的大规模架构重构。

---


# 最新基础设施适配要求

## A. Canon 请求调度必须保留独立队列

远端最新请求调度器已经定义：

```text
canon_analysis 并发上限 = 2
continuation_style_analysis 并发上限 = 1
```

本轮不得修改为五路或无限并发。

所有正常批次、动态补尾子批次和定向补扫请求必须继续使用：

```ts
queueClass: 'canon_analysis'
taskId: runId
externalSignal: 当前 Canon 运行的 AbortSignal
```

要求：

- 动态子批次不得绕过 `requestScheduler` 直接调用 provider；
- 同一批次两路可并行，但全局 Canon 同时在途请求不得超过 2；
- style analysis 必须继续使用独立的 `continuation_style_analysis` 队列；
- style analysis 只能在 Canon 五维 Gate 通过后开始；
- 低内存状态下新增子批次应保持 queued，不得丢失；
- 队列中的子批次必须可被暂停和取消。

## B. 续写 V4 的“四次物理请求上限”不适用于 Canon

最新续写 V4 对单次续写工作流设置了物理请求数量约束。该约束只属于：

```text
Writer / Checker / Control / Repair
```

不得被抽取到 Canon 分析公共层。

Canon 的产品目标明确是：

```text
通过更多次 API 调用换取原著分析质量
```

因此：

- 正常批次数量按原著范围和30%正文预算决定；
- 缩块重试可以产生20%和12%子批次；
- 五维不足可产生15%定向补扫；
- 不得复用 V4 的 maxPhysicalRequests、四次调用计数器或 Repair completeness policy；
- 只受队列并发、显式重试次数和定向补扫轮数约束，不受总调用次数硬上限约束。

## C. 取消、暂停和迟到响应必须采用最新安全模式

最新 pipeline 升级强化了“先持久化取消终态，再中止网络”和“迟到响应不得推进状态”。

Canon 必须实现同等保证：

1. 用户暂停或取消时，先将运行、批次和 work item 状态持久化；
2. 再 abort 当前 provider 请求和队列中尚未启动的请求；
3. LLM 调用返回后必须再次检查 `signal.aborted`；
4. evidence 验证前检查；
5. 打开物化事务前检查；
6. 事务提交前检查；
7. 已取消运行的迟到响应不得：
   - 保存 result_json；
   - 创建子批次；
   - 物化事实；
   - 更新 coverage；
   - 启动 style analysis；
   - 激活快照。
8. 恢复运行只能处理数据库中明确可恢复的 queued/partial/failed 项；
9. 不得仅依赖进程内 `Map` 判断所有权或完成状态。

## D. 动态子批次必须绑定输入工件

最新续写 V4 已强化 artifact hash 绑定。Canon 动态子批次也应采用确定性输入绑定。

每个 batch/work item 的 `input_hash` 至少包含：

```text
source_id
source_version
source_sha256
parser_version
normalization_version
boundary_char_offset_exclusive
analysis mode / scope
material_type
chapter_id
source_char_start
source_char_end
chunk ratio
prompt/extraction version
正文片段 hash
```

物化前必须确认：

- 当前 run 的 source fingerprint 未变化；
- result 对应当前 work item input_hash；
- 字符范围与持久化 batch segment 一致；
- 旧 checkpoint 或旧 result_json 不能应用到新的 segment；
- 子批次恢复时必须重新校验 input_hash。

## E. Schema、fresh install、backup 和 restore 必须同步

远端 `schemaManifest` 将以下 Canon 运行表列入备份：

```text
continuation_analysis_runs
continuation_analysis_batches
continuation_analysis_work_items
canon_evidence
canon_evidence_links
五类 Canon 事实表
```

因此，新增批次字段或索引时必须同步修改：

- 下一版本 migration；
- `createCurrentSchema`；
- `schemaManifest` columns；
- `schemaManifest` indexes；
- migration registry；
- migration fixtures；
- fresh-install schema 测试；
- backup/restore round-trip 测试；
- 旧数据库恢复测试。

不能只修改 migration 而遗漏 fresh install，也不能只修改表结构而遗漏 manifest。

## F. 保留最新续写结果找回和停止逻辑

本轮 Canon 改造不得破坏：

- 未采纳续写 pending review 结果找回；
- Chapter Editor 与 Continuation Workspace 的恢复入口；
- V4 Writer/Checker/Control/Repair状态；
- pipeline foreground 停止；
- pipeline task cancellation；
- 续写结果页现有展示；
- 当前请求调度优先级。

新增回归测试应证明 Canon 长任务、暂停、恢复和失败不会影响续写 pending review 工作流。

## G. 文档与目录约定

远端已对 docs 进行清理和重组。建议将本方案存放为：

```text
docs/optimization/tavo-mini-canon-analysis-round2-fix-plan.md
```

本方案必须保持自包含，不引用已删除的旧原著分析方案。

---

# 第一部分：P0 阻断问题

## 4. P0-1：修复批次 `partial` 状态与数据库约束不一致

### 4.1 当前问题

业务代码在缩块成功但正文尚未完全覆盖时，将父批次更新为：

```sql
state = 'partial'
```

但数据库 `continuation_analysis_batches.state` 当前只允许：

```text
queued
running
completed
failed
cancelled
```

一旦触发缩块补尾流程，SQLite 会因 CHECK 约束失败而中断。

### 4.2 推荐方案

新增下一 Schema 版本，将批次状态正式扩展为：

> 远端当前为 Schema 33，因此远端基线对应 Schema 34；若本地已升级，使用本地当前版本 + 1。

```text
queued
running
partial
completed
failed
cancelled
```

不建议仅把 `partial` 存入 `error_code`，因为它是明确的业务状态：

- 已完成部分正文；
- 已保存有效结果；
- 尚存在未覆盖子范围；
- 当前批次不能计入最终完成。

### 4.3 迁移要求

SQLite 无法直接修改 CHECK，需重建 `continuation_analysis_batches`：

1. 创建新表；
2. 新 CHECK 包含 `partial`；
3. 复制旧数据；
4. 重建主键、唯一索引和普通索引；
5. 删除旧表；
6. 重命名新表；
7. 校验外键和行数一致。

### 4.4 状态语义

| 状态 | 含义 | 可最终化 |
|---|---|---:|
| queued | 等待处理 | 否 |
| running | 正在处理 | 否 |
| partial | 当前范围部分完成，已有子批次接管未覆盖部分 | 否 |
| completed | 当前批次全部范围和所有必要路线完成 | 是 |
| failed | 不可恢复失败 | 否 |
| cancelled | 用户取消 | 否 |

### 4.5 验收条件

- `state='partial'` 可以正常写入；
- 运行恢复后能识别 partial 父批次；
- partial 不计入 completed；
- partial 存在时不能最终化；
- 子批次全部完成后，父批次可转为 completed 或保持 partial 但由聚合状态明确判定已闭合；
- 推荐最终将父批次转为 completed，并保留 `had_partial_coverage=1` 审计字段。

---

## 5. P0-2：重构动态补尾子批次为持久化任务

### 5.1 当前问题

现有动态子批次存在以下缺陷：

- `itemsByBatch` 在循环开始前只加载一次；
- 新插入的 work item 没有同步到内存 Map；
- 新子批次可能没有实际执行任何 API 请求；
- `partialCoverageByBatch` 只按 `batchIndex` 存储，一批内两路同时缩块会互相覆盖；
- 多章节父批次创建的子批次仍使用父批次章节范围；
- chunk 元数据只写入内存对象，未持久化；
- 应用重启后无法恢复子批次字符边界；
- progressTotal 没有可靠增加；
- 子批次与父批次、路线、章节之间缺少稳定关系。

### 5.2 目标数据模型

建议在下一 Schema 版本为批次补充：

```sql
parent_batch_index INTEGER,
material_type TEXT,
chapter_id INTEGER,
source_char_start INTEGER,
source_char_end INTEGER,
coverage_kind TEXT NOT NULL DEFAULT 'full',
had_partial_coverage INTEGER NOT NULL DEFAULT 0
```

字段含义：

- `parent_batch_index`：父批次索引；
- `material_type`：当批次是路线专属补尾时，明确属于哪一路；
- `chapter_id`：字符级子批次对应的唯一章节；
- `source_char_start/source_char_end`：相对该章节正文的 UTF-16 字符范围；
- `coverage_kind`：
  - `full`
  - `chunk`
  - `retry_tail`
  - `rescan`
- `had_partial_coverage`：是否曾发生缩块补尾。

如不希望扩展原表，也可以建立独立表：

```sql
continuation_analysis_batch_segments
```

但从实现复杂度看，直接扩展批次表更简单。

### 5.3 子批次唯一键

子批次幂等键必须包含：

```text
run_id
parent_batch_index
material_type
chapter_id
source_char_start
source_char_end
coverage_kind
```

例如：

```text
{runId}:{parentBatch}:{materialType}:{chapterId}:{start}:{end}:retry_tail
```

禁止使用运行时数组长度生成不可恢复的唯一标识。

### 5.4 子批次创建规则

每个未覆盖范围按以下粒度创建独立子批次：

```text
一条路线 × 一个章节 × 一个连续字符范围
```

禁止：

- 一个子批次覆盖父批次全部章节范围；
- 仅记录章节 position 而不记录字符范围；
- 用内存 Map 作为唯一范围来源；
- 两条路线共享同一个补尾 work item。

### 5.5 调度器要求

每处理完一个批次后，调度器必须重新读取数据库中的可执行批次，而不是依赖初始数组快照。

推荐循环：

```ts
while (true) {
  const nextBatch = await findNextQueuedBatch(runId);
  if (!nextBatch) break;
  await processOneBatch(nextBatch);
}
```

优于：

```ts
const batches = await listBatches(runId);
for (const batch of batches) {
  // 中途修改 batches
}
```

### 5.6 work item 要求

对于普通批次：

```text
character_state
world_plot
```

两个 work item 均存在。

对于路线专属补尾子批次：

```text
只创建发生 partial 的 material_type
```

创建后必须立即持久化，并由数据库查询驱动调度。

### 5.7 进度计算

禁止使用仅增不减的内存计数器作为真实进度。

真实进度应从数据库计算：

```sql
completed_work_items / total_work_items
```

动态新增子批次和 work item 后：

- `progress_total` 自动增加；
- 恢复运行时进度保持正确；
- 两个页面同时观察也不会出现不同步。

### 5.8 验收条件

- 两路同时 partial 时创建两个独立子批次；
- 多章节批次中某一章 partial，只创建该章尾段；
- 新子批次会真实发起 API 请求；
- 应用强制退出后恢复，子批次范围不丢失；
- 不重复创建相同尾段；
- 所有正文字符最终被至少一次有效分析覆盖；
- 不允许未覆盖尾部静默进入 finalizing。

---

## 6. P0-3：建立统一的总输入预算切片器

### 6.1 当前问题

当前重试时通过：

```ts
chapter.content.slice(0, chapterTextLimit)
```

对每章分别裁剪。

这不能保证多章节请求的总正文量从 30%降到20%或12%。

例如：

- 10章；
- 每章3万字符；
- 每章均小于 `chapterTextLimit`；
- 重试时输入总量可能完全没有减少。

定向补扫15%也存在同样问题。

### 6.2 新增统一模块

建议新增：

```text
canonSourceSlicePlanner.ts
```

核心接口：

```ts
interface SourceSliceInput {
  chapters: BoundedSourceChapter[];
  totalTokenBudget: number;
  startCursor?: SourceCursor;
}

interface SourceCursor {
  chapterId: number;
  charOffset: number;
}

interface SourceSliceSegment {
  chapterId: number;
  chapterPosition: number;
  charStart: number;
  charEnd: number;
  content: string;
  absoluteBookCharStart: number;
}

interface SourceSlicePlan {
  segments: SourceSliceSegment[];
  estimatedTokens: number;
  fullyCovered: boolean;
  nextCursor: SourceCursor | null;
}
```

### 6.3 核心行为

切片器必须：

1. 按章节顺序消费总 token 预算；
2. 预算是整个请求的原著正文总预算；
3. 可包含多个完整章节；
4. 最后一个章节可以只包含部分；
5. 返回精确的下一游标；
6. 不重复、不跳过字符；
7. 支持从章节中间开始；
8. 使用统一 token 估算器；
9. 对 CJK、ASCII、混合文本保持保守估算；
10. 为每个 segment 保留原章节 ID 和绝对偏移。

### 6.4 预算来源

正常分析：

```text
context_window × 30%
```

第一次缩块：

```text
context_window × 20%
```

第二次缩块：

```text
context_window × 12%
```

定向补扫：

```text
context_window × 15%
```

如果服务商协议要求：

```text
input + max_output <= context_window
```

则只缩正文可用预算，不降低 `max_output_tokens`。

### 6.5 提示词构造

提示词不得再遍历原始章节后各自 slice。

应直接使用切片器产出的 segments：

```ts
segments.map(segment => renderSegment(segment))
```

每个 segment 的 metadata 至少包含：

```text
chapterId
chapterPosition
segmentCharStart
segmentCharEnd
bookBodyStart
bookBodyEnd
```

### 6.6 partial 判定

只有：

```text
slicePlan.fullyCovered === false
```

才标记 partial。

不能因为发生过重试就自动认为 partial。

### 6.7 验收条件

- 多章节请求重试后总正文 token 确实减少；
- 30%、20%、12%、15%均按请求总量计算；
- 每个未覆盖尾段都可以生成精确游标；
- 相邻切片首尾无缝衔接；
- 无重复字符范围；
- 无遗漏字符范围；
- 超长单章、短章集合和混合章节均通过测试。

---

## 7. P0-4：修复五类事实唯一索引与 upsert

### 7.1 当前问题

Schema 33 已添加部分唯一索引，但物化仍使用普通 `INSERT`。

重复事实可能来自：

- 不同正常批次；
- 缩块子批次；
- 定向补扫；
- 恢复重跑；
- 模型对同一事实使用相同标题或业务键。

普通 `INSERT` 会触发唯一约束错误并导致批次失败。

### 7.2 五类业务键

#### 世界规则

```text
snapshot_id + normalized_title
```

当前只使用原始 `title`，建议新增或计算规范化键：

```text
title_normalized
```

#### 人物

```text
snapshot_id + canonical_name_normalized
```

当前 `canonical_name` 直接唯一可能受空格、大小写和标点影响。

#### 剧情线

```text
snapshot_id + normalized_title
```

#### 人物关系

```text
snapshot_id
+ source_character_id
+ target_character_id
+ normalized_relation_type
```

需要明确关系方向语义；若某些关系无方向，应在写入前标准化人物 ID 顺序。

#### 人物经历

```text
snapshot_id
+ character_id
+ event_type
+ normalized_title
```

### 7.3 标准 upsert 模式

不要依赖：

```sql
INSERT ... ON CONFLICT DO UPDATE
```

之后再使用：

```sql
SELECT last_insert_rowid()
```

因为 UPDATE 路径不会保证 `last_insert_rowid()` 是目标事实 ID。

推荐统一封装：

```ts
async function upsertFactAndReturnId(...)
```

实现方式优先级：

#### 方案 A：SQLite 支持 RETURNING

```sql
INSERT INTO ...
VALUES (...)
ON CONFLICT (...) WHERE ...
DO UPDATE SET ...
RETURNING id
```

#### 方案 B：兼容模式

1. `INSERT OR IGNORE`；
2. 使用完整业务键 `SELECT id`；
3. 显式 `UPDATE`；
4. 返回查询得到的 ID。

### 7.4 更新策略

冲突时需要定义字段合并：

- `confidence`：取较高值或最新值；
- `description`：优先更完整文本；
- `last_observed_position`：取较大值；
- `first_observed_position`：取较小值；
- `updated_at`：更新；
- `analysis_run_id`：保持当前快照当前运行；
- `review_status`：
  - 不得把用户 locked/confirmed 降回 pending；
  - 当前 staging 快照通常只有 AI 数据，但仍应写成安全规则；
- `revision`：必要时增加。

### 7.5 证据绑定

事实 upsert 返回真实 ID 后，再插入 evidence 和 link。

禁止使用任何“最近插入 ID”推断冲突更新后的目标行。

### 7.6 验收条件

- 相同世界规则跨批次不报错；
- 相同剧情线补扫不报错；
- 相同关系重跑不报错；
- 相同经历重跑不报错；
- evidence 链接到实际 upsert 行；
- 事实总数不因重跑无限增长；
- 多条不同 evidence 可同时链接同一事实；
- 五维 Gate 按事实去重后的行数统计。

---

# 第二部分：P1 数据质量问题

## 8. P1-1：统一所有 evidence 写入入口

### 8.1 当前问题

部分维度使用统一 `evInput()`，但关系、知识、状态、时间线等仍手工构造 evidence 参数。

手工构造遗漏：

- `readBackVerifier`
- `sourceOrigin`
- `rescanOperationId`

后果：

- 错误偏移可能落库；
- rescan evidence 被标成 batch；
- 补扫清理找不到相关证据；
- 不同维度质量标准不一致。

### 8.2 改造要求

所有 evidence 写入必须经过唯一入口：

```ts
buildEvidenceInsertInput(ctx, candidate)
```

禁止业务循环自行拼装参数。

适用 owner type：

```text
world_rule
character
alias
relationship
plot_thread
experience
knowledge
character_state
timeline_event
```

### 8.3 原文回读

每条 evidence 在事务写入前必须完成：

```text
范围合法
→ SourceReader 回读
→ 回读文本与 quotePreview 一致
→ hash 计算
→ 写入
```

建议先在事务外完成 readback，生成 VerifiedEvidence：

```ts
interface VerifiedEvidence {
  candidate: ExtractionEvidenceCandidate;
  quoteSha256: string;
  quoteText: string;
}
```

事务内不做文件读取或耗时 I/O。

### 8.4 验收条件

- 所有 owner type 均经过 readback；
- 任意维度偏移错误均拒绝；
- 所有 rescan evidence 正确标记；
- evidence 日志可追踪来源；
- 不再存在手工 evidence input。

---

## 9. P1-2：修复定向补扫删除顺序和孤儿证据

### 9.1 当前问题

当前流程先删除 links，再通过 `EXISTS(link)` 删除 evidence。

第二步执行时 links 已不存在，因此 evidence 不会被删除，产生孤儿记录。

### 9.2 推荐实现

在同一事务中先冻结待删除 ID：

```sql
CREATE TEMP TABLE temp_rescan_evidence_ids(id INTEGER PRIMARY KEY);
```

或在代码中先查询 ID 列表。

事务步骤：

1. 查询目标 evidence IDs；
2. 删除对应 links；
3. 删除对应 evidence；
4. 插入新的事实、evidence 和 links；
5. 校验本 operation 无孤儿；
6. 提交事务。

若数据库始终启用外键并确认 `canon_evidence_links.evidence_id ON DELETE CASCADE` 生效，可直接删除 evidence，但仍建议保留显式测试。

### 9.3 删除范围

删除必须同时限定：

```text
snapshot_id
analysis_run_id
source_origin = 'rescan'
rescan_operation_id
owner_type
```

不能删除：

- 正常 batch evidence；
- 另一 request group evidence；
- 另一 rescan round evidence；
- 其他快照或运行的数据。

### 9.4 验收条件

- 同一 operation 重跑后旧 evidence 为0；
- 旧 links 为0；
- 新 evidence 正确写入；
- 孤儿 evidence 为0；
- 另一维度 evidence 数量不变；
- batch evidence 数量不变。

---

## 10. P1-3：定向补扫必须走统一批次规划

### 10.1 当前问题

补扫目前可能一次将半部章节传入 extractor。

15%实际上变成“每章最多15%”，不是请求总正文15%。

此外：

- 提取使用 roundChapters；
- 物化可能使用全部 rescanChapters；
- 缩块 partial outcome 未处理；
- 章节范围和 evidence resolution 可能不一致。

### 10.2 改造方案

定向补扫使用与正常分析相同的切片器和调度器，仅参数不同：

```text
mode scope：保持当前模式范围
request group：只选择缺失维度所属路线
source ratio：15%
round：最多2轮
```

### 10.3 轮次策略

第一轮：

```text
按当前模式范围，从靠近续写边界的一侧开始扫描
```

第二轮：

```text
扫描尚未覆盖的另一部分范围
```

注意：

- 快速模式永远不能越过最后10章；
- 完整模式可以覆盖全部章节；
- 两轮不可使用完全相同的切片；
- 每轮可以产生多个15%批次，而不是单次请求。

### 10.4 补扫粒度

建议针对缺失的具体维度聚焦提示词，而不是只按路线泛化：

```text
characters
relationships
experiences
worldRules
plotThreads
```

同一路有多个缺失维度时可合并一次请求，但提示词必须明确只补缺失项。

### 10.5 补扫物化

每次只物化本次实际发送的 segments。

禁止传入未发送给模型的章节范围。

### 10.6 验收条件

- 15%是所有 segments 总 token；
- 快速模式不读取第11章；
- 补扫 partial 会创建持久化尾段；
- 补扫不误删其他维度；
- 补扫后 Gate 重新查询数据库；
- 补扫后 coverage/capabilities 重算；
- 两轮仍不足则运行失败，不激活。

---

## 11. P1-4：Schema 33历史去重必须重绑定 evidence links

### 11.1 当前问题

历史迁移保留最大 ID 事实并删除旧重复行，但未把旧事实的 evidence links 转移到保留行。

因为 `owner_id` 是多态 ID，不具备到五张事实表的外键约束，删除事实不会自动重绑定。

可能出现：

- 有证据的旧事实被删；
- 无证据的新事实被保留；
- link 指向不存在 owner；
- Gate 判断保留事实无证据。

### 11.2 新迁移策略

建议 Schema 34 对五张表分别执行可验证迁移。

对每个业务键分组：

1. 选择 keeper ID；
2. 建立 duplicate ID → keeper ID 映射；
3. 将所有 evidence links 的 `owner_id` 更新为 keeper ID；
4. 若更新后产生重复 link，使用 `INSERT OR IGNORE` 或去重；
5. 删除 duplicate facts；
6. 删除无任何 link 的孤儿 evidence；
7. 创建或验证唯一索引；
8. 记录迁移统计。

### 11.3 keeper 选择

不要简单固定最大 ID。

建议优先级：

1. `review_status='locked'`
2. `review_status='confirmed'`
3. 有 evidence 数量更多
4. confidence 更高
5. updated_at 更新
6. ID 更大

如 staging 快照无用户数据，可简化，但迁移函数应对真实历史状态安全。

### 11.4 迁移后校验

每张表至少检查：

```text
重复业务键 = 0
悬空 owner links = 0
孤儿 evidence = 0
有效事实证据数未减少
```

### 11.5 验收条件

- 升级前后五维有效计数不下降；
- 旧证据全部关联 keeper；
- 无悬空 link；
- 无唯一索引创建失败；
- 迁移可重入；
- 迁移失败完整回滚。

---

## 12. P1-5：物化改为原子事务

### 12.1 当前问题

当前流程常见形式：

```text
清理事务
→ 多条事实逐条自动提交
→ evidence逐条自动提交
→ links逐条自动提交
```

中途任意失败会留下半成品。

### 12.2 目标流程

```text
解析
→ Schema校验
→ evidence定位
→ SourceReader回读验证
→ 构建写入计划
→ 单事务物化
→ 提交
→ 数据库回读
→ Gate/coverage
```

### 12.3 写入计划

建议新增：

```ts
interface CanonMaterializationPlan {
  facts: PlannedFactUpsert[];
  evidence: PlannedEvidenceInsert[];
  links: PlannedEvidenceLink[];
  cleanup: PlannedCleanup[];
}
```

事务前：

- 完成所有纯计算；
- 完成所有 SourceReader I/O；
- 验证业务键；
- 验证 evidence；
- 计算 source origin。

事务内：

1. 精确清理；
2. upsert facts；
3. 获取真实 IDs；
4. 插入 evidence；
5. 插入 links；
6. 执行本批次不变量查询；
7. 提交。

### 12.4 事务不变量

提交前验证：

- 每个被计入的五维事实至少有一条 evidence；
- 每条 evidence 至少有一条 link；
- 所有 links 的 owner ID 存在；
- owner type 与事实表匹配；
- 当前 operation 无重复业务键；
- 无超边界 evidence。

### 12.5 失败处理

任意一步失败：

- 整个事务回滚；
- work item 标记 failed；
- batch 标记 failed；
- 当前 staging snapshot 不激活；
- 旧 ready snapshot 保持不变。

### 12.6 验收条件

- 在任意写入步骤注入异常，数据库无半成品；
- 事实、证据、链接数量保持事务前状态；
- retry 可安全重跑；
- materialization empty 错误能准确区分；
- Gate 永远不会统计半成品。

---

# 第三部分：状态机与最终验收

## 13. 统一批次完成判定

一个批次只有同时满足以下条件才可为 completed：

- 所有规定 work item 完成；
- 当前批次没有未覆盖范围；
- 所有 partial 尾段已被子批次接管；
- 子批次已持久化成功；
- 物化事务成功；
- 结果可回读；
- 当前批次没有 queued/running/failed 子任务。

父子关系建议使用递归或聚合查询判断。

---

## 14. 最终化前硬门

进入 finalizing 前必须查询数据库：

```text
failed batches = 0
queued batches = 0
running batches = 0
partial batches = 0
failed work items = 0
queued work items = 0
running work items = 0
```

任一不为0：

- 不得运行五维 Gate；
- 不得运行 style analysis；
- 不得进入 awaiting_review；
- 不得激活。

---

## 15. 五维验收

最终验收保持：

```text
characters >= 3
worldRules >= 3
relationships >= 3
plotThreads >= 3
experiences >= 3
```

统计必须限定：

```text
当前 run
当前 snapshot
非 superseded
非 ignored
事实存在
至少一条有效 evidence link
evidence 属于当前 run/snapshot
```

建议增强：

- link owner ID 必须真实存在；
- evidence quote 回读仍一致；
- 不计悬空 links；
- 不计历史迁移残留。

---

## 16. coverage 与 capabilities

五维 Gate 通过后重新计算：

- categoryCounts
- capabilities
- evidenceValidated
- analyzedChapterCount
- analyzedRanges
- incompleteReasons

其中：

- 快速模式的 `sourceChapterCount` 应明确表示模式范围章节数，或另增加：
  - `totalImportedChapterCount`
  - `selectedSourceChapterCount`
- `partial_chapter_coverage` 只能表示当前模式范围有遗漏，不能因完整 TXT 比最后10章更多而把快速模式标成不完整。

---

## 17. 激活

激活仍保持最终原子操作：

```text
Canon snapshot
+
style profile
+
continuation_settings.active_canon_snapshot_id
```

新运行失败时：

- 旧 active snapshot 不变；
- 旧 style profile 不变；
- AI 续写继续读取旧成功产物；
- staging/failed 数据不能被续写读取。

---

# 第四部分：数据库迁移计划

## 18. 下一 Schema 版本建议内容

下一 Schema 版本至少包含：

1. 重建 `continuation_analysis_batches`，支持 partial；
2. 增加父子批次与字符范围字段；
3. 增加适合调度的索引；
4. 修复五类事实历史重复的 evidence link 重绑定；
5. 清理悬空 links；
6. 清理孤儿 evidence；
7. 规范化业务键字段或索引；
8. 验证 Schema 33唯一索引；
9. 增加迁移审计测试。

### 推荐索引

```sql
CREATE INDEX idx_analysis_batches_next
ON continuation_analysis_batches(run_id, state, batch_index);

CREATE INDEX idx_analysis_batches_parent
ON continuation_analysis_batches(run_id, parent_batch_index);

CREATE INDEX idx_analysis_batches_segment
ON continuation_analysis_batches(
  run_id,
  material_type,
  chapter_id,
  source_char_start,
  source_char_end
);
```

---

# 第五部分：实施步骤

## 19. 第一阶段：先补失败测试

编码前先添加能稳定暴露问题的测试：

1. partial 状态写入触发旧 CHECK；
2. 动态子批次创建后未执行 work item；
3. 两路同时 partial 被覆盖；
4. 多章节缩块总输入未减少；
5. 子批次重启后 chunk meta 丢失；
6. 重复 world rule 触发唯一约束；
7. upsert 后 last_insert_rowid 指向错误；
8. 补扫删除 links 后 evidence 残留；
9. relationship evidence 未 readback；
10. 15%补扫总输入超预算；
11. 迁移删除有证据旧事实；
12. 物化中途失败留下半成品。

---

## 20. 第二阶段：完成下一 Schema 迁移

先解决：

- partial 状态；
- 子批次持久化字段；
- 迁移 evidence links；
- 唯一索引兼容；
- 数据清理。

所有迁移测试通过后再改业务调度器。

---

## 21. 第三阶段：实现统一切片器

将以下流程全部迁移到同一切片器：

- 正常30%；
- retry 20%；
- retry 12%；
- rescan 15%；
- 超长单章；
- 多章节批次；
- 子批次恢复。

删除或退役按每章 slice 的旧逻辑。

---

## 22. 第四阶段：重构调度器

改为数据库驱动：

```text
读取下一个 queued batch
→ 读取该批次 work items
→ 运行
→ 物化
→ 如 partial 则创建子批次
→ 继续读取下一个 queued batch
```

不能再依赖启动时一次性加载的 batch/work item 数组。

---

## 23. 第五阶段：统一 upsert 与 evidence

完成：

- 五类事实 upsert；
- 真实 ID 返回；
- 统一 evidence input；
- readback；
- rescan provenance；
- 精确清理。

---

## 24. 第六阶段：原子物化

将正常批次和补扫物化统一为：

```text
prepare plan
→ transaction
→ readback
```

正常分析和 rescan 只在 cleanup scope、sourceOrigin 和 operation ID 上有差异。

---

## 25. 第七阶段：最终化和激活

加入：

- 未完成批次硬门；
- 未完成 work item硬门；
- 五维 Gate；
- coverage 重算；
- style analysis；
- 原子激活。

---

# 第六部分：测试矩阵

## 26. 单元测试

### 切片器

- 单章短文本；
- 单章超长文本；
- 多章总预算；
- CJK；
- ASCII；
- 混合文本；
- 30%；
- 20%；
- 12%；
- 15%；
- 游标恢复；
- 边界无重复；
- 边界无遗漏。

### upsert

- insert路径；
- update路径；
- 返回真实ID；
- evidence绑定真实ID；
- review_status保护；
- confidence合并；
- position合并。

### evidence

- 所有owner type回读；
- 错误偏移拒绝；
- 正确偏移接受；
- chunk绝对偏移；
- sourceOrigin；
- operation ID；
- 孤儿检测。

---

## 27. 集成测试

至少覆盖：

1. 完整模式多批次成功；
2. 快速模式最后10章成功；
3. 两路正常并行；
4. 一路缩块；
5. 两路同时缩块；
6. 多章节缩块；
7. 动态子批次实际请求；
8. 应用重启恢复；
9. 子批次幂等；
10. 父批次partial禁止最终化；
11. 重复世界规则跨批次；
12. 重复剧情线定向补扫；
13. 重复关系；
14. 重复经历；
15. 补扫不删除另一分类；
16. 补扫重跑零孤儿；
17. 物化异常完整回滚；
18. Gate少于3条失败；
19. 补扫后达到3条成功；
20. 新运行失败保留旧active；
21. AI续写统一读取active snapshot；
22. 动态子批次全部通过 `canon_analysis` 队列；
23. Canon 同时在途请求不超过2；
24. queued子批次取消后不再启动；
25. provider迟到响应在取消后不得落库；
26. Canon 调用次数不受V4四次物理请求上限影响；
27. Canon长任务不影响续写pending review结果找回；
28. style analysis仍使用独立单飞队列。

---

## 28. 迁移测试

至少准备：

- Schema 32 数据库；
- Schema 33 无重复数据库；
- Schema 33 有重复事实数据库；
- 有证据旧事实 + 无证据新事实；
- 多条 evidence 指向重复事实；
- 悬空 link；
- 孤儿 evidence；
- partial运行模拟数据。

验证升级到下一 Schema 版本后：

```text
业务键重复 = 0
有效事实数不下降
有效 evidence 数不下降
悬空 link = 0
孤儿 evidence = 0
批次状态合法
旧成功快照仍可读取
```

---

# 第七部分：日志与可观测性

## 29. 建议日志字段

每个批次记录：

```text
runId
snapshotId
batchIndex
parentBatchIndex
materialType
chapterId
sourceCharStart
sourceCharEnd
coverageKind
chunkRatio
sourceTokenBudget
actualSourceTokens
attempt
finishReason
partialCoverage
nextCursor
createdChildBatchCount
materializedFactCount
verifiedEvidenceCount
rejectedEvidenceCount
transactionCommitted
```

定向补扫额外记录：

```text
rescanRound
missingDimensions
requestGroup
rescanOperationId
sourceOrigin
```

禁止记录：

- API Key；
- 完整原著正文；
- 完整模型思维链；
- 不必要的敏感响应。

---

# 第八部分：验收标准

## 30. P0验收

以下任一不满足，禁止合并：

- partial 状态不再触发数据库约束；
- 动态子批次真实执行；
- 子批次重启可恢复；
- 两路 partial 不互相覆盖；
- 多章节20%/12%总输入确实下降；
- 五类事实重复不触发唯一约束；
- upsert evidence 绑定真实ID；
- 补扫无孤儿证据；
- 物化异常完整回滚。

---

## 31. 产品验收

### 完整分析

- 分析全部导入 TXT；
- 正文按30%总预算切块；
- 所有缩块尾段最终处理；
- 五维每维不少于3条；
- 结果真实落库并可回读；
- 页面可见；
- 可激活；
- AI续写可读取。

### 快速续写分析

- 只分析最后10章；
- 不读取第11章之前内容；
- 正文按30%总预算切块；
- 自身独立满足五维每维不少于3条；
- 结果真实落库并可回读；
- 页面可见；
- 可激活；
- AI续写使用相同查询链路读取。

---

## 32. 技术验收

必须全部通过：

```powershell
npm run lint
npm run typecheck
npm run verify:version
npm run test:ci
npm run apk:debug
```

也可以最终执行聚合命令：

```powershell
npm run verify
```

远端当前 `package.json` 要求 Node.js `>=24.3.0`，开工前必须记录：

```powershell
node --version
npm --version
```

此外必须单独报告：

```text
Canon 单元测试
Canon 集成测试
Schema迁移测试
fresh-install schema测试
backup/restore测试
续写V4回归测试
pending review回归测试
Android debug build
```

并提供：

- 总测试数；
- 新增测试数；
- 失败数；
- 跳过数；
- Schema版本；
- 迁移结果；
- APK构建结果。

---

# 第九部分：Agent执行要求

## 33. 开发原则

Agent实施时必须遵循：

1. 先完成本地/远端差异预检，保护用户未提交改动；
2. 先复现并补失败测试；
3. 再修改生产实现；
4. 不通过删除断言或降低标准让测试通过；
5. 不复制事实凑数量；
6. 不绕过 evidence 回读；
7. 不用内存状态替代数据库持久化；
8. 不把 max_output_tokens 降低；
9. 不关闭思考模式；
10. 不改变最后10章产品定义；
11. 不让两个分析模式相互借用数据；
12. 不让失败快照替换旧active；
13. 所有迁移必须可验证和可回滚。
---

## 34. 最终交付报告

完成后必须输出：

1. 开工时本地 HEAD、远端 HEAD 和 ahead/behind 状态；
2. 根因说明；
3. 修改模块列表；
4. 下一 Schema 迁移内容及最终版本号；
5. 批次状态机变化；
6. 统一切片器实现；
7. 动态子批次恢复机制；
8. 五类事实 upsert 策略；
9. evidence统一校验策略；
10. 事务物化策略；
11. 历史数据修复结果；
12. 新增测试列表；
13. 完整测试结果；
14. 构建结果；
15. 尚存风险；
16. 人工复核关键文件和关键函数。
---

# 第十部分：完成定义

本轮修复只有在以下全部成立时才算完成：

```text
正文不静默丢失
动态补尾可恢复
总预算切片真实生效
重复事实安全upsert
证据真实回读
补扫精确隔离
迁移不损失证据
物化完全原子
五维硬验收可信
失败运行不影响旧产物
AI续写统一读取成功产物
```

任何一个条件不满足，本轮修复均不得视为验收通过。

---

## 35. 本修订版的适用判断

在本地仓实际施工时，Agent应将每一项标记为：

```text
未实现
部分实现
已实现但缺测试
已完整实现
不再适用（必须说明仓库变化）
```

只有通过当前本地代码和自动化测试证明“已完整实现”的项目才能从施工范围移除。  
不得仅根据提交说明、注释或函数名称判定问题已经解决。

