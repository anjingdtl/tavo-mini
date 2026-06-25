# 系统 TTS 引擎接入设计稿

> 目标：在现有云端 TTS 之外，增加对安卓手机系统内置 TTS（`android.speech.tts.TextToSpeech`）的接入，让**没有云端语音 API 的用户开箱即用、零配置即可朗读**。两种引擎在语音设置顶部一键切换。

## 1. 目标与非目标

**目标**
- 新增「系统 TTS」朗读引擎：直接调用手机预装的 TTS 引擎合成并播放章节正文。
- 默认引擎为「系统 TTS」，新用户首次安装即可朗读，无需任何配置。
- 在语音设置顶部提供「系统 TTS / 云端 API」引擎切换；下方表单按引擎显示对应字段。
- 系统引擎支持：TTS 引擎选择、声线选择、语言、语速、音调、音量。
- 章节编辑器「朗读」按钮在系统引擎下永远可用，不再校验 API Key / URL。

**非目标**
- 不实现系统 TTS 的流式分段进度回调（采用全文一次性朗读）。
- 不实现字幕同步、高亮当前朗读句。
- 不引入第三方 TTS 库（如 `react-native-tts`），原生桥接直接使用系统 API。
- 不导出系统 TTS 音频为文件。
- 不改动云端 TTS 现有合成与播放链路。

## 2. 关键决策

- **引擎切换位于顶层**：`voiceStore.playChapter` 内根据 `engine` 字段分发到系统路径或云端路径，配置 / 存储 / UI / 调用链统一在一个引擎枚举上，互不干扰。
- **默认引擎为 `system`**：首次安装默认使用系统 TTS，达成「零配置即可朗读」。
- **扩展现有 `TtsAudioModule`**：系统 TTS 的原生方法与现有 `playAudioFile/stopAudio`（MediaPlayer）共存于同一个 Kotlin 模块，JS 端通过同一个 `NativeModules.TtsAudio` 访问，避免新增 package。
- **配置存储复用 settings 键值表**：新增 `tts_engine` 与 `system_tts_config` 两个键，与现有 `voice_config` 并行；不重构现有云端配置结构。
- **互斥播放**：系统 TTS 与云端 MediaPlayer 共用同一时刻只能有一个发声；`speak` 启动前先停止 MediaPlayer，反之亦然。

## 3. 架构

```text
ChapterEditor 「朗读」按钮
  │
  ▼
voiceStore.playChapter(text)
  │
  ├─ engine === 'system' ? ────────────────┐
  │                                         │
  ▼                                         ▼
System TTS Path                        Cloud TTS Path (现有, 不变)
  │                                         │
TtsAudio.speak(text, systemConfig)     services/tts.ts synthesizeToFile()
  │                                     → 临时音频文件
  ▼                                     → TtsAudio.playAudioFile(path)
Android TextToSpeech
  │
  ▼
扬声器播放
```

## 4. 数据模型

### 4.1 新增类型（`src/types/tts.ts`）

```ts
export type TtsEngine = 'system' | 'cloud';

export interface SystemTtsConfig {
  enginePackage: string;  // 选用的 TTS 引擎包名；空串 = 系统默认引擎
  voiceKey: string;       // 选用的声线 key；空串 = 引擎默认声线
  language: string;       // BCP 47 语言标签，如 'zh-CN'，影响声线过滤
  speed: number;          // 语速 0.1~10.0（1.0 = 正常，Android 标准）
  pitch: number;          // 音调 0.0~2.0（1.0 = 正常）
  volume: number;         // 音量 0~1（相对系统媒体音量的比例）
}

export interface SystemTtsEngineInfo {
  name: string;           // 引擎包名
  label: string;          // 显示名
  isDefault: boolean;
}

export interface SystemTtsVoiceInfo {
  key: string;            // 声线唯一 key
  name: string;           // 显示名
  locale: string;         // 语言区域
}
```

`VoiceConfig`（云端）保持不变。

### 4.2 settings 表新增配置键

已有 `settings(key TEXT PRIMARY KEY, value TEXT)`，新增三条：

