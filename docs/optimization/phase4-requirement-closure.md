# TAVO-MINI Phase IV Requirement Closure

日期：2026-09-01（Asia/Shanghai）
施工仓：`E:\AiWorkSpace\tavo-mini`
当前主方案：`docs/optimization/TAVO-MINI_Phase4_IV13U_一致性与唯一性收口修复方案_20260901.md`
IV-12A 开工时 `HEAD == origin/main == 24b65486337cf0c45a2a5aa9d82661d0f1644f23`。
当前状态以 [`phase4-iv13u-progress.md`](phase4-iv13u-progress.md) 为唯一 SSOT：`PHASE IV FINAL SEALED / GO`

## Historical Evidence — IV-12A～E 结论（不代表当前态）

历史封板语句（不代表当前态）：`PHASE IV FINAL SEALED / GO`

IV-12A～E 完成了以真实 Writer Style 为 SSOT 的 Style Requirement / Adherence 合同、4 类计划 × Fast/Standard/Quality 同题 A/B、Narrative Completion 验收和 Completion Boundary 文学回归。12 个样本全部有效：三档均 4/4 完成与 first-pass；25/25 条 Style Requirement 均完成评测，Adherence=1.0、Hard Style Violation=0、Style Drift=0；Scene Completion、Beat Realization、Character Consistency、Causal Continuity、Ending Effectiveness 及 Boundary 五项均 PASS。

Historical Required Gates（IV-12）：

| Required Gate | 结果 | 证据与边界 |
| --- | --- | --- |
| Writer Style SSOT / Requirement Projection | **PASS** | 真实冻结 Style；25 条要求（Mandatory 4 / Preferred 19 / Avoid 2）；12/12 assessed、unknown=0 |
| Fast / Standard / Quality 同题 A/B | **PASS** | 同 Plan fingerprint、同 Style/Projection fingerprint、同 Context 构建版本；4×3=12 样本可配对 |
| Writer Style Adherence | **PASS** | 三档均 1.0；Hard Style Violation=0；Style Drift=0 |
| Narrative Completion | **PASS** | 五项维度逐样本通过，最低分 3/4 |
| Completion Boundary 文学回归 | **PASS** | 无场景缩水、摘要化、情绪过快、动作链截断、慢节奏清单化或模板化结尾 |
| Safety / Throughput | **PASS** | Thinking enabled；Mandatory Truth 保持；Governor physical call=0；无 hidden retry；12/12 first-pass |
| Receipt / DB / Android | **PASS** | 三份 DB integrity=ok；快照恢复 SHA-256 一致；`adb install -r`；crash/ANR=0 |
| Engineering | **PASS** | full verify、targeted 13/13、typecheck、lint quiet、Elastic、version、APK 全通过 |

## Historical Evidence — Final Seal Required Gates（IV-10 后，封存）

> 本表只保留 IV-10 当时的验收快照；其中的 9/10 与 NO-GO 已由 IV-12A～E 当前矩阵和最终工程复核替代，不是当前状态。

| Required Gate | 结果 | 证据与边界 |
| --- | --- | --- |
| 当前版本真实 Android 5 章连续运行 | **PASS** | `test-logs/phase4-deepseek-rca-20260830/`：DeepSeek 5/5 adopted、First-Pass 5/5、总调用 11、in 727,531 / out 15,414 |
| 当前版本真实 Android 10 章连续运行 | **NO-GO（9/10）** | 同目录：9/10 adopted（First-Pass 8/10）；唯一失败章「账册的末行」3 次尝试全部为模型失控生成（1×570s@200k cap、2×length@65,536 cap），P0-05 fail-closed 正确；同位置重计划（卷中遗页）正常通过 |
| E2E First-Pass Adoptable Rate 可与历史 A/B 比较 | **NO-GO（有真实分母）** | DeepSeek 合计 13/15 = 86.7% < 历史确定性 8/8 = 100%（比较器规则 `current_first_pass_below_historical`）；次级 outcome_unknown 2/34 vs C9 1/38 回退。数据真实，不达标即 NO-GO，不折算 |
| latency / input-output-reasoning / length / unknown / Context block 可比 | **有真实样本** | DeepSeek draft provider 延迟 20–90s（C9 p50 187.7s）；draft input 51.5k–74.3k（C9 p50 38.1k，3000 字目标 + standard 思考口径差异已标注）；length 事件 2/34 paid pipeline 调用（C9 5/38） |
| 当前 Receipt / DB / UI / logcat 证据齐全 | **PASS** | debug 签名 `run-as` 可直接拉取 DB（`db-batch5-final.sqlite` 等 11 份快照）；UI/XML/PNG/logcat/crash buffer（空）齐全 |
| 其余代码、协议和安全边界 | PASS | 全量 verify（532 suites / 3760 tests）、typecheck、lint --quiet、verify:elastic 全绿；P0 表见下 |

