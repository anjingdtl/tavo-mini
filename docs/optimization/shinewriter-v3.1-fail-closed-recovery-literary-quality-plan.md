# ShineWriter 大纲流水线 V3.1：失败闭锁、结构化恢复与终稿文学质量修复建设方案

> 文档状态：Final v1.0，作为本轮直接改造与验收基线；不代表代码已经完成或验收通过  
> 编写日期：2026-08-09  
> 决策方式：基于 2026-08-09 产品/技术一问一答结果定稿；未单独选择的实施细节采用本文推荐方案  
> 适用范围：上线后的新 V3.1 大纲流水线任务；V2 历史任务保持兼容  
> 前置方案：`shinewriter-v3-brief-compiler-continuity-repair-plan.md`

---

## 1. 本轮结论先行

V3.1 不再把“API 有返回”“JSON 勉强可解析”“最终存在一段正文”混为同一种成功。

本轮统一采用以下原则：

1. **V3 任一必需节点失败即闭锁。** Review、FactCheck、Brief、Final 中任何一个当前模式要求执行的节点失败、缺失、空响应或合同无效，都不得伪装为成功，不得跳过后继续进入 Final，也不得把 Draft 当作 Final 交付。
2. **失败页必须始终提供“从失败节点重试”。** 已成功 checkpoint 原样复用，只重跑第一个失败节点及尚未成功的下游节点；并行完成的另一个审核节点不得重复计费。
3. **Review/FactCheck/Brief 关闭 Thinking。** 它们是结构化审计器/合同编译器，必须把可解析合同写入 `message.content`；高推理预算只留给 Draft 和 Final。结构化节点仍保留各自的 low 预算档位用于预算与诊断，但不发送 Thinking。
4. **reasoning-only 不再重做一次完整审核。** 新 V3.1 首次结构化请求即要求 content-only；若兼容网关仍返回 reasoning-only，先做一次明确的禁思考合同重试，仍无效时只允许一次轻量 Audit Formatter，将已有 reasoning 转成合同，不再重复注入 Draft、长大纲和完整资料。
5. **Brief 保留统一弹性预算。** 不设置容易截断合同的小型静态上限；弹性输出上限与实际消耗、Thinking 档位分开管理。
6. **Review 合同取消对精确段落锚点的硬依赖。** 使用“开头/场景/中段/结尾/全章 + 短证据摘录”的语义定位，避免 locator 漂移令必改项失去可执行性。
7. **Final 的软件交付门禁保持克制。** 正确返回非空小说正文、没有协议泄漏且没有明显截断即可完成该节点；不得从普通必改指令中抽取所谓“禁词”，不得因关键词命中自动二次生成整篇终稿。
8. **文学质量通过输入合同与发布验收保证。** Final 必须直接获得上一章接缝、当前章大纲、人物/世界观硬事实、Draft 和 Brief；发布前用资料齐全的真实长大纲样本逐条验收，不再用阶段状态、字数或 token 数代替文学判断。
9. **成功终稿允许派生重写。** 用户可补充一条不覆盖 Brief 硬约束的修订要求，只重新调用 Final；派生任务保留原任务、原终稿和完整证据链。
10. **旧 V3 执行链不迁移。** 升级前创建灾难恢复备份，再事务清理旧 V3 task/checkpoint/attempt 与阶段结果；保留已采纳章节正文、内容修订历史和独立 API 用量日志。

这不是增加更多重复调用，而是让每一次调用职责更窄、输入更明确、失败更诚实。

---

## 2. 问题背景与独立复核结论

### 2.1 当前稳定性问题

本轮设备数据库与日志复核得到以下事实：

- 已观察到的 12 个 V3 Review API 任务中，5 个任务的首次 Review 出现 `content=empty + reasoning_content!=empty`，即 reasoning-only；
- 上述首次请求的 reasoning 输出分别约为 1,027、2,335、1,338、2,800、2,908 token，并不能仅凭 reasoning-only 推断 `max_tokens` 耗尽；
- 当前历史 attempt 证据不足以完整区分所有 `finish_reason`，因此后续必须持久化完成原因与双通道 token 分账；
- 当前恢复路径曾采用“再次携带 Draft/上下文、关闭 Thinking、重跑完整 Review”的方式，既丢弃第一次 reasoning 中已经形成的判断，又重复消耗输入、延长串行耗时；
- 已观察到 3 个 Brief checkpoint 失败：一个来自早期固定小预算，另两个即使使用弹性大上限仍因 `sourceId`、必填 instruction 等合同问题失败。因此 Brief 剩余问题主要是合同归一化与语义完整性，不是继续放大 `max_tokens`。

### 2.2 当前 Review 定位协议问题

真机结果页曾连续出现 5 条 Review locator 无效警告，全部被转为 `unlocatedRequired`。这证明精确 anchor/range 对模型生成的审计报告不够稳定。

问题不在于是否把无效锚点扩大到全章，而在于：**Final Reviser 本身能够阅读完整 Draft，Review 没有必要把每个修改意见绑定到脆弱的段落编号。**

V3.1 应把 Review 的身份从“基于硬锚点的补丁生成器”改为“带证据的语义审计器”。

### 2.3 当前终稿文学质量问题

已复核的三章真实正文不能支持此前“质量已经通过”的结论：

| 样本           | 复核结论   | 关键问题                                                                                                                                   |
| -------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 第 5 章        | 不通过     | 角色已经捡起齿轮并读完纸条后，正文又写“这枚齿轮还在水中，还没有被她拾起来”，构成同场景硬时间矛盾；不能判为 4/4 必改项落地                  |
| 封印的档案室   | 有条件通过 | 与上一章下楼梯的接缝自然、主要节拍完成；但“女人没有走近”后手却直接伸到角色面前取走文件，存在空间动作矛盾，且比喻表达偏密                   |
| 残图的齿轮诗篇 | 不通过     | 大纲要求午夜行动，终稿在 23:37 提前执行；泄露第三把钥匙相关信息；用“营业执照/重新登记姓名”解释林兰与沈照的关系，属于资料未支持的说明性补丁 |

另外，这三章测试快照中的 `outlineText`、`characterText`、`worldbookText`、`noteText`、`storyMemoryText`、`episodicMemoryText` 均为空。它们最多只能证明“上一章局部接缝”能力，不能证明“符合二十多章大纲、人物卡、世界书和长记忆”。

因此，V3.1 的质量验收必须更换为资料齐全的长大纲夹具。

### 2.4 当前实现需要纠正的附带问题

- 新 V3 high/max 档仍将 Review/FactCheck 提升到 high，与结构化审计器定位不符；
- Final 连续性检查失败时会自动再调用一次 Final，重复高成本生成；
- Final 合规检查会从普通 `mustFix.instruction` 中提取词语作为 forbidden marker，可能把“补充坐标”等正向要求误判成禁写“坐标”；
- 任务列表阶段总数仍存在硬编码为 4 的路径，V3 full 实际为 5 个阶段时可能显示 `5/4`；
- 当前 Review、FactCheck、Brief 的宽容解析边界不一致，模型轻微字段漂移会在不同节点得到不同结果。

### 2.5 真机补充缺陷：Brief 丢失 hardConstraints

补充真机截图显示：Review 与 FactCheck 已成功，Brief 返回约 657 个可见 token、1,059 个 Thinking token，但以“Brief 丢失 hardConstraints”失败。该问题不是空响应，也没有证据表明由输出预算耗尽造成。

当前实现的真实语义是：`FinalWritingBriefV1` 没有独立 `hardConstraints` 字段，校验器要求 FactCheck 的每条 `hardConstraints` 都被 Brief LLM **逐字复制**到 `mustPreserve`，并用字符串完全相等判断。提示词只泛化要求“保留所有 hard/required”，模型一旦遗漏或改写措辞，就会被拒绝。

门禁阻断 Final 和“从失败节点重试”按钮是正确行为，但只重试 Brief 不能根治“让 LLM 搬运不可变字段”的架构缺陷。V3.1 必须把 hardConstraints、protectedFacts、mustNotAdvance 等不可变约束改为本地确定性继承；LLM Brief 只生成需要语义压缩的可变写作指令。

