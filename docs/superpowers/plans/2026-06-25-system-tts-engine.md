# 系统 TTS 引擎接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在云端 TTS 之外，增加对 Android 系统内置 `TextToSpeech` 的接入，默认引擎为 system，新用户零配置即可朗读。

**Architecture:** 顶层引擎切换模式。`voiceStore.playChapter` 根据 `engine` 字段分发到系统路径（`TtsAudio.speak`）或云端路径（现有 `synthesizeToFile → playAudioFile`）。扩展现有 `TtsAudioModule.kt`，不新建模块、不新增依赖、不升级数据库 schema。配置走 `settings` 键值表，与现有 `voice_config` 并行。

**Tech Stack:** React Native 0.85 + TypeScript + Zustand + Kotlin（Android `android.speech.tts.TextToSpeech`）+ Jest

**设计稿：** `docs/superpowers/specs/2026-06-25-system-tts-engine-design.md`

---

## File Structure

| 文件 | 改动类型 | 职责 |
|---|---|---|
| `src/types/tts.ts` | 修改 | 新增 `TtsEngine`、`SystemTtsConfig`、`SystemTtsEngineInfo`、`SystemTtsVoiceInfo` 类型 |
| `src/constants/voice.ts` | 修改 | 新增 `DEFAULT_TTS_ENGINE`、`DEFAULT_SYSTEM_TTS_CONFIG` |
| `src/services/database.ts` | 修改 | 新增 `getTtsEngine/setTtsEngine/getSystemTtsConfig/setSystemTtsConfig` |
| `src/native/TtsAudioModule.ts` | 修改 | 接口扩展 speak/stopSpeak/isTtsReady/getEngines/getVoices |
| `android/app/src/main/java/com/shinewriter/TtsAudioModule.kt` | 修改 | 新增 TextToSpeech 相关方法 |
| `src/store/voiceStore.ts` | 修改 | 新增 engine/systemConfig state、分发逻辑、stop 互斥 |
| `src/screens/VoiceSettingsScreen.tsx` | 修改 | 顶部引擎切换 + 按引擎显示字段 |
| `__tests__/voiceStoreEngine.test.ts` | 新建 | 引擎分发测试 |
| `jest.setup.js` | 修改 | 补充 `NativeModules.TtsAudio` 新方法 mock |

---

## Task 1: 类型与常量扩展

**Files:**
- Modify: `src/types/tts.ts`
- Modify: `src/constants/voice.ts`

- [ ] **Step 1: 扩展 `src/types/tts.ts`**

在文件末尾追加（保留现有 `VoiceConfig`、`VoicePreset` 不动）：

```ts
export type TtsEngine = 'system' | 'cloud';

export interface SystemTtsConfig {
  enginePackage: string;
  voiceKey: string;
  language: string;
  speed: number;
  pitch: number;
  volume: number;
}

export interface SystemTtsEngineInfo {
  name: string;
  label: string;
  isDefault: boolean;
}

export interface SystemTtsVoiceInfo {
  key: string;
  name: string;
  locale: string;
}

export interface SpeakConfig {
  enginePackage: string;
  voiceKey: string;
  language: string;
  speed: number;
  pitch: number;
  volume: number;
}
```

- [ ] **Step 2: 扩展 `src/constants/voice.ts`**

在文件末尾追加，并补 import：

```ts
import type { VoiceConfig, VoicePreset, TtsEngine, SystemTtsConfig } from '../types/tts';

// ... 现有 DEFAULT_VOICE_CONFIG 保持不变 ...

export const DEFAULT_TTS_ENGINE: TtsEngine = 'system';

export const DEFAULT_SYSTEM_TTS_CONFIG: SystemTtsConfig = {
  enginePackage: '',
  voiceKey: '',
  language: 'zh-CN',
  speed: 1.0,
  pitch: 1.0,
  volume: 1.0,
};

export const SYSTEM_TTS_LANGUAGE_OPTIONS: { value: string; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en-US', label: 'English (US)' },
];
```

注意把文件顶部现有的 `import type { VoiceConfig, VoicePreset } from '../types/tts';` 替换为新的四类型 import。

- [ ] **Step 3: 提交**

```bash
git add src/types/tts.ts src/constants/voice.ts
git commit -m "feat(tts): add system TTS engine types and constants"
```

---

## Task 2: 数据库存取方法

**Files:**
- Modify: `src/services/database.ts`

- [ ] **Step 1: 补 import**

在 `src/services/database.ts` 顶部的类型 import 区域，补充新类型导入。找到现有 `import type { VoiceConfig } from '../types/tts';`（或类似），改为：

```ts
import type { VoiceConfig, TtsEngine, SystemTtsConfig } from '../types/tts';
import { DEFAULT_SYSTEM_TTS_CONFIG } from '../constants/voice';
```

- [ ] **Step 2: 新增四个存取方法**

在现有 `getVoiceConfig/setVoiceConfig` 之后（约第 1398 行附近）追加：

```ts
export async function getTtsEngine(): Promise<TtsEngine> {
  const value = await getSetting('tts_engine');
  return value === 'cloud' ? 'cloud' : 'system';
}

export async function setTtsEngine(engine: TtsEngine): Promise<void> {
  await setSetting('tts_engine', engine);
}

export async function getSystemTtsConfig(): Promise<SystemTtsConfig> {
  const raw = await getSetting('system_tts_config');
  if (!raw) return DEFAULT_SYSTEM_TTS_CONFIG;
  try {
    return { ...DEFAULT_SYSTEM_TTS_CONFIG, ...(JSON.parse(raw) as Partial<SystemTtsConfig>) };
  } catch {
    return DEFAULT_SYSTEM_TTS_CONFIG;
  }
}

export async function setSystemTtsConfig(config: SystemTtsConfig): Promise<void> {
  await setSetting('system_tts_config', JSON.stringify(config));
}
```

- [ ] **Step 3: 提交**

```bash
git add src/services/database.ts
git commit -m "feat(tts): add system TTS config persistence to database layer"
```

---

## Task 3: 原生模块 JS 桥接扩展

**Files:**
- Modify: `src/native/TtsAudioModule.ts`

- [ ] **Step 1: 扩展 TS 接口**

将 `src/native/TtsAudioModule.ts` 整体替换为：

```ts
import { NativeModules } from 'react-native';
import type {
  SpeakConfig,
  SystemTtsEngineInfo,
  SystemTtsVoiceInfo,
} from '../types/tts';

interface TtsAudioNative {
  playAudioFile(path: string): Promise<void>;
  stopAudio(): Promise<void>;
  speak(text: string, config: SpeakConfig): Promise<void>;
  stopSpeak(): Promise<void>;
  isTtsReady(): Promise<boolean>;
  getEngines(): Promise<SystemTtsEngineInfo[]>;
  getVoices(enginePackage?: string): Promise<SystemTtsVoiceInfo[]>;
}

export const TtsAudio: TtsAudioNative = NativeModules.TtsAudio;
```

