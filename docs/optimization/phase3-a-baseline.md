# TAVO-MINI 三期 A 轮 Exact HEAD 基线

> 冻结日期：2026-08-24  
> Exact HEAD：`fc65973c09b682d2400ddb39768cad707a891cc4`  
> 远端：`origin/main` 与本地 `main` 一致  
> 版本：V2.21.1 / Schema 56  
> 工作区：除本轮方案文档与本基线产物外，无未提交生产改动

本文件只记录 **A0**：当前代码的真实基线。不改生产逻辑，不为 A1/A2/A3 提前铺路。

---

## 1. 工作区核对

| 项 | 结果 |
|---|---|
| `git fetch origin main` | 成功 |
| `HEAD` | `fc65973c09b682d2400ddb39768cad707a891cc4` |
| `origin/main` | 同一 SHA |
| 提交说明 | `chore(release): V2.21.1 revision structured report fix` |
| 未跟踪 | 方案文档 `docs/optimization/TAVO-MINI_Phase3_A_三级质量与Agent基座_20260824.md` |
| 生产源码 diff | 空 |

原则：ONE Kernel / ONE Context / ONE Prompt Compiler / ONE QA / ONE Memory。历史 frozen task Resume 语义不变。

---

## 2. 当前用户侧档位（A1 之前）

流水线配置页当前是四段思考档位，而不是方案要求的三级：

| UI 标签 | 内部 `executionProfile` | `reasoningEffort` | 方案对照 |
|---|---|---|---|
| 极速 | `one_shot` | `low` | A1 `fast` |
| 低 | `standard` | `low` | A1 将从用户侧收走 |
| 中 | `standard` | `high` | 当前平衡档 → A1 `standard` |
| 高 | `standard` | `max` | 当前质量档 → A1 `quality` |

内部仍只有：

- `WritingExecutionProfile = standard \| one_shot`
- `stageReasoning`
- `WritingStagePolicy`

新 Compact Standard DAG（仅新任务 / topology=2）：

`Freeze → Draft → ONE QA → Conditional Revision → FinalValidate → Persist`

极速把 QA / Revision 等付费阶段写成正式 skip，不减少 Canon / Outline / Seam / Story Memory / Writer Style 上下文。

---

## 3. 结构基线样本（12 章）

路径：`test-logs/phase3-a-structural-baseline.json`  
用例：`__tests__/writingPhase3ABaseline.test.ts`

每个场景 × 三档 × 2 章，Freeze 真实生产 `WritingRequest`，记录政策期望的 paid call，不发明第二套 Writer / Compiler / Budget。

| 场景 | 档位 | 章 | freezeFingerprint 前 12 位 | 期望 paid LLM | Formatter | Primary retry |
|---|---|---|---|---|---|---|
| Outline | 极速 | 1 | `ff9e49c0ada7` | 1 | 禁止 | 禁止 |
| Outline | 极速 | 2 | `68f0b2529ff5` | 1 | 禁止 | 禁止 |
| Continuation | 极速 | 1 | `34b7606c95ff` | 1 | 禁止 | 禁止 |
| Continuation | 极速 | 2 | `07f3bc1d5db6` | 1 | 禁止 | 禁止 |
| Outline | 当前平衡 | 1 | `95b0e6d59ab3` | 5* | 允许 | 允许 |
| Outline | 当前平衡 | 2 | `db8cf1e1a9ca` | 5* | 允许 | 允许 |
| Continuation | 当前平衡 | 1 | `95cd5a773bf6` | 5* | 允许 | 允许 |
| Continuation | 当前平衡 | 2 | `d999c87c9c06` | 5* | 允许 | 允许 |
| Outline | 当前质量 | 1 | `67d93a245232` | 5* | 允许 | 允许 |
| Outline | 当前质量 | 2 | `d3b55507e962` | 5* | 允许 | 允许 |
| Continuation | 当前质量 | 1 | `1cd24a97e96c` | 5* | 允许 | 允许 |
| Continuation | 当前质量 | 2 | `c4dd4f5ec717` | 5* | 允许 | 允许 |

\* `listPaidStagesForPolicy` 仍按 **legacy `stageOrder`** 计数（Outline：draft/review/factCheck/revision/proof；Continuation：draft/review/audit/revision/proof）。运行时 Compact DAG 是 `draft → qa → revision`，Revision 是否发出取决于 QA executable findings。因此 **运行时标准/质量档最多 3 次付费写作调用（Draft + QA + Conditional Revision）**，结构表里的 5 是 freeze 身份上的 legacy stageOrder 投影，不是 Compact 运行时上限。

