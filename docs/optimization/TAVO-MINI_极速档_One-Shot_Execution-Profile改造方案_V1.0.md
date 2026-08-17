# TAVO-MINI “极速”档（One-Shot Execution Profile）改造方案 V1.0

**项目：** TAVO-MINI / ShineWriter  
**目标：** 在现有“低 / 中 / 高”思考档位基础上新增“极速”档。  
**适用场景：** 网文日更、轻创作、快速草稿、非严肃作品、速度与调用成本优先场景。

---

## 1. 核心目标

新增第四档：

| 档位 | 用户定位 | 核心策略 |
|---|---|---|
| 极速 | 速度/成本优先 | One-Shot，仅 1 次付费 LLM 调用 |
| 低 | 快速创作 | 保持现有低档逻辑 |
| 中 | 平衡 | 保持现有默认逻辑 |
| 高 | 质量优先 | 保持现有高档逻辑 |

本轮不重构低/中/高档，只新增“极速”。

核心定义：

> 极速 = One-Shot Execution Profile。仍使用现有弹性上下文自动预算，在模型真实 Context Window 内尽可能完整装入本章有效资料，只调用一次 Shared Draft LLM；跳过所有付费 AI 审查、事实核查、修订和终稿重写，仅保留本地 Final Validate、Persist、Trace 与 Post-writing Update。

---

## 2. 设计原则

### 2.1 极速是 Execution Profile，不是 reasoningEffort

禁止：

```ts
reasoningEffort = 'extreme'
reasoningEffort = 'very_low'
```

应定义为：

```ts
executionProfile = 'one_shot'
```

用户界面仍显示“极速”，但内核理解为流水线执行策略。

---

### 2.2 不新增第二套 Writer Core

极速仍必须走：

```text
Production Writing Entry
→ ONE Writing Kernel
→ ONE Freeze
→ ONE Shared Stage Runner
→ Shared Draft
→ ONE Shared Writer Core
→ ONE Shared Prompt Compiler
```

禁止新增：

```text
fastWriter.ts
extremeWriter.ts
oneShotWriterCore.ts
fastPromptCompiler.ts
extremePromptCompiler.ts
```

也禁止通过 scenario/profile callback 跳到另一套 Writer。

极速差异只能通过：

- Execution Profile
- WritingStagePolicy
- Requirement / Policy Projection
- Stage Skip Rules
- Frozen Stage Reasoning

表达。

---

### 2.3 极速 = 少跑流程，不是少给上下文

**禁止为极速档设置任何新的固定输入 Token 上限。**

禁止类似：

```text
极速最多 32K
极速最多 50K
最近上下文固定 20K
Story Memory 固定 10K
Canon 固定 15K
```

极速必须完整继承现有：

```text
Context Budget
Hierarchical Context Allocation
Elastic Budget
mandatory / preferred / optional
protected source
dynamic clipping
context-window fit check
模型真实 context window
现有安全余量机制
```

硬原则：

> **Execution Profile 不得覆盖 Context Budget Algorithm。**

极速提速来自减少后续 Stage 和模型调用，而不是人为压缩上下文。

---

## 3. 极速档目标流水线

```text
Collect
↓
Normalize
↓
Plan
↓
Existing Elastic Allocate
↓
Render
↓
Freeze
↓
Shared Draft
↓
Local Final Validate
↓
Shared Persist
↓
Post-writing Update
```

模型侧唯一付费调用：

```text
Shared Draft Primary = 1 次 API
```

正式 Stage 策略：

```text
Draft           ENABLED
Review          SKIPPED
Audit           SKIPPED
FactCheck       SKIPPED
Revision        SKIPPED
Proof           SKIPPED
FinalValidate   ENABLED（Local）
Persist         ENABLED
PostWriting     ENABLED
```

所有跳过必须通过正式 `WritingStagePolicy.skipRules` 表达，例如：

```ts
review: {
  skipReason: 'One-Shot profile skips AI review',
  policyRuleId: 'profile.one_shot.skip_review',
}
```

