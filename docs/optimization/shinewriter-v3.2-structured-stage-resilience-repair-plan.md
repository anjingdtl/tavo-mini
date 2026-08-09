# ShineWriter 大纲流水线 V3.2：Review / FactCheck / Brief 阻滞修复与审计质量恢复方案

> 文档状态：Final v1.0，作为直接开发、迁移与验收基线；不代表代码已经完成或验收通过  
> 编写日期：2026-08-10  
> 当前代码基线：`main@97ef7679`，ShineWriter V2.11.40，Schema 48  
> 适用范围：大纲流水线 V3 新建任务，以及 V3.1 失败任务的兼容恢复  
> 前置文档：`shinewriter-v3.1-fail-closed-recovery-literary-quality-plan.md`、`shinewriter-v3.1-emulator-qa-progress-report-20260809.md`  
> 发布策略：直接发布新版本，不进行 A/B 实验；V2 与已冻结 V3.1 任务保留历史兼容语义

---

## 1. 结论与建设原则

`97ef7679` 已经正确实现“必需节点失败即闭锁”和“从失败节点重试”，但尚未解决 Review、FactCheck、Brief 的结构化合同阻滞。当前主要问题不是这三个阶段正常返回时耗时过长，而是合同失败、恢复路径遗漏和重复调用共同放大了流水线停线概率。

V3.2 统一采用以下原则：

1. **继续 fail-closed。** Review、FactCheck、Brief 任一必需节点没有形成有效语义合同，均不得进入 Final/Proof，不得把 Draft 伪装成终稿。
2. **主审节点使用真正的 low Thinking。** Review、FactCheck、Brief 正式调用统一为 `Thinking enabled + low`；Draft 与 Final/Proof 继续按用户选择的 low/high/max 档位执行。
3. **只有 Formatter 关闭 Thinking。** Audit Formatter 与 Brief Formatter 固定使用 `Thinking disabled`，仅整理已有候选判断，不重新阅读 Draft、前文、大纲或资料。
4. **语义判断与传输信封分离。** LLM 只负责 findings、verdict、coverage、修订指令等需要推理的语义；`schemaVersion`、`draftHash`、硬约束、已知边界和安全空容器由本地确定性代码生成。
5. **格式宽容、语义严格。** Markdown 围栏、字段别名、数组包装和本地可确定字段缺失可以归一化；缺少真实审阅判断、事实覆盖凭证或必改指令时仍然失败。
6. **不为格式问题重跑完整主审。** content 或 reasoning 中存在可恢复候选时，只允许一次轻量 Formatter；不得再次注入十几章上下文、Draft 和资料重跑完整 Review/FactCheck。
7. **五个主阶段预算相互独立。** Draft、Review、FactCheck、Brief、Final/Proof 各自获得独立弹性上下文预算，不共享静态总池，不因上游实际消耗改变下游 Thinking 档位。
8. **成功 checkpoint 必须复用。** 用户从失败节点继续时，只重跑第一个失败节点及未成功下游；并行成功的另一审计节点不得重复调用。
9. **结构通过不等于文学通过。** 发布验收必须同时验证上一章衔接、大纲执行、资料一致性、人物状态、空间动作、时间线、重复段落与结尾边界。
10. **V3.1 历史任务不篡改冻结请求。** 旧任务按原 profile 恢复，但可获得候选通道修复、字段级诊断等不改变业务语义的兼容补丁；新任务直接使用 V3.2 合同。

本方案明确废止旧 V3.1 文档中“Review/FactCheck/Brief effective tier 为 low，但 API Thinking disabled”的实现解释。V3.2 中“low Thinking”必须同时满足：Thinking 已启用、effective effort 为 low、请求和冻结快照均可证明这两点。

---

## 2. 独立复核证据

### 2.1 最终构建样本

基于以下真机数据库快照复核：

`test-logs/emulator-qa-v31-reasoning-20260809-223649/db-batch-poll2.sqlite`

最终提示词修复后的四个任务为：

- `pt_mslwtdj6_127`
- `pt_mslxsk5z_128`
- `pt_msly39tu_129`
- `batch_batch_mslyk4b5_p44g6s_ord1_1786289553707`

观察结果：

| 阶段 | 首轮合同通过 | 实际表现 |
| --- | ---: | --- |
| Review | 3/4，75% | 批量首章返回 2,704 visible tokens、`finish_reason=stop`、content-only，但以 `missing_required_fields` 失败 |
| FactCheck | 4/4 | 每次仅 63–74 visible tokens，归一化结果均为零 corrections、零 protectedFacts、零 hardConstraints |
| Brief | 3/3 | 三次到达 Brief 的任务均通过，但样本量不足以证明长期稳定 |
| 完整流水线 | 3/4，75% | 一次 Review 合同失败导致批量后续两章未启动 |

因此，当前 Review 的实时阻断仍未解决。FactCheck 虽然结构通过，但存在“极短空合同被视为成功”的审计有效性风险。Brief 的 hardConstraints 本地信封修复已有正向证据，但尚未经过足够连续样本证明稳定。

### 2.2 调用放大

整个 V3.1 测试周期内：

| 阶段 | 物理 API 调用 | 到达该阶段的任务数 | 额外调用 |
| --- | ---: | ---: | ---: |
| Review | 13 | 11 | 2 |
| FactCheck | 12 | 10 | 2 |
| Brief | 15 | 10 | 5 |
| 合计 | 40 | 31 个阶段实例 | 9 |

相对于每个阶段实例一次正式调用，调用放大约为 29%。已出现的最差个例包括：

- 一个 Review 使用三次完整调用后才成功；
- 一个 FactCheck 使用主调用、Formatter、再次完整主调用共三次；
- 一个 Brief 在人工重试过程中累计五次调用。

这证明阻滞的核心是失败概率和恢复路径，而不是正常阶段的纯推理时长。

### 2.3 正常耗时并非主要矛盾

混合 V3.1 样本平均耗时约为：

- Draft：109.6 秒；
- Review：12.9 秒；
- FactCheck：7.0 秒；
- Brief：4.8 秒；
- Final/Proof：64.5 秒。

Review/FactCheck/Brief 成功时明显短于 Draft 和 Final。V3.2 的性能目标不是继续压缩几秒正常耗时，而是消除结构失败后十几万上下文的重复主审与整批暂停。

### 2.4 文学审计有效性尚未证明

最终构建的三个成功 Review 均为零修订项，只返回 outlineExecution；四个 FactCheck 均为空核查合同；三个 Brief 的 `mustFix` 均为零。

