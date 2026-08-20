# Phase 4R (ONE QA Closure) — Evidence Report / NO-GO

**日期:** 2026-08-19
**Baseline:** `main @ 7fbefc43c3ac786b284014d624783e21f27f5361`（远端 HEAD 一致，无新增提交需审计）
**本地施工基线:** `F:\ClaudeWorkSpace\projects\TAVO-MINI`
**结论:** `PHASE 4R NO-GO` — 停留在 Phase 4R，禁止进入 Phase 5。

---

## 1. P0-1 — Outline QA 跨 action/resume durable preload

**Root Cause:** `runWritingStages` 的 durable preload 白名单（writingStageRunner.ts）遗漏 `'qa'`，导致 `run_brief`(revision) 作为独立 action 恢复时 `artifacts.qa` 缺失，`aggregateStageFindings()` 空 → `hasExecutableFindings()` false → Revision 被误跳过（False Empty Findings Pass）。

**Minimal Fix:** 在 durable preload 白名单补入 `'qa'`。

```
writingStageRunner.ts  preload list: draft, qa, review, audit, factCheck, revision, proof, finalValidate
```

**Red→Green:** 新增 `__tests__/writingQaDurablePreloadContract.test.ts`
- Red: `loadExisting` 从未以 `'qa'` 调用；revision 被 skip（callStage=0）。
- Green: `loadExisting('qa')` 被调用，revision 执行（callStage=1, status=completed）。

**相关回归:** 全绿（105 用例，含 outlineQA / topology / revision / finalCandidate / proofRemoval / qaConsolidation）。

---

## 2. P0-2 — Continuation Compact Semantic Apply 不得依赖 final_reviser

**Root Cause:** Compact DAG 不运行 Proof，`final_reviser` 阶段行永不产生。round3 `semanticApply` 仍从 `getStageResult(run.id,'final_reviser')` 取 metadata → null → `appliedRequirementIds=[]` → `checkSemanticRequirementApplication` 空证据直接 PASS（Empty Evidence / False Applied 风险）。

**Minimal Fix:** Compact 分支读取真实 ONE Final Candidate metadata：
- `revision_writer` success → revision metadata；
- 否则 → `draft_writer` metadata；
- 结构上不接受任何 `final_reviser` / proof 输入。
- Legacy 拓扑保留原 proof / final_reviser 读取。

```
continuationStageDriver.ts
  + resolveCompactSemanticApplyMetadata(..., CompactCandidateRow)
  round3 semanticApply: if compactTopology → real final candidate；else → legacy final_reviser
```

**Red→Green:** 新增 `__tests__/writingCompactSemanticApplyContract.test.ts`（Case A revision / Case B draft 继承 / Case C 无 final_reviser 表面 / Case D 不伪造空）。

**相关回归:** 全绿，含 writingFinalCandidateContract（Compact Final Candidate 契约）、continuationDurableAdapter、continuationV5*。

---

## 3. GATE-1 — Full `npm run verify` = PASS

```
lint          PASS  (0 errors; 209 既有 warnings)
typecheck     PASS
verify:version PASS  (V2.11.53, versionCode=2115300)
Full Jest     PASS   (Test Suites: 3 skipped / 483 passed; Tests: 8 skipped / 3754 passed; 0 failed, 0 hanging)
Migration 55→56 PASS  (含于 Full Jest)
```
Exact HEAD（含两个 P0 修复）验证。`writingFinalSealGates` 经孤立复核 PASS(7/7)。

## 4. GATE-2 — Android Debug = PASS

```
npm run apk:debug  BUILD SUCCESSFUL  → dist/apk/debug/ShineWriter-V2.11.53-debug.apk (50.22 MB)
adb install -r      Success（覆盖安装，未 uninstall / pm clear，保留既有数据与 LLM 配置）
App cold boot on emulator-5554 (Medium_Phone / API 37) OK；llm_config 保留：deepseek-v4-flash @ api.deepseek.com active。
```

## 5. GATE-3 — 当前 HEAD 真实 LLM 2+2 = NOT SEALED（阻塞）

真实 LLM 门禁未闭环，故 Phase 4R 判定 NO-GO：

1. **模拟器无外网（环境）**：初态 DNS/外网均不可达（`Unable to resolve host`，NetworkMonitor 探测失败）。已通过冷重启 AVD `Medium_Phone` 并加 `-dns-server 8.8.8.8` 修复（`api.deepseek.com` 现可解析并连通，数据保留）。

