# TAVO-MINI Phase IV Progress

施工仓：`F:\\ClaudeWorkSpace\\projects\\TAVO-MINI`
唯一主方案：`docs/optimization/TAVO-MINI_Phase4_流水线再治理与写作通过率恢复计划_20260830.md`
开工日期：2026-08-30（Asia/Shanghai）
Exact HEAD / origin/main：`64b88580c134f67e3fb73d1951ef6bc972da5552`

## 保护边界

- 已执行 `git fetch origin`；开工时 `HEAD == origin/main`，工作区没有已跟踪文件改动。
- 用户未提交文件、旧 Phase III-C C10、C8 Resume、C9 Observability 以及全部历史失败证据均保留；不执行 `git reset`、`git clean`、`adb uninstall` 或 `pm clear`。
- 旧 C10 冻结为历史 checkpoint，不继续旧 Phase III-C Final Seal，也不删除或改写旧证据。
- Android 只允许 `adb install -r`；Thinking Always On；`outcome_unknown` 永不自动 retry；不引入 Agent、第二 Writer、第二 Context、第二 Memory 或 Governor LLM call。

## Phase IV PDCA 状态

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

## IV-0 证据索引

- Phase IV 主方案：`docs/optimization/TAVO-MINI_Phase4_流水线再治理与写作通过率恢复计划_20260830.md`
- Phase III-C C9 聚合：`test-logs/phase3-c9-cost-latency-20260830-000001/c9-aggregate.json`
- Phase III-C C9 安全投影：`test-logs/phase3-c9-cost-latency-20260830-000001/c9-final-projection.json`
- Phase III-C C9 Receipt 摘要：`test-logs/phase3-c9-cost-latency-20260830-000001/c9-receipt-summary.txt`
- Phase III-C C9 Android/UI/logcat：`test-logs/phase3-c9-cost-latency-20260830-000001/c9-android-gate-summary.txt`、`c9-ai-result.xml`、`c9-result-details.xml`、`c9-logcat.txt`
- Phase III-C C10 冻结记录：`docs/optimization/phase3-c-progress.md`（C10 PLAN / user-directed stop / Android pending）
- Phase IV IV-0 fresh install/real probe：`test-logs/phase4-iv0-baseline-20260830-144426/iv0-check-b.md`（release `adb install -r`、证书复用、UI capability、真实 401）


## IV-9 Pre-Seal Correction（2026-08-30，凭据恢复后）

开工基线：`HEAD == origin/main == 945cd2922aaf0d6ed4896ac76e6a7738df149870`；工作区仅有未跟踪用户文件，全部保留。本轮只做最小修正，不新增 Agent / 第二 Writer / 第二 Context / 第二 Memory / 大型 QA Gate / 额外 LLM call / 固定业务 maxTokens / unknown 自动 retry。

- **Red Test**：`__tests__/phase4PreSealCorrection.test.ts`（先红后绿，8 tests）。
- **QA `finishReason=length` 最小修正**：截断/合同无效的 ONE-QA 保持 Advisory（不硬阻断、不追加调用）；但 Revision skip 在 `qa_truncated_advisory` / `qa_contract_advisory` 存在时改记显式规则 `policy.phase4.qa_incomplete_not_clean`——Mandatory / Canon / State Safety 检查未决时禁止静默当 Clean。实现：`src/services/writing/stages/evaluateRuntimeStageSkip.ts`。
- **Context 最小修正**：`projectPhase4ElasticContext` 的保留判定从"仅按 kind"改为按价值：Mandatory 全留；`activation==='explicit'` 或 `requirement==='preferred'` 的高价值 Optional 不再因 kind 被粗暴丢弃；低相关 automatic Optional 先裁。仍是同一冻结上下文的确定性子集，无第二 Context Builder。实现：`src/services/writing/context/stageContextProjection.ts`。
- **Governor 旁路复核**：`__tests__/phase4GovernorBypass.test.ts` 原样通过；无 Governor physical call。
- **验证链**：targeted（7 suites / 35 tests）→ typecheck → `lint --quiet` → `verify:elastic` → full verify（532 suites passed / 3 skipped；3759 tests passed / 8 skipped；VERIFY_EXIT_CODE=0）→ signed APK → `adb install -r`（数据保留，firstInstallTime 不变）。

## 当前阶段结论

IV-0 不修改生产逻辑。基线与阻滞 Pareto 已封存到 `phase4-baseline-and-blocking-pareto.md`。本轮 CHECK-B 已完成同签名 release `adb install -r`、启动、UI capability 核验；真实 provider 连接返回 HTTP 401（credential 过期/无效），因此新 paid sample 保持 HOLD，历史 C9 真实样本继续作为基线。主要阻滞不是账务或 Governor physical call，而是主链把质量协议、上下文复制和当前请求决策耦合在一起：`length`、JSON/报告合同和 Context/Governor preflight 共同吞噬一次通过率。IV-1 从 Gate inventory 开始。

