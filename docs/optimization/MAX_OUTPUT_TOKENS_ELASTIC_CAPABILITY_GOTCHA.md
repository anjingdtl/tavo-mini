# `max_output_tokens` 弹性能力配置坑位说明

更新时间：2026-08-27

## 结论

`llm_config.context_window` 与 `llm_config.max_output_tokens` 是所选模型的真实能力声明，不是 ShineWriter 的产品默认值。任何页面、Store、Repository、Pipeline stage、Provider 或兼容适配器都不得自行写入 4000、4096、8192、128000 等“常见模型值”作为兜底。

当前约定：

- 持久化值 `0` 表示 `AUTO / unknown`，不是一个真实的模型能力。
- 如果 `max_output_tokens` 已填写正数，它是用户根据模型文档提供的逻辑能力上限；运行时保留它。
- 如果 `max_output_tokens` 留空或为 `0`，统一从同一模型的 `context_window × 20%` 弹性派生。
- 逻辑能力随后经过 Provider capability adapter 转成线路协议允许的 `max_tokens`，再由阶段预算按任务需要收缩；Provider 上限和阶段 demand 都不能回写模型真实能力。
- `context_window` 也必须来自当前选定模型。缺少它时，涉及输入打包或模型冻结的路径必须 fail-closed，不能假装使用某个大模型窗口继续发送。

唯一入口是 [`providerCapabilities.ts`](../../src/services/llm/providerCapabilities.ts)：

- `resolveModelOutputCapability`：解析已配置能力或按 context 弹性派生。
- `requireModelContextWindow` / `requireModelMaxOutputTokens`：模型冻结和严格预算路径的 fail-closed 校验。
- `resolveProviderOutputBudget`：只做逻辑能力到 Provider wire 能力的转换。
- `resolveLLMRequestConfig` / `resolveLLMRequestConfigById`：把持久化 `0` 转成运行时 AUTO 结果。

## 最容易复发的错误

不要写以下代码：

```ts
const contextWindow = Number(config.context_window) || 128000;
const maxOutput = Number(config.max_output_tokens) || 4000;
const maxTokens = options.maxTokens ?? 8192;
```

也不要把 Context Auto V3 的模拟窗口、Preset 的 `max_tokens`、资源条目的输入预算或某个阶段的最小输出 demand 当成模型能力。它们属于不同层次：

| 层次 | 允许的来源 | 是否能代表模型能力 |
| --- | --- | --- |
| 模型能力 | `llm_config` + Provider adapter | 是 |
| 运行时逻辑输出 | `resolveModelOutputCapability` | 是，来自模型能力 |
| 阶段/任务 demand | 当前阶段协议和质量要求 | 否，只能在请求内收缩 |
| 资源 `max_tokens` | 资料输入裁剪预算 | 否，是输入预算 |
| Preset/Tavern `max_tokens` | 旧资产或外部格式兼容字段 | 否，不能控制 ShineWriter 运行时 |
| 测试/迁移/debug 固定值 | 历史数据、夹具、显式诊断场景 | 否，不得复制到产品运行时 |

## 数据迁移和兼容

Schema 58 的 `v57-to-v58` 只把仍然完全未配置、且恰好沿用旧种子值的 LLM 行转换为 `0/0`；已经选择模型或填写能力的行保持原值。旧 migration 和测试夹具中出现历史 `4096/4000` 是兼容证据，不表示当前默认值。

作家风格和 Tavern 导入可以保留外部文件中的正数 `max_tokens`，但它们只是资产兼容元数据。新建/生成资产使用 `0` 表示 AUTO，运行时输出由当前 LLM 模型能力解析器决定。

## 防回归规则

提交前必须执行：

```text
npm run verify:elastic
npm run typecheck
npm run verify
```

`verify:elastic` 扫描活跃 `src`，阻止模型能力字段重新出现固定 4000/4096/8192 回退，也阻止 `contextWindow || 128000` 一类窗口冒充。历史 migration 被排除是为了允许幂等迁移表达旧值；这不构成运行时代码豁免。

审查新代码时按下面顺序检查：

1. 先确认调用是否拿到了当前冻结的 `LLMRequestConfig`。
2. 没有显式任务 demand 时，让 `callLLM`/Provider 从 request config 解析输出预算。
3. 有任务 demand 时，使用共享解析结果做上限收缩，不要把 demand 写回 `llm_config`。
4. 没有真实 context 或输出能力时，返回可行动错误或进入明确的诊断/fallback 入口；不能默默采用常见模型值。
5. 新增固定数字时注明它是协议最小值、输入预算、重试策略还是 Provider 外部合同；若它看起来像模型能力，必须放进能力适配器并写测试。

这条边界是 Phase III-B 的硬门禁：模型能力只从模型声明来，自动化只调整本次请求的上下文和阶段 demand。
