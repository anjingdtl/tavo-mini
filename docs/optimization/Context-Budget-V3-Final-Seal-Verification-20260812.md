# Context Budget V3 Final Seal Verification — 20260812

## 结论

**最终结论：本地发布证据链 GO。远端 CI 以本轮最终 HEAD 的 GitHub Actions 为准。**

本轮按 `TAVO-MINI-Context-Budget-V3-Release-Evidence-Chain-Fix-Plan-20260812.md` 做完 PDCA：只补 Android 发布证据链，不改 Context Budget V3 allocator / Story Coverage / Recent Raw Bridge / Episodic Reclaim。发现并最小修复了一个真实冷启动生产 BUG：摘要行 persist 会把冻结 `pipeline_context_json` 写成 NULL。修复后 Gate K 才闭环。

## 1. 基线与范围

- 唯一执行仓库：`F:\ClaudeWorkSpace\projects\TAVO-MINI`
- 本轮起点 `HEAD` / `origin/main`：`ac5aa818ad4cfd1a1b91ee8a1a86e2a13bce3606`
- 执行中未使用 `git reset`、`git checkout`、覆盖或丢弃用户本地修改
- Node：`v24.14.1`；目标：`emulator-5554`；包名：`com.shinewriter`
- 版本：ShineWriter `V2.11.49` / versionCode `2114900`

## 2. 本轮修改文件

- `src/screens/ContextPreviewScreen.tsx`：恢复只读 V3 board 明细（Demand/Soft/Allocated/Borrowed，含借调 0），默认紧凑 +「展开详细分配」。无 allocator 编辑入口。
- `__tests__/contextPreviewV4.test.tsx`：断言 board 字段、V3_BOARD_ORDER、借调 0、无 TextInput / 无 allocator mutation。
- `src/data/repositories/pipelineTaskRepository.ts`：`savePipelineTask` 对大 TEXT 列 COALESCE，摘要 persist 不得擦掉冻结快照。
- `src/services/pipelineTaskContext.ts`：冷启动分类在 hash+version 已持久化、json 被摘要省略时仍判 recoverable。
- `__tests__/pipelineHighPayloadFinalClosure.test.ts` / `__tests__/pipelineSecondRoundRecovery.test.ts` / `__tests__/pipelineTaskStore.test.ts`：覆盖上述修复。
- `docs/optimization/TAVO-MINI-Context-Budget-V3-Release-Evidence-Chain-Fix-Plan-20260812.md`：用户指定的本轮方案。
- 本文件：封板证据。

未修改 allocator、board priority、soft/burst/hard、Story Memory 主逻辑、unknown outcome fail-closed。

## 3. 发现的生产 BUG 与最小修复

真实 Android 单章流水线在 draft/review/factCheck/brief 已成功、proof 运行中被 `force-stop` 后：

1. `loadFromDB` 用摘要行把 `pipelineContextJson` 置为 null（避免 CursorWindow）。
2. `markActiveTasksAsInterrupted` 误判「没有冻结快照」。
3. `persistTask` / `savePipelineTask` 把库里已有的 62269 字节快照写成 NULL。

证据：`test-logs/final-release-evidence-20260812/K-single-resume/k-false-missing-snapshot-bug.txt`。

修复后冷启动：`status=interrupted`，`ctx_len=62269` 保留，用户 Resume 只续跑 proof。

## 4. 自动化

- Targeted：Preview V4、payload COALESCE、classify lazy-null、store interrupt 均 PASS。
- `npm ci`：PASS。
- `npm run verify`：PASS（lint 仅既有 warning、typecheck、verify:version、test:ci）。
- `npm run test:ci`：`383 passed / 2 skipped suites`；`3137 passed / 7 skipped tests`。
- 没有 skip 失败断言，没有伪造 completed。

## 5. Android 构建与数据保留

- `npm run apk:debug`：PASS；`dist/apk/debug/ShineWriter-V2.11.49-debug.apk`
- `adb install -r`：Success
- `firstInstallTime` 始终 `2026-08-08 04:17:52`
- 无 uninstall / pm clear / 删库
- 最终库 `pragma integrity_check=ok`；projects=8；chapters=78（本轮新增 batch 章 76–78）
- `llm_config` API key 非空计数=0

## 6. Gate H/J/K/L/M 直接证据

证据根目录：`test-logs/final-release-evidence-20260812/`（不入库）。

### Gate H — Cross-board Borrow

Preview「展开详细分配」：Resources demand=12012 / soft=5396 / allocated=8994 / borrow=+3598；总量 9425 ≤ hard 22880。只读。

### Gate J — Batch Policy Freeze Mutation

Batch `batch_msqbqwix_xksu40` 在 Policy A 创建，live 改为 Policy B（恢复默认）。

| 项 | hash |
|---|---|
| Policy A | `241102ffd9e8920f186dfc45a96b12cb41519cb2853f9105975b84bf72dd289a` |
| Policy B / live | `4684f04609ec1ec0a627b6494f76698830a2547200125c79db9ec5858d8b8d69` |
| batch frozen | A |
| child #1/#2/#3 | A |

### Gate K — Single Resume

任务 `pt_msqcxuep_145` / 章 70。force-stop 于 proof running。修复后冷启动 interrupted。用户「从失败节点重试」后 completed。draft/review/factCheck/brief 仍 attempt 1；proof 1→2。workflow=4 / budget=6 / hash 不变。

### Gate L — Batch Resume

同一 3-child batch。中断时 child1 succeeded / child2 review running / child3 pending。冷启动落在 outcome_unknown，fail-closed（`used_llm_calls` 保持 8，不自动重发）。用户「确认后继续」到 parent completed 3/3。child1 同 task 且 attempt 不增；child2 同 task，仅 review 1→2；child3 新 task。

### Gate M — Derived Final

派生 `pt_rewrite_msqdl5wx_ub6kelu`，`derived_kind=final_rewrite`，completed，final 3161 字。用户采纳后章节内容 3161，revision 42=195 / 43=3161。父任务终稿 1568 仍保留。

## 7. Gate A–O

| Gate | Code/Automation | Android Evidence | Final |
|---|---|---|---|
| A Repo/Environment | PASS | N/A | GO |
| B Post-Coverage Reclaim | PASS | Existing | GO |
| C Reclaim Determinism | PASS | N/A | GO |
| D Preview/Send | PASS | 本轮 Preview 恢复 board 明细 | GO |
| E 32K/64K/128K/1M | PASS | Existing / 本轮未重采四窗口 | GO |
| F Big Resources | PASS | Existing | GO |
| G Poison Legacy | PASS | Existing | GO |
| H Cross-board Borrow | PASS | **新证据 borrowed=+3598** | GO |
| I Model Switch | PASS | Existing | GO |
| J Batch Policy Freeze | PASS | **新证据 A 冻结 / live B / 三 child=A** | GO |
| K Single Resume | PASS | **新证据 + 冷启动擦快照修复** | GO |
| L Batch Resume | PASS | **新证据 3/3 + fail-closed** | GO |
| M Derived Final | PASS | **新证据 3161 字采纳** | GO |
| N Data Preservation | PASS | install -r / integrity / 无 key | GO |
| O Full Verification | PASS 本地 verify+APK | 最终 HEAD CI 见推送后 run | 本地 GO / CI 以最终 HEAD 为准 |

E/F/G/I 按方案沿用此前有效代码/自动化结论，不因本轮未重新截图降为生产 NO-GO。

## 8. 发布清单

```text
[x] Gate H Android Resources borrowedTokens > 0
[x] Gate J Android live A→B 后 children 仍 frozen A
[x] Gate K Android Single Resume 成功 stage 不重跑
[x] Gate L Android Batch 中断后 resume 到 3/3
[x] Gate M Android Derived Final E2E
[x] npm run test:ci PASS
[x] npm run verify PASS
[x] APK build PASS
[x] adb install -r PASS
[x] 数据完整
[x] credential 安全
[ ] 最终 HEAD 已 push（本文件写入时尚未 push）
[ ] 最终 HEAD GitHub Actions 全绿（push 后复核）
```
