# TAVO-MINI Phase IV-13 建设方案
## Final Integrity + Dual Revision Final Seal
### 最终稿完整性、精准修订、整章重写与双场景封板

> 版本：Phase IV-13 v1.0  
> 日期：2026-08-31  
> 当前施工仓：`E:\AiWorkSpace\tavo-mini`  
> 远端仓：`anjingdtl/tavo-mini`  
> Agent 开工时必须先 `git fetch`，核验真实 `origin/main`、本地 `HEAD` 与工作区状态，以实际远端为准。  

---

# 0. 本轮定位

Phase IV 主体已经完成：

- Gate 减法；
- JSON Contract 瘦身；
- Governor 旁路化；
- Mandatory + Elastic Context；
- Persistence / Resume / Idempotency；
- Thinking Always On；
- Reasoning / Final Channel 分离；
- Draft Completion Boundary；
- Writer Style SSOT；
- Fast / Standard / Quality 同题验证；
- 原著续写 20 章真实生产长测。

当前仍存在两个需要在最终封板前完成的产品闭环：

1. **Final Plain-Text Integrity**
   - 真实长测发现过 JSON-like wrapper 被 QA / FinalValidate 放行并最终持久化；
   - 最终稿必须保证为合法小说正文，协议包装不得进入最终正文。

2. **Dual Revision**
   - 用户需要两种明确不同的修订入口：
     - 精准修订：只修改用户选中的局部范围；
     - 整章重写：保持事实与约束，重新生成整章表达。

本轮目标不是继续重构 Writing Pipeline，而是完成：

> **最终稿必须可安全交付；生成结果必须支持用户可控、可回退、可验证的两种 AI 修订方式。**

---

# 1. 总体架构原则

## 1.1 正常写作主链保持不变

继续保持：

```text
Freeze
→ Draft
→ ONE QA
→ optional Revision
→ FinalValidate
→ Persist
→ PostWriting / Memory
```

禁止为了本轮功能增加：

- 第二 Writer；
- 第二 QA；
- 第二 Context Builder；
- 第二 Memory；
- 第二 Prompt Compiler；
- Agent Loop；
- hidden retry；
- 自动 re-plan；
- 新的正常生产 LLM Stage。

## 1.2 Dual Revision 不属于正常 Pipeline

两种修订都定义为：

```text
User-Initiated Post-Generation Action
```

不属于：

```text
Production Writing Pipeline Stage
```

也不改变已有的 First-Pass 统计口径。

用户主动修订是一次新的显式用户操作，必须独立计账。

## 1.3 两个入口长期并存

最终稿页面和章节编辑器应明确提供：

```text
[精准修订]    [整章重写]
```

用户心智：

```text
只对局部不满意
→ 精准修订

整章整体不满意
→ 整章重写
```

不得合并成一个模糊的“AI 修改”入口让模型猜测修改范围。

---

# 2. IV-13A — Final Plain-Text Integrity

## 2.1 背景

原著续写 20 章真实长测中出现：

```text
Writer output
→ QA clean/pass
→ FinalValidate success
→ Persist success
→ 最终正文仍保留 JSON-like wrapper
```

这是 Final Candidate / Persistence Boundary 的真实漏检。

## 2.2 目标

建立统一的最终正文交付合同：

# Plain-Text Novel Body Contract

正常最终正文必须：

- 是纯小说正文；
- 非空；
- 非截断；
- 非 reasoning；
- 非 JSON object / array wrapper；
- 非 Markdown code fence；
- 非 response schema；
- 非协议字段；
- 非模型说明文字；
- 非“以下是正文”等包装；
- 不出现明显错误的重复章节标题包装。

## 2.3 Root Cause First

禁止直接写：

```text
如果像 JSON，就把 content 字段剥出来
```

必须先定位真实来源属于：

- Writer Prompt Contract；
- Provider Adapter；
- response_format；
- reasoning/final channel extraction；
- Final Candidate normalization；
- Persist boundary。

只有证据确认后才能做最小修正。

## 2.4 Fail-Closed

最终应形成：

```text
Final Candidate
↓
Plain-Text Novel Body Contract
↓
PASS
  → Persist
FAIL
  → 不持久化为 Final
```

不得：

- silent retry；
- hidden second LLM；
- 自动重写；
- Formatter LLM。

如可以本地无歧义规范化，例如明确、稳定、协议定义内的合法 adapter wrapper，必须有专门测试并记录来源。

---

# 3. IV-13B — Shared Dual Revision Contract

两种修订共享：

- Final Artifact；
- Chapter ID；
- Scenario；
- Frozen Truth Projection；
- Body Fingerprint；
- User Instruction；
- Preview；
- User Confirm / Discard；
- Revision History；
- Physical Call Accounting。

建议统一领域对象：

