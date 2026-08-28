# Phase III-C 施工进度

> 唯一施工基线：`E:\AiWorkSpace\tavo-mini`
>
> 开工时间：2026-08-28（Asia/Shanghai）

## 基线

- `main` 与 `origin/main` Exact HEAD：`c9bd25a6`（`fix(phase3-b): seal B10 final acceptance gates`）。
- 开工前已执行：`git status --short --branch`、`git fetch origin`、`git branch -vv`、`git log --oneline -20`。
- 开工时工作区已有未跟踪文件：C 轮方案文档、B 轮方案文档、`scripts/qa/__pycache__/`；本轮保留，不把它们当作施工改动。
- 已确认模拟器：`emulator-5554`，包名 `com.shinewriter`，旧版本 `V2.21.1` / `versionCode=2210100`，`firstInstallTime=2026-08-10 09:49:20`。未执行卸载、`pm clear` 或重置应用数据。
- 真实 LLM / 项目 / Writer Style / Canon / Story Memory 的安全元数据只在设备 DB 证据中核验，API key 不读取、不记录、不输出。

## 固定证据规则

- 每个阶段必须按 `Plan → Red Test → 最小实现 → targeted verify → APK → adb install -r → 模拟器已有真实 LLM → DB/Receipt/UI/Final Artifact → Act → 独立 commit` 闭环。
- Mock/fake provider 仅用于单元测试、Red Test、故障注入；不作为任何阶段 GO 证据。
- 任一真实 Android/LLM Check 为 NO-GO，停止进入下一阶段。

## 阶段记录

### C0-A — Model Capability Single Source of Truth

状态：C0-A 能力门禁 GO；独立提交 `6a1c4d69`。完整 1M 真实写作请求另有超时观察，未计入成功证据。

Plan：让 `llm_config.context_window` / `llm_config.max_output_tokens` 成为唯一模型能力真相；自动上下文入口与当前模型双向同步；`max_output_tokens=0` 保持 AUTO；新 Freeze 读取最新已保存能力，旧 Frozen 任务不漂移。

Red Test：

- `npx jest __tests__/llmContextAutoCapabilityIsolation.test.ts __tests__/llmContextWindowSync.test.ts __tests__/contextAutoAllocatorV3.test.ts --runInBand` 首次运行 2 suites failed、9 tests failed、7 passed，失败点覆盖 Auto→LLM、mirror、AUTO=0、旧 Freeze 保护和 draft fail-closed。

最小实现：

- `src/services/contextAutoAllocator.ts`：Auto Context 只更新选定/active 已保存模型的 `llm_config.context_window`，Receipt 与设置写入同一 SQLite transaction；`max_output_tokens` 原值复制，0 保持 AUTO；未保存/未知 id fail-closed。
- `src/data/repositories/llmConfigRepository.ts`：LLM 保存与 active 切换将 `context_auto_input` 维护为 active 模型的显示 mirror，运行真相仍为 `llm_config`。
- `src/screens/ContextAutoConfigScreen.tsx` / `src/screens/LLMSettingsScreen.tsx`：普通用户只看到上下文长度、当前模型能力和 AUTO 说明，不暴露 V3 工程术语。
- `__tests__/llmContextAutoCapabilityIsolation.test.ts`、`__tests__/llmContextWindowSync.test.ts`、`__tests__/contextAutoAllocatorV3.test.ts`：新增 C0-A contracts，覆盖 saved model、active model、max output 0、Freeze 不漂移和 transaction receipt。

Targeted verify：

- 5 个相关 suites：50/50 PASS；`npm run typecheck` PASS；`npm run lint` PASS；`npm run verify:elastic` PASS。
- `npm run verify`：504 suites passed（4 skipped），3,636 tests passed（9 skipped）。

APK / install-r：

