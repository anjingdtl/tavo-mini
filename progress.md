# ShineWriter 进度交接

> 最后更新：2026-08-01（接手续写模块 Android 模拟器长测与修复）
> 状态：**长测进行中**。分支 `agent/continuation-import-canon-emulator-qa` 已落地 9 个 commit + 1 个修复测试；BUG-007（retryStyle UNIQUE 冲突）已修复并通过模拟器复测；CAN-101 完整分析剩余 style 重试卡在模拟器 LLM 出向请求超时，需排查网络或切本地 mock。

## 续写模块长测（agent 分支 `agent/continuation-import-canon-emulator-qa`）

> 触发人：用户在 Grok Build 中途断电，请求接手 `docs/tavo-mini_续写模块_Android模拟器自动测试与修复长程执行计划.md` 的长测工作。基线 commit `04e4dd7`（V2.11.8 schema 29）。

### 已完成（按计划章节）

- **Phase A（工具链 + 基线）**：`npm ci`、`npm run verify`（lint + typecheck + 1654 tests / 202 suites）、`npm run apk:debug` 全部通过。
- **IMP-001/003/004/006（导入主路径）**：模拟器 emulator-5554 (API 36, V2.11.8, buildCode 2110800) 上 PASS；产物落在 `artifacts/qa/20260801-emulator-qa-1/IMP-001…006/`。
- **CAN-001（LLM 配置接入）**：PASS，验证 deepseek API base + model 配置正确生效。
- **CAN-101（Canon 完整分析 happy path）**：分析运行跑通、人物/状态、世界观/剧情 100% 完成；唯一失败 = 风格分析 schema 校验（已修复）。
- **BUG-001 picker lifecycle**：fix（commit `8a9c2db`）。
- **BUG-002 awaiting_review 显示**：fix（commit `ead5bf6`）。
- **BUG-003 failed picker copy orphans**：fix（commit `073e708` + `3d8ebbb`）。
- **BUG-004 evidence cleanup SQL**：fix（commit `bae039f`）。
- **BUG-005 QA LLM 配置导入**：`a87dcca feat(settings): import device-local QA LLM config for emulator tests`。
- **BUG-006 style JSON schema coercion**：`19b1167 fix(style): coerce string fields into string arrays for profile V2`。
- **BUG-007 retryStyle UNIQUE 冲突**：`0b81dbb fix(style): clear stale fingerprint rows before retryStyleAnalysis`。
  - 复现：模拟器单独重试风格时无 UI 反馈；logcat `UNIQUE constraint failed: continuation_style_profiles_fingerprint`。
  - 根因：`idx_continuation_style_profiles_fingerprint` UNIQUE 索引上 fingerprint (含 analyzer_version) 已存在旧 failed 行；retryStyleAnalysis → runStyleAnalysis 总是 INSERT 新 profileId，撞唯一索引。
  - 修复：新增 `deleteStyleProfileByFingerprint(projectId, fingerprint)`；`retryStyleAnalysis` 在 `runStyleAnalysis` 之前调用，仅删 state ∈ {failed, interrupted, cancelled, outdated} 的行，**不动 ready 行**。
  - 验证：单元测试 `__tests__/styleProfileRetryCleanup.test.ts` 2 个用例 PASS；模拟器点击「单独重试」后 DB 创建了新的 `b0d4303f-…` profile（不再冲突）。
  - **遗留**：`__tests__/styleAnalysis.test.ts` 用 jest.mock 替换了 `styleProfileRepository` 整个模块，需在 mock 对象里加 `deleteStyleProfileByFingerprint: jest.fn()` 才能跑通 `npm run verify`（否则 1 fail：`(0 , _styleProfileRepository.deleteStyleProfileByFingerprint) is not a function`）。

### 未完成 / 阻塞

- **CAN-101 收尾**：风格 retry 后日志显示 `请求超时，请检查网络或模型服务`（error_message 入 DB 已记录）。模拟器 ping `api.deepseek.com` → 10.0.0.1 (NAT 网关) 510ms；无 curl 工具，无法验证 HTTPS 真实连通。下一步要么排查代理/DNS，要么切换到本地 mock LLM (`scripts/qa/mock-openai-server.mjs` 还没建)。
- **CAN-002（context=2000/output=2000 预检拒绝）**：需要切到一份 context_window=2000/max_output_tokens=2000 的 QA LLM 配置；`qa/fixtures/continuation/llm-qa-can-002-tiny.json.example` 已写好模板，未实际 push 到模拟器外置目录执行。
- **CAN-005（100K 单章 chunk）**：FX-012 fixture 已存在；待集成到测试。
- **CAN-105（非法 JSON mock）**、**CAN-201（分析中强停恢复）**：依赖 mock-openai-server.mjs；服务脚本未建。
- **PERF-001（50MB 导入压力）**：未跑。
- **`npm run verify` 当前状态**：1654 pass / 3 skipped / **1 fail**（上述 styleAnalysis.test.ts mock 缺失 `deleteStyleProfileByFingerprint`）。

### 仓库 / 分支当前状态

- 工作分支：`agent/continuation-import-canon-emulator-qa`
- 本地领先 `origin/agent/continuation-import-canon-emulator-qa` 9 个 commit（包含 BUG-001…007 与 QA LLM config 导入 + version 对齐 + lockfile）。
- 最新本地 commit：`0b81dbb fix(style): clear stale fingerprint rows before retryStyleAnalysis (BUG-007)`。
- 模拟器上 APK：`dist/apk/debug/ShineWriter-V2.11.8-debug.apk`（含 0b81dbb 修复，11:11 → 12:15 重建），已 install 到 `emulator-5554`。
- 模拟器当前工作项目：`current_project_id=3`（QA-IMP-006，含现成 canon_snapshot + failed style profile，可立即继续 retry 验证）。
- 长测状态文件：`.agent/continuation-qa-state.md`（最近一次更新同步了 BUG-007 fixed + 当前阻塞）。