禁止 `async () => undefined`，也不得伪装成 `completed`。

---

## 4. API 调用硬约束

### 4.1 每章最多 1 次付费调用

极速档硬指标：

```text
Paid LLM Calls Per Chapter <= 1
```

唯一允许：

```text
Shared Draft Primary
```

以下全部禁止：

- Draft Retry
- Primary Replay
- Formatter
- Review
- Audit
- FactCheck
- Revision
- Proof
- Final Reviser
- 自动“再试一次”
- reasoning-only 后二次修复

---

### 4.2 极速档关闭 Formatter

标准模式现有 Formatter 能力继续保留，但极速档必须关闭。

极速：

```text
Primary success
→ Local Validate
→ Persist
```

失败：

```text
Primary empty / reasoning_only / malformed / truncated / provider error
→ FAIL CLOSED
```

不得：

```text
Primary
→ Formatter
→ Second API
```

建议将能力放入统一 Profile/Policy：

```ts
{
  id: 'one_shot',
  maxPaidLlmCalls: 1,
  allowFormatter: false,
  allowPrimaryRetry: false,
}
```

如已有等价字段，应复用，不重复造概念。

---

## 5. Shared Draft Prompt 改造

极速仍只使用：

```text
compileSharedWritingPrompt()
```

不新增极速 Prompt Compiler。

允许在 Shared Draft 的 Policy Projection 中加入 One-Shot 指令，例如：

```text
【执行模式：极速 / One-Shot】

本次是本章唯一一次模型生成。
生成结果不会再经过 AI Review、FactCheck、Revision 或 Proof。
请直接输出可保存的完整章节正文。

必须尽最大可能同时满足：
- 用户指令
- 当前章节大纲/剧情任务
- 已冻结 Canon / Boundary / Seam / Anchor
- 人物与世界设定
- Story Memory
- Writer Style
- 前文连续性
- 目标篇幅与自然结尾
```

注意：这是统一 Prompt 的 Profile 投影，不是第二套 Prompt。

---

## 6. 上下文策略

### 6.1 完全继承现有弹性预算

极速仍经过：

```text
Source Collection
→ Requirement Classification
→ Context Planning
→ Hierarchical Allocation
→ Elastic Borrow / Clip
→ Render
→ Freeze
```

不增加固定 Token cap。

---

### 6.2 “尽可能装入所有有效资料”的含义

不是数据库无脑全量拼接，而是沿用当前上下文治理。

优先保证 Mandatory：

- 当前章节任务
- 用户指令
- 当前有效大纲
- Continuation Canon
- Boundary
- Seam
- Primary Anchor
- 必要人物状态
- 必要世界规则
- 关键 Story Memory

Preferred 尽量纳入：

- 最近章节
- Episodic Memory
- Writer Style
- 相关角色
- 相关世界书
- 关联笔记
- 次级剧情资料

Optional 空间不足时仍由现有弹性预算做动态裁剪/排序/排除。

---

## 7. Outline 与 Continuation

### 7.1 Outline 极速

```text
Outline Source Adapter
→ Requirements
→ Existing Elastic Context Budget
→ Freeze
→ Shared Draft
→ Local FinalValidate
→ Persist
→ Story Memory Update
```

跳过：

```text
Review
FactCheck
Brief / Revision
Proof
```

---

### 7.2 Continuation 极速

仍保留 Freeze 前：

```text
Canon
Boundary
Seam
Anchor
Style
Continuation State
Story Memory
```

随后：

```text
Freeze
→ Shared Draft
→ Local FinalValidate
→ Persist
→ State Extraction / Story Memory
```

不得为了“一次 API”绕过 Canon/Boundary/Seam 构建。

> **一次 API ≠ 不做上下文治理。**

---

## 8. Local Final Validate

极速不做 AI 审稿，但必须保留不增加 API 的本地门禁：

