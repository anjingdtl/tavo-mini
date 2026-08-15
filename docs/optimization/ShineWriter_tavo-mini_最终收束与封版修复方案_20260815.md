# ShineWriter / tavo-mini 最终收束与封版修复方案
## —— 基于远端 main `c975155e` 与 Verify #296 失败结果的最小闭环方案

> 文档性质：本地 Agent 可直接执行的收束方案 / PDCA Seal Plan  
> 仓库：`anjingdtl/tavo-mini`  
> 目标分支：`main`  
> 当前远端基线 HEAD：`c975155ef42303a89cfeb4c4507103866ad2e9d6`  
> 当前远端 CI：GitHub Actions `Verify #296` / run `31872426112`  
> 当前结论：核心改造已落地，但远端 CI 未全绿，暂不得标记 `GO / SEALED`  
> 核心原则：**只收口、不扩边界；先修 CI 硬阻断，再做完整验证和文档回写。**

---

# 0. 执行摘要

本轮不是新的架构改造，不重新审议 Continuation Batch、Outline Pipeline、Writer Style、Context Auto、Story Memory 或 Token Budget 的设计。

当前远端 `main` 已完成：

- 续写模式「一键写 N 章」Additive Adapter 接入；
- Continuation V5 独立执行链；
- Future Plan / Future Source Leakage 防护；
- eligible → Adoption → Finalize → State Ready 严格串行门；
- V5 Writer Style Snapshot 对齐；
- Active Writer Style Resolver 收口；
- Context Auto 遗留全局写库入口删除；
- Note `none/禁用` 语义修正；
- 多章批次自动预算按章数扩展；
- Android Debug Build 与 Migration Matrix 已在远端 CI 通过。

但 `Verify #296` 因 `npm run lint` 存在 **2 个 error** 而失败，导致同一 CI Job 中的 TypeScript 与 Jest 被跳过。

因此本轮唯一目标是：

```text
修复 2 个 lint error
→ 本地完整 verify
→ APK / 数据保留冒烟
→ push 单一收束 commit
→ GitHub Actions Verify 三 Job 全绿
→ 回写 PDCA 最终真实 HEAD / Run ID / 结果
→ 独立 Final Audit
→ GO / SEALED
```

---

# 1. 当前已确认的 NO-GO

## 1.1 CI 阻断 1：未使用 import

文件：

```text
src/services/contextAutoAllocator.ts
```

当前错误：

```text
'serializeContextAutomationPolicy' is defined but never used
@typescript-eslint/no-unused-vars
```

处理要求：

- 删除未使用的 `serializeContextAutomationPolicy` import；
- 不修改其余 Context Auto V2/V3 算法；
- 不顺手清理其他 warning；
- 不恢复已经删除的旧 `applyContextAutoAllocation` 全局写库入口。

---

## 1.2 CI 阻断 2：测试变量未使用

文件：

```text
__tests__/batchPlanner.test.ts
```

当前错误位置约为：

```text
line 414
```

现状类似：

```ts
const [msgs, maxTokensArg, options] = mockCallLLMResult.mock.calls[0];
```

其中 `msgs` 未使用。

处理优先级：

```ts
const [, maxTokensArg, options] = ...
```

或：

```ts
const [_msgs, maxTokensArg, options] = ...
```

优先采用**最小 diff 且符合当前 ESLint 规则**的写法。

禁止为了此问题修改 Planner 业务逻辑、LLM 参数、预算规则或测试目标。

---

# 2. 本轮严格边界

## 2.1 允许修改

原则上只允许：

```text
src/services/contextAutoAllocator.ts
__tests__/batchPlanner.test.ts
docs/optimization/ShineWriter_大纲模式架构精准修复方案_20260815.md
```

如果执行中发现必须增加一个专门的 Seal / PDCA 记录文件，也允许在：

```text
docs/optimization/
```

新增一份文档。

---

## 2.2 禁止修改

除非新的红测明确证明存在本轮引入的 P0/P1，否则禁止修改：

```text
src/services/continuation/**
src/services/storyMemory/**
src/services/multiChapterBatch/continuationBatchAdapter.ts
src/services/multiChapterBatch/continuationBatchStateGate.ts
src/services/pipeline/**
src/services/pipelineRunner*
src/services/contextBuilder*
src/services/continuation/canon/**
src/services/continuation/continuationSourceReader.ts
src/services/continuation/generation/continuationV5Runner.ts
src/services/continuation/generation/continuationV5PromptCompiler.ts
src/services/continuation/generation/finalArtifactValidator.ts
SQLite schema / migrations
frozenRequestJson
input_fingerprint
旧 V4 及以下兼容协议
```