---

## 3. 建设目标与非目标

### 3.1 建设目标

V3.1 同时满足三类目标。

#### 执行效率

- Review/FactCheck/Brief 关闭 Thinking；
- reasoning-only 恢复不重放 Draft 与完整资料；
- Review 与 FactCheck 在 full 模式继续并行；
- 已成功 checkpoint 在重试时不重复调用；
- Final 正常路径只调用一次。

#### 执行稳定性

- 每个必需节点只有真实成功后才能推进；
- 结构化输出允许安全格式漂移，但不允许补造关键语义；
- 所有失败均可定位、可恢复、可计费追溯；
- reasoning-only、截断、空响应、JSON 无效、语义字段缺失分别记录；
- 杀进程、冷启动、批次暂停后仍从冻结 checkpoint 恢复。

#### 终稿文学质量

- 开头自然承接上一章的时间、地点、动作和人物状态；
- 当前章大纲要求的必达节拍完整落地；
- 不提前推进下一章边界；
- 人物身份、称谓、持有物、伤势、知识范围符合资料；
- 世界观规则、时间线、空间动作和因果链没有新增硬矛盾；
- Final 确实落实 Review/FactCheck 的 required/hard 项，而不是只改写措辞。

### 3.2 非目标

- 不通过多路生成、投票或 A/B 实验换取微弱质量提升；
- 不新增一个高 Thinking 的“终稿后审稿器”作为每章固定串行步骤；
- 不用简单关键词命中自动否决文学正文；
- 不把静态小 token 上限重新加到 Brief；
- 不修改已冻结 V2 历史任务的恢复语义；
- 不把风格偏好（例如比喻密度）一律升级为运行时硬失败。

---

## 4. 目标流水线

```text
Draft（用户档位）
  │
  ├───────────────┐
  ▼               ▼
Review（固定 low） FactCheck（固定 low）
  │               │
  └──── 成功汇合 ─┘
          │
          ▼
Brief Compiler（固定 low，弹性预算）
          │
          ▼
Final Reviser（用户档位，正常路径单次调用）
          │
          ▼
最小交付校验 → 成功正文
```

任何必需节点失败时：

```text
checkpoint = failed
task = failed
下游不执行
结果页显示失败原因 + “从失败节点重试”
```

full 模式中，Review 与 FactCheck 的并行关系不改变。如果 Review 失败而 FactCheck 成功，系统保留成功的 FactCheck，仅重试 Review；两者都成功后才进入 Brief。

---

## 5. V3 fail-closed 状态机

### 5.1 节点成功定义

| 节点      | 成功条件                                         | 不得视为成功的情况                                                |
| --------- | ------------------------------------------------ | ----------------------------------------------------------------- |
| Draft     | 返回非空、可交付的小说初稿                       | reasoning-only、空文本、明显截断、协议正文                        |
| Review    | 获得可归一化且语义完整的审计合同                 | 只有 reasoning 且恢复失败、必需审计字段缺失、引用来源不可确认     |
| FactCheck | 获得可归一化且语义完整的事实合同                 | 只有 reasoning 且恢复失败、hard 事实缺失来源、合同截断            |
| Brief     | 所有 required/hard sourceId 被覆盖，边界字段完整 | 本地 fallback 冒充 API 成功、未知 sourceId、必改 instruction 为空 |
| Final     | 正确返回非空小说正文，无协议泄漏、无明显截断     | 空正文、reasoning-only、JSON/分析文本代替小说、明显未完成         |

### 5.2 不允许的降级路径

V3 新任务禁止以下行为：

- Review 失败后使用 FactCheck 单边结果进入 Brief/Final；
- FactCheck 为当前模式必需却失败时，仅靠 Review 进入 Final；
- Brief API 合同无效后，写入本地简化 Brief 并标记成功；
- Final 失败后，把 Draft 写入 `finalText` 并展示“终稿成功”；
- checkpoint 为 `skipped`，但当前模式其实要求该阶段时继续推进；
- 将 warning、degraded、fallback 文案包装成普通 success。

### 5.3 模式语义

| 模式        | 必需路径                                   | 失败处理                             |
| ----------- | ------------------------------------------ | ------------------------------------ |
| noReview    | Draft                                      | Draft 失败即停止；没有 Brief/Final   |
| twoStage    | Draft → Review → Brief → Final             | Review/Brief/Final 任一失败即停止    |
| conditional | Draft → FactCheck → Brief → Final          | FactCheck/Brief/Final 任一失败即停止 |
| full        | Draft → Review ∥ FactCheck → Brief → Final | 两个审计都成功后才能继续             |

`skipped` 只允许表示“该模式设计上不执行”，不能表示“执行失败但决定放过”。

---

## 6. 从失败节点继续

### 6.1 用户体验要求

只要任务以可恢复失败结束，结果失败页和任务中心卡片都必须显示主操作按钮：

```text
从失败节点重试
```

页面同时展示：

- 失败节点名称；
- 人类可读的失败原因；
- 是否会重新产生 API 费用；
- 哪些成功节点会直接复用；
- 如果输入已变化，明确提示将按冻结输入重试，另提供“按当前内容重新开始”。

不能只显示“返回”“放弃”“重新运行完整流水线”。

点击重试后必须先弹出费用确认，明确列出将重新调用的节点和直接复用的成功 checkpoint。人工重试次数不设硬上限；每次重试都新增 attempt 并保留历史，不能覆盖旧 attempt。

### 6.2 checkpoint 重置规则

| 首个失败节点 | 重试时保留                                | 重置为 pending          |
| ------------ | ----------------------------------------- | ----------------------- |
| Draft        | 无                                        | Draft 及全部下游        |
| Review       | 已成功 Draft；full 模式中已成功 FactCheck | Review、Brief、Final    |
| FactCheck    | 已成功 Draft；full 模式中已成功 Review    | FactCheck、Brief、Final |
| Brief        | Draft、Review、FactCheck                  | Brief、Final            |
| Final        | Draft、Review、FactCheck、Brief           | Final                   |

重试不得重新编译或静默替换已经成功节点的冻结输入。若用户选择“按当前内容重新开始”，创建新任务，不污染旧任务审计链。

full 模式中 Review 与 FactCheck 同时失败时，一个“从失败节点重试”操作同时重置两个失败分支并重新并行执行；已经成功的并行分支不重跑。

### 6.3 自动重试与人工重试边界

- 明确的网络瞬断、429 且存在可靠 retry-after，可按现有安全策略有限自动重试；
- `outcome_unknown` 不得静默自动重试；
- 合同语义无效、reasoning-only 恢复失败、Brief 缺关键字段、Final 交付无效，进入失败页等待人工重试；
- 自动重试耗尽后仍必须展示“从失败节点重试”。

Draft 或 Final 出现 reasoning-only 时不做隐藏的完整重算：两者都需要创作正文，不能像结构化合同一样安全地从 reasoning 转换，必须直接失败并交由用户重试。

### 6.4 UI 阶段计数

阶段总数必须由冻结执行图动态计算：

- noReview：1；
- twoStage：4；
- conditional：4；
- full：5。

禁止继续硬编码 `totalStages = 4`。

### 6.5 批量任务失败

多章批量流水线中任一章节失败时立即暂停整个批次，尚未生成的后续章节不得绕过失败章节继续运行。用户从该章节的失败节点重试成功后，批次再按原顺序继续，确保后一章始终继承前一章的确定正文状态。

---

## 7. 推理档位归一化 V3

### 7.1 新档位级联

```ts
const STAGE_REASONING_PROFILE_V3 = {
  low: {
    draft: 'low',
    review: 'low',
    factCheck: 'low',
    brief: 'low',
    proof: 'low',
  },
  high: {
    draft: 'high',
    review: 'low',
    factCheck: 'low',
    brief: 'low',
    proof: 'high',
  },
  max: {
    draft: 'max',
    review: 'low',
    factCheck: 'low',
    brief: 'low',
    proof: 'max',
  },
} as const;
```

这里的内部 `proof` 仍对应用户看到的“终稿”。后续可单独重命名，但不得在本轮大规模改枚举导致历史 checkpoint 失配。

### 7.2 为什么结构化阶段关闭 Thinking

- 它们需要判断，但输出是紧凑、可验证的结构化审计合同；
- high/low Thinking 均可能出现推理占比过高、可见 JSON 为空的真实样本；
- 它们不直接创作小说，不应与 Draft/Final 竞争高推理预算；
- low 仍作为预算档位和诊断标签保留，但不再发送 Thinking；
- 输出稳定性、端到端耗时和用户成本都能得到直接改善。

### 7.3 版本冻结

新任务冻结：

```ts
reasoningProfileVersion: 3;
```

兼容规则：

- V2 历史任务继续使用原历史逻辑；
- 升级时清理全部旧 V3/profile 2 任务及其流水线中间结果，不允许旧合同恢复到新执行器；
- 已被用户采纳的章节正文和内容修订历史不属于流水线中间结果，必须保留；
- 独立 `llm_usage_logs` 必须保留，历史 token 与费用仍可核对；
- 上线后新建任务统一使用 profile 3；
- UI 展示 requested tier 与每阶段 effective tier，避免用户误以为 high 会让所有节点都 high。

---

## 8. reasoning-only 恢复协议

### 8.1 设计缺口

当前缺口不是“没有重试”，而是重试职责错误：第一次 Review 已在 reasoning 中完成大量判断，第二次却丢弃这些判断，重新发送 Draft 和完整上下文要求模型再审核一次。

这会造成：

- 重复读取长输入；
- 两次判断可能不一致；
- 额外延迟与 token；
- 第二次仍可能产生 reasoning-only；
- 恢复行为与“格式恢复”名义不一致。

### 8.2 新恢复流程

```text
Review/FactCheck/Brief：Thinking disabled
  │
  ├─ content 可归一化 ───────────────→ success
  │
  ├─ content 空、reasoning 非空
  │      │
  │      ├─ 本地提取出完整合同 ──────→ success
  │      │
  │      └─ 提取失败
  │             │
  │             └─ Audit Formatter 一次
  │                    ├─ 合同有效 ──→ success
  │                    └─ 仍无效 ────→ failed
  │
  └─ content 与 reasoning 都空 ──────→ failed
```

### 8.3 本地提取顺序

1. 直接解析 content；
2. 提取 fenced JSON；
3. 提取首个完整 JSON object/array；
4. 若 content 为空，再对 reasoning_content 执行相同提取；
5. 进行字段别名、空白、数字字符串、额外字段等安全归一化；
6. 验证所有关键语义字段。

本地归一化可以修格式，不能补造审核结论。

### 8.4 Audit Formatter

Formatter 的输入只允许包含：

- 第一次响应的 `reasoning_content`；
- 目标 JSON schema 的简化说明；
- 本次合法 `sourceId` 清单；
- 固定指令“只整理已有判断，不新增审核意见”。

Formatter 禁止读取：

- Draft 全文；
- 大纲全文；
- 上下文章节；
- 人物卡、世界书和长记忆；
- 第一次 Review 的原始长请求。

Formatter 固定使用 Thinking disabled，并要求最终合同必须写入 content。若 Provider 无法可靠关闭 Thinking，则该 Formatter 请求不满足 V3.1 能力条件，节点失败并交由用户重试，不能静默改成 low。最多调用一次。

Review、FactCheck、Brief 的正式调用继续使用 `response_format=json_object`，并发送 `thinking=disabled`；不支持该可选扩展的兼容网关会退化为省略该字段的 content-only 请求。V3.1 通过 content-only 首请求、一次禁思考重试、宽容本地解析和 Formatter 恢复偶发通道/格式失配，不为 DeepSeek 单独建立另一套无 JSON Mode 的合同路径。

### 8.5 截断与 reasoning-only 分开处理

- `finishReason=length`：可以提高 Formatter 的弹性输出预留，但不重做审核；
- `finishReason=stop + reasoning-only`：判定为输出通道失配，直接走提取/Formatter；
- `finishReason=content_filter`：不进入 Formatter，按安全失败处理；
- 无 finishReason：记录 unknown，仍可尝试本地提取，但不得宣称预算耗尽。

### 8.6 必须持久化的诊断

每次 attempt 至少记录：

```ts
interface StructuredAttemptDiagnostics {
  finishReason: string | null;
  emptyReason: string | null;
  responseChannel: 'content' | 'reasoning' | 'both' | 'empty';
  outputTokens: number | null;
  reasoningTokens: number | null;
  visibleOutputTokens: number | null;
  parseFailureCode: string | null;
  formatterUsed: boolean;
}
```

如果当前表缺列，应通过新 schema migration 增量添加，不在错误文案中拼接不可查询的临时信息代替持久化。

为支持 App 在“原响应已经返回、Formatter 尚未完成”时被杀后的恢复，允许在本地临时持久化原始 `reasoning_content`：

- 仅供同一 checkpoint 的本地提取、Formatter 和冷启动恢复使用；
- 合同恢复成功或节点最终失败后立即清除完整 reasoning 正文；
- 长期只保留长度、hash、token、finishReason、emptyReason、responseChannel 和恢复结果；
- 不写入普通日志、备份导出或用户可分享的质量报告；
- 临时数据的创建、读取和清理必须受 checkpoint CAS 与事务保护。

---

## 9. Review / FactCheck 合同改造

### 9.1 从硬锚点改为语义定位

建议合同：

```ts
interface AuditItemV31 {
  id: string;
  severity: 'required' | 'hard' | 'advisory';
  category:
    | 'opening_continuity'
    | 'outline_execution'
    | 'character'
    | 'world_rule'
    | 'timeline'
    | 'space'
    | 'causality'
    | 'style';
  target: {
    kind: 'opening' | 'scene' | 'middle' | 'ending' | 'global';
    sceneHint?: string;
    evidenceQuote?: string;
  };
  finding: string;
  instruction: string;
  preserve?: string[];
  sourceRefs?: string[];
}
```

规则：

- `id` 是审计项身份，不是段落定位器；
- `evidenceQuote` 是帮助人和 Final 找到场景的短摘录，可选且不参与授权；
- `target.kind` 只表达语义区域；
- required/hard 的 `instruction` 必须自包含、可执行；
- locator 不再是 Review 成败的核心条件；
- 禁止因 locator 无效把整章自动纳入“可任意重写”授权。

### 9.2 宽容 JSON、严格语义

允许本地修复：

- Markdown code fence；
- 顶层对象外的少量说明文字；
- `must_fix` / `mustFix` 等确定性别名；
- 数字、布尔值的安全字符串转换；
- 未识别的额外字段；
- 空的 optional 数组；
- sourceId 的大小写或首尾空白差异。

禁止本地补造：

- required/hard 的 instruction；
- 未知 sourceId 对应的审核意见；
- 大纲结尾状态；
- mustNotAdvance；
- 人物/世界观硬事实；
- Review 没有给出的结论。

### 9.3 Review 审核重点

Review 必须显式覆盖：

1. 上一章结尾到本章开头的时间、地点、动作、人物状态；
2. 当前章大纲必达节拍；
3. 下一章不得提前发生的边界；
4. 人物称谓、身份、知识范围、持有物、伤势；
5. 同一场景内的时间与空间动作；
6. 因果链是否缺步骤或发生倒置；
7. 资料没有支持的解释性新增设定；
8. 风格退化作为 advisory，不与硬事实混淆。

### 9.4 FactCheck 审核重点

FactCheck 只负责可核查事实：

- 人物、世界书、笔记、长记忆中的明确事实；
- 已发生事件与未来大纲的区分；
- 时间、数量、坐标、道具、机关规则；
- 事实冲突的来源引用。

FactCheck 不负责文学润色，也不重复 Review 的风格评价。

FactCheck 返回合法合同但问题列表为空时，节点记为 `success`，UI 显示“核查通过（0 项）”。只有当前模式按设计不执行 FactCheck 时才能记为 `skipped`，禁止用 skipped 混淆“已经核查但无问题”和“未执行”。

