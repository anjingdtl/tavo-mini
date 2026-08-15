# ShineWriter / tavo-mini 写作链路稳定性治理方案
## —— 写作、资料、上下文与弹性预算的系统性收束改造

**适用项目：** `anjingdtl/tavo-mini`  
**治理范围：** 写作主链、资料检索、Story Memory、Writer Style、Context Auto、上下文拼装、弹性预算、Pipeline 消费、Resume / Cold Start  
**治理目标：** 从“持续修小 BUG”转向“统一契约、单一事实源、可解释、可回放、可持续防回归”的稳定性工程体系。  
**执行原则：** 分阶段 PDCA、小步提交、阶段门禁，禁止一次性大爆改。

---

# 0. 背景与核心判断

当前项目已经具备较完整的单元测试、类型检查、Android 构建和 CI 验证能力，但在真实使用中，仍会在以下环节反复出现小 BUG：

- 写作入口与实际 Pipeline 参数不一致；
- 资料已配置但未进入最终上下文；
- Context Auto、手动资料、Writer Style、Story Memory 之间相互覆盖或失效；
- 弹性预算在不同模式、模型窗口、资料规模下表现不一致；
- 某阶段重新读取数据库后，与生成开始时的状态发生漂移；
- Resume / Cold Start 后恢复出的上下文与原请求不完全一致；
- 某模块异常时被静默降级为空内容，但系统仍继续生成；
- 单模块测试全绿，跨模块组合后仍出现问题；
- 修复 A 后，在另一写作模式或预算组合中出现 B。

这说明当前主要矛盾已经不是“某一个函数写错”，而是：

> **写作、资料、上下文、预算与 Pipeline 之间缺少唯一、冻结、可追踪的跨模块契约。**

因此，本轮不重写弹性预算数学核心，也不继续堆零散 if / fallback，而是建立一条稳定的 Generation Context 主链。

---

# 1. 总体目标

最终形成：

```text
用户发起生成
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
Draft
    ↓
Review
    ↓
Fact Check
    ↓
Proof
    ↓
Finalize
```

**Freeze 之后，任何下游阶段原则上不得重新读取会改变本次生成语义的业务状态。**

最终达到：

1. 一次生成只有一个事实源；
2. 同一请求可稳定重放；
3. 每项资料为什么进入/未进入上下文可解释；
4. 每一 Token 预算为什么如此分配可解释；
5. Resume / Cold Start 不改变本次请求语义；
6. 模块失败不能静默伪装为正常；
7. 真实 BUG 可沉淀成永久回归资产；
8. 旧任务兼容逻辑不再污染新任务主链。

---

# 2. 本轮明确不做

本轮属于 **Stability Architecture / 稳定性治理**，不是功能升级。

原则上禁止：

- 重写当前弹性预算数学核心；
- 无证据调整现有 80% / 95% / Hard Limit 逻辑；
- 大规模重构无关模块；
- 顺手重写 Story Memory；
- 顺手重做 Continuation V5；
- 无必要升级 Schema；
- 清理全项目 warning；
- 修改无关 UI；
- 修改模型 Provider；
- 修改 Prompt 文风；
- 改变大纲、续写等业务能力定义；
- 通过弱化测试、删除断言、eslint ignore、`|| true` 等方式制造假绿。

第一原则：

> **先稳定语义，再优化实现。**

---

# 3. P0：建立 Generation Context 单一事实源

建议新增版本化冻结对象：

```ts
FrozenGenerationContextV1
```

至少包含：

```ts
interface FrozenGenerationContextV1 {
  version: 1;

  identity: {
    generationId: string;
    projectId: number;
    chapterId: number;
    chapterPosition: number;
    writingMode: string;
    workflowVersion: string;
    createdAt: number;
  };

  sourceSnapshot: {
    projectRevision?: string;
    chapterRevision?: string;
    sourceRevision?: string;
    canonRevision?: string;
    storyMemoryFingerprint?: string;
  };

  resolvedSettings: {
    modelId: string;
    contextWindow: number;
    reservedOutputTokens: number;
    safetyMargin: number;
    presetId: number | null;
    writerStyleId?: number | null;
    noteMode?: string;
    contextStrategy?: string;
    contextBudgetVersion: number;
    elasticBudgetEnabled: boolean;
  };

  candidates: FrozenContextCandidate[];
  budgetPlan: FrozenBudgetPlan;
  renderedContext: FrozenRenderedContext[];
  messages: ChatMessage[];
  estimatedInputTokens: number;
  diagnostics: GenerationDiagnostic[];
  generationFingerprint: string;
}
```

