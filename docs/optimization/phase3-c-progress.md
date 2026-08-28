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

状态：C0-A 能力门禁 GO；独立提交待完成。完整 1M 真实写作请求另有超时观察，未计入成功证据。

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

Act：完成独立 commit 后，才允许进入 C0-B；若后续阶段真实 LLM Check=NO-GO，立即停止，不以“基本完成”替代门禁。

### C0-B → C10

尚未开始。严格等待前序阶段真实 Check=GO 后进入。
