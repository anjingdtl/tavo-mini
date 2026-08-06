# Tavo Mini Pipeline 最终收口与外键 787 修复方案

> 适用仓库：`D:\AiWorkSpace\tavo-mini`  
> 远端审计基线：`anjingdtl/tavo-mini main @ d854a20a2a131988afad45e01375f5330dbb345f`  
> 本地代码始终为施工时的唯一事实来源。  
> 文档目的：完成 Pipeline 专项的最后封口，同时修复章节大纲写作启动时的 SQLite 外键错误。

---

## 1. 背景与当前状态

Tavo Mini 的大纲写作 Pipeline 已完成以下架构收敛：

- Schema 39 阶段 checkpoint；
- `determineNextPipelineAction()` 持久化状态决策；
- `reconcilePipelineTask()` 作为首次运行与恢复的统一入口；
- CAS 阶段认领；
- Draft 最终请求冻结；
- Full 模式 Audit 候选集合冻结；
- Review、Fact Check、Proof 统一请求编译；
- `ReadyStageRequest` 模型调用门禁；
- 守恒预算分配器；
- checkpoint 查询和 CAS 的 fail-closed 语义。

这些架构方向已经正确，本轮禁止再次重构或复制新的执行体系。

当前仍需处理两组问题：

1. **最终消息兜底裁剪可能破坏完整大纲、必需正文或系统协议。**
2. **新任务父记录异步落库，checkpoint 子记录可能先插入，触发 SQLite 外键错误 787。**

用户现场报错：

```text
FOREIGN KEY constraint failed
(code 787 SQLITE_CONSTRAINT_FOREIGNKEY)
```

该错误出现在章节编辑页启动大纲写作 Pipeline 时，属于数据库父子记录写入顺序问题，不是大纲内容、导入格式或模型配置问题。

---

## 2. 本轮目标

完成以下两个封口，之后结束 Pipeline 专项架构审计：

```text
封口 A：最终窗口收缩只能裁剪 optional sections
封口 B：pipeline_tasks 与 pipeline_stage_checkpoints 原子创建和安全更新
```

最终必须满足：

```text
完整大纲永不被最终兜底裁剪
阶段必需正文永不被最终兜底裁剪
系统协议和 repair 指令永不被最终兜底裁剪

任务父记录成功落库后才能启动状态机
checkpoint 不可能在父任务不存在时插入
保存父任务不得删除已有 checkpoint
父任务或事务失败时 LLM 调用次数为 0
```

---

## 3. 非目标与禁止事项

本轮禁止：

- 新建第二套 Runner 或 Resume；
- 修改现有状态机总体设计；
- 新建另一套 Pipeline Store；
- 关闭 `PRAGMA foreign_keys`；
- 通过 `sleep()`、延迟 300ms、重试等待等方式掩盖竞态；
- 在 UI 中吞掉 787 后自动重试；
- 将 checkpoint 外键删除；
- 将 `ON DELETE CASCADE` 改为无约束；
- 重新引入 `INSERT OR REPLACE`；
- 对完整组装后的 system/user message 整体裁剪；
- 以“先发布后观察”为由跳过真实 SQLite 测试；
- 顺手扩展 Draft、Story Memory、Audit 检索或 UI 功能。

发现其他问题时，只记录，不扩大本轮施工范围，除非它直接阻塞本方案的两项不变量。

---

# 4. 问题一：最终消息兜底裁剪破坏 mandatory 内容

## 4.1 当前风险

Review、Fact Check、Proof 已经使用守恒预算器分配 optional sections，并根据 allocation 裁剪：

- preset；
- character；
- worldbook；
- notes；
- Story Memory；
- episodic memory；
- recent bridge；
- user prompt；
- review/fact-check 辅助资料等。

但 `compileStageRequest.ts` 中的最终组装逻辑在发现消息因标签、角色或协议开销略微超窗时，仍可能直接裁剪整条 `system` 或 `user` message。

一条 Review user message 通常同时包含：

```text
项目大纲
可选上下文资料
完整 Draft 正文
任务标签
```

一条 Proof message 也可能同时包含：

```text
完整 Draft
Review 报告
Fact Check 报告
项目大纲
修订协议
可选设定资料
```

对整条消息调用 `clipTextToTokenBudget()` 会同时切掉：

- 完整大纲；
- Draft 正文；
- Review / Fact Check 报告；
- 系统输出格式；
- repair 指令；
- 消息尾部的重要约束。

这违反以下核心不变量：

```text
outline = mandatory
stage body = mandatory
protocol = mandatory
repair instruction = mandatory
optional context = 可裁剪
```

## 4.2 正确设计

最终消息编译必须采用“重新分配并重建”，而不是“组装后整体切字符串”。

推荐流程：

```text
1. 计算固定协议 token
2. 保留完整大纲
3. 保留完整阶段必需正文
4. 计算 optional 剩余预算
5. 分配 optional allocations
6. 按 allocation 裁剪 optional 原始字段
7. 组装最终 messages
8. 对最终 messages 重新估算
9. 若因标签/协议开销轻微超窗：
   只缩减 optional allocations
10. 重新组装 messages
11. 再检查
12. 仍无法容纳则返回 Blocked
```

禁止在第 9 步裁剪已经组装完成的整条消息。

## 4.3 推荐接口

将编译过程内部整理为可重建结构：

```ts
interface OptionalContextSection {
  id: string;
  rawText: string;
  requestedTokens: number;
  allocatedTokens: number;
  weight: number;
}

interface MandatoryStageContent {
  outlineText: string;
  bodyText: string;
  systemProtocol: string;
  repairInstruction?: string;
}

interface StageAssemblyInput {
  mandatory: MandatoryStageContent;
  optionalSections: OptionalContextSection[];
}
```

阶段 Builder 接收已经裁剪后的 optional 字段：

```ts
function buildReviewMessagesFromAllocation(
  input: StageAssemblyInput,
): ChatMessage[];
```

或者保留现有 Builder，但编译器必须能够基于新的 allocation 重建 context 对象和 messages。

## 4.4 收缩算法

建议最多执行 3 次收缩：

```ts
for (let pass = 0; pass < 3; pass += 1) {
  const clippedOptional = clipOptionalSections(
    originalOptionalSections,
    allocations,
  );

  const messages = buildMessages({
    mandatory,
    optional: clippedOptional,
  });

  const estimatedInputTokens = estimateStageInputTokens(messages);
  const total =
    estimatedInputTokens +
    reservedOutputTokens +
    safetyMargin;

  if (total <= contextWindow) {
    return ready(messages, allocations);
  }

  const overshoot = total - contextWindow;

  const changed = shrinkOptionalAllocations({
    allocations,
    overshoot,
    priority: OPTIONAL_SHRINK_PRIORITY,
  });

  if (!changed) {
    break;
  }
}

return blocked(...);
```

`shrinkOptionalAllocations()` 只能修改 optional 项：

```text
preset
character
worldbook
note
storyMemory
episodic
recentBridge
userPrompt
可选报告或补充资料
```

不得修改：

```text
outline
mandatory_body
system_protocol
repair_instruction
required_review_report
required_fact_check_report
```

## 4.5 收缩优先级

优先回收低优先级或体积最大的 optional 分区。

可采用以下启发式：

```text
1. 按可回收 token 从大到小
2. 同等情况下按业务优先级从低到高
3. 每轮按 overshoot + 额外安全缓冲回收
4. 不允许 allocation 变成负数
5. 所有 allocation 总和始终守恒
```

示例：

```ts
const targetReduction = overshoot + 32;

const shrinkable = allocations
  .filter(section => section.kind === 'optional')
  .sort((a, b) => {
    const byPriority = a.shrinkPriority - b.shrinkPriority;
    if (byPriority !== 0) return byPriority;
    return b.allocatedTokens - a.allocatedTokens;
  });
```

## 4.6 错误分类

最终仍无法容纳时：

### 只有完整大纲自身导致不可容纳

```text
OUTLINE_TOO_LARGE
```

判断条件：

```text
fixed protocol
+ full outline
+ reserved output
+ safety margin
> context window
```

### 其他 mandatory 组合导致不可容纳

```text
CONTEXT_WINDOW_EXCEEDED
```

包括：

