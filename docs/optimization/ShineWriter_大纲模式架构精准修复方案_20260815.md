# ShineWriter 大纲模式架构精准修复方案（实证版 PDCA）

- 日期：2026-08-15
- 范围：大纲创作模式的快照、作家风格决议、上下文自动化遗留写库、笔记模式和多章批次预算
- 审查对象：当前 `main` 的 `9687b0ea`，而不是原方案记录的旧工作区状态
- 工作原则：**实践是检验真理的唯一标准**。静态扫描只产生假设；只有可重复的测试、数据库观察、装机冒烟和回归结果才能把假设升级为结论。

## 0. 基线与审查结论

### 0.1 已完成的冒烟基线

基线在任何产品代码修改前完成，证据目录为
`test-logs/precision-fix-plan-review-20260815/baseline/`：

| 项目 | 实际结果 |
|---|---|
| Git | `main` 与 `origin/main` 一致，工作区干净；HEAD=`9687b0ea` |
| `npm run typecheck` | exit 0 |
| `npx jest --runInBand --ci` | 421 个套件中 421 个通过；3350 passed、8 skipped、无 failed（总计 3358 tests） |
| `npm run apk:debug` | exit 0，生成 `dist/apk/debug/ShineWriter-V2.11.52-debug.apk` |
| Android | `emulator-5554`，API 37，`adb install -r` 成功，`com.shinewriter/.MainActivity` 冷启动成功 |
| 启动日志 | 未见 FATAL/崩溃；首屏显示的是设备原有“流水线完成”历史状态，不能把它误判为本轮功能通过或失败 |
| 设备数据库 | 只读拉取成功；`pipeline_stage_attempts` 的历史样本中，Brief/弹性 trace 有 `finalEstimatedInputTokens`，draft/review/factCheck/proof 多数没有可回比估算值 |

原方案中“`e78f1888` + 工作区 7 处未提交修复”“3349 tests”均与当前仓库事实不符，已删除，不再作为验收依据。基线日志和设备快照均不进入 Git 提交。

### 0.2 问题索引（按实测后的处理结论）

| 编号 | 原评审假设 | 当前结论 | 本轮动作 |
|---|---|---|---|
| FIX-1 / A1 | V5 快照写入、序列化、解析不一致，作家风格投影会在恢复时丢失 | 已由代码路径和回归用例证明 | 修复 |
| FIX-2 / A2 | 作家风格决议在 5 处复制并漂移 | 已由调用点、错误文案和 b0-3 两处重复修复证明 | 修复 |
| FIX-3 / C6 | 遗留函数可对 `llm_config`/`presets` 全表 UPDATE | 函数仍存在且无生产调用，风险真实 | 删除遗留入口，V3 不动 |
| FIX-4 / B6 | `none/禁用` 实际仍全量注入笔记 | 单测当前明确证明该行为 | 修复为零候选 |
| FIX-5 / A3 | 估算器缺少漂移观测 | 估算值没有覆盖所有 attempt，不能直接算全量漂移 | 增加只读观测脚本，报告覆盖率；不改估算公式 |
| FIX-6 / A4 | 三套安全余量必须统一 | 三者分别属于默认弹性、最终请求检查、V3 策略层；没有行为失败证据 | 本轮不改，列为待证项 |
| FIX-7 / C5 | legacy thinking 必然沿用 1500 并截断 | 当前冻结流程会在首次冻结时保存 V2 预算；尚无可复现旧任务证据 | 本轮不改，列为待证项 |
| FIX-8 / B1 | 批次 `window×4` 输入上限与章数无关 | 代码和设备批次记录均证明上限固定，而调用上限按章数增长 | 修复为按章数扩展的自动上限 |

明确不在本轮：God module 拆分、错误分类器合并、版本兼容表重构、资源三代栈下线、schema/migration、提示词文本和冻结指纹协议变更。

## 1. 执行纪律

1. 先基线、再定向复现、再写回归测试；测试必须先红后绿，不能把原有错误期望当成“绿基线”。
2. 本轮不在中途提交。所有修复、测试、APK 和装机验证完成后，才形成一个闭环 commit 并 push 到 `main`；commit body 列出 FIX-1/2/3/4/5/8。
3. 不执行 `adb uninstall`、`pm clear`、删除或替换用户数据库；只用 `adb install -r`。真实 LLM 不可用时，不伪造生成结果，以纯函数/SQLite 只读证据替代，并在 PDCA 中标明边界。
4. 不触碰 SQLite schema、冻结 prompt 文本、`frozenRequestJson`、`input_fingerprint` 和旧 V4 及以下兼容判定。
5. 每个修复保持最小 diff；任何失败先定位并回退工作区改动，不在红色结果上继续叠加。

## 2. 修复卡

### FIX-1：V5 快照三方对齐（A1）

