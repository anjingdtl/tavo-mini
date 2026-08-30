# TAVO-MINI Phase IV Requirement Closure

日期：2026-08-30（Asia/Shanghai）
唯一主方案：`docs/optimization/TAVO-MINI_Phase4_流水线再治理与写作通过率恢复计划_20260830.md`
开工时 `HEAD == origin/main == 64b88580c134f67e3fb73d1951ef6bc972da5552`。
最终状态：`PHASE IV FINAL SEAL HOLD / NO-GO`

## 结论

Phase IV 的主链减法、协议瘦身、Governor 旁路、Context 弹性化、Persistence Boundary 收拢、历史比较器和连续运行 harness 均已落地并通过本地回归。最终 Required Gate 不能全部 PASS：设备上的真实 provider probe 返回 `HTTP 401`（令牌过期或验证不正确），所以当前版本没有合法的真实 Android 5 章/10 章 paid 分母，也没有可用于 First-Pass A/B 的当前 Receipt/DB 样本。

该结论是外部 credential blocker 导致的 `HOLD`，不是把 401 折算成业务成功或业务失败；没有用 mock、contract test、旧版本结果或 C9 projection completion 冒充当前 E2E。

## Final Seal Required Gates

| Required Gate | 结果 | 证据与边界 |
| --- | --- | --- |
| 当前版本真实 Android 5 章连续运行 | HOLD | `test-logs/phase4-iv7-20260830-155254/iv7-check-b.md`；UI 真实连接为 HTTP 401，未形成 paid 分母 |
| 当前版本真实 Android 10 章连续运行 | HOLD | 同上；没有在 credential 失效时强行发起批量付费任务 |
| E2E First-Pass Adoptable Rate 可与历史 A/B 比较 | HOLD | `docs/optimization/phase4-historical-ab.md`；比较器对缺失 current sample fail-closed |
| latency / input-output-reasoning / length / unknown / Context block 可比 | HOLD | C9 数值完整保留；当前没有同口径 paid sample |
| 当前 Receipt / DB / UI / logcat 证据齐全 | HOLD | UI/XML/PNG/logcat 已有；release `run-as` 返回 `package not debuggable`，当前 DB 不能直接拉取 |
| 其余代码、协议和安全边界 | PASS（确定性/静态/历史证据） | 本文 P0 表、全量 verify 和 IV-0～IV-7 evidence index |

## 十项最终问题

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

## 真实解封条件

外部恢复合法 API credential 后，按下列固定顺序补证：

1. 同一签名 release、同一设备、同一 `adb install -r`；不清理已有数据。
2. 在 UI `保存并测试` 验证连接成功；不要在文档中记录或输出 API Key。
3. 用当前冻结上下文连续跑 5 章，再连续跑 10 章；每章采集 First-Pass、physical calls、Governor、Context composition、Resume/Idempotency、Receipt/DB、UI 和 logcat。
4. 用 `phase4ContinuousHarness` 与 `phase4HistoricalAb` 计算真实分母和 A/B；只有所有 Required Gate PASS 才能把状态改为 `PHASE IV FINAL SEALED / GO`。
