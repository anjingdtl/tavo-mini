# ShineWriter 大纲流水线统一收束优化：真实 LLM 测试报告

测试日期：2026-08-10（Asia/Shanghai）  
应用版本：V2.11.40 / versionCode 2114000  
测试设备：Android Emulator `emulator-5554`，包名 `com.shinewriter`  
测试工程：`release_touch_test`（project id 1）

## 1. 测试范围与数据保护

本轮按要求完成：

- 3 个独立单章完整流水线：草稿 → Review → FactCheck → Brief → Proof。
- 3 个 3 章 Batch，共 9 个 Batch 子章节；每个 Batch 均走规划器和完整流水线。
- 每章目标字数为 800，Batch 模式为 `full`。
- 使用设备中现有的 LLM 配置：配置名“默认配置”、OpenAI 兼容 Provider、模型 `deepseek-v4-flash`；报告不记录 API Key。
- 只使用 `adb install -r` 覆盖安装后的现有应用状态；未卸载、未清数据、未执行 `pm clear`，未重建模拟器。
- 首次真实链路需要通知权限时，仅通过 `pm grant com.shinewriter android.permission.POST_NOTIFICATIONS` 授权；没有触碰应用数据库清理操作。

真实 LLM 测试证据保存在：
`test-logs/real-llm-v2.11.40-20260810/`

其中包含测试前/后 SQLite 快照、每个 Batch 的快照、UI XML/截图、规划与执行 logcat、最终 crash buffer。快照中保留了本轮新增的 Batch 章节数据，未把 API Key 写入文件。

## 2. 单章结果

| 样本 | 任务 ID | 结果字数 | LLM 调用 | 主阶段一次通过 | Formatter | 总 tokens | 阶段耗时 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 单章 A / 第 1 章 | `pt_msmm5x5y_1` | 1207 | 5 | 5/5 | 0 | 8,414 | 34.3s |
| 单章 B / 第 2 章 | `pt_msmmda61_3` | 1113 | 5 | 5/5 | 0 | 12,460 | 71.4s |
| 单章 C / 第 3 章 | `pt_msmmh01j_4` | 1528 | 6 | 4/5 | 1 | 13,266 | 52.7s |

单章使用的实际章节摘要（包含 ADB 文本输入留下的字符转义/拼写痕迹）已保存在最终数据库快照：

1. `A dective finds a brass key at the old sstation%2C solves a short riddle%2C and ends the chapter before opening the locked door.`
2. `An archivist follows a lantern into the flooded library s1%and finds a map to a missing room. The chapter ends when the map changes by itself.`
3. `At dawn the locksmith returns to the station with a broken clock and meets a child who knows his name. The chapter ends when the locked door begins to%breathe.`

单章 C 的 FactCheck 首次响应只有 reasoning 通道可解析内容，记录为 `reasoning_only`，随后由 Contract Formatter 成功恢复；没有完整主审重跑。

另有一次因通知权限/页面操作时序产生的重复单章任务 `pt_msmm735f_2`：5 次调用、17,069 tokens、最终成功。它不计入上述 3 个独立样本，但保留在快照和统计中作为 accidental duplicate。

## 3. Batch 结果

| Batch | Batch ID | 规划 tokens | 子章节结果 | 主阶段一次通过 | Formatter | 总调用 | 输入 / 输出 tokens |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| Batch 1 | `batch_msmmn7nv_umuldy` | 4,489 | 3/3 succeeded | 13/15 | 2 | 17 | 45,694 / 19,779 |
| Batch 2 | `batch_msmmwj8y_vdgj3q` | 2,381 | 3/3 succeeded | 15/15 | 0 | 15 | 97,442 / 29,547 |
| Batch 3 | `batch_msmn5hba_g3402b` | 1,796 | 3/3 succeeded | 11/15 | 4 | 19 | 119,564 / 52,861 |

所有 Batch 均记录为 `pipeline_mode=full`、`outline_workflow_version=4`、`context_budget_version=4`，且 9 个 Batch item 的 `completion_quality` 均为 `full_pipeline`。

### 3.1 九个子章节明细

| 子章节 | 任务 ID | 结果字数 | 调用 | 主阶段一次通过 | Formatter | 总 tokens | 阶段耗时 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| B1-1 黄铜钥匙与沉默的谜语 | `...ord1_1786329902260` | 1248 | 5 | 5/5 | 0 | 10,445 | 37.1s |
| B1-2 水淹档案中的活地图 | `...ord2_1786329939931` | 1734 | 6 | 4/5 | 1 | 23,852 | 59.7s |
| B1-3 黎明时门扉呼吸 | `...ord3_1786330000209` | 1450 | 6 | 4/5 | 1 | 31,176 | 83.7s |
| B2-1 硬币中的密语 | `...ord1_1786330272476` | 2092 | 5 | 5/5 | 0 | 32,646 | 85.2s |
| B2-2 黑暗市场的迷途 | `...ord2_1786330358272` | 3056 | 5 | 5/5 | 0 | 43,154 | 62.4s |
| B2-3 最终交付 | `...ord3_1786330421304` | 1520 | 5 | 5/5 | 0 | 51,189 | 158.5s |
| B3-1 暴风信号 | `...ord1_1786330701632` | 1436 | 6 | 4/5 | 1 | 62,852 | 226.9s |
| B3-2 风暴足迹 | `...ord2_1786330929355` | 2511 | 7 | 3/5 | 2 | 59,725 | 154.1s |
| B3-3 冰下之声 | `...ord3_1786331084249` | 2681 | 6 | 4/5 | 1 | 49,848 | 81.6s |

