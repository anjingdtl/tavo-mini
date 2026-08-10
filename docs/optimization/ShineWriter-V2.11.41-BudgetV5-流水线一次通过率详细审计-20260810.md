# ShineWriter V2.11.41 Budget V5 流水线一次通过率详细审计

审计日期：2026-08-10（Asia/Shanghai）
审计仓库：E:\AiWorkSpace\tavo-mini
审计范围：test-logs/outline-budget-v5-qa-20260810/ 及 test-logs 下相关 SQLite 快照、日志、UI XML/summary。
审计模式：只读；未重新运行 LLM，未修改生产代码、配置、SQLite、测试数据；本次只新增本报告和配套 CSV。
逐阶段逐尝试明细：E:\AiWorkSpace\tavo-mini\docs\optimization\ShineWriter-V2.11.41-BudgetV5-stage-attempt-audit-20260810.csv

## 1. 结论摘要

按应用 pipeline-audit 的显式 valid 字段作为语义/结构验收结果，并把 reasoning_only 作为独立诊断维度（不自动把已记录 valid=true 的事件改判为失败）：

- 6 章共 30 个主阶段，首次 Primary 通过 29 个，一次通过率 96.7%。
- 整条流水线直通 5/6 章，直通率 83.3%。
- Formatter 0 次；完整 Primary retry 1 次；reasoning_only 2 次；invalid_json 0 次。
- 唯一完整 Primary retry：Batch ordinal 3 的 FactCheck，attempt 1 为 reasoning_only，attempt 2 成功。
- Batch ordinal 1 的 Brief 原始日志为 textLength=0、emptyReason=reasoning_only，但 pipeline-audit 同时记录 valid=true，且没有 Formatter/retry；主统计按应用显式 valid=true 计为一次通过，并在 reasoning_only 单项中计 1 次。

为避免把这个矛盾信号掩盖，另给出 raw-visible 敏感性口径：若把任何 emptyReason=reasoning_only 都强制判为语义未直通，则为 28/30 = 93.3%，整条流水线为 4/6 = 66.7%。这不是另一轮测试，而是同一证据的保守解释。

## 2. 审计前置检查与证据边界

- 审计开始时 git status 为 clean：main...origin/main；没有覆盖本地未提交修改的风险。
- 未执行 LLM、未执行数据库写入、未执行数据库修复或字段补造。
- 目标 QA 目录中的 single-a.db 只有 48 bytes；以 SQLite read-only URI 打开失败：DatabaseError: file is not a database。
- 对 test-logs 下全部 SQLite 快照做了 read-only 扫描，6 个目标 taskId 精确命中数为 0。
- test-logs/cur.db 虽然有 pipeline_tasks、pipeline_stage_attempts、llm_usage_logs，分别为 13、72、75 行，但其中没有本轮 6 个 taskId，不能拿旧任务记录替代本轮。
- test-logs/shine_check15.db 同样是旧快照，且 pipeline_stage_attempts 缺少本轮所需的新版诊断字段；没有使用。
- 因此 request_version、contextBudgetVersion、contextWindow、modelMaxOutputTokens、实际 request max_tokens、逐阶段 inputTokens、formatter_used 等无法从本轮可匹配落库证据确认的字段，在 CSV 中写为 unknown。
- 本轮 Budget V5 和三组 provider 捕获预算只作为运行级背景事实保留：Context 1M/Model 200K → 200,000；Context 1M/Model 64K → 64,000；Context 128K/Model 32K → 25,600；运行级 ContextBudgetVersion=5。没有把这些运行级值伪装成每个 task/stage 的冻结请求字段。

## 3. 目标任务识别

