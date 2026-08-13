# ShineWriter 资料库与构建库小说化改造一期 —— 工程收尾 PDCA 方案
## （含一期漏项：预设构建补齐）

> 文档版本：2026-08-13  
> 适用仓库：`anjingdtl/tavo-mini`  
> 文档性质：**一期工程收尾 / Final Seal 执行方案**  
> 上位方案：`ShineWriter_资料库与构建库小说化改造一期方案_20260813_PDCA更新版`  
> 本文新增纠偏：**“预设构建”正式纳入一期 P0 / Must，与角色卡构建、世界书构建平级。**  
> 当前结论：**一期主体架构基本完成，但尚未满足 Final Seal GO 条件，必须继续 PDCA，直到一期剩余 NO-GO = 0。**

---

# 0. 文档目标与最高执行规则

本文件不是重新设计第一期，也不是扩大到二期。

本文件负责：

1. 接管一期主体开发完成后的工程收尾；
2. 关闭当前验收发现的全部 NO-GO；
3. **补齐一期方案遗漏的“预设构建”主链；**
4. 补齐真实 Android E2E、覆盖安装和设备数据库证据；
5. 再次从独立验收者视角核对一期方案；
6. 在不突破一期边界的前提下，把当前实现推进到正式 GO。

一期收尾的最高规则仍然是：

> **资料更像小说资料、构建更像小说构建、下游一律不动。**

并追加本次收尾专用规则：

> **任何为了“修绿”或“顺手接通新资料”而修改 Context Budget V3、Context Builder、Worldbook activation、Pipeline、Freeze / Resume、cold-start Resume、Story Memory、Canon、Outline 运行语义的做法，都不是一期收尾，而是新的越界修改，默认直接判一期 NO-GO。**

Agent 不得因为：

- 主体功能已经完成；
- 只剩少量测试；
- APK 已经能编译；
- 问题看起来像 flaky；
- Android 流程需要额外操作；
- “预设构建”可以以后再做；
- 剩余问题“可以后续优化”；

而提前停止。

**只有一期全部 Must / P0 / GO 项都有证据，且最终剩余 NO-GO = 0，才能结束。**

---

# 1. 本次对一期范围的正式纠偏

原一期方案已经明确：

```text
资料库：
角色
世界书
预设
```

并明确：

```text
构建模块负责生成适用于长篇小说创作的
角色、世界设定、作家风格资料
```

但实际工程步骤与 E2E 清单只完整列出了：

```text
角色卡构建
世界书构建
```

遗漏了：

```text
预设构建
```

这是一期方案的工程漏项，不属于二期功能扩张。

因此本文件正式修正一期构建目标：

```text
构建
├─ 角色卡
├─ 世界书
└─ 预设
```

三者必须平级。

最终 Build 页不能再只有：

```text
IndependentTarget = 'character' | 'worldbook'
```

而必须形成等价的三目标模型：

```text
ConstructionTarget
= 'character'
| 'worldbook'
| 'preset'
```

一期 Final Seal 从本文起按三类构建产物验收。

---

# 2. 当前远端基线

## 2.1 仓库

```text
repository:
anjingdtl/tavo-mini
```

截至本文件编写时，当前远端一期主体提交：

```text
e3fff905fc80d70ea4abab16a03bb9aae25d5118
feat: 资料库与构建库小说化改造一期
```

一期前封板基线：

```text
772f81ac8717904bd628656e2a551745789831c4
release: v2.11.50 context budget v3 seal
```

更早 Context Final Seal 生产基线：

```text
85ec31355b88f6caa6df49f48ea7a0dc966b860a
fix: preserve frozen pipeline snapshot on cold-start resume
```

当前版本：

```text
V2.11.50
versionCode = 2115000
database schema = 51
contextBudgetVersion = 6
```

---

## 2.2 当前构建代码事实

当前 `BuildScreen.tsx` 的目标仍是：

```text
type IndependentTarget = 'character' | 'worldbook'
```

当前 `src/services/construction/targets.ts`：

```text
export type ConstructionTarget =
  | 'character'
  | 'worldbook'
```

当前模式主要是：

```text
character_independent
character_from_worldbook
worldbook_independent
worldbook_from_character
character_from_text
worldbook_from_text
```

即：

> **一期主体提交已经完成角色 / 世界书小说化构建，但尚未有真正的 Preset Build Target。**

因此“预设构建”是本次收尾必须补齐的明确工程项。

---

# 3. 当前 GitHub Actions 状态

当前一期提交对应：

```text
Verify Run:
31660054140
```

结果：

```text
Migration matrix
PASS

Android Debug build
PASS

JavaScript validation
FAIL
```

JavaScript validation 内：

```text
verify:version
PASS

lint
PASS
0 errors
198 warnings

typecheck
PASS

test:ci
FAIL
```

Jest 汇总：

```text
Test Suites:
384 passed
3 skipped
1 failed

Tests:
3144 passed
8 skipped
1 failed
```

唯一失败：

```text
__tests__/cl06HardBudgetGate.test.ts

CL-06:
真实硬门禁 used + upcoming <= cap

失败用例：
attempt 失败后 used_llm_calls 实时反映（不等 Adoption）

Expected:
checkedUsage = true

Received:
checkedUsage = false
```

CI 日志中同时存在覆盖安装证据缺口：

```text
repaired_device.db not found
— run the emulator overwrite-install test first
```

虽然对应 test suite 返回 PASS，但该日志明确说明：

> **当前 CI 没有真正拿到覆盖安装后的设备数据库进行断言。**

因此不能把这个 PASS 当成覆盖安装已经完成。

---

# 4. 已经确认可继承的 GO 架构

本轮收尾不得推翻已经正确实现的主体架构。

---

## 4.1 角色

已形成：

```text
NovelCharacterDraft
      ↓
deterministic local Adapter
      ↓
CCv3 compatibility envelope
```

继续要求：

```text
first_mes = empty
mes_example = empty
system_prompt = empty
post_history_instructions = empty
alternate_greetings = []
```

小说完整结构继续保存在：

```text
extensions.shinewriter_novel_character_v1
```

旧 CCv3 JSON / PNG / 未知 extensions 继续兼容。

---

## 4.2 世界书

已形成：

```text
NovelWorldbookDraft
      ↓
deterministic local Adapter
      ↓
Lorebook v3
```

LLM 继续只负责：

```text
title
category
keywords
content
```

不得让 LLM 负责：

```text
constant
enabled
insertion_order
spec
spec_version
runtime activation
```

ShineWriter 自建世界书继续默认常驻。

外部显式：

```text
constant=false
```

必须继续保留，不得覆盖成 true。

---

## 4.3 Preset 资料库

继续使用现有 Preset Schema：

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

现有导出格式继续：

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

继续坚持资料库三层：

```text
预设
├─ 我的预设
├─ 作家风格
└─ 官方预设
```

以及：

```text
Static Catalog
      ↓
复制
      ↓
现有 DB Preset
```

不新建：

```text
AuthorStyleProfile
StyleProfile V3
第二套 Preset DB
第二套 Prompt 协议
```

---

## 4.4 Quality

继续坚持：

```text
技术 / 结构错误
→ Hard Gate

内容丰满度不足
→ Soft Warning
```

禁止恢复“字数不足直接丢弃有效产物”的旧行为。

---

# 5. 本次收尾 NO-GO 清单

本轮拆为 6 个 closure workstream。

| ID | 项目 | 当前状态 | Final Seal 要求 |
|---|---|---:|---|
| NG-01 | CL-06 / `test:ci` 红 | NO-GO | 全量 CI PASS |
| NG-02 | **预设构建主链缺失** | NO-GO | Build 三类目标平级且可真实使用 |
| NG-03 | 作家风格 Catalog 内容资产不完整 | NO-GO | 达到原方案文学机制预设要求 |
| NG-04 | Android 一期真实 UI E2E 缺证据 | NO-GO | 三类资料 + 三类构建全链路 PASS |
| NG-05 | 覆盖安装数据保留缺证据 | NO-GO | 旧数据覆盖升级后完整保留 |
| NG-06 | 独立第二视角 PDCA / Final Seal 证据链缺失 | NO-GO | 最终矩阵全部 GO |

最终必须：

```text
NG-01 = CLOSED
NG-02 = CLOSED
NG-03 = CLOSED
NG-04 = CLOSED
NG-05 = CLOSED
NG-06 = CLOSED

一期剩余 NO-GO = 0
```

---

# 6. 本次收尾 Forbidden Diff

收尾阶段的可修改范围必须比首轮开发更窄。

原则上允许：

```text
src/services/construction/**
src/services/constructionAiGenerator.ts
src/services/constructionFileService.ts
src/services/presets/**
src/screens/BuildScreen.tsx
src/screens/ResourceLibrary.tsx
src/components/CharacterEditor.tsx

一期直接相关 tests
QA scripts
QA evidence docs
```

Repository：

```text
characterRepository
worldbookRepository
presetRepository
```

继续默认保护。

只有出现真实、可复现的落库 / round-trip 问题时，才允许最小修改。

---

## 6.1 默认禁止修改的区域

以下默认视为 Final Seal 封板区：

```text
src/services/context/**
contextBuilder*
resourceContextCandidates*
Resources candidate-first rendering

Worldbook runtime activation

Context Preview runtime semantics

src/services/pipeline/**
Draft / Review / FactCheck / Brief / Proof protocols

Frozen Snapshot
Freeze / Resume
cold-start Resume

Story Memory
Canon
Outline runtime logic
```

同时锁定：

```text
contextBudgetVersion = 6
database schema = 51
```

---

# 7. 预设构建的正式一期定义

这是本文件最重要的补漏项。

目标：

> **让用户可以像构建角色卡、构建世界书一样，在“构建”里直接生成一个可长期复用的小说写作 Preset。**

它不是：

```text
Pipeline Prompt Builder
Context Builder
Stage Prompt Builder
Story Memory Prompt
Author Style Runtime Engine
```

它只是：

```text
用户需求 / TXT 写作样本
      ↓
文学机制抽象
      ↓
Preset 构建产物
      ↓
shinewriter-preset-v1
      ↓
保存 / 导入资料库 / 编辑 / 导出
```

---

# 8. 预设构建技术原则

## 8.1 不新建持久化协议

预设构建必须直接复用现有：

```text
Preset
shinewriter-preset-v1
presetRepository
资料 → 预设 → 我的预设
```

不得新增：

```text
construction_preset 表
author_style 表
preset_v2 表
style_runtime_json
```

---

## 8.2 LLM 只生成文学语义

LLM 只负责生成：

```text
name
system_prompt
writing_style
extra_instructions
```

不让 LLM 负责：

```text
spec
is_default
temperature
top_p
max_tokens
数据库 id
project binding
created_at
updated_at
```

这些由本地代码确定。

原则：

```text
LLM
→ 写“怎么写小说”

local deterministic Adapter
→ 写“怎么保存成 ShineWriter Preset”
```

---

## 8.3 推荐构建中间对象

可在 construction 层增加轻量 DTO，例如：

```ts
interface NovelPresetDraft {
  name: string;
  system_prompt: string;
  writing_style: string;
  extra_instructions: string;
}
```

注意：

> 这是**构建层临时 DTO**，不是新的持久化 Preset Schema。

本地 Adapter 输出：

```text
shinewriter-preset-v1
```

并补：

```text
is_default = false
temperature = 现有 Preset 默认值
top_p = 现有 Preset 默认值
max_tokens = 现有 Preset 默认值
```

具体数值优先复用仓库已有默认常量 / 编辑器默认值。

禁止复制一套新的默认配置常量造成漂移。

---

# 9. 预设构建模式

一期必须支持：

```text
独立构建 → 预设
TXT → 预设
```

即新增至少：

```text
preset_independent
preset_from_text
```

相应：

```text
ConstructionTarget
+= 'preset'
```

```text
ConstructionMode
+= 'preset_independent'
+= 'preset_from_text'
```

LLM 用量 scenario 建议：

```text
construction_preset_independent
construction_preset_from_text
```

---

## 9.1 一期不要求的交叉构建

以下不设为一期 Must：

```text
角色 → 预设
世界书 → 预设
预设 → 角色
预设 → 世界书
```

原因：

```text
角色 / 世界书 = 故事事实资产
Preset = 写作机制资产
```

强行互转容易把故事内容与写作方法混在一起。

如未来需要：

```text
从某本小说项目推导专属写作风格
```

可另做后续设计。

一期只做：

```text
独立设计
TXT 风格提炼
```

已经足以形成真正可用的 Preset Build。

---

# 10. BuildScreen 三类目标 UI

当前独立构建目标：