这些结果可能来自干净 Draft，也可能来自关闭 Thinking 后审计深度不足。现有证据无法支持“Review/FactCheck 已经充分履行文学与事实审计职责”。流水线状态成功、JSON 可解析、字数正常均不得代替文学质量验收。

---

## 3. 根因分析

### 3.1 Review/FactCheck Formatter 的确定性入口缺陷

当前恢复入口只使用：

```ts
const recoverableFormatterInput = result.reasoningText?.trim() || '';
```

而 Formatter 构建函数内部实际支持：

```ts
candidate: invalid.reasoningText || invalid.text || ''
```

这导致“content 非空但结构无效、reasoning 为空”的响应永远无法进入 Formatter。本次批量 Review 正好命中该路径：模型已经返回大量 content，但恢复器把它判定为没有可恢复候选并直接停线。

### 3.2 让 LLM 搬运本地已知字段

当前 Review 要求模型精确返回：

- 数字 `schemaVersion=3`；
- 与客户端完全相等的 `draftHash`；
- `corrections`、`protectedFacts`；
- `outlineExecution` 下六个数组和一个字符串。

FactCheck 同样要求模型精确搬运 schema、hash 和多个可能为空的数组。遗漏任意空数组都会令整份数千字分析作废。

这些字段混合了三类性质不同的数据：

1. 客户端已经知道且必须不可变的数据；
2. 可由本地安全补齐的结构容器；
3. 必须由模型推理产生的真实语义。

把三类数据全部交给 LLM 严格复述，是合同脆弱的主要来源。

### 3.3 low 档位被错误实现为 Thinking disabled

当前 `resolveV31StageReasoning` 对 Review、FactCheck、Brief 返回：

```ts
thinking: { type: 'disabled' }
```

同时又将 `effectiveTier` 记录为 low。这会在 UI、日志和测试中形成“看似 low，实际完全未启用 Thinking”的歧义。

结构化输出需要最终答案位于 content，不等于必须关闭 Thinking。正确设计应是：模型在低推理档完成审计，并把最终紧凑合同放入 content；如果 provider 偶发只返回 reasoning，则由本地解析和 Formatter 恢复通道解决。

### 3.4 reasoning-only 恢复仍会重放完整审计

当前 reasoning-only 分支先重新编译完整 Review/FactCheck 请求并再次调用主模型，然后才考虑 Formatter。该路径重复发送 Draft、上下文和资料，既浪费 token，也丢弃第一次 reasoning 已经形成的判断。

V3.2 应优先把现有 reasoning 作为语义候选：本地解析成功则直接归一化；本地无法归一化才调用一次轻量 Formatter。只有两个通道都没有可恢复语义时，阶段才失败并等待用户重试。

### 3.5 字段级诊断被丢弃

校验器已经产生 `details`，例如：

- 缺少 `draftHash`；
- 缺少 `outlineExecution`；
- `outlineExecution.mustNotAdvance` 不是数组；
- 缺少 `hardConstraints`；
- correction 缺少 instruction 或 severity。

当前 attempt 只持久化统一的 `parse_failure_code=missing_required_fields`，没有保存安全的字段路径、根键列表、检测到的合同方言和恢复决策。结果是报告能够证明“合同失败”，却无法确定究竟缺少哪个字段。

### 3.6 FactCheck 允许无覆盖凭证的空成功

`corrections=[]` 本身可以是合法结论，但不能单独证明模型完成过核查。当前四个真实 FactCheck 都返回极短空合同，没有 checkedDimensions、verdict、fact refs 或 coverage receipt。

V3.2 必须区分：

- “完成核查，未发现问题”；
- “没有进行有效核查，但返回了几个空数组”。

前者可通过，后者必须失败。

---

## 4. V3.2 目标架构

### 4.1 总体流程

```text
Draft
  ├─ Review primary（Thinking enabled + low）
  │    └─ 本地候选提取 → 兼容适配 → 语义校验 → 本地不可变信封
  │           └─ 仍为可恢复结构错误 → Audit Formatter（disabled，最多一次）
  └─ FactCheck primary（Thinking enabled + low）
       └─ 本地候选提取 → 兼容适配 → 语义校验 → 本地不可变信封
              └─ 仍为可恢复结构错误 → Audit Formatter（disabled，最多一次）

Review + FactCheck 均真实成功
  └─ Brief primary（Thinking enabled + low）
       └─ 本地归一化 + 不可变信封
              └─ 可恢复结构错误 → Brief Formatter（disabled，最多一次）

Brief 真实成功
  └─ Final/Proof（按用户 low/high/max Thinking）
```

Review 和 FactCheck 保持并行。Brief 只依赖两个已验证合同。任一必需节点最终失败，控制器进入 paused/failed，不进入 Final。

### 4.2 三层合同

每个结构化节点均拆为三层：

#### 第一层：LLM 语义载荷

只包含必须由模型判断的内容，例如 findings、verdict、coverage、修订 instruction。

#### 第二层：本地规范化合同

负责：

- JSON/Markdown 围栏提取；
- 已知字段别名映射；
- 单对象转数组；
- severity/category/target 的安全别名归一化；
- 对候选 findings 分配或去重本地 sourceId；
- 对可安全确定的缺省容器补空数组。

本地规范化不得创造新的文学判断、事实错误或修订要求。

#### 第三层：不可变权威信封

由客户端覆盖并最终签名：

- contract/schema version；
- draftHash/sourceHash；
- 来自大纲与资料的硬边界；
- required source IDs；
- 已验证上游 hardConstraints/protectedFacts；
- allocation trace、reasoning policy 和 request fingerprint。

即使 LLM 试图修改这些字段，也以本地权威值为准并记录 warning。

---

## 5. 推理档位与配置归一化

### 5.1 新任务统一策略

| 阶段 | Thinking | effective tier | 说明 |
| --- | --- | --- | --- |
| Draft | enabled | 用户 low/high/max | 创作主阶段 |
| Review | enabled | 固定 low | 文学、衔接与大纲审计 |
| FactCheck | enabled | 固定 low | 时间线、人物、物品与世界事实核查 |
| Brief | enabled | 固定 low | 将已验证 findings 编译成可执行终稿要求 |
| Final/Proof | enabled | 用户 low/high/max | 终稿创作主阶段 |
| Audit Formatter | disabled | 不参与用户档位 | 只改变格式，不重新审计 |
| Brief Formatter | disabled | 不参与用户档位 | 只整理已有 Brief 语义 |

### 5.2 不允许的配置

以下状态必须在任务创建或恢复时被拒绝：

