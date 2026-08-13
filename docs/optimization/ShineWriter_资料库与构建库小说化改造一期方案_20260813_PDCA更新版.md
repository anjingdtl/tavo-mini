# ShineWriter 资料库与构建库小说化改造一期方案

> 文档定位：一期实施与穿测基线  
> 项目：`anjingdtl/tavo-mini` / ShineWriter  
> 远端核对分支：`main`  
> 最新远端 HEAD：`36b353ba3014cd2e99ee8e87c826480b2130bb22`  
> 最新生产代码基线：`85ec31355b88f6caa6df49f48ea7a0dc966b860a`  
> 生产代码提交：`fix: finalize context budget v3 closure`  
> 应用版本：`2.11.49`  
> 数据库 Schema：`51`  
> Context Budget 契约版本：`6`  
> 更新日期：2026-08-13  
> 核心原则：**富资料、轻协议、暂不接驳**

---

## 0. 执行摘要

本期只解决两个问题：

1. **资料库中的“角色、世界书、预设”到底应该是什么。**
2. **构建模块应该怎样生成适用于长篇小说创作的角色、世界设定和作家风格资料。**

本期**不解决**这些资料在正文创作时“如何被消费”的问题。

也就是说，本期只完成：

```text
用户 / 外部文件
      ↓
资料库 + 构建库
      ↓
高质量小说资源资产
      ↓
兼容格式保存 / 导入 / 导出
```

本期明确停在这里。

以下链路全部留到下一阶段：

```text
角色档案 / 世界书 / 预设
        ↓
弹性上下文
        ↓
Context Budget
        ↓
Pipeline Context Snapshot
        ↓
Draft / Review / FactCheck / Brief / Proof
```

### 0.3 最新提交后的增量审计结论

从 `faccaf42...` 到当前 Final Seal 序列，项目进一步封板了 Context Budget V3 与 Pipeline 接驳。对一期最重要的不是新增功能，而是形成新的“保护面”：

```text
已封板运行时
├─ Context Budget V3 / contextBudgetVersion=6
├─ model-aware context sizing
├─ hierarchical / elastic allocation
├─ Story State / Sliding / Episodic actual demand
├─ Resources candidate-first rendering
├─ Worldbook activation
├─ Context Preview observability
├─ Pipeline Context Snapshot
├─ Freeze / Resume
└─ cold-start Resume persistence
```

因此一期实施策略由原来的：

```text
“尽量不碰下游”
```

升级为：

```text
“下游封板区默认不可修改”
```

只有资料侧自身无法完成兼容，且存在明确编译/数据损坏问题时，才允许做**不改变运行语义**的最小兼容补丁；否则一律记入二期。

### 0.1 一期最终目标

一期结束后，ShineWriter 应形成三类稳定的小说资料资产：

```text
资料库
│
├─ 角色档案
│   └─ 回答“这个人物是谁”
│
├─ 世界书
│   └─ 回答“这个世界是什么样、有哪些持续成立的世界事实”
│
└─ 预设
    └─ 回答“应该怎么写”
       ├─ 我的预设
       ├─ 作家风格
       └─ 官方预设
```

构建模块则负责生成这些**小说语义资料**，而不是让 LLM 直接承担 Tavern / CCv3 / Lorebook 等兼容协议字段的拼装工作。

### 0.2 一期最重要的边界

> **本期不得修改弹性上下文、Context Budget V3、资源运行时注入、Pipeline、Story Memory、Canon、Outline 运行逻辑。**

### 0.2.1 交付方式：必须采用自主 PDCA 闭环

本方案不是“一轮开发 + 一轮测试完成即交付”的任务。

Agent 必须把整个一期建设视为一个持续闭环：

```text
PLAN
逐条读取方案目标、边界、验收项、红线
        ↓
DO
实施本轮改造 + targeted tests + 集成测试 + Android E2E
        ↓
CHECK
重新从方案第一页开始逐条兑现审核
重新检查实际代码，而不是只看自己的变更说明
重新检查测试证据、兼容性、边界、数据保留和 GO 条件
        ↓
ACT
发现任何未兑现项、缺口、回归、边界扩散或证据不足
→ 继续修复
→ 补测试
→ 重新穿测
→ 再次进入 CHECK
        ↓
只有全部方案目标 = GO
才允许最终交付
```

**首轮完成不是结束，而只是第一次 PDCA 的 `DO` 阶段结束。**

Agent 不得因为：

```text
代码已经能编译
主要测试已通过
功能看起来可用
首轮改造已经完成
```

就提前交付。

最终交付前，必须至少完成一次**独立于首轮实现过程的方案复审**，并在存在问题时自动进入下一轮 PDCA，直到没有剩余 NO-GO 项。


即使在本期穿测中发现“新角色档案进入 Writer 后仍按旧字段展示”“世界书注入仍不够理想”“作家预设在某阶段没有按预期工作”，也只允许记录为二期接驳问题，**不得为了把一期功能“顺手接通”而修改下游主链路。**

---

# 1. 远端当前代码审计

## 1.1 当前远端基线

本方案更新时采用以下最新远端序列：

```text
main HEAD
36b353ba3014cd2e99ee8e87c826480b2130bb22
└─ Final Seal / 验收证据与总结文档提交

production code baseline
85ec31355b88f6caa6df49f48ea7a0dc966b860a
fix: finalize context budget v3 closure
```

其中 `85ec313...` 是本轮实际生产代码封板提交，重点收口：

```text
Context Preview 的只读可观测性
Pipeline cold-start Resume 的持久化恢复
相关自动化测试
```

其后 `36b353b...` 主要补齐 Final Seal / 发布验收证据与总结文档，不再扩大算法面。

本轮验证运行：

```text
GitHub Actions run: 31625912741
JavaScript validation: PASS
Migration Matrix: PASS
Android Debug build: PASS
```

当前工程基线继续为：

```text
name: ShineWriter
version: 2.11.49
database schema: 51
contextBudgetVersion: 6
React Native: 0.85.3
TypeScript: 5.8.3
```

### 对一期方案的直接影响

这批新提交没有改变“一期只做资料库 / 构建库小说化”的目标，反而要求把边界进一步锁紧：

> **Context Budget V3 已经进入 Final Seal 状态；一期不得借资源小说化之名改变其候选收集、Worldbook activation、Preview、Freeze / Resume、Pipeline Snapshot 或预算分配契约。**

现有主要门禁命令：

```bash
npm run lint
npm run typecheck
npm run test:ci
npm run verify:version
npm run verify
npm run apk:debug
npm run apk:release
```

---

## 1.2 当前资料库实际结构

当前 `src/screens/ResourceLibrary.tsx` 已经把资源集中到一个资料库页面：

```text
续写
大纲
角色
世界书
笔记
预设
```

角色、世界书、预设均为数据库资源，并通过 `project_resources` 与项目建立启用关系。

这意味着一期不需要重新发明一个“小说资料中心”，而应该**在现有 ResourceLibrary 内完成语义升级**。

### 当前角色资源

`src/data/repositories/characterRepository.ts` 当前角色核心存储：

```text
characters
├─ name
├─ source_type
├─ data_json
├─ max_tokens
├─ estimated_tokens
└─ collection_id
```

`data_json` 是通用 JSON 容器。

因此一期完全可以在原 CCv3 JSON 中增加 ShineWriter 自己的小说角色扩展，而不需要新增角色字段表。

**结论：角色一期优先零 Schema 迁移。**

### 当前世界书资源

`src/data/repositories/worldbookRepository.ts` 当前条目已经具备：

```text
keyword_primary
keyword_secondary
content
comment
enabled
constant
max_tokens
estimated_tokens
position
collection_id
```

并且：

- 新建世界书条目默认 `constant = 1`；
- 世界书合集在当前项目启用时，会让该合集子条目参与当前项目；
- 当前实现还会在启用合集时将条目更新为 `constant = 1`。

这与当前产品定义一致：

> **ShineWriter 自建世界书是小说持续世界认知，不依赖用户理解 Lorebook 关键词触发机制。**

本期不改变该运行规则。

**结论：世界书一期零 Schema 迁移。**

### 当前预设资源

`src/types/novel.ts` 与 `src/data/repositories/presetRepository.ts` 当前 Preset 持久字段：

```text
name
is_default
system_prompt
writing_style
temperature
top_p
max_tokens
extra_instructions
```

当前资料库编辑器也直接编辑：

- 系统提示词
- 写作风格
- 额外约束
- 温度
- Top P
- Max Tokens
- 默认预设

当前 `exportService.ts` 的预设导出格式是：

```json
{
  "spec": "shinewriter-preset-v1",
  "name": "...",
  "system_prompt": "...",
  "writing_style": "...",
  "extra_instructions": "...",
  "temperature": 0.8,
  "top_p": 0.9,
  "max_tokens": 4000
}
```

所以必须以远端事实为准：

> 当前角色和世界书已经有明确的 CCv3 / Lorebook v3 兼容输出链路；当前 Preset 则仍是 ShineWriter 自有持久结构和 `shinewriter-preset-v1` 导出格式。

一期因此**不把“完整迁移到某一外部 Preset 协议”设为前置条件**，避免把资料小说化工程扩大为协议迁移工程。

---

# 2. 当前构建模块的问题

