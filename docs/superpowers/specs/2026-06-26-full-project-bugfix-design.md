# 全项目 BUG 审查与修复方案

> 日期：2026-06-26
> 范围：ShineWriter 全项目代码审查与分阶段修复

## 一、审查概况

通过 5 个并行审查 agent 对全项目 80+ 文件进行深度静态分析，共发现 **150+ 个问题点**，分布如下：

| 模块 | 高危 | 中危 | 低危 | 合计 |
|------|------|------|------|------|
| AI 管线 (llm/pipeline/context/macro) | 8 | 10 | 10 | 28 |
| 数据层 (database/migrations/backup) | 2 | 9 | 11 | 22 |
| 状态管理 + 导航 + UI | 0 | 24 | 30 | 54 |
| 导入导出 + 工具 + 屏幕 | 5 | 30+ | 15+ | 50+ |
| 原生 Android (Kotlin/Manifest/Gradle) | 4 | 6 | 5 | 15 |
| **合计** | **19** | **79** | **71** | **169** |

## 二、修复范围与优先级

### 修复原则
1. **高危优先**：所有影响数据正确性、功能可用性、崩溃的 BUG 必须修复
2. **中危择重**：选择影响核心流程、用户体验明显的中危 BUG 修复
3. **低危从缓**：代码风格、类型安全等低危问题本轮不处理（避免过度改动引入风险）
4. **每 Phase 独立 commit**：确保可回滚

### 不修复的项
- 安全问题（keystore 密码硬编码）——需要独立的密钥管理方案，不在本轮范围
- 构建配置（jscFlavor 动态版本、keystore 目录缺失）——需要 CI 环境配合
- 性能优化（selector 订阅优化、useMemo）——单独优化轮次处理，避免大面积改动
- `callLLMStream` 伪流式死代码——当前无调用方，删除即可但属于功能删除，需确认

## 三、分阶段修复计划

### Phase 1：数据层关键修复（6 个 BUG）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 1.1 | database.ts | 迁移失败后永久无法重试：`app_version` 提前写入 + `same` 分支不检查 schemaVersion | `'same'` 分支也检查 `schemaVersion < SCHEMA_VERSION`，触发 `runMigrations` |
| 1.2 | backupService.ts | 备份/恢复遗漏 `project_note_config` 和 `note_style_profiles` 两张表 | 加入 `ALL_TABLES`、`DELETE_ORDER`、`INSERT_ORDER` |
| 1.3 | database.ts | `deleteProject(0)` 级联清空全部全局资源 | 开头加 `if (id <= 0) return` 守卫 |
| 1.4 | database.ts | `setActiveLLMConfig` 两条 UPDATE 非原子 | 用 `transaction` 包裹 |
| 1.5 | database.ts | `createProject` 多步骤无事务 | 整体包进 `transaction` |
| 1.6 | database.ts | `repairOversizedNotes` 事务范围错误 + 吞异常 | 把 insertNoteRow 纳入事务；异常往上抛或 console.warn |

### Phase 2：AI 管线核心修复（7 个 BUG）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 2.1 | llm.ts | 用户取消被误报为"请求超时" | catch 中先判 `externalSignal?.aborted`，区分取消 vs 超时 |
| 2.2 | llm.ts | abort 监听器在 finally 中未移除，资源泄漏 | 把 handler 提到外部作用域，finally 中 removeEventListener |
| 2.3 | pipelineRunner.ts | `cancelledTasks` Set 永不清理 | 在 `runChapterPipeline`/`resumePipeline` 的 finally 中 `delete(taskId)` |
| 2.4 | pipelineRunner.ts | `resumePipelineInner` full 模式漏掉 review 重做 | 补充 review 阶段的 conditional 重做逻辑 |
| 2.5 | pipelineRunner.ts | resume twoStage review 失败处理与首次不一致 | 统一为：review 失败后继续走 proof（用空 reviewText） |
| 2.6 | batchChapterPipeline.ts | `onProgress` 当 `onStageUpdate` 传入，类型不匹配 | 传入适配器 `(info) => onProgress(typeof info === 'string' ? info : info.label)` |
| 2.7 | batchChapterPipeline.ts | `ensureTargetChapters` while 循环死循环风险 | 加最大重试次数 + 检查 working.length 是否增长 |

### Phase 3：导入导出安全修复（6 个 BUG）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 3.1 | fileImport.ts | `readJsonObject` 中 `JSON.parse` 未 try-catch | 包裹 try-catch，抛友好错误 |
| 3.2 | fileImport.ts | `decodeLatin1` 用 `String.fromCharCode(...bytes)` 栈溢出 | 改为分批拼接：循环 slice(0, 8192) |
| 3.3 | jsonExtractor.ts | 括号匹配忽略字符串字面量，LLM 输出含 `{`/`}` 的字符串值会截断 | 实现时跟踪字符串状态（inString + 转义处理） |
| 3.4 | tts.ts | `currentAbortController`/`currentTempFile` 并发覆盖 | 加互斥锁，拒绝并发调用 |
| 3.5 | tts.ts | `json.base_resp.status_code` 未判空 | 先校验 `json.base_resp` 存在性 |
| 3.6 | fileImport.ts / projectImport.ts | RNFS.readFile utf8 不会去 BOM，导入 Windows 文件失败 | 读取后 `.replace(/^\uFEFF/, '')` |

