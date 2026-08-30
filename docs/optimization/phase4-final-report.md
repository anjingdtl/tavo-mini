# TAVO-MINI Phase IV Final Report

日期：2026-08-30（Asia/Shanghai）；IV-10 DeepSeek 根因隔离轮结算更新：2026-08-31
施工仓：`F:\\ClaudeWorkSpace\\projects\\TAVO-MINI`
唯一主方案：`docs/optimization/TAVO-MINI_Phase4_流水线再治理与写作通过率恢复计划_20260830.md`

## 最终判定

**PHASE IV FINAL SEAL HOLD / NO-GO**（IV-10 后维持；两个历史 blocker 已关闭，余下缺口已收敛为单一 model 侧病态计划，详见下文 IV-10 结算）

- ~~唯一未满足的最终 Required Gate 是当前版本真实 Android 5/10 章 paid E2E：设备真实 provider 返回 HTTP 401~~（2026-08-30 凭据恢复后解除）
- ~~新 blocker 是提供端对边界首章 Draft 的持续停摆（外部依赖）~~（2026-08-31 IV-10 证伪并关闭：根因为特定章节计划梗概触发的模型失控超长生成，provider 无关，应用侧 fail-closed 正确）
- **现行余下缺口**：10 章批次 9/10 adopted（First-Pass 8/10），唯一失败章为 model 侧病态计划（3 次尝试全部失控：1×570s@200k、2×length@65,536），P0-05 正确拒绝持久化；5 章 Required Gate 已 PASS（5/5，First-Pass 5/5）；Historical A/B 按比较器规则 NO-GO（86.7% < 历史确定性 100%）。

## 保护边界与范围

- 开工前先执行 `git fetch origin`；当时 `HEAD`、`origin/main` 均为 `64b88580c134f67e3fb73d1951ef6bc972da5552`。
- 工作区原有未提交/未跟踪用户文件未清理、未覆盖；旧 C10 冻结，不继续旧 Phase III-C Final Seal。
- C8 Resume、C9 Observability、历史失败、`finishReason=length`、`outcome_unknown`、provider/network/parse 失败证据均保留。
- Android 只使用同签名 release 的 `adb install -r`；没有执行 `adb uninstall` 或 `pm clear`。

## 阶段 PDCA 结算

| 阶段 | PLAN → RED → DO | CHECK-A | CHECK-B | ACT / 判定 |
| --- | --- | --- | --- | --- |
| IV-0 Baseline / Blocking Pareto | 完成只读基线与 Pareto | full verify 通过 | release/UI 可用；provider 401 | `GO` 进入 Gate 减法；新 paid sample HOLD |
| IV-1 Gate 减法 | 18 项 inventory，8 Hard / 3 Advisory / 3 Merge / 4 Remove | targeted regression/typecheck/lint/elastic/version 通过 | install-r/UI 通过；401 | `GO` 进入 JSON 瘦身 |
| IV-2 JSON 协议瘦身 | QA/Revision 最小协议 Red-first | regression 通过 | release/UI 通过；401 | `GO` |
| IV-3 Governor 旁路化 | current-request veto Red-first | Governor/Writer/Receipt regression 通过 | release/UI 通过；401 | `GO`，physical call=0 |
| IV-4 Context 阻滞治理 | Mandatory + Elastic Optional Red-first | Context regression 通过 | release/UI 通过；401 | `GO` |
| IV-5 Persistence Boundary | Final Candidate/DB/sidecar Red-first | full verify 通过 | install-r/UI/数据保护通过；401 | `GO`，真实 paid 继续 HOLD |
| IV-6 历史 A/B | comparator Red-first | 8 suites / 36 tests targeted 通过；typecheck/lint/elastic/version 通过 | install-r/UI/401 | `NO-GO/HOLD`，拒绝伪造 current First-Pass |
| IV-7 真实 5/10 章连续运行 | continuous harness Red-first | final full verify 531 suites passed / 3 skipped；3751 tests passed / 8 skipped | install-r、数据保护、UI/XML/PNG/logcat；401 | `NO-GO/HOLD`，真实 5/10 分母缺失 |
| IV-8 Final Seal | closure matrix + final report | full verify evidence inherited from IV-7 | no new valid paid sample; same 401 blocker | `PHASE IV FINAL SEAL HOLD / NO-GO` |

## 治理结果

### 主链

Compact 写作链已收敛为：

```text
Freeze → Draft → ONE QA → (optional Revision) → local Persistence Boundary
```

没有新增 Agent、Writer、Context、Memory、Prompt Compiler 或 LLM stage。FinalValidate 只承担本地 Persistence Boundary；正文、状态 sidecar、Canon/State mutation 的信任边界不再分散到多个质量 Gate。

### Gate / JSON / Context / Governor

