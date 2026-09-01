# TAVO-MINI Phase IV Progress

施工仓：`E:\\AiWorkSpace\\tavo-mini`
当前主方案：`docs/optimization/TAVO-MINI_Phase4_IV13U_一致性与唯一性收口修复方案_20260901.md`
开工日期：2026-08-30（Asia/Shanghai）
IV-12A 开工时 HEAD / origin/main：`24b65486337cf0c45a2a5aa9d82661d0f1644f23`

## 保护边界

- 已执行 `git fetch origin --prune`；IV-12A 开工时 `HEAD == origin/main`。工作区中既有用户未跟踪文档与 QA 产物均未删除、未覆盖；本轮只处理明确的 Phase IV 代码、测试、报告和 progress 文件。
- 用户未提交文件、旧 Phase III-C C10、C8 Resume、C9 Observability 以及全部历史失败证据均保留；不执行 `git reset`、`git clean`、`adb uninstall` 或 `pm clear`。
- 旧 C10 冻结为历史 checkpoint，不继续旧 Phase III-C Final Seal，也不删除或改写旧证据。
- Android 只允许 `adb install -r`；Thinking Always On；`outcome_unknown` 永不自动 retry；不引入 Agent、第二 Writer、第二 Context、第二 Memory 或 Governor LLM call。

## Historical Evidence — IV-0～IV-8 PDCA 状态（封存）

| 阶段 | PLAN | RED | DO | CHECK-A | CHECK-B | ACT / 决策 |
| --- | --- | --- | --- | --- | --- | --- |
| IV-0 Baseline / Blocking Pareto | DONE | DONE（证据聚合工具/生产行为基线） | DONE（只读报告） | DONE（`npm.cmd run verify`） | NO-GO（真实 provider HTTP 401；外部 credential blocker，详见 IV-0 evidence） | `GO`：Pareto/历史真实基线足够进入 IV-1；Android 新付费样本保持 HOLD，不伪造通过 |
| IV-1 Gate 减法 | DONE | DONE（`phase4GateSimplification.test.ts` 先证明旧 Gate 无显式分类） | DONE（18 项 inventory；8 Hard / 3 Advisory / 3 Merge / 4 Remove） | DONE（11 suites / 77 tests、typecheck、lint、elastic、version） | HOLD（signed release `adb install -r`、启动和配置页通过；真实 provider HTTP 401） | `GO（代码实现 PASS；真实 paid Android 验收在 401 期间只能记 HOLD，不是完整 Production GO）`：确定性 Gate policy 已接入，credential 恢复后补真实付费样本 |
| IV-2 JSON 协议瘦身 | DONE | DONE（最小 QA/Revision contract Red-first） | DONE（Phase IV marker 下 decision/content-first；hash/diff 本地） | DONE（同 IV-1 回归 + typecheck/lint） | HOLD（release UI 正常；provider 401，未伪造 LLM 通过） | `GO（代码实现 PASS；真实 paid Android 验收在 401 期间只能记 HOLD，不是完整 Production GO）`：历史契约兼容保留，Compact 新路径切换最小协议 |
| IV-3 Governor 旁路化 | DONE | DONE（`phase4GovernorBypass.test.ts` 先证明 learned recommendation 不得挡当前请求） | DONE（current-request Governor decision bypass；physical call=0） | DONE（Governor/Writer/receipt regression + typecheck/lint） | HOLD（release 启动正常；真实 provider 401） | `GO（代码实现 PASS；真实 paid Android 验收在 401 期间只能记 HOLD，不是完整 Production GO）`：只在数学 hard capability 不可满足时阻断；下一阶段收拢 Persistence |
| IV-4 Context 阻滞治理 | DONE | DONE（`phase4ContextThroughput.test.ts` 先证明旧 projection/normalization 不满足） | DONE（Mandatory + Elastic projection、exact dedupe、composition Receipt） | DONE（11 suites / 77 tests、typecheck、lint、elastic、version） | HOLD（release UI/配置可用；真实 provider 401） | `GO（代码实现 PASS；真实 paid Android 验收在 401 期间只能记 HOLD，不是完整 Production GO）`：Mandatory 不丢，低相关 Optional 先去重/投影；进入 IV-5 |
| IV-5 Persistence Boundary 收拢 | DONE | DONE（`phase4PersistenceBoundary.test.ts` 先证明旧候选回退/sidecar 信任边界不满足） | DONE（FinalValidate 唯一候选；空结果 fail-closed；sidecar 本地净化） | DONE（全量 `npm.cmd run verify`：529 suites passed / 3 skipped；3742 tests passed / 8 skipped） | HOLD（signed release `adb install -r`、UI/安装数据保护通过；真实 provider HTTP 401） | `GO（代码实现 PASS；真实 paid Android 验收在 401 期间只能记 HOLD，不是完整 Production GO）`：Persistence Boundary 已收拢；真实 paid E2E 继续 HOLD，进入历史 A/B |
| IV-6 历史 A/B | DONE | DONE（`phase4HistoricalAb.test.ts` Red-first） | DONE（fail-closed 历史比较器与 HOLD 语义） | DONE（8 suites / 36 tests；typecheck、lint、elastic、version） | HOLD（signed release `adb install -r`、UI/数据保护通过；真实 provider HTTP 401，无 current paid sample） | `NO-GO/HOLD`：比较器拒绝伪造 First-Pass；继续 IV-7 harness，凭据恢复后补 5/10 章真实样本 |
| IV-7 真实 5/10 章连续运行 | DONE | DONE（`phase4ContinuousHarness.test.ts` Red-first） | DONE（纯汇总器；无新增生产 Gate/LLM stage） | DONE（full verify：531 suites passed / 3 skipped；3751 tests passed / 8 skipped；typecheck、lint、elastic、version） | HOLD（signed release `adb install -r`、UI/数据保护通过；真实 provider HTTP 401，未形成 5/10 paid 分母） | `NO-GO/HOLD`：安全证据通过但真实 5/10 样本缺失；进入 IV-8 闭环，不发布虚假 GO |
| IV-8 Final Seal | DONE | DONE（Required Gate 审计先识别 current paid sample 缺失） | DONE（closure matrix + final report；不新增生产 Gate/LLM stage） | DONE（继承 IV-7 full verify：531 suites passed / 3 skipped；3751 tests passed / 8 skipped） | HOLD（继承 IV-7 signed release/UI/logcat；provider HTTP 401，5/10 real paid sample 缺失） | `PHASE IV FINAL SEAL HOLD / NO-GO`：不发布虚假 `PHASE IV FINAL SEALED / GO` |

