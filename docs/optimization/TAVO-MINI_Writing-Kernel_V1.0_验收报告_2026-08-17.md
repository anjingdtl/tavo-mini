# TAVO-MINI Writing Kernel V1.0 验收报告

**日期：** 2026-08-17

**仓库：** `E:\AiWorkSpace\tavo-mini`

**验收方案：** `docs/optimization/TAVO-MINI_Writing-Kernel_最终收束与防改名糊弄验收方案_V1.0.md`

**验收范围：** Shared Writer 收束、Outline/Continuation 生产调用图、耐久状态与账本、全量回归、Debug 模拟器穿测

## 1. 结论

本 checkpoint 的代码收束与 Debug 验收通过。生产正文路径已统一到 Shared Writer，旧的完整 Continuation V5 Writer 已删除，硬门禁、全量测试、稳定性/replay、Debug APK 安装和真实 LLM 穿测均已执行。

正式 Release APK、Release Checklist 和发布签名验收未在本 checkpoint 执行，因此本报告不替代正式 Release 封板记录。

## 2. 本轮根因与修复

### 2.1 Pipeline 契约迁移

- `pipelineRunner.test.ts` 按 V4/Shared Writer 契约收束，失败路径改为 fail-closed，不恢复旧的 retry Writer。
- Review/Audit/FactCheck 的输出契约统一为结构化 JSON 报告；非法报告直接失败，正文 Stage 保持文本契约。
- Outline 写阶段继续通过 CAS/attempt 入口执行；Resume Freeze 只经 `ReconcileOptions` 传递，不改历史 `pipeline_context_json`。

### 2.2 Continuation 耐久账本

- `continuationDurableAdapter` 为五个物理写作节点执行一次性 reservation，禁止 Resume/并发重复请求。
- Stage result 保留 reservation 的输入 token 预算，并在完成时写回实际 input/output usage，使批次报告按 `request_count` 正确统计。
- 结构化 Review/Audit 报告可从耐久记录恢复，不因 Resume 丢失 Stage body。

### 2.3 Story Memory 与模式路由

- 修复 `project_story_memory.memory_json='{}'` 占位默认值进入重建流程的问题，并保留 Android SQLite 原生错误诊断。
- 修复 Multi-Chapter 页面在项目/路由切换时的 Outline/Continuation 状态串线和过期异步 hydration。
- 将 `pipeline_brief` 纳入长请求超时策略。

### 2.4 第二套 Writer 清理

- 删除 `src/services/continuation/generation/legacy/continuationV5Writers.ts` 的完整重复 Writer。
- 保留 legacy pipeline/runner 的兼容边界，但生产调用图不再导入旧 Writer。
- 新增生产 import graph 硬门禁，防止通过目录名排除旧 Writer。

## 3. 自动化质量门

| 门禁 | 结果 |
|---|---|
| `npm run lint` | PASS，0 errors；保留既有 warnings |
| `npm run typecheck` | PASS |
| `npm run verify:version` | PASS，V2.11.53 / versionCode 2115300 一致 |
| Full Jest | PASS，452 suites passed，4 skipped；3508 tests passed，9 skipped |
| Generation Stability workflow 同款 16 suites | PASS，81/81 tests |
| Replay targeted suites | PASS，2/2 suites，16/16 tests |
| `pipelineRunner.test.ts` | PASS，38/38 tests |
| Story Memory / Durable Adapter 定向回归 | PASS，4 suites，41 tests |
| `git diff --check` | PASS |

Generation Stability 使用 `.github/workflows/generation-stability.yml` 中的完整 `--runTestsByPath` 命令执行，未使用 `allow-failure`。

## 4. Debug APK 与模拟器

- 构建命令：`npm run apk:debug`
- 安装命令：`adb -s emulator-5554 install -r dist/apk/debug/ShineWriter-V2.11.53-debug.apk`
- 产物：`dist/apk/debug/ShineWriter-V2.11.53-debug.apk`
- 安装后冷启动进入作品库，未发现 React Native、AndroidRuntime 或 FATAL 崩溃。
- 模拟器已有 LLM 配置和项目数据保持可用。

## 5. 真实 LLM 穿测

### 5.1 Outline 3/3

测试项目：`qa-outline-pdca-20260817`。真实 LLM 连续生成 3 章成功，批次报告为成功 `3/3`，对应 brief/draft/factCheck/proof/review checkpoints 全部成功，未出现 `SHARED_WRITER_INVALID_REPORT` 或 FATAL 崩溃。

### 5.2 Continuation 3/3

测试项目：`qa-cont-pdca-20260817`。Canon、规划和连续 3 章续写链路成功，章节 72/73/74 均 finalized，18 个物理 Stage 全部 success，Story Memory 重建与 outbox 均 completed，最终批次为 `3/3`。

### 5.3 最新账本修复烟测

在最新 Debug APK 上执行 1 章真实续写，run `ct_08434cbbde364b45906def8e8103f88f` 已 `completed/adopted`：

- `draft_writer`、`narrative_architect`、`revision_writer`、`adversarial_auditor`、`final_reviser` 五个物理节点均 `request_reserved=1`、`request_count=1`、`status=success`；
- 批次账本统计为 `used_llm_calls=5`、输入 tokens `48,001`、输出 tokens `43,231`；
- Story Memory `status=clean`，through position 为 5；extract/rebuild outbox 均 completed；
- 一次真实网络失败被记录为 1 次 reservation，未发生静默重复请求。

该烟测中，Agent 在等待状态同步期间通过 UI 结束了外层批次，因此外层 batch 状态为 cancelled；run、正文采用和 Story Memory 已完成，不能把该批次状态当作新的 1/1 clean-batch 证据，但它完整验证了最新 reservation/usage 修复。

## 6. 证据文件

以下证据保留在本机 `test-logs/emulator-qa-20260817-pdca/`：

- `ui-outline-after-fix-poll-600s.xml`
- `db-cont-final.sqlite`
- `db-ledger-smoke-final.sqlite`
- `ui-final-cold-start.xml`
- `logcat-final-cold-start.txt`

## 7. 发布边界

本报告结论为：**Writing Kernel Debug checkpoint PASS**。正式 Release 封板仍需按 `docs/RELEASE_APK_BUILD.md` 与 `docs/RELEASE_CHECKLIST.md` 执行 Release 构建、签名校验、安装和发布前验收。
