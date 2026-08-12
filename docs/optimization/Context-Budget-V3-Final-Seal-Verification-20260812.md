# Context Budget V3 Final Seal Verification — 20260812

## 结论

**最终结论：NO-GO。**

本轮已完成 V2 Proof Resume 红灯的最小测试修复、T02 Phase A→Phase B 因果断言、V3 Preview 分层摘要、冻结策略/多章恢复自动化，以及本地完整门禁和 Android 模拟器回归。仍有若干方案要求的“直接 Android 证据”未形成闭环，不能把自动化测试、旧 APK 产物或可推导结果冒充为封板证据。

## 1. 基线与范围

- 唯一执行仓库：`F:\ClaudeWorkSpace\projects\TAVO-MINI`
- 本轮起点 `HEAD`：`54ad7d0e6176680873bc5d7da4f0b0b929396e8e`
- 本轮起点 `origin/main`：同上；ahead/behind：`0/0`
- 起点 dirty：仅有用户提供的未跟踪方案文件 `docs/optimization/Context-Budget-V3-Final-Closure-Build-and-Seal-Plan-20260812.md`
- 执行中未使用 `git reset`、`git checkout`、覆盖或丢弃本地修改；本轮只修改本文件、方案要求的源文件和测试文件。
- Node：`v24.14.1`；npm：`11.14.1`；JDK：`17.0.19`
- ADB：`1.0.41`；目标：`emulator-5554`；Android SDK：36；包名：`com.shinewriter`

## 2. V2 Proof Resume 红灯

### 复现与定位

远端失败运行 `31600017847` 的唯一失败为：

```text
V2 Proof failure resume re-fires ONLY the V2 proof
Expected: 2
Received: 1
```

生产代码的 `safe_retry` 退避和“只重跑失败 proof stage”语义是正确的；失败来自集成测试依赖真实墙钟等待退避 timer，在 CI 调度下第一次断言时仍只观察到一次 proof attempt。没有修改生产 retry、没有加 sleep、没有删断言或降低标准。

### 最小修复与验证

`__tests__/pipelineWorkflowV2Integration.test.ts` 仅在该测试内使用 Jest fake timers，显式运行待处理 timers 后再等待真实 reconcile Promise；原有断言保持：draft/review/factCheck 各 1 次、proof 恰好 2 次、第二次 proof `request_version=2`，且没有协议降级。

Targeted 测试通过，随后 `npm run test:ci` 与 `npm run verify` 均通过。因此本问题判定为 CI/测试时序问题，不是生产 BUG。

## 3. T02 Phase A → Phase B 因果闭环

本轮没有重构 allocator、board priority、Story Coverage、Recent Raw Bridge、Episodic Reclaim 或 32K/1M 策略。`__tests__/contextBuilderV3.integration.test.ts` 新增的断言通过 spy 验证：

1. Phase A 先完成 preliminary demand/allocation。
2. Story Coverage 解析后排除已转为 Raw Bridge 的 episodic candidates。
3. Phase B 再次调用同一 `allocateHierarchicalContextBudget`，而不是循环或第二套 allocator。
4. final Resources allocation 高于 preliminary allocation，并出现 `borrowedTokens > 0`；最终总量仍不超过 hard limit。
5. final allocation 与对同一最终 demand 的 deterministic allocator 重算一致。

静态扫描确认 `contextBuilder.ts` 没有新增固定最终 cap、第二套 allocator、额外 LLM 调用、额外 DB retrieval 或 fixed-point loop。生产 Context Budget V3 主设计未扩展。

## 4. 本轮修改文件

- `__tests__/pipelineWorkflowV2Integration.test.ts`：V2 Proof CI 时序最小修复。
- `__tests__/contextBuilderV3.integration.test.ts`：T02 Phase A→B 因果与 allocator 重算断言。
- `__tests__/contextPreviewV4.test.tsx`：更新 Preview 断言，覆盖 V3 board 详情。
- `__tests__/multiChapterBatchStateMachine.test.ts`：3-child frozen policy + cold-start resume 因果测试。
- `src/screens/ContextPreviewScreen.tsx`：只读展示 V3 envelope 的分层预算摘要；隐藏四个 board 的 demand、soft、allocated、borrowed 明细，不改变策略或发送请求。
- `docs/optimization/Context-Budget-V3-Final-Closure-Build-and-Seal-Plan-20260812.md`：用户指定的执行方案文件。
- `docs/optimization/Context-Budget-V3-Final-Seal-Verification-20260812.md`：本封板证据。

## 5. 自动化验证

### Targeted

以下 9 个 suite 定向验证通过，共 87 tests：

```text
npx jest __tests__/pipelineWorkflowV2Integration.test.ts __tests__/contextBuilderV3.integration.test.ts __tests__/contextPreviewV4.test.tsx __tests__/multiChapterBatchStateMachine.test.ts __tests__/f301BatchResumeFrozenContext.test.ts __tests__/derivedFinalPolicyFreeze.test.ts __tests__/pipelineFinalSealShrink.test.ts __tests__/pipelineFinalArtifactValidator.test.ts __tests__/contextBudgetV3FinalClosure.test.ts --runInBand --ci
```

### 全量门禁

- `npm ci`：PASS。
- `npm run verify:version`：PASS，`V2.11.49 / versionCode 2114900`。
- `npm run lint`：PASS，`0 errors / 198 warnings`；没有 lint error。
- `npm run typecheck`：PASS。
- `npm run test:ci`：PASS，`383 passed / 2 skipped suites`，共 `383/385 suites`；`3134 passed / 7 skipped tests`，共 `3141 tests`。
- `npm run verify`：PASS，包含上述 lint、typecheck、version 和 Jest CI 门禁。

测试中的 dynamic import、SQLite fixture 和 native mock 警告均未转化为失败；没有跳过失败测试或放宽断言。

## 6. Android 构建、安装与数据保留

- `npm run apk:debug`：PASS；Gradle `BUILD SUCCESSFUL`。
- APK：`dist/apk/debug/ShineWriter-V2.11.49-debug.apk`
- 版本：`V2.11.49`；versionCode：`2114900`
- 安装命令：`adb -s emulator-5554 install -r dist/apk/debug/ShineWriter-V2.11.49-debug.apk`
- 安装结果：`Success`
- 全程没有执行 `adb uninstall` 或 `pm clear`。
- 安装前后 `firstInstallTime` 均为 `2026-08-08 04:17:52`，dataDir 保持 `/data/user/0/com.shinewriter`；仅 `lastUpdateTime` 按预期变化。
- 当前安装后数据库快照：`test-logs/emulator-qa-20260812-final-closure/db-final-install.sqlite`
- 当前快照 `pragma integrity_check`：`ok`；projects：`8`；chapters：`75`。
- `llm_config` 的 API key 非空计数为 `0`；没有把 credential、API key、完整 prompt 或完整模型响应写入证据。

## 7. 当前 APK 的 Android 真实证据

### Gate H Preview 分层摘要

当前最终 APK 的真实路径为：项目列表 → `3 写作` → `第二章 关系开启` → 横向滑动章节工具栏 → `上下文`。

证据：

- 文本：`test-logs/emulator-qa-20260812-final-closure/texts-context-preview-final.txt`
- UI hierarchy：`test-logs/emulator-qa-20260812-final-closure/ui-context-preview-final.xml`
- 截图：`test-logs/emulator-qa-20260812-final-closure/screen-context-preview-final.png`

真实 UI 只显示 `上下文预算 V3 分层弹性`、模型窗口、强制输入上限、软线、突发线、必须保留、弹性池、突发池、风险等级和总量摘要；按本轮 UI 要求，`Story State`、`Resources`、`Sliding Window`、`Episodic` 的 board 明细已隐藏。该章节不再从 UI 暴露 `borrowedTokens`，因此不能证明 Gate H 要求的 Android `borrowedTokens > 0` 场景。

### Gate L 的 Android 3-child 生产批次

本轮真实 Android 生产批次 `batch_msq670ef_34muuy` 完成 `3/3`：

- parent status：`completed`
- children：3 个均 `succeeded`
- 每个 child：完整流水线，`brief/draft/factCheck/proof/review` 五个 checkpoint 均 `succeeded`，每阶段 attempt `1`
- batch context budget version：`6`
- outline workflow version：`4`
- pipeline calls：`17`
- `pipeline_context_json` 中三个 child 的 frozen policy hash 相同，且与 batch planner envelope 相同：`4684e04609ec1ec0a627b6494f76698830a2547200125c79db9ec5858d8b8d69`
- execution 中的 policy version 为 `context-automation-v3`，模型 context window 为 `1,000,000`

证据：`test-logs/emulator-qa-20260812-final-closure/texts-batch-live-218s.txt`、`screen-batch-live-218s.png`、`db-batch-completed.sqlite`。这证明真实三章批次和 frozen snapshot 能完成，但没有发生 child 中途 force-stop 后的 resume，也没有 live policy mutation；不能直接升级为 Gate J/K/L 的严格 Resume/Mutation 证据。

## 8. Gate A–O 真实判定

| Gate | 判定 | 证据与边界 |
|---|---|---|
| A Repo/Environment Discovery | GO | 起点 HEAD、origin/main、dirty 状态、Node/JDK/ADB/serial 均已记录；未 reset/丢弃本地修改。 |
| B Post-Coverage Reclaim | GO | T02 integration 断言通过；Phase B 重新分配并满足 hard cap。 |
| C Reclaim Determinism | GO | 同一 allocator 的 final 重算一致；定向/full Jest 通过，未新增循环或第二 allocator。 |
| D Preview/Send | GO | 当前最终 APK Preview 可见 V3 envelope 分层摘要；相关 pipeline/preview regression 通过。 |
| E 32K/64K/128K/1M | NO-GO | 自动化覆盖通过；本轮最终 APK 只重新采集了 1M Preview，未重新采集四窗口的同一 SHA Android XML。旧 APK 证据不作为本轮直接证据。 |
| F Big Resources | NO-GO | 自动化回归通过；本轮最终 APK 未重新采集大资源 full-fit 的同一 SHA Android trace。 |
| G Poison Legacy | NO-GO | 自动化兼容回归通过；本轮最终 APK 未重新采集 poison legacy 的同一 SHA Android Preview。 |
| H Cross-board Borrow | NO-GO | board 明细按 UI 要求隐藏；当前 Preview 没有 Android `borrowedTokens > 0` 的直接可见证据。 |
| I Model Switch | NO-GO | 本轮最终 APK 重新进入的是已保存的 1M Preview；没有重新完成“切换小窗口→保存→回到 1M、且不点 Context Apply”的同一 SHA Android证据。 |
| J Batch Policy Freeze Mutation | NO-GO | 自动化测试证明 live policy 改变后 3-child resume 仍使用 frozen A；真实 Android 批次只有同 hash 完成，没有中途 live mutation 对照。 |
| K Single Resume | NO-GO | 自动化 resume 断言通过；本轮没有完成 Android“成功 stage 后中断、恢复且成功 stage 不重复”的闭环。 |
| L Batch Resume | NO-GO | Android 3-child 批次完成，但没有 child 中断后的最终 completed resume；自动化 cold-start resume 通过，不能替代实机证据。 |
| M Derived Final Regression | NO-GO | `derivedFinalPolicyFreeze`、Final Seal shrink/artifact validator 和 full verify 通过；本轮没有新的 Android Derived Final 端到端完成证据。 |
| N Data Preservation | GO | `adb install -r`、firstInstallTime、数据库 integrity、项目/章节计数和 API key 非空计数均满足；未 uninstall/pm clear。 |
| O Full Verification | NO-GO | `npm run test:ci`、`npm run verify`、assembleDebug 均通过；但 E–M 中列出的强制 Android 证据缺口仍存在，且远端 Actions 需以本轮提交后的真实运行结果为准。 |

## 9. 剩余 blocker 与封板结论

本轮没有发现需要继续扩展 Context Budget V3 主设计的生产 BUG。V2 红灯已按测试时序最小修复，生产 retry 语义保持不变。

仍需补齐才能 GO：

1. Android 真实场景中 `borrowedTokens > 0` 的 board-level 直接字段证据；
2. Android 批次中途 live policy mutation 后 child 继续使用 parent frozen hash；
3. Android 成功 stage 后的 Single Resume 完成闭环；
4. Android child 中断后的 Batch Resume 最终 completed；
5. 本轮最终 APK 的四窗口、大资源、poison legacy、model switch 和 Derived Final 直接证据。

因此本次封板结论为：**NO-GO**。不以旧 SHA 产物、可推导数字、自动化替代实机或未完成的远端运行结果伪造 GO。
