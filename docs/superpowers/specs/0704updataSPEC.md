# ShineWriter / tavo-mini：小米 MIX 4（Android 14）本地 TTS 适配规格

> 文档类型：可执行工程规格（Implementation SPEC）  
> 目标仓库：`anjingdtl/tavo-mini`  
> 目标平台：Android 14，重点设备为小米 MIX 4  
> 当前技术栈：React Native 0.85.3、TypeScript、Kotlin 原生模块  
> 当前应用版本基线：V2.2.3 附近；施工前必须以 `main` 最新代码为准重新确认文件内容  
> 文档状态：Ready for implementation

---

## 0. Agent 执行指令

本规格用于代码 Agent 直接对照施工。执行时必须遵守以下规则：

1. 先阅读完整规格，再开始修改代码。
2. 不得删除现有云端 TTS 功能。
3. 不得把现有 `PipelineForegroundService` 改造成 TTS 播放服务。
4. 每完成一个里程碑都必须运行测试、构建 APK，并记录结果。
5. 遇到当前仓库结构与本规格不一致时，以“保持现有业务行为 + 达成本规格验收标准”为原则调整，不得机械覆盖。
6. 所有原生 TTS 操作必须避免并发初始化、重复回调、悬空 Promise 和 Activity 泄漏。
7. 任何错误都必须向 JS 层返回明确错误码，禁止只记录日志后静默失败。
8. 不得引入需要 Google Play Services 才能运行的依赖。
9. 小米 MIX 4 真机验收未通过前，不得宣称适配完成。
10. 施工分为两个独立里程碑：
   - **Milestone A：系统 TTS 兼容修复，必须完成。**
   - **Milestone B：应用内置离线 TTS，建议完成，可单独发布。**

---

## 1. 背景与现状

当前项目已经实现系统 TTS：

- JS 层通过 `src/native/TtsAudioModule.ts` 调用原生模块。
- 状态由 `src/store/voiceStore.ts` 管理。
- 设置页面位于 `src/screens/VoiceSettingsScreen.tsx`。
- Kotlin 实现位于：
  - `android/app/src/main/java/com/shinewriter/TtsAudioModule.kt`
  - `android/app/src/main/java/com/shinewriter/TtsAudioPackage.kt`
- 原生包在 `MainApplication.kt` 手动注册。
- 默认语音引擎目前是 `system`。

现有实现已经能在安装 Google TTS 的模拟器上朗读，但不能保证在小米国行 ROM 上正常工作。

### 1.1 已确认的工程问题

1. `AndroidManifest.xml` 缺少 Android 11+ 的 TTS Service 包可见性声明。
2. `ensureTts()` 仅使用 `tts != null` 和 `ttsReady` 判断状态，存在并发初始化竞争。
3. `getVoices(enginePackage)` 接收了引擎包名，但没有真正切换到目标引擎。
4. 整章文本一次性交给 `TextToSpeech.speak()`，可能超过系统单次输入上限。
5. 语言状态只按 `< 0` 判断，没有区分“缺少语音数据”和“不支持语言”。
6. 原生 `ttsError` 事件没有携带错误码、引擎、分段等诊断信息。
7. 打开 TTS 设置只使用单一 Intent，在部分小米 ROM 上可能不存在。
8. 设置页同时请求引擎和声线，容易触发初始化竞争。
9. 设置页没有“重新检测”和完整诊断结果。
10. 当前所谓“系统 TTS”依赖手机安装的第三方/系统引擎，并不等于应用真正内置离线 TTS。

---

## 2. 总体目标

### 2.1 Milestone A：系统 TTS 兼容修复

使应用在小米 MIX 4 Android 14 上能够：

- 正确发现已安装的 TTS 引擎；
- 正确初始化默认或用户指定的引擎；
- 正确判断中文语音是否可用；
- 对小说长章节自动分段并连续朗读；
- 朗读完成、失败、停止后状态可恢复；
- 给出明确可操作的诊断和引导；
- 不影响现有云端 TTS。

### 2.2 Milestone B：应用内置离线 TTS

增加一个完全不依赖小米系统 TTS、Google TTS 或网络 API 的 `builtin` 引擎：

- 本地 ONNX 模型推理；
- 中文离线朗读；
- 支持停止；
- 支持长文本分段；
- 模型可按需下载或随 APK 分发；
- 系统 TTS 不可用时仍可朗读。

---

## 3. 非目标

本次不要求：

- 制作完整有声书编辑器；
- 逐字高亮；
- 句级时间轴导出；
- 语音克隆；
- 声音情感控制；
- iOS 适配；
- 重构云端 TTS API；
- 将 TTS 合并进 AI 流水线前台服务；
- 为所有 Android 品牌做完整兼容认证。

---

# Part I：Milestone A——系统 TTS 兼容修复

## 4. Milestone A 文件变更清单

### 必须修改

