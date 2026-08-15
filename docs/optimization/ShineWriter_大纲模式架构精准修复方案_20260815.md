# ShineWriter 大纲模式架构精准修复方案（PDCA）

- 日期：2026-08-15
- 范围：大纲创作模式（资料库 / 流水线 / 弹性系统）架构评审结论的精准修复
- 基线：code head `e78f1888` + 本轮工作区 7 处已修 bug（见批次 0）
- 依据：
  - 架构评审（2026-08-15，三子系统全量扫描，证据均核实到 file:line）
  - `ShineWriter_第三期_作家风格预设全链路重构_PDCA方案_20260814.md`（§26/§29-§33）
  - `ShineWriter_第二期_资料资产_写作流水线_弹性上下文接驳方案_20260813.md`（§8.5）
  - `tavo-mini-multi-chapter-batch-and-elastic-budget-pool-plan.md`（§3/§7.3/§11）
  - `docs/EMULATOR_QA_PLAYBOOK.md`（冒烟环境与绕行）

---

## 0. 问题索引（本方案针对的评审结论）

| 编号 | 问题 | 严重度 | 批次 |
|---|---|---|---|
| A1 | V5 快照写入/序列化/解析三方不一致，作家风格分阶段投影持久化后失效 | A | 批次 1（FIX-1） |
| A2 | 作家风格→preset 决议逻辑 5 处复制且已漂移 | A | 批次 1（FIX-2） |
| C6 | 遗留 `applyContextAutoAllocation` 内无 WHERE 的全表 UPDATE llm_config/presets | A（待引爆） | 批次 1（FIX-3） |
| B6 | 笔记模式"禁用"名不符实：none → 全量注入 | B（用户可感） | 批次 1（FIX-4） |
| A3 | token 估算器（1 token/汉字）无校准回路，输入侧硬门全部押注估算 | A | 批次 2（FIX-5 观测先行） |
| A4 | 三套安全边际公式，1M 窗口下差约 40 倍 | A | 批次 2（FIX-6，数据到位后统一） |
| C5 | 遗留任务（无冻结 stageBudgets）审计预留 1500 + thinking 可开 → 截断 | B | 批次 2（FIX-7） |
| B1 | 批次预算池按 128K 时代调参：window×4 输入上限 vs 弹性单次占窗 70-95% | B | 批次 2（FIX-8） |

明确**不在本方案内**（另立方案）：B2 双 God module 拆分、B3 错误分类器合一、B4 版本兼容表收敛、B5 资源三代栈下线、C1-C4/C7/C8。理由见 §5。

---

## 1. 修复纪律（硬性，先读后动）

### 1.1 冒烟先行协议 —— 任何修复动手之前必须完成并留档

> 原则：**没有绿色基线就没有修复**。基线不绿（环境问题/既有失败）时，先停下修环境或上报，
> 禁止在红色基线上叠加改动——那是边界扩大的头号来源。

每个 FIX 动手前，依次执行并归档到 `test-logs/precision-fix-<FIX-ID>/baseline/`：

1. **全局基线三件套**
   - `npm run typecheck`（0 错误）
   - `npx jest`（全量，记录通过总数；与上一次归档总数差异需可解释）
   - `npm run apk:debug` 构建成功 + 安装 `emulator-5554`（`adb install -r`）
2. **关键路径装机冒烟子集**（三系统各一条，与被修子系统对应者必跑，其余可按卡说明豁免）
   - 流水线：`02-writing-lifecycle`（或 MCP UI 等价路径）
   - 资料库：`03-resource-library`
   - 流水线取消/暂停：`06-pipeline-cancel`
   - 注意：Maestro 对中文匹配不稳，失败时按 `EMULATOR_QA_PLAYBOOK.md` 用
     `scripts/qa/ui-find.mjs` + 坐标点按复测，不得直接判失败。