```text
角色卡
世界书
```

必须改成：

```text
角色卡
世界书
预设
```

视觉和交互层级平级。

推荐：

```text
构建目标
[ 角色卡 ] [ 世界书 ] [ 预设 ]
```

而不是把预设藏到：

```text
更多
设置
作家风格 Catalog
```

因为这是三个并列的构建产物。

---

# 11. 独立预设构建输入

建议字段：

```text
预设名称

适用题材 / 类型
目标读者或整体气质

叙述视角
叙述者距离

语言质感
句法 / 词汇倾向
段落组织

场景与环境描写
人物描写
对白与人物声音

节奏
冲突推进

悬念 / 信息揭示 / 伏笔

章节结构

意象 / 感官

禁止项 / 反模式

补充要求

丰满度：
紧凑 / 丰满 / 深度
```

不要求每个字段都填写。

但 UI 不应只提供：

```text
“风格描述”
```

一个大输入框。

因为一期的目标是形成真正的小说写作机制 Preset，而不是模糊风格标签。

---

# 12. TXT → 预设

该模式非常重要。

用户可以选择：

```text
一份 TXT
↓
选章节 / 片段
↓
分析其写作机制
↓
生成可编辑 Preset
```

该流程的目标是：

> **提炼写法，不复制故事内容。**

LLM 应抽象：

```text
叙述视角
距离
句法
词汇
段落
场景组织
对白规律
人物声音差异
节奏
冲突
信息揭示
悬念
伏笔
意象
感官
章节结构
常见禁忌
```

不得把来源中的：

```text
人物姓名
具体地名
具体剧情事实
专有设定
章节事件
```

直接写成 Preset 规则。

不得长段复制来源文本作为 Preset 内容。

---

## 12.1 TXT 解析链路复用

继续复用现有：

```text
pickSourceFile
readTextFileWithAutoEncodingResult
parseConstructionTextSource
buildTextSourceSnapshot
section selection
encoding detection
```

支持：

```text
UTF-8
GBK / GB18030
章节选择
片段选择
较大 TXT
```

不得为预设构建另外造一套 TXT Reader。

---

# 13. 预设构建输出合同

模型必须返回单个 JSON 对象：

```json
{
  "name": "预设名称",
  "system_prompt": "总体作者身份、叙事原则与不可突破的核心约束",
  "writing_style": "完整的写作风格与文学机制",
  "extra_instructions": "悬念、冲突、章节、禁止项、反模式与补充约束"
}
```

---

## 13.1 system_prompt 职责

主要承载：

```text
写作者身份
总体叙事目标
叙述立场
核心创作原则
最重要的不可突破风格原则
```

不承载：

```text
某一章剧情
某一个角色事实
某个世界书设定
```

---

## 13.2 writing_style 职责

主要承载：

```text
叙述视角
叙述者距离

句法
词汇
段落

场景描写
环境描写
人物描写

对白
人物声音区分

节奏
信息密度

意象
感官
```

---

## 13.3 extra_instructions 职责

主要承载：

```text
冲突升级
悬念
伏笔
信息揭示

章节结构
长篇一致性

禁止项
常见错误
低质仿写模式
反模式
```

---

# 14. 预设构建 Hard Gate / Soft Target

## 14.1 Hard Gate

只拦技术和合同错误：

```text
网络失败
响应为空
reasoning-only
明确截断
JSON 无法解析
根对象不是 object

name 为空
system_prompt 为空
writing_style 为空
extra_instructions 为空

Adapter 生成失败
shinewriter-preset-v1 本地回读失败
明显 Prompt / contract 泄漏
```

---

## 14.2 Soft Target

原一期建议规模继续生效：

| 档位 | 作家风格预设建议规模 |
|---|---:|
| 紧凑 | 1500–2500 中文字 |
| 丰满 | 2500–4500 中文字 |
| 深度 | 4000–7000 中文字 |

但这些只是：

```text
Soft Target
```

不是：

```text
保存门禁
```

例如：

```text
深度预设只有 3600 字
```

如果结构完整、内容有效：

```text
允许产出
给 warning
不丢弃
```

---

# 15. Construction Budget 增加 preset target

`src/services/construction/budget.ts` 属于构建层，可以继续修改。

新增：

```text
target = preset
```

预算逻辑应根据：

```text
detailLevel
provider context_window
provider max_output_tokens
reservePercent
TXT source size
```

计算。

不得触碰：

```text
Context Budget V3
Pipeline stage budget
正文资源预算
```

---

## 15.1 Preset 不需要世界书分批

世界书可：

```text
entry batches
```

Preset 默认是一个完整文档。

一期不建议为 Preset 新建复杂多批合并协议。

如果模型输出预算不足：

```text
UI 提示调整预留
或降低丰满度
```

即可。

除非真实 provider 限制证明单次无法完成，才允许最小分段策略。

不得为此引入新的长任务状态机。

---

# 16. Preset ConstructionArtifact

当前：

```text
ConstructionArtifact
= CharacterArtifact
| WorldbookArtifact
```

需要扩展为：

```text
ConstructionArtifact
= CharacterArtifact
| WorldbookArtifact
| PresetArtifact
```

建议：

```ts
interface PresetArtifact {
  kind: 'preset';
  name: string;
  preset: ShineWriterPresetV1;
  qualityReport?: ConstructionQualityReport;
}
```

其中：

```text
preset
```

直接复用现有导出格式。

---

# 17. 构建预览

角色：

```text
角色定位
身份背景
性格
动机
矛盾
关系
人物弧
```

世界书：

```text
按条目预览
```

预设：

必须按三个核心区域清晰预览：

```text
系统提示词
写作风格
额外约束
```

同时显示：

```text
预设名称
丰满度
质量 warning
预计 / 实际输出规模
```

必要时支持：

```text
查看 JSON
```

与角色 / 世界书保持一致的构建预览体验。

---

# 18. 预设构建保存到手机

`saveConstructionArtifact` 必须支持：

```text
kind = preset
```

导出：

```text
*.json
```

内容：

```text
shinewriter-preset-v1
```

保存后的文件必须可以被现有 ShineWriter Preset 导入链路重新导入。

必须做：

```text
build
→ save
→ import
→ compare
```

round-trip。

---

# 19. 预设构建导入资料库

`importConstructionArtifactToLibrary` 必须支持：

```text
PresetArtifact
```

导入目标：

```text
资料
→ 预设
→ 我的预设
```

