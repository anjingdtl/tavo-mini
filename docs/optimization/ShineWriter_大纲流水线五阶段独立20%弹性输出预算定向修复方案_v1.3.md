# ShineWriter 大纲流水线五阶段独立 20% 弹性预算定向修复方案

> 适用项目：`anjingdtl/tavo-mini`  
> 核查基线：`main@c2f51a17c975ff3906bad2d2496f99ced7ef20c3`  
> 方案版本：v1.3（同步远端 Schema 50 / Story Memory 非阻塞基线，补齐 Budget V5 版本入口）  
> 修复性质：**小规模、定向、可回滚的预算语义修复**  
> 核心范围：统一大纲流水线新任务 / 新 Batch 的五个 Primary LLM 阶段 + 设置侧预算预览/同步入口  
> 不修改：Story Memory 业务逻辑、Prompt、Reasoning 档位、结构化合同、Formatter、Provider 通道行为、业务语义校验；但必须验证最新 Story Memory 非阻塞/正文持久化能力无回归


---

# 0. 最新远端提交复核（2026-08-10）

上一版方案基线为 `90a6564`。远端当前新增 1 个提交：

```text
c2f51a17c975ff3906bad2d2496f99ced7ef20c3
fix: make story memory non-blocking and durable
```

## 0.1 对本轮预算方案的影响判断

该提交**没有直接修改**以下预算核心文件：

```text
src/services/contextAutoAllocator.ts
src/services/contextAutomationPolicy.ts
src/screens/ContextAutoConfigScreen.tsx
src/screens/LLMSettingsScreen.tsx
src/screens/PipelineConfigScreen.tsx
src/services/pipeline/reconcile.ts
src/services/pipeline/outlineWorkflowVersion.ts
```

因此此前确认的预算根因仍成立：

```text
旧 50/15/15/20
→ pipeline_*_max_tokens
→ PipelineConfig
→ reconcile visibleOutputFloors / stage max
→ Stage Compiler reservedOutputTokens
```

本轮修复方向**不变**。

## 0.2 新提交带来的强制边界

最新提交把 Story Memory 改成：

```text
章节正文先完成本地持久化
→ Story Memory 维护后台排队
→ Story Memory LLM 失败不得阻塞章节定稿
```

同时新增：

```text
Schema 50
story_memory_request_attempts
Story Memory 物理 HTTP 请求账本
Provider physicalRequestHooks
```

因此本轮预算改造增加以下硬边界：

- 不新增 Schema 51；
- 不修改 Schema 50 Story Memory migration；
- 不修改 `story_memory_request_attempts`；
- 不删除或绕过 LLM Provider 的 `physicalRequestHooks`；
- 不修改 Story Memory 请求次数预算；
- 不让 Context Auto / 大纲预算改造重新把 Story Memory 变成同步阻塞；
- 不改变“章节正文先落库、Story Memory 后维护”的时序；
- Story Memory 失败时，已保存章节正文必须继续保留。

## 0.3 Budget V5 版本入口需要补齐

最新 `useChapterPipeline` 仍把版本类型写死为：

```ts
outlineWorkflowVersion: 1 | 2 | 3 | 4;
contextBudgetVersion: 1 | 2 | 3 | 4;
```

而本方案要求：

```text
CURRENT_CONTEXT_BUDGET_VERSION = 5
```

因此实施时必须同步检查所有版本类型/解析入口，至少包括：

```text
src/services/pipeline/outlineWorkflowVersion.ts
src/types/pipelineExecution.ts
src/types/pipeline.ts
src/services/pipelineTaskContext.ts
src/store/pipelineTaskStore.ts
src/screens/chapter-editor/hooks/useChapterPipeline.ts
Batch 创建 / freeze 相关类型
相关 tests / fixtures
```

不能只修改 `CURRENT_CONTEXT_BUDGET_VERSION` 常量，否则会形成“常量是 5、类型/parser 仍只接受到 4”的半升级状态。


---

# 1. 本轮确认的两个实现偏差

本轮核查确认，不是单一的 `reasoning_only` 问题，而是**大纲流水线预算语义在“运行时”和“设置侧”都残留了旧时代的固定拆分逻辑**。

