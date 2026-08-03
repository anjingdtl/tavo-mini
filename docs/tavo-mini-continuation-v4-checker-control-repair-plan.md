# Tavo Mini 续写 V4 Checker / Control 修复方案

> 适用仓库：`anjingdtl/tavo-mini`  
> 适用流水线：Continuation V4  
> 目标：增强 Checker 与 Control 对 Repair 的任务下发、追踪和验收能力。  
> 明确非目标：**不取消 Local Final Gate 对篇幅问题的软化策略**，不把“最终必须落入合法字数区间”重新变成硬阻断。

---

## 1. 问题结论

当前问题不是 Checker、Control 完全没有注入 Repair，而是两条控制链都存在“任务不够可执行、执行结果不够可验收”的缺口。

### 1.1 Control 当前缺口

当前代码允许以下组合被当作有效结果：

```json
{
  "action": "expand",
  "suggestions": []
}
```

这会导致：

1. Control 确认需要扩写；
2. Repair 收到 `action=expand`、当前字数和合法区间；
3. 但没有任何必须回填的 `suggestionId`；
4. Repair 只要比 Writer 多几个字，就可能通过当前方向校验；
5. 结果页显示 `Control suggestion 0 项`。

本质上，Control 只发出了方向指令，没有形成稳定、可追踪、可量化验收的修订任务。

### 1.2 Checker 当前缺口

Checker Prompt 与 Parser 的字段协议不一致：

| Prompt 要求 | Parser 实际读取 |
|---|---|
| `draftQuote` | `generatedExcerpt` |
| `suggestedAction` | `suggestedFix` |

模型按 Prompt 正确输出时，Parser 可能读取不到定位文本和修复建议。严重问题随后会因为缺少完整可执行字段，被自动从 `error/blocking` 降级为 `warning`，Repair 因而不必强制落实。

此外，当前 Runner 还有两个关联问题：

1. Checker 要求回显 `writerArtifactHash`，但解析流程没有验证该回显是否与当前 Writer artifact 一致。
2. Writer 的本地安全检查可以触发 Repair，但 `runRepairNode` 实际只接收 `checker.persistedIssues`。除篇幅外的本地安全问题可能触发了 Repair，却没有作为明确任务注入 Repair。

### 1.3 最终门禁策略

Local Final Gate 对 `chapter_length_*` 降级为 warning 是现有产品策略，本次保持不变。

本次修复的目标是：

- Repair 必须进行**可证明的实质修订**；
- 允许 Repair 经过实质修订后仍未完全达到目标字数；
- 禁止“只多一个字”“只改标点”“只回填 ID”被视为已经完成 Control 或 Checker 的任务。

---

## 2. 修复目标

1. Checker、Control 向 Repair 下发的每一项强制任务都有稳定 ID。
2. Repair 必须声明自己落实了哪些 Checker issue、Control suggestion。
3. 客户端必须验证 Repair 不只是声明落实，而是实际产生了对应方向的有效变化。
4. 本地确定性结果优先于模型回显。
5. 保留 V4 的四次物理请求上限，不增加复查请求。
6. 不引入数据库 Schema 迁移。
7. 不修改 V1/V2 行为。
8. 保留最终篇幅软门禁。

---

## 3. 设计原则

### 3.1 本地真值优先

以下内容以客户端本地计算为权威：

- 当前汉字数；
- 目标汉字数；
- 最低和最高合法区间；
- Control 的长度方向：`expand / compress / keep`；
- Writer 与 Repair 的实际字数变化；
- artifact hash；
- 本地重复、泄漏和接缝重合检查。

模型只能补充具体编辑建议，不能覆盖本地真值。

### 3.2 先标准化，再判断严重度

Checker 的字段别名必须先统一成内部标准字段，再执行：

- 严重度校验；
- evidence 校验；
- artifact 定位；
- warning 降级。

不能因为 Prompt 和 Parser 命名不同而意外降级。

### 3.3 有任务就必须可追踪

只要本地或模型判断需要 Repair，就必须形成至少一个稳定任务 ID：

- Checker：使用持久化后的 check ID；
- Control：使用稳定的 suggestion ID；
- 本地安全检查：使用持久化后的 check ID；
- 篇幅由 Control 的本地 suggestion 负责，不重复作为 Checker task 注入。

### 3.4 软门禁不等于无验收

最终长度可以继续是 warning，但 Control 的“扩写/压缩”必须达到最低实质进度。

