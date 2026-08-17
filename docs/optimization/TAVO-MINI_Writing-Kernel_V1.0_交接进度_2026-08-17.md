# Writing Kernel V1.0 交接进度

**日期：** 2026-08-17  
**仓库：** `E:\AiWorkSpace\tavo-mini`（唯一执行基线）  
**方案：** `docs/optimization/TAVO-MINI_Writing-Kernel_最终收束与防改名糊弄验收方案_V1.0.md`  
**本轮目标：** ONE Production Writing Kernel + ONE Shared Writer Core + ONE Shared Stage Implementation  
**封板状态：** **未封。禁止宣布 FINAL SEALED / GO。**

> **2026-08-17 补记：** Kernel 收束后一次通过率明显下降。根因不是“Writer 还没统一”，而是 V3.2 双通道采用、一次 Formatter、每阶段 Freeze thinking、Brief 压缩修订被当成旧 Core 丢掉。补救必须发生在 Shared Writer 内。详见 `TAVO-MINI_Writing-Kernel_一次通过契约收回进度_20260817.md`。不要再只盯单个 `reasoning_only` / 300s 超时修补丁。

---

## 1. 下一任必须先知道的结论

1. 这轮已经把 **生产写正文权威** 从 Outline/Continuation 场景 Core 抽到共享层。判断标准是 Production Call Graph，不是文件名。
2. `SharedWritingStageInput.execute()` 已删除。共享 Stage 不再通过 callback 回跳场景 Writer。
3. Outline 3/3、Continuation 3/3 真实 LLM 实测 **还没做**。Debug APK / `adb install -r` / lint / typecheck / Full Jest / Generation Stability / Replay x10 **本轮未跑完**。
4. `src/services/continuation/generation/legacy/continuationV5Writers.ts` **仍是一整套完整 Writer**（Draft / Architect / Revision / Auditor / Final Reviser）。它只被 `legacy/` 引用。硬门禁用 `!name.includes('/legacy/')` 排除了它。这 **不算收束完成**，下一任不得把它当“已经统一”。
5. 不要用改名、搬目录、Facade、Capability 包装、`async () => undefined` 把测试做绿。方案第 3 节明确这是 NO-GO。

---

## 2. 当前生产调用图（已落地）

```text
UI / batch / resume
  → runWritingKernel / runOutlineWritingKernel / runContinuationWritingKernel
      → createOutlineStageDriver / createContinuationStageDriver
          → Freeze（一次）
          → runWritingStages
              → runDraftStage / runReviewStage / runAuditStage / runFactCheckStage
                / runRevisionStage / runProofStage / runFinalValidateStage / runPersistStage
                  → executeSharedWriterStage          # 唯一生产 Writer LLM
                      → compileSharedWritingPrompt    # 唯一生产 Prompt 编译入口
                      → callWritingStageLLM
```

场景层允许留下的东西：

- Source Adapter / Requirement / Policy / Validator / Plugin
- Durable adapter（CAS、checkpoint、ledger、attempt）
- Freeze 前收集 Canon / Boundary / Seam / Anchor / Style / Obligation

场景层 **不得** 再掌握完整 Writer LLM / Prompt / Revision / Final Reviser。

---

## 3. 关键文件

### 共享内核（新权威）

| 路径 | 职责 |
|---|---|
| `src/services/writing/stages/writerCore.ts` | 唯一 Shared Writer Core。LLM、空输出、结构化报告校验、usage |
| `src/services/writing/prompt/sharedPromptCompiler.ts` | 唯一生产 Prompt 编译入口 |
| `src/services/writing/prompt/requirementProjection.ts` | Requirement / 前序 Artifact 投影 |
| `src/services/writing/stages/{draft,review,audit,factCheck,revision,proof,finalValidate,persist}.ts` | 各 Stage 各一套具体实现 |
| `src/services/writing/stages/writingStageRunner.ts` | 唯一 post-Freeze dispatcher |
| `src/services/writing/contracts/writingPolicy.ts` | `skipRules` + 正式 `skipped` |
| `src/services/writing/contracts/writingStage.ts` | 无 `execute()`；有 `persistAdapter` / `persistStageFailure` / `usage` |