## 当前状态指针（IV-13U）

当前唯一有效阶段结论为 [`phase4-iv13u-progress.md`](phase4-iv13u-progress.md)：

```text
U1-U6 consistency/uniqueness PASS
R1/R2 PASS
A3 3/3 PASS
Continuation B3 3/3 (batch_mti4bayt_zhh5gp, writing_mode=continuation)
PHASE IV FINAL SEALED / GO
```

上表 IV-0～IV-12 的旧结算均为 Historical Evidence，不是当前态；当前分母不吸收旧 20 章长测或旧 IV-12 GO。

## Historical Evidence — IV-0 证据索引（封存）

- Phase IV 主方案：`docs/optimization/TAVO-MINI_Phase4_流水线再治理与写作通过率恢复计划_20260830.md`
- Phase III-C C9 聚合：`test-logs/phase3-c9-cost-latency-20260830-000001/c9-aggregate.json`
- Phase III-C C9 安全投影：`test-logs/phase3-c9-cost-latency-20260830-000001/c9-final-projection.json`
- Phase III-C C9 Receipt 摘要：`test-logs/phase3-c9-cost-latency-20260830-000001/c9-receipt-summary.txt`
- Phase III-C C9 Android/UI/logcat：`test-logs/phase3-c9-cost-latency-20260830-000001/c9-android-gate-summary.txt`、`c9-ai-result.xml`、`c9-result-details.xml`、`c9-logcat.txt`
- Phase III-C C10 冻结记录：`docs/optimization/phase3-c-progress.md`（C10 PLAN / user-directed stop / Android pending）
- Phase IV IV-0 fresh install/real probe：`test-logs/phase4-iv0-baseline-20260830-144426/iv0-check-b.md`（release `adb install -r`、证书复用、UI capability、真实 401）


## Historical Evidence — IV-9 Pre-Seal Correction（2026-08-30，凭据恢复后）

开工基线：`HEAD == origin/main == 945cd2922aaf0d6ed4896ac76e6a7738df149870`；工作区仅有未跟踪用户文件，全部保留。本轮只做最小修正，不新增 Agent / 第二 Writer / 第二 Context / 第二 Memory / 大型 QA Gate / 额外 LLM call / 固定业务 maxTokens / unknown 自动 retry。

- **Red Test**：`__tests__/phase4PreSealCorrection.test.ts`（先红后绿，8 tests）。
- **QA `finishReason=length` 最小修正**：截断/合同无效的 ONE-QA 保持 Advisory（不硬阻断、不追加调用）；但 Revision skip 在 `qa_truncated_advisory` / `qa_contract_advisory` 存在时改记显式规则 `policy.phase4.qa_incomplete_not_clean`——Mandatory / Canon / State Safety 检查未决时禁止静默当 Clean。实现：`src/services/writing/stages/evaluateRuntimeStageSkip.ts`。
- **Context 最小修正**：`projectPhase4ElasticContext` 的保留判定从"仅按 kind"改为按价值：Mandatory 全留；`activation==='explicit'` 或 `requirement==='preferred'` 的高价值 Optional 不再因 kind 被粗暴丢弃；低相关 automatic Optional 先裁。仍是同一冻结上下文的确定性子集，无第二 Context Builder。实现：`src/services/writing/context/stageContextProjection.ts`。
- **Governor 旁路复核**：`__tests__/phase4GovernorBypass.test.ts` 原样通过；无 Governor physical call。
- **验证链**：targeted（7 suites / 35 tests）→ typecheck → `lint --quiet` → `verify:elastic` → full verify（532 suites passed / 3 skipped；3759 tests passed / 8 skipped；VERIFY_EXIT_CODE=0）→ signed APK → `adb install -r`（数据保留，firstInstallTime 不变）。

