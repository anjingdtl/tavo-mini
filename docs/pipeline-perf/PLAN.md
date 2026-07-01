# ShineWriter 流水线性能优化 执行计划（V2.2.0）

> 配套 SPEC.md。本文件专注于**执行顺序、交付物拆分、验收手段**。
> 编码遵循：prettier 单引号、无尾分号（项目已有 prettierrc）、Lint + 测试必须先绿再 commit。

## 总览

```
[Phase 0] 规约与基线
    ↓
[Phase 1] 流式核心（callLLMStream + 错误信号分层）
    ↓
[Phase 2] 流水线接入草稿流式 + 增量落库
    ↓
[Phase 3] review/factCheck 全模式并行
    ↓
[Phase 4] ContextBuilder 并行与 IDF 缓存
    ↓
[Phase 5] 全量回归与 fix
    ↓
[Phase 6] Android emulator 端到端穿测
    ↓
[Phase 7] 版本号升级与 Release APK 打包
```

每个 Phase 都要：
- 实施
- 新增 / 更新对应测试
- `npm run lint` 通过
- `npm test` 通过
- `git add` + `git commit -m "perf(pipeline): ..."`（commit message 参考仓库现有 `feat(pipeline): ...` 风格）
- Review（自我 review，把变更点总结在控制台输出）

---

## Phase 0 — 规约与基线

**目标**：建立文档 + 当前测试基线。

**任务清单**：
- [x] 阅读 `pipelineRunner.ts` / `llm.ts` / `contextBuilder.ts` / `pipelineMessages.ts` / `pipelineTaskStore.ts`
- [x] 查阅前置 commit 96aab88（流式回退）原因
- [x] 编写 `docs/pipeline-perf/SPEC.md`
- [x] 编写 `docs/pipeline-perf/PLAN.md`（本文）
- [x] `npm run lint` → 记录 baseline 错误数（应有 0）
- [x] `npm test` → 记录 baseline 通过数（应为当前全绿数）

**交付**：
- `docs/pipeline-perf/SPEC.md`
- `docs/pipeline-perf/PLAN.md`

---

## Phase 1 — 流式核心 `callLLMStream`

> 配套 SPEC §3.2.1。**这是整个优化里风险最高的环节**，必须单独 PR review。

### 实施

文件：`src/services/llm.ts`

| 步骤 | 内容 |
|------|------|
| 1.1 | 新增类型 `LLMStreamHandlers`、`CallLLMStreamOptions` |
| 1.2 | 抽出工具 `parseSSEChunks(buffer): { events, rest }`：把 `data: {...}\n\n` 行切成完整 event，未完整行留在 rest |
| 1.3 | 抽出工具 `extractDeltaFromEvent(event)`：兼容 OpenAI `{choices:[{delta:{content}}]}` 与"其他格式"（解析失败返回 `''` 不抛错） |
| 1.4 | 实现 `callLLMStream(messages, maxTokens, config, handlers, externalSignal, options?)` |
|     | - 应用 `limitLLMRequest` 队列 |
|     | - `stream=true` 投递 body |
|     | - stall watchdog：每次 chunk 触发 `clearTimeout` + `setTimeout(stallMs)` 重置 |
|     | - total timeout：`setTimeout(totalMs)` |
|     | - 与 `externalSignal` 通过 `addEventListener('abort', ...)` 解耦 |
|     | - SSE 流式读取直到 `data: [DONE]` |
| 1.5 | 错误信号分层（在 catch 里根据 controller.signal 与外部 signal 状态分别 throw） |
| 1.6 | 降级策略：第一次 fetch 后若 Content-Type 不是 text/event-stream 且不是 SSE 格式，自动重试 `stream:false` 并 `console.warn` 提示 |

### 测试

文件：`__tests__/llm.test.ts`（追加）

新增用例：
- `callLLMStream 解析 SSE 流并累积文本` —— mock fetch 返回 `data: {...}` 序列，断言 handlers.onChunk 被调用次数、最终 onDone 文本正确
- `callLLMStream 抛 'cancelled' 当 externalSignal.aborted` —— 不走超时
- `callLLMStream stall 触发 throw 'stall'` —— mock fetch 返回卡住不响应
- `callLLMStream 总超时 throw 'timeout'` —— abort 后 100ms 抛错
- `callLLMStream 降级到非流式当 SSE 不可用` —— Content-Type 设为 `application/json`
- `callLLMStream usage 计入 llm_usage_logs` —— mock fetch 末尾 chunk 带 `usage`，断言 db.logLLMUsage 被正确调用

### 验证

```bash
npm run lint
npx jest __tests__/llm.test.ts
npm test
```