### 交接清单（下一个 agent 起手精确步骤）

1. **先修测试 mock**（2 行代码，避免 CI 红）：
   - 文件 `__tests__/styleAnalysis.test.ts` line 6-21，`jest.mock('../src/...styleProfileRepository', ...)` 对象里加 `deleteStyleProfileByFingerprint: jest.fn(),`；必要时 line 42-52 import 也加上同名 import（仅用于类型/引用，无副作用）。
   - 跑 `npx jest __tests__/styleAnalysis.test.ts` 确认 1 fail → 全绿；再 `npm run verify`。
2. **CAN-101 收尾**：模拟器「分析概览」页 → 「单独重试」（bounds=[537,1004][752,1114]） → 「开始」bounds=[810,1316][978,1458] 中心 (894,1387)；观察 DB `continuation_style_profiles` 是否新增 ready profile。如果仍超时，改走 mock LLM（`scripts/qa/mock-openai-server.mjs` 新建）。
3. **CAN-002**：`qa/fixtures/continuation/llm-qa-can-002-tiny.json.example` 复制成 `shinewriter-llm-qa.json`，把 `LLMTesti.txt` 的 key 填入；push 到 `Android/data/com.shinewriter/files/shinewriter-llm-qa.json`（UI 已有「导入QA配置」按钮 `a87dcca` commit 加的）。
4. **CAN-005 / CAN-105 / CAN-201**：等 mock LLM 服务就位再跑。
5. **PERF-001**：50MB 文本运行时生成，脚本待写。
6. **每次会话结束前**：
   - 更新 `.agent/continuation-qa-state.md`。
   - 更新本 `progress.md`（最新版本段）。
   - 不要 commit `docs/LLMTesti.txt` / `qa/fixtures/...shinewriter-llm-qa.json`（含真 key）。`.gitignore` 已配。
   - 不要 `git reset --hard` / `git push --force`。

### 工具 / 脚本新增

- `scripts/qa/ui-list-nodes.mjs` — 用 fast-xml-parser 解析 uiautomator dump，按关键词过滤节点 + bounds（替代 PowerShell 笨重的 SelectNodes）。
- `scripts/qa/dump_continuation.py` — Python sqlite3 dump continuation 模块关键表（项目 / sources / settings / analysis_runs / style_profiles / snapshots / import_jobs）；CLI 友好。
- `scripts/qa/capture-android-evidence.sh` 等旧脚本继承自上一阶段。

## 版本进度

- **V2.6.6（2026-07-27）**：修复角色卡/世界书生成结果低于 Token 档位下限时被错误判定为失败的问题。现在仅截断、JSON/必填结构无效、核心文本为空、世界书条目或关键词无效、回读不兼容会阻止应用；结构完整且可回读的结果会保留并显示实际/目标 Token 与补强建议。回归测试 145 个套件、1107 个用例通过；Android 模拟器已从 V2.6.5 升级安装并确认构建页提示与无崩溃日志；Release APK 已签名、zipalign 并完成版本验收。

- **V2.5.24（2026-07-25）**：修复新项目中单独启用或新增世界书条目时仍受关闭父合集过滤的问题；启用子条目会同步开启所属项目合集，但不会改变兄弟条目状态。Android 模拟器上下文预览已验证；Release APK 已完成签名、16KB zipalign 与版本验收。
- **V2.5.23（2026-07-25）**：新项目资料默认关闭；世界书合集开关显式级联全部条目；写作中新增世界书立即进入章节上下文预览；四阶段流水线补齐上下文并串行化任务持久化，避免实时审核结果被旧快照覆盖。Release APK 已完成签名、16KB zipalign 与版本验收。
- **V2.5.22（2026-07-25）**：「构建」模块正式上线（底部导航第五个 Tab，用在线 OpenAI 兼容 LLM 独立生成可移植角色卡与多条目世界书），资料库「AI 一键生成」入口下线并收敛至此。回归通过，Release APK 已构建。
- **V2.5.21（2026-07-24）**：父合集「合集启用」开关展示来源修正（只读项目级配置）；AI 一键生成提示词框滚动修复。
- **V2.5.20（2026-07-23）**：角色 / 世界书 / 笔记的项目级父合集开关独立持久化；Schema 升级至 18。
- **V2.5.17**：多阶段流水线修订收口（Phase 0–4）；LLM 设置页改「上下文长度」时可联动同步流水线各阶段 Max Tokens。
- **V2.5.16**：多阶段流水线修订启动。

详见各版本 [`CHANGELOG.md`](CHANGELOG.md) 与 [`README.md`](README.md)。

---

## 多阶段流水线修订（Phase 0–4，已完成）

- 修正 4 模式（noReview / twoStage / conditional / full）的阶段依赖：twoStage / conditional 串行，full 仅 review ∥ factCheck 并行。
- 引入共享上下文快照 `PipelineContextSnapshot`、分区 token 预算裁剪、初稿后二次本地召回。
- LLM 设置页新增「上下文长度」「最大输出 Token」输入框，改上下文长度时弹窗确认是否按 50/15/15/20 比例同步流水线各阶段 Max Tokens。
- 单元测试、类型检查、Lint、Debug 与 Release 构建全部通过。

> 详细的内部穿测记录（设备标识、模型配置、token 数据、各阶段耗时与返回示例、验收产物路径等）保存在本地未跟踪文档 `PROGRESS-INTERNAL.md`，不纳入仓库。
