# ShineWriter 大纲流水线统一收束优化改造方案

> 文档状态：Final v1.0  
> 方案用途：交由本地 Agent 做施工前评估、实施、真机验证与发版验收  
> 远端参考基线：`anjingdtl/tavo-mini` `main@f56b489dc73d4ad6013b42802ba9c820b2c7b0b7`  
> 参考版本：ShineWriter V2.11.40 / Schema 49  
> 核心目标：**收束用户决策点、提高 Review / FactCheck / Brief 一次通过率、保留 Brief 的 LLM 编辑决策能力，并终止旧流水线未完成任务的执行兼容。**  
> 最终产品原则：**用户只决定“思考强度”，软件决定完整流水线。**

---

# 1. 最终决策摘要

本轮讨论后的最终方向不是继续增加流水线版本和配置，而是进行一次**产品与工程双收束**。

## 1.1 新任务只保留一条流水线

所有新的大纲章节任务固定执行：

```text
Draft
  ↓
Review ─────────┐
                ├─ 并行
FactCheck ──────┘
  ↓
Brief
  ↓
Final
```

不再允许用户选择：

```text
无审核
仅评估
仅核查
完整
```

这些模式从用户产品层彻底消失。

---

## 1.2 用户唯一的质量/成本决策点：思考强度

设置页只保留：

```text
思考强度

[ 快速 ]  [ 平衡 ]  [ 质量 ]
```

对应内部：

| 用户档位 | Draft | Review | FactCheck | Brief | Final |
|---|---|---|---|---|---|
| 快速 | low | low | low | low | low |
| 平衡 | high | low | low | high | high |
| 质量 | max | low | low | max | max |

原则：

- Draft：直接决定初稿创作质量，跟随用户档位；
- Review：快速发现文学、大纲、节奏问题，固定 low；
- FactCheck：快速做事实与连续性核查，固定 low；
- **Brief：承担真正的编辑决策、冲突消解和修订策略，必须跟随用户档位；**
- Final：执行完整终稿写作，跟随用户档位；
- Formatter：仅做格式整理，固定 `Thinking disabled`。

---

## 1.3 Brief 必须继续是 LLM 节点

本轮明确否决：

```text
Review + FactCheck
      ↓
纯本地 Brief Compiler
      ↓
Final
```

历史实现已经证明：纯本地 Brief 虽然结构稳定，但会机械拼接审核意见，无法可靠完成：

- 冲突消解；
- 修订轻重取舍；
- 编辑策略；
- 多条要求的合并；
- 节奏与事实约束之间的平衡；
- 将审查结果转换成自然、统一的写作方案。

因此正常主路径必须保留：

```text
Review + FactCheck
      ↓
Brief LLM
      ↓
Final
```

本地代码只负责**协议、证据、ID、覆盖、校验和安全信封**，不代替 Brief 做编辑推理。

---

## 1.4 一键写 N 章与单章完全统一

“一键写 N 章”不再拥有独立的：

```text
仅草稿
快速
完整
```

等生成模式。

Batch 只读取统一的流水线配置。

用户在设置页选择：

```text
快速 / 平衡 / 质量
```

之后：

```text
单章生成
一键写 N 章
```

全部使用同一条完整流水线和同一套推理策略。

Batch 创建时冻结当前思考强度，批次执行过程中用户修改设置，不影响已经创建的 Batch。

---

## 1.5 不再兼容旧流水线“继续执行”

这是本轮的重要收束决策。

升级后：

- 旧流水线已经完成的任务：保留、可查看、可采纳；
- 已采纳的历史正文：完全不动；
- **旧流水线未完成 / failed / interrupted / outcome_unknown 的任务：不再 Resume；**
- 用户尝试继续时，提示使用当前流水线重新生成。

即：

> **保留数据兼容，不保留旧执行协议兼容。**

数据库升级链、用户数据、历史任务记录仍要完整保留。

---

# 2. 当前主要问题：一次通过率，而不是正常推理速度

当前 V3.2 的真实测试已经说明：

Review / FactCheck / Brief 正常成功时，本应是整条流水线中最快的环节。

历史样本大致表现为：

```text
Draft       ~109.6s
Review       ~12.9s
FactCheck     ~7.0s
Brief         ~4.8s
Final        ~64.5s
```

