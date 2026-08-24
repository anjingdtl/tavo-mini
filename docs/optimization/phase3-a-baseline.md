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
