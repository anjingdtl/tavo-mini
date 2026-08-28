# Phase III-B B10 最终验收报告

更新时间：2026-08-28

当前状态：**PHASE III-B FINAL SEALED / GO**

## 1. 验收边界与 Exact HEAD

- 唯一施工基线：`E:\AiWorkSpace\tavo-mini`。
- 验收起点 Exact HEAD：`ae2574d425ca8ce07e56b24f5a238e48fed1eb12`。
- 验收起点 `origin/main`：`ae2574d425ca8ce07e56b24f5a238e48fed1eb12`，与本地 HEAD 一致。
- 本轮只收口 Phase III-B 的 B10 最终验收；没有进入 C 轮，没有做新的架构重构。
- 交付改动仅限：共享 Writer 的 `finishReason=length` fail-closed，以及对应的 Revision/共享阶段 Red Test；报告同步修订。
- 原有未跟踪用户文件 `docs/optimization/TAVO-MINI_Phase3_B_生产闭环与体验验收报告_20260826.md`、`scripts/qa/__pycache__/` 未纳入提交。

## 2. PDCA 记录

### Plan

锁定 B10 硬门禁：全新 generationTrace/run、Outline/Continuation Standard Issue 各至少 2 章、每章 Draft → QA → Revision、每章真实 physical writer calls ≤3、最终请求全部 `finishReason=stop`，D/Q/R model-visible messages 与 frozen receipt 完整一致，弹性 maxTokens 和 Revision 合同 fail-closed，Final-body state proposal 绑定正确，并完成 Android 覆盖安装后的真实流程。

### Red Test / 真实复现

- 首个 Continuation 真实复现批次 `batch_mtcbp7pu_g2hu3f` 因 mock Observer 返回空 `chapters`，触发 `Observation 缺少章节：CH01`，已明确标记为 NO-GO 审计样本，未作为性能通过样本。
- 历史 retry、`finishReason=length`、旧失败 receipt 与旧报告中的聚合 physical 数字全部保留作审计，不作为当前 Exact HEAD 的通过样本。
- Revision 合同 Red Test 覆盖了截断 JSON、缺少 `strategy/actions/preserve/ending`、空正文、Segment Repair 无效、同一响应 Full Revision fallback 和 proposal 指纹绑定；本轮再补 Draft/QA 的 `finishReason=length` fail-closed Red Test。

### Do

- `src/services/writing/stages/writerCore.ts`：primary Writer response 和可选 formatter response 在解析/持久化前统一检查 `finishReason=length`；命中即记录失败 receipt、清空 adopted text、拒绝 Persist，适用于 Draft/QA/Revision。
- 没有为格式修复再发第 4 次常规 LLM 请求；无效 Segment Repair 只允许使用同一次 Revision response 内的合法完整 `content` fallback。
- 生产代码调用 `callLLM`/`callLLMResult` 的第二参数未发现固定 `4000/4096/8192/16384` 业务上限；固定数字只留在与生产请求无关的测试夹具或历史迁移注释中。

### Targeted verify

定向执行并通过：

```text
6 suites / 27 tests passed
writingRevisionFormatContract
writingPhysicalCallLedgerContract
writingRequestReceipt
writingStageBudgetBinding
writingFinalSealBehavior
writingQaStructuredContractAdmission
npm run verify:elastic
```

### Check / Act

- 真实 DB、stage ledger、raw mock server log、receipt 和 frozen request 重建均已逐请求核对。
- 发现旧报告把同一章 D/Q/R 错写成 `physical=1`，已按真实物理请求总数修正为每章 `physical=3`；历史 `17/29` 不再作为当前结论。
- 发现共享 Writer 只对 Revision 截断 fail-closed 的覆盖缺口，已收口为三类共享阶段统一 fail-closed，并补回归测试。

## 3. 全新 Standard Issue 样本

以下样本均是全新 batch/run/trace，不复用施工期间的 retry、length 或旧失败 run。

### 3.1 安装后 Outline 样本

- batch：`batch_mtcecfp1_3n49ut`
- project：`40 / QA_OUTLINE_20260817`
- source prompt：`B10_APK_FINAL_OUTLINE_STANDARD_ISSUE`
- execution：`standard`，`pipeline_topology_version=2`，`reasoning_effort=max`
- batch 结果：`completed=2/2`，`used_llm_calls=6`，`used_input_tokens=18106`，`used_output_tokens=690`
- generationTrace：
  - chapter 9234：`gt-mtced46z-7luuwiqg`
  - chapter 9235：`gt-mtced5yd-3hyhrvdf`
- 真实证据：`test-logs/phase3-b-live-20260828/db-post-install-finalized.sqlite`、`mock-writing-fresh-v3.jsonl`。

### 3.2 Continuation 样本

- batch：`batch_mtccc0v6_47um8q`
- project：`23 / E2E_CONTINUATION`
- source prompt：`B10 CONTINUATION FINAL STANDARD ISSUE CLEAN MEMORY TWO CHAPTERS`
- execution：`standard`，`pipeline_topology_version=2`，`reasoning_effort=max`
- batch 结果：`completed=2/2`，`used_llm_calls=6`，`used_input_tokens=22394`，`used_output_tokens=1126`
- run：
  - chapter 9232：`ct_916f4dfaed4848d3ab2c0f1c98fce8ef`
  - chapter 9233：`ct_0fad6e5d2e2042749685db2ff199d29e`
- generationTrace：
  - chapter 9232：`gt_8bfd6c613ef221d3573e6d657cf83e3c`
  - chapter 9233：`gt_0e8a94e8b07971627a6391d01800dc3e`
- 真实证据：`test-logs/phase3-b-live-20260828/db-continuation-v4-final-restarted.sqlite`、`mock-writing-fresh-v3.jsonl`、`audit-b10-final-evidence.json`。

### 3.3 真实 physical request 口径

`physical` 是该章 Draft、QA、Revision 三个阶段所有真实 Provider dispatch 的总和，不是逻辑 Stage 数，也不把 formatter/protocol fallback/retry 隐藏在 Stage 内。

- Clean：Compact Standard 的 QA 为 `pass` 且没有可执行 finding 时跳过 Revision，真实口径为 Draft + QA = **2 physical calls**。
- Issue：本轮四个验收章节都确实触发 Revision，真实口径为 Draft + QA + Revision = **3 physical calls**，全部 ≤3。
- 四章均为每阶段 `attempt=1`、`physicalRequestCount=1`、`protocolFallbackCount=0`、`formatterUsed=false`、provider retry=0。
- batch 的 `used_llm_calls=6` 与两章各 3 次 Writer physical dispatch 相符。Planner 和 Story Memory Observer 是独立的辅助请求，单独记录，不冒充 D/Q/R，也没有隐藏第 4 次 Writer 请求。
- Continuation v4 item 的 `retry_count=1/2` 是 state-gate polling 记录，不是 Provider retry；D/Q/R stage ledger 仍全部为 attempt 1 / physical 1。

## 4. 每章 D/Q/R 真实证据

表中 token 均为 `input/output`；`R(brief)` 是 Outline durable 层对共享 Revision 的持久化 stage 名称。所有 receipt 的 `finishReason` 均为 `stop`。

| 样本 / 章 | physical | Draft | QA | Revision | fallback / formatter / retry | Final fingerprint | 最终状态 |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| Outline APK 后 / 9234 | **3** | 2598/51 | 2885/102 | 3648/192 | 0 / 0 / 0 | `c21ee91cf6f06576c7fdd41afecca5d887ecb94bedf6e71821eb00aeea5ec472` | `chapters.status=final` |
| Outline APK 后 / 9235 | **3** | 2538/51 | 2849/102 | 3588/192 | 0 / 0 / 0 | `c21ee91cf6f06576c7fdd41afecca5d887ecb94bedf6e71821eb00aeea5ec472` | `chapters.status=final` |
| Continuation / 9232 | **3** | 3623/102 | 3546/169 | 4267/292 | 0 / 0 / 0 | `ef300c58fa6c93e555fb6cd48773d1a01d6239a82f829393a18f1501db92811c` | `chapters.status=finalized` |
| Continuation / 9233 | **3** | 3423/102 | 3384/169 | 4151/292 | 0 / 0 / 0 | `ef300c58fa6c93e555fb6cd48773d1a01d6239a82f829393a18f1501db92811c` | `chapters.status=finalized` |

### 4.1 Receipt fingerprint 对照

生产 fingerprint 算法为：对真实发送的 `messages` 按 role + 每条 content 的 SHA-256 做稳定 JSON，再计算整体 SHA-256。以下每行都是 raw mock server message 重算结果与 frozen receipt 的 `messagesFingerprint` 相等，同时 receipt `requestFingerprint` 与 DB stage ledger 相等。

| 章 / 阶段 | messagesFingerprint | requestFingerprint | maxOutputTokens | finishReason |
| --- | --- | --- | ---: | --- |
| 9234 / D | `8fb3a8377ba8949202cae587990ac2629bf73c9e29b07edee8e32b13ef052713` | `7f35a9ce46f792f954227b3cbef6033de0d134da2ca689a057a2d5a27053fe0c` | 13107 | stop |
| 9234 / Q | `9fe53f07e9ea3a06208d8e749c4d0c5733437f884a3a2efa27a8cda92c5f50dd` | `b6a3bc3cbfaf2cbee17a2cffc162a55e9e789c239fa7f6cccdf508828b05f9ba` | 13107 | stop |
| 9234 / R | `31051bd5ac339362e5e656965992768285fad7b900588384f6181c66b2390eac` | `af2050092c07c17cfcce17c5ef28cf638adeb81a2d6b55d753365ea7d1fd6493` | 13107 | stop |
| 9235 / D | `65d71700e236db3ce905c1355a27225b5e0875645ad90a255233a372b0e404a2` | `aeff9631a059e038a796ff7889b4557211ffeee8738886440b6a10b3f9a5315c` | 13107 | stop |
| 9235 / Q | `e0c1c46384b7fb93a4a812c0c268477de4dba2b555424d1f627b3fc07bd6d854` | `ba551371027843e0ce97ffc7e4e205e95aef5dc24f859e20cbbfe6fb26a4f020` | 13107 | stop |
| 9235 / R | `230b75d89b4acef1aa41fb0a3c0ff9a745a4313b53b499cbcf67734c253af7c4` | `28a01791b5a8275cf3181751debec1b310005c0e68bcc2c9f01099ab0fff5ae0` | 13107 | stop |
| 9232 / D | `049e237f155159c650e7202cf05c000be8a26ec4e85e3e59693b8f80454c2933` | `31a7ce81800f39160b800af853724d8256e97b627e7820b6c02847fd01d79557` | 13107 | stop |
| 9232 / Q | `fa3eaadab4888a9394b9fbd7f23894a217c091274655e92d17ef8935c4d847d3` | `8a3c55fee7dbb90ccd735ff638eff6d68f082feb2f2fa9ffb1189b767efd5832` | 3350 | stop |
| 9232 / R | `ce8afa4df59ea254c554dc3b498725d65076db6cc86bb180f6940958dd8e141b` | `11f250d95ba40c604b5846423eeae7c29e4dac741bd04243d651dca097b76a6` | 13107 | stop |
| 9233 / D | `a9b1abaaad641bb8f8864e03b6b3be9872de9df65bda66c99e2600c19615429d` | `e919b49e17bcd4b669bb6a9c9535ebe87e2acd4d6e551b7f1f2f0faf04c1b382` | 13107 | stop |
| 9233 / Q | `e0263a58c92ac3fcd5b9fd2b91a6f1693b20daf34b35e4beb9f5bbb5b08407d9` | `0ed998275fec352452ae27cb947b76bb0745ffc966e0dcb5e6fc9425857cd7c0` | 3350 | stop |
| 9233 / R | `746b9e2293b0d8596293156b6d27886e74c838b48aae401a7e7664c6e82a7d17` | `77474655f0d3759de228925f47878d567926534689375a19cb35e7245d8e9062` | 13107 | stop |

## 5. model-visible D/Q/R 注入核查

核查对象是 raw server 收到的最终 `messages`，不是仅检查 FrozenContext 对象或 QA artifact。12 个 D/Q/R 请求逐一使用 raw message body 重算 fingerprint，并与 receipt/ledger 对照；未发现 Freeze 后 live read 漂移、串章、future leakage 或旧资料覆盖新冻结上下文。

### Outline 9234/9235

D/Q/R 均实际包含：

- 当前章节 Requirement / 用户指令、当前章节标题与 Outline/梗概；
- `Chapter Truth Projection`；
- `Requirement Checklist`；
- `preset/writing`、`writer_style/active`、当前结构化状态和当前章节/近期章节投影；
- Draft 之后的 QA/Revision 请求还实际包含已保存的 Draft、QA findings 与对应输出契约。

该 Outline fixture 没有 Continuation-only 的 Canon snapshot、Source Boundary、上一章 Seam/Anchor、相关人物/世界书实体或可命中的 Continuation Notes；这些项在审计中明确标为 N/A/无命中，没有把 N/A 伪装成注入成功，也没有从其他章节借入资料。QA 使用现有 union frozen projection 的 fail-safe 路径，Mandatory Truth 未被裁掉。

### Continuation 9232/9233

D/Q/R raw messages 均逐阶段检查并确认进入最终发送内容：

- 当前章节 Requirement / Outline/本章梗概、Chapter Truth Projection、Requirement Checklist；
- Canon hard facts、Canon evidence refs、世界规则；
- Source Boundary、原著边界；
- 上一章 Seam / Anchor、接缝与 primary anchor；
- Writer Style、相关人物/人物状态/关系/经历、世界书；
- Notes/资料、当前 Draft、QA findings 与 Revision contract；
- Story Memory / Structured State：9232 使用 frozen clean Story Memory；9233 在冻结时 Story Memory 状态为 dirty，故不读取可能过期的 live memory，改由 frozen Structured State fail-safe 继续提供连续性约束。

9233 的 dirty-memory 事实已记录在 run freshness 中，不是遗漏或串章；冷启动后项目 Story Memory 恢复为 clean，through position=6。两章的 Canon snapshot 均为 `snap-phase3b-cont-ready`，revision 1，boundary position=1、offset=316；没有把 boundary 之后的未来章节写入当前 D/Q/R。

## 6. Evidence QA 与 QA/Draft 比例

- 4 个验收章节的 QA raw messages 均如实记录为 `fallbackReason=no-entity-hit`，没有伪称为 hit；raw messages 未出现 `QA Evidence Projection v1` 窄投影头，说明实际走的是现有 union fail-safe 路径。
- Continuation Canon snapshot 的 `evidenceValidated=true`，hard/soft Canon 的 evidence refs 已冻结并在 D/Q/R 中可见；`no-entity-hit` 只影响相关实体窄投影，不裁剪 Canon、Boundary、Seam、Memory、Style 等 Mandatory Truth。
- QA/Draft input ratio（仅作诊断，不以比例为目标）：
  - Outline APK 后：`5734 / 5136 = 111.7%`；
  - Continuation v4：`6930 / 7046 = 98.4%`。
- 这批没有为了降低比例而删除 Canon、Boundary、Seam、Memory、Style 或 Requirement Checklist。

## 7. Final-Body State Proposal

- Continuation 9232/9233：QA 各返回 1 条 `stateProposals`，Revision 各返回 1 条 `finalStateProposals`；由于 `Final != Draft`，QA proposals 全部作废，只采用 Revision proposals。
- QA evidence quote：`铜色车票收回口袋`；Revision final evidence quote：`铜色车票收回左侧口袋`；后者在 Final Body 中唯一命中。
- `proposalSourceBodyFingerprint` 由客户端绑定最终正文；两章的 proposal extraction/chapter revision hash 均等于 Final fingerprint `ef300c58fa6c93e555fb6cd48773d1a01d6239a82f829393a18f1501db92811c`。
- `continuation_state_sync_outbox` 的 `extract_state` 条目数为 0；`story_memory_request_attempts` 的 `extract_state` 次数为 0。正常路径没有 QA/legacy 双写。
- 两章最终 proposal 均为 accepted；`apply_event` 与 `rebuild_story_memory` outbox 完成，最终 Story Memory 为 clean。
- Outline 9234/9235 没有 Continuation 状态提案需求；Final 定稿后仅触发正常 Story Memory rebuild，不发起 `extract_state` LLM。

## 8. Revision 格式 P0

生产代码与 Red Test 共同保证：

- Draft、QA、Revision 任何请求的 `finishReason=length` 都在解析/持久化前 fail-closed；不会出现截断后继续 Persist。
- Revision JSON 缺少 `strategy/actions/preserve/ending`、空 `content`、协议包裹错误、`INVALID_REVISION_CONTRACT` 均拒绝 Persist。
- 长正文、quality/high reasoning、Segment Repair 和 Full Revision fallback 均走同一 response contract；Segment Repair 无效时只使用同一次 response 内的合法完整 content，不发送第 4 次常规请求。
- 本轮 12 个 D/Q/R receipt 均 `finishReason=stop`，无 `length`、malformed Revision JSON、`INVALID_REVISION_CONTRACT`、formatter 或 protocol fallback。

## 9. maxTokens 弹性 P0

- 模拟器保留的 LLM 配置：`context_window=65536`、`max_output_tokens=0`（AUTO）。
- 真实 D/R 请求解析为 `maxOutputTokens=13107`；Continuation QA 根据 frozen stage capacity 解析为 `3350`，`minOutputTokens=1675`；不是业务层写死的 4000/4096/8192/16384。
- Full-text Draft/Revision 的 target demand 仅用于需求估算；transport ceiling 由 providerCapabilities、当前模型 context window、elastic reservation 和 frozen stage capacity 共同解析，Provider adapter 才负责真实协议字段映射。
- 真实 log 中的 Planner/Observer max tokens 也来自解析后的上下文/阶段能力；它们与 Writer D/Q/R 分开统计。
- `npm run verify:elastic` 通过；生产 `callLLM`/`callLLMResult` numeric-second-argument scan 未发现固定业务上限。

## 10. SQLite 热路径

复核了 `pipeline_tasks`、`pipeline_stage_attempts`、Continuation artifacts/stage-results 以及 multi-chapter batch usage/adoption 路径：列表查询使用窄投影，正文/大 JSON 通过按需列读取或 chunk，不使用读取大载荷的 `SELECT *`。旧的 backup/export、Worldbook、Story Memory 和 legacy 读取不属于本轮 B10 pipeline 热路径，也没有把静态结论扩大为“全项目不存在 SELECT *”。本轮真实 DB 快照未出现新的 `SQLiteBlobTooBigException`。

## 11. Android 最终验收

- 构建：`npm run apk:debug` 通过。
- 交付 APK：`dist/apk/debug/ShineWriter-V2.21.1-debug.apk`
- APK SHA-256：`AED1FB623BAEA9D9B55A58A0749A4A181211C38F7CE53E10B83D65D82855C6B2`
- 设备：`emulator-5554`，包：`com.shinewriter`，`versionCode=2210100`。
- 安装：仅执行 `adb -s emulator-5554 install -r ...`，返回 `Success`；没有 uninstall、`pm clear`、reset 或清理已有应用数据。
- 覆盖安装后保留并核验：项目 23/40、LLM config、Continuation Writer Style `style-phase3b-cont-ready`、Canon snapshot `snap-phase3b-cont-ready`、Story Memory。项目 23 最终 `status=clean`、through position=6。
- 安装后真实 Outline UI：批次报告显示 `成功 2/2`、`完整流水线 2`；9234、9235 分别进入编辑器并通过“定稿”，DB 均为 `chapters.status=final`。
- Continuation v4 真实流程完成生成 → QA → Revision → 采纳/最终稿 → 定稿；9232/9233 为 `chapters.status=finalized`，run 为 `state=completed / completion_reason=adopted`。
- UI/DB 证据：`android-post-install-batch-report.png`、`android-post-install-ch9234-finalized.png`、`android-post-install-ch9235-finalized.png`、`db-post-install-finalized.sqlite`、`db-continuation-v4-final-restarted.sqlite`。
- 最终启动与流程日志未出现新的 `FATAL EXCEPTION`、`ReactNativeJS` 应用错误或 `SQLiteBlobTooBigException`。

## 12. Verify 最终证据

最终重新执行并通过：

```text
npm run verify:elastic  PASS
npm run typecheck        PASS
npm run verify           PASS
  lint: 0 errors / 216 existing warnings
  typecheck: PASS
  verify:elastic: PASS
  verify:version: [verify:version] ok V2.21.1 versionCode=2210100
  Jest: 4 skipped suites, 504 passed suites；9 skipped tests, 3638 passed tests
npm run apk:debug        PASS
adb install -r           Success
```

## 13. 历史审计排除项

- 旧报告中的标准矩阵 aggregate physical=17/29 不再作为本轮口径；凡是有 D/Q/R 的章节，当前报告均按真实 `3` 记录。
- 旧 retry/length receipts 保留在 ledger 供审计，但不进入当前 Exact HEAD 性能通过样本。
- `batch_mtcbp7pu_g2hu3f`：Continuation Observer 空 payload 导致 NO-GO，排除。
- `batch_mtcb9ge1_zdvqzr`：旧 Outline Revision contract 无效，排除。
- `batch_mtce1xaf_en8syb`：安装后误开的规划探针随后通过 UI 结束，`BATCH_CANCELLED`、Writer calls=0，排除，不作为 Standard Issue 样本。

## 最终决策

全新 Outline/Continuation Standard Issue 样本均为两章；每章真实 physical=3；所有最终 D/Q/R request `finishReason=stop`；12 个 D/Q/R 的 model-visible messages、messagesFingerprint、requestFingerprint 与 receipt/ledger 全部一致；Evidence QA hit/fallback 如实记录；Final-body state proposal、弹性 maxTokens、Revision fail-closed、SQLite 热路径和 Android 覆盖安装证据均通过。

**PHASE III-B FINAL SEALED / GO**

C 轮未启动。完成后停止。
