# Phase III-B Final Acceptance Report

更新时间：2026-08-28

当前状态：**PHASE III-B FINAL SEALED / GO**

> 本页下方保留 2026-08-27 的历史记录，历史段落中的旧结论不覆盖本节。
> 本节基于实现 tip `be835da`、最新 Debug APK、`emulator-5554` 上的真实 B 轮矩阵、
> 实际 model-visible receipt 重建比对和全量门禁；C 轮未启动。

## 当前 B 轮最终硬门禁（2026-08-28）

| 门禁 | 实测结果 | 结论 |
| --- | --- | --- |
| State Proposal / Evidence QA / PostWriting | 六组最终矩阵的最终运行均完成；无冻结需求要求状态变化，最终 `stateProposalSource=none`、proposal rows=0；Continuation `rebuild_story_memory` 13/13 completed；每章 `extract_state=0` | PASS |
| 最终 model-visible messages / request receipt | 20 个实际 QA receipt（Outline Standard/Quality 为 Evidence hit，Continuation Standard/Quality 为 fail-safe fallback）均与冻结上下文 + 实际 Draft 重建的 messages/request fingerprint 相等；receipt 保留 usage、finishReason、physical/fallback count，原始 prompt body 按设计不入库 | PASS |
| `pipeline_tasks` / continuation 大载荷热路径 | `pipeline_tasks`、`pipeline_stage_attempts`、continuation artifacts/stage-results 读取均采用窄投影、chunk 或按需正文加载；B 热路径未发现读取大 JSON/BLOB 的 `SELECT *` | PASS |
| `npm run verify:elastic` | PASS | PASS |
| `npm run typecheck` | PASS | PASS |
| `npm run verify` | PASS：lint 0 errors / 216 existing warnings；505 suites passed（3 skipped）；3637 tests passed（8 skipped） | PASS |
| 最新 Debug APK | `npm run apk:debug` PASS；`dist/apk/debug/ShineWriter-V2.21.1-debug.apk`，SHA-256 `1383E792F5B251F5025AD090BBD70B06547D89D3C87E09BEF5A6B123995FEB51` | PASS |
| 安装与启动 | 仅执行 `adb -s emulator-5554 install -r`，结果 `Success`；包 `com.shinewriter`，`versionCode=2210100`；UI dump 渲染正常 | PASS |
| Outline 真实矩阵 | 极速 3/3、标准 5/5、质量 5/5 完成 | PASS |
| Continuation 真实矩阵 | 极速 3/3、标准 5/5、质量 5/5 完成 | PASS |

**最终决策：GO。** 仅封存 Phase III-B B 轮；C 轮未启动。

## 六组真实矩阵总览

| 矩阵 | batch id | 完成 | physical stage calls | batch input/output tokens | 证据数据库 |
| --- | --- | ---: | ---: | ---: | --- |
| Outline 极速 | `batch_mtbumxje_l315c7` | 3/3 | 3 | 56237 / 10950 | `test-logs/emulator-qa-20260828-001604/db-outline-fast-now.sqlite` |
| Outline 标准 | `batch_mtbuw2xo_s8qu8b` | 5/5 | 17 | 396243 / 125028 | `test-logs/emulator-qa-20260828-001604/db-outline-standard-retry-a0dbfca8.sqlite` |
| Outline 质量 | `batch_mtbwrzqn_lj0wyp` | 5/5 | 10 | 309081 / 66654 | `test-logs/emulator-qa-20260828-001604/db-outline-quality-final-14.sqlite` |
| Continuation 极速 | `batch_mtbxgnb0_tm5h7e` | 3/3 | 3 | 135103 / 6936 | `test-logs/emulator-qa-20260828-001604/db-cont-fast-final.sqlite` |
| Continuation 标准 | `batch_mtbs11zh_oih677` | 5/5 | 29 | 920269 / 78090 | `test-logs/emulator-qa-20260828-001604/db-cont-standard-resume-final-1.sqlite` |
| Continuation 质量 | `batch_mtbydeny_w81osr` | 5/5 | 15 | 759003 / 53731 | `test-logs/emulator-qa-20260828-001604/db-cont-quality-final-consistent.sqlite` |

说明：矩阵 UI 的“质量”档对应 receipt `qualityProfile=quality`、`reasoningEffort=max`；数据库的通用 `execution_profile` 字段为 `standard` 是既有执行拓扑字段，不代表降档。Outline 标准的 batch counter 是被接受结果的 usage；逐 receipt 审计同时保留了被拒绝 retry 的物理调用和 usage。

## 逐章最终证据

表中 token 均为 `input/output`；`D/Q/R` 分别为 Draft/QA/Revision。`Revision(brief)` 是 Outline durable 层对 Compact Revision body 的名称。`Segment/Full` 记录 B7 局部修复/完整修订；`—` 表示该档正式跳过或该章没有 Revision。Final fingerprint 为最终正文 SHA-256；`extract_state` 是 PostWriting 正常状态抽取 LLM 次数。

| 矩阵/章 | physical | D | Q | R | finishReason | Evidence QA | Segment/Full | State source | Final fingerprint | extract_state |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- | ---: |
| Outline 极速 / 16 | 1 | 16107/2179 | — | — | stop | skip | — | none | `6b432846d054c112784918a88dec7713b61cd0bd95360ea08e90686ae1109d25` | 0 |
| Outline 极速 / 17 | 1 | 18828/3074 | — | — | stop | skip | — | none | `286a97bb22f4d8348a3b0636d97878c438086e375b70a7316824757b5fa9e14b` | 0 |
| Outline 极速 / 18 | 1 | 21302/5697 | — | — | stop | skip | — | none | `980407598b40c4dc3555e703aa08134c192c3e8b686b36cb37c16e6fd217faec` | 0 |
| Outline 标准 / 19 | 5 | 24320/14201 | 13603/3403 | 63650/67730 (brief) | stop | hit | 0/1 (brief) | none | `c4c82c5545840ef0a4526f59a52d72edaf6a314c16d84ade5af482bfb4706838` | 0 |
| Outline 标准 / 20 | 3 | 55308/26574 | 14710/1746 | — | stop | hit | 0/0 | none | `335fa5bd921b6148e9f19ca865e5df7404af7b02774c0b381f0d0ddb97f9ce91` | 0 |
| Outline 标准 / 21 | 5 | 32176/10365 | 15895/1777 | 70049/52408 (brief) | stop | hit | 0/1 (brief) | none | `d1850e1c7f020718353e455c8c5ec45d587237f8ddf3dae38c71892c520e1f7a` | 0 |
| Outline 标准 / 22 | 2 | 37743/11249 | 14977/871 | — | stop | hit | 0/0 | none | `457d3e65aa5c45d4145f35a78cd7a17233bb75295f90cd098943b8e34aea58e9` | 0 |
| Outline 标准 / 23 | 2 | 42065/5580 | 11747/685 | — | stop | hit | 0/0 | none | `4d9ef02ead839fb38ddf1e528c3c92ecda98fdca36636413bc8b1049b80244bb` | 0 |
| Outline 质量 / 24 | 2 | 43146/17569 | 13349/657 | — | stop | hit | 0/0 | none | `47f825584efc6906fb0f6e50971277e51f6f8347f0ee65bac131303ac372af1f` | 0 |
| Outline 质量 / 25 | 2 | 46277/12704 | 14596/2022 | — | stop | hit | 0/0 | none | `fb76936023ea4a21298f96f4bb574a0af0367b833b0843da8b4f23f11d00b8b1` | 0 |
| Outline 质量 / 26 | 2 | 49655/13357 | 13230/161 | — | stop | hit | 0/0 | none | `a1e284a129d7602408a27c235fb3d0ec11f2dd4115baa504d63d7b5d4533154e` | 0 |
| Outline 质量 / 27 | 2 | 50473/13124 | 13749/467 | — | stop | hit | 0/0 | none | `9f046a914786359a055a687453034a200f901d6b5fb6b4a42d84b1494afa830a` | 0 |
| Outline 质量 / 28 | 2 | 51308/5777 | 13298/816 | — | stop | hit | 0/0 | none | `f722dd27d11c0060903a480364bbfac006fd9f882a23b6306f0ae1230899d6ff` | 0 |
| Continuation 极速 / 29 | 1 | 43376/995 | — | — | stop | skip | — | none | `bd3b0d3e3fd45ad57aebfb82703d9951d331c06511055dbdc004a19746ee41ec` | 0 |
| Continuation 极速 / 30 | 1 | 44017/2410 | — | — | stop | skip | — | none | `bd669157f99eb2b08dc7e98720e2b5f1e3c7869a2b30bb5397ec15e7c0d3225a` | 0 |
| Continuation 极速 / 31 | 1 | 47710/3531 | — | — | stop | skip | — | none | `82a975e69a4283d224bbc9af4d13953560e99e5b85b871a3739836477696a8d8` | 0 |
| Continuation 标准 / 11 | 11 | 30773/2565 (Σ123092/11370) | 22287/222 (Σ94265/8635) | 32610/2824 (Σ70517/6059) | stop；旧 retry 含 length | fallback: no-entity-hit | 0/1 | none | `e21a557c559dbe09e63fa81dfb659df31450172737f0b44bfedb67b7f88495ab` | 0 |
| Continuation 标准 / 12 | 3 | 33120/1523 | 21726/255 | 33743/1728 | stop | fallback: no-entity-hit | 0/1 | none | `47e705fe73f08eba5c71c1babd460792c866fa49c7bbcc3af88da83479a22ef6` | 0 |
| Continuation 标准 / 13 | 3 | 35369/1476 | 20927/582 | 36007/1805 | stop | fallback: no-entity-hit | 0/1 | none | `4d3f20b992ea34f62e945d1347f0596676a1b4329f3038c88823125991046122` | 0 |
| Continuation 标准 / 14 | 3 | 37160/3264 | 23073/226 | 39474/3536 | stop | fallback: no-entity-hit | 0/1 | none | `d858db18ff9492f2d29d57c3ba3f80d7559d132ca28888fe6878f7bc5356e2de` | 0 |
| Continuation 标准 / 15 | 9 | 41668/1640 (Σ125004/17752) | 23727/576 (Σ84010/1256) | 42229/1899 (Σ142782/18623) | stop；旧 retry 含 length | fallback: no-entity-hit | 0/1 | none | `4e7ac08fd3dd8c819071bfd5bace65bc4266dfb8753dbe5d6121f0e6c73a3ac8` | 0 |
| Continuation 质量 / 33 | 1 | 50946/5332 | 27869/314 | 54399/5584 | stop | fallback: no-entity-hit | 0/1 | none | `7282b74fbbe0fe20ca9721b216fb24cf5ab6cb42935e6e94221b45f6a6a5b0c7` | 0 |
| Continuation 质量 / 34 | 1 | 56278/1303 | 25728/320 | 55701/1654 | stop | fallback: no-entity-hit | 0/1 | none | `b9d950de69d407fff7ccaf0ab264ffd55d86ce7b151e510a7a394b7becde4ba4` | 0 |
| Continuation 质量 / 35 | 1 | 58155/5313 | 25734/239 | 60360/5985 | stop | fallback: no-entity-hit | 0/1 | none | `aa1a75bd66840575025e116077d9a89be7df28594e9f79fe6816ec427e9eb555` | 0 |
| Continuation 质量 / 36 | 1 | 63300/9703 | 34230/308 | 69760/9992 | stop | fallback: no-entity-hit | 0/1 | none | `5941a889c4b1e653dafef164f6d5f8604149567b010bd481d47f5b87f52cd1ba` | 0 |
| Continuation 质量 / 37 | 1 | 72019/3535 | 32266/238 | 72258/3911 | stop | fallback: no-entity-hit | 0/1 | none | `7a71e144cb93f97f2c614132f6a1c279082a8fe0730318f9251270d929395332` | 0 |

Continuation 标准的 `Σ` 是该章所有 retry receipt 的累计 usage；未带 `Σ` 的章节没有额外 retry。最终 adopted run 的 Draft/QA/Revision 均为 `finishReason=stop`，旧的被拒绝 retry（第 11、15 章）的 `length` receipt 保留在 ledger，没有被最终结果覆盖。所有 Continuation 最终 run 都为 `state=completed / completion_reason=adopted / awaiting_user`，且 `adopted_revision_hash=finalized_revision_hash`。

## Evidence QA 与真实请求闭环

- Outline 标准 19–23、Outline 质量 24–28：Evidence QA `enabled=true`，分别重建出 2294/2334/2539/2674/2574 和 2364/2504/2544/2559/2634 projected tokens；实际 receipt 的 `messagesFingerprint`、`requestFingerprint` 全部匹配 projected compiler。
- Continuation 标准 11–15、Continuation 质量 33–37：全部真实命中 `no-entity-hit` 的 fail-safe fallback；实际 receipt 的 `messagesFingerprint`、`requestFingerprint` 全部匹配 fallback compiler，未强行裁剪资料。
- Outline/Continuation 极速正式跳过 QA/Revision；跳过由 one-shot policy 显式记录，不以空 artifact 冒充执行。
- 校验输入来自每章持久化的 `frozenContext`、实际已保存 Draft artifact 和 `pipeline_stage_attempts.frozen_request_json`。生产 receipt 只存 fingerprint/元数据，不存完整 prompt；因此该核对证明的是当前生产编译器重建的 model-visible messages 与真实 dispatch receipt 一致。

## State Proposal / PostWriting 真实闭环

- 最终 30 章均没有冻结需求要求记录状态变化，故 `State Proposal source=none`、最终 proposal rows=0 是契约允许且预期的结果；没有把“无提案”伪装成状态更新。
- QA / Revision envelopes 逐项检查了 Final==Draft 与 Final!=Draft 分流、payload/risk/proposalType、最终正文 evidenceQuote 和正文 fingerprint 绑定；本矩阵的最终 Revision 没有生成非空提案。
- Continuation 13 章每章各有一次成功的 `rebuild_story_memory` outbox；正常 PostWriting 未发起 `extract_state` LLM，计数为 0。Outline one-shot/compact finalization 同样没有状态抽取调用。

## SQLite 热路径审查

本轮复核了 `pipeline_tasks`、`pipeline_stage_attempts`、`continuation_generation_artifacts`、`continuation_generation_stage_results` 以及 multi-chapter batch usage/adoption 路径：元数据列表只取窄列，正文/JSON/BLOB 通过按需列读取或 chunk 读取；B 热路径未发现 `SELECT *` 读取 `pipeline_tasks` 大载荷。源码中仍存在 backup/export、Worldbook、Story Memory 和 legacy chapter 等全表读取，它们不属于本轮 B6–B8 的 pipeline payload 热路径，未把该静态结论扩大为“全项目不存在 SELECT *”。

## APK / 模拟器证据

- APK：`dist/apk/debug/ShineWriter-V2.21.1-debug.apk`，SHA-256 `1383E792F5B251F5025AD090BBD70B06547D89D3C87E09BEF5A6B123995FEB51`。
- 设备：`emulator-5554`，包 `com.shinewriter`，`versionName=V2.21.1`、`versionCode=2210100`；安装仅使用 `adb install -r`，没有 uninstall、`pm clear`、reset 或清理已有应用数据。
- UI 证据：`test-logs/emulator-qa-20260828-001604/ui-phase3b-final.xml`；最新 APK 启动后显示“作品库”和 Outline/Continuation 工作流界面。
- 所有六组真实批次的原始 DB 快照路径已列于上表；这些 DB 同时承载 stage ledger、usage、receipt、finishReason、physical/fallback count、最终正文与 outbox 证据。

## B 轮审计结论

实现 tip `be835da` 已完成 State Proposal / Evidence QA / PostWriting、model-visible request receipt、physical request/usage/stage ledger、SQLite 大载荷 projection/chunk、弹性预算和真实 Android 矩阵闭环。全量验证与最新 APK 安装均通过，Outline 与 Continuation 的极速/标准/质量硬门禁全部满足。保留既有未跟踪文件，不纳入本提交；C 轮未启动。

---

## 2026-08-27 历史记录（不构成当前验收）

## 范围

- 仅收口 B6、B7、B8；B0-B5 保持不动，不启动 C 轮。
- 本轮新增能力规则：`providerCapabilities.ts` 是唯一模型能力解析入口；持久化 `0` 表示 AUTO/unknown；留空 `max_output_tokens` 按同一模型 `context_window × 20%` 弹性派生；无真实能力时 fail-closed；Provider adapter 只做逻辑能力到 wire `max_tokens` 的适配。
- 阶段 demand、资源输入预算、Preset/Tavern compatibility 字段不作为模型能力。

## 自动化门禁

- 定向 capability / Canon / Historical Digest / Story Memory / Preset / Tavern / LLM config / migration 57→58 / multi-chapter budget / B6-B8 测试：通过。
- `npm run lint`：通过，0 errors，216 warnings。
- `npm run typecheck`：通过。
- `npm run verify:elastic`：通过。
- `npm run verify`：通过，500 个测试套件通过，3622 个测试通过，9 个测试跳过。
- `npm run verify:version`：通过，`V2.21.1 / versionCode=2210100`。

## Android 实测

- APK：`dist/apk/debug/ShineWriter-V2.21.1-debug.apk`。
- 设备：`emulator-5554`，包名 `com.shinewriter`；安装命令为 `adb install -r`，结果 `Success`。
- Fixture：`test-logs/phase3-b-live-20260827/db-continuation-final-fixture.sqlite.b64`。
- Mock：`test-logs/phase3-b-live-20260827/mock-writing-server.mjs`；本轮追加日志为 `mock-writing-continuation-fixed.jsonl`。
- 真实路径“编辑第 4 章 → AI 续写 → 采纳 → 定稿”完成；UI 显示初稿 46 字、最终稿 48 字、1 处修改。

## Continuation DB 闭环

最终数据库证据：`test-logs/phase3-b-live-20260827/db-phase3b-final-apk-direct.sqlite`，原始流拉取大小 35,946,496 字节，`PRAGMA integrity_check=ok`。

- `continuation_state_proposals`：恰好 1 条，`subject_ref_type=plotline`。
- `extraction_content_hash`、`chapter_revision_hash`、Final body SHA 完全一致：`ef300c58fa6c93e555fb6cd48773d1a01d6239a82f829393a18f1501db92811c`。
- Revision `proposalSourceBodyFingerprint` 与 Final body fingerprint 严格相等。
- 唯一完成的 `rebuild_story_memory` outbox payload：`stateProposalPipeline=final_body_v1`、`stateProposalSource=revision`、`stateProposalFingerprintMatched=true`；其中 `writing_persisted` event 的 Final body fingerprint 同值。
- `rebuild_story_memory` outbox：恰好 1 条，`state=completed`。
- 正常 `extract_state` LLM：0；usage 仅包含 Draft、QA、Revision 与 `story_memory_v2_primary`。
- Continuation writing event 正常通过；Final chapter 为 `status=finalized`，Continuation run 为 `state=completed / completion_reason=adopted`。

## 时间边界与未来泄漏

- Canon snapshot 边界：position 1、global offset 316；Canon 各实体最大 observed position 为 1。
- 写作上下文的 Story Memory through position 为 0；定稿后 Story Memory 为 position 1、`status=clean`。
- 本轮 Draft/QA/Revision 请求携带 Canon、原著 Boundary、Seam、Story Memory 约束；观察器按独立的只观察契约运行；新增 mock 请求扫描未命中 position 2、`第 5 章`等未来标记。
- 因此本轮 Canon、Boundary、Seam、Story Memory 未发现未来章节泄漏。

## Outline 既有证据复核

- Issue：3 次真实 Draft/QA/Revision 请求。
- Clean：2 次真实请求。
- Fast：1 次真实请求。
- Evidence QA：最后真实命中请求包含 `QA Evidence Projection v1`，Draft 返回包含目标证据正文，QA 返回 `pass`；此路径的 Draft/QA input p50 分别为 3187/4247，均为 `n=1`。不将 fallback 或多次历史样本拼成提效结论。

## Logcat 判定

- 当前启动/流程日志没有新增 ReactNativeJS 错误或 FATAL 异常；ReactNativeJS 仅为正常的 `Running "ShineWriter"` 启动行。
- ReactHost `onWindowFocusChange` SoftException 与本轮前启动日志一致，属于既有 RN 启动诊断且未导致崩溃。
- 当前仍有 1 次 `SQLiteBlobTooBigException`，栈为 `SELECT * FROM pipeline_tasks`。同一签名已在本轮前 07:02、07:49、07:54 的启动日志出现；当前 capability 收口未改该查询，因此判定为既有 fixture/启动读取问题，记录为 Known Existing Issue，不冒充本轮修复。

## 封版决策

最终 diff 审查结论：B0-B5 未动，C 轮未启动；排除项不纳入提交；定向测试、全量 verify、静态弹性门禁、Debug APK、最终模拟器闭环、DB 指纹/outbox、Outline 证据和日志前后比对均无硬门禁失败。因此本轮状态为：

`PHASE III-B FINAL SEALED / GO`
