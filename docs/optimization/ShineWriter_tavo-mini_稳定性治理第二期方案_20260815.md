# ShineWriter / tavo-mini 稳定性治理第二期方案
## —— 从 Stability Foundation GO 到 Stability Architecture GO / SEALED

**项目：** `anjingdtl/tavo-mini`  
**执行基线：** 以执行时本地最新 `main` 为准  
**当前远端验收参考 HEAD：** `b6c2f7b81296a1c4eaaa8e811adf063e495e8fb2`（V2.11.53）  
**第一期状态：** `Stability Foundation — GO`  
**第二期目标：** `Stability Architecture — GO / SEALED`  
**执行方式：** 分阶段 PDCA、小步提交、Golden Diff、真机穿测、独立 Stability CI；禁止再次“大爆改”

---

# 0. 第二期治理定位

第一期已经完成并验证了以下基础能力：

- `generationTraceId` 已进入大纲生成链；
- `FrozenGenerationContextV1` 与 `generationFingerprint` 已建立；
- Freeze Envelope 损坏已改为 fail-closed；
- Resume / Cold Start 可验证指纹不漂移；
- 多数影响 Generation 语义的 silent fallback 已结构化诊断化；
- Replay Harness 已具备冻结信封解析与指纹重算能力；
- Regression Corpus 已建立；
- Golden Journey 20 条已建立；
- Legacy live-DB post-draft 路径已移出生产主链；
- 常规 CI（JS / Android / Migration）已全绿。

因此第二期**不是重新设计稳定性架构**，而是补齐第一期最终验收发现的剩余 P1 / P2 缺口。

正确路线：

```text
保持第一期契约稳定
        ↓
真正拆分 Context Builder
        ↓
补齐 Candidate / Budget / Render Contract
        ↓
Trace 升级为决策级可解释
        ↓
Replay 升级为决策级重放
        ↓
Continuation 接入统一 Trace
        ↓
完整真机矩阵
        ↓
独立 Generation Stability CI
        ↓
最终独立审计
        ↓
GO / SEALED
```

---

# 1. 第一阶段验收遗留问题

## P1-01：Context Builder 六阶段仅完成 Layer 1

当前已有：

```text
collect
normalize
plan
allocate
render
freeze
```

六阶段命名、计时和 freeze guard，但真正的 DB / Repository 读取、Story Memory、Note、Candidate、Context Auto、Budget demand、Render 等仍大量交织在 `contextBuilder` 主体内。

第二期必须完成 **Layer 2+ 的真正迁移**。

## P1-02：FrozenGenerationContext 缺完整 Candidate / Budget / Render Contract

当前 Snapshot 仍不能完整回答：

- 找到了哪些资料；
- 哪些资料被选择；
- 哪些未被选择；
- 选择/拒绝原因；
- 每项 demandTokens；
- 每项 allocatedTokens；
- 每项 actualTokens；
- 是否 clipped；
- clipping reason。

## P1-03：Replay 仍是 Fingerprint Replay，不是 Decision Replay

当前 Replay 主要验证 Envelope / Fingerprint / Frozen Request determinism，但还不能从真实输入稳定重跑：

```text
Candidate Selection
→ Demand Plan
→ Budget Allocation
→ Render
```

## P1-04：Real Device Matrix 未完整覆盖

第二期必须补齐：

- Continuation；
- Context Auto；
- Story Memory；
- Writer Style；
- 大型资料；
- 64K / 128K / 1M；
- 80% / 95% / Hard Limit；
- Continuation N 章；
- Freeze 后 DB 修改再 Resume。

## P2-01：Continuation V5 未统一 generationTraceId

当前 Continuation 仍有独立 `contextTraceJson` 体系，需要通过 Adapter 统一到 Generation Trace 语义体系。

## P2-02：缺少独立 Generation Stability CI Gate

目前稳定性测试虽然跟随 Jest 执行，但缺少独立、显式、不可忽略的：

```text
Generation Stability
```

---

# 2. 第二期总体目标

最终形成稳定主链：

```text
UI / Generation Entry
        ↓
Generation Identity
        ↓
Collect
        ↓
Normalize
        ↓
Plan
        ↓
Allocate
        ↓
Render
        ↓
Freeze
        ↓
Frozen Generation Contract
        ↓
Draft
        ↓
Review
        ↓
FactCheck
        ↓
Brief
        ↓
Proof / Finalize
```