## 2.1 角色构建仍然是 Tavern / Chatbot 角色卡思维

当前 `src/services/constructionAiGenerator.ts` 中：

```ts
const CHARACTER_STRING_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
] as const;
```

当前角色系统 Prompt 要求 LLM 必须生成：

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

其中：

- `first_mes`
- `mes_example`
- `system_prompt`
- `post_history_instructions`
- `alternate_greetings`

本质上是面向角色扮演聊天，而不是面向小说作者管理角色。

当前 `CharacterEditor.tsx` 也仍完整暴露：

- 第一条消息
- 替代问候
- 对话示例
- system_prompt
- 后置指令

因此现在虽然页面叫“角色”，底层仍然在要求用户和 LLM 创建一个聊天机器人角色。

---

## 2.2 当前角色“丰满度”预算花错了位置

`src/services/construction/quality.ts` 当前会分别检查：

```text
first_mes
mes_example
system_prompt
post_history_instructions
dialogue turns
```

并为这些字段预留大量输出。

这会导致同样的 3000 Token：

```text
旧方案：
人物本体  + 角色聊天协议 + 对话示例 + 模型行为指令

目标方案：
人物本体  + 身份经历 + 动机 + 矛盾 + 关系 + 语言 + 人物弧
```

一期应该把预算从“聊天卡完整度”重新投入到“小说人物完整度”。

---

## 2.3 当前世界书已经常驻，但构建 Prompt 仍混入剧情职责

当前 `worldbookSystemPrompt()` 已经明确：

```text
constant = true
小说写作默认整本世界书进入上下文
```

这一点本期保留。

但当前覆盖要求仍包括：

```text
当前主冲突
剧情钩子
关系或冲突
```

尤其 `worldbook_from_character` 当前要求：

> 至少有一条描述该角色的关键关系、组织或冲突。

其中“组织”“稳定社会关系”可以属于世界书，但“当前主冲突”“剧情冲突”容易把 Outline / Story Memory 的动态职责写入长期世界设定。

本期需要把世界书构建语义收束为：

> **作者希望小说世界持续成立、持续被模型知道的世界事实。**

而不是：

> 当前剧情状态的第二份记忆。

---

## 2.4 当前世界书由 LLM 直接生成兼容协议字段

当前 LLM 被要求自己输出：

```json
{
  "keys": [],
  "secondary_keys": [],
  "content": "",
  "comment": "",
  "constant": true
}
```

随后代码再强制：

```ts
constant: true
```

这说明 `constant` 本来就不需要让模型决定。

同理：

```text
spec
spec_version
enabled
insertion_order
creator
character_version
```

这些都属于确定性兼容元数据，不应该消耗 LLM 的创作注意力。

---

# 3. 一期产品定义

## 3.1 六类创作信息的职责边界

即使本期只改前三类，也应先把边界写死：

| 资源 | 唯一职责 | 一期 |
|---|---|---|
| Preset | HOW：怎么写 | 改 |
| Character | WHO：人物是谁 | 改 |
| Worldbook | WORLD：世界是什么样 | 改 |
| Outline | NEXT：接下来计划发生什么 | 不改 |
| Story Memory | PAST/STATE：已经发生什么、动态状态 | 不改 |
| Canon | SOURCE TRUTH：续写原著权威事实 | 不改 |

核心要求：

> **一期不得为了让 Character / Worldbook 更“好用”，把 Outline、Story Memory、Canon 的职责复制进来。**

---

# 4. 一期总架构

## 4.1 设计原则：富资料、轻协议、暂不接驳

### 富资料

资料库保存的是**母版资料 / 完整真相**。

不应因为未来可能存在 Token 预算问题，就提前把角色、世界书、作家风格压缩成贫瘠标签。

### 轻协议

LLM 只生成它擅长的：

- 人物语义
- 世界事实
- 文学风格规则

协议字段由本地代码确定性生成。

### 暂不接驳

本期到资料库落库/导出为止。

不修改这些资料怎样进入正文 Writer。

---

## 4.2 构建中间模型

新的构建链路：

```text
用户输入 / TXT / 角色卡 / 世界书
              ↓
          LLM 生成
              ↓
      小说语义中间模型
              ↓
    deterministic Adapter
              ↓
  CCv3 / Lorebook / Preset 数据
              ↓
      现有资料库持久层
```

本期不要让：

```text
LLM = 创意生成器 + 协议编译器
```

而应变成：

```text
LLM = 小说资料生成器
Local Adapter = 协议编译器
```

---

# 5. 角色资源小说化改造

## 5.1 UI 命名

资料库 Tab 可继续显示简洁的：

```text
角色
```

但以下面向创建/编辑的主要文案统一改为：

```text
角色档案
```

例如：

```text
导入角色卡          → 保留（兼容入口）
新建角色卡          → 新建角色档案
角色详情            → 角色档案
构建目标“角色卡”    → 角色档案
```

在适当位置增加一次说明：

> 角色档案用于小说人物塑造；兼容 CCv3 JSON / PNG 角色卡导入导出。

不要全面把 “CCv3 角色卡” 术语删掉，因为它仍是兼容格式。

---

## 5.2 新的 `NovelCharacterDraft`

建议在 `construction/targets.ts` 或独立文件增加内部类型：

```ts
interface NovelCharacterDraft {
  name: string;
  aliases?: string[];
  role?: string;
  identity?: string;
  appearance?: string;
  background?: string;
  personality?: string;
  motivation?: string;
  conflict?: string;
  relationships?: string[];
  abilities?: string;
  limitations?: string;
  secrets?: string;
  speech_style?: string;
  arc?: string;
  continuity?: string[];
  tags?: string[];
}
```

### 为什么保持相对扁平

一期不要设计过深嵌套 JSON。

例如关系先用：

```json
[
  "李毅：高中同学，信任但经常争执",
  "何世恒：队友，对其行动力高度依赖"
]
```

而不是马上要求：

```json
{
  "target_id": "...",
  "relationship_type": "...",
  "trust": 0.81,
  "timeline": [...]
}
```

理由：

- LLM 输出稳定性更高；
- 用户手工编辑更容易；
- 不需要 Schema 迁移；
- 二期如果需要语义关系图，再做独立解析。

---

## 5.3 角色档案应覆盖的核心维度

构建 Prompt 应把输出预算用于：

```text
1. 姓名 / 别名
2. 叙事定位
3. 身份与社会位置
4. 外貌与辨识特征
5. 成长环境
6. 关键人生经历
7. 显性性格
8. 隐性性格
9. 性格形成原因
10. 内在矛盾
11. 长期欲望
12. 短期目标
13. 恐惧 / 弱点 / 执念
14. 价值观 / 底线
15. 关键人物关系
16. 能力 / 知识 / 资源
17. 能力限制
18. 秘密 / 认知盲区 / 错误信念
19. 说话习惯与语言风格
20. 行为习惯
21. 人物弧
22. 不可漂移的连续性事实
```

不是每个字段都必须非空。

### 最低结构硬要求

只保留：

```text
name 必须非空

并且以下至少存在足够核心人物信息：
role / identity / background
personality / motivation / conflict
```

不要硬要求每个人物都有：

- 秘密
- 人物弧
- 特殊能力
- 多段关系

否则会逼模型无依据编造。

---

## 5.4 明确退出 AI 构建的字段

一期角色构建 **LLM 不再生成**：

```text
first_mes
mes_example
system_prompt
post_history_instructions
alternate_greetings
```

这些字段不应再：

- 出现在角色系统 Prompt 的强制 JSON 协议；
- 参与角色丰满度评分；
- 占用构建输出预算；
- 出现在新建小说角色的默认编辑主界面。

---

## 5.5 CCv3 本地 Adapter

为了保持当前导入/导出链路，构建完成后仍输出标准角色卡 envelope：

```json
{
  "spec": "chara_card_v3",
  "spec_version": "3.0",
  "data": {
    "name": "...",
    "description": "...",
    "personality": "...",
    "scenario": "",
    "first_mes": "",
    "mes_example": "",
    "system_prompt": "",
    "post_history_instructions": "",
    "tags": [],
    "alternate_greetings": [],
    "creator": "ShineWriter 构建",
    "character_version": "1.0",
    "extensions": {}
  }
}
```

其中：

### `description`

由本地 Adapter 把完整 `NovelCharacterDraft` 编译为人类可读的小说角色档案文本。

例如：

```text
【角色定位】
...

【身份背景】
...

【关键经历】
...

【动机与目标】
...

【矛盾与弱点】
...

【关系】
...

【语言与行为】
...

【连续性事实】
...
```

### `personality`

保留核心性格字段，便于外部 CCv3 工具读取。

### `scenario`

一期建议：

- 如果中间模型后续补充 `initial_situation`，可映射；
- 否则空字符串；
- 不把“叙事氛围”硬塞进 scenario。

### 聊天型字段

统一由 Adapter 设置为空：

```text
first_mes = ""
mes_example = ""
system_prompt = ""
post_history_instructions = ""
alternate_greetings = []
```

---

## 5.6 ShineWriter 扩展数据

建议完整中间模型同时写入：

```text
data.extensions.shinewriter_novel_character_v1
```

例如：

