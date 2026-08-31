# TAVO-MINI 三期 B 轮改造升级方案
## 生产闭环、结果可见性与单章热路径提效

> 项目本地路径：`E:\AiWorkSpace\tavo-mini`
> 建议方案落点：`E:\AiWorkSpace\tavo-mini\docs\optimization\TAVO-MINI_Phase3_B_生产闭环与体验提效_20260826.md`
> 前置条件：三期 A 轮已完成并封板。
> 当前架构原则：**Current-Pipeline-Only**，只维护当前唯一 Writing Pipeline；旧流水线任务不兼容，检测到旧版本直接 fail-closed，用户重新按当前流程执行。
> 本轮总目标：**在不减少 Canon / 大纲 / 原著资料 / Seam / Story Memory / Writer Style 的前提下，同时解决“用户看不到最终稿、看不懂 AI 改了什么、只看到 token、不知道有多少字、项目导入入口不清晰”与“标准/质量档调用成本偏高”这两类问题。**

---

# 0. B 轮定位

A 轮解决的是：

- ONE Kernel / ONE Context / ONE Prompt Compiler / ONE QA / ONE Memory；
- 极速 / 标准 / 质量三级；
- Chapter Truth Projection；
- Request Receipt / deterministic requestFingerprint；
- 当前唯一流水线；
- Legacy Pipeline 全量下线。

B 轮不再重构 Kernel。

B 轮只解决两件事：

1. **生产结果真正变成用户可理解、可阅读、可修改的“最终稿”。**
2. **压缩标准 / 质量档的单章 LLM 热路径。**

本轮完成后的理想用户心智：

```text
导入/新建项目
    ↓
生成章节
    ↓
看到最终稿
    ↓
知道 AI 改了哪些地方
    ↓
知道为什么改
    ↓
看到真实字数
    ↓
继续修改 / 继续生成
```

而不是：

```text
Draft
QA
Revision
Formatter
Fallback
Retry
Tokens
```

工程指标保留，但退到“详细信息 / 开发诊断”层。

---

# 1. B 轮硬约束

## 1.1 架构硬约束

必须继续保持：

- ONE Production Writing Entry；
- ONE Writing Kernel；
- ONE Context Planner；
- ONE Final Budget；
- ONE Freeze；
- ONE Prompt Compiler；
- ONE QA；
- ONE Story Memory；
- ONE WritingPersistedEvent；
- ONE Current Pipeline。

禁止：

- 新增第二 Writer；
- 新增第二 QA；
- 新增第二 Prompt Compiler；
- 新增第二 Context；
- 新增第二 Memory；
- 为“最终稿”额外增加 Final Writer LLM Stage；
- 恢复任何已删除 Legacy Pipeline；
- 为旧任务继续背兼容包袱。

## 1.2 质量硬约束

无论极速 / 标准 / 质量，以下事实不得因为提速而消失：

1. 当前章节要求 / 大纲；
2. Canon / 原著硬事实；
3. Source Boundary；
4. 上一章真实 Seam / Anchor；
5. Story Memory / Structured State；
6. Writer Style。

## 1.3 UX 硬约束

用户必须在 5 秒内能回答：

1. **我的最终稿在哪里？**
2. **AI 改了什么？**
3. **为什么改？**
4. **这章多少字？**
5. **下一步我能怎么继续？**

---

# 2. B0 — 项目导入入口恢复与统一

## 2.1 背景

仓库已具备：

- TXT 小说导入为可编辑项目；
- JSON 项目包导入；
- TXT 编码识别；
- TXT 自动分章；
- TXT LLM 智能分章；
- JSON 项目资源恢复。

问题不是能力不存在，而是**产品入口弱、用户心智不统一**。

本轮把“导入项目”提升为项目一级能力。

## 2.2 项目首页入口

项目页应明确提供：

```text
[＋ 新建项目]
[↓ 导入项目]
```

点击“导入项目”后：

