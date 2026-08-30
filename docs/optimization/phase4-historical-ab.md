# Phase IV-6 Historical A/B Throughput Recovery

日期：2026-08-30（Asia/Shanghai）
主方案：`docs/optimization/TAVO-MINI_Phase4_流水线再治理与写作通过率恢复计划_20260830.md`

## 结论先行

`IV-6 = HOLD / 未封 GO`。

当前版本的确定性比较器、Gate/JSON/Context/Persistence 证据已具备，但设备上保存的真实 provider 返回 `HTTP 401`，没有形成新的当前版本 paid E2E 样本。因此不能证明“Phase IV 当前 First-Pass Adoptable Rate ≥ 历史稳定版本”，也不能把 mock/contract test 当成真实通过率。凭据恢复后只需补采当前版本的同口径 5/10 章样本，再重跑本比较器。

## 三方证据

| 指标 | 历史通过率治理稳定版本 | Phase IV Baseline（C9） | Phase IV 当前版本 |
|---|---|---|---|
| E2E First-Pass Adoptable | Outline/Continuation deterministic Android `8/8`；另有受限真实 LLM smoke `2/2`，均为历史结果 | C9 aggregate 没有 First-Pass/Adoptable 字段；23 个 unique projection 中 `17 completed / 5 failed / 1 interrupted` 仅作状态参考，不能冒充 First-Pass | `HOLD`：尚无当前版本真实 paid E2E 分母；真实 provider probe 为 401 |
| latency | 历史报告明确不做 P50/P95 | provider p50/p95=`187740/337781 ms`；total p50/p95=`187764/337786.8 ms` | 未形成可比 paid 样本 |
| input/output/reasoning | 未形成统一统计 | p50 input/output/reasoning=`38125/11435/9587`；p95=`42615/17017.4/15633.8` | 未形成可比 paid 样本 |
| JSON failure | 历史 8/8 回归未给出同口径 JSON 分母 | `0/38`（C9 exact-set） | 未形成可比 paid 样本；Phase IV 最小协议为 contract evidence |
| Context block | 未形成同口径阻滞率 | C9 aggregate 未提供 Context block 分母 | contract evidence：Mandatory 保留、无关 Optional 被丢弃/去重；不宣称真实 block rate=0 |
| `finishReason=length` | 历史报告未给统一比例 | `5/38 = 13.16%` | 未形成可比 paid 样本；规则已保持 fail-closed |
| `outcome_unknown` | 历史报告未给统一比例 | `1/38 = 2.63%` | 未形成可比 paid 样本；规则保持永不自动 retry |
| physical calls | 历史报告未给统一全量 call 分母 | writer/total paid=`38/38`，Governor=`0`，aux=`0` | 本轮真实 probe 未进入付费成功样本；Governor contract=`0` physical call |

历史来源：`docs/optimization/TAVO-MINI_第二期_Final-Seal_最终封板报告_20260820.md`。C9 数字来源：`test-logs/phase3-c9-cost-latency-20260830-000001/c9-aggregate.json`。两者均保留为历史证据，不被本轮改写。

## 当前版本已验证的减法信号（非 E2E 通过率）

- Gate inventory：18 项，`Hard 8 / Advisory 3 / Merge 3 / Remove 4`；Governor 当前请求否决、Formatter rescue call、model-side fingerprint 和重复诊断已从 Phase IV 标记路径移除。
- 最小 QA clean JSON：`{"decision":"clean"}`，20 字符；测试中的旧代表性 envelope 为 96 字符。该比例只说明协议形状收缩，不等同 token 账单下降。
- Context：`Mandatory + Elastic Optional` projection、Optional exact dedupe 和 composition Receipt 已通过确定性测试；不会优先用整章阻断替代压缩/去重/降相关度。
- Persistence：FinalValidate 非 skipped 时是唯一落盘候选；空结果 fail-closed；非法 State Sidecar 可本地舍弃；未新增 LLM stage。
- 全量 CHECK-A：`npm.cmd run verify` 通过（529 suites passed / 3 skipped；3742 tests passed / 8 skipped）。

## 决策规则与可复现证据

`__tests__/phase4HistoricalAb.test.ts` 先在缺少当前真实样本时锁定 `HOLD`，再覆盖：当前 First-Pass 达到历史且次级失败率改善时才 `GO`、First-Pass 低于历史时 `NO-GO`、非法分母 fail-closed。实现：`src/services/writing/metrics/phase4HistoricalAb.ts`。

当前真实 Android 证据：`test-logs/phase4-iv5-20260830-153500/iv5-check-b.md`。其中同签名 release 使用 `adb install -r` 成功、数据未清理、UI 可用，但 provider 返回 401；该外部凭据阻滞不被错误折算为业务成功或业务失败率。

## ACT

保持主链减法实现，不为填表新增工程 Gate、重试或额外 LLM。进入 IV-7 的确定性连续运行 harness 与证据结构；真实 5/10 章仍受同一 credential blocker 约束，凭据恢复后补测并回填本表。