```json
{
  "extensions": {
    "shinewriter_novel_character_v1": {
      "aliases": [],
      "role": "...",
      "identity": "...",
      "appearance": "...",
      "background": "...",
      "motivation": "...",
      "conflict": "...",
      "relationships": [],
      "abilities": "...",
      "limitations": "...",
      "secrets": "...",
      "speech_style": "...",
      "arc": "...",
      "continuity": []
    }
  }
}
```

目的：

- `description` 为通用兼容文本；
- `extensions` 为 ShineWriter 的高质量结构化母版；
- 不新增数据库列；
- 二期接驳时可以直接消费结构化版本；
- 外部软件即使忽略扩展，也不影响 CCv3 基础兼容。

---

# 6. 角色资料库编辑器改造

当前 `CharacterEditor.tsx` 是最需要小说化的 UI 之一。

## 6.1 新角色档案默认编辑模式

当检测到：

```text
extensions.shinewriter_novel_character_v1
```

或新建的是 ShineWriter 小说角色时，默认进入：

```text
【基本信息】
姓名
别名
角色定位
身份

【人物塑造】
外貌
背景经历
核心性格
目标 / 动机
主要矛盾 / 弱点

【关系与能力】
关键关系
能力 / 资源
能力边界

【深层人物】
秘密 / 认知盲区
说话习惯
人物弧
连续性事实
```

---

## 6.2 旧 CCv3 卡兼容编辑

不能删除现有 Tavern 字段支持。

如果导入老角色卡含有：

```text
first_mes
mes_example
system_prompt
post_history_instructions
alternate_greetings
```

应继续：

- 原样保存；
- 可编辑；
- 可再次导出；
- PNG 角色图资产继续保留。

推荐 UI：

```text
小说角色档案
────────────
主要小说字段

兼容信息
────────────
[展开 CCv3 兼容字段]
  第一条消息
  替代问候
  对话示例
  系统提示词
  后置指令
```

这样做到：

> **新角色不再围绕聊天字段创建，旧角色也不会丢数据。**

---

## 6.3 原始 JSON 回退能力必须保留

当前 CharacterEditor 在 JSON 解析失败时会回落到原始 JSON 编辑。

该安全能力保留。

不得为了“字段化 UI”丢掉对未知扩展字段的 round-trip。

---

# 7. 世界书小说化改造

## 7.1 世界书的产品定义

一期正式定义：

> **Worldbook = 作者要求当前小说世界持续成立、持续被创作模型知晓的世界事实与世界背景。**

与传统纯关键词百科式 Lorebook 不同，ShineWriter 自建世界书默认承担：

```text
Persistent World Awareness
```

即：

> 用户启用一本世界书，就合理期待模型知道其中的世界事实。

---

## 7.2 常驻策略与 Worldbook activation 本期不改

本期明确保留资料语义：

```text
ShineWriter 新建世界书条目 → 默认 constant=true
ShineWriter 构建世界书     → Adapter constant=true
外部 Lorebook 显式 false   → 继续按现有导入兼容规则保留
```

同时把以下内容列为**封板运行时契约**：

```text
世界书合集启用/停用的现有 Repository 语义
project_resources / project_collection_settings 的现有行为
getWorldbookEntriesByProject 的现有读取契约
Worldbook activation 的现有 Context V3 行为
resource candidate-first rendering
0 命中/递归扫描/预算分配等现有运行时行为
```

一期不重新定义这些规则，也不为了“小说化”修改 `setWorldbookCollectionEnabledForProject()` 等运行时相关 Repository 逻辑。

尤其不实施以下二期思路：

```text
Core / Reference
高/中/低注入浓度
关键词 0 命中则不注入
语义检索替代常驻
按章节压缩世界书
新的 Worldbook 激活算法
```

这些都属于上下文接驳工程，不属于一期。

---

## 7.3 世界书内容应回答什么

建议构建条目围绕：

```text
条目名称
类型 / 性质
定义
发生地点 / 所属区域
影响范围
知情范围（如适用）
起源 / 历史
运行规则
当前长期状态
社会 / 世界影响
与其他设定的稳定关系
不可违反的事实
```

### “发生地点 != 影响范围”

例如：

```text
条目：青秀路连续杀人案
发生区域：青秀路
影响范围：南宁市
```

即使剧情人物当前没有进入青秀路，这件事仍可能通过：

- 新闻
- 警方布控
- 市民警觉
- 夜间营业变化
- 社会传闻

影响整个城市。

世界书应该把这种“世界后果”表达清楚，而不只是存一个关键词。

---

## 7.4 世界书不得承担的内容

一期 Prompt 明确禁止把以下内容作为普通世界书的默认覆盖要求：

```text
本章发生了什么
上一章发生了什么
当前角色受伤状态
人物现在在哪
伏笔已经揭示到哪
下一章应该发生什么
当前主冲突推进到哪一步
写作风格
```

对应归属：

```text
动态故事状态 → Story Memory
未来安排     → Outline
文学表达     → Preset
续写权威事实 → Canon
```

当前构建 Prompt 中的：

```text
当前主冲突
剧情钩子
```

应从默认世界书覆盖规范中移除。

---

# 8. 世界书构建中间模型

建议：

```ts
interface NovelWorldbookDraft {
  name: string;
  entries: NovelWorldbookEntryDraft[];
}

interface NovelWorldbookEntryDraft {
  title: string;
  category?: string;
  keywords?: string[];
  content: string;
}
```

其中 `content` 应是完整、高密度的世界设定正文。

可以要求模型在正文中按自然语言表达：

```text
性质
影响范围
核心事实
运行规则
现实影响
稳定关联
```

但不要把一期 JSON schema 复杂化成十几个必填字段。

---

## 8.1 Lorebook Adapter

本地确定性转换：

```text
title
→ comment
→ 首要 keyword

keywords
→ keys

secondary_keys
→ 默认 []

content
→ content

enabled
→ true

constant
→ true

insertion_order
→ 本地数组序号

spec
→ lorebook_v3

spec_version
→ 1.0
```

模型不再负责：

```text
constant
enabled
insertion_order
spec
spec_version
```

---

## 8.2 关键词继续保留，但角色改变

一期仍保留 Lorebook 的：

```text
keys
secondary_keys
```

因为：

- 外部兼容需要；
- 现有数据库已经支持；
- 二期可以继续利用它们作为相关性线索。

但一期构建 Prompt 不再把“关键词能否命中”作为世界事实是否有价值的判断标准。

---

# 9. 角色 → 世界书 / 世界书 → 角色 / TXT 模式

现有四个 UI 模式不需要推倒重做：

```text
独立构建
由世界书
由角色卡
由 TXT
```

一期只改语义。

---

## 9.1 世界书 → 角色档案

目标：

> 在给定世界规则下创建一个真正属于这个世界的小说人物。

优先吸收：

- 时代与社会制度；
- 地理环境；
- 组织；
- 职业逻辑；
- 技术/魔法限制；
- 社会规范。

禁止：

- 把世界书全文复制进角色 description；
- 把所有世界设定都变成人物经历。

---

## 9.2 角色档案 → 世界书

目标：

> 从角色所处环境中扩展稳定世界知识。

允许抽取/扩展：

```text
地点
组织
制度
职业体系
宗教
文化
历史背景
社会关系
技术 / 魔法机制
关键物品
```

不应把：

```text
人物当前情绪
人物当前任务
人物弧推进
某一章的冲突结果
```

机械转换成世界书。

当前 Prompt 中：

> “至少有一条描述该角色的关键关系、组织或冲突”

建议调整为：

> “优先扩展与角色有关的地点、组织、制度、社会关系或稳定世界规则；不得把角色当前情绪、即时目标或剧情进度伪装为世界设定。”

---

## 9.3 TXT → 角色档案

明确：

```text
素材明确事实 = 高优先级既定事实
未明确部分   = 可在不冲突前提下补完
```

后续可预留两个模式，但一期不是必须：

```text
整理模式：只整理显式事实
补完模式：允许合理创作
```

如果实现会扩大 UI，可留作一期 P2 或后续。

---

## 9.4 TXT → 世界书

目标：

> 将长文本中的稳定世界知识拆分为独立条目。

优先识别：

- 地点
- 势力
- 制度
- 规则
- 历史
- 文化
- 物品
- 持续社会事件

不要机械复制段落。

---

# 10. 构建丰满度重新定义

## 10.1 1M 上下文背景下的原则

当前主力写作模型已经可以使用很大的上下文窗口。

因此一期资料资产不应继续采取“贫困式资料设计”。

正确原则：

> **资料库保存完整版真相；二期上下文层再决定一次看多少。**

一期不要为了未来的：

- context token
- pipeline token
- retrieval

提前损失：

- 人物立体度；
- 世界完整度；
- 文学风格细节。

---

## 10.2 建议目标区间

以下全部是 **Soft Target**，不是硬门禁。

### 角色档案

| 档位 | 建议完整资料规模 |
|---|---:|
| 紧凑 | 1200–2000 中文字 |
| 丰满 | 2000–3500 中文字 |
| 深度 | 3500–5500 中文字 |

### 世界书单条

| 档位 | 建议规模 |
|---|---:|
| 紧凑 | 250–500 中文字 |
| 丰满 | 400–800 中文字 |
| 深度 | 600–1200 中文字 |

### 作家风格预设