- `npm run apk:debug` PASS；产物 `dist/apk/debug/ShineWriter-V2.21.1-debug.apk`，SHA-256 `79E525DC9C01D4A371CED3C01C49FFDDDEE5699DC10655BC9A48C775D27E0A82`。
- `adb -s emulator-5554 install -r` PASS；未卸载、未 `pm clear`、未重置数据；`firstInstallTime` 保持 `2026-08-10 09:49:20`。

真实 Android / DB / Receipt / UI：

- 旧 DB 快照：`test-logs/phase3-c-c0-a-preflight/old.sqlite`；`integrity_check=ok`，原有 `llm_config` 为 GLM-5.3-Flash、1,000,000、AUTO=0；API key 未读取或记录。
- 真实 UI 先保存 `65,536`，再从“上下文自动化配置”保存 `1,000,000`：`test-logs/phase3-c-c0-a-android/ui-c0a-65k-after-edit.xml`、`ui-c0a-after-65k-save-retry.xml`、`ui-c0a-after-1m-from-65k.xml`。
- 1M 后 App 重启再进入两页：`ui-after-1m-relaunch-llm.xml` 显示 `1000000`，`ui-after-1m-relaunch-context.xml` 显示 `1,000,000 / AUTO`。
- DB `test-logs/phase3-c-c0-a-android/after-1m-from-65k.sqlite`：`integrity_check=ok`；`llm_config.context_window=1000000`、`max_output_tokens=0`、`is_active=1`；`settings.context_auto_input=1000000`；Receipt `schemaVersion=3`、`syncedContextWindow={configId:1,contextWindow:1000000,maxOutputTokens:0}`、`affectedCounts.llmConfigs=1,presets=0`。
- 已保存新任务的冻结上下文快照：`contextWindow=1000000`、`modelName=GLM-5.3-Flash`、运行时 AUTO 派生 `maxOutputTokens=200000`，Freeze fingerprint 已落库；后续模型能力更新不会改写该快照。
- 真实 `保存并测试` 使用已配置 GLM-5.3-Flash 返回“测试通过 / 回复：连接成功”：`ui-real-llm-test-result.xml`。
- 另创建了仅用于真实链路验证的 `Phase3C_C0A_QA` 项目与空章节，不改动旧项目；在 1M/AUTO 下发起的完整写作请求最终以 `total_timeout` fail-closed，未产生正文/Final Artifact，证据保存在 `after-real-writing-175s.sqlite`。此观察不作为 C0-A 能力门禁的 PASS 证据，也不被隐瞒。

当前已知限制：模拟器只有 1 个已保存的真实 LLM 配置，model-switch 的多配置行为由 targeted/unit contract 覆盖；未复制或输出 API key 来制造第二配置。

Act：已完成独立 commit `6a1c4d69`，允许进入 C0-B；若后续阶段真实 LLM Check=NO-GO，立即停止，不以“基本完成”替代门禁。

### C0-B — 项目卡片统计与批量项目管理

状态：C0-B 真实 Check GO；独立 commit `86084517`。提交前已完成一次真实 UI 回归修复并重新走完 APK/install-r/全量门禁。C0-C 尚未开始。

Plan：项目卡片只显示轻量投影的章节数与统一口径正文字数；正文统计不在列表页扫描；在同一作品库页提供批量导出与批量删除，不新增一级导航或工程术语。统计口径为所有已保存可编辑章节正文的非空白 Unicode code point；大纲、Canon、原著来源、人物、世界书、笔记、Story Memory、prompt、revision、context 和 metadata 均排除。

Red Test：

- 初始 C0-B 新增测试在实现前按预期失败：3 个新 suite 因模块不存在失败（2 suites failed、9 tests failed、7 passed）。
- 真实 UI Check 进一步发现列表回退后仍显示 `0 字`，而 DB 已为正文 20 字；新增 `__tests__/projectListStatsRefresh.test.ts` 固化“列表重新获得焦点必须 reload 共享统计”的 Red Test。

