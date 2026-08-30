# TAVO-MINI Phase IV Pre-Seal 测试报告

日期：2026-08-30（Asia/Shanghai）
基线：开工时 `HEAD == origin/main == 945cd292`（git fetch 复核无新远端提交）；收口提交 `b83af379`。
对应轮次：IV-9 Pre-Seal Correction（主方案：`TAVO-MINI_Phase4_流水线再治理与写作通过率恢复计划_20260830.md`）

## 1. 结论

`PHASE IV FINAL SEAL HOLD / NO-GO`（维持）。

- 本地/确定性验证：**全部 PASS**。
- 真实 Android 付费运行：**部分完成**。凭据已恢复（401 解除），5 章连续批次 4/5 章 adopted；第 5 章、10 章批次第 1 章 Draft 遭遇提供端持续停摆（本地 570s 看门狗连续 10 次 `total_timeout`），无法形成完整 5/10 章分母。
- 最终 GO 仍被阻断在**外部 provider 能力**，不在应用架构；未伪造任何通过。

## 2. 测试环境

| 项 | 值 |
| --- | --- |
| 设备 | emulator-5554（Medium_Phone，API 37.1，x86_64） |
| 包名 / 版本 | com.shinewriter / V2.21.1 |
| 安装方式 | `adb install -r`（firstInstallTime=2026-08-23 04:59:45 保持不变，数据零丢失） |
| APK 签名说明 | 在装包为 debug 签名，release 签名与之不兼容且约束禁止 uninstall，故本轮真实运行使用**同代码 debug 构建**（dist/apk/debug/ShineWriter-V2.21.1-debug.apk） |
| LLM | GLM-5.3-Flash @ open.bigmodel.cn coding endpoint（UI「保存并测试」通过，见 `llm-save-test-pass.png`） |
| 项目 | elasticcontqa（原著续写，批次前 99 章） |

## 3. 本地验证链（全部 PASS）

| 步骤 | 结果 |
| --- | --- |
| Red-first 新增测试 `__tests__/phase4PreSealCorrection.test.ts` | 先红（5 failed）→ 实现后 **9/9 passed** |
| Targeted phase4 套件（7 suites / 35 tests） | PASS |
| `npm run typecheck` | PASS |
| `npm run lint -- --quiet` | 0 errors |
| `npm run verify:elastic` | PASS |
| `npm run verify`（full） | **532 suites passed / 3 skipped；3760 tests passed / 8 skipped；exit 0** |
| Governor 旁路回归 `phase4GovernorBypass.test.ts` | 原样通过（未改动） |
| 既有 `phase4ContextThroughput.test.ts` | 更新 2 处 fixture（低相关 note 由 explicit 改 automatic，匹配新语义）后 PASS |

### Red-first 测试覆盖点

1. QA `finishReason=length`（`qa_truncated_advisory`）与合同无效（`qa_contract_advisory`）时，Revision skip 不得落在 clean 规则，必须记 `policy.phase4.qa_incomplete_not_clean`（skipReason 含「不得记为 Clean」）；真正 clean 的 QA 仍走原 `policy.one_pipeline.conditional_revision_no_findings`。
2. `isPhase4QaLengthAdvisory`：QA+phase4+length=true；draft/revision+length=false；无 phase4 marker 的 QA length=false（历史硬门保持）。此用例对应真实运行复现的缺口（见 §5.3）。
3. Context：explicit Optional 不因 kind 被裁；preferred Optional 不因 kind 被裁；Mandatory 非 白名单 kind 全留；低相关 automatic Optional 先裁（composition 证据数组断言）。

## 4. 代码修正内容（最小面，无新增 Gate / LLM call / Agent / 第二 Builder）

| 文件 | 修正 |
| --- | --- |
| `src/services/writing/stages/writerCore.ts` | 新增 `isPhase4QaLengthAdvisory`；primary 调用路径与 `finalizeWriterArtifact` 统一走该判定——phase4 QA 截断不再被无条件 `assertWriterFinishReason` 硬拒，统一降级 Advisory artifact |
| `src/services/writing/stages/evaluateRuntimeStageSkip.ts` | Revision skip 检测 QA incomplete 诊断，改记显式非 Clean 规则 `policy.phase4.qa_incomplete_not_clean` |
| `src/services/writing/context/stageContextProjection.ts` | 弹性投影保留判定从「仅 kind」改为「价值优先」：Mandatory 全留；`activation==='explicit'` 或 `requirement==='preferred'` 保留；低相关 automatic Optional 先裁 |

## 5. 真实 Android 运行

### 5.1 5 章连续批次 `batch_mtfkmlek_i6qms3`（目标 5 章 × 3000 字，思考强度冻结「标准」，topology=2 compact）

结果：**4/5 adopted（full_pipeline），第 5 章提供端停摆，用户确认式结束批次留证（cancelled）**

| 显示章 | item | 结果 | Draft 尝试 | 末次时长 | physical calls | in/out tokens | 阶段链（末次尝试） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 第100章 潮水提前之夜 | 1 | **adopted** | 3（timeout→QA截断→修正版通过） | 452s | 2 | 83,502 / 24,185 | draft:success → qa:**skipped(截断Advisory)** → revision:skipped → final_validate:success |
| 第101章 代权者的文书 | 2 | **adopted** | 1 | 369s | 2 | 89,603 / 20,459 | draft:success → qa:success → revision:skipped → final_validate:success |
| 第102章 最后一潮之前 | 3 | **adopted** | 1 | 1105s | 3 | 135,704 / 61,333 | draft:success → qa:success → revision:success → final_validate:success |
| 第103章 治安官归来 | 4 | **adopted** | 1 | 472s | 2 | 97,497 / 26,190 | draft:success → qa:success → revision:skipped → final_validate:success |
| 第104章 重走档案路线 | 5 | **failed** | 5（全部 570s timeout） | 571s×5 | 5（均无产出） | 7,125×5 / 0 | draft:failed ×5 |

