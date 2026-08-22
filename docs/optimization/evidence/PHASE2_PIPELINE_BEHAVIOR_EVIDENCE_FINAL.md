# PHASE 2 Pipeline Behavior 最终证据（脱敏）

本文件是进入远端、可供审计的最终证据。它只记录身份、DAG、ledger、hash 与终态，不包含 API Key、Prompt 全文、小说完整正文、SQLite 数据库或隐私数据。

原始采集包（本地、不入库）：`test-logs/emulator-qa-final-20260822-9FFBE1/`  
原始采集说明：`test-logs/emulator-qa-final-20260822-9FFBE1/PIPELINE_BEHAVIOR_EVIDENCE.md`

## 0. 身份与 ancestry

| 字段 | 值 | 类型 |
|---|---|---|
| Git Production SHA | `6d389f8da48cf7a61d810246ef9e4a71d7e3fc18` | Git commit |
| Production commit | `fix(writing): close pipeline behavior persistence loop` | Git subject |
| Live LLM APK SHA-256 | `9FFBE113B9DAFF5A914618741F5177396067E0BDCD702D57E627D211D21EC8AC` | APK digest |
| appVersion | V2.11.54 / versionCode 2115400 | 构建元数据 |
| Android device | emulator-5554 | 设备 |
| 安装方式 | 仅 `adb install -r`；未 `adb uninstall` / `pm clear` / 清 App 数据 | 操作约束 |

**Git SHA 与 APK SHA 不得混用。** `6d389f8d…` 是生产源码提交；`9FFBE113…` 是该生产源码工作区打出的 live 矩阵 APK。

Ancestry：

```text
0148c4a25145e1876d9387bd936d5f3d8e5910b0
  docs(writing): seal phase 2 after remote verification
    └── 5284c1a3e75eef5c368c6e0d35083ccd55ffd792
          docs: add pipeline behavior next-step execution plan
            └── 6d389f8da48cf7a61d810246ef9e4a71d7e3fc18   ← 最终生产源码 SHA
                  fix(writing): close pipeline behavior persistence loop
                    └── 0a5640699ac4ab235fcaa9f634ea683863faf492
                          ci(writing): lock pipeline behavior final seal gates
                            └── docs/CI-only 子提交（本证据与 Final Seal 报告）
                                  生产源码 SHA ≠ 仓库 docs/CI 子提交 SHA
```

绑定规则：

- 本轮不修改 `src/`、配置语义或运行时依赖，因此 **不重跑** 真实 LLM 2+2+1+1。
- `realLlmValidatedHead` = 生产源码 SHA `6d389f8d…`。
- live 矩阵 APK = `9FFBE113…`（2026-08-22 16:30–17:41 采集）。
- `dist/apk/debug/ShineWriter-V2.11.54-debug.apk` 随后还存在一次 debug 重建 `69C20D1C48AD06B85F6250EFF03335DA1295BFE8488CB778C32A8449C915B1D9`（C3 smoke / 提交前重建）。它 **不是** 第二份 live LLM 矩阵，也不得替换 `9FFBE113…`。
- 远端 GitHub 已在 `6d389f8d` 上跑通 Verify 与 Generation Stability。本轮把 Pipeline Behavior Red Tests 显式接入 Generation Stability 后，CI 实际验证 SHA 是 `6d389f8d` 的 CI/docs-only 子提交。

未入库：API Key、Prompt 全文、小说完整正文、SQLite、隐私数据。`generationTraceId` 保留可追溯前缀，供与本地证据包对照。

## 1. 矩阵覆盖

有效样本 6 个，全部绑定同一 Production SHA 与同一 live APK SHA。

| 样本 | scenario | executionProfile | 分支 | chapter | batch / run id |
|---|---|---|---|---:|---|
| O-S-1 | outline | standard | Clean（Revision SKIP） | 310 | `batch_mt44rdiv_awxxh6` / task `batch_batch_mt44rdiv_awxxh6_ord1_1787388204163` |
| O-S-2 | outline | standard | Needs Revision（Revision ×1） | 311 | `batch_mt44rdiv_awxxh6` / task `batch_batch_mt44rdiv_awxxh6_ord2_1787388251050` |
| C-S-1 | continuation | standard | Needs Revision（adopted Revision） | 313 | `batch_mt453e5w_wgc6mr` / run `ct_efda36a8d9df488eb88ed407e3a08bd0` |
| C-S-2 | continuation | standard | Needs Revision（adopted Revision） | 314 | `batch_mt453e5w_wgc6mr` / run `ct_922d3e0f5b124aaca6afb0dedf7fb6b2` |
| O-1 | outline | one_shot | Draft only | 312 | `batch_mt44y9rg_a8gwbf` / task `batch_batch_mt44y9rg_a8gwbf_ord1_1787388515528` |
| C-1 | continuation | one_shot | Draft only | 316 | `batch_mt45pe6u_onyclb` / run `ct_55191ddf1c944871874629c094bf2556` |

覆盖要求核对：

- Outline Standard ×2：O-S-1、O-S-2
- Continuation Standard ×2：C-S-1、C-S-2
- Outline One-Shot ×1：O-1
- Continuation One-Shot ×1：C-1
- 至少 1 个 Standard Clean：O-S-1
- 至少 1 个 Standard Needs Revision：O-S-2（C-S-1 / C-S-2 同样是 Needs Revision）

统一 Post-Freeze DAG：

```text
Source Adapter → ONE Context → Freeze
→ Draft
→ ONE QA
→ Conditional Revision
→ FinalValidate(local)
→ Persist
→ WritingPersistedEvent
→ PostWriting
→ ONE Memory
```

`collect → normalize → plan → allocate → render → freeze` 是 Freeze 前的 Source Adapter / ONE Context，不是第二套 Writer / QA / Pipeline。

## 2. 样本总表

| 样本 | Logical | Formatter | Physical (primary) | Fallback | Primary Retry | Tokens in / out | Final Candidate | Persist body hash |
|---|---:|---:|---:|---:|---:|---|---|---|
| O-S-1 | 2 | 0 | 2 | 0 | 0 | 27,558 / 3,903 | Draft | `4e5e3c8c7b5005f319987840772866299e8e3ca764445637b3477fe053f957d0` |
| O-S-2 | 3 | 0 | 3 | 0 | 0 | 39,068 / 6,643 | Revision | `de4653e641d0613d14f6ccda28ad463c2ed438e67981a12093076d902b423fe6` |
| C-S-1 | 3 | 0 | 3 | 0 | 0 | 48,799 / 6,154 | adopted Revision | `f92130697dad63c5c01fa158f694af39592d634bb36256023d779311926cb4e2` |
| C-S-2 | 3 | 0 | 3 | 0 | 0 | 43,834 / 3,369 | adopted Revision | `64c3b01559cfb309b719e6ceed5637a9eab6aac2f60a55cbf9fbd7c6a3ce7eef` |
| O-1 | 1 | 0 | 1 | 0 | 0 | 17,146 / 4,359 | Draft | `776a333faa57c4506e5945ab25d010fee43818f0516ee853cb69b39e87292dd1` |
| C-1 | 1 | 0 | 1 | 0 | 0 | 20,887 / 1,245 | Draft | `43fe120788f618c2723ef8489b23df6fd51a99fc29d48ade8cab734f33cddef9` |

Continuation 观测 physical 还包含独立 PostWriting state-extraction auxiliary：C-S-1 / C-S-2 为 4 = 3 primary + 1 auxiliary，C-1 为 2 = 1 + 1。auxiliary 不计入 chapter-writing paid stage。

## 3. O-S-1 Outline Standard / chapter 310 / Clean

| 字段 | 值 |
|---|---|
| Git Production SHA | `6d389f8da48cf7a61d810246ef9e4a71d7e3fc18` |
| APK SHA-256 | `9FFBE113B9DAFF5A914618741F5177396067E0BDCD702D57E627D211D21EC8AC` |
| sample / chapter / run id | O-S-1 / 310 / `batch_batch_mt44rdiv_awxxh6_ord1_1787388204163` |
| scenario | outline |
| executionProfile | standard |
| pipelineTopologyVersion | compact_standard |
| generationTraceId | `gt-mt44sczl-jh7obdpb` |
| freezeFingerprint | `c0ab30e8ef7d44e691ad8ad5359b6795766c852148579957120c495af2100378` |
| requirementsFingerprint | `3d060bcb3f60f949c9f6a23238a6dd25af7b872f9741df9a2cd63377b8adf1a7` |
| Draft / QA / Revision | Draft completed；QA completed（clean）；Revision SKIP `policy.one_pipeline.conditional_revision_no_findings` |
| Logical Call Count | 2 |
| Formatter Call Count | 0 |
| Physical Request Count | 2 |
| Protocol Fallback Count | 0 |
| Primary Retry Count | 0 |
| Stage tokens in/out | Draft 17,936 / 2,906；ONE QA 9,622 / 997；Revision 0 / 0；FinalValidate / Persist local |
| Final Candidate source | Draft |
| Final Candidate hash | `4e5e3c8c7b5005f319987840772866299e8e3ca764445637b3477fe053f957d0` |
| Persist body hash | 同上，与 `pipeline_tasks.final_text` 一致 |
| FinalValidate | completed，local |
| WritingPersistedEvent | fingerprint 与 Persist body hash 一致 |
| PostWriting | `postWritingUpdate=completed`；WritingPersistedEvent → Story Memory queued |
| Story Memory / outbox | chapter 310 仍为 planned；Outline 插件不把 planned outline 正文推进长期正文记忆；`project_story_memory` clean，无静默失败 |
| Duplicate Paid Call | 0 |
| Freeze Drift | 0 |
| Final Candidate Drift | 0 |
| Pipeline Divergence | 0 |
| verdict | DAG_MATCH=YES |

Expected DAG：

```text
Freeze → Draft → ONE QA → Conditional Revision(SKIP)
→ FinalValidate → Persist → PostWriting → ONE Memory
```

Actual DAG：

```text
collect:C → normalize:C → plan:C → allocate:C → render:C → freeze:C
→ draft:S→C → qa:S→C → revision:S→SKIP(policy.one_pipeline.conditional_revision_no_findings)
→ finalValidate:S→C → persist:C → postWritingUpdate:C
→ ONE Memory: queued/no-op（Outline planned chapter 插件边界）
```

## 4. O-S-2 Outline Standard / chapter 311 / Needs Revision

| 字段 | 值 |
|---|---|
| Git Production SHA | `6d389f8da48cf7a61d810246ef9e4a71d7e3fc18` |
| APK SHA-256 | `9FFBE113B9DAFF5A914618741F5177396067E0BDCD702D57E627D211D21EC8AC` |
| sample / chapter / run id | O-S-2 / 311 / `batch_batch_mt44rdiv_awxxh6_ord2_1787388251050` |
| scenario | outline |
| executionProfile | standard |
| pipelineTopologyVersion | compact_standard |
| generationTraceId | `gt-mt44td5v-qzvw3q7s` |
| freezeFingerprint | `1297ca45ea34f91c4dad39da017dceebe8fe9cd0dc525511e2213fce2e291eef` |
| requirementsFingerprint | `33e69cb5f28815fb835e93b68fd1eb2a411e6f10fe5d122e77f5479ca609675c` |
| Draft / QA / Revision | Draft completed；QA completed（executable finding）；Revision RUN ×1 completed |
| Logical Call Count | 3 |
| Formatter Call Count | 0 |
| Physical Request Count | 3 |
| Protocol Fallback Count | 0 |
| Primary Retry Count | 0 |
| Stage tokens in/out | Draft 17,192 / 4,179；ONE QA 10,945 / 1,772；Conditional Revision 10,931 / 692；FinalValidate / Persist local |
| Final Candidate source | Revision |
| Final Candidate hash | `de4653e641d0613d14f6ccda28ad463c2ed438e67981a12093076d902b423fe6` |
| Persist body hash | 同上，与 persisted `final_text` 一致 |
| FinalValidate | completed，local |
| WritingPersistedEvent | 存在，fingerprint 与 Persist 一致 |
| PostWriting | `postWritingUpdate=completed`；planned outline 不触发 continuation state outbox |
| Story Memory / outbox | queued/no-op（Outline planned chapter 插件边界） |
| Duplicate Paid Call | 0 |
| Freeze Drift | 0 |
| Final Candidate Drift | 0 |
| Pipeline Divergence | 0 |
| verdict | DAG_MATCH=YES |

Expected DAG：

```text
Freeze → Draft → ONE QA → Conditional Revision(RUN ×1)
→ FinalValidate → Persist → PostWriting → ONE Memory
```

Actual DAG：

```text
collect:C → normalize:C → plan:C → allocate:C → render:C → freeze:C
→ draft:S→C → qa:S→C → revision:S→C
→ finalValidate:S→C → persist:C → postWritingUpdate:C
→ ONE Memory: queued/no-op（Outline planned chapter 插件边界）
```

Ledger：`pipeline_draft`、`pipeline_qa`、`pipeline_brief`（仅 revision 的兼容 ledger scenario；trace 语义为 revision）。

## 5. C-S-1 Continuation Standard / chapter 313

| 字段 | 值 |
|---|---|
| Git Production SHA | `6d389f8da48cf7a61d810246ef9e4a71d7e3fc18` |
| APK SHA-256 | `9FFBE113B9DAFF5A914618741F5177396067E0BDCD702D57E627D211D21EC8AC` |
| sample / chapter / run id | C-S-1 / 313 / `ct_efda36a8d9df488eb88ed407e3a08bd0` |
| scenario | continuation |
| executionProfile | standard |
| pipelineTopologyVersion | compact_standard |
| generationTraceId | `gt_d08dab6f1d8e39204cf7fbdd06e81cc4` |
| freezeFingerprint | `4327e292f501b4c180e421835e7295d18e2a6375916cd1e05b8fe85977cd2397` |
| requirementsFingerprint | `7073f34501d781572f9f3c167cc8bb82c7d071c9a965553f1bf23bf3a8517eeb` |
| Draft / QA / Revision | `draft_writer=success`；`unified_qa=success`；`revision_writer=success`；无 narrative_architect / adversarial_auditor / final_reviser |
| Logical Call Count | 3 |
| Formatter Call Count | 0 |
| Physical Request Count | 3 primary（观测 4 = 3 + 1 auxiliary） |
| Protocol Fallback Count | 0 |
| Primary Retry Count | 0 |
| Stage tokens in/out | Draft 20,708 / 3,252；ONE QA 13,265 / 1,275；Conditional Revision 13,546 / 1,480；state extraction auxiliary 1,280 / 147；FinalValidate / Persist local |
| Final Candidate source | adopted Revision |
| Final Candidate hash | `f92130697dad63c5c01fa158f694af39592d634bb36256023d779311926cb4e2`（`adopted_revision_hash=finalized_revision_hash`） |
| Persist body hash | 同上；chapter 313 内容 SHA 相同 |
| FinalValidate | `final_validate=success`，local |
| WritingPersistedEvent | 完成 |
| PostWriting | apply_event、extract_state、rebuild_story_memory 最终 completed |
| Story Memory / outbox | project 27 clean，through chapter 314 / position 22。一次可恢复的 rebuild 变化冲突最终 settled，非 primary retry、非 Pipeline Divergence |
| Duplicate Paid Call | 0 |
| Freeze Drift | 0 |
| Final Candidate Drift | 0 |
| Pipeline Divergence | 0 |
| verdict | DAG_MATCH=YES |

Expected DAG：

```text
Freeze → Draft → ONE QA → Conditional Revision(RUN ×1)
→ FinalValidate → Persist → PostWriting → ONE Memory
```

Actual DAG：

```text
collect:C → normalize:C → plan:C → allocate:C → render:C → freeze:C
→ draft:S→C → qa:S→C → revision:S→C
→ finalValidate:S→C → persist:C → postWritingUpdate:C
→ state extraction:C → ONE Memory/rebuild_story_memory:C
```

## 6. C-S-2 Continuation Standard / chapter 314

| 字段 | 值 |
|---|---|
| Git Production SHA | `6d389f8da48cf7a61d810246ef9e4a71d7e3fc18` |
| APK SHA-256 | `9FFBE113B9DAFF5A914618741F5177396067E0BDCD702D57E627D211D21EC8AC` |
| sample / chapter / run id | C-S-2 / 314 / `ct_922d3e0f5b124aaca6afb0dedf7fb6b2` |
| scenario | continuation |
| executionProfile | standard |
| pipelineTopologyVersion | compact_standard |
| generationTraceId | `gt_b325740bdd9e4fa2a22eb19bf06efa80` |
| freezeFingerprint | `c235b90ab7b77dc6cac453bafe7ddf1cfdbfb216cee642bfb1d73f0ce9a707aa` |
| requirementsFingerprint | `f6bae69bbd9063c996c1da5a674c3b1bae2f246e0ad620137dcba2d0122d945b` |
| Draft / QA / Revision | Draft / QA / Revision 均 completed |
| Logical Call Count | 3 |
| Formatter Call Count | 0 |
| Physical Request Count | 3 primary（观测 4 = 3 + 1 auxiliary） |
| Protocol Fallback Count | 0 |
| Primary Retry Count | 0 |
| Stage tokens in/out | Draft 21,509 / 658；ONE QA 10,624 / 934；Conditional Revision 10,836 / 1,555；state extraction auxiliary 865 / 222；FinalValidate / Persist local |
| Final Candidate source | adopted Revision |
| Final Candidate hash | `64c3b01559cfb309b719e6ceed5637a9eab6aac2f60a55cbf9fbd7c6a3ce7eef` |
| Persist body hash | 同上；chapter 314 内容 SHA 相同 |
| FinalValidate | completed，local |
| WritingPersistedEvent | 完成 |
| PostWriting | WritingPersistedEvent、state extraction、rebuild_story_memory 全部 settled |
| Story Memory / outbox | project 27 memory clean through chapter 314 / position 22 |
| Duplicate Paid Call | 0 |
| Freeze Drift | 0 |
| Final Candidate Drift | 0 |
| Pipeline Divergence | 0 |
| verdict | DAG_MATCH=YES |

Expected / Actual DAG 与 C-S-1 同构（Revision RUN ×1 + PostWriting state extraction + ONE Memory）。

## 7. O-1 Outline One-Shot / chapter 312

| 字段 | 值 |
|---|---|
| Git Production SHA | `6d389f8da48cf7a61d810246ef9e4a71d7e3fc18` |
| APK SHA-256 | `9FFBE113B9DAFF5A914618741F5177396067E0BDCD702D57E627D211D21EC8AC` |
| sample / chapter / run id | O-1 / 312 / `batch_batch_mt44y9rg_a8gwbf_ord1_1787388515528` |
| scenario | outline |
| executionProfile | one_shot |
| pipelineTopologyVersion | compact_standard |
| generationTraceId | `gt-mt44z18p-5cmuyxs9` |
| freezeFingerprint | `41d1a267f503a9f179effd311e0f48854c0501280d07872ab18d4c6ea182a07b` |
| requirementsFingerprint | `471463beea2d65b6b878a98c5240645e9bc02fca578284b4c4a95c9344a30e55` |
| Draft / QA / Revision | Draft completed；QA SKIP `profile.one_shot.skip_qa`；Revision SKIP `profile.one_shot.skip_revision` |
| Logical Call Count | 1 |
| Formatter Call Count | 0 |
| Physical Request Count | 1 |
| Protocol Fallback Count | 0 |
| Primary Retry Count | 0 |
| Stage tokens in/out | Draft 17,146 / 4,359；QA 0 / 0；Revision 0 / 0；FinalValidate / Persist local |
| Final Candidate source | Draft |
| Final Candidate hash | `776a333faa57c4506e5945ab25d010fee43818f0516ee853cb69b39e87292dd1` |
| Persist body hash | 同上，与 `pipeline_tasks.final_text` 一致 |
| FinalValidate | completed，local |
| WritingPersistedEvent | `finalBodyFingerprint` 与 Persist 一致 |
| PostWriting | closure marker 完成 |
| Story Memory / outbox | chapter 312 为 planned outline；ONE Memory 按 Outline 插件规则 clean / no-op |
| Duplicate Paid Call | 0 |
| Freeze Drift | 0 |
| Final Candidate Drift | 0 |
| Pipeline Divergence | 0 |
| verdict | DAG_MATCH=YES |

Expected DAG：

```text
Freeze → Draft ×1 → ONE QA(SKIP)
→ Conditional Revision(SKIP) → FinalValidate
→ Persist → PostWriting → ONE Memory
```

Actual DAG：

```text
collect:C → normalize:C → plan:C → allocate:C → render:C → freeze:C
→ draft:S→C → qa:S→SKIP(profile.one_shot.skip_qa)
→ revision:S→SKIP(profile.one_shot.skip_revision)
→ finalValidate:C → persist:C → postWritingUpdate:C
→ ONE Memory: queued/no-op（Outline planned chapter 插件边界）
```

Ledger：只有 `pipeline_draft`；没有 QA / Revision / Review / Audit / FactCheck / Proof / Formatter。

## 8. C-1 Continuation One-Shot / chapter 316

| 字段 | 值 |
|---|---|
| Git Production SHA | `6d389f8da48cf7a61d810246ef9e4a71d7e3fc18` |
| APK SHA-256 | `9FFBE113B9DAFF5A914618741F5177396067E0BDCD702D57E627D211D21EC8AC` |
| sample / chapter / run id | C-1 / 316 / `ct_55191ddf1c944871874629c094bf2556` |
| scenario | continuation |
| executionProfile | one_shot |
| pipelineTopologyVersion | compact_standard |
| generationTraceId | `gt_a40bb2aff461b4b4f06a6b5f0deb1fb2` |
| freezeFingerprint | `1c27b84437636663779de4dd8e38d1d1489d02ea123612324bce4ddca9128691` |
| requirementsFingerprint | `9407de9840079c974a5b905063b6e7016632e352dee858ca99c1a4e86bd82f3b` |
| Draft / QA / Revision | Draft success；QA / Revision 正式 skip；FinalValidate local success |
| Logical Call Count | 1 |
| Formatter Call Count | 0 |
| Physical Request Count | 1 primary（观测 2 = 1 + 1 auxiliary） |
| Protocol Fallback Count | 0 |
| Primary Retry Count | 0 |
| Stage tokens in/out | Draft 20,887 / 1,245；QA 0 / 0；Revision 0 / 0；state extraction auxiliary 1,464 / 344；FinalValidate / Persist local |
| Final Candidate source | Draft |
| Final Candidate hash | `43fe120788f618c2723ef8489b23df6fd51a99fc29d48ade8cab734f33cddef9` |
| Persist body hash | 同上；continuation final artifact 与 chapter 316 内容 SHA 相同 |
| FinalValidate | completed，local |
| WritingPersistedEvent | 完成 |
| PostWriting | apply_event、extract_state、rebuild_story_memory 全部 completed / attempt1 |
| Story Memory / outbox | project 27 memory clean through chapter 316 / position 24，无 dirty / error |
| Duplicate Paid Call | 0 |
| Freeze Drift | 0 |
| Final Candidate Drift | 0 |
| Pipeline Divergence | 0 |
| verdict | DAG_MATCH=YES |

Expected DAG：

```text
Freeze → Draft ×1 → ONE QA(SKIP)
→ Conditional Revision(SKIP) → FinalValidate
→ Persist → PostWriting → ONE Memory
```

Actual DAG：

```text
collect:C → normalize:C → plan:C → allocate:C → render:C → freeze:C
→ draft:S→C → qa:S→SKIP(profile.one_shot.skip_qa)
→ revision:S→SKIP(profile.one_shot.skip_revision)
→ finalValidate:S→C → persist:C → postWritingUpdate:C
→ state extraction:C → ONE Memory/rebuild_story_memory:C
```

## 9. 合计计数

| 计数器 | 值 |
|---|---|
| Pipeline Divergence | 0 |
| Unexpected LLM Stage | 0 |
| Duplicate Paid Call | 0 |
| Hidden Formatter / Fallback | 0 |
| Primary Retry | 0 |
| Freeze Drift | 0 |
| Final Candidate Drift | 0 |
| Persist / PostWriting Break | 0 |
| Memory Drift | 0 |

补充（采集包已记录，不属于生产 DAG Divergence）：

- 6 个有效样本 `formatterCallCount=0`、`protocolFallbackCount=0`、`primaryRetryCount=0`。
- Continuation item 的 `retry_count`（C-S-1=1、C-S-2=4、C-1=2）是批次 / 恢复 / 异步闭环的持久化计数，不是 primary LLM retry。
- 有效矩阵没有 Review / Audit / FactCheck / Proof / Judge 生产调用。
- 被隔离的非矩阵批次（配置误操作，不纳入 2+2+1+1）：`batch_mt44gfst_pe38hn`、`batch_mt45cm5q_fr9f50`、`batch_mt45gu1c_jst8bo`、`batch_mt45kdna_ronum3`。

## 10. 判定

6 个有效样本 Expected DAG == Actual DAG，且全部可追溯到：

- 生产源码 SHA `6d389f8da48cf7a61d810246ef9e4a71d7e3fc18`
- live APK SHA-256 `9FFBE113B9DAFF5A914618741F5177396067E0BDCD702D57E627D211D21EC8AC`

本文件不上传数据库、正文、Prompt 或密钥。本地完整采集包仅作对照，不以 sqlite 入库。
