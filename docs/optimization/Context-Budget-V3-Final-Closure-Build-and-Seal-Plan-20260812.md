# TAVO-MINI Context Budget V3 最终收口建设与封板方案

> 文档日期：2026-08-12  
> 适用项目：`anjingdtl/tavo-mini`  
> 当前远端基线：`54ad7d0e6176680873bc5d7da4f0b0b929396e8e`  
> 当前版本：ShineWriter `V2.11.49`  
> 当前结论：**NO-GO**  
> 本方案目标：在不继续扩展 Context Budget V3 主设计的前提下，清零最终封板剩余阻断，形成可独立复核的 Final Seal 证据链。

---

## 1. 背景与当前状态

Context Budget V3 主体建设已基本完成，Post-Coverage Episodic Demand Reclaim 已落地并推送至远端。

当前已经确认的核心实现包括：

- Story Coverage 完成后，排除已进入 Recent Raw Bridge 的章节；
- 基于剩余 Episodic candidates 重算真实 Episodic demand；
- 当 demand 发生变化时，复用同一 `allocateHierarchicalContextBudget()`；
- 最多执行一次 deterministic Phase B redistribution；
- 已提交 Raw Bridge 通过 Sliding board 的 `minTokens` floor 保持不被二次回收；
- 不重复 DB、LLM、retrieval、Coverage 读取；
- 无 fixed-point redistribution；
- 32K / 1M hard budget safety、determinism 等专项测试已覆盖。

因此：

> **Post-Coverage Episodic Demand Reclaim 本体按代码级验收可视为 GO。**

当前最终封板仍为 NO-GO，主要剩余问题已经从“算法与预算主逻辑”转移到：

1. 远端 GitHub Actions 未全绿；
2. Android 实机证据不足；
3. Batch / Resume / Policy Freeze / Derived Final 缺少完整闭环；
4. Cross-board borrow 尚缺实机可观察字段；
5. 个别自动化用例仍可进一步加强因果证明。

---

# 2. 本轮建设总目标

本轮不再进行新的架构扩展，而是完成最后一轮“证据化收口”。

最终目标：

```text
代码行为正确
        ↓
自动化测试闭环
        ↓
CI clean checkout 全绿
        ↓
Android 实机可观察
        ↓
Resume / Batch / Policy Freeze 实际闭环
        ↓
Final Seal 文档
        ↓
GO
```

最终需将 Gate 状态收敛为：

| Gate | 当前 | 最终目标 |
|---|---|---|
| A–G | GO | GO |
| H Cross-board Borrow | NO-GO | GO |
| I | GO | GO |
| J Batch Policy Freeze | NO-GO | GO |
| K Single Resume | NO-GO | GO |
| L Batch Resume | NO-GO | GO |
| M Derived Final | NO-GO | GO |
| N | GO | GO |
| O Release / CI Seal | NO-GO | GO |

---

# 3. 建设原则与边界

## 3.1 严格冻结主设计

除非新测试能够明确证明 allocator 本身存在 bug，否则：

- 不修改 Context Budget V3 board priority；
- 不修改 soft / elastic / hard budget 公式；
- 不新增第三阶段 redistribution；
- 不改 Story Coverage 选择原则；
- 不重新设计 Episodic retrieval；
- 不修改 Recent Raw Bridge 的章节选择策略；
- 不调整 32K / 1M budget profile；
- 不借“收口”名义继续扩展功能。

本轮的优先级是：

> **修证据、修闭环、修 CI、补可观察性，而不是继续优化算法。**

---

## 3.2 以本地仓为执行基准，以远端仓为最终验收基准

Agent 开始执行时：

1. 先读取本地仓；
2. 检查当前 branch / HEAD / dirty files；
3. 与远端 `origin/main` 比较；
4. 不允许直接 reset 或覆盖用户未提交修改；
5. 如本地存在更新，以本地实际代码为分析基准；
6. 最终完成后必须推送远端，再以远端 clean checkout 结果验收。

