# ShineWriter 默认能力启用、旧任务自动兼容与 V2 验收问题改造方案

> 文档状态：已实施（2026-08-08，提交见 CHANGELOG 2.11.39 条目；模拟器覆盖升级与真实 LLM 验收见 Phase 4 记录）  
> 编制依据：本地仓库 `F:\ClaudeWorkSpace\projects\TAVO-MINI` 现状  
> 基线版本：V2.11.38  
> 基线 Schema：43  
> 基线提交：`d22850119c0b5ff36581f51a501c9f5dd357f960`  
> 适用平台：Android-only React Native  
> 编制日期：2026-08-08

---

## 1. 结论与产品决策

以下三项能力不再作为用户可开关的实验功能，而是正式产品能力：

1. 大纲创作中的“一键写 N 章 / 批量写章”默认可用；
2. 普通大纲写作 Pipeline 默认使用弹性上下文预算 V2；
3. 普通大纲真实章节的新任务默认使用 Outline Workflow V2，即稳定锚点、结构化审核、修订合同、Final Reviser 和本地终稿校验。

设置页删除这三项实验开关。生产运行时不再读取：

```text
multi_chapter_batch_enabled
elastic_budget_v2_enabled
outline_workflow_v2_enabled
```

旧设置行可以保留为无效历史数据，避免为清理三个字符串而额外修改用户数据库；但业务代码、页面和测试不得再依赖它们。

`startup_note_repair_enabled` 属于具有数据改写行为的维护开关，不在本次默认启用范围内，仍应保留在明确的数据维护流程中。

本次采用的兼容原则是：

> 新任务默认新版，旧任务后台自动识别并继续旧版；版本一旦冻结，运行中和恢复时绝不切换。

这里的“自动降级”只表示对历史任务和历史批次使用其兼容协议，不表示 V2 请求失败后临时改用 V1 再发一轮请求。

---

## 2. 当前本地实现现状

### 2.1 当前三个实验门控

`src/services/featureFlags.ts` 当前定义：

```text
elastic_budget_v2_enabled
multi_chapter_batch_enabled
outline_workflow_v2_enabled
```

三个读取函数都只有在设置值严格等于字符串 `true` 时返回启用，因此新安装和未手工开启的升级用户默认关闭。

### 2.2 一键写 N 章当前入口

当前链路为：

```text
OutlineEditor
  → isMultiChapterBatchEnabled()
  → 显示“批量写章”入口
  → MultiChapterBatchScreen
  → 再次读取 isMultiChapterBatchEnabled()
  → 关闭时显示“该功能暂未开放”
```

也就是说，功能实现已经存在，但入口和页面仍被两层实验门控拦截。

### 2.3 弹性预算当前路由

`src/services/pipeline/reconcile.ts` 在每次 reconcile 开始时读取实时设置，并把结果写入模块级变量 `elasticBudgetEnabled`。Draft、Review、FactCheck 和 Legacy Proof 编译时都使用这个实时值。

该实现不能直接改为“读取不到就返回 true”，原因是旧任务 Resume 会读取当前新默认值，从而用不同预算算法重建请求，破坏冻结上下文、请求指纹和恢复确定性。

### 2.4 Outline Workflow V2 当前路由

当前已具备 `PipelineExecutionSnapshot.outlineWorkflowVersion?: 1 | 2`：

- `2`：稳定锚点审核、修订合同、Final Reviser、本地终稿校验；
- `1` 或缺失：Legacy Review / FactCheck / Proof；
- 已冻结任务 Resume 时继续使用冻结值。

现有实现的主要问题不是 Resume，而是新任务只有在实验设置开启后才会冻结为 V2。

### 2.5 当前数据版本

本地实际为 Schema 43，而不是早期文档中的 Schema 40。`pipeline_tasks` 当前已有：

```text
pipeline_context_json
pipeline_context_version
pipeline_context_hash
```