## 1.1 运行时偏差：五阶段没有全部拿到独立 20% 输出 reservation

目标设计：

```text
Draft      → 独立 requestMaxTokens = min(context_window × 20%, model.max_output_tokens)
Review     → 独立 requestMaxTokens = min(context_window × 20%, model.max_output_tokens)
FactCheck  → 独立 requestMaxTokens = min(context_window × 20%, model.max_output_tokens)
Brief      → 独立 requestMaxTokens = min(context_window × 20%, model.max_output_tokens)
Final      → 独立 requestMaxTokens = min(context_window × 20%, model.max_output_tokens)
```

五个阶段是五次独立 API 请求，**不能共享一个 20% 总输出池后再切分**。

当前实现中：

- Brief 已接近正确语义；
- Draft / Review / FactCheck / Final 仍受旧 `pipeline_*_max_tokens` / visible floor 链影响；
- 旧比例仍为：

```text
总窗口 × 20% outputBudget
        ↓
Draft       50%
Review      15%
FactCheck   15%
Proof       20%
```

这导致新弹性预算系统仍被 Legacy 固定预算“喂值”。

---

## 1.2 设置侧偏差：上下文自动配置仍是旧预算模型

当前“设置 → 上下文自动化配置”仍调用旧：

```ts
allocateContextBudget()
```

其预览仍展示：

```text
输入侧：80%
输出侧：20%
  ├─ Draft 50%
  ├─ Review 15%
  ├─ FactCheck 15%
  └─ Proof 20%
```

点击“一键应用”后仍会写入：

```text
pipeline_draft_max_tokens
pipeline_review_max_tokens
pipeline_factcheck_max_tokens
pipeline_proof_max_tokens
```

因此用户看到的“自动配置结果”和新弹性流水线的目标语义不一致。

---

## 1.3 LLM 设置页还有第二条旧同步入口

当前 LLM 设置页在用户修改 `context_window` 后，会询问：

> 是否按兼容比例同步大纲流水线阶段 Max Tokens？

该入口继续调用：

```ts
syncPipelineMaxTokensFromContextWindow()
```

而该函数内部仍是：

```text
context × 20%
再按
50 / 15 / 15 / 20
切分
```

这意味着即使主流水线改好了，只要用户以后在 LLM 设置里调整上下文，仍可能再次把旧阶段固定值写回。

这是本轮必须一起切断的“回污染路径”。

---

# 2. 本轮修复目标

只解决预算语义，不扩大到模型行为和业务合同。

## 2.1 新统一流水线

对于 `contextBudgetVersion >= 5` 的新任务 / 新 Batch：

```ts
stageOutputReservation = resolveElasticStageOutputReservation({
  contextWindow,
  modelMaxOutputTokens,
});
```

五个 Primary 阶段统一：

```text
Draft      = stageOutputReservation
Review     = stageOutputReservation
FactCheck  = stageOutputReservation
Brief      = stageOutputReservation
Final      = stageOutputReservation
```

其中现有 resolver 的语义保持：

```text
min(
  floor(context_window × 20%),
  model.max_output_tokens
)
```

不得新增第二套等价公式。

---

## 2.2 设置页

“上下文自动配置”必须从：

> 旧的固定阶段配额计算器

调整为：

> **上下文/资源自动配置 + 当前统一大纲流水线真实弹性预算预览**

用户输入仍保持一个数字，不新增复杂设置项。

设置页必须让用户清楚看到：

```text
统一大纲流水线（新任务）
Draft       200K max
Review      200K max
FactCheck   200K max
Brief       200K max
Final       200K max

每阶段均为独立 API 请求
每阶段重新获得自己的 20% 输出 reservation
```

---

# 3. 修复边界

## 3.1 允许修改

仅允许修改：

1. 新统一流水线任务冻结阶段的 `requestMaxTokens`；
2. 新统一流水线任务冻结阶段的 `visibleOutputFloor` 来源；
3. `contextBudgetVersion`；
4. Context Auto 设置页的“大纲流水线预算预览”；
5. LLM 设置页旧“按兼容比例同步”入口；
6. 与以上行为直接相关的单元测试 / 集成测试 / 真实 LLM 诊断字段。

---

## 3.2 禁止修改

本轮禁止：