最小实现：

- `src/services/projectWritingStats.ts`：唯一统计与显示格式服务；Unicode code point 计数、章节/正文 delta SQL builder。
- `src/data/schema/createCurrentSchema.ts`、`src/services/migrations/v58-to-v59.ts`、`src/services/migrations/index.ts`、`src/services/database/schemaManifest.ts`：Schema 59 新增 `project_writing_stats`，迁移按 64 章窄投影批量、确定性清空重建，并兼容最小历史迁移夹具。
- `src/data/repositories/projectRepository.ts`、`src/data/repositories/multiChapterBatchRepository.ts`、`src/services/multiChapterBatch/batchAdoption.ts`、`src/services/writing/persist/continuationAdoption.ts`：创建、保存、定稿、删除、批量写章等边界与正文写入同事务维护统计；列表只读取 `p.* + project_writing_stats`，导出采用 position/id keyset 窄投影。
- `src/services/projectBatchService.ts`、`src/services/exportService.ts`：生成 UTF-8 store ZIP，批量导出任一项目失败则不保存半包；现有完整 ShineWriter JSON 包作为每个 entry，导入仍走既有恢复流程，不写入密钥。
- `src/screens/ProjectListScreen.tsx`、`src/store/projectStore.ts`：同页批量模式、全选/选择、导出/确认删除；焦点恢复时 reload 项目投影。`__tests__/projectListStatsRefresh.test.ts` 发现的回归由 `useFocusEffect + loadProjects` 最小修复。

Targeted verify：

- C0-B targeted：6 suites / 21 tests PASS（统计服务、真实 sql.js 仓储、迁移、ZIP、既有 story-memory statement 回归、焦点刷新 contract）。
- `npm run typecheck` PASS；`npm run verify:elastic` PASS。
- 修复后的 `npm run verify` 明确 PASS：509 suites passed（4 skipped），3,644 tests passed（9 skipped），总计 513 suites / 3,653 tests；lint 0 errors（保留仓库既有 warnings）。

APK / install-r：

- 修复后 `npm run apk:debug` PASS；`dist/apk/debug/ShineWriter-V2.21.1-debug.apk`，SHA-256 `5E0FDD7079A3CFA4E8519AFD3C47D314083DFCBC89793BBAC953C93145B0D73B`。
- `adb -s emulator-5554 install -r` PASS；`versionName=V2.21.1`、`versionCode=2210100`；`firstInstallTime=2026-08-10 09:49:20` 保持不变。无卸载、`pm clear` 或应用数据重置。

真实 Android / DB / Receipt / UI / Final Artifact：

- 模拟器现有真实 `GLM-5.3-Flash` 配置通过“保存并测试”，UI 显示“测试通过 / 模型已连通 / 回复：连接成功”：`test-logs/phase3-c-c0-b-android/ui-real-llm-test-result.xml` 与 `screen-real-llm-test-result.png`。未使用 mock/fake provider；过滤应用错误日志为空：`logcat-fixed-app-errors.txt`。
- 通过真实 UI 创建 3 个临时项目，批量模式明确显示“已选择 3 个”，原有 `Phase3C_C0A_QA` 未选中。系统保存界面实际生成 `ShineWriter-Projects-20260828.zip`，应用 UI 显示“批量导出成功”；设备实际文件已拉取到 `test-logs/phase3-c-c0-b-android/ShineWriter-Projects-20260828.zip`，3 个 entry 均为合法 JSON、项目名匹配、无 API key/Authorization/Bearer 字段。导出截图/XML 与 ZIP 解包结果均保留在同一目录。
- 通过应用“恢复项目”真实流程导入其中一个 entry，UI 显示“项目「Phase3C_C0B_1」已恢复”；随后批量确认删除 3 个原选项目，最后单独删除导入副本。`after-import-copy-delete.sqlite`：`integrity_check=ok`、仅保留原有 `Phase3C_C0A_QA`，`orphanStats=0`、`orphanChapters=0`。
- 修复复测：真实编辑器保存 `Phase3C_C0B_body_123` 后，重建 APK、install-r、重启并回到项目列表，UI 从 `0 字` 正确显示 `1 章 · 20 字`：`ui-project-list-after-fixed-install.xml`、`screen-fixed-install-card-20-chars.png`；`after-fixed-install-card-refresh.sqlite` 中 `content_length=20`、`body_char_count=20`，1M/AUTO 仍为 `context_window=1000000` / `max_output_tokens=0`，Story Memory 与 pipeline task 保留。

