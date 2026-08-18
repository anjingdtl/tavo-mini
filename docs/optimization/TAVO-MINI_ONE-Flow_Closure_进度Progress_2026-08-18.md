# TAVO-MINI ONE-Flow Closure 最终封板 —— 进度 Progress

- 日期：2026-08-18（暂停）→ **2026-08-19 凌晨完成收尾**
- 性质：Closure PDCA / 最终封板收尾（方案：`TAVO-MINI_ONE-Flow_收尾建设与最终封板方案_V1.0.md`）
- 状态：**✅ 全部完成**（真实 LLM 穿测 6/6，Full Regression 全绿，封板报告见 `TAVO-MINI_ONE-Flow_Closure_最终封板报告_2026-08-19.md`）
- 接手补记（2026-08-19）：GROK 中途接手追加 `b53c4bd1`/`a49e0d0f`/`3244bef8` 三个 commit；本轮接回后处理模拟器 DNS 故障（重启恢复）、发现并修复 `retry-all` 的 UPDATE-LIMIT 生产 bug（`01cbaf6`），完成穿测 B 2/2 与 C-2 1/1。

## 一、基线与提交记录

| 项 | 值 |
|---|---|
| baselineHead | `ca00918c2a773db606238f7488d8006b3439d5a8`（与方案一致，远端无更新） |
| 当前 HEAD | `fdf17c62` |
| version | 2.11.53（versionCode 2115300） |
| Node / JDK | v24.14.1 / Temurin 17.0.19 |
| 设备 | emulator-5554（Medium_Phone，2GB RAM，x86_64，API 37.1） |
| LLM | deepseek-v4-flash（key 在 Android Keystore keychain，DB 中 api_key 为空是设计） |

已提交 commit（均在本地 main，**未 push**）：

1. `091e60a8` fix(writing): scope continuation ready gate to relevant outbox failures（P0-1/2/3 + 3 个 closure 测试套件 + 方案文档入库）
2. `fdf17c62` fix(continuation): keep run reads under the low-RAM CursorWindow limit（穿测中发现的生产 bug 修复）

**工作区未提交修改（2 个文件）**：
- `.github/workflows/generation-stability.yml` —— 已加入 3 个 Closure Gates 测试文件（`writingOneFlowClosureOutbox / PendingReplay / ReadyGate`），ciConfiguration 测试已验证绿。**遗漏未随 091e60a8 提交**，需下次提交。
- `src/services/continuation/generation/continuationStateOutboxWorker.ts` —— 冷启动复位 outbox 僵尸 `running` 行（`coldStartNormalizeContinuation` 内加一条 `UPDATE ... WHERE state='running' → 'interrupted'`）。typecheck + worker/phase3 测试（70 passed）已绿，Full Jest 未重跑。**需提交**。

## 二、P0 修复完成情况（全部完成）

### P0-1 outbox 历史失败污染 Batch Ready Gate ✅
- Root Cause：`continuationBatchStateGate.ts` 第 4 步用项目级 `getOutboxSummary().failedCount > 0` 全局阻断 —— 任何历史失败永久阻断未来 Batch。
- Minimal Fix：新增相关性分类器（纯函数 `classifyOutboxFailure`，词汇表 `blocking / stale / covered / superseded / historical / unrelated`），依据当前章节 revision hash、后续成功 rebuild 覆盖关系、SM truth 行（`status=clean && dirtyFrom=null/>completed && throughPosition>=completed`）判定；未识别形状 fail-closed；**不删任何历史行，无 Schema 改动**。
- Red→Green：`__tests__/writingOneFlowClosureOutbox.test.ts` 15 用例（修复前 8 RED / 7 GREEN，修复后 15/15 GREEN）。

### P0-2 legacy pending replay ✅（生产代码本就正确，仅补测试）
- `replayPendingContinuityProposals` = `listProposals(pending)` → 纯分类器（无 LLM）→ routine 自动 commit；已 accepted 行不再列出（幂等）；真冲突保持 pending。
- `__tests__/writingOneFlowClosurePendingReplay.test.ts` 5 用例全绿（含二次 replay 零新增 commit/event）。

### P0-3 Ready Gate 与 SM Truth 对齐 ✅
- `__tests__/writingOneFlowClosureReadyGate.test.ts` 6 用例全绿（truth clean+covered 不被旧失败翻案；dirty/rebuilding/failed 且 dirtyFrom≤completed 继续 NOT ready；truth 无法作证 + 范围内失败 → blocked）。

### 穿测中发现并修复的两个真生产 bug（超出 P0 清单但直接阻断本轮验收，属最小修复）

1. **CursorWindow 溢出**（commit `fdf17c62`）：51 章 Continuation 项目的 run 行 `context_snapshot_json` 达 1MB+；2GB RAM 模拟器 CursorWindow 缩为 1MB，`SELECT * FROM continuation_generation_runs` 直接 `SQLiteBlobTooBigException` → 批次 stage_failed。
   - 修复：6 个读函数全部改为元数据投影（`NULL AS context_snapshot_json` + `json_extract` 提取 workflowVersion/generationTraceId）；新增 `getRunContextSnapshotJson`（512KB substr 分段流式读）与 `getRunGenerationTraceId`（SQL 层提取）；5 个真实需要 snapshot 本体的消费点（kernel trace 持久化、V4/V5/legacy resume、finalize trace 回填）改用流式读；写路径不受影响（bind 参数不过窗口）。
   - 测试：`__tests__/continuationRunCursorWindow.test.ts` 4 用例（2.6MB 快照真 SQLite）；4 个既有测试 mock 适配。
