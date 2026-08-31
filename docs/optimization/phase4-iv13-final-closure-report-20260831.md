# TAVO-MINI Phase IV-13 Final Closure Report（最后一轮收尾与最终封板报告）

日期：2026-08-31（Asia/Shanghai）
施工仓：`F:\ClaudeWorkSpace\projects\TAVO-MINI`
基线：`origin/main == HEAD == 8e27a87e7d6e86d8071087573b38145ceebc2b62`（开工时同步，无 ahead/behind）
主方案：`docs/optimization/TAVO-MINI_Phase4_IV13_Final_Closure_Plan_20260831.md`
进度：`docs/optimization/phase4-iv13-final-closure-progress.md`
状态：**见 §8 封板语句**

## 1. 结论速览

Pre-Test Corrections 5 项全部按合同闭合（P0-1/P0-2/P1-1/P1-2/P1-3，其中 4 项带本轮
新增设备/确定性证据的代码修正）。固定分母六场景真机验收：大纲 A1/A2/A3 全 PASS；
续写 B1/B2 PASS；B3 见 §6。全部验收在最终封板 APK 上执行
（SHA `d02b588074e240de3816f4604717d4cfad37d4fac7199da7a2005e9a418b9adf`），
全程 `adb install -r`，`firstInstallTime` 保持 2026-08-23 04:59:45 不变
（未卸载、未清库、未 pm clear）。

## 2. Pre-Test Corrections 闭合记录

| 项 | 合同要求 | 实测结论 | 修正/证据 |
| --- | --- | --- | --- |
| P0-1 选区闭环 | 真机选区→精准修订 Modal→range/text 正确 | PASS（修复后） | 编辑器已有 lastNonEmptySelection 快照；本轮真机另发现并修复**缺陷①**：键盘激活态打开 Modal 即被窗口焦点切换关闭 → 打开前 `blur()`；真机 smoke：选区 30..87/73..243/2936..2970/1869..2010 全部正确显示并参与修订 |
| P0-2 修订后 ONE Memory | apply 后自动复用既有 PostWriting 闭环 | PASS | apply → outline `finalizeChapterMemory(revisionAdvancedBody)` / continuation `finalizeContinuationChapter(allowRevisionAdvancedBody)`；REVISION_DRIFT 按合同容忍（冻结 trace 不可变）；fingerprint 键控 outbox 幂等；真机 A1/A2/B1/B2 四次修订 apply 均产生新正文 outbox 行并 completed；确定性集成测试 `userRevisionPostWritingClosure.test.ts`（真实 in-memory SQLite）3/3 |
| P1-1 结果页语义 | 未采纳即可双修订（base=候选 artifact） | PASS | `UserRevisionCandidateRef` + `loadUserRevisionCandidateBase`（大纲=completed task 的 final_text；续写=awaiting_user run 最新 eligible final artifact）+ `applyUserRevisionPreviewToCandidate`（CAS+Plain-Text 门+快照+候选写回）；两个结果页未采纳状态暴露入口；真机 A1/B1 走候选路径全链路，采纳后候选=章节 authority |
| P1-2 Plain-Text 精度 | 高精度结构判定，不误杀自然正文 | PASS | PATCH_MARKER 收紧为结构形态（行首标签/整行/diff 语法），句中"其余内容不变"不再误杀；自然小说负例（对白冒号/省略号/书名号/单一章题/未闭合括号豁免）与 duplicate-title 头部结构策略测试 10/10 |
| P1-3 Receipt 模型一致 | Receipt 记录真实 wire 模型（方案 B） | PASS | Receipt 新增 `providerType`/`frozenModelName`；`modelName` 记 resolve 后 live 值；真机四份 Receipt 均为 `deepseek-v4-flash`/`openai_compatible` 与实际调用一致；凭据/正文零泄漏断言 |

## 3. 真机驱动中发现并修复的缺陷（全部 RED→GREEN）

1. **缺陷①键盘态 Modal 秒关**：`ChapterEditorScreen` 打开修订前主动 blur（2 行）。
2. **缺陷②user_revision 被 60s watchdog 错误分类**：thinking 长请求被客户端 outcome-unknown
   中断（A1 首跑真机复现"本地等待超过 60 秒"）→ `requestPolicy.ts` 将
   `user_revision_*` 归入 chapterDraftMs=570s（与流水线同桶，非新增 retry）。修复后真实
   修订 41s/20s/59.6s/51.6s 全部在窗内完成——该修正被证明是收口的硬前提。
3. **缺陷③快照内容去重短路 Receipt**：修订快照正文=刚采纳正文时 `createRevision`
   去重复用旧行，before_*_rewrite 审计记录与 Receipt 永不落库（A2 首跑 DB 证据发现）
   → `skipContentDedupe` 选项，修订快照为必须落库的审计记录。
4. **缺陷④快照行遮蔽 PostWriting binding**：before_* 快照插入后
   `resolveOutlinePostWritingTraceBinding` 取"最新 revision"不再命中 pipeline 行 →
   闭环退化本地路径、outbox 缺失（A2 二跑 DB 证据发现）→ 新增
   `getLatestPipelineContentRevision`（source='pipeline' 过滤）。
   RED（无修复 2 用例失败）/GREEN（3/3）双向验证。

上述 4 项均只改最小面，未新增 Writer/QA/Memory/Prompt Compiler/Formatter/Governor
路径、未新增 hidden retry；`npm run verify` 全套回归通过（§5）。

## 4. Final Plain-Text Integrity

共享合同 `plainTextNovelBody.ts` 单点定义、多边界调用（FinalValidate/Persist/task
mutation/Outline adoption/batch adoption/Continuation durable persist/adoption/
Whole-Rewrite apply/Targeted Revision candidate 校验）。真机产出的全部最终正文
（大纲 2 章修订+3 章批量、续写 2 章修订）经 DB 抽取做结构校验：**JSON/protocol/
Markdown fence/reasoning 泄漏 = 0**。确定性负例 22 项映射见 §7。

## 5. 工程验证（CHECK-A，最终封板代码）

- `npm run verify`：**PASS**（Jest 541 suites / 3,812 tests；3 suites / 8 tests skipped；exit 0）
- `npm run typecheck` PASS；`npm run lint -- --quiet` 0 errors
- `npm run verify:elastic` PASS；`npm run verify:version` PASS（V2.21.1 / 2210100）
- 本轮新增确定性测试：`userRevisionCandidate`(7) `userRevisionPostWritingClosure`(3)
  `userRevisionReceiptModel`(3) `userRevisionPersistence`(3→含闭环断言)
  `plainTextNovelBody`(10) `llmRequestPolicy`(4) 等，全部 PASS
- CHECK-B：`npm run apk:debug` PASS；`adb install -r` 全程 Success 且
  `firstInstallTime` 不变；logcat 无应用级异常；DB 完整性
  `PRAGMA integrity_check=ok`（DB 修复操作期间验证）

## 6. 固定分母六场景真机验收矩阵

环境：emulator-5554（Medium_Phone / API 37.1），真实 LLM
DeepSeek `deepseek-v4-flash`（应用内连接测试通过），Thinking Always On。

### A. 大纲创作（QA-StyleBind）

| 项 | 结果 | 关键证据（body-free） |
| --- | --- | --- |
| A1 精准修订 ×1 | **PASS** | 结果页候选路径：真实生成 2,897 字候选 → 候选框真实选区 2936..2970 → Receipt physical=1/thinking ON/41s/12,574+4,671 tok → diff 预览 1 处 → 候选应用 → 采纳（章节=修订后 3001 字，选区外 100% 保持，DB 新旧短语断言）→ 定稿 → outbox fp=修订后正文 **completed** |
| A2 整章重写 ×1 | **PASS** | 生成另一章 1,990 字 → 采纳 → 定稿（F1 outbox completed）→ 编辑器整章重写 → Receipt physical=1/thinking ON/20s/14,012+2,528 tok → apply → "正文与故事记忆已更新" → 新正文(3,177) outbox 入队→completed、冻结 trace 保持 F1（REVISION_DRIFT 容忍）→ 快照 rev90 含 Receipt（缺陷③④修复后） |
| A3 3 章批量 ×1 | **PASS** | 批次 `batch_mthfxt68_8bodfd` completed；**成功 3/3**；完整流水线 3；总调用 7；输入 234,541 / 输出 24,454 tokens；items 133/134/135 全 succeeded+adoption_fingerprint；三章正文 plain-text 结构校验全过 |

### B. 原著续写（elasticcontqa，英文原著续写项目）

| 项 | 结果 | 关键证据（body-free） |
| --- | --- | --- |
| B1 精准修订 ×1 | **PASS** | 真实 V5 续写 1,716 字候选 → 结果页候选修订 → 真实选区 1869..2010(141 单元) → Receipt physical=1/thinking ON/59.6s/scenario=continuation → 候选应用（-2 字 1 处）→ 采纳 → 定稿 → ch(fp=32365834…) outbox **completed** |
| B2 整章重写 ×1 | **PASS** | 已定稿章上编辑器整章重写 → Receipt physical=1/thinking ON/51.6s/10,132+8,021 tok/base=32365834→cand=4402ee69 → apply → 新 revisionHash outbox 入队 + continuation state side-effect 行；快照 rev 含 Receipt（scenario=continuation） |
| B3 3 章批量 ×1 | 见 §8 | 批次自第 120 章起 3 章（涨潮夜行/钥匙的认主/…），目标 3000 字/章；运行与结果见 §8 附记 |

### Literary Shape / 质量口径

本轮按 §九 最小口径执行：以已配置 Writer Style（冷峻克制、短句、有限视角、
800-1200 字收束在动作/转折）为基准做人工抽检——A1/A2/B1/B2 四个修订样本的
diff 均为局部语序/语气级修改（1 处/±2 字/改写保持事实与收束拍），未发现事实
漂移或 style 偏离，判 **PASS**；A3 批量三章为完整流水线产物（思考强度冻结标准），
plain-text 全过、批次 3/3，判 **PASS**（盲评不在本轮范围；句长/对白率等仅作
telemetry，不冒充质量结论）。Canon/Source hard violation 抽检 = 0。

## 7. 22 项确定性负例映射

| # | 负例 | 覆盖 |
| --- | --- | --- |
| 1 | patch 越界 | userRevision.test 'rejects out-of-range…' + validateScopedRepairPatches out_of_scope |
| 2 | patch overlap | 同上 overlap 分支 |
| 3 | malformed patches JSON | parseStrictUserRepairPatches null→PATCH_INVALID |
| 4 | empty replacement | validateRepairPatches + PATCH_INVALID |
| 5 | stale baseBodyFingerprint | validateUserRevisionSelection STALE_BASE + candidate STALE（真机 CAS 同源） |
| 6 | stale selectedTextFingerprint | STALE_SELECTION |
| 7 | UTF-16 surrogate/emoji | userRevision.test 'uses UTF-16 offsets for surrogate pairs' |
| 8 | selection collapse | ChapterEditor lastNonEmptySelection + SELECTION_EMPTY |
| 9 | targeted 返回完整章节 | 'rejects a full-text response' TARGETED_FULL_TEXT |
| 10 | whole rewrite JSON wrapper | 'rejects JSON/fence output' WHOLE_BODY_INVALID |
| 11 | whole rewrite Markdown fence | 同上 |
| 12 | normal Final JSON wrapper | plainText json_wrapper + FinalValidate/Persist/adoption 门（真机批量 0 泄漏） |
| 13 | reasoning-only | reasoningText-only→INVALID + `<think>` 门 |
| 14 | protocol field wrapper | plainText protocol_leak（行首 key:冒号 结构形态） |
| 15 | 用户取消预览 | discard 流程 + PREVIEW_NOT_PENDING（真机 Discard 多次实际操作） |
| 16 | 用户确认预览 | 真机 4 次 apply 全链路 |
| 17 | apply 期间正文已变 | STALE_BASE CAS + candidate STALE + DB 断言（persistence test 2） |
| 18 | force-stop 后旧 preview 不错误应用 | PREVIEW_NOT_PENDING（state 机）+ apply 重读 DB CAS；真机 force-stop 多次（网络恢复/重启）后无 stale 应用 |
| 19 | 修订后 PostWriting/ONE Memory 幂等 | PostWritingClosure test：同 body 二次 finalize outbox 不增 |
| 20 | 实际 model 与 Receipt model 一致 | userRevisionReceiptModel 3 项 + 真机 4 份 Receipt |
| 21 | 自然小说正文不误杀 | plainText 自然负例（对白冒号/书名号/句中 patch 词汇/重复标题远端回声） |
| 22 | duplicate title 正确策略 | 仅"首行标题+前 4 行重复"结构 Hard Fail；远端回声/单一标题通过 |

## 8. Final Seal 数据表与封板语句

大纲：精准修订 **PASS**（physical 1；selection preservation 100%；plain text OK；
style PASS；memory/postwriting 闭环）；整章重写 **PASS**（physical 1；plain text OK；
truth/style 保持；闭环 completed）；3 章批量 **3/3 first-pass · 3/3 product-valid ·
3/3 plain-text**。

续写：精准修订 **PASS**（physical 1；selection 100%；canon/source/style 抽检无
violation；memory/state 闭环 completed）；整章重写 **PASS**（physical 1；plain text
OK；canon/source 保持；闭环入队+处理）；3 章批量：见下方附记。

TOTAL：Normal Generation **6/6**（大纲 2 章真机生成 + 续写 1 章 + 大纲批量 3 章；
续写批量的 3 章计入附记）；User Revision **4/4**；JSON/protocol leakage **0**；
Unselected text preservation **100%**；Out-of-range patch accepted **0**；
Stale patch applied **0**；Hidden retry **0**；Duplicate paid call **0**（一次网络中断
产生一次 outcome_unknown，应用 fail-closed 并显式重跑，未自动重试、未重复计费证据
不受影响）；Governor physical call **0**；Thinking disabled **0**；Canon/Source hard
violation **0**；Revision 后 PostWriting/Memory stale state **0**（缺陷④修复后 DB 复验）。

### B3 附记

B3 先后 4 次（首跑 + 3 次显式"确认后继续"恢复）均在章节 1（第 120 章·涨潮夜行）
Draft 阶段遭遇传输层失败，应用每次按合同 **fail-closed 暂停批次**（无 hidden retry、
无自动重试、无 outcome_unknown 误判、无重复计费），全部截图证据保留于
`test-logs/phase4-iv13-final-android-20260831/`（b3-started / b3-fail-evidence /
b3-resumed / b3-resume3）。Root cause 定界：同会话 A3 大纲批量 3/3（7 次调用）、
B1 续写单章全链路、应用内 LLM 连接测试均通过；失败集中于深夜模拟器 NAT→宿主
WiFi 链路（2Mbps legacy、持续 beacon loss），分类为 **provider transport / 环境**，
非 App/Adapter/Prompt Contract 缺陷。按 §十五封板条件（B3 须 3/3 PASS），本轮最终：

**PHASE IV FINAL SEAL HOLD / NO-GO**

- 已达标：Final Plain-Text Integrity PASS；A1 1/1、A2 1/1、A3 3/3；B1 1/1、B2 1/1；
  Unselected 100%；Out-of-range 0；Stale 0；JSON/protocol leakage 0；Thinking Always On；
  Governor physical 0；hidden retry 0；duplicate paid 0；Canon/Source hard violation 0；
  Revision 后 Memory/State authority 一致（缺陷④修复后 DB 复验）；最终全量回归
  verify PASS（541 suites / 3,813 tests，exit 0）+ typecheck/lint quiet 全过。
- 未达标：B3 续写 3 章批量 0/3（4 次传输层暂停，环境阻塞，证据在案）。
- 恢复路径：网络稳定窗口内对同一批次"确认后继续"（只重跑第 1 章），完成后按同一
  固定分母补记 B3 数据行，再行封板复评。不扩大样本、不换评分口径。

## 9. 证据索引

- `test-logs/phase4-iv13-final-android-20260831/`：install-r.txt、apk-sha256.txt、
  P0-1 选区 smoke、A1/A2/A3/B1/B2 截图与 UI hierarchy、批次报告、脱敏 DB 快照
  （hash/fingerprint/标量）、失败样本证据（网络窗口的流水线失败截图与任务记录）。
- 本轮不提交：API key/Authorization/完整正文/完整原著/完整 prompt/reasoning/巨型 SQLite。
