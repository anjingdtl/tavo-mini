# ShineWriter 大纲流水线 V3：Brief Compiler、前后文一致性修复与推理预算归一化建设方案

> 目标版本：V2.11.40（直接启用，不做 A/B 实验）  
> 数据库基线：Schema 46  
> 新任务协议：Outline Workflow V3 + Context Budget V3  
> 适用范围：大纲模式单章流水线与“一键写 N 章”子任务  
> 不适用范围：原著续写独立 Runner、自由写作 Legacy 流水线、本地 GGUF 专用协议  
> 核心目标：保留 DeepSeek Thinking 的文学价值，同时消除 Revision Contract 对 Final Reviser 的超长推理放大，并修复 V2 前后文一致性回退。

---

## 1. 执行结论

本轮不再把 V2 继续当作可局部打补丁的终态，而是为新任务直接启用 Workflow V3：

```text
Draft
  ↓
Review ─────────┐
                ├→ 审核结果本地归一化
FactCheck ──────┘
  ↓
Brief 复杂度判定
  ├─ 简单合同：本地编译 Brief（0 API）
  └─ 复杂合同：Brief Compiler（1 API，Thinking enabled + low）
  ↓
Brief 完整性门禁
  ↓
Final Reviser（完整初稿 + 精简 Brief + 连续性最小闭包）
  ↓
技术交付门禁
```

V3 必须同时完成以下修复，禁止只新增 Brief Compiler 而保留 V2 终稿上下文缺陷：

1. 将产品推理档位修正为真实的 `low / high / max`；
2. 删除 `medium / high` 在 DeepSeek 服务端实际同档的问题；
3. 推理档位按阶段级联，不再用一个倍率同时扩大四阶段 `max_tokens`；
4. Brief Compiler 只做合同蒸馏，不重新审阅、不写小说，固定使用 `low` Thinking；
5. Final Reviser 不再直接读取复杂 Revision Contract JSON；
6. Final Reviser 恢复完整大纲、上一章接缝、故事状态和关键设定；
7. Review 的非法 anchor/range 不得自动扩大为整章可执行修改；
8. Review 失败时不得继续走“FactCheck 单边 + 轻上下文终稿”；
9. Final 软件门禁继续只拦技术错误，不恢复主观质量硬门禁；
10. 新逻辑直接作为 V2.11.40 新任务默认能力发布，不设置实验开关、不做 A/B 分流；
11. V1/V2 历史任务和历史批次严格按冻结版本恢复，不插入 Brief 节点。

---

## 2. 当前基线与已经确认的问题

### 2.1 当前版本事实

- App：V2.11.39；
- Schema：46；
- 新大纲任务默认冻结 `outlineWorkflowVersion=2`；
- 新大纲任务默认冻结 `contextBudgetVersion=2`；
- 当前 Stage：`draft / review / factCheck / proof`；
- 当前产品推理档位：`low / medium / high`；
- 当前 Final Reviser 输入：Revision Contract JSON + 完整初稿 + 少量可裁剪辅助上下文；
- 当前 Final 本地门禁：只阻断空正文、协议泄漏、明确截断等技术错误。

### 2.2 真机证据

已观测到以下典型任务：

| 阶段          | 输入 Token | 输出 Token（含 Thinking） |     耗时 |
| ------------- | ---------: | ------------------------: | -------: |
| Draft         |      1,143 |                     1,520 |  20.5 秒 |
| Final Reviser |      3,546 |                    20,245 | 161.4 秒 |

对应 Review 合同只有约 1,956 字符，但包含：

- 5 条修订项；
- 22 个 `protectedAnchorIds`；
- 5 条 `mustPreserve`；
- `fulfilledBeats`；
- `endingGoal`；
- 每条修订的 diagnosis / rewriteGoal / preserveMeaning；
- Revision Contract 编译时回填的定位锚点正文。

因此耗时根因不是 Final 输入字符特别多，而是 Final 被要求完成高密度约束求解：定位、对照、保护、冲突消解、最小修改、完整重输出同时成立。

### 2.3 V2 前后文一致性回退链路

当前高风险链路为：

```text
弹性预算压缩部分历史上下文
→ Review JSON 失败或定位漂移
→ 宽容解析把局部问题扩大为 chapter scope
→ 或 Review 失败后只保留 FactCheck
→ Revision Contract 丢失文学连续性与大纲执行信息
→ Final 又没有完整大纲/人物/世界状态
→ 技术门禁无法识别剧情偏移
→ 不连贯终稿被正常交付
```

### 2.4 当前推理档位并不是真正三档

DeepSeek V4 Flash 的有效档位是：

```text
low / high / max
```

当前产品却保存：

```text
low / medium / high
```

其中 `medium` 会被服务端兼容映射到 `high`，造成“平衡”和“质量”没有形成真实物理档位，且产品从未使用 `max`。

### 2.5 当前输出预算与推理档位错误耦合

当前实现通过倍率同时修改 Draft、Review、FactCheck、Proof 的 `max_tokens`：

```text
low    = 0.85 × base
medium = 1.00 × base
high   = 1.45 × base
```

这会产生两个问题：

1. `reasoning_effort` 是推理强度，`max_tokens` 是推理与可见正文共享的总输出上限，两者不是同一概念；
2. 扩大输出预留会从输入上下文中挤走 Recent Bridge、Story Memory 和资料预算，质量档反而可能读到更少的前文。

V3 必须彻底解除这一耦合。

---

## 3. V3 产品语义

### 3.1 新版本号与冻结版本

建议直接发布：

```text
versionName = V2.11.40
versionCode = 2114000
SCHEMA_VERSION = 46
CURRENT_OUTLINE_WORKFLOW_VERSION = 3
CURRENT_CONTEXT_BUDGET_VERSION = 3
CURRENT_FINAL_REVISER_REASONING_POLICY_VERSION = 3
CURRENT_REASONING_PROFILE_VERSION = 2
CURRENT_BRIEF_POLICY_VERSION = 1
```

本轮不需要新增数据库表或列：

- `pipeline_stage_checkpoints.stage` 是 TEXT，可持久化 `brief`；
- `pipeline_stage_attempts.stage` 是 TEXT，可记录 Brief API attempt；
- `outline_workflow_version` / `context_budget_version` 是整数列，可写入 3；
- Brief 配置可进入 settings KV；
- Brief 与逐阶段推理配置可冻结在 `pipeline_context_json.execution`。

因此保持 Schema 46，避免为了协议枚举变化制造无意义 Schema 47。若实施时新增了实体列或约束，再单独提升 Schema，禁止预先空升版本。

### 3.2 新旧任务隔离

| 任务类型                |   Workflow |     Budget | 行为                   |
| ----------------------- | ---------: | ---------: | ---------------------- |
| 升级前历史任务          |        1/2 |        1/2 | 原样恢复，绝不补 Brief |
| 升级前历史批次子任务    | 批次冻结值 | 批次冻结值 | 原样恢复               |
| V2.11.40 新大纲单章任务 |          3 |          3 | 使用 V3                |
| V2.11.40 新大纲批次     |          3 |          3 | 子任务继承 V3          |
| 非大纲/自由写作         |          1 |          1 | 不切换协议             |

Resume 只读任务快照，不读取当前设置，不把旧 `medium` 临时改成新 `high`。

### 3.3 五节点不是五次固定调用

Brief 是持久化逻辑 Stage，但不保证每次产生 API 调用：