---

## 3.3 修复边界必须最小化

任何发现的问题都先完成：

```text
复现
→ 定位
→ 判断是否属于本轮范围
→ 最小修复
→ targeted test
→ regression
→ full verify
```

禁止：

- 顺手重构无关代码；
- 批量升级依赖；
- 调整无关 UI；
- 改动历史协议行为；
- 删除或放宽已有测试以获得 PASS；
- 将真实失败改成 skip；
- 通过扩大 timeout 掩盖状态机错误；
- 通过 catch / ignore 掩盖 Resume、DB 或 LLM 状态异常。

---

# 4. Workstream 0：先补强 Post-Coverage Reclaim 最后一处自动化证据

## 4.1 目标

现有 T02 已证明最终 Resources board：

- `borrowedTokens > 0`
- `allocatedTokens > softTargetTokens`
- 与 hierarchical allocator 的最终计算一致

但还缺一条最直接的因果链：

> Phase B 的 Resources allocation 必须明确大于 Phase A allocation。

---

## 4.2 建议建设方式

在测试层增加可观察的 preliminary allocation。

优先方案：

- 不污染生产接口；
- 在测试环境通过 allocator trace / hook / extracted helper 获取 Phase A result；
- Phase B 后比较 final result。

目标断言：

```ts
expect(finalResourcesAllocated).toBeGreaterThan(
  preliminaryResourcesAllocated,
);
```

同时保留：

```ts
expect(finalResources.borrowedTokens).toBeGreaterThan(0);
expect(finalTotal).toBeLessThanOrEqual(hardInputLimit);
```

---

## 4.3 验收标准

T02 必须完整证明：

```text
Coverage 前：
Episodic demand > Phase B Episodic demand

Coverage 后：
Raw chapters 从 Episodic candidates 排除

Phase B：
Resources final allocation > Phase A allocation

同时：
hard input limit 未突破
```

若为实现该测试必须大幅侵入生产接口，则放弃增加生产 API，只保留测试内部 instrumentation。

---

# 5. Workstream 1：清零 GitHub Actions JavaScript Validation 红灯

## 5.1 当前问题

当前远端 `54ad7d0` 的 CI 状态：

- Android Debug Build：PASS
- Migration Matrix：PASS
- JavaScript validation：FAIL

当前唯一失败：

```text
__tests__/pipelineWorkflowV2Integration.test.ts

V2 production state machine
› V2 Proof failure resume re-fires ONLY the V2 proof
```

预期：

```text
proof attempts = 2
```

实际：

```text
proof attempts = 1
```

该失败在本次 Context Budget Reclaim 改造前的 parent 提交上已经存在，因此：

> 优先按“遗留 CI blocker”处理，不将其直接归因于 Context Budget V3。

---

## 5.2 排查重点

重点检查以下路径：

- V2 proof transient failure 的 retry disposition；
- safe_retry backoff；
- reconcile loop 是否在 CI 环境过早 finalize；
- `Date.now()` / fake timer / timer granularity；
- retry due time；
- SQLite attempt persistence；
- Node 24 与本地 Node 环境行为差异；
- Jest `--runInBand --ci` 与本地 `npm run verify` 差异；
- Promise / microtask / timer flush 顺序；
- test fixture 是否依赖 wall clock。

---

## 5.3 优先判断：生产 bug 还是测试时序 bug

### 如果生产状态机确实只执行一次 proof

则修生产逻辑。

必须保证：

```text
draft succeeded
review succeeded
factCheck succeeded
proof attempt #1 transient failure
proof safe_retry
proof attempt #2 succeeded
previous successful stages NOT rerun
task completed
```

### 如果生产逻辑正确，仅 CI wall-clock 导致第二次 retry 未到期

则修测试设计，使其 deterministic。

优先使用：

