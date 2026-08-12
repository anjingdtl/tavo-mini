# Tavo-Mini Context Budget V3 最终封板收尾改造与验收方案

> 项目：Tavo-Mini  
> 方案定位：**Context Budget V3 Final Seal / 最终封板**  
> 编制时远端参考 HEAD：`faccaf42bdf846787b826ea76f4ac5f0aa3fbf6b`  
> 参考提交：`feat: finalize context budget v3 closure`  
> 日期：2026-08-12  
>
> **重要说明：本轮将更换开发机和 Agent。本文不写死任何本地目录、ADB serial、Node/Java/Android SDK 路径、模拟器名称或构建产物路径。Agent 必须在新环境中自行发现仓库、工具链和设备，以本地仓当前真实状态为唯一实施依据。**

---

# 0. 本轮结论与目标

上一轮远端独立验收结论为：

```text
NO-GO
```

但主体架构已经完成，当前不再允许大规模扩展 Context Budget V3。

已确认完成的核心能力包括：

```text
V6 Story Coverage candidate-first
Recent Raw ≤ 10
V3 Board Grant 决定 Recent Bridge
V6 Poison Legacy 自动化测试
Resources candidate-first
Story State actual demand
Final Reviser 静态 12K/8K/6K/4K/5K cap 移除
Derived Final narrow read / CursorWindow 修复
Derived Final 仅新增一次 Final API
Batch V3 Policy/hash 持久化
章节手动 Context Config 入口移除
Settings 收束到 V3 模型感知
Full verify PASS
Android Derived Final PASS
```

本轮只做最后三类工作：

1. **关闭一个仍存在的预算利用率残留：Post-Coverage Episodic Demand Reclaim。**
2. **完成上一轮缺失的 Android Mandatory Gate 22 / 28 / 34 / 35 / 36 / 37 / 39 / 40 / 41。**
3. **重新生成最终 Verification，只有全部 Gate 有证据才允许 GO。**

原则：

> **不再发明 V4/V7，不再新增第二套 allocator，不再调大固定 token，不再重开已经封板的 Story Memory Protocol V2、Pipeline 审核语义或 Continuation 业务协议。**

---

# 1. 新开发机 Preflight：禁止假设环境

Agent 开工后第一件事不是改代码，而是识别环境。

## 1.1 自动定位仓库

在当前工作目录或用户指定工作区内寻找 Git 仓库，然后执行：

```bash
git rev-parse --show-toplevel
```

若当前目录不是仓库，Agent 应在合理工作区中查找 `tavo-mini`，不得假定：

```text
E:\AiWorkSpace\tavo-mini
F:\ClaudeWorkSpace\projects\TAVO-MINI
C:\...
```

任何历史路径都只是旧机器信息，不是本轮约束。

确认 repo root 后：

```bash
git status --short --branch
git remote -v
git fetch --all --prune
git rev-parse HEAD
git rev-parse origin/main
git rev-list --left-right --count HEAD...origin/main
git log -10 --oneline
```

记录：

```text
repo root
current branch
local HEAD
origin/main HEAD
ahead/behind
dirty files
untracked files
```

## 1.2 本地修改保护

禁止：

```bash
git reset --hard
git clean -fd
git checkout .
```

如发现本地未提交内容：

- 不覆盖；
- 不擅自 stash/drop；
- 先判断是否属于本轮改造；
- 不相关则绕开；
- 相关则在 Verification 中说明如何合并。

## 1.3 远端基线

编制本方案时远端参考为：

```text
faccaf42bdf846787b826ea76f4ac5f0aa3fbf6b
```

但 Agent 必须重新 fetch。

如果 `origin/main` 已前进：

```text
先审计新提交
→ 判断是否已经修复本方案内容
→ 以当前代码为准
```

不得机械回退到 `faccaf42`。

---

# 2. 新开发机工具链探测

不要复制旧开发机路径。

Agent 应自行检查：

