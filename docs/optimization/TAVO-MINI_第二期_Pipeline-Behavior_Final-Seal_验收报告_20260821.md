# TAVO-MINI 第二期 Pipeline Behavior Final Seal 验收报告

状态：FINAL LIVE SEAL / GO candidate。验收日期：2026-08-23（Asia/Shanghai）。

项目：TAVO-MINI / ShineWriter

唯一施工基线：`F:\ClaudeWorkSpace\projects\TAVO-MINI`

验收方案：`docs/optimization/TAVO-MINI_第二期_最终生产源码穿透测试与自修复封板方案_V1.0.md`

最终脱敏证据：[`docs/optimization/evidence/PHASE2_PIPELINE_BEHAVIOR_EVIDENCE_FINAL_V2.md`](evidence/PHASE2_PIPELINE_BEHAVIOR_EVIDENCE_FINAL_V2.md)
历史证据：`PHASE2_PIPELINE_BEHAVIOR_EVIDENCE_FINAL.md`（已标记 `SUPERSEDED / HISTORICAL`，不得使用）

## 1. SHA / APK 绑定

| 字段 | 值 |
|---|---|
| finalProductionCodeHead | `6d389f8da48cf7a61d810246ef9e4a71d7e3fc18` |
| androidValidatedHead | `6d389f8da48cf7a61d810246ef9e4a71d7e3fc18` |
| realLlmValidatedHead | `6d389f8da48cf7a61d810246ef9e4a71d7e3fc18` |
| APK | `dist/apk/debug/ShineWriter-V2.11.54-debug.apk` |
| apkSha256 | `A78AE8BA7C9FF104D67C058D3F0BA7BD1E9662CA0EDE8C38EF3AB3D1DDA294A3` |
| appVersion / versionCode | `V2.11.54 / 2115400` |
| finalRepositoryHead | 本次 Evidence/Final-Seal docs push 后的 `origin/main`；它是 docs-only 后代，精确 SHA 以最终 handoff `git rev-parse origin/main` 为准 |

Production SHA、APK SHA、live LLM evidence 三者已分开记录。本轮没有改动 `src/`、运行时配置语义或持久化逻辑；不存在旧 APK、旧 SHA 或旧 live evidence 重新绑定。

## 2. Final live matrix

真实有效样本共 6 个：Outline Standard×2、Continuation Standard×2、Outline One-Shot×1、Continuation One-Shot×1。完整 Expected DAG、Actual DAG、Freeze、QA、Revision、四口径调用、Token、Final Candidate、Persist/Event、PostWriting、Memory、Resume 与 hash 对账见 V2 Evidence；摘要如下：

| 样本 | 任务 | 实际结论 |
|---|---|---|
| Outline Standard×1 | `pt_mt4nxqpa_288` / ch318 | QA clean，Revision 0，Final Candidate=Draft，Memory applied |
| Outline Standard×2 | `pt_mt4nv3ly_287` / ch319 | QA needs_revision，Revision 1；真实 R3 Resume 不重复 Draft/QA 付费 |
| Outline One-Shot×1 | `pt_mt4oczsa_289` / ch320 | Draft×1，QA/Revision policy skip，Final Candidate=Draft |
| Continuation One-Shot×1 | `ct_700794a0993f4116b6fe24772abd9476` / ch321 | Draft×1，QA/Revision skip，state extraction + Memory closure |
| Continuation Standard×1 | `ct_31a45a60468646a4ad704a472979aba0` / ch322 | QA 13 findings，Revision×1，final/adopted/event/chapter hash一致 |
| Continuation Standard×2 | `ct_74d455e5f71e470191b22edbd54fba25` / ch323 | QA 11 findings，formatter strict revalidation×1，Revision×1，outbox settled |

关键不变量：Pipeline Divergence=0；Unexpected LLM Stage=0；Duplicate Paid Call=0；Hidden Physical Call=0；Freeze Drift=0；Final Candidate Drift=0；PostWriting Break=0；Memory Drift=0；新矩阵 Legacy leakage=0。

## 3. Gate 判定

| Gate | 结果 |
|---|---|
| F0 Exact Production SHA → rebuild APK → install `-r` | PASS |
| F1/F2 Context / Freeze / Expected DAG vs Actual DAG | PASS |
| F3 QA / conditional Revision / Local FinalValidate | PASS |
| F4 logical / formatter / primary physical / fallback / retry / token ledger | PASS |
| F5 Outline Finalize→WritingPersistedEvent→PostWriting→ONE Memory | PASS |
| F6 Continuation state extraction / Memory / Resume / no duplicate paid | PASS |
| F7 structured QA / one Revision / invalid-QA fail-closed | PASS |
| F8 fallback、primary retry、formatter、protocol 分层 | PASS |
| F9 primary vs PostWriting auxiliary token 分离 | PASS |
| F10 Revision success→Revision else Draft candidate rule | PASS |
| F11 UI / Trace / Durable Ledger consistency | PASS |
| F12 legacy isolation、禁止旧 stages、acceptance tightening | PASS |
| F13 R1 Draft、R2 QA、R3 Revision、R4 Persist/PostWriting、R5 outbox recovery | PASS |
| F14 Verify / Generation Stability / Migration / Android Debug | PASS |

## 4. CI / Android 状态

- `npm run verify:version` PASS；`npm run lint` PASS（0 errors，211 existing warnings）；`npm run typecheck` PASS。
- `npm run test:ci` PASS：497 passed / 3 skipped suites；3803 passed / 8 skipped tests。
- Migration PASS：44 suites / 211 tests。
- Generation Stability explicit runs PASS：35 suites / 230 tests，以及 Phase-2 final-seal 21 suites / 108 tests。
- F13 focused resume/outbox contracts PASS：12 suites / 120 tests。
- clean Android debug build PASS；APK SHA 为 `A78AE8BA…`；`adb install -r` 成功；冷启动 Activity resumed，UI 可见，logcat 无崩溃/未处理 JS 错误。
- 没有使用 skip/only、`continue-on-error`、`allow-failure`、`|| true` 或 `SKIP_PHASE2` 隐藏失败。

## 5. 实际修复项

本轮没有发现需要改变生产源码的缺陷，因此实际 source/runtime/persistence 修复项为“无”。执行的是证据封板修复：废止旧 Evidence 身份、从锁定 Production SHA 重新构建并安装 APK、重新完成真实 2+2+1+1、生成脱敏 V2 Evidence。早期 One-Shot 空结果已 fail-closed 排除，没有被计入最终矩阵。

## 6. 最终决策

所有 Gate PASS，Production SHA、APK SHA 与六个真实样本均可追溯；无外部 blocker。

```text
PHASE 2 FINAL SEALED / GO
```