- Gate inventory 从 18 项候选/交叉门禁收敛为 8 Hard、3 Advisory、3 Merge、4 Remove。
- QA clean 从代表性旧 envelope 96 字符降为 `{"decision":"clean"}` 20 字符；该结果只证明协议瘦身，不冒充 token 计费下降。
- QA/Revision 的 hash、fingerprint、diff、changeset 尽量本地计算；Revision 正文优先，非关键 sidecar 可丢弃。
- Context 使用 Mandatory + Elastic Optional；先做 Optional 压缩、去重和低相关资料裁剪，禁止优先阻断整章；按 stage 不复制 Draft Optional。
- Governor 观察当前请求并调优下一轮；current-request learned veto 已旁路，Governor physical call=0。

### Persistence / 安全

- Final Candidate 是唯一持久化候选；空结果、截断正文、DB transaction、Resume/Idempotency、Canon/State safety 均 fail-closed。
- `finishReason=length` 不作为 Final；`outcome_unknown` 不自动 retry；所有历史 paid ledger/Receipt 继续可审计。
- IV-7 release 安装后 `firstInstallTime=2026-08-08 07:48:12` 保持不变，作品库仍显示 `SM43U2Proj / 2 章 / 13 字`，证明 `adb install -r` 未清理数据。

## 指标结算

| 指标 | C9 baseline / 历史 | Phase IV 当前 | 结论 |
| --- | --- | --- | --- |
| E2E First-Pass Adoptable | C9 无该字段；历史 deterministic 8/8、restricted real 2/2 | 无合法 current paid 分母 | HOLD，不可计算提升 |
| provider latency | p50/p95 `187740/337781 ms` | 无同口径 sample | HOLD |
| total latency | p50/p95 `187764/337786.8 ms` | 无同口径 sample | HOLD |
| input tokens | p50/p95 `38125/42615` | 代码已减压，未形成 paid sample | 不宣称降幅 |
| output/reasoning tokens | p50/p95 `11435/17017.4` / `9587/15633.8` | 无同口径 sample | HOLD |
| `finishReason=length` | `5/38 = 13.16%` | 规则保留，当前无分母 | HOLD |
| `outcome_unknown` | `1/38 = 2.63%` | 规则保留，401 不作 unknown paid run | HOLD |
| exact-set invalid-format | `0/38` | 最小合同确定性通过 | 无 E2E 降幅可报 |
| Context block | C9 无可用分母 | Mandatory/Elastic contract 通过 | 无真实 rate 可报 |
| Governor physical calls | `0` | `0`（代码/确定性） | 安全目标保持 |

## Evidence Index

- 主进度与 PDCA：`docs/optimization/phase4-progress.md`
- IV-0 baseline/Pareto：`docs/optimization/phase4-baseline-and-blocking-pareto.md`
- Gate inventory：`docs/optimization/phase4-gate-inventory.md`
- Historical A/B：`docs/optimization/phase4-historical-ab.md`
- Continuous harness：`docs/optimization/phase4-continuous-harness.md`
- IV-7 final full verify / Android / UI / logcat：`test-logs/phase4-iv7-20260830-155254/iv7-check-b.md`
- IV-0～IV-6 Android evidence：`test-logs/phase4-iv0-baseline-20260830-144426/`、`test-logs/phase4-iv1-4-20260830-152100/`、`test-logs/phase4-iv5-20260830-153500/`、`test-logs/phase4-iv6-20260830-154500/`
- C9 aggregate/Receipt/projection：`test-logs/phase3-c9-cost-latency-20260830-000001/`
- C8/C9/旧 C10 状态：`docs/optimization/phase3-c-progress.md` 与历史 Phase III-C evidence 原样保留

## 最小解封动作

凭据恢复后，不再改架构：

1. 在设备 UI 更新合法 credential，执行 `保存并测试`。
2. 同一签名 release、同一设备，仅 `adb install -r`，连续跑 5 章与 10 章。
3. 保存每章 Receipt/DB/UI/logcat，运行 `phase4ContinuousHarness` 与 `phase4HistoricalAb`。
4. 只有 First-Pass、A/B、Context/length/unknown、DB/Receipt、Resume、无 hidden retry、Governor=0 全部满足时，才允许把最终状态改成 GO。

当前最终状态：`PHASE IV FINAL SEAL HOLD / NO-GO`

## 2026-08-30 凭据恢复后真实运行补充（Pre-Seal Correction 轮）

- 开工基线 `HEAD == origin/main == 945cd292`；`git fetch` 后无新远端提交；用户未跟踪文件全部保留。
- UI `保存并测试` 通过（GLM-5.3-Flash），401 blocker 解除。同代码 debug 签名 `adb install -r`（release 签名与在装包不兼容且禁止 uninstall），firstInstallTime 不变、数据零丢失。
- **Pre-Seal Correction（Red-first，`__tests__/phase4PreSealCorrection.test.ts`，9 tests）**：
  1. QA `finishReason=length`/合同无效保持 Advisory；Revision skip 记显式 `policy.phase4.qa_incomplete_not_clean`——Mandatory/Canon/State Safety 未决时禁止静默当 Clean。真实运行复现并修复了 `writerCore` primary 调用路径上无条件 `assertWriterFinishReason` 的缺口（`isPhase4QaLengthAdvisory`），生产链路验证：QA 截断→skipped（非 Clean）→Revision 零额外调用→章节正常 adopted。
  2. Context：Mandatory 全留；`explicit`/`preferred` 高价值 Optional 不再仅因 kind 被裁；低相关 automatic Optional 先裁。无第二 Context Builder。
  3. Governor 旁路保持：`phase4GovernorBypass.test.ts` 原样通过，Governor physical call=0。