### Outline 耐久层（不是第二套 Writer）

| 路径 | 职责 |
|---|---|
| `src/services/writing/execution/outlineStageDriver.ts` | 状态机一步一步走。写阶段走耐久操作，**不再**自己直接跑 Writer |
| `src/services/writing/execution/runOutlineSharedWriterAction.ts` | CAS claim + `pipeline_stage_attempts` + `runWritingStages` |
| `src/services/writing/persistence/outlineDurableAdapter.ts` | checkpoint / `persistTaskStage` / 失败落库 / token |
| `src/services/pipeline/outlineStageRuntime.ts` | durable 操作、retry、finalize、complete。Writer LLM 已剥离 |

`runOneAction()` 约定：

- `run_draft` / `run_review` / `run_fact_check` / `run_brief` / `run_proof` → `runOutlineDurableOperation` → `runSharedOutlineWriterAction`
- `finalize_from_*` 先跑共享 `finalValidate` + `persist`，再跑 durable finalize（complete / fail / 通知）
- Freeze 通过 `ReconcileOptions.frozenWritingContext` / `writingKernelTrace` 传入 Shared Writer
- **禁止** 为了让 Shared Writer 读到 Freeze，去改写历史 envelope JSON。`parsePersistedPipelineTaskContext` 会按 hash 验签，改了会 `SNAPSHOT_PARSE_FAILED`

### Continuation

| 路径 | 职责 |
|---|---|
| `src/services/writing/execution/continuationStageDriver.ts` | ledger → draft/review → revision/audit/factCheck → proof/finalValidate/persist |
| `src/services/writing/persistence/continuationDurableAdapter.ts` | V5 ledger artifact / stage_result |
| `src/services/writing/stages/continuationStageCapabilities.ts` | **只剩 ledger / 失败落库**，不再写正文 |

生产入口是 `runContinuationWritingKernel()`。UI / batch 不再走 `legacy/startContinuationRun`。

### 遗留第二套 Writer（未清干净）

```text
src/services/continuation/generation/legacy/continuationV5Writers.ts
  ↑
legacy/continuationV5Pipeline.ts
legacy/continuationV5Runner.ts
```

内部仍有 `runContinuationDraftCapability` / RevisionAndAudit / Proof / `compileContinuationV5*` / `callWritingStageLLM`。  
生产路径不进口。硬门禁目前扫不到。下一任若要封板，必须处理它：删除、或保证没有任何生产 import，并把门禁扩到“生产 import graph = 0”，而不是把文件藏进 `legacy/`。

---

## 4. 本轮已修的真实回归

### F301（`__tests__/f301BatchResumeFrozenContext.test.ts`）— 3/3 绿

根因不是测试协议，是 Outline 写阶段绕过了 CAS/attempt：

- Driver 曾直接 `runWritingStages`，不创建 `pipeline_stage_attempts`
- Resume 后 proof attempt 不加 1，整章重跑 succeeded attempts = 0

修复：

1. 写阶段改走 `runSharedOutlineWriterAction`
2. 真实 LLM usage 写回 attempt（proof resume 期望 `+460`）
3. 失败 Stage 走 `persistStageFailure`
4. Resume 的 in-memory Freeze 经 `ReconcileOptions` 传入，**不改** 历史 `pipeline_context_json`
5. 曾把 Freeze 字段写进内存 envelope，触发 `SNAPSHOT_PARSE_FAILED`；已回滚

验收命令：

```bash
npx jest --runInBand --ci __tests__/f301BatchResumeFrozenContext.test.ts --no-coverage
```

上次结果：`3 passed`。