同时让以下六者共享同一套 Contract：

```text
Generation Trace
Replay
Regression Corpus
Golden Journey
Real Device
CI Stability Gate
```

---

# 3. 第二期执行总原则

## 3.1 第一阶段成果保护区

原则上禁止重写：

- `generationFingerprint` 核心语义；
- Frozen Envelope 持久化机制；
- Resume fail-closed；
- 当前弹性预算纯函数核心；
- 当前 V3 Budget 数学；
- Continuation V5 核心生成算法；
- Story Memory 核心算法；
- 已有 Golden Journey 断言；
- 已有 Replay 指纹校验。

允许：

```text
扩展 Contract
抽离阶段
增加 Adapter
补充 Trace
补充 Replay
补充 Gate
```

## 3.2 所有结构迁移必须 Golden Diff

每迁移一层：

```text
Old Output
vs
New Output
```

必须证明：

```text
same candidates
same selected set
same allocations
same rendered text
same diagnostics
same fingerprint
```

若预期行为改变，必须先有：

```text
Red reproduction
Expected semantic change
Regression test
```

## 3.3 每阶段独立提交

禁止一次性大改几百个文件。

推荐每个 Phase：

```text
1~3 个结构性 commit
1 个 test commit
1 个 docs evidence commit
```

---

# 4. Phase 0：Baseline 与第二期基线冻结

任何修改前执行：

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git fetch origin
git rev-parse origin/main
git log --oneline -20
```

若存在用户未提交修改：

```text
必须保护
不得 reset
不得 clean
不得覆盖
```

重新运行：

```bash
npm run verify:version
npm run lint
npm run typecheck
npm run test:ci
```

并单独验证：

```text
Golden Journey
Replay Harness
FrozenGenerationContext
GenerationTrace
Phase3 fail-closed
```

输出：

```text
Second Phase Baseline Report
```

**Gate P0-0：** 基线全绿且工作区边界清晰后才允许开始重构。

---

# 5. Phase 1：真正完成 Context Builder 六阶段拆分

这是第二期最高优先级。

## 5.1 推荐目录

```text
src/services/context/generation/
    collectGenerationMaterials.ts
    normalizeGenerationMaterials.ts
    buildGenerationContextPlan.ts
    allocateGenerationContextBudget.ts
    renderGenerationContext.ts
    freezeGenerationContext.ts
    generationContracts.ts
    generationDiagnostics.ts
```

不强制完全按目录命名，但职责必须真正分开。

## 5.2 Collect

新增真实：

```ts
collectGenerationMaterials(...)
```

输出：

```ts
CollectedGenerationMaterials
```

只负责 IO / Source Capture：

- project；
- current chapter；
- previous chapters；
- outline；
- characters；
- worldbook；
- notes；
- note config；
- Story Memory；
- Episodic Memory raw candidates；
- Writer Style；
- Preset；
- Context Config；
- Context Auto policy；
- LLM config / context window。

Collect 禁止：

- 做最终预算；
- 做最终裁剪；
- 拼 final messages；
- 决定最终 selected；
- 修改 Pipeline 状态。

## 5.3 Normalize

新增：

```ts
normalizeGenerationMaterials(...)
```

输出：

```ts
NormalizedGenerationMaterials
```

统一：

- source type；
- source ID；
- revision/hash；
- empty filtering；
- duplicates；
- chapter position；
- future source guard；
- note mode；
- Story Memory eligibility；
- Writer Style validity；
- explicit / automatic source marker。

要求尽量保持纯函数。

## 5.4 Plan

新增：

```ts
buildGenerationContextPlan(...)
```

输出：

```ts
GenerationContextPlan
```

至少包含：

```text
candidateId
sourceType
sourceId
selected
selectedReason
rejectedReason
requirement
relevance
priority
selectionBoost
demandTokens
minTokens
targetTokens
maxTokens
```

Plan 不做最终 text clipping。

## 5.5 Allocate

新增统一 Adapter：

```ts
allocateGenerationContextBudget(...)
```

内部可以继续适配：

- legacy fixed budget；
- elastic budget；
- V3 hierarchical budget。

但上层只能看到统一：

```ts
GenerationBudgetAllocation
```

输出至少：

```text
candidateId
requestedTokens
allocatedTokens
allocationReason
waterLevel
clippedByBudget
```

**不要重写 `allocateDemandsWithinCapacity` 数学核心。**

目标是：

> 统一入口，不统一底层算法实现。

## 5.6 Render

新增：

```ts
renderGenerationContext(...)
```

输入只能是：

```text
Normalized Materials
+
Plan
+
Allocation
```

不得重新：

- 读 DB；
- 算 relevance；
- 决定 selected；
- 改 requirement；
- 解释 Context Auto；
- 做第二套 allocation。

输出：

```ts
RenderedGenerationContext
```

每项至少：

```text
candidateId
requestedTokens
allocatedTokens
actualTokens
clipped
clippingReason
renderedHash
```

## 5.7 Freeze

新增：

```ts
freezeGenerationContext(...)
```

负责最终一致性：

```text
Candidate Contract
Budget Contract
Rendered Contract
Messages
Diagnostics
Fingerprint
```

Freeze 前必须校验：

```text
sum(actualTokens) <= hardInputLimit
mandatory contract intact
future source leakage = 0
future plan leakage = 0
message payload matches rendered context
fingerprint generated
```

## Gate P1-1

只有同时满足：

```text
Collect 真迁出
Normalize 真迁出
Plan 真迁出
Allocate 统一入口
Render 真迁出
Freeze 真迁出
```

才允许关闭 Phase 1。

**仅增加命名、wrapper 或 stopwatch 不算完成。**

---

# 6. Phase 2：FrozenGenerationContext V2 / 完整 Candidate Contract

如果持久化结构变化明显，推荐新增：

```ts
FrozenGenerationContextV2
```

不要偷偷改变 V1 含义。

## 6.1 Candidate Contract

```ts
interface FrozenContextCandidateV1 {
  candidateId: string;