2. **冷启动 outbox 僵尸 running**（未提交）：批次中 app 重启后 `running` 态 outbox 行永不被 re-claim（`listPendingOutbox` 只取 pending/interrupted），Ready Gate 永久等待 → `BATCH_CONTINUATION_STATE_SYNC_TIMEOUT`。修复：`coldStartNormalizeContinuation` 复位 `running → interrupted`。已在真机验证生效（48 条 running 复位后被消化）。

## 三、Full Regression（代码侧全部通过）

| 门 | 结果 |
|---|---|
| verify:version | ok V2.11.53 |
| typecheck | 0 错误 |
| lint | 0 errors（203 warnings 为既有） |
| test:ci（Full Jest） | 3671 passed / 0 failed / 8 skipped（skip 为既有，baseline 同款） |
| Closure 重点组（seal/one-shot/one-flow-phase0-4/closure/batch/outbox/storyMemory/migration） | 912 passed / 4 skipped（既有） |

## 四、Resume/Crash 五项保障核验 ✅
1. Draft 完成后 crash → resume 不重复 paid：既有 `writingOneShotPaidCallGate.test.ts:234`（persisted draft → ZERO physical calls）
2. QA 完成后 crash → 不重调已完成 stage：既有 `continuationV4Resume.test.ts:520`
3. One-Shot draft 成功后 crash → paid≤1：既有 `writingOneShotResume.test.ts:112`
4. pending replay 幂等：本轮 `writingOneFlowClosurePendingReplay.test.ts`
5. 历史 outbox 失败 relevance 判定不漂移：本轮分类器为纯函数 + closure 套件锁定

## 五、真实 LLM 穿测进度（详见测试记录文档）

| 轮 | 目标 | 结果 |
|---|---|---|
| C-1 Outline One-Shot | 2 章 | ✅ 2/2（每章 paid=1） |
| A Outline Standard | 2 章 | ✅ 2/2（含一次"结果未知"checkpoint 恢复实证） |
| B Continuation Standard | 2 章 | ⏸ 1/2 —— item1 succeeded；item2 因 rebuild 风暴超时 failed 一次，正在等待 outbox 消化后重试（详见测试记录"当前断点"） |
| C-2 Continuation One-Shot | 1 章 | ⬜ 未开始 |

**B 轮真实验证已拿到的关键证据**：124 条 legacy pending 经 Ready Gate replay 全部自动 commit（`pending 124→0`，`auto_commit 131`），无需人工清理；真实 Canon 冲突 fail-closed 语义由测试锁定（设备数据中未出现真冲突行）。

## 六、恢复执行清单（下次会话从这继续）

1. 提交工作区两个未提交修改（workflow + cold-start 复位），建议并入一个 commit（`fix(continuation): reset zombie outbox running rows on cold start` + workflow 增补，或分开）。
2. 检查项目 16 outbox 消化情况（`SELECT state,COUNT(*) FROM continuation_state_sync_outbox WHERE project_id=16 AND state!='completed'`）—— SM 已 clean、through=49；等待 139 pending（多为 apply_event no-op）+ interrupted 消化完。
3. 继续 B 轮：进入 E2E_CB1 → "一键续写 N 章" → 批次页"确认后继续"（两次确认弹窗）→ item 2 从 checkpoint 恢复（生成 run 已 completed awaiting_user，恢复应直接走采纳/定稿，不应重复正文付费）→ 目标 2/2。
   - 注意：那条 `rebuild_story_memory:16:51:<hash>:ce_7888...` failed 行（乐观锁冲突）**不应阻断**——P0-1 分类器会判 superseded/covered；若仍被阻断即为回归，需立即排查。
4. C-2：项目 15（E2E_CONT_BATCH）或 16 单章极速（档位切"极速"），paid≤1。
5. 数据口径汇总（traceId/paidCalls/tokens per 章，见测试记录文档§三表格，补 B/C-2）。
6. 最终流程：commit → `npm run apk:debug`（Exact Final HEAD APK）→ `adb install -r` → 封板报告 `docs/optimization/TAVO-MINI_ONE-Flow_Closure_最终封板报告_2026-08-18.md` → push → 确认远端 Verify / Generation Stability 双 Green。
7. 遗留观察项（记录进报告，不扩大范围）：
   - UI 曾出现一次 `Row too big` Toast（读取大 run 行的显示层，已被列裁剪修复覆盖，出现即回归）。
   - 131 条 replay 并发 rebuild 存在乐观锁冲突（1 条 failed，被覆盖不阻断）；可选后续优化：同位置事件合并 rebuild，非本轮范围。
   - `markRunsInterruptedOnColdStart` 自身 SELECT 仍读 `context_snapshot_json`（冷启动仅命中 queued/running run，当前规模未爆；列裁剪可作后续加固）。

## 七、测试文档索引
- 穿测证据与数据口径：`docs/optimization/TAVO-MINI_ONE-Flow_Closure_穿测测试记录_2026-08-18.md`
- 证据副本目录（本地）：`C:/Users/Administrator/AppData/Local/Temp/tavo-qa/`（device-db*.db 系列、ui.xml、screen.png）
