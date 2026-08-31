# TAVO-MINI Phase III-C 建设方案
## 长篇持续生产与稳定性封板

> 文档版本：2026-08-28
> 本地施工基线：`E:\AiWorkSpace\tavo-mini`
> 建议落点：`E:\AiWorkSpace\tavo-mini\docs\optimization\TAVO-MINI_Phase3_C_长篇持续生产与稳定性封板_20260828.md`
> 编写时远端 B 轮封板基线：`c9bd25a66b768e3dae2df9c56a88debb1d10f292`。开工时必须重新 `git fetch` 并记录 `origin/main` Exact HEAD。
> 本轮定位：**把 TAVO 从“稳定写好一章”升级成“稳定持续写完整本小说”。**

---

# 0. C 轮总定义

Phase III-A 已解决统一架构；Phase III-B 已完成单章生产闭环、Final Artifact、Revision Diff、字数优先、TXT/JSON 项目导入、Final-body State Proposal、Segment Repair、Writer Issue Path ≤3 physical calls、弹性 maxTokens、结构化输出 fail-closed 与 Android 覆盖安装验收。

Phase III-C 不再以“继续减少几个 Token”为中心，正式修订为：

> **长篇持续生产与稳定性封板：让当前唯一 Writing Pipeline 在连续几十至上百章节的生产过程中，保持 Canon、人物状态、Story Memory、Seam、Writer Style 与 Source Boundary 一致；控制全链路 LLM 调用和上下文增长；支持当前 Pipeline 的可靠恢复、严格幂等与安全预取；同时保持普通用户 UI 简洁。**

```text
A轮：架构正确
B轮：一章可用
C轮：整本书可持续
```

---

# 1. C 轮 P0 产品原则：后台更强，前台不能更复杂

TAVO 面向普通小说作者，不是 Pipeline 调试器。

C 轮即使新增 Memory Delta、Durable Resume、Exact Memoization、N+1 Prefetch、Long-Horizon Audit、Total Paid LLM Budget、Book Production Envelope 等后台能力，也不得机械翻译成新的一级页面、新的一级导航、新的工程型按钮。

普通用户主流程继续保持：

```text
项目
  ↓
章节
  ↓
写作 / 继续写
  ↓
最终稿
  ↓
查看修改 / 编辑 / 下一章
```

## UI Complexity Gate

必须满足：

- 一级导航数量不得因 C 轮增加；
- 项目 → 写作 → 最终稿的核心点击步骤不得增加；
- 不新增“为了后台模块而存在”的主按钮；
- `Memory Delta / Fingerprint / Prefetch / Receipt / Outbox / Stage / Budget` 不进入普通用户主界面；
- 技术信息只放“生成详情 / 开发诊断”；
- 能自动恢复则只显示“继续上次写作”；
- Memory Merge / Prefetch invalidation 等成功路径默认无感；
- 只有真正需要用户决策的冲突才弹普通语言提示；
- 新增页面/弹窗必须回答“普通小说用户为什么需要看到它”，否则不得新增。

**产品判断：用户感觉更稳定、更快、更省事，而不是感觉软件更复杂。**

---

# 2. 架构硬约束

必须继续保持：

```text
ONE Production Writing Entry
ONE Writing Kernel
ONE Context
ONE Prompt Compiler
ONE QA
ONE Story Memory
ONE WritingPersistedEvent
ONE Current Pipeline
```

禁止：

- 第二 Writer / 第二 Context / 第二 Prompt Compiler / 第二 QA / 第二长期 Memory；
- Final Writer / Long-Horizon Writer；
- 第二 Narrative Pipeline；
- 恢复已删除 Legacy Pipeline；
- 模糊缓存替代 Frozen Context；
- 为提速删除 Canon / Boundary / Seam / Story Memory / Writer Style；
- Prefetch 绕过 Freeze；
- Resume 时用 live truth 覆盖已冻结任务。

Current-Pipeline-Only 继续成立：旧 Pipeline fail-closed；但**当前 Pipeline 必须具备 durable resume / idempotency**。

---

# 3. C0-A — Model Capability Single Source of Truth

## 3.1 P0 回归

当前用户可见：

```text
上下文自动化配置：1,000,000 tokens
LLM 设置 context_window：65,536
```

这会让普通用户误以为 1M 已真正生效，也会污染后续 20/50/100 章压力测试基线。

