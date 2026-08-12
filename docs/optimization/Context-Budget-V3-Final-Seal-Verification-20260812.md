# Context Budget V3 Final Seal Verification — 20260812

## 结论

**最终结论：NO-GO。**

Post-Coverage Episodic Demand Reclaim 已完成代码与本地测试闭环；但按本方案“Seal Gate A~O 任一缺证据即 NO-GO”的规则，本轮 Android 的 Gate H、J、K、L、M 仍没有完整实证，因此不能封板 GO。

## 1. 环境与仓库真相

- Repo root：`F:\ClaudeWorkSpace\projects\TAVO-MINI`
- 初始/最终 local HEAD：`faccaf42bdf846787b826ea76f4ac5f0aa3fbf6b`
- 初始/最终 `origin/main`：`faccaf42bdf846787b826ea76f4ac5f0aa3fbf6b`
- `git merge-base HEAD origin/main`：同上；ahead/behind：`0/0`
- 已执行：`git status`、`git fetch --all --prune`；fetch 后再次核对 HEAD 与 `origin/main` 一致。
- 初始 dirty 内容已保护：
  - `src/services/contextBuilder.ts`
  - `__tests__/contextBuilderV3.integration.test.ts`
  - 用户已有未提交文件 `docs/optimization/Tavo-Mini-Context-Budget-V3-Final-Seal-Plan.md`（未修改）
- Node：`v24.14.1`
- JDK：`17.0.19`
- ADB：`1.0.41`，serial：`emulator-5554`
- Android：`sdk_gphone16k_x86_64` / SDK 36
- 环境原始输出：`test-logs/context-budget-v3-final-seal-20260812/environment-final.log`

本地环境没有使用历史设备 serial、历史 SDK/JDK 路径或 APK 路径作为源码假设；实际路径仅记录在本验收证据中。

## 2. 本轮实现

### 根因

V3 Phase A 为 Episodic 计算 natural actual demand 时，候选集仍可能包含稍后由 Story Coverage resolve 后提交到 Recent Raw Bridge 的章节摘要。Coverage 完成后，如果不重新计算，Episodic 会继续占用已经不再需要的需求额度，释放空间也不会回到其它 unmet Board。

### Phase A / Phase B

`src/services/contextBuilder.ts` 的处理为：

1. Phase A 在内存候选集上计算 Episodic natural demand，并用同一份候选数据完成资源候选采集与第一次 `allocateHierarchicalContextBudget`。
2. Story Coverage resolve 后，用 `rawChapterIds` 调用 `excludeRawFromEpisodicCandidates`。
3. 只在内存中对剩余 Episodic 候选重新测量 actual demand；不重新读 DB、不重新检索、不重新调用 LLM、不重新收集 Resources candidates。
4. 只有 demand 发生变化时，使用同一个 hierarchical allocator 做一次 deterministic Phase B allocation；同时把已提交的 Raw Bridge demand 作为 Sliding continuity floor，避免最终分配缩回已承诺内容。
5. `applyV3Allocation` 覆盖最终四个 Board grant；后续 memory/render/Preview/Frozen Draft/Send 读取最终 grant。

`V3_DEMAND_PROBE_BUDGET = 1,000,000` 仅用于测量 natural demand 的无裁剪探针，最终分配仍完全由 model-relative envelope、Board demand、soft/elastic ceiling 和同一 allocator 决定；它不是发送请求的固定 token cap。

静态扫描：

- `allocateHierarchicalContextBudget` 在 `contextBuilder.ts` 只有 Phase A 与一次 Phase B 两个调用点。
- Phase B 没有 `while`/fixed-point loop。
- 没有新增第二套 allocator、固定最终 cap、额外 LLM 调用或额外 DB retrieval。
- 证据：`test-logs/context-budget-v3-final-seal-20260812/static-scan.log`

### Allocation 对照

| 对照 | 证据 |
|---|---|
| Preliminary Episodic 包含待转 Raw 的 summaries | T01/T02/T03 integration fixtures；Phase A 先计算完整候选 demand |
| Post-Coverage 排除 Raw 并重算 | T01 断言全 Raw 后 Episodic actual demand 为 0；T03 断言 partial Raw 后仅保留非 Raw summaries |
| 释放容量回到 unmet Board | T02 用同一 allocator 重算，断言 Resources `allocatedTokens` 与 final allocator 一致且 `borrowedTokens > 0` |
| Hard safety | T02、T04/T05 断言 final total 不超过 `hardInputLimit`；T04/T05 覆盖 32K 与 1M |
| Determinism | T06 20 次并发 build 的完整 hierarchical trace 一致 |

Android 大资源 trace 还给出了一组真实 allocation 对照：32K 下两个大资源 demand 为 `12,042`、`12,044`，分配为 `3,718`、`3,718`，第三个资源 `62→62`；1M 下三项均 full-fit，即 `12,042→12,042`、`12,044→12,044`、`62→62`。

## 3. 自动化验证

### Targeted

命令：

```text
npx jest __tests__/contextBuilderV3.integration.test.ts __tests__/contextBudgetV3Closure.test.ts __tests__/contextBudgetV3.spec.test.ts __tests__/pipelineHighPayloadFinalClosure.test.ts __tests__/derivedFinalPolicyFreeze.test.ts __tests__/f301BatchResumeFrozenContext.test.ts __tests__/multiChapterBatchWorkflowVersion.test.ts __tests__/multiChapterBatchStateMachine.test.ts --runInBand --ci --coverage=false
```

结果：**8 suites passed，72 tests passed**。

### Property / invariant

命令：

```text
npx jest __tests__/contextBudgetV3Closure.test.ts __tests__/contextBudgetV3.spec.test.ts --runInBand --ci --coverage=false --testNamePattern "property|invariant|determin"
```

结果：**2 suites passed，6 tests passed，26 tests skipped**。其中包含 allocator invariant、随机分配与 deterministic property 覆盖。

### Typecheck / lint / full verify

- `npm run typecheck`：PASS
- `npm run lint`：PASS，`0 errors / 198 warnings`；本轮没有新增 lint error
- `npm run verify:version`：PASS
- `npm run verify`：PASS
  - Jest：`383 passed / 7 skipped`，`383/385 suites`；`3133 passed / 7 skipped`，共 `3140 tests`
  - 完整日志：`test-logs/context-budget-v3-final-seal-20260812/npm-verify-final.log`

## 4. Android Build / Install

- `npm run apk:debug`：PASS
- 版本：`V2.11.49` / versionCode `2114900`
- APK：`dist/apk/debug/ShineWriter-V2.11.49-debug.apk`
- 使用 `adb install -r` 完成安装与第二次连续安装验证。
- 全程没有执行 `adb uninstall` 或 `pm clear`。

## 5. Android Context Preview Gates

### Gate E — 32K / 64K / 128K / 1M

真实 Context Preview XML：

- 32K：`context-qa32k-300.xml`，模型窗口 `32,768`，hard `27,458`，预估 `7,662`
- 64K：`context-qa64k-2300.xml`，模型窗口 `65,536`，hard `58,915`，预估 `7,662`
- 128K：`context-qa128k-final.xml`，模型窗口 `131,072`，hard `121,830`，预估 `7,662`
- 1M：`context-qa1m-persisted.xml`，模型窗口 `1,000,000`，hard `956,000`，预估 `7,662`

四个窗口均为 `risk normal`；hard input limit 单调增加，未观察到反向 clipping。该 Gate 的真实 Preview 证据为 PASS。

### Gate F — 两个大资源 full-fit

使用两个真实约 69K 字符的大资源并保持显式激活：

- 1M：`context-qa1m-big.xml` / `context-preview-v31-1m-big.png`
- Preview 预估：`31,637` tokens
- 资源 A：demand `12,042`，allocated `12,042`，`full_fit`
- 资源 B：demand `12,044`，allocated `12,044`，`full_fit`
- 没有历史固定 `2~3K` allocation。
- 32K 对照：`context-qa32k-big.xml`；两个大资源各分配 `3,718`，说明 clipping 来自 envelope/allocator，而不是资源固定 cap。

Gate F：PASS。

### Gate G — Poison Legacy

`qa-poison-live.db` 写入了极端 legacy 值：`sliding_window_size=1`、`resource_budget=1`、`summary/story/episodic budget=1`、`recent_chapter_count=999999`、`memory_top_k=0`、`custom_range_start=999999` 等；未篡改 V3 policy/frozen task。

真实 Preview：`context-poison-legacy.xml`，仍为 1M envelope，预估 `31,637`，两个大资源仍为 `12,042→12,042` 与 `12,044→12,044` full-fit。Legacy 兼容回归由 full verify 覆盖。

Gate G：PASS。

### Gate H — Cross-board Borrow

32K live Preview 的资源 item allocation 为：

- total resource allocation：`3,718 + 3,718 + 62 = 7,498`
- V3 resources soft target：`floor(15,739 × 0.30) = 4,721`
- allocator 计算出的 borrowed amount：`7,498 - 4,721 = 2,777 > 0`
- resources elastic ceiling：`floor(15,739 × 0.50) = 7,869`，因此 `7,498 ≤ 7,869`

这里的 `2,777` 是基于真实 Android item trace、当前 V3 policy 和 allocator 公式的可复核推导；本轮 UI/XML 没有直接持久化或显示 Board-level `borrowedTokens` 字段。因此按 Mandatory Gate 的“Android `borrowedTokens > 0` 直接证据”要求，本 Gate 严格判 **NO-GO**，不能把推导冒充直接字段证据。

## 6. Model Switch

从小窗口切换到 1M 的证据：`llm_1m_entry2.xml`、`llm_1m_escape.xml`、`qa-1m-saved2.db`、`home_1m_afterpersist.xml`、`context-qa1m-persisted.xml`。

操作只修改 LLM 的 context length 并保存 LLM 配置；没有进入 Context Auto Config 点击“一键应用”。随后重新进入 Preview 自动得到 1M envelope。Gate I：PASS。

## 7. Batch Policy Freeze / Resume

### Gate J — Batch Policy Freeze Mutation

真实 3 章 Batch 启动前 child snapshot 证据：`batch_running_before_kill.db`。

- parent `context_budget_version=6`
- child `context_budget_version=6`
- frozen policy version：`context-automation-v3`
- frozen policy hash：`4684f04609ec1ec0a627b6494f76698830a2547200125c79db9ec5858d8b8d69`
- UI 明确显示“批次已冻结：质量；修改流水线配置不会影响本批次”

本轮没有完成“中途修改 live policy 后启动后续 child”的闭环；当前 live policy hash 仍为同值，且没有 child2 的 parent-hash 对照。因此 Gate J：**NO-GO**。没有直接篡改 child frozen data 伪造证据。

### Gate K — Single Resume

真实 Single Resume 路径证据：

- `single2_after_kill.db`：章节 2 任务可控中断，未解析
- `home_after_single2_kill.xml`：冷启动显示“从失败节点重试”
- `single_resume_confirm.xml`：用户确认 Resume
- `single_resume_started.db`：Resume 后 checkpoint 进入 `draft=running`，旧 checkpoint 未被伪造为成功

但本次中断发生在成功 Stage 之前，且为避免继续产生请求随后停止；没有“成功 Stage 后中断 → 成功 Stage 不重复 → 完成”的完整实证。因此 Gate K：**NO-GO**。

### Gate L — Batch Resume

真实 Batch Resume 路径：

1. 创建 3 章 Batch，规划 UI 显示冻结 reasoning tier。
2. 第 1 child 进入 `drafting` 后可控 `am force-stop`。
3. 冷启动进入 `paused`，UI 显示“应用中断，请确认后继续”。
4. 点击“确认后继续”并取得真实 Resume 结果。

证据：`batch_running_before_kill.xml`、`batch_after_force_stop.db`、`batch_recovery_entry.xml`、`batch_resume_confirm.xml`、`batch_resume_running_5s_real.db`、`batch_resume_logcat.txt`。

实际结果为 `paused_timeout_unknown` / `BATCH_LLM_OUTCOME_UNKNOWN`；child 没有成功初稿，后续 child 没有完成，parent 没有最终 `completed`。系统没有重复采用未确认结果，这是 fail-closed 行为，但不满足封板 Gate L 的最终 completed 要求。Gate L：**NO-GO**。

## 8. Derived Final Regression

本轮 targeted/full tests 中：

- `pipelineHighPayloadFinalClosure.test.ts`：PASS
- `derivedFinalPolicyFreeze.test.ts`：PASS
- full verify：PASS

这些测试继续覆盖大 parent、无 CursorWindow、上游 stage 不重复、Final 只新增一次的回归约束；但本轮没有完成新的 Android 真实 Derived Final 端到端完成证据。因此不能把上一轮文档或旧机器证据当作本轮 Gate M 证据。Gate M：**NO-GO**。

## 9. Data Preservation / API Credential Continuity

### Install and package continuity

`adb install -r` 前后：

- versionCode：`2114900`
- versionName：`V2.11.49`
- firstInstallTime：前后均为 `2026-08-08 04:17:52`
- lastUpdateTime 按预期变化
- package 输出：`package-pre-second-install.txt`、`package-post-second-install.txt`

### Database continuity

`pre-second-install.db` 与恢复后的 `post-restore-after-launch.db` 均：

- `pragma integrity_check`：`ok`
- projects：`8`
- QA project chapters：`33`
- QA project resources：`11`
- QA characters：`3`
- QA notes：`3`
- QA project story memory：`1`
- `pipeline_tasks`：`39`
- `pipeline_stage_checkpoints`：`176`
- `pipeline_stage_attempts`：`193`
- `llm_usage_logs`：`308`
- API key DB non-empty count：`0`
- context window / max output：`1,000,000 / 200,000`
- `pipeline_draft_max_tokens` 恢复为原值 `100,000`

第二次安装前后 API Key UI 均显示 `35` 个 bullet；没有把 raw credential 写入 SQLite、报告或日志。数据库快照和 UI 证据：`pre-second-install.db`、`post-second-install.db`、`llm_settings_pre-second-install.xml`、`llm_settings_post-second-install.xml`。

Gate N：PASS。测试结束后已将应用数据库恢复为第二次安装前快照，当前输入法也恢复为系统 LatinIME。

## 10. Seal Gate A~O 判定

| Gate | 判定 | 真实证据/原因 |
|---|---|---|
| A Repo/Environment Discovery | GO | repo、Node/JDK/ADB/serial、HEAD/origin 记录齐全；见 environment-final.log |
| B Post-Coverage Reclaim | GO | T01/T02/T03/T04/T05 与最终 allocator assertions 全通过 |
| C Reclaim Determinism | GO | T06 20 次并发一致；allocator 两调用点；无循环/第二 allocator |
| D Preview/Send | GO | ContextBuilder final grant、Preview trace、pipeline high-payload/prompt regression 全通过 |
| E 32K/64K/128K/1M | GO | 四份真实 Android Preview XML，hard limit 单调增加 |
| F Big Resources | GO | 两个大资源在 1M full-fit，32K 按 envelope 受控分配 |
| G Poison Legacy | GO | 极端 legacy DB 下 V6 Preview 与大资源 full-fit 不受影响 |
| H Cross-board Borrow | NO-GO | live allocation 可推导 `borrowed=2,777`，但没有 Android Board-level `borrowedTokens` 直接字段证据 |
| I Model Switch | GO | 仅切 1M、未点 Context Apply、Preview 自动扩张 |
| J Batch Policy Freeze Mutation | NO-GO | 没有完成 live policy hash 变化后续 child hash 保持 parent 的闭环 |
| K Single Resume | NO-GO | Resume 已启动，但没有成功 Stage 后中断并完成的闭环 |
| L Batch Resume | NO-GO | 真实 Resume 进入 `paused_timeout_unknown`，未最终 completed |
| M Derived Final Regression | NO-GO | 自动化回归 PASS，但没有本轮新 Android 端到端完成证据 |
| N Data Preservation | GO | install -r、firstInstallTime、数据计数、secure credential continuity 均保留 |
| O Full Verification | NO-GO | local verify PASS，但 Mandatory Android gates 未全 PASS；本轮没有远端 CI 运行/状态接口证据 |

## 11. Final GO / NO-GO

**NO-GO。**

已完成并验证的交付是 Post-Coverage Episodic Demand Reclaim 代码、测试和本地 full verify；不得将本文件中的 NO-GO 解释为代码回滚或数据损坏。重新封板前仍需补齐：

1. 可观测且真实的 Android Board-level `borrowedTokens > 0` 证据；
2. Batch 中途 live policy mutation 后 child hash freeze；
3. 成功 Stage 后的 Single Resume 完成闭环；
4. 至少两个 child 的 Batch Resume 最终 completed；
5. 本轮新 Android Derived Final 完成证据。

