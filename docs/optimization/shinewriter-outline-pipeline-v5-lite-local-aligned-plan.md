# ShineWriter Outline Pipeline V5-Lite 本地对齐改造方案

> 文档性质：施工前技术方案与验收基线  
> 本地事实源：`F:\ClaudeWorkSpace\projects\TAVO-MINI`  
> 评估基线：`main@2bdcc6ffdd3007182383fcd1438a9bef8dec5083`  
> 版本基线：ShineWriter V2.11.38 / Schema 43  
> 适用范围：当前产品“大纲创作”项目（`projects.mode='outline'`）中新发起的真实章节 Pipeline；项目创建时间不构成排除条件  
> 明确排除：原著续写 Pipeline、LLM Provider、Thinking、Timeout、Story Memory、Batch 生产状态机，以及历史兼容数据的清理/迁移  
> 结论：有条件可行；完成本文 P0 约束后可施工

---

## 1. 改造目标

本次参考 Continuation V5 已验证的“客户端稳定锚点 → 结构化审核合同 → 客户端编辑工作包 → Final Reviser → 本地终稿校验”机制，优化大纲创作章节 Pipeline。

目标不是新增 LLM 节点，也不是关闭推理，而是把现有 Proof 从“重新读取并重新判断全部资料”收敛为“执行已经确定的修订合同”。

预期收益：

1. 降低 Proof 输入 Token；
2. 减少 Review / FactCheck 与 Proof 的重复判断；
3. 降低 Proof 延迟和超时概率；
4. 保持正常路径的物理 LLM 请求数不增加；
5. 保持四个持久化 Stage、恢复、计费、Batch adoption 和 `finalText` 外部契约不变。

本方案不承诺仅靠架构调整必然提升文学质量。质量与性能必须通过真实章节 A/B 验证后才能默认启用 V2。

---

## 2. 本地实现事实

### 2.0 术语边界

为避免把产品模式、Pipeline 档位和任务协议混为一谈，本文统一使用以下定义：

| 名称 | 当前定义 |
|---|---|
| 产品项目类型 | 用户当前可新建的只有“大纲创作（outline）”和“原著续写（continuation）”两种 |
| 历史 freeform | 仅为已有数据保留的内部兼容值，不是当前第三种产品模式 |
| Pipeline Mode | 大纲创作内部的 `noReview / twoStage / conditional / full` 四种处理档位 |
| Workflow Version | 同一个大纲创作 Pipeline 内部的请求协议版本 V1/V2 |
| 已有冻结任务 | 升级前已经持久化 execution snapshot、checkpoint 或已付费 Stage 的 `pipeline_tasks`；不等于老项目或老作品 |

用户的大纲项目无论创建于哪个版本，只要升级后新发起章节生成任务，都属于 V2 候选。版本兼容针对的是“已经开始执行的 Pipeline 任务”，不是项目年龄。

### 2.1 当前持久化 Stage

当前 Stage 固定为：

```text
draft
review
factCheck
proof
```

权威实现位于：

- `src/services/pipeline/reconcile.ts`
- `src/services/pipeline/determineNextPipelineAction.ts`
- `src/services/pipeline/compileStageRequest.ts`
- `src/data/repositories/pipelineStageCheckpointRepository.ts`

本次不得新增 `revisionContract`、`finalValidate`、`finalReviser` 等数据库 Stage。

### 2.2 当前实际有四种 Pipeline Mode

```text
noReview:
Draft → Finalize Draft

twoStage:
Draft → Review → Proof → Finalize

conditional:
Draft → FactCheck → Proof → Finalize

full:
Draft → Review || FactCheck → Proof → Finalize
```

`full` 的 Review / FactCheck 由 `Promise.all` 并行执行，两个 Stage 分别 CAS claim，必须保持。

### 2.3 当前 Proof 的真实输入

Legacy Proof 当前把以下内容作为 mandatory 或 optional 输入：

```text
完整 Draft
完整 Review 报告
完整 FactCheck 报告
完整 Outline（mandatory）
写作 Preset
当前章节目标
用户要求
人物约束
世界规则
Story Memory
Episodic Memory
Notes
Recent Bridge
```

这验证了 V5-Lite 的优化空间，但也说明不能直接删除 Outline 和硬事实源；V2 Contract 必须先把其中不可丢失的义务完整结构化。

### 2.4 冻结、恢复与计费