```text
导入小说
TXT 小说 → 自动识别章节 → 创建可编辑项目

恢复项目
TAVO / ShineWriter JSON 项目包 → 恢复完整项目
```

不要要求普通用户理解：

- outline mode；
- continuation mode；
- package spec v1/v2/v3/v4。

用户只需要理解：

- TXT = 导入小说正文；
- JSON = 恢复 TAVO 项目。

## 2.3 TXT 导入体验

导入预览至少显示：

- 文件名 / 项目名；
- 编码；
- 识别章节数；
- 总字数；
- 前 5 个章节标题；
- 分章模式；
- 警告。

示例：

```text
《我的小说》

编码：GBK
识别章节：126
总字数：438,521 字

分章：
✓ 标准标题识别

预览：
第1章……
第2章……
第3章……

[确认导入]
```

## 2.4 TXT 大文件处理统一

当前项目 TXT 导入仍存在整篇 JS String + 20MB 上限。

续写 TXT 已有更成熟的 Streaming Decode / Normalize / Parse。

B0 要求：

- 尽量复用现有 Streaming Decoder / Normalizer / Parser；
- 项目 TXT 与续写 TXT 不维护两套完全独立的大文件解析逻辑；
- 不允许热路径因为大 TXT 再次 OOM；
- 保留安全 size guard；
- 不强求 B0 一次就支持任意超大文件，但要把架构统一到共享 Streaming 能力。

## 2.5 JSON 导入体验

JSON 导入显示：

```text
项目名
模式
章节数
资源数
是否包含：
- 大纲
- 人物
- 世界书
- 笔记
- 作家风格
- Continuation 数据
```

导入后直接进入新项目，不停留在技术日志页。

## 2.6 B0 验收

至少验证：

- UTF-8 TXT；
- GBK / GB18030 TXT；
- 标准章节标题；
- 序章 / 楔子 / 番外；
- 无标题整篇回退；
- LLM 智能分章；
- JSON v4 项目包；
- 导入后章节可编辑；
- 导入后可直接跑当前 Writing Pipeline；
- 导入失败整单回滚，不留下半项目。

Commit 建议：

`feat(project): restore first-class txt json project import`

---

# 3. B1 — Final Artifact：最终稿成为一等公民

## 3.1 当前问题

当前流水线内部有：

- Draft；
- QA；
- Revision；
- FinalValidate；
- Persist。

但用户侧没有一个明确、稳定、始终可阅读的：

**Final Artifact**

导致用户看到：

- 初稿；
- “修订成功”；
- tokens；
- Stage 状态；

却不知道最终正文到底是什么。

## 3.2 新增统一 Final Artifact

在当前 Kernel 产物模型上增加明确的：

```ts
FinalWritingArtifact
```

建议至少包含：

```ts
{
  chapterId,
  generationTraceId,
  qualityProfile,

  body,
  bodyFingerprint,

  sourceKind: 'draft' | 'revision' | 'segment_repair',
  revisionApplied: boolean,

  draftBodyFingerprint,
  finalBodyFingerprint,

  charCount,
  nonWhitespaceCharCount,
  paragraphCount,

  finalizedAt
}
```

注意：

- Final Artifact 是当前流水线最终结果的**稳定用户投影**；
- 不新增 LLM Stage；
- 不新增第二持久化真相；
- 最终正文仍以当前章节 persisted body 为 authority；
- Final Artifact 可由现有 Stage Artifact / Persisted Chapter 重建。

## 3.3 Final 生成规则

### QA Pass

```text
Draft
  ↓
QA Pass
  ↓
Final = Draft
```

0 次额外 LLM。

### QA Needs Revision

```text
Draft
  ↓
QA
  ↓
Revision / Segment Repair
  ↓
Final = Applied Result
```

### Revision No-op

如果 Revision 认为无需实际改写：

```text
Final = Draft
```

必须明确标记：

```text
revisionApplied = false
```