禁止：

- 借机处理 202 个 lint warning；
- ESLint 大面积 auto-fix；
- 依赖升级；
- Node / Gradle / React Native 升级；
- God module 拆分；
- Story Memory 专项修复；
- Continuation State Extraction 专项修复；
- Token estimator 算法调整；
- FIX-6 / FIX-7 待证项实施；
- 无测试证据的“顺手优化”。

---

# 3. Round 0 —— 本地仓状态与远端基线锁定

执行任何修改前：

```bash
git status
git branch --show-current
git rev-parse HEAD
git fetch origin
git rev-parse origin/main
git log --oneline -5 origin/main
```

必须确认：

```text
origin/main = c975155ef42303a89cfeb4c4507103866ad2e9d6
```

如果远端 HEAD 已变化：

1. 停止按旧 SHA 直接修改；
2. 查看新提交内容；
3. 判断上述 2 个 lint error 是否已经被修复；
4. 重新运行 `npm run lint`；
5. 以新的真实 HEAD 为基线继续，不得机械 cherry-pick 或覆盖。

如果本地存在未提交改动：

- 不得 reset / clean / checkout 覆盖；
- 先记录 `git status --short`；
- 判断是否为用户现有工作；
- 本轮只叠加最小收束修改；
- 提交前必须明确本轮 diff 边界。

Gate：

```text
GO-0 =
远端基线明确
+ 本地用户改动未被破坏
+ 本轮修改边界明确
```

---

# 4. Round 1 —— 精确复现当前 CI 错误

修改前先执行：

```bash
npm run lint
```

目标：

必须能够复现远端 CI 的两个 error，至少确认：

```text
__tests__/batchPlanner.test.ts
@typescript-eslint/no-unused-vars

src/services/contextAutoAllocator.ts
@typescript-eslint/no-unused-vars
```

允许存在既有 warning。

记录：

```text
lint-before.log
exit code
error 数
warning 数
```

禁止在未确认真实失败点前批量改代码。

Gate：

```text
GO-1 =
CI 两个 error 本地可复现
或有可解释的环境差异证据
```

---

# 5. Round 2 —— 最小修复

只实施以下两项：

## FIX-SEAL-1

删除：

```ts
serializeContextAutomationPolicy
```

的未使用 import。

不得改变 Context Auto 的任何运行行为。

## FIX-SEAL-2

消除 `batchPlanner.test.ts` 中未使用的 `msgs` 变量。

不得改变：

```text
maxTokensArg == 8000
options.max_tokens == 8000
```

等现有测试语义。

完成后立即执行：

```bash
git diff --check
git diff -- src/services/contextAutoAllocator.ts __tests__/batchPlanner.test.ts
npm run lint
```

硬要求：

```text
lint errors = 0
```

warning 可保留，禁止为追求 0 warning 扩大范围。

Gate：

```text
GO-2 =
两个 lint error 消失
+ 业务代码行为未改变
+ diff 最小
```

---

# 6. Round 3 —— 本地完整验证

Lint 通过后，依次运行：

```bash
npm run verify:version
npm run lint
npm run typecheck
npm run test:ci
```

如果项目本地惯用的是：

```bash
npx jest --runInBand --ci
```

也可追加执行，但 `npm run test:ci` 必须覆盖 GitHub Actions 的真实命令。

要求：

```text
verify:version = PASS
lint = 0 errors
typecheck = PASS
test:ci = PASS
```

特别注意：

远端上一轮由于 lint 提前失败，TypeScript 与 Jest 被跳过，因此本轮必须真实跑完，不能用上一次本地 PDCA 的旧日志替代。

若任何测试失败：

1. 先判断是否由本轮 2 行级修改导致；
2. 若是，修复最小根因；
3. 若不是，登记新的 NO-GO；
4. 不得为了“全绿”修改不相关测试预期或降低断言强度。

Gate：

```text
GO-3 =
Version + Lint + TypeScript + Jest 全绿
```

---

# 7. Round 4 —— Android 与迁移回归

虽然远端 `Verify #296` 中：

```text
Android Debug build = PASS
Migration matrix = PASS
```

仍建议本地至少执行与 CI 对等的关键检查：

