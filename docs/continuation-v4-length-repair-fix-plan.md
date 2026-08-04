# 续写 V4 流水线「目标字数不达标 + Repair 复制原文」修复方案

> 日期：2026-08-04
> 范围：Continuation V4 FULL-Control 流水线（`src/services/continuation/generation/`）
> 症状：
> 1. 续写生成配置目标章节字数设 3000，Writer 初稿经常只有 1000+ 汉字；
> 2. Checker / Control 已检出问题，但 Repair 经常直接复制 Writer 原文，未按问题精准修订。
>
> 目标（用户确认）：**在保持文学质量的前提下**，让 Writer 输出落在目标字数的 **±30%** 区间内（如 3000 → 2100–3900 汉字）。字数弱提示是当时为消除"硬字数指标导致注水、可读性严重下降"而做的有意改动（commit `1bb39e9`「V4 创作松绑」），本方案**不回滚松绑**，而是寻找"硬指标注水"与"弱提示无后果"之间的中间路径。
>
> 硬性约束（用户确认）：**每次 run 的 LLM 物理请求总数仍控制在 4 次以内**（Writer / Checker / Control / Repair 各一次，与现状一致），不引入自动重试。

---

## 1. 结论摘要（TL;DR）

**两个问题都不是"字数被当成 token"造成的，而是 V4「创作松绑」改造（见 `docs/tavo-mini-v4-creative-loosening-redesign.md`）把字数和 Repair 约束力削弱过度：**

- **问题 1（字数不达标）**：目标字数在代码里始终按**汉字数**处理（`continuationLengthContract.ts` 的 `countHanCharacters`），没有 token/字数混淆。真正原因是 V4「创作松绑」改造把字数从提示到验收全程解除：
  - V4 Writer 提示词把目标字数降级为「弱提示」，明确告诉模型"不是必须机械达到的硬指标""可自然长于或短于参考篇幅"（`continuationV4PromptCompiler.ts:27-47`）；
  - 字数偏差的本地确定性检查被全程降级：`softenFinalGateLengthChecks` 把 `chapter_length_*` 从 error 降为 warning（`continuationV4Runner.ts:1064`），`isHardLocalSafetyIssue` 明确排除长度问题（`continuationV4Runner.ts:647`），即**长度不足永远不会触发 Repair**；
  - Repair 提示词明确写着"不得为了接近参考字数增加或删除内容"（`continuationV4PromptCompiler.ts:340-341`）；
  - 所以"设 3000 出 1000"在全链路中**没有任何一环会认为这是个需要修复的问题**。
  - 历史背景：松绑前是硬约束（"最低合格线未达到前不得结束章节"），导致模型为凑字数注水、文学质量下降，commit `1bb39e9` 因此改为弱提示。当前问题是弱提示矫枉过正——**从"硬指标"直接跳到"无指标"，丢掉了中间档**。
- **问题 2（Repair 复制原文）**：Repair 只有**一次**物理请求机会（V4 四请求硬上限，`reservePhysicalStage`，`continuationV4Runner.ts:1396`）。当 Repair 模型偷懒返回原文时：
  - 客户端能检测到（`noMeaningfulChange` 判定、`repair_checker_issue_unchanged` / `repair_control_style_unchanged` 合规检查），但检测到之后的动作是**拒绝候选、保留 Writer 初稿、run 进入 `awaiting_user`**（`continuationV4Runner.ts:2118-2160`、`2486-2490`），**不重试**；
  - 用户最终看到的就是 Writer 原文，表现为"Repair 直接复制了原文"。
- 另外发现一个**明确的代码 bug**：`renderStyleFinding` 中 `generatedExcerpt` 三元表达式两个分支都是 `undefined`（`continuationV4PromptCompiler.ts:268-271`），导致 Control 文风问题交给 Repair 时**永远不携带命中原文片段**，Repair 只能拿到 UTF-16 offset 数字，无法精准定位，这是"不能精准按发现的问题修订"的直接原因之一。

---

## 2. 问题 1 详细根因：目标字数为何失效

