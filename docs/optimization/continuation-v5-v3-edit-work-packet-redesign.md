# 续写 V5：以真实 V2 编辑工作包驱动 V3 润色

## 背景与结论

续写 V5 的设计目标不是通过比较 V2/V3 正文、设置硬门槛或拦截候选稿来“逼出差异”。目标是让调用链本身为 V3 提供明确、可执行、基于真实 V2 的编辑任务，从而自然产出经过润色的 V3。

已完成的第一阶段改造将调用顺序调整为：

```text
V1 Draft + A1 Architect（并行）
        ↓
V2 Revision
        ↓
C2 Auditor（审阅真实 V2）
        ↓
V3 Final Reviser
```

仍为五次物理 LLM 调用，不增加额外审查调用。

第二阶段已将 C2 的自由文本引文替换为客户端生成的 V2 片段 ID（`v2-p-xxx`）。C2 只能选择真实 ID；客户端回填该片段的原文、UTF-16 范围与偏移。因此，C2 不再可能用近似转述冒充 V2 锚点。

但是，真实设备验证表明：锚点真实性已经解决，V3 的编辑执行力度仍不足。

## 最近一次设备证据

测试运行：`ct_65a1e68170664feb85ed8eb09daf127e`，APK `V2.11.18`。

| 项目 | 结果 |
| --- | --- |
| 物理请求数 | 5/5 |
| C2 审阅对象 | `revision_1`（真实 V2） |
| C2 风格任务 | 6 条，6 个不同 `v2-p-xxx` ID |
| 锚点真实性 | 6/6 的 `generatedStart/end/excerpt` 均能逐字回读 V2 |
| V3 自报 | 6/6 style requirement、7/7 obligation 已应用 |
| V2/V3 相似度 | 96.91% |
| V2 改动字符 | 254/6865 |
| C2 目标片段改动 | 约 121/585 字符 |
| 未触及任务 | `v2-p-151` 改动为 0 |

这说明当前问题不再是“C2 有没有看见真实 V2”，而是 V3 同时接收全文、风格资料、Canon、A1、JSON 任务和全局指令时，把任务理解成可轻量处理的参考；`appliedStyleRequirementIds` 是模型回执，不能代表实际编辑深度。

原始脱敏证据位于：`test-logs/emulator-v5-anchor-inspect-20260804-213053/`。

## 改造原则

1. 不新增 V2/V3 相似度、最小改动量、任务命中率等结果硬门槛。
2. 不增加 LLM 调用次数，不为验证目的再次调用模型。
3. 不因为模型润色过轻而丢弃 V3、回滚 V2 或强制重跑。
4. 用输入组织和角色指令驱动 V3 的注意力，而不是在输出端设卡。
5. 继续保留现有 JSON 完整正文、hash binding、空正文/协议泄漏等技术安全校验；本方案不改变这些基础安全机制。

## 目标设计：V3 编辑工作包

### 核心变化

V3 不应只看到：

```text
完整 V2
C2 styleAudit JSON
C2 finalObligations JSON
```

而应先看到一个由客户端展开的、按任务排序的“编辑工作包”：

```text
任务 1 / style_1 / v2-p-002
【真实 V2 原段】
...
【诊断】
...
【本段改写目标】
...
【必须保留】
- ...
【执行动作】
将整段重新组织为新的叙述表达；保留事件、人物选择和情绪落点，
不能只删词、改标点或做少量同义替换。
```

每个任务包都使用 `parseContinuationV5AuditEnvelope` 已经解析/回填的 `generatedExcerpt`，不能重新使用模型提供的原始引文。随后再提供完整 V2 作为合成基线。

### 建议的数据结构

不需要迁移数据库或改变 `ContinuationV5AuditEnvelope` 的持久化格式。新增一个仅用于 Final Reviser prompt 的本地派生类型/函数即可：

```ts
interface ContinuationV5EditWorkItem {
  requirementId: string;
  anchorId: string;
  sourceText: string;       // 解析后的真实 V2 原段
  sourceStart: number;
  sourceEnd: number;
  dimension: ContinuationV5StyleDimension;
  description: string;
  rewriteGoal: string;
  preserveMeaning: string[];
  obligationIds: string[];  // 可按 style source / 描述关联，关联不到则 []
}
```

建议新增纯函数：

```ts
buildContinuationV5EditWorkPacket(audit: ContinuationV5AuditEnvelope): ContinuationV5EditWorkItem[]
```

规则：