3. **定向复现（缺陷证据）**：按每张修复卡的"修复前冒烟"步骤，捕获当前（缺陷）行为
   的可复核证据（单测输出 / DB 查询结果 / 截图）。**该证据就是修复后行为翻转的对照物。**

### 1.2 边界控制

- **单 FIX 单 commit**，commit message 以 `fix(<FIX-ID>):` 开头；禁止一个 commit 混多张卡。
- **diff 预算**：每张卡产品代码 ≤ 150 行（测试与文档不计）；超限必须拆卡或升级为独立方案。
- **禁区清单**（触碰即停，需先升级讨论）：
  - SQLite schema 迁移与 schemaVersion 变更；
  - 任何进入冻结上下文的提示词文本（改文本即改协议指纹，破坏"冻结请求复用"不变量 §3.7）；
  - `frozenRequestJson` / `input_fingerprint` / `pipeline_context_*` 的写入路径；
  - V4 及以下旧批次的兼容判定（只允许更严格，不允许放松）。

### 1.3 修复后验证与回滚

- 顺序：新回归单测（先红后绿）→ 重跑定向复现（行为按预期翻转）→ 全量 `npx jest` +
  `typecheck` → 按卡的"装机验证"复验 → §1.1 的装机冒烟子集重跑全绿。
- 任何一步不绿：**立即 revert 该 FIX 的 commit**，不带病叠加修补。回滚后基线三件套重跑留档。
- 真实 LLM 冒烟的费用控制：一律用小项目（如 P2_AWARENESS / E2E_CB1）、章节目标字数调小、
  验证到"阶段开始/首个成功检查点"即取消批次。

---

## 2. 批次 0：本轮已完成修复（工作区待提交，先行归组）

以下 7 处已实现并通过全量 3349 测试 + 装机验证，**提交前须完整跑一次 §1.1 基线**，按逻辑归组提交：

| 组 | 内容 | 文件 |
|---|---|---|
| b0-1 planner 解析 | 截断/损坏 JSON 失败闭合、悬空逗号兜底、wire max_tokens 尊重用户配置、修复请求携带原始输出、finishReason=length 透传 | `multiChapterBatch/planner.ts`、`continuationBatchPlanner.ts`、`index.ts` |
| b0-2 预览恢复 | 冷启动预览从 plannerOutputJson 重建 | `screens/MultiChapterBatchScreen.tsx` |
| b0-3 风格基线 | 基线 writer style 不再合成非法 preset（流水线 + 预览屏两处） | `pipeline/reconcile.ts`、`screens/ContextPreviewScreen.tsx` |
| b0-4 错误分类 | 新增 pause_task_failed，本地确定性失败展示真实原因 | `determineNextBatchAction.ts`、`reconcileMultiChapterBatch.ts` |

对应测试：`batchPlanner.test.ts`、`continuationBatchPlanner.test.ts`、
`multiChapterBatchScreen.test.tsx`、`multiChapterBatchStateMachine.test.ts`、`multiChapterBatchFaultMatrix.test.ts`。

---

## 3. 批次 1（P0：立即修，全部有界）

### FIX-1 V5 快照三方对齐（A1）

**证据（已核实）**
- 写入方：`src/services/draftPipelineCompiler.ts:262-269` —— 有 `writerStyleSnapshot` 时标
  `snapshotVersion: 5`（硬编码 5；`PIPELINE_CONTEXT_SNAPSHOT_VERSION_V5` 常量从未被引用）。
- 序列化方：`src/services/pipelineTaskContext.ts:1302-1307` —— `snapshotVersion = isV33||isV32 ? 4 : isV3 ? 3 : 1`，
  **把 5 强制改写为 4**（但 spread 保留了 `writerStyleSnapshot` 字段在 JSON blob 中）。
- 解析方：同文件 415-429 只认 {1,3,4}，字面 5 会抛 `OUTLINE_SNAPSHOT_INVALID`；解析输出为
  显式字段列表，`writerStyleSnapshot` 与 `execution.writerStyle` 全文 0 处读取——**解析即丢失**。
