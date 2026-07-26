# ShineWriter 构建模块：质量下限、丰满角色卡与 TXT 素材构建 SPEC

| 字段 | 值 |
|---|---|
| 文档日期 | 2026-07-26 |
| 文档状态 | 待实施 |
| 当前基线 | V2.6.4 / 数据库 Schema 18 |
| 目标版本 | 下一功能版本（实施时确定） |
| 数据库 Schema | 保持 18，不新增迁移 |
| 优先级 | P1：构建产物质量与写作可用性 |
| 主要影响范围 | 构建预算、角色/世界书提示词与校验、TXT 来源解析、构建页、测试 |
| 前置功能 | V2.5.22 构建模块；V2.6.3 世界书默认常驻；V2.6.4 构建产物直入资料库 |

---

## 0. 文档用途

本文是对「构建」模块的增量规格，解决三项问题：

1. 当前仅限制单次请求的最大输出 Token，已有的最低预留门槛（角色 512、世界书 256/条）过低，且不校验模型实际返回的规模，因此可得到格式正确但内容过短的产物；
2. 角色卡的提示词只要求基本字段，缺少人物小传、关系、动机、限制和戏剧张力等多维约束；
3. 构建页只能把 JSON/PNG 作为反向构建来源，不能把 TXT 素材解析为一次性来源并生成角色卡或世界书。

本规格在保持 `chara_card_v3` / `lorebook_v3` 兼容、保留当前在线 LLM 调度与取消机制的前提下，引入“内容丰满度”及其可验证下限，并增加“由 TXT 构建”流程。

参考 `anjingdtl/tavo-maker` 的提示词丰富化设计：角色 `description` 目标 1200 字以上，世界书单条 `content` 目标 800 字以上，并覆盖人物外貌、经历、心理，以及世界设定的历史、场景和量化信息。该参考是本规格的“深度”档质量基线，而不是对所有模型、所有档位一律强制的固定长度：

