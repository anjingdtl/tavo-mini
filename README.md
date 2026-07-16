# ShineWriter / 小说工作台

<div align="center">

**Android 移动端小说创作、资料与 AI 工作台**

[![Platform](https://img.shields.io/badge/Platform-Android-3DDC84.svg)](#技术栈与支持范围)
[![React Native](https://img.shields.io/badge/React%20Native-0.85.3-61DAFB.svg)](https://reactnative.dev/)
[![Version](https://img.shields.io/badge/Version-V2.4.4-blue.svg)](CHANGELOG.md)
[![Tests](https://img.shields.io/badge/Tests-401%2F401%20passed-success.svg)](#测试与质量门禁)

</div>

ShineWriter 是一款 Android-only 的离线优先小说工作台，覆盖项目管理、章节写作、角色与世界书、笔记资料库、多阶段 AI 流水线、TTS 朗读、备份与恢复。小说数据默认留在设备上；只有用户主动发起在线模型或云端语音请求时，相关内容才会发送到配置的服务商。

当前版本：**V2.4.4** · 数据库 Schema：**14** · 最低 Android API：**24**

`V2.4.4` 是可靠性与发布验收 Tag：自动保存失败传播、清空正文竞态、Jest 自然退出、CI、Maestro 和可执行故障注入均已收口。该 Tag 不附带签名 APK；Release/Minified Release、ARM64 物理设备及部分故障场景仍需外部凭据或设备补验，详见 `docs/RELEASE_CHECKLIST.md`。

## 主要能力

| 模块 | 能力                                                                                        |
| ---- | ------------------------------------------------------------------------------------------- |
| 项目 | 创建、切换和删除小说项目；支持大纲模式与自由写作模式                                        |
| 写作 | 章节 CRUD、2 秒防抖自动保存、AI 续写/修订、草稿与版本回退                                   |
| 资料 | 角色卡 JSON/PNG 元数据导入、角色集合、世界书集合与条目、笔记资料库、预设                    |
| AI   | OpenAI 兼容在线 API；GGUF + Android llama.cpp 本地模型；草稿 → 审查 → 事实核查 → 校对流水线 |
| 语音 | 系统 TTS 与可配置语音服务；章节和选区朗读；前后台保活                                       |
| 备份 | Manifest 驱动的 v3 备份、SHA-256 校验、原子恢复、外部模型资源引用                           |
| 诊断 | LLM 用量日志、流水线任务状态、超时/取消/网络错误分类                                        |

## 技术栈与支持范围

- Android-only；`minSdk 24`，`compileSdk/targetSdk 36`。
- React Native `0.85.3`、React `19.2.3`、TypeScript `5.8`、Kotlin `2.1.20`。
- Node.js `>= 24.3.0`、JDK `17`、Android SDK 与 Gradle 环境。
- SQLite：数据库文件名为 `shine_writer.db`，位于 Android 应用私有数据目录，当前 Schema 为 14。
- 本地模型：仅支持 `.gguf`，由 Android `llama.cpp` JNI 引擎加载；模型文件放在应用私有模型目录，不上传服务器。
- 在线模型：OpenAI 兼容 Chat Completions 接口。默认只允许 HTTPS；局域网 HTTP 必须由用户显式开启，并限制在 `127.0.0.1`、`10/8`、`172.16/12`、`192.168/16`，公网 HTTP 永远拒绝。
- API Key：通过 `react-native-keychain` 写入 Android Keystore；`llm_config` 只保存配置名称、地址、模型等非密钥字段。备份文件不包含 API Key，恢复后需要重新填写。

## 数据、备份与隐私

- 章节、项目、资料、任务和用量日志默认保存在本机 SQLite；本地 GGUF 文件也保存在应用私有目录。
- 手动备份和自动备份写入应用专属外部目录的 `backups/` 子目录。
- v3 备份包含可恢复的业务表数据、Schema/应用版本和外部资源引用，并使用 SHA-256 校验；API Key 等凭据不进入备份。
- 恢复前会生成保护性备份，恢复过程使用原子事务；恢复的 LLM 配置不会带回旧设备的 Keychain 凭据。
- 在线 API 或云端语音调用时，API Key 和相应的小说文本会按服务商协议传输。开启局域网 HTTP 时，应用会明确提示内容可能以明文传输。

## 截图

| 项目首页                     | 写作页                        | LLM 设置                             |
| ---------------------------- | ----------------------------- | ------------------------------------ |
| ![项目首页](screen_main.png) | ![写作页](screen_writing.png) | ![LLM 设置](screen_llm_settings.png) |

## 快速开始

```bash
git clone https://github.com/anjingdtl/tavo-mini.git
cd tavo-mini
npm ci
```

启动 Metro：

```bash
npm start
```

连接 Android 模拟器或真机后运行开发版：

```bash
npm run android
```

## 构建与发布

APK 统一交付路径是 `dist/apk/{debug|release}/`：

| 命令                           | 产物                                                  |
| ------------------------------ | ----------------------------------------------------- |
| `npm run apk:debug`            | `dist/apk/debug/ShineWriter-V{version}-debug.apk`     |
| `npm run apk:release`          | `dist/apk/release/ShineWriter-V{version}-release.apk` |
| `npm run apk:release:minified` | R8/资源压缩 Release 评估包                            |

构建脚本会从 `package.json` 生成版本元数据、运行 Gradle，并把 APK 复制到上述交付目录。Release 构建必须显式提供以下环境变量，不会使用默认签名密码：

```text
SHINE_WRITER_RELEASE_STORE_FILE
SHINE_WRITER_RELEASE_STORE_PASSWORD
SHINE_WRITER_RELEASE_KEY_ALIAS
SHINE_WRITER_RELEASE_KEY_PASSWORD
```

发布后的 APK 从 [GitHub Releases](https://github.com/anjingdtl/tavo-mini/releases) 下载；尚未创建 Release 时，可在对应 GitHub Actions 运行页查看 CI 产物。每次正式发布还应在发布说明中附带 APK SHA-256。

## 测试与质量门禁

```bash
npm run lint
npm run typecheck
npm run test:ci
npm run test:coverage
npm run verify
```

当前本地验证基线：**82 个 Jest suite / 401 个测试通过**。最近一次覆盖率为 statements `78.33%`、branches `60.37%`、functions `86.05%`、lines `79.95%`；覆盖率门禁为全局 branches `55%`、functions `65%`、lines `65%`、statements `65%`，Schema、迁移、数据库和备份服务有更高的定向阈值。

`npx jest --runInBand --ci --detectOpenHandles` 可在 Node 24.14.1 上自然退出，不使用 `--forceExit`，无 open-handle 报告或超时。最终分支头的 GitHub Actions [Verify Run 29504809163](https://github.com/anjingdtl/tavo-mini/actions/runs/29504809163) 三个 Job 全部成功。

GitHub Actions `Verify` 对 `main` push 和 Pull Request 执行：

- JavaScript：lint、typecheck、Jest、coverage。
- Android Debug：`assembleDebug`。
- Migration matrix：迁移测试。

核心 UI 写作链路另有 `e2e/maestro/` 流程；真实 Android 验证使用 adb/UI tree 检查启动、项目/章节创建、自动保存、设置和持久化结果。

## 项目结构

```text
src/main/                         App 入口与主题/导航容器
src/navigation/                   Tab 与 Stack 导航
src/data/connection/              SQLite 连接、查询、事务边界
src/data/schema/                  当前 Schema 创建、初始化与运行时校验
src/data/repositories/            按领域拆分的数据访问层
src/services/llm/                 Provider、并发队列、超时和网络策略
src/services/pipelineRunner.ts    多阶段 AI 流水线
src/screens/chapter-editor/       章节编辑器组件与 hooks
src/store/                        Zustand 状态仓库
android/                          Android 原生、llama.cpp JNI、前台服务
__tests__/                        Jest 与 React Native 测试
e2e/maestro/                      可移植的核心流程 E2E 定义
scripts/                          版本生成、依赖补丁和 APK 构建脚本
dist/apk/                         本地 APK 交付目录
```

## 已知限制

- 当前只维护 Android 工程，不提供 iOS 构建目标。
- GGUF 模型的速度、可用上下文长度和内存占用取决于设备、量化方式和模型模板；本地模型请求会串行化，低内存事件会暂停新任务。
- 不同 OpenAI 兼容服务商的流式字段和错误格式可能不同；连接、普通请求、章节/流水线和本地无进展超时会分类反馈，但不会替服务商修复配置问题。
- 局域网 HTTP 只适合可信网络；公网 HTTP 不支持绕过安全策略。
- API Key 不随备份迁移，这是刻意的隐私边界；换设备或恢复备份后需要重新填写。
- TTS 的可用音色、后台行为和性能受 Android 版本及设备厂商实现影响。
- API 37 x86_64 模拟器会报告部分原生库的 16KB page-size/RELRO 兼容提示；ARM64 物理设备发布前仍需补验。
- `V2.4.4` 为 Tag-only 工程验收版本，不包含签名 Release APK 或 GitHub Release 附件。

## English summary

ShineWriter is an Android-only, offline-first novel-writing workspace built with React Native 0.85.3 and TypeScript. It includes project/chapter editing, character and world-book libraries, notes, a four-stage AI pipeline, TTS, backups, OpenAI-compatible APIs, and local GGUF inference through Android llama.cpp.

The current tag is **V2.4.4** with database Schema **14**. It is an engineering reliability tag without a signed Release APK. The app stores SQLite data and local models on-device. API keys are kept in Android Keystore through `react-native-keychain` and are excluded from backups. HTTPS is the default; opt-in HTTP is restricted to private IPv4 LAN ranges. See the Chinese sections above for build, test, release, privacy, and known-limit details.

## License

MIT License — see [LICENSE](LICENSE).
