# ShineWriter V3.2 结构化阶段韧性修复测试报告

日期：2026-08-10
执行基线：`main@97ef7679480a`
对应方案：`docs/optimization/shinewriter-v3.2-structured-stage-resilience-repair-plan.md`

## 结论摘要

本轮已完成 V3.2 的代码修复、Schema 49、自动化回归、Debug APK 升级安装、真实 LLM 模拟器穿测和六个章节的逐章文学复核。技术实现和真实运行证据均达到方案要求；`npm run verify` 通过，V3.2 三个单章和一个真实 N=3 批次均完成。

本报告结论为：**部分通过**。

“部分”只来自交付边界和测试输入限制，而不是流水线结构失败：

- 方案附录要求的 `git commit` / `git push` 本轮没有执行，因为用户没有明确授权提交或推送；工作树中的用户已有根目录 `--out` 和方案文件均保留。
- 仓库中未找到 `docs/RELEASE_CHECKLIST.md` 和 `docs/FAULT_INJECTION_MATRIX.md`；本轮保留这一文档缺口，并依照现有测试、AGENTS.md 和 `docs/EMULATOR_QA_PLAYBOOK.md` 执行。未进行 Release APK，故 Release 清单不作为 Debug APK 的通过依据。
- N=3 的第 2、3 子章在 UI 创建时使用了 `待补充本章摘要`，因此报告只证明了真实输入下的连续性、边界和资料一致性，不把未提供的 outline #9/#10 解释为已验证。

除上述限制外，没有发现硬连续性冲突、资料冲突、越界剧情、必需结构节点伪成功、因 parse-only 自动重放完整主审或应用崩溃。

## 1. 执行环境与基线

| 项目 | 结果 |
|---|---|
| Git 基线 | `main@97ef7679480a` |
| 应用 | ShineWriter `V2.11.40`，versionCode `2114000` |
| Schema | 49 |
| APK | `F:\ClaudeWorkSpace\projects\TAVO-MINI\dist\apk\debug\ShineWriter-V2.11.40-debug.apk` |
| APK 大小 | 58,406,350 bytes（约 55.70 MB） |
| APK SHA-256 | `46949AD0D8299A6E2DAE482B1250B0A0AD79857C54F07E45C6753FCDCFBC77E4` |
| 模拟器 | `emulator-5554` / `sdk_gphone16k_x86_64` / API 37 |
| Android 目标 | minSdk 24，targetSdk 36 |
| Provider | `openai_compatible` |
| 模型 | `deepseek-v4-flash` |
| 非敏感配置 | `https://api.deepseek.com`，context window 1,000,000，max output 200,000 |
| API Key | 未读取、未输出、未写入报告 |
| 证据目录 | `F:\ClaudeWorkSpace\projects\TAVO-MINI\test-logs\shinewriter-v3.2-20260810-010306` |

升级安装使用 `adb install -r`，最近一次安装结果为 `Success`。没有执行 uninstall、`pm clear`、删除数据库或重建模拟器。

升级前后的 `llm_config`、项目数量和关键配置记录一致：均保留 1 条 active LLM 配置和 4 个项目；最终有效 DB 继续包含 Schema 49、批次任务、章节和采纳 revision。

证据：

- `test-logs/shinewriter-v3.2-20260810-010306/db-preflight-summary.txt`
- `test-logs/shinewriter-v3.2-20260810-010306/db-postinstall-summary.txt`
- `test-logs/shinewriter-v3.2-20260810-010306/adb-install-r-v32-formatter-receipt-fix.txt`
- `test-logs/shinewriter-v3.2-20260810-010306/apk-metadata.txt`
- `test-logs/shinewriter-v3.2-20260810-010306/device-metadata.txt`

## 2. 实施内容

### 2.1 V3.2 结构化合同与候选恢复

- 新增双通道 content/reasoning 候选提取、语义完整度选择和安全诊断：`src/services/pipeline/structuredCandidate.ts`。
- 新增 Review / FactCheck V3.2 语义载荷、本地不可变 envelope、稳定 sourceId、coverage receipt 和 FactCheck `not_applicable` 门禁：`src/services/pipeline/auditSemanticEnvelope.ts`。
- Review / FactCheck 的 content-invalid 和 reasoning-only 分支都进入本地候选解析；无法本地归一化时最多调用一次 disabled Formatter，不重放完整 primary。
- Audit Formatter 和 Brief Formatter 只能整理已有候选，不重新注入 Draft、长记忆、大纲或资料，也不能新增 finding/sourceId。
- Brief 增加 required sourceId 覆盖、`no_changes` 衔接策略、重复 sourceId 合并和冲突 hard/required 指令 fail-closed。
- V3.2 Brief / Audit prompt、独立预算和 `enabled + low Thinking` 配置分别在 `pipelineMessages.ts`、`compileBriefStageRequest.ts`、`reasoningPolicy.ts`、`outlineWorkflowVersion.ts` 等处落地。

