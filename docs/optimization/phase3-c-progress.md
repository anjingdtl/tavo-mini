# Phase III-C 施工进度

> 唯一施工基线：`F:\ClaudeWorkSpace\projects\TAVO-MINI`
>
> 历史证据中的 `E:\AiWorkSpace\tavo-mini` 仅表示旧环境，不是当前施工路径。
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

## C-v2 重规划分界

- 原 C1 长程基线因 Runtime P0 暴露出 `total_timeout` / `outcome_unknown` 黑盒而中止；旧的 NO-GO 记录、timeout 生命周期和未知结果保护结论保留在上文，不删除、不粉饰。
- 新 C-v2 从 `C1 — Runtime Observability First` 重启，先照亮现有成熟 Writing Pipeline 的 Request Boundary；不引入 Governor、不改变 wire budget、不修改 timeout 常数、不关闭 Thinking、不新增 Writer/Reviewer/Agent/Context/Memory/Prompt Compiler。
- C0-A Model Capability Single Source、C0-B 项目统计/批量管理、C0-C UI Complexity Gate 均在本次开工后的 Regression Check 通过：17 suites / 121 tests PASS，`typecheck`、`verify:elastic`、`lint -- --quiet` PASS。
- 当前 C-v2 基线 Exact HEAD 与 `origin/main` 同为 `e38b8b2e654c29561ad37ac27c77d91e4ef3d1ba`；工作区已有未跟踪文件全部属于用户/环境内容，保持不动。

### C1 — Runtime Observability First（C-v2）

状态：C1 Runtime Observability First GO；旧 C1 Long-Horizon NO-GO 记录继续保留；本节对应改动将在本轮独立 C1 commit 中封板。

Plan：

- 假设：慢请求无法解释的直接根因是观测字段分散在阶段 trace、Receipt、Provider Result 和 usage ledger 中，缺少一个与最终 messages/最终 wire budget 对齐的安全 Request Boundary 记录；当前 Receipt 的缺 usage fallback 还会把未知值写成 0。
- 本阶段只改：每个实际 Writer/Formatter physical request 的安全 Receipt/observability metadata；队列、Provider、parse、persist 的分段生命周期；真实 Provider request id、failure class、`requestMayHaveExecuted`、finish reason、usage nullability 和物理请求数的持久化投影；对应单元/合同测试。
- 明确不改：任何请求消息、Prompt、预算值、Governor 行为、timeout 常数、reasoning 策略、Retry 行为、Pipeline 拓扑、Mandatory Truth 投影、UI 一级导航和已有用户数据。
- Red Test：queue/provider 分离、usage 缺失保持 null、`outcome_unknown` 保留、Receipt 禁止 raw prompt/body、physical request count 真实计数、timeout 不自动 retry、Thinking 安全 metadata 可核验。
- Red Test 实际结果：新增 `__tests__/phase3C1RuntimeObservability.test.ts`，6 tests 中 4 项失败、2 项通过。失败点与预期一致：Receipt 缺少 `writingRunId/scenario/llmConfigId/providerAdapterId/configuredContextWindow/completionCapability/wireMaxTokens/targetChars` 等边界字段；缺 usage 被写成 `0` 而非 `null`；`outcome_unknown` 被写成 `failed` 且未保留 `providerRequestId/requestMayHaveExecuted`；`timings` 未提供 queue/provider/parse/persist/total 分段。通过项确认现有 physical request count 与未知结果不自动 retry 契约未回归。
- CHECK-A：targeted Jest、`npm run typecheck`、`npm run verify:elastic`、`npm run lint -- --quiet`，阶段结束前 `npm run verify`。
- CHECK-B：`npm run apk:debug`、记录 APK SHA-256、仅 `adb install -r`；保留既有 App 数据和真实 LLM 配置，通过真实 UI 运行 500 字 Fast Draft、1000 字 Standard、3000 字 Standard，并保存安全 UI/DB/Receipt/usage/filtered logcat 证据。
- GO / NO-GO：所有 Red Test 闭环、代码门禁 PASS、APK/install-r PASS，且每个真实请求（包括 slow/timeout）能回答 queue/provider/parse/persist 分段耗时、实际 prompt tokens、最终 wire max output、Thinking/reasoning policy、Provider usage/finishReason、physical fallback、是否可能已执行、是否自动 retry；否则 C1 NO-GO 并停止，不进入 C2。