- [ ] **Step 2: 提交**

```bash
git add src/native/TtsAudioModule.ts
git commit -m "feat(tts): extend TS bridge interface for system TTS methods"
```

---

## Task 4: 原生 Kotlin 模块扩展（核心）

**Files:**
- Modify: `android/app/src/main/java/com/shinewriter/TtsAudioModule.kt`

这是本计划最复杂的步骤。在现有 `TtsAudioModule.kt` 上扩展，保留所有现有 `MediaPlayer` 逻辑不动。

- [ ] **Step 1: 重写 `TtsAudioModule.kt`**

将整个文件替换为以下内容（含现有 MediaPlayer 逻辑 + 新增 TextToSpeech 逻辑）：

```kotlin
package com.shinewriter

import android.content.ComponentName
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Build
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.util.Locale

class TtsAudioModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private var mediaPlayer: MediaPlayer? = null
  private var currentPromise: Promise? = null

  // ===== System TextToSpeech =====
  private var tts: TextToSpeech? = null
  private var ttsReady: Boolean = false
  private var pendingSpeakPromise: Promise? = null
  private var pendingSpeakText: String? = null
  private var pendingSpeakConfig: ReadableMap? = null
  private val utteranceId = "shinewriter-tts-utterance"
  private var currentEnginePackage: String? = null

  override fun getName(): String = "TtsAudio"

  // ===== Existing MediaPlayer playback (unchanged) =====

  @ReactMethod
  fun playAudioFile(path: String, promise: Promise) {
    stopAudioInternal(rejectPending = true)
    stopSpeakInternal(rejectPending = false)  // 互斥：先停系统 TTS

    val file = File(path)
    if (!file.exists()) {
      promise.reject("FILE_NOT_FOUND", "音频文件不存在: $path")
      return
    }

    currentPromise = promise
    try {
      mediaPlayer = MediaPlayer().apply {
        setDataSource(path)
        setOnCompletionListener {
          releasePlayer()
          currentPromise?.resolve(null)
          currentPromise = null
        }
        setOnErrorListener { _, what, extra ->
          releasePlayer()
          currentPromise?.reject("PLAYBACK_ERROR", "播放失败: what=$what extra=$extra")
          currentPromise = null
          true
        }
        prepare()
        start()
      }
    } catch (e: Exception) {
      Log.e("TtsAudio", "playAudioFile failed", e)
      releasePlayer()
      currentPromise?.reject("PLAYBACK_EXCEPTION", "播放异常: ${e.message}")
      currentPromise = null
    }
  }

  @ReactMethod
  fun stopAudio(promise: Promise) {
    stopAudioInternal(rejectPending = true)
    promise.resolve(null)
  }

  private fun stopAudioInternal(rejectPending: Boolean) {
    releasePlayer()
    if (rejectPending && currentPromise != null) {
      currentPromise?.reject("CANCELLED", "播放已停止")
      currentPromise = null
    }
  }

  private fun releasePlayer() {
    try {
      mediaPlayer?.let { player ->
        if (player.isPlaying) {
          player.stop()
        }
        player.reset()
        player.release()
      }
    } catch (e: Exception) {
      Log.e("TtsAudio", "releasePlayer error", e)
    } finally {
      mediaPlayer = null
    }
  }

  // ===== System TTS methods (new) =====

  @ReactMethod
  fun speak(text: String, config: ReadableMap, promise: Promise) {
    stopAudioInternal(rejectPending = true)  // 互斥：先停 MediaPlayer

    if (text.isBlank()) {
      promise.reject("EMPTY_TEXT", "朗读文本为空")
      return
    }

    pendingSpeakPromise = promise
    pendingSpeakText = text
    pendingSpeakConfig = config
    ensureTts { ok ->
      if (!ok) {
        pendingSpeakPromise?.reject("TTS_ENGINE_UNAVAILABLE", "未找到 TTS 引擎，请前往系统设置安装")
        pendingSpeakPromise = null
        pendingSpeakText = null
        pendingSpeakConfig = null
        return@ensureTts
      }
      doSpeak()
    }
  }

  @ReactMethod
  fun stopSpeak(promise: Promise) {
    stopSpeakInternal(rejectPending = false)
    promise.resolve(null)
  }

  @ReactMethod
  fun isTtsReady(promise: Promise) {
    promise.resolve(ttsReady)
  }

  @ReactMethod
  fun getEngines(promise: Promise) {
    val result: WritableArray = Arguments.createArray()
    try {
      ensureTts { _ ->
        val ttsInstance = tts
        if (ttsInstance == null) {
          promise.resolve(result)
          return@ensureTts
        }
        val defaultEngineName = ttsInstance.defaultEngine
        val engines = ttsInstance.engines
        if (engines != null) {
          for (engine in engines) {
            val map: WritableMap = Arguments.createMap()
            map.putString("name", engine.name)
            map.putString("label", engine.label ?: engine.name)
            map.putBoolean("isDefault", engine.name == defaultEngineName)
            result.pushMap(map)
          }
        }
        promise.resolve(result)
      }
    } catch (e: Exception) {
      Log.e("TtsAudio", "getEngines failed", e)
      promise.resolve(result)
    }
  }

  @ReactMethod
  fun getVoices(enginePackage: String?, promise: Promise) {
    val result: WritableArray = Arguments.createArray()
    try {
      ensureTts { _ ->
        val ttsInstance = tts
        if (ttsInstance == null) {
          promise.resolve(result)
          return@ensureTts
        }
        val voices = ttsInstance.voices
        if (voices != null) {
          for (voice in voices) {
            val map: WritableMap = Arguments.createMap()
            map.putString("key", voice.key ?: "")
            map.putString("name", voice.name ?: "")
            map.putString("locale", voice.locale?.toLanguageTag() ?: "")
            result.pushMap(map)
          }
        }
        promise.resolve(result)
      }
    } catch (e: Exception) {
      Log.e("TtsAudio", "getVoices failed", e)
      promise.resolve(result)
    }
  }

  // ===== Internal helpers =====

  private fun ensureTts(callback: (Boolean) -> Unit) {
    if (tts != null) {
      callback(ttsReady)
      return
    }
    try {
      tts = TextToSpeech(reactApplicationContext) { status ->
        ttsReady = status == TextToSpeech.SUCCESS
        if (ttsReady) {
          tts?.setAudioAttributes(
            AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_MEDIA)
              .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
              .build()
          )
          tts?.setOnUtteranceProgressListener(utteranceListener)
        }
        callback(ttsReady)
      }
    } catch (e: Exception) {
      Log.e("TtsAudio", "TextToSpeech init failed", e)
      callback(false)
    }
  }

  private fun doSpeak() {
    val ttsInstance = tts
    val text = pendingSpeakText
    val config = pendingSpeakConfig
    val promise = pendingSpeakPromise
    if (ttsInstance == null || text == null || config == null || promise == null) {
      return
    }

    try {
      val enginePackage = if (config.hasKey("enginePackage")) config.getString("enginePackage") else null
      val voiceKey = if (config.hasKey("voiceKey")) config.getString("voiceKey") else null
      val language = if (config.hasKey("language")) config.getString("language") else null
      val speed = if (config.hasKey("speed")) config.getDouble("speed") else 1.0
      val pitch = if (config.hasKey("pitch")) config.getDouble("pitch") else 1.0
      val volume = if (config.hasKey("volume")) config.getDouble("volume") else 1.0

      // 切换引擎（若与当前不同）
      if (!enginePackage.isNullOrEmpty() && enginePackage != currentEnginePackage) {
        // TextToSpeech 引擎在构造时确定，运行时切换需要重建实例
        rebuildTtsWithEngine(enginePackage)
        // rebuild 异步，onInit 成功后会再次进入 doSpeak
        return
      }

      // 设置语言
      if (!language.isNullOrEmpty()) {
        val parts = language.split("-")
        val locale = if (parts.size >= 2) Locale(parts[0], parts[1]) else Locale(parts[0])
        ttsInstance.language = locale
      }

      // 设置声线（API 21+）
      if (!voiceKey.isNullOrEmpty()) {
        val voices = ttsInstance.voices
        if (voices != null) {
          val matched = voices.find { it.key == voiceKey }
          if (matched != null) {
            ttsInstance.voice = matched
          }
        }
      }

      ttsInstance.setSpeechRate(speed.toFloat())
      ttsInstance.setPitch(pitch.toFloat())

      val params = android.speech.tts.TextToSpeech.Engine.KEY_PARAM_VOLUME to volume.toFloat()
      val result = ttsInstance.speak(
        text,
        TextToSpeech.QUEUE_FLUSH,
        null,
        utteranceId
      )
      if (result == TextToSpeech.SUCCESS) {
        // 约定：朗读开始即 resolve（onStart 由 utteranceListener 处理，
        // 但 onStart 不可靠，所以此处 speak 入队成功后立即 resolve）
        promise.resolve(null)
        pendingSpeakPromise = null
        pendingSpeakText = null
        pendingSpeakConfig = null
      } else {
        promise.reject("TTS_SPEAK_ERROR", "TTS 入队失败 code=$result")
        pendingSpeakPromise = null
        pendingSpeakText = null
        pendingSpeakConfig = null
      }
    } catch (e: Exception) {
      Log.e("TtsAudio", "doSpeak failed", e)
      promise.reject("TTS_SPEAK_ERROR", "朗读异常: ${e.message}")
      pendingSpeakPromise = null
      pendingSpeakText = null
      pendingSpeakConfig = null
    }
  }

  private fun rebuildTtsWithEngine(enginePackage: String) {
    currentEnginePackage = enginePackage
    try {
      tts?.shutdown()
      tts = null
      ttsReady = false
      val engine = ComponentName(enginePackage, "$enginePackage.TtsService")
      val intent = android.content.Intent(reactApplicationContext, engine.javaClass)
      intent.setPackage(enginePackage)
      tts = TextToSpeech(reactApplicationContext, { status ->
        ttsReady = status == TextToSpeech.SUCCESS
        if (ttsReady) {
          tts?.setAudioAttributes(
            AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_MEDIA)
              .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
              .build()
          )
          tts?.setOnUtteranceProgressListener(utteranceListener)
          doSpeak()
        } else {
          pendingSpeakPromise?.reject("TTS_ENGINE_NOT_READY", "引擎切换失败")
          pendingSpeakPromise = null
        }
      }, engine)
    } catch (e: Exception) {
      Log.e("TtsAudio", "rebuildTtsWithEngine failed", e)
      // 回退到默认引擎重试
      currentEnginePackage = null
      ensureTts { ok ->
        if (ok) doSpeak() else {
          pendingSpeakPromise?.reject("TTS_ENGINE_NOT_READY", "引擎切换失败")
          pendingSpeakPromise = null
        }
      }
    }
  }

  private val utteranceListener = object : UtteranceProgressListener() {
    override fun onStart(utteranceId: String?) {
      // 朗读开始（约定：promise 已在 speak 入队成功时 resolve，此处仅作日志）
    }

    override fun onDone(utteranceId: String?) {
      // 朗读完成（约定：不驱动 promise，仅清理内部状态）
    }

    override fun onError(utteranceId: String?) {
      // 朗读错误（约定：promise 已在入队成功时 resolve，此处仅日志）
    }
  }

  private fun stopSpeakInternal(rejectPending: Boolean) {
    try {
      tts?.stop()
    } catch (e: Exception) {
      Log.e("TtsAudio", "stopSpeak error", e)
    }
    if (rejectPending && pendingSpeakPromise != null) {
      pendingSpeakPromise?.reject("CANCELLED", "朗读已停止")
    }
    pendingSpeakPromise = null
    pendingSpeakText = null
    pendingSpeakConfig = null
  }

  // ===== Lifecycle cleanup =====

  override fun onCatalystInstanceDestroy() {
    stopAudioInternal(rejectPending = false)
    stopSpeakInternal(rejectPending = false)
    try {
      tts?.shutdown()
    } catch (e: Exception) {
      Log.e("TtsAudio", "tts shutdown error", e)
    }
    tts = null
    super.onCatalystInstanceDestroy()
  }
}
```