- `PipelineExecutionSnapshot` 在任务首次运行时冻结 Pipeline Mode、四阶段预算、Preset 内容和模型身份；Resume 不重新读取这些运行时设置。
- `pipeline_stage_checkpoints` 是 Stage 状态权威；失败/中断 Stage 可重置为 pending，成功 Stage 不重跑。
- `pipeline_stage_attempts` 一行代表一次真实 HTTP 请求；成功、失败、safe retry、outcome unknown 都参与真实用量统计。
- Draft 请求已持久化 frozen request；非 Draft Stage 当前主要依靠冻结上下文、持久化上游输出和版本化编译器确定性重建请求。
- Batch 通过 `runChapterPipeline()` / `resumePipeline()` 委托单章 Pipeline，并从 `pipeline_stage_attempts` 聚合真实请求用量。

### 2.5 历史 freeform 兼容数据的真实状态

当前产品只提供“大纲创作”和“原著续写”两种新建类型。`freeform` 不是当前产品模式，而是兼容保留的历史内部值：

- 新建项目 UI 不再提供 `freeform`；
- 历史 `projects.mode='freeform'` 项目仍可打开、编辑、导入和导出；
- `FreeformEditor` 仍通过 `runFreeformPipeline()` 复用普通 Pipeline；
- `runFreeformPipeline()` 使用 `chapter.id === 0` 的伪章节。

因此，本次不清理或迁移历史 freeform 数据；同时不能仅根据“调用了普通 Pipeline”自动启用 V2，必须确认任务属于大纲创作的真实章节。

### 2.6 老项目与老任务不是同一概念

- 老大纲项目：升级后新建的 Pipeline 任务应使用 V2，不因为项目创建时间较早而保留 V1；
- 老章节正文：改造不会启动后台批量重写，也不会直接改动已有章节；普通单章 Pipeline 仍只有在用户采纳结果后才写入章节正文；
- 已有冻结任务：升级前已经完成部分 Stage 的任务必须继续 V1 Resume，避免重新解析旧报告、重复请求或重复计费；
- 仅创建了 task row、但尚未冻结 execution snapshot 且没有发出 HTTP 请求的任务，可按首次实际启动时的当前默认版本冻结。

---

## 3. 目标架构

### 3.1 Full

```text
Draft V1
  ↓
Canonical Draft + Stable Revision Anchors（本地，0 LLM）
  ↓
Review V2 ─────────────┐
                      ├─ Promise.all
FactCheck V2 ──────────┘
  ↓
Revision Contract Compiler（本地，0 LLM）
  ↓
Final Reviser（仍持久化为 proof）
  ↓
Local Final Artifact Validator（本地，0 LLM）
  ↓
Final
```

无格式修复、无网络重试的 happy path 为 4 次 HTTP 请求。

### 3.2 twoStage

```text
Draft
  ↓
Review V2
  ↓
Revision Contract
  ↓
Final Reviser
  ↓
Local Validator
```

Happy path 为 3 次 HTTP 请求。

### 3.3 conditional

```text
Draft
  ↓
FactCheck V2
  ↓
Revision Contract
  ↓
Final Reviser
  ↓
Local Validator
```

Happy path 为 3 次 HTTP 请求。

### 3.4 noReview

```text
Draft
  ↓
Finalize Draft
```

不得构建 Revision Contract，不得运行 Final Validator，不得改变当前行为。Happy path 为 1 次 HTTP 请求。

---

## 4. 作用域与 Workflow Version

### 4.1 新冻结字段

在 `PipelineExecutionSnapshot` 增加：

```ts
outlineWorkflowVersion?: 1 | 2;
```

语义：

```text
undefined / 1
→ Legacy Review / FactCheck / Proof

2
→ Anchored Review / FactCheck + Revision Contract + Final Reviser + Local Validator
```

### 4.2 V2 启用条件

只在任务首次冻结 execution snapshot 时判断：

```text
项目 mode === 'outline'
AND targetType === 'chapter'
AND chapter.id > 0
AND DEFAULT_OUTLINE_WORKFLOW_VERSION === 2
```

满足时冻结 `outlineWorkflowVersion=2`；否则冻结 1 或保持缺省 Legacy 语义。

项目的创建时间、章节创建时间和已有正文长度都不参与版本判断。已有 outline 项目在升级后新发起的真实章节任务与新项目采用相同规则。

本改造不会在升级时扫描或修改项目正文。V2 只影响用户之后主动发起的生成请求；生成结果仍遵守现有 preview/adoption 契约。

不得在 Resume 时重新读取当前项目模式或运行时开关。已冻结任务永远按冻结版本恢复。

### 4.3 明确排除

以下执行路径固定保持 V1：

- 已有冻结 task 的 execution snapshot 没有 `outlineWorkflowVersion`；
- 历史 `freeform` 兼容项目；
- `runFreeformPipeline()` 的 `chapter.id === 0` 伪章节；
- Continuation 项目；
- 任何无法确认项目模式的恢复任务。

