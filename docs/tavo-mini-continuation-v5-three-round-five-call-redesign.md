# TAVO-MINI Continuation V5：三轮三稿、五次调用改造方案

> 项目：`anjingdtl/tavo-mini`  
> 本地目录：`D:\AiWorkSpace\2NDWorkSApace\tavo-mini`  
> 实施基线：`d04727ab78837a29ae806aaf15d6b02401dec3ee`  
> 当前版本：`V2.11.16 / Schema 33`  
> 基线提交：`docs(claude): 同步 V2.11.16 / Schema 33 / V4 / Canon 五维硬验收`  
> V4 核心实现祖先：`62f4db9cd7e59dbaa41e36f61b850d1477b89c88`  
> 建议文档路径：`D:\AiWorkSpace\2NDWorkSApace\tavo-mini\docs\tavo-mini-continuation-v5-three-round-five-call-redesign.md`

---

## 0. 实施前提：本地已同步远端最新提交

本方案按以下前提实施：

```text
本地仓库：
D:\AiWorkSpace\2NDWorkSApace\tavo-mini

预期 HEAD：
d04727ab78837a29ae806aaf15d6b02401dec3ee
```

Agent 开工时只需验证：

```bash
git status --short --branch
git branch --show-current
git rev-parse HEAD
git log -5 --oneline --decorate
git diff
git diff --cached
```

本次实施**不得主动执行**：

```text
git fetch
git pull
git merge
git rebase
git checkout 到其他分支
git reset
git clean
```

若 `git rev-parse HEAD` 不是预期提交：

1. 不自动同步远端；
2. 不覆盖本地代码；
3. 先报告实际 HEAD、分支和差异；
4. 仅在用户明确授权后处理基线偏差。

若 HEAD 正确但存在未提交修改：

- 保留所有用户修改；
- 先识别与 V5 改造的重叠文件；
- 采用兼容式增量修改；
- 不以“恢复干净工作树”为理由丢弃内容。

远端 `main` 的最新公开提交已确认为 `d04727a`。本方案不再要求 Agent 比较、拉取或追赶远端，只要求以当前本地 HEAD 为唯一实施基线。

---

## 1. 方案摘要

Continuation V5 不再使用：

```text
Writer
→ Checker + Control
→ Repair
→ 不通过则回退 Writer
```

而是改为：

```text
Round 1
Draft Writer + Narrative Architect
→ V1 初稿 + A1 叙事架构

Round 2
Revision Writer + Adversarial Auditor
→ V2 第一次修订稿 + C2 最终修订合同

Round 3
Final Reviser
→ V3 最终稿

Local
Final Artifact Validator
→ 仅检查技术完整性，不比较旧稿，不回退 V1/V2
```

物理请求总计最多 5 次，墙钟时间仍为 3 轮：

```text
Draft Writer          1
Narrative Architect   1
Revision Writer       1
Adversarial Auditor   1
Final Reviser         1
--------------------------------
总计                  5
```

---

## 2. 为什么需要 V5

当前 V4 已完成长度软化、Control 绑定、截断诊断、Repair Prompt 预算和 Resume 等工程修复，但仍有三项结构性限制：

1. **单次 Writer 容易主动早停。** 即使用户目标为 3000 汉字，模型仍可能以 `finishReason=stop` 在 1200～1900 字附近自然收束。
2. **Repair 职责冲突。** 它既被要求最小干预，又被期待补足明显缺失的叙事内容。
3. **旧 Local Final Gate 会回退初稿。** 这适合局部 Repair，却不适合允许结构性改写的最终修订。

五次调用是当前限制下的平衡点：

```text
2 + 2 + 1 = 5 次调用
```

---

## 3. 核心产品原则

### 3.1 三轮三稿

术语固定：

```text
V1：初稿
V2：第一次修订稿
V3：第二次修订稿 / 最终稿
```

### 3.2 只有 V3 可交付

```text
V1 eligibility = intermediate
V2 eligibility = intermediate
V3 eligibility = eligible | rejected
```

V3 失败时：

```text
本次无可交付终稿
→ awaiting_regeneration
```

不得自动回退 V2 或 V1。

### 3.3 字数是创作目标，不是资格门禁

`targetChapterChars` 动态注入三轮，用于 Prompt、预算、UI 和 telemetry。

不得用于：

- 自动拒绝 V3；
- 回退旧稿；
- 逐 Beat 数字配额；
- 固定净增要求；
- 放宽完整性和技术安全检查。

### 3.4 不让用户选稿

用户默认只看到 V3。V1/V2 仅用于审计、恢复和调试，不提供采纳按钮。

### 3.5 V3 后不再调用 LLM

Final Reviser 是最后一次模型调用。之后只能执行本地技术验证，不得合并、润色、复审或自动重试。

---

## 4. 总体架构

```text
Round 1
┌────────────────────┐      ┌─────────────────────────────┐
│ Draft Writer       │      │ Narrative Architect         │
│ 完整初稿 V1         │      │ 叙事架构 A1                  │
└─────────┬──────────┘      └──────────────┬──────────────┘
          └──────────────────┬──────────────┘
                             ▼
Round 2
┌────────────────────┐      ┌─────────────────────────────┐
│ Revision Writer    │      │ Adversarial Auditor         │
│ 第一次修订稿 V2     │      │ 最终修订合同 C2              │
└─────────┬──────────┘      └──────────────┬──────────────┘
          └──────────────────┬──────────────┘
                             ▼
Round 3
                  ┌────────────────────────┐
                  │ Final Reviser          │
                  │ 完整最终稿 V3           │
                  └────────────┬───────────┘
                               ▼
                  Final Artifact Validator
                  零请求技术验证
```

