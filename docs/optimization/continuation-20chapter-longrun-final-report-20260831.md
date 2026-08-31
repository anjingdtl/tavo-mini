# TAVO-MINI 原著续写 20 章长测最终报告

日期：2026-08-31
项目：`bailimeng-longrun-20260831`（project_id=67，`mode=continuation`）
仓库 HEAD：`d9f84003`
设备：`emulator-5554`，已安装 V2.21.1

## 结论

**最终结果：NO-GO。**

本轮 20 章均完成一次用户发起的正常续写并进入最终采纳状态；第一遍 E2E First-Pass Adoptable Rate 为 **20/20=100.0%**，95% Wilson CI 为 **83.89%–100.00%**。结构性硬一致性检查未观察到 Hard Canon Violation、Future Source Leakage 或 Source Boundary Violation。

但最终门禁不能通过：

1. 两轮盲评合并文学平均分为 **77.3/100**，低于门槛 80。
2. Run B 的目标位置 11（章节 `玄阳来讯`，chapter_id=9283）最终持久化正文仍是 JSON-like 包装而非纯正文；该问题没有被 QA 判出，属于交付完整性/协议泄漏。
3. 另有一处轻微交付格式问题：Run A 目标位置 9 的正文首行重复章节标题；其最终候选只比 draft 少一个尾部换行，没有发生模型重试或 revision writer 请求。

因此，本报告记录为一次完整但未通过最终门禁的长测，不修改 Gate、Context、Governor、Prompt、Retry 或 maxTokens，也不以任何后处理方式掩盖失败证据。

## 1. 测试范围与判定口径

源文本为《白篱梦》，源文本数据库记录为 source_id=4、299 个源章节、规范化字符数 1,033,681。续写边界固定为 `end_of_source`，source position 298，global char offset exclusive 1,033,681。

两轮均通过 `multi_chapter_batch` 入口，单次创建、单次启动、未手动 pause、未手动 retry、未 re-plan、未 recovery 后改写 firstPass。每章只允许一个 continuation generation run；最终采纳以 run 的 `state=completed`、`completion_reason=adopted`、`adopted_revision_hash=finalized_revision_hash` 为准。

本报告中的 First-Pass 定义是：一次正常用户发起写作，在不改设置、不重开任务、不手动 retry 的情况下，最终得到可采纳正文。批处理内部的 QA/revision 属于同一次统一写作内核执行链，不另计为用户 retry。

`multi_chapter_batch_items.retry_count` 在本轮 continuation 路径中是 state gate 等待/轮询计数，不是 LLM provider retry。两轮均未观察到 provider 自动重发；因此报告同时列出两类计数，避免把状态同步等待误报成模型 retry。

## 2. 阶段 0 收尾：DB 真实状态

检查对象为 `test-logs/continuation-20chapter-longrun-20260831/after-canon4.db`，以及 Run B 完成后的最终快照。两份快照均通过 `PRAGMA integrity_check=ok`，`PRAGMA foreign_key_check` 为空。

### Style Profile V2

当前 schema 的合法枚举不是 `active/accepted`：

- `continuation_style_profiles` 真实行数为 1。
- active profile：`3f6eba04-6e3c-47d2-bb4e-c792cc512ca0`（文档中仅保留完整 ID 便于查证，不含正文）。
- `state=ready`、`review_status=pending`、`profile_schema_version=2`、analyzer=`style-v2-4`、confidence=0.95。
- `continuation_settings.active_style_profile_id` 正确指向该行；source、source version、Canon snapshot、boundary 与画像指纹均匹配。
- 当前代码的 `getInjectableStyleProfile`/schema validator 接受 `state=ready` 且非 ignored 的画像，因此该画像是**有效可注入画像**。没有因为 UI 文案再额外触发风格分析重试。

### Canon 与边界

- `active_canon_snapshot_id` 指向活动 snapshot `0d4656b9-892f-4bf9-90dd-9639a75c0d3a`，revision=1、status=ready。
- Canon 快速分析 6/6 完成；characters=13、world rules=3、relationships=8、plot threads=6、timeline events=18、evidence=63。
- continuation source 为 ready，规范化 SHA-256 前缀为 `796e3299f283`。
- 两轮所有 frozen source snapshot 的 source_id/source_version/hash/boundary/canon revision 一致，无运行中漂移。

### Generation settings 与 LLM

`continuation_generation_settings` 存在且字段包含 `strictness_profile`。Run A 的 strictness 为 `balanced`，Run B 为 `strict`；每轮的 7 个保护级别按对应 profile 固定。writer/checker/repair/state extraction/control 的配置均为 Deepseek id=3。

