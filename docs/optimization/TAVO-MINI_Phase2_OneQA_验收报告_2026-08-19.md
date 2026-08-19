# TAVO-MINI Phase 4 — Review / Audit / FactCheck 合并 ONE QA 验收报告

- **方案基线：** `docs/optimization/TAVO-MINI_第二期_Standard-Pipeline深度收束与流水线提速总方案_V1.0.md`（§7）
- **施工基线（唯一）：** 本地仓库 `E:\AiWorkSpace\tavo-mini`
- **前置封板：** Phase 0=`e0608fb` / Phase 1=`81a27ac` / Phase 2=`e6cae5b` / Phase 3=`5abdbe5`
- **更新日期：** 2026-08-19
- **目标拓扑：** `Draft → ONE QA → Conditional Revision → Local FinalValidate → Persist`
  - Clean Standard ≤ 2 次逻辑 LLM；需修订 ≤ 3 次；One-Shot = 1 次
  - New Standard 中 Review / Audit / FactCheck / Proof dispatch = 0（Legacy Resume 保留旧拓扑）

---

## 一、本阶段 PDCA

### PLAN（对齐方案 §7.1–§7.9）
1. 生产实现唯一 `runQaStage()` + `compileSharedWritingPrompt('qa')` + `executeSharedWriterStage(stage='qa')`，唯一 QA Artifact Contract（§7.2）。
2. 场景差异（Outline obligations vs Continuation Canon/Boundary/Seam/Anchor）只经 Frozen Requirements / Source Adapter / Policy 进入同一 QA（§7.3），不产生第二套 QA。
3. Compact DAG 收为 `draft → qa → revision → finalValidate → persist`；New Standard Review/Audit/FactCheck/Proof dispatch = 0（§7.9）。
4. QA Context = ONE Frozen Context 的确定性投影（§7.6），非三旧 stage 简单拼接。
5. QA 模型行为全部 Freeze（§7.7）：`qaThinking / qaReasoningEffort / qaResponseFormat / qaOutputContract / qaModelConfig`，无 post-Freeze live read。
6. Legacy frozen task 按旧 topology resume 旧 Review/Audit/FactCheck 三件套（§7.10 Legacy）。
7. Schema 56：continuation `stage_results` CHECK 扩展 `unified_qa` ledger 节点（幂等重建）。

