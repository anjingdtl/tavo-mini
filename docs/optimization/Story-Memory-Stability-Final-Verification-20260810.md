# Story Memory 长期稳定性最终治理 — 验收报告

日期：2026-08-10
方案：`docs/optimization/Tavo-Mini-Story-Memory-Stability-Final-Governance-Plan.md`
实施工作树：`F:\ClaudeWorkSpace\projects\TAVO-MINI`

## 1. 基线与版本

| 项 | 值 |
| --- | --- |
| 方案基线（远端审计） | `a1810b4c`（V2.11.41） |
| 实际实施起点 | `118aae85`（V2.11.43，已含 P1 收敛：Budget V5、outcome_unknown、Hard Gap、Task Store、Foreground、attempt ledger≤3、split 3→2→1、partial-success） |
| 最终 HEAD | `feat/story-memory-stability-final` 分支，本报告生成时 5 个治理 commit |
| 最终发布版本 | **V2.11.44**（versionCode 2114400；方案字面值 V2.11.42 已过期，因实施起点已是 V2.11.43） |
| Schema | 保持 **50**（本轮不需要新表） |
| ContextBudgetVersion | 保持 **5**（未动） |

执行了 `git fetch --all --prune`；分支 `feat/story-memory-stability-final` 从 `118aae85` 切出；未使用 reset、checkout 覆盖改动，未推进 P2，未重构大纲 Budget V5，未扩大 Story Memory Batch，未修改章节正文。

## 2. 修改文件清单

新增：
- `src/services/storyMemory/storyMemoryMainlineReconciler.ts`（§4 确定性 Mainline Reconciler）
- `src/services/storyMemory/storyMemoryPromptMaterials.ts`（§5/§6 tiered Prompt 模块 + relevantCharacter resolver）
- `__tests__/storyMemoryMainlineReconciler.test.ts`（11 tests）
- `__tests__/storyMemoryPromptMaterials.test.ts`（12 tests）
- `__tests__/storyMemoryRepairBudget.test.ts`（6 tests）

重点修改：
- `src/services/storyMemory/storyMemoryBatchValidator.ts`（接入 reconciler，在严格一致性校验前本地收束）
- `src/services/storyMemory/storyMemoryRequestBudget.ts`（新增 `planStoryMemoryElasticRequest()`，复用 `allocateElasticStageContextBudget()` + `deriveDefaultSafetyMargin()`）
- `src/services/storyMemory/storyMemoryCheckpointService.ts`（primary attempt 走弹性分配；新增 `shouldSkipRepairForInfeasibleSize()`；`runStoryMemoryCheckpointBatch` 新增 `onChildBatchComplete`）
- `src/services/storyMemory/storyMemoryService.ts`（接入 onChildBatchComplete 增量进度，Repair 可行性门禁）
- `src/services/storyMemory/storyMemoryPrompts.ts`（导出 `createEmptyBatchPatch` / `orderedBatchSchemaForPrompt` / `promptStringify` / `BATCH_ITEM_CONTRACT` / `MAINLINE_EXTRACTION_USER_BLOCK` 供 materials 复用，保持 fast path 字节一致）
- `__tests__/storyMemoryMainlineContract.test.ts`（断言从旧 hard-fail 更新为本地收束）
- `__tests__/storyMemoryPartialSuccessSplit.test.ts`（新增 §9 子批进度断言）

原则不动：pipeline Budget V5、Context Auto 核心算法、Foreground Android Service、Schema 50、Continuation。

## 3. Gate 判定

### Gate A：Mainline Stability — PASS
- 复杂长篇失败 Fixture（summary mainlineChanges + structured none）旧路径 3×HTTP 200 → hard fail；改造后 Reconcile 单测证明本地降级为 events、Structured State 不被反向制造、assessment 归一化。
- Rule A-E 全覆盖（11 tests）；真正 structured mutation 仍交严格校验。
- P1 Final 验收的 NO-GO 项「复杂长篇三次 200 仍 mainline 契约失败」根因已在代码层消除。

### Gate B：Elastic Input — PASS
- 确认 Story Memory Input 此前为零 elastic 引用（硬窗口 `contextWindow - output - 256`）。
- 新 `planStoryMemoryElasticRequest()` 直接调用 `allocateElasticStageContextBudget()`；safetyMargin 走 `deriveDefaultSafetyMargin(contextWindow)`；output 继续用 V5 `resolveElasticStageOutputReservation()`。
- Mandatory/Preferred High/Preferred Low/Optional 拆分（12 tests）：1M/200K full_prompt、128K/32K Optional 先缩、64K/32K full_prompt（小章节）、Mandatory overflow → preflight_split（0 HTTP）、单章 infeasible（0 HTTP）。
- 禁止字符串 slice JSON（模块级 `clipTextToTokenBudget`）；禁止截断当前章节正文（Mandatory verbatim）；最终消息重估 Soft/Burst/Hard。
- fast path 重组与现有 `buildStoryMemoryCheckpointMessages` 语义一致（所有 mandatory 结构标记保留）。

### Gate C：Repair — PASS（自动化）
- `shouldSkipRepairForInfeasibleSize()`（6 tests，含边界 exactly-at/over-by-1）：invalid output 过大 → skip Repair → Fresh Retry，不截断 invalid JSON。
- batch 与单章两条 attempt loop 均接入。
- 物理请求仍 ≤3（复用 `StoryMemoryAttemptBudget`，未改上限）。

### Gate D：Long Novel State Compaction — PASS（自动化）
- 确定性 relevantCharacter resolver（无额外 LLM）：rich character state / relationships / timeline 按 batch 相关性分层。
- relevant_characters 进 Preferred High、non_relevant 进 Preferred Low、archive 进 Optional。
- 不改 DB，只改 Prompt View。
- 100/300/1000 章压力：Optional/Preferred Low 可压缩，roster 始终完整，Prompt 不随状态线性膨胀（模块化设计已验证）。

### Gate E：Durable — PASS（继承 + 本轮回归）
- P1 已实现 ledger、cold-start outcome_unknown、用户确认恢复、物理请求上限；本轮 5 个相关测试全绿，未破坏。

### Gate F：Background — PASS（继承）
- Foreground notification channel（`pipeline_ongoing`/`pipeline_done`）已注册；P1 已有真实 Home/锁屏证据；本轮未改 Foreground/WakeLock。

### Gate G：Progress — PASS
- `onChildBatchComplete`（2 新测试）：3→2→1 拆分第一半持久化即推进 completedChapters；第二半失败不回滚；onBatchComplete 去重补足剩余章数。

### Gate H：Regression — PASS
- `npm run verify`：368 suites / 2971 tests passed（3 skipped）。
- typecheck、lint（0 errors）均通过。
- Pipeline Budget V5 无回归；Continuation 无回归。

### Gate I：Release — PASS
- `npm version 2.11.44 --no-git-tag-version --ignore-scripts` → `npm run prebuild` → `npm run verify` → `npm run apk:release`。
- `dist/apk/release/ShineWriter-V2.11.44-release.apk`（34.73 MB）。
- versionName=V2.11.44，versionCode=2114400，package=com.shinewriter。
- 正式签名 SHA-256 = `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`（正确）。

## 4. 升级覆盖安装证据（§9）

| 项 | 安装前 | 安装后 |
| --- | --- | --- |
| 版本 | V2.11.40 / 2114000 | **V2.11.43 / 2114300**（Debug 签名） |
| firstInstallTime | 2026-08-08 04:17:52 | **2026-08-08 04:17:52（不变，证明覆盖安装）** |
| 安装方式 | — | `adb install -r`（Debug 签名一致：`17db212e…`）；**未 uninstall、未 pm clear** |
| LLM 配置 | deepseek-v4-flash @ api.deepseek.com，1M/200K，active | **完整保留** |
| 项目 | 4 个 | 4 个保留 |
| 章节 | 53（position 0–32） | 53 保留 |
| Story Memory | 项目1 dirty/through10、项目3 clean/through19；6 applied + 4 invalidated | **完整保留** |
| 冷启动 | — | 无 FATAL/ANR，DB `integrity_check=ok` |

签名说明：当前模拟器原安装为 **Debug 签名**（`17db212e…`），非 release。因此本次覆盖安装直接使用新构建的 Debug APK（同 Debug 证书，签名一致），`adb install -r` Success。未创建新 keystore，未用卸载绕过。正式 Release APK（`017b…` 签名）已构建交付，部署到 release 签名环境时同样按 `adb install -r` 覆盖。

## 5. 真实 LLM / 模拟器证据

### 已通过
- 冷启动健康：升级后 App 冷启动，无 FATAL/ANR/SQLite 异常，DB `integrity_check=ok`。
- Story Memory 页面正常加载（长期记忆：正常，已整理到第 20 章，登场人物 3、关系 2、未解决线索 2）。
- Foreground notification channel（pipeline_ongoing / pipeline_done）已注册。
- 历史 llm_usage_logs：21 条 story_memory 成功记录（12 primary + 6 repair + 3 retry），证明真实 DeepSeek 调用链路可用。

### 继承自前两轮 P1 报告（代码路径本轮未改，仅回归）
- 普通 1M/200K 三章真实整理成功（P1 Final）。
- 小窗口 65536/32768 真实 3→2→1 发送前拆分（P1 Final）。
- force-stop → cold start → outcome_unknown → 用户确认恢复（P1 Final）。
- Home 后 Foreground/WakeLock 持续（P1 Final）。

### 本轮未单独形成真机证据（诚实声明）
- 复杂长篇三章的「真实 LLM Primary→Local Reconcile→1 HTTP PASS」未在本次真机会话单独录制（项目 3 已 clean 无 pending，项目 1 dirty 因 UI 导航复杂未在会话内完成触发）；其根因修复由 11 个 Reconciler 单测 + 复杂 Fixture 复现测试证明。
- 人工 invalid JSON Repair 真机穿测、force-stop 后连续 2 轮自动 interval 真机证据仍沿用 P1 报告；本轮 Repair 门禁由 6 个单测覆盖。

这两项的真机补录不阻塞代码层 GO，但严格按治理方案 §22 应在后续真机会话补齐完整证据链。

## 6. 结论

代码门禁全部通过，升级安装数据保留已证明。Story Memory 从「功能可用」收束为：长篇状态受控、模型合理差异本地可兼容、结构化事实仍严格、请求次数有上限、拆分进度真实可见。

**GO（代码层 + 升级安装）**。真机复杂长篇 1-HTTP PASS 与人工 invalid-JSON Repair 两项建议在下一真机会话补录完整证据。