当前配置 UI 没有 planner 的独立模型控件，因此 raw `planner_llm_config_id` 保持 NULL；冻结时按当前 active LLM fallback，20 个 run 的 `settings_snapshot_json` 中 `resolvedModelConfigIds.planner=3`，且 frozen planner config_id=3。这里如实保留该“raw NULL / effective 3”的可观测性差异，没有直接改写已完成 run 的 DB 行。

两轮冻结时共同使用：`pipeline_mode=full`、execution profile=`standard`、reasoning effort=`high`、Thinking=`enabled`、checker enabled、target length=3,000、max repair=1、planner confirmation policy=`never`。所有 43 个物理阶段请求的 receipt 均为 model config id=3、model=`deepseek-v4-flash`、context window=1,000,000、completion capability=200,000。

## 3. Run A：Balanced × 10

批次：`batch_mtgxzzwt_z4nok4`，target positions 0–9；每章成功 10/10，full pipeline 10/10，最终采纳 10/10。

| 指标 | 结果 |
|---|---:|
| 物理阶段请求 | 20 |
| input / output tokens | 464,862 / 60,498 |
| draft_writer | 10 success，request=10 |
| unified_qa | 9 success、1 skipped，request=10 |
| revision_writer | 10 skipped，request=0 |
| final_validate | 10 success，request=0 |
| protocol fallback / formatter fallback | 0 / 0 |
| provider retry | 0 observed |
| state-gate retry_count 合计 | 11 |

QA 的 1 个 skipped 记录保留在 DB，不能解释成成功重试；其余 9 个 QA envelope 为 clean/pass，无未解决 finding。所有 run 均为一章一个 run，state gate 最终完成。

## 4. Run B：Strict × 10

批次：`batch_mtgyrr6g_bnsrdz`，target positions 10–19；每章成功 10/10，full pipeline 10/10，最终采纳 10/10。

| 指标 | 结果 |
|---|---:|
| 物理阶段请求 | 23 |
| input / output tokens | 1,125,017 / 82,078 |
| draft_writer | 10 success，request=10 |
| unified_qa | 10 success，request=10 |
| revision_writer | 3 success、7 skipped，request=3 |
| final_validate | 10 success，request=0 |
| protocol fallback / formatter fallback | 0 / 0 |
| provider retry | 0 observed |
| state-gate retry_count 合计 | 11 |

QA decision 为 7 个 clean/pass、3 个 revise。3 个 revise 分别涉及一处事实用词、一处额心符印连续性、一处人物称谓与皇太女身份信息；均在同一次 pipeline 内各完成 1 次 revision writer，最终未留下对应 unresolved finding。目标位置 11 的 JSON-like 交付包装被 QA clean/pass 放行，构成独立于文学一致性的协议/持久化问题。

## 5. 逐章状态记录

表中的“状态等待计数”不是 provider retry。`revision=1` 表示一次统一 pipeline 内的 revision writer 请求，不是用户重试。

