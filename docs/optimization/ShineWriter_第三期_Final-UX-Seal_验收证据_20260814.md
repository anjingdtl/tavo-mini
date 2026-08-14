# ShineWriter 第三期 Final UX Seal（NG-LLM 定点收尾）

日期：2026-08-14
产品版本：V2.11.52
范围：只关 NG-LLM-01 / NG-LLM-02。不改 Writer Style 已封板架构。

## 身份锚点

| 锚点 | 值 |
| --- | --- |
| 前一轮 Code HEAD | `8cd67524ccbfec5f964549b62d1012159fe9514b` |
| 本轮 Code HEAD | 见本文件所在提交；不回写自己的 SHA |
| 上一轮 Actions | `31788851482` |

Writer Style 第三期协议仍以 `ShineWriter_第三期_Final-Seal_验收证据_20260814.md` 为准。

## Seal 判定

NG-LLM-01 / NG-LLM-02 = CLOSED。无新 P0/P1。
第三期剩余 NO-GO = 0。结论：GO / SEALED。

## 关闭证据

| 编号 | 结果 | 证据 |
| --- | --- | --- |
| NG-LLM-01 | CLOSED | 删除 `syncLLMCapabilityAfterAutoApply`。`applyContextAutoAllocationV3` 仍只写 `context_auto_mode` / `context_auto_policy_v3` / `context_auto_input`。模拟 128K 后设备 `llm_config` 仍为 `1000000 / 200000`，只有 `context_auto_input=128000`。 |
| NG-LLM-02 | CLOSED | `resolveLLMConfigIdForContextSync` 不再 fallback 到 active/`configs[0]`。draft id=0 / 未知 id fail-closed。未保存配置进入 Context Auto 只做模拟。 |

故障注入 A–F：`__tests__/llmContextAutoCapabilityIsolation.test.ts` 全过。

## 本轮明确撤销的错误行为

上一轮 UX Closure 把 80/20 模拟窗口写回当前 `llm_config.context_window` / `max_output_tokens`。该行为违反 V3 合同，已删除。LLM 设置页 `useFocusEffect` 刷新保留；未保存 draft 不再偷改其他模型。

## Gate

| Gate | 结果 |
| --- | --- |
| lint / typecheck / test:ci / coverage / verify:version / migration | GO（415 suites / 3274 tests；覆盖率 Statements 73.89% / Branches 63.25% / Functions 78.58% / Lines 75.63%） |
| Android Debug + `adb install -r` | GO，`ShineWriter-V2.11.51-debug.apk` 56.63 MB |
| Maestro 15 LLM + Context Auto | GO，设备库证明能力未改 |
| Maestro 05 LLM 只读 | GO |
| Maestro 01–06 | GO（本轮抽检） |
| Maestro 07+ 续写新建对话框 | 未作为本轮阻断。失败点是 `new-project-name` 未弹出，与 LLM 能力写回无关，不记新 P0/P1 |
| Writer Style | 未改动 |

## 合同

- `context_auto_input` = Preview / 预算模拟窗口。
- `llm_config.context_window` / `max_output_tokens` = 模型真实能力，只在 LLM 设置页保存时改变。
- Context Auto 可读取选中模型窗口作默认模拟值，不得反向覆盖。
- 恢复默认不改任何 LLM capability。