因此问题并不是：

> “审核节点思考太慢。”

真正的问题是：

> **模型已经完成语义判断，但因为结构化合同过重，最终交付无法通过客户端严格协议。**

这会产生：

```text
Primary
  ↓
结构/字段不匹配
  ↓
Formatter
  ↓
仍失败
  ↓
用户从失败节点继续
  ↓
新的 Primary
```

从而让一个原本只需数秒到十几秒的审核节点变成多次调用、重复消耗和批次阻滞点。

---

# 3. 根因定义：LLM 承担了过多“工程协议责任”

当前需要继续拆开的不是“语义审查”，而是模型输出责任。

LLM 擅长：

```text
发现问题
判断事实
理解冲突
制定修改策略
生成文字
```

LLM 不适合长期承担：

```text
schemaVersion
draftHash
transport envelope
复杂 coverage 对象
稳定 sourceId
数据库外键式 ID 对齐
空数组搬运
协议版本
响应 channel
validation metadata
确定性去重
确定性冲突规则
```

最终原则：

> **复杂思考，极简交付。**

以及：

> **语义严格，格式宽容；协议严格，由客户端负责。**

---

# 4. 目标总体架构

```text
                         用户
                          │
                思考强度：快速/平衡/质量
                          │
                          ▼

                      Draft LLM
                          │
                          ▼
                 Stable Draft Anchors
                       0 LLM
                          │
                 ┌────────┴────────┐
                 ▼                 ▼
             Review LLM       FactCheck LLM
              fixed low          fixed low
                 │                 │
                 ▼                 ▼
          Local Semantic     Local Semantic
           Normalizer         Normalizer
                 └────────┬────────┘
                          ▼
                       Brief LLM
                 跟随用户 low/high/max
                          │
                          ▼
                Local Brief Envelope
             sourceId / coverage / hash
                       0 LLM
                          │
                          ▼
                       Final LLM
                 跟随用户 low/high/max
                          │
                          ▼
                 Local Final Validator
                       0 LLM
                          │
                          ▼
                        Final
```

---

# 5. 用户界面收束

## 5.1 删除“生成模式”

流水线设置页删除整个：

```text
生成模式

无审核 / 仅评估 / 仅核查 / 完整
```

新任务永远执行完整流水线。

## 5.2 “V3 思考强度”改名为“思考强度”

用户不需要知道：

```text
V3
V3.1
V3.2
Brief Compiler
effective tier
JSON
Formatter
reasoning profile
```

推荐文案：

### 快速
> 完整执行创作、审阅、事实核查、编辑规划和终稿，优先速度与成本。

### 平衡
> 审阅与事实核查保持快速；创作、编辑规划和终稿使用更强思考，兼顾质量与效率。

### 质量
> 审阅与事实核查保持快速；创作、编辑规划和终稿使用最高思考强度，优先成稿质量。

## 5.3 一键写 N 章删除生成模式选择

Batch 页面不再出现：

```text
仅草稿
快速
完整
```

只保留真正属于批量生成的选择，例如：

```text
生成章节数
起始章节 / 计划
开始生成
```

可选显示只读提示：

```text
当前思考强度：平衡
```

但不要再次提供第二个修改入口。

---

# 6. 推理策略收束

## 快速

```text
Draft      low
Review     low
FactCheck  low
Brief      low
Final      low
```

## 平衡

```text
Draft      high
Review     low
FactCheck  low
Brief      high
Final      high
```

## 质量

```text
Draft      max
Review     low
FactCheck  low
Brief      max
Final      max
```

Formatter：

```text
Thinking disabled
```

### Review / FactCheck 为什么固定 low

这两个节点的任务是“发现问题”，不是“负责写最终解决方案”。

它们应优先：

- 快；
- 覆盖完整；
- 定位准确；
- 一次成功。

不能因为 JSON 协议不稳定而把 reasoning 提升到 high/max 来掩盖协议设计问题。

### Brief 为什么跟随用户档位

Brief 的职责不是简单搬运：

```text
Review finding
FactCheck finding
```

而是：

```text
理解两份审核意见
判断冲突
确定优先级
决定修改方案
决定保留什么
决定怎么兼顾节奏与事实
形成 Final Writer 能直接执行的统一编辑策略
```

