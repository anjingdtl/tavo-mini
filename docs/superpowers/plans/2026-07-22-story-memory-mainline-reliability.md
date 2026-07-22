# ShineWriter 故事记忆“故事主线”可靠性修复 Implementation Plan

> 本计划配套 SPEC：`docs/superpowers/specs/2026-07-22-story-memory-mainline-reliability-spec.md`。实施者必须按任务顺序执行，使用 `- [ ]` 更新进度；每个任务先写失败测试，再做最小实现。

**Goal:** 让故事记忆中的剧情弧、当前目标、活跃冲突、未解决线索、未兑现伏笔能够稳定生成、更新和结束，并阻止“摘要已有主线变化但结构化主线静默全空”。

**Architecture:** 保留现有 Story Memory Checkpoint 架构和完整状态原子链；只扩展主线 Patch、Prompt、Validator、Merger 与页面诊断。新增字段采用向后兼容默认值，不改数据库 Schema，不新增常规 LLM 请求。

**Tech Stack:** React Native CLI + TypeScript + SQLite JSON state + Zustand + Jest + `@testing-library/react-native`

**Current Baseline:** V2.5.17 / Database Schema 17 / StoryMemory State Schema 1 / Batch Patch Schema 2

---

## 0. 实施边界

### 允许修改

| 文件 | 类型 | 职责 |
|---|---|---|
| `src/services/storyMemory/storyMemoryTypes.ts` | 修改 | 主线 assessment、arc replace、冲突解决类型 |
| `src/services/storyMemory/storyMemoryDefaults.ts` | 修改 | 新补丁默认主线字段 |
| `src/services/storyMemory/storyMemoryPrompts.ts` | 修改 | 单章/批量/repair 主线契约 |
| `src/services/storyMemory/storyMemoryValidator.ts` | 修改 | 单章主线结构、引用、evidence、一致性校验 |
| `src/services/storyMemory/storyMemoryBatchValidator.ts` | 修改 | 批量归一化、摘要交叉校验、字段映射 |
| `src/services/storyMemory/storyMemoryMerger.ts` | 修改 | arc replace、objective clear、conflict resolve |
| `src/services/storyMemory/storyMemoryRenderer.ts` | 条件修改 | 仅在主线生命周期测试暴露显示问题时修改 |
| `src/screens/StoryMemoryScreen.tsx` | 修改 | 五项详细显示和全空诊断 |
| `__tests__/storyMemoryPrompts.test.ts` | 修改 | 既有 Prompt 回归 |
| `__tests__/storyMemoryBatchValidator.test.ts` | 修改 | 既有 Batch Validator 回归 |
| `__tests__/storyMemoryMerger.test.ts` | 修改 | 既有单章合并回归 |
| `__tests__/storyMemoryCheckpointMerger.test.ts` | 修改 | 既有批量映射回归 |
| `__tests__/StoryMemoryScreen.test.tsx` | 修改 | 页面回归 |
| `__tests__/storyMemoryMainlinePromptContract.test.ts` | 新增 | 主线 Prompt 精确契约 |
| `__tests__/storyMemoryMainlineValidator.test.ts` | 新增 | 主线一致性与兼容性 |
| `__tests__/storyMemoryMainlineLifecycle.test.ts` | 新增 | 五项完整生命周期 |

### 禁止修改

- `src/data/schema/**`
- `src/services/migrations/**`
- `src/data/repositories/storyMemoryRepository.ts`（除非发现现有序列化无法保存新增 JSON 字段；正常情况下不得修改）
- `src/services/storyMemory/storyMemoryPolicy.ts`
- `src/services/storyMemory/storyMemoryCoverage.ts`
- `src/services/contextBuilder.ts`
- 人物提取、人物召回、关系优先级算法
- `plotlines` / `project_plotlines`
- 流水线阶段和 LLM Provider
- Android 原生代码

若实施中必须突破以上禁止范围，应停止施工、记录证据并重新评审 SPEC，不得顺手扩展。

---

## Phase 0：基线、复现与护栏

### Task 0.1：阅读与工作区确认

**Files:** 无修改

- [ ] 阅读：

  ```text
  AGENTS.md
  README.md
  CHANGELOG.md
  docs/superpowers/specs/2026-07-18-structured-story-memory-design.md
  docs/superpowers/specs/2026-07-19-story-memory-checkpoint-architecture-spec.md
  docs/superpowers/specs/2026-07-22-story-memory-mainline-reliability-spec.md
  docs/STORY-MEMORY-CHECKPOINT-TEST-REPORT.md
  ```

- [ ] 检查工作区，不清理历史调试产物：

  ```powershell
  git status --short
  git branch --show-current
  node --version
  ```

- [ ] 若需要新分支，使用：

  ```powershell
  git switch -c codex/story-memory-mainline-reliability
  ```

  未经用户要求不要自动提交、推送或创建 PR。

### Task 0.2：运行基线

**Files:** 无修改

- [ ] 运行故事记忆专项基线：

  ```powershell
  npx jest __tests__/storyMemoryPrompts.test.ts __tests__/storyMemoryBatchValidator.test.ts __tests__/storyMemoryMerger.test.ts __tests__/storyMemoryCheckpointMerger.test.ts __tests__/StoryMemoryScreen.test.tsx --runInBand
  ```

- [ ] 运行工程门禁基线：

  ```powershell
  npm run verify
  ```

- [ ] 记录当前已有失败。不得把无关历史失败算作本轮修复结果。

### Task 0.3：写当前缺陷的失败测试

**Files:**

- Create: `__tests__/storyMemoryMainlinePromptContract.test.ts`
- Create: `__tests__/storyMemoryMainlineValidator.test.ts`

- [ ] 在 Prompt 契约测试中证明当前缺陷：

  - 单章模板缺少显式 `currentObjective`；
  - 批量模板缺少显式 `currentObjective`；
  - 两者缺少 `conflictResolutions`；
  - 两者缺少主线 changed/unchanged 判定；
  - repair 文案没有禁止清空主线绕过校验。

- [ ] 在 Validator 测试中构造：

  ```text
  chapterSummaries.mainlineChanges = ['林岚决定继续调查钟楼']
  mainlinePatch = 当前合法全空结构
  ```

  期望新行为为拒绝，但当前实现会通过。

- [ ] 运行并确认新增断言失败：

  ```powershell
  npx jest __tests__/storyMemoryMainlinePromptContract.test.ts __tests__/storyMemoryMainlineValidator.test.ts --runInBand
  ```

**Phase 0 完成条件：** 已有基线结果；新增测试稳定复现至少“目标字段缺失”和“摘要/主线矛盾被放行”两个根因。

---

## Phase 1：类型与向后兼容默认值

### Task 1.1：扩展主线 Patch 类型

**Files:**

- Modify: `src/services/storyMemory/storyMemoryTypes.ts`

- [ ] 新增或导出：

  ```ts
  export type MainlineChangeResult = 'changed' | 'unchanged';

  export interface MainlineChangeAssessment {
    result: MainlineChangeResult;
    reason: string;
  }

  export interface ConflictResolutionPatch {
    conflictRef: string;
    resolution: string;
    evidenceQuote: string;
  }

  export interface BatchConflictResolutionPatch {
    conflictRef: string;
    resolution: string;
    evidence: BatchEvidenceQuote[];
  }
  ```

- [ ] 将 `currentArcUpdate.action` 的联合类型扩展为 `replace`。

- [ ] 在 `MainlinePatch` 和 `BatchMainlinePatch` 中增加：

  ```ts
  assessment?: MainlineChangeAssessment;
  conflictResolutions: ...[];
  ```

  `assessment` 保持可选是为了编译期兼容旧库存 Patch；新模型输出是否必需由 Validator 决定。

- [ ] 不修改 `StoryMainline` 和 `StoryMemoryState` 的 Schema。

### Task 1.2：补默认补丁结构

**Files:**

- Modify: `src/services/storyMemory/storyMemoryDefaults.ts`
- Modify: `src/services/storyMemory/storyMemoryPrompts.ts`

- [ ] `createEmptyChapterMemoryPatch()` 的 `mainlinePatch` 增加：

  ```ts
  assessment: { result: 'unchanged', reason: '' },
  conflictResolutions: [],
  ```

- [ ] `createEmptyBatchPatch()` 同样增加两个字段。

- [ ] 不把 `currentObjective` 直接设为 `undefined` 后期待 JSON 出现；在 Prompt 专用 ordered schema 中显式插入：

  ```ts
  currentObjective: null
  ```

- [ ] 更新现有测试工厂中手写的 `mainlinePatch`，但只添加兼容字段，不改变测试原意。

### Task 1.3：编译验证

- [ ] 运行：

  ```powershell
  npm run typecheck
  npx jest __tests__/storyMemoryBatchValidator.test.ts __tests__/storyMemoryMerger.test.ts __tests__/storyMemoryCheckpointMerger.test.ts --runInBand
  ```

- [ ] 若大量测试因手写 fixture 缺字段失败，优先让新字段在类型层向后兼容；不要一次性重写无关 fixture。

**Phase 1 完成条件：** 新类型可编译，旧状态/旧补丁 fixture 不需要数据库迁移即可继续运行。

---

## Phase 2：Prompt 契约补全

### Task 2.1：新增主线抽取规则区块

**Files:**

- Modify: `src/services/storyMemory/storyMemoryPrompts.ts`
- Test: `__tests__/storyMemoryMainlinePromptContract.test.ts`

- [ ] 新增共享常量或函数 `mainlineExtractionUserBlock()`，内容必须覆盖：

  - 五项准确定义；
  - 有证据约束的概括；
  - arc start/update/complete/replace；
  - objective set/replace/clear；
  - conflict create/update/resolve；
  - thread open/update/resolve；
  - foreshadow open/partially_paid/paid；
  - 摘要和结构化主线同步；
  - 无变化时必须写 assessment reason。

- [ ] 单章和批量消息构建都复用该区块，避免两套规则漂移。

- [ ] 区块位置：人物检查清单之后，章节正文之后，严格输出范式之前。

### Task 2.2：补全单章输出范式

**Files:**

- Modify: `src/services/storyMemory/storyMemoryPrompts.ts`

- [ ] 单章 Prompt 的 `mainlinePatch` 必须按稳定顺序输出：

  ```text
  assessment
  currentArcUpdate
  currentObjective
  conflictUpserts
  conflictResolutions
  threadOpens
  threadUpdates
  threadResolutions
  foreshadowingUpserts
  timelineAnchors
  completedBeats
  ```

- [ ] `currentObjective` 空范式必须为 JSON `null`，不能被 `JSON.stringify` 省略。

- [ ] `PATCH_ITEM_CONTRACT` 增加 assessment、objective、conflict resolution 和临时引用格式。

### Task 2.3：补全批量输出范式

**Files:**

- Modify: `src/services/storyMemory/storyMemoryPrompts.ts`

- [ ] `createEmptyBatchPatch()` 和 `orderedBatchSchemaForPrompt()` 包含新增字段。

- [ ] `BATCH_ITEM_CONTRACT` 明确 evidence 数组格式。

- [ ] 保持字段总顺序：人物 → 关系 → 主线 → chapterSummaries。

- [ ] 不改变既有“人物优先于缩短输出”的规则。

### Task 2.4：加强 repair/retry 文案

**Files:**

- Modify: `src/services/storyMemory/storyMemoryPrompts.ts`

- [ ] 更新以下函数：

  - `buildStoryMemoryRepairMessages`
  - `buildStoryMemoryCheckpointRepairMessages`
  - `buildStoryMemoryCheckpointRetryMessages`
  - `buildStoryMemoryFreshRetryMessages`

- [ ] 明确禁止：

  - 删除主线操作以绕过摘要一致性；
  - 用 `unchanged` 掩盖摘要中的主线变化；
  - 用标题代替稳定 ID；
  - 新增正文不存在的情节。

### Task 2.5：Prompt 测试

- [ ] 测试字段存在、顺序和文案，而不是对整段 Prompt 做脆弱快照。

- [ ] 运行：

  ```powershell
  npx jest __tests__/storyMemoryMainlinePromptContract.test.ts __tests__/storyMemoryPrompts.test.ts --runInBand
  ```

**Phase 2 完成条件：** 单章、批量、repair 三条模型输出路径都能看见完整五项契约，`currentObjective` 不再被模板省略。

---

## Phase 3：主线 Validator 与一致性门禁

### Task 3.1：单章字段归一化

**Files:**

- Modify: `src/services/storyMemory/storyMemoryValidator.ts`
- Test: `__tests__/storyMemoryMainlineValidator.test.ts`

- [ ] 扩展 `normalizeOptionalPatchFields()`：

  - assessment result/reason 文本化；
  - `replace` 作为合法 arc action；
  - `conflictResolutions` 默认空数组；
  - objective JSON `null` 归一化为缺失；
  - conflict resolution 字段文本化。

- [ ] 新模型输出的 assessment reason 必须非空；旧库存 Patch 的兼容不通过伪造 reason 实现。

### Task 3.2：主线引用校验

**Files:**

- Modify: `src/services/storyMemory/storyMemoryValidator.ts`

- [ ] 新增以下精确引用检查：

  - `update/complete/replace` 的 arcRef 等于当前 arc ID；
  - `start` 只允许当前 arc 为空；
  - `conflictResolutions` 引用当前活跃冲突；
  - conflict/foreshadow 更新使用已有稳定 ID；
  - 新 conflict/thread/foreshadow 使用规定的 `new_*` 临时 ID；
  - 临时 ID 在同一 Patch 内唯一。

- [ ] 未知引用不得通过标题模糊匹配。

- [ ] 保持既有 soft-skip 风格时，必须返回 warning 或在后续一致性门禁中触发 repair；不能删完后无痕成功。

### Task 3.3：Evidence 校验

**Files:**

- Modify: `src/services/storyMemory/storyMemoryValidator.ts`

- [ ] 将 `conflictResolutions` 加入 evidence operations。

- [ ] objective clear（空 value）仍要求证据。

- [ ] arc replace 要求证据。

- [ ] recovery 后重新计算真正的五项 mutation 数量。

- [ ] 如果原 assessment 为 changed，但 recovery 后 mutation 数量为 0，抛出可 repair 的 StoryMemoryError。

### Task 3.4：Assessment 一致性纯函数

**Files:**

- Modify: `src/services/storyMemory/storyMemoryValidator.ts`
- Test: `__tests__/storyMemoryMainlineValidator.test.ts`

- [ ] 实现可单测的辅助逻辑，例如：

  ```ts
  function hasMainlineStateMutation(patch: MainlinePatch): boolean
  function validateMainlineAssessment(patch: MainlinePatch): void
  ```

- [ ] 规则：

  - changed + mutation > 0：通过；
  - changed + mutation = 0：失败；
  - unchanged + mutation = 0：通过；
  - unchanged + mutation > 0：失败；
  - 新模型输出缺 assessment：失败；
  - 旧库存 Patch 应由回放路径兼容，不应重新当作模型输出校验。

### Task 3.5：批量字段映射

**Files:**

- Modify: `src/services/storyMemory/storyMemoryBatchValidator.ts`
- Modify: `src/services/storyMemory/storyMemoryMerger.ts` 中 `batchPatchToChapterDraft`

- [ ] 批量 raw JSON 映射：

  - assessment；
  - currentObjective；
  - conflictResolutions；
  - arc replace。

- [ ] `batchPatchToChapterDraft()` 将 batch evidence 转换为单章 evidenceQuote。

- [ ] 所有旧 Patch 数组访问使用安全默认：

  ```ts
  draft.mainlinePatch.conflictResolutions ?? []
  ```

### Task 3.6：摘要与主线交叉校验

**Files:**

- Modify: `src/services/storyMemory/storyMemoryBatchValidator.ts`
- Test: `__tests__/storyMemoryMainlineValidator.test.ts`

- [ ] 聚合：

  - `mainlineChanges`
  - `newThreads`
  - `resolvedThreads`

- [ ] 实现 SPEC 7.4 的映射规则。

- [ ] 交叉校验必须发生在 evidence recovery 和无效引用过滤之后，确保看到最终真正会应用的 Patch。

- [ ] 失败使用现有可进入 repair 的错误码：

  - 单章：`MEMORY_PATCH_SCHEMA_INVALID` 或更具体的既有兼容码；
  - 批量：`MEMORY_CHECKPOINT_SCHEMA_INVALID`。

  本轮不要新增数据库错误状态。

### Task 3.7：Validator 测试矩阵

- [ ] 覆盖 SPEC 11.2 的全部场景。

- [ ] 额外覆盖：

  - assessment reason 为空；
  - objective clear 无证据；
  - replace 使用错误 arcRef；
  - conflict resolution 使用未知 ID；
  - recovery 删除最后一个 mutation；
  - 只有 timeline/completedBeats 不算五项 changed；
  - 旧 Batch Patch 缺 assessment/conflictResolutions 可安全进入 replay mapper。

- [ ] 运行：

  ```powershell
  npx jest __tests__/storyMemoryMainlineValidator.test.ts __tests__/storyMemoryBatchValidator.test.ts __tests__/storyMemoryValidator.test.ts --runInBand
  ```

**Phase 3 完成条件：** 新输出无法再以“摘要有主线、Patch 全空”的形式通过；合法无变化批次不产生无意义失败。

---

## Phase 4：确定性主线合并与生命周期

### Task 4.1：先写生命周期失败测试

**Files:**

- Create: `__tests__/storyMemoryMainlineLifecycle.test.ts`

- [ ] 建立最小 fixture：

  ```text
  Chapter 1：arc start + objective set + conflict/thread/foreshadow open
  Chapter 2：arc/objective/conflict/thread update + foreshadow partially_paid
  Chapter 3：conflict/thread resolve + foreshadow paid + arc replace
  Chapter 4：objective clear + arc complete
  ```

- [ ] 对每一步断言完整 `state.mainline`，不要只断言文本包含。

- [ ] 先运行并确认 `replace`、`conflictResolutions` 相关断言失败。

### Task 4.2：剧情弧 replace

**Files:**

- Modify: `src/services/storyMemory/storyMemoryMerger.ts`

- [ ] 将现有 arc 分支改成显式 switch，保持既有 start/update/complete 行为。

- [ ] 实现 replace 固定顺序：

  ```text
  归档旧 arc
  → 生成新 arc stable ID
  → 设置新 name/summary/startedChapterId
  ```

- [ ] 错误 arcRef 应在 Validator 阶段被过滤/拒绝；Merger 仍需防御，不得静默覆盖。

- [ ] 完成节点去重继续复用稳定 ID 或现有去重机制。

### Task 4.3：当前目标 set/replace/clear

**Files:**

- Modify: `src/services/storyMemory/storyMemoryMerger.ts`

- [ ] 保持缺失即不变。

- [ ] 非空 value 使用 trim 后结果。

- [ ] 空 value 合法清空。

- [ ] 同值重复设置不产生额外实体或指纹漂移。

### Task 4.4：冲突解决

**Files:**

- Modify: `src/services/storyMemory/storyMemoryMerger.ts`

- [ ] 在 conflict upsert 后处理 `conflictResolutions ?? []`。

- [ ] 解析同批临时引用和已有稳定 ID。

- [ ] 合法解决后：

  - 从 `activeConflicts` 删除；
  - 追加“冲突「标题」解决：resolution”完成节点；
  - 使用稳定 ID 去重；
  - evidence chapter 取正确章节；
  - 未知引用产生 warning，不影响其他主线项。

### Task 4.5：伏笔状态单向保护

**Files:**

- Modify: `src/services/storyMemory/storyMemoryMerger.ts`

- [ ] 保证合法顺序：

  ```text
  open → partially_paid → paid
  ```

- [ ] 已 paid 的伏笔不得被普通空字段或旧状态无证据恢复成 open。

- [ ] 不新增 StoryMainline 字段。

### Task 4.6：批量兼容与指纹

**Files:**

- Modify: `src/services/storyMemory/storyMemoryMerger.ts`
- Test: `__tests__/storyMemoryCheckpointMerger.test.ts`

- [ ] Batch → Chapter 映射保留 assessment 诊断字段，但 Merger 不把 assessment 写进 State。

- [ ] 旧 Batch 缺新增字段时不发生 `.map of undefined`。

- [ ] 对相同 base + patch 连续执行两次，断言：

  - 完成节点不重复；
  - 活跃冲突不会误删其他项；
  - state fingerprint 确定；
  - estimatedTokens 正常更新。

### Task 4.7：合并回归

- [ ] 运行：

  ```powershell
  npx jest __tests__/storyMemoryMainlineLifecycle.test.ts __tests__/storyMemoryMerger.test.ts __tests__/storyMemoryCheckpointMerger.test.ts __tests__/storyMemorySystemInvariants.test.ts --runInBand
  ```

**Phase 4 完成条件：** 五项可以进入、更新和退出；批量跨剧情弧切换不丢失旧弧完成记录；旧批次可回放。

---

## Phase 5：Renderer 与故事记忆页面

### Task 5.1：锁定 Renderer 行为

**Files:**

- Modify if needed: `src/services/storyMemory/storyMemoryRenderer.ts`
- Test: `__tests__/storyMemoryRenderer.test.ts`

- [ ] 先仅添加测试，确认现有 Renderer 已满足：

  - arc 名称 + 摘要；
  - objective；
  - conflict 状态 + stakes；
  - thread 描述；
  - paid 伏笔过滤；
  - 完成节点可注入；
  - Token 硬上限不变。

- [ ] 如果测试已通过，不修改 Renderer。

- [ ] 只有发现与新生命周期直接冲突时做最小修改。

### Task 5.2：页面五项详细显示

**Files:**

- Modify: `src/screens/StoryMemoryScreen.tsx`
- Test: `__tests__/StoryMemoryScreen.test.tsx`

- [ ] 把当前仅标题展示改为：

  - arc：名称 + summary；
  - conflict：title + state + stakes；
  - thread：title + description；
  - foreshadow：setup + expectedPayoff；
  - objective 保持完整文本。

- [ ] 对空可选字段使用简洁中文，不显示多余分隔符。

- [ ] 不在页面执行数据推断或 SQL。

### Task 5.3：全空诊断

**Files:**

- Modify: `src/screens/StoryMemoryScreen.tsx`
- Test: `__tests__/StoryMemoryScreen.test.tsx`

- [ ] 新增局部纯判断：

  ```text
  status=clean
  AND throughChapterPosition>=5
  AND currentArc/objective/conflicts/openThreads/unpaidForeshadowing 全空
  AND recentCompletedBeats/recentResolvedThreads/archiveDigest 均无主线历史
  ```

- [ ] 显示 SPEC 9.3 的诊断文案。

- [ ] 不自动展开高级操作，不自动重建。

- [ ] dirty/rebuilding/failed/empty 不显示该诊断。

- [ ] 如果五项为空但存在完成/解决历史，显示“当前没有活跃主线事项，最近主线节点已闭合”，不得显示未识别诊断。

### Task 5.4：UI 回归

- [ ] 运行：

  ```powershell
  npx jest __tests__/StoryMemoryScreen.test.tsx __tests__/storyMemoryRenderer.test.ts __tests__/storyMemoryRendererRetrieval.test.ts --runInBand
  ```

**Phase 5 完成条件：** 页面显示真实主线内容；长期全空时给出可理解诊断；Renderer 优先级和 Token 预算无回归。

---

## Phase 6：集成回归与工程门禁

### Task 6.1：12～15 章确定性生命周期测试

**Files:**

- Modify: `__tests__/storyMemoryMainlineLifecycle.test.ts`

- [ ] 扩展为至少 4 个批次、每批 3 章的净变化重放。

- [ ] 断言每批：

  - throughChapterPosition；
  - state status；
  - 当前 arc/objective；
  - active conflict 数量；
  - open thread 数量；
  - unpaid foreshadow 数量；
  - recentCompletedBeats；
  - state fingerprint。

- [ ] 中间插入一个合法 unchanged 批次，证明不会误报。

### Task 6.2：检查点请求数回归

**Files:**

- Test only: `__tests__/storyMemoryThirtyChapter.test.ts`

- [ ] 不改变该测试原本的“30 章 / 10 次请求”目标。

- [ ] 更新 fixture 兼容新增主线字段，但不得通过新增主线专用请求使请求数上升。

- [ ] 运行并断言主请求仍为 10。

### Task 6.3：结构化故事记忆专项回归

- [ ] 运行：

  ```powershell
  npx jest __tests__/storyMemoryMainlinePromptContract.test.ts __tests__/storyMemoryMainlineValidator.test.ts __tests__/storyMemoryMainlineLifecycle.test.ts --runInBand
  npx jest __tests__/storyMemoryPrompts.test.ts __tests__/storyMemoryBatchValidator.test.ts __tests__/storyMemoryValidator.test.ts --runInBand
  npx jest __tests__/storyMemoryMerger.test.ts __tests__/storyMemoryCheckpointMerger.test.ts __tests__/storyMemoryRebuild.test.ts --runInBand
  npx jest __tests__/storyMemoryThirtyChapter.test.ts __tests__/storyMemoryTwentyChapter.test.ts --runInBand
  npx jest __tests__/StoryMemoryScreen.test.tsx __tests__/storyMemoryRenderer.test.ts __tests__/storyMemorySystemInvariants.test.ts --runInBand
  ```

### Task 6.4：代码反模式扫描

- [ ] 扫描：

  ```powershell
  rg -n "currentObjective|conflictResolutions|assessment|action: 'replace'" src/services/storyMemory __tests__
  rg -n "SELECT |INSERT |UPDATE |DELETE " src/screens/StoryMemoryScreen.tsx
  rg -n "plotlines|project_plotlines" src/services/storyMemory src/screens/StoryMemoryScreen.tsx
  ```

- [ ] 预期：

  - 新字段覆盖 Prompt/Validator/Merger/Test；
  - Screen 无 SQL；
  - 本轮未接入 plotlines。

### Task 6.5：全量门禁

- [ ] 运行：

  ```powershell
  npm run lint
  npm run typecheck
  npm run test:ci
  npm run test:coverage
  ```

- [ ] `npm run verify` 必须最终再跑一次：

  ```powershell
  npm run verify
  ```

- [ ] 记录测试套件数量、测试数量、覆盖率和任何历史 warning。

**Phase 6 完成条件：** 主线专项和全量门禁通过，30 章检查点请求数不增加，无 Schema/plotline/SQL 越界。

---

## Phase 7：Android 真实模型与旧项目验收

### Task 7.1：准备固定验收剧本

**Files:**

- Add artifacts only under: `test-logs/story-mainline-acceptance-<date>/`

- [ ] 准备 12～15 章固定文本，明确包含：

  - arc start/update/replace/complete；
  - objective set/change/clear；
  - conflict open/update/resolve；
  - thread open/update/resolve；
  - foreshadow open/partial/paid；
  - 一个合法无变化批次。

- [ ] 不把临时 DB、截图、日志写到仓库根目录。

### Task 7.2：Android 模拟器真实模型验收

- [ ] 启动应用并导入/创建固定剧本。

- [ ] 每章保存并定稿，按当前 smart 策略形成检查点。

- [ ] 每个检查点记录：

  ```text
  through/status
  main checkpoint 请求数
  repair/retry 次数
  arc/objective/conflict/thread/foreshadow 状态
  Context Preview 主线文本
  ```

- [ ] 必须通过 SPEC 12.2 的 10 个场景。

- [ ] 若 repair 率异常升高，先记录模型原始结构问题；不得通过删除校验器解决。

### Task 7.3：既有四五十章项目副本验收

- [ ] 先创建应用内备份并验证备份文件存在。

- [ ] 只在副本/可恢复环境执行“清空并重建”。

- [ ] 验收：

  - through 到最后定稿章；
  - status clean；
  - 五项与最近正文持续状态相符；
  - 已解决冲突/线索不残留；
  - 已 paid 伏笔不显示；
  - 人物/关系没有灾难性丢失；
  - 没有正文外虚构。

- [ ] 保存脱敏验收摘要，不提交用户小说正文。

### Task 7.4：失败与恢复验证

- [ ] 在可恢复测试项目上验证：

  - 主线一致性 repair 最终失败时，章节仍保持定稿；
  - 最后有效 checkpoint 不被无效输出覆盖；
  - 用户可以稍后“立即整理”或重建；
  - 取消重建不会留下伪 clean 状态。

**Phase 7 完成条件：** 自动化正确性与真实模型语义质量均有证据，旧项目有可操作恢复路径。

---

## Phase 8：文档、版本与交付

### Task 8.1：更新文档

**Files（实施完成后按实际结果修改）：**

- Modify: `CHANGELOG.md`
- Modify: `README.md`（仅必要的版本/能力摘要）
- Modify: `docs/optimization/progress.md`
- Add: `docs/<version>-STORY-MAINLINE-RELIABILITY-REPORT.md`

- [ ] 施工报告必须包含：

  - 根因；
  - 实际修改文件；
  - Patch 契约；
  - 兼容策略；
  - 测试命令与结果；
  - Android 真实模型结果；
  - repair 率；
  - 旧项目重建结果；
  - 已知限制。

- [ ] 不把确定性单测描述成真实模型验收。

### Task 8.2：版本处理

- [ ] 由维护者确认目标版本后，再同步：

  - `package.json`
  - `CHANGELOG.md`
  - `README.md`

- [ ] 不手改 `src/constants/version.json`；使用既有 `npm run prebuild` 生成。

- [ ] 未经明确要求不构建 Release APK。

### Task 8.3：最终差异检查

- [ ] 运行：

  ```powershell
  git status --short
  git diff --stat
  git diff --check
  ```

- [ ] 确认没有：

  - 数据库迁移；
  - Android/iOS 文件；
  - 新依赖；
  - 根目录测试产物；
  - 用户小说正文；
  - 无关格式化。

- [ ] 最终再运行：

  ```powershell
  npm run verify
  ```

---

## 推荐提交拆分

仅在用户授权提交后使用；每个提交必须保持可测试。

```text
test(story-memory): capture mainline extraction gaps
feat(story-memory): complete mainline prompt and validation contract
feat(story-memory): add mainline lifecycle merge operations
feat(story-memory): improve mainline status display and diagnostics
test(story-memory): add mainline lifecycle and regression coverage
docs(story-memory): document mainline reliability closure
```

不得把版本升级、APK、无关文档和核心代码混入同一提交。

---

## 最终验收清单

### Scope

- [ ] 只修改故事主线相关链路和测试
- [ ] 无数据库 Schema 变更
- [ ] 无 plotlines 接线
- [ ] 无人物/关系/召回算法修改
- [ ] 无常规 LLM 请求增加

### Contract

- [ ] 单章/批量模板都有 currentObjective
- [ ] 单章/批量模板都有 assessment
- [ ] 单章/批量模板都有 conflictResolutions
- [ ] repair 禁止清空主线绕过校验

### Validation

- [ ] changed/unchanged 与操作一致
- [ ] 摘要与 mainlinePatch 一致
- [ ] evidence recovery 后重新校验
- [ ] 旧 Patch 安全兼容

### Lifecycle

- [ ] arc start/update/complete/replace
- [ ] objective set/replace/clear
- [ ] conflict create/update/resolve
- [ ] thread open/update/resolve
- [ ] foreshadow open/partial/paid
- [ ] 幂等和指纹稳定

### UI

- [ ] 五项显示完整信息
- [ ] paid 伏笔不显示
- [ ] 多章 clean 但全空时显示诊断
- [ ] 不自动触发重建

### Quality gates

- [ ] 主线专项 Jest 通过
- [ ] 30 章请求数回归通过
- [ ] `npm run verify` 通过
- [ ] `npm run test:coverage` 通过
- [ ] Android 固定剧本通过
- [ ] 既有长篇副本重建通过

---

## Execution Handoff

实施 Agent 从 Phase 0 开始，按 checkbox 更新本文。任何需要修改 Schema、repository 持久化格式、Context Builder、人物/关系或检查点调度的发现，都视为超出本 PLAN：先暂停，给出代码证据和最小替代方案，再由维护者决定是否扩展范围。
