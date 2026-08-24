# TAVO-MINI 三期 A 轮方案
## 生成质量三级 + Writing Agent 基础身份收束

> 基线：当前远端 `main` / V2.21.1  
> 原则：不重构 ONE Kernel，不改变 ONE Context / ONE QA / ONE Memory 主架构。  
> 本轮目标：先把“怎么跑、依据什么事实跑、一次请求是谁”定义清楚，为后续提效打地基。

---

## 1. 本轮只做四件事

1. 冻结当前 Exact HEAD 基线；
2. 用户侧生成质量收束为「极速 / 标准 / 质量」三级；
3. 在现有 FrozenWritingContext 内增加 Chapter Truth Projection；
4. 为每次真实 LLM 请求建立可追溯 Request Receipt / Request Fingerprint。

本轮不做：
- QA + State Extraction 合并；
- Story Memory Delta；
- Segment Repair；
- 下一章预取；
- 新的 Agent Loop；
- 第二套 Context / Memory / Prompt Compiler。

---

## 2. A0：Exact HEAD 基线

先对当前代码做真实基线，不改生产逻辑。

至少验证：

- Outline：极速 / 当前平衡 / 当前质量，各 2 章；
- Continuation：极速 / 当前平衡 / 当前质量，各 2 章；
- `npm run verify` 全绿；
- Debug APK 构建；
- `adb install -r` 覆盖安装；
- 保留现有项目、LLM 配置和 App 数据。

记录：

- 每章 physical LLM calls；
- Draft / QA / Revision tokens；
- 总耗时；
- freezeFingerprint；
- QA Revision 触发；
- Finalize → Next Chapter Ready 耗时；
- 当前 PostWriting State Extraction 调用。

输出：

`docs/optimization/phase3-a-baseline.md`

Commit：

`test(writing): freeze phase3-a exact-head baseline`

---

## 3. A1：生成质量三级收束

用户侧只显示：

`极速 | 标准 | 质量`

### 极速

继承当前 One-Shot：

- 1 次 paid LLM call；
- 跳过 QA / Revision；
- 不允许 Formatter rescue；
- 不自动 Primary retry；
- 不减少 Canon / Outline / Seam / Story Memory / Writer Style 上下文。

### 标准

等价当前“平衡档”：

`Draft → ONE QA → Conditional Revision`

默认推荐。

### 质量

等价当前“质量档”：

`High-quality Draft → Strict ONE QA → Conditional High-quality Revision`

注意：

**质量档不增加新的 Stage。**

内部继续复用：

- `WritingExecutionProfile = standard | one_shot`
- `stageReasoning`
- `WritingStagePolicy`

只新增用户侧概念：

`GenerationQualityProfile = fast | standard | quality`

并在 Freeze 时把最终映射冻结。

历史任务：
- 不迁移；
- 按原 frozen policy Resume。

Commit：

`feat(writing): converge generation quality to fast standard quality`

---

## 4. A2：Chapter Truth Projection

目的：

让 Draft / QA / Revision 明确使用同一套冻结事实，不再靠各 Stage 自己理解。

在现有 `FrozenWritingContext` 内增加：

`ChapterTruthProjection`

至少包含指纹级关系：

- 当前章节 requirement / outline；
- Canon snapshot / hard facts；
- Source Boundary；
- 上一章正文 fingerprint；
- Seam / Anchor；
- Story Memory fingerprint；
- Structured Continuity State fingerprint；
- Writer Style fingerprint；
- source fingerprints。

原则：

- 它不是第二套 Context；
- 不重新做预算；
- 不重新查数据库；
- 不保存一份重复的大正文；
- 能从 FrozenWritingContext 重建；
- Freeze 后不可漂移。

增加 fail-closed 检查：

- Draft / QA / Revision 的 Truth fingerprint 必须一致；
- post-Freeze 禁止 live Canon / live Story Memory 注入。

Commit：

`feat(writing): add chapter truth projection to one frozen context`

---

## 5. A3：Request Receipt / Exact Request Identity

在现有：

- durable LLM attempt；
- WritingKernelTrace；
- Observability；
- generationTraceId；

基础上补充一次实际模型请求的统一身份。

每个请求至少记录：

- requestId；
- generationTraceId；
- stage；
- qualityProfile；
- executionProfile；
- provider / model；
- thinking / reasoningEffort；
- promptCompilerVersion；
- freezeFingerprint；
- truthProjectionFingerprint；
- stageProjectionFingerprint；
- messagesFingerprint；
- requestFingerprint；
- maxOutputTokens；
- responseFormat；
- usage；
- finishReason；
- outcome；
- result artifact reference。

要求：

> Model-visible request 必须可追溯、可诊断。

但不要把完整大型 Prompt 重新塞入单行 SQLite JSON。

若保存完整请求，只能采用：
- chunk；
- artifact reference；
- 或已有持久化载体。

Commit：

`feat(writing): add reconstructable request receipts`

---

## 6. A 轮验收

A 轮 GO 必须满足：

1. 极速 / 标准 / 质量 UI 和冻结语义正确；
2. 极速仍严格 1 paid call；
3. 标准、质量仍使用当前 Compact Standard DAG；
4. 三档 Canon / Outline / Seam / Story Memory / Writer Style 不缺失；
5. 旧 frozen task Resume 不改变；
6. Truth Projection 在 Draft / QA / Revision 间无漂移；
7. 每次 LLM request 都有唯一 Request Receipt；
8. `npm run verify` 全绿；
9. Android Debug 覆盖安装验证通过；
10. 不新增第二 Kernel / Context / Prompt Compiler / Memory。

A 轮完成后独立提交验收报告：

`docs/optimization/phase3-a-final-report.md`

只有 A 轮 GO，才进入 B 轮。