### 上下文不缺失

- Outline 样本包含：`outline` / `story_memory` / `writer_style` / 上一章 `chapter`
- Continuation 样本包含：`canon` / `source_boundary` / `seam` / `primary_anchor` / `story_memory` / `writer_style`
- 极速与标准/质量使用同一套 FrozenWritingContext 收集-冻结路径，不缩上下文

### QA Revision 触发

当前合同：`conditional_on_executable_findings`  
（pass verdict 或无可执行 finding → 正式跳过 Revision）

### PostWriting State Extraction

当前仍是 Persist 之后的 **辅助调用**，One-Shot 不跳过 PostWriting / ONE Memory。结构样本不执行 PostWriting，故 `postWritingAuxiliaryCallCount = 0`、`stateExtractionMs = 0`；这是“未跑辅助阶段”，不是“极速取消了 State Extraction”。

### Finalize → Next Chapter Ready

结构 Freeze 不测量墙钟。该指标留给 A 轮完成后的 Debug 覆盖安装观察，不在 A0 伪造数字。

---

## 4. 质量门禁与安装

| 项 | 状态 |
|---|---|
| 结构基线测试 | PASS（`writingPhase3ABaseline.test.ts` 2/2） |
| `npm run verify` | PASS。lint/typecheck/version 通过；Jest `498` suites / `3818` tests passed（9 skipped），约 190.6s |
| Debug APK | `dist/apk/debug/ShineWriter-V2.21.1-debug.apk`（50.14 MB），`BUILD SUCCESSFUL` |
| 安装方式 | `adb -s emulator-5554 install -r -d --user 0`，**未** uninstall / `pm clear` |
| 安装前 | `com.shinewriter` 已存在：`versionName=V2.11.53` / `versionCode=2115300` |
| 安装后 | `Success` → `versionName=V2.21.1` / `versionCode=2210100` |
| 现有项目 | 作品库保留：**大纲创作 33**、**原著续写 15**；当前项目「Phase 3 穿测项目」仍在 |
| LLM 配置 | 设置页仍显示「OpenAI 兼容接口」与「LLM 设置」；流水线任务 (9) 仍在 |
| 截图 | `test-logs/phase3-a0-after-migrate.png`、`test-logs/phase3-a0-settings.png` |

---

## 5. A0 结论

- Exact HEAD 已冻结，生产逻辑未改。
- 用户侧仍是「极速 / 低 / 中 / 高」，A1 才收束为「极速 / 标准 / 质量」。
- 极速已严格 1 paid call，禁止 Formatter 与 Primary retry。
- 标准与质量共用 Compact Standard DAG，差别只在 `reasoningEffort`（high vs max）。
- 无第二 Kernel / Context / Prompt Compiler / QA / Memory。
- 旧 frozen task Resume 路径未触碰。

A0 GO：verify 全绿，Debug 覆盖安装成功且项目 / LLM 配置保留。进入 A1。

---

## 6. A4 真实 LLM 基线（2026-08-24 / 08-25）

> 设备：`emulator-5554` Medium_Phone；包 `com.shinewriter` V2.21.1 / `2210100`  
> 安装：`adb install -r -d --user 0`（`lastUpdateTime=2026-08-24 07:59:20`），**未** uninstall / `pm clear`  
> 模型：设备 Keystore 中已有的 OpenAI 兼容 `deepseek-v4-flash`  
> 项目：大纲「Phase 3 穿测项目」(id 48)；续写「qa-cont-pdca-20260817」(id 43，Canon/画风 ready)  
> DB 快照：`test-logs/a4-live.db`（50.7 MB）

### 6.1 Outline（共享 Writing Kernel）

