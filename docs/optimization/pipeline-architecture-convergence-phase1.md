# Pipeline 架构收敛 — 阶段 1

> 状态：阶段 1（仅模型与决策函数，**不改 Runner 业务行为**）  
> 基线：`main` @ `8b752a4`，Schema **38**  
> 目标：把“发现一个问题打一个补丁”收敛为统一不变量 + 状态机 + 持久化边界

---

## 1. 五个系统不变量（目标态）

| # | 不变量 | 含义 |
|---|---|---|
| 1 | SQLite 唯一事实源 | 任务/阶段/冻结配置/上下文/终稿：先写库 → await 成功 → 再更新内存 → 再下一步 |
| 2 | 单一持久化状态机 | 首次运行与恢复共用 `reconcilePipelineTask`；禁止双路径一路执行到底 |
| 3 | 阶段幂等 | 每 `(taskId, stage)` 唯一有效 checkpoint；`succeeded` 绝不重调模型 |
| 4 | 运行环境冻结 | mode / 预设正文 / maxTokens / 模型身份指纹 在启动时冻结；Resume 禁止读 live 配置替换 |
| 5 | 统一请求编译 | 全部阶段 + Preview 走同一 `compilePipelineStageRequest` |

---

## 2. 当前状态机（as-is）

### 2.1 任务级状态

```text
idle → queued? → drafting → reviewing | factChecking → proofing
  → completed | failed | cancelled | interrupted
```

实现位置：`src/types/pipeline.ts` 的 `PipelineTaskStatus`；转换散落在 `pipelineTaskStore` + `pipelineRunner`。

### 2.2 两条执行路径（问题核心）

```text
runChapterPipeline
  └─ runChapterPipelineInner
       ├─ 读 live getPipelineConfig / getActiveLLM
       ├─ buildExecutionSnapshot（内存）
       ├─ compileDraft → await persistTaskPipelineContext
       ├─ callLLM draft → store.updateTaskStage（fire-and-forget 写库）
       ├─ full: post-draft retrieval → await persist auditContext
       └─ 按 mode 分支：noReview / twoStage / conditional / full
            一路 if 到底，依赖内存变量

resumePipeline
  └─ resumePipelineInner
       ├─ 从 Zustand task.stageResults 用 .find() 猜已完成阶段
       ├─ 无 draft success → 回落到 runChapterPipelineInner（重新读 live 配置）
       ├─ 有 V2 execution → 用冻结配置；V1 → live 配置
       ├─ full 缺 auditContext → 可能重建 post-draft（读 live 资料风险）
       └─ 按 mode 再写一整套 if 分支
            ⚠ proof 成功后若任务未 complete，仍会再次进入 runProofStage
```

### 2.3 阶段结果模型（as-is）

```text
pipeline_tasks.stage_results  TEXT JSON 数组
  → 每次 updateTaskStage 追加一条
  → 同一 stage 可出现多次（success/failed/skipped 混杂）
  → UI / resume 用 .find(stage === X && status === success)
```

没有：

- 每阶段唯一行约束
- CAS 认领
- `running` / `interrupted` 阶段态
- 与任务状态同步的原子事务

### 2.4 持久化边界（as-is）

| 数据 | 写入路径 | 是否 await | 问题 |
|---|---|---|---|
| 任务行（status/stage_results/final_text） | `persistTask` 链式 fire-and-forget | 否 | 状态机不等待落盘 |
| 冻结上下文 envelope V2 | `persistTaskPipelineContext` → `updatePipelineTaskContext` | **是**（关键路径已修） | 仅上下文字段；与 stage 结果不同步 |
| Draft 文本进 stage_results | fire-and-forget | 否 | 进程可在 LLM 成功后、落盘前死亡 |
| 终稿 final_text + complete | fire-and-forget | 否 | complete 与 final_text 可丢一边 |
| 执行配置 | 塞进 envelope.execution JSON | 随上下文 | 无独立列/哈希；V1 任务无 execution |
| Audit context | 同上 envelope | await | full 恢复缺 audit 时可能 live 重建 |