Batch 规划输入的数据库原文也保留在 `multi_chapter_batches.source_prompt`。其中 Batch 1/2/3 分别为废弃车站、夜市硬币、山地气象站三个 3 章故事；ADB 文本注入造成的 `%` 字符痕迹按实际事实保留。

## 4. 一次通过率、Formatter 与重试

统计口径：只统计 12 个预期章节的 5 个主阶段（共 60 次 primary stage attempt）；primary 响应若需要 Formatter，则不算主阶段语义一次通过，但不算网络失败。

- 主阶段语义一次通过：`53 / 60 = 88.3%`。
- Formatter 恢复：7 次；其中 `reasoning_only` 6 次，`invalid_json` 1 次。
- 非 Formatter 的完整主阶段重试：0 次。
- 失败的主阶段最终请求：0 次。
- 3 次 Batch planner：3/3 成功，共 8,666 tokens。
- 预期测试请求合计：60 个主阶段 + 7 个 Formatter + 3 个 planner = 70 次，全部成功。
- 含 accidental duplicate 的数据库 `llm_usage_logs`：75 次、424,762 tokens，失败 0 次。
- 12 个预期章节中完全不需要 Formatter 的整条流水线：6/12；另外 6 个均由 Formatter 成功恢复并完成。

按组汇总：

| 组别 | 主阶段 | 主阶段一次通过 | Formatter | 调用总数 | 总 tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| 3 个独立单章 | 15 | 14 | 1 | 16 | 34,140 |
| Batch 1 子章节 | 15 | 13 | 2 | 17 | 65,473 |
| Batch 2 子章节 | 15 | 15 | 0 | 15 | 126,989 |
| Batch 3 子章节 | 15 | 11 | 4 | 19 | 172,425 |
| 合计 | 60 | 53 | 7 | 67 | 399,027 |

## 5. 流水线配置事实核对

从 `pipeline_tasks.pipeline_context_json` 和 stage attempt 记录核对到：

- Draft：按用户冻结档位执行 max/thinking enabled。
- Review：effective low/thinking enabled。
- FactCheck：effective low/thinking enabled。
- Brief：跟随用户冻结档位执行 max/thinking enabled，`briefPolicyVersion=4`。
- Proof：按用户冻结档位执行 max/thinking enabled。
- Formatter：只作为合同语义/解析恢复，`thinking disabled`，没有重新跑完整主审。

这与本轮目标“单章与 Batch 共用同一完整流水线、Review/FactCheck 固定 low、Brief 跟随用户档位”一致；本轮没有观察到旧未完成流水线 Resume 分支被使用。

## 6. Batch 落库与数据状态

- 3 个 Batch 均为 `completed`，每个均为 `3/3 succeeded`。
- 9 个 Batch item 均有 `adopted_revision_id`，对应新建章节 4–12；最终 `chapters.content` 长度分别为：1248、1734、1450、2092、3056、1520、1436、2511、2681。
- 单章任务结果写入 task `final_text`，但没有执行采用动作；原有第 1–3 章 `content_len` 仍为 0。
- Batch UI 报告中的“采用草稿：0”表示没有 partial draft adoption；数据库事实显示 9 个 item 均以 `full_pipeline` 质量完成并产生正式 adopted revision。

## 7. 设备与稳定性结果

- 真实配置请求均命中 `deepseek-v4-flash`，没有 mock/fallback 请求。
- 3 个规划请求和 67 个预期章节流水线请求均正常结束。
- 最终 `adb logcat -b crash -d` 为空；未观察到应用崩溃。
- 最长单子任务为 Batch 3 第 1 章 Proof，约 129.6s；未超出预算，也未导致 Batch 中断。长尾耗时仍是后续体验风险。

## 7.1 自动化回归

- `npm run lint`：通过；0 errors，172 个既有 warning。
- `npm run typecheck`：通过。
- `npm run test:ci`：通过；359 个 suite passed、2 个 skipped；2921 个 test passed、4 个 skipped；耗时约 121.9s。
- `npm run verify`：本轮直接执行在工具的 124s 命令窗口达到 timeout，未取得组合命令的最终退出码；将其拆分后，lint、typecheck、test:ci 均已独立通过。该组合超时应视为执行窗口问题，不记为源码测试失败，也不记为组合命令通过。
- `git diff --check`：通过。

## 8. 结论与发版条件

本轮真实 LLM 单章/Batch 验证通过：12 个预期章节全部完成，3 个 Batch 全部 3/3 成功，Formatter 均能闭环恢复，未出现网络失败、非 Formatter 重试或崩溃。一次通过率已从样本不足状态获得可量化基线：主阶段语义一次通过 88.3%，完整章节无 Formatter 一次通过 50%。

本轮结果可以作为统一流水线逻辑和 Batch 状态机的真实链路验收证据，但不单独等同于正式发版放行。正式发版仍需在当前提交代码上完成 Release APK 签名构建、`docs/RELEASE_CHECKLIST.md` 的正式 APK 验收以及既有 `npm run verify`/模拟器回归结果复核。当前工作树还存在本轮之外的历史文档删除/未跟踪改动，不能把它们混入本轮测试提交。