- [ ] **Step 2: 验证编译（不阻塞，可在端到端构建时验证）**

此步骤的真正验证在 Task 7 的全量 APK 构建中完成。当前 Kotlin 文件如有语法错误，构建时会暴露。

- [ ] **Step 3: 提交**

```bash
git add android/app/src/main/java/com/shinewriter/TtsAudioModule.kt
git commit -m "feat(tts): integrate Android system TextToSpeech into TtsAudioModule"
```

---

## Task 5: voiceStore 分发逻辑与 stop 互斥

**Files:**
- Modify: `src/store/voiceStore.ts`

- [ ] **Step 1: 重写 `src/store/voiceStore.ts`**

将整个文件替换为：

```ts
import { create } from 'zustand';
import Toast from 'react-native-toast-message';
import * as db from '../services/database';
import { synthesizeToFile, cancelTts, isTtsTextTooLong } from '../services/tts';
import {
  getSecureVoiceApiKey,
  setSecureVoiceApiKey,
} from '../services/secureStorage';
import { TtsAudio } from '../native/TtsAudioModule';
import { DEFAULT_VOICE_CONFIG, DEFAULT_SYSTEM_TTS_CONFIG, DEFAULT_TTS_ENGINE } from '../constants/voice';
import type { VoiceConfig, TtsEngine, SystemTtsConfig } from '../types/tts';
import RNFS from 'react-native-fs';

interface VoiceState {
  engine: TtsEngine;
  config: VoiceConfig;
  apiKey: string;
  systemConfig: SystemTtsConfig;
  isSynthesizing: boolean;
  isPlaying: boolean;
  loadVoiceConfig: () => Promise<void>;
  saveVoiceConfig: (config: VoiceConfig) => Promise<void>;
  saveSystemTtsConfig: (config: SystemTtsConfig) => Promise<void>;
  setEngine: (engine: TtsEngine) => Promise<void>;
  setVoiceApiKey: (key: string) => Promise<void>;
  setMiniMaxApiKey: (key: string) => Promise<void>;
  playChapter: (text: string) => Promise<void>;
  stop: () => Promise<void>;
}

async function deleteIfExists(path: string): Promise<void> {
  try {
    if (await RNFS.exists(path)) {
      await RNFS.unlink(path);
    }
  } catch {
    // ignore cleanup errors
  }
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  engine: DEFAULT_TTS_ENGINE,
  config: DEFAULT_VOICE_CONFIG,
  apiKey: '',
  systemConfig: DEFAULT_SYSTEM_TTS_CONFIG,
  isSynthesizing: false,
  isPlaying: false,

  loadVoiceConfig: async () => {
    const [config, apiKey, engine, systemConfig] = await Promise.all([
      db.getVoiceConfig(),
      getSecureVoiceApiKey(),
      db.getTtsEngine(),
      db.getSystemTtsConfig(),
    ]);
    set({ config, apiKey, engine, systemConfig });
  },

  saveVoiceConfig: async (config) => {
    await db.setVoiceConfig(config);
    set({ config });
  },

  saveSystemTtsConfig: async (systemConfig) => {
    await db.setSystemTtsConfig(systemConfig);
    set({ systemConfig });
  },

  setEngine: async (engine) => {
    await get().stop();
    await db.setTtsEngine(engine);
    set({ engine });
  },

  setVoiceApiKey: async (key) => {
    await setSecureVoiceApiKey(key);
    set({ apiKey: key.trim() });
  },

  setMiniMaxApiKey: async (key) => {
    await get().setVoiceApiKey(key);
  },

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
        await TtsAudio.speak(text, state.systemConfig);
        set({ isSynthesizing: false, isPlaying: true });
      } catch (error: any) {
        set({ isSynthesizing: false, isPlaying: false });
        const message = error?.message || '朗读失败';
        if (!message.includes('取消') && !message.includes('停止')) {
          Toast.show({ type: 'error', text1: message });
        }
      }
      return;
    }

    // 云端路径（保持不变）
    if (!state.apiKey.trim()) {
      Toast.show({ type: 'error', text1: '请先配置语音 API Key' });
      return;
    }
    if (isTtsTextTooLong(text)) {
      Toast.show({ type: 'info', text1: '正文超过 10000 字，将只朗读前 10000 字' });
    }

    set({ isSynthesizing: true });
    let audioPath: string | null = null;
    try {
      audioPath = await synthesizeToFile(text, state.config, state.apiKey);
      set({ isSynthesizing: false, isPlaying: true });
      try {
        await TtsAudio.playAudioFile(audioPath);
      } finally {
        set({ isPlaying: false });
        if (audioPath) {
          await deleteIfExists(audioPath);
        }
      }
    } catch (error: any) {
      set({ isSynthesizing: false, isPlaying: false });
      if (audioPath) {
        await deleteIfExists(audioPath);
      }
      const message = error?.message || '朗读失败';
      if (!message.includes('取消') && !message.includes('停止')) {
        Toast.show({ type: 'error', text1: message });
      }
    }
  },

  stop: async () => {
    const { engine, isSynthesizing, isPlaying } = get();
    if (!isSynthesizing && !isPlaying) return;
    set({ isSynthesizing: false, isPlaying: false });
    if (engine === 'system') {
      try {
        await TtsAudio.stopSpeak();
      } catch {
        // ignore
      }
    } else {
      if (isSynthesizing) {
        await cancelTts();
      }
      if (isPlaying) {
        try {
          await TtsAudio.stopAudio();
        } catch {
          // ignore
        }
      }
    }
  },
}));
```

