# TAVO-MINI Continuation V4 工程问题补充修复方案（基于 7bad7d8 更新版）

> 项目目录：`D:\AiWorkSpace\tavo-mini`  
> 建议保存位置：`D:\AiWorkSpace\tavo-mini\docs\tavo-mini-v4-engineering-fixes-supplement.md`  
> 远端审查基线：`7bad7d8f997237a0b324649a8d6e27cf430bf6d9`  
> 前置提交：`1bb39e90aa5b1be6f81dd8916c20256d4a7ee788`  
> 本文状态：已根据 `continuation-v4-length-repair-fix-plan` 落地后的实际代码重新编写  
> 核心目标：修复新实现中的工程缺陷和语义回归，同时保留四请求上限、完整章节输出、Checker 五维审查、Control 文风审查和 Repair 防坍缩。

---

## 1. 远端审查结论

上一轮改造已经完成了以下内容：

- 共享字数契约改为目标值 `±30%`；
- Writer Prompt 增加 Beat 篇幅预算和深化引导；
- `chapter_length_under_target` 可以单独触发 Repair；
- Repair 必须增长并达到目标区间下限；
- 长度扩写模式将整篇 Writer 标记为 targeted；
- Control style finding 的 excerpt 开始向 Repair 传递；
- 引入统一任务清单和行内锚点；
- Writer 增加 `finishReason === 'length'` 检查；
- Repair 输出增加部分结构化失败诊断。

但当前实现存在两类问题：

### 1.1 产品语义回归

代码和 UI 仍声称“字数只作提示”，但低于下限时实际上会：

1. 生成 error 级别的 `chapter_length_under_target`；
2. 自动触发 Repair；
3. 要求候选必须比 Writer 更长；
4. 要求候选必须达到 `target × 0.7`；
5. 未达到时以 blocking 合规错误拒绝 Repair。

这已经不是弱提示，而是换了名称的字数硬门禁。

### 1.2 工程实现仍不完整

上一轮声称已修复的部分工程问题仍有残留：

- Prompt Compiler 仍把 style confidence 写死为 1；
- 仍用“保留原意”补造 `preserveMeaning`；
- 仍可能在 Prompt 层重新升级 `repairReady`；
- Control 没有验证模型回显的 Writer hash；
- 风格资料版本没有真实绑定；
- Repair 没有检查 `finishReason === 'length'`；
- Writer 截断仍落到通用 `writer_failed`；
- 重叠任务被跳过锚点后，任务清单仍声称存在锚点；
- 无范围的长度任务也被显示为有锚点；
- 实际 Repair Prompt 比预预算 Prompt 大得多；
- Checker / Control 任务被重复注入多次；
- failureDiagnostics 已持久化，但结果页没有真正展开显示；
- duplicate window 仍使用横跨正常正文的宽范围。

---

## 2. 必须先统一的产品边界

本轮工程修复必须以以下边界为准：

### 2.1 字数

- 用户设置的目标字数继续动态注入；
- 可以使用比例区间作为 Writer 的参考体量；
- 字数偏差只用于 Prompt、UI 和 telemetry；
- 字数偏差不得单独触发 Repair；
- 字数偏差不得决定 Repair eligibility；
- 不得要求 Repair 必须增长、缩短或进入区间；
- 不得因字数偏差将 Writer 标记为风险候选。

### 2.2 Checker

Checker 继续只负责：

- 人物；
- 世界规则；
- 人物关系；
- 剧情线；
- 人物经历；
- 续写边界；
- 用户锁定规则；
- 明确时间、状态和 future leakage。

### 2.3 Control

Control 继续只负责原著文风一致性：

- narrative voice；
- POV；
- sentence rhythm；
- dialogue voice；
- emotional expression；
- description density；
- subtext；
- scene transition；
- AI template；
- padding。

### 2.4 Repair

Repair：