---

## 5. Workflow Version 与兼容

新增：

```ts
workflowVersion: 5
```

历史 `workflowVersion: 2 | 4` 继续可读、可恢复，不得把 V4 运行重新解释为 V5。

```ts
switch (run.workflowVersion) {
  case 5:
    return runContinuationV5(...);
  case 4:
    return runContinuationV4(...);
  default:
    return runLegacyContinuation(...);
}
```

建议先用项目级 feature flag 启用 V5，稳定后再替换默认入口。

---

## 6. 节点定义

```ts
export type ContinuationV5PhysicalNode =
  | 'draft_writer'
  | 'narrative_architect'
  | 'revision_writer'
  | 'adversarial_auditor'
  | 'final_reviser';

export type ContinuationV5LocalNode = 'final_validate';

export type ContinuationV5Node =
  | ContinuationV5PhysicalNode
  | ContinuationV5LocalNode;
```

轮次：

```ts
export const CONTINUATION_V5_ROUNDS = {
  round1: ['draft_writer', 'narrative_architect'],
  round2: ['revision_writer', 'adversarial_auditor'],
  round3: ['final_reviser'],
} as const;
```

硬上限：

```ts
export const CONTINUATION_V5_MAX_PHYSICAL_REQUESTS = 5;
```

---

## 7. Artifact 模型

推荐新增：

```ts
export type ContinuationV5ArtifactStage =
  | 'draft'
  | 'revision_1'
  | 'final';

export type ContinuationArtifactEligibility =
  | 'intermediate'
  | 'eligible'
  | 'rejected';
```

Artifact 链：

```text
V1 draft
parentArtifactId = null

V2 revision_1
parentArtifactId = V1.id

V3 final
parentArtifactId = V2.id
```

建议结构：

```ts
interface ContinuationArtifact {
  id: string;
  runId: string;
  stage:
    | 'writer'
    | 'repair'
    | 'user_edit'
    | 'draft'
    | 'revision_1'
    | 'final';

  revisionRound: 0 | 1 | 2;
  parentArtifactId: string | null;
  content: string;
  contentHash: string;

  eligibilityStatus:
    | 'intermediate'
    | 'eligible'
    | 'rejected';

  rejectionCode: string | null;
}
```

### 7.1 数据库迁移决策

实施前检查 SQLite 是否对以下列存在 CHECK 约束：

```text
continuation_generation_artifacts.stage
continuation_generation_artifacts.eligibility_status
continuation_generation_stage_results.stage
```

若为无 CHECK 的 TEXT，只扩展 TypeScript 与 Repository；若存在 CHECK，则做一次加法式迁移，只增加新值，不重写历史数据。

不推荐把 V1/V2 伪装成 `rejected`，也不推荐继续把 V2/V3 都伪装成 `repair`。

---

## 8. Round 1：Draft Writer

### 8.1 职责

Draft Writer 输出完整 V1，重点是：

- 原著叙述气质；
- 人物对白；
- 情绪和动作现场感；
- 用户本章要求；
- 当前人物、关系、剧情和经历状态；
- 自然章末；
- 尽量接近目标体量。

V1 不是提纲或片段。

### 8.2 长度策略

```ts
interface ContinuationV5LengthPolicy {
  preferredMinRatio: number;
  preferredMaxRatio: number;
  severeUnderRatio: number;
  outputHeadroomRatio: number;
}

export const CONTINUATION_V5_LENGTH_POLICY = {
  preferredMinRatio: 0.9,
  preferredMaxRatio: 1.1,
  severeUnderRatio: 0.65,
  outputHeadroomRatio: 1.2,
};
```

目标 3000 时：

```text
首选体量：2700–3300
严重欠写诊断：低于 1950
```

这些值只用于 Prompt、预算、warning 和 telemetry，不用于候选资格。

### 8.3 Prompt 核心

```text
你是 Continuation V5 Draft Writer。

请生成从章节开头到自然结尾的完整初稿 V1。

用户希望本章约为 {targetHan} 个汉字，首选自然体量约为
{preferredMinHan}–{preferredMaxHan} 个汉字。

这不是要求写完后补字，而是要求你在动笔前准备足以支撑该体量的
有效叙事内容。

主要行动不能只被一句话概述。
中心冲突不能刚刚启动就结束。
重要人物的行动、阻力、选择、反应和后果需要真正发生在正文中。

不要为每个 Beat 分配固定字数。
不要为了接近目标而重复心理、环境、反应、对白或总结解释。

如果没有足够内容自然展开，说明当前 plan 的故事体量不足；
请先调整 plan，增加符合 Canon、人物状态和用户要求的有效推进，
而不是提前结束正文。
```

### 8.4 输出契约

```ts
interface ContinuationV5DraftEnvelope {
  schemaVersion: 1;

  plan: {
    chapterGoal: string;
    centralConflict: string;
    beats: Array<{
      id: string;
      summary: string;
      stateChange: string;
    }>;
  };

  content: string;
}
```