不要让 UI 显示“修订成功”却让用户误以为正文已经发生变化。

## 3.4 Final Artifact 必须在两个入口可见

- 大纲模式；
- 续写模式。

并且两者统一使用同一种 Final UI 语义。

Commit 建议：

`feat(writing): promote final artifact to first-class result`

---

# 4. B2 — Revision ChangeSet：让用户知道 AI 改了什么

## 4.1 核心目标

用户看到修订后，必须能看到：

- 改了哪里；
- 改前是什么；
- 改后是什么；
- 为什么改。

## 4.2 ChangeSet 数据结构

在 Revision 结果中增加结构化 ChangeSet。

建议：

```ts
type RevisionChange = {
  id: string;

  anchorId: string;
  changeType:
    | 'add'
    | 'delete'
    | 'rewrite'
    | 'wording'
    | 'logic'
    | 'canon'
    | 'continuity'
    | 'style';

  beforeText: string;
  afterText: string;

  reason: string;
  findingIds: string[];

  beforeFingerprint: string;
  afterFingerprint: string;
};
```

```ts
type RevisionChangeSet = {
  version: 1;
  draftFingerprint: string;
  finalFingerprint: string;
  changes: RevisionChange[];
};
```

## 4.3 ChangeSet 不允许成为第二正文

ChangeSet 是：

**Draft → Final 的解释投影**

不是正文 authority。

Final Body 才是最终正文。

## 4.4 UI

最终结果页显示：

```text
最终稿  4,826 字

AI 本次修改：8 处

[阅读最终稿]
[查看修改]
```

进入“查看修改”：

```text
修改 1 / 8

类型：人物一致性

修改前：
……

修改后：
……

原因：
上一章角色尚未知晓该信息，修正为符合当前知识状态。
```

## 4.5 如果没有发生修改

显示：

```text
AI 检查通过，本次未修改正文。
最终稿与初稿一致。
```

不要显示：

```text
修订完成
```

让用户误解成“AI 明明改了但不给我看”。

Commit 建议：

`feat(writing): expose revision changeset and final diff`

---

# 5. B3 — 字数优先，Token 退到详细信息

## 5.1 用户层主指标

小说用户主显示：

- 章节字数；
- 初稿字数；
- 最终稿字数；
- 修改增减字数；
- 段落数。

例如：

```text
最终稿：4,826 字
初稿：4,731 字
本次调整：+95 字
```

## 5.2 Token 仍保留

但放入：

```text
[生成详情]
```

内部显示：

- Draft input/output tokens；
- QA input/output tokens；
- Revision input/output tokens；
- physical calls；
- formatter；
- retry；
- latency；
- requestFingerprint。

默认用户页面不再把 Tokens 作为唯一指标。

## 5.3 字数规则

必须定义统一口径，例如：

```text
charCount = 去除空白后的 Unicode 字符数
```

或者另提供：

```text
总字符数
正文非空白字符数
```

但全 App 必须统一，不能一个页面按 JS length，一个页面按 tokens。

Commit 建议：

`feat(ui): make writing char count primary and tokens secondary`

---

# 6. B4 — 结果页重构：从流水线监控页变成作品结果页

## 6.1 页面优先级

当前“流水线结果”页改为：

### 第一层：作品

```text
第 18 章

最终稿
4,826 字

[阅读全文]
```

### 第二层：AI 修改

```text
本次生成：
初稿 4,731 字
最终稿 4,826 字
修改 8 处

[查看修改]
```

### 第三层：用户动作

```text
[编辑最终稿]
[继续写下一章]
[重新生成]
```

### 第四层：技术详情

折叠：

```text
生成详情
Draft ✓
QA ✓
Revision ✓
2 / 3 LLM calls
33,176 tokens
...
```

## 6.2 用户动作原则

至少支持：

- 阅读最终稿；
- 编辑最终稿；
- 查看修改；
- 重新生成；
- 继续下一章。

