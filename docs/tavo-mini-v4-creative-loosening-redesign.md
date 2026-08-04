# TAVO-MINI Continuation V4 创作松绑与 Checker / Control / Repair 职责重构方案

> 本地项目目录：`D:\AiWorkSpace\tavo-mini`  
> 建议保存位置：`D:\AiWorkSpace\tavo-mini\docs\tavo-mini-v4-creative-loosening-redesign.md`  
> 适用范围：Continuation V4 FULL-Control 流水线  
> 核心目标：保留原著事实与安全底线，降低对 Writer 和 Repair 的机械控制，让模型优先写出自然、有原著气质的完整章节。

---

## 1. 背景

近期真实用户反馈表明，现有流水线虽然能拦截明显失败的 Repair，但作品正在出现新的质量退化：

- 为满足字数指标而补心理、补环境、补重复反应；
- 为满足结构任务而机械覆盖 Beat；
- 语言越来越像模板化编辑结果；
- 人物对白、留白、节奏和情绪表达失去原著气息；
- Repair 可能只回填任务 ID，却不真正修改；
- Repair 也可能返回片段、摘要或坍缩后的章节；
- Control 的篇幅任务和结构 findings 正在挤占模型的创作注意力。

根因不是模型能力不足，而是系统把可计算指标当成了创作质量目标。

本轮改造原则：

> 事实准确是硬底线，文风一致是精准审查，字数只是动态弱提示，文学表达交给模型。

---

## 2. 新版职责划分

### 2.1 Writer：完整章节创作者

Writer 负责：

- 根据用户本章要求创作完整章节；
- 使用冻结的原著五维资料；
- 延续原著风格分析与代表性原文样本；
- 保持人物、关系、世界规则、剧情线和经历准确；
- 输出从章节开头到自然结尾的完整正文。

Writer 不再承担：

- 机械覆盖全部 Beat；
- 强制达到具体字数区间；
- 按对话比例、段落长度、结构指标逐项写作；
- 为满足字数增加解释性心理、环境描写或重复反应。

### 2.2 Checker：原著五维资料一致性审查

Checker 只负责：

1. 人物；
2. 世界规则；
3. 人物关系；
4. 剧情线；
5. 人物经历。

同时继续检查：

- 用户锁定规则；
- 续写边界；
- future leakage；
- 不该知道的信息；
- 明确的时间与状态冲突。

Checker 不负责：

- 字数；
- 文风；
- 段落长短；
- 对话比例；
- Beat 覆盖；
- 章末钩子；
- “灵性”或整体节奏评价。

### 2.3 Control：原著文风一致性审查

Control LLM 保留，但职责从“篇幅控制”改为“风格审查”。

Control 负责审查：

- 叙述视角；
- 叙述距离；
- 句式和节奏；
- 人物对白个性；
- 情绪表达方式；
- 描写密度；
- 留白和潜台词；
- 场景转换；
- 模板化心理活动；
- AI 套话、总结式表达和凑字数痕迹。

Control 不再负责：

- `expand / compress / keep` 决策；
- `expectedDeltaHan`；
- 最低净增、最低净减；
- 以字数差额驱动 Repair；
- 用段落比例或 Beat 覆盖强迫改写。

### 2.4 Repair：精准、最小干预的完整章节修订者

Repair 负责：

- 接收 Checker 的事实问题；
- 接收 Control 的文风问题；
- 对明确问题进行最小范围修订；
- 未涉及段落尽量保持 Writer 原文；
- 始终输出完整章节终稿，而不是片段、Patch 或摘要。

Repair 不负责：

- 为接近字数目标扩写或压缩；
- 统一润色整章；
- 重写未标记段落；
- 处理抽象、无定位的 findings；
- 为体现风格而堆叠风格特征。

---

## 3. 字数策略：动态注入，弱提示

### 3.1 动态来源

字数继续来自流水线用户配置：

```ts
const targetChapterChars =
  snapshot.settingsSnapshot.values.targetChapterChars;
```

不得在 Prompt、Runner、Gate 或测试里写死业务字数目标。

允许使用现有：

```ts
resolveContinuationLengthContract(targetChapterChars)
```

派生参考区间，但该区间只用于提示和展示。

### 3.2 Writer Prompt 文案

建议动态生成：

