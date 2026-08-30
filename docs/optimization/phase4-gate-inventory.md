# Phase IV-1 Gate Inventory & Simplification

日期：2026-08-30
主方案：`docs/optimization/TAVO-MINI_Phase4_流水线再治理与写作通过率恢复计划_20260830.md`

## 结论

现行主链的真正 Hard Gate 只保留八类安全/能力边界：冻结请求绑定、Mandatory Truth、Provider 硬能力、`finishReason=length`、`outcome_unknown`、最终正文完整性、DB transaction/Resume、Canon/状态安全。

质量报告字段、非关键 finding、可丢弃的状态 sidecar 不再阻断完整正文；Final Candidate 与 Persist Safety 合并为一个本地 Persistence Boundary；Review/Audit/FactCheck 只在历史拓扑保留，Compact 主链合并为 ONE QA。

Governor 当前请求否决、Formatter 救援 LLM call、模型侧 hash/fingerprint 以及重复诊断全部退出正常主链。

## 分类摘要

| 分类 | 数量 | 处理 |
| --- | ---: | --- |
| KEEP HARD BLOCK | 8 | 只保护数据、付费、截断正文、真相/状态和 Provider/DB 硬边界 |
| DOWNGRADE TO ADVISORY | 3 | 质量形状、非关键质量 finding、可丢弃的状态 sidecar |
| MERGE | 3 | Persistence Boundary、ONE QA、本地确定性计算 |
| REMOVE | 4 | Governor 当前否决、Formatter 救援、模型侧 hash、重复诊断 |
| 合计 | 18 | Hard Gate 占比 44.4%，低于半数 |

## Gate 逐项记录

完整机器可读清单位于：
`src/services/writing/gates/phase4GatePolicy.ts`。每一项均记录名称、Stage、触发位置、业务目的、是否阻断、失败后果、保护对象、是否重复、是否需要 LLM/JSON、是否可本地归一化以及移除后的最坏风险。

### KEEP HARD BLOCK

- `frozen_context_and_fingerprint`：冻结请求与 Resume 身份不能漂移。
- `mandatory_truth`：Truth / Canon / continuity 投影漂移必须 fail-closed。
- `provider_capability_boundary`：Mandatory + 最低可见正文 + 合理 reasoning 超出 Provider 数学能力时才阻断。
- `truncated_output`：`finishReason=length` 永不作为 Final 落库。
- `outcome_unknown`：未知付费结果只记账、不自动 retry。
- `final_body_integrity`：最终候选为空或不完整时不完成。
- `persistence_transaction`：DB、checkpoint、Resume 失败时不假装完成。
- `canon_state_safety`：明确会污染 Canon/Story State 的变更 fail-closed。

### DOWNGRADE / MERGE / REMOVE

- QA/Review report shape 与普通风格问题只产生 bounded advisory；不能因为缺少 confidence、analysis、evidence、长摘要而丢掉完整正文。
- Final Candidate 与最终落库保护合并；本地 hash/fingerprint/diff/changeset 不进入模型正常协议。
- Compact 主链只走 `Draft → ONE QA → (optional Revision) → local Persistence Boundary`；旧 Review/Audit/FactCheck 仅为历史 Resume 兼容。
- Governor 只记录本轮结果并生成下一轮建议；Formatter 不再以第二次付费请求救援当前 Stage。

## P0 审核

- Thinking Always On：保持。
- 不新增 Agent/Writer/Context/Memory/Prompt Compiler：保持。
- Mandatory Truth、`length`、`outcome_unknown`、付费记账、Resume/Idempotency、Canon/State safety：均列为 Hard。
- Android 数据边界：后续 CHECK-B 继续只使用 `adb install -r`，不 uninstall/pm clear。

## IV-1 决策

PLAN/RED 已完成；本清单由 Red 测试锁住。DO 先落地显式策略层，随后由 IV-2～IV-5 将对应 remove/merge/advisory 行为接入运行时。历史 C8 Resume、C9 Observability 和失败证据不改写。
