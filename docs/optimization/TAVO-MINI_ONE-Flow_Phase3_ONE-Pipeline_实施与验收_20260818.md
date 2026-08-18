# TAVO-MINI ONE Flow Phase 3 — ONE Pipeline

**状态：** 尚未开始。必须在 ONE Memory / ONE Context 稳定后进入。

目标：

- ONE Orchestrator + ONE Stage DAG + ONE Stage Policy
- Draft → (Review ∥ Audit/FactCheck) → Findings Aggregator → Conditional Revision → Conditional/Required Proof → Local FinalValidate → Persist
- Revision / Proof 无真实问题时必须 `status=skipped` + `skipReason` + `policyRuleId`，禁止 Fake Completed
- 只并发数据依赖独立的 Stage；禁止 Promise.all 全流水线
- 复用现有 Scheduler 的 pipeline / same-project 并发，不重造第二套 Scheduler
- Proof 去留必须用 Phase 0 的质量/性能基线做 A/B，不得只为提速直接砍
