# ShineWriter TTS 小米 MIX 4 适配执行计划

> 基于 `docs/superpowers/specs/0704updataSPEC.md`
> 施工范围：Milestone A 完整实现 + Milestone B 最小脚手架（类型与功能开关，实际 ONNX 集成因依赖真机模型资产 deferred）
> 目标版本：`2.3.0`

---

## 目标

让 ShineWriter 在小米 MIX 4（Android 14）上稳定调用系统 TTS，解决引擎发现、初始化竞态、引擎切换、长文本分段、错误诊断等关键问题；保留云端 TTS 不变；为内置离线 TTS 预留扩展接口。

---

## 架构要点

- 原生层用状态机管理 `TextToSpeech` 生命周期，避免并发初始化和引擎切换竞态。
- 新增 `TtsTextChunker` 统一处理系统/内置 TTS 的长文本分段。
- `speak()` 按段驱动，首段入队成功后 resolve，完成/错误/停止通过事件通知。
- JS 层按 session 过滤事件，忽略旧会话迟到消息。
- 设置页串行执行 diagnostics → engines → voices，提供重新检测、打开设置、安装语音数据入口。

---

## 变更清单

| 类别 | 文件 |
|---|---|
| Manifest | `android/app/src/main/AndroidManifest.xml` |
| Kotlin 原生 | `android/app/src/main/java/com/shinewriter/TtsAudioModule.kt`（重构） |
| Kotlin 新增 | `android/app/src/main/java/com/shinewriter/TtsTextChunker.kt` |
| Kotlin 测试 | `android/app/src/test/java/com/shinewriter/TtsTextChunkerTest.kt` |
| JS 类型 | `src/types/tts.ts` |
| JS 原生桥接 | `src/native/TtsAudioModule.ts` |
| JS 状态 | `src/store/voiceStore.ts` |
| JS 设置页 | `src/screens/VoiceSettingsScreen.tsx` |
| JS 常量 | `src/constants/voice.ts` |
| Jest Mock | `jest.setup.js` |
| Jest 测试 | `__tests__/systemTtsCompatibility.test.ts` |
| 文档 | `docs/tts-xiaomi-debug.md` |

---

## Milestone A：系统 TTS 兼容修复

### Task 1：AndroidManifest 增加 TTS Service 查询声明

**文件：** `android/app/src/main/AndroidManifest.xml`

在 `<manifest>` 根节点下、`<application>` 之前插入：

```xml
<queries>
    <intent>
        <action android:name="android.intent.action.TTS_SERVICE" />
    </intent>
</queries>
```

不新增 `QUERY_ALL_PACKAGES` 或其他高风险权限。

验收：
- `npm run apk:debug` 能正常打包。
- `adb shell dumpsys package | Select-String "android.intent.action.TTS_SERVICE"` 能看到查询声明。

---

### Task 2：长文本分段器 `TtsTextChunker`

**新建：** `android/app/src/main/java/com/shinewriter/TtsTextChunker.kt`

实现 `object TtsTextChunker { fun split(text: String, maxLength: Int): List<String> }`。

切分优先级：
1. 连续空行（`\n\s*\n`）
2. 换行
3. 中文句末 `。！？`
4. 英文句末 `.!?`
5. 分号 `；;`
6. 逗号 `，,`
7. 字符硬切

约束：
- 过滤纯空白段；
- 每段非空且长度 ≤ maxLength；
- 不吞标点；
- 超长无标点字符串允许硬切。

**新建：** `android/app/src/test/java/com/shinewriter/TtsTextChunkerTest.kt`

覆盖：
- 短文本不分段；
- 中文句号分段；
- 中英混合；
- 连续换行；
- 超长无标点硬切；
- 每段长度上限；
- 拼接一致性；
- 空字符串；
- 仅空白字符串。

验收：
- `./gradlew :app:testDebugUnitTest --tests "com.shinewriter.TtsTextChunkerTest"` 通过。

---

### Task 3：重构 `TtsAudioModule.kt`

**文件：** `android/app/src/main/java/com/shinewriter/TtsAudioModule.kt`