## Historical Evidence — IV-10 DeepSeek Provider/App 根因隔离（2026-08-30/31）

用户将软件 LLM 配置切换为 DeepSeek（`deepseek-v4-flash` @ `api.deepseek.com`，UI 保存并测试通过；密钥在 keychain，不入文档）。本轮任务不是扩展架构，而是对"GLM 时代 Boundary-first Draft 570s 停摆"做 Provider/App 根因隔离：PLAN → RED/复现 → 证据 → 假设淘汰 → 最小实验 → CHECK-A/B → ACT。**生产代码零改动**（无新 Gate/LLM call/Agent/Writer/Context/Memory；不新增 blocking）。

### PDCA

| 轮 | 变量 | 结果 |
| --- | --- | --- |
| R1 | provider GLM→DeepSeek，恢复 batch10（同冻结上下文，chapter 118 = GLM 连停 4 次的同一请求） | **22.8s 通过**；随后连过 7 章（51.5k→59.5k tokens 全部 20–70s）；item 8（63,581）一次 570s timeout，用户确认重试 43s 通过 |
| R2 | 传输隔离（零付费）：主机→DeepSeek 305KB body；app→10.0.2.2 监听器（slirp 路径）真实 draft body | 主机 401 in 0.36s；**234,748/234,748 字节完整上传 2.3s** + 即时 400 → 传输层/watchdog 链路健康 |
| R3 | item 10（69,650 tokens，批次最大） | 570s timeout ×1 → wire max_tokens 200k→65,536（仅改 config `max_output_tokens`）→ **length 截断 ×2（65,536/65,536 满额，189 tok/s，5.8min）**，P0-05 全部拒绝持久化 |
| R4 | 同位置重计划（5 章批次，第 115 章「卷中遗页」= 失败 item 10「账册的末行」同位置，输入仅差 165 tokens） | **正常通过（输出 1,323）**；后续章上下文更大（72,034/74,306/74,240）全部正常，5/5 adopted、First-Pass 5/5 |

### 根因树（假设淘汰）

| 假设 | 判定 | 证据 |
| --- | --- | --- |
| H1 GLM provider/model/endpoint 特异 | **证伪** | DeepSeek 复现同类停摆（item 8/10） |
| H2 "边界首章 7k 小请求"形态 | **证伪** | 停摆请求真实输入 ≈53–70k（`estimateMessagesTokens` 中文估算失真 + `stage_results.input_tokens` 为派生值，二者误导了 IV-9 叙事；governor `actualPromptTokens` 与 provider 实报为准） |
| H3 请求体积阈值 | **证伪** | 同位置 69,485 成功 vs 69,650 失控（差 165 tokens）；74,306/74,240 更大请求成功 |
| H4 transport / watchdog 缺陷 | **证伪** | R2 传输全通；watchdog 按设计触发、分类 `outcome_unknown` 正确、零自动 retry |
| H5 reasoning/output wire 参数 | 部分成立（观测形态） | max_tokens 上限只改变失控的可观测形态（盲停 vs length 截断），不是触发因子 |
| H6 Resume/ledger/Governor | **证伪** | 批次跨 provider、跨进程重启恢复正常；Governor `preflightBlocked=false`、physical call=0；账务完整 |
| **H7 最终根因** | **成立** | **特定章节计划梗概触发模型失控超长生成**：「账册的末行」3/3 确定性失控（1×盲停 + 2×length）；「高潮听证」1/2 随机；其余 13 个计划 0/N。GLM 侧同理（「重走档案路线」「启封栏里的名字」在 thinking-high 下推理失控越界 570s，且 2026-08-30 10:58–13:26 存在 provider 退化窗口放大失效面，期间小请求 planner 仍成功） |

### 结算（真实 DeepSeek）

- **10 章批次** `batch_mtfrwv40_bhx4r5`：9/10 adopted，First-Pass 8/10；总调用 28，in 1,195,182 / out 156,334。唯一失败章被 P0-05 正确 fail-closed。
- **5 章批次** `batch_mtbs11zh_oih677`：**5/5 adopted，First-Pass 5/5**；总调用 11，in 727,531 / out 15,414。
- 合计 15 章尝试：14 adopted（93%）、First-Pass 13/15（87%）；draft 延迟 20–90s（GLM 同类 412–665s）。
- crash/ANR=0；Governor physical call=0；`outcome_unknown` 零自动 retry；Resume/Idempotency 正常；DB/Receipt/UI/logcat 齐全（`test-logs/phase4-deepseek-rca-20260830/`）。

### 配置变更（唯一持久状态变化，非代码）

`llm_config id=2 max_output_tokens`: 0(AUTO→弹性 200k) → **65,536**。依据：失控生成下 200k wire cap 使失败表现为 9.5min 盲停 + outcome_unknown；65,536 使其在 ~6min 内变为可分类、可拒绝的 length 失败（P0-09 不受影响——这是用户可配置的模型能力字段，不是业务固定值；可在 UI 随时改回）。

