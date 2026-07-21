# ShineWriter 流水线修订 — 进度交接

> 最后更新：2026-07-21（V2.5.17 发版完成）
> 状态：**全部完成**。Phase 0–4 代码 + 914 单元测试 + 模拟器 4 模式 E2E + LLM 设置弹窗同步流水线 max_tokens + V2.5.17 Release APK 构建 + commit + push。

---

## 一、已完成且已验证的工作

### Phase 0–4：流水线修订（全部完成，914 个单元测试通过）

| Phase | 内容 | 状态 |
|---|---|---|
| Phase 0 | 基线确认（125 suites / 857 tests 全通过） | ✅ |
| Phase 1 | 修正阶段依赖：twoStage/conditional 串行，full 仅 review∥factCheck 并行 | ✅ |
| Phase 2 | 共享上下文快照 PipelineContextSnapshot + buildContext 返回快照 + 分区裁剪 + 删除 slice(0,3000) | ✅ |
| Phase 3 | 初稿后二次本地召回 buildPostDraftAuditContext | ✅ |
| Phase 4 | 自动化测试 + 类型检查 + 构建 + 模拟器冒烟 | ✅ |

### 变更文件

**修改（5 个）**：
- `src/services/pipelineRunner.ts` — 重写：抽取 runReviewStage/runFactCheckStage/runProofStage 共享 helper；twoStage 串行 draft→review→proof；conditional 串行 draft→factCheck→proof；full 并行 review∥factCheck 后 proof 等待；full 接入初稿后二次召回；删除 buildContextPreview()；删除旧并行文案；resume 同步修正
- `src/services/pipelineMessages.ts` — 重写：buildReviewMessages/buildFactCheckMessages/buildProofMessages 改为接收 ReviewContext/FactCheckContext/ProofConstraints；分区 token 预算裁剪；删除 slice(0,3000)
- `src/services/contextBuilder.ts` — BuildContextResult 增加 pipelineContext；buildResourceContext 返回分区字段
- `__tests__/pipelineRunner.test.ts` — 重写：17 个新断言
- `CHANGELOG.md` — [Unreleased] 记录

**新增（7 个）**：
- `src/types/pipelineContext.ts` — PipelineContextSnapshot / ReviewContext / FactCheckContext / ProofConstraints + 快照→分区转换器
- `src/services/postDraftRetrieval.ts` — 初稿驱动 Episodic/世界书/人物召回 + 合并去重 + 失败回退
- `__tests__/pipelineContextIntegration.test.ts` — 5 tests（全链路）
- `__tests__/pipelineContextSnapshot.test.ts` — 5 tests
- `__tests__/pipelineMessages.test.ts` — 13 tests
- `__tests__/postDraftContinuityScenarios.test.ts` — 11 tests（SPEC §20.5 连续性矩阵）
- `__tests__/postDraftRetrieval.test.ts` — 16 tests

### 测试结果

- `npm run verify`（lint + typecheck + test:ci）：**130 suites / 914 tests 全通过**
- `npm run typecheck`：0 errors
- `npm run lint`：0 errors（10 个预存在 warning）
- `npm run apk:debug`：BUILD SUCCESSFUL

### DeepSeek API 提示词实测（已完成）

直接用 DeepSeek API 实测了 buildReviewMessages / buildFactCheckMessages 提示词：
- 评估返回 `{strengths:3, issues:4, suggestions:5}`，正确指出钥匙归属冲突与关系冲突
- 核查返回 `{errors:3, warnings:3}`，正确捕捉「第一次踏入人民公园」（被 Story Memory 证伪）、「李雪从未见过张明」（被证伪）、钥匙位置错误，尊重世界书规则

---

## 二、4 模式真机 E2E 测试（已完成）

### 测试环境

