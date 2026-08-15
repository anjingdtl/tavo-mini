# Generation Regression Corpus（生成回归资产）

治理方案 §17：每个真实 BUG 沉淀一个可重放的回归 Case。修复必须先在
Replay Harness / 集成测试中复现（Red），修复后转 Green 并把 Case 登记于此。

线上问题排查流程（方案 §16）：

1. 获取 generationTraceId（信封 `trace.generationTraceId`）
2. 导出 Trace / Snapshot（pipeline_tasks.pipeline_context_json + attempts）
3. `replayFrozenGeneration()` 重放复现
4. 先写失败测试 → Red → 最小修复 → Green
5. 在本目录登记 Case

## Case 索引

| Case | 缺陷 | 复现测试 | 修复 commit |
|---|---|---|---|
| [REG-001](REG-001-corrupt-envelope-silent-refreeze/) | 冻结信封损坏被静默跳过，用 live DB 重冻结并继续生成（Freeze 契约击穿） | `__tests__/stabilityPhase3FrozenSnapshotFailClosed.test.ts` | `5a898573` |

## 结构约定

每个 Case 一个目录：

```
REG-XXX-<slug>/
  README.md        缺陷描述 / 复现条件 / 期望行为 / 修复方式
  fixture/         脱敏后的信封/Trace 样本（可再生的用脚本生成）
  expected.md      期望的 diagnostics / budget / fingerprint 行为
```
