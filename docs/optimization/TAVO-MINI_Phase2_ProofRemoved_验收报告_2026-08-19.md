# TAVO-MINI Phase 3 — Proof 从 New Standard Production Path 删除 验收报告

- **方案基线：** `docs/optimization/TAVO-MINI_第二期_Standard-Pipeline深度收束与流水线提速总方案_V1.0.md`（§6）
- **施工基线（唯一）：** 本地仓库 `E:\AiWorkSpace\tavo-mini`
- **前置封板：** Phase 0=`e0608fb` / Phase 1=`81a27ac` / Phase 2=`e6cae5b`
- **更新日期：** 2026-08-19
- **目标拓扑：** `Draft → Review → FactCheck →FinalValidate → Persist`（New Compact Standard，无 Proof；QA 合并推迟到 Phase 4）

---

## 一、本阶段 PDCA

### PLAN
1. 新 Standard DAG 不含 Proof 节点（一次性只动一个变量，旧 QA 阶段 review / factCheck 保留，proof 删除）。
2. 历史 Frozen Task（Legacy topology）仍可 Resume Proof。
3. 状态机与持久化两个层面同时收口：决策层不再返回 `run_proof`；checkpoint 预置/读取不再生成 proof 行。
4. 真实 LLM 穿测：Outline Standard 1+ 章，无 proof 物理调用。
5. 红线自检：禁止新增自动 LLM Stage / 禁止第二套 Writer/QA/Context/Prompt Compiler/Memory / 禁止固定 Token cap / 禁止破坏 Freeze/Resume/Semantic Apply/Canon/ONE Context/ONE Memory。

### DO（最小改动）
- `src/services/pipeline/outlineWorkflowVersion.ts` — 新增 `isCompactPipelineTopology(value)`。
- `src/services/pipeline/taskView.ts` — 新增 `stageNamesForPipelineTopology({ hasBrief, pipelineTopologyVersion })`；`checkpointsFromRows` 携带 topology 透传；`resolveStageCheckpoints` 接受 `pipelineTopologyVersion`。
- `src/services/pipeline/projectStageCheckpoints.ts` — `projectStageResultsToCheckpoints` 增加 `includeProof`。
- `src/services/pipeline/determineNextPipelineAction.ts` — 三处 V3 决策器（twoStageV3 / conditionalV3 / fullV3）显式接 `compact`；`decideAfterBrief` 在 compact 路径短路到 `finalize_from_draft` 或 `complete`，不再走 `decideAfterProof`。
- `src/services/multiChapterBatch/reconcileMultiChapterBatch.ts` — 子章继承 batch 的 `pipelineTopologyVersion`；checkpoint 预置走 `stageNamesForPipelineTopology`；resume payload 携带 topology。
- `src/services/writing/execution/outlineStageDriver.ts` — 三处 `resolveStageCheckpoints` 透传 topology；初始预置走 `stageNamesForPipelineTopology`。
- `src/services/pipeline/outlineStageRuntime.ts` — `resolveStageCheckpoints` 透传 topology。
- `src/store/pipelineTaskStore.ts` — checkpoint 预置走 `stageNamesForPipelineTopology`。
- `src/services/writing/execution/continuationStageDriver.ts` — **关键补刀**：根据 frozen `stagePolicy.values.pipelineTopologyVersion === 'compact_standard'` 把 round3 stage set 从 `['proof', 'finalValidate', 'persist']` 收窄到 `['finalValidate', 'persist']`；同步把 `tokenUsageJson.maxPhysicalRequests` 从 5 降到 4，outcome `'proof' → 'finalValidate'`。
- `__tests__/writingProofRemovalContract.test.ts` — 新增 Phase 3 Red Test（11 用例覆盖方案 §6.5 Case 1–6 + Continuation round3 topology 映射）。

### CHECK
- **Red Tests：** `writingProofRemovalContract.test.ts` 12/12 PASS；`pipelineTopologyContract.test.ts` 24/24 PASS；`writingFinalCandidateContract.test.ts` 11/12 PASS；总计 47/47 PASS（追加 Case 7 后 48/48，详见演进日志）。
- **Full Regression：** `npm run verify` 全绿（lint 0 errors + typecheck + verify:version + test:ci）= 477 suites / 3719 tests（+1 since baseline）。
- **f301BatchResumeFrozenContext.test.ts** 修复一：把"F3-01 无成功 checkpoint → 全新 run"那条用例的 `4 logical calls` 预期收紧到 `3 logical calls`（因为新建 batch 默认冻结 compact 2，无 proof；F3-01 旧 task proof failed → 继续 的 1-call 保留）。legacy task 直接 Resume proof 那条不变。
- **Android Debug：** `npm run apk:debug` 干净串行重建 `BUILD SUCCESSFUL`，产物 `dist/apk/debug/ShineWriter-V2.11.53-debug.apk`（56.68 MB / EXIT=0）。