```bash
npm run apk:debug
```

如本地 Android 模拟器环境可用：

```bash
adb install -r <debug-apk>
```

要求：

- 只允许 `adb install -r`；
- 禁止 `adb uninstall`；
- 禁止 `pm clear`；
- 禁止清空用户数据库；
- 冷启动应用；
- 检查无新增 FATAL / ReactNativeJS 未捕获异常。

Migration：

执行仓库 CI 对等迁移测试：

```bash
npm test -- migration --runInBand
```

要求：

```text
APK build = PASS
Migration tests = PASS
历史数据不因本轮变化受影响
```

由于本轮没有 schema 改动，不得创建新 migration。

Gate：

```text
GO-4 =
Android build + Migration 无回归
```

---

# 8. Round 5 —— 核心架构防回归抽查

本轮不重新大测整个架构，但必须确认收束修改没有误伤关键能力。

至少抽查以下测试或相应现有 suite：

```text
pipelineContextSnapshotV5
activeStyleResolver
contextAutoAllocator
note semantics / note mode none
multiChapterBatchBudget
continuationBatchSchema
continuationBatchPlanner
continuationBatchAdapter
```

重点不变量：

```text
1. Continuation Batch 不走 runChapterPipeline
2. active_continuation_run_id 与 active_pipeline_task_id 语义仍隔离
3. Future Plan Leakage = 0
4. Future Source Leakage = 0
5. eligible Final 才可自动 Adoption
6. Adoption 后必须 Finalize
7. State 未 Ready 时下一章 LLM call = 0
8. Source / Boundary / Canon drift = fail closed
9. kill/resume 不重复 chapter / run / adoption
10. Outline Batch 原路径不被 Continuation Adapter 改写
11. Note mode none = 零候选
12. Writer Style V5 snapshot 往返不丢失
13. 自动 Batch Budget 随 chapterCount 扩展
```

Gate：

```text
GO-5 =
核心回归无新增失败
```

---

# 9. 已知问题处理原则

以下两项是此前真实 LLM E2E 暴露的既有单章链路问题：

```text
A. continuationStateOutboxWorker：
   状态提取模型可能返回 reasoning-only / 空正文

B. storyMemory v2：
   checkpoint rebuild 可能出现事务失败
```

本轮处理方式：

```text
记录，不修。
```

除非本轮最小收束修改导致其行为发生新的回归，否则不得进入这些受保护模块。

原因：

- 两项问题在单章链路中同样存在；
- 不是 Continuation Batch Adapter 新增缺陷；
- 属于独立专项；
- 强行并入本轮会破坏“只收束、不扩边界”的 Seal 原则。

最终报告中继续标记为：

```text
Known Existing Issues / 非本轮 NO-GO
```

不得错误写成“已解决”。

---

# 10. Round 6 —— PDCA 文档真实回写

更新：

```text
docs/optimization/ShineWriter_大纲模式架构精准修复方案_20260815.md
```

原文中类似：

```text
“提交与 push 在最终工作区审查通过后执行”
```

已经与仓库事实不一致，必须更新。

回写至少包括：

```text
Seal 前 HEAD
Seal 修复内容
本地 lint 结果
typecheck 结果
Jest / test:ci 结果
APK build 结果
Migration 结果
最终 commit SHA
GitHub Actions Run ID
三个 CI Job 结果
剩余 Known Issues
最终 Seal 判定
```

禁止伪造：

- 测试数量；
- Actions Run ID；
- APK 结果；
- 真机结果；
- E2E 完成度。

所有数字以实际命令输出为准。

---

# 11. Round 7 —— Commit / Push

提交前：

```bash
git status --short
git diff --check
git diff --stat
git diff
```

确认只包含本轮允许范围。

推荐 commit：

```text
fix: seal architecture precision closure
```

推荐 body：

```text
- remove the two lint blockers from Verify #296
- keep Context Auto and batch planner behavior unchanged
- close local version/lint/typecheck/test verification
- update PDCA with the actual seal evidence
```

然后：

```bash
git add <明确文件>
git commit
git push origin main
```

禁止：

```text
git add .
```

如果工作区还有用户无关改动，应逐文件 stage。

Gate：

```text
GO-7 =
单一收束 commit
+ 无无关文件混入
+ push 成功
```

---

# 12. Round 8 —— 远端 GitHub Actions 最终硬门

Push 后检查新 HEAD 的 GitHub Actions `Verify`。

