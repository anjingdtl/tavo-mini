# 续写原著 Canon 分析三连问题修复方案

> 适用版本：V2.10.4 / Schema 24（request_groups_v2 协议）
> 范围：`src/services/continuation/canon/`、`src/services/llm/openAICompatibleProvider.ts`、`src/screens/continuation/canon/CanonAnalysisOverviewScreen.tsx`
> 原则：不改 Canon 只读边界；不改 Schema；校验器只放宽（字段归一化）不收紧；所有失败必须带可诊断信息。

## 0. 症状清单

| # | 症状 | 用户可见文案 |
|---|------|------------|
| S1 | 原著分析间歇性失败 | 「××的模型输出连续 3 次无效：LLM 未返回分析结果。请检查模型是否支持 JSON 输出后重试。」 |
| S2 | 进度到达 100% 后状态文案永久停留 | 「100% · 正在汇总结果」（即使 run 已进入 `awaiting_review`） |
| S3 | 分析"成功"完成后 Canon 资料大面积为空 | 世界观/人物画像/人物关系/人物经历 0 条，仅主线剧情有约 2 条（且无原文证据） |

三个症状相互独立但同源于一条链路：**两组 LLM 请求 → JSON 校验 → 物化入库 → 概览页呈现**。下面逐一定位。

---

## 1. S1 根因：空响应被误报为"模型不支持 JSON"，且重试策略对确定性失败空转

### 调用链证据

1. `canonAnalysisService.ts:1445-1460` `extractMaterialWithLlm()` 调 `callLLMResult(..., maxTokens = 5000/8000, { responseFormat: 'json_object' })`，随后：
   ```ts
   if (!response?.text?.trim()) {
     throw canonOutputError('LLM 未返回分析结果');   // :1460
   }
   ```
2. `openAICompatibleProvider.ts:266-277` 空 `text` 的真实来源被抹平：
   ```ts
   // Strict separation: never fall back reasoning_content into business text.
   const rawContent = message.content;
   const text = typeof rawContent === 'string' && rawContent.trim().length > 0
     ? rawContent : null;
   ```
   以下四种真实情况全部归一为 `text = null`：
   - **a. 推理模型烧光输出预算**：deepseek-reasoner / qwen3-thinking 类模型，`max_tokens=5000` 被 reasoning trace 耗尽，`content` 返回空串且 `finish_reason='length'`。provider 刻意不把 `reasoning_content` 回退为业务文本（设计如此），于是 `text=null`。
   - **b. 网关 200 带错误体**：部分 OpenAI 兼容网关在参数不支持（如 `response_format`）或模型异常时返回 HTTP 200 + `{"error":{...}}`，无 `choices`。`data.choices?.[0]?.message || {}` → `{}` → `text=null`，**真实错误被吞**。
   - **c. content 为数组 parts**：个别网关把 content 返回为 `[{type:'text',text:...}]`，`typeof !== 'string'` → `null`。
   - **d. 本地 llama.cpp 上下文溢出**：`llamaCppProvider.ts:308-310` 把上下文钳到 `Math.min(4096, context_window)`，而 Canon 单批 prompt 含 3 章 × 6000 字 ≈ 1.8 万字符（`:1427-1432`），远超窗口； thinking 模型的输出再经 `stripReasoningBlocks()`（`:111-113`）剥离后为空。
3. 重试空转：`:1472-1489` 三次 attempt 除追加一句"请重新生成完整 JSON"外，请求体完全相同——`max_tokens` 不变、不关闭推理、不缩批。对 a/b/d 这类**确定性失败**，重试 3 次只是把同一错误放大 3 倍，最后在 `:1493` 包装成误导性文案"请检查模型是否支持 JSON 输出后重试"。
4. 诊断缺失：work item 的 `errorMessage` 只有通用文案，不带 `finish_reason`、不带响应片段，`llm_usage_logs` 只记 token 数不记响应内容，用户和开发者都无法区分"模型真不支持 JSON"与"预算不足/上下文溢出/网关报错"。

### 修复方案（P0）

**改动 1：`openAICompatibleProvider.ts` —— 把真实原因浮上来**

