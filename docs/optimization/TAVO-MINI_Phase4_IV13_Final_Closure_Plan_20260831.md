# TAVO-MINI Phase IV-13 Final Closure Plan（最后一轮收尾与最终封板方案）

日期：2026-08-31（Asia/Shanghai）
施工仓：`F:\ClaudeWorkSpace\projects\TAVO-MINI`
远端仓：`anjingdtl/tavo-mini`
状态：**PHASE IV FINAL SEAL HOLD / IN PROGRESS**

> 本文档是本轮收尾的 SSOT。本轮不含 Phase IV-13 前史的本地方案文档，以当前远端代码、
> `docs/optimization` 现有文档与 Git 历史为基线重新生成。全部真实验收完成前禁止写 GO。

## 1. 开工基线（实测记录）

| 项 | 值 |
| --- | --- |
| `origin/main` SHA | `8e27a87e7d6e86d8071087573b38145ceebc2b62` |
| 本地 HEAD SHA | `8e27a87e7d6e86d8071087573b38145ceebc2b62` |
| 当前分支 | `main`（与 origin 同步，无 ahead/behind） |
| git status | tracked 全部 clean；仅未跟踪文件（历史截图/db/日志/docs），一律保留 |
| 保护约束 | 禁止 `git reset --hard`、`git clean`、`adb uninstall`、`pm clear`；Android 只允许 `adb install -r` |

HEAD 提交 `8e27a87e feat(phase4): enforce final text and dual revision gates` 已包含 Phase IV-13
的代码面：共享 Plain-Text 合同、`targeted_revision` / `whole_chapter_rewrite` 双动作、
`UserRevisionModal`、body-free Receipt、`before_*` 快照与 Jest 回归。
上一轮进度（`phase4-iv13-progress.md` / `phase4-iv13-final-report-20260831.md`）结论为
`NO-GO / IN PROGRESS`：确定性检查全过，真实 Android 六项固定场景全部 PENDING，
且精准修订选区闭环（P0-1）尚未取得安装后 PASS 证据。

## 2. 本轮目标（只关闭三个产品闭环）

1. **A. Final Plain-Text Integrity**：高精度阻断协议污染，全写入边界 ONE 合同。
2. **B. Dual Revision**：精准修订 + 整章重写两个独立用户入口，均为 User-Initiated
   Post-Generation Action，各自恰好 1 次显式 LLM，Preview → 用户确认 → Persist。
3. **C. 最小真实 Android Final Seal**：固定小分母 6 场景真机验收 + 证据链。

正常主链保持 Freeze → Draft → ONE QA → optional Revision → FinalValidate → Persist
→ PostWriting / ONE Memory。禁止新增第二 Writer/QA/Context Builder/Memory/Prompt
Compiler、Literary Judge production stage、Agent Loop、hidden retry、自动 re-plan、
Formatter LLM、Governor 当前请求 Gate 或任何新正常生产 LLM Stage。Thinking Always On。

## 3. Pre-Test Corrections（正式测试前必须关闭的 5 项）

以下结论来自对本轮 HEAD 代码的实际通读（非旧印象）：

### P0-1 Android 精准修订选区闭环 —— 代码修复在位，缺安装后闭环证据

- `ChapterEditorScreen.tsx` 已有 `lastNonEmptySelectionRef` 最后非空 UTF-16 选区快照，
  Android 原生 action mode 吞掉 selection 时回退到该快照；切章时重置。
- 上轮真机仍复现"请先选择正文"，当时安装包未含修正后的闭环重测。
- **本轮动作**：CHECK-B 安装新 APK 后，先做真机 UI smoke：长按选正文 → 点精准修订 →
  Modal 打开 → 显示正确 selected range → selected text 与 UTF-16 start/end 对应。
  PASS 后才能开始 A1/B1 正式验收。禁止用自动填 offset 或测试后门代替真实选区。
- UTF-16 坐标统一 JS/RN `[start, end)`，覆盖中文、标点，保留 surrogate-pair/emoji 回归
  （`__tests__/userRevision.test.ts` 已有 surrogate 用例，保留）。

### P0-2 修订 Apply 后必须重新闭合 ONE Memory / PostWriting —— 确认存在缺口（本轮核心修正）

现状（实测）：
- `applyUserRevisionPreview` 只做 `createRevision` 快照 + `db.updateChapter(content=B)`，
  **没有触发任何 PostWriting / ONE Memory / Continuation State 闭环**。
- 大纲唯一 PostWriting 边界是编辑器"定稿"= `finalizeChapterMemory`（pipeline 绑定章节走
  `enqueueOutlineStoryMemoryPostWriting` outbox + `persistOutlinePostWritingClosure`）。
- 续写唯一等价闭环是 `finalizeContinuationChapter`（Final-Body State Proposals +
  `rebuild_story_memory` outbox，dedupe key 含 revisionHash）。