| 文件 | 变更 |
|---|---|
| `android/app/src/main/AndroidManifest.xml` | 增加 TTS Service 查询声明 |
| `android/app/src/main/java/com/shinewriter/TtsAudioModule.kt` | 重构初始化、引擎切换、分段、诊断、事件 |
| `src/native/TtsAudioModule.ts` | 扩展原生接口和事件类型 |
| `src/types/tts.ts` | 增加诊断、错误、状态类型 |
| `src/store/voiceStore.ts` | 适配新事件、错误和播放会话 |
| `src/screens/VoiceSettingsScreen.tsx` | 增加诊断、重试和引导 UI |
| `src/constants/voice.ts` | 增加系统 TTS 默认值和提示常量 |
| `jest.setup.js` 或现有 Jest 原生模块 Mock 文件 | 补充新接口 Mock |

### 建议新增

| 文件 | 用途 |
|---|---|
| `android/app/src/main/java/com/shinewriter/TtsTextChunker.kt` | 长文本分段，便于单元测试 |
| `android/app/src/test/java/com/shinewriter/TtsTextChunkerTest.kt` | Kotlin 分段单元测试 |
| `__tests__/systemTtsCompatibility.test.ts` | JS 状态与诊断回归测试 |
| `docs/tts-xiaomi-debug.md` | 真机调试命令和常见故障 |

---

## 5. AndroidManifest 适配

### 5.1 修改要求

在 `<application>` 之前增加：

```xml
<queries>
    <intent>
        <action android:name="android.intent.action.TTS_SERVICE" />
    </intent>
</queries>
```

完整结构示意：

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">

    <queries>
        <intent>
            <action android:name="android.intent.action.TTS_SERVICE" />
        </intent>
    </queries>

    <uses-permission android:name="android.permission.INTERNET" />
    <!-- 保留现有 permissions -->

    <application
        ...>
        <!-- 保留现有 Activity 和 Service -->
    </application>
</manifest>
```

### 5.2 验收标准

- APK 可正常安装。
- `getEngines()` 能发现系统已注册的 TTS 引擎。
- 不新增任何高风险权限。
- 不添加 `QUERY_ALL_PACKAGES`。

---

## 6. Kotlin TTS 初始化状态机

### 6.1 禁止保留的错误逻辑

不得继续使用以下模式作为唯一判断：

```kotlin
if (tts != null) {
    callback(ttsReady)
    return
}
```

因为 `TextToSpeech` 对象已创建不代表 `onInit` 已完成。

### 6.2 新增状态定义

在 `TtsAudioModule.kt` 中增加：

```kotlin
private enum class TtsInitState {
    IDLE,
    INITIALIZING,
    READY,
    FAILED
}
```

成员变量：

```kotlin
private var initState = TtsInitState.IDLE
private val initCallbacks = mutableListOf<(Boolean) -> Unit>()
private val mainHandler = Handler(Looper.getMainLooper())
private var initTimeoutRunnable: Runnable? = null
private const val TTS_INIT_TIMEOUT_MS = 8000L
```

如 Kotlin 不允许在普通类中直接使用 `const val`，放入 `companion object`。

### 6.3 初始化要求

实现：

```kotlin
private fun ensureTts(
    requestedEngine: String? = currentEnginePackage,
    callback: (Boolean) -> Unit
)
```

行为：

1. `READY` 且当前引擎与 requestedEngine 匹配：立即回调 `true`。
2. `INITIALIZING` 且目标引擎相同：把 callback 加入等待队列。
3. 当前引擎与目标引擎不同：安全关闭旧实例，重新初始化。
4. `IDLE` 或 `FAILED`：开始初始化。
5. 初始化必须在主线程触发。
6. 所有等待 callback 必须恰好被调用一次。
7. 初始化超过 8 秒：
   - 状态变为 `FAILED`；
   - shutdown 当前实例；
   - 清空实例；
   - 所有 callback 返回 `false`；
   - 记录明确日志。
8. 初始化成功后：
   - 设置音频属性；
   - 注册 `UtteranceProgressListener`；
   - 设置 `currentEnginePackage` 为实际引擎；
   - 状态变为 `READY`。
9. 初始化失败后允许用户再次重试，不能永久锁死。

### 6.4 安全关闭方法

新增：

```kotlin
private fun shutdownTts(resetEngine: Boolean = false)
```

必须：

- 取消初始化超时；
- 调用 `stop()`；
- 调用 `shutdown()`；
- `tts = null`；
- `ttsReady = false`；
- `initState = IDLE`；
- 必要时清空 `currentEnginePackage`；
- 捕获所有异常，不能导致进程崩溃。

### 6.5 并发安全

以下方法可能同时调用初始化，必须共享同一个初始化队列：

- `speak()`
- `getEngines()`
- `getVoices()`
- `diagnoseTts()`
- `isTtsReady()`（如需要触发初始化）

不得为每个方法分别创建独立 `TextToSpeech` 实例。

---

## 7. 引擎发现与切换

### 7.1 `getEngines()` 返回结构

保持原字段，并建议增加：

```typescript
export interface SystemTtsEngineInfo {
  name: string;
  label: string;
  isDefault: boolean;
  isCurrent: boolean;
}
```

Kotlin 返回字段：

```kotlin
map.putString("name", engine.name)
map.putString("label", engine.label ?: engine.name)
map.putBoolean("isDefault", engine.name == ttsInstance.defaultEngine)
map.putBoolean("isCurrent", engine.name == currentEnginePackage)
```

### 7.2 `getVoices(enginePackage)` 必须真正切换

现有参数不能再被忽略。

行为：

1. `enginePackage` 为空：使用系统默认引擎。
2. `enginePackage` 非空：使用三参数构造函数初始化目标引擎。
3. 初始化完成后再读取 `voices`。
4. 声线结果按 `locale`、`name` 排序。
5. 返回：

```typescript
export interface SystemTtsVoiceInfo {
  key: string;
  name: string;
  locale: string;
  quality: number;
  latency: number;
  requiresNetwork: boolean;
  features: string[];
}
```

Kotlin 映射：

```kotlin
map.putString("key", voice.name)
map.putString("name", voice.name)
map.putString("locale", voice.locale?.toLanguageTag() ?: "")
map.putInt("quality", voice.quality)
map.putInt("latency", voice.latency)
map.putBoolean("requiresNetwork", voice.isNetworkConnectionRequired)
```

`features` 用 WritableArray 返回；读取异常时返回空数组。

### 7.3 引擎切换失败回退

用户指定引擎初始化失败时：

1. 不得静默冒充该引擎成功。
2. 先返回错误：`TTS_ENGINE_INIT_FAILED`。
3. UI 提示用户重新选择引擎。
4. 只有当调用方明确请求 `allowFallback=true` 时才回退系统默认引擎。

为避免破坏现有接口，可在 `SpeakConfig` 增加：

```typescript
allowEngineFallback?: boolean;
```

默认值：`true`。但诊断和声线查询默认不得回退，否则结果会误导用户。

---

## 8. 语言和语音数据诊断

### 8.1 新增原生接口

在 `TtsAudioNative` 中增加：

```typescript
getDiagnostics(
  enginePackage?: string,
  language?: string,
): Promise<SystemTtsDiagnostics>;
```

### 8.2 类型定义

在 `src/types/tts.ts` 增加：

```typescript
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
```

### 8.3 Kotlin 语言状态映射

必须区分：

```kotlin
TextToSpeech.LANG_AVAILABLE
TextToSpeech.LANG_COUNTRY_AVAILABLE
TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE
TextToSpeech.LANG_MISSING_DATA
TextToSpeech.LANG_NOT_SUPPORTED
```

对应返回字符串：

```text
available
country_available
variant_available
missing_data
not_supported
unknown
```

### 8.4 Locale 解析

不得继续只用 `language.split("-")` 处理所有情况。

优先：

```kotlin
val locale = Locale.forLanguageTag(languageTag)
```

当结果语言为空或非法时，回退：

```kotlin
Locale.SIMPLIFIED_CHINESE
```

默认语言仍为 `zh-CN`。

### 8.5 诊断返回要求

即使初始化失败，也尽量返回完整设备信息和错误信息，不要直接 reject；只有桥接层发生不可恢复异常时才 reject。

---

## 9. 长文本分段

### 9.1 核心要求

系统 TTS 不得再把整章正文一次性交给 `speak()`。

限制长度：

```kotlin
val maxLength = (TextToSpeech.getMaxSpeechInputLength() - 256)
    .coerceAtLeast(500)