```ts
type UserRevisionKind =
  | 'targeted_revision'
  | 'whole_chapter_rewrite';
```

不得建立第二正文 authority。

章节正文仍是唯一持久化 authority。

---

# 4. 精准修订 Targeted Revision

## 4.1 使用场景

例如：

- 只改两句对白；
- 一段更含蓄；
- 增加一点环境描写；
- 修改最后一小段收束；
- 降低 AI 腔；
- 保持剧情，只调整局部表达。

## 4.2 用户流程

```text
Final / Chapter Editor
↓
用户选中文字
↓
精准修订
↓
填写要求
↓
1 × LLM
↓
JSON Patch[]
↓
Local Validate
↓
Diff Preview
↓
用户应用 / 放弃
```

## 4.3 Selection Snapshot

发起修订时冻结：

```ts
{
  chapterId,
  scenario,
  baseBodyFingerprint,
  selectionStart,
  selectionEnd,
  selectedTextFingerprint,
  instruction
}
```

offset 必须沿用当前 React Native / JS 字符串语义：

```text
UTF-16 半开区间 [start, end)
```

## 4.4 核心原则

# Read Context 可以宽，Write Scope 必须窄

模型可以读取：

```text
选区前文
选区
选区后文
当前章节目标
Mandatory Truth
Writer Style
Character / Worldbook
Story Memory
```

原著续写还可以读取：

```text
Canon
Source Boundary
Character State / Knowledge
Seam / Anchor
Original Style Profile
Continuation Plan
```

但模型写权限只能在：

```text
selectionStart ~ selectionEnd
```

## 4.5 输出合同

只能输出局部 Patch：

```json
{
  "patches": [
    {
      "start": 1200,
      "end": 1450,
      "replacement": "修订后的连续小说正文"
    }
  ]
}
```

禁止返回：

- 完整章节；
- 修改建议；
- Markdown；
- reasoning；
- 说明文字。

## 4.6 复用现有 Continuation Patch Engine

优先复用 / 抽象当前已有：

```text
parseRepairPatches
validateRepairPatches
validateRepairPatchCoverage
applyParsedRepairPatches
UTF-16 offset
non-overlap validation
paragraph insertion boundary
```

不得为大纲精准修订再造一套平行 Patch Engine。

应形成共享底层 Patch Contract。

## 4.7 Range Hard Guard

必须验证：

```text
patch.start >= selectionStart
patch.end <= selectionEnd
```

任何越界：

```text
REJECT
```

关键硬指标：

```text
Unselected Text Preservation = 100%
Out-of-Range Patch Accepted = 0
```

“其他部分不要修改”不能只靠 Prompt。

## 4.8 Stale Patch Protection

LLM 返回后必须重新检查：

```text
currentBodyFingerprint === baseBodyFingerprint
```

如果用户等待期间手动修改正文：

```text
禁止直接应用旧 Patch
```

提示重新选择修订范围。

不得模糊重定位旧 offset 后自动套用。

## 4.9 Preview First

精准修订不得自动覆盖正文。

必须：

```text
生成 Patch
↓
Validate
↓
Candidate
↓
局部 Diff Preview
↓
用户确认
↓
Apply
```

用户放弃时：

```text
正文零变化
```

应用前应保留可恢复版本 / revision history。

---

# 5. 整章重写 Whole-Chapter Rewrite

## 5.1 使用场景

例如：

- 这一章整体节奏不对；
- 保持剧情但整体更克制；
- 对白太多，重新组织；
- 保留事实和结尾，重新写一版；
- 风格整体重写。

## 5.2 用户流程

```text
Final
↓
整章重写
↓
填写整章要求
↓
复用当前 Frozen Truth
↓
1 × LLM
↓
完整新章节
↓
Plain-Text Validate
↓
Whole-Chapter Preview
↓
用户应用 / 放弃
```

## 5.3 不重新跑完整 Pipeline

整章重写不是：

```text
Planner
→ Draft
→ QA
→ Revision
```

正常情况下只执行一次显式 Whole-Chapter Rewrite 请求。

如果用户要求：

```text
剧情也重新规划
```

那属于“重新生成章节 / 重新规划”，不是本功能。

## 5.4 输出合同

整章重写只能返回：

```text
纯小说正文
```

不能返回：

- Patch；
- JSON wrapper；
- Markdown；
- 说明；
- reasoning。

最终必须经过与正常 Final 相同的：

```text
Plain-Text Novel Body Contract
```

## 5.5 大纲创作约束

整章重写继续保持：

```text
Outline
Mandatory Truth
Character
Worldbook
Story Memory
Writer Style
Ending Boundary
```

优先级：

```text
Mandatory Truth / Outline Hard Boundary
>
User Rewrite Instruction
>
Style Preference
```

## 5.6 原著续写约束

还必须保持：