---

## 10. Brief Compiler V3.1

### 10.1 职责保持不变但合同收敛

Brief 只负责把已成功的 Review/FactCheck 归一化结果编译为 Final 可执行合同。V3.1 将最终合同拆成“本地不可变信封”和“LLM 语义载荷”：

```ts
interface BriefImmutableEnvelopeV31 {
  schemaVersion: 2;
  sourceHash: string;
  requiredSourceIds: string[];
  protectedFacts: string[];
  hardConstraints: string[];
  mustNotAdvance: string[];
  outlineObligations: string[];
  endingBoundary: string;
}

interface BriefSemanticPayloadV31 {
  coveredRequiredIds: string[];
  openingContinuity: string[];
  mustFix: Array<{
    sourceIds: string[];
    target: 'opening' | 'scene' | 'middle' | 'ending' | 'global';
    instruction: string;
    preserve: string[];
  }>;
  mustPreserve: string[];
  endingState: string;
  styleAdvisories: string[];
}

interface FinalWritingBriefV31
  extends BriefImmutableEnvelopeV31,
    BriefSemanticPayloadV31 {}
```

不可变信封由本地从已验证的 FactCheck、Review 和冻结连续性胶囊确定性构建：

- `protectedFacts` 与 `hardConstraints` 原样继承 FactCheck；
- `mustNotAdvance`、`outlineObligations`、`endingBoundary` 原样继承 Review/冻结大纲边界；
- `requiredSourceIds` 与 `sourceHash` 本地计算；
- 不要求 Brief LLM 复述、改写或搬运这些字段；
- LLM 输出中即使出现同名字段也不作为权威值，本地信封覆盖它们并记录 warning。

这类确定性继承不是“为缺失合同填写默认值”，而是从已通过上游门禁的权威合同复制不可变事实。只有 `mustFix`、`openingContinuity`、`endingState`、风格建议等需要语义压缩的字段由 Brief LLM 生成。

Brief 不得重新审阅 Draft，不得新增剧情，不得解释资料空缺，不得把 advisory 提升为 hard。

只要当前模式包含 Final，就必须调用一次 Brief Compiler。即使 Review/FactCheck 没有发现 required/hard 问题，Brief 仍负责整理 openingContinuity、outlineObligations、mustNotAdvance 与 endingState；不建立“无问题时本地简化 Brief”或“跳过 Brief”的第二条执行语义。

### 10.2 sourceId 归一化

- Brief 输入携带合法 sourceId manifest；
- 完全匹配优先；
- 仅允许大小写、首尾空白、确定性前缀差异的本地修复；
- 无法唯一映射的 sourceId 导致 Brief 失败；
- 所有 required/hard ID 必须 100% 出现在 `coveredRequiredIds` 或有机器可读的 `notApplicable` 依据；
- 不得为通过覆盖率校验而生成空 instruction。

`coveredRequiredIds` 最终由本地根据已验证的 `mustFix[].sourceIds` 计算，LLM 自报值仅用于诊断，不能仅凭它宣称 required/hard 已覆盖。每个 required/hard 必须具有非空可执行 instruction，或具有可验证的 `notApplicable` 原因。

### 10.3 弹性预算

保留既有统一弹性分配原则：

- `requestMaxTokens` 是 provider 允许的弹性天花板，不是目标消耗；
- 可见 JSON 保底与 reasoning headroom 单独核算；
- Brief 关闭 Thinking；low 仅作为结构化预算档位保留；
- mandatory 内容先保留，optional 说明后裁剪；
- 不设置 2K/4K 等容易造成完整合同截断的静态硬上限；
- 实际 token 账单按真实 usage 统计，不以大 ceiling 估算为已消耗。

### 10.4 Brief 失败

Brief 返回格式或字段无效时，按以下顺序恢复：

1. 宽容提取并解析 JSON；
2. 本地附加权威不可变信封；因此仅缺失 `hardConstraints`、`protectedFacts`、`mustNotAdvance`、`outlineObligations` 等搬运字段时无需调用 Formatter，也不得失败；
3. 验证 `mustFix`、instruction、sourceId、endingState 等语义载荷；
4. 载荷仍无法归一化时，允许一次固定 Thinking disabled 的 Contract Formatter。

Contract Formatter 只读取 Brief 原始 content/reasoning、目标语义载荷 Schema、合法 sourceId manifest 和权威不可变字段 manifest，不重新读取 Draft，也不重新执行 Brief 的语义编译。不可变 manifest 只允许逐字复制，禁止改写。

Brief 在本地提取和一次 Contract Formatter 后仍不满足合同：

```text
brief checkpoint = failed
final checkpoint = pending
task = failed
UI = 从 Brief 失败节点重试
```

禁止生成 success-looking fallback。

Review、FactCheck 或 Brief 经 Formatter 恢复为合法合同后，节点记为 `success` 并允许继续执行，同时展示“格式已恢复”标识；详情保留原始失败类型和 Formatter attempt，不能伪装成从未发生恢复。

真机截图中的“Brief 丢失 hardConstraints”在 V3.1 中应走第 2 步直接恢复：FactCheck 合同中的 hardConstraints 被本地原样写入不可变信封，不再消耗第二次 LLM 调用。若上游 FactCheck 自身缺少该必需字段，则失败应发生在 FactCheck，而不是拖到 Brief。

### 10.5 结构化输出兼容边界（DeepSeek 基准、模型无关）

DeepSeek V4 Flash 在真实验收中暴露了“紧凑 JSON”行为：当本章没有 required/hard 修正时，Brief 的若干语义数组可能被省略；Draft 在 Thinking 开启时也可能偶发只返回 `reasoning_content`。DeepSeek 是本方案的能力基准样本，但这类差异属于模型输出通道/合同表达差异，不能做成模型名称白名单，也不能因为模型可用就取消门禁。

因此增加一套对所有已配置 LLM 生效的、按合同而非模型识别的结构化输出兼容层：

- `schemaVersion`、根对象、JSON 可解析性、协议泄漏、sourceId 白名单、required/hard 覆盖、每条 `mustFix` 的非空 instruction、不可变 envelope、`mustNotAdvance` 和 hard facts 仍是硬失败条件；
- 允许语义上为空的 `coveredRequiredIds` / `mustFix` 缺失时归一化为空数组；缺失的 `openingContinuity`、`mustPreserve`、`styleAdvisories` 也只能安全归一化为空数组；
- 当且仅当 `requiredSourceIds` 为空时，未知或不完整的可选 `coveredRequiredIds` / `mustFix` 可以被丢弃并记录 warning；只要存在任何 required/hard 来源，未知 ID 或不完整必需项仍立即失败；
- `endingState` 缺失时只能逐字继承本地不可变 `endingBoundary`，不得由模型或本地推测新剧情；每次归一化都持久化 warning；
- Draft/Final 的 reasoning-only 仍然失败并等待用户重试；Brief 仍最多只允许一次 Contract Formatter；Formatter 失败仍不得使用本地简化 Brief 冒充 API 成功；
- 兼容归一化后的章节仍必须通过 Final 正文门禁、硬事实/防提前检查和文学质量验收，不能以“模型适配”替代发布验收。

这样放宽的是“无语义内容时的字段省略/可选 finding 形态”，不是事实、剧情边界或修订责任；报告必须同时记录 compatibility profile、原始缺失字段和归一化 warning，便于不同模型之间进行同口径复测。

---

## 11. Final Reviser 文学质量建设

### 11.1 Final 不能只看到 Draft + Brief

Brief 是修订合同，不是全部创作事实来源。Final 的 mandatory 输入至少包括：

1. Canonical Draft；
2. Final Writing Brief；
3. 上一章末尾的连续文本窗口；
4. Recent Bridge/上一章结束状态；
5. 当前章大纲正文与本章边界；
6. 下一章最小防提前边界；
7. 与本章命中的人物卡、世界书、笔记硬事实；
8. Story/Episodic Memory 中与当前场景直接相关的状态。