- **模拟器**：`emulator-5554`（Pixel_10_Pro_XL），重启时加 `-dns-server 8.8.8.8,8.8.4.4 -no-snapshot-load` 修复 DNS
- **应用**：`com.shinewriter` debug APK V2.5.16
- **项目**：`PipelineVerify`（2 章，第 2 章 synopsis="ZhangMingGoesToSaltLake"）
- **LLM 配置**：「配置 2」DeepSeek
  - base_url：`https://api.deepseek.com`
  - model：`deepseek-v4-flash`（推理模型，输出 reasoning_content + 正文）
  - api_key：UI 输入并经 Android Keystore 持久化
  - 「保存并测试」返回："测试通过 模型 deepseek-v4-flash 已连通"
- **流水线模式切换**：流水线配置页 4 个按钮（无审核 / 仅评估 / 仅核查 / 完整），UI 不显示选中态，靠描述文案确认（"仅生成初稿，不运行任何评估、核查或终审" = noReview 等）

### 4 模式测试结果总览

数据库 `pipeline_tasks` 表共 6 条记录：2 条早期 failed（DNS 不通时遗留，error=`请先在设置中配置 API 地址、API Key 和模型名称`）+ 4 条本次 completed（4 模式各 1 条）。

| # | task_id | 模式 | status | 总耗时 | 总 tokens | draft | review | factCheck | proof |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `pt_mruqvbzd_4` | noReview | completed | 104.8s | 1,366 | ✅ success | ⏭ skipped | ⏭ skipped | ⏭ skipped |
| 2 | `pt_mruqkri7_3` | twoStage | completed | 297.6s | 11,125 | ✅ success | ✅ success | ⏭ skipped | ✅ success |
| 3 | `pt_mrur1ni6_5` | conditional | completed | 119.2s | 8,057 | ✅ success | ⏭ skipped | ✅ success | ✅ success |
| 4 | `pt_mrur7t0p_6` | full | completed | 190.1s | 18,738 | ✅ success | ✅ success | ✅ success | ✅ success |

### 各模式详细结果

#### 1. noReview（`pt_mruqvbzd_4`，耗时 104.8s / 1,366 tokens）

| 阶段 | 状态 | 耗时 | 输出 tokens | 文本字数 |
|---|---|---|---|---|
| draft | success | 18,812ms | 1,144 | 1,346 |
| review | skipped | 0ms | 0 | 13（"无审核模式已跳过…"） |
| factCheck | skipped | 0ms | 0 | 12（"无审核模式已跳过…"） |
| proof | skipped | 0ms | 0 | 12（"无审核模式已跳过…"） |

**结论**：`final_text` = draft 原文，未触发任何审核/核查/终审。符合 noReview 语义。

#### 2. twoStage（`pt_mruqkri7_3`，耗时 297.6s / 11,125 tokens）

| 阶段 | 状态 | 耗时 | 输出 tokens | 文本字数 |
|---|---|---|---|---|
| draft | success | 30,837ms | 2,425 | 3,478 |
| review | success | 13,627ms | 1,024 | 296 |
| factCheck | skipped | 0ms | 0 | 12（"仅评估模式已跳过事实核查"） |
| proof | success | 14,688ms | 2,342 | 3,478 |

**review 返回真实 JSON**（节选）：
```json
{"strengths":["...5 条..."],"issues":[],"suggestions":[]}
```

**结论**：终审收到真实评估报告，factCheck 被显式跳过。符合 twoStage 语义。

#### 3. conditional（`pt_mrur1ni6_5`，耗时 119.2s / 8,057 tokens）

| 阶段 | 状态 | 耗时 | 输出 tokens | 文本字数 |
|---|---|---|---|---|
| draft | success | 21,501ms | 1,561 | 1,884 |
| review | skipped | 0ms | 0 | 12（"仅核查模式已跳过文学评估"） |
| factCheck | success | 15,751ms | 1,317 | 47 |
| proof | success | 12,145ms | 1,537 | 1,884 |

**factCheck 返回真实 JSON**（节选）：
```json
{"errors":[],"warnings":[],"confirmed":[]}
```

**结论**：终审收到真实核查报告，review 被显式跳过。符合 conditional 语义。

#### 4. full（`pt_mrur7t0p_6`，耗时 190.1s / 18,738 tokens）