### 4.4 回滚语义

通过修改：

```ts
const DEFAULT_OUTLINE_WORKFLOW_VERSION: 1 | 2 = 1;
```

可让未来新任务回到 Legacy。已经冻结为 V2 的任务继续 V2 Resume，禁止中途切换版本。

本字段存储在现有 `pipeline_context_json` 中，不需要 Schema migration。

---

## 5. Canonical Draft 与稳定锚点

### 5.1 新模块

建议新增：

```text
src/services/pipeline/revisionAnchors.ts
```

### 5.2 Canonical Draft

从已经成功持久化的 Draft checkpoint 读取原文，并确定性规范化：

```text
CRLF → LF
孤立 CR → LF
不做 Unicode 归一化
不修改正文字符、标点和段落内容
```

Review V2、FactCheck V2、Contract 和 Final Reviser 必须使用同一份 canonical Draft。

Hash 统一定义为：

```ts
draftHash = sha256Hex(canonicalDraft)
```

Offset 使用 JavaScript 字符串索引，即 UTF-16 code unit offset，与现有 TypeScript/SQLite 字符串处理保持一致。

### 5.3 Anchor 类型

```ts
interface PipelineRevisionAnchor {
  id: string;
  start: number;
  end: number;
  text: string;
  paragraphIndex: number;
  segmentIndex: number;
}
```

### 5.4 切分规则

1. 以一个或多个空行分隔自然段；
2. 忽略纯空白段，但保留真实 offset；
3. 普通段落使用 `draft-p-001`、`draft-p-002`；
4. 超长单段必须按确定性句界/字符上限继续切分，使用 `draft-p-001-s-001`；
5. 完全重复的段落仍获得不同 ID；
6. 相同 canonical Draft 必须产生完全相同的 anchors、offset 和顺序。

具体单段上限作为模块常量并通过真实章节压测确定，第一版建议控制在约 1200–1800 UTF-16 code units，禁止依赖 LLM Tokenizer 才能切分。

### 5.5 Prompt 渲染红线

Review / FactCheck 只能看到一次正文：

```text
[draft-p-001]
第一段正文

[draft-p-002]
第二段正文
```

不得同时注入“完整无标记 Draft + 完整 anchor excerpt 列表”，否则会重复正文并增加 Token。

Anchor 标记仅用于定位，Prompt 必须明确禁止模型把标记写入报告正文或最终小说。

---

## 6. 修订项定位协议

强制所有问题只有一个 `anchorId` 无法表达“缺失 Beat、跨段顺序、插入点、章节边界”等问题，因此 V2 采用显式 scope。

```ts
type PipelineRevisionScope =
  | 'anchor'
  | 'range'
  | 'insertion'
  | 'chapter'
  | 'boundary';

interface PipelineAuditCorrectionV2 {
  id: string;
  scope: PipelineRevisionScope;

  anchorId?: string;
  anchorIds?: string[];
  insertionBeforeAnchorId?: string;
  insertionAfterAnchorId?: string;
  boundary?: 'opening' | 'ending';

  dimension: string;
  severity: 'required' | 'hard' | 'warning';
  diagnosis: string;
  rewriteGoal: string;
  preserveMeaning: string[];
}
```

结构校验规则：

| scope | 必需定位字段 |
|---|---|
| `anchor` | `anchorId` |
| `range` | 至少两个合法 `anchorIds` |
| `insertion` | before/after 至少一个 |
| `chapter` | 不需要 anchor |
| `boundary` | `boundary`，可附邻近 anchor |

模型不得输出 excerpt、start 或 end。所有真实原文和 offset 均由客户端根据 anchor 回填。

---

## 7. Review V2 合同

Review 负责文学、大纲执行与章节结构，不负责 Canon 硬事实裁决。

```ts
interface PipelineReviewReportV2 {
  schemaVersion: 2;
  draftHash: string;
  requiredCorrections: PipelineAuditCorrectionV2[];
  protectedAnchorIds: string[];
  outlineExecution: {
    fulfilledBeats: string[];
    missingBeats: string[];
    deviations: string[];
    prematureBeats: string[];
    mustPreserve: string[];
    endingGoal?: string;
    mustNotAdvance: string[];
  };
}
```

职责包括：

- 本章大纲节点落实情况；
- 缺失 Beat 与后续剧情提前；
- 场景顺序、节奏、人物表现、对话和情绪递进；
- 开头承接和章末落点；
- 冗余、重复、Show/Tell；
- 已正确完成且 Final 必须保护的内容。

输出必须紧凑，不得重复整段 Draft，不得输出完整修订稿。

---

## 8. FactCheck V2 合同

FactCheck 负责事实、状态、连续性与知识边界。

```ts
interface PipelineFactCheckReportV2 {
  schemaVersion: 2;
  draftHash: string;
  requiredCorrections: PipelineAuditCorrectionV2[];
  protectedFacts: string[];
  hardConstraints: string[];
}
```

职责包括：

- 人物位置、身体和情绪状态；
- 人物已知/未知信息；
- 关系、时间、地点和物品归属；
- 能力与世界规则；
- 已发生事件、Story Memory、Episodic Memory、Recent Bridge 连续性；
- 不得提前发生或提前得知的硬事实；
- 用户明确确认的事实。

FactCheck 不负责纯文学偏好，不能用现实常识覆盖已建立的世界规则。

---

## 9. V2 Parser 与 Validator

为降低 Legacy 回归风险，不建议直接把现有约 900 行的 `pipelineAuditValidator.ts` 改造成混合协议巨型文件。

建议新增：

```text
src/services/pipeline/revisionAuditValidator.ts
```

并保持：

```text
V1 → 现有 validateReviewResult / validateFactCheckResult
V2 → 新 validateReviewV2Result / validateFactCheckV2Result
```

V2 Validator 必须验证：

1. 顶层字段白名单；
2. `schemaVersion === 2`；
3. `draftHash` 与客户端 hash 完全一致；
4. Correction scope 与定位字段匹配；
5. 所有 anchor 均存在；
6. required/hard correction 不得空描述或空目标；
7. 数组和单项大小有上限；
8. 不允许完整 Draft 回声；
9. 不允许小说正文、Prompt 或 reasoning 泄漏；
10. normalized JSON 字段顺序稳定，便于 Resume 重建和 fingerprint 测试。

第一次验证失败时沿用当前一次性 format repair。第二次仍失败则该 Stage 失败，不无限重试。

---

## 10. Revision Contract Compiler

### 10.1 新模块

```text
src/services/pipeline/revisionContract.ts
```

必须为纯函数、0 LLM、无数据库读取、无时间随机量。

### 10.2 输入

```text
Canonical Draft
Stable Anchors
成功的 Review V2（可选）
成功的 FactCheck V2（可选）
Frozen workflow/compiler version
```

`twoStage` 只有 Review，`conditional` 只有 FactCheck。Full 允许一份审核失败、另一份成功后继续生成 Contract，保持当前单审核降级语义。

### 10.3 输出

```ts
interface PipelineRevisionContract {
  schemaVersion: 1;
  compilerVersion: 1;
  draftHash: string;
  reviewHash?: string;
  factCheckHash?: string;
  workItems: PipelineRevisionWorkItem[];
  protectedAnchorIds: string[];
  protectedFacts: string[];
  hardConstraints: string[];
  outlineObligations: {
    fulfilledBeats: string[];
    missingBeats: string[];
    mustPreserve: string[];
    endingGoal?: string;
    mustNotAdvance: string[];
  };
}
```

WorkItem 必须保留 correction scope，并由客户端回填真实 anchor text/start/end。

### 10.4 确定性优先级

```text
Fact hard constraint
  > Outline / chapter boundary
  > Character knowledge and continuity
  > Literary correction
  > Style warning
```

同优先级保持原报告顺序；Review 与 FactCheck 的合并顺序固定。

### 10.5 禁止语义脑补

Compiler 只允许：

- 结构验证；
- anchor 回填；
- 确定性排序；
- 完全相同结构项去重；
- 汇总保护项与硬约束；
- 标记显式冲突。

不得根据自然语言相似度自行判断两个问题“可以合并”，不得猜测非法 anchor 的相似段落，不得生成模型未表达的新语义。

### 10.6 Fail-closed

- required/hard correction 的定位非法：对应审核结果不得进入成功 Contract；
- 只有 warning 定位非法：可丢弃并记录非敏感 warning；
- Full 一侧审核失效：使用另一侧生成 Contract；
- 两侧都失效：沿用当前从 Draft 降级 finalize，不调用 Proof；
- Contract 编译器内部异常：Proof 不发请求，任务按现有失败/降级语义处理。

---

## 11. Final Reviser（V2 Proof）

Legacy `compileProofStageRequest()` 和 `buildProofMessages()` 必须保留，不得让旧任务经过新协议。

建议新增独立 V2 编译入口：

```text
compileFinalReviserStageRequest()
buildFinalReviserMessages()
```

### 11.1 Mandatory 输入

```text
1. Revision Contract / Edit Work Packet
2. 完整 Canonical Draft
3. 当前章节原始目标
4. Contract 中的 hard constraints / outline obligations
```

### 11.2 Preferred 输入

```text
5. 上一章真实正文接缝 / Recent Bridge 的最小必要部分
6. 写作 Preset 的精简版本
7. 用户本轮明确要求
```

### 11.3 V2 原则上不再整包输入

```text
完整 Outline
原始 Review JSON
原始 FactCheck JSON
完整 Story Memory
完整 Episodic Memory
完整人物卡
完整世界书
完整 Notes
```

不能简单“删除完整 Outline”。Contract 必须先携带 `fulfilledBeats / missingBeats / mustPreserve / endingGoal / mustNotAdvance`，并通过 A/B 证明足以保护章节边界。

### 11.4 Prompt 顺序

```text
① Revision Contract / Edit Work Packet
② 完整 Canonical Draft
③ 当前章节目标和用户要求
④ 上一章接缝
⑤ 精简文风与硬约束
```

正文只能注入一次，Contract 中的 excerpt 只对需要修改的局部回填。

### 11.5 输出协议

第一版继续直接输出完整小说正文，不引入 JSON Final Envelope。

不得输出：

- Patch / diff；
- “其余内容不变”；
- Contract JSON；
- 修改说明；
- Anchor 标记；
- reasoning / `<think>`；
- Prompt 内容。

---

## 12. Local Final Artifact Validator

### 12.1 新模块

```text
src/services/pipeline/finalArtifactValidator.ts
```

在 Proof 模型返回后、`persistStage(... status: 'success')` 前执行。0 LLM，不创建 attempt。

### 12.2 Hard Fail

只对确定性技术交付错误 Hard Fail：

- 正文为空；
- `finishReason === 'length'` 且输出明显未完成；
- 只有 reasoning，没有正文；
- `<think>`、系统 Prompt、Contract、anchor 标记明显泄漏；
- 输出是 JSON 审核合同、Patch 或修改说明；
- 全文由重复自然段构成；
- 相对 Draft 发生灾难性长度坍缩并同时命中摘要/截断信号；
- 尾部停在明显未闭合的技术性分隔符或协议块。

### 12.3 Warning 而非 Hard Fail

以下单一启发式不得独立阻止交付：

- 正文较短；
- 包含“总结”“最终”等普通小说词语；
- 某条 Review 是否完全执行；
- 文学是否精彩；
- 情绪、节奏、文风的主观质量；
- 单一长度比例未达预期。

### 12.4 失败语义

Validator 失败：

1. 当前 Proof HTTP attempt 保持真实成功/已计费；
2. Proof checkpoint 按现有失败语义保存 Draft fallback 和技术错误；
3. 不自动再调用一次 Final Reviser；
4. 用户显式 Resume 时才允许重新运行 Proof；
5. 不重跑已成功 Draft / Review / FactCheck。

---

## 13. HTTP Attempt 与预算语义

### 13.1 Happy path

| Mode | 物理请求 |
|---|---:|
| noReview | 1 |
| twoStage | 3 |
| conditional | 3 |
| full | 4 |

### 13.2 修复/重试路径

当前 Review / FactCheck 各允许一次格式修复，网络层还有 safe retry / outcome unknown 语义。因此不得写“Full 永远最多 4 次请求”。

正确红线：

> V5-Lite 不新增任何业务 LLM 节点；在没有格式修复和网络重试时，Full 为 4 次。所有真实 repair/retry 请求继续创建 attempt、计费并受 Batch hard cap 约束。

本地步骤：

```text
Revision Anchors      0 attempt
Revision Contract     0 attempt
Final Validator       0 attempt
```

建议让 V2 的 Review / FactCheck / Proof attempt 写入现有 `request_version=2`，Draft 仍可保持当前 request version。无需新增列。

---

## 14. Resume 与跨版本兼容

### 14.1 已有冻结任务的 Legacy Proof 失败恢复

```text
升级前已冻结且已完成部分 Stage 的任务：
Draft succeeded
Review succeeded
FactCheck succeeded
Proof failed

升级后 Resume：
只重置 Proof checkpoint
→ outlineWorkflowVersion undefined => V1
→ Legacy Proof compiler
→ 只新增一次 Proof HTTP attempt
```

不得把该任务已持久化的旧 Review / FactCheck JSON 解析为 V2。这里的兼容对象是任务，不是项目：同一老大纲项目之后新建的另一个任务可以正常冻结 V2。

### 14.2 V2 Proof 失败恢复

```text
V2 Draft succeeded
V2 Review / FactCheck succeeded
Proof failed

Resume：
从持久化 Draft + 审核 JSON 确定性重建相同 anchors 和 Contract
→ 只重跑 Proof
```

必须测试重建后的：

- `draftHash` 相同；
- anchor 列表相同；
- Contract normalized JSON/hash 相同；
- 编译后的 request fingerprint 相同；
- 成功 Stage attempt 数不增加。

### 14.3 Compiler Version 纪律

`outlineWorkflowVersion=2` 发布后，任何会改变 V2 Contract 或 Prompt 绑定语义的修改必须：

- 保留旧 V2 compiler；或
- 增加新的 workflow/compiler version；
- 不得直接改变已冻结 V2 任务的恢复结果。

可选加固项：后续可利用已有 `pipeline_stage_attempts.frozen_request_json` 持久化 V2 Proof 请求并在 retry 时复用，但不作为第一阶段必须项，避免扩大本次状态机改造范围。

---

## 15. Batch 边界

Batch 生产代码原则上 0 修改：

```text
draft_only → noReview
fast       → twoStage
full       → full
```

Batch 继续只感知：

```text
draft / review / factCheck / proof
```

不得修改：

- `reconcileMultiChapterBatch.ts` 的生产决策；
- `determineNextBatchAction.ts`；
- Batch lease / adoption / budget / pause 状态机；
- `used_llm_calls` 聚合语义。

Batch 新建的真实 outline 章节任务会在单章 Pipeline 首次冻结时获得 V2；Resume 使用已冻结版本，`pipelineModeOverride` 不覆盖 workflow version。

仅允许为 Batch 增加回归测试；若测试证明必须修改生产 Batch，应先暂停施工并单独评估。

---

## 16. 预计代码影响面

### 16.1 高概率修改

```text
src/types/pipelineExecution.ts
src/types/pipelineAudit.ts（仅在确有共享价值时；优先保持 Legacy）
src/services/pipelineTaskContext.ts
src/services/pipeline/reconcile.ts
src/services/pipeline/compileStageRequest.ts
src/services/pipelineMessages.ts
src/services/pipeline/index.ts
```

### 16.2 建议新增

```text
src/types/pipelineRevision.ts
src/services/pipeline/revisionAnchors.ts
src/services/pipeline/revisionAuditValidator.ts
src/services/pipeline/revisionContract.ts
src/services/pipeline/finalArtifactValidator.ts
```

### 16.3 原则上不修改

```text
src/services/continuation/**
src/services/llm/**
src/services/llm.ts
src/services/multiChapterBatch/**（生产逻辑）
src/data/repositories/multiChapterBatchRepository.ts
src/services/storyMemory/**
src/services/migrations/**
src/data/schema/**
```

原方案中提到的 `src/services/pipelineAudit.ts` 在当前本地不存在；实际 Legacy 类型位于 `src/types/pipelineAudit.ts`，日志/验证位于 `src/services/pipelineAuditValidator.ts`。

---

## 17. 分阶段施工计划

### Phase 0：测试锁定与版本路由

- 为四种 mode 建立当前调用数与 Stage 顺序测试；
- 锁定 Full 并行；
- 锁定历史 freeform 兼容行为；
- 锁定 Legacy Proof-only Resume；
- 实现 `outlineWorkflowVersion` parse / serialize / default-to-V1；
- 不改变生产 Prompt。

### Phase 1：纯数据结构与稳定锚点

- 新增 V2 类型；
- 实现 canonical Draft、hash、anchors；
- 实现 tagged Draft 单次渲染；
- 完成 LF/CRLF、重复段、Emoji、中文、空段、长段测试；
- 不接入生产 Pipeline。

### Phase 2：V2 Parser / Validator

- 实现 Review V2 / FactCheck V2 parser；
- 严格 scope/anchor/hash 校验；
- 保持 Legacy validator 不变；
- 覆盖 format repair 和 reasoning-only 现有策略。

### Phase 3：Review / FactCheck V2 接入

- 仅 `outlineWorkflowVersion=2` 使用新 Prompt；
- Full 保持 `Promise.all`；
- twoStage / conditional 分别只运行一侧审核；
- noReview 不进入新逻辑；
- 失败语义保持当前降级策略。

### Phase 4：Revision Contract Compiler

- 实现纯函数编译器；
- 覆盖所有 scope；
- 完全相同项去重、确定性排序、显式冲突保留；
- 覆盖单审核成功、双审核成功、非法 required anchor；
- 锁定 Contract hash。

### Phase 5：Final Reviser

- 新增 V2 Proof compiler，不覆盖 Legacy compiler；
- Contract 优先、完整 Draft 第二；
- 删除 V2 Proof 的完整 Outline/raw reports/重复上下文；
- 保留最小章节目标、接缝、文风和硬约束；
- 校验 context budget、fingerprint 和完整正文输出。

### Phase 6：Local Validator

- 接在 Proof 返回和成功持久化之间；
- Hard Fail 只检查技术交付；
- 不产生 LLM attempt；
- 失败不自动重发。

### Phase 7：Resume / Batch / SQLite 回归

- Legacy 与 V2 Proof-only Resume；
- Batch fast/full、暂停、冷启动、safe retry、outcome unknown、budget cap；
- 真实 SQLite checkpoint/attempt 计数；
- adoption 后 `finalText` 与章节正文完整。

### Phase 8：A/B 与默认启用

- 初始开发阶段可保持 `DEFAULT_OUTLINE_WORKFLOW_VERSION=1`；
- 用显式测试注入或开发构建运行 V2；
- 完成真实章节 A/B；
- 质量与性能通过后单独提交默认值切换为 2；
- 默认值切换不得与其他 Pipeline 重构混在同一提交。

---

## 18. 必测矩阵

### 18.1 Mode

| 场景 | 预期 |
|---|---|
| V1 noReview | 1 request，行为不变 |
| V2 noReview | 1 request，不构建 Contract/Validator |
| V2 twoStage | Draft + Review + Final |
| V2 conditional | Draft + FactCheck + Final |
| V2 full | Draft + Review/FactCheck 并行 + Final |
| Full 单审核失败 | 使用另一份成功报告生成 Contract |
| Full 双审核失败 | Draft fallback，不调用 Proof |

### 18.2 作用域

- outline 真实章节新任务冻结 V2；
- 已有冻结 task 缺字段走 V1；
- 历史 freeform 兼容路径走 V1；
- 老 outline 项目的新任务正常冻结 V2；
- 升级本身不修改已有章节正文；
- `chapter.id=0` 走 V1；
- continuation 不进入普通 Pipeline V2；
- Resume 不受当前默认值变化影响。

### 18.3 Anchor

- LF / CRLF / 单独 CR；
- 两个完全相同段落；
- 中文标点；
- Emoji / surrogate pair；
- 空白段；
- 单段超长正文；
- scope=range；
- scope=insertion；
- scope=chapter；
- scope=boundary；
- 不存在 anchor；
- tagged Draft 只出现一次正文。

### 18.4 Resume

- V1 Proof failed → 仅 Legacy Proof；
- V2 Proof failed → Contract/fingerprint 相同，仅 V2 Proof；
- Review succeeded / FactCheck failed；
- Review failed / FactCheck succeeded；
- format repair 后成功的审核在 Resume 时不重发；
- app 冷启动恢复；
- stale running checkpoint 恢复；
- 成功 Stage 不重复计费。

### 18.5 Validator

- empty；
- reasoning only；
- `<think>` 泄漏；
- JSON Contract / Prompt 泄漏；
- anchor 标记泄漏；
- patch / “其余不变”；
- whole-paragraph duplicate；
- finishReason length；
- 合法短章不误判；
- 小说中普通“总结/最终”词语不误判。

### 18.6 Batch

- draft_only；
- fast；
- full；
- Proof failure → Resume；
- safe retry；
- outcome unknown；
- budget cap；
- pause during Proof；
- cold-start resume；
- completedCount / adoption / finalText；
- repair attempt 真实计费。

---

## 19. 性能与质量验收

### 19.1 可直接从本地记录的指标

当前 `pipeline_stage_attempts` / checkpoint 可支持：

- 每阶段 input/output/total tokens；
- 每阶段 duration；
- HTTP attempt 数；
- retry / outcome unknown；
- 编译输入 token 估算；
- Proof timeout/失败率。

当前 LLMResult 没有统一的 reasoning-token 数值字段。除非 Provider 已返回可用 usage，否则 reasoning tokens 只作可选观察项，不得为采集它而修改 Provider。

### 19.2 建议性能目标

- V2 Proof input tokens 相比 Legacy 中位数下降至少 30%；
- V2 Proof p50 时长下降至少 20%–25%；
- Proof timeout rate 不高于 Legacy；
- happy path 调用数不增加；
- 含 repair/retry 的总 attempt 按真实值统计；
- Full 总 Token 不高于 Legacy，理想下降。

### 19.3 质量指标

- 大纲节点遗漏率；
- 后续剧情提前率；
- 人物知识边界错误；
- 世界规则错误；
- 前后章衔接；
- Final 相对 Draft 的无理由大幅漂移；
- 人工“直接采纳 / 小改 / 重写”比例；
- Validator false positive 数量。

建议至少选择短/中/长章节、轻/重设定、包含复杂大纲边界的代表样本进行盲评。性能达标但质量明显退化时不得默认启用 V2。

---

## 20. 可观测性与隐私

允许记录：