最小实现：

- `src/services/llm/types.ts`、`src/services/llm/requestPolicy.ts`、`src/services/llm/openAICompatibleProvider.ts`：为 Provider Result / Error 增加 provider request id、raw usage、output-budget trace 与 queue/dispatch/send/receive/parse 生命周期；保留原有请求 payload、timeout、retry、thinking 和 fallback 行为。
- `src/services/writing/contracts/writingRequestReceipt.ts`、`src/services/writing/stages/writerCore.ts`：把安全 Request Boundary 元数据写入 Receipt；usage 缺失保持 `null`；保存 `writingRunId`、scenario、provider adapter/model/config、quality/execution/thinking/reasoning、target/context/capability/wire budget、finish/empty/failure/uncertainty、physical/fallback 计数和分段 timing；Receipt compact 投影删除 prompt/body/messages，不保存正文或 Key。
- `src/services/writing/execution/runOutlineSharedWriterAction.ts`、`src/services/writing/persistence/continuationDurableAdapter.ts`、`src/services/writing/execution/continuationStageDriver.ts`、`src/services/writing/persist/continuationAdoption.ts`：把 Receipt 安全投影、官方 token nullability、provider boundary fields 和 durable `persistMs` 接到 attempt/stage ledger；避免 continuation 外层再次累加持久化耗时；`outcome_unknown` 仍不自动重试。
- `src/services/writing/contracts/writingSource.ts`、`src/services/writing/contracts/frozenWritingContext.ts`、`src/services/writing/context/freezeWritingContext.ts`、`src/services/writing/scenario/continuationRunPreparation.ts`：仅传递 targetChars 作为观测输入，不参与 Freeze fingerprint 或请求行为。

Targeted verify：

- Red Test 首次结果已保留：6 tests 中 4 项失败、2 项通过；失败点为 Receipt 边界字段、usage nullability、`outcome_unknown` 映射和分段 timing 缺失。
- 最小实现后 `npx jest __tests__/phase3C1RuntimeObservability.test.ts __tests__/continuationDurableAdapter.test.ts --runInBand`：2 suites / 12 tests PASS；`npm run typecheck`、`npm run verify:elastic`、`npm run lint -- --quiet` PASS。
- 最终 `npm run verify` PASS：lint 0 errors（仓库既有 258 warnings）、typecheck、elastic、version 均 PASS；Jest `3 skipped, 513 passed` suites，`8 skipped, 3657 passed` tests，共 516 suites / 3665 tests。

APK / install-r：

- `npm run apk:debug` PASS；构建时仅为 JDK loopback 临时目录使用进程级 `jdk.net.unixdomain.tmpdir` 环境参数，未清理 Gradle 缓存；产物 `dist/apk/debug/ShineWriter-V2.21.1-debug.apk`，大小 59,826,514 bytes，SHA-256 `3F469E700E111AFB81CD7065E6828A76B5C5848A3BD9876E62C9C67A999387C1`。
- `adb -s emulator-5554 install -r` PASS；设备包 `com.shinewriter` 为 `versionName=V2.21.1` / `versionCode=2210100`；未卸载、未 `pm clear`、未重置应用数据，既有真实 LLM 配置和项目数据保留。

真实 Android / DB / Receipt / UI / logcat：