- `effectiveTier=low` 但 `thinking.type=disabled`，且该请求是 Review/FactCheck/Brief primary；
- Brief 从 Review 或用户总档位继承 high/max；
- Review/FactCheck 因 Draft 使用 high/max 而级联升级；
- Final 因 Brief 固定 low 而被级联降级；
- Formatter 读取用户高档位并开启 Thinking。

### 5.3 Provider 能力记录

冻结快照必须同时记录：

- `requestedThinking`；
- `requestedEffort`；
- `providerSupportsThinking`；
- `providerAppliedThinking`；
- `providerAppliedEffort`；
- 未应用时的兼容原因。

不支持显式 effort 的兼容 Provider 可以省略专有参数，但不得在 UI 或日志中伪装为“已应用 low Thinking”。DeepSeek V4 等支持模型必须实际发送 enabled + low。

---

## 6. V3.2 Review 语义合同

### 6.1 LLM 输出载荷

推荐最小形状：

```ts
interface ReviewSemanticPayloadV32 {
  verdict: 'pass' | 'needs_revision';
  findings: Array<{
    severity: 'hard' | 'required' | 'advisory';
    category:
      | 'opening_continuity'
      | 'outline_execution'
      | 'character'
      | 'prose'
      | 'spatial_logic'
      | 'causality'
      | 'ending_boundary';
    target: {
      kind: 'opening' | 'scene' | 'middle' | 'ending' | 'global';
      sceneHint?: string;
      evidenceQuote?: string;
    };
    finding: string;
    instruction: string;
    preserve?: string[];
  }>;
  outlineAssessment: {
    fulfilled: string[];
    missing: string[];
    deviations: string[];
    premature: string[];
    endingAssessment: string;
  };
  coverage: {
    checkedDimensions: Array<
      | 'opening_continuity'
      | 'outline_execution'
      | 'character'
      | 'prose'
      | 'spatial_logic'
      | 'causality'
      | 'ending_boundary'
    >;
  };
}
```

LLM 不再负责返回 `schemaVersion`、精确 `draftHash`、`protectedFacts` 或六个固定名称的空数组。

### 6.2 本地生成内容

客户端负责：

- 写入 `schemaVersion=4` 和 `auditContractVersion=32`；
- 写入真实 draftHash；
- 为 findings 生成稳定 `sourceId`；
- 从冻结大纲胶囊写入权威 endingGoal、mustNotAdvance 和必须保留事项；
- 将 `outlineAssessment` 映射为现有 Final 所需的 outlineExecution；
- 对缺失但可确定为空的 advisory 容器补空数组。

### 6.3 语义门禁

Review 仅在以下条件满足时成功：

- verdict 合法；
- checkedDimensions 至少覆盖 opening continuity、outline execution、character、prose、ending boundary；
- `verdict=needs_revision` 时至少存在一条 hard/required finding；
- `verdict=pass` 时 findings 可以为空，但 coverage 不得为空；
- 每条 hard/required finding 都有 finding、instruction 和语义 target；
- 没有越过冻结的下一章边界；
- sourceId 全部由本地生成或映射，不接受模型随意创造的权威 ID。

缺少 coverage 不得通过本地填空伪装为审阅完成。

---

## 7. V3.2 FactCheck 语义合同

### 7.1 LLM 输出载荷

```ts
interface FactCheckSemanticPayloadV32 {
  verdict: 'pass' | 'needs_revision' | 'not_applicable';
  findings: Array<{
    severity: 'hard' | 'required' | 'advisory';
    category:
      | 'timeline'
      | 'character_state'
      | 'object_state'
      | 'world_rule'
      | 'spatial_logic'
      | 'knowledge_boundary'
      | 'outline_boundary';
    target: {
      kind: 'opening' | 'scene' | 'middle' | 'ending' | 'global';
      evidenceQuote?: string;
    };
    factRef?: string;
    finding: string;
    instruction: string;
  }>;
  confirmedFactRefs: string[];
  coverage: {
    checkedDimensions: Array<
      | 'timeline'
      | 'character_state'
      | 'object_state'
      | 'world_rule'
      | 'spatial_logic'
      | 'knowledge_boundary'
      | 'outline_boundary'
    >;
    checkedFactRefs: string[];
  };
}
```

### 7.2 本地权威信封

以下内容不得要求 LLM 搬运：

- schemaVersion、draftHash；
- 输入事实清单的 ID 与文本；
- 资料、大纲和上一章接缝中的 hardConstraints；
- 已知 protectedFacts；
- 禁止提前推进的 outline boundary。

FactCheck 的职责是判断 Draft 是否违反这些事实，而不是重新生成一份事实数据库。

### 7.3 空结果规则

`findings=[]` 只有在以下条件下才可通过：

- verdict 明确为 pass；
- checkedDimensions 非空并覆盖所有有输入材料的维度；
- 有事实输入时，checkedFactRefs/confirmedFactRefs 至少能证明实际读取过相关事实；
- 输入确实没有可核查资料时，允许 `not_applicable`，但必须记录 `FACT_CONTEXT_EMPTY` warning，不能显示成完整事实核查通过。

这将阻止“63 token 三个空数组”被当作充分核查证据。

---

## 8. V3.2 Brief 语义合同

### 8.1 保留一次 LLM Brief 调用

Brief 继续作为独立 API 节点，固定使用 enabled + low Thinking。它不是本地模板替代品，其职责是把 Review/FactCheck 的离散发现压缩为 Final 可执行的写作要求。

### 8.2 LLM 输出载荷

```ts
interface BriefSemanticPayloadV32 {
  verdict: 'apply_changes' | 'no_changes';
  instructions: Array<{
    sourceIds: string[];
    priority: 'hard' | 'required' | 'advisory';
    target: 'opening' | 'scene' | 'middle' | 'ending' | 'global';
    instruction: string;
    preserve?: string[];
  }>;
  openingContinuity: string[];
  styleAdvisories: string[];
}
```

### 8.3 本地信封继续负责

- sourceHash；
- requiredSourceIds；
- protectedFacts；
- hardConstraints；
- mustNotAdvance；
- outlineObligations；
- endingBoundary。

### 8.4 Brief 门禁

- 上游存在 hard/required sourceId 时，`verdict=no_changes` 无效；
- 每个 requiredSourceId 必须被至少一条 instruction 覆盖；
- LLM 遗漏或改写本地不可变字段不失败，由本地权威信封覆盖并记录 warning；
- instruction 缺失、sourceId 指向不存在上游发现、或出现相互冲突的 hard 指令时失败；
- 上游没有必改项时允许 `no_changes`，但仍保留一次 Brief API 调用，并要求返回开篇衔接或保持策略。

---

## 9. 候选提取与 Formatter 恢复

### 9.1 双通道候选选择