```text
outlineWorkflowVersion
requestVersion
draftAnchorCount
reviewCorrectionCount
factCorrectionCount
contractWorkItemCount
contractCompilerVersion
proofEstimatedInputTokens
proofReservedOutputTokens
finalValidatorCodes
```

禁止记录：

- API Key；
- 完整小说正文；
- 完整 Prompt；
- reasoning 原文；
- 角色卡、世界书、Notes 原文；
- Contract 中回填的真实 excerpt。

日志只记录计数、hash、错误码和长度，不记录内容。

---

## 21. 风险分级

### P0

1. Workflow Version 路由错误导致已有冻结任务解析 V2；
2. 历史 freeform 兼容路径被误启用 V2；
3. 忽略 `conditional` 模式；
4. Anchor 协议无法表达缺失/跨段问题；
5. 删除完整 Outline 后 Contract 未携带完整章节边界；
6. Proof Resume 重跑已成功审核或改变请求语义；
7. 本地步骤错误创建 HTTP attempt；
8. Batch repair/retry 计费被误当成“最多 4 次”。

### P1

1. Final Validator 误杀合法小说；
2. 超长段 anchor 粒度过粗；
3. Contract 项过多导致 Proof 输入下降不明显；
4. Review 与 FactCheck 冲突未显式保留；
5. V2 parser 扩大 Legacy validator 回归面；
6. 同一 workflow version 下未来 compiler 改动导致恢复漂移。

### P2

1. 诊断日志不足；
2. UI 仍显示“终审校对员”而内部角色已变为 Final Reviser；
3. 文档和代码命名不完全一致。

P2 不应驱动本轮 UI 大改。

---

## 22. 最终验收红线

以下任一失败不得合并：

1. 历史 freeform 兼容行为改变；
2. 已有冻结 Legacy task 被套用 V2；
3. 老 outline 项目的新任务因项目创建时间被错误锁定为 V1；
4. `conditional` 行为缺失或调用链错误；
5. noReview 产生 Contract、Validator 或额外请求；
6. Full Review / FactCheck 不再并行；
7. happy path 业务 LLM 节点数增加；
8. repair/retry attempt 未真实计费；
9. Proof Resume 重跑成功 Draft / Review / FactCheck；
10. Stage 名或 PipelineTaskStatus 扩展；
11. `finalText` 不再是完整可采纳小说正文；
12. Local Contract / Validator 创建 attempt；
13. Batch 生产状态机被不必要修改；
14. Continuation V5 或 Story Memory 行为改变；
15. Final Validator 自动触发额外 Final 请求；
16. Anchor hash/offset 在 Resume 后不一致；
17. V2 Contract 无法表达 insertion/chapter/boundary 问题；
18. `npm run verify` 未通过；
19. 关键真实 SQLite、Batch Resume、冷启动回归失败；
20. 真实章节 A/B 显示质量明显退化。

---

## 23. 施工完成后的验证命令

至少执行：

```bash
npm run lint
npm run typecheck
npm run test:ci
npm run verify
```

并单独运行新增/关键套件：

```bash
npx jest __tests__/pipelineRevisionAnchors.test.ts --runInBand
npx jest __tests__/pipelineRevisionContract.test.ts --runInBand
npx jest __tests__/pipelineRevisionAuditValidator.test.ts --runInBand
npx jest __tests__/pipelineFinalArtifactValidator.test.ts --runInBand
npx jest __tests__/pipelineRunner.test.ts --runInBand
npx jest __tests__/pipelineE2E.test.ts --runInBand
npx jest __tests__/outlinePipelineSnapshot.test.ts --runInBand
npx jest __tests__/f301BatchResumeFrozenContext.test.ts --runInBand
npx jest __tests__/multiChapterBatchStateMachine.test.ts --runInBand
```

测试文件名可按最终实现调整，但覆盖面不得减少。

---

## 24. 最终建议

建议按本文分阶段开工，采用以下原则：

```text
已有冻结任务的 Legacy V1：冻结、保留、不改写

老 outline 项目的新任务：与新项目一致，按当前默认版本冻结

V2 Review / FactCheck：
把判断转成可执行且可定位的合同

Client：
只做结构验证、真实原文回填和确定性排序

Final Reviser：
读完整 Draft 和唯一施工合同，不重新研究全部资料

Local Validator：
只检查技术交付，不评价文学质量
```

第一阶段先实现类型、锚点、Validator、Contract 和版本路由，并保持默认 V1；第二阶段接入 V2；第三阶段完成真实 A/B 后再切换默认值。这样可以在不破坏已有冻结任务、历史 freeform 兼容数据、Batch 和 Continuation 的前提下，让所有 outline 项目后续新发起的任务使用一致的新流程，并验证 V5-Lite 是否真正降低 Proof 成本、保持章节质量。