### 2.5 当前四模式拓扑（逻辑正确，实现重复）

```text
noReview:     Draft ──► finalize_from_draft
twoStage:     Draft ──► Review ──► Proof ──► finalize
conditional:  Draft ──► FactCheck ──► Proof ──► finalize
full:         Draft ──► AuditContext ──► (Review ∥ FactCheck) ──► Proof ──► finalize
```

降级（审核全失败 / Proof 失败）：保留 draft 为 final_text，任务 `failed`（非 `completed`）。

### 2.6 与目标不变量的差距（架构级，非缺陷清单）

1. **数据源不唯一**：Zustand 常先于 SQLite 成为决策输入（尤其 resume）。
2. **状态转换不原子**：无 stage CAS；双点继续 / 前后台并发无 DB 层互斥。
3. **阶段不幂等**：数组追加 + find；Proof 成功后 resume 可重跑 Proof。
4. **冻结不完整**：V1 无 execution；full audit 恢复可 live 重建；API URL 指纹未冻结。
5. **请求编译不统一**：仅 Draft 有 `compileDraftPipelineRequest`；Review/FC/Proof/Preview 另拼。
6. **预算不守恒**：多套比例叠加（大纲/Story/资源/窗口/Episodic）。

---

## 3. 目标状态机（to-be）

### 3.1 唯一入口

```text
runChapterPipeline(taskId)  ──┐
resumePipeline(taskId)      ──┼──►  reconcilePipelineTask(taskId)
cold-start 仅 mark interrupted ─┘         │
                                           ▼
                              loop:
                                1. SELECT task + checkpoints FROM SQLite
                                2. action = determineNextPipelineAction(...)
                                3. CAS claim if action needs execution
                                4. execute action
                                5. await persist result
                                6. continue until terminal / blocked / need user
```

冷启动**只**做：

```text
running stages → interrupted
active task status → interrupted（可恢复）或 failed（不可恢复）
```

**不**自动调模型。

### 3.2 决策纯函数（本阶段已落地）

```ts
determineNextPipelineAction(task, stages): PipelineAction
```

路径：`src/services/pipeline/determineNextPipelineAction.ts`  
测试：`__tests__/determineNextPipelineAction.test.ts`

动作集合：

```text
persist_initial_snapshot
run_draft
build_audit_context
run_review | run_fact_check | run_review_and_fact_check
run_proof
finalize_from_draft | finalize_from_proof
complete
blocked { code, message, ... }
```

### 3.3 阶段 checkpoint 目标表

```sql
-- 阶段 2 引入（本阶段仅类型 + 决策语义）
CREATE TABLE pipeline_stage_checkpoints (
  task_id TEXT NOT NULL,
  stage TEXT NOT NULL,          -- draft|review|factCheck|proof|finalize
  status TEXT NOT NULL,         -- pending|running|succeeded|failed|skipped|interrupted
  output_text TEXT,
  error_code TEXT,
  error_message TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  duration_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, stage)
);
```

CAS 认领：

```sql
UPDATE pipeline_stage_checkpoints
SET status = 'running', started_at = ?, attempt_count = attempt_count + 1, updated_at = ?
WHERE task_id = ? AND stage = ?
  AND status IN ('pending', 'interrupted');
-- rowsAffected === 1 才拥有执行权
```

可选历史表：`pipeline_stage_attempts`（不进主决策路径）。

### 3.4 任务表语义对齐（可复用现有列）

当前 `pipeline_tasks` 已有：

```text
id, target_type, target_id, status, stage_results, final_text, error,
input_fingerprint, pipeline_context_json/version/hash,
created_at, updated_at, resolved_at, resolved_action
```

目标语义映射：

| 目标字段 | 现有/计划 |
|---|---|
| execution_snapshot | envelope.execution（可后续拆列） |
| draft_context | envelope.draftContext |
| audit_context | envelope.auditContext |
| stage_results 数组 | **废弃为投影**；权威为 checkpoints 表 |
| final_text | 保留 |