```bash
node --version
npm --version
java -version
adb version
adb devices -l
```

如项目有版本管理文件，还应读取：

```text
package.json
package-lock.json
.nvmrc
.tool-versions
android/gradle/wrapper/gradle-wrapper.properties
android/build.gradle*
android/app/build.gradle*
```

目标：

- 使用项目声明的 Node/npm/Gradle/JDK；
- 不擅自升级框架或 Android Gradle Plugin；
- 不因新机器环境差异顺手做依赖升级；
- 环境缺失只安装“运行当前项目所需”的最低必要组件。

如果有多个 Android 设备/模拟器：

```bash
adb devices -l
```

自动选择一个在线且可运行目标，并把 serial 记录到 Verification。

不得写死：

```text
emulator-5554
```

---

# 3. 本轮修改边界

## 3.1 允许修改

```text
Context Budget V3 hierarchical allocation integration
Story Coverage → Episodic demand feedback
Context Preview 的折叠式预算详情（可选但推荐）
Android QA / test fixture / verification helpers
相关 targeted/property/integration tests
Verification 文档
必要的测试脚本
```

## 3.2 原则上禁止修改

```text
Story Memory Protocol V2 Observation Compiler
Story Memory Merger / CAS
physical request ledger
LLM retry protocol
Draft/Review/FactCheck/Brief 的语义合同
Derived Final 已封板架构
Continuation Writer / Checker / Control / Repair 业务协议
Provider transport
数据库大规模 schema 重构
```

只有出现新的、可复现 P0 时才允许越界，并必须在 Verification 单独说明。

---

# 4. P0：Post-Coverage Episodic Demand Reclaim

## 4.1 当前残留

上一轮实现已经做到：

```text
previous chapters
    ↓
Episodic preliminary candidates
    ↓
计算 episodicDemand
    ↓
Hierarchical Board Allocation
    ↓
获得 sliding grant
    ↓
resolveStoryMemoryCoverage()
    ↓
rawChapterIds
    ↓
excludeRawFromEpisodicCandidates()
```

问题在于：

> **第一次 Board Allocation 时，Episodic Demand 可能仍包含稍后会进入 Recent Raw Bridge 的章节。**

示例：

```text
预估 Episodic demand = 8K
Board 给 Episodic = 8K

resolve Story Coverage 后：
最近若干章全部作为 Raw Recent Bridge

最终 Episodic 实际只需 1K
```

多出的约 7K 已经不再消费，但也不会自动回到 Resources / Story State / Sliding 等仍有 unmet demand 的板块。

这不造成超窗口，但会造成：

```text
预算利用率损失
跨板块借调不充分
小/中窗口下资料过度裁剪
Preview 中 demand/grant 与最终真实消费有偏差
```

---

# 5. P0 目标不变量

本轮必须做到：

```text
Final Board Demand
=
最终实际可消费的 Demand
```

至少针对 Episodic：

```text
postCoverageEpisodicDemand
<=
preCoverageEpisodicDemand
```

若：

```text
postCoverageEpisodicDemand < allocatedEpisodic
```

则差额必须可以：

```text
reclaim
→ redistribute
→ 其它仍 unmet 的 Board
```

同时保持：

```text
final allocation <= board ceiling
final total <= hard input
deterministic
0 extra LLM
0 extra DB retrieval round
```

---

# 6. 推荐实现：Two-pass Deterministic Local Reconciliation

不要创建新的 allocator。

继续复用：

```text
allocateHierarchicalContextBudget()
```

推荐流程：

```text
Phase A
────────────────────────
collect Story Coverage candidates
collect Story State demand
collect preliminary Episodic candidates/demand
collect Resource candidates/demand
estimate Sliding demand
        ↓
Initial Hierarchical Allocation
        ↓
sliding grant
        ↓
resolveStoryMemoryCoverage()
        ↓
rawChapterIds

Phase B
────────────────────────
exclude rawChapterIds from Episodic candidates
        ↓
recompute postCoverageEpisodicDemand
        ↓
if demand changed:
    rebuild same HierarchicalBudgetInput
    ONLY update episodic.actualDemandTokens
    run same allocator once again
        ↓
Final Board Allocation
        ↓
render all boards
```