**C0-A 未 GO 前禁止开始正式 Long-Horizon Baseline。**

## 3.2 唯一权威

模型能力持久化 authority 继续只有：

```text
llm_config.context_window
llm_config.max_output_tokens
```

规则：

```text
context_window
→ 当前模型唯一上下文长度真相

max_output_tokens
→ 0 = AUTO / unknown
→ 正数 = 用户明确配置的模型真实输出能力
```

“上下文自动化配置”不得继续保存第二套会让用户误以为生效的运行能力。

## 3.3 双向同步

Auto Context → LLM Config：

```text
1M → 一键应用
→ active LLM config.context_window = 1_000_000
```

然后自动上下文页、LLM设置页、App重启后、新 Writing Freeze、Receipt / Frozen Model / Provider dispatch 必须一致。

LLM Config → Auto Context：

```text
context_window = 262144
→ 自动上下文页立即显示 262144
```

模型切换：

```text
Model A = 1M
Model B = 128K
Model C = 32K
```

切换 active model 后显示对应模型自己的能力，不能残留前一模型 Preview。

## 3.4 Freeze 稳定性

```text
已冻结任务 → 保持原 FrozenStageModelConfig
新任务     → 使用最新已保存 Model Capability
```

禁止配置修改污染运行中任务。

## 3.5 max_output_tokens 继续 AUTO

若：

```text
context_window = 1_000_000
max_output_tokens = 0
```

数据库继续保存 `0`，不要把运行时 20% 等派生值写回。

运行时统一：

```text
providerCapabilities
+ context_window
+ 模型真实 max output（若声明）
+ available context
+ stage demand
→ elastic reservation
```

## 3.6 UI 收敛

普通用户页只保留类似：

```text
上下文长度
当前模型：GLM-5.3-Flash

自动
128K
200K
512K
1M

[保存]
```

说明：

> 上下文越大，可供 AI 参考的小说资料越多。系统会自动分配写作、检查和记忆所需空间。

`V3 分层弹性预算 / Story State / Recent Bridge / QA Board / policy hash / reservation / 模拟窗口` 等工程概念移入开发诊断。

## 3.7 验收

必须真实验证：

- 65,536 → 1M；
- Auto → LLM 设置同步；
- LLM 设置 → Auto 同步；
- App restart；
- model switch；
- active model 一致；
- new Freeze 使用新值；
- old Frozen run 不漂移；
- Receipt / Frozen Model / Provider request capability 一致；
- `max_output_tokens=0` 不被写回派生值；
- `npm run verify:elastic` PASS；
- 生产 `callLLM/callLLMResult` 无固定数字第二参数。

建议 commit：

`fix(llm): unify model capability as single source of truth`

---

# 4. C0-B — 项目列表：章节数、字数、批量管理

## 4.1 项目卡片

无论大纲创作或原著续写，每个项目卡片直接显示：

```text
《项目名》
大纲创作
63 章 · 24.8 万字
最后编辑：今天 14:32
```

或：

```text
《项目名》
原著续写
41 章 · 16.2 万字
最后编辑：昨天 21:10
```

## 4.2 字数统一口径

> **项目正文总字数 = 当前项目所有可编辑章节已保存正文的非空白 Unicode 字符数总和。**

不统计 Outline、Canon、原著参考资料、Worldbook、Characters、Notes、Story Memory、Prompt、Revision Diff、Context、Metadata。

全 App 复用同一个计数 service，不允许不同页面各算各的。

## 4.3 禁止列表页扫描所有正文

禁止：

```text
打开项目列表
→ SELECT 全部 chapter body
→ JS 全量遍历计数
```

必须使用轻量项目统计投影，例如：

```ts
ProjectWritingStats {
  projectId
  chapterCount
  bodyCharCount
  updatedAt
}
```

或复用已有合适结构。

章节新建、正文保存、Finalize、删除、TXT 导入、JSON 恢复时增量更新；migration / repair 使用 deterministic rebuild。

## 4.4 批量管理

项目页只增加简单入口：

```text
[＋新建] [↓导入] [批量管理]
```

选择状态：

```text
☐ 项目A
☑ 项目B
☑ 项目C

已选择 2 个

[导出] [删除]
```

支持全选/取消，不新增“项目管理中心”一级页面。

## 4.5 批量导出

第一版只做完整项目导出，复用现有 TAVO / ShineWriter JSON project package。

多项目：