Final 不必重新读取前十章全文，但不能把所有连续性责任都压缩到 Brief。Brief 可能遗漏语气、动作接缝和人物即时状态，上一章原文窗口必须作为不可裁 mandatory。

上一章原文窗口不使用固定 2K/4K 字符硬切，也不默认读取上一章全文。上下文构建器应优先识别并保留上一章最后一个完整场景，在本阶段预算允许时向前动态扩展，同时携带 Recent Bridge，避免从对话、动作或因果链中间截断。

### 11.1.1 冻结连续性胶囊与阶段独立预算

任务创建时构建并冻结一份连续性事实源：上一章接缝、Recent Bridge、当前章大纲、下一章最小防提前边界、命中的人物/世界书/笔记硬事实以及 Story/Episodic Memory 状态。Draft、Review、FactCheck、Brief、Final 引用相同版本，避免运行期间资料变化导致不同阶段判断依据漂移。

“共享冻结事实源”不等于共享一个小型 token 池：

- 五个 Stage 仍是五次独立请求；
- 每个 Stage 按职责选择自己的视图并独立编译；
- 每个 Stage 独立计算 context window、80% soft pool、95% burst band、visible floor 与 reasoning headroom；
- 五次请求的预算不相加，不在阶段间机械切固定百分比；
- Brief 默认读取归一化审计结果和冻结边界摘要，不直接吞入完整长资料；
- Brief 继续保留自己的统一弹性预算。

如果项目本来没有某类资料，胶囊如实记录 `not_provided` 并继续；如果用户已启用且本章命中的 mandatory 大纲、人物、世界书或记忆读取失败，则在发起 Draft 前阻断，不能把系统读取失败伪装成“用户没有提供资料”。

### 11.2 Final 输入优先级

```text
P0 mandatory
  Draft
  Brief required/hard
  上一章结尾接缝
  当前章大纲
  人物/世界观命中硬事实
  mustNotAdvance / endingState

P1 preferred
  Recent Bridge
  相关 Story/Episodic Memory
  本章命中笔记
  风格样本摘要

P2 optional
  更早章节摘要
  低相关资料
  解释性元数据
```

任何预算降级不得先裁 P0。

### 11.3 Final 提示合同

Final 的系统/用户指令必须明确：

- 直接输出完整小说正文，不输出 JSON、修订说明或思考；
- 开头必须从上一章结束状态自然继续，禁止重新开场或重复介绍；
- 保留 Draft 中正确且符合资料的内容，只修 Brief 指定的问题；
- 修改后重新检查同一场景的时间先后、空间距离、人物动作、持有物；
- 不得用资料中不存在的别名、登记、亲属、历史事件解释矛盾；
- 当前章大纲时间点是实际剧情约束，不是可随意提前的氛围提示；
- mustNotAdvance 表示事件不能在本章成为已发生事实，但允许在不泄密的前提下保留已有悬念；
- 收束到 endingState，不额外开下一章场景。

### 11.4 最小交付门禁

Final 运行时硬门禁只检查：

- content 非空；
- 不是 reasoning-only；
- 不是 JSON、分析报告、修订清单或协议泄漏；
- 没有强证据表明输出被截断；
- 正文达到最低可交付形态。

以下项目不得作为简单关键词硬失败：

- mustFix instruction 中出现的普通名词；
- mustNotAdvance 里的主体词本身；
- 某个词在否定句、回忆或悬念中的合理出现；
- 比喻、句长、对话占比等风格指标。

特别修复：`finalBriefComplianceValidator` 不得再从普通 `mustFix.instruction` 提取 forbidden marker。只有显式机器规则才能产生确定性校验，而且语义不明确时只记录 warning。

### 11.5 取消自动第二次 Final

正常 V3.1 Final 最多一次 API 调用。

如果本地最小交付门禁失败：

- checkpoint 标记 failed；
- 保存失败诊断；
- 结果页提供“从失败节点重试”；
- 不在后台自动再生成一整篇终稿。

这样避免一次不可靠的关键词门禁触发第二个高 Thinking、长输出请求，也让用户明确知道发生了什么。

### 11.6 文学质量如何保证

本轮不增加固定的“Final 后高推理审稿 API”。文学质量由三层共同保证：

1. **输入层**：Final 直接获得不可裁剪的上一章接缝、当前章大纲和命中资料；
2. **合同层**：Review/FactCheck/Brief 用 content-only 结构化请求产出完整审计，Brief 100% 覆盖 required/hard；
3. **发布验收层**：对 Draft→Review→Brief→Final 做逐条文学审计，任何硬连续性回归都阻断版本发布。

运行时不欺骗用户，发布时也不以“API 成功率”替代质量判断。

### 11.7 仅重写终稿

Final 已成功但用户主观不满意时，结果页提供“仅重写终稿”入口，并允许用户补充一条修订要求：

- 创建派生任务并引用原任务；
- 复用原任务冻结的 Draft、Review、FactCheck、Brief 和连续性胶囊；
- 原任务、原终稿和完整证据链永久保留；
- 派生任务只执行一次新的 Final，不重跑前置节点；
- 用户补充要求可以调整文风、节奏、描写和局部表达；
- 用户补充要求的优先级低于人物/世界观硬事实、mustNotAdvance、当前章大纲边界和 Brief hard constraints；
- 本地可确定的明显冲突直接提示用户创建新完整流水线，其余在 Final 指令中明确“Brief 硬约束优先”，不增加冲突检查 API；
- 执行前明确提示将产生一次新的 Final API 费用。

---

## 12. 上下文与预算分配

### 12.1 各 API 独立弹性预算

Draft、Review、FactCheck、Brief、Final 是五个独立请求。每个请求按自己的 context window 分配输入与输出，不把五次调用机械切成一个总百分比。

统一公式继续采用：

```text
availableInput = contextWindow - requestMaxTokens - safetyMargin
softPool       = floor(availableInput × 0.80)
burstBand      = floor(availableInput × 0.95)
```

其中 `requestMaxTokens` 允许使用 provider 弹性 ceiling，但编译前仍要验证：

- visible output floor；
- 当前 stage 的 reasoning headroom；
- mandatory input；
- 包装误差安全边界。

### 12.2 不能被裁掉的连续性内容

| Stage     | mandatory                                                                     |
| --------- | ----------------------------------------------------------------------------- |
| Draft     | 当前章大纲、上一章接缝、人物/世界观硬事实、当前状态                           |
| Review    | Draft、上一章接缝、当前章大纲、下一章边界、相关资料                           |
| FactCheck | Draft、可核查事实来源、当前/未来状态区分                                      |
| Brief     | 全部 normalized required/hard、endingState、mustNotAdvance、sourceId manifest |
| Final     | Draft、Brief、上一章接缝、当前章大纲、命中硬事实                              |

### 12.3 超预算策略

1. 删除重复包装与原始 JSON 冗余；
2. 裁低相关 optional 资料；
3. 压缩更早章节摘要；
4. 保留上一章原文尾部与当前章硬约束；
5. 使用 burst band；
6. Draft/Final 的 requested tier 与 mandatory 输入、visible floor 无法同时容纳时，按 `max → high → low` 逐级降低 effective tier，优先保护连续性依据与可见正文空间；
7. 降档写入冻结 execution、request fingerprint、attempt diagnostics，并在结果页明确展示原因；
8. low 仍无法容纳 mandatory 时请求前失败，提示用户调整模型 context window；
9. 不通过关闭 Brief Thinking 或静默丢大纲来“保证能发出请求”。

---

## 13. 效率与稳定性设计

### 13.1 预期减少的浪费

| 当前浪费                       | V3.1 处理             |
| ------------------------------ | --------------------- |
| Review high Thinking           | 固定 low              |
| FactCheck high Thinking        | 固定 low              |
| reasoning-only 后重放长上下文  | 只处理已有 reasoning  |
| Final 关键词门禁后自动再生成   | 取消自动第二次 Final  |
| 失败后整条流水线重跑           | checkpoint 精确续跑   |
| locator 无效导致警告与合同漂移 | 语义位置 + 短证据摘录 |

