# TAVO-MINI Phase 2 — Phase 2 验收报告（Pipeline Topology Version + Resume Contract）

- **日期：** 2026-08-19
- **施工基线：** `E:\AiWorkSpace\tavo-mini`（唯一基线）
- **对应方案章节：** `docs/optimization/TAVO-MINI_第二期_Standard-Pipeline深度收束与流水线提速总方案_V1.0.md` §5
- **Commit：** `feat(writing): freeze compact-standard pipeline topology for new tasks`

---

## 1. PLAN — 基线 / 根因 / 影响边界

### 1.1 Baseline（Before）

- `pipeline_tasks` / `multi_chapter_batches` 已冻结 `outline_workflow_version` / `context_budget_version` /（批次）`execution_profile`（Schema 54）。
- Writing Kernel freeze 的 `stagePolicy.values` 只有 `contextBudgetVersion` + `outlineStageReasoning`，**没有** topology 冻结标记。
- Resume gate（`pipelineRunner.ts` + `outlineStageDriver.ts`）用 **live 常量** `CURRENT_OUTLINE_WORKFLOW_VERSION(4)` 拒绝 owv≠4；旧任务一律 `LEGACY_PIPELINE_RESUME_BLOCKED`。
- Phase 1 的 `finalCandidateModeForPolicy` 已读 `values.pipelineTopologyVersion==='compact_standard'`，但生产无人写入。

### 1.2 Root Cause

缺少**每 task / 每 batch 冻结一次**的 `pipeline_topology_version` 持久标记。若后续 Phase 3/4 删除 Proof / 合并 QA 改变 DAG，将没有 durable 依据区分「历史 legacy 任务」与「新 compact 任务」；Resume 决策会依赖 live default，旧任务存在被新 DAG 接管的漂移风险。

### 1.3 Impact Boundary

- 新增持久列 + 创建期冻结 + kernel `stagePolicy.values` 标签 + Resume gate 读冻结值。
- **Phase 2 不改变任何 DAG**：compact 任务仍跑既有 stage（proof 仍在 DAG，Phase 3 才移除）。
- 不新增 LLM Stage；不引入第二套 Writer/QA/Context。
- 不做任何场景拆分（Outline/Continuation 仍走同一 Kernel）。
- Continuation run 行级 topology 冻结不在本期（batch 头已冻结；run 级留给 Phase 4/7）——已记录为边界。

### 1.4 Red Tests（方案 §5.6 Case 1–5 + 冻结标签联动）

| Case | 断言 |
|---|---|
| C1 | legacy 任务（topology=1, owv=3, cbv=5）proof interrupted → resume **只**跑 `run_proof`（draft/review/factCheck/brief 不再派发）；proof failed → `blocked(STAGE_FAILED, retry proof)` |
| C2 | compact 任务（topology=2）draft+QA 槽位 succeeded 后 crash → resume 不重跑 draft/review（QA）；全审计成功、proof interrupted → 只 `run_proof`（durable semantics fixture） |
| C3 | 新 batch 创建冻结 compact(2)；legacy batch(1) 读回保持 1；子章继承 batch（reconcile 已接） |
| C4 | 迁移：旧行默认 1（legacy_standard）；v54→v55 幂等；fresh DDL 自带列；显式 2 保真 |
| C5 | 冻结值损坏（99）→ `PIPELINE_TOPOLOGY_CORRUPT` fail-closed，不猜默认 |
| +1 | kernel 冻结标签 `'compact_standard'` → `finalCandidateModeForPolicy` 走 compact（proof 排除）；`'legacy_standard'` → legacy |

### 1.5 Expected Call Graph（Phase 2 保持不变）

```
New compact task（冻结 topology=2，Phase 2 仍走旧 stage）:
  draft → review → factCheck → revision(brief) → proof → [finalValidate → persist]
Legacy task resume（冻结 topology=1）:
  按冻结旧 topology 继续，绝不被 compact 接管
One-Shot（executionProfile=one_shot，不变）:
  draft → [finalValidate → persist]
```

---

## 2. DO — 施工内容（最小改动）

**新增冻结模型**
- `src/services/pipeline/outlineWorkflowVersion.ts`：`PipelineTopologyVersion = 1|2`、`LEGACY/COMPACT/CURRENT_PIPELINE_TOPOLOGY_VERSION`、`pipelineTopologyLabel()`、`normalizePersistedPipelineTopologyVersion()`（损坏→null）、`checkPipelineResumeContract()`（单一 resume 门禁：topology 合法 + cbv 可续）。