新增统一 `selectStructuredCandidate`：

1. 尝试直接解析 content；
2. 尝试从 content 的 Markdown 围栏、前后说明或多对象文本中提取 JSON；
3. 尝试直接解析 reasoning；
4. 尝试从 reasoning 中提取 JSON；
5. 若两侧都有候选，根据已知根键、finding 数量、coverage 完整度和截断状态选择语义得分更高者；
6. 记录选择通道、候选长度、根键、hash 和拒绝原因。

不得再使用“只有 reasoning 非空才允许 Formatter”的单通道条件。

### 9.2 可恢复结构错误

以下情况允许本地适配或一次 Formatter：

- JSON 被 Markdown 围栏包裹；
- content 前后有简短解释文字；
- recognized legacy/V3.1 字段别名；
- findings/corrections 单对象与数组漂移；
- severity、target、category 使用已知别名；
- 缺少 schemaVersion、draftHash 等本地确定字段；
- 缺少可以安全确定为空的展示容器；
- reasoning-only 但包含清晰审计判断；
- content 非空且包含完整语义，但合同形状不符。

### 9.3 不可恢复语义错误

以下情况不得由 Formatter 补造：

- content_filter；
- 两个通道都为空；
- 输出明显截断且最后一条 finding/instruction 不完整；
- 返回小说正文而非审计报告，且没有可提取判断；
- verdict=pass 但没有 coverage receipt；
- verdict=needs_revision 但没有任何可执行 finding；
- Brief 缺少上游 requiredSourceId 对应的真实 instruction；
- 候选含无法映射到任何上游 finding 的伪造 sourceId；
- Formatter 试图新增候选中不存在的判断。

不可恢复时立即 fail-closed，并显示“从失败节点重试”。

### 9.4 Formatter 调用约束

每个阶段每次用户触发的运行最多一次 Formatter：

- Thinking disabled；
- 仅输入候选、合同 schema、允许字段、上游合法 ID manifest；
- 不输入 Draft、前十章、长记忆、大纲全文、人物卡或世界书；
- 输出预算根据候选长度和合同复杂度弹性计算；
- Formatter 调用失败后不自动重跑完整主审；
- Formatter 产物重新经过同一语义校验器，不能绕过门禁。

### 9.5 sourceId 生成

当前 Formatter 通过正则从候选中的 `"id"` 提取 legalSourceIds，无法覆盖 `sourceId` 别名、非标准 JSON 或没有 ID 的有效 findings。

V3.2 改为：

1. 本地解析每条语义 finding；
2. 按 stage、序号、category、finding hash 生成稳定 sourceId；
3. 将生成后的 manifest 交给 Formatter；
4. Formatter 只能引用 manifest 中的 ID；
5. 最终本地再次校验覆盖关系。

Formatter 不负责创造权威 ID。

---

## 10. 失败恢复状态机

### 10.1 正常结构错误

```text
primary API 成功
  → 本地解析失败
  → 候选存在且错误可恢复
  → Formatter 一次
      → 合同有效：stage success
      → 合同仍无效：stage failed/paused
```

不得插入第二次完整 primary 调用。

### 10.2 真正空响应或网络失败

- 网络错误、429、5xx 按现有 request policy 做有限传输重试；
- provider 明确返回空 content 且 reasoning 也为空，阶段失败；
- reasoning-only 且 reasoning 有语义，直接进入本地解析/Formatter；
- reasoning-only 但 reasoning 只是过程碎片，没有结论，阶段失败；
- 用户从失败节点重试时重新调用该 primary，成功 checkpoint 不重跑。

### 10.3 并行 Review/FactCheck

若 Review 失败、FactCheck 成功：

- 保存 FactCheck success checkpoint；
- 整体任务 paused；
- 用户重试只执行 Review；
- Review 成功后直接进入 Brief；
- FactCheck 不重复计费。

反向情况同理。

### 10.4 批量任务

- 当前子章失败时批次暂停；
- 后续子章不得启动；
- 用户从失败节点继续后，先完成当前子章；
- 当前子章 Final 成功并采纳后，才允许下一章读取更新后的上一章正文；
- 不允许并发生成存在章节依赖的后续 Draft。

---

## 11. 上下文预算与 token 分账

### 11.1 五阶段独立弹性预算

Draft、Review、FactCheck、Brief、Final/Proof 每次都是独立 API 请求，预算计算必须分别进行：

```text
stageAvailable = providerContextWindow
               - stageEstimatedInput
               - stageSafetyMargin

stageReservedOutput = complexityAwareReservation(stage, stageAvailable)
```

要求：

- 不设一个全流水线共享 token 池；
- 不因 Draft 消耗较多而扣减 Review/FactCheck/Brief/Final 的上下文窗口；
- 不因 Review 实际输出较少而把“剩余预算”级联给 Brief；
- 不用小型固定上限锁死 Brief；
- 上限只受当前请求物理 context window、安全边界和 provider 限制约束；
- 输入超窗时按本阶段材料优先级收缩，不改变其他阶段预算。

### 11.2 Thinking 与上下文预算解耦

预算分配器只负责可用 token；reasoning policy 只负责 Thinking enablement 和 effort。两者在任务创建时统一归一化，但不得互相隐式覆盖。

例如：Brief 的上下文预算可以因复杂度增加而扩大，但其 Thinking 始终为 enabled + low，不得自动升级 high，也不得因预算紧张变成 disabled。

### 11.3 分账字段

每个 physical attempt 必须分别记录：

- input tokens；
- visible output tokens；
- reasoning tokens；
- total tokens；
- primary/formatter；
- candidate channel；
- formatter 是否使用；
- contract first-pass 是否成功；
- stage 最终是否成功。

UI 不得继续把“HTTP/API 调用成功”与“合同校验成功”显示成同一个 succeeded。

---

## 12. Schema 49 与持久化

当前仓库为 Schema 48。V3.2 建议升级至 Schema 49，在 `pipeline_stage_attempts` 增加：

```sql
ALTER TABLE pipeline_stage_attempts
  ADD COLUMN response_candidate_temp TEXT;

ALTER TABLE pipeline_stage_attempts
  ADD COLUMN response_candidate_channel TEXT;

ALTER TABLE pipeline_stage_attempts
  ADD COLUMN validation_details_json TEXT;
```

### 12.1 response_candidate_temp

- 只用于 API 已返回、阶段尚未终态时的崩溃恢复；
- 最长保存本地允许的 Formatter 候选长度；
- 阶段成功或最终失败后立即清空；
- 不写入日志；
- 不进入备份导出；
- 旧 `reasoning_content_temp` 保留用于 V3.1 兼容读取，新任务改用通用候选字段；
- 所有清理路径同时清除两种 temp 字段。