注意：

- 这是同一个 deterministic allocator 的本地二次收敛，不是新增预算系统；
- 不增加任何 LLM 调用；
- 不重新读取 DB；
- 不重新做外部检索；
- Resources candidates 不重新采集；
- Story State 不重新渲染 DB；
- 只基于 Phase A 已经冻结在当前 buildContext 调用内的数据重新分配。

---

# 7. 防止二次分配改变 Story Coverage 造成循环

这里必须避免：

```text
allocation1 → coverage1
→ episodic demand2
→ allocation2 → sliding grant变化
→ coverage2 → episodic demand3
→ 无限循环
```

推荐采用**最多两次**的 deterministic closure。

方案 A（优先）：

```text
Initial allocation
→ resolve Coverage
→ recompute Episodic demand
→ Final allocation
```

然后：

- Final Sliding grant 如果增加，只允许增加 raw capacity；
- 不允许因为 Episodic reclaim 后 Final Sliding grant 下降导致已选 Raw 被撤销；
- 必要时将 Initial Sliding grant 作为 final sliding floor；
- Final allocator 中 Sliding 的 min/floor 可设为 initial resolved grant 的实际已消费量，而不是旧配置值。

等价不变量：

```text
finalSlidingAllocated
>=
tokensActuallyCommittedByResolvedCoverage
```

这样无需第三轮。

若现有 allocator 不方便设置 board floor，则可以：

```text
final sliding actual demand
=
resolved bridge actual rendered demand
```

并确保 allocator 对该 committed demand 不会缩回。

禁止 while-loop 反复求固定点。

---

# 8. Final Render 必须使用 Final Allocation

最终：

```text
effectiveStoryStateBudget
effectiveResourceBudget
effectiveSlidingWindow
effectiveEpisodicBudget
```

必须全部来自：

```text
Final Hierarchical Allocation
```

同时更新：

```text
hierarchicalBudgetTrace
resource item allocations
resource item traces
```

Preview / Frozen Snapshot / Draft Send 必须看到 Final Trace，不得看到 Phase A 临时 Trace。

---

# 9. 新增回归测试：Episodic Reclaim

至少新增以下测试。

## T01 — Raw consumes preliminary Episodic

构造：

```text
recent 4 chapters
每章都有 memory_summary
大 sliding grant
```

Phase A：

```text
episodic demand > 0
```

Story Coverage：

```text
4 chapters all raw
```

Final：

```text
postCoverageEpisodicDemand ≈ 0
```

断言：

```text
episodic allocated shrinks
released capacity is reclaimable
```

## T02 — Reclaim goes to Resources

构造：

```text
Resources demand > soft target
Episodic prelim demand > 0
recent raw full-fit
```

断言：

```text
resource finalAllocated
>
initialResourceAllocated
```

同时：

```text
borrow/reclaim reason 可追踪
```

## T03 — Partial Raw

部分章节 Raw、部分 Episodic。

断言：

```text
post demand 只包含未被 Raw 覆盖章节
```

## T04 — 32K Pressure

小窗口下必须确保：

```text
不超 hard
Recent seam 不丢
资源能获得回收额度
```

## T05 — 1M Full Fit

大窗口：

```text
所有实际 demand full-fit
无无意义 clipping
```

## T06 — Determinism

同输入重复 20 次：

```text
same board allocation
same raw ids
same episodic ids
same resource item grants
same prompt bytes
```

---

# 10. Context Preview：折叠式 Budget Detail

上一轮将四个 Board 明细从主卡中删除，UI 已更简洁。

本轮不要求恢复常驻四行大表。

推荐只增加：

```text
查看预算详情
```

折叠区显示：

