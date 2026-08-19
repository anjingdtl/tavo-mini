# TAVO-MINI Phase 2 — Phase 0 验收报告（第二期 Baseline 与调用成本固化）

- **日期：** 2026-08-19
- **施工基线：** `E:\AiWorkSpace\tavo-mini`（唯一基线）
- **改动性质：** 只观察，不改变生产行为
- **对应方案章节：** `docs/optimization/TAVO-MINI_第二期_Standard-Pipeline深度收束与流水线提速总方案_V1.0.md` §3

---

## 1. PLAN — 基线目标

二期 Phase 0 不改变任何生产行为，只把当前 Standard 的真实调用口径与关键路径固定下来，作为后续 Phase 1–7 的「Before」基准。

### 1.1 需要固化的口径

| 口径 | 定义 | 现状来源 |
|---|---|---|
| Logical Stage Call | 逻辑阶段调用次数 | `WritingLlmCallRecord.kind === 'logical_stage'`（`writingChapterObservability.ts`） |
| Formatter Call | Shared Writer 二次（Formatter）调用 | `kind === 'formatter'` |
| Physical Request | 真实 HTTP 请求数 | `physicalRequestCount`（含 protocol fallback） |
| Protocol Fallback | 协议降级次数 | `protocolFallbackCount` |
| Stage Token | 每阶段 input/output token | `WritingStageTimingRecord.inputTokens/outputTokens` |
| Stage Latency | 每阶段执行时长 | `WritingStageTimingRecord.stageExecutionMs` 等 |

### 1.2 需要固化的调用图（当前现状）

从真实代码 `WRITING_STAGE_DAG` + 两 Source Adapter 的 frozen skipRules 得出：

**Outline Standard（owv=4 当前）**
```
draft → review → factCheck → revision(brief) → proof → finalValidate → persist
```
付费逻辑阶段 = `[draft, review, factCheck, revision, proof]` = **5 次**

**Continuation V5（当前）**
```
draft → review → audit → revision(brief) → proof → finalValidate → persist
```
付费逻辑阶段 = `[draft, review, audit, revision, proof]` = **5 次**

**One-Shot（极速，封板不变）**
```
draft → finalValidate → persist
```
付费逻辑阶段 = `[draft]` = **1 次**

---

## 2. DO — 施工内容

Phase 0 仅新增观察性测试，零生产代码改动：

- 新增 `__tests__/writingPhase2Baseline.test.ts`，4 个用例：
  - **B1**：断言当前生产 DAG 以 `WRITING_STAGE_DAG` 为唯一权威（串行 draft→revision→proof→finalValidate→persist；QA 并行组 review/audit/factCheck）。
  - **B2**：用真实 Freeze 管线生成 **Outline Standard 2 章 + Continuation Standard 2 章 + One-Shot 1+1** 结构基线（`test-logs/phase2-structural-baseline.json`），断言两 Source Adapter 在同一个 Standard Kernel 上的付费阶段位形。
  - **B3**：证明 Logical / Formatter / Physical / Protocol-fallback 四口径在每章、每阶段可区分且可聚合。
  - **B4**：证明 `finalizeWritingKernelObservability` 能把快照挂回 trace（可持久化基线数据的通道）。

真实 LLM 的 2+2+1+1 样本按一期先例以结构基线先行（`measureStructuralChapterObservability` 走真实 Freeze + 编译每个付费阶段，不触发付费），真实付费样本在 Phase 3 / Phase 7 验收。

---

## 3. CHECK — 验证

### 3.1 四口径可区分 / 可聚合

- `summarizeWritingLlmCalls` 独立累计 logical / formatter / physical / protocolFallback。
- `WritingLlmSnapshot` 给出章级四计数器；`WritingStageTimingRecord` 给出阶段级四计数器 + token + 时长。
- B3 实测：2 logical + 1 formatter + 1 protocol fallback → 章级 `{logical:2, formatter:1, physical:4, fallback:1, input:600, output:130}`，阶段级聚合一致。

### 3.2 Stage Token / Latency 按章聚合

- 每阶段 `inputTokens / outputTokens / stageExecutionMs` 可累加为章级汇总（B3 聚合断言通过）。
- `pipeline_stage_attempts` 是逐 HTTP 请求权威账本；`pipeline_stage_checkpoints` 是逐 task×stage 权威状态；`llm_usage_logs` 是全局计费账本。

### 3.3 One-Shot 基线

- One-Shot Outline 与 Continuation 均 `chapterWritingPaidCallCount === 1`，付费阶段位形 `['draft']`。

### 3.4 回归

- `npm run verify`（lint + typecheck + Jest CI）全绿：**474 suites passed（4 skipped），3676 tests passed，9 skipped，0 failed**。

---

## 4. ACT — GO / NO-GO

| GO Gate | 结果 |
|---|---|
| Baseline 数据可读取 | ✅ `phase2-structural-baseline.json` + observability 契约 |
| Logical / Formatter / Physical / Fallback 四口径可区分 | ✅ B3 |
| Stage Token 可按章聚合 | ✅ B3 / checkpoint / attempts |
| Stage latency 可按章聚合 | ✅ B3（stageExecutionMs 等） |
| Current DAG 明确 | ✅ `WRITING_STAGE_DAG` 为单一权威 |
| One-Shot 基线仍为 1-call | ✅ B2（outline + continuation） |
| Full Jest = PASS | ✅ 474 suites / 3676 tests |
| Typecheck = PASS | ✅ |
| Lint = PASS | ✅ |

## 结论：PHASE 0 GO ✅

---

## 5. 附：当前调用图（Phase 0 记录，作为「Before」）

```
Standard Production（两个 Source Adapter，同一 Kernel）:
Outline:  draft → review → factCheck → revision → proof → [finalValidate → persist]
Continuation: draft → review → audit → revision → proof → [finalValidate → persist]
付费次数: 5（逻辑） ≈ 5（物理，无 formatter/fallback 时）
One-Shot:  draft → [finalValidate → persist]
付费次数: 1（逻辑） ≈ 1（物理）
```

二期最终目标（After，Phase 7 后）：
```
Compact Standard: draft → QA → revision? → [finalValidate → persist]
正常 ≤ 2 次逻辑 LLM，需修订 ≤ 3 次；One-Shot = 1 次
```