- 后果：首次持久化-解析循环后，`reconcile.ts:2082`、`stageResourceContextV4.ts` 的 V5 分支
  永远走 V4；resume 后 `runtime.writerStyle` 为 null，`assertProtectedWriterStyleFits` 空转；
  审校/事实核对/终审的风格投影静默降级。反向地雷：谁让序列化如实写 5，解析方立即把任务判死。

**修复前冒烟（定向复现）**
1. 单测复现（新增，预期先红后绿用）：构造含 `writerStyleSnapshot` 的 V5 draftContext →
   `serializePipelineTaskContext` → `parsePipelineContextSnapshotStrict` → 断言当前
   `snapshotVersion === 4 && writerStyleSnapshot === undefined`（把缺陷钉进测试日志）。
2. 装机复现：绑定真实作家风格的项目生成一章 → 任务落库后拉取
   `pipeline_tasks.pipeline_context_json`，确认 blob 内含 `writerStyleSnapshot` 但恢复运行时
   `runtime.writerStyle` 为 null（logcat 或调试断言取证）。

**修复内容（最小 diff）**
1. 序列化方：`writerStyleSnapshot` 存在时保留版本 5（`snapshotVersion` 计算加入该分支），
   并改用 `PIPELINE_CONTEXT_SNAPSHOT_VERSION_V5` 常量。
2. 解析方：版本门 {1,3,4} → {1,3,4,5}；按既有严格校验风格解析 `writerStyleSnapshot`
   （结构校验对齐 `FrozenWriterStyleV1`，非法即 `OUTLINE_SNAPSHOT_INVALID` fail-closed）。
3. `parsePipelineExecutionSnapshot` 输出字段列表补 `writerStyle`（缺省 null，旧 blob 兼容）。
4. 引用常量替换硬编码 5。

**边界**：不改 envelope 版本判定（isV3/isV32/isV33）；旧 blob（版本 4 + 残留
`writerStyleSnapshot` 字段）继续按 V4 解析、忽略多余字段，行为不变；不迁移历史数据
（§30：禁止重写旧 context）。

**修复后验证**：上述单测翻转为断言 V5 往返保持；补"旧 V4 blob 解析不变"回归用例；
装机：绑风格项目跑完一章 + 中途强杀 resume 一次，确认审校阶段消费风格投影
（ContextPreviewScreen 或 stage trace 中 `writer_style_projection` 出现）。
**回滚**：revert 单 commit，新旧 blob 均不受影响（版本 5 只在新任务产生）。

### FIX-2 作家风格决议收编为单一服务（A2）

**证据（已核实）**：5 处独立实现——
`pipeline/reconcile.ts:2032-2062`、`screens/ContextPreviewScreen.tsx:424-453`（近乎逐字重复）、
`data/repositories/pipelineTaskRepository.ts:89-100 与 154-166`（内联 SQL 校验）、
`data/repositories/presetRepository.ts:214-229`。错误文案已漂移（"不存在" vs "不存在或已失去项目归属"）。
本周 b0-3 两个 bug（流水线 + 预览屏各一处）即此病灶产物。

**修复前冒烟**：grep 清单归档（5 处实现逐字对比）；装机三态取证——空绑定（baseline 正常）、
悬空绑定（`ACTIVE_WRITER_STYLE_MISSING` 拦截）、正常绑定（风格生效），当前三处入口行为一致性的
文字记录。

**修复内容（最小 diff）**
1. 新建 `src/services/writerStyle/activeStyleResolver.ts`：唯一实现 §26.2/§26.3 契约——
   `resolveActiveWriterStyle(projectId)` 返回 `{ writerStyle, draftPreset | null, missing?: error }`：
   空绑定 → 默认基线 + `draftPreset = null`；悬空 → 抛 `ACTIVE_WRITER_STYLE_MISSING`；
   正常绑定 → 资产冻结 + `assetId > 0` 时合成 draft preset（与 b0-3 守卫同一规则）。
   错误文案收敛为单一常量。
