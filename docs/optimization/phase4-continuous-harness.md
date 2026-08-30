# Phase IV Continuous 5/10 Chapter Harness

日期：2026-08-30
阶段：IV-7 真实 5/10 章连续运行
结论：`HOLD`，未宣称 Final Seal GO

## 目的与边界

IV-7 只增加可审计的证据汇总器，不增加 Writer、Agent、Context、Memory、生产 Gate 或 Governor 调用。输入是每章已经采集的运行证据，输出包括：

- E2E First-Pass Adoptable Rate 及其真实分母；
- 总物理调用、Governor physical call、重复调用；
- Context token 与冻结预算边界；
- Resume/Idempotency、DB integrity、crash、ANR；
- `pass`、`hold`、`no-go` 与可复核原因。

章数不匹配、物理调用缺失或非法、Governor physical call、重复调用、Context 溢出、Resume/Idempotency 失败、DB 损坏、crash/ANR 或 First-Pass 未完成时，汇总器 fail-closed 为 `no-go`。真实 Android LLM 样本缺失且其它安全项通过时，结果为 `hold`；不会把 deterministic harness、mock 或 contract test 计作真实 E2E。

## PLAN → RED → DO → CHECK-A

- PLAN：`docs/optimization/phase4-progress.md` 的 IV-7 PLAN 固定 5/10 章、单一冻结上下文、无隐藏调用和上述 P0 证据。
- RED：先运行 `__tests__/phase4ContinuousHarness.test.ts`，得到缺失 `phase4ContinuousHarness` 模块的失败。
- DO：实现 `src/services/writing/metrics/phase4ContinuousHarness.ts`，只做纯汇总和 fail-closed 判定。
- CHECK-A：
  - `phase4ContinuousHarness`、历史 A/B、Gate、Governor、Context、Persistence 和 Final Candidate 相关回归：9 suites / 41 tests passed；
  - `npm.cmd run typecheck` passed；
  - `npm.cmd run lint -- --quiet` passed；
  - `npm.cmd run verify:elastic` passed；
  - `npm.cmd run verify:version` passed，V2.21.1 / versionCode 2210100。
  - 最终全量 `npm.cmd run verify`：`VERIFY_EXIT_CODE=0`，Jest 531 suites passed / 3 skipped，3751 tests passed / 8 skipped；完整输出见 IV-7 evidence。

## Android CHECK-B

- release APK 构建成功，SHA-256：`C2F9F7EB51A71CB402DAD5D80A7FEB30A2E395E66D9B38AD4DFF20BCF1A60632`。
- `emulator-5554` 在线；只执行 `adb install -r`，结果 `Success`。
- 安装后包版本仍为 V2.21.1 / 2210100，`firstInstallTime=2026-08-08 07:48:12`；作品库仍显示 `SM43U2Proj`、`2 章`、`13 字`，说明没有通过安装破坏用户数据。
- UI 配置页显示已保存的模型、上下文长度 `1000000` 和掩码 API Key；真实 `保存并测试` 返回：`API 请求失败 (401, 401): 令牌已过期或验证不正确`。
- release APK 非 debuggable，`run-as com.shinewriter` 返回 `package not debuggable`；因此本轮 DB 直接快照不可用，仍保留 UI、Receipt/历史证据和 logcat 证据，不虚构 DB 通过。
- 未发现 app crash/ANR 的 logcat 证据；但这不替代真实 5/10 章运行。

证据目录：`test-logs/phase4-iv7-20260830-155254/`，CHECK-B 摘要：`iv7-check-b.md`。
CHECK-B：`HOLD`。当前凭据无法建立真实 paid E2E 分母，故没有生成 5/10 章的虚假 First-Pass 结果。凭据恢复后，使用同一 harness 重跑 5 章和 10 章连续链，再进入 Final Seal 判定。