导入后：

```text
is_default = false
```

不得自动覆盖当前默认 Preset。

如果同名：

```text
名称自动避让
```

例如：

```text
冷峻悬疑
冷峻悬疑 (2)
冷峻悬疑 (3)
```

具体格式可沿用仓库已有命名规则。

核心要求：

> **绝不能静默覆盖已有用户 Preset。**

---

# 20. 预设构建后的完整资源闭环

必须证明：

```text
构建预设
↓
预览
↓
保存到手机
↓
导入资料库
↓
我的预设
↓
编辑
↓
保存
↓
导出
↓
再导入
```

完整 PASS。

---

# 21. Workstream A —— NG-01：关闭 CL-06 / test:ci

## 21.1 先证明问题

使用与 CI 尽可能一致的环境：

```text
Node 24.14.1
npm ci
jest --runInBand --ci
```

先 targeted：

```bash
npx jest __tests__/cl06HardBudgetGate.test.ts --runInBand
```

然后连续重复。

建议至少：

```text
10 次
```

目的不是“碰巧找到一次 PASS”，而是判断：

```text
稳定失败
偶发失败
单测独跑 PASS / 全量时 FAIL
环境相关
测试污染
异步时序
真实生产逻辑回归
```

---

## 21.2 必查路径

围绕：

```text
used_llm_calls
attempt
failed attempt
Adoption
batch hard budget
reservation / usage accounting
```

必须回答：

```text
1. attempt 什么时候被记为 started？
2. 什么时候算一次真实 LLM call？
3. failed attempt 结束时 used_llm_calls 是否立即更新？
4. 更新动作是否 await？
5. CL-06 查询数据库时，持久化是否已经完成？
6. 全量 Jest 前序 suite 是否污染 timer / mock / DB state？
7. 一期提交是否改变 module import order 或测试耗时，从而暴露既有 race？
```

---

## 21.3 基线对照

在干净 worktree：

```text
772f81ac
```

使用相同：

```text
Node 24.14.1
npm ci
targeted command
```

重复 CL-06。

记录：

```text
772f81ac:
10 次 PASS / FAIL

当前一期 HEAD:
10 次 PASS / FAIL
```

用于判断：

```text
一期引入
vs
历史 flaky / 环境变化
```

---

## 21.4 修复原则

优先：

```text
修一期自己的因果链
```

如果是测试隔离：

```text
修 isolation
但不得降低 Final Seal 语义
```

禁止：

```text
改 expected
skip
only
删断言
把实时一致改成最终一致
用超长 timeout 掩盖同步问题
```

---

## 21.5 NG-01 CLOSED

必须：

```text
CL-06 targeted 稳定 PASS
npm run test:ci = PASS
没有降低旧 Final Seal 断言
没有越界 Context / Pipeline 语义修改
```

---

# 22. Workstream B —— NG-02：补齐预设构建

这是本次新增的一期核心 Must。

---

## 22.1 类型层

至少完成：

```text
ConstructionTarget += preset

ConstructionMode +=
preset_independent
preset_from_text

modeTarget
modeScenario
ConstructionInput
ConstructionArtifact
```

全部有类型检查。

---

## 22.2 生成层

在当前 construction AI 服务中补：

```text
presetSystemPrompt
preset user prompt / messages
preset JSON parse
preset contract validation
preset local Adapter
quality report
```

---

## 22.3 文件层

补：

```text
PresetArtifact save
PresetArtifact import to library
shinewriter-preset-v1 read-back
duplicate name handling
```

---

## 22.4 UI 层

Build 页：

```text
角色卡
世界书
预设
```

三目标平级。

支持：

```text
独立构建 → 预设
TXT → 预设
```

---

## 22.5 Preset targeted tests

建议新增 / 扩展：

```text
constructionPresetTarget.test.ts
constructionPresetPrompt.test.ts
constructionPresetAdapter.test.ts
constructionPresetQuality.test.ts
constructionPresetFileService.test.ts
constructionPresetTxtSource.test.ts
buildScreenPreset.test.tsx
```

不强制文件名，但测试语义必须覆盖。

---

## 22.6 必测合同

```text
preset_independent → target preset

preset_from_text → target preset

scenario 正确

LLM 输出只需要：
name
system_prompt
writing_style
extra_instructions

LLM 不负责：
temperature
top_p
max_tokens
is_default
spec

Adapter：
生成 shinewriter-preset-v1

本地回读：
PASS

导入资料库：
进入“我的预设”

同名：
不覆盖

导入后：
可编辑
可删除
可导出
```

---

## 22.7 TXT 风格提炼 tests

fixture 中包含：

```text
具体角色名
具体地名
具体事件
明显句法风格
对白风格
段落风格
```

断言输出：

```text
包含文学机制
不要求复述剧情
不把来源事实写成系统世界规则
```

不要用脆弱的逐字文本断言。

重点测：

```text
Prompt 合同
字段结构
内容方向
```

---

## 22.8 NG-02 CLOSED

```text
Build 三目标平级
独立预设构建 PASS
TXT→预设 PASS
PresetArtifact PASS
保存到手机 PASS
导入资料库 PASS
round-trip PASS
同名不覆盖
未新增 DB Schema
未改下游 Context / Pipeline
```

---

# 23. Workstream C —— NG-03：作家风格 Catalog 内容资产收尾

当前问题不是 Catalog 架构，而是：

> **“作家风格”资料资产本身仍需要达到真正可长期使用的文学机制密度。**

---

## 23.1 每个作家风格至少覆盖

```text
叙述视角
叙述者距离

句法
词汇
段落组织

场景描写
环境描写
人物描写

对白
人物声音差异

信息揭示
悬念
伏笔

冲突
节奏
章节结构

意象
感官

适用的特殊机制

禁止项
常见错误
低质仿写模式
```

不能只写：

```text
语言克制
多写细节
保持连贯
```

---

## 23.2 Catalog 与 Build 的关系

两者必须明确区分：

### Catalog

```text
官方已经准备好的优质风格模板
↓
用户复制
↓
我的预设
```

### Preset Build

```text
用户自己描述需求 / 提供 TXT
↓
AI 生成专属风格 Preset
↓
我的预设
```

不得因为新增 Preset Build：

```text
删除作家风格 Catalog
```

也不得因为已有 Catalog：

```text
取消 Preset Build
```

两者互补。

---

## 23.3 版权边界

