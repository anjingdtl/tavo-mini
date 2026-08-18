# TAVO-MINI ONE-Flow Closure 最终封板报告

- 日期：2026-08-19（穿测跨 08-18～08-19）
- 方案：`TAVO-MINI_ONE-Flow_收尾建设与最终封板方案_V1.0.md`
- 结论（待远端 CI 双 Green 后生效）：**ONE FLOW FINAL SEALED / GO**

## 一、版本与提交

| 项 | 值 |
|---|---|
| baselineHead | `ca00918c2a773db606238f7488d8006b3439d5a8` |
| finalHead | `01cbaf6`（含下述 5 个修复 commit + 本报告文档 commit） |
| version | 2.11.53（versionCode 2115300） |
| 环境 | Node v24.14.1 / Temurin JDK 17.0.19 / Android SDK（emulator x86_64, API 37.1） |
| 设备 | emulator-5554（Medium_Phone，2GB RAM —— 低内存档） |
| LLM | deepseek-v4-flash @ api.deepseek.com（key 于 Keystore keychain） |
| APK | `dist/apk/debug/ShineWriter-V2.11.53-debug.apk`（50.22 MB），多次迭代均为 `adb install -r` 保留数据安装（未 uninstall / 未 pm clear / 未清库） |

修复 commit（本地 main，按序）：

1. `091e60a8` fix(writing): scope continuation ready gate to relevant outbox failures —— P0-1/2/3 + 3 个 Closure 测试套件
2. `fdf17c62` fix(continuation): keep run reads under the low-RAM CursorWindow limit —— 穿测发现的 run 行 1MB+ 读取崩溃
3. `b53c4bd1` fix(continuation): reset zombie outbox running rows on cold start
4. `3244bef8` fix(continuation): claim extract_state outbox rows before replay rebuilds —— FIFO 风暴饿死（接手 AGENT 发现）
5. `01cbaf6` fix(continuation): retry-all outbox reset must not use UPDATE-LIMIT —— Android SQLite 不支持 UPDATE…LIMIT 致"全部重试"静默失败
6. （随本报告提交）`a49e0d0f` ci(generation-stability): add ONE-Flow closure gate suites + 封板文档

## 二、Outbox Root Cause 与 Before/After

**Root Cause（P0-1）**：`continuationBatchStateGate.ts` 第 4 步在精确 revision 检查之后仍用项目级 `getOutboxSummary().failedCount > 0` 全局阻断 —— 任意历史失败（过期/已覆盖/无关）永久阻断未来所有 Batch。

**After（Minimal Fix）**：纯函数相关性分类器（词汇表 `blocking / stale / covered / superseded / historical / unrelated`）。判据：
- extract_state：章节已删=historical；hash 漂移=stale；position 超出范围=unrelated；范围内且 hash 仍匹配=blocking
- rebuild：fromPosition 超范围=unrelated；SM truth（clean + dirty=null/>completed + through≥completed）=covered；后续更早起点成功 rebuild=superseded；否则 blocking
- apply_event=historical（事件在确认时已持久化）；无法解析=fail-closed blocking
- 不删任何历史行；无 Schema 改动；SM truth 读取一次复用给 ONE Memory ready 判定

**Ready Gate Before/After（真机活案例）**：项目 16 累积 1 条乐观锁冲突 failed + 38 条网络期 failed rebuild —— Before 行为下批次永久 blocked；After 行为下经"全部重试"（本次修复的第 5 个 commit 使其真正可用）+ worker 重跑全部转 completed，批次最终 completed 2/2。

## 三、legacy pending replay（P0-2 真机验证）

- 修复前遗留：**124 条 legacy pending proposals**（项目 16）
- Ready Gate replay 首次执行后：**124 → 0**（累计 auto_commit 138 = 124 legacy + 14 新提取），零人工清理、零分类 LLM 调用
- replay 幂等：二次执行新增 commit=0、新增 event=0（自动化锁定 + 真机批次多次恢复未见重复）
- 真冲突 fail-closed：payload 级 canon_conflict/unmergeable/low_confidence 仍 pending，Batch gate 以 `BATCH_CONTINUATION_STATE_CONFLICT` 阻断（closure 套件锁定；设备数据中未出现真冲突行）

## 四、Exact HEAD Android 验证与数据保留

- 每次 APK 迭代均 `adb install -r`；**LLM key（Keystore）、模型配置、25 个项目、Story Memory、Continuation Source/Canon、124 legacy pending、历史 failed outbox 全程保留**（安装前后 DB 快照比对确认）
- 穿测期间真实经历了：app 中途重启（冷启动复位实证）、模拟器重启（DNS 故障恢复）、多次批次 pause/resume —— 全部走生产恢复路径，未清任何数据

## 五、真实 LLM 穿测（6/6）

| 轮 | 结果 | generationTraceId（逐章） | Paid 正文 | 关键验证 |
|---|---|---|---|---|
| A Outline Standard 2 章 | ✅ 2/2 | gt-msynmrno-myeg32se / gt-msyo18po-68hupdm9 | 每章 1 | QA 并行 wave（review+factcheck）、Conditional Revision、Proof、FinalValidate；一次"结果未知"checkpoint 精确恢复（已成功阶段复用，draft 零重复） |
| B Continuation Standard 2 章 | ✅ 2/2 | gt_6929563234463a93… / gt_ae9abea84bce… | 每章 1（多次恢复零重复） | Persist→WritingPersistedEvent→extract_state→auto commit→SM→Ready Gate→次章 Freeze 全闭环；124 pending replay；SM through 49→52；无关历史失败不再阻断 |
| C One-Shot 2+1 章 | ✅ 3/3 | gt-msyn4ni3… / gt-msyn5m68… / gt_3855bd56… | 每章 1 | chapterWritingPaidCallCount=1；formatter/review/audit/factCheck/revision/proof=0；Persist+PostWriting PASS（SM through=53） |

- physicalRequests / tokens / 辅助调用逐章明细：见《穿测测试记录》§一/§二/§三/§三B
- Resume Duplicate Paid = 0（B 轮多次 crash/恢复后 pipeline_draft 总数仍恰为每章 1）
- 按方案§十口径：不声称 P50/P95、不外推

## 六、Resume / Crash 五项保障

1. Draft 完成后 crash → resume 不重复 paid：`writingOneShotPaidCallGate.test.ts:234` + B 轮真机多次恢复实证
2. QA 完成后 crash → 不重调已完成 stage：`continuationV4Resume.test.ts:520` + B 轮真机（review/audit 完成后恢复仅续跑 proof）
3. One-Shot draft 后 crash → paid≤1：`writingOneShotResume.test.ts:112` + C-2 真机
4. pending replay 幂等：`writingOneFlowClosurePendingReplay.test.ts` + 真机 124→0 无重复
5. 历史 outbox 失败 relevance 判定不漂移：分类器为纯函数，closure 套件 15 用例锁定；真机冷启动后判定与测试一致

## 七、自动化与 Full Regression

| 门 | 结果 |
|---|---|
| verify:version | ok V2.11.53 |
| lint | 0 errors（203 warnings 为既有基线） |
| typecheck | 0 错误 |
| Full Jest（test:ci） | 3673 passed / 0 failed / 8 skipped（skip 为 baseline 既有） |
| Closure Gates（新增 3 套件） | Outbox 17 + PendingReplay 5 + ReadyGate 6 = 28 用例全绿，已加入 Generation Stability workflow |
| 重点组（seal/one-shot/phase0-4/closure/batch/outbox/storyMemory/migration） | 912+ passed |
| 新增 CursorWindow 套件 | 4 用例（2.6MB 快照真 SQLite 列裁剪/分段读） |
| Android Debug Build | BUILD SUCCESSFUL（Exact HEAD APK 50.22 MB） |
| Migration | migrationMatrix 全绿（Full Jest 内） |

架构锁复核：Writer Core=1、Prompt Compiler=1、Final Budget=1、LTM=Story Memory only、Post-Freeze Live Source Read=0、One-Shot paid≤1、新增 hard input token cap=0（既有 Phase0/Phase4/OneShot 套件持续锁定，未新增任何第二实现）。

## 八、遗留观察项（记录，不扩大范围）

1. replay 风暴成本：124 条一次性 auto-commit 产生 111 次 SM checkpoint LLM 调用（~1.68M input tokens）+ 大量 per-event rebuild 排队。机制正确但可优化（同位置事件合并 rebuild / replay 分批）—— 建议后续单独议题。
2. `markRunsInterruptedOnColdStart` 自身 SELECT 仍读 `context_snapshot_json`（冷启动仅命中 queued/running run，当前规模未触发 CursorWindow 上限；可按 `RUN_METADATA_SELECT` 模式加固）。
3. 环境事实：2GB 模拟器上 `uiautomator dump` 会被 OOM kill（静默失败产生旧文件误导取证）；模拟器长跑后 DNS 可能失效需重启。均非产品缺陷，已写入 QA 备忘。

## 九、CI

- `.github/workflows/generation-stability.yml` 已加入 3 个 Closure 套件（无 allow-failure）
- Push 后要求远端 **Verify = Green 且 Generation Stability = Green**（结果见下，推送后回填）
  - [x] Verify Green（run #32168043065，completed success，7m20s，@ fc031880）
  - [x] Generation Stability Green（run #32168043194，completed success，40s，@ fc031880）

## 十、封板条件核对（方案§十四）

| 条件 | 状态 |
|---|---|
| ONE Pipeline / Context / Memory / Flow | PASS（冻结区未动，全套件绿） |
| Historical irrelevant failed outbox no longer blocks | PASS（真机活案例 + 15 用例） |
| Current relevant failure remains fail-closed | PASS（blocking 分类 + 既有 exact-key 检查） |
| Legacy routine pending replay = PASS / Real conflict gated / Idempotent | PASS / PASS / PASS |
| Outline Standard 2/2 / Continuation Standard 2/2 / One-Shot 2/2（3 章覆盖） | PASS / PASS / PASS |
| One-Shot Paid ≤ 1 / Resume Duplicate Paid = 0 | PASS / PASS |
| Freeze Drift / Memory Drift / Canon Regression / Fatal Context Loss / False Applied | 0（批次全 completed，无 BLOCK 漂移错误码） |
| Full Jest / Lint / Typecheck / Migration / Android Debug / Stability / Verify | PASS×6 + 远端待回填 |
| Second Writer/Compiler/Final Budget/LTM = 0；New Hard Input Token Cap = 0 | PASS（架构锁） |