按以下要求完整重构：

1. **状态机**
   - 新增 `enum class TtsInitState { IDLE, INITIALIZING, READY, FAILED }`。
   - 成员：`initState`、`initCallbacks`、`mainHandler`、`initTimeoutRunnable`。
   - 超时 8 秒。

2. **`ensureTts(requestedEngine, callback)`**
   - READY 且引擎匹配：立即回调 true。
   - INITIALIZING 且目标引擎相同：加入队列。
   - 引擎不同或 IDLE/FAILED：安全关闭旧实例，重新初始化。
   - 初始化在主线程触发；每个 callback 恰好调用一次。
   - 超时后状态 FAILED、shutdown、清空实例、所有 callback 返回 false。

3. **`shutdownTts(resetEngine)`**
   - 取消超时、stop、shutdown、清空 tts、ttsReady=false、initState=IDLE、按需清空 currentEnginePackage。
   - 捕获所有异常。

4. **`getEngines()`**
   - 返回 `name`、`label`、`isDefault`、`isCurrent`。

5. **`getVoices(enginePackage)`**
   - 真正切换到目标引擎（三参数构造函数）。
   - 初始化完成后读取 voices，按 locale/name 排序。
   - 返回 `key`、`name`、`locale`、`quality`、`latency`、`requiresNetwork`、`features`。

6. **`getDiagnostics(enginePackage?, language?)`**
   - 返回 `SystemTtsDiagnostics` 全部字段，包含设备信息、引擎信息、语言状态、voice 统计、maxInputLength。
   - 使用 `Locale.forLanguageTag()`，非法时回退 `Locale.SIMPLIFIED_CHINESE`。
   - 区分 `LANG_AVAILABLE/COUNTRY_AVAILABLE/VAR_AVAILABLE/MISSING_DATA/NOT_SUPPORTED`。

7. **`installTtsData()`**
   - 使用 `Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA)`。
   - `resolveActivity()` 后启动，不存在则返回 false。

8. **`openTtsSettings()`**
   - 依次尝试 `com.android.settings.TTS_SETTINGS`、`Settings.ACTION_ACCESSIBILITY_SETTINGS`、`Settings.ACTION_SETTINGS`。
   - 都加 `FLAG_ACTIVITY_NEW_TASK`，resolve 后启动，全部失败返回 false。

9. **`speak(text, config)`**
   - 新请求覆盖旧请求时，旧 pending promise reject `TTS_CANCELLED`。
   - 参数校验：speed 0.1~4.0、pitch 0.1~2.0、volume 0.0~1.0。
   - 语言检查：MISSING_DATA 返回 `TTS_LANGUAGE_DATA_MISSING`，NOT_SUPPORTED 返回 `TTS_LANGUAGE_NOT_SUPPORTED`。
   - 声线检查：`voiceKey` 不存在返回 `TTS_VOICE_NOT_FOUND`；`offlineOnly=true` 且需网络返回 `TTS_VOICE_REQUIRES_NETWORK`。
   - 文本分段：`maxLength = (TextToSpeech.getMaxSpeechInputLength() - 256).coerceAtLeast(500)`。
   - 会话：`TtsSession(sessionId, chunks)`，utteranceId 格式 `shinewriter:<sessionId>:<index>:<total>`。
   - 首段 `QUEUE_FLUSH` 入队，resolve；后续段在 `onDone` 中逐段驱动。
   - 事件：`ttsStart`（首段 onStart）、`ttsProgress`（每段开始）、`ttsDone`（最后一段完成）、`ttsError`（任意段失败）、`ttsStopped`（用户主动停止）。

10. **`stopSpeak()`**
    - 标记 session stopped、调用 tts.stop()、清空 activeSession、发送 `ttsStopped`、resolve。

11. **生命周期**
    - `onCatalystInstanceDestroy()` 停止 MediaPlayer、停止 TTS、shutdown、取消 Handler、清空状态、不发事件。

12. **日志**
    - 统一 Tag `ShineWriterTts`。
    - 记录厂商/型号/SDK、初始化状态、引擎、语言状态、分段数、段事件；不记录完整正文、API Key、隐私数据。

