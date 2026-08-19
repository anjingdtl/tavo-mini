# TAVO-MINI 第二期 Standard-Pipeline 收束·项目进度总览 Progress

- **方案基线：** `docs/optimization/TAVO-MINI_第二期_Standard-Pipeline深度收束与流水线提速总方案_V1.0.md`
- **施工基线（唯一）：** 本地仓库 `E:\AiWorkSpace\tavo-mini`
- **更新日期：** 2026-08-19
- **当前 HEAD：** `5abdbe5`（Phase 3 已 commit；Phase 2 = `e6cae5b`；Phase 1 = `81a27ac`；Phase 0 = `e0608fb`）
- **目标顶层：** `Draft → ONE QA → Conditional Revision → Local FinalValidate → Persist`
  - Clean Standard ≤ 2 次逻辑 LLM；需修订 ≤ 3 次；One-Shot = 1 次
  - New Standard 中 Review=0 / Audit=0 / FactCheck=0 / Proof=0（仅 Legacy Resume 保留旧拓扑）

---

## 一、总体推进状态（串行，未 GO 禁止进入下一阶段）

| Phase | 名称 | 状态 | 独立 Commit | 验收报告 | 硬 Gate |
|---|---|---|---|---|---|
| **0** | 第二期 Baseline 与调用成本固化 | ✅ **GO** | `e0608fb` | ✅ | ✅ verify 全绿 |
| **1** | Final Candidate Contract 收束 | ✅ **GO** | `81a27ac` | ✅ | ✅ verify + Android Debug 全绿 |
| **2** | Pipeline Topology Version + Resume | ✅ **GO** | `e6cae5b` | ✅ | ✅ verify + Migration + Android Debug 全绿 |
| **3** | Proof 从新 Standard 删除 | ✅ **GO** | `5abdbe5` | ✅ | ✅ verify + Android Debug + 真实 LLM 穿测 全绿 |
| **4** | Review/Audit/FactCheck 合并 ONE QA | 🚧 **施工完成·待封板** | 待提交 | ✅（报告已建，Android Debug/真机后回填终值） | ⚠️ 单测绿；Android Debug / 真实 LLM / 全量 verify 待续 |
| **5** | Revision Trigger / API / Token 治理 | ⬜ 未开始 | — | — | — |
| **6** | Batch / Single / Resume / UI / Ledger 收束 | ⬜ 未开始 | — | — | — |
| **7** | 真实 LLM 穿测 + 最终封板 | ⬜ 未开始 | — | — | — |

> 最终硬 Gate 全部通过后才宣布 `PHASE 2 FINAL SEALED / GO`。

---

## 二、Phase 0 — 完成 ✅（已封板）

**Commit：** `e0608fb test(writing): baseline standard pipeline cost and call graph`

**施工内容（只观察，不改生产行为）：**
- 新增 `__tests__/writingPhase2Baseline.test.ts`（4 用例）：
  - B1 断言当前生产 DAG 以 `WRITING_STAGE_DAG` 为唯一权威
  - B2 生成 Outline Standard 2 章 + Continuation Standard 2 章 + One-Shot 1+1 结构基线（`test-logs/phase2-structural-baseline.json`）
  - B3 证明 Logical / Formatter / Physical / Protocol-Fallback 四口径按章×阶段可区分、可聚合
  - B4 证明 `finalizeWritingKernelObservability` 可把快照挂回 trace
- 验收报告：`docs/optimization/TAVO-MINI_Phase2_Baseline_验收报告_2026-08-19.md`

**硬 Gate 证据：** `npm run verify`（lint 0 errors + typecheck + verify:version + test:ci）全绿，474 suites / 3676 tests。

**当前生产调用图（Phase 0 记录的「Before」，两项 Source Adapter 走同一个 Kernel）：**
- Outline Standard：`draft → review → factCheck → revision → proof → [finalValidate → persist]`，付费 5
- Continuation V5：`draft → review → audit → revision → proof → [finalValidate → persist]`，付费 5
- One-Shot：`draft → [finalValidate → persist]`，付费 1