```

### 9.2 分段优先级

按以下顺序尽量切分：

1. 连续空行；
2. 换行；
3. 中文句末：`。！？`；
4. 英文句末：`.!?`；
5. 分号：`；;`；
6. 逗号：`，,`；
7. 最后才按字符硬切。

### 9.3 分段器建议接口

新增 `TtsTextChunker.kt`：

```kotlin
object TtsTextChunker {
    fun split(text: String, maxLength: Int): List<String>
}
```

要求：

- 返回内容顺序与原文一致；
- 每段不为空；
- 每段长度不超过 maxLength；
- 拼接后与清洗后的原文语义一致；
- 不吞标点；
- 不因连续换行生成大量空段；
- 对超过 maxLength 的超长无标点字符串可以硬切。

### 9.4 播放会话

每次朗读创建唯一会话：

```kotlin
private data class TtsSession(
    val sessionId: String,
    val chunks: List<String>,
    var currentIndex: Int = 0,
    var stopped: Boolean = false
)
```

成员：

```kotlin
private var activeSession: TtsSession? = null
```

每段 utterance ID 格式：

```text
shinewriter:<sessionId>:<index>:<total>
```

### 9.5 队列策略

推荐逐段驱动，不要一次性把所有段塞入系统队列：

1. 首段调用 `QUEUE_FLUSH`。
2. `onDone` 后再提交下一段。
3. 这样可以控制停止、错误和进度。
4. 最后一段完成后发送 `ttsDone`。
5. 中间段完成不得发送全局完成事件。

### 9.6 段间错误

任意一段触发 `onError`：

- 停止当前会话；
- 清空 activeSession；
- 发送带错误详情的 `ttsError`；
- 不再提交后续段；
- JS 状态必须恢复。

---

## 10. `speak()` 行为规范

### 10.1 `SpeakConfig` 扩展

```typescript
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
```

### 10.2 参数边界

原生层必须再次校验：

| 参数 | 有效范围 | 默认 |
|---|---:|---:|
| speed | 0.1～4.0 | 1.0 |
| pitch | 0.1～2.0 | 1.0 |
| volume | 0.0～1.0 | 1.0 |

UI 可提供更窄范围，但原生层必须防御非法输入。

### 10.3 声线选择

1. 指定 `voiceKey` 时先查找匹配 voice。
2. `offlineOnly=true` 且匹配 voice 需要网络时，返回 `TTS_VOICE_REQUIRES_NETWORK`。
3. 指定 voice 不存在：
   - 返回 `TTS_VOICE_NOT_FOUND`；
   - 不得默默使用其他声线。
4. 未指定 voice：使用引擎默认声线。

### 10.4 语言选择

1. 先调用 `isLanguageAvailable(locale)`。
2. `LANG_MISSING_DATA`：返回 `TTS_LANGUAGE_DATA_MISSING`。
3. `LANG_NOT_SUPPORTED`：返回 `TTS_LANGUAGE_NOT_SUPPORTED`。
4. 可用时调用 `setLanguage(locale)`。
5. 如果指定 voice，设置 voice 后再次确认 locale 结果合理。

### 10.5 Promise 语义

`TtsAudio.speak()` Promise 语义保持：

- **首段成功入队后 resolve。**
- 播放完成通过事件通知。
- 初始化失败或首段入队失败时 reject。
- 后续段出错通过 `ttsError` 事件通知。

这一语义必须写入代码注释和 TypeScript 接口注释。

---

## 11. 事件协议

### 11.1 事件名称

保留：

```text
ttsStart
ttsProgress
ttsDone
ttsError
ttsStopped
```

当前已有 `ttsDone`、`ttsError`；补充其余事件。

### 11.2 事件类型

在 `src/types/tts.ts` 增加：

```typescript
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
```

### 11.3 事件发送规则

- `ttsStart`：首段 `onStart` 时发送一次。
- `ttsProgress`：每段开始时发送。
- `ttsDone`：最后一段完成时发送一次。
- `ttsError`：任何段失败时发送一次。
- `ttsStopped`：用户主动停止时发送一次。

同一个 session 不得同时发送 `ttsDone` 和 `ttsError`。

### 11.4 JS 监听清理

当前 store 在模块加载时直接 `addListener`。施工时必须保证：

- 热重载或测试环境不会重复注册；
- 可使用模块级单例订阅保护；
- 或提供 `initializeTtsListeners()` 并在 App 入口调用一次；
- Jest 测试结束后可移除监听。

---

## 12. 停止与生命周期

### 12.1 `stopSpeak()`

必须：

- 标记 activeSession 已停止；
- 调用 `tts.stop()`；
- 清空 activeSession；
- 清空 pending Promise/文本/config；
- 发送 `ttsStopped`；
- resolve，不因 stop 返回码导致 reject。

### 12.2 新朗读覆盖旧朗读

新 `speak()` 到来时：

1. 停止旧会话；
2. 旧会话不得再触发完成事件；
3. 若旧请求仍处于初始化阶段，旧 Promise reject：

```text
code: TTS_CANCELLED
message: 新的朗读请求已覆盖旧请求
```

### 12.3 Catalyst 销毁

`onCatalystInstanceDestroy()` 中：

- 停止 MediaPlayer；
- 停止系统 TTS；
- 关闭 TTS 实例；
- 取消 Handler 回调；
- 清空监听相关状态；
- 不发送 JS 事件。

---

## 13. 设置页改造

### 13.1 加载流程

系统 TTS 页面进入时按顺序执行：

1. 加载保存的配置；
2. 调用 `getDiagnostics()`；
3. 诊断成功后调用 `getEngines()`；
4. 根据选中引擎调用 `getVoices()`；
5. 禁止 `getEngines()` 与 `getVoices()` 无序并发初始化。

可以在 JS 侧串行，也可以依赖原生状态机；为了 UI 状态明确，仍建议串行。

### 13.2 页面状态

新增：

```typescript
type TtsDetectionState =
  | 'idle'
  | 'detecting'
  | 'ready'
  | 'warning'
  | 'error';