| 档位 | 建议规模 |
|---|---:|
| 紧凑 | 1500–2500 中文字 |
| 丰满 | 2500–4500 中文字 |
| 深度 | 4000–7000 中文字 |

注意：

- 不设置“超过 X 字禁止保存”；
- 也不因为深度角色只有 3200 字就判失败；
- 目标是丰富有效信息，不是纯粹堆字。

---

## 10.3 “深度”不再等于“字数”

### 角色深度

增加的是：

```text
性格成因
内在矛盾
多层欲望
关系差异
价值冲突
弱点
错误信念
行为模式
人物弧
```

### 世界书深度

增加的是：

```text
历史成因
运行规则
利益关系
社会后果
地域影响
跨设定关联
例外和边界
```

### 作家风格深度

增加的是：

```text
叙述者人格
句法规律
对白规律
场景组织
冲突升级
悬念机制
意象系统
节奏规律
章节结构
常见误仿与禁止项
```

---

# 11. 构建质量门禁重构

## 11.1 Hard Gate

只保留客观、技术性失败：

```text
网络 / provider 请求失败
响应为空
reasoning-only
finish_reason = length / 明确截断
JSON 无法解析
根对象格式错误
角色缺少 name
角色完全没有核心人物信息
世界书 entries 为空
世界书条目 content 为空
Adapter 生成失败
CCv3 / Lorebook 本地回读失败
明显 Prompt / contract 泄漏
```

---

## 11.2 Soft Warning

以下全部不得直接丢弃生成结果：

```text
角色没有秘密
角色关系较少
角色档案低于建议长度
世界书某条较短
世界书类别覆盖不够全面
关键词数量偏少
作家预设某一文学维度不够充分
建议条目数量有轻微偏差（若最终结构仍可安全保存）
```

当前 UI 已经具备：

> “未完全达到目标，已保留本次结果”

这一交互方向应保留。

---

## 11.3 删除 Chatbot 专属质量项

从 `construction/quality.ts` 的角色质量模型中删除：

```text
minFirstMessageChars
minExampleChars
minSystemPromptChars
minPostHistoryChars
minDialogueTurns
```

替换为小说维度覆盖统计，例如：

```text
identity
background
personality
motivation
conflict
relationships
limitations
speech_style
arc
continuity
```

维度不足为 warning。

---

# 12. 构建预算模块改造边界

`src/services/construction/budget.ts` 属于**构建模块自己的输出预算**，不等同于正文 Context Budget V3。

因此一期允许修改：

```text
construction/budget.ts
```

但只能用于：

- 新角色档案的建议输出规模；
- 世界书构建批次规模；
- 构建模型 `max_tokens` 预留；
- 大模型上下文窗口下不再过度保守。

禁止借此修改：

```text
正文资源预算
Context Budget V3
Pipeline stage budget
资源注入预算
```

---

## 12.1 现有 1%–15% 输出预留滑块

当前构建页：

```text
requestedOutput = C × p
p ∈ [1%, 15%]
```

对 1M 上下文模型来说，通常 provider 的 `max_output_tokens` 会更早成为实际上限。

一期可保留该 UI，不必为了大上下文重新设计滑块。

只需要确保新的 Soft Target 不会因为旧 `requiredMinOutput` 逻辑把有效生成硬阻断。

---

## 12.2 世界书分批保留

当前世界书已经支持：

```text
条目过多
→ planWorldbookBatches
→ 多次 LLM 生成
→ 最后合并
```

该机制保留。

一期仅根据新的世界书内容规模重新校准每批目标。

不重写并发/队列/LLM 调度。

---

# 13. 预设与“作家风格库”一期改造

## 13.1 不新增 AuthorStyleProfile

一期禁止新增另一套：

```text
AuthorStyleProfile
StyleProfileV1/V2
authorStyleId
writerStyle
styleGate
style runtime JSON
style repair pipeline
```

作家风格就是 Preset 的一种官方资源。

---

## 13.2 资料库目录层

预设 Tab 改成：

```text
预设
│
├─ 我的预设
├─ 作家风格
└─ 官方预设
```

### 我的预设

现有数据库 Preset。

### 作家风格

App 内置静态 Catalog。

### 官方预设

可用于通用写作模板、类型小说模板等，仍映射到同一个 Preset 数据结构。

---

## 13.3 作家风格的内容结构

在现有字段内承载：

### `system_prompt`

核心文学原则、叙述者定位、最高优先级风格约束。

### `writing_style`

详细文学规则，例如：

```text
叙事视角
叙述者人格
词汇年代感
句式结构
段落节奏
外貌描写
环境描写
动作描写
心理描写
对白规律
角色声音
悬念
伏笔
冲突
章节起笔
章节收尾
幽默
恐怖 / 紧张
感官与意象
```

### `extra_instructions`

补充执行规则与“避免事项”，例如：

```text
避免现代网络腔
避免总结式收尾
避免每段都作价值判断
避免机械比喻
避免把风格规则显式说出来
```

---

## 13.4 作家风格内容应该足够丰富

不能把作家风格简化成：

```text
多短句
多悬念
口语化
```

因为这不足以产生稳定文学相似性。

作家风格资料应成为完整的“文学机制预设”。

---

## 13.5 Catalog 持久化策略

一期优先采用：

```text
App Static Catalog
        ↓ 用户选择/复制
标准 ShineWriter Preset
        ↓
现有 presets 表
```

Catalog 元数据可包含：

```ts
interface PresetCatalogItem {
  id: string;
  category: 'author_style' | 'official';
  name: string;
  description: string;
  tags: string[];
  preset: {
    system_prompt: string;
    writing_style: string;
    extra_instructions: string;
    temperature: number;
    top_p: number;
    max_tokens: number;
  };
}
```

不需要新增数据库表。

---

## 13.6 当前 Preset 协议的边界事实

当前远端导出是：

```text
shinewriter-preset-v1
```

因此一期的安全目标是：

```text
不破坏现有 Preset
+ 增加 Catalog
+ 完善编辑体验
+ 完善内容质量
```

如果需要进一步实现 Tavo / SillyTavern Preset 外部协议导入导出，应先做单独兼容审计：

```text
字段映射
prompt 顺序语义
injection position
role
depth
enabled
marker
sampler
```

在没有证明映射无损之前，不应把其混入本期核心改造。

---

# 14. 资料库 UI 改造

## 14.1 角色 Tab

建议：

```text
角色
├─ 角色合集
└─ 角色档案
```

按钮：

```text
导入角色卡
批量导入角色卡
导入文件夹
新建角色合集
新建角色档案
```

保留导出 CCv3 JSON/PNG 相关能力。

---

## 14.2 世界书 Tab

保留：

```text
世界书合集
条目
合集启用
条目启用
常驻条目
导入
导出
```

但说明文字从纯 Lorebook 技术概念转向小说用户语言：

```text
常驻条目（不需要关键词触发）
```

当前 UI 已经采用这句，方向正确。

本期不删除 `constant` 手工开关，以保持外部 Lorebook 兼容。

---

## 14.3 Preset Tab

加入顶层筛选：

```text
我的预设 | 作家风格 | 官方预设
```

用户从作家风格/官方 Catalog 选择后：

```text
预览
→ 添加到我的预设
→ 生成独立 DB Preset
```

不要让 App 静态资产与用户 DB 项共享可变 ID。

---

# 15. 导入导出兼容原则

## 15.1 Character

必须继续支持：

```text
CCv3 JSON
SillyTavern PNG metadata
已有 ShineWriter 角色 JSON
未知 extensions round-trip
```

新构建角色仍输出：

```text
chara_card_v3
```

---

## 15.2 Worldbook

必须继续支持：

```text
lorebook_v3
普通 entries JSON
角色卡内嵌 character_book
```

外部文件如果显式：

```text
constant=false
```

当前 importer 会在有关键词时保留为非常驻。

该兼容语义一期保留。

ShineWriter 自建世界书默认：

```text
constant=true
```

两者不冲突。

---

## 15.3 Preset

一期：

```text
现有 shinewriter-preset-v1 不破坏
现有 DB preset 不迁移
Catalog item 复制为现有 preset
```

外部 Tavern/Tavo Preset 深度协议适配不作为本期核心验收条件。

---

# 16. 数据库与迁移策略

## 16.1 默认方案：零 Schema 迁移

一期首先按以下方式落地：

### Character

```text
characters.data_json
└─ CCv3
   └─ data.extensions.shinewriter_novel_character_v1
```

### Worldbook

继续使用已有列：

```text
keyword_primary
keyword_secondary
content
comment
constant
...
```

### Preset

继续：

```text
system_prompt
writing_style
extra_instructions
temperature
top_p
max_tokens
```

### Catalog

静态 TypeScript / JSON 资产，不进 SQLite。

---

## 16.2 Schema 迁移阻断条件

只有出现下列不可绕过问题，才允许一期引入 migration：

```text
无法无损保存小说角色结构化数据
无法区分 Catalog 资源和用户资源
现有字段会导致明确数据覆盖/丢失
```

但在当前远端结构下，这三个条件都没有成立。

所以：

> **Agent 不得仅为了“结构看起来更漂亮”新增数据库列。**

---

# 17. 一期明确允许修改的代码范围

最新 Final Seal 之后，代码影响面必须按三层管理。

## P0：允许直接改造的资料 / 构建层