但尚无独立的工作流版本和预算策略版本列。批次表也没有冻结其子任务应使用的 Pipeline 版本。

---

## 3. 目标行为

### 3.1 用户可见行为

大纲创作项目进入大纲编辑页后，始终显示“一键写 N 章”入口，不再读取设置、不闪烁、不先隐藏再出现。

设置页不再出现：

- AI 写 N 章开关；
- 弹性上下文预算开关；
- 定向修订流水线开关；
- “实验功能”“重启后生效”“暂未开放”等相关文案。

若功能前置条件不满足，例如没有有效 LLM 配置、大纲为空、预算不足，应显示具体业务错误，不得伪装为“功能未开放”。

### 3.2 新任务行为

升级版本创建的普通大纲真实章节任务默认冻结：

```ts
outlineWorkflowVersion = 2;
contextBudgetVersion = 2;
```

适用条件：

- `projects.mode === 'outline'`；
- `target_type === 'chapter'`；
- `chapter.id > 0`；
- 任务由新版本创建。

不适用条件：

- 原著续写独立 generation runner；
- 历史 `freeform` 兼容记录；
- `chapter.id === 0` 的历史伪章节；
- 已冻结或由旧版本创建的任务。

### 3.3 老作品行为

项目创建时间不决定新旧工作流。

- 老大纲项目已有章节正文：升级不修改；
- 老大纲项目已有任务：按任务冻结版本恢复；
- 老大纲项目升级后新发起的章节任务：默认 V2；
- 老大纲项目升级后新建的一键写 N 章批次：默认 V2；
- 原著续写项目：继续使用续写独立 Pipeline，不进入普通大纲 V2。

因此，“老作品不受升级影响”准确含义是已有正文、已有冻结任务和已有批次不被重写；不是让老项目永久停留在旧写作能力。

---

## 4. 版本冻结与后台自动兼容

### 4.1 为什么不能只删除开关

如果只把三个 `is...Enabled()` 改成恒定 `true`，会产生以下问题：

1. 旧任务 Resume 可能改用弹性预算 V2；
2. 旧任务的请求内容和 request fingerprint 可能变化；
3. 旧批次的已完成章节走 V1，升级后尚未创建的子任务走 V2；
4. 同一批次内部出现两套协议和两套预算算法；
5. 故障恢复可能重复计费或无法复用成功 checkpoint。

因此必须把“默认启用”和“历史兼容”分开实现。

### 4.2 建议 Schema 43 → 44

在 `pipeline_tasks` 新增：

```sql
outline_workflow_version INTEGER NOT NULL DEFAULT 1,
context_budget_version INTEGER NOT NULL DEFAULT 1
```

在 `multi_chapter_batches` 新增：

```sql
outline_workflow_version INTEGER NOT NULL DEFAULT 1,
context_budget_version INTEGER NOT NULL DEFAULT 1
```

迁移默认值必须是 `1`，这样所有升级前已经存在的任务和批次自然成为 Legacy，不需要扫描项目创建时间，也不需要猜测任务是否开始执行。

新版本创建任务或批次时必须显式写入 `2`。不能依赖数据库列默认值，因为列默认值是为旧数据兼容准备的。

迁移还必须同步：

- `createCurrentSchema.ts`；
- Schema manifest / validator；
- 迁移 fixture；
- 备份 manifest 与恢复列投影；
- `PipelineTask`、批次 Row/Input 类型；
- repository insert / mapRow / update 逻辑；
- Schema 43→44 真实 SQLite 迁移测试。

### 4.3 运行时权威顺序

单任务的版本来源按以下顺序确定：

1. 已有有效 `PipelineExecutionSnapshot`：Snapshot 是唯一权威；
2. 尚未冻结 Snapshot：读取 `pipeline_tasks` 的两个版本列；
3. 版本列非法、缺失或无法解析：Fail-closed 为 V1，并记录兼容原因；
4. 绝不根据当前设置页、当前默认常量或项目创建时间改变既有任务版本。