```text
Story State
  demand / allocated / borrowed

Recent Bridge
  demand / allocated / borrowed

Resources
  demand / allocated / borrowed

Episodic
  demand / allocated / borrowed
```

目的：

> 配置权由系统接管，但解释权仍保留给用户。

要求：

- 默认折叠；
- 不恢复手动配置；
- 不出现 sliding/full/custom；
- 不允许从 Preview 改预算；
- 数据必须来自真实 Final `hierarchicalBudgetTrace`；
- 不重新计算第二份 Preview allocator。

如果本轮为了控制风险决定不改 UI，也允许，但 Verification 必须明确列为：

```text
non-blocking product follow-up
```

不能误判为算法 Gate。

---

# 11. Mandatory Android Gate 收尾

上一轮以下 Gate 缺实机证据：

```text
22
28
34
35
36
37
39
40
41
```

本轮必须全部补齐。

---

# 12. Gate 22 — Batch Policy Freeze Live Mutation

目标不是再次跑普通 Batch，而是**主动制造 live Policy 变化**。

步骤：

```text
1. 创建 ≥2 章 Batch
2. 记录 Batch frozen:
   version
   policyVersion
   policyHash
   policySnapshot
3. 让第一个 child 开始/完成
4. 修改 live Context Automation Policy
5. 继续后续 child
6. 查询 parent/child frozen metadata
```

断言：

```text
parent contextBudgetVersion = 6
child1 = 6
child2 = 6

child1 policyHash = parent policyHash
child2 policyHash = parent policyHash

livePolicyHash != parentPolicyHash
```

后续 child 仍必须使用 parent frozen snapshot。

如果 UI 无法方便修改内部 ratio，可通过正式 Settings 的可用 Policy 操作完成；禁止直接篡改 child frozen data 伪造测试。

---

# 13. Gate 28 — 32K / 64K / 128K / 1M

在 Android 实际运行 Context Preview 或等价真实 V6 Build。

依次验证：

```text
32K
64K
128K
1M
```

每档记录：

```text
model context window
hard input
soft pool
burst pool
Story demand/allocated
Sliding demand/allocated
Resources demand/allocated
Episodic demand/allocated
clipped item count
```

核心单调性：

对于同一份项目/章节/资源：

```text
window increases
→ board allocated 不应无理由下降
→ clipped count 不应增加
→ full-fit item 不应重新被裁剪
```

允许因取整出现极小差异，但必须解释。

---

# 14. Gate 34 — Android Big Resources

必须真实构造至少两个大资源。

优先使用安全 QA fixture 或测试项目，不破坏用户真实项目。

示例：

```text
Character A ≈ 10K+ tokens
Character B ≈ 10K+ tokens
```

要求两项都被明确激活/选择。

在 1M 模型下：

```text
A allocated >= A actual demand
B allocated >= B actual demand
A clipped = false
B clipped = false
```

不能再出现历史问题：

```text
每项固定约 2~3K
```

---

# 15. Gate 35 — Android Poison Legacy

需要证明新任务真的不受旧配置污染。

可通过测试 fixture、旧数据库字段或现有内部 QA 入口设置：

```text
strategy = custom
slidingWindowSize = 1
recentChapterCount = 1
resourceBudget = 1
storyStateBudget = 1
episodicBudget = 1
memoryTopK = 0/1
includeResources = false
```

然后发起 V6 Preview/Task。

断言：

```text
Recent Bridge 仍按 V3 actual demand/grant
Resources Board 仍可工作
Story/Episodic 不受 legacy hard cap
```

必须保留 before/after DB 或 trace 证据。

不得为了测试破坏 Legacy 旧任务兼容。

---

# 16. Gate 36 — Android Cross-board Borrow

必须制造真实：

```text
allocated > softTarget
borrowed > 0
```

建议：

```text
大 Resources demand
Story State demand 很小或 0
Episodic demand 很小
Sliding demand 较小
```

然后选择足够大的模型/窗口让 Resources 可以借用其它板块未消费 soft capacity。