2. 五处调用点改为消费该服务（`getPipelineConfig` 的内联 SQL 校验改为调用服务并保留其异常语义）。

**边界**：不改 DB 读写函数签名；`setProjectActiveWriterStyle` 的事务行为不动，仅校验内部收编；
不新增错误码（沿用 `ACTIVE_WRITER_STYLE_MISSING`）。

**修复后验证**：单测三态（空/悬空/正常）对服务直接断言；5 处调用点的既有测试全绿；
装机三态与冒烟记录逐条对照（文案统一为预期内差异）。
**回滚**：revert 后回到 5 处复制现状，无数据影响。

### FIX-3 删除无 WHERE 的 Context Auto 遗留写库（C6）

**证据（已核实）**：`src/services/contextAutoAllocator.ts:585-593` ——
`UPDATE llm_config SET context_window = ?, max_output_tokens = ?` 与 `UPDATE presets SET max_tokens = ?`
均无 WHERE；函数 `applyContextAutoAllocation` 当前零调用（仅 `contextAutoRepository.ts:155` 文档注释
引用）。距重演 V2.11.52"Context Auto 覆写 LLM 能力"事故只差一次误调用。

**修复前冒烟**：`grep -rn "applyContextAutoAllocation\b" src/` 归档零调用证据；基线三件套。

**修复内容（最小 diff）**：删除 `applyContextAutoAllocation` 整个函数及配套常量与文档引用；
补一个导出面回归测试（模块不再导出该符号），防复活。

**边界**：`applyContextAutoAllocationV3`（现行）与 `restoreContextAutoDefaults` 不动。

**修复后验证**：全量测试 + typecheck；导出面测试通过。
**回滚**：revert 即恢复死代码，无行为影响。

### FIX-4 笔记模式"禁用"语义修正（B6）

**证据（已核实）**：UI 标签 `{ value: 'none', label: '禁用' }`（`ResourceLibrary.tsx:1375`）+
提示"如需全部关闭，请将笔记模式切换为'禁用'"（692-698）；运行时 `none` 落入
`compileOriginalNotes`（`noteDetailCompiler.ts:303-315` dispatch 的 else 支），V7 与
legacy（`contextBuilder.ts:1957-1973`）两路均全量注入启用笔记——标签与行为相反，预算白烧+内容照漏。

**修复前冒烟（定向复现）**：小项目启用 2 条笔记 → 模式切"禁用" → 上下文预览
（`ContextPreviewScreen`）确认当前笔记内容**仍在** prompt 中（截图归档）。

**修复内容（最小 diff）**：两处分发将 `mode === 'none'` 改为返回空候选（V7：
`noteDetailCompiler` dispatch 前置短路；legacy：`contextBuilder` note 分发前置短路）；
`compileOriginalNotes` 保留给显式需要原文的模式值（若有历史项目依赖 none=全量，见下方边界）。

**边界**：`style`/`retrieval` 模式行为零变化；不改 `project_note_config` 存储结构；
**用户可见行为变更**（none 从"全量注入"变"真禁用"），需在 CHANGELOG 记录。

**修复后验证**：单测（none → 空候选；style/retrieval 回归不变）；装机重跑冒烟步骤，
确认预览中笔记内容消失、另两模式不受影响；03-resource-library 冒烟流绿。
**回滚**：revert 恢复旧行为（回到"标签误导"现状），无数据影响。

---

## 4. 批次 2（P1：观测先行 / 数据到位后动手）

### FIX-5 估算漂移观测脚本（A3 第一阶段，零产品代码）

