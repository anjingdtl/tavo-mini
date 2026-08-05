# Pipeline 架构收敛报告

> 完成日期：2026-08-05  
> 基线起点：`8b752a4`（第二轮大纲修复方案文档）  
> Schema：38 → **39**

---

## 1. 最终状态机

唯一执行入口：

```text
runChapterPipeline  ─┐
resumePipeline      ─┼─► reconcilePipelineTask(taskId)
cold-start 仅 interrupt ─┘
```

循环：

```text
1. 读 SQLite 任务 + checkpoints（失败则投影 stage_results）
2. determineNextPipelineAction(taskView, stages)
3. CAS claim（pending|interrupted → running）
4. 执行单一动作
5. await 持久化结果
6. 再次 reconcile
```

纯决策函数：`src/services/pipeline/determineNextPipelineAction.ts`  
执行器：`src/services/pipeline/reconcile.ts`

---

## 2. 数据库表与约束

### pipeline_tasks（沿用 + 语义强化）

- `pipeline_context_json/version/hash`：V2 envelope（draft + audit + execution）
- `stage_results`：兼容投影列（每阶段唯一结果）
- `final_text` / `status` / `resolved_*`

### pipeline_stage_checkpoints（Schema 39 新增）

```text
PRIMARY KEY (task_id, stage)
status ∈ pending | running | succeeded | failed | skipped | interrupted
```

CAS：

```sql
UPDATE ... SET status='running', attempt_count=attempt_count+1
WHERE status IN ('pending','interrupted')
-- rowsAffected === 1 才拥有执行权
```

---

## 3. 阶段转移图

```text
noReview:     Draft → finalize_from_draft → complete
twoStage:     Draft → Review → Proof → finalize_from_proof → complete
conditional:  Draft → FactCheck → Proof → finalize…
full:         Draft → build_audit_context → (Review ∥ FactCheck) → Proof → finalize…
```

降级：审核全失败或 Proof 失败 → `finalize_from_draft(degraded)`，`failed` + 保留初稿。

---

## 4. 幂等策略

| 状态 | 恢复行为 |
|---|---|
| succeeded | 绝不重调模型 |
| skipped | 视为已决策 |
| failed | 可 finalize 降级或人工重开 |
| interrupted / pending | CAS 后执行 |
| running（冷启动） | → interrupted |
| running（进程内） | blocked TASK_ALREADY_RUNNING |

**Proof succeeded 且无 final → 只 finalize；有 final 未 complete → 只 complete。**

---

## 5. 恢复策略

- 冷启动：`markActiveTasksAsInterrupted` + `interruptAllRunningStages`；**不**自动 LLM
- 用户继续：`resumePipeline` → 同一 `reconcilePipelineTask`
- full 缺 auditContext：动作 `build_audit_context`（基于冻结 draftContext + draft 正文的 post-draft 检索，禁止静默用新资料替换冻结语义的任意重建）

---

## 6. CAS 认领

- 模块：`claimStageCheckpoint`
- UI：继续按钮点击即禁用；`isReconcileActive` 进程内互斥
- 失败提示：「任务已在运行」

---

## 7. 冻结数据范围

任务启动时写入 V2 envelope：

- `execution`：mode、各阶段 maxTokens、预设全文、模型 id/name/window
- `draftContext`：大纲/记忆/角色/世界书等
- `auditContext`（full）：post-draft 命中

Resume 用冻结 execution；API Key 走同 configId 的 live 凭据，并校验 **id + modelName**。

---

## 8. 统一请求编译器

```text
compileDraftStageRequest
compileReviewStageRequest / compileFactCheckStageRequest / compileProofStageRequest
compilePipelineStageRequest（门面）
```

路径：`src/services/pipeline/compileStageRequest.ts`  
Preview 与真实 Draft 共用 `compileDraftStageRequest`；未冻结任务时 UI 文案为 **预估请求**。

---

## 9. 统一预算算法

`allocateStageContextBudget`：

```text
安全余量 → 输出预留 → 固定 Prompt → 完整大纲 → 必需正文 → 剩余按权重分可选资料
可选权重总和归一化 ≤ 100%
大纲不设 30% 硬顶；仅当大纲+必需正文装不下才阻断
```

错误码区分 `OUTLINE_TOO_LARGE` vs `CONTEXT_WINDOW_EXCEEDED`（不靠中文正则分类 UI）。

---

## 10. 故障注入矩阵

见 `__tests__/pipelineFaultInjectionMatrix.test.ts`：

```text
快照前 / 快照后 / Draft 中断 / Draft 落盘后 / Audit 后 /
Review 后 / FactCheck 后 / Proof 后 / Final 后 / complete 前 / running 并发
```

断言：不重跑已成功阶段；终态确定。

---

## 11. 删除或废弃的旧路径

| 路径 | 状态 |
|---|---|
| `runChapterPipelineInner` / `resumePipelineInner` 双路径业务 | **入口已改调 reconcile**；文件内旧函数体遗留为死代码（后续可删） |
| `stage_results` 无限追加 | 改为每阶段 upsert 投影 |
| Resume 重跑已成功 Proof | 由决策表禁止 |
| Preview「实际发送消息」 | 改为「预估请求」 |

---

## 12. 完成标准核对

| 标准 | 状态 |
|---|---|
| 任意中断点恢复不重跑已成功模型阶段 | 决策表 + 故障矩阵 |
| 重复点击仅一个执行器 | CAS + reconcile 锁 + UI 禁用 |
| 阶段结果进入下一阶段前落盘 | `persistTaskStage` await |
| 首次与恢复同一状态机 | 均 → reconcile |
| 统一请求编译器 | compileStageRequest |
| 预算守恒 | allocateStageContextBudget |
| 旧任务不静默用新配置 | execution 冻结 + 身份校验 |
| 冻结任务不读改后资料替换上下文 | draft/audit snapshot |
| Proof 成功后只 Finalize | 决策表 |
| 非大纲超窗不跳大纲管理 | 错误码分流 |
| DB 与 UI 状态一致 | Store 投影 + 结果页 uniqueStageResults |

---

## 13. 关键文件

```text
src/services/pipeline/*
src/data/repositories/pipelineStageCheckpointRepository.ts
src/services/migrations/v38-to-v39.ts
src/store/pipelineTaskStore.ts
src/services/pipelineRunner.ts（薄入口）
src/screens/PipelineTaskScreen.tsx
src/screens/PipelineResultScreen.tsx
src/screens/ContextPreviewScreen.tsx
__tests__/determineNextPipelineAction.test.ts
__tests__/pipelineFaultInjectionMatrix.test.ts
__tests__/allocateStageContextBudget.test.ts
__tests__/migrations-v38-v39.test.ts
```