- 环境核验：`adb devices` 仅使用 `emulator-5554 device`；真实配置为设备已有的 GLM-5.3-Flash/OpenAI-compatible adapter，API key 未读取、未输出。三档均通过 App 既有 UI 创建，未使用 fake/virtual provider。
- 500 字 Fast：batch `batch_mtd69ehk_u9bjle`、run `ct_1b2eda6aa66c403ebcd4d33c937f249b`、chapter 40，UI 报告 `1/1`、完整流水线 `1`、总调用 `1`；Receipt `input/output/reasoning/visible=75737/3919/3365/554`、`finishReason=stop`、`queue/provider/parse/persist/total=0/82962/1/11/82974ms`、physical/fallback `1/0`。UI/DB/安全投影/filtered logcat：`test-logs/phase3-c1-android-current-r2/matrix-500-final.xml`、`matrix-500-final.sqlite`、`matrix-500-safe-projection.json`、`matrix-500-logcat-filtered.txt`；DB `integrity_check=ok`、projects 3、chapters 40、keys 0、敏感/崩溃匹配均为 0。
- 1000 字 Standard：batch `batch_mtd6uh8e_2qxari`、run `ct_ddef1724b8534e55885fead36f4bfd24`、chapter 41，run `completed/adopted`；Draft 与 unified QA 各 1 次成功，Conditional Revision 按条件跳过。Draft Receipt `input/output=74796/11573`、`finishReason=stop`、provider `232781ms`、persist `10ms`、total `232793ms`；QA Receipt `input/output=22145/2693`、`finishReason=stop`、provider `67039ms`、persist `0ms`、total `67040ms`；每个阶段 physical/fallback `1/0`。证据：`standard-1000-final.sqlite`、`standard-1000-safe-projection.json`、`standard-1000-running.xml`、`standard-1000-logcat-filtered.txt`；DB `integrity_check=ok`、projects 3、chapters 41、keys 0，敏感/崩溃匹配均为 0。
- 3000 字 Standard：batch `batch_mtd76ukt_zf0o92`、run `ct_2cf4c83b52e44d6e801c3175ff288561`、chapter 42。Draft 成功：`input/output=75126/19199`、`finishReason=stop`、provider `412890ms`、persist `13ms`、total `412904ms`；unified QA 唯一请求返回 `finishReason=length`，usage `23892/3350`、`reasoning=3343`、`visible=7`，provider `77990ms`、parse `1ms`，run 以 `SHARED_WRITER_TRUNCATED_OUTPUT` fail-closed，未自动重试；UI 明确显示“批次已暂停 / 续写运行失败”。失败请求仍有完整安全 Receipt、physical/fallback `1/0` 和 finish reason，能区分“Provider 已返回但业务 contract 拒绝”与 `outcome_unknown`。证据：`standard-3000-final-before-stop.xml`、`standard-3000-final.sqlite`、`standard-3000-safe-projection.json`、`standard-3000-logcat-filtered.txt`；DB `integrity_check=ok`、projects 3、chapters 42、keys 0，敏感/崩溃匹配均为 0。
- 三份 safe projection 均声明 `rawPromptOrBodyStored=false`；没有把正文、完整 prompt、request/response body 或 Key 写入 Receipt/证据。所有真实调用均为单一 physical request，`protocolFallbackCount=0`；未触发 outcome-unknown auto retry。

Act：C0 Regression、C1 Red→最小实现→targeted/full verify、APK/install-r 和 500/1000/3000 真实 Android Request Boundary Check 均完成。新 C-v2 C1 按“慢/失败可解释”标准 GO；3000 Standard 的 `finishReason=length` 是当前真实 Provider 输出上限导致的可解释 fail-closed，不冒充内容成功，也不改动 C1 之外的预算/timeout/拓扑行为。停止在 C1，不进入 C2；C2 仅记录为下一阶段建议，旧 C1 长程基线 NO-GO 仍有效。

## C2 — Governor Shadow Mode（初始实施记录；C2-CORRECTION 见下）

状态：C2 implementation PASS / Android matrix HOLD；当前执行 C2-CORRECTION。远端 HEAD `39b91e58` 的 C1 GO 结论继续保持；C3 未开始且本轮禁止开始。

### Plan