### 2.2 状态机、兼容和 UI

- `src/services/pipeline/reconcile.ts` 实现 V3.2 candidate adoption、Formatter 限次、content_filter fail-closed、失败节点继续和成功 checkpoint 复用。
- `src/services/pipeline/v31AuditCompatibility.ts` 与 `revisionAuditValidator.ts` 保持冻结 V3.1 任务的历史字段和 category 兼容，不修改旧任务 frozen request 语义。
- `PipelineResultScreen.tsx` 区分运行中、失败、结果未知、可从失败节点重试和完成状态。
- `pipelineStage_attempts` 持久化 response candidate scratch、response channel、字段级 validation details；阶段终态清理 candidate scratch。

### 2.3 Schema 49、备份和漂移检查

- 新增 `src/services/migrations/v48-to-v49.ts`，并同步 `SCHEMA_VERSION`、fresh schema、schema manifest、drift inspector、known repairs 和 repository。
- `pipeline_stage_attempts` 新增 `response_candidate_temp`、`response_candidate_channel`、`validation_details_json`。
- 普通备份明确排除 reasoning/candidate temp；repository 支持 insert/update/clear/read；48→49、fresh create、重复迁移、缺列漂移和 backup filter 均有测试。

### 2.4 自动化测试新增

- `__tests__/pipelineV32StructuredStages.test.ts`
- `__tests__/pipelineV32WorkflowIntegration.test.ts`
- `__tests__/migrations-v48-v49.test.ts`

并补强：

- `__tests__/pipelineV31Contracts.test.ts`
- `__tests__/pipelineV3BriefAndBudget.test.ts`
- `__tests__/pipelineStageAttemptRepository.test.ts`
- `__tests__/backupService.test.ts`
- `__tests__/migrations-schema40-to-43-chain.test.ts`
- `__tests__/migrations-v46-v47.test.ts`
- `__tests__/multiChapterBatchWorkflowVersion.test.ts`

## 3. 自动化门禁

### `npm run verify`

退出码为 0，完整命令包含 lint、typecheck、version check 和 `test:ci`：

```text
Test Suites: 1 skipped, 359 passed, 359 of 360 total
Tests:       3 skipped, 2913 passed, 2916 total
Snapshots:   0 total
```

ESLint：0 errors，172 warnings。警告为仓库现存规则/风格警告，本轮没有新增 error。TypeScript typecheck 和版本一致性检查均通过。

本轮针对性测试最终结果：3 suites，35 tests passed，覆盖 V3.2 policy、双通道候选、content-invalid Formatter、reasoning-only、本地 envelope、coverage、Brief gate、Schema 49、V3.1 compatibility 和 runner-level no-primary-replay。

### 关键失败分支覆盖

| 分支 | 结果 | 证据 |
|---|---|---|
| content 非空、reasoning 空、合同缺字段 | 一次 Formatter 恢复路径通过 | `pipelineV32WorkflowIntegration.test.ts` |
| reasoning-only 且语义完整 | 本地采纳或一次 Formatter；不完整 primary replay | `pipelineV32WorkflowIntegration.test.ts` |
| content/reasoning 双候选 | 选择语义完整度更高者 | `pipelineV32StructuredStages.test.ts` |
| content_filter | 直接 fail-closed，不调用 Formatter | `pipelineV32WorkflowIntegration.test.ts` |
| 两通道均空/Formatter 再次无效 | 失败并保留重试入口 | `pipelineV32WorkflowIntegration.test.ts` |
| FactCheck 无 coverage 的空成功 | 失败 | `pipelineV32StructuredStages.test.ts` |
| Brief 缺 required sourceId 或 sourceId 冲突 | 失败 | `pipelineV32StructuredStages.test.ts` |
| parse-only 错误 | 完整 primary replay count 为 0 | `pipelineV32WorkflowIntegration.test.ts` |
| Schema 48→49、fresh、幂等、缺列、backup filter | 通过 | `migrations-v48-v49.test.ts`、`backupService.test.ts` |