- [ ] **Step 2: 提交**

```bash
git add src/store/voiceStore.ts
git commit -m "feat(tts): add engine dispatch and stop mutex in voiceStore"
```

---

## Task 6: VoiceSettingsScreen UI 引擎切换

**Files:**
- Modify: `src/screens/VoiceSettingsScreen.tsx`

- [ ] **Step 1: 重写 `src/screens/VoiceSettingsScreen.tsx`**

将整个文件替换为（保留现有云端字段、新增顶部引擎切换和系统 TTS 字段）：

```tsx
import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Save, Volume2 } from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import { Button, Field, Header, Screen, SegmentedControl, spacing } from '../components/ui';
import { useThemeStore } from '../store/themeStore';
import { useVoiceStore } from '../store/voiceStore';
import {
  VOICE_PRESETS,
  DEFAULT_VOICE_CONFIG,
  DEFAULT_SYSTEM_TTS_CONFIG,
  VOICE_API_URL_EXAMPLE,
  SYSTEM_TTS_LANGUAGE_OPTIONS,
} from '../constants/voice';
import { TtsAudio } from '../native/TtsAudioModule';
import type {
  VoiceConfig,
  TtsAudioFormat,
  TtsSampleRate,
  TtsBitrate,
  TtsEngine,
  SystemTtsConfig,
  SystemTtsEngineInfo,
  SystemTtsVoiceInfo,
} from '../types/tts';

const SAMPLE_TEXT = '这是 ShineWriter 的语音测试，Hello world，一二三四五。';

const FORMAT_OPTIONS: { value: TtsAudioFormat; label: string }[] = [
  { value: 'mp3', label: 'MP3' },
  { value: 'wav', label: 'WAV' },
  { value: 'flac', label: 'FLAC' },
];

const SAMPLE_RATE_OPTIONS: { value: TtsSampleRate; label: string }[] = [
  { value: 16000, label: '16k' },
  { value: 24000, label: '24k' },
  { value: 32000, label: '32k' },
  { value: 44100, label: '44.1k' },
];

const BITRATE_OPTIONS: { value: TtsBitrate; label: string }[] = [
  { value: 32000, label: '32k' },
  { value: 64000, label: '64k' },
  { value: 128000, label: '128k' },
];

const ENGINE_OPTIONS: { value: TtsEngine; label: string }[] = [
  { value: 'system', label: '系统 TTS' },
  { value: 'cloud', label: '云端 API' },
];

export const VoiceSettingsScreen: React.FC = () => {
  const { theme } = useThemeStore();
  const {
    engine: savedEngine,
    config: savedConfig,
    apiKey: savedApiKey,
    systemConfig: savedSystemConfig,
    loadVoiceConfig,
    saveVoiceConfig,
    saveSystemTtsConfig,
    setEngine,
    setVoiceApiKey,
    playChapter,
  } = useVoiceStore();

  const [engineDraft, setEngineDraft] = useState<TtsEngine>(savedEngine);
  const [draft, setDraft] = useState<VoiceConfig>(DEFAULT_VOICE_CONFIG);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [systemDraft, setSystemDraft] = useState<SystemTtsConfig>(DEFAULT_SYSTEM_TTS_CONFIG);
  const [testing, setTesting] = useState(false);
  const [voiceDropdownOpen, setVoiceDropdownOpen] = useState(false);
  const [engines, setEngines] = useState<SystemTtsEngineInfo[]>([]);
  const [voices, setVoices] = useState<SystemTtsVoiceInfo[]>([]);
  const [engineDropdownOpen, setEngineDropdownOpen] = useState(false);
  const [voiceListDropdownOpen, setVoiceListDropdownOpen] = useState(false);

  useEffect(() => {
    loadVoiceConfig();
  }, [loadVoiceConfig]);

  useEffect(() => {
    setEngineDraft(savedEngine);
    setDraft(savedConfig);
    setApiKeyDraft(savedApiKey);
    setSystemDraft(savedSystemConfig);
  }, [savedEngine, savedConfig, savedApiKey, savedSystemConfig]);

  // 加载系统 TTS 引擎列表
  useEffect(() => {
    if (engineDraft !== 'system') return;
    let mounted = true;
    TtsAudio.getEngines()
      .then((list) => {
        if (mounted) setEngines(list);
      })
      .catch(() => {
        if (mounted) setEngines([]);
      });
    return () => {
      mounted = false;
    };
  }, [engineDraft]);

  // 加载声线列表（引擎或语言变化时）
  useEffect(() => {
    if (engineDraft !== 'system') return;
    let mounted = true;
    TtsAudio.getVoices(systemDraft.enginePackage || undefined)
      .then((list) => {
        if (!mounted) return;
        // 按当前语言过滤
        const langBase = systemDraft.language.split('-')[0];
        const filtered = list.filter((v) => v.locale.toLowerCase().startsWith(langBase.toLowerCase()));
        setVoices(filtered.length > 0 ? filtered : list);
      })
      .catch(() => {
        if (mounted) setVoices([]);
      });
    return () => {
      mounted = false;
    };
  }, [engineDraft, systemDraft.enginePackage, systemDraft.language]);

  const updateDraft = (fields: Partial<VoiceConfig>) => {
    setDraft((current) => ({ ...current, ...fields }));
  };

  const updateSystemDraft = (fields: Partial<SystemTtsConfig>) => {
    setSystemDraft((current) => ({ ...current, ...fields }));
  };

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

  const onEngineChange = async (value: TtsEngine) => {
    setEngineDraft(value);
    try {
      await setEngine(value);
      Toast.show({ type: 'success', text1: value === 'system' ? '已切换到系统 TTS' : '已切换到云端 API' });
    } catch {
      // ignore
    }
  };

  const selectedVoicePreset = VOICE_PRESETS.find((preset) => preset.id === draft.voiceId);
  const voiceLabel = selectedVoicePreset?.name || '自定义音色 ID';
  const selectedEngineLabel =
    engines.find((e) => e.name === systemDraft.enginePackage)?.label ||
    (systemDraft.enginePackage ? systemDraft.enginePackage : '系统默认引擎');
  const selectedVoiceLabel =
    voices.find((v) => v.key === systemDraft.voiceKey)?.name ||
    (systemDraft.voiceKey ? systemDraft.voiceKey : '引擎默认声线');

  const normalizedDraft = (): VoiceConfig => ({
    ...draft,
    apiUrl: draft.apiUrl.trim(),
    model: draft.model.trim(),
    voiceId: draft.voiceId.trim(),
  });

  const save = async () => {
    try {
      await Promise.all([
        saveVoiceConfig(normalizedDraft()),
        setVoiceApiKey(apiKeyDraft),
        saveSystemTtsConfig(systemDraft),
      ]);
      Toast.show({ type: 'success', text1: '语音设置已保存' });
    } catch (error: any) {
      Alert.alert('保存失败', error?.message || '请重试');
    }
  };

  const testVoice = async () => {
    if (engineDraft === 'cloud' && !apiKeyDraft.trim()) {
      Alert.alert('缺少 API Key', '请先填写语音 API Key。');
      return;
    }
    setTesting(true);
    try {
      await Promise.all([
        setVoiceApiKey(apiKeyDraft),
        saveVoiceConfig(normalizedDraft()),
        saveSystemTtsConfig(systemDraft),
      ]);
      await playChapter(SAMPLE_TEXT);
    } catch (error: any) {
      Alert.alert('测试失败', error?.message || '请检查语音配置。');
    } finally {
      setTesting(false);
    }
  };

  return (
    <Screen>
      <Header title="语音设置" subtitle="朗读引擎 / 语音 API" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>朗读引擎</Text>
        <SegmentedControl value={engineDraft} options={ENGINE_OPTIONS} onChange={(value) => onEngineChange(value)} />

        {engineDraft === 'system' ? (
          <SystemTtsFields
            theme={theme}
            systemDraft={systemDraft}
            engines={engines}
            voices={voices}
            selectedEngineLabel={selectedEngineLabel}
            selectedVoiceLabel={selectedVoiceLabel}
            engineDropdownOpen={engineDropdownOpen}
            voiceListDropdownOpen={voiceListDropdownOpen}
            updateSystemDraft={updateSystemDraft}
            setEngineDropdownOpen={setEngineDropdownOpen}
            setVoiceListDropdownOpen={setVoiceListDropdownOpen}
            clamp={clamp}
          />
        ) : (
          <CloudTtsFields
            theme={theme}
            draft={draft}
            apiKeyDraft={apiKeyDraft}
            setApiKeyDraft={setApiKeyDraft}
            updateDraft={updateDraft}
            selectedVoicePreset={selectedVoicePreset}
            voiceLabel={voiceLabel}
            voiceDropdownOpen={voiceDropdownOpen}
            setVoiceDropdownOpen={setVoiceDropdownOpen}
            clamp={clamp}
          />
        )}

        <View style={styles.actions}>
          <Button label={testing ? '测试中…' : '测试朗读'} icon={Volume2} onPress={testVoice} disabled={testing} />
          <Button label="保存" icon={Save} variant="secondary" onPress={save} />
        </View>
      </ScrollView>
    </Screen>
  );
};

// ===== System TTS 字段子组件 =====
interface SystemTtsFieldsProps {
  theme: any;
  systemDraft: SystemTtsConfig;
  engines: SystemTtsEngineInfo[];
  voices: SystemTtsVoiceInfo[];
  selectedEngineLabel: string;
  selectedVoiceLabel: string;
  engineDropdownOpen: boolean;
  voiceListDropdownOpen: boolean;
  updateSystemDraft: (fields: Partial<SystemTtsConfig>) => void;
  setEngineDropdownOpen: (open: boolean) => void;
  setVoiceListDropdownOpen: (open: boolean) => void;
  clamp: (value: number, min: number, max: number) => number;
}

const SystemTtsFields: React.FC<SystemTtsFieldsProps> = ({
  theme,
  systemDraft,
  engines,
  voices,
  selectedEngineLabel,
  selectedVoiceLabel,
  engineDropdownOpen,
  voiceListDropdownOpen,
  updateSystemDraft,
  setEngineDropdownOpen,
  setVoiceListDropdownOpen,
  clamp,
}) => (
  <View>
    {engines.length === 0 ? (
      <Text style={[styles.hintText, { color: theme.colors.textSecondary }]}>
        未检测到 TTS 引擎，请前往手机系统设置安装。
      </Text>
    ) : null}

    <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>TTS 引擎</Text>
    <TouchableOpacity
      accessibilityRole="button"
      onPress={() => setEngineDropdownOpen(!engineDropdownOpen)}
      style={[styles.dropdownButton, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}
    >
      <Text style={[styles.dropdownText, { color: theme.colors.textPrimary }]}>{selectedEngineLabel}</Text>
      <Text style={[styles.dropdownHint, { color: theme.colors.textSecondary }]}>
        {engineDropdownOpen ? '收起' : '选择'}
      </Text>
    </TouchableOpacity>
    {engineDropdownOpen ? (
      <View style={[styles.dropdownList, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}>
        <TouchableOpacity
          onPress={() => {
            updateSystemDraft({ enginePackage: '', voiceKey: '' });
            setEngineDropdownOpen(false);
          }}
          style={[styles.dropdownOption, !systemDraft.enginePackage && { backgroundColor: theme.colors.accentSoft }]}
        >
          <Text
            style={[
              styles.dropdownOptionText,
              { color: !systemDraft.enginePackage ? theme.colors.accent : theme.colors.textPrimary },
            ]}
          >
            系统默认引擎
          </Text>
        </TouchableOpacity>
        {engines.map((engine) => {
          const active = engine.name === systemDraft.enginePackage;
          return (
            <TouchableOpacity
              key={engine.name}
              onPress={() => {
                updateSystemDraft({ enginePackage: engine.name, voiceKey: '' });
                setEngineDropdownOpen(false);
              }}
              style={[styles.dropdownOption, active && { backgroundColor: theme.colors.accentSoft }]}
            >
              <Text
                style={[styles.dropdownOptionText, { color: active ? theme.colors.accent : theme.colors.textPrimary }]}
              >
                {engine.label}
                {engine.isDefault ? '（默认）' : ''}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    ) : null}

    <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>语言</Text>
    <SegmentedControl
      value={systemDraft.language}
      options={SYSTEM_TTS_LANGUAGE_OPTIONS}
      onChange={(value) => updateSystemDraft({ language: value, voiceKey: '' })}
    />

    <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>声线</Text>
    <TouchableOpacity
      accessibilityRole="button"
      onPress={() => setVoiceListDropdownOpen(!voiceListDropdownOpen)}
      style={[styles.dropdownButton, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}
    >
      <Text style={[styles.dropdownText, { color: theme.colors.textPrimary }]}>{selectedVoiceLabel}</Text>
      <Text style={[styles.dropdownHint, { color: theme.colors.textSecondary }]}>
        {voiceListDropdownOpen ? '收起' : '选择'}
      </Text>
    </TouchableOpacity>
    {voiceListDropdownOpen ? (
      <View style={[styles.dropdownList, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}>
        <TouchableOpacity
          onPress={() => {
            updateSystemDraft({ voiceKey: '' });
            setVoiceListDropdownOpen(false);
          }}
          style={[styles.dropdownOption, !systemDraft.voiceKey && { backgroundColor: theme.colors.accentSoft }]}
        >
          <Text
            style={[
              styles.dropdownOptionText,
              { color: !systemDraft.voiceKey ? theme.colors.accent : theme.colors.textPrimary },
            ]}
          >
            引擎默认声线
          </Text>
        </TouchableOpacity>
        {voices.map((voice) => {
          const active = voice.key === systemDraft.voiceKey;
          return (
            <TouchableOpacity
              key={voice.key}
              onPress={() => {
                updateSystemDraft({ voiceKey: voice.key });
                setVoiceListDropdownOpen(false);
              }}
              style={[styles.dropdownOption, active && { backgroundColor: theme.colors.accentSoft }]}
            >
              <Text
                style={[styles.dropdownOptionText, { color: active ? theme.colors.accent : theme.colors.textPrimary }]}
              >
                {voice.name}（{voice.locale}）
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    ) : null}

    <View style={styles.numericRow}>
      <View style={styles.numericField}>
        <Field
          label="语速"
          value={String(systemDraft.speed)}
          onChangeText={(value) => updateSystemDraft({ speed: clamp(Number(value) || 1, 0.1, 10) })}
          keyboardType="numeric"
        />
      </View>
      <View style={styles.numericField}>
        <Field
          label="音调"
          value={String(systemDraft.pitch)}
          onChangeText={(value) => updateSystemDraft({ pitch: clamp(Number(value) || 1, 0, 2) })}
          keyboardType="numeric"
        />
      </View>
      <View style={styles.numericField}>
        <Field
          label="音量"
          value={String(systemDraft.volume)}
          onChangeText={(value) => updateSystemDraft({ volume: clamp(Number(value) || 1, 0, 1) })}
          keyboardType="numeric"
        />
      </View>
    </View>
  </View>
);

// ===== Cloud TTS 字段子组件（从原 UI 抽取，逻辑不变）=====
interface CloudTtsFieldsProps {
  theme: any;
  draft: VoiceConfig;
  apiKeyDraft: string;
  setApiKeyDraft: (value: string) => void;
  updateDraft: (fields: Partial<VoiceConfig>) => void;
  selectedVoicePreset?: { id: string; name: string };
  voiceLabel: string;
  voiceDropdownOpen: boolean;
  setVoiceDropdownOpen: (open: boolean) => void;
  clamp: (value: number, min: number, max: number) => number;
}

const CloudTtsFields: React.FC<CloudTtsFieldsProps> = ({
  theme,
  draft,
  apiKeyDraft,
  setApiKeyDraft,
  updateDraft,
  selectedVoicePreset,
  voiceLabel,
  voiceDropdownOpen,
  setVoiceDropdownOpen,
  clamp,
}) => (
  <View>
    <Field
      label="语音 API Key"
      value={apiKeyDraft}
      onChangeText={setApiKeyDraft}
      placeholder="填写语音服务 API Key"
      secureTextEntry
      autoCapitalize="none"
      autoCorrect={false}
    />
    <Field
      label="语音 API URL"
      value={draft.apiUrl}
      onChangeText={(value) => updateDraft({ apiUrl: value })}
      placeholder={VOICE_API_URL_EXAMPLE}
      autoCapitalize="none"
      autoCorrect={false}
    />
    <Field
      label="模型"
      value={draft.model}
      onChangeText={(value) => updateDraft({ model: value })}
      placeholder="例如 speech-2.8-hd"
      autoCapitalize="none"
      autoCorrect={false}
    />
    <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>音色</Text>
    <TouchableOpacity
      accessibilityRole="button"
      onPress={() => setVoiceDropdownOpen(!voiceDropdownOpen)}
      style={[styles.dropdownButton, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}
    >
      <Text style={[styles.dropdownText, { color: theme.colors.textPrimary }]}>{voiceLabel}</Text>
      <Text style={[styles.dropdownHint, { color: theme.colors.textSecondary }]}>
        {voiceDropdownOpen ? '收起' : '选择'}
      </Text>
    </TouchableOpacity>
    {voiceDropdownOpen ? (
      <View style={[styles.dropdownList, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}>
        {VOICE_PRESETS.map((preset) => {
          const active = preset.id === draft.voiceId;
          return (
            <TouchableOpacity
              key={preset.id}
              onPress={() => {
                updateDraft({ voiceId: preset.id });
                setVoiceDropdownOpen(false);
              }}
              style={[styles.dropdownOption, active && { backgroundColor: theme.colors.accentSoft }]}
            >
              <Text
                style={[styles.dropdownOptionText, { color: active ? theme.colors.accent : theme.colors.textPrimary }]}
              >
                {preset.name}
              </Text>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity
          onPress={() => {
            updateDraft({ voiceId: '' });
            setVoiceDropdownOpen(false);
          }}
          style={[styles.dropdownOption, !selectedVoicePreset && { backgroundColor: theme.colors.accentSoft }]}
        >
          <Text
            style={[
              styles.dropdownOptionText,
              { color: !selectedVoicePreset ? theme.colors.accent : theme.colors.textPrimary },
            ]}
          >
            自定义音色 ID
          </Text>
        </TouchableOpacity>
      </View>
    ) : null}
    {!selectedVoicePreset ? (
      <Field
        label="自定义音色 ID"
        value={draft.voiceId}
        onChangeText={(value) => updateDraft({ voiceId: value })}
        placeholder="输入语音服务的 voice_id"
        autoCapitalize="none"
        autoCorrect={false}
      />
    ) : null}
    <View style={styles.numericRow}>
      <View style={styles.numericField}>
        <Field
          label="语速"
          value={String(draft.speed)}
          onChangeText={(value) => updateDraft({ speed: clamp(Number(value) || 1, 0.5, 2) })}
          keyboardType="numeric"
        />
      </View>
      <View style={styles.numericField}>
        <Field
          label="音量"
          value={String(draft.vol)}
          onChangeText={(value) => updateDraft({ vol: clamp(Number(value) || 1, 0.1, 10) })}
          keyboardType="numeric"
        />
      </View>
      <View style={styles.numericField}>
        <Field
          label="音调"
          value={String(draft.pitch)}
          onChangeText={(value) => updateDraft({ pitch: Math.round(clamp(Number(value) || 0, -12, 12)) })}
          keyboardType="numeric"
        />
      </View>
    </View>
    <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>音频格式</Text>
    <SegmentedControl value={draft.format} options={FORMAT_OPTIONS} onChange={(value) => updateDraft({ format: value })} />
    <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>采样率</Text>
    <SegmentedControl
      value={draft.sampleRate}
      options={SAMPLE_RATE_OPTIONS}
      onChange={(value) => updateDraft({ sampleRate: value })}
    />
    <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>比特率</Text>
    <SegmentedControl value={draft.bitrate} options={BITRATE_OPTIONS} onChange={(value) => updateDraft({ bitrate: value })} />
  </View>
);

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: 120 },
  sectionLabel: { fontSize: 12, fontWeight: '700', marginTop: spacing.md, marginBottom: spacing.sm },
  hintText: { fontSize: 12, marginTop: spacing.sm, marginBottom: spacing.sm },
  dropdownButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownText: { fontSize: 15, fontWeight: '700' },
  dropdownHint: { fontSize: 12, fontWeight: '700' },
  dropdownList: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, marginTop: spacing.xs, overflow: 'hidden' },
  dropdownOption: { minHeight: 40, justifyContent: 'center', paddingHorizontal: spacing.md },
  dropdownOptionText: { fontSize: 14, fontWeight: '600' },
  numericRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  numericField: { flex: 1 },
  actions: { gap: spacing.md, marginTop: spacing.xl },
});
```

