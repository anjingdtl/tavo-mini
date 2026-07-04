# ShineWriter TTS 小米 MIX 4 调试指南

> 本指南用于在小米 MIX 4（Android 14）上排查系统 TTS 与内置离线 TTS 相关故障。

---

## ADB 常用命令

### 查看默认 TTS 引擎

```bash
adb shell settings get secure tts_default_synth
```

### 查看应用是否声明了 TTS Service 查询

Windows PowerShell：

```powershell
adb shell dumpsys package | Select-String "android.intent.action.TTS_SERVICE"
```

### 抓取 TTS 相关日志

```bash
adb logcat -c
adb logcat -s ShineWriterTts TextToSpeech
```

### 列出已安装 TTS 引擎

```bash
adb shell pm query-services -a android.intent.action.TTS_SERVICE
```

---

## 常见故障与排查

### 1. 未检测到可用的系统语音引擎

**现象：** 设置页显示 `TTS_NO_ENGINE`，`已安装引擎` 为 0。

**根因：** 小米国行 ROM 可能未预装 Google TTS，也未预装其他中文 TTS 引擎。

**处理：**

1. 点击 `打开系统语音设置`，检查是否有可用引擎。
2. 如系统设置中无引擎，需用户自行安装第三方 TTS（如 Google 文字转语音、讯飞语记等）。
3. 或切换到 `内置离线 TTS`（Milestone B）。

### 2. 当前引擎缺少中文语音数据

**现象：** `languageStatus` 为 `missing_data`，点击测试朗读失败。

**根因：** 引擎已安装，但未下载中文语音包。

**处理：**

1. 点击 `尝试安装语音数据`。
2. 如系统无响应，点击 `打开系统语音设置` 手动下载。
3. 小米设备建议进入 `设置 > 更多设置 > 无障碍 > 文字转语音 (TTS)` 安装语音数据。

### 3. 系统语音引擎响应超时

**现象：** `TTS_ENGINE_INIT_TIMEOUT`，日志中 `initializeTtsInstance start` 后 8 秒无 `success`/`failed`。

**根因：** 部分厂商 TTS 引擎初始化缓慢或卡住。

**处理：**

1. 重新检测。
2. 切换其他 TTS 引擎。
3. 在系统设置中清除 TTS 引擎缓存。

### 4. 已保存的声线不存在

**现象：** `TTS_VOICE_NOT_FOUND`。

**根因：** 用户曾选择某个声线，但该声线在当前引擎中不存在。

**处理：** 重新进入语音设置，选择当前引擎支持的声线。

### 5. 长文本分段异常

**现象：** 长章节朗读到某一段后停止或报错。

**排查：**

1. 查看日志中 `starting TTS session=xxx chunks=N maxLength=M`。
2. 若某段触发 `onError`，日志会显示 `utterance error` 与 native error code。
3. 检查 `maxInputLength` 是否过小（部分引擎限制 4000 字符）。

### 6. 云端 TTS 行为异常

**现象：** 切换到云端后无法播放或停止后仍有声音。

**排查：**

1. 确认已配置 API Key。
2. 检查网络连接。
3. 停止播放时确认 `cancelTts` 与 `stopAudio` 均被调用。

---

## 内置离线 TTS 调试（Milestone B）

### 查看模型目录

```bash
adb shell run-as com.shinewriter ls files/tts-models
```

### 检查模型文件完整性

每个模型目录应包含 `installed.json` 及 manifest 中声明的必要文件。

### 离线验收

1. 开启飞行模式。
2. 进入语音设置，切换到 `内置离线`。
3. 点击测试朗读。
4. 抓取日志确认无网络请求。

---

## 日志 Tag 说明

- `ShineWriterTts`：应用 TTS 模块主日志。
- `TextToSpeech`：Android 系统 TTS 框架日志。

---

## 已知限制

- Milestone A 仍依赖设备实际安装的 TTS 引擎和中文语音数据。
- Milestone B 需要用户主动下载模型，首次初始化可能需要数秒。
- 熄屏持续朗读需要额外前台服务（Milestone B.1），当前版本未实现。