```text
ShineWriter-Projects-YYYYMMDD.zip
  项目A.json
  项目B.json
  项目C.json
```

要求：

- 不创建第二套项目包协议；
- 单项目失败可明确指出；
- 不生成半截 JSON；
- 不导出 API key / credential；
- 每个项目包可重新导入并编辑；
- 大项目避免巨型 CursorWindow。

## 4.6 批量删除

普通用户提示：

```text
删除 4 个项目？

删除后将同时移除这些项目的章节和相关资料。
删除后无法恢复，请先导出需要保留的项目。

[取消] [删除]
```

工程要求：

- 使用 transaction / 当前 Repository 能力；
- project-scoped 数据正确级联；
- 失败不能 UI 假装全部成功；
- 不遗留 orphan chapter / run / mapping / outbox；
- 正在执行写作任务的项目 fail-safe；
- App 被杀后能判断操作状态。

建议 commits：

```text
feat(project): show chapter and word counts on project cards
feat(project): add simple batch export and delete
```

---

# 5. C0-C — UI Complexity Gate

C0 完成后做一次专门 UI 审核：

```text
一级导航新增 = 0
核心写作步骤增加 = 0
默认展开技术信息增加 = 0
后台模块要求用户维护的新开关 = 0（原则）
```

允许新增：项目卡片字数、批量管理、简化后的上下文长度配置、真正需要用户决定的恢复/冲突提示。

禁止新增：Memory Delta 页面、Prefetch 页面、Memoization 页面、Pipeline Resume 控制台、Book Production Envelope 主页面、普通用户 Long-Horizon Dashboard。

---

# 6. C1 — Long-Horizon Baseline：先测再优化

正式后端优化前建立真实基线：

```text
5章 Smoke
20章 Stability
50章 Long Run
100章 Stress
```

每章至少记录：

```text
chapterIndex
generationTraceId
qualityProfile
Writer Physical Calls
Total Paid LLM Calls
Draft/QA/Revision tokens
Planner calls
Observer calls
Story Memory calls
Context input tokens
Final char count
Story Memory size
DB payload size
Final fingerprint
Seam fingerprint
Canon boundary
State proposal count
retry/fallback
latency
```

持续检查：

- Canon hard conflict；
- Source Boundary；
- future leakage；
- Seam；
- 人物知识状态；
- 人物位置/生死/关系；
- 世界规则；
- Timeline；
- Writer Style；
- Story Memory through position；
- Final-body proposal fingerprint。

**必须先用当前 HEAD 跑真实基线，再开始 Memory Delta / Memoization / Prefetch。**

建议 commit：

`test(longrun): establish phase3-c long-horizon baseline`

---

# 7. C2 — Story Memory Durable Delta

目标：

```text
ONE Story Memory
+
Final-body Memory Delta
→ Deterministic Merge
→ Current Story Memory
```

Delta 只是 ONE Story Memory 的增量写入格式，不是第二长期 Memory。

权威链：

```text
Final Artifact
→ Final-body State Proposal
→ Validated Memory Delta
→ Deterministic Merge
→ ONE Story Memory
```

禁止 Draft / QA old body / live current chapter 直接写 Delta。

建议结构应适配现有 Memory Schema，不得另造平行 truth：

```ts
StoryMemoryDelta {
  version
  projectId
  chapterId
  sourceFinalFingerprint
  throughPosition
  additions
  updates
  removals
  relationshipChanges
  knowledgeChanges
  timelineChanges
  evidence
  createdAt
}
```

Merge 必须：

- sourceFinalFingerprint 匹配；
- through position 连续；
- 不越未来；
- 同 chapter delta 幂等；
- conflict fail-closed；
- Merge 失败保留 last clean Story Memory；
- crash 后可重放未完成 Delta；
- 不生成无限增长的单行巨型 JSON。

验收必须比较 20 / 50 / 100 章的 Memory size、更新 token、耗时曲线，要求更新成本趋于稳定，不随总章节数无界线性增长。

建议 commit：

`perf(memory): add durable final-body story memory delta`

---

# 8. C3 — Current-Pipeline Durable Resume + Idempotency

目标场景：

```text
写到第37章
App被杀 / Android进程回收 / 网络中断 / Provider超时 / 手机重启
→ Current Pipeline 安全继续
```

Resume 必须：

