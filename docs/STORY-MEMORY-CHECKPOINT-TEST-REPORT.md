# 故事记忆检查点架构验证报告

| 字段 | 值 |
|---|---|
| 日期 | 2026-07-19 |
| 版本 | V2.5.6 |
| Schema | **16** |
| 分支 | 已合入 `main`（原 `codex/story-memory-checkpoints`） |
| 总评 | **PASS** |

## 1. 实现摘要

- 默认 `smart` + `intervalChapters=3`。
- 定稿 Step A 本地 `final`；Step B 仅 due 时一次 `story_memory_checkpoint` 批量请求。
- 上下文：长期 Checkpoint + Pending Bridge + Seam；Episodic Top-K 排除 raw bridge 章节。
- 仅 hard due 允许生成前强制整理；preview 永不调用故事记忆 LLM。
- Schema 16 保留 v1 patch/snapshot/state。
- 重建默认按 interval 分批；缺失人物/线索/关系引用 soft-skip。
- 多人物抽取 prompt 强化名单与出场顺序。

## 2. 自动化证明：30 章请求数

确定性测试：`__tests__/storyMemoryThirtyChapter.test.ts`

| 指标 | 结果 |
|---|---|
| 策略 | smart / interval=3 |
| 主检查点请求 | **10** |
| 非 due 定稿（不调 LLM） | **20** |
| uncovered chapter | **0** |
| 对比旧路径 | 30 次逐章请求 → 10 次批量请求 |

## 3. Schema 16

- 迁移：`v15-to-v16.ts`（幂等 `CREATE IF NOT EXISTS`）
- Fresh schema / manifest / backup：`project_story_memory_policy`、`story_memory_batches`
- 回滚：关闭 `story_memory_checkpoint_scheduler_enabled` 回到逐章兼容路径；不降级数据库

## 4. 外部验收（DeepSeek 模拟器）

| 项 | 结果 |
|---|---|
| 模型 | `deepseek-v4-flash` @ `https://api.deepseek.com` |
| 剧本 | 30 章 / 11 人物 / 5 交织剧情线（`test-logs/checkpoint-30ch-20260719/novel_30.py`） |
| through / status | **29 / clean** |
| 人物 | **11/11**（林岚、周恪、沈棠、顾沉、白薇、老霍、阿念、方迟、谢衡、墨七、叶疏） |
| 关系 | **25** |
| 线索 | 开放 2 + 已解决 1 + 伏笔 1 |
| applied batches | **10**（每批 3 章） |
| 主检查点请求 | **10** |
| repair/retry | 10（证据锚定修复，可接受） |
| 逐章 patch 主请求 | **0** |
| 非空 memory_summary | **30/30** |
| 本地详细报告 | `test-logs/checkpoint-30ch-20260719/ACCEPTANCE-30CH-REPORT.md`（gitignore） |

| 项 | 状态 |
|---|---|
| 在线模型 30 章多人物多线 | **PASS** |
| 本地 GGUF 3 章批次 | 未在本轮执行（需设备模型） |
| Android 真机 arm64 | 未在本轮执行 |

## 5. 已知限制

- 真实模型语义质量仍依赖供应商输出；soft-skip 会丢弃无法对齐的坏引用，需后续观察 cast 漏提。
- 本地 GGUF 与 arm64 真机长上下文仍需专项验收。
- repair 率（本轮约 1:1 主请求）仍有优化空间，但不阻塞 clean 收敛。