Act：C0-B 的实现、真实 Android Check 与全量门禁均 PASS，已由独立 commit `86084517` 封存；现在允许进入 C0-C。C0-C 及后续阶段仍未开始，未宣布任何 Phase III/C 最终 GO。

### C0-C — UI Complexity Gate

状态：C0-C 真实 Check GO；独立 commit `279e1257`。C1 尚未开始。

Plan：专门审核 C0-A/C0-B 是否把后台能力转嫁成新的一级导航、核心写作步骤、默认技术信息或用户必须维护的开关；允许的变化只有上下文长度、项目卡统计、同页批量管理和必要的普通语言确认。

Red Test：

- `__tests__/phase3CUiComplexityGate.test.ts` 首次运行时因缺少持久审核记录失败（1 failed / 2 passed），随后补齐审核记录并保留三项 contract check。

最小实现：

- 新增 `docs/optimization/phase3-c-ui-complexity-audit.md`，记录四项 0 增量门禁、禁止项、主流程与真实 Android 证据；不新增任何产品页面、一级导航或后台设置。
- 新增 `__tests__/phase3CUiComplexityGate.test.ts`：固定五个既有 Tab、普通用户屏幕不出现 C 轮后台术语、项目卡和同页批量入口仍存在。

Targeted verify：

- `npx jest __tests__/phase3CUiComplexityGate.test.ts --runInBand`：3/3 PASS。
- `npm run typecheck` PASS；`npm run verify:elastic` PASS；该 contract test 专项 lint PASS。

APK / install-r：

- `npm run apk:debug` PASS；产物 `dist/apk/debug/ShineWriter-V2.21.1-debug.apk`，SHA-256 `5E0FDD7079A3CFA4E8519AFD3C47D314083DFCBC89793BBAC953C93145B0D73B`。
- `adb -s emulator-5554 install -r` PASS；版本与 `firstInstallTime=2026-08-10 09:49:20` 保持；未卸载、未清数据。

真实 Android / DB / Receipt / UI：

- `test-logs/phase3-c-c0-c-android/ui-primary-tabs.xml`：仍为 `1 项目 / 2 资料 / 3 写作 / 构建 / 设置` 五个既有一级入口；无 C 轮新增一级导航。
- `ui-core-writing-flow.xml` → `ui-core-chapter-editor.xml` 与 `screen-core-chapter-editor.png`：项目列表进入写作后直接到章节编辑，正文显示 `20 字`，核心路径没有新增点击步骤。
- `ui-settings-home.xml`、`ui-llm-settings.xml`：上下文长度与 LLM 配置仍在既有设置页；没有新增后台模块开关或工程控制台。
- `ui-real-llm-test-result.xml`、`screen-real-llm-test-result.png`：使用模拟器已保存的真实 `GLM-5.3-Flash` 返回“测试通过 / 模型已连通 / 回复：连接成功”；未使用 mock/fake provider。
- `after-real-llm.sqlite`：`integrity_check=ok`、Schema 59、项目 `1 章 / 20 字`、`context_window=1000000`、`max_output_tokens=0`、`context_auto_input=1000000`，Story Memory/pipeline task 保留；`logcat-app-errors.txt` 应用错误模式 0 行。