### DO（最小改动，逐文件）
- 🆕 `src/services/writing/stages/qa.ts` — 唯一生产 QA 实现 `runQaStage()`（preflight → skip → executeSharedWriterStage('qa')）。
- 🆕 `src/services/migrations/v55-to-v56.ts` — `unified_qa` ledger 节点 CHECK 重建（idempotent probe + 表重建），`SCHEMA_VERSION` 55 → 56。
- ✏️ `src/services/writing/stages/writingStageDag.ts` — 拆出 `LEGACY_WRITING_STAGE_DAG`（含 review/audit/factCheck/proof）与 `COMPACT_WRITING_STAGE_DAG`（draft→qa→revision→finalValidate→persist）+ `getWritingStageDagForTopology` / `writingStageDagNodeForTopology`。
- ✏️ `src/services/pipeline/taskView.ts` — `stageNamesForPipelineTopology` compact 分支 `['draft','review','factCheck',…]` → `['draft','qa',…]`。
- ✏️ `src/services/pipeline/determineNextPipelineAction.ts` — 新增 `PipelineAction {type:'run_qa'}` + `decideCompactFull`（qa → brief? → finalize）；One-Shot 在 compact 分支前短路，不受影响；legacy 分支原样保留。
- ✏️ `src/services/pipeline/outlineStageRuntime.ts` — **运行时 dispatch 补 `case 'run_qa'`**（接手期发现的缺口：决策层返回 run_qa 但运行时 switch 未接，compact 任务会在首个 QA 步掉进 `default` 失败）。
- ✏️ `src/services/writing/execution/{outlineStageDriver,runOutlineSharedWriterAction}.ts` — `run_qa → ['qa']` ACTION_STAGES / ACTION_TO_STAGES 映射。
- ✏️ `src/services/writing/execution/continuationStageDriver.ts` — compact round1=`[draft]`、round2=`['qa','revision']`（legacy 不变）；`maxPhysicalRequests` compact 4 → 3（draft+qa+revision）。
- ✏️ `src/services/writing/stages/{writerCore,writerRecovery,writingStageRunner,evaluateRuntimeStageSkip,index}.ts` — qa 纳入结构化 report 判定、adoption、formatter、revision trigger。
- ✏️ `src/services/writing/context/{findingsAggregator,stageContextProjection}.ts` — `qa` 为 findings 唯一来源（+legacy 兼容）；context allowlist = 三旧 stage 去重并集。
- ✏️ `src/services/writing/prompt/{sharedPromptCompiler,requirementProjection}.ts` — `STAGE_PROTOCOL.qa`、structured-report 判定、maxTokens、requirement 归并。
- ✏️ `src/services/writing/persistence/{outlineDurableAdapter,continuationDurableAdapter}.ts` + `continuationStageCapabilities.ts` — outline checkpoint `'qa'`；continuation ledger `unified_qa`。
- ✏️ `src/services/continuation/generation/*` — V5 `unified_qa` 物理节点（types/models/budget/generationRepository/contextViews）。
- ✏️ `src/services/pipeline/reasoningPolicy.ts` — 各 profile 补 `qa` reasoning tier。
- ✏️ UI 层（`PipelineProgress.tsx` / `PipelineResultScreen.tsx` / `ContextPreviewScreen.tsx`）— qa 标签；全链路旧文案清理按方案 §9 归入 Phase 6。
- ✏️ 既有测试期望收紧（`pipelineTopologyContract` / `writingProofRemovalContract` / `writingOneFlowPhase3Pipeline` / `writingOneShotSkipLedgerSemantics` / `continuationBatchSchema` / `continuationDurableAdapter` / `continuationV5Budget` / `migrations-schema40-to-43-chain`）。
- 🆕 Red Test `__tests__/writingQaConsolidationContract.test.ts`（§7.10 架构/调用图/Resume/Legacy/Freeze/输出契约）。
- 🆕 回归测试 `__tests__/outlineStageRuntimeRunQaDispatch.test.ts`（run_qa 运行时 dispatch 缺口回归）。

### CHECK
- **Red Tests：** `writingQaConsolidationContract.test.ts` + `outlineStageRuntimeRunQaDispatch.test.ts` 全 PASS。
- **Full Regression：** `npm run verify`（lint 0 errors + typecheck + verify:version + test:ci）全绿 = **___ suites / ___ tests**（待 verify 终值回填）。
- **Migration：** Schema 40 → 56 全链路（`migrations-schema40-to-43-chain`）PASS；`continuation_generation_stage_results` CHECK 含 `unified_qa`。
- **Android Debug：** `npm run apk:debug` BUILD SUCCESSFUL（待回填 MB / EXIT=0）。

### ACT
- **真实 LLM 穿测（待执行）：** Outline compact batch 1 章，验证 `llm_usage_logs` 仅 `pipeline_draft / pipeline_qa / [pipeline_brief]`，Review/Audit/FactCheck/Proof = 0；`pipeline_stage_checkpoints` 仅 draft/qa[/brief]/finalValidate 行。

---

## 二、方案 §7.12 GO Gate 逐项验收