  sourceType:
    | 'chapter'
    | 'outline'
    | 'character'
    | 'worldbook'
    | 'note'
    | 'story_memory'
    | 'episodic_memory'
    | 'writer_style'
    | 'canon'
    | 'preset'
    | 'other';

  sourceId: string | number | null;
  sourceRevision: string | null;
  contentHash: string;

  activation:
    | 'explicit'
    | 'automatic'
    | 'mandatory'
    | 'system';

  selected: boolean;
  selectedReason: string | null;
  rejectedReason: string | null;

  requirement: 'mandatory' | 'preferred' | 'optional';

  relevance: number | null;
  priority: number | null;
  selectionBoost: number | null;

  demandTokens: number;
}
```

## 6.2 Budget Contract

```ts
interface FrozenBudgetItem {
  candidateId: string;

  demandTokens: number;
  minTokens: number;
  targetTokens: number;
  maxTokens: number;

  allocatedTokens: number;

  allocationReason: string;
  waterLevel: 'mandatory' | 'soft' | 'burst' | 'hard' | 'none';

  budgetClipped: boolean;
}
```

## 6.3 Render Contract

```ts
interface FrozenRenderedContextItem {
  candidateId: string;
  allocatedTokens: number;
  actualTokens: number;

  included: boolean;

  clipped: boolean;
  clippingReason: string | null;

