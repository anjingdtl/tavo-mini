# TAVO-MINI ONE Flow Phase 2 — ONE Context 实施与验收

**日期：** 2026-08-18  
**状态：** Phase 2 本轮收束完成（可进入 Phase 3）。**未封 `ONE FLOW FINAL SEALED / GO`。**

---

## 1. 已落地

| 目标 | 结果 |
|---|---|
| Production Context Planner = 1 | `buildWritingContextPlan` |
| Final Budget Decision = 1 | `allocateWritingContextBudget` 是唯一写入 `FrozenWritingContext.allocation` 的决策 |
| Frozen Context Truth = 1 | Freeze 算法未重写 |
| Adapter 不做最终 Budget | Writing Adapter 只出 candidate |
| 无新固定输入 Token 上限 | Projection / Aggregator / Demand planner 均无 32K/100K cap |
| Deterministic Stage Projection | Shared Compiler 已接入 |
| Findings Aggregator | Revision / Proof 消费汇总 Findings |
| 去除双层最终 Budget | Collection 改为 **fetch demand**；软 overflow 不再当最终闸门 |

### 调用图

```text
Source Adapters / Collection demand (I/O bound)
  → collect / normalize
  → ONE Planner (buildWritingContextPlan)
  → ONE generic budget (allocateWritingContextBudget)
  → ONE Render / ONE Freeze
  → compileSharedWritingPrompt
        → projectFrozenContextForStage
        → previousArtifactBlock(stage) + aggregateStageFindings
```

Continuation `planContinuationSourceDemand` / 既有 `planContinuationContextBudget` 数学 **只用于采集时限制 Canon/接缝/记忆读取量**，不再对“已组装软 token 超窗”做第二套最终失败。硬 Canon / 锁定规则超窗仍 fail-closed。

`planContinuationV4ContextBudget` 仍只在采集路径上给 Writer envelope 做 fetch bound，不进入 Freeze allocation。

---

## 2. 门禁

| 项 | 结果 |
|---|---|
| `__tests__/writingOneFlowPhase2Context.test.ts` | 含 collection≠final budget 硬门禁 |
| typecheck | PASS |
| 未跑新的 10 章真实 LLM | 仍以 Phase 0 基线对照 |

---

## 3. 明确不做

- 未重写 Elastic / Hierarchical 数学模型
- 未重写 Canon / Story Memory / Writer
- 未宣称 ONE FLOW FINAL SEALED
