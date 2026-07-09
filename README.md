# ShineWriter / 小说工作台

<div align="center">

**移动端小说创作 · 资料 · AI 工作台**

[![Platform](https://img.shields.io/badge/Platform-Android-3DDC84.svg)](#-技术栈)
[![React Native](https://img.shields.io/badge/React%20Native-0.85-61DAFB.svg)](https://reactnative.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/Version-V2.2.2-blue.svg)](CHANGELOG)
[![Tests](https://img.shields.io/badge/Tests-223%2F223%20passed-success.svg)](#-测试)

A mobile novel-writing studio with project management, world-book & character
library, multi-stage AI pipeline, voice dictation, and offline-first SQLite
storage.

[English](#-english) · [中文](#-中文)

</div>

---

## 📑 目录 / Table of Contents

- [🌟 项目亮点](#-项目亮点)
- [✨ 主要功能](#-主要功能)
- [🛠 技术栈](#-技术栈)
- [🚀 快速开始](#-快速开始)
- [📦 构建发布](#-构建发布)
- [🧪 测试](#-测试)
- [📁 项目结构](#-项目结构)
- [🔧 V2.2.2 更新日志](#-v222-更新日志)
- [🤝 贡献](#-贡献)
- [📄 许可证](#-许可证)
- [🇬🇧 English](#-english)

---

## 🌟 项目亮点

- **📱 完全离线优先** — 数据全部保存在本地 SQLite，断网也能写作；AI 调用是唯一外网依赖。
- **🤖 多角色 AI 流水线** — 4 阶段流水线（初稿作者 → 审阅编辑 + 事实核查员 → 终审校对员）协作生成高质量内容。
- **🌊 流式输出 + 后台保活** — 草稿阶段实时流式渲染；前台服务保活 + Wake Lock 让 App 切后台也能继续生成。
- **📚 富文本资料库** — 角色卡（PNG 元数据导入）、世界书集合、笔记资料库、预设管理。
- **🎙 语音朗读** — TTS 引擎集成，多音色多语速，章节正文一键朗读。
- **🔌 OpenAI 兼容接口** — 支持任何 OpenAI 兼容 API（DeepSeek、Moonshot、自部署等）。
- **🎨 自研三色主题** — `#439EA6 / #B0E0E3 / #D7F1F4` 全局色彩语言。

---

## ✨ 主要功能

| 模块 | 功能 |
|------|------|
| **项目** | 创建 / 删除 / 切换小说项目；大纲 / 自由模式选择 |
| **写作** | 章节 CRUD；正文 2 秒防抖自动保存；AI 续写 / 定稿 / 版本回退 |
| **资料** | 角色卡（PNG 元数据导入）；世界书（collection + entry 二级结构）；笔记（仿写 / 资料库模式）；预设管理 |
| **设置** | LLM 配置（多端点 + 测通）；流水线 4 阶段配置；TTS 引擎选择；后台运行开关 |
| **导出** | Markdown 导出；Android Documents 保存 |
| **诊断** | 任务用量统计；前端日志；崩溃追踪 |

---

## 🛠 技术栈

- **框架**: React Native 0.85.3 + React 19.2.3
- **语言**: TypeScript 5.8
- **导航**: React Navigation 7
- **状态管理**: Zustand 5
- **本地存储**: SQLite（react-native-sqlite-storage）+ AsyncStorage + Keychain（API Key）
- **网络**: fetch + SSE 流式（自实现 ReadableStream 适配）
- **原生模块**: Kotlin (PipelineForegroundService / PngMetadata / TtsAudio)
- **测试**: Jest 29 + @testing-library/react-native 13

---

## 🚀 快速开始

### 环境要求

- **Node.js** >= 22.11
- **Android SDK** + JDK 17 + Gradle 9
- **React Native CLI** 环境（`@react-native-community/cli`）

### 安装

```bash
git clone https://github.com/anjingdtl/tavo-mini.git
cd tavo-mini
npm install
```

### 启动 Metro

```bash
npm start
```

### 运行 Android

```bash
npm run android
```

或者先构建 APK 再安装：

```bash
npm run apk:debug      # 生成 dist/apk/debug/ShineWriter-V2.2.2-debug.apk
adb install -r dist/apk/debug/ShineWriter-V2.2.2-debug.apk
```

---

## 📦 构建发布

| 命令 | 产物 |
|------|------|
| `npm run apk:debug` | `dist/apk/debug/ShineWriter-V{version}-debug.apk` |
| `npm run apk:release` | `dist/apk/release/ShineWriter-V{version}-release.apk` |

构建脚本会自动：
1. 调用 `prebuild` 从 git commit 数生成 `versionCode` 和 `buildTime`
2. 调用 Gradle `assembleDebug` / `assembleRelease`
3. 拷贝 APK 到 `dist/apk/{variant}/`

---

## 🤖 本地离线模型（LiteRT-LM）

ShineWriter 支持导入 `.litertlm` 格式的本地模型，在飞行模式下也能运行 AI 生成。

- **仅支持 `.litertlm`**：通过「设置 → LLM 配置 → 本地离线模型 → 管理本地模型」导入。
- **模型存放位置**：导入后模型文件保存在应用私有目录，**不会**上传到任何服务器，运行时也不需要网络。
- **数据清除会删除模型**：卸载 App 或在系统设置中「清除存储空间」会一并删除已导入的本地模型，请保留原始文件备份。
- **离线运行**：选择本地模型配置后，AI 续写、润色、流水线等调用均不发送网络请求。
- **兼容性**：当前集成 LiteRT-LM `0.14.0`，GPU/CPU 后端自动选择；部分模型可能需要在真机上才能正常加载。

---

## 🧪 测试

```bash
npm test                # 跑全部 Jest 套件（45 suites / 223 tests）
npm run lint            # ESLint 全量检查
```

测试覆盖：数据库迁移、SQLite 事务、流水线各阶段、LLM 流式、笔记双模式、
上下文构建、备份/恢复、安全存储、UI 组件等核心模块。

---

## 📁 项目结构

```
tavo-mini/
├── src/
│   ├── components/         # 通用 UI 组件
│   ├── constants/          # 常量（主题色、默认值、版本号）
│   ├── navigation/         # 导航栈 + 全局跳转引用
│   ├── native/             # 原生模块 JS 侧包装
│   ├── screens/            # 屏幕组件
│   ├── services/           # 业务服务（database/llm/pipeline/...）
│   ├── store/              # Zustand 状态
│   ├── types/              # TypeScript 类型
│   ├── utils/              # 工具函数
│   └── main/               # App 入口
├── android/                # Android 原生工程
├── __tests__/              # Jest 测试套件（45 suites）
├── scripts/                # 构建/补丁脚本
└── dist/apk/               # 打包产物
```

---

## 🔧 V2.2.2 更新日志

V2.2.2 是一个 bug-fix 版本，聚焦于数据库稳定性和流水线可靠性：

### 修复

1. **🗄 SQLite InvalidStateError（DOM Exception 11）**
   `database.transaction(async (tx) => {...})` 在 await 处触发 transaction
   finalize，导致第二次 executeSql 抛错。修复：新增 `runInTransactionSafe`
   helper，把所有 7 处 transaction 调用方改造成「事务外预读 + 同步 push」。

2. **🧹 流水线冷启动清理 stale 任务**
   旧实现只在 `AppState.change='active'` 事件触发清理，但冷启动不发该事件，
   导致上次中断的流水线任务永远卡死。修复：在 `index.tsx` 启动序列主动
   调 `loadFromDB + markStaleTasksAsFailed()`。

3. **💬 LLM「保存并测试」弹窗文案**
   弹窗标题和正文都是「连接成功」造成视觉重复。修复：标题改为「测试通过」，
   正文显示真实模型名 + 模型回复内容。

### 测试

- 新增 2 个测试套件（`createProjectNoAsyncTransaction.test.ts`、
  `pipelineStaleOnColdStart.test.ts`），全量回归 223/223 通过。

---

## 🤝 贡献

欢迎提 Issue 和 PR：

1. Fork 仓库
2. 创建分支：`git checkout -b feature/your-feature`
3. 提交：遵循 Conventional Commits（`feat:` / `fix:` / `chore:` 等）
4. 测试：`npm test` + `npm run lint` 全绿
5. Push 并开 PR

---

## 📄 许可证

MIT License — 详见 [LICENSE](LICENSE)。

---

# 🇬🇧 English

## 🌟 Highlights

- **📱 Fully offline-first** — All data stored locally in SQLite; AI is the only network dependency.
- **🤖 Multi-role AI pipeline** — 4 stages (Draft Author → Reviewer + Fact-Checker → Final Proofreader) collaborate to produce high-quality prose.
- **🌊 Streaming + foreground keep-alive** — Real-time streaming during draft stage; `PipelineForegroundService` with Wake Lock keeps generation running even when the app is backgrounded.
- **📚 Rich resource library** — Character cards (PNG metadata import), world-book collections, notes, presets.
- **🎙 Voice dictation** — TTS engine integration with multiple voices and speeds; one-tap read-aloud for chapter body.
- **🔌 OpenAI-compatible API** — Works with any OpenAI-compatible endpoint (DeepSeek, Moonshot, self-hosted, etc.).
- **🎨 Custom tri-color theme** — `#439EA6 / #B0E0E3 / #D7F1F4` global color language.

## ✨ Features

| Module | Capabilities |
|--------|--------------|
| **Projects** | Create / delete / switch novel projects; outline vs. freeform mode |
| **Writing** | Chapter CRUD; 2-second debounced auto-save; AI continue / finalize / version rollback |
| **Library** | Character cards (PNG metadata import); world-book (collection + entry); notes (imitation / library mode); presets |
| **Settings** | LLM configuration (multi-endpoint + connectivity test); 4-stage pipeline config; TTS engine selection; background run toggle |
| **Export** | Markdown export via Android Documents |
| **Diagnostics** | Per-task token usage; in-app logs; crash tracking |

## 🛠 Tech Stack

- **Framework**: React Native 0.85.3 + React 19.2.3
- **Language**: TypeScript 5.8
- **Navigation**: React Navigation 7
- **State**: Zustand 5
- **Storage**: SQLite (react-native-sqlite-storage) + AsyncStorage + Keychain (API keys)
- **Network**: fetch + self-implemented SSE streaming adapter
- **Native modules**: Kotlin (PipelineForegroundService / PngMetadata / TtsAudio)
- **Tests**: Jest 29 + @testing-library/react-native 13

## 🚀 Quick Start

### Prerequisites

- **Node.js** >= 22.11
- **Android SDK** + JDK 17 + Gradle 9
- **React Native CLI** environment (`@react-native-community/cli`)

### Install

```bash
git clone https://github.com/anjingdtl/tavo-mini.git
cd tavo-mini
npm install
```

### Start Metro

```bash
npm start
```

### Run Android

```bash
npm run android
```

Or build the APK first and install:

```bash
npm run apk:debug      # outputs dist/apk/debug/ShineWriter-V2.2.2-debug.apk
adb install -r dist/apk/debug/ShineWriter-V2.2.2-debug.apk
```

## 📦 Building

| Command | Output |
|---------|--------|
| `npm run apk:debug` | `dist/apk/debug/ShineWriter-V{version}-debug.apk` |
| `npm run apk:release` | `dist/apk/release/ShineWriter-V{version}-release.apk` |

Build script will:
1. Call `prebuild` to generate `versionCode` and `buildTime` from git
2. Run Gradle `assembleDebug` / `assembleRelease`
3. Copy APK to `dist/apk/{variant}/`

## 🤖 Local Offline Models (LiteRT-LM)

ShineWriter supports importing `.litertlm` local models so AI generation works in airplane mode.

- **`.litertlm` only**: import via *Settings → LLM Config → Local Offline Model → Manage Local Models*.
- **Private app storage**: imported models are saved in the app's private directory; they are **never** uploaded and do not require a network connection at runtime.
- **Data clearing deletes models**: uninstalling the app or clearing storage in system settings will remove imported models. Keep the original files as a backup.
- **Offline execution**: when a local model config is selected, AI continue/finalize/pipeline calls do not send any network requests.
- **Compatibility**: currently integrates LiteRT-LM `0.14.0` with automatic GPU/CPU backend selection; some models may need a real device to load correctly.

---

## 🧪 Tests

```bash
npm test                # Run all Jest suites (45 suites / 223 tests)
npm run lint            # ESLint full check
```

Coverage: database migrations, SQLite transactions, pipeline stages, LLM
streaming, dual-mode notes, context building, backup/restore, secure storage,
UI components, and other core modules.

## 📁 Project Layout

```
tavo-mini/
├── src/
│   ├── components/         # Reusable UI components
│   ├── constants/          # Constants (theme, defaults, version)
│   ├── navigation/         # Navigation stack + global refs
│   ├── native/             # Native module JS wrappers
│   ├── screens/            # Screen components
│   ├── services/           # Business services (database/llm/pipeline/...)
│   ├── store/              # Zustand stores
│   ├── types/              # TypeScript types
│   ├── utils/              # Utilities
│   └── main/               # App entry
├── android/                # Android native project
├── __tests__/              # Jest suites (45 suites)
├── scripts/                # Build / patch scripts
└── dist/apk/               # Build artifacts
```

## 🔧 V2.2.2 Changelog

V2.2.2 is a bug-fix release focused on database stability and pipeline reliability:

### Fixed

1. **🗄 SQLite InvalidStateError (DOM Exception 11)**
   `database.transaction(async (tx) => {...})` finalized the transaction on
   the first await, throwing on subsequent executeSql. Fix: introduced
   `runInTransactionSafe` helper; refactored all 7 transaction call sites to
   "pre-read outside transaction, then sync-push into transaction".

2. **🧹 Cold-start cleanup of stale pipeline tasks**
   The previous implementation only cleaned up stale tasks on the
   `AppState.change='active'` event, which cold start does not emit, leaving
   `drafting` tasks permanently stuck. Fix: explicitly invoke
   `loadFromDB + markStaleTasksAsFailed()` in `index.tsx` startup sequence.

3. **💬 LLM "Save & Test" dialog copy**
   Title and body both rendered "连接成功", causing visual duplication.
   Fix: title changed to "测试通过"; body now shows the actual model name
   and reply content.

### Tests

- 2 new test suites added; full regression 223/223 passing.

## 🤝 Contributing

Issues and PRs are welcome:

1. Fork the repo
2. Create a branch: `git checkout -b feature/your-feature`
3. Commit using Conventional Commits (`feat:` / `fix:` / `chore:` etc.)
4. Test: ensure `npm test` + `npm run lint` pass
5. Push and open a PR

## 📄 License

MIT License — see [LICENSE](LICENSE).