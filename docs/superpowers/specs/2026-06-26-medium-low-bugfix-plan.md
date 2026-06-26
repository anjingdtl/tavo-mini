# 中低危 BUG 全面修复计划（Phase 7-11）

> 日期：2026-06-26
> 范围：ShineWriter 全项目剩余中危与低危 BUG 修复
> 前置：已完成 Phase 1-6 共 40 个高/中危 BUG 修复（见 `2026-06-26-full-project-bugfix-design.md`）

## 一、审查概况

本轮通过 3 个并行审查 agent + 塔拉手动审查数据层，共发现 **155 个剩余问题点**：

| 模块 | 中危 | 低危 | 合计 |
|------|------|------|------|
| AI 管线（llm/pipeline/context/macro/messages/chapter/noteRetriever/styleAnalyzer/summary/draft/utils） | 7 | 18 | 25 |
| 状态管理 + 导航 + 组件 | 15 | 15 | 30 |
| 屏幕层（25 个屏幕文件） | 30 | 10 | 40 |
| 原生模块（Kotlin + TS 桥接 + AndroidManifest + jest） | 13 | 17 | 30 |
| 数据层（database/backup/secureStorage/revision/migrations） | 8 | 22 | 30 |
| **合计** | **73** | **82** | **155** |

## 二、修复原则

1. **中危优先**：影响功能正确性、数据完整性、用户体验的中危必修复
2. **低危择重**：死代码清理、类型安全、性能优化等低危择重修复
3. **不过度重构**：只修 BUG，不做架构调整；不改变现有 API 接口签名
4. **每 Phase 独立 commit**：确保可回滚
5. **增量验证**：每 Phase 测试通过才进下一步

### 不修复的项
- 安全问题（keystore 密码硬编码）——需要独立密钥管理方案
- 构建配置（jscFlavor 动态版本）——需要 CI 环境配合
- 性能优化的深度重构（selector 订阅重写）——单独优化轮次

## 三、分阶段修复计划

### Phase 7：AI 管线核心逻辑修复（16 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 7.1 | contextBuilder.ts | 资料库检索模式完全失效：`buildRetrievedNoteContext` 构造的 query 把 chapterTitle/synopsis/userPrompt 全传空串，prefilter 拿不到关键词，LLM 检索根本不被调用 | 从 buildContext 透传 currentChapter.title/synopsis 到 buildRetrievedNoteContext |
| 7.2 | pipelineRunner.ts | 取消信号在阶段内被吞：checkCancelled 只在阶段间调用，阶段内 abort 被 catch 当普通失败，draft 场景误存半成品草稿 | 各阶段 catch 先判 abortSignal?.aborted，是取消则 cancelTask + return |
| 7.3 | pipelineRunner.ts | resume 阶段 durationMs 写成时间戳（Date.now() 而非 Date.now()-start），UI 耗时显示天文数字 | 续跑阶段前记录 start，durationMs 写 Date.now()-start |
| 7.4 | llm.ts | callLLMResult 取消错误硬编码"朗读已取消"，管线取消时用户看到错误文案语义错乱 | 改为通用文案"已取消" |
| 7.5 | contextBuilder.ts | 宏替换未覆盖系统提示词：preset.system_prompt 里的 {{char}}/{{user}} 等以字面量进入 LLM | 对 resolvedSystemPrompt 也调用 processMacros |
| 7.6 | batchChapterPipeline.ts | 批量生成覆盖已有草稿：ensureTargetChapters 复用 nonFinal 章节直接覆盖 content | ensureTargetChapters 只挑选 content 为空的章节 |
| 7.7 | contextBuilder.ts | clipTextTailToTokenBudget O(n²)：循环内字符串前插，5万 token 文本卡顿数秒 | 先反向遍历累计 token 找起始下标，最后 slice，O(n) |
| 7.8 | contextBuilder.ts | 多处 `||` 误用导致 max_tokens=0 被忽略（character/note/entry） | 改用 `??` |
| 7.9 | pipelineRunner.ts | conditional 模式状态语义错配：factCheck 阶段调用 setTaskStatus('reviewing') | 改为 'factChecking' 或调整语义 |
| 7.10 | pipelineRunner.ts | resolvePreset 静默回退到 presets[0]，用户以为用自定义预设实际用默认 | presetId 找不到时 Toast 提示 |
| 7.11 | pipelineMessages.ts | buildProofMessages 用"未能完成"子串判断审阅是否可用，LLM 返回含此子串的文本会误判 | 改用 reviewText.trim() 判空 |
| 7.12 | tokenEstimator.ts + contextBuilder.ts | estimateTokens 按单字符循环调用，5万 token 文本约15万次正则操作 | 对整段文本一次性 estimateTokens 后用二分查找裁剪点 |
| 7.13 | summaryGenerator.ts | generateSummary 用 callLLM 不带 config，scenario 回退 'chat'，无 projectId，用量统计失真 | 传 { scenario:'chapter_summary', projectId } |
| 7.14 | styleAnalyzer.ts | analyzeNoteStyle 不校验空内容，空串发往 LLM 返回噪声污染缓存 | 入口判空抛错或返回 EMPTY_PROFILE |
| 7.15 | noteRetriever.ts | extractContextWindow 大小写敏感，query 与 note 内容大小写不一致时漏匹配 | indexOf 前统一 toLowerCase |
| 7.16 | contextBuilder.ts | 世界书 entry.id=0 回退 indexOf 当 id，可能与其他条目 id 撞号 | Number(entry.id) 直接取，0 当无效 |

### Phase 8：状态管理与导航修复（18 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 8.1 | CharacterEditor.tsx | emitChange 闭包陷阱：useCallback deps 仅 [onChange]，内部读闭包旧值覆盖 fieldsRef，连续编辑多字段时上一字段被重置 | 每帧同步 fieldsRef.current，emitChange 仅合并 updates |
| 8.2 | main/index.tsx | init() 无 try-catch，openDatabase 抛错时 setReady 永不执行，App 永久卡白屏 | try-catch 包裹，失败设错误状态 |
| 8.3 | voiceStore.ts | 系统 TTS 路径竞态：speak resolve 前已触发 ttsDone 事件，isPlaying 永久卡死 | speak 调用前注册一次性 done 监听 |
| 8.4 | voiceStore.ts | stop() 中 await cancelTts() 未 try-catch，抛错后 stopAudio 不执行，原生音频泄漏 | try-catch 包裹 cancelTts |
| 8.5 | main/index.tsx | subscribe 回调多 task 同时完成时，早完成 task 被覆盖且 prompted.add 后永不弹窗 | 维护 pendingQueue 串行展示 |
| 8.6 | pipelineTaskStore.ts | loadFromDB catch 吞错，DB 故障时 UI 显示"无任务"无反馈 | catch 中 console.warn + Toast |
| 8.7 | PipelineResultPrompt.tsx | buildCopy 硬编码"章节 #N"，freeform 任务也显示"章节" | 根据 targetType 切换文案 |
| 8.8 | CharacterEditor.tsx | _debounceTimer 模块级共享，多实例互相 clearTimeout | 改为 useRef |
| 8.9 | CharacterEditor.tsx | 切换 showRawDialogue 不同步 dialogueGroups，切回可视化显示旧对话组 | 切换时立即 setDialogueGroups |
| 8.10 | CharacterEditor.tsx | 多处 list 用 index 作 key（groups/greetings/tags），删除中间项时焦点错乱 | 用稳定 key |
| 8.11 | GenerationResultModal.tsx | taskId=null 时提前 return，visible 状态与实际显示脱节 | 改为 Modal visible={visible && !!taskId} |
| 8.12 | projectStore.ts | loadProjects 仅 try-finally 无 catch，抛错时 unhandled rejection | 补 catch |
| 8.13 | projectStore.ts | current 不在 projects 时回退 projects[0] 但不同步 DB，每次启动都走回退 | 回退时同步写 db.setSetting |
| 8.14 | settingsStore.ts | loadSettings Promise.all 无 try-catch，失败导致 PipelineForeground.setEnabled 不执行 | 包裹 try-catch |
| 8.15 | voiceStore.ts | TtsAudioEmitter 模块顶层注册，热重载重复注册 | 提供 setup() 函数 App 入口调用一次 |
| 8.16 | navigationRef.ts | 新 taskId 覆盖 pendingTaskId，旧 taskId 静默丢失 | 维护 pending 队列 |
| 8.17 | main/index.tsx | setTimeout navigate 未在 cleanup clearTimeout，ready 变化时旧 timer 仍执行 | 保存 timer id，cleanup clearTimeout |
| 8.18 | ThemeProvider.tsx | db.getSetting('theme_mode') 无 .catch，失败时 unhandled rejection | 补 .catch |

### Phase 9：屏幕层 async 错误处理批量补全（20 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 9.1 | ChapterEditor.tsx | loadChapter 无 try-catch，DB 异常时 unhandled rejection + 白屏 | 包裹 try-catch + Toast |
| 9.2 | ChapterEditor.tsx | clearContent onPress async 无 try-catch + 无 loading 状态 | 包裹 try-catch + clearing 状态 |
| 9.3 | ChapterEditor.tsx | manualCheckpoint async 无 try-catch，失败仍显示"已保存"误导 | 包裹 try-catch |
| 9.4 | ChapterEditor.tsx | toggleTts async 无 try-catch，失败无反馈 | 包裹 try-catch + Toast |
| 9.5 | FreeformEditor.tsx | loadData 无 try-catch，失败时片段和正文不显示 | 包裹 try-catch + Toast |
| 9.6 | FreeformEditor.tsx | addFragment 无 try-catch，失败后 setText('') 仍执行丢失输入 | 包裹 try-catch，失败不 clear |
| 9.7 | FreeformEditor.tsx | deleteFragment onPress 无 try-catch | 包裹 try-catch + Toast |
| 9.8 | NotesScreen.tsx | add 无 try-catch，失败后 setTitle('') 仍执行 | 包裹 try-catch，失败不 clear |
| 9.9 | PresetScreen.tsx | add 无 try-catch，失败后 setName('') 仍执行 | 包裹 try-catch，失败不 clear |
| 9.10 | ResourceLibrary.tsx | remove onPress 无 try-catch，串联多个 deleteXxx 任一失败无反馈 | 包裹 try-catch + Toast |
| 9.11 | ResourceLibrary.tsx | toggleProjectUsage 无 try-catch，失败时 Switch 状态与 DB 不一致 | 包裹 try-catch，失败回滚 |
| 9.12 | ResourceLibrary.tsx | setAllCharacters / toggleCollection 无 try-catch | 包裹 try-catch + Toast |
| 9.13 | ContextConfig.tsx | save 无 try-catch，失败时 Toast 仍显示"已保存"误导 | 包裹 try-catch |
| 9.14 | ChapterSummary.tsx | save 无 try-catch，失败仍弹"已保存" | 包裹 try-catch |
| 9.15 | PlotlineManager.tsx | remove onPress 无 try-catch | 包裹 try-catch + Toast |
| 9.16 | BackupCenterScreen.tsx | load 为 try-finally 无 catch（Phase 6.2 遗漏） | 补 catch + Toast |
| 9.17 | LLMSettingsScreen.tsx | activate / remove 无 try-catch，失败无反馈 | 包裹 try-catch |
| 9.18 | ProjectListScreen.tsx | confirmDelete onPress 未 try-catch | 包裹 try-catch + Toast |
| 9.19 | PipelineTaskScreen.tsx | resolveTask onPress 未 await + 未 try-catch | await + try-catch |
| 9.20 | PipelineResultScreen.tsx | cleanup 中 resolveTask 未 await + 未 try-catch | .catch(()=>{}) 兜底 |

### Phase 10：屏幕层 UI 交互与原生模块修复（22 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 10.1 | ChapterEditor.tsx | useEffect 订阅 pipeline store 依赖含 chapter 对象，每次编辑退订重订 | 依赖改 [chapterId]，effect 内用 ref 读取 |
| 10.2 | PipelineResultScreen.tsx | 采纳/放弃按钮无 disabled（Phase 6.3 遗漏），可重复点击触发多次 updateChapter | 增加 adopting 状态 disable |
| 10.3 | UpgradeScreen.tsx | 开始升级按钮无 disabled，双击触发两次迁移 | 增加 disabled={status!=='waiting'} |
| 10.4 | CharacterDetail.tsx / WorldbookDetail.tsx | 加载期间无 loading 指示器，显示"未找到"误导；无 try-catch；useState\<any\> | 增加 loading 状态 + try-catch + 具体类型 |
| 10.5 | ContextConfig.tsx | useEffect setDraft 监听 contextConfig，外部更新覆盖用户未保存编辑 | 用 ref 标记编辑态，编辑期不覆盖 |
| 10.6 | LLMSettingsScreen.tsx | useEffect 依赖 [llmConfig, llmConfigs, selectedId]，store 变更覆盖用户编辑 | 用 ref 标记编辑态 |
| 10.7 | RevisionHistoryScreen.tsx | restore onPress 无 isMounted 检查，卸载后 setState | 用 isMountedRef 守卫 |
| 10.8 | PipelineConfigScreen.tsx | useEffect 无 cleanup、无 isMounted 检查，卸载后 setState | 增加 isMountedRef |
| 10.9 | DraftPreviewScreen.tsx | formatTime 未校验 Invalid Date，渲染"NaN-NaN-NaN" | 增加 isNaN 判断返回"—" |
| 10.10 | ContextConfig.tsx | 多处 Number(value) \|\| 3 模式，0 被当 falsy | 改用 ?? |
| 10.11 | ChapterEditor.tsx | seenTerminalRef 永不清理，长时间使用内存增长 | useEffect cleanup 清空 |
| 10.12 | PngMetadataModule.kt (原生) | Phase 4 新建的 PngMetadataModule 是死代码，JS 侧 parseCharacterCardPNG 从未调用原生 | 在 parseCharacterCardPNG 中先调原生再回退 JS |
| 10.13 | jest.setup.js | 缺失 NativeModules.PngMetadata mock | 补 mock |
| 10.14 | TtsAudioModule.kt | speak 在 rebuildTtsWithEngine 等待期间被覆盖，旧 promise 永久挂起 | speak 入口检查 rebuilding，reject 旧 promise |
| 10.15 | TtsAudioModule.kt | doSpeak 中 speed/pitch=0 触发 IllegalArgumentException | 调用前 clamp 到合法范围 |
| 10.16 | TtsAudioModule.kt | setLanguage 不检查返回值，不支持时静默用错误语言 | 检查返回值 <0 时 reject |
| 10.17 | PngMetadataModule.kt | chunk length 无上限校验，恶意大文件 OOM | 增加 MAX_CHUNK_SIZE 校验 |
| 10.18 | PipelineForegroundService.kt | wakelock 30 分钟超时后无续期，长任务 CPU 休眠 | 周期性检查 isHeld 后重新 acquire |
| 10.19 | PipelineForegroundService.kt | acquireWakeLock 未 try-catch，SecurityException 传播到 onStartCommand 致 Service 崩溃 | try-catch 包裹 |
| 10.20 | MainActivity.kt | handleDeepLinkIntent 不去除已处理 intent extra，Activity 重建时重复导航 | 末尾 removeExtra |
| 10.21 | PngMetadataModule.ts | 桥接接口缺 parsePngMetadata 方法签名，类型为 any | 定义接口并 cast 类型 |
| 10.22 | jest.config.js | transformIgnorePatterns 白名单缺 react-native-keychain / @react-native-documents/picker | 白名单加入 |

### Phase 11：死代码清理与数据层修复（18 项）

| # | 文件 | BUG | 修复 |
|---|------|-----|------|
| 11.1 | llm.ts | callLLMStream 死代码，无调用方 | 删除 |
| 11.2 | pipelineMessages.ts | buildAssessmentMessages / buildLightProofMessages 死代码 | 删除 |
| 11.3 | contextBuilder.ts | buildSummaryContext 死代码 | 删除 |
| 11.4 | chapterGeneration.ts | mergeChapterGenerationResult 仅测试使用 | 删除 |
| 11.5 | voiceStore.ts | setMiniMaxApiKey 冗余包装死代码 | 删除 |
| 11.6 | GenerationResultModal.tsx | 整个组件无引用方死代码 | 删除 |
| 11.7 | database.ts | createProject 多步骤无事务（INSERT + ensureDefaultPreset + setProjectResourceEnabled + createChapter） | 整体包进 transaction |
| 11.8 | database.ts | deleteLLMConfig 非原子：DELETE + clearSecureLLMApiKey + setActiveLLMConfig 非事务 | 包进 transaction（DB 部分） |
| 11.9 | database.ts | getPipelineConfig 重复查询 getSetting 8 次，每次独立 SQL | 单次 SELECT 后解析 |
| 11.10 | database.ts | getProjectNoteConfig 中 `Number(row.retrieval_top_k) \|\| 5` 误用 \|\| | 改用 ?? |
| 11.11 | database.ts | setProjectNoteConfig 非事务：先 SELECT existing 再 INSERT OR REPLACE | 包进 transaction |
| 11.12 | backupService.ts | computeChecksum 用 charCodeAt 循环，大备份 JSON.stringify 本身就慢，叠加 O(n) hash | 保留现有实现但注释说明非加密用途 |
| 11.13 | backupService.ts | restoreFromBackup 的 llm_config 行跳过 api_key 但 INSERT 时列名可能不匹配 | 已正确过滤，补注释 |
| 11.14 | ChapterCard.tsx | plotlineColors 用 index 作 key | 用稳定 key |
| 11.15 | ContextPreviewScreen.tsx | 两个 FlatList keyExtractor 用下标 | 用 stable id |
| 11.16 | voiceStore.ts | setMiniMaxApiKey 死代码（同 11.5，确认后删） | 删除 |
| 11.17 | TtsAudioModule.kt | onError(String?) 已废弃 | override 新版 onError(utteranceId, errorCode) |
| 11.18 | appState.ts | 冷启动 AppState.currentState 不可靠 | 初始化后延迟 500ms 主动读一次 |

## 四、测试策略

- 每个 Phase 完成后运行 `npm run lint` + `npx jest` 全量测试
- 每个修复确保不破坏现有 167 个测试
- 如需新增 mock，同步更新 `jest.setup.js`
- 全部修复完成后做一次最终全量测试

## 五、提交策略

- 每个 Phase 完成后独立 commit（conventional commit 格式）
- 全部完成后统一 `git push origin main`
- commit message 格式：`fix(<scope>): <摘要>`

## 六、风险控制

1. **不过度重构**：只修 BUG，不做架构调整
2. **保持兼容**：修复不改变现有 API 接口签名
3. **增量验证**：每 Phase 测试通过才进下一步
4. **原生代码谨慎**：Phase 10 涉及 Kotlin 原生代码，无法在沙箱环境编译验证，需确保逻辑正确
5. **死代码删除前确认**：Phase 11 删除前用 Grep 二次确认无引用方