```text
本次用户设置的参考篇幅约为 {targetChapterChars} 个汉字。

该篇幅用于帮助把握章节体量，不是必须机械达到的硬指标。
优先保证情节自然完整、人物和资料准确、叙述延续原著风格。

不得为了接近参考字数：
- 填充重复心理；
- 堆叠环境描写；
- 重复人物反应；
- 扩展无新信息的对白；
- 添加总结性解释。

正文可根据本章实际情节自然长于或短于参考篇幅。
```

### 3.3 字数只产生 advisory

保留：

```text
chapter_length_under_target
chapter_length_over_target
```

统一降级为：

```text
warning
```

字数偏差只用于：

- UI 提示；
- telemetry；
- 用户人工判断。

不得用于：

- 单独触发 Repair；
- 决定 Repair eligibility；
- 强制净增或净减；
- 拒绝完整且质量更好的章节。

### 3.4 停用篇幅硬验收

以下逻辑不再参与 eligibility：

```text
repair_control_insufficient_progress
requiredProgressHan
CONTROL_PROGRESS_RATIO
CONTROL_PROGRESS_FLOOR_HAN
ctrl_local_expand
ctrl_local_compress
```

为兼容旧数据可以暂时保留字段和解析，但必须从：

- Repair 触发；
- Prompt 强制任务；
- Local Final Gate blocking；
- 默认候选选择；

中移除。

---

## 4. Writer Prompt 松绑

修改：

```text
src/services/continuation/generation/continuationV4PromptCompiler.ts
```

### 4.1 保留内容

Writer 仍接收：

- 用户要求；
- 冻结五维资料；
- 人物与关系当前状态；
- 续写边界；
- 原著风格画像；
- 少量代表性原文片段；
- 动态参考字数；
- 必要的章节承接点。

### 4.2 删除或弱化

删除或降级以下八股式要求：

- 必须覆盖所有 Beat；
- 必须达到最低字数；
- 必须满足固定对话比例；
- 必须满足固定段落分布；
- 必须增加若干动作、反应、因果；
- 输出前逐项完成结构检查表；
- 为达到字数增加内容；
- 将风格画像当作逐项合规规则。

### 4.3 风格提示原则

Prompt 应明确：

```text
自然延续原著的叙述气质、人物语言和情绪表达倾向。
风格画像用于帮助理解整体画风，不要求逐项机械复现。
不要为了表现“像原著”而堆叠固定句式、意象或修辞。
```

---

## 5. Checker 新契约

### 5.1 输入

Checker 接收：

- 当前 Writer 完整正文；
- Writer artifact hash；
- 冻结五维资料；
- 相关 evidence；
- 用户锁定规则；
- 续写边界。

### 5.2 输出

建议继续使用 envelope：

```json
{
  "schemaVersion": 2,
  "writerArtifactHash": "",
  "issues": [],
  "warnings": []
}
```

Checker issue：

```ts
interface ContinuationCanonIssue {
  issueId: string;
  category:
    | 'character'
    | 'world'
    | 'relationship'
    | 'plot'
    | 'experience'
    | 'boundary'
    | 'locked_rule';

  severity: 'warning' | 'error' | 'blocking';
  confidence: number;

  generatedStart: number | null;
  generatedEnd: number | null;
  generatedExcerpt: string;

  description: string;
  evidenceIds: number[];
  suggestedFix: string;

  repairReady: boolean;
}
```

### 5.3 可进入 Repair 的条件

Checker issue 只有同时满足以下条件，才能 `repairReady=true`：

1. 有合法正文范围，或 excerpt 能在 Writer 中唯一定位；
2. 有明确 evidence；
3. 有具体问题描述；
4. 有直接修订动作；
5. severity 为 `error` 或 `blocking`；
6. 与当前 Writer artifact hash 精确绑定。

普通 warning 只展示，不进入 Repair。

### 5.4 示例

```json
{
  "issueId": "checker_1",
  "category": "relationship",
  "severity": "error",
  "confidence": 0.96,
  "generatedStart": 1280,
  "generatedEnd": 1312,
  "generatedExcerpt": "她第一次听说这个名字。",
  "description": "冻结经历显示该人物此前已经见过并讨论过此人。",
  "evidenceIds": [381, 402],
  "suggestedFix": "改写为她认出该名字，并表现出与既有经历一致的反应。",
  "repairReady": true
}
```

---