```

页面需要显示：

- 检测中；
- 当前默认引擎；
- 已安装引擎数量；
- 当前语言状态；
- 匹配声线数量；
- 离线声线数量；
- 最大单段字符数；
- 错误说明。

### 13.3 新增按钮

必须增加：

- `重新检测`
- `打开系统语音设置`
- 当缺少语音数据时：`尝试安装语音数据`

### 13.4 安装语音数据 Intent

原生模块增加：

```typescript
installTtsData(): Promise<boolean>;
```

Kotlin 使用：

```kotlin
Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA)
```

启动前必须 `resolveActivity()`。

若系统无可处理 Activity，返回 `false`，UI 提示用户安装第三方 TTS 引擎或使用内置离线 TTS。

### 13.5 设置页错误文案

必须映射以下错误：

| 错误码 | 文案 |
|---|---|
| `TTS_NO_ENGINE` | 未检测到可用的系统语音引擎 |
| `TTS_ENGINE_INIT_TIMEOUT` | 系统语音引擎响应超时，请重新检测 |
| `TTS_ENGINE_INIT_FAILED` | 语音引擎初始化失败 |
| `TTS_LANGUAGE_DATA_MISSING` | 当前引擎缺少中文语音数据 |
| `TTS_LANGUAGE_NOT_SUPPORTED` | 当前引擎不支持所选语言 |
| `TTS_VOICE_NOT_FOUND` | 已保存的声线不存在，请重新选择 |
| `TTS_VOICE_REQUIRES_NETWORK` | 所选声线需要联网，不符合离线设置 |
| `TTS_SPEAK_FAILED` | 系统未能开始朗读 |

不得直接把长堆栈显示给普通用户。

### 13.6 小米专用提示

当：

```typescript
diagnostics.manufacturer.toLowerCase() === 'xiaomi'
```

且系统 TTS 不可用时，显示：

> 小米系统可能未预装中文 TTS 引擎。可先打开系统语音设置安装语音数据，或切换到“内置离线 TTS”。

不允许基于机型硬编码功能分支，只允许调整提示文案。

---

## 14. `voiceStore` 改造

### 14.1 新增状态

```typescript
interface VoiceState {
  // 保留现有字段
  activeTtsSessionId: string | null;
  ttsProgress: {
    chunkIndex: number;
    chunkCount: number;
  } | null;
  lastTtsError: TtsErrorEvent | null;
}
```

### 14.2 播放开始

调用 `TtsAudio.speak()` 前：

```typescript
set({
  isSynthesizing: true,
  isPlaying: false,
  activeTtsSessionId: null,
  ttsProgress: null,
  lastTtsError: null,
});
```

`speak()` resolve 后：

```typescript
set({
  isSynthesizing: false,
  isPlaying: true,
});
```

### 14.3 事件处理

- `ttsStart`：写入 sessionId，`isPlaying=true`。
- `ttsProgress`：更新分段进度。
- `ttsDone`：仅当 sessionId 与当前会话一致时清空状态。
- `ttsError`：仅处理当前 session；恢复状态并显示映射后的错误。
- `ttsStopped`：恢复状态，不显示错误 Toast。

旧会话的迟到事件必须忽略。

### 14.4 停止

系统 TTS stop 不应依赖当前 `isPlaying`。如果 `isSynthesizing=true`，也必须调用 `stopSpeak()`，以取消初始化期间的待处理请求。

### 14.5 云端 TTS 回归

以下现有行为必须保持：

- API Key 校验；
- 合成文件后使用 MediaPlayer；
- 停止时取消网络请求；
- 临时文件清理；
- 云端和系统 TTS 互斥。

---

## 15. 系统设置 Intent 回退

### 15.1 `openTtsSettings()`

按顺序尝试：

1. `com.android.settings.TTS_SETTINGS`
2. `Settings.ACTION_ACCESSIBILITY_SETTINGS`
3. `Settings.ACTION_SETTINGS`

每个 Intent 均必须：

- 添加 `FLAG_ACTIVITY_NEW_TASK`；
- 调用 `resolveActivity()`；
- 成功启动后立即 resolve `true`。

全部失败：resolve `false`，不要因厂商没有页面而崩溃。

### 15.2 不允许使用

- 不允许显式绑定小米内部 Activity 类名；
- 不允许调用未公开的 MIUI API；
- 不允许根据 Android 版本硬编码不存在的 Settings 常量。

---

## 16. 日志规范

统一 Tag：

```text
ShineWriterTts
```

必须记录：

- 设备厂商、型号、Android SDK；
- 初始化开始/成功/失败/超时；
- 请求引擎和实际引擎；
- 引擎数量；
- language status；
- voice 数量和离线 voice 数量；
- 分段数量；
- 每段开始/完成/错误；
- stop 和 shutdown。

不得记录：

- 完整章节正文；
- API Key；
- 用户隐私数据。

文本日志最多记录：

```text
textLength=<长度>
preview=<前 20 个字符，debug 构建可选>
```

release 构建建议不记录 preview。

---

## 17. Milestone A 测试规格

### 17.1 Kotlin 单元测试

`TtsTextChunkerTest` 至少覆盖：

1. 短文本不分段。
2. 中文句号分段。
3. 中英混合分段。
4. 连续换行。
5. 超长无标点字符串硬切。
6. 每段均不超过上限。
7. 拼接后不丢字符和标点。
8. 空字符串返回空列表。
9. 仅空白字符串返回空列表。

### 17.2 Jest 测试

至少覆盖：

1. 系统 TTS 调用 `speak()`，不调用云端合成。
2. 云端 TTS 行为不变。
3. `ttsDone` 恢复状态。
4. `ttsError` 恢复状态并保留错误详情。
5. 旧 session 的迟到事件被忽略。
6. 初始化阶段调用 stop 仍执行 `stopSpeak()`。
7. 页面按顺序执行 diagnostics → engines → voices。
8. `LANG_MISSING_DATA` 显示正确文案。
9. 小米厂商提示只影响文案，不影响功能分支。
10. `requiresNetwork=true` 在离线过滤中被排除。

### 17.3 Android 构建

必须通过：

```bash
npm test
npm run lint
npm run apk:debug
npm run apk:release
```

若 release 构建依赖本机签名环境，至少保证 Gradle release compile 通过并说明签名限制。

### 17.4 真机测试矩阵

目标机：小米 MIX 4，Android 14。

| 场景 | 预期 |
|---|---|
| 没有任何 TTS 引擎 | 页面明确显示未检测到引擎，不崩溃 |
| 安装一个支持中文的引擎 | 可发现、可选择、可测试 |
| 引擎缺少中文数据 | 显示“缺少中文语音数据” |
| 选择不存在的旧声线 | 提示重新选择，不静默失败 |
| 100 字短文 | 正常朗读一次 |
| 5000 字章节 | 自动分段、连续朗读 |
| 10000 字章节 | 自动分段、不中途卡死 |
| 朗读中点击停止 | 立即停止，按钮状态恢复 |
| 朗读结束后再次播放 | 能再次朗读 |
| 切换系统/云端引擎 | 旧播放停止，新引擎可用 |
| 熄屏 | Milestone A 只要求系统允许时继续；不作为强制通过项 |
| 来电/音频焦点变化 | 不崩溃；允许系统暂停或停止 |

### 17.5 ADB 验证命令

```bash
adb shell settings get secure tts_default_synth
adb logcat -c
adb logcat -s ShineWriterTts TextToSpeech
```

Windows PowerShell：

```powershell
adb shell dumpsys package | Select-String "android.intent.action.TTS_SERVICE"
adb logcat -s ShineWriterTts TextToSpeech
```

---

## 18. Milestone A 完成定义

必须同时满足：

- [ ] Manifest 增加 TTS Service 查询声明。
- [ ] 原生初始化使用状态机，无并发竞态。
- [ ] 指定引擎后，声线查询来自正确引擎。
- [ ] 能区分缺少数据和不支持语言。
- [ ] 小说长文本自动分段。
- [ ] 完成、错误、停止事件均包含 session 信息。
- [ ] JS 忽略旧会话迟到事件。
- [ ] 设置页可重新检测并显示诊断。
- [ ] 所有 Jest 测试通过。
- [ ] debug APK 构建通过。
- [ ] 小米 MIX 4 Android 14 短文和长文真机测试通过。
- [ ] 云端 TTS 回归通过。

---

# Part II：Milestone B——应用内置离线 TTS

## 19. 技术决策

使用 `sherpa-onnx` Android/Kotlin API 接入离线 TTS。

原因：

- Android 原生可运行；
- 不依赖 Google 服务；
- 支持 ONNX 离线推理；
- 官方仓库有 Android TTS 示例；
- 支持中文 VITS/Matcha 等模型；
- 可通过 `AudioTrack` 流式播放。

### 19.1 版本固定

施工时必须：

1. 选择 sherpa-onnx 的明确 release/tag。
2. 将版本写入：
   - Gradle 注释；
   - `docs/tts-model-license.md`；
   - 本规格实施记录。
3. 禁止直接依赖浮动 `master`。
4. JNI 库、Kotlin API 和模型配置必须来自同一兼容版本。

### 19.2 ABI

首版至少支持：

```text
arm64-v8a
```

因为小米 MIX 4 是 arm64 设备。

如当前 APK 面向更多设备，可同时保留：

```text
armeabi-v7a
x86_64（仅开发/模拟器，可选）
```

不得为了减少体积而破坏现有已支持 ABI，除非在发布说明中明确变更。

---

## 20. Milestone B 数据模型

### 20.1 扩展引擎类型

```typescript
export type TtsEngine = 'system' | 'builtin' | 'cloud';
```

### 20.2 内置 TTS 配置

```typescript
export interface BuiltinTtsConfig {
  modelId: string;
  speakerId: number;
  speed: number;
  volume: number;
  autoDownload: boolean;
}
```

默认值建议：

```typescript
export const DEFAULT_BUILTIN_TTS_CONFIG: BuiltinTtsConfig = {
  modelId: 'zh-default-v1',
  speakerId: 0,
  speed: 1.0,
  volume: 1.0,
  autoDownload: false,
};
```

### 20.3 模型清单

新增：

```typescript
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