若 Catalog 参考真实作家：

```text
只写抽象文学特征
```

禁止大段内置受版权保护的原文。

更推荐：

```text
文学机制型名称
类型型名称
叙事方法型名称
```

---

## 23.4 NG-03 CLOSED

```text
作家风格不再是短标签模板
至少一个完整风格项逐项覆盖一期文学机制要求
Catalog copy / edit / delete / export 全链路通过
Catalog 不覆盖已有用户 Preset
Catalog 与 Preset Build 同时存在且职责清晰
```

---

# 24. Workstream D —— NG-04：Android 模拟器真实 E2E

**Android Debug build PASS 不等于 Android E2E PASS。**

本轮必须在真实 Android 模拟器中完成。

记录：

```text
emulator model
Android API
APK path
APK SHA256
git commit
测试日期
```

每个 P0 流程至少留：

```text
操作结果
截图 / 录屏关键帧
失败时 logcat
生成 / 导出文件验证
```

---

# 25. 角色 Android E2E

必须走：

```text
资料
→ 角色
→ 合集
→ 新建角色档案
→ 编辑
→ 保存
→ 重新打开
```

检查：

```text
小说化字段正确
保存后不丢
不强制 chat 字段
```

再：

```text
导入旧 CCv3 JSON
导入 PNG 角色卡
导出
再导入
项目启用 / 停用
```

验证：

```text
旧聊天字段不丢
未知 extensions 不丢
PNG metadata / 图片不丢
```

---

# 26. 世界书 Android E2E

必须：

```text
资料
→ 世界书
→ 新建合集
→ 新建条目
→ 编辑
→ 常驻开关
→ 启用合集
```

再测试 Lorebook：

```text
constant=true
constant=false
无 constant
entries array
entries object
character_book embedded
```

重点：

```text
外部显式 constant=false
导入后仍为 false
```

---

# 27. Preset 资料库 Android E2E

必须：

```text
资料
→ 预设
```

看到：

```text
我的预设
作家风格
官方预设
```

Catalog：

```text
预览
添加到我的预设
打开
编辑
保存
导出
删除
```

重复添加：

```text
同 Catalog 复制 2 次
```

要求：

```text
名称避让
不覆盖
```

---

# 28. Build Android E2E —— 三类目标

一期必须实际看到：

```text
构建目标
角色卡 | 世界书 | 预设
```

不是只通过 unit test。

---

## 28.1 角色

```text
独立角色
世界书 → 角色
TXT → 角色
```

---

## 28.2 世界书

```text
独立世界书
角色 → 世界书
TXT → 世界书
```

---

## 28.3 预设

必须新增：

```text
独立预设
TXT → 预设
```

---

## 28.4 三档丰满度

三类目标都至少证明：

```text
紧凑
丰满
深度
```

不要求所有输入 × 所有档位穷举。

但 Android 必须有代表性真实生成。

unit / budget tests 覆盖完整矩阵。

---

# 29. 预设构建 Android 详细穿测

## 29.1 独立预设

填写：

```text
预设名称
类型
视角
语言质感
对白
节奏
悬念
章节结构
禁止项
```

生成后检查：

```text
name
system_prompt
writing_style
extra_instructions
```

均有有效内容。

再：

```text
查看 JSON
保存到手机
导入资料库
```

确认：

```text
资料 → 预设 → 我的预设
```

可看到新预设。

---

## 29.2 TXT → 预设

选择一份小说 TXT：

```text
识别编码
选章节 / 片段
生成
```

检查：

```text
结果提炼写法
不是剧情总结
不是人物卡
不是世界书
不是照抄原文
```

然后：

```text
导入资料库
编辑
保存
导出
再导入
```

---

# 30. Build 异常流

三类构建至少覆盖：

```text
取消生成
401
模型返回非法 JSON
模型返回截断 JSON
保存到手机
导入资料库
```

预设也必须纳入。

检查：

```text
取消无脏产物
401 错误可理解
非法 JSON Hard Gate
截断 Hard Gate
成功可保存
成功可导入
```

---

# 31. TXT 来源穿测

TXT 至少：

```text
UTF-8
GBK / GB18030
多章节
片段勾选
较大 TXT
```

并确认：

```text
TXT→角色
TXT→世界书
TXT→预设
```

都使用同一稳定 Reader / parser 主链。

---

## 31.1 NG-04 CLOSED

```text
角色资料 E2E PASS
世界书资料 E2E PASS
Preset 资料 E2E PASS

角色构建 E2E PASS
世界书构建 E2E PASS
预设构建 E2E PASS

异常流 PASS
TXT PASS

证据完整
```

---

# 32. Workstream E —— NG-05：覆盖安装数据保留

必须：

```text
旧 APK
↓
真实产生数据
↓
直接覆盖安装一期候选 APK
↓
不卸载
不清数据
↓
验证原数据
```

不能用：

```text
全新安装
fixture-only
纯内存 SQLite
```

代替。

---

# 33. 覆盖安装前准备数据

## 33.1 角色

```text
多个角色合集
普通旧 CCv3
PNG
first_mes
mes_example
system_prompt
post_history
alternate_greetings
未知 extension
```

---

## 33.2 世界书

```text
多个合集
constant=true
constant=false
无 constant
多个关键词
secondary keys
```

---

## 33.3 Preset

```text
多个用户 Preset
默认 Preset
非默认 Preset
system_prompt
writing_style
extra_instructions
temperature
top_p
max_tokens
```

---

## 33.4 项目与下游旧数据

```text
资源启用关系
已有项目
章节
大纲
Story Memory
Canon（如存在）
已有 Pipeline / Resume 状态（如可安全准备）
```

---

# 34. 覆盖安装前证据

至少记录：

```text
各资源 count
关键 row id
关键 JSON hash
关键字段摘要
数据库 SHA256
```

建议：

```text
pre-upgrade-db-copy
pre-upgrade-summary.json
```

---

# 35. 执行覆盖安装

只允许：

```text
adb install -r <phase1-candidate.apk>
```

或仓库正式覆盖安装脚本。

严禁：

```text
adb uninstall
pm clear
wipe data
```

---

# 36. 覆盖安装后验证

必须确认：

```text
角色不丢
PNG 不丢
chat 字段不丢
unknown extension 不丢

世界书不丢
constant=false 不变 true
合集开关正常

Preset 不丢
默认 Preset 正常
用户 Preset 不被 Catalog 覆盖

项目绑定不丢

章节不丢
大纲不丢
Story Memory 不异常
```