## 6. Control 新契约：原著文风审查

修改：

```text
src/services/continuation/generation/continuationControl.ts
src/services/continuation/generation/types.ts
src/services/continuation/generation/continuationV4PromptCompiler.ts
```

### 6.1 输入

Control 接收：

- Writer 完整正文；
- Writer artifact hash；
- 原著风格画像；
- 风格画像 revision；
- 每个关键维度的少量代表性原文片段；
- 用户明确风格要求；
- 动态参考字数，仅用于识别“凑字数痕迹”，不作为目标。

### 6.2 风格维度

```ts
type ContinuationStyleDimension =
  | 'narrative_voice'
  | 'pov'
  | 'sentence_rhythm'
  | 'dialogue_voice'
  | 'emotional_expression'
  | 'description_density'
  | 'subtext'
  | 'scene_transition'
  | 'ai_template'
  | 'padding';
```

### 6.3 输出

```ts
interface ContinuationStyleIssue {
  findingId: string;
  styleDimension: ContinuationStyleDimension;

  severity: 'warning' | 'error';
  confidence: number;

  generatedStart: number | null;
  generatedEnd: number | null;
  generatedExcerpt: string;

  description: string;
  styleEvidenceIds: string[];
  rewriteGoal: string;
  preserveMeaning: string[];

  repairReady: boolean;
}

interface ContinuationStyleControlReport {
  schemaVersion: 2;
  writerArtifactHash: string;
  styleProfileRevision: number | null;
  issues: ContinuationStyleIssue[];
  warnings: ContinuationStyleIssue[];
  summary: {
    reviewedDimensions: ContinuationStyleDimension[];
    actionableIssueCount: number;
    auditWarningCount: number;
  };
}
```

### 6.4 Control Prompt 原则

必须明确：

```text
风格画像和代表片段用于判断整体倾向，不是逐项打勾的写作规范。

只有出现清晰、局部、可引用、可修订的文风偏离时才输出 issue。
无法定位的整体感觉只能放入 warnings。
不要因为正文没有同时体现所有风格特征就判错。
不要要求补 Beat、增加冲突或改变剧情。
不要根据参考字数要求扩写或压缩。
```

### 6.5 可进入 Repair 的风格问题

同时满足：

1. 有准确范围或唯一 excerpt；
2. 有风格 evidence；
3. confidence 达到集中配置阈值；
4. rewriteGoal 清晰；
5. preserveMeaning 非空；
6. 不要求新增事实；
7. 不要求重构整章；
8. `repairReady=true`。

建议将阈值集中配置，例如：

```ts
STYLE_REPAIR_CONFIDENCE_MIN
```

不得散落多个魔法数字。

### 6.6 示例

```json
{
  "findingId": "style_1",
  "styleDimension": "emotional_expression",
  "severity": "error",
  "confidence": 0.91,
  "generatedStart": 2450,
  "generatedEnd": 2580,
  "generatedExcerpt": "他感到非常悲伤，因为他终于意识到自己已经失去了一切……",
  "description": "原著通常通过动作、停顿和短句表现情绪，此处连续直接解释心理，明显偏离原著表达。",
  "styleEvidenceIds": [
    "style_sample_7",
    "style_profile_emotion_2"
  ],
  "rewriteGoal": "保留人物悲伤和事件事实，删除解释性心理，用动作、停顿或简短对白表现。",
  "preserveMeaning": [
    "人物意识到损失",
    "情绪为悲伤",
    "不得改变当前事件结果"
  ],
  "repairReady": true
}
```

---

## 7. Repair 触发规则

修改：

```text
src/services/continuation/generation/continuationV4Runner.ts
```

新逻辑：

```ts
const actionableCheckerIssues =
  checkerIssues.filter(issue => issue.repairReady);

const actionableStyleIssues =
  controlIssues.filter(issue => issue.repairReady);

const actionableLocalSafetyIssues =
  localSafetyIssues.filter(isHardLocalSafetyIssue);

const shouldRepair =
  actionableCheckerIssues.length > 0 ||
  actionableStyleIssues.length > 0 ||
  actionableLocalSafetyIssues.length > 0;
```

不得再由以下条件触发 Repair：

```text
字数偏长
字数偏短
Control action != keep
Beat 覆盖不足
段落长度不均
对话比例偏差
无定位的风格 warning
```