- fake timers；
- injectable clock；
- 显式 advance time；
- deterministic retry clock。

禁止简单加入：

```ts
await sleep(1000)
```

来“赌 CI 时间”。

---

## 5.4 验收标准

本地必须通过：

```bash
npm run lint
npm run typecheck
npm run test:ci
npm run verify
```

远端 GitHub Actions 必须：

```text
JavaScript validation PASS
Migration Matrix PASS
Android Debug Build PASS
```

最终不得再存在红色 required job。

---

# 6. Workstream 2：Gate H — Cross-board Borrow Android 可观察性闭环

## 6.1 当前缺口

自动化已经能够证明 board-level borrow，例如：

```text
resources.borrowedTokens > 0
```

但 Android 实机目前无法直接看到：

- soft target；
- actual demand；
- allocated tokens；
- borrowed tokens；
- reclaim 前后差异。

因此 Gate H 缺少实机一级证据。

---

## 6.2 建设目标

在现有 Context Preview / Budget Trace / Debug 视图中，增加只读展示。

至少暴露：

```text
Story State
- actualDemandTokens
- softTargetTokens
- allocatedTokens
- borrowedTokens

Resources
- actualDemandTokens
- softTargetTokens
- allocatedTokens
- borrowedTokens

Sliding Window
- actualDemandTokens
- softTargetTokens
- allocatedTokens
- borrowedTokens

Episodic
- actualDemandTokens
- softTargetTokens
- allocatedTokens
- borrowedTokens
```

同时展示：

```text
hardInputLimit
mandatoryTokens
totalEstimatedInputTokens
```

---

## 6.3 UI 边界

该能力只用于诊断和验收：

- 不允许用户在此页面修改 allocator；
- 不引入新的配置；
- 不改变生产逻辑；
- 不显示秘密数据；
- 不显示 API credential；
- 不写入 DB；
- 只读取本次 `hierarchicalBudgetTrace`。

推荐仅在：

- Context Preview；
- Debug / Experimental；
- Pipeline trace detail

中展示。

---

## 6.4 Android 验收场景

构造 32K 场景：

- Mandatory 有一定占用；
- Resources demand 大于 soft target；
- Coverage 产生 Raw Bridge；
- Episodic reclaim 后释放 budget；
- Resources 获得 borrow。

实机必须能够明确看到：

```text
Resources borrowedTokens > 0
Resources allocatedTokens > softTargetTokens
totalEstimatedInputTokens <= hardInputLimit
```

并保存：

- 截图；
- trace JSON；
- 测试项目 ID；
- chapter ID；
- app version；
- git SHA。

---

# 7. Workstream 3：Gate J — Batch Policy Freeze 闭环

## 7.1 目标

证明：

> Batch 启动时冻结 Context Budget Policy，运行中修改 live policy 后，后续 child 仍使用 Batch 启动时的 frozen policy。

---

## 7.2 需要确认的数据

Batch 创建时必须具备稳定可复核的：

```text
policy snapshot
policy hash / fingerprint
context budget version
context window
reserved output tokens
```

后续每个 child pipeline 必须能追溯到：

```text
batch frozen policy hash
```

---

## 7.3 Android 实测步骤

1. 设置 Context Budget Policy A；
2. 创建至少 3 chapter 的 Batch；
3. 启动 Batch；
4. 等 child #1 已创建或开始；
5. 修改 live policy 为 Policy B；
6. 不重新创建 Batch；
7. 继续 child #2、#3；
8. 检查每个 child persisted context snapshot / trace；
9. 对比 frozen policy hash。

期望：

```text
Batch frozen hash = A

child #1 hash = A
child #2 hash = A
child #3 hash = A

live settings = B
```

不得出现：

```text
child #2 / #3 = B
```

---

## 7.4 自动化测试

新增或补强：

```text
BatchPolicyFreeze.integration
```

至少覆盖：