| key | value |
|---|---|
| `tts_engine` | `'system'` 或 `'cloud'`；默认 `'system'` |
| `system_tts_config` | `SystemTtsConfig` 的 JSON |
| `voice_config` | 现有，云端用，不变 |

### 4.3 默认值（`src/constants/voice.ts` 新增）

```ts
export const DEFAULT_TTS_ENGINE: TtsEngine = 'system';

export const DEFAULT_SYSTEM_TTS_CONFIG: SystemTtsConfig = {
  enginePackage: '',  // 空 = 系统默认引擎
  voiceKey: '',       // 空 = 引擎默认声线
  language: 'zh-CN',
  speed: 1.0,
  pitch: 1.0,
  volume: 1.0,
};
```

## 5. 原生模块设计（`android/app/src/main/java/com/shinewriter/TtsAudioModule.kt`）

### 5.1 总体

现有 `playAudioFile` / `stopAudio` / `releasePlayer` / `stopAudioInternal` 完全不动。新增以下成员：

- 一个 `TextToSpeech tts` 字段，懒加载，单例
- 一个 `CompletableDeferred` / 回调字段跟踪当前 speak 的完成
- 一个 `UtteranceProgressListener` 监听朗读进度

### 5.2 新增 `@ReactMethod`

| 方法 | 签名 | 说明 |
|---|---|---|
| `speak` | `(text: String, config: ReadableMap, promise: Promise)` | 按 config 设置引擎/声线/语言/语速/音调/音量后朗读 |
| `stopSpeak` | `(promise: Promise)` | 停止系统 TTS 并 resolve |
| `isTtsReady` | `(promise: Promise)` | resolve bool，引擎是否初始化完成 |
| `getEngines` | `(promise: Promise)` | resolve `Array<{name,label,isDefault}>` |
| `getVoices` | `(enginePackage: String?, promise: Promise)` | resolve `Array<{key,name,locale}>` |

### 5.3 实现要点

- **初始化**：`TextToSpeech(context, initListener)`，`onInit(status)` 成功（`SUCCESS`）后标记 ready。首次 `speak` 调用如果引擎未就绪，等待初始化（最多几秒）再朗读，超时则 reject `"TTS_ENGINE_NOT_READY"`。
- **引擎/声线切换**：`speak` 内若 `config.enginePackage` 非空且与当前不同，先 `tts.setEngine(enginePackage)`（通过构造参数 `engine = ComponentName(...)` 或 `tts.defaultEngine` 切换）；然后 `tts.setLanguage(locale)` 与 `tts.voice = Voice(...)`（API 21+）。
- **参数**：`tts.setSpeechRate(speed)`、`tts.setPitch(pitch)`、`speak(..., volume, ...)`（`speak` 重载支持 pan/utteranceId）。
- **音频通道**：`tts.setAudioAttributes(AudioAttributes.Builder().setUsage(USAGE_MEDIA).setContentType(CONTENT_TYPE_SPEECH).build())`，确保走媒体音量而非通话音量。
- **完成回调约定**：原生 `speak` 的 promise 在**朗读开始（`onStart` 或参数设置完成、调用 `tts.speak(...)` 成功入队）时 resolve**，不等 `onDone`。这样 JS 层 `isPlaying=true` 表示「朗读已启动」，需由 `stop()` 或 App 退出置回 false（系统 TTS 没有像云端 MediaPlayer 那样的「整段播完自动 await 结束」语义）。
- **`UtteranceProgressListener`**：
  - `onStart(utteranceId)` — resolve 当前 speak promise（若尚未 resolve）
  - `onDone(utteranceId)` / `onError(utteranceId)` — 仅做内部清理（清空 pending promise 引用），**不**再 resolve/reject；朗读的真正结束由 JS 层 `stop()` 或用户操作驱动。这样可避免「朗读播完 → promise 才 resolve → isPlaying 才置 false」的延迟与云端语义不一致。