Beat 说明行动、阻力和局面变化，禁止数字配额。

### 8.5 Draft 诊断

```ts
{
  targetHan: number;
  preferredMinHan: number;
  preferredMaxHan: number;
  actualHan: number;
  targetAttainmentRatio: number;
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number | null;
  maximumOutputTokens: number;
  declaredMaxOutputTokens: number;
}
```

`draft_severe_under_target` 仅为 warning，不阻断 Round 2。

---

## 9. Round 1：Narrative Architect

Architect 与 Draft Writer 并行，不读取 V1。

它只准备足以支撑目标体量的有效叙事材料，不写小说正文，不分配场景字数。

```ts
interface ContinuationV5ArchitectureEnvelope {
  schemaVersion: 1;
  chapterGoal: string;
  centralConflict: string;

  sceneUnits: Array<{
    sceneId: string;
    entryState: string;
    characterAction: string;
    resistance: string;
    turningPoint: string;
    consequence: string;

    relationshipChange: string | null;
    informationChange: string | null;
    riskChange: string | null;

    canonEvidenceIds: number[];
    requiredContinuity: string[];
    forbiddenInventions: string[];
  }>;

  endingState: string;
  forbiddenPaddingPatterns: string[];
}
```

每个 scene unit 必须包含：

```text
行动 → 阻力或异常 → 选择或转折 → 局面变化 → 后果
```

客户端计算：

```ts
architectureHash = sha256(canonicalJson(envelope))
```

不得信任模型自己生成的 hash。

---

## 10. Round 1 并行边界

```ts
const [draftResult, architectureResult] = await Promise.allSettled([
  runDraftWriterNode(...),
  runNarrativeArchitectNode(...),
]);
```

Draft 失败或截断：运行失败，不进入 Round 2。

Architect 失败：允许使用本地 fallback A1，来源仅限 Draft plan、用户要求和冻结状态，不新增核心事实，并记录：

```text
narrative_architect_degraded
```

不得自动重试。

---

## 11. Round 2：Revision Writer

Revision Writer 接收完整 V1、A1、冻结 Canon、原著风格、用户要求和目标篇幅，生成完整 V2。

这一轮主要解决：

- V1 明显欠写；
- 场景过早结束；
- 事件只被概述；
- 行动缺少阻力；
- 人物选择没有后果；
- 关系、信息或风险没有变化。

Prompt：

```text
你要生成完整的第一次修订稿 V2。

V1 是文学表达基线。
A1 是叙事材料，不是必须机械执行的清单。

保留 V1 中自然、有原著气息的人物对白、叙述、动作和留白；
同时从 A1 中选择符合 Canon、人物状态和用户要求的有效内容，
修复 V1 中过早收束、只作概述或事件链不足的部分。

通过真实行动、阻力、选择、转折和后果扩充章节。

不得重复心理、堆叠环境、重复反应、扩展无信息对白或添加总结解释。
不得凭空创造重大人物、能力、组织、规则或后续事实。

用户目标约为 {targetHan} 个汉字。
V1 当前为 {draftHan} 个汉字。
优先完成尚未充分展开的核心场景，而不是机械补足差额。
```

输出：

```ts
interface ContinuationV5RevisionEnvelope {
  schemaVersion: 1;
  draftArtifactHash: string;
  architectureHash: string;
  content: string;
  usedArchitectSceneIds: string[];
  omittedArchitectSceneIds: string[];
  declaredNewCoreFacts: string[];
}
```

严格验证 V1/A1 hash。绑定失败不落 V2 artifact。

---

## 12. Round 2：Adversarial Auditor

Auditor 与 Revision Writer 并行，因此看不到 V2。它不是 V2 认证器，而是独立审查 V1+A1，并生成 V3 使用的最终修订合同 C2。

为了保持五次调用，Auditor 在一个 envelope 中严格分区：

```text
canonAudit
styleAudit
architectureAudit
finalObligations
```

它不得把事实和文风混成一个总分。


Auditor 输出契约：