---

## 三、Phase 1 — Final Candidate Contract 收束（代码完成，待收尾）

**目标（方案 §4）：** 删除 Proof 前先确立「谁是最终正文」。唯一 Final Candidate = `revision exists → revision；否则 draft`；FinalValidate 与 Persist 只消费这一候选（单真值），New Standard 对 Proof 依赖 = 0。

**已完成的代码（未 commit）：**
- 🆕 `src/services/writing/stages/finalCandidate.ts`
  - `resolveFinalWritingCandidate(artifacts, {mode})`：纯本地，不读 live DB
  - `mode: 'compact'` → `[revision, draft]`（无 proof）；`mode: 'legacy'` → `[proof, revision, draft]`
  - 正式 skip（`structured.skipped===true`）不作为候选；空正文 fail-closed 不偷偷回退
  - 完整继承中标阶段的 `appliedRequirementIds / validNoOpRequirementIds / validNoOpReasons`
  - `finalCandidateModeForPolicy(policy)`：`values.pipelineTopologyVersion==='compact_standard'` → compact（为 Phase 2 预留）
- ✏️ `src/services/writing/stages/finalValidate.ts` — 只消费 `resolveFinalWritingCandidate`；修复「draft 带 appliedRequirementIds 时 metadata 丢失」；空候选 → `FINAL_BODY_MISSING`
- ✏️ `src/services/writing/stages/persist.ts` — 只消费已校验候选（默认优先 `artifacts.finalValidate`），不再自己拼 proof→revision→draft 双重真值；空 → `PERSIST_BODY_MISSING`
- ✏️ `src/services/writing/contracts/writingStage.ts` — `SharedWritingArtifact` 增加 `sourceStage?: 'proof'|'revision'|'draft'|null`
- 🆕 `__tests__/writingFinalCandidateContract.test.ts`（10 用例，覆盖方案 §4.6 Case 1–6 + compact/legacy/flag）

**Phase 1 Red Test 证据：** `writingFinalCandidateContract.test.ts` 10/10 PASS；`writingPhase2Baseline.test.ts` 4/4 PASS。

**Full Regression：** `npm run verify` 全绿 —— **475 suites / 3686 tests**，lint 0 errors，typecheck PASS。

**Android Debug：** `npm run apk:debug` 干净串行重建 **BUILD SUCCESSFUL**，输出 `dist/apk/debug/ShineWriter-V2.11.53-debug.apk`（56.55 MB），EXIT=0。此前并发误操作导致的 Metro 文件锁报错为环境/误操作产物，干净构建未复现。

**Phase 1 封板（已完成）：**
- ✅ 补写 `docs/optimization/TAVO-MINI_Phase2_FinalCandidateContract_验收报告_2026-08-19.md`（对齐方案 §4.7 GO Gate，逐项 ✅）
- ✅ 干净 `npm run apk:debug` → Android Debug = PASS（56.55 MB / EXIT=0）
- ✅ 独立 commit：`81a27ac refactor(writing): establish proof-independent final candidate contract`
- ✅ **PHASE 1 GO** 已宣布，允许进入 Phase 2

---

## 三-2、Phase 2 — Pipeline Topology Version + Resume Contract（已完成 ✅ GO）

**Commit：** `e6cae5b feat(writing): freeze compact-standard pipeline topology for new tasks`

**施工内容：**
- 🆕 `pipeline_topology_version`（1=legacy_standard，2=compact_standard）持久列：Schema 55（`v54-to-v55.ts` 幂等 ALTER + fresh DDL + `schemaManifest` backup 列同步）。
- task/batch 创建各 Freeze 一次；子章继承 batch；派生终稿继承父任务。
- Kernel freeze `stagePolicy.values.pipelineTopologyVersion` 标签（driver + runtime 两处）。
- Resume gate 改为 `checkPipelineResumeContract`：只查冻结契约（topology 合法 + cbv 可续），**移除 live `CURRENT_OUTLINE_WORKFLOW_VERSION` 比较** → cbv 可续的 legacy 任务按冻结旧 topology Resume；损坏 → `PIPELINE_TOPOLOGY_CORRUPT` fail-closed。
- 🆕 Red Test `pipelineTopologyContract.test.ts` 21 用例（§5.6 Case 1–5 + 标签联动）。

**硬 Gate 证据：** `npm run verify` 全绿（476 suites / 3707 tests）+ 全链路 Schema40→55 迁移 + `npm run apk:debug` BUILD SUCCESSFUL（56.56 MB / EXIT=0）。
**验收报告：** `docs/optimization/TAVO-MINI_Phase2_TopologyVersionResume_验收报告_2026-08-19.md`

**Phase 2 过渡说明：** 新任务冻结 compact(2) 但 Phase 2 仍跑 proof（DAG 未变）；kernel values 已带 `compact_standard` → Phase 1 compact Final Candidate 生效（proof 不再是最终正文候选），proof 付费冗余调用在 Phase 3 移除。

---

## 四、后续 Phase 3–7（下一 agent 路途要点）

每个 Phase 都要先读方案对应章节，完成 **PDCA → Red Test → Full Regression → GO/NO-GO → 独立 commit + 验收报告**。

### Phase 3 — Proof 从新 Standard 删除（方案 §6）
- compact topology 的 DAG 去掉 proof 节点（保留 Legacy Proof Resume）
- 一次只改一个变量：此阶段暂保留旧 QA stages（review/factCheck），只砍 proof
- Red Test：compact 下 proof dispatch=0 / physical=0 / ledger=0；Legacy 仍能 resume proof
- Commit：`refactor(writing): remove proof from compact standard production topology`
- 关键落点：`determineNextPipelineAction.ts`（decision）、`outlineStageDriver.ts` ACTION_STAGES、checkpoint 预置 `initialStages`、`outlineWorkflowVersion.ts`、`finalCandidate`（compact 已排除 proof ✔）

**Phase 3 已封板（commit `5abdbe5`）：**
- ✅ `decideAfterBrief` 在 compact 下短路到 `finalize_from_draft` / `complete`，`run_proof` 不再返回。
- ✅ `stageNamesForPipelineTopology({ hasBrief, pipelineTopologyVersion })` 决定 compact 是否预置 proof。
- ✅ `resolveStageCheckpoints` + `checkpointsFromRows` 透传 topology：compact 下忽略 stray proof 行。
- ✅ `continuationStageDriver.ts` round3 topology-aware：`compact` → `['finalValidate', 'persist']`；`maxPhysicalRequests` 从 5 收窄为 4。
- ✅ Red Test `writingProofRemovalContract.test.ts` 12/12 PASS；`pipelineTopologyContract.test.ts` 24/24 PASS。
- ✅ `f301BatchResumeFrozenContext.test.ts`：`unbound + new run` 用例 `4 → 3 calls` 期望收紧（legacy-task-resumes-proof 仍为 1）。
- ✅ `npm run verify` 全绿 = 477 suites / 3719 tests。
- ✅ `npm run apk:debug` BUILD SUCCESSFUL，56.68 MB / EXIT=0。
- ✅ **真实 LLM 穿测**（fresh project 48 + compact batch `batch_p3u_*`）：UI 显示"批次完成 · 总调用 4"；`llm_usage_logs` 仅有 `pipeline_draft / pipeline_review / pipeline_factcheck / pipeline_brief` 4 条；`pipeline_stage_checkpoints` 仅 `{draft, review, factCheck, brief}` succeeded，**0 proof 行**。
- ✅ 验收报告：`docs/optimization/TAVO-MINI_Phase2_ProofRemoved_验收报告_2026-08-19.md`
- ⚠️ 方案 §6.6 的 Outline 2 章 + Continuation 2 章大样本按计划串到 Phase 7 一并完成最终封板。
- ✅ **PHASE 3 GO**，允许进入 Phase 4（合并 ONE QA）。

