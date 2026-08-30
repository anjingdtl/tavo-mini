# TAVO-MINI Phase IV-0：Baseline & Blocking Pareto

日期：2026-08-30（Asia/Shanghai）
Exact HEAD：`64b88580c134f67e3fb73d1951ef6bc972da5552`
`origin/main`：`64b88580c134f67e3fb73d1951ef6bc972da5552`
工作区：开工时无已跟踪改动；未跟踪用户文件未触碰。
范围：只读聚合 Phase III-C C3-C9 既有 Receipt/ledger/projection 与历史报告，不修改生产逻辑、不改写历史失败证据。

## 1. 继承与冻结

- C8 Durable Resume 与 C9 Observability 作为 Phase IV 的底层能力继承。
- 旧 C10 保持 `IN PROGRESS / user-directed stop / Android pending` 的历史状态；不继续旧 Phase III-C Final Seal，不删除旧 C10 Red、C8/C9 失败、`finishReason=length`、`outcome_unknown`、provider/network/parse 失败证据。
- Phase III-C C9 的 `Governor physical call=0` 与真实 paid-call 账务作为安全基线保留；Phase IV 目标是让 Governor 彻底不影响当前请求，而不是重新引入调用。

## 2. C3-C9 当前真实基线

来源：`test-logs/phase3-c9-cost-latency-20260830-000001/c9-aggregate.json`，selection 规则为“每个 unique run 只取一个 final safe projection，排除 poll snapshot；Fast/Standard 与 Quality 证据分开处理”。

| 指标 | 基线 | 解释 |
| --- | ---: | --- |
| 去重 Fast/Standard case | 23 | C3-C9 projection 级 case |
| 带 Receipt 的 paid requests | 37 | 每个 physical request 的可见 Receipt |
| paid request denominator | 38 | 另有 1 个 `outcome_unknown` ledger-only request，不能伪造成 Receipt |
| Writer physical calls | 38 | 与 paid denominator 对齐 |
| Total paid calls | 38 | post-writing auxiliary = 0 |
| Governor physical calls | 0 | 继承安全事实 |
| protocol fallback | 0 | 继承安全事实 |
| provider latency p50 / p95 | 187,740 / 337,781 ms | 约 187.7 / 337.8 秒 |
| total latency p50 / p95 | 187,764 / 337,786.8 ms | 主要由 provider 占用 |
| input tokens p50 / p95 | 38,125 / 42,615 | 当前 Draft/宽上下文高位 |
| output tokens p50 / p95 | 11,435 / 17,017.4 | 含 reasoning |
| reasoning tokens p50 / p95 | 9,587 / 15,633.8 | 高于 visible output |
| visible output tokens p50 / p95 | 1,592 / 2,348.2 | 正文/报告可见产物偏小 |
| timeout | 0 / 38 | 不是当前主要阻滞 |
| `outcome_unknown` | 1 / 38 = 2.63% | 必须继续 fail-closed、禁止 retry |
| `finishReason=length` | 5 / 38 = 13.16% | 最大已观测硬失败来源；不得放宽持久化安全 |
| exact-set invalid-format | 0 / 38 | 仍需保留本地协议防线 |
| dynamic budget utilization p50 / p95 | 0.2404 / 1 | Governor/弹性预算观测值，不应再阻断当前请求 |

C9 代表性 Standard Clean run：Draft input/output/reasoning/visible = `42081/17851/15534/2317`，provider `299472 ms`；QA = `24349/1455/1324/131`，provider `25664 ms`；总 physical = `2`，总 token = `85736`。这证明当前 QA 仍携带大输入与结构化协议成本，而 Draft 的 reasoning 占用明显高于可见正文。

## 3. 历史稳定对照

Phase III-B 最终报告选定的 4 个新鲜 Standard Issue 章节（Outline 2 + Continuation 2）每章 D/Q/R 均完成、最终 `finishReason=stop`、每章 physical = `3`，可作为“质量/安全收口后的历史稳定对照”。其对照不是等价的 Phase IV 通过率样本：

- Phase III-B 选择样本是人为挑选的 clean/issue 定稿样本；没有把历史 retry、length、旧失败 run 计入成功样本。
- Phase IV 的第一 KPI 改为一次正常发起后直接得到可采纳正文，因此必须重新记录分母，不能用“最终成功样本”替代 First-Pass Adoptable Rate。
- 对照来源：`docs/optimization/phase3-b-final-report.md` §3-§5、§13；续写 9232/9233 与大纲 9234/9235 的真实 evidence 仍原样保留。

## 4. Blocking Pareto

### 4.1 已证实阻滞

| 排名 | 阻滞族 | 观测证据 | 业务影响 | Phase IV 处置 |
| ---: | --- | --- | --- | --- |
| 1 | `finishReason=length` | `5/38` paid denominator；C3-C9 profiles 仍出现 length signal | 截断正文若进入 Final 会污染章节；这是 P0，不能降级 | KEEP HARD BLOCK；去除无关协议/上下文成本，保留完整正文门禁 |
| 2 | 当前请求 Governor / output preflight | C9 Receipt 记录 production Governor enabled/ready，`resolveStageWireMax()` 仍会对 `decision.blocked` 抛 `WRITING_GOVERNOR_PREFLIGHT_BLOCKED` | 学习状态可能把本轮直接挡住，违背旁路原则 | IV-3 移除 current-request veto；只写 next-request recommendation |
| 3 | QA/Revision 结构化合同过宽 | QA 提示要求 `verdict/findings/content/stateProposals`；Revision 要求 `schemaVersion/strategy/actions/preserve/ending`，还有 proposal/segment-repair 兼容 | 推理和可见输出被协议占用，parse/contract failure 让正文不能一次通过 | IV-2 QA 最小 `{decision,findings?}`；Revision 完整正文优先，sidecar 可选 |
| 4 | Stage Context 复制与宽 union | C9 Draft/QA input `42081/24349`；当前 `stageContextProjection` 对 Draft 保留 `*`，QA 是 12-kind union，Revision 仍携带多类 Optional | QA/Revision 重复读取低相关资料，耗时与 length 风险上升 | IV-4 Mandatory + Elastic Optional；按 stage 去重/压缩 Optional，不能裁 Mandatory |
| 5 | 质量与安全 Gate 混合 | 当前 `assertStructuredReport`、QA strict validator、Revision contract 与 Final Validate/semantic apply 交错 | 文学质量不确定会表现成整章失败，安全边界难以单独审计 | IV-1/IV-5 质量 Advisory，P0 收拢到 Persistence Boundary |
| 6 | `outcome_unknown` | `1/38`，已有 ledger-only 账务 | 重发会双收费/重复副作用 | KEEP HARD BLOCK；永不自动 retry |

### 4.2 非阻滞/已安全的基线事实

- Governor physical call = 0；本轮不增加任何 Governor call。
- post-writing auxiliary physical call = 0；C8 Resume/C9 observability 已有持久化基础。
- C9 stable projection `dbIntegrity=ok`，`api_key/authorization/bearer=0`，projection 不含 raw prompt/body。
- Android 覆盖安装采用 `adb install -r`，既有用户数据未清理。

## 5. IV-0 判定

**GO。** 根因分布可解释，历史证据未篡改，生产逻辑未改动。下一阶段是 IV-1 Gate Inventory & Simplification：先把全部主链 Gate 标注为 `KEEP HARD BLOCK / DOWNGRADE TO ADVISORY / MERGE / REMOVE`，再以 Red 测试锁定安全边界。