---

## 4. Checker 修复方案

### 4.1 统一 Checker 输出协议

修改文件：

- `src/services/continuation/generation/continuationV4PromptCompiler.ts`
- `src/services/continuation/generation/continuationChecker.ts`
- `src/services/continuation/generation/continuationV4Runner.ts`
- `src/services/continuation/generation/types.ts`

Checker 的标准输出建议统一为：

```json
{
  "schemaVersion": 1,
  "writerArtifactHash": "当前 Writer artifact hash",
  "issues": [
    {
      "issueId": "checker_model_1",
      "category": "plot",
      "subtype": "canon_conflict",
      "severity": "error",
      "confidence": 0.95,
      "generatedStart": 120,
      "generatedEnd": 138,
      "generatedExcerpt": "问题原句",
      "description": "与冻结 Canon 冲突",
      "evidenceIds": [39],
      "suggestedFix": "改写为符合冻结事实的表述"
    }
  ],
  "warnings": []
}
```

Prompt 不再使用 `draftQuote`、`suggestedAction` 作为主字段。

### 4.2 Parser 保留旧字段兼容

为了兼容模型缓存、旧测试和不同模型的输出习惯，Parser 应接受以下别名：

```ts
const generatedExcerpt =
  item.generatedExcerpt ??
  item.draftQuote ??
  item.quote ??
  '';

const suggestedFix =
  item.suggestedFix ??
  item.suggestedAction ??
  item.fix ??
  '';

const generatedStart =
  item.generatedStart ??
  item.draftStart ??
  null;

const generatedEnd =
  item.generatedEnd ??
  item.draftEnd ??
  null;
```

执行顺序必须是：

1. 读取并标准化别名；
2. 标准化字符串、数组和范围；
3. 绑定 artifact；
4. 过滤 evidence；
5. 最后决定是否需要降级为 warning。

### 4.3 新增 Checker envelope 解析

建议新增：

```ts
parseCheckerLlmEnvelope(raw: string): {
  schemaVersion: 1;
  writerArtifactHash: string | null;
  issues: RawCheckIssue[];
}
```

保留 `parseCheckerLlmJson` 作为兼容包装函数，避免无关调用方一次性改动过大。

V4 Runner 使用 envelope parser，并验证：

```ts
parsed.writerArtifactHash === artifact.contentHash
```

处理规则：

- hash 一致：正常绑定和持久化；
- hash 缺失或不一致：本次 Checker 结果不可用；
- 标记 Checker stage 为失败或降级；
- 不采用这些 LLM issues；
- 不发起额外请求；
- 本地检查和 Control 仍可继续驱动 Repair。

建议错误码：

```text
checker_artifact_hash_missing
checker_artifact_hash_mismatch
```

### 4.4 修复 persisted issue 匹配

当前 `persistedCheckerIssues()` 只按以下三项匹配：

```text
subtype + description + generatedExcerpt
```

存在重复项误匹配或漏匹配风险。

建议改为无 Schema 迁移的稳定 fingerprint：

```text
category
subtype
severity
generatedStart
generatedEnd
generatedExcerpt
description
sorted evidenceIds
suggestedFix
```

持久化后重新查询 artifact 的 checks，再通过 fingerprint 找回本次 Checker 对应的 DB rows。

### 4.5 将本地安全问题明确注入 Repair

当前 Pipeline 中：

```ts
const checkerIssues = checker?.persistedIssues ?? [];
const localSafetyIssues = writerChecks.filter(...);
```

`localSafetyIssues` 会参与是否启动 Repair 的判断，但 `runRepairNode()` 只收到 `checkerIssues`。

修改为：

```ts
const localRepairIssues = localSafetyIssues.filter(
  issue => !issue.subtype.startsWith('chapter_length_'),
);

const repairIssues = dedupePersistedChecks([
  ...checkerIssues,
  ...localRepairIssues,
]);
```

然后向 Repair 传入 `repairIssues`。

说明：

- `chapter_length_*` 不注入 Checker task，避免和 Control 重复；
- `source_overlap`、`continuation_anchor_overlap`、`future_leakage`、`self_duplicate` 等本地安全问题必须作为明确任务注入；
- Prompt 标题改为：

```text
【Checker / 本地安全审查报告】
```

### 4.6 Checker Repair 合规校验

保留现有规则：