执行快照冻结时，应把任务行版本复制进 Snapshot：

```ts
interface PipelineExecutionSnapshot {
  outlineWorkflowVersion: 1 | 2;
  contextBudgetVersion: 1 | 2;
  // existing fields...
}
```

新快照不再允许省略这两个字段；解析历史 Snapshot 时缺失才解释为 V1。

### 4.4 批次版本冻结

批次创建时一次性冻结两个版本。批次后续创建每个章节任务时，必须复制批次版本，不得重新读取应用默认值。

这样可以保证：

- 升级前创建的未完成批次继续 V1；
- 升级后创建的新批次全部使用 V2；
- 暂停、杀进程、冷启动、恢复、safe retry 后版本不变；
- 同一批次所有子任务使用同一工作流和预算策略。

### 4.5 自动兼容决策表

| 场景 | Workflow | Budget | 行为 |
|---|---:|---:|---|
| 旧冻结任务，Snapshot 缺版本 | V1 | V1 | 仅恢复 Legacy Stage |
| 旧任务，无 Snapshot，迁移后版本列为 1 | V1 | V1 | 首次运行即冻结 V1 |
| 旧未完成批次，迁移后批次版本为 1 | V1 | V1 | 后续子任务继续 V1 |
| 老项目升级后新建单章任务 | V2 | V2 | 使用新版工作流 |
| 老项目升级后新建批次 | V2 | V2 | 全批次使用新版工作流 |
| 新项目单章或新批次 | V2 | V2 | 使用新版工作流 |
| 历史 freeform / chapter.id=0 | V1 | V1 | 兼容读取，不扩展产品模式 |
| continuation 项目 | 独立版本 | 独立预算 | 不进入普通 Pipeline |

### 4.6 禁止中途降级

以下行为禁止：

- V2 Review 已发出后切换到 V1 Review；
- V2 FactCheck 成功后调用 Legacy Proof；
- V2 Final Reviser 失败后再发一次 Legacy Proof；
- Resume 时因为新版本默认值变化而重编译另一协议；
- 同一批次按当前应用默认值为不同章节选择不同版本。

新 V2 任务发生问题时，应使用现有安全语义：成功 Stage 不重发、失败 Stage 按同协议 Resume、终稿技术校验失败时回退 Draft。不能用协议降级制造额外模型调用。

---

## 5. 去除实验开关的代码改造

### 5.1 `src/services/featureFlags.ts`

移除以下业务导出及对应键：

```ts
isElasticBudgetV2Enabled
setElasticBudgetV2Enabled
isMultiChapterBatchEnabled
setMultiChapterBatchEnabled
isOutlineWorkflowV2Enabled
setOutlineWorkflowV2Enabled
```

不得把它们改成恒定返回 `true` 后继续保留，因为这会掩盖仍依赖实时开关的错误调用。

`startupNoteRepair` 相关能力保持不变。

### 5.2 `src/screens/SettingsScreen.tsx`

删除三个开关对应的：

- import；
- React state；
- 初始化读取；
- toggle handler；
- Switch 与实验文案；
- “重启应用后生效”Toast。

如果“实验功能”区没有其他非维护功能，应整个删除；破坏性数据维护入口应归入“数据维护”，不能和默认写作能力混放。

### 5.3 `src/screens/OutlineEditor.tsx`

删除 `batchEntryEnabled` 和 `useFocusEffect` 中的异步 Flag 读取，直接渲染“一键写 N 章”入口。

建议将当前按钮文案“批量写章”统一为产品要求的“一键写 N 章”，页面标题和相关测试同步统一，避免同一功能两个名字。

### 5.4 `src/screens/MultiChapterBatchScreen.tsx`

删除 `useFlag()`、`enabled` 以及“该功能暂未开放”占位页。

页面只保留真实前置条件判断：

- 当前项目必须存在；
- 当前项目必须是 `outline`；
- 必须有可用 LLM 配置；
- 章节数、目标字数和预算必须合法；
- 同一项目已有活跃批次时恢复原批次，而不是再建一份。

