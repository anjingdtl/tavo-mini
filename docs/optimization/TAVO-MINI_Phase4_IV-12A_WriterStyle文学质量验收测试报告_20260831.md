# TAVO-MINI Phase IV IV-12A～IV-12E Writer Style 与文学质量验收测试报告

日期：2026-08-31（Asia/Shanghai）
施工仓：`E:\AiWorkSpace\tavo-mini`
验收主方案：[`TAVO-MINI_Phase4_优化建设与WriterStyle文学质量最终封板方案_20260831.md`](E:/AiWorkSpace/tavo-mini/docs/optimization/TAVO-MINI_Phase4_%E4%BC%98%E5%8C%96%E5%BB%BA%E8%AE%BE%E4%B8%8EWriterStyle%E6%96%87%E5%AD%A6%E8%B4%A8%E9%87%8F%E6%9C%80%E7%BB%88%E5%B0%81%E6%9D%BF%E6%96%B9%E6%A1%88_20260831.md)

## 1. 最终结论

本轮 IV-12A～IV-12E 的验收范围全部通过：

| 验收面 | 结果 | 关键证据 |
| --- | --- | --- |
| Safety | PASS | Thinking enabled；Mandatory Truth/冻结上下文回归通过；Governor physical call=0；无 hidden retry；DB integrity=ok |
| Throughput | PASS | 12/12 样本完成，三个档位均 4/4 first-pass；无稳定 runaway、Context Block 或额外物理调用 |
| Writer Style | PASS | 25/25 条要求逐样本完成评测；Adherence=1.0；Hard Style Violation=0；Style Drift=0 |
| Narrative Quality | PASS | Scene Completion、Beat Realization、Character Consistency、Causal Continuity、Ending Effectiveness 全部逐样本 PASS |
| Engineering | PASS | `npm run verify`、targeted Jest、typecheck、lint quiet、Elastic、version、APK、`adb install -r`、crash/ANR 检查全部通过 |

因此，当前代码与本轮脱敏证据满足：

```text
PHASE IV FINAL SEALED / GO
```

本结论只针对本报告所绑定的 Writer Style 投影、生产代码状态和证据工件。后续如改动生产 Prompt 或 Completion Boundary wording，必须重新执行方案规定的 pathological equivalent 3/3、5 章、10 章验证；本轮没有生产 Prompt 改动，因此该条件未被触发。

## 2. 变更边界与根因闭环

### 2.1 基线与保护

- 已执行 `git fetch origin --prune`。
- IV-12A 开工时 `HEAD == origin/main == 24b65486337cf0c45a2a5aa9d82661d0f1644f23`。
- 工作区中用户既有未跟踪的 Phase III/Phase IV 文档和 QA 产物均保留，未执行 `git reset`、`git clean`、`adb uninstall` 或 `pm clear`。
- 设备原始数据库先做快照，验证后原样恢复；恢复前后 SHA-256 均为 `374b05cf5ae2b16c390cd35c5b18e3a88e456879565f6e77dfd4a47ca79de3e9`，SQLite `integrity_check=ok`。

### 2.2 RED → Root Cause → 最小修正 → 重测

首轮矩阵检查发现：批次冻结时 Standard/Quality 的质量档位推导可能沿用 stale live profile，造成冻结的 `qualityProfile`/`executionProfile` 与实际请求 override 不一致，不能作为有效 A/B 分母。该问题是质量档位配置传播问题，不是用文学分数倒推生产行为，也不是 Prompt 质量问题。

最小修正为导出并复用 `resolvePipelineGenerationQualityProfile()`，让批次冻结上下文从当前请求的有效 reasoning/execution override 推导质量档位。随后重新构建 APK、重新跑三档 Android 矩阵，并只接收修正后的 v2 证据。没有新增生产 Judge LLM、文学 Gate、自动 retry/re-plan、第二 Writer、第二 Context、第二 Prompt Compiler 或固定业务 `maxTokens`。

本轮 Literary Evaluation 全部位于 Test/Evidence/Acceptance 层：