| 分组 | taskId | batchId | chapterId | 识别证据 |
|---|---|---|---|---|
| 单章 A | pt_msmty01s_114 | unknown | unknown | single-a-logcat.txt 的 pipeline-audit；UI 仅提供章节运行结果，没有可匹配 DB |
| 单章 B | pt_msmu1dnp_115 | unknown | unknown | single-b-logcat.txt 的 pipeline-audit；UI 仅提供章节运行结果，没有可匹配 DB |
| 单章 C | pt_msmu49st_116 | unknown | unknown | single-c-logcat.txt 的 pipeline-audit；UI 仅提供章节运行结果，没有可匹配 DB |
| Batch ordinal 1 | batch_batch_msmu9wqs_aky337_ord1_1786342691988 | batch_batch_msmu9wqs_aky337（由 child taskId 前缀机械归一，非独立 DB 命中） | 13 | batch-logcat-final.txt:26、30 |
| Batch ordinal 2 | batch_batch_msmu9wqs_aky337_ord2_1786342744470 | batch_batch_msmu9wqs_aky337（由 child taskId 前缀机械归一，非独立 DB 命中） | 14 | batch-logcat-final.txt:1141、1144 |
| Batch ordinal 3 | batch_batch_msmu9wqs_aky337_ord3_1786342937032 | batch_batch_msmu9wqs_aky337（由 child taskId 前缀机械归一，非独立 DB 命中） | 15 | batch-logcat-final.txt:3986、3989 |

单章 chapterId 在现有 logcat/UI 证据中没有数据库主键；没有把 UI 中的“第 N 章”标签擅自当成 chapterId。Batch 的 13/14/15 是 batch-reconcile 明确打印的 chapterId。

## 4. 六章阶段矩阵

CSV 共 31 行：30 个五阶段主阶段实例，加上 1 行 Batch ordinal 3 FactCheck 的 attempt 2。Draft/Final 没有本轮 pipeline-audit 结构化单行，因此这些行保留 UI 完成证据；缺失的逐请求 token/预算字段仍为 unknown。

| 任务 | Draft | Review | FactCheck | Brief | Final | 是否整条直通（主口径） | 额外调用 |
|---|---|---|---|---|---|---|---|
| 单章 A | 成功；UI 推断 P1 | P1 valid=true | P1 valid=true | P1 valid=true | 成功；UI 推断 P1 | 是 | 0 |
| 单章 B | 成功；UI 推断 P1 | P1 valid=true | P1 valid=true | P1 valid=true | 成功；UI 推断 P1 | 是 | 0 |
| 单章 C | 成功；UI 推断 P1 | P1 valid=true | P1 valid=true | P1 valid=true | 成功；UI 推断 P1 | 是 | 0 |
| Batch ordinal 1 / ch13 | 成功；Batch 完成证据 | P1 valid=true | P1 valid=true | P1 valid=true，raw reasoning_only | 成功；Batch 完成证据 | 是（主口径） | 0 |
| Batch ordinal 2 / ch14 | 成功；Batch 完成证据 | P1 valid=true | P1 valid=true | P1 valid=true | 成功；Batch 完成证据 | 是 | 0 |
| Batch ordinal 3 / ch15 | 成功；Batch 完成证据 | P1 valid=true | P1 reasoning_only，失败 | P2 valid=true | 成功；Batch 完成证据 | 否 | FactCheck 1 次完整 Primary retry |

“UI 推断 P1”只表示该五阶段结果页显示成功、跳过 0、且当前任务没有观察到恢复事件；它不代表数据库 attempt row 已经可读。逐字段的不确定性以 CSV 的 evidence_level 和 unknown 保留。

## 5. 有结构化 pipeline-audit 行的逐次证据

下表覆盖本轮日志实际打印的 Review / FactCheck / Brief 事件；Draft / Final 的 per-request 字段没有被当前 logcat 打印，见第 6 节。