- create batch with A；
- mutate settings to B；
- create/reconcile later children；
- child policy hash remains A；
- cold start resume 后仍为 A。

---

## 7.5 GO 标准

同时满足：

- 自动化 PASS；
- Android 实机 PASS；
- DB snapshot 可查；
- policy hash 全链一致。

---

# 8. Workstream 4：Gate K — Single Pipeline Resume 闭环

## 8.1 目标

证明单章节 Pipeline：

> 已成功 Stage 不重跑，只从失败/中断 Stage 继续，并最终完成。

---

## 8.2 推荐测试节点

优先选择：

```text
draft       succeeded
review      succeeded
factCheck   succeeded
proof       interrupted / safe retry
final       pending
```

然后触发：

- app kill；
- foreground service interruption；
- 可恢复 transient failure；

再 Resume。

---

## 8.3 必须验证

Resume 前后 attempts：

```text
draft        1
review       1
factCheck    1
proof        2
```

或根据当前流水线实际阶段名称等价判断。

不得：

```text
draft -> 2
review -> 2
factCheck -> 2
```

同时：

```text
workflow version 不降级
request_version 不降级
context snapshot 不重新冻结
最终 task = completed
```

---

## 8.4 Android 实机证据

必须保留：

- Resume 前任务状态；
- stage checkpoint；
- Resume 后 attempts；
- final artifact；
- task completed；
- DB 行；
- app log。

---

# 9. Workstream 5：Gate L — Multi-Chapter Batch Resume 真正完成闭环

## 9.1 当前问题

已有实机恢复行为能够 fail-closed：

```text
BATCH_LLM_OUTCOME_UNKNOWN
paused_timeout_unknown
```

但这只能证明安全阻断，不能证明：

> Batch Resume 能继续成功生产并完成多个 child。

---

## 9.2 最终验收要求

至少构造一个 3 chapter Batch：

```text
child #1 completed
child #2 interrupted
child #3 pending
```

执行 cold-start / resume 后：

```text
child #1 不重跑
child #2 从正确阶段继续并 completed
child #3 正常继续并 completed

parent batch = completed
```

至少要求：

```text
>= 2 child completed after resume path
```

---

## 9.3 Unknown Outcome 分支要求

如果遇到真实 outcome unknown：

- 必须继续保持 fail-closed；
- 不允许自动重复 LLM；
- 不允许为了通过验收把 unknown 当 success；
- 可通过人工明确 retry / recover 后继续；
- 最终另开一个确定性 interruption 场景完成 Gate L。

换言之：

> Unknown Outcome safety 行为保留，但不能拿它代替 Batch Resume 成功闭环。

---

## 9.4 自动化矩阵

覆盖：

### L1
child #1 completed，child #2 interrupted

### L2
cold start 后 state normalize

### L3
resume child #2

### L4
child #1 attempt count unchanged

### L5
child #2 completed

### L6
child #3 completed

### L7
parent completed

### L8
project changed / fingerprint mismatch 时 fail-closed

---

# 10. Workstream 6：Gate M — Derived Final Android E2E

## 10.1 目标

证明 Derived Final 不只是单测正确，而是在 Android 实际生产链中可完成。

---

## 10.2 场景

选择一个稳定章节：

1. draft 成功；
2. review/fact-check/proof 按当前协议完成；
3. final artifact 由 derived final 规则生成；
4. UI 正确展示；
5. DB 正确记录；
6. Resume 后不重复生成已完成 final。

---

## 10.3 必须校验

至少包括：

```text
final artifact 非空
source revision 对应正确
derived final version 正确
final validation PASS
token / budget trace 正确
task completed
chapter adoption 正确
```

如果存在 Final Seal / shrink：

```text
final input <= hard limit
```

---

# 11. Workstream 7：Final Seal 统一证据包

所有 Gate 完成后，不直接宣布 GO。

必须执行一次新的 Final Seal。

---

## 11.1 代码基线