候选资料建议统一：

```ts
interface FrozenContextCandidate {
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
    | 'other';

  sourceId?: string | number;
  sourceRevision?: string;
  contentHash: string;

  selected: boolean;
  selectedReason: string;

  requirement: 'mandatory' | 'preferred' | 'optional';
  relevance: number;
  demandTokens: number;
}
```

## Snapshot 必须能回答

- 当时是哪个项目、哪一章？
- 什么写作模式？
- 使用哪个模型、Context Window、Output Reserve、Safety Margin？
- 使用哪个 Preset、Writer Style、Note Mode、Context Policy？
- Story Memory 当时什么状态？
- 找到了哪些资料？
- 哪些资料被选中？
- 哪些资料因预算被排除？
- 哪些资料被裁剪？
- 各模块申请多少 Token、最终获得多少？
- 最终发送给 LLM 的 messages 是什么？
- 是否发生降级？
- Freeze 时的数据指纹是什么？

回答不了，说明 Snapshot 还不完整。

---

# 4. P0：Context Builder 收束成六阶段

目标结构：

```text
collectGenerationMaterials()
        ↓
normalizeGenerationMaterials()
        ↓
buildGenerationContextPlan()
        ↓
allocateGenerationContextBudget()
        ↓
renderGenerationContext()
        ↓
freezeGenerationContext()
```

## 4.1 Collect：唯一允许大量 IO 的阶段

负责读取：

- 当前章节；
- 前文；
- 大纲；
- 人物；
- 世界观；
- 笔记；
- Story Memory；
- Episodic Memory；
- Writer Style；
- Preset；
- Context Auto 配置；
- 模型窗口参数。

输出：

```ts
CollectedGenerationMaterials
```

要求：

- 不做预算；
- 不做最终裁剪；
- 不直接生成最终 messages；
- 所有来源保留 `sourceId / revision / hash`。

## 4.2 Normalize：统一语义

负责：

- 去重；
- 删除非法空项；
- 统一 source 类型；
- 统一 priority / relevance；
- 统一 requirement；
- 区分显式选择与自动激活；
- 校验未来章节污染；
- 校验 Story Memory checkpoint；
- 校验 Writer Style；
- 校验章节位置。

输出：

```ts
NormalizedContextCandidate[]
```

尽量保持纯函数。

## 4.3 Plan：只描述需求

生成：

```ts
GenerationContextDemandPlan
```

包含：

- mandatory / preferred / optional；
- demandTokens；
- min / target / max；
- priority；
- relevance；
- selectionBoost；
- selectedReason。

**Plan 不负责裁剪文本。**

## 4.4 Allocate：预算唯一入口

预算核心只接受 Demand Plan，输出：

```ts
GenerationBudgetAllocation
```

要求：

- 所有预算分配只在这里发生；
- Renderer 不再私自二次预算；
- 各模块不得自己扣 Context Window；
- Review / FactCheck 不得重新分配本轮基础上下文。

当前弹性预算与 V3 数学逻辑优先保留，通过 Adapter 收口。

## 4.5 Render：严格按 Allocation 渲染

Renderer 不得：

- 重新决定选不选；
- 重新算 priority；
- 重新读数据库；
- 偷偷增加资料；
- 删除 mandatory；
- 重新解释 Context Auto。

仅执行：

```text
Candidate + Allocation → Rendered Text
```

并记录：

- requestedTokens；
- allocatedTokens；
- actualTokens；
- clipped；
- clippingReason。

## 4.6 Freeze：最终一致性验证

Freeze 前至少检查：

```text
sum(actualTokens) <= HardInputLimit
mandatory contract intact
future source leakage = 0
future plan leakage = 0
message payload matches rendered context
generationFingerprint generated
```

Freeze 成功后，下游只消费 Frozen Snapshot。

---

# 5. P0：禁止 Pipeline 下游重新解释上下文

Draft 之后不得：

- 再读资料库得到不同结果；
- 再计算 Writer Style；
- 再取新的 Story Memory；
- 再执行 Context Auto；
- 再按实时 DB 解释 Note；
- 再按新模型配置重算本次 Context Window；
- 再生成与 Draft 不同的共享事实集。

下游可以追加：

- Draft 正文；
- Review Prompt；
- Fact Check Prompt；
- Proof Prompt；
- 阶段特有临时指令。