| task / ordinal | stage | attempt | outputTokens | reasoningTokens | visibleOutputTokens | finishReason | emptyReason | valid | 证据 |
|---|---|---:|---:|---:|---:|---|---|---|---|
| pt_msmty01s_114 | Review | 1 | 152 | 107 | 45 | stop | unknown | true | single-a-logcat.txt:1668 |
| pt_msmty01s_114 | FactCheck | 1 | 54 | 30 | 24 | stop | unknown | true | single-a-logcat.txt:1543 |
| pt_msmty01s_114 | Brief | 1 | 549 | 516 | 33 | stop | unknown | true | single-a-logcat.txt:2020 |
| pt_msmu1dnp_115 | Review | 1 | 59 | 23 | 36 | stop | unknown | true | single-b-logcat.txt:3723 |
| pt_msmu1dnp_115 | FactCheck | 1 | 57 | 33 | 24 | stop | unknown | true | single-b-logcat.txt:3727 |
| pt_msmu1dnp_115 | Brief | 1 | 372 | 339 | 33 | stop | unknown | true | single-b-logcat.txt:4058 |
| pt_msmu49st_116 | Review | 1 | 81 | 36 | 45 | stop | unknown | true | single-c-logcat.txt:1744 |
| pt_msmu49st_116 | FactCheck | 1 | 49 | 25 | 24 | stop | unknown | true | single-c-logcat.txt:1731 |
| pt_msmu49st_116 | Brief | 1 | 1,505 | 1,472 | 33 | stop | unknown | true | single-c-logcat.txt:2596 |
| Batch ord1 / ch13 | Review | 1 | 667 | 575 | 92 | stop | unknown | true | batch-logcat-final.txt:681 |
| Batch ord1 / ch13 | FactCheck | 1 | 138 | 97 | 41 | stop | unknown | true | batch-logcat-final.txt:623 |
| Batch ord1 / ch13 | Brief | 1 | 66 | 66 | 0 | stop | reasoning_only | true | batch-logcat-final.txt:691 |
| Batch ord2 / ch14 | Review | 1 | 1,082 | 1,037 | 45 | stop | unknown | true | batch-logcat-final.txt:1931 |
| Batch ord2 / ch14 | FactCheck | 1 | 1,488 | 1,448 | 40 | stop | unknown | true | batch-logcat-final.txt:1981 |
| Batch ord2 / ch14 | Brief | 1 | 72 | 39 | 33 | stop | unknown | true | batch-logcat-final.txt:2003 |
| Batch ord3 / ch15 | Review | 1 | 165 | 120 | 45 | stop | unknown | true | batch-logcat-final.txt:4286 |
| Batch ord3 / ch15 | FactCheck | 1 | 1,774 | 278 | 1,496 | stop | reasoning_only | false | batch-logcat-final.txt:4378 |
| Batch ord3 / ch15 | FactCheck | 2 | 39 | 0 | 39 | stop | unknown | true | batch-logcat-final.txt:4429 |
| Batch ord3 / ch15 | Brief | 1 | 161 | 128 | 33 | stop | unknown | true | batch-logcat-final.txt:4634 |

判读要点：

- 当前日志没有 invalid_json，也没有 contract invalid 的 pipeline-audit 事件；因此观察到的 invalid_json=0、contract invalid=0 是“本轮现有日志未观察到”，不是用缺失 DB 行证明绝对不存在。
- Batch ordinal 1 Brief 的 outputTokens=66、reasoningTokens=66、visibleOutputTokens=0、emptyReason=reasoning_only，但同一行 valid=true；这是主口径与敏感性口径差异的唯一来源。
- Batch ordinal 3 FactCheck attempt 1 明确 valid=false、reason=reasoning_only；attempt 2 明确 valid=true，构成唯一完整 Primary retry。
- 这些结构化行没有打印 formatter_used、request_version、contextBudgetVersion、contextWindow、modelMaxOutputTokens、request max_tokens、inputTokens，CSV 对应列均为 unknown。

## 6. Draft / Final 的 UI 证据

UI 结果页显示了阶段完成和展示层 token 摘要，但展示层的“tokens”不是本轮可确认的 per-request outputTokens，不能直接写入 outputTokens。CSV 仅把 UI 数值放入 ui_displayed_* 辅助列。