### 其它已绿（上一轮 + 本轮）

- 新硬门禁：`writingSingleWriterImplementation` / `writingNoScenarioExecutor` / `writingNoEmptyStage` / `writingPolicy`
- `pipelineWorkflowV2Integration` / `pipelineV32WorkflowIntegration` 已按 Execution Compatibility = NO 改断言
- CL-01 / CL-06 在更早一轮修过
- typecheck / eslint 在更早一轮通过过；**本 checkpoint 之后未再全量跑**

---

## 5. 未完成：`pipelineRunner.test.ts`

文件：`__tests__/pipelineRunner.test.ts`  
状态：按新契约改了一半，**未绿**。

最近一次整文件：`14 failed / 24 passed / 38 total`（`test-logs/jest-pr-5.txt`）。  
单独跑 `outline draft that only returns reasoning` 可以通过。

### 新契约（不要退回旧 V2 重试核）

| 旧协议 | 新协议 |
|---|---|
| thinking-disabled 自动重试（2 次 LLM） | 空输出 / 纯推理 **只打 1 次**，正式 failed |
| Review 小说正文 / 非法 JSON 再 repair 一次 | Review/Audit/FactCheck 必须是结构化报告，否则 failed，不自动 repair |
| Review/Proof 失败 → `finalize_from_draft` 保初稿 | V4 `requireManualRetry`：**STAGE_FAILED 阻断**，不 degrade |
| twoStage = draft → review → proof | 任务 `outlineWorkflowVersion=4` 时中间有 **brief**（`pipeline_brief`） |
| Proof prompt 旧套话（“本次未提供有效文学评估”等） | Shared compiler + `previousArtifactBlock` |
| `async () => undefined` 跳过 | `status=skipped` + `skipReason` + `policyRuleId` |

`seedTask()` 已写上 `outlineWorkflowVersion: 4`、`contextBudgetVersion: 5`。  
但 `jest.mock('../src/services/database')` 里：

```ts
getStageCheckpoints: jest.fn(async () => []),
ensurePendingCheckpoints: jest.fn(async () => undefined),
```

空 checkpoint 会走 `projectStageResultsToCheckpoints`。`includeBrief=true` 时投影出 pending `brief`/`factCheck`。  
这会让 once-chain 的 LLM mock 错位（brief 吃掉本该给 proof 的回复），表现为：

- 期望 4 次 LLM，实际 3 次
- `persistCompleteTask` 收到 Brief JSON
- proof 失败断言对不上

下一任不要再给 Shared Writer 加第二套 Outline-only retry。优先做：

1. 给 `pipelineRunner.test.ts` 补真实一点的 checkpoint mock，或让 `defaultSharedStageReply()` 覆盖 `pipeline_brief`
2. 所有 `mockResolvedValueOnce` 链按 `draft → review → [factCheck] → brief → proof` 对齐
3. 失败路径断言改成 fail-closed：`persistFailTask` + `notifyFailed`，不要再要 `persistTaskFinalText(draft)` / `proof skipped`
4. token 断言看 `persistTaskStage` 的 `tokens`（adapter 已写 `{input,output,total,reasoning,visible}`）

相关实现：