模型 URL、SHA-256、许可证必须使用实际值，禁止占位值进入 release 分支。

---

## 21. 模型分发方案

首版推荐“按需下载”，不直接把 100MB 以上模型塞入基础 APK。

### 21.1 存储目录

```text
<app files dir>/tts-models/<modelId>/<version>/
```

不得放入公共 Downloads 目录。

### 21.2 下载流程

状态：

```typescript
export type ModelDownloadState =
  | 'not_installed'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'installed'
  | 'failed';
```

流程：

1. 检查磁盘空间。
2. 下载到 `.part` 文件。
3. 显示进度。
4. 下载完成后校验 SHA-256。
5. 校验失败立即删除。
6. 解压到临时目录。
7. 验证必要文件全部存在。
8. 原子重命名到正式目录。
9. 写入 `installed.json`。
10. 删除压缩包和临时文件。

### 21.3 安全要求

- 只允许 HTTPS。
- 必须校验 SHA-256。
- 防止 Zip Slip：解压后路径必须仍位于目标目录。
- 失败时不得留下被识别为“已安装”的半成品。
- 删除模型前必须先停止使用该模型的朗读会话。

---

## 22. 内置 TTS 原生模块

### 22.1 新增文件

```text
android/app/src/main/java/com/shinewriter/BuiltinTtsModule.kt
android/app/src/main/java/com/shinewriter/BuiltinTtsPackage.kt
src/native/BuiltinTtsModule.ts
```