### Commit

```bash
git add src/services/llm.ts __tests__/llm.test.ts
git commit -m "feat(llm): 新增 callLLMStream 流式核心，错误信号分层

- 新增 SSE 解析与 stall/total watchdog
- 4 类错误信号清晰分离：cancelled / timeout / stall / http
- 不支持 SSE 的 provider 自动降级到非流式
- 老的 callLLMResult 行为不变（V2.1.5 全兼容）
"
```

---

## Phase 2 — 流水线接入草稿流式 + 增量落库

> 配套 SPEC §3.2.2 与 §3.2.4。

### 实施

文件：`src/services/pipelineRunner.ts`

| 步骤 | 内容 |
|------|------|
| 2.1 | 在草稿分支把 `await callLLMResult(draftMessages, ...)` 改为 `callLLMStream` + 累积 delta |
| 2.2 | 抽出 `utils/stages.ts`：`getPipelineStageOrder(mode): StageName[]`、`getStageProgressPercent(mode, completedStages)` |
| 2.3 | `usePipelineTaskStore` 新增 `draftPreview: string`（per-task），由 `setDraftPreview` 更新 |
| 2.4 | 每次 stage 完成立即写一次"工作进度副本"到 `pipeline_tasks.stage_results` 已有机制 = OK；并通过 `db.savePipelineTask` 立即落库（已有） |
| 2.5 | resume 改动：复用当前 task 的 in-memory `stageResults`，无需再次调 stage |
| 2.6 | `runChapterPipeline` 新增第四参 `options?: { useDraftStream?: boolean }`；`false` 时走老路径 |
| 2.7 | PipelineProgress 接受 `draftPreview` prop；用 `useEffect` 监听 store 变化更新 |

### 测试

文件：`__tests__/pipelineRunner.test.ts`、`__tests__/pipelineProgress.test.tsx` 更新

- 草稿阶段 mock `callLLMStream`：传 3 个 chunk，断言 store 中 `updateTaskStage` 入参 `text` 等于完整文本
- 草稿开关关闭时走 `callLLMResult`（等价于 V2.1.5 测试）
- 草稿失败时仍走老 `failTask` 路径，cancelled 走 `cancelTask`
- Stage 完成即落库：mock `db.savePipelineTask`，断言调用次数随 stage 递增

### Commit

```bash
git add src/services/pipelineRunner.ts src/store/pipelineTaskStore.ts src/utils/stages.ts src/components/PipelineProgress.tsx __tests__/pipelineRunner.test.ts __tests__/pipelineProgress.test.tsx __tests__/pipelineTaskStore.test.ts
git commit -m "feat(pipeline): 草稿阶段接入流式输出 + 阶段增量落库

- 草稿阶段用 callLLMStream 边收边落 store.draftPreview
- runChapterPipeline 新增 useDraftStream 选项（默认开）
- 每次 stage 完成立刻 savePipelineTask，resume 可立即接力
- PipelineProgress 实时显示草稿预览
"
```

---

## Phase 3 — review / factCheck 全模式并行

> 配套 SPEC §3.2.3。

### 实施

文件：`src/services/pipelineRunner.ts`

关键改动：
- `twoStage` 分支：`draft → [review_in_progress_with_proof_priming]`
  - 启动 `proof(draftText, reviewText='', factCheckText='')` 立即开始
  - `review` 完成时，如果 proof 还在跑，记录 `reviewText` → proof 内自动通过 `latestReviewSignal` 拉取（用闭包共享引用）
  - 如果 proof 已完成（review 太慢），保留 draft-only 版本作为 final；UI 提示"已用初稿打磨，可应用审阅意见再跑一次"
- `conditional` 分支：同上，把 review 换成 factCheck
- `full` 模式已是 review‖factCheck → proof，保持

引入新概念 `proofInputs`：每次 proof 开始接收一次 snapshot `{draft, review?, factCheck?}`；review/factCheck 完成时更新 `proofInputs`；当 proof 完成时使用**最新 snapshot**。

为避免 token 爆炸，proof 系统提示词改为"如果 review/factCheck 已就绪就用，否则标记未就绪"，并且在 proof 完成时若 review/factCheck **是 proof 开始之后才完成**的，则自动追加一次以 review 为输入的轻量再打磨（仅 1 次，max_tokens 限制）。

### 测试

新增：
- `twoStage 并行：proof network 请求时间 < review 完成时间（断言 mock 顺序）`
- `full 模式等价于 V2.1.5（回归测试）`
- `proof 在 review 完成前完成：保留 draft-final 状态`

### Commit

