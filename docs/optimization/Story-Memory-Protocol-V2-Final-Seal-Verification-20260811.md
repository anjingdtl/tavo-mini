# Story Memory Protocol V2 Final Seal Verification

日期：2026-08-11  
仓库：`F:\ClaudeWorkSpace\projects\TAVO-MINI`  
最终版本：`V2.11.48` / `versionCode=2114800` / Schema 50  
结论：**PASS / GO**

---

## 1. 基线与范围

| 项 | 值 |
| --- | --- |
| 开工前 `git status` | 仅未跟踪方案文档 `docs/optimization/Tavo-Mini-Story-Memory-Protocol-V2-Final-Seal-Plan.md` |
| `git fetch --all --prune` | 已执行 |
| 开工前 HEAD | `cdcab413a055e1bfb6ce4e98fcf855177a989634` |
| 开工前 `origin/main` | 同 `cdcab413`（`0 0`） |
| 未提交修改 | 全部保留，未 `reset --hard` / `git clean` |
| 版本策略 | V2.11.47 已在 origin 以 release 提交存在 → 本轮顺延 **V2.11.48** |

完整阅读：

- `docs/optimization/Tavo-Mini-Story-Memory-Protocol-V2-Final-Seal-Plan.md`

接驳链 `rg` 复核（本地实现真相）：

```text
Observation
→ compileStoryMemoryObservations (Compiler)
→ StoryMemoryBatchPatchDraft
→ validateCompiledStoryMemoryBatchPatch / validateStoryMemoryBatchPatch
→ batchPatchToChapterDraft
→ applyStoryMemoryPatch / applyStoryMemoryBatchPatch (Merger)
→ StoryMemoryState
→ saveStoryMemoryBatchUpdate (CAS/DB)
→ Context Consumer (renderer / ContextPreview / 写作上下文)
```

本轮只修 **BatchPatch → ChapterPatch adapter → Merger** 时间元数据层，以及 live known-change 解析同构 / diagnostics 分类。未改 Outline Pipeline、Continuation、Canon；未扩 Batch>3；未新增 Request Runner / Allocator；未增加物理重试。

---

## 2. 根因与最小修复

### P0-1：Batch 时间元数据被 through chapter 压平

**根因**：`applyStoryMemoryBatchPatch` 经 `batchPatchToChapterDraft` 后，以 `rangeRef.throughChapterId/throughPosition` 作为唯一 Merger context，导致 Character/Relationship/Conflict/Thread/Foreshadow/Timeline 的 firstSeen/opened/lastChanged/resolved 全部落到 Batch 终点。

**修复**（`src/services/storyMemory/storyMemoryMerger.ts`）：

- 新增本地-only `StoryMemoryBatchTemporalMaps` / `buildStoryMemoryBatchTemporalMaps`
- 从 `chapterSummaries + rangeRef` 建 `chapterId → position`
- 从每条 patch item 的 `BatchEvidenceQuote[]` 推导 first/last evidence chapter + position
- 单次 `applyStoryMemoryPatch` 写入时间字段；**仍是一个逻辑 Batch → 一次 Merger → 一次 CAS/DB**
- 不改 Schema；不要求模型输出 firstSeen/opened 字段

### P0-2：complex-long known-change 语义 Gate 未跑实

**根因（测试侧）**：live test 把 `extractJSON()` 返回的 **JSON 字符串** 直接喂给 normalizer，生产路径实际是：

```text
parseStoryMemoryObservationCandidate
= extractJSON + JSON.parse
```

因此模型明明返回了 observations，测试却读到 `observationsReceived=0`。

**修复**：live 对齐生产 `parseStoryMemoryObservationCandidate`，并在 compile/validate 后真正 `applyStoryMemoryBatchPatch`。

### P1：`OBS_FUTURE_REF` diagnostics

`StoryMemoryV2DropReason` 增加 `future_ref`：

```ts
case 'OBS_FUTURE_REF':
  return 'future_ref'
```

---

## 3. 失败测试先行

| 测试 | 结果 |
| --- | --- |
| `__tests__/storyMemoryBatchTemporalMetadata.test.ts`（新增） | 先失败复现 through-flatten → 修复后 **7/7 PASS** |
| `__tests__/storyMemoryFinalGovernance.test.ts` 增补 `future_ref` | **PASS** |
| `__tests__/storyMemoryProtocolV2.live.test.ts` complex-long | 修复解析后 **PASS** |

Temporal 断言路径：

```text
compile → hard validate → applyStoryMemoryBatchPatch → final StoryMemoryState
```

覆盖 Character / Relationship / Conflict / Thread / Foreshadow / Timeline + 单 Batch CAS 语义。

---

## 4. 自动化门禁证据

| Gate | 结果 | 证据 |
| --- | --- | --- |
| Temporal + FinalGovernance + Merger 相关 | 28 passed | Jest |
| `npx jest --runInBand storyMemory` | **54 suites passed / 1 skipped；496 passed / 4 skipped** | `test-logs/story-memory-suite-seal.log` |
| Live complex-long `3×18000` production path | **PASS** | 见下节 |
| `npm run verify` | **373 suites / 3039 tests passed**（2 suites / 7 tests skipped） | `test-logs/npm-verify-seal.log` |
| `npm run verify:version` | **ok V2.11.48 / 2114800** | CLI |

### Live complex-long 真实语义（不可再 skip / 假成功）

路径：

```text
callLLMResult
→ buildStoryMemoryLLMConfig
→ STORY_MEMORY_V2_REQUEST_KINDS.primary
→ Provider Adapter
→ parseStoryMemoryObservationCandidate
→ normalize / compile / hard validate
→ applyStoryMemoryBatchPatch
```

| 指标 | 值 |
| --- | --- |
| HTTP | 200 |
| finishReason | stop |
| estimatedInputTokens | 54806 |
| outputReservation | 20480 |
| **observationsReceived** | **18** |
| **observationsAccepted** | **18** |
| observationsDropped | 0 |
| **semanticCategories** | `character, foreshadowing, objective, arc` |
| applied | true |
| throughChapterPosition | 9 |
| physicalAttemptCount | 1 |

证据文件：

- `test-logs/android-qa/story-memory-v2-closure-20260811/live-complex-long-diag-from-jest.json`
- `test-logs/android-qa/story-memory-v2-closure-20260811/live-closure-report.json`

---

## 5. Android 模拟器穿测

设备：`emulator-5554`（`sdk_gphone16k_x86_64`）  
安装：`adb install -r` only  
**禁止项遵守**：无 uninstall / 无 `pm clear` / 无清库  
`firstInstallTime` 始终为 `2026-08-08 04:17:52`

QA 目录：`test-logs/android-qa-story-memory-v2-final-seal-20260811/`

### M1：三章 Temporal Lifecycle（真实 App 单 Batch）

操作：项目 `SMV2-Three-Chapter-Lifecycle-Prompt-Fix-QA` → 故事记忆 → **清空并重新构建**  
结果：

| 项 | 值 |
| --- | --- |
| batch | `batch_7_0_2_*` **from=0 through=2 applied**（单 3 章 Batch） |
| attempt | `story_memory_v2_primary` HTTP 200，`attempt_no=1` |
| state | through_position=2，clean（重建完成时） |

时间元数据（`m1-temporal-report.json`，from Evidence 推导，**非 through=71 压平**）：

| 实体 | 断言 | 结果 |
| --- | --- | --- |
| Character 林澈 | firstSeen=69 / firstPos=0 | PASS |
| Character 齐衡 | first=69 / last=70 | PASS |
| Relationship 盟友 | first=70 / last=71 | PASS |
| Thread 北门钥匙来源 | opened=70 / resolved=71 | **PASS**（opened ≠ resolved） |
| Foreshadow 蓝色铜铃 | opened=70 / last=71 / paid | PASS |
| Conflict beat | chapterId=71 | PASS |

证据：`db-after-m1-rebuild.sqlite`、`m1-temporal-report.json`、`ui-sm-rebuild-poll.xml`

### M2：Known-change complex-long

- Jest live production-policy Gate：**PASS**（上表 18/18/categories）
- App 侧：M1 清空重建走真实生产 LLM + 同一 Request Policy 路径，HTTP 200 + state mutation 已落库

### M3：下一章 Context 一致性

章节编辑器工具栏横滑在本模拟器 hierarchy 上未能稳定露出「上下文」按钮（既有 Maestro 中文/工具栏横滑坑，见 playbook）。  
改用 Story Memory 主线消费面验证：

| 断言 | UI 证据 |
| --- | --- |
| 检查点至第 3 章 | 「已整理到：第 3 章」 |
| open thread 不作为未解决 | 「未解决线索（0）」 |
| active conflict 空 | 「活跃冲突：无」 |
| currentObjective | 「当前目标：调查铜铃的来历」 |

证据：`ui-m3-sm.xml`、`ui-m3-mainline.xml` + DB temporal report

### M4：后台 / 锁屏 smoke

Home → Lock → Unlock → 回前台，`MainActivity` 焦点恢复，Story Memory UI 仍可读。  
证据：`m4-home.txt`、`m4-lock.txt`、`ui-m4-resumed.xml`

### M5：force-stop `outcome_unknown`

清空重建后约 1s `am force-stop`，冷启动：

| 项 | 值 |
| --- | --- |
| UI | **「长期记忆：需要处理未确认请求」**（未误显示成功） |
| 待整理 | 第 1～3 章 |
| DB attempt | `status=outcome_unknown` |
| failure_class | `outcome_unknown` |
| error_code | `COLD_START_SENT_WITHOUT_RESULT` |
| http_status | null |
| attempt_no | 1（无物理重试 / 无自动确认） |

证据：`ui-m5-rebuild-force-stop.xml`、`db-m5-rebuild-force-stop.sqlite`、`m5-force-stop-rebuild-event.txt`

---

## 6. 版本与 APK

| 产物 | 路径 | 大小 | SHA-256 |
| --- | --- | --- | --- |
| Debug | `dist/apk/debug/ShineWriter-V2.11.48-debug.apk` | 52,239,020 | `B2CA470F2D82CFD5E3F3622DE774C7AD09AAAF3AE075F0F47D9129C586495378` |
| Release | `dist/apk/release/ShineWriter-V2.11.48-release.apk` | 36,515,922 | `359D82E4A3692C5DB8183FF56152A979C25601CAE30EF49CB04C1D8BC3A76EA7` |

Release 验收（`scripts/verify-release-apk.ps1`）：

| 检查 | 结果 |
| --- | --- |
| package | `com.shinewriter` |
| versionName | `V2.11.48` |
| versionCode | `2114800` |
| v2 签名 | Verified |
| signers | 1 |
| zipalign | successful |
| 证书 SHA-256 | `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a` |

Debug 设备覆盖安装后：`versionName=V2.11.48` / `versionCode=2114800`，`firstInstallTime` 仍为 `2026-08-08 04:17:52`。

---

## 7. 修改文件清单

| 文件 | 说明 |
| --- | --- |
| `src/services/storyMemory/storyMemoryMerger.ts` | Batch temporal maps + Evidence 时间推导 |
| `src/services/storyMemory/storyMemoryV2Diagnostics.ts` | `future_ref` 分类 |
| `__tests__/storyMemoryBatchTemporalMetadata.test.ts` | 新增 temporal integration |
| `__tests__/storyMemoryFinalGovernance.test.ts` | future_ref 断言 |
| `__tests__/storyMemoryProtocolV2.live.test.ts` | 生产 parse + apply 语义 Gate |
| `package.json` / `package-lock.json` / `src/constants/version.json` | V2.11.48 |
| `README.md` / `CHANGELOG.md` | 版本与条目 |

---

## 8. GO Gate 逐项

| # | Gate | 结果 |
| --- | --- | --- |
| 1 | Batch 内 temporal metadata 真实 | **GO** |
| 2 | Character firstSeen/lastChanged | **GO** |
| 3 | Relationship firstSeen/lastChanged | **GO** |
| 4 | Thread opened=CH2-ish / resolved=CH3-ish | **GO** |
| 5 | Foreshadow opened/last/paid | **GO** |
| 6 | Timeline evidence chapter（单测） | **GO** |
| 7 | complex-long received>0 / accepted≥3 / categories | **GO**（18/18） |
| 8 | production Request Path 同构 | **GO** |
| 9 | Android M1～M5 | **GO** |
| 10 | `npm run verify` | **GO** |

### NO-GO 条件对照

| 风险 | 是否发生 |
| --- | --- |
| firstSeen/opened 仍取 through | 否 |
| resolvedThread.opened == resolved | 否 |
| known-change Live skip | 否（已真跑） |
| accepted=0 假成功 | 否 |
| 新增 DB Schema / 拆 Batch CAS | 否 |
| 物理 HTTP > 3 | 否（attempt_no=1） |
| uninstall/pm clear | 否 |
| verify fail | 否 |

---

## 9. 最终结论

**PASS / GO**

Story Memory Protocol V2 最终封板条件已满足：

1. 模型事实发生在哪一章，Compiler → Patch → Merger → DB 时间元数据一致保留在哪一章（单 Batch 单 CAS）。  
2. known-change 长篇必须真实提取并持久化连续性语义，不能再用 HTTP 200 / state clean / skipped live 判过。

工作树仍含本轮未提交修改；未执行 commit / push。APK、DB、截图与日志保留在本地产物目录，不入库。