```text
src/screens/BuildScreen.tsx
src/screens/ResourceLibrary.tsx
src/components/CharacterEditor.tsx

src/services/constructionAiGenerator.ts
src/services/construction/targets.ts
src/services/construction/quality.ts
src/services/construction/budget.ts
src/services/constructionFileService.ts

建议新增：
src/services/construction/characterDraftAdapter.ts
src/services/construction/worldbookDraftAdapter.ts

Preset Catalog：
src/services/presets/*
src/assets/presets/*
或符合本地仓现有目录风格的同等职责文件

对应 targeted tests / UI tests
```

原则：

> 改的是“资源怎么创建、怎么编辑、怎么兼容保存”，不是“资源在 Writer 中怎么被选中和注入”。

---

## P1：兼容层，可改但必须保持 round-trip

```text
src/services/fileImport.ts
src/services/exportService.ts
src/types/character.ts
必要的纯数据类型文件
```

允许：

```text
识别 ShineWriter novel character extension
保持未知 extensions
增加 deterministic adapter 的序列化/回读验证
保持 CCv3 / PNG / Lorebook 兼容
```

禁止：

```text
借导入导出修改运行时启用逻辑
导入时重写项目上下文策略
把 external Lorebook 统一改造成新的 activation 模型
```

---

## P2：Repository 默认视为“保护区”

以下文件在一期中**优先不改**：

```text
src/data/repositories/characterRepository.ts
src/data/repositories/worldbookRepository.ts
src/data/repositories/presetRepository.ts
src/types/novel.ts
```

原因：

- `characters.data_json` 已足够承载小说角色扩展；
- Worldbook 已有现成字段；
- Preset 已有现成持久结构；
- Catalog 可通过现有 create/update 路径复制；
- Context Budget V3 刚完成 Final Seal，不应因一期重新扰动资源查询/启用契约。

只有在出现**资料自身无法落库或 round-trip 会丢数据**的可复现问题时，才允许对 Repository 做最小补丁。

即使修改，也不得改变：

```text
项目资源启用关系
合集父开关语义
worldbook constant / activation 运行时规则
Context Builder 的查询结果形态
Pipeline Freeze / Resume 所依赖的资源契约
```

---

## P3：遗留详情页，先确认实际导航

```text
src/screens/CharacterDetail.tsx
src/screens/WorldbookDetail.tsx
src/screens/PresetScreen.tsx
```

如果当前导航未使用：

> 不为“视觉统一”顺手重构。

---

# 18. 一期禁止修改范围

以下列为**强制红线**。

## 18.1 Context 系统

Final Seal 后，下列内容视为**封板区**，禁止语义修改：

```text
src/services/context/resourceContextCandidates.ts
src/services/contextBuilder.ts
Context Budget V3
contextBudgetVersion = 6
hierarchical allocator
elastic allocator
Post-Coverage / Episodic Demand Reclaim
Story State / Sliding / Episodic actual-demand collection
Resources candidate-first rendering
Worldbook activation
context automation policy
Context Preview 运行逻辑与只读可观测契约
ContextConfig 语义
ContextAutoConfig 语义
```

一期不得为了让新 `shinewriter_novel_character_v1` 立即进入正文而修改这些模块。

---

## 18.2 Pipeline

禁止修改：

```text
src/services/pipeline/*
Pipeline task execution
Draft
Review
FactCheck
Brief
Proof
stage prompt contract
stage budget
stage retry
stage resume
stage checkpoint
cold-start Resume persistence
Frozen Snapshot
Pipeline Context Snapshot
Freeze / Resume 契约
```

`85ec313...` 刚修复的 cold-start Resume 持久化属于一期强保护项。

---

## 18.3 Story Memory / Canon / Outline

禁止修改：

```text
Story Memory
Story Memory update cadence
Story Memory extraction
Canon
Continuation SourceReader
Continuation context assembly
Outline workflow
Outline injection
outline generation pipeline
```

---

## 18.4 禁止“顺手接驳”

即使发现：

```text
新角色 extension 没被正文读取
新世界书结构没有特殊优先级
作家 Catalog 没自动绑定 Draft
```

一期正确做法是：

```text
记录二期接驳项
```

而不是：

```text
顺手修改 resourceContextCandidates / pipeline
```

---

# 19. 边界防扩散机制

Agent 实施时必须建立一份变更清单。

开工前记录：

```text
BASELINE_HEAD = 36b353ba3014cd2e99ee8e87c826480b2130bb22
PRODUCTION_BASELINE = 85ec31355b88f6caa6df49f48ea7a0dc966b860a
```

如果本地 `origin/main` 已继续前进，则以实际最新 `origin/main` 为新基线，并先重做一次增量审计。

提交前执行：

```bash
git diff --name-only <phase1-baseline>...HEAD
```

以下路径默认为 **Forbidden Diff**：

```text
src/services/context/
src/services/contextBuilder.ts
src/services/pipeline/
Story Memory runtime
Canon runtime
continuation context
outline pipeline runtime
ContextConfig
ContextAutoConfig
ContextPreview runtime semantics
```

若出现 Forbidden Diff：

```text
默认结论 = NO-GO
```

只有同时满足以下三点才允许保留：

1. 是纯编译/类型兼容，不改变运行语义；
2. 资料侧无法解决；
3. 有 targeted regression 证明 Final Seal 契约不变。

否则必须回退该 diff。

特别检查：

```text
contextBudgetVersion 仍为 6
Worldbook activation 测试未改期望来迁就新实现
Freeze / Resume 测试未改期望来迁就新实现
Context Preview 只读观测契约未变化
```


---

# 20. 详细实施步骤

## Step 1：建立小说角色中间模型

- 新增 `NovelCharacterDraft`；
- 增加解析器；
- 最小必填只保留 name + 核心人物内容；
- LLM 不再输出 chat 字段。

### Done

```text
characterSystemPrompt 不出现 first_mes 强制要求
不出现 {{char}} / {{user}} 对话要求
不要求 system_prompt
不要求 post_history
```

---

## Step 2：建立角色 CCv3 Adapter

输入：

```text
NovelCharacterDraft
```

输出：

```text
CharaCardV3
```

要求：

- deterministic；
- chat fields 空；
- description 本地编译；
- extension 保存完整结构；
- existing importer readback 通过。

---

## Step 3：改造 CharacterEditor

- 新角色默认小说档案编辑；
- legacy CCv3 字段放入“兼容字段”折叠区；
- 未知 extension 不丢失；
- raw JSON fallback 保留。

---

## Step 4：世界书 Prompt 小说化

移除：

```text
当前主冲突
剧情推进
把 character 当前冲突强制变世界设定
```

增加：

```text
影响范围
持续世界后果
规则边界
稳定关系
```

---

## Step 5：建立 Worldbook Draft + Adapter

LLM 只输出：

```text
name
entries[].title
entries[].category
entries[].keywords
entries[].content
```

本地生成：

```text
constant=true
enabled=true
insertion_order
spec
spec_version
```

---

## Step 6：改造质量模型

Character：

```text
Chatbot field length
→ Novel dimension coverage
```

Worldbook：

```text
纯最小字数
→ 推荐规模 + 内容维度 warning
```

长度目标只做 Soft Warning。

---

## Step 7：调整构建 UI

角色输入改为：

```text
角色名称
题材 / 时代
角色定位
身份 / 背景
核心性格
目标 / 动机
主要矛盾 / 弱点
关键关系
外貌特征（可选）
补充要求
```

移除：

```text
叙事氛围
```

世界书输入改为：

```text
世界书名称
题材 / 时代
核心世界规则
重点覆盖领域
已确定设定
不可违反的规则
补充要求
条目数
丰满度
```

移除或重定义：

```text
叙事用途
```

---

## Step 8：改造构建预览

角色预览不再突出：

```text
开场白
```

改为：

```text
角色定位
身份背景
核心性格
动机
矛盾
关系
人物弧
```

世界书继续按条目展示。

---

## Step 9：增加作家风格 Catalog

- 静态数据；
- 分类展示；
- 预览；
- 一键复制到“我的预设”；
- 复制后是普通 DB Preset；
- 可以继续编辑/删除/导出。

---

## Step 10：兼容回归

确保：

```text
旧角色 JSON
旧角色 PNG
旧 Lorebook
旧 ShineWriter Preset
旧项目
```

全部可正常读取。

---

# 21. 构建 Prompt 设计规范

## 21.1 角色 Prompt

核心目标：

> 生成一份可支撑长篇小说持续塑造的角色档案，而不是聊天机器人设定。

Prompt 应强调：

```text
人物的表面特征必须有形成原因或行为体现
目标必须能转化为行动
弱点必须能产生剧情代价
关系必须体现对不同人物的差异
能力必须有边界
语言习惯应可用于正文对白
人物弧是可能变化方向，而不是预写剧情结果
连续性事实是后续不应随意漂移的锚点
```

---

## 21.2 世界书 Prompt

核心目标：

> 建立一个作者希望全书持续成立的世界知识体系。

Prompt 应强调：

```text
事实优先
规则优先
影响范围
因果关系
世界后果
例外边界
跨设定关系
```

避免：

```text
写作建议
模型指令
“下一章应……”
“为了制造悬念……”
“让主角……”
```

---