Act：四项 UI Complexity Gate 均 PASS，已由独立 commit `279e1257` 封存；现在允许进入 C1。尚未建立任何长程基线，未宣布 Phase III-C/Phase III 最终 GO。

### C1 — Long-Horizon baseline（真实长程证据 NO-GO；补充回归进行中）

Plan：C1 基线起始 Exact HEAD 为 `e10d16aa`。严格先采集当前实现的真实基线，目标矩阵为 5/20/50/100 章；在 C1 基线完成前不实现 Memory Delta、Memoization 或 Prefetch。采集范围限定为本次新增项目/批次，不读取旧项目的 mock/fake provider 行作为证据。

Red Test：

- 新增 `__tests__/phase3CLongHorizonBaseline.test.ts`，先运行 `npx jest __tests__/phase3CLongHorizonBaseline.test.ts --runInBand`；采集器文件尚不存在时 2/2 tests 按预期失败，锁定 5/20/50/100 矩阵、逐章字段和缺失证据不得转成 0 的 fail-closed 契约。
- 真实复测暴露 `pipeline_qa` 落入 60 秒普通 watchdog；新增 `__tests__/llmRequestPolicy.test.ts` Red Test，先验证期望的长请求策略为 570,000ms，旧实现按预期失败。

最小实现：

- 新增 `scripts/qa/collect-phase3-c-baseline.js`，使用 `DatabaseSync(..., { readOnly: true })` 对指定项目/批次做窄投影采集；读取章节、Pipeline task/checkpoint/attempt、Writing Observability/Request Receipt、usage、batch ledger、Story Memory、Canon boundary、state proposal 和 Final Artifact 指纹，不读取或输出 API key/完整 prompt/正文。
- 采集器按章节全局 position 生成 `chapterIndex`，planner 调用在每批首项做确定性归属；Writer Physical Calls、Total Paid LLM Calls、planner/observer/Story Memory 调用、阶段 tokens、重试/fallback、上下文输入、Final char/fingerprint、Story Memory/DB payload 等分别记录。缺失证据保留 `null` 或 `not_applicable` 并进入 `evidence.missing`，矩阵自动 NO-GO。
- 连续性检查字段仅记录证据可见性和 `manual_review_required`，不把没有自动判定的 Canon、边界、future leakage、人物状态、世界规则、Timeline 或 seam 宣称为 PASS。
- `src/services/llm/requestPolicy.ts` 将 `pipeline_qa` 纳入长请求策略，并将章节/管线长请求最后 watchdog 从 300,000ms 调整为 570,000ms；没有改变请求重试或结果未知的 fail-closed 语义。

Targeted verify：

- `npx jest __tests__/phase3CLongHorizonBaseline.test.ts --runInBand`：2/2 PASS。
- `npm run typecheck`：PASS；`npm run verify:elastic`：PASS；`npm run lint`：PASS（仓库既有 warnings，无 errors；新增采集器无 errors）。
- watchdog 修复 targeted：`npx jest __tests__/llmRequestPolicy.test.ts __tests__/phase3CLongHorizonBaseline.test.ts --runInBand` 4/4 PASS；`npm run typecheck`、`npm run verify:elastic`、`npm run lint -- --quiet` 均 PASS。
- 对现有 C0-C 快照执行采集器得到 5/20/50/100 全部 `NO-GO`，因为该快照没有 C1 批次；该负向结果仅验证 fail-closed，不计入真实基线。

APK / install-r：

- watchdog 修复后 `npm run apk:debug` PASS；产物 `dist/apk/debug/ShineWriter-V2.21.1-debug.apk`，SHA-256 `70B995625B86155B522BA39C9AB8F28B742ABF4863BDB75FEE99E07A5C93426F`。
- `adb -s emulator-5554 install -r` PASS；`versionCode=2210100`、`versionName=V2.21.1`、`firstInstallTime=2026-08-10 09:49:20` 保持；没有卸载、`pm clear` 或重置数据。