| Run / position | 章节标题 | 最终字符数 | 状态等待计数 | QA | revision | fallback | First-Pass | 最终 adopt | 备注 |
|---|---|---:|---:|---|---:|---:|---|---|---|
| A / 0 | 西山重逢 | 2,004 | 1 | clean/pass | 0 | 0 | yes | yes | — |
| A / 1 | 结发为夫妻 | 3,954 | 1 | clean/pass | 0 | 0 | yes | yes | — |
| A / 2 | 监学风波 | 3,142 | 1 | clean/pass | 0 | 0 | yes | yes | — |
| A / 3 | 帝心难测 | 2,258 | 1 | clean/pass | 0 | 0 | yes | yes | — |
| A / 4 | 圣祖观来客 | 3,433 | 1 | clean/pass | 0 | 0 | yes | yes | — |
| A / 5 | 旧念残响 | 2,957 | 1 | clean/pass | 0 | 0 | yes | yes | — |
| A / 6 | 玄阳归心 | 2,861 | 1 | skipped（无 finding） | 0 | 0 | yes | yes | QA skipped 原始记录保留 |
| A / 7 | 朝堂风云 | 3,013 | 2 | clean/pass | 0 | 0 | yes | yes | 状态 gate 多等一次 |
| A / 8 | 旧梦终散 | 4,791 | 1 | clean/pass | 0 | 0 | yes | yes | — |
| A / 9 | 山高水长 | 2,997 | 1 | clean/pass | 0 | 0 | yes | yes | 首行章节标题重复；仅尾换行规范化 |
| B / 10 | 雨后孤客 | 3,984 | 1 | clean/pass | 0 | 0 | yes | yes | — |
| B / 11 | 玄阳来讯 | 3,774 | 2 | clean/pass | 0 | 0 | yes | yes | JSON-like 包装，交付 NO-GO |
| B / 12 | 迷谷妖雾 | 3,391 | 1 | revise | 1 | 0 | yes | yes | fact finding 已修复 |
| B / 13 | 远古祭坛 | 3,896 | 1 | revise | 1 | 0 | yes | yes | continuity finding 已修复 |
| B / 14 | 碎片共鸣 | 2,634 | 1 | clean/pass | 0 | 0 | yes | yes | — |
| B / 15 | 心魔倒影 | 5,531 | 1 | clean/pass | 0 | 0 | yes | yes | — |
| B / 16 | 无梦之境 | 5,160 | 1 | clean/pass | 0 | 0 | yes | yes | — |
| B / 17 | 故人归来 | 1,535 | 1 | clean/pass | 0 | 0 | yes | yes | 引号结尾，标记为非句号闭合 |
| B / 18 | 溪边拾忆 | 3,781 | 1 | clean/pass | 0 | 0 | yes | yes | — |
| B / 19 | 岁岁年年 | 2,753 | 1 | revise | 1 | 0 | yes | yes | voice / required event 已修复 |

补充：20 个 `continuation_generation_runs` 均为 `state=completed`、`stage=awaiting_user`、`completion_reason=adopted`，`adopted_revision_hash` 与 `finalized_revision_hash` 全部相等。20 个章节均为 `finalized`。

## 6. KPI 与 Wilson 95% CI

| KPI | A | B | 合计 |
|---|---:|---:|---:|
| E2E First-Pass Adoptable Rate | 10/10 = 100.0%（72.25%–100.00%） | 10/10 = 100.0%（72.25%–100.00%） | **20/20 = 100.0%（83.89%–100.00%）** |
| Draft Direct-Adopt（无 revision writer 物理请求） | 10/10 = 100.0%（72.25%–100.00%） | 7/10 = 70.0%（39.68%–89.22%） | **17/20 = 85.0%（63.96%–94.76%）** |
| Draft 与最终 artifact 原始等值 | 9/10 = 90.0%（59.59%–98.21%） | 7/10 = 70.0%（39.68%–89.22%） | **16/20 = 80.0%（58.40%–91.93%）** |

Draft Direct-Adopt 与 First-Pass 不合并：前者只衡量是否经过 revision writer，后者衡量一次用户写作是否最终可采纳。A/9 的差异只是一处尾部换行 canonicalization，所以 operational direct-adopt 为 yes，但原始 artifact equality 为 no。

最终门禁：First-Pass ≥90% **通过**；Hard Canon=0（本轮观察）**通过**；Literary Avg ≥80 **失败**，因此总结果 NO-GO。

## 7. 脱敏盲评

### 方法

对最终持久化正文生成 label-only 输入，评审输入只保留 Writer Style 要求与最终正文；评审不知道 Run A/B、章节位置、源边界位置或是否为目标候选。进行了两轮不同顺序的 blinded scoring。两轮由同一评审器完成，不能等同两名独立评审；该限制已纳入结果解释。

10 项 rubric，每项 1–5：Writer Style/Voice Fit、Prose Naturalness/Diction/Rhythm、Dialogue Naturalness、Character Consistency、Canon Fidelity、Continuity/Seam、Scene Construction/Imagery、Causal/Conflict Logic、Pacing/Proportion、Ending + Plain-text Delivery Completeness。Overall/100 = 10 项合计 × 2。

