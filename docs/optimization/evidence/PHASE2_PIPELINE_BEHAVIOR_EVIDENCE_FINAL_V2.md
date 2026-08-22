# PHASE 2 Pipeline Behavior 最终真实 Evidence V2（脱敏）

状态：FINAL LIVE EVIDENCE / 封板候选。采集日期：2026-08-23（Asia/Shanghai）。

本文件只记录可审计的身份、DAG、checkpoint、调用 ledger、token、hash、outbox 与终态；不包含 API Key、Prompt 全文、小说完整正文、SQLite 数据库或隐私数据。旧证据 `PHASE2_PIPELINE_BEHAVIOR_EVIDENCE_FINAL.md` 已标记 `SUPERSEDED / HISTORICAL`，不得与本文件混用。

## 1. 身份、构建与安装绑定

| 字段 | 最终值 |
|---|---|
| 唯一施工基线 | `F:\ClaudeWorkSpace\projects\TAVO-MINI` |
| Production SHA | `6d389f8da48cf7a61d810246ef9e4a71d7e3fc18` |
| Production commit | `fix(writing): close pipeline behavior persistence loop` |
| APK | `dist/apk/debug/ShineWriter-V2.11.54-debug.apk` |
| APK SHA-256 | `A78AE8BA7C9FF104D67C058D3F0BA7BD1E9662CA0EDE8C38EF3AB3D1DDA294A3` |
| appVersion / versionCode | `V2.11.54 / 2115400` |
| Android | `emulator-5554`, API 37, `sdk_gphone16_x86_64` |
| 安装方式 | 仅 `adb -s emulator-5554 install -r ...apk`，结果 `Success`；未 uninstall、未 `pm clear`、未销毁数据库 |
| LLM runtime | OpenAI-compatible DeepSeek endpoint，模型 `deepseek-v4-flash`；API Key 未进入证据 |
| final Repository SHA | 本 Evidence/Final-Seal docs push 后的 `origin/main`；精确值见最终 handoff（它是 docs-only 后代，不是新的 Production SHA） |

本轮没有修改 `src/`、运行时配置语义或持久化逻辑；因此没有触发重新冻结 Production SHA 之外的第二次矩阵。APK 由锁定 Production SHA 重新 clean build，SHA 与本矩阵完全一致。

## 2. Gate 总览

| Gate | 结果 | 证据 |
|---|---|---|
| F0 Exact Production SHA / ancestry | PASS | `git fetch origin main`；生产代码差异相对 `6d389f8d` 为空 |
| F1/F2 ONE Context、Freeze、DAG | PASS | 六个 live 样本均有 trace、freeze、requirements hash 与 checkpoint |
| F3 QA / Revision / FinalValidate | PASS | Standard clean、needs_revision、One-Shot skip 规则均按 policy 执行 |
| F4 四口径调用、Token、无隐藏付费 | PASS | logical / formatter / primary physical / fallback / retry ledger 对账通过 |
| F5 Outline Finalize→Event→PostWriting→ONE Memory | PASS | 三个 Outline 完成闭环；finalize 与 event 在同一原子 finalize transaction 内提交，Memory batch 随后 applied |
| F6 Continuation state / Memory / Resume | PASS | state extraction、rebuild_story_memory、clean、drift=0；O-S-2 为真实 R3 resume |
| F7/F8/F9/F10/F11/F12 contract gates | PASS | structured QA、fallback 分层、token ledger、candidate rule、UI/Trace/Ledger 对齐均通过 |
| F13 R1-R5 recovery | PASS | 12 个 focused suites / 120 tests；live R3 额外由 O-S-2 覆盖 |
| F14 Full Verify / Generation Stability / Migration / Android Debug | PASS | 见第 5 节 |

## 3. 六个真实 LLM 样本矩阵

说明：`tokens` 采用 `input/output`。表中 `primary`、`formatter`、`physical`、`fallback`、`retry` 统计的是章节 Writing Kernel 的四口径 ledger；`aux` 是 continuation state extraction 等辅助调用；`observed total` 是本次写作运行可观测合计。每行 Memory 栏另列 `story_memory_v2_primary` 与必要的 Memory formatter token，避免把 PostWriting/ONE Memory 隐藏或误算成第二 Writer/QA/Revision。

| 样本 | project / chapter | task / run | profile | trace / freeze | Expected DAG → Actual DAG | QA / Revision | 调用与 tokens | Final Candidate / Persist / Event hash | Memory / 终态 |
|---|---|---|---|---|---|---|---|---|---|
| Outline Standard×1 | `28 / 318` | `pt_mt4nxqpa_288` | standard | `gt-mt4nxqpy-9jfxgqy0` / `4380c7167664603dc85cef98500486175ce1001df66b827ef1ff90f13c44334c` | Expected `Source Adapter→ONE Context→Freeze→Draft→ONE QA→conditional Revision→FinalValidate→Persist→Event→PostWriting→ONE Memory`; Actual `Source Adapter→ONE Context→Freeze→Draft→ONE QA(pass, findings=[])→Revision skip→FinalValidate→Persist→Event→PostWriting→ONE Memory` | QA pass；findings `[]`；Revision `0` | logical `2`; formatter `0`; primary physical `2`; fallback `0`; retry `0`; primary `3551/1074`; aux `0/0`; total `3551/1074` | final=`81df135ceb9bde2041b51fcd51bda07260db4b0e02435a7063e0ac1ad55afa29`; Persist/Event/Chapter same | batch applied；Memory LLM `1684/592`；project memory clean；chapter final |
| Outline Standard×2 | `28 / 319` | `pt_mt4nv3ly_287` | standard | `gt-mt4nv3mi-gq2zcqc2` / `46e9feef38bf215ae98272dd1794fb86779ac7304e8d72ceccda9a4bcadeb289` | Expected same Standard DAG; Actual `Freeze→Draft→ONE QA(needs_revision)→Revision×1→FinalValidate→Persist→Event→PostWriting→ONE Memory`; Resume suffix reran only Revision | QA needs_revision；exactly one Revision；formatter `0` | full durable task ledger logical `3`; formatter `0`; primary physical `3`; fallback `0`; retry `0`; primary `9521/8697`; aux `0/0`; total `9521/8697`; resume suffix only `4023/2819` | final=`eef779ea20050f3720bb472fbb35c5e2dbe521a10c80386c783cac65eaa561ec`; Persist/Event/Chapter same | live Resume preserved Draft+QA；Memory LLM `3690/667`；Memory batch applied；clean |
| Outline One-Shot×1 | `28 / 320` | `pt_mt4oczsa_289` | one_shot | `gt-mt4oczto-59jaq7nv` / `7a6f017f182715dd0ee61498b09b779dc21389d684a5791e768809a34dc04788` | Expected `Freeze→Draft×1→QA skip→Revision skip→FinalValidate→Persist→Event→PostWriting→ONE Memory`; Actual exactly that; no paid QA/Revision/Formatter/Primary Retry | QA skip `profile.one_shot.skip_qa`；Revision skip `profile.one_shot.skip_revision` | logical `1`; formatter `0`; primary physical `1`; fallback `0`; retry `0`; primary `5054/1872`; aux `0/0`; total `5054/1872` | final=`953e1e5c63ad92f57bfddc2a81b4c1f342c68e6abc6dd104beb8f621799edfa5`; Persist/Event/Chapter same | batch applied；Memory LLM `2491/657`；project memory clean；chapter final |
| Continuation One-Shot×1 | `27 / 321` | `ct_700794a0993f4116b6fe24772abd9476` | one_shot | `gt_229c036429622a12551f7850e74dc15a` / `0803738646f8b8e496d01a4d4cd164d7f8ddd8d0223a9f8eb2d2bad4f979af2a` | Expected `extract_state→Freeze→Draft×1→QA skip→Revision skip→FinalValidate→Persist→Event→PostWriting→rebuild_story_memory`; Actual exactly that | QA skip；Revision skip；local FinalValidate pass | logical `1`; formatter `0`; primary physical `1`; aux physical `1`; fallback `0`; retry `0`; primary `20784/1245`; aux `1464/547`; observed `22248/1792` | draft=`ee0031ecae7bc43e38a74babfc17c6c37105f67fde59cfa9c5cdf220383e010b`; final/adopted/Persist/Event/Chapter=`1d2c6b621e5e4ba49f5b09419dd7df52bba88f9c83762515809583942d4b6bff` | extract `1`、apply `7`、rebuild `8` completed；Memory LLM `3721/792`；project memory through ch323 clean |
| Continuation Standard×1 | `27 / 322` | `ct_31a45a60468646a4ad704a472979aba0` | standard | `gt_212696a8d15f73a3f60828d5d284b50b` / `dbda6b7b5bfaf33bb6782c373a787ae5e2dbf243a0db224e2c6854788ec28793` | Expected `extract_state→Freeze→Draft→ONE QA→conditional Revision→FinalValidate→Persist→Event→PostWriting→rebuild_story_memory`; Actual `extract_state→Freeze→Draft→ONE QA(needs_revision, 13 findings)→Revision×1→FinalValidate→Persist→Event→PostWriting→rebuild_story_memory` | QA needs_revision，13 findings；Revision `1`；formatter `0` | logical `3`; formatter `0`; primary physical `3`; aux physical `1`; fallback `0`; retry `0`; primary `42473/4443`; aux `1255/296`; observed `43728/4739` | draft=`d77cdfc32c8354c0528e6436b18f5badb9ee4aced28292bb580564b900032e65`; revision=`04862ddcc6b776abb97699d10d5ce2b2456b31314751e2511f5668ffaf4ad70c`; final/adopted/Persist/Event/Chapter=`661bca08e2ea6c5c6c76994b12a17375bb25fb17dfcc096630f118b884c03011` | extract `1`、apply `4`、rebuild `5` completed；Memory primary `3294/8192` + Memory formatter `9536/6092`；clean |
| Continuation Standard×2 | `27 / 323` | `ct_74d455e5f71e470191b22edbd54fba25` | standard | `gt_82c995381776e2c11696d28cf3b71079` / `2747dd732e9f586ceb5425fb5996485f804bbc64cccd5e896039302e39687256` | Expected same Continuation Standard DAG; Actual `extract_state→Freeze→Draft→ONE QA(needs_revision, 11 findings；formatter strict revalidation×1)→Revision×1→FinalValidate→Persist→Event→PostWriting→rebuild_story_memory` | QA needs_revision，11 findings；formatter `1`；Revision `1`；fail-closed policy preserved | logical `3`; formatter `1`; primary physical `4`; aux physical `1`; fallback `0`; retry `0`; primary `44197/4922`; formatter `1910/750`; aux `1190/318`; observed physical `5`, total `47297/5990` | draft=`619e410380787afaa088c87616acbdbc247c333c2ee691f19e5b256f2ac43480`; revision=`c062b6422b0e2f894f72137802d65d61a6f38619ca1d1d3c4fdb09a36a8abce3`; final/adopted/Persist/Event/Chapter=`2e4e9063a27572c895763fb5511e9c97300235e12a5b4e260d79931c387d7aea` | extract `1`、apply `4`、rebuild `5` completed；Memory LLM `2867/1022`；clean |

矩阵规则核对：Standard clean 的 Final Candidate=Draft；Standard needs_revision 的 Final Candidate=Revision；One-Shot 的 Final Candidate=Draft。所有六个样本的最终 Candidate、最终 artifact、adopted body、chapter final content 与 WritingPersistedEvent `finalBodyFingerprint` 一致。新矩阵中 Legacy leakage、Review、Audit、FactCheck、Proof、Judge、QA2、Continuation `narrative_architect/adversarial_auditor/final_reviser` 均为 `0`。

### 3.1 Outline F5 时序核对

| 样本 | pipeline completed | adoption / content revision | chapter finalize + Event | PostWriting / ONE Memory |
|---|---|---|---|---|
| O-S-1 ch318 | `2026-08-22T17:39:47.124Z` | `17:40:18.073Z` | `17:41:43.522Z / 17:41:43.524Z` | batch applied `17:41:49.152Z` |
| O-S-2 ch319 | `2026-08-22T17:45:33.363Z` | `17:46:55.795Z` | `17:47:31.069Z / 17:47:31.071Z` | batch applied `17:47:35.986Z` |
| O-OS ch320 | `2026-08-22T17:51:44.683Z` | `17:53:12.075Z` | `17:53:27.282Z / 17:53:27.284Z` | batch applied `17:53:31.470Z` |

每行的 finalize 与 WritingPersistedEvent 在同一原子 finalize transaction 中提交；`persistedAt` 与数据库 `finalized_at` 的 1–2ms 差异是事务内 event 构造时间，不是“planned outline 被误记为 finalized”，也没有在 Event/PostWriting 前产生第二次付费写作。durable commit order 为 `pipeline complete≤adoption≤chapter finalize/event≤PostWriting≤Memory`，PASS。

### 3.2 Continuation F6、Resume、outbox

- ch321：`extract_state` 1、`apply_event` 7、`rebuild_story_memory` 8；冷启动后全部 completed、attempt=1，最终 memory `through_chapter_id=323`、clean。
- ch322：`extract_state` 1、`apply_event` 4、`rebuild_story_memory` 5；全部 completed、attempt=1，clean。
- ch323：`extract_state` 1、`apply_event` 4、`rebuild_story_memory` 5；全部 completed、attempt=1，clean。
- O-S-2 ch319 是真实 live R3：Draft 与 QA checkpoint 已成功，不重复付费；只恢复 Revision compatibility checkpoint 的 attempt 2。full durable ledger 仍是 Draft×1 + QA×1 + Revision×1，未出现重复 Draft/QA。
- 仓库中保留一条更早历史任务的失败 outbox row（project27/ch313，旧 dedupe key）；它不属于本次六样本、未被新任务引用，已作为 historical non-blocking 记录，不得被伪装成当前成功证据。

## 4. UI / Trace / Durable Ledger 对账

冷启动后的真实 APK UI 显示 `作品库`、`原著接入、Canon 与续写工作流`、`大纲创作（2）`、`原著续写（1）` 等正常入口；结果页/任务详情使用 compact stage labels。UI 展示的 Draft、ONE QA、Revision skip/run、FinalValidate、PostWriting/Memory 与 trace、stage checkpoint、attempt、LLM usage ledger 对齐。

对账结论：每个新 live 样本的实际 LLM 调用都能在 primary/formatter/aux ledger 找到；fallback=0、primary retry=0；formatter 只在 C-S-2 的 QA strict revalidation 出现 1 次，没有隐藏 physical call。O-S-2 UI 恢复只展示待恢复 suffix，但最终 Durable Ledger 仍按完整任务统计，避免把 resume suffix 误报为整任务。

## 5. Full Verify / CI / Android Debug

| 检查 | 结果 |
|---|---|
| `npm run verify:version` | PASS：V2.11.54 / 2115400 |
| `npm run lint` | PASS：0 errors，211 warnings（既有 lint warnings） |
| `npm run typecheck` | PASS |
| `npm run test:ci` | PASS：497 passed / 3 skipped suites；3803 passed / 8 skipped tests |
| Migration `npm test -- migration --runInBand` | PASS：44 suites / 211 tests |
| Generation Stability explicit suite 1 | PASS：35 suites / 230 tests |
| Generation Stability explicit Phase-2 final-seal suite | PASS：21 suites / 108 tests |
| F13 focused resume/outbox suite | PASS：12 suites / 120 tests |
| `npm run verify` | PASS：version、lint、typecheck、full test:ci 均完成，无失败退出 |
| Android build | PASS：clean `assembleDebug` + `scripts/build-apk.js debug` |
| Android install | PASS：仅 `adb install -r`，`Success` |
| Android cold start | PASS：`com.shinewriter/.MainActivity` resumed，UI 可见 |
| Android logcat | PASS：无 `FATAL EXCEPTION`、`AndroidRuntime`、React Native JS 未处理错误 |

未使用 `.skip/.only/fit/xit` 逃避 Gate；workflow 没有 `continue-on-error`、`allow-failure`、`|| true` 或 `SKIP_PHASE2`。测试中的预期错误日志来自测试注入，不是失败测试。

## 6. Failure / repair ledger

本轮真实生产源码未发现需要修复的缺陷，因此没有执行会改变 Production SHA 的 source fix，也没有重构或新增 Pipeline/Writer/QA/Context/Memory。已执行的封板动作只有：

1. 将旧 APK/旧 live evidence 明确隔离为 `SUPERSEDED / HISTORICAL`。
2. 从 Exact Production SHA `6d389f8d…` 重新 clean build 新 APK，并以 `adb install -r` 安装。
3. 重新采集并脱敏完整 2+2+1+1 Evidence，更新本报告。

一次早期 One-Shot 空结果被 fail-closed 排除，没有被计入矩阵，也没有通过补写 evidence 伪装成功。

## 7. Seal decision

所有方案 Gate 均有对应 PASS 证据；没有开放的代码 blocker，没有旧 APK/SHA/live evidence 重新绑定。最终 handoff 以实际 push 后的 Repository SHA、Production SHA `6d389f8d…`、APK SHA `A78AE8BA…` 为准。

```text
PHASE 2 FINAL SEALED / GO
```