### 13.2 并发策略

- full 模式 Review 与 FactCheck 保持并行；
- Formatter 只在对应审计响应失效时串接在该分支，不影响另一个成功分支；
- Brief 只在所有必需审计成功后运行；
- 多章批次继续遵守“后一章读取前一章已采用/已确定正文”的章节依赖，不为追求并发破坏章节顺序；
- 并发数开放不等于允许同一 checkpoint 重复执行，仍需 CAS claim。

### 13.3 指纹与幂等

- 每个 stage attempt 绑定冻结 request fingerprint；
- Formatter 使用独立 `requestVersion` 与 fingerprint；
- 同一个 failed checkpoint 人工重试递增 attemptNo，不覆盖历史 attempt；
- success checkpoint 不得因 App 重启重复调用；
- Brief 的 sourceHash 必须绑定 Review/FactCheck normalized 结果；
- Final fingerprint 必须绑定 Draft hash、Brief hash 与 continuity capsule hash。

---

## 14. 观测、错误码与结果页

### 14.1 建议错误码

```text
AUDIT_EMPTY_RESPONSE
AUDIT_REASONING_ONLY
AUDIT_FORMATTER_INVALID
AUDIT_CONTRACT_INCOMPLETE
FACT_CONTRACT_INCOMPLETE
BRIEF_UNKNOWN_SOURCE_ID
BRIEF_REQUIRED_NOT_COVERED
BRIEF_IMMUTABLE_SOURCE_INVALID
BRIEF_CONTRACT_INVALID
FINAL_REASONING_ONLY
FINAL_EMPTY_BODY
FINAL_PROTOCOL_LEAK
FINAL_TRUNCATED
INPUT_CONTEXT_OVERFLOW
```

错误码用于状态机与测试，人类可读中文用于 UI。禁止依赖中文字符串判断恢复路径。

### 14.2 结果页信息

每个 stage card 展示：

- 状态；
- 耗时；
- 输入、可见输出、reasoning token；
- effective Thinking 档位；
- 是否使用 Formatter；
- warning 汇总；
- 失败时的重试入口。

大量相同 locator/格式 warning 应折叠显示，例如“5 条审阅意见已使用语义位置归一化”，避免淹没真正的质量风险。

### 14.3 指标分离

至少分别统计：

- 技术成功率；
- reasoning-only 发生率；
- Formatter 恢复率；
- checkpoint 人工重试成功率；
- 各 stage P50/P95 耗时；
- visible/reasoning token 占比；
- required/hard 落地率；
- 文学质量验收通过率。

不得用技术成功率代替文学质量通过率。

---

## 15. 代码改造范围

### 15.1 推理策略

| 文件                                       | 改造                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `src/services/pipeline/reasoningPolicy.ts` | 新增 `STAGE_REASONING_PROFILE_V3`，Review/FactCheck/Brief effective tier 固定 low 且 Thinking disabled；保留旧 profile 解析 |
| `src/types/pipelineExecution.ts`           | 允许并冻结 `reasoningProfileVersion: 3`                                                                                     |
| `src/services/pipelineTaskContext.ts`      | 新任务写 profile 3；V2 历史解析保留；旧 V3/profile 2 不再进入恢复执行器                                                     |
| `src/services/pipeline/reconcile.ts`       | 使用冻结的阶段档位，Formatter 单独决策                                                                                      |

### 15.2 结构化恢复

| 文件/模块                   | 改造                                                                             |
| --------------------------- | -------------------------------------------------------------------------------- |
| `reconcile.ts`              | 移除 reasoning-only 的完整 Review/FactCheck 重放，接入本地提取与 Audit Formatter |
| `revisionAuditValidator.ts` | 统一 tolerant parse、语义完整性与 failure code                                   |
| `briefResultValidator.ts`   | 对齐相同提取规则，保持 required/sourceId 严格                                    |
| 新增 `auditFormatter.ts`    | 构建只含 reasoning + schema + sourceId 的轻量请求                                |
| attempt repository/schema   | 持久化 finishReason、emptyReason、responseChannel、visible token、formatterUsed  |
| 临时响应仓储                | 临时保存待 Formatter 使用的 reasoning，节点结束即安全清理                        |

### 15.3 状态机与恢复 UI

| 文件                             | 改造                                                         |
| -------------------------------- | ------------------------------------------------------------ |
| `determineNextPipelineAction.ts` | 所有 V3 必需节点 fail-closed；禁止 skipped/failed 穿透       |
| `reconcile.ts`                   | 精确 reset 首个失败节点和未成功下游，复用成功 checkpoint     |
| `PipelineResultScreen.tsx`       | 所有可恢复失败展示“从失败节点重试”及复用说明                 |
| `PipelineTaskScreen.tsx`         | 动态阶段总数，修复 `5/4`                                     |
| settings/UI 文案                 | 同步 V3 full 五阶段与阶段 Thinking 说明                      |
| 派生任务服务                     | “仅重写终稿”复制冻结证据引用、保存用户补充要求并只运行 Final |
| 批次协调器                       | 子章节失败立即暂停，成功重试后按顺序续跑                     |

### 15.4 Final 质量输入与门禁

| 文件                               | 改造                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Final request compiler             | mandatory 注入上一章接缝、当前章大纲和命中硬事实                                                           |
| `finalBriefComplianceValidator.ts` | 删除从 mustFix 正向指令推导禁词的逻辑；不确定语义降为 warning                                              |
| `finalArtifactValidator.ts`        | 只保留交付形态、协议泄漏和明显截断检查                                                                     |
| `reconcile.ts`                     | 取消 Final 自动 repairPass 二次整篇调用；失败交给 checkpoint 重试                                          |
| Brief schema/types                 | 拆分本地不可变信封与 LLM 语义载荷，增加 hardConstraints、outline obligations、protected facts、语义 target |
| Brief immutable envelope compiler  | 从已验证 FactCheck/Review/连续性胶囊原样继承硬约束，禁止 LLM 搬运字段成为成败条件                          |
| continuity capsule builder         | 冻结共享事实源并为五个 Stage 独立编译弹性预算视图                                                          |

### 15.5 QA 工具

| 文件/脚本                                 | 改造                                                         |
| ----------------------------------------- | ------------------------------------------------------------ |
| `scripts/qa/analyze-pipeline-quality.mjs` | 输出逐项 mustFix 落地、边界、时空因果和资料符合性证据        |
| 测试夹具                                  | 新增 20+ 章大纲、人物卡、世界书、笔记、Story Memory 完整项目 |
| 质量报告模板                              | 技术状态与文学结论分栏，不允许仅写“成功”                     |

### 15.6 升级清理 migration

升级步骤必须按以下顺序执行：

1. 创建 schema-recovery/升级前数据库备份；
2. 校验备份可读并记录 hash；
3. 开启单一数据库事务；
4. 精确识别并删除全部旧 V3/profile 2 task、checkpoint、stage attempt 与阶段结果；
5. 保留 V2 历史任务、已采纳章节正文、内容修订历史和 `llm_usage_logs`；
6. 清理与旧 V3 task 关联且不再被其他实体引用的临时 reasoning；
7. 提交后执行引用完整性与计数审计；
8. 任一步失败则回滚事务并停止升级，不允许半清理状态启动新执行器。

备份仅用于灾难恢复，不在产品 UI 提供旧 V3 任务恢复入口。

---

## 16. 测试建设

### 16.1 单元测试

必须覆盖：

