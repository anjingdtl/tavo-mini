package com.shinewriter

import android.content.ComponentName
import android.content.Intent
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
    // 注意：TextToSpeech.EngineInfo 不暴露 service class name，无法精确构造
    // ComponentName 切换到指定引擎。这里采用「查询已安装 TTS 服务的 MainInterface
    // Service」的方式找到对应 class name，构造 ComponentName 后重建 TTS 实例。
    currentEnginePackage = enginePackage
    try {
      tts?.shutdown()
    } catch (e: Exception) {
      Log.e("TtsAudio", "tts shutdown before rebuild error", e)
    }
    tts = null
    ttsReady = false
    try {
      val engine = resolveEngineComponent(enginePackage)
      if (engine != null) {
        tts = TextToSpeech(reactApplicationContext, { status ->
          ttsReady = status == TextToSpeech.SUCCESS
          if (ttsReady) {
            applyAudioAttributes(tts)
            tts?.setOnUtteranceProgressListener(utteranceListener)
            doSpeak()
          } else {
            pendingSpeakPromise?.reject("TTS_ENGINE_NOT_READY", "引擎切换失败")
            clearPendingSpeak()
          }
        }, engine)
      } else {
        // 找不到 service class，回退默认引擎
        Log.w("TtsAudio", "engine service not found for $enginePackage, fallback to default")
        currentEnginePackage = null
        ensureTts { ok ->
          if (ok) doSpeak() else {
            pendingSpeakPromise?.reject("TTS_ENGINE_NOT_READY", "引擎切换失败")
            clearPendingSpeak()
          }
        }
      }
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

  /**
   * 查询系统中实现了 ACTION_TTS_SERVICE 的服务，匹配目标包名，返回其 ComponentName。
   * 返回 null 表示未找到。
   */
  private fun resolveEngineComponent(enginePackage: String): ComponentName? {
    return try {
      val pm = reactApplicationContext.packageManager
      val intent = Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE)
      val resolveInfos = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        pm.queryIntentServices(intent, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY)
      } else {
        @Suppress("DEPRECATION")
        pm.queryIntentServices(intent, 0)
      }
      resolveInfos?.find { it.serviceInfo?.packageName == enginePackage }?.let {
        ComponentName(it.serviceInfo.packageName, it.serviceInfo.name)
      }
    } catch (e: Exception) {
      Log.e("TtsAudio", "resolveEngineComponent failed", e)
      null
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
      // 朗读完成（约定：不驱动 promise，仅清理内部状态）
    }

    override fun onError(utteranceId: String?) {
      // 朗读错误（约定：promise 已在入队成功时 resolve）
      Log.w("TtsAudio", "TTS utterance error: $utteranceId")
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