实际执行与 Check：

- `npm run apk:debug` PASS；产物仍为 `dist/apk/debug/ShineWriter-V2.21.1-debug.apk`，SHA-256 `5E0FDD7079A3CFA4E8519AFD3C47D314083DFCBC89793BBAC953C93145B0D73B`。`adb -s emulator-5554 install -r` PASS；`versionCode=2210100`、`versionName=V2.21.1`、`firstInstallTime=2026-08-10 09:49:20` 保持不变；没有卸载、`pm clear` 或重置数据。
- 通过现有 App UI 新建隔离基线项目 `phase3c-c1-baseline`（project id 57），使用已保存的真实 `GLM-5.3-Flash`、5 章、每章 3000 字，planner 真实请求成功并将 5 章计划冻结；UI 证据为 `test-logs/phase3-c-c1-android/ui-planning-preview-after-save.xml`、`ui-planning-preview-bottom-3.xml`，DB 中 `batch_planner=success` 1 次。
- 通过 UI 点击“开始批量写作”后真实第 1 章进入 `running_pipeline → draft → qa`。Draft 真实成功：`input=2274`、`output=6871`、`total=9145`、`finish_reason=stop`；随后 QA 真实请求以 `total_timeout` 结束，`failure_class=outcome_unknown`、`error_code=total_timeout`。UI 落入“批次已暂停 / 结果未知”：`test-logs/phase3-c-c1-android/ui-batch-paused-result-unknown.xml`、`screen-batch-paused-result-unknown.png`。
- 一致性 DB 快照 `test-logs/phase3-c-c1-android/batch-paused-clean.sqlite`：`integrity_check=ok`；批次 `paused_timeout_unknown` / `BATCH_LLM_OUTCOME_UNKNOWN`，第 1 项 `outcome_unknown`，Pipeline task `failed`；QA attempt `outcome_unknown`，无 Final Body/Final Artifact，章节正文长度为 0。真实 usage ledger 同时记录 `pipeline_planner=success`、`pipeline_draft=success`、`pipeline_qa=error`，未隐藏失败请求或辅助付费请求。
- 只读基线采集器报告 `test-logs/phase3-c-c1-android/c1-baseline-real-no-go.json` 明确为 `decision=NO-GO`：5 章完成数 `0/5`，20/50/100 目标均未完成；第 1 章缺 `finalCharCount`/`finalFingerprint`，其余章节保持 pending 和 null，不把缺失证据转换为 0 或 PASS。真实证明模式为 `android-existing-config` / `GLM-5.3-Flash`。

