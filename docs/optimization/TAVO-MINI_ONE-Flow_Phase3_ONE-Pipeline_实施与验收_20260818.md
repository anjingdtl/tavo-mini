# TAVO-MINI ONE Flow Phase 3 — ONE Pipeline 实施与验收

**日期：** 2026-08-18  
**状态：** Phase 3 本轮完成（可进入 Phase 4 集成）。**未封 `ONE FLOW FINAL SEALED / GO`。**

---

## 1. 已落地

| 目标 | 结果 |
|---|---|
| ONE Orchestrator | 仍是 `runWritingStages` |
| ONE Stage DAG | `WRITING_STAGE_DAG` 显式依赖，不再只靠数组顺序 |
| Conservative QA 并行 | Draft 之后 Review ∥ Audit/FactCheck（同一 wave，`Promise.all` 仅这一组） |
| Revision 不与 Review 并行 | DAG 禁止 |
| Conditional Revision | 无执行 findings → `skipped` + `policy.one_pipeline.conditional_revision_no_findings` |
| Conditional Proof | 默认 standard **仍 Required**；仅 `values.proofPolicy === 'conditional'` 才可跳 |
| Formal skip | 禁止 Fake Completed |
| Scheduler | 复用现有 pipeline / same-project 上限（2），不重造 |
| One-Shot | Paid Draft 仍 = 1 |

### DAG

```text
Draft
  ├→ Review
  └→ Audit / FactCheck
        ↓
Conditional Revision
        ↓
Proof (standard required)
        ↓
Local FinalValidate
        ↓
Persist
```

Outline 已有 `run_review_and_fact_check`；runner 现在真并行这两步。  
Continuation driver 仍按轮次切批，但同一批内由 DAG 保证 Audit/FactCheck 先于 Revision。

Brief 正式 skip 不再被 `determineNextPipelineAction` 当成失败 Brief，而是进入 Proof。

---

## 2. 明确不做

- 未为提速默认砍 Proof（无真实 A/B 长测前保持 Required）
- 未 `Promise.all` 全流水线
- 未重写 Writer / Budget / Canon
- 未跑 10 章真实 LLM

---

## 3. 门禁

`__tests__/writingOneFlowPhase3Pipeline.test.ts`：DAG、条件 Revision、One-Shot 1 call、skipped brief → proof。