因此平衡/质量档应该提升 Brief reasoning。

---

# 7. Review 输出协议继续做减法

Review 模型只输出它真正判断的内容。

建议 Semantic Payload：

```json
{
  "verdict": "pass",
  "checked": [
    "outline",
    "pacing",
    "character",
    "dialogue",
    "ending"
  ],
  "findings": []
}
```

需要修改时：

```json
{
  "verdict": "revise",
  "checked": [
    "outline",
    "pacing",
    "character",
    "dialogue",
    "ending"
  ],
  "findings": [
    {
      "target": "draft-p-012",
      "level": "required",
      "issue": "本章提前进入下一章剧情",
      "instruction": "停在发现地下入口，不得真正进入"
    }
  ]
}
```

可选保留：

```json
{
  "preserve": ["draft-p-004"],
  "ending": "停在确认入口存在"
}
```

Review 不再要求模型输出：

```text
schemaVersion
draftHash
responseChannel
validation metadata
完整 transport envelope
复杂 sourceId
客户端已知硬约束
无意义空容器
```

这些全部由客户端完成。

---

# 8. FactCheck 输出协议继续做减法

建议 Semantic Payload：

```json
{
  "verdict": "pass",
  "checked": [
    "character_state",
    "knowledge",
    "timeline",
    "location",
    "items",
    "world_rules",
    "continuity"
  ],
  "findings": []
}
```

发现问题时：

```json
{
  "verdict": "revise",
  "checked": [
    "character_state",
    "knowledge",
    "timeline",
    "location",
    "items",
    "world_rules",
    "continuity"
  ],
  "findings": [
    {
      "target": "draft-p-021",
      "level": "hard",
      "issue": "林葵此时尚不知道钥匙用途",
      "instruction": "只能表现为确认钥匙存在，不得表现为知道用途"
    }
  ]
}
```

## 8.1 coverage 仍必须存在，但简化为模型可稳定表达的 `checked`

不能退回到：

```json
{
  "findings": []
}
```

然后客户端就认为“事实核查通过”。

正确做法：

```text
模型返回 checked[]
        ↓
客户端生成正式 CoverageReceipt
```

模型不负责生成复杂 coverage 对象。

---

# 9. 客户端 Semantic Normalizer

建议将当前 V3.2 已有的：

```text
structuredCandidate
auditSemanticEnvelope
v32AuditCompatibility
revisionAuditValidator
```

继续收束。

本地 Normalizer 负责：

1. 从 content / reasoning 提取候选；
2. Markdown fence 去除；
3. JSON 前后说明文本提取；
4. 单对象/数组常见形状兼容；
5. 字段别名安全映射；
6. level/category 的有限别名归一；
7. target anchor 验证；
8. 为 finding 分配稳定本地 ID；
9. 写入 draftHash；
10. 生成 immutable envelope；
11. 生成 CoverageReceipt；
12. 保存安全 validation details。

不得：

- 推测模型未表达的事实；
- 自行创造 finding；
- 把语义缺失当成格式问题修复。

---

# 10. Formatter 的定位

Formatter 继续存在，但必须降级为真正的“格式保险丝”。

触发条件：

```text
候选有明确语义
但结构无法被本地安全归一化
```

Formatter 输入：

```text
仅候选结果
+ 极简目标 schema
+ 合法 anchor/source manifest
```

禁止重新注入：

```text
完整 Draft
完整 Outline
Story Memory
人物资料
世界书
上一章正文
```

Formatter：

```text
Thinking disabled
```

每一次阶段执行最多：

```text
1 primary
+
1 formatter
```

Parse-only 问题不得自动重跑完整 Primary。

---

# 11. Brief 保留 LLM，但输出也必须极简

Brief 的输入是客户端已经规范化完成的：

```text
Review findings
FactCheck findings
Hard Constraints
Protected facts
Ending boundary
```

客户端在输入 Brief 前先为审核条目生成短 ID：

```text
R1
R2
F1
F2
```

不要使用长 hash 式模型可见 ID。

## 11.1 推荐 Brief Semantic Payload