### 5.5 `src/services/pipeline/reconcile.ts`

删除：

```text
elasticBudgetEnabled
outlineWorkflowV2Enabled
refreshPipelineFlags()
```

所有 Stage 编译改为使用冻结执行配置：

```ts
const useElasticBudget = execution.contextBudgetVersion === 2;
const useOutlineWorkflowV2 = execution.outlineWorkflowVersion === 2;
```

禁止模块级可变布尔值。并发任务必须各自读取自己的冻结版本，避免任务 A/B 在同一 JS 进程内相互覆盖运行策略。

### 5.6 默认版本常量

默认版本常量只允许在“新任务/新批次创建”时使用：

```ts
export const CURRENT_OUTLINE_WORKFLOW_VERSION = 2 as const;
export const CURRENT_CONTEXT_BUDGET_VERSION = 2 as const;
```

Resume、checkpoint reconcile、attempt retry 不得读取这些常量决定已有任务版本。

---

## 6. 本次验收发现的问题与修复要求

以下问题必须在默认启用前修复。不能因为当前开关默认关闭而降级处理。

### 6.1 P1：硬约束字符串被拆成单字

位置：

```text
src/services/pipeline/compileStageRequest.ts
compileFinalReviserStageRequest()
```

当前代码对两个 `string` 使用展开语法：

```ts
const hardConstraints = [
  ...params.constraints.relevantCharacterConstraints,
  ...params.constraints.relevantWorldRules,
];
```

结果会把中文文本拆成单字，再把每个字当成一条硬约束，造成：

- Token 明显膨胀；
- 约束语义损坏；
- 截断后的内容变成无意义字符列表；
- Final Reviser 可能被错误约束。

修复要求：

1. 以完整模块文本参与预算分配；
2. 需要列表时按明确段落/行规则切分，不按字符切分；
3. 去空、稳定去重，保持原顺序；
4. Contract 内已有的 `hardConstraints` 不得无意义重复注入；
5. 增加中文、多行、Emoji、超预算裁剪测试，断言不存在单字 bullet。

### 6.2 P1：待修订锚点被同时标记为保护锚点

位置：

```text
src/services/pipeline/revisionContract.ts
```

当前编译器把所有 workItem 定位锚点加入 `protectedAnchorIds`。Final Reviser 提示词又同时要求：

- 逐条执行 `workItems`；
- 必须保留 `protectedAnchorIds`；
- 合同未要求的位置不要修改。

这使同一段落同时成为“必须修改”和“必须保护”的对象。

修复要求：

1. `protectedAnchorIds` 只来自审核报告明确声明的保护项；
2. workItem 的 anchor/range/insertion/boundary 定位不得自动加入保护集合；
3. 同一审核报告中，保护锚点与 required/hard 修订定位重叠时，Validator 判为协议冲突并触发一次格式修复；
4. Review 保护锚点与 FactCheck 硬事实修订跨报告冲突时，Contract Compiler 按“事实修订优先”移出保护集合，并记录确定性 compiler warning；
5. 增加集合不相交测试和跨报告冲突测试。

### 6.3 P2：自然段切分实现与方案不一致

位置：

```text
src/services/pipeline/revisionAnchors.ts
```

方案和代码注释规定“一个或多个空行分隔自然段”，当前却使用 `text.split('\n')`，等价于每一行都是一个锚点。

修复要求：

1. 以一个或多个空白行作为自然段分隔；
2. 单个换行仍属于同一自然段；
3. 保留原始 UTF-16 start/end offset；
4. 超长自然段继续使用确定性子段切分；
5. tagged Draft 不得改变 canonical Draft 的正文字符；
6. 新增 `A\nB\n\nC` 用例，断言 `A\nB` 是同一自然段锚点。

### 6.4 P2：`finishReason=length` 被无条件判失败

位置：

```text
src/services/pipeline/finalArtifactValidator.ts
```