### 已知契约事实（记录，非本轮引入）

DeepSeek V4 续写冻结 `thinking: disabled`（`freezeContinuationThinking`，commit `f525e933`，2026-08-17；理由：thinking-on 时 V4 JSON draft 返回 reasoning_only）。与 P0-01「Thinking Always On」字面冲突在此显式标注：P0-01 的验证语境是 GLM（thinking 正常参与生成）；DeepSeek 走的是更早的、有失败证据支撑的 V4 契约。

### ACT / 判定

- 原"GLM Boundary-first 停摆"根因**关闭**：已隔离（H7）、已表征、已缓解；该请求家族在 DeepSeek 上以 20–90s 正常完成（含 GLM 连停 4 次的原请求）。
- 5 章 Required Gate：**PASS**。10 章 Required Gate：**9/10（NO-GO 未满分母）**——缺口为单一 model 侧病态计划，fail-closed 正确，同位置重计划已被 5 章批次证明可正常写作。
- Historical A/B 按比较器规则 **NO-GO**（First-Pass 0.867 < 历史确定性 1.0；outcome_unknown 2/34 vs 1/38 次级回退）。
- **`PHASE IV FINAL SEAL HOLD / NO-GO` 维持**——不为封板降低标准；10 章完整分母仍差 1 章，且缺口性质已从"未知外部停摆"收敛为"已理解的模型侧生成病理"。
- 证据：`test-logs/phase4-deepseek-rca-20260830/README-evidence.md`。

## Historical Evidence — 当前阶段结论（2026-08-31 IV-10 快照，已封存）

IV-9 时代"外部提供端停摆是唯一剩余 blocker"的表述已被 IV-10 根因隔离轮**取代**：停摆根因不是"外部提供端对边界首章的持续停摆"，而是"特定章节计划梗概触发的模型失控超长生成"（对 GLM 与 DeepSeek 同样成立，详见 IV-10 根因树）；IV-9 证据段中"边界首章 fresh 首章（in≈7k 小上下文）"的量化描述是估算器伪像，真实请求为 53–70k tokens（证据：`test-logs/phase4-deepseek-rca-20260830/`）。IV-9 的原始运行记录、42 次付费台账与 NO-GO 判定作为历史证据原样保留。

## Historical Evidence — IV-10 收尾代码复查（2026-08-31，关机前）

逐项复核生成流水线全部阻滞/阻断点，确认根因闭环且均有处理：

| # | 阻滞/阻断点 | 根因 | 处理状态 |
| --- | --- | --- | --- |
| 1 | Draft 570s"停摆"（GLM/DeepSeek） | 计划梗概触发的模型失控超长生成（H7） | **关闭**：length 硬门拒绝持久化 ×2 验证；outcome_unknown+用户确认恢复；config `max_output_tokens=65536` 缓解（失控 ~6min 变为可分类失败） |
| 2 | 570s 看门狗语义 | 刻意的会计安全边界（贴近 provider 10min 窗口） | 保持，不放宽；分类 `outcome_unknown` 正确 |
| 3 | Hard Gate ×8（`phase4GatePolicy.ts` 逐条复读） | 全部为 P0 级安全/能力边界（冻结指纹/Mandatory Truth/能力边界/length/unknown/空正文/DB 事务/Canon） | 无未分类硬阻断；质量协议门零混入 |
| 4 | 隐藏 retry | — | 无：`shouldAutoRetryFailure` 仅 requestPolicy 内部定义；所有停摆重试均 UI 用户确认 |
| 5 | Governor | — | 旁路保持：全部 receipt `preflightBlocked=false`、scenario 记录 0 条 |
| 6 | Context 投影 | — | IV-9 价值保留生效；receipt `silentContextLossCount=0`、Mandatory 6 项全在 |
| 7 | QA 截断 | IV-9 修正 | Advisory 路径生产验证（10 批 item 1） |
| 8 | `stage_results.input_tokens` 失败行写入预留期 `compiledPromptTokens` 估算（如 7,103），非最终请求大小 | 观测语义问题（预算冻结时快照），曾误导 IV-9 RCA | **已文档化**（IV-10 修正附言）；权威值在 receipt `actualPromptTokens`/usage 行；不改 schema（关机前不引入无设备回归的变更） |
| 9 | 请求队列 | — | 全天 34+ 次付费调用 `queueWaitMs=0`，无排队饥饿 |
| 10 | 模拟器网络（DNS 代理死亡 + 大 body 上传健康性） | emulator 进程内 slirp DNS 代理坏死（`adb reboot` 无效） | 环境问题：重启模拟器进程修复；传输路径 234,748 字节完整上传 2.3s 验证 |
| 11 | DeepSeek thinking 契约 | 冻结 `disabled`（`f525e933`，reasoning_only 证据） | 文档化；与 P0-01 的语境差异已显式标注 |

结论：**无未处理的生成流水线阻滞点**。工作区无未提交改动；本地 `HEAD == origin/main == 2d69416e`。

## 历史阶段结论（IV-0～IV-9 期间，原样保留）

