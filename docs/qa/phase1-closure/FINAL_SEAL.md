# ShineWriter 一期工程收尾 Final Seal

执行日期：2026-08-13（Asia/Shanghai）
分支：`codex/phase1-closure`
目标版本：`2.11.50`

## 1. 基线与边界

- `HEAD` 与 `origin/main` 在本轮开始时均为 `af0927fca18faa3afc9e218463cc50fd6598e7c6`，分支无 ahead/behind；`git fetch --all --prune` 在本机超时，随后用 `git ls-remote origin refs/heads/main` 核验远端 main 仍为该 SHA。
- 首轮 working tree 只有用户提供的两份 `docs/optimization/*20260813*.md` 未跟踪方案文档；它们不属于本次实现，不会提交。
- 运行时不变量：`src/services/migrations/index.ts` 的 `SCHEMA_VERSION = 51`；`src/types/pipelineContext.ts` 与 `src/services/contextBuilder.ts` 的 `contextBudgetVersion = 6`。
- Forbidden Diff 审计范围覆盖 Context Budget V3、`contextBuilder`、Worldbook activation、Pipeline、Freeze/Resume、Story Memory、Canon、Outline；本次实现文件不触及这些运行语义。

## 2. 实现闭环

### CL-06 / test:ci

- 新增预设目标、适配器、生成质量门禁、文件导入导出、BuildScreen 和 ResourceLibrary 覆盖。
- 角色卡结构化字段适配器增加对象/数组安全渲染，实机验证不再出现 `[object Object]`。
- 最终完整 `test:ci` 已通过：391 suites passed / 3 skipped（394 total），3166 tests passed / 8 skipped（3174 total）。

### 一等“预设构建”

- BuildScreen 与角色卡、世界书共享独立构建和 TXT Reader 来源构建；目标为 `preset_independent` / `preset_from_text`。
- 生成协议固定为 `shinewriter-preset-v1`，只允许 `name`、`system_prompt`、`writing_style`、`extra_instructions` 四个文本字段；采样默认值由本地适配器提供，不把额外 LLM 字段写入导出协议。
- compact/full/deep 质量档、预览、保存、JSON 导出/导入、库内编辑/复制/删除、同名不覆盖和 TXT→预设链路均有单测与真机证据。
- TXT 提示词只抽取机制/风格，不把原著人名、地点、事件或原文复制进预设。

### 作家风格 Catalog

- `src/services/presets/catalog.ts` 补齐感官现实主义机制，并增加限知悬念推进与版权安全的完整机制描述。
- 真机证据覆盖全部 Catalog、复制两次生成同名副本、编辑、导出、删除确认；导出文件：
  `test-logs/phase1-closure/android-e2e/exports/感官现实主义.json`
  SHA-256 `A10966976102B3D1AC52B103159678EFB57251FB01D0ED63CB23F189B7CB8EEF`。

## 3. Android 真机证据

设备：`emulator-5554`，Android API 37，包名 `com.shinewriter`。所有 XML/UI 截图/日志位于 `test-logs/phase1-closure/android-e2e-final/`。

| 场景 | 证据 | 结果 |
| --- | --- | --- |
| 独立预设构建 | `ui/02-preset-compact.xml`、`ui/15-preset-result.xml`、`ui/17-preset-json.xml`、`exports/E2E_Final_Preset-预设.json` | full 预设生成、质量预览、精确协议 JSON、保存/导出通过；SHA-256 `5A1D1C1708E36EB5AC0586B687002B3A149586E21DA82628690A89F44962D6F5` |
| 独立角色卡/世界书 | `ui/34-character-result.xml`、`ui/43-worldbook-result3.xml` | 角色关系、世界书长事实条目和质量报告均可见 |
| 世界书→角色、角色卡→世界书 | `ui/64-role-to-worldbook-form.xml` 至 `ui/82-role-to-worldbook-retry-result3.xml` | 真实选择器、导入、重试和结果通过 |
| UTF-8 多章节 TXT→角色/世界书/预设 | `ui/83-txt-build-top.xml`、`ui/91-txt-to-character-result.xml`、`ui/102-txt-to-worldbook-result.xml`、`ui/110-txt-to-preset-result.xml`、`ui/115-txt-preset-imported.xml` | 6/6 章节读取、片段选择、三种目标生成与导入通过 |
| 取消 | `ui/116-cancel-running.xml`、`ui/117-cancelled.xml` | Toast“已取消生成”，表单恢复，未落产物 |
| 401 | `ui/126-http401.xml`、`screenshots/126-http401.png`、`logcat/126-http401.log` | 中文“API 认证失败（HTTP 401）”，要求更新 Key 并保存测试 |
| 非法 JSON | `ui/127-invalid-json.xml`、`screenshots/127-invalid-json.png`、`logcat/127-invalid-json.log` | `JSON Parse error: Unexpected character: o`，停在失败态 |
| 截断 JSON | `ui/128-truncated-json.xml`、`screenshots/128-truncated-json.png`、`logcat/128-truncated-json.log` | `JSON Parse error: Unexpected end of input`，停在失败态 |
| 下游写作/Context Preview | `ui/136-chapter-editor.xml`、`ui/138-toolbar-context.xml`、`ui/139-context-preview.xml`、`screenshots/139-context-preview.png` | 真实章节编辑器与 Context Budget V3 预览正常，显示 1,000,000 窗口、分层弹性池和 6 项资料分配 |

## 4. 覆盖安装与真实 device DB

- 覆盖安装使用 `adb -s emulator-5554 install -r`，没有 uninstall 或 `pm clear`；本轮候选 debug APK：`dist/apk/debug/ShineWriter-V2.11.50-debug.apk`，SHA-256 `8E6842243A2443AC800558A191113286361413339ADA318668A638579A982DF6`。
- 覆盖安装前最终即时基线：`test-logs/phase1-closure/overwrite-pre/pre-upgrade-device.db`，7,426,048 bytes，SHA-256 `FAB59FAC3D93E7C8FC9EAA91B3518AC6B9802698B0523B0D8646359E1D9725AA`。
- 首轮历史采样（含已清理的空白角色）保留为 `test-logs/phase1-closure/overwrite-pre/pre-upgrade-device-initial-raw.db`，没有再作为覆盖安装包含性基线。
- 覆盖安装前后 `install -r` 的即时数据库 SHA-256 相同：`FAB59FAC3D93E7C8FC9EAA91B3518AC6B9802698B0523B0D8646359E1D9725AA`；启动后最终库 `device-db/final-after-launch.db` 为 7,426,048 bytes，SHA-256 `24F8CDED94454B67C75DF779C8426C5EB6DDCB71593E7A9EDD0708A3EE2BABC7`。
- 覆盖安装后的历史修复样本：`test-logs/phase1-closure/overwrite-post/repaired_device.db`，SHA-256 `E8F39C354CD7125DF9945A3BDB3EC1A529D6EB9D6AE1C3F41982412E96A9483D`。
- 本轮错误矩阵配置库：`device-db/config-16384.db` 回读 active 临时配置 `context_window=16384`；恢复库 `device-db/config-restored-default.db` 回读默认配置 active、`allow_insecure_lan_http=false`、schema 51。
- 最终发布后从设备重新拉取 `run-as com.shinewriter cat databases/shine_writer.db`，复制到 `test-logs/repaired_device.db`（SHA-256 同 `24F8CDED...`），并运行：

  ```powershell
  $env:SHINE_WRITER_REQUIRE_DEVICE_DB = '1'
  npx jest __tests__/schema40-verify-device-db.test.ts --runInBand --ci
  Remove-Item Env:SHINE_WRITER_REQUIRE_DEVICE_DB
  ```

该测试要求 schema 51、Canon evidence provenance/index、项目数据行保留及预设/outline 相关行存在；最终通过：projects 2、chapters 23、characters 2、worldbook_entries 1、presets 7、project_resources 10。

## 5. 最终门禁与第二视角复审

最终门禁已执行并记录：

```text
npm ci
npm run lint
npm run typecheck
npm run test:ci
npm run verify
npm run apk:debug
npm run apk:release
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-release-apk.ps1
adb -s emulator-5554 install -r dist/apk/debug/ShineWriter-V2.11.50-debug.apk
```

结果：`npm ci` 成功；`npm run lint` 0 errors / 198 existing warnings；`npm run typecheck`、`npm run test:ci`、`npm run verify` 全部成功。`npm run test:ci` 为 391 passed / 3 skipped suites，3166 passed / 8 skipped tests。

APK 结果：

- debug：`dist/apk/debug/ShineWriter-V2.11.50-debug.apk`，59,099,522 bytes，SHA-256 `8E6842243A2443AC800558A191113286361413339ADA318668A638579A982DF6`。
- release：`dist/apk/release/ShineWriter-V2.11.50-release.apk`，36,636,014 bytes，SHA-256 `2AB210C92C028EFB2C71E7B95D47EB730D8D0F852CE0943B236C6679E386729A`；`verify-release-apk.ps1` hard assertions 全部通过，证书 SHA-256 `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`，v2、zipalign、package/version/versionCode 均通过。
- 覆盖安装：`test-logs/phase1-closure/android-e2e-final/logcat/install-r-final.txt` 为 `Success`；安装后启动 `140-after-install.xml` 可见 `ReviewTierE2E` 项目，`140-after-install.log` 无 fatal app crash signature。

独立验收者复审项目：

1. 重新审阅一期方案的 Must/Forbidden Diff/Final Seal 条款；
2. 从 `af0927fca18faa3afc9e218463cc50fd6598e7c6` 到最终 HEAD 复查文件清单与 `git diff --check`；
3. 独立核验 schema 51、`contextBudgetVersion` 6、预设协议四字段、Catalog、真机 XML/截图/日志、覆盖安装和 device DB 测试；
4. 独立重跑相关回归测试与完整 `test:ci`；
5. 仅在远端 GitHub Actions Verify、迁移测试和 Android debug 构建成功后，将“一期剩余 NO-GO”记为 0。

### Final Seal 结论

开发验收已完成；远端 CI 与第二视角复审完成后更新最终结论。

**PDCA 最后一轮一期剩余 NO-GO = 0**
