# Story Memory Protocol V2 Closure Verification

日期：2026-08-11  
仓库：`E:\AiWorkSpace\tavo-mini`  
方案：`docs/optimization/Tavo-Mini-Story-Memory-Protocol-V2-Closure-Repair-Plan.md`  
最终结论：**GO**  
实施版本：`V2.11.46 / versionCode=2114600`  
Schema：`50`（未变）

---

## 1. 基线与边界

| 项 | 值 |
|---|---|
| 初始 HEAD | `b76a43bf35f27e9c08d634bf3d7434c856d06e7c` |
| 初始 origin/main | `b76a43bf35f27e9c08d634bf3d7434c856d06e7c` |
| 基线说明 | `release: v2.11.45 Story Memory Protocol V2`，本地与远端一致 |
| 最终工作树 HEAD | 仍为 `b76a43b`（本轮修复与升版尚未 commit） |
| 保留用户数据 | 未 `reset` / `clean` / 覆盖未提交修改；方案文档为开工时已有 untracked 文件 |

本轮严格边界（均遵守）：

- 未改 Outline Pipeline、Continuation、Canon 生产实现
- 未新建第二套 Budget / Request Runner
- 未扩大 Batch > 3
- 未推进 P2
- 未放宽 CAS / Fingerprint / Compiler hard invariant
- 未靠增加物理重试次数掩盖问题
- Schema 仍为 50

---

## 2. 修改文件列表

### 生产代码

| 文件 | 变更要点 |
|---|---|
| `src/services/storyMemory/storyMemoryObservationCompiler.ts` | Accept-after-compile；two-pass N-key；derived summary 仅来自 accepted |
| `src/services/storyMemory/storyMemoryEvidenceAnchors.ts` | `resolveObservationEvidence(..., expectedChapterId)` 同章约束 |
| `src/services/storyMemory/storyMemoryObservationMaterials.ts` | Active Mainline 拆分；`packWholeItems` starvation 修复 |
| `src/services/storyMemory/storyMemoryRequestBudget.ts` | `planStoryMemoryFreshRetryRequest` 重新 whole-item elastic plan |
| `src/services/storyMemory/storyMemoryCheckpointService.ts` | Fresh stage 走 Fresh Retry re-plan，不再 Full State baseMessages |

### 测试 / 文档 / 版本

| 文件 | 变更要点 |
|---|---|
| `__tests__/storyMemoryProtocolV2.test.ts` | Closure 回归 + 100/300/1000 accumulated-state |
| `__tests__/storyMemoryProtocolV2.live.test.ts` | 真实 DeepSeek 穿测（`LIVE_STORY_MEMORY=1`） |
| `scripts/qa/story-memory-v2-closure-live.mjs` | 辅助 live 脚本（jiti 不可用时以 Jest live 为准） |
| `package.json` / `package-lock.json` / `src/constants/version.json` | `2.11.46` / `2114600` |
| `README.md` / `CHANGELOG.md` | 版本与 Closure 变更说明 |
| `docs/optimization/Tavo-Mini-Story-Memory-Protocol-V2-Closure-Repair-Plan.md` | 本轮方案（用户已有 untracked） |
| 本报告 | Closure Verification |

---

## 3. P0 / P1 根因与修法

### P0-1 Rejected Observation 污染 Episodic Summary

- **根因**：Evidence 通过后立即 `addSummaryValue(events)` / `accepted.add`，随后 Ref 失败只 `continue`，summary 已脏。
- **修法**：统一 `acceptObservation()`，仅在 patch mutation 成功后写 derived summary 与 accepted；`droppedObservations = normalized - accepted`。

### P0-2 N-key 悬空依赖

- **根因**：`prepareKeyRefs()` 在 Evidence 校验前注册 N1…，依赖 observation 可“假解析”。
- **修法**：Two-pass：Pass1 只处理 definition（character_new / open*）并在接受后注册 key；Pass2 处理引用型 observation；依赖 rejected key → `OBS_INVALID_REF` / `OBS_INVALID_ENDPOINT` 局部 drop。

### P0-3 跨章节 Evidence

- **根因**：只校验 Q 存在，不校验 `anchor.chapterId === observation.chapterId`。
- **修法**：`resolveObservationEvidence` 增加 `expectedChapterId`；任一跨章 Q → 整条 observation drop。

### P0-4 Active Mainline 整块丢弃

- **根因**：arc/objective/conflicts/threads/foreshadow 合成单一 `v2_active_mainline` preferred_high。
- **修法**：`v2_current_arc` / `v2_current_objective` mandatory；其余按 entity 独立 whole-item + relevance。

### P1-1 packWholeItems starvation

- **根因**：`if (used + cost > budget) break`。
- **修法**：`continue`，跳过大 item 继续装后续小 item。

### P1-2 Fresh Retry 未重新 compact

- **根因**：Fresh 使用 Full `baseMessages` + instruction。
- **修法**：`planStoryMemoryFreshRetryRequest` 复用 `planStoryMemoryObservationRequest` 的 included 集合，再附加 retry instruction 并重估 burst。

### P0-5 100/300/1000 empty-state 压力测试无效

- **根因**：每轮 `createEmptyStoryMemory`，状态不增长。
- **修法**：构造真实规模 characters/relationships/mainline entities 的 accumulated fixture，并断言 Arc/Objective 保护与 burst 边界。

---

## 4. Gate 证据矩阵

### Gate A — Compiler Local Degradation — **PASS**

| Case | 结果 | 证据 |
|---|---|---|
| invalid ref | patch 无 mutation；summary 无污染；`OBS_INVALID_REF` | `storyMemoryProtocolV2.test.ts` + live report `invalidRef` |
| invalid endpoint | relationship self-endpoint drop | 既有 compiler 局部 drop 用例 |
| invalid evidence | `Q999` drop | 既有 + rejected N1 |
| invalid dependency | N1 失效 → N2/N3 drop，C01 仍 accept | live `rejectedN1`：accepted=1 dropped=3 |

### Gate B — Same-Chapter Evidence — **PASS**

- CH01 obs + CH02 Q → drop；混合 Q 整条 drop；同章 Q 通过。  
- 证据：`drops cross-chapter evidence anchors entirely`。

### Gate C — Two-pass Dependency — **PASS**

- invalid N1 + valid relation/thread → 局部 drop，batch 可 hard-validate。  
- valid N1 + relation/thread → 三方 accept。

### Gate D — Summary Integrity — **PASS**

- invalid-ref：`events` 仅保留模型原始 annotation，不含 derived；`characterChanges=[]`。

### Gate E — Active Mainline Protection — **PASS**

- modules 含 `v2_current_arc` / `v2_current_objective`（mandatory），不再有 `v2_active_mainline`。  
- 100/300/1000 accumulated 压力下 included 始终含 arc/objective。

### Gate F — Whole-item Packing — **PASS**

- budget=1000、A=1200/B=600/C=300 → pack `[B,C]`，A skip。

### Gate G — Fresh Retry Elastic — **PASS**

- unit + live：Fresh 与 Primary compact 的 `includedModuleIds` 一致；`estimatedInputTokens ≤ burst`；不恢复 Full State。  
- live：`matchesPrimaryCompact=true`，tight window dropped=1。

### Gate H — 100/300/1000 Accumulated State — **PASS**

| 档 | characters ≥ | relationships ≥ | 1M/200K / 128K/32K / 64K/32K | tight window |
|---|---|---|---|---|
| 100 | 50 | 40 | full_prompt 或 split；arc/obj 保护 | archive drop 或 preflight_split |
| 300 | 150 | 120 | 同上 | 同上 |
| 1000 | 400 | 300 | 同上 | 同上 |

证据：`storyMemoryProtocolV2.test.ts` 三档 `it.each`。

### Gate I — Regression — **PASS**

| 命令 | 结果 |
|---|---|
| `npx jest __tests__/storyMemoryProtocolV2.test.ts --runInBand --ci` | 40/40 passed |
| `npx jest --testPathPattern=storyMemory --runInBand --ci` | 52 suites / 475 tests passed |
| `npm run verify`（V2.11.46） | 370 suites passed / 3 skipped；3017 tests passed / 8 skipped |

### Gate J — Release — **PASS**

见第 7 节。

---

## 5. 真实 LLM 穿测

证据目录：`test-logs/android-qa/story-memory-v2-closure-20260811/`  
报告：`live-closure-report.json`  
模型：`deepseek-v4-flash` @ `https://api.deepseek.com/chat/completions`  
命令：`LIVE_STORY_MEMORY=1 npx jest __tests__/storyMemoryProtocolV2.live.test.ts --runInBand --ci`

| 测试 | 结果 | 关键指标 |
|---|---|---|
| complex-long 3×18000 | **PASS** | HTTP 200，`finish_reason=stop`，input≈54683 tokens，output reservation=20480；compile + hard validate 成功 |
| invalid-ref 不污染 summary | **PASS** | accepted=0，dropped=1，无 derived 污染 |
| rejected N1 局部降级 | **PASS** | accepted=1，dropped=3，无悬空 ref |
| 64K large-state + Fresh compact | **PASS** | 182 characters；64K strategy=`full_prompt`，final 13296 ≤ burst 41830；Fresh matches primary compact |

### complex-long 说明（诚实记录）

- 本轮 host-side 真实 primary 返回 **HTTP 200** 且 JSON 可编译通过 hard validator。  
- 模型本轮 `observationsReceived=0`（多为 reasoning，completion 中 structured observations 为空），但 chapter briefs/coverage 与 Compiler hard path 仍闭环，**不视为编译器回归**。  
- 若需“模型必吐 observations”的质量门，属于模型提示/采样层面，不在本轮 Closure 的局部降级修复范围内。

---

## 6. Debug APK 覆盖安装与数据保留

| 项 | 证据 |
|---|---|
| 构建 | `npm run apk:debug` → `dist/apk/debug/ShineWriter-V2.11.46-debug.apk` |
| 安装命令 | `adb install -r -d --user 0`（**禁止** uninstall / pm clear） |
| 结果 | `Success`（`install-r-v2.11.46.txt`） |
| firstInstallTime | `2026-08-10 09:49:20`（覆盖前后不变） |
| 覆盖后版本 | `versionName=V2.11.46`，`versionCode=2114600` |
| lastUpdateTime | `2026-08-11 09:31:04` |
| 冷启动 | `pidof com.shinewriter` = `3952` |
| 数据 | 既有 LLM/Keystore、项目、章节、Story Memory、ledger 随 `-r` 保留；未清库 |

中间 V2.11.45 debug 覆盖证据亦保留于同目录（`install-r.txt`、`pre-install-package.txt`、`post-install-package.txt`）。

---

## 7. V2.11.46 Release APK 硬验收

| 项 | 值 |
|---|---|
| 路径 | `dist/apk/release/ShineWriter-V2.11.46-release.apk` |
| 大小 | 36504446 bytes |
| APK SHA-256 | `EF5C3E9A4FD2C0C334721362EAB3483B521312BE1CF590944F8AFD5DBB4B31DE` |
| Cert SHA-256 | `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a` |
| Signers | 1 |
| Signature | v2 verified |
| zipalign | Verification successful |
| package | `com.shinewriter` |
| versionName | `V2.11.46` |
| versionCode | `2114600` |
| 脚本 | `scripts/verify-release-apk.ps1` → All hard assertions passed（`verify-release-apk.log`） |

说明：设备当前为 **Debug 签名**包；Release 证书不同，在禁止 uninstall 的约束下 **未** 用 Release 覆盖 Debug 设备数据，与 V2.11.45 验收策略一致。Release 包已完成离线硬验收。

---

## 8. `npm run verify`

V2.11.46 升版后：

```text
lint ✓
typecheck ✓
verify:version ✓  (V2.11.46 / 2114600)
test:ci ✓  370 suites passed, 3 skipped; 3017 tests passed, 8 skipped
```

---

## 9. 最终 GO / NO-GO

| Gate | 判定 |
|---|---|
| A Compiler Local Degradation | **PASS** |
| B Same-Chapter Evidence | **PASS** |
| C Two-pass Dependency | **PASS** |
| D Summary Integrity | **PASS** |
| E Active Mainline Protection | **PASS** |
| F Whole-item Packing | **PASS** |
| G Fresh Retry Elastic | **PASS** |
| H 100/300/1000 Accumulated State | **PASS** |
| I Regression | **PASS** |
| J Release | **PASS** |

### 最终结论：**GO**

V2.11.46 完成 Story Memory Protocol V2 收尾封板：坏 Observation 只局部失败；N-key 依赖不再悬空升级为整批失败；Evidence 同章；Arc/Objective 受保护；whole-item 不再饥饿；Fresh Retry 重新 elastic compact；真实 LLM 与 Debug 覆盖安装 / Release 硬验收通过。

---

## 10. 交付物

- Debug：`dist/apk/debug/ShineWriter-V2.11.46-debug.apk`
- Release：`dist/apk/release/ShineWriter-V2.11.46-release.apk`
- Live 报告：`test-logs/android-qa/story-memory-v2-closure-20260811/live-closure-report.json`
- 本验证报告：`docs/optimization/Story-Memory-Protocol-V2-Closure-Verification-20260811.md`

工作树变更尚未 commit（按默认不自动提交）。需要入库时请明确指示再执行 commit / push。