**已证缺陷**：`draftPipelineCompiler.ts` 写死 `snapshotVersion: 5`；`pipelineTaskContext.ts` 序列化时只产生 1/3/4，解析门只接受 1/3/4，且解析结果没有 `writerStyleSnapshot` 和 `execution.writerStyle`。因此 V5 内容在持久化往返后要么被改成 V4，要么 fail-closed，恢复运行时作家风格为空。

**修复**：

- 使用 `PIPELINE_CONTEXT_SNAPSHOT_VERSION_V5`，序列化保留 V5；envelope 版本判定不改。
- V5 解析严格校验 `FrozenWriterStyleV1` 的版本、资产身份、采样字段和五个阶段投影；V5 缺字段或结构非法时抛 `OUTLINE_SNAPSHOT_INVALID`。
- 解析执行快照时保留可选 `writerStyle`；V4 及更早 blob 没有该字段时保持旧行为。
- V4 blob 即使残留 `writerStyleSnapshot` 也继续忽略，不放松旧版本兼容判定。

**红绿证据**：新增 V5 往返、非法 V5 fail-closed、旧 V4 忽略残留字段三组回归；检查序列化 JSON 的 `snapshotVersion` 和解析后的投影文本/`execution.writerStyle`。

### FIX-2：作家风格活动决议收编（A2）

**已证缺陷**：流水线、预览屏、pipeline repository 和 preset repository 各自查询、冻结和合成 preset，且错误文案不同。

**修复**：新增 `activeStyleResolver.ts`，集中定义三态：空绑定返回默认基线且无 draft preset；悬空/未启用绑定抛统一 `ACTIVE_WRITER_STYLE_MISSING`；正常绑定只冻结一次并按 `assetId > 0` 合成 draft preset。五个入口消费同一决议服务；DB 签名和事务边界不变。

**红绿证据**：对纯决议核心做空绑定、悬空绑定、正常绑定三态测试；`rg` 确认入口不再各自复制冻结/错误决策；现有 pipeline/preset 测试全绿。设备侧只做保留数据的启动和资源页冒烟，不伪造未配置的真实三态。

### FIX-3：删除无 WHERE 的 Context Auto 遗留写库（C6）

**已证缺陷**：`applyContextAutoAllocation` 仍包含无 WHERE 的 `UPDATE llm_config ...` 和 `UPDATE presets ...`，虽当前无生产调用，但一旦误接会覆盖全库。

**修复**：删除该遗留导出及其专属测试；保留 `applyContextAutoAllocationV3`、V3 策略和只读/项目级计数逻辑不变。增加导出面测试，防止旧入口复活。

### FIX-4：笔记模式“禁用”语义修正（B6）

**已证缺陷**：V7 `compileNoteDetailCandidatesFromSnapshot` 和 legacy `buildNoteContext` 都把 `mode=none` 落到原文全量注入；UI 却把 none 标为“禁用”。

**修复**：两条运行路径的 `none` 均返回空候选/空文本；style/retrieval 不改；存储结构不改；`CHANGELOG.md` 记录这是用户可见的语义修正。旧的原文编译函数不再由合法模式调用，保留与删除均以测试结果为准，不新增隐藏模式。

**红绿证据**：V7 快照 none 由“有候选”翻转为“零候选”；legacy `buildContext` 在 none 下不读取笔记正文；style/retrieval 回归；资源库 UI 冒烟仍能切换三种标签。

### FIX-5：估算漂移只读观测（A3 第一阶段）

设备证据表明不能从现有 attempt 行推导所有阶段的冻结估算：只有部分 `allocation_trace_json` 或 `frozen_request_json.elasticBudgetTrace` 含 `finalEstimatedInputTokens`。因此不新增虚假的全量比值，也不在本轮改变 token 估算算法。

**修复**：新增 `scripts/qa/measure-estimator-drift.mjs`，只读 SQLite，报告：可比较行数/覆盖率、按 stage 的 P50/P95/最大 `actual input_tokens / estimated input_tokens`、未覆盖行数；不输出 prompt、API key 或正文。

**判定**：脚本能对基线设备快照产出“部分覆盖”报告即通过；覆盖率不足时 FIX-6 不得据此改数。若以后需要全阶段校准，另立方案增加非敏感观测字段并重新评审协议边界。

### FIX-8：批次预算池按章数扩展（B1）

**已证缺陷**：`multiChapterBatchStore.ts` 当前 `maxInputTokens = contextWindow × 4`、`maxOutputTokens = contextWindow × 2`，与章数无关，而 `maxLlmCalls = chapterCount × 12` 随章数增长。设备中多个 3 章批次也固定为 4,000,000/2,000,000，证实不是文档误读。

**修复**：抽出纯函数 `deriveAutomaticBatchBudget`。保留 1–2 章批次的原有最低 envelope；从 3 章起按章数扩展：输入上限为 `window × max(4, chapterCount × 2)`，输出上限为 `window × max(2, chapterCount)`，调用上限仍为 `chapterCount × 12`。只改新规划阶段写入的自动上限，旧批次的冻结值不变，闸门和暂停分类不变。