| 情况               | Brief checkpoint                           | Brief API |
| ------------------ | ------------------------------------------ | --------: |
| 无审核模式         | skipped                                    |         0 |
| 无可执行修订       | succeeded（本地 empty brief）              |         0 |
| 简单合同           | succeeded（本地 deterministic brief）      |         0 |
| 复杂合同           | succeeded（LLM brief）                     |         1 |
| Brief API 输出无效 | **failed（不写入 fallback，不进入 Final）** | 1，不自动重试；用户可从 Brief 失败节点重试 |
| Review 必需但失败  | skipped/failed，Draft fallback             |         0 |

这样既满足 Brief Compiler 的语义价值，也避免给所有本来很快的终稿增加串行网络耗时。

---

## 4. 新状态机

### 4.1 Stage 与任务状态

```ts
export type PipelineStageName =
  | 'draft'
  | 'review'
  | 'factCheck'
  | 'brief'
  | 'proof';

export type PipelineTaskStatus =
  | 'idle'
  | 'queued'
  | 'drafting'
  | 'reviewing'
  | 'factChecking'
  | 'briefing'
  | 'proofing'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted';
```

V3 新任务创建 checkpoint：

```text
draft / review / factCheck / brief / proof
```

V1/V2 仍创建原四项，投影层不得凭当前代码自动补行。

### 4.2 各模式路径

#### noReview

```text
Draft → Finalize Draft
Review/FactCheck/Brief/Proof = skipped
```

#### twoStage

```text
Draft → Review → Brief → Final Reviser
```

Review 失败：直接保留 Draft，不运行 Brief/Final。

#### conditional

```text
Draft → FactCheck
  ├─ 无 required/hard → Finalize Draft
  └─ 有 required/hard → Brief → Final Reviser
```

Conditional 不允许把纯 warning 变成一次终稿重写。

#### full

```text
Draft → (Review ∥ FactCheck) → Brief → Final Reviser
```

降级策略：

| Review | FactCheck | V3 行为                                                           |
| ------ | --------- | ----------------------------------------------------------------- |
| 成功   | 成功      | 合并后进入 Brief                                                  |
| 成功   | 失败      | 使用 Review；Final 注入完整连续性上下文并展示事实核查缺失 warning |
| 失败   | 成功      | 不运行轻上下文终稿，保留 Draft；提示文学评估失败                  |
| 失败   | 失败      | 保留 Draft，任务失败                                              |

原因：Review 是大纲执行、章节结构、开头衔接和文学连续性的唯一审核来源；在它缺失时，仅凭 FactCheck 进入 Final 会重复 V2 的质量回退路径。

### 4.3 Brief 失败语义

Brief API 不允许把无效结果伪装成本地成功。API 已被触发后，若返回内容未通过完整性门禁，或调用本身失败：

1. checkpoint 必须记为 `failed`，保存失败原因与本次 token/耗时；
2. 不写入本地 fallback Brief，不进入 Final Reviser；
3. 状态机将任务置为失败，结果页提供“从 Brief 失败处重启”；
4. 重启只重跑 Brief 及其后续阶段，复用已经成功的 Draft/Review/FactCheck；
5. 只有“根本未调用 API”的本地路径（简单合同或上下文窗口确实不足）才允许使用 `compileDeterministicBrief()`，且仍需通过本地覆盖门禁；
6. 若本地路径也无法保证 required/hard 覆盖，则同样阻断 Final，不得产出可信度不明的终稿。

原因：Brief 是 Review/FactCheck 到 Final 的唯一审核结果压缩层。API 校验失败意味着核查结果没有被安全传递；此时继续 Final 等价于跳过核查，任何“fallback + success”都会让 UI 给出错误的可信度信号。

---

## 5. Review / FactCheck 修复

### 5.1 保留宽容解析，收紧语义扩大

继续支持：

- Markdown fenced JSON；
- JSON 前后解释文字；
- 缺少 `schemaVersion` / `draftHash`；
- 未知字段；
- 可安全补齐的数组；
- 可识别的文学评估自然语言。

但必须修改以下行为。

### 5.2 禁止非法定位自动升级为 chapter

新规则：

| 原始情况                           | V2                  | V3                                                                 |
| ---------------------------------- | ------------------- | ------------------------------------------------------------------ |
| 模型明确 `scope=chapter`           | chapter             | chapter                                                            |
| warning 的 anchor/range 无效       | 降级 chapter        | 转 advisory，不进入可执行 mustFix                                  |
| required/hard 的 anchor/range 无效 | 降级 chapter 或失败 | 标记 `unlocatedRequired`，交 Brief Compiler 语义归并；不得扩大授权 |
| 完全无诊断/目标                    | 丢弃                | 丢弃                                                               |
| 自然语言评估                       | chapter warning     | advisoryNotes，不直接授权整章重写                                  |

原则：

> “定位失败”只能降低自动执行权限，不能扩大修改范围。

### 5.3 Review V3 归一化模型

```ts
interface NormalizedReviewV3 {
  schemaVersion: 3;
  draftHash: string;
  executableCorrections: NormalizedCorrectionV3[];
  unlocatedRequired: NormalizedCorrectionV3[];
  advisoryNotes: string[];
  outlineExecution: {
    fulfilledBeats: string[];
    missingBeats: string[];
    deviations: string[];
    prematureBeats: string[];
    mustPreserve: string[];
    endingGoal: string;
    mustNotAdvance: string[];
  };
  protectedFacts: string[];
  warnings: string[];
}
```

`protectedAnchorIds` 可以继续留在 Review 内部用于审计可追溯，但不得直接传给 Final Reviser，也不得枚举所有未修改段落。

### 5.4 Review Thinking 与格式失败

Review/FactCheck 仍保留 Thinking，因为其判断有文学和事实价值；但推理档位由阶段级联控制，不允许使用 `max`。

Review reasoning-only：

- 首次调用保留 Thinking；
- 若 content 为空但 reasoning_content 非空，允许一次确定性“正文提取重试”：Thinking disabled、固定低温、只输出报告；
- 该重试只用于 reasoning-only，不用于普通字段漂移；
- 可本地修复的 JSON 不调用重试。

这样避免当前“宽容解析上线后，reasoning-only 反而直接失败”的缺口。

### 5.4.1 reasoning-only 根因判定（不改变统一 Thinking 档位）

`reasoning-only` 的严格定义是：Provider 收到 `choices[0].message` 后，
`message.content` 为空，但 `message.reasoning_content` 非空。客户端必须继续把
两条通道分开；它不是“把 reasoning 当正文”，也不能仅凭这个分类断言
`max_tokens` 被推理耗尽。

本轮已有设备证据：

- 批量测试的两个 Review 首次请求确实都是 `content=empty + reasoning_content`，但历史
  attempt 没有保存 `finishReason`，因此当时不能证明是预算截断；
- 单章任务 `pt_mslb8y95_121` 的两次 Review 首次输出分别为 `1,338`、`2,800` 个
  reasoning token，而请求 `maxTokens=31,536`，远未达到该请求上限；
- Provider 现在必须同时记录 `finishReason`、`outputTokens`、`reasoningTokens`、
  `visibleOutputTokens` 与 `emptyReason`。只有 `emptyReason=reasoning_only` 且
  `finishReason=length` 才标记为“推理预算截断”；`finishReason=stop` 只能判定为
  “模型结束时没有写出可见合同正文”；