- 假设：C1 已能观测最终 messages、Provider capability、usage、finishReason 和生命周期；当前缺少同一 Request Boundary 上的确定性 Demand Floor / Soft Budget / Hard Ceiling 对照，因此无法判断现有 wire 预算是否过宽、过窄或被 Provider 能力错误限制。
- 根因：现有 `compiled.maxTokens` 只表达 legacy 请求预算，尚未把 target、output contract、reasoning envelope、protocol reserve、safety reserve、实际 prompt occupancy 与 profile learning 形成安全旁路记录；也没有 profile isolation 和异常样本污染保护。
- 本阶段只改：新增纯函数 Governor Shadow 计算器、轻量 profile 聚合器、Receipt/阶段证据中的安全 shadow projection；把它接到共享 Writer 的最终 messages boundary，并验证 recommendation 不改变当前 wire request。
- 明确不改：不启用 recommendation；不改已有 `maxTokens`；不改 Prompt Compiler、Context 裁剪、Thinking policy、timeout、Retry、Pipeline 拓扑、Stage 数量、业务 `llm_config`；不新增 LLM 调用；不保存 prompt/body/正文/Key。
- Red Test：覆盖 Demand Floor ≤ 推荐值（硬能力足够时）、recommendation 不等同模型最大能力、quality/reasoning envelope 单调提升、profile key 隔离、Known Result 低利用率慢收紧、`outcome_unknown`/network/5xx/persist 不学习，以及 Shared Writer 仍发送原 legacy maxTokens 且 Receipt 有 shadow 字段。
- Android 真实 LLM Check：500 / 1000 / 3000 字 × Fast / Standard / Quality，优先用既有真实配置；每个请求收集 APK SHA、install-r、UI、DB、Receipt、usage、finishReason、timing 与 filtered logcat，确认 shadow physical call=0 且未改变真实调用数。
- GO 指标：Red Test 闭环；推荐值可解释且不越过硬能力；profile 只保存聚合统计并隔离 provider/model/stage/profile/contract/compiler/reasoning policy；异常样本不污染；targeted/full verify、APK/install-r、真实 Android Matrix、DB/Receipt 证据完整；独立 commit。

### Red Test

首轮 `npx.cmd jest __tests__/phase3C2GovernorShadow.test.ts --runInBand` 已真实失败：suite 在加载阶段报 `Cannot find module '../src/services/writing/governor/writingGovernor'`，0 tests executed。失败点明确为 Governor Shadow / profile 模块尚不存在；未提前修改生产实现。

### Minimal Implementation

- 新增 `src/services/writing/governor/writingGovernor.ts`，只在最终 compiled messages boundary 计算 C2 shadow：实际 prompt token、target demand、visible floor、reasoning envelope、protocol/safety reserve、soft recommendation、context/provider hard ceiling、legacy wire 对照和 preflight 结果；不发起 LLM 请求、不选择预算、不改变已有请求。
- Governor profile key 按 provider adapter/model/stage/quality/execution/output contract/compiler/reasoning policy 隔离；只聚合 sample count、利用率、延迟和 finish reason。仅 `stop + businessResultValid` 或已知 `length` 样本学习；`outcome_unknown`、network/provider/fatal/cancelled、safe retry 和未知 usage 均不学习。
- `WritingRequestReceipt` 及 durable runtime projection 增加安全 `governorShadow`；Shared Writer 的 primary/injected/formatter boundary 均记录 shadow，physical request 仍保持原有一次调用语义，成功业务结果才 promote profile。
- `Batch Target Demand Plumbing Correction`（commit `39b91e58` 已带入，当前不回滚）：批量续写把每个 item 的 `targetWords` 冻结为 `targetChapterChars`，再经 `settingsOverride` 进入 `buildContinuationV5Context`；它确实参与 Context / Source / Stage Budget，不是纯 Shadow metadata。独立 target 回归测试在 C2-CORRECTION 小节登记。
- 纠正旧表述：不能再笼统写“Prompt / legacy request behavior 均未改变”。本次 target plumbing 会改变 budget demand 输入；但实际 Prompt 编译文本、legacy wire `maxTokens`、Thinking 开关、timeout、Retry、Pipeline topology、Provider wire payload 和 physical call 数均保持不变。C2 recommendation 仍未接管真实 wire。

### Targeted Red Test / Verify

- Red Test 首轮保持真实失败：`npx.cmd jest __tests__/phase3C2GovernorShadow.test.ts --runInBand` 在加载阶段报 `Cannot find module .../writingGovernor`，0 tests executed；随后按失败点补最小实现，未用测试替代生产验证。
- 定向闭环：`npx.cmd jest __tests__/phase3C2GovernorShadow.test.ts __tests__/continuationBatchAdapter.test.ts --runInBand`，2 suites / 33 tests PASS。覆盖 demand/soft/hard/legacy wire 分离、reasoning envelope 单调性、profile isolation/learning、异常样本不污染、batch target 冻结、Shared Writer 单物理调用和 legacy maxTokens 不变。
- 最终代码门禁：`npm.cmd run verify` PASS；lint `0 errors / 258 warnings`（均为仓库既有 warning），typecheck、`verify:elastic`、`verify:version` PASS；Jest `3 skipped, 514 passed` suites（517 total），`8 skipped, 3661 passed` tests（3669 total）。
- `git diff --check` 在提交前执行；仅将 C2 源码、测试与本进度文档纳入提交，用户/环境未跟踪文件、APK 和 test logs 不进入 Git。