## 21.3 作家风格 Prompt / Catalog 编写规范

作家风格不是标签集合。

应该至少覆盖：

```text
叙述视角
叙述者距离
句法
词汇
段落
描写
对白
人物声音
信息揭示
悬念
伏笔
冲突
节奏
章节结构
意象
感官
幽默 / 恐怖 / 抒情机制
禁止项
容易出现的错误仿写
```

如果内置真实作家风格，应以**抽象文学特征描述**为主，不在资源里大段复制受版权保护的原文。

---

# 22. 单元测试矩阵

## 22.1 Character Draft

必须覆盖：

```text
完整角色
最小角色
可选字段为空
aliases 数组
relationships 数组
continuity 数组
中文长文本
特殊字符
未知额外字段
```

断言：

```text
不需要 first_mes
不需要 mes_example
不需要 system_prompt
不需要 post_history
```

---

## 22.2 Character Adapter

断言：

```text
spec = chara_card_v3
spec_version = 3.0
name 正确
description 含主要小说维度
personality 正确
chat fields = empty
extensions.shinewriter_novel_character_v1 完整
parseCharacterCardJSON 回读成功
二次 serialize 不丢 extension
```

---

## 22.3 Legacy Character

测试：

```text
旧 CCv3 JSON
CCv3 PNG
带 alternate_greetings
带 mes_example
带 system_prompt
带 post_history
带未知 extensions
```

断言：

```text
导入不丢
编辑后不丢
导出后不丢
```

---

## 22.4 Worldbook Draft

测试：

```text
2 条
4 条
12 条
中文关键词
别称
无 secondary key
长条目
不同 category
```

断言：

```text
LLM draft 不需要 constant
不需要 insertion_order
```

---

## 22.5 Worldbook Adapter

断言：

```text
Lorebook v3 可回读
所有自建条目 constant=true
enabled=true
顺序稳定
keywords 保留
content 不被截断
```

---

## 22.6 Legacy Lorebook

测试：

```text
constant=true
constant=false
没有 constant
character_book embedded
entries object
entries array
```

断言：

```text
显式 constant=false 的合法外部条目保持 false
默认导入策略不回归
```

---

## 22.7 Quality

断言：

```text
短但有效角色 → 可保存 + warning
缺秘密 → warning
缺人物弧 → warning
无 name → hard fail
空 JSON → hard fail
截断 → hard fail
世界书 content 空 → hard fail
世界书稍短 → warning
```

---

## 22.8 Construction Budget

覆盖：

```text
32K
128K
256K
1M
```

并组合不同：

```text
max_output_tokens
compact/full/deep
2/4/8/12 worldbook entries
```

重点验证：

> 大上下文不会因为旧的“聊天字段最低字数”被错误阻断。

---

# 23. 集成测试矩阵

## 23.1 独立角色档案

```text
填写表单
→ 生成
→ 预览
→ 查看 JSON
→ 导入资料库
→ 打开角色档案
→ 编辑
→ 导出
→ 再导入
```

必须全链路成功。

---

## 23.2 世界书 → 角色

```text
导入 Lorebook
→ 构建角色
→ 角色应体现世界规则
→ 不应把 lorebook 全文复制进 description
```

---

## 23.3 角色 → 世界书

```text
导入旧 CCv3
→ 构建世界书
→ 生成地点/组织/制度/稳定世界关系
→ 不得把 first_mes / user 对话转成世界事实
```

---

## 23.4 TXT → 角色 / 世界书

测试：

```text
UTF-8
GBK / GB18030
多章节
片段勾选
超大 TXT
```

确保现有文本解码与片段选择不回归。

---

## 23.5 作家风格 Catalog

```text
打开预设
→ 作家风格
→ 预览
→ 添加到我的预设
→ 编辑
→ 删除
→ 导出
```

并测试重复添加策略：

推荐：

```text
允许复制
但名称自动避免覆盖
```

不要静默修改已有用户预设。

---

# 23.6 Final Seal 契约非回归测试

这是本次更新后新增的强制测试层。

一期虽然不接驳 Context/Pipeline，但必须证明没有破坏刚封板的 V3 行为。

要求：

```text
原 Context Budget V3 targeted suites 原样 PASS
原 resource candidate suites 原样 PASS
原 Worldbook activation suites 原样 PASS
原 Preview observability suites 原样 PASS
原 Pipeline Freeze / Resume suites 原样 PASS
原 cold-start Resume persistence suites 原样 PASS
```

禁止通过以下方式“修绿”：

```text
修改旧测试期望以适配一期的新运行时行为
提高 budget 掩盖资源膨胀
把失败测试 skip
降低断言
重新定义 contextBudgetVersion
```

如果一期代码完全不涉及这些模块，最理想结果就是：

> **生产代码零 diff + 原测试零语义调整 + 全量回归继续通过。**

---

# 24. Android 模拟器 E2E

一期至少覆盖以下真实 UI：

### 角色

```text
资料 → 角色
合集列表
打开合集
新建角色档案
编辑角色档案
导入 CCv3 JSON
导入 PNG
导出
项目启用开关
```

### 世界书

```text
资料 → 世界书
新建合集
新建条目
常驻开关
启用合集
导入 Lorebook
导出 Lorebook
```

### 预设

```text
资料 → 预设
我的预设
作家风格
官方预设
复制到我的预设
编辑
```

### 构建

```text
独立角色
独立世界书
世界书→角色
角色→世界书
TXT→角色
TXT→世界书
紧凑/丰满/深度
取消生成
401 错误
JSON 异常
保存到手机
导入资料库
```

---

# 25. 覆盖安装与数据保留测试

即使一期设计为零 Schema 迁移，也必须做覆盖安装。

准备旧版 APK 中的数据：

```text
多个角色合集
旧 CCv3 卡
PNG 卡
带 chat 字段卡
多个世界书
constant=false 外部世界书
自建 constant=true 世界书
多个用户预设
默认预设
项目资源启用/停用状态
```

然后：

```text
安装一期新 APK 覆盖旧 APK
```

验收：

```text
角色不丢
图片不丢
扩展字段不丢
世界书不丢
constant 不异常
合集开关不异常
预设不丢
默认预设不异常
项目绑定不丢
章节/大纲/Story Memory 不受影响
```

---

# 26. 下游“不变性”回归测试

虽然一期不修改 Context/Pipeline，但必须验证没有被误伤。

最少做 smoke：

```text
打开已有项目
打开上下文预览
运行一章既有流水线
完成 Draft
完成 Review
完成 FactCheck
完成 Brief
完成 Proof
```

目的不是验证新资料已经正确接驳，而是验证：

> **一期没有改变现有下游行为，也没有破坏 `contextBudgetVersion=6`、Worldbook activation、Preview、Freeze / Resume 与 cold-start Resume 的 Final Seal 契约。**

如果新资料的新增结构当前没有被 Writer 完整利用，这是预期的二期缺口，不属于一期失败。

---

# 27. 发版门禁

代码完成后执行：

```bash
npm run lint
npm run typecheck
npm run verify:version
npm run test:ci
npm run apk:debug
```

发布候选再执行：

```bash
npm run apk:release
```

如果仓库当前 release 流程另有既定命令，以本地仓最新脚本为准。

---

# 28. 一期验收标准

## GO 条件

### 资源定义

- [ ] 新建角色语义已从聊天机器人转为小说角色档案
- [ ] 世界书明确为持续世界认知
- [ ] Preset 形成“我的预设 / 作家风格 / 官方预设”资料架构

### 构建

- [ ] 角色 LLM 不再生成 chat 专属字段
- [ ] 角色使用小说中间模型
- [ ] 世界书 LLM 不再负责协议元数据
- [ ] 世界书不再默认要求“当前主冲突”
- [ ] Soft Target 已替代过度主观硬门禁
- [ ] 1M 模型下可生成丰富资料

### 兼容

- [ ] CCv3 JSON 导入/导出不回归
- [ ] PNG 角色卡不回归
- [ ] Lorebook v3 导入/导出不回归
- [ ] 外部 `constant=false` 兼容不回归
- [ ] 用户已有 Preset 不回归
- [ ] 未知角色扩展字段不丢失

### 数据

- [ ] 优先零 Schema 迁移
- [ ] 覆盖安装资料不丢
- [ ] 项目资源启用关系不丢

### 边界

- [ ] Context Budget V3 未发生语义修改
- [ ] `contextBudgetVersion` 仍为 6
- [ ] Resources candidate-first rendering 未修改
- [ ] Worldbook activation 未修改
- [ ] Context Preview Final Seal 契约未修改
- [ ] Pipeline Freeze / Resume 未修改
- [ ] cold-start Resume 持久化未修改
- [ ] Story Memory 未修改
- [ ] Canon 未修改
- [ ] Outline 运行逻辑未修改

### 工程

- [ ] lint pass
- [ ] typecheck pass
- [ ] test:ci pass
- [ ] verify:version pass
- [ ] debug APK pass
- [ ] Android E2E pass

### PDCA 交付门禁

- [ ] 首轮开发/测试完成后已重新逐条审计本方案
- [ ] 至少执行了一次独立“验收者视角”代码复审
- [ ] 每个发现的问题都已完成修复 + 回归，而不是只登记
- [ ] 所有 PDCA 轮次剩余一期 NO-GO = 0
- [ ] 最终验收矩阵中所有一期 Must / P0 / GO 项 = GO
- [ ] 只剩方案明确划归二期的接驳事项