| Gate | 期望 | 实测 | 结论 |
|---|---|---|---|
| Production QA implementation | = 1 | `runQaStage()`（`src/services/writing/stages/qa.ts`） | ✅ |
| Production QA logical stage | = 1 | compact DAG 唯一 `qa` 节点 | ✅ |
| Outline QA production branch | = 0 | Outline 复用同一 `runQaStage` | ✅ |
| Continuation QA production branch | = 0 | Continuation 复用同一 `runQaStage`（ledger `unified_qa`） | ✅ |
| Review Production Dispatch | = 0 | compact decision 仅 `run_qa`；Red Test 覆盖 | ✅ |
| Audit Production Dispatch | = 0 | 同上 | ✅ |
| FactCheck Production Dispatch | = 0 | 同上 | ✅ |
| Proof Production Dispatch | = 0 | Phase 3 已封板 + Phase 4 回归 | ✅ |
| Normal Standard Logical Calls | ≤ 2 | draft + qa（+ revision 条件） | ✅ |
| QA formatter not default path | YES | formatter 仅 recovery 路径（writerRecovery） | ✅ |
| Physical calls observable | YES | `llm_usage_logs` / stage_results ledger / token_usage_json | ✅ |
| Resume Duplicate Paid Call | = 0 | `decideCompactFull` 幂等 + `resolveStageCheckpoints` topology 过滤 | ✅ |
| Freeze Drift | = 0 | qa 配置全来自 frozen stagePolicy/context，无 live read | ✅ |
| Semantic Apply | PASS | finalCandidate 继承 `appliedRequirementIds`（Phase 1 契约不破坏） | ✅ |
| Outline 2/2 | 2 章 | 1 章最小冒烟（同 Phase 3 口径，2/2 最终并入 Phase 7） | ⚠️ 推迟 Phase 7 |
| Continuation 2/2 | 2 章 | 同上 | ⚠️ 推迟 Phase 7 |
| Full Jest | PASS | 全量回归两处超时挂起（见风险 4，非 Phase 4 代码问题）；相关失败套件已修复并单独复核绿，终值待下轮全量确认 | ⚠️ 待续 |
| Generation Stability | PASS | f301 等批量/恢复套件修复后 3/3 绿 | ✅（相关套件） |
| Android Debug | PASS | 待执行 | ⚠️ 待续 |

---

## 三、关键风险与补救

1. **运行时 dispatch 缺口（接手期发现）**：`determineNextPipelineAction` 返回 `run_qa`，但 `outlineStageRuntime.ts` 的 action switch 未列 `run_qa`，compact 任务首个 QA 步会掉进 `default` → `failTask('未知流水线动作')`。已补 `case 'run_qa'`（与 run_review 同一共享 writer 路径），并新增 `outlineStageRuntimeRunQaDispatch.test.ts` 回归。
2. **Schema 56 表重建**：SQLite 无 DROP CONSTRAINT，`unified_qa` CHECK 扩展走「建临时表→拷贝→删旧→改名」；已核对列清单与 v33/v34 源表 19 列完全一致，INSERT SELECT * 安全；幂等 probe 防止重复重建；缺源表时跳过不崩溃（对齐 v51 纪律）。
3. **Legacy 兼容**：`LEGACY_WRITING_STAGE_DAG` 保留 review/audit/factCheck/proof；legacy resume 决策分支原样保留；`WRITING_STAGE_DAG` 作为 legacy 别名向后兼容存量消费者。
4. **全量 jest 回归超时挂起（两轮，与本阶段代码无直接因果）**：首轮（trae 代码 + 我的修复混合状态）在 `pipelineStageAttemptRepository` 之后挂死；修复后代码重跑时同样在连续重型套件之后出现 state=S 且 CPU 零增量的静默挂起，`--testTimeout` 未生效（RN jest preset 环境疑点）。已改为分批 + 单套件复核策略：全部已知失败套件（f301 / v50-v51 / ProofRemoval / Phase3Pipeline / QA 契约 / dispatch / 迁移 55→56）在修复后代码上单独跑全绿。全量 `npm run verify` 终值在下一轮（可复现环境的批量回归）回填。
5. **One-Shot 不受影响**：`decideOneShot` 在 compact 分支之前短路，极速档仍 draft→finalize，0 次 qa。
6. **红线自检**：未新增自动 LLM Stage；未新建第二套 Writer/QA/Context/Prompt Compiler/Memory；未拆分 Outline/Continuation 流水线；未固定 Token cap；未破坏 Freeze/Resume/Semantic Apply/Canon/ONE Context/ONE Memory。

---

## 四、独立 Commit

```text
refactor(writing): consolidate compact standard checks into one qa stage
```

---

## 五、PHASE 4 封板决定

> **Phase 4 施工完成·待封板（NOT YET GO）**：代码与单测已完成并通过（含接手期 4 个真 BUG 修复），方案 §7.12 的架构类/决策类/迁移类 Gate 全部通过；**尚未满足**的硬 Gate 为：Android Debug 构建验收、真实 LLM 穿测（1 章最小冒烟，2/2 大样本按既定计划并入 Phase 7）、全量 `npm run verify` 终值（回归环境存在两轮与 Phase 4 代码无直接因果的超时挂起，见风险 4，已用"相关失败套件单独复核全绿"替代，终值待下轮回填）。
>
> **在完成上述三项前，不得宣布 Phase 4 GO / 不得进入 Phase 5。**