- `scripts/qa/writerStyleAdherence.ts`：测试侧 Style Requirement Projection、Adherence 汇总和脱敏证据辅助函数；生产 `src` 无引用。
- `scripts/qa/collect-writer-style-evidence.mjs`：只读、metadata-only 证据采集器。
- `__tests__/writerStyleAdherenceContract.test.ts`：Writer Style 合同测试。

## 3. Writer Style Requirement / Adherence 合同

真实项目 Writer Style 是唯一 SSOT，来自冻结写作上下文的实际 Style 资产 `IV12A冷静限知`，而不是另建一套测试风格。证据中的 Style fingerprint 为：

```text
d896039e1e7e8c09a093bf0fb0fde43a0e29b93d0eefe637f911d644d3956b27
```

合同投影共 25 条可追溯要求：

| 类别 | 数量 | 验收含义 |
| --- | ---: | --- |
| Mandatory | 4 | 必须满足；任一未知或不满足即不通过 |
| Preferred | 19 | 应尽量保持；用于 Style Adherence 与 Drift 观察 |
| Avoid | 2 | 命中禁止模式或明显违反即形成风格问题 |
| 合计 | 25 | 每个样本都必须完成评测 |

12 个样本均满足：`assessed=25`、`unknown=0`、`satisfied=25`、Mandatory `4/4`、`writerStyleAdherenceRate=1.0`、`hardStyleViolationCount=0`、`styleDriftCount=0`。证据层明确声明 `productionJudgeLlm=false`、`productionLiteraryGate=false`、`productionRetryOrReplan=false`。

## 4. 同题 Fast / Standard / Quality A/B

### 4.1 可比性

三档共使用同一组 4 类计划任务：人物对白冲突、情绪关系推进、悬疑调查清单、动作强因果。每类任务分别在 Fast、Standard、Quality 下执行，形成 `4 × 3 = 12` 个样本。

- 同一 Plan fingerprint：`5f04c3fc6f27eee1a781d4f4cf15eb6ed5e9f99ce42544fc887d9a3c2d1b5b23`。
- 同一 Writer Style fingerprint 和同一 Style Requirement Projection fingerprint：`1cdcb80019611e54eab7ed667b154a33a7d36b566cf43fe8d207ab2e2bd1d14d`。
- 使用同一 Context 构建版本和相同任务上下文输入；每个样本独立冻结，`contextIsolatedPerSample=true`，避免跨样本污染。
- 同一模型、同一 Thinking 开启语义；只改变质量档位对应的 reasoning/execution 配置。

### 4.2 运行矩阵与 Physical Calls 口径

本报告的 `Physical Calls` 指阶段级真实网络请求，不是“每个章节只允许一次”的抽象章节计数。Fast 只有一次 Draft 请求；Standard/Quality 各有一次 Draft 和一次 QA 请求。没有 retry、fallback 或自动 re-plan，因此每章物理请求分别为 Fast=1、Standard=2、Quality=2。

| 档位 | reasoning / execution | 样本 | 批次完成 | LLM calls | 每章物理请求 | First-Pass | retry / fallback |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Fast | `low` / `one_shot` | 4 | 4/4 | 4 | 1/chapter | 4/4 | 0 / 0 |
| Standard | `high` / `standard` | 4 | 4/4 | 8 | 2/chapter | 4/4 | 0 / 0 |
| Quality | `max` / `standard` | 4 | 4/4 | 8 | 2/chapter | 4/4 | 0 / 0 |

所有样本均为 Thinking enabled、finish reason 为可接受的 stop、无 outcome_unknown；Governor 没有 physical call，也没有阻断 current request。

### 4.3 Writer Style 与叙事结果

Writer Style 三档结果完全一致：每档 4/4 样本 Adherence=1.0，Hard Style Violation=0，Style Drift=0。因此不存在“某一档明显更稳定”的证据；在本分母上三档并列稳定。

叙事质量采用独立、脱敏的 evidence-code 标注，最低通过分数为 3（1～4 量表），不保存正文、完整 Prompt 或 reasoning 原文。各档平均分如下：

| 档位 | Scene Completion | Beat Realization | Character Consistency | Causal Continuity | Ending Effectiveness | 结论 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Fast | 3.75 | 3.50 | 4.00 | 4.00 | 3.75 | 4/4 PASS |
| Standard | 4.00 | 4.00 | 4.00 | 4.00 | 4.00 | 4/4 PASS |
| Quality | 3.75 | 4.00 | 4.00 | 4.00 | 3.75 | 4/4 PASS |

Fast 的动作因果样本按保守规则记为 Beat Realization=3，但仍保留关键 beat 和后果链，未形成失败。这个保守分不会改变 12/12 的通过结论。

## 5. Completion Boundary 文学副作用专项

12/12 样本对以下五项均为 PASS：

| 检查项 | 结果 | 结论 |
| --- | --- | --- |
| Investigation summary | PASS | 调查内容被场景化呈现，没有退化成摘要/清单复述 |
| Emotion too fast | PASS | 情绪有递进，没有被 Boundary 直接跳到结论 |
| Action chain truncated | PASS | 行动、反应与后果链完整，没有截断在动作发生前 |
| Slow-pace checklisting | PASS | 慢节奏样本仍有场景推进，没有模板化列清单 |
| Template ending | PASS | 结尾保持具体钩子/开放动作，没有统一套话结尾 |

因此本轮没有发现 Completion Boundary 造成的场景缩水、摘要化、情绪过快、动作链截断、慢节奏清单化或模板化结尾；没有需要继续做 Prompt 最小修正的文学退化根因。

## 6. Quality Tier Value 与 Literary Shape Telemetry 边界

本轮观察到的档位价值如下：

- Fast 用 4 次调用完成 4 个样本，物理调用和延迟最低；文学标注仍全部通过，但平均 Beat 分低于 Standard。
- Standard 增加一次 QA，调用数为 Fast 的 2 倍；本小样本中五项叙事平均分均为 4.00，说明 QA 在本矩阵中带来可观察的完整性/一致性收益，但样本量不足以宣称普遍因果关系。
- Quality 与 Standard 同为 8 次调用，Quality 使用更高 reasoning；本矩阵没有额外通过率收益或 Style 收益，平均叙事分反而在 Scene/Ending 上略低于 Standard。因此不能仅凭档位名称断言 Quality 一定更好；额外成本的文学回报在本分母上尚未证明。

下列数据来自脱敏的 `writing-quality-shape-telemetry-v2.json`，只作为 Literary Shape Telemetry / Pipeline Stability 描述，不作为文学质量分数或 Gate：

| 档位 | batch input tokens | batch output tokens | stage latency mean | 形态 telemetry 示例 |
| --- | ---: | ---: | ---: | --- |
| Fast | 29,358 | 15,102 | 44.8s | bodyChars mean 2,076.75；dialogue ratio mean 0.11 |
| Standard | 59,681 | 59,179 | 87.1s | bodyChars mean 2,105；dialogue ratio mean 0.14 |
| Quality | 68,015 | 62,477 | 95.2s | bodyChars mean 2,674.25；dialogue ratio mean 0.13 |

句长、对白率、重复率、段落数、正文长度和结尾标点等都不能替代 Style Adherence、叙事维度或独立验收。它们只用于发现异常形态和定位根因。

## 7. Safety / Throughput / Android 证据

- 12 个样本均为 `thinking=enabled`；未关闭 Thinking。
- Mandatory Truth 保持在冻结上下文链路中；本轮没有增加 Context 架构或旁路副本。
- Governor 继续旁路；矩阵和证据中的 Governor physical call 为 0。
- 没有 hidden retry、protocol fallback 或自动 re-plan；每个样本均为单次阶段尝试，retry 计数为 0。
- `verify:elastic` 通过，没有恢复固定业务 `maxTokens`；质量档位修正只处理 profile propagation。
- 三个 SQLite 最终数据库 `integrity_check=ok`；账户、章节批次和证据均由脱敏 collector 读取。
- Android 使用 `emulator-5554`，安装 `dist/apk/debug/ShineWriter-V2.21.1-debug.apk`，仅采用 `adb install -r`。三档批次均 4/4 完成。
- 三份终态 logcat 均未命中 `FATAL EXCEPTION`、`AndroidRuntime FATAL`、`ANR in`、`OOM`、`SocketTimeout` 或 `SSLHandshakeException`。
- 设备原始数据库已在测试后精确恢复，恢复文件与 preflight 快照 SHA-256 一致；应用保持 force-stopped，避免恢复后的设备状态继续写入。