- 只处理 Checker / Control / 本地安全的精准问题；
- 进行最小干预；
- 必须输出完整章节；
- 不得因为字数目标自动扩写整章；
- Repair 后没有第二次 Control LLM，不得宣称存在 Repair 后文风质量闸。

---

## 3. P0：撤销“弱提示名义下的字数硬门禁”

修改：

```text
src/services/continuation/generation/continuationLengthContract.ts
src/services/continuation/generation/continuationChecker.ts
src/services/continuation/generation/continuationV4PromptCompiler.ts
src/services/continuation/generation/continuationV4Runner.ts
src/services/continuation/generation/repairCompletenessPolicy.ts
src/screens/continuation/ContinuationResultScreen.tsx
```

### 3.1 从 Repair 触发条件移除长度

删除 V4 `shouldRepair` 中：

```ts
lengthExpansionIssues.length > 0
```

Repair issues 不再加入：

```ts
...lengthExpansionIssues
```

以下情况必须跳过 Repair：

- 只有 `chapter_length_under_target`；
- 只有 `chapter_length_over_target`；
- 只有篇幅或 Beat 诊断；
- 无 Checker / Control / local safety 可执行问题。

### 3.2 从统一任务清单移除长度任务

删除：

```ts
kind: 'length_expansion'
```

删除 `buildRepairUnifiedTasks` 中：

```ts
checks.filter(isLengthExpansionIssue)
```

删除：

```text
定向深化扩写任务
当前汉字数
缺口约多少汉字
必须达到目标区间下限
```

### 3.3 删除长度硬合规检查

删除：

```text
repair_length_expansion_no_growth
repair_length_expansion_below_floor
```

不得验证：

```ts
candidateHan > writerHan
candidateHan >= minFloor
```

`chapter_length_*` 继续只作为 warning。

### 3.4 删除 `lengthExpansionMode` 全文豁免

删除或停用：

```ts
lengthExpansionMode
```

不得因为字数不足执行：

```ts
new Set(writerParagraphs.map(p => p.index))
```

所有 Repair 都必须继续接受：

- 未涉及段落保留率；
- 最小干预；
- 开头 / 中段 / 结尾锚点；
- 防坍缩；

检查。

### 3.5 V4 Writer 本地字数检查必须是 warning

当前 deterministic check 生成 error，导致结果页将其计入风险。

建议：

- V1 / V2 如需保留旧 severity，则不要修改共享 deterministic 语义；
- V4 在 `ensureWriterLocalChecks` 落库前，对 `chapter_length_*` 做 V4 专用软化；
- 对历史已落库 error，V4 Runner 和 UI 必须按 subtype 重新解释为 warning；
- `reviewBlocked` 不得包含 V4 的 `chapter_length_*`。

### 3.6 修正 UI 语义

当前 UI 显示：

```text
篇幅仅作提示，不影响候选资格
```

只有当代码真的不再用长度触发 Repair、拒绝 Repair、标记风险时，这句话才成立。

结果页应显示：

```text
用户参考篇幅：3000
实际汉字：1850
篇幅偏短，仅供人工参考；未因此触发自动 Repair。
```

---

## 4. P0：隔离 V4 参考区间，避免影响旧链路

当前 `resolveContinuationLengthContract` 被修改为共享 `±30%`，同时影响 V4 和 legacy。

这属于跨流水线行为变更，不应由 V4 修复方案顺带决定。

### 4.1 建议拆分

恢复共享 legacy contract 到改造前语义，或保持 legacy 当前已确认的独立策略。

新增 V4 专用：

```ts
resolveContinuationV4ReferenceLengthBand(targetChapterChars)
```

例如：

```ts
interface ContinuationReferenceLengthBand {
  targetHanCharacters: number;
  advisoryMinHanCharacters: number;
  advisoryMaxHanCharacters: number;
  toleranceRatio: number;
}
```

V4 参考区间只能用于：

- Writer Prompt；
- Control UI；
- telemetry；
- `chapter_length_*` warning。

不得用于 eligibility。

### 4.2 比例集中配置

不要在多个文件散落：

```ts
0.3
0.7
```

集中到 V4 advisory policy：

```ts
V4_REFERENCE_LENGTH_TOLERANCE_RATIO
```

如果产品后续调整 20%、25% 或 30%，只修改一处。

---

## 5. P0：删除 Beat 数字配额和错误质量承诺

### 5.1 删除 Beat 篇幅预算

当前 Writer Prompt 要求：

```text
为每个 beat 在 summary 中标注预期篇幅量
```

这会：

- 污染 Beat summary；
- 让模型按表格写作；
- 重新制造平均扩写和八股节奏；
- 与“不要机械覆盖全部 Beat”冲突。

改为：

```text
尽量使本章体量接近用户参考目标。
若主要场景过早收束，可自然深化既有动作、对话、反应和因果过程；
没有自然内容可展开时，不得为达到数字填充。
```

不要为每个 Beat 分配数字。

### 5.2 删除不存在的 Repair 后 Control 质量闸

当前 Repair Prompt 写着：

```text
扩写后仍须通过文风质量闸（padding / ai_template / description_density）
```

当前流水线没有 Repair 后第二次 Control，所以这句话不真实。

必须删除。

可替换为：

```text
Repair 后只执行本地完整性、协议、重复和确定性安全检查；
不会进行第二次 LLM 文风复核。
```

---

## 6. P0：彻底修复 style finding 的可信度链

修改：

```text
src/services/continuation/generation/types.ts
src/services/continuation/generation/continuationControl.ts
src/services/continuation/generation/continuationV4PromptCompiler.ts
```

### 6.1 `ContinuationControlFinding` 补全字段

增加：

```ts
confidence?: number;
generatedExcerpt?: string;
```

`styleIssueToFinding` 必须完整映射：

```ts
confidence: issue.confidence
generatedExcerpt: issue.generatedExcerpt
```

### 6.2 禁止 Prompt 层写死 confidence

删除：

```ts
confidence: 1
```

必须使用真实值。

### 6.3 禁止补造 preserveMeaning

删除：

```ts
preserveMeaning.length > 0
  ? preserveMeaning
  : ['保留原意']
```

缺少 preserveMeaning 时：

```ts
repairReady = false
```

### 6.4 Prompt Compiler 不得重新升级 repairReady

当前 `renderStyleFinding` 仍会再次调用 `isStyleIssueRepairReady` 并与 upstream 状态做 OR。

改为：

```ts
repairReady: finding.repairReady === true
```

Prompt Compiler 只负责渲染，不负责重新判定。

### 6.5 删除 `styleIssuesFromReport` 的伪造字段

不得将旧 finding 转为：

```ts
confidence: 1
repairReady: true
```

兼容旧报告时：

- 缺真实 confidence / evidence / preserveMeaning → audit-only；
- 不得为了兼容自动进入 Repair；
- 记录 `control_legacy_finding_downgraded` telemetry。

---

## 7. P0：修复 style issue 的定位绑定

### 7.1 range 与 excerpt 同时存在时必须互相验证

当前合法 range 会直接切片，并忽略模型 excerpt 是否匹配。

正确规则：

1. range 合法且 excerpt 为空：以 Writer slice 为准；
2. range 合法且 excerpt 非空：
   - Writer slice 与 excerpt 一致 → 绑定；
   - 不一致 → range 不可信，尝试唯一 excerpt；
3. excerpt 唯一出现 → 绑定到唯一位置；
4. excerpt 出现多次 → audit-only；
5. excerpt 不存在 → audit-only。

### 7.2 唯一性检查

```ts
const first = artifactText.indexOf(excerpt);
const second =
  first >= 0
    ? artifactText.indexOf(excerpt, first + excerpt.length)
    : -1;

const unique = first >= 0 && second < 0;
```

当前使用一次 `indexOf` 会错误绑定重复原句的第一处。

### 7.3 返回结构化绑定结果

建议：

```ts
interface StyleIssueBindingResult {
  issue: ContinuationStyleIssue;
  status:
    | 'bound_by_range'
    | 'bound_by_unique_excerpt'
    | 'range_excerpt_mismatch'
    | 'excerpt_not_found'
    | 'excerpt_not_unique'
    | 'invalid_location';
}
```

非 bound 状态全部：

```ts
repairReady=false
```


---

## 8. P0：Control artifact 与风格资料版本绑定

当前 Control 只把模型返回的 `writerArtifactHash` 写入 report，没有验证是否等于当前 Writer hash。

同时，当前冻结风格结构实际提供：

```text
profileId
profileHash
rendererVersion
renderLevel
snapshotRefs.styleProfileHash
```

不应继续使用没有真实来源的 `styleProfileRevision` 作为主要绑定字段。

### 8.1 Prompt 契约

Control Prompt 要求回显：

```json
{
  "writerArtifactHash": "...",
  "styleProfileHash": "...",
  "styleRendererVersion": "..."
}
```

只要求回显当前系统真实拥有的字段。

### 8.2 Parser 校验

错误码：

```text
control_artifact_hash_missing
control_artifact_hash_mismatch
control_style_profile_hash_missing
control_style_profile_hash_mismatch
control_style_renderer_version_mismatch
```

发生任一绑定错误时：

1. 丢弃全部 LLM style issues；
2. 使用本地 fallback；
3. Control 标记 degraded；
4. 不增加请求；
5. 不触发 Repair；
6. 保留 Writer；
7. outputJson 保存 expected / echoed 的非敏感 hash 元数据。

### 8.3 Runner 传入权威值

必须传入：

```ts
writerArtifactHash: artifact.contentHash
styleProfileHash:
  snapshot.stageViews.control.style.profileHash
  ?? snapshot.stageViews.control.snapshotRefs.styleProfileHash
styleRendererVersion:
  snapshot.stageViews.control.style.rendererVersion
```

### 8.4 Resume 也必须重新验真

当前 `loadStoredControlReport` 对已归一化 report 直接 `as-is` 返回。

应增加：

```ts
validateStoredControlReportBinding(...)
```

验证：

- stored writerArtifactHash；
- stored styleProfileHash；
- stored rendererVersion；
- 当前 Writer artifact；
- 当前冻结 snapshot。

不匹配时不得恢复旧 style issues。

---

## 9. P0：修复 Writer / Repair 截断错误码和失败 telemetry

### 9.1 Writer 当前只是部分完成

当前已经检查 `finishReason === 'length'`，但抛出普通 `Error`，catch 后通常落为：

```text
writer_failed
```

并且失败路径没有保存预算详情。

必须改为稳定错误码：

```text
writer_output_truncated
```

建议使用带 code 的错误：

```ts
class ContinuationStageOutputTruncatedError extends Error {
  code: string;
  stage: 'writer' | 'checker' | 'control' | 'repair';
}
```

### 9.2 Writer 失败时保存诊断

即使没有 artifact，也应在 stage outputJson 保存：

```ts
{
  schemaVersion: 1,
  finishReason: 'length',
  declaredMaxOutputTokens: frozen.maxOutputTokens,
  effectiveMaxOutputTokens: writerBudget.maximumOutputTokens,
  minimumOutputTokens: writerBudget.minimumOutputTokens,
  promptTokens: estimateMessagesTokens(messages),
  completionTokens: result.usage?.completion ?? null,
  referenceTargetHan: snapshot.settingsSnapshot.values.targetChapterChars
}
```

### 9.3 Repair 必须检查 finishReason

当前 Repair 调用后直接解析 JSON，未检查 `finishReason`。

增加：

```text
repair_output_truncated
```

Repair 截断时：

- 不解析半截 envelope；
- 不插入 Repair artifact；
- Writer 保持 eligible；
- local_verify 标记 skipped；
- run 进入 awaiting_user；
- 不重试；
- UI 明确是输出预算截断。

### 9.4 可选：Checker / Control 截断诊断

不改变 fallback 行为，但可使用：

```text
checker_output_truncated
control_output_truncated
```

以区别普通 JSON 协议错误。

---

## 10. P0：修复 Repair Prompt 预算低估和任务重复

当前实际 Repair Prompt 在 Checker / Control 返回后新增了：

- unified task list；
- 行内锚点；
- Checker 明细；
- Control 明细；
- Control 报告摘要；
- Writer plan；
- 完整 Writer 正文。

但 `actualV4SnapshotAfterWriter` 预算预估时使用：

```ts
checkerReport: { issues: [] }
controlReport: fallback
```

实际 Prompt 可能远大于预算预览。

### 10.1 在 Repair reservation 前重新测量真实 Prompt

在 Checker / Control 完成后：

```ts
const repairMessages = compileContinuationV4RepairMessages(...)
const actualRepairPromptTokens = estimateMessagesTokens(repairMessages)
```

检查：

```ts
actualRepairPromptTokens
+ repairBudget.maximumOutputTokens
<= frozen.contextWindow
```

### 10.2 不得静默削减硬任务

如果超出上下文：

1. 先移除重复展示；
2. 压缩非必要摘要；
3. 减少 Control audit-only 内容；
4. 缩短任务前后上下文；
5. Checker / local safety 硬任务不得丢弃；
6. 仍超限时以 `repair_prompt_budget_exceeded` 阻断 Repair，并保留 Writer。

不得自动增加第 5 次请求。

### 10.3 任务只能展示一次

当前同一问题可能出现在：

- unified task list；
- Checker 明细；
- Control 明细；
- Control 报告摘要 findings。

改为：

```text
统一任务卡（唯一任务来源）
+
紧凑统计摘要
+
完整 Writer 正文
```

删除重复 JSON dump。

---

## 11. P0：修复统一任务卡结构

当前 `RepairUnifiedTask` 缺少：

- evidence IDs；
- confidence；
- 前后上下文；
- forbidden changes；
- priority；
- 是否真正注入锚点。

建议改为：

```ts
interface ContinuationRepairTaskCard {
  taskIndex: number;
  taskId: string;
  source: 'local_safety' | 'checker' | 'style_control';
  priority: number;

  generatedStart: number | null;
  generatedEnd: number | null;
  generatedExcerpt: string;

  contextBefore: string;
  contextAfter: string;

  problem: string;
  evidenceIds: Array<number | string>;
  confidence: number | null;
  rewriteGoal: string;
  preserveMeaning: string[];
  forbiddenChanges: string[];

  anchorInjected: boolean;
}
```

### 11.1 执行顺序

1. local safety blocking；
2. Checker blocking/error；
3. Control style error。

### 11.2 audit-only 不进入任务卡

Control warning 和无法定位问题只用于 UI，不进入 Repair Prompt。

### 11.3 上下文长度集中配置

```ts
REPAIR_TASK_CONTEXT_CHARS
MAX_REPAIR_STYLE_TASKS
```

Checker / local safety 硬任务不得因上限被丢弃。

---

## 12. P0：修复锚点协议不一致

当前 `injectRepairAnchors` 会跳过重叠区间，但 `formatUnifiedTaskLine` 对所有任务都写：

```text
锚点=⟦ISSUE_n_START⟧…⟦ISSUE_n_END⟧
```

因此可能出现：

- 任务清单声称有锚点；
- Writer 正文里实际没有该锚点。

无 range 的长度任务也被声称有锚点。

### 12.1 注入函数返回元数据

```ts
interface RepairAnchorInjectionResult {
  text: string;
  injectedTaskIndexes: number[];
  skipped: Array<{
    taskIndex: number;
    reason:
      | 'no_range'
      | 'invalid_range'
      | 'overlap'
      | 'out_of_bounds';
  }>;
}
```

### 12.2 任务卡按真实状态渲染

有锚点：

```text
定位：锚点 ⟦ISSUE_3_START⟧…⟦ISSUE_3_END⟧
```

无锚点：

```text
定位：utf16 1200–1260；命中原文：“……”
```

不得声称不存在的锚点。

### 12.3 重叠任务

不要静默跳过。

处理策略：

- 同一段问题合并成一个任务卡；或
- 保留多个任务，但共用同一锚点并列出多个修订目标。

### 12.4 锚点仍是可选增强

如果精准 excerpt + 上下文已经足够，优先不向正文插入锚点。

---

## 13. P0：Repair 合规检查防止“只改标点”

当前 unchanged 检查主要依赖：

```ts
candidateText.includes(originalExcerpt)
```

模型只改一个标点，原 excerpt 不再完整存在，就可能绕过。

### 13.1 Checker 事实问题

对 Checker 五维问题，增加去空白、去标点的内容比较：

```ts
normalizeSemanticSurface(text)
```

如果原问题的汉字主体仍完整保留，仅变化标点或空格，则：

```text
repair_checker_issue_surface_unchanged
```

blocking。

### 13.2 Control 文风问题

不能统一禁止标点变化，因为 `sentence_rhythm` 的标点变化可能有效。

按维度处理：

- `sentence_rhythm`：允许标点变化，但要求句子分割或节奏结构实际变化；
- `emotional_expression` / `ai_template` / `padding`：仅标点变化不算落实；
- `dialogue_voice`：至少对白主体发生变化；
- 其他维度使用保守的表层变化判断。

本地检查不能宣称语义已修复，只验证“不是形式化回填”。

---

## 14. P1：Repair 失败诊断真正进入 UI

当前 `failureDiagnostics` 已写入 Repair outputJson，但结果页只根据通用 rejectionCode 给出模糊文案。

### 14.1 保存具体主拒绝码

不要只保存：

```text
repair_compliance_failed
local_final_gate_failed
```

主 rejectionCode 应优先使用第一项 blocking code，例如：

```text
repair_control_style_unchanged
repair_partial_output
repair_anchor_residue
repair_checker_issue_unapplied
```

完整列表继续保存在 diagnostics。

### 14.2 UI 展示 diagnostics

Repair 卡片展开时显示：

```text
未落实任务
- checker #42：……
- style_3：……

完整性 / 安全失败
- repair_missing_unaffected_sections：……
- self_duplicate：……

当前展示：Writer 初稿
Repair 候选：已拒绝，仅供审计
```

### 14.3 截断单独展示

Writer / Repair 的 `*_output_truncated` 不应显示成普通 JSON 错误。

### 14.4 长度文案与真实行为一致

完成 P0 长度回退后显示：

```text
篇幅只作提示，未触发自动 Repair。
```

---

## 15. P1：精确 duplicate occurrences

当前 duplicate window：

```ts
{
  start: first.start,
  end: last.end,
  count
}
```

会把中间正常正文包含进去。

### 15.1 类型

```ts
interface ContinuationDuplicateOccurrence {
  start: number;
  end: number;
  paragraphId: string;
}

interface ContinuationDuplicateWindow {
  start: number;
  end: number;
  count: number;
  occurrences: ContinuationDuplicateOccurrence[];
}
```

### 15.2 Local Final Gate

`self_duplicate`：

- excerpt 只显示一个真实重复 occurrence；
- description 标记重复 paragraph IDs；
- 不展示跨越中间正文的大块文本。

---

## 16. P1：Resume 路径一致性

当前已有 Repair artifact、但 Local Verify 未完成时，恢复路径只重新跑 Local Final Gate，可能缺少：

- Checker / Control compliance；
- task IDs；
- targeted spans；
- anchor raw content；
- length mode状态。

在移除 length expansion 后仍需保证：

### 16.1 持久化必要输入

Repair stage outputJson 在 artifact 落库前或原子事务中保存：

```ts
{
  appliedCheckerIssueIds,
  appliedControlFindingIds,
  unappliedItems,
  targetedSpans,
  rawAnchorResidueDetected,
  complianceCheckSubtypes
}
```

### 16.2 Resume 不得跳过 compliance

恢复时：

- 能重建 compliance → 重新执行；
- 无法重建 → 不得自动提升 Repair 为 eligible；
- 保留 Writer，并标记：

```text
repair_resume_compliance_unavailable
```

---

## 17. 测试方案

### 17.1 字数语义

1. V4 Writer 低于参考区间；
2. Checker / Control 无 actionable issue；
3. 断言 Repair skipped；
4. Writer eligible；
5. `chapter_length_under_target` 在 V4 UI 中表现为 warning；
6. 不产生 `repair_length_expansion_*`；
7. 不出现 `lengthExpansionMode`。

### 17.2 旧链路隔离

- V4 advisory band 改动不影响 V1 / V2；
- legacy contract 测试恢复到产品确认值；
- V4 比例只用于提示和 telemetry。

### 17.3 Prompt

- 不含 Beat 数字配额；
- 不含“必须达到下限”；
- 不含不存在的 Repair 后 Control 质量闸；
- 动态目标仍正确注入。

### 17.4 Style 可信度

- confidence 保持模型真实值；
- 缺 evidence → audit-only；
- 缺 preserveMeaning → audit-only；
- Prompt Compiler 不重新升级 repairReady；
- legacy finding 不自动变 repair-ready。

### 17.5 定位

- range 与 excerpt 一致 → bound；
- 不一致 → 不信任 range；
- excerpt 唯一 → bound；
- excerpt 重复 → audit-only；
- excerpt 不存在 → audit-only。

### 17.6 Control 绑定

- Writer hash 正确 → 可采纳；
- hash 缺失 / 不匹配 → issues 丢弃；
- style profile hash 正确 → 可采纳；
- profile hash 不一致 → degraded；
- resume 旧 report 同样重新校验。

### 17.7 截断

- Writer `finishReason=length` → `writer_output_truncated`；
- Writer failure outputJson 有预算；
- Repair `finishReason=length` → `repair_output_truncated`；
- Repair 不落 artifact、不重试、回退 Writer。

### 17.8 Prompt 预算

- 实际任务多时重新测量 Repair Prompt；
- 超预算先去重和压缩；
- 硬任务不丢失；
- 仍超限时 `repair_prompt_budget_exceeded`；
- 请求数仍 ≤4。

### 17.9 锚点

- 有效范围真实注入；
- no-range 不声称有锚点；
- overlap 不静默丢失；
- 残留锚点 blocking；
- strip 后完整性比较正确。

### 17.10 合规

- Checker 只改标点仍被拒绝；
- Control padding 只改标点仍被拒绝；
- sentence_rhythm 合理改标点不被一刀切拒绝。

### 17.11 UI

- 展示具体 failureDiagnostics；
- 展示当前候选来源；
- Writer / Repair 截断有专属文案；
- 长度 warning 不显示成风险硬问题。

### 17.12 Resume

- 恢复不会绕过 compliance；
- 缺恢复元数据时不自动提升 Repair；
- 不重复请求。

---

## 18. 建议修改文件

| 文件 | 修改内容 |
|---|---|
| `continuationLengthContract.ts` | 拆分 V4 advisory band 与 legacy contract |
| `continuationChecker.ts` | 移除长度扩写触发语义；V4 长度软化 |
| `continuationControl.ts` | 唯一定位、range/excerpt 校验、hash/profile 绑定、duplicate occurrences |
| `continuationV4PromptCompiler.ts` | 移除长度任务和 Beat 配额；可信 task cards；真实锚点状态；去重 |
| `continuationV4Runner.ts` | shouldRepair 回退；移除长度 compliance/mode；截断码；实际 Prompt 预算；diagnostics |
| `repairCompletenessPolicy.ts` | 删除全文 targeted 豁免；保持最小干预 |
| `types.ts` | confidence、profile binding、task card、duplicate occurrence 类型 |
| `ContinuationResultScreen.tsx` | 精确失败诊断、截断、长度 warning、当前候选 |
| V4 tests | 新语义和回归覆盖 |
| legacy tests | 防止 V4 改动污染旧链路 |

---

## 19. 实施顺序

1. 读取当前本地工作树，确认是否与远端 `7bad7d8` 一致；
2. 先修复长度语义回归；
3. 拆分 V4 advisory band；
4. 删除 Beat 数字预算和错误质量闸文案；
5. 修复 style confidence / preserve / repairReady；
6. 实现唯一定位和 range/excerpt 验证；
7. 实现 Control hash/profile 绑定及 resume 验证；
8. 修复 Writer / Repair 截断错误码和失败 telemetry；
9. 重构统一任务卡，删除重复 Prompt；
10. 增加实际 Repair Prompt 预算检查；
11. 修复锚点元数据和 overlap；
12. 加强表层 unchanged 检查；
13. 更新 UI diagnostics；
14. 精确 duplicate occurrences；
15. 修复 Resume compliance；
16. targeted tests；
17. typecheck；
18. lint；
19. `npm run verify`；
20. APK build；
21. 模拟器验证；
22. 最多两次真实 API 测试；
23. 检查 Git diff 和凭据安全。

---

## 20. 完成标准

只有同时满足以下条件，才算完成：

1. 字数偏差不再单独触发 Repair；
2. 不再要求 Repair 达到 70% 下限；
3. 不再存在 length expansion compliance；
4. 不再将全文标记为 targeted；
5. V4 长度在 Writer checks 和 UI 中是真正 warning；
6. V4 advisory band 不污染 V1 / V2；
7. Writer Prompt 不再要求 Beat 数字配额；
8. Prompt 不再宣称 Repair 后有 Control 文风质量闸；
9. style confidence 不再写死为 1；
10. 不再补造 preserveMeaning；
11. Prompt Compiler 不重新升级 repairReady；
12. range / excerpt 不一致时不会错误绑定；
13. 重复 excerpt 不会绑定第一处；
14. Control 严格绑定 Writer hash；
15. Control 严格绑定真实 style profile hash / renderer version；
16. stored Control report 在 resume 时重新验真；
17. Writer 截断使用明确错误码并保存预算；
18. Repair 截断使用明确错误码并安全回退；
19. 实际 Repair Prompt 在请求前重新测量；
20. 同一任务不重复注入多次；
21. 锚点清单与正文实际注入一致；
22. overlap 不静默丢任务；
23. Checker 事实问题不能靠只改标点蒙混；
24. UI 展示具体失败码和任务；
25. duplicate 使用精确 occurrences；
26. Resume 不绕过 compliance；
27. Repair 仍输出完整章节；
28. 防坍缩、安全门禁保持；
29. 物理请求始终 ≤4；
30. 无数据库 migration；
31. API Key 未泄漏；
32. targeted tests、typecheck、lint、verify 和 APK build 全部通过。

---

## 21. 最终原则

> 上一轮实现把“长度软目标”重新变成了自动 Repair 和硬合规条件，本轮必须纠正这一语义回归。  
> 工程优化应提高 Checker / Control 问题的定位可信度和 Repair 的执行成功率，而不是用字数门禁迫使模型扩写。  
> Repair 的修改可以很小，但输出必须是完整章节；没有第二次 LLM 文风复核时，系统不得声称扩写质量已经被 Control 审查。