- 修改 `80% soft pool`；
- 修改 `95% burst band`；
- 修改 safety margin；
- 修改 mandatory / preferred / optional 分配算法；
- 修改输入上下文裁剪策略；
- 修改 Prompt；
- 修改 Reasoning 档位；
- 修改 Review / FactCheck 固定 low Thinking；
- 修改 Provider；
- 修改 `reasoning_only` 分类；
- 修改 `StructuredCandidate`；
- 修改 Formatter；
- 给 Formatter 扩到完整 20%；
- 修改 Story Memory；
- 修改 Canon；
- 修改语义合同；
- 修改 Final Artifact Validator；
- 修改 Batch 串并行拓扑；
- 修改 CAS / lease / retry 机制；
- 数据库 Schema migration；
- 修改 `story_memory_request_attempts` / Story Memory request ledger；
- 修改 Story Memory `StoryMemoryAttemptBudget` / request policy；
- 删除、绕过或改变 Provider `physicalRequestHooks` 的调用语义；
- 无关 UI 重构；
- 与当前大纲流水线预算无关的全仓历史清理。

### 允许删除的历史残留

由于旧未完成流水线不再支持恢复，freeform 模块也已退出产品，本轮允许删除**直接位于当前大纲流水线预算调用链上的历史残留**，包括：

- 旧 `50/15/15/20` 大纲输出比例；
- `computePipelineMaxTokensFromContextWindow()`；
- LLM Settings 中“兼容比例同步”入口；
- Pipeline Config 中四阶段手工 Max Tokens；
- Context Auto 中旧四阶段输出拆分；
- 仅用于旧大纲预算 / freeform 预算兼容的分支与 API。

但不要把本轮扩大成全仓 dead-code sweep。只有确认无现行调用、且直接与本轮预算收束相关的残留才删除。

---

# 4. 版本与旧任务处理

建议：

```text
CURRENT_CONTEXT_BUDGET_VERSION
4 → 5
```

同时必须把所有现行任务创建/快照/parser 的 `ContextBudgetVersion` 类型扩展到 5。  
这属于本轮预算版本落地的必要改动，不属于旧版本兼容建设。

不升级：

```text
CURRENT_OUTLINE_WORKFLOW_VERSION
```

不升级数据库 Schema。当前远端已经是 **Schema 50**；本轮预算修复不得新增 Schema 51，也不得修改 Schema 50 Story Memory 请求账本结构。

### 4.1 新任务

```text
contextBudgetVersion = 5
→ 五阶段独立 20% reservation
→ 新的 visible floor 语义
```

### 4.2 旧未完成任务

不再维护旧预算恢复语义。

规则改为：

```text
outlineWorkflowVersion != CURRENT
OR
contextBudgetVersion != CURRENT
    → 禁止 Resume
    → 提示用户按新版重新生成
```

不做：

- 旧预算迁移；
- 旧 snapshot 预算转换；
- 旧 task 自动续跑；
- 旧 Batch 继续执行。

### 4.3 用户已写好的章节

本轮唯一必须保护的数据资产是：

```text
chapters.content
已采用 revision
已写入正式章节正文
```

这些数据禁止改写、删除、回滚。

旧 pipeline task / snapshot / checkpoint 只属于运行历史，不得反向影响已经保存好的章节正文。

---

# 5. 核心修复一：五阶段统一物理输出 reservation

复用现有：

```ts
resolveElasticStageOutputReservation({
  contextWindow,
  modelMaxOutputTokens,
})
```

在新任务创建 / execution freeze 时只计算一次：

```ts
const primaryStageOutputReservation =
  resolveElasticStageOutputReservation({
    contextWindow,
    modelMaxOutputTokens: requestConfig.max_output_tokens,
  });
```

然后在 `contextBudgetVersion >= 5` 下：

```ts
requestMaxTokenOverrides: {
  draft: primaryStageOutputReservation,
  review: primaryStageOutputReservation,
  factCheck: primaryStageOutputReservation,
  brief: primaryStageOutputReservation,
  proof: primaryStageOutputReservation,
}
```

禁止继续只给 Brief override。

---

# 6. 核心修复二：v5 visibleOutputFloor 必须与 Legacy PipelineConfig 解耦