- 两者对"同一章、不同 fingerprint"都会抛 `WRITING_POST_WRITING_REVISION_DRIFT`
  （大纲在 `persistOutlinePostWritingClosure`，续写在 `closeContinuationPostWritingSnapshot`），
  因此修订后不能直接复用——这正是本轮要打通的点。

本轮最小修正（复用唯一闭环，不建第二 Memory）：
1. `applyUserRevisionPreview` 在 `db.updateChapter` 成功后自动调用既有闭环：
   outline → `finalizeChapterMemory(chapterId, { revisionAdvancedBody: true })`；
   continuation → `finalizeContinuationChapter({..., content: candidateBody, allowRevisionAdvancedBody: true })`。
2. 两条闭环在**显式声明 revision-advanced body** 时容忍 `REVISION_DRIFT`
   （冻结 trace 上的旧 body 事件是不可变历史；新正文 authority 由 fingerprint 键控的新
   outbox 行承载），outbox enqueue 失败仍然硬失败并回滚章节写入。
3. 幂等性：outbox dedupe key 均含正文 fingerprint → 同一新正文重复入队只产生一行；
   修订后重复 apply 被 `STALE_BASE` CAS 拒绝。duplicate outbox / duplicate state
   extraction = 0 由确定性测试断言。
4. 用户不再需要手动点"定稿"才更新 Memory——apply 成功即自动进入既有 PostWriting 闭环。

### P1-1 生成结果页双修订入口语义（Pre-Adoption Revision）—— 确认被采纳门槛挡住（本轮最小纠偏）

现状（实测）：
- `PipelineResultScreen`：`revisionReady = task.status === 'completed' && task.resolvedAction === 'accept'`。
- `ContinuationResultScreen`：`revisionReady = run.state === 'completed' && (completionReason === 'adopted' || finalizedRevisionHash)`。
- 两个结果页都**强迫用户先采纳才出现修订入口**，与"生成 Final Candidate → 阅读 →
  精准修订 / 整章重写 → 采纳"的目标语义不符。

本轮最小纠偏（两种 authority 共用同一 Service / Patch Contract / Preview UI，不复制 Writer）：
1. **Pre-Adoption Revision：base = 当前 Final Candidate Artifact**。
   - 大纲候选 = `pipeline_tasks.final_text`（采纳走 `adoptPipelineTaskResult`，
     它读取 `finalText` → Plain-Text 门 → 覆盖章节；所以修订候选 = CAS 更新 `final_text`，
     采纳自然采用修订后候选）。
   - 续写候选 = run 的最新 eligible artifact（`insertArtifact` 支持显式
     `eligibilityStatus`；新增修订 artifact 以 `stage='final'` + `parent=current final` +
     `eligible` 插入，`getLatestEligibleArtifact` 采纳时取最新 final）。
   - Frozen Truth 来源扩展：outline 用未要求 resolved-accept 的 completed task 上下文，
     continuation 用 `findLatestPendingReviewRunForChapter`（awaiting_user run，已存在）。
2. **Post-Adoption Revision：base = 当前 Chapter Body**（现有编辑器入口，保持不变）。
3. 结果页在未采纳状态直接打开共享 `UserRevisionModal`（candidate 模式）：
   - 整章重写：输入要求 → 1 次 LLM → Preview → Apply/Discard。
   - 精准修订：Modal 内展示候选正文选区框（multiline TextInput 承载候选，长按产生真实
     用户选区），选区 + 指令 → 1 次 LLM Patch → Preview → Apply/Discard。
     选区框内容与存储候选 fingerprint 不一致时拒绝生成（防手改漂移）。
4. Candidate Apply 规则：重新读取候选 → fingerprint CAS（stale 拒绝）→ Plain-Text 门 →
   写回候选 → `before_*` revision 快照（保存修订前候选，可恢复）→ body-free Receipt。
   不写章节正文、不触发 Memory 闭环（Memory 仍在采纳/定稿唯一边界）。
5. 用户点 Discard：候选零变化。LLM 等待期间候选变化 → Apply 前 CAS 拒绝并提示重新发起。

### P1-2 Plain-Text Gate 高精度 —— 契约在位，本轮补自然小说负例

- 共享合同 `plainTextNovelBody.ts` 覆盖 JSON wrapper / JSON-like protocol / Markdown
  fence / `<think>` reasoning / response schema / Patch JSON / prompt 前缀 / 协议字段 /
  duplicate title wrapper / 未闭合协议尾，全部 Hard Fail，不自动剥壳、不隐藏 retry。
- 精度原则：协议字段正则要求"行首 key + 冒号"的结构形态；prompt 前缀已要求
  冒号/换行分隔（上轮误杀已修）。
- **本轮动作**：新增自然小说负例（含中文对白冒号、省略号、书名号、行首英文单词、
  正文内 JSON 形态对白等），断言全部 `valid=true`；核对 duplicate title 只在
  "首行标题 + 前 4 行内重复标题"的结构形态才 Hard Fail。不做敏感词 Gate。

