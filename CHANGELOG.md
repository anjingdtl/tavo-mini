# Changelog

## V2.4.3（当前版本 / Current build）

### 新增 / Added

- **本地离线模型支持（GGUF + llama.cpp）**
  - 支持导入 `.gguf` 格式模型并在设备本地运行文本生成。
  - 新增「设置 → LLM 配置 → 本地离线模型」入口，可切换在线 API / 本地模型。
  - 新增「本地模型管理」页面：导入、验证、删除本地模型，显示文件大小与状态。
  - 本地模型文件保存在应用私有目录，运行时无需网络，卸载或清除数据会同步删除。
  - 集成 Android `llama.cpp` JNI 引擎，支持 GGUF 头校验、导入进度和流式生成。

### 技术变更 / Technical

- 数据库 Schema 当前为 `14`，迁移和运行时校验均使用事务安全路径。
- 备份格式升级为 v3：manifest 驱动、SHA-256 校验、凭据隔离和原子恢复；本地 GGUF 文件通过外部资源引用处理。
- Release 构建不再包含默认签名密码，版本号统一从 `package.json.version` 和显式构建号生成。

### 验证 / Verification

- Jest：68 suites / 320 tests 通过。
- Android Debug APK：`ShineWriter-V2.4.3-debug.apk` 构建通过。