这是本轮补充核查后需要特别修正的一点。

当前新任务预算冻结仍会把：

```text
params.config.draftMaxTokens
params.config.reviewMaxTokens
params.config.factCheckMaxTokens
历史 proof 派生值
```

送进 `visibleOutputFloors`。

而这些值本身正是旧 50/15/15/20 自动配置的产物。

因此：

> **只改 requestMaxTokens、不改 visible floor 来源，还不能真正切断旧预算语义。**

## 6.1 v5 正确语义

对于 `contextBudgetVersion >= 5`：

`visibleOutputFloor` 只表示：

> 该阶段完成合法可见业务结果所需的最低输出空间。

它不再表示：

> 这个阶段被分到多少物理输出额度。

建议直接使用现有 stage policy 的语义 floor：

```text
Draft       policy.visibleOutputFloor
Review      policy.visibleOutputFloor
FactCheck   policy.visibleOutputFloor
Brief       policy.visibleOutputFloor
Final       policy.visibleOutputFloor
```

或已有更精确的“实际业务最低需求”计算。

但禁止继续从：

```text
pipeline_draft_max_tokens
pipeline_review_max_tokens
pipeline_factcheck_max_tokens
pipeline_proof_max_tokens
```

读取 v5 的最低适配阈值。

---

## 6.2 reasoningHeadroom 保持原职责

继续保留：

```text
visibleOutputFloor
+
reasoningHeadroom
```

用于：

- 最低能力适配判断；
- `fitsModelOutput`；
- 判断模型是否具备完成该阶段的基本能力。

但它不再决定物理：

```text
requestMaxTokens
```

物理上限统一由 20% elastic reservation 决定。

---

# 7. 核心修复三：上下文自动配置页面与新弹性预算统一

当前设置页不能继续把旧固定分配当成“当前流水线预算”。

## 7.1 保留现有输入/资源配置

以下功能本轮全部保留：

- 一个最大上下文输入框；
- 128K / 200K / 512K / 1M 快捷值；
- 输入侧资源预算；
- 滑动窗口；
- Story State；
- Episodic；
- 角色 / 笔记 / 世界书预算；
- Last Applied；
- Context Automation Policy。

不重做整个设置系统。

---

## 7.2 “输出侧”预览必须换成新语义

当前：

```text
📤 输出侧（20%）
草稿
审阅
事实核查
校对
```

且四个值不同。

对于当前统一大纲流水线，应改为：

```text
📤 统一大纲流水线：每次调用独立输出 reservation

Draft       X
Review      X
FactCheck   X
Brief       X
Final       X

X = resolveElasticStageOutputReservation(...)
```

必须复用运行时同一个 resolver。

禁止 UI 自己再写一套：

```ts
context * 0.2
```

防止以后再次漂移。

---

## 7.3 设置页预览必须展示“未来新任务真实冻结值”

建议新增纯函数：

```ts
buildOutlineElasticBudgetPreview(...)
```

但它只能是对现有 runtime allocator/resolver 的薄封装，不复制预算算法。

输入：

```text
contextWindow
prospective modelMaxOutputTokens
reasoning tier（仅做适配检查时需要）
```

输出至少：

```text
stage
requestMaxTokens
visibleOutputFloor
reasoningHeadroom
softInputLimit
hardInputLimit
```

UI 只负责显示。

### 验收原则

同一输入下：

```text
Settings Preview
===
New Task execution.stageBudgets
===
Provider 最终 max_tokens
```

三者必须一致。

---

# 8. 上下文自动配置“一键应用”的处理边界

当前“一键应用”还承担：

- ContextConfig；
- LLM config；
- presets；
- 资源 max_tokens；
- 旧 PipelineConfig 固定预算。

本轮不整体重构 Context Auto，但**旧 PipelineConfig 固定预算必须从大纲创作路径退出**。

## 8.1 保持现有 context / resource 写入

继续保持：

```text
context_auto_input
sliding_window_size
resource_budget
story_state_budget_tokens
episodic_memory_budget_tokens
memory_patch_max_tokens
资源级 max_tokens
```

不改。

---

## 8.2 保持现有自动配置的 20% LLM output baseline 语义

本轮不新增“模型最大输出”第二输入框，也不做 Provider 能力自动探测。

