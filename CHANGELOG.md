# Changelog

## V2.4.0（未发布 / Unreleased）

### 新增 / Added

- **本地离线模型支持（LiteRT-LM）**
  - 支持导入 `.litertlm` 格式模型并在设备本地运行文本生成。
  - 新增「设置 → LLM 配置 → 本地离线模型」入口，可切换在线 API / 本地模型。
  - 新增「本地模型管理」页面：导入、验证、删除本地模型，显示文件大小与状态。
  - 本地模型文件保存在应用私有目录，运行时无需网络，卸载或清除数据会同步删除。
  - 集成 LiteRT-LM Android SDK `0.14.0`，支持 GPU / CPU 后端自动选择。

### 技术变更 / Technical

- 数据库 Schema 升级到 `12`：新增 `local_llm_models` 表，扩展 `llm_config` 表（`provider_type`、`local_model_id`、`local_backend`、`context_window`、`max_output_tokens`）。
- 引入 LLM Provider Registry，将现有 OpenAI 兼容 HTTP 调用抽取为 `openAICompatibleProvider`，并新增 `localLiteRtLmProvider`。
- Android 原生层新增 LocalLLM 模块：流式导入、SHA-256 校验、引擎加载、流式生成、取消与内存压力回调。
- 增加 ProGuard keep 规则保护 `com.google.ai.edge.litertlm.**`。