### Phase 4：原生模块修复（6 个 BUG）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 4.1 | (新建) | PngMetadata 原生模块 Kotlin 实现缺失 | 新建 `PngMetadataModule.kt` + `PngMetadataPackage.kt`，注册到 MainApplication |
| 4.2 | TtsAudioModule.kt | TTS 引擎切换失败后实例未 shutdown，永久不可用 | onInit 失败分支先 `shutdown(); tts = null` 再 ensureTts |
| 4.3 | MainActivity.kt | `super.onCreate(null)` 丢失状态恢复 | 改为 `super.onCreate(savedInstanceState)` |
| 4.4 | PipelineForegroundModule.kt | 完成/失败通知依赖 Service 创建的 Channel，未启动时静默失败 | postDoneNotification 内 ensureChannel |
| 4.5 | TtsAudioModule.kt | `openTtsSettings` 用 `ACTION_VOICE_INPUT_SETTINGS`（语音识别页） | 改为 `ACTION_TEXT_TO_SPEECH_SETTINGS` |
| 4.6 | PipelineForegroundModule.kt | `updateProgress` 用 `startService` 而非 `startForegroundService` | 统一用 `ContextCompat.startForegroundService` |

### Phase 5：状态管理与导航修复（7 个 BUG）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 5.1 | pipelineTaskStore.ts | `resolveTask` 未把 `resolvedAction` 写入内存 state | set 回调里同步设 `resolvedAction: action` |
| 5.2 | ChapterEditor.tsx | `beforeRemove` flush 失败仍 dispatch，静默丢数据 | flush 失败时不离开 + Toast 提示 |
| 5.3 | ChapterEditor.tsx | `finalizeChapter` 未先 flush autoSaveRef | finalize 前先 `await autoSaveRef.current.flush()` |
| 5.4 | TabNavigator.tsx | `ChapterEditorRoute` 无 key，切换章节显示旧内容 | 加 `key={route.params.chapterId}` |
| 5.5 | SettingsScreen.tsx | 未授权时仍开启后台写作 | 未授权时 return 不开启 |
| 5.6 | navigationRef.ts | navigationRef 未就绪时 deeplink 被丢弃 | 实现 deeplink 队列，ready 后重放 |
| 5.7 | PipelineResultScreen.tsx | `useRoute` 在 try 块内（Hook 反模式）+ unmount setTimeout resolveTask 竞态 | 拆分 Hook 调用；用 ref 标记已 accept |

### Phase 6：UI 交互与错误处理统一修复（批量中危）

| # | 范围 | BUG 模式 | 修复 |
|---|------|---------|------|
| 6.1 | 10+ 屏幕 | async 事件处理器无 try-catch，未处理 Promise rejection | 统一补全 try-catch + Toast |
| 6.2 | UsageStatsScreen / ContextPreviewScreen / RevisionHistoryScreen | `try...finally` 无 `catch` | 补 catch 设置错误状态 |
| 6.3 | PipelineConfigScreen / ProjectListScreen / PipelineResultScreen | 无 loading 防重复点击 | 加 loading 状态 disable 按钮 |
| 6.4 | OutlineEditor.tsx | 批量更新 position 用 Promise.all，部分失败不回滚 | 改用 Promise.allSettled |
| 6.5 | PlotlineManager.tsx | AI 生成情节线颜色全相同（闭包陷阱） | 用循环变量计算颜色索引 |
| 6.6 | noteRetriever.ts | 缓存 slice 后无法满足更大 topK 需求 | 缓存时不截断 |
| 6.7 | llm.ts | `usage.prompt_tokens \|\| estimate` 用 `\|\|` 而非 `??`，0 被误判 | 改用 `??` |
| 6.8 | summaryGenerator.ts | `JSON.parse(json)` 未 try-catch | 包裹 try-catch + 友好错误 |
| 6.9 | debounce.ts | 吞掉所有错误，自动保存失败用户无感知 | 提供 onError 回调 |

## 四、测试策略

- 每个 Phase 完成后运行 `npm run lint` + `npx jest` 全量测试
- 每个修复确保不破坏现有 167 个测试
- 如需新增 mock（如 PngMetadata），同步更新 `jest.setup.js`
- 全部修复完成后做一次最终全量测试

## 五、提交策略

- 每个 Phase 完成后独立 commit（conventional commit 格式）
- 全部完成后统一 `git push origin main`
- commit message 格式：`fix(<scope>): <摘要>`

## 六、风险控制

1. **不过度重构**：只修 BUG，不做架构调整
2. **保持兼容**：修复不改变现有 API 接口签名
3. **增量验证**：每 Phase 测试通过才进下一步
4. **原生代码谨慎**：Phase 4 涉及 Kotlin 原生代码，无法在沙箱环境编译验证，需确保逻辑正确