延续当前自动配置行为：

```text
llm_config.context_window = numericInput
llm_config.max_output_tokens = numericInput × 20%
```

但必须明确：

> 对新统一大纲流水线而言，这两个字段是模型窗口/输出能力基线；五阶段运行时会再通过 `resolveElasticStageOutputReservation()` 读取它们，而不是读取旧 pipeline_* 固定配额。

如果未来要支持不同 Provider 独立 capability profile，另立方案，不并入本轮。

---

## 8.3 旧 pipeline_* 固定预算从 Context Auto 退出

以下字段不再由“上下文自动配置”写入：

```text
pipeline_draft_max_tokens
pipeline_review_max_tokens
pipeline_factcheck_max_tokens
pipeline_proof_max_tokens
```

原因：

- 旧未完成流水线不再恢复；
- freeform 已退出产品；
- 当前大纲流水线由模型能力 + elastic resolver 直接冻结；
- 继续写这些字段只会制造第二套预算权威。

数据库中已存在的旧 key 可以暂时留在表里，不需要 migration 删除；但当前代码不得再把它们当作大纲预算来源。

---

# 9. 核心修复四：清理 LLM 设置页“旧同步回污染”

当前：

```ts
syncPipelineMaxTokensFromContextWindow()
```

仍按 50/15/15/20 写回固定阶段预算。

对于当前统一大纲流水线，这个入口已经不应存在于正常设置流程。

## 9.1 推荐处理

从 LLM Settings 的正常保存流程中移除：

```text
“是否自动调整大纲流水线阶段 Max Tokens？”
```

原因：

新 v5 任务应该直接读取保存后的：

```text
context_window
max_output_tokens
```

然后在创建任务时冻结自己的弹性预算。

不再需要：

```text
LLM Settings
→ 再复制一份固定 pipeline max tokens
```

这正是导致两套预算长期漂移的原因之一。

---

## 9.2 删除旧同步函数

`syncPipelineMaxTokensFromContextWindow()` 与其底层：

```text
computePipelineMaxTokensFromContextWindow()
```

不再有产品用途，应在确认无其他现行调用后删除。

同时删除：

- 对旧 50/15/15/20 结果的测试断言；
- LLM Settings 中对应提示文案；
- 仅为该同步函数存在的 import / helper。

不再保留 deprecated 兼容入口。

---

## 9.3 save 与 saveAndTest 必须一致

当前 LLM 设置存在两个保存出口：

```text
保存配置
保存并测试
```

本轮验收必须保证：

- 两条路径保存相同 `context_window / max_output_tokens`；
- 两条路径都不会触发旧 50/15/15/20 回写；
- 下一次创建 v5 task 时得到相同 stage reservation。

不能出现：

```text
普通保存 → 一套预算
保存并测试 → 另一套预算
```

---

# 10. Context Auto 页面中 Continuation V4 预览的小修正

当前该页面的 Continuation V4 模拟构造：

```ts
{
  contextWindow: numericInput,
  maxOutputTokens: numericInput,
}
```

也就是说，预览把“最大上下文输入值”同时当作 max output 能力。

虽然其 policy 最终仍会按输出比例裁剪，但语义不够一致。

本轮允许做一个极小修正：

```text
prospectiveMaxOutputTokens
=
allocateContextBudget(...).llmMaxOutputTokens
```

或由同一自动配置结果取得。

使预览与“一键应用后真正写入的 LLM max_output_tokens”一致。

禁止顺手重构 Continuation V4 budget resolver。

---

# 11. 唯一预算权威链

修复后只允许存在：

```text
Frozen LLM capability
(context_window + max_output_tokens)
        ↓
resolveElasticStageOutputReservation()
        ↓
execution.stageBudgets[]
        ↓
Provider max_tokens
```

这条链是唯一权威。

以下内容全部退出当前大纲预算控制：

```text
pipeline_*_max_tokens
50/15/15/20 stage ratio
旧固定 stage max token 同步
freeform budget fallback
historical budget fallback
```

数据库中历史 key 可以存在，但生产代码不再消费。

---

# 12. 推荐修改文件

重点检查：

