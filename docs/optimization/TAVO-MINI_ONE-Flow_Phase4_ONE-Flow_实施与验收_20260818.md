# TAVO-MINI ONE Flow Phase 4 — 接驳与压缩实测

**日期：** 2026-08-18  
**状态：** Phase 4 接驳落地，压缩长测已跑。**未封 `ONE FLOW FINAL SEALED / GO`。**

---

## 1. 已落地

| 目标 | 结果 |
|---|---|
| ONE Flow 闭环合同 | `src/services/writing/flow/oneFlowContract.ts` |
| Pipeline → Memory 唯一事件 | `WritingPersistedEvent`；Outline `finalizeChapterMemory`、Continuation `finalizeContinuationChapter` 必须先构造 |
| Memory → Context | Continuity State 作为 `structured_continuity_state` candidate 进入 Adapter，再走 ONE Budget / Freeze |
| Batch Ready | `evaluatePostWritingMemoryReady` + 旧 pending 回放 `replayPendingContinuityProposals` |
| 无第二套 Writer / Budget / LTM | 门禁扫描保持 |

闭环：

```text
Memory / Canon / State
  → Context Candidates
  → ONE Planner / Elastic Budget / Freeze
  → ONE Pipeline DAG
  → Persist
  → WritingPersistedEvent
  → Story Memory + Continuity State
  → Next Chapter Ready
```

---

## 2. 压缩实测（用户指定 2+2+2+批次2）

设备：`emulator-5554`，升级安装 `dist/apk/debug/ShineWriter-V2.11.53-debug.apk`（`adb install -r`，保留 LLM）。

| 样本 | 批次 | 结果 | Paid / 调用 | 备注 |
|---|---|---|---|---|
| Outline 连续 2 章 + Batch 一组 2 章 | `batch_msyc1epo_gufq7b` | **2/2 completed**，`full_pipeline` | 11 次（含规划） | 暗流 / 灯塔之下。UI 显示思考「中」，行冻结 `reasoning_effort=high` |
| Continuation 连续 2 章 | `batch_msydcv9j_ipn5a1` | 第 1 章 **full_pipeline**；第 2 章正文已定稿 2191 字，item=`failed` | 10 次 | 见 §4 |
| One-Shot 连续 2 章 | `batch_msyfdvob_fagwlm` | **2/2 completed** | **2**（每章 1） | 雨夜孤港 / 亡者遗言。`execution_profile=one_shot` |

本轮按用户要求压缩为每组 2 章，**不是**方案原文的 10/10/5。禁止据此宣布最终封板。

---

## 3. 冲突弹窗（对照方案）

总路线 §5.4 / §12.3：

- 正常 State Extraction **不再**等人（Auto Validate / Commit）
- **仍保留**冲突确认：Canon 冲突、重大状态冲突、无法自动合并、低置信且影响后续

这次弹出的「31 项状态冲突」**不是**第 11 章新提取出来的冲突。

库证：31 条 `pending` 全部 `created_at=2026-08-17`，来自第 72/73/74/76 章（Phase 1 之前）。`countPendingMajorProposals` 把所有 `pending` 当成冲突门。Phase 1 当时明确欠「旧 pending 不自动回放」。

本轮补了 `replayPendingContinuityProposals`：进批次下一章门和续写首页前，先用同一套分类器回放；普通残留自动提交，真冲突才留审核页。

第 2 章续写后来被另一条旧失败挡住：`rebuild_story_memory` on chapter 72，`故事记忆在整理期间发生了变化，本批次未写入。` 重试仍失败。正文已落库，批次未标 2/2。

---

## 4. 门禁

| 项 | 结果 |
|---|---|
| `__tests__/writingOneFlowPhase4Flow.test.ts` | 含闭环、PersistedEvent、State candidate、旧 pending 分类、One-Shot skip |
| typecheck | PASS |
| 生成稳定性清单 | 已挂 Phase 4 文件 |

---

## 5. 明确不做 / 仍欠

- 未宣布 `ONE FLOW FINAL SEALED / GO`
- 未按原文跑 10/10/5
- 未重写 Writer / Elastic Budget / Canon
- 续写批次未干净 2/2（旧 SM rebuild fail）
- 旧 pending 回放已合入代码，本轮安装的 APK 早于该补丁；本机 31 条是人工「全部确认」清掉的
