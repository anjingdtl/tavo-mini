# TAVO-MINI Phase IV Requirement Closure

日期：2026-08-30（Asia/Shanghai）；IV-10 DeepSeek 根因隔离轮更新：2026-08-31
唯一主方案：`docs/optimization/TAVO-MINI_Phase4_流水线再治理与写作通过率恢复计划_20260830.md`
开工时 `HEAD == origin/main == 64b88580c134f67e3fb73d1951ef6bc972da5552`；IV-10 轮基线 `HEAD == origin/main == 8cec6a5f`。
最终状态：`PHASE IV FINAL SEAL HOLD / NO-GO`（2026-08-31 IV-10 更新：401 与"外部 provider 停摆"两个历史 blocker 均已解除/关闭；现余缺口为 10 章批次 9/10——单一 model 侧病态计划被 P0-05 正确 fail-closed）

## 结论（IV-10 后）

Phase IV 主链减法、协议瘦身、Governor 旁路、Context 弹性化、Persistence Boundary 收拢均已落地并通过回归。2026-08-30/31 的 DeepSeek 真实轮完成了 5 章（5/5 adopted，First-Pass 5/5）与 10 章（9/10 adopted，First-Pass 8/10）连续运行；原"Boundary-first Draft 570s 停摆"的根因已在证据支持下**关闭**：不是 provider 特异、不是传输/看门狗缺陷、不是"7k 小上下文"，而是**特定章节计划梗概触发的模型失控超长生成**——对 GLM（thinking-high，推理失控）与 DeepSeek（thinking-off，文本失控）同样成立，经非流式 + 570s 看门狗观测为"无输出停摆"；应用侧全程 fail-closed 正确（length 拒绝持久化、outcome_unknown 零自动 retry、账务完整）。10 章完整分母仍差 1 章（唯一失败章为 model 侧病态计划；同位置重计划已被 5 章批次证明可正常写作），故维持 `HOLD / NO-GO`，不为封板降低标准。

## Final Seal Required Gates（IV-10 后）

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

## P0 Closure

| P0 | 闭环状态 | 证据/说明 |
| --- | --- | --- |
| P0-01 Thinking Always On | PASS（代码/契约） | 写作请求和模型可见契约保持 thinking；无关闭路径 |
| P0-02 不新增 Agent / Multi-Agent | PASS | Phase IV 只改现有 Writing Kernel 路径 |
| P0-03 不新增第二 Writer / Context / Memory / Prompt Compiler | PASS | 未增加第二实例；上下文为既有 projection 的收拢 |
| P0-04 Mandatory Truth 不因 throughput 被裁掉 | PASS（确定性） | Mandatory projection 与 truth/canon safety 保留 |
| P0-05 `finishReason=length` 不持久化为 Final | PASS（确定性） | `truncated_output` 为 Hard Block；Persistence Boundary fail-closed |
| P0-06 `outcome_unknown` 永不自动 retry | PASS（确定性/历史） | C9 `1/38` ledger-only 仍保留；无自动 retry |
| P0-07 Governor 不阻断当前请求 | PASS（确定性） | `phase4GovernorBypass.test.ts` |
| P0-08 Governor physical call = 0 | PASS（确定性/历史） | C9=0；Phase IV Governor 仅本地旁路观察 |
| P0-09 禁止固定业务 maxTokens | PASS（代码/Elastic） | `verify:elastic` 通过；运行时弹性派生，不回写固定业务值 |
| P0-10 Physical Paid Calls 如实计账 | PASS（历史；当前无 paid sample） | C9 paid denominator=38；401 不计为付费成功 |
| P0-11 Android 只 `adb install -r` | PASS | IV-0～IV-7 仅使用签名 release `adb install -r`；未 uninstall/pm clear |
| P0-12 Resume / Idempotency 不退化 | PASS（确定性） | Persistence Boundary、continuous harness 和 C8 证据 |
| P0-13 不允许 Canon / Story Memory 污染 | PASS（确定性） | `canon_state_safety` 保持 Hard Block；状态 sidecar 非法可舍弃但不污染正文状态 |

## 真实解封条件（IV-10 后）

历史 blocker（401 凭据、GLM"边界首章停摆"）均已关闭。当前唯一未满分的 Required Gate 是 10 章批次 9/10（单一 model 侧病态计划，已 root-cause）。按下列固定顺序补证：

1. 维持当前 DeepSeek 配置（`deepseek-v4-flash` @ `api.deepseek.com`，`max_output_tokens=65536`）与同签名 debug 包，仅 `adb install -r`；不清理数据。
2. 连续新开 10 章批次：因失控生成按计划梗概随机/特定触发（今日观测 1/16 计划确定性 + 1/16 随机），遇到 length 截断/timeout 时按 UI 用户确认流程重试或对该章重计划（5 章批次已证明同位置重计划可正常写作），目标形成 10/10 adopted 分母。
3. 用 `phase4ContinuousHarness` 与 `phase4HistoricalAb` 计算真实分母与 A/B；First-Pass 达到历史稳定水平（今日 86.7% vs 历史确定性 100% 的差距需由更大分母或改善收敛判定）且次级指标无回退时，才允许把状态改为 `PHASE IV FINAL SEALED / GO`。
4. 全程不记录 API Key 与小说正文；每章 Receipt/DB/UI/logcat 入 `test-logs/`。