- 所有 `error/blocking` issue 必须出现在 `appliedCheckerIssueIds`；
- 未知 issue ID 拒绝；
- `unappliedItems` 非空拒绝；
- 问题原句完整保留时拒绝。

补充规则：

1. `generatedExcerpt` 有效时，Repair 不能只回填 ID 而保留原句；
2. Writer 与 Repair 归一化后完全相同，继续拒绝；
3. 本地安全 issue 同样使用持久化 check ID 参与审计；
4. warning 继续展示，但不强制 Repair 回填；
5. 不增加第二次语义 Checker 请求，UI 继续明确“Repair 后未进行二次语义模型复查”。

---

## 5. Control 修复方案

### 5.1 Control action 必须来自本地指标

`buildContinuationControlFallback(metrics)` 生成的 action 作为权威 action：

```ts
const localReport = buildContinuationControlFallback(metrics);
const authoritativeAction = localReport.action;
```

模型返回的 action 只作为回显诊断，不得覆盖本地 action。

例如本地低于最低线时，即使模型返回：

```json
{
  "action": "keep"
}
```

最终 report 仍必须是：

```json
{
  "action": "expand"
}
```

### 5.2 非 keep 状态必须注入本地强制 suggestion

当本地 action 为 `expand` 或 `compress` 时，必须始终保留本地 suggestion：

```text
ctrl_local_expand
ctrl_local_compress
```

模型 suggestion 只能补充，不能删除本地 suggestion。

合并建议：

```ts
const suggestions = dedupeBySuggestionId([
  ...localReport.suggestions,
  ...normalizedModelSuggestions,
]);
```

因此下列模型结果：

```json
{
  "action": "expand",
  "suggestions": []
}
```

最终也必须包含：

```json
{
  "suggestions": [
    {
      "suggestionId": "ctrl_local_expand",
      "expectedDeltaHan": 367,
      "instruction": "至少朝最低线进行实质扩写……"
    }
  ]
}
```

### 5.3 过滤方向错误的模型 suggestion

模型 suggestions 必须满足：

- `suggestionId` 非空且唯一；
- `instruction` 非空；
- `expectedDeltaHan` 是有限数字；
- expand 时 `expectedDeltaHan > 0`；
- compress 时 `expectedDeltaHan < 0`；
- keep 时只接受与模型 `action=keep` 一致的结构建议。

建议策略：

- 本地 action 与模型 action 不一致时，丢弃模型 suggestions，仅保留本地建议；
- 本地 action 与模型 action 一致时，合并合法模型建议；
- 本地数字字段始终覆盖模型数字字段；
- `preserve` 使用本地与模型的去重并集。

### 5.4 增加 Control 诊断信息

建议在 report 或 stage telemetry 中记录：

```ts
{
  metricEchoMismatch: boolean;
  actionEchoMismatch: boolean;
  localSuggestionInjected: boolean;
  droppedSuggestionCount: number;
}
```

这些字段用于 UI 和调试，不影响 Repair 的业务协议。

### 5.5 Repair 必须回填本地 Control suggestion ID

只要本地 action 不是 `keep`，Repair 必须在：

```json
"appliedControlSuggestionIds": []
```

中包含：

```text
ctrl_local_expand
```

或：

```text
ctrl_local_compress
```

缺失时产生：

```text
repair_control_suggestion_unapplied
```

并拒绝 Repair candidate。

### 5.6 增加“最低实质进度”校验

当前只检查：

```ts
expand   => candidateHan > writerHan
compress => candidateHan < writerHan
```

该条件过弱。

建议新增统一 helper：

```ts
const CONTROL_PROGRESS_RATIO = 0.35;
const CONTROL_PROGRESS_FLOOR_HAN = 80;

function requiredControlProgressHan(requiredDeltaHan: number): number {
  const delta = Math.abs(requiredDeltaHan);
  if (delta === 0) return 0;
  return Math.min(
    delta,
    Math.max(
      CONTROL_PROGRESS_FLOOR_HAN,
      Math.ceil(delta * CONTROL_PROGRESS_RATIO),
    ),
  );
}
```

验收规则：

#### expand

满足以下任一条件即可：

1. Repair 已达到 `allowedMinHan`；
2. Repair 实际增加字数达到 `requiredControlProgressHan(missingToMinimum)`。

#### compress

满足以下任一条件即可：

1. Repair 已低于或等于 `allowedMaxHan`；
2. Repair 实际减少字数达到 `requiredControlProgressHan(excessOverMaximum)`。