  renderedHash: string;
}
```

## 6.4 Snapshot 必须能回答

对任意 Candidate：

```text
有没有读取？
有没有激活？
有没有 selected？
为什么 selected？
为什么 rejected？
申请多少 token？
实际拿到多少？
最终使用多少？
有没有裁剪？
为什么裁剪？
```

## Gate P1-2

新增测试：

```text
candidate selection round-trip
budget round-trip
render round-trip
snapshot fingerprint includes candidate semantics
snapshot tamper fail-closed
historical V1 compatibility
```

---

# 7. Phase 3：Generation Trace V2 —— 决策级可解释

当前 `selectedCount = null` 必须结束。

建议新增：

```ts
GenerationTraceV2
```

包含：

```text
generationTraceId
identity
settings
candidateSummary
budgetSummary
candidates[]
modules[]
diagnostics[]
stageTimings[]
overallStatus
```

## 7.1 Candidate Trace 示例

```json
{
  "candidateId": "character:18",
  "sourceType": "character",
  "selected": false,
  "reason": "relevance_below_threshold",
  "demandTokens": 1800,
  "allocatedTokens": 0,
  "actualTokens": 0
}
```

## 7.2 统一故障定位枚举

未来出现“人物资料没生效”，Trace 必须能区分：

```text
not_collected
not_activated
not_selected
budget_zero
render_zero
snapshot_missing
pipeline_consume_error
```

## Gate P1-3

选 10 条 Golden Journey 保存 Trace Snapshot，断言：

```text
selectedCount != null
candidate reason complete
module allocation complete
clipping reason complete
```

---

# 8. Phase 4：Replay Harness V2 —— Decision Replay

第二期 Replay 的核心目标：

> **可重放“为什么形成这个 Snapshot”，而不只是重新计算 Hash。**

## 8.1 Replay Fixture

建议：

```ts
GenerationReplayFixtureV2
```

至少包含：

```text
project fixture
chapter fixture
outline fixture
resource fixture
story-memory fixture
context config
preset
writer style
model config
policy
expected frozen snapshot
```

LLM 继续 Stub。

## 8.2 Replay Pipeline

真正执行：

```text
Fixture
↓
Collect
↓
Normalize
↓
Plan
↓
Allocate
↓
Render
↓
Freeze
↓
Compare Expected
```

比较：

```text
Candidate Set
Selected Set
Selection Reasons
Budget Allocation
Rendered Hashes
Final Fingerprint
Diagnostics
```

## 8.3 Replay Diff

失败必须返回结构化差异：

```text
candidate mismatch
selection mismatch
allocation mismatch
render mismatch
fingerprint mismatch
```

不能只返回：

```text
hash different
```

## Gate P1-4

同一 fixture 连续 10 次：

```text
candidate identical
selected identical
allocation identical
render identical
fingerprint identical
```

至少支持：

```text
REG-001
GJ-07 Writer Style
Note None
Story Memory Dirty
1M Context
```

---

# 9. Phase 5：Continuation 接入统一 Generation Trace

**不重写 Continuation V5。只做 Observability Adapter。**

## 9.1 Trace Identity

Continuation run 启动时创建：

```text
generationTraceId
```

同一个 run：

```text
queued
running
awaiting_user
interrupted
resume
completed
```

必须复用同一 ID。

## 9.2 N 章 Lineage

一键 N 章建议：

```text
batchTraceId
    ↓
generationTraceId chapter 1
generationTraceId chapter 2
generationTraceId chapter 3
```

每章必须独立 fingerprint。

## 9.3 Continuation Trace 最低覆盖

```text
source snapshot
canon
tail
current instruction
budget
LLM request identity
eligibility
adoption
finalization
state gate
```

## Gate P2-1

覆盖：

```text
Continuation single chapter
Continuation interrupted/resume
Continuation N=3
future source leakage = 0
future plan leakage = 0
trace ID stable
chapter fingerprint independent
```

---

# 10. Phase 6：Silent Fallback 二次审计

第一期已审计一次，第二期在拆 Builder 后必须重新扫描 Generation 语义链：

```text
catch
return []
return 0
return ''
return null
best effort
fallback
ignore
```

只处理 Generation Semantic Path，不做全项目 warning cleanup。

每个 fallback 分类：

```text
SAFE_NON_SEMANTIC
DIAGNOSTIC_REQUIRED
BLOCKING_REQUIRED
LEGACY_ONLY
```

输出：

```text
Second Phase Silent Fallback Audit
```

**Gate P1-5：**

```text
Unclassified semantic fallback = 0
```

---

# 11. Phase 7：Golden Journey V2

第一期 20 条全部保留。

第二期重点是升级断言，不是单纯增加数量。

原来只断言：

```text
noteText empty
fingerprint stable
```

升级为：

```text
Candidate
Selection
Reason
Allocation
Rendered
Fingerprint
Diagnostic
```

## 新增建议场景

### GJ-21

同资料、同设置、同输入连续 Freeze 两次：

```text
semantic contract identical
```

### GJ-22

新增未激活低相关世界观：

```text
mandatory allocation unchanged
```

### GJ-23

Context Window 64K → 128K：

```text
mandatory selected set unchanged
```

### GJ-24

128K → 1M：

```text
sliding window bounded
```

### GJ-25

某 optional resource 内容翻倍：

```text
不得挤掉 mandatory
```

### GJ-26

Freeze 后修改 Writer Style：

```text
resume 使用 old frozen style
new generation 使用 new style
```

### GJ-27

Freeze 后删除 worldbook：

```text
resume 不漂移
new generation 反映删除
```

### GJ-28

Continuation N=3：

```text
fingerprint 独立
future leakage = 0
trace lineage 正确
```

---

# 12. Phase 8：完整 Real Device Stability Matrix

这是第二期封版前的核心业务门禁。

## Device Matrix A：Outline

- RD-01 普通大纲单章；
- RD-02 人物 + 世界观 + Note；
- RD-03 Story Memory ready；
- RD-04 Story Memory dirty；
- RD-05 Writer Style enabled；
- RD-06 Context Auto；
- RD-07 Manual Context。

## Device Matrix B：Budget

- RD-08 64K；
- RD-09 128K；
- RD-10 1M Provider；
- RD-11 Soft 80% 附近；
- RD-12 Burst 95% 附近；
- RD-13 Mandatory Hard Overflow。

RD-13 强制：

```text
必须显式 Block
不得静默裁 Mandatory
```

## Device Matrix C：Continuation

- RD-14 Continuation 单章；
- RD-15 Continuation N=3；
- RD-16 Continuation Kill / Resume；
- RD-17 soft warning / rejected / awaiting regeneration。

## Device Matrix D：Freeze / Resume

- RD-18 Draft 中 Kill；
- RD-19 Review 中 Kill；
- RD-20 Freeze 后修改 DB 再 Resume。

要求：

```text
fingerprint unchanged
shared facts unchanged
```

## 每个 Case 必须取证

至少记录：

```text
generationTraceId
generationFingerprint
candidateCount
selectedCount
budget summary
diagnostics
task final state
fatal log scan
```

## Gate P1-6

```text
20/20 Real Device Matrix PASS
Fatal = 0
Silent Context Loss = 0
Fingerprint Drift = 0
Unexpected Live DB Re-read = 0
```

---

# 13. Phase 9：独立 Generation Stability CI

在 GitHub Actions 增加独立 Job：

```yaml
generation-stability:
  name: Generation Stability