- 第二次真实复测：修复 `pipeline_qa` 后，新项目 `phase3c-c1-timeout-fix`（project id 58）批次 `batch_mtco7ach_3zzkcd` 的 Draft 在 300,000ms 处 `total_timeout / outcome_unknown`；`retry4-paused-clean.sqlite` 显示正文长度 0、usage 记录了该失败请求，UI 为“结果未知”。该轮证明原 Draft watchdog 仍过短，未重试未知请求。
- 中途无效轮：项目 `phase3c-c1-smoke3` 的 Planner 正在真实运行时，误用默认 `pull-db-evidence.js`，其默认行为会先 `am force-stop`；该轮仅保留为采证流程教训，不计入任何真实 PASS。后续运行只用 UI/进程存活轮询，阶段结束后才 clean pull。
- 第四次真实复测：新项目 `phase3c-c1-smoke4`（project id 60），批次 `batch_mtcp3rpv_rqcv59`，使用现有真实 `GLM-5.3-Flash`、5 章、每章 3000 字。第 1 章真实完成并通过 Draft/QA/Revision，UI 进度 `1/5`；第 2 章 Draft 在新的 570,000ms watchdog 处 `total_timeout / outcome_unknown`，未产生第 2 章正文，未重试未知请求。证据：`test-logs/phase3-c-c1-android/ui-c1-fourth-paused-result-unknown.png`、`ui-c1-fourth-current-24m.xml`、`c1-fourth-paused-clean.sqlite`、`logcat-c1-fourth-filtered.txt`。clean DB `integrity_check=ok`；第 1 章正文长度 3,205，但批次未完成，C1 真实矩阵仍 NO-GO。
- 用户随后要求长测超过 3 章改用虚拟 LLM。执行边界：虚拟 LLM 只作为补充的配置切换/冻结隔离/流程回归，不作为任何 C1 真实 GO 证据；若未完成真实 5/20/50/100，最终报告必须保持 NO-GO。
- 补充多 LLM 配置回归（非 GO 证据）：通过已安装 App 的既有“LLM 设置”页新建并保存 `Phase3C-Virtual-LLM`，端点为 `https://virtual.invalid/v1`、模型名为 `virtual-test-model`、上下文 `128000`、`max_output_tokens=0`（AUTO）。API key 仅使用设备端临时占位值，未读取、输出或提交；未点击“保存并测试”，未发起虚拟写作请求，也未将其伪装成真实 provider 成功。
- 配置应用与切换 UI：虚拟配置保存成功并通过“设为当前”切换成功，证据为 `test-logs/phase3-c-c1-android/screen-c1-virtual-config-saved.png`、`screen-c1-virtual-config-active.png`；随后通过独立的“选中配置”与“设为当前”动作恢复真实 `默认配置`，证据为 `screen-c1-real-config-restored2.png`。在不清理数据的 App 重启后，LLM 页面仍显示 `OpenAI 兼容 API · 当前：默认配置`，同时保留两个配置卡片；证据为 `screen-c1-multi-llm-reload.png`、`phase3c-llm-reload.xml`。
- 配置 DB Check：`test-logs/phase3-c-c1-android/c1-multi-llm-switch-final.sqlite` 的窄投影显示 `默认配置`（`is_active=1`、真实模型、`context_window=1000000`、`max_output_tokens=0`）与 `Phase3C-Virtual-LLM`（`is_active=0`、`context_window=128000`、`max_output_tokens=0`）共存，`settings.context_auto_input=1000000`；没有读取或输出密钥。该快照只证明配置保存、切换、恢复和重启持久化，不证明虚拟 provider 或长篇正文链路。
- 因第四次真实轮次在第 2 章 Draft 已进入结果未知，尚未达到“真实完成 3 章后”的切换点；本轮没有用虚拟配置替代真实 5/20/50/100，也没有生成虚拟长测 Final Artifact。虚拟配置回归仅作为用户要求的耗时控制补充，C1 真实长程门禁仍为 NO-GO。