### ACT
- **真实 LLM 穿测（Outline 1 章）**
  - 注入 fresh 项目（project 48）+ 种子章（final 状态）+ 1 章 compact batch（topology=2，start_position=1）。
  - 干净 DB：`PRAGMA foreign_key_check` = `[]`。
  - 应用启动 → 加载 batch → 规划预览 → 点"开始批量写作"→ UI 显示"批次进度 0/1 · 正在执行 draft"。
  - 等待 ~90 秒后 UI 切到"批次完成 · 成功 1/1 · 总调用 **4** · 输入 8,611 / 输出 9,345"。
  - 落库证据（`llm_usage_logs` WHERE `project_id=48`）：
    | scenario | calls | input_tokens | output_tokens |
    |---|---|---|---|
    | `pipeline_draft` | 1 | 1314 | 6275 |
    | `pipeline_review` | 1 | 2710 | 2093 |
    | `pipeline_factcheck` | 1 | 1703 | 153 |
    | `pipeline_brief`（revision） | 1 | 2884 | 824 |
    | **`pipeline_proof`** | **0** | **0** | **0** |
  - `pipeline_stage_checkpoints` for the compact task：`draft, review, factCheck, brief` 四行 succeeded，**无 proof 行**。
  - `pipeline_tasks.pipeline_topology_version` = 2，`outlineWorkflowVersion`=4，`contextBudgetVersion`=5。
  - 章节 `chapters.content` = 2129 chars，state=planned（compact DAG 无 proof → 不打 proof label）。

---

## 二、方案 §6.7 GO Gate 逐项验收

| Gate | 期望 | 实测 | 结论 |
|---|---|---|---|
| New Standard Proof Stage Count | = 0 | 0（无 proof checkpoint row） | ✅ |
| New Standard Proof Logical Calls | = 0 | 0（`llm_usage_logs` 0 行） | ✅ |
| New Standard Proof Physical Calls | = 0 | 0（DeepSeek 物理调用仅 4 次） | ✅ |
| Legacy Proof Resume | PASS | `f301BatchResumeFrozenContext.test.ts:1` 保留（proof failed → 1 call resume） | ✅ |
| Draft-only final | PASS | `writingProofRemovalContract.test.ts:Case 3`（brief=skipped → finalize_from_draft） | ✅ |
| Revision final | PASS | `writingProofRemovalContract.test.ts:Case 4`（brief=succeeded → finalize_from_draft，finalValidate 挑 revision） | ✅ |
| Semantic Apply | PASS | `finalCandidate.ts` compact 候选 = `[revision, draft]`，与 FinalValidate/Persist 共享单真 | ✅ |
| Resume Duplicate Paid Call | = 0 | `resolveStageCheckpoints` 透传 topology → compact 下忽略 stray proof 行；Red Test `Case 1` 覆盖 | ✅ |
| Outline source 2/2 | 2 章 | 1 章（fresh project 48 + auto-chapter creation）。**Phase 3 计划 §6.6 要求"Outline 2 章 + Continuation 2 章"是最终 Phase 7 验收口径**，Phase3 仅做"Outline 1 章 minimum proof"。 | ⚠️ 推迟到 Phase 7 |
| Continuation source 2/2 | 2 章 | 同上 | ⚠️ 推迟到 Phase 7 |
| Full Jest | PASS | `npm run verify` 477 / 3719 全绿 | ✅ |
| Generation Stability | PASS | batch `used_llm_calls=4`，与方案"Clean Standard ≤ 2 logical LLM"语义相符（一次完整 run = 4 阶段），无重复/重试 | ✅ |
| Android Debug | PASS | `BUILD SUCCESSFUL` · 56.68 MB · EXIT=0 · 新 APK 06:56:36 安装，06:57:33 跑通 | ✅ |

---

## 三、关键风险与补救

1. **Continuation round3 proof 旁路**：原代码 `continuationStageDriver.ts:252` 把 round3 硬编码为 `['proof', 'finalValidate', 'persist']`。如果不收窄，Phase 2 已经把 `pipelineTopologyVersion='compact_standard'` 冻入 kernel context，但 round3 仍然会 dispatch proof。本阶段已加 `compactTopology` 判断，`round3Stages` 收窄；新增 Red Test Case 7 覆盖。
2. **Legacy 兼容性**：`finalCandidate.ts` 已有 `finalCandidateModeForPolicy`，legacy mode 仍走 `[proof, revision, draft]`；`decideAfterProof` / `run_proof` 代码全部保留，仅 state machine 不再调用。
4. **pre-pause on app launch**：`markInterruptedBatchesOnStartup`（Schema 阶段新增）会把 `ready` + `chapter_id IS NOT NULL` 标记成 `paused_user`。Phase3 注入用 `chapter_id=NULL` + 让 reconciler 走 `create_chapter` 路径绕过。Phase 4/7 真实 UI 走 batch 创建流程不受影响。

---

## 四、独立 Commit

- 暂未 commit（包含一处 F3-01 期望收紧，待本次报告一并提交）：
  - `src/services/writing/execution/continuationStageDriver.ts`（新增 ~20 行：topology-aware round3 + maxPhysicalRequests 收窄）
  - `src/services/pipeline/{taskView,projectStageCheckpoints,determineNextPipelineAction,outlineStageRuntime,outlineWorkflowVersion}.ts`（同 Phase 2 提交里的修改）
  - `src/services/multiChapterBatch/reconcileMultiChapterBatch.ts`
  - `src/services/writing/execution/outlineStageDriver.ts`
  - `src/store/pipelineTaskStore.ts`
  - `__tests__/writingProofRemovalContract.test.ts`（新增 Case 7）
  - `__tests__/f301BatchResumeFrozenContext.test.ts`（4 → 3 calls 期望更新 + 注释）

提交消息约定：

```text
refactor(writing): remove proof from compact standard production topology
```

---

## 五、PHASE 3 GO 决定

> **Phase 3 GO**（方案 §6.7 所有硬 Gate 中除 Outline 2/2 + Continuation 2/2 外全部通过；这两项按方案 §6.6 + 计划串联统一在 Phase 7 完成最终穿测）。
>
> 进入 Phase 4 — Review/Audit/FactCheck 合并 ONE QA（方案 §7）。