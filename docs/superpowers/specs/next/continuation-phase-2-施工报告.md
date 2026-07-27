# 原著续写 Phase 2 施工报告

> 版本：V2.7.0 → **V2.8.0**；Schema：19 → **20**  
> 施工日期：2026-07-27  
> 对应 Spec：`docs/superpowers/specs/next/continuation-phase-2-canon-analysis.spec.md`

## 1. Phase 1 DoD / 交接契约审核

施工前复跑 Phase 1 交接测试（全部通过）：

| 契约 | 结果 |
| --- | --- |
| `continuationSourceReader` snapshot 漂移 → `continuation_source_snapshot_outdated` | ✅ |
| 边界裁剪 / 末章中间边界物理截断 | ✅ |
| future source 默认不可由领域 Reader 返回 | ✅ |
| Schema 19 迁移与 branded types | ✅ |
| 边界变更使 `analysis_status=outdated` | ✅ |

Phase 1 已知收尾项（导入向导 UI 全流程、写作页 AI 门控、`custom_offset` 滑块）**不阻断** Phase 2 硬依赖（active source / UTF-16 / chunks / boundary / format v3 / SourceReader）。本阶段未实现 Phase 3。

## 2. Schema / 迁移

| 项 | 施工前 | 施工后 |
| --- | --- | --- |
| `SCHEMA_VERSION` | 19 | **20** |
| 迁移文件 | …→v18→v19 | + `v19-to-v20.ts` |
| fresh schema | Schema 19 续写表 | + Canon 全表 + settings 含 `active_canon_snapshot_id` |
| 迁移矩阵 | 3..18→19 | **3..19→20** |
| 备份 | format v3 | format v3；Canon/run/batch/evidence 均为 `backup:true` |

新增表（节选）：

- `continuation_canon_snapshots`（`idx_canon_snapshots_one_ready` partial unique）
- `continuation_analysis_runs` / `continuation_analysis_batches`
- `canon_evidence` / `canon_evidence_links`
- `canon_world_rules` / `canon_characters` / `canon_character_aliases`
- `canon_character_state_snapshots` / `canon_relationships`
- `canon_plot_threads` / `canon_plot_thread_characters`
- `canon_character_experiences` / `canon_character_knowledge`
- `canon_timeline_events`

`continuation_settings` 增加 `active_canon_snapshot_id`（Phase 3 唯一 Canon 入口指针）。

失效路径（边界更新 / `markAnalysisOutdated`）在同一事务：

1. 将 staging/awaiting_review/ready snapshot → `outdated`
2. 活跃 run → `outdated`
3. 清空 `active_canon_snapshot_id`，`analysis_status='outdated'`

## 3. 核心能力

### 3.1 领域服务（`src/services/continuation/canon/`）

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 公共类型 / Phase 3 handoff 形状 |
| `canonJsonValidators.ts` | 版本化提取 JSON Schema 校验 |
| `deterministicExtractor.ts` | CI/离线确定性提取（标记 + 对话启发式） |
| `canonRepository.ts` | 表级持久化（**不对 UI/Phase 3 开放读路径**） |
| `canonEvidenceService.ts` | 证据写入、boundary 校验、orphan/未来证据 |
| `canonAnalysisService.ts` | run/batch 状态机、materialize、activate 事务 |
| `canonEntityResolver.ts` | 别名规范化 / 最长匹配 |
| `canonReviewService.ts` | 确认/锁定/忽略/revision |
| `canonQueryService.ts` | **Phase 3 唯一查询入口** |
| `canonInvalidationService.ts` | 项目级失效 / ready 探测 |

### 3.2 不变量

- future leakage：证据 `char_end > boundaryExclusive` 拒绝写入；激活前 `countFutureEvidence === 0`
- 未激活 snapshot（staging/awaiting_review/failed/outdated）不可被 QueryService 读取
- Query 必须 `snapshotId === active_canon_snapshot_id` 且 `revision` 一致，否则 `canon_snapshot_outdated`
- UI 通过 review list / QueryService / analysis overview 访问，不直接 SQL Canon 表
- Phase 3 不得传 `ContinuationChapterPosition` 作为 `atSourcePosition`（类型与文档约束）

### 3.3 模型能力

- 默认 `extractorMode: 'deterministic'`（可测、不依赖外网）
- 可选 LLM：`callLLM` + `responseFormat: 'json_object'`，失败回退确定性提取
- `probeModelCapability` 记录 `json_valid/schema_valid/context_sufficient`（内存缓存，不落探针正文）
- 所有 JSON 列经 validator；fence/截断/坏枚举有单测

## 4. UI

- 资料 > 续写 > **原著分析**（`CanonAnalysisOverviewScreen`）
- 五类列表：世界观 / 人物 / 关系 / 剧情 / 经历（确认·锁定·忽略·证据预览）
- 分析任务列表（继续/重试/取消/立即处理）
- 路由挂在 `ResourceStack`（`TabNavigator`）