- **First-Pass Adoptable：3/5**（item 2/3/4 一次通过；item 1 第 3 次尝试才 adopted，不计 first-pass）。
- Governor physical call = **0**；crash/ANR = **0**（crash buffer 为空）。
- 数据保护：批次结束仅放弃未完成章，4 章成果与全部历史保留。

### 5.2 10 章连续批次 `batch_mtfrwv40_bhx4r5`（目标 10 章 × 3000 字）

结果：**0/10，paused_user 留证**。第 1 章（第105章 启封栏里的名字）Draft 连续 4 次 570s `total_timeout`（in=7,103 / out=0），其中第 4 次发生在**完整 App 冷重启 + C8 durable resume** 之后，排除进程内状态因素；为避免继续消耗无效 paid 调用而停止重试。

### 5.3 Pre-Seal Correction 的生产验证（关键证据）

item 1 的三次尝试横跨修正前后，构成天然 A/B：

1. 第 1 次（timeout）：Draft 570s 停摆。
2. 第 2 次（**修正前 APK**）：Draft 成功；QA `finishReason=length` 截断 → 被硬拒（`qa 输出以 finishReason=length 截断，拒绝持久化`）→ 章节失败。**真实复现了缺口**。
3. 第 3 次（**修正版 APK**，`adb install -r` 后 checkpoint 精确恢复）：Draft 复用成功；QA 再次截断 → **Advisory skipped（非 Clean），Revision 零调用，FinalValidate 通过，章节 adopted**。修正按设计生效，且没有静默当 Clean。

## 6. 付费调用台账（llm_usage_logs，2026-08-30 全天，共 42 次）

| scenario | success | error(total_timeout) | input tokens | output tokens |
| --- | --- | --- | --- | --- |
| batch_planner | 2 | 0 | 1,814 | 19,545 |
| pipeline_draft | 9 | **10** | 405,784 + 619,944 | 174,730 + 0 |
| pipeline_qa | 8 | 0 | 275,184 | 21,127 |
| pipeline_brief（Revision） | 2 | 0 | 79,573 | 42,874 |
| story_memory_v2_primary | 11 | 0 | 111,988 | 17,402 |
| **合计** | **32** | **10** | **1,494,287** | **275,678** |

- 10 次 timeout 全部是「边界首章 Draft」同一模式（in≈6.2–7.1k 小上下文、out=0、恰在 570–571s 被本地看门狗终止）。
- 无 `outcome_unknown` 自动 retry；每次 timeout 均为用户确认式恢复（对话框明示可能重复费用）。
- Governor 相关 scenario 记录为 **0 条** → physical call=0 由台账直接佐证。

## 7. 阻断分析（NO-GO 归因）

| Gate | 状态 | 归因 |
| --- | --- | --- |
| 5 章连续 | 4/5，First-Pass 3/5 | 第 5 章 Draft 提供端停摆 ×5（应用侧看门狗按设计触发，费用如实入账） |
| 10 章连续 | 0/10 | 第 1 章 Draft 提供端停摆 ×4（含冷重启 resume） |
| Historical A/B | 部分真实 | 已有 4 个真实 adopted 样本可对 C9 基线（38 paid）做部分比较；分母不完整，不宣称整体提升 |

**模式**：所有成功 Draft 均为「带已采纳前文记忆」的后续章（in 83k–135k）；所有停摆均为「原著边界 fresh 首章」（in≈7k）。与时段、进程状态无关（冷重启复现），为 provider 侧对特定请求模式的持续停摆，非应用缺陷。570s 看门狗是刻意贴近 provider 10 分钟窗口的会计安全边界，不允许放宽（放宽会把 slow-valid 转成 outcome_unknown 重复扣费风险）。

## 8. 解封条件（架构零改动）

1. provider 侧恢复对边界首章 Draft 的正常响应（或更换可用同能力模型配置）。
2. 重跑 5 章与 10 章连续批次，形成完整分母；用 `phase4ContinuousHarness` 与 `phase4HistoricalAb` 计算真实 First-Pass 与 A/B。
3. 全部 Required Gate 真实 PASS 后，才允许把状态改写为 `PHASE IV FINAL SEALED / GO`。

## 9. 证据索引

- 逐章运行表 / 台账 / 结论：`test-logs/phase4-preseal-20260830-1650/README-evidence.md`
- 运行前后完整 DB：`test-logs/phase4-preseal-20260830-1650/db-preflight.sqlite`、`db-final.sqlite`
  （关键表：`multi_chapter_batches(_items)`、`continuation_generation_runs`、`continuation_generation_stage_results`、`llm_usage_logs`）
- 全程 logcat 与 crash buffer：`logcat-batch5.txt`、`logcat-batch10.txt`、`logcat-crash*.txt`（空）
- UI 取证：`llm-save-test-pass.png`、`batch5-started.png`、`plan5.png`、`ui-*.xml`、`final-state.png`
- 测试 helper：`scripts/qa/ui-tap.mjs`、`scripts/qa/ui-find.mjs`、`scripts/qa/db_probe.py`
- 代码与测试：提交 `b83af379`（本仓库 main）
