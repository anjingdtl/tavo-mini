# ShineWriter 个人小说工作台优化改造设计

> 日期：2026-06-13
> 状态：已确认，待实施
> 目标版本：V1.4.x - V1.6.x

## 1. 背景

ShineWriter 已经具备项目、章节、自由写作、资料库、上下文构建、多阶段 AI
管线、密钥安全存储、数据库迁移、升级备份和多格式导出能力。当前短板不在于
“能否生成”，而在于个人长期创作最需要的三个保障：

1. 写下的内容不会因为返回、切后台或异常而丢失。
2. AI 覆盖、清空、批量生成等高风险操作可以预览、撤销和恢复。
3. 用户能理解 AI 使用了什么上下文、消耗了多少资源、失败后如何继续。

本改造以 Android-only、单用户、本地优先为约束，不引入账号、云同步、协作、
服务端任务队列或 iOS 支持。

## 2. 成功标准

### 2.1 数据安全

- 编辑器返回、切换项目、进入后台前，最后一次输入必须完成保存或明确提示失败。
- 章节正文与自由写作文档的高风险变更必须产生可恢复快照。
- 手动备份可创建、验证、查看和恢复；失败恢复不得破坏现有数据库。
- 项目 JSON 能够完成导出后的重新导入。

### 2.2 AI 可控性

- 生成前可查看实际上下文来源、命中原因和 token 预算。
- 生成结果默认进入预览，不直接覆盖已有正文。
- 中断的管线可从最后一个成功阶段继续，不重复已成功阶段。
- 批量生成逐章保留结果与错误，允许重试单章。

### 2.3 长篇可用性

- 可以搜索项目内章节、正文、概要、笔记和世界书。
- 可以调整章节顺序并保持位置连续。
- 故事概览可显示字数、状态、摘要覆盖和情节线进展。
- 可以查看按时间、场景和模型聚合的 LLM 用量与失败率。

### 2.4 工程质量

- 每个阶段结束时 `npm test -- --runInBand` 全部通过。
- `npm run lint` 无 error。
- 每个阶段至少构建一次 `npm run apk:debug`，产物只写入
  `dist/apk/debug/`。
- README、脚本和仓库结构与 Android-only 定位一致。

## 3. 实施策略

采用三阶段渐进交付，而不是一次性重写：

| 阶段 | 主题 | 可独立交付结果 |
|---|---|---|
| Phase 1 / V1.4 | 数据安全与可恢复 | 防丢保存、版本历史、手动备份恢复、项目导入、测试门禁 |
| Phase 2 / V1.5 | AI 可解释与可续跑 | 上下文预览、生成草稿、差异采纳、管线断点续跑 |
| Phase 3 / V1.6 | 长篇效率与工程治理 | 搜索、排序、故事统计、用量统计、专注模式、Android-only 清理 |

每个阶段使用独立 schema migration。Phase 1 将 schema 从 5 升至 6，
Phase 2 从 6 升至 7，Phase 3 从 7 升至 8。

## 4. 总体架构

### 4.1 新增服务边界

| 模块 | 职责 |
|---|---|
| `utils/debounce.ts` | 支持 `flush()` 的异步防抖，不负责 UI |
| `services/revisionService.ts` | 创建、查询、恢复和清理正文快照 |
| `services/backupService.ts` | 备份清单、校验、事务恢复和保留策略 |
| `services/projectImport.ts` | 校验并导入 `.shinewriter.json` |
| `services/contextInspector.ts` | 将上下文构建结果转换为可展示的来源清单 |
| `services/generationDraftService.ts` | 保存生成结果及采纳状态 |
| `services/pipelineResume.ts` | 计算可恢复阶段并续跑任务 |
| `services/searchService.ts` | 项目内统一搜索 |
| `services/analyticsService.ts` | 故事与 LLM 用量聚合 |

`database.ts` 继续作为唯一 SQL 入口。上述服务只能调用 `database.ts` 暴露的
CRUD，不直接执行 SQL，备份迁移代码除外。

### 4.2 数据流

```text
编辑器输入
  -> 本地 state
  -> async debounce
  -> database CRUD
  -> 保存状态
  -> 高风险动作前 revision snapshot

AI 生成
  -> buildContextDetailed()
  -> ContextBuildResult + ContextTrace
  -> 用户确认
  -> pipeline/generation call
  -> generation_drafts
  -> 预览/对比
  -> 追加、替换或放弃
  -> 采纳前 revision snapshot
```

## 5. Phase 1：数据安全与可恢复

### 5.1 可 flush 的自动保存

`debounce()` 改为异步控制器：

```ts
export interface DebouncedAsync<TArgs extends unknown[]> {
  call: (...args: TArgs) => void;
  flush: () => Promise<void>;
  cancel: () => void;
  pending: () => boolean;
}
```

行为要求：

- `call()` 只保留最新参数。
- `flush()` 立即执行待保存内容，并等待保存完成。
- 多次 `flush()` 共享同一个执行 Promise，不重复写入。
- 保存失败向调用方抛出，不把 UI 错误吞掉。
- `ChapterEditor` 和 `FreeformEditor` 在返回、卸载、项目变化和 App
  进入后台时调用 `flush()`。
- 返回动作先保存再导航；保存失败时留在当前页并提供“重试/仍然退出”。
- 状态统一为 `已保存`、`保存中`、`保存失败`，不再仅靠字符串散落维护。

### 5.2 正文版本历史

新增表 `content_revisions`：

```sql
CREATE TABLE content_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  source_ref TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX idx_content_revisions_target
  ON content_revisions(target_type, target_id, created_at DESC);
```

`target_type` 仅允许 `chapter`、`freeform`。`source` 仅允许：

- `manual_checkpoint`
- `before_clear`
- `before_ai_replace`
- `before_pipeline_accept`
- `before_restore`
- `before_batch_replace`
- `before_import_replace`

保留策略：

- 每个目标最多自动保留 50 条。
- `manual_checkpoint` 不参与自动清理，最多保留 20 条。
- 相邻快照内容完全一致时不重复创建。

新增 `RevisionHistoryScreen`，支持查看时间、来源、字数、全文预览和恢复。
恢复本身先创建 `before_restore` 快照，形成可逆链。

### 5.3 备份中心

设置页新增“数据与备份”入口，进入 `BackupCenterScreen`。

备份文件升级为格式版本 2：

```json
{
  "format": "shinewriter-backup",
  "format_version": 2,
  "meta": {
    "app_version": "1.4.0",
    "schema_version": 6,
    "created_at": "2026-06-13T12:00:00.000Z",
    "table_count": 17,
    "row_count": 123,
    "checksum": "sha256-or-deterministic-hash"
  },
  "tables": {}
}
```

功能：

- 手动创建备份。
- 展示备份时间、版本、大小和校验状态。
- 删除单个备份。
- 恢复前展示元数据并二次确认。
- 恢复前先创建 `pre_restore` 安全备份。
- 校验 JSON 结构、格式版本、表白名单和 checksum。
- 恢复在单个 SQLite transaction 中执行；任何失败整体回滚。
- 不恢复 `llm_config.api_key` 明文字段，API Key 仍以 Keystore 当前值为准。

自动备份继续保留最近 3 个；用户手动备份保留最近 10 个。两类文件通过
`meta.kind` 区分。

### 5.4 项目 JSON 导入

导出规范统一为 `shinewriter-project-v2`，保留读取 v1 的兼容能力。

导入流程：

1. 文档选择器选取 JSON。
2. 解析并校验 `spec`、项目模式和资源数组。
3. 展示项目名、章节数、资料数和来源版本。
4. 只支持“导入为新项目”，不覆盖现有项目。
5. 在一个 transaction 中创建项目、章节、片段、情节线和资源。
6. ID 全部重新映射，修复章节-情节线、资料启用关系。
7. API Key、流水线任务、用量日志不属于项目包，不导入。

### 5.5 Phase 1 验收

- 输入后立即返回，重新打开内容仍存在。
- 强制让保存失败，页面显示失败且不会静默退出。
- AI 替换、清空、恢复和批量覆盖均能在历史中找到前一版。
- 无效备份无法执行删除式恢复。
- 模拟恢复中途失败，原数据库保持不变。
- 项目导出后导入，新项目正文和资源数量一致。

## 6. Phase 2：AI 可解释与可续跑

### 6.1 上下文追踪模型

扩展 `BuildContextResult`：

```ts
export type ContextSourceKind =
  | 'preset'
  | 'chapter'
  | 'memory'
  | 'character'
  | 'note'
  | 'worldbook'
  | 'instruction';

export interface ContextTraceItem {
  kind: ContextSourceKind;
  sourceId: number | null;
  title: string;
  reason: string;
  estimatedTokens: number;
  included: boolean;
  clipped: boolean;
  preview: string;
}

export interface BuildContextResult {
  messages: ChatMessage[];
  chapters: Chapter[];
  trace: ContextTraceItem[];
  estimatedInputTokens: number;
}
```

世界书 `reason` 必须说明“常驻”“主关键词命中”“主+次关键词命中”或
“递归命中”。预算不足而未注入的候选项也进入 trace，`included=false`。

新增 `ContextPreviewScreen`：

- 按类别汇总 token。
- 展示实际注入和被预算裁剪的来源。
- 可展开查看不超过 500 字的预览。
- 入口位于章节生成、自由续写、流水线和批量生成确认步骤。
- 用户可选择“本次直接生成”；不在预览页临时修改长期配置。

### 6.2 生成草稿与采纳策略

新增表 `generation_drafts`：

```sql
CREATE TABLE generation_drafts (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  base_content TEXT NOT NULL DEFAULT '',
  generated_text TEXT NOT NULL,
  context_trace TEXT NOT NULL DEFAULT '[]',
  usage_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

`mode` 为 `continue`、`replace`、`pipeline`、`batch`。`status` 为
`pending`、`accepted`、`rejected`。

新增 `GenerationPreviewScreen`：

- 显示原文和生成文，可切换“原文/生成/并排”。
- 章节支持“替换正文”“追加到正文”“放弃”。
- 自由写作支持“追加”“替换”“放弃”。
- 采纳前创建 revision。
- 预览页关闭后 pending 草稿仍保留，可从任务中心重新进入。
- 第一版不实现字符级富文本 diff，使用段落级变更摘要，避免引入大型依赖。

### 6.3 管线断点续跑

schema 7 为 `pipeline_tasks` 增加：

```sql
ALTER TABLE pipeline_tasks ADD COLUMN project_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pipeline_tasks ADD COLUMN pipeline_mode TEXT NOT NULL DEFAULT 'twoStage';
ALTER TABLE pipeline_tasks ADD COLUMN input_snapshot TEXT NOT NULL DEFAULT '{}';
ALTER TABLE pipeline_tasks ADD COLUMN context_trace TEXT NOT NULL DEFAULT '[]';
ALTER TABLE pipeline_tasks ADD COLUMN resume_from TEXT;
ALTER TABLE pipeline_tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1;
```

`input_snapshot` 保存启动时的章节标题、概要、正文、配置、预设解析结果和构建好的
messages。API Key 不进入快照。

恢复规则：

- `draft` 成功后中断：从当前模式需要的 review/factCheck/proof 继续。
- review 与 factCheck 其中一个成功：只补失败或缺失阶段，再进入 proof。
- proof 成功但任务未完成：直接使用 proof 文本完成。
- 用户修改目标正文不影响旧任务恢复，因为恢复使用启动快照。
- 恢复前明确提示这是基于旧快照；用户也可以放弃并新建任务。
- 每次恢复 `attempt_count + 1`，失败历史保留在 stage result 中。

App 回到前台时不再只弹警告，而是把异常退出时的运行任务标记为
`interrupted`。`PipelineTaskStatus` 新增 `interrupted`，任务中心提供“继续”和
“放弃”。

### 6.4 批量生成

- 批量生成不再自动覆盖章节。
- 每章生成一个 pending draft。
- 完成页显示成功、失败、待采纳数量。
- 支持“全部采纳”“逐章查看”“仅重试失败项”。
- “全部采纳”逐章创建 revision；单章失败不回滚其他已采纳章节。

### 6.5 Phase 2 验收

- 同一章节在预览页显示的总 token 与发送消息估算一致。
- 世界书命中原因可解释，预算裁剪可见。
- 所有正文生成默认不直接覆盖已有内容。
- 在 draft、review、factCheck 后分别模拟中断，恢复时不重复成功阶段。
- 重启 App 后 pending 草稿和 interrupted 任务仍可访问。

## 7. Phase 3：长篇效率与工程治理

### 7.1 项目内搜索

新增 `ProjectSearchScreen`，搜索范围：

- 章节标题、概要、正文
- 笔记标题和正文
- 世界书关键词、备注和正文
- 角色名称及标准角色字段

搜索采用 SQLite `LIKE`，首版不引入 FTS。要求：

- 输入 250ms 防抖，最少 2 个字符。
- 每类最多返回 30 条。
- 结果显示来源、标题和命中位置附近摘要。
- 点击结果进入相应编辑页；无法直接定位字段的结果至少打开目标实体。

### 7.2 章节排序与状态管理

- 新增 `reorderChapters(projectId, orderedIds)`，在 transaction 中重写 position。
- 首版采用“上移/下移”按钮，不引入拖拽原生依赖。
- 章节列表增加状态筛选：全部、计划、草稿、修订、定稿。
- 删除章节后自动压缩 position。

### 7.3 故事概览

故事概览新增：

- 总章节数、总字数、已定稿章节数、摘要覆盖率。
- 每章字数和状态。
- 情节线关联章节范围及尚未关联的情节线。
- 缺少概要、缺少记忆摘要、正文为空的质量提示。

不新增图表依赖，使用卡片、进度条和列表。

### 7.4 LLM 用量统计

schema 8 扩展 `llm_usage_logs`：

```sql
ALTER TABLE llm_usage_logs ADD COLUMN project_id INTEGER;
ALTER TABLE llm_usage_logs ADD COLUMN model_name TEXT NOT NULL DEFAULT '';
ALTER TABLE llm_usage_logs ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
```

`callLLMResult()` 和 `callLLMStream()` 记录项目、模型和耗时。新增
`UsageStatsScreen`：

- 今日、近 7 天、近 30 天总 token。
- 输入/输出 token。
- 成功率和失败次数。
- 按场景和模型分组。
- 不计算货币费用，因为兼容模型价格无法可靠获知。

### 7.5 专注写作与可访问性

专注模式：

- 隐藏常规工具区，只保留返回、保存状态、字数和 AI 入口。
- 字号支持小/中/大，保存在 settings。
- Android 保持屏幕常亮使用原生 `FLAG_KEEP_SCREEN_ON` 小模块；若不实现原生模块，
  则该项从 V1.6 首版移除，不引入第三方依赖。

可访问性：

- 重要操作触控高度至少 44dp，主操作优先 48dp。
- `SegmentedControl` 增加 `accessibilityRole="tab"`、选中状态和 label。
- 图标按钮必须有中文 accessibilityLabel。
- 危险操作按钮使用明确文本，不只使用颜色区分。

### 7.6 Android-only 工程治理

- 删除 `package.json` 的 `ios` 脚本。
- 删除已跟踪的 `ios/` 目录。
- README 重写为 ShineWriter Android 开发、测试、构建、签名和产物说明。
- 修复版本检测测试，不再硬编码当前版本。
- 清理现有 lint warning。
- 增加 release checklist，要求测试、lint、APK 产物和版本信息验证。

### 7.7 Phase 3 验收

- 100 章项目搜索结果在可接受时间内返回，不阻塞连续输入。
- 排序后重启 App，章节顺序保持正确且 position 连续。
- 故事概览统计与数据库内容一致。
- 用量统计可按时间、模型和场景聚合。
- TalkBack 能识别主要导航、按钮、选中状态和危险操作。
- 仓库不再包含 iOS 工程或 iOS 命令。

## 8. 数据库迁移

| 迁移 | breaking | 内容 |
|---|---:|---|
| v5 -> v6 | false | 新增 `content_revisions` 和索引 |
| v6 -> v7 | false | 新增 `generation_drafts`；扩展 `pipeline_tasks` |
| v7 -> v8 | false | 扩展 `llm_usage_logs` |

所有新增列必须有默认值，保证旧数据直接升级。迁移前仍使用现有备份机制，但手动
备份中心完成后，自动升级备份也切换到格式 v2。

## 9. 错误处理

- 所有用户可见错误使用中文。
- 保存失败不得仅 `console.warn`；编辑器必须保留未保存 state。
- 备份校验错误、恢复错误和导入错误必须区分。
- 管线恢复失败只更新当前 attempt，不删除已有阶段结果。
- 统计与搜索失败不得影响编辑和生成主链路。
- 数据库 mutation 服务返回错误，不在服务层弹 Alert；由页面决定 Toast/Alert。

## 10. 测试策略

### 单元测试

- async debounce 的 call/flush/cancel/并发行为。
- revision 去重、保留策略、恢复前快照。
- 备份格式校验、checksum、事务回滚。
- 项目导入 ID 映射和失败回滚。
- context trace token、裁剪和世界书命中原因。
- pipeline resume 阶段计算。
- 搜索结果归类和摘要。
- 故事及用量聚合。

### 组件测试

- 编辑器返回前 flush，失败时阻止退出。
- 历史页恢复确认。
- 上下文预览分类与生成入口。
- 生成预览的追加、替换、放弃。
- interrupted 任务继续和放弃。
- 设置页备份、统计入口。

### 集成验证

- 从 schema 5 升级到 8，原项目可读写。
- 导出项目后重新导入。
- 创建备份、修改数据、恢复备份。
- 运行管线、中断、重启、继续、采纳。
- `npm test -- --runInBand`
- `npm run lint`
- `npm run apk:debug`

## 11. 文件规划

### 新增

- `src/types/revision.ts`
- `src/types/contextTrace.ts`
- `src/types/generationDraft.ts`
- `src/services/revisionService.ts`
- `src/services/projectImport.ts`
- `src/services/contextInspector.ts`
- `src/services/generationDraftService.ts`
- `src/services/pipelineResume.ts`
- `src/services/searchService.ts`
- `src/services/analyticsService.ts`
- `src/screens/RevisionHistoryScreen.tsx`
- `src/screens/BackupCenterScreen.tsx`
- `src/screens/ContextPreviewScreen.tsx`
- `src/screens/GenerationPreviewScreen.tsx`
- `src/screens/ProjectSearchScreen.tsx`
- `src/screens/UsageStatsScreen.tsx`
- `src/services/migrations/v5-to-v6.ts`
- `src/services/migrations/v6-to-v7.ts`
- `src/services/migrations/v7-to-v8.ts`
- 对应 Jest 测试文件

### 重点修改

- `src/services/database.ts`
- `src/services/backupService.ts`
- `src/services/contextBuilder.ts`
- `src/services/llm.ts`
- `src/services/pipelineRunner.ts`
- `src/services/batchChapterPipeline.ts`
- `src/store/pipelineTaskStore.ts`
- `src/screens/ChapterEditor.tsx`
- `src/screens/FreeformEditor.tsx`
- `src/screens/OutlineEditor.tsx`
- `src/screens/PipelineTaskScreen.tsx`
- `src/screens/PipelineResultScreen.tsx`
- `src/screens/StoryOverview.tsx`
- `src/screens/SettingsScreen.tsx`
- `src/navigation/TabNavigator.tsx`
- `src/components/ui.tsx`
- `src/utils/debounce.ts`
- `README.md`
- `package.json`

## 12. 明确不包含

- 云同步、登录、多人协作。
- iOS 支持。
- 后台常驻生成或 Android WorkManager。
- 向量数据库、embedding 服务或全文 FTS。
- 字符级富文本 diff。
- 模型价格维护和费用结算。
- 自动发布到应用商店。

## 13. 发布与回滚

- 每个 Phase 单独提高 minor 版本并生成 release APK。
- 每次 schema 升级均为非 breaking，可回滚代码但不主动降级数据库。
- 发布前保留上一版本 APK 和一份真实设备备份。
- 若 Phase 2 管线恢复出现严重问题，可关闭“继续任务”入口，旧任务仍可查看和放弃。
- 若 Phase 3 搜索或统计异常，不影响写作与生成主路径。
