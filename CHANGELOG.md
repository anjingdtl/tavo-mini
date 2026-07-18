# Changelog

All notable changes to ShineWriter are documented here. This file follows the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Version
numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

No unreleased changes are currently recorded.

## [2.5.1] - 2026-07-18

### Fixed

- 修复结构化故事记忆在模型请求已经发出后取消时被错误持久化为 `failed` 的问题；现在取消会保留已完成 checkpoint、恢复为 `dirty`，并允许继续重建。

### Changed

- 将长篇结构化故事记忆的正式发布版本统一推进至 V2.5.1，Schema 保持 15，不新增迁移。
- 发布文档明确区分确定性 OpenAI 兼容服务的协议/运行时验证与真实外部模型语义验收。

### Tests

- Android API 37 x86_64 模拟器完成 29 个非空章节完整重建、正常输出、repair、二次非法失败、在途取消与继续、snapshot 回放和 clean 上下文注入。
- 非空备份在清除应用数据后恢复 Story Memory 三表 1/29/2 行完全一致，且 API Key 未进入备份。
- 最终本地门禁为 98 suites / 489 tests；覆盖率 statements 78.77%、branches 61.38%、functions 85.56%、lines 80.33%。

### Known limitations

- 真实外部模型的语义质量、限流与网络波动，以及 arm64 真机 llama.cpp 长上下文性能仍需专项验收。
- Android 16 KB page-size 对话框报告的第三方原生库对齐风险仍未关闭。

## [2.5.0] - 2026-07-18

### Added

- 新增长篇小说结构化故事记忆：项目级固定保存登场人物、人物关系和故事主线，每次章节生成作为连续性约束强制注入。
- 每章定稿由模型只生成带正文证据的增量补丁，程序负责严格校验、稳定 ID 分配、确定性合并和章节事件文本渲染。
- 新增 Schema 15 的 `project_story_memory`、`chapter_memory_patches`、`story_memory_snapshots`，支持原子保存、备份恢复、级联删除与按位置快照。
- 新增 dirty 失效、base fingerprint 校验、补丁复用、取消/失败 checkpoint、完整重建和旧摘要快速初始化。
- 故事概览新增“故事记忆”页面，可查看状态、三类记忆、构建进度和最近错误，并执行快速初始化、继续、完整、取消或清空重建。
- 新增 `structured_story_memory_enabled` 回滚开关；关闭后保留新表并回退旧章节事件摘要定稿路径。

### Changed

- `chapters.memory_summary` 继续保留，但改为由已验证 episodic patch 确定性渲染；原 TF-IDF Top-K 检索能力保留。
- 上下文顺序调整为系统预设 → 项目故事状态 → 资料 → 相关历史章节事件 → 最近正文 → 当前章节指令。
- 自动上下文输入预算调整为正文 45% / 资料 20% / Story State 25% / Episodic Memory 10%，并新增每章补丁输出上限。
- 数据库 Schema 从 14 升级为 15；迁移只建表和索引，不会在启动或迁移时调用模型。

### Fixed

- IDF 缓存签名改为章节 ID、token 数和内容指纹组合，可识别等长摘要内容变化。
- 修改、删除或重排已定稿章节会把 dirty 起点合并到最早受影响位置，不再静默注入已知过期的全局状态。
- 章节正文保存与记忆生成失败解耦；模型或事务失败不会回滚、清空正文或伪造新的定稿时间。

### Tests

- 新增领域合并、运行时校验、Schema 14→15、repository、LLM repair、定稿、重建、渲染、上下文、预算和 UI 定向测试。
- 自动化结果与覆盖率见 [`docs/V2.5.0-STORY-MEMORY-TEST-REPORT.md`](docs/V2.5.0-STORY-MEMORY-TEST-REPORT.md)。

### Known limitations

- Android 真机 30 章场景、在线模型、本地 GGUF、强杀恢复与备份清空恢复仍需发布候选包补验。
- 旧摘要快速初始化依赖原摘要质量；准确性要求高的项目应主动执行完整正文重建。

## [2.4.6] - 2026-07-18

### Added

- 设置板块新增"上下文自动化配置"模块：用户填入模型支持的最大上下文（如 200000），系统按内置比例（输入 80% / 输出 20%）自动分配到 ContextConfig（滑动窗口 65% / 资料预算 20% / 摘要预算 15%）、PipelineConfig（草稿 50% / 审阅 15% / 事实核查 15% / 校对 20%）、llm_config、presets 和资源级 max_tokens 共 5 处配置点。
- 支持 128K / 200K / 512K / 1M 快捷按钮与自由输入，实时分配预览，一键应用与"恢复默认"。
- 资源级 max_tokens 按各表实际数量动态分摊（R1 算法），单项有最小下限兜底。
- 本地 GGUF 模型的 `context_window` 不被覆写，由模型文件元数据保留。
- 应用过程走单一 `executeTransaction` 原子事务，写入失败整体回滚；记录"上次应用"卡片供回显。

### Changed

- 不修改数据库 Schema 版本（保持 14）；不引入新的 npm 依赖。
- 设置页 AI 板块顶部新增独立入口。

### Tests

- 新增 `contextAutoAllocator`（19 个）与 `contextAutoRepository`（12 个）测试，覆盖分配算法典型/极大/极小/零资源/比例常量与 repository 读写 round-trip、应用函数事务原子性与字段保留语义。
- 全量 Jest 基线：84 套件 / 432 测试通过。
- emulator-5554（Android 17 / x86_64）端到端穿测 8 模块 0 崩溃，完整报告见 [`docs/V2.4.6-TEST-REPORT.md`](docs/V2.4.6-TEST-REPORT.md)（含 6 张关键截图）。

### Known limitations

- `V2.4.6` 是工程验收 Tag，不含签名 Release/Minified Release APK（`SHINE_WRITER_RELEASE_*` 环境变量未配置）。V2.4.4/V2.4.3/V2.4.2 的 release APK 在 `dist/apk/release/ShineWriter-V<ver>-release.apk` 已历史产物。
- 16KB 页大小 / RELRO 对齐警告仍然存在：`lib/{x86_64,arm64-v8a}/libllamacpp_jni.so`、`libreactnative.so`、`libhermesvm.so`、`libllama.so`、`libggml*.so`、`libsqliteJni.so` 等第三方 .so 未对齐，Android 15+ 真机无法启动；需 RN 0.85.x 的 16KB 兼容 patch + llama.cpp 重编后才能用于 Play Store 发布。

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

- Upgrading from 2.3.x runs the Schema 12→13 migration. Legacy local-model records may require re-import when their source file or runtime is no longer available.

### Local model and API compatibility

- Android supports `.gguf` models through llama.cpp. Online APIs remain OpenAI-compatible and are independent of the local engine.
