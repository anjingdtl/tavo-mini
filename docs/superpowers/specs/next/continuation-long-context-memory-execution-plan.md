# 续写长上下文与持续记忆执行方案

## 目标

让原著续写在长上下文模型下，像大纲创作一样持续使用并更新两类记忆：

1. 原著边界前的 Canon 与原著接缝；
2. 边界后的续写章节短期桥接、章节事件记忆和长期 Story Memory。

每次续写只能读取目标章节之前的内容；不得因为更大的窗口而无界增长，也不得把未定稿草稿写入长期记忆。

## 当前缺口

- 接缝原著固定 400 token、最近续写固定 5 x 500 token，且从章节开头裁取。
- 续写上下文直接裁取 `memory_json` 至 800 token，未走 checkpoint eligibility、Renderer、章节事件检索与覆盖计划。
- 续写定稿只排队状态提取；Story Memory 重建要等待 proposal 人工确认，和编辑器提示不一致。
- 已确认的关系、知识、经历未完整进入 Planner/Writer 提示。
- 已定稿续写章节内容变更已由通用章节仓储触发状态与记忆失效；本轮不重复接入 UI 回调，避免产生双重重建任务。
- 上下文窗口只从当前激活模型读取，未按 Planner/Writer 的实际冻结模型求安全预算。

## 实施设计

### 1. 阶段感知的上下文预算

新增纯函数 `planContinuationContextBudget()`：

- 先解析 Planner、Writer、Checker 的冻结模型配置；共享生成上下文按 Planner/Writer 可用窗口的较小值计算。
- 输出预留使用实际阶段输出上限与固定安全余量，不把 1M 窗口机械预留 15%。
- 原著接缝、最近续写桥接、长期记忆、章节事件记忆、Canon、补充资料拥有明确类别预算和上限。
- 所有裁剪使用 token 估算；关键接缝使用尾部裁剪。最终按已编译 messages 再做不超窗校验。

### 2. 续写短期与长期记忆

续写 Context Builder 复用既有 `project_story_memory`、checkpoint eligibility、Story Memory renderer 与 episodic retriever：

- 只注入 `clean` 且 `through < targetPosition` 的检查点；dirty、failed、future/same checkpoint 不得泄漏正文。
- 最近续写章节按“最近章完整/章末优先，较早章递减”组成短期桥接。
- 从已定稿章节的 `memory_summary` 按本章指令检索章节事件，且排除已作为原文桥接的章节，避免重复。
- 原著仍由 Canon 与接缝负责；Story Memory 只累计边界后的续写章节。

### 3. 定稿与状态治理解耦

定稿的单一事务同时写入：章节 finalized、Story Memory dirty、`extract_state` outbox、带依赖的 `rebuild_story_memory` outbox。

- 重建任务依赖状态提取完成，以保证队列顺序可恢复、可重试。
- 状态提取无论是否产生 proposal，都推进章节摘要/长期记忆。
- proposal 确认继续生成权威 state event，并再触发从该位置开始的重建。
- 重大 proposal 仍要求人工审核；普通章节记忆不等待审核。

### 4. 提示、可观测性与失效

- Planner/Writer 同时渲染人物、关系、知识、经历、剧情状态。
- Trace 显示实际模型窗口、输入预算、桥接章节、长期记忆检查点、episodic 命中与省略原因。
- 已定稿章节 hash 变更时接入 continuation state invalidation；未定稿自动保存不污染长期记忆。
- 上下文预览区分“完整请求”与“资料上下文”，并标明 Planner/Writer/Checker 阶段。

## 自审结论

- 不把原著全文写入 Story Memory，避免原著 Canon 与续写事实混淆。
- 不让 Context Builder 在每次生成时额外调用 LLM；记忆更新只由持久化 outbox 异步完成。
- 不以“1M”作为无上限注入许可：采用类别上限、尾部优先和最终 message preflight，避免成本、延迟及中部遗忘。
- 不自动确认高风险 proposal；自动更新的是可由定稿正文直接验证的章节摘要与长期检查点。
- 如需持久化新的项目级上下文深度配置，必须走 Schema 25 → 26 迁移、schema manifest、备份与迁移测试。

## 验收

1. 8K、32K、128K、1M 窗口的预算单调增长，且每阶段 message 不超窗。
2. 原著接缝和最近续写均从章末承接；边界中途不泄漏未来原著。
3. 多章定稿后，下一章可见 clean Story Memory、最近桥接及检索到的章节事件。
4. state extraction 为空、失败、pending proposal、major proposal、确认 proposal 均有确定的 outbox/记忆行为。
5. 修改已定稿章节后，旧 event/记忆失效并从最早影响位置重建。
6. lint、typecheck、Jest/coverage、Android Debug、模拟器关键流程、Release APK 签名/元数据验收全部通过。