设计要求是 `finishReason === 'length'` 且输出明显未完成时 Hard Fail。当前实现只要 finishReason 为 length 就失败，可能把刚好触及输出上限但结构完整的终稿回退为 Draft。

修复要求：

1. `length` 只能作为组合信号，不能单独 Hard Fail；
2. 必须同时命中明确未完成证据，例如未闭合技术块、未闭合句尾、灾难性长度坍缩、明显省略/续写标记；
3. `length + 完整正文` 应通过或产生 warning；
4. `length + 明显截断` 才返回 `finish_length_incomplete`；
5. 保持短章和正常小说词语不误判。

### 6.5 P1：缺少 V2 生产状态机集成测试

当前新增的 5 组 V2 单元测试共 91 项均通过，但主要验证纯函数和版本解析，没有真正驱动 `reconcilePipelineTask` 执行 V2。

必须增加生产链路测试，至少证明：

- V2 noReview：只调用 Draft；
- V2 twoStage：Draft → Review → Final Reviser；
- V2 conditional：Draft → FactCheck → Final Reviser；
- V2 full：Draft → Review/FactCheck 并行 → Final Reviser；
- Full 单审核失败：另一份成功报告生成 Contract；
- Full 双审核失败：Draft fallback，不调用 Proof；
- V2 format repair 最多一次且 requestVersion=2；
- V2 Final Validator 在 checkpoint success 前运行；
- V2 Proof 失败 Resume 时只重发 V2 Proof；
- 冷启动和 stale-running 恢复不重复已成功 Stage；
- 新批次全部子任务固定 V2；
- 旧批次全部子任务固定 V1；
- 物理请求数、attempt 版本、费用统计与预期一致。

---

## 7. 实施阶段

### Phase 0：先修复验收阻断项

完成第 6 章的四项代码缺陷，并补对应单元测试。

退出条件：

- Final Reviser 不再收到单字硬约束；
- workItems 与 protectedAnchorIds 不再冲突；
- Anchor 满足空行自然段规则；
- `finishReason=length` 不再单独阻断完整正文。

### Phase 1：Schema 44 与版本冻结

新增任务级、批次级版本列，完成迁移、fresh schema、manifest、backup、repository 和类型同步。

退出条件：

- Schema 43 升级后所有旧任务/旧批次版本均为 1；
- 新任务/新批次显式写 2；
- 升级前后用户正文、项目、资料、任务和批次行数/内容指纹不变；
- 迁移可重跑且幂等。

### Phase 2：删除实验门控并接入冻结版本

删除设置页三个开关、入口门控、页面门控和 reconcile 实时 Flag 读取。

退出条件：

- 一键写 N 章对所有 outline 项目直接可见；
- 新任务默认 V2 + 弹性预算 V2；
- 旧任务自动 V1；
- 无模块级可变 Flag 控制任务协议。

### Phase 3：V2 状态机和 Batch 集成测试

按第 6.5 节补齐单章、Resume、故障注入和批次测试。

退出条件：

- 四种 Pipeline mode 调用顺序正确；
- Full 审核仍并行；
- 成功 Stage 不重复计费；
- 单批次不混用版本；
- Legacy 回归保持通过。

### Phase 4：Android 模拟器与真实 LLM 验收

使用 Debug APK 覆盖安装现有 V2.11.38 测试环境，保留用户数据，执行：

1. 旧冻结 V1 单章任务 Resume；
2. 老 outline 项目新建 V2 单章任务；
3. 新建一键写 N 章 V2 批次；
4. 批次暂停、杀进程、冷启动、恢复；
5. Final Reviser 终稿成功和安全回退各一例；
6. 检查 checkpoint、attempt.request_version、请求数、最终候选和 crash log。

退出条件：

- 无 FATAL / ANR / SQLite 错误；
- 旧任务没有被重发为 V2；
- 新任务不再进入 V1；
- 请求数与 mode 设计一致；
- 失败只走安全 Draft fallback，不额外调用 Legacy Proof。