**证据**：`estimateTokens` 为 1 token/汉字启发式（`tokenEstimator.ts:20-44`）；输入侧硬门
（`CONTEXT_WINDOW_EXCEEDED` / `OUTLINE_OVER_BUDGET`）全部依赖它；真实 `usage.prompt_tokens`
已在 attempt 行入库（`reconcile.ts:498-505`）但从不与 `estimatedInputTokens` 回比。

**修复前冒烟**：无产品行为变更，仅需基线三件套。

**修复内容（最小 diff）**：新增 `scripts/qa/measure-estimator-drift.js`——从设备拉 DB，
对每条 attempt 求真实 input_tokens 与冻结请求中估算值的比值，输出分布（P50/P95/最大）。
产出漂移报告归档，作为 FIX-6/FIX-8 的参数依据。

**边界**：不改任何产品代码、不改 schema。

**修复后验证**：脚本在真机 DB 上产出报告；报告进入本方案附录。
**回滚**：删脚本即可。

### FIX-6 安全边际统一（A4，以 FIX-5 数据为前置）

**证据**：`deriveDefaultSafetyMargin = min(1024, max(256, 2%窗口))`（`budgetAllocator.ts:52-55`）
vs `max(512, 4%)`（`outlineContextBuilder.ts:210-213`）vs `policy.safetyMarginRatio`
（`contextAutoAllocator.ts:871-874`）。1M 窗口下 1024 vs 40000。

**修复内容（最小 diff，两步）**
1. 抽公共 `deriveSafetyMargin(window, tier)`，三处消费点改为传 tier 调用（**数值先不变**，
   仅消除公式复制）；
2. 依据 FIX-5 漂移报告的 P95 决定弹性审计档的下限修正（预期：把 `min(1024,…)` 的 1024 上限
   改为 `clamp(2%窗口, 256, 漂移P95×2)` 量级），**只在数据证明当前余量不足时才改数值**。

**边界**：分配器结构与水位逻辑不动；改数值前必须附漂移数据引用；冻结任务不受影响
（边际在编译期计算，不进指纹）。

**修复后验证**：三处消费点单测（各 tier 数值断言）；装机：大窗口模型跑一次弹性审计阶段
编译预览不越窗。
**回滚**：revert 单 commit。

### FIX-7 遗留任务审计输出预留下限（C5）

**证据**：无冻结 `stageBudgets` 的任务（cbv 1-4 或缺省）走 1500 配置兜底
（`pipelineTaskRepository.ts:136-139` 经 `stageMaxTokens` 回退 `reconcile.ts:2724-2735`），
而 `stageReasoning`（2737-2755）可能开启 thinking——推理计入 completion，1500 共享即截断
（与已修的 planner 截断同族）；`bumpRetryBudget`（1103-1108）只在事后补救。

**修复内容（最小 diff）**：仅 legacy 兜底路径——当该阶段 thinking 开启时，wire 上限取
`max(配置值, resolvePlannerWireMaxTokens 同款规则)`（复用 b0-1 抽出的
`resolvePlannerWireMaxTokens`，参数：预留=配置值、configuredMax=模型 `max_output_tokens`、
窗口减输入减边际为顶）。冻结 stageBudgets 的任务路径零变化。

**修复前冒烟**：构造 cbv 遗留任务（或单测桩）+ thinking 开启，记录当前 wire=1500；
**修复后验证**：同场景 wire 提升且受窗口约束；现行任务（cbv 6/7）wire 不变的回归用例。
**回滚**：revert 单 commit。

### FIX-8 批次预算池参数重标定（B1）

**证据**：`multiChapterBatchStore.ts:380-391`——输入上限 `window×4`（与章数无关）、调用上限
`章数×12`；弹性阶段单次合法占窗 70-95%（`reconcile.ts:1453-1467` 按"已用真实值+本次估算"计费）。
1M 模型 6-10 次近满窗调用即触 `paused_batch_budget`，20 章批次中途停机。

