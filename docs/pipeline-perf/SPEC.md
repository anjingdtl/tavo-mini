# ShineWriter 流水线性能优化 SPEC（V2.2.0）

> 项目：shinewriter（基于 tavo-maker 的 Android-only RN 应用）
> 版本目标：2.1.5 → 2.2.0
> 状态：Draft（执行前）

---

## 1. 背景与动机

用户反馈"流水线工作时长是在太久了"。在 V2.1.5 复测，正常模式（full）跑完一章三阶段约需 **45–90s**；长 context + 复杂大纲时多次触达 60s 超时边界并偶发失败。分析代码后定位四类瓶颈：

| 类别 | 位置 | 现象 |
|------|------|------|
| **A. 串行 round-trip** | `llm.ts::callLLMResult` 全程 `stream:false` | 用户必须等 LLM 完整返回才能看到任何反馈，TTFB = 整段响应时长 |
| **B. 阶段依赖过紧** | `pipelineRunner.ts::runChapterPipelineInner` | `twoStage`/`conditional` 模式 review 与 factCheck **串行**执行；只 `full` 模式并行 |
| **C. 单调超时** | `llm.ts` 全局 60s `setTimeout` | 长 draft 阶段（3k–5k tokens）极易触达，全局回退为失败 |
| **D. Context 构建串行** | `contextBuilder.ts::buildNoteContextOriginal` | Note 循环里逐条 `db.getNoteContentById` = N 次 round-trip；`buildMemoryContext` 每次重建 IDF |
| **E. Save 太晚** | `pipelineRunner.ts` saveDraftAndComplete 只在末尾调用 | review/factCheck/proof 任意阶段失败 → 全部 LLM 调用无 replay 价值，resume 重新计算 |

V2.1.1 的流式尝试（commit 96aab88 之前的版本）因**流式 + 60s 共用超时 + AbortError 错乱**被回退。新方案必须把"用户取消 / 请求超时 / 阶段超时 / 连接 watchdog"四类信号彻底分开。

## 2. 目标与非目标

### 2.1 性能目标（数据说话，不空喊）

| 指标 | 现状（V2.1.5） | 目标（V2.2.0） | 验证方式 |
|------|----------------|----------------|----------|
| TTFB（首个 token 抵达 RN） | 等同于整段响应时长 | **< 1.5s**（连接建立后） | 集成测试 + emulator 穿测 |
| `full` 模式总耗时（4 节草稿 × 2k tokens） | ~60–90s | **< 40s** | 集成 benchmark |
| `twoStage` 模式总耗时 | ~30–50s | **< 22s** | 集成 benchmark |
| `note` 注入阶段（10+ 笔记） | O(N) round-trip | 1 次 bulk fetch | 单元测试：注入 50 条笔记 < 100ms |
| Resume 接力耗时 | 必须重跑成功阶段之前的 stage | **跳过所有 success 阶段**，仅接力未完成或失败阶段 | 单元测试 |

### 2.2 非目标（明确不做）

- **不**新增 LLM provider
- **不**改 Worldbook / Character 数据模型
- **不**重构 Zustand store
- **不**改 SQLite schema；现有 schema version 5 不动
- **不**换 React Native 版本
- **不**引入 web worker / native module（除现有 PipelineForeground）

## 3. 方案

### 3.1 架构总览

```
                   ┌──────────────┐
                   │  UI screens  │
                   │ (editor etc) │
                   └──────┬───────┘
                          │ 启动流水线
                          ▼
              ┌───────────────────────┐
              │   pipelineRunner.ts    │
              │   (编排：状态/取消/    │
              │    save 增量/进度上报) │
              └──────┬────────────────┘
                     │
        ┌────────────┼─────────────┐
        ▼            ▼             ▼
   draft (stream)  review        factCheck
        │           ▲              ▲
        │           └────full──────┘
        │           ▲ (并行)
        ▼
   proof  (stream opt)
        │
        ▼
   saveDraft (每次 stage 完成立刻持久化到 pipeline_tasks 表，
             最终 saveDraftAndComplete 写到 chapter)
```

**关键变化**：
1. 草稿阶段可选用流式输出 → 用户即时看到进展
2. review + factCheck 在所有模式下并行
3. 阶段结果随时落到 `pipeline_tasks.stage_results`（已有机制，扩频率）
4. ContextBuilder 注入并行化与缓存

### 3.2 详细设计

#### 3.2.1 新增 `callLLMStream`（流式路径）

文件：`src/services/llm.ts`

```ts
export interface LLMStreamHandlers {
  onChunk: (delta: string) => void;   // 每段增量文本（拼接即完整文本）
  onDone: (result: LLMResult) => void; // 整段完成，附带 usage
  onError: (err: Error) => void;
}

export async function callLLMStream(
  messages: ChatMessage[],
  maxTokens: number | undefined,
  config: LLMCallConfig | undefined,
  handlers: LLMStreamHandlers,
  externalSignal?: AbortSignal,
  options?: { stallTimeoutMs?: number; totalTimeoutMs?: number },
): Promise<LLMResult>;
```

**错误信号分层**（这是 V2.1.1 翻车的根源，必须拆干净）：

| 信号来源 | 判定 | 处理 |
|----------|------|------|
| 用户主动取消 | `externalSignal.aborted === true` | 抛 `Error('已取消')`，`code='cancelled'` |
| 阶段总超时 | `Date.now() - start > totalTimeoutMs` | 抛 `Error('阶段超时')`，`code='timeout'` |
| 连接 stall（无 chunk ≥ N 秒） | watchdog 触发 `controller.abort()` | 抛 `Error('流式响应停滞')`，`code='stall'` |
| HTTP 非 2xx | `!response.ok` | `formatLLMError(status, body)`，原样抛出 |
| SSE 解析失败 | 多帧 JSON 解析失败累计 | 抛 `Error('SSE 解析失败')`，`code='parse'` |

**默认超时**（按 stage 区分，参考 V2.1.0 注释中"流式保活"的意图）：

| Stage | totalTimeoutMs | stallTimeoutMs |
|-------|----------------|----------------|
| `pipeline_draft` | 300_000（5min） | 30_000 |
| `pipeline_review` | 120_000 | 30_000 |
| `pipeline_factcheck` | 120_000 | 30_000 |
| `pipeline_proof` | 300_000（5min） | 30_000 |
| `chat` | 60_000 | 20_000 |

可在 `options` 覆盖；不传则按 scenario 推断。

**降级**：
- `stream=true` 时若 provider 返回 `Content-Type` 不是 `text/event-stream` 或首字节非 `data:`，自动重试一次 `stream:false` 并把累积 delta 抛弃。**前提**：首 chunk 还没开始（否则用户看到一半文本被替换）。

#### 3.2.2 草稿阶段使用流式

文件：`src/services/pipelineRunner.ts`（草稿分支）

```ts
const draftText = await new Promise<string>((resolve, reject) => {
  let buf = '';
  let lastFlush = Date.now();
  const flushIfStale = () => {
    if (buf && Date.now() - lastFlush > 1500) {
      store.updateDraftPreview(taskId, buf);  // 实时刷新草稿预览
      lastFlush = Date.now();
    }
  };
  callLLMStream(
    draftMessages,
    config.draftMaxTokens,
    buildCallConfig(...),
    {
      onChunk: (delta) => {
        buf += delta;
        if (buf.length - lastFlushedLen > 200) {
          store.updateDraftPreview(taskId, buf);
          lastFlushedLen = buf.length;
        }
        flushIfStale();
      },
      onDone: (result) => {
        resolve(result.text || '');
        ...
      },
      onError: (err) => reject(err),
    },
    abortSignal,
  );
}).catch(...);
```

**非流式兼容开关**：当用户配置 `pipeline.streamDraftEnabled === false` 或 provider 在 `llm.ts` 端检测失败 1 次后，回退到 `callLLMResult` 完整调用。**进度心跳**：每 1500ms 仍未 flush 时强制 flush 一次，避免长 delta 卡住 UI。

`AIStreamText` 组件已存在（`src/components/AIStreamText.tsx`），但当前显示规则不接受外部文本增量。需要扩展 props 支持 `text: string` + `isGenerating: boolean` + `onStop`，与 `PipelineProgress` 共用 `pipelineTaskStore.draftPreview`。

#### 3.2.3 review + factCheck 全模式并行

文件：`src/services/pipelineRunner.ts`

`twoStage` 与 `conditional` 当前是 **`draft → review → proof`**（或 **`draft → factCheck → proof`**）严格串行。改写：

- **twoStage**：`draft → [review ‖ proof]`（review 和 proof 同时启动；proof 拿到 draft 后立即开工，review 完成后用 `setReviewFeedback(taskId, text)` 注入 draft preview 中给用户看）
- **conditional**：`draft → [factCheck ‖ proof]`（同上）
- **full**：`draft → [review ‖ factCheck] → proof`（已经是这样，保持）

**为什么 proof 可以并行启动**：proof 的入参只有 draft，不需要 review/factCheck 结果。两者**真的独立**。
但**输出回写顺序**：等 review/factCheck 完成后，重新用"含 review+factCheck 的 prompt"再跑一次 proof？不——我们用**渐进式 proof**：第一次 proof 基于纯 draft 立即开始；如果在它完成之前 review/factCheck 完成，则**用最新 review/factCheck 信息再次调用** proof（但仅一次）。如果 proof 已经完成才收到 review/factCheck 结果，则不再二次调用，避免重复耗 token。

#### 3.2.4 saveDraft 增量落库

文件：`src/services/pipelineRunner.ts`、`src/services/draftService.ts`

每次阶段**成功**完成，立即把该阶段产物持久化到 `pipeline_tasks.stage_results`（已有 `updateTaskStage` 路径），同时把**当前最佳文本**作为"工作进度副本"写到 `drafts` 表：

```ts
// 每个 stage 完成立即写一份副本（仅 stage_text 字段）
store.updateTaskStage(taskId, { stage, text, status: 'success', ... });
// 当前最佳文本：draft 成功后就是 draftText，review/factCheck 成功后是 draftText（它们是"意见"），proof 成功后是 finalText
const bestText = (stage === 'proof' ? finalText : draftText);
await db.saveInProgressPipelineDraft(taskId, bestText);
```

resume 时优先读 `in_progress_pipeline_drafts` 最近一次快照，避免再次调用成功过的阶段（仅在配置标记 `pipeline.skipCompletedOnResume=true` 时启用，默认开启）。

**不创建新表**：复用现有 `pipeline_tasks.stage_results`（已存文本）。在 SQLite 里加一个**轻量视图** `pipeline_in_progress_drafts`：

```sql
CREATE VIEW IF NOT EXISTS pipeline_in_progress_drafts AS
SELECT pt.id AS task_id,
       pt.target_type, pt.target_id, pt.status,
       (SELECT sr.text FROM (
         SELECT stage, text, ROW_NUMBER() OVER (PARTITION BY stage ORDER BY rowid DESC) rn
         FROM (
           SELECT json_each.key AS stage, json_each.value->>'text' AS text, json_each.value->>'status' AS status, json_each.value->>'updatedAt' AS updatedAt
           FROM pipeline_tasks pt2, json_each(pt2.stage_results)
           WHERE pt2.id = pt.id
         ) WHERE status = 'success'
       ) sr WHERE sr.rn = 1 ORDER BY sr.updatedAt DESC LIMIT 1) AS latest_text,
       pt.updated_at
FROM pipeline_tasks pt
WHERE pt.status IN ('drafting','reviewing','factChecking','proofing')
  AND pt.resolved_at IS NULL;
```

→ 不用视图，直接走 SQL：`SELECT stage_results FROM pipeline_tasks WHERE id=?`，按已存文本取最后一个 success 即可。**无需 schema 改动**。

#### 3.2.5 ContextBuilder 并行与缓存

文件：`src/services/contextBuilder.ts`

| 子函数 | 现状 | 优化 |
|--------|------|------|
| `buildCharacterContext` | 串行无循环（已 OK） | 加 **try/catch 单条目失败**不影响其他 |
| `buildNoteContextOriginal` | `for (note) { await db.getNoteContentById(...) }` | 新增 `db.getNotesContentByIds(ids: number[])` bulk API → **1 次 round-trip** |
| `buildWorldbookContext` | 已 OK（DB 返回全集） | — |
| `buildMemoryContext` | `tokenize` + `buildIdf` + `vectorize` 在调用方每次执行 | **同项目 IDF 缓存**：key=projectId, 失效条件=notes-content 写入 |
| `buildNoteContext` 内部串行 noteRetriever / styleAnalyzer | 多条 promise 串行 | 改 `Promise.allSettled`（注：styleAnalyzer 已用 allSettled，沿用） |

**IDF 缓存设计**：
- `src/utils/idfCache.ts` 新文件
- 内存缓存：`Map<projectId, { signature: string, idf: Map<string, number>, expiresAt: number }>`
- signature = `chapters.map(c => c.memory_summary.length).join(',')` ——任何章节 memory_summary 改动即失效
- 持久化层用 SQLite（内存里加 `idf_cache` 表，单 row per project）

**后续优化排队**：同一草案多次调用 buildContext 可缓存 messages（key = chapterId + config hash），本版本**先不实现**，留 TODO。

#### 3.2.6 复用 base context

文件：`src/services/pipelineRunner.ts`

`resumePipelineInner` 当前每次 `buildContext` 都重做（至少 factCheck 阶段）。改为：把首次 `buildContext` 结果保存在 pipeline task 内存（不存 DB，避免 JSON 序列化大），resume 直接复用。

### 3.3 API 兼容性

#### 3.3.1 对外暴露

```ts
// src/services/pipelineRunner.ts
export async function runChapterPipeline(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (info: StageInfo | string) => void,
  options?: { useDraftStream?: boolean },  // ← 新增，UI 可选
): Promise<void>;
```

- `useDraftStream` 默认 `true`；当提供 `false` → 走老的 `callLLMResult`，完全等价 V2.1.5 行为
- `callLLMStream` 是新增导出，老的 `callLLMResult` API 完全不变

#### 3.3.2 UI 行为

- `PipelineProgress` 新增 prop `draftPreview?: string`（可选流式预览）→ `AIStreamText` 已支持文本渲染
- `PipelineConfigScreen` 增加"草稿实时预览"开关（默认开），关闭回到 V2.1.5 行为
- 设置页签名变化：测试快照可能需要更新（`pipelineProgress.test.tsx` 等）

### 3.4 测试策略

每个 phase 落点后：

| Phase | 新增/更新测试 |
|-------|---------------|
| 1. 流式核心 | `__tests__/llm.test.ts` 新增：降级 / stall watchdog / abort 拆分；mock fetch SSE 文本 |
| 2. 草稿流式 | `__tests__/pipelineRunner.test.ts` 用 mock 的 `callLLMStream` 验证 `updateDraftPreview` 被调用 |
| 3. 并行 stage | `__tests__/pipelineRunner.test.ts` 用 `Promise.all` 顺序断言：review 与 proof 同时 in-flight |
| 4. Context 并行 | `__tests__/contextBuilderNoteMode.test.ts` 加压力用例：50 条笔记 < 100ms |
| 5. 全量回归 | `npm test` 全绿 |

### 3.5 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Provider 不支持 SSE | 全程失败 | 自动降级到非流式（首次失败计数 +1 in-memory，per-task） |
| Stall watchdog 误杀 | 慢提供商被截断 | 默认 stall=30s + token 流速自适应（平均 tput < 5 t/s 时延长 30s） |
| AbortError 误判 | 用户取消变成超时 | 4 类错误信号分层标记（见 §3.2.1） |
| 并行 stage 显存翻倍 | OOM | proof 阶段不读完整 review+factCheck 文本，只取摘要（前 1500 字符）作为 prompt 注入 |
| Old UI 看不惯 draftPreview | 用户混淆 | 默认开预览；设置开关可关；首屏 Toast 提示"启用草稿实时预览" |
| iOS 工程被改坏 | 提交污染 | **任何 spec 改动不进入 iOS/ 目录**；grep 验收 `git diff --stat` 不含 ios/ |

## 4. 验收标准

### 4.1 自动化验收

1. `npm run lint` 0 error
2. `npm test` 全绿（包含本次新增测试）
3. `npm run apk:debug` 成功生成 APK
4. `dist/apk/debug/ShineWriter-V2.2.0-debug.apk` 存在

### 4.2 手动 / 模拟器验收

1. **场景 A（full）**：启用 LLM，新建项目 2 章，运行流水线 → 应在 40s 内看到首 token、95s 内收到 final 文本
2. **场景 B（草稿流式）**：运行流水线 → UI 上 `AIStreamText` 应实时显示累积文本，停止后停留在最后状态
3. **场景 C（并行）**：观察 `logcat`，review 与 proof 网络请求时间应**重叠**
4. **场景 D（resume）**：在 proof 阶段杀进程（模拟）→ 重启 app → 应直接接力 proof，前面的 stage 不重跑
5. **场景 E（降级）**：把 base_url 改成不支持 SSE 的 mock 地址 → 流水线仍能跑完（走非流式 fallback）

### 4.3 性能验收（在 emulator 上，用 `npm run android` + 实 LLM）

| 指标 | 阈值 |
|------|------|
| TTFB | ≤ 1500ms |
| full 模式总耗时 | ≤ 60s（V2.1.5 实测 ~80s） |
| 2k token 草稿单阶段 | ≤ 25s（含流式开销） |

## 5. 交付物

1. `src/services/llm.ts` 新增 `callLLMStream` + 配套辅助
2. `src/services/pipelineRunner.ts` 重构编排：草稿流式 + 全模式并行 + 增量落库
3. `src/services/contextBuilder.ts` 注入并行化 + IDF 缓存
4. `src/services/database.ts` 新增 `getNotesContentByIds`
5. `src/utils/idfCache.ts` 新增
6. `src/utils/stages.ts` 抽出 stage 计算（被 pipelineRunner + 测试复用）
7. UI：`PipelineProgress.tsx`、`PipelineResultScreen.tsx` 接入流式预览
8. 更新 `__tests__/` 内对应测试
9. `version.json` → 2.2.0，`package.json` → 2.2.0
10. `dist/apk/release/ShineWriter-V2.2.0-release.apk`（最终交付）

## 6. 变更历史

| 日期 | 作者 | 说明 |
|------|------|------|
| 2026-07-01 | MobileAppBuilder | 初版（v0.1）|