- **错误回调兜底**：若 `speak` 调用本身抛异常（引擎不可用、未就绪、参数非法），在 try/catch 中 reject 对应错误码。
- **互斥播放**：`speak` 开始前调用 `stopAudioInternal(rejectPending = true)` 停止 MediaPlayer；`playAudioFile` 开始前调用 `stopSpeakInternal()` 停止系统 TTS。
- **生命周期**：在 `onHostPause` / `onHostDestroy`（通过 `ReactApplicationContext.addActivityEventListener` 或生命周期监听）调用 `stopSpeak`，并在 destroy 时 `tts.shutdown()` 释放资源。
- **无可用引擎**：`getEngines()` 返回空数组时，设置页引擎下拉显示提示文本；`speak` 在 `tts == null || !ready` 时 reject `"TTS_ENGINE_UNAVAILABLE"`。

### 5.4 JS 桥接扩展（`src/native/TtsAudioModule.ts`）

```ts
import { NativeModules } from 'react-native';

interface SpeakConfig {
  enginePackage: string;
  voiceKey: string;
  language: string;
  speed: number;
  pitch: number;
  volume: number;
}

interface TtsAudioNative {
  // 现有
  playAudioFile(path: string): Promise<void>;
  stopAudio(): Promise<void>;
  // 新增
  speak(text: string, config: SpeakConfig): Promise<void>;
  stopSpeak(): Promise<void>;
  isTtsReady(): Promise<boolean>;
  getEngines(): Promise<Array<{ name: string; label: string; isDefault: boolean }>>;
  getVoices(enginePackage?: string): Promise<Array<{ key: string; name: string; locale: string }>>;
}

export const TtsAudio: TtsAudioNative = NativeModules.TtsAudio;
```

## 6. 服务层（`src/services/database.ts`）

新增四个方法，与现有 `getVoiceConfig/setVoiceConfig` 风格一致：

```ts
export async function getTtsEngine(): Promise<TtsEngine> {
  return ((await getSetting('tts_engine')) as TtsEngine) || 'system';
}

export async function setTtsEngine(engine: TtsEngine): Promise<void> {
  await setSetting('tts_engine', engine);
}

export async function getSystemTtsConfig(): Promise<SystemTtsConfig> {
  const raw = await getSetting('system_tts_config');
  if (!raw) return DEFAULT_SYSTEM_TTS_CONFIG;
  try {
    return { ...DEFAULT_SYSTEM_TTS_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SYSTEM_TTS_CONFIG;
  }
}

export async function setSystemTtsConfig(config: SystemTtsConfig): Promise<void> {
  await setSetting('system_tts_config', JSON.stringify(config));
}
```

无需数据库迁移（settings 表已是键值结构）。

## 7. 状态层（`src/store/voiceStore.ts`）

### 7.1 State 扩展

```ts
interface VoiceState {
  // 现有
  config: VoiceConfig;          // 云端配置
  apiKey: string;
  isSynthesizing: boolean;
  isPlaying: boolean;
  // 新增
  engine: TtsEngine;
  systemConfig: SystemTtsConfig;
  // ...
  loadVoiceConfig: () => Promise<void>;
  saveVoiceConfig: (config: VoiceConfig) => Promise<void>;
  saveSystemTtsConfig: (config: SystemTtsConfig) => Promise<void>;
  setEngine: (engine: TtsEngine) => Promise<void>;
  playChapter: (text: string) => Promise<void>;
  stop: () => Promise<void>;
}
```

### 7.2 `playChapter` 分发逻辑

```ts
playChapter: async (text) => {
  const state = get();
  if (state.isSynthesizing || state.isPlaying) return;
  if (!text.trim()) {
    Toast.show({ type: 'error', text1: '当前章节没有正文内容' });
    return;
  }

  if (state.engine === 'system') {
    set({ isSynthesizing: true });
    try {
      // 约定：原生 speak 在朗读开始时立即 resolve（详见 5.3「完成回调」），
      // 朗读完成的 onDone 仅用于内部资源清理，不驱动 isPlaying。
      // isPlaying=true 表示「正在朗读」，需由 stop() 或 App 退出置 false。
      await TtsAudio.speak(text, state.systemConfig);
      set({ isSynthesizing: false, isPlaying: true });
    } catch (error: any) {
      set({ isSynthesizing: false, isPlaying: false });
      Toast.show({ type: 'error', text1: error?.message || '朗读失败' });
    }
    return;
  }

  // 现有云端逻辑：保持不变
  // （含 apiKey.trim() 校验、isTtsTextTooLong、synthesizeToFile → playAudioFile）
}
```

**系统 TTS 完成时机约定**：原生 `speak(text, config)` 的 promise 在**朗读开始时** resolve（详见 5.3「完成回调约定」）。`isPlaying=true` 表示「朗读已启动」，需由 `stop()` 或 App 退出置回 false。这与云端路径（`playAudioFile` await 在播完时 resolve）语义不同，是有意为之——系统 TTS 的「整段播完」时机由原生 `onDone` 通知，但 JS 层不依赖它驱动 `isPlaying`，避免两条路径语义割裂时的实现复杂度。用户感知一致：点朗读 → 进入「停止」态 → 点停止或切引擎回到「朗读」态。

### 7.3 `stop` 覆盖两套引擎

```ts
stop: async () => {
  const { engine, isSynthesizing, isPlaying } = get();
  if (!isSynthesizing && !isPlaying) return;
  set({ isSynthesizing: false, isPlaying: false });
  if (engine === 'system') {
    try { await TtsAudio.stopSpeak(); } catch { /* ignore */ }
  } else {
    if (isSynthesizing) await cancelTts();
    if (isPlaying) try { await TtsAudio.stopAudio(); } catch { /* ignore */ }
  }
}
```

### 7.4 切换引擎时停止当前朗读

`setEngine` 在写入配置前先调用 `stop()`，避免切换瞬间出现两条声音。

## 8. UI（`src/screens/VoiceSettingsScreen.tsx`）

### 8.1 顶部引擎切换器

在 `<Header>` 之后、所有字段之前，加一个 `SegmentedControl`：

```tsx
<SegmentedControl
  value={engineDraft}
  options={[
    { value: 'system', label: '系统 TTS' },
    { value: 'cloud', label: '云端 API' },
  ]}
  onChange={(value) => onEngineChange(value)}
/>
```

切换时：先保存引擎选择，再根据值显示/隐藏下方表单组。

### 8.2 系统 TTS 模式字段

仅当 `engineDraft === 'system'` 时显示：

- **TTS 引擎**（下拉）：选项来自 `TtsAudio.getEngines()`，首项为「系统默认」；下拉为空时显示提示「未检测到 TTS 引擎，请前往手机系统设置安装」。
- **声线**（下拉）：选项来自 `TtsAudio.getVoices(enginePackage)`，按当前 `language` 过滤；首项「引擎默认」。
- **语言**（下拉或字段，简化版可直接用 language 列表）：候选 `['zh-CN', 'zh-TW', 'en-US']`。
- **语速 / 音调 / 音量**：复用现有 `Field` 数值输入，范围分别 `0.1~10.0 / 0.0~2.0 / 0~1`。
- **测试朗读**按钮：直接 `playChapter(SAMPLE_TEXT)`，无 Key 校验。

### 8.3 云端 API 模式字段

仅当 `engineDraft === 'cloud'` 时显示现有的全部字段（API Key / URL / 模型 / 音色 / 采样率 / 比特率 / 格式 / 语速音量音调），逻辑完全不变。

### 8.4 引擎/声线加载

- `VoiceSettingsScreen` 聚焦时（`useFocusEffect`）调用 `TtsAudio.getEngines()` 与（选中引擎后）`getVoices()` 填充下拉。
- 引擎切换后，若原选声线不在新引擎的声线列表中，自动回退为空（默认声线）。
- 加载失败显示空列表并提示。

## 9. 章节编辑器（`src/screens/ChapterEditor.tsx`）

唯一改动：`toggleTts` 中系统引擎模式下**移除 API Key 校验**（API Key 校验在云端路径，位于 `voiceStore.playChapter` 内部，系统路径天然不走那里）。按钮逻辑维持现状：

```tsx
const toggleTts = async () => {
  if (!chapter) return;
  if (isSynthesizing || isPlaying) {
    await stop();
    return;
  }
  await playChapter(chapter.content);  // engine 分发在 store 内完成
};
```

按钮文案沿用 `isSynthesizing ? '生成中…' : isPlaying ? '停止' : '朗读'`。系统 TTS 下 `isSynthesizing` 极短，用户感知是直接进入「停止」状态。

## 10. 边界与失败处理

| 场景 | 处理 |
|---|---|
| 系统无可用 TTS 引擎 | `getEngines()` 返回空 → 设置页引擎下拉显示提示；`speak` reject `"TTS_ENGINE_UNAVAILABLE"` → Toast「未找到 TTS 引擎，请前往系统设置安装」 |
| 引擎未初始化完成 | `speak` 内部等待 `onInit`（最多 ~3s）→ 超时 reject `"TTS_ENGINE_NOT_READY"` |
| 朗读中切换引擎 | `setEngine` 先 `stop()` 再切换 |
| 朗读中切换声线/参数 | 先 stop 当前朗读，再以新参数重新 speak（或直接 stop 让用户重新点） |
| App 切后台 | `onHostPause` 调用 `stopSpeak`，避免后台继续朗读 |
| App 退出 | `onHostDestroy` `stopSpeak` + `tts.shutdown()` 释放 |
| 无网络 | 系统 TTS 完全不受影响（核心优势） |
| 朗读文本为空 | `playChapter` 内统一校验，两个引擎共用 |
| 系统朗读自然播完 | `isPlaying` **不自动**复位（约定见 5.3）；按钮停留在「停止」态，用户需点一下停止或切换章节。若后续需要自动复位，可由原生 `onDone` 发送事件，但本期不实现 |

## 11. 测试

### 11.1 单元测试（Jest）

- **`__tests__/voiceStoreEngine.test.ts`**（新增）：mock `TtsAudio`，覆盖：
  - `engine === 'system'` 路径调用 `TtsAudio.speak`，不调用 `synthesizeToFile`
  - `engine === 'cloud'` 路径调用 `synthesizeToFile + playAudioFile`，不调用 `speak`
  - `stop` 在 system 引擎下调用 `TtsAudio.stopSpeak`，在 cloud 引擎下调用 `stopAudio`
  - 切换引擎时先 stop
- **`jest.setup.js`**：补充 `NativeModules.TtsAudio` 的 `speak / stopSpeak / isTtsReady / getEngines / getVoices` mock。

### 11.2 手动验收（`android-dev` skill / 真机）

由于原生模块 Jest 无法覆盖，以下场景必须在真机或模拟器跑通：

- 首次安装（清数据后）默认引擎为系统 TTS，点朗读立即发声
- 设置页切换到云端 API，配置后能朗读
- 系统 TTS 下切换引擎、切换声线、调语速/音调/音量后朗读正常
- 朗读中点停止、朗读中切换引擎、朗读中切后台
- 系统无 TTS 引擎的降级提示（若可模拟）

## 12. 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/types/tts.ts` | 新增 `TtsEngine`、`SystemTtsConfig`、`SystemTtsEngineInfo`、`SystemTtsVoiceInfo` |
| `src/constants/voice.ts` | 新增 `DEFAULT_TTS_ENGINE`、`DEFAULT_SYSTEM_TTS_CONFIG` |
| `src/services/database.ts` | 新增 `getTtsEngine/setTtsEngine/getSystemTtsConfig/setSystemTtsConfig` |
| `src/native/TtsAudioModule.ts` | 接口扩展 speak/stopSpeak/isTtsReady/getEngines/getVoices |
| `src/store/voiceStore.ts` | 新增 engine/systemConfig state、分发逻辑、stop 互斥 |
| `src/screens/VoiceSettingsScreen.tsx` | 顶部引擎切换 + 按引擎显示字段 |
| `src/screens/ChapterEditor.tsx` | 无逻辑改动（按钮已透明走 store 分发） |
| `android/app/src/main/java/com/shinewriter/TtsAudioModule.kt` | 新增 TextToSpeech 相关方法 |
| `__tests__/voiceStoreEngine.test.ts` | 新增引擎分发测试 |
| `jest.setup.js` | 补充 `NativeModules.TtsAudio` 新方法 mock |

无数据库 schema 版本升级，无新增第三方依赖。