同时新增验证：

```text
覆盖升级后
Build 页出现“预设”
但不会修改任何旧 Preset
```

---

# 37. 设备数据库证据

本轮必须生成真实：

```text
repaired_device.db
```

或仓库当前 QA 脚本期待的等价设备 DB。

再次执行：

```text
schema40-verify-device-db
```

这次不得再：

```text
repaired_device.db not found
→ return
→ suite PASS
```

必须真正读设备 DB 并断言。

---

## 37.1 NG-05 CLOSED

```text
真实覆盖安装完成
没有卸载 / 清数据
设备 DB 被拉取
旧数据完整
资源绑定完整
下游旧数据完整
device-db verification 真执行
```

---

# 38. 下游“不变性” Android Smoke

一期不负责把新资料完整接进 Writer。

但必须证明没有破坏旧 Writer。

用已有项目：

```text
打开项目
→ Context Preview
→ 运行一章既有 Pipeline
```

至少：

```text
Draft
Review
FactCheck
Brief
Proof
```

验收：

```text
流程可完成
Preview 正常
Worldbook activation 不变
Freeze / Resume 不变
cold-start Resume 不变
```

---

## 38.1 对预设构建的边界特别说明

新增的 Preset Build 只负责：

```text
生成 Preset 资源
```

不得为了证明“生成的 Preset 有效果”而改：

```text
Pipeline Prompt 组装
Context Snapshot
Stage Prompt
Preset runtime binding
```

如果当前系统已有 Preset 使用机制：

```text
只验证旧机制未坏
```

如果新构建出的某些完整文学字段在某些下游阶段未充分消费：

```text
记录二期
```

不在一期顺手改。

---

# 39. Workstream F —— NG-06：独立第二视角 Final Seal

前五个 workstream 结束后：

```text
Developer Closure
结束
```

然后切换：

```text
Independent Acceptor
```

从上位一期方案第一页重新审计。

不能只看刚修过的项目。

---

# 40. 独立验收矩阵

## 40.1 角色

```text
[ ] 新建角色是小说角色档案
[ ] LLM 不生成 chat 专属字段
[ ] NovelCharacterDraft 被真实调用
[ ] deterministic CCv3 Adapter 被调用
[ ] extension 完整
[ ] CharacterEditor 小说字段主导
[ ] legacy chat 字段无损
[ ] unknown extension round-trip
[ ] JSON import/export
[ ] PNG import
```

---

## 40.2 世界书

```text
[ ] NovelWorldbookDraft 被调用
[ ] LLM 只生成世界事实
[ ] 不要求“当前主冲突”
[ ] 不输出 runtime metadata
[ ] local Adapter 生成 Lorebook
[ ] 自建 constant=true
[ ] external constant=false 保留
[ ] import/export 回归
[ ] runtime activation 未改
```

---

## 40.3 Preset 资料库

```text
[ ] 我的预设
[ ] 作家风格
[ ] 官方预设
[ ] 作家风格机制完整
[ ] Static Catalog
[ ] copy → DB Preset
[ ] duplicate name avoid overwrite
[ ] copy 后可编辑
[ ] copy 后可删除
[ ] copy 后可导出
[ ] legacy Preset 不回归
```

---

## 40.4 Preset Build

新增一期 Must：

```text
[ ] Build 页角色 / 世界书 / 预设三目标平级

[ ] preset_independent
[ ] preset_from_text

[ ] LLM 只生成文学语义字段
[ ] LLM 不生成 sampling / DB / spec 元数据

[ ] local Adapter → shinewriter-preset-v1

[ ] 紧凑
[ ] 丰满
[ ] 深度

[ ] save to phone
[ ] import to library
[ ] editable
[ ] deletable
[ ] exportable
[ ] round-trip

[ ] duplicate name no overwrite

[ ] TXT 只提炼写作机制
[ ] 不把故事事实当 Preset 规则

[ ] 不修改下游 Pipeline / Context
```

---

## 40.5 Quality / Budget

```text
[ ] technical / structural failure = hard
[ ] content short = warning
[ ] no chat-field content hard gate
[ ] character compact/full/deep
[ ] worldbook compact/full/deep
[ ] preset compact/full/deep

[ ] 32K
[ ] 128K
[ ] 256K
[ ] 1M

[ ] worldbook 2/4/8/12 entries 预算合理
[ ] preset 大上下文预算合理
```

Android 不要求笛卡尔积穷举。

unit / budget tests 覆盖矩阵。

---

## 40.6 兼容

```text
[ ] CCv3 JSON
[ ] PNG
[ ] Lorebook v3
[ ] constant=false
[ ] old Preset
[ ] shinewriter-preset-v1
[ ] unknown extensions
[ ] TXT encoding
[ ] project enable relations
```

---

# 41. Forbidden Diff Final Audit

执行：

```bash
git diff --name-only 772f81ac...HEAD
```

逐文件审计：

```text
Context
Pipeline
Story Memory
Canon
Outline runtime
Schema
Repositories
```

最终报告：

```text
contextBudgetVersion = 6
database schema = 51

Forbidden Diff:
0
```

如果非 0：

```text
逐项给出理由
逐项证明运行语义不变
```

但一期原则仍然：

> **越接近 0 越正确。**

---

# 42. Final Seal 测试集合

最终代码完成后：

```bash
npm ci
npm run lint
npm run typecheck
npm run verify:version
npm run test:ci
```

如果仓库存在：

```bash
npm run verify
```

也必须执行。

Android：

```bash
npm run apk:debug
```

发布候选：

```bash
npm run apk:release
```

若正式脚本已变化，以最新 `package.json` 为准并记录真实命令。

---

# 43. 一期 targeted regression

至少重新跑：

```text
constructionAdapters
constructionQuality
constructionBudget
constructionAiGenerator
constructionFileService

construction preset target
construction preset prompt
construction preset adapter
construction preset quality
construction preset file service
construction preset TXT

characterEditorNovel
resourceLibraryUi
BuildScreen preset UI

fileImport
legacy character compatibility
legacy worldbook compatibility
presetCompatibility
presetRepositoryIntegrity
```

---

# 44. 原 Final Seal 测试

原样继续 PASS：

```text
Context Budget V3
contextBuilder V3
resource candidate
Worldbook activation
Context Preview
Pipeline Freeze
Resume
cold-start Resume
Frozen Snapshot
```