- Draft 正文过长；
- Review / Fact Check 报告过长；
- 固定协议过长；
- repair 指令和正文组合过长；
- 模型窗口过小；
- 输出预留过高。

禁止使用中文错误信息正则判断类别。

## 4.7 涉及文件

重点检查：

```text
src/services/pipeline/compileStageRequest.ts
src/services/pipeline/budgetAllocator.ts
src/services/pipelineMessages.ts
src/types/pipelineContext.ts
__tests__/pipelineSealBudget.test.ts
```

根据本地实际结构调整，不要求机械使用这些文件名。

---

# 5. 问题二：新任务启动触发 SQLite 外键 787

## 5.1 已确认的执行链路

当前流程近似如下：

```text
Chapter UI
→ createTask('chapter', chapter.id)
→ Zustand 内存加入任务
→ persistTask(task) 后台异步保存
→ createTask 立即返回 taskId
→ runChapterPipeline(taskId, chapter)
→ reconcilePipelineTask()
→ ensurePendingCheckpoints(taskId)
→ INSERT pipeline_stage_checkpoints
```

Schema 39 定义：

```sql
FOREIGN KEY (task_id)
REFERENCES pipeline_tasks(id)
ON DELETE CASCADE
```

当 `pipeline_tasks` 父记录尚未完成写入时，`ensurePendingCheckpoints()` 插入子记录会触发：

```text
SQLITE_CONSTRAINT_FOREIGNKEY
code 787
```

这是一个确定的父子记录竞态。

## 5.2 另一个关联风险：INSERT OR REPLACE

当前 `savePipelineTask()` 使用类似：

```sql
INSERT OR REPLACE INTO pipeline_tasks (...)
```

SQLite 的 `REPLACE` 语义不是普通 UPDATE。

冲突时它可能：

```text
DELETE 原有父记录
→ INSERT 新父记录
```

由于 checkpoint 外键使用：

```text
ON DELETE CASCADE
```

保存任务状态时可能删除所有已有 checkpoint。

因此本轮必须同时修复：

```text
父记录首次创建的时序
父记录后续更新的 SQL 语义
```

不能只给 `createTask()` 增加等待而保留 `INSERT OR REPLACE`。

---

# 6. 数据库正确模型

## 6.1 新任务必须原子创建

推荐新增 Repository 方法：

```ts
async function createPipelineTaskWithCheckpoints(
  task: NewPipelineTaskRecord,
  stages: PipelineCheckpointStage[],
): Promise<void>
```

事务内部执行：

```sql
BEGIN;

INSERT INTO pipeline_tasks (...);

INSERT INTO pipeline_stage_checkpoints (
  task_id,
  stage,
  status,
  attempt_count,
  updated_at
)
VALUES (?, 'draft', 'pending', 0, ?);

INSERT INTO pipeline_stage_checkpoints (... 'review' ...);
INSERT INTO pipeline_stage_checkpoints (... 'factCheck' ...);
INSERT INTO pipeline_stage_checkpoints (... 'proof' ...);

COMMIT;
```

任何一步失败：

```sql
ROLLBACK;
```

必须保证：

```text
不存在只有父任务没有 checkpoint 的半成品
不存在只有 checkpoint 没有父任务的非法状态
```

`ensurePendingCheckpoints()` 可以保留作为旧任务修复或幂等校验，但不应再承担新任务首次父子创建。

## 6.2 createTask 改为异步

当前接口：

```ts
createTask(
  targetType: 'chapter' | 'freeform',
  targetId: number,
): string
```

改为：

```ts
createTask(
  targetType: 'chapter' | 'freeform',
  targetId: number,
): Promise<string>
```

推荐顺序：

```ts
const task = buildNewTask(targetType, targetId);

await db.createPipelineTaskWithCheckpoints(task, [
  'draft',
  'review',
  'factCheck',
  'proof',
]);

set(state => ({
  tasks: [...state.tasks, task],
}));

return task.id;
```

数据库失败时：

```text
不加入 Zustand
不返回 taskId
不启动 foreground service
不调用 reconcile
不调用 LLM
```

如为了 UI 反馈需要先显示“正在创建”，应使用独立的临时 UI 状态，不得把未落库任务加入正式 Pipeline Store。

## 6.3 所有调用点必须 await

章节模式：

```ts
const taskId = await createTask('chapter', chapter.id);
await runChapterPipeline(taskId, chapter, ...);
```

自由写作模式：

```ts
const taskId = await createTask('freeform', projectId);
await runFreeformPipeline(taskId, projectId, documentText, steerText, ...);
```

需要全仓搜索：

```text
createTask(
runChapterPipeline(
runFreeformPipeline(
```

不要只修改章节编辑器中的一个调用点。

重点文件可能包括：

```text
src/screens/chapter-editor/hooks/useChapterPipeline.ts
src/screens/...freeform...
src/store/pipelineTaskStore.ts
src/services/pipelineRunner.ts
```

以本地搜索结果为准。

## 6.4 savePipelineTask 改为真正 UPSERT

禁止继续使用：

```sql
INSERT OR REPLACE
```

改为：

```sql
INSERT INTO pipeline_tasks (
  id,
  target_type,
  target_id,
  status,
  stage_results,
  final_text,
  error,
  input_fingerprint,
  pipeline_context_json,
  pipeline_context_version,
  pipeline_context_hash,
  created_at,
  updated_at,
  resolved_at,
  resolved_action
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  target_type = excluded.target_type,
  target_id = excluded.target_id,
  status = excluded.status,
  stage_results = excluded.stage_results,
  final_text = excluded.final_text,
  error = excluded.error,
  input_fingerprint = excluded.input_fingerprint,
  pipeline_context_json = excluded.pipeline_context_json,
  pipeline_context_version = excluded.pipeline_context_version,
  pipeline_context_hash = excluded.pipeline_context_hash,
  updated_at = excluded.updated_at,
  resolved_at = excluded.resolved_at,
  resolved_action = excluded.resolved_action;
```

通常不建议更新：

```text
created_at
id
```

除非本地已有明确兼容需求。

## 6.5 数据库层额外防线

在 `ensurePendingCheckpoints()` 和 `claimStageCheckpoint()` 前可以增加父任务存在检查，但它只能作为诊断防线，不是主修复。

示例：

```ts
const parent = await getPipelineTaskById(taskId);

if (!parent) {
  throw new PipelineDatabaseError(
    'PIPELINE_TASK_NOT_PERSISTED',
    `父任务 ${taskId} 尚未持久化，禁止创建阶段 checkpoint`,
  );
}
```

禁止在父任务不存在时自动临时插入一个字段不完整的父任务。

## 6.6 状态机启动规则

`runChapterPipeline()` / `runFreeformPipeline()` 接收的 taskId 必须已经满足：

```text
pipeline_tasks 中存在父记录
四个 pending checkpoint 已存在
事务已提交
```

因此状态机开头的：

```ts
ensurePendingCheckpoints(...)
```

可以改成：

```text
验证 checkpoint 完整
缺失时按兼容策略补齐
数据库异常 fail-closed
```

新任务正常路径不应依赖它完成首次建表数据。

---

# 7. 两项修复之间的统一不变量

本轮两组问题看似独立，实际遵循同一原则：

```text
进入下一阶段前，前置状态必须完整且持久化
```

消息编译器：

```text
optional 分配完成
→ 最终消息通过窗口检查
→ 才能调用模型
```

任务数据库：

```text
父任务与 checkpoint 事务提交
→ 才能启动 reconcile
→ 才能调用模型
```

统一要求：

```text
任何“准备阶段”失败
→ LLM 调用次数必须为 0
```

---

# 8. 推荐施工顺序

## 阶段 1：建立失败复现测试

先编写两个失败测试：

```text
A. final assembly 轻微超窗时完整大纲或 Draft 被切断
B. createTask 后立即 reconcile 触发外键 787
```

测试必须先在当前代码上失败。

## 阶段 2：修复 pipeline_tasks 更新语义

先将：

```text
INSERT OR REPLACE
```

改成：

```text
INSERT ... ON CONFLICT(id) DO UPDATE
```

增加测试证明：

```text
已有 checkpoint 时多次保存 pipeline_tasks
checkpoint 行数和内容保持不变
```

这一步必须先完成，否则后续事务创建的 checkpoint 仍可能被父任务更新误删。