- DeepSeek 官方 [JSON Output 文档](https://api-docs.deepseek.com/guides/json_mode/) 明确提示，
  JSON Output 偶尔可能返回空 content，并建议通过修改提示词缓解；因此当前最高概率根因是 Thinking + JSON Output 的
  结构化输出偶发失配，不能归因于本方案把 Review/FactCheck 的 Thinking 档位设置过高。

根因排查采用固定输入矩阵，不修改 `low/high/max` 归一化：

1. 保持 `Thinking enabled + high + response_format=json_object`，记录基线空响应率；
2. 在相同请求上增加“最终合同必须写入 content、不得只结束在 reasoning_content”的
   明确提示，比较空响应率；
3. 保持 Thinking/high，只改变 JSON 输出参数作为诊断对照；禁用 Thinking 仅作为既有
   一次提取重试的恢复对照，不作为架构方案；
4. 每组至少重复 10 次，比较 `finishReason` 分布、reasoning/visible 分账和耗时；
5. 任一 `reasoning-only` 必须留下完整安全诊断，不能再以“提高 max_tokens”作为无证据
   的通用结论。

只有在矩阵证据确认后，才决定是否进一步调整审阅提示或 Provider 参数组合；不通过
   降低 Review/FactCheck 的统一档位来规避问题。

### 5.5 FactCheck 保持事实严格性

FactCheck 仍要求：

- hard/required 事实必须有明确证据；
- 不允许把未来大纲当成已发生事实；
- 不允许用现实常识覆盖世界书；
- 不允许无依据增加 hardConstraints；
- reasoning-only 可进行一次 Thinking-disabled 提取重试；
- 普通 JSON 格式漂移优先本地修复。

---

## 6. Brief Compiler 设计

### 6.1 职责边界

Brief Compiler 只能：

1. 合并重复 Review/FactCheck 意见；
2. 消解同一问题的表述重复；
3. 把机器合同转换成简短写作指令；
4. 保留所有 hard/required；
5. 保留大纲 endingGoal / mustNotAdvance / missingBeats；
6. 将 advisory warning 与可执行修改分离；
7. 删除无法在本章执行的未来任务；
8. 为 Final 生成自然语言位置提示，而不是锚点协议。

Brief Compiler 禁止：

- 重新阅读或改写初稿；
- 发现新的文学问题；
- 新增人物、事实、设定或剧情；
- 提升 warning 的严重性；
- 删除 hard/required；
- 输出小说正文；
- 输出推理过程；
- 再生成一份复杂 Revision Contract。

### 6.2 为什么 Brief 不读取初稿

Brief 的输入只包含已经归一化的 Review/FactCheck。它不读取：

- 初稿全文；
- 完整大纲；
- 人物卡；
- 世界书；
- Story Memory；
- Episodic Memory；
- Previous Chapter 正文。

这样可以保证：

- 输入稳定且短；
- 不会变成第二次审阅；
- 不会重复 Draft/Final 的上下文成本；
- 不会因为读到正文而擅自提出新修改；
- Brief API 延迟可控制在短请求范围。

### 6.3 Brief 输入协议

```ts
interface BriefCompilerInputV1 {
  schemaVersion: 1;
  sourceHash: string;
  workflowMode: 'twoStage' | 'conditional' | 'full';
  review?: {
    executableCorrections: BriefSourceItem[];
    unlocatedRequired: BriefSourceItem[];
    advisoryNotes: string[];
    outlineExecution: NormalizedReviewV3['outlineExecution'];
  };
  factCheck?: {
    corrections: BriefSourceItem[];
    protectedFacts: string[];
    hardConstraints: string[];
  };
}

interface BriefSourceItem {
  sourceId: string;
  severity: 'hard' | 'required' | 'warning';
  dimension: string;
  diagnosis: string;
  rewriteGoal: string;
  preserveMeaning: string[];
  locationHint?: 'opening' | 'middle' | 'ending' | string;
  evidenceQuote?: string;
}
```

`evidenceQuote` 最多保留 80 ～ 120 字，只用于帮助生成自然语言位置提示；禁止把整段正文回填进 Brief 输入。

### 6.4 Brief 输出协议

Brief API 可以返回简单 JSON 供本地校验，但该 JSON 永远不直接传给 Final：

```ts
interface FinalWritingBriefV1 {
  schemaVersion: 1;
  sourceHash: string;
  coveredRequiredIds: string[];
  mustFix: Array<{
    sourceIds: string[];
    location: string;
    instruction: string;
    preserve: string[];
  }>;
  mustPreserve: string[];
  mustNotAdvance: string[];
  openingContinuity: string[];
  endingState: string;
  advisoryNotes: string[];
}
```

Final 编译器只渲染以下纯文本：

```text
【必须修改】
1. ……

【必须保持】
- ……

【不得提前推进】
- ……

【开头衔接】
- ……

【结尾状态】
……
```

以下字段不进入 Final：

- `schemaVersion`；
- `sourceHash`；
- `sourceIds`；
- `coveredRequiredIds`；
- anchor ID；
- Review/FactCheck 原始 JSON；
- 编译警告。

### 6.5 Brief 完整性门禁

本地必须检查：

1. `sourceHash` 精确匹配；
2. 每个 hard/required sourceId 至少覆盖一次；
3. 不允许未知 sourceId；
4. `hardConstraints` 不得缺失；
5. `mustNotAdvance` 不得缺失；
6. `endingGoal` 非空时必须转成 endingState；
7. 不允许 `<think>`、Prompt、小说正文或锚点协议泄漏；
8. `mustFix` 数量与长度受限；
9. 同一个 sourceId 不得被相互矛盾的指令重复覆盖；
10. advisoryNotes 不得升级成 mustFix。

门禁失败不调用第二次 Brief API，也不得把本地 fallback 写成成功；任务必须停在 Brief 失败处并等待用户重启。只有 API 未触发的本地路径才允许使用确定性 Brief。

### 6.6 Brief 复杂度触发器

`shouldCallBriefCompiler()` 必须是纯函数，输入为归一化审核结果和冻结 policy：

```text
满足任一条件 → API Brief

- hard/required 总数 >= 4
- executable + unlocated 总数 >= 6
- 存在 chapter/range 级 required/hard
- 存在 unlocatedRequired
- 同一位置有 Review/FactCheck 冲突
- protectedFacts + hardConstraints >= 8
- missingBeats / mustNotAdvance 任一非空
- endingGoal 与某条修订目标存在潜在重叠
- 归一化审核文本 > 1,500 字符
```

否则使用本地确定性 Brief，避免给简单合同增加网络延迟。

### 6.7 Brief 调用参数

```json
{
  "thinking": { "type": "enabled" },
  "reasoning_effort": "low",
  "temperature": 0.1,
  "top_p": 1,
  "response_format": { "type": "json_object" }
}
```

Brief 的任务不是机械摘录，而是小规模语义压缩：它需要合并重复意见、消解 Review/FactCheck 冲突、判断优先级并保证 required/hard 覆盖。因此 DeepSeek V4 Flash 等支持 Thinking 的模型必须发送 `reasoning_effort=low`，不得关闭 Thinking。

Brief 的推理档位固定为 `low`，不继承产品级 `high/max`：`low` 用于完成必要的语义消歧，禁止向上级联可以避免一个辅助节点变成新的长推理瓶颈。

输出预算：

```ts
briefVisibleOutputFloor = clamp(
  512 + requiredCount * 140 + warningCount * 60,
  768,
  2048,
);

briefReasoningHeadroom = clamp(briefVisibleOutputFloor, 1024, 2048);

briefMaxTokens = min(
  configuredModelMaxOutputTokens || floor(contextWindow × 0.20),
  floor(contextWindow × 0.20),
);
```

其中 `briefVisibleOutputFloor` 是可见 JSON 的最低合同容量，`briefReasoningHeadroom` 是固定 `low` 档的独立最低推理容量；两者用于请求前的完整性门禁，不能互相挤占。`briefMaxTokens` 是每个 API 请求从统一弹性算力池取得的输出预留，不再是 Brief 专属的 2400/4K 小预算：DeepSeek 的 1M context 对应 200K 输出余量，实际配置更低时取配置值。若模型输出上限不足以同时容纳可见合同与 low 推理最低容量，不得将 Brief 静默改为 disabled，应按下述规则改用本地 Brief。

Brief 不再拥有独立的小上下文预算或静态 4K 上限。它与 Draft、Review、FactCheck、Final 使用同一个弹性 Stage 编译器：对本次 API 请求的可用输入容量 `C = contextWindow - requestMaxTokens - safetyMargin`，以 `floor(C × 0.80)` 作为软池，`95%` 作为 burst 水位，硬上限只保留给 mandatory 内容和封装误差。五个阶段分别拥有自己的请求窗口，不把五次调用的预算相加，也不从其他阶段机械切走固定比例。

若 Brief 的 mandatory 输入 + 输出预留 + safety margin 超出窗口：

1. 弹性池先回收 `advisoryNotes` 等 optional 输入；
2. 再按优先级裁剪 preferred/optional 上下文；
3. `brief_core` 中的 hard/required、hardConstraints、mustNotAdvance 不裁剪；
4. 仍不适配则跳过 API，使用本地 Brief，并保留 Thinking 未关闭的原因；
5. 本地 Brief 仍无法完整覆盖则 Draft fallback。

---

## 7. Final Reviser V3

### 7.1 输入不再是 Revision Contract JSON

Final Reviser V3 输入：

```text
1. 纯文本 Final Writing Brief
2. 完整 canonical draft
3. 连续性最小闭包
4. 精简文风
5. 用户本轮要求
```

禁止再次注入：

- Review 原始 JSON；
- FactCheck 原始 JSON；
- Revision Contract JSON；
- `protectedAnchorIds`；
- 锚点回填正文；
- sourceId / hash / schemaVersion；
- advisory warning 的机器字段。

### 7.2 连续性最小闭包

V3 新增 `FinalContinuityCapsule`：

```ts
interface FinalContinuityCapsule {
  fullOutlineText: string;
  immediatePreviousChapterText: string;
  immediatePreviousEnding: string;
  recentBridgeText: string;
  storyMemoryText: string;
  episodicMemoryText: string;
  relevantCharacterText: string;
  relevantWorldRules: string;
  currentInstructionText: string;
  retrievalUserPrompt: string;
  presetText: string;
}
```

全部来自 Draft 冻结快照或同一时刻冻结的候选池，不在 Final 前重新读取数据库。

### 7.3 Context Snapshot V3

当前 `recentBridgeText` 是多章拼接文本，无法稳定识别上一章完整正文。V3 快照增加：

```ts
immediatePreviousChapterText: string;
immediatePreviousChapterId?: number;
immediatePreviousChapterPosition?: number;
immediatePreviousEnding: string;
```

快照 envelope 版本提升为 3，但仍存储在 `pipeline_context_json`，不需要新列。

历史 V2 快照缺少这些字段时仍按 V2 compiler 恢复，不允许 V3 parser 猜测重建。

### 7.4 Final 上下文优先级

V3 Final 每次调用独立计算预算，优先级如下。

#### Mandatory：不足则阻断，不裁剪

1. Final 协议；
2. Final Writing Brief 中的 hard/required；
3. 完整 canonical draft；
4. 完整项目大纲；
5. hardConstraints / mustNotAdvance；
6. 当前章节目标；
7. 可见正文输出下限。

#### Required-with-floor：可从完整值降到最小闭包

1. 上一章完整正文：优先完整注入，最低保留最后 2,000 Token；
2. Story Memory：优先完整，最低保留关键人物/地点/物品/未完成动作；
3. 相关人物状态；
4. 相关世界规则。

#### Preferred

1. 其余 Recent Bridge；
2. Episodic Memory；
3. 精简文风；
4. 用户本轮补充要求。

#### Optional

1. 普通项目笔记；
2. 非命中人物卡；
3. 非命中世界书；
4. advisoryNotes。

### 7.5 Final 输出预算下限

Final 必须完整输出正文，因此先计算可见输出下限：

```ts
visibleFinalFloor = clamp(
  ceil(estimateTokens(canonicalDraft) * 1.2) + 256,
  1024,
  model.maxOutputTokens,
);
```

`max_tokens` 不能低于该值。Reasoning headroom 只能使用满足 mandatory input 与 visible floor 后的剩余空间。

如果：

```text
mandatoryInput + visibleFinalFloor + safetyMargin > contextWindow
```

则在发请求前阻断，并提示减少大纲/章节长度或切换更大窗口模型。禁止通过删除完整大纲或压缩 canonical draft 强行发送。

### 7.6 Final Prompt 收口

删除会诱发约束求解膨胀的表达：

- “逐条执行 JSON workItems”；
- “逐个保护所有 protectedAnchorIds”；
- “合同没有要求修改的部分不要动”与大量保护列表同时出现；
- 要求当前章保证未来章节回收某伏笔；
- 重复的 preserveMeaning / protectedFacts / mustPreserve。

改为：

```text
你是小说终稿编辑。根据简短修订要求完善本章。
保持未涉及内容的事实、叙事视角与文风稳定；不得改变既有剧情方向。
完整输出修订后的正文，不输出分析或修改说明。
```

Final 依然输出完整正文，不使用 patch、diff 或锚点替换。

---

## 8. 五节点上下文预算

### 8.1 关键原则：每个调用拥有独立窗口

Draft、Review、FactCheck、Brief、Final 是不同 HTTP 请求。五个请求都使用统一的弹性算力池算法；每次调用按自己的 `contextWindow` 独立计算 80% soft pool、95% burst band 与硬上限。新增 Brief 不从其他阶段机械“切走 5% 上下文”，五次请求的预算也不相加为一个共享小池。

每个阶段都必须独立满足：

```text
estimatedInput
+ reservedVisibleOutput
+ reasoningHeadroom
+ safetyMargin
<= modelContextWindow
```

因此 V3 删除“新增一个阶段就同比降低其他四阶段 max_tokens”的做法。

### 8.2 Context Automation Policy V3

新增 per-stage 独立配置：

```ts
interface OutlinePipelineBudgetPolicyV3 {
  draft: StageBudgetPolicy;
  review: StageBudgetPolicy;
  factCheck: StageBudgetPolicy;
  brief: StageBudgetPolicy;
  proof: StageBudgetPolicy;
}

interface StageBudgetPolicy {
  visibleOutputFloor: number;
  visibleOutputRatio?: number;
  reasoningHeadroom: Record<'low' | 'high' | 'max', number>;
  safetyMarginRatio: number;
  /** Optional diagnostic override only; no V3 default sets a static cap. */
  maxOutputCap?: number;
}
```

不再用 `applyPipelineReasoningBudget()` 对四阶段统一乘 `0.85 / 1 / 1.45`。
实际请求的输入裁剪统一走 `compileStageRequestWithElasticBudget()`；`maxOutputCap` 不作为 Brief 或任何其他阶段的默认小预算。

### 8.3 建议默认策略

| Stage     | 可见输出目标                 | Thinking headroom                          | 输入重点                           |
| --------- | ---------------------------- | ------------------------------------------ | ---------------------------------- |
| Draft     | 用户章节长度预算             | 按档位                                     | 大纲、前文、状态、设定             |
| Review    | 紧凑审核报告                 | low/high，禁止 max                         | 初稿、完整大纲、连续性材料         |
| FactCheck | 紧凑事实报告                 | low/high，禁止 max                         | 初稿、状态、事实资料               |
| Brief     | 768 ～ 2048 的可见 JSON 保底 | 固定 low，1024 ～ 2048；与可见输出独立分账 | 归一化审核结果，沿用统一弹性输入池 |
| Final     | `draftTokens × 1.2 + 256`    | 按档位                                     | Draft、Brief、连续性闭包           |

### 8.4 Reasoning 与 visible output 分账

执行快照应同时冻结：

```ts
interface FrozenStageBudgetV3 {
  stage: PipelineStageName;
  visibleOutputFloor: number;
  reasoningHeadroom: number;
  requestMaxTokens: number;
  estimatedMandatoryInput: number;
  optionalInputBudget: number;
  safetyMargin: number;
}
```

其中，普通阶段的 `requestMaxTokens` 仍由该阶段冻结的输出预算决定；Brief V3 使用上面的统一弹性输出预留。`visibleOutputFloor + reasoningHeadroom` 是最低可行性检查，不是 Brief 的 provider `max_tokens` 上限。若 Provider 的 `max_tokens` 同时包含 Thinking 与正文，则本地必须同时检查这两个最低账户，不允许把一个很小的阶段上限误当成完整弹性池。

### 8.5 预算不足时的级联顺序

每个 Stage 独立执行同一套弹性分配：

1. 保护 mandatory；
2. 在 80% soft pool 内分配 preferred/optional；
3. 高相关 preferred 必要时借用 burst band；
4. 重建消息并做最终硬窗口检查；
5. 检查 visible output floor 与 low/high/max 的 reasoning headroom；
6. 输出上限无法同时容纳可见输出和 Thinking 时，请求前改用本地 Brief 或阻断，不得关闭 Thinking；
7. mandatory 超出硬上限则请求前阻断。

禁止：

- 先裁完整大纲；
- 先裁上一章接缝；
- 先裁 Final Brief 的 required/hard；
- 为保留 `max` 标签而牺牲正文输出下限；
- 静默发送一个必然 reasoning-only 的请求。

---

## 9. 推理档位与级联归一化

### 9.1 新产品档位

```ts
export type PipelineReasoningTier = 'low' | 'high' | 'max';
```

UI：

| UI   | 存储值 | 含义                         |
| ---- | ------ | ---------------------------- |
| 快速 | low    | 优先速度，保留基础 Thinking  |
| 平衡 | high   | DeepSeek 默认质量档          |
| 质量 | max    | Draft/Final 使用最大推理强度 |

默认值改为 `high`。

### 9.2 按阶段级联

```ts
const STAGE_REASONING_PROFILE_V2 = {
  low: {
    draft: 'low',
    review: 'low',
    factCheck: 'low',
    brief: 'low',
    proof: 'low',
  },
  high: {
    draft: 'high',
    review: 'high',
    factCheck: 'high',
    brief: 'low',
    proof: 'high',
  },
  max: {
    draft: 'max',
    review: 'high',
    factCheck: 'high',
    brief: 'low',
    proof: 'max',
  },
} as const;
```

Review/FactCheck 在质量档保持 `high`，不升级 `max`：结构化审核的主要瓶颈是可见报告被隐藏推理挤占，真机已有 Review 84.1%、FactCheck 93.2% 输出 Token 属于 reasoning 的证据。Brief 在三种产品档位下都固定为 `low`，不关闭，也不随 high/max 向上级联。

### 9.3 上下文不足时的 effective tier 降级

先计算该 Stage 能提供的 reasoning headroom，再确定 effective tier：

```text
requested max
  ├─ 满足 max headroom → max
  ├─ 仅满足 high headroom → high
  └─ 仅满足 low headroom → low

requested high
  ├─ 满足 high headroom → high
  └─ 仅满足 low headroom → low

requested low
  └─ 不能满足 low headroom → 请求前阻断
```

降级必须：

- 写入冻结 execution；
- 写入 attempt fingerprint；
- 在结果页显示“因上下文容量，某阶段从 max 调整为 high”；
- Resume 继续使用 effective tier；
- 不在 HTTP 400 后临时更改档位重试。

### 9.4 旧设置归一化

新增 settings：

```text
pipeline_reasoning_profile_version = 2
pipeline_reasoning_effort = low | high | max
pipeline_brief_visible_output_floor = 1200（默认，可自动调整）
pipeline_brief_reasoning_headroom = 1200（默认，限 1024～2048）
```

首次读取旧设置且 profile version 缺失时：

| 旧值      | 新值 | 理由                               |
| --------- | ---- | ---------------------------------- |
| low       | low  | 保持快速意图                       |
| medium    | high | 旧 medium 服务端本就映射 high      |
| high      | max  | 旧 UI 的“质量”意图迁移为真正最高档 |
| max       | max  | 已是新值                           |
| 缺失/非法 | high | 新默认平衡档                       |

归一化必须在一次 settings transaction 中写回值与 profile version，避免启动中途读到半迁移状态。

### 9.5 历史任务不归一化

历史冻结快照遵循：

| 快照         | Resume 行为                                |
| ------------ | ------------------------------------------ |
| V2 + low     | 继续发送 low                               |
| V2 + medium  | 继续发送 medium，保持历史指纹              |
| V2 + high    | 继续发送 high，不升级 max                  |
| V2 无 effort | 继续省略                                   |
| V3           | 使用冻结 requested/effective stage profile |

设置迁移只影响未来新任务。

### 9.6 Provider 能力归一化

| Provider                          | 行为                                   |
| --------------------------------- | -------------------------------------- |
| 官方 DeepSeek + deepseek-v4-flash | 发送 low/high/max                      |
| 官方 DeepSeek + 其他模型          | 按能力白名单映射或省略                 |
| 自定义 OpenAI-compatible 网关     | 默认省略 reasoning_effort              |
| Thinking disabled                 | 必须省略 reasoning_effort              |
| 未知模型                          | 保留 max_tokens，省略 vendor extension |

不允许仅凭模型名向未知网关发送 DeepSeek 扩展。

---

## 10. Draft 与前文一致性修复

### 10.1 修复当前正文重复注入

当前同章续写可能同时出现：

- `existingContent.slice(-1500)`；
- `createChapterGenerationRequest().userPrompt` 中的完整当前正文。

V3 规定正文只能由 Draft compiler 注入一次：

```text
新空章：上一章接缝 + 当前章节目标
同章续写：当前已有正文（按预算完整或保尾）+ 当前章节目标
```

`retrievalUserPrompt` 只保存用户要求和检索关键词，不再重复携带正文。

### 10.2 上一章接缝独立冻结

Draft 和 Final 共用：

- `immediatePreviousChapterText`；
- `immediatePreviousEnding`；
- 同一 source hash。

任何 Story Memory checkpoint 状态都不得导致上一章最后场景完全消失。

### 10.3 Sliding Window 优先级修正

Context Budget V3 中：

```text
immediatePreviousEnding = mandatory
immediatePreviousChapterText = required-with-floor
recentBridge older chapters = preferred
episodic older history = preferred/optional
```

不再把整个 slidingWindow 统一作为最低优先级 optional。

### 10.4 Story Memory 降级语义

Story Memory 仍允许非致命降级，但必须：

- 将缺失/dirty/coverage gap 写入 Draft 与 Final trace；
- 保留即时上一章原文；
- 不把长期状态缺失伪装为“覆盖完整”；
- Full 模式 Review 必须看到相同 warning；
- Story Memory 不可用且上一章也为空时，明确提示连续性风险。

---

## 11. Final 软件门禁

继续执行用户确认的宽松语义。

### 11.1 Hard Fail

- 空正文；
- reasoning-only；
- `<think>` 泄漏；
- Prompt/Brief/JSON/锚点协议泄漏；
- patch/diff/“其余内容不变”；
- `finish_reason=length` 且存在明确未闭合证据；
- 未闭合技术分隔符。

### 11.2 Warning Only

- 长度明显变化；
- 大段重复；
- 修改幅度较大；
- 与 Draft 高相似；
- 主观文学质量疑虑；
- 目标字数偏差。

### 11.3 不新增第二次 Final

Final 正确返回正文即交付。Brief 的目的正是请求前降低认知复杂度，不允许再通过 Final 自动重试抵消收益。

### 11.4 V3 审核/Brief/Proof 失败只允许人工从失败节点重试

V3 的 Review、FactCheck、Brief 或 Final Reviser/Proof 只要发生失败、空正文、reasoning-only、技术交付门禁失败，或 Brief 携带的连续性硬边界未满足，均不得自动把 Draft 写入 `finalText`，也不得通过 `finalize_from_draft(degraded)` 伪装成可采纳结果。失败 checkpoint 必须保持 `failed`，任务置为 failed，结果页提供“从失败节点重试”；Proof 的连续性硬门禁额外写入机器错误码 `FINAL_PROOF_RETRY_REQUIRED`，供状态机精确区分 Proof 重试路径。

用户确认重试后，只将 failed/interrupted/running checkpoint 置回 pending；已经成功的 Draft、Review、FactCheck、Brief 检查点和冻结请求保持不变。状态机从对应失败节点继续，并只执行该节点及尚未完成的后续节点；若只有 Proof 失败，则只重跑 Proof。V2 历史任务继续按其冻结版本的既有语义恢复。

---

## 12. 持久化、恢复与指纹

### 12.1 Execution Snapshot V3

```ts
interface PipelineExecutionSnapshotV3 extends PipelineExecutionSnapshot {
  outlineWorkflowVersion: 3;
  contextBudgetVersion: 3;
  reasoningProfileVersion: 2;
  requestedReasoningTier: 'low' | 'high' | 'max';
  stageReasoning: {
    draft: FrozenStageReasoning;
    review: FrozenStageReasoning;
    factCheck: FrozenStageReasoning;
    brief: { thinking: 'enabled'; effort: 'low' };
    proof: FrozenStageReasoning;
  };
  briefPolicyVersion: 1;
  briefVisibleOutputFloor: number;
  briefReasoningHeadroom: number;
  briefMaxTokens: number;
  stageBudgets: FrozenStageBudgetV3[];
}
```

### 12.2 Brief checkpoint

`pipeline_stage_checkpoints`：

- `stage='brief'`；
- `output_text` 保存已校验的 FinalWritingBriefV1 JSON；
- `warnings` 继续通过 task stage result 或统一 metadata 保存；
- `duration_ms` 包含本地编译或 Brief API 总耗时；
- `attempt_count=0` 表示本地 Brief；
- `attempt_count=1` 表示调用 Brief API。

### 12.3 Brief attempt

`pipeline_stage_attempts` 记录：

- request_version = 1；
- request fingerprint；
- normalized audit sourceHash；
- thinking=enabled；
- reasoningEffort=low；
- estimated input / reserved output；
- token usage；
- failure class。

### 12.4 Fingerprint 必含字段

```text
workflowVersion
contextBudgetVersion
reasoningProfileVersion
requestedTier
effectiveStageTier
briefPolicyVersion
briefTriggerDecision
briefSourceHash
thinking
reasoningEffort
maxTokens
messagesHash
```

### 12.5 冷启动恢复

| Brief 状态                     | 恢复动作                             |
| ------------------------------ | ------------------------------------ |
| pending                        | 重新判定本地/API Brief，使用冻结输入 |
| running + attempt 可恢复       | 按 attempt 策略恢复                  |
| succeeded                      | 直接使用持久化 Brief，不重新调用     |
| failed + local fallback 可构建 | 仅限 API 未触发的本地路径；API 已返回无效结果时保持 failed |
| failed + API 已返回无效结果    | 保持 failed，阻断 Final，等待从 Brief 重启              |
| failed + required 覆盖不可保证 | 保持 failed，阻断 Final                                |

禁止从 live Review、live settings 或最新大纲重建 Brief。

---

## 13. 批量写章适配

### 13.1 批次冻结

新批次冻结：

- workflowVersion=3；
- contextBudgetVersion=3；
- reasoningProfileVersion=2；
- requestedReasoningTier；
- Brief policy version；
- 五节点预算策略版本。

子任务首次创建时继承，之后不再读取批次当前设置。

### 13.2 调用次数预算

最坏调用数：

| 模式        |                                   最大调用数/章 |
| ----------- | ----------------------------------------------: |
| noReview    |                                               1 |
| twoStage    |             4（Draft + Review + Brief + Final） |
| conditional |          4（Draft + FactCheck + Brief + Final） |
| full        | 5（Draft + Review + FactCheck + Brief + Final） |

Review/FactCheck reasoning-only 提取重试属于故障预算，应在批次调用上限中单独预留；Brief 与 Final 不自动重试。

### 13.3 串并行关系

```text
Review ∥ FactCheck
      ↓ join
Brief
      ↓
Final
```

Brief 是串行依赖，不能假装与 Final 并发。进度页应显示“正在整理终稿写作要求”。

---

## 14. UI 与可观测性

### 14.1 设置页

替换当前三档：

```text
快速 low / 平衡 high / 质量 max
```

显示级联说明：

- 快速：全创作节点 low；
- 平衡：创作与审核 high；
- 质量：Draft/Final max，审核 high；
- Brief Compiler 始终使用 low Thinking，不随用户档位升到 high/max；
- 因上下文容量产生的 effective 降级会显示在结果页。

### 14.2 结果页

新增 Brief Stage 展示：

- 本地整理 / AI 整理；
- 输入/输出 Token；
- 耗时；
- required 覆盖数；
- warning 数；
- 是否 fallback；
- requested/effective reasoning tier；
- Final reasoning tokens / visible output tokens。

### 14.3 Context Preview

Preview 必须展示两个独立视图：

1. Draft 预估上下文；
2. Final V3 连续性最小闭包预估。

Brief 输入依赖尚未产生的审核结果，Preview 只显示预算规则和最大输入上限，不伪造实际 Brief。

---

## 15. 代码改造清单

### 15.1 类型与版本

| 文件                                              | 修改                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| `src/types/pipeline.ts`                           | 增加 brief/briefing；档位改 low/high/max                          |
| `src/types/pipelineExecution.ts`                  | Workflow/Budget 3、reasoning profile、Brief policy、stage budgets |
| `src/types/pipelineContext.ts`                    | Snapshot V3 与 immediate previous fields                          |
| `src/services/pipeline/outlineWorkflowVersion.ts` | CURRENT 版本切到 3                                                |
| `src/services/pipeline/reasoningPolicy.ts`        | 删除统一倍率，新增逐阶段归一化                                    |

### 15.2 Brief Compiler

新增：

```text
src/services/pipeline/briefCompilerTypes.ts
src/services/pipeline/briefTriggerPolicy.ts
src/services/pipeline/compileBriefStageRequest.ts
src/services/pipeline/briefResultValidator.ts
src/services/pipeline/deterministicBriefCompiler.ts
src/services/pipeline/renderFinalWritingBrief.ts
```

### 15.3 Runner 与状态机

| 文件                             | 修改                                        |
| -------------------------------- | ------------------------------------------- |
| `determineNextPipelineAction.ts` | 增加 run_brief / Brief 恢复路径             |
| `reconcile.ts`                   | `actionRunBrief`、Review 失败策略、Final V3 |
| `compileStageRequest.ts`         | Brief compiler + Final V3 compiler          |
| `pipelineMessages.ts`            | Brief Prompt、Final V3 Prompt               |
| `pipeline/types.ts`              | LLM_STAGES 增加 brief，按版本生成           |
| `projectStageCheckpoints.ts`     | V3 五阶段投影，V1/V2 四阶段隔离             |
| `pipelineTaskStore.ts`           | 新任务条件创建五 checkpoint                 |

### 15.4 配置与自动预算

| 文件                         | 修改                                                                     |
| ---------------------------- | ------------------------------------------------------------------------ |
| `pipelineTaskRepository.ts`  | settings profile version、briefMaxTokens、归一化事务                     |
| `contextAutomationPolicy.ts` | per-stage Budget Policy V3                                               |
| `contextAutoAllocator.ts`    | 五阶段统一弹性预算快照；每次 API 按自身窗口计算 80% soft pool / 20% 余量 |
| `PipelineConfigScreen.tsx`   | low/high/max 与级联说明                                                  |
| `ContextPreviewScreen.tsx`   | Draft/Final 两套预算预览                                                 |

### 15.5 上下文与质量修复

| 文件                        | 修改                                              |
| --------------------------- | ------------------------------------------------- |
| `contextBuilder.ts`         | 独立捕获 immediate previous chapter               |
| `draftPipelineCompiler.ts`  | 消除同章正文重复注入                              |
| `chapterGeneration.ts`      | retrieval prompt 不携带完整正文                   |
| `revisionAuditValidator.ts` | 禁止非法 locator 扩大为 chapter                   |
| `revisionContract.ts`       | V3 不再向 Final 输出锚点合同；仅作为 Brief source |
| `finalArtifactValidator.ts` | 保持宽松技术门禁                                  |
| `finalBriefComplianceValidator.ts` | 校验 Final 是否越过 Brief 连续性硬边界；失败只允许从对应节点重试 |
| `scripts/qa/analyze-pipeline-quality.mjs` | 生成 Draft→Review→Brief→Final 正文质量增益证据 |

### 15.6 UI 与批次

| 文件                             | 修改                                      |
| -------------------------------- | ----------------------------------------- |
| `PipelineResultScreen.tsx`       | Brief Stage、推理档位与降级原因           |
| `MultiChapterBatchScreen.tsx`    | 五阶段调用估算与档位显示                  |
| `reconcileMultiChapterBatch.ts`  | Workflow V3 继承与最坏调用预算            |
| `multiChapterBatchRepository.ts` | 新 settings/snapshot 归一化，不改历史批次 |

---

## 16. 实施顺序

### Phase 0：版本与设置归一化

1. 增加 low/high/max 类型；
2. 增加 reasoning profile version；
3. 完成旧 low/medium/high 设置事务迁移；
4. 历史 execution parser 保留 medium；
5. 新任务冻结 Workflow/Budget 3。

### Phase 1：预算解耦

1. 删除统一 output multiplier；
2. 实现 per-stage visible floor + reasoning headroom；
3. 实现 effective tier 级联；
4. 更新 auto allocator 和 LLM 设置同步；
5. 增加 Final mandatory fit gate。

### Phase 2：Review/FactCheck 修复

1. locator 失败不扩大为 chapter；
2. narrative fallback 改 advisory；
3. reasoning-only 提取重试；
4. Full 模式 Review 失败停止 Final；
5. 归一化 V3 source model。

### Phase 3：Brief Stage

1. 类型、checkpoint、attempt；
2. 复杂度纯函数；
3. Brief Prompt；
4. 本地覆盖门禁；
5. deterministic fallback；
6. Resume/CAS/取消。

### Phase 4：Final V3 与连续性闭包

1. Snapshot V3；
2. immediate previous chapter 独立冻结；
3. Final Writing Brief 纯文本渲染；
4. 恢复完整大纲和关键上下文；
5. 删除 Contract JSON/anchor 注入；
6. 消除 Draft 当前正文重复注入。

### Phase 5：批次、UI、验收与发版

1. 批次继承；
2. 进度/结果/Preview；
3. 单测、SQLite 恢复、故障注入；
4. 真机完整链路；
5. 直接发布 V2.11.40。

本方案不包含 A/B、灰度百分比或实验开关。验证失败即阻断发版，验证通过即启用 V3 新任务默认值。

---

## 17. 测试矩阵

### 17.1 设置归一化

- 旧 low → 新 low；
- 旧 medium → 新 high；
- 旧 high → 新 max；
- 缺失/非法 → high；
- settings transaction 原子写入 profile version；
- 历史 V2 medium 快照恢复仍发送 medium；
- 新 V3 不允许保存 medium。

### 17.2 推理级联

- low：Draft/Review/Fact/Final 均 low，Brief low；
- high：Draft/Review/Fact/Final 均 high，Brief 固定 low；
- max：Draft/Final max，Review/Fact high，Brief 固定 low；
- Thinking disabled 时不发送 reasoning_effort；
- 上下文不足 max→high→low 有确定性原因；
- fingerprint 随 effective tier 改变；
- Resume 不重新计算 effective tier。

### 17.3 Review 修复

- fenced JSON；
- 前后解释文字；
- 缺字段本地补齐；
- warning locator 无效变 advisory；
- required locator 无效进入 unlocatedRequired；
- 明确 chapter scope 保留；
- narrative review 不生成 chapter mustFix；
- reasoning-only 只进行一次 disabled 提取；
- 小说正文/Prompt 泄漏继续失败。

### 17.4 Brief Compiler

- 简单合同 0 API；
- 复杂合同 1 API；
- required IDs 全覆盖；
- 丢失 hard ID → 本地 fallback；
- 未知 ID → fallback；
- sourceHash 不匹配 → fallback；
- advisory 不得升级；
- Brief 不读取 draft；
- Brief 发送 `thinking=enabled` 与 `reasoning_effort=low`；
- Brief 的可见输出与 low reasoning headroom 独立分账；
- Brief 与其余四个 API 阶段使用同一弹性算力池，不设置独立小预算或静态 4K 上限；
- Brief 不重试；
- process death 后复用 succeeded brief。

### 17.5 Final V3

- Final messages 不含 Revision Contract JSON；
- 不含 anchor ID；
- 不含 source IDs；
- 包含完整 draft；
- 包含完整 outline；
- 包含即时上一章正文或 floor；
- 包含 Story Memory 关键状态；
- visible output floor 不被 reasoning headroom 挤占；
- warning 不触发第二次 Final；
- V3 Review/FactCheck/Brief/Proof 空、截断、reasoning-only、协议泄漏或连续性硬门禁失败均不回退 Draft，保持对应 checkpoint failed 并提供“从失败节点重试”；V2 历史任务按冻结版本处理。

### 17.6 前后文语义回归夹具

建立确定性夹具，不用模型评分：

上一章末冻结以下事实：

```text
人物：林岚
地点：钟楼密室
持有物：银钥匙、地图残页、金属请柬
未完成动作：等待第十三声钟响
已知信息：不知道电话女人身份
禁止推进：不能揭示沈先生真实身份
```

断言：

- Draft request 含上述即时状态；
- Review request 含上述状态；
- Brief source 保留相关 hard/required；
- Final request 含 continuity capsule；
- Final Brief 不要求提前揭示身份；
- Review 失败路径不调用 Final；
- locator 漂移不会产生 chapter 级修改授权。

### 17.7 多章与恢复

- 第 20 ～ 30 章仍冻结正确上一章；
- Story Memory clean/dirty/missing/coverage gap；
- 批次第 N+1 章读取第 N 章已采用正文；
- Brief 中断恢复；
- Review/Fact 并行 join 后只生成一次 Brief；
- 旧 V2 批次不出现 Brief；
- 新 V3 批次最坏调用预算正确。

### 17.8 Draft→Final 正文质量增益审计

流水线的技术成功、耗时和稳定性不能替代正文质量验收。每个真实 LLM 单章任务，以及批量任务中的每一个子任务，都必须保留并可关联读取以下四份证据：

```text
Draft → Normalized Review → Compiled Brief → Final
```

质量审计必须同时回答“审核发现的问题有没有被修复”和“终稿有没有引入新的前后文/剧情问题”：

- Review 的每一条 `required` / `hard` 修订逐条标记为 `applied`、`partially_applied`、`not_applied` 或 `not_applicable`；有明确可执行意见却在 Final 中 `not_applied` 时，该子任务质量不通过；
- Brief 的 `mustNotAdvance`、`mustFix`、`openingContinuity`、`endingState` 必须与 Final 对照核查；禁止提前揭示的身份、物件、地点、真相和后续动作不得出现在 Final 的已推进剧情中；
- 对照 Draft 与 Final 的开头接缝、结尾接缝、人物状态、持有物、地点、时间顺序、因果链和悬念边界；必须说明 Final 是修复、保持还是回归；
- 统计可见正文长度、段落数、对话/叙事结构、重复段落、协议/推理泄漏等客观证据，并保存 Draft/Final 的差异摘要；这些指标用于发现退化，不把字数增加当成质量提升；
- 质量判断必须包含人工可读的证据引用或短摘录，至少覆盖 Review 必改项和 Brief 前后边界，不能只以 `succeeded`、token 数或耗时作为结论；
- “技术门禁通过但正文没有实质改善，或出现新的关键衔接/剧情回归”判定为验收失败。该审计是发布验收与报告门禁，不改变 Review/FactCheck 的推理档位，也不把主观文学评分擅自变成自动拒绝条件。

---

## 18. 发版门禁

### 18.1 代码门禁

```text
npm run lint
npm run typecheck
npm run verify:version
npm run test:ci
```

新增测试不得仅验证 Stage 成功，还必须验证实际消息内容和预算字段。

### 18.2 真机门禁

至少完成：

1. V2.11.39 → V2.11.40 覆盖安装；
2. 旧 V2 interrupted task 恢复；
3. 新 V3 single chapter full；
4. 新 V3 complex Brief API；
5. Brief API 无效结果必须阻断 Final，并能从 Brief 失败处重启；
6. Review reasoning-only 提取，并核对 `finishReason` 与 reasoning/visible token 分账；
7. V2 历史 Review 失败语义保持兼容；V3 Review/FactCheck 失败不得回退 Draft，结果页必须提供对应失败节点重试；
8. V3 Proof 连续性硬门禁失败不得回退 Draft，结果页必须提供“从失败节点重试”，且只重跑 Proof；
9. 第 20 章以后前章衔接；
10. 两章批次顺序继承；
11. low/high/max 三档请求体抓包；
12. 结果页 reasoning/visible tokens；
13. 取消、杀进程、冷启动恢复。
14. 单章与批量子任务分别完成 Draft→Review→Brief→Final 正文质量增益审计；
15. 质量审计逐条证明 Review 的 required/hard 已落地、Brief 禁止提前项未泄漏、前后章接缝与剧情因果未回归；若只技术成功而正文无提升，验收必须失败。

### 18.3 必须满足的发布条件

- 新 V3 Final 不接收复杂合同 JSON；
- Brief required/hard 覆盖率为 100%；
- Brief 调用最多一次；
- Final 调用最多一次；
- Review 失败不进入 Fact-only 轻上下文 Final；
- locator 失败不扩大为 chapter；
- full outline 与上一章接缝不会被 reasoning 档位挤掉；
- `medium` 不再出现在新设置和新 V3 快照；
- DeepSeek V4 Flash 三档实际发送 low/high/max；
- Brief 始终 Thinking enabled + low，且不向 high/max 级联；
- Brief API 完整性校验失败不得伪装成成功或进入 Final；
- V3 Review/FactCheck/Brief/Proof 任一失败不得自动以 Draft 作为终稿交付，必须在结果页给出对应失败节点重试，并复用已成功 checkpoint；
- `reasoning-only` 不得被笼统解释为预算耗尽；必须记录 `finishReason`，并区分
  `length` 截断与 `stop` 空 content；
- 技术成功率、恢复成功率和正文质量增益率分开统计；不得用流水线状态成功替代终稿质量通过；
- 每个单章/批量子任务都有可复核的 Draft、Review、Brief、Final 对照证据，Review 必改项已落地，Brief 边界未被提前推进，且前后文/剧情衔接没有新增关键回归；
- 旧任务恢复语义不变。

---

## 19. 回滚方案

本轮不设置实验开关，但必须保留代码级紧急回滚：

```ts
CURRENT_OUTLINE_WORKFLOW_VERSION = 2;
CURRENT_CONTEXT_BUDGET_VERSION = 2;
```

回滚只影响未来新任务：

- 已冻结 V3 的任务继续按 V3 恢复；
- 不删除 brief checkpoint；
- 不改写历史 pipeline_context_json；
- 不把新 low/high/max 设置重新降回 low/medium/high；
- V2 compiler 与 V3 compiler 并存至少一个完整发布周期。

若必须停止某个正在恢复的 V3 任务，只能由用户显式重新开始，不能静默切协议。

---

## 20. 建议提交拆分

```text
1. feat(pipeline): add workflow v3 and normalize low/high/max reasoning profiles
2. refactor(pipeline): decouple stage output floors from reasoning headroom
3. fix(pipeline): prevent tolerant review locators from widening to chapter scope
4. feat(pipeline): add durable conditional brief compiler stage
5. feat(pipeline): compile final reviser v3 from plain brief and continuity capsule
6. fix(pipeline): freeze immediate previous chapter and remove duplicate draft body injection
7. feat(batch): inherit workflow v3 brief and stage reasoning snapshots
8. feat(ui): expose brief progress, effective tiers and budget diagnostics
9. test(pipeline): add v3 semantic continuity, recovery and device acceptance coverage
10. chore(release): bump V2.11.40 and update README/CHANGELOG
```

---

## 21. 最终验收定义

本方案完成的判定不是“Brief API 能调用成功”，而是以下链路整体成立：

```text
真实 low/high/max 设置
→ 逐阶段推理档位冻结
→ Draft 保留即时上一章与完整大纲
→ Review/FactCheck 输出被安全归一化
→ 非法定位不扩大修改权限
→ 复杂合同由固定 low Thinking 的 Brief Compiler 压缩
→ required/hard 本地覆盖校验通过
→ Final 只接收纯文本写作要求
→ Final 同时获得完整初稿与连续性最小闭包
→ 可见正文预算不被 Thinking 挤占
→ 正确正文一次交付
```

V3 的核心不是简单增加第五次调用，而是把职责重新分开：

- Review/FactCheck 负责判断；
- Brief Compiler 负责压缩和消歧；
- Final Reviser 负责写作；
- 本地代码负责预算、覆盖验证、恢复与技术交付。

只有这样，新增 Brief 才会减少整体推理时间，而不是把同一份复杂度再计算一遍；同时也能修复 V2 因合同丢失、定位扩大和终稿上下文过薄导致的前后文一致性下降。