本轮未修改生产 Prompt，因此不触发重新跑 pathological equivalent 3/3、5 章、10 章的条件；既有 IV-10/IV-11 的真实 Android 连续运行与 Thinking/Completion Boundary 证据继续作为历史安全基线保留。

## 8. Engineering Verification

| 检查 | 结果 |
| --- | --- |
| `npm run verify` | PASS：534 suites passed / 4 skipped；3,773 tests passed / 9 skipped；总计 3,782 tests；退出码 0 |
| targeted Writer Style + quality profile Jest | PASS：13/13 |
| `npm run typecheck` | PASS |
| `npm run lint -- --quiet` | PASS |
| `npm run verify:elastic` | PASS |
| `npm run verify:version` | PASS：V2.21.1 / versionCode 2210100 |
| Debug APK build | PASS：`dist/apk/debug/ShineWriter-V2.21.1-debug.apk` |
| Android `adb install -r` / UI / logcat | PASS |
| `git diff --check` | PASS：无 whitespace error |

全量 lint 的既有 warning 未被本轮新增错误放大；quiet 检查无输出并成功退出。

## 9. 脱敏证据索引

- 机器可读 Writer Style / Narrative / Boundary 验收：[`writer-style-evidence-v2.json`](E:/AiWorkSpace/tavo-mini/test-logs/phase4-iv12a-20260831/writer-style-evidence-v2.json)
- Literary Shape Telemetry：[`writing-quality-shape-telemetry-v2.json`](E:/AiWorkSpace/tavo-mini/test-logs/phase4-iv12a-20260831/writing-quality-shape-telemetry-v2.json)
- 脱敏独立标注：[`annotations-v2.json`](E:/AiWorkSpace/tavo-mini/test-logs/phase4-iv12a-20260831/annotations-v2.json)
- 三档 Android 数据、截图、UI XML、logcat：[`test-logs/phase4-iv12a-20260831/`](E:/AiWorkSpace/tavo-mini/test-logs/phase4-iv12a-20260831/)
- 设备 preflight/restore 快照：[`test-logs/phase4-iv12a-preflight-20260831/`](E:/AiWorkSpace/tavo-mini/test-logs/phase4-iv12a-preflight-20260831/)
- Style contract test：[`writerStyleAdherenceContract.test.ts`](E:/AiWorkSpace/tavo-mini/__tests__/writerStyleAdherenceContract.test.ts)
- Test-side contract implementation：[`writerStyleAdherence.ts`](E:/AiWorkSpace/tavo-mini/scripts/qa/writerStyleAdherence.ts)
- Read-only evidence collector：[`collect-writer-style-evidence.mjs`](E:/AiWorkSpace/tavo-mini/scripts/qa/collect-writer-style-evidence.mjs)
- 本轮最小生产修正：[`outlineStageRuntime.ts`](E:/AiWorkSpace/tavo-mini/src/services/pipeline/outlineStageRuntime.ts)
- 进度记录：[`phase4-progress.md`](E:/AiWorkSpace/tavo-mini/docs/optimization/phase4-progress.md)

所有提交证据遵循 metadata-only 规则：不保存 API Key、reasoning 原文、完整正文、完整 Prompt、标题/梗概或错误消息。

## 10. Final Seal Decision

本轮完成了从真实 Writer Style SSOT 到 Style Requirement Projection、同题三档 A/B、独立文学验收、Completion Boundary 专项、稳定性与 Android 工程验证的完整 PDCA 闭环。结果证明：

```text
高通过率 + 高效率 + Writer Style 不丢 + 小说质量不降 + 工程证据完整
```

最终决策：

```text
PHASE IV FINAL SEALED / GO
```

后续若出现文学质量退化，处理顺序仍固定为：

```text
Root Cause → 最小修正 → 同题 A/B → Android/工程回归 → PDCA
```

不得将 Literary Evaluation 演变为生产 Judge LLM、文学 Gate、自动 retry/re-plan 或新增架构层。
