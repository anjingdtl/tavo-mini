# TAVO-MINI 第二期 Final-Seal 实际测试报告（停止收尾版）

日期：2026-08-21（Asia/Shanghai）
施工基线：`F:\\ClaudeWorkSpace\\projects\\TAVO-MINI`
报告性质：真实实机证据记录，不是 GO 宣告

## 结论

```text
PHASE 2 PRE-SEAL / NO-GO
```
本轮在 Final Production Code 上完成了真实 Standard 实机穿测，但没有自然获得正式的：

```text
QA executable finding → Revision=1
```

多次 QA 正文已经指出明显的硬约束违反，但实际落库的 QA 结果是普通文本摘要，不是带 `verdict/findings/severity/target/instruction` 的可执行 finding；运行时因此按当前契约跳过 Brief/Revision。不能把这些样本伪装成 Needs-Revision live，也不能宣布 `PHASE 2 FINAL SEALED / GO`。

## 1. HEAD 身份与代码边界

| 字段 | 实际值 | 说明 |
|---|---|---|
| `remoteMainBeforeWork` | `7713c81c68203d8dcb61515b150606ba23d02ea0` | C0 fetch 后的远端 `main` |
| `finalRepositoryHead` | `7713c81c68203d8dcb61515b150606ba23d02ea0` | 本轮实机证据绑定的仓库 HEAD |
| `finalProductionCodeHead` | `d9b603df81006e417a24890a3665911fe196d135` | 实际生产代码 HEAD |
| `realLlmValidatedHead` | `d9b603df81006e417a24890a3665911fe196d135` | App 从 `7713c81` 构建；相对该生产 SHA 只有 docs 差异 |
| `ciValidatedHead` | `NOT VALIDATED` | C2 未进入；没有远端 GitHub Actions SUCCESS 证据 |

已核实：

```text
HEAD == origin/main == 7713c81c68203d8dcb61515b150606ba23d02ea0
git diff d9b603d..7713c81 --name-only：仅 docs/ 路径
非 docs 生产路径差异：0
```

本轮没有修改主流水线、QA/Revision Prompt、Context、Memory、One-Shot 或 Legacy topology；没有生产代码修复，没有人工写数据库，没有清 App 数据。

## 2. 实机与安装证据

设备与应用：

```text
device: emulator-5554
API: 37
package: com.shinewriter
activity: com.shinewriter/.MainActivity
versionName: V2.11.54
versionCode: 2115400
```

构建与安装：

```text
npm run apk:debug                 BUILD SUCCESSFUL
APK: dist/apk/debug/ShineWriter-V2.11.54-debug.apk
bytes: 53880682
SHA256: 921D6C69A89BB085DC3700BA5D8EDB8B5B6CD947CA11A30437BBA807C20E7186
adb -s emulator-5554 install -r  Success
```

只执行了 `adb install -r`；未执行 `pm clear`、`uninstall` 或任何 App 数据清除。实机使用现有真实 OpenAI-compatible 配置，Standard 设置经 UI 保存并由数据库独立核验为：

```text
pipeline_mode: full
pipeline_execution_profile: standard
pipeline_reasoning_effort: low
provider: openai_compatible
base_url: https://api.deepseek.com
model: deepseek-v4-flash
```

密钥未写入本报告。

## 3. Final HEAD 真实 Standard 穿测

测试项目为 UI 创建的 Outline 项目 `tavo final seal natural standard`（project 26）。共完成 15 个真实 Standard 章节任务，章节 254–268 均通过 UI 采纳并最终定稿；没有人工改动任何任务结果。

所有 15 个任务的共同结果：

```text
Draft = 1
QA = 1
Revision = 0
Review/Audit/FactCheck/Proof = 0 paid call / 无对应旧 stage row
pipeline_tasks.status = completed
resolved_action = accept
```

章节 254–268 的最终快照中，`chapters.status=final`、`finalized_at` 非空且正文长度大于 0。代表性 clean trace 显示 `FinalValidate=completed`、`Persist=completed`，Story Memory 代表性快照为 clean；这些只能证明 Clean 路径持久化正常，不能替代缺失的 Needs-Revision 证据。

### 3.1 任务与 QA 实际结果

| chapter | task | QA 实际输出摘要 | 实际 Revision |
|---:|---|---|---:|
| 254 | `pt_mt1n0yc9_239` | 符合梗概、无确凿问题 | 0 |
| 255 | `pt_mt1ng20o_240` | 覆盖要点、无确凿问题 | 0 |
| 256 | `pt_mt1nnarq_241` | 符合硬性要求 | 0 |
| 257 | `pt_mt1ntde7_242` | 指出视觉描述、人物说话、未归还地图 | 0 |
| 258 | `pt_mt1o017y_243` | 判定三只瓶子设定符合 | 0 |
| 259 | `pt_mt1okyhj_244` | 指出未明确埃利安柑橘过敏 | 0 |
| 260 | `pt_mt1ortsq_245` | 指出声音描述及蜡封位置错误 | 0 |
| 261 | `pt_mt1oyuqp_246` | 指出未明确印章且水位超过第一级台阶 | 0 |
| 262 | `pt_mt1p43wg_247` | 指出多处颜色描述违反色盲设定 | 0 |
| 263 | `pt_mt1p90db_248` | 指出密封信封未取走及试图开封 | 0 |
| 264 | `pt_mt1pd54y_249` | 判定符合大纲 | 0 |
| 265 | `pt_mt1qckad_250` | 明确指出水到第一步后才完成交付的阻塞问题 | 0 |
| 266 | `pt_mt1qhy9n_251` | 判定四个动作顺序符合 | 0 |
| 267 | `pt_mt1qncnd_252` | 指出摘下头盔并说话违反硬约束 | 0 |
| 268 | `pt_mt1qxwl9_253` | 判定密封罗盘章节符合指令 | 0 |

### 3.2 关键失败证据

例如 task `pt_mt1qckad_250` 的 QA 正文实际为：

```text
发现一个阻塞性问题：水漫上第一步后才完成交付，不符合“before water reaches the first step”的硬性要求。
```

但同一任务的实际阶段结果为：

```text
draft: success, attempt=1
qa: success, attempt=1
brief: skipped
brief reason: QA 无可执行问题（verdict=pass 或无 blocking/warning 可定位修订项：info/generic 不触发）
revision paid call: 0
```

另一个 task `pt_mt1qncnd_252` 明确输出“摘下头盔并说话”违反硬约束，但同样被判定为 `brief skipped`，没有 Revision stage row，也没有 Revision paid call。

这说明本轮真实问题不是“没有任何内容违规”，而是：

```text
模型 QA 文本可以识别违规
但没有产生正式可定位 executable finding
→ 运行时无法合法触发 Revision
```

因此 C1 必须 NO-GO。不能用人工补 finding、人工改 severity 或人工写 Revision 来掩盖该问题。

### 3.3 调用与 token 证据

每个任务都只观察到一次 Draft 和一次 QA 主阶段调用；所有任务 Revision=0。`pipeline_stage_attempts` 显示大多数 Draft/QA 的 `formatter_used=0`；chapter 265 的 Draft 记录出现 `formatter_used=1`，该异常已如实保留，未被隐藏或改写。

代表性 task `pt_mt1qxwl9_253` 的 token 记录：

```text
Draft: input=9135, output=2674, total=11809
QA:    input=8817, output=423,  total=9240
Revision: no paid call
```

完整阶段原始结果和逐章数据库快照保存在本报告对应证据目录。

## 4. Continuation 探索结果（不计入封板样本）

为验证真实 Continuation 入口，曾通过 UI 导入本地 TXT 并启动 Canon quick analysis。该输入只有一个短章节，最终自然失败：

```text
state=failed
error_code=analysis_minimum_coverage_not_met
```

该尝试未进入写作 Draft/QA/Revision，不能计入任何 live gate；没有人工补齐覆盖率，也没有修改数据库。

## 5. C0–C4 Gate 实际状态

| 阶段 | 结果 | 实际事实 |
|---|---|---|
| C0 | GO | HEAD 已锁定；生产代码 SHA 为 `d9b603d`，当前仓库相对它仅 docs 差异 |
| C1 | **NO-GO** | 15 个真实 Standard 任务全部 `Draft=1 / QA=1 / Revision=0`；无正式 Needs-Revision live |
| C2 | 未进入 | 未查询或声称远端 Verify / Generation Stability SUCCESS |
| C3 | 未进入 | 本报告只记录 NO-GO 事实，不写虚假的远端 CI PASS |
| C4 | 未进入 | 本次提交是测试报告状态更新，不是 Final Seal GO 提交 |

## 6. Remote CI 状态

本轮因为 C1 未 GO，未进入 C2；因此：

```text
Remote Verify: NOT RUN / NOT VALIDATED
Remote Generation Stability: NOT RUN / NOT VALIDATED
Phase 2 Final Seal Gate: NOT RUN / NOT VALIDATED
ciValidatedHead: NOT VALIDATED
```

任何本地 workflow-equivalent 或历史 CI 记录都不能在本轮被写成远端 SUCCESS。

## 7. 证据索引

主要证据目录：

```text
test-logs/emulator-qa-20260820-final-seal-needs-revision/
```

关键证据：

```text
apk-debug-build.log
adb-install-r.log
pipeline-config-standard.txt
db-after-user-stop.sqlite
db-chapter-15-final.sqlite
chapter-2-stage-results-raw.json … chapter-15-stage-results-raw.json
clean-pipeline-context.json
clean-story-memory.txt
logcat-app-errors-after-ai-safe.txt
```

这些证据保留了真实 UI、数据库状态、阶段结果和设备日志；报告不包含 API key、完整 Prompt 或完整 Draft 正文。

## 最终判定

```text
Clean Standard live: 已观察到并持久化
Needs-Revision live: FAIL（未获得正式 finding → Revision=1）
One-Shot live: 本轮未重新执行，不得宣称本轮已闭环
Remote Verify: 未验证
Remote Generation Stability: 未验证
HEAD/报告: 已按本轮真实 NO-GO 状态修正

PHASE 2 PRE-SEAL / NO-GO
```