暂不要求做复杂的逐条 Accept / Reject。

B 轮先保证：

**Final 可见 + Diff 可见 + 可继续编辑。**

Commit 建议：

`feat(ui): rebuild writing result around final manuscript`

---

# 7. B5 — Evidence QA Projection

## 7.1 背景

当前 ONE QA 使用 Frozen Context 上较宽的 union projection。

B 轮进一步收缩成：

```text
Exact Draft
+
Chapter Truth Projection
+
Requirement Checklist
+
Relevant Evidence
```

## 7.2 Mandatory Truth 永不删除

Evidence QA 必须保留：

- 当前章节要求；
- Canon hard facts；
- Source Boundary；
- 上一章 Seam；
- Story Memory / Structured State；
- Writer Style hard constraints。

## 7.3 Relevant Evidence

只选择本章真正相关的：

- 人物；
- 世界书；
- Canon evidence；
- Story Memory facts；
- 当前资料。

## 7.4 Fail-safe

Evidence Resolver：

- 高置信 → Evidence Projection；
- 低置信 / 命中异常 → 回退当前 QA union projection。

禁止：

```text
为了省 token
→ 硬裁 Canon / Memory / Seam
```

## 7.5 目标

观测目标：

```text
QA input p50 ≈ Draft input p50 的 30% ~ 45%
```

不是硬 cap。

Commit 建议：

`perf(writing): project one qa onto exact evidence`

---

# 8. B6 — QA + State Proposal 合并

## 8.1 当前浪费

当前流程：

```text
Draft
→ QA
→ Revision
→ Persist
→ PostWriting State Extraction 再读一遍正文
```

Clean Standard 实际可能出现：

```text
Draft 1
QA 1
State Extraction 1
```

至少 3 个语义 LLM 请求。

## 8.2 目标

### Clean Standard / Quality

```text
Draft
→ QA + StateProposals
→ Final
```

总计：

```text
2 paid LLM calls
```

正常 PostWriting State LLM：

```text
0
```

## 8.3 QA 输出增加

QA JSON 增加：

```ts
stateProposals: [...]
```

每条包含：

```text
proposalType
subjectRefType
subjectRefId
payload
evidenceQuote
risk
```

禁止继续让模型手算 UTF-16 offset。

## 8.4 evidenceQuote 本地解析

客户端：

```text
evidenceQuote
→ 在 Final Body 中 exact match
→ 转 UTF-16 offset
```

规则：

- 0 match → reject；
- 1 match → accept；
- 多 match → ambiguous，reject / fallback。

## 8.5 Revision 情况

### Final == Draft

QA stateProposals 可继续使用。

### Final != Draft

QA proposals 必须失效。

Revision / Segment Repair 必须输出基于最终正文的：

```text
finalStateProposals
```

并要求：

```text
proposalSourceBodyFingerprint
==
finalBodyFingerprint
```

## 8.6 Shadow Mode

先保留 legacy `stateExtractionPrompt.ts` 双跑一段时间：

```text
QA/Revision proposals
vs
旧 State Extraction
```

只做对比，不写第二套长期记忆。

切换门禁：

- 重大事实漏提 = 0；
- Canon false accept = 0；
- future leakage = 0；
- evidence 错绑 = 0；
- body fingerprint mismatch = 0。

Commit 建议：

`feat(writing): shadow qa-derived state proposals`

切换后：

`perf(writing): cut over state extraction to qa revision output`

---

# 9. B7 — Anchored Segment Repair + Deterministic Final Assembly

## 9.1 目标

局部问题不再整章 Revision。

适用：

- 单句 Canon 错误；
- 人物知识错误；
- 局部时间线；
- 衔接问题；
- 若干段落措辞 / 信息补充。

## 9.2 Anchor

客户端为段落生成：

```text
anchorId
paragraphHash
range
```

QA finding 指向 Anchor。

## 9.3 Segment Repair 输出

模型返回：

```text
anchorId
replacementText
findingIds
reason
stateProposals
```