记录：

```text
git status
git rev-parse HEAD
git rev-parse origin/main
git diff
```

要求：

```text
HEAD == origin/main
working tree clean
```

---

## 11.2 自动化验证

必须执行：

```bash
npm ci
npm run verify:version
npm run lint
npm run typecheck
npm run test:ci
npm run verify
```

专项：

```bash
# Context Budget V3 targeted
npx jest __tests__/contextBuilderV3.integration.test.ts --runInBand

# V3 property / closure
npx jest __tests__/contextBudgetV3Closure.test.ts --runInBand
npx jest __tests__/contextBudgetV3FinalClosure.test.ts --runInBand

# Batch / Resume / Policy Freeze
# 运行本轮新增或补强的 targeted suites
```

---

## 11.3 Android

必须：

```bash
cd android
./gradlew assembleDebug
```

然后：

```bash
adb install -r <apk>
```

除非测试明确需要，否则：

```text
禁止 uninstall
禁止 pm clear
```

必须保留用户现有数据。

---

## 11.4 数据安全

验证：

- 原数据库仍存在；
- 用户测试项目仍存在；
- credential 未进入 SQLite；
- Secure Storage / Keychain 数据未被 DB dump；
- 不输出 credential 到日志；
- 不上传 credential 到 Git。

---

# 12. 最终 Gate 判定表

完成后生成新版：

```text
Context-Budget-V3-Final-Seal-Verification-YYYYMMDD.md
```

每个 Gate 必须有：

| 字段 | 内容 |
|---|---|
| Gate | H / J / K / L / M / O |
| Requirement | 验收定义 |
| Automation Evidence | 测试与结果 |
| Android Evidence | 设备实测 |
| DB Evidence | 如适用 |
| CI Evidence | GitHub Actions |
| Git SHA | 当前远端 SHA |
| Status | GO / NO-GO |
| Notes | 风险或例外 |

---

# 13. 最终 GO 条件

只有全部满足才允许 GO：

## 13.1 Context Budget

- Post-Coverage Raw exclusion 正确；
- Episodic demand 正确回收；
- Phase B 最多一次；
- deterministic；
- 32K hard-safe；
- 1M hard-safe；
- cross-board borrow 实机可见。

## 13.2 Policy / Resume

- Batch frozen policy 不受 live setting mutation 影响；
- Single Resume 成功 stage 不重跑；
- Batch Resume 成功 child 不重跑；
- parent 能最终 completed；
- unknown outcome 仍 fail-closed。

## 13.3 Final

- Derived Final Android E2E PASS；
- Final artifact 校验 PASS；
- hard budget 不突破。

## 13.4 Release

- `npm run verify` PASS；
- `npm run test:ci` PASS；
- GitHub Actions 全绿；
- Android Debug Build PASS；
- APK overwrite install PASS；
- 数据不丢；
- credential 不落 DB；
- HEAD = origin/main；
- working tree clean。

---

# 14. 明确禁止的“伪收口”

以下行为一律不能用于把 NO-GO 改成 GO：

- 将失败测试改成 skip；
- 删除失败断言；
- 把 expected 值改成当前错误结果；
- 增加长 sleep 掩盖时序；
- 将 Resume 改为重新跑完整 Pipeline；
- 将 unknown outcome 自动当作 failure 后重试；
- 为通过 Gate H 伪造 borrowedTokens；
- 修改 trace 但生产 allocator 不一致；
- 通过 uninstall / `pm clear` 绕过迁移或恢复问题；
- 删除测试数据；
- 删除历史 task / checkpoint；
- 关闭 CI job；
- 将 required CI 改 optional；
- 为避免 Node 24 问题直接永久锁死过期环境而不说明原因。

---

# 15. Agent 建议执行顺序

严格建议按以下顺序：