- 仅纳入 `anchorId != null`、`generatedExcerpt` 非空的 style corrections。
- 保持 C2 原始顺序，最多 6 条。
- `sourceText` 必须等于 C2 解析后合同中的 `generatedExcerpt`。
- 不做相似度检查、替换结果检查或任何 V3 后验判定。
- 兼容旧合同：`anchorId == null` 的任务不进入工作包，仍保留原有 JSON 任务区供历史 resumed run 使用。

### Prompt 编排

在 `compileContinuationV5FinalReviserMessages` 中：

1. 先生成 `editWorkPacket`。
2. 在 user message 内，将工作包放在 `完整 V2` 之前，标题为 `【V3 必须先完成的定点编辑工作包】`。
3. 每项明确写出“执行动作：整体重写本段”，并重申事件、人物选择、因果和情绪落点不可改变。
4. 系统提示词要求按编号依次完成编辑工作包，再将这些改写无缝合成为完整 V3；禁止先全文复述、最后只在少数地方微调。
5. 完整 V2 仍然发送，供模型保持章节连续性和未选片段稳定，不应省略。
6. 保留现有 `C2 finalObligations`、Canon corrections、A1 scenes 等信息，但将它们置于工作包之后，降低对具体编辑任务的注意力稀释。

推荐系统提示词的关键语义：

```text
你先执行下方按编号给出的真实 V2 编辑工作包，再合成完整 V3。
每个工作包的“真实 V2 原段”均由客户端从 V2 回填；它是本次必须重写的源段。
对每一项，必须保留 listed preserveMeaning 的事件、人物选择、因果和情绪落点，
但必须以新的句式、节奏、叙述组织或对白/留白实现 rewriteGoal。
不能用删词、改标点、只替换一两个近义词来完成某项。
完成所有工作包后再通读全文，只对未被选中的片段做必要的衔接调整。
```

注意：这是创作输入指令，不是要求输出 patch、diff 或逐项解释。V3 仍必须输出完整正文 envelope。

## 建议实现位置

| 文件 | 修改内容 |
| --- | --- |
| `src/services/continuation/generation/continuationV5PromptCompiler.ts` | 新增工作包构建/格式化纯函数；调整 Final Reviser 的 system/user message 顺序与措辞。 |
| `__tests__/continuationV5PromptRoles.test.ts` | 覆盖工作包包含真实 V2 原段、位于完整 V2 之前、系统提示要求逐项整体重写。 |
| 可选：`__tests__/continuationV5Contracts.test.ts` | 验证具有 `anchorId` 的解析后 style correction 能被工作包完整映射；旧 `anchorId=null` 合同不抛错。 |
| `CHANGELOG.md` / `README.md` / 版本元数据 | 按仓库发版规则递增补丁版本并通过 `npm run prebuild` 生成 `version.json`。 |

不建议修改：

- `finalArtifactValidator.ts`：不要新增“差异不足”“锚点未改”“任务未命中”等拦截逻辑。
- LLM scheduler / 请求上限：保持 5 次物理调用。
- 数据库 schema / migration：本方案只使用现有 audit envelope 字段派生 prompt。

## 测试与验收

### 自动测试

1. `buildContinuationV5EditWorkPacket`：真实锚点任务映射为 sourceText、范围、目标、保留语义；legacy 空 anchor 被跳过而不异常。
2. Final prompt：工作包在 `完整 V2` 前，包含每项真实原段和“整体改写”动作，保留完整 V2 基线。
3. 原有 C2/V3 hash binding、五次请求工作流、soft-gate 兼容测试继续通过。
4. `npm run verify` 必须通过。

### 模拟器手工验证

新建一条续写运行，读取持久化数据库并记录：

- `adversarial_auditor` 成功、`reviewedArtifactStage=revision_1`、`degraded=false`。
- style tasks 数量 3–6，anchorId 全部非空且不重复。
- 对每条：`v2.slice(generatedStart, generatedEnd) === generatedExcerpt`。
- `final_reviser` 成功且无 fallback。
- 仅作诊断（不作门槛）：统计每个锚点的 V2→V3 改动覆盖情况，人工确认多个完整目标段在句式/节奏/表达上发生可读的重写。

推荐使用现有 Android QA 证据目录流程，避免在根目录写入数据库、提示词或模型响应。

## 非目标

- 不承诺每个 V3 与 V2 必须有固定百分比差异；不同文本的最佳润色幅度不同。
- 不把 V3 改为 patch 输出，也不要求模型输出逐段 before/after 说明。
- 不把模型自报的 `appliedStyleRequirementIds` 当作质量判断依据。
- 不重构 V1、A1、V2 的职责；本次仅提升 C2→V3 的驱动表达。
