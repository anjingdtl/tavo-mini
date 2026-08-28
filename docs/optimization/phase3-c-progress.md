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

### C1 → C10

尚未开始。C0-C 已独立提交，按方案先建立当前 HEAD 的真实 Long-Horizon baseline。