- 用户要求“长测超过 3 章后改用虚拟 LLM”后，先按低成本真实路径复测：在现有 App 中新建隔离项目 `phase3c-c1-fast-real`（project id `61`），确认当前真实配置仍为默认 `GLM-5.3-Flash`，流水线档位切换为极速并冻结为 `one_shot`、`reasoning_effort=low`，通过真实 UI 创建 `5` 章 × `500` 字批次。虚拟 LLM 没有参与该真实批次，也没有把虚拟结果计入 C1 GO。
- 该批次由真实 GLM Planner 成功生成并冻结 5 章计划：`batch_planner success`，输入 `372`、输出 `1,834`、总计 `2,206` tokens；批次 ID 为 `batch_mtcqz9br_v6m7qj`。规划预览显示“批次已冻结：极速”，真实 Android 起始截图为 `test-logs/phase3-c-c1-android/screen-c1-fast-real-planning-start2.png`，低成本批次表单为 `screen-c1-fast-real-batch-form-5x500-with-prompt.png`。
- 真实写作 Check：第 1 章 Draft 成功，`input=2,278`、`output=8,820`、`total=11,098`、`finish_reason=stop`，随后真实第 2 章 Draft 在 `570,000ms` watchdog 触发 `total_timeout`，被 fail-closed 为 `outcome_unknown`；没有自动重试、没有点击“确认后继续”，没有重复付费请求。批次最终为 `paused_timeout_unknown` / `BATCH_LLM_OUTCOME_UNKNOWN`，`completed_count=1/5`、`used_llm_calls=1`。
- DB Check（无 force-stop 的 live 窄投影快照）：`test-logs/phase3-c-c1-android/c1-fast-real-current-live.sqlite`，`PRAGMA integrity_check=ok`；项目 61 的批次为 `execution_profile=one_shot`、`reasoning_effort=low`、`1/5`；第 1 项 `succeeded`、第 2 项 `outcome_unknown`、第 3–5 项 `pending`。第 1 章正文长度 `2,429`，第 2 章正文长度 `0`，没有可将未知结果当作 Final Artifact 的证据。
- Receipt/usage Check：同一快照的真实 `llm_usage_logs` 记录 `batch_planner success`（`2,206` total）、`pipeline_draft success`（`11,098` total）和 `pipeline_draft error / total_timeout`（输入 `7,602`，输出 `0`）；辅助 Planner 与失败请求均可见，没有隐藏为 0。批次条目、Pipeline attempt 和 usage ledger 的状态一致。
- 当前 UI 在最后一次 ADB 只读核验中明确显示“批次已暂停 / 结果未知 / 请求可能已在服务端执行，重新执行可能产生重复费用”；随后模拟器从 ADB 断开，尝试再次拉取截图/XML 得到 `device 'emulator-5554' not found`，因此没有生成或宣称不存在的最终 UI 文件。已保存的 live DB 是本轮可靠的 DB/Receipt 证据。
- 本轮没有达到“真实完成 3 章后”的虚拟切换点，未点击结果未知批次的继续按钮；虚拟配置仍只用于前述配置保存、切换、恢复真实配置和重启持久化回归。虚拟 endpoint/model 没有 `保存并测试`、没有写作请求、没有 Final Artifact，不能替代真实 5/20/50/100 矩阵。

Act：当前真实长程基线仍未满足“真实 5/20/50/100 基线完成”门禁，且本轮再次在第 2 章 Draft 进入 `outcome_unknown`，因此 C1 继续 NO-GO；C2 继续阻断，不进入下一阶段。新增 watchdog 修复由独立 commit `aa7acc6c` 封存，本轮仅新增测试记录，未修改源码。后续接手 agent 必须先恢复并确认 `emulator-5554`，不得对未知请求盲重试；只能继续 C1 的真实证据采集，虚拟 LLM 只能作为非 GO 的多配置切换/应用补充，不以虚拟结果、Known Issue、后续优化或基本完成替代门禁。

交接检查点（2026-08-28）：

- 当前分支为 `main`，源码工作树除既有未跟踪方案文件与 `scripts/qa/__pycache__/` 外无未提交源码改动；本次待提交仅为本进度文档。
- 最新已验证源码 HEAD 为 `a25985aa`；本地 `main` 比 `origin/main` 超前 9 个 commit。下一位 agent 接手后应先按原用户要求重新执行 `git status`、`git fetch`、`git branch -vv`、`git log --oneline -20`，再确认远端状态。
- C0-A/C0-B/C0-C 已有独立 commit 并记录真实 Android Check；C1 只有 fail-closed 采集器/timeout 修复和 NO-GO 真实尝试，C2–C10 尚未施工。禁止生成 requirement closure/final report 或宣布任何 Phase III-C/III GO。
- 本次 push 前的最后门禁：确认 progress 文档只包含本轮事实；`git diff --check`；仅提交该文档；推送完成后将 push commit 作为下一位 agent 的起点。

### C2 → C10

尚未开始；因 C1 NO-GO 按顺序门禁阻断。