---

### Task 4：扩展 JS 类型 `src/types/tts.ts`

新增/修改：

```typescript
export type TtsEngine = 'system' | 'cloud' | 'builtin';

export interface SpeakConfig {
  enginePackage: string;
  voiceKey: string;
  language: string;
  speed: number;
  pitch: number;
  volume: number;
  offlineOnly?: boolean;
  allowEngineFallback?: boolean;
}

export interface SystemTtsEngineInfo {
  name: string;
  label: string;
  isDefault: boolean;
  isCurrent: boolean;
}

export interface SystemTtsVoiceInfo {
  key: string;
  name: string;
  locale: string;
  quality: number;
  latency: number;
  requiresNetwork: boolean;
  features: string[];
}

export type SystemTtsLanguageStatus =
  | 'available'
  | 'country_available'
  | 'variant_available'
  | 'missing_data'
  | 'not_supported'
  | 'unknown';

export interface SystemTtsDiagnostics {
  initialized: boolean;
  manufacturer: string;
  model: string;
  androidVersion: string;
  sdkInt: number;
  requestedEngine: string;
  currentEngine: string;
  defaultEngine: string;
  installedEngineCount: number;
  selectedEngineInstalled: boolean;
  language: string;
  languageStatus: SystemTtsLanguageStatus;
  voiceCount: number;
  matchingVoiceCount: number;
  offlineVoiceCount: number;
  maxInputLength: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface TtsSessionEvent {
  sessionId: string;
  enginePackage: string;
  chunkIndex: number;
  chunkCount: number;
}

export interface TtsErrorEvent extends TtsSessionEvent {
  errorCode: string;
  nativeErrorCode?: number;
  message: string;
}

// Milestone B 最小脚手架
export interface BuiltinTtsConfig {
  modelId: string;
  speakerId: number;
  speed: number;
  volume: number;
  autoDownload: boolean;
}

export interface BuiltinTtsModelManifest {
  id: string;
  displayName: string;
  version: string;
  language: string;
  engine: 'vits' | 'matcha';
  downloadUrl: string;
  archiveSize: number;
  installedSize: number;
  sha256: string;
  speakerCount: number;
  sampleRate: number;
  licenseName: string;
  licenseUrl: string;
  files: {
    model?: string;
    acousticModel?: string;
    vocoder?: string;
    tokens: string;
    lexicon?: string;
    ruleFsts?: string[];
    ruleFars?: string[];
    dataDir?: string;
  };
}
```

---

### Task 5：扩展原生桥接 `src/native/TtsAudioModule.ts`

新增方法到 `TtsAudioNative`：

```typescript
getDiagnostics(
  enginePackage?: string,
  language?: string,
): Promise<SystemTtsDiagnostics>;
installTtsData(): Promise<boolean>;
```

保持事件发射器单例。

---

### Task 6：改造 `src/store/voiceStore.ts`

1. 新增状态：
   - `activeTtsSessionId: string | null`
   - `ttsProgress: { chunkIndex; chunkCount } | null`
   - `lastTtsError: TtsErrorEvent | null`

2. `playChapter`：
   - 调用 speak 前重置上述状态，`isSynthesizing=true, isPlaying=false`。
   - speak resolve 后 `isSynthesizing=false, isPlaying=true`，并记录 `activeTtsSessionId`。

3. 事件监听：
   - 使用模块级单例保护，避免热重载/测试重复注册；提供 `initializeTtsListeners()`。
   - `ttsStart`：写入 sessionId，isPlaying=true。
   - `ttsProgress`：更新进度。
   - `ttsDone`：仅当 sessionId 匹配时清空。
   - `ttsError`：仅处理当前 session，恢复状态，显示映射后错误。
   - `ttsStopped`：恢复状态，不显示错误 Toast。

4. `stop`：
   - 即使 `isSynthesizing=true` 也调用 `stopSpeak()`，取消待处理请求。

5. 云端 TTS 路径保持不变。

---

