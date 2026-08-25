# TAVO-MINI 三期 A 轮最终验收报告

> 日期：2026-08-25  
> Exact HEAD 基线：`fc65973c09b682d2400ddb39768cad707a891cc4`（V2.21.1 / Schema 56）  
> A3 封口 HEAD：`6d4adf3`  
> A4：`a8f9378` Receipt 身份 + 失败 Receipt + 真实 LLM 基线  
> 预算修复：`d237fa1` 修订输出走弹性预留；后续 Formatter/Repair 同样去硬截断  
> 未实施 B/C 轮。

---

## 1. 本轮做了什么

| 阶段 | Commit | 内容 |
|---|---|---|
| A0 | `4aacc88` | Exact HEAD 结构基线 12 样本 |
| A1 | `ff2c97f` | 用户侧 极速 / 标准 / 质量 |
| A2 | `88fde98` | FrozenWritingContext 内 Chapter Truth Projection |
| A3 | `6d4adf3` | Request Receipt（当时指纹仍掺了 requestId/时间） |
| launcher | `851e6fd` | Windows 一键启动 |
| **A4** | 本提交 | ① 真实 LLM 矩阵 ② `requestFingerprint` 硬定性 ③ 失败请求 Receipt |

未做（方案明确排除，属 B/C）：QA+State Extraction 合并、Story Memory Delta、Segment Repair、下一章预取、新 Agent Loop、第二套 Context / Memory / Prompt Compiler。

---

## 2. 硬门禁对照

| # | GO 条件 | 结果 |
|---|---|---|
| 1–6 / 10 | A1–A3 语义（三级质量、Compact DAG、不缩上下文、历史 Resume、Truth 不进 freezeFingerprint、无第二 Kernel） | **维持 GO**。A4 未改这些合同 |
| 7 | 每次 LLM request 都有唯一 Receipt | **A4 收紧 GO**。`requestId` 仍唯一（`gt + stage + Date.now + seq`）；**`requestFingerprint` = sha256(stable identity)，不含 requestId / Date.now / seq / generationTraceId**。同模型/messages/params/frozen 请求指纹相同 |
| 7b | 失败请求也有 Receipt | **GO（代码 + 大纲 live）**。provider 调用前 `started` 立刻记入 trace；catch 写成 `failed`/`cancelled`；大纲落 `pipeline_stage_attempts.frozen_request_json`；续写失败落既有 `continuation_generation_stage_results.output_json`。无第二账本 |
| 8 | `npm run verify` | **GO**。lint + typecheck + version + Jest **502 suites / 3832 tests passed**（9 skipped） |
| 9 | Debug 覆盖安装 | **GO**。`install -r -d --user 0`，未卸载/清数据；`lastUpdateTime=2026-08-24 07:59:20` |
| live | Outline/Continuation × 三档 × ≥2 章真实 LLM | **部分 GO**。见 §6。续写 3×2 全部定稿；大纲极速/标准 2×2 定稿；**大纲质量两章修订失败未定稿** |

---

## 3. A4-2 / A4-3 实现要点

`WritingRequestIdentity` 只含：stage / kind / qualityProfile / executionProfile / provider / model / thinking / reasoningEffort / promptCompilerVersion / freeze / truth / stage / messages fingerprints / maxOutputTokens / responseFormat。

`invokePhysicalWriterCall`：先 `startRequestReceipt`（outcome=`started`，`recordWritingRequestReceipt`）再打 provider；成功 `finishRequestReceipt(succeeded)`；异常 `failed` 或 `cancelled`，并把 receipts 挂到 Error 上给 durable adapter。

Red Test：`__tests__/writingRequestReceipt.test.ts`（指纹确定性；失败路径 started→failed）。

---

## 4. A4-1 真实 LLM 基线摘要

设备 Keystore 已有 `deepseek-v4-flash`。详细表见 `docs/optimization/phase3-a-baseline.md` §6。

**极速**：Outline / Continuation 各 2 章，**物理 1**，QA/Revision 正式跳过，可采纳并定稿。

**标准**：Outline 2 章物理 2（QA pass → 修订跳过）；Continuation 2 章物理 3（QA 触发修订且修订成功）。

**质量**：Continuation 2 章物理 3–4（含一次 Formatter），修订成功并定稿。Outline 2 章 Draft+QA 成功后修订 fail-closed（网络失败 / `revision 返回格式无效`），Receipt 已落失败 outcome，章节未定稿。

**Finalize→Next Ready**：定稿 Toast 立即出现；续写明确排队「状态提取与故事记忆重建」。下一章按钮在正文底部，上滑可进下一章编辑器（约 2s）。

**PostWriting**：结果页采纳前为「等待」；定稿后走 ONE Memory / 状态提取 outbox，不是 Persist 同步完成。

---

## 5. Debug 覆盖安装

| 项 | 结果 |
|---|---|
| APK | `dist/apk/debug/ShineWriter-V2.21.1-debug.apk` |
| 命令 | `adb -s emulator-5554 install -r -d --user 0` |
| 禁止项 | **未** uninstall，**未** `pm clear` |
| 版本 | `versionName=V2.21.1` / `versionCode=2210100` |
| 项目 / LLM | 大纲 33 + 续写 15；Keystore 密钥保留 |

---

## 6. 明确未做 / 范围边界

- 未实施 B/C 轮。
- 未改 Schema 版本。
- 大纲质量档 Revision「返回格式无效」的根因是 Shared Compiler 把修订 `maxTokens` 硬截成 8192，截断 JSON 后又禁止 Compact Formatter 救援。已改为走冻结弹性输出预留（`resolveElasticStageOutputReservation` / `sharedStageMaxOutputTokens`），不再使用阶段本地绝对 cap。
- 未改「标准」Draft Receipt 上观察到的 `reasoningEffort=max` 映射现象。
- 续写成功路径在 A4 补写 `output_json.requestReceipts`（失败路径 live 时已有；成功路径 live 样本仍只在 token_usage / UI 账本，因补写发生在跑批之后）。

---

## 7. 结论

A4 代码三项缺口：指纹硬定性、失败 Receipt、真实 LLM 记录，均已落地。

**A4 代码 GO。**  
**live 矩阵：续写满矩阵 GO；大纲质量档曾因 8192 硬截断未定稿。预算修复后需覆盖安装再测。**  
停在 A 轮。不进入 B 轮。

---

## 8. 方案未完工与刻意未改的硬编码

### 本轮方案仍欠的建设

| 项 | 状态 |
|---|---|
| A0–A3 合同（三级质量、Truth、Receipt） | 已提交 |
| A4 指纹硬定性 + 失败 Receipt | 已提交 |
| Outline/Continuation × 三档 × 2 章 live | 续写满；大纲质量档待预算修复后复测 |
| 续写成功路径 Receipt 写入 `output_json` | 代码已补，live 样本在补写之前 |
| 方案排除的 B/C 项 | 不做 |

### 扫过但仍不改的硬编码（不是写作 Kernel 输出预算）

- `FALLBACK_CONTEXT_WINDOW = 8192`：配置缺失时的窗口兜底，不是阶段输出 cap。
- `deriveDefaultSafetyMargin` 的 256–1024：按窗口 2% 的安全边，弹性分配器自己的安全余量。
- `DEFAULT_MAX_TOKENS = 4000`：流水线配置默认值；弹性开启后会被 V3/20% 预留覆盖。
- `presets/catalog.ts` `max_tokens: 4000`：预设模板，不是运行时 envelope。
- 构建模块 `construction/budget.ts`：与写作上下文预算隔离。
- Provider 探测 `max_tokens: 16`、Tavern `openai_max_tokens: 300`。
- Formatter 候选 `slice(0, 12000)`：整理已有语义的输入截取，不是 `max_tokens`。
- Brief `visibleOutputFloor` 768–2048：只参与「可见输出 + thinking 是否装得下」检查；弹性模式下 `requestMaxTokens` 仍走 20% 预留。
