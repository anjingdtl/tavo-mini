# Phase III-B Final Acceptance Report

更新时间：2026-08-28

当前状态：**PHASE III-B FINAL ACCEPTANCE IN PROGRESS / NO-GO**

> 本页下方保留 2026-08-27 的历史封板记录，不能作为当前 HEAD 的验收结论。
> 2026-08-28 的 B 轮复核已重新执行定向 7 suites / 32 tests、
> `npm run verify:elastic`、`npm run typecheck`、`npm run verify`（均通过）；
> 但 Debug APK 连续三次在 Gradle 尚未开始编译前因宿主 Java loopback
> `Invalid argument: connect` 失败。没有最新 APK，就没有执行 `adb install -r`，
> 也没有启动 Outline / Continuation 的真实 3/5/5 矩阵。因此不得宣布 GO。

## 当前 B 轮硬门禁（2026-08-28）

| 门禁 | 实测结果 | 当前结论 |
| --- | --- | --- |
| State Proposal / Evidence QA / PostWriting 定向回归 | 7 suites / 32 tests PASS；Final==Draft 仅 QA、Final!=Draft 仅 Revision+fingerprint、正常路径 `extract_state=0` | PASS |
| 最终 model-visible messages / receipt / physical ledger | 定向回归 PASS；receipt 由实际 dispatch 的同一 `compiled.messages` 构建并保留 usage、finishReason、physical/fallback count | PASS |
| `pipeline_tasks` 热路径审查 | 生产源码未发现 `SELECT * FROM pipeline_tasks`；读取为窄投影/分块载荷 | PASS |
| `npm run verify:elastic` / `npm run typecheck` / `npm run verify` | PASS（lint 0 errors / 216 existing warnings） | PASS |
| 最新 Debug APK 构建 | FAIL：Gradle daemon 的 JDK loopback pipe 初始化报 `Unable to establish loopback connection`；`--no-daemon` 同样失败 | BLOCKED |
| `adb install -r` 最新 APK | 未执行，不能以旧 APK 替代最新构建 | BLOCKED |
| Outline / Continuation 真机 3/5/5 矩阵 | 未启动；无最新 APK 时不伪造或复用历史样本 | BLOCKED |

**当前决策：NO-GO。** 只保留 III-B B 轮；待宿主机 Java/Gradle loopback 故障消除后，从最新 Debug APK 构建、`adb install -r` 和真实矩阵继续。

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