```ts
interface ContinuationV5AuditEnvelope {
  schemaVersion: 1;

  draftArtifactHash: string;
  architectureHash: string;

  canonSnapshotId: string;
  canonRevision: number;
  inputRevisionHash: string;

  styleProfileHash: string | null;
  styleRendererVersion: string | null;

  canonAudit: {
    requiredCorrections: Array<{
      requirementId: string;
      category:
        | 'character'
        | 'world'
        | 'relationship'
        | 'plot'
        | 'experience'
        | 'knowledge'
        | 'timeline'
        | 'boundary'
        | 'locked_rule';

      severity: 'warning' | 'error' | 'blocking';
      confidence: number;

      generatedStart: number | null;
      generatedEnd: number | null;
      generatedExcerpt: string;

      description: string;
      evidenceIds: number[];
      requiredOutcome: string;
      forbiddenChanges: string[];
    }>;

    protectedFacts: string[];
    forbiddenFacts: string[];
  };

  styleAudit: {
    requiredCorrections: Array<{
      requirementId: string;
      dimension:
        | 'narrative_voice'
        | 'pov'
        | 'sentence_rhythm'
        | 'dialogue_voice'
        | 'emotional_expression'
        | 'description_density'
        | 'subtext'
        | 'scene_transition'
        | 'ai_template'
        | 'padding';

      severity: 'warning' | 'error';
      confidence: number;

      generatedStart: number | null;
      generatedEnd: number | null;
      generatedExcerpt: string;

      description: string;
      styleEvidenceIds: string[];
      rewriteGoal: string;
      preserveMeaning: string[];
    }>;

    protectedPassages: Array<{
      passageId: string;
      generatedStart: number;
      generatedEnd: number;
      generatedExcerpt: string;
      reason: string;
    }>;

    forbiddenExpansionPatterns: string[];
  };

  architectureAudit: {
    safeSceneIds: string[];

    rejectedScenes: Array<{
      sceneId: string;
      reasonCode:
        | 'canon_conflict'
        | 'future_leakage'
        | 'knowledge_conflict'
        | 'relationship_conflict'
        | 'style_drift'
        | 'padding_risk'
        | 'duplicate_function'
        | 'unsupported_core_fact';

      description: string;
      evidenceIds: number[];
    }>;
  };

  finalObligations: Array<{
    obligationId: string;
    source:
      | 'canon'
      | 'style'
      | 'architecture'
      | 'user_rule';

    priority: number;
    description: string;
    requiredOutcome: string;
    forbiddenChanges: string[];
  }>;
}
```

Auditor 必须绑定：

```text
draftArtifactHash
architectureHash
canonSnapshotId
canonRevision
inputRevisionHash
styleProfileHash
styleRendererVersion
```

绑定失败时使用本地 fallback contract，并记录：

```text
adversarial_audit_binding_failed
adversarial_auditor_degraded
```

fallback 只允许包含：

- 用户锁定规则；
- 硬 Canon facts；
- 禁止新增核心事实；
- 禁止 future leakage；
- 禁止 padding 和 AI template；
- A1 scene 默认仅作参考，不视为已审查安全。

不得自动重试 Auditor。

---

## 13. Round 2 并行边界

```ts
const [revisionResult, auditResult] = await Promise.allSettled([
  runRevisionWriterNode(...),
  runAdversarialAuditorNode(...),
]);
```

Revision Writer 失败或截断：

```text
run.state = awaiting_regeneration
error = revision_writer_failed | revision_writer_output_truncated
```

不得让 V3 从 V1 跳过 V2。

Auditor 失败：使用 fallback C2，允许进入 Round 3，但必须在 telemetry 和 UI 标明独立审查降级。

---

## 14. Round 3：Final Reviser

Final Reviser 生成唯一 V3。

它接收：

- 完整 V2；
- C2 最终修订合同；
- A1 中安全或未明确拒绝的 scene；
- C2 标记的 V1 protected passages；
- 冻结 Canon；
- 原著风格；
- 用户要求；
- 动态目标篇幅。

V2 是主要正文基线。为控制上下文，不建议默认再次注入完整 V1；V1 中需要找回的内容由 `protectedPassages` 提供。

### 14.1 优先级

```text
1. 用户锁定规则与续写边界
2. 冻结 Canon 和当前状态
3. C2 中 blocking/error 最终义务
4. V2 已完成的事件链
5. V1 protected passages 中更自然的表达
6. A1 中安全且尚未充分落地的有效 scene
7. 用户动态目标篇幅
```

### 14.2 Prompt 核心

```text
你要生成本次唯一的完整最终稿 V3。

V2 是当前正文基线，但不是不可修改的模板。
C2 是最终修订合同。

必须完成 C2 中全部 blocking/error 义务。
不得使用 C2 明确拒绝的 Architect scene。
不得自行创造新的核心人物、能力、组织、关系状态、世界规则或后续剧情事实。

保留 V2 中已经成立的行动、转折、人物选择和后果。
如果 V2 磨掉了 C2 标记的 V1 优质对白、动作或留白，可以恢复或重构。

用户参考目标约为 {targetHan} 个汉字。
V2 当前为 {revisionHan} 个汉字。

若仍明显偏短，应继续完成尚未充分展开的核心场景：
- 行动；
- 阻力；
- 人物选择；
- 信息变化；
- 关系变化；
- 实际后果。

不得追加无关描写，不得重复心理、反应、对白或解释。

只输出从章节开头到自然结尾的完整最终章节。
```

### 14.3 输出契约

```ts
interface ContinuationV5FinalEnvelope {
  schemaVersion: 1;

  revisionArtifactHash: string;
  architectureHash: string;
  auditContractHash: string;

  content: string;

  appliedObligationIds: string[];
  appliedCanonRequirementIds: string[];
  appliedStyleRequirementIds: string[];

  usedArchitectSceneIds: string[];
  restoredProtectedPassageIds: string[];

  declaredNewCoreFacts: string[];
  unappliedItems: string[];
}
```

### 14.4 绑定

必须验证：

```text
revisionArtifactHash == V2.contentHash
architectureHash == A1.architectureHash
auditContractHash == C2.contractHash
```

错误码：

```text
final_revision_hash_missing
final_revision_hash_mismatch
final_architecture_hash_missing
final_architecture_hash_mismatch
final_audit_hash_missing
final_audit_hash_mismatch
```

### 14.5 合同回填

本地只验证协议层：

- blocking/error obligation IDs 是否全部回填；
- `unappliedItems` 是否为空；
- `usedArchitectSceneIds` 是否存在于 A1；
- 是否使用 C2 明确拒绝的 scene；
- `declaredNewCoreFacts` 是否为空。

本地不能宣称语义已真正修复。

---

## 15. Final Artifact Validator

旧 `Local Final Gate` 的 Writer-relative 语义必须删除。新节点只判断 V3 是否是技术上可交付的完整 artifact。

### 15.1 检查范围

#### 输出完整性

- `finishReason !== length`；
- envelope 可解析；
- schemaVersion 正确；
- content 非空；
- content 不是 Patch；
- content 不是摘要；
- content 不是提纲；
- content 不是“其余不变”；
- content 不是修改说明。

#### 协议污染

- 无 Markdown 代码围栏；
- 无 JSON 外壳进入 content；
- 无 `<think>`；
- 无 Prompt 内容；
- 无协议字段进入正文；
- 无客户端锚点残留。

#### 确定性退化

- 无整段自重复；
- 无明显重复窗口；
- 无可确定的 source overlap；
- 无 continuation anchor overlap；
- 无近空正文；
- 无明显片段式断尾。

#### 合同结构

- input hashes 正确；
- required IDs 回填；
- rejected scene 未声明使用；
- `unappliedItems=[]`；
- `declaredNewCoreFacts=[]`。

### 15.2 明确删除的旧检查

V5 Validator 不得使用：

```text
repair_candidate_unchanged
repair_non_minimal_rewrite
repair_missing_unaffected_sections
unaffectedRetentionRatio
candidateToWriterHanRatio
openingAnchorRetained
middleAnchorRetained
endingAnchorRetained
targetedSpans
fallbackArtifactStage=writer
```

V3 可以对 V2 做结构性改写。

### 15.3 字数

V3 严重偏短：

```text
final_severe_under_target
```

只产生 warning，不拒绝。

### 15.4 失败行为

```text
V3 eligibility = rejected
run.state = awaiting_regeneration
```

UI：

```text
最终稿未通过技术完整性验证。
本次没有可交付终稿，请重新生成。
```

不得自动展示或采纳 V1/V2。

---

## 16. 输出预算设计

### 16.1 完整正文节点

三个完整正文节点：

```text
draft_writer
revision_writer
final_reviser
```

预算需求：

```ts
targetDemandTokens =
  targetChapterChars
  * estimatedTokensPerHan;

requiredOutputCapacity =
  targetDemandTokens
  * outputHeadroomRatio
  + protocolEnvelopeTokens;
```

请求前必须满足：

```ts
maximumOutputTokens >= minimumOutputTokens
```

以及：

```ts
actualPromptTokens
+ maximumOutputTokens
<= contextWindow
```

### 16.2 Headroom

初始建议：

```ts
outputHeadroomRatio = 1.2
```

用于容纳 JSON envelope、标点、非汉字字符、tokenizer 波动和模型差异。

### 16.3 Architect / Auditor

它们是结构化输出节点，不需要完整章节输出预算，但必须保证 JSON 契约不会因输出上限截断。

### 16.4 V3 Prompt 压缩

Final Reviser Prompt 的优先级：

1. 完整 V2；
2. C2 final obligations；
3. C2 canon/style required corrections；
4. A1 safe scenes；
5. V1 protected passages；
6. 冻结硬 Canon；
7. 原著风格摘要；
8. 用户要求。

压缩顺序：

```text
Level 0：完整内容
Level 1：移除 audit-only warning
Level 2：移除 A1 低优先级 scene
Level 3：protected passage 只保留 excerpt
Level 4：压缩 soft Canon 与历史摘要
```

不得截断：

- 完整 V2；
- blocking/error obligation；
- 用户锁定规则；
- 硬 Canon；
- 最终输出预算。

仍无法容纳：

```text
final_reviser_prompt_budget_exceeded
```

不发请求，进入 `awaiting_regeneration`。

---

## 17. Prompt 去重

每项信息只能有一个权威来源。

Revision Writer 只保留：

```text
V1 完整正文
A1 scene units
冻结约束摘要
用户要求
目标体量
输出契约
```

Final Reviser 只保留：

```text
V2 完整正文
C2 最终义务
A1 安全 scene
protected V1 excerpts
冻结硬约束
用户要求
目标体量
输出契约
```

不要同时注入完整 JSON 和重复格式化列表。

---

## 18. 模型配置映射

现有设置包含：

```text
plannerLlmConfigId
writerLlmConfigId
checkerLlmConfigId
repairLlmConfigId
controlLlmConfigId
```

推荐映射：

```text
Draft Writer          → writerLlmConfigId
Narrative Architect   → plannerLlmConfigId，缺失时继承 writer
Revision Writer       → repairLlmConfigId，缺失时继承 writer
Adversarial Auditor   → checkerLlmConfigId
Final Reviser         → repairLlmConfigId，缺失时继承 writer
```

`controlLlmConfigId` 可作为 Auditor 候选模型。第一版可在 checker/control 中按以下顺序确定：

1. contextWindow 更大；
2. maxOutputTokens 更充足；
3. 配置可用；
4. configId 做稳定 tie-break。

长期可新增 `auditorLlmConfigId` 和 `finalReviserLlmConfigId`，但第一版不建议立即增加设置表字段。

---

## 19. Stage Result Ledger

```ts
interface ContinuationV5StageResult {
  runId: string;
  node: ContinuationV5Node;
  round: 1 | 2 | 3 | 4;

  status:
    | 'queued'
    | 'running'
    | 'success'
    | 'failed'
    | 'interrupted'
    | 'skipped';

  requestReserved: boolean;
  requestCount: 0 | 1;

  modelConfigId: number | null;

  inputHash: string;
  inputTokens: number | null;
  outputTokens: number | null;

  minOutputTokens: number | null;
  maxOutputTokens: number | null;

  outputJson: string | null;
  artifactId: string | null;

  errorCode: string | null;
  errorMessage: string | null;
}
```

`final_validate`：

```text
requestReserved = false
requestCount = 0
modelConfigId = null
```

初始化时一次创建全部节点，保证 Resume 能判断未开始、已 reservation 和已完成状态。

---

## 20. Reservation 与并发

每个物理节点最多一次请求。

进入一轮前先完成两个 reservation，再并行发出请求，避免只发出其中一路。

Round barrier：

```text
Round 2：
draft success
architecture success | degraded fallback

Round 3：
revision success
audit success | degraded fallback
```

总请求计数：

```ts
const physicalCount = stageResults
  .filter(row => row.node !== 'final_validate')
  .reduce((sum, row) => sum + row.requestCount, 0);

if (physicalCount >= 5 && nextNodeIsUnreserved) {
  throw new Error('Continuation V5 物理请求上限已用尽');
}
```

---

## 21. Resume 策略

### Round 1

- V1 已完成，A1 已 reservation 但无结果：不重发 A1，使用 fallback；
- A1 已完成，V1 已 reservation 但无结果：运行失败；
- 两者完成：进入 Round 2。

### Round 2

- V2 已完成，C2 已 reservation 但无结果：使用 fallback C2；
- C2 已完成，V2 已 reservation 但无结果：进入 awaiting_regeneration；
- 两者完成：进入 Round 3。

### Round 3

- V3 artifact 已存在：只恢复 `final_validate`；
- Final Reviser 已 reservation 但无完整 artifact：不重发；
- V3 截断：不解析半截 envelope，不落 artifact。

Validator 是零请求纯函数，可幂等重复执行。

---

## 22. 失败与降级矩阵

| 节点 | 失败后是否继续 | 行为 |
|---|---:|---|
| Draft Writer | 否 | run failed |
| Narrative Architect | 是 | fallback A1，标记 degraded |
| Revision Writer | 否 | awaiting_regeneration |
| Adversarial Auditor | 是 | fallback C2，标记 degraded |
| Final Reviser | 否 | awaiting_regeneration |
| Final Validator | 否 | V3 rejected，awaiting_regeneration |

不自动重试任何 LLM 节点。

---

## 23. Telemetry

运行级：

```ts
{
  workflowVersion: 5;
  physicalRequestCount: number;
  roundsCompleted: number;

  targetHan: number;

  draftHan: number | null;
  revisionHan: number | null;
  finalHan: number | null;

  draftAttainmentRatio: number | null;
  revisionAttainmentRatio: number | null;
  finalAttainmentRatio: number | null;

  architectureDegraded: boolean;
  auditorDegraded: boolean;

  architectureSceneCount: number;
  revisionUsedSceneCount: number;
  finalUsedSceneCount: number;

  auditCanonRequirementCount: number;
  auditStyleRequirementCount: number;
  finalAppliedObligationCount: number;

  finalValidationPassed: boolean | null;
  finalValidationCodes: string[];
}
```

每个完整稿节点记录：

```text
finishReason
promptTokens
completionTokens
actualTokensPerHan
declaredMaxOutputTokens
effectiveMaxOutputTokens
minimumOutputTokens
```

不得记录 API Key、Authorization header、完整 Prompt、完整正文到普通日志或模型思考过程。

---

## 24. UI 改造

结果页按轮展示：

```text
Round 1
- Draft Writer
- Narrative Architect

Round 2
- Revision Writer
- Adversarial Auditor

Round 3
- Final Reviser

Local
- Final Artifact Validator
```

展示三稿体量：

```text
目标：3000 汉字
V1：1243
V2：2360
V3：2885
```

默认只展示 V3。V1/V2 放入折叠的“生成过程审计”，默认不展开，不提供采纳按钮。

V3 失败时：

```text
最终稿未形成可交付结果。
本次不会自动回退到初稿或第一次修订稿。
```

按钮：

```text
重新生成
放弃
```

建议额外展示：

```text
App build commit
Run workflow version
Run created version
```

避免新 APK 打开旧 Run 时误判。


---

## 25. Adoption 语义

只有以下 artifact 可以被采用：

```text
stage = final
eligibilityStatus = eligible
```

`getLatestEligibleArtifact(runId)` 在 V5 中必须只返回 V3。

不得因为 V1/V2 artifact 更新时间更晚、ID 更新或列表排序变化而误选中间稿。

采用前仍执行：

- run 与 artifact 归属校验；
- 章节 revision 冲突校验；
- source / Canon outdated 校验；
- finalizedRevisionHash 校验。

---

## 26. Final Validator 错误码

建议统一使用：

```text
final_output_truncated
final_invalid_json
final_invalid_envelope
final_empty_content
final_partial_output
final_summary_output
final_patch_output
final_protocol_leakage
final_prompt_leakage
final_anchor_leakage
final_self_duplicate
final_source_overlap
final_continuation_anchor_overlap
final_hash_binding_failed
final_required_obligation_unapplied
final_rejected_architect_scene_used
final_declared_new_core_fact
final_unapplied_items
final_severe_under_target            warning only
```

V5 不应继续使用 `repair_*` 作为主错误码，避免 UI、telemetry 和测试将 Final Reviser 错误理解为旧 Repair。

---

## 27. Parser 与安全要求

每个模型输出都必须按以下顺序处理：

1. 检查 `finishReason`；
2. 若为 `length`，持久化截断诊断并停止；
3. 解析 JSON；
4. 验证顶层 object；
5. 验证 schemaVersion；
6. 验证输入 hash 回显；
7. 验证字段类型和数组元素；
8. 计算客户端 hash；
9. 落库。

禁止：

- 解析截断 JSON；
- 对缺字段静默补造可信数据；
- 写死 confidence；
- 补造 evidence；
- 补造 preserveMeaning；
- 信任模型自己声称的输出 hash；
- 将协议字段泄漏进正文；
- 在日志打印完整 Prompt、正文或凭据。

---

## 28. 建议代码结构

新增：

```text
src/services/continuation/generation/continuationV5Runner.ts
src/services/continuation/generation/continuationV5PromptCompiler.ts
src/services/continuation/generation/continuationV5Budget.ts
src/services/continuation/generation/continuationV5Contracts.ts
src/services/continuation/generation/continuationV5ContextViews.ts
src/services/continuation/generation/finalArtifactValidator.ts
```

修改：

```text
src/services/continuation/generation/types.ts
src/services/continuation/generation/generationRepository.ts
src/services/continuation/generation/continuationGenerationRunner.ts
src/services/continuation/generation/continuationContextBuilder.ts
src/screens/continuation/ContinuationResultScreen.tsx
```

可能修改：

```text
数据库 migration
续写设置页
模型配置页
未采纳 run 恢复入口
章节编辑器轮询逻辑
```

V4 文件尽量不直接改造成 V5：

```text
continuationV4Runner.ts
continuationV4PromptCompiler.ts
continuationV4Budget.ts
```

V5 应先独立实现，稳定后再抽取共享函数。

---

## 29. 可复用 V4 能力

可以复用：

- 冻结模型配置；
- Context Snapshot；
- Canon / style 冻结视图；
- `countHanCharacters`；
- token estimator；
- stage reservation；
- hash 工具；
- source overlap；
- continuation anchor overlap；
- duplicate occurrences；
- 截断错误；
- API 调用封装；
- cancellation controller；
- adoption conflict 检查。

需要重新定义：

- stage ledger；
- artifact eligibility；
- Prompt；
- budget；
- Resume；
- UI；
- Final validation；
- V1/V2/V3 关系。

---

## 30. 测试方案

### 30.1 类型与契约

1. workflowVersion 5 可序列化和恢复；
2. V1/V2 eligibility 为 intermediate；
3. 只有 V3 eligible；
4. A1 hash 由客户端计算；
5. C2 hash 由客户端计算；
6. 所有 envelope 绑定正确；
7. 缺 hash / 错 hash 被拒绝。

### 30.2 Round 1

8. Draft 与 Architect 并行发起；
9. 两个节点各只 reservation 一次；
10. Draft 输出完整 V1；
11. Draft `finishReason=length` 不落 artifact；
12. Architect 输出合法 scene units；
13. Architect 失败使用 fallback；
14. fallback 不增加新核心事实；
15. 只有 Draft 失败会阻断 Round 2。

### 30.3 Round 2

16. V2 与 Auditor 并行发起；
17. V2 接收完整 V1+A1；
18. V2 输出完整章节；
19. V2 不允许 Patch；
20. V2 hash 绑定错误被拒绝；
21. Auditor 输出 canon/style/architecture 分区；
22. Auditor 缺 evidence 的项不升级为 blocking；
23. Auditor 绑定错误使用 fallback；
24. Auditor 失败不重试；
25. V2 失败阻断 Round 3。

### 30.4 Round 3

26. V3 只在 V2 ready 后调用；
27. V3 接收完整 V2；
28. V3 接收 C2 blocking/error obligations；
29. V3 不使用 rejected scene；
30. V3 回填 required IDs；
31. V3 `unappliedItems` 非空被拒绝；
32. V3 声明新核心事实被拒绝；
33. V3 `finishReason=length` 不落 artifact；
34. V3 Prompt 超预算时不发请求；
35. V3 只输出完整章节。

### 30.5 Validator

36. 不比较 V3 与 V1/V2 保留率；
37. 不检查最小干预；
38. V3 结构性重写可以通过；
39. V3 片段被拒绝；
40. V3 摘要被拒绝；
41. V3 Prompt 泄漏被拒绝；
42. V3 自重复被拒绝；
43. V3 字数偏短只 warning；
44. Validator 失败不回退 V1/V2；
45. Validator 对同一 V3 hash 幂等。

### 30.6 请求数与并发