### Phase 5：正式发版门禁

执行：

```powershell
npm run lint
npm run typecheck
npm run test:ci
npm run test:coverage
npm run verify
npm run apk:debug
```

正式 APK 另按 `docs/RELEASE_APK_BUILD.md` 和 `docs/RELEASE_CHECKLIST.md` 执行。

---

## 8. 必测矩阵

### 8.1 默认能力

| 场景 | 预期 |
|---|---|
| 全新安装 | 一键写 N 章可见，新任务 V2/Budget V2 |
| Schema 43 覆盖升级 | 三项能力无需用户操作即可用于新任务 |
| settings 中三个旧键为 false | 新任务仍使用正式默认能力 |
| settings 中三个旧键为 true | 行为相同，不再读取这些键 |
| Settings 页面 | 不显示三个实验开关和重启文案 |

### 8.2 旧数据兼容

| 场景 | 预期 |
|---|---|
| 旧任务有 Snapshot、无版本字段 | V1/Budget V1 |
| 旧任务无 Snapshot | 从迁移后的任务版本列冻结 V1 |
| 旧任务 Proof failed | 只恢复 Legacy Proof |
| 旧批次剩余多个章节 | 后续子任务均为 V1 |
| 老项目新单章 | V2/Budget V2 |
| 老项目新批次 | 批次及全部子任务为 V2/Budget V2 |
| 历史 freeform | V1，UI 不恢复自由写作模式 |
| continuation | 独立 runner，不受本改造影响 |

### 8.3 V2 审核与终稿

- Review / FactCheck 输出必须绑定 canonical draftHash；
- Anchor locator 必须存在且范围合法；
- workItems 与 protectedAnchorIds 不冲突；
- Final Reviser 输入只包含一次完整 canonical Draft；
- 硬约束按完整文本传递；
- 合同、锚点、Prompt、thinking、patch 不得泄漏；
- 完整的 `finishReason=length` 结果不被单信号拒绝；
- 明显截断、空正文、reasoning-only 必须拒绝；
- 本地校验失败后 Draft fallback，且不新增第五次请求。

### 8.4 批次

- draft_only / fast / full；
- 规划、确认、运行、暂停、恢复、取消、采纳；
- 冷启动 active batch 恢复；
- Lease 续约与双 owner 排斥；
- 预算上限和物理调用统计；
- 每个 item 的 task 版本等于 batch 冻结版本；
- completedCount、adoption、finalText 一致；
- 单章失败不会导致其他章节协议切换。

---

## 9. 建议新增或调整的测试文件

```text
__tests__/pipelineFinalReviserCompilerV2.test.ts
__tests__/pipelineRevisionContract.test.ts
__tests__/pipelineRevisionAnchors.test.ts
__tests__/pipelineFinalArtifactValidator.test.ts
__tests__/pipelineWorkflowV2Integration.test.ts
__tests__/pipelineWorkflowVersionPersistence.test.ts
__tests__/pipelineWorkflowV2Resume.test.ts
__tests__/multiChapterBatchWorkflowVersion.test.ts
__tests__/multiChapterBatchV2Integration.test.ts
__tests__/migrations-v43-v44.test.ts
__tests__/settingsDefaultCapabilities.test.ts
__tests__/outlineDefaultBatchEntry.test.tsx
```

原 `settingsExperimentalToggles.test.ts` 不应简单删除后失去约束，应改写为断言三个实验开关已经不存在、正式入口默认存在。

原 `multiChapterBatchScreen.test.tsx` 中 Flag OFF 占位页测试应删除，替换成 outline 项目直接渲染创建表单，以及 continuation/无项目的明确错误态测试。

---

## 10. 文件影响范围

### 10.1 必改