| Label | R1 十项分数 | R1 /100 | R2 十项分数 | R2 /100 | 平均 |
|---|---|---:|---|---:|---:|
| S01 | 4/4/4/4/4/4/3/4/4/4 | 78 | 4/4/4/4/4/4/4/4/4/4 | 80 | 79 |
| S02 | 4/4/4/4/5/4/4/4/4/4 | 82 | 4/4/4/4/4/4/4/4/4/4 | 80 | 81 |
| S03 | 4/4/4/4/5/4/4/4/3/4 | 80 | 4/4/4/4/5/4/4/4/3/4 | 80 | 80 |
| S04 | 4/4/4/4/5/4/4/4/3/4 | 80 | 4/4/4/4/4/4/4/4/3/4 | 78 | 79 |
| S05 | 1/1/1/2/4/3/2/3/2/1 | 40 | 1/1/1/2/4/3/2/2/2/1 | 38 | 39 |
| S06 | 4/4/4/4/4/4/4/4/4/4 | 80 | 4/4/4/4/4/4/4/4/4/4 | 80 | 80 |
| S07 | 4/4/4/4/4/4/4/4/3/4 | 78 | 4/4/4/4/4/4/4/4/3/4 | 78 | 78 |
| S08 | 4/4/4/4/4/4/4/4/3/4 | 78 | 4/4/4/4/4/4/4/4/3/4 | 78 | 78 |
| S09 | 4/4/4/4/4/4/4/4/3/4 | 78 | 4/4/4/4/4/4/4/4/3/4 | 78 | 78 |
| S10 | 4/4/4/4/4/4/3/4/3/4 | 76 | 4/4/4/4/4/4/4/4/3/4 | 78 | 77 |
| S11 | 4/4/4/4/4/4/4/4/4/4 | 80 | 4/4/4/4/4/4/4/4/3/4 | 78 | 79 |
| S12 | 4/4/4/4/5/4/4/4/4/4 | 82 | 4/4/4/4/4/4/4/4/4/4 | 80 | 81 |
| S13 | 4/4/4/4/5/4/4/4/4/4 | 82 | 4/4/4/4/5/4/4/4/4/4 | 82 | 82 |
| S14 | 4/4/4/4/4/4/3/4/3/4 | 76 | 4/4/4/4/4/4/3/4/3/4 | 76 | 76 |
| S15 | 4/4/4/4/5/4/5/4/3/4 | 82 | 4/4/4/4/5/4/4/4/3/4 | 80 | 81 |
| S16 | 4/4/4/4/4/4/4/4/3/4 | 78 | 4/4/4/4/4/4/4/4/3/4 | 78 | 78 |
| S17 | 4/4/4/4/4/4/4/4/3/3 | 76 | 4/4/4/4/4/4/4/4/3/3 | 76 | 76 |
| S18 | 4/4/4/4/5/4/4/4/4/4 | 82 | 4/4/4/4/4/4/4/4/4/4 | 80 | 81 |
| S19 | 4/4/4/4/5/4/4/4/4/4 | 82 | 4/4/4/4/5/4/4/4/4/4 | 82 | 82 |
| S20 | 4/4/4/4/5/4/5/4/3/4 | 82 | 4/4/4/4/5/4/4/4/3/4 | 80 | 81 |

R1 平均为 77.6，R2 平均为 77.0，合并平均 **77.3/100**。按运行回填后，A 平均 79.0，B 平均 75.6。去除唯一交付包装异常对应的诊断样本后，平均为 79.3，仍不能用来通过 80 分门槛；正式门禁使用包含异常的全量结果。

## 8. 硬一致性与持久化审计

| 检查项 | 结果 | 证据/口径 |
|---|---|---|
| Hard Canon Violation | 0 observed/unresolved | strict QA 无 hard-canon finding；最终局部重扫未发现未解决硬冲突 |
| Future Source Leakage | 0 structural | source chapters 只有 position 0–298，boundary 之后行数为 0；只据本地源快照判断 |
| Source Boundary Violation | 0 | 20 个 frozen anchor 的 source/hash/boundary/canon revision 一致 |
| 人物漂移 | 0 final unresolved | B 的 1 个人物称谓 finding 经 revision 后未留下 unresolved；不是把 transient finding 删除 |
| 时间线 / 空间 / 物件 | 0 observed/unresolved | 20 章审计未发现未解决项 |
| Story Memory | 0 persistence error | 20 个 memory snapshots，through positions 0–19；20 个 outbox 均 completed、attempt_count=1 |
| 跨章接续 / 接缝锚点 | 0 drift observed | target positions 0–19 连续，前章锚点与下一章 run 绑定一致 |
| 必删点 | 0 unresolved | 本轮 custom rules 为空，未发现未解决 must-delete 记录 |
| state proposal/event | 0 / 0 | `continuation_state_proposals` 与 `continuation_state_events` 均无行；不代表跳过了 memory 持久化 |
| continuation check result | 0 rows | QA findings 保存在 unified_qa stage envelope，本表为空是当前实现事实 |

QA 共记录 4 个 transient findings：fact=1、continuity=1、character_voice=1、missing_required_event=1；其中 3 个在同一 pipeline 内 revision 后闭合。`continuation_generation_artifacts` 有 20 个 draft、3 个 revision_1、20 个 final eligible；没有删除失败记录。