1. 三个用户档位下 Review/FactCheck/Brief 的 effective tier 仍为 low 且 Thinking 始终 disabled；
2. Draft/Final 正确使用 low/high/max；
3. reasoning-only 可从 reasoning 本地提取合同；
4. 本地提取失败时 Formatter 输入不含 Draft/大纲/资料；
5. Formatter 最多调用一次；
6. content 与 reasoning 都空时 stage failed；
7. tolerant JSON 可修 code fence、别名、额外字段；
8. required instruction 缺失不得本地补造；
9. unknown sourceId 不得静默丢弃；
10. Review/FactCheck/Brief 失败不执行 Final；
11. Final validator 不把“补充坐标”中的“坐标”当禁词；
12. Final 最小交付失败不自动发起第二次 Final；
13. full 模式动态显示 5 个阶段；
14. V2 历史任务行为不变；旧 V3/profile 2 被升级清理且不可恢复；
15. 所有 Formatter 固定 Thinking disabled，正式结构化节点仍发送 `response_format=json_object`；
16. Formatter 恢复后状态为 success 且带 `formatRecovered=true`；
17. FactCheck 合法空问题列表记为 success 而不是 skipped；
18. Draft/Final reasoning-only 不触发隐藏的完整重算；
19. 五个 Stage 引用同一冻结事实源但分别拥有独立弹性预算；
20. mandatory 资料读取失败在请求前阻断，`not_provided` 不误判为失败；
21. FactCheck hardConstraints 非空而 Brief LLM 完全省略对应字段时，本地不可变信封仍逐字保留并成功；
22. Brief LLM 改写或伪造 hardConstraints 时，权威本地值覆盖模型值并留下 warning；
23. 上游 FactCheck 合同缺失 hardConstraints 字段时在 FactCheck 阶段失败，不进入 Brief；
24. `mustFix.instruction` 等真正语义载荷缺失时不能靠不可变信封伪装成功，必须 Formatter 或失败。

### 16.2 状态机集成测试

| 场景                               | 期望                                                  |
| ---------------------------------- | ----------------------------------------------------- |
| Review failed、FactCheck succeeded | task failed；重试只跑 Review，然后 Brief/Final        |
| FactCheck failed、Review succeeded | task failed；重试只跑 FactCheck，然后 Brief/Final     |
| 两者同时 failed                    | 一个操作同时重置两分支并行重试；两者均成功后 join     |
| Brief invalid                      | Final attempt 数为 0                                  |
| Final reasoning-only               | Final failed，Draft/Review/FactCheck/Brief 均保留成功 |
| App 在 Brief 前被杀                | 冷启动从冻结 Brief 恢复，不重跑审计                   |
| 用户修改章节后点击失败重试         | 默认按冻结输入重试；可选新建任务按当前内容重启        |
| 旧 V2 proof 失败                   | 继续旧冻结降级/恢复语义，不被 V3.1 改写               |
| 两次以上人工重试                   | 不设硬上限；attemptNo 递增且每次费用确认              |
| 批量第 N 章失败                    | 批次暂停；N+1 不执行；N 成功后顺序续跑                |
| Final 成功后补充修订               | 创建派生任务；旧结果保留；仅调用新 Final              |
| 补充要求覆盖 hard boundary         | 本地明确冲突时阻断并要求新建完整任务                  |
| 原响应后、Formatter 前杀进程       | 从临时 reasoning 恢复；节点结束后原文清理             |
| 升级遇到旧 V3/profile 2            | 备份后事务清理；V2、已采纳正文、usage logs 保留       |

### 16.3 故障注入

至少模拟：

- HTTP 429/500/超时；
- outcome unknown；
- content 空、reasoning 非空；
- content 与 reasoning 都空；
- finishReason length；
- 截断 JSON；
- fenced JSON；
- 字段别名；
- unknown sourceId；
- Brief required 覆盖不足；
- Final 返回 JSON/分析说明；
- Final 返回半句截断正文；
- 进程在 checkpoint CAS 后、API 前后、持久化前后被杀。

---

## 17. 文学质量验收

### 17.1 验收数据集

新验收项目必须真实包含：

- 至少 24 章大纲；
- 至少 3 个主要人物卡，含别名、称谓、知识范围和关系；
- 至少 5 条世界书硬规则；
- 项目笔记与启用状态；
- 非空 Story Memory 与 Episodic Memory；
- 第 20 章以后仍可验证的跨章伏笔、持有物与时间线；
- 至少一个多章批量任务，后一章依赖前一章终稿状态。

若上述输入为空，报告必须写“该维度未测试”，不得判定资料符合性通过。

每次发版至少完成 6 章 DeepSeek V4 Flash 真实文学验收：

- 3 个分散单章，分别覆盖故事早期、中段和第 20 章以后；
- 3 个连续批量章节，用于验证章节状态顺序继承；
- 其他 Provider 只要求结构兼容、失败恢复和请求参数测试，本轮不要求同等规模文学样本。

### 17.2 每章硬质量门禁（发布验收，不是运行时关键词门禁）

每个样本的硬质量项必须满足：

- 上一章结尾到本章前 2 ～ 4 段无关键时间、地点、动作断裂；
- 当前章 required outline beats 落地率 100%；
- Review/FactCheck required/hard 项落地率 100%，或有可复核的 `notApplicable` 理由；
- mustNotAdvance 关键事件提前发生数为 0；
- 新增人物身份、世界观、时间、空间、持有物硬矛盾数为 0；
- 未经资料支持的关键解释性设定数为 0；
- 协议、JSON、思考过程泄漏数为 0；
- 批量后一章正确读取前一章确定正文状态。

人物身份、时间顺序、持有物、世界观硬事实、大纲必达项、剧情越界和未经资料支持的关键解释均为硬问题，零容忍。任何一项硬失败，该章节文学验收不通过。

每章最多允许 1 个不影响剧情事实与主线的轻微连续性问题，例如动作过渡略生硬、短暂指代不清或场景衔接少一句说明。出现第 2 个轻微问题即不通过；任何硬问题不得占用轻微额度。

### 17.3 风格质量评分

在硬门禁之外，对以下维度进行 1 ～ 5 分人工可读评分：

- 开头衔接自然度；
- 叙事清晰度；
- 场景动作可信度；
- 人物语言与行为一致性；
- 行文节奏与重复控制；
- 资料符合性与融入自然度，是否出现说明性堆砌。

发布标准按单章判定：“开头衔接自然度”和“资料符合性”不得低于 4/5；叙事清晰度、场景动作可信度、人物语言与行为一致性、行文节奏与重复控制不得低于 3/5。不得用六项平均分掩盖关键单项不达标。比喻词频、段落长度、对话占比仅作为开发/验收辅助证据，不展示在普通用户结果页，也不直接替代评分。

### 17.4 三个已发现问题必须成为固定回归样本

1. **齿轮时序**：物件被拾取后不得再次写成“仍在水中未拾取”；
2. **档案室空间动作**：人物未靠近时不能无过渡完成近距离夺取；
3. **午夜与身份边界**：不得把午夜行动提前到 23:37，不得泄露第三钥匙位置/持有人，不得用无资料依据的登记改名解释人物称谓。

验收报告必须引用 Draft、Review、Brief、Final 的短摘录和对应判断，不能只写“3/3 已修复”。

### 17.5 独立复核与失败重测

质量脚本只负责生成 mustFix 落地、资料引用、时空状态和差异证据表，不能自动宣布文学质量通过。最终判定必须由未参与本轮实现的人独立复核正文，并在报告中引用 Draft、Brief、Final 的短摘录和判断依据。

6 章中任一章节出现硬问题、超过 1 个轻微问题或任一评分未达线，立即阻断发版。完成提示、合同、上下文或执行器修复后，必须重新运行和复核全部 6 章，不能只重测失败章节，因为核心改动可能改变所有样本输出。

### 17.6 质量证据链

每个样本保存：

```text
冻结输入摘要
上一章结尾原文窗口
当前章大纲与资料命中
Draft
Normalized Review / FactCheck
Brief
Final
逐条必改项落地表
新增矛盾检查表
人工可读文学结论
```

技术报告与文学报告分开给结论：

```text
技术执行：通过 / 不通过
恢复能力：通过 / 不通过
文学质量：通过（无轻微问题）/ 通过（1 个轻微问题）/ 不通过
资料符合性：通过 / 不通过 / 未测试
```

---

## 18. 发版门禁

### 18.1 代码门禁

```text
npm run lint
npm run typecheck
npm run test:ci
npm run verify
```

新增测试必须验证真实请求消息、冻结档位、checkpoint 行为和 attempt 次数，不能只断言函数被调用。