---

# 29. NO-GO 条件

任一成立均不得发版：

```text
旧 CCv3 导入丢字段
旧 PNG 无法读取
旧 Lorebook 导入损坏
世界书常驻行为被一期意外改变
用户原有角色/世界书/预设丢失
覆盖安装数据异常
角色构建仍依赖 first_mes / mes_example 等字段
Adapter 会覆盖未知 extension
作家 Catalog 会静默覆盖用户预设
为了接驳新资料修改了 Context V3 / Pipeline
修改 `contextBudgetVersion`
改变 Worldbook activation
改变 Freeze / Resume 或 cold-start Resume
为让一期测试通过而改写 Final Seal 旧测试期望
首轮结束后未进行独立方案/代码复审
仍有一期范围内未完成项却以“后续优化”名义交付
PDCA 复审发现问题后没有继续修复与回归
需要用户再次确认才继续推进一期剩余工作
```

---

# 30. 二期明确预留但本期不做

一期完成后，另立：

> 《ShineWriter 小说资料资源上下文接驳与流水线注入优化方案》

二期再统一解决：

```text
NovelCharacterDraft extension
           ↓
角色上下文渲染

Worldbook
           ↓
持续认知 / 相关性 / 注入浓度 / Token 预算

Preset
           ↓
Draft / Review / FactCheck / Proof 绑定策略

全部资料
           ↓
Context Budget V3
           ↓
Frozen Snapshot
           ↓
Pipeline
```

二期重点问题包括：

1. 角色档案哪些字段进入正文；
2. 旧 CCv3 `system_prompt` 是否退出小说 Writer；
3. 世界书在超大规模时如何保持持续认知又避免注意力稀释；
4. 1M / 128K / 32K 模型如何弹性分配；
5. 作家风格在 Draft / Proof 的权重；
6. Review / FactCheck 是否保持风格中立；
7. Preview 如何解释真实注入资源；
8. Worldbook / Story Memory / Canon 冲突优先级；
9. Frozen Snapshot 怎样冻结资料版本。

一期不得提前实施这些内容。

---

# 31. 实施优先级建议

## P0

```text
NovelCharacterDraft
Character Adapter
Character construction prompt
Character quality
CharacterEditor 小说化

NovelWorldbookDraft
Worldbook Adapter
Worldbook construction prompt
Worldbook quality

BuildScreen 表单/预览
legacy import/export regression
```

## P1

```text
Preset Catalog
作家风格资源
官方预设资源
Preset UI 分类
```

## P2

```text
详情页视觉统一
TXT 整理/补完模式
更多 Catalog 筛选
资源说明优化
```

P2 不得阻塞一期核心交付。

---

# 31.5 强制 PDCA 自主闭环机制

本节是一期的**最高执行规则之一**。

## 31.5.1 为什么必须二次复审

首轮开发过程中，Agent 容易出现以下典型偏差：

```text
实现时只关注局部文件
测试围绕自己的实现编写
把“测试通过”误认为“方案兑现”
忽略原有兼容链路
遗漏边界红线
没有再次核对远端/本地最新代码
没有重新检查实际 UI 与真实 Android 行为
```

因此首轮结束后，必须切换身份：

> 从“实现者”切换为“独立验收者”。

第二轮检查不得直接沿用首轮“我已经做完”的假设。

---

## 31.5.2 每一轮 PDCA 的固定流程

### P — Plan / 重新对照方案

每一轮开始，Agent 必须重新读取本方案，并生成内部验收矩阵，至少覆盖：

```text
角色档案目标
世界书目标
Preset / 作家风格目标
构建中间模型
Adapter
兼容导入导出
质量 Hard / Soft Gate
UI 改造
数据保留
零 Schema 迁移原则
Forbidden Diff
Final Seal 非回归
Android E2E
覆盖安装
GO / NO-GO
二期边界
```

不能只根据上一轮 TODO 继续做。

---

### D — Do / 修复与测试

对本轮发现的所有未兑现项：

```text
定位真实代码原因
做最小边界修复
补 targeted test
执行相关集成测试
执行真实 Android 流程
```

禁止为“快速变绿”：

```text
降低断言
跳过测试
扩大 Mock
放宽 Hard Gate
修改 Final Seal 旧测试期望
绕开真实 UI / Repository
```

---

### C — Check / 独立验收

完成本轮修复后，Agent 必须重新审查：

#### 代码

```text
git diff
新增文件
删除文件
关键函数调用链
实际持久化结构
实际导入导出结构
UI 实际调用路径
未使用/遗留页面
```

#### 方案兑现

逐条回答：

```text
已实现？
部分实现？
未实现？
不适用？
有证据？
```

任何“部分实现”都不能算 GO。

#### 测试证据

重新确认：

```text
targeted tests
lint
typecheck
test:ci
verify
APK
Android E2E
legacy compatibility
覆盖安装
Final Seal 原测试
```

#### 边界

重新执行：

```bash
git diff --name-only <phase1-baseline>...HEAD
```

并检查 Forbidden Diff。

---

### A — Act / 自动进入下一轮

只要出现以下任一情况：

```text
某一方案目标未完整兑现
某一 GO 条件缺证据
某个测试失败
某个兼容路径未测
Android E2E 未闭环
覆盖安装未验证
存在 Forbidden Diff 未解释
出现新回归
代码审查发现设计偏差
Hard / Soft Gate 与方案不一致
```

Agent 必须：

```text
自动建立下一轮修复清单
继续修复
继续测试
再次 CHECK
```

**不得向用户请求“是否继续”。**

---

## 31.5.3 PDCA 终止条件

只有当以下结果同时成立，PDCA 才允许停止：

```text
方案所有 Must / P0 / GO 条件 = GO
所有 Hard Gate 测试 = PASS
所有兼容测试 = PASS
Final Seal 非回归 = PASS
Android E2E = PASS
覆盖安装数据保留 = PASS
Forbidden Diff = 0 或全部有合规证明
无未处理 P0/P1 缺陷
无“待确认是否修复”项
无“建议后续再做”但实际属于一期范围的遗漏项
```

允许留下的只能是：

> 本方案已经明确归属二期、且不影响一期 GO 的事项。

---

## 31.5.4 至少执行两次视角不同的审查

即使首轮全部测试一次通过，也必须至少完成：

```text
第 1 轮：
实现者视角
开发 + 测试

第 2 轮：
验收者视角
从方案重新审计代码 + 重新核验证据
```

如果第 2 轮发现问题：

```text
进入第 3 轮
修复 + 验收
```

后续不限轮次，直到全 GO。

因此：

> **PDCA 的循环次数由实际质量决定，不设人为上限。**

---

## 31.5.5 Agent 不得提前退出的典型理由

以下都不是合法终止理由：

```text
“主要功能已经完成”
“剩下只是小问题”
“测试基本通过”
“应该没问题”
“受时间限制先交付”
“建议后续优化”
“需要用户确认后再继续”
```

只要属于一期范围，Agent 必须自主推进到 GO。

---

## 31.5.6 每轮必须留下审计记录

每轮至少记录：

```text
PDCA Round
发现的问题
根因
修改文件
新增/修改测试
测试结果
边界审计
剩余 NO-GO
下一轮动作
```

最终交付报告中要包含精简后的 PDCA 历史，例如：

```text
Round 1
发现 6 项 → 修复 6 项

Round 2
独立复审发现 2 项 → 修复 2 项

Round 3
全量复审
0 个一期缺口
GO
```

目的不是堆报告，而是证明：

> 最终 GO 是经过重复验证得到的，不是首轮自评。

---

# 32. Agent 实施规则

Agent 开工时：

1. **以本地仓当前代码为唯一实施基准。**
2. 方案更新时远端锚点为 `36b353ba3014cd2e99ee8e87c826480b2130bb22`；生产代码锚点为 `85ec31355b88f6caa6df49f48ea7a0dc966b860a`。
3. 开工第一步必须 `fetch --all --prune` 并核对本地 / `origin/main`；若远端继续前进，先做增量审计再实施。
4. 如果本地代码已经领先本文锚点：
   - 先理解新增提交；
   - 不回退已有修复；
   - 将本文映射到最新本地结构。
5. 修复前必须证明问题存在。
6. 禁止重构无关模块。
7. 优先零 Schema 迁移。
8. 优先确定性本地 Adapter。
9. 不增加付费 LLM repair loop。
10. 内容质量使用 soft warning。
11. 技术/结构失败使用 hard gate。
12. 一期禁止接驳 Context/Pipeline。
13. `contextBudgetVersion=6` 和 Final Seal 行为视为只读依赖。
14. 每完成一个资源域，先做 targeted tests，再进入下一个域。
15. 首轮实现与测试完成后，**不得交付**，必须进入 PDCA `CHECK`。
16. `CHECK` 必须重新从本方案开始逐条审计实际代码、测试和边界，而不是复述首轮完成情况。
17. 发现任何一期缺口后必须自动进入下一轮 `ACT → PLAN → DO → CHECK`，不得询问用户是否继续。
18. PDCA 不设固定轮数，直到全部一期 GO 条件成立。
19. 即使首轮一次全绿，也必须至少执行一次独立的第二视角代码/方案复审。