IV-0 不修改生产逻辑。基线与阻滞 Pareto 已封存到 `phase4-baseline-and-blocking-pareto.md`。本轮 CHECK-B 已完成同签名 release `adb install -r`、启动、UI capability 核验；真实 provider 连接返回 HTTP 401（credential 过期/无效），因此新 paid sample 保持 HOLD，历史 C9 真实样本继续作为基线。主要阻滞不是账务或 Governor physical call，而是主链把质量协议、上下文复制和当前请求决策耦合在一起：`length`、JSON/报告合同和 Context/Governor preflight 共同吞噬一次通过率。IV-1 从 Gate inventory 开始。

IV-6 已完成可复现的历史 A/B 比较器与审计表：历史稳定结果、C9 38 paid 分母和当前版本测量口径已对齐，但当前 Android paid sample 因 provider HTTP 401 缺失，比较结果依法保持 `HOLD`，不把单元测试、mock 或 C9 projection completion 当作 E2E First-Pass。该 HOLD 只约束真实验收，不阻断继续建设 IV-7 的连续运行 harness。

## IV-6 PLAN — Historical A/B Throughput Recovery

- 只把历史稳定版本的真实结果、C9 的真实 paid 分母/错误率和 Phase IV 当前版本的可审计测量放在同一比较表；缺失的 current real sample 记为 `HOLD`，不把 mock/contract test 伪装成 E2E First-Pass。
- 第一指标固定为 E2E First-Pass Adoptable Rate；latency、input/output/reasoning、JSON failure、Context block、length、unknown、physical calls 作为次级指标。
- 历史稳定版本采用 `TAVO-MINI_第二期_Final-Seal_最终封板报告_20260820.md` 的 Outline/Continuation 8/8 deterministic Android regression 与 2/2 restricted real LLM smoke；不把其历史结果算作本轮当前版本。
- Baseline 采用 C9 `c9-aggregate.json` 的 38 paid-request denominator；当前版本若没有新的真实 Android paid sample，只输出“不可判定/待凭据恢复”，并继续构造可复现的比较器与 IV-7 harness。

## Historical Evidence — IV-1 证据索引（封存）

- Inventory：`docs/optimization/phase4-gate-inventory.md`
- Machine-readable policy：`src/services/writing/gates/phase4GatePolicy.ts`
- Red-first test：`__tests__/phase4GateSimplification.test.ts`
- IV-1～IV-4 signed Android / UI / 401 / logcat：`test-logs/phase4-iv1-4-20260830-152100/`
- IV-2 compact contract test：`__tests__/phase4GateSimplification.test.ts`
- IV-3 Governor bypass test：`__tests__/phase4GovernorBypass.test.ts`
- IV-4 Context throughput test：`__tests__/phase4ContextThroughput.test.ts`

## Historical Evidence — IV-5 证据索引（封存）

- Persistence Boundary Red/DB/Receipt regression：`__tests__/phase4PersistenceBoundary.test.ts`
- Final candidate regression：`__tests__/writingFinalCandidateContract.test.ts`、`__tests__/outlineDurableAdapterFinalCandidate.test.ts`
- Signed Android / UI / 401 / logcat / install-r：`test-logs/phase4-iv5-20260830-153500/iv5-check-b.md`

## Historical Evidence — IV-6 证据索引（封存）

- Historical A/B Red/Green：`__tests__/phase4HistoricalAb.test.ts`、`src/services/writing/metrics/phase4HistoricalAb.ts`
- Historical comparison and fail-closed conclusion：`docs/optimization/phase4-historical-ab.md`
- Signed Android / UI / 401 / logcat / install-r：`test-logs/phase4-iv6-20260830-154500/iv6-check-b.md`

## Historical Evidence — IV-7 PLAN — Continuous 5/10 Chapter Harness（封存）

- 以单一冻结上下文顺序跑 5 章与 10 章 compact 写作任务，逐章记录 First-Pass Adoptable、物理调用、Governor physical call、Context composition、Resume/Idempotency、DB integrity、crash/ANR；不虚构真实 provider 结果。
- harness 只做可审计汇总，不新增 Writer、Agent、Context、Memory 或生产 Gate；任何 chapter count 不符、重复收费/调用、Governor physical call、DB 损坏或 crash/ANR 都是 NO-GO。
- CHECK-B 必须使用同签名 release `adb install -r`，检查真实 Android UI、Receipt/DB 可见证据和 logcat；当前凭据若仍为 HTTP 401，则记录 `HOLD`，继续 IV-8 做闭环文档但不发布 Final Seal GO。

## Historical Evidence — IV-8 PLAN — Final Seal Closure（封存）

