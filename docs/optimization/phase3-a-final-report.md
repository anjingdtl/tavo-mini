# TAVO-MINI 三期 A 轮最终验收报告

> 日期：2026-08-24  
> Exact HEAD 基线：`fc65973c09b682d2400ddb39768cad707a891cc4`（V2.21.1 / Schema 56）  
> A 轮封口 HEAD：`6d4adf3`  
> 结论：**A 轮 GO**。未实施 B/C 轮。

---

## 1. 本轮做了什么

只做方案规定的四件事：

| 阶段 | Commit | 内容 |
|---|---|---|
| A0 | `4aacc88` `test(writing): freeze phase3-a exact-head baseline` | 冻结 Exact HEAD，结构基线 12 样本，verify + Debug 覆盖安装 |
| A1 | `ff2c97f` `feat(writing): converge generation quality to fast standard quality` | 用户侧收束为 极速 / 标准 / 质量 |
| A2 | `88fde98` `feat(writing): add chapter truth projection to one frozen context` | FrozenWritingContext 内 Chapter Truth Projection |
| A3 | `6d4adf3` `feat(writing): add reconstructable request receipts` | 每次真实模型请求的 Request Receipt |

未做：QA + State Extraction 合并、Story Memory Delta、Segment Repair、下一章预取、新 Agent Loop、第二套 Context / Memory / Prompt Compiler。

---

## 2. 硬门禁对照

| # | GO 条件 | 结果 |
|---|---|---|
| 1 | 极速 / 标准 / 质量 UI 和冻结语义正确 | **GO**。流水线配置页只显示这三档；`GenerationQualityProfile` 在 Freeze 时映射到既有 `executionProfile` + `reasoningEffort`。截图：`test-logs/phase3-a-final-quality.png` |
| 2 | 极速仍严格 1 paid call | **GO**。`one_shot` skipRules 覆盖 QA/Revision 等付费阶段；禁止 Formatter 与 Primary retry。结构样本 paid call = 1 |
| 3 | 标准、质量仍使用当前 Compact Standard DAG | **GO**。`draft → qa → revision → finalValidate → persist`。质量档不增加 Stage |
| 4 | 三档 Canon / Outline / Seam / Story Memory / Writer Style 不缺失 | **GO**。极速不缩上下文；Continuation 样本含 canon/boundary/seam/anchor/story_memory/writer_style；Outline 样本含 outline/chapter/story_memory/writer_style |
| 5 | 旧 frozen task Resume 不改变 | **GO**。无 `qualityProfile` 的请求 freeze 仍不写入该键；`executionProfile` 仍仅在 one_shot 时显式落盘。解析未知 quality 值 fail-closed，缺省不迁移 |
| 6 | Truth Projection 在 Draft / QA / Revision 间无漂移 | **GO**。三阶段共用同一 `truthProjection.fingerprint`；漂移返回 `WRITING_TRUTH_PROJECTION_DRIFT`。不进入 freezeFingerprint |
| 7 | 每次 LLM request 都有唯一 Request Receipt | **GO**。`requestId` 唯一；含 freeze/truth/stage/messages/request fingerprints。完整 Prompt 不进 SQLite JSON；落在 artifact、kernel trace 与既有 `pipeline_stage_attempts.frozen_request_json` |
| 8 | `npm run verify` 全绿 | **GO**。A3 封口：lint + typecheck + version + Jest **502 suites / 3829 tests passed**（9 skipped） |
| 9 | Android Debug 覆盖安装验证通过 | **GO**。见 §5 |
| 10 | 不新增第二 Kernel / Context / Prompt Compiler / Memory | **GO**。无 `fastWriter` / 第二 Compiler / 第二 Context / 第二 Memory。内部仍是 `WritingExecutionProfile` + `stageReasoning` + `WritingStagePolicy` |

---

## 3. 映射与冻结语义

用户侧：`极速 | 标准 | 质量`