至少捕获一个 Board：

```text
borrowedTokens > 0
```

并证明：

```text
allocated <= ceiling
总量 <= hard input
```

如果实现 Post-Coverage Reclaim，本 Gate 最好同时证明：

```text
Episodic shrink
→ Resources increase
```

---

# 17. Gate 37 — Real Model Switch Auto Expansion

这是本轮最重要的体验验收之一。

必须真实：

```text
1. 选择较小窗口模型/配置
2. 打开同一章节 Preview
3. 记录 clipping / allocations
4. 只切换到 1M 模型
5. 不点击任何“应用预算”
6. 再次打开/刷新 Preview
```

断言：

```text
系统直接读取新的模型 context_window
hard/soft/burst 自动变化
大资源 allocation 自动增长
clipping 自动减少或不增加
没有独立 budget apply 步骤
```

这证明：

> **预算真正跟模型走，而不是跟旧 ContextConfig 或手工 Apply 走。**

---

# 18. Gate 39 — Android Full Pipeline + Resume

先跑完整：

```text
Draft
Review
FactCheck
Brief
Final
```

之后再单独制造 Resume：

```text
开始一个新流水线
→ 至少一个 Stage succeeded
→ Home / App switch / 可控进程生命周期切换
→ 返回 App
→ Resume
```

断言：

```text
已 succeeded Stage 不重复调用
attempt count 不增加
frozen model 不变
frozen policy hash 不变
frozen context hash 不变
最终可继续完成
```

禁止通过直接改 DB 把 Stage 设成功来代替真实 Resume。

---

# 19. Gate 40 — Android Batch Resume

创建至少 2 章 Batch。

中途：

```text
至少一个 child 已经进入/完成
→ App switch / 可控中断
→ 返回
→ Batch Resume
```

断言：

```text
已完成 child 不重复
未完成 child 继续
Batch frozen policy 不变
child policy hash 一致
最终 completed
```

建议和 Gate 22 的 live Policy mutation 合并设计一次测试，减少 LLM 消耗，但两类证据必须分别清楚。

---

# 20. Gate 41 — Data Preservation + API Key Continuity

必须使用：

```bash
adb install -r <apk>
```

禁止：

```text
adb uninstall
pm clear
清数据库
删除 app data
```

覆盖安装前记录：

```text
firstInstallTime
projects count
chapters count
resources counts
story memory counts
pipeline task counts
usage/attempt counts
```

覆盖安装后再次记录。

API Key 不得明文输出。

推荐连续性验证：

```text
before:
  hasStoredApiCredential = true

adb install -r

after:
  hasStoredApiCredential = true
```

或者调用项目现有安全读取 API，只验证：

```text
credential exists
same hash/fingerprint
```

禁止把真实 key 写进 Verification。

若无法安全读取 fingerprint，可通过已有 LLM 配置继续成功调用作为辅助证据，但最好仍有 boolean/fingerprint 层验证。

---

# 21. Derived Final 不再重构，只做回归

已经独立验收通过的链路：

```text
Result
→ 仅重写终稿
→ narrow metadata/payload reads
→ 复用 frozen upstream
→ +1 Final API
→ completed
```

本轮只需回归：

```text
large parent payload
no CursorWindow
Draft +0
Review +0
FactCheck +0
Brief +0
Final +1
```

禁止再次扩大 Derived Final 架构。

---

# 22. Final Reviser 不再重调固定数字

上一轮已经移除：

```text
12K
8K
6K
4K
5K
```

等模块 Hard Cap。

本轮只回归：

```text
actual demand
model-relative envelope
shared elastic allocation
```

不要重新加入绝对 token cap。

`minTokens` 如果仍存在，只允许是 continuity floor，不得演变为 max ceiling。

---

# 23. Story Coverage 不再重构

必须保持：

```text
collectStoryMemoryCoverageCandidates()
→ budget-neutral
→ max raw 10
→ allocator grant
→ resolveStoryMemoryCoverage()
```

