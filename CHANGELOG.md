# Changelog

## [2.11.30] - 2026-08-05

### Fixed

- **备份引擎：非核心表缺失时不再崩溃**：解决召回时"恢复备份失败：no such table: outlines"。
  - **根因**：`createBackup` 遍历 BACKUP_MANIFEST 读表时用 `SELECT *` 但**没有 try/catch**——与同文件的 `readBackupTables`（有容错）逻辑不一致。用户的旧库（schema < 36）没有 outlines 表，SELECT 直接抛异常中断整个备份，导致召回的前置恢复备份失败、整个召回中止。
  - **修法**：`createBackup` 的读表循环加 try/catch，非核心表（CORE_TABLE_NAMES 之外的表如 outlines）SELECT 失败时跳过（空数组），核心表失败才 throw。与 readBackupTables 容错策略一致。

## [2.11.29] - 2026-08-05

### Fixed

- **召回合并：绕过启动初始化直连原始数据库**：解决"召回中止 无法打开数据库：[object Object]"。
  - **根因**：`openDatabase()` 内部调 `initializeDatabase()`——当数据库 schema 漂移/损坏导致启动校验 fail-closed 时，`initializeDatabase` 抛 `SchemaRecoveryError`（结构化对象），`openDatabase` re-throw，merger 的 catch 用 `e?.message` 提取失败渲染成 `[object Object]`。召回功能本该修复的库，自己却连不上。
  - **降级原始连接**：`applyRecall` 在 `openDatabase()` 失败时，降级到 `SQLite.openDatabase` 直接打开原始连接（跳过 initializeDatabase 的校验链），让召回/修复仍能操作数据库。底层 SQLite 连接其实已打开，只是初始化没过。
  - **全链路 extractMessage**：merger 所有 catch 路径（DB_OPEN / RECOVERY_BACKUP / DRIFT_REPAIR / SOURCE_INSERT）统一用 `extractMessage`，处理 Error / string / {message} / SchemaRecoveryError{code,errors} / 任意对象，杜绝 `[object Object]`。

## [2.11.28] - 2026-08-05

### Fixed

- **召回功能：库不可读时提供修复路径**：解决 V2.11.27 用户遇到的"全部表读取失败 + 无备份源 + 无可操作按钮"死路。
  - **根因**：V2.11.27 的 unreachable 诊断报告把 `needsRepair` 设为 false，导致"修复结构漂移"开关不显示；`repairDrift` 默认被设为 false，"执行召回"按钮因 `canApply=false` 被禁用——用户看到死路。
  - **unreachable 也显示修复开关**：`needsRepair=true`（`repairKnownSchemaDrift` 幂等安全，值得一试），用户即使没有备份也能尝试修复当前库让数据重新可读。
  - **显示具体错误原因**：`unreachableReason` 在 UI 展示，用户和我都能知道库为什么读不了。
  - **引导文案**："你的资料可能仍在库里。点击下方'修复数据库结构漂移'尝试恢复读取。"

## [2.11.27] - 2026-08-05

### Fixed

- **召回扫描彻底防崩**：解决真机上"扫描失败 [object Object]"问题（V2.11.26 修复不彻底）。
  - **根因**：`scanCurrentDb` 里 `openDatabase()` 和 `inspectKnownSchemaDrift(db)` 没有 try/catch 保护。真机上报障用户的库恰好处于损坏/漂移状态，settings 表读取抛异常，冒泡到 UI catch；召回功能本应应对"库有问题"的场景，扫描入口自己却崩了。
  - **总入口防崩**：`scanRecallSources` 包最外层 try/catch，库不可读时构造一个全 -1 的 unreachable 诊断报告返回（不抛），UI 进 preview 态展示"当前库读取失败"，仍可继续扫描备份源。
  - **版本号显示**：RecallScreen 入口态显示当前 versionName，用户截图即可确认跑的版本，避免误报。

## [2.11.26] - 2026-08-05

### Fixed

- **召回扫描真机崩溃修复**：解决真机上"扫描失败 [object Object]"问题。
  - **根因**：Toast 错误展示用 `e?.message`，真机 release bundle 里部分异常对象没有标准 `message` 属性，渲染成 `[object Object]`；同时 `scanDir` 循环里 `parseBackupFile` 调用未包 try/catch，单个损坏备份文件会让整个扫描抛出。
  - **健壮错误提取**：新增 `extractMessage` / `extractErrorMessage` helper，处理 Error / string / {message} / 其他对象，保证 Toast 永远显示可读字符串。
  - **单文件异常隔离**：`scanDir` 每个文件解析包 try/catch，失败的文件记录一条 invalid finding（"读取失败：<原因>"）而非中断整个扫描。
  - **错误详情可见**：scanError 态 UI 展示具体错误信息，方便用户报告。

## [2.11.25] - 2026-08-05

### Added

- **备份中心「召回潜在数据」功能**：为升级后资料"显示为空"的场景提供手动召回入口。
  - **三源扫描**：源 A 诊断当前库（schema 漂移检测 + 11 张召回表行数 + 主键集合）；源 B 扫描 `schema-recovery/` 恢复点 JSON；源 C 扫描 `backups/` 用户备份 JSON。
  - **主键差集算法**：`recoverable` 按源行主键与当前库已有键集合的差集计算，精确区分"完全缺失"与"部分缺失"，避免把已存在数据误判为可召回。
  - **扫描→预览→勾选→合并**：用户主动触发，按源×表预览可召回量，勾选后执行；默认只勾选有可召回量的源。
  - **安全合并**：合并前强制 `createSchemaRecoveryBackup`（失败即中止、不动数据）；源 A 修复 = `repairKnownSchemaDrift`，源 B/C 合并 = `INSERT OR IGNORE` 只补缺失行，绝不 DELETE/UPDATE 现有行。
  - **非递减召回守卫**：合并前后 `captureUserDataRecallSnapshot` 比对，after 必须是 before 的超集；数据减少立即标 failed（区别于迁移场景的严格相等守卫，召回语义是"只增不减"）。
  - **列投影兼容**：旧 schema 备份（缺新列/多已删列）通过 `SCHEMA_MANIFEST` 列交集安全合并。
  - **新模块**：`src/services/recall/`（recallTypes / recallScanner / recallMerger / dataRecallService）+ `src/screens/RecallScreen.tsx`；备份中心新增入口按钮，SettingsStack 注册 Recall 路由。
  - **复用 V2.11.24 召回基础设施**：不造新合并引擎，90% 复用 schemaDriftInspector / knownSchemaRepairs / userDataRecallSnapshot / schemaRecoveryBackup / backupService。

### Validation

- 18 个真实 SQLite 测试（S1-S8 扫描 + M1-M10 合并 + E2E 端到端）；`npm run verify` 全过（279 套件 / 2292 测试 / 0 TS 错误）；模拟器覆盖安装验证入口可达、扫描结果真实、按钮布局无重叠。

## [2.11.24] - 2026-08-05

### Fixed

- **Schema 40 用户资料召回修复**：解决覆盖安装后角色卡、世界书显示为空的 P0 事故。
  - **根因**：数据库 recorded `schema_version=39`，但 `canon_evidence` 表的 `source_origin` / `rescan_operation_id`（Schema 32→33 provenance 列）从未实际落地。版本迁移引擎跳过 32→33，漂移永久存在；引用 `source_origin` 的查询（Canon rescan、启动校验器）抛 `no such column`，中断初始化链，UI 来不及读到仍然完好的角色卡和世界书。
  - **Schema 39→40**：新增幂等 `ensureCanonEvidenceProvenanceSchema`（check-then-ALTER + backfill `batch` + CREATE INDEX IF NOT EXISTS），不依赖 `ADD COLUMN IF NOT EXISTS`。
  - **32→33 幂等化**：重构为逻辑迁移 `migrateV32ToV33`，共享同一 ensure 函数；不再无条件 ALTER（旧代码在已有列的库上重复执行会抛 `duplicate column`）。
  - **初始化顺序重排**：inspect 漂移 → 捕获召回快照 → 创建+校验 schema-recovery 备份 → pre-migration repair → migrate → post-migration repair → strict validate → seed → 比较召回快照 → 全部成功才写版本标记。
  - **召回快照**：分块读完整 ID 集合，strict before/after 比较（角色/世界书/合集/关联表）；不一致时阻止启动并报 `USER_DATA_RECALL_MISMATCH`。
  - **schema-recovery 备份**：独立 `schema-recovery/` 目录，写后重读校验 checksum + 核心表行数；`SELECT *` 容忍漂移列；核心表行数不匹配时 fail-closed。
  - **UI 防假空态**：`ResourceLibrary` 新增 `loadError` 状态——数据库读取错误不再渲染成"还没有角色卡"；改为显示"资料暂时无法读取，数据可能仍然存在"。
  - **恢复状态上报**：`main/index.tsx` 修复成功时 Toast 展示前后数量；恢复失败时不掩盖错误，提示保留原数据库和恢复备份。
  - **canon_evidence 整表缺失**：不创建空表掩盖问题，保留数据库和备份，返回结构化恢复错误。
  - **备份类型扩展**：新增 `pre_migration` / `schema_recovery` BackupKind。

### Validation

- 新增 19 个 drift-matrix 测试（Case A–O）覆盖正常升级、漂移修复、安全失败；E2E 修复证明在真实 sql.js SQLite 上验证 recorded-39 漂移库修复后数据不变；模拟器覆盖安装验证（注入漂移 DB → 装修复版 → 角色卡/世界书重新出现 → Schema 40 物理确认）；2271 Jest pass / 0 TS errors。

## [2.11.23] - 2026-08-05

### Fixed

- **Pipeline 三封口收敛**：冻结执行、checkpoint/CAS 全面 fail-closed、预算器真正驱动最终 messages。
  - **冻结 Draft 请求**：任务启动时持久化 `FrozenDraftRequest`（含最终 messages 与 fingerprint）；Draft 首次/Resume/重试只发送冻结 messages，不再从 live 大纲/人物/世界书/Story Memory 重编译。
  - **冻结 Audit 候选**：full 模式在启动时捕获 `FrozenAuditCandidates`；Draft 完成后仅在冻结池内重打分生成 `auditContext`，不得再读实时 Repository；缺候选的旧任务不可静默恢复。
  - **CAS / checkpoint fail-closed**：统一 `executeClaimedStage`；`getStageCheckpoints` / claim 抛错或 `rowsAffected != 1` 时 LLM 调用次数为 0；普通异常不会把阶段永久卡在 `running`；关键终态走 awaited `persistFailTask`。
  - **预算驱动最终消息**：Review / Fact Check / Proof 的可选资料按守恒 allocation 实际裁剪；模型调用只接受 `ReadyStageRequest`；retry/repair 超窗不调模型。
  - **大纲 30% 不再硬阻断生成**：`OUTLINE_BUDGET_RATIO=0.3` 仅作管理页建议；生成用剩余输入预算装完整大纲，仅当完整大纲 + fixed prompt + 必需正文 + 输出预留 + 安全余量超窗时阻断。

### Changed

- 统一阶段编译结果为 `ready: true | false` 联合类型；错误分类不再用中文正则判断大纲错误。

### Validation

- 新增封口单测（冻结 / 预算 / CAS fail-closed）与 Schema 39 故障注入恢复测试；pipeline 相关回归与 `tsc --noEmit` 通过。

## [2.11.22] - 2026-08-05

### Fixed

- 续写 V5 draft writer 章节衔接断裂：prompt 读取的是 `primaryAnchorSummary`（context builder 在续写章节场景下刻意清空成占位符的遗留标签），从未读取真实的 `primaryAnchor.excerpt`，导致模型生成第 N+1 章时完全看不到第 N 章正文，章节之间无法衔接（相对 V4 的回归）。draft writer 现改为渲染真实上一章接缝（summary + 已裁剪 excerpt 尾段）；revision writer / auditor / final reviser 三个原本不带任何上一章正文的阶段统一注入接缝块，auditor 新增「衔接检查」职责（发现问题须产出 `finalObligation`），final reviser 提示 V3 开头须与接缝自然衔接。
- 续写 V5 Stage Caller 空正文偶发失败：`defaultV5StageCaller()` 接收了 `responseFormat` 参数但调用 `callLLMResult()` 时遗漏透传，`response_format: json_object` 从未上链，部分模型偶发返回空正文/纯计划 JSON 触发 `sanitizeChapterContent()` 的空正文校验。`defaultV5StageCaller` 现透传 `responseFormat`（与 `defaultStageCaller` 一致映射）；空正文校验不放宽，新增 `buildV5DraftWriterDiagnostics()` 收集安全诊断字段、`mapV5DraftWriterEmptyContentError()` 将错误重写为可操作中文提示（截断/过滤/网络等更具体错误优先透传）。
- 续写结果页点展开/折叠按钮卡顿：V5「V3 改动占比」行在 JSX 内联调用 `computeV3ChangeRatio`，对 V2/V3 两段完整正文（3000+ 汉字）跑 O(N×M) 汉字序列 LCS 动态规划，且未做 `useMemo`，导致每次切换 `expanded`/`busy` 状态触发 re-render 时同步阻塞 JS 线程。现将该计算提到组件顶层并用 `useMemo` 锁定 V2/V3 的 `content` 与 `contentHash` 依赖，仅在正文实际变化时重算。

### Changed

- 续写结果页不再展示 V1/V2/V3 三段正文：三段各 3000+ 字的 `<Text selectable>` 同时挂载在单个 `ScrollView` 内，是上下滚动时明显掉帧的主因；对用户而言只有可采纳的 V3 才有决策价值（其正文已在工作区编辑器中审阅），过程稿正文无实际用途。V5 三稿卡片改为始终显示的摘要行——标题（V1/V2/V3）、生成 Token 数、汉字数、状态标签（过程稿·不可采纳 / 可交付终稿），去掉展开按钮与正文区。「V3 改动占比」行作为无正文情况下的质量摘要保留。

### Validation

- 新增章节衔接回归（draft/revision/auditor/final-reviser 四阶段接缝注入 + 占位符消失）、V5 Stage Caller 透传与空正文诊断映射测试；更新 V5 结果页测试断言三段正文永不渲染、摘要行与采纳/放弃按钮保留；全量 `npm run verify` 通过。

## [2.11.21] - 2026-08-04

### Fixed

- 续写 V5 修复 V2 artifact 被 `insertArtifact` 去重逻辑静默吞掉的严重缺陷：当 revision_writer 产出的 V2 正文与 V1 draft 的 contentHash 相同时，`UNIQUE(run_id, content_hash)` 冲突会让 insertArtifact 直接返回已有的 draft 行，导致整个 V1→V2→C2→V3 链路退化为 V1→C2(审V1)→V3(润色V1)，V2 扩写环节完全架空。revision_writer 的 insertArtifact 调用现在传 `requireStageMatch: true`，确保即使 hash 撞车也会生成独立的 revision_1 artifact（通过 `withDistinctArtifactBody` 加 salt 区分）。

### Changed

- 流水线结果页「V3 改动占比」行优化：当 V3 与 V2 正文一致（contentHash 相同）时，明确提示「V3 与 V2 正文一致，未做润色」而非笼统的 0%，帮助识别 V2 被吞或 V3 未执行润色的异常场景。

### Validation

- 新增 regression：V2 contentHash 与 V1 相同时仍产出独立 revision_1 artifact；全量 `npm run verify`、Android Debug 构建与模拟器安装见本次构建记录。

## [2.11.20] - 2026-08-04

### Changed

- 续写执行进度条映射到 V5 真实阶段：`PipelineProgress` 与 `useChapterPipeline` 新增 V5 节点（`draft_writer` / `narrative_architect` / `revision_writer` / `adversarial_auditor` / `final_reviser` / `final_validate`）及 `round1/2/3`→子阶段映射，进度文案随 V1→A1→V2→C2→V3 实时推进，不再全程停在「正在准备续写上下文…」。结果页「生成进行中」横幅同步改为中文阶段名。
- 续写结果页（V5 三稿区）新增「V3 改动占比」行：基于 V2/V3 汉字序列 LCS 计算定点润色幅度（contentHash 一致时直接显示 0%），帮助直观区分「全局相似度高」与「目标段实际已重写」。

### Hardened

- `buildContinuationV5RevisionAnchors` 入口对输入做 `\r\n`→`\n` 归一化防御：锚点偏移与 excerpt 永远基于 LF 口径，即便未来某条路径意外传入 CRLF 也不会造成偏移错位。经实测复核，当前 V2 落库正文为 LF、C2 锚点偏移已精确匹配，此前报告的「漂移」为诊断工具（Windows sqlite3 CLI）的换行转换假象，代码本身无 bug。

### Validation

- 新增锚点 builder CRLF 归一化回归；全量 `npm run verify`、Android Debug 构建与模拟器安装见本次构建记录。

## [2.11.19] - 2026-08-04

### Changed

- 续写 V5 的 Final Reviser（V3）改由客户端展开的「V3 编辑工作包」驱动：在 `continuationV5PromptCompiler.ts` 新增 `buildContinuationV5EditWorkPacket` / `formatContinuationV5EditWorkPacket` 与 `ContinuationV5EditWorkItem` 类型，从已解析的 C2 `styleAudit.requiredCorrections` 中仅挑选 `anchorId` 非空且真实原段非空的任务，逐项回填真实 V2 原段、偏移、维度、改写目标、必须保留信息和关联义务。
- V3 的 system/user prompt 重排：先给出按编号排序的工作包，每项明确「整体重写本段」执行动作，禁止以删词、改标点或少量近义替换完成任务；完整 V2 仍作为章节连续性基线紧随其后；Canon、A1、finalObligations 等排在工作包之后，降低对定点编辑的注意力稀释。
- 仍保持五次物理 LLM 请求；V3 仍输出完整正文 envelope；不新增 V2/V3 差异、最小改动量、锚点命中率等结果硬门槛；`finalArtifactValidator.ts` 未做拦截改动。legacy `anchorId=null` 合同兼容、不抛错。

### Validation

- 新增工作包构建、legacy 空锚点兼容、Final prompt 工作包位于完整 V2 之前、工作包含真实原段与整体改写指令的回归；全量 `npm run verify`、Android Debug 构建与模拟器安装见本次构建记录。

## [2.11.18] - 2026-08-04

### Changed

- 续写 V5 的 C2 改用客户端从真实 V2 提取的稳定段落锚点（`v2-p-xxx`）：Auditor 只能选择锚点 ID，客户端回填原文、偏移和范围给 C2 合同与 V3，杜绝模型转述/拼接出的伪锚点。
- V3 改为按 C2 的真实锚点逐段整体改写，明确禁止仅删词、改标点或少量近义词替换来完成润色；不增加 LLM 调用、不引入 V2/V3 差异硬门槛。

### Validation

- 补充 V2 锚点构建、C2 锚点解析回填与 V3 定向润色提示词回归；全量 `npm run verify`、Android Debug 构建和模拟器安装见本次构建记录。

## [2.11.17] - 2026-08-04

### Changed

- 续写 V5 的 C2 改为由真实 V2 驱动：原本并行的 Revision Writer 与 Adversarial Auditor 改为 `V1/A1 并行 → V2 → C2(V2) → V3`。保持五次物理 LLM 请求上限，但 C2 现在审阅实际 V2，而不是只能基于 V1/A1 推测。
- Auditor Prompt 要求即使无 Canon 错误也针对 V2 给出 3–6 条带原句锚点、rewriteGoal 与 preserveMeaning 的可执行文风润色项；Final Reviser 将这些任务作为逐项改写驱动，而非空泛参考。C2 新增 `revisionArtifactHash`，将其审阅对象绑定到 V2。

### Validation

- V5 合同、Prompt 角色与工作流定向回归通过；全量 `npm run verify`、Android Debug 构建与模拟器安装见本次构建记录。

## [2.11.16] - 2026-08-04

### Added

- 原著分析质量改造：max_tokens 与 thinking 不再被人为压缩；30% 预算只用于正文切块，缩块重试阶梯 `[0.30, 0.20, 0.12]`；五维硬验收（characters / worldRules / relationships / plotThreads / experiences 各 ≥3，按 run + snapshot 隔离计数）失败时定向补扫，缺失维度聚焦当前模式原文范围（full=全部 / quick=最后 10 章）≤2 轮；物化回读 `materializedTotal===0` 判定为 `analysis_materialization_empty` 不激活；快速分析最后 30 章 → 最后 10 章精读，CanonQueryService 不再区分 full / quick；新增 `canonBudgetPolicy` / `canonFiveDimensionGate`。
- Schema 33：Canon evidence 表新增 `source_origin` / `rescan_operation_id` 列及五个业务唯一索引（world_rules / characters / plot_threads / relationships / experiences），迁移中按 `review_status != superseded` 去重清理；`canonEvidenceService` 定向补扫按 `owner_type + source_origin + rescan_operation_id` 分类级删除，绝对不触碰 batch 证据或跨分类。
- 续写 V4 字段协议统一：`writerArtifactHash` 校验 Writer artifact contentHash；`reportAction(metrics)` 让本地 Control 决策权威、模型回显仅作诊断；稳定 fingerprint（category / severity / range / 排序后 evidence / suggestedFix）替代旧 `subtype + description + excerpt`。
- 续写 V4 Repair 可执行契约：非篇幅本地安全问题（`source_overlap` / `continuation_anchor_overlap` / `future_leakage` / `self_duplicate` / `resurrection_forbidden`）注入 Repair；篇幅类 `chapter_length_*` 由 Control 拥有；Repair 收到 `controlProgressDirective` 与 `audit-task` 段，回填 `appliedIssueIds` / `appliedControlFindingIds` / `appliedLocalSuggestionIds`，注入与采纳计数 + Writer / candidate 汉字 + actualDelta + requiredProgress + controlProgressPassed 全部接入现有 telemetry 列。
- 续写 V4 长度收敛：P0-0 共享比例 `±30%` 长度契约（V4 / legacy 共用）；P0-1 修复 style finding excerpt，去掉证据占位；P0-2 Writer 软区间 + beat 预算 + 深化优先；P0-3 长度扩展 Repair 触发条件、增长 / 下限合规、扩展完整性；P1-1 统一任务列表 + 内联锚点 + 结构化失败诊断；P1-3 Writer `finishReason` 长度检测与 budget telemetry。
- 续写 V4 创作松绑：Checker 软化字数目标，改用 `repairReady` / `completeness` 策略驱动 Repair；Control 改为文风审阅（不再卡扩缩进度门），文风发现明细直接展示在结果页；章节编辑器 / 续写工作台可找回未采纳的 pending review run。
- 续写 V4 取消 / 停止路径加固：避免取消竞态与未处理 rejection；请求调度在 cancellation 期间不再注入新任务；V4 / pending / policy 单测覆盖。

### Fixed

- 原著分析 5 大证据 / 补扫 / coverage 缺陷：(1) 超长章节 chunk 证据绝对偏移（`BoundedSourceChapter` 附 `chunkStartChar` / `chunkEndChar`，`resolveExtractionEvidenceAgainstChapters` 统一加偏移，`insertEvidence` 落库前用 SourceReader 回读校验，偏移错误拒绝落库）；(2) 定向补扫误删其他分类证据（新 `materializeRescanResult` 按 `owner_type + source_origin + rescan_operation_id` 分类级删除，`materializeBatchResult` 补齐 `canon_world_rules` 删除与 `source_origin` 过滤）；(3) 缩块重试静默丢失正文尾部（新 `partialCoverage` + `analyzedCharEnds`，调用方把未覆盖尾部重新规划为持久化子批次）；(4) 15% 补扫预算 + 轮换片段（`SOURCE_CHUNK_RATIO_RESCAN=0.15`，`resolveCanonBudget` 派生真实 15% 预算，两轮使用不同章节区间，max_tokens / thinking 保持完整）；(5) 补扫后 `coverage` / `capabilities` 未重算（gate 通过后重新 `buildCoverage` + `updateSnapshotMeta`，五维计数改为 evidence-aware 与 Gate 一致）。
- 续写 V4 Repair 强校验：`repair_control_insufficient_progress` 从 warning 提升为 blocking（expand / compress 双向），区分 (A) Control 方向实质进展硬门 与 (B) 最终字数在合法区间软门；Local Final Gate 保留 `chapter_length_*` warning；本地 suggestion id 缺失但进展达标仍为 warning，按产品决策维持现状。

### Validation

- `npm run verify`、`npm run test:coverage` 通过；新增强 schema-32 / schema-33 fixture、`sql.js` 真实 SQLite 内存测试基建与 10 个 Canon 测试文件 / 36 测试；Android Debug 构建通过；4 处工作流测试同步到新 contract。
- 完整设计与脱敏证据见 `docs/continuation-v4-length-repair-fix-plan.md` / `docs/tavo-mini-v4-engineering-fixes-supplement.md` / `docs/tavo-mini-v4-creative-loosening-redesign.md` / `docs/tavo-mini-canon-analysis-round2-fix-plan-remote-aligned.md`。

## [2.11.15] - 2026-08-03

### Added

- 新增原著续写 V4 FULL-Control 独立流水线：Writer 初稿 → Checker / Control 并行 → Repair 完整终稿 → Local Final Gate，最多四次物理 LLM 请求；Checker 的有证据 `error/blocking` 会强制进入 Repair，不能因篇幅合格而短路。
- 明确 Checker / Control 分工：Checker 负责 Canon、状态、知识、关系与锁定规则事实一致性；Control 输出重复退化、段落结构、Beat 覆盖、对话/场景节奏和结尾推进等结构化 advisory findings，Repair 通过 `appliedControlFindingIds` 回填，未回填只记 warning。
- 强化 Repair 可执行契约：Checker issue 只有具备精确原文定位、证据和直接修订动作时才作为 repair-ready 任务注入；Control 负责结构类观察，Checker 不再把无定位的结构 warning 伪装成语义修订单。Repair 漏掉回执数组时按空数组兼容解析，正文仍交给 Local Final Gate 与合规校验。
- Schema 升级到 32：新增四阶段结果、请求 reservation、artifact eligibility / rejection 与原子终稿落库；Canon 仍只经 `CanonQueryService` 读取，外部资料只接收冻结的 `external_supplement` binding。
- Writer 动态汉字目标同时注入提示词头部和输出前检查；Control 使用客户端本地汉字计数，Repair 只接受完整终稿 envelope，不接受 offset Patch；Local Final Gate 的篇幅区间只作 warning，不阻断已完成质量修订且通过本地安全检查的 Repair，只有正文坍缩到 1000 个汉字以内才硬拦截。Repair 上下文收敛为 Writer 原文、Checker 报告和 Control 报告，避免重复 Canon / 状态 / 风格上下文分散修订注意力。

### Validation

- `npm run verify`、`npm run test:coverage`、Android Debug 构建通过；真实 DeepSeek V4 配置在 Android 模拟器完成 Canon ready → V4 FULL-Control，Writer 本地 2,133 汉字触发 Control `expand`，Repair 修订到 2,429 汉字并成为默认 eligible 候选；Local Final Gate 将篇幅不足保留为 warning，物理请求 4/4。完整脱敏证据见 `docs/optimization/continuation-full-control-v4-validation-report.md`。

### Fixed

- 新增 Schema 30→31：修复已升级到 2.11.13 的原著续写数据库中，部分 Canon 表仍错误引用临时表 `continuation_analysis_runs_v29` 的外键；升级后可正常删除原著，原著、续写章节与已有 Canon 数据均会保留并完成关联修复。
- Schema 29→30 的原著分析任务表重建同步覆盖全部 Canon 关联表，避免从旧版直接升级时再次留下临时表外键。

## [2.11.13] - 2026-08-01

### Fixed

- Schema 28→29 多文件原著迁移改为逐列幂等检查，修复预览版已写入列但版本号未更新时的 `duplicate column name: source_files_json` 启动失败。
- 新增 Schema 29→30：重建遗留 Canon 分析任务的 `stage` 约束并完整保留任务、批次和工作项，允许已完成正文提取的任务进入 `style_analysis` / `style_validation`，不再卡在“正在汇总结果”。

## [2.11.12] - 2026-08-01

### Fixed

- 续写 Writer 输出预算改为依据模型上下文、目标篇幅和配置动态计算，移除隐藏的 4096 token 硬上限；首次空响应会保留 finish reason 并在安全上限内自动重试，避免“Writer 未返回正文”误报。
- 大纲初稿对推理-only/长度截断的空响应增加一次安全重试，仍无正文时阻止保存空草稿并给出可操作错误。
- 上下文预览与实际续写共用同一 Writer 预算计算，避免预览显示与实际请求不一致。
- 续写 planner / writer / checker 纳入章节级 180 秒超时策略，避免大上下文请求错误落入 60 秒普通请求超时。

### Validation

- 续写与大纲空响应、动态预算自动化回归通过；Android 模拟器在默认 1M 上下文与真实 6.2MB 原著上完成 DeepSeek 续写/大纲流程，正式签名 APK 验收记录见 `test-logs/`。

## [2.11.11] - 2026-08-01

### Fixed

- 原著章节解析兼容常见 TXT 标题空格写法（如“第 1 章”“第　十二　回”），不再将这种多章原著错误退化为单一“无标题章节”。解析规则版本已更新；历史上受此格式影响的原著需重新导入一次，以重建正确的章节边界。
- 原著写作风格的置信度改为证据置信度：基于实际有界原著字数、抽样材料量、场景分层和章节覆盖计算，并保留模型评分中较高的可信值。模型不会再因“仅识别到一章”而把已有大样本分析错误显示为 20%。分析覆盖统计由客户端按实际样本回写，不再信任模型生成的计数。
- 原著风格分析进入独立单并发队列，Canon 正文批次全部完成后才自动入队；风格任务遵循 80% 安全上下文预算（先预留输出，再留 20% 余量），不抢占 Canon 的两路长上下文槽位，也不会按 1M 窗口满载发送。

### Validation

- 回归覆盖中英文/全角空格章节标题的一次性与流式等价解析；覆盖 210 万字符、三文件、八类分层样本在模型自报 20% 时仍获得至少 80% 的证据置信度，以及短小样本不会被虚高。

## [2.11.10] - 2026-08-01

### Fixed

- Canon 完整分析改为仅按实际文本 token 预算连续打包；章节只保留证据边界，不再以每批 20 章人为拆分。1M 上下文在 80% 安全预算下可将约 6 MiB 原著按约 791K 输入 tokens 分为少量可恢复批次。
- “结果整理”阶段新增数据库心跳和界面活动说明：模型请求完成后的本地证据/覆盖范围合并不再只是无解释的 100%，会显示最近活动时间。

### Validation

- 使用 `docs/LLMTesti.txt` 的 DeepSeek V4 Flash 配置真实导入三份约 2 MiB TXT：多选无编码弹窗、LLM 首次排序正确；完整 Canon 3 批 / 6 调用均首试成功，原著写作风格首轮成功并自动启用。

## [2.11.9] - 2026-08-01

### Fixed

- **多 TXT 导入反复要求选择编码**：多文件导入改为全自动按每个文件的原生检测结果解码，不再向用户展示编码选择；单文件的低置信度恢复选项保持不变。
- **多 TXT 的 LLM 排序误回退**：排序结果解析改用与 Canon 相同的稳健 JSON 提取逻辑，兼容 Markdown 包裹、前后说明、双重 JSON 编码、字符串索引和常见字段别名；缺少置信度或理由时使用安全默认值。排序请求同时固定使用排序页当前选择的 LLM 配置。
- **大原著 Canon 分析请求超时/OOM**：每个 Canon 请求现在最多使用声明上下文的 80%，其中输出最多占这份安全预算的 25%；保留两路并发，原著会按这一安全预算拆成可恢复批次。客户端 Canon 请求总超时同步提高到 9 分 30 秒，避免在模型服务仍正常排队或生成时过早中断。

### Tests

- 新增多文件编码确认分支回归测试；扩展排序测试，覆盖 Markdown、双重 JSON 编码、字符串索引、字段别名及指定 LLM 配置传递；补充 1M 上下文 80% 安全预算的 Canon 分批回归。

## [2.11.8] - 2026-08-01

### Fixed

- **多 TXT 导入失败无提示**：批量导入循环由"任一文件失败即整批中止"改为逐文件 try/catch，失败文件收集到清单，弹窗告知成功/失败数量与每个失败文件的具体原因（编码不支持/超大/解码失败/解析失败等），并提供"继续导入成功文件"选项；全部失败时阻止导入。编码探测失败不再静默吞，改为 Toast 提示将按 UTF-8 兜底。临时副本清理覆盖所有已复制文件（含后续步骤失败的路径）。
- **Canon 分析"模型上下文不足"**：根因是 `planAnalysisTokenBudget` 写死 32768 输出基线且无 chunk 降级。新增 `adaptiveBatchPlanner` 完全从用户 LLM 配置（`context_window` / `max_output_tokens`）派生每 batch 输入预算：小上下文模型自动切更多批次、超大章节自动按字符区间切成 chunk batches 逐段分析（绝不跳过章节），用 LLM 调用次数弥补上下文限制；`extractMaterialWithLlm` 的 `max_tokens` 与预算校验值统一。分析前新增预检对话框，展示当前配置、预计 batch 数/LLM 调用次数/耗时；配置不足时给出具体的 `max_output_tokens` 与 `context_window` 建议值。
- **多文件排序页采样失败静默**：采样失败时提示"部分文件预览失败，将仅按文件名排序"。
- **迁移夹具测试在 Windows 的环境兼容**：`migrationFixtures.test.ts` 的 Python 候选顺序改为 win32 下 `py` 优先，规避 Microsoft Store 的 `python` 应用执行别名 stub（exit 9009）导致的误失败。
- **续写 Canon 恢复与风格画像重复分析**：清理进程死亡后遗留的非 ready 风格画像，并复用匹配的 ready profile 槽位，避免重试/恢复路径触发 fingerprint UNIQUE；旧 ready 画像在新运行成功前保持可用。
- **超长无换行原著导入 OOM**：导入器改为分片累计并流式统计正文 hash、长度与段落，避免把超长逻辑行反复拼接成巨型 JS 字符串；50 MiB 单文件压力回归完成，无 OOM/ANR。
- **续写长测故障注入覆盖**：加入本地 mock OpenAI 兼容服务，覆盖 malformed JSON、慢响应、空响应、429/500 重试与超时场景，并完成 CAN-105/CAN-201 模拟器验收。

### Tests

- 新增 `__tests__/adaptiveBatchPlanner.test.ts`：覆盖小书打包、大窗口少批次/小窗口多批次、超大章节 chunk 切分（不丢内容）、20 章质量上限、chunk 字符数动态派生、配置不足友好报错带建议值、precheck 结构化估算。
- 新增 `__tests__/continuationImportErrorHandling.test.ts`：覆盖 errorCode 到用户文案映射与失败清单格式化。
- Android 模拟器长测：CAN-005 100K 单章四段连续 chunk、CAN-105 非法 JSON、CAN-201 强停恢复、PERF-001 50 MiB 导入与真实 DeepSeek 最终分析均通过；DeepSeek V4 Flash 以 1,000,000 上下文补测通过。完整门禁 `npm run verify` 已通过，Release APK 已签名并完成 16KB zipalign 验收。

## [2.11.7] - 2026-07-31

### Added

- **续写模式支持多 TXT 原著导入**：一次可选择多个 TXT 文件，合并为单一虚拟 source。多文件场景跳转 `ContinuationSourceOrderingScreen` 排序预览页，先采样每个文件头尾约 1500 字供 LLM 分析先后顺序；LLM 排序失败或未配置 LLM 时回退文件名排序；用户可在预览页上移/下移/移除文件后再导入。导入过程跨文件共享 normalizer/parser/hasher 状态，`chunkIndex` / `char_offset` / `position` 跨文件累加，章节 `position` 全局递增、`detected_title` 保留原文。
- **Schema 升级到 29**：`continuation_sources` 新增 `source_files_json` / `is_multi_file` / `file_count` 三列；`continuation_source_text_chunks` 与 `continuation_source_chapters` 新增 `file_index` 列仅作来源标记。`v28-to-v29` 迁移与 `createCurrentSchema` 镜像建表已同步，`schemaManifest` 列清单同步更新。

### Fixed

- **备份中心"一按备份就卡死"**：根因是 `listBackups` 对每个备份文件都跑一次完整 SHA-256 校验，叠加手写 SHA-256 让出事件循环频率过低（每 32KB 才让出一次）与低效的 `utf8Encode`（`number[]` 逐字节 push 动态扩容），导致 JS 线程长时间阻塞 UI。改为：`listBackups` 仅做轻量结构校验，SHA-256 校验延迟到 `restoreFromBackup`；SHA-256 让出频率提高到每 1KB；`utf8Encode` 预分配 `Uint8Array` 两遍扫描写入。同时修复 `readAndValidateBackup` 三元表达式两边相同的笔误（`parsed : parsed` → `parsed : null`）。
- **单文件原著导入 SQL 列数不匹配**：`continuationSourceRepository.insertSource` 的 `INSERT INTO continuation_sources` 语句 VALUES 占位符比列表少一个，导致 "22 values for 23 columns" 错误。补回缺失的 `?` 占位符，单文件导入恢复正常。

### Tests

- 新增 `__tests__/migrations-v28-v29.test.ts`：验证 v28→v29 五条 ALTER TABLE 语句与新列默认值/CHECK 约束。
- 新增 `__tests__/continuationOrderingService.test.ts`：覆盖 LLM 排序成功、LLM 调用失败回退文件名、LLM 返回不可解析回退文件名等场景。

## [2.11.6] - 2026-07-30

### Fixed

- **v26→v27 迁移彻底移除本地模型配置**：`llm_config` 仅保留 `provider_type='openai_compatible'` 的在线配置（id/base_url/api_key/model_name/is_active 等字段原样拷贝，确保 Keystore 中按 config id 存储的 API Key 仍可寻址）；历史 `llama_cpp` / `local_litertlm` 配置直接丢弃，不再转成空白占位。若升级后没有任何在线配置，自动种子一条激活的“默认配置”。配套 `__tests__/migrations/v26-to-v27.test.ts` 锁定 SQL 语义。
- **上下文自动化默认 1M tokens**：`ContextAutoConfigScreen` 默认输入与占位提示由 `200000` 调整为 `1000000`，与 1M 快捷预设一致，减少用户每次手动改大窗口。

### Tests

- 全量回归 `npm run verify`：ESLint 0 error、typecheck 通过、version 一致；Jest 191 suites / 1569 tests 通过（1 suite / 3 tests 既有 skip）。

## [2.11.5] - 2026-07-30

### Fixed

- **回归备份与 Schema 验证覆盖**：补回 `__tests__/backupService.test.ts` 与 `__tests__/schemaValidator.test.ts`，确保 V2.11.4 移除本地模型后，备份签名/恢复/校验路径与 `validateSchema` 仍满足覆盖率门禁（`backupService.ts` 84% statements / 70% branches / 87% lines；`schemaValidator.ts` 89/73/91）。
- **CHANGELOG 顶部格式**：V2.11.4 块改回 `[2.11.4]` 标准格式并拆分 `### Removed`，使 `npm run verify:version` 通过、CI 能严格校验版本头条目。
- **迁移测试锁定**：所有 `migrations-v20-v21` ~ `migrations-v25-v26` 用例的 `SCHEMA_VERSION` 期望同步到 27，避免回归测试错误绑死历史版本。
- **Schema 27 校验一致性**：`schemaValidator` 不再读取已移除的 `local_model_id` 字段，激活 LLM 校验收缩到“是否至少存在一条 `is_active=1` 配置”，避免误报的同时让 `schemaManifest.llm_config` 列清单与运行时校验一致。

## [2.11.4] - 2026-07-30

### Removed

- **“AI 写 N 章”批量生成**：移除入口与 `batchChapterPipeline` 执行管线，仅保留单章 AI 写作流水线。
- **本地 GGUF / llama.cpp 模型**：移除 `localModelStore`、原 `LlamaCppModule` JNI、`local_llm_models` 数据表与离线部署链路；备份不再包含本地模型外部资产，本地配置在升级后转为非激活的在线占位项。LLM 设置页同时移除本地 GGUF Tab，仅保留在线 API 管理。
- **Schema 升级到 27**：`v26-to-v27` 迁移脚本清空 `local_llm_models` 与 `continuation_import_jobs`（已在 Schema 26 末尾清理），并对历史 `provider_type='llama_cpp' | 'local_litertlm'` 的 `llm_config` 自动转为 `provider_type='openai_compatible'` 的安全占位（默认 `is_active=0`）。

All notable changes to ShineWriter are documented here. This file follows the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Version
numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.11.3] - 2026-07-30

### Added

- **章节编辑器底部"下一章"按钮**：大纲模式与原著续写模式共用 `ChapterEditor`，底部正文区下方新增主操作按钮 `下一章`（仅在当前章节正文非空时显示）。已有下一章（按 `position ASC, id ASC` 排序的下一条）时直接进入下一章编辑器；没有下一章时按项目模式创建新章节并进入——大纲沿用 `chapters.length`，续写用 `MAX(position)+1` 并接续原著边界标题（Spec §11.4）。导航用 `replace` 配合 `useUnsavedChangesGuard.bypassNextRemove`，Android 返回键直接回到章节列表而不污染章节编辑器栈。新增 `src/services/chapterNavigation.ts` 与 `__tests__/chapterNavigation.test.ts`（8 个用例覆盖大纲/freeform/续写三种模式）。
- **LLM 设置页按 Tab 分管配置**：在 `LLMSettingsScreen` 顶部新增 Tab 切换条（`在线 API` / `本地 GGUF`），把两类配置分开显示与管理：列表按当前 Tab 的 `provider_type` 过滤；新增配置预填当前 Tab 类型（本地 Tab 锁定 `cpu` 后端与 2048 上下文）；删除限制从全局"至少 1 个"改为"每类至少 1 个"，提示按类型区分；Header 仍显示全局 active 配置名，跨 Tab 可见。新增 `__tests__/llmSettingsScreen.test.tsx`（7 个用例覆盖默认 Tab、切 Tab 过滤、跨 Tab active、新增预填、删除限制等场景）。
- **世界书批量生成（BuildScreen）**：当世界书条目数 × 细节度所需 token 超过单次输出预留时，`planWorldbookBatches` 自动把世界书切分为多批，每批独立发起 LLM 调用并跨批主键去重。BuildScreen 通过 `onBatchProgress` 回调显示「第 X/Y 批 · 生成中…」进度，并统一每批 `max_tokens` 保证批次间能力一致；不可行时（输出预留过小）阻断生成而不是发一个必败的请求。新增 `src/services/construction/budget.ts` `WorldbookBatchPlan` 与 `__tests__/constructionBudget.test.ts`（138 行）。
- **Canon 分析输出预算翻倍**：完整原著分析 single-call profile 的输出基线翻倍——`standard` 16 384 → 32 768，`deep` 32 768 → 65 536 token，避免长输出被截断后重试浪费预算。
- **画风分析器 `style-v2-3`**：最高强度 V2 仿写规格延续，提示词与统计侧小幅增强；旧版 `style-v2-2` 仍然可注入。

### Changed

- **构造请求长超时**：`llm/requestPolicy` 新增 `constructionMs = 180s` 超时（默认 60s），避免长生成任务在慢模型上被误判超时。

### Fixed

- **世界书跨批去重空主键条目完全跳过**：`constructionAiGenerator` 新增 `entryDedupeKey` fallback——主触发词为空时回退到全部触发词拼接，再为空回退正文前 30 字符前缀，避免空主键条目在跨批去重阶段被完全跳过导致重复条目被采纳。
- **世界书分批说明注入不再硬编码 `messages[1]`**：`constructionAiGenerator` 改为倒序查找最后一条 `user` message，兼容未来 system/user 结构变更（例如多 system 提示或插入 user 澄清轮次）。
- **Canon deep 档在线模型诊断**：`canonAnalysisService.planAnalysisTokenBudget` 在在线模型未配置 `context_window` 时输出 `console.warn`（不拒绝，运行时由 provider clamp + `finish_reason=length` 兜底），便于诊断"成功但被截断"的根因。
- **AGP 9.x 构建失败**：`android/app/build.gradle` 在 `extractNativeLibs="true"` 下补 `packagingOptions { jniLibs { useLegacyPackaging = true } }`，避免 `:app:packageDebug` 失败。保留 `extractNativeLibs=true` 是为 TurboModule + llama.cpp JNI 减少安装期 .so 抽压 IO。

### Tests

- 新增 `__tests__/constructionBudget.test.ts`：覆盖 `planWorldbookBatches` 的边界（不需要分批 / 阈值触发 / 不可行 / 均匀分配 / 每批 max_tokens 取最大批的目标）。
- 新增 `__tests__/constructionAiGenerator.test.ts` 161 行，覆盖 `generateWorldbookInBatches` 的单/批路径、跨批去重（含 fallback）、分批进度回调、批说明注入位置倒序查找。
- 新增 `__tests__/continuationStateOutboxWorker.test.ts` 514 行，强化续写 outbox 排空逻辑。
- 同步 `__tests__/canonLlmAnalysis.test.ts` / `__tests__/canonAnalysisTokenBudget.test.ts` / `__tests__/styleAnalysisPrompt.test.ts` 与新的 baseline / `style-v2-3`。

## [2.11.2] - 2026-07-30

### Fixed

- **完整原著分析自动衔接风格分析**：移除 `processAnalysisRunInner` 在 Canon 批次收尾后的过早 `state='awaiting_review'` 终态提交。批量校验与 evidence_validation 之后、风格分析尚未启动时，run 继续保留 `state='running'`，避免 `awaiting_review` 与错误的 `completedAt` 提前使 `pauseInterruptedRuns` 漏救、`isResumableAnalysisState` 拒绝继续以及概览页误显“审核并启用”按钮。
- **概览状态文案覆盖风格分析阶段**：`runStatusLabel` 补齐 `state='running'` 下的 `style_analysis`（“正在分析原著写作风格”）与 `style_validation`（“正在校验风格画像”），避免 S2 之后再次出现“分析中但显示正在汇总结果”。

### Tests

- 新增 `__tests__/canonAnalysisStylePipeline.test.ts`：在 `processAnalysisRun` 编排下断言 `runStyleAnalysis` → `activateSnapshotAndStyleProfile` 的调用顺序、最终由原子激活写入 `state='completed'`，并锁定不应再出现 `state='awaiting_review'` 写入或 `completedAt` 提前设定。
- 扩展 `__tests__/canonRunStatusLabel.test.ts` 与 `__tests__/canonAnalysisOverviewStatus.test.tsx`，新增 `style_analysis` / `style_validation` 文案用例并保留 `finalizing` 既有断言。

## [2.11.1] - 2026-07-30

### Changed

- **原著高仿续写**：原著画风改为续写的强制严格约束，不再提供关闭/平衡/严格的用户开关，也不再允许跳过画风分析；没有可注入且已启用的画像会阻断续写并引导完成分析。
- **高强度画风画像**：风格分析提示升级为最高强度仿写规格，要求以句段、语气、词汇、人物口吻、叙事节奏五个维度给出带范围、触发场景和禁忌的具体指令；分析器升级为 `style-v2-2`，旧版画像自动过期且无法继续注入。
- **风格启用闭环**：单独重试风格分析成功后会原子地成为当前注入画像；对于历史“已生成但未启用”的画像，分析概览提供“启用原著风格”操作。
- **底部创作路径**：两种项目模式的底栏统一为“1 项目 → 2 资料/续写资料 → 3 写作/续写 → 构建 → 设置”，前三步间显示箭头提示。

### Fixed

- 上下文资料分配中候选和已选均为 0 的类别不再误报“已裁剪”，改为显示“暂无内容”；真正发生裁剪时仍明确标注。
- **续写上下文审计**：最近续写被最新接缝完整覆盖时明确显示“接缝覆盖”，不再误报预算裁剪；规划与正文统一注入完整 Canon 事实，过滤 Canon 基线、剧情线与同事实时间线的重复注入。

## [2.11.0] - 2026-07-30

### Added

- **原著写作风格（Schema 26）**：Canon 章节分析成功后、激活快照前增加独立 `style_analysis` 阶段，产出可版本化、可审核的 V2 风格画像。
- **文风约束配置**：续写生成配置支持独立文风约束（后续版本已收敛为原著画风强制严格遵循）。
- **动态风格注入**：Context 只读缓存画像，不隐式触发风格 LLM；按阶段窗口动态预算，Planner/Writer/Checker/Repair 分级注入；上下文预览展示「原著风格画像」级别、token 与降级原因，并区分 Planner / Writer 请求。
- **续写章节显示编号**：用户可见章节号接续原著边界（边界第 20 章 → 首篇续写「第 21 章」）；内部 `ContinuationChapterPosition` 不变。

### Changed

- 分析概览增加「原著写作风格」卡片（未分析 / 分析中 / 失败 / 就绪 / 过期 / 已忽略）。
- 激活 Canon 与风格画像改为原子路径（`activateSnapshotAndStyleProfile`），UI 显式传递 `styleProfileId` / `allowStyleSkip`。
- **续写结果体验统一**：续写完成页改为与普通流水线一致的折叠阶段卡片与“放弃 / 采纳”操作；正文不再在结果页直接铺满。触发严重一致性问题后的自动修复会明确标注轮次和“采纳将写入修复稿”。
- **上下文预览中文化**：续写资料分配将内部字段和计量单位转换为中文业务名称，例如“用户锁定规则”“续写接缝（紧接上一章）”和“词元”。

### Fixed

- **1M 上下文同步**：在上下文自动化配置应用方案后立即刷新 LLM 设置状态，LLM 设置页会显示新的上下文长度与最大输出 token。
- **顺序续写接缝**：续写下一章时优先使用已采纳续写章节的章末作为接缝锚点，不再把原著最后一章错误拼接到后续每一章。

### Tests

- 风格统计/抽样/V2 schema、分析服务、原子激活、动态注入、章节编号与 `continuationStyleIntegration` 集成测试；轻量 Maestro `12-continuation-style-overview.yaml`。
- 续写结果页折叠/采纳、自动修复提示、顺序接缝与 1M 上下文同步回归；Android 模拟器连续生成并采纳第 4、5、6 章。

## [2.10.7] - 2026-07-29

### Changed

- **续写长上下文预算**：续写快照改为按实际 Planner / Writer 模型窗口的较小值分配输入，输出预留按 Writer 上限和受限比例计算；原著接缝、Canon、最近续写桥接、长期 Story Memory、章节事件摘要和外部补充分别受控预算与上限，不再沿用固定 400 token 接缝与 5×500 token 前文。
- **前文承接与长期记忆**：原著接缝、最近续写正文均从章末优先裁取；后续章节同时使用目标位置之前的 clean Story Memory、与本章相关的章节事件摘要和最近正文桥接。dirty、failed、同章或未来检查点不注入。
- **续写定稿闭环**：定稿事务除状态提取外同步排队依赖型 Story Memory 重建；即使状态提取没有 proposal，已定稿正文也会进入章节摘要与长期记忆。proposal 审核仍独立维护权威续写状态，确认后会触发再次重建。
- **提示与预览可读性**：Planner/Writer 补齐关系、知识边界与人物经历状态；上下文预览标明“实际请求”与“资料分配”，避免把 system/user 提示误解为额外原文上下文。

### Tests

- 新增 1M 窗口预算增长、章末裁取、依赖 outbox 顺序和 Planner/Writer 续写记忆注入的回归覆盖。

## [2.10.6] - 2026-07-29

### Added

- **续写模式边界**：作品库按「大纲创作 / 原著续写」分组，续写项目进入独立工作台；底部入口随当前项目切换为「续写 / 补充 / 续写资料」，避免误把普通大纲流程当作续写流程。
- **Schema 25 外部补充绑定**：新增 `continuation_resource_bindings`。角色卡、世界书、笔记和预设默认不进入续写，只有项目已关联且明确标为 `external_supplement` 的资料才可注入；原著镜像与不参与资料被明确排除。
- **真实续写上下文预览**：章节编辑的上下文页会按续写生成器的真实 Canon、状态、历史与外部补充预算组装，并显示各组已选、裁剪和排除情况。

### Changed

- **资料库提示与交互**：续写项目下的角色卡、世界书、笔记、预设均提示「原著信息已由 Canon 自动调度」，并可为每项资料设置续写用途，避免对原著重复引用，同时仍支持补充原著之外的信息。
- **续写提示词优先级**：外部补充被明确标为低于锁定 Canon 事实、边界与当前状态的受控信息源，不能覆盖原著约束。

## [2.10.5] - 2026-07-29

### Fixed

- **完整原著 Canon 分析**：保留模型思考能力，按已配置上下文容量分段深挖全部原著，不再固定截断章节正文；空响应、字段别名和近义证据会安全诊断、归一化与定位，避免“成功但资料为空”。
- **默认采纳与中文进度**：成功快照自动成为当前原著资料；分析概览全程使用中文终态文案，不再把已完成任务显示成“待审核激活”或“正在汇总结果”。
- **人物统一关联与剧情四要素**：同一快照内正式名和唯一别名解析到统一人物 ID；关系、经历、知识、状态和剧情人物关联均防止孤儿 ID。剧情/时间线保留时间、地点、人物、事件，原文未说明的时间不猜测。
- **续写事实复核与历史概览**：FULL 续写的复核和定向修复同时读取八类 Canon 事实及证据编号；历史概览支持后台保活、进度展示和覆盖范围说明。

### Verified

- Android 17 x86_64 真机回归：299 章完整分析 `30/30` 成功并自动启用；世界观 30、人物 160、关系 64、剧情 54、经历 52，关联完整性审计无孤儿 ID。

## [2.10.4] - 2026-07-28

### Changed

- **第三期历史记忆**：新增历史章节摘要、摘要章节映射与本地候选索引；摘要明确为非 Canon 弱参考，只有命中用户关键词时才进入续写上下文，源或续写边界变化会自动过期。
- **Schema 24**：新增 `continuation_historical_digests`、`continuation_historical_digest_chapters`、`continuation_historical_index_terms`，纳入备份与恢复顺序。
- **原著 Canon 两组请求协议**：新建分析任务每个章节批次改为「人物与状态」和「世界观与剧情」两次 LLM 请求，完整保留人物、关系、经历、知识、状态、世界规则、剧情和时间线字段；旧任务仍按原五类请求恢复，不会丢失已完成进度。
- **Schema 23**：`continuation_analysis_work_items` 的可选请求类型扩展为两组新协议，升级时会原样迁移 Schema 22 的五类工作项。

## [2.10.3] - 2026-07-28

### Fixed

- **原著分析取消后可继续**：取消不再丢弃已经完成的批次或资料项。分析概览和任务列表均提供「从已取消进度继续」，只重新排队未完成项；意外退出后残留的运行中批次/资料项在冷启动时也会安全转为可继续队列。
- **非标准模型 JSON 兼容**：除 Markdown 和前后缀外，现可识别部分 OpenAI 兼容网关对 JSON 内容的双重编码；自动重试会明确要求模型重新生成完整 Canon schema，减少重复返回无效格式导致的失败。

### Tests

- 新增已取消任务可继续、未完成项重排队、双重 JSON 编码和重试纠错提示回归测试。
- Android 17 x86_64 模拟器：299 章 / 1,033,681 字符 TXT 的 Quick 分析冷启动恢复、继续、取消、从取消进度继续并完成 500/500 均通过，无 JS 或原生崩溃。

## [2.10.2] - 2026-07-28

### Fixed

- **原著分析模型输出恢复**：空响应、带说明文字或 Markdown 代码围栏的结构化响应会安全提取 JSON 并最多重试三次；只有连续失败后才将对应资料项标记为失败，并提示具体资料类型和模型 JSON 能力检查方向。
- **原著分析任务进度固化可见**：分析任务页现在读取已持久化的工作项，按五类资料与批次展示完成、待处理、失败、错误和尝试次数；运行中自动刷新，返回页面或进程中断后已完成进度仍可查看，重试只处理未完成项。

### Tests

- 新增带前后缀/多 JSON 对象、JSON 字符串内花括号的解析回归测试，以及空响应和无效 JSON 自动重试测试。

## [2.10.1] - 2026-07-28

### Fixed

- **原著分析调度可靠性**：Canon 长上下文请求从五路并发收敛为全局两路；单项请求使用三分钟超时，并对 429、5xx、网络波动和超时最多进行三次指数退避重试，降低服务排队或限流时留下零散失败项的概率。
- **分析概览可读性与断点继续**：最近分析任务改为世界观、人物画像、人物关系、主线剧情、人物经历五条汇总进度条，不再逐批堆叠状态文本；暂停后提供明确的「继续」入口，失败时仅重试未完成项，已完成项复用持久化结果。

### Tests

- 新增 Canon 请求限流、三分钟超时策略和 429 自动重试回归测试。

## [2.10.0] - 2026-07-28

### Added

- **原著分析可见进度与后台保活**：Standard / Deep Canon 分析现在把每个原著章节批次拆为世界观、人物画像、人物关系、主线剧情、人物经历五项可见工作；资料 > 续写 > 分析概览会实时显示确定型进度条、批次与资料类型状态，并支持暂停、取消和继续。
- **Schema 22**：新增 `continuation_analysis_work_items`，持久化五类资料的请求状态、结果和错误；升级时为既有分析批次补齐工作项，任务恢复只重跑未完成或失败的资料项。
- **五路并行 Canon 请求**：远程 OpenAI 兼容模型使用独立 `canon_analysis` 队列，单个批次最多并行五个资料请求；本地 llama.cpp 保持单路执行，避免显存竞争。
- **后台任务通知**：复用 Android 前台服务和 WakeLock，在锁屏/切换 App 时保持分析；完成通知可直接跳到资料 > 分析任务。

### Tests

- 新增 Schema 21→22 迁移、备份 manifest 与 fresh schema 对齐测试；新增五路 Canon 队列并发和资料请求隔离测试。

## [2.9.3] - 2026-07-28

### Fixed

- **续写 TXT 中文文件名导入**：Android 文件选择器返回的本地 `file://` URI 会对中文等非 ASCII 文件名进行百分号编码；导入前现在会统一还原为真实文件系统路径，原生 TXT 读取模块不再把 `%E7...` 当作文件名的一部分而误报“无法读取所选文件”。
- **共享导入路径**：同一 URI 还原逻辑同步用于资料库单个/批量导入和项目包导入，避免中文文件名在其他本地导入入口出现同类读取失败。

### Tests

- 新增 URL 编码中文文件名、ASCII 文件名和异常百分号转义的路径还原单元测试。
- Android API 37 模拟器使用桌面原文件《白篱梦》作者：希行.txt 实测：修复前稳定复现读取失败；修复后同一中文文件名成功解析 299 章、UTF-8。

## [2.9.2] - 2026-07-28

### Fixed

- **续写采纳事务**：SQLite 原生异步 `executeSql` 回调现在正确传递受影响行数；章节乐观锁冲突不会再把 run 误记为已采纳，用户可重新采纳。
- **状态同步恢复**：用户对耗尽自动重试额度的 outbox 执行手动重试时，会重置连续重试计数并真正重新进入 worker。
- **上下文失效治理**：激活 Canon、修订/新增/批量确认 Canon 记录都会使使用旧 Canon 的进行中续写失效；恢复中断 run 不会隐式确认待确认计划。
- **原著激活一致性**：原著 source 激活、边界切换、旧 run 失效与 import job 完成状态合并为同一个 SQLite 事务。

### Tests

- 新增原生异步事务回调、耗尽 outbox 人工重试、source 激活 job 原子完成和章节采纳冲突可重试的回归测试。
- `npm run verify`、`npm run test:coverage` 通过；Android API 37 模拟器安装 Debug APK 后冷启动、Schema 21 初始化、普通项目隔离与原著续写项目的 TXT 导入入口均通过，无原生/JS 崩溃。

## [2.9.1] - 2026-07-28

### Fixed

- **首次安装可靠性**：修复 Schema 19→20 建表中 Canon 表约束先于专属列导致 SQLite `near "category"` 失败；同一空白首次安装若已留下基础表但尚无用户项目，现在会安全、幂等地补齐 current schema，旧的含用户数据 Schema 0 仍严格拒绝升级。
- **续写产品接线**：`ContinuationSourceChaptersScreen` 已接入 Android 文件选择、`keepLocalCopy`、解析预览和确认激活；返回续写首页时用 focus reload 刷新已导入状态，不再显示过期的导入入口。
- **Phase 3 收尾**：按配置 id 解析模型配置；章节采纳创建 revision；续写章节的改写/删除会使有效状态与 Story Memory 失效；定稿 outbox 在冷启动和定稿后实际执行并触发完整 Story Memory 重建，proposal 确认保持单事务。

### Tests

- 新增 Schema 19→20 Canon 建表顺序回归、首次安装中断恢复与含用户项目 Schema 0 拒绝测试。
- Android API 37 模拟器实际通过：续写项目创建、TXT 选择/解析/导入、边界持久化重启、离线 Standard Canon 分析与激活、章节定稿和状态同步 outbox；未配置 API 的 AI 续写受明确配置门保护。

## [2.9.0] - 2026-07-27

### Added — 原著续写 Phase 3（Canon 驱动 AI 续写闭环）

- **Schema 21**：`continuation_generation_settings`、`continuation_generation_runs`（`ct_` id）、`continuation_generation_artifacts`、`continuation_plans`、`continuation_check_results`、`continuation_state_proposals` / `continuation_state_events`、`continuation_entities` / aliases、`continuation_state_sync_outbox`、`continuation_style_profiles`；全部 `backup:true`，format v3。
- **独立 continuation runner**：阶段 `context → planner → writer → checker → repair → awaiting_user`，不修改 freeform `draft/review/factCheck/proof` 语义；共享冻结 Context snapshot；每阶段模型路由可独立配置。
- **Context Builder**：经 bounded SourceReader + active `CanonQueryService` + Effective State 融合；禁止隐式 Story Memory LLM；token 预算与 capability 门禁（strict/balanced/loose）。
- **Checker / Repair**：八类连续性检查，证据绑定与 UTF-16 半开定位；局部修复与旧 check obsolete。
- **采纳 / 定稿 / 状态回灌**：采纳只写章节草稿；定稿插入 `extract_state` outbox；确认 proposal 原子写 event + dirty + rebuild outbox；**禁止在 SQLite 事务内调用 LLM**。
- **UI**：续写入口文案「AI 续写」；`ContinuationResultScreen`；通知深链 `ct_` 优先；冷启动将 running run/outbox 标 interrupted。
- **E2E**：`09/10/11-continuation-*.yaml`；连续 30 章验收用例。

### Tests

- Phase 3 核心/管线契约、Schema 20→21、迁移矩阵 3..20→21。

## [2.8.0] - 2026-07-27

### Added — 原著续写 Phase 2（Canon 分析与 Active Snapshot）

- **Schema 20**：`continuation_canon_snapshots`（含每项目至多一个 `ready` partial unique index）、`continuation_analysis_runs` / `continuation_analysis_batches`、`canon_evidence` / `canon_evidence_links`、五类 Canon 表（世界观/人物/关系/剧情/经历）+ 别名/状态/知识/时间线/剧情参与关联；`continuation_settings.active_canon_snapshot_id` 作为 Phase 3 唯一可读入口。
- **分析管线**：Quick/Standard/Deep 档位；snapshot 绑定 Phase 1 source id/version/hash/parser/normalizer/boundary；批次幂等键、冷启动 pause、证据校验、future leakage 阻断；默认确定性提取器（CI/离线）+ 可选 LLM 提取（本地 Schema 校验）。
- **Active Snapshot 发布**：staging → awaiting_review → 用户激活事务（旧 ready→outdated、指针切换、`analysis_status=ready`）；未激活 run 不污染 Phase 3。
- **人工治理**：确认/锁定/忽略/revision supersede；审核操作递增 snapshot revision。
- **CanonQueryService**：Phase 3 唯一查询入口；`snapshotId+revision` 校验、位置不超过 boundary、默认排除 ignored/superseded；`getContextBundle` 支持 strict/balanced/loose 与 token 预算裁剪。
- **UI**：资料 > 续写 > 原著分析概览 + 五类资料列表 + 分析任务；可查看证据预览。
- **失效**：边界/源变更清空 `active_canon_snapshot_id` 并将 snapshot/run 标 outdated。

### Tests

- future leakage 阻断用例、实体消歧、JSON 校验、Query Service 契约、Schema 19→20 与迁移矩阵 3..19→20。

## [2.7.0] - 2026-07-27

### Added — 原著续写 Phase 1（数据与产品底座）

- **项目模式扩展**：新增 `continuation`（原著续写）模式，新建项目可选择「大纲创作」或「原著续写」；历史 `freeform` 项目保持兼容，可继续打开。`normalizeProjectMode()` 在写入边界统一校验，未知模式被阻断。
- **Schema 19**：新增 5 张续写表（`continuation_sources`、`continuation_source_text_chunks`、`continuation_source_chapters`、`continuation_settings`、`continuation_import_jobs`），含 partial unique index（每项目最多一个 ready source / 一个活跃导入任务）、composite foreign key 与完整 CHECK 约束。
- **TXT 原著导入**：Android 原生 `ContinuationTextImportModule` 分块解码 UTF-8/UTF-8 BOM/GBK/GB18030/UTF-16 LE/BE，处理多字节跨块边界；规范化层去除 BOM/NUL/控制字符、统一换行，记录 `normalization_version`；解析器识别中文章节（第 N 章/节/回、卷）、英文 Chapter、`正文 第一章` 前缀，拒绝正文误识别，无标题时回退整篇。
- **可恢复导入任务**：导入任务支持 queued/running/paused/awaiting_review/completed/failed/cancelled/interrupted 状态机；App 重启后 `recoverInterruptedJobs` 将遗留活跃任务转为 interrupted，用户可继续/重来/取消。
- **续写边界与未来原文防护**：`ContinuationSourceReader` 提供 bounded API（`listBoundedSourceChapters` / `readBoundedEvidenceRange`），每次调用在同一事务校验 snapshot（source id/version/hash/parser/normalizer/boundary），过期抛 `continuation_source_snapshot_outdated`；自定义边界落在章节中间时末章被物理裁剪。`ContinuationSourceBrowserService` 作为 UI-only 的未来原文浏览出口，禁止 canon/generation 模块导入。
- **资料模块重构**：底部「资料」改为 `ResourceStack`（续写/角色/世界书/笔记/预设），不再新增底部主 Tab。
- **备份与项目包**：4 张业务表进入备份（import_jobs 为首张 `backup:false`）；continuation 项目导出为 `shinewriter-project-v3`，携带 source/chunks/chapters/settings；v3 导入前校验 chunk 连续性、per-chunk SHA-256、总字符数与外键，失败回滚整个项目；v1/v2 包继续兼容。
- **Phase 2 交接契约**：`ContinuationSourceSnapshot` + `ContinuationSourceReader` 接口固定，Phase 2 只能通过公开 service 获取 boundary 内原著章节。

### Changed

- 新建项目选择器不再展示「自由写作」（历史项目仍可打开）。
- `schemaValidator` 跳过 `backup:false` 表的 MISSING_TABLE 检查，避免恢复后误报。
- 迁移测试 harness 支持 `CREATE UNIQUE INDEX`（partial index）。

### Tests

- 新增 115+ 测试覆盖：项目模式、branded offset/UTF-16、bounded reader 不变量、chunk 连续性、解析器（含 30 章夹具）、edit log、导入服务 helper、设置/边界服务、项目包 v3、ResourceHome UI。
- 全量 1222 测试通过；迁移矩阵覆盖 Schema 3–18 → 19。

## [2.6.6] - 2026-07-26

### Fixed

- **构建结果不再因质量目标被整份丢弃**：角色卡 / 世界书通过 JSON 结构、必填字段和现有导入回读校验后，即使模型未达到所选档位的 Token 或字段长度目标，也会保留到预览并显示差距与补强项，用户仍可保存或导入。截断、无效 JSON、缺少必填结构和不可导入产物继续硬阻断；不会静默发起第二次收费请求。

## [2.6.5] - 2026-07-26

### Added

- **构建生成规模与质量控制**：角色卡、世界书新增紧凑 / 丰满 / 深度三档；预算同时计算可见产物的最低生成 Token，默认「丰满」档。角色卡按身份、经历、关系、目标、恐惧、秘密、矛盾、场景、开场和多轮示例对话生成并验收；世界书按条目正文长度、总常驻内容和条目数量验收。
- **TXT 素材构建**：支持 UTF-8、UTF-16 LE/BE TXT，按标题与段落解析为可选择片段；可直接生成角色卡或世界书。仅在点击生成时发送所选文本，不保存来源路径、不写入资料库或备份。

### Changed

- **世界书常驻不变量**：构建世界书的提示词、解析和质量校验均强制所有条目 `constant: true`；预览显示「全部常驻」与估算常驻内容。
- **失败可恢复性**：构建请求失败后保留可操作错误卡片；API 401 会明确引导用户更新 Key 并用「保存并测试」验证连接。
- **边界质量稳定性**：世界书提示词要求在正文验收下限上预留 15% 余量，避免模型输出贴线而被质量校验拒绝。

### Tests

- 新增构建质量、TXT 解析、预算和界面恢复测试；Android x86_64 模拟器已验证 DeepSeek 连接、丰满角色卡预览和 4 条常驻世界书预览。

## [2.6.4] - 2026-07-25

### Added

- **构建产物一键导入资料库**：预览页新增「导入资料库」按钮。角色卡 / 世界书序列化为与资料库相同的 `chara_card_v3` / `lorebook_v3` JSON 后，复用既有导入链路写入 SQLite，并按当前项目启用（角色卡落入默认合集，世界书新建合集 + 条目）。仍保留「保存到手机」；无当前项目时拦截并提示先在「项目」中选择。

### Tests

- `importConstructionArtifactToLibrary` 单元测试；BuildScreen 导入成功 / 无项目拦截用例。

## [2.6.3] - 2026-07-25

### Changed

- **世界书默认常驻（构建 / 导入 / 启用）**：
  1. 「构建」模块生成的世界书条目强制 `constant: true`，提示词与解析均按整本常驻输出。
  2. 资料库导入世界书默认常驻；仅源文件显式 `constant: false/0` 时保留非常驻。
  3. 项目侧打开世界书合集或单条「当前项目使用」时，后端同步将对应条目 `constant=1`。
  4. 新建世界书条目默认常驻。

### Tests

- 构建产物全常驻、导入默认常驻 / 显式 false 保留、启用子条目写 constant 的单元测试覆盖。

## [2.6.2] - 2026-07-25

### Fixed

- **世界书写作上下文真正可用**：
  1. **空章 / 无关键词命中兜底**：章节标题、概要、正文均不含触发词且无常驻条目时，项目已启用的世界书会以「项目启用兜底」注入，避免「资料库已开、初稿却像空白世界」。有关键词命中时仍保持选择性注入。
  2. **多触发词完整保留**：导入 / 构建世界书时，`keys` 数组的全部主触发词写入 `keyword_primary`（逗号分隔），不再只保留 `keys[0]` 并把别称误塞进次关键词。
  3. **生成指令参与扫描**：`retrievalUserPrompt`（章节生成指令）纳入世界书扫描文本，空章开写时也能靠概要复述命中触发词。
  4. **新建合集同步项目开关**：在当前项目新建世界书合集时立即写入 `project_collection_settings`，避免 UI 仅靠默认值显示“开启”却与写入侧不一致。

### Tests

- 单元测试：无关键词命中时兜底注入、别称主关键词命中、lorebook 多 keys 导入字段；相关文件导入与写作上下文用例全量通过。

## [2.6.1] - 2026-07-25

### Fixed

- **世界书条目读取侧对齐角色卡**：上下文查询此前额外叠了一层条目全局 `enabled` 硬过滤，导致导入带禁用标记的世界书条目、或在条目编辑器里关闭过启用的条目，即使项目级合集与条目均已启用，仍被排除在章节上下文、初稿与各审核阶段之外。现在世界书与角色卡一致，仅由项目级开关决定是否参与；合集级与条目级的项目开关成为唯一仲裁。条目编辑器中语义混淆的「条目启用」开关同步移除，统一收敛到列表项的「当前项目使用」。

### Tests

- 单元测试覆盖：条目全局 `enabled=0` 时仍可进入上下文、合集项目级关闭时仍被过滤；既有世界书激活与角色卡上下文用例全量回归通过。

## [2.6.0] - 2026-07-25

### Fixed

- **写作上下文与流水线回归发布**：世界书合集开启后，常驻子条目会进入章节上下文、初稿、审阅、事实核查和终审；流水线审核阶段结果保持结构化且可查看。

### Tests

- Android x86_64 模拟器：新建六章项目；验证新项目资料默认关闭、世界书合集开启级联子条目、章节上下文预览包含常驻世界书；完整四阶段流水线（初稿、审阅、事实核查、终审）成功且审核 JSON 非空；定稿后手动整理长期记忆至第 6 章，状态正常、覆盖完整。

## [2.5.24] - 2026-07-25

### Fixed

- **世界书子条目启用被父合集过滤**：新项目会先关闭已有资料；此前用户随后单独启用或新建世界书条目时，子条目的“当前项目使用”虽显示为开启，但关闭的项目级父合集仍会让上下文查询排除它。现在启用世界书子条目会原子地同步开启其所属项目合集，不会级联改变兄弟条目。

### Tests

- Android x86_64 模拟器复现并验证：父合集关闭 → 单独开启常驻子条目 → 父合集自动开启 → 章节上下文预览显示世界书条目“已包含”。

## [2.5.23] - 2026-07-25

### Fixed

- **写作资料上下文刷新**：新项目显式为已有角色卡、世界书、笔记和预设创建项目级关闭状态；随后在写作过程中启用或新增的资料会按当前项目开关参与后续章节的上下文预览与生成。
- **世界书合集级联开关**：打开合集会启用其全部条目，关闭合集会停用全部条目；用户仍可按条目关闭不需要的资料。
- **流水线上下文与审阅结果持久化**：审阅、事实核查和校对统一获得其应使用的预设、角色、世界书、笔记、故事记忆和章节上下文；同一任务的 SQLite 快照写入按顺序串行，避免较早的空审核状态覆盖已成功的实时审核结果。

### Tests

- 新增新项目资料关闭、世界书父子级联、写作中新增世界书后上下文预览、流水线完整上下文映射及审核结果持久化竞态回归测试。
- Android x86_64 模拟器验证：已有资料的新项目默认关闭、世界书父开关关闭/重开同步子条目、章节上下文预览包含新建常驻世界书条目。

## [2.5.22] - 2026-07-25

### Added

- **「构建」模块**：底部导航新增第五个 Tab「构建」（顺序：项目｜写作｜构建｜资料｜设置）。用当前在线 OpenAI 兼容 LLM 独立生成可移植的角色卡（`chara_card_v3`）与多条目世界书合集（`lorebook_v3`），支持三种模式：独立构建、基于手机里的世界书 JSON 构建角色卡、基于角色卡 JSON/PNG 构建世界书。每次构建提供 1%–15%（默认 5%）的输出预留滑块，按 `C / M / S` 公式计算输出预留与来源上下文预算，并受 `max_output_tokens` 限制；来源超预算、输出预留不足、模型返回无效 JSON、取消生成或取消保存均不产出文件或写入资料库。世界书默认 6 条（2–12 可调），生成后用现有资料库导入解析器回读校验；角色卡 / 世界书经 Android 系统保存窗口写入用户选择的手机目录，须在「资料」手动导入并启用后才参与写作。首版仅支持在线模型，本地 llama.cpp 配置会被明确拦截并引导前往 LLM 设置。
- 新增服务：`src/services/construction/budget.ts`（预算纯函数）、`src/services/construction/targets.ts`（共享类型）、`src/services/constructionAiGenerator.ts`（提示词 / 解析 / 回读校验）、`src/services/constructionFileService.ts`（序列化与系统保存封装）、`src/components/ConstructionSlider.tsx`（无原生依赖的自研滑块）、`src/screens/BuildScreen.tsx`（构建流程 UI）。
- `fileImport` 新增 `pickSourceFile` 公共方法，供构建模块模式二 / 模式三一次性读取来源文件，不写入资料库。

### Changed

- **资料库 AI 生成入口下线**：移除「资料」模块中角色卡与世界书条目的「AI 一键生成」按钮、提示词弹窗与回填逻辑（删除 `src/services/resourceAiGenerator.ts`）；手工维护、导入导出与合集管理保持不变。AI 生成能力统一收敛到「构建」模块，且不再直接回填资料库。
- 底部导航由 4 Tab 增至 5 Tab，新增「构建」Tab（`Hammer` 图标）。
- 公共 `Button` 组件新增可选 `testID` 属性。

### Tests

- 新增 `constructionBudget`（预算公式 / 安全余量 / 最低预留 / 可生成性 / M 与上下文上限）、`constructionAiGenerator`（四种模式提示词与场景、角色卡 v3 封装、世界书条目数与重复主触发词、无效 JSON、空返回、取消信号透传、Token 估算）、`constructionFileService`（命名与非法字符、保存成功、用户取消不报成功、真实错误抛出）、`BuildScreen`（在线 LLM 前置校验与前往设置、三模式生成与预览、取消生成、无效 JSON、来源格式错误、取消保存不报成功、保存成功提示、默认预算展示）与资料库 AI 入口已删除的回归测试。
- 穿越回归（V2.5.22 Debug）：在线 LLM 前置校验（本地 llama.cpp / 配置不完整被拦截并引导设置）、预算公式实测一致、输出预留不足拦截（提示提高预留比例）、自研滑块首次点击精确设值（硬化后不再跳到最大值）、模型输出长度截断检测（不静默返回半成品）、资料库「AI 一键生成」入口已确认下线、深色主题切换、项目 CRUD、章节编辑器加载。结论：未发现代码缺陷。

## [2.5.21] - 2026-07-24

### Fixed

- **父合集开关展示与持久化一致性**：角色 / 世界书 / 笔记合集的「合集启用」开关改为只读 `project_collection_settings`（默认开启），不再用子资料 `project_resources` 聚合结果推导。修复跨项目查看时开关被显示为关闭、再次打开后仍弹回关闭的问题；空合集与全部子项停用时父开关也能正确保持。
- **AI 生成提示词框滚动**：资料库 AI 一键生成弹窗的提示词输入框显式启用 `scrollEnabled`，配合高度上限，长提示词可在框内滚动且不把按钮顶出屏幕。

### Tests

- 新增合集列表 SQL 契约：`enabled_for_project` 必须来自 `COALESCE(pcs.enabled, 1)`，禁止再 join/SUM 子资源启用状态。
- Android 模拟器穿越回归：首启 Schema 18、双项目、合集开关、AI 弹窗、章节编辑器、默认预设、笔记/世界书入口。

## [2.5.20] - 2026-07-23

### Fixed

- **项目资料合集状态完整性**：角色、世界书和笔记的项目级父合集开关改为独立持久化；关闭父级不再批量覆盖子资料的启用状态，空合集状态也可在项目间独立保存。项目上下文查询会统一排除被关闭的父合集。
- **资料库项目切换竞争**：资料库异步加载增加请求代次保护，项目 A 的迟到结果不能覆盖已切换到项目 B 的页面状态。
- **并发流水线通知归属**：前台服务按任务保存标题、阶段和进度，任务 A 的阶段更新不会再借用任务 B 的标题。

### Added

- Schema 升级至 18，新增 `project_collection_settings` 并纳入备份/恢复 manifest，承载项目级父合集开关。

### Tests

- 新增 v17→v18 执行型迁移、父合集状态写入契约和项目资料查询过滤回归；定向回归 36 tests 通过。

## [2.5.19] - 2026-07-23

### Fixed

- **流水线取消可靠性**：用户停止流水线后，即使底层 LLM 请求在 abort 后晚到返回，也会在每次响应落地前重新检查取消状态，不再写入后续阶段、启动终审或把任务标为完成。取消标记持续到整条任务结束才释放。

### Tests

- 新增晚到 LLM 响应取消回归：取消后草稿请求才返回时，审核、终审和完成状态均不得发生。
- Android 模拟器 `slow_response` 回归：点击停止后等待超过原先 91 秒复现窗口，Mock 调用保持 `draft=1 / review=0 / proof=0`，页面停留在章节编辑器。

## [2.5.18] - 2026-07-23

### Fixed

- **故事主线记忆可靠性**：主线抽取 Prompt 明确覆盖当前剧情弧、目标、冲突、未解线索和伏笔；章节摘要与主线补丁交叉校验，避免“章节发生主线变化但五项全空”写入。补全剧情弧替换、目标清空、冲突解决归档和伏笔支付生命周期；故事记忆页在长篇无活跃/无历史主线时给出诊断，而非笼统显示“无”。
- **新建项目预设可用性**：项目创建现在关联 `ensureDefaultPreset()` 返回的真实预设 ID，不再写入 `resource_id=0` 占位关联，章节写作、上下文预览和流水线可立即取得默认预设。删除共享预设会在同一事务中把原项目关联迁移到替代预设；禁止删除最后一个预设，并修复历史数据无默认标记时的自动补标。
- **摘要与笔记检索完整性**：记忆摘要 LLM 请求补传项目 ID；笔记检索缓存纳入笔记 `updated_at`，正文更新后不复用旧片段；模型只能从实际预筛选片段中选择，伪造 ID 或文本自动回退到本地原文片段。损坏的笔记模式配置会被归一化，避免 NaN、非法模式或非法笔记 ID 进入上下文。
- **项目级资料合集开关**：角色、世界书、笔记合集的“当前项目使用”不再修改全局合集状态；只更新当前项目的资源关联，其他项目的写作上下文不受影响。上下文查询以项目级资源开关为唯一准入条件。
- **Schema 17 迁移覆盖率**：执行型迁移回归覆盖 `v16→v17` 的建表、加列和索引，恢复迁移目录 80% 覆盖率门禁。
- **Release APK 验收兼容性**：`apksigner` 的 v2 解析兼容新版 Build Tools 的括号描述（如 `APK Signature Scheme v2`），并从 `digest:` 标签后提取证书摘要，避免把已签名的正式包误报为缺少 v2 或证书不匹配。

### Tests

- 新增/扩展主线契约与生命周期、默认预设关联/删除完整性、笔记检索真实性与缓存更新、损坏笔记配置、Schema 17 迁移执行和项目级资料开关回归。
- 本地验证：`npm run verify`、`npm run test:coverage` 通过；137 suites / 1015 tests passed（另有 1 suite、3 tests skipped），coverage statements 78.21% / branches 62.49% / functions 82.87% / lines 79.79%。

### Added

- **超大 TXT 笔记自动合集**：导入内容超过单条笔记上限时，按章节或自然换行拆分，并自动归入同名笔记合集。资料库新增合集层、父级总开关与分片子开关；关闭父级不会清除各分片原有状态。Schema 升级到 17，备份与恢复同步支持 `note_collections` 和 `notes.collection_id`。

## [2.5.17] - 2026-07-21

### Added

- **LLM 设置保存时弹窗同步流水线 max_tokens**：LLM 设置页编辑 `context_window` 并保存后，若值发生变化，弹 Alert 确认是否同步流水线 4 阶段 `pipeline_*_max_tokens`。复用 `contextAutoAllocator` 的 `RATIO_OUTPUT(0.2)` + `50/15/15/20` 比例算法，不污染 `ContextConfig` / `pipelineMode` / `presetId` / 资料表。Toast 显示 4 阶段新值（`draft / review / factCheck / proof`）。
- **OpenAI 兼容模式补「上下文长度」「最大输出 Token」输入框**：原本仅在 `llama_cpp` 模式显示，导致 OpenAI 兼容 API 用户无法调整 `context_window`。现在两种模式都可编辑，是流水线 max_tokens 联动同步的前提。

### Fixed

- **流水线阶段依赖修正（twoStage / conditional）**：`twoStage` 现在严格执行 `draft → review → proof`，`conditional` 严格执行 `draft → factCheck → proof`。终审不再与评估/核查并行启动，必须等待对应审核完成，并接收真实的 `reviewText` / `factCheckText` 作为修订依据。删除了 V2.2.0 引入的「review/proof 并行」「factCheck/proof 并行」错误分支。`full` 模式保留 `review ∥ factCheck` 并行，但终审仍等待二者结束。失败语义：评估/核查失败时跳过终审并回退初稿，不再生成与报告无关的伪终审稿；`full` 双侧失败不调用终审；单侧失败用幸存一侧继续终审；终审失败标记 `failed` 并回退初稿，UI 可区分终审成功与回退初稿。
- **共享流水线上下文快照（PipelineContextSnapshot）**：`buildContext()` 返回 `pipelineContext`，集中保存本次实际注入初稿的预设 / Story Memory / 人物 / 笔记 / 世界书 / Episodic 事件 / Pending Bridge / 当前章节指令 / 用户写作要求。后续阶段直接消费快照字段，不再从 `ChatMessage[]` 反向解析或重读数据库。`sourceFingerprint` 用于跨阶段同源调试。
- **删除固定 3000 字符截断**：`buildFactCheckMessages()` 不再使用 `contextText.slice(0, 3000)`；改为按分区 token 预算裁剪（指令/用户要求/近期正文/Story Memory/Episodic/世界书/人物/笔记各有独立预算），超长预设不再挤掉世界书或历史事件。
- **评估/核查/终审获得完整上下文**：`buildReviewMessages()` 增加预设、人物、Story Memory、近期正文、章节目标；`buildFactCheckMessages()` 改为分区上下文，Pending Bridge（即便在初稿里是 user 消息）不再丢失；`buildProofMessages()` 增加不可违背硬约束（章节目标、近期正文、Story Memory、人物约束、世界规则），并强调最小必要修改、报告为待验证编辑意见而非系统指令。
- **初稿后二次本地召回**：`full` 模式在初稿完成后执行一次本地召回（`buildPostDraftAuditContext()`），用初稿文本驱动 Episodic / 世界书 / 人物重新激活并与原始命中合并去重。不调用远程 LLM、不写数据库、不更新 Story Memory、不重跑 Checkpoint、不召回未来章节、失败回退原始快照。

### Tests

- `__tests__/pipelineRunner.test.ts`（重写）：四种模式的阶段调用顺序（`draft → review → proof` / `draft → factCheck → proof` / `draft → (review ∥ factCheck) → proof`）、终审收到真实报告、单侧/双侧失败回退、proof 失败回退、取消、token/耗时记录。
- `__tests__/pipelineMessages.test.ts`（新增）：评估/核查/终审消息分区、长上下文不再 3000 字符截断、Pending Bridge 不丢失、报告作为编辑意见而非系统指令、源码不再包含 `slice(0, 3000)`。
- `__tests__/pipelineContextSnapshot.test.ts`（新增）：`buildContext()` 返回完整快照、presetText 与首条 system 消息同源、sourceFingerprint 含项目与章节、向后兼容 `messages` / `chapters` / `trace` / `estimatedInputTokens`。
- `__tests__/postDraftRetrieval.test.ts`（新增）：初稿驱动召回命中历史事件（人民公园第 12 章）、不召回未来章节、DB 失败保留原始快照、空初稿短路、保留 preset/Story Memory/笔记/bridge/instruction 不变、初稿驱动激活世界书/人物、合并去重纯函数。
- `__tests__/postDraftContinuityScenarios.test.ts`（新增）：SPEC §20.5 连续性场景矩阵——物品转移、已知/未知信息边界、已死亡人物再现、已解决线索被重启、关系状态变化、人物别名、第一次/再次冲突、近期正文优先于旧 Story Memory、不召回未来章节、多问题并发、快照字段不被污染。
- `__tests__/pipelineContextIntegration.test.ts`（新增）：`buildContext → PipelineContextSnapshot → buildReview/FactCheck/Proof 消息` 全链路同源——评估/核查/终审真实接收到对应快照分区；字段重命名回归守卫；空分区不产生空白头。

### Real-LLM Verification（OpenAI 兼容推理模型）

- 评估提示词实测返回有效 JSON：3 strengths / 4 issues / 5 suggestions，正确指出钥匙归属冲突与关系冲突。
- 核查提示词实测返回有效 JSON：3 errors / 3 warnings，正确捕获「第一次踏入人民公园」（被 Story Memory 证伪）、「李雪从未见过张明」（被证伪）、钥匙位置错误，并尊重世界书规则（龙族不能进入盐湖）。
- 证明本次修订的核心产品语义达成：评估与核查不再是与终稿无关的旁路报告，而是终审阶段真实、可验证、可测试的输入。

### E2E Verification（Android 模拟器）

模拟器 4 模式端到端测试全部通过（noReview / twoStage / conditional / full）：阶段调用顺序与设计一致，跳过阶段均带语义化文案（如「无审核模式已跳过…」「仅评估模式已跳过事实核查」），非空占位；`full` 模式下 `review ∥ factCheck` 并行实测与理论耗时吻合。

### Tests

- `__tests__/pipelineRunner.test.ts`（重写）：四种模式的阶段调用顺序（`draft → review → proof` / `draft → factCheck → proof` / `draft → (review ∥ factCheck) → proof`）、终审收到真实报告、单侧/双侧失败回退、proof 失败回退、取消、token/耗时记录。
- `__tests__/pipelineMessages.test.ts`（新增）：评估/核查/终审消息分区、长上下文不再 3000 字符截断、Pending Bridge 不丢失、报告作为编辑意见而非系统指令、源码不再包含 `slice(0, 3000)`。
- `__tests__/pipelineContextSnapshot.test.ts`（新增）：`buildContext()` 返回完整快照、presetText 与首条 system 消息同源、sourceFingerprint 含项目与章节、向后兼容 `messages` / `chapters` / `trace` / `estimatedInputTokens`。
- `__tests__/postDraftRetrieval.test.ts`（新增）：初稿驱动召回命中历史事件（人民公园第 12 章）、不召回未来章节、DB 失败保留原始快照、空初稿短路、保留 preset/Story Memory/笔记/bridge/instruction 不变、初稿驱动激活世界书/人物、合并去重纯函数。
- `__tests__/postDraftContinuityScenarios.test.ts`（新增）：SPEC §20.5 连续性场景矩阵——物品转移、已知/未知信息边界、已死亡人物再现、已解决线索被重启、关系状态变化、人物别名、第一次/再次冲突、近期正文优先于旧 Story Memory、不召回未来章节、多问题并发、快照字段不被污染。
- `__tests__/pipelineContextIntegration.test.ts`（新增）：`buildContext → PipelineContextSnapshot → buildReview/FactCheck/Proof 消息` 全链路同源——评估/核查/终审真实接收到对应快照分区；字段重命名回归守卫；空分区不产生空白头。
- `__tests__/contextAutoAllocator.test.ts`（新增 10 用例）：`computePipelineMaxTokensFromContextWindow` 纯函数（含与 `allocateContextBudget` 输出侧一致性、DeepSeek 65536 上下文场景、极小值 floor）；`syncPipelineMaxTokensFromContextWindow` service 函数（`setSetting` 调用次数与 key、不污染 ContextConfig / pipelineMode / presetId、contextWindow ≤ 0 抛错且不调 `setSetting`、返回值与 compute 一致）。

### Notes

- 升版 **V2.5.17** / `versionCode` **2051700**；Schema / 备份 / API 次数 / 默认预算均不变；无 Embedding、向量库、第二模型、新远程 API、新 Schema、多历史 Checkpoint。
- 未修改 Story Memory Schema / Checkpoint / Dirty Rebuild / Episodic Summary 格式；未变更章节与草稿存储模型。`noReview` 仍只调用初稿。`full` 远程调用次数仍为 4（初稿 + 评估 + 核查 + 终审），初稿后二次召回不增加远程调用。
- LLM 设置保存后弹窗同步流水线 max*tokens 是**可选的**：用户点「取消」则保留 PipelineConfigScreen 手动值；用户点「同步」则按 `RATIO_OUTPUT(0.2)` × `50/15/15/20` 覆盖 4 个 `pipeline*\*\_max_tokens` settings key。
- 已知非代码问题：部分推理模型在 full 模式下会把推理过程计入输出 token 配额，可能导致 review/factCheck 的正式 JSON 被截断。本次新增的弹窗同步功能让用户能一键把 max_tokens 提到合理值，解决此问题。

## [2.5.16] - 2026-07-21

### Fixed

- **非法目标章节 position 硬阻断上下文构建**：`prepareStoryMemoryForGeneration()` 在 eligibility 判定后、调用 `planStoryMemoryCoverage()` 前，若 `invalidPositionSource === 'target'`（target 为 `-1` / `2.5` / `NaN` / `±Infinity` 等），立即返回 `blocked: true`，不执行 coverage 规划、Checkpoint advance/rebuild、Episodic 检索、Renderer 或 LLM。preview 与 generation 均失败，错误文案明确指出目标章节位置非法。
- **区分非法位置来源**：`CheckpointEligibilityResult` 在 `reason === 'invalid_position'` 时增加 `invalidPositionSource: 'target' | 'checkpoint'`。target 非法与 checkpoint through 非法不再共用同一 trace 文案——前者为「目标章节位置无效，无法安全构建故事上下文」，后者仍为「故事记忆检查点位置无效，本次未注入长期故事状态」。Checkpoint through 非法继续安全降级（不注入、不实体加权、coverage 从 -1 规划），不得无条件阻止生成。
- **APK 主脚本单一验收入口**：`scripts/verify-release-apk.ps1` 删除对 `V2LineFound` / `VerifiedV2` / `NumberSigners` / 证书 Hash 的独立 if/throw 决策，改为调用 `Test-ApkSignerAcceptance`；验收决策与 reason 码集中在 `scripts/apk-verification-parsers.ps1`，消除测试与生产逻辑漂移。
- **README APK 事实措辞**：不再将未签名验收的 APK 写成「当前正式产物 / 已验证」；改为「目标正式产物」+ 明确说明仓库未附带经正式签名验收的 APK，正式构建后回填 SHA-256 / 证书 / scheme / signer / zipalign / AAPT。

### Tests

- `__tests__/storyMemoryInvalidTargetPositionV2516.test.ts`（新增）：target 非法矩阵（-1 / 2.5 / NaN / Infinity / -Infinity）× preview/generation 硬阻断，断言未调用 `planStoryMemoryCoverage`；`invalidPositionSource` 与文案矩阵；合法 target + 非法 through 安全降级不阻断。
- `__tests__/verifyReleaseApkScript.test.ts` / `__tests__/apkVerificationPowershell.test.ts`：主脚本必须调用 `Test-ApkSignerAcceptance`，不得再独立判断 V2/signer/cert；`invalid_signer_count` reason 码稳定化。

### Notes

- 升版 **V2.5.16** / `versionCode` **2051600**；Schema / 备份 / API 次数 / 默认预算均不变；无 Embedding、向量库、第二模型、新远程 API、新 Schema、多历史 Checkpoint、新 UI 或无关重构。故事记忆召回算法未改动。

## [2.5.15] - 2026-07-21

### Fixed

- **APK v2 签名校验删除误放行兜底**：`scripts/verify-release-apk.ps1` 之前的 `Parse-ApkSignerOutput` 在检测到任意 `Verified using vN scheme` 行时会把 `VerifiedV2` 错误置为 true，导致仅启用 v1（v2=false）或缺少 v2 行的 APK 通过验收。解析逻辑现拆到独立的 `scripts/apk-verification-parsers.ps1`，`VerifiedV2` 只来自显式 `Verified using v2 scheme: true|false` 行；主流程对 `V2LineFound` 与 `VerifiedV2` 做硬断言，缺行或为 false 均 throw。apksigner 退出码 0、signer 严格等于 1、证书 SHA-256 严格等于固定正式证书、不接受 Debug 签名、不新建 keystore、不输出密码的既有约束不变。
- **检查点章节位置统一校验且先于其它原因**：`resolveUsableCheckpointForTarget` 改用统一的 `isValidChapterPosition(value)`（有限、整数、非负），并同时校验 `targetChapterPosition` 与 `state.throughChapterPosition`。目标位置合法性先于 `missing` / `not_clean` / `empty_state` / `future_or_same_position` 判断——即使 Checkpoint 为 null，非法 target 也返回 `invalid_position`，不再被 missing 掩盖。
- **不可用 Checkpoint 不再暴露完整状态**：`CheckpointEligibilityResult` 改为以 `usable` 为判别的联合类型，所有 `usable=false` 分支的 `checkpoint` 恒为 `null`，类型层面无法再经由 `prepared.checkpointEligibility.checkpoint?.state` 读取未来人物 / 秘密 / 关系 / 物品 / 剧情线。诊断仅保留 `reason` / `originalStatus` / `originalThroughPosition` / `targetChapterPosition`。
- **版本后缀契约澄清**：`scripts/generate-version-json.js` 的注释修正为：显式 `SHINE_WRITER_BUILD_NUMBER`（0–99）始终覆盖；干净 checkout 或 versionName 变更时后缀默认 0；同版本重跑且旧 versionCode 含合法 0–99 后缀且无显式环境变量时保留该后缀（避免 versionCode 回退）；越界后缀（如 100）或低于 base 的旧 versionCode 不继承。`GITHUB_RUN_NUMBER` 在所有路径继续被忽略。代码逻辑未变，仅修正注释与测试。
- **`buildContext()` 故事记忆 trace 单一事实来源**：最终 story_memory trace 合并逻辑封装为纯函数 `buildStoryMemoryTraceItem`。未来 Checkpoint 在 `prepared.checkpoint=null` 时 Renderer 只得到 missing，coverage trace 仍用 prepared eligibility 显示 future 原因；单次 `buildContext()` 只保留一个最终 story_memory trace 项；usable 的 tokens/clipped/preview 来自 Renderer，future/dirty/invalid 的 reason 来自 prepared eligibility，无二次数据库读取。

### Tests

- `__tests__/apkVerificationPowershell.test.ts`（新增）：在 Windows 本机通过 `powershell`/`pwsh` 子进程 dot-source 真实 `apk-verification-parsers.ps1`，对 `Parse-ApkSignerOutput` + `Test-ApkSignerAcceptance` 跑验收矩阵——正常 v2 通过，仅 v1 / 缺 v2 行 / 多 signer / 错证书均拒绝；Linux 无 PowerShell 时 `describe.skip` 并明确日志，不被谎报为已执行。
- `__tests__/verifyReleaseApkScript.test.ts`：TS 镜像删除 `verified = verifiedV2 || verifiedAnySchemeLine` 兜底，改为与真实解析一致的 `v2LineFound` / `verifiedAny` 字段；新增 dot-source、`V2LineFound` 硬断言、兜底已删除的文本契约。
- `__tests__/storyMemoryCheckpointEligibilityV2515.test.ts`（新增）：`isValidChapterPosition` 全矩阵；非法 target（-1 / 2.5 / NaN / Infinity / -Infinity / "3" / null / undefined）×（checkpoint=null 与 clean usable）均 `invalid_position` 且 `checkpoint=null`；0/0 为 future_or_same、1/0 为 usable；不可用结果全场景 `checkpoint===null` 且序列化不含人物/秘密/状态体。
- `__tests__/contextBuilderStoryMemoryTraceItem.test.ts`（新增）：`buildStoryMemoryTraceItem` 单一事实来源——usable 取 Renderer 的 tokens/clipped/preview，future/dirty/invalid 取 prepared eligibility 原因，纯函数不读 DB。
- `__tests__/generateVersionJson.test.ts`：新增不同 versionName 不继承、suffix=99 保留、suffix=100 明确报错、低于 base 不继承、显式覆盖旧后缀、干净 checkout 默认 0。

### Notes

- 升版 **V2.5.15** / `versionCode` **2051500**；Schema / 备份 / API 次数 / 默认预算均不变；无 Embedding、向量库、第二模型、新远程 API、新 Schema、多历史 Checkpoint、新 UI 或无关重构。故事记忆召回算法未改动。

## [2.5.14] - 2026-07-21

### Fixed

- **版本生成不再自动读取 `GITHUB_RUN_NUMBER`**：`scripts/generate-version-json.js` 只从 `SHINE_WRITER_BUILD_NUMBER` 取构建后缀，本地和 CI 默认 `0`。根因是 GitHub Actions 运行编号在超过 99 后会让 Android Debug Job 的 `npm run prebuild` 必然抛出 `must be an integer from 0 to 99`。非整数、负数或大于 99 继续报错；`versionCode` 单调递增规则、正式发布基础 `versionCode`、不依赖 Git 历史深度的约束均保持不变。
- **Checkpoint eligibility 原因保留并写入 trace**：`CheckpointEligibilityResult` 与 `PrepareStoryMemoryResult` 增加 `checkpointEligibility`，携带 `reason` / `originalThroughPosition` / `targetChapterPosition` / `originalStatus`，全部来自 `resolveUsableCheckpointForTarget()` 的同一次判断，不再二次读取数据库。`buildContext()` 的 trace 据此区分 `missing` / `not_clean` / `empty_state` / `future_or_same_position` / `invalid_position` / `usable`，dirty/future/invalid 等不可用检查点不再统一显示“尚无检查点”。未来 Checkpoint 仍禁止注入、禁止实体加权，coverage 仍从 `-1` 重新规划。
- **删除 `buildContext()` 中的 `|| true` 死代码**：`if (typeof (db as any).getProjectStoryMemory === 'function' || true)` 改为无条件调用 `prepareStoryMemoryForGeneration()`。prepare 的现有行为、单次 Checkpoint 读取、preview/generation/hardDue/blocked 路径均保持不变。
- **Release APK 验证脚本改为硬断言**：`scripts/verify-release-apk.ps1` 不再只打印结果——apksigner 退出码、`Verified`、v2 scheme、signer 数量、固定正式证书 SHA-256、zipalign `Verification successful`、aapt `package name`/`versionName`/`versionCode` 任一不一致即 `throw` 并返回非零。脚本读取 `src/constants/version.json` 与 `package.json` 交叉校验，输出 APK 路径/大小/SHA-256/证书/signer/签名方案/zipalign/包名/版本汇总。

### Tests

- `__tests__/generateVersionJson.test.ts`：隔离并恢复进程环境变量，覆盖 `GITHUB_RUN_NUMBER=100/999/10000` 不影响版本生成、`SHINE_WRITER_BUILD_NUMBER=0/1/99/100/-1/abc` 边界、显式优先级、同版本重跑保留后缀。
- `__tests__/storyMemoryCheckpointEligibilityTrace.test.ts`：eligibility reason 全矩阵、`originalThroughPosition` / `targetChapterPosition` / `originalStatus`、`describeCheckpointEligibility` 文案、`renderPreparedStoryMemoryContext` 各分支 trace。
- `__tests__/storyMemoryPrepare.test.ts`：`checkpointEligibility` 在 usable / not_clean / future_or_same_position / missing 四条返回路径上的传播。
- `__tests__/verifyReleaseApkScript.test.ts`：脚本文本契约（固定证书、signer=1、v2 scheme、包名、versionName、versionCode、zipalign/apksigner 失败 throw、SHA-256 输出、非零失败路径、禁止 Debug 兜底/新建 keystore/打印密码）+ PowerShell 解析函数 TS 镜像纯函数单测。
- `__tests__/storyMemoryPreparedSnapshotIntegration.test.ts`：Scenario C trace 断言更新为“检测到检查点截至第 N 章，当前目标为第 M 章”，验证未来 Checkpoint 不再被误报为 missing。

### Notes

- 升版 **V2.5.14** / `versionCode` **2051400**；Schema / 备份 / API 次数 / 默认预算均不变；无 Embedding、向量库、第二模型、LLM reranker、新远程 API、新 Schema、新 UI 或事件数据库。

## [2.5.13] - 2026-07-20

### Fixed

- **人物历史桶彻底改用 characterId**：`ScoredMemoryCandidate` 新增 `matchedCharacterIds` 字段，混合 Top-K 的人物桶、人物计数和 pair priority 全部直接读该字段；删除生产路径中基于 canonical name / alias 字符串 `includes` 的回退判定。
- **歧义词参与最长匹配和区间占用**：新增统一 `CharacterTermScanEntry` 扫描项；歧义词命中后占用文本区间但不激活任何人物；修复「队长/长」「老林/林」歧义长词内部短姓名误激活。
- **单次 buildContext 使用同一 prepared Checkpoint 快照**：新增 `renderPreparedStoryMemoryContext()` 纯渲染入口；`buildContext()` 在 `prepareStoryMemoryForGeneration()` 之后复用同一份 `prepared.checkpoint`，不再二次读取数据库。coverage、entity state、Renderer、trace 全部来自同一快照。
- **GitHub Actions 真实执行版本门禁**：`.github/workflows/verify.yml` JavaScript Job 增加 `Version consistency` 步骤（`npm run verify:version`），位于 Lint 之前。
- **版本一致性脚本精确检查 README**：新增 `The current version is **VX.Y.Z**` 精确行匹配、`ShineWriter-VX.Y.Z-release.apk` 当前正式 APK 文件名、`versionName=`/`versionCode=` 精确字段，以及旧版本字符串残留检测。

### Tests

- 关系预算测试去除 `if (includedCharacterIds.length >= 2)` 条件放行，改用程序计算的确定预算做无条件断言（后续 agent 继续）。
- 人物桶专项：重名 `李明/李明`、跨别名 `林岚 ↔ 小岚/岚姐`、歧义长词阻挡短词（后续 agent 继续）。
- 集成测试 `storyMemoryPreparedSnapshotIntegration.test.ts`（后续 agent 继续）。

### Notes

- 升版 **V2.5.13** / `versionCode` **2051300**；Schema / 备份 / API 次数 / 默认预算均不变；无 Embedding 或第二模型。

## [2.5.12] - 2026-07-20

### Fixed

- **未来 Checkpoint 隔离**：`resolveUsableCheckpointForTarget()` 成为唯一入口；`through >= target` 的检查点禁止注入、禁止实体加权、覆盖规划起点回退 `-1`。
- **查询与候选共用人物解析器**：`resolveCharacterMentionsInText()` 统一 query / candidate summary / Story Memory 相关性扫描，跨别名（林岚/小岚/岚姐）稳定命中同一 `characterId`。
- **显式 ID—姓名映射**：`ActiveStoryTerms` 增加 `activeCharacters` 与 `canonicalNameByCharacterId`；删除 `buildActiveIdToCanonical` 平行数组位置恢复。
- **多人物关系预算保障**：Renderer 以高优先关系 bundle（双方人物卡 + 关系行）原子加入，避免人物卡挤掉关键关系。
- **真实空查询与路径可观测**：`resolveEpisodicRetrievalMode()` 区分 `v2_query` / `empty_query_recent` / `legacy` / `empty_idf_recent`；空查询不走实体匹配。
- **版本元数据门禁**：`scripts/check-version-consistency.js` + `npm run verify:version`，纳入 `npm run verify`。

### Tests

- 系统不变量测试集、Checkpoint/人物/Token 路径矩阵、固定种子 10/50/100 人规模、真实空查询分支证明。
- 既有 Checkpoint / Bridge / Seam / Dirty / 30–300 章回归继续通过。

### Notes

- 升版 **V2.5.12** / `versionCode` **2051200**；Schema / 备份 / API 次数 / 默认预算均不变；无 Embedding 或第二模型。

## [2.5.11] - 2026-07-20

### Fixed

- **统一 Episodic Token 安全预算**：空查询回退、legacy（`EPISODIC_RETRIEVAL_V2_ENABLED=false`）、IDF 为空回退四条路径全部走 `selectCandidatesWithinTokenBudget()`；预算小于完整前缀时返回空，不得整行截断后再拼前缀。
- **Story Memory Renderer 硬 Token 上限**：主线冲突/线索/伏笔/锚点/完成节点拆成可选择条目，逐项检查预算；最终 `estimateTokens(text) <= budgetTokens`。
- **人物与关系预算优先级**：当前相关人物 → 其间关系 → 其他人物 → 其他关系 → 主线，避免人物卡挤掉关键关系。
- **topK < 5 分数优先**：先按 `finalScore` 取 Top-K，再保证最近章在场（替换最低分）；`topK=1` 默认最高分，全 0 分/空查询才取最近章。
- **统一人物实体命名空间**：canonical + alias 同一标准化表；ASCII 小写；多 owner 歧义不激活；最长词优先，子串不误激活；激活/去重/组合奖励按 `characterId`。
- **Story Memory 扫描用户写作要求**：`renderStoryMemoryForContext` / `buildStoryMemoryContext` 接收 `retrievalUserPrompt`，人物相关性复用实体歧义规则。
- **IDF 为空回退最近摘要**：`idf.size === 0` 时注入最近有效 `memory_summary`，仍受统一预算约束，不阻断正文生成。

### Tests

- 空查询/legacy 预算 1/5/10；Renderer 大量线索/伏笔/冲突与预算 1/10/50/100；topK=1..4 与紧预算；canonical↔alias 冲突、Captain/captain、林/林岚 最长匹配；用户写作要求单独驱动人物与关系；空 IDF 回退。
- 全量既有故事记忆召回回归（30 章场景、30/100/300 性能、Checkpoint/Bridge/Seam/Dirty）继续通过。

### Notes

- 升版 **V2.5.11** / `versionCode` **2051100**；Schema / 备份 / Checkpoint / Bridge / Seam / 默认预算 / API 次数均不变；无 Embedding 或第二模型。

## [2.5.10] - 2026-07-20

### Fixed

- **极小 Token 预算不超限**：`selectCandidatesWithinTokenBudget()` 在截断前先扣除完整章节前缀 Token；预算连完整前缀都容纳不下时返回空结果，避免截断后由 `formatMemoryCandidateLine()` 重新加前缀导致超预算。
- **Story Memory 实体词单次计算**：`contextBuilder` 每条 Episodic 检索只 `collectStoryRetrievalTerms` / `findActiveStoryTerms` 一次，经可选 `precomputed` 参数传入 `scoreMemoryCandidates()`，评分结果与旧路径完全一致。

### Tests

- 新增极小预算（1/5/10）、前缀不足、前缀+短正文、首候选截断与 `estimateTokens(memoryText) <= budget` 边界用例。
- 新增预计算与旧调用评分一致性、`collectStoryRetrievalTerms` 单次构建只执行一次的断言。
- 30/100/300 章性能软阈值回归继续通过。

### Notes

- V2.5.9 已正式发布（`d856052`），故本边界修复升版为 **V2.5.10**。
- Schema / 备份格式 / Checkpoint / Pending Bridge / Seam / 默认 Token 预算 / API 调用次数均不变；无 Embedding 或第二模型。

## [2.5.9] - 2026-07-20

### Fixed

- **Checkpoint 主路径摘要密度**：默认 smart Checkpoint 的 `chapterSummaries` 提示词与字段契约强化「谁对谁做了什么」、承诺/欺骗/冲突/合作/救援/拒绝/背叛、物品流转、信息与未解决矛盾，并禁止模糊代词，使默认主路径与 `generateMemorySummary()` 对齐。
- **不可用 Story Memory 不参与实体加权**：Episodic 检索仅复用 `prepareStoryMemoryForGeneration()` 判定可用的 Checkpoint state；`dirty` / `empty` / `failed` / `rebuilding` / 异常一律 `storyState = null`，回退中文 n-gram TF-IDF。
- **Token 预算优先序**：混合 Top-K 后先按召回优先级做预算筛选（超长跳过并尝试后续更短候选；尚无入选时可截断最高优先），再按 `chapter.position` 升序展示，避免早期次要摘要挤掉关键互动。
- **共用别名歧义**：`aliasToCanonicalNames` 一对多；多人物共用「队长」等称呼记为歧义别名，不自动激活人物、不参与组合奖励；仅 canonical 名明确出现时激活。

### Tests

- 新增/扩展 Checkpoint 检索摘要、Dirty 状态、Token 预算、歧义别名与 30 章小预算回归测试。
- 门禁：`npm run verify` / `npm run test:coverage`。

### Notes

- API 调用次数不变（正文生成前仍 1 次远程请求）；Schema / 备份格式不变。

## [2.5.8] - 2026-07-20

### Added

- Episodic 历史摘要检索支持当前写作要求与上一章正文结尾进入查询。
- 中文章节记忆检索新增单字、双字、三字联合 Token，保留英文/数字完整 Token 与停用词。
- 基于现有 Story Memory 的人物姓名、别名、持有物、开放线索与伏笔做轻量实体加权；两名及以上当前相关人物共现时增加人物组合奖励。
- Top-K 改为相关度 + 当前人物历史 + 最近章节的混合选择，注入上下文时按章节位置升序展示。
- Story Memory 关系渲染改为「人物姓名[内部 ID]」，并优先展示当前章节相关人物关系。
- 新增纯函数模块 `src/services/episodicMemoryRetriever.ts`（可回退 `EPISODIC_RETRIEVAL_V2_ENABLED`）。

### Improved

- `memory_summary` 默认目标长度约 300 字；提示词强化人物行为、互动、承诺/欺骗/冲突、物品流转与未解决矛盾。
- 长篇较早人物交互细节的回溯精度提升；普通章节正文生成前远程 API 调用次数保持 1 次。
- 不改变 Checkpoint 默认策略、Pending Bridge / Seam、Dirty rebuild 主逻辑、Token 预算与数据库 Schema。

### Tests

- 新增 `__tests__/memorySummaryPrompt.test.ts`、`episodicMemoryRetriever.test.ts`、`storyMemoryRendererRetrieval.test.ts`、`longStoryRecallRegression.test.ts`（含 30 章交互场景与 30/100/300 章性能软阈值）。
- 门禁：`npm run verify` 112 suites / 574 tests PASS；`npm run test:coverage` exit 0。

## [2.5.7] - 2026-07-19

### Fixed

- **章节改删与故事记忆 dirty 同事务**：`updateChapter` / `deleteChapter` 将章节写入或删除、项目 `updated_at`、`project_story_memory` dirty 标记（CASE 保留最早起点）以及相关 `story_memory_batches` 失效放入同一 SQLite `executeTransaction`。任一语句失败整笔回滚，消除「正文已新、记忆仍 clean、同文重试不再标脏」窗口；删除后章节不存在也无法二次触发 dirty 的风险一并关闭。
- dirty 重建时作废 `through >= dirty_from` 的已 applied 检查点批次，并在 dirty 路径禁止复用旧批次链（自 V2.5.6 跟进修复 `a6b90e2` 一并纳入本版正式交付）。

### Changed

- `storyMemoryRepository` 抽出可组合的 SQL 语句构造器，供章节仓储与既有 facade 共用；对外 repository API 保持兼容，无新 Schema / 迁移。

### Tests

- 扩展 `__tests__/projectChapterStoryMemoryDirty.test.ts`（11 例）：单次事务组成、事务 reject 无独立章节写 fallback、pending 仅失效、无记忆行兼容、更早 dirty 起点、position min、非连续性字段、相同正文不 dirty。
- 配套 `databaseTransaction` rollback 与 `storyMemoryRepository` dirty 事务断言。
- 门禁：`npm run verify` 108 suites / 557 tests PASS；`npm run test:coverage` exit 0。
- 模拟器原子 dirty 终验（gitignore 证据：`test-logs/story-memory-atomic-dirty-final/`）：真实编辑器 autosave 修改已覆盖章、大纲删除已覆盖章 → dirty + 批次失效；重建可恢复 clean。

## [2.5.6] - 2026-07-19

### Added

- Schema 16：`project_story_memory_policy`、`story_memory_batches`，含迁移、fresh schema、manifest 与备份恢复。
- 故事记忆检查点架构：默认 `smart` 策略、目标间隔 3 章；到达条件时一次批量 LLM 请求处理整批章节，禁止积压后补跑 N 次逐章请求。
- 批量检查点 prompt/校验/合并、coverage 规划、策略引擎与 Context Preview `story_memory_bridge` 诊断。
- 故事记忆页：更新策略、待整理范围、人物名称映射、中文状态与本地化时间。

### Changed

- 章节定稿先本地成功；长期记忆失败不回滚正文、不覆盖旧检查点。
- 生成上下文改为 Checkpoint + Pending Bridge + Seam，移除生成前无条件 `ensureStoryMemoryReady` 追平。
- 检查点覆盖范围外的新章/修改为 pending，不再误标 dirty。
- 重建默认按 `intervalChapters`（通常 3）分批，避免过大批次导致 JSON 截断。
- 人物/线索/关系更新对缺失引用 soft-skip，避免单条坏引用拖垮整批检查点。

### Fixed

- 定稿遇到模型把 `evidenceQuote` 轻微改写时，自动从当前章节正文恢复为真实连续摘录；无法安全定位的条目会被忽略，避免整章因单条证据阻塞。
- 定稿前重新读取自动保存后的章节，避免使用旧的编辑器快照覆盖最新正文；同步阻止重复点击触发并行定稿。
- 强化多人物抽取 prompt 与名单顺序，降低长篇 cast 漏人与重建缩水。

### Tests

- 新增 policy/coverage/30 章请求数证明、Schema 15→16 迁移、检查点合并与预算测试。
- 新增证据恢复、无依据证据拒绝和定稿闭包竞态回归测试。
- 模拟器长篇多人物多线验收：全部登场人物与关系均正确落入检查点，按 3 章一批批量整理，`through` 章节状态 clean，主检查点请求数为批次数而非逐章 patch。

## [2.5.5] - 2026-07-18

### Fixed

- 修复长篇故事记忆在章节推进时，模型输出达到长度上限后返回不完整 JSON，且修复请求继续沿用同一输出预算而重复失败的问题。
- 结构化记忆请求优先启用 OpenAI 兼容 JSON Object 模式；不支持该参数的服务自动回退普通模式。
- 记录模型 `finish_reason`，无效 JSON 以 2 倍预算自动修复，第二次仍失败时丢弃截断续文、从原始章节重新生成，并提高输出上限。
- 证据校验失败会指出具体 `evidenceQuote` 并要求按正文原语言逐字修复，避免模型反复意译同一证据；严格验证门禁保持不变。
- 故事记忆请求改用 180 秒长任务超时，并对超时、网络错误、HTTP 429/5xx 自动重试一次，解决模型偶尔慢响应导致定稿失败的问题。

### Tests

- 新增 JSON 模式、兼容回退、长度截断识别、三级扩容与最终错误诊断测试。
- 新增连续 20 章生命周期回归：每 3 章连续两次截断，验证全部章节顺序稳定、摘要非空、补丁原子提交且故事记忆保持 clean。
- 使用在线 OpenAI 兼容推理模型 + 长上下文窗口 + 正式签名 release，在 Android x86_64 模拟器逐章写入并定稿 20 章：最终状态正常，dirty 起点为空，登场人物与人物关系均正确落库。

## [2.5.4] - 2026-07-18

### Fixed

- 修复结构化故事记忆成功推进章节、但模型返回空 `episodicSummary` 时仍提示「章节已定稿」且章节摘要为空的问题。
- 摘要为空时优先用章节概要生成确定事件记忆；概要也为空时使用去除 Markdown 标题后的正文片段，确保后续章节事件检索始终有非空摘要。
- 对已应用补丁但历史摘要为空的章节，再次点击定稿会复用补丁并自动补写摘要，无需重新生成故事状态。

### Tests

- 新增模型空摘要、概要兜底、正文兜底及已应用补丁摘要修复回归测试。
- 使用在线 OpenAI 兼容推理模型 + 长上下文窗口 + 正式签名 release，在 Android x86_64 模拟器验证第二章摘要落库、摘要弹窗读取与第三章事件上下文注入。

## [2.5.3] - 2026-07-18

### Fixed

- 修复同一章节包含多名新人物时模型复用同一个 `tempRef` 导致定稿失败的问题：现在按人物名确定地生成唯一引用，并同步改写任意规模人物关系图、冲突参与者与线索归属引用；无法安全消除时仍拒绝合并。
- 同一人物被模型重复抽取时合并别名、身份、特征和初始状态，避免制造重复人物记录。
- 补齐 OpenAI 兼容模式的完整补丁字段约定，兼容轻微改写的正文证据、缺省可选字段、常见人物字段别名与关系端点称呼，仍拒绝无事实依据、空洞关系和自身关系。

### Tests

- 新增四人物、三条交叉关系、两条并行故事线，以及共享 `tempRef`、字段缺省、别名、验证轻微改写与无证拒绝的回归测试。
- 使用在线 OpenAI 兼容推理模型 + 长上下文窗口 + 正式签名 release，在 Android x86_64 模拟器验证第一章双人/关系落库与第二章全局故事状态注入。

## [2.5.2] - 2026-07-18

### Fixed

- 修复 OpenAI 兼容推理模型为新人物返回 `new_char_石瑛` 这类 Unicode 临时引用时，章节定稿被误判为「新人物临时引用无效」的问题；校验仍拒绝空格、标点和无法消除的引用。
- 将新人物临时引用的格式错误与重复错误拆分为可操作的 repair 提示，并在故事记忆系统提示词中明确唯一性与允许字符，避免第二次修复继续返回同类错误。
- 第一章故事记忆可正常推进后，第二章上下文恢复注入项目级全局故事状态。

### Tests

- 使用正式签名 release + 在线 OpenAI 兼容推理模型 + 长上下文窗口在 Android x86_64 模拟器复现定稿失败与全局状态缺失。
- 新增 Unicode、非法标点和重复 `tempRef` 定向测试，并对修复后的稳态做第一章定稿与第二章上下文注入回归。

## [2.5.1] - 2026-07-18

### Fixed

- 修复结构化故事记忆在模型请求已经发出后取消时被错误持久化为 `failed` 的问题：现在取消会保留已完成 checkpoint、恢复为 `dirty`，并允许继续重建。

### Changed

- 将长篇结构化故事记忆的正式发布版本统一推进至 V2.5.1，Schema 保持 15，不新增迁移。
- 发布文档明确区分确定 OpenAI 兼容服务的协议运行时验证与真实外部模型语义验收。

### Tests

- Android x86_64 模拟器完成 29 个非空章节完整重建、稳态输出、repair、两次非法失败、中途取消与继续、snapshot 回放和 clean 上下文注入。
- 非空备份在清除应用数据后恢复 Story Memory 三表完全一致，且 API Key 未进入备份。
- 最终本地门禁为 98 suites / 489 tests；覆盖率 statements 78.77% / branches 61.38% / functions 85.56% / lines 80.33%。

### Known limitations

- 真实外部模型的语义质量、限流与网络波动，以及 arm64 真机 llama.cpp 长上下文性能仍需专项验收。
- Android 16 KB page-size 对第三方原生库的对齐风险尚未关闭。

## [2.5.0] - 2026-07-18

### Added

- 新增长篇小说结构化故事记忆：项目级固定保存登场人物、人物关系和故事主线，每次章节生产行为连续性强制注入。
- 每章定稿由模型只生成带正文验证的增量补丁，程序负责严格校验、稳定 ID 分配、确定性合并和章节事件文本渲染。
- 新增 Schema 15 的 `project_story_memory`、`chapter_memory_patches`、`story_memory_snapshots`，支持原子保存、备份恢复、级联删除与按位快照。
- 新增 dirty 失效、base fingerprint 校验、补丁重用、取消/失败 checkpoint、完整重建和旧摘要快速初始化。
- 故事概览新增「故事记忆」页面，可查看状态、三类记忆、构建进度和最近错误，并执行快速初始化、继续、完整、取消或清空重建。
- 新增 `structured_story_memory_enabled` 回滚开关；关闭后保留新表并回退旧章节事件摘要定稿路径。

### Changed

- `chapters.memory_summary` 继续保留，但改由已验证 episodic patch 定性覆盖渲染；旧 TF-IDF Top-K 检索能力保留。
- 上下文顺序调整为 系统预设 → 项目故事状态 → 资料 → 相关历史章节事件 → 最近正文 → 当前章节指令。
- 自动上下文输入预算调整为正文 45% / 资料 20% / Story State 25% / Episodic Memory 10%，并新增每章补丁输出上限。
- 数据库 Schema 从 14 升级到 15；迁移只建表和索引，不会在启动或迁移时调用模型。

### Fixed

- IDF 缓存签名改为章节 ID、token 数和内容指纹组合，可识别长摘要内容变化。
- 修改、删除或重排已定稿章节会把 dirty 起点合并到最早受影响位置，不再静默注入已知过期的全局状态。
- 章节正文保存与记忆生成失败解耦；模型或事务失败不会回滚、清空正文或伪造新的定稿时间。

### Tests

- 新增领域合并、运行时校验、Schema 14→15、repository、LLM repair、定稿、重建、渲染、上下文、预算和 UI 定向测试。
- 自动化结果与覆盖率见本地测试报告。

### Known limitations

- Android 真机长篇场景、在线模型、本地 GGUF、强杀恢复与备份清空恢复仍需发布候选包补验。
- 旧摘要快速初始化依赖原摘要质量；准确性要求高的项目应主动完整重建正文。

## [2.4.6] - 2026-07-18

### Added

- 设置板块新增「上下文自动化配置」模块：用户填入模型支持的最大上下文（如 200000），系统按内置比例（输入 80% / 输出 20%）自动分配到 ContextConfig（滑动窗口 65% / 资料预算 20% / 摘要预算 15%）、PipelineConfig（草稿 50% / 审阅 15% / 事实核查 15% / 校对 20%）、`llm_config`、`presets` 和资源级 max_tokens 共 5 处配置点。
- 支持 128K / 200K / 512K / 1M 快捷按钮与自由输入，实时分配预览，一键应用与「恢复默认」。
- 资源级 max_tokens 按各表实际数量动态分摊（R1 算法），单项有最小下限兜底。
- 本地 GGUF 模型的 `context_window` 不被覆盖，由模型文件元数据保留。
- 应用过程走单一 `executeTransaction` 原子事务，写入失败整体回滚；记录「上次应用」卡片供回溯。

### Changed

- 不修改数据库 Schema 版本（保持 14），不引入新 npm 依赖。
- 设置页 AI 板块顶部新增独立入口。

### Tests

- 新增 `contextAutoAllocator` 与 `contextAutoRepository` 测试，覆盖分配算法典型/极大/极小/零资源、比例常量、repository 读写 round-trip、应用函数事务原子性与字段保留语义。
- 全量 Jest 基线通过。
- Android x86_64 模拟器端到端穿测 8 模块 0 崩溃，完整报告见本地测试报告。

### Known limitations

- `V2.4.6` 是工程验收 Tag，不含正式 Release / Minified Release APK（release 签名环境变量未配置）。
- 16KB page-size / RELRO 对齐警告仍然存在：`lib/{x86_64,arm64-v8a}/libllamacpp_jni.so` 等第三方 `.so` 未对齐，Android 15+ 真机无法启动；需 RN 0.85.x 的 16KB 兼容 patch + llama.cpp 重编后才能用于 Play Store 发布。

## [2.4.4] - 2026-07-16

### Added

- Added test-only migration/restore statement injection and real device flows for autosave kill, network interruption, and TTS background transitions.
- Added final per-flow Maestro/JUnit, logcat, UI-tree, screenshot, APK hash, and GitHub Actions evidence.

### Changed

- Node.js support is now `>=24.3.0`; CI uses Node 24.14.1.
- Jest CI and coverage run naturally without `--forceExit`, and GitHub Actions runs coverage once instead of executing the full suite twice.
- Backup publication now writes a staging file and atomically moves it into place after a successful write.
- The verification baseline is 82 Jest suites / 401 tests with 78.33% statements, 60.37% branches, 86.05% functions, and 79.95% lines.

### Fixed

- Autosave database failures propagate to exit guards and retain retryable pending state.
- Clearing chapter content now serializes with pending autosave and cannot be overwritten by a stale debounced write.
- Maestro selectors and navigation match the current Android UI, including API 37 compatibility prompts and deterministic pipeline cancellation.

### Known limitations

- `V2.4.4` is a Tag-only engineering release; no signed Release or Minified Release APK is attached because signing environment variables were unavailable.
- Migration-kill, restore-kill, GGUF-import-kill, and native OOM execution remain blocked by missing pause injectors/model assets; TTS background verification is partial because the API 37 emulator engine returned native error `-7` after playback began.
- API 37 reports a 16KB page-size/RELRO compatibility warning for native libraries; an ARM64 physical-device matrix remains required before distributing an RC APK.

### Security

- Fault-injection switches are test-only, cannot be enabled by remote input, and are disabled in Release builds.
- Release signing still requires process environment variables; no signing password, API key, or user database is committed.

### Removed

- No production capability was removed in V2.4.4.

## [2.4.3] - 2026-07-12

### Added

- Added Android llama.cpp local GGUF generation, import validation, progress reporting, cancellation, and local-model settings.
- Added Schema 14 runtime validation, note-mode compatibility repair, manifest-driven v3 backups, SHA-256 checksums, atomic restore, and external local-model references.
- Added TTS foreground keep-alive, unified notification permission handling, and background pipeline service timing fixes.

### Changed

- Release metadata is generated from `package.json`; Release signing requires explicit external environment variables.
- The database initialization path repairs known legacy defects before final schema validation.

### Fixed

- Fixed the legacy `project_note_config` upgrade path that could omit retrieval columns and make note-mode saving fail.
- Fixed world-book field preservation, background pipeline startup timing, and TTS foreground-service cleanup.

### Security

- Backup payloads do not contain LLM credentials; restoring a configuration clears any stale matching Keychain credential.

### Compatibility and upgrade risk

- Existing Schema 13 databases migrate to Schema 14. The startup repair path also handles databases that reached the current tables without all expected columns.
- Existing local GGUF files remain external assets and must be present or re-imported after restore; API keys must be entered again.

### Local model and API compatibility

- The supported local engine is Android llama.cpp with GGUF models. Online configuration remains OpenAI-compatible.

## [2.4.2] - 2026-07-11

### Added

- Added chapter-aware note navigation and chunking for the resource library.

### Changed

- Kept the database Schema unchanged from 2.4.1 while improving note retrieval context.

### Fixed

- Improved chapter selection and resource-library behavior for long notes.

### Security

- No new credential or network behavior was introduced in this release.

### Compatibility and upgrade risk

- No database migration is required from 2.4.1. Existing notes remain readable; chapter-aware indexing changes how long note content is presented to retrieval.

### Local model and API compatibility

- Local llama.cpp/GGUF and OpenAI-compatible API contracts remain unchanged.

## [2.4.1] - 2026-07-10

### Added

- Added stronger local-generation progress, startup, and failure feedback.

### Changed

- Hardened local-model generation controls, JNI concurrency/cancellation behavior, Qwen reasoning handling, and APK version-bundle validation.
- Kept the database Schema unchanged from 2.4.0.

### Fixed

- Fixed stale JavaScript bundles, cold-start pipeline results, inactive local configuration selection, and several local import/generation hangs.

### Security

- No new credential storage behavior was introduced in this release.

### Compatibility and upgrade risk

- No database migration is required from 2.4.0. Existing GGUF model records are retained; devices should re-test model loading after upgrading because native generation control changed.

### Local model and API compatibility

- GGUF models continue to use Android llama.cpp. OpenAI-compatible online endpoints remain supported.

## [2.4.0] - 2026-07-10

### Added

- Added the Android llama.cpp engine, JNI bridge, GGUF local-model manager, streaming generation, cancellation, and model lifecycle controls.
- Added TurboModule compatibility and regression coverage for the React Native 0.85 Android architecture.

### Changed

- Database Schema advanced from 12 to 13 for local-model metadata.
- The supported local-model path changed to GGUF + llama.cpp; the previous experimental local runtime was removed from the product path.

### Fixed

- Fixed native model-load/generation serialization, request cancellation races, model import state handling, and core TurboModule registration.

### Security

- Local GGUF inference runs on-device and does not require network access.

### Compatibility and upgrade risk

- Upgrading from 2.3.x runs the Schema 12 鈫?3 migration. Legacy local-model records may require re-import when their source file or runtime is no longer available.

### Local model and API compatibility

- Android supports `.gguf` models through llama.cpp. Online APIs remain OpenAI-compatible and are independent of the local engine.