```text
Source Boundary
Canon
Character State
Character Knowledge
Seam / Anchor
Original Style Profile
Story Memory
Continuation Plan
```

不能因为用户要求“更刺激”就引入原著事实冲突或 Future Source Leakage。

---

# 6. UI 目标

## 6.1 Final 页面

统一显示：

```text
最终稿  3,826 字

[精准修订]    [整章重写]

[采纳 / 保存]
```

## 6.2 精准修订

用户先选择文本。

弹出：

```text
已选择 126 字

希望怎么修改？
[____________________________]

本次只允许修改选中文字。

[取消]    [生成修订]
```

返回后显示：

```text
修改前
……

修改后
……

选区外正文：保持不变

[放弃]    [应用修改]
```

## 6.3 整章重写

显示：

```text
整章重写

希望怎么调整这一章？
[____________________________]

事实、大纲、人物状态与 Writer Style 硬约束仍保持。

[取消]    [生成新版本]
```

返回后：

```text
原稿
新版本

[放弃]    [应用新版本]
```

原稿必须可追溯。

---

# 7. 大纲创作验收矩阵

本轮不做大规模重复长测。

只执行：

## 7.1 单章精准修订 ×1

步骤：

```text
正常生成 1 章
→ 得到 Final
→ 选择一段
→ 精准修订
→ Preview
→ Apply
```

必须验证：

```text
精准修订成功
physical call = 1
Patch 合法
选区外正文 100% 不变
base fingerprint 正确
Writer Style 保持
Outline / Character / Worldbook / Story Memory 无硬冲突
无 hidden retry
```

## 7.2 单章整章重写 ×1

步骤：

```text
正常生成 1 章
→ Final
→ 整章重写
→ Preview
→ Apply
```

验证：

```text
physical call = 1
确实发生实质重写
Final 为纯小说正文
无 JSON wrapper
无协议泄漏
Mandatory Truth 保持
Outline 保持
Writer Style 保持
原稿可恢复 / 可追溯
```

## 7.3 三章批量写作 ×1

正常执行：

```text
3 章批量大纲创作
```

要求：

```text
3/3 E2E First-Pass
3/3 Product-valid Final
3/3 Plain-text Final
Thinking ON
Governor physical call = 0
hidden retry = 0
duplicate Persist = 0
Writer Style 正常
```

---

# 8. 原著续写验收矩阵

## 8.1 单章精准修订 ×1

步骤：

```text
正常续写 1 章
→ Final
→ 选择局部正文
→ 精准修订
→ Preview
→ Apply
```

必须验证：

```text
physical call = 1
选区外正文 100% 不变
Canon 不冲突
Source Boundary 不突破
Future Source Leakage = 0
Character Knowledge 不越界
Seam / Anchor 不被破坏
Original Style Profile 保持
stale patch protection PASS
```

## 8.2 单章整章重写 ×1

步骤：

```text
正常续写 1 章
→ Final
→ 整章重写
→ Preview
→ Apply
```

必须验证：

```text
physical call = 1
纯小说正文
JSON/protocol leakage = 0
Canon 保持
Source Boundary 保持
Character State 保持
Continuation Plan 保持
Original Style Profile 保持
原稿可追溯
```

## 8.3 三章批量续写 ×1

执行：

```text
连续续写 3 章
```

要求：

```text
3/3 E2E First-Pass
3/3 Product-valid Final
3/3 Plain-text Final
Hard Canon Violation = 0
Future Source Leakage = 0
Source Boundary Violation = 0
duplicate paid = 0
hidden retry = 0
Story Memory / PostWriting 正常闭环
```

---

# 9. 本轮最终真实测试总量

固定为：

```text
大纲创作：
- 单章精准修订 1
- 单章整章重写 1
- 3章批量 1批

原著续写：
- 单章精准修订 1
- 单章整章重写 1
- 3章批量 1批
```

不再要求：

- 20 章重跑；
- Wilson CI；
- 大规模盲评；
- 跨 20 章趋势分析。

本轮目标是针对新增能力和真实 blocker 做精准回归。

---

# 10. 测试必须覆盖的负例

除真实 Android 正向测试外，至少用 deterministic / unit / integration 测试覆盖：

1. 越界 Patch；
2. overlap Patch；
3. malformed JSON；
4. empty replacement；
5. stale baseBodyFingerprint；
6. stale selectedTextFingerprint；
7. UTF-16 / surrogate pair offset；
8. 多段文本选择；
9. App force-stop 后旧 Patch 不得错误应用；
10. 整章重写返回 JSON wrapper；
11. 整章重写返回 Markdown fence；
12. Final 返回协议字段；
13. 精准修订返回完整章节而非 Patch；
14. 用户取消 Preview；
15. 用户应用 Preview。

---

# 11. KPI

