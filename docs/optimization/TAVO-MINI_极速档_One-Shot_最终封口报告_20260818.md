# TAVO-MINI 极速档 One-Shot 最终封口报告（FINAL SEALED / GO）

**日期**：2026-08-18
**执行基线**：本地仓库 `E:\AiWorkSpace\tavo-mini` @ main，起点 `5eb3443`（feat(writing): add one-shot execution profile 极速档）
**范围声明**：本轮只做 3 个封口问题（P0-1 / P0-2 / P1），未触碰 Writing Kernel / Shared Writer / Shared Prompt / Elastic Context Budget 主体设计，未做任何其它性能优化。

---

## 0. Final HEAD SHA

- **封口代码提交：`6a087f2`**（`fix(writing): seal one-shot final gates (P0-1/P0-2/P1)`，含全部代码、测试与 workflow 改动）。
- 最终 HEAD：`6a087f2` + 本报告提交（`git log -2 --oneline`）。

## 1. P0-1：pipelineWorkflowV2Integration 原 9 个失败的根因与处理

### 1.1 复现与定界（Baseline → Root Cause）

- 当前 HEAD `5eb3443`：`npx jest __tests__/pipelineWorkflowV2Integration.test.ts` = **9 failed / 5 passed**。
- 用 `git worktree` 建立历史基线复现：
  - `557d16b`（restore first-pass contracts **之前**）：**14/14 全过**。
  - `5b1eb00`（restore first-pass contracts，即 One-Shot 改造前的基线 HEAD）：**同样 9 failed**。
- 结论：9 个失败由 `5b1eb00`「restore first-pass contracts in Shared Writer」引入的**生产契约演进**造成，在 One-Shot 提交之前就已存在，属**历史 V2 协议断言漂移，不是极速档回归、不是生产 BUG**。该提交当时更新了 `pipelineV32WorkflowIntegration.test.ts` / `pipelineRunner.test.ts`，但漏更新了 V2 集成测试。

### 1.2 两类根因（9 个失败全覆盖）

**根因 A（7 个测试）——旧 V2 fixture 不满足现行共享 Writer first-pass 采纳契约**：

现行生产契约（`writerRecovery.ts` / `writerCore.ts`，由 `writingFirstPassContracts.test.ts` 锁定）要求结构化报告带显式采纳信号（`content`+`verdict`，或 `issues`/`strengths`/`suggestions`；factCheck 为 `verdict`/`errors`/`warnings`/`confirmed`）。旧 V2 payload（`findings`/`requiredCorrections`/`outlineExecution`）不含信号 → `isAdoptableStructuredReport` 判不可采纳 → 触发**一次性 thinking-disabled Formatter 挽救调用**（现行契约的一部分）→ 测试 mock 的 `stageOf()` 分类器不认识 Formatter prompt → 抛 `unexpected stage request: unknown` → 任务 failed。

涉及：twoStage / conditional / full / DeepSeek / Final Artifact Validator / Proof-resume / legacy-v1（legacy 的 factCheck mock 同样缺 factCheck 采纳信号）。

**根因 B（2 个测试）——旧 V2「审核阶段 thinking disabled」断言过期**：

现行契约为 V3.3 per-stage frozen thinking（`stageReasoning.ts`：Outline 场景 review/factCheck 主调用 thinking **enabled**，factCheck/audit effort=low；Formatter 挽救调用恒 disabled）。V2 任务（owv=2 非 structured）freeze 时无 stageReasoning 快照，回退到该默认表。

### 1.3 处理方式（全部为测试侧更新，零生产代码改动）

| 改动 | 内容 |
|---|---|
| fixture 补采纳信号 | `reviewV2Report`/`factCheckV2Report` 增加 `content` + `verdict`（与共享 STRUCTURED_REPORT_CONTRACT 一致），保留全部历史 V2 字段；legacy factCheck mock 返回 `confirmed`+`issues` 信号 |
| 分类器扩展 | `stageOf()` 增加 `reviewFormatter`/`factCheckFormatter` 识别（Formatter 是现行契约的一等公民） |
| thinking 断言更新 | 审核主调用期望 `{type:'enabled'}`（factCheck 另断言 `reasoningEffort:'low'`），并补 `temperature: 0.2` 确定性断言 |
| reasoning-only 测试重写 | 按现行契约改名为「one thinking-disabled Formatter rescue then fails closed」：主调用 1 次（enabled）+ Formatter 恰 1 次（disabled）+ 之后 fail closed，无更多请求 |
| 清理 | 移除两个历史 DEBUG console.log；修复 `all` 变量 shadow 警告 |

**红线遵守**：未 skip/`.only`/放宽断言/allow-failure/删测试；未恢复旧 V2 Writer、旧 retry、旧 fallback、旧 prompt、旧 stage flow；生产代码零改动。

### 1.4 Full Jest 最终结果

```
npm run test:ci
Test Suites: 4 skipped, 462 passed, 462 of 466 total
Tests:       9 skipped, 3565 passed, 3574 total   →  0 failed
```

（4 skipped 套件 / 9 skipped 用例为仓库既有平台性 skip，与本轮无关；3565 = 上轮 3561 + 本轮新增 4。）

## 2. P0-2：Generation Stability 接入全部 One-Shot 硬门禁

`.github/workflows/generation-stability.yml` 新增 7 个测试文件（任务要求的 6 组 + 本轮 P1 新增治理门禁）：

- `writingOneShotProfile.test.ts`（Gate D formal skip + Freeze 契约 + standard 字节级不变）
- `writingOneShotPaidCallGate.test.ts`（第二次 Paid Call / Formatter 偷跑 / fail-closed）
- `writingOneShotStagePolicy.test.ts`（状态机不派发 audit / 无 fast-extreme 概念）
- `writingOneShotElasticBudget.test.ts`（固定 Token cap = 0 / 绕过 Elastic Budget = 0）
- `writingOneShotResume.test.ts`（Resume 重复调用 / Primary Retry 偷跑）
- `writingOneShotOnePaidCallPerChapter.test.ts`（fast/extreme Writer/Compiler/ContextBuilder = 0）
- `writingOneShotSkipLedgerSemantics.test.ts`（**本轮新增**：Formal Skip 不退化为 fake completed / empty executor，三层语义一致）

未设置任何 allow-failure。本地同款完整跑（26 suites / 137 tests）全绿。

## 3. P1：Continuation One-Shot Skip 状态语义统一

### 3.1 治理前（问题）

| 观测面 | one_shot 下被跳过阶段（review/audit/factCheck/revision/proof）的状态 |
|---|---|
| Shared Stage Result | `skipped` ✅（带 skipReason + policyRuleId） |
| Continuation Durable Ledger | `queued` ❌（永不 settle，污染 Skip Rate / Stage Completion / Critical Path / Duration / Efficiency / Paid 统计） |
| Kernel Trace / 驱动外层 outcome | `completed` ❌（驱动硬编码，fake completed） |

### 3.2 治理后（小范围改动，8 个文件，零 schema 迁移）

| 文件 | 改动 |
|---|---|
| `contracts/writingStage.ts` | `WritingStageNotification.status` 增加 `'skipped'` + 可选 `skipReason`/`policyRuleId`；adapter 增加可选 `persistStageSkip` |
| `contracts/frozenWritingContext.ts` | `WritingKernelStageEvent` 同步扩展 |
| `trace/writingTrace.ts` + `unifiedWritingKernel.ts` | trace 事件携带 skip 溯源 |
| `stages/writingStageRunner.ts` | skipped 结果 → `persistStageSkip`（落 ledger，不发请求、不写空 artifact） |
| `persistence/continuationDurableAdapter.ts` | 实现 `persistStageSkip`：ledger 行置为**既有** `skipped` 状态（schema-32 CHECK 已允许，零迁移），output_json envelope 记 `{skipped, skipReason, policyRuleId}` |
| `execution/continuationStageDriver.ts` | 三轮 outcome 从**真实共享阶段结果**派生（`outcomesFromResults`），不再硬编码 completed |

### 3.3 治理后（验证）

- **Red→Green**：stash 生产改动后新测试 `writingOneShotSkipLedgerSemantics.test.ts` 3/4 失败（Red 确认）；恢复后 4/4 全绿。
- Ledger 终态（one_shot 真实 SQLite 集成断言）：`draft_writer=success(request_count=1)`；`narrative_architect/revision_writer/adversarial_auditor/final_reviser` 全部 `skipped`（request_count=0、request_reserved=0、envelope 带 `profile.one_shot.skip_*` 溯源）；artifact 仅 `draft`+`final`（无空 artifact 冒充执行）。
- Kernel Trace：skipped 事件带 `skipReason`+`policyRuleId`；completed 事件无 skip 字段。
- **Standard 模式零回归**：standard 全程无 skip 记录（`persistStageSkip` 从不被调，137 项 Generation Stability 同款测试 + 51 项 Replay/Resume 回归全绿）。
- 影响面复查：无任何生产消费方依赖 audit 节点的 `queued` 状态（adoption/settlement/UI 均不分支于该状态）。