| 档 | 章 | task | 结果 | 物理调用 | Draft in/out | QA in/out | Revision | QA 触发修订 | 定稿 |
|---|---|---|---|---|---|---|---|---|---|
| 极速 | 第 3 章 / 9202 | `pt_mt6ymbl3_125` | completed | **1** | 2578 / 2799 | 跳过 | 跳过 | 否 | 是 `final` |
| 极速 | 第 4 章 / 9203 | `pt_mt6yvi0r_126` | completed | **1** | 4648 / 6053 | 跳过 | 跳过 | 否 | 是 `final` |
| 标准 | 第 5 章 / 9204 | `pt_mt6z1lh8_127` | completed | **2** | 5582 / 15617 | 5496 / 1912 | 跳过 | 否（QA pass） | 是 `final` |
| 标准 | 第 6 章 / 9205 | `pt_mt6zabh6_128` | completed | **2** | 3998 / 10440 | 3988 / 1722 | 跳过 | 否（QA pass） | 是 `final`（08-25 补定稿） |
| 质量 | 第 7 章 / 9206 | `pt_mt6zxdlz_129` | **failed** | 2（Draft+QA 成功） | 4282 / 1903 | 4098 / 1125 | 失败：Network request failed → `revision 返回格式无效` | **是** | 否，0 字 |
| 质量 | 第 8 章 / 9207 | `pt_mt7ybcx6_130` | **failed** | 2 | 6871 / 10845 | 6279 / 1141 | 失败：格式无效；墙钟 3m 33s / UI 25,136 tok | **是** | 否，0 字 |

Receipt 落在既有 `pipeline_stage_attempts.frozen_request_json`：`requestId` 唯一；`requestFingerprint` 64 hex；失败 attempt 含 `outcome: failed`（provider 调用前 `started`，结束后 `failed`/`succeeded`）。

### 6.2 Continuation（同一 Kernel；账本 `continuation_generation_stage_results`）

| 档 | 章 | run | 结果 | UI 物理 | Draft in/out | QA in/out | Revision in/out | QA 触发修订 | 定稿 |
|---|---|---|---|---|---|---|---|---|---|
| 极速 | 第 16 章 / 9208 | `ct_5b68…52a4` | completed | **1** / 17,713 tok | 15565 / 2148 | 跳过 | 跳过 | 否 | 是 `finalized` |
| 极速 | 第 17 章 / 9209 | `ct_8e09…5c1c` | completed | **1** / 16,765 tok | 16169 / 596 | 跳过 | 跳过 | 否 | 是 |
| 标准 | 第 18 章 / 9210 | `ct_8603…7c82` | completed | **3** / 33,861 tok | 13071 / 596 | 8523 / 886 | 9555 / 1230 | **是** | 是 |
| 标准 | 第 19 章 / 9211 | `ct_42ca…1f0e` | completed | **3** / 33,176 tok | 13290 / 566 | 8591 / 405 | 9146 / 1178 | **是** | 是 |
| 质量 | 第 20 章 / 9212 | `ct_99ca…aa16` | completed | **3** / 35,117 tok | 13460 / 547 | 8629 / 1363 | 10000 / 1118 | **是** | 是 |
| 质量 | 第 21 章 / 9213 | `ct_0ea2…f311` | completed | **4**（Formatter 1）/ 43,315 tok | 13634 / 537 | 10590 / 2100 | 9518 / 6936 | **是** | 是 |

跑批墙钟（含采纳/定稿，ISO `created_at`→`updated_at`）：极速约 2m25s ×2；标准 4m01s / 4m20s；质量 6m07s / 14m09s。

### 6.3 Finalize → Next Ready / PostWriting

- 定稿后立刻 Toast「章节已定稿」。大纲：长期记忆后台排队（「待整理 N 章」）。续写：`状态提取与故事记忆重建已排队 (hash …)`。
- PostWriting / ONE Memory 在结果页 **采纳前保持「等待」**；定稿后进入 outbox，不在 Persist 同步做完。
- 「下一章」在正文底部（`next-chapter-button`），上滑后可点；已有下一章时编辑器约 2s 内打开。
- 截图：`test-logs/a4_ol_fast2.png`、`a4_ol_std1.png`、`a4_ol_std2.png`、`a4_qfail.png`、`a4_ch8_res.png`、`a4_cf1_90.png`、`a4_cs1_done.png`、`a4_cq1_done.png`、`a4_cq2_done.png`、`a4_cq2_fin.png`。

### 6.4 观察（不在 A4 修）

- 大纲质量档两次都在 **max thinking + json_object Revision** 上 fail-closed（网络失败或「返回格式无效」），Formatter 计数为 0。续写质量档同一 DAG 两次都过了 Revision。
- 大纲「标准」Draft Receipt 的 `reasoningEffort` 记为 `max`（`qualityProfile=standard`）。QA 仍是 `low`。不在本轮改映射。