### Task 7：改造 `src/screens/VoiceSettingsScreen.tsx`

1. 加载流程串行：
   - 进入页面先 `getDiagnostics()`；
   - 成功后 `getEngines()`；
   - 根据选中引擎 `getVoices()`。

2. 新增页面状态 `TtsDetectionState`：
   - `'idle' | 'detecting' | 'ready' | 'warning' | 'error'`

3. 新增显示：
   - 检测中/检测完成状态；
   - 当前默认引擎；
   - 已安装引擎数量；
   - 当前语言状态；
   - 匹配声线数量；
   - 离线声线数量；
   - 最大单段字符数；
   - 错误说明。

4. 新增按钮：
   - `重新检测`；
   - `打开系统语音设置`；
   - 缺少语音数据时显示 `尝试安装语音数据`。

5. 错误文案映射：
   - `TTS_NO_ENGINE` → 未检测到可用的系统语音引擎
   - `TTS_ENGINE_INIT_TIMEOUT` → 系统语音引擎响应超时，请重新检测
   - `TTS_ENGINE_INIT_FAILED` → 语音引擎初始化失败
   - `TTS_LANGUAGE_DATA_MISSING` → 当前引擎缺少中文语音数据
   - `TTS_LANGUAGE_NOT_SUPPORTED` → 当前引擎不支持所选语言
   - `TTS_VOICE_NOT_FOUND` → 已保存的声线不存在，请重新选择
   - `TTS_VOICE_REQUIRES_NETWORK` → 所选声线需要联网，不符合离线设置
   - `TTS_SPEAK_FAILED` → 系统未能开始朗读

6. 小米专用提示：
   - `manufacturer.toLowerCase() === 'xiaomi'` 且系统 TTS 不可用时，显示：
   - "小米系统可能未预装中文 TTS 引擎。可先打开系统语音设置安装语音数据，或切换到“内置离线 TTS"。"

7. 禁止引擎/声线并发请求。

---

### Task 8：扩展 `src/constants/voice.ts`

新增：

```typescript
export const ENABLE_BUILTIN_TTS = true;

export const DEFAULT_BUILTIN_TTS_CONFIG: BuiltinTtsConfig = {
  modelId: 'zh-default-v1',
  speakerId: 0,
  speed: 1.0,
  volume: 1.0,
  autoDownload: false,
};

export const SYSTEM_TTS_ERROR_MESSAGES: Record<string, string> = {
  TTS_NO_ENGINE: '未检测到可用的系统语音引擎',
  TTS_ENGINE_INIT_TIMEOUT: '系统语音引擎响应超时，请重新检测',
  TTS_ENGINE_INIT_FAILED: '语音引擎初始化失败',
  TTS_LANGUAGE_DATA_MISSING: '当前引擎缺少中文语音数据',
  TTS_LANGUAGE_NOT_SUPPORTED: '当前引擎不支持所选语言',
  TTS_VOICE_NOT_FOUND: '已保存的声线不存在，请重新选择',
  TTS_VOICE_REQUIRES_NETWORK: '所选声线需要联网，不符合离线设置',
  TTS_SPEAK_FAILED: '系统未能开始朗读',
  TTS_CANCELLED: '朗读已取消',
};
```

调整 `ENGINE_OPTIONS` 为动态读取 `ENABLE_BUILTIN_TTS`。

---

### Task 9：更新 Jest Mock

**文件：** `jest.setup.js`

更新 `NativeModules.TtsAudio` mock，新增：
- `getDiagnostics`
- `installTtsData`
- 事件发射支持（可测试 listener）。

保持 `addListener/removeListeners` mock。

---

### Task 10：新增 Jest 回归测试

**新建：** `__tests__/systemTtsCompatibility.test.ts`

覆盖：
1. 系统 TTS 调用 `speak()`，不调用云端合成；
2. 云端 TTS 行为不变；
3. `ttsDone` 恢复状态；
4. `ttsError` 恢复状态并保留错误详情；
5. 旧 session 迟到事件被忽略；
6. 初始化阶段调用 stop 仍执行 `stopSpeak()`；
7. 页面按顺序执行 diagnostics → engines → voices；
8. `LANG_MISSING_DATA` 显示正确文案；
9. 小米厂商提示只影响文案，不影响功能分支；
10. `requiresNetwork=true` 在离线过滤中被排除。