## 阶段 3：实现父子事务创建

新增：

```ts
createPipelineTaskWithCheckpoints(...)
```

使用真实 SQLite 事务。

要求：

```text
父任务插入失败 → 0 条 checkpoint
任意 checkpoint 插入失败 → 父任务回滚
事务提交后父任务和四条 checkpoint 同时可见
```

## 阶段 4：createTask 与调用点异步化

改造 Store 接口并全仓修正调用点：

```text
createTask(): Promise<string>
await createTask(...)
```

同步更新相关 TypeScript 类型和测试 Mock。

## 阶段 5：修复 final message 收缩

删除对完整 `system` / `user` message 的最终兜底裁剪。

改成：

```text
缩减 optional allocation
→ 重建 messages
→ 重新估算
```

保留最大循环次数，避免死循环。

## 阶段 6：完整回归

运行：

```text
相关 Jest
完整 Jest
TypeScript
Lint
Android debug
Android release
真实设备或模拟器启动 Pipeline
```

---

# 9. 测试矩阵

## 9.1 真实 SQLite 外键测试

测试环境必须：

```sql
PRAGMA foreign_keys = ON;
```

### Case 1：新章节任务立即启动

```text
创建 chapter task
不等待任何人工延时
立即读取父任务和 checkpoint
立即启动 reconcile
```

断言：

```text
不报 787
父任务存在
draft/review/factCheck/proof 四条 pending checkpoint 存在
```

### Case 2：自由写作任务立即启动

断言与章节模式相同。

### Case 3：重复保存父任务

```text
创建任务和 checkpoint
保存 drafting
保存 reviewing
保存 failed/completed
```

每次断言：

```text
checkpoint 数量不变
checkpoint 内容不被删除
```

### Case 4：父任务插入失败

注入错误：

```text
pipeline_tasks INSERT 抛错
```

断言：

```text
checkpoint 数量 = 0
Zustand 不存在该任务
reconcile 调用次数 = 0
LLM 调用次数 = 0
```

### Case 5：第二条 checkpoint 插入失败

事务中让 `review` checkpoint 插入失败。

断言：

```text
父任务不存在
所有 checkpoint 均不存在
LLM 调用次数 = 0
```

### Case 6：并发创建

并发启动两个不同任务：

```text
两个父任务和各自 checkpoint 完整
互不覆盖
```

同一目标的重复点击仍由现有 UI/Store 活跃任务检查阻止。

## 9.2 消息完整性测试

### Case 7：Review 标签开销轻微超窗

构造：

```text
完整大纲
完整 Draft
大量 optional preset/worldbook
窗口只比初次组装少几十 token
```

断言：

```text
compiled.ready === true
完整大纲逐字存在
完整 Draft 逐字存在
系统协议逐字存在
只有 optional section 缩短
```

### Case 8：Proof 标签开销轻微超窗

断言：

```text
完整 Draft 存在
必需 Review 报告存在
必需 Fact Check 报告存在
完整大纲存在
optional constraints 被缩短
```

### Case 9：mandatory 确实无法容纳

断言：

```text
compiled.ready === false
模型调用次数 = 0
```

### Case 10：完整大纲自身过大

断言：

```text
error.code === OUTLINE_TOO_LARGE
```

### Case 11：正文导致超窗

断言：

```text
error.code === CONTEXT_WINDOW_EXCEEDED
```

### Case 12：repair 路径

Review repair、Fact Check repair 都必须断言：

```text
repair instruction 未被裁剪
必需正文未被裁剪
optional 资料可缩短
```

---

# 10. UI 错误处理

数据库错误不应直接把英文 SQLite 原始错误展示给普通用户。

应映射为：

```text
标题：无法启动流水线

内容：
写作任务未能保存到本地数据库，因此没有调用模型。
请重试；如仍然失败，请重新打开应用后检查数据库状态。
```

诊断日志保留：

```text
code = PIPELINE_TASK_CREATE_FAILED
sqliteCode = 787
taskId
targetType
targetId
schemaVersion
```

禁止把错误描述成：

```text
大纲导入失败
模型请求失败
API 配置错误
```

因为实际失败发生在模型调用之前。