这能达到两个目标：

- 2133 → 2134 不再算完成；
- 2133 → 2300 可以被视为进行了实质扩写，即使还没有达到 2500，最终长度仍可由软门禁作为 warning 处理。

建议错误码：

```text
repair_control_insufficient_progress
```

说明：

- 35% 和 80 汉字是建议默认值；
- 应定义为集中常量并写清注释；
- 不要散落魔法数字；
- 后续可以根据真实数据调整。

### 5.7 Control 的结构建议验收边界

客户端无法在不增加模型请求的情况下完整判断“某个场景是否真的扩写得更好”。

本次本地验收只保证：

- suggestion ID 被声明落实；
- 文本发生实质变化；
- 字数方向正确；
- 达到最低实质进度；
- 没有重复、泄漏、坍缩等本地安全问题。

语义质量仍由用户审阅和现有软门禁策略承担。

---

## 6. Repair Prompt 调整

修改：

`src/services/continuation/generation/continuationV4PromptCompiler.ts`

Repair Prompt 中明确写入：

1. 每一个强制 Checker / 本地安全 issue；
2. 每一个 Control suggestion；
3. Control 的本地权威 action；
4. 当前字数；
5. 与最低线或最高线的差值；
6. 最低实质进度要求；
7. 必须回填的 issue ID 和 suggestion ID。

建议增加一段：

```text
【本次必须完成的审计任务】
- 必须落实所有 severity=error/blocking 的 Checker / 本地安全 issue，并回填其 issueId。
- 必须落实所有 Control suggestion，并回填其 suggestionId。
- Control 要求 expand/compress 时，不能只做标点、措辞或少量字符变化；终稿必须达到客户端给出的最低实质进度。
- 最终篇幅未完全进入合法区间时仍可能作为 warning 保留，但没有实质进度会被直接拒绝。
```

---

## 7. UI 与可观测性

修改：

`src/screens/continuation/ContinuationResultScreen.tsx`

当前：

```text
应用 Checker issue 0 项、Control suggestion 0 项
```

只能表示 Repair 返回的 applied ID 数量，容易被理解为“没有注入”。

建议显示：

```text
Checker：注入 2 项强制任务，Repair 声明应用 2 项
Control：action expand，注入 1 项强制建议，Repair 声明应用 1 项
字数变化：2133 → 2305，增加 172；最低实质进度 129
最终篇幅：仍低于 2500，按软门禁记录 warning
```

建议在 Repair output / local verify output 中持久化：

```ts
{
  injectedCheckerIssueCount: number;
  appliedCheckerIssueCount: number;
  injectedControlSuggestionCount: number;
  appliedControlSuggestionCount: number;
  writerHan: number;
  candidateHan: number;
  actualDeltaHan: number;
  requiredProgressHan: number;
  controlProgressPassed: boolean;
}
```

不需要数据库新增列，可继续放在现有 JSON 字段中。

---

## 8. 建议修改文件

| 文件 | 修改内容 |
|---|---|
| `src/services/continuation/generation/continuationV4PromptCompiler.ts` | Checker 标准字段；Repair 强制任务和最低实质进度提示 |
| `src/services/continuation/generation/continuationChecker.ts` | Checker envelope parser；旧字段别名兼容；先标准化后降级 |
| `src/services/continuation/generation/continuationControl.ts` | 本地 action 权威；强制本地 suggestion；模型建议合并和过滤；进度 helper |
| `src/services/continuation/generation/continuationV4Runner.ts` | hash 校验；本地安全 issue 合并注入；Repair 合规增强；telemetry |
| `src/services/continuation/generation/types.ts` | Checker envelope、Control diagnostics 等类型 |
| `src/screens/continuation/ContinuationResultScreen.tsx` | 区分注入数量、应用数量和实际进度 |
| `__tests__/continuationV4PromptCompiler.test.ts` | Prompt 契约测试 |
| `__tests__/continuationControl.test.ts` | Control 归一化和本地 suggestion 测试 |
| `__tests__/continuationV4Workflow.test.ts` | Repair 合规和软门禁共存测试 |
| `__tests__/continuationV4Resume.test.ts` | 持久化、恢复和四请求上限回归 |
| Checker 相关现有测试文件或新建 `__tests__/continuationCheckerV4.test.ts` | Checker 字段兼容、hash、严重度测试 |

---

## 9. 测试方案

### 9.1 Checker 测试

