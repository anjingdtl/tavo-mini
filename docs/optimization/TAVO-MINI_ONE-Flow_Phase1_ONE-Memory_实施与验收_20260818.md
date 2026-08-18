# TAVO-MINI ONE Flow Phase 1 — ONE Memory 实施与验收

**日期：** 2026-08-18  
**仓库：** `E:\AiWorkSpace\tavo-mini`  
**状态：** Phase 1 本轮完成（可进入 Phase 2）。**未封 `ONE FLOW FINAL SEALED / GO`。**

---

## 1. 本轮范围

只做 ONE Memory 收束，不重写 Story Memory / Canon / Writer / Budget。

| 目标 | 结果 |
|---|---|
| Narrative Long-Term Memory System Count = 1 | Story Memory（`src/services/storyMemory` + `project_story_memory`） |
| Outline uses Story Memory | `outlineWritingAdapter` 继续发 `story_memory` candidate |
| Continuation uses Story Memory | `continuationWritingAdapter` 继续发 `story_memory` + `episodic_memory` |
| Continuation Second Long-Term Memory = 0 | 未新增 ContinuationMemory / FastMemory / OneShotMemory |
| Structured Continuity State retained | `getEffectiveContinuationState` + events / proposals 仍在 |
| Canon retained | 仍只通过 `CanonQueryService` 读 |
| Normal User Confirmation Barrier = 0 | 提取后 routine proposal 自动 commit |
| Conflict-only confirmation retained | Canon / 重大冲突 / 无法合并 / 低置信且影响后续 仍进审核页 |

---

## 2. 真实调用图（改前 / 改后）

### 改前

```text
Persist / finalize
  → extract_state outbox
      → insertProposals(status=pending)
          → 用户必须在 ContinuationStateReviewScreen 确认每一条
              → confirmProposal → state event + dirty Story Memory
  → 下一批次 / strict 下一章被 pending major proposal 挡住
```

`countPendingMajorProposals` 把 `character_state` / `relationship_change` / `new_world_fact` / `new_character` 全部算作“重大”，等于正常章节每次都有人工 Barrier。

### 改后

```text
Persist / finalize
  → extract_state outbox
      → insertProposals
      → Local Validate + Canon hard-fact check
      → 正常项 commitAcceptedProposal（auto_commit，不弹用户）
      → 冲突 / 无法合并 / 低置信且影响后续 保持 pending
  → Story Memory 仍是唯一长期叙事记忆
  → Batch：普通 State Update 不再等人；仅剩余确认项才 BATCH_CONTINUATION_STATE_CONFLICT
```

权威（policy，不改 Canon / SM 算法）：

```text
Canon > Frozen Source Boundary > Structured Continuity State > Story Memory > Recent Prose

Story Memory ≠ Canon            → Canon 胜
Story Memory ≠ Continuity State → State 胜
Continuity State ≠ Canon(硬事实) → Conflict Gate
```

硬事实：`aliveState` / `identityState` / `knowledgeBoundary`。  
软运行时：`location` / `physicalState` / `emotionalState` / `currentGoal` / `activePlotThread` 允许 State 覆盖。

---

## 3. 落地文件

| 文件 | 作用 |
|---|---|
| `src/services/writing/memory/memoryAuthority.ts` | 权威序 + 硬事实冲突 + 融合时省略冲突硬字段 |
| `src/services/writing/memory/continuityStateCommitPolicy.ts` | auto-commit vs 用户确认分类 |
| `src/services/writing/memory/continuityStateAutoCommit.ts` | 提取后自动提交；只被 outbox worker 直接引用 |
| `src/services/writing/memory/oneMemoryContract.ts` | ONE Memory 契约 / 禁止第二套 LTM 文件 |
| `src/services/writing/memory/postWritingMemoryReady.ts` | PostWriting Ready Gate（提取未完成不可进下一章 Freeze） |
| `src/services/continuation/generation/commitStateProposal.ts` | 无 LLM、无 worker 依赖的 durable commit（打破循环） |
| `continuationStateOutboxWorker.ts` | extract 后调用 auto-commit |
| `continuationStateService.ts` | 融合时走权威规则；`confirmProposal` 变薄封装 |
| `generationRepository.ts` | `countPendingMajorProposals` = 全部剩余 pending |
| `continuationBatchStateGate.ts` | 剩余确认项 → `BATCH_CONTINUATION_STATE_CONFLICT` |
| 审核 / 首页文案 | 改为“冲突待确认 / 正常已自动提交” |

**没有**重写 `storyMemoryService`、Canon 分析、Writer Core、Elastic Budget。

---

## 4. 门禁

| 项 | 结果 |
|---|---|
| 新硬门禁 | `__tests__/writingOneFlowPhase1Memory.test.ts` |
| Generation Stability | `.github/workflows/generation-stability.yml` 已挂上该文件 |
| lint（本轮改动） | 0 errors |
| typecheck | PASS |
| verify:version | PASS，V2.11.53 / 2115300 |
| Full Jest | PASS，466 suites / 3613 tests（review 修动态 import 前） |
| 修动态 import 后 focused | PASS，`writingOneFlowPhase1Memory` + outbox + repository + review UI |

---

## 5. Review 发现与修复

1. **动态 `import(confirmProposal)` 在 RN/Jest 下会丢。** 一旦失败，extract 的 fail-soft 会把所有 proposal 留在 pending，Barrier 等于没拆。  
   **修复：** 把 durable commit 抽到 `commitStateProposal.ts`（不依赖 worker），auto-commit 静态调用 `commitAcceptedProposal`。
2. **`writing` barrel 不得间接加载 CanonQueryService。** auto-commit 不再从 `src/services/writing/memory/index.ts` 再导出。
3. 审核页 / 首页文案与 `continuationStateReviewUi` 空态同步。

---

## 6. 明确不做 / 仍欠

- 未重写 Story Memory / Canon / Elastic Budget / Writer。
- 未改 Schema。
- 未跑新的 10 章真实 LLM 长测（仍用 Phase 0 基线）。
- Ready Gate 对 **单章 balanced** 下一章 Freeze 仍不硬挡（避免把提取慢变成交互阻断）；**Batch** 继续等 extract + SM rebuild，并对剩余冲突 fail-closed。
- 旧库里已经 pending 的“普通状态”不会自动回放提交，用户可在审核页一次确认；新提取不再产生这类 Barrier。

---

## 7. 决策

**GO — 进入 Phase 2 ONE Context。**

下一刀：Source Adapter 只提供 candidate；最终 Budget / Freeze 仍走现有 Elastic / Hierarchical；补 Stage Projection 与 Findings Aggregator 的红灯与最小骨架。不重造 Budget 数学模型。
