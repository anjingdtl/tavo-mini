package com.shinewriter

import android.content.Intent
import android.media.AudioAttributes
import android.media.MediaPlayer
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
import com.facebook.react.modules.core.DeviceEventManagerModule
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

    // 10.14 修复：覆盖 pending 前 reject 旧的 promise，避免 rebuildTtsWithEngine 等待期间旧 promise 永久挂起
    pendingSpeakPromise?.reject("CANCELLED", "新的朗读请求已覆盖")
    pendingSpeakPromise = promise
    pendingSpeakText = text
    pendingSpeakConfig = config

    val requestedEngine = if (config.hasKey("enginePackage")) config.getString("enginePackage") else null
    if (!requestedEngine.isNullOrEmpty() && requestedEngine != currentEnginePackage) {
      // 目标引擎与当前不同，需重建 TTS 实例（异步），onInit 成功后再次进入 doSpeak
      rebuildTtsWithEngine(requestedEngine)
      return
    }

    ensureTts { ok ->
      if (!ok) {
        pendingSpeakPromise?.reject("TTS_ENGINE_UNAVAILABLE", "未找到 TTS 引擎，请前往系统设置安装")
        clearPendingSpeak()
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
            // Android Voice 类用 name 作为唯一标识（无 key 字段），JS 侧的 key 字段对应 voice.name
            map.putString("key", voice.name ?: "")
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

  @ReactMethod
  fun openTtsSettings(promise: Promise) {
    try {
      // android.provider.Settings 未提供 TTS 设置常量，使用标准 action 字符串打开系统 TTS 设置页
      val intent = Intent("com.android.settings.TTS_SETTINGS")
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      reactApplicationContext.startActivity(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      Log.e("TtsAudio", "openTtsSettings failed", e)
      promise.reject("OPEN_TTS_SETTINGS_FAILED", "无法打开系统 TTS 设置")
    }
  }

  // NativeEventEmitter 要求原生模块实现这两个方法（空实现即可）
  @ReactMethod
  fun addListener(eventName: String) {
    // No-op: 事件发送走 RCTDeviceEventEmitter.emit，无需跟踪监听器
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // No-op: 同上
  }

  // ===== Internal helpers =====

  private fun ensureTts(callback: (Boolean) -> Unit) {
    if (tts != null) {
      callback(ttsReady)
      return
    }
    try {
      val ctx = reactApplicationContext
      tts = TextToSpeech(ctx) { status ->
        ttsReady = status == TextToSpeech.SUCCESS
        if (ttsReady) {
          applyAudioAttributes(tts)
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
      val voiceKey = if (config.hasKey("voiceKey")) config.getString("voiceKey") else null
      val language = if (config.hasKey("language")) config.getString("language") else null
      val speed = if (config.hasKey("speed")) config.getDouble("speed") else 1.0
      val pitch = if (config.hasKey("pitch")) config.getDouble("pitch") else 1.0
      val volume = if (config.hasKey("volume")) config.getDouble("volume") else 1.0

      // 设置语言
      if (!language.isNullOrEmpty()) {
        val parts = language.split("-")
        val locale = if (parts.size >= 2) Locale(parts[0], parts[1]) else Locale(parts[0])
        // 10.16 修复：检查 setLanguage 返回值，不支持时 reject 而非静默用错误语言
        val langResult = ttsInstance.setLanguage(locale)
        if (langResult < 0) {
          promise.reject("TTS_LANG_NOT_SUPPORTED", "TTS 不支持语言: $language")
          clearPendingSpeak()
          return
        }
      }

      // 设置声线（API 21+）。Android Voice 用 name 作唯一标识，匹配 voiceKey
      if (!voiceKey.isNullOrEmpty()) {
        val voices = ttsInstance.voices
        if (voices != null) {
          val matched = voices.find { it.name == voiceKey }
          if (matched != null) {
            ttsInstance.voice = matched
          }
        }
      }

      // 10.15 修复：speed/pitch=0 或负数触发 IllegalArgumentException，clamp 到合法范围
      val safeSpeed = speed.coerceIn(0.1, 4.0)
      val safePitch = pitch.coerceIn(0.1, 2.0)
      ttsInstance.setSpeechRate(safeSpeed.toFloat())
      ttsInstance.setPitch(safePitch.toFloat())

      val params = android.os.Bundle()
      params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume.toFloat())

      val result = ttsInstance.speak(
        text,
        TextToSpeech.QUEUE_FLUSH,
        params,
        utteranceId
      )
      if (result == TextToSpeech.SUCCESS) {
        // 约定：speak 入队成功即 resolve（onStart/onDone 不驱动 promise）
        promise.resolve(null)
        clearPendingSpeak()
      } else {
        promise.reject("TTS_SPEAK_ERROR", "TTS 入队失败 code=$result")
        clearPendingSpeak()
      }
    } catch (e: Exception) {
      Log.e("TtsAudio", "doSpeak failed", e)
      promise.reject("TTS_SPEAK_ERROR", "朗读异常: ${e.message}")
      clearPendingSpeak()
    }
  }

  private fun rebuildTtsWithEngine(enginePackage: String) {
    // TextToSpeech 三参构造函数直接接受 engine 包名字符串：
    //   TextToSpeech(context, listener, engine: String)
    currentEnginePackage = enginePackage
    try {
      tts?.shutdown()
    } catch (e: Exception) {
      Log.e("TtsAudio", "tts shutdown before rebuild error", e)
    }
    tts = null
    ttsReady = false
    try {
      val initListener = TextToSpeech.OnInitListener { status ->
        ttsReady = status == TextToSpeech.SUCCESS
        if (ttsReady) {
          applyAudioAttributes(tts)
          tts?.setOnUtteranceProgressListener(utteranceListener)
          doSpeak()
        } else {
          // 引擎切换失败，回退默认引擎重试一次
          Log.w("TtsAudio", "engine $enginePackage init failed, fallback to default")
          currentEnginePackage = null
          // 先 shutdown 失败的引擎实例并置空，否则 ensureTts 检查 tts != null 直接返回 false
          try {
            tts?.shutdown()
          } catch (e: Exception) {
            Log.e("TtsAudio", "shutdown failed engine instance error", e)
          }
          tts = null
          ttsReady = false
          ensureTts { ok ->
            if (ok) doSpeak() else {
              pendingSpeakPromise?.reject("TTS_ENGINE_NOT_READY", "引擎切换失败")
              clearPendingSpeak()
            }
          }
        }
      }
      tts = TextToSpeech(reactApplicationContext, initListener, enginePackage)
    } catch (e: Exception) {
      Log.e("TtsAudio", "rebuildTtsWithEngine failed", e)
      currentEnginePackage = null
      ensureTts { ok ->
        if (ok) doSpeak() else {
          pendingSpeakPromise?.reject("TTS_ENGINE_NOT_READY", "引擎切换失败")
          clearPendingSpeak()
        }
      }
    }
  }

  private fun applyAudioAttributes(ttsInstance: TextToSpeech?) {
    try {
      ttsInstance?.setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      )
    } catch (e: Exception) {
      Log.e("TtsAudio", "applyAudioAttributes failed", e)
    }
  }

  private val utteranceListener = object : UtteranceProgressListener() {
    override fun onStart(utteranceId: String?) {
      // 朗读开始（约定：promise 已在 speak 入队成功时 resolve）
    }

    override fun onDone(utteranceId: String?) {
      // 朗读完成：通知 JS 层重置 isPlaying 状态
      sendEvent("ttsDone", null)
    }

    // 11.17 修复：新版 API（API 21+）系统回调此带 errorCode 的重载，
    // 旧版 onError(String?) 在新版系统上不再被回调，必须 override 此方法才能收到错误
    override fun onError(utteranceId: String?, errorCode: Int) {
      Log.w("TtsAudio", "TTS utterance error: $utteranceId code=$errorCode")
      sendEvent("ttsError", null)
    }

    // 旧版 API（已废弃）：保留 override 以兼容旧设备/引擎，新版系统不再回调此方法
    @Deprecated("旧版回调，新版 API 改用 onError(utteranceId, errorCode)")
    override fun onError(utteranceId: String?) {
      Log.w("TtsAudio", "TTS utterance error (legacy): $utteranceId")
      sendEvent("ttsError", null)
    }
  }

  private fun sendEvent(eventName: String, params: WritableMap?) {
    try {
      reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(eventName, params)
    } catch (e: Exception) {
      Log.e("TtsAudio", "sendEvent $eventName failed", e)
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
    clearPendingSpeak()
  }

  private fun clearPendingSpeak() {
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