但共享事实和基础上下文必须来自：

```ts
FrozenGenerationContext
```

---

# 6. P0：建立统一 Generation Trace

每次真正发起生成，创建：

```text
generationTraceId
```

贯穿：

```text
UI
→ Generation Request
→ Collect
→ Normalize
→ Plan
→ Allocate
→ Render
→ Freeze
→ Draft
→ Review
→ Fact Check
→ Proof
→ Finalize
```

最低应记录：

```json
{
  "generationTraceId": "...",
  "projectId": 1,
  "chapterId": 23,
  "writingMode": "outline",
  "modelId": "...",
  "contextWindow": 65536,
  "reservedOutputTokens": 8000,
  "safetyMargin": 4000,
  "candidateCount": 18,
  "selectedCount": 12,
  "budget": {
    "hardInputLimit": 53536,
    "softInputLimit": 42828,
    "burstInputLimit": 50859,
    "finalEstimatedInputTokens": 42100
  },
  "modules": [],
  "diagnostics": []
}
```

以后出现“第 23 章人物资料没生效”，定位必须按：

```text
未读取
→ Candidate 未激活
→ Budget=0
→ Render 丢失
→ Snapshot 不一致
→ Pipeline 未消费
```

而不是凭经验猜。

---

# 7. P0：建立 Replay Harness

新增：

```text
Generation Replay Harness
```

目标：

> 保存一次真实 Snapshot / Trace 后，可在测试环境稳定重放。

建议保存脱敏后的：

- SQLite fixture；
- FrozenGenerationContext；
- Trace；
- 模型响应 Stub；
- 预期最终行为。

同一输入必须满足：

```text
same candidate selection
same budget allocation
same rendered context
same generation fingerprint
```

在线 LLM 不作为 Replay 必需条件，可使用固定 Stub。

---

# 8. P0：建立 Golden Journey

不要再以“Jest 数量增加多少”作为主要稳定性指标。

建议首批固定约 20 条：

1. 基础大纲写作；
2. 大纲 + 人物 + 世界观；
3. 大纲 + 笔记；
4. Note = none；
5. Story Memory ready；
6. Story Memory dirty；
7. Writer Style enabled；
8. Preset 切换；
9. Context Auto；
10. 手动 Context；
11. 64K Context Window；
12. 128K / 大窗口；
13. 1M Provider / 超大上下文；
14. Mandatory 接近 Hard Limit；
15. Soft 超 80%；
16. 接近 95%；
17. Continuation 单章；
18. Continuation 一键 N 章；
19. 生成途中 Kill → Cold Start → Resume；
20. Freeze 后 DB 数据发生变化再 Resume。

关键断言：

```text
Note none → note candidate=0
Story Memory dirty → 不注入脏 checkpoint
Writer Style → snapshot 冻结
1M Context → 不因窗口巨大而无界吞入全部资料
Continuation N → 每章独立 Snapshot，未来计划/来源泄漏=0
Resume → generationFingerprint 不变
```

---

# 9. P1：消灭静默降级

必须审计影响 Generation 语义的：

```ts
catch { return []; }
catch { return 0; }
catch { return ''; }
```

不是所有异常都阻断，但必须留下结构化状态。

统一：

```ts
type GenerationDiagnosticSeverity =
  | 'info'
  | 'warning'
  | 'error'
  | 'blocking';
```

总体状态：

```text
OK
DEGRADED
BLOCKED
```

示例：

```text
RESOURCE_RETRIEVAL_FAILED → DEGRADED
STORY_MEMORY_CHECKPOINT_DIRTY → DEGRADED
ACTIVE_WRITER_STYLE_MISSING → 按现有契约 DEGRADED 或 BLOCKED
BUDGET_MANDATORY_OVERFLOW → BLOCKED
```

尤其禁止把：

```text
真实 demand = 0
```

和：

```text
异常导致 demand 无法测量
```

都表现为 `demandTokens = 0`。

---

# 10. P1：Legacy 退出主链

长期结构应为：

```text
Legacy persisted task
        ↓
Compatibility Adapter
        ↓
Current Internal Contract
        ↓
Current Main Pipeline
```

而不是让 Context Builder 内部长期存在大量：

```text
V1 / V2 / V3 / old task / old note / old writer style / new path
```

兼容旧数据可以保留，但兼容逻辑应停留在系统边缘。

新任务只生成当前版本 Snapshot。

---

# 11. P1：数据契约版本化

以下对象都必须有明确 `version`：

- FrozenGenerationContext；
- Resource Candidate；
- Budget Plan；
- Generation Trace；
- Persisted Pipeline Snapshot。

未来升级通过：

```text
V1 → Adapter → Current Model
```

禁止长期靠“字段存在不存在”猜版本。

---

# 12. P1：Generation Fingerprint

Freeze 后计算：

```text
generationFingerprint
```

建议覆盖：

- chapter identity；
- source hashes；
- preset；
- writer style；
- story memory；
- context policy；
- budget plan；
- rendered context；
- model window；
- reserved output。

用途：

### Resume

```text
stored fingerprint == restored fingerprint
```

### Replay

确认真正同输入。

### Debug

区分：

```text
数据变了
```

与：

```text
同一数据算法不稳定
```

---

# 13. P1：Context Preview 必须展示真实 Snapshot

Context Preview 不应重新计算一遍“猜测上下文”。

优先展示：

```text
FrozenGenerationContext
```

至少显示：

- 实际资料；
- 实际 Token；
- 实际裁剪；
- 实际预算；
- 实际 Story Memory；
- 实际 Writer Style；
- 实际 diagnostics。

生成前预览可以使用 Prepared Preview Snapshot，但必须明确标记 `PREVIEW`，不得和真实执行结果混淆。

---

# 14. P1：错误码统一

建立错误域：

```text
GENERATION_CONTEXT_*
RESOURCE_*
STORY_MEMORY_*
BUDGET_*
SNAPSHOT_*
PIPELINE_*
RESUME_*
```

例如：

```text
GENERATION_CONTEXT_SOURCE_CHANGED
GENERATION_CONTEXT_FREEZE_FAILED
RESOURCE_RETRIEVAL_FAILED
RESOURCE_RENDER_FAILED
STORY_MEMORY_CHECKPOINT_DIRTY
STORY_MEMORY_CHECKPOINT_FUTURE
BUDGET_MANDATORY_OVERFLOW
BUDGET_INVALID_CAPACITY
SNAPSHOT_FINGERPRINT_MISMATCH
PIPELINE_SNAPSHOT_MISSING
RESUME_CONTEXT_MISMATCH
```

禁止不断增加仅存在于局部函数中的自由文本错误。

---

# 15. 测试体系调整

推荐：

```text
              Real Device E2E
                   少量
                    ▲
          Golden Journey / Replay
                 重点加强
                    ▲
             Integration Tests
                    ▲
              Unit / Property
                  大量
```

新增重点：

## Contract Test

验证：

```text
Collector → Planner → Allocator → Renderer → Freeze
```

数据契约完全一致。

## Property Test

预算继续验证：

```text
allocated >= 0
allocated <= demand
sum <= capacity
same input → same output
mandatory first
optional shrink never touches mandatory
```

## Metamorphic Test

例如：

- 增加无关低相关度笔记，不应改变 mandatory allocation；
- Context Window 增大，不应导致原 selected mandatory 消失；
- 未激活世界观增加内容，不应改变最终 fingerprint；
- 同一输入重复执行，Snapshot 必须一致。

## Restart Test

```text
Freeze → kill app → cold start → resume
```

fingerprint 必须不变。

## Migration Test

```text
旧 Schema → Migration → Compatibility Adapter → Current Frozen Contract
```

---

# 16. 真实 BUG 的强制处理流程

以后所有真实 BUG 固定执行：

```text
1. 获取 generationTraceId
2. 导出对应 Trace / Snapshot
3. Replay Harness 复现
4. 先写失败测试
5. 确认 Red
6. 定位最小根因
7. 最小修复
8. 测试转 Green
9. 加入 Regression Corpus
10. 全量 CI
```

禁止：

```text
用户说“资料没生效”
→ Agent 搜代码
→ 猜一个位置修改
→ 单测绿
→ Push
```

必须：

> **先复现，再修复。**

---

# 17. Regression Corpus

建议建立：

```text
qa/generation-regressions/
```

每个真实 BUG 一个 Case：

```text
REG-001-note-none-leak
REG-002-writer-style-resume
REG-003-story-memory-dirty
REG-004-budget-soft-overflow
REG-005-continuation-future-plan
...
```

每个 Case 至少包含：

```text
README
input fixture
expected snapshot
expected diagnostics
expected budget result
```

真实使用越久，回归资产越丰富。