```text
src/services/featureFlags.ts
src/screens/SettingsScreen.tsx
src/screens/OutlineEditor.tsx
src/screens/MultiChapterBatchScreen.tsx
src/services/pipeline/reconcile.ts
src/services/pipeline/outlineWorkflowVersion.ts
src/services/pipeline/compileStageRequest.ts
src/services/pipeline/revisionContract.ts
src/services/pipeline/revisionAnchors.ts
src/services/pipeline/finalArtifactValidator.ts
src/types/pipelineExecution.ts
src/types/pipeline.ts
src/types/multiChapterBatch.ts
src/data/repositories/pipelineTaskRepository.ts
src/data/repositories/multiChapterBatchRepository.ts
src/data/schema/createCurrentSchema.ts
src/data/schema/schemaValidator.ts
src/services/migrations/index.ts
src/services/migrations/v43-to-v44.ts
```

### 10.2 按本地实现核对后同步

```text
src/data/schema/schemaManifest.ts 或等价 manifest
src/services/backupService.ts 及 backup manifest
src/services/pipelineTaskContext.ts
src/services/multiChapterBatch/**
src/store/multiChapterBatchStore.ts
README.md
CHANGELOG.md
docs/RELEASE_CHECKLIST.md
```

### 10.3 原则上不改

```text
src/services/continuation/**
src/services/llm/**
src/services/storyMemory/**
历史 freeform 表与兼容读取逻辑
```

---

## 11. 回滚与故障策略

生产版不保留用户可见实验开关，也不通过远程或本地设置动态改变任务协议。

若上线后必须紧急回滚，应发布修复版本并只改变“新任务创建时写入的当前版本”：

```ts
CURRENT_OUTLINE_WORKFLOW_VERSION = 1;
CURRENT_CONTEXT_BUDGET_VERSION = 1;
```

回滚版本仍必须遵守：

- 已冻结 V2 任务继续 V2 Resume；
- 已创建 V2 批次的剩余子任务继续 V2；
- 不删除 Schema 44 列；
- 不修改已有正文和成功 checkpoint；
- 不通过设置页让用户承担协议选择。

单任务运行时失败继续采用安全回退：

- Audit 单侧失败：使用另一侧有效合同；
- Audit 双侧失败：Draft fallback，不调用 Final Reviser；
- Final Reviser 技术校验失败：Draft fallback；
- outcome unknown：保持同版本并等待安全恢复；
- 不用 V1 重试 V2 已发出的请求。

---

## 12. 最终验收标准

同时满足以下条件才可认定本改造完成：

1. 三项能力不再出现在实验设置中；
2. 一键写 N 章在 outline 项目默认可见；
3. 新单章、新批次默认写入 Workflow V2 和 Budget V2；
4. 旧任务和旧批次缺版本时自动使用 V1；
5. 任务/批次运行中、Resume 和冷启动后版本不变；
6. 本次验收发现的四项代码问题全部修复并有回归测试；
7. V2 四种 mode、单/双审核失败、Resume、Batch 均有生产状态机测试；
8. 全量 lint、typecheck、Jest、coverage、version consistency 通过；
9. Schema 43→44 升级前后用户数据指纹一致；
10. Android 覆盖安装和真实 LLM 验收通过；
11. 原著续写、历史 freeform、Legacy Pipeline 和 Story Memory 无回归；
12. 不存在通过实时设置把已有任务从 V1 切到 V2 或从 V2 切回 V1 的路径。

---

## 13. 最终执行建议

本次不应采用“把三个默认值从 false 改成 true”的小修方式。正确建设路径是：

```text
先修复 V2 验收缺陷
  → 给任务和批次增加明确版本冻结
  → 旧记录迁移默认 V1
  → 新记录显式写 V2
  → 删除设置页和页面实验门控
  → 补齐生产状态机与 Batch 集成测试
  → Android 覆盖升级和真实 LLM 验收
```

这样既实现了“正式能力默认可用”，也保证旧作品正文不被修改、旧任务不改变协议、旧批次不混用版本，并且不再把复杂的兼容责任交给用户开关承担。