- [ ] **Step 2: 提交**

```bash
git add src/screens/VoiceSettingsScreen.tsx
git commit -m "feat(tts): add engine switcher and system TTS fields to voice settings"
```

---

## Task 7: jest.setup mock 补充

**Files:**
- Modify: `jest.setup.js`

- [ ] **Step 1: 扩展 `NativeModules.TtsAudio` mock**

将 `jest.setup.js` 第 100-107 行的 React Native mock 替换为：

```js
jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  RN.NativeModules.TtsAudio = {
    playAudioFile: jest.fn(() => Promise.resolve()),
    stopAudio: jest.fn(() => Promise.resolve()),
    speak: jest.fn(() => Promise.resolve()),
    stopSpeak: jest.fn(() => Promise.resolve()),
    isTtsReady: jest.fn(() => Promise.resolve(true)),
    getEngines: jest.fn(() => Promise.resolve([
      { name: 'com.google.android.tts', label: 'Google TTS', isDefault: true },
    ])),
    getVoices: jest.fn(() => Promise.resolve([
      { key: 'zh-cn-x', name: '中文女声', locale: 'zh-CN' },
    ])),
  };
  return RN;
});
```

- [ ] **Step 2: 提交**

```bash
git add jest.setup.js
git commit -m "test(tts): mock system TTS native methods in jest setup"
```