46. 成功路径总请求数为 5；
47. 任一路径不超过 5；
48. Round 1 同时最多 2；
49. Round 2 同时最多 2；
50. Round 3 只有 1；
51. Resume 不重复请求；
52. cancel 后不继续下一轮。

### 30.7 UI

53. 按三轮展示；
54. 默认只显示 V3；
55. V1/V2 无采纳按钮；
56. V3 失败显示重新生成；
57. 不出现“回退 Writer 初稿”；
58. 展示 V1/V2/V3 汉字数；
59. 展示 workflowVersion 和 build commit。

### 30.8 V4 回归

60. 历史 V4 run 仍可打开；
61. V4 Resume 不进入 V5；
62. V4 request cap 仍为 4；
63. V4 artifact 查询不误选 V5 intermediate；
64. V1/V2 legacy 不受影响。

---

## 31. 真实 API 验证场景

真实完整 V5 run 最多建议执行 2 次。

### 场景 A：当前容易写短的章节

目标：

```text
3000 汉字
```

期望：

```text
V1 可能偏短
A1 提供足够 scene
V2 明显增加有效事件链
V3 进一步收敛
最终不出现重复心理或环境注水
```

记录：

```text
V1/V2/V3 汉字数
每轮 finishReason
每轮 completion tokens
Architect scene 数量
V2/V3 使用 scene 数量
Auditor requirement 数量
```

### 场景 B：V1 已较完整

期望：

- Architect 不强迫机械扩写；
- V2 不进行无意义大改；
- V3 主要做文风与精度收敛；
- 不因目标字数膨胀到上限；
- V3 仍为完整章节。

以下异常使用 mock / fixture：

- Architect invalid JSON；
- Auditor hash mismatch；
- V2 truncated；
- V3 truncated；
- V3 使用 rejected scene；
- V3 Prompt leakage；
- Resume 中断；
- request cap。

---

## 32. 实施阶段

### Phase 0：代码审查

确认：

- 当前 HEAD 与工作树；
- stage result 表约束；
- artifact stage / eligibility 约束；
- V4 pending run 恢复逻辑；
- Result Screen 对 `repair` 的硬编码；
- adoption 查询；
- `maxRepairRounds` 依赖；
- context automation policy 对固定四节点的假设。

### Phase 1：Contracts 与类型

- workflowVersion 5；
- node types；
- V5 envelopes；
- intermediate eligibility；
- artifact stages；
- parser tests。

### Phase 2：Repository 与 ledger

- 初始化 6 个节点；
- reservation；
- stage ordering；
- V1/V2/V3 artifact；
- Resume；
- adoption 查询。

### Phase 3：Context 与 budget

- 五节点 context views；
- 五节点 budget；
- Round 3 Prompt 压缩；
- preflight；
- output headroom。

### Phase 4：Round 1

- Draft Writer；
- Architect；
- parallel barrier；
- Architect fallback。

### Phase 5：Round 2

- Revision Writer；
- Auditor；
- binding；
- Auditor fallback。

### Phase 6：Round 3

- Final Reviser；
- contract application；
- V3 artifact。

### Phase 7：Validator

- 技术完整性；
- 不回退；
- final eligibility。

### Phase 8：UI

- 三轮；
- 三稿；
- V3 only；
- failure / regeneration。

### Phase 9：验证

- targeted tests；
- typecheck；
- lint；
- `npm run verify`；
- debug APK；
- emulator；
- 真实 API。

---

## 33. 完成标准

只有同时满足以下条件才算完成：

1. 使用 workflowVersion 5；
2. V4 历史运行不受影响；
3. Round 1 为 Draft + Architect 并行；
4. Round 2 为 Revision + Auditor 并行；
5. Round 3 只有 Final Reviser；
6. 总物理请求最多 5；
7. 每节点最多一次；
8. V1、V2 均为 intermediate；
9. 只有 V3 可 eligible；
10. V3 失败不回退 V1/V2；
11. Architect 不写正文；
12. Architect 不分配 Beat 字数；
13. V2 输出完整章节；
14. Auditor 事实与文风分区；
15. Auditor 严格绑定 V1/A1；
16. V3 严格绑定 V2/A1/C2；
17. V3 只输出完整章节；
18. V3 后没有 LLM 请求；
19. Validator 不使用最小干预；
20. Validator 不使用旧稿保留率；
21. Validator 不因字数拒绝；
22. 字数目标动态注入三轮；
23. 严重偏短有清晰 warning；
24. Draft / Revision / Final 都记录 finishReason；
25. 截断不解析、不落 artifact；
26. Prompt 超预算不发请求；
27. UI 默认只展示 V3；
28. 用户不能选择 V1/V2；
29. final rejected 时只允许重新生成或放弃；
30. API Key 不进入日志、源码、测试或快照；
31. targeted tests、typecheck、lint、verify、APK 全部通过。

---

## 34. 最终设计原则

> V1 负责产生文学初稿，A1 负责准备足够叙事容量。  
> V2 负责第一次结构性修订，C2 负责提供独立的最终修订合同。  
> V3 负责完成唯一终稿。  
> 本地 Validator 只验证 V3 是否是技术上完整的交付物，不比较旧稿，不回退旧稿，也不替代语义审查。

> 解决 3000 字目标的正确方式，不是让最后的 Repair 补字，而是让故事在三轮中逐步获得足够的行动、阻力、选择、转折和后果。