- 验证链：targeted → typecheck → `lint --quiet`（0 errors）→ `verify:elastic` → full verify（532 suites passed / 3 skipped；3760 tests passed / 8 skipped）→ APK → `adb install -r`。
- **5 章连续（真实）**：4/5 adopted（3 clean first-pass；First-Pass Adoptable 3/5）；第 5 章 Draft 提供端连续 5 次 570s 停摆。physical calls 2–3/章；无 crash/ANR；Receipt/DB/UI/logcat 齐全（`test-logs/phase4-preseal-20260830-1650/`）。
- **10 章连续（真实）**：第 1 章 Draft 连续 4 次 570s 停摆（含冷重启 C8 Resume），0/10；停止重试避免无效 paid 调用。
- **最终判定维持 `PHASE IV FINAL SEAL HOLD / NO-GO`**：401 已解除，新 blocker 是提供端对边界首章 Draft 的持续停摆（外部依赖）。全部 Required Gate 真实 PASS 之前，不得写 `PHASE IV FINAL SEALED / GO`。
  （IV-10 更新：上一行所记"提供端停摆"归因已被修正并关闭，见下节。）

## IV-10 DeepSeek Provider/App 根因隔离结算（2026-08-30/31）

基线 `HEAD == origin/main == 8cec6a5f`；工作区无已跟踪改动；生产代码零改动；零新增 Gate/LLM stage/retry/Agent。

### 根因（证据支持）

**"Boundary-first Draft 570s 停摆" = 特定章节计划梗概触发的模型失控超长生成**，经非流式（`stream:false`）+ 570s total watchdog 观测为"无输出停摆"。

- 触发具有计划特异性：「账册的末行」3/3 确定性失控；「高潮听证」1/2 随机；同日其余 13 个计划 0 失控。GLM 侧对应「重走档案路线」「启封栏里的名字」（thinking-high 推理失控越界 570s；2026-08-30 10:58–13:26 存在 provider 退化窗口放大失效面，期间小请求仍成功）。
- wire max_tokens 只改变观测形态：200k cap → >9.5min 盲停（outcome_unknown）；65,536 cap → ~5.8min 可见 `finishReason=length`（token 级实锤：65,536/65,536 满额输出，189 tok/s，reasoningTokens=null）。
- 已证伪假设：GLM provider 特异（DeepSeek 复现）、"7k 小上下文边界首章"（真实 53–70k，估算器伪像）、体积阈值（同位置 69,485 成功 vs 69,650 失控；74,306/74,240 更大成功）、transport/watchdog 缺陷（234,748 字节 draft body 完整上传 2.3s；watchdog 分类正确）、Resume/Governor（旁路完好，physical call=0）。

### 真实 DeepSeek 结算

| Gate | 结果 |
| --- | --- |
| 5 章连续 | **PASS：5/5 adopted，First-Pass 5/5**（11 调用，in 727,531 / out 15,414）|
| 10 章连续 | 9/10 adopted，First-Pass 8/10（28 调用，in 1,195,182 / out 156,334）；唯一失败章 fail-closed 正确 |
| 合计 | 15 章尝试：14 adopted（93%）、First-Pass 13/15（87%）；draft 延迟 20–90s（GLM 同类 412–665s）|
| GLM 连停 4 次的原请求（chapter 118）| DeepSeek 22.8s 一次通过 |
| Historical A/B | **NO-GO**：86.7% < 历史确定性 100%；次级 outcome_unknown 2/34 vs 1/38 回退 |

### P0 与安全边界（本轮全部保持）

P0-05 length 拒绝持久化 ×2 ✓；P0-06 outcome_unknown 零自动 retry（3 次重试均 UI 用户确认）✓；P0-07/08 Governor 旁路、physical call=0 ✓；P0-10 全部真实调用入账 ✓；P0-11 未 uninstall/pm clear（本轮零 APK 重装，代码零改动）✓；P0-12 批次跨 provider/跨重启 resume 正常 ✓；crash/ANR=0 ✓。

### 配置变更（唯一持久状态）

`llm_config id=2 max_output_tokens`: 0(AUTO→200k) → **65,536**（用户可配置能力字段，非业务固定值；把失控生成的失败形态从 9.5min 盲停变为 ~6min 可分类 length 失败）。其余配置与用户 `DS测试用例.txt` 一致。

### 解封剩余动作

按 `phase4-requirement-closure.md`「真实解封条件（IV-10 后）」：连续 10 章新批次形成 10/10 分母（遇病态计划按用户确认重试/重计划），A/B 收敛后即可重评 `PHASE IV FINAL SEALED / GO`。
