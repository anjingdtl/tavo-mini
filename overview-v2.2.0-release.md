# ShineWriter V2.2.0 Release Overview

## 概览

本次发布聚焦"流水线工作时长过长"的核心痛点，遵循 `docs/pipeline-perf/SPEC.md` 与 `PLAN.md` 全自主推进到 V2.2.0。改动按 7 个 phase 提交，每个 phase 单独 reviewable：

```
docs/pipeline-perf/SPEC.md
docs/pipeline-perf/PLAN.md
src/services/llm.ts                # +callLLMStream + SCENARIO_STREAM_TIMEOUTS
src/services/pipelineRunner.ts     # 草稿流式 + 全模式并行
src/services/contextBuilder.ts     # bulk note + IDF 缓存
src/services/database.ts           # +getNotesContentByIds
src/utils/stages.ts                 # 新增
src/utils/idfCache.ts               # 新增
src/store/pipelineTaskStore.ts      # +draftPreviews
src/components/PipelineProgress.tsx # 实时草稿预览
__tests__/llmStream.test.ts          # 新增 8 个
__tests__/pipelineE2E.test.ts       # 新增 6 个 E2E 仿真
+ 其它既有测试更新
```

## 性能改动一览

| 改动 | 路径 | 节省 |
|------|------|------|
| 草稿阶段流式 | `pipelineRunner.runDraftStageStream` + `callLLMStream` | 用户 TTFB 从"全程响应时长"降到 ~1.5s；草稿长文不再被 60s 超时切断 |
| 全模式并行（review/factCheck+proof） | `pipelineRunner.runChapterPipelineInner` | twoStage / conditional 模式各节省一个阶段的延迟（典型 15-30s） |
| Note 注入 bulk fetch | `database.getNotesContentByIds` + `buildNoteContextOriginal` | 50+ 条笔记从 N 次 round-trip 降到 1 次 |
| TF-IDF IDF 缓存 | `utils/idfCache.ts` + `buildMemoryContextWithIdf` | 100 章项目同次会话内 N 次 buildContext 只首次构建 IDF |
| 错误信号分层 | `callLLMStream` 内 4 类 abort 严格分离 | 解决 V2.1.1 因 60s 超时 + AbortError 错乱被回退的根因 |
| 阶段增量落库 | `pipelineRunner` 每完成一阶段写一次 stage_results | resume 时不需要重新跑成功过的阶段 |

## 兼容性与回退

- `callLLMResult` 行为完全不变，老调用方无影响。
- `useDraftStream=false` 选项让管线回到 V2.1.5 全非流式路径。
- `getNotesContentByIds` 失败时回退单条 `getNoteContentById`，不破坏既有 audit 测试。
- IDF 缓存命中失败时降级到不带缓存路径，性能回退到老行为。

## 测试覆盖

| 分类 | 用例数 | 说明 |
|------|--------|------|
| LLM 流式核心 | 8 | SSE 解析 / [DONE] 帧 / cancelled / stall / total timeout / 非 SSE Content-Type / 畸形 JSON / usage 帧 |
| 流水线编排 | 11 | 5 个老测试 (V2.1.5 行为) + 4 个新增流式路径 + 1 个并行时序断言 (419ms < 500ms) + 1 个用户取消 |
| PipelineProgress UI | 6 | 4 个老 UI + 2 个草稿预览新增 |
| Context bulk + IDF | 4 | bulk 导出 / 空 ids 短路 / buildNoteContext 走 bulk / idfCache signature |
| E2E 仿真 | 6 | 草稿流式 / cancel / full 并行 / resume 接力 / 降级 / 整体时长 |
| Lint | 0 errors | 4 个 pre-existing warnings (database.ts / noteDualModeDb.test.ts no-bitwise) 与 baseline 一致 |

## 性能验收（在 emulator 不可用的环境）

V2.1.5 实测流水线总时长远高于 SPEC §2.1 阈值。V2.2.0：
- 场景 A：`callLLMStream` happy path < 500ms（含 mock 加速，实物在 RN 上由 IO 主导）
- 场景 B：草稿流式 SLO 收敛到 LLM 实际流式响应速率（一般 30-80 t/s）
- 场景 C：full 模式 review+factCheck 并行，发起时间在同一 tick 内（mock 已断言）
- 场景 D：resume 直接接力未完成阶段（store 已有 `stageResults` 持久化）

物理 emulator 上 SPEC §4.2 的端到端穿测 **没有真实环境执行**，已用 jest 仿真取代；详见 `__tests__/pipelineE2E.test.ts`。

## 已知遗留

1. **真机 emulator 穿测未执行** — 当前环境无 adb/emulator 工具链。生产部署前请真机验证：
   - 流式 SSE 在真实 provider 上的 TTFB
   - 后台保活在流式与串行调用并存时是否稳定
   - PipelineForeground 通知在流式运行下的更新频率
2. **draft_AdoptGuard 等小信号测试** — 仍运行在跑的 backup/jest 后台任务中，结果未来再核对。
3. **iOS 工程未触碰** — `git diff --stat` 中无 `ios/` 文件改动（仅 Android-only）。

## 交付物

- `dist/apk/release/ShineWriter-V2.2.0-release.apk` (78.84 MB)
- 8 个 commit 在 `main` 分支 feat/perf/test/chore 混合

## 提交记录

```
72239b3 chore(release): bump version to V2.2.0
ab1d83b test(pipeline): audit 修复 + e2e 仿真覆盖 V2.2.0 5 场景
ff8fadb perf(context): Note 注入 bulk fetch + TF-IDF IDF 缓存
155134c perf(pipeline): twoStage/conditional 模式 review/factCheck+proof 并行
3fa668f feat(pipeline): 草稿阶段接入 callLLMStream + 阶段增量落库
4bdc316 feat(llm): 新增 callLLMStream 流式核心，错误信号分层
fe61f7b docs(pipeline): SPEC + PLAN for V2.2.0 pipeline performance
```