### APK / install-r（初始 C2 记录）

- `npm.cmd run apk:debug` PASS；产物 `dist/apk/debug/ShineWriter-V2.21.1-debug.apk`，SHA-256 `4A7D63E766AAC342092633C21311FC4B48DB7EE9963D817DB017DE95A15D695E`。
- 通过 `adb -s emulator-5554 install -r` 安装，包 `com.shinewriter`，`versionName=V2.21.1` / `versionCode=2210100`；未使用 `uninstall`、`pm clear` 或数据库清理，保留既有数据和 LLM 配置。

### Android / DB / Receipt / UI / logcat（初始 C2 历史证据）

- 使用 QA skill 要求的真实设备 `emulator-5554`、App 既有在线配置 `OpenAI 兼容 API / GLM-5.3-Flash`，API key 未读取或写入报告；通过真实 UI 创建单章批次，未使用 fake/virtual provider。设备在中断后掉线，重连时发现的旧 `V2.11.51` AVD 仅用于确认环境，不计入 C2 结果，也未清数据。
- 修正 target/provider boundary 后，当前已完成 `Quality × 500/1000/3000` 三个真实样本；每个样本均为 1 章、2 次 physical request（Draft + QA），没有自动重试，DB 均 `integrity_check=ok`、3 projects、0 API keys。三次 QA 均因真实 Provider 返回 `finishReason=length` 被业务 fail-closed 为 `SHARED_WRITER_TRUNCATED_OUTPUT`，UI 显示“批次已暂停 / 续写运行失败”，这是可解释的安全失败，不冒充内容成功。

| target / batch | Draft（Receipt shadow） | QA（Receipt shadow） | persisted result |
| --- | --- | --- | --- |
| 500 / `batch_mtdmj2w0_lukan6` | input/output `56676/8011`，visible/reasoning `660/7351`，`stop`；target `500`，adapter `open.bigmodel.cn-v4`，legacy/recommended `131072/22283` | input/output `24961/1200`，visible/reasoning `4/1196`，`length`；target `500`，legacy/recommended `1200/20835` | `paused_user`，used `2`，error `BATCH_CONTINUATION_RUN_FAILED` |
| 1000 / `batch_mtdms14e_vp64du` | input/output `51641/15011`，visible/reasoning `1021/13990`，`stop`；target `1000`，adapter `open.bigmodel.cn-v4`，legacy/recommended `131072/24547` | input/output `25790/1250`，visible/reasoning `7/1243`，`length`；target `1000`，legacy/recommended `1250/21626` | `paused_user`，used `2`，error `BATCH_CONTINUATION_RUN_FAILED` |
| 3000 / `batch_mtdn2ck7_dlmigx` | input/output `41853/28846`，visible/reasoning `2181/26665`，`stop`；target `3000`，adapter `open.bigmodel.cn-v4`，legacy/recommended `131072/33602` | input/output `27035/3350`，visible/reasoning `35/3315`，`length`；target `3000`，legacy/recommended `3350/24791` | `paused_user`，used `2`，error `BATCH_CONTINUATION_RUN_FAILED` |

- 上表的三份冷快照为 `test-logs/phase3-c-v2/c2-governor-shadow/db-final-500-quality-fixed.sqlite`、`db-final-1000-quality-fixed.sqlite`、`db-final-3000-quality-fixed.sqlite`；对应 UI 过程/终态 XML、filtered logcat 和安全字段解析均保存在同一 evidence directory。Receipt 只保留 metadata/fingerprint/usage/finish/timing/shadow，不含 prompt、body、正文或 Key；三样本 `physicalRequestCount=1`/stage、`protocolFallbackCount=0`。
- Draft profile key 在三种 target 间保持一致（target 不参与 profile identity），QA profile key 独立于 Draft；三种 target 的 shadow `recommendationMeetsDemandFloor=true`、`preflightBlocked=false`。这证明 capability 与 request budget 已分开观测，但 recommendation 尚未接管 wire。
- 修正前的旧 500/1000/3000 × Fast/Standard/Quality 观测曾出现 `targetChars=3000` 和 `providerAdapterId=null`，均标记为 superseded，仅作为发现问题的过程证据，不作为 C2 GO 矩阵结论。

