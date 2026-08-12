# Context Budget V3 全链路自动弹性预算最终收束与修复改造

## Verification Report — 2026-08-12

结论：**NO-GO**。

本报告按本地方案 `Tavo-Mini-Context-Budget-V3-Unified-Automation-Final-Closure-Plan.md` 逐项核验 42 个 Mandatory Gate。方案 SHA-256：`B21BCA34E82EDFD3F5E19E565C7AF5FC12452308B22EB0B63BB7DC73F369335A`。

实现与测试已完成，但 Gate 22、28、34、35、36、37、39、40、41 尚未全部满足真实 Android/覆盖场景要求；根据方案“任一 Mandatory Gate 未通过不得宣称完成”，因此本轮只能判 NO-GO。

### Evidence 基线

- Repo：`E:/AiWorkSpace/tavo-mini`
- HEAD：`bc464f537ecd4e1676c3cb6c92b0a4dea1dc3429`
- `origin/main`：`bc464f537ecd4e1676c3cb6c92b0a4dea1dc3429`
- Final debug APK：[ShineWriter-V2.11.49-debug.apk](../../dist/apk/debug/ShineWriter-V2.11.49-debug.apk)，59,030,122 bytes，SHA-256 `24663E97EB08F11B48B9530D9C6D6FF152B75E394EF1CBFB0DB70CBF2AB86C7E`
- Device：`emulator-5554`，最终安装命令为 `adb install -r E:\AiWorkSpace\tavo-mini\dist\apk\debug\ShineWriter-V2.11.49-debug.apk`，结果 `Success`
- 最终包信息：`versionCode=2114900`、`versionName=V2.11.49`、`targetSdk=36`、`firstInstallTime=2026-08-10 09:49:20`、`lastUpdateTime=2026-08-12 09:29:36`
- 未执行 `uninstall`、`pm clear`、数据库清空或清理用户数据；所有用户已有未提交修改和根目录历史调试产物均保留。

### Test 基线

- Targeted：6 suites / 40 tests PASS：`contextBuilderV3.integration`、`contextBudgetV3FinalClosure`、`pipelineHighPayloadFinalClosure`、`pipelineV3BriefAndBudget`、`multiChapterBatchRepository`、`derivedFinalPolicyFreeze`。
- UI targeted：`contextPreviewV4.test.tsx` 2 tests PASS；先验证旧四板块断言失败，再删除展示行后通过。
- Property：2 suites / 18 tests PASS；包含两个各 `10,000` trials 的 token-safe / hierarchical allocator property 集合。
- `npm run typecheck`：PASS。
- `npm run verify`：PASS；`382 passed, 3 skipped, 382 of 385 suites`；`3126 passed, 8 skipped, 3134 tests`。Lint 仅有既有 warnings，无 error。
- 最终 APK 启动后按 `FATAL EXCEPTION|ANR|CursorWindow|SQLiteException|OutOfMemoryError|ReactNativeJS.*(ERROR|Error)` 过滤当前进程 logcat：`NO_MATCHED_APP_ERRORS`。

## Gate 01 — Repo Preflight — GO

证据：首轮先执行了 `git status`、`git fetch --all --prune`，随后核对 local HEAD 与 `origin/main`，两者均为 `bc464f537ecd4e1676c3cb6c92b0a4dea1dc3429`。最终 `git status --short --branch` 仍为 `## main...origin/main`，原有未提交文件和未跟踪调试文件仍在，未执行 stage/commit/reset/checkout。

## Gate 02 — Full Scan — GO

证据：按方案对 `ContextConfig`、固定 Final cap、高 Payload query、Batch Policy/hash、Continuation category budget 做了 scoped `rg` 审计。最终 targeted query 扫描输出 `NO_TARGETED_SELECT_STAR`；`src/services/pipeline/compileStageRequest.ts` 固定 cap literal 扫描输出 `NO_COMPILE_STAGE_FIXED_CAP_LITERALS`。遗留 `ContextConfig` 仅保留兼容读取/旧版本路径，V6 入口不再用其决定实际 demand；全量 verify PASS。

## Gate 03 — Manual Context UI — GO

证据：`src/screens/OutlineEditor.tsx` 已移除章节手动“上下文配置”快捷入口，仅保留章节编辑器工具栏的“上下文”预览。最终 APK UI tree [context_preview_ui_latest_final.xml](../../test-logs/context_preview_ui_latest_final.xml) 与截图 [context_preview_ui_latest_final.png](../../test-logs/context_preview_ui_latest_final.png) 显示 V3 总预算摘要；[emulator_final_context_auto_policy_fix.xml](../../test-logs/emulator_final_context_auto_policy_fix.xml) 未显示 sliding/full/custom 或固定前文 token 输入。

## Gate 04 — Legacy Compatibility — GO

证据：Legacy Settings key、V1~V5 parser/兼容字段仍保留；旧任务不迁移。全量 `npm run verify` 中 legacy pipeline、resume、migration suites 均 PASS。新增的 V6 policy 校验只对 V6 Derived Final fail-closed，不破坏 V1~V5 旧任务查看/兼容路径。

## Gate 05 — V6 Ignores Legacy Budget — GO

证据：`contextBuilderV3.integration.test.ts` 的 Legacy Poison 测试 PASS；V6 分支候选、demand、resources、Story/Episodic 均不读取旧 strategy/slidingWindowSize/resourceBudget 作为实际 hard ceiling。`contextBudgetV3FinalClosure.test.ts` 与 `contextBuilderV3.integration.test.ts` 相关测试均 PASS。

## Gate 06 — Story Coverage — GO

证据：`collectStoryMemoryCoverageCandidates` 先取 raw 最近候选（上限 10），保留 seam metadata；`resolveStoryMemoryCoverage` 再由 V3 grant 决定 raw 与 episodic。Targeted 测试验证了旧 sliding budget 不参与候选先行，以及小/大 grant 会得到不同 raw/episodic 结果；无旧 4K hard gap 回归。

## Gate 07 — Recent Bridge Grant — GO

证据：候选先行后由 V3 allocator 决定 Recent Bridge；targeted/integration tests 验证 rendered bridge 不超过授权 grant。最终 Preview tree 显示 `Recent Bridge` 需求 `14,462`、分配 `14,462`，并在同一 V3 allocation trace 中呈现，见 [emulator_final_context_preview_policy_fix.xml](../../test-logs/emulator_final_context_preview_policy_fix.xml)。

## Gate 08 — Snapshot Dedup — GO

证据：V6 snapshot 清除上一章完整正文，只保留 `immediatePreviousChapterEnding/Id/Position` 和已授权 bridge；`pipelineTaskContext` 保留合法 V3 summary。`contextBuilderV3.integration.test.ts` 与 `contextBudgetV3Closure.test.ts` 相关 snapshot/continuity tests PASS。

## Gate 09 — Story State Demand — GO

证据：V6 Story State demand 使用实际 prepared render token；缺失、dirty、空内容为 0。V3 allocator property/integration tests 验证 empty board 可释放容量，不再以旧配置数字伪造 demand。

## Gate 10 — Resources Demand — GO

证据：Resources 采用 candidate-first，实际激活项求和；未发现 35/20/45 配比、resource-count 等分或旧 resourceBudget hard cap。大资源 candidate/full-fit 相关 targeted tests PASS。Android 两大 Character 的手工满配场景另见 Gate 34，尚未通过。

## Gate 11 — Episodic Demand — GO

证据：Episodic demand 使用实际 retrieval candidate token；空 retrieval 为 0，授权后由 V3 grant 决定是否注入。最终 Preview tree 显示 `Episodic` 需求 `7,232`、分配 `7,232`；Story Coverage targeted/property tests PASS。

## Gate 12 — Cross-board Borrow — GO

证据：allocator integration/property tests 覆盖空闲容量回收与跨 Board 借调，验证 `allocated > softTarget`、ceiling/burst/hard boundary 和 invariant。Android 真机/模拟器上尚未专门构造并捕获 `borrowed > 0`，该缺口属于 Gate 36。

## Gate 13 — Final Static Caps — GO

证据：`src/services/pipeline/compileStageRequest.ts` 已移除 Final Reviser 内固定 12K/8K/6K/4K/5K module hard cap；targeted `pipelineV3BriefAndBudget.test.ts` 验证 Final elastic module 来自 actual/model-relative allocation，且 32K→1M 测试通过。

## Gate 14 — Final Mandatory Boundary — GO

证据：Final compile 保留 Brief、Canonical Draft、Full Outline、Revision Instruction、Immediate Ending 的 mandatory boundary；相关 pipeline V3 tests 与全量 verify PASS，compiled request 仍在模型窗口与 reserved output 边界内。

## Gate 15 — Review/FactCheck/Proof — GO

证据：Review/FactCheck/Proof 使用共享弹性分配，没有新增业务绝对 cap；最终父任务 UI [emulator_final_v6_parent_result.xml](../../test-logs/emulator_final_v6_parent_result.xml) 显示五阶段全部成功；完整 verify PASS。

## Gate 16 — Brief — GO

证据：Brief 仍走 compact semantic/compiler path，不将其改成大上下文重审；最终父任务显示 `终稿 Brief · 成功`，UI tree 中有 `Brief Compiler（Thinking enabled + max；简化合同）`，见 [emulator_final_v6_parent_result.xml](../../test-logs/emulator_final_v6_parent_result.xml)。

## Gate 17 — Derived Final Narrow Read — GO

证据：`getPipelineTaskForDerivedFinalRewrite` 使用显式 metadata projection；`final_text`、`pipeline_context_json` 走单列 bounded chunk reader。`pipelineHighPayloadFinalClosure.test.ts` 用 500K 级 payload 验证 metadata 不带大 Blob，PASS。最终实际 Derived Final 完成且无 CursorWindow。

## Gate 18 — Derived Checkpoint Read — GO

证据：`getStageCheckpointsForDerivedFinalRewrite` 显式投影并逐 checkpoint/chunk 读取 `output_text`；task list 使用 metadata-only summary。`pipelineHighPayloadFinalClosure.test.ts`、checkpoint targeted tests 与全量 verify PASS。

## Gate 19 — Derived Call Count — GO

证据：最终 APK 真实链路的父任务 `pt_mspv1hzn_112` 产生 usage id 72–76 五个阶段调用；派生任务 `pt_rewrite_mspvbjp7_e7opfmx` 只新增 usage id 77、scenario=`pipeline_proof`。最终 DB usage 从 76→77，Derived 结果 [emulator_final_v6_derived_result.xml](../../test-logs/emulator_final_v6_derived_result.xml) 显示 37s、五个复用阶段和一次新 Final。

## Gate 20 — Derived Frozen Semantics — GO

证据：最终 DB 中父任务与派生子任务均为 `context_budget_version=6`，execution 与 draft Context Summary 均为 `context-automation-v3`，policy hash 均为 `4684f04609ec1ec0a627b6494f76698830a2547200125c79db9ec5858d8b8d69`，snapshot 存在且校验通过。新增 `derivedFinalPolicyFreeze.test.ts` 还验证了无 V3 Frozen Policy 的历史 V6 父任务会 fail-closed，不会以 live/default policy 偷渡派生。

## Gate 21 — High Payload Repository — GO

证据：Task list、unresolved restore、adoption、resume、derived 均已拆为 explicit projection / lazy chunk reader；`pipelineHighPayloadFinalClosure.test.ts` 和全量 repository/pipeline suites PASS。目标路径最终静态扫描无 `SELECT * FROM pipeline_tasks` 或 `SELECT * FROM pipeline_stage_checkpoints`。

## Gate 22 — Batch Policy Freeze — NO-GO

证据（已通过部分）：最终设备 DB 中 latest batch `batch_msptq301_u6fhk5` 为 `completed`、2/2、`used_llm_calls=12`、`context_budget_version=6`；planner envelope 含 `contextAutomationPolicyVersion=context-automation-v3`、hash `4684f04609ec1ec0a627b6494f76698830a2547200125c79db9ec5858d8b8d69` 和 snapshot。两个 child 均为 V6，且 execution policy/hash 与 parent 相同。`multiChapterBatchRepository`/batch integration tests PASS。

缺口：本轮未在 Android UI 上先修改 live Policy、再继续同一批次并单独捕获“后续 child 仍使用 parent hash”的完整手工操作证据。因此该 Mandatory Gate 按严格标准判 NO-GO。

## Gate 23 — Single Resume — GO

证据：`f301BatchResumeFrozenContext.test.ts` 与 `contextBudgetV3Closure.test.ts` 验证 frozen context/policy 在 resume 中保留，成功阶段不被重复写入；相关 targeted tests 及 full verify PASS。Android Resume 手工缺口另见 Gate 39。

## Gate 24 — Context Automation Settings — GO

证据：最终 APK [emulator_final_context_auto_policy_fix.xml](../../test-logs/emulator_final_context_auto_policy_fix.xml) 显示 `V3 策略与预算模拟（不修改模型真实能力）`、真实 `context_window/max_output_tokens`、`当前 V3 Policy` 与 hash，并明确模拟数字不会覆盖模型能力；未显示旧 V2 fixed-ratio cards。

## Gate 25 — Resources / Worldbook — GO

证据：V6 resources 不再由 Legacy `includeResources` 关闭整个 Board；episodic text 进入 worldbook activation haystack，recursion 归类为 retrieval feature。最终 Preview 显示 `7 项资料分配`、Episodic exclusion/coverage trace，见 [emulator_final_context_preview_policy_fix.xml](../../test-logs/emulator_final_context_preview_policy_fix.xml)。相关 resource/worldbook tests PASS。

## Gate 26 — Tail Clip — GO

证据：`contextBudgetV3Closure.test.ts` 的 Closure §12 token-safe property 运行 `10,000` randomized trials，覆盖 CJK、ASCII、mixed、emoji、punctuation、CRLF；Closure §24 allocator invariant 另运行 `10,000` trials。最终 targeted property command：2 suites / 18 tests PASS。

## Gate 27 — Continuation — GO

证据：Continuation V4 使用 frozen real model/category demand；空 category reclaim 和 Canon/Anchor hard semantics 相关 continuation suites 在 full verify PASS。未扩大架构或新增预算体系。

## Gate 28 — 32K/64K/128K/1M — NO-GO

证据（部分）：最终 APK Settings UI 曾验证 32K 与 1M simulation，最终 Preview 实际显示 `模型窗口 1,000,000`、强制输入上限 `956,000`；[emulator_post_install_32k.xml](../../test-logs/emulator_post_install_32k.xml)、[emulator_post_install_1m_fixed.xml](../../test-logs/emulator_post_install_1m_fixed.xml) 可复核。

缺口：未在当前 Android 设备上完成独立 64K、128K 手工窗口链路，也未完成完整“clipping 不反向增加”的四点 Android 证据，因此判 NO-GO。

## Gate 29 — Preview=Send — GO

证据：Preview 与 Send 共用 `buildContext`、V3 policy/hash、candidate coverage、Board/Item allocator 和 trace；`contextBudgetV3FinalClosure`/context integration tests PASS。Board/Item 细节仍在内部 trace 中用于一致性校验，用户预览仅展示 V3 总预算摘要。

## Gate 30 — Determinism — GO

证据：policy hash 为稳定 SHA-256；allocator/coverage/prompt tests 验证同输入得到同 allocation/trace，时间戳只在 persistence metadata，不进入 prompt bytes。`pipelineV32WorkflowIntegration` 的 exact policy snapshot/hash assertions PASS。

## Gate 31 — No Extra LLM — GO

证据：Preview、allocation、coverage、Derived metadata loading 都是本地/DB 逻辑；full parent 真实记录为 5 calls，Derived 真实记录只增加 1 个 `pipeline_proof` usage，见 Gate 19。自动预算未新增规划类 LLM 请求。

## Gate 32 — Full Verify — GO

证据：targeted、property、typecheck、lint、full `npm run verify` 全部完成；最终 full 结果为 `382 passed, 3 skipped` suites、`3126 passed, 8 skipped` tests。Lint 只有既有 warnings，无新增 error。

## Gate 33 — Android UI — GO

证据：最终 APK 覆盖安装后，Settings tree、Context Auto tree、章节编辑器 toolbar 与 Context Preview 均可读取；最终 Preview [context_preview_ui_latest_final.xml](../../test-logs/context_preview_ui_latest_final.xml) 显示 `上下文预览`、`上下文预算 V3 分层弹性`、模型窗口/强制输入上限/软线/突发线、必须保留/弹性池/突发池/风险等级，且不再出现 `Story State`、`Recent Bridge`、`Resources`、`Episodic` 四个板块行。截图 [context_preview_ui_latest_final.png](../../test-logs/context_preview_ui_latest_final.png) 可读，证明预算卡已收窄；当前 logcat 无 FATAL/ANR/CursorWindow/SQLiteException/OOM/ReactNativeJS 错误。

## Gate 34 — Android Big Resources — NO-GO

证据（部分）：代码和单测已覆盖大资源 candidate/full-fit；最终 Preview 有 7 项资料分配。

缺口：未在 Android 上手动灌入两个大 Character resource，验证大模型空间足够时两项均 full-fit，因此 NO-GO。

## Gate 35 — Android Poison Legacy — NO-GO

证据（部分）：V6 Legacy Poison 单测 PASS。

缺口：未在 Android UI 上把旧配置调到极端小值后真实发起 V6 任务并留存完整 UI/DB 证据，因此 NO-GO。

## Gate 36 — Android Borrow — NO-GO

证据（部分）：allocator property/integration 已验证跨 Board borrow invariant。

缺口：最终设备 Preview 的本次 allocation 没有产生 `borrowedTokens > 0`；未构造并捕获真实 Android `allocated > softTarget`/`borrowed > 0`，因此 NO-GO。

## Gate 37 — Android Model Switch — NO-GO

证据（部分）：最终 Settings simulation 显示 32K 与 1M 档位，最终 Preview 在 1M 下正确显示 956K hard input limit。

缺口：未完成“先小窗口实际任务 → 只切到 1M 模型 → 不点击 Apply → 自动扩张”的真实 Android 模型切换链路，故 NO-GO。

## Gate 38 — Android Derived Final — GO

证据：最终 APK 上真实操作“流水线结果 → 仅重写终稿 → 填写 `tighten dialogue` → 确认并执行”成功。确认框 [emulator_final_v6_derived_confirm.xml](../../test-logs/emulator_final_v6_derived_confirm.xml) 明确写出“只新增一次 Final API 调用”；结果 [emulator_final_v6_derived_result.xml](../../test-logs/emulator_final_v6_derived_result.xml) 显示 completed、五个上游阶段成功复用、Final 成功。最终 DB 的父/子任务与 usage 证据见 Gate 19/20，无 CursorWindow、无上游重跑。

## Gate 39 — Android Full Pipeline/Resume — NO-GO

证据（部分）：最终 APK 新父任务 `pt_mspv1hzn_112` 完成 Draft → Review → FactCheck → Brief → Final，五个 checkpoint 均 succeeded、attempt=1；UI [emulator_final_v6_parent_result.xml](../../test-logs/emulator_final_v6_parent_result.xml) 显示五阶段成功。

缺口：未在最终 APK 上执行一次可控中断/App switch/resume 并证明成功阶段不重复，因此 Gate 39 NO-GO。

## Gate 40 — Android Batch — NO-GO

证据（部分）：设备 DB batch `batch_msptq301_u6fhk5` 已完成 2/2，两个 child 均 V6、均拥有与 parent 相同 policy hash；批次 UI [emulator_batch_final_finished.xml](../../test-logs/emulator_batch_final_finished.xml) 显示 `成功：2/2`、`完整流水线：2`、`总调用：12`。

缺口：未完成同一批次的 Android Batch Resume 手工场景，因此即使 ≥2 章和 hash/version 已满足，Mandatory Gate 仍判 NO-GO。

## Gate 41 — Data Preservation — NO-GO

证据（已通过部分）：最终使用 `adb install -r`，firstInstallTime 从未改变；未执行 uninstall/pm clear。最终设备只读 DB 统计为 `projects=2`、`chapters=23`、`pipeline_tasks=13`、`pipeline_stage_checkpoints=64`、`llm_usage_logs=77`、`story_memory_snapshots=13`；最终 UI 仍保留 `ReviewTierE2E`、批次新增章节和已有章节内容。LLM Settings UI 仍显示默认配置/模型，未把 API key 明文导出。

缺口：本轮没有对 Android Keystore 中 API key 做不泄露前提下的专门连续性断言，因此按 Gate 的逐项严格证据要求判 NO-GO，而不是推断 API key 已验证保留。

## Gate 42 — Final Report — GO

证据：本文件已生成；42 个 Gate 均有单独证据、状态与缺口说明，所有缺失项均显式标为 NO-GO，最终总体决策没有被部分通过项覆盖。

## Final Decision

**NO-GO** — Gate 22、28、34、35、36、37、39、40、41 未全部 PASS。

本轮未 stage/commit/push。下一轮若要转 GO，必须补齐上述真实 Android 场景并重新运行至少 targeted/property/full verify、最终 APK `adb install -r`、数据保留检查和本报告 42 门复核。