- 逐条核对 Phase IV 主方案的 P0、阶段产物、PDCA、Android 安装约束、Receipt/DB/UI/logcat 证据和历史证据保留边界；把“已证明”“仅本地/确定性证明”“真实样本缺失”分开。
- Final Seal 的第一验收指标仍是 E2E First-Pass Adoptable Rate；没有当前真实 Android 5/10 章分母时，结论必须是 `HOLD`，不得用 C9 projection completion、mock、contract test 或旧版本结果替代。
- 复核主链没有新增工程 Gate、额外 LLM stage、Governor physical call 或固定业务 maxTokens；`outcome_unknown` 不自动 retry，`finishReason=length` 不持久化。
- 完成 `phase4-requirement-closure.md` 与 `phase4-final-report.md`，记录最终可执行解封条件。若真实证据仍为 401，则完成审计文档但维持 `PHASE IV FINAL SEAL HOLD / NO-GO`，不输出 `PHASE IV FINAL SEALED / GO`。

## Historical Evidence — IV-8 PDCA 结论（封存）

- **RED**：Final Seal Required Gate 审计发现当前版本没有合法的真实 Android 5/10 章 paid 分母；C9 projection completion、历史 8/8、mock 和 contract test 均不能替代 First-Pass。
- **DO**：完成 `phase4-requirement-closure.md`、`phase4-final-report.md`，逐项记录 10 个最终问题和 13 个 P0 的证据等级；不引入新的生产 Gate、LLM stage 或 retry。
- **CHECK-A**：继承 IV-7 最终 full verify：`VERIFY_EXIT_CODE=0`，Jest 531 suites passed / 3 skipped，3751 tests passed / 8 skipped；lint 0 errors、typecheck、Elastic、version 通过。
- **CHECK-B**：继承同签名 release `adb install -r`、UI/数据保护/XML/PNG/logcat 证据；`保存并测试` 为真实 HTTP 401，release DB 受 `run-as: package not debuggable` 限制，不能宣称当前 DB paid sample 完成。
- **ACT / GO-NO-GO**：代码治理继续保持；最终封板保持 `PHASE IV FINAL SEAL HOLD / NO-GO`。凭据恢复后仅补真实 5/10 章和 Receipt/DB/First-Pass A/B，不改变已封存的主链减法方向。

## Historical Evidence — IV-8 证据索引（封存）

- Requirement closure：`docs/optimization/phase4-requirement-closure.md`
- Final report：`docs/optimization/phase4-final-report.md`
- Continuous harness / IV-7 full CHECK-A：`docs/optimization/phase4-continuous-harness.md`、`test-logs/phase4-iv7-20260830-155254/iv7-check-b.md`
- Historical A/B：`docs/optimization/phase4-historical-ab.md`
- Historical C9 and C8/C9 evidence：`test-logs/phase3-c9-cost-latency-20260830-000001/`

## Historical Evidence — IV-11 DeepSeek Thinking Always On 与质量-稳定性矩阵（2026-08-31）

当前施工仓：`E:\AiWorkSpace\tavo-mini`。本节为当前事实更新；前文 IV-10 旧结算段落作为历史记录保留，不把历史 `Root Cause Closed` 表述直接当作本轮封板结论。

### PDCA

| 环节 | 当前证据与结论 |
| --- | --- |
| PLAN | 恢复 DeepSeek Thinking Always On；修复普适章节完成边界；补采文学质量、思考档次和流水线稳定性的批次关联数据；不扩展架构。 |
| RED | stale DeepSeek disabled frozen contract；结构等价 pathological Bad Plan；Thinking ON 下 reasoning-only final-content 缺失。IV-10 原始“账册的末行”完整 fixture 当前不可得，已明确标记。 |
| DO | DeepSeek frozen/wire 强制 ON；reasoning/final channel 分离；共享 Draft completion boundary；JSON/prose 最终正文必须进入 `content`；新增只读 `collect-writing-quality-matrix.mjs`。 |
| CHECK-A | `npm run verify` 通过：533 suites passed / 4 skipped；3,766 tests passed / 9 skipped；lint/typecheck/elastic/version 全通过。 |
| CHECK-B | 同代码 V2.21.1 debug APK 使用 `adb install -r` 真实 Android 复测：Bad Plan 3/3，Good 5 章 5/5，修复后 Good 10 章 10/10；首次 Good 10 的 7/10 reasoning-only 失败保留。终态 crash buffer 无应用 crash。 |
| ACT | 数据采集完成；Final Seal 仍 `PHASE IV FINAL SEAL HOLD / NO-GO`。当前准确表述是结构等价 pathological fixture 的 remediation 已验证，exact historical fixture、跨思考档次 A/B 和文学质量标注仍待补齐。 |

### 质量-稳定性矩阵

`test-logs/phase4-iv11-android-20260831/writing-quality-stability-matrix-20260831.json` 记录 4 个批次、28 个章节观察。每个批次/章节通过 `correlationKey` 关联：

`thinking`、`reasoningEffort`、`qualityProfile`、`model`、`literaryQualityProxy`、`pipelineStability`

文学质量当前只记录确定性代理指标（句段形态、对白比例、重复信号、标点/结尾/转场等），不自动生成主观文学总分；人工/评测模型字段为 `not_collected`。本轮四个样本均为 `thinking=enabled / reasoningEffort=low`，因此不能宣称不同思考档次的因果差异。

### 真实批次

