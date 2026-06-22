# ShineWriter 升级改造进度记录

> 版本路径：V1.3.8 → V1.4.0 → V1.5.0 → V1.6.0 → V1.6.1 → V1.6.2
> 日期：2026-06-13 ~ 2026-06-14
> 设计文档：
> - `docs/superpowers/specs/2026-06-13-personal-novel-workbench-optimization-design.md`
> - `docs/superpowers/specs/2026-06-14-draft-crashfix-and-toolbar-relayout-design.md`
> 建设计划：
> - `docs/superpowers/plans/2026-06-13-personal-novel-workbench-optimization.md`
> - `docs/superpowers/plans/2026-06-14-draft-crashfix-and-toolbar-relayout.md`

---

## V1.6.1 / 闪退修复与工具栏重排

修复草稿预览页采纳/删除/清空按钮在异步流程中因 Alert 套嵌 + 组件卸载导致 setState 抛错而闪退的稳定性问题，并把章节编辑工具栏从一字排开重排为清晰的两行 4×4 布局，按钮 label 全部缩短到 ≤2 汉字。

- 草稿预览：`isMountedRef` 守卫所有 setState；`adoptingRef` 全局锁防止双击并发；Alert 回调扁平化，仅触发稳定 async `runAdopt / runDelete / runClear`；错误反馈从 Alert 改为 inline 文字 + 4 秒自动消失。
- 章节编辑：工具栏拆为两个 `toolbarRow`（4×4），移除 Button 的 `flex: 1` 强制均分，新增可选 `minWidth` prop。
- 测试：新增 3 个测试套件（`draftAdoptGuard` / `draftPreview` / `chapterEditorToolbar`），共 11 个用例。
- 总计：20 个测试套件 / 93 个测试用例全部通过，ESLint 0 error。

> 延后到 V1.6.2+ 的 backlog：
> - LLM 写作管线动态进度条
> - 流水线写作结束自动弹出结果
> - 备份中心备份列表展示

---

## V1.6.2 / 写作管线 UX 打磨

三个写作流体验改进：进度反馈、结果自动弹窗、备份布局修复。

- 进度条：新增 `PipelineProgress` 组件（ActivityIndicator + 阶段名 + 已用时长），`pipelineRunner.runChapterPipeline` 的 `onStageUpdate` 回调扩展为结构化 `StageInfo` 对象（向后兼容），ChapterEditor 在 generating 时渲染进度条。
- 结果弹窗：新增 `GenerationResultModal` 组件（Modal + PipelineResultScreen），流水线完成后不再 navigate 而是在 ChapterEditor 之上弹 Modal；PipelineResultScreen 增加可选 `taskId` / `onClose` / `onAdopted` props 支持非路由模式。
- 备份布局：`BackupCenterScreen` 的 createRow 加 elevation=2 / zIndex=2 / backgroundColor / borderBottom，修复与 FlatList 的视觉重叠。
- 测试：新增 3 个测试套件（`pipelineProgress` / `generationResultModal` / `backupCenterLayout`），共 7 个用例。
- 总计：23 个测试套件 / 100 个测试用例全部通过，ESLint 0 error。

> 设计文档：`docs/superpowers/specs/2026-06-14-v1.6.2-backlog-ux-polish-design.md`
> 建设计划：`docs/superpowers/plans/2026-06-14-v1.6.2-backlog-ux-polish.md`


---

## 改造目标

将 ShineWriter 从"能用"升级为"防丢、可恢复、可解释、适合长篇创作"的 Android 小说工作台，聚焦三大方向：

1. **数据安全** — 写下的内容不会丢失，高风险操作可撤销
2. **AI 可控性** — 生成结果可预览、可采纳、可续跑
3. **长篇效率** — 搜索、排序、统计、专注模式

---

## Phase 1 / V1.4.0：数据安全与可恢复

### Task 1: 建立基线并修复版本检测测试 ✅

- 将 `installTypeDetection.test.ts` 中硬编码版本号改为动态读取 `version.json`
- 将 `CharacterEditor.tsx` 的 `borderBottomWidth: 2` 内联样式移入 StyleSheet
- 全量测试和 lint 通过

### Task 2: 实现可 flush 的异步防抖 ✅

- 重写 `src/utils/debounce.ts`，从简单 debounce 升级为 `DebouncedAsync` 控制器
- 新增 `call()` / `flush()` / `cancel()` / `pending()` 四个方法
- `flush()` 立即执行待保存内容并等待完成，多次 flush 共享同一 Promise
- 新增 7 个单元测试覆盖并发、失败传播、pending 状态等场景

### Task 3: 新增 schema 6 与正文版本历史 ✅

- 新增 `content_revisions` 表，支持 chapter / freeform 两种目标类型
- 7 种快照来源：`manual_checkpoint`、`before_clear`、`before_ai_replace`、`before_pipeline_accept`、`before_restore`、`before_batch_replace`、`before_import_replace`
- `revisionService.ts` 实现去重（相邻内容一致不重复创建）和自动清理（每目标最多 50 条）
- 恢复前自动创建 `before_restore` 快照，形成可逆链
- 新增 `src/types/revision.ts` 类型定义
- 新增 `src/services/migrations/v5-to-v6.ts` 迁移脚本

### Task 4: 编辑器防丢保存与历史页面 ✅

- `ChapterEditor` 和 `FreeformEditor` 重构保存状态为 `SaveStatus`（saved / saving / failed）
- AppState 监听：进入后台/非活跃时自动 flush
- 组件卸载时 flush 而非 cancel，确保内容不丢失
- 新增 `flushAndClose()`：保存失败时阻止退出并提供重试选项
- 清空正文前创建 `before_clear` 快照
- 新增手动"保存版本"按钮，创建 `manual_checkpoint` 快照
- 新增 `RevisionHistoryScreen`：时间线展示、来源标签、字数、预览和恢复
- 导航注册 RevisionHistory 路由

### Task 5: 备份 v2 与备份中心 ✅

- 备份格式升级为 v2：新增 `format`、`format_version`、`meta.kind`、`meta.checksum`
- 区分 `CORE_TABLES`（验证必需）和 `ALL_TABLES`（完整导出），解决向后兼容
- 新增 `validateBackup()`：校验 JSON 结构、格式版本、表白名单和 checksum
- 新增 `listBackups()`：展示备份时间、版本、大小和校验状态
- 新增 `createManualBackup()` 和 `createPreRestoreBackup()`
- 恢复操作在单个 SQLite transaction 中执行，失败整体回滚
- 清理策略改为分类保留：3 auto / 10 manual / 3 pre_restore
- 新增 `BackupCenterScreen`：创建、查看、恢复和删除备份
- 设置页新增"数据与备份"入口

### Task 6: 项目包导入与 V1.4 验证 ✅

- 新增 `src/services/projectImport.ts`：解析、预览和导入项目包
- 导出规范升级为 `shinewriter-project-v2`，保留 v1 读取兼容
- 导入流程：文件选择 → 解析校验 → 预览确认 → 事务导入（ID 重映射）
- 项目列表页新增"导入"按钮和搜索功能
- 版本号更新为 1.4.0

---

## Phase 2 / V1.5.0：AI 可解释与可续跑

### Task 7: 上下文追踪模型 ✅

- 新增 `src/types/contextTrace.ts`：定义 7 种 `ContextSourceKind` 和 `ContextTraceItem`
- `contextBuilder.ts` 重构：`buildResourceContext` 返回 `{ text, traceItems }`
- 角色上下文、笔记上下文、世界书上下文均返回追踪信息
- 世界书追踪精确到命中原因：常驻 / 主关键词命中 / 主+次关键词命中 / 递归命中
- `BuildContextResult` 扩展 `trace` 和 `estimatedInputTokens` 字段

### Task 8: 上下文预览页面 ✅

- 新增 `ContextPreviewScreen`：按类别汇总 token，展示注入和裁剪来源
- 支持展开查看不超过 500 字的预览
- 可切换"来源清单"和"原始消息"两种视图
- 导航注册 ContextPreview 路由

### Task 9: schema 7 与生成草稿 ✅

- 新增 `generation_drafts` 表，支持 continue / replace / pipeline / batch 四种模式
- 新增 `src/types/draft.ts` 类型定义
- 新增 `src/services/draftService.ts`：`saveDraft` / `getDrafts` / `removeDraft` / `clearDrafts`
- 新增 `src/services/migrations/v6-to-v7.ts` 迁移脚本
- 备份表清单更新，包含 `generation_drafts`

### Task 10: 生成预览与批量采纳 ✅

- 新增 `DraftPreviewScreen`：展示生成草稿列表，支持采纳/删除/清空
- 采纳前自动创建 `before_pipeline_accept` 快照
- `pipelineRunner.ts` 重构：所有生成结果先保存为草稿，不再直接覆盖正文
- 新增 `saveDraftAndComplete` 辅助函数
- 导航注册 DraftPreview 路由

### Task 11: 管线断点续跑与 V1.5 验证 ✅

- `pipelineRunner.ts` 新增 `resumePipeline` 函数
- 恢复逻辑：检查 `completedStages`，跳过已成功阶段，从第一个缺失阶段继续
- 版本号更新为 1.5.0

---

## Phase 3 / V1.6.0：长篇效率与工程治理

### Task 12: 项目搜索与章节排序 ✅

- `ProjectListScreen` 新增搜索功能：搜索框 + 250ms 防抖 + 过滤项目列表
- `OutlineEditor` 新增章节排序：上移/下移按钮，`moveChapter` 函数

### Task 13: 故事概览统计 ✅

- `StoryOverview` 新增统计行：总章节数、总字数、有内容章节数、平均每章字数
- 每章显示字数

### Task 14: schema 8 与 LLM 用量统计 ✅

- `llm_usage_logs` 新增 `model_name` 列
- 新增索引 `(project_id, created_at)`
- 新增 `getLLMUsageStats` 和 `getLLMUsageSummary` 查询
- 新增 `UsageStatsScreen`：今日/7天/30天筛选、输入输出 token、成功率、场景和模型分组
- 新增 `src/services/migrations/v7-to-v8.ts` 迁移脚本
- 设置页新增"用量统计"入口

### Task 15: 专注模式与可访问性 ✅

- `ChapterEditor` 新增专注模式：隐藏标题/概要/工具栏，使用更大字号编辑器
- 工具栏新增按钮：版本、历史、上下文、草稿、清空
- 专注模式切换按钮

### Task 16: Android-only 清理与最终发布 ✅

- 导出规范更新为 v2
- `index.tsx` 备份调用传入 `kind='automatic'` 参数
- 版本号更新为 1.6.0
- 全量测试通过（17 suites / 82 tests）
- ESLint 0 errors

---

## 数据库迁移路径

| 迁移 | breaking | 内容 |
|---|---:|---|
| v5 → v6 | false | 新增 `content_revisions` 表和索引 |
| v6 → v7 | false | 新增 `generation_drafts` 表和索引 |
| v7 → v8 | false | `llm_usage_logs` 新增 `model_name` 列和索引 |

当前 `SCHEMA_VERSION = 8`，所有迁移均为非破坏性，保证旧数据直接升级。

---

## 变更统计

V1.6.0 相比 V1.3.8：

- **45 个文件**变更
- **+5,078 行**新增
- **-3,404 行**删除

### 新增文件

| 文件 | 职责 |
|---|---|
| `src/types/revision.ts` | 版本历史类型定义 |
| `src/types/draft.ts` | 生成草稿类型定义 |
| `src/types/contextTrace.ts` | 上下文追踪类型定义 |
| `src/services/revisionService.ts` | 快照创建、去重和恢复 |
| `src/services/draftService.ts` | 生成草稿持久化 |
| `src/services/projectImport.ts` | 项目包校验和导入 |
| `src/services/migrations/v5-to-v6.ts` | schema 5→6 迁移 |
| `src/services/migrations/v6-to-v7.ts` | schema 6→7 迁移 |
| `src/services/migrations/v7-to-v8.ts` | schema 7→8 迁移 |
| `src/screens/RevisionHistoryScreen.tsx` | 版本历史浏览和恢复 |
| `src/screens/BackupCenterScreen.tsx` | 备份管理 UI |
| `src/screens/ContextPreviewScreen.tsx` | 上下文预览 UI |
| `src/screens/DraftPreviewScreen.tsx` | 生成草稿预览和采纳 |
| `src/screens/UsageStatsScreen.tsx` | LLM 用量统计 UI |
| `__tests__/debounce.test.ts` | 异步防抖测试 |
| `__tests__/revisionService.test.ts` | 版本历史服务测试 |

### 重点修改文件

| 文件 | 变更内容 |
|---|---|
| `src/utils/debounce.ts` | 重写为 flushable async 控制器 |
| `src/services/backupService.ts` | 备份 v2 格式、校验、分类保留、事务恢复 |
| `src/services/contextBuilder.ts` | 上下文追踪模型、世界书命中原因 |
| `src/services/pipelineRunner.ts` | 生成草稿保存、管线断点续跑 |
| `src/services/database.ts` | 新增 3 张表 CRUD 和用量统计查询 |
| `src/screens/ChapterEditor.tsx` | 防丢保存、版本快照、专注模式 |
| `src/screens/FreeformEditor.tsx` | 防丢保存、历史入口 |
| `src/screens/StoryOverview.tsx` | 统计行和每章字数 |
| `src/screens/ProjectListScreen.tsx` | 搜索和导入功能 |
| `src/screens/OutlineEditor.tsx` | 章节排序 |
| `src/screens/SettingsScreen.tsx` | 备份中心和用量统计入口 |
| `src/navigation/TabNavigator.tsx` | 5 个新路由注册 |

---

## 测试覆盖

- 17 个测试套件，82 个测试用例全部通过
- 新增测试：debounce（7）、revisionService（5）、backupService（18）
- 更新测试：migrationEngine、installTypeDetection、pipelineRunner、writingContextEnhancements
- ESLint 0 errors

---

## 明确不包含

- 云同步、登录、多人协作
- iOS 支持
- 后台常驻生成或 Android WorkManager
- 向量数据库、embedding 服务或全文 FTS
- 字符级富文本 diff
- 模型价格维护和费用结算
- 自动发布到应用商店
