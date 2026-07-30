# 分析原著 Token 消耗优化报告

> 分析时间：2026-07-30 | 目标：减少"分析原著"功能的 token 消耗

---

## 1. Token 消耗全景

### 1.1 调用链

```
用户触发分析
  ├─ startAnalysis() → 创建 N 个 batch（每批 3~20 章）
  │    每个 batch 创建 2 个 work_item（character_state + world_plot）
  │    总 work_item 数 = batches × 2
  │
  ├─ processAnalysisRunInner() → 遍历每个 batch
  │    └─ 每个 batch 并行发起 2 次 LLM 调用：
  │         ├─ extractMaterialWithLlm(chapters, profile, modelConfigId, 'character_state')
  │         │    发送: 5 个类别（characters/relationships/experiences/knowledge/states）
  │         └─ extractMaterialWithLlm(chapters, profile, modelConfigId, 'world_plot')
  │              发送: 3 个类别（worldRules/plotThreads/timelineEvents）
  │         **两调用收到的章节正文完全相同！**
  │
  ├─ runStyleAnalysis() → 1-N 次 LLM 调用（单次或 map/reduce）
  │    发送: 全书统计指标 JSON + 分层风格样本
  │
  └─ activateSnapshotAndStyleProfile() → 原子激活
```

### 1.2 规模估算（以 100 章、本地模型为例）

| 指标 | 数值 |
|------|------|
| 每批章节数 | 3（本地模型固定） |
| 总批次数 | ~34 |
| 每批 LLM 调用数 | 2（×2 重复） |
| Canon 提取总调用 | **~68 次** |
| 重试上限 | 3 次/调用 |
| 风格分析调用 | 1~N 次 |
| 每调用 prompt overhead | ~600 tokens |
| 每调用重复章节正文 | 完全相同 |

### 1.3 100 章在线模型示例（128K 窗口）

| 指标 | 数值 |
|------|------|
| 每批章节数 | ~15-19（动态计算） |
| 总批次数 | ~6 |
| Canon 提取总调用 | **~12 次** |
| 相对本地模型节省 | 82% |

---

## 2. 核心问题诊断

### 问题 1（最大浪费）：每 batch 2 次 LLM 调用发送完全相同的章节正文

**代码位置**：`canonAnalysisService.ts` 第 1591-1661 行

```typescript
// 每个 batch 的 runMaterial 调用两次，传入完全相同的 slice
const settled = await Promise.allSettled(
  batchItems.map(item => item.materialType).map(runMaterial),
);
```

- `character_state` 和 `world_plot` 各收到完全一样的章节正文
- 每章附带 `(chapterId=..., position=..., bodyStart=..., bodyEnd=...)` 元数据
- **浪费比例：~50% 的章节正文传输量（对本地模型尤为严重）**

### 问题 2：EXTRACTION_FIELD_SPEC 包含所有 8 个类别

**代码位置**：`extractionPromptSpec.ts` 第 17-27 行 + `canonAnalysisService.ts` 第 2234 行

```typescript
// 无论哪个 materialType，都发送完整的 8 类别字段规范
const prompt = [
  // ...
  EXTRACTION_FIELD_SPEC,  // 全部 8 个类别的字段定义，~400 字符
  EVIDENCE_FIELD_SPEC,    // ~80 字符
  EXTRACTION_JSON_SKELETON, // 包含所有 8 个空数组，~120 字符
  // ...
];
```

即使 `world_plot` 只负责 3 个类别（worldRules/plotThreads/timelineEvents），仍然发送 characters/knowledge/states 等的字段规范。

### 问题 3：JSON skeleton 强制所有 8 个数组出现

```typescript
// EXTRACTION_JSON_SKELETON 要求所有数组非 null
'JSON 结构：{"schemaVersion":1,"worldRules":[],"characters":[],"relationships":[],"plotThreads":[],"experiences":[],"knowledge":[],"states":[],"timelineEvents":[]}。'
```

