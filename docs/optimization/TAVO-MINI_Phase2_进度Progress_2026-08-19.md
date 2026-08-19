# TAVO-MINI 第二期 Standard-Pipeline 收束·项目进度总览 Progress

- **方案基线：** `docs/optimization/TAVO-MINI_第二期_Standard-Pipeline深度收束与流水线提速总方案_V1.0.md`
- **施工基线（唯一）：** 本地仓库 `E:\AiWorkSpace\tavo-mini`
- **更新日期：** 2026-08-19
- **当前 HEAD：** `81a27ac`（Phase 1 已 commit；Phase 0 = `e0608fb`）
- **目标顶层：** `Draft → ONE QA → Conditional Revision → Local FinalValidate → Persist`
  - Clean Standard ≤ 2 次逻辑 LLM；需修订 ≤ 3 次；One-Shot = 1 次
  - New Standard 中 Review=0 / Audit=0 / FactCheck=0 / Proof=0（仅 Legacy Resume 保留旧拓扑）

---

## 一、总体推进状态（串行，未 GO 禁止进入下一阶段）

| Phase | 名称 | 状态 | 独立 Commit | 验收报告 | 硬 Gate |
|---|---|---|---|---|---|
| **0** | 第二期 Baseline 与调用成本固化 | ✅ **GO** | `e0608fb` | ✅ | ✅ verify 全绿 |
| **1** | Final Candidate Contract 收束 | ✅ **GO** | `81a27ac` | ✅ | ✅ verify + Android Debug 全绿 |
| **2** | Pipeline Topology Version + Resume | ⬜ 未开始 | — | — | — |
| **3** | Proof 从新 Standard 删除 | ⬜ 未开始 | — | — | — |
| **4** | Review/Audit/FactCheck 合并 ONE QA | ⬜ 未开始 | — | — | — |
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

## 四、后续 Phase 2–7（下一 agent 路途要点）

每个 Phase 都要先读方案对应章节，完成 **PDCA → Red Test → Full Regression → GO/NO-GO → 独立 commit + 验收报告**。

### Phase 2 — Pipeline Topology Version + Resume Contract（方案 §5）
- 新增冻结 `pipelineTopologyVersion`（1=legacy_standard，2=compact_standard）
- task/batch 创建时各 Freeze 一次、子章继承 batch、Resume 不重读 live 默认
- 历史 Frozen Task 按**旧 topology** Resume（这是本方案的硬要求；当前 `resumePipeline` / `outlineStageDriver.ts:333-372` 会以 `LEGACY_PIPELINE_RESUME_BLOCKED` 阻止 owv≠4 任务——需评估：是扩展 resume 放行能力，还是保持现状并说明；**不可让旧任务被 Compact Standard 接管**）
- 迁移（schema 增列）+ 幂等 + `pipelineTopologyVersion` 损坏 fail-closed
- Commit：`feat(writing): freeze compact-standard pipeline topology for new tasks`
- 关注点：`src/types/pipeline.ts`（PipelineTask 增字段）、schema（`createCurrentSchema.ts` + `vN-to-vN+1.ts`）、`outlineWorkflowVersion.ts`、`determineNextPipelineAction.ts`、`outlineStageRuntime.ts` freeze 处

### Phase 3 — Proof 从新 Standard 删除（方案 §6）
- compact topology 的 DAG 去掉 proof 节点（保留 Legacy Proof Resume）
- 一次只改一个变量：此阶段暂保留旧 QA stages（review/factCheck），只砍 proof
- Red Test：compact 下 proof dispatch=0 / physical=0 / ledger=0；Legacy 仍能 resume proof
- Commit：`refactor(writing): remove proof from compact standard production topology`
- 关键落点：`determineNextPipelineAction.ts`（decision）、`outlineStageDriver.ts` ACTION_STAGES、checkpoint 预置 `initialStages`、`outlineWorkflowVersion.ts`、`finalCandidate`（compact 已排除 proof ✔）

### Phase 4 — 合并 ONE QA（方案 §7）
- 生产实现唯一 `runQaStage()` + `compileSharedWritingPrompt('qa')` + `executeSharedWriterStage(stage='qa')`
- Outline/Continuation 不得有第二套 QA；场景差异只在 Source Adapter / Frozen Requirements / Policy
- 需要扩展：`SharedWritingStageName` 增 `'qa'`、`STAGE_PROTOCOL.qa`、`WRITING_STAGE_DAG`（qa 依赖 draft，revision 依赖 qa）、`writerCore`/`writerRecovery`/`findingsAggregator`/`evaluateRuntimeStageSkip`（qa 作为唯一 findings 源）、`stageContextProjection.STAGE_CONTEXT_KIND_ALLOWLIST.qa`、durable adapters 的 `qa` 映射（outline checkpoint `'qa'`；continuation ledger node 如 `'unified_qa'`）
- Commit：`refactor(writing): consolidate compact standard checks into one qa stage`
- **红线：** 不新增自动 LLM Stage、不固定 Token cap

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
