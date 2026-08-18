# TAVO-MINI ONE-Flow 最终封板 —— 接手 AGENT 交接提示词

> 用法：新会话以此为唯一施工指令，全文粘贴或让 AGENT 直接读取本文件。配合三份必读文档执行。

---

请以本地仓库 `F:\ClaudeWorkSpace\projects\TAVO-MINI` 为唯一施工基线，全程自主执行，完成 ONE-Flow 最终封板（Closure PDCA）的**收尾阶段**。

本轮性质：接续 2026-08-18 已完成的主体修复与 4/6 章真实穿测，**只做剩余验证与封板**。不是继续架构升级，严禁借机重构已验收的 ONE Memory / ONE Context / ONE Pipeline / Writing Kernel。

==================================================
一、开工前必读（按序）
==================================================

1. `docs/optimization/TAVO-MINI_ONE-Flow_Closure_进度Progress_2026-08-18.md`
   —— 当前进度全貌、两个已提交 commit、未提交修改清单、恢复执行清单（§六）、遗留观察项（§七）。
2. `docs/optimization/TAVO-MINI_ONE-Flow_Closure_穿测测试记录_2026-08-18.md`
   —— 已完成穿测的全部证据（traceId / paidCalls / tokens）、B 轮断点细节、DB 查询速查、adb 命令。
3. `docs/optimization/TAVO-MINI_ONE-Flow_收尾建设与最终封板方案_V1.0.md`
   —— 原始方案（冻结区、封板条件§十四、性能口径§十、最终报告§十三）。

==================================================
二、当前状态快照（以实际 git log / git status 复核为准）
==================================================

- baselineHead `ca00918c`；当前本地 HEAD 应为 `fdf17c62`（若不符，先停下来核对，禁止回退）。
- 已提交：`091e60a8`（Ready Gate outbox 相关性修复 + 3 个 Closure 套件）、`fdf17c62`（CursorWindow 列裁剪 + 分段读）。均**未 push**。
- 工作区应有 2 个未提交修改：
  - `.github/workflows/generation-stability.yml`（Closure Gates 已加入，ciConfiguration 测试已验证）
  - `src/services/continuation/generation/continuationStateOutboxWorker.ts`（冷启动复位 outbox 僵尸 running；typecheck + worker/phase3 70 测试已绿，**Full Jest 尚未整体重跑**）
- Full Jest 最后一次全量绿：3671 passed / 0 failed / 8 skipped（skip 为既有）。
- 穿测进度：C-1 Outline One-Shot 2/2 ✅；A Outline Standard 2/2 ✅；**B Continuation Standard 1/2 ⏸**（详见下）；C-2 Continuation One-Shot 未开始。
- 设备：emulator-5554（Medium_Phone / 2GB RAM）已启动，应用 com.shinewriter 已装 V2.11.53（含全部修复），**历史数据全部保留（禁止 uninstall / pm clear / 清库）**。LLM key 在 Keystore keychain（DB 里 api_key 为空是设计）。

==================================================
三、执行清单（严格按序）
==================================================

### 步骤 0：基线复核
```
git fetch --all --prune && git checkout main && git pull --ff-only
git status && git rev-parse HEAD
npm run verify:version && npm run typecheck && npm run lint
```
若远端 main 已高于 `fdf17c62`：以最新 main 为准重新核状态，禁止回退。

### 步骤 1：补 Full Regression 后提交遗留修改
跑 `npm run test:ci` 全绿后，把工作区 2 个修改提交（建议拆两个 commit）：
- `fix(continuation): reset zombie outbox running rows on cold start`
- `ci(generation-stability): add ONE-Flow closure gate suites`

### 步骤 2：完成穿测 B（本轮最重要，当前断点见测试记录§三）
先核对项目 16 outbox 消化与 SM 状态：
```
MSYS_NO_PATHCONV=1 adb -s emulator-5554 exec-out run-as com.shinewriter cat databases/shine_writer.db > <本地临时路径>
sqlite3 <本地临时路径> "SELECT state,COUNT(*) FROM continuation_state_sync_outbox WHERE project_id=16 AND state!='completed' GROUP BY state; SELECT status,dirty_from_position,through_chapter_position FROM project_story_memory WHERE project_id=16;"
```
SM 应为 clean / dirty=null；outbox pending 剩余多为 apply_event（no-op，会自然消化）。若 SM 仍 dirty 且 outbox 停滞，先查 worker 是否在跑（冷启动复位已装）。

UI 操作序列（作品库卡片直点偶发无响应，**一律用底部 tab 进入当前工作项目**）：
1. 底部 tab「1 项目」→「原著续写（2）」筛选 → 底部 tab「3 续写」（进入 E2E_CB1 工作台）
2. 「一键续写 N 章」→ 批次页应显示 paused → 「确认后继续」→ 二次弹窗「确认继续」
3. item2（重铸天机，run `ct_475b342d…` 已 completed/awaiting_user）从 checkpoint 恢复，**应走采纳/定稿路径，不得重复正文付费调用**（对照 llm_usage_logs 的 pipeline_draft 计数）
4. 目标 2/2 completed

