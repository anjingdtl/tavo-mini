# Story Memory P1 无阻滞 + P2 保守并发 V3 验收报告

日期：2026-08-10
实施基线：`E:\AiWorkSpace\tavo-mini`
方案：`Tavo-Mini-Story-Memory-No-Stall-P1-P2-Repair-Plan-V3-HEAD-90a6564.md`

## 1. 基线核查

- 已先执行 `git fetch --all --prune`。
- 当前分支为 `main`；本地 `HEAD` 与 `origin/main` 均为 `90a6564ac21637ef0f30b3f0cabeeecec79694fb`，未发现远端领先差异。
- 当前版本为 `V2.11.40`，`versionCode=2114000`。
- 原工作区已有 `CLAUDE.md` 修改、历史优化文档删除和若干未跟踪方案文档；本次没有清理、回滚或覆盖这些既有工作。

## 2. P1 实施内容

### 写作主链路无阻滞

- `storyMemoryPrepare` 改为本地数据库 + Coverage 只读准备，不调用 LLM、不等待 Story Memory 锁。
- Safe Coverage 继续写作；仅真实 Hard Gap 触发本地阻断和安全提示。
- 章节定稿采用 Local First / Return First：章节本地事务先完成并返回；记忆摘要、checkpoint/maintenance 在后台排队。
- 生成上下文仍对 Hard Gap/非法目标 fail-closed，避免把安全边界移到后台后丢失。

### 请求、重试和不确定结果

- 所有 Story Memory 结构化请求统一经过 `storyMemoryRequestPolicy`，固定携带 `thinking: { type: 'disabled' }`。
- 在 provider 的每一次真实 `fetch` 前后接入物理请求 hook；一个逻辑子请求共享最多 3 次真实 HTTP 请求预算，覆盖 protocol fallback 与安全重试。
- `outcome_unknown` 不再被当作可安全重试；传输层不确定结果会进入持久 attempt ledger，冷启动后禁止静默重发。
- 非 2xx、连接/超时等结果按统一 attempt 状态记录；部分成功沿用最后一个成功 checkpoint，不回退已应用数据。

### 持久化与冷启动

- Schema 由 49 升至 50，新增 `story_memory_request_attempts`，不保存 prompt、API Key 或 reasoning，只保存 logical batch、物理 attempt 序号、状态、HTTP/error 元数据和时间。
- 启动期会把已经 `sent` 的 attempt 标记为 `outcome_unknown`；Schema 49→50 的首次启动竞态已加表存在性保护，不再对尚未物理创建的 ledger 表直接报 SQLite 缺表错误。

## 3. P1 自动化测试证据

以下均在最终源码（含缺表竞态保护）上执行：

- `npm run test:ci`：通过；361 suites passed、2 skipped，2926 tests passed、4 skipped。
- Story Memory/LLM 目标集：6 suites passed、56 tests passed。
- `npm run typecheck`：通过。
- `npm run lint`：通过，0 errors、174 warnings；warning 为现有代码风格/规则提示。
- `git diff --check`：无 whitespace error。

新增/覆盖的关键断言包括：23 章 Safe Coverage 写作准备不触发 LLM、Hard Gap 本地阻断、Local First 返回状态、Partial Success、ledger 冷启动 `outcome_unknown`、不确定结果不静默重发，以及 provider fallback + retry 的真实 HTTP 总次数不超过 3。

## 4. 真实 LLM 与模拟器穿测

### APK 升级安装

Debug 构建成功，产物：

`dist/apk/debug/ShineWriter-V2.11.40-debug.apk`

模拟器中原安装包使用正式 release 证书，而 Gradle 默认 Debug 证书不同；为满足“升级安装并保留原 LLM 配置”，本次使用现有正式 keystore 对 Debug APK 重新签名，未创建新 keystore，随后执行：

`adb -s emulator-5554 install -r ...ShineWriter-V2.11.40-debug.apk`

结果：`Success`。安装后仍为 `V2.11.40 / 2114000 / DEBUGGABLE`，证书 SHA-256 仍为：

`017b3fbed4001083f2f70a0c51e8e463322df66b095e1c3a476fdd0d86dc2a0a`

全程没有 uninstall、`pm clear` 或清空数据库。

### 数据保留

升级前快照为 Schema 49；最终冷启动后快照通过 SQLite `integrity_check`，结果为 `ok`，Schema 为 50。LLM 配置元数据保持不变：

- 配置：`默认配置`
- Base URL：`https://api.deepseek.com`
- Model：`deepseek-v4-flash`
- Context window：`1000000`
- active：`1`

API Key 未读取、未打印、未写入报告。穿测章节“黄铜钥匙与沉默的谜语”内容长度在升级后仍为 1248，状态为 `final`；Story Memory 已应用 batch（第 4 章），没有回退。

### 写作主链路

在模拟器中打开该章节并点击“定稿”：本地章节状态先完成，立即检查时内容仍为 1248，未等待 Story Memory LLM；该项目的 smart interval 为 10，因此当时没有额外触发 checkpoint 请求。

### 真实 Story Memory LLM 请求

随后从 Story Memory 页面点击“立即整理长期记忆”，等待约 33 秒。UI 结果：

- `长期记忆：正常`
- `已整理到：第4章`
- 待整理：第5～第12章
- “需要重建”为空

最终数据库证据：

- `project_story_memory.status=clean`
- `story_memory_batches`: 第 4 章 batch 为 `applied`
- `story_memory_request_attempts`: 1 条 `primary`，`attempt_no=1`，`status=succeeded`，`http_status=200`，无 retry、无 error
- `llm_usage_logs`: `scenario=story_memory_checkpoint`，`status=success`，input 3399、output 1606、total 5005 tokens

本次真实请求未发生 retry。请求体中的 `thinking` 字段不由服务端 usage log 回显；其固定 `disabled` 由源码策略和自动化契约测试证明，真实调用则以 HTTP 200、usage success 和应用 batch 成功作为穿测证据。

最终 APK 冷启动复验：`no such table: story_memory_request_attempts` 日志 0 条，`FATAL EXCEPTION` 0 条；升级后再次拉取数据库仍完整、LLM 配置仍保留。

## 5. P2 判定

本轮没有实施 P2 并发改造。当前没有形成足够的 Stateless Observation parity、成本/缓存等价性和 hole/partial-success 对照证据，因此按 V3 方案要求停止 P2；Reducer 与 State Apply 保持现有串行实现，没有新增并发或平行 Provider。

## 6. 结论与剩余风险

- **P1：GO**。写作主链路不再同步等待 Story Memory LLM；Hard Gap 仍 fail-closed；请求预算、Non-Thinking、Partial Success、断点和 attempt ledger 已有源码、自动化、真实 LLM 和升级安装证据。
- **P2：NO-GO / STOP**。Parity 尚未证明，保留串行实现。
- 剩余风险：真实服务端不会回显请求体，因此 `thinking=disabled` 的线上证据仍是客户端策略 + 契约测试，而非服务端回显；后续若推进 P2，必须先补齐 Stateless Observation 的 parity、成本、缓存命中和孔洞/部分成功证明。

证据目录：`test-logs\story-memory-p1-p2-20260810-qa\`，包含升级前后数据库快照、UI dump、logcat、APK 签名/安装结果及脱敏数据库检查脚本。