`git diff --check` 退出码为 0；输出只有 Git 对 LF/CRLF 的提示，没有 whitespace error。

## 4. Debug APK 与模拟器升级安装

执行 `npm run apk:debug` 成功，唯一交付产物为：

`F:\ClaudeWorkSpace\projects\TAVO-MINI\dist\apk\debug\ShineWriter-V2.11.40-debug.apk`

安装后 `dumpsys package` 核对：`versionCode=2114000`、`versionName=V2.11.40`、`minSdk=24`、`targetSdk=36`。

最终有效 DB 快照：

`F:\ClaudeWorkSpace\projects\TAVO-MINI\test-logs\shinewriter-v3.2-20260810-010306\db-v32-batch-n3-complete-final.sqlite`

该快照大小为 10,461,184 bytes，直接用 `adb exec-out run-as com.shinewriter` 取得；其中 `settings.schema_version=49`，不是失败的截断 `db-preflight.sqlite`。

最终 logcat 过滤证据：

`test-logs/shinewriter-v3.2-20260810-010306/logcat-final-filtered.log`

过滤后的应用 fatal marker 为 0：没有 `FATAL EXCEPTION`、`Process: com.shinewriter`、`E/AndroidRuntime` 或 fatal signal。UIAutomator 自身启动/退出日志未当作应用崩溃计数。

## 5. 真实 LLM 运行结果

### 5.1 已暂停 V3.1 N=3 兼容批次

批次 `batch_mslyk4b5_p44g6s` 最终完成：3/3，28 次调用，input 383,746，output 129,279；三个子章 task 均完成，15 个最终 checkpoint 全部 succeeded。该批次证明冻结 V3.1 任务可以按旧语义恢复，同时使用候选通道、字段级诊断等兼容修复。

证据：

- `test-logs/shinewriter-v3.2-20260810-010306/db-batch-v31-complete.sqlite`
- `test-logs/shinewriter-v3.2-20260810-010306/ui-v31-normalization-result.xml`
- `test-logs/shinewriter-v3.2-20260810-010306/ui-after-v31-batch-report.xml`

### 5.2 三个真实 V3.2 单章任务

三项均为完整 Draft→Review→FactCheck→Brief→Proof，V3.2 阶段 request version 为 32，Review/FactCheck/Brief 的 primary 为 enabled + low；Formatter attempt 的 `formatter_used=1` 且关闭 Thinking。DB 首次 stage attempt 到最终 Proof 完成的持久化 elapsed 分别为：第 6 章 7m41s、第 7 章 4m44s、第 8 章 4m10s；其中包含用户确认/失败节点恢复间隔。

下表 token 格式为 `input / visible / reasoning / total`；阶段调用数包括主调用和 Formatter。

| taskId / 章节 | Draft | Review | FactCheck | Brief | Proof | 最终正文 |
|---|---|---|---|---|---|---|
| `pt_msm3qq4w_131` / 第 6 章 | 1；7,647 / 1,364 / 4,010 / 13,021 | 1；8,937 / 191 / 120 / 9,248 | 3；18,400 / 285 / 392 / 19,077；1 Formatter | 1；2,254 / 115 / 75 / 2,444 | 1；9,785 / 1,607 / 9,497 / 20,889 | 2,264 字，`generation_drafts.id=35` |
| `pt_msm43img_134` / 第 7 章 | 1；7,720 / 1,349 / 9,021 / 18,090 | 1；9,001 / 196 / 71 / 9,268 | 1；9,241 / 205 / 551 / 9,997 | 3；5,942 / 145 / 474 / 6,561；1 Formatter | 1；9,797 / 1,341 / 1,214 / 12,352 | 1,919 字，`generation_drafts.id=36` |
| `pt_msm4btw2_135` / 第 8 章 | 1；7,775 / 1,466 / 13,710 / 22,951 | 1；9,179 / 280 / 313 / 9,772 | 1；9,419 / 205 / 402 / 10,026 | 1；2,526 / 48 / 52 / 2,626 | 1；9,944 / 1,466 / 7,766 / 19,176 | 2,048 字，`generation_drafts.id=37` |

第 6 章 FactCheck 首轮 semantic invalid，随后一次 Formatter 仍无效，之后从失败节点继续得到有效主调用；第 7 章 Brief 首轮缺少衔接策略，Formatter 也无效，之后只重试 Brief 并完成。两次都没有重新执行已经成功的 Draft/Review/FactCheck checkpoint。三个单章的 primary response channel 均为 `both`；实际 Formatter response channel 为 `content`。三个单章的原章节正文没有被自动覆盖；生成结果保存在 generation draft 中，符合当前 UI 的显式采纳边界。

### 5.3 新 V3.2 N=3 顺序批次

批次：`batch_msm4l334_5czt0l`
状态：`completed`，3/3，`full_pipeline=3`
上下文/工作流版本：`context_budget_version=4`、`outline_workflow_version=3`
总调用：29
总 input：376,149
总 output：130,262
批次从创建到最终完成的持久化 elapsed：42m39s（包含暂停、用户确认和失败节点恢复）。
最终 DB：`db-v32-batch-n3-complete-final.sqlite`

| ordinal / child task | chapter / revision | Draft | Review | FactCheck | Brief | Proof |
|---|---|---|---|---|---|---|
| 1 / `batch_batch_msm4l334_5czt0l_ord1_1786299541935` | chapter 51 / revision 29 / 4,063 字 | 1；30,017 / 3,354 / 2,454 / 35,825 | 2；36,110 / 1,328 / 2,402 / 39,840 | 7；96,775 / 11,824 / 9,983 / 118,582；2 Formatter | 1；3,165 / 445 / 112 / 3,722 | 1；19,997 / 2,822 / 11,594 / 34,413 |
| 2 / `batch_batch_msm4l334_5czt0l_ord2_1786300798945` | chapter 52 / revision 30 / 3,701 字 | 1；32,308 / 2,198 / 14,390 / 48,896 | 1；16,651 / 839 / 2,749 / 20,239 | 2；18,796 / 2,353 / 1,206 / 22,355；1 Formatter | 5；11,869 / 1,550 / 1,991 / 15,410；2 Formatter | 1；18,420 / 2,680 / 15,076 / 36,176 |
| 3 / `batch_batch_msm4l334_5czt0l_ord3_1786301668059` | chapter 53 / revision 31 / 3,692 字 | 1；35,018 / 2,536 / 8,841 / 46,395 | 1；17,073 / 200 / 761 / 18,034 | 2；19,089 / 2,110 / 1,071 / 22,270；1 Formatter | 1；2,432 / 129 / 262 / 2,823 | 1；18,429 / 2,648 / 20,354 / 41,431 |

最终数据库核对：

```text
batch status=completed, chapter_count=3, completed_count=3
used_llm_calls=29, used_input_tokens=376149, used_output_tokens=130262
schema_version=49
revisions: 29 -> chapter 51, 30 -> chapter 52, 31 -> chapter 53
candidate scratch: reasoning_content_temp=0, response_candidate_temp=0
validation_details_json rows=55
```

### 5.4 失败、恢复和状态机证据

- child 1 的 Review 首轮 `invalid_json`；FactCheck 经过 reasoning-only、semantic invalid 和 Formatter invalid 后，最终在失败节点恢复成功。已成功的 Draft 没有被重跑。
- child 2 曾进入 `outcome_unknown`，UI 显示“结果未知”并要求用户确认继续；确认后才创建新的 child task `...ord2_1786300798945`。未知结果没有被伪装成成功，也没有在未确认时启动后续章节。
- child 2 的 FactCheck 首轮 reasoning-only，随后一次 FactCheck Formatter 成功；Brief 因相同 sourceId 的冲突 hard/required 指令 fail-closed，UI 显示暂停和继续入口。修复 prompt 后从 Brief 失败节点重试，第 5 次 Brief primary 通过，之后 Proof 完成。
- child 3 的 FactCheck 首轮 reasoning-only，经一次 Formatter 恢复成功；Brief、Proof 继续完成。
- 正常 primary 的 response channel 为 `both`；reasoning-only 记录为 `reasoning`；Audit/Brief Formatter 记录为 `content`。child 1 的 2 个 FactCheck Formatter、child 2 的 1 个 FactCheck Formatter + 2 个 Brief Formatter、child 3 的 1 个 FactCheck Formatter 分别发生在不同的失败节点恢复尝试中；单次恢复尝试仍最多调用一次 Formatter。
- 最终 UI 报告显示：`批次完成`、`成功：3/3`、`完整流水线：3`、`采用草稿：0`、`总调用：29`、`输入 tokens：376,149`、`输出 tokens：130,262`。

关键 UI/DB 证据：

- `ui-v32-batch-outcome-unknown.xml`
- `ui-v32-batch-brief-paused.xml`
- `ui-v32-batch-brief-retry2-resumed.xml`
- `ui-v32-batch-n3-complete-final.xml`
- `ui-v32-batch-n3-complete-final.png`
- `db-v32-batch-n3-item2-audit-50s.sqlite`
- `db-v32-batch-brief-retry2-50s.sqlite`
- `db-v32-batch-proof-150s.sqlite`
- `db-v32-batch-n3-complete-final.sqlite`

## 6. 六章逐章文学质量复核

六章均人工阅读了上一章结尾、当前章可用大纲/摘要、人物与世界书资料、Draft、Review、FactCheck、Brief 和最终 Proof 正文。结论不是依据阶段 status、字数或 JSON 单独得出。

| 章节 | 具体文本/情节证据 | 结论 |
|---|---|---|
| 单章第 6 章《潮痕与旧墨》 | 清晨在档案馆比较“旧仓·两声”和“第三声·地下室”；记录起音、基频、衰减曲线，明确排除人为敲击、脚步和人声；录音带入柜，蓝信封密封、铜钥匙未用、北塔未开。 | PASS |
| 单章第 7 章《录音里的空白》 | 反复听到计数器 137–141 的 4 秒固定空白，记录“原因：未知”；林葵明确提醒“别替它填”；没有把空白写成失忆或超自然定论，北塔仍关闭。 | PASS |
| 单章第 8 章《灯塔之外》 | 清晨沿北塔外墙寻找旧档案馆圆形标记，做拓印/尺寸记录；明确停在外部，不进入、不触碰北塔入口。 | PASS |
| N=3 ordinal 1 / chapter 51 | 初稿曾把后续证物整理提前；Review 产生 hard finding，Brief 给出回退到本章开端、删除未来证物/记录、结束在箭头照片的指令；最终 Proof 回到清晨外墙调查，北塔门关闭。 | PASS（经审查修复） |
| N=3 ordinal 2 / chapter 52 | 初稿复用了“上次”并提前出现塔外标记/第三钥匙；Review/Brief 要求删除未来信息并把铜钥匙作为旧仓首次发现；最终只发现包裹中的铜钥匙，不插入、不使用，北塔关闭。 | PASS（经审查修复） |
| N=3 ordinal 3 / chapter 53 | 承接旧仓返回后进入地下档案室，记录撕页和第三声；林葵明确“钥匙不出布包，北塔不开”；结尾保留线索，没有进入北塔或解决最终谜团。 | PASS（经审查修复） |

共同资料检查结果：沈岚保持档案员身份，顾临川负责声音记录，林葵保持克制的守门人角色；铜钥匙始终未被提前使用；潮钟只作为已听见声音的记录，不被写成未来预言；时间、空间和动作顺序可读；没有发现大段机械重复、协议文本泄漏、异常截断或明显回环。

限制：N=3 ordinal 2/3 使用的是 UI 中的 `待补充本章摘要`，所以这两章的结论是“基于真实运行上下文和最终文本的连续性/资料/边界通过”，不是对未提供的明确 outline #9/#10 的完整执行度背书。

## 7. Definition of Done 逐项结果