## 十项最终问题（下列 1–10 为 IV-9 时回答，历史保留；第 4/5 条已被 IV-10 真实样本取代，更新见上表）

1. **Hard Gate 从多少降到多少？**  本次可审计 inventory 共 18 项候选/交叉门禁，收敛为 8 项 Hard Block；另有 3 项 Advisory、3 项 Merge、4 项 Remove。这里的“18”是 inventory 总数，不把 18 项错误地称为 18 个 Hard Gate。
2. **JSON Contract 减少多少？**  Compact clean 合同从代表性旧 envelope 的 96 字符降为 `{"decision":"clean"}` 的 20 字符，字符数减少 76、约 79.2%；这是协议形状指标，不是 token 账单指标。Revision 采用正文优先，hash/fingerprint/diff/changeset 尽量本地计算。
3. **Draft / QA / Revision input 降低多少？** 结构和代码路径已改为 Mandatory + Elastic Optional、stage-specific projection、exact dedupe，QA/Revision 不再无脑复制 Draft Optional；但当前版本没有真实 paid 分母，不能诚实给出 E2E input 降幅百分比。C9 基线 p50/p95 input：`38125/42615`。
4. **First-Pass 成功率提升多少？** 当前不可判定。C9 没有 First-Pass/Adoptable 字段，当前版本因 401 没有合法分母；历史 `8/8` deterministic 与 `2/2` restricted real 仅作历史背景，不计入当前版本。
5. **p50/p95 latency 改善多少？** 当前不可判定。C9 provider p50/p95=`187740/337781 ms`，total p50/p95=`187764/337786.8 ms`；当前无同口径 paid sample。
6. **length / Context block / JSON failure 下降多少？** 当前不可判定。C9 `finishReason=length=5/38=13.16%`、`outcome_unknown=1/38=2.63%`、exact-set invalid-format=`0/38`；Context block 没有可用 C9 分母。规则层已保持：length 不落 Final、unknown 不自动 retry、Mandatory Truth 不丢。
7. **Governor 是否完全旁路？** 是。当前请求不再接受 learned recommendation 的阻断；Governor physical call 保持 0。只有数学上无法满足 Provider 硬能力时才允许 fail-closed。
8. **C8 Resume / C9 Observability 是否保持？** 是。C8 Resume、C9 Receipt/ledger/aggregate/projection 和历史失败证据均保留；Persistence Boundary 继承 Resume/Idempotency，未改写历史 C9 证据。
9. **P0 安全是否全部保留？** 代码/确定性检查/历史证据层面是；当前真实 5/10 Android 运行仍待凭据恢复后补证。P0 逐项见下表。
10. **是否回到正常写作链而非工程协议链？** 是（实现方向）。Compact 主链为 `Freeze → Draft → ONE QA → (optional Revision) → local Persistence Boundary`，不新增 LLM stage；最终 E2E 通过率仍需真实样本确认。

## Historical Evidence — P0 Closure（IV-12）