### Phase 4 — 合并 ONE QA（方案 §7）【接手期施工完成，待封板】

**目标：** 生产实现唯一 `runQaStage()` + `compileSharedWritingPrompt('qa')` + `executeSharedWriterStage(stage='qa')`；Outline/Continuation 无第二套 QA；场景差异只在 Source Adapter / Frozen Requirements / Policy；compact DAG = `draft → qa → revision → finalValidate → persist`。

**已完成（代码 + 单测全绿）：**
- 🆕 `src/services/writing/stages/qa.ts` — 唯一生产 QA 实现。
- 🆕 `src/services/migrations/v55-to-v56.ts` — `unified_qa` ledger CHECK 重建（幂等 + 缺表跳过），`SCHEMA_VERSION` 55 → 56。
- ✏️ `writingStageDag.ts` 拆 `LEGACY/COMPACT_WRITING_STAGE_DAG` + `getWritingStageDagForTopology`；`taskView.stageNamesForPipelineTopology` compact = `[draft, qa, (brief)]`。
- ✏️ `determineNextPipelineAction` 新增 `run_qa` + `decideCompactFull`；One-Shot 前置短路不受影响；legacy 分支原样保留。
- ✏️ `outlineStageRuntime` / `runOutlineSharedWriterAction` / `outlineStageDriver` — `run_qa → ['qa']` 运行时 dispatch。
- ✏️ `continuationStageDriver` — compact round1=`[draft]`、round2=`['qa','revision']`；`maxPhysicalRequests` compact 4 → 3。
- ✏️ `writerCore/writerRecovery/writingStageRunner/evaluateRuntimeStageSkip/findingsAggregator/stageContextProjection/sharedPromptCompiler/requirementProjection/reasoningPolicy/stageReasoning` — qa 纳入结构化 report、adoption、formatter、revision trigger、context allowlist、reasoning freeze。
- ✏️ durable adapters — outline checkpoint `'qa'`；continuation ledger `unified_qa`（V5 models/budget/generationRepository/contextViews 同步）。
- ✏️ UI 层（`PipelineProgress` / `PipelineResultScreen` / `ContextPreviewScreen`）qa 标签；旧文案全链路清理按 §9 归入 Phase 6。

**接手期全量回归驱动的 4 个真 BUG 修复（均有回归测试）：**
1. `normalizePersistedPipelineTopologyVersion` 只认数字 1/2，freeze 写的是字符串 `'compact_standard'` → 运行时 DAG 查 legacy → `WRITING_STAGE_DAG_DEADLOCK: qa`。修复：normalize 同时接受 label 字符串。
2. `stageReasoning.LLM_STAGES` 漏 `'qa'` → `resolveFrozenStageReasoning('qa')` undefined → shared writer 崩溃。修复：补 qa 并归入结构化低档（§7.7）。
3. `v55-to-v56` 迁移缺源表时崩溃（`no such table: continuation_generation_stage_results`）。修复：缺表跳过（对齐 v51 纪律）。
4. `outlineStageRuntime` action switch 漏 `run_qa` → compact 任务首个 QA 步 failTask('未知流水线动作')。修复：补 case。

