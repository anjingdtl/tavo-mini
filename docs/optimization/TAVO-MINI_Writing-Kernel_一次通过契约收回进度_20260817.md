# Writing Kernel 一次通过契约收回进度

**日期：** 2026-08-17  
**仓库：** `E:\AiWorkSpace\tavo-mini`  
**状态：** 进行中。Kernel 统一目标不变；一次通过契约必须留在 Shared Writer 内。  
**禁止：** 宣布 FINAL SEALED / GO；用改测试、放宽断言、恢复旧 Prompt/Core 或增加 live model-config 读取来过关。

---

## 1. 为什么要做这一轮

8 月 5–10 日大纲流水线已经治理到可验收：

- V2.11.41 Budget V5 审计：6 章 30 个主阶段，首次 Primary 29/30，**一次通过率 96.7%**。
- 同期真实 LLM：53/60 = 88.3% 语义一次通过，但 **7 次 Contract Formatter 全部救回**，完整 Primary 重试 = 0，最终失败 = 0。

那套一次通过不是“换一个 Writer 函数名”换来的，而是四条生产契约：

1. **每阶段 Freeze thinking/effort**（V3.2/V3.3：结构化主阶段 thinking enabled，FactCheck 固定 low）。
2. **双通道候选**：content 空但 reasoning 里有完整 JSON 时本地采用，不算失败。
3. **最多一次 thinking-disabled Formatter**，禁止完整 Primary replay。
4. **Brief 是语义压缩器**，不是 300 秒预算下的无界整章重写。

8 月 16–17 日 Writing Kernel 收束把生产正文改到 `writerCore.ts` + `compileSharedWritingPrompt()`。CAS / Freeze / 单 Writer 边界是对的，但上面四条契约没有一起迁过去。结果是：

- Review/FactCheck 被 Writer Core 一律 `thinking: disabled`，V3.3 `stageReasoning` 算了也不用。
- 只认 `result.text`；reasoning 里的合法 JSON 变成 `SHARED_WRITER_EMPTY_OUTPUT`。
- Formatter 生产调用为 0。
- Revision prompt 变成“重写完整章节”，同一 300 秒超时被整章思考打爆。
- Continuation JSON draft 一度丢掉 DeepSeek V4 `thinking: disabled`。

这不是“再修一个 DeepSeek BUG”就能解释的一次通过率下降。**统一 Kernel 时把已经治理好的流水线当成旧 Core 删掉了。**

后续任何人改 Writing Kernel，必须同时保住：

- ONE Writer Core / ONE Draft compiler / 无 `frozenStageMessages` / 无 Freeze 后 live model-config 读取
- **以及** 上述四条一次通过契约

丢掉后者再宣布 Writer 已统一，属于再次踩坑。

---

## 2. 本轮改造范围

目标：**契约进 Kernel，不回退双 Writer。**

| 契约 | 新落点 | 明确不回退 |
|---|---|---|
| 每阶段 thinking | Freeze 时写入 `stagePolicy.values.stageReasoning`；Writer Core 只读冻结表 | 不在 Writer Core 里按模型名猜 DeepSeek |
| 双通道采用 | `writerRecovery.adoptStructuredWriterText` → `selectStructuredCandidate` | 不把 reasoning 当散文 Draft 正文 |
| 一次 Formatter | `writerRecovery.compileSharedWriterFormatterPrompt`，thinking disabled，无第三跳 | 不恢复 `reconcile.ts` 旧 Writer |
| Brief 修订合同 | `compileSharedWritingPrompt('revision')`：JSON 合同 + maxTokens≤8192 | 不恢复 `compileBriefStageRequest` 为第二套生产编译器 |

关键文件：

- `src/services/writing/contracts/stageReasoning.ts`
- `src/services/writing/stages/writerRecovery.ts`
- `src/services/writing/stages/writerCore.ts`
- `src/services/writing/prompt/sharedPromptCompiler.ts`
- `src/services/writing/contracts/writingPolicy.ts`
- Outline Freeze：`outlineStageDriver.ts` / `outlineStageRuntime.ts` 传入已计算的 `execution.stageReasoning`

硬门禁：`__tests__/writingFirstPassContracts.test.ts` + `writingFinalSealGates.test.ts`。

---

## 3. 验收未完成项

- [x] 红灯测试定义一次通过契约
- [x] Focused green + 原有 anti-rename / anti-Facade / seal gates
- [x] V3.2 workflow 集成恢复到收束前契约（enabled thinking、本地采用、一次 Formatter）
- [x] 改动文件 lint 0 error；typecheck PASS
- [ ] 全量 Jest / Generation Stability / Replay x10
- [ ] 最终 HEAD 上真实 LLM Outline 3 + Continuation 3（不得沿用旧 3+3）

未完成前不得宣布 `FINAL SEALED / GO`。