---

# 18. 分阶段 PDCA

## Phase 0：Baseline 与链路地图

工作：

- 以最新本地 `main` 为基础；
- fetch `origin/main`；
- 检查 worktree；
- 梳理完整 Generation Call Graph；
- 标出 DB / Repository / Retriever / Budget / Render / Pipeline 边界；
- 列出 silent fallback；
- 列出重复读取业务状态的位置；
- 列出 legacy branch。

输出：

```text
Generation Chain Map
Silent Fallback Inventory
Legacy Branch Inventory
DB Re-read Inventory
```

**Gate P0-0：** 未完成链路地图前，不改业务逻辑。

---

## Phase 1：Trace First

先引入：

```text
generationTraceId + 最小 Generation Trace
```

暂不改变生成语义。

**Gate P0-1：**

- 现有生成行为不变；
- Trace 能完整覆盖一次单章生成。

---

## Phase 2：FrozenGenerationContext V1

先作为内部对象引入：

```text
旧 Context Builder
→ FrozenGenerationContext Adapter
→ Pipeline
```

暂不急于重写 Builder。

**Gate P0-2：**

- Snapshot 序列化/反序列化稳定；
- fingerprint 稳定；
- Resume 可恢复；
- Draft 与下游消费同一 Snapshot。

---

## Phase 3：下游消费收口

逐步让：

```text
Review / Fact Check / Proof / Finalize
```

从重新读取业务状态，切换为消费 Frozen Snapshot。

**Gate P0-3：**

Freeze 后即使 DB 发生变化，下游本次语义不漂移。

---

## Phase 4：Context Builder 六阶段拆分

逐步迁移：

```text
Collect
Normalize
Plan
Allocate
Render
Freeze
```

每迁移一层执行 Golden Diff：

```text
旧输出 vs 新输出
```

**Gate P0-4：** 核心 Golden Journey 全绿。

---

## Phase 5：Silent Fallback 治理

逐项把：

```text
catch → []
catch → 0
catch → ''
```

改为：

```text
diagnostic + explicit degraded/blocking
```

**Gate P0-5：** 所有影响 Generation 语义的 fallback 可观测。

---

## Phase 6：Replay Harness

支持从真实 Trace / Snapshot 重放。

**Gate P0-6：**

同一 Fixture 重放 10 次：

```text
snapshot hash identical
budget identical
render identical
```

---

## Phase 7：Golden Journey

完成首批约 20 条。

**Gate P0-7：** Critical Journey 全绿。

---

## Phase 8：Legacy Adapter

将兼容逻辑逐步移至边缘。

**Gate P1-8：** 新任务主链不再依赖 Legacy branch。

---

## Phase 9：Real Device 穿测

真机/模拟器覆盖：

```text
大纲
续写
Context Auto
Story Memory
Writer Style
大量资料
弹性预算
Kill / Resume
```

**Gate P1-9：** 不得出现：

- fatal；
- silent context loss；
- fingerprint drift；
- next-stage re-read drift。

---

# 19. Git 提交策略

禁止一次提交几千行混合改动。

建议拆为：

```text
feat(trace): add generation trace identity
feat(context): add frozen generation context v1
refactor(pipeline): consume frozen generation snapshot
refactor(context): extract collect phase
refactor(context): extract normalize phase
refactor(context): extract planning phase
refactor(context): unify budget allocation boundary
refactor(context): isolate renderer
fix(context): replace silent fallback with diagnostics
test(generation): add replay harness
test(generation): add golden journeys
refactor(compat): isolate legacy generation adapters
docs(stability): record final governance evidence
```

每个 commit 必须可独立验证和回滚。

---

# 20. CI 新增 Stability Gate

在现有 Verify 基础上建议增加：

```text
Generation Stability
```

至少运行：

```text
Frozen Context contract tests
Budget property tests
Replay regression corpus
Golden Journey critical subset
Snapshot determinism tests
Restart / Resume tests
```

最终 CI：

```text
JavaScript validation
Android Debug build
Migration matrix
Generation Stability
```

---

# 21. 性能边界

治理不能把“稳定”做成“极慢”。

建议记录：

```text
Collect time
Normalize time
Plan time
Allocate time
Render time
Freeze time
DB query count
candidate count
final token count
```

至少建立：

```text
普通项目
大型项目
超大项目
```

三类基线。

重点防止：