- 响应 200 但无 `choices` 且 body 含 `error` 字段时，抛 `formatLLMError(200, JSON.stringify(data.error))`，不再返回 `text=null`。
- `content` 为数组 parts 时拼接 `part.type === 'text'` 的文本后再判定。
- `text` 为空时，`LLMResult` 增加 `emptyReason` 字段：`'length' | 'content_filter' | 'reasoning_only' | 'no_choices' | 'empty'`，依据 `finishReason` 与 `reasoningText` 是否存在填充（`finishReason` 已存在于 `:294`，仅需透传分类）。

**改动 2：`canonAnalysisService.ts` `extractMaterialWithLlm()` —— 分类处理 + 自适应重试**

- 空响应时按 `emptyReason` 给出具体文案：
  - `length` → 「模型输出被 max_tokens 截断（finish_reason=length）」；
  - `reasoning_only` → 「推理模型的 reasoning 占满输出预算，未产生正文」；
  - `no_choices` → 直接抛网关真实错误；
  - 其余 → 「LLM 返回了空响应」。
- `finish_reason='length'` 或 `reasoning_only` 时，下一次 attempt 将 `max_tokens` 翻倍（5000→10000→20000，封顶 `context_window - 输入估算 - 512`）；这是**有效重试**，不计入"相同请求空转"。
- 基线提升：standard `5000 → 8192`，deep `8000 → 16384`（Canon 八数组 JSON 在 3 章输入下 5000 经常性不够）。
- 最终失败时，`errorMessage` 附带诊断尾部：`[finishReason=length, 响应前 200 字符: …]`；只附**响应**片段，绝不附 prompt 与 API Key。

**改动 3：本地模型前置防护（`startAnalysis`）**

- 发起分析前用既有 `estimateMessagesTokens()` 估算单批 prompt；可用输出空间 = `min(context_window, 4096) - 输入估算 - max_tokens - 256`。
- 不足时自动降级：`chaptersPerBatch=1`、章节切片 6000 → 自适应收缩；降级后仍不足则抛出明确错误：「本地模型上下文不足以执行 Canon 分析（估算输入 X tokens / 窗口 Y），请改用在线模型」，禁止进入三次空转。

### 验收（S1）

- 单测：mock provider 分别返回 ① `content:''` + `finish_reason:'length'` ② `content:''` + 有 `reasoning_content` ③ 200 + error body ④ content 数组 parts，断言各自抛出对应具体文案，且 ①② 的第二次 attempt `max_tokens` 翻倍。
- 单测：`startAnalysis` 在本地 4096 窗口 + 3×6000 字章节时抛出上下文不足错误或完成自动降级。
- 真机回归：用 deepseek-reasoner 跑一轮 fast_continuation，不再出现「LLM 未返回分析结果」；失败时 Toast 能说明真实原因。

---

## 2. S2 根因：概览页状态文案只看 work item，不读 run 终态

### 调用链证据

`CanonAnalysisOverviewScreen.tsx:463-496`：进度区仅由 `latestRun.progressTotal > 0` 决定渲染，状态文案 `:488-493`：

```tsx
{workItems.some(item => item.state === 'running' || item.state === 'queued')
  ? '正在处理 Canon 请求组'
  : '正在汇总结果'}
```

- run 进入 `awaiting_review` 后，全部 work item 为 `completed` → 条件恒假 → **永久显示「正在汇总结果」**；`paused`/`failed`/`cancelled` 态同理误显。
- `:98-104` 的 1s 轮询在终态停止，错误文案被定格。
- 注：`stage` 字段（`chapter_extraction`/`evidence_validation`/`finalizing`）已在 run 表持久化（`canonAnalysisService.ts:1219/1249`），UI 完全没用到。

### 修复方案（P1）

`CanonAnalysisOverviewScreen.tsx` 状态文案改为 `state × stage` 二维派生：

| run.state | 文案 |
|---|---|
| `queued` | 排队等待中 |
| `running` + `chapter_extraction` | 正在处理 Canon 请求组 |
| `running` + `evidence_validation` | 正在校验原文证据 |
| `running` + `finalizing` | 正在汇总结果 |
| `awaiting_review` | 分析完成，等待审核激活 |
| `paused` | 已暂停，可继续 |
| `failed` | 分析失败（配合 errorMessage） |
| `cancelled` | 已取消，可从断点继续 |

进度条区域仅在 `state ∈ {queued, running}` 时显示动态文案；终态显示对应静态文案。同时把轮询条件与文案派生收敛到同一个 `runStatusLabel(run, workItems)` 纯函数，便于单测。

### 验收（S2)

- 组件测试：构造 `awaiting_review`/`failed`/`paused`/`running+finalizing` 四种 run，断言文案分别为「分析完成，等待审核激活」/「分析失败」/「已暂停，可继续」/「正在汇总结果」。
- 真机回归：分析完成后概览页不再停留「正在汇总结果」。

---

## 3. S3 根因：prompt 缺元素级字段规范 + 校验器静默丢弃，只有 plotThreads 能存活

### 调用链证据

1. **Schema 23 请求协议**（`types.ts:439-442`）：每批只发 2 组请求 `['character_state', 'world_plot']`，每组要求模型填写 8 数组中对应的 3~5 个。
2. **prompt 缺陷**（`canonAnalysisService.ts:1419-1433`）：`extractMaterialWithLlm()` 的 prompt 只给了数组名骨架 `{"schemaVersion":1,"worldRules":[],"characters":[],…}`，**没有给元素级字段名**。对照旧版单请求 `extractWithLlm()` `:1538-1539` 明确写有：
   > 数组元素字段必须严格使用对应名称：worldRules(category,title,…)；characters(canonicalName,aliases,…)；relationships(sourceName,targetName,…)；…
   > evidence 元素字段：chapterId、chapterPosition、charStart、charEnd、quotePreview。

   这两行在迁移到 request_groups_v2 时被遗漏，模型只能**猜**字段名。
3. **校验器静默丢弃**（`canonJsonValidators.ts` `validateExtractionResult()`）：每条目字段不符即 `continue`，不报错、不计数：

   | 数组 | 必填校验 | 模型常见猜测 | 结果 |
   |---|---|---|---|
   | `characters` | `canonicalName` 非空（`:295-296`） | `name` | 全灭 |
   | `relationships` | `sourceName`+`targetName`（`:318-320`） | `source`/`target`、`from`/`to` | 全灭 |
   | `experiences` | `characterName`+`title`（`:359-361`） | `character` | 全灭 |
   | `knowledge` | `characterName`+`factKey`（`:376-377`） | `character`、`fact` | 全灭 |
   | `states` | `characterName`（`:394`） | `character` | 全灭 |
   | `timelineEvents` | `eventKey`+`title`（`:417-419`） | `key`、`event` | 全灭 |
   | `worldRules` | `title`（`:280-281`） | `title`（可猜中）或字符串数组 | 大部分灭 |
   | `plotThreads` | **`title`（`:338-339`）** | `title` ✓ | **唯一存活** |

   `plotThreads` 只要求最自然的 `title`，`level`/`status` 缺省有兜底（`'subplot'`/`'active'`），因此成为唯一幸存分类——与"主线剧情里有两段内容"完全吻合。
4. **证据同样猜不准**：`parseEvidence()` `:146-163` 要求 `charStart/charEnd` 为合法数字偏移，模型对"全书 UTF-16 绝对偏移"基本靠猜，`charStart=-1` 兜底即丢弃；且证据缺失不阻塞条目入库（`materializeBatchResult` 对空 evidence 数组只是不插入），于是幸存的 2 条 plotThreads 也是无证据的。
5. **失败无声**：物化对空数组不报错、证据插入失败仅返回 `null`（`canonEvidenceService.ts:68-69`）、`listCanonRows` 无 review_status 过滤（`canonReviewService.ts:296-299`，排除 UI 显示问题）——整个 run 以 `awaiting_review` "成功"结束、进度 100%，但 Canon 五表近乎全空，**没有任何一环报警**。

### 修复方案（P0）

**改动 1（治根）：`canonAnalysisService.ts` prompt 补齐元素级字段规范**

- 把 `:1538-1539` 的字段规范行提炼为共享常量 `EXTRACTION_FIELD_SPEC` / `EVIDENCE_FIELD_SPEC`（`canonJsonValidators.ts` 或新 `extractionPromptSpec.ts`），`extractMaterialWithLlm` 与旧版 `extractWithLlm` 共同引用，杜绝再次漂移。
- 按 `materialType` 在规范中高亮本组要填的数组（减少模型把注意力分散到空数组上）。
- 同时明确："不确定的偏移量请给出该章正文内的相对估计值，不要省略 evidence"（引导模型给出可定位的 quote，而非留空）。

**改动 2（兜底）：`canonJsonValidators.ts` 字段名归一化**

新增 `normalizeExtractionItem()`，校验前先按别名表归一（仅放宽、不收紧）：

```
name → canonicalName（characters）
source|from → sourceName；target|to → targetName（relationships）
character → characterName（experiences/knowledge/states）
fact → factKey（knowledge）
key|event → eventKey（timelineEvents）
name → title（worldRules/plotThreads，仅当 title 缺失时）
```

**改动 3（可见性）：丢弃统计上抛**

- 新增 `validateExtractionResultWithStats(raw): { result, stats }`，`stats.dropped` 记录每类 `received/accepted/dropped` 计数及首个丢弃原因；`validateExtractionResult()` 保持签名不变（probe 等旧调用不受影响）。
- `extractMaterialWithLlm()` 当某类 `dropped > 0` 时，把统计写入该 work item 的 `errorMessage`（warning 通道，state 仍为 `completed`），并 `console.warn`；当某类**本应非空却全灭**（received>0 且 accepted=0）时，直接判定本轮输出无效并重试（带统计的重试指令比"重新生成"有效得多）。

### 验收（S3）

- 单测：构造使用 `name`/`source`/`target`/`character`/`fact`/`key` 别名的 mock JSON，断言归一化后各分类全部接受。
- 单测：构造字段完全不符的 JSON，断言 work item 写入 dropped 统计；received>0 且 accepted=0 时触发重试。
- 集成回归：fixture 项目跑完整 fast_continuation，`buildCoverage()` 的 `categoryCounts` 中 worldRules/characterProfiles/relationships/experiences/plotThreads **五类全部 > 0**，且幸存者条目带有 ≥1 条 evidence link。

---

## 4. 实施顺序与影响面

| 序 | 改动 | 文件 | 风险 |
|---|---|---|---|
| 1 | S3 prompt 字段规范 + 归一化 + 丢弃统计 | `canonAnalysisService.ts`、`canonJsonValidators.ts`（+新 `extractionPromptSpec.ts`） | 低：只放宽；prompt +~200 token |
| 2 | S2 概览页文案派生 | `CanonAnalysisOverviewScreen.tsx`（抽 `runStatusLabel` 纯函数） | 低：纯 UI |
| 3 | S1 provider 空响应分类 + 自适应重试 | `openAICompatibleProvider.ts`、`canonAnalysisService.ts`、`llm/types.ts` | 中：provider 为全App共享，需回归普通写作管线；`emptyReason` 为新增可选字段，旧调用方无感 |
| 4 | S1 本地模型前置防护 | `canonAnalysisService.ts`（`startAnalysis`） | 低：只新增前置校验 |

- `max_tokens` 基线提升会抬高单次请求成本，但消除了三次确定性空转，总体更省；`response_format` 不支持的 400 自动降级逻辑（`openAICompatibleProvider.ts:247-263`）保持不变。
- 测试：`__tests__/` 新增/更新 `canonJsonValidators`（归一化+stats）、`canonAnalysisService`（重试策略、降级）、`openAICompatibleProvider`（空响应分类）、概览页组件测试；mock 一律进 `jest.setup.js` 或既有 `jest.mock` 模式；PR 前过 `npm run verify`。

## 5. 不做的事

- 不改 `review_status='pending'` 的入库语义与人工审核激活流程（Spec §8.7）。
- 不改 `ANALYSIS_REQUEST_GROUPS` 两组请求协议与批次/断点续跑机制。
- 不为本地模型强行支持 Canon 分析；上下文不足时明确拒绝而非产出垃圾 Canon。