### Act / Commit / Remaining Risks

- 初始 C2 源码、定向测试、全量门禁、APK 构建/install-r 和 Quality 三档真实 Android 证据已完成并写入本节；这些记录保留为 `39b91e58` 的历史基线，C2-CORRECTION 的新门禁与设备状态见下节。
- C2 Android GO 矩阵尚未封板：修正后 `500/1000/3000 × Fast/Standard` 六个组合仍需真实 LLM 复测；因此本节明确记为 `C2 implementation PASS / Android matrix HOLD`，不进入 C3，不宣布 Phase III-C GO。C2 profile 当前仅为进程内聚合，持久化与完整矩阵留待后续阶段。
- C3 → C10 仍未开始；原 C1 长程基线 NO-GO、C2 修正前 superseded 证据和本轮真实 QA length fail-closed 结论均保留，不删除、不粉饰。

### C2-CORRECTION — Shadow Governor 解耦、reasoning feedback 与 Batch Target Demand Plumbing Correction

状态：C2-CORRECTION 的 implementation PASS；Android matrix HOLD。远端 HEAD `39b91e58` 的 C1 GO 继续有效；本轮没有开始 C3，也没有继续消耗剩余真实 LLM 矩阵。

施工仓：`F:\ClaudeWorkSpace\projects\TAVO-MINI`。`E:\AiWorkSpace\tavo-mini` 只作为历史证据中的旧环境说明。

#### PLAN

- 暂停原 C2 真实矩阵，仅修 Shadow Governor 本身；先用 128K/1M context 对照、GLM reasoning 样本和 batch target plumbing 回归锁住边界，再决定是否恢复矩阵。
- 接受条件：ContextSafetyReserve 只进入 availableCompletion；OutputSafetyReserve 只按 visible demand、reasoning envelope、protocol reserve 与已知波动计算；1M context 不再制造约 20K output soft budget。
- 接受条件：已知成功/已知 `length` 结果才更新 reasoning profile；下一轮 envelope 同时使用 versioned cold-start seed、历史真实 reasoning aggregate 和当前 actualPromptTokens / target demand；unknown/network/5xx 不污染 profile。
- 继续保持 shadow-only：不让 recommendation 接管 legacy wire `max_tokens`，不关闭 Thinking，不修改 timeout 常数，不启用 Streaming，不增加 physical call。

#### 新 Red Tests 首次 FAIL

- 新增 Governor Red Test 后首次运行 `npx.cmd jest __tests__/phase3C2GovernorShadow.test.ts --runInBand`：9 tests 中 5 PASS、4 FAIL。失败分别锁定了 1M context 导致 soft budget 暴涨、known high-reasoning 后 envelope 不提升、低 reasoning 样本后的高水位保护缺失，以及 `http_5xx` 错误错误地改写 profile。
- 新增 `__tests__/phase3C2BatchTargetDemand.test.ts` 作为独立 plumbing contract；它验证 500/1000/3000 的 target 经 `settingsOverride` 到达 Freeze / kernel request，并证明非 3000 不会回落到 project default 3000。

#### 最小修正

- `src/services/writing/governor/writingGovernor.ts` 升为 `writing-governor-shadow-v2`：`contextSafetyReserve = contextWindow × 0.02` 仅用于 availableCompletion；baseSoftBudget 不再包含它。新增 demand-relative `outputSafetyReserve`，旧 `safetyReserve` 仅保留为 output-only 兼容别名。
- Governor 以 versioned cold-start seed 保留原始 effort 比例，但真实反馈成为主要信号；profile 只保留 bounded reasoning/visibleDemand 与 reasoning/actualPromptTokens 的 EWMA/high-water、样本计数等聚合，不保存正文、prompt、memory 或 key。已知 high reasoning 会提高下一轮 envelope；连续低 reasoning 只按慢衰减修正；`outcome_unknown`、network、5xx、provider/fatal/cancelled 等不学习。
- 当前 demand 与 input 在每轮重新归一化，profile key 不包含 target，因此 500/1000/3000 共享 profile 并按当前 demand/input 自适应；Thinking policy、timeout、wire payload 和 physical call 行为不变。
- 单独登记 `Batch Target Demand Plumbing Correction`：`continuationBatchAdapter` 的 `targetWords` → `targetChapterChars` → `settingsOverride` → `buildContinuationV5Context`，会参与 Context / Source / Stage Budget。该 correction 不回滚 `39b91e58`，也不再宣称“Prompt / legacy request behavior 均未改变”；实际 Prompt 文本与 legacy wire 行为未改，但 target demand budget 输入确实改变。