必须全部通过：

```text
JavaScript validation = SUCCESS
Android Debug build    = SUCCESS
Migration matrix       = SUCCESS
```

其中 JavaScript validation 必须真实执行并通过：

```text
Version consistency
Lint
TypeScript
Jest (CI mode)
```

不能再出现：

```text
TypeScript = skipped
Jest = skipped
```

如果 Actions 失败：

```text
NO-GO
```

读取具体 job log，只修真实根因，不得继续在文档里宣布 SEALED。

---

# 13. Independent Final Audit

CI 全绿后，独立执行一次最终审计。

回答以下问题：

```text
Q1. 最新 origin/main 是否就是本轮 Seal HEAD？
Q2. 工作区是否干净？
Q3. Verify 是否三 Job 全绿？
Q4. JS Job 中 lint/typecheck/Jest 是否全部真实执行？
Q5. 本轮是否只修复 CI 阻断与 PDCA 状态？
Q6. 是否误改 Continuation / Story Memory / Pipeline 核心？
Q7. 是否误恢复已删除的 Context Auto 全局写库入口？
Q8. Note none 是否仍为零候选？
Q9. V5 Writer Style Snapshot 是否仍严格往返？
Q10. Continuation State Gate 是否仍保证下一章 LLM call=0？
Q11. 是否存在新增 P0？
Q12. 是否存在新增 P1？
Q13. 是否仍有本轮必须解决的 NO-GO？
```

Final Seal 唯一允许条件：

```text
新 P0 = 0
新 P1 = 0
本轮剩余 NO-GO = 0
GitHub Actions Verify = 全绿
```

最终结论才允许写：

```text
GO / SEALED
```

---

# 14. 失败处理纪律

任何阶段失败时：

1. 保留失败日志；
2. 明确根因；
3. 判断是否为本轮引入；
4. 新 P0/P1 自动登记 NO-GO；
5. 不在未理解的红色结果上继续叠加修改；
6. 不降低测试强度；
7. 不删除失败测试；
8. 不通过扩大 eslint ignore 绕过错误；
9. 不通过 `|| true`、关闭 CI step 等方式制造假绿；
10. 不因 warning 数量较多而启动全仓 lint cleanup。

---

# 15. Agent 自主执行要求

本地 Agent 应自主完成本方案，不需要逐步向用户申请确认。

执行原则：

```text
以本地仓为操作对象
以 origin/main 为远端事实校验
保护本地未提交用户改动
最小 diff
先复现再修复
先红后绿
失败自动定位
边界内自动修复
边界外登记 NO-GO
验证完成后再 commit / push
push 后必须检查远端 Actions
Actions 未全绿不得结束为成功
```

如果发现远端在执行期间已有其他新提交：

```text
fetch
→ 比较差异
→ 避免覆盖
→ 在最新 main 上重新验证
→ 必要时重新生成 Seal commit
```

禁止强推：

```bash
git push --force
```

---

# 16. 最终交付报告格式

Agent 完成后输出：

```text
# Final Seal Report

Baseline HEAD:
Final HEAD:
Commit:
GitHub Actions Run:

## Changes
- ...
- ...

## Local Gates
- verify:version:
- lint:
- typecheck:
- test:ci:
- APK:
- migration:
- targeted regression:

## Remote Gates
- JavaScript validation:
- Android Debug build:
- Migration matrix:

## Architecture Audit
- Continuation Batch isolation:
- Future Plan Leakage:
- Future Source Leakage:
- State Ready hard gate:
- Outline regression:
- Writer Style V5 snapshot:
- Note none:
- Batch budget scaling:

## Known Existing Issues
- continuation state extraction reasoning-only:
- story-memory v2 checkpoint rebuild:

## New Defects
P0:
P1:
P2:

## Remaining NO-GO
...

## Final Decision
GO / SEALED
或
NO-GO：<明确原因>
```

---

# 17. 最终验收标准

本轮不是以“代码改完”为完成标准，而是以：

```text
远端最新 HEAD
+
GitHub Actions Verify 全绿
+
本地完整回归全绿
+
PDCA 与真实仓库状态一致
+
无新增 P0/P1
+
无本轮剩余 NO-GO
```

作为唯一完成标准。

> **本轮必须保持克制：当前核心架构已经基本成立，真正需要解决的是最后两个 CI 阻断和 Seal 证据闭环。不要重新开启架构建设。**