```text
src/services/contextAutoAllocator.ts
src/services/contextAutomationPolicy.ts
src/screens/ContextAutoConfigScreen.tsx
src/screens/LLMSettingsScreen.tsx
src/screens/PipelineConfigScreen.tsx
src/services/pipeline/reconcile.ts
src/services/pipeline/outlineWorkflowVersion.ts
src/types/pipelineExecution.ts
src/types/pipeline.ts
src/services/pipelineTaskContext.ts
src/store/pipelineTaskStore.ts
src/screens/chapter-editor/hooks/useChapterPipeline.ts
multi-chapter batch version freeze 相关文件
```

原则上只读、不改算法：

```text
src/services/pipeline/elasticBudgetAllocator.ts
src/services/pipeline/elasticStageCompiler.ts
src/services/pipeline/reasoningPolicy.ts
src/services/storyMemory/storyMemoryAttemptBudget.ts
src/services/storyMemory/storyMemoryRequestPolicy.ts
src/data/repositories/storyMemoryRequestAttemptRepository.ts
src/services/llm/openAICompatibleProvider.ts
```

其中 `openAICompatibleProvider.ts` 最新加入了 Story Memory 物理请求账本 hooks。  
除非预算补丁出现明确编译错误，否则本轮不修改该文件。

如果 Agent 开始大改这些核心 allocator / reasoning / provider，视为越界。

---

# 13. 自动化测试

## T1 五阶段独立 reservation

```text
context = 1,000,000
modelMax = 200,000
expected = 200,000
```

五阶段全部 200K。

---

## T2 模型输出更小

```text
context = 1,000,000
modelMax = 64,000
expected = 64,000
```

五阶段全部 64K。

---

## T3 20% context 更小

```text
context = 128,000
modelMax = 32,000
expected = 25,600
```

五阶段全部 25,600。

---

## T4 新任务完全忽略 Legacy 固定配额

故意设置：

```text
pipeline_draft_max_tokens = 100000
pipeline_review_max_tokens = 30000
pipeline_factcheck_max_tokens = 30000
pipeline_proof_max_tokens = 40000
```

同时模型：

```text
context = 1M
max_output = 200K
```

创建 v5 task。

必须得到：

```text
Draft      200K
Review     200K
FactCheck  200K
Brief      200K
Final      200K
```

并且 visible floor 也不能被上述 Legacy 数值污染。

这是本轮最关键回归测试之一。

---

## T5 Context Auto 预览与 Runtime 完全一致

输入 1M：

设置页显示：

```text
五阶段 200K
```

应用后创建新任务：

```text
execution.stageBudgets[].requestMaxTokens = 200K
```

实际 Provider：

```text
max_tokens = 200K
```

三者一致。

---

## T6 LLM 设置修改后无需 Legacy Sync

修改：

```text
context_window
max_output_tokens
```

保存后：

- 不弹旧 50/15/15/20 同步；
- 创建新 v5 task；
- 新任务直接按新 LLM capability 冻结。

---

## T7 save / saveAndTest 等价

相同配置分别走：

```text
保存
保存并测试
```

最终新任务预算完全相同。

---

## T8 旧未完成任务直接阻断 Resume

构造：

```text
outlineWorkflowVersion = CURRENT
contextBudgetVersion = 4
```

以及更老版本组合。

必须：

- Resume 直接拒绝；
- 0 次 LLM 调用；
- 不迁移预算；
- 不修改 `chapters.content`；
- 不删除已经落库正文。

---

## T9 Formatter 不变化

人为制造：

```text
reasoning_only
invalid_json
```

Formatter 继续使用原 bounded budget。

不得继承 Primary 20%。

---

## T10 输入 allocator 无回归

覆盖：

```text
32K
64K
128K
1M
```

确认：

- soft 80% 规则不变；
- burst 95% 规则不变；
- mandatory 不裁剪；
- optional 正常回收；
- hard overflow 仍阻断。

---


## T11 Budget V5 类型链完整

必须覆盖：

```text
CURRENT_CONTEXT_BUDGET_VERSION = 5
→ useChapterPipeline createTask 接受 5
→ pipelineTaskStore 持久化 5
→ PipelineExecutionSnapshot 接受 5
→ pipelineTaskContext parser 接受 5
→ Batch freeze 接受 5
```

不存在任一：

