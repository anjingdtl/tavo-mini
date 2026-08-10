# ShineWriter 大纲流水线 Budget V5 定向修复真实 LLM 测试报告

测试日期：2026-08-10（Asia/Shanghai）  
实施基线：`main@c2f51a17c975ff3906bad2d2496f99ced7ef20c3`  
发版版本：V2.11.41（真实 LLM 穿测使用同一源码的 V2.11.40 正式签名 APK，随后仅升版本号并重新构建 V2.11.41）  
测试设备：Android Emulator `emulator-5554`，包名 `com.shinewriter`  
测试工程：`release_touch_test`

## 1. 范围与边界

- 验证五阶段 Draft → Review → FactCheck → Brief → Final 的真实运行链路。
- 验证旧 Budget 任务阻断、Context Auto/LLM Settings/Pipeline Config 的预算入口收束。
- 未卸载应用、未清数据、未执行 `pm clear`；原有用户章节正文未作为测试目标覆盖。
- Batch 测试仅新建测试章节 13–15；单章测试未执行“采纳”，避免改写原有章节。
- 测试日志与 UI 证据保存在：
  `test-logs/outline-budget-v5-qa-20260810/`

## 2. 真实单章测试

| 样本 | 任务 ID | 结果 | 阶段结果 | 耗时 |
| --- | --- | --- | --- | ---: |
| 单章 A | `pt_msmty01s_114` | 成功 | 5/5，无跳过 | 29s |
| 单章 B | `pt_msmu1dnp_115` | 成功 | 5/5，无跳过 | 71s |
| 单章 C | `pt_msmu49st_116` | 成功 | 5/5，无跳过 | 47s |

三次均命中设备已有的真实 DeepSeek 配置，没有使用 mock provider 或 fallback。

## 3. 真实 Batch 测试

Batch 参数：3 章、每章目标 800 字、完整流水线。

| 项目 | 结果 |
| --- | --- |
| Batch 结果页 | 成功：3/3 |
| 完整流水线 | 3 |
| 总调用 | 16 |
| 输入 tokens | 132,320 |
| 输出 tokens | 35,485 |
| 额外重试 | FactCheck 1 次 reasoning-only 后自动重试成功 |
| Crash buffer | 空 |

三个子任务均完成并自动采纳到新建测试章节 13–15。日志中的三个任务 ID 为：

- `batch_batch_msmu9wqs_aky337_ord1_1786342691988`
- `batch_batch_msmu9wqs_aky337_ord2_1786342744470`
- `batch_batch_msmu9wqs_aky337_ord3_1786342937032`

## 4. 预算与自动化验证

Provider 捕获测试确认：

- Context 1M / Model 200K → 五阶段均 `200,000`。
- Context 1M / Model 64K → 五阶段均 `64,000`。
- Context 128K / Model 32K → 五阶段均 `25,600`。
- 当前版本为 `ContextBudgetVersion=5`；旧 `pipeline_*_max_tokens` 不再污染新任务。

自动化结果：

- `npm run verify`：通过。
- Jest：361 个测试套件通过，2928 个测试通过；2 个套件、4 个测试按项目配置跳过。
- Story Memory 与 request ledger 回归：通过。
- `git diff --check`：通过。

## 5. 结论

V5 新任务的五阶段独立 20% reservation、旧任务 fail-closed 阻断、批量顺序推进和真实 LLM 链路均通过。本轮未修改 Schema、Prompt、Reasoning 策略、Formatter、输入 80%/95% 算法或 Story Memory 业务逻辑。

设备截图证据：`test-logs/outline-budget-v5-qa-20260810/batch-complete.png`。

## 6. V2.11.41 发版验收

- `npm run verify` 在版本升到 V2.11.41 后复跑通过。
- `npm run apk:release` 构建成功，产物为：
  `dist/apk/release/ShineWriter-V2.11.41-release.apk`
- Release 证书 SHA-256：
  `017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`
- 通过 `adb install -r` 覆盖安装成功，设备确认 `versionName=V2.11.41`、`versionCode=2114100`。
- 启动后可进入作品库，保留原有应用数据；最终 crash buffer 为空。
