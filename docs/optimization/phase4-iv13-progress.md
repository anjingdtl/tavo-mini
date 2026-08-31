# TAVO-MINI Phase IV-13 Progress

施工仓：`E:\\AiWorkSpace\\tavo-mini`  
日期：2026-08-31（Asia/Shanghai）  
主方案：`docs/optimization/TAVO-MINI_Phase4_IV-13_FinalIntegrity_DualRevision_FinalSeal_20260831.md`

## 当前结论

`NO-GO / IN PROGRESS`

Final Integrity 与双修订入口的代码门禁已通过，`npm run verify` 已通过；但真实 Android 六项固定场景尚未全部完成，DB/Receipt/UI/logcat 的完整证据链仍不齐。在全部门禁完成前，结论保持 `NO-GO`，不发布 `PHASE IV FINAL SEALED / GO`。

## 基线与保护

- `git fetch origin` 已执行。
- 开工时 `HEAD == origin/main == 113d5e6a5bb0bf1b6eec66a37b45c7e342ef7d8d`。
- 开工时 tracked worktree clean；既有用户未跟踪方案文件 `docs/optimization/TAVO-MINI_Phase4_IV-13_FinalIntegrity_DualRevision_FinalSeal_20260831.md` 与 `scripts/qa/__pycache__/` 均保留。
- 本轮不执行 `git reset --hard`、`git clean`、`adb uninstall` 或 `pm clear`；Android 只允许 `adb install -r`。

## 本轮施工闭环

### Final Plain-Text Integrity

- 新增共享零请求合同：`src/services/writing/contracts/plainTextNovelBody.ts`。
- FinalValidate、Persist、outline stage runtime、Zustand pipeline task mutation、pipeline task repository、outline durable adapter、Continuation durable adapter、Continuation adoption、3 章批量 adoption 均在最终正文写入前复核。
- JSON/JSON-like wrapper、Markdown fence、协议字段、reasoning/prompt/Patch 泄漏、重复章节标题和未闭合协议尾部均 fail-closed；不做自动剥壳、隐藏 retry 或第二次请求。
- Continuation V5 technical Final Integrity 即使历史 soft-gate 开关被打开也保持硬阻断。

### 双用户修订入口

- `src/services/writing/userRevision.ts` 提供 `targeted_revision` 与 `whole_chapter_rewrite` 两种独立动作。
- 精准修订：TextInput UTF-16 选区快照 → 一次 Thinking ON LLM → 原始响应必须是唯一顶层 `patches` JSON → 复用 Continuation Patch parser/validator/apply → 本地选区边界、重叠、stale 与选区外前后缀 100% 校验 → 内存 Diff → 用户确认后写库。
- 整章重写：复用已持久化 Frozen Truth → 一次 Thinking ON LLM → 完整纯正文 → Preview → 用户确认；不运行 Planner、QA、Revision、Context、Memory、Prompt Compiler 或 Governor LLM。
- 两种入口均写 body-free Receipt 和用户确认前的 `before_*` revision snapshot；应用时重新读取章节并做 Frozen Truth / 正文 fingerprint CAS 防 stale 覆盖。
- 大纲与原著续写共享同一 Modal、service、Preview、Receipt 和确认路径；结果页只有已采纳的最终正文才暴露修订按钮，待采纳结果不会把非 authority 正文作为修订基准。

## 已完成的确定性检查

| 检查                                         | 结果                                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| 双修订/范围/UTF-16/stale/一调用测试          | PASS（15 tests）                                            |
| Plain-Text Integrity 测试                    | PASS（7 tests）                                             |
| Persistence / body-free Receipt 测试         | PASS（2 tests）                                             |
| FinalValidate/Persist 集成测试               | PASS                                                        |
| FinalManuscriptCard / ChapterToolbar UI 测试 | PASS                                                        |
| Continuation V5 Final contract 回归          | PASS                                                        |
| 本轮聚焦回归（8 suites）                     | PASS（59 tests）                                            |
| `npm run typecheck`                          | PASS                                                        |
| `npm run lint`                               | PASS（0 errors；260 existing warnings）                     |
| `npm run verify:elastic`                     | PASS                                                        |
| `npm run verify:version`                     | PASS（V2.21.1 / 2210100）                                   |
| `npm run verify`                             | PASS（537 suites / 3793 tests；4 suites / 9 tests skipped） |
| Debug APK 构建                               | PASS（V2.21.1；57.05 MB）                                   |
| `adb install -r`                             | PASS（firstInstallTime 保持不变）                           |
| 大纲：精准 1 / 整章 1 / 批量 3               | PENDING                                                     |
| 原著续写：精准 1 / 整章 1 / 批量 3           | PENDING                                                     |
| Safety、DB/Receipt/UI/logcat                 | PENDING                                                     |

`npm run verify` 的最终结果为 exit code 0；Jest 汇总为 `Test Suites: 4 skipped, 537 passed, 537 of 541 total`、`Tests: 9 skipped, 3793 passed, 3802 total`。本轮还单独复跑了此前暴露问题的 `writingQaStructuredContractAdmission`，4/4 PASS。Lint 的 260 条为现有项目 warning，不构成 error，未以放宽门禁的方式处理。

## PDCA 根因与重测记录

- **Check → Act：Final Plain-Text 误报。** 原协议前缀正则把测试正文 `修订后正文` 误判为 prompt 泄漏；已收紧为必须存在冒号或换行分隔，专项回归与 full verify 均 PASS。
- **Check → Act：原生选区与工具栏动作的边界。** 真机已观察到 Android 原生长按选区和 action mode；代码增加最后一个非空 UTF-16 选区快照并在切章时重置。此前安装包点击精准修订仍出现“请先选择正文”，因此该修正尚未取得新的安装后闭环证据，精准修订真实场景继续 PENDING，不宣称已通过。
- **Scope guard：** 没有重跑 20 章或大规模盲评；没有新增 hidden retry、第二 Writer/QA/Context/Memory/Prompt Compiler；Governor 继续旁路。

## 证据目录约束

本轮 Android 截图、UI hierarchy、logcat、脱敏 DB/Receipt 只写入 `test-logs/phase4-iv13-*`；不污染仓库根目录，不把正文、prompt、reasoning、API key 写入 body-free 证据。

## 当前真实 Android 证据索引

- `test-logs/phase4-iv13-android-20260831/install-r-selection-fix.txt`：`adb install -r` 成功，安装前后 `firstInstallTime` 保持不变。
- `test-logs/phase4-iv13-android-20260831/screenshot-outline-longpress2.png`：大纲章节正文 Android 原生长按选区可见。
- `test-logs/phase4-iv13-android-20260831/screenshot-outline-selected2.png`：大纲章节选区 handles/action mode 可见。
- `test-logs/phase4-iv13-android-20260831/screenshot-targeted-second.png`：点击精准修订后仍收到“请先选择正文”，说明真实精准修订闭环尚未 PASS。
- `test-logs/phase4-iv13-android-20260831/logcat-targeted-fix-open.log`：对应操作日志；尚未形成六项场景的完整 DB/Receipt/UI/logcat 证据集。

以上证据只证明安装约束和原生选区 UI 局部事实，不等价于精准修订、整章重写或 3 章批量通过。

## 封板规则

只有 Final Integrity、两类修订、两组 3 章批量、Safety、DB/Receipt/UI/logcat 和 full verify 全部 PASS，才可将本文件与最终报告更新为：

`PHASE IV FINAL SEALED / GO`

否则保持 `NO-GO → Root Cause → 最小修正 → 重测`。