## 9.4 本地 Apply

客户端验证：

- anchor 存在；
- paragraph hash 未漂移；
- replacement 非空；
- 不包含协议泄漏；
- finding 已覆盖。

然后：

```text
Draft
+ Patch[]
→ Deterministic Assembly
→ Final
```

## 9.5 Full Revision 仍保留

只用于：

- 全章结构错；
- 主情节缺失；
- 大纲严重偏离；
- findings 跨大范围；
- 局部 Patch 会破坏整体因果。

Segment apply 失败：

```text
fallback → Full Revision
```

注意：

**Segment Repair 仍属于当前 Revision Stage。**

禁止新增：

```text
segmentRepairStage
```

Commit 建议：

`perf(writing): add anchored segment repair inside revision`

---

# 10. B8 — 三档最终调用目标

## 极速

```text
Draft
→ Local Final Gate
→ Final
```

目标：

```text
1 paid LLM call
```

不 QA，不 Revision，不 State Extraction LLM。

注意：

如果当前 PostWriting State Extraction 仍存在，B6 Cutover 后也应做到：

```text
正常 0 additional State LLM
```

若极速无 QA 无法产生 State Proposal，可保留独立的低成本本地 / 延迟策略，但不得偷偷让“极速 = 2+ paid calls”。

需要在 B 轮实施中明确设计并实测。

## 标准 Clean

```text
Draft 1
QA + State 1
Final
```

目标：

```text
2 paid calls
```

## 标准 Issue

```text
Draft
QA
Segment Repair
```

目标：

```text
3 paid calls
```

## 质量 Clean

```text
Quality Draft
Strict QA + State
```

目标：

```text
2 paid calls
```

## 质量 Issue

```text
Draft
QA
Repair
```

目标：

```text
≤ 3 paid calls
```

质量档禁止为了“质量”再增加第四个常规 Stage。

---

# 11. B9 — Observability 不另起炉灶

继续扩展现有：

- `writingChapterObservability`
- `writingObservabilityCollector`
- `writingPhysicalRequestAccounting`
- `writingTokenLedger`

新增观测：

```text
draftCharCount
finalCharCount
changeCount
segmentRepairCount
segmentRepairCoverage
qaInputToDraftInputRatio
stateProposalCount
stateFallbackCount
finalArtifactFingerprint
```

开发诊断可看完整工程指标。

普通用户只看：

```text
字数
修改处数
生成完成状态
```

---

# 12. B 轮实施顺序

严格按以下顺序，不允许全部一起改：

## B0
项目导入一级入口 + TXT/JSON 用户闭环

## B1
Final Artifact

## B2
Revision ChangeSet / Diff

## B3
字数优先 + 结果页 UX

## B4
Evidence QA

## B5
QA/State Shadow

## B6
QA/State Cutover

## B7
Segment Repair + Deterministic Assembly

## B8
最终性能/UX封板

每阶段：

```text
Red Test
→ 实现
→ targeted verify
→ Android 实测
→ PDCA
→ 独立 commit
```

NO-GO 不进入下一阶段。

---

# 13. Android 实测

必须：

```text
adb install -r
```

禁止：

```text
adb uninstall
pm clear
```

除非某个明确的 Clean Install 测试单独要求。

保留：

- 项目；
- LLM 配置；
- Writer Style；
- Canon；
- Story Memory；
- 用户已导入项目。

重点实测：

### 项目导入
- TXT；
- JSON；
- 导入后编辑。

### 最终稿
- QA Pass；
- Revision；
- Segment Repair；
- Final = Draft；
- Final != Draft。

### 用户体验
用户必须能直接看到：

```text
最终稿
字数
修改处数
```

而不是首先看到 Token Ledger。

---

# 14. B 轮真实 LLM 验收

至少：

## Outline

- 极速 ≥ 3 章；
- 标准 ≥ 5 章；
- 质量 ≥ 5 章。

