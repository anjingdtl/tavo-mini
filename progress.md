# ShineWriter 进度交接

> 最后更新：2026-08-01（接手续写模块 Android 模拟器长测与修复）
> 状态：**长测、真实 LLM 验收、Release 构建与代码交付全部完成**。CAN-005、CAN-105、CAN-201、PERF-001 与 1M 上下文 DeepSeek 验收均已通过；BUG-009/010 已修复。

## 续写模块长测（`main`）

> 触发人：用户在 Grok Build 中途断电，请求接手 `docs/tavo-mini_续写模块_Android模拟器自动测试与修复长程执行计划.md` 的长测工作。基线 commit `04e4dd7`（V2.11.8 schema 29）。

### 已完成（按计划章节）

- **Phase A（工具链 + 基线）**：`npm ci`、`npm run verify`（lint + typecheck + 1654 tests / 202 suites）、`npm run apk:debug` 全部通过。
- **IMP-001/003/004/006（导入主路径）**：模拟器 emulator-5554 (API 36, V2.11.8, buildCode 2110800) 上 PASS；产物落在 `artifacts/qa/20260801-emulator-qa-1/IMP-001…006/`。
- **CAN-001（LLM 配置接入）**：PASS，验证 deepseek API base + model 配置正确生效。
- **CAN-101（Canon 完整分析 happy path）**：分析运行跑通、人物/状态、世界观/剧情 100% 完成；风格 schema 校验、单独重试、重试未完成项以及冷启动恢复均已在模拟器通过。最终 DB 为 `analysis_status=ready`，Canon/style profile 均为 ready。
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
- **BUG-008 resume/cold-start style UNIQUE**：`e777ec1 fix(continuation): clean stale style profiles before resume`。
  - 复现：Canon 风格分析请求过程中强停 App，冷启动后点击“继续”；旧 profile 仍为 `running`，第二次 `runStyleAnalysis` 插入撞 `UNIQUE constraint`。
  - 根因：公共 Canon resume 路径此前没有清理旧 fingerprint；清理函数也未覆盖进程死亡/暂停遗留的 `running` profile。
  - 修复：Canon 风格阶段调用前统一清理同 fingerprint 的非 ready profile；清理状态扩展为 `running/failed/interrupted/cancelled/outdated`，ready profile 保留；新增 resume pipeline 和 running orphan 回归测试。
  - 验证：模拟器两次恢复均未再出现 UNIQUE；真实 DeepSeek 请求最终完成，冷启动后 `continuation_settings.analysis_status=ready`，run=`completed/style_validation`，style profile=`ready`；无 crash。

- **BUG-009 ready 风格画像复用**：匹配的 ready profile 不再因重复分析 INSERT 新行而触发 fingerprint UNIQUE；新 LLM 运行期间保留旧 ready 画像，成功后原位刷新 run/snapshot 关联，失败不污染旧画像。单元测试与模拟器 malformed-JSON 回归通过。
- **BUG-010 超长无换行 TXT 导入 OOM**：根因是导入流把单个超长逻辑行反复拼接成 JS 字符串，触发约 100 MiB 分配并导致 Android 进程 OOM。改为分片累计、流式更新正文 hash/长度/段落统计，仅对短行 join；70K 回归测试通过。

### 后续长测结果