也可以把功能合并进现有 `TtsAudioModule`，但推荐独立模块，降低系统 TTS 和 ONNX 生命周期耦合。

### 22.2 JS 接口

```typescript
export interface BuiltinTtsNative {
  initialize(config: {
    modelDir: string;
    modelType: 'vits' | 'matcha';
    modelFile?: string;
    acousticModelFile?: string;
    vocoderFile?: string;
    tokensFile: string;
    lexiconFile?: string;
    ruleFsts?: string[];
    ruleFars?: string[];
    dataDir?: string;
    numThreads?: number;
  }): Promise<{
    ready: boolean;
    sampleRate: number;
    speakerCount: number;
  }>;

  speak(
    text: string,
    config: {
      speakerId: number;
      speed: number;
      volume: number;
    },
  ): Promise<{ sessionId: string }>;

  stop(): Promise<void>;
  release(): Promise<void>;
  isReady(): Promise<boolean>;
}
```

### 22.3 线程要求

- 模型初始化不得运行在 UI 线程。
- 推理不得运行在 React Native JS 线程。
- 使用单线程 Executor 或 Coroutine Dispatcher，首版禁止并发合成多个会话。
- 新会话开始时停止旧会话。
- `release()` 等待当前推理退出后释放 native 资源。

### 22.4 音频播放

