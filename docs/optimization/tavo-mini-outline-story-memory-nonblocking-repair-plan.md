# TAVO-MINI 大纲创作第 12 章阻断与长期记忆无法创建修复方案

> 文档日期：2026-08-08  
> 代码基线：V2.11.38 / Schema 43  
> 文档状态：待实施  
> 优先级：P0（写作主链路阻断）  
> 影响范围：大纲创作的上下文预览、章节 AI 写作、Story Memory 检查点生成与重建  
> 数据库变更：P0/P1 不需要新增 Schema

## 1. 结论摘要

本问题不是“大纲内容本身写到第 12 章后超限”，而是 Story Memory 三条规则组合后形成的确定性阻断：

1. Smart 长期记忆默认每 10 章触发一次；
2. 未进入检查点的完整章节正文最多只允许 10 章进入上下文；
3. 第一个长期记忆检查点失败后，第 12 章面对 11 章待覆盖历史，其中至少 1 章会被标成 `uncovered`；现有代码把这个质量风险直接升级为异常，导致预览和正式写作都无法继续。

截图 2 的“模型没有返回检查点补丁”可精确定位到 `storyMemoryCheckpointService.ts` 的空业务正文分支。该分支在 JSON repair、扩大输出预算和 fresh retry 之前直接抛错，所以现有的多轮修复逻辑没有被执行。这就是“无论如何都没办法创建长期记忆”的直接原因。

必须建立新的产品不变量：

> **长期记忆是增强项，不是写作许可。长期记忆缺失、过期或重建失败时，系统必须明确警告并降级上下文，但不得锁死用户写作。**

建议保留“最多 10 章完整原文”的成本和上下文安全上限，但把“历史覆盖不足”从硬门禁改为可观察的降级状态；只有目标章节位置非法、数据库不可读、请求本身无法放入模型窗口等真正不能生成的错误才允许硬阻断。

## 2. 用户现象与代码证据

### 2.1 现象一：第 11 章之后，第 12 章无法写作

截图提示：

```text
构建上下文失败
长期记忆覆盖不足，请先整理检查点或扩大上下文预算。
```

对应链路：

```text
ContextPreviewScreen / 正式 Draft 编译
  → compileDraftStageRequest
  → compileDraftPipelineRequest
  → buildContext
  → prepareStoryMemoryForGeneration
  → planStoryMemoryCoverage
  → prepared.blocked=true
  → buildContext 抛异常
```

关键实现：

- `src/services/storyMemory/storyMemoryCoverage.ts`
  - `STORY_MEMORY_MAX_RAW_CHAPTERS = 10`；
  - 超过最近 10 章的待整理章节只能由 `memory_summary` 覆盖；没有摘要就进入 `uncoveredChapterIds`。
- `src/services/storyMemory/storyMemoryPolicy.ts`
  - Smart 默认间隔为 10 章；
  - interval 决定何时创建检查点，LLM batch 固定为每批 3 章。
- `src/services/storyMemory/storyMemoryPrepare.ts`
  - Preview 遇到 `uncoveredChapterIds` 直接返回 `blocked=true`；
  - Generation 自动整理失败且仍有 uncovered 时抛出 `MEMORY_CHECKPOINT_COVERAGE_GAP`；
  - 自动整理成功但仍有 uncovered 时也返回 `blocked=true`。
- `src/services/contextBuilder.ts`
  - 对任何 `prepared.blocked` 直接 `throw new Error(...)`。

### 2.2 为什么恰好在第 12 章稳定出现

假设项目从未成功创建检查点，内部 `throughChapterPosition=-1`：

| 目标章节 | 此前已有正文 | 原文硬上限 | 最少未覆盖数 | 结果 |
|---|---:|---:|---:|---|
| 第 11 章 | 10 章 | 10 | 0 | 仍可仅靠近期正文桥接 |
| 第 12 章 | 11 章 | 10 | 1 | 第 1 章无摘要时必定 uncovered |
| 第 N 章 | N-1 章 | 10 | 至少 N-11 | 阻断持续扩大 |

因此，第 12 章不是偶然阈值，而是 `10 章检查点间隔 + 10 章原文上限 + 检查点从未成功` 的数学边界。

默认 `slidingWindowSize=4000` 时，若单章正文较长，token 预算可能比“章数 10”更早产生 uncovered；第 12 章只是与章数上限无关、必然出现的最晚边界。

### 2.3 现象二：长期记忆始终无法创建

截图提示：

```text
第1章起检查点重建失败：模型没有返回检查点补丁。
```

这段文案来自：

```text
rebuildStoryMemoryUnlocked
  → runStoryMemoryCheckpointBatch
  → generateValidatedCheckpointBatch
  → requestCheckpoint
  → result.text 为空
  → MEMORY_CHECKPOINT_INVALID_JSON：模型没有返回检查点补丁
```

已确认的缺陷不是“没有设计重试”，而是空响应发生在重试入口之外：

1. `requestCheckpoint()` 在 `result.text` 为空时立即抛错；
2. `generateValidatedCheckpointBatch()` 只有拿到非空 `firstResult` 后，才进入 parse → repair → retry；
3. 因此，空响应不会触发 repair，也不会执行 `nextBudget()`；
4. 首批失败后，重建把项目记忆状态写成 `failed`，后续 eligibility 会按 `not_clean` 拒绝注入；
5. 批量检查点成功之前，当前 scheduler 主路径也不会为这些章节写入 `memory_summary`，所以 coverage 没有 episodic fallback。

Provider 已能区分以下空响应原因：

```ts
'length' | 'content_filter' | 'reasoning_only' | 'no_choices' | 'empty'
```

但 Story Memory 调用方没有消费 `emptyReason`，统一退化成“模型没有返回检查点补丁”。截图足以证明 `message.content` 为空，但仅凭截图不能断定具体是 reasoning-only、length 还是兼容网关空响应。无论属于哪一类，调用方丢弃分类并绕过恢复逻辑都是已确认根因。

### 2.4 本次回归为何现在暴露

这是规则组合回归，而不是单个新函数的孤立错误：

- `52f09c6f` 同时引入“最近完整正文最多 10 章”和“新 policy 默认 10 章触发”；
- `bd7b23a2` 进一步固定 Smart 模式 1～9 章不按 token 提前触发；
- Schema 43 又把历史系统默认 `smart/3` 收敛到 `smart/10`；
- 旧的 coverage hard-block 自 2026-07-19 起一直存在；
- Story Memory 空响应分支同样仍是旧的立即失败实现。

每条规则单看都有合理目的，但它们没有共同覆盖“第一个 checkpoint 失败”这一故障场景，最终形成第 12 章写作熔断。

## 3. 根因分级

### Root Cause A：把上下文质量风险错误建模成写作许可

`uncoveredChapterIds` 的真实含义是“本次请求无法完整携带全部历史”，不等于“无法生成”。现有 `blocked: boolean` 把它与非法章节位置等真正致命错误混在一起。

后果：

- Preview 页面直接报错，无法展示仍可发送的降级请求；
- 正式生成在 Story Memory 失败时一并失败；
- 用户唯一能做的是反复重建，但重建又受同一个模型空响应影响；
- 一个辅助功能故障升级为主写作功能不可用。

### Root Cause B：checkpoint 空响应绕过恢复状态机

当前恢复只覆盖“有文本但 JSON 不合法/校验失败”，没有覆盖“业务正文为空”。`emptyReason` 已在 Provider 层存在，但 Story Memory 没有按原因决策。

### Root Cause C：两个阈值完全贴边，没有故障缓冲

触发间隔和原文上限都是 10。第 10 章的首次 checkpoint 只要失败一次，下一章定稿后就跨入不可覆盖区，没有一章缓冲，也没有本地 fallback 摘要。

这不是要求简单把某个常量改成 11。只调阈值只能把故障从第 12 章推迟到第 13/21 章，不能解决长期记忆失败和写作硬阻断。

### Root Cause D：错误诊断和测试覆盖不完整

当前测试明确断言“preview coverage 不足必须 blocked”，因此现有测试保护的是错误产品语义。另一方面，没有 Story Memory checkpoint 对 `reasoning_only`、`length`、`no_choices`、空 content 的恢复测试，也没有“第 12 章 + 首 checkpoint 失败后仍能生成”的端到端测试。

## 4. 修复目标与不可破坏的不变量

### 4.1 必须达成

1. 没有长期记忆、长期记忆 failed/dirty、检查点整理失败时，大纲创作仍能继续发起 AI 写作。
2. 用户必须在写作前或发起时看到明确提示，知道历史连续性可能下降，并能跳转到故事记忆页面重构。
3. 不把“未注入”伪装成“已覆盖”；Trace 和预览必须显示降级范围与遗漏章数。
4. 检查点空响应必须进入有界恢复流程，按 `emptyReason` 采取正确动作。
5. 任一重试都必须有次数和 token 上限，不能无限调用或无限扩大成本。
6. 已成功的旧 checkpoint 不能因后续批次失败而失去可用性。
7. 修复不能自动删除用户章节、Story Memory 或已有 snapshots。

### 4.2 继续保持

- 最近完整正文最多 10 章的硬上限继续保留；
- 不将 reasoning 内容当作业务 JSON；
- 不伪造 LLM 未提取出的结构化人物、关系、主线和事实；
- Future/same-position checkpoint 继续禁止注入，避免时间穿越；
- 非法目标章节位置继续硬阻断；
- 章节定稿和正文保存不依赖长期记忆成功。

## 5. 目标行为设计

### 5.1 把 `blocked` 拆成“致命错误”和“质量告警”

建议将 `PrepareStoryMemoryResult` 演进为以下语义（字段名可在实现时微调）：

```ts
interface PrepareStoryMemoryResult {
  checkpoint: ProjectStoryMemoryRecord | null;
  checkpointEligibility: CheckpointEligibilityResult;
  coverage: StoryMemoryCoveragePlan;
  checkpointUpdated: boolean;

  // 仅真正无法构建请求时为 true。
  fatal: boolean;
  fatalReason: string;

  // 长期记忆不可用、部分历史未覆盖等均走 warning。
  degraded: boolean;
  warnings: Array<{
    code:
      | 'story_memory_missing'
      | 'story_memory_dirty'
      | 'story_memory_failed'
      | 'checkpoint_update_failed'
      | 'history_partially_omitted';
    message: string;
    uncoveredChapterIds?: number[];
    action: 'open_story_memory' | 'adjust_context' | 'retry_later';
  }>;
}
```

为降低 P0 改动面，也可以暂时保留 `blocked/blockReason`，但必须遵循：

- 只有非法 target position 等真正致命情况设置 `blocked=true`；
- coverage gap 一律 `blocked=false`，通过新增 `warnings` 或 `degradedReason` 输出；
- `buildContext()` 只对 fatal/blocked 抛异常。

### 5.2 非阻断降级顺序

当检查点不可用或更新失败时，按以下顺序构建可用上下文：

1. 使用最后一个仍可用且严格早于目标章节的 clean checkpoint；
2. 使用已有 `memory_summary` 作为 episodic fallback；
3. 注入最近最多 10 章完整正文，保留最近章末 seam；
4. 更早且没有摘要的章节保持 `uncovered`，不伪造摘要、不突破完整正文 10 章上限；
5. 继续编译 Writer 请求，同时添加告警和 Trace：遗漏起止章节、遗漏章数、实际注入方式；
6. 用户选择继续即正常调用 Writer，选择“整理长期记忆”则跳转 Story Memory 页面。

建议用户文案：

```text
长期记忆暂不可用，已使用最近 10 章正文继续写作。
较早的 1 章未纳入本次请求，人物与伏笔连续性可能下降。
你可以继续生成，或稍后前往“故事记忆”重新整理。
```

禁止继续使用“无法安全生成”描述 coverage gap；它会让用户误以为正文存在数据损坏。

### 5.3 Preview 与正式写作保持一致

Preview 不调用 checkpoint LLM，但必须能展示降级后的真实预估请求：

- 不再因 coverage gap 抛 Toast error；
- 页面顶部显示 warning panel；
- “查看资料分配”中 `story_memory` 显示状态与原因；
- `story_memory_bridge` 显示最近正文/摘要覆盖；
- 增加 `history_omitted` 或等价 trace，列出未注入章节；
- 预览显示的 messages 必须与正式 Writer 的降级策略一致。

正式写作可以在后台/前置阶段尝试一次 checkpoint 更新，但失败只追加 warning，不得中止 Draft。P0 可先保留同步尝试以控制改动范围；P1 应把自动整理与 Writer 可用性解耦，避免模型超时让用户长时间停留在“构建上下文”。

## 6. Checkpoint 空响应修复设计

### 6.1 统一结果分类

`requestCheckpoint()` 不应把空文本直接压成一个通用异常。应返回或抛出带结构字段的结果：

```ts
interface StoryMemoryAttemptFailure {
  kind: 'empty_response' | 'invalid_json' | 'validation_error' | 'provider_error';
  emptyReason?: LLMResult['emptyReason'];
  finishReason?: string | null;
  requestedMaxTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  attempt: number;
}
```

不得把 prompt、章节正文、完整模型响应或 reasoning 内容写入错误日志。

### 6.2 有界恢复矩阵

| 首次结果 | 下一步 | 是否使用旧输出作 assistant 消息 |
|---|---|---|
| `reasoning_only` | fresh retry；`thinking: {type:'disabled'}`；在模型上限内提高输出预算 | 否 |
| `length` | 提高预算；仍失败则把 3 章 batch 拆为更小子批次 | 否 |
| `empty` | fresh retry 一次，可关闭 thinking | 否 |
| `no_choices` | 按网关/Provider 错误失败，显示可操作诊断 | 否 |
| `content_filter` | 不盲目重试；提示 Provider 拒绝输出 | 否 |
| 非空但 JSON 不完整 | 进入现有 repair；达到 length 时扩大预算或缩 batch | 是 |
| JSON 可解析但校验失败 | 进入现有带 validation error 的 repair | 是 |

关键规则：

- 空输出不能构造 `assistant: ''` 的 repair 对话；应重新发 fresh retry；
- `reasoning_content` 永远不能回填成 `text`；
- `thinking: disabled` 只作为 reasoning-only 的恢复动作，避免对不支持该扩展的网关首请求即报 400；如 Provider 明确识别 thinking 参数不支持，应回退到无 thinking 参数的 bounded retry；
- 总物理请求次数建议最多 3 次；子批次降级仍需受整次整理总调用数约束；
- 手动重建与自动 checkpoint 必须复用同一个 attempt coordinator，不能各自实现不同重试语义。

### 6.3 预算必须读取真实模型能力

当前 `checkpointMaxTokens()` 只根据 `memoryPatchMaxTokens` 和 batch size 推导 2400～16000，没有同时约束活动 LLM 配置的 `context_window` 与 `max_output_tokens`。

建议新增 Story Memory budget planner：

```text
safeOutputMax = min(
  configured max_output_tokens,
  context_window - estimatedInputTokens - protocolSafety
)
```

- 若 `safeOutputMax` 小于完成最小 JSON 所需预算，先缩小 batch，不要发送必然失败的请求；
- reasoning-only 时优先关闭 thinking，再考虑提高预算；
- length 时优先在配置上限内增大输出；到达上限后缩 batch；
- UI 错误要显示建议调整的 `context_window/max_output_tokens`，但不得把“扩大上下文”当作唯一解决办法。

### 6.4 保存最近成功状态，不让失败污染可用 checkpoint

增量 advance 已处理“batch1 成功、batch2 失败”时保留最近 clean checkpoint；重建路径也必须使用相同语义：

- 首批尚未成功：状态可保持 `empty` 或 `failed`，并记录 `lastError`；
- 已至少成功一批：`throughChapterPosition` 与 `memory_json` 保留最近成功批次，eligibility 仍可用；
- dirty rebuild 失败：不得把旧脏状态伪装为 clean；可回退到编辑位置之前的最近 clean snapshot；
- 重建尝试状态与“最后可用 checkpoint 状态”概念上应分离。P0 可通过保守状态写回实现，后续若需要完整审计再考虑独立 attempt 表。

## 7. 分阶段实施方案

### P0：解除写作硬阻断

涉及文件：

- `src/services/storyMemory/storyMemoryPrepare.ts`
- `src/services/contextBuilder.ts`
- `src/types/contextTrace.ts`（如新增遗漏 trace）
- `src/screens/ContextPreviewScreen.tsx`
- `src/screens/chapter-editor/hooks/useChapterPipeline.ts` 或统一告警展示组件

改动：

1. Preview coverage gap 返回 degraded warning，不再 `blocked=true`。
2. Generation checkpoint/rebuild 失败后重新规划 coverage，但即使仍 uncovered 也返回可用降级结果，不再抛 `MEMORY_CHECKPOINT_COVERAGE_GAP`。
3. `buildContext()` 仅对 fatal error 抛出；继续生成 pending bridge、recent chapters、outline 和其他资料。
4. 对未覆盖章节添加明确 Trace 和可见 warning。
5. 正式生成前用一次可确认/可继续的提示，不能要求用户必须先重建。

P0 不改变数据库，不改变 10 章完整原文上限，不自动清空记忆。

### P1：修复长期记忆空响应和重试

涉及文件：

- `src/services/storyMemory/storyMemoryCheckpointService.ts`
- `src/services/storyMemory/storyMemoryService.ts`（单章兼容路径也有同类空响应早退）
- `src/services/storyMemory/storyMemoryRebuild.ts`
- `src/services/llm.ts` / `src/services/llm/types.ts`（仅在需要透传已有字段时）
- 可新增 `src/services/storyMemory/storyMemoryAttemptPolicy.ts`
- 可新增 `src/services/storyMemory/storyMemoryBudget.ts`

改动：

1. 让空响应进入统一 attempt coordinator。
2. 消费 `emptyReason/finishReason`，按恢复矩阵 fresh retry。
3. reasoning-only 的下一次调用传 `thinking: disabled`。
4. length 在真实模型能力范围内扩容；到顶后缩小 batch。
5. 输出可操作且脱敏的错误信息。
6. 修正 rebuild partial-success 状态写回。

### P2：解耦自动整理与 Writer 启动

目标：coverage hardDue 时不让用户等待一次完整 Story Memory 重建后才开始 Writer。

建议：

- Writer 使用当前可用的 frozen degraded context 立即启动；
- Story Memory 整理以现有项目锁单飞运行；
- 整理成功只影响下一次写作，不修改已冻结任务上下文；
- 同一项目同一范围使用 dedupe key，避免 Preview、定稿和正式写作同时重复调用；
- 自动任务失败只更新 Story Memory 状态与通知，不回写当前 Writer 为 failed。

若本轮不引入持久后台队列，至少应使用进程内 single-flight + 明确的重试入口，不能 fire-and-forget 后吞错。

### P3：恢复现有受影响项目

升级后无需数据迁移：

1. `empty/failed + through=-1`：点击“立即整理长期记忆”从第 1 章重新尝试；
2. 已有部分 applied batch：从最后成功 `throughPosition + 1` 继续；
3. dirty 项目：从编辑影响点之前最近有效 snapshot 重建；
4. 不要求用户“清空并重建”；清空只能保留为高级、明确确认的最后手段；
5. 即使恢复仍失败，写作也走 P0 降级路径。

## 8. 测试计划

### 8.1 必须先修改的旧断言

以下测试当前把错误语义锁成了正确行为，需要改写：

- `__tests__/storyMemoryPrepare.test.ts`
  - “preview hard-due ... blocks”改为“返回 degraded warning 且不阻断”。
- `__tests__/storyMemoryPreparedSnapshotIntegration.test.ts`
  - “coverage insufficient ... blocks generation”改为“checkpoint 不注入、历史部分遗漏、请求仍可编译”。

### 8.2 新增单元测试

1. 目标第 12 章、前 11 章有正文、无 checkpoint、无摘要：
   - `blocked/fatal=false`；
   - raw 正文不超过 10 章；
   - `uncoveredChapterIds` 精确包含第 1 章；
   - warnings 含遗漏 1 章。
2. 同场景调用 `buildContext()`：
   - 返回非空 messages；
   - outline 仍完整注入；
   - trace 明确记录 history omitted；
   - 不调用 Preview LLM。
3. 正式 generation 自动 checkpoint 失败：
   - Writer 请求仍可编译；
   - warning 带 `checkpoint_update_failed`；
   - Story Memory 错误不覆盖 Draft 错误状态。
4. 首次 checkpoint 返回 `reasoning_only`，第二次 thinking-disabled 返回合法 JSON：成功持久化。
5. 首次返回 `length`，扩容后成功。
6. 达到输出上限后由 3 章 batch 缩成 1 章并成功。
7. `no_choices/content_filter/empty` 分别产生正确、脱敏、可操作错误。
8. 三次均失败：整理失败，但原有 clean checkpoint 仍可注入。
9. 重建 batch1 成功、batch2 失败：状态仍以 batch1 的 clean checkpoint 为准。
10. 非法 target position 仍然 hard-block，防止修复把真实输入错误也软化。

### 8.3 集成与 UI 测试

端到端固定场景：

```text
新建大纲创作项目
→ 连续写并定稿 11 章
→ checkpoint 模型第一次返回 reasoning-only/empty
→ 新建第 12 章
→ 打开上下文预览
→ 显示降级告警和实际资料分配
→ 点击继续写作
→ Draft 正常进入运行态并返回正文
→ 前往故事记忆立即整理
→ bounded retry 成功
→ 下一次预览显示 clean checkpoint 已注入
```

还需验证：

- 第 20、30、50 章持续写作，不存在新的固定章数熔断；
- 低 `context_window/max_output_tokens` 配置给出预算建议而不是无限重试；
- App 重启后 failed/partial 状态可恢复；
- 取消重建不会取消正在运行的 Writer；
- UI 中“继续写作”与“前往故事记忆”均可访问且不会重复触发请求。

### 8.4 建议门禁命令

```bash
npx jest __tests__/storyMemoryPrepare.test.ts \
  __tests__/storyMemoryPreparedSnapshotIntegration.test.ts \
  __tests__/storyMemoryTenChapterBoundary.test.ts \
  __tests__/storyMemoryCheckpointService.test.ts \
  __tests__/storyMemoryCheckpointAdvanceFailure.test.ts \
  __tests__/storyMemoryPartialSuccessRecovery.test.ts \
  --runInBand

npm run verify
```

完成代码后再使用 TAVO-MINI Android emulator QA 覆盖上述真机路径；本方案阶段不构建 Release APK。

## 9. 验收标准

### 写作可用性

- 长期记忆表不存在、为空、dirty、failed 或重建失败时，第 12 章及后续章节仍可预览和生成。
- coverage gap 不再产生“构建上下文失败”。
- 用户能看到明确但非阻断的长期记忆告警。
- 用户无需清空数据即可继续写作和重新整理。

### 长期记忆可靠性

- reasoning-only/length 空响应能进入有界恢复流程。
- 合法恢复结果能写入 `project_story_memory`、`story_memory_batches`、章节 `memory_summary` 和 snapshot。
- 所有尝试失败时保存准确 `lastError`，不泄露 prompt、正文、API Key 或 reasoning。
- partial success 后最近 clean checkpoint 仍可用于下一次上下文。

### 成本与安全

- 单次 checkpoint 物理调用有硬上限；
- 不突破活动模型 `context_window/max_output_tokens`；
- 最近完整正文仍不超过 10 章；
- 不伪造长期记忆覆盖，不静默隐藏遗漏章节；
- 不改变章节正文、定稿状态和已存在的有效记忆。

## 10. 风险与回滚

| 风险 | 控制措施 |
|---|---|
| 降级生成可能遗漏早期伏笔 | 强告警、Trace 标明遗漏范围、保留一键重构入口 |
| reasoning-only 重试增加费用 | 最多 3 次、按 emptyReason 执行、达到模型上限立即停止 |
| 缩 batch 增加调用数 | 全任务总调用数上限 + dedupe + 只在 length 时启用 |
| 后台整理与 Writer 产生竞态 | Writer 冻结上下文；Story Memory 只影响后续任务；项目级 single-flight |
| 旧测试大量依赖 blocked | 先更改产品契约测试，再修改实现；保留非法 target 的硬阻断用例 |

回滚顺序：

1. P2 异步解耦可单独关闭，退回“同步尝试但失败后继续”；
2. P1 attempt coordinator 可通过内部 feature flag 暂时退回单次请求，但不得恢复写作 hard-block；
3. P0 非阻断语义是本问题的核心产品要求，不应回滚为“没有长期记忆就禁止写作”。

## 11. 最终建议

本次应按 **P0 非阻断 → P1 空响应恢复 → P2 解耦与去重 → 真机验收** 的顺序实施。

不要采用以下表面修复：

- 只把原文上限从 10 改成 11/20；
- 只把 checkpoint 间隔从 10 改成 9；
- 只扩大 `slidingWindowSize`；
- 只把“清空并重建”作为用户解决办法；
- 把 reasoning 内容当 JSON 使用；
- 捕获错误后静默假装历史已完整覆盖。

真正的修复边界是：**写作主链路永远不依赖长期记忆成功；长期记忆自身则通过分类诊断、有界重试、预算适配和最近成功状态保护恢复可靠性。**