## 4. 最终硬指标矩阵

| 指标 | 结果 | 证据 |
|---|---|---|
| One-Shot Paid Calls ≤ 1 / 章 | ✅ | `writingOneShotPaidCallGate` + `writingOneShotStagePolicy`（1 physical call，真实 ledger 测试 request_count=1） |
| Formatter（one_shot）= 0 | ✅ | `allowsFormatterCall` 硬门禁（Gate 测试 4 例 fail-closed） |
| Automatic Retry（one_shot）= 0 | ✅ | `writingOneShotResume`：无 checkpoint 重置、无第二次请求 |
| Review/Audit/FactCheck/Revision/Proof API Calls（one_shot）= 0 | ✅ | ledger 断言 request_count=0 + 全链路只 1 次物理调用 |
| New Hard Token Cap = 0 | ✅ | `writingOneShotElasticBudget` + 架构扫描（无 32K/50K/80K 常量） |
| Elastic Context Budget Regression = 0 | ✅ | one_shot 与 standard 的 plan/allocation/rendered 指纹逐字节相同 |
| Resume Duplicate Paid Call = 0 | ✅ | `writingOneShotResume` + Gate 测试（loadExisting 0 调用） |
| ONE Kernel / Writer / Prompt 结构无回归 | ✅ | `writingProductionCallGraph` / `writingSingleWriterImplementation` / `writingNoScenarioExecutor` / 架构扫描门禁全绿；本轮生产改动仅为 skip 语义投影，未新增任何执行入口/Writer/Compiler/Builder |
| skipped ≠ completed/failed/queued | ✅ | 三层一致 `skipped` + skipReason + policyRuleId（P1 新门禁锁定） |
| Outline/Continuation 5+5 行为未触碰 | ✅ | 本轮未改 one_shot 执行链主体（仅 skip 观测语义），按任务要求未重复真实 5+5 |

## 5. 最终验证清单（本轮实际执行）

| 项 | 命令/方式 | 结果 |
|---|---|---|
| Lint | `npm run lint` | PASS（0 errors；203 warnings 均为存量，本轮触碰文件仅新增 0 警告并顺手消除 1 个存量 shadow 警告） |
| TypeScript | `npm run typecheck` | PASS |
| 版本一致性 | `npm run verify:version` | PASS（V2.11.53 versionCode=2115300） |
| Full Jest | `npm run test:ci` | **0 failed**（3565 passed） |
| Generation Stability 同款 | 26 文件本地完整跑 | PASS（137 tests） |
| Replay/Resume 回归 | 8 文件（V4Resume/CheckpointResume/SecondRoundRecovery/ChapterRecovery/BatchP1Recovery/FrozenContext 等） | PASS（51 tests） |
| One-Shot 6+1 组硬门禁 | 见 §2 | PASS（37 tests） |
| Android Debug build | `npm run apk:debug` | BUILD SUCCESSFUL → `dist/apk/debug/ShineWriter-V2.11.53-debug.apk`（56.47 MB） |
| Android 真机 smoke | Medium_Phone 模拟器安装+启动+截图+logcat | PASS：MainActivity 前台、作品库正常渲染、无 FATAL/ReactNativeJS/SQLite/schema-drift 异常（P1 触碰执行链与 ledger，故执行本项；ledger 写路径已由真实 SQLite 集成测试覆盖，未重复真实 5+5） |

## 6. 结论

```
One-Shot FINAL SEALED / GO
```

极速档主体（1 次 API / 章、Formatter 禁用、自动重试禁用、审核阶段零调用、完整继承弹性上下文预算）保持不变且全部硬门禁已进入 Generation Stability CI 持续阻断。下一阶段「流程治理与流水线提速」可以在此基线上开展：Skip Rate / Stage Completion Rate / Critical Path / Stage Duration / Pipeline Efficiency / Paid-NonPaid 统计现在可以在三层一致的 `skipped` 语义上直接计算，不再被 queued 噪声与 fake completed 污染。