### P1-3 Receipt 模型记录与实际 wire 调用一致 —— 确认违规（本轮最小修正）

现状（实测）：`callUserRevisionOnce` 用 `resolveLLMRequestConfigById(frozenTruth.modelConfigId)`
解析**当前 live config** 发请求，Receipt 却写 `frozenTruth.modelName`（frozen）——
wire 用 live、账本写 frozen，正是禁止形态。

本轮选**方案 B**：User Revision 明确使用当前 revision model（按 frozen configId 解析
当前 config 的 live `model_name`/endpoint/凭据），Receipt 记录**真正 resolve 后**的
provider/model/config；新增 `providerType` 与 `frozenModelName` 字段（frozen 值仅作
绑定说明，不再冒充实际 wire 模型）。configId 被删时 fail-closed（请求失败，不回退）。
确定性测试断言"实际 model 与 Receipt model 一致"。

## 4. 正式合同要点（沿用并固化）

- **精准修订**：Selection Snapshot（chapterId/scenario/baseBodyFingerprint/selectionStart/
  selectionEnd/selectedTextFingerprint/instruction）；响应必须是唯一顶层 `{patches}` JSON；
  复用 Continuation Patch parser/validator/apply（不造第二 Patch Engine）；越界/重叠/
  stale/完整正文返回/选区外变化全部 REJECT；Unselected Text Preservation = 100%
  （前缀/后缀相等断言，不靠 prompt 自觉）；恰好 1 次物理请求，protocol fallback 或
  第二物理请求 fail-closed。
- **整章重写**：复用 Frozen Truth，1 次显式 LLM，输出纯小说正文，共享 Plain-Text 门；
  禁止重跑 Planner/QA/Revision/Context rebuild/Memory/Governor LLM。
- **Apply/Preview/Version**：Candidate → Preview → 用户确认 → Persist；Discard 零变化；
  Apply 前 CAS + `before_targeted_revision` / `before_whole_chapter_rewrite` 快照；
  Receipt body-free（无正文/prompt/reasoning/key）。
- **Final Plain-Text 全写入边界**：Outline FinalValidate / Persist / task final mutation /
  Outline adoption / Multi-chapter batch adoption / Continuation FinalValidate /
  durable persist / adoption / Whole-Rewrite apply / Targeted Revision candidate
  final-body validation；规则定义单点（ONE Shared Contract），调用点多点。

## 5. 正式真实 Android 验收矩阵（固定分母，不重跑 20 章）

| 场景 | 大纲 | 续写 |
| --- | --- | --- |
| 精准修订单章 ×1 | A1 | B1 |
| 整章重写单章 ×1 | A2 | B2 |
| 3 章批量 ×1 | A3（3/3 first-pass / product-valid / plain-text） | B3（同左 + canon/source hard violation=0） |

每个样本必须验证：physical call=1、Thinking ON、plain-text、（精准）选区外 100% 不变、
stale guard、Receipt body-free、PostWriting/ONE Memory 对新正文闭环、duplicate=0、
DB/UI/logcat 正常、no hidden retry；续写另加 Canon/Source/Seam/Style 保持。
文学质量按 Writer Style / Original Style Profile adherence 出 PASS/WARNING/FAIL。

## 6. 工程验证（每个修正执行）

PLAN → RED → DO → CHECK-A → CHECK-B → ACT → GO / NO-GO。

- CHECK-A：targeted Jest、`npm run typecheck`、`npm run lint -- --quiet`、
  `npm run verify:elastic`、`npm run verify:version`、`npm run verify`。
- CHECK-B：`npm run apk:debug`、APK SHA、`adb install -r`（禁止 uninstall / pm clear /
  清库重装）、真实 Android UI、真实 LLM、DB、Receipt、UI hierarchy/screenshot、logcat。
- 不得用 mock 结果代替真实 Android 业务矩阵。

## 7. 封板条件与状态

全部满足（Final Integrity PASS；A1/A2/A3、B1/B2/B3 全 PASS；Unselected 100%；
Out-of-range=0；Stale applied=0；JSON/protocol leakage=0；Revision Apply 后
PostWriting/ONE Memory/Continuation State 与新正文 authority 一致；Thinking Always On；
Governor physical=0；hidden retry=0；duplicate paid=0；unsafe outcome_unknown retry=0；
Canon/Source hard violation=0；typecheck/lint/verify 全套、APK、install -r、DB、Receipt、
UI、logcat 全 PASS）才允许写：

`PHASE IV FINAL SEALED / GO`

否则保持 **`PHASE IV FINAL SEAL HOLD / NO-GO`**，走 NO-GO → Root Cause → 最小修正 →
重测 → 继续。证据只入 `test-logs/phase4-iv13-final-*/`（脱敏、body-free）。