Post-Coverage Reclaim 只能接在后面，不允许退回：

```text
config.slidingWindowSize
```

决定 V6 candidate。

Poison Legacy 测试必须继续 PASS。

---

# 24. 静态扫描

完成后执行等价扫描。

## Legacy Leakage

```bash
rg -n "slidingWindowSize|resourceBudget|storyStateBudgetTokens|episodicMemoryBudgetTokens|strategy.*custom|customRangeStart|customRangeEnd" src
```

人工区分：

```text
Legacy <=5 compatibility
V6 runtime
```

V6 runtime 不得把这些当 hard cap。

## Final fixed caps

```bash
rg -n "maxTokens:\s*(12000|8000|6000|5000|4000)" src/services/pipeline
```

不得重新出现业务模块固定 ceiling。

## High payload SELECT

```bash
rg -n "SELECT \* FROM pipeline_tasks|SELECT \* FROM pipeline_stage_checkpoints" src
```

任何命中都必须解释是否属于非关键旧脚本；生产关键路径不得回归。

---

# 25. 测试顺序

必须按以下顺序，不要只跑 full verify。

## Phase 1 — Targeted failing-first

先为 Post-Coverage Reclaim 写失败测试：

```text
pre demand contains raw chapter summaries
post demand excludes them
capacity redistributed
```

确认旧代码确实 fail，再实现。

## Phase 2 — Targeted

至少：

```text
contextBuilder V3 integration
hierarchical allocator
Story Coverage
resource item allocation
Final budget
Derived Final
Batch freeze
Resume
Continuation budget
```

## Phase 3 — Property

至少：

```text
token safe
hierarchical invariant
determinism
tail clip
```

## Phase 4

```bash
npm run typecheck
```

## Phase 5

运行项目既有 lint/verify：

```bash
npm run verify
```

若脚本名称变化，以当前 `package.json` 为准。

不得修改测试脚本来掩盖失败。

---

# 26. Remote CI

推送前检查项目是否存在 GitHub Actions。

如果远端有可用 CI：

- 等待 commit checks；
- 所有 required/有效 checks 必须绿。

如果仓库仍然没有 CI：

Verification 必须写：

```text
Remote CI: unavailable / no status checks
```

不得把“没有 CI”写成 PASS。

---

# 27. Android 安装与测试原则

Agent 在新机器自行：

```bash
adb devices -l
```

确定 serial。

构建 debug APK 后：

```bash
adb -s <actual-serial> install -r <actual-apk-path>
```

禁止假定旧：

```text
emulator-5554
ShineWriter-V2.11.49-debug.apk
```

版本号、APK 名称、路径都以新机器当前构建结果为准。

---

# 28. 数据采证原则

每个 Android Gate 尽量留下：

```text
UI XML
screenshot
DB readonly query result
logcat excerpt
allocation trace
usage call count
policy hash
context hash
```

但 Verification 不应依赖仅存在于旧机器、未提交的：

```text
test-logs/*.png
*.xml
旧 adb dump
旧 DB copy
```

新 Agent 必须重新生成本轮证据。

可以引用旧证据作背景，但不能用来满足本轮 Mandatory Gate。

---

# 29. NO-GO 条件

以下任一成立，本轮仍 NO-GO：

```text
Post-Coverage Episodic 释放额度无法回收
Final trace 仍使用 Phase A 旧 demand
V6 又读取 slidingWindowSize/resourceBudget 作为 hard cap
32K/64K/128K/1M 未跑齐
Android 两大资源未 full-fit
Android Poison Legacy 未跑
Android borrowedTokens > 0 未出现
模型切到1M仍需要手工 Apply budget
Batch live Policy mutation 未证明 freeze
Single Resume 未实跑
Batch Resume 未实跑
API Key continuity 无安全证据
Derived Final 又触发 CursorWindow
Derived Final 上游 Stage 重跑
Preview 与实际 Draft 分配不一致
full verify fail
需要 uninstall/pm clear 才能通过
依赖旧开发机证据代替新机实测
```