---

# 11. 兼容性处理

## 11.1 已存在的失败任务

修复后，旧的 `failed` 任务不应自动恢复。

用户可以：

```text
移除失败任务
重新开始生成
```

不得为缺少 checkpoint 或父记录的旧任务静默补造成功状态。

## 11.2 旧 Schema 任务

Schema 39 迁移继续保留。

父子事务创建只影响新任务，不需要改变历史 backfill 语义。

## 11.3 Store Mock

测试 Mock 必须同步改成异步：

```ts
createTask: jest.fn(async (...) => taskId)
```

禁止为了少改测试而保留一个生产同步入口。

---

# 12. 完成定义

以下全部成立才算完成。

## 消息编译封口

- `finalizeCompiled()` 不再裁剪整条 system/user message；
- 最终超窗只回收 optional allocations；
- 每次 allocation 改变后重新构建 messages；
- 完整大纲不被裁剪；
- 阶段必需正文不被裁剪；
- 系统协议不被裁剪；
- repair 指令不被裁剪；
- Ready/Blocked 门禁继续有效；
- 任何 Blocked 请求的 LLM 调用次数为 0。

## 外键 787 封口

- `createTask()` 返回 `Promise<string>`；
- 所有调用点都 `await createTask()`；
- 新任务通过一个事务创建父任务和 checkpoint；
- 事务提交后才能启动 Pipeline；
- `savePipelineTask()` 不再使用 `INSERT OR REPLACE`；
- 更新父任务不会删除 checkpoint；
- 父任务创建失败时 Store 不出现幽灵任务；
- 事务失败时不启动 reconcile；
- 数据库失败时 LLM 调用次数为 0；
- 章节模式和自由写作模式均通过真实 SQLite 测试；
- `PRAGMA foreign_keys = ON` 下不再出现 787。

---

# 13. Agent 施工指令

请在本地仓库：

```text
D:\AiWorkSpace\tavo-mini
```

完成本文件规定的两组修复。

开工前记录：

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git log -1 --oneline --decorate
```

先搜索：

```bash
rg "INSERT OR REPLACE INTO pipeline_tasks"
rg "createTask\("
rg "runChapterPipeline\("
rg "runFreeformPipeline\("
rg "ensurePendingCheckpoints"
rg "clipTextToTokenBudget" src/services/pipeline
rg "finalizeCompiled"
```

施工原则：

```text
只修消息 optional-only 收缩
只修父任务/checkpoint 原子创建
不扩张 Pipeline 架构
不复制新 Runner
不关闭外键
不使用 sleep
不保留 INSERT OR REPLACE
```

测试必须包含真实 SQLite 外键测试，不得仅使用 Map 模拟 checkpoint。

---

# 14. 最终报告模板

完成后输出：

## Git 状态

```text
起始分支
起始 HEAD
结束 HEAD
开工前 git status
完工后 git status
```

## 修改摘要

```text
消息编译器如何只收缩 optional
父子任务事务如何实现
createTask 调用点如何异步化
savePipelineTask UPSERT SQL
错误映射方式
```

## 修改文件

```text
逐项列出文件和改动目的
```

## 测试

```text
消息完整性单测
真实 SQLite 外键测试
章节任务启动测试
自由写作任务启动测试
重复父任务保存测试
事务回滚测试
完整 Jest
TypeScript
Lint
Android debug
Android release
真实设备验证
```

未执行项必须说明原因，不得写“应该通过”。

## 数据库验证结果

```text
foreign_keys 是否开启
任务创建后父记录数量
checkpoint 数量
重复 savePipelineTask 后 checkpoint 数量
故障注入后的回滚结果
```

## 提交信息

```text
提交 SHA
是否推送
是否创建 PR
是否混入用户原有修改
```

---

# 15. 收口结论

本轮完成后，Pipeline 专项应进入正常使用阶段，不再继续以静态审计方式无限扩展。

后续只有在真实使用中出现明确可复现问题时，才按以下分类处理：

```text
数据库原子性
状态机幂等性
冻结数据一致性
请求预算与消息完整性
具体业务功能缺陷
```

不得重新回到“发现一个现象就增加一条特殊分支”的修复方式。