| task | Draft UI 展示：总/可见/Thinking | Final UI 展示：总/可见/Thinking | 输入上下文（全流水线） | 证据 |
|---|---:|---:|---:|---|
| pt_msmty01s_114 | 1,252 / 555 / 311 | 1,956 / 656 / 188 | 4,051 | single-a-start-2-summary.txt |
| pt_msmu1dnp_115 | 3,795 / 665 / 2,747 | 4,449 / 665 / 2,564 | 4,384 | single-b-running-3-summary.txt |
| pt_msmu49st_116 | 1,582 / 1,051 / 139 | 4,149 / 1,051 / 1,486 | 5,821 | single-c-running-2-summary.txt |
| Batch 3 子章 | per-stage unknown | per-stage unknown | Batch total input 132,320 | batch-complete.xml、batch-logcat-final.txt |

单章结果页分别显示 5/5 阶段成功、跳过 0；Batch 结果页显示成功 3/3、完整流水线 3、总调用 16、输入 132,320、输出 35,485。按现有证据，单章 5×3=15 次主阶段调用，Batch 15 个主阶段加 1 次 FactCheck retry，共 31 次物理 LLM 调用；Draft/Final 的逐阶段调用字段仍不能从日志逐行复原。

## 7. A：阶段一次通过率

定义：首次 Primary 无 Formatter、无完整 Primary retry，并直接通过应用语义/结构校验。对 Review / FactCheck / Brief 使用 pipeline-audit.valid；Draft / Final 使用结果页成功、跳过 0 和无当前恢复事件的 UI/调用证据，标为 inferred。

| 组别 | 总 Primary 阶段数 | 首次通过数 | 一次通过率 | Formatter 次数 | reasoning_only 次数 | invalid_json 次数 | 完整 Primary retry 次数 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 3 个独立单章 | 15 | 15 | 100.0% | 0 | 0 | 0 | 0 |
| 3 个 Batch 子章 | 15 | 14 | 93.3% | 0 | 2 | 0 | 1 |
| 6 章合计 | 30 | 29 | 96.7% | 0 | 2 | 0 | 1 |

阶段一次通过的 29 个具体对象是：3 个单章的 15 个阶段、Batch ordinal 1 的 5 个阶段、Batch ordinal 2 的 5 个阶段、Batch ordinal 3 的 Draft/Review/Brief 3 个首次阶段；不通过的是 Batch ordinal 3 / chapterId 15 / FactCheck / attempt 1，证据为 batch-logcat-final.txt:4378。

保守 raw-visible 敏感性：把 Batch ordinal 1 / chapterId 13 / Brief / attempt 1 的 reasoning_only 强制视为未通过，则首次通过为 28/30=93.3%；Batch 子章为 13/15=86.7%。

## 8. B：整条流水线直通率

定义：一章的 Draft、Review、FactCheck、Brief、Final 五个主阶段全部首次 Primary 通过，期间没有 Formatter、没有完整 Primary retry。

| 组别 | 直通章节 | 直通率 | 未直通章节与原因 |
|---|---:|---:|---|
| 3 个独立单章 | 3/3 | 100.0% | 无 |
| 3 个 Batch 子章 | 2/3 | 66.7% | ordinal 3 / chapterId 15：FactCheck attempt 1 reasoning_only，随后完整 Primary retry |
| 6 章合计 | 5/6 | 83.3% | batch ordinal 3 / chapterId 15 |

额外调用逐项追溯：