**Schema 55（幂等迁移 + fresh DDL + manifest）**
- 🆕 `src/services/migrations/v54-to-v55.ts`：给 `pipeline_tasks` + `multi_chapter_batches` 加 `pipeline_topology_version INTEGER NOT NULL DEFAULT 1`；`tableColumns` 空集（表不存在）跳过，幂等。
- `src/services/migrations/index.ts`：`SCHEMA_VERSION=55` + 54→55 逻辑迁移。
- `src/data/schema/createCurrentSchema.ts`：`pipeline_tasks` 内联列 + `buildSchema55CreateSqls()`（仅 `multi_chapter_batches` ALTER，避免重复列）。
- `src/services/database/schemaManifest.ts`：两表 backup 列清单补 `pipeline_topology_version`（Backup/manifest 同步）。

**Task / Batch 冻结一次 + 子章继承**
- `src/store/pipelineTaskStore.ts` `createTask`：`pipelineTopologyVersion` 默认 legacy(1)；`loadFromDB` / `persistTask` / 5 处 reducer 快照全部带上（防 Freeze Drift）。
- `src/screens/chapter-editor/hooks/useChapterPipeline.ts` + `src/screens/PipelineTaskScreen.tsx`（按新版重新生成）：新 Standard outline 任务冻结 `COMPACT_PIPELINE_TOPOLOGY_VERSION`(2)。
- `src/data/repositories/multiChapterBatchRepository.ts` + `src/store/multiChapterBatchStore.ts`：batch 创建冻结 compact(2)；行映射 + `createBatch` INSERT 带列。
- `src/services/multiChapterBatch/reconcileMultiChapterBatch.ts`：子章任务继承 `batch.pipelineTopologyVersion`（旧 batch 默认 1 → 子章 legacy）。
- `src/services/pipeline/derivedFinalRewrite.ts`：派生终稿子任务继承父任务 topology。

**Kernel freeze 标签（post-Freeze 只读冻结值）**
- `src/services/writing/execution/outlineStageDriver.ts` + `src/services/pipeline/outlineStageRuntime.ts` 两处 freeze：`values.pipelineTopologyVersion = pipelineTopologyLabel(task.pipelineTopologyVersion)`。
- `src/services/pipeline/taskView.ts` + `types.ts`：`PersistedPipelineTaskView` 带 `pipelineTopologyVersion`（决策函数读冻结值，不读 live default）。

**Resume gate（方案 §5.5 硬要求：Legacy Resume = PASS，不被 compact 接管）**
- `pipelineRunner.ts` + `outlineStageDriver.ts` 两处 gate：改为 `checkPipelineResumeContract`——只检查**冻结契约**：
  - 冻结 topology 损坏 → `PIPELINE_TOPOLOGY_CORRUPT`（fail-closed，不猜默认）；
  - cbv 非可续（1–4）→ 保持 `LEGACY_PIPELINE_RESUME_BLOCKED`；
  - **移除对 live `CURRENT_OUTLINE_WORKFLOW_VERSION` 的比较**：cbv 可续的 legacy 任务现在可按**冻结旧 topology** resume（Engine 本就有历史 envelope 兼容适配 + owv1/2/3 决策分支），绝不被 compact 接管。

**Red Test**
- 🆕 `__tests__/pipelineTopologyContract.test.ts`（21 用例，覆盖 §5.6 Case 1–5 + 标签联动）。
- 修正既有版本 pin：`continuationBatchSchema.test.ts` / `migrations-schema40-to-43-chain.test.ts` 的 `SCHEMA_VERSION` 54→55；两个 batch fixture 补 `pipelineTopologyVersion`。

---

## 3. CHECK — 验证

### 3.1 Focused Tests

- `pipelineTopologyContract.test.ts`：**21/21 PASS**。
- 相关回归：`pipelineRunner` / `continuationBatchSchema` / `migrations-v43-v44` / `migrations-v46-v47` / `migrations-schema40-to-43-chain` / `writingFinalCandidateContract` 全 PASS。

### 3.2 Architecture Gates（方案 §5.7）

