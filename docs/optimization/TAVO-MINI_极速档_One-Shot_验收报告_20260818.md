# TAVO-MINI 极速档 One-Shot Execution Profile 验收报告

**日期**：2026-08-17 ～ 2026-08-18
**基线**：本地仓库 F:\ClaudeWorkSpace\projects\TAVO-MINI @ main（实现于 5b1eb002 之上）
**依据**：《TAVO-MINI 极速档 One-Shot Execution Profile 改造方案 V1.0》
**证据目录**：`docs/optimization/evidence/one-shot-20260817/`

---

## 1. 最终验收矩阵（方案 §16 逐条对照）

| 验收项 | 结果 | 证据 |
|---|---|---|
| 四档 UI = 极速 / 低 / 中 / 高 | ✅ | `ui_tier_default.png`（四档同屏）、`ui_tier_one_shot_selected.png`（极速选中）；选中后 settings 表 `pipeline_execution_profile='one_shot'` + `pipeline_reasoning_effort='low'` |
| One-Shot Execution Profile = implemented | ✅ | `src/services/writing/contracts/executionProfile.ts`；非 reasoningEffort 档位（`normalizeWritingExecutionProfile('extreme'|'low') = 'standard'`，门禁测试锁定） |
| ONE Kernel = preserved | ✅ | 未新增任何执行入口；`writingProductionCallGraph` G1–G8 门禁全量 Jest 通过 |
| ONE Shared Writer Core = preserved | ✅ | `writingOneShotOnePaidCallPerChapter.test.ts` 扫描：0 个 fast/extreme writer 文件；writerCore 无场景分支 |
| ONE Shared Prompt Compiler = preserved | ✅ | One-Shot 指令块是统一 Prompt 内的 Profile 投影（仅 draft 注入，proof 不注入——Elastic 测试断言） |
| ONE Freeze = preserved | ✅ | one_shot 冻结进 stagePolicy（values + skipRules）并参与 freezeFingerprint；standard 模式字节级不变（`writingOneShotProfile.test.ts` byte-identical 断言） |
| One-Shot Paid LLM Calls ≤ 1 | ✅ | 见 §2 / §3 真实 LLM 取证；`writingOneShotPaidCallGate.test.ts` |
| Formatter = disabled in one-shot | ✅ | writerCore `allowsFormatterCall` 门禁：reasoning-only/empty/malformed 全部 Fail Closed（1 次调用后抛 `SHARED_WRITER_EMPTY_OUTPUT`），standard 模式 Formatter 契约保留（对照组测试） |
| Automatic Primary Retry = disabled | ✅ | `maybeAutoRetryStage` / `consumeFailedStageRetryDisposition` one_shot 硬阻断（`writingOneShotResume.test.ts`：无 checkpoint 重置；standard 对照组保留重置） |
| Review/Audit/FactCheck/Revision/Proof = formal skipped | ✅ | 冻结 skipRules 带 `profile.one_shot.skip_<stage>`；Outline checkpoints 四阶段 status='skipped'；Continuation stage ledger 四阶段保持 queued（从未派发）且 final_validate 本地 success |
| FinalValidate = local PASS | ✅ | 两场景 5 章全过；Semantic Apply 本地门禁未动 |
| Persist = PASS | ✅ | Outline 章节 224–228（2740–5009 字符）；Continuation 章节 229–233（3629–5762 字符）全部落库 |
| Post-writing Update = PASS | ✅ | Continuation Story Memory 45→50（clean）；state_events 226 / entities 21 正常推进；Outline 新项目 story memory 初始状态与历史 standard 批次项目（21/22/23）一致 |
| Existing Elastic Context Budget = preserved | ✅ | `writingOneShotElasticBudget.test.ts`：8K/64K/1M 窗口下 one_shot 与 standard 的 plan/allocation/rendered 指纹逐字节相同 |
| New hard token cap = 0 | ✅ | 契约文件扫描门禁（无 32K/50K/80K 等常量）；真实穿测：Outline 每章 input ~1.5K token（小项目自动预算）vs Continuation 每章 input 25.7K–27.7K token（大项目 Canon/Seam/Style/Memory 弹性装载）——同一预算系统按资料规模伸缩 |
| Fast/extreme context builder = 0 | ✅ | 架构扫描门禁 |
| Resume Duplicate Paid Call = 0 | ✅ | 执行幂等：Draft artifact 已持久化 → loadExisting 直接返回、0 次调用（Gate 测试）；执行中断（force-stop 演练）后批次走状态机恢复，draft checkpoint succeeded 不再触发 run_draft |
| Post-Freeze Live Model Read = 0 | ✅ | 未改动请求解析路径；`writingFinalSealBehavior` 既有门禁全量通过 |
| Fatal Architecture Regression = 0 | ✅ | Full Jest 3553 通过（唯一失败套件为 HEAD 预存，见 §5） |

## 2. Outline 极速连续 5 章（真实 LLM：deepseek-v4-flash）

批次 `batch_msxge8k6_wjw1po`（项目 25 OneShot-O-20260817，`execution_profile='one_shot'`，reasoning_effort='low'）：

| 章 | Paid calls | Draft attempts | 非 Draft 付费 Stage | Formatter | 正文落库 | Freeze | one_shot 冻结 |
|---|---|---|---|---|---|---|---|
| 1 | 1 | 1 | 0（review/factCheck/brief/proof 全 skipped） | 0 | 2783 字符 | ✅ 指纹匹配 | ✅ |
| 2 | 1 | 1 | 0 | 0 | 3225 字符 | ✅ | ✅ |
| 3 | 1 | 1 | 0 | 0 | 2740 字符 | ✅ | ✅ |
| 4 | 1 | 1 | 0 | 0 | 4456 字符 | ✅ | ✅ |
| 5 | 1 | 1 | 0 | 0 | 5009 字符 | ✅ | ✅ |

- 批次 `used_llm_calls = 5`（对照：同库历史 standard 批次每章 5 次调用）。
- `llm_usage_logs`（项目 25）：`batch_planner ×1`（批次规划，非章节调用）+ `pipeline_draft ×5`，**无任何 review/factcheck/brief/proof/formatter scenario 调用**。
- 第 1 章 envelope 取证：`execution.executionProfile='one_shot'`；`stagePolicy.values.executionProfilePolicy={maxPaidLlmCalls:1, allowFormatter:false, allowPrimaryRetry:false}`；五条 skipRules 全带 policyRuleId；freezeFingerprint 与 trace 一致；generationTraceId 有效；rendered 预算 438 token（由弹性预算器按小项目资料计算，模型窗口 1,000,000）。
- 明细：`outline_verify.json`。

## 3. Continuation 极速连续 5 章（真实 LLM：deepseek-v4-flash）

批次 `batch_msxtwf9x_5jecza`（项目 16 E2E_CB1，continuation 模式，`execution_profile='one_shot'`）：

| 章 | Paid calls（唯一= draft_writer） | 审查 Stage（ledger） | FinalValidate | 正文落库 | Draft input tokens（弹性预算） |
|---|---|---|---|---|---|
| 1 | 1 | 4 阶段 queued（零调用） | 本地 success | 3804 字符 | 25,736 |
| 2 | 1 | 4 阶段 queued | 本地 success | 4874 字符 | 26,242 |
| 3 | 1 | 4 阶段 queued | 本地 success | 3629 字符 | 26,658 |
| 4 | 1 | 4 阶段 queued | 本地 success | 5762 字符 | 27,379 |
| 5 | 1 | 4 阶段 queued | 本地 success | 4664 字符 | 27,661 |

- 每章 run `state=completed, completion_reason=adopted, quality=full_pipeline`；`maxPhysicalRequests=1`（tokenUsage 冻结）。
- **Canon/Boundary/Seam/Anchor/Style/Story Memory 全部正常构建**：每章 snapshot 含 canonSnapshotId+revision、seam(summary+excerpt)、primary anchor、style profile hash、story memory fingerprint；memory through 逐章递增 45→49，批次后 project 16 `through=50, status=clean`。
- 每章 generationTraceId 唯一；freezeFingerprint 匹配。
- 唯一的 draft_writer error 记录为 2026-08-15 历史 network_error，与本批次无关。
- 说明：stage ledger 中被跳过的审查阶段显示 `queued`（初始态，从未派发请求、无 token）而非 skipped——正式 skip 合同存在于冻结 stagePolicy.skipRules 与共享 stage 结果中；ledger 行不做"fake completed"，符合 Fail-Closed 原则。
- 明细：`continuation_verify.json`。

## 4. PDCA 与工程门禁