#### Targeted / Typecheck / Verify

- `npx.cmd jest __tests__/phase3C2GovernorShadow.test.ts __tests__/phase3C2BatchTargetDemand.test.ts __tests__/continuationBatchAdapter.test.ts --runInBand`：3 suites / 44 tests PASS。
- `npm.cmd run typecheck` PASS；`npm.cmd run verify:elastic` PASS。
- `npm.cmd run verify` PASS：3 skipped、515 passed suites（518 total）；8 skipped、3672 passed tests（3680 total）；lint 0 errors，保留仓库既有 258 warnings；version consistency PASS。
- `git diff --check` 通过（文档更新后将再次复核）。

#### APK / install-r

- `npm.cmd run apk:debug` PASS；Windows/JDK loopback 使用进程级短路径 `C:\tavo-uds` workaround，产物 `dist/apk/debug/ShineWriter-V2.21.1-debug.apk`，大小 `59,838,778` bytes，SHA-256 `85F04E25FBC348D9CFDA1A677C1299E1D98B50FF1D268C055F1E6F9F9A1B9B72`。
- QA 前置 `adb devices` 为空；`emulator-5554` 的 `get-state`、包核验与 `adb install -r` 均因 `device not found` 被阻断。没有卸载、`pm clear`、数据库清理或任何真实 LLM 请求。证据目录已建立：`test-logs/phase3-c-correction-android`。

#### Real GLM Probe / Android Check

- 由于 `emulator-5554` 当前不在线，500 Quality Draft、1000 Quality Draft 和 1 个真实 QA 均未启动；不把环境阻塞误报为 Probe PASS，也不继续跑完整 `500/1000/3000 × Fast/Standard/Quality` 矩阵。
- 单元/Shared Writer contract 已确认 Governor 不产生额外 physical call、legacy maxTokens 仍原样发送、recommendation 仍为 shadow-only；真实设备侧的 `Governor physical call=0`、reasoning feedback、QA reasoning room、UI/DB/Receipt/logcat 证据待设备恢复后补齐。

#### ACT / Remaining Gate

- 当前结论固定为 `C2 implementation PASS / Android matrix HOLD`；C1 GO 保持，C3 禁止开始。待设备在线后只补三条指定 Probe；只有 Probe PASS 才能讨论恢复剩余矩阵。
- C2 profile 目前仍为内存态；C3 Production Governor 前必须增加轻量 durable aggregate，只保存上述聚合统计，不保存正文、prompt 或 memory。
- 未修改 timeout 常数、Thinking 开关、Streaming 或真实 wire max_tokens；本轮改动按用户指令提交到 `main` 并推送 `origin/main`，工作区其余用户原有未跟踪文件保留。

## C3 → C10

### C2-CORRECTION Android Matrix Closure（2026-08-29）

状态：`C2-CORRECTION Android Matrix GO`；C3 门禁已解除。旧 C1 Long-Horizon NO-GO、C2 初始矩阵 HOLD 和修正前 superseded 证据均保留，不删除、不粉饰。当前远端基线为 `78b1b09f`（`origin/main`）。

#### Android / install-r / 数据安全

- 使用 Test Android Apps skill 的真实设备流程核验 `adb devices`、UI tree 定位、截图、DB 快照和 filtered logcat；设备为 `emulator-5554`，包为 `com.shinewriter`。
- `dist/apk/debug/ShineWriter-V2.21.1-debug.apk` 构建通过，SHA-256 为 `85F04E25FBC348D9CFDA1A677C1299E1D98B50FF1D268C055F1E6F9F9A1B9B72`；只执行 `adb -s emulator-5554 install -r`，未卸载、未 `pm clear`、未重置数据库，既有真实 GLM-5.3-Flash/OpenAI-compatible 配置保留。
- 最终稳定快照为 `test-logs/phase3-c-c2-android/matrix-3000-quality/report.sqlite`，`PRAGMA integrity_check=ok`。安全只读投影由 `scripts/qa/phase3-c2-matrix-projection.mjs` 生成：`test-logs/phase3-c-c2-android/c2-corrected-matrix-safe-projection.json`；投影不输出 prompt、正文、request/response body、API key 或 authorization。
- 投影覆盖 `9/9` 单章组合；全部 Governor shadow version 为 `writing-governor-shadow-v2`，敏感字段计数 `apiKey=0 / authorization=0 / bearer=0`；所有已记录 Receipt 均 `wireUnchanged=true`、`recommendationNotSent=true`。