### 2.1 字数单位没有问题

`continuationLengthContract.ts`：
- `resolveContinuationLengthContract(targetChapterChars)` 把用户设置直接当作**目标汉字数**（3000 → target 3000 / min 2500 / max 3500，容差 ±500）；
- `countHanCharacters` 按 Unicode 码点统计 CJK 汉字，不含标点、空白、数字、拉丁字母。

token 只在**输出预算**侧出现：`continuationV4Budget.ts:163-164` 用 `estimatedTokensPerHan = 3`（`contextAutomationPolicy.ts:88`）把目标汉字数换算成 token 需求。3000 字 → demand 9000 token、minimum 6480 token（覆盖率 0.72）。预算是保守放大而不是缩小，**预算侧通常不会把输出卡到 1000 字**（除非用户把该 LLM 配置的 `max_output_tokens` 填得很小，例如 2048/4096，见 2.3）。

### 2.2 真正根因：提示词松绑 + 全链路零强制

| 环节 | 现状 | 位置 |
|---|---|---|
| Writer system | 「参考篇幅（弱提示）」：明确"不是必须机械达到的硬指标""可自然长短"，并罗列禁止凑字数的负面清单 | `continuationV4PromptCompiler.ts:27-35` |
| Writer user 末尾 | 再次强调"可自然长短；情节完整…优先于凑字数" | `continuationV4PromptCompiler.ts:37-47` |
| Checker | 被禁止报告字数问题（`isCheckerForbiddenSubtype` 排除 `chapter_length_*`） | `continuationV4Runner.ts:657-659` |
| 本地确定性检查 | `chapter_length_under_target` 仍会生成（severity=error），但描述里写明"V4 下篇幅仅作提示" | `continuationChecker.ts:131-145` |
| Local Final Gate | `softenFinalGateLengthChecks` 把长度检查降为 warning | `continuationV4Runner.ts:1064-1073` |
| Repair 触发条件 | `isHardLocalSafetyIssue` 排除长度；`isRepairableCheckerIssue` 排除长度 | `continuationV4Runner.ts:647`、`continuationChecker.ts:54-56` |
| Repair 提示词 | "参考篇幅…不是修订任务。不得为了接近参考字数增加或删除内容" | `continuationV4PromptCompiler.ts:340-341` |

即：**从 Writer 到 Repair，没有任何一环会要求把 1000 字扩到 3000 字。** 模型在"弱提示 + 无后果"下自然选择省力输出。

对比：松绑前的硬约束版本（commit `1bb39e9` 之前）写法是「【Writer 本次汉字产出硬目标】…在 content 未达到最低合格线前不得结束章节」。该写法消除了短章，但把"字数达标"变成了模型的第一优先级，直接引发注水（重复心理、环境堆砌、无信息对白），正是松绑要解决的问题。**本方案不走回这个写法。**

另外，当前长度契约的容差是固定 ±500 汉字（`CONTINUATION_LENGTH_TOLERANCE_HAN = 500`）：对 3000 字目标相当于 ±16.7%，比用户期望的 ±30% 更紧；对 1000 字目标又相当于 ±50%，过松。容差需要按比例化。

### 2.3 次要因素（建议一并排查）

- **用户 LLM 配置的 `max_output_tokens`**：`maximumOutputTokens = min(declaredMaxOutputTokens, contextWindow × 0.2, available)`（`continuationV4Budget.ts:267-271`）。若配置里 max_output_tokens 只有 2048~4096， Writer 物理上写不到 3000 字。需要确认用户配置。
- **Writer 无截断检测**：V4 `runWriterNode` 不检查 `finishReason === 'length'`（旧链路有明确报错，`continuationGenerationRunner.ts:1028`），JSON 被截断时只会抛"不是合法 JSON"，而不是"输出预算不足"。
- **JSON envelope 开销**：Writer 要求单个 JSON object 输出（plan + content），换行转义、引号转义都会吃 token，进一步压缩可用正文体量。

---