---

# 30. 最终 Mandatory Gate

本轮最终只需重点封以下 Gate，但上一版其余已 PASS 项必须回归不退化。

## Seal Gate A — Repo/Environment Discovery
- [ ] 自动定位 repo；
- [ ] 自动发现 Node/JDK/ADB；
- [ ] 自动发现 Android serial；
- [ ] 无历史路径硬编码；
- [ ] local/origin HEAD 已记录。

## Seal Gate B — Post-Coverage Reclaim
- [ ] Preliminary Episodic demand 可包含 recent summaries；
- [ ] Coverage 后 raw ids 被排除；
- [ ] post demand 重算；
- [ ] 释放容量进入 final allocator；
- [ ] unmet board 可获得回收额度；
- [ ] final total 不超 hard。

## Seal Gate C — Reclaim Determinism
- [ ] 最多两次 deterministic local allocation；
- [ ] 无循环；
- [ ] 无第三套 allocator；
- [ ] 0 extra LLM；
- [ ] 0 extra DB retrieval。

## Seal Gate D — Preview/Send
- [ ] Preview 使用 final allocation；
- [ ] Frozen Draft 使用 final allocation；
- [ ] prompt bytes 与同条件 send 一致；
- [ ] Phase A trace 不泄漏成最终结果。

## Seal Gate E — 32K/64K/128K/1M
- [ ] 32K Android；
- [ ] 64K Android；
- [ ] 128K Android；
- [ ] 1M Android；
- [ ] clipping monotonic。

## Seal Gate F — Big Resources
- [ ] 两个真实大资源；
- [ ] 1M full-fit；
- [ ] 无固定2~3K；
- [ ] item trace 与真实 token 一致。

## Seal Gate G — Poison Legacy
- [ ] Android 旧参数极端小；
- [ ] V6 不受影响；
- [ ] Legacy 旧任务仍兼容。

## Seal Gate H — Cross-board Borrow
- [ ] Android `borrowedTokens > 0`；
- [ ] `allocated > softTarget`；
- [ ] 不超 ceiling；
- [ ] 最好包含 Episodic reclaim → Resources increase。

## Seal Gate I — Model Switch
- [ ] 小窗口真实 Preview；
- [ ] 只切 1M；
- [ ] 不点 Apply；
- [ ] 自动扩张。

## Seal Gate J — Batch Policy Freeze Mutation
- [ ] ≥2 child；
- [ ] 中途修改 live policy；
- [ ] 后续 child 仍 parent hash；
- [ ] parent/children version=6。

## Seal Gate K — Single Resume
- [ ] 成功 Stage 后可控中断；
- [ ] Resume；
- [ ] 成功 Stage 不重复；
- [ ] frozen hashes 不漂移。

## Seal Gate L — Batch Resume
- [ ] ≥2章；
- [ ] 可控中断；
- [ ] Resume；
- [ ] 已完成 child 不重复；
- [ ] 最终 completed。

## Seal Gate M — Derived Final Regression
- [ ] 大 parent；
- [ ] no CursorWindow；
- [ ] 上游 +0；
- [ ] Final +1；
- [ ] completed。

## Seal Gate N — Data Preservation
- [ ] `adb install -r`；
- [ ] firstInstallTime 不变；
- [ ] Projects/Chapters/Resources 保留；
- [ ] Story Memory 保留；
- [ ] Usage/Attempt 保留；
- [ ] API credential continuity 安全验证；
- [ ] 无 uninstall / pm clear。

## Seal Gate O — Full Verification
- [ ] targeted；
- [ ] property；
- [ ] typecheck；
- [ ] lint 无新增 error；
- [ ] full verify；
- [ ] Android Gates；
- [ ] remote CI 状态说明。

---

# 31. Final Verification 文档

完成后生成：