- Final body 非空
- 最低合法正文条件
- 输出不能明显是分析过程/错误结构
- Freeze fingerprint 正确
- Requirements fingerprint 无 drift
- Source fingerprint 无异常
- generationTraceId 有效
- Persist 成功
- Duplicate Freeze = 0
- Post-Freeze live source read = 0
- Post-Freeze live model-setting read = 0
- Story Memory / Continuation State 正常进入后处理

---

## 9. 失败策略

极速档禁止自动补救：

```text
Primary API failed
→ 本章 failed
```

不得自动：

```text
retry
formatter
degrade 到其它档位
切换普通流水线
```

允许用户主动点击“重新生成”。这应创建新的 `generationTraceId / WritingRun`，不属于原任务第二次调用。

UI 可提示：

> 极速生成失败。本模式不会自动重试或调用第二次模型，可手动重新生成，或切换至低/中/高档。

---

## 10. UI / 设置

思考档位升级为：

```text
极速 | 低 | 中 | 高
```

“极速”说明建议：

> **仅调用模型一次，跳过 AI 审查和修订，速度与成本最低。适合网文日更、轻创作和快速草稿。上下文仍按当前弹性预算自动装载。**

副说明：

```text
一次生成 · 不审稿 · 不复写
```

---

## 11. Freeze 与兼容性

旧项目已有低/中/高值保持不变，不强制迁移。

建议由统一配置编译：

```text
User Preset
→ Execution Profile
→ Stage Policy
→ Frozen Stage Reasoning
```

而不是在各 Stage 中散落：

```ts
if (thinkingLevel === 'extreme')
```

极速 Freeze 必须固化：

```text
executionProfile = one_shot
maxPaidLlmCalls = 1
allowFormatter = false
allowPrimaryRetry = false
stage skip policy
stage reasoning
model behavior
existing Context Budget result
Requirements
```

Resume 只能沿用原 Freeze，不得因用户后来修改档位而改变未完成任务。

---

## 12. Trace / Telemetry

建议新增或复用：

```text
executionProfile
paidLlmCallCount
formatterCallCount
retryCallCount
skippedStageCount
chapterE2EMs
inputTokens
outputTokens
freezeFingerprint
generationTraceId
```

极速成功必须满足：

```text
executionProfile = one_shot
paidLlmCallCount = 1
formatterCallCount = 0
retryCallCount = 0
reviewCalls = 0
auditCalls = 0
factCheckCalls = 0
revisionCalls = 0
proofCalls = 0
```

---

## 13. 硬门禁

建议新增：

```text
writingOneShotProfile.test.ts
writingOneShotPaidCallGate.test.ts
writingOneShotStagePolicy.test.ts
writingOneShotElasticBudget.test.ts
writingOneShotResume.test.ts
```

### Gate A：最多一次 API

```text
One-Shot paid LLM calls <= 1
```

任何 Formatter / Retry 触发第二次物理调用必须失败。

### Gate B：不得绕开 Shared Writer

必须仍经过：

```text
runWritingStages
runDraftStage
executeSharedWriterStage
compileSharedWritingPrompt
```

### Gate C：不得覆盖现有 Context Budget

验证：

- one-shot 不写死 input token cap
- 不覆盖 model context window
- 不新增 fast/extreme context builder
- 与标准模式使用同一预算/分配体系

### Gate D：正式 Skip

Review/Audit/FactCheck/Revision/Proof：

```text
status = skipped
skipReason != empty
policyRuleId != empty
```

### Gate E：Resume 不增加调用

场景：

```text
API success
→ Persist 前进程死亡
→ Resume
```

结果必须：

```text
Paid call count 仍 = 1
```

应恢复已持久化 Draft Artifact，不得重复请求。

---

## 14. PDCA 实施顺序

### PDCA-0：Baseline

先记录现有低/中/高：

- Paid API / chapter
- Chapter E2E P50 / P95
- Input Tokens
- Output Tokens
- Formatter Rate
- Retry Rate
- Failure Rate

### PDCA-1：Execution Profile Contract

先写 Red Test：

- one_shot contract
- Freeze 持久化
- Resume 不变

### PDCA-2：Stage Policy

Red：

```text
one_shot:
Review/Audit/FactCheck/Revision/Proof 必须正式 skipped
```

只改 Policy，不改 Shared Stage 实现。

### PDCA-3：Single Paid Call Gate

Red：

- Formatter 触发时必须被 one-shot 阻断
- Retry 必须阻断
- second physical request 必须失败

再做最小修复。

### PDCA-4：Shared Draft Profile Projection

仅在统一 Shared Prompt 中加入 one-shot policy block。

禁止新增极速 Prompt Compiler。

### PDCA-5：Elastic Context Regression

覆盖：

- 大 Outline
- 大 Story Memory
- 大 Canon
- 大 Writer Style
- 最近章节窗口
- 小 Context Window 模型
- 超大 Context Window 模型

确认始终使用现有弹性 Context Budget，不出现新硬 Token 上限。

### PDCA-6：Resume / Crash / Network

测试：

```text
Freeze 后 crash
Draft 成功后 crash
Persist 前 crash
provider timeout
reasoning-only
empty body
content filter
```

自动 Paid Calls 必须 <= 1。

### PDCA-7：真实 LLM

建议至少：

```text
Outline 极速连续 5 章
Continuation 极速连续 5 章
```

每章验证：

- 物理 API = 1
- 正文落库
- Trace 完整
- Story Memory 正常
- Continuation State 正常
- 无第二调用
- 无 Context Budget 回归

---

## 15. 性能验收指标

本轮不要先写死“必须快多少秒”，先建立可重复 Benchmark。

| 指标 | 极速 | 低 | 中 | 高 |
|---|---:|---:|---:|---:|
| Paid API / chapter | | | | |
| E2E P50 | | | | |
| E2E P95 | | | | |
| Input Tokens / chapter | | | | |
| Output Tokens / chapter | | | | |
| Formatter Rate | | | | |
| Retry Rate | | | | |
| Failure Rate | | | | |

极速硬指标：

```text
Paid API Calls / Chapter <= 1
No hidden Formatter
No hidden Retry
No hidden Review
No hard Token cap
```

---

## 16. 最终验收标准

只有以下全部成立，才允许宣布“极速档完成”：

```text
四档 UI = 极速 / 低 / 中 / 高

One-Shot Execution Profile = implemented

ONE Kernel = preserved
ONE Shared Writer Core = preserved
ONE Shared Prompt Compiler = preserved
ONE Freeze = preserved

One-Shot Paid LLM Calls <= 1
Formatter = disabled in one-shot
Automatic Primary Retry = disabled in one-shot

Review = formal skipped
Audit = formal skipped
FactCheck = formal skipped
Revision = formal skipped
Proof = formal skipped

FinalValidate = local PASS
Persist = PASS
Post-writing Update = PASS

Existing Elastic Context Budget = preserved
New hard token cap = 0
Fast/extreme context builder = 0
Fast/extreme writer core = 0
Fast/extreme prompt compiler = 0

Resume Duplicate Paid Call = 0
Post-Freeze Live Source Read = 0
Post-Freeze Live Model Read = 0
Fatal Architecture Regression = 0
```

---

## 17. 最终目标调用图

```text
用户选择“极速”
        ↓
User Preset Compiler
        ↓
Execution Profile = ONE_SHOT
        ↓
Source / Requirements / Existing Elastic Context Budget
        ↓
ONE Freeze
        ↓
ONE Writing Kernel
        ↓
Shared Draft
        ↓
ONE Shared Writer Core
        ↓
ONE Shared Prompt Compiler
        ↓
ONE Paid LLM Call
        ↓
Local Final Validate
        ↓
Shared Persist
        ↓
Story Memory / Continuation State
```

最终原则：

> **极速不是阉割上下文，而是把多轮 AI 流水线压缩成一次高信息密度生成。**

> **资料仍按现有弹性上下文自动预算尽可能完整装入；速度和成本节省来自取消后续 AI 审查、修订、Proof、Formatter 和自动 Retry，而不是通过人为缩短 Context 实现。**