- 不用 live Context 覆盖 frozen truth；
- 不重复 Persist 已完成 Stage；
- 不重复 Finalize；
- 不重复 State Proposal apply；
- 不重复 Memory Delta merge；
- 不重复付费发送已成功 exact request。

关键 identity：

```text
generationTraceId
requestFingerprint
stage
attempt identity
finalFingerprint
memoryDelta identity
persist event identity
```

Persist / Merge / Outbox 必须做到：

```text
same identity
→ exactly-once observable effect
```

真实 Android 恢复矩阵至少覆盖：

- Draft 后杀 App；
- QA 后杀 App；
- Revision 后杀 App；
- Finalize 前杀 App；
- Persist 后 UI 未刷新时杀 App；
- Memory Delta merge 前杀 App；
- network failure；
- Provider 5xx / timeout；
- Android restart。

建议 commit：

`feat(pipeline): harden current-pipeline durable resume and idempotency`

---

# 9. C4 — End-to-End Paid LLM Budget

B 轮只封了：

```text
Writer Physical Calls
```

C 轮新增整章：

```text
Total Paid LLM Calls
```

统计：

- Planner；
- Draft；
- QA；
- Revision；
- Observer；
- Story Memory；
- Memory Delta；
- 其他 paid model request。

必须同时报告：

```text
writerPhysicalCalls
totalPaidLlmCalls
```

禁止把辅助请求藏在“不是 Writer”里。

C1 先测 baseline，再优化。目标是 Clean / Issue 的总调用不随章节数增长，Observer / Memory 不无条件每章重复昂贵全量读取，retry / protocol fallback / rejected usage 全部如实计账。

普通用户 UI 不显示这些明细，继续折叠在“生成详情”。

建议 commit：

`feat(observability): account end-to-end chapter paid llm budget`

---

# 10. C5 — Exact Successful Request Memoization

只允许 Exact，不允许 semantic similarity。

仅当以下全部一致：

```text
Frozen Context
messages
model
provider adapter
thinking
reasoningEffort
maxOutputTokens
outputContract
stage contract
requestFingerprint
```

且历史 Artifact：

```text
success
valid contract
compatible current pipeline
```

才允许复用。

任何 Canon / Outline / Boundary / Seam / Story Memory / Writer Style / Model / Reasoning / capacity / compiler version / stage contract 改变都必须 miss。

诊断层记录：

```text
memoizationHit
sourceRequestFingerprint
sourceArtifactFingerprint
savedPhysicalCalls
```

普通用户无按钮。

建议 commit：

`perf(writing): reuse exact successful request artifacts safely`

---

# 11. C6 — Safe N+1 Static Prefetch

只允许预取静态准备：

- N+1 Outline；
- Canon projection candidates；
- Source candidate index；
- token estimate；
- immutable resource metadata。

禁止提前生成 Draft / QA / Story Memory，禁止在 N 未 Finalize 前冻结 N+1 dynamic truth。

```text
N章运行
→ 预取N+1静态资料
→ N章Finalize
→ 校验Seam/Memory/State/Canon
→ 仍有效则复用，否则invalidate
```

Prefetch 失败不能阻断正常写作。

建议 commit：

`perf(context): add invalidation-safe n-plus-one static prefetch`

---

# 12. C7 — Long-Horizon Consistency Audit

不是第二 QA，不进入正文改写 Pipeline。

生产仍然：

```text
Draft
→ ONE QA
→ Conditional Revision
→ Final
```

Long-Horizon Audit 只作为验收/观测工具，优先 deterministic；若使用 LLM，只用于测试证据，不直接改正文，不加入用户每章常规付费热路径。

20 / 50 / 100章 Gate：

```text
Canon hard conflict = 0
future leakage = 0
Source Boundary violation = 0
Seam catastrophic loss = 0
knowledge-state violation = 0
Memory fingerprint mismatch = 0
Writer Style catastrophic drift = 0
```

建议 commit：

`test(longrun): add long-horizon consistency audit gates`

---

# 13. C8 — Book Production Envelope（仅 Observability）

不是第二 Context / 第二 Memory / Prompt truth / 用户编辑对象。

只聚合已有观测：

```ts
BookProductionEnvelope {
  projectId
  currentChapterPosition
  storyMemoryThroughPosition
  storyMemoryFingerprint
  canonBoundary
  lastFinalFingerprint
  cumulativeWriterPhysicalCalls
  cumulativeTotalPaidLlmCalls
  cumulativeInputTokens
  cumulativeOutputTokens
  contextP50
  contextP95
  storyMemorySize
  dbPayloadSize
  lastSuccessfulChapter
  consecutiveFailureCount
  updatedAt
}
```