- `assertStructuredReport()` 在 `writerCore.ts`：review/audit/factCheck 必须有 issues/findings/errors/verdict 等字段
- 空输出中文：`只返回了推理内容` / `未返回正文`
- JSON 报告 body 用抽出的 JSON slice，去掉 ` ```json ` 围栏

---

## 6. 硬门禁（已加，必须保持红先于假绿）

| Gate | 文件 | 要求 |
|---|---|---|
| 每 Stage 生产实现 = 1 | `writingSingleWriterImplementation.test.ts` | `runXStage` 只在对应 `stages/x.ts` |
| Scenario Writer Caller = 0 | 同上 | `runOutlineWritingCapability` / `runContinuation*Capability` / `startContinuationRun` / `runChapterPipeline` / `resumePipeline` 生产 caller = 0（定义处除外） |
| 旧模块无 Writer LLM | 同上 | `outlineStageRuntime` / `continuationStageCapabilities` / `outlineWritingCapability` / `outlineStageOperation` 不得 `callWritingStageLLM` / 完整 V5 prompt compile / `actionRunDraft` 等 |
| 无 `execute()` 逃生口 | `writingNoScenarioExecutor.test.ts` | `SharedWritingStageInput` 无 execute；Driver 不注入场景 Writer |
| 无假 Stage | `writingNoEmptyStage.test.ts` | 禁止 `async () => undefined`；skip 必须有 reason + rule id |
| Generation Stability | `.github/workflows/generation-stability.yml` | 已列入上述新测试 |

**门禁漏洞：** `/legacy/` 被排除。`continuationV5Writers.ts` 因此假绿。封板前要补“生产 import graph 不得引用 legacy writers”。

---

## 7. 下一任 PDCA 顺序（不要跳）

严格按方案：Root Cause → Red Regression → Minimal Fix → Green → Full Regression → Commit。

1. **先绿 `pipelineRunner.test.ts`**  
   `npx jest --runInBand --ci __tests__/pipelineRunner.test.ts --no-coverage`
2. **硬门禁 + F301 回归**  
   ```bash
   npx jest --runInBand --ci ^
     __tests__/writingSingleWriterImplementation.test.ts ^
     __tests__/writingNoScenarioExecutor.test.ts ^
     __tests__/writingNoEmptyStage.test.ts ^
     __tests__/writingPolicy.test.ts ^
     __tests__/writingSharedStageSet.test.ts ^
     __tests__/f301BatchResumeFrozenContext.test.ts --no-coverage
   ```
3. **处理 legacy Writer**  
   确认生产 import = 0；能删就删；不能删就封死入口，并升级门禁。
4. **质量门**  
   `npm run lint`  
   `npm run typecheck`  
   `npm run test:ci`  
   Generation Stability 同 workflow 命令  
   Replay x10（`__tests__/replayHarness.test.ts` 及方案要求的 replay）
5. **Debug APK**  
   `npm run apk:debug`  
   `adb install -r`（保数据）  
   确认 LLM 配置和项目数据还在
6. **真实 LLM**  
   Outline 连续 3 章 + Continuation 连续 3 章  
   只有写正文实现确实只剩 1 套，且 3/3 + 3/3 全过，才允许 FINAL SEALED / GO

---

## 8. 不要做的事

- 不要把 `legacy/continuationV5Writers.ts` 再接回 Driver / Shared Stage
- 不要恢复 `SharedWritingStageInput.execute`
- 不要为了 `pipelineRunner.test.ts` 旧断言，重建 thinking-disabled retry / formatter repair 作为第二套 Writer
- 不要改历史 `pipeline_context_json` 来“补” Freeze
- 不要升版本、不要动 Schema、不要扩到 Canon/Budget/Outline Pipeline 架构
- 没有 3/3 + 3/3 不要写 GO / SEALED

---

## 9. 本机已验证 / 未验证

| 项 | 状态 |
|---|---|
| F301 3/3 | 已绿 |
| 新硬门禁文件 | 已落地；本 checkpoint 后未再跑 |
| `pipelineRunner.test.ts` | 未绿（约 14 failing，契约改到一半） |
| lint / typecheck | 更早一轮通过；本 checkpoint 后未再跑 |
| Full Jest | 未跑完 |
| Generation Stability / Replay x10 | 未跑 |
| Debug APK + `adb install -r` | 未做 |
| 真 LLM Outline 3 + Continuation 3 | 未做 |
| FINAL SEALED / GO | **禁止** |

临时日志（不要提交）：`test-logs/jest-pipeline-fail*.txt`、`test-logs/jest-f301-*.txt`、`test-logs/jest-pr-*.txt`