## Continuation

- 极速 ≥ 3 章；
- 标准 ≥ 5 章；
- 质量 ≥ 5 章。

其中必须覆盖：

- QA Pass；
- QA needs_revision；
- Segment Repair；
- Full Revision fallback；
- Revision no-op；
- State Proposal；
- evidenceQuote ambiguity；
- Formatter fallback；
- Retry；
- 导入 TXT 项目后直接生成；
- JSON 项目包恢复后直接生成。

---

# 15. B 轮硬门禁

## 项目导入

- TXT / JSON 入口一级可见；
- TXT 导入后为可编辑项目；
- JSON 导入后为完整可编辑项目；
- 导入失败不留半项目；
- 大文件 TXT 不因整篇读入导致明显 OOM 回归。

## Final

- Final Artifact 完整率 = 100%；
- QA Pass 时 Final = Draft；
- Revision 后 Final 可阅读；
- Final Body Fingerprint 可追溯；
- 最终稿始终可见。

## Diff

- 实际修改发生时 ChangeSet 可解释；
- 无修改时明确显示“未修改正文”；
- before / after / reason 可展示。

## 字数

- 所有最终结果页显示字数；
- 字数统计规则统一；
- Token 默认退到详情页。

## 调用

- 极速主写作 = 1 paid call；
- Standard Clean = 2；
- Quality Clean = 2；
- Issue Path ≤ 3；
- 正常 PostWriting State LLM = 0。

## 一致性

- Canon hard conflict = 0；
- Source Boundary violation = 0；
- Seam loss = 0；
- Writer Style drift = 0；
- State Proposal body mismatch = 0；
- Segment Patch 锚点误应用 = 0。

## 架构

- 无第二 Kernel；
- 无第二 Context；
- 无第二 Prompt Compiler；
- 无第二 QA；
- 无第二 Memory；
- 无 Final Writer Stage；
- 无 Legacy Pipeline 回归。

---

# 16. 推荐 Commit 序列

```text
B0  feat(project): restore first-class txt json project import

B1  feat(writing): promote final artifact to first-class result

B2  feat(writing): expose revision changeset and final diff

B3  feat(ui): rebuild writing result around final manuscript
B3b feat(ui): make writing char count primary and tokens secondary

B4  perf(writing): project one qa onto exact evidence

B5A feat(writing): shadow qa-derived state proposals
B5B perf(writing): cut over state extraction to qa revision output

B6  perf(writing): add anchored segment repair inside revision

B7  docs(writing): seal phase3-b production loop and ux
```

---

# 17. 最终产物

B 轮完成后输出：

```text
docs/optimization/phase3-b-final-report.md
```

报告至少包含：

- Exact HEAD；
- Commit 序列；
- TXT / JSON 导入证据；
- Final Artifact 证据；
- Diff UI 证据；
- 字数 UI 证据；
- 三档真实 LLM 调用矩阵；
- Evidence QA Token 对比；
- State Extraction Cutover 数据；
- Segment Repair 数据；
- Android install-r 证据；
- full verify 数字；
- GO / NO-GO。

最终只有满足全部硬门禁时才标记：

```text
PHASE III-B FINAL SEALED / GO
```

否则继续 NO-GO。

---

# 18. 本轮最重要的产品结论

B 轮不是简单“省 Token”。

B 轮的真正目标是：

> **让用户从已有小说 / 项目开始，能直接进入可编辑项目；让 AI 生成的结果最终变成清晰可见的终稿；让用户知道 AI 改了什么、为什么改、现在多少字，并能继续编辑或继续写下一章；同时把标准 / 质量档单章热路径压缩到 2~3 次真实 LLM 调用。**

如果 B 轮完成，TAVO 的用户体验应该从：

```text
“我看到了一堆流水线状态，但不知道最终稿在哪。”
```

升级成：

```text
“我知道这一章现在是什么，AI 改了哪里，我可以直接继续写。”
```