阶段 2 迁移策略：`stage_results` 只读兼容 → 导入 checkpoints → 新写入只 upsert checkpoint。

---

## 4. 阶段转移图（目标决策表摘要）

### noReview

| 条件 | 动作 |
|---|---|
| 无 execution / draft context | `persist_initial_snapshot` |
| draft pending/interrupted | `run_draft` |
| draft failed | `blocked` |
| draft succeeded，无 final | `finalize_from_draft` |
| final 有、status≠completed | `complete` |
| completed | `blocked` TASK_TERMINAL |

### twoStage

| 条件 | 动作 |
|---|---|
| draft 未成功 | 同上 |
| review pending/interrupted | `run_review` |
| review failed | `finalize_from_draft`（降级） |
| review succeeded，proof pending | `run_proof` |
| proof succeeded，无 final | `finalize_from_proof` |
| proof failed | `finalize_from_draft`（降级） |
| **proof succeeded 且已有 final** | `complete`（**绝不** `run_proof`） |

### conditional

与 twoStage 对称，review ↔ factCheck。

### full

| 条件 | 动作 |
|---|---|
| draft 成功，无 auditContext | `build_audit_context` |
| audit 就绪，review+fc 均未决 | `run_review_and_fact_check` |
| 仅缺一侧 | `run_review` 或 `run_fact_check` |
| 两侧均 failed | `finalize_from_draft` |
| 至少一侧 succeeded，proof pending | `run_proof` |
| 其后同 twoStage | finalize / complete |

任一 stage `status === 'running'`（且非本执行器刚 CAS）：`blocked` `TASK_ALREADY_RUNNING`。

---

## 5. 恢复策略（目标）

```text
冷启动：running → interrupted；不跑模型
用户继续：reconcilePipelineTask
  succeeded 阶段：跳过
  interrupted/pending：CAS 后执行
  final_text 已在、未 complete：只 complete
  Proof succeeded：只 finalize/complete
  full 无 auditContext：
    推荐：Draft 前冻结 post-draft 候选集，恢复时只在候选内检索
    可接受：blocked TASK_NOT_RECOVERABLE（禁止 silent live 重建）
```

阶段 1 **不实现** reconcile，只把决策表锁死，防止后续双路径分叉。

---

## 6. 幂等与 CAS（目标）

```text
模型调用前：CAS pending|interrupted → running
模型成功后：await upsert succeeded + output_text
模型失败后：await upsert failed
进程死亡：冷启动 running → interrupted
重复点击：CAS 失败 → UI「任务已在运行」
```

---

## 7. 阶段 1 交付物

| 文件 | 作用 |
|---|---|
| 本文档 | as-is / to-be 状态机与持久化边界 |
| `src/services/pipeline/types.ts` | 目标类型（StageStatus / Action / Task 视图） |
| `src/services/pipeline/determineNextPipelineAction.ts` | 纯决策函数 |
| `src/services/pipeline/projectStageCheckpoints.ts` | 旧 `stageResults[]` → checkpoint 投影（兼容读） |
| `src/services/pipeline/index.ts` | barrel |
| `__tests__/determineNextPipelineAction.test.ts` | 决策表测试 |

**明确不做（阶段 1）：**

- 不改 `pipelineRunner.ts` 业务分支
- 不改 Schema / 迁移
- 不改 Store / UI
- 不接 `reconcilePipelineTask`

---

## 8. 后续阶段（提醒，不施工）

1. **阶段 2**：checkpoints 表 + 同步写库 + CAS + Store 投影  
2. **阶段 3**：`reconcilePipelineTask` 替换双 Inner  
3. **阶段 4**：统一编译器 + 守恒预算  
4. **阶段 5**：UI 派生 + 错误码  
5. **阶段 6**：故障注入矩阵

启发式：新问题先判断违反哪条不变量，修复抽象层，禁止在 3+ 调用点打补丁。