- [参考设计](https://github.com/anjingdtl/tavo-maker/blob/master/docs/superpowers/specs/2026-05-28-prompt-enrichment-design.md)
- [参考实施计划](https://github.com/anjingdtl/tavo-maker/blob/master/docs/superpowers/plans/2026-05-28-prompt-enrichment.md)

---

## 1. 关键兼容性不变量

### 1.1 世界书必须常驻（不可回退）

这是本轮的最高优先级兼容性约束。既有项目已验证：世界书若不设为常驻，写作上下文不能稳定生效。

因此，**由构建模块生成的每一条世界书必须为 `constant: true`**。该约束必须在以下四层同时成立：

```text
世界书系统提示词要求 constant=true
  → 解析器无条件写入 constant: true
  → lorebook_v3 回读校验确认每条均为 true
  → 直接导入资料库后仍以常驻条目参与写作上下文
```

明确禁止：

1. 不得为了控制长内容上下文而把构建产物改为“按关键词触发”；
2. 不得把模型返回的 `constant: false` 原样写入构建产物；
3. 不得提供会使构建世界书变为非常驻的 UI 开关；
4. 不得删除现有 `parseWorldbookResponse()` 中强制 `constant: true` 的防线；
5. 不得因 TXT 来源、丰满度档位或导入方式改变常驻语义。

需要控制写作上下文占用时，只能通过减少条目数、降低丰满度档位、调整项目资料预算或拆分世界书合集处理；不能破坏常驻链路。

### 1.2 其余不变量

1. 继续只支持当前激活的在线 OpenAI 兼容模型；本轮不接入本地 llama.cpp 构建。
2. 继续复用 `callLLMResult` 的网络策略、排队、取消、超时、用量日志与 JSON 模式兼容行为。
3. 生成失败、取消、截断、低于质量下限或回读失败时，绝不保存文件、绝不写入资料库。
4. 角色产物继续使用 `chara_card_v3`；世界书继续使用 `lorebook_v3`；既有 JSON/PNG 来源模式保持可用。
5. TXT 仅作为一次性构建来源：不保存原路径、不写入 SQLite、不进入备份；缓存副本必须清理。
6. 不增加数据库表、列、迁移、原生模块、Android 权限或 npm 依赖。

---

## 2. 现状与根因

### 2.1 已有保护并非不存在，但不足以保证质量

`src/services/construction/budget.ts` 已有：

- 角色卡 `CHARACTER_MIN_OUTPUT = 512`；
- 世界书 `WORLDBOOK_MIN_OUTPUT_PER_ENTRY = 256`；
- 输出预留滑块、模型 `max_output_tokens`、上下文安全余量和来源预算校验；
- `finishReason === 'length'` 时拒绝截断结果。

这些保护只说明“请求有最低可用输出空间”，并不说明：

```text
模型实际返回了足够 Token
模型每个字段/条目达到了预期篇幅
角色的关键维度确实得到覆盖
```

现有角色提示词只定义字段名，世界书提示词只要求“客观设定正文”，因此模型在预算紧张或偏简洁时可返回合法、可导入但过于单薄的 JSON。

### 2.2 设计原则

本轮将“规模控制”拆成两个不同的、不可互相替代的约束：

| 层级 | 目的 | 实现方式 |
|---|---|---|
| 请求容量下限 | 确保模型至少有空间完成所选规模 | 预算模块要求 `outputReserve >= requiredMinOutput` |
| 实际产物下限 | 防止模型提前结束并返回短 JSON | 使用服务商 output usage 或本地 Token 估算 + 字段/条目长度校验 |

`max_tokens` 只能限制上限，不能保证模型一定写到下限。因此两层都必须实施。

---

## 3. 内容丰满度与 Token 预算

### 3.1 新类型

新增 `ConstructionDetailLevel`：

```ts
export type ConstructionDetailLevel = 'compact' | 'full' | 'deep';
```

用户可见名称为“紧凑”“丰满”“深度”。默认值为 `full`。

### 3.2 档位契约

| 档位 | 角色实际最小输出 | 世界书单条实际最小输出 | 角色 `description` 最小中文有效字符 | 世界书单条 `content` 最小中文有效字符 | 默认世界书条目数 |
|---|---:|---:|---:|---:|---:|
| 紧凑 | 1,600 | 400 | 600 | 300 | 6 |
| 丰满（默认） | 2,800 | 650 | 1,000 | 550 | 4 |
| 深度 | 3,600 | 900 | 1,200 | 800 | 4 |

世界书总最低输出 Token：

```text
requiredMinOutput = 200 + entryCount × worldbookMinOutputPerEntry
```

其中 200 Token 为合集名称、键词、说明、JSON 结构与安全冗余。角色的 `requiredMinOutput` 就是表中“角色实际最小输出”。

数字以项目现有 `estimateTokens()` 的估算口径定义；对中文字符，该估算器按每字约一个 Token 计。实际服务商返回 `completion_tokens` 时，以该值优先。

### 3.3 预算公式与 UI 行为

保留既有公式：

```text
C = context_window
M = max_output_tokens
S = 安全余量
requestedOutput = round(C × reservePercent)
outputReserve = min(requestedOutput, M, C − S)
sourceBudget = C − outputReserve − S
```

新增必须成立的条件：

```text
requiredMinOutput(detailLevel, target, entryCount) ≤ outputReserve
```

不成立时：

1. 禁用“生成”；
2. 显示所选档位/条目数所需的最低 Token；
3. 给出最小输出预留百分比；
4. 若受 `M` 限制，即使调高滑块也无效，明确引导用户减少条目数、选择较低档位或使用更高输出上限的模型。

切换目标、丰满度或世界书条目数时，页面将输出预留滑块自动提高到“当前配置最小可生成值”与现有值中的较大者；不会自动降低用户已经选定的预留。若最大 15% 仍不可满足，不改变滑块而显示阻断原因。

### 3.4 实际响应下限

`generateConstruction()` 在以下步骤后执行质量校验：

```text
LLM 返回
→ 取消/length/空文本检查
→ JSON 解析与结构校验
→ 封装为 chara_card_v3 或 lorebook_v3
→ Token 下限与内容质量校验
→ 既有 fileImport 回读校验
→ 返回预览产物 + qualityReport
```

质量下限衡量的是**最终可保存、会进入资料库的可见 JSON 内容**，而不是服务商账单用量。部分推理模型会把隐藏 reasoning 计入 `completion_tokens`；若用该值直接放行，短正文可能被隐藏推理 Token 虚高而错误通过。

因此实际产物 Token 一律按 `estimateTokens(result.text)` 计算；结构化字段长度则按最终归一化后的 `chara_card_v3` / `lorebook_v3` 内容计算。`result.outputTokens` 与 `result.rawUsage?.completion_tokens` 仅用于质量报告中的“服务商用量（如提供）”和用量日志，不参与通过/拒绝判定。

任何一个可见内容校验表明产物低于当前 `requiredMinOutput`，都视为“生成规模不足”。不接受该产物。

错误必须包含可操作信息，例如：

```text
生成内容低于“丰满”档下限：实际约 1,920 / 至少 2,800 Token。
请使用“按原设定补全”、提高输出预留，或切换为紧凑档。
```

不自动发起隐藏的第二次模型调用。预览区改为失败信息卡，提供：

- “按原设定重试”；
- “返回调整规模”。

“按原设定补全”可作为后续独立迭代；若实施，必须在点击前明确说明会再发起一次在线请求和预计最大输出，不得静默消耗额度。

---

## 4. 角色卡质量契约

### 4.1 输出格式保持不变

仍只接受下列字段并封装为 `chara_card_v3.data`：

```text
name
description
personality
scenario
first_mes
mes_example
system_prompt
post_history_instructions
tags
alternate_greetings
```

不得为了丰富人物而引入只有构建模块认识、资料库和编辑器无法使用的私有必填字段。丰富信息应写入上述标准字段，必要的自定义字段只能是可忽略的兼容扩展，不能作为质量通过条件。

### 4.2 提示词覆盖矩阵

角色系统提示词须将以下维度明确映射到输出字段：

| 维度 | 必须表达的内容 | 主要落点 |
|---|---|---|
| 身份与叙事功能 | 身份、职业/阵营、社会位置、故事作用 | `description`、`tags` |
| 外在呈现与习惯 | 与题材相称的外貌、衣着、动作、感官细节 | `description` |
| 经历与关系 | 出身、关键转折、重要关系、社会网络 | `description`、`scenario` |
| 内在驱动 | 欲望、目标、恐惧、秘密、道德底线 | `personality`、`description` |
| 矛盾与限制 | 性格反差、能力边界、代价、易触发情绪 | `personality`、`system_prompt` |
| 当前戏剧张力 | 当前处境、人物和用户可互动的冲突 | `scenario`、`first_mes` |
| 可演绎声音 | 用词、句式、回避/主动方式、关系变化 | `mes_example`、`system_prompt` |

用户明确给出的事实优先级最高。模型只能在不冲突的空白处做合理创作；不得把推断写成用户已确认的事实，不得无故加入敏感身份、伤害经历或成人内容。

### 4.3 字段级最低要求

所有档位都要求标准字段非空。`full` / `deep` 额外要求：

| 字段 | 丰满 | 深度 |
|---|---:|---:|
| `description` | ≥ 1,000 中文有效字符 | ≥ 1,200 |
| `personality` | ≥ 250 | ≥ 320 |
| `scenario` | ≥ 200 | ≥ 260 |
| `first_mes` | ≥ 120 | ≥ 160 |
| `mes_example` | ≥ 320，至少 3 轮角色互动 | ≥ 420，至少 4 轮 |
| `system_prompt` | ≥ 120 | ≥ 160 |
| `post_history_instructions` | ≥ 60 | ≥ 80 |
| `tags` | 至少 3 个不重复标签 | 至少 4 个不重复标签 |

“中文有效字符”指去除空白、JSON 结构符号与纯 Markdown 标题后的可见内容长度。`{{char}}` 和 `{{user}}` 视为可见宏，不因长度计算被重复放大。

`mes_example` 必须含 `{{char}}` 和 `{{user}}`；对话轮数以两者的有效发言行计算。仅有长独白、不含真实交替对话，不得通过。

### 4.4 质量报告

新增 `ConstructionQualityReport`，至少包含：

```ts
interface ConstructionQualityReport {
  detailLevel: ConstructionDetailLevel;
  /** 最终可保存可见 JSON 的本地估算，不含模型 reasoning。 */
  actualOutputTokens: number;
  /** 服务商声明的用量；仅展示，不能作为质量通过条件。 */
  providerOutputTokens?: number;
  requiredMinOutput: number;
  passed: boolean;
  failures: Array<{ code: string; message: string }>;
  character?: {
    fieldLengths: Record<string, number>;
    dialogueTurns: number;
    dimensionCoverage: string[];
  };
  worldbook?: {
    entryLengths: number[];
    totalEstimatedPersistentTokens: number;
  };
}
```

维度覆盖只用于解释和提示，不应采用脆弱的关键词匹配把优质角色误判失败。硬性拒绝条件只包括：Token 下限、字段非空、长度、对话轮数、标签数量、世界书条目数/关键词/常驻性和回读兼容性。

---

## 5. 世界书质量契约

### 5.1 条目结构与常驻性

保持当前输出结构：

```json
{
  "name": "世界书名称",
  "entries": [
    {
      "keys": ["主触发词", "别称"],
      "secondary_keys": ["关联词"],
      "content": "客观设定正文",
      "comment": "条目说明",
      "constant": true
    }
  ]
}
```

每条必须：

1. `constant` 明确为 `true`；
2. 有至少一个非空主触发词，并保留别称；
3. 有非空、可复用、客观陈述的 `content`；
4. 有便于资料库识别的 `comment`；
5. 与同一合集的其他条目不重复主触发词，不机械重复正文。

解析器继续忽略模型对 `constant` 的不兼容输出并强制把最终 `LorebookEntry.constant` 设为 `true`。

### 5.2 内容结构

提示词要求每条围绕一个紧密知识主题写作，并按适用情况覆盖：

```text
核心定义 / 当前规则
→ 起源、历史演变或关键转折
→ 典型场景、行为后果或可用于章节的实例
→ 规模、时间、资源、等级或其他可验证的相对/量化信息
→ 与势力、地点、人物、冲突或其他设定的连接
```

不是所有幻想/历史题材都应伪造精确数值。没有可信数字时，模型可使用明确的相对范围、制度等级或可观察后果；不得为满足“量化”要求编造看似权威的具体统计。

### 5.3 逐条硬校验

按当前丰满度档位检查每条 `content` 的中文有效字符数量；不足即拒绝整份产物，而不是只删除短条目后减少条目数。

最终校验顺序：

```text
精确条目数
→ 不重复主触发词
→ 每条 keys/content/comment
→ 每条 content 长度
→ 每条 constant === true
→ 合集总输出 Token 下限
→ lorebook_v3 回读
```

### 5.4 常驻上下文提示

世界书全部常驻是写作可靠性的必要条件，但深度内容会提高资源上下文占用。预览页显示：

```text
常驻世界书：4 条
估算常驻内容：3,200 Token
当前仅为构建提示；实际写作是否能完整带入仍受项目资料预算控制。
```

该提示不得阻止生成、保存或导入，也不得建议关闭常驻。若预计常驻 Token 较高，只提示用户减少条目数、选择较低档位或在设置中评估资料预算。

---

## 6. 由 TXT 构建

### 6.1 模式与用户流程

构建模式扩展为：

```text
独立构建 ｜ 由世界书 ｜ 由角色卡 ｜ 由 TXT
```

进入“由 TXT”后，显示“目标类型：角色卡 / 世界书”，并保留丰满度、补充需求和世界书条目数量控制。

流程：

```text
选择 TXT
→ 本地解码和分段
→ 查看/选择要使用的片段
→ 预算校验
→ 在线 LLM 结构化生成
→ 质量/常驻/回读校验
→ 预览
→ 保存到手机或导入当前项目资料库
```

TXT 是“原始素材”，不是已知的角色卡或世界书格式。因此本功能是“先本地解析、再由 LLM 结构化生成”，不是不调用模型的直接导入。

### 6.2 文件与编码支持

新增 `pickTextSourceFile()`，仅接受 `.txt` 或 `text/plain`。选择器仍使用 Android Storage Access Framework，并通过 `keepLocalCopy(..., 'cachesDirectory')` 取得临时本地副本。

支持：

- UTF-8（含/不含 BOM）；
- UTF-16 LE（BOM）；
- UTF-16 BE（BOM）。

无 BOM 且不能作为有效 UTF-8 解码的文本，应提示“暂不支持该 TXT 编码，请另存为 UTF-8 后重试”，不得以乱码送入模型。

本轮不支持 DOC/DOCX、PDF、Markdown 专用解析、OCR 或压缩包；这些格式不应伪装成 TXT 成功导入。

### 6.3 本地解析与片段选择

新增纯函数 `parseConstructionTextSource(text, fileName)`：

1. 清理 BOM、统一换行；
2. 从首个有效标题、`#` 标题、`第…章/节/回` 标题及空行段落识别段落；
3. 生成稳定顺序的 `TextSourceSection[]`；
4. 保留原文，不调用 LLM，不改写文本；
5. 为每段给出字符数和 `estimateTokens`。

页面默认选中全部片段。若完整来源超出 `sourceBudget`：

- 禁用生成；
- 显示超出的 Token 数；
- 允许用户取消勾选片段，直到所选内容满足预算；
- 不进行静默截断、自动摘要或任意尾部裁剪。

没有识别到标题时，把连续非空段落按安全长度切成可选择片段；切分必须在换行/句末优先，不能破坏 Unicode 字符。

### 6.4 TXT 提示词约束

TXT 目标为角色时，用户提示词要求：

```text
仅把素材中明确出现的事实视为既定设定；
可在不冲突处做创作性补全；
若素材存在矛盾，以用户补充需求为最高优先级，并在角色内部保持自洽；
不要把原文叙述逐段复制到角色卡。
```

TXT 目标为世界书时，要求将人物经历、场景描写、制度/地点/关系等拆解成独立常驻条目；至少一条必须覆盖素材中的关键关系、组织、地点或主冲突，且每条最终仍为 `constant: true`。

### 6.5 隐私与清理

TXT 内容会作为在线生成输入发送至用户已配置的服务商。选择 TXT 前及来源摘要区域显示现有隐私基线一致的说明：

```text
仅在点击“生成”后，当前勾选的 TXT 内容和补充需求会发送给你配置的在线模型服务。
文件不会写入资料库、备份或长期缓存。
```

临时副本必须在成功、解析失败、取消、来源更换和组件卸载后异步删除。删除失败只记录诊断，不应把构建结果判为失败。

---

## 7. UI 规格

### 7.1 构建表单

在现有表单中新增：

1. “内容丰满度”三段选择器，位于目标/来源后、补充需求前；
2. “由 TXT”模式和目标类型二级选择器；
3. TXT 来源摘要及片段勾选列表；
4. 预算面板中的“最低生成”“本次输出预留”“来源预算”“预计输入”；
5. 世界书预览中的“全部常驻”标识及常驻 Token 估算；
6. 角色/世界书预览中的质量检查摘要。

界面所有颜色继续从 `useThemeStore` 获取，不硬编码颜色。

### 7.2 预算面板文案

预算格至少显示：

```text
上下文容量
模型最大输出
所选档位最低生成
本次输出预留
来源预算
预计输入
```

当不可生成时，优先显示最具体的原因：

1. `max_output_tokens` 小于质量下限；
2. 上下文窗口/15% 滑块上限不足；
3. 当前滑块低于最小比例；
4. 所选来源超过来源预算。

### 7.3 预览状态

通过时：展示产物摘要和 `qualityReport` 的简要信息。角色至少显示描述长度、对话轮数、标签数；世界书显示每条正文长度、全部常驻状态、常驻内容 Token 估算。

失败时：保留表单和来源选择，不创建预览产物。Toast 只做简短提示；完整的可操作原因显示在生成按钮附近，避免长错误被 Toast 截断。

“保存到手机”“导入资料库”只在通过全部质量校验的预览状态中可见。

---

## 8. 类型、模块与调用边界

### 8.1 建议文件变化

| 文件 | 变化 |
|---|---|
| `src/services/construction/quality.ts`（新增） | 丰满度常量、Token/字符/字段约束、质量报告与纯校验函数 |
| `src/services/construction/budget.ts` | `detailLevel` 入参、动态 `requiredMinOutput`、最小滑块比例和诊断 |
| `src/services/construction/targets.ts` | TXT 两种目标输入、`ConstructionDetailLevel` 贯穿四/六种构建模式 |
| `src/services/construction/textSourceParser.ts`（新增） | BOM 解码、分段、选择快照、Token 估算；不依赖 UI/网络/数据库 |
| `src/services/fileImport.ts` | 仅增加可复用的 TXT 选择与临时副本辅助，不在此处写构建规则 |
| `src/services/constructionAiGenerator.ts` | 提示词、来源快照、实际输出 Token 读取、质量校验、世界书常驻断言 |
| `src/screens/BuildScreen.tsx` | 档位、TXT 选择/片段、预算与质量报告 UI |
| `__tests__/...` | 覆盖本规格第 10 节 |

`constructionFileService.ts` 的文件序列化和直接导入资料库逻辑保持为既有入口；它只能接收已经通过质量校验的 `ConstructionArtifact`。

### 8.2 模式扩展

建议将模式扩展为：

```ts
type ConstructionMode =
  | 'character_independent'
  | 'character_from_worldbook'
  | 'worldbook_independent'
  | 'worldbook_from_character'
  | 'character_from_text'
  | 'worldbook_from_text';
```

TXT 来源结构使用已选片段生成的 `sourceSnapshot`，而不在 `ConstructionInput` 中携带文件路径或原始 File URI。

新增 scenario：

```text
construction_character_from_text
construction_worldbook_from_text
```

它们沿用现有 LLM usage log，不增加表字段。

### 8.3 质量校验 API

建议 `generateConstruction()` 返回：

```ts
interface GeneratedConstructionResult {
  artifact: ConstructionArtifact;
  qualityReport: ConstructionQualityReport;
}
```

只有 `qualityReport.passed === true` 时函数才 resolve；将 report 与 artifact 一起返回，是为了让预览显示可解释数据，而不是让页面重复计算质量。

若保持原返回类型以降低调用方改动，也可把报告挂到新 `ConstructionArtifact` 联合字段；两种实现中必须确保报告不可由页面伪造，且保存/导入路径仅接受已验证结果。

---

## 9. 非目标与明确禁止

本轮不实现：

1. 自动、隐藏的“二次补全”模型请求；
2. 根据世界书关键词切换非常驻，以降低上下文占用；
3. 由 TXT 直接写入角色/世界书资料库而不经模型和质量校验；
4. TXT 的 OCR、PDF/DOCX 解析、云端文件同步、长期保存或备份；
5. 修改全局资料预算算法、世界书扫描算法、写作上下文注入策略或项目资源开关；
6. 将角色卡或世界书生成重新放回“资料”页；生成入口仍统一在“构建”页；
7. 新增数据库 Schema、持久化“上次使用档位”或保存 TXT 文件内容；
8. 修改现有 JSON/PNG 来源解析兼容性；
9. 以关键词命中猜测“角色维度覆盖”后把其作为硬性拒绝条件；
10. 将模型被 `finishReason=length` 截断的结果当成短内容修复后继续导入。

---

## 10. 测试规格

### 10.1 预算与档位纯函数

`__tests__/constructionBudget.test.ts` 和新增 `__tests__/constructionQuality.test.ts` 至少覆盖：

1. 三档角色/世界书下限计算；
2. 世界书条目数变化时总下限和最小百分比正确变化；
3. 默认丰满档世界书默认 4 条；
4. `max_output_tokens` 小于质量下限时不可生成；
5. 同一上下文下调高滑块后恰好达到可生成边界；
6. 模型返回 usage 与本地估算的优先级；
7. 角色所有字段、对话轮数、标签数和 description 下限；
8. 世界书逐条长度、精确条目数、关键词去重、全部常驻；
9. 紧凑/丰满/深度对应的通过与失败边界；
10. 质量失败绝不产生可保存 artifact。

### 10.2 生成器契约

`__tests__/constructionAiGenerator.test.ts` 新增：

1. 各档角色系统提示词含相应字段级长度/维度要求；
2. 深度档明确要求 description 1200 字、世界书单条 800 字；
3. 所有世界书提示词包含 `constant: true`，TXT 世界书模式也相同；
4. `parseWorldbookResponse()` 无论模型返回何值，最终条目均为 `constant: true`；
5. `outputTokens` 低于下限拒绝；缺 usage 时按 `estimateTokens` 拒绝；
6. `finishReason=length` 继续优先拒绝；
7. TXT 两种模式带入选中来源快照、补充需求、档位与正确 scenario；
8. 通过质量检查的产物仍可被现有角色/世界书导入解析器回读。

### 10.3 TXT 解析器

新增 `__tests__/constructionTextSourceParser.test.ts`：

1. UTF-8 BOM、纯 UTF-8、UTF-16 LE/BE；
2. 非法编码明确失败而不产生乱码快照；
3. `#` 标题、中文“第 X 章”、空行段落的分段；
4. 无标题长文本的安全分段；
5. 片段勾选后快照顺序稳定、Token 统计正确；
6. 选中内容超预算时 UI/纯函数给出阻断，而非截断；
7. 空白 TXT、超长单段、中文/英文混合和特殊字符。

### 10.4 UI 与直接导入回归

扩展 `__tests__/BuildScreen.test.tsx`：

1. 默认显示“丰满”；
2. 档位和世界书条目数改变后预算/生成按钮状态更新；
3. 预算不足显示明确原因；
4. 选择 TXT 后可选目标和来源摘要；
5. 超预算 TXT 禁止生成；
6. 世界书预览明确显示“全部常驻”；
7. 质量失败没有保存/导入按钮；
8. 通过后既有“保存到手机 / 导入资料库”流程不回归；
9. 无当前项目的导入拦截继续有效。

同时保留并扩展 `constructionFileService` 和 `fileImport` 测试：构建世界书进入资料库后，每个条目为常驻，且项目启用关系不回归。

### 10.5 E2E 验收

新增/扩展 Maestro 流程，至少覆盖：

```text
角色丰满档生成 → 质量通过 → 保存/导入
世界书丰满档生成 → 预览全常驻 → 导入 → 写作上下文预览出现世界书
TXT → 选择片段 → 角色卡生成
TXT → 选择片段 → 世界书生成 → 常驻写作上下文生效
预算不足 → 生成按钮禁用且不发请求
```

真实外部模型的文本质量须人工抽检；自动化测试用固定 mock JSON 验证边界和不变量，不依赖模型随机语义。

### 10.6 回归命令

```powershell
npx jest __tests__/constructionBudget.test.ts __tests__/constructionQuality.test.ts --runInBand
npx jest __tests__/constructionAiGenerator.test.ts __tests__/constructionTextSourceParser.test.ts --runInBand
npx jest __tests__/BuildScreen.test.tsx __tests__/constructionFileService.test.ts __tests__/fileImport.test.ts --runInBand
npm run verify
```

实施完成后，再按 Android 流程执行构建与模拟器验收；正式 APK 只有在用户明确要求发布时才构建，并必须先阅读 `docs/RELEASE_APK_BUILD.md`。

---

## 11. 实施顺序

### Phase 1：纯规则与预算

1. 新增 `quality.ts`；
2. 改造 `budget.ts` 接受丰满度和动态条目下限；
3. 先补预算/质量失败测试，再实现；
4. 不改 UI、不发网络请求。

### Phase 2：生成器与提示词

1. 让四种既有模式都携带丰满度；
2. 强化角色、世界书提示词；
3. 接入真实输出 Token 与质量报告；
4. 再次确认世界书提示词、解析器、回读均为 `constant: true`；
5. 保证原 JSON/PNG 反向构建回归。

### Phase 3：TXT 素材来源

1. 实现编码解码、分段、快照和缓存清理的纯函数；
2. 增加两种 TXT 构建模式；
3. 接入来源预算和选段 UI；
4. 补隐私提示与异常路径测试。

### Phase 4：UI、E2E 与文档

1. 接入档位、质量报告、常驻 Token 提示；
2. 完成直接导入和写作上下文常驻回归；
3. 执行 `npm run verify`；
4. 更新 CHANGELOG、README 的构建能力说明；
5. 在 `test-logs/` 保存模拟器验收产物，禁止污染仓库根目录。

每个 Phase 独立提交；不要夹带无关重构、格式化或版本文件手改。

---

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 深度档超过多数模型 4,000 Token 上限 | 动态预算阻断；默认 4 条世界书；清晰提示降低档位/条目或提高模型上限 |
| 模型声明完成但实际文本偏短 | usage/估算 + 字段级/逐条硬校验，不接收短产物 |
| 长常驻世界书挤占写作资料预算 | 显示常驻 Token 估算；引导通过条目数和档位控制，绝不关闭常驻 |
| 强提示词导致字段套话或重复 | 维度分工、条目去重、对话轮数与事实优先约束；真实模型抽检 |
| TXT 太长导致来源超上下文 | 用户选择片段；不静默截断、不自动摘要、不隐式增加请求次数 |
| TXT 编码乱码 | 明确支持 BOM UTF-8/UTF-16；无法安全解码即失败 |
| TXT 泄露到持久存储 | 仅缓存副本，构建后清理；不写库、不备份；发送前显示隐私提示 |
| 改造常驻语义导致写作回归 | 将 `constant === true` 设为提示词、解析、回读、导入和 E2E 的多层硬断言 |

---

## 13. Definition of Done

只有下列条件全部满足，本次改造才可完成：

- [ ] 角色卡和世界书均有用户可见、可计算的生成 Token 下限；
- [ ] 预算不足时不能发起请求，并显示可操作原因；
- [ ] 返回 JSON 即使合法，只要 Token/字段/条目质量不足也不能保存或导入；
- [ ] 丰满角色卡覆盖身份、外在、经历、关系、动机、矛盾、当前冲突与对话声音；
- [ ] 深度档达到参考基线：description ≥ 1200 字、世界书单条 content ≥ 800 字；
- [ ] 所有构建世界书条目在提示词、解析产物、回读和资料库导入后始终 `constant: true`；
- [ ] 世界书导入后在真实写作上下文预览中可稳定出现；
- [ ] TXT 可在不持久化原文件的前提下，经选段和预算校验生成角色卡或世界书；
- [ ] JSON/PNG 既有来源模式、保存和直接导入资料库流程未回归；
- [ ] 新增 Jest、BuildScreen 与 Maestro 覆盖全部关键路径；
- [ ] `npm run verify` 通过；
- [ ] CHANGELOG、README 与最终实现一致；
- [ ] 无数据库迁移、无新 Android 权限、无秘密或用户 TXT 内容进入仓库。
