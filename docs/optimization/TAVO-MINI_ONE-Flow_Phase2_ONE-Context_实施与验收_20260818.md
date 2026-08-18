# TAVO-MINI ONE Flow Phase 2 — ONE Context 实施与验收

**日期：** 2026-08-18  
**状态：** **部分建设（PARTIAL）。未封。** 必须在 ONE Memory 之后继续 PDCA，不得宣布 `ONE FLOW FINAL SEALED / GO`。

---

## 1. 本轮已落地

| 目标 | 本轮 |
|---|---|
| Production Context Planner = 1 | 仍是 `buildWritingContextPlan`（未新增第二套 Planner） |
| Final Budget Decision = 1（Kernel 通用） | 仍是 `allocateWritingContextBudget` |
| Frozen Context Truth = 1 | 未改 Freeze 算法 |
| Adapter 不做最终 Budget | Outline / Continuation Writing Adapter 仍只出 candidate |
| 无新固定输入 Token 上限 | Projection / Aggregator 无 32K / 100K cap |
| Deterministic Stage Projection | **已接入** Shared Prompt Compiler |
| Findings Aggregator | **已接入** Revision / Proof 的 previous artifacts |

### 调用图（本轮）

```text
Source Adapters
  → collect / normalize
  → ONE Planner (buildWritingContextPlan)
  → ONE generic budget (allocateWritingContextBudget)
  → ONE Render / ONE Freeze
  → compileSharedWritingPrompt
        → projectFrozenContextForStage   // 确定性切片，不再预算
        → previousArtifactBlock(stage)
              → aggregateStageFindings   // Revision/Proof 不再叠完整报告
```

Stage 切片（kind allowlist，不是五套 Budget）：

| Stage | 切片 |
|---|---|
| Draft | 完整 Frozen Render |
| Review | instruction / outline / writer_style / preset / note |
| Audit / FactCheck | canon / boundary / seam / anchor / character / worldbook / story_memory |
| Revision | instruction / outline / canon / boundary / writer_style / story_memory + 初稿 + 汇总 Findings |
| Proof | writer_style / instruction + 终稿候选 + 汇总 Findings |

---

## 2. 明确未做（下一刀）

- **未**拆除 `continuationSourceCollection.planContinuationContextBudget`（场景侧布局预算仍在，不是本轮 Fake 统一）。
- **未**把 Elastic / Hierarchical 数学收成新公式。
- **未**改 Canon / Story Memory / Writer Core。
- **未**跑 10 章真实 LLM 长测。Before/After 墙钟仍以 Phase 0 基线为准。

`planContinuationContextBudget` 仍是 Phase 2 剩余债：场景收集阶段的布局预算，必须在确认不破坏 Continuation Freeze 后再并入 ONE Budget 入口。

---

## 3. 门禁

| 项 | 结果 |
|---|---|
| `__tests__/writingOneFlowPhase2Context.test.ts` | PASS |
| Generation Stability yml | 已挂上 |
| 受影响 writing 套件（20 suites / 130 tests） | PASS |
| typecheck / eslint（本轮文件） | PASS |

---

## 4. 决策

**继续 PDCA，不封 Phase 2。**  
下一刀：审计并收束 Continuation Source Collection 的第二套布局预算，且必须先红灯再动生产。