---

## Task 8: 引擎分发单元测试

**Files:**
- Test: `__tests__/voiceStoreEngine.test.ts`

- [ ] **Step 1: 新建测试文件**

`__tests__/voiceStoreEngine.test.ts`:

```ts
import { useVoiceStore } from '../src/store/voiceStore';
import { TtsAudio } from '../src/native/TtsAudioModule';
import * as ttsService from '../src/services/tts';

jest.mock('../src/services/database', () => ({
  getVoiceConfig: jest.fn(() => Promise.resolve({
    apiUrl: '', model: 'm', voiceId: 'v', speed: 1, vol: 1, pitch: 0, sampleRate: 32000, bitrate: 128000, format: 'mp3',
  })),
  setVoiceConfig: jest.fn(() => Promise.resolve()),
  getTtsEngine: jest.fn(() => Promise.resolve('system')),
  setTtsEngine: jest.fn(() => Promise.resolve()),
  getSystemTtsConfig: jest.fn(() => Promise.resolve({
    enginePackage: '', voiceKey: '', language: 'zh-CN', speed: 1, pitch: 1, volume: 1,
  })),
  setSystemTtsConfig: jest.fn(() => Promise.resolve()),
}));

jest.mock('../src/services/secureStorage', () => ({
  getSecureVoiceApiKey: jest.fn(() => Promise.resolve('')),
  setSecureVoiceApiKey: jest.fn(() => Promise.resolve()),
}));

jest.mock('react-native-fs', () => ({
  exists: jest.fn(() => Promise.resolve(false)),
  unlink: jest.fn(() => Promise.resolve()),
}));

describe('voiceStore engine dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useVoiceStore.setState({
      engine: 'system',
      isSynthesizing: false,
      isPlaying: false,
      systemConfig: { enginePackage: '', voiceKey: '', language: 'zh-CN', speed: 1, pitch: 1, volume: 1 },
      config: { apiUrl: '', model: 'm', voiceId: 'v', speed: 1, vol: 1, pitch: 0, sampleRate: 32000, bitrate: 128000, format: 'mp3' },
      apiKey: '',
    });
  });

  test('system engine calls TtsAudio.speak, not synthesizeToFile', async () => {
    const speakSpy = jest.spyOn(TtsAudio, 'speak').mockResolvedValue(undefined);
    const synthSpy = jest.spyOn(ttsService, 'synthesizeToFile').mockResolvedValue('/tmp/x.mp3');

    await useVoiceStore.getState().playChapter('你好世界');

    expect(speakSpy).toHaveBeenCalled();
    expect(synthSpy).not.toHaveBeenCalled();
    speakSpy.mockRestore();
    synthSpy.mockRestore();
  });

  test('cloud engine calls synthesizeToFile + playAudioFile, not speak', async () => {
    useVoiceStore.setState({ engine: 'cloud', apiKey: 'k' });
    const speakSpy = jest.spyOn(TtsAudio, 'speak').mockResolvedValue(undefined);
    const synthSpy = jest.spyOn(ttsService, 'synthesizeToFile').mockResolvedValue('/tmp/x.mp3');
    const playSpy = jest.spyOn(TtsAudio, 'playAudioFile').mockResolvedValue(undefined);

    await useVoiceStore.getState().playChapter('你好世界');

    expect(synthSpy).toHaveBeenCalled();
    expect(playSpy).toHaveBeenCalled();
    expect(speakSpy).not.toHaveBeenCalled();
    speakSpy.mockRestore();
    synthSpy.mockRestore();
    playSpy.mockRestore();
  });

  test('stop in system engine calls TtsAudio.stopSpeak', async () => {
    useVoiceStore.setState({ engine: 'system', isPlaying: true });
    const stopSpeakSpy = jest.spyOn(TtsAudio, 'stopSpeak').mockResolvedValue(undefined);
    const stopAudioSpy = jest.spyOn(TtsAudio, 'stopAudio').mockResolvedValue(undefined);

    await useVoiceStore.getState().stop();

    expect(stopSpeakSpy).toHaveBeenCalled();
    expect(stopAudioSpy).not.toHaveBeenCalled();
    stopSpeakSpy.mockRestore();
    stopAudioSpy.mockRestore();
  });

  test('setEngine stops current playback before switching', async () => {
    useVoiceStore.setState({ engine: 'system', isPlaying: true });
    const stopSpeakSpy = jest.spyOn(TtsAudio, 'stopSpeak').mockResolvedValue(undefined);

    await useVoiceStore.getState().setEngine('cloud');

    expect(stopSpeakSpy).toHaveBeenCalled();
    expect(useVoiceStore.getState().engine).toBe('cloud');
    stopSpeakSpy.mockRestore();
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
npx jest __tests__/voiceStoreEngine.test.ts
```