## 3. 问题 2 详细根因：Repair 为何复制原文

### 3.1 端到端流程与失效点

```
Checker/Control 检出问题（repairReady）
  → runRepairNode 组装提示词（含问题清单 + 完整原文）
  → 仅 1 次物理请求（4 请求硬上限）
  → parseContinuationV4RepairEnvelope
  → 三层验收：
     a) noMeaningfulChange：候选==原文 → 拒绝
     b) validateContinuationV4RepairCompliance：回填 id 缺失 / 问题原句仍在 → blocking
     c) runContinuationV4LocalFinalGate + evaluateRepairCompleteness
  → 任一失败 → finalizeContinuationV4Repair(eligibilityStatus='rejected')
  → run 进入 awaiting_user，Writer 初稿保持为最新 eligible 候选
  → 用户在结果界面看到的就是 Writer 原文   ← 症状
```

关键代码事实：

1. **只有一次机会，失败不重试**。`reservePhysicalStage` 在已有 4 次物理请求后直接 throw（`continuationV4Runner.ts:1396-1398`）；Repair 被拒后 `runV4Pipeline` 直接 return（`2486-2490`），注释写明"Writer remains the latest eligible artifact"。
2. **「未改动」检测是纯文本级别的**：`noMeaningfulChange` 只做去空白后相等比较（`677-679`、`2042-2044`）；`repair_checker_issue_unchanged` 要求 `excerpt.length >= 4` 且原句在候选中完整存在（`750-765`）——模型只需对命中句做同义微调（甚至只改标点以外的几个字）即可绕过，而整章其余部分原样复制。
3. **Control 问题丢失定位片段（代码 bug）**：`renderStyleFinding` 的 `generatedExcerpt` 两个分支都是 `undefined`（`continuationV4PromptCompiler.ts:268-271`）。Repair 收到的文风任务只有 `generatedStart/End` 数字 + rewriteGoal，**没有原文片段**。模型无法把 offset 映射到正文，只能瞎改或不改。`repairReady` 判定还用 `styleEvidenceIds ?? ['x']` 占位（同文件 282 行附近），进一步稀释任务可信度。
4. **Repair 提示词任务密度过高**：单个 system prompt 同时塞入 Checker 五维 JSON + Control findings JSON + 报告摘要 + 长度禁令 + 冻结 Canon/状态 + 输出协议六字段，user 里再贴整章原文。对长章（3000+ 字）这很容易让模型"读不完任务"，退化为复述原文 + 回填 id。
5. **回填 id 即可部分蒙混**：`validateContinuationV4RepairCompliance` 对 Checker issue 有原句在位检测，但对「问题不在 excerpt 里、描述较宽泛」的 issue 只检查 id 是否回填；`unappliedItems` 非空会 blocking，但模型只要不回填 unappliedItems 且不触发原句检测就能过。

### 3.2 为什么用户感知是"直接复制原文"

三种常见路径最终都呈现为原文：

- Repair 模型原样返回 → `repair_candidate_unchanged` 拒绝 → 保留 Writer 原文；
- Repair 微调但问题原句仍在 → `repair_checker_issue_unchanged` / `repair_control_style_unchanged` → 拒绝 → 保留 Writer 原文；
- Repair 抛错/超时/JSON 不合法 → catch 分支保留 Writer 原文（`continuationV4Runner.ts:2212-2240`）。

UI 上 Repair 阶段显示失败/拒绝，正文仍是 Writer 初稿——用户的描述完全吻合。

---

## 4. 修复方案

总原则：**质量优先的字数收敛，且 4 次请求上限不动**——不回滚创作松绑、不恢复"未达最低线不得结束"的硬指标写法、不增加物理请求；把「目标篇幅」从"无后果的弱提示"升级为"**有比例区间（±30%）、有节奏引导、有质量护栏的软目标**"，把 Repair 从"一次定生死"升级为"**一次做足**：统一任务清单 + 锚点定位 + 失败诊断透出"。

核心设计取舍（针对"强提示导致注水"的历史教训）：

