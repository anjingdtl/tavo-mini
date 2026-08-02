# 原著续写 DeepSeek 质量优先与动态字数闭环施工方案

> 文档状态：Ready for implementation  
> 编写日期：2026-08-03  
> 施工基线：ShineWriter V2.11.14、Schema 31、分支 `fix/continuation-repair-coverage`  
> 目标协议：Continuation workflow V3  
> 施工边界：完成代码改造、自动化测试与全量工程回归；本轮不构建 APK，不做模拟器或真机测试  
> 优先级：**续写质量 > 目标汉字数履约 > 生成效率**

## 1. 背景与已确认事实

当前 workflow V2 已实现：

```text
Writer
→ LLM Checker + 本地确定性检查
→ 标准 Repair（必要时）
→ Repair 后本地复检
→ awaiting_user
```

2026-08-02 的模拟器穿测暴露出以下问题：

1. 项目续写目标为 3000 个汉字，合法区间为 2500～3500；Writer 只输出 1057 个汉字。
2. Writer 请求的 `requestedMaxTokens` 为 200000，实际 completion 为 1799，`finishReason=stop`。因此短输出不是 token 截断，而是模型主动提前结束。
3. 标准 Repair 产物为 2114 个汉字，但实际内容等于 Writer 正文完整重复两遍。
4. 当前候选规则主要判断“是否更接近目标”“patch 是否与问题区间相交”，未识别整章自重复，因此损坏候选被保存。
5. 额外 Repair 消耗了又一次 API 请求，但仍未进入合法字数区间，也没有第二次 LLM Checker。
6. 当前 Runner 把 Writer 的一次传输重试从逻辑三阶段上限中扣除；实际一次 run 可能超过用户理解的 API 调用数。
7. V2 结果页允许用户风险采纳仍有 open error/blocking 的候选，长度不合格稿件可能被写入草稿并使 run 完成。
8. 当前 `defaultStageCaller()` 对 DeepSeek V4 显式发送 `thinking: { type: 'disabled' }`，与本轮“质量第一、保持 DeepSeek 思维链启用”的决策冲突。

上述事实的详细记录见：

- `docs/continuation-repair-emulator-test-report.md`
- `src/services/continuation/generation/continuationGenerationRunner.ts`
- `src/services/continuation/generation/continuationRepairPatch.ts`
- `src/services/continuation/generation/continuationLengthContract.ts`

本轮不能通过继续放大 `max_tokens`、强化一句字数提示或增加无界 Repair 次数解决。DeepSeek V4 的 1M context / 长输出只提供容量，不提供最小输出保证。必须把“质量审核、动态长度控制、物理请求计数、最终复检”变成可恢复的确定性状态机。

## 2. 产品决策与不可变约束

### 2.1 三项优先级

候选选择和状态迁移采用严格字典序，而不是加权评分：

```text
第一优先：质量硬门禁和语义一致性
第二优先：目标汉字数合法区间
第三优先：API 次数、token、耗时
```

含义：

- 字数达标不能补偿 Canon 冲突、接缝复制、future leakage、人物知识越界或整章重复。
- 高质量但长度不达标的正文可以作为失败诊断产物保留，但不能成为 V3 可正常采纳产物。
- 修订稿若比 Writer 稿更接近目标、但破坏质量硬门禁，必须拒绝修订稿。
- 为节省一次请求，不得跳过修订后的最终 LLM Checker。
- 达到四次物理 API 请求上限后仍未闭环，应明确失败，不能风险采纳或隐式发起第五次请求。

### 2.2 DeepSeek Thinking

对 `deepseek-v4-flash` 和 `deepseek-v4-pro`：

- Writer：`thinking.enabled`，`reasoning_effort=high`。
- Initial Checker：`thinking.enabled`，`reasoning_effort=high`。
- Integrated Reviser：`thinking.enabled`，`reasoning_effort=high`。
- Final Checker：`thinking.enabled`，`reasoning_effort=high`。

不得把 reasoning 内容写入：

- 章节正文；
- generation artifact；
- `token_usage_json`；
- `context_trace_json`；
- 普通日志；
- 备份。

允许记录非敏感指标：reasoning token 数（供应商返回时）、completion token 数、finish reason、empty reason、阶段耗时。

对非 DeepSeek OpenAI-compatible 配置不得盲发供应商不支持的参数。应通过冻结的模型能力策略决定是否发送 `thinking` / `reasoning_effort`；若某个 V3 run 明确要求 thinking、但冻结模型不支持，则在联网前阻断并给出中文可操作错误，不得静默关闭 thinking。

### 2.3 动态目标汉字数

V3 每次 run 的唯一目标来源是冻结设置：

```ts
const targetChapterChars =
  snapshot.settingsSnapshot.values.targetChapterChars;

const lengthContract =
  resolveContinuationLengthContract(targetChapterChars);
```

要求：

- `3000` 只允许作为 `continuation_generation_settings.target_chapter_chars` 的新项目默认值和测试样例，不得成为运行时控制常量。
- Writer、Plan、预算、Initial Checker、本地检查、Integrated Reviser、Final Checker、结果页和采纳门禁必须共享同一冻结 `lengthContract`。
- run 创建后用户修改项目续写设置，不得改变本次 run 的目标。
- resume 必须复用冻结目标，不重新读取当前项目设置。
- 模型自报字数不可信；所有实际字数由客户端本地计数。
- 当前 V2 的目标 ±500 行为先保持兼容。本轮不同时引入新的容差 UI，避免把状态机改造与产品策略改动混在一起。

### 2.4 四次“物理请求”硬上限

V3 的上限是每次真正执行 HTTP `fetch` 的次数，不是逻辑 stage 数：

- 第一次请求计数；
- 超时重试计数；
- 5xx / 网络重试计数；
- `response_format` 不支持后去掉参数重发也计数；
- 冷启动 resume 后继续累计；
- 用户手动触发的额外修订同样计数。

最大值：

```ts
const MAX_CONTINUATION_V3_PHYSICAL_REQUESTS = 4;
```

在第 5 次请求发出前必须阻断。计数预留要发生在 `fetch` 之前并持久化；进程在“预留后、发出前”崩溃时，恢复后保守视为已消耗，避免重复计费。

### 2.5 现有领域边界保持不变

- 原著 Canon 只读。
- Generation/UI 不得直查 Canon 表，只能使用 `CanonQueryService` 或冻结 bundle。
- 后续续写章继续以最近续写章为 primary anchor；不得回退为原著边界正文。
- 不修改 SourceChapterPosition / ContinuationChapterPosition 两套命名空间。
- 未定稿正文不得进入 Story Memory 或续写状态事件。
- 采纳只写章节草稿；定稿后的 state extraction / outbox 行为保持原语义。
- LLM 请求不得位于 SQLite 事务内。
- API Key 继续只从 Android Keystore 获取，不进入 snapshot、日志或备份。
- outline/freeform 的既有流水线不受影响。

## 3. 目标工作流

### 3.1 V3 标准状态机

```text
冻结上下文与动态长度契约（本地）
  ↓
Thinking Writer（API #1）
  ↓
保存 Writer plan + Writer artifact
  ↓
并行：
  ├─ Initial LLM Checker（API #2）
  └─ 本地质量/长度硬检查（0 API）
  ↓
合并 Initial 检查结果
  ├─ 全部通过 → awaiting_user
  └─ 任一 error/blocking 或长度不合法
       ↓
     Thinking Integrated Reviser（API #3）
       ↓
     保存 repair artifact，初检历史标为 obsolete
       ↓
     并行：
       ├─ Final LLM Checker（API #4）
       └─ 最终本地质量/长度硬检查（0 API）
       ↓
     合并 Final 检查结果
       ├─ 全部通过 → awaiting_user
       └─ 未通过 → failed（保留 artifact 供诊断，不允许正常采纳）
```

正常路径只有 2 次请求；修订路径固定 4 次。V3 不再提供“额外 Repair 一次”。

### 3.2 为什么 Initial Checker 可以检查短稿

Initial Checker 与本地检查并行，检查结果不是最终判决，而是 Integrated Reviser 的修订输入。即使 Writer 稿长度不足，Initial Checker 仍可发现：

- Canon 冲突；
- 知识边界越界；
- 人物关系和状态冲突；
- 时间线问题；
- 计划落实缺失；
- 风格显著偏移。

Integrated Reviser 同时解决语义问题与字数问题；Final Checker 再检查实际修订稿，因此不存在“Checker 结果绑定旧正文后直接当作终稿结论”的问题。

### 3.3 请求失败与额度退化

物理请求失败同样消耗额度：

- Writer 请求失败且无 artifact：允许在剩余额度内走既有传输重试，但重试也计数。
- Writer 重试后成功且 Writer + Initial Checker 全部通过：可以正常进入 awaiting_user。
- 任一失败导致剩余额度不足以完成“Integrated Reviser + Final Checker”双阶段时，不得只修订不终检；应以 `api_request_budget_exhausted` 失败并保留最近安全 artifact。
- Initial Checker 网络失败：V3 不再降级成 deterministic-only 成功；质量优先要求失败或在剩余额度内重试。
- Integrated Reviser 失败：保留 Writer artifact，run 失败，不自动再次修订。
- Final Checker 失败：保留 repair artifact，run 失败，不允许把“未复检修订稿”作为正常候选。

## 4. V3 数据协议与兼容策略

### 4.1 Workflow Version

扩展类型：

```ts
type ContinuationWorkflowVersion = 2 | 3;
```

以下字段支持 V3：

- `ContinuationGenerationSettingsSnapshot.workflowVersion?: 2 | 3`
- `ContinuationContextSnapshot.workflowVersion?: 2 | 3`
- `ContinuationGenerationRun.workflowVersion?: 2 | 3`

分流规则：

- 无 workflowVersion：完整走 legacy Planner 路径。
- workflowVersion=2：完整保留现有 Writer → Checker → patch Repair → 本地复检及历史 resume 语义。
- workflowVersion=3：走本文状态机。

不得原地改变已存在 V2 run 的行为。新创建 run 默认冻结为 V3。

### 4.2 不新增数据库 Schema

本轮以当前 Schema 31 为基线，不新增 Schema 32，理由：

- workflowVersion 已存入冻结 JSON。
- 物理请求计数和阶段 telemetry 可存入 `token_usage_json`。
- `continuation_generation_runs.stage` 继续复用 `writer` / `checker` / `repair` / `awaiting_user`。
- Integrated Reviser artifact 继续使用 `stage='repair'`。
- Initial / Final Checker 通过独立 telemetry key 和 artifact 绑定区分。
- 检查历史已有 artifact id/hash 和 `obsolete` 状态。

若施工中发现必须修改表 CHECK 或新增权威字段，必须停止并先更新本方案、迁移、current schema、manifest、validator、fixtures、backup 测试；不得业务层动态建表。

### 4.3 Token Usage V3

建议结构：

```ts
interface ContinuationV3TokenUsage {
  workflowVersion: 3;
  physicalRequestCount: number;
  maxPhysicalRequests: 4;
  requests: Array<{
    ordinal: 1 | 2 | 3 | 4;
    stage: 'writer' | 'initial_checker' | 'integrated_reviser' | 'final_checker';
    attemptKind: 'initial' | 'transport_retry' | 'format_fallback';
    reservedAt: string;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    estimatedPromptTokens?: number;
    requestedMaxTokens?: number;
    promptTokens?: number;
    reasoningTokens?: number;
    completionTokens?: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
    finishReason?: string | null;
    emptyReason?: string | null;
    outcome: 'reserved' | 'succeeded' | 'failed';
    errorCode?: string;
  }>;
  stages: {
    writer?: ContinuationV3StageMetrics;
    initialChecker?: ContinuationV3StageMetrics;
    integratedReviser?: ContinuationV3StageMetrics;
    finalChecker?: ContinuationV3StageMetrics;
    localInitialGate?: ContinuationV3LocalGateMetrics;
    localFinalGate?: ContinuationV3LocalGateMetrics;
  };
}
```

不得在 telemetry 中保存 prompt、正文、API key、reasoning 原文或供应商完整错误响应。

### 4.4 Writer V3 输出契约

新增严格解析器，不改变 V2 `parseWriterResult()`：

```json
{
  "schemaVersion": 2,
  "plan": {
    "targetHanCharacters": 由冻结设置动态传入,
    "chapterGoal": "...",
    "centralConflict": "...",
    "beats": [
      {
        "order": 1,
        "summary": "...",
        "targetHanCharacters": 动态分配值
      }
    ],
    "participatingCharacterIds": [],
    "characterActions": [],
    "plotAdvances": [],
    "foreshadowingActions": [],
    "proposedStateChanges": [],
    "risks": []
  },
  "content": "完整章节正文"
}
```

本地校验：

- 顶层只能是 object。
- `schemaVersion === 2`。
- `plan.targetHanCharacters` 必须等于冻结 target。
- beat 必须有正整数 order、非空 summary 和正整数目标。
- beat 目标总和允许小幅规划误差，但必须记录；正文是否合法只认本地实际计数。
- content 必须是非空纯正文，不包含标题、计划、Markdown 或嵌套 JSON。
- `finishReason=length`、reasoning-only、空 content、非法 JSON 均不得保存为 Writer artifact。

### 4.5 Integrated Reviser 输出契约

V3 不使用 offset patch 作为最终修订交付物。新增：

```json
{
  "schemaVersion": 1,
  "content": "完整修订章节正文"
}
```

要求：

- 完整保留并改善 Writer 的事件链、人物互动、因果、情绪转折和自然收束。
- 同时处理全部 Initial open error/blocking 和本地硬问题。
- 按冻结动态长度契约输出完整章节。
- 不得返回 patch、问题说明、摘要、标题或 Markdown。
- 模型声明“已修复”不具有证据效力；是否通过只看最终本地门禁和 Final Checker。

## 5. DeepSeek 请求层改造

### 5.1 Provider 类型

扩展：

```ts
type ReasoningEffort = 'low' | 'high' | 'max';

interface LLMGenerateOptions {
  thinking?: { type: 'enabled' | 'disabled' };
  reasoning_effort?: ReasoningEffort;
  beforeAdditionalHttpAttempt?: (meta: {
    attemptKind: 'format_fallback' | 'provider_retry';
  }) => Promise<void> | void;
}
```

同步贯穿：

- `src/services/llm/types.ts`
- `src/services/llm.ts`
- `src/services/llm/openAICompatibleProvider.ts`
- 测试 mocks / call config 类型

Provider 构造 DeepSeek 请求时发送：

```json
{
  "thinking": { "type": "enabled" },
  "reasoning_effort": "high"
}
```

物理计数采用单一所有权，禁止重复计数：

1. Runner 在每次调用 `callStage()` / `defaultStageCaller()` 前预留该次阶段调用的首个 HTTP 请求；Writer 传输重试重新进入调用时再预留一次。
2. Provider 的第一次 `fetch` 使用 Runner 已预留的额度，不再重复增加。
3. Provider 内部去掉 `response_format` 后的 fallback，或未来新增的 provider 内部 retry，必须在额外 `fetch` 前 await `beforeAdditionalHttpAttempt()`，再预留一笔额度。
4. 注入测试用 `callStage` 时，每次调用由 Runner 预留一笔，与生产首个 `fetch` 语义一致。

这样一次普通 stage call 计数 1，发生 format fallback 时计数 2，第 5 次真实 `fetch` 会在网络前被阻断。

### 5.2 冻结模型能力

扩展 `FrozenContinuationModelConfig`，冻结非密钥能力：

```ts
interface FrozenContinuationModelConfig {
  // existing fields
  thinkingPolicy?: {
    required: boolean;
    type: 'enabled';
    reasoningEffort: 'high';
  };
}
```

DeepSeek V4 新 run 固定为 required。resume 不重新根据实时模型名改变策略。

### 5.3 动态 Max Tokens

不得把模型配置的 200K/384K 上限直接当成每阶段 `requestedMaxTokens`。

预算输入：

```text
T = 冻结 targetChapterChars
Hmin/Hmax = 动态长度契约
proseDemand = estimateTargetChapterTokens(Hmax)
planDemand = 根据 beat 计划 JSON 预留
reasoningReserve = DeepSeek thinking 预留
formatReserve = JSON 转义与协议预留
```

Writer / Reviser：

```text
desiredOutput = proseDemand + plan/revision overhead + reasoningReserve
requestedMaxTokens = min(
  desiredOutput,
  frozen max_output_tokens,
  stage window output capacity,
  compiled-message remaining capacity
)
```

Initial / Final Checker 独立按正文长度、允许问题数、证据结构和 reasoning reserve 计算。不得给 Checker 直接分配 200K。

所有倍率必须集中在版本化预算策略中并由纯函数测试覆盖；不得散落在 Runner 或 UI 中。初始参数宁可为 thinking 留足空间，后续再以真实遥测调优。

### 5.4 Context Cache 友好布局

为四阶段建立字节级稳定的公共前缀：

```text
公共安全与续写协议
→ 冻结 Canon/locked rules
→ 冻结有效状态
→ 冻结文风画像
→ 阶段专用指令
→ 本阶段正文/问题
```

要求：

- 公共块顺序和序列化稳定。
- 阶段差异尽量放在公共前缀之后。
- 不为了缓存命中重复注入不需要的软上下文。
- 记录供应商返回的 cache hit/miss token（若存在），不记录内容。

## 6. 质量硬门禁

### 6.1 本地长度门禁

沿用 `resolveContinuationLengthContract()`，但所有调用必须传冻结动态目标。

建议增强汉字计数以覆盖完整 Unicode Han 范围，并增加回归：

- BMP CJK Unified Ideographs；
- Extension A；
- Compatibility Ideographs；
- 如 Hermes 支持 Unicode property escapes，优先使用 `\p{Unified_Ideograph}` 并显式覆盖 `〇`；否则使用经过测试的 code-point 实现。

不得把 UTF-16 patch offset 与 Unicode 汉字计数混为同一概念。

### 6.2 自重复门禁

新增独立纯函数模块，例如：

```text
src/services/continuation/generation/continuationDuplicateDetector.ts
```

至少检测：

1. `candidate === original + original` 及其带少量连接符/空白的变体。
2. 规范化段落 hash 的重复比例。
3. 候选内部 8～12 汉字 n-gram 重复率。
4. 修订稿新增部分与 Writer 原文的异常高重合率。
5. 最长重复片段和连续重复段落。
6. 已有 source/continuation anchor overlap。

输出结构化指标：

```ts
interface ContinuationDuplicateEvaluation {
  status: 'within' | 'suspicious' | 'blocking';
  repeatedParagraphRatio: number;
  repeatedNgramRatio: number;
  longestRepeatedHanSpan: number;
  wholeArtifactDuplication: boolean;
  reasons: string[];
}
```

整章重复、连续大段重复必须是不可覆盖的 blocking。

### 6.3 本地质量门禁聚合器

新增聚合器，例如：

```text
src/services/continuation/generation/continuationQualityGate.ts
```

输入：artifact、snapshot、可选 parent artifact。输出：

```ts
interface ContinuationQualityGateResult {
  pass: boolean;
  length: ContinuationLengthEvaluation;
  duplicate: ContinuationDuplicateEvaluation;
  localIssues: RawCheckIssue[];
  hardBlockingSubtypes: string[];
}
```

V3 不得仅调用 `isRepairCandidateUsable()` 决定终稿。V2 继续保留该函数以兼容历史流程。

### 6.4 Final Checker 的权威性

- Initial Checker 结果绑定 Writer artifact。
- 创建 repair artifact 后，将 Writer artifact 上仍 open 的初检结果标为 `obsolete`；不要仅因修订区间相交标为 `auto_repaired`。
- Final Checker 和最终本地检查的新结果绑定 repair artifact/hash。
- 只有 final artifact 无 open error/blocking 且本地 hard gate pass，才进入 awaiting_user。
- Final Checker 不得把无证据推测升级为 error/blocking，继续遵守既有证据规则。

## 7. Runner 与恢复语义

### 7.1 新增 V3 分流

在 `runStages()` 中显式分流：

```ts
if (snapshot.workflowVersion === 3) {
  await runQualityFirstV3Stages(...);
  return;
}
if (snapshot.workflowVersion === 2) {
  await runStandardStages(...);
  return;
}
await runLegacyStages(...);
```

不要继续扩大现有 `runStandardStages()`；V3 使用独立线性函数，降低 resume 和调用计数相互污染的风险。

### 7.2 阶段边界

每个可恢复边界必须先持久化再进入下一 API：

1. context snapshot 已保存；
2. Writer 请求额度已预留；
3. Writer artifact + plan 已保存；
4. Initial checks 已保存；
5. Reviser 请求额度已预留；
6. repair artifact 已保存；
7. Final checks 已保存；
8. awaiting_user。

resume 必须根据 artifact/check/telemetry 组合判断下一步，不仅依赖 `run.stage`：

- Writer artifact 存在：禁止重发 Writer。
- Writer checks 完整、无 repair artifact：根据检查决定 awaiting_user 或 Reviser。
- repair artifact 存在但 final checks 不完整：只允许 Final Checker，前提是还有物理额度。
- Final checks 完整：重新运行本地纯函数门禁后决定 awaiting_user/failed，不再发请求。
- 已预留但 outcome=reserved 的请求：保守视为已消耗，不自动重复。

### 7.3 并行边界

允许：

```ts
await Promise.all([
  runInitialLlmChecker(...),
  Promise.resolve().then(() => runLocalQualityGate(...)),
]);
```

以及修订后的 Final Checker / 本地门禁并行。

禁止：

- Writer 与 Initial Checker 并行；
- Initial Checker 与 Integrated Reviser 并行；
- Integrated Reviser 与 Final Checker 并行；
- 对同一 run 并行发两个 Writer 候选；这会挤占四次额度并削弱最终质量闭环。

## 8. Prompt 改造

### 8.1 Writer Prompt

必须动态插入：

- `targetHanCharacters`；
- `minHanCharacters` / `maxHanCharacters`；
- 当前 plan 每 beat 的目标分配要求；
- “覆盖全部节拍不等于完成，正文还必须达到本次动态长度契约”；
- 完整场景、人物互动、动作、因果、情绪、结果余波和自然章末要求；
- 禁止摘要、提纲、重复、水文、复制原著。

提示中的 3000 只能来自实际冻结设置恰好等于 3000 的运行时插值。

### 8.2 Initial / Final Checker Prompt

复用共同 Checker 编译器，但传入明确 phase：

```ts
compileCheckerMessages(snapshot, content, {
  phase: 'initial' | 'final',
});
```

- 长度、自重复、接缝重复继续由本地权威检查，LLM 不重复制造长度问题。
- Initial Checker 重点发现需交给 Reviser 的语义问题。
- Final Checker 必须检查实际 repair artifact，并说明这是最终复检。
- Initial 和 Final 的检查记录必须能从 telemetry/UI 区分。

### 8.3 Integrated Reviser Prompt

新增独立编译函数，例如：

```ts
compileIntegratedReviserMessages(
  snapshot,
  plan,
  writerContent,
  initialOpenChecks,
  localGate,
)
```

Prompt 明确优先级：

```text
1. 不破坏 Canon、状态、人物动机、接缝和完整事件链
2. 修复全部 error/blocking
3. 达到冻结动态汉字区间
4. 保持文风和自然叙事
5. 只输出严格 JSON 中的完整修订正文
```

必须提供当前实际汉字数、缺口/超额、动态目标和合法范围；不得写死 3000。

## 9. 结果页与采纳门禁

### 9.1 V3 阶段展示

结果页展示：

- Thinking Writer；
- Initial Checker；
- Integrated Reviser（发生时）；
- Final Checker（发生修订时）；
- Initial / Final 本地门禁；
- `physicalRequestCount / 4`；
- 动态目标、合法范围、Writer 实际汉字数、最终实际汉字数；
- 重复检查摘要；
- 每阶段 prompt/reasoning/completion token 和耗时（不展示 reasoning 原文）。

### 9.2 V3 禁止风险采纳硬失败

对 workflowVersion=3：

- 有 open error/blocking：不能采纳。
- 长度不合法：不能采纳。
- duplicate gate blocking：不能采纳。
- Final Checker 未完成：不能采纳 repair artifact。
- `allowOpenChecks=true` 应直接拒绝，不能调用 `buildAcceptOpenChecksStatement()`。
- 允许用户查看、复制或放弃失败 artifact；如产品现有 UI 无复制入口，本轮不强制新增，但不得伪装为成功候选。

V1/V2 历史风险采纳行为保持兼容。

### 9.3 配置页和上下文预览

- 目标章节字数继续来自项目续写生成配置。
- 文案改为“目标章节汉字数”，说明实际验收区间。
- 明确“DeepSeek V4 Thinking 将保持启用”。
- 明确“正常 2 次、需要综合修订时 4 次真实请求；网络/格式重试也占额度”。
- Context Preview 展示 V3 Writer 实际动态目标和预算；不得展示固定 3000。

## 10. 文件级施工清单

### 10.1 核心类型与 Provider

- `src/services/llm/types.ts`
  - 增加 reasoning effort、HTTP attempt hook、cache/reasoning usage 类型。
- `src/services/llm.ts`
  - 贯穿新增参数。
- `src/services/llm/openAICompatibleProvider.ts`
  - 发送 DeepSeek thinking/reasoning_effort。
  - Provider 内部额外 fetch 前调用 additional-attempt hook；首个 fetch 使用 Runner 已预留额度。
  - 解析 reasoning/cache usage。
- `src/services/continuation/generation/types.ts`
  - workflowVersion 3、V3 plan/telemetry/冻结 reasoning policy 类型。

### 10.2 预算与上下文

- `src/services/continuation/generation/continuationContextBudget.ts`
  - 增加 thinking-aware 的 Writer/Checker/Reviser 预算纯函数。
  - 取消 V3 直接使用 stage capacity 最大值作为 requested max。
- `src/services/continuation/generation/continuationContextBuilder.ts`
  - 新 run 冻结 workflowVersion=3、thinking policy、动态 target contract。
- `src/services/continuation/generation/continuationContextTrace.ts`
  - 增加 reasoning/output 预算与 V3 阶段摘要。

### 10.3 Prompt、解析与质量门禁

- `src/services/continuation/generation/continuationPromptCompiler.ts`
  - V3 Writer、phase-aware Checker、Integrated Reviser。
- `src/services/continuation/generation/continuationLengthContract.ts`
  - Unicode Han 计数增强；保持动态目标契约。
- 新增 `continuationDuplicateDetector.ts`
  - 自重复纯函数。
- 新增 `continuationQualityGate.ts`
  - 聚合长度、重复和既有确定性检查。
- 可新增 `continuationV3Parsers.ts`
  - V3 Writer/Reviser 严格解析，避免继续扩大 Runner。

### 10.4 Runner、Repository 与 UI

- `src/services/continuation/generation/continuationGenerationRunner.ts`
  - 独立 `runQualityFirstV3Stages()`。
  - 四次物理请求预留/持久化。
  - 两个 Promise.all 并行边界。
  - V3 resume/失败语义。
- `src/services/continuation/generation/generationRepository.ts`
  - workflowVersion=3 读取。
  - 复用 checks obsolete/history API；必要时增加按 artifact/phase 的只读辅助函数。
- `src/screens/continuation/ContinuationResultScreen.tsx`
  - V3 阶段、物理计数、动态长度、Final Checker 展示。
  - V3 移除额外 Repair 和风险采纳。
- `src/screens/continuation/ContinuationGenerationConfigScreen.tsx`
  - 动态目标/Thinking/调用上限说明。
- `src/screens/ContextPreviewScreen.tsx`
  - V3 Writer 动态目标和 thinking-aware 预算。

## 11. 测试施工矩阵

### 11.1 新增或重点更新的测试文件

1. `__tests__/continuationQualityFirstV3Workflow.test.ts`
2. `__tests__/continuationDuplicateDetector.test.ts`
3. `__tests__/continuationLengthRepair.test.ts`
4. `__tests__/continuationStandardWorkflow.test.ts`
5. `__tests__/continuationStageBudgets.test.ts`
6. `__tests__/continuationContextBudget.test.ts`
7. `__tests__/continuationFactCheckPrompt.test.ts`
8. `__tests__/continuationResultScreen.test.tsx`
9. `__tests__/continuationGenerationConfigScreen.test.tsx`
10. `__tests__/continuationPhase3Repository.test.ts`
11. `__tests__/continuationProjectPackageV3.test.ts`
12. `__tests__/backupService.test.ts`
13. Provider/LLM 请求相关测试。

### 11.2 V3 工作流必测用例

- Writer + Initial Checker 均通过：恰好 2 次物理请求。
- Writer 长度不足、Checker 无语义问题：Reviser + Final Checker，总计 4 次。
- Writer 长度合法但 Initial Checker 有 error：总计 4 次。
- Writer 同时长度不足和 Canon error：一次 Integrated Reviser 同时处理，随后 Final Checker。
- Reviser 后长度合法、Final Checker 无 severe：awaiting_user。
- Reviser 后长度仍不足：failed，不能采纳。
- Reviser 后出现新 Canon error：failed，不能采纳。
- Final Checker 网络失败：failed，不能采纳。
- Initial Checker 网络失败：不得 deterministic-only 成功。
- 请求计数到 4 后 Provider format fallback 被阻断，第 5 次 fetch 从未发生。
- Writer 传输重试消耗额度；resume 不重置。
- reserved 请求后模拟进程中断，resume 不重复发送该请求。
- V3 不显示/不允许额外 Repair。
- V3 `allowOpenChecks=true` 被 service 层拒绝。
- V2 既有行为和测试全部保持通过。
- legacy Planner run 仍可恢复。

### 11.3 动态目标必测用例

至少覆盖：

```text
target = 200
target = 1000
target = 3000
target = 8000
target = 30000
```

每个目标验证：

- snapshot 冻结正确；
- Writer prompt 使用对应值；
- plan echo 使用对应值；
- beat 预算不含固定 3000；
- requestedMaxTokens 随目标单调变化；
- Checker/Reviser prompt 使用相同 contract；
- 本地长度检查边界包含；
- UI 展示一致；
- 修改项目设置后 resume 仍使用原冻结目标。

增加源码级防回归断言或精准测试，确保 V3 runtime prompt/budget 中不存在业务硬编码 `3000`；测试样例和数据库默认不在禁止范围。

### 11.4 Thinking 必测用例

- DeepSeek V4 四阶段均发送 `thinking.enabled`。
- 四阶段均发送 `reasoning_effort=high`。
- reasoning 内容不进入 artifact、trace、token usage 和错误日志。
- reasoning token 被记录为数字（供应商返回时）。
- reasoning-only Writer/Reviser 不保存 artifact。
- 不支持 thinking 的非 DeepSeek 配置按冻结策略阻断或兼容，不得因新增字段破坏其他 provider。
- `response_format` fallback 每次 fetch 都消耗物理额度。

### 11.5 重复与质量门禁必测用例

- 使用本次真实形态：`repair === writer + writer`，必须 blocking。
- 两份正文中间只有空白/标点差异，仍能识别整章重复。
- 重复一个长段落多次，blocking。
- 正常修辞复沓或短句重复不过度误报。
- 新增内容与 Writer 原文高度复制，blocking。
- source seam / continuation anchor overlap 继续 blocking。
- 字数达标但重复失败，不能进入 awaiting_user。
- 字数更接近目标但质量退化，拒绝修订稿。

### 11.6 并行与 artifact 绑定

- Initial LLM Checker 与本地门禁都完成后才决定 Reviser。
- Final LLM Checker 与最终本地门禁都完成后才决定 awaiting_user。
- Initial checks 只绑定 Writer artifact/hash。
- Final checks 只绑定 repair artifact/hash。
- 创建 repair artifact 后，Writer open checks 标记 obsolete，不被伪装成已语义修复。
- Final Checker 从不检查旧 Writer artifact。

### 11.7 回归范围

必须确保以下领域无回归：

- continuation anchor / sequential generation / future leakage；
- CanonQueryService 和证据绑定；
- 原著风格强制注入；
- generation repository；
- 冷启动 interrupted/resume；
- adoption 并发保护；
- finalized state extraction / outbox；
- Story Memory dirty/rebuild；
- backup v3 / restore；
- Schema 31 validator 和迁移矩阵；
- outline/freeform pipeline；
- LLM provider 网络策略、调度和超时。

## 12. 分 Work Package 实施

### WP0：基线和测试红灯

1. 跑 V2 定向测试，记录基线。
2. 先添加以下失败测试：Thinking、动态目标、四次物理请求、整章重复、修订后 Final Checker。
3. 确认工作区无非本任务改动，不覆盖用户文件。

完成标志：新测试准确暴露当前 V2 缺陷，既有测试仍可单独运行。

### WP1：Provider 与物理请求预算

1. 贯穿 thinking/reasoning_effort。
2. Runner 预留 stage 首个请求；Provider 增加内部额外 fetch 的 attempt hook，且两者不得双计数。
3. 增加 V3 物理请求预留、持久化和上限错误。
4. 补 Provider、fallback、resume 测试。

完成标志：任何生产 fetch 都不能绕过 V3 计数；第 5 次请求在网络前被拒绝。

### WP2：V3 类型、预算和冻结快照

1. workflowVersion 3 类型与 repository 读取。
2. 冻结 DeepSeek thinking policy。
3. thinking-aware 动态输出预算。
4. 新 run 默认 V3，V1/V2 不变。

完成标志：200～30000 的动态目标测试通过，V3 不直接请求 200K 输出额度。

### WP3：Prompt、解析器和本地质量门禁

1. V3 Writer schema 2。
2. phase-aware Checker。
3. Integrated Reviser 全文协议。
4. Unicode Han 计数。
5. duplicate detector 和 quality gate。

完成标志：真实 `writer + writer` 回归样例被 blocking；所有 prompt 使用冻结动态目标。

### WP4：V3 Runner 与恢复

1. 独立 V3 线性状态机。
2. 两个本地/LLM 并行边界。
3. 初检 → 全文修订 → 终检 artifact/check 绑定。
4. 失败、额度耗尽、中断恢复。
5. V3 禁用额外 Repair。

完成标志：正常 2 次、修订 4 次、任何路径不超过 4 次真实请求。

### WP5：UI、预览和可观测性

1. 结果页四阶段展示。
2. 动态长度与重复门禁展示。
3. V3 禁止风险采纳。
4. 配置页和上下文预览文案。
5. cache/reasoning/physical request 非敏感遥测。

完成标志：UI 与 service 双层阻止不合格 V3 artifact 采纳。

### WP6：全量回归与文档对齐

1. 跑全部定向测试。
2. 跑工程门禁和覆盖率。
3. 更新与实际行为冲突的开发文档、README/CHANGELOG（只改必要内容）。
4. 检查无 APK、数据库、日志、截图等产物进入 Git。

完成标志：第 13 节全部通过，无模拟器/真机步骤。

## 13. 自动化验收与全量回归

### 13.1 定向测试

根据实际新增文件调整，但至少执行：

```powershell
npx jest __tests__/continuationQualityFirstV3Workflow.test.ts --runInBand
npx jest __tests__/continuationDuplicateDetector.test.ts __tests__/continuationLengthRepair.test.ts --runInBand
npx jest __tests__/continuationStandardWorkflow.test.ts __tests__/continuationPhase3Repository.test.ts --runInBand
npx jest __tests__/continuationContextBudget.test.ts __tests__/continuationStageBudgets.test.ts --runInBand
npx jest __tests__/continuationFactCheckPrompt.test.ts __tests__/continuationResultScreen.test.tsx __tests__/continuationGenerationConfigScreen.test.tsx --runInBand
npx jest __tests__/continuationAnchor.test.ts __tests__/continuationSequentialGeneration.test.ts __tests__/continuationStyleInjection.test.ts --runInBand
npx jest __tests__/continuationStateOutboxWorker.test.ts __tests__/backupService.test.ts __tests__/continuationProjectPackageV3.test.ts --runInBand
```

### 13.2 全量工程门禁

必须执行且全部通过：

```powershell
npm run verify
npm run test:coverage
```

`npm run verify` 已包含：

```text
lint
typecheck
test:ci
```

### 13.3 本轮明确不执行

- `npm run android`
- `npm run apk:debug`
- 任意 release APK 构建
- adb / Maestro
- Android 模拟器测试
- Android 真机测试
- DeepSeek 真实在线调用

真实模型和设备验收留到下一阶段单独执行。

## 14. Definition of Done

只有同时满足以下条件才算完成：

1. 新 run 默认 workflowVersion=3，V1/V2 历史 run 可读、可恢复且语义不变。
2. DeepSeek V4 的 Writer、Initial Checker、Integrated Reviser、Final Checker 全部启用 thinking/high。
3. 目标汉字数唯一来自冻结 `targetChapterChars`，200～30000 动态测试通过。
4. 正常路径恰好 2 次物理请求，修订路径恰好 4 次。
5. 所有 fetch、fallback 和 retry 都受同一四次持久化预算约束。
6. 修订后必有 Final Checker；不再存在“修订稿仅本地复检即正常采纳”。
7. `writer + writer`、大段自重复、接缝复制全部被本地 blocking。
8. 字数达标但质量失败的候选不可采纳。
9. 质量通过但字数失败的候选不可正常采纳。
10. V3 service 和 UI 都拒绝 `allowOpenChecks` 风险采纳。
11. artifact/check/hash/parent 绑定正确，Initial/Final 历史可审计。
12. reasoning 原文、prompt、正文和 API Key 未进入非正文遥测或日志。
13. 定向测试、`npm run verify`、`npm run test:coverage` 全部通过。
14. 未执行、也未声称执行模拟器或真机测试。
15. 工作区没有新增 APK、数据库、凭据、日志、截图或其他调试产物。

## 15. 非目标

- 不做模拟器或真机测试。
- 不构建 Debug/Release APK。
- 不发起真实 DeepSeek API 穿测。
- 不更改目标长度容差产品策略；保持现有动态 target ±500 契约。
- 不重写 Canon 分析、风格分析、State Extraction 或 Story Memory 算法。
- 不修改原著 Source/Canon 数据。
- 不删除 V1/V2 历史协议或 Planner 数据。
- 不为 outline/freeform 引入 V3 continuation stage。
- 不新增“快速/标准/严谨”模式。
- 不以本地拼装可选段落替代完整章节级质量修订。

## 16. 施工纪律

- 开始前阅读仓库根 `AGENTS.md`、`README.md`、本方案和现有 V2 优化方案。
- 以当前代码和 Schema 31 为事实来源；历史 Phase 3 Schema 21 SQL 仅作背景，不得回退当前 schema。
- 使用小步提交边界，但除非用户明确要求，不自动提交、推送或创建 PR。
- 保留用户已有改动，不清理仓库根历史调试产物。
- 文件修改使用项目既有风格和数据访问分层。
- 新增原生依赖不在本轮预期范围；若不可避免，必须同步 Jest mock 和 transform whitelist。
- 错误信息使用中文，UI 通过 Toast/现有错误卡展示。
- 遇到需要扩大本方案边界、修改 Schema 或牺牲 Final Checker 的情况时停止并报告，不得自行改变三项优先级。