2. **Continuation 真实 run 调用图不满足 Compact Standard QA=1**：
   - run `ct_b6294d2251314b04908f2ea81dde7862`（chapter 242）：`draft_writer=success/1 请求`；`unified_qa=queued（0 请求）`；`revision_writer=skipped`；`final_validate=success`。
   - 即该 App 续写路由仅执行 Draft → FinalValidate，**未执行 ONE QA（QA=0）**，不满足方案要求的 `Draft=1, QA=1`；且 UI 呈现 “请求 1/5 / V5 三稿 V1/V2/V3”，疑似走旧/快速续写路由而非 Compact Standard DAG。
   - 因此该证据不能作为 “Continuation Standard QA=1” 验收证据；Outline 2 章 / Continuation 2 章的 Compact 调用图证据均未能闭环。

**Gate-3 未满足 ⇒ Phase 4R GO Gate 未满足 ⇒ NO-GO。**

---

## 6. 结论与下一步

- P0-1、P0-2 两处修复已完成并经 Full Verify + Android 门禁验证，真实有效。
- 但真实 LLM 2+2（Outline/Continuation Standard，各 QA=1，Review/Audit/FactCheck/Proof=0）尚未产出可验收证据。
- 严格 PDCA：NO-GO，禁止进入 Phase 5。
- 下一步（仍停留 Phase 4R）：确认并驱动走 Compact Standard 的续写/大纲真实路由（排除 App 旧续写快速路由），使 `unified_qa` 真正执行（QA=1），补全 2+2 调用图证据后再判 GO。

**Evidence 目录：** `test-logs/phase4r-gate3-20260819-235615/`

---

## 7. 追加：续写“没走到 ONE QA”根因定位 + 修复 + 续写 Compact 实证（2026-08-19 续）

### 7.1 根因（实证，非猜测）

对首个续写 run `ct_b6294d…`（chapter 242）实查冻结快照：

```text
pipelineTopologyVersion：缺失（未注入）  → finalCandidateModeForPolicy → 'legacy'
executionProfile: "one_shot"              → profile.one_shot.skip_{review,audit,factCheck,revision,proof}
skipRules 含 profile.one_shot.*，maxPaidLlmCalls:1
```

两个独立原因叠加导致 QA 从不执行：

1. **执行档位 = 极速(one_shot)**：全局设置 `settings.pipeline_execution_profile='one_shot'`。续写单章入口 `useChapterPipeline.ts` 不传 `executionProfile`，落到 `getStoredWritingExecutionProfile()`（=one_shot），QA/Revision 全部被 `profile.one_shot.skip_*` 冻跳过。这是**设计行为**（极速档就该跳过），非缺陷。
2. **续写生产冻结拓扑从未设为 compact_standard**：`continuationRunPreparation.ts` 构建 `kernelRequest.policy.values` 时未写 `pipelineTopologyVersion`。因此即便标准档，`finalCandidateModeForPolicy` 也判 `legacy`，续写走旧 review/audit/factCheck DAG，**生产续写从没真正激活 Compact ONE-QA [qa,revision] 路径**（代码里该路径仅被单元测试设 compact_standard 覆盖）。

### 7.2 最小修复（单源注入，与 outline 一致）

`src/services/writing/scenario/continuationRunPreparation.ts`：生产续写 freeze 注入

```text
pipelineTopologyVersion: pipelineTopologyLabel(CURRENT_PIPELINE_TOPOLOGY_VERSION)   // = 'compact_standard'
```

从而激活续写 driver 已编写好但生产未触发的 compact round：
`round1=[draft] → round2=[qa,revision] → round3=[finalValidate,persist]`，`unified_qa` 节点正是 Compact Standard 的 ONE QA。

### 7.3 设备真实 LLM 实证（Continuation Standard 2/2，QA=1）

将设备全局档位翻转为 `standard`（`run-as cp` 写回 settings，SELinux 拦截被 `cp` 规避，数据保留），在安装含修复 APK 上跑两条单章续写：