---

### Task 11：新增调试文档

**新建：** `docs/tts-xiaomi-debug.md`

包含：
- ADB 命令：
  - `adb shell settings get secure tts_default_synth`
  - `adb logcat -s ShineWriterTts TextToSpeech`
  - PowerShell `adb shell dumpsys package | Select-String "android.intent.action.TTS_SERVICE"`
- 常见故障：无引擎、缺少数据、初始化超时、声线不存在。

---

## Milestone B：内置离线 TTS 最小脚手架

### Task 12：扩展类型与功能开关

已完成于 Task 4 和 Task 8：
- `TtsEngine` 增加 `'builtin'`；
- `BuiltinTtsConfig`、`BuiltinTtsModelManifest` 类型；
- `ENABLE_BUILTIN_TTS` 开关；
- 设置页 `ENGINE_OPTIONS` 动态加入 `"内置离线"`。

不实现实际 sherpa-onnx 原生模块、模型下载和播放，因需要真机模型资产与 30 分钟稳定性验证，按规格可单独发布。

---

## 构建与发布

### Task 13：本地验证

依次执行：

```bash
npm test
npm run lint
```

修复所有失败。

### Task 14：Debug APK 构建

```bash
npm run apk:debug
```

确认产物：`dist/apk/debug/ShineWriter-V<ver>-debug.apk`。

### Task 15：问题修复

根据测试和构建结果修复问题。重点检查：
- Kotlin 编译错误；
- TypeScript 类型错误；
- Jest 失败；
- Lint 失败。

### Task 16：升级软件版本

修改 `package.json`：

```json
"version": "2.3.0"
```

运行 `npm run prebuild` 生成新 `src/constants/version.json`。

### Task 17：Release APK 构建

```bash
npm run apk:release
```

确认产物：`dist/apk/release/ShineWriter-V2.3.0-release.apk`。

如 release 签名失败，至少保证 Gradle release compile 通过并记录签名限制。

### Task 18：提交与推送

建议拆分为多个提交（可根据实际改动合并）：

1. `fix(android): declare TTS service visibility`
2. `feat(tts): add TTS text chunker with Kotlin tests`
3. `refactor(tts): native TTS initialization state machine and diagnostics`
4. `feat(tts): long-text chunked playback with session events`
5. `feat(ui): TTS settings detection, retry and Xiaomi hints`
6. `test(tts): system TTS compatibility regression tests`
7. `feat(tts): builtin offline TTS scaffolding`
8. `docs(tts): add Xiaomi MIX 4 debug guide`
9. `chore(release): bump version to 2.3.0`

最后：

```bash
git push origin main
```

---

## 验收标准

- [ ] Milestone A：Manifest 查询声明正确。
- [ ] Milestone A：原生 TTS 初始化状态机无并发竞态。
- [ ] Milestone A：指定引擎后声线查询来自正确引擎。
- [ ] Milestone A：能区分 `missing_data` 和 `not_supported`。
- [ ] Milestone A：长文本自动分段。
- [ ] Milestone A：完成/错误/停止事件携带 session 信息。
- [ ] Milestone A：JS 忽略旧会话迟到事件。
- [ ] Milestone A：设置页可重新检测并显示诊断。
- [ ] 全量 Jest 测试通过。
- [ ] `npm run lint` 通过。
- [ ] Debug APK 构建通过。
- [ ] Release APK 构建通过（或 compile 通过 + 签名说明）。
- [ ] 版本升级到 2.3.0。
- [ ] 提交并 push 到 main。

---

## 已知限制

- 真机 Xiaomi MIX 4 实际朗读效果需后续真机验证；本计划完成代码与本地构建验收。
- Milestone B 的实际 ONNX 模型集成、模型下载、AudioTrack 流式播放 deferred 到独立发布。