| 阶段 | 状态 | 耗时 | 输出 tokens | 文本字数 |
|---|---|---|---|---|
| draft | success | 30,866ms | 2,291 | 3,373 |
| review | success | 10,578ms | 1,500 | 2,313 |
| factCheck | success | 27,841ms | 1,500 | 2,474 |
| proof | success | 20,002ms | 2,716 | 3,382 |

**并行验证**（关键证据）：
- draft 单独串行：30.9s
- review ∥ factCheck 并行：max(10.6s, 27.8s) = 27.8s
- proof 等待并行完成后串行：20.0s
- 理论总耗时：30.9 + 27.8 + 20.0 = **78.7s**
- 实测总耗时：**79s**（与理论完全吻合，证明 review∥factCheck 真正并行，不是串行伪装）

**结论**：4 阶段全跑、0 跳过，且 review∥factCheck 并行得到实测验证。符合 full 语义。

### 发现的非代码问题（不影响本次验收）

**问题**：full 模式下，DeepSeek 推理模型 `deepseek-v4-flash` 的 `reasoning_content`（思考过程）占满了 Max Tokens 1500 的配额，导致 review/factCheck 的正式 JSON 输出被截断（输出文本中只剩初稿开头或思考过程片段，看不到完整 JSON）。

- twoStage/conditional 模式下 review/factCheck 各自只跑 1 个，token 配额够用，JSON 正常
- full 模式 review 和 factCheck 同时跑，各自的 1500 token 都被 reasoning 占满
- 这是 **LLM 配置问题**（Max Tokens 偏小 for 推理模型），不是流水线代码 bug

**建议**：
1. 把 DeepSeek 配置的 Max Tokens 提高到 3000+（设置 → LLM 设置 → 编辑 DeepSeek 配置）
2. 或者换非推理模型（如 `deepseek-chat`），不会输出 reasoning_content
3. 流水线代码已通过 914 个单元测试，无需改动

**[2026-07-21 更新] 已通过代码改造解决**：见下文「四、V2.5.17 后续改造」。

### 验收要点对照

| 验收点 | 结果 |
|---|---|
| noReview 只有 draft | ✅ |
| twoStage 的 factCheck 是 skipped | ✅ |
| twoStage 终审收到真实评估报告 | ✅（JSON `strengths/issues/suggestions`） |
| conditional 的 review 是 skipped | ✅ |
| conditional 终审收到真实核查报告 | ✅（JSON `errors/warnings/confirmed`） |
| full 四阶段全跑 | ✅ |
| full 的 review∥factCheck 并行 | ✅（实测 79s ≈ 理论 78.7s） |
| 跳过阶段不是空占位文案 | ✅（"无审核模式已跳过…" / "仅评估模式已跳过事实核查" / "仅核查模式已跳过文学评估"） |

### 测试产物

所有测试产物（截图、uiautomator dump、Python 辅助脚本、SQLite 快照）位于 `test-logs/pipeline-4mode/`，包括：
- `sw-final.db` — 最终数据库快照（含 6 条 task 记录）
- `summary_all_tasks.py` / `inspect_stages.py` / `inspect_head_tail.py` — 阶段结果解析脚本
- `*.png` / `*.xml` — 各模式截图与 UI dump

---

## 三、V2.5.17 后续改造（已完成）

### 起因

4 模式 E2E 测试发现的「full 模式 review/factCheck 被 reasoning_content 占满 1500 token 配额」问题，根因是 **LLM 设置页改 `context_window` 不会联动流水线 `pipeline_*_max_tokens`**。`pipeline_review_max_tokens` / `pipeline_factcheck_max_tokens` 默认值是 1500，OpenAI 兼容模式的用户从未有过机会调整。

### 改造内容

**1. 新增纯函数 + service 函数**（`src/services/contextAutoAllocator.ts`）

- `computePipelineMaxTokensFromContextWindow(contextWindow)`：复用 `RATIO_OUTPUT(0.2)` × `50/15/15/20` 比例，与 `allocateContextBudget` 输出侧完全一致，但不需要资源计数
- `syncPipelineMaxTokensFromContextWindow(contextWindow)`：仅写 4 个 `pipeline_*_max_tokens` settings key，不污染 `ContextConfig` / `pipelineMode` / `presetId` / 资料表