### 12.2 response_candidate_channel

允许值：`content`、`reasoning`、`both_content_preferred`、`both_reasoning_preferred`。阶段终态时可以保留通道枚举，但正文候选必须清空。

### 12.3 validation_details_json

只保存安全结构信息，不保存用户正文或模型长回答：

```ts
interface ValidationDetailsV1 {
  version: 1;
  failureCode: string;
  missingPaths: string[];
  invalidPaths: string[];
  detectedDialect?: string;
  rootKeys: string[];
  candidateChannel?: string;
  candidateChars: number;
  candidateHash?: string;
  findingCount?: number;
  requiredFindingCount?: number;
  coverageDimensions?: string[];
  formatterEligible: boolean;
  formatterDecision: string;
}
```

该字段用于结果页诊断、测试报告和故障统计，避免再次出现只能看到 `missing_required_fields`、无法知道具体缺项的情况。

### 12.4 迁移要求

- 新建 `v48-to-v49.ts` 幂等迁移；
- 同步 `createCurrentSchema.ts`、schema manifest、validator 与迁移夹具；
- 对 recorded-49 但物理缺列的漂移库执行启动期检查；
- schema-recovery backup 不得包含临时候选正文；
- 迁移测试覆盖 48→49、旧库升级、新库直建和重复执行。

---

## 13. 版本与历史任务兼容

### 13.1 新任务

新建 V3.2 任务冻结：

- `pipeline_context_json.version=4`；
- `auditContractVersion=32`；
- `reasoningProfileVersion=4`；
- `briefPolicyVersion=3`；
- stage request version 使用 32；
- workflow stage graph 仍为 Draft→Review/FactCheck→Brief→Final，不升级为另一条产品流水线。

### 13.2 V3.1 历史任务

- 不改写其 frozen messages、request fingerprint 或原 reasoning profile；
- 继续允许 disabled Thinking 的旧请求按历史语义恢复；
- 可以应用双通道候选选择、content Formatter 入口修复、字段级诊断和临时 scratch 持久化；
- 已成功 checkpoint 原样复用；
- 不因应用升级把历史成功 Review/FactCheck 重新判无效。

### 13.3 当前暂停 N=3

当前批量首章已经保存 Draft 和 FactCheck success checkpoint。升级兼容补丁后：

- 用户点击“从失败节点重试”；
- 只重新调用 Review；
- FactCheck 不重跑；
- 新返回如果再次出现 content 合同形状漂移，应由 Formatter 自动恢复；
- 因此前 5,021 字候选正文已经被清空，本次不可避免需要一次新的 Review primary 调用。

若要让该历史任务使用 V3.2 low Thinking 新合同，应显式创建派生恢复任务，不得静默修改原任务冻结语义。默认建议先用 V3.1 兼容修复完成当前批次，再用新任务执行 V3.2 正式验收。

---

## 14. UI 与可观测性

### 14.1 结果页状态

每个结构化阶段区分显示：

- API 请求成功；
- 本地合同首轮通过；
- 经本地兼容适配通过；
- 经 Formatter 恢复通过；
- 合同失败并暂停。

不得把 physical attempt 的 `status=succeeded` 直接翻译成阶段成功。

### 14.2 用户可见诊断

失败卡片显示：

- 阶段名；
- 失败类别；
- 安全字段级原因，例如“缺少 Review.coverage.checkedDimensions”；
- 是否已经尝试 Formatter；
- 已复用哪些成功 checkpoint；
- “从失败节点重试”按钮。

不展示 reasoning 正文、完整模型响应或用户资料内容。

### 14.3 成功提示

示例：

```text
文学评估 · 成功
合同首轮通过 · low Thinking
```

或：

```text
文学评估 · 成功
合同经轻量 Formatter 恢复 · 未重跑完整审阅
```

Brief 的本地不可变信封覆盖属于正常归一化提示，不使用红色错误样式。

---

## 15. 代码改造范围

### 15.1 推理策略

- `src/services/pipeline/reasoningPolicy.ts`
  - 新增 V3.2 profile；
  - Review/FactCheck/Brief primary 改为 enabled + low；
  - Formatter 保持 disabled；
  - 保留 V2/V3.1 历史 profile。
- `src/services/pipelineTaskContext.ts`
  - 冻结并验证 V3.2 reasoning/config 版本；
  - 禁止 low tier + disabled primary 的伪配置；
  - 保留旧 context 解析。

### 15.2 提示词与合同

- `src/services/pipelineMessages.ts`
  - 新建 Review/FactCheck V3.2 语义载荷提示词；
  - 删除要求模型复述 hash、schema 和空容器的指令；
  - 加入 coverage receipt 和 verdict。
- `src/services/pipeline/revisionAuditValidator.ts`
  - 增加 V3.2 语义校验；
  - 明确结构错误与语义错误分类；
  - 输出字段级 validation details。
- 新建 `src/services/pipeline/auditSemanticEnvelope.ts`
  - 构建 Review/FactCheck 本地不可变信封；
  - 生成稳定 sourceId；
  - 不允许新增模型判断。
- `src/services/pipeline/v31AuditCompatibility.ts`
  - 保留旧任务适配；
  - 新增单独的 V3.2 compatibility adapter，避免继续扩大 V3.1 泛化范围。

### 15.3 Formatter 与 reconcile

- `src/services/pipeline/auditFormatter.ts`
  - 接收本地 manifest；
  - 移除仅通过 `"id"` 正则生成 legal IDs 的逻辑；
  - 输出 V3.2 semantic payload，不搬运不可变信封。
- `src/services/pipeline/briefFormatter.ts`
  - 对齐 V3.2 Brief semantic payload；
  - 保持无 Draft/长上下文。
- `src/services/pipeline/reconcile.ts`
  - 新增双通道候选选择；
  - content-invalid 也允许 Formatter；
  - 删除 reasoning-only 的自动完整主审重放；
  - 将 validation details 持久化；
  - 保持 fail-closed 和 checkpoint 复用。

### 15.4 数据层

- `src/services/migrations/v48-to-v49.ts`
- `src/services/migrations/index.ts`
- `src/data/schema/createCurrentSchema.ts`
- `src/services/database/schemaManifest.ts`
- `src/data/repositories/pipelineStageAttemptRepository.ts`
- `src/services/backupService.ts`

### 15.5 UI

- `src/screens/PipelineResultScreen.tsx`
- `src/components/PipelineResultPrompt.tsx`
- `src/screens/MultiChapterBatchScreen.tsx`