只有字数 warning 时：

- 跳过 Repair；
- Writer 保持默认 eligible；
- UI 展示参考字数偏差。

---

## 8. Repair Prompt：最小干预 + 完整终稿

### 8.1 核心原则

Repair Prompt 必须包含：

```text
你是最小干预修订者，不是重新创作整章。

只修改 Checker 和 Control 明确标出的原文范围，以及保证上下文自然所需的最小接缝。

未被标记的段落、人物语气、叙述节奏、留白和语言表达尽量保持不变。

用户配置的参考篇幅只用于理解章节体量，不是修订任务。
不得为了接近参考字数增加或删除内容。
```

### 8.2 两组任务

Prompt 分为：

```text
【Checker：五维资料一致性修订】
【Control：原著文风修订】
```

执行顺序：

1. 先修 Checker 的事实问题；
2. 再修 Control 的风格问题；
3. 不处理 audit-only warnings；
4. 不统一润色全文；
5. 不改写未标记段落；
6. 不新增 Canon、人物经历或剧情事实。

### 8.3 完整终稿硬约束

必须明确：

```text
你的修改范围可以很小，但输出范围必须覆盖整篇章节。

即使只修改一句话，也必须返回从章节开头到自然结尾的完整终稿。
未修改部分必须与修改部分一起输出。

禁止只输出：
- 修改片段；
- 新增段落；
- Patch；
- offset；
- replacement；
- 修改说明；
- 摘要；
- 大纲；
- “其余内容保持不变”；
- “以下为修改部分”。
```

### 8.4 Envelope 保持完整

```json
{
  "schemaVersion": 1,
  "content": "完整章节终稿",
  "appliedCheckerIssueIds": [],
  "appliedControlFindingIds": [],
  "unappliedItems": []
}
```

可继续兼容旧的：

```text
appliedControlSuggestionIds
```

但新版不再以篇幅 suggestion 为语义。

### 8.5 防止凑字数和八股文

Prompt 必须明确禁止：

```text
不得为了接近参考字数：
- 新增解释性心理；
- 重复人物反应；
- 堆叠环境描写；
- 扩展无新信息对白；
- 添加总结性句子；
- 机械重复风格画像中的特征。
```

---

## 9. Repair 完整性与防坍缩门禁

修改：

```text
src/services/continuation/generation/continuationV4Runner.ts
```

字数目标弱化，不代表完整章节约束弱化。

### 9.1 必须硬拦截

新增或保留：

```text
repair_empty_content
repair_partial_output
repair_summary_output
repair_content_collapsed
repair_missing_unaffected_sections
repair_envelope_leakage
repair_prompt_leakage
self_duplicate
future_leakage
source_overlap
```

### 9.2 不以目标字数判定坍缩

防坍缩不能使用：

```text
未达到 targetChapterChars
低于 allowedMinHan
```

作为 blocking。

完整性判断应基于 Writer 与 Repair 的关系。

### 9.3 段落保留检查

实现纯本地检查：

1. 将 Writer 和 Repair 切分为自然段；
2. 标记 Checker / Control 目标段落；
3. 对未被任务标记的段落计算保留情况；
4. 检查章节开头、中段和结尾是否仍存在；
5. 允许目标段落及必要接缝发生变化；
6. 大量未涉及段落整体消失时判定坍缩。

建议新增：

```ts
interface RepairCompletenessMetrics {
  writerParagraphCount: number;
  candidateParagraphCount: number;
  targetedWriterParagraphCount: number;
  unaffectedWriterParagraphCount: number;
  retainedUnaffectedParagraphCount: number;
  unaffectedRetentionRatio: number;
  openingAnchorRetained: boolean;
  middleAnchorRetained: boolean;
  endingAnchorRetained: boolean;
  candidateToWriterHanRatio: number;
}
```

### 9.4 阈值集中管理

允许设置防坍缩安全阈值，但它们必须：

- 集中在一个 policy 模块；
- 与用户目标字数无关；
- 用于章节完整性，不用于篇幅达标；
- 有测试与真实样本校准；
- 不散落硬编码。

例如：

```ts
interface RepairCompletenessPolicy {
  minUnaffectedParagraphRetentionRatio: number;
  minCandidateToWriterHanRatio: number;
  requireOpeningAnchor: boolean;
  requireMiddleAnchor: boolean;
  requireEndingAnchor: boolean;
}
```