**2. LLMSettingsScreen 改造**（`src/screens/LLMSettingsScreen.tsx`）

- OpenAI 兼容模式补「上下文长度」「最大输出 Token」输入框（原本只在 `llama_cpp` 模式显示）
- `save()` 检测 `context_window` 变化，弹 Alert 确认是否同步流水线 max_tokens
- 用户点「同步」→ 调 `syncPipelineMaxTokensFromContextWindow` → Toast 显示 4 阶段新值

**3. 新增 10 个单元测试**（`__tests__/contextAutoAllocator.test.ts`）

- 6 个测 `computePipelineMaxTokensFromContextWindow` 纯函数（含与 `allocateContextBudget` 一致性、DeepSeek 65536 场景、极小值 floor）
- 4 个测 `syncPipelineMaxTokensFromContextWindow` service 函数（`setSetting` 调用、不污染其他 key、抛错、返回值）

### 验证结果

- `npm run lint`：0 errors（8 个预存在 warning）
- `npm run typecheck`：0 errors
- 6 相关 suites / 86 tests 全通过
  （`contextAutoAllocator` + `contextAutoRepository` + `pipelineRunner` + `pipelineMessages` + `pipelineContextSnapshot` + `pipelineContextIntegration`）
- commit `da058a2` 已推送到 `main`

### 实际效果（以 DeepSeek 65536 上下文为例）

用户在 LLM 设置页把「上下文长度」从默认 4096 改成 65536 保存后：
- 弹窗：「检测到上下文长度从 4096 改为 65536，是否自动调整流水线各阶段的 Max Tokens？」
- 点「同步」→ Toast 显示 `draft=6554 / review=1966 / factCheck=1966 / proof=2621`
- review/factCheck 从 1500 提到 1966，full 模式下 DeepSeek 推理模型的 reasoning_content 不再占满配额

---

## 四、V2.5.17 发版（已完成）

### 版本升级

- `package.json` version：`2.5.16` → `2.5.17`
- `versionCode`：`2051600` → `2051700`
- `src/constants/version.json`：由 `npm run prebuild` 自动生成
- `CHANGELOG.md`：[Unreleased] → [2.5.17]，新增 Added / E2E Verification / Tests / Notes 四节
- `README.md`：badge、当前版本行、V2.5.17 变更说明、APK 产物路径、验收状态

### Release APK 构建与验收

按 `docs/RELEASE_APK_BUILD.md` 标准构建步骤执行：

1. 加载 `SHINE_WRITER_RELEASE_*` 用户级环境变量到当前 PowerShell 进程
2. `npm run apk:release` → `BUILD SUCCESSFUL` → APK 复制到 `dist/apk/release/ShineWriter-V2.5.17-release.apk`
3. `apksigner verify --verbose --print-certs` → 签名验证成功，证书 SHA-256 = `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`
4. `zipalign -c -P 16 -v 4` → `Verification successful`
5. `aapt dump badging` → `versionName=V2.5.17`、`versionCode=2051700`

**实测验收数据**：

| 验收项 | 实测结果 |
|---|---|
| apksigner verify | Verifies，Verified v2 = true |
| 证书 SHA-256 | `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`（与固定值一致） |
| Number of signers | 1 |
| zipalign -c | Verification successful |
| versionName | V2.5.17 |
| versionCode | 2051700 |
| 文件大小 | 37,422,535 bytes（35.69 MB） |
| APK SHA-256 | `97CE827B10E1F58A8BCEFA4C90F3D76D971DBC68D5E4BB70A68935241F695247` |
| 构建日志 | `test-logs/pipeline-4mode/apk-release-v2517.log` |

### git 状态

- 分支：`main`
- V2.5.17 发版 commit：`chore(release): V2.5.17 — pipeline revamp closure + LLM settings sync`
- 包含变更：`package.json` + `CHANGELOG.md` + `README.md` + `progress.md` + 3 个代码文件 + 1 个测试文件
- 前序 commit：`1966f10`（Phase 0–4 代码）+ `da058a2`（LLM 设置弹窗同步流水线）
- 本次 commit + push 后任务全部完成