---

# 33. 推荐提交拆分

建议至少拆成：

```text
1. feat(resources): add novel character draft and compatibility adapter
2. feat(resources): novelize character library editor
3. feat(build): novelize character construction and quality model
4. feat(build): add novel worldbook draft and adapter
5. feat(build): refine persistent worldbook construction semantics
6. feat(presets): add preset catalog and author-style resources
7. test(resources): add compatibility and data-preservation regression
8. test(android): close phase-1 resource/build e2e
```

不要把 Context / Pipeline 修改混进任何一个 commit。

---

# 34. 一期最终设计结论

一期的核心不是：

> “把 Tavern 字段改几个名字。”

而是完成一次职责收束：

```text
过去：
兼容协议
决定内部资源长什么样

一期后：
小说创作语义
决定内部资料要表达什么

兼容协议
只负责如何保存和交换
```

最终结构：

```text
                 ShineWriter 资料资产层

        ┌────────────┬─────────────┬────────────┐
        │            │             │            │
   角色档案        世界书          Preset
      WHO           WORLD           HOW
        │            │             │
 Novel Character  Persistent     My / Author /
     Draft        World Facts     Official
        │            │             │
        └────── deterministic adapters ──────┐
                                              ↓
                            当前数据库 + 兼容导入导出

────────────────── 一期边界，到此为止 ──────────────────

                         二期再接：
              Context Budget / Pipeline / Writer
```

一期的验收关键词只有三个：

> **资料更像小说资料、构建更像小说构建、下游一律不动。**

---

# 35. 本次更新相对上一版的关键修订

| 项目 | 上一版 | 2026-08-13 更新版 |
|---|---|---|
| 远端基线 | `faccaf42...` | HEAD `36b353b...` / 生产代码 `85ec313...` |
| Schema | 未在首页锁定 | `51` |
| Context 契约 | 泛指 V3 | 明确 `contextBudgetVersion=6` |
| Context 边界 | 禁止修改 | 升级为 Final Seal **封板区** |
| Repository | P0 可改 | 默认保护，优先零修改 |
| Worldbook | 保留常驻 | 保留资料常驻，同时明确不得改 runtime activation |
| Preview | 普通禁改项 | 明确保护最新只读可观测契约 |
| Resume | 普通 Pipeline 禁改 | 明确保护最新 cold-start Resume 修复 |
| 回归 | 下游 smoke | 增加强制 Final Seal 原测试原样回归 |
| Diff 门禁 | 需解释 | Forbidden Diff 默认 NO-GO |
| 交付机制 | 首轮完成后验收 | 强制自主 PDCA 循环，直到一期全 GO |

本次修订没有改变一期产品目标，只是根据最新远端封板状态进一步缩小可动范围。

---

# 附录 A：当前远端关键代码锚点

方案本次更新时的远端锚点：

```text
main HEAD
36b353ba3014cd2e99ee8e87c826480b2130bb22

production code baseline
85ec31355b88f6caa6df49f48ea7a0dc966b860a
fix: finalize context budget v3 closure

version
2.11.49

database schema
51

contextBudgetVersion
6

src/screens/ResourceLibrary.tsx
src/screens/BuildScreen.tsx
src/components/CharacterEditor.tsx

src/services/constructionAiGenerator.ts
src/services/construction/targets.ts
src/services/construction/quality.ts
src/services/construction/budget.ts
src/services/constructionFileService.ts

src/services/fileImport.ts
src/services/exportService.ts

src/data/repositories/characterRepository.ts
src/data/repositories/worldbookRepository.ts
src/data/repositories/presetRepository.ts

src/types/character.ts
src/types/novel.ts
package.json
```

---

# 附录 B：外部兼容参考

Tavo 文档参考：

```text
世界书：
https://docs.tavoai.dev/cn/guides/lore-book/

自建角色：
https://docs.tavoai.dev/cn/guides/bots/create/

预设：
https://docs.tavoai.dev/cn/guides/preset/
```

这些协议继续作为兼容生态参考，但 ShineWriter 的内部产品语义以“长篇小说创作”优先。

---

# 附录 C：给本地 Agent 的简短自主执行提示词

```text
以本地仓当前代码为唯一实施基准，完整阅读《ShineWriter_资料库与构建库小说化改造一期方案_20260813更新版.md》后自主完成一期改造与穿测，不逐项向我确认。

开工第一步先执行 fetch --all --prune，确认本地 HEAD、origin/main 与工作区状态。本文更新时远端 main HEAD 为 36b353ba3014cd2e99ee8e87c826480b2130bb22，生产代码封板基线为 85ec31355b88f6caa6df49f48ea7a0dc966b860a（fix: finalize context budget v3 closure），当前版本 V2.11.49、Schema 51、contextBudgetVersion=6。若 origin/main 已继续前进，先审计新增提交并把方案映射到最新代码，禁止回退后续修复。

本期边界必须锁死：只改资料库和构建库的“资源资产定义、构建生成、编辑展示、兼容导入导出”。禁止修改弹性上下文、Context Budget V3、resourceContextCandidates、contextBuilder、Resources candidate-first rendering、Worldbook activation、Context Preview 运行语义、Pipeline、Draft/Review/FactCheck/Brief/Proof 协议、Frozen Snapshot、Freeze/Resume、cold-start Resume、Story Memory、Canon、Outline 运行逻辑。发现新资料暂时不能被正文充分消费，记录为二期问题，不得顺手接驳。Final Seal 区默认 Forbidden Diff；若出现必须按方案做边界审计，不能通过修改旧测试期望来迁就新行为。

核心目标：
1. 角色从 Tavern 聊天角色卡改为小说角色档案；LLM 不再生成 first_mes、mes_example、system_prompt、post_history_instructions、alternate_greetings；使用 NovelCharacterDraft + 本地 deterministic Adapter 继续输出 CCv3，并保留旧 JSON/PNG 卡和未知 extensions 的无损 round-trip。完整结构优先写入 extensions.shinewriter_novel_character_v1。
2. 世界书继续维持 ShineWriter 自建默认常驻的资料定义；不修改已封板的运行时 Worldbook activation。LLM 只生成小说世界事实，不负责 constant/enabled/order/spec 等协议元数据；本地 Adapter 输出 Lorebook v3；外部显式 constant=false 继续按现有导入规则保留；移除“当前主冲突/剧情推进”等 Story Memory/Outline 职责。
3. Preset 不新建 AuthorStyleProfile；在现有 Preset 资源上建设“我的预设 / 作家风格 / 官方预设” Catalog。优先静态 Catalog→复制为现有 DB Preset，不做无必要 Schema 迁移，不引入与既有 Preset 平行的新协议模型。
4. 按“富资料、轻协议、暂不接驳”执行。主力模型支持大上下文，角色、世界书、作家风格采用充分的 Soft Target；禁止用主观字数硬门禁丢弃有效产物。
5. Repository 默认保护：characterRepository/worldbookRepository/presetRepository 优先不改。现有 data_json、worldbook 字段和 preset 字段足以一期落地；只有可复现的数据无法落库/round-trip 丢失问题才允许最小修改，且不得改变项目资源启用、合集父开关、Worldbook activation 或 Context V3 查询契约。
6. 以零 Schema 迁移为优先；发现方案与本地代码冲突时，以本地代码和测试事实为准做最小必要调整，禁止重构无关模块。

执行方式必须采用自主 PDCA 闭环：
- 首轮完成改造与测试后禁止直接交付；
- 重新从方案第一页开始，以“独立验收者”视角审计实际代码、UI、持久化、导入导出、测试和边界；
- 对所有未兑现项自动进入下一轮修复和穿测；
- 每轮结束继续重新审计；
- 不得询问我“是否继续”，不得因为主要功能完成或测试基本通过而提前退出；
- PDCA 不设轮数上限，只有所有一期方案目标和 GO 条件全部为 GO 才能结束；
- 即使首轮一次全绿，也至少执行一次独立的第二视角复审。

完成每轮后执行：
- 角色 / 世界书 / Preset / Build targeted tests
- legacy CCv3 JSON/PNG/Lorebook/旧 Preset round-trip
- Context Budget V3 / Worldbook activation / Preview / Freeze-Resume / cold-start Resume 原测试原样回归
- npm run lint
- npm run typecheck
- npm run verify:version
- npm run test:ci
- npm run verify
- debug APK
- release candidate APK（按仓库当前正式门禁）
- Android 模拟器完成角色/世界书/预设/构建全链路 E2E
- 覆盖安装数据保留测试

最终输出：
1. 远端/本地基线
2. 变更文件清单
3. Forbidden Diff 审计
4. targeted / full test 证据
5. Android E2E 证据
6. 覆盖安装数据保留证据
7. PDCA 各轮发现项 / 修复项 / 剩余项摘要
8. 最终方案兑现矩阵（每项必须是 GO / 二期，不允许模糊状态）
9. 最终 GO / NO-GO
10. 二期未接驳事项

最终交付前必须确认：
“PDCA 最后一轮一期剩余 NO-GO = 0”。

任何 Context/Pipeline/Story Memory/Canon/Outline 运行语义变化，默认直接判一期 NO-GO。
任何一期范围内仍有未完成项，也不得交付。
```
