# Phase IV-13 Final Closure Progress（最后一轮收尾进度）

> Historical Evidence（2026-08-31）：本文件的 HOLD 与旧分母只保留历史轨迹；当前状态与分母以 `phase4-iv13u-progress.md` 为准。

日期：2026-08-31（Asia/Shanghai）
主方案：`docs/optimization/TAVO-MINI_Phase4_IV13_Final_Closure_Plan_20260831.md`
状态：**PHASE IV FINAL SEAL HOLD / NO-GO**（六场景中 A1/A2/A3/B1/B2 全 PASS，
B3 续写 3 章批量两次传输层暂停未达 3/3；详见最终报告 §8）

## 基线（实测）

- `git fetch origin` 已执行；`origin/main == HEAD == 8e27a87e7d6e86d8071087573b38145ceebc2b62`。
- 分支 `main`；tracked worktree clean；既有未跟踪文件全部保留。
- 本轮禁止 `git reset --hard` / `git clean` / `adb uninstall` / `pm clear`。
- 设备 `emulator-5554` 在线（state=device）。

## Pre-Test Corrections 核对结论（代码实测，2026-08-31）

| 项 | 结论 | 本轮动作 |
| --- | --- | --- |
| P0-1 选区闭环 | `lastNonEmptySelectionRef` 修复在位；上轮安装后闭环证据缺失 | CHECK-B 后真机 UI smoke，PASS 才开 A1/B1 |
| P0-2 修订后 Memory 闭环 | **缺口确认**：apply 只写章节，无 PostWriting 复用；两条既有闭环对修订 fingerprint 抛 REVISION_DRIFT | apply 自动进入既有闭环 + revision-advanced 容忍（最小修正） |
| P1-1 结果页双修订入口 | **被采纳门槛挡住**：两结果页均 `adopted/accept` 后才显示 | Pre-Adoption Revision（base=候选 artifact）最小纠偏 |
| P1-2 Plain-Text 精度 | 契约在位、结构性高精度；自然小说负例不足 | 补自然负例 + duplicate title 策略验证 |
| P1-3 Receipt 模型一致性 | **违规确认**：wire 用 live config，Receipt 记 frozen modelName | 方案 B：Receipt 记录真实 resolve 后 provider/model/config |

## 施工进度

- [x] 基线与保护确认
- [x] 关键代码通读（userRevision / Modal / PostWriting 闭环 / 结果页 / Plain-Text 合同 / 采纳路径）
- [x] 本方案与进度文档落盘
- [x] P1-3 Receipt 修正：`UserRevisionReceipt` 新增 `providerType` / `frozenModelName`；
      `modelName` 改记 resolve 后的 live wire 模型（方案 B）。测试
      `userRevisionReceiptModel.test.ts` 3/3 PASS（含凭据/正文不泄漏断言）。
- [x] P0-2 修正：`applyUserRevisionPreview` 在章节写入后自动进入既有闭环
      （outline → `finalizeChapterMemory({revisionAdvancedBody:true})`；
      continuation → `finalizeContinuationChapter({allowRevisionAdvancedBody:true})`）；
      两条闭环对 revision-advanced body 容忍 REVISION_DRIFT（冻结 trace 不可变，
      新 fingerprint 键控 outbox 行为新 authority）；闭环失败回滚章节写入并抛
      `USER_REVISION_POST_WRITING_FAILED`。测试：`userRevisionPostWritingClosure.test.ts`
      （真实 in-memory SQLite）3/3 + persistence 3/3 PASS。
- [x] P1-1 修正：`UserRevisionCandidateRef`（chapter / pipeline_task / continuation_run）、
      `loadUserRevisionCandidateBase`（大纲=completed task 的 final_text；续写=
      awaiting_user run 的最新 eligible final artifact）、
      `applyUserRevisionPreviewToCandidate`（候选 CAS + 共享 Plain-Text 门 + before 快照 +
      persistTaskFinalText / insertArtifact(eligible final) + 落库校验）；两个结果页在
      未采纳状态暴露双修订入口（Modal 内候选选区框支持真实长按选区）。
      测试 `userRevisionCandidate.test.ts` 7/7 PASS。
- [x] P1-2 修正：PATCH_MARKER_RE 收紧为结构化形态（行首标签/整行备注/diff 语法），
      句中自然语义（"其余内容不变，只把最后一句压低"）不再误杀；新增自然小说负例
      （对白冒号/省略号/书名号/单一章题/未闭合括号豁免）与 duplicate-title 头部结构
      策略验证。plainTextNovelBody 10/10 PASS。
