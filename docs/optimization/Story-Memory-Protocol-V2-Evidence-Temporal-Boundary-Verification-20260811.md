# Story Memory Protocol V2 — Evidence Temporal Boundary Verification

日期：2026-08-11<br>
仓库：`F:\ClaudeWorkSpace\projects\TAVO-MINI`<br>
最终结论：**GO**

## 1. 基线与范围

- 已先执行 `git status`、`git fetch --all --prune`。
- 初始 `HEAD` 与 `origin/main` 均为 `9836adda3a9b016c9e99c7523ffacf18b358b747`，ahead/behind 均为 0；最终未切换分支、未 reset、未提交、未 push。
- 初始唯一未提交内容是最新收尾方案：`docs/optimization/Tavo-Mini-Story-Memory-Protocol-V2-Evidence-Temporal-Boundary-Final-Plan.md`，已保留。
- 已完整阅读该方案，并以本地实际链路 `normalize → compile → hard validate → applyStoryMemoryBatchPatch → final StoryMemoryState` 实施。
- 未修改 DB Schema、LLM Contract、CAS、Request Runner、Batch 切分、Validator 门槛或其他架构边界。

V2.11.48 的正式分发证据为 release commit、README/CHANGELOG 记录及已有 `dist/apk/release/ShineWriter-V2.11.48-release.apk`；因此按方案升级到 V2.11.49。当前版本为 `V2.11.49`，`versionCode=2114900`，Schema 仍为 50。

## 2. 根因与最小修复

根因是 Compiler 的旧 `mergeEvidence()` 在去重后直接 `slice(0, 3)`。同一 Patch Item 在早章节产生多条 accepted Observation 时，后章节 Evidence 会被截掉；Merger 仍能得到部分正确字段，但 `firstSeen/opened` 或 `lastChanged/resolved` 的时间边界可能停留在错误章节。

修复仅位于 `src/services/storyMemory/storyMemoryObservationCompiler.ts`：

1. 建立 ordered chapters 的 `chapterId → position` 映射，Evidence 排序只依据 chapter position，不假设 chapterId 数值顺序。
2. 先按 `chapterId + quote` 去重，再按章节分组并按 position 排序。
3. 上限固定为 `MAX_PATCH_ITEM_EVIDENCE = 3`。
4. 单章节仍保留前三条；两章节保留 earliest 与 latest，并用确定性策略填充第三条；三章节至少各保留一条；更多章节在三条上限内保留 earliest/middle/latest 代表。
5. 所有 Character、Relationship、Conflict、Thread、Foreshadowing 以及 new-character 合并路径统一使用该 helper；未扩大 Evidence 上限。

## 3. 失败优先与四类回归

测试文件：`__tests__/storyMemoryBatchTemporalMetadata.test.ts`。先在旧实现上运行，4 个新增回归均按预期失败，失败原因均为最终章节 Evidence 被旧 `slice(0,3)` 丢弃；应用修复后重新运行全部通过。

四个测试均完整经过 normalize、compile、hard validate、`applyStoryMemoryBatchPatch` 和最终 `StoryMemoryState`，不是只测 helper：

| 场景 | 真实断言 |
|---|---|
| Character | 非数值有序 chapterId `101 → 7`；CH1 new + 多次 update、CH2 final update；最终 `firstSeen=101`、`lastChanged=7`，Evidence ≤ 3 且保留两端。 |
| Relationship | 非数值有序 chapterId `42 → 7`；CH1 open + 多次 update、CH2 final update；最终 `firstSeen=42`、`lastChanged=7`。 |
| Foreshadowing | 非数值有序 chapterId `1000 → 17 → 3`；CH1 open/update/partial、CH3 resolve；最终 `opened=1000`、`lastChanged=3`、`status=paid`。 |
| 三章覆盖 | 非数值有序 chapterId `[50, 1, 10]`，同一 Relationship Patch Item 有超过 3 条 Evidence；编译 Patch Evidence 恰为最多 3 条且章节覆盖 `[50,1,10]`，最终时间边界仍为首章/末章。 |

## 4. 自动化 Gate

- Temporal/final-governance 专项：`2 suites / 25 tests passed`。
- Story Memory 专项：`54 suites / 500 tests passed`；1 suite、4 tests 按既有配置 skipped。
- `npm run verify`：通过。最终结果为 `373 passed / 375 total suites`、`3043 passed / 3050 tests`，2 suites、7 tests skipped；lint 仅保留既有 warnings，无 error；typecheck 通过。
- `npm run verify:version`：通过，`V2.11.49 versionCode=2114900`。
- `git diff --check`：通过。

## 5. Production-policy complex-long Live semantic smoke

应用原有 LLM 配置保持不动；本地/设备配置核对为 base `https://api.deepseek.com`、model `deepseek-v4-flash`。API Key 未写入仓库、报告、测试日志或命令输出。Live 测试使用应用实际会归一化到的 `/chat/completions` 请求路径。

报告：`F:\ClaudeWorkSpace\projects\TAVO-MINI\test-logs\android-qa\story-memory-v2-closure-20260811\live-closure-report.json`

- HTTP 200，`finishReason=stop`，`physicalAttemptCount=1`。
- `observationsReceived=14`、`observationsAccepted=14`、`observationsDropped=0`。
- 语义类别覆盖 `character, foreshadowing, objective, timeline`，semantic gate pass。
- `applied=true`，推进到 `throughChapterPosition=9`。
- invalid-ref gate：accepted 0 / dropped 1；rejected-N-1 gate：accepted 1 / dropped 3；64K fresh-budget gate pass。
- 实际调用链记录为 `callLLMResult → buildStoryMemoryLLMConfig → STORY_MEMORY_V2_REQUEST_KINDS.primary → parseStoryMemoryObservationCandidate → normalize/compile/validate/apply`。

## 6. Android Debug 真实链路与 temporal stress

设备：`emulator-5554`，API 37，`sdk_gphone16k_x86_64`。最终 Debug APK：

- `F:\ClaudeWorkSpace\projects\TAVO-MINI\dist\apk\debug\ShineWriter-V2.11.49-debug.apk`
- 58,884,686 bytes，SHA-256：`91BB6E9ED876089CAA155CCCF630C662CD25411A66B34E9344BE2CCACB1CF684`
- 使用 `adb -s emulator-5554 install -r` 覆盖安装成功；未执行 uninstall、`pm clear`、清库或删除数据库。
- 设备核对：`versionName=V2.11.49`、`versionCode=2114900`；`firstInstallTime=2026-08-08 04:17:52` 在覆盖安装后保持不变。
- 重启后 `topResumedActivity=com.shinewriter/.MainActivity`，清空 logcat 后无 `FATAL EXCEPTION`。

真实 UI stress 使用项目 7 `SMV2-Three-Chapter-Lifecycle-Prompt-Fix-QA`：

- 通过编辑器 UI 在 chapter 69（position 0）加入同一蓝色铜铃 foreshadowing 的多条重复/更新事实，再保留 chapter 71（position 2）的 resolve 场景；未通过 DB 直灌制造结果。
- 运行 Story Memory「继续整理」实际生成并应用 `batch_7_0_2_1e23fdy11cohuw`，范围 chapter 69 position 0 → chapter 71 position 2，状态 `applied`。
- 同一 foreshadowing 的编译 Patch Evidence 为 3 条，章节边界为 `[69, 69, 71]`；即在多于 3 个有效源事实的 stress 下仍未超过 3 条，并保留 earliest/latest。
- 最终 `StoryMemoryState`：foreshadowing `status=paid`、`openedChapterId=69`、`lastChangedChapterId=71`；project memory `status=clean`、through chapter 71 position 2。另有 Character `firstSeen=69/lastChanged=70`、Relationship `firstSeen=70/lastChanged=71` 的真实结果。

Android 数据库不持久化原始 accepted Observation 计数，因此 Android 证据以真实 UI 输入、实际 applied batch、编译 Patch 上限和最终 State 为准；accepted 计数的精确证据由上面的 Live semantic report 和失败优先的端到端 Jest 回归提供。

## 7. 下一章 Context smoke

在同一设备、同一项目的下一章（第 5 章，planned chapter 72）打开「上下文」并查看预估请求：

- 预估请求 2,250 词元；长期故事检查点 374 词元。
- 检查点截至第 3 章，coverage `完整`，无空洞。
- 展开的系统消息仍包含角色、Relationship、current objective、active conflicts、unresolved threads、unfulfilled foreshadowing 和 recent completed beat；与最终 StoryMemoryState 一致。

证据文件：
`F:\ClaudeWorkSpace\projects\TAVO-MINI\test-logs\evidence-temporal-boundary-20260811-224102\screen-context-request.png`、`ui-context-request.xml`、`screen-context-memory-detail.png`、`ui-context-memory-detail.xml`、`ui-context-memory-detail.txt`。

## 8. Release APK Gate

正式 Release APK：

- `F:\ClaudeWorkSpace\projects\TAVO-MINI\dist\apk\release\ShineWriter-V2.11.49-release.apk`
- 36,516,938 bytes，SHA-256：`E36A1172FF43ABC093D90C661EDA8A4BEECE1E6EFD841A5FC146743490395731`
- package：`com.shinewriter`
- `versionName=V2.11.49`、`versionCode=2114900`
- 单 signer；证书 SHA-256：`017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`
- v2 签名验证通过；`zipalign Verification successful`。
- `scripts/verify-release-apk.ps1` 全部 hard assertions passed。

## 9. 最终判定

所有要求的代码、端到端测试、Live semantic、Android temporal stress、下一章 Context、Debug 覆盖安装及 Release APK Gate 均通过；Evidence 上限保持 3 条，ordered chapter position 边界得到保护，未触碰禁止修改项。

**最终判定：GO。**