并明确：

```text
旧测试期望未为一期功能修改
```

---

# 45. CI Final Seal

最终候选 commit push 后：

GitHub Actions：

```text
Verify
```

必须：

```text
JavaScript validation = PASS
Migration matrix = PASS
Android Debug build = PASS
```

不能用：

```text
本地绿
```

替代：

```text
远端绿
```

最终报告必须写：

```text
commit SHA
workflow run id
workflow conclusion
各 job conclusion
```

---

# 46. QA 证据目录

建议：

```text
docs/qa/phase1-closure/
```

或：

```text
test-logs/phase1-closure/
```

内容：

```text
00-baseline.md
01-forbidden-diff.md
02-cl06.md
03-preset-build.md
04-preset-catalog.md
05-android-e2e.md
06-overwrite-install.md
07-downstream-smoke.md
08-final-test-gates.md
09-final-acceptance.md
```

Android：

```text
screenshots/
logcat/
exports/
device-db/
```

若不提交 APK / DB：

至少记录：

```text
SHA256
本地路径
生成命令
验证摘要
```

---

# 47. 每轮 PDCA 固定记录模板

```markdown
## PDCA Round X

### PLAN

本轮目标：
- ...

本轮开始剩余 NO-GO：
- NG-...

### DO

发现问题：
1. ...

根因：
1. ...

修改文件：
- ...

新增 / 修改测试：
- ...

Android 流程：
- ...

### CHECK

targeted:
- PASS / FAIL

test:ci:
- PASS / FAIL

lint:
- PASS / FAIL

typecheck:
- PASS / FAIL

Android:
- PASS / FAIL

Forbidden Diff:
- ...

### ACT

已关闭：
- NG-...

仍剩余：
- NG-...

下一轮：
- ...

一期剩余 NO-GO：
N
```

---

# 48. 推荐 PDCA 顺序

## Round 0 —— Baseline

```text
同步远端
锁基线
diff audit
记录 CI
记录当前 Build 只有 character/worldbook
```

不改代码。

---

## Round 1 —— Developer Closure A

主任务：

```text
NG-01 CL-06
NG-02 预设构建
```

先确保：

```text
targeted
test:ci
lint
typecheck
verify:version
```

全绿。

如果没绿：

```text
继续 Round 1.x
```

不得进入封板。

---

## Round 2 —— Developer Closure B

主任务：

```text
NG-03 作家风格 Catalog
```

并做：

```text
Preset Build
vs
Catalog
```

职责隔离复审。

---

## Round 3 —— Device Closure

主任务：

```text
NG-04 Android E2E
NG-05 覆盖安装
```

真实设备流发现问题：

```text
立即修
重新 build
重新走对应 E2E
```

不能只登记。

---

## Round 4 —— Independent Acceptor

重新：

```text
读方案
看 diff
看代码
看 tests
看 Android
看设备 DB
看 CI
看边界
```

如果发现任何问题：

```text
Round 5
自动修复
```

然后再次验收。

PDCA 不设固定轮数。

---

# 49. 提交策略

建议小提交：

```text
1. test/fix: close phase1 verification blocker
2. feat(build): add first-class preset construction
3. test(build): close preset construction contracts
4. feat(presets): complete phase1 author-style catalog assets
5. test(resources): close phase1 preset compatibility regressions
6. qa(android): close phase1 three-target build e2e
7. qa: record phase1 overwrite-install evidence
8. docs: seal phase1 resource/build closure
```

如果 CL-06 无需代码修复：

```text
不要为了有提交而改测试
```

---

# 50. 严禁混入的二期内容

任何提交都不得顺手加入：

```text
Context V4
新的资源注入
角色档案直接重写正文 Context
世界书新 relevance 算法

Preset 新 runtime engine
Preset 与 Pipeline stage 新绑定
Pipeline Prompt 重构
Writer Prompt 重构

Story Memory 优先级
Canon 优先级
Outline 调度

Frozen resource snapshot
新的 Pipeline freeze contract
```

这些全部属于二期或独立工程。

---

# 51. 最终 GO 矩阵

Final Seal 报告一期范围只允许：

```text
GO
二期
```

不得写：

```text
基本完成
部分完成
后续优化
建议以后补
风险可接受
```

---

## 51.1 资料

```text
[ ] GO 角色小说化
[ ] GO 世界书小说化
[ ] GO Preset 三层资料架构
[ ] GO 作家风格 Catalog 文学机制完整
```

---

## 51.2 构建

```text
[ ] GO 角色卡构建
[ ] GO 世界书构建
[ ] GO 预设构建

[ ] GO 独立角色
[ ] GO 世界书→角色
[ ] GO TXT→角色

[ ] GO 独立世界书
[ ] GO 角色→世界书
[ ] GO TXT→世界书

[ ] GO 独立预设
[ ] GO TXT→预设
```

---

## 51.3 构建中间模型 / Adapter

```text
[ ] GO NovelCharacterDraft
[ ] GO Character Adapter

[ ] GO NovelWorldbookDraft
[ ] GO Worldbook Adapter

[ ] GO Preset construction DTO
[ ] GO Preset Adapter → shinewriter-preset-v1
```

---

## 51.4 Quality

```text
[ ] GO Hard Gate 只拦客观失败
[ ] GO Soft Target 不丢有效产物

[ ] GO character compact/full/deep
[ ] GO worldbook compact/full/deep
[ ] GO preset compact/full/deep
```

---

## 51.5 保存 / 导入 / 导出

```text
[ ] GO character save/import/export
[ ] GO worldbook save/import/export
[ ] GO preset save/import/export
[ ] GO preset duplicate no overwrite
```

---

## 51.6 兼容

```text
[ ] GO old CCv3 JSON
[ ] GO old PNG
[ ] GO old Lorebook
[ ] GO constant=false
[ ] GO old Preset
[ ] GO unknown extensions
[ ] GO TXT encoding
[ ] GO 覆盖安装数据保留
```

---

## 51.7 下游边界

```text
[ ] GO Context Budget V3 不变
[ ] GO contextBudgetVersion = 6
[ ] GO Schema = 51
[ ] GO Worldbook activation 不变
[ ] GO Preview 不变
[ ] GO Pipeline 不变
[ ] GO Freeze / Resume 不变
[ ] GO cold-start Resume 不变
[ ] GO Story Memory 不变
[ ] GO Canon 不变
[ ] GO Outline runtime 不变
```

