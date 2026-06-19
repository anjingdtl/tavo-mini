# MiniMax 语音朗读功能实现计划

> **For agentic workers:** 按以下任务逐项实现，每完成一项打勾并校验。

**Goal:** 在 Tavo Mini 章节编辑页接入 MiniMax Speech 2.8 语音合成，按预设音色朗读正文。

**Architecture:** 配置存 SQLite settings + API Key 存 Keystore；HTTP 调用 MiniMax `/v1/t2a_v2` 获取 hex 音频；RNFS 写入临时 MP3；原生 Kotlin `MediaPlayer` 播放；Zustand store 统一状态。

**Tech Stack:** React Native 0.85、TypeScript、fetch、RNFS、Keychain、Android MediaPlayer、Zustand、Jest。

---

### Task 1: 类型与常量

**Files:**
- Create: `src/types/tts.ts`
- Create: `src/constants/voice.ts`

**内容：**
- `VoiceConfig` 类型（model、voiceId、speed、vol、pitch、sampleRate、bitrate、format）。
- `VoicePreset` 类型。
- 预设音色列表 `VOICE_PRESETS`、默认配置 `DEFAULT_VOICE_CONFIG`、最大字符 `MAX_TTS_CHARS = 10000`。

---

### Task 2: 安全存储扩展

**Files:**
- Modify: `src/services/secureStorage.ts`

**内容：**
- 新增 `getSecureMiniMaxApiKey / setSecureMiniMaxApiKey / clearSecureMiniMaxApiKey`，service 为 `com.tavomini.minimax.api-key`。

---

### Task 3: 数据库配置读写

**Files:**
- Modify: `src/services/database.ts`

**内容：**
- 新增 `getVoiceConfig(): Promise<VoiceConfig>` 与 `setVoiceConfig(config: VoiceConfig): Promise<void>`，使用 `settings` 表 `voice_config` JSON 存储。

---

### Task 4: TTS 服务

**Files:**
- Create: `src/services/tts.ts`

**内容：**
- `synthesizeToFile(text, voiceConfig, apiKey): Promise<string>`：构造 HTTP 请求、校验响应、hex 转 base64、RNFS 写临时文件。
- `cancelTts()`：取消进行中的 fetch 并清理文件。
- 错误统一抛中文异常。

---

### Task 5: 原生音频播放模块

**Files:**
- Create: `android/app/src/main/java/com/tavomini/TtsAudioModule.kt`
- Create: `android/app/src/main/java/com/tavomini/TtsAudioPackage.kt`
- Create: `src/native/TtsAudioModule.ts`
- Modify: `android/app/src/main/java/com/tavomini/MainApplication.kt`

**内容：**
- Kotlin 模块暴露 `playAudioFile(path)`（播放完成后 resolve）和 `stopAudio()`。
- `Package` 注册，`MainApplication` 的 PackageList 中添加。
- TS 桥接 `NativeModules.TtsAudio`。

---

### Task 6: 语音状态管理

**Files:**
- Create: `src/store/voiceStore.ts`

**内容：**
- 加载/保存 `voiceConfig` 与 MiniMax API Key。
- `playChapter(text)`：校验 Key、调用 TTS、播放文件、管理 `isSynthesizing / isPlaying`。
- `stop()`：停止播放、取消合成、清理文件。

---

### Task 7: 语音设置页

**Files:**
- Create: `src/screens/VoiceSettingsScreen.tsx`

**内容：**
- API Key 输入、模型切换、音色选择（预设列表 + 自定义输入）、语速/音量/语调输入、采样率/比特率/格式。
- 「测试朗读」「保存」按钮。

---

### Task 8: 设置入口与路由

**Files:**
- Modify: `src/screens/SettingsScreen.tsx`
- Modify: `src/navigation/TabNavigator.tsx`

**内容：**
- SettingsScreen AI 区块新增「语音朗读」卡片与入口。
- SettingsStackParamList 与 SettingsStackScreen 注册 `VoiceSettings`。

---

### Task 9: 章节编辑页朗读入口

**Files:**
- Modify: `src/screens/ChapterEditor.tsx`

**内容：**
- 工具栏新增「朗读 / 停止」按钮。
- 调用 `voiceStore.playChapter` / `voiceStore.stop`。
- 空内容、超长内容 Toast 提示。

---

### Task 10: 测试与 Mock

**Files:**
- Modify: `jest.setup.js`
- Create: `__tests__/tts.test.ts`
- Create: `__tests__/voiceStore.test.ts`（可选）

**内容：**
- mock `NativeModules.TtsAudio`。
- 测试 hex 转换、请求构造、超长截断、响应错误处理。
- 测试 VoiceSettingsScreen 保存交互（可选）。

---

### Task 11: 校验

**命令：**
- `npm run lint`
- `npm test`

**预期：** ESLint 无错误，Jest 全部通过。