```json
{
  "strategy": "压缩重复调查动作，但保留获得关键信息所必需的步骤；本章推进到确认门锁结构，不真正开门。",
  "actions": [
    {
      "covers": ["R1", "F2"],
      "instruction": "缩短重复调查，但保留人物获得密码线索的必要动作"
    },
    {
      "covers": ["F1"],
      "instruction": "林葵不得表现为知道钥匙用途"
    }
  ],
  "preserve": [
    "保留两人在旧仓发生意见冲突"
  ],
  "ending": "停在确认北塔门锁结构"
}
```

Brief 不再负责：

```text
schemaVersion
draftHash
复杂 source manifest
transport envelope
数据库级 ID
复杂 coverage 对象
完整 immutable hard constraints
validation details
```

本地程序补齐。

---

# 12. Local Brief Envelope

Brief LLM 返回后，本地负责将语义结果编译成 Final Writer 的正式写作 Brief。

本地检查：

1. `actions[].covers` 只能引用合法短 ID；
2. 所有 `hard/required` source ID 必须至少被一个 action 覆盖；
3. advisory 可以不强制覆盖；
4. 不允许 Formatter/Brief 新增不存在的 source；
5. 同 source 多 action 可以本地去重；
6. 明显互相矛盾的 hard actions fail-closed；
7. protected facts / hard constraints 使用客户端真值；
8. ending boundary 使用客户端真值。

本地不要代替 Brief 做：

```text
调查应该缩短到什么程度
怎样兼顾节奏与知识来源
两个文学建议怎样融合更自然
```

这些仍由 Brief LLM 决定。

---

# 13. Final 阶段保持当前成熟上下文闭包

本轮主要解决一次通过率，不重新推翻 Final 架构。

Final 继续获得：

- 完整 canonical Draft；
- 最终 Writing Brief；
- 当前章节完整大纲/要求；
- 即时上一章正文或必要章末；
- 当前故事状态闭包；
- 必要硬约束；
- 当前写作 preset/style。

不要因为 Brief 简化而再次把 Final 变成“盲写”。

Final 输出仍为：

> 完整、连续、可直接采纳的最终小说正文。

---

# 14. Local Final Validator 保持 0 LLM

继续只做技术交付门禁：

- 空正文；
- reasoning/protocol 泄漏；
- JSON/Prompt 冒充小说；
- 明显截断；
- 灾难性坍缩；
- 严重重复；
- 明显不是真实章节正文。

不要让本地代码假装判断文学是否精彩。

---

# 15. Pipeline Mode 从产品层彻底退出

新任务创建时：

```text
固定完整流水线
```

不再读取用户：

```text
noReview
twoStage
conditional
full
```

的选择。

旧数据库字段可以暂时保留，作为：

```text
历史记录
兼容读取
诊断
```

但不得再参与**新任务的执行决策**。

---

# 16. 一键写 N 章统一策略

Batch 创建时冻结：

```text
当前统一 workflow version
当前 reasoning tier
当前 context budget version
```

同一个 Batch 所有子任务必须使用同一份冻结策略。

运行中用户去设置页修改：

```text
平衡 → 质量
```

当前 Batch 不改变。

下一次新 Batch 才读取新配置。

Batch 每章仍严格顺序执行：

```text
chapter N Final
      ↓
采纳 / 持久化
      ↓
更新 Story Memory / 连续性状态
      ↓
chapter N+1 Draft
```

不得引入 Batch 并行写章。

---

# 17. 旧流水线兼容策略：只保数据，不保执行

本轮明确删除“旧未完成任务继续 Resume”的产品要求。

## 17.1 已完成旧任务

```text
completed
```

处理：

- 保留；
- 可以查看；
- 可以采纳；
- 不重新生成；
- 不改变历史 token/attempt。

## 17.2 已采纳历史正文

完全不动。

## 17.3 旧流水线未完成任务

包括：

```text
idle/running
failed
interrupted
outcome_unknown
paused
```

且：

```text
task.workflowVersion !== CURRENT_WORKFLOW_VERSION
```

时：

> 不允许 Resume。

用户提示：

```text
该任务使用旧版生成流程，升级后已无法继续。
为保证生成质量，请使用当前流水线重新生成。
原章节正文和已完成历史结果不会被覆盖。
```

按钮：

```text
[稍后]
[按新版重新生成]
```

---

# 18. 旧 Batch 的处理

旧 Batch 已经完成并采纳的章节：

```text
全部保留
```

当前正在生成但尚未完成的章节：