```text
1 | 2 | 3 | 4
```

导致当前新任务无法使用 Budget V5 的现行类型入口。

历史数字是否仍可只读解析，不是本轮重点；但任何新任务入口都必须完整接受当前版本。

---

## T12 Story Memory / 正文持久化无回归

预算补丁完成后必须额外跑最新远端已有回归：

```text
__tests__/chapterFinalizeStoryMemory.test.ts
__tests__/finalizeChapterMemoryReturnState.test.ts
__tests__/storyMemoryNoStallGeneration.test.ts
__tests__/storyMemoryRequestAttemptLedger.test.ts
```

必须证明：

- 章节正文仍先本地落库；
- Story Memory LLM 不同步阻塞章节定稿；
- Story Memory 后台失败不回滚正文；
- request ledger 仍按 Schema 50 正常工作；
- Provider physical request 账本没有因预算代码清理失效。

---

# 14. 集成测试

## 14.1 Context Auto → New Task

完整链路：

```text
Settings
→ Context Auto 输入 1M
→ 一键应用
→ DB llm_config = 1M / 200K
→ 新建大纲流水线任务
→ stageBudgets 五阶段 = 200K
→ 五次 Provider max_tokens = 200K
```

必须真实抓最终调用参数，而不是只测 UI。

---

## 14.2 LLM Settings → New Task

修改当前模型：

```text
context_window = 128K
max_output_tokens = 32K
```

下一任务必须：

```text
25.6K × 5 stages
```

无需任何固定 PipelineConfig 同步。

---

## 14.3 Batch

创建 3 章 Batch：

- Batch 冻结 budgetVersion 5；
- child task 全部继承；
- 每个 child 五阶段均按同一规则；
- Batch 创建后修改 Settings，不影响已经冻结的 Batch。

## 14.4 章节落库 / Story Memory 隔离

完成一章流水线并采用结果：

```text
Final result
→ chapters.content / revision 本地写入成功
→ Story Memory maintenance queued
```

人为令 Story Memory Provider 失败，必须：

```text
章节正文仍存在
pipeline 预算结果不回滚
Story Memory failure 独立记录
```

本轮预算改造不得引入“等待 Story Memory 才算章节写完”的同步依赖。

---

# 15. 真实 LLM 小规模穿测

先跑：

```text
3 个独立单章
+
1 个 3 章 Batch
=
6 章
```

保持：

- `deepseek-v4-flash`
- 同一 reasoning 档位；
- 同一 Prompt；
- 同一合同；
- 同一 Formatter；
- 同一输入上下文策略。

记录：

```text
stage
contextBudgetVersion
contextWindow
modelMaxOutputTokens
requestMaxTokens
visibleOutputFloor
reasoningHeadroom
finishReason
reasoningTokens
visibleOutputTokens
FormatterUsed
```

### 本轮第一验收目标

不是先看 `reasoning_only`。

先证明：

```text
五阶段真正都拿到了正确独立 reservation
```

预算链正确后，再观察：

```text
reasoning_only
Formatter
一次通过率
```

是否自然改善。

---

# 16. P0 验收标准

必须全部满足：

- 新任务 `contextBudgetVersion = 5`；
- 五阶段 Primary 独立 20% reservation；
- 五阶段真正 Provider `max_tokens` 与 frozen stage budget 一致；
- v5 visible floor 不读取 Legacy `pipeline_*_max_tokens`；
- Context Auto 页面预览与 Runtime 同 resolver；
- Context Auto 页面不再把 50/15/15/20 当当前统一流水线预算展示；
- LLM Settings 正常保存不再触发旧比例回写；
- save / saveAndTest 行为一致；
- Legacy task / Batch 不变；
- Formatter 不变；
- Reasoning 不变；
- Prompt 不变；
- 80% / 95% 输入弹性算法不变；
- 无数据库 migration；当前 Schema 保持 50；
- Story Memory `physicalRequestHooks` / request ledger 无回归；
- 章节正文先落库、Story Memory 后台维护的时序无回归；
- Budget V5 在 task / execution / parser / chapter editor / Batch 类型链完整；
- `npm run verify` 完整退出码 0；
- 无崩溃。

---

# 17. 不作为本补丁硬门槛的观察指标