## 5. 测试与性能结果

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| lint + typecheck + version + Jest | `npm run verify` | ✅ **1252 passed**（3 skipped） |
| coverage | `npm run test:coverage` | ✅ Statements **70.56%** / Branches **58.4%** / Functions **76.27%** / Lines **72.43%**（均过阈值） |
| 迁移矩阵 | `migrationMatrix.test.ts` | ✅ Schema 3..19 → 20 |
| future leakage | `canonFutureLeakage.test.ts` | ✅ 发布阻断项通过 |
| entity / JSON / evidence / query | 对应单测 | ✅ |
| Android Debug | `npm run apk:debug` | ✅ BUILD SUCCESSFUL |

新增/关键测试文件：

- `__tests__/migrations-v19-v20.test.ts`
- `__tests__/canonFutureLeakage.test.ts`（含 20 章边界 + 中段边界）
- `__tests__/canonJsonValidators.test.ts`
- `__tests__/canonEntityResolver.test.ts`
- `__tests__/canonEvidenceValidation.test.ts`
- `__tests__/canonQueryService.test.ts`
- `__tests__/canonAnalysisLifecycle.test.ts`
- `e2e/maestro/08-continuation-canon-analysis.yaml`（含人工 checkpoint）

性能说明：确定性 Standard 路径在单测环境为内存级毫秒～数十毫秒批次处理；真实 30 章在线 LLM 耗时依赖模型与网络，未作为 CI 硬依赖。峰值内存未在本机做专项 profiler，建议真机 30 章夹具再记一轮。

## 6. APK 路径

```
dist/apk/debug/ShineWriter-V2.8.0-debug.apk   (54.12 MB)
```

## 7. Phase 3 交接契约验证

公开形状（`types.ts` + `CanonQueryService`）：

```ts
interface CanonSnapshot {
  id; projectId; sourceId; sourceVersion; sourceSha256;
  parserVersion; normalizationVersion;
  boundaryPosition; boundaryCharOffsetExclusive;
  extractionVersion; revision; capabilities; coverage;
  status: 'ready' | 'outdated' | ...;
}

interface CanonContextBundle {
  snapshot; worldRules; characters; characterStates;
  relationships; experiences; knowledge; plotThreads;
  timelineEvents; evidenceRefs; estimatedTokens; omittedReasonCounts;
}
```

| 交接要求 | 状态 |
| --- | --- |
| Phase 3 只调 `CanonQueryService` | ✅ 文档 + index 导出约束 |
| active pointer 原子发布 | ✅ `activateSnapshot` 事务 |
| 非 ready / revision 漂移抛 `canon_snapshot_outdated` | ✅ 单测 |
| 不得使用 `ContinuationChapterPosition` 作为 `atSourcePosition` | ✅ 类型为 `SourceChapterPosition` |
| Quick capabilities 标记不完整 | ✅ `emptyCapabilities('quick')` + coverage incompleteReasons |
| timeline blocking 依赖 confirmed/locked（strict） | ✅ `getContextBundle` 过滤 |

## 8. 剩余风险

1. **LLM 提取质量**：真实长篇 Standard/Deep 依赖模型与 prompt；CI 走确定性夹具，真机在线验收仍需一轮。
2. **导入向导 UI**：仍为 Phase 1 收尾项；分析 UI 假设源已导入且边界已设。
3. **orphan evidence 与复杂 revision 合并**：激活前强制 orphan=0；人物合并/拆分 UI 未做完整交互，服务层具备基础 revision 与别名能力。
4. **角色卡/世界书显式导出**：Spec 允许映射字段；本阶段以治理+查询为主，批量导出 UI 可后续补。
5. **覆盖率**：新增大体积服务拉低全局覆盖率绝对值（仍过门禁）；后续可对 `canonAnalysisService`/`canonQueryService` 补集成测。
6. **Maestro 08**：自动化步骤含人工 checkpoint，完整 E2E 需设备上已有续写项目。

## 9. Definition of Done 自检

| 条目 | 状态 |
| --- | --- |
| 五类 Canon 可生成、审核、查询 | ✅ |
| snapshot 与 source/boundary 绑定 + active pointer 原子发布 | ✅ |
| future leakage 测试通过 | ✅ |
| Phase 3 无需直查 Canon 表 | ✅ `CanonQueryService` |
| 30 章夹具 future leakage + 提取覆盖 | ✅（确定性路径） |
| UI 可跳转证据预览 | ✅ |
| 分析失败不污染 active snapshot | ✅ staging/awaiting_review 直至 activate |
| 施工报告 | ✅ 本文件 |

**结论**：Phase 2 数据模型、分析状态机、证据系统、五类 Canon、审核治理与 Query Service 已落地并通过全部门禁；未提前实现 Phase 3 生成管线。