模型必须在输出中包含 5 个空数组（针对 `world_plot`）或 3 个空数组（针对 `character_state`），每条空数组约 15-20 字符的 token 消耗。虽然每个空数组开销不大，但乘以调用次数（68 次）会累积。

### 问题 4：重试时完整 prompt 重发

**代码位置**：`canonAnalysisService.ts` 第 2265-2277 行

```typescript
for (let attempt = 1; attempt <= 3; attempt += 1) {
  const retryInstruction = attempt > 1
    ? buildExtractionRetryInstruction(lastDroppedStats ?? undefined)
    : '';
  const response = await callLLMResult(
    [{ role: 'user', content: `${prompt}${retryInstruction}` }],
    // ...
  );
}
```

重试时整个 prompt（包括章节正文）重新发送。当模型输出 JSON 格式错误时，3 次尝试意味着 3 倍的全部传输。

### 问题 5：风格分析 system prompt 非常冗长

**代码位置**：`styleAnalysisPrompt.ts` 第 52-77 行

```typescript
export function buildStyleAnalysisSystemPrompt(): string {
  return [
    '你是严谨的原著写作风格分析器...',
    // 9 条详细要求，每条约 30-80 字
    // 完整 JSON SKELETON（约 1200 字符）
  ].join('\n');
}
```

system prompt 约 1500+ 字符，加上 user prompt 中的完整 metrics JSON 和样本文本，每次风格分析调用消耗大量 token。

### 问题 6：风格分析的 metrics JSON 可能很大

`computeStyleMetrics(chapters)` 对全文计算统计指标（句长分布、词汇频率、标点统计等），整个 JSON 序列化后可能达数 KB 甚至数十 KB，直接嵌入 prompt 中发送。

---

## 3. 优化方案（按收益排序）

### 优化 1：合并 character_state + world_plot 为单次 LLM 调用 ⭐⭐⭐

**收益：减少 50% 的 LLM 调用次数和章节正文传输**

**当前**：每 batch 2 次并行调用，正文重复发送 2 次  
**优化后**：每 batch 1 次调用，一次提取全部 8 个类别

**实现方式**：
- 新增 `ANALYSIS_REQUEST_GROUPS` 常量 `'full_extraction'`
- 合并 `MATERIAL_PROMPTS` 为：
  ```
  '只输出所有八个数组。characters/relationships/experiences/knowledge/states 是人物维度；worldRules/plotThreads/timelineEvents 是世界观与剧情维度。'
  ```
- 或将现有的 2 次并行调用改为顺序：第一次调用后，用其输出作为第二次调用的上下文摘要，从而让第二次调用只需接受摘要而非全文。

**风险评估**：
- 对于强大模型（DeepSeek V4、GPT-4 等）：单一调用处理 8 类别完全可行
- 对于小型本地模型：可保留现有的分拆逻辑，在线模型则合并

**保守方案**：新增一个 `full_extraction` work_item 类型，在 `ANALYSIS_REQUEST_GROUPS` 中替换原来的两个。保留旧逻辑作为 fallback。

### 优化 2：按需裁剪 EXTRACTION_FIELD_SPEC ⭐⭐

**收益：每调用节省约 150-250 字符的 prompt**

只发送当前 materialType 负责的字段规范，不发送无关字段。

```typescript
// 新增函数
function buildScopedFieldSpec(materialType: AnalysisWorkItemType): string {
  const owned = new Set(MATERIAL_CATEGORY_OWNERSHIP[materialType]);
  const lines: string[] = [];
  if (owned.has('worldRules')) lines.push('worldRules(category,title,description,constraintLevel,confidence,evidence)');
  if (owned.has('characters')) lines.push('characters(canonicalName,aliases,description,importance,confidence,evidence)');
  // ...
  return '数组元素字段必须严格使用对应名称：' + lines.join('；') + '。';
}
```

### 优化 3：按需裁剪 JSON SKELETON ⭐