- Batch ordinal 3 / chapterId 15 / FactCheck：attempt 1，valid=false、reason=reasoning_only、emptyReason=reasoning_only，见 batch-logcat-final.txt:4378；attempt 2，valid=true，见 :4429。该阶段从首次 Primary 到成功发生 2 次物理 LLM 调用。
- Batch ordinal 1 / chapterId 13 / Brief：发生 1 次 reasoning_only 事件，见 :691；没有 Formatter、没有 retry，pipeline-audit.valid=true，因此主口径仍直通；raw-visible 敏感性口径会把这一章判为非直通。
- 其余 29 个首次主阶段没有当前目标任务的 Formatter、invalid_json、contract invalid 或完整 Primary retry 证据。

raw-visible 敏感性下，整条流水线直通为 4/6=66.7%，因为只额外排除 Batch ordinal 1 / chapterId 13。

## 9. 与 V2.11.40 旧基线并列

| 指标 | V2.11.40 旧报告 | V2.11.41 Budget V5 本轮主口径 |
|---|---:|---:|
| 主阶段一次通过 | 53/60 = 88.3% | 29/30 = 96.7% |
| 整条流水线直通 | 6/12 = 50.0% | 5/6 = 83.3% |
| Formatter | 7 次 | 0 次 |
| reasoning_only | 6 次 | 2 次 |
| 完整 Primary retry | 0 次 | 1 次 |

旧基线来源：docs/optimization/ShineWriter_大纲流水线统一收束优化真实LLM测试报告-20260810.md:70-79。本表只做样本结果并列，不宣称因果改进；旧样本 12 章/60 个主阶段，本轮 6 章/30 个主阶段，且本轮有 1 个 accepted reasoning_only 的口径分歧，必须标记为小样本对比。

## 10. Formatter 与过期证据排除

- 本轮 6 个目标 taskId 的当前 logcat 没有 Contract Formatter 事件；Batch 结果页总调用 16 = 15 个主阶段 + 1 个已定位的 FactCheck retry，未留下 Formatter 的调用余量。
- single-a/b/c 当前结果页和对应当前 logcat 也没有 Formatter 事件；单章结果均为五阶段完成。
- single-c-existing-result-2-summary.txt 中的“Contract Formatter”属于当前 pt_msmu49st_116 之前的旧 UI 结果快照，不与 current single-c-running-2-summary.txt / single-c-logcat.txt 的目标运行绑定，因此没有计入本轮 6 章。
- 本轮“仅重写终稿”UI 文案没有对应新的目标 taskId / pipeline-audit 物理调用，未把它误算成完整主阶段 retry；用户要求的 retry 只统计完整 Primary retry。

## 11. 仍存在的证据问题

1. 缺少与本轮 6 个 taskId 匹配的 SQLite 快照，无法逐行核对 pipeline_tasks、pipeline_stage_attempts、llm_usage_logs、Batch record，也无法确认 request ledger 的 per-attempt 关联。
2. single-a.db 是无效文件；不能修复、替换或从旧快照拼接，以免污染只读审计。
3. 当前 logcat 只对 Review / FactCheck / Brief 打印 pipeline-audit 结构化 token/finish/empty 字段；Draft / Final 的 per-request input/output/finish 和 attempt row 不可复原。
4. 当前 logcat 没有逐请求 max_tokens、contextWindow、modelMaxOutputTokens、request_version、contextBudgetVersion；V5 预算值只能作为运行级背景事实，不能填写到 CSV 的 task/stage 细节。
5. ord1 Brief 同时出现 raw reasoning_only 和 valid=true；本报告保留主口径与 raw-visible 敏感性，不擅自消解该冲突。

## 12. 导出说明

- 机器可读明细：E:\AiWorkSpace\tavo-mini\docs\optimization\ShineWriter-V2.11.41-BudgetV5-stage-attempt-audit-20260810.csv
- 详细报告：E:\AiWorkSpace\tavo-mini\docs\optimization\ShineWriter-V2.11.41-BudgetV5-流水线一次通过率详细审计-20260810.md
- CSV 每行对应一个 task/stage/attempt；unknown 表示现有证据无法确认，不是零值或推测值。
- 导出前后没有改动生产代码、配置、数据库内容或测试数据。