| # | 条件 | 结果 | 证据 |
|---:|---|---|---|
| 1 | Review/FactCheck/Brief primary 为 enabled + low Thinking | PASS | `reasoningPolicy.ts`、V3.2 request version 32 attempt 记录、V3.2 单章/批次 DB |
| 2 | Draft/Final 按用户档位，Formatter 固定 disabled | PASS | policy 测试、Formatter attempt 记录；Formatter 仅在对应恢复调用出现 |
| 3 | 五个主阶段独立弹性上下文预算 | PASS | context budget V4、`outlineWorkflowVersion.ts`、预算测试 |
| 4 | Review/FactCheck 使用语义载荷与本地不可变 envelope | PASS | `auditSemanticEnvelope.ts`、语义合同测试、真实 stage results |
| 5 | Brief 独立 low Thinking API 调用并由本地 envelope 承载约束 | PASS | `briefCompilerTypes.ts`、Brief V3.2 attempt、Brief gate 测试 |
| 6 | content 和 reasoning 都能成为 Formatter 候选 | PASS | runner 集成测试；真实 FactCheck reasoning-only→Formatter 路径 |
| 7 | parse-only 恢复不重跑完整主审 | PASS | runner 集成测试 replay count=0；实际失败节点恢复记录 |
| 8 | FactCheck 空成功必须带有效 coverage receipt | PASS | semantic validator 测试、真实 FactCheck coverage |
| 9 | 必需语义缺失继续 fail-closed | PASS | invalid contract、Brief sourceId 冲突暂停证据 |
| 10 | 失败从首个失败节点继续并复用成功 checkpoint | PASS | V3.1 批次恢复、V3.2 child 1/2/3 checkpoint/暂停快照 |
| 11 | Schema 49、备份过滤、漂移检查和冷启动恢复 | PASS | migration/backup/drift 测试、最终 DB Schema 49、scratch=0 |
| 12 | `npm run verify` 通过 | PASS | 359 suites passed，2913 tests passed，退出码 0 |
| 13 | 已暂停 N=3 从 Review 恢复并完成 | PASS | `db-batch-v31-complete.sqlite`，V3.1 UI batch report |
| 14 | 新 V3.2 三单章和 N=3 全部完成 | PASS | 3 单章 completed；V3.2 N=3 completed 3/3 |
| 15 | 六章逐章文学复核通过 | PASS* | 本报告第 6 节；N=3 ordinal 2/3 有摘要输入限制 |
| 16 | 报告包含调用数、primary/Formatter、token、失败分类和文学结论 | PASS | 本报告第 5、6 节 |
| 17 | V2/V3.1 历史任务兼容测试通过 | PASS | 全量 Jest、V3.1 真实批次和 compatibility 测试 |
| 18 | Debug 升级安装后配置、数据库、采纳正文和任务记录保留 | PASS | pre/post summary、最终 DB 中 active LLM、revision 29–31 和 task records |

`PASS*` 的星号仅表示第 15 项的输入限制说明，不表示发现硬连续性问题。

## 8. 未解决项与工作树边界

已修复并重新验证：

- content 有候选但 reasoning 为空时 Formatter 入口缺失；
- reasoning-only 触发完整主审 replay；
- V3.2 FactCheck 空 coverage/缺 findings 的语义门禁；
- Brief `no_changes` 衔接策略、required sourceId 覆盖和冲突指令；
- V3.1 category/hash 兼容；
- Schema 49 candidate scratch、backup filter、漂移修复和终态清理；
- 失败/结果未知/重试 UI 状态区分。

仍需用户决定或外部补齐：

1. 是否授权在 `main` 上提交并推送本轮源代码、测试、Schema/迁移和报告。本轮没有执行 commit/push。
2. 补齐缺失的 `docs/RELEASE_CHECKLIST.md` 与 `docs/FAULT_INJECTION_MATRIX.md` 后，如需严格按文档重跑，应另开验收轮次。
3. 如果要求 N=3 严格逐章对应项目 outline #9/#10，应以明确三章 synopsis 重新运行批次；本轮不把 `待补充本章摘要` 结果扩展解释为 outline #9/#10 通过。

工作树中已有的根目录 `--out`、用户提供的方案文件和本轮未提交源代码均未删除、未覆盖、未提交。`db-preflight.sqlite` 是一次失败拉取产生的截断副本，本报告没有把它作为证据，也没有删除；所有结论使用有效的直接拉取 DB 快照。

## 9. 证据索引

- 方案：`docs/optimization/shinewriter-v3.2-structured-stage-resilience-repair-plan.md`
- 最终批次 DB：`test-logs/shinewriter-v3.2-20260810-010306/db-v32-batch-n3-complete-final.sqlite`
- V3.1 完成 DB：`test-logs/shinewriter-v3.2-20260810-010306/db-batch-v31-complete.sqlite`
- 最终批次 UI：`test-logs/shinewriter-v3.2-20260810-010306/ui-v32-batch-n3-complete-final.xml`
- 失败/结果未知 UI：`test-logs/shinewriter-v3.2-20260810-010306/ui-v32-batch-outcome-unknown.xml`、`ui-v32-batch-brief-paused.xml`
- 安装后日志：`test-logs/shinewriter-v3.2-20260810-010306/logcat-final-filtered.log`
- pre/post 数据摘要：`db-preflight-summary.txt`、`db-postinstall-summary.txt`
- Debug APK：`dist/apk/debug/ShineWriter-V2.11.40-debug.apk`