#### 9-cell real matrix

| target / quality | batch status | LLM calls | input / output | observed outcome |
| --- | --- | ---: | ---: | --- |
| 500 / Fast | `completed` | 1 | `35386 / 5760` | Draft `stop`，完整流水线成功 |
| 500 / Standard | `cancelled`（UI：批次已结束） | 2 | `57649 / 8512` | Draft `stop`；QA `length`，fail-closed |
| 500 / Quality | `cancelled`（UI：批次已结束） | 2 | `60947 / 5275` | Draft `stop`；QA `length`，fail-closed；采用同进程 feedback 最新样本 |
| 1000 / Fast | `completed` | 1 | `33592 / 8331` | Draft `stop`，完整流水线成功 |
| 1000 / Standard | `cancelled`（UI：批次已结束） | 2 | `58716 / 7555` | Draft `stop`；QA `length`，fail-closed |
| 1000 / Quality | `cancelled`（UI：批次已结束） | 2 | `63214 / 14112` | Draft `stop`；QA `length`，fail-closed |
| 3000 / Fast | `completed` | 1 | `34389 / 22960` | Draft `stop`，完整流水线成功 |
| 3000 / Standard | `cancelled`（UI：批次已结束） | 2 | `65175 / 26769` | Draft `stop`；QA `length`，fail-closed |
| 3000 / Quality | `cancelled`（UI：批次已结束） | 1 | `7127 / 0` | 本地等待 LLM 超过 `570s`，`total_timeout` / `outcome_unknown`，fail-closed |

这里的 `cancelled` 是在 QA/未知结果安全失败后通过 UI “结束批次”收尾形成的 durable header 状态；不代表失败内容被当成成功。Standard/Quality 的 QA `finishReason=length` 未持久化正文，也未自动重试；3000 Quality 的未知结果没有重复执行。Fast 三个成功单元均为单一 physical call，并完成完整流水线。

#### Governor / reasoning feedback Check

- 三个 target 的 Draft shadow profile key 保持同一 provider/model/stage/contract/compiler/reasoning-policy 隔离键；target 只作为当前 demand 输入，不污染 profile identity。
- 真实 Quality 同进程 feedback pair 显示已知结果才更新聚合：500 字 Draft 的 `profileSampleCount` 从 `1` 到 `2`，`demandFloor` 从 `2359` 到 `5283`，`reasoningEnvelope` 从 `1264` 到 `4188`，`recommendedSoftBudget` 从 `2899` 到 `6039`；`coldStart/learned` 仍按 `MIN_PROFILE_SAMPLES=3` 保持未 learned。未把 unknown/network/5xx 样本纳入学习。
- 1M context 的 ContextSafetyReserve 仅影响 available completion；本矩阵中 `legacyWireMax` 仍为 provider ceiling `131072`，推荐值始终为 shadow 字段，未进入真实 wire，也没有新增 physical request。

#### C2 decision

- C2-CORRECTION targeted tests：`phase3C2GovernorShadow`、`phase3C2BatchTargetDemand`、`continuationBatchAdapter` 共 `44/44 PASS`；`typecheck`、`verify:elastic`、完整 `verify` 均 PASS，完整校验为 `515` suites / `3672` tests passed（另有既有 skipped/warnings）。
- Android 9-cell、DB integrity、Receipt/usage、UI 状态和 filtered logcat 证据齐全；预期的 `length` 与 `outcome_unknown` 均按 fail-closed 处理。因此 C2 正式 `GO`，允许进入 C3。

### C3 → C10

尚未开始；C3 必须先以 Red Test 锁定 durable aggregate，再按阶段独立推进。旧 C1 长程基线 NO-GO 仍保留。