初始默认值由实现 Agent 根据现有测试样本和真实失败案例提出，并在报告中说明依据。

### 9.5 组合判定

不得仅凭单一词语或单一字数比例阻断。

建议 blocking 条件为组合证据，例如：

```text
未涉及段落保留率严重不足
+
开头/中段/结尾至少一个关键锚点缺失
```

或：

```text
正文相对 Writer 大幅缩短
+
段落数显著下降
+
出现摘要式表达
```

### 9.6 摘要和占位检测

检测：

```text
本章主要讲述
随后众人
经过一番
最终他们
以上为修订
其余内容不变
以下为修改部分
```

这些只能作为辅助证据，不能单独 blocking。

---

## 10. Repair 合规验证

### 10.1 Checker

对每个强制 Checker issue：

- ID 必须回填；
- 原问题范围必须真实改变；
- evidence 相关事实不得继续冲突；
- 未知 ID 拒绝；
- `unappliedItems` 非空拒绝。

### 10.2 Control

对每个 `repairReady=true` 的风格问题：

- finding ID 必须回填；
- 目标范围必须真实改变；
- preserveMeaning 不能被破坏；
- 原模板化问题句若完整保留，判定未修改；
- audit-only warning 不要求回填。

### 10.3 不增加第二次 LLM

本地只能验证：

- 是否改了；
- 是否保留完整章节；
- 是否有泄漏、重复和明显安全问题；
- 是否回填正确 ID。

本地不能宣称已经完成第二次语义或文学质量复核。

UI 必须明确：

```text
Repair 已完成本地完整性与协议检查，未进行第二次 LLM 语义复核。
```

---

## 11. 默认候选选择

### 11.1 Writer 为文学基线

- Checker / Control 无可执行问题：Writer 默认 eligible；
- 只有字数 warning：Writer 默认 eligible；
- 只有 audit warning：Writer 默认 eligible；
- Repair 被跳过：Writer 默认 eligible。

### 11.2 Repair 成为默认候选的条件

Repair 必须同时满足：

1. 实际修复至少一个明确问题；
2. 完整章节输出；
3. 未发生坍缩；
4. 未引入新的本地安全问题；
5. 未大规模改写无关段落；
6. Local Final Gate 通过。

### 11.3 大范围改写保护

当 Repair 修改了大量未标记段落时：

- 不自动设为默认；
- 标记为“需人工比较”；
- Writer 仍保留。

不要建立复杂文学评分，只做最小干预保护。

---

## 12. UI 调整

修改：

```text
src/screens/continuation/ContinuationResultScreen.tsx
```

### 12.1 新角色文案

- Checker：`原著五维资料一致性审查`
- Control：`原著文风一致性审查`
- Repair：`精准最小干预修订，输出完整章节`
- Local Final Gate：`完整性与确定性安全检查`

### 12.2 字数展示

显示：

```text
用户参考篇幅：3200
实际汉字：2875
篇幅仅作提示，不影响候选资格
```

不得显示：

```text
最低必须增加
最低必须减少
Control 进度通过/失败
```

### 12.3 Repair 跳过

```text
未发现需要自动修订的五维资料或文风问题，保留 Writer 原稿。
```

### 12.4 Repair 被拒绝

```text
Repair 已返回候选正文，但未通过完整性或安全检查。
当前默认可采纳候选为 Writer 初稿。
```

根据原因补充：

- `Repair 只返回了局部内容或摘要。`
- `Repair 丢失了大量未修改正文。`
- `Repair 仍保留明确问题。`
- `Repair 引入了重复或协议内容。`

### 12.5 Repair 通过

```text
Repair 已完成精准修订，并通过完整章节与本地安全检查。
未进行第二次 LLM 语义复核。
```

---

## 13. Telemetry

利用现有 JSON 字段，不新增数据库迁移。

建议记录：

```ts
{
  referenceTargetHan: number;
  actualWriterHan: number;
  lengthWarningSubtypes: string[];

  checkerActionableIssueCount: number;
  checkerAuditWarningCount: number;

  styleActionableIssueCount: number;
  styleAuditWarningCount: number;
  reviewedStyleDimensions: string[];

  repairTriggeredBy: Array<
    'checker' | 'style_control' | 'local_safety'
  >;

  appliedCheckerIssueCount: number;
  appliedStyleFindingCount: number;

  writerParagraphCount: number;
  repairParagraphCount: number;
  unaffectedRetentionRatio: number;
  openingAnchorRetained: boolean;
  middleAnchorRetained: boolean;
  endingAnchorRetained: boolean;
  candidateToWriterHanRatio: number;

  repairCompletenessPassed: boolean;
  repairMinimalInterventionPassed: boolean;
}
```