使用 `AudioTrack`：

- `USAGE_MEDIA`
- `CONTENT_TYPE_SPEECH`
- 单声道
- 采样率来自模型
- `ENCODING_PCM_FLOAT` 或与 sherpa 输出匹配的编码
- `MODE_STREAM`

回调产生样本后边生成边写入 AudioTrack，避免先生成完整 WAV 导致等待和大内存占用。

### 22.5 停止机制

使用线程安全标志：

```kotlin
@Volatile
private var stopRequested = false
```

生成回调检测：

```kotlin
if (stopRequested) return 0
```

停止时：

- 标记 stopRequested；
- pause；
- flush；
- stop；
- 发送 `builtinTtsStopped`；
- 恢复 JS 状态。

### 22.6 文本分段复用

内置 TTS 同样使用 `TtsTextChunker`，但单段上限可配置为较合理的模型推理长度，例如 200～500 中文字符。

不要把 10000 字全文一次性送入模型。

---

## 23. 内置 TTS 状态与事件

事件：

```text
builtinTtsInitializing
builtinTtsStart
builtinTtsProgress
builtinTtsDone
builtinTtsError
builtinTtsStopped
```

事件统一包含：

```typescript
interface BuiltinTtsEvent {
  sessionId: string;
  modelId: string;
  chunkIndex: number;
  chunkCount: number;
}
```

错误增加：

```typescript
interface BuiltinTtsErrorEvent extends BuiltinTtsEvent {
  errorCode:
    | 'MODEL_NOT_INSTALLED'
    | 'MODEL_CORRUPTED'
    | 'MODEL_INIT_FAILED'
    | 'INVALID_SPEAKER_ID'
    | 'SYNTHESIS_FAILED'
    | 'AUDIO_TRACK_FAILED'
    | 'CANCELLED';
  message: string;
}
```

---

## 24. 前端设置页：三引擎模式

顶部切换：

```text
系统 TTS | 内置离线 | 云端 API
```

### 24.1 内置离线区域

显示：

- 模型名称；
- 语言；
- 模型大小；
- 是否已安装；
- 下载进度；
- 安装/删除按钮；
- 音色/说话人选择；
- 语速；
- 测试朗读。

### 24.2 默认策略

新安装用户的默认策略建议：

1. 首次启动仍默认 `system`，避免自动下载大模型。
2. 如果系统 TTS 诊断失败，在设置页突出推荐 `builtin`。
3. 用户点击安装并成功后，可询问是否切换为内置离线。
4. 不允许未征得用户同意自动下载 100MB 以上模型。

### 24.3 降级顺序

播放时不做完全自动的跨引擎降级，避免用户不知情地产生云端费用。

允许的策略：

- `system` 失败：提示切换到 `builtin`，不自动切换。
- `builtin` 未安装：提示安装，不自动调用 cloud。
- `cloud` 失败：显示云端错误，不自动改用其他引擎。

---

## 25. 前台播放服务（可选增强）

当产品要求熄屏、后台持续朗读时，新增：

```text
android/app/src/main/java/com/shinewriter/TtsPlaybackService.kt
```

Manifest：

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />

<service
    android:name=".TtsPlaybackService"
    android:exported="false"
    android:foregroundServiceType="mediaPlayback" />