```typescript
function buildScopedJsonSkeleton(materialType: AnalysisWorkItemType): string {
  const owned = new Set(MATERIAL_CATEGORY_OWNERSHIP[materialType]);
  const arrays = ALL_CATEGORIES.map(cat =>
    owned.has(cat) ? `"${cat}":[...]` : `"${cat}":[]`
  );
  return `JSON 结构：{"schemaVersion":1,${arrays.join(',')}}。` +
    (materialType === 'full_extraction' ? '' : ' 仅填写非空数组对应的分类。');
}
```

### 优化 4：风格分析 prompt 压缩 ⭐⭐

**当前 system prompt**：约 1500 字符  
**压缩目标**：约 800 字符，保持关键约束

```typescript
export function buildStyleAnalysisSystemPrompt(): string {
  return [
    '你是原著风格分析器，输出作为续写的可操作契约。只依据下方统计与样本判断，禁止外部知识。',
    '必须只返回 JSON，不要 Markdown。schemaVersion=2，所有字段必须出现。',
    '每个字段写成"如何写+范围/频率+触发场景+禁忌"的可执行指令格式（如"常态12-18字短句；紧张时连续2-4短句"），禁止"语言优美"等空泛结论。',
    '五项核心维度必须写具体：①句式（句长/段长/标点）；②语气（基调/情绪递进）；③用词（语域/偏好/禁忌词）；④视角（叙事距离/对白习惯）；⑤节奏（场景推进/转场/章末）。每项≥2条约束。',
    'sceneVariants 覆盖 action/dialogue/emotion/description/transition，每条≥2指令+1禁忌。',
    'characterVoices 只描述抽象习惯，禁止复现原句。confidence∈[0,1]。',
    STYLE_PROFILE_JSON_SKELETON,
  ].join('\n');
}
```

**省约 40%**，即每次风格分析节省 700 字符 prompt tokens。

### 优化 5：风格分析 metrics JSON 摘要化 ⭐⭐

当前 `metricsJson` 是全量统计指标的序列化结果，可能非常长。

**方案 A**：提取关键指标摘要，减少到 1-2KB 以内  
**方案 B**：将 metrics 分为"核心指标"（必须发送）+ "详细指标"（可选，仅在 map/reduce 时发送）  
**方案 C**：用自然语言摘要替代原始 JSON，如 "平均句长 18 字，对话密度 35%，标点偏好：逗号>句号>省略号..."

### 优化 6：增量分析（长尾优化）⭐

对于已分析过的原著，新增章节时只分析增量部分，而非全量重分析。

**实现思路**：
- 记录上次分析的 `endPosition`
- 新增章节时只创建覆盖新章节的 batch
- 合并新旧 Canon 快照

### 优化 7：弱化 evidence quotePreview 要求 ⭐

当前要求每条 evidence 必须附带 ≤160 字原文引用。对于 token 敏感的场景，可以：
- 降低到 80 字
- 或只在 full_canon/deep 模式下要求完整引用，standard 模式下降级为章节位置引用

---

## 4. 推荐实施优先级

| 优先级 | 优化项 | 预估节省 | 风险 |
|--------|--------|----------|------|
| P0 | 合并 2 次 LLM 调用为 1 次（在线模型） | **~50%** | 低（强模型已验证） |
| P1 | 风格分析 prompt 压缩 | **~20%** 风格分析调用 | 低（纯文本优化） |
| P1 | 风格分析 metrics 摘要化 | **~30-60%** 风格分析调用 | 中（需验证摘要质量） |
| P2 | 按需裁剪 FIELD_SPEC + JSON_SKELETON | **~5-10%** 每调用 | 极低 |
| P3 | 增量分析 | **变化量**（重分析场景） | 中（需新增合并逻辑） |
| P3 | 弱化 evidence quote | **~5%** 每调用输出 | 低（降低约束即可） |

---

## 5. 具体实施建议

### 5.1 合并 LLM 调用（P0）

```typescript
// types.ts 新增
export const ANALYSIS_REQUEST_GROUPS = [
  'full_extraction',  // 新：一次提取全部 8 个类别
] as const;

// canonAnalysisService.ts MATERIAL_PROMPTS 新增
const MATERIAL_PROMPTS: Record<AnalysisWorkItemType, string> = {
  // ...existing entries...
  full_extraction:
    '填写所有八个数组。characters/relationships/experiences/knowledge/states 记录人物维度的全部事实；worldRules/plotThreads/timelineEvents 记录世界观与剧情维度的全部事实。',
};

// MATERIAL_CATEGORY_OWNERSHIP 新增
const MATERIAL_CATEGORY_OWNERSHIP = {
  // ...existing entries...
  full_extraction: [
    'worldRules', 'characters', 'relationships', 'plotThreads',
    'experiences', 'knowledge', 'states', 'timelineEvents',
  ],
};
```

同时增大 `full_extraction` 的 `CANON_OUTPUT_BASELINE_TOKENS`：
```typescript
const CANON_OUTPUT_BASELINE_TOKENS: Record<AnalysisProfile, number> = {
  quick: 8192,
  standard: 24576,  // 原来 16384 × 1.5
  deep: 49152,      // 原来 32768 × 1.5
  full_extraction: ... // 如需要独立档位
};
```

### 5.2 向后兼容

保留 `character_state` + `world_plot` 的旧逻辑用于 `workItemProtocol: 'request_groups_v2'` 的 resume 场景。新 run 使用 `workItemProtocol: 'request_groups_v3'`。

---

## 6. 预期效果

以 100 章、在线模型为例：

| 场景 | 优化前 | 优化后 | 节省 |
|------|--------|--------|------|
| Canon 提取 LLM 调用 | 12 次 | 6 次 | **50%** |
| Canon 提取章节传输 | 6 批×2=12 次 | 6 次 | **50%** |
| Canon prompt overhead | 12×600=7200 tokens | 6×600=3600 tokens | **50%** |
| 风格分析 system prompt | ~1500 字符 | ~800 字符 | **~47%** |
| 风格分析 metrics JSON | ~5-50KB | ~1-2KB | **60-95%** |
| 总 token 消耗估算 | - | - | **约 40-50%** |

---

## 7. 涉及文件清单

| 文件 | 需修改内容 |
|------|-----------|
| `src/services/continuation/canon/types.ts` | 新增 `full_extraction` 常量 |
| `src/services/continuation/canon/canonAnalysisService.ts` | 新增 MATERIAL_PROMPT、OWNERSHIP、output baseline |
| `src/services/continuation/canon/extractionPromptSpec.ts` | 新增按需裁剪的 prompt builder |
| `src/services/continuation/styleProfile/styleAnalysisPrompt.ts` | 压缩 system/user prompt |
| `src/services/continuation/styleProfile/styleAnalysisService.ts` | metrics 摘要化 |

---

## 8. 不良影响评估

> 核心原则：现有 2 调用分拆设计（`request_groups_v2`）不是随意为之，而是对旧版单调用全量提取（`extractWithLlm`，使用 5000-8000 token 输出预算）的质量修复。优化必须在不倒退质量的前提下进行。

### 8.1 P0：合并 character_state + world_plot → 单次 full_extraction

**历史���景**：代码中遗留了一个 `extractWithLlm()` 函数（第 2529 行），它本来就是对单次调用提取全部 8 个类别的尝试。它在 commit `2966836` 被 `request_groups_v2`（当前 2 调用分拆）取代。原因有两方面：

1. **输出预算不足**：旧版单调用只用 5000-8000 token 输出预算，8 个类别共享这点空间，必然不完整
2. **字段规范缺失**：S3 bug（commit `f761d3e`）暴露了分拆模式下 prompt 只列了数组名而没有元素级字段规范，导致模型猜错字段名被静默丢弃

**当前单调用与旧版的关键差异**：

| 维度 | 旧版 extractWithLlm | 当前 grouped 2 调用 | 提议的 full_extraction |
|------|---------------------|---------------------|----------------------|
| 输出预算 | 5000-8000 | 16384-32768 × 2 | 32768（deep）/ 24576（standard��� |
| 字段规范 | 无（当时缺失） | 完整 EXTRACTION_FIELD_SPEC | 沿用完整字段规范 |
| 重试逻辑 | 无 | 3 次 + stats-aware | 沿用 |
| thinking 模式 | 不支持 | 支持（preserve thinking） | 沿用 |

**可能的不良影响**：

a) **类别之间的注意力竞争（中等风险）**  
   当 8 个类别挤在一次调用中，模型可能产生"锚定效应"——优先提取它认为最重要的类别（通常是 characters 和 plotThreads），而削弱对 states、knowledge、timelineEvents 等结构化要求更高的类别的投入。当前分拆模式下，每个调用只负责 3-5 个类别，注意力更聚焦。

   **缓解措施**：
   - 在 prompt 中明确要求各分类的条目数量平衡
   - 增大输出预算（deep 用 49152，standard 用 24576）
   - 新增 post-hoc 质量检查：当某类别条目数为 0 但其他类别丰富时，自动 fallback 到分拆模式单独补提取该类别

b) **输出 token 截断（低-中风险）**  
   如果一 batch 的章节内容非常丰富（人物多、关系复杂、剧情密集），8 个类别合并后的 JSON 可能超过输出预算上限，触发 `finish_reason=length`。
   
   **缓解措施**：max_tokens 自适应扩大到 `baseline * 2` 或 `maxTokenCeiling`，当前重试逻辑已支持预算翻倍

c) **本地小模型质量退化（中-高风险）**  
   本地 llama.cpp 模型（3B-7B 级别）的推理能力有限，让它同时关注 8 个维度的结构化提取可能超出能力范围。相比之下，当前分拆成 5+3 个类别更容易被小模型消化。

   **缓解措施**：**关键——保留分拆模式作为本地模型的默认行为**，`full_extraction` 仅对 `providerType !== 'llama_cpp'` 的在线模型启用。这是最安全的做法。

d) **不可回退的架构变更（低风险）**  
   `ANALYSIS_REQUEST_GROUPS` 是 run 创建时就固定的。如果按在线/本地分开策略，一个 run 要么是全量提取要么是分拆提取，不能在中途切换。这会影响 resume 逻辑，需要在 checkpoint 中记录 `workItemProtocol: 'request_groups_v3'`。

   **缓解措施**：正确实现 checkpoint 版本兼容，旧 run resume 走旧路径

### 8.2 P1：风格分析 prompt 压缩

**可能的不良影响**：

a) **风格指令可操作性下降（中等风险）**  
   当前 prompt 中反复强调"可操作的写作指令"而非"语言优美"等空泛结论，这种强调不是冗余而是防退化机制。压缩后如果去掉了关键的约束措辞，模型可能会回归到生产空泛评价的本能。

   **具体风险举例**：
   - 去掉 `"常态 12-18 字短句；紧张时连续 2-4 短句"` 这类示例 → 模型可能输出 `"句式简洁"`
   - 去掉 `"禁止输出'维持原样'、'无变化'"` → 模型可能在信息不足时偷懒

   **缓解措施**：
   - 保留所有"禁止"类约束（它们是 prompt engineering 中最有效的部分）
   - 压缩示例但保留示例的精神（用更短的同义表述）
   - 灰度验证：压缩前后对同一本书跑两轮，盲评风格画像的可操作性和具体性

b) **多语言混杂风险（低风险）**  
   当前 prompt 用中文写了大量约束，如果压缩导致重要的否定句式（"禁止""不得"）丢失，模型可能误用英文输出某些字段。

   **缓解措施**：所有"禁止/不得/只允许"保留原样

### 8.3 P1：风格分析 metrics JSON 摘要化

**可能的不良影响**：

a) **统计精度损失（中等风险）**  
   `computeStyleMetrics(chapters)` 产出的全量 JSON 包含精确的句长分布直方图、词汇频率表、标点统计等。如果摘要化，模型失去了精确数字依据，只能基于模糊描述做判断。

   **具体风险举例**：
   - 原文有双峰句长分布（短句很多 + 偶尔长句），摘要只说"平均 18 字" → 模型无法生成 `"常态 12-16 字短句，关键场景出现 30-50 字长句"` 这类精确约束
   - 摘要化可能丢失标点偏好中的关键信号（如某个作者偏爱分号连接独立句）

   **缓解措施**：
   - 不用自然语言摘要，而是提取前 N 个关键统计指标（Top-K 策略）：
     ```
     - 句长 P25/P50/P75/P95 分位数（而非完整直方图）
     - 前 20 高频词 + 前 10 高频标点
     - 对话占比、描写占比、叙述占比
     - 平均段长
     ```
     这样保真度最高，体积从数十 KB 降到约 1KB
   - 或者，用 LLM 先做一轮"风格统计摘要"，把 metrics JSON 作为 user message 而非 system prompt 发送（user message 不计入某些模型的 thinking budget）

### 8.4 P2：按需裁剪 FIELD_SPEC + JSON SKELETON

**不良影响：几乎没有**。

唯一微小的风险是：如果 prompt 中只列出了 3 个类别但模型仍然输出其他 5 个（因为数据中有相关事实），validator 会 drop 这些合法条目。但 MATERIAL_CATEGORY_OWNERSHIP 已经在 `onlyMaterial()` 中过滤了——当前代码在最终结果中只保留该 work item 负责的类别，无关类别的条目本来就会被丢弃。所以裁剪 prompt 不会改变最终结果。

### 8.5 P3：增量分析

**可能的不良影响**：

a) **跨批次人物关系断裂（高风险）**  
   人物跨越新旧批次的边界时，关系提取可能不完整。例如：
   - 第 1-50 章分析了人物 A→B 的关系
   - 第 51-60 章新增分析中人物 C 出场，与 A 有互动
   - A→C 的关系被正确提取，但 "B→C" 或三角关系完全丢失

   **缓解措施**：
   - 增量分析时附带一份已有人物列表和关系摘要作为上下文
   - 或增量分析后做一次"跨批次关系补全"LLM 调用

b) **剧情线索断连（中-高风险）**  
   长线伏笔可能横跨旧批次尾和新批次头，增量分析时不知道前面的铺垫，可能把伏笔当成新线索误判。

   **缓解措施**：增量分析时注入前一批次的 plotThreads 摘要作为 context

c) **timelineEvents 时间线碎片化（中等风险）**  
   新增章节的时间线事件可能与已有事件产生新的时间关系，增量分析无法感知。

   **缓解措施**：增量分析后做一次轻量的"时间线合并"检查

### 8.6 P3：弱化 evidence quotePreview（160→80 字）

**可能的不良影响**：

a) **证据定位失败率上升（中风险）**  
   `resolveExtractionEvidenceAgainstChapters()` 使用精确匹配 + LCS 近似匹配（要求 ≥75% 相似度，≥6 字符）。160 字→80 字意味着模型给的 quote 更短，但验证匹配对长度的要求不变（≥6 字符），所以直接匹配不受影响。

   真正的问题是：短 quote 更容易在原文中出现多处匹配（歧义），导致证据定位到错误的章节位置。这会使得 `charStart/charEnd` 偏移量不准确。

   **缓解措施**：只在 `standard` 档降级，`deep` 档保持 160 字

### 8.7 汇总：风险矩阵

| 优化项 | 不确定风险 | 质量风险 | 兼容性风险 | 综合建议 |
|--------|-----------|---------|-----------|---------|
| P0 合并 LLM 调用 | 中 | 中（本地）<br>低（在线） | 低 | **按 provider 分策略执行** |
| P1 风格 prompt 压缩 | 低 | 中 | 无 | 灰度验证后执行 |
| P1 metrics 摘要化 | 低 | 中 | 无 | Top-K 策略替代全量 JSON |
| P2 裁剪 FIELD_SPEC | 极低 | 极低 | 无 | 直接执行 |
| P3 增量分析 | 高 | 高 | 中 | 暂缓，需先设计跨批次上下文注入 |
| P3 弱化 evidence | 低 | 低 | 无 | deep 档保持 160，standard 可降