补充结构恢复状态、字段级错误和 checkpoint 复用说明；保留失败节点重试按钮。

---

## 16. 自动化测试要求

### 16.1 推理策略测试

1. 新 V3.2 的 Review/FactCheck/Brief 均为 enabled + low；
2. Draft/Final 随用户 low/high/max；
3. Formatter 始终 disabled；
4. V3.1 冻结任务仍按旧 disabled profile 恢复；
5. 不支持显式 effort 的 Provider 正确记录未应用状态。

### 16.2 候选与 Formatter 回归

必须新增能够命中本次真实缺陷的 runner 级测试：

1. content 非空、reasoning 为空、合同缺字段 → Formatter 被调用一次并成功；
2. reasoning-only 且包含完整语义 → 不重跑完整 primary，直接本地解析或 Formatter；
3. content 与 reasoning 都有候选 → 选择语义完整度更高者；
4. content_filter → 不调用 Formatter，直接失败；
5. 两通道均空 → 失败；
6. Formatter 再次无效 → 失败并显示重试；
7. 同一运行不得调用两个 Formatter；
8. parse-only 错误的完整 primary replay count 必须为 0。

### 16.3 语义合同测试

1. 缺 schema/hash 但语义完整 → 本地信封补齐并成功；
2. Review pass 但 coverage 缺失 → 失败；
3. Review needs_revision 但没有 finding → 失败；
4. FactCheck 空 findings 且 coverage 完整 → 成功；
5. FactCheck 三个空数组且无 coverage → 失败；
6. Brief no_changes 且上游存在 required IDs → 失败；
7. Brief 覆盖全部 required IDs → 成功；
8. Formatter 试图新增 finding/sourceId → 失败；
9. 本地硬约束与 LLM 输出冲突 → 本地值覆盖并 warning；
10. V3.1 recognized legacy shape 继续兼容，任意无关对象不通过。

### 16.4 状态机与批量测试

1. Review 失败、FactCheck 成功 → paused，FactCheck checkpoint 保留；
2. 从 Review 重试 → FactCheck 不重跑；
3. Brief 失败 → Final 不启动；
4. Formatter 期间杀进程 → 冷启动从 response candidate scratch 恢复；
5. 终态后所有候选正文 temp 清空；
6. 批量当前章失败 → 后续章不启动；
7. 当前章恢复并采纳后 → 下一章读取新的上一章正文；
8. V2 历史任务行为不变。

### 16.5 Schema 49 测试

- 48→49 迁移；
- 新库直建；
- 重复迁移幂等；
- recorded-49 物理缺列检测；
- 备份过滤 response candidate temp；
- repository insert/update/clear/read；
- schema manifest 与 validator 同步。

最终必须执行：

```bash
npm run verify
```

不得仅报告 suite/test 数量，必须同时报告本方案新增测试文件和关键失败分支覆盖情况。

---

## 17. 真实 LLM 与文学质量验收

本轮不做 A/B 实验，直接验证 V3.2 是否达到发布标准。

### 17.1 测试组合

- 3 个真实单章任务；
- 1 个真实 N=3 顺序批量任务；
- 合计至少 6 个完成章节；
- 使用包含前文章节、长记忆、大纲、人物资料和世界设定的真实项目；
- 至少一个受控 Draft 夹具包含明确时间矛盾、人物状态冲突和越界剧情，用于证明 Review/FactCheck 不是空审计器。

### 17.2 稳定性门槛

- 6 个章节全部完成，无人工从头重启任务；
- 结构漂移允许由单次 Formatter 自动恢复；
- 任一 parse-only 问题不得重跑完整 Review/FactCheck/Brief primary；
- 任一必需语义缺失必须 fail-closed；
- 从失败节点继续时，已成功 checkpoint 重复调用数为 0；
- 批量不出现 Draft 冒充 Final、跳过 Brief 或后续章提前启动；
- 每个结构化阶段最多一次 primary + 一次 Formatter；
- candidate scratch 在阶段终态后全部清空。

### 17.3 审计有效性门槛

- Review 与 FactCheck 的 coverage receipt 完整率为 100%；
- 受控错误夹具中的硬错误必须全部被对应审计阶段识别；
- Brief 必须覆盖全部 hard/required source IDs；
- Final 必须落实全部 hard/required 指令；
- 空 findings 只有在 verdict+coverage 同时有效时允许通过；
- 不以 visible token 数、JSON 字段齐全或阶段成功替代审计质量判断。

### 17.4 每章文学人工复核

每章均逐项记录：

1. 开头是否自然承接上一章末尾的时间、地点、动作、在场人物和情绪；
2. 是否完整执行当前章大纲必达节拍；
3. 是否提前推进下一章或泄露禁区信息；
4. 人物身份、称谓、知识范围、持有物和伤势是否符合资料；
5. 世界规则、时间线、空间动作和因果链是否自洽；
6. Review/FactCheck 必改项是否在 Brief 中保真；
7. Final 是否逐项落地 Brief；
8. 是否存在大段重复、机械总结、语义回环或异常截断；
9. 结尾是否满足 ending boundary；
10. 整体行文是否达到可直接采纳的小说正文标准。

任一章出现硬连续性矛盾、越界剧情、资料冲突、必改项遗漏或明显段落重复，即判文学验收失败，不得用其余章节平均分抵消。

---

## 18. 实施顺序

### 第一批：V3.1 兼容热修

1. 修复 Review/FactCheck Formatter 的 content 候选入口；
2. 增加双通道候选选择；
3. 保存字段级 validation details；
4. 移除 reasoning-only 的完整主审自动重放；
5. 增加本次 2,704 visible token content-invalid 的回归测试；
6. 保持旧冻结任务 reasoning profile 不变。

完成后，可从失败 Review 恢复当前 N=3，验证不再因同类格式漂移直接停线。

### 第二批：V3.2 合同切换

1. 新增 enabled + low reasoning profile；
2. 建设 Review/FactCheck semantic payload；
3. 建设本地 audit immutable envelope；
4. 建设 FactCheck coverage receipt；
5. 升级 Brief semantic payload 与覆盖门禁；
6. 新任务切换至 context version 4 / contract version 32。

### 第三批：Schema 49 与 UI

1. 增加通用 candidate scratch 和 validation details；
2. 补全备份过滤、漂移检查、迁移测试；
3. UI 区分 API 成功、合同成功、Formatter 恢复和最终失败；
4. 保证所有失败页都有从失败节点重试。

### 第四批：完整验收