```

至少运行：

```text
FrozenGenerationContext contract
GenerationTrace V2
GenerationStage contracts
Replay V2
Regression Corpus
Golden Journey
Continuation trace
Budget property tests
Resume/fingerprint
Future leakage
Silent fallback classification
```

CI 原则：

```text
独立显示
独立失败
不可被普通 Jest summary 淹没
```

禁止：

```text
continue-on-error
|| true
allowFailure
```

---

# 14. Phase 10：最终架构独立审计

## Q1

`contextBuilder` 是否仍直接承担多数 Collect / Plan / Render 逻辑？

若是：

```text
NO-GO
```

## Q2

新 Generation 主链是否仍存在多个业务层直接调用 Budget 分配器的旁路？

若是：

```text
NO-GO
```

## Q3

Renderer 是否重新 select / rank / read DB / allocate？

若是：

```text
NO-GO
```

## Q4

Frozen Snapshot 是否能完整解释 Candidate？

如果仍：

```text
selectedCount = null
```

或资料没有 reason：

```text
NO-GO
```

## Q5

Replay 是否仍只重算 Hash？

如果不能重跑：

```text
Candidate → Plan → Budget → Render
```

则：

```text
NO-GO
```

## Q6

Continuation 是否仍使用完全独立 Trace Identity？

若无统一 lineage：

```text
NO-GO
```

## Q7

是否仍有未分类 semantic silent fallback？

若有：

```text
NO-GO
```

## Q8

Real Device Matrix 是否真实完成，而不是仅以 Jest 替代？

若否：

```text
NO-GO
```

## Q9

Generation Stability Job 是否存在且全绿？

若否：

```text
NO-GO
```

---

# 15. Regression Corpus 第二期扩展

至少新增：

```text
REG-002-writer-style-fingerprint
REG-003-selected-resource-budget-zero
REG-004-story-memory-dirty-not-injected
REG-005-note-none-no-candidate
REG-006-1m-window-bounded-sliding
REG-007-resume-after-db-change
REG-008-continuation-trace-resume
REG-009-render-allocation-drift
REG-010-mandatory-overflow-block
```

真实发现新 BUG 时继续追加。

所有新 REG 必须保留：

```text
原始现象
最小复现
Root Cause
Red Test
Fix
Green Evidence
```

---

# 16. 性能门禁

拆阶段不能引入新的性能问题。

记录：

```text
collect duration
normalize duration
plan duration
allocate duration
render duration
freeze duration
DB query count
candidate count
selected count
render token count
```

建立三档基线：

```text
Small Project
50 chapters / small resources

Medium Project
200 chapters / medium resources

