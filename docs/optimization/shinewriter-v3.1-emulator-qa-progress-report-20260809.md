# ShineWriter V3.1 当前进度测试报告

日期：2026-08-09  
版本：V2.11.40（versionCode 2114000）  
测试设备：`emulator-5554`，Android API 37，`sdk_gphone16k_x86_64`  
模型：DeepSeek V4 Flash（`deepseek-v4-flash`）  
报告状态：阶段性通过，批量 N=3 仍有一个真实合同阻断项，不能标记为全量验收通过。

## 1. 本轮改造范围

- V3.1 Draft/Proof 保持 Thinking；Review、FactCheck、Brief 改为 content-only 结构化合同。
- reasoning-only、结构化合同无效、网络结果未知分别进入不同的 fail-closed 状态，不把异常结果当成成功。
- 增加一次明确的禁 Thinking 合同重试和受限 Audit/Brief Formatter 恢复路径，不重放完整审核上下文。
- Review/FactCheck 接入模型无关的 V3.1 合同兼容适配；保留旧版已识别 JSON 形状的显式适配，不接受任意对象的泛化填充。
- Brief 的 `sourceHash`、`requiredSourceIds`、`protectedFacts`、`hardConstraints`、`mustNotAdvance`、`outlineObligations`、`endingBoundary` 由本地不可变信封确定，LLM 只提供语义载荷。
- 结果页将“本地不可变信封归一化”从橙色警告降为中性说明，真实合同/质量警告仍保留警示色。
- 保留批量写作的 SQLite checkpoint、CAS、预算和恢复状态机，批次使用升级安装后的既有配置运行。

## 2. APK 升级安装与配置保留

本轮 debug APK 使用升级安装：

```text
adb -s emulator-5554 install -r dist/apk/debug/ShineWriter-V2.11.40-debug.apk
```

安装结果为 `Success`。未执行卸载、`pm clear` 或删除数据库。安装前后 DB 行数、LLM 配置和当前项目均做了比对；活动配置仍为 DeepSeek V4 Flash，API Key 未写入报告或日志。

证据目录：

`F:/ClaudeWorkSpace/projects/TAVO-MINI/test-logs/emulator-qa-v31-reasoning-20260809-223649/`

主要证据：`install-upgrade-after-prompt-source-fix.txt`、`config-preservation-after-prompt-source-fix.jsonl`、`db-after-prompt-source-fix.sqlite`。

## 3. 单章真实 LLM 穿测

| 场景 | 任务 | 结果 | 关键事实 |
|---|---|---|---|
| 第 22 章 | `pt_mslwtdj6_127` | 通过 | Prompt 源修复后 Review content-only 成功；最终稿成功；Proof 保持 Thinking |
| 第 23 章 | `pt_mslxsk5z_128` | 通过 | 五阶段均成功；Brief visible 117、Thinking 0；终稿 3445 字 |
| 第 24 章 | `pt_msly39tu_129` | 通过 | 五阶段均成功；Brief visible 104、Thinking 0；终稿 2692 字 |

三次单章均为 `skipped 0`，Review/FactCheck/Brief 均没有把 reasoning 通道当业务内容。Draft/Proof 的 Thinking 仍然存在，说明“关闭结构化阶段 Thinking”没有误伤终稿创作通道。

## 4. Brief 红字 UI 回归

第 24 章结果页的原始橙色长串来自正常的本地信封覆盖提示，并非失败。修复后页面只显示：

```text
说明：终稿 Brief 已按本地不可变约束归一化
```

终稿仍显示成功，未出现红色长串。截图证据：

`F:/ClaudeWorkSpace/projects/TAVO-MINI/test-logs/emulator-qa-v31-reasoning-20260809-223649/brief-warning-ui-ch24-result.png`

## 5. 一键写 N=3 穿测结果

批次：`batch_mslyk4b5_p44g6s`  
配置：3 章、完整管线、质量档、目标 3000 字/章。规划预览成功生成三章计划，并核对了以下连续性约束：北塔不强开、第三把钥匙仍未出现、线索按章递进。

批次真正启动后，第 1 章任务为：

`batch_batch_mslyk4b5_p44g6s_ord1_1786289553707`

持久化结果：

- Draft：成功；
- FactCheck：成功，content-only；
- Review：模型返回了 5021 字 content，`finish_reason=stop`，`response_channel=content`，但合同校验失败；
- Review attempt：`failure_class=response_invalid`、`error_code=PIPELINE_RESPONSE_INVALID`、`parse_failure_code=missing_required_fields`；
- 批次：`paused_user`，`BATCH_PIPELINE_FAILED`；第 2、3 章未启动。

这是预期的 fail-closed 行为：该次不是 reasoning-only，不是网络超时，也不是“结果未知”，没有错误地把 Draft 当 Final 或继续进入 Brief/Proof。

当前剩余阻断项是 Review 具体缺失字段的可观测性：现有持久化只保留了安全的失败分类，没有保存原始合同正文，因此本次事实已经能确定为“Review content 合同无效”，但还不能从 DB 反推出具体是哪一个字段。下一轮应先加入不含正文的字段级诊断，再针对真实输出做模型无关兼容修复；不能用放宽全部必需字段的方式掩盖问题。

## 6. 文学质量检查边界

自动证据已确认：单章 Draft→Review→FactCheck→Brief→Proof 管线完整通过，Review/FactCheck/Brief 的结构化结果未泄漏到终稿正文，终稿长度和阶段衔接均正常；连续性样本持续保持“北塔未打开、第三把钥匙未取得”等硬事实。

本报告不把结构门禁通过等同于主观文学评分。批量 N=3 尚未完成，且还需要在修复 Review 合同阻断后对三章终稿做逐章人工文学复核（通顺度、资料一致性、前文衔接、重复段落和结尾边界）。

## 7. 本地代码门禁

`npm run verify`：通过。

- ESLint：通过；仅有仓库既有 warning；
- TypeScript：通过；
- version verify：通过；
- Jest：356 个测试套件通过，1 个套件跳过；2888 个测试通过，3 个测试跳过；
- 本轮 V3.1 合同、兼容层、Brief 展示和 checkpoint 恢复测试均通过。

## 8. 当前结论

V3.1 的单章路径、结构化 content/reasoning 隔离、Brief 红字 UI 归类和升级安装数据保留已经有真实证据支持；一键写 N=3 已证明批量状态机能启动并在 Review 合同无效时正确暂停，但尚未达到 N=3 三章完成的验收条件。该状态应以“部分完成，保留一个可定位的 Review 合同兼容阻断项”记录。