1. `npm run verify`；
2. Debug APK 构建与 `adb install -r` 保留数据升级；
3. 当前 N=3 失败节点恢复验证；
4. 新 V3.2 三单章 + N=3；
5. 六章文学人工复核；
6. 输出调用次数、token 分账、Formatter 命中和 checkpoint 复用报告。

四批均属于同一版本直接建设，不是 A/B 实验。可以分提交实施，但发布时必须整体满足 DoD。

---

## 19. 发布阻断条件

出现以下任一情况不得宣布 V3.2 验收完成：

- Review/FactCheck/Brief primary 仍为 Thinking disabled；
- UI 显示 low Thinking，但冻结请求证明 Thinking 未启用；
- content 非空的结构错误没有进入 Formatter；
- reasoning-only 会自动重放完整 Draft/上下文；
- FactCheck 无 coverage 的空数组可以成功；
- 模型遗漏 schema/hash/空容器仍导致整个语义报告作废；
- Formatter 可以新增候选中不存在的判断；
- 任一必需节点失败后仍进入 Final；
- 失败页缺少“从失败节点重试”；
- 重试重复调用已成功并行 checkpoint；
- 五个主阶段未独立分配弹性上下文预算；
- Brief 被重新锁定为静态小输出预算；
- 真实 N=3 未完成；
- 六章文学复核缺失，或存在硬连续性/资料/越界问题；
- 只以 `npm run verify` 和测试数量代替真实 LLM 与文学验收。

---

## 20. Definition of Done

V3.2 只有同时满足以下条件才能交付：

1. Review/FactCheck/Brief primary 为 enabled + low Thinking，真实请求证据可查；
2. Draft/Final 按用户档位，Formatter 固定 disabled；
3. 五个主阶段分别获得独立弹性上下文预算；
4. Review/FactCheck 使用语义载荷 + 本地不可变信封；
5. Brief 保留独立 low Thinking API 调用，并由本地信封承载不可变约束；
6. content 和 reasoning 都能成为 Formatter 候选；
7. parse-only 恢复不重跑完整主审；
8. FactCheck 空成功必须有有效 coverage receipt；
9. 所有必需节点继续 fail-closed；
10. 所有失败状态均可从第一个失败节点继续并复用 checkpoint；
11. Schema 49、备份过滤、漂移检查和冷启动恢复通过；
12. `npm run verify` 通过；
13. 当前暂停 N=3 从 Review 恢复并完成；
14. 新 V3.2 三单章和 N=3 全部完成；
15. 六章逐章文学复核通过；
16. 报告同时给出真实调用数、primary/formatter 分账、visible/reasoning token、失败分类和文学结论；
17. V2 与 V3.1 历史任务兼容测试通过；
18. Debug APK 升级安装后配置、数据库、已采纳正文和任务记录保留。

只有达到以上全部条件，才可以使用“Review/FactCheck/Brief 阻滞问题已解决”“V3.2 已验收完成”或同等表述。

---

## 附录 A：交给实施 Agent 的完整执行提示词

以下提示词可直接复制给负责开发、模拟器穿测、报告与提交的 Agent：