- **Red → Green**：先写 6 个 `writingOneShot*` 门禁测试文件（Red：11 fail / 13 对照 pass），最小实现后 Focused Green 33/33。未放宽任何既有测试；standard 行为全部有对照组断言。
- **lint**：`eslint .` 0 error（205 个预存 no-void 风格 warning，与基线一致）。
- **typecheck**：`tsc --noEmit` 0 error。
- **Full Jest**：3553 通过 / 9 失败。失败全部集中于 `pipelineWorkflowV2Integration.test.ts`，**经 git stash 基线复核，该 9 个失败在未含本轮改动的 HEAD（5b1eb002）上同样失败（9 failed / 5 passed 完全一致）**，属预先存在的 V2 历史协议断言漂移，与本轮无关，未在本轮边界内修改。
- **Schema 53→54**：`multi_chapter_batches.execution_profile`（幂等 ALTER 迁移）；版本钉死测试更新为 54 并新增列级断言。

## 5. 构建 / 安装 / 数据保留

- Debug 构建：`dist/apk/debug/ShineWriter-V2.11.53-debug.apk`（50.22 MB）。
- `adb install -r`（未卸载、未清数据）：Schema 53→54 迁移成功（schema_version=54，execution_profile 列就位）。
- 数据保留逐项对照（`data_retention.json`）：projects 24=24、正文章节 165=165、激活 LLM 配置 deepseek-v4-flash 不变、续写风格画像 1=1、Story Memory 策略 9=9、续写 runs 66=66、reasoning 设置不变 —— **ALL_RETAINED**。

## 6. 变更清单（摘要）

新增：
- `src/services/writing/contracts/executionProfile.ts`（Execution Profile 契约，无 token cap）
- `src/services/migrations/v53-to-v54.ts`（批次 execution_profile 列）
- 测试：`__tests__/writingOneShot{Profile,PaidCallGate,StagePolicy,ElasticBudget,Resume,OnePaidCallPerChapter}.test.ts` + `__tests__/helpers/oneShotFixtures.ts`
- `scripts/kernel-closure-qa/verify_one_shot.py`（批次逐章硬门禁取证）

修改（均为 Profile 投影，不新增第二套实现）：
- `writingPolicy.ts`：one_shot skipRules + values 冻结（standard 字节不变）
- `writerCore.ts`：Formatter 硬门禁（one_shot Fail Closed）
- `sharedPromptCompiler.ts`：Draft One-Shot 投影块
- `determineNextPipelineAction.ts`：one_shot 路由 draft→finalize→complete（decideOneShot）
- `outlineStageRuntime.ts`：执行快照冻结 executionProfile；`actionFinalizeFromDraft` 正式 skip 记录；`maybeAutoRetryStage`/`consumeFailedStageRetryDisposition` one_shot 硬阻断
- `outlineStageDriver.ts`：freeze surface 时同步 reconcileOptions（供门禁读取冻结策略）
- `continuationRunPreparation.ts` / `continuationWritingTypes.ts` / `continuationStageDriver.ts`：profile 接入 + maxPhysicalRequests=1
- `pipelineTaskContext.ts` / `taskView.ts` / `types/pipeline.ts` / `types/pipelineExecution.ts`：executionProfile 冻结解析与视图（非法值 Fail Closed）
- `pipelineTaskRepository.ts`：settings key `pipeline_execution_profile` 读写
- 批次链路：repo（Schema 54 读写）、store（创建冻结）、reconcile + continuationBatchAdapter（override 传递）、`pipelineRunner.ts`（PipelineRunOptions 透传）
- UI：`PipelineConfigScreen`（极速/低/中/高）、`reasoningPolicy.ts`（极速 preset + 标签低/中/高）、`MultiChapterBatchScreen`（批次显示"极速"）

## 7. 已知边界

1. `pipelineWorkflowV2Integration.test.ts` 的 9 个失败为 HEAD 预存问题（V2 历史协议断言），建议另立 PDCA 轮处理，不在极速档边界内。
2. Continuation stage ledger 对 one_shot 跳过阶段保留 `queued` 初始态（诚实展示，非 fake completed）；正式 skip 语义在冻结 stagePolicy 中完整可审计。
3. 批次规划器（batch_planner）每批次 1 次调用，属批次编排（N 章共享一次规划），不计入"每章正文调用"口径；章节级硬指标 Paid=1 不受影响。

**结论：方案 §16 全部验收项通过，极速档 One-Shot Execution Profile 改造完成。**