- 重复 DB 查询；
- 每个 candidate 单独查数据库；
- Trace 写入阻塞主线程；
- Snapshot 无限制膨胀。

---

# 22. Snapshot 存储策略

建议分层：

### Active Task

保存完整 Frozen Snapshot。

### Recent Debug

保留最近 N 次完整 Trace。

### Long-term

仅保留：

```text
fingerprint
summary trace
error diagnostics
```

真实 BUG 时允许主动导出完整 Snapshot。

---

# 23. Agent 执行边界

本地 Agent 必须：

1. 以本地工作区为实际执行环境；
2. 每阶段开始前 fetch `origin/main`；
3. 不覆盖用户未提交改动；
4. 不使用 `git reset --hard`；
5. 不使用 `git clean -fd`；
6. 不 force push；
7. 先测试再改代码；
8. 每轮必须有 Red → Green 证据；
9. 超出当前阶段边界的问题登记 Issue / NO-GO，不顺手扩边；
10. 不因“顺便更合理”改变业务语义；
11. 所有新行为必须有测试；
12. 所有真实 BUG 必须进入 Regression Corpus；
13. 每阶段通过 Gate 后再进入下一阶段；
14. 每阶段 Push 后检查远端 GitHub Actions；
15. CI 未全绿，不得宣称阶段完成。

---

# 24. 每阶段验收报告模板

```md
# Stability Phase N Report

## Baseline

Local HEAD:
origin/main:
Worktree:

## Scope

本轮允许：
本轮禁止：

## Changes

1.
2.
3.

## Tests

Targeted:
Contract:
Regression:
TypeScript:
Lint:
Jest:
Android:
Migration:

## Golden Journey

GJ-xx:
GJ-xx:

## Trace Evidence

generationTraceId:
snapshot fingerprint:
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

# 25. 最终验收标准

## 架构

- [ ] Generation Context 已形成单一冻结事实源；
- [ ] Freeze 后 Pipeline 不再重新读取影响本次语义的数据；
- [ ] Context Builder 已收束为明确阶段；
- [ ] Budget 只有统一入口；
- [ ] Renderer 不重新决策；
- [ ] 新任务主链不被 Legacy 分支污染。

## 可解释

- [ ] 每次 Generation 有 generationTraceId；
- [ ] 每个资料选中/未选中有 reason；
- [ ] 每项预算分配有 reason；
- [ ] 每次裁剪有 reason；
- [ ] 所有语义级 fallback 有 diagnostic。

## 可重放

- [ ] Snapshot 可序列化；
- [ ] Snapshot 可恢复；
- [ ] fingerprint 稳定；
- [ ] Replay Harness 可执行；
- [ ] 同输入重复执行结果确定。

## 防回归

- [ ] 首批 Golden Journey 完成；
- [ ] Regression Corpus 建立；
- [ ] 真实 BUG 修复遵守“先复现后修复”；
- [ ] Restart / Resume 通过；
- [ ] Migration 通过。

## CI

- [ ] lint 0 errors；
- [ ] typecheck green；
- [ ] test:ci green；
- [ ] Android Debug green；
- [ ] Migration green；
- [ ] Generation Stability green。

## 缺陷

```text
New P0 = 0
New P1 = 0
Remaining Stability NO-GO = 0
```

全部满足后：

```text
STABILITY ARCHITECTURE — GO / SEALED
```

---

# 26. 最重要的执行原则

本轮最危险的做法，是 Agent 看到 Context Builder 很复杂后直接“大重构”。

禁止。

正确顺序：

```text
先 Trace
→ 再 Snapshot
→ 再锁下游
→ 再逐层拆 Builder
→ 再治理 fallback
→ 再建立 Replay
→ 再扩大 Golden Journey
→ 最后清 Legacy
```

即：

> **先建立观测和契约，再移动代码。**

---

# 27. 最终预期

治理前：

```text
资料没生效
预算好像不对
Story Memory 偶尔失效
Resume 后行为不一致
修一个地方另一处出问题
Agent 很难判断问题在哪
```

治理后：

```text
Generation Trace 指出异常阶段
Replay Harness 稳定复现
Snapshot 确认当时真实输入
Budget Trace 解释分配原因
Diagnostic 说明降级原因
Regression Corpus 防止复发
```

最终从：

> **不断寻找并修复小 BUG**

转向：

> **稳定契约 + 可观测 + 可回放 + 自动防回归**

这才是 tavo-mini 从“功能完整”走向“长期稳定”的关键工程收束。