必须覆盖：

1. Prompt 使用 `generatedExcerpt`、`suggestedFix`；
2. Parser 正常读取标准字段；
3. Parser 兼容 `draftQuote`、`suggestedAction`；
4. 旧字段经过标准化后，合法 error 不会被误降级为 warning；
5. evidence 不合法时仍按现有安全策略降级；
6. `writerArtifactHash` 一致时采用 issues；
7. hash 缺失或不一致时不采用 LLM issues；
8. 本地安全 issue 被注入 Repair；
9. `chapter_length_*` 不作为 Checker task 重复注入；
10. Repair 未回填本地安全 issue ID 时被拒绝；
11. Repair 回填 ID 但保留原问题句时被拒绝。

### 9.2 Control 测试

必须覆盖：

1. 低于最低线，模型返回 `expand + suggestions=[]`，最终仍有 `ctrl_local_expand`；
2. 低于最低线，模型返回 `keep`，最终 action 仍为 `expand`；
3. 高于最高线，模型返回 `expand`，最终 action 为 `compress`；
4. 模型数字回显不一致，本地数字不被覆盖；
5. expected delta 方向错误的 suggestion 被丢弃；
6. 模型合法建议与本地建议合并且去重；
7. Repair 未回填 `ctrl_local_expand` 时被拒绝；
8. Writer 2133 → Repair 2134，被判定为进度不足；
9. Writer 2133 → Repair 达到最低实质进度但仍低于 2500，Control 合规通过；
10. 上述候选的最终长度仍是 warning，Local Final Gate 的软化策略不变；
11. 达到合法区间时正常通过；
12. invalid JSON 时使用本地 fallback。

### 9.3 Pipeline 回归

必须覆盖：

1. 正常路径仍最多四次物理请求；
2. 不产生第五次请求；
3. Checker 失败但 Control 有任务时仍可 Repair；
4. Control 模型失败时本地 fallback 仍可驱动 Repair；
5. Checker 与 Control 都无任务时跳过 Repair；
6. resume 后不重复发出已 reservation 请求；
7. V1/V2 行为不变；
8. 无数据库 Schema 迁移。

---

## 10. 验收标准

修复完成后，必须满足：

1. 截图场景中，Control 不再出现 `action=expand` 但强制 suggestion 为 0。
2. Repair 如果没有回填 `ctrl_local_expand`，candidate 被拒绝。
3. Repair 只增加极少字符，candidate 被拒绝。
4. Repair 有明显扩写但仍未达到最低线，可以通过 Control 合规校验，并由最终软门禁记录 warning。
5. Checker 按 Prompt 输出 `draftQuote/suggestedAction` 时，不会因字段错位被意外降级。
6. 新 Prompt 改用标准内部字段。
7. Checker artifact hash 不一致时，issues 不会绑定到错误 artifact。
8. 本地安全 issue 触发 Repair 时，该 issue 会明确注入 Repair。
9. UI 能区分“注入任务数”和“Repair 声明应用数”。
10. `npm run verify` 通过。
11. V4 四请求上限不变。
12. 最终长度软门禁不变。

---

## 11. 实施顺序

建议按以下顺序实施，降低交叉故障：

1. 先补 Checker parser 的字段别名兼容和单元测试；
2. 修改 Checker Prompt 为标准字段；
3. 增加 Checker envelope 和 artifact hash 校验；
4. 修复本地安全 issue 注入 Repair；
5. 修改 Control report 归一化；
6. 强制注入本地 Control suggestion；
7. 增加 Repair 最低实质进度校验；
8. 增加 telemetry 和 UI 文案；
9. 补 resume、请求上限和 V2 回归测试；
10. 执行 targeted tests；
11. 执行 `npm run verify`。

---

## 12. Agent 执行提示词

```text
请在仓库 anjingdtl/tavo-mini 的当前工作树中，修复 Continuation V4 流水线中 Checker 和 Control 对 Repair 控制力不足的问题。

先阅读并严格执行本修复方案文档。开始修改前，请重新检查当前 main/工作树中的以下文件，避免基于旧代码直接套补丁：

- src/services/continuation/generation/continuationV4PromptCompiler.ts
- src/services/continuation/generation/continuationChecker.ts
- src/services/continuation/generation/continuationControl.ts
- src/services/continuation/generation/continuationV4Runner.ts
- src/services/continuation/generation/types.ts
- src/screens/continuation/ContinuationResultScreen.tsx
- __tests__/continuationV4PromptCompiler.test.ts
- __tests__/continuationControl.test.ts
- __tests__/continuationV4Workflow.test.ts
- __tests__/continuationV4Resume.test.ts

必须完成以下修复：

一、Checker
1. 将 V4 Checker Prompt 的 issue 标准字段统一为 generatedStart、generatedEnd、generatedExcerpt、suggestedFix。
2. Parser 同时兼容旧字段 draftQuote、suggestedAction、draftStart、draftEnd，并在严重度判断前完成字段标准化。
3. 新增或重构 Checker envelope parser，读取并校验 writerArtifactHash。
4. writerArtifactHash 缺失或与当前 Writer artifact hash 不一致时，不采用该 LLM issues，不额外重试，并记录明确错误码。
5. 改进 persisted Checker issue 的匹配，避免只按 subtype + description + excerpt 造成误匹配。
6. 将 Writer 的本地安全 error/blocking 检查合并进 Repair 的强制 issue 列表，但排除 chapter_length_*，篇幅仍由 Control 负责。
7. Repair 必须回填所有强制 Checker/本地安全 issue 的持久化 ID；只回填 ID 而保留原问题句时仍要拒绝。

二、Control
1. Control 的 action、currentHan、targetHan、allowedMinHan、allowedMaxHan 必须始终以本地 metrics 为权威。
2. 本地 action 为 expand/compress 时，必须始终保留 ctrl_local_expand 或 ctrl_local_compress，本地 suggestion 不得被模型空数组覆盖。
3. 模型 suggestions 只能补充本地 suggestion；过滤 action 不一致、expectedDeltaHan 符号错误、空 instruction、重复 ID 的 suggestion。
4. Repair 必须回填所有 Control suggestion ID。
5. 将当前“只要 candidate 比 Writer 多/少一个字就算有进展”的规则替换为最低实质进度规则：
   - CONTROL_PROGRESS_RATIO = 0.35
   - CONTROL_PROGRESS_FLOOR_HAN = 80
   - requiredProgress = min(abs(requiredDelta), max(80, ceil(abs(requiredDelta) * 0.35)))
   - 达到合法区间，或达到 requiredProgress，均视为完成 Control 的最低实质进度。
6. 最终篇幅门禁继续软化：chapter_length_* 在 Local Final Gate 中仍为 warning。不要把最终字数重新改为硬阻断。
7. 在现有 JSON telemetry/output 中记录注入任务数、应用任务数、Writer/Repair 汉字数、实际 delta、requiredProgress 和 progressPassed，不新增数据库 Schema。

三、UI
1. 结果页区分“注入 Checker issue 数”“Repair 应用 Checker issue 数”“注入 Control suggestion 数”“Repair 应用 Control suggestion 数”。
2. 展示 Writer → Repair 的字数变化、最低实质进度和最终长度 warning。
3. 不再用单独的“应用 0 项”暗示上游没有注入。

四、约束
1. 不增加任何 LLM 请求。
2. V4 物理请求上限仍为 4。
3. 不增加数据库迁移。
4. 不改变 V1/V2 行为。
5. 不移除当前 Local Final Gate 的长度软化策略。
6. 不做无关重构，不修改无关 UI。
7. 保持 resume/reservation 安全，不允许产生第 5 次请求。

五、测试
请补齐并运行至少以下测试：
- Checker 标准字段解析；
- Checker 旧字段别名兼容；
- Checker artifact hash mismatch；
- 本地安全 issue 注入 Repair；
- expand + suggestions=[] 自动注入 ctrl_local_expand；
- model action 与本地 action 冲突时本地 action 胜出；
- Repair 缺少 Control suggestion ID 被拒绝；
- 只增加 1 个汉字被判定进度不足；
- 达到最低实质进度但仍低于合法下限时，Control 合规通过且 Final Gate 只产生长度 warning；
- 四请求上限和 resume 回归；
- V1/V2 回归。

完成后运行 targeted tests 和 npm run verify。

最终报告必须包含：
1. 根因确认；
2. 修改文件清单；
3. 每项行为变化；
4. 测试命令与结果；
5. 是否保持四请求上限；
6. 是否保持最终长度软门禁；
7. 仍无法通过本地确定性校验的语义风险。

直接修改当前工作树。不要创建数据库迁移，不要推送远端，不要在未运行测试的情况下声称修复完成。
```