### 18.2 真机门禁

至少完成：

1. 覆盖安装前数据库备份可读、hash 可核对；
2. V2 历史任务保留并可恢复；旧 V3/profile 2 任务与流水线结果被事务清理；
3. 已采纳章节正文、内容修订历史和 `llm_usage_logs` 保留；
4. V3.1 low/high/max 三档请求抓取；
5. Review/FactCheck/Brief effective tier 固定 low、正式请求与 Formatter 均 disabled 的请求体证据；
6. reasoning-only 本地提取成功；
7. reasoning-only Formatter 成功与失败各一次；
8. FactCheck 输出非空 hardConstraints、Brief LLM 省略/改写搬运字段时，本地不可变信封仍逐字保留且 Brief 成功；
9. Review、FactCheck、Brief、Final 各自失败页面和任务中心的重试按钮；
10. full 模式单边/双边审核失败后的 checkpoint 复用；
11. Brief 弹性预算与五阶段独立实际 token 分账；
12. Final 正常路径只有一次 API attempt；
13. “仅重写终稿”派生任务只调用 Final 且旧终稿保留；
14. 3 个早期/中段/20 章以后分散单章；
15. 3 个连续批量章节，失败时后续暂停；
16. 杀进程、冷启动、网络切换及 Formatter 临时 reasoning 恢复；
17. 全部 6 章 DeepSeek V4 Flash 独立文学复核与完整证据链。

### 18.3 发布阻断条件

出现以下任一情况不得宣告验收完成：

- V3 必需节点失败后仍进入 Final；
- 失败页缺少“从失败节点重试”；
- 重试重复调用已经成功的 checkpoint；
- Review/FactCheck 在新 profile 中仍发送 high/max；
- reasoning-only 恢复重新携带完整 Draft/资料；
- Brief 静态小上限导致合同截断；
- Brief 无效却使用 fallback 进入 Final；
- Brief 因 LLM 没有复述 hardConstraints/protectedFacts/mustNotAdvance 等不可变字段而失败；
- Final Writing Brief 中的本地 hardConstraints 与已验证 FactCheck 不逐字一致；
- Final 正常路径出现自动第二次整篇生成；
- Final validator 仍从正向必改指令推导禁词；
- full 模式仍显示 `5/4`；
- 文学测试资料为空却宣称“符合资料”；
- 任一样本存在新增关键前后文、时空、人物或剧情边界矛盾；
- 任一章节超过 1 个轻微连续性问题或单项文学评分未达线；
- 质量结论不是由未参与实现的人独立复核；
- 旧 V3 清理没有升级前备份、事务回滚或错误删除已采纳正文/usage logs；
- 批量失败后仍继续生成后续章节；
- 验收报告只以 suite 数、成功状态、token 或耗时证明文学质量。

---

## 19. 实施顺序

本轮不做 A/B，直接建设新 profile，但按依赖顺序合入和验收。

### Phase 0：升级数据边界

1. 新增升级前灾难恢复备份；
2. 建设旧 V3/profile 2 精确识别与事务清理；
3. 证明 V2、已采纳章节、修订历史和 usage logs 不受影响；
4. 清理失败时 fail-closed，禁止启动半迁移数据库。

### Phase 1：状态机与失败 UI

1. 统一 V3 必需节点 fail-closed；
2. 修复从失败 checkpoint 精确重试；
3. 结果页与任务中心统一重试入口、费用确认和不限次人工 attempt；
4. 批次失败暂停与成功后顺序续跑；
5. 动态阶段计数；
6. 补齐错误码和 UI 文案。

### Phase 2：推理档位与 reasoning-only

1. 引入 reasoning profile 3；
2. Review/FactCheck/Brief effective tier 固定 low 且 Thinking disabled；
3. 建设本地双通道提取；
4. 建设固定 Thinking disabled 的轻量 Audit/Contract Formatter；
5. 建设 reasoning 临时持久化与节点结束清理；
6. 持久化 finishReason 与 response channel 诊断。

### Phase 3：合同与 Brief

1. Review 去硬锚点；
2. 统一 tolerant JSON；
3. Brief schema v2 拆分本地不可变信封与 LLM 语义载荷；
4. hardConstraints/protectedFacts/mustNotAdvance 等权威字段本地确定性继承；
5. sourceId manifest 与 required 100% 有效 instruction 覆盖；
6. 保留 Brief 独立弹性预算。

### Phase 4：Final 质量输入与最小门禁

1. Final 注入连续性 mandatory capsule；
2. 修复 forbidden marker 误判；
3. 移除自动第二次 Final；
4. 增加 Draft/Brief/资料 hash 指纹；
5. 建设“仅重写终稿”派生任务与受约束用户补充要求。

### Phase 5：测试、真机与文学验收

1. 单元/状态机/故障注入；
2. 资料齐全的 24 章测试项目；
3. DeepSeek V4 Flash 的 3 个分散单章与 3 个连续批量章节；
4. 三个既有文学问题回归；
5. 未参与实现者独立复核；任一失败修复后全部 6 章重跑；
6. 独立复核完成后才能更新验收结论。

---

## 20. 回滚与兼容

- 新任务通过 `reasoningProfileVersion=3` 与新 Brief schema 识别；
- V2 历史任务继续按旧路径运行；
- 旧 V3/profile 2 任务在升级备份后事务清理，不能恢复到新执行器；
- 已采纳章节正文、内容修订历史和独立 usage logs 不随旧 V3 清理；
- V3.1 紧急回滚只停止创建新 profile 3 任务，不尝试恢复已清理的旧 V3 执行链；
- 已创建的 profile 3 任务仍按冻结语义完成或从失败节点恢复，除非紧急版本明确将其安全终止；
- 新字段使用增量 migration，旧值允许 null；
- 升级前备份仅用于数据库灾难恢复，不在普通 UI 暴露旧任务恢复能力。

---

## 21. 已确认的产品决策

- 所有 V3 必需节点 fail-closed；
- 结果页和任务中心都能从失败 checkpoint 重试，人工次数不限但每次确认费用；
- Review/FactCheck/Brief 固定 low budget 但 Thinking disabled，Draft/Final 按用户档位；
- Audit/Contract Formatter 只在本地解析失败后调用一次并固定关闭 Thinking；
- Review 使用语义位置与短摘录，不依赖硬锚点；
- 正式结构化调用继续使用 `response_format=json_object`；
- Brief 每条含 Final 的路径都调用，并保留独立弹性预算；
- hardConstraints 等不可变字段由本地权威合同继承，不要求 LLM 搬运；
- Final 使用最小交付门禁，正常路径只调用一次；
- 用户可通过派生任务补充受硬约束限制的要求并仅重写 Final；
- 风格统计只进入开发/验收报告，不在普通结果页展示；
- 文学验收每章允许最多 1 个纯表达类轻微问题，硬事实和剧情边界零容忍；
- 每版至少 6 章 DeepSeek V4 Flash 真实输出，由未参与实现者独立复核；任一失败后全部 6 章重跑；
- 旧 V3 任务和流水线结果升级时清理，但已采纳正文、修订历史和 usage logs 保留；
- 多章批次遇到失败立即暂停，修复后顺序续跑。

---

## 22. 完成定义

只有同时满足以下条件，本轮才可判定完成：

```text
V3 fail-closed 状态机成立
+ 所有失败节点可精确续跑
+ Review/FactCheck/Brief fixed low budget + Thinking disabled
+ reasoning-only 不重做完整审核
+ Brief 弹性预算保持有效
+ Brief 不可变硬约束由本地逐字继承
+ Final 正常路径单次调用
+ Final 获得连续性与资料 mandatory 输入
+ 旧 V3 安全清理且用户正式正文/usage logs 无损
+ 技术门禁全部通过
+ 资料齐全的 6 章 DeepSeek V4 Flash 真机验收通过
+ 三个已知文学回归样本通过独立复核
= V3.1 可发布
```

任何单项缺失，都只能写“部分完成”，不能宣告 V3.1 已验收。