| 手段 | 旧硬约束（已弃用） | 本方案 |
|---|---|---|
| 提示词 | "未达最低合格线前不得结束章节" → 字数是最高优先级，必然注水 | "目标体量 ±30% 区间 + 按节拍分配篇幅 + 深化优先于收束" → 字数是节奏参考，质量是验收线 |
| 不达标处理 | 强制继续写 → 模型原地注水 | 定向扩写 Repair：只深化既有场景，且由 Control 的 padding/ai_template 维度做**质量闸**——扩写出注水照样被拒 |
| 验收标准 | 单一字数线 | 字数区间（宽）+ 质量指标（严），两者都过才算完成 |

### P0-0：长度契约容差从固定 ±500 改为比例 ±30%

文件：`continuationLengthContract.ts`

- `CONTINUATION_LENGTH_TOLERANCE_HAN = 500` 是固定值，对不同目标字数尺度不一致。改为 `resolveContinuationLengthContract` 内按比例计算：`tolerance = round(target × 0.3)`（如 3000 → 2100–3900；1000 → 700–1300；8000 → 5600–10400）。
- 影响面：`evaluateContinuationLength`、Writer/Repair 提示词中的区间展示、本地确定性检查的上下限描述，全部自动跟随，无需逐处改文案。
- 兼容性：该契约同时被旧标准链路（`continuationPromptCompiler.ts`）引用，旧链路的硬约束文案会同步变宽——可接受，或给旧链路单独保留固定容差（评估后决定）。
- 配套单测：边界值（1000/3000/8000）的 min/max 断言。

### P0-1：修复 `renderStyleFinding` 的 generatedExcerpt bug

文件：`continuationV4PromptCompiler.ts:261-288`

- 把 `generatedExcerpt` 的两个 `undefined` 分支改为：优先用 finding 自带的 excerpt 字段；否则用 `generatedStart/End` 从 `artifactText` 切片（需要把 artifactText 传入或在上层预切片）。
- 同时把 `styleEvidenceIds ?? ['x']` 占位改为空数组 + 在 repairReady 判定里如实反映（缺证据则不为 repairReady）。
- 配套单测：构造带 offset 的 finding，断言 Repair prompt 中包含命中原文片段。

### P0-2：Writer 长度提示升级为「比例软目标 + 节拍篇幅分配 + 深化引导」

文件：`continuationV4PromptCompiler.ts` 的 `writerLengthSoftHint` / `writerLengthTailReminder`

这是"质量不降、字数收敛"的关键杠杆。**短章的根因往往是 pacing 失控**——模型把节拍快速过完就收尾，而不是不会写长。方案：

1. **区间化软目标**：删除"可自然长于或短于参考篇幅"这类免写许可，改为：「本章目标体量约 N 个汉字，正常落区间 M–K（±30%）。低于下限通常意味着场景展开不足，而非情节已经讲完。」不给"硬指标/不合格"字眼，但也不给"随便短"的许可。
2. **节拍篇幅预算（防提前收束的结构性手段）**：Writer 的 plan 里有 beats，在提示词中要求"规划时为每个 beat 标注预期篇幅量（合计 ≈ N），写作时按预算展开每个节拍再推进到下一个"。这让长度目标转化为**节奏分配**，模型不需要在最后硬凑，从机制上避免注水。
3. **深化优先的正向清单**（替代单纯的负面禁令）：「若正文明显低于下限，优先深化已有场景：动作的过程与后果、对话的回合与潜台词、人物的即时反应、关键情绪的铺陈、冲突的升级阶梯——而不是提前收束、新增支线或复述设定。」保留原有的注水负面清单不变。
4. user 末尾自查改为：「输出前自查：正文是否落在 M–K 区间；若低于 M，是哪个节拍被压缩了？回到该节拍深化，而不是加结尾感言。」

### P0-3：建立「篇幅不足 → 定向深化扩写」闭环，并以 Control 质量维度作闸

现状是长度问题被所有触发条件排除。按以下方式恢复闭环，同时**用质量指标锁住注水**：