```text
Step 1
复现并修复 V2 Proof Resume CI 红灯

Step 2
补强 T02 Phase A → Phase B delta assertion

Step 3
增加 Android board-level budget trace 可观察性

Step 4
完成 Gate H Android 实测

Step 5
完成 Batch Policy Freeze 自动化 + Android 实测

Step 6
完成 Single Resume 自动化 + Android 实测

Step 7
完成 Batch Resume 自动化 + Android 实测

Step 8
完成 Derived Final Android E2E

Step 9
npm run verify / test:ci / Android build

Step 10
推送远端

Step 11
等待并检查 GitHub Actions 全绿

Step 12
基于远端 HEAD 重做 Final Seal
```

如果 Step 1～8 中任意一步发现严重生产 bug：

```text
立即暂停 Final Seal
→ 最小修复
→ targeted regression
→ full regression
→ 再继续
```

---

# 16. 建议新增/更新文件

优先控制在以下范围内：

```text
src/services/contextBuilder.ts
__tests__/contextBuilderV3.integration.test.ts

# Gate H
src/screens/ContextPreviewScreen.tsx
或现有 Budget Trace 相关展示文件

# Gate J / K / L
src/services/multiChapterBatch/*
src/services/pipeline/*
对应 __tests__ 文件

# Gate M
Final / Derived Final 相关已有模块与测试

docs/optimization/
Context-Budget-V3-Final-Seal-Verification-YYYYMMDD.md
```

除非证明确有必要，否则不要扩散到其他模块。

---

# 17. 最终交付物

Agent 完成后必须交付以下内容：

## A. 代码

- 最小修复；
- 新增测试；
- Android trace 可观察性。

## B. 测试结果

汇总：

```text
targeted suites
property tests
npm run test:ci
npm run verify
Android assembleDebug
adb install -r
```

## C. 实机证据

至少：

- Gate H；
- Gate J；
- Gate K；
- Gate L；
- Gate M。

## D. CI

GitHub Actions：

```text
JavaScript validation PASS
Migration Matrix PASS
Android Debug Build PASS
```

## E. Final Seal

新版：

```text
Context-Budget-V3-Final-Seal-Verification-YYYYMMDD.md
```

最终只允许两种结论：

```text
GO
```

或：

```text
NO-GO
```

不得使用：

```text
基本通过
条件通过
建议上线
风险可接受
```

来替代严格 Gate 判定。

---

# 18. 本轮完成定义（Definition of Done）

本轮建设只有在以下全部完成后才算结束：

```text
[ ] V2 Proof Resume CI blocker 已解决
[ ] T02 Phase A → Phase B 因果断言已补强
[ ] Gate H Android board borrow 实证完成
[ ] Gate J Batch Policy Freeze 实证完成
[ ] Gate K Single Resume 实证完成
[ ] Gate L Batch Resume 实证完成
[ ] Gate M Derived Final Android E2E 完成
[ ] npm run test:ci PASS
[ ] npm run verify PASS
[ ] GitHub Actions 全绿
[ ] Android build PASS
[ ] overwrite install PASS
[ ] 原测试数据保留
[ ] credential 未进入数据库
[ ] 远端 HEAD 与本地 HEAD 一致
[ ] Final Seal 文档完成
[ ] 所有 Gate = GO
```

---

# 19. 最终执行方针

本轮应视为：

> **Context Budget V3 的最终封板工程，而不是下一轮功能开发。**

优先消灭不确定性和证据缺口。

只要没有新的自动化或 Android 实证证明 Context Budget V3 allocator 本体存在错误，就不要再调整：

- allocator 数学规则；
- board priority；
- Story Coverage；
- Episodic reclaim；
- Recent Raw Bridge；
- 32K / 1M budget 策略。

最终目标不是让更多代码发生变化，而是让现有正确行为具备：

```text
可重复
可观察
可恢复
可追溯
可在 CI 复现
可在 Android 实机复核
```

当上述条件全部成立，才正式解除 NO-GO，进入最终发版。