**重点观察**：项目 16 存在 1 条真实 failed rebuild（`rebuild_story_memory:16:51:<hash>:ce_7888…`，乐观锁冲突、已被其它成功 rebuild 覆盖）。恢复过程中它**不得阻断** Batch —— 这是 P0-1 分类器 superseded/covered 判定的活案例。若因此被 BLOCK，立即停止并排查回归（对照 `__tests__/writingOneFlowClosureOutbox.test.ts`）。

若 Continuation 不能干净 2/2：立即 NO-GO，继续 PDCA，不得封板。

### 步骤 3：穿测 C-2（Continuation One-Shot 1 章）
在项目 15（E2E_CONT_BATCH）或 16 上单章「极速」档（档位在 设置→流水线配置→思考档位，改后需保存）。验收：`chapterWritingPaidCallCount = 1`，formatter/review/audit/factCheck/revision/proof 全 0，Persist/PostWriting PASS。

### 步骤 4：数据口径汇总
按方案§十逐章补齐测试记录§五表格（generationTraceId / freezeFingerprint / executionProfile / paidCalls / tokens / SM & 状态提取状态）。**不做 P50/P95、不声称提速、不外推。**

### 步骤 5：Exact Final HEAD APK + 封板
1. 全部 commit 后记录 finalHead；`npm run apk:debug` 重建（Exact HEAD APK）
2. `adb install -r`（保留数据），记录 APK 路径/版本
3. 撰写 `docs/optimization/TAVO-MINI_ONE-Flow_Closure_最终封板报告_<date>.md`（方案§十三全部条目 + Progress 文档§七的三个遗留观察项）
4. push 后确认远端 **Verify = Green 且 Generation Stability = Green**（若 CI 未触发，记录原因并给本地等价证据，但正式封板优先远端 Green）

==================================================
四、冻结区与禁止事项（继承原方案，违反即返工）
==================================================

- 冻结：ONE Production Writing Entry / Writing Kernel / Shared Writer Core / Shared Prompt Compiler / Context Planner / allocateWritingContextBudget / Frozen Context / Stage Projection / Findings Aggregator / Pipeline DAG / QA Parallel / Conditional Revision / ONE Story Memory / Structured Continuity State / WritingPersistedEvent / One-Shot 极速档。
- 禁止新增第二套 Writer/Compiler/Context Builder/Final Budget/LTM；禁止新 hard input token cap；禁止重写 Elastic/Hierarchical Budget；禁止为提速默认删 Proof；禁止放宽 Canon/Freeze/Semantic Apply/FinalValidate；禁止 silent fallback 吞异常；禁止清库解决历史状态。
- 测试禁止 `.only` / `.skip` / allow-failure / 弱化断言 / 注释失败测试。
- 发现新问题：与本轮封板直接相关 → 最小修复 + Red Test；否则记录进报告，不扩大范围。

==================================================
五、环境与操作坑（上一轮实测沉淀）
==================================================

- adb 在 PATH；模拟器 x86_64；**中文无法 `input text`（会 NPE）**，UI 输入一律英文（%s 转义空格）。
- UI dump 用 `/data/local/tmp/ui.xml` + `MSYS_NO_PATHCONV=1 adb pull`（/sdcard 与 adb shell grep 中文均不可靠）。
- 拉设备 DB 必须 `adb exec-out run-as … cat`（shell cat 会被 CRLF 损坏二进制）。
- 批次配置页：生成章数改 2；摘要必填（英文即可）；「开始批量写作」在长文页需先 BACK 收起编辑焦点再 swipe 滚动到底（swipe 会被文本框吃掉）。
- 档位映射：极速=one_shot，中/高=standard（存 settings 表 `pipeline_execution_profile`，可从 DB 直接核实）。
- 2GB RAM 设备 CursorWindow=1MB：任何读取大 JSON 列的新 SQL 都必须列裁剪或 substr 分段（参照 `RUN_METADATA_SELECT` / `getRunContextSnapshotJson`）。UI 若再出现 "Row too big" Toast 即为回归。
- 全局记忆（用户级 AGENTS.md）有设备/通道速查；Maestro 中文匹配必挂，UI 驱动用 adb 坐标。

==================================================
六、封板条件（全部满足才可标记 ONE FLOW FINAL SEALED / GO）
==================================================

Outline Standard 2/2 ＋ Continuation Standard 2/2 ＋ One-Shot 2/2（C-1 两章已计）；One-Shot paid≤1；Resume duplicate paid=0；历史无关 failed outbox 不阻断、当前相关失败仍 fail-closed；legacy routine pending replay=PASS 且幂等、真冲突仍 gated；Freeze/Memory Drift=0、Canon Regression=0、Fatal Context Loss=0、False Applied=0；Full Jest/Lint/Typecheck/Migration/Android Debug/Generation Stability/Verify 全 PASS；Second Writer/Compiler/Final Budget/LTM=0；New Hard Input Token Cap=0。

除非遇到密钥、设备、权限等无法自行恢复的问题，否则不要等待人工确认。现在开始自主执行。