**红绿证据**：纯函数覆盖 1/2/3/20 章和非法章数；现有批次闸门测试证明手工小上限仍会 `paused_batch_budget`；设备历史批次只读检查证明旧值未被迁移。

## 3. 本轮不实施但保留为待证项

### FIX-6：安全余量

`deriveDefaultSafetyMargin`、`deriveContextSafetyMargin`、V3 `safetyMarginRatio` 是三个拥有不同职责和边界的策略。当前只有静态数值差，没有因余量不足导致的真实失败样本；统一公式会改变冻结外编译边界，故本轮不改。待 FIX-5 未来达到足够覆盖率并出现明确越窗/截断证据后另立卡。

### FIX-7：legacy thinking 输出上限

当前 V2 首次冻结会先执行 `applyPipelineReasoningBudget`，并把 stage max tokens 写进 execution；恢复则从 execution 读取，而不是重新回到 1500 默认值。当前没有一个可复核的“无 stageBudgets + thinking enabled + wire=1500 + 实际截断”样本，故不把假设写成修复。后续若拿到旧数据库样本，再按旧任务兼容边界单独设计。

## 4. PDCA 验收门

### Plan

完成本文件修订、记录实测基线、锁定 FIX-1/2/3/4/5/8 的最小范围，并将 FIX-6/7 标记为待证。

### Do

按卡先添加回归断言并记录红色结果，再实施最小代码改动；运行观测脚本；构建 Debug APK 并用 `adb install -r` 覆盖安装。

### Check

必须同时满足：

- 定向红绿测试、全量 Jest、typecheck 全部通过；
- APK 构建、保留数据安装、冷启动通过；logcat 无新增 FATAL/未捕获异常；
- FIX-1/2/3/4/8 的行为证据完成翻转；FIX-5 报告诚实标注覆盖率；
- 资源库/流水线最小 UI 冒烟通过，旧设备数据库仍可读；
- `git diff --check` 通过，改动未触碰 schema、冻结 prompt 和旧兼容判定。

### Act

把实际测试计数、APK 路径、设备结果、观测报告覆盖率和剩余 FIX-6/7 的理由回写本节；确认没有未完成的必需动作后，才 commit 并 push `main`。若任何硬门失败，停止提交并记录阻断原因。

## 5. 最终实测回写（PDCA Check / Act）

- 定向红绿：先红后绿已完成。首轮红测记录于
  `test-logs/precision-fix-plan-review-20260815/red-targeted.log` 和
  `red-fix3.log`；实现后最终 6 个定向套件 39/39 通过，5 个原回归套件
  75/75 通过，证据分别为 `pre-final-targeted.log`、
  `regression-targeted-1.log`。
- 全量 Jest / typecheck：`npx jest --runInBand --ci` exit 0，424 个套件通过、3
  个跳过；3344 项测试通过、8 项跳过（总计 3352 项），证据为
  `final-jest-3.log`。`npm run typecheck` exit 0，证据为
  `final-typecheck-2.log`。
- APK / `adb install -r` / 冷启动：`npm run apk:debug` exit 0，生成
  `dist/apk/debug/ShineWriter-V2.11.52-debug.apk`；在 `emulator-5554` 上保留
  用户数据执行 `adb install -r` 成功，启动到
  `com.shinewriter/.MainActivity`，证据目录为
  `test-logs/precision-fix-plan-review-20260815/post-fix-final/emulator/`，最终
  构建日志为 `final-apk-debug.log`。
- FIX-5 观测报告：基线设备快照共 269 次 attempt，91 次可比较，覆盖率
  `33.83%`；总体比值 P50=`0.7224`、P95=`3.6126`、最大=`3.6126`。draft/proof
  没有可比较估算值，报告没有补造数据，因此未修改估算公式；报告为
  `baseline/emulator/estimator-drift-report.json`。
- UI 与 logcat：作品库和当前“大纲创作”写作页冒烟通过，UI 树可见
  “章节 · 大纲 · 摘要 · 上下文”、章节内容和底部导航；应用过滤日志未见
  `FATAL EXCEPTION`、`Process: com.shinewriter` 崩溃或 ReactNativeJS 未捕获异常。
- 静态安全门：旧的无范围 Context Auto 入口在 `src` 中不再存在；未触碰
  schema、冻结 prompt、`frozenRequestJson`、`input_fingerprint` 或旧版本兼容判定；
  `git diff --check` exit 0。
- Act：FIX-1/2/3/4/5/8 已完成并有证据闭环；FIX-6/7 仍因覆盖率和可复核失败样本不足
  保持待证，不把假设扩展为行为改动。提交与 push 在最终工作区审查通过后执行。