**Red Tests：** `writingQaConsolidationContract.test.ts` 19 用例（§7.10 架构/调用图/Resume/Legacy/Freeze/输出契约 + label 归一化 + qa reasoning freeze）、`outlineStageRuntimeRunQaDispatch.test.ts` 3 用例、`migrations-schema55-to-56.test.ts` 5 用例（CHECK 扩展/数据保留/幂等/缺表跳过/fresh DDL 顺序）→ 全 PASS。
**期望收紧：** `f301BatchResumeFrozenContext` 新 run 3 calls → 2 calls（draft+qa，pass 跳过修订）；`writingProofRemovalContract` Case 3/4/5 改 qa checkpoint；`writingOneFlowPhase3Pipeline` DAG 未知 stage 断言改 toThrow。
**已验证绿：** lint 0 errors / typecheck PASS / verify:version OK；f301 3/3、v50-v51、ProofRemoval+Phase3 21/21、QA 契约 19/19、dispatch 3/3、迁移 5/5。
**待续（封板门槛）：** Android Debug 构建、模拟器真实 LLM 冒烟（冒烟 DB 已备好 `scripts/phase4-smoke-db.py`：compact batch topology=2 + DeepSeek 配置，schema 55→56 顺带做迁移穿测）、全量 `npm run verify` 终值回填。
**红线自检：** 未新增自动 LLM Stage / 未建第二套 Writer/QA/Context/Prompt Compiler/Memory / 未拆分 Outline/Continuation 流水线 / 未固定 Token cap / 未破坏 Freeze/Resume/Semantic Apply/Canon/ONE Context/ONE Memory。
**验收报告：** `docs/optimization/TAVO-MINI_Phase2_OneQA_验收报告_2026-08-19.md`（GO Gate 表格待 Android Debug/真机后回填终值）。

### Phase 5 — Revision Trigger / API / Token 治理（方案 §8）
- QA `verdict:pass + []` → Revision = 0；仅 executable blocking/warning finding 才 Revision = 1
- QA 输出极简 JSON；Revision context 排除旧 Review/Audit/FactCheck 堆积报告
- 物理请求与协议降级可观测
- Commit：`perf(writing): tighten qa revision triggers and stage token costs`

### Phase 6 — UI / Ledger / Batch / Single / Resume 收束（方案 §9）
- 扫掉生产 UI 里的 `reviewing/auditing/factchecking/proofing` 旧文案
- New Standard 不产生 fake skipped legacy 行；UI 展示「生成/检查/修订/校验/保存」
- Commit：`refactor(writing): align batch ui ledger and resume with compact standard topology`
- 落点：`src/screens/PipelineTaskScreen.tsx`、`PipelineResultScreen.tsx`、`chapter-editor/hooks/useChapterPipeline.ts`、`PipelineProgress.tsx`、`pipelineTaskStore` stage 映射

### Phase 7 — 真实 LLM 穿测 + 最终封板（方案 §10/§11）
- Outline Standard 2 章 + Continuation Standard 2 章 + One-Shot 1+1（共 6 章真实付费样本）
- 每章记录 generationTraceId / freezeFingerprint / pipelineTopologyVersion / 四口径 / tokens / stage latency
- 全部门禁通过后 `PHASE 2 FINAL SEALED / GO`
- Commit：`docs(optimization): seal phase-two compact standard pipeline`

### 历史踩坑专项回归（方案 §14，最终统一复跑）
H1 Shared Writer Recovery / H2 Frozen Thinking(DeepSeek) / H3 Envelope 损坏 fail-closed / H4 Resume 冻结上下文不 NULL 覆盖 / H5 重复付费调用=0 / H6 Legacy 不被接管 / H7 不用 fake skipped 冒充收束 / H8 Provider Physical 可观测 / H9 禁 UPDATE-LIMIT / H10 禁物化大 JSON / H11 Cold Start / H12 UI Same-Task 完成态重感知。

---

## 五、纪律与红线（贯穿全程）

1. **每个 Phase 独立 PDCA + 独立 commit + 独立验收报告**，未 GO 禁止进入下一阶段
2. 禁止新增任何自动 LLM Stage；禁止新建第二套 Writer/QA/Context/Prompt Compiler/Memory
3. 禁止重新拆分 Outline/Continuation 流水线（场景差异只在 Source/Requirements/Policy）
4. 禁止固定 Token cap；Token 优化来自减 Stage/减重复 Context/减检查输出/减 Formatter 常态化
5. 禁止破坏 Freeze / Resume / Semantic Apply / Canon / ONE Context / ONE Memory
6. 历史 Frozen Task 必须按旧 topology Resume；不得被 Compact Standard 接管
7. 改动敏感区前先读：README / CHANGELOG / docs/optimization 相关方案 / AGENTS.md
8. Android 真机/模拟器验收未做前，不得声称「修复完成」
