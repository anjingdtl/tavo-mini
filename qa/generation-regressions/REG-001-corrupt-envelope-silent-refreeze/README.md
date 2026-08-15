# REG-001 — 冻结信封损坏被静默跳过（silent live-DB re-freeze）

- **发现阶段：** Stability Phase 3（2026-08-15）
- **严重级：** P0（Freeze 契约击穿，语义漂移不可观测）
- **修复：** commit `5a898573`（`fix(pipeline): fail closed on corrupt frozen envelope`）

## 缺陷描述

`pipeline/reconcile.ts` 的 `loadRuntime` 中：

```ts
try {
  parsed = parsePersistedPipelineTaskContext(task, {...});
} catch {
  parsed = null;   // ← 静默吞掉
}
```

任务已拥有冻结信封（pipelineContextJson 非空）但解析失败（hash 损坏 /
JSON 损坏 / 指纹不匹配）时，`parsed=null` 使后续逻辑把任务当作"未冻结"，
从 **live DB** 重新读取配置并重新冻结，然后继续生成——本次生成的语义
在无任何诊断的情况下发生了漂移。

## 复现证据（Red）

`__tests__/stabilityPhase3FrozenSnapshotFailClosed.test.ts`（真实 sql.js
SQLite + 真实状态机，仅 mock LLM 出口）：

- 修复前：resume 一个信封 hash 损坏的任务 → 状态机静默重冻结 → 一路
  跑到 Draft LLM 调用（测试断言 LLM 不得被调用时收到
  "LLM must never be called in this journey"）。
- 修复后：任务显式 failed，error 含"冻结上下文解析失败"，损坏信封
  原样保留，0 次 LLM 调用。

## 期望行为（修复后契约）

| 条件 | 行为 |
|---|---|
| 信封存在且解析成功 | 冻结路径（不变） |
| 信封存在但解析失败 | 抛 `SNAPSHOT_PARSE_FAILED`（fail-closed），任务 failed，信封保留，禁止任何 LLM 调用 |
| 信封不存在（首跑/未冻结） | live 路径（合法，不变） |

## 关联资产

- 错误码：`SNAPSHOT_PARSE_FAILED`（src/types/generationTrace.ts 注册表）
- 重放：`replayFrozenGeneration()` 会把该路径归类为
  `envelope_parse` 失败（corrupt 输入，不抛异常）