禁止记录：

- API key；
- 完整 Prompt；
- 完整模型请求头；
- 不必要的完整正文副本。

---

## 14. 建议修改文件

| 文件 | 修改内容 |
|---|---|
| `src/services/continuation/generation/types.ts` | 新 Checker / Style Control / completeness 类型 |
| `src/services/continuation/generation/continuationV4PromptCompiler.ts` | Writer 松绑、Checker 五维、Control 风格、Repair 完整终稿 |
| `src/services/continuation/generation/continuationChecker.ts` | 五维 issue 归一化与 repair-ready |
| `src/services/continuation/generation/continuationControl.ts` | 从篇幅 Control 改为风格审查解析 |
| `src/services/continuation/generation/continuationV4Runner.ts` | 新 Repair 触发、去除字数硬门禁、完整性检查 |
| `src/services/continuation/generation/repairCompletenessPolicy.ts` | 集中防坍缩 policy |
| `src/screens/continuation/ContinuationResultScreen.tsx` | 新职责、弱字数提示、完整性状态 |
| `__tests__/continuationCheckerV4.test.ts` | 五维审查契约 |
| `__tests__/continuationControl.test.ts` | 风格 issue 契约 |
| `__tests__/continuationV4PromptCompiler.test.ts` | Writer 松绑与 Repair 完整输出 |
| `__tests__/continuationV4Workflow.test.ts` | 新触发、字数弱提示、坍缩拒绝 |
| `__tests__/continuationV4Resume.test.ts` | 四请求、恢复兼容 |
| UI 测试 | 新状态文案 |

---

## 15. 测试方案

### 15.1 动态字数注入

使用不同用户配置：

- 1800；
- 3200；
- 6000。

断言：

- Writer Prompt 动态变化；
- 没有业务目标硬编码；
- 字数只产生 warning；
- 不因字数单独触发 Repair。

### 15.2 Writer 无问题但偏长

- Writer 超过参考区间；
- Checker 无 actionable issue；
- Control 无 actionable style issue。

预期：

- Repair 跳过；
- Writer eligible；
- UI 显示篇幅 warning。

### 15.3 Checker 五维问题

构造人物关系冲突。

预期：

- Checker 输出可定位、带 evidence 的 issue；
- Repair 被触发；
- Repair 修改目标句；
- 输出整篇章节；
- 未涉及段落保留。

### 15.4 Control 文风问题

构造局部模板化心理：

```text
他感到非常悲伤，因为他意识到……
```

提供原著克制表达 evidence。

预期：

- Control 输出精准 style issue；
- Repair 只修改目标区域；
- preserveMeaning 保持；
- 输出整篇章节；
- 无关段落不大幅变化。

### 15.5 抽象风格 warning

Control 只返回：

```text
整体节奏略显平淡
```

且无范围、无 evidence。

预期：

- audit-only；
- 不触发 Repair；
- Writer eligible。

### 15.6 Repair 返回片段

Repair 只返回一个修订段落。

预期：

- `repair_partial_output` blocking；
- Repair rejected；
- Writer 保留。

### 15.7 Repair 返回摘要

Repair 输出剧情概述。

预期：

- 完整性组合检查失败；
- `repair_summary_output` 或 `repair_content_collapsed`；
- Repair rejected。

### 15.8 Repair 丢失未修改部分

- 目标只在中部一个段落；
- Repair 删除开头或结尾大段。

预期：

- opening / ending anchor 失败；
- unaffected retention 失败；
- Repair rejected。

### 15.9 Repair 完整且最小修改

- 只修改一个事实问题；
- 全文完整返回；
- 大部分未涉及段落保持。

预期：

- completeness 通过；
- minimal intervention 通过；
- Repair eligible。

### 15.10 四请求与恢复

断言：

- Writer 1；
- Checker 1；
- Control 1；
- Repair 0 或 1；
- 总数最多 4；
- resume 不重复 reservation；
- 无新 migration。

