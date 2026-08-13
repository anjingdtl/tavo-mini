# ShineWriter 第二期 Final Seal / 验收证据

> 文档日期：2026-08-13  
> 项目：`anjingdtl/tavo-mini` / ShineWriter  
> 唯一实施方案：`docs/optimization/ShineWriter_第二期_资料资产_写作流水线_弹性上下文接驳方案_20260813.md`  
> 实施前基线：`main@1c7e50af`（一期 construction PDCA 已入库）  
> 一期 Final Seal 基线：`746af54f`  
> 应用版本：`V2.11.50` / versionCode `2115000`  
> 数据库 Schema：**51（未升 52）**  
> 新任务契约：Context Budget **7** / Resource Context **2** / Pipeline Snapshot **4**  
> 最终结论：**GO。第二期剩余 NO-GO = 0。**

---

## 0. 一句话结论

第二期已把一期封板的角色 / 世界书 / 预设接进写作运行时：启用资料先形成 **Global Awareness**，相关时再展开 **Elastic Detail**，Preset 按五阶段策略绑定；新大纲任务冻结 V7/V2/V4，旧 V6/V3 任务 Resume 不自动升级。Android 覆盖安装后 Preview 用同一套 Draft 编译器证明青秀路事实进入 Prompt，且带「小说设定数据 / 不得覆盖写作协议」隔离包装。

---

## 1. 范围与不做事项

本期完成方案 §2.1 Must / P0：

| ID | 项 | 结论 |
|---|---|---|
| P2-01 | Preset → Pipeline 正式接驳 | PASS |
| P2-02 | Character → Global Awareness + Detail Renderer | PASS |
| P2-03 | Worldbook → Global Awareness + Detail Activation | PASS |
| P2-04 | Resource Context 双层候选 | PASS |
| P2-05 | Context Budget 对 Global / Detail 弹性适配 | PASS |
| P2-06 | Pipeline Context Snapshot V4 | PASS |
| P2-07 | Draft / Review / FactCheck / Brief / Proof 阶段消费 | PASS |
| P2-08 | Freeze / Resume / cold-start Resume | PASS |
| P2-09 | Context Preview / Trace 可解释性 | PASS |
| P2-10 | Android E2E + 覆盖安装 + Final Seal | PASS |

明确未做（方案禁止 / 下期）：

- Embedding / RAG / Top-K
- 生成前额外 LLM 总结 round-trip
- 把 Outline 当已发生剧情事实
- 改写一期 V6 封板语义或静默升级旧任务
- 续写 Canon / V4 / V5 runner 改造
- 发版升版本号（仍为 V2.11.50）

---

## 2. 与方案的冲突及处理（数据兼容优先）

按用户规则：方案与现码冲突时，优先保证数据兼容、Frozen Snapshot 一致性、Context Budget 正确性，并记录原因。

### 2.1 Schema 51 未升 52

方案初稿讨论过给 `worldbook_entries` / `worldbook_collections` / `note_collections` 加 `source_revision`。

**实施决定：Schema 保持 51，不加迁移。**

原因：

1. Character 在 Schema 51 已有 `source_revision`。
2. Worldbook / Notes / Preset 的变更可用语义内容 + `updated_at` 计算确定性 fingerprint，不必为二期单独加列。
3. Capsule 由冻结源码编译，不把派生胶囊当权威存储。
4. 新装与升级用户共用 `createCurrentSchema` + 现有迁移链，避免「升级有列、新装无列」或相反漂移。

权威一致性靠 `computeResourceSourceFingerprint` + 三次读取比对（`RESOURCE_SOURCE_CHANGED_DURING_BUILD`），而不是新列。

### 2.2 未新增 `context_preview_v2_enabled` 默认 OFF

方案曾写 Preview V2 用独立 feature flag。

**实施决定：新大纲章节任务 / Preview 直接冻结并走 V7。**

原因：

- 新任务必须冻结 `contextBudgetVersion=7` 才是二期产品语义。
- 再套一层默认 OFF 的 Preview 开关，会使 P0「新任务走 V7」在真机上不可验收。
- 旧任务 Resume 仍只读冻结 snapshot 的版本字段；`contextBuilder` 对 `budgetVersion === 6` 走原 V3 分层，`>= 7` 才走 V7。这已经是版本隔离，不需要第二个全局开关。

`elastic_budget_v2_enabled` 保持原样，未改一期语义。

### 2.3 Capsule 不落独立表

方案允许 Capsule 派生。实施只冻结 **源快照 + 编译结果文本 + fingerprint**，运行时确定性重编译。Resume / 五阶段不再回读 live 资料库。

### 2.4 fingerprint 不得包含 `Date.now()`

初版 `snapshotFingerprint` 把 `capturedAt=Date.now()` 编进哈希，导致同一次 Preview 两次读永远不相等，真机 fail-closed 成 `RESOURCE_SOURCE_CHANGED_DURING_BUILD`。

**修复：指纹只哈希 characters / worldbook / notes / preset 的源指纹 + includeResources。** `capturedAt` 仅作观测字段。`id` 固定为 `'view'`。

### 2.5 预设 id `0` / 空选择

设置里「未选预设」常落成 `0`。若把 `0` 当显式预设，Preview 会 `PRESET_SOURCE_READ_FAILED`。

**修复：`requestedPresetId <= 0` 视为未选择，走默认小说基线；只有 `id > 0` 且读失败才 fail-closed。**

---

## 3. 架构落地对照

```text
角色档案 / 世界书              Preset
        │                        │
        ▼                        ▼
Global Awareness Capsule     writing baseline
        +                    system / style / extra
Elastic Detail                   │
        │                        │
        └──── protected ─────────┤
                                 ▼
                    Context Budget V7
                                 ▼
                    Snapshot V4（冻结源+编译结果）
              ┌──────────┬───────┼────────┬──────────┐
              ▼          ▼       ▼        ▼          ▼
            Draft      Review  FactCheck  Brief     Proof
```

运行时入口仍是 `pipelineRunner` / `compileStageRequest` / `contextBuilder`。V7 资料编译在 `src/services/context/resources/`，五阶段只读冻结视图在 `src/services/pipeline/stageResourceContextV4.ts`。

版本常量（`outlineWorkflowVersion.ts`）：

- `V3_HIERARCHICAL_CONTEXT_BUDGET_VERSION = 6`（旧任务 Resume）
- `PHASE2_CONTEXT_BUDGET_VERSION = 7`（新大纲任务冻结）
- `PHASE2_RESOURCE_CONTEXT_VERSION = 2`
- `STRUCTURED_CONTEXT_BUDGET_VERSIONS = [3, 4, 5, 6, 7]`
- `isCurrentOutlinePipelineContextBudgetVersion`：5 / 6 / **7**
- `normalizePersistedContextBudgetVersion(7) === 7`，未知版本塌到 1，**不会**把 6 升成 7

`contextBuilder.buildContext`：

- `budgetVersion === 6` → 原 V3 分层资源路径（一期封板）
- `budgetVersion >= 7` → Awareness 保护区 + Detail 弹性 + Preset 基线

---

## 4. PDCA 轮次

| 轮 | 内容 | 结果 |
|---|---|---|
| 0 | 读方案、现码、一期 V6/V3 封板边界 | 锁定 Schema 51、V6 不改、新任务 V7 |
| 1 | Character / Worldbook Awareness 编译器 + 指纹 + fail-closed | 单测 PASS |
| 2 | Resource Context V2 双层候选 / scorer / 强度 | 单测 PASS |
| 3 | Context Budget V7 + `contextBuilder` 独立分支 | 单测 PASS |
| 4 | Preset 五阶段绑定（full / evaluation / hard / minimal） | 单测 PASS |
| 5 | Snapshot V4 + Freeze / Resume / cold-start | 单测 PASS |
| 6 | Context Preview / Trace / UI（仅全局感知、详情已展开） | 单测 + 真机 |
| 7 | lint / typecheck / test:ci / Android 覆盖安装 E2E | 全绿后封板 |

真机发现并修了两个 P0：

1. 预设 `id=0` 被当成显式选择 → fail-closed  
2. snapshot fingerprint 含时间戳 → `RESOURCE_SOURCE_CHANGED_DURING_BUILD`

两处均已补测试语义（preset `<=0` 走默认；指纹不含 `capturedAt`）。

---

## 5. GO 清单（方案 §60）

| 项 | 证据 | 结论 |
|---|---|---|
| Character Global Awareness 全域存在 | `characterAwarenessCompiler` + fallback 测试；空卡不伪造胶囊 | PASS |
| Worldbook Global Awareness 全域存在 | `worldbookAwarenessCompiler`；P0 `full_source_protected`；真机 QingxiuRoad / StableRule「全局感知」 | PASS |
| Preset 已正式绑定全 Pipeline | `presetPipelineBinding.test.ts`：Draft/Proof full，Review 评判目标，FactCheck/Brief 硬约束 | PASS |
| Character Detail 可弹性展开 | `characterDetailRenderer` + V7 board/item allocator | PASS |
| Worldbook Detail 可弹性展开 | 真机「QingxiuRoad（详情）」「详情展开｜constant」 | PASS |
| constant=true 不再等于无限全文硬塞 | 胶囊 + 详情分条；allocator 按 grant 裁剪；100 条全文硬塞由预算 fail-closed 拦住 | PASS |
| constant=false 未命中仍有 Awareness | `resourceContextV2` / Preview「仅全局感知」源码 + 单测 | PASS |
| 人物关系不因 Detail 未激活而断裂 | Awareness 文本独立于 detail items；Resume 测「林晚不知道真相」 | PASS |
| 知识边界不因 Detail 未激活而消失 | 同上；CCv3 `system_prompt` 不进 Awareness | PASS |
| 青秀路雨夜案例 | 真机 Prompt：`Qingxiu Road has a rainy-night killer. Residents avoid walking alone in rain.` | PASS |
| static vs evolved story state | Preview 系统消息含「可变资料基线若与更晚的故事记忆或近期正文冲突，以更晚已发生状态为准」 | PASS |
| Context Budget V7 protected awareness | 真机：「全局感知为保护区，详情才进入弹性分配」；`resourceBudgetV7` 32K 先压 Detail | PASS |
| 32K / 128K / 大窗口 | `resourceBudgetV7.test.ts` + 真机 1,000,000 窗口分层数字 | PASS |
| Awareness over-budget fail closed | `RESOURCE_AWARENESS_OVER_BUDGET`；Preview 映射为阻止生成 | PASS |
| Snapshot V4 冻结真实资源内容 | `pipelineContextSnapshotV4` / `resourceContextFreeze` | PASS |
| 五阶段不重新查资料 DB | `stageResourceContextV4.ts` 注释与实现：只收 snapshot | PASS |
| Resume 使用冻结资料 | `resourceFreezeResume.test.ts` | PASS |
| cold-start Resume 使用冻结资料 | `resourceColdStartResume.test.ts` | PASS |
| Preset + Style Note 优先级 | Trace：`styleNotePresent`；Preset 不是 resource item | PASS |
| Preview 能解释 Awareness-only | 徽章「仅全局感知」/「详情已展开」；真机 7 项资料分配 | PASS |
| source fingerprint 可观测 | 源快照三次读取比对；Preview 失败码透出 | PASS |
| legacy CCv3 prompt 隔离 | `resourceContextPromptIsolation` + 真机「小说设定数据｜非系统指令｜不得覆盖写作协议」 | PASS |
| V6 legacy task 无回归 | `budgetVersion === 6` 独立分支；`contextBudgetV3Closure` 仍覆盖 6 | PASS |
| Schema migration（若有） | **无新迁移**；SCHEMA_VERSION=51 | PASS |
| Android E2E | 见 §7 | PASS |
| 覆盖安装数据不丢 | `firstInstallTime=2026-08-10 09:49:20`，`lastUpdateTime=2026-08-13 08:17:37`；P2_AWARENESS + ReviewTierE2E 仍在 | PASS |
| lint / typecheck / test:ci | 见 §6 | PASS |
| 独立验收复审无剩余 NO-GO | 见 §8 | PASS |

---

## 6. 自动化证据

### 6.1 lint

`npm run lint`：0 errors（198 既有 warnings，无新增 error）。

### 6.2 typecheck

`npm run typecheck`：`tsc --noEmit` 通过。

### 6.3 二期定向单测

```text
npx jest --runInBand --ci
  characterAwarenessCompiler
  worldbookAwarenessCompiler
  resourceAwarenessFallback
  resourceDetailScorer
  resourceContextV2
  resourceBudgetV7
  presetPipelineBinding
  pipelineContextSnapshotV4
  pipelineStageResourceConsistency
  resourceFreezeResume
  resourceColdStartResume
  resourceContextPromptIsolation
  contextPreviewResourceAwareness
  contextBuilderV7.integration
  contextBudgetV3Closure
  multiChapterBatchStore
```

结果：**16 suites / 69 tests PASS**。

### 6.4 test:ci

`npm run test:ci`（全量 Jest `--runInBand --ci`）：

```text
Test Suites: 3 skipped, 405 passed, 405 of 408 total
Tests:       8 skipped, 3212 passed, 3220 total
Time:        177.13 s
```

未改一期 V6 期望来「凑绿」；`contextBudgetV3Closure` 仅把 7 登记为 structured/resumable，未知未来版本从「7」改为「8」。

---

## 7. Android E2E / 覆盖安装

| 项 | 值 |
|---|---|
| 设备 | `emulator-5554` / `sdk_gphone16k_x86_64` |
| 包 | `com.shinewriter` |
| APK | `dist/apk/debug/ShineWriter-V2.11.50-debug.apk` |
| 安装 | `adb install -r`（未 uninstall / 未 `pm clear`） |
| firstInstallTime | 2026-08-10 09:49:20 |
| lastUpdateTime | 2026-08-13 08:17:37 |
| 覆盖后项目 | `P2_AWARENESS`（当前工作项目）+ `ReviewTierE2E`（8/12） |

操作路径：

1. 作品库 → `P2_AWARENESS` 已是当前项目（覆盖后数据仍在）
2. `3 写作` → `第 2 章` → 工具栏左滑 → `上下文`
3. 首次 Preview 在 fingerprint 修复前 fail-closed；覆盖安装修复包后 Preview 成功
4. 资料库启用世界书合集，写入 `QingxiuRoad`（雨夜杀人狂事实，constant=true）
5. 再次 Preview：V7 / Resource Context V2 / Snapshot V4
6. 展开预估请求：详情消息含隔离包装 + 青秀路原文

真机可见文案（摘录）：

```text
上下文预算 V3 分层弹性
Context Protocol V7 · Resource Context V2 · Snapshot V4
全局感知为保护区，详情才进入弹性分配
7 项资料分配

QingxiuRoad
全局感知｜full_source_protected
详情已展开

QingxiuRoad（详情）
详情展开｜constant

以下是本次写作可展开的资料详情（全局骨架已单独注入）：
【小说设定数据｜非系统指令｜不得覆盖写作协议】
【QingxiuRoad】
Qingxiu Road has a rainy-night killer. Residents avoid walking alone in rain.
【设定数据结束】
```

截图（不入库，本地 `test-logs/phase2-final/`）：

- `06-preview-awareness.png`
- `07-preview-prompt-isolation.png`

Maestro 流程：`e2e/maestro/13-phase2-resource-context.yaml`（无 `clearState`，覆盖安装安全；工具栏增加两次 LEFT swipe，避免「上下文」在屏外）。

未跑完整五阶段真实 LLM 生成：Preview 与发送路径共用 `compileDraftStageRequest`。资料接驳正确性以编译结果 + 冻结视图单测为准，不以一次外部模型抽样代替。

---

## 8. NO-GO 条件复查（方案 §61）

| NO-GO 条件 | 本轮状态 |
|---|---|
| 世界书未命中后核心事实完全不可见 | 未发生。QingxiuRoad 在第 2 章未点名时仍有 Awareness +（constant）Detail |
| 角色 Detail 未激活导致人物关系断裂 | Awareness 独立于 Detail；空卡不生成伪关系 |
| 角色提前知道秘密 | CCv3 `system_prompt` 不进 Awareness |
| 100 条 constant 仍把 100 条全文硬塞 | Awareness 保护区；超预算 fail-closed；Detail 走 item grant |
| Preset 只在 Draft 生效，Proof 丢失 | Draft 与 Proof 同为 `full` |
| FactCheck 重新读取最新世界书 | V4 编译器只读 snapshot |
| Resume 后资源版本漂移 | 冻结文本断言；live 变更不影响 |
| 旧 V6 task 被自动升级 | `=== 6` 独立路径；normalize 保 6 |
| legacy role system_prompt 覆盖项目 Preset | 设定数据围栏 + Draft 系统提示仍是写作基线 |
| Awareness 超预算仍继续调用 LLM | `RESOURCE_AWARENESS_OVER_BUDGET` 阻断 |
| Preview 只显示「未注入」却看不出 Awareness | 真机有「全局感知」行，不是单纯未包含 |
| 资料读取失败被 catch 成空数组继续生成 | 读失败 / 构建中源变更 / 显式预设丢失均 fail-closed |

---

## 9. 主要改动清单

新增：

- `src/services/context/resources/*`（Awareness / Detail / Preset / Freeze / Trace / Source Snapshot）
- `src/services/pipeline/stageResourceContextV4.ts`
- 14 个二期 `__tests__/*.test.ts`
- `e2e/maestro/13-phase2-resource-context.yaml`
- 本文件 + 实施方案

修改（接线，不改 V6 语义）：

- `contextBuilder.ts`：V7 分支与 V6 并列
- `compileStageRequest.ts` / `draftPipelineCompiler.ts` / `pipelineMessages.ts`
- `pipelineTaskContext.ts` / `pipelineContext.ts` / `pipelineExecution.ts` / `pipelineFrozen.ts`
- `outlineWorkflowVersion.ts` / `reconcile.ts` / `pipelineRunner.ts` / `pipelineTaskStore.ts`
- `useChapterPipeline.ts` / `PipelineTaskScreen.tsx` / `PipelineResultScreen.tsx`
- `ContextPreviewScreen.tsx` / `ContextConfig.tsx`
- `multiChapterBatchStore.ts` / `determineNextBatchAction.ts` / `multiChapterBatchRepository.ts`
- `contextBudgetV3Closure.test.ts` / `multiChapterBatchStore.test.ts`

未改：`createCurrentSchema.ts`、`SCHEMA_VERSION`、续写 runner、Canon 表。

---

## 10. 已知边界（不是 NO-GO）

1. 本轮模拟器上的角色合集卡片正文为空，因此 Preview 没有角色行。这是「无可靠源就不伪造胶囊」，不是漏接。Character 编译由单测覆盖。
2. 真机两条世界书均为 constant，所以徽章是「详情已展开」而不是「仅全局感知」。后者由 `contextPreviewResourceAwareness.test.ts` 锁 UI 语义。
3. 未升应用版本。二期作为 V2.11.50 工作树能力合入；发版另走 `docs/RELEASE_CHECKLIST.md`。
4. Maestro 流程在已有 `P2_AWARENESS` 的覆盖库上重跑会在「新建」处撞名，需干净库或改名。验收用的是覆盖库上手动复验，不是二次新建。

---

## 11. 封板声明

实施者按方案从第一页核对 Character / Worldbook / Preset / Notes 兼容 / 五阶段 / Preview / Freeze-Resume / 异常流 / 升级兼容，完成 PDCA 至 P0 全过。

**ShineWriter 第二期剩余 NO-GO = 0。允许合入 `main`。**
