# Changelog

All notable changes to ShineWriter are documented here. This file follows the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Version
numbers follow [Semantic Versioning](https://semver.org/).

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
- LLM 设置保存后弹窗同步流水线 max_tokens 是**可选的**：用户点「取消」则保留 PipelineConfigScreen 手动值；用户点「同步」则按 `RATIO_OUTPUT(0.2)` × `50/15/15/20` 覆盖 4 个 `pipeline_*_max_tokens` settings key。
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
- Story Memory 关系渲染改为「人物姓名[内部ID]」，并优先展示当前章节相关人物关系。
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

- Upgrading from 2.3.x runs the Schema 12鈫?3 migration. Legacy local-model records may require re-import when their source file or runtime is no longer available.

### Local model and API compatibility

- Android supports `.gguf` models through llama.cpp. Online APIs remain OpenAI-compatible and are independent of the local engine.