1. `continuationChecker.ts`：`chapter_length_under_target` 保留为本地确定性检查（不依赖 LLM），**仅当实际汉字数 < target×0.7** 时升级为可执行项；落在 ±30% 区间内则完全不产生检查项。
2. `continuationV4Runner.ts`：
   - `isHardLocalSafetyIssue` 不动；新增 `isLengthExpansionIssue(subtype)` 允许 `chapter_length_under_target` 触发 Repair（`chapter_length_over_target` 不触发——超长不强制压缩，符合松绑原则）；
   - `shouldRepair` 条件加入长度扩写项。
3. `continuationV4PromptCompiler.ts` 的 Repair 编译：当任务清单含篇幅扩写时，注入**定向深化扩写指令**（替代现在的"不得为接近参考字数增删内容"）：
   - 给出当前汉字数、目标区间、缺口数；
   - 要求"只在既有场景与既有节拍内深化：动作过程、对话回合、人物反应、感官细节、冲突升级阶梯；禁止新增人物/设定/情节线；禁止摘要式扩写、禁止复述前文、禁止为每个段落平均加水"；
   - 同时把 Writer 的 beats 篇幅预算一并给 Repair，让它知道该深化哪个节拍。
   - **与 Checker/Control 任务共用同一次 Repair 请求**：扩写任务并入统一的可执行清单（见 P1-1），不增加请求数。若本次只有长度问题，Repair 的任务清单就是纯扩写。
4. **质量闸（防注水回潮）**：扩写后的候选照常过 Control 文风审查，其中 `padding`、`ai_template`、`description_density` 维度天然能识别注水；`runContinuationV4LocalFinalGate` 的 `self_duplicate` 检测兜底重复退化。扩写候选若触发这些质量项 → 按现有机制拒绝。**即：字数不达标会触发扩写，但扩写注水了一样过不了。**
5. 合规侧：`validateContinuationV4RepairCompliance` 对长度任务验证 `candidateHan > writerHan` 且候选汉字数进入 target×0.7 以上，而不是回填 id 即过。
6. `repairCompletenessPolicy.ts`：对"扩写型 Repair"把新增段落视为 targeted（扩写天然会改动较多段落），避免误判 `repair_non_minimal_rewrite`；`minCandidateToWriterHanRatio` 等坍缩阈值不变。

### P1-1：单次 Repair 内做足任务（坚守 4 次请求上限，不加自动重试）

用户约束：**每次 run 的 LLM 物理请求总数仍 ≤ 4**（Writer / Checker / Control / Repair 各一次）。因此放弃"Repair 失败自动重试第二轮"的思路（那会需要第 5 次请求），改为把唯一一次 Repair 的成功率做足：

1. **统一可执行清单**：把 Checker 五维问题、Control 文风 finding、长度扩写任务（P0-3）合并成一个编号任务表放进 Repair 提示词，一次请求处理全部，不拆分、不追加请求。
2. **锚点注入（原 P1-2 提升为本项核心）**：组装 Repair user 消息时，对带 offset 的问题在原文中注入**行内锚点标记**（如 `⟦ISSUE_3_START⟧…⟦ISSUE_3_END⟧`），让模型直接看到要改哪里，而不是自己数 UTF-16 offset。终稿解析时客户端剥离锚点并校验；`localGateExtraIssues` 增加锚点残留检测（blocking）。问题清单按"必须先改"排序，每项给出：锚点编号、命中原文、问题描述、建议修法、必须保留的语义点——比现在的纯 JSON dump 更可执行。
3. **修复 P0-1 的 excerpt bug** 是前置依赖：没有命中片段，单次 Repair 必然继续"盲改或复制"。
4. **失败时的去向（不自动重试）**：Repair 被拒后保持现有行为（保留 Writer 初稿、run 进入 `awaiting_user`），但把失败原因结构化透出到结果界面——具体是哪些 issue 未落实、哪个质量闸没过——由用户决定是否以该 run 为基础**手动发起一次新的修复动作**（新动作算用户主动触发的新请求，不违反自动流水线 ≤4 次的约束）。

