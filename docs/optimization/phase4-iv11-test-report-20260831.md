# TAVO-MINI Phase IV IV-11 测试报告

日期：2026-08-31（Asia/Shanghai）
施工仓：`E:\AiWorkSpace\tavo-mini`
本轮基线：`259489a0`（执行本轮提交前的 `main` / `origin/main`）
版本：ShineWriter `V2.21.1`，`versionCode=2210100`

## 1. 最终结论

本轮数据采集和复测完成，但最终封板结论仍为：

**`PHASE IV FINAL SEAL HOLD / NO-GO`**

本轮可以确认：

- DeepSeek 写作请求已恢复 Thinking Always On，且通过 frozen request / wire / response channel 证据验证，不是只改 UI 状态。
- 通用章节完成边界和最终 `content` 输出合同已加入共享写作提示词；没有按“账册”“档案”等具体词做黑名单，也没有新增 Gate、Writer、Context、Memory、LLM stage、hidden retry 或自动 re-plan。
- 结构等价的 pathological Bad Plan 在 Thinking ON 下真实 Android 连续通过 3/3；5 章批次通过 5/5；修复最终输出契约后第二次 10 章批次通过 10/10。
- 首次 10 章批次仍保留为失败证据：7/10 完成，第 8 章出现 `reasoning_only`，没有最终 `content`。后续修复后另开批次重测通过，但不能覆盖该失败分母。
- IV-10 中提到的原始“账册的末行”完整 fixture 在当前工作区和历史 evidence 路径中未找到；本轮使用的是结构等价、无正文的可复现坏计划 fixture，并在报告中明确区分。

因此本轮不写 `Root Cause Closed` 或 `PHASE IV FINAL SEALED / GO`。当前准确表述为：

**`Root Cause Remediation Verified on structural-equivalent pathological fixture; exact historical fixture and cross-tier quality evidence pending.`**

## 2. 实施内容

### 2.1 Thinking Always On 与 final channel

- `freezeContinuationThinking()` 对 DeepSeek V4 写作模型强制冻结为 `thinking: enabled`。
- 共享写作、原著续写、outline frozen snapshot、adoption 和 state outbox 路径统一保持 DeepSeek Thinking ON；普通模型行为不变。
- `reasoning_content` 只作为内部推理通道；最终章节正文必须来自合法 final `content`，reasoning-only 且无 final content 时 fail-closed。
- Draft 的 prose / JSON 输出合同均明确要求最终正文或结构化结果进入 `content`，不能由 `reasoning_content` 替代。

### 2.2 Pathological Plan 最小普适修复

- 在共享 Draft completion contract 中增加“只完成当前章节、自然结尾后停止、不继续下一章、不重复展开已完成清单”的语义边界。
- 同一语义边界同步进入续写 V5 prompt compiler；没有新增模型调用或重规划路径。
- 结构等价 Bad Plan 的差异只保留在章节任务语义：Bad Plan 含递归式清单核对和无终止语义，Good Plan 为有限场景、决策、后果和自然结尾。

### 2.3 文学质量与流水线稳定性采集

新增只读 QA 采集器：

`scripts/qa/collect-writing-quality-matrix.mjs`

采集输出为 body-free JSON，不写入提示词、计划、标题、梗概、正文、reasoning content、response body、API key 或 error message。每个批次生成唯一 `correlationKey`，并为每个章节输出长表观察记录。

文学质量部分记录确定性代理指标，不伪造主观文学总分：

- 正文长度与去空白长度；
- 句子/段落数量及长度分布；
- 对白引号占比；
- 句子、段落重复和相邻重复信号；
- 终止标点形态、结尾类型、场景转场提示；
- 协议泄漏标记；
- `literaryQualityAnnotation` 人工/评测模型评分预留字段，当前保持 `not_collected`。

流水线部分记录：

- batch/item 状态、full-pipeline 和 first-pass；
- retry、stage attempt、physical request、protocol fallback、formatter；
- finish reason、empty reason、response channel、failure class/error code；
- input/output/reasoning/visible-output tokens、reasoning/output 比例；
- stage latency、batch wall time；
- provider adapter、model、Thinking、reasoning effort、quality profile、execution profile、context/completion capability 和实际 wire 值。

## 3. 验证链

| 检查项 | 结果 |
| --- | --- |
| Thinking ON / frozen / wire / channel targeted tests | PASS |
| Pathological Plan body-free structural RED/Green test | PASS |
| `node --check scripts/qa/collect-writing-quality-matrix.mjs` | PASS |
| Prettier check（采集器） | PASS |
| `npm run lint -- --quiet` | PASS，0 error |
| `npm run typecheck` | PASS |
| `npm run verify:elastic` | PASS |
| `npm run verify` | PASS，533 suites passed / 4 skipped；3,766 tests passed / 9 skipped；exit 0 |
| Debug APK | PASS，`dist/apk/debug/ShineWriter-V2.21.1-debug.apk` |
| Android 安装 | PASS，使用 `adb install -r`；未执行 uninstall / pm clear |
| final Android crash buffer | PASS，四个终态批次均无应用 crash 证据 |

## 4. 真实 Android 批次结算

所有批次均使用 DeepSeek V4 Flash，receipt 中均为 `thinking=enabled`、`reasoningEffort=low`、`qualityProfile=fast`、`executionProfile=one_shot`。下表中的质量数值是确定性代理指标，不是文学评分。