```

要求：

- 仅在实际播放时启动；
- 使用独立通知渠道；
- 通知提供停止操作；
- 播放结束立即停止前台服务；
- 不复用 `PipelineForegroundService`；
- Android 13+ 处理通知权限缺失，但权限缺失不能导致应用崩溃；
- 使用 Audio Focus；
- 耳机拔出、来电等事件按系统预期暂停或停止。

此项可以作为 Milestone B.1，不阻塞首版离线朗读。

---

## 26. Milestone B 测试规格

### 26.1 单元测试

- 模型 manifest 解析。
- SHA-256 校验成功和失败。
- Zip Slip 路径拒绝。
- 半成品目录不会被识别为已安装。
- speakerId 越界。
- stop 标志能终止后续生成。
- session 迟到事件被忽略。

### 26.2 真机性能测试：小米 MIX 4

记录：

- 模型初始化耗时；
- 首段首音延迟；
- 1000 字合成/播放稳定性；
- 峰值内存；
- CPU 使用情况；
- 连续朗读 30 分钟是否崩溃；
- 停止响应时间；
- 第二次播放是否需要重新加载模型。

建议通过标准：

| 指标 | 建议目标 |
|---|---:|
| 首次模型初始化 | ≤ 10 秒 |
| 已初始化后的首音延迟 | ≤ 3 秒 |
| 停止响应 | ≤ 1 秒 |
| 30 分钟连续朗读 | 无崩溃、无明显内存持续增长 |
| 第二次播放 | 不重复完整加载模型 |

模型本身性能无法满足时，允许调整目标，但必须记录实测数据。

### 26.3 离线验收

真机开启飞行模式后：

- 应用内置 TTS 可初始化；
- 测试短句可朗读；
- 5000 字章节可连续朗读；
- 不访问云端 API；
- 不依赖系统 TTS 引擎。

---

## 27. Milestone B 完成定义

- [ ] `TtsEngine` 已扩展为三种引擎。
- [ ] 模型 manifest 包含真实版本、SHA-256 和许可证。
- [ ] 模型下载支持进度、校验、失败清理。
- [ ] sherpa-onnx 版本已固定。
- [ ] arm64-v8a 真机可初始化模型。
- [ ] 飞行模式可朗读中文。
- [ ] 长文本可分段连续播放。
- [ ] 停止在 1 秒左右生效。
- [ ] 模型释放后无 native 崩溃。
- [ ] 系统 TTS、内置 TTS、云端 TTS 互斥。
- [ ] 小米 MIX 4 30 分钟稳定性测试通过。
- [ ] 模型许可证和第三方声明已加入发布文档。

---

# Part III：提交与验收流程

## 28. 建议提交拆分

禁止把所有改动压成一个巨大提交。建议：

1. `fix(android): declare TTS service visibility`
2. `refactor(tts): add native initialization state machine`
3. `fix(tts): query voices from selected engine`
4. `feat(tts): add diagnostics and actionable errors`
5. `feat(tts): chunk long text with session events`
6. `feat(ui): add TTS detection and retry controls`
7. `test(tts): cover Xiaomi compatibility flows`
8. `feat(tts): add builtin offline engine scaffolding`
9. `feat(tts): add model download and verification`
10. `feat(tts): integrate sherpa-onnx playback`
11. `docs(tts): add model licenses and device test report`

Milestone A 和 B 最好使用独立 PR。

---

## 29. PR 描述必须包含

- 问题现象；
- 根因；
- 修改范围；
- 不修改的范围；
- 测试命令；
- 小米 MIX 4 实测结果；
- 使用的 TTS 引擎名称；
- Android 版本；
- 长文本长度；
- 已知限制；
- 截图或日志片段；
- 如果包含模型，列出模型许可证、大小、SHA-256。

---

## 30. 最终验收报告模板

```markdown
# TTS 适配验收报告

## 环境
- Device: Xiaomi MIX 4
- Android: 14
- ROM/Build:
- App version:
- APK type: debug/release

## System TTS
- Installed engines:
- Default engine:
- Selected engine:
- Chinese language status:
- Matching voices:
- Offline voices:

## Cases
- Short text: PASS/FAIL
- 5000 chars: PASS/FAIL
- 10000 chars: PASS/FAIL
- Stop during playback: PASS/FAIL
- Replay after completion: PASS/FAIL
- Switch system/cloud: PASS/FAIL

## Builtin TTS
- Model:
- Model version:
- Model SHA-256:
- Init time:
- First audio latency:
- Airplane mode: PASS/FAIL
- 30-minute stability: PASS/FAIL

## Tests
- npm test:
- npm run lint:
- debug APK build:
- release APK build:

## Known limitations
-
```

---

## 31. 回滚边界

### Milestone A 回滚

如果系统 TTS 重构出现严重问题：

- 可以回滚 Kotlin 状态机和 UI 诊断；
- Manifest 的 `<queries>` 可保留；
- 云端 TTS 必须始终可用；
- 不得清除用户已保存的云端配置。

### Milestone B 回滚

内置引擎必须受功能开关控制：

```typescript
export const ENABLE_BUILTIN_TTS = true;
```

紧急情况下可关闭 UI 入口，但：

- 不删除用户已经下载的模型；
- 不改变 system/cloud 配置；
- 后续恢复功能时仍可识别已安装模型。

---

## 32. 最终工程判断

Milestone A 解决的是“小米 MIX 4 能否正确调用手机中的系统 TTS”。它仍依赖设备实际安装的语音引擎和中文语音数据。

Milestone B 才能实现“应用自身具备真正的本地离线 TTS”，从根本上消除小米 ROM 是否预装 Google TTS、系统默认引擎是否可用等差异。

推荐发布路径：

1. 先发布 Milestone A，快速解决引擎发现、初始化竞态和长文本问题。
2. 再发布 Milestone B，把内置离线 TTS 作为稳定默认能力。
3. 最终产品保留三种模式：
   - 系统 TTS：体积小，依赖设备；
   - 内置离线：稳定，不依赖厂商，需下载模型；
   - 云端 API：音质高，依赖网络和 API Key。