Large Project
500+ chapters / large resources
```

重点防止：

```text
重复 DB 查询
N+1 query
candidate 重复 hash
重复 token estimate
相同 Story Memory 重复解析
```

---

# 17. Commit 建议顺序

```text
refactor(context): extract collect generation materials
refactor(context): extract normalize generation materials
refactor(context): extract generation context plan
refactor(context): unify generation budget adapter
refactor(context): isolate generation renderer
refactor(context): isolate generation freeze
feat(context): add frozen context candidate contract v2
feat(trace): add decision-level generation trace v2
feat(replay): add decision replay pipeline
feat(continuation): unify generation trace identity
fix(context): close second-pass silent fallbacks
test(generation): strengthen golden journey decision assertions
test(generation): expand regression corpus
docs(stability): record phase-2 device matrix
ci(stability): add generation stability gate
docs(stability): record phase-2 final seal
```

每个 commit 必须：

```text
targeted test green
diff boundary reviewed
no unrelated files
```

---

# 18. Agent 自主执行规则

## 18.1 可自主处理

如果出现：

```text
当前 Phase 范围内的类型错误
当前 Phase 范围内的测试回归
当前 Phase 范围内的 contract mismatch
当前 Phase 范围内的 CI failure
```

Agent 应：

```text
自行定位
自行修复
自行重测
继续推进
```

不需要逐步向用户确认。

## 18.2 不得自主扩大范围

如果发现：

- Story Memory 算法需要重写；
- Continuation 核心生成逻辑需要重写；
- Budget 数学需要大改；
- Schema 需要大规模迁移；
- Provider 层有独立问题；
- UI 需要大规模改版；

必须：

```text
记录 Out-of-Scope
评估 P0/P1/P2
若阻塞当前 Gate → NO-GO
不得顺手扩大重构
```

---

# 19. Git 安全规则

绝对禁止：

```bash
git reset --hard
git clean -fd
git push --force
```

如果存在用户工作区改动，也禁止：

```bash
git add .
```

必须：

```text
明确 stage 文件
检查 diff
保护现有修改
```

---

# 20. GitHub Actions 规则

每个主要 Phase Push 后：

```text
重新获取 remote HEAD
确认 Actions Run 对应当前 SHA
```

最终必须：

```text
JavaScript validation = SUCCESS
Android Debug build = SUCCESS
Migration matrix = SUCCESS
Generation Stability = SUCCESS
```

并确认：

```text
lint 实际执行
typecheck 实际执行
Jest 实际执行
Stability 实际执行
```

核心 Gate 不得 skipped。

---

# 21. Phase Report 模板

```md
# Stability Phase II / Phase N Report

## Baseline
Local HEAD:
origin/main:
Worktree:

## Scope
Allowed:
Forbidden:

## Changes
1.
2.
3.

## Golden Diff
Candidate:
Selection:
Budget:
Render:
Fingerprint:

## Tests
Targeted:
Contract:
Regression:
Golden Journey:
Replay:
TypeScript:
Lint:
Jest:
Android:
Migration:

## Trace Evidence
generationTraceId:
generationFingerprint:
selectedCount:
diagnostics:

## New Defects
P0:
P1:
P2:

## Remaining NO-GO
1.
2.

## GitHub Actions
Run ID:
JS:
Android:
Migration:
Stability:

## Decision
GO / NO-GO
```

---

# 22. Final Stability Seal Report 模板

```md
# Stability Architecture Phase II Final Seal

## Baseline
Local:
origin/main:
Previous Stable HEAD:

## Final
Final HEAD:
Version:
Commit:
GitHub Actions Run:

## Phase Completion
Phase 0:
Phase 1:
Phase 2:
Phase 3:
Phase 4:
Phase 5:
Phase 6:
Phase 7:
Phase 8:
Phase 9:
Phase 10:

## Context Architecture
Collect extracted:
Normalize extracted:
Plan extracted:
Allocate unified:
Render isolated:
Freeze isolated:

## Frozen Contract
Candidate contract:
Budget contract:
Render contract:
Fingerprint:

## Trace
Outline:
Continuation:
Batch:
Decision reasons:

## Replay
Candidate replay:
Selection replay:
Budget replay:
Render replay:
Determinism x10:

## Golden Journey
V1 20:
V2 additional:
Total:

## Regression Corpus
REG count:
New regression cases:

## Real Device
Outline:
Budget:
Continuation:
Resume:
Fatal:
Fingerprint drift:

## CI
JS:
Android:
Migration:
Generation Stability:

## Defects
New P0:
New P1:
New P2:
Remaining NO-GO:

## Final Decision
STABILITY ARCHITECTURE — GO / SEALED
```

---

# 23. 最终 Seal 强制条件

## 架构

- [ ] Collect 真正从 Builder 迁出；
- [ ] Normalize 真正从 Builder 迁出；
- [ ] Plan 真正从 Builder 迁出；
- [ ] Budget 经统一 Generation Adapter；
- [ ] Render 不重新决策；
- [ ] Freeze 为单一最终事实源；
- [ ] 新主链无 Legacy live-DB 旁路。

## Frozen Contract

- [ ] candidates[] 完整；
- [ ] selected 可解释；
- [ ] rejected 可解释；
- [ ] demand 可解释；
- [ ] allocation 可解释；
- [ ] render 可解释；
- [ ] clipping 可解释；
- [ ] fingerprint 覆盖全部关键语义。

## Trace

- [ ] Outline 有 generationTraceId；
- [ ] Continuation 有 generationTraceId；
- [ ] Batch 有 lineage；
- [ ] selectedCount 不再是 null；
- [ ] 资料原因可查询；
- [ ] Budget reason 可查询；
- [ ] diagnostic 可查询。

## Replay

- [ ] Candidate 可重放；
- [ ] Selection 可重放；
- [ ] Budget 可重放；
- [ ] Render 可重放；
- [ ] Fingerprint 可重放；
- [ ] x10 deterministic。

## Regression

- [ ] 第一阶段 20 Golden Journey 全绿；
- [ ] 第二阶段扩展 Journey 全绿；
- [ ] Regression Corpus 扩展；
- [ ] 所有本轮真实 BUG 先 Red 后 Green。

## Real Device

- [ ] Outline；
- [ ] Context Auto；
- [ ] Story Memory；
- [ ] Writer Style；
- [ ] Large Resources；
- [ ] 64K；
- [ ] 128K；
- [ ] 1M；
- [ ] 80%；
- [ ] 95%；
- [ ] Hard Overflow；
- [ ] Continuation；
- [ ] Continuation N；
- [ ] Kill / Resume；
- [ ] Freeze 后 DB 变化。

## CI

- [ ] JS green；
- [ ] Android green；
- [ ] Migration green；
- [ ] Generation Stability green。

## 缺陷

```text
New P0 = 0
New P1 = 0
Remaining Stability NO-GO = 0
```

最终才允许：

```text
STABILITY ARCHITECTURE — GO / SEALED
```

---

# 24. 本期最重要的执行顺序

严格按：

```text
Baseline
↓
Builder 真拆分
↓
Candidate Contract
↓
Trace V2
↓
Replay V2
↓
Continuation Trace
↓
Silent Fallback 二次审计
↓
Golden Journey V2
↓
Real Device Matrix
↓
Generation Stability CI
↓
Independent Audit
↓
Seal
```

禁止倒序。

特别禁止：

```text
先改 CI
先写 Seal
先补文档
```

然后把未完成架构标记完成。

---

# 25. 第二期完成后的预期变化

第一期已经解决：

```text
Freeze 漂移
Resume 漂移
Snapshot 损坏静默重建
基础 Trace 缺失
基础 Replay 缺失
```

第二期完成后，应进一步解决：

```text
为什么资料没进上下文？
为什么某项资料被 Budget 放弃？
为什么同一设置 allocation 不同？
到底哪个阶段改变了结果？
Continuation 和 Outline 为什么不好统一排障？
实际设备与 Jest 为什么表现不一致？
```

最终故障定位流程应变成：

```text
Trace 定位
→ Replay 复现
→ Regression 固化
→ 最小修复
```

而不是：

```text
找代码猜原因
```

---

# 26. 最终结论

第一期已经提供了足够安全的：

```text
Trace
Freeze
Fingerprint
Golden Journey
Replay Foundation
Regression Foundation
```

因此第二期最重要的原则不是“大改”，而是：

> **利用第一期建立的安全网，把原本为了降低风险只做到 Layer 1 的结构性治理真正收口，并把资料选择、预算分配、渲染结果全部纳入可解释、可重放、可真机验证的统一契约。**

完成后，才允许正式定义：

```text
STABILITY ARCHITECTURE
GO / SEALED
```