- `batch_mtgl6rps_0llu1q`：结构等价 Bad Plan，3/3 full_pipeline、first-pass 3/3。
- `batch_mtglhrce_uuwp6b`：Good 5，5/5 full_pipeline、first-pass 5/5。
- `batch_mtgm0bjg_ukyy4m`：首次 Good 10，7/10 full_pipeline，1 个 reasoning-only failure；作为失败分母保留。
- `batch_mtgmub04_rzoyix`：final-channel contract 修复后 Good 10，10/10 full_pipeline、first-pass 10/10。

### 下一实验

1. 找回 IV-10 原始“账册的末行” frozen fixture，Thinking ON 下复测至少 3/3。
2. 用相同有限计划做 `low / medium / high` reasoning effort 平衡 A/B，沿用同一质量-稳定性矩阵。
3. 完成人工或独立评测模型的文学质量标注后，再讨论文学质量优化，不用长度或对白比例冒充文学分数。

### IV-11 证据索引

- 测试报告：`docs/optimization/phase4-iv11-test-report-20260831.md`
- 质量/稳定性矩阵：`test-logs/phase4-iv11-android-20260831/writing-quality-stability-matrix-20260831.json`
- Thinking contract：`__tests__/continuationThinkingAlwaysOn.test.ts`
- Plan delta：`__tests__/phase4Iv11PlanDelta.test.ts`
- Android 终态快照：`test-logs/phase4-iv11-android-20260831/`

## Historical Evidence — IV-12A～E Writer Style / Literary Quality Final Seal（2026-08-31）

> 本节的 GO 是当时的历史快照，不代表当前 Phase IV 状态；当前状态由 IV-13U progress SSOT 维护。

本轮按新主方案从 IV-12A 开始自主完成 PDCA。文学评测严格停留在 Test/Evidence/Acceptance 层，真实项目 Writer Style 作为唯一 SSOT；没有新增生产 Judge LLM、文学 Gate、自动 retry/re-plan、第二 Writer、第二 Context 或固定业务 maxTokens。

### PDCA

| 环节 | 当前证据与结论 |
| --- | --- |
| PLAN | 建立 Style Requirement / Adherence 合同；同 Plan、同 Context 构建版本、同 Writer Style 下执行 Fast / Standard / Quality 同题 A/B；补做五项叙事维度与 Completion Boundary 专项。 |
| RED | 首轮发现批次冻结质量档位可能沿用 stale live profile，Standard/Quality 的冻结 profile 与请求 override 不一致，首轮不纳入有效分母。 |
| Root Cause | profile propagation 位于 `outlineStageRuntime` 的批次冻结推导，未统一使用当前请求的有效 quality/reasoning/execution override。 |
| DO | 以 `resolvePipelineGenerationQualityProfile()` 做最小修正；Style 合同、脱敏 collector 和独立标注全部置于 `scripts/qa`/测试层。 |
| CHECK-A | v2 重新执行 4 类计划 × 3 档质量 = 12 个样本；12/12 完成，三档均 4/4 first-pass，25/25 Style Requirement 逐样本完成。 |
| CHECK-B | Adherence=1.0、Hard Style Violation=0、Style Drift=0；五项叙事维度及五项 Completion Boundary 检查全部 PASS；APK、`adb install -r`、DB integrity、logcat、全量工程验证通过。 |
| ACT | Safety / Throughput / Writer Style / Narrative Quality / Engineering 全部 PASS，决策更新为 `PHASE IV FINAL SEALED / GO`。 |

### Writer Style 合同与同题矩阵

- 实际冻结 Writer Style 资产：`IV12A冷静限知`；Style Requirement Projection 共 25 条：Mandatory 4、Preferred 19、Avoid 2。
- 同一 Plan fingerprint：`5f04c3fc6f27eee1a781d4f4cf15eb6ed5e9f99ce42544fc887d9a3c2d1b5b23`。
- 同一 Writer Style / Projection fingerprint；每个样本独立冻结 Context，`contextIsolatedPerSample=true`，不发生跨样本污染。
- Fast：`low / one_shot`，4 样本、4 calls、4/4 first-pass。
- Standard：`high / standard`，4 样本、8 calls、4/4 first-pass，一次 Draft + 一次 QA。
- Quality：`max / standard`，4 样本、8 calls、4/4 first-pass，一次 Draft + 一次 QA。
- Physical Calls 口径为阶段级真实网络请求：Fast 为 1/chapter；Standard 为 2/chapter（Draft + QA）；Quality 为 2/chapter（Draft + QA）。因此三档总 calls 分别为 4、8、8，无 retry/fallback。

三档 Writer Style 结果并列稳定：12/12 Adherence=1.0，Hard Style Violation=0，Style Drift=0。Standard 在本分母的叙事平均分均为 4.00，观察到 QA 的实际收益；Quality 相比 Standard 没有额外通过率或 Style 收益，额外 reasoning 成本未在本小样本中证明额外文学回报。上述结论不把档位名称当作质量保证，也不把形态 telemetry 当作文学校验分。

### 叙事质量与 Completion Boundary