| 用户档 | `GenerationQualityProfile` | `WritingExecutionProfile` | `reasoningEffort` | 付费写作 DAG |
|---|---|---|---|---|
| 极速 | `fast` | `one_shot` | `low` | Draft 1 次；QA/Revision 正式跳过 |
| 标准 | `standard` | `standard` | `high`（原「中 / 平衡」） | Draft → ONE QA → Conditional Revision |
| 质量 | `quality` | `standard` | `max`（原「高」） | 同上，不增加 Stage |

历史任务：不迁移。Resume 只读已冻结 policy / snapshot。

---

## 4. 各阶段 PDCA

### A0

- **P**：不改生产逻辑，冻 Exact HEAD。  
- **D**：12 个结构 Freeze 样本（Outline/Continuation × 三档 × 2 章）；`npm run verify`；Debug APK `adb install -r`。  
- **C**：极速 paid=1；标准/质量 Compact DAG；项目 33+15 与 LLM 配置保留。  
- **A**：进入 A1。结构样本记录的 5 paid 是 legacy `stageOrder` 投影；运行时 Compact 上限是 Draft+QA+Conditional Revision。

### A1

- **P**：用户只见三级；内部不改 Kernel。  
- **D**：Red Test → `generationQualityProfile.ts` + Freeze 映射 + 流水线配置 UI + 设置持久化。  
- **C**：verify 全绿；无 `qualityProfile` 的 standard freeze 仍 byte-identical。  
- **A**：进入 A2。旧「低」档从用户侧收走，打开配置页会显示为「标准」。

### A2

- **P**：Draft/QA/Revision 共用冻结事实指纹。  
- **D**：`ChapterTruthProjection` 从 FrozenWritingContext 重建；gate + compiler fail-closed。  
- **C**：指纹稳定；漂移被拦；`freezeFingerprint` 不含 truth 字段，历史 Resume 可重建。  
- **A**：进入 A3。对测试夹具缺 `sourceBundle` 做了防御，避免误伤既有 Writer 单测。

### A3

- **P**：每次真实模型请求可追溯。  
- **D**：`WritingRequestReceipt` 在 Shared Writer 主路径与 Formatter 路径生成；写入 artifact / trace / `frozen_request_json`。  
- **C**：`requestId` 唯一；JSON 不含正文 Prompt。  
- **A**：A 轮封口。完整 Prompt 仍可通过 Frozen Context + `shared-prompt-compiler-v1` + stage 重建后对照 `messagesFingerprint`。

---

## 5. Debug 覆盖安装

| 项 | 结果 |
|---|---|
| APK | `dist/apk/debug/ShineWriter-V2.21.1-debug.apk`（56.81 MB） |
| 命令 | `adb -s emulator-5554 install -r -d --user 0` |
| 禁止项 | **未** uninstall，**未** `pm clear` |
| 安装 | `Success`；`lastUpdateTime` 2026-08-24 06:46:06 |
| 版本 | `versionName=V2.21.1` / `versionCode=2210100` |
| 项目 | 大纲创作 **33**、原著续写 **15**；「Phase 3 穿测项目」仍为当前项目 |
| LLM | 设置页仍有「OpenAI 兼容接口」；流水线任务 **(9)** 仍在 |
| UI | 生成质量 = **极速 / 标准 / 质量**，默认「标准」选中 |
| 截图 | `test-logs/phase3-a-final-home.png`、`phase3-a-final-quality.png`、`phase3-a-final-settings.png` |

---

## 6. 明确未做 / 范围边界

- 未跑 12 章 **live HTTP** 生成。A0 用生产 Freeze + 政策期望 paid call 冻基线；墙钟、真实 token、Finalize→Next Ready 不伪造。  
- 未改 Schema 版本（Receipt 复用已有 `frozen_request_json`）。  
- 未实施 B/C 轮。

---

## 7. 结论

A 轮十条硬门禁全部满足。

**A 轮 GO。可以进入 B 轮。**