- **CAN-005（100K 单章 chunk）**：真实 DeepSeek 配置下完成 4 个连续批次：`[0,28187)`、`[28187,56374)`、`[56374,84561)`、`[84561,100002)`；最终 Canon/style 均 ready，无断档。
- **CAN-105（非法 JSON）**：mock LLM 返回 malformed JSON；修复后的 ready profile 槽位被安全复用，分析最终完成，无 `UNIQUE`/崩溃。
- **CAN-201（强停恢复）**：分析请求进行中 `force-stop`；冷启动后 DB 从 `running` 恢复为 `paused`，批次/工作项重新排队，继续后 run 完成，重试次数由 1 变为 2。
- **PERF-001（50 MiB 导入）**：首次测试复现 OOM；修复后继续导入完成，单章 `52,428,780` 字，生成 800 个连续 chunk，`gap_count=0`；无 OOM/ANR，冷启动后 PSS 从约 310 MiB 回落至约 207 MiB。
- **最终真实 DeepSeek 验收**：先以 128K 配置完成 run `cedee736-7c98-4367-9b4d-ac8710dff139`；按 V4 Flash 实际能力将配置提升到 `1,000,000` 后补测 run `edb55345-e18d-43cc-89b0-099430891b2c`，预检显示单 batch 输入预算 `991419`、预计 2 次调用，最终完成 `style_validation`、progress `2/2`；Canon snapshot `8242ca6d…` 与 style profile 均 ready；最终日志无 FATAL/OOM/ANR/SQLite UNIQUE。

### CAN-002（tiny-model precheck）

- 模拟器临时将当前配置改为 `context_window=2000` / `max_output_tokens=2000`，点击“完整原著分析”。
- UI 明确拒绝：剩余输入预算为 0（低于最低 1024），建议 `max_output_tokens ≤ 1024` 或 `context_window ≥ 4629`。
- DB 验证：项目 3 的分析 run 数仍为 1，最新 run 仍为 `completed/style_validation`；没有创建新分析任务。
- 测试结束后已恢复 `context_window=128000` / `max_output_tokens=8000`。

### 已交付

- 正式 Release APK 已构建并完成签名/zipalign/版本验收：`dist/apk/release/ShineWriter-V2.11.8-release.apk`，SHA-256 `003E6911A96A52C1241DC120C8E4448B62C7C035A615E9B30E4BEAECF7D15810`。
- `npm run verify` 已通过；提交 `a9dd320` 已推送到 `origin/main`。真实 LLM 配置、API key、数据库和 QA 运行产物均未提交。

### 仓库 / 分支当前状态

- 工作分支：`main`
- 最新本地 commit：`a9dd320 fix(continuation): complete emulator long-test fixes`，已推送到 `origin/main`。
- 模拟器上 APK：`dist/apk/debug/ShineWriter-V2.11.8-debug.apk`（V2.11.8，已安装到 `emulator-5554`）。
- 模拟器最近验收项目：`QA－参－005`（project 7）；50 MiB 压力项目为 `PERF-001-50MB`（project 8）。
- 长测状态文件：`.agent/continuation-qa-state.md`（最近一次更新同步了 BUG-007 fixed + 当前阻塞）。

### 交接清单（下一个 agent 起手精确步骤）

1. **门禁**：已完成 `npm run verify` 和 `git diff --check`。
2. **Release**：已按发布指南完成 `npm run apk:release`，验收签名、16KB zipalign、版本元数据和 SHA-256。
3. **交付**：提交 `a9dd320` 已推送 `main`；后续可直接从该提交继续。
6. **每次会话结束前**：
   - 更新 `.agent/continuation-qa-state.md`。
   - 更新本 `progress.md`（最新版本段）。
   - 不要 commit `docs/LLMTesti.txt` / `qa/fixtures/...shinewriter-llm-qa.json`（含真 key）。`.gitignore` 已配。
   - 不要 `git reset --hard` / `git push --force`。

### 工具 / 脚本新增

- `scripts/qa/ui-list-nodes.mjs` — 用 fast-xml-parser 解析 uiautomator dump，按关键词过滤节点 + bounds（替代 PowerShell 笨重的 SelectNodes）。
- `scripts/qa/dump_continuation.py` — Python sqlite3 dump continuation 模块关键表（项目 / sources / settings / analysis_runs / style_profiles / snapshots / import_jobs）；CLI 友好。
- `scripts/qa/mock-openai-server.mjs` — 本地异常/慢响应/重试场景 mock OpenAI 兼容服务，日志自动脱敏。
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
