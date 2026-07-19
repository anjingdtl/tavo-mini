# 故事记忆检查点架构验证报告

| 字段 | 值 |
|---|---|
| 日期 | 2026-07-19 |
| 基线 | V2.5.6 / Schema 15 |
| 目标 | Schema 16 检查点架构 |
| 分支 | `codex/story-memory-checkpoints` |

## 1. 实现摘要

- 默认 `smart` + `intervalChapters=3`。
- 定稿 Step A 本地 `final`；Step B 仅 due 时一次 `story_memory_checkpoint` 批量请求。
- 上下文：长期 Checkpoint + Pending Bridge + Seam；Episodic Top-K 排除 raw bridge 章节。
- 仅 hard due 允许生成前强制整理；preview 永不调用故事记忆 LLM。
- Schema 16 保留 v1 patch/snapshot/state。

## 2. 自动化证明：30 章请求数

确定性测试：`__tests__/storyMemoryThirtyChapter.test.ts`

| 指标 | 结果 |
|---|---|
| 策略 | smart / interval=3 |
| 主检查点请求 | **10** |
| 非 due 定稿（不调 LLM） | **20** |
| uncovered chapter | **0** |
| 对比旧路径 | 30 次逐章请求 → 10 次批量请求 |

> Token 与真实模型耗时需真实 usage log；本报告不伪造“节省 66% Token”。

## 3. Schema 16

- 迁移：`v15-to-v16.ts`（幂等 `CREATE IF NOT EXISTS`）
- Fresh schema / manifest / backup：`project_story_memory_policy`、`story_memory_batches`
- 回滚：关闭 `story_memory_checkpoint_scheduler_enabled` 回到逐章兼容路径；不降级数据库

## 4. 质量门禁（实施后执行）

见最终 agent 报告中的 lint / typecheck / test:ci / coverage / verify / apk:debug 结果。

## 5. 外部验收

| 项 | 状态 |
|---|---|
| 在线模型 3 章批次 | 未在本环境执行（需用户 API） |
| 本地 GGUF 3 章批次 | 未在本环境执行（需设备模型） |
| Android 真机/模拟器 UI | 以 Debug APK 构建结果为准 |

## 6. 已知限制

- 重建路径仍可复用 v1 逐章 patch；完整重建的 v2 batch 路径在 dirty rebuild 中按批次推进。
- 真实模型语义质量依赖供应商输出，自动化使用确定性 fixture 验证合并与请求次数。