```text
docs/optimization/
Context-Budget-V3-Final-Seal-Verification-YYYYMMDD.md
```

必须包含：

1. 新开发机环境摘要；
2. repo root（允许写本轮实际路径，仅 Verification 记录，不作为代码假设）；
3. initial local HEAD；
4. initial origin/main；
5. final HEAD；
6. changed files；
7. Post-Coverage Reclaim 根因；
8. Phase A/Phase B 算法；
9. allocation before/after 对比；
10. 0 extra LLM；
11. static scan；
12. targeted；
13. property；
14. typecheck/lint/full verify；
15. 32K/64K/128K/1M Android；
16. Big Resources；
17. Poison Legacy；
18. Borrow；
19. Model Switch；
20. Batch Policy Mutation；
21. Single Resume；
22. Batch Resume；
23. Derived Final；
24. data preservation；
25. API credential continuity；
26. Remote CI；
27. 所有 Seal Gate A~O；
28. 最终 GO/NO-GO。

---

# 32. GO 定义

只有全部成立：

```text
Post-Coverage Reclaim closed
32K/64K/128K/1M Android complete
Big Resources full-fit
Poison Legacy live
Borrow live
1M auto expansion live
Batch freeze mutation live
Single Resume live
Batch Resume live
Derived Final regression
Data/API credential preservation
Full Verify
```

才允许：

```text
GO
```

并写：

> **Context Budget V3 全链路自动弹性上下文完成最终封板。后续除非出现新的可复现生产问题，不再继续增加预算层级、固定比例或理论复杂度。**

---

# 33. Agent 开工提示词

```text
这是 Tavo-Mini Context Budget V3 的最终封板轮次。当前开发机和 Agent 已更换，禁止使用任何历史机器的写死路径、ADB serial、Android SDK/JDK/Node 路径或 APK 文件名。先自动定位 Git repo root，执行 git status、git fetch --all --prune，记录 local/origin HEAD 和 dirty files，保护所有本地修改；再按当前 package.json、Gradle 配置和系统实际环境发现 Node/JDK/ADB/模拟器，以当前本地仓代码为唯一实施真相。

完整阅读本方案后不要扩大架构。主体 V6、Story Coverage、Final elastic、Derived Final CursorWindow、Batch Policy Freeze、手动 Context UI 收束都已基本完成，本轮核心代码只关闭 Post-Coverage Episodic Demand Reclaim：当前 preliminary Episodic demand 可能包含稍后进入 Recent Raw Bridge 的章节，Story Coverage resolve 后要排除 rawChapterIds、重算 postCoverage Episodic actual demand，并使用同一个 hierarchical allocator 做最多一次 deterministic final redistribution，让释放容量回到其它仍 unmet 的 Board。禁止新建第二套 allocator、循环求固定点、增加 LLM/DB 请求或重新引入固定 token cap；最终 Preview/Frozen Draft/Send 必须使用 final allocation。

先写能复现旧问题的失败测试，再修代码；补 raw→episodic exclusion、reclaim→resources、partial raw、32K、1M、determinism 测试。然后严格补齐上一轮缺失的 Android Gate：32K/64K/128K/1M、两个大资源 full-fit、Poison Legacy、真实 borrowedTokens>0、只切1M无需 Apply 自动扩张、Batch 中途修改 live Policy 后 child hash 仍冻结、Single Resume、Batch Resume、Data/API credential continuity；Derived Final 只做回归，必须继续保持大 parent 无 CursorWindow、上游 +0、Final +1。使用 adb install -r，禁止 uninstall/pm clear。

所有 targeted/property/typecheck/lint/full verify 与 Android Seal Gate A~O 全部有新开发机实证后，才允许 GO。任何 Mandatory 证据缺失仍判 NO-GO。最后生成 docs/optimization/Context-Budget-V3-Final-Seal-Verification-YYYYMMDD.md，逐 Gate 列真实命令、测试结果、allocation/hash/usage/Android 证据和最终结论。
```