12 个样本的 Scene Completion、Beat Realization、Character Consistency、Causal Continuity、Ending Effectiveness 全部 PASS，最低分为 3。调查没有摘要化，情绪没有过快跳变，动作保留后果链，慢节奏没有变为清单，结尾没有统一模板化套话。Fast 动作因果样本按保守标注为 Beat=3，但关键 beat 与后果仍然存在，未形成失败。

句长、对白率、重复率、正文长度、段落形态和标点只作为 Literary Shape Telemetry；它们不参与文学质量 acceptance，也不能冒充 Writer Style 或 Narrative Quality 分数。

### Safety / Throughput / Engineering

- Thinking Always On；Mandatory Truth 不丢；Governor 继续旁路，physical call=0。
- 无 hidden retry、protocol fallback 或自动 re-plan；三档样本无 retry，finish reason 可接受。
- 三份矩阵 DB `integrity_check=ok`；设备原始快照测试后精确恢复，SHA-256 未变化。
- `emulator-5554` 上使用 `dist/apk/debug/ShineWriter-V2.21.1-debug.apk` 执行 `adb install -r`；三档批次均完成，logcat 无应用 FATAL/ANR/OOM/超时异常。
- `npm run verify`：534 suites passed / 4 skipped；3,773 tests passed / 9 skipped；targeted contract/profile tests 13/13；typecheck、`lint -- --quiet`、`verify:elastic`、`verify:version` 全部 PASS。
- 本轮没有生产 Prompt 改动，因此不触发 pathological equivalent 3/3、5 章、10 章重新验证条件；若后续修改生产 Prompt 或 Completion Boundary wording，必须重新执行该条件。

### IV-12 证据索引

- 最终测试报告：`docs/optimization/TAVO-MINI_Phase4_IV-12A_WriterStyle文学质量验收测试报告_20260831.md`
- Writer Style / Narrative / Boundary 脱敏证据：`test-logs/phase4-iv12a-20260831/writer-style-evidence-v2.json`
- Literary Shape Telemetry：`test-logs/phase4-iv12a-20260831/writing-quality-shape-telemetry-v2.json`
- 独立脱敏标注：`test-logs/phase4-iv12a-20260831/annotations-v2.json`
- Android / DB / UI / logcat：`test-logs/phase4-iv12a-20260831/`、`test-logs/phase4-iv12a-preflight-20260831/`
- 合同实现与测试：`scripts/qa/writerStyleAdherence.ts`、`__tests__/writerStyleAdherenceContract.test.ts`
- 最小生产修正：`src/services/pipeline/outlineStageRuntime.ts`；回归：`__tests__/writingGenerationQualityProfile.test.ts`

### Historical Evidence — IV-9 真实 Android 运行结算（凭据恢复后，2026-08-30）

- 设备/包：emulator-5554，debug 签名 `adb install -r`（release 签名与在装 debug 包不兼容，且禁止 uninstall，故本轮真实运行使用同代码的 debug 构建；firstInstallTime=2026-08-23 保持不变，数据零丢失）。模型：GLM-5.3-Flash（UI `保存并测试` 通过）。
- **5 章连续批次**（`batch_mtfkmlek_i6qms3`，目标 5 章/3000 字）：4/5 章 `full_pipeline` adopted；第 5 章 Draft 连续 5 次 `total_timeout`（本地 570s 看门狗，提供端对该 fresh-boundary 请求停摆，冷重启/in-place resume 均不收敛），用户确认式结束批次留证（status=cancelled，4 章成果保留）。
  - 首章（第100章显示）3 次尝试：timeout → QA `finishReason=length` 截断（修正前 APK 硬拒，真实复现了缺口）→ 修正版 APK 重装后 Draft success + QA 截断**按 Advisory skipped（非 Clean）**、Revision 零调用、FinalValidate 通过并 adopted——Pre-Seal Correction 在生产链路验证生效。
  - First-Pass Adoptable：3/5（第114/115/116 显示章一次通过；第100显示章第 3 次尝试 adopted，不计 first-pass）；physical calls 2–3/章；Governor physical call=0；无 crash/ANR（crash buffer 空）。
- **10 章连续批次**（`batch_mtfrwv40_bhx4r5`）：第 1 章 Draft 连续 4 次 570s timeout（含一次完整 App 冷重启后 resume），0/10，未继续烧 paid 调用，结束留证。
- **判定**：两个连续运行 Required Gate 均无法形成完整分母 → `PHASE IV FINAL SEAL HOLD / NO-GO` 维持；真实 4/5 章样本与生产级修正验证已入账（`test-logs/phase4-preseal-20260830-1650/`）。外部提供端停摆是唯一剩余 blocker；恢复后仅需补"边界首章 Draft"可通过的 provider 环境并重跑 5/10 章，不改架构。
- **测试报告**：`docs/optimization/phase4-preseal-test-report-20260830.md`（验证链、Red-first 明细、5/10 章逐章运行表、42 次付费调用台账、NO-GO 归因与解封条件）。
- C9 基线对比（真实样本）：input tokens per adopted chapter 83.5k–135.7k vs C9 p50 38.1k（本批含 3000 字目标与思考强度标准，口径不同，不作降幅宣称）；QA/Revision 合同、Resume、Receipt/DB 完整可审计。