```text
放弃旧 Pipeline 中间状态
按当前流水线从 Draft 重跑
```

后续尚未开始的章节：

```text
全部使用当前流水线
```

推荐实现：

```text
旧 Batch
第1章 ✓
第2章 ✓
第3章 interrupted
第4～10章 pending
```

用户点击“按新版继续”后：

```text
旧 Batch → 历史只读/结束

新 Batch
起点：第3章
剩余：第3～10章
统一新 workflow
统一 reasoning tier
```

不要让一个 Batch 内混用多代协议。

---

# 19. 执行兼容代码的清理原则

可以删除/收束：

- V1/V2/V3.1 未完成任务的执行分支；
- 旧 reasoning profile 的 Resume 决策；
- 旧 Contract → 当前 Contract 的执行转换；
- 旧任务 Formatter 恢复分支；
- 旧 PipelineMode 新任务创建逻辑；
- Batch 旧 mode 新建逻辑。

但不要为了“代码看起来干净”删除：

- 数据库历史迁移；
- 历史任务读取；
- 历史结果页；
- attempt / token 历史；
- 已采纳 revision；
- Backup/Restore 兼容。

一句话：

> **删除旧执行引擎，不删除旧数据解释能力。**

---

# 20. Workflow Version 建议

由于本轮改变了：

- 用户模式模型；
- Brief reasoning policy；
- structured semantic payload；
- 旧任务恢复策略；

建议创建新的内部 workflow version。

例如：

```ts
CURRENT_OUTLINE_WORKFLOW_VERSION = 4
```

但具体数字以本地 HEAD 当前常量为准，Agent 不得机械采用 4。

已有数据库 `outline_workflow_version` 为整数列时，优先复用现有字段，不为“版本号 +1”单独升级 Schema。

`contextBudgetVersion` 如果预算算法没有变化，则继续沿用当前版本。

---

# 21. 一次通过率成为核心发版指标

从本轮开始，不再把：

```text
最终能恢复完成
```

作为主要成功指标。

必须单独统计：

```text
Review Primary Pass Rate
FactCheck Primary Pass Rate
Brief Primary Pass Rate
```

Primary Pass 定义：

```text
stage primary 第一次请求
无需 Formatter
无需用户重试
直接形成有效合同
```

## 21.1 Straight-Through Audit Rate

定义：

```text
Review primary pass
AND
FactCheck primary pass
AND
Brief primary pass
```

整个审核链不经过 Formatter、不需要用户重试。

## 21.2 Call Amplification

定义：

```text
结构化阶段物理调用数
÷
结构化阶段实例数
```

理想值：

```text
1.00
```

---

# 22. 建议验收目标

以下作为真实 LLM 发布目标，不作为模型供应商绝对 SLA：

| 指标 | 最低验收 | 目标 |
|---|---:|---:|
| Review primary pass | ≥90% | ≥95% |
| FactCheck primary pass | ≥90% | ≥95% |
| Brief primary pass | ≥90% | ≥95% |
| 单阶段 Formatter 命中率 | ≤10% | ≤5% |
| parse-only 完整 primary replay | 0 | 0 |
| 成功 checkpoint 重复调用 | 0 | 0 |
| Straight-through audit rate | ≥80% | ≥90% |
| 结构化调用放大 | ≤1.20 | ≤1.10 |

样本不足时不得用 3 个章节就宣称达到长期比例。

---

# 23. 可观测性

每个结构化阶段记录：

```text
primary_pass
formatter_used
manual_retry_count
response_channel
validation_failure_category
checked_dimension_count
finding_count
required_finding_count
input_tokens
visible_tokens
reasoning_tokens
duration
```

Brief 额外记录：

```text
input_required_source_count
covered_required_source_count
brief_action_count
```

不得保存完整 reasoning 正文。

---

# 24. 错误分类必须区分“格式失败”和“语义失败”

建议至少：

```text
FORMAT_INVALID
JSON_EXTRACT_FAILED
MISSING_CHECKED_DIMENSIONS
INVALID_ANCHOR
SEMANTIC_EMPTY
REQUIRED_FINDING_MISSING
BRIEF_REQUIRED_SOURCE_UNCOVERED
BRIEF_CONFLICTING_HARD_ACTION
CONTENT_FILTER
OUTCOME_UNKNOWN
```