## 9. 风格统计与累积衰减

统计基于最终持久化正文，未把正文写入本报告。句长为句子平均字符数；重复率为同一规范化算法下 `1 - unique_sentence_ratio`；转场次数为转场提示统计；结尾按标点代理规则分类。Run B position 11 的包装会严重拉高段长，因此同时标出该异常的诊断影响。

| 桶 | n | 字符均值 | 句长均值 | 对白率 | 段长均值 | 重复率 | 转场均值 | 句号闭合 / 非句号闭合 | 包装泄漏 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1–5 | 5 | 2,958.2 | 18.06 | 31.59% | 29.29 | 1.15% | 0.20 | 5 / 0 | 0 |
| 6–10 | 5 | 3,323.8 | 20.05 | 32.64% | 33.59 | 0.13% | 0.00 | 4 / 1 | 0 |
| 11–15 | 5 | 3,535.8 | 21.03 | 24.52% | 220.59* | 0.95% | 0.20 | 4 / 1* | 1 |
| 16–20 | 5 | 3,752.0 | 19.87 | 27.11% | 41.48 | 0.62% | 0.20 | 4 / 1 | 0 |

`*` 11–15 的段长与非句号闭合受 position 11 包装异常影响；排除该单个异常做内存诊断时，该桶段长均值为 40.23、4/4 句号闭合。全量 20 章段长均值为 81.24，排除包装异常为 35.93；全量字符均值为 3,392.45。

观察到的累积趋势：篇幅均值从 2,958.2 增至 3,752.0，没有衰减；句长在 11–15 桶达到 21.03 后回落至 19.87；对白率从 32.64% 降至 24.52% 后回升至 27.11%；重复率低且非单调。主要异常集中在交付协议包装，而不是单调风格崩坏。A/9 另有 1 次首行标题重复；全量 20 章中 adjacent duplicate=2。

所有 43 个 receipt 的 finish 统计为 `stop=41`、`length=2`；`emptyReason=reasoning_only` 出现 8 次，visibleOutputTokens 字段均缺失/NULL。由于对应章节仍有持久化候选正文，这些字段被记录为 telemetry/protocol anomaly，不被擅自解释为“正文为空”，也没有触发自动重发。protocolFallback 与 formatterFallback 均为 0。

## 10. 运行稳定性与证据文件

清理 logcat 后启动与轮询期间，crash buffer 未发现应用 crash/ANR；日志中的 uiautomator 启停 `AndroidRuntime` 行属于 UI dump 工具本身，未计为应用崩溃。Run A/B 的完成截图、UI XML、轮询日志和 DB 快照均保存在：

`E:\AiWorkSpace\tavo-mini\test-logs\continuation-20chapter-longrun-20260831\`

代表性证据：

- `after-canon4.db`：Canon 完成后的阶段 0 DB 快照。
- `after-standard-config-20260831-1615.db`：标准执行 profile、Thinking ON、full pipeline 配置快照。
- `after-balanced-config-20260831-1610.db`、`after-strict-config-20260831-1625.db`：两套 strictness 配置快照。
- `after-runA-completed-20260831-1618.db`、`after-runB-completed-20260831-1633.db`：两轮完成后的 DB 快照，均使用 adb `exec-out` 二进制拉取。
- `db-schema-after-runB.txt`、`db-summary-after-runB.txt`、`run-stage-check-summary.txt`、`canon-state-summary.txt`：结构与阶段汇总。
- `screen-batch-report-runA-20260831-1618.png`、`screen-batch-report-runB-20260831-1633.png`：批次完成 UI 证据；对应 XML 与 logcat 轮询文件同目录保存。

DB、截图、日志均未复制到文档正文；大 SQLite 不进入提交内容。

## 11. 脱敏与后续建议

本报告与 manifest 不包含 API key、Authorization、完整用户 prompt、完整原著或大量生成正文；正文异常仅以类型、章节位置和审计结果描述。原始 evidence 保留在本地测试工件目录，用于复核，不作为源码/报告内嵌数据。

下一步应优先定位“writer/QA receipt 已有输出但最终正文仍保留 JSON-like wrapper”的协议边界与持久化入口，并补充对非纯文本最终候选的 fail-closed 检查；同时补足 QA skipped/`finish=length`/`reasoning_only` 的可观测性。修复后应在不调整门禁与统计口径的前提下重跑同等规模长测。