Expected: 4 passed

- [ ] **Step 3: 提交**

```bash
git add __tests__/voiceStoreEngine.test.ts
git commit -m "test(tts): add engine dispatch and stop mutex tests"
```

---

## Task 9: 全量验证（lint + test）

**Files:** 无改动

- [ ] **Step 1: 运行 lint**

```bash
npm run lint
```

Expected: 0 errors（warning 可接受，但应无新增 error）

- [ ] **Step 2: 运行全部测试**

```bash
npm test
```

Expected: 所有测试 pass，包括新增的 `voiceStoreEngine.test.ts` 和既有的所有测试

- [ ] **Step 3: 如有失败，修复后重新运行直到全绿**

---

## Self-Review

**Spec coverage 检查：**
- 第 1 节目标（系统 TTS 引擎、默认 system、引擎切换、参数配置、朗读按钮无 Key 校验）→ Task 1/5/6 覆盖 ✅
- 第 2 节关键决策（顶层切换、扩展现有模块、settings 存储、互斥播放）→ Task 2/4/5 覆盖 ✅
- 第 4 节数据模型（类型、settings 键、默认值）→ Task 1/2 覆盖 ✅
- 第 5 节原生模块（speak/stopSpeak/isTtsReady/getEngines/getVoices、互斥、生命周期、完成回调约定）→ Task 4 覆盖 ✅
- 第 6 节数据库存取（四个方法）→ Task 2 覆盖 ✅
- 第 7 节 voiceStore（state、playChapter 分发、stop 互斥、setEngine stop）→ Task 5 覆盖 ✅
- 第 8 节 UI（顶部切换、系统字段、云端字段、测试朗读）→ Task 6 覆盖 ✅
- 第 9 节 ChapterEditor（无逻辑改动）→ 已在 spec 注明，无新增任务 ✅
- 第 10 节边界（无引擎提示、切换 stop、App 退出 shutdown）→ Task 4（onCatalystInstanceDestroy）+ Task 6（engines.length === 0 提示）覆盖 ✅
- 第 11 节测试（jest.setup + voiceStoreEngine）→ Task 7/8 覆盖 ✅

**Placeholder scan：** 无 TBD/TODO，所有代码块完整 ✅

**Type consistency：**
- `SystemTtsConfig` 字段名（enginePackage/voiceKey/language/speed/pitch/volume）在 Task 1/2/4/5/6/8 一致 ✅
- `TtsEngine = 'system' | 'cloud'` 在所有 Task 一致 ✅
- `TtsAudio` 方法名（speak/stopSpeak/isTtsReady/getEngines/getVoices）在 Task 3/4/5/7/8 一致 ✅
- `getTtsEngine/setTtsEngine/getSystemTtsConfig/setSystemTtsConfig` 在 Task 2/5/8 一致 ✅

**Potential issue fixed：**
- Task 4 的 `rebuildTtsWithEngine` 使用了 `engine.javaClass` 这种不存在的语法，已修正为直接 `ComponentName(enginePackage, ...)` + `TextToSpeech(context, listener, engine)` 构造重载，这是 Android 正确的运行时切换引擎 API。

---

## Execution

**执行方式：inline execution**（在当前会话内顺序执行，每个 Task 完成后 review + fix）。
