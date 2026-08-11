# Story Memory Protocol V2 Final Governance Verification

日期：2026-08-11  
仓库：`F:\ClaudeWorkSpace\projects\TAVO-MINI`  
最终版本：`V2.11.47` / `versionCode=2114700`  
结论：**PASS / GO**

## 1. 基线与范围

- 已先执行 `git status`、`git fetch --all --prune`。
- `HEAD`、`origin/main`、merge-base 均为 `bff1243941ffb35bc3daf85551a55b67986d438d`，`git rev-list --left-right --count HEAD...origin/main` 为 `0 0`。
- 原有未提交的治理方案 `docs/optimization/Tavo-Mini-Story-Memory-Protocol-V2-Final-Governance-and-Pipeline-Integration-Plan-F-Workspace.md` 保留未改动。
- 本轮只处理 Story Memory Protocol V2 最终 3 个 P0；未修改 Outline Pipeline、Continuation、Canon，也未推进 P2。

完整阅读的方案为上述 Story Memory Protocol V2 Final Governance and Pipeline Integration Plan。随后使用 `rg` 审计了真实链路：写作定稿/维护入口 → checkpoint request → production LLM request policy/provider adapter → normalize/compiler → validator → Merger → CAS/DB → maintenance/rebuild → story-memory prepare/context preview/写作上下文消费。

## 2. 三个 P0 的最小收束

### P0-1：禁止 N-key 跨章节及同章向未来引用

- `storyMemoryObservationCompiler.ts` 为 observation 增加证据偏移与按章节位置/证据顺序的确定性解析。
- 只有已经在当前可见时间点被接受的定义 observation 才能注册 N-key；跨章节或同章后出现的定义被识别为未来引用并局部丢弃，诊断码为 `OBS_FUTURE_REF`。
- 既有 invalid-ref 的局部降级、accepted summary 与实际 compile 约束保持不变。

### P0-2：按真实 Merger temp-ref 能力补齐同批次 lifecycle

- 保持现有 Merger/CAS/DB 架构，不增加物理重试，不放宽全局 Validator。
- 对 Merger 已支持的 temp-ref 形态，Compiler 补齐 Relationship、Conflict、Thread、Foreshadowing 的 same-batch open/update/resolve/paid 生命周期。
- 对 Merger 不支持直接 temp update 的实体，Compiler 在同一 patch 内确定性 fold 到对应的新建/upsert patch；Validator 只增加了同批次 `conflictUpserts` 的精确引用收束，不扩大其它引用边界。

### P0-3：known-change complex-long 的零 Observation 假成功与真实 QA 同构

- 新增诊断侧 `evaluateStoryMemoryKnownChangeSemanticGate`：`observationsReceived=0`、`observationsAccepted=0`、accepted 数低于 3，或没有具体 patch category 时不通过。
- 该门禁是 known-change QA/语义验收诊断，不把生产正常路径改成“全局零 Observation hard fail”，也没有新增物理重试。
- live QA 移除直连 `fetch`，使用生产 `callLLMResult`、`buildStoryMemoryLLMConfig`、生产 request kind、Request Policy 与 Provider Adapter 链路；API key 只从 `DEEPSEEK_API_KEY` 读取，未写入报告或日志。

## 3. 失败测试先行与自动化门禁

先添加失败复现，再进行最小修复：

- 未来引用（character/relationship/conflict/thread/foreshadowing，含同章未来定义）和三章 lifecycle：`__tests__/storyMemoryFinalGovernance.test.ts`。
- known-change 零 Observation 语义门禁：同一测试文件。
- Relationship open 的 N-key temp-ref prompt contract：同一测试文件；首次运行按真实 prompt contract 失败，补充本地 Merger 能力允许的 relationship open 示例后通过。

最终结果：

| Gate | 结果 |
| --- | --- |
| `npx jest --runInBand __tests__/storyMemoryFinalGovernance.test.ts` | 13 passed / 13 total |
| `npx jest --runInBand storyMemory` | 53 suites passed，1 skipped；488 passed，4 skipped |
| `npm run verify:version` | PASS，`V2.11.47` / `2114700` |
| 最终 `npm run verify` | 372 suites passed，2 skipped；3031 passed，7 skipped |
| `__tests__/storyMemoryProtocolV2.live.test.ts` | 因当前进程没有 `DEEPSEEK_API_KEY`，1 suite / 4 tests skipped；未读取或猜测 secret |

lint 中仍有仓库既有 warning，但无 error；typecheck、版本一致性和 Jest CI 均通过。真实 App 入口 QA 使用已配置的生产 LLM，实际请求取得 HTTP 200，弥补了 live Jest 因环境变量缺失而跳过的限制。

## 4. 真实 Android App 入口穿测

QA 证据目录：`test-logs/android-qa-story-memory-v2-final-governance-20260811-193153/`

### M1：known-change / rebuild

- 通过 App 入口执行现有长篇项目的“重新整理长期记忆”。
- 真实请求完成后 UI 恢复正常；DB 快照显示 state clean、已整理到第 11 章对应 position、无 pending dirty checkpoint，批次按范围 applied。
- 证据：`ui-after-rebuild-tap.xml`、`db-after-rebuild-tap.sqlite`。

### M2：三章 same-batch lifecycle

- 使用 App 导入的合成 QA 项目 `SMV2-Three-Chapter-Lifecycle-Prompt-Fix-QA`。
- 第 1 章初始化角色/既有关系；第 2 章真实 App 请求打开盟友关系、冲突、线程和伏笔；第 3 章真实 App 请求更新关系并 resolve conflict/thread、paid foreshadowing。
- 最终 UI：through 第 3 章、clean、characters 2、relationships 2、unresolved lines 0。
- DB：3 个批次均 `applied`，3 个 primary attempt 均 HTTP 200、`attempt_no=1`；active conflicts 0、open threads 0、foreshadowing 为 `paid`，关系与主线目标均已落库。
- 证据：`ui-three-chapter-memory-after-ch3.xml`、`db-three-chapter-lifecycle.sqlite`。

### M3：禁止未来引用

- 自动化测试覆盖五类实体及同章未来定义，未来引用均产生 `OBS_FUTURE_REF` 并局部 drop。
- 三章真实 App lifecycle 的 applied patch 未出现未来 N-key 被接受；没有人为放宽 Validator 或制造 App 侧注入通道。
- 证据：`__tests__/storyMemoryFinalGovernance.test.ts`、`db-three-chapter-lifecycle.sqlite`、`ui-three-chapter-memory-after-ch3.xml`。

### M4：后台/锁屏

- 在 App 维护任务运行中回到 Home 并锁屏；唤醒后恢复到相同任务范围，随后完成维护。
- 最终 UI 显示长期记忆正常、through 第 20 章、无 pending。
- 证据：`ui-m4-locked-start.xml`、`m4-power-locked*.txt`、`ui-m4-resumed.xml`、`ui-m4-resumed-complete-check.xml`。

### M5：force-stop 与 `outcome_unknown`

- 对长篇项目的已定稿旧章节做真实 known-change，定稿后约 1.2 秒在请求尚未返回时执行 `am force-stop com.shinewriter`，随后冷启动 App。
- UI 正确进入“需要处理未确认请求”，而不是把未确认请求显示成成功；显示已整理到第 9 章、待处理第 10–20 章。
- DB 中唯一非 succeeded attempt 为 `outcome_unknown`，`http_status=null`、`attempt_no=1`、`failure_class=outcome_unknown`、`error_code=COLD_START_SENT_WITHOUT_RESULT`；没有物理重试，也没有自动确认。
- 证据：`m5-force-stop-event.txt`、`ui-m5-after-force-stop-memory.xml`、`db-m5-after-force-stop-outcome-unknown.sqlite`。

### M6：下一章上下文消费

- 在三章 lifecycle 项目创建下一章，通过 App 的上下文预览与实际请求预览检查长期故事检查点接驳。
- 预览显示检查点截至第 3 章、coverage 完整、无空洞；消息详情包含已落库的盟友关系状态、当前目标、无 active conflict/unresolved clue/unfulfilled foreshadowing，以及最近完成的冲突解决 beat。
- 证据：`ui-m6-next-context-preview.xml`、`ui-m6-next-request-preview.xml`、`ui-m6-memory-message-detail.xml`。

所有 Debug App 安装均使用 `adb install -r`；没有执行 `adb uninstall`、`pm clear`、删除数据库或清库。现有 Debug QA 设备 `emulator-5554` 的 Debug 覆盖安装保留原 `firstInstallTime=2026-08-08 04:17:52`。

## 5. 版本与正式 APK

所有前置 Gate 通过后才顺延补丁版本：

- `npm version 2.11.47 --no-git-tag-version --ignore-scripts` 已同步 `package.json` 与 `package-lock.json`。
- `npm run prebuild` 生成 `src/constants/version.json`，未手改生成文件。
- README 的中文/英文版本、正式 APK 文件名、versionName/versionCode 已更新；CHANGELOG 已增加本次治理条目。
- `npm run apk:release` 成功，正式交付路径：
  `dist/apk/release/ShineWriter-V2.11.47-release.apk`
- APK 大小：36,510,782 bytes；SHA-256：`F07DC2F42342F968C2D9B9EEEAAC7B0879C0DBE513600953EB108F7E2BCB6088`。
- `scripts/verify-release-apk.ps1` 全部通过：package `com.shinewriter`、`versionName=V2.11.47`、`versionCode=2114700`、v2 签名、单 signer、zipalign、证书 SHA-256 `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`。
- 由于 Debug 与正式包证书不同，没有在保留用户数据的 Debug 设备上强行替换签名；使用第二个本地 AVD `emulator-5556` 完成正式包 `adb install -r` 和冷启动。安装成功，显示 `V2.11.47`/`2114700`，焦点为 `com.shinewriter/.MainActivity`，最近日志无 `FATAL EXCEPTION` 或 `AndroidRuntime` 崩溃。验收后已停止第二个 AVD，未卸载或清库。

## 6. 交付边界

- 本报告、源码、测试和版本元数据保留在工作树；APK、Gradle 中间产物、keystore、数据库、截图和日志未提交到 Git。
- 当前工作树仍有本轮未提交修改，未执行 commit、push 或覆盖用户已有修改。
- 正式 APK 已满足本轮治理 Gate，最终结论为 **PASS / GO**。
