# Story Memory Protocol V2 Final Verification

日期：2026-08-11
仓库：`E:\AiWorkSpace\tavo-mini`
最终结论：**GO**
实施版本：`V2.11.45 / versionCode=2114500`；Schema 仍为 `50`

## 1. 基线与边界

- 已执行 `git status`、`git fetch --all --prune`。
- `HEAD = bca6632bb45254e68da22788f5800cdaf5a83147`。
- `origin/main = bca6632bb45254e68da22788f5800cdaf5a83147`。
- `final HEAD = bca6632bb45254e68da22788f5800cdaf5a83147`（本轮未提交，HEAD 未移动）。
- 工作树原有未提交修改全部保留；没有 `reset --hard`、覆盖修改或清理无关产物。
- 未改大纲 Pipeline、Continuation、Canon；没有推进 P2、没有扩大 Batch>3、没有新建第二套 Elastic Allocator。
- Schema 仍为 50；全部 Gate 通过后按方案第 54 节升为 `2.11.45 / V2.11.45`，并完成正式签名 APK 硬验收。

## 2. 已实施的 V2 主链

生产请求链已收敛为：

```text
Evidence Anchor + Entity Handle + Semantic Observation
  -> local Normalizer
  -> local Resolver / deterministic Compiler
  -> existing Batch Patch / Merger / CAS / DB
```

主要实现位置：

- `src/services/storyMemory/storyMemoryEvidenceAnchors.ts`：Q001…Q020+，Anchor 必须是正文连续子串。
- `src/services/storyMemory/storyMemoryEntityHandles.ts`：C/R/F/T/P/A 与章节 CH/N 的确定性 handle。
- `src/services/storyMemory/storyMemoryObservationTypes.ts`、`storyMemoryObservationNormalizer.ts`：10 类 Observation、wrapper/alias/default op、去重、局部丢弃与 warning。
- `src/services/storyMemory/storyMemoryObservationCompiler.ts`：按章节位置、Evidence offset、原始顺序 deterministic 编译到既有 `StoryMemoryBatchPatchDraft`，之后继续复用既有 Validator/Merger/CAS/DB。
- `src/services/storyMemory/storyMemoryObservationMaterials.ts`、`storyMemoryObservationPrompts.ts`：mandatory protocol/contract/range/handle/evidence 与 bounded whole-item materials；不把 Patch schema 交给模型直接维护。
- `src/services/storyMemory/storyMemoryObservationFormatter.ts`：body-free Formatter；Fresh Retry 不回显 assistant candidate。
- `src/services/storyMemory/storyMemoryCheckpointService.ts`：Primary → Formatter → Fresh Retry，冻结模型配置，每个 logical child batch 物理 HTTP 上限仍为 3；超窗按既有 3→2→1 split，并先持久化已完成子批次。
- `src/services/storyMemory/storyMemoryV2Diagnostics.ts`：只记录脱敏、bounded 的请求/材料/Observation 统计，不记录正文、完整 prompt、API Key 或模型原始响应。
- `src/services/storyMemory/storyMemoryDebugHarness.ts` 与 Android Debug bridge：仅在 Debug 构建提供受控的 invalid observation、Primary invalid JSON、Formatter invalid JSON 和 64K capability seam；Release 构建消费不到这些场景，不改变生产路径。

保留并复用：`outcome_unknown`、Foreground/WakeLock、Task Store、Partial Success、Fingerprint/CAS、既有 Batch Patch/Merger/DB。

本轮新增/修改范围集中在 Story Memory V2、其测试、Debug-only QA bridge、版本元数据与验收文档；未触碰 Outline Pipeline、Continuation、Canon 的生产实现。

主要修改文件：`storyMemoryCheckpointService.ts`、`storyMemoryService.ts`、`storyMemoryRequestBudget.ts`、`storyMemoryAttemptBudget.ts`、`storyMemoryBatchValidator.ts`，以及 `storyMemoryEvidenceAnchors.ts`、`storyMemoryEntityHandles.ts`、`storyMemoryObservation*.ts`、`storyMemoryProtocolVersion.ts`、`storyMemoryV2Diagnostics.ts`、`storyMemoryDebugHarness.ts`；对应 Jest 专项测试、Android Debug bridge mock/bridge、`README.md`、`CHANGELOG.md`、版本文件和本报告。

## 3. 自动化 Gate

| Gate | 结果 | 证据 |
|---|---|---|
| A Anchors | PASS | V2 专项测试 20 个 exact-substring anchor case；另含确定性 Q handle。 |
| B Handles | PASS | existing character、alias、relationship、thread、conflict、foreshadow、章节 handle 与 deterministic ordering 覆盖。 |
| C Normalizer | PASS | valid/wrapper/unknown key/missing optional/bad observation/duplicate/missing chapter 覆盖。 |
| D Compiler | PASS | 所有 Observation kind 编译到既有 Batch Patch schema。 |
| E Partial Degradation | PASS | 20 valid + 3 invalid → 20 accepted、3 warnings、Batch 可应用。 |
| F No Summary Dual-write | PASS | summary 从编译后的 Patch Observation 派生；没有恢复 Summary/Mainline 双写。 |
| G Budget | PASS | 1M/200K、128K/32K、64K/32K 的 bounded planning 与输出 reservation 覆盖。 |
| H Structured Input | PASS | whole-item packing；不截半行 entity、半 JSON、章节正文。 |
| I Attempt | PASS | 单元测试验证物理 HTTP ≤3；真实 ledger 本轮每个成功逻辑批次均为一个 primary。 |
| J Durable | PASS | 真实 force-stop → cold start → outcome_unknown → 用户确认 → 新 V2 请求成功。 |
| 100/300/1000 | PASS | V2 专项测试验证 100、300、1000 章请求材料不随总章节数线性膨胀。 |

预算与压力指标：V2 目标输出按 1/2/3 章使用 8192/14336/20480 reservation，hard cap 24576、单章保底 4096；64K 实测 child batch estimated tokens 为 3742 与 6816，最终 state 3990；所有物理 logical child 请求均未超过 3 次，Batch 未扩大到 3 章以上。

## 4. 测试结果

### 4.1 专项与全量

- `npx jest __tests__/storyMemoryProtocolV2.test.ts __tests__/storyMemoryDebugHarness.test.ts --runInBand --ci`：**2 suites / 37 tests passed**；包含 100、300、1000 章压力边界。
- `npm run verify`（V2.11.45 版本变更后重新执行）：**370 suites passed、2 skipped；3010 tests passed、4 skipped；lint/typecheck/verify:version 全部通过**。
- 专项日志：[140-story-memory-v2-specialized.log](../../test-logs/android-qa/story-memory-v2-final-20260811/140-story-memory-v2-specialized.log)
- 升版后全量日志：[148-npm-verify-v2.11.45.log](../../test-logs/android-qa/story-memory-v2-final-20260811/148-npm-verify-v2.11.45.log)

### 4.2 Debug APK 覆盖升级

- 构建命令：`npm run apk:debug`（V2.11.45），成功。
- APK：[ShineWriter-V2.11.45-debug.apk](../../dist/apk/debug/ShineWriter-V2.11.45-debug.apk)
- SHA-256：`213A80890991BF9C31ACCD61284EDAD31CA7C3D5790DE7E9AEEA62D625432B9E`
- 覆盖升级：从 V2.11.44 Debug 使用 `adb install -r`，结果 `Success`；未执行 uninstall、`pm clear` 或删除数据库/secure storage。
- 覆盖前后 `firstInstallTime` 均为 `2026-08-10 09:49:20`；覆盖后 `versionCode=2114500`、`versionName=V2.11.45`。
- 覆盖前后设备数据库 SHA-256 均为 `B25BE8CBAAE6A6DFC2795E00E456C7A074C456078CC890FE2ABF137CFA2BC9AA`；冷启动进程存在，UI hierarchy 正常，无 FATAL/ANR。
- 包信息：[154-pre-debug-v2.11.45-install-package.txt](../../test-logs/android-qa/story-memory-v2-final-20260811/154-pre-debug-v2.11.45-install-package.txt)、[155-post-debug-v2.11.45-install-package.txt](../../test-logs/android-qa/story-memory-v2-final-20260811/155-post-debug-v2.11.45-install-package.txt)、[155-debug-cold-start.log](../../test-logs/android-qa/story-memory-v2-final-20260811/155-debug-cold-start.log)

正式包也已按 Release 指南构建并硬验收：[ShineWriter-V2.11.45-release.apk](../../dist/apk/release/ShineWriter-V2.11.45-release.apk)，SHA-256 `E64CB86A3ADE508A5DAC15483C460D7CD4091AAF6AA9B35F69BB3E40AF15A1B3`；v2、单 signer、证书 `017b3f...d2a0a`、zipalign、包名和版本全部通过，详见 [150-verify-release-apk.log](../../test-logs/android-qa/story-memory-v2-final-20260811/150-verify-release-apk.log)。设备当前是 Debug 签名包（`bf825bc9...ed372`），Release 证书不同；在禁止卸载的约束下未用 Release 包覆盖 Debug 包，未绕过数据保留规则。

### 4.3 真实数据与 ledger

最终设备快照：[155-post-debug-v2.11.45-install.db](../../test-logs/android-qa/story-memory-v2-final-20260811/155-post-debug-v2.11.45-install.db)

- 原有项目、LLM 配置、API Key 保护、章节、Story Memory、ledger 均保留；API Key 没有进入 SQLite。
- 为按要求增加复杂长篇穿测内容，直接将测试正文写入第 14～16 章；未删除已有数据。三章均为 `final`，每章 `20831` 字符。
- SQLite `integrity_check=ok`；项目数：2；章节数：16。
- 项目 1 Story Memory：`through_chapter_position=15`、`estimated_tokens=3990`、`status=clean`、`last_error=''`。
- 已应用 Story Memory batch：13 个。
- ledger：17 个 attempt，其中 16 succeeded、1 cancelled；该 cancelled 是 force-stop 后用户确认 `outcome_unknown` 的原请求，随后已有新的成功 V2 attempt。
- 当前更新策略通过应用 UI 恢复为 `every_chapter`；`interval_chapters=3` 仅为历史字段，当前 mode 已是每章更新。
- 临时导入原复杂 Fixture 后以哈希 `EEB32AC2...64629AC` 原样完成设备安装与复测；复测结束用 `[142-pre-original-long-fixture-restore.db](../../test-logs/android-qa/story-memory-v2-final-20260811/142-pre-original-long-fixture-restore.db)` 恢复，恢复前后 SHA-256 均为 `43953B60...1356846`。

### 4.4 已通过的真实流程

- 普通三章与自动 maintenance 连续轮次：策略设为 every chapter；第 2/3 章一轮成功，第 4 章第二轮成功，相关证据见 [20-chapter2-before-finalize.db](../../test-logs/android-qa/story-memory-v2-final-20260811/20-chapter2-before-finalize.db)、[27-ch2-after-finalize.db](../../test-logs/android-qa/story-memory-v2-final-20260811/27-ch2-after-finalize.db)、[32-ch4-poll.db](../../test-logs/android-qa/story-memory-v2-final-20260811/32-ch4-poll.db)、[34-ch4-after-update.db](../../test-logs/android-qa/story-memory-v2-final-20260811/34-ch4-after-update.db)。
- 原复杂长篇失败 Fixture：原始 `complex-long-1m-fixture.db` 哈希与设备安装副本一致；其第 8～10 章（3×18000 字符）从 `through_position=6` 真实推进到 9，一次 `story_memory_v2_primary` HTTP 200，batch `1_7_9` `applied`，证据：[143-original-long-fixture-installed.db](../../test-logs/android-qa/story-memory-v2-final-20260811/143-original-long-fixture-installed.db)、[144-original-long-start.db](../../test-logs/android-qa/story-memory-v2-final-20260811/144-original-long-start.db)、[145-original-long-poll20.db](../../test-logs/android-qa/story-memory-v2-final-20260811/145-original-long-poll20.db)、[146-original-long-complete.db](../../test-logs/android-qa/story-memory-v2-final-20260811/146-original-long-complete.db)。
- Evidence Anchor + invalid observation：真实模型请求经过 V2 materials/anchor 协议，Debug-only seam 在真实 HTTP 返回后附加 1 个非法 handle；本地接受其余 observation，`warnings=1`，batch 仍 `applied`：[114-invalid-observation-complete.db](../../test-logs/android-qa/story-memory-v2-final-20260811/114-invalid-observation-complete.db)、[114-invalid-observation-complete.log](../../test-logs/android-qa/story-memory-v2-final-20260811/114-invalid-observation-complete.log)。生产诊断不保存原始响应，避免正文/API Key/完整 prompt 泄漏。
- Formatter：真实 Primary HTTP 200 后注入 invalid JSON，真实 Formatter HTTP 200 完成并 apply：[117-formatter-complete.db](../../test-logs/android-qa/story-memory-v2-final-20260811/117-formatter-complete.db)、[117-formatter-complete.log](../../test-logs/android-qa/story-memory-v2-final-20260811/117-formatter-complete.log)。
- Fresh Retry：真实 Primary 与 Formatter 均注入 invalid JSON，第三次真实 `story_memory_v2_fresh_retry` HTTP 200，state clean：[120-fresh-retry-complete.db](../../test-logs/android-qa/story-memory-v2-final-20260811/120-fresh-retry-complete.db)、[120-fresh-retry-complete.log](../../test-logs/android-qa/story-memory-v2-final-20260811/120-fresh-retry-complete.log)。
- 64K 小窗口：Debug capability 强制 `context_window=65536/max_output_tokens=32768`；3 章根批次先完成 `13→14` 的 2 章 child，再完成 `15→15` 单章 child，均 HTTP 200、`applied`，最终 through 15 clean：[134-small-window-start.db](../../test-logs/android-qa/story-memory-v2-final-20260811/134-small-window-start.db)、[135-small-window-poll-1.db](../../test-logs/android-qa/story-memory-v2-final-20260811/135-small-window-poll-1.db)、[136-small-window-complete.db](../../test-logs/android-qa/story-memory-v2-final-20260811/136-small-window-complete.db)、[136-small-window-debug.log](../../test-logs/android-qa/story-memory-v2-final-20260811/136-small-window-debug.log)。
- Force-stop 恢复：请求进入 `sent` 后强停；冷启动分类为 `outcome_unknown`；用户确认后旧 attempt 被取消、新 V2 attempt HTTP 200，memory 恢复 clean：[44-cold-start-outcome-unknown.db](../../test-logs/android-qa/story-memory-v2-final-20260811/44-cold-start-outcome-unknown.db)、[56-recovery-after.db](../../test-logs/android-qa/story-memory-v2-final-20260811/56-recovery-after.db)。
- Home/锁屏后台：第 10 章在 `mCurrentFocus=NotificationShade`、`mAwake=false`、`mDreamingLockscreen=true` 期间完成 HTTP 200 并 apply；WakeLock acquire/release 记录存在：[110-ch10-locked-complete.db](../../test-logs/android-qa/story-memory-v2-final-20260811/110-ch10-locked-complete.db)、[110-ch10-locked-window.txt](../../test-logs/android-qa/story-memory-v2-final-20260811/110-ch10-locked-window.txt)、[110-ch10-locked-power.txt](../../test-logs/android-qa/story-memory-v2-final-20260811/110-ch10-locked-power.txt)。

## 5. 真实 LLM Gate

| Real Test | 结果 | 说明 |
|---|---|---|
| 1 普通三章 | PASS | 真实三章推进与连续两轮 automatic maintenance 完成，primary→compile→apply。 |
| 2 原复杂长篇失败 Fixture | PASS | 原 `complex-long-1m-fixture.db` 原样导入，3×18000 字符从 through 6 推进到 9；一次 V2 primary HTTP 200，batch applied。 |
| 3 Evidence | PASS | 真实模型请求使用 Evidence Anchor materials；本地只接受 anchor/observation 编译结果。原始响应不落库是既定隐私约束，使用专项 contract/anchor 测试、bounded observation stats 与最终 CAS 状态审计。 |
| 4 Invalid Observation | PASS | 真实 HTTP 返回后 Debug-only 注入 1 个 invalid handle；其余 observations 被接受，warnings=1，batch 继续 applied。 |
| 5 Invalid JSON Formatter | PASS | 真实 Primary invalid JSON → 真实 body-free Formatter HTTP 200 → applied；无章节正文重新注入。 |
| 6 Fresh Retry | PASS | 真实 Primary 与 Formatter 均失败后，第三次 fresh retry HTTP 200；冻结配置/材料链保持不变并 applied。 |
| 7 64K 小窗口 | PASS | 真实 64K/32K capability seam 下 whole-item compact；3→2→1 child 依次持久化，两个 child 均 HTTP 200/applied。 |
| 8 Force-stop | PASS | 真实设备已闭环，见 4.4。 |
| 9 自动维护两轮 | PASS | 真实设备已闭环，见 4.4。 |
| 10 Home/锁屏/切换 App | PASS | 第 10 章在锁屏/休眠窗口中完成 HTTP 200 并 apply，窗口显示 asleep/NotificationShade，WakeLock 保活证据齐全。 |

## 6. 最终判定

**GO。**

V2 本地 Anchor/Handle/Normalizer/Compiler、既有 Batch Patch/Merger/CAS/Partial Success、`outcome_unknown`、Foreground/WakeLock、Task Store、3→2→1 split 均通过自动化与真实设备 Gate。原复杂长篇失败 Fixture 已用真实模型复测通过；Debug-only 注入仅用于证明降级分支，Release 构建不启用该桥接。

交付状态：

- 版本已升为 V2.11.45，Schema 50 未变。
- 最终 Debug 已完成保留数据的 `adb install -r` 覆盖升级并冷启动通过。
- 正式 Release APK 已构建并通过签名/zipalign/版本硬验收；由于设备当前 Debug 签名与 Release 签名不同且本轮禁止卸载，未用 Release 包覆盖设备，未影响 Debug 真实 Gate，也未清理任何用户数据。
- 工作树仍保留用户原有未提交修改；未执行 reset、uninstall 或 `pm clear`。