尽量复用已有 Observability，不建立第二 telemetry 系统。

默认不显示给普通用户。

建议 commit：

`feat(observability): add book-level production envelope projection`

---

# 14. C9 — Android 长篇 Stress Seal

测试层级：

```text
5章 Smoke
20章 Stability
50章 Long Run
100章 Stress
```

至少覆盖 Outline 与 Continuation。若双模式 100 章成本不可接受，可允许：

```text
Outline 100
Continuation 50
```

但报告必须写真实数量，禁止虚报。

---

# 15. C 轮 PDCA：必须用模拟器已有真实 LLM

这是本轮最重要的验收规则。

## 15.1 Mock 不能作为任何 GO 证据

C0-C9 每个阶段的 **PDCA Check / Act 是否 GO，必须使用模拟器老版本 App 里已经配置好的真实 LLM 实测**。

严禁用以下内容作为阶段 GO 证据：

- mock writing server；
- fake LLM；
- scripted deterministic response；
- hard-coded fixture response；
- localhost 模拟 Provider。

Mock / stub 只允许用于：

- 单元测试；
- Red Test；
- parser contract；
- repository deterministic test；
- failure injection。

但：

> **Mock PASS ≠ PDCA Check PASS。**

每个阶段进入 GO 前必须追加真实 LLM Android 实测。

## 15.2 必须保留旧 App 已有 LLM 配置

施工前：

1. 核对模拟器当前已安装旧版本 App；
2. 核对 active LLM 配置存在；
3. 不输出 API key；
4. 只记录安全元数据：provider、model name、context_window、max_output_tokens、config id/fingerprint；
5. 构建新 APK；
6. **只用 `adb install -r` 覆盖安装**；
7. 再核对 LLM 配置、项目、Writer Style、Canon、Story Memory 均未丢失；
8. 后续真实测试全部使用该真实配置。

禁止：

```text
adb uninstall
pm clear
reset app data
替换成 mock config
把 provider 改 localhost fake server
在日志/报告中记录 API key
```

## 15.3 每阶段固定 PDCA 模板

```text
PLAN
→ 定义问题、真实基线、硬门禁

DO
→ Red Test + 最小实现

CHECK-A
→ targeted unit / integration

CHECK-B（强制）
→ build APK
→ adb install -r
→ 使用模拟器已有真实 LLM
→ 执行真实用户流程
→ 收集 DB / Receipt / Logs / UI / Final Artifact

ACT
→ 失败继续修复
→ 再真实 LLM 复测
→ 全部通过才 GO
```

禁止：

```text
unit tests PASS
→ 直接 GO
```

---

# 16. maxTokens / Model Capability 永久 P0

C 轮新增任何 LLM 能力（Planner、Memory Delta、Long-Horizon verifier、Observer 等）都必须复用：

```text
providerCapabilities
+
Frozen model capability
+
elastic stage capacity
```

禁止：

```text
callLLM(messages, 4096)
callLLM(messages, 8192)
maxTokens: 16384
contextWindow || 128000
```

`npm run verify:elastic` 必须始终 PASS。

生产 `callLLM/callLLMResult` numeric literal 第二参数继续 CI FAIL。

Provider 真实 wire ceiling 只允许放 Provider adapter。

---

# 17. Structured Output 永久 P0

C 轮任何新增 JSON / structured LLM contract，例如 Memory Delta、Long-Horizon structured audit、Planner/Observer structured data，都必须统一：

```text
finishReason=length → fail closed
JSON invalid → fail closed
required fields missing → fail closed
schema mismatch → fail closed
fingerprint mismatch → fail closed
截断 → 禁止 Persist
```

优先复用 B 轮 shared structured contract / failure semantics。

禁止：

```text
格式坏了
→ 自动重复请求很多次
→ 看起来成功
```

所有 retry 必须进入真实 physical / total paid ledger。

---

# 18. SQLite / 大载荷 P0

C 轮禁止高频热路径：

```sql
SELECT * FROM pipeline_tasks
SELECT * FROM large_artifacts
```

要求：

- metadata projection；
- chunk；
- body on demand；
- large JSON lazy read；
- Memory Delta 分批；
- Project Stats 窄投影；
- Book Envelope 小字段；
- 100章审计证据不得塞进单行巨型 BLOB。