- [x] CHECK-A：targeted 12 suites / 77 tests PASS；`npm run typecheck` PASS；
      `npm run lint -- --quiet` 0 errors；`npm run verify:elastic` PASS；
      `npm run verify:version` PASS（V2.21.1 / 2210100）；`npm run verify` PASS
      （541 suites passed / 3812 tests passed，3 suites / 8 tests skipped，exit 0）。
- [x] CHECK-B：`apk:debug` PASS（最终封板构建 SHA
      `d02b588074e240de3816f4604717d4cfad37d4fac7199da7a2005e9a418b9adf`），
      `adb install -r` 成功且 `firstInstallTime` 始终保持 2026-08-23 04:59:45 不变
      （全程未卸载/清库）。LLM 凭据确认可用（Deepseek / deepseek-v4-flash，
      应用内"保存并测试"= 测试通过）。
- [x] P0-1 真机 smoke PASS：真实长按/双击/SHIFT+方向键选区 → 精准修订 → Modal 显示
      正确选区（30..87 / 73..243 等）→ selected text 与 UTF-16 start/end 对应。
      真机发现并修复缺陷①：键盘激活态下打开修订 Modal 会立即被窗口焦点切换关闭
      （打开前主动 blur，`TextInput.State.currentlyFocusedInput()?.blur()`）。
- [x] 真机驱动中发现并修复缺陷②：`user_revision_*` 场景被 60s normal watchdog
      错误分类，thinking 长请求被客户端 outcome-unknown 中断（真机 A1 首跑复现）。
      修正为归入 chapterDraftMs=570s 长超时桶（非新增 retry；与流水线同桶），
      RED→GREEN 测试 `llmRequestPolicy.test.ts`。修复后真实修订 41s/20s 完成。
- [x] A1（大纲·精准修订单章 ×1）PASS：真实生成 Final（2,897 字候选）→ 结果页直接
      进入候选精准修订（P1-1 Pre-Adoption 入口）→ 候选正文选区框真实选区
      （2936..2970）→ 1 次 LLM（Receipt：physical=1，thinking ON，hiddenRetry=0，
      Governor 旁路，resolved model=deepseek-v4-flash）→ Diff 预览 → 确认应用
      （候选更新 1 处）→ 采纳（章节=修订后候选 3001 字）→ 定稿 → ONE Memory
      outbox（fingerprint=修订后正文）**completed**。快照链完整：
      before_targeted_revision（scope=pre_adoption_candidate，含 body-free Receipt）+
      adoption_previous + pipeline。选区外正文 100% 保持。
- [x] A2（大纲·整章重写单章 ×1）PASS：真实生成另一章 Final（穿越迷雾 1,990 字）
      → 采纳 → 定稿（F1 outbox completed）→ 编辑器整章重写 → 真实 LLM 重写
      （Receipt：physical=1，thinking ON，14,012/2,528 tokens）→ 确认应用 →
      toast"正文与故事记忆已更新" → 新正文 outbox 入队并 completed、冻结 trace
      保持 F1 事件（REVISION_DRIFT 按合同容忍）。真机发现并修复缺陷③：
      `createRevision` 内容去重把 before_whole_chapter_rewrite 审计快照短路
      （快照正文=刚采纳正文时 Receipt 永不落库）→ `skipContentDedupe` 选项；
      缺陷④：快照行遮蔽 Outline PostWriting 的 pipeline binding 查找 →
      `getLatestPipelineContentRevision` 过滤 source='pipeline'，RED→GREEN
      集成测试（`userRevisionPostWritingClosure.test.ts` 3/3）。修复后重定稿
      补齐新正文（3,177 字）outbox（真机验证）。
- [ ] A3（大纲 3 章批量 ×1）
- [ ] B1 / B2 / B3（原著续写三项）
- [ ] 证据汇总 + 文学质量校验 + 22 项负例映射 + Final Seal 数据表 + 最终报告

## 证据目录

`test-logs/phase4-iv13-final-*/`（只保留脱敏、body-free 证据：hash/fingerprint/range/
pass-fail/receipt scalar/token/latency/physical calls/violation code/memory-outbox
status/DB integrity/截图/UI hierarchy/脱敏 logcat）。

## 封板规则

全部验收 PASS 之前，本文件与最终报告保持
`PHASE IV FINAL SEAL HOLD / NO-GO`；任何正式样本首次失败保留证据，
Root Cause → 最小修正 → targeted regression → full checks → `adb install -r` →
重跑同一固定场景，不扩大分母。
