# MiniMax 语音朗读功能设计稿

> 目标：在章节编辑页按预设音色朗读正文，音色、语速等可在设置中配置。

## 1. 目标与非目标

**目标**
- 接入 MiniMax Speech 2.8（HTTP 同步语音合成），按章节正文生成语音。
- 提供可配置的音色预设（voice_id）、语速、音量、语调、模型（speech-2.8-hd / speech-2.8-turbo）。
- 在章节编辑工具栏增加「朗读 / 停止」入口。
- 语音合成音频整段生成完成后在 Android 端播放。

**非目标**
- 不实现边生成边流式播放（按用户选择先采用整段生成后播放）。
- 不实现多音色混音、自定义复刻音色、字幕文件处理。
- 不将语音文件长期保存或导出。

## 2. 关键决策

- **API Key**：单独配置并安全存储 MiniMax API Key，不与 LLM 配置复用。
- **播放方案**：新增原生 Kotlin 音频模块 `TtsAudioModule`，使用 Android `MediaPlayer` 播放本地 MP3，避免引入第三方音频库。
- **合成方案**：使用 MiniMax HTTP 同步接口 `POST https://api.minimaxi.com/v1/t2a_v2`（React Native 标准 WebSocket 不支持自定义 Authorization Header，故改用功能完全相同的 HTTP 接口）。
- **配置存储**：语音配置以 JSON 形式存入 `settings` 表 `key = 'voice_config'`；API Key 存入 Android Keystore（`react-native-keychain`）。
- **文本限制**：单次朗读按 MiniMax 限制最多 10,000 字符，超长时取前 10,000 字符并提示用户。

## 3. 架构

```text
ChapterEditor
  │
  ├─ 点击「朗读」
  │
  ▼
TtsService (src/services/tts.ts)
  │
  ├─ 读取 voiceConfig + 安全存储中的 MiniMax API Key
  ├─ POST https://api.minimaxi.com/v1/t2a_v2
  ├─ 解析返回的 hex 音频
  ├─ 写入 RNFS 临时文件
  │
  ▼
TtsAudioModule (Android MediaPlayer)
  │
  ▼
扬声器播放
```

## 4. 数据模型

### 4.1 settings 表新增配置项

已存在 `settings(key TEXT PRIMARY KEY, value TEXT)`，新增一条：

| key | value（JSON）|
|---|---|
| `voice_config` | `{ model, voiceId, speed, vol, pitch, sampleRate, bitrate, format }` |

### 4.2 TypeScript 类型

```ts
// src/types/tts.ts
export interface VoiceConfig {
  model: 'speech-2.8-hd' | 'speech-2.8-turbo';
  voiceId: string;
  speed: number;   // 0.5 ~ 2
  vol: number;     // 0 ~ 10
  pitch: number;   // -12 ~ 12
  sampleRate: 16000 | 24000 | 32000 | 44100;
  bitrate: 32000 | 64000 | 128000;
  format: 'mp3' | 'wav' | 'flac';
}
```

### 4.3 安全存储

- service：`com.shinewriter.minimax.api-key`
- account：`minimax-api-key`
- 与现有 `secureStorage.ts` 风格一致，新增 `getSecureMiniMaxApiKey / setSecureMiniMaxApiKey / clearSecureMiniMaxApiKey`。

## 5. 预设音色列表

内置一批 MiniMax 官方系统音色供选择（可在设置页下拉选择，也允许用户手动输入自定义 voice_id）：

```ts
export const VOICE_PRESETS = [
  { id: 'male-qn-qingse', name: '青涩青年' },
  { id: 'male-qn-jingying', name: '精英青年' },
  { id: 'male-qn-badao', name: '霸道青年' },
  { id: 'male-qn-daxuesheng', name: '青年大学生' },
  { id: 'female-shaonv', name: '少女' },
  { id: 'female-yujie', name: '御姐' },
  { id: 'female-chengshu', name: '成熟女性' },
  { id: 'female-tianmei', name: '甜美女性' },
  { id: 'audiobook_male_1', name: '男性有声书 1' },
  { id: 'audiobook_male_2', name: '男性有声书 2' },
  { id: 'audiobook_female_1', name: '女性有声书 1' },
  { id: 'audiobook_female_2', name: '女性有声书 2' },
  { id: 'English_expressive_narrator', name: '英文叙事男声' },
];
```

## 6. 服务层接口

```ts
// src/services/tts.ts
export interface TtsOptions {
  text: string;
  voiceConfig: VoiceConfig;
  apiKey: string;
  onProgress?: (receivedBytes: number) => void;
}

export async function synthesizeToFile(options: TtsOptions): Promise<string>;
export function cancelSynthesis(): void;
```

返回值为本地 MP3 文件绝对路径。`cancelSynthesis` 用于关闭 WebSocket 并清理。

## 7. HTTP 同步接口实现

参考 MiniMax 文档 `POST https://api.minimaxi.com/v1/t2a_v2`：

请求体：
```json
{
  "model": "speech-2.8-hd",
  "text": "正文内容",
  "stream": false,
  "output_format": "hex",
  "voice_setting": {
    "voice_id": "male-qn-qingse",
    "speed": 1,
    "vol": 1,
    "pitch": 0
  },
  "audio_setting": {
    "sample_rate": 32000,
    "bitrate": 128000,
    "format": "mp3",
    "channel": 1
  }
}
```

响应：
```json
{
  "data": { "audio": "<hex>", "status": 2 },
  "base_resp": { "status_code": 0, "status_msg": "success" }
}
```

流程：
1. `fetch` 发送请求，Header 带 `Authorization: Bearer {apiKey}`。
2. 校验 `base_resp.status_code === 0`。
3. 将 `data.audio` 的 hex 字符串转为 base64。
4. 使用 `RNFS.writeFile(filepath, base64Audio, 'base64')` 写入本地文件。
5. 返回本地文件路径。

异常处理：
- 网络失败、HTTP 非 200、`base_resp.status_code !== 0` → 抛出中文错误。
- 用户点击停止 → 取消后续播放并删除已生成的临时文件。

## 8. 原生音频模块

### 8.1 Kotlin 模块 `TtsAudioModule`

路径：`android/app/src/main/java/com/shinewriter/TtsAudioModule.kt`

暴露方法：
- `playAudioFile(path: String, promise: Promise)`：用 `MediaPlayer` 播放本地音频，播放结束后释放资源。
- `stopAudio(promise: Promise)`：停止并释放当前 `MediaPlayer`。

### 8.2 TypeScript 桥接

```ts
// src/native/TtsAudioModule.ts
import { NativeModules } from 'react-native';
export const TtsAudio = NativeModules.TtsAudio;
```

### 8.3 注册

在 `MainApplication.kt` / package list 中注册 `TtsAudioPackage`。

## 9. UI 设计

### 9.1 设置入口

在 `SettingsScreen` 的「AI」区块新增卡片：
- 标题：语音朗读
- 描述：配置 MiniMax Key、音色与语速。
- 按钮：语音设置 → 跳转 `VoiceSettingsScreen`。

### 9.2 VoiceSettingsScreen

- MiniMax API Key（安全输入框，保存到 Keystore）。
- 模型选择：`speech-2.8-hd` / `speech-2.8-turbo`。
- 音色选择：下拉选择预设，或切换为自定义输入。
- 语速、音量、音调滑块 / 数字输入。
- 音频设置：采样率、比特率、格式（默认 32k / 128000 / mp3）。
- 「测试朗读」按钮：使用当前配置朗读一段示例文本，验证连接与音色。
- 「保存」按钮。

### 9.3 章节编辑页

在 `ChapterEditor` 工具栏新增按钮：
- 未播放时显示「朗读」，图标 `Volume2`。
- 合成中显示「生成中…」，禁用并显示 loading。
- 播放中显示「停止」，图标 `Square`；点击停止播放并取消合成。
- 长按/提示：朗读时取正文内容，超长自动截断并 Toast 提示。

## 10. 状态管理

新增 `src/store/voiceStore.ts`：

```ts
interface VoiceState {
  config: VoiceConfig;
  apiKey: string;
  isPlaying: boolean;
  isSynthesizing: boolean;
  loadVoiceConfig: () => Promise<void>;
  saveVoiceConfig: (config: VoiceConfig) => Promise<void>;
  setMiniMaxApiKey: (key: string) => Promise<void>;
  playChapter: (text: string) => Promise<void>;
  stop: () => Promise<void>;
}
```

`voiceStore` 负责协调配置加载、安全存储读写和播放控制。实际 WebSocket 与文件写入由 `TtsService` 处理。

## 11. 测试策略

- 单元测试 `__tests__/tts.test.ts`：
  - WebSocket 消息解析、hex 转 base64 写入文件逻辑。
  - 超长文本截断逻辑。
  - 配置序列化/反序列化。
- 组件测试：
  - `VoiceSettingsScreen` 渲染、保存按钮触发 store 方法。
  - `ChapterEditor` 朗读按钮状态切换。
- Jest mock：
  - 在 `jest.setup.js` 新增 `TtsAudio` 原生模块 mock。
  - 已有 `react-native-fs` mock 需要支持 `writeFile` base64 写入。

## 12. 风险与回退

- **WebSocket 在 Android 网络受限环境失败**：界面提示检查网络和 API Key；保留用户配置不丢失。
- **音频文件写入失败**：捕获异常并 Toast 提示。
- **原生模块编译问题**：若 MediaPlayer 在目标 Android 版本有变更，使用 `android.media.MediaPlayer` 标准 API，minSdk 24 已支持。

## 13. 文件变更清单

- 新增
  - `src/types/tts.ts`
  - `src/services/tts.ts`
  - `src/store/voiceStore.ts`
  - `src/screens/VoiceSettingsScreen.tsx`
  - `src/native/TtsAudioModule.ts`
  - `android/app/src/main/java/com/shinewriter/TtsAudioModule.kt`
  - `android/app/src/main/java/com/shinewriter/TtsAudioPackage.kt`
  - `__tests__/tts.test.ts`
- 修改
  - `src/services/secureStorage.ts`（新增 MiniMax Key 方法）
  - `src/services/database.ts`（新增 voice_config settings 读写）
  - `src/screens/SettingsScreen.tsx`（新增语音设置入口）
  - `src/screens/ChapterEditor.tsx`（新增朗读按钮与状态）
  - `src/navigation/TabNavigator.tsx`（注册 VoiceSettings 路由）
  - `jest.setup.js`（mock TtsAudio）