硬门禁：

```text
SQLiteBlobTooBigException = 0
CursorWindow allocation failure = 0
OOM = 0
```

---

# 19. 实施顺序

严格：

```text
C0-A Model Capability Single Source of Truth
C0-B Project Card 字数 + 批量导出/删除
C0-C UI Complexity Gate
C1   Long-Horizon Baseline
C2   Story Memory Durable Delta
C3   Current-Pipeline Durable Resume / Idempotency
C4   End-to-End Paid LLM Budget
C5   Exact Memoization
C6   Safe N+1 Static Prefetch
C7   Long-Horizon Consistency Audit
C8   Book Production Envelope
C9   Android 50/100章 Stress Seal
C10  Phase III Final Closure Review
```

任一阶段真实 LLM Check NO-GO，不得进入下一阶段。

---

# 20. 推荐 Commit 序列

```text
C0A fix(llm): unify model capability as single source of truth
C0B feat(project): show chapter and word counts on project cards
C0C feat(project): add simple batch export and delete
C0D refactor(ui): keep phase3-c user flows cognitively simple
C1  test(longrun): establish phase3-c long-horizon baseline
C2  perf(memory): add durable final-body story memory delta
C3  feat(pipeline): harden current-pipeline durable resume and idempotency
C4  feat(observability): account end-to-end chapter paid llm budget
C5  perf(writing): reuse exact successful request artifacts safely
C6  perf(context): add invalidation-safe n-plus-one static prefetch
C7  test(longrun): add long-horizon consistency audit gates
C8  feat(observability): add book-level production envelope projection
C9  test(android): seal long-horizon production stress matrix
C10 docs(phase3-c): seal long-form production and stability
```

每阶段：

```text
Red Test
→ 实现
→ targeted verify
→ APK
→ adb install -r
→ 真实 LLM
→ DB/Receipt/UI evidence
→ PDCA
→ 独立 commit
```

---

# 21. 每阶段证据模板

每阶段必须记录：

```text
阶段ID
Plan
Red Test
修改文件
Exact HEAD
targeted tests
full verify（需要时）
APK SHA
adb install-r 结果
真实 LLM 安全元数据
真实 run/batch/generationTrace
Writer physical calls
Total paid calls
input/output tokens
finishReason
fallback/retry
Final fingerprint
Memory fingerprint
DB evidence
UI evidence
GO / NO-GO
```

过程文档：

`docs/optimization/phase3-c-progress.md`

---

# 22. 最终真实 LLM 验收矩阵

## Model Capability

- 65K → 1M；
- 双向 UI 同步；
- restart；
- model switch；
- new Freeze；
- old Frozen run 不漂移。

## Project UX

- Outline project 字数；
- Continuation project 字数；
- 大项目字数；
- TXT import 后字数；
- JSON restore 后字数；
- 批量导出 ≥3 项目；
- 导出包重新导入；
- 批量删除 ≥3 项目；
- 部分失败处理；
- 项目列表不读取大正文。

## Long Run

真实 LLM：

```text
5章
20章
50章
100章
```

## Resume

真实 LLM + Android：

- Draft 后 kill；
- QA 后 kill；
- Revision 后 kill；
- Persist 边界；
- network failure；
- app restart；
- Android process restart。

## Memory

- Delta apply；
- duplicate delta；
- conflict；
- crash before merge；
- crash after merge；
- resume；
- 20/50/100章 size curve。

## Cost

逐章统计 Writer physical、Total Paid LLM、tokens、latency，并计算 p50 / p95 / long-run slope。

---

# 23. 最终硬门禁

## 架构

```text
第二 Kernel = 0
第二 Context = 0
第二 Prompt Compiler = 0
第二 QA = 0
第二长期 Memory = 0
Legacy Pipeline 恢复 = 0
Final Writer = 0
```

## Model Capability

```text
Auto Context / LLM Config 双值 = 0
新 Freeze 能力错配 = 0
旧 Frozen task capability drift = 0
硬编码业务 maxTokens = 0
verify:elastic = PASS
```

## Structured Output

```text
length 后 Persist = 0
malformed JSON 后 Persist = 0
schema mismatch 后 Persist = 0
无记录 retry = 0
```

## 长程一致性