`reservePhysicalStage` 的 4 请求硬上限、telemetry `maxPhysicalRequests: 4` 均保持不变。

### P1-3：Writer 截断与预算诊断

- `runWriterNode` 检查 `result.finishReason === 'length'`：报错信息明确指出"输出被 max_tokens 截断，请提高该模型 max_output_tokens 或降低目标字数"，与旧链路对齐。
- 结果界面/日志透出 `budget.maximumOutputTokens` 与 `declaredMaxOutputTokens`，让用户能发现"我目标 3000 字但模型配置只给 2048 token"这类配置问题。

### P2：验收与回归

- 单测：
  - 长度契约比例容差：1000/3000/8000 目标的 min/max 边界（P0-0）；
  - `renderStyleFinding` 携带 excerpt（P0-1）；
  - Writer 提示词包含 ±30% 区间与节拍篇幅预算文案（P0-2）；
  - 长度扩写触发条件：`chapter_length_under_target` 在 ±30% 区间内不触发、低于 0.7×target 触发；扩写任务与其他问题合并进同一次 Repair 清单（P0-3 + P1-1）；
  - 锚点注入/剥离往返一致、锚点残留被门禁拦截（P1-1）；
  - **请求数回归：构造各类 run（无问题/仅长度/仅 Checker/混合），断言物理请求总数 ≤ 4**（P1-1）。
- 覆盖率门禁：`continuationV4Runner.ts`、`continuationV4PromptCompiler.ts` 属于 `services/**` 高阈值区域，新增分支需补测试。
- 手工回归：目标 3000 字，验证 Writer 初稿落在 2100–3900（±30%）区间的比例；构造 Checker 命中问题，验证 Repair 终稿中问题原句消失且全文完整；抽读扩写后的章节，确认无注水感（对照 Control 的 padding/ai_template 维度报告）。

---

## 5. 涉及文件清单

| 文件 | 改动 |
|---|---|
| `src/services/continuation/generation/continuationLengthContract.ts` | P0-0 容差比例化（±30%） |
| `src/services/continuation/generation/continuationV4PromptCompiler.ts` | P0-1 excerpt bug；P0-2 Writer 长度文案与节拍预算；P0-3 Repair 扩写指令；P1-1 统一任务清单与锚点格式 |
| `src/services/continuation/generation/continuationV4Runner.ts` | P0-3 触发条件；P1-1 失败诊断透出（4 请求上限不变）；P1-3 finishReason 检测 |
| `src/services/continuation/generation/continuationChecker.ts` | P0-3 长度检查分级 |
| `src/services/continuation/generation/repairCompletenessPolicy.ts` | P0-3 扩写型 Repair 的阈值豁免 |
| `src/services/continuation/generation/continuationControl.ts` | P0-1 配套（finding excerpt 字段贯通） |
| `__tests__/` | 上述各项单测 |

## 6. 风险与取舍

- **与创作松绑方向的冲突**：P0-2/P0-3 重新让字数影响流程，已按"比例区间（宽）+ 质量闸（严）"设计——字数只决定"要不要深化"，Control 的 padding/ai_template/description_density 维度决定"深化得能不能过"。若实测仍出现注水回潮，第一调节点是 P0-3 的触发阈值（如从 0.7 降到 0.6），而不是放宽质量闸。
- **请求成本**：无变化。所有修复都在现有 4 次物理请求（Writer/Checker/Control/Repair）内完成；P2 有专门的 ≤4 请求回归测试守住这条线。
- **锚点方案**依赖模型不把锚点符号带进终稿，需要本地剥离 + 残留检测兜底；若锚点残留率高，可退回"问题清单带原文片段"的无锚点模式（P0-1 修复后该模式也已可用）。
- **单次 Repair 的固有上限**：不加重试意味着 Repair 模型严重失常时仍会保留初稿；缓解手段是 P1-1 的失败诊断透出 + 用户手动再修复入口。
