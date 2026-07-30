# 原著续写：连续接缝与定稿关联修复方案

> 文档状态：Ready for implementation  
> 编制日期：2026-07-30  
> 适用版本：V2.10.7 / Schema 26  
> 范围：原著续写（Continuation）生成、采纳、定稿、状态提取与 Android Debug 回归  
> 本轮不做 Release APK，不创建或修改签名材料。

## 1. 结论与目标

本轮要修复两个已经确认的生产问题：

1. **第二篇及之后的续写仍反复以原著最后一章为接缝。**当前 Context Builder 每次都读取原著末章尾段，Writer 每次都把它放进 prompt；即使已有续写前章，也没有「前一篇续写优先」的强约束。结果会表现为模型重复原著结尾，或把原著末章直接接到每一篇续写前。
2. **从“采纳”回到编辑器后再定稿时，生成 run 未关联到定稿任务。**编辑器调用 `finalizeContinuationChapter()` 时没有传 `sourceRunId`。因此状态提取任务拿不到生成时冻结的 `resolvedModelConfigIds.stateExtraction`，会回退为当下项目配置；同时 proposal 无法可靠追溯其来源 run。

完成后必须满足：

- 只有没有任何前序续写正文时，才允许把原著边界尾段作为正文接缝。
- 已有前序续写正文时，下一篇只以**位置最高的前序续写章尾段**作为正文接缝；原著只经 Canon、已确认续写状态、Story Memory 和摘要提供背景，不得再注入原著末章原文。
- 采纳后的定稿能够自动找回对应 run，并使用该 run 冻结的状态提取模型配置；手写章节则有明确、安全的 fallback。
- 结果页不能静默采纳与原著接缝大段重复的正文。

## 2. 已确认根因

### 2.1 原著接缝被无条件注入

`buildContinuationContext()` 读取 bounded source 的最后一章并总是填充 `bundles.seam`；`compilePlannerMessages()` 与 `compileWriterMessages()` 每次都注入该 block。`recentChapters` 虽然也存在，但没有优先级语义或互斥关系。

这不是“数据库把原著正文字符串拼接写入 chapters”的问题：`adoptArtifactAsDraft()` 是将 artifact **整体覆盖**到目标章节。问题发生在 LLM prompt 层，因此必须改接缝选择策略、提示词和验收测试，而不能只改保存逻辑。

### 2.2 重复检测没有阻断采纳

`runDeterministicChecks()` 能识别 `source_overlap`，但只把它记录为 error/warning。`ContinuationResultScreen` 对所有非空 artifact 都允许“采纳”，所以重复原著末章的正文依然能进入草稿并被定稿。

### 2.3 UI 路径遗漏 sourceRunId

`ContinuationResultScreen` 调用 `adoptArtifactAsDraft({ runId })`，完成后返回编辑器；`ChapterEditor` 后续定稿只传 `projectId/chapterId/content`。run 表已有 `chapter_id`、`completion_reason='adopted'`、`adopted_revision_hash` 与冻结 settings snapshot，故本轮**无需新增 schema 字段**即可稳定反查来源 run。

## 3. 不变量与边界

1. `chapters.position` 仍是 0-based `ContinuationChapterPosition`；不得写入原著 `SourceChapterPosition`。
2. 原著边界、Canon 和 style profile 仍只能通过既有 bounded SourceReader / CanonQueryService 读取。
3. 生成中的 Context Snapshot 必须冻结接缝选择结果；后续不因数据库变动改变本次 run 的 prompt。
4. 已存在的 schemaVersion 1 run 必须可继续查看、恢复与采纳；不要求重建旧 run。
5. 不把原著正文保存进 `chapters`，不放宽原著边界，不在 transaction 内调用 LLM。
6. 手写、导入或历史章节没有可关联 run 时，状态提取允许使用项目的 state-extraction 设置，但 outbox payload 必须写明 fallback 原因。

## 4. 施工设计

### 4.1 建立显式的“正文接缝选择”模型

在 `src/services/continuation/generation/` 新增一个小型纯函数（建议 `continuationAnchor.ts`），输入为：

- `targetPosition`；
- 已按 `position DESC, id DESC` 排序、且正文非空的前序续写章节；
- 原著边界尾段（仅作为没有前序续写时的候选）。

输出需明确区分：

```ts
type ContinuationAnchor = {
  kind: 'source_seam' | 'continuation_chapter';
  summary: string;
  excerpt: string;
  chapterId: number | null;
  position: ContinuationChapterPosition | null;
};
```

选择规则：

| 条件 | `kind` | Writer/Planner 可见正文接缝 |
| --- | --- | --- |
| 没有正文非空的前序续写章 | `source_seam` | 原著边界尾段 |
| 存在前序续写章 | `continuation_chapter` | position 最大、同 position 时 id 最大的前序续写章尾段 |

不得使用 `targetPosition === 0` 作为唯一判断；位置有洞、删除或首次创建空章节时都必须按“前序**非空正文**是否存在”决定。已有的 `recentChapters` 仍作为短期历史桥接，但它不是当前接缝的替代选择逻辑。

### 4.2 Context Snapshot 与兼容性

修改 `ContinuationContextSnapshot`：增加 `primaryAnchor?: ContinuationAnchor`，并将新生成的 snapshot `schemaVersion` 升为 2。保留原 `bundles.seam` 供 schemaVersion 1 历史 run 读取：

- 新 snapshot：`primaryAnchor` 是唯一可注入的正文接缝；当 `kind='continuation_chapter'` 时，`bundles.seam.excerpt` 必须为空，不再携带原著末章原文。
- 旧 snapshot：Prompt Compiler 没有 `primaryAnchor` 时沿用 legacy `bundles.seam`，确保已有 run 可恢复。
- Trace 新增 `primaryAnchorKind`、`primaryAnchorChapterId`、`primaryAnchorPosition`，结果页将其展示为“本章接缝：原著边界”或“本章接缝：续写第 N 章”。不要在 trace 展示正文。

`buildContinuationContext()` 的推荐顺序：

1. 先读取前序续写章节并选出 `primaryAnchor`；
2. 仅当没有前序正文时，再通过 SourceReader 读取原著边界尾段；
3. `recentChapters` 继续按现有预算从新到旧收集，但必须排除已作为 primary anchor 的重复全文（可保留其较短摘要/标识，不能让同一原文重复占满预算）；
4. 用选定 anchor、recent bridge、Canon、Effective State 和 Story Memory 组装冻结快照。

### 4.3 修改 Prompt Compiler

将 `seamBlock()` 替换为兼容型 `primaryAnchorBlock()`：

- `source_seam`：`【当前正文接缝：原著边界】`，只在第一篇有效续写时输出；
- `continuation_chapter`：`【当前正文接缝：最近续写第 N 章】`，包含该章尾段；
- legacy snapshot：继续渲染旧 `bundles.seam`，避免旧 run 失效。

Planner 与 Writer 系统提示新增硬规则：

> 当存在“当前正文接缝：最近续写第 N 章”时，必须从该续写章结尾继续推进。原著内容仅用于 Canon/背景核验；不得从原著末章重新起笔、复述或连续复制原著正文。

Writer 不应同时出现原著正文接缝和最近续写正文接缝。Checker/Repair 若需要 Canon，继续使用 Canon facts，不回退读取原著正文。

### 4.4 重复检测与采纳门槛

1. 对 `source_seam`，沿用最长公共连续子串检查；连续重合阈值建议保持 24 字告警、40 字 error。
2. 对 `continuation_chapter`，新增 `continuation_anchor_overlap`：检测生成正文开头与前一续写章尾段的异常长复制，避免简单把上一章重复一遍；正常的短承接句不得误伤。
3. `source_overlap` 达到 error 时，结果页不能直接“采纳”。优先调用已有 Repair；Repair 后仍存在 error 时显示“检测到与原著接缝大段重复”，只提供“重新生成/放弃”。
4. 不要把所有 Canon error 一刀切禁用采纳。本轮只对 `source_overlap`（及新增 anchor 的严重整段重复）启用硬门槛，以避免改变既有审核策略。
5. 为结果页增加明确原因和修复建议；不能仅显示 error 数量。

### 4.5 让定稿自动关联来源 run（无 migration）

在 `generationRepository.ts` 新增只读查询，例如：

```ts
findLatestAdoptedRunForChapter(projectId: number, chapterId: number)
```

查询条件：`project_id`、`chapter_id`、`state='completed'`、`completion_reason='adopted'`，按 `completed_at DESC, created_at DESC` 取一条。该查询代表“当前章节最近一次被采纳的 AI 续写来源”；即使作者在采纳后做了人工编辑，仍应沿用这次 run 冻结的 state-extraction 配置。

在 `finalizeContinuationChapter()` 内部：

1. 若调用方显式传入 `sourceRunId`，先验证该 run 属于相同 project/chapter，验证失败即拒绝；
2. 若未传，调用上述查询自动解析来源 run；
3. 解析到 run 后，从其 `settingsSnapshotJson.resolvedModelConfigIds.stateExtraction` 读取冻结配置；将 run id、config id 写入 extract_state outbox，并在同一 transaction 更新 `finalized_revision_hash`；
4. 没有来源 run 时，payload 写入 `sourceRunId: null` 与 `configNote: 'manual_or_unknown_source_run'`。Worker 只在该明确 fallback 情况使用项目当前 `stateExtractionLlmConfigId`；
5. 保留现有“章节 + Story Memory dirty + extract_state + rebuild outbox”的单事务边界、幂等 dedupe key 与冷启动处理。

`ChapterEditor` 可以继续不持有跨页面 run state；服务层反查是权威路径。可选地传递 run id 仅是优化，不得成为正确性依赖。

## 5. 自动化测试计划

新增的测试必须采用真实服务/纯函数断言，不只做文本搜索或 mock 后的自我证明。

### 5.1 单元测试

建议新增 `__tests__/continuationAnchor.test.ts`：

1. 无前序续写正文：选 `source_seam`，原著尾段存在。
2. 有 position 0 正文，目标 position 1：选 position 0 的 `continuation_chapter`，不读取/不返回原著正文。
3. 三章连续：目标 position 2 选择 position 1，而非 position 0 或原著末章。
4. position 有洞、同 position 多条异常数据时：按最大 position、最大 id 稳定选择。
5. 前序章节为空、planned：忽略，正确回退原著接缝。

补充 Prompt Compiler 测试：

- 第二章/第三章的 Planner、Writer prompt 含“最近续写第 N 章”和该章标记；**不含**原著末章唯一标记。
- 第一章 prompt 含原著边界尾段。
- schemaVersion 1 snapshot 仍能编译并保留 legacy seam。

补充 Checker/Result 测试：

- 40 字以上原著重叠产生 `source_overlap:error`；
- 结果页不渲染可直接执行的“采纳”路径，而是展示重新生成/放弃；
- 普通 warning 与非 overlap 的既有行为不回归。

### 5.2 Repository 与事务测试

扩展 `__tests__/continuationPhase3Repository.test.ts`：

1. 仅通过先 `adoptArtifactAsDraft()`、再 `finalizeContinuationChapter()`（不显式传 run id）的真实调用路径，断言 outbox payload 包含正确 `sourceRunId` 和冻结 `llmConfigId`。
2. 采纳后人工编辑正文再定稿，仍关联最近 adopted run，且 `finalized_revision_hash` 是编辑后的 hash。
3. 手写章节定稿：sourceRunId 为 null、configNote 为明确 fallback，不抛错。
4. 显式传入外项目/外章节 run：拒绝且无任何事务写入。
5. outbox insert 故障时，章节、SM、run 的 finalized hash、outbox 全部回滚。

### 5.3 连续生成集成回归

新增或扩展 `__tests__/continuationSequentialGeneration.test.ts`，以三个唯一标记构造场景：

- 原著末章：`【ORIGINAL_FINAL_TAIL】`；
- 第一续写章尾段：`【CONTINUATION_1_TAIL】`；
- 第二续写章尾段：`【CONTINUATION_2_TAIL】`。

断言：

| 目标章 | 必须含接缝标记 | 禁止含 |
| --- | --- | --- |
| 第 1 篇续写 | `ORIGINAL_FINAL_TAIL` | 无 |
| 第 2 篇续写 | `CONTINUATION_1_TAIL` | `ORIGINAL_FINAL_TAIL` |
| 第 3 篇续写 | `CONTINUATION_2_TAIL` | `ORIGINAL_FINAL_TAIL`、`CONTINUATION_1_TAIL` 作为当前接缝 |

还要断言冻结 snapshot trace 的 anchor kind/position 与表格一致，并确认原著 boundary 之后的内容从未出现。

### 5.4 必跑门禁

```powershell
npx jest __tests__/continuationAnchor.test.ts __tests__/continuationSequentialGeneration.test.ts __tests__/continuationPhase3Repository.test.ts __tests__/continuationPhase3Pipeline.test.ts __tests__/continuationResultScreen.test.tsx __tests__/continuationChapterNumbering.test.ts --runInBand --ci
npm run lint
npm run typecheck
npm run verify
```

若新增数据层或 schema manifest 代码，额外运行 `npm run test:coverage`；本轮按设计不应新增 migration。

## 6. Android 模拟器 Debug 验收

模拟器已由用户启动。使用新建的测试项目，**不要**执行 `pm clear`、不要删除用户项目或数据库、不要构建 Release APK。

### 6.1 构建与安装

```powershell
adb devices
npm run apk:debug
adb -s emulator-5554 install -r "dist/apk/debug/ShineWriter-V2.10.7-debug.apk"
```

若版本号随施工变更，以 `dist/apk/debug/` 中由 `npm run apk:debug` 新生成的唯一 APK 为准。所有截图、UI dump、logcat 只写入 `test-logs/continuation-anchor-finalization-YYYYMMDD/`，不污染仓库根目录。

### 6.2 UI 验收步骤

1. 新建一个独立测试续写项目（名称含日期），导入至少 3 章原著；原著末章结尾写入可辨识标记，例如“原著末章唯一锚点”。完成边界与 Canon 准备。
2. 新建第 1 篇续写章，打开“查看实际上下文”，确认 trace/预览显示“本章接缝：原著边界”。生成、采纳、编辑器内定稿。
3. 在资料页确认存在状态提取/记忆任务；若有 proposal，确认或拒绝并观察任务可完成。不要把“已排队”误记为已经成功，须确认 outbox 不为 failed。
4. 新建第 2 篇续写章，打开“查看实际上下文”：必须显示“本章接缝：续写第 1 章”，原著末章唯一锚点不得出现在 Writer context。生成并采纳后，正文开头不得复制原著末章。
5. 同样生成第 3 篇续写章：接缝必须为第 2 篇续写章；不得重新回接原著末章。
6. 对第 2 或第 3 篇做小幅人工编辑后定稿，检查状态提取成功、proposal 能追溯 run，且没有“冻结配置丢失”或 outbox failed。
7. 如果设备没有可用的真实 LLM 配置，完成 context-preview、定稿 outbox、run 关联和 UI 路由验收；将“真实模型三章生成”明确记录为受配置阻塞，不能虚报通过。

### 6.3 判定标准

- P0：第 2/3 篇 context 或正文中仍出现原著末章连续复制，或错误接缝 → 不通过。
- P0：采纳后定稿的 outbox 未带 sourceRunId/冻结 config，或任何原子写入半成功 → 不通过。
- P1：source-overlap error 仍可直接采纳 → 不通过。
- P1：Debug APK 无法安装、应用启动崩溃、ReactNativeJS/SQLite FATAL → 不通过。

## 7. 交付物

1. 业务代码、测试与必要的文档更新；不新增 schema migration，除非施工中证明现有 run 反查无法满足上述不变量。
2. 测试命令输出和通过数量。
3. Debug APK：`dist/apk/debug/ShineWriter-V<当前版本>-debug.apk`。
4. 模拟器验收记录：项目名、三章接缝结果、outbox/run 关联结果、截图/UI dump/logcat 路径、真实 LLM 是否可用。
5. 简短变更说明，列出未完成或受阻项，不得把缺少 LLM 配置写成通过。

