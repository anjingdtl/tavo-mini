# 流水线耗时优化分析（shinewriter）

> 项目：基于 tavo-maker 的 Android-only RN 应用，小说写作工作台  
> 入口：`src/services/pipelineRunner.ts` + `src/services/llm.ts` + `src/services/contextBuilder.ts`  
> 产物：本报告 + 优化清单

## 1. 时间花在哪（实测锚点）

当前流水线执行形态，**以一个章节、full 模式为例**：

```
[草稿 draft]   --串行--> [审阅 review]   --并行--> [终审 proof]
                        [核查 factCheck] --/
```

各阶段单次 LLM 往返耗时（依据 `proofMaxTokens / draftMaxTokens / reviewMaxTokens / factCheckMaxTokens` 估算）：

| 阶段 | 输入 token | 输出 token | 模型 | 估时（GPT-4 / DeepSeek / 本地） |
|------|-----------|-----------|------|-----------------------------|
| draft | 4k–15k | 4k | 主模型 | 30–90s |
| review | 5k（全文 draft） | 1.5k | 主模型 | 20–60s |
| factCheck | 5k+3k = 8k | 1.5k | 主模型 | 20–60s |
| proof | 5k+1.5k+1.5k = 8k 输入 + review/fact 全文 | 4k | 主模型 | 30–90s |
| **合计（full）** | — | — | — | **70–180s（3+ 次往返）** |

加上下文构建（DB N+1 + macroReplace + token 估算）：单章额外 +0.5–3s。  
批次 30 章 × 3 分钟（最优）/ 7 分钟（差模型）= **30 min ~ 3.5 h**。

## 2. 瓶颈清单（按影响排序）

### 2.1 [P0] `stream: false` 全场禁用 — `src/services/llm.ts:134, 206`
两个 `fetch` 调用都把 stream 写死成 `false`。**整段生成期间 UI 收到的是 0 字节**，直到整段返回那一刻才一次性写入 store。  
- 影响：感知延迟 100%+；用户在 30s-60s 内无任何反馈，误以为卡死；AbortController 的 60s 超时容易触发。
- 修复：增加 `callLLMStream` 返回 AsyncIterable + onDelta 回调；UI 实时追加文本和进度。  
- 收益：体感速度提升 3-5 倍（感知）。

### 2.2 [P0] `buildNoteContextOriginal` 循环单查 — `src/services/contextBuilder.ts:402-456`
```ts
for (const note of notes) {
  const content = await db.getNoteContentById(note.id);   // ← N+1
  ...
}
```
每个 note 一次 SQL，10 条 = 10 次往返。同步串行；并发打开还可能把 SQLite 锁死。  
- 修复：增加 `getNoteContentsByIds(ids: number[]): Promise<Map<number,string>>`，一次性 `WHERE id IN (...)`，在循环外一次 `await`。  
- 收益：上下文构建 -50%；批次模式累计节省 5–30s。

### 2.3 [P0] 全场景串行 4 个 LLM 往返 — `src/services/pipelineRunner.ts`
| 模式 | 实际串行次数 |
|------|--------------|
| `noReview` | 1 ✅ |
| `twoStage` | 3 ⚠ |
| `conditional` | 3 ⚠ |
| `full` | 3（review+factCheck 已并行，但 proof 仍是最后一道串行） |

优化方向：
- **[a]** draft 阶段切到流式后，proof 阶段可以与 review/factCheck 并行准备 prompt（即"边审阅边准备 proof"，llm.ts 实现 side-effects）。但 proof 仍需审阅+核查结果，**真正可减的是把 proof 与 review/factCheck 合并**——让 review 直接输出修改建议+改写后的草稿，少一轮。  
- **[b]** 批次模式下让相邻章节并行（限 2-3 并发）；现在 `batchChapterPipeline.ts:63 for...of` 完全串行。  
- 收益：full 模式 -30-40%；批次 -50%。

### 2.4 [P1] 60s fetch 超时偏短 — `src/services/llm.ts:173`
draft 阶段输出 4000 tokens + 1.5 万 tokens 输入，在 GPT-4 / DeepSeek 上常规就要 90-180s。**超时触发后会走到 stream fallback 但当前代码写死 stream:false，fallback 等同无效**——直接抛错，浪费已经花的算力。
- 修复：根据 `max_tokens` 自动估时（≈ `tokens × 30ms/100t + 20s`），上限提到 8 分钟。  
- 收益：减少"假超时"导致的非必要重跑。

### 2.5 [P1] proof 阶段 prompt 过大 — `src/services/pipelineMessages.ts:87-127`
`buildProofMessages` 一次性塞入：**完整 draft + 完整 reviewText + 完整 factCheckText**。  
- 真实有效信号 = review.issues + suggestions + factCheck.errors + warnings（一般几百 token）
- 当前形态：~8000 token 输入里 90% 都是 noise（叙述性建议结论 LLM 会在 proof 里自己再理解一遍）。
- 修复：用 LLM/正则解析 review 的 JSON，取 `issues` 和 `suggestions` 数组**只把改动建议条目**喂给 proof，原文保持不动以减少输入。  
- 收益：proof 输入 -60-70%，LLM 算力 -30-50%；副作用是 proof 输出的"修改角度更明确"。

