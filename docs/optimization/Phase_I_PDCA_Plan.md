# Phase I PDCA — Writing Source Interface Unification

## Plan

范围仅限进入 Writing Kernel 前的资料接口：`WritingScenario`、`WritingSource`、`WritingSourceBundle`、Outline/Continuation Adapter、Source Validation、Source Fingerprint、Source Trace 和 Legacy Restart Input Layer。

明确边界：Data Compatibility = YES；Execution Compatibility = NO。旧未完成执行态不迁移、不 Resume；只恢复项目、章节和用户指令，并创建新的 run/trace/fingerprint/context 身份。Phase I 不改 Draft、Review、Revision、Finalize、模型调用策略、Story Memory 算法或 Continuation Writer Core。

## Do

- 新增统一 Source Contract 与稳定 SHA-256 指纹。
- 新增 `OutlineWritingAdapter` 与 `ContinuationWritingAdapter`，输出相同三分桶结构。
- 新增 fail-closed `validateWritingSourceBundle()` 和标准错误码。
- 新增 Source Trace 与 `restartLegacyWritingTask()`。
- 建立 OUTLINE/CONTINUATION Golden Fixtures，并加入 x10 determinism、结构一致性、场景泄漏和 Legacy Restart 测试。

## Check

Phase I Check 命令：

```text
npm run lint
npm run typecheck
npm test -- --runInBand --runTestsByPath __tests__/writingSourceContract.test.ts __tests__/writingLegacyRestart.test.ts
```

额外检查：每个 Golden Fixture 指纹构建 10 次；Outline 与 Continuation 均通过同一 Validation 入口；Legacy Restart 不携带 checkpoint/frozenContext/review/artifact。

执行结果（2026-08-16）：

- `npm run lint`：PASS，0 errors；202 条既有 warnings，无新增 Phase I error。
- `npm run typecheck`：PASS。
- Phase I focused tests：PASS，2 suites / 4 tests。
- 全量 Jest：PASS，439 suites passed，3445 tests passed，8 skipped，0 failed。
- 生产接入边界审计：PASS；Outline 与 Continuation 仅在进入既有执行阶段前生成 Source Trace，Adapter 本身无数据库读取；未改动 Draft/Review/Revision/Finalize/Story Memory 执行逻辑。
- Determinism/contract：PASS；Golden fixtures x10 指纹稳定，场景泄漏、重复 candidate、hash/revision、空 mandatory 和 Legacy Restart 回归均覆盖。

## Act

发现契约、hash、重复 candidate、场景泄漏或旧执行态复用问题时，按 Finding → Root Cause → Fix → Regression → Re-run 闭环。Phase I 未进入 Kernel 重写，未修改既有用户数据或执行表。

本阶段结论：PASS，可进入独立 Commit；Phase II 不复用旧执行态，仅复用项目/章节/用户指令等数据语义。