| 样本 | batch | 交付结果 | 正文可用性 | 稳定性摘要 | 质量代理摘要 |
| --- | --- | --- | --- | --- | --- |
| 结构等价 Bad Plan | `batch_mtgl6rps_0llu1q` | 3/3 full_pipeline | 3/3 | first-pass 3/3；retry 0；physical 3；failure 0 | 平均 3,456.67 字符；对白占比均值 3%；句子唯一率均值 0.99 |
| Good 5 | `batch_mtglhrce_uuwp6b` | 5/5 full_pipeline | 5/5 | first-pass 5/5；retry 0；physical 5；failure 0 | 平均 4,585 字符；对白占比均值 15%；句子唯一率均值 1 |
| Good 10 首次运行 | `batch_mtgm0bjg_ukyy4m` | 7/10 full_pipeline；paused_user | 7/10 | first-pass 7/10；1 failed；retry 0；failure 在第 8 章 | 平均 4,351.29 字符（仅已生成 7 章）；对白占比均值 15%；句子唯一率均值 1 |
| Good 10 修复后复测 | `batch_mtgmub04_rzoyix` | 10/10 full_pipeline | 10/10 | first-pass 10/10；retry 0；physical 10；failure 0 | 平均 5,568.4 字符；对白占比均值 10%；句子唯一率均值 1 |

首次 Good 10 批次的失败不是 runaway，而是 Thinking ON 下 provider 返回了 reasoning-only、final content 为空；该证据促成了 final-channel prompt contract 修复。修复后的 10 章批次以新 batch 重新运行，结果单独统计，不覆盖首次失败样本。

## 5. 思考档次 × 文学质量 × 稳定性矩阵

矩阵文件：

`test-logs/phase4-iv11-android-20260831/writing-quality-stability-matrix-20260831.json`

当前矩阵包含 4 个批次、28 个章节观察，四批次的 `correlationKey` 均唯一；每个章节观察同时带有：

`thinking` + `reasoningEffort` + `qualityProfile` + `model` + `literaryQualityProxy` + `pipelineStability`

本轮四个样本实际都为 `low` 思考档次，因此矩阵已经具备关联数据源，但还不能推导 `low / medium / high` 的因果差异。后续做跨档 A/B 时应保持计划、目标字数、模型和上下文尽量相同，只改变 reasoning effort，并继续使用同一采集器。

## 6. NO-GO 原因与下一实验

### 当前 NO-GO

1. 原 IV-10 精确坏计划 fixture 不在当前工作区/可用历史 evidence 中，不能把结构等价 fixture 宣称为 exact fixture。
2. 首次 10 章真实分母曾出现 7/10，且有一次 reasoning-only final-content 缺失；虽然修复后新批次 10/10，但历史失败必须保留。
3. 当前所有真实样本均为 `reasoningEffort=low`，尚未形成跨思考档次的文学质量 A/B 分母。
4. 当前文学质量只有确定性代理数据，尚未完成人工或独立评测模型标注，因此不能给出主观文学质量结论。

### 下一最小实验

1. 找回并固定 IV-10 原始“账册的末行” frozen fixture；在 Thinking ON、正常 capability-driven/AUTO 语义、无 hidden retry、无自动 re-plan 下至少复测 3/3。
2. 使用同一有限计划和相同目标，分别运行 `low / medium / high` reasoning effort 的小型平衡批次；记录同一 `correlationKey` 结构下的质量代理、人工/评测模型维度和稳定性。
3. 只有 exact fixture、5 章、10 章、First-Pass、DB/Receipt、Resume、Governor、crash/ANR 与跨档质量证据同时满足要求，才重新评估 Final Seal。

## 7. 证据索引

- 当前脱敏质量/稳定性矩阵：`test-logs/phase4-iv11-android-20260831/writing-quality-stability-matrix-20260831.json`
- Bad Plan 终态 DB/UI/logcat：`test-logs/phase4-iv11-android-20260831/db-bad-63-final.sqlite`、`ui-bad-63-terminal.xml`、`logcat-crash-bad-63-final.txt`
- Good 5 终态 DB/UI/logcat：`test-logs/phase4-iv11-android-20260831/db-good5-final.sqlite`、`ui-good5-terminal.xml`、`logcat-crash-good5-final.txt`
- 首次 Good 10 失败 DB/UI/logcat：`test-logs/phase4-iv11-android-20260831/db-good10-final.sqlite`、`ui-good10-failed.xml`、`logcat-crash-good10-final.txt`
- 修复后 Good 10 终态 DB/UI/logcat：`test-logs/phase4-iv11-android-20260831/db-good10b-final.sqlite`、`ui-good10b-terminal-2.xml`、`logcat-crash-good10b-final.txt`
- Thinking / channel contract tests：`__tests__/continuationThinkingAlwaysOn.test.ts`
- Plan delta / completion boundary tests：`__tests__/phase4Iv11PlanDelta.test.ts`
- 当前进度：`docs/optimization/phase4-progress.md`

既有 `phase4-final-report.md`、`phase4-requirement-closure.md`、`phase4-preseal-test-report-20260830.md` 和主方案中的历史段落保持原样；本报告只补充 IV-11 当前事实，不将 NO-GO 改写成 GO。