IV-6 已完成可复现的历史 A/B 比较器与审计表：历史稳定结果、C9 38 paid 分母和当前版本测量口径已对齐，但当前 Android paid sample 因 provider HTTP 401 缺失，比较结果依法保持 `HOLD`，不把单元测试、mock 或 C9 projection completion 当作 E2E First-Pass。该 HOLD 只约束真实验收，不阻断继续建设 IV-7 的连续运行 harness。

## IV-6 PLAN — Historical A/B Throughput Recovery

- 只把历史稳定版本的真实结果、C9 的真实 paid 分母/错误率和 Phase IV 当前版本的可审计测量放在同一比较表；缺失的 current real sample 记为 `HOLD`，不把 mock/contract test 伪装成 E2E First-Pass。
- 第一指标固定为 E2E First-Pass Adoptable Rate；latency、input/output/reasoning、JSON failure、Context block、length、unknown、physical calls 作为次级指标。
- 历史稳定版本采用 `TAVO-MINI_第二期_Final-Seal_最终封板报告_20260820.md` 的 Outline/Continuation 8/8 deterministic Android regression 与 2/2 restricted real LLM smoke；不把其历史结果算作本轮当前版本。
- Baseline 采用 C9 `c9-aggregate.json` 的 38 paid-request denominator；当前版本若没有新的真实 Android paid sample，只输出“不可判定/待凭据恢复”，并继续构造可复现的比较器与 IV-7 harness。

## IV-1 证据索引

- Inventory：`docs/optimization/phase4-gate-inventory.md`
- Machine-readable policy：`src/services/writing/gates/phase4GatePolicy.ts`
- Red-first test：`__tests__/phase4GateSimplification.test.ts`
- IV-1～IV-4 signed Android / UI / 401 / logcat：`test-logs/phase4-iv1-4-20260830-152100/`
- IV-2 compact contract test：`__tests__/phase4GateSimplification.test.ts`
- IV-3 Governor bypass test：`__tests__/phase4GovernorBypass.test.ts`
- IV-4 Context throughput test：`__tests__/phase4ContextThroughput.test.ts`

## IV-5 证据索引

- Persistence Boundary Red/DB/Receipt regression：`__tests__/phase4PersistenceBoundary.test.ts`
- Final candidate regression：`__tests__/writingFinalCandidateContract.test.ts`、`__tests__/outlineDurableAdapterFinalCandidate.test.ts`
- Signed Android / UI / 401 / logcat / install-r：`test-logs/phase4-iv5-20260830-153500/iv5-check-b.md`

## IV-6 证据索引

- Historical A/B Red/Green：`__tests__/phase4HistoricalAb.test.ts`、`src/services/writing/metrics/phase4HistoricalAb.ts`
- Historical comparison and fail-closed conclusion：`docs/optimization/phase4-historical-ab.md`
- Signed Android / UI / 401 / logcat / install-r：`test-logs/phase4-iv6-20260830-154500/iv6-check-b.md`

## IV-7 PLAN — Continuous 5/10 Chapter Harness

- 以单一冻结上下文顺序跑 5 章与 10 章 compact 写作任务，逐章记录 First-Pass Adoptable、物理调用、Governor physical call、Context composition、Resume/Idempotency、DB integrity、crash/ANR；不虚构真实 provider 结果。
- harness 只做可审计汇总，不新增 Writer、Agent、Context、Memory 或生产 Gate；任何 chapter count 不符、重复收费/调用、Governor physical call、DB 损坏或 crash/ANR 都是 NO-GO。
- CHECK-B 必须使用同签名 release `adb install -r`，检查真实 Android UI、Receipt/DB 可见证据和 logcat；当前凭据若仍为 HTTP 401，则记录 `HOLD`，继续 IV-8 做闭环文档但不发布 Final Seal GO。

## IV-8 PLAN — Final Seal Closure

- 逐条核对 Phase IV 主方案的 P0、阶段产物、PDCA、Android 安装约束、Receipt/DB/UI/logcat 证据和历史证据保留边界；把“已证明”“仅本地/确定性证明”“真实样本缺失”分开。
- Final Seal 的第一验收指标仍是 E2E First-Pass Adoptable Rate；没有当前真实 Android 5/10 章分母时，结论必须是 `HOLD`，不得用 C9 projection completion、mock、contract test 或旧版本结果替代。
- 复核主链没有新增工程 Gate、额外 LLM stage、Governor physical call 或固定业务 maxTokens；`outcome_unknown` 不自动 retry，`finishReason=length` 不持久化。
- 完成 `phase4-requirement-closure.md` 与 `phase4-final-report.md`，记录最终可执行解封条件。若真实证据仍为 401，则完成审计文档但维持 `PHASE IV FINAL SEAL HOLD / NO-GO`，不输出 `PHASE IV FINAL SEALED / GO`。

## IV-8 PDCA 结论

- **RED**：Final Seal Required Gate 审计发现当前版本没有合法的真实 Android 5/10 章 paid 分母；C9 projection completion、历史 8/8、mock 和 contract test 均不能替代 First-Pass。
- **DO**：完成 `phase4-requirement-closure.md`、`phase4-final-report.md`，逐项记录 10 个最终问题和 13 个 P0 的证据等级；不引入新的生产 Gate、LLM stage 或 retry。
- **CHECK-A**：继承 IV-7 最终 full verify：`VERIFY_EXIT_CODE=0`，Jest 531 suites passed / 3 skipped，3751 tests passed / 8 skipped；lint 0 errors、typecheck、Elastic、version 通过。
- **CHECK-B**：继承同签名 release `adb install -r`、UI/数据保护/XML/PNG/logcat 证据；`保存并测试` 为真实 HTTP 401，release DB 受 `run-as: package not debuggable` 限制，不能宣称当前 DB paid sample 完成。
- **ACT / GO-NO-GO**：代码治理继续保持；最终封板保持 `PHASE IV FINAL SEAL HOLD / NO-GO`。凭据恢复后仅补真实 5/10 章和 Receipt/DB/First-Pass A/B，不改变已封存的主链减法方向。

## IV-8 证据索引

- Requirement closure：`docs/optimization/phase4-requirement-closure.md`
- Final report：`docs/optimization/phase4-final-report.md`
- Continuous harness / IV-7 full CHECK-A：`docs/optimization/phase4-continuous-harness.md`、`test-logs/phase4-iv7-20260830-155254/iv7-check-b.md`
- Historical A/B：`docs/optimization/phase4-historical-ab.md`
- Historical C9 and C8/C9 evidence：`test-logs/phase3-c9-cost-latency-20260830-000001/`

### IV-9 真实 Android 运行结算（凭据恢复后，2026-08-30）

- 设备/包：emulator-5554，debug 签名 `adb install -r`（release 签名与在装 debug 包不兼容，且禁止 uninstall，故本轮真实运行使用同代码的 debug 构建；firstInstallTime=2026-08-23 保持不变，数据零丢失）。模型：GLM-5.3-Flash（UI `保存并测试` 通过）。
- **5 章连续批次**（`batch_mtfkmlek_i6qms3`，目标 5 章/3000 字）：4/5 章 `full_pipeline` adopted；第 5 章 Draft 连续 5 次 `total_timeout`（本地 570s 看门狗，提供端对该 fresh-boundary 请求停摆，冷重启/in-place resume 均不收敛），用户确认式结束批次留证（status=cancelled，4 章成果保留）。
  - 首章（第100章显示）3 次尝试：timeout → QA `finishReason=length` 截断（修正前 APK 硬拒，真实复现了缺口）→ 修正版 APK 重装后 Draft success + QA 截断**按 Advisory skipped（非 Clean）**、Revision 零调用、FinalValidate 通过并 adopted——Pre-Seal Correction 在生产链路验证生效。
  - First-Pass Adoptable：3/5（第114/115/116 显示章一次通过；第100显示章第 3 次尝试 adopted，不计 first-pass）；physical calls 2–3/章；Governor physical call=0；无 crash/ANR（crash buffer 空）。
- **10 章连续批次**（`batch_mtfrwv40_bhx4r5`）：第 1 章 Draft 连续 4 次 570s timeout（含一次完整 App 冷重启后 resume），0/10，未继续烧 paid 调用，结束留证。
- **判定**：两个连续运行 Required Gate 均无法形成完整分母 → `PHASE IV FINAL SEAL HOLD / NO-GO` 维持；真实 4/5 章样本与生产级修正验证已入账（`test-logs/phase4-preseal-20260830-1650/`）。外部提供端停摆是唯一剩余 blocker；恢复后仅需补"边界首章 Draft"可通过的 provider 环境并重跑 5/10 章，不改架构。
- C9 基线对比（真实样本）：input tokens per adopted chapter 83.5k–135.7k vs C9 p50 38.1k（本批含 3000 字目标与思考强度标准，口径不同，不作降幅宣称）；QA/Revision 合同、Resume、Receipt/DB 完整可审计。