---

## 16. 安卓模拟器与真实 API 验收

本机模拟器已启动。

测试 API key 位于：

```text
D:\AiWorkSpace\tavo-mini\docs\TEST-KEY.txt
```

### 16.1 安全要求

Agent 可以读取该文件用于本机真实测试，但必须：

- 不显示 key；
- 不 echo；
- 不复制到源码；
- 不写入测试；
- 不写入文档；
- 不放入命令行参数；
- 不写入 Git tracked 配置；
- 不出现在截图、日志和最终报告；
- 不修改 `TEST-KEY.txt`；
- 仅使用项目现有安全凭据配置机制；
- 测试结束清理临时环境变量；
- 最后检查 `git status` 和 `git diff`。

如果发现 `TEST-KEY.txt` 被 Git 跟踪或进入 diff，立即停止真实 API 测试并报告。

### 16.2 设备确认

执行：

```text
adb devices
```

确认设备状态为 `device`。

禁止：

- wipe data；
- 清空全部应用数据；
- 覆盖用户真实项目；
- 无限制重复调用 API。

### 16.3 实机场景

#### 场景 A：只有字数偏差

预期：

- Writer 完整生成；
- Checker / Control 无 actionable issue；
- Repair 跳过；
- Writer 默认候选；
- 字数仅 warning。

#### 场景 B：五维事实问题

预期：

- Checker 精准定位；
- Repair 修改；
- 输出完整章节；
- Local Final Gate 通过。

#### 场景 C：局部文风问题

预期：

- Control 精准定位；
- Repair 最小修改；
- 无关段落保持；
- 完整章节输出。

#### 场景 D：坍缩模拟

优先使用测试 fixture 或 mock，不依赖模型随机失败。

预期：

- 片段或摘要被 blocking；
- Writer 安全回退；
- UI 文案准确。

真实 API 完整 V4 流水线建议最多 2 次；失败后先分析证据，不盲目重跑。

---

## 17. 完成标准

只有同时满足以下条件，才算完成：

1. 字数来自用户配置动态注入；
2. 字数只作弱提示；
3. 字数偏差不单独触发 Repair；
4. Checker 只审查原著五维资料与硬规则；
5. Control 改为原著文风审查；
6. Control 不再输出篇幅强制动作；
7. Checker / Control 只有精准可执行问题才进入 Repair；
8. 抽象 warning 不进入 Repair；
9. Repair 只做最小干预；
10. Repair 始终输出完整章节；
11. 片段、Patch、摘要、占位表达被拒绝；
12. 未涉及段落大量丢失被拒绝；
13. 防坍缩不依赖用户目标字数；
14. self-duplicate、future leakage、协议泄漏继续硬拦截；
15. Writer 是无问题时的默认文学基线；
16. Repair 通过完整性、安全和最小干预后才能成为默认候选；
17. 总请求不超过 4；
18. resume / reservation 安全保持；
19. 无数据库 migration；
20. V1 / V2 无回归；
21. targeted tests、typecheck、lint、verify 通过；
22. 模拟器真实场景有可审计结果；
23. API key 未泄漏。

---

## 18. Agent 实施顺序

1. 检查当前工作树、分支和未提交修改；
2. 阅读现有设计文档与相关调用链；
3. 列出拟修改文件和明确不修改范围；
4. 调整类型；
5. 松绑 Writer Prompt；
6. 重构 Checker 契约；
7. 将 Control 改为风格审查；
8. 修改 Repair 触发条件；
9. 重写 Repair Prompt；
10. 实现完整性与防坍缩 policy；
11. 修改 Local Final Gate；
12. 修改默认候选逻辑；
13. 修改 UI 和 telemetry；
14. 添加 targeted tests；
15. 运行 typecheck、lint、测试和 verify；
16. 构建 debug APK；
17. 覆盖安装模拟器；
18. 进行最多两次真实 API 流水线；
19. 检查安全与 Git diff；
20. 输出实施报告。

---

## 19. 最终原则

> 字数来自用户配置，但只是参考。  
> Checker 负责原著五维资料准确。  
> Control 负责原著文风一致。  
> Repair 只做精准、最小范围修改。  
> Repair 修改范围可以很小，但输出必须是整篇完整章节。  
> 系统应保护文学表达，而不是把小说变成指标合格的八股文。