### 2.6 [P1] `buildContext` 在 `resumePipeline` 重复调用 — `src/services/pipelineRunner.ts:707`
仅 resume `factCheck` 时为取 `contextText` 又跑了一次完整 `buildContext`（含 N+1 查询 + macro replace + token estimator）。
- 修复：在原 `runChapterPipelineInner` 成功进入 draft 后，把 `baseContext` 文本缓存进 `pipeline_tasks` 表的 stageResults 元字段（`buildContextPreview(messages)`）。resume 走捷径直接读。  
- 收益：续跑 -0.5-3s（视项目复杂度）；故障态下流畅性显著改善。

### 2.7 [P1] 全程使用主模型 — `src/services/database.ts:1598-1601`
所有阶段都使用 `llmConfig.model_name`，无法区分 draft/review/proof 用不同模型。  
- 修复：在 `pipeline_config` 表加 `*_model_config_id` 列（指向 `llm_config.id`，schema v11），UI 设置里为 review / factCheck / proof 选"轻量模型"。  
- 收益：审阅/核查 -40-60%（用 gpt-4o-mini / qwen-turbo 这类替代 gpt-4），且更便宜。

### 2.8 [P2] `concurrencyLimiter(250)` 不设防 — `src/services/llm.ts:59`
250 = 实际无限制。App 切后台或快速点多个任务会瞬间发起 50+ 推流。
- 修复：降到 4–8（单 LLM 服务的健康并发上限）；批次内部再多一层节流。  
- 收益：避免 provider 触发 429 / 服务器排队。

### 2.9 [P2] `PipelineForeground.updateProgress` 过频 — `pipelineRunner.ts:307, 343, ...`
每个阶段切一次进度 + 一次文案更新；LLM 调用本身已经在 `setTaskStatus` 同样触发 store 写。两层都做 IPC 序列化。
- 修复：合并 `updateProgress` 调用节奏（节流到 1.5s 一次或每阶段一次）；store 内置防抖。  
- 收益：原生 bridge 调用 -70%，省 CPU。

### 2.10 [P2] `markStaleTasksAsFailed` 阈值 10 分钟 — `pipelineTaskStore.ts:200`
长文本批次生成经常跨分钟边界，10 分钟看似足够但实际不友好。
- 修复：改成"进度心跳"判断：`updateTaskStage` 期间持续 `updatedAt = Date.now()`；frontend 心跳超 25min 才判失败。  
- 收益：长创作场景下少误杀。

### 2.11 [P3] `clipTextTailToTokenBudget` 逐字符估算 — `contextBuilder.ts:627-639`
单字符 token 估算 O(n²)（虽然这里写了 reverse 一次性，但单字符调用 `estimateTokens(char)` 每次都走 Map）。  
- 修复：直接用 `text.length / 2` 估中文 token，`/4` 估英文 token，常数预算剪裁。  
- 收益：上下文尾部裁剪 -95% 耗时（对万字前文）。

### 2.12 [P3] `note style` 懒缓存已实现但首次仍是阻塞 — `styleAnalyzer.ts`
首次仿写必须每篇做一次 LLM 分析。可读取用户的 `enabledNoteIds` 在启动时**预热**：进入写作 Tab 后台预热即可，不要让草稿调用等结果。  
- 收益：首次仿写 -20-40s。

## 3. 推荐落地顺序（影响/工时比）

| 序 | 项 | 类型 | 估时 | 影响 | 是否破坏性 |
|---|----|------|------|------|-----------|
| ① | P0.2 `getNoteContentsByIds` 批读 | DB | 1h | 中 | ❌ |
| ② | P0.1 流式 `callLLMStream` + UI onDelta | API+UI | 2-3d | 高 | ⚠ 用开关灰度 |
| ③ | P1.4 自适应超时 | 1h | 低 | ❌ | |
| ④ | P1.5 proof 输入精简（解析 review JSON） | 0.5d | 中 | ❌ | |
| ⑤ | P2.7 多 LLM 配置（schema v11） | DB+UI | 2d | 中-高 | ✅ 需 migration |
| ⑥ | P0.3b 批次 N 并发（限 2-3） | 1d | 中 | ❌ | |
| ⑦ | P1.6 buildContext 结果缓存到 stageResults | 0.5d | 中 | ❌ | |
| ⑧ | P0.3a 把 review 直接给带改写的草稿 | idea | 3d | 高 | ⚠ 输出质量需验证 |
| ⑨ | P3.11 token 估算替换 | utils | 0.5d | 低 | ❌ |

**零风险快速 PR**：①②③ 周内可合，按顺序上线；其余按需求走。

## 4. 验证手段

- 加 `performance.now()` 标记进 `pipeline_tasks.stageResults[i].durationMs`（已有部分覆盖），前端在 ChapterEditor 用 ⓘ 弹窗显示每阶段耗时和 input/output token。
- 跑批次 5/10/20 章，对比优化前后平均时长。
- 用 `console.timeEnd` 输出三阶段（draft / review / proof）的 server-side 网络耗时，对比到 API 上报时长，判 signal 是否真是 LLM 慢。

## 5. 不要做的事

- ❌ 不要硬塞 prompt cache / 微调，provider 多变且 prompt template 不稳定。
- ❌ 不要试着"并行调用 4 个不同 LLM provider 对比"——除非已经有 AB 框架，否则调试成本极高。
- ❌ 不要把 review/factCheck 也强行流式化——这两阶段本来就是出短 JSON，没必要。
- ❌ 不要把 draft 拆成 4×1000 tokens 拼接（chunk-assemble）；中文小说风格一致性会被破坏，token 边界可能切碎句子。