```bash
git add src/services/pipelineRunner.ts __tests__/pipelineRunner.test.ts
git commit -m "perf(pipeline): twoStage/conditional 模式 review+proof 并行化

- proof 立即基于 draft 开始，review/factCheck 后到时附 snapshot
- 避免 proof 等 review 多花的等价于 1 个阶段的时间
- full 模式行为不变（已经并行）
"
```

---

## Phase 4 — ContextBuilder 并行与 IDF 缓存

> 配套 SPEC §3.2.5。

### 实施

| 步骤 | 内容 |
|------|------|
| 4.1 | `database.ts` 新增 `getNotesContentByIds(ids: number[]): Promise<Record<number, string>>` （SQLite 单次 IN 查询 + 返回 Map） |
| 4.2 | `contextBuilder.buildNoteContextOriginal` 改为先 `db.getNotesByProject` 拿到 ID 列表，再 bulk 读，替换循环内的 `getNoteContentById` |
| 4.3 | 新增 `utils/idfCache.ts`：内存 + SQLite（`idf_cache` 表）双层缓存 |
| 4.4 | `contextBuilder.buildMemoryContext` 接受 `getIdf: (projectId) => Promise<Map>` 注入 |
| 4.5 | `database.ts` 新增 `getMemorySummariesByProject(projectId)` 一次拿全部 |
| 4.6 | signature 计算用 `summaries.map(s => s.length).join('|')`（够用，避免序列化大文本） |

### 测试

`__tests__/contextBuilderNoteMode.test.ts` 追加：
- 50 条 note 用 bulk 路径：mock `getNotesContentByIds` 单次返回，对比串行实现的耗时 < 80ms（mock 跳过真实 IO 时间）
- 100 章带 summary：IDF 缓存命中后 `buildMemoryContext` 跑第二次 < 20ms

### Commit

```bash
git add src/services/contextBuilder.ts src/services/database.ts src/utils/idfCache.ts __tests__/contextBuilderNoteMode.test.ts
git commit -m "perf(context): Note 注入 bulk fetch + IDF 缓存

- 新增 getNotesContentByIds 单次 IN 查询，避免 N 次 round-trip
- 同项目 IDF 在 memory_summary 不变时复用
- 50 条笔记注入从 O(N) roundtrip → 1 次
"
```

---

## Phase 5 — 全量回归与 fix

### 任务

- [ ] `npm run lint`
- [ ] `npm test`（全量，期望 100% 通过）
- [ ] 修复任何在 Lint/test 中暴露的问题
- [ ] 检查覆盖率：`__tests__/pipelineRunner.test.ts` 覆盖所有 mode 分支
- [ ] 检查 `git diff --stat` 不含 `ios/`

### Commit

如有 fix：
```bash
git commit -m "fix: lint/test 回归修复"
```

---

## Phase 6 — Android emulator 端到端穿测

### 任务

- [ ] 启动 Android emulator（命令：`emulator -avd <name>` 或 `adb devices`）
- [ ] `npm run android` 安装 debug 包到 emulator
- [ ] 在 emulator 上跑 SPEC §4.2 的 5 个场景
- [ ] 用 `adb logcat | grep -i "PipelineForeground\|llm\|SSE"` 观察流式调用
- [ ] 截图记录关键节点（草稿预览实时刷新 / 完成提示 / 并行网络）

### 备注

如果当前环境没有 emulator：
- 尝试 `emulator -list-avds` 看是否有预置
- 尝试 `npm run android` 启动时自动 build + install
- 若彻底无 emulator：用 `npx jest --runInBand` 加一条 e2e test 模拟整链路（mock fetch）

### 提交

截图放入 `docs/pipeline-perf/screenshots/`，不是 commit 内容（gitignored 或文档目录）

---

## Phase 7 — 版本号升级与 Release APK

### 任务

| 文件 | 修改 |
|------|------|
| `package.json` | `"version": "2.1.5"` → `"2.2.0"` |
| `android/app/build.gradle` | `versionName "2.1.5"` → `"2.2.0"`，`versionCode 215` → `220`（如适用） |
| `version.json`（如存在） | 同步 |
| `app.json`（如存在） | 同步 |

### 命令

```bash
npm run apk:release
ls -la dist/apk/release/ShineWriter-V2.2.0-release.apk
```

### Commit

```bash
git add package.json android/app/build.gradle version.json app.json
git commit -m "chore(release): bump version to V2.2.0"
```

---

## 验收 checklist

- [ ] Phase 0 ~ 7 全部 commit
- [ ] Lint 0 error
- [ ] Jest 全绿
- [ ] emulator 5 场景通过
- [ ] `dist/apk/release/ShineWriter-V2.2.0-release.apk` 存在并返回

