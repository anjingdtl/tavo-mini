# 分析原著 Token 优化实施计划

> 日期：2026-07-30 | 基于 `docs/optimization/canon-analysis-token-optimization.md`

## 改动概览

3 处改动，约 150 行代码变更，预计节省 40-50% token 消耗。

| # | 改动 | 涉及文件 | 行数 |
|---|------|---------|------|
| 1 | 合并双调用为单调用 | types.ts, canonAnalysisService.ts | ~80 |
| 2 | 风格 metrics Top-K | styleStatistics.ts, styleAnalysisService.ts, styleAnalysisPrompt.ts | ~50 |
| 3 | 风格 prompt 压缩 | styleAnalysisPrompt.ts | ~20 |

---

## 改动 1：合并双调用为单调用（P0）

### 1.1 types.ts

```typescript
// 旧
export const ANALYSIS_REQUEST_GROUPS = [
  'character_state',
  'world_plot',
] as const;

// 新
export const ANALYSIS_REQUEST_GROUPS = [
  'full_extraction',
] as const;
```

### 1.2 canonAnalysisService.ts — MATERIAL_PROMPTS 新增

```typescript
const MATERIAL_PROMPTS: Record<AnalysisWorkItemType, string> = {
  // ...existing...
  full_extraction:
    '填写所有八个数组。characters/relationships/experiences/knowledge/states 记录人物维度的全部事实；worldRules/plotThreads/timelineEvents 记录世界观与剧情维度的全部事实。',
};
```

### 1.3 canonAnalysisService.ts — OWNERSHIP 新增

```typescript
const MATERIAL_CATEGORY_OWNERSHIP = {
  // ...existing...
  full_extraction: [
    'worldRules', 'characters', 'relationships', 'plotThreads',
    'experiences', 'knowledge', 'states', 'timelineEvents',
  ],
};
```

### 1.4 canonAnalysisService.ts — 输出预算调大

全量提取需要更大的输出空间：

```typescript
const CANON_OUTPUT_BASELINE_TOKENS: Record<AnalysisProfile, number> = {
  quick: 4096,
  standard: 32768,   // 原 16384 × 2（因为一次要装原来两次的内容）
  deep: 65536,       // 原 32768 × 2
};
```

### 1.5 canonAnalysisService.ts — startAnalysis checkpoint

`workItemProtocol` 从 `'request_groups_v2'` 改为 `'request_groups_v3'`。旧 run resume 时通过 `ANALYSIS_REQUEST_GROUPS` 常量仍然能找到 work_items（因为 `full_extraction` 替换了原来的两个），但如果旧 run 使用的是 `character_state` + `world_plot`，resume 时 work_items 类型不变走原路径。

### 1.6 向后兼容

旧 run 的 work_items 类型是 `character_state` / `world_plot`，resume 时：
- `listWorkItems()` 返回旧类型的 items
- `batchItems.map(item => item.materialType).map(runMaterial)` 走原 MATERIAL_PROMPTS
- 新 run 创建时只有 `full_extraction` 类型

---

## 改动 2：风格 metrics Top-K（P1）

### 2.1 styleStatistics.ts — 新增 `summarizeStyleMetrics()`

```typescript
export function summarizeStyleMetrics(metrics: StyleMetrics): string {
  return [
    `全书 ${metrics.chapterCount} 章，共 ${metrics.totalChars} 字符。`,
    `句长：中位数 ${metrics.sentenceLength.median} 字，典型范围 ${metrics.sentenceLength.p25}-${metrics.sentenceLength.p75} 字（${metrics.sentenceLength.count} 句）。`,
    `段长：中位数 ${metrics.paragraphLength.median} 字。`,
    `对话占比：${(metrics.dialogue.ratio * 100).toFixed(1)}%，${metrics.dialogue.turnCount} 轮。`,
    `标点偏好：${topKHistogram(metrics.punctuation.frequent, 10)}。`,
    `情感标点占比：${(metrics.punctuation.emotionalTerminalRatio * 100).toFixed(1)}%。`,
    `人称倾向：${metrics.person.firstPersonRatio > 0.6 ? '第一人称' : metrics.person.firstPersonRatio > 0.1 ? '第三人称为主' : '第三人称'}。`,
    `功能比重：动作${pt(metrics.functionalRatios.action)} 心理${pt(metrics.functionalRatios.psychological)} 环境${pt(metrics.functionalRatios.environment)} 说明${pt(metrics.functionalRatios.expository)}。`,
  ].join('\n');
}
```

### 2.2 styleAnalysisService.ts — 调用 summarizeStyleMetrics

在 `runStyleAnalysis()` 中，`computeStyleMetrics` 后调用 `summarizeStyleMetrics`，将摘要传给 `analyzeWithLlm` 替代全量 JSON。

### 2.3 styleAnalysisPrompt.ts — 用户 prompt 调整

`buildStyleAnalysisUserPrompt` 的 `metricsJson` 参数改为 `metricsSummary: string`（已摘要文本，不再是大 JSON）。

---

## 改动 3：风格 prompt 压缩（P1）

### 3.1 styleAnalysisPrompt.ts — `buildStyleAnalysisSystemPrompt()`

从约 1500 字符压缩到约 800 字符，去重保留关键约束：

```
'你是原著写作风格分析器。输出作为续写 Writer/Checker/Repair 的可操作契约。只依据下方统计与样本判断，禁止外部知识。'
'必须只返回完整 JSON，不要 Markdown/解释。schemaVersion=2，所有字段必须出现。'
'每个字段写成"如何写+频率/范围+触发场景+禁忌"的可执行指令，如"常态12-18字短句；紧张时连续2-4短句"；禁止"语言优美""节奏紧凑"等空泛结论。'
'五项核心维度各≥2条约束：①句式句长/段长/标点组合；②语气基调/情绪递进/克制方式；③用词语域/偏好/禁忌词；④视角叙事距离/对白习惯；⑤节奏场景推进/转场/章末。'
'sceneVariants 覆盖 action/dialogue/emotion/description/transition，各≥2指令+1禁忌。'
'characterVoices 只描述抽象语言习惯，禁止复现原句。confidence∈[0,1]。'
SKELETON
```

---

## 测试验证计划

1. `npm run verify` — lint + typecheck + 全量 Jest 测试
2. 重点验证：
   - `canonAnalysisTokenBudget.test.ts` — 输出预算变化不影响
   - `canonAnalysisLifecycle.test.ts` — 新 work_item 类型
   - `canonLlmAnalysis.test.ts` — full_extraction prompt 正确性
   - 风格分析相关测试（如有）
3. `npm run apk:debug` — 构建 debug APK
4. 模拟器安装验证基础流程

---

## 回滚预案

所有改动通过 git 管理。如有问题：
- `git revert` 回滚到改动前 commit
- 旧 run 的 resume 逻辑不变，不受新 work item 类型影响
