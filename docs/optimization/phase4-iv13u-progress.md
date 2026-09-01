# TAVO-MINI Phase IV-13U Progress

日期：2026-09-01（Asia/Shanghai）  
施工仓：`E:\AiWorkSpace\tavo-mini`  
主方案：`docs/optimization/TAVO-MINI_Phase4_IV13U_一致性与唯一性收口修复方案_20260901.md`

> 本文件是 Phase IV 当前状态与验收分母的唯一 SSOT。旧 IV-12/IV-13 文档只作 Historical Evidence；不得从旧文档的 GO、HOLD 或旧分母推导当前状态。

## 当前唯一结论

**`PHASE IV FINAL SEALED / GO`**

U1～U6 的一致性/唯一性工程门禁、R1 大纲精准修订、R2 原著续写整章重写，以及本次在最终 APK 模拟器上直接重跑的原著续写固定 3 章 B3 均已通过真机闭环。B3 的唯一实体为 `batch_mti4bayt_zhh5gp`，DB 明确为 `writing_mode=continuation`、`chapter_count=3`、`completed_count=3`，不再使用此前误命中的 outline A3 作为替代。本次 follow-up 只补 receipt 冷启动收口与 direct User Revision provenance，不重跑 B3/R1/R2。

## 0. PLAN 基线与保护

- 已执行 `git fetch origin --prune`。
- `origin/main == HEAD == 0b1f6c87a8bd767a057cc39c1ff9bf572cb419df`；分支为 `main`。
- 开工时仅发现并保留用户已有未跟踪文件：主方案文件与 `scripts/qa/__pycache__/run-a5-outline-quality.cpython-314.pyc`。
- 全程未执行 `git reset --hard`、`git clean`、`adb uninstall` 或 `pm clear`；Android 仅使用 `adb install -r`，用户数据库未清除。
- 设备：`emulator-5554`；最终 debug APK：`dist/apk/debug/ShineWriter-V2.21.1-debug.apk`。

## 唯一验收分母

| 口径 | 当前结果 | 是否计入当前封板 |
| --- | ---: | --- |
| A1 大纲精准修订 | 1/1 PASS | 是 |
| A2 大纲整章重写 | 1/1 PASS | 是 |
| B1 原著续写精准修订 | 1/1 PASS（历史既有真机样本） | 是 |
| B2 原著续写整章重写 | 1/1 PASS | 是 |
| A3 大纲 3 章批量 | 3/3 PASS | 是，不能替代 B3 |
| B3 原著续写固定 3 章批量 | 3/3 PASS（`batch_mti4bayt_zhh5gp`） | 是 |

因此当前可诚实汇总为：修订场景 `4/4`；大纲批量 `3/3`；原著续写 B3 `3/3`；满足最终封板条件。

## IV-13U-0 Baseline / Authority Inventory

### PLAN

- 当前不一致：结果页身份、请求账本、Final 合法性、Continuation current pointer、正文与 PostWriting、Phase IV 文档状态均存在旧实现或旧文档分叉。
- 唯一 Authority 应该是：精确 `taskId/runId`、一个 Durable Receipt、一个 Shared Final Body Contract、一个 current-final pointer、当前章节 fingerprint/既有 PostWriting、一个当前状态 SSOT。
- 改动边界：只收敛现有写作与持久化边界，不扩建正常 Writing Pipeline。
- 禁止触碰：新 Writer/QA/Context/Memory/Prompt Compiler/Governor Gate、hidden retry、自动 re-plan、旧用户文件。
- 预期测试：Authority inventory、schema/迁移、结果页与持久化回归。

### RED

已由 `__tests__/phase4Iv13uConsistencyRed.test.ts` 固化旧风险：结果页可能由 chapter 猜 latest、Continuation 多个 eligible Final、旧请求账本与用户修订账本分裂、不同 Final validator 规则漂移、旧 IV-12 GO 与 B3 pending 并存。

### DO

完成 schema 61 增量、Receipt repository、current-final authority、结果页 exact candidate ref、共享正文合同、PostWriting fingerprint 收敛与备份大字段安全读取修正。

### CHECK-A

targeted regression、typecheck、lint、elastic、version 与 full `npm.cmd run verify` 全部通过。

### CHECK-B

最终 APK 安装后冷启动、项目/写作页导航、R1、R2、批次 UI、DB 导出和 logcat 证据均已采集到 `test-logs/phase4-iv13u-20260901/`。

### ACT

把旧 IV-12 GO 从当前状态链中降级为 Historical；把当前分母固定为本文件表格，不允许 A3 或旧 20 章长测替代 B3。

### VERDICT

**GO（U0 基线与 Authority inventory 完成）**。

## IV-13U-1 Candidate Identity SSOT

### PLAN

所有 Result 写操作必须携带精确 `taskId` 或 `runId`，并校验 project/chapter 绑定；`latest` 只允许用于只读发现或历史兼容路径。

### RED

对抗用例覆盖同章 Task A/Task B、Run A/Run B：打开 A 后不得修改更晚的 B；错绑项目/章节必须 fail-closed。

### DO

`PipelineResultScreen` 与 `ContinuationResultScreen` 直接传 `candidateRef.taskId/runId`；候选读取、CAS Apply、Current Final 读取均按精确 identity；Continuation 恢复/采纳使用 current pointer，不再从所有 eligible 中猜 latest。

### CHECK-A

`phase4Iv13uConsistencyRed.test.ts`、`userRevisionCandidate.test.ts`、`continuationResultScreen.test.tsx` 通过；全量 verify 通过。

### CHECK-B

R1 evidence 显示精确 chapter 9262 的 targeted action；R2 evidence 显示精确 chapter 9272/run `ct_9fe4a134908f4bdc9081fb0806ab3fde` 的 whole-chapter action；两条 Receipt 的 candidate identity 与 UI 操作一致。

### ACT

保留 `chapter` 作为 Post-Adoption 当前正文 authority；Pre-Adoption Result 只能使用带 route binding 的 exact candidate ref。任何缺少精确 Final 身份的续写候选直接拒绝写入。

### VERDICT

**GO（U1 exact identity）**。

## IV-13U-2 ONE Durable WritingRequestReceipt

### PLAN

物理请求事实只能进入一个 `WritingRequestReceipt`；User Revision 只保留 action binding，不维护第二套 provider/model/physical/fallback 真相。Receipt 必须在 send 前 durable，Discard、失败、force-stop、invalid response 也必须可追溯。

### RED

覆盖旧风险：Preview Discard/force-stop 后只有内存 receipt；UserRevisionReceipt 与统一 receipt 重复记账；请求跨 provider 边界后不应自动 retry。

### DO

新增 `writing_request_receipts` 与启动期 reconciliation；User Revision 先写 `started`，再更新 succeeded/failed/outcome_unknown/cancelled；Receipt JSON 仅存 bounded metadata/fingerprint，不存 prompt、正文、key 或 reasoning blob。冷启动对 `succeeded + pending` 只关闭 durable preview ledger，不改写 provider outcome，避免 force-stop 后永久 pending。

### CHECK-A

`phase4Iv13uPersistence.test.ts`、`userRevisionReceiptModel.test.ts`、`userRevisionPersistence.test.ts` 通过；本次新增的冷启动收口与 direct User Revision provenance assertions 通过；full verify 通过。

### CHECK-B

`check-b-invariant-audit.json` 中 R1/R2 各一条 Receipt：`physicalRequestCount=1`、`protocolFallbackCount=0`、`requestMayHaveExecuted=true`、Thinking enabled、outcome succeeded；open preview=0；model/provider 均为 `deepseek-v4-flash` / `openai_compatible`。

### ACT

Receipt 账本保持 durable-first；UI 只读取它的标量投影；失败后只做显式用户动作，不做 hidden retry 或 outcome_unknown 自动重发。

### VERDICT

**GO（U2 one durable receipt）**。

## IV-13U-3 Shared Final Body Contract

### PLAN

Outline、Continuation、User Revision 的最终正文都必须调用同一个 `plainTextNovelBody.ts` 合同；技术合法性由一个合同定义，调用点可以多个。

### RED

自然小说中的对白冒号、省略号、书名号和普通语义不能被误杀；JSON/protocol/fence/reasoning/prompt/patch/anchor/结构化重复标题不能进入最终正文。

### DO

`validatePlainTextNovelBody()` 成为 FinalValidate、Persist、adoption、batch adoption、candidate apply 与 whole-rewrite apply 的共同门；移除 Outline/Continuation 各自重复的技术 hard rule。

### CHECK-A

`plainTextNovelBody` 自然负例与结构性负例、Outline/Continuation final validator 回归通过；full verify 通过。

### CHECK-B

R1/R2 UI preview 与 Apply 均通过纯正文门；B3 误定位的 A3 三章在 final 写入边界也均通过纯正文结构检查。此事实不能改变批次模式身份。

### ACT

继续保持 fail-closed；不剥壳、不用关键词黑名单、不追加 Formatter/第二请求。

### VERDICT

**GO（U3 shared final-body contract）**。

## IV-13U-4 Current Final Candidate Authority

### PLAN

允许 Final 历史多行，但每个 Continuation run 必须通过显式 pointer 只暴露一个 Current Final Authority；禁止 `eligible + ORDER BY latest` 推导当前对象。

### RED

迁移前同一 run 可留下多个 eligible final，结果页、恢复和修订可能读到不同对象。

### DO

schema 61 新增 `continuation_current_final_authorities(run_id PRIMARY KEY, active_final_artifact_id...)`；v60→v61 幂等 backfill；Final settlement 与 candidate revision 使用 CAS；历史 artifacts 不删除。

### CHECK-A

`phase4Iv13uPersistence.test.ts` 验证多历史 Final、单 pointer、CAS 冲突和迁移幂等；full verify 通过。

### CHECK-B

最终 DB：`continuation_current_final_authorities` 为 23 rows / 23 distinct run IDs；Final history 为 23 rows；缺失或非 eligible pointer 为 0；SQLite integrity=`ok`、FK check 为空。

### ACT

恢复、采纳、Result 修订只读 Current Final；历史 Generation/Final 行保持不可变。

### VERDICT

**GO（U4 current-final uniqueness）**。

## IV-13U-5 Current Revision / PostWriting Authority

### PLAN

当前章节正文、当前 revision fingerprint 与 PostWriting/ONE Memory/Continuation State 必须指向同一正文；历史 `GenerationPersistedEvent` 只能作为不可变历史。

### RED

修订 Apply 后若只更新 chapters.content，旧 Memory/PostWriting fingerprint 会继续充当 current authority；重复 Apply 或旧事件回放可能产生 stale state。

### DO

Apply 通过 CAS 写入正文后立即复用既有 PostWriting/ONE Memory 闭环；指纹键控 outbox 幂等；失败回滚正文；Continuation 的历史 event 不覆盖新正文 authority。

### CHECK-A

`phase4Iv13uPersistence.test.ts` 与 User Revision/PostWriting regression 通过；full verify 通过。

### CHECK-B

R2 当前章节 9272 fingerprint=`9ad4282a...`，与 run `finalized_revision_hash` 一致；包含该 fingerprint 的 `rebuild_story_memory` outbox 为 completed/attempt=1；project 67 memory status=clean。R1/R2 Receipt candidate fingerprint 与最终章节 fingerprint 均可追溯。

### ACT

继续区分 Generation History、Current Chapter Revision、PostWriting/Memory 三种 authority；不篡改历史事件，不把历史正文重新当 current。

### VERDICT

**GO（U5 current revision/PostWriting consistency）**。

## IV-13U-6 Phase IV Status / Denominator SSOT

### PLAN

当前状态与验收分母只能在本文件维护；旧 IV-12 GO、旧 IV-13 NO-GO、20 章长测结果全部显式 Historical，不能混合成当前结论。

### RED

聚合文档此前同时存在 IV-12 GO、IV-13 HOLD 与不同批次分母，且 A3/B3 标签容易混淆。

### DO

新增本 progress/report；同步 `phase4-final-report.md`、`phase4-requirement-closure.md`、`phase4-progress.md` 与旧 IV-12 报告的 Historical 标记；固定本文件“4/4 修订、A3=3/3、B3=3/3”表。

### CHECK-A

文档检索确认当前聚合入口指向本文件；工程 full verify 通过。

### CHECK-B

DB identity audit 明确：`batch_mtgkk3dc_j6pp07` 是 `writing_mode=outline`、3/3 completed，只计 A3；随后按用户指示直接在模拟器重跑出唯一的 `batch_mti4bayt_zhh5gp`，其 `writing_mode=continuation`、`chapter_count=3`、`completed_count=3`，三项均为 `full_pipeline`。

### ACT

保持当前状态与分母只由本 SSOT 表达；A3 与 B3 通过 `writing_mode` 和唯一 `batch_id` 分离计数，不以跨模式的“3/3 completed”替代 B3。

### VERDICT

**GO（U6 文档与分母 SSOT 收敛）**。

## IV-13U-7 Minimal Android Regression + B3 Final Seal

### PLAN

U1～U6 通过后只执行：大纲精准修订×1、原著续写整章重写×1、固定 3 章原著续写 B3 真机重跑；不重跑 20 章、不扩大样本、不改 prompt/章节/计划/timeout/retry。

### RED

此前误命中的 `batch_mtgkk3dc_j6pp07` 必须先由真实 DB 身份审计排除为 A3；在用户要求直接重跑后，新 B3 必须由真实 `batch_id`/chapter/run 精确追溯。旧报告提到的“第120章·涨潮夜行/钥匙的认主”实体不作为本轮 B3 身份依据。

### DO

- R1 已完成：chapter 9262，精准选区 UI → Preview → Confirm Apply → `已保存`；单次物理请求。
- R2 已完成：chapter 9272，whole rewrite UI → Preview → Confirm Apply → `已保存`；单次物理请求。
- 直接在最终 APK 模拟器上创建并执行唯一固定 3 章 continuation B3：`batch_mti4bayt_zhh5gp`（project 67，章节 9292/9293/9294，run `ct_88909535687642719ad174d40b470b80` / `ct_ab299cb8ee654fb9b25cae304ee74864` / `ct_d2d59d0b15cd467e8caa534c52b208a4`）。UI 显示 `批次完成 / 成功 3/3 / 完整流水线 3 / 采用草稿 0`，DB 三项均 `succeeded`、`full_pipeline`。

### CHECK-A

full `npm.cmd run verify`：Jest 543 passed / 4 skipped，3824 passed / 9 skipped；typecheck、lint、elastic、version 全通过。

### CHECK-B

- APK build：PASS；SHA-256=`36474F37A80EE8F4F413DD0D687D57E1756D84717431C368EF2313D823213DC6`。
- `adb -s emulator-5554 install -r dist/apk/debug/ShineWriter-V2.21.1-debug.apk`：`Success`；package `com.shinewriter`，versionName `V2.21.1`，versionCode `2210100`。
- 冷启动、写作页、R1、R2、B3 批次 UI hierarchy/screenshot/logcat 均留证；最终 DB `settings.schema_version=61`，integrity=`ok`，FK check 为空，pipeline context 最大长度约 954596，未再出现修复前的 no-such-table/Row-too-big 应用错误。
- B3 body-free final audit：23 个 current Final pointer 对应 23 个 distinct run，23 个 Final history，缺失/非 eligible pointer 为 0；B3 三章正文 fingerprint 均同时匹配章节正文、run `finalized_revision_hash` 与当前 Final artifact；三条 PostWriting outbox 均 completed 且按当前 fingerprint 去重，project Story Memory 为 `clean`。
- B3 request ledger：8 次真实物理写作请求与 8 条 stage receipt、run token ledger 对齐；protocol fallback=0、primary retry=0、formatter=0。item 的 `retry_count` 仅为状态同步等待计数，不是 LLM 重试。

### ACT

根因是上一轮把 outline A3 误当作 B3；按 PDCA 的 ACT 已直接回到模拟器原著续写入口重跑固定 3 章，并用唯一 `batch_id`、章节、run、Final pointer、PostWriting/Memory 和 UI 复核闭环。未扩建正常 Writing Pipeline，未重跑 20 章。

### VERDICT

**GO（B3 continuation 3/3、唯一性与一致性均形成可审计分母）**。

## IV-13U-8 Follow-up Receipt Cold-start / Provenance

- 实现提交 SHA：`cf5c5f8f95e0abe0973a8cb80bbcb2bd8695ece4`。

### PLAN

修复成功 Preview 后 force-stop 造成的 `succeeded + pending` 幽灵 ledger；direct User Revision 使用独立 provenance。按用户指示不重跑 B3、R1、R2，仅执行受影响的 targeted tests、full verify 和窄范围 Android 冷启动复验。

### RED

新增断言先复现两处旧行为：`succeeded + pending` 启动 reconciliation 返回 0；direct User Revision receipt 仍为 `shared-prompt-compiler-v1`。

### DO

启动 reconciliation 对 `pending` 且 receipt `outcome=succeeded` 的行以 CAS 方式改为 durable `failed`，保留 receipt 的 `succeeded`、physical dispatch 和 execution boundary 事实；standalone User Revision receipt 改用 `direct-user-revision-v1`，共享 Writing Pipeline 保持 shared compiler provenance。

### CHECK-A

targeted GREEN：`phase4Iv13uPersistence.test.ts`、`userRevisionReceiptModel.test.ts`、`writingRequestReceipt.test.ts` 共 3 suites / 12 tests 通过；full `npm.cmd run verify` 通过，Jest 543 passed / 4 skipped，3824 passed / 9 skipped。

### CHECK-B

- debug APK build PASS，SHA-256=`36474F37A80EE8F4F413DD0D687D57E1756D84717431C368EF2313D823213DC6`；`adb install -r` PASS。
- force-stop 后冷启动 `Status=ok`、`LaunchState=COLD`、`MainActivity` resumed，UI hierarchy 通过设备文件 dump 获取；应用进程无 FATAL/AndroidRuntime marker。
- body-free evidence index：[`evidence/phase4-iv13u-final-evidence-20260901.json`](evidence/phase4-iv13u-final-evidence-20260901.json)，SHA-256=`F57C23D7F3155ECE6EE7A3C3AA0ADDFAFC68966C16E051AE22BD091E3CF223BA`。

### ACT

不引入 schema 迁移、不持久化候选正文；通过 fail-closed 关闭不可恢复的 pending action audit，避免重复 provider call。保留既有 B3/R1/R2 真机证据，不重新消耗样本。

### VERDICT

**GO（follow-up receipt cold-start closure and direct provenance）**。

## Final GO / NO-GO

当前唯一结论为：

```text
PHASE IV FINAL SEALED / GO
```

已通过：U1～U6、R1、R2、A3、B3 `3/3`、full verify、APK、`adb install -r`、DB integrity/FK、Receipt、UI、logcat。B3 使用唯一 continuation `batch_id`，不是 outline A3，也不是历史 20 章长测。

本轮无需继续扩样；保持现有唯一 SSOT、Receipt、Final Authority、PostWriting/Memory 与历史证据边界。