| Gate | 证据 |
|---|---|
| Topology frozen per task = YES | `createTask` 冻结 + DB 列 + kernel values 标签（Red Test C3/C4） |
| Topology frozen per batch = YES | `createBatch` 冻结 compact(2)，legacy(1) 保真（C3） |
| Legacy Resume = PASS | `checkPipelineResumeContract` 放行 legacy+cbv 可续；决策层 `run_proof`（C1） |
| New topology durable contract = PASS | compact 任务 succeeded 阶段不被重跑（C2） |
| Resume Duplicate Paid Call = 0 | C1/C2：succeeded 阶段一律不重派发 |
| Freeze Drift = 0 | 创建期一次冻结；store 全快照带列；resume 读冻结值 |
| No live topology read post-Freeze | 决策/门禁只读 `task.pipelineTopologyVersion`；kernel 只读冻结 label |
| Migration idempotent | v54→v55 幂等（C4 + 全链路 Schema40→55） |
| Backup/manifest updated | `schemaManifest.ts` 两表列已补 |
| Migration = PASS | 真实 sql.js 升级链 Schema40→55 全过 |
| Android upgrade install | 迁移链测试 + Android Debug 构建（真机升级留 Phase 7 终封） |

### 3.3 Full Regression

- `npm run verify`（lint + typecheck + verify:version + Jest CI）全绿：**476 suites passed（4 skipped），3707 tests passed（9 skipped），0 failed**，exit code 0。
- 相比 Phase 1（475 suites / 3686 tests）新增 1 suite / 21 tests（Phase 2 Red Test）。

### 3.4 Android Debug

- `npm run apk:debug` 干净重建：**BUILD SUCCESSFUL**，输出 `dist/apk/debug/ShineWriter-V2.11.53-debug.apk`（56.55 MB），EXIT=0。

---

## 4. ACT — GO / NO-GO

| GO Gate（方案 §5.7） | 结果 |
|---|---|
| Topology frozen per task = YES | ✅ |
| Topology frozen per batch = YES | ✅ |
| Legacy Resume = PASS | ✅（冻结契约门禁 + 决策层按旧 topology） |
| New topology durable contract = PASS | ✅ |
| Resume Duplicate Paid Call = 0 | ✅ |
| Freeze Drift = 0 | ✅ |
| No live topology read post-Freeze | ✅ |
| Migration idempotent | ✅ |
| Backup/manifest updated if schema changed | ✅ |
| Full Jest = PASS | ✅ 476 suites / 3707 tests |
| Migration = PASS | ✅ 全链路 Schema40→55 |
| Android upgrade install = PASS | ✅ 迁移链测试 + Android Debug 构建（真机升级留 Phase 7） |

## 结论：PHASE 2 GO ✅

Phase 2 封板，允许进入 Phase 3（Proof 从 compact Standard DAG 删除）。

---

## 5. 附：设计说明与边界

### 5.1 Resume gate 变更说明（方案 §5 硬要求）

- 原 gate 用 live `CURRENT_OUTLINE_WORKFLOW_VERSION` 拒绝 owv≠4，违反「Resume 不重读 live default」。
- 现改为 `checkPipelineResumeContract`：只查**冻结契约**（topology 合法 + cbv 可续 5/6/7）。cbv 1–4（不兼容预算协议）仍 `LEGACY_PIPELINE_RESUME_BLOCKED`（现有两条 legacy 测试：owv3/cbv4、owv4/cbv4 依旧被拒，未破坏）。cbv 可续的 legacy 任务按冻结旧 topology 继续——Engine 本就有历史 envelope 兼容适配与 owv1/2/3 决策分支，且在冻结上下文不可解析时仍 fail-closed。
- 红线上「历史 Frozen Task 不被 Compact Standard 接管」通过两重保证满足：①所有 pre-Schema-55 行迁移默认 `pipeline_topology_version=1`（legacy）；②Resume 决策读取冻结 topology，绝不读 `CURRENT_PIPELINE_TOPOLOGY_VERSION`。

### 5.2 过渡期行为（一次只改一个变量）

- Phase 2 新任务冻结 compact(2) 但仍跑 proof（DAG 未变）。此时 kernel `stagePolicy.values.pipelineTopologyVersion='compact_standard'` → Phase 1 的 compact Final Candidate 生效：**proof 不再作为最终正文候选**（最终正文 = revision 或 draft）。这是 Phase 1 合同的设计意图，proof 的付费冗余调用在 Phase 3 移除。

### 5.3 边界

- Continuation run（`generation_runs`）级 topology 冻结不在本期；continuation batch 头已冻结 compact。run 级接线留 Phase 4（QA 合并）/ Phase 7（真实穿测）。
- UI 层 legacy 判定（`isRecoverable` / `isLegacyIncomplete` / stage label）仍按 owv 判定，属 Phase 6 全链路 UI/Ledger 收束范围，本期不动。