---

## 51.8 CI / Android

```text
[ ] GO test:ci
[ ] GO lint
[ ] GO typecheck
[ ] GO verify:version
[ ] GO verify

[ ] GO Android Debug
[ ] GO release candidate

[ ] GO Android 三类资料 E2E
[ ] GO Android 三类构建 E2E
[ ] GO overwrite install
[ ] GO device DB verification
```

---

# 52. 一期最终产品形态

一期封板后，用户在 ShineWriter 里应看到：

```text
资料
├─ 角色
├─ 世界书
└─ 预设
   ├─ 我的预设
   ├─ 作家风格
   └─ 官方预设
```

以及：

```text
构建
├─ 角色卡
├─ 世界书
└─ 预设
```

构建来源能力：

```text
角色卡：
独立
世界书
TXT

世界书：
独立
角色卡
TXT

预设：
独立
TXT
```

形成完整闭环：

```text
构建
↓
小说资料资产
↓
保存到手机 / 导入资料库
↓
编辑
↓
导出
```

一期明确停在这里。

---

# 53. 二期明确事项

一期完成后仍属于二期：

```text
新角色小说字段如何进入正文弹性上下文
世界书如何在 Context 层做更智能消费
Preset 如何在不同 Pipeline stage 分层使用
项目级风格快照
Preset freeze
资源优先级
Story Memory / Canon / Outline 与新资料的协同
```

一期不接。

---

# 54. Agent 最终交付格式

最终必须输出：

```text
1. 最终 commit SHA
2. 远端 Verify Run ID
3. 各 CI Job 状态
4. 变更文件清单
5. Forbidden Diff 审计
6. CL-06 根因与关闭证据
7. 预设构建实现与测试证据
8. 作家风格 Catalog 收尾证据
9. targeted tests
10. full test:ci
11. lint / typecheck / verify
12. Debug / Release APK
13. Android 三类资料 E2E
14. Android 三类构建 E2E
15. 覆盖安装证据
16. device DB verification
17. 下游 Smoke
18. PDCA 各轮摘要
19. 最终 GO 矩阵
20. 二期事项
```

最终最后一行必须是：

```text
PDCA 最后一轮一期剩余 NO-GO = 0
```

否则：

```text
Final Seal = NO-GO
```

---

# 附录 A：给本地 Agent 的自主执行提示词

```text
以本地仓当前代码为唯一实施基准，完整阅读：
1. 《ShineWriter_资料库与构建库小说化改造一期方案》
2. 《ShineWriter_第一期工程收尾_PDCA方案_含预设构建补齐_20260813.md》

然后自主完成一期工程收尾，不逐项向我确认。

第一步 fetch --all --prune，确认 HEAD、origin/main、working tree，并审计 772f81ac...HEAD 的全部 diff。

本次一期收尾新增一个明确补漏项：
“预设构建”必须与“角色卡构建、世界书构建”平级，是一期 P0 / Must，不属于二期。

最终 Build 目标必须是：
character | worldbook | preset

至少新增：
preset_independent
preset_from_text

Preset Build 必须：
- 复用现有 Preset DB / presetRepository / shinewriter-preset-v1；
- 不新增 DB Schema；
- LLM 只生成 name / system_prompt / writing_style / extra_instructions；
- temperature / top_p / max_tokens / is_default / spec 等由本地 deterministic Adapter 补齐；
- 支持紧凑 / 丰满 / 深度；
- 支持预览；
- 支持保存到手机；
- 支持导入“资料→预设→我的预设”；
- 同名不得覆盖，必须名称避让；
- 导入后可以编辑 / 删除 / 导出；
- 保存文件必须能再次导入；
- TXT→预设只提炼文学机制，不把角色名、地名、剧情事实写成 Preset 规则。

本期边界锁死：
只改资料库和构建库的资源资产定义、构建生成、编辑展示、兼容导入导出。
禁止修改：
Context Budget V3、resourceContextCandidates、contextBuilder、Worldbook activation、Context Preview 运行语义、Pipeline、Draft/Review/FactCheck/Brief/Proof、Frozen Snapshot、Freeze/Resume、cold-start Resume、Story Memory、Canon、Outline runtime。
contextBudgetVersion 必须仍是 6。
database schema 必须仍是 51。

本轮 NO-GO：
NG-01 CL-06 / test:ci
NG-02 预设构建缺失
NG-03 作家风格 Catalog 内容完整度
NG-04 Android 三资料 + 三构建 E2E
NG-05 覆盖安装与 device DB
NG-06 独立第二视角 Final Seal

执行自主 PDCA：
- 不设固定轮数；
- 每轮 PLAN/DO/CHECK/ACT；
- 发现问题立即修复；
- 不询问“是否继续”；
- 首轮全绿也必须至少执行一次独立验收者复审；
- 只有一期剩余 NO-GO=0 才结束。

CL-06 不允许通过修改 expected、skip、删断言或降低实时一致语义修绿。
先在相同 Node/npm 环境下对 772f81ac 和当前 HEAD 做重复对照，证明是一期回归、测试隔离、环境变化还是历史 race，再做最小修复。

最终必须执行：
npm ci
npm run lint
npm run typecheck
npm run verify:version
npm run test:ci
npm run verify（如存在）
debug APK
release candidate APK

Android 必须真实穿测：
资料：角色 / 世界书 / 预设
构建：角色卡 / 世界书 / 预设
并完成：
独立角色
世界书→角色
TXT→角色
独立世界书
角色→世界书
TXT→世界书
独立预设
TXT→预设
紧凑/丰满/深度代表性真实生成
取消
401
非法 JSON
截断 JSON
保存到手机
导入资料库

覆盖安装必须：
旧 APK 写真实数据
adb install -r 候选 APK
不 uninstall
不 pm clear
拉取真实设备 DB
真正执行 device-db verification
旧角色/世界书/Preset/项目/章节/大纲/Story Memory 等数据不得丢失。

最后切换 Independent Acceptor，从一期方案第一页重新审计实际代码、UI、DB、导入导出、测试、Android、CI 和边界。

最终交付必须包含完整 GO 矩阵。
任何一期 Must 未完成 → NO-GO。
任何 Context/Pipeline/Story Memory/Canon/Outline 运行语义变化 → 默认 NO-GO。

最后一行必须：
PDCA 最后一轮一期剩余 NO-GO = 0
```
