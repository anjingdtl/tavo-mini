# ShineWriter 大纲流水线统一收束优化测试报告

日期：2026-08-10

## 1. 本轮范围

本轮以本地当前代码和未提交改动为事实源，完成大纲创作流水线的统一收束：

- 新单章与一键写 N 章统一执行 `Draft → Review → FactCheck → Brief → Proof`。
- 删除新任务的生成模式选择；历史已完成任务仍可查看。
- 单章与 Batch 共用一份用户思考强度配置。
- `Draft / Brief / Proof` 跟随用户档位；`Review / FactCheck` 固定 `low` Thinking。
- 简化当前 Review、FactCheck、Brief 的语义 JSON 协议，由本地 envelope、短 ID 和校验器维护事实边界。
- 旧未完成流水线不再 Resume；Batch 通过新版重建剩余章节。

本地实际代码版本为 `V2.11.40`、`versionCode=2114000`、Schema 49。没有新增数据库迁移，也没有改动无关领域。

## 2. 自动化验证

### 完整门禁

命令：

```text
npm run verify
```

结果：通过。

- ESLint：0 errors，172 warnings；warnings 为项目既有规则告警。
- TypeScript：通过。
- 版本校验：`V2.11.40 / versionCode=2114000`。
- Jest：359/361 suites 通过，2 suites 按项目配置跳过；2920/2924 tests 通过，4 tests 跳过。

### 本轮重点回归

命令：

```text
npx jest --runInBand --ci \
  __tests__/multiChapterBatchWorkflowVersion.test.ts \
  __tests__/multiChapterBatchStore.test.ts \
  __tests__/f301BatchResumeFrozenContext.test.ts \
  __tests__/batchProductionPathFailures.test.ts \
  __tests__/batchReleaseBlockers.test.ts \
  __tests__/cl01SafeRetryRealChain.test.ts
```

结果：6 suites、36 tests 全部通过。

覆盖内容包括：统一完整五阶段、Batch 逐章创建与采纳、冻结上下文恢复、旧 Batch 阻断与新版重建、safe retry 持久化、预算门禁以及真实 reconcile 状态机链路。`cl01SafeRetryRealChain` 只替换 LLM 网络出口，属于 mock provider 的真实 reconcile 链路，不计入真实 LLM 统计。

## 3. Debug APK 与模拟器验证

构建命令：

```text
npm run apk:debug
```

产物：

```text
dist/apk/debug/ShineWriter-V2.11.40-debug.apk
```

模拟器原安装版本为 V2.11.34。首次直接安装默认 Debug 签名 APK 时，Android 报告签名不一致；未执行卸载、清数据、`pm clear` 或重建模拟器。随后使用项目已有正式证书对当前 Debug 构建产物做本地同证书签名，并再次使用：

```text
adb install -r
```

升级覆盖成功，设备版本为 V2.11.40，原应用数据目录保持为 `/data/user/0/com.shinewriter`。

UI 与日志结果：

- 设置首页显示统一完整流水线文案，不再显示“按模式动态分阶段”。
- 流水线配置页只有“思考强度”快速/平衡/质量，没有生成模式选择。
- “一键写 N 章”入口正常打开，表单未出现生成模式选择。
- 启动、设置页与 Batch 入口均未发现应用 fatal marker。
- 模拟器现有 LLM 配置和项目数据保持；只读检查发现设备没有可运行的 pipeline task 或 Batch。

## 4. 真实 LLM 统计边界

本轮没有发起当前版本的真实 LLM 单章或 Batch 请求，因此以下指标为 N/A，不记为 0%：

- primary 一次通过率：N/A。
- Formatter 次数：N/A。
- 真实重试次数：N/A。

原因是模拟器现有项目只有一个空的计划章节，没有可运行的大纲、任务或 Batch。为保留用户现有项目数据、API Key 和数据库状态，本轮没有人为创建测试内容或改写现有项目，也没有把 mock provider 结果冒充真实 LLM 结果。

此前 V3.2 真实 QA 报告中的调用统计仅作为历史基线，不计入本轮当前协议结果。

## 5. Batch 结论

自动化 Batch 验证通过：

- 新 Batch 固定完整流水线和当前工作流版本。
- 旧未完成 Batch 进入阻断状态，不继续旧语义。
- 新版重建只保留剩余章节，并冻结当前思考强度与工作流版本。
- safe retry、失败节点恢复、预算门禁和多章节顺序推进均通过。

模拟器只完成 Batch 入口 UI 验证，未启动真实 Batch 请求。

## 6. 发版判断

当前达到开发验证和自动化回归通过条件，但尚未达到正式发版条件：

1. 本轮缺少当前 V2.11.40 协议的真实 LLM 单章与 Batch 统计。
2. 本轮只构建并验证 Debug APK，没有执行正式 Release APK 构建和发布验收。