| P0 | 闭环状态 | 证据/说明 |
| --- | --- | --- |
| P0-01 Thinking Always On | PASS（当前矩阵） | IV-12 三档 12 个样本均为 `thinking=enabled`；无关闭路径 |
| P0-02 不新增 Agent / Multi-Agent | PASS | Phase IV 只改现有 Writing Kernel 路径 |
| P0-03 不新增第二 Writer / Context / Memory / Prompt Compiler | PASS | 未增加第二实例；上下文为既有 projection 的收拢 |
| P0-04 Mandatory Truth 不因 throughput 被裁掉 | PASS（确定性） | Mandatory projection 与 truth/canon safety 保留 |
| P0-05 `finishReason=length` 不持久化为 Final | PASS（确定性） | `truncated_output` 为 Hard Block；Persistence Boundary fail-closed |
| P0-06 `outcome_unknown` 永不自动 retry | PASS（确定性/历史） | C9 `1/38` ledger-only 仍保留；无自动 retry |
| P0-07 Governor 不阻断当前请求 | PASS（确定性） | `phase4GovernorBypass.test.ts` |
| P0-08 Governor physical call = 0 | PASS（当前矩阵） | IV-12 三档真实矩阵均为 0；Governor 仅本地旁路观察 |
| P0-09 禁止固定业务 maxTokens | PASS（代码/Elastic） | `verify:elastic` 通过；运行时弹性派生，不回写固定业务值 |
| P0-10 Physical Paid Calls 如实计账 | PASS（当前矩阵） | IV-12 calls=20（Fast 4 + Standard 8 + Quality 8）；每章物理请求为 1/2/2；无重复收费或 hidden retry |
| P0-11 Android 只 `adb install -r` | PASS | IV-12 使用同代码 debug APK 的 `adb install -r`；未 uninstall/pm clear；测试后恢复设备快照 |
| P0-12 Resume / Idempotency 不退化 | PASS（确定性/历史回归） | Persistence Boundary、continuous harness、C8 证据与本轮 DB 快照恢复均通过 |
| P0-13 不允许 Canon / Story Memory 污染 | PASS（确定性） | `canon_state_safety` 保持 Hard Block；状态 sidecar 非法可舍弃但不污染正文状态 |

## Historical Evidence Index（IV-12）

- Writer Style / Narrative / Boundary 报告：`docs/optimization/TAVO-MINI_Phase4_IV-12A_WriterStyle文学质量验收测试报告_20260831.md`
- 脱敏 annotations：`test-logs/phase4-iv12a-20260831/annotations-v2.json`
- 脱敏 Writer Style evidence：`test-logs/phase4-iv12a-20260831/writer-style-evidence-v2.json`
- Literary Shape Telemetry：`test-logs/phase4-iv12a-20260831/writing-quality-shape-telemetry-v2.json`
- Android / DB / UI / logcat：`test-logs/phase4-iv12a-20260831/`、`test-logs/phase4-iv12a-preflight-20260831/`

## Historical Evidence — 真实解封条件（IV-10，已完成并封存）

> 本节只保留 IV-10 当时的解封条件与操作记录，已由 IV-12A～E 完成闭环，不是当前待办。

历史 blocker（401 凭据、GLM"边界首章停摆"）均已关闭。当时唯一未满分的 Required Gate 是 10 章批次 9/10（单一 model 侧病态计划，已 root-cause）；该段为 IV-10 Historical Evidence，不是当前解封条件。

1. 维持当前 DeepSeek 配置（`deepseek-v4-flash` @ `api.deepseek.com`，`max_output_tokens=65536`）与同签名 debug 包，仅 `adb install -r`；不清理数据。
2. 连续新开 10 章批次：因失控生成按计划梗概随机/特定触发（今日观测 1/16 计划确定性 + 1/16 随机），遇到 length 截断/timeout 时按 UI 用户确认流程重试或对该章重计划（5 章批次已证明同位置重计划可正常写作），目标形成 10/10 adopted 分母。
3. 用 `phase4ContinuousHarness` 与 `phase4HistoricalAb` 计算真实分母与 A/B；First-Pass 达到历史稳定水平（今日 86.7% vs 历史确定性 100% 的差距需由更大分母或改善收敛判定）且次级指标无回退时，才允许把状态改为 `PHASE IV FINAL SEALED / GO`。
4. 全程不记录 API Key 与小说正文；每章 Receipt/DB/UI/logcat 入 `test-logs/`。