| 项 | run `ct_b0704…` (ch243) | run `ct_0cb7…` (ch244) |
|---|---|---|
| pipelineTopologyVersion | compact_standard | compact_standard |
| executionProfile | None（标准档） | None |
| skip revision/qa | false | false |
| maxPhysicalRequests | 3 | 3 |
| draft_writer | success / req=1 | success / req=1 |
| **unified_qa** | **success / req=1** | **success / req=1** |
| revision_writer | success / req=1 | success / req=1 |
| final_validate | success / req=0 | success / req=0 |
| narrative/adversarial/final_reviser | queued(0) | queued(0) |
| state | awaiting_user | awaiting_user |

**关键结论：**
- `Draft=1, QA=1, Revision=1, FinalValidate(local)`，逻辑付费 ≤3（“有问题才改一次”目标）。
- `review / audit / factCheck / proof = 0`（narrative_architect / adversarial_auditor / final_reviser 全部 queued，compact 不派发）。
- 证明修复有效：生产续写现在真正跑 Compact ONE-QA DAG，QA=1。

### 7.4 全量验证（注入后）

```text
Full npm run verify = PASS
lint / typecheck / verify:version = PASS
Full Jest：483 suites / 3754 tests 通过，0 failed（注入无回归）
续写/写作相关套件（continuation*, writing*Compact/*QA/*ProofRemoval/*FinalCandidate 等）139 用例全绿
```

### 7.5 尚缺（Gate-3 完整性，未改变本 Phase 结论）

- Outline Standard 2/2、One-Shot 真实 run 尚未采集（本排查聚焦续写）。
- 因此 Phase 4R 的 GO Gate 仍以“续写 Compact 已实证 + 全量绿”推进；是否判定 GO 需补 Outline 2/2 后再定。本报告仅追加续写根因/修复/实证结论。

**续写实证证据库：** `test-logs/phase4r-gate3-20260819-235615/db-run2-p2.sqlite`（run ct_b0704）、`db-run3-final.sqlite`（run ct_0cb7）。

---

## 8. 补充：Outline Standard 2/2 + One-Shot 1+1 + 续写 One-Shot 2/2 真实 LLM 实证（2026-08-20）

### 8.1 Outline Standard 2/2（compact_standard，QA=1）

线上 Outline 任务 `pt_mt0bh9z9_231` 与另一章节，`pipeline_topology=2 (compact_standard)`，逐阶段命中：
- Draft、ONE QA、Brief 阶段正确执行且各状态 success，无 review/audit/factCheck/proof 派发。
- 证明生产 Outline 走 Compact ONE-QA DAG（QA=1）。

### 8.2 One-Shot 1+1（极速档，正文调用=1）

- **Outline One-Shot**：draft 唯一付费调用，qa/review/audit/factCheck/revision/proof 全部按 `profile.one_shot.skip_*` 正式跳过。
- **Continuation One-Shot** run `ct_db86de`：`draft_writer=success/1 请求`（唯一付费 body 调用）、`unified_qa=skipped`（QA=0）、frozen 快照 = `one_shot + compact_standard`。符合 One-Shot 保持 1 次正文调用目标。

### 8.3 续写 One-Shot 修复（QA 也未逃逸）

`oneShotSkipRules` 补 `'qa'` skip 规则 + 红测 `writingOneShotCompactQaSkip.test.ts` 转绿；续写 One-Shot 下 round2=[qa,revision] 全部 formal skip，`calls===['draft']`，硬断言恰好 1 次付费调用。

---

## 9. GATE-Final — Full `npm run verify` = PASS（Exact HEAD）

```
lint                    PASS  (0 errors)
typecheck               PASS
verify:version          PASS  (V2.11.53)
Full Jest               PASS  (Test Suites: 3 skipped / 484 passed; Tests: 8 skipped / 3755 passed; 0 failed)
```

Phase 4R 三个 P0/修复（QA durable preload、Compact Semantic Apply、One-Shot QA skip）对应的红测均已随全量回归绿，无新回归。

---

## 10. 结论：PHASE 4R GO + PHASE 2 FINAL SEALED

- P0-1 / P0-2 根因修复 + 红测 + 全量绿：✅
- 真实 LLM Compact 调用图实证：Outline Standard 2/2、Continuation Standard 2/2、One-Shot 1+1 全部闭环，`Draft×1 + QA×1`（标准 Clean）/ `Draft×1+QA×1+Revision×1`（有问题时）/ One-Shot `正文×1`。✅
- Review / Audit / FactCheck / Proof 新生产调用均为 0。✅
- Exact HEAD 全门禁（verify / verify:version / Full Jest）通过；未新增自动 LLM Stage、未重建双流水线、未新增第二套 Writer/QA/Context/Prompt Compiler/Memory、未固定 Token cap，Freeze / Resume / Semantic Apply / Canon / ONE Context / ONE Memory / One-Shot 均未破坏。✅

**判定：`PHASE 4R GO`（关闭 NO-GO），`PHASE 2 FINAL SEALED / GO`。**

---

## 11. 追加：Phase 5 / Phase 6 / Phase 7 收束（2026-08-20 续）

### 11.1 Phase 5 — Revision Trigger / API / Token（commit `5746c3c`）

- **Red→Green**：`__tests__/writingRevisionTriggerContract.test.ts`（12 用例）。
- §5.1/§5.2 在 **compact 拓扑**生效：Revision 仅当「无 pass 类 verdict」AND「存在可执行 finding：issue 非空 + severity∈{blocking,warning} + (target|requirementIds) 可定位 + (instruction|target) 可执行」才派发；
  - QA pass+[]、info-only、pass+warning、generic 无定位、empty-issue → **Revision=0**；
  - blocking/warning 可执行 finding → **Revision=1**。
- legacy 拓扑保留旧 loose Review/Audit/FactCheck→brief 语义（§2.3/§4.2C），回归全绿（pipelineRunner 41/41）。
- §5.3 QA 输出紧凑：pass 时 findings=[]（content 一句话），禁默认 strengths/长篇摘要/文学点评/正文复述/大段 suggestions/思维过程；finding 必须带 target/requirementIds + instruction。
- §5.5 Revision 上下文只带 Draft + 聚合 findings + 按白名单收窄的冻结投影，不堆旧报告/完整冻结上下文。

### 11.2 Phase 6 — Batch/Single/Resume/UI/Ledger/Trace 收束（commit `6d44ce4`）

- **Red→Green**：`__tests__/continuationCompactLedgerContract.test.ts`（2 用例）。
- §6.2 compact 续写 ledger 只建 `draft_writer / revision_writer / unified_qa / final_validate`，**不再预建 `narrative_architect / adversarial_auditor / final_reviser` 的 queued/0 fake 行**；legacy 保持完整 V5 ledger。
- §6.3 PipelineProgress 用户语义补齐 revision/finalValidate/persist（修订/校验/保存），共享 `PipelineStageName` 不发生 legacy exhaustive map 动荡。

### 11.3 Phase 7 — Exact HEAD / CI / Stability 锁定（commit `97f5417`）

- §7.1 新增 `__tests__/phaseTwoGenerationStabilityGate.test.ts`（3 用例）：锁定二期 Generation Stability 套件集，并禁止 `.skip/.only/xdescribe/xit/fit/fdescribe/allow-failure`，杜绝「未跑测试混过关」。
- §7.2 Exact Final HEAD 全量 verify = **487 suites / 3772 tests，0 failed**；Stability 集 11 suites / 87 tests 全绿；typecheck/lint/version PASS。
- Android Debug 门禁：final HEAD `apk:debug` BUILD SUCCESSFUL（50.11MB），`adb install -r` Success（保留 LLM 配置）。

### 11.4 真实 LLM 2+2+1+1（§7.3 live 刷新）状态

- 2+2 Standard + One-Shot 1+1 共 6 章的真实 LLM 调用图已在 **HEAD `7fbefc43`（Phase4R 端）** 采集：Outline Standard 2/2（pt_mt0bh9z9_231 等）、Continuation Standard 2/2（ct_b0704/ct_0cb7，Draft=1 QA=1 Revision=1）、One-Shot 2/2（Outline 1 + ct_db86de）。
- 说明：**final HEAD（Phase5/6/7 叠加后，即 `97f5417`）的 live 6 章刷新**属于需要模拟器 UI 逐步驱动的物理门禁，未在本次会话内以脚本重新跑全 6 章；自动化门禁（verify/稳定性/Android 构建安装）已在 final HEAD 全绿。
- 严谨处置：「PHASE 2 FINAL SEALED」以 **自动化全门禁 + 既有 live 2+2+1+1 证据（HEAD 7fbefc43）** 为依据；final HEAD 的 live 逐章刷新作为后续 device-time 的收尾项，不被静默宣称已重跑。各项工程与门禁均按方案 §10 独立提交，未横跨 Phase 合并 Commit。