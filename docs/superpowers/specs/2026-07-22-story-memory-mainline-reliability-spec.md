# ShineWriter 故事记忆“故事主线”可靠性修复 SPEC

| 字段 | 值 |
|---|---|
| 文档日期 | 2026-07-22 |
| 文档状态 | 待实施 |
| 当前基线 | V2.5.17 / 数据库 Schema 17 |
| 目标版本 | 下一功能版本（实施时由维护者确定） |
| 数据库 Schema | 保持 17，不新增迁移 |
| Story Memory State Schema | 保持 1 |
| Batch Patch Schema | 保持 2，新增字段必须向后兼容 |
| 优先级 | P1：长篇故事连续性与功能可信度 |
| 主要影响范围 | 故事主线 Prompt、主线 Patch 校验、确定性合并、故事记忆页面、专项测试 |
| 前置规格 | `docs/superpowers/specs/2026-07-18-structured-story-memory-design.md`、`docs/superpowers/specs/2026-07-19-story-memory-checkpoint-architecture-spec.md` |

---

## 0. 文档用途

本文是对既有结构化故事记忆的**局部增量修订**，只修复故事记忆页面中以下五项长期为空或生命周期不完整的问题：

1. 当前剧情弧；
2. 当前目标；
3. 活跃冲突；
4. 未解决线索；
5. 未兑现伏笔。

本文不重新设计整个 Story Memory，不替代既有检查点、Pending Bridge、Episodic Retrieval、人物和关系机制。未被本文明确修改的既有设计与系统不变量继续有效。

目标不是强迫每一章都产生主线变化，也不是用程序臆造故事，而是确保：

> **当章节正文和章节摘要已经包含持续性主线信息时，模型必须把它转换为可校验、可合并、可结束的结构化主线状态；当确实没有变化时，系统必须能解释这是“本批无变化”，而不是静默漏提。**

---

## 1. 已确认现状与根因

### 1.1 当前可见症状

已写作、定稿并整理四五十章后，故事记忆页面的“故事主线”仍可能长期显示：

```text
剧情弧：无
当前目标：无
活跃冲突：无
未解决线索：无
未兑现伏笔：无
```

顶部“已整理到第 N 章 / 状态正常”只证明检查点请求、校验和持久化流程完成，不证明五项主线信息已经被有效抽取。

### 1.2 已确认代码根因

1. `MainlinePatch.currentObjective` 存在于 TypeScript 类型和合并器中，但单章、批量空模板都没有显式输出该字段；Prompt 同时要求模型不得自创字段，因此该字段极易永久为空。
2. `currentArcUpdate.action = 'none'` 和所有主线数组为空是合法输出；现有校验只检查结构、引用和证据，不检查“章节摘要已有主线信号但结构化主线为空”。
3. Prompt 对人物和关系有大量硬性要求，对五项主线只有简略字段说明，模型在输出预算紧张时会优先省略主线。
4. `chapterSummaries.mainlineChanges`、`newThreads`、`resolvedThreads` 与 `mainlinePatch` 之间没有一致性约束。
5. 活跃冲突只有 `conflictUpserts`，没有解决操作；冲突一旦加入就没有可靠的退出生命周期。
6. 批量检查点若跨越“旧剧情弧结束、新剧情弧开始”，现有 `start/update/complete` 单操作不能无损表达替换语义。
7. 批量校验的 evidence 恢复路径可能软删除不合格主线项；删除后若结构仍合法，系统可能把“主线项被清空”当作成功。
8. Story Memory 页面只显示简短标题或“无”，无法区分“确实没有主线信息”和“已整理但未识别”。

### 1.3 当前功能并非完全未接线

现有合并器和 Renderer 已能持久化并注入部分主线字段。问题主要位于：

```text
模型输出契约不完整
  → 主线语义缺少硬要求
  → 校验允许静默全空
  → 生命周期缺少冲突解决/剧情弧替换
  → 页面只能显示“无”
```

因此本轮应补齐这条链路，不应另建第二套故事系统。

---

## 2. 修复目标

### 2.1 必须达成

1. 单章与批量 Prompt 都显式展示 `currentObjective` 输出位置。
2. 五项主线字段都有明确、互斥且可执行的抽取规则。
3. 新模型输出必须明确声明“本批主线有变化”或“本批主线无变化”。
4. 章节摘要包含主线信号时，不允许结构化主线静默全空。
5. 剧情弧支持开始、更新、完成和替换。
6. 当前目标支持设置、替换和有证据地清空。
7. 活跃冲突支持新增、更新和解决后移出。
8. 线索继续支持打开、更新、解决，并加强引用和一致性校验。
9. 伏笔继续支持打开、更新、部分兑现和完全兑现。
10. 旧 State、旧单章 Patch 和旧 Batch Patch 继续可读、可回放。
11. 不增加常规检查点请求次数；只有发现输出自相矛盾时才复用现有 repair。
12. 页面能区分“当前确实为空”和“已整理多章但未识别到有效主线”。
13. 自动化和真实模型验收都能证明五项状态随剧情推进而正确进入和退出。

### 2.2 成功定义

在一部包含明确剧情弧、目标、冲突、线索和伏笔的固定验收小说中：

- 第一阶段整理后，预期打开的五项状态均存在；
- 中段更新后，不产生重复实体，状态内容被更新；
- 解决阶段后，已解决冲突和线索从“活跃/未解决”列表移出；
- 已兑现伏笔不再出现在“未兑现伏笔”；
- 新剧情弧替换旧剧情弧时，当前弧正确切换，旧弧进入已有完成节点历史；
- 上下文 Renderer 注入的主线内容与页面状态一致；
- 任一时刻都不得出现“摘要声称主线变化，但结构化主线全空且检查点仍成功”的结果。

---

## 3. 严格范围边界

### 3.1 本轮允许修改

- `src/services/storyMemory/storyMemoryTypes.ts`
- `src/services/storyMemory/storyMemoryDefaults.ts`
- `src/services/storyMemory/storyMemoryPrompts.ts`
- `src/services/storyMemory/storyMemoryValidator.ts`
- `src/services/storyMemory/storyMemoryBatchValidator.ts`
- `src/services/storyMemory/storyMemoryMerger.ts`
- `src/services/storyMemory/storyMemoryRenderer.ts`（仅主线渲染和测试需要时）
- `src/screens/StoryMemoryScreen.tsx`
- 与上述文件直接对应的 Jest 测试
- 本轮变更说明、验收记录和版本文档

### 3.2 非目标

本轮不实现：

- 数据库 Schema 18；
- 新表、新列或新 repository 领域；
- 将 `plotlines` / `project_plotlines` 接入 Story Memory；
- 用户手工编辑底层主线 JSON；
- Embedding、向量数据库、第二模型或 LLM reranker；
- 新增常规 LLM 调用；
- 修改检查点间隔、Due Policy、Pending Bridge 或 Seam；
- 修改人物抽取、人物历史桶、关系优先级或实体召回；
- 修改流水线阶段和上下文快照结构；
- 自动在启动、迁移或页面打开时触发付费重建；
- 仅为修复页面观感而伪造默认剧情弧或默认目标。

### 3.3 明确禁止

1. 禁止在页面层从章节正文临时推测主线。
2. 禁止把 `chapterSummaries.mainlineChanges` 直接无证据复制进全局状态。
3. 禁止因为某个主线 evidence 不合法就静默删除所有主线操作并返回成功。
4. 禁止遇到未知引用时用标题模糊匹配到任意已有实体。
5. 禁止自动清空现有项目并重建。
6. 禁止修改人物和关系的既有 Prompt 优先级语义。
7. 禁止以增加每章一次独立“主线抽取请求”解决问题。

---

## 4. 术语与五项语义

| 字段 | 定义 | 应记录 | 不应记录 |
|---|---|---|---|
| 当前剧情弧 | 当前正在推进的一段中期叙事阶段 | “潜入王城”“调查钟楼失踪案” | 整部小说题材、单章动作、空泛主题 |
| 当前目标 | 当前核心行动方下一步持续推进的明确目标 | “找到进入档案室的钥匙” | “活下去”“继续调查”等无对象泛化语句 |
| 活跃冲突 | 尚未解决、会约束后续行动的对抗或障碍 | 人物对抗、阵营冲突、资源争夺 | 一次性争吵、已结束战斗、纯情绪波动 |
| 未解决线索 | 已提出但尚未回答、兑现或闭合的问题/秘密/承诺 | 失踪者去向、未解密码、未履行承诺 | 已解释事实、普通场景细节 |
| 未兑现伏笔 | 正文有明确铺垫且预期后续回收的信号 | 被反复强调的物品、预言、异常征兆 | 任意装饰性描写、模型自行预测的剧情 |

### 4.1 有证据约束的概括

主线字段允许做**保守概括**，否则“剧情弧”和“当前目标”很难逐字出现在正文中。概括必须满足：

1. 概括中的人物、行为、对象、状态均能由 evidence 支持；
2. 不引入正文未出现的新事件、新动机或未来结果；
3. `evidence` / `evidenceQuote` 仍必须是正文连续原文；
4. 概括粒度只到“当前持续状态”，不得扩展为完整故事大纲。

### 4.2 “无变化”不是“没填写”

新输出必须携带主线变更判定：

```ts
interface MainlineChangeAssessment {
  result: 'changed' | 'unchanged';
  reason: string;
}
```

- `changed`：至少存在一个真正改变五项状态的操作；
- `unchanged`：五项操作均为空/`none`，且 `reason` 必须说明本批为何没有持续性变化；
- 旧 Patch 缺少该字段时，程序按 legacy 输入处理，不影响回放；
- `assessment` 是补丁诊断信息，不新增到 `StoryMemoryState`，不改变页面数据源。

---

## 5. 目标 Patch 契约

### 5.1 保持现有 Schema 版本

本轮字段均为向后兼容扩展：

- `StoryMemoryState.schemaVersion` 保持 `1`；
- 单章 Patch `schemaVersion` 保持 `1`；
- Batch Patch `schemaVersion` 保持 `2`；
- 数据库表中的 `schema_version` 不变；
- 旧 JSON 缺少新增字段时统一归一化为安全默认值。

不得因为本轮修改创建数据库迁移。

### 5.2 `currentObjective` wire 协议

模型输出范式必须显式包含：

单章：

```json
"currentObjective": null
```

有变化时：

```json
"currentObjective": {
  "value": "找到进入地下档案室的钥匙",
  "evidenceQuote": "林岚说，无论如何先找到那把钥匙"
}
```

批量模式将 `evidenceQuote` 替换为 `evidence[]`。

语义：

- `null` 或缺失：保持上一目标不变；
- 非空 `value`：设置或替换当前目标；
- 空字符串 `value`：正文明确表明旧目标已完成/放弃且暂无新目标时清空；
- 清空操作仍必须提供合法 evidence；
- 不得用空 evidence 的空字符串覆盖已有目标。

TypeScript 内部可继续使用现有可选 `currentObjective?: ...`，wire JSON 的 `null` 在归一化后变为 `undefined`。

### 5.3 剧情弧操作

扩展 `currentArcUpdate.action`：

```ts
type CurrentArcAction =
  | 'none'
  | 'start'
  | 'update'
  | 'complete'
  | 'replace';
```

规则：

| action | 前置状态 | 结果 |
|---|---|---|
| `none` | 任意 | 保持当前弧 |
| `start` | 当前弧为空 | 创建新弧 |
| `update` | 当前弧存在，`arcRef` 精确匹配 | 更新名称/摘要 |
| `complete` | 当前弧存在，`arcRef` 精确匹配 | 归档完成节点并清空当前弧 |
| `replace` | 当前弧存在，`arcRef` 精确匹配 | 归档旧弧，同时创建新弧 |

`replace` 用于批量检查点跨越旧弧结束和新弧开始的场景。不得用 `start` 静默覆盖已有弧。

### 5.4 冲突解决操作

新增补丁类型：

```ts
interface ConflictResolutionPatch {
  conflictRef: string;
  resolution: string;
  evidenceQuote: string;
}

interface BatchConflictResolutionPatch {
  conflictRef: string;
  resolution: string;
  evidence: BatchEvidenceQuote[];
}
```

并在两种 `mainlinePatch` 中加入：

```ts
conflictResolutions: ConflictResolutionPatch[];
```

合并规则：

1. `conflictRef` 必须精确引用 `activeConflicts` 中的 ID；
2. 合法解决后从 `activeConflicts` 删除；
3. 使用已有 `recentCompletedBeats` 保存简短完成记录：`冲突「标题」解决：resolution`；
4. 同一冲突重复解决必须幂等，不重复追加完成节点；
5. 未知引用不得删除其他冲突，归一化阶段应丢弃并产生 warning；
6. 旧 Patch 缺少 `conflictResolutions` 时按空数组处理。

### 5.5 冲突、线索和伏笔引用

新增实体必须使用明确临时引用：

- `new_conflict_*`
- `new_thread_*`
- `new_foreshadow_*`

更新和解决必须使用输入状态中的精确稳定 ID。

不得继续使用空 `ref` 依赖标题隐式判断“新增还是更新”。合并器可以继续生成稳定 ID，但生成依据必须包含合法临时引用和章节证据；同一 Patch 内引用必须可解析。

### 5.6 主线变更判定

`mainlinePatch` 新增：

```ts
assessment: {
  result: 'changed' | 'unchanged';
  reason: string;
};
```

下列任一操作视为 `changed`：

- 剧情弧 action 非 `none`；
- 存在 `currentObjective`；
- `conflictUpserts` 或 `conflictResolutions` 非空；
- `threadOpens`、`threadUpdates` 或 `threadResolutions` 非空；
- `foreshadowingUpserts` 非空且确实改变 open/partially_paid/paid 状态。

`timelineAnchors` 和 `completedBeats` 不属于页面五项，不得单独把 assessment 判为 `changed`。

---

## 6. Prompt 规格

### 6.1 单章与批量模板必须一致

两套 Prompt 都必须：

1. 显式给出 `assessment`；
2. 显式给出 `currentObjective: null`；
3. 显式给出 `conflictResolutions: []`；
4. 给出五项定义、更新条件和反例；
5. 给出已有剧情弧、冲突、线索、伏笔的精确 ID；
6. 要求输出前进行主线一致性自检。

### 6.2 主线抽取检查清单

Prompt 中新增独立区块，放在人物/关系检查清单之后、输出范式之前：

```text
【故事主线检查清单】
1. 当前叙事阶段是否开始、推进、完成或切换？
2. 核心行动方是否形成、改变、完成或放弃持续目标？
3. 是否出现仍未解决的对抗/障碍，或已有冲突已经解决？
4. 是否提出新的未解问题/秘密/承诺，或旧线索已经闭合？
5. 是否出现明确铺垫，或已有伏笔部分/完全兑现？
6. 若 chapterSummaries 写入 mainlineChanges/newThreads/resolvedThreads，必须同步输出对应结构化操作。
7. 若上述均无变化，assessment.result=unchanged 并给出简短原因；不得以空数组代替判断。
```

### 6.3 输出优先级

保持人物与关系优先的既有要求，但主线必须位于长 `chapterSummaries` 之前：

```text
newCharacters
→ characterUpdates
→ newRelationships
→ relationshipUpdates
→ mainlinePatch
→ chapterSummaries
```

不得降低人物抽取的既有强度；本轮只要求主线不再被长摘要静默挤掉。

### 6.4 Repair Prompt

现有修复消息追加：

```text
若 chapterSummaries 已写明主线变化、新线索或解决事项，禁止把 mainlinePatch 改成全空来绕过校验。
修复 assessment 与实际操作的一致性。
未知引用应改为输入状态中的精确 ID；新增实体应使用规定的 new_* 临时引用。
只修复结构、引用、证据和主线一致性，不新增正文没有的剧情。
```

### 6.5 请求次数约束

- 不新增“主线专用常规请求”；
- 正常检查点仍为一次请求；
- 只有主线一致性校验失败时才走已有 repair/retry；
- 不允许每章额外调用一次主线模型；
- usage scenario 名称保持现状，不新增数据库字段。

---

## 7. 校验与归一化规格

### 7.1 处理顺序

新输出按以下顺序处理：

```text
JSON / shape 校验
→ 新字段默认值归一化
→ 主线实体引用校验
→ evidence 校验与有限恢复
→ assessment 与操作一致性校验
→ chapterSummaries 与 mainlinePatch 交叉校验
→ 确定性合并
```

### 7.2 旧补丁兼容

旧补丁缺失新字段时：

```ts
assessment = undefined;          // legacy，不对旧数据执行新强校验
conflictResolutions = [];
```

旧补丁不得因为缺少新字段而变为 invalidated 或 failed。

新模型输出必须包含 `assessment`；仅 repository 中已存在的旧 Patch 可走 legacy 兼容。

### 7.3 Assessment 一致性

| assessment | 实际五项操作 | 结果 |
|---|---|---|
| `changed` | 至少一项 | 通过 |
| `changed` | 全空 | 校验失败，触发 repair |
| `unchanged` | 全空 | 通过 |
| `unchanged` | 存在操作 | 校验失败，触发 repair |
| 缺失 | 新模型输出 | 校验失败，触发 repair |
| 缺失 | 旧库存 Patch | legacy 通过 |

### 7.4 摘要交叉校验

聚合本批所有 `chapterSummaries`：

- `mainlineChanges` 非空：assessment 必须为 `changed`，且至少有剧情弧、目标、冲突或伏笔操作；
- `newThreads` 非空：必须存在 `threadOpens`，或已有同一稳定线索被 `threadUpdates` 更新；
- `resolvedThreads` 非空：必须存在 `threadResolutions`、`conflictResolutions`、伏笔 `paid` 或剧情弧 `complete/replace` 中至少一种闭合操作；
- 如果摘要三类字段均为空，允许 `unchanged`；
- 不允许根据关键词字符串自动写入状态，只能要求模型 repair。

### 7.5 Evidence 恢复边界

现有 evidence recovery 可继续尝试从正文找到连续原文，但：

1. 恢复前被标记为 `changed` 的关键主线操作全部被删除后，必须重新运行一致性校验；
2. 若删除导致主线全空，不得静默成功，必须触发 repair；
3. `timelineAnchors` / `completedBeats` 的既有 soft-drop 兼容可保留；
4. 五项关键操作不得被同一 catch 分支整体清空后直接返回成功。

### 7.6 引用校验

- `update/complete/replace` 的 `arcRef` 必须匹配当前弧；
- `conflictResolutions.conflictRef` 必须存在于活跃冲突；
- `threadUpdates/threadResolutions` 必须引用现有或同批新线索；
- 更新既有伏笔必须引用现有 ID；
- 新实体临时引用必须唯一、格式合法；
- 错误引用不得通过标题模糊匹配其他实体。

---

## 8. 确定性合并规格

### 8.1 合并不变量

1. 相同 previous state + 相同规范化 Patch 必须得到相同结果指纹。
2. 同一 Patch 重放不得重复添加冲突、线索、伏笔或完成节点。
3. 更新必须保留 `openedChapterId`，只更新 `lastChangedChapterId` 和 evidence。
4. 解决操作必须先验证目标存在，再删除活跃状态。
5. 未知引用只影响该操作，不得清空整个主线。

### 8.2 剧情弧替换

`replace` 的应用顺序固定为：

```text
校验旧 arcRef
→ 把旧弧摘要写入 recentCompletedBeats
→ 创建新弧稳定 ID
→ 设置新弧 name/summary/startedChapterId
```

若旧弧不存在或 ID 不匹配，操作不得降级为 `start`。

### 8.3 当前目标

- `currentObjective` 缺失：保持；
- `value.trim()` 非空：替换；
- `value === ''` 且 evidence 合法：清空；
- 不对目标做标题相似度合并；
- 同值重复设置应保持幂等。

### 8.4 冲突解决

解决活跃冲突后：

```text
activeConflicts 删除目标
recentCompletedBeats 追加“冲突「标题」解决：resolution”
```

完成节点继续受现有有界归档规则约束。

### 8.5 伏笔兑现

- `open` 和 `partially_paid` 继续保存在 `foreshadowing`；
- `paid` 可以保留在状态中作为历史，但页面和 Renderer 的“未兑现”列表必须过滤；
- 同一伏笔从 `paid` 不得被无证据改回 `open`。

---

## 9. UI 规格

### 9.1 数据来源

页面继续只读取已持久化的 `record.state.mainline`。屏幕不得直接读取章节正文，不得直接写 SQL，不得调用 LLM 推测显示内容。

### 9.2 五项展示

- 剧情弧：`名称｜摘要`；
- 当前目标：完整目标文本；
- 活跃冲突：`标题｜当前状态｜代价`；
- 未解决线索：`标题｜说明`；
- 未兑现伏笔：`铺垫 → 预期兑现`，若预期兑现为空则只显示铺垫。

所有列表继续使用稳定 ID 作为 React key。

### 9.3 全空诊断

当满足：

```text
throughChapterPosition >= 5
AND 五项展示状态全部为空
AND metadata.status === 'clean'
AND recentCompletedBeats/recentResolvedThreads/archiveDigest 均无主线历史
```

页面在五项上方显示：

```text
已完成多章长期记忆整理，但尚未识别到有效故事主线。
若正文包含持续目标、冲突或悬念，可在高级操作中清空并重建。
```

该提示不应显示为系统错误，不应自动启动重建。

若五项当前状态为空，但 `recentCompletedBeats`、`recentResolvedThreads` 或 `archiveDigest` 表明此前存在并已闭合的主线历史，则显示普通说明：

```text
当前没有活跃主线事项，最近主线节点已闭合。
```

不得将其误报为“未识别”。

### 9.4 合法空状态

以下情况继续显示普通“无”，不显示异常诊断：

- 尚未整理任何章节；
- 只整理少量开篇章节；
- 状态为 dirty、rebuilding 或 failed；
- 当前五项已在收尾章全部闭合，且状态中仍有完成/解决历史。

本轮不要求新增主线编辑器。

---

## 10. 既有项目与重建策略

### 10.1 不自动迁移语义数据

代码升级不会修改旧 `memory_json`，也不会在数据库迁移、启动或打开页面时自动调用模型。

### 10.2 推荐恢复路径

已经存在四五十章且五项长期为空的项目：

1. 升级后先创建本地备份；
2. 确认所有需要纳入的章节已经定稿；
3. 在故事记忆高级操作中执行现有“清空并重建”；
4. 等待状态恢复为 clean 且 through 到达最后定稿章；
5. 核对人物、关系数量与五项主线结果；
6. 结果异常时保留备份并记录模型输出/错误，不覆盖原备份。

### 10.3 为什么首版不新增“仅重建主线”

现有批次指纹、快照和项目状态以完整 `StoryMemoryState` 为原子链。单独改写 `mainline` 而不重算批次链会产生第二事实来源；为主线另建独立批次链又会扩大 Schema、备份和恢复范围。

因此本轮复用已有完整重建路径。未来若确有成本需求，应另立 SPEC，不得在本轮临时实现半套主线回填。

---

## 11. 测试规格

### 11.1 Prompt 契约

必须断言：

- 单章与批量模板包含 `assessment`；
- 包含 `currentObjective`；
- 包含 `conflictResolutions`；
- 包含五项定义与一致性检查清单；
- Repair Prompt 禁止通过清空主线绕过校验；
- 主线字段仍位于长 `chapterSummaries` 之前。

### 11.2 Validator

至少覆盖：

1. `changed + 全空` 拒绝；
2. `unchanged + 存在操作` 拒绝；
3. 摘要 `newThreads` 非空但无 `threadOpens` 拒绝；
4. 摘要 `resolvedThreads` 非空但无闭合操作拒绝；
5. 主线 evidence recovery 全部删除后重新触发失败；
6. 合法无变化批次通过；
7. 旧 Patch 缺新字段继续通过；
8. 未知冲突/线索/伏笔引用不会误改其他实体。

### 11.3 Merger 生命周期

至少覆盖：

- arc start/update/complete/replace；
- objective set/replace/clear；
- conflict create/update/resolve；
- thread open/update/resolve；
- foreshadow open/partially_paid/paid；
- 同 Patch 重放幂等；
- 解决后活跃列表正确移除；
- 状态指纹稳定；
- Batch Patch 到 Chapter Draft 的新增字段映射完整。

### 11.4 UI

至少覆盖：

- 五项有内容时显示完整摘要；
- clean 且已整理 6 章以上、五项全空时显示诊断；
- empty/dirty/failed 不误显示诊断；
- `paid` 伏笔不显示在未兑现列表；
- 多项列表 key 稳定且无重复告警。

### 11.5 集成剧本

新增 12～15 章确定性主线剧本，分三阶段：

1. **开启阶段**：新剧情弧、明确目标、活跃冲突、新线索、伏笔；
2. **推进阶段**：目标改变、冲突升级、线索更新、伏笔部分兑现；
3. **闭合/切换阶段**：冲突解决、线索解决、伏笔兑现、旧弧替换为新弧。

确定性测试使用固定合法 Patch，不依赖外部模型；真实语义质量在 Android 模拟器专项验收。

### 11.6 回归命令

```powershell
npx jest __tests__/storyMemoryMainlinePromptContract.test.ts --runInBand
npx jest __tests__/storyMemoryMainlineValidator.test.ts --runInBand
npx jest __tests__/storyMemoryMainlineLifecycle.test.ts --runInBand
npx jest __tests__/storyMemoryBatchValidator.test.ts __tests__/storyMemoryPrompts.test.ts --runInBand
npx jest __tests__/storyMemoryMerger.test.ts __tests__/storyMemoryCheckpointMerger.test.ts --runInBand
npx jest __tests__/StoryMemoryScreen.test.tsx __tests__/storyMemoryRenderer.test.ts --runInBand
npm run verify
npm run test:coverage
```

新增测试文件名可在实施时小幅调整，但职责不得合并成一个难以定位的大测试文件。

---

## 12. Android 与真实模型验收

### 12.1 新建验收项目

使用固定 12～15 章文本，不使用生产小说作为唯一证据。每三章定稿一次检查点，记录：

- through position；
- status；
- 每批 repair/retry 次数；
- 五项主线状态；
- 解决前后活跃实体数量；
- Context Preview 中的主线文本。

### 12.2 必过场景

1. 开篇检查点创建剧情弧和目标；
2. 新冲突、线索、伏笔进入页面；
3. 中段更新不重复创建；
4. 冲突解决后从活跃列表移出；
5. 线索解决后从未解决列表移出；
6. 伏笔 paid 后从未兑现列表移出；
7. arc replace 后页面显示新弧；
8. 页面状态与 Context Preview 一致；
9. 普通过渡批次可 `unchanged` 且不触发无意义 repair；
10. 章节定稿仍不因检查点失败回滚正文。

### 12.3 既有长篇项目验收

对备份副本执行“清空并重建”，验收：

- status 最终为 clean；
- through 到达最后定稿章；
- 人物与关系没有灾难性丢失；
- 若最近章节仍存在明确持续目标/冲突/线索，五项不得全部为空；
- 已解决的冲突和线索不继续显示为活跃；
- 不把正文未出现的内容写入主线。

真实项目不用于自动化精确字符串断言，只用于人工语义复核。

---

## 13. 性能、成本与安全

1. 正常检查点请求数不得增加。
2. Prompt 增量应控制在约 800～1500 中文字符以内，实施后记录实际 Token 差值。
3. 新增字段不得显著扩大 `StoryMemoryState`；assessment 只保存在 Patch，不进入 State。
4. 主线实体继续受 Renderer Token 硬上限约束。
5. 不新增 npm 包、原生模块、网络域名或权限。
6. 不在日志输出正文、API Key 或完整模型响应。
7. 真实模型验收产生的输出放入 `test-logs/`，不得污染仓库根目录。

---

## 14. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Prompt 加强后模型过度抽取 | 五项定义、反例、证据校验、合法 unchanged |
| 一致性门禁增加 repair 率 | 只在摘要与 Patch 矛盾时触发；记录真实 repair 率 |
| 旧 Patch 缺新字段无法回放 | legacy 归一化，新增字段默认安全值 |
| arc replace 破坏旧弧 | 必须精确 arcRef，错误时拒绝而非覆盖 |
| 冲突解决误删实体 | 精确稳定 ID，未知引用只丢该操作 |
| evidence recovery 再次静默清空 | recovery 后强制重跑主线一致性校验 |
| 长篇重建改变人物/关系 | 先备份；首版复用已有完整原子重建，不做隐式迁移 |
| 页面把合法收尾误报为空 | 仅 clean 且 through>=5 才提示；文案为诊断而非错误 |

---

## 15. Definition of Done

只有同时满足以下条件，才可宣布故事主线修复完成：

- [ ] 单章和批量 Prompt 显式包含目标、冲突解决和变更判定；
- [ ] 五项语义和引用规则有代码级校验；
- [ ] 摘要与结构化主线矛盾会触发 repair，而非静默成功；
- [ ] arc replace、objective clear、conflict resolve 生命周期可用；
- [ ] 旧 Patch/State 回放兼容；
- [ ] 页面提供有效内容和全空诊断；
- [ ] 新增专项测试全部通过；
- [ ] `npm run verify` 通过；
- [ ] `npm run test:coverage` 不降低现有门禁；
- [ ] Android 固定剧本真实模型验收通过；
- [ ] 既有长篇备份副本重建验收完成；
- [ ] CHANGELOG、README/进度文档与实际实现一致；
- [ ] 未修改数据库 Schema、人物/关系算法、检查点策略和流水线。

---

## 16. Agent 施工纪律

1. 开始前阅读本 SPEC、配套 PLAN、AGENTS.md、README、CHANGELOG 和前置 Story Memory 规格。
2. 先运行并记录基线测试，保留用户已有改动。
3. 每个阶段先写失败测试，再做最小实现。
4. 不在同一提交夹带格式化、重命名或无关重构。
5. 不手改 `src/constants/version.json`。
6. 本轮默认不构建 Release APK；若后续明确要求发版，必须先阅读 `docs/RELEASE_APK_BUILD.md`。
7. 任何新增主线字段必须同时覆盖单章、批量、repair、归一化、合并和回放路径。
8. 最终报告必须列出：修改文件、测试命令、测试结果、真实模型结果、已知限制和旧项目恢复步骤。