**修复内容（最小 diff，以 FIX-5 数据校核后定值）**：
`maxInputTokens = window × chapterCount × k`（k 起始建议 2，即"平均每章两次近满窗输入"的
失控保护）、`maxOutputTokens = chapterCount × 五阶段预留之和`（按 20% 包络记账口径对齐）、
`maxLlmCalls = chapterCount × 12` 维持。只改 `updateBatchBudget` 入参公式，不改闸门语义。

**边界**：闸门判断逻辑（`assertBatchBudgetAvailable`）与 `BatchBudgetExceededError` 分类不动；
仅对新批次生效（批次上限在 planner 期冻结，旧批次保持自身冻结值——符合 §4.4 冻结原则）。

**修复前冒烟**：小目标字数 3 章批次在 1M 窗口模型上完整跑通（记录各阶段 input_tokens，
验证当前公式确实会在中途触顶的场景用数据推演即可，不必真触顶）；
**修复后验证**：同批次完整跑通不误触顶；人为调小上限仍能正确 `paused_batch_budget`（分类回归）。
**回滚**：revert 单 commit，旧批次不受影响。

---

## 5. 明确不做（防边界扩大）

1. **B2 拆 God module**（reconcile.ts 6321 行 / contextBuilder.ts 2766 行）：纯重构无行为收益
   配高风险，需独立重构方案与专属回归矩阵，不混入精准修复。
2. **B3 错误分类器三合一**：涉及单章/批次两套 UI 语义，先在本方案各卡内保持"三处同步修改"
   纪律，合并另立方案。
3. **B4 版本兼容表收敛、B5 资源三代栈下线**：均需迁移与兼容设计，另立 PDCA。
4. **C1（捕获期 LLM/写库）、C4（崩溃窗口候选恢复）、C7（O(attempts²) 聚合）、C8（开关扇入）**：
   中期优化项，非阻滞。
5. **任何 schema / 协议指纹 / 提示词文本变更**：见 §1.2 禁区。

## 6. 冒烟用例矩阵（FIX × 冒烟方式）

| FIX | 全局基线三件套 | 装机冒烟子集 | 定向复现（修复前捕获 / 修复后翻转） |
|---|---|---|---|
| FIX-1 | 必跑 | 02 + 06（强杀 resume） | 单测往返丢失 / V5 保持 + blob 对照 |
| FIX-2 | 必跑 | 02 + 03 | 三态（空/悬空/正常）行为与文案对照 |
| FIX-3 | 必跑 | 豁免（零调用死代码） | grep 零调用归档 / 导出面测试 |
| FIX-4 | 必跑 | 03 | 预览含笔记 → 不含；另两模式不变 |
| FIX-5 | 必跑 | 豁免（纯脚本） | 漂移报告产出 |
| FIX-6 | 必跑 | 02 | 三 tier 数值断言 + 大窗口编译不越窗 |
| FIX-7 | 必跑 | 06 | legacy+thinking wire=1500 → 受窗口约束提升；现行任务不变 |
| FIX-8 | 必跑 | 02 | 3 章批次全程不误触顶 + 人为触顶分类正确 |

## 7. 验收标准总表

1. 每张卡：基线留档 → 单 FIX 单 commit → 新回归测试先红后绿 → 定向复现翻转 →
   全量 jest + typecheck 绿 → 装机验证 → 冒烟子集绿。
2. 批次 1 完成后：`冻结作家风格缺少有效 id` 类缺陷在本仓库不可再现（决议单一来源）；
   V5 风格投影在持久化往返后保持；笔记"禁用"不再注入；无 WHERE UPDATE 不可达。
3. 批次 2 完成后：漂移报告归档；安全边际单一函数；遗留任务无 1500 截断路径；
   1M 窗口 3 章批次全程无误触 `paused_batch_budget`。
4. 全程不触碰 §1.2 禁区；任何一步不绿即 revert 并留档原因。