这样后续才能知道一次通过率到底卡在：

```text
模型没想明白
```

还是：

```text
模型想明白但交付格式漂移
```

---

# 25. 推荐施工顺序

## Phase 0：施工前评估

Agent 先确认本地：

- HEAD；
- dirty files；
- 当前 workflow/context/reasoning 版本；
- 当前设置页生成模式字段；
- Batch mode；
- V3.2 structured contracts；
- Brief input/output；
- legacy resume 分支；
- 当前 Schema；
- 当前真实测试。

只评估，不改代码。

## Phase 1：产品配置收束

完成：

- 删除“生成模式”UI；
- “V3 思考强度”改为“思考强度”；
- 简化用户文案；
- 新任务固定完整流水线；
- Batch 删除模式选择；
- Batch 读取统一 reasoning tier。

这一阶段暂不修改 Structured Contract。

## Phase 2：Reasoning Policy 收束

实现：

```text
Draft      user tier
Review     low
FactCheck  low
Brief      user tier
Final      user tier
Formatter  disabled
```

新任务冻结当前档位。

## Phase 3：Review / FactCheck Semantic Payload 简化

把模型输出缩减到：

```text
verdict
checked
findings
少量必要语义字段
```

其余全部客户端 envelope 化。

## Phase 4：Brief Semantic Payload 简化

保留 Brief LLM。

输入使用短 source ID：

```text
R1/R2/F1/F2
```

输出只保留：

```text
strategy
actions + covers
preserve
ending
```

客户端再构建正式 Final Writing Brief。

## Phase 5：旧执行兼容切断

实现：

```text
legacy incomplete task
→ cannot resume
→ restart with current pipeline
```

Batch：

```text
legacy incomplete batch
→ preserve completed chapters
→ close old batch
→ create new remaining batch
```

## Phase 6：测试、模拟器与真实 LLM 验收

最后再决定发版。

---

# 26. 自动化测试矩阵

## 26.1 UI

- 生成模式选择器不存在；
- 设置页只存在思考强度；
- 不出现 V3/V3.2/effective/JSON 等开发术语；
- Batch 页面不存在独立生成模式；
- Batch 能显示当前统一档位。

## 26.2 新任务拓扑

所有新任务：

```text
Draft
Review
FactCheck
Brief
Final
```

Review/FactCheck 并行。

禁止创建：

```text
noReview
review-only
fact-only
draft-only
```

新任务。

## 26.3 Reasoning

验证：

```text
快速：
全部 low

平衡：
Draft high
Review low
FactCheck low
Brief high
Final high

质量：
Draft max
Review low
FactCheck low
Brief max
Final max
```

Formatter 始终 disabled。

## 26.4 Review / FactCheck

必须覆盖：

- 极简合法 JSON；
- Markdown fenced JSON；
- content-only；
- reasoning-only；
- content + reasoning；
- 字段别名；
- 缺 checked；
- 空 findings + 完整 checked；
- invalid anchor；
- hard finding；
- parse-only → Formatter；
- Formatter 再次非法 → fail closed；
- parse-only 不重放 Primary。

## 26.5 Brief

必须覆盖：

- 所有 required ID 被覆盖；
- 一个 action 合并多个 source；
- 同 source 重复 action；
- 非法 source；
- hard source 漏覆盖；
- advisory 漏覆盖允许；
- hard action 冲突；
- Formatter 不得新增 source；
- Brief high/max reasoning 配置；
- Brief output 极简 schema。

## 26.6 Batch

验证：

- Batch 无 mode；
- reasoning tier 创建时冻结；
- 中途改设置不改变当前 Batch；
- 下一章只在上一章 Final/采纳完成后启动；
- 所有子任务新 workflow；
- 不混版本。

## 26.7 旧任务

### completed
可查看、可采纳。

### legacy failed/interrupted
Resume 不启动旧 Pipeline。

必须显示：

```text
按新版重新生成
```

并创建当前 workflow 的新任务。

## 26.8 旧 Batch

- 已完成章节不重做；
- 当前未完成章节从 Draft 新跑；
- 旧 Batch 不继续；
- 新剩余 Batch 使用当前 workflow；
- 不丢历史 token/attempt/revision。

---

# 27. 真实 LLM 验收建议

本轮一次通过率是核心，因此真机测试不能只跑“最终成功”。

建议至少：

```text
5 个单章
+
1 个 N=5
```

合计至少 10 个真实章节。

如果成本过高，第一轮可先：

```text
3 单章 + N=3
```

但只能作为 RC，不作为长期一次通过率统计结论。

每个真实章节记录：

```text
Draft attempts
Review primary/formatter
FactCheck primary/formatter
Brief primary/formatter
Final attempts

input tokens
visible tokens
reasoning tokens
duration
failure category
manual retry count
```

文学验收仍必须检查：

- 大纲节点；
- 上一章承接；
- 人物知识边界；
- 时间空间；
- 世界规则；
- 越界剧情；
- Brief 是否真正解决 Review/FactCheck 冲突；
- Final 是否执行 Brief；
- 是否机械、重复、截断。

---

# 28. 发版阻断条件

出现以下任一情况不得发版：

1. 用户仍可创建非完整新流水线；
2. Batch 仍存在第二套生成模式；
3. Brief 在平衡/质量档仍固定 low；
4. Review / FactCheck 被提升到 high/max 来掩盖合同失败；
5. Review / FactCheck 仍要求模型搬运大量本地已知字段；
6. Brief 仍要求复杂 transport contract；
7. parse-only 自动重跑完整 Primary；
8. Formatter 能新增审核判断；
9. FactCheck 无 checked/coverage 仍可空成功；
10. Brief 漏掉 hard/required source 仍通过；
11. 旧未完成任务仍进入旧执行引擎；
12. 旧已完成/已采纳结果被破坏；
13. Batch 已完成章节因升级被重做；
14. `npm run verify` 失败；
15. Debug APK 升级安装数据丢失；
16. 真机测试仍出现明显调用放大且未解释；
17. Release APK 未按项目签名流程验证。

---

# 29. 不在本轮范围内

不要顺手处理：

- LLM streaming 大重构；
- Provider 全局重构；
- 继续增加审核节点；
- 删除 Brief LLM；
- 改成多候选投票；
- Story Memory 再设计；
- Continuation V5 重构；
- Batch 并行写章；
- 本地模型架构；
- 全局数据库瘦身；
- 物理删除所有旧版本字段。

这些如有价值，另开后续方案。

---

# 30. Agent 施工前评估模板

```markdown
# 大纲流水线统一收束施工前评估

## 1. 本地基线
- HEAD:
- origin/main:
- dirty files:
- app version:
- schema:

## 2. 当前用户配置入口
- 生成模式：
- 思考强度：
- Batch mode：

## 3. 当前新任务拓扑
...

## 4. 当前 reasoning profile
...

## 5. Review/FactCheck 当前模型输出字段
...

## 6. Brief 当前模型输出字段
...

## 7. 当前 legacy resume 分支
...

## 8. 本方案与本地代码不一致处
...

## 9. 预计删除/收束的生产代码
...

## 10. 数据兼容边界
...

## 11. 测试计划
...

## 12. 是否建议施工
YES / NO
```

Agent 在完成评估前不得直接大改生产代码。

---

# 31. 最终产品心智

用户最终只需要理解两个问题：

```text
我要写什么？
```

以及：

```text
我要更快，还是更高质量？
```

不再要求用户理解：

```text
无审核
仅评估
仅核查
完整
V3
V3.2
Brief Compiler
JSON Contract
Formatter
effective tier
workflow version
```

最终界面是：

```text
流水线配置

思考强度

[ 快速 ]  [ 平衡 ]  [ 质量 ]
```

而软件内部始终执行：

```text
Draft
   ↓
Review + FactCheck
   ↓
Brief
   ↓
Final
```

---

# 32. 最终工程原则

本轮改造的最终原则可以压缩为五句话：

> **一条流水线，不让用户选内部节点。**

> **一个思考强度，单章与一键 N 章统一使用。**

> **Review / FactCheck 复杂思考、极简交付。**

> **Brief 保留 LLM 智能，并跟随用户质量档位；客户端负责协议，不负责编辑决策。**

> **旧数据继续兼容，旧未完成执行链不再兼容。**

如果这五条最终在代码、UI、Batch、恢复策略和真实 LLM 测试中全部成立，本轮“收束优化”才算真正完成。
