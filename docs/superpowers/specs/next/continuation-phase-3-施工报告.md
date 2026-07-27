# 原著续写 Phase 3 施工报告

> 版本：V2.8.0 → **V2.9.0**；Schema：20 → **21**  
> 施工日期：2026-07-27  
> 对应 Spec：`docs/superpowers/specs/next/continuation-phase-3-ai-continuation.spec.md`

## 1. Phase 1 / Phase 2 DoD 与交接契约

施工前复跑交接测试（全部通过）：

| 契约 | 结果 |
| --- | --- |
| bounded `continuationSourceReader` snapshot 漂移 / 边界裁剪 / future 排除 | ✅ |
| `CanonQueryService` active + revision 校验 | ✅ |
| future leakage 阻断（Canon 证据） | ✅ |
| Schema 19→20 迁移 | ✅ |

**未绕过**：Phase 3 Context 仅经 SourceReader 读原著；仅经 `CanonQueryService` 读 Canon；strict 模式 capability / pending proposal / dirty memory 可阻断。

## 2. Schema / 迁移 / 备份

| 项 | 施工前 | 施工后 |
| --- | --- | --- |
| `SCHEMA_VERSION` | 20 | **21** |
| 迁移 | …→v19→v20 | + `v20-to-v21.ts` |
| fresh schema | Schema 20 | + Phase 3 全表 |
| 迁移矩阵 | 3..19→20 | **3..20→21** |
| 备份 | format v3 | format v3；Phase 3 表全部 `backup:true` |

新增表：

- `continuation_generation_settings`
- `continuation_generation_runs`（`ct_%` id）
- `continuation_generation_artifacts`
- `continuation_plans`
- `continuation_check_results`
- `continuation_state_proposals` / `continuation_state_events`
- `continuation_entities` / `continuation_entity_aliases`
- `continuation_state_sync_outbox`
- `continuation_style_profiles`

## 3. 核心实现（改动文件）

### 3.1 数据与迁移

- `src/services/migrations/v20-to-v21.ts`（新）
- `src/services/migrations/index.ts` — `SCHEMA_VERSION=21`
- `src/data/schema/createCurrentSchema.ts` — 镜像 Schema 21
- `src/services/database/schemaManifest.ts` — backup + restoreOrder 410–510

### 3.2 Generation 服务（`src/services/continuation/generation/`）

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 独立 stage/run 类型；与 freeform `PipelineStageName` 隔离 |
| `generationRepository.ts` | settings/runs/artifacts/plans/checks/proposals/events/outbox |
| `continuationContextBuilder.ts` | 冻结 Context snapshot + trace；**无** SM LLM |
| `continuationPromptCompiler.ts` | Planner/Writer/Checker/Repair/Extraction 分阶段 prompt |
| `continuationChecker.ts` | 确定性检查 + JSON 解析 + 证据/UTF-16 绑定 |
| `continuationRepairService.ts` | 局部确定性修复 + 轮次上限 |
| `continuationGenerationRunner.ts` | 独立 runner；采纳/定稿/取消/恢复 |
| `continuationStateService.ts` | Effective State 融合；proposal 确认；失效 |
| `continuationStateOutboxWorker.ts` | extract/apply/rebuild；冷启动 interrupted |
| `continuationStyleService.ts` | 边界内文风统计（无大段原文复制） |
| `continuationContextTrace.ts` | 结果页摘要 |
| `index.ts` | 公开导出 |

### 3.3 UI / 导航 / 启动

- `ContinuationResultScreen.tsx` — 规划 / 一致性 / 采纳草稿 / 放弃
- `TabNavigator.tsx` — `ContinuationResult` 路由
- `navigationRef.ts` — `ct_` 深链优先
- `useChapterPipeline.ts` — continuation 模式走独立 runner
- `ChapterToolbar.tsx` — continuation 显示「AI 续写」
- `ChapterEditorScreen.tsx` — 定稿插入 extract outbox（无事务内 LLM）
- `main/index.tsx` — 冷启动 normalize continuation run/outbox

### 3.4 测试与 E2E

- `__tests__/migrations-v20-v21.test.ts`
- `__tests__/continuationPhase3Core.test.ts`
- `__tests__/continuationPhase3Pipeline.test.ts`（含 **连续 30 章** 验收逻辑）
- `__tests__/continuationPhase3Repository.test.ts`
- `__tests__/migrationMatrix.test.ts` 扩到 3..20→21
- `e2e/maestro/09-continuation-generate-and-adopt.yaml`
- `e2e/maestro/10-continuation-check-and-repair.yaml`
- `e2e/maestro/11-continuation-state-rebuild.yaml`

### 3.5 文档 / 版本

- `package.json` / `package-lock.json` → **2.9.0**
- `src/constants/version.json` → V2.9.0 / 2090000
- `README.md` / `CHANGELOG.md` / `Agents.md`

## 4. 关键不变量落实

| 不变量 | 实现 |
| --- | --- |
| 不改 freeform stage 语义 | 新 `ContinuationStageName`；旧 pipeline 未改 stage 枚举 |
| 采纳零回灌 | `adoptArtifactAsDraft` 只写章节草稿 + run completed；无 proposal/event/SM LLM |
| 定稿后异步提取 | `finalizeContinuationChapter` 本地事务 + `extract_state` outbox |
| 事务内无 LLM | outbox worker 在事务外调用；confirm 只写 event/dirty/outbox |
| SourceReader / Canon 门禁 | Context Builder 仅用二者；strict 缺 capability 阻断 |
| 冻结 snapshot | run 创建时写入 `context_snapshot_json`；阶段从快照编译 |
| 模型路由 | `settings_snapshot_json.resolvedModelConfigIds` 按阶段冻结 |

## 5. 模型路由 / Token / 性能

| 阶段 | 默认路由 | 说明 |
| --- | --- | --- |
| Planner | `planner_llm_config_id` 或 active | JSON plan；失败回退默认 plan |
| Writer | `writer_llm_config_id` 或 active | 正文 artifact + hash |
| Checker | 可关；否则 checker config | 确定性检查始终跑；LLM 可选 |
| Repair | repair config | 默认 max 1 轮；确定性优先修 future/复活 |
| State Extraction | state_extraction config | 定稿后 outbox；单独计费场景名 |

性能设计：

- Context **禁止**为选上下文再打远程 LLM。
- recent 章节窗口固定（最近 5 章 excerpt）；30 章验收断言 token 不随章数无界增长。
- 硬规则优先；超预算对 hard 显式阻断。

## 6. 测试结果

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| lint + typecheck + version + Jest | `npm run verify` | ✅ **1283 passed**（3 skipped） |
| coverage | `npm run test:coverage` | ✅ Statements **69%** / Branches **57%** / Functions **75.3%** / Lines **70.8%** |
| Phase1/2 交接 | SourceReader / CanonQuery / future leakage | ✅ |
| 迁移 | 3..20→21 + v20→v21 | ✅ |
| 30 章验收 | `continuationPhase3Pipeline` | ✅ 无 future 泄漏 + 有界 Context |
| Android Debug APK | `npm run apk:debug` | ✅ BUILD SUCCESSFUL |

## 7. APK 路径

```
dist/apk/debug/ShineWriter-V2.9.0-debug.apk   (54.28 MB)
```

## 8. 剩余风险

1. **真机 LLM 质量**：CI/单测以确定性检查 + fake inject 为主；在线 Planner/Writer/Checker 质量依赖模型与 prompt，需设备矩阵补一轮。
2. **Effective State 与章节 revision 交叉校验**：事件在失效路径上按 position 处理；章节 hash 不一致时依赖调用方触发 `onChapterContentChanged`，完整 UI 全路径需真机回归。
3. **Story Memory rebuild**：V2.9.1 的生产 worker 在定稿/确认后的 outbox 实际调用完整重建；LLM 调用仍严格位于事务外。未配置 API 时 outbox 记录可重试失败并给出明确配置错误，不会伪造成功。
4. **E2E Maestro 09–11**：当前 Windows 环境未安装 Maestro 二进制，已以 ADB UI-tree 等价流程完成模拟器验收：导入、边界、Canon 分析激活、定稿和 outbox；在线生成的模型语义仍需要已配置服务的设备矩阵。
5. **Style profile**：统计提取已实现；用户确认 UI 仍可后续打磨。
6. **局部 UI 文案**：continuation 工具栏为「AI 续写」；outline/freeform 仍为「AI 重新生成」。

## 9. 产品闭环（三阶段完成后）

```text
创建原著续写项目
→ 导入 TXT 原著
→ 解析和设置续写边界
→ 分析五类 Canon
→ 用户确认关键设定
→ Canon 驱动章节规划
→ 生成续写正文
→ 连续性检查与局部修复
→ 用户采纳为章节草稿
→ 编辑并定稿
→ 提取并确认续写状态
→ 异步更新 Story Memory
→ 下一章继续
```