## 11.1 精准修订

必须记录：

```text
TargetedRevisionSuccess
PhysicalCalls
PatchCount
PatchContractValid
OutOfRangeRejected
BaseConflictDetected
SelectedRangeChanged
UnselectedTextPreserved
Latency
Tokens
UserApplied / UserDiscarded
```

硬指标：

```text
大纲精准修订 = 1/1 PASS
续写精准修订 = 1/1 PASS
Unselected Text Preservation = 100%
Out-of-range accepted = 0
Stale patch incorrectly applied = 0
Physical Call = 1/action
```

## 11.2 整章重写

必须记录：

```text
WholeChapterRewriteSuccess
PhysicalCalls
PlainTextValid
BodyChanged
MandatoryTruthPass
StylePass
CanonPass（continuation）
SourceBoundaryPass（continuation）
Latency
Tokens
UserApplied / UserDiscarded
```

硬指标：

```text
大纲整章重写 = 1/1 PASS
续写整章重写 = 1/1 PASS
Physical Call = 1/action
Plain-text Final = 100%
JSON/protocol leakage = 0
```

## 11.3 批量写作

要求：

```text
大纲 3/3
续写 3/3

E2E First-Pass = 6/6
Product-valid Final = 6/6
Plain-text Final = 6/6
```

---

# 12. P0 Safety

全程保持：

```text
Thinking Always On
Governor physical call = 0
Mandatory Truth intact
outcome_unknown 不自动 retry
duplicate paid call = 0
hidden retry = 0
Canon / Story Memory pollution = 0
DB integrity = ok
Resume / Idempotency 不退化
```

Android：

```text
只允许 adb install -r
禁止 uninstall
禁止 pm clear
```

---

# 13. Strict PDCA

每个 IV-13 子阶段执行：

```text
PLAN
→ RED
→ DO
→ CHECK-A
→ CHECK-B
→ ACT
→ GO / NO-GO
```

其中：

## IV-13A
Final Plain-Text Integrity RCA / 修复

## IV-13B
Shared Dual Revision Contract

## IV-13C
大纲：
1 精准 + 1 整章 + 3 章批量

## IV-13D
续写：
1 精准 + 1 整章 + 3 章批量

## IV-13E
Engineering / Android / Evidence / Final Seal

发现问题：

```text
NO-GO
→ 保存失败证据
→ Root Cause
→ 最小修正
→ 重跑该阶段
```

不得为了测试通过扩大改造范围。

---

# 14. 工程验收

最终至少执行：

```text
targeted tests
typecheck
lint -- --quiet
verify:elastic
full verify
APK debug build
adb install -r
Android real flow
DB integrity
Receipt
UI
logcat
```

如本轮生产 Prompt / Final Contract / Patch Engine 有变化，必须保留 RED→GREEN 测试。

---

# 15. Evidence

提交：

```text
docs/optimization/phase4-iv13-progress.md
docs/optimization/phase4-iv13-final-report-YYYYMMDD.md
```

可提交 body-free JSON：

```text
phase4-iv13-evidence.json
```

允许：

- fingerprint；
- range；
- patch count；
- pass/fail；
- token；
- latency；
- physical calls；
- violation category；
- body changed boolean；
- outside-range-preserved boolean。

禁止提交：

- API Key；
- Authorization；
- 完整 Prompt；
- reasoning 原文；
- 完整小说正文；
- 巨型 SQLite。

---

# 16. Final Seal

只有以下全部满足：

```text
Final Plain-Text Integrity PASS

AND

大纲精准修订 1/1 PASS
大纲整章重写 1/1 PASS
大纲批量 3/3 PASS

AND

续写精准修订 1/1 PASS
续写整章重写 1/1 PASS
续写批量 3/3 PASS

AND

Unselected Text Preservation = 100%
Out-of-range accepted = 0
Stale patch applied = 0
JSON/protocol leakage = 0

AND

Thinking / Governor / Canon / Memory / Paid Call Safety PASS

AND

Engineering / APK / Android / DB / Receipt PASS
```

才允许：

# `PHASE IV FINAL SEALED / GO`

否则：

```text
PHASE IV FINAL SEAL HOLD / NO-GO
```

---

# 17. 最终产品闭环

Phase IV 封板后的正常用户流程应为：

```text
生成章节
↓
自动检查 / 修订
↓
得到合法 Final
↓
用户阅读
├─ 只对局部不满意
│    ↓
│  精准修订
│    ↓
│  Patch + Diff + Confirm
│
└─ 整章不满意
     ↓
   整章重写
     ↓
   Full Rewrite + Preview + Confirm
↓
保存
↓
继续下一章
```

最终原则：

> **生成结果必须合法可用；局部修订必须真正局部；整章重写必须真正整章；两者都由用户显式控制，不让系统替用户猜。**
