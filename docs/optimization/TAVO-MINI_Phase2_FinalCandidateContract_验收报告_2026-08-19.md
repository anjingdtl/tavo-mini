# TAVO-MINI Phase 2 — Phase 1 验收报告（Final Candidate Contract 收束）

- **日期：** 2026-08-19
- **施工基线：** `E:\AiWorkSpace\tavo-mini`（唯一基线）
- **改动性质：** 确立「谁是最终正文」的单一真值合同；FinalValidate / Persist 只消费它
- **对应方案章节：** `docs/optimization/TAVO-MINI_第二期_Standard-Pipeline深度收束与流水线提速总方案_V1.0.md` §4
- **Commit：** `refactor(writing): establish proof-independent final candidate contract`

---

## 1. PLAN — 基线 / 根因 / 影响边界

### 1.1 Baseline（Before）

- 删除 Proof 前，系统必须回答「没有 Proof 时谁是最终正文」。
- 现有 FinalValidate 虽能 `proof → revision → draft` 选择正文，但最终 metadata 主要来自 `proof` / `revision`；若 `Draft → QA PASS → Revision SKIP → Proof removed`，会丢 `appliedRequirementIds / structured / validNoOp*`，导致 Semantic Apply false fail 与 Requirement Result 漂移。
- Persist 仍各自再拼一遍 `proof → revision → draft` 双重真值（双真相风险）。

### 1.2 Root Cause

缺少一个**纯本地、不读 live DB** 的单一解析函数；`finalValidate` 与 `persist` 各自维护优先级链。

### 1.3 Impact Boundary

- 只影响写入链路尾部：FinalValidate / Persist 消费最终正文的方式。
- 不改变：Draft / Review / Audit / FactCheck / Revision / Proof 的生成行为、Freeze、Resume、Semantic Apply 判定规则。
- 不读取 live DB（纯本地函数），不新增任何 LLM Stage。

### 1.4 Red Tests（方案 §4.6 Case 1–6 + compact/legacy/flag）

| Case | 断言 |
|---|---|
| C1 | 仅 Draft + revision/proof 正式 skip → FinalValidate PASS，body=Draft |
| C2 | Draft 带 appliedRequirementIds + validNoOp → FinalValidate 完整继承 |
| C3 | Revision 存在 → Revision 覆盖 Draft 成为 Final Candidate |
| C4 | Revision 存在但正文空（非 skip）→ fail-closed，不偷偷回退 Draft |
| C5 | 全空正文 → `FINAL_BODY_MISSING` |
| C6 | Semantic Apply failed → FinalValidate failed，不落库 |
| +1 | compact 模式 proof 不作为候选（Proof dependency = 0） |
| +2 | legacy 模式 proof 仍可作首候选（Resume 兼容） |
| +3 | policy flag `pipelineTopologyVersion==='compact_standard'` 选 compact 模式 |
| +4 | compact 下 revision 优先且继承 metadata |

### 1.5 Expected Call Graph（不变）

```
Draft → [Review/Audit/FactCheck] → Conditional Revision → Proof → FinalValidate → Persist
                                      （最终正文来源 = resolveFinalWritingCandidate：revision → draft）
```

---

## 2. DO — 施工内容（最小改动，无顺手重构）

- 🆕 `src/services/writing/stages/finalCandidate.ts`
  - `resolveFinalWritingCandidate(artifacts, {mode})`：纯本地，不读 live DB。
  - `compact` → `[revision, draft]`（无 proof）；`legacy` → `[proof, revision, draft]`。
  - 正式 skip（`structured.skipped===true`）不作为候选；非 skip 空正文 fail-closed，不偷偷回退。
  - 完整继承中标阶段的 `appliedRequirementIds / validNoOpRequirementIds / validNoOpReasons`。
  - `finalCandidateModeForPolicy(policy)`：`values.pipelineTopologyVersion==='compact_standard'` → compact（为 Phase 2 预留）。
- ✏️ `src/services/writing/stages/finalValidate.ts` — 只消费 `resolveFinalWritingCandidate`；修复「draft 带 appliedRequirementIds 时 metadata 丢失」；空候选 → `FINAL_BODY_MISSING`。
- ✏️ `src/services/writing/stages/persist.ts` — 只消费已校验候选（默认优先 `artifacts.finalValidate`），不再自己拼 proof→revision→draft 双重真值；空 → `PERSIST_BODY_MISSING`。
- ✏️ `src/services/writing/contracts/writingStage.ts` — `SharedWritingArtifact` 增加 `sourceStage?: 'proof'|'revision'|'draft'|null`。
- 🆕 `__tests__/writingFinalCandidateContract.test.ts`（10 用例，覆盖方案 §4.6 Case 1–6 + compact/legacy/flag）。

---

## 3. CHECK — 验证

### 3.1 Focused Tests

- `writingFinalCandidateContract.test.ts`：**10/10 PASS**。
- `writingPhase2Baseline.test.ts`（Phase 0 回归）：**4/4 PASS**。

### 3.2 Architecture Gates（方案 §4.7）

| Gate | 证据 |
|---|---|
| Final Candidate Truth = 1 | `resolveFinalWritingCandidate` 唯一解析点；finalValidate / persist 均消费它 |
| Draft-only final path = PASS | C1 / C2 |
| Revision final path = PASS | C3 |
| Requirement metadata preserved | C2 / C4（appliedRequirementIds / validNoOp 完整继承） |
| Semantic Apply unchanged | 判定规则未动；C6 仍失败不落库 |
| Persist consumes validated candidate | `persist.ts` 默认消费 `artifacts.finalValidate`，回退也走同一候选函数 |
| Proof dependency in new final contract = 0 | compact 候选列表无 proof（+1） |
| Post-Freeze live read = 0 | `resolveFinalWritingCandidate` 纯本地，无 DB / 网络读取 |

### 3.3 Full Regression

- `npm run verify`（lint + typecheck + verify:version + Jest CI）全绿：**475 suites passed（4 skipped），3686 tests passed（9 skipped），0 failed**，exit code 0。
- Generation Stability：已随 test:ci 的 gate suites 覆盖（一期 `ci(generation-stability)` 引入），Phase 1 无生成行为改动。

### 3.4 Android Debug

- `npm run apk:debug`（干净串行重建）：**BUILD SUCCESSFUL**，输出 `dist/apk/debug/ShineWriter-V2.11.53-debug.apk`（56.55 MB），exit code 0。
- 并发误操作导致的 Metro 文件锁报错为环境/误操作产物；本次干净构建未复现。

---

## 4. ACT — GO / NO-GO

| GO Gate（方案 §4.7） | 结果 |
|---|---|
| Final Candidate Truth = 1 | ✅ |
| Draft-only final path = PASS | ✅ |
| Revision final path = PASS | ✅ |
| Requirement metadata preserved | ✅ |
| Semantic Apply unchanged | ✅ |
| Persist consumes validated candidate | ✅ |
| Proof dependency in new final contract = 0 | ✅ |
| Post-Freeze live read = 0 | ✅ |
| Full Jest = PASS | ✅ 475 suites / 3686 tests |
| Generation Stability = PASS | ✅ test:ci gate suites 覆盖 |
| Android Debug = PASS | ✅ 56.55 MB / EXIT=0 |

## 结论：PHASE 1 GO ✅

Phase 1 封板，允许进入 Phase 2（Pipeline Topology Version + Resume Contract）。

---

## 5. 附：遗留 / 前置说明

- `finalCandidateModeForPolicy` 已按 `pipelineTopologyVersion==='compact_standard'` 预留 compact 模式，但 Phase 1 尚未有任务真正冻结该 topology（Phase 2 落地）。
- 正式 skip 语义与 fail-closed 语义保持一期封板行为，未做任何放宽。