```text
Canon hard conflict = 0
Source Boundary violation = 0
future leakage = 0
Seam catastrophic loss = 0
knowledge-state violation = 0
Memory fingerprint mismatch = 0
```

## 稳定性

```text
SQLiteBlobTooBig = 0
CursorWindow 大载荷崩溃 = 0
OOM = 0
重复 Finalize = 0
重复 Memory Delta merge = 0
已存在成功 exact artifact 时重复付费发送 = 0
```

## UI

```text
一级导航新增 = 0
核心写作步骤增加 = 0
工程术语进入普通用户主流程 = 0
项目卡片字数可见 = 100%
批量导出/删除可用
```

---

# 24. 性能原则

不为了达标牺牲 Mandatory Truth。

目标看趋势：

```text
Context 不随章节数无限线性增长
Memory update cost趋稳
Total Paid Calls趋稳
DB payload增长受控
p95 latency不随章节数失控
```

如果优化导致 Canon / Boundary / Seam / Story Memory / Writer Style 丢失，直接 NO-GO。

---

# 25. 最终报告

完成后输出：

`docs/optimization/phase3-c-final-report.md`

至少包含：

- Final Exact HEAD；
- Baseline HEAD；
- Commit 序列；
- C0 Model Capability 证据；
- 项目字数 / 批量管理证据；
- UI Complexity Gate；
- 真实 LLM 安全元数据；
- 5/20/50/100章真实矩阵；
- Writer Physical vs Total Paid Calls；
- Story Memory Delta 曲线；
- Resume / Idempotency；
- Memoization hit/miss；
- Prefetch hit/invalidation；
- Long-Horizon consistency；
- SQLite / DB size；
- Android APK SHA；
- `adb install -r`；
- `npm run verify:elastic`；
- `npm run typecheck`；
- `npm run verify`；
- GO / NO-GO。

---

# 26. C10 — Agent 最终反向复核方案完成度

Agent 在准备宣称完成前，必须重新打开并从头阅读：

`docs/optimization/TAVO-MINI_Phase3_C_长篇持续生产与稳定性封板_20260828.md`

然后生成：

`docs/optimization/phase3-c-requirement-closure.md`

逐条映射：

```text
方案章节
→ 需求
→ 实现文件
→ commit
→ Red Test
→ targeted test
→ 真实 LLM Android run
→ DB/Receipt/UI evidence
→ 状态
```

状态只能：

```text
PASS
NO-GO
N/A（必须说明为什么方案允许 N/A）
```

禁止：

```text
基本完成
大致完成
应该没问题
后续再优化
```

## 必须主动找漏项

Agent 要反查：

- 方案章节是否没有对应 commit；
- 是否只有 mock test 没有真实 LLM；
- 是否只有 UI 没数据层；
- 是否只有数据层没用户闭环；
- 是否没做 Android `install-r`；
- 是否 100章只写报告没真实 run；
- 是否新增 LLM 绕过 `verify:elastic`；
- 是否新增 Structured Output 没 fail-closed；
- 是否 Memory Delta / Prefetch 形成第二 Truth；
- 是否新增一级 UI；
- 是否项目字数靠全表 body scan；
- 是否批量删除留下 orphan；
- 是否批量导出不能重新导入；
- 是否 Total Paid Calls 漏辅助请求；
- 是否 Resume 重复收费 / 重复 Persist。

## 最终 Completion Gate

只有：

```text
phase3-c-requirement-closure.md 所有必需项 PASS
+
真实 LLM 长程矩阵 PASS
+
Android install-r PASS
+
full verify PASS
+
UI Complexity Gate PASS
+
maxTokens / Structured Output P0 PASS
```

才允许：

```text
PHASE III-C FINAL SEALED / GO
PHASE III FINAL SEALED / GO
```

任何必需项 NO-GO 都继续 PDCA，不得把阻塞项改写成 Known Issue 后封板。

---

# 27. 最终产品判定

C 轮成功的标准不是增加多少模块，而是普通用户能感受到：

```text
项目一眼能看到多少章、多少字
多个项目能方便导出和删除
上下文设置不再前后矛盾

写第1章和写第80章一样简单
App中断后能继续
小说设定不会越写越乱
最终稿仍然清晰可见
后台不会偷偷越来越贵
软件没有因为“更强”而更难用
```

最终目标：

> **让 TAVO 具备整本长篇小说的持续生产能力，同时把复杂度留在系统内部，而不是转嫁给普通用户。**
