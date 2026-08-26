# ShineWriter 建设进度（B 轮工程）

> 最后更新：2026-08-26 · 分支：`main`
> 测试基线：Jest 全量 `3586 passed / 9 skipped`；`tsc` 0 error；`lint` 0 error

## 工程目标（B 轮）

在 ONE Kernel / ONE Context / ONE Prompt Compiler / ONE QA / ONE Memory 的
收敛基线上，完成生产闭环与体验提效：

- 结果页以「作品」为第一层（最终稿字数/段落优先，技术详情收进折叠）
- Final Artifact 一等公民（落库、结果卡、编辑/阅读/对比入口）
- Revision 修改处逐段可见（Diff / Changeset）
- Evidence QA（Exact Draft + 章节真相 + 要求检查清单 + 相关证据，带 fail-safe）
- QA/State 合并（Shadow 双跑 → Cutover 金丝雀，最终目标 2 次语义调用）
- Anchored Segment Repair 与三档调用目标封板（B7/B8 待办）

## 已完成阶段

| 阶段 | 交付内容 | 验证 | 提交 |
|------|----------|------|------|
| B0 | 项目一级导入入口恢复 + TXT/JSON 导入闭环（含双确认与流式解析） | 全量测试 + 模拟器闭环 | `d2ec04f` |
| B1 | Final Artifact 一等公民：summary 落库、结果卡、初稿/终稿指纹与来源判定 | 全量测试 + 模拟器落库校验 | `8b10010` |
| B2 | Revision ChangeSet / Diff：段级 LCS 差异、修改处数、逐条查看 | 单测 16 用例 + 全量 | `c8435f9` |
| B3 | 结果页重构：章节标题 + 最终稿卡（字数/段落/修改处）+ 动作层 +「生成详情」折叠 +「编辑最终稿」直达 | 全量测试 + 模拟器闭环 | `65db61c` |
| B3-fix | 「编辑最终稿」返回回到结果页（跨 Tab 返回上下文，而非章节列表） | 模拟器闭环 | `1187732` |
| B4 | Evidence QA Projection：QA 缩放为 Exact Draft + Chapter Truth + Requirement Checklist + Relevant Evidence；低置信 fail-safe 回退 union；QA 输入 token 结构化观测 | 单测 7 用例 + 真机管线（fallback 路径实测） | `afcb305` |
| B5 | QA/State Shadow：QA 契约增加 `stateProposals`（模型只出 evidenceQuote，禁止手算 offset）；evidenceQuote→UTF-16 本地解析（0/1/多命中规则）；与 legacy 提取的影子对比统计入 observability | 单测 12 用例 + 真机管线回归 | `d767bad` |
| B6 | QA/State Cutover 金丝雀：QA proposals 本地解析后以 pending 进入既有提案管道（幂等复用，不自动确认）；Revision 契约增加 `finalStateProposals` + `proposalSourceBodyFingerprint`（最终正文指纹绑定） | 单测 6 用例（续写侧）+ 全量回归 | 待推送（见 `git log` 最新提交） |

## 验证方式与基线

- Android 实测一律 `adb install -r` 覆盖安装，禁止 `uninstall` / `pm clear`，
  保留项目、LLM 配置、Writer Style、Canon、Story Memory 与用户导入数据。
- 每阶段：Red Test → 实现 → targeted verify → 全量回归 → 真机/模拟器闭环 → 独立提交。
- 管线输入 token 观测（`llm_usage_logs`，实测样例）：
  - Draft input ≈ 1.4k tokens
  - QA（当前无续写证据场景走 fail-safe union）≈ 2.7k–3.7k tokens
  - B4 目标：Evidence 投影下 QA input p50 约为 Draft 的 30%–45%（需续写场景实测确认）。

## 未完成（后续阶段）

- **B7 Anchored Segment Repair**：局部问题改为段级修复（段 anchor + 替换文本 +
  本地校验与确定性拼接），不再整章修订；仍属现有 Revision Stage，不新增 stage；
  失败回退整章 Revision。
- **B8 三档调用目标封板**：极速 1 call / 标准 Clean 2 calls / 标准 Issue 3 calls /
  质量档 ≤3 calls；并补足 `draftCharCount / segmentRepairCount / qaInputToDraftInputRatio /
  finalArtifactFingerprint` 等观测字段。
- **续写场景真机验证**：当前模拟器数据为大纲项目；续写路径以单测 + shadow 数据为准，
  切换门禁（重大事实漏提 / Canon 误收 / 未来泄漏 / 证据错绑 / 指纹失配 均为 0）待续写实测。

## 约束与约定

- 发版构建遵循 `docs/RELEASE_APK_BUILD.md` 与 `docs/RELEASE_CHECKLIST.md`；
  版本号经 `npm version` 与 `npm run prebuild` 生成元数据，不手改生成文件。
- B 轮方案细节见 `docs/optimization/TAVO-MINI_Phase3_B_生产闭环与体验提效_20260826.md`（规划文档，不入库）。