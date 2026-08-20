# TAVO-MINI 第二期 Final-Seal 最终封板报告

日期：2026-08-21（Asia/Shanghai）
施工基线：`F:\\ClaudeWorkSpace\\projects\\TAVO-MINI`
报告性质：P0 修复、真实失败 fixture 验收、Debug APK 回归、受限真实 LLM smoke 与远端 CI 的最终封板记录

## 最终结论

```text
PHASE 2 FINAL SEALED / GO
```

本轮只修复一个 P0：`QA Structured Contract Admission Gap`。旧 C1“持续跑真实章节直到自然触发 Revision”的概率型测试已取消：真实章节已经证明模型可能在自然语言中识别硬性违规，却不稳定地产生可执行结构化 finding；继续追加章节只会浪费 LLM 调用，不能构成确定性验收。Needs-Revision 主验收已改为真实失败输出 fixture 穿透 production path，并由一次受控真实 Continuation Standard smoke 做兼容性确认。

## 1. 基线、提交与边界

| 项目 | 实际值 |
|---|---|
| `remoteMainBeforeWork` | `2b2973902e198f440f61b914d1a3d6b3c1520290` |
| fetch 审计 | `origin/main` 无新增提交；fetch 后仍为上述 SHA |
| P0 production fix | `2ab07dd7a2b2d85588d2735528ad438181294b67` |
| 工作分支 | `codex/qa-contract-p0-final-seal` |
| PR | [#23](https://github.com/anjingdtl/tavo-mini/pull/23)（保留 Draft，未合并） |

本轮没有修改 One-Shot、Context、Memory、Legacy topology，也没有新增 QA2、Proof 或 Judge。Revision Trigger 没有放松；中文正则没有被用于自动制造 blocking finding。测试数据库在模拟器回归结束后恢复到测试前快照，未使用 `pm clear`、`uninstall` 或人工写入生产结果。

## 2. P0：真实失败 fixture → Red → Root Cause → Minimal Fix → Focused Green

### 2.1 真实失败 fixture

fixture 来源于 Final-Seal Standard 任务 `pt_mt1qckad_250`（chapter 265）的真实 QA 输出：

```text
发现一个阻塞性问题：水漫上第一步后才完成交付，不符合“before water reaches the first step”的硬性要求。
```

模型识别了硬性违规，但只返回自然语言 `content`，缺少 `verdict/findings` 结构，因此是“内容上失败、Admission 上非法”的真实失败样本。fixture：`src/services/writing/fixtures/qa-content-only-failure.ts`。

### 2.2 Red 与根因

新增 `__tests__/writingQaStructuredContractAdmission.test.ts` 先固定以下失败事实：

- content-only QA 不能被当作可执行 finding，也不能触发 Revision；
- `pass` 携带 findings、`needs_revision` 无 findings、非法 verdict、`info` severity、无定位或无行动指令的 finding 均非法；
- Primary 与 Formatter 都非法时，不能持久化 QA，必须 fail-closed。

根因是 QA 的自然语言正文曾经能够落库和展示，但没有经过严格的结构化 Admission；而 Revision Trigger 只应消费带有可定位目标与可执行行动的 structured finding。于是“QA 文本识别到违规”与“Revision 合法触发条件”发生断裂，真实结果为 `Revision=0`。

### 2.3 最小修复

- `validateQaStructuredContract` 严格限定 `verdict` 为 `pass | needs_revision`。
- `pass` 必须 `findings=[]`；`needs_revision` 必须至少一个 finding。
- 每个 finding 必须有 `blocking | warning`、非空 `issue`、可定位的 `target` 或 `requirementIds`，以及可执行的 `instruction` 或 `target`。
- 非法 Primary QA 最多调用一次现有 Formatter；Formatter 输出再次走同一严格校验；仍非法立即 `SHARED_WRITER_INVALID_REPORT` fail-closed。
- QA finding 聚合、durable adapter 与 prompt contract 统一使用同一 Admission Contract；QA 不再从正文、`info` 或 generic 文本制造 blocking finding。

### 2.4 Focused Green 验收

`writingQaStructuredContractAdmission.test.ts` 四项测试全部通过，核心链路为：

```text
invalid QA fixture
  → Formatter（恰好一次）
  → valid needs_revision finding
  → durable QA structured envelope
  → Revision=1
  → FinalValidate PASS
  → Persist PASS
```

测试同时核验了 Formatter 调用最多一次、durable QA 可重新加载、Revision brief 只有一个、Revision paid call 恰好一个；Primary 与 Formatter 都非法的路径无 QA 持久化并 fail-closed。

## 3. Full Verify

本地门禁全部通过：

| 门禁 | 结果 |
|---|---|
| `npm run verify` | PASS；lint 0 errors，typecheck PASS，Jest `488 passed / 491 suites`、`3777 passed / 3785 tests` |
| Generation Stability | PASS；Phase 1 `35 suites / 227 tests`，Phase 2 `13 suites / 93 tests` |
| Migration | PASS；`44 suites / 211 tests` |
| Debug APK | PASS；`npm run apk:debug` |
| APK | `dist/apk/debug/ShineWriter-V2.11.54-debug.apk`，53,880,682 bytes |
| SHA256 | `4ffce30a95e0d938fd172718d71900aec2be34e1355e4fc94ae02c4771d05e4b` |
| 安装 | `adb -s emulator-5554 install -r` → `Success` |

### 3.1 Debug APK 模拟器 8 章回归

设备：`emulator-5554`，API 37，包名 `com.shinewriter`，版本 `V2.11.54 / 2115400`。使用确定性本地 mock writing server 驱动 Debug APK，避免新增真实 LLM 消耗；每章完成后均检查 UI、pipeline task、stage attempts、SQLite 结果及 logcat，并在发现阻滞点后做精准修复。

#### 大纲创作模式：4 个 Pipeline 档次各 1 章

| 档次 | chapter / task | 实际阶段 | 结果 |
|---|---|---|---|
| One-Shot / fast | 269 / `pt_mt1tvxug_254` | Draft 1，QA 0；Brief/Revision/FinalValidate/Persist 按 clean 路径跳过 | completed，accept，已采纳 |
| Low | 270 / `pt_mt1u0jkk_255` | Draft 1，QA 1 pass；Brief 跳过 | completed，accept，已采纳 |
| Medium | 271 / `pt_mt1u4fon_256` | Draft 1，QA 1 pass；Brief 跳过 | completed，accept，已采纳 |
| High | 272 / `pt_mt1u8t08_257` | Draft 1，QA 1 pass；Brief 跳过 | completed，accept，已采纳 |

#### 原著续写模式：4 个实际可选配置各 1 章

Continuation 不消费 Outline 的全局四档开关，因此按其现有 `loose / balanced / strict / custom` 配置覆盖四章；这不是拓扑变更。

| 配置 | chapter / run | 实际阶段 | 结果 |
|---|---|---|---|
| Balanced（证据文件名 `fast`） | 273 / `ct_812378a7af454165a90629cf6f1c38ca` | Draft 1，Unified QA 1，Revision skipped，FinalValidate PASS | completed，adopted |
| Loose | 274 / `ct_1e391e6ac92141a29ce81289281ddc0f` | Draft 1，Unified QA 1，Revision skipped，FinalValidate PASS | completed，adopted |
| Strict | 275 / `ct_ae80e13e00a6453db328199e7a0246c4` | Draft 1，Unified QA 1，Revision skipped，FinalValidate PASS | completed，adopted |
| Custom | 276 / `ct_01528d458b364240a2abec5a57a4f5d0` | Draft 1，Unified QA 1，Revision skipped，FinalValidate PASS | completed，adopted |

8/8 章节均穿透实际生产流水线并成功采纳。逐章证据、数据库快照、UI XML/PNG、pipeline 文本及 logcat 均保存在 `test-logs/qa-contract-p0-20260821/`。

### 3.2 逐章阻滞点与精准修复

- Continuation Canon extraction 首次被 mock 响应的 evidence quote 不接受：将 fixture 改为与原著 source 的精确引文，重新穿透 production path。
- Continuation Style Profile 首次返回 prose 而非 V2 schema：改为完整合法 Style Profile V2 fixture，未放松生产校验。
- 冷启动时 terminal task summary 的 `finalText` 延迟加载，UI 误报“流水线已完成但本次生成内容为空”：在 `src/main/index.tsx` 对 terminal task 触发 detail hydration 后再判断 prompt；针对性 UI 回归 `4 suites / 13 tests` 全部通过。

## 4. 受限真实 LLM smoke（严格最多 2 章）

旧 C1 已停止，没有继续跑章节等待概率触发 Revision。真实 LLM 仅执行 Outline Standard 1 章与 Continuation Standard 1 章：

### 4.1 Outline Standard：1 章

- task：`pt_mt1vx7ch_254`；同一章节首次遇到一次暂时性网络失败后，仅对同一任务做一次受控 retry。
- 最终：Draft success（attempt 2）、QA success（attempt 1）、Brief success、Revision 0；task completed / accept，UI 采纳并保存。
- 这次 retry 没有新增章节，也没有恢复旧 C1 概率型循环。

### 4.2 Continuation Standard：1 章

- run：`ct_ae2ba743d4904b639031f4ec615276ca`。
- 阶段：Draft success 1、Unified QA success 1（自然 `needs_revision`）、Revision success 1、FinalValidate success、Persist/采纳 PASS。
- durable QA 的 structured finding 穿透 Revision Trigger，证明真实生产链路得到 `Revision=1`，最终正文已保存。

两章 smoke 均已完成后立即停止真实 LLM；没有追加测试、没有恢复 C1。

## 5. 远端验证

PR #23 的远端验证均为 SUCCESS，且均针对 P0 production fix commit `2ab07dd7a2b2d85588d2735528ad438181294b67`：

| 远端门禁 | 结果 | 证据 |
|---|---|---|
| Verify / JavaScript validation | SUCCESS | [job 96556660705](https://github.com/anjingdtl/tavo-mini/actions/runs/32409594808/job/96556660705) |
| Verify / Android Debug build | SUCCESS | [job 96556660631](https://github.com/anjingdtl/tavo-mini/actions/runs/32409594808/job/96556660631) |
| Verify / Migration matrix | SUCCESS | [job 96556660864](https://github.com/anjingdtl/tavo-mini/actions/runs/32409594808/job/96556660864) |
| Generation Stability | SUCCESS | [job 96556661177](https://github.com/anjingdtl/tavo-mini/actions/runs/32409594880/job/96556661177) |

因此：

```text
Remote Verify: SUCCESS
Remote Generation Stability: SUCCESS
```

## 6. 证据索引

完整本轮证据目录：`test-logs/qa-contract-p0-20260821/`

关键本地证据包括：

- `flow-fast-outline-final.sqlite`、`flow-low-outline-final.sqlite`、`flow-mid-outline-final.sqlite`、`flow-high-outline-final.sqlite`
- `flow-cont-fast-final.sqlite`、`flow-cont-loose-final.sqlite`、`flow-cont-strict-final.sqlite`、`flow-cont-custom-final.sqlite`
- `real-outline-smoke-final.sqlite`、`real-outline-smoke-final.png`
- `real-cont-smoke-final.sqlite`、`real-cont-smoke-final.png`
- `emulator-qa-all-logcat.txt`
- `db-before-flows.sqlite`、`db-restored-final.sqlite`

报告不包含 API key、完整 Prompt 或完整 Draft 正文；测试 log 目录保持本地忽略状态。

## 最终判定

```text
QA Structured Contract Admission: PASS
Invalid QA → Formatter≤1 → strict revalidate → fail-closed: PASS
Needs-Revision fixture → valid finding → durable QA → Revision=1 → FinalValidate/Persist: PASS
Debug APK 8 章回归: PASS（大纲 4 + 续写 4）
真实 LLM smoke: PASS（大纲 1 + 续写 1；无额外章节）
Local Verify / Generation Stability / Migration / Android Debug: PASS
Remote Verify: SUCCESS
Remote Generation Stability: SUCCESS
旧 C1 概率型测试: 已取消，原因已记录

PHASE 2 FINAL SEALED / GO
```