```text
请在 F:\ClaudeWorkSpace\projects\TAVO-MINI 仓库中，严格按照
docs/optimization/shinewriter-v3.2-structured-stage-resilience-repair-plan.md
完成 ShineWriter V3.2 的 Review / FactCheck / Brief 阻滞修复、自动化验证、真实 LLM 模拟器穿测、测试报告、提交与推送。

一、执行基线与边界

1. 开始前完整阅读仓库 AGENTS.md、本方案、README.md、CHANGELOG.md、docs/EMULATOR_QA_PLAYBOOK.md、docs/FAULT_INJECTION_MATRIX.md，以及 tavo-mini-emulator-qa skill 的 SKILL.md，并按其中要求执行。
2. 先检查 git status、当前分支、HEAD、Node/JDK/Android/adb 环境、已连接模拟器、应用版本和数据库 Schema。保留用户已有改动与未跟踪文件，不得删除、覆盖或提交无关文件，尤其不得提交仓库根目录现有的“--out”临时文件。
3. 本轮直接建设 V3.2，不做 A/B 实验。不得通过放松 fail-closed、跳过 Review/FactCheck/Brief、把 Draft 当 Final、降低文学门禁或重复生成多个候选投票来换取表面通过率。
4. Draft、Review、FactCheck、Brief、Final/Proof 必须各自获得独立弹性上下文预算。Review/FactCheck/Brief primary 必须真实使用 Thinking enabled + low；Draft/Final 按用户档位；Audit/Brief Formatter 固定 Thinking disabled。
5. V2 和已冻结 V3.1 任务保持历史兼容。不得静默改写旧任务的 frozen request、request fingerprint 或 reasoning profile。

二、开发与自动化验证

1. 按方案完成双通道候选选择、content-invalid Formatter 恢复、reasoning-only 不重放完整主审、语义载荷与本地不可变信封拆分、FactCheck coverage receipt、Brief sourceId 覆盖、字段级诊断、Schema 49、备份过滤、冷启动恢复、UI 状态区分和失败节点重试。
2. 必须增加 runner 级回归测试，明确覆盖“content 非空、reasoning 为空、missing_required_fields 时仍调用一次 Formatter”的本次真实缺陷。不能只测试 Formatter prompt builder。
3. 必须证明 parse-only 错误不会再次调用完整 Review/FactCheck/Brief primary；每个结构化阶段每次运行最多一次 primary + 一次 Formatter。
4. 必须证明无 coverage 的 FactCheck 空数组合同不能成功，且存在 hard/required sourceId 时 Brief 不得以 no_changes 通过。
5. 运行针对性测试后执行 npm run verify。若失败，修复本轮范围内的问题并重新执行，直至完整通过。记录最终 suite/test 数量，但不得把 verify 通过等同于真实 LLM 或文学质量验收通过。

三、Debug APK 构建与模拟器升级安装

1. 使用项目标准命令 npm run apk:debug 构建 Debug APK，产物只能使用 dist/apk/debug/ShineWriter-V<ver>-debug.apk。
2. 使用 adb install -r 对当前已配置真实 LLM 的模拟器进行升级安装。禁止 uninstall、pm clear、删除数据库、重置应用数据或重新创建模拟器；必须保留现有 API 配置、Keystore 中的密钥、项目资料、章节和数据库。
3. 安装前后分别记录 package/version、数据库 Schema、项目数量、LLM 配置记录数量和关键任务数量，确认升级安装没有清空数据。不得在日志或报告中输出 API Key、Authorization header 或其他密钥。
4. 若本轮代码修复后重新构建 APK，继续使用 adb install -r 覆盖升级，并再次确认数据和 LLM 配置保留。

四、真实 LLM 模拟器穿测

必须使用模拟器软件中已经配置好的真实 LLM，不得用 mock、伪造响应、数据库直接写入成功状态或只跑 Jest 代替以下穿测。开始真实调用前记录模型名称、Provider 类型和非敏感配置；不得泄露密钥。

A. 三个真实单章测试

1. 连续完成 3 个不同章节的单章流水线，每章必须完整经过 Draft→Review/FactCheck→Brief→Final/Proof。
2. 每个任务记录 taskId、目标章节、五阶段状态、开始/结束时间、耗时、input/visible/reasoning/total token、physical attempt 数、response channel、parse failure、Formatter 使用、checkpoint 复用和最终字数。
3. 若结构化阶段发生格式漂移，确认系统自动执行的恢复不超过一次 Formatter，且没有重跑完整主审。
4. 若任一必需阶段最终失败，必须停在失败页并出现“从失败节点重试”；执行重试验证时，只允许重跑失败节点及未成功下游，已成功并行 checkpoint 不得重复调用。

B. 一键写 N 章的三章生成测试

1. 在 UI 中使用“一键写 N 章”，明确设置 N=3，真实完成三个顺序章节，不得只验证批次能够启动。
2. 验证章节严格顺序执行：上一章 Final 成功并采纳后，下一章才开始，并读取刚生成的上一章作为连续性上下文。
3. 任一子章失败时，批次必须暂停，后续章不得提前启动；从失败节点恢复后，应继续完成当前章和剩余章节，不得重做已经成功的 Draft、Review、FactCheck 或 Brief checkpoint。
4. 三章全部完成后记录 batchId、三个 child taskId、每章调用/耗时/token/Formatter/checkpoint 数据以及总流水线耗时。

五、文学质量逐章验收

上述 3 个单章和 N=3 的 3 个章节合计至少 6 章，每章都必须人工阅读上一章结尾、当前章大纲、可用人物/世界观/长记忆资料、Draft、Review、FactCheck、Brief 和 Final，逐项给出有证据的判断：

1. 开篇是否自然承接上一章的时间、地点、动作、人物状态和未完成事件；
2. 是否完成当前章大纲必达节拍；
3. 是否提前推进下一章、泄露 mustNotAdvance 内容或越过 ending boundary；
4. 人物身份、称谓、知识范围、关系、伤势和持有物是否符合资料；
5. 时间线、空间动作、世界规则和因果链是否自洽；
6. Review/FactCheck 是否产生有效 coverage，是否识别实际存在的问题，而非只返回空数组；
7. Brief 是否完整覆盖所有 hard/required sourceId；
8. Final 是否落实全部必改项，同时保留 protectedFacts/hardConstraints；
9. 是否存在大段重复、机械总结、语义回环、突兀跳转、异常截断或协议文本泄漏；
10. 是否达到可以直接采纳的小说正文质量。

每章必须引用短小的具体文本证据或明确的情节事实支持结论。不得仅凭“阶段成功”“字数正常”“JSON 有效”判文学质量通过。任一硬连续性矛盾、资料冲突、越界剧情、必改项遗漏或明显重复均应判该章不通过并记录。

六、穿测中发现问题的处理规则

1. 若问题的修复不违背本方案，可直接定位、修改、补测试、重新构建并使用 adb install -r 升级安装，然后从最小受影响节点或用例重新验证。
2. 修复必须保持：fail-closed、失败节点重试、checkpoint 复用、五阶段独立弹性预算、Review/FactCheck/Brief enabled + low、Formatter disabled、语义严格和 Final 文学质量要求。
3. 若某个候选修复会违背本方案、改变已确认产品决策、要求放过无效合同、关闭 low Thinking、重复完整主审、删除用户数据或扩大到无关架构，只记录现象、证据、影响和建议，不实施，也不擅自判定采用哪个方向。
4. 对外部 Provider 故障、真实模型随机性或无法在本轮安全修复的问题，同样保留完整证据并如实标记为未解决；不得伪装成功。
5. 每次修复后必须补对应自动化回归测试，并重跑受影响的真实穿测；不得只修改提示词后沿用修复前结果。

七、证据与完整测试报告

所有新增截图、UI tree、logcat、SQLite 快照、SQL 查询结果和过程记录写入 test-logs 下本轮独立时间戳目录，不得污染仓库根目录。敏感内容必须脱敏。

最终在 docs/optimization/ 下输出一份完整 Markdown 测试报告，至少包含：

1. 代码基线、最终 commit、应用版本、Schema、设备/模拟器信息；
2. 实施内容与关键文件清单；
3. npm run verify 的完整结论和测试数量；
4. Debug APK 绝对路径、文件大小/hash、adb install -r 结果；
5. 升级前后数据与真实 LLM 配置保留证据；
6. 三个单章逐任务结果；
7. 一键 N=3 的 batch/child 逐任务结果；
8. 每个阶段的调用次数、耗时、input/visible/reasoning/total token、首轮合同通过、Formatter 恢复、失败分类和 checkpoint 复用；
9. 六章逐章文学质量评价与具体证据；
10. 发现的问题、已修复问题、未解决问题、因违背方案而仅记录的问题；
11. 对本方案全部 Definition of Done 和发布阻断条件逐条给出 PASS/FAIL/NOT RUN 与证据路径；
12. 明确最终结论：通过、部分通过或不通过。存在未完成 N=3、未完成文学复核、必需节点伪成功、重复完整主审或硬连续性问题时，不得写“验收完成”。

八、Git 提交与推送

1. 全部开发、自动化验证、APK 升级穿测、真实 LLM 测试和完整报告完成后，再检查 git diff/status，确认不包含 API Key、数据库、APK、截图、根目录临时文件“--out”或其他无关产物。
2. 只提交本轮源代码、测试、Schema/迁移和正式 Markdown 文档。遵循仓库现有忽略规则，不强行提交 test-logs 临时证据或 dist APK，除非仓库规则明确要求。
3. 在 main 分支创建清晰的一次或少量有意义 commit；提交前再次运行必要门禁。
4. 按用户授权将最终提交 git push 到远端 main。不得 force push、rebase 已推送历史或覆盖他人提交。
5. 最终回复必须给出：测试结论、报告路径、APK 路径、commit hash、push 结果、剩余问题，以及未提交本地文件列表。

在所有工作完成前持续推进，不要因为单次真实 LLM 失败或一次 APK 构建失败就提前宣布阻塞；应先依据日志、checkpoint、attempt 和数据库证据进行安全定位。只有权限、密钥不可用、模拟器不可用或同一外部阻断连续确认后，才如实报告阻塞并保留已完成证据。
```
