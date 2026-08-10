# Story Memory Final P1 验收报告

日期：2026-08-10

最终结论：**NO-GO**（按《Tavo-Mini-Story-Memory-Final-P1-Repair-Plan》要求，Gate F 的全部真实 LLM 子项必须通过；本轮仍有真实复杂长篇与人工 invalid-JSON Repair 缺少通过证据）。

## 1. 实施基线与卫生

- 按要求执行了 `git fetch --all --prune`。
- 最终复核：`HEAD=501e7f71697d91e12a2006f6bbb0f35706b23a12`，`origin/main=501e7f71697d91e12a2006f6bbb0f35706b23a12`，`git rev-list --left-right --count HEAD...origin/main = 0 0`。
- 首次进入本轮时的 `78f8c6e` 已由当前仓库历史提交 `501e7f7` 收束；未使用 reset、checkout、uninstall 或 `pm clear` 覆盖用户改动。
- 当前未提交改动包括 `__tests__/storyMemoryOutcomeRecovery.test.ts` 中补充的“后续 interval maintenance 可恢复”回归断言，以及本验收报告文件。
- 未推进 P2，未重构大纲 Budget V5，未扩大 Story Memory Batch，未修改章节正文、Schema 结构或 Provider。

## 2. 本轮收束内容

- Budget V5：新增冻结的 Story Memory LLM capability/request config；每个 primary、repair、fresh retry 独立规划 input/output，使用完整 prompt 预检，不再以旧的 16000 或 `memoryPatchMaxTokens` 硬夹断；无法容纳时在 HTTP 前 split。
- `outcome_unknown`：冷启动将 `sent` 归类为 `outcome_unknown`；自动维护 fail closed；用户取消不发请求；用户确认只终结选中的逻辑批次并保留 ledger 审计；恢复后可继续 interval maintenance。
- Hard Gap：`useChapterPipeline → Preview → Hard Gap` 本地立即阻断生成，并调用后台 enqueue，不等待 LLM。
- 任务与保活：统一 `story-memory:<projectId>` task；进度按真实章节范围/已完成批次计算；复用现有 Pipeline Foreground Service、notification 和 WakeLock；StoryMemoryScreen 收束为单 Primary CTA，诊断/设置折叠，人物/关系/主线折叠，页面卸载不取消后台任务。

主要实现文件：

- `src/services/storyMemory/storyMemoryRequestBudget.ts`
- `src/services/storyMemory/storyMemoryService.ts`
- `src/services/storyMemory/storyMemoryCheckpointService.ts`
- `src/services/storyMemory/storyMemoryForeground.ts`
- `src/store/storyMemoryTaskStore.ts`
- `src/data/repositories/storyMemoryRequestAttemptRepository.ts`
- `src/screens/StoryMemoryScreen.tsx`
- `src/screens/chapter-editor/hooks/useChapterPipeline.ts`

## 3. 自动化验证

Targeted tests：

- integration：8 suites / 48 tests passed；
- recovery：5 suites / 22 tests passed；
- P1：8 suites / 32 tests passed；覆盖 Budget V5、outcome recovery、task progress、Screen、checkpoint、no-stall、Hard Gap enqueue；
- 新增后的 `npx jest __tests__/storyMemoryOutcomeRecovery.test.ts --runInBand --ci`：1 suite / 1 test passed。

完整门禁 `npm run verify`：

- lint：0 errors，175 个既有 warnings；
- typecheck：passed；
- version consistency：`V2.11.41 versionCode=2114100`；
- Jest：364 suites passed，2 suites skipped；2937 tests passed，4 tests skipped。

## 4. APK 与升级安装

- `npm run apk:debug` 已通过，唯一交付路径：
  `dist/apk/debug/ShineWriter-V2.11.41-debug.apk`
- 为复用模拟器中已有 LLM，测试副本使用正式 keystore 重新签名后执行 `adb install -r`；没有卸载应用，也没有 `pm clear`。
- 包名 `com.shinewriter`、版本 `V2.11.41`、versionCode `2114100` 保持一致。
- `firstInstallTime=2026-08-07 10:36:16` 在覆盖安装后保持不变。
- 覆盖安装后项目 `release_touch_test`、活动 LLM 配置 `deepseek-v4-flash`、Base URL、掩码 API Key、`context_window=1000000`、`max_output_tokens=200000` 均保留。
- QA 结束后已把原始数据库恢复回模拟器；最终复核为 1 个 final 章节、Story Memory through position 3、原有成功 attempt、LLM 1M/200K 配置。

## 5. 真实 LLM / 模拟器证据

### 已通过

1. 普通 1M/200K 三章：使用模拟器已有 DeepSeek 配置，真实整理 3 个章节成功；数据库 Story Memory 从 position 3 推进到 position 6，批次 applied，notification/WakeLock 在完成后释放。
2. Foreground keepalive：整理期间切回 Home 后仍观察到 `ShineWriter · 长期记忆` 的 ongoing foreground notification、`pipeline_ongoing` channel 与 `shinewriter:pipeline` partial WakeLock；任务没有因页面离开而丢失。较慢的一次真实响应超过 5 分钟，返回 App 后完成，随后 WakeLock release。
3. Force-stop recovery：真实观察到 `sent → force-stop → cold start → outcome_unknown`；自动维护被阻断；UI 显示处理入口；取消没有产生新请求；确认后旧 unknown 变为 `cancelled / USER_ACKNOWLEDGED_OUTCOME_UNKNOWN`，新手动请求成功推进到 position 6。全程没有删除 ledger。
4. 小窗口 preflight：真实配置 `65536 / 32768`，25,000 字符级章节 fixture 触发了 `3 → 2 → 1` 的发送前拆分；ledger 中未出现初始三章 `4:6` 请求，首个真实请求为单章 `4:4`。每个逻辑批次物理请求上限为 3。

证据目录：`test-logs/android-qa/story-memory-final-p1-20260810/`。其中 `after-real-1m-3ch-shine_writer.db`、`after-unknown-resume-foreground-return-shine_writer.db`、`small-window-3-to-2-to-1-live-2s-shine_writer.db`、`final-restored-shine_writer.db` 保存了关键数据库快照。

### 未满足 / 未形成通过证据

1. 复杂长篇三章没有得到“完整成功”证据：在 1M/200K、较大 Previous State、三章约 18K 字符正文 fixture 下，逻辑批次 `7:9` 的 3 次真实 HTTP 请求均返回 200，但结构化主线校验失败，连续三次后按上限 fail closed，未错误写入 batch。根因定位为真实模型输出与 Story Memory 业务校验契约不一致，不是 output budget 越界或发送前 split 失效。
2. 计划要求的“人为制造一次 invalid JSON 的真实 Repair”尚未完成独立穿测；自动化 Repair/总请求数 `<=3` 已覆盖，但不能替代该真实 LLM Gate。
3. Force-stop 后“确认恢复成功，再由有待整理范围的真实 interval maintenance 发起后续请求”尚未单独形成完整真实证据；后续 interval 不再永久锁死已有单测覆盖，最终恢复快照也已清洁。
4. 因此不能宣称 Gate F 全部通过，严格结论必须是 NO-GO。

## 6. Gate 判定

| Gate | 判定 | 依据 |
| --- | --- | --- |
| A Budget V5 | PASS | capability freeze、独立 input/output 预算、1M/200K→200K、preflight split 与 targeted tests |
| B No-Stall | PASS | chapter finalize/no-stall 测试、Hard Gap enqueue 测试与代码路径 |
| C Durable | PASS | ledger、cold-start unknown、用户确认恢复、物理请求上限 |
| D Progress/Keepalive | PASS（背景完成时长仍需后续专门复核） | task store、foreground bridge、UI 进度、真实 notification/WakeLock |
| E UI | PASS | 单 Primary CTA、诊断折叠、unknown 入口、clean/no-pending 状态及 Screen tests |
| F Real LLM | **NO-GO** | 复杂长篇未成功；人工 invalid-JSON Repair 未完成；后续有 pending 的真实自动请求未形成证据 |
| G Regression | PASS | `npm run verify`、升级安装、数据保留、APK 版本一致性 |

结论：代码门禁和已执行的真实恢复/保活路径均可复核，但依照计划的全量 Gate F 规则，本轮不能给 GO。下一轮只需补齐上述三项真实穿测并重新生成报告，不应借此扩大本轮的 P2、Batch 或大纲范围。