以下只观察：

- `reasoning_only` 是否下降；
- Formatter 是否下降；
- Primary 一次通过率是否提高；
- amplification 是否下降；
- 耗时是否变化。

不能为了这些指标再顺手修改：

```text
Prompt
Reasoning
Provider
Formatter
Validator
```

如果仍有 `reasoning_only`，另开根因拆分，不在本补丁继续扩大范围。

---

# 18. 回滚

若出现严重回归：

1. 回退本轮代码提交；
2. 不执行数据库降级；
3. 不修改任何 `chapters.content`；
4. 不删除已完成章节；
5. 新旧 pipeline task 历史记录保持原样。

由于本轮不再承诺旧任务 Resume，回滚策略也不需要维持历史预算兼容分支。

---

# 19. Agent 实施纪律

Agent 必须：

1. 以本地仓为唯一实施基线；
2. 先检查 `git status`；
3. 不覆盖用户未提交修改；
4. fetch / compare origin/main 只作参考；
5. 先写 failing test 证明：
   - 新任务仍受旧 50/15/15/20 影响；
   - Context Auto 仍展示旧输出拆分；
   - LLM Settings 仍可回写旧比例；
   - Pipeline Config 仍能手工写四阶段 Max Tokens；
   - 旧 budgetVersion 任务仍可能进入 Resume；
6. 再做最小补丁；
7. 可以删除与当前大纲预算直接相关、确认无现行调用的 Legacy / freeform 预算代码；
8. 不做无关全仓 dead-code sweep；
9. 不修改 elastic allocator 核心算法；
10. 不修改 Prompt / Reasoning / Formatter；
11. 每个生产变更必须有测试；
12. 超出预算范围的问题只记录，不顺手修；
13. 在预算测试之外，额外执行 Story Memory 非阻塞与 request-ledger 回归；
14. 最终给出 before / after 参数表和 Provider 调用证据；
15. 最终报告必须注明实施基线 commit，并确认基线不早于 `c2f51a1`。

---

# 20. 最终目标结构

```text
设置 → 上下文自动配置
        │
        ├─ context_window
        └─ max_output_tokens baseline
                 │
                 ▼
        新任务 / 新 Batch 冻结
                 │
                 ▼
resolveElasticStageOutputReservation()
                 │
     ┌───────────┼───────────┬───────────┬───────────┐
     ▼           ▼           ▼           ▼           ▼
   Draft       Review     FactCheck     Brief       Final
   20%          20%         20%          20%         20%
 独立请求      独立请求      独立请求      独立请求      独立请求

每次 API 调用重新获得自己的完整弹性预算。
五阶段不共享 output pool。
旧 50/15/15/20 只作为 Legacy 兼容数据存在。
```

---

# 结论

本轮目标进一步收束为：

1. **运行时：**
   五个 Primary API 阶段统一改为独立 20% 输出 reservation。

2. **设置侧：**
   Context Auto 只展示与 Runtime 同源的弹性预算，不再计算或展示 50/15/15/20。

3. **配置侧：**
   Pipeline Config 删除四阶段手工 Max Tokens；大纲预算不再由用户手工切分。

4. **同步侧：**
   删除 LLM Settings 的旧比例同步入口，以及对应 `compute/syncPipelineMaxTokensFromContextWindow()`。

5. **旧任务：**
   旧 workflow / budgetVersion 未完成任务不再 Resume，不迁移预算，只保护已经写入 `chapters.content` 的用户正文。

6. **freeform：**
   不再为 freeform 保留任何预算兼容。远端若仍存在直接位于当前 pipeline/budget 调用链上的 freeform 残留，在确认无调用后可一并删除。

7. **单一权威：**
   当前大纲流水线只认：

```text
LLM capability
→ elastic reservation
→ stageBudgets[]
→ Provider max_tokens
```

不再保留第二套固定阶段预算体系。

这比“继续兼容旧预算”更符合当前产品实际，也更容易彻底消除预算根因漂移。

最新远端 `c2f51a1` 没有改变上述预算根因，因此不需要改方案方向；只需要把 **Schema 50 / Story Memory 非阻塞 / Provider 请求账本**作为新的不可破坏基线，并确保 Budget V5 的版本类型链完整升级。
