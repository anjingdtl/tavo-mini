# 已归档：Canon 原著分析失败修复方案（基于 2026-07-28 真机回归）

> 本文记录的是早期失败时的候选方案，已被实际实现和
> `2026-07-28-canon-analysis-fix-real-device-regression.md` 的真机结论取代。
> 下文关于“等待审核激活”和“关闭 thinking”的文字均不再适用：当前实现会自动启用成功快照，并保留模型的默认思考能力。

## 1. 目标与完成标准

> **实施结论（2026-07-28）：已达成。** 真机 `fast_continuation` 现为
> `awaiting_review / 20/20`，并已审核激活快照。最终实施在 P0/P1 的基础上，
> 对未知的纯枚举描述采用保守 canonical 默认值（不放宽身份或 evidence 校验），
> 并为官方 DeepSeek V4 请求显式发送 `thinking: { type: 'disabled' }`；后者避免
> 默认 reasoning 在生成 JSON 前耗尽预算。错误诊断不再输出 response/reasoning 片段。

目标不是让部分 Canon 条目入库，而是让 `fast_continuation` 在已配置的在线 LLM 上以 **`awaiting_review`** 终态完成；失败时仍必须留下足以定位兼容性问题、但不泄露原著正文或 API Key 的结构化诊断。

本方案保持以下边界：

- 不改 database schema、不新增 migration、不改 `ANALYSIS_REQUEST_GROUPS` 两组协议。
- `validateExtractionResult()` 的公开签名不变；校验器只增加归一化/默认值，不收紧既有接受条件。
- 不把原始 prompt、章节正文或完整模型回复写入日志、错误信息或数据库诊断。
- 不改 review-status 入库语义：任一必需 work item 失败，run 仍应是 `failed`，不能把不完整快照伪装为成功。

验收门槛：

1. `fast_continuation` 的 20 个 work item 都为 `completed`，run 为 `awaiting_review`。
2. `coverage_json.categoryCounts` 的 worldRules、characterProfiles、relationships、experiences、plotThreads 均大于 0，`evidenceValidated >= 1`。
3. 所有失败 work item 都有可读取的**脱敏结构诊断**；`error_message` 不包含 API Key、prompt 或章节正文。
4. 真机完成页显示“分析完成，等待审核激活”，而失败页仍显示“分析失败”。

## 2. 本次失败的事实与根因判断

真机在 deepseek-v4-flash 上两次运行后均为 `failed / chapter_extraction`，最后一次为 10/20 completed、10/20 failed。失败快照虽已有五类数据（2/12/7/8/2）和一条已校验证据，但只覆盖 6/30 个目标章节，不能视为成功。

已确认的三个断点：

| 断点 | 证据 | 影响 |
| --- | --- | --- |
| 失败输出不可取证 | `canonAnalysisService.ts` 的成功分支才将 `JSON.stringify(outcome.result)` 写入 `resultJson`；catch 分支只写 error code/message。真机全部 failed work item 的 `result_json` 都为 NULL。 | 无法从真实模型返回确定需要新增哪个别名，继续补别名只能猜。 |
| 截断与过大输出同时存在 | 一个失败诊断含 `finishReason=length`，且 `max_tokens` 已从 8192 加至 16384。 | 单纯继续抬高 token 不能保证完成，且可能加重耗时和成本。 |
| 重试纠偏信息不够自包含 | 重试只给统计和文本说明；准确字段规范在长章节正文之前，`buildExtractionRetryInstruction()` 还写了“详见下方规范”，而追加的重试文本位于 prompt 末尾。 | 模型在第二、三次仍可能重复非规范字段或枚举，导致同一类全被丢弃。 |

这意味着修复顺序必须是“先可观测、再按证据放宽、同时限制恢复请求的输出体积”，不能直接扩大 `EXTRACTION_FIELD_ALIASES`。

## 3. P0：失败输出的脱敏结构诊断（先做）

**实施状态（2026-07-28）：已完成，待真机取证。** `CanonAnalysisOutputError` 现可携带诊断 envelope；work item 失败分支会将其写入既有 `result_json`。新增单测覆盖三次全丢弃后的诊断结构，并断言角色名、字段值和 evidence 片段不会被持久化。`npm run verify` 已通过。

### 设计

为 `extractMaterialWithLlm()` 的每次已解析 JSON 输出构造一个仅含**形状**的诊断对象，并在最终 `material_failed` 时写入既有 work item 的 `result_json`。不新增列，且只在 `state='failed'` 时采用该格式；现有恢复路径只读取 `completed && resultJson`，不会把诊断当作 Canon 提取结果解析。

建议格式：

```ts
{
  diagnosticVersion: 1,
  kind: 'canon_extraction_validation_failure',
  attempts: [{
    finishReason: 'length' | 'stop' | null,
    responseLength: 1234,
    categories: {
      characters: {
        received: 8,
        accepted: 0,
        dropped: 8,
        firstDropReason: 'characters: canonicalName 为空',
        sampleKeySets: [['name', 'role'], ['character', 'importance']]
      }
    }
  }]
}
```

`sampleKeySets` 最多保留每分类 3 组、每组只保留顶层 key 名并排序；不得保存 key 的值、`quotePreview`、evidence 内容、正文片段或完整 JSON。解析失败时只记录 `responseLength`、JSON 恢复阶段/错误类别和 `finishReason`，不保存 response preview。

定义内部 `CanonExtractionOutputError`（或等价的附加 metadata 类型）以跨越 `extractMaterialWithLlm()` 与 work-item catch 分支传递该诊断。最终 catch 调 `updateWorkItem(..., { resultJson: JSON.stringify(diagnostic) })`；正常 completed 行的 `resultJson` 格式保持不变。

### TDD 用例

1. 全丢弃 JSON 后最终失败：断言 work item 保存的 `result_json` 是诊断 envelope，含 received/dropped/firstDropReason/sampleKeySets，且没有条目值与 quotePreview。
2. malformed JSON：断言 envelope 不含模型原文，只含长度与 parse stage。
3. completed item：断言仍保存既有 `ChapterExtractionResult`，断点恢复行为不变。
4. 重试开始时不得清掉上一轮失败诊断，新的最终失败才覆盖为最新 envelope。

## 4. P1：针对实测变体的最小兼容层

### 取证与决策规则

先用 P0 构建的 diagnostic envelope 在同一 fixture 上重新跑一轮；按每个失败分类的 `sampleKeySets` 建立“实测变体 → canonical 字段”的清单。只有满足以下条件才允许添加到 `EXTRACTION_FIELD_ALIASES` 或枚举归一化表：

1. 字段语义唯一、与 canonical 名一一对应；
2. 诊断中至少出现一次，且有为该变体编写的失败后转绿单测；
3. canonical 字段已经存在时绝不覆盖它；
4. 变体值仍经过既有必填、类型、枚举和 evidence 校验。

可能需要覆盖的不只是名称字段，还包括模型常用的中文/英文枚举值（例如角色重要性、关系公开状态、剧情层级/状态）。这些必须逐项由 P0 证据驱动；不可预先猜测性放宽。

### TDD 用例

- 每个经取证的字段/枚举变体先写一个当前失败的 validator fixture，随后添加一条最小归一化规则使其通过。
- canonical 名优先：同时给出 canonical 和 alias 时，canonical 值必须保留。
- 含未知变体的对象仍应被丢弃并给出 firstDropReason，防止归一化把垃圾输入变成资料。

## 5. P2：把“有效重试”变成可收敛的恢复请求

不改变两组 request group、批次划分或 eight-array JSON 协议，只在 prompt 的重试尾部增加自包含纠偏，并控制输出上限。

### 5.1 自包含 schema 回显

`buildExtractionRetryInstruction()` 应在末尾重新列出**本 work item 所属分类**的 canonical 字段和允许枚举，而不是引用 prompt 前部的“下方规范”。明确要求：

- 未负责数组必须返回 `[]`；
- 负责数组必须使用回显的字段名；
- 对 dropped 分类按 `firstDropReason` 修正；
- 不输出解释、思考过程或重复章节正文。

将该部分作为独立纯函数并以快照单测覆盖，避免与 `EXTRACTION_FIELD_SPEC` 漂移。

### 5.2 针对 length 的受控缩减

当 `finishReason='length'` 时，下一次不能只翻倍 token；还应切换到同一协议下的 recovery output budget：每个负责分类限制条目数、每条仅一条 evidence、description/summary/factSummary 截断到固定短上限。限制值要写成命名常量并由单测固定。

推荐初始上限（待 mock 输出长度验证后定稿）：

- character_state：characters 8、relationships 10、experiences/knowledge/states 各 8；
- world_plot：worldRules 8、plotThreads 8、timelineEvents 10；
- 每条 evidence 最多 1 条，文本字段最多 120 字。

这不改变数据模型或分析协议，只要求模型在一个批次先返回高置信、可验证的代表性事实；后续 batch 仍会补齐覆盖。若 recovery 请求依然 `length`，最终错误需要显示“输出在受控缩减后仍被截断”，便于区分字段兼容问题。

### TDD 用例

1. `length` 后第二次请求同时断言 max tokens 增加、recovery instruction 含 owned-category schema 与条目上限。
2. 非 length 的 validation failure 不应错误启用 output caps，但应附上具体 firstDropReason。
3. request group、material ownership、八数组骨架必须和当前值完全一致。

## 6. P3：端到端验证与发布门禁

实施顺序：P0 → 单测/verify → P1（基于真机诊断）→ 单测/verify → P2 → 单测/verify → 真机回归。

真机回归按以下顺序记录：

1. 新建或清理 fixture 的失败 run，确认一个故意无效 fixture 会写入脱敏 diagnostic envelope。
2. 使用 deepseek-v4-flash 跑完整 `fast_continuation`，等待到终态；不得通过“重试未完成项”无限循环来代替成功。
3. DB 查询 run state、20 个 work item state、snapshot coverage 和 `evidenceValidated`；再从 UI 核对 awaiting_review 文案。
4. 若仍失败，先读取 envelope 取得新的字段/枚举证据，再仅做 P1 的下一条最小别名补充；若是受控缩减后仍 length，则停下报告模型输出能力不足，不继续提高 token 或扩大 prompt。

每一个代码阶段都必须先有失败测试，随后运行 `npm run verify`。不构建 release APK、不改版本号。

## 7. 非目标

- 不将 `failed` 快照自动激活或改为 awaiting_review。
- 不将完整模型回复写入数据库作为调试材料。
- 不改变 Canon 的只读查询边界或 Phase 3 读取方式。
- 不针对本地 llama.cpp 扩展 Canon 分析支持。
