package com.shinewriter

import android.content.Intent
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
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
import java.util.UUID

class TtsAudioModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    private const val TAG = "ShineWriterTts"
    private const val TTS_INIT_TIMEOUT_MS = 8000L
    private const val SESSION_ID_PREFIX = "shinewriter"
    private const val CHUNK_SEPARATOR = ":"

    // Error codes mirrored to JS layer
    private const val ERR_EMPTY_TEXT = "EMPTY_TEXT"
    private const val ERR_CANCELLED = "TTS_CANCELLED"
    private const val ERR_ENGINE_UNAVAILABLE = "TTS_NO_ENGINE"
    private const val ERR_ENGINE_INIT_TIMEOUT = "TTS_ENGINE_INIT_TIMEOUT"
    private const val ERR_ENGINE_INIT_FAILED = "TTS_ENGINE_INIT_FAILED"
    private const val ERR_LANGUAGE_DATA_MISSING = "TTS_LANGUAGE_DATA_MISSING"
    private const val ERR_LANGUAGE_NOT_SUPPORTED = "TTS_LANGUAGE_NOT_SUPPORTED"
    private const val ERR_VOICE_NOT_FOUND = "TTS_VOICE_NOT_FOUND"
    private const val ERR_VOICE_REQUIRES_NETWORK = "TTS_VOICE_REQUIRES_NETWORK"
    private const val ERR_SPEAK_FAILED = "TTS_SPEAK_FAILED"
    private const val ERR_OPEN_SETTINGS_FAILED = "OPEN_TTS_SETTINGS_FAILED"
  }

  // ===== MediaPlayer playback (cloud TTS) =====
  private var mediaPlayer: MediaPlayer? = null
  private var currentAudioPromise: Promise? = null

  // ===== System TextToSpeech state machine =====
  private enum class TtsInitState { IDLE, INITIALIZING, READY, FAILED }

  private var tts: TextToSpeech? = null
  private var ttsReady: Boolean = false
  private var initState = TtsInitState.IDLE
  private val initCallbacks = mutableListOf<(Boolean) -> Unit>()
  private val mainHandler = Handler(Looper.getMainLooper())
  private var initTimeoutRunnable: Runnable? = null
  private var currentEnginePackage: String? = null

  private var activeSession: TtsSession? = null
  private var pendingSpeakPromise: Promise? = null
  private var pendingSpeakText: String? = null
  private var pendingSpeakConfig: ReadableMap? = null

  override fun getName(): String = "TtsAudio"

  // ===== MediaPlayer methods (unchanged behavior) =====

  @ReactMethod
  fun playAudioFile(path: String, promise: Promise) {
    stopAudioInternal(rejectPending = true)
    stopSpeakInternal(rejectPending = false, emitStopped = false)

    val file = File(path)
    if (!file.exists()) {
      promise.reject("FILE_NOT_FOUND", "音频文件不存在: $path")
      return
    }

    currentAudioPromise = promise
    try {
      mediaPlayer = MediaPlayer().apply {
        setDataSource(path)
        setOnCompletionListener {
          releasePlayer()
          currentAudioPromise?.resolve(null)
          currentAudioPromise = null
        }
        setOnErrorListener { _, what, extra ->
          releasePlayer()
          currentAudioPromise?.reject("PLAYBACK_ERROR", "播放失败: what=$what extra=$extra")
          currentAudioPromise = null
          true
        }
        prepare()
        start()
      }
    } catch (e: Exception) {
      Log.e(TAG, "playAudioFile failed", e)
      releasePlayer()
      currentAudioPromise?.reject("PLAYBACK_EXCEPTION", "播放异常: ${e.message}")
      currentAudioPromise = null
    }
  }

  @ReactMethod
  fun stopAudio(promise: Promise) {
    stopAudioInternal(rejectPending = true)
    promise.resolve(null)
  }

  private fun stopAudioInternal(rejectPending: Boolean) {
    releasePlayer()
    if (rejectPending && currentAudioPromise != null) {
      currentAudioPromise?.reject("CANCELLED", "播放已停止")
      currentAudioPromise = null
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
      Log.e(TAG, "releasePlayer error", e)
    } finally {
      mediaPlayer = null
    }
  }

  // ===== System TTS public methods =====

  @ReactMethod
  fun speak(text: String, config: ReadableMap, promise: Promise) {
    stopAudioInternal(rejectPending = true)

    if (text.isBlank()) {
      promise.reject(ERR_EMPTY_TEXT, "朗读文本为空")
      return
    }

    logDeviceInfo()
    Log.i(TAG, "speak requested enginePackage=${config.optString("enginePackage")} " +
      "voiceKey=${config.optString("voiceKey")} language=${config.optString("language")} " +
      "textLength=${text.length}")

    // 新的朗读请求覆盖旧请求
    pendingSpeakPromise?.reject(ERR_CANCELLED, "新的朗读请求已覆盖旧请求")
    clearPendingSpeak()

    pendingSpeakPromise = promise
    pendingSpeakText = text
    pendingSpeakConfig = config

    val requestedEngine = config.optString("enginePackage")
    val needsRebuild = !requestedEngine.isNullOrEmpty() && requestedEngine != currentEnginePackage

    if (needsRebuild) {
      Log.i(TAG, "engine switch required: current=$currentEnginePackage requested=$requestedEngine")
      shutdownTts(resetEngine = true)
      initializeTts(requestedEngine)
      return
    }

    ensureTts(requestedEngine) { ok ->
      if (!ok) {
        pendingSpeakPromise?.reject(ERR_ENGINE_UNAVAILABLE, "未检测到可用的系统语音引擎")
        clearPendingSpeak()
        return@ensureTts
      }
      doSpeak()
    }
  }

  @ReactMethod
  fun stopSpeak(promise: Promise) {
    stopSpeakInternal(rejectPending = false, emitStopped = true)
    promise.resolve(null)
  }

  @ReactMethod
  fun isTtsReady(promise: Promise) {
    promise.resolve(initState == TtsInitState.READY)
  }

  @ReactMethod
  fun getEngines(promise: Promise) {
    ensureTts(currentEnginePackage) { ok ->
      val result: WritableArray = Arguments.createArray()
      if (!ok) {
        promise.resolve(result)
        return@ensureTts
      }
      val ttsInstance = tts
      if (ttsInstance == null) {
        promise.resolve(result)
        return@ensureTts
      }
      try {
        val defaultEngineName = ttsInstance.defaultEngine ?: ""
        val engines = ttsInstance.engines
        if (engines != null) {
          for (engine in engines) {
            val map: WritableMap = Arguments.createMap()
            map.putString("name", engine.name)
            map.putString("label", engine.label ?: engine.name)
            map.putBoolean("isDefault", engine.name == defaultEngineName)
            map.putBoolean("isCurrent", engine.name == currentEnginePackage)
            result.pushMap(map)
          }
        }
      } catch (e: Exception) {
        Log.e(TAG, "getEngines failed", e)
      }
      promise.resolve(result)
    }
  }

  @ReactMethod
  fun getVoices(enginePackage: String?, promise: Promise) {
    val requestedEngine = enginePackage?.takeIf { it.isNotEmpty() }
    ensureTts(requestedEngine) { ok ->
      val result: WritableArray = Arguments.createArray()
      if (!ok) {
        promise.resolve(result)
        return@ensureTts
      }
      val ttsInstance = tts
      if (ttsInstance == null) {
        promise.resolve(result)
        return@ensureTts
      }
      try {
        val voices = ttsInstance.voices
        if (voices != null) {
          val sorted = voices.sortedWith(compareBy({ it.locale?.toLanguageTag() ?: "" }, { it.name ?: "" }))
          for (voice in sorted) {
            val map = voiceToMap(voice)
            if (map != null) result.pushMap(map)
          }
        }
      } catch (e: Exception) {
        Log.e(TAG, "getVoices failed", e)
      }
      promise.resolve(result)
    }
  }

  @ReactMethod
  fun getDiagnostics(enginePackage: String?, language: String?, promise: Promise) {
    val requestedEngine = enginePackage?.takeIf { it.isNotEmpty() } ?: ""
    val targetLanguage = language?.takeIf { it.isNotEmpty() } ?: "zh-CN"
    val diagnostics = Arguments.createMap()

    diagnostics.putBoolean("initialized", false)
    diagnostics.putString("manufacturer", Build.MANUFACTURER ?: "")
    diagnostics.putString("model", Build.MODEL ?: "")
    diagnostics.putString("androidVersion", Build.VERSION.RELEASE ?: "")
    diagnostics.putInt("sdkInt", Build.VERSION.SDK_INT)
    diagnostics.putString("requestedEngine", requestedEngine)
    diagnostics.putString("currentEngine", currentEnginePackage ?: "")
    diagnostics.putString("defaultEngine", tts?.defaultEngine ?: "")
    diagnostics.putString("language", targetLanguage)
    diagnostics.putString("languageStatus", "unknown")
    diagnostics.putInt("voiceCount", 0)
    diagnostics.putInt("matchingVoiceCount", 0)
    diagnostics.putInt("offlineVoiceCount", 0)
    diagnostics.putInt("maxInputLength", TextToSpeech.getMaxSpeechInputLength())

    ensureTts(requestedEngine.takeIf { it.isNotEmpty() }) { ok ->
      val ttsInstance = tts
      diagnostics.putBoolean("initialized", ok && ttsInstance != null)

      if (ttsInstance == null) {
        if (!ok) {
          diagnostics.putString("errorCode", ERR_ENGINE_INIT_FAILED)
          diagnostics.putString("errorMessage", "语音引擎初始化失败")
        }
        promise.resolve(diagnostics)
        return@ensureTts
      }

      try {
        diagnostics.putString("currentEngine", currentEnginePackage ?: "")
        diagnostics.putString("defaultEngine", ttsInstance.defaultEngine ?: "")
        val engines = ttsInstance.engines
        diagnostics.putInt("installedEngineCount", engines?.size ?: 0)
        diagnostics.putBoolean(
          "selectedEngineInstalled",
          requestedEngine.isEmpty() || engines?.any { it.name == requestedEngine } == true,
        )

        val locale = parseLocale(targetLanguage)
        val langResult = ttsInstance.isLanguageAvailable(locale)
        val status = languageStatusFromResult(langResult)
        diagnostics.putString("languageStatus", status)

        val voices = ttsInstance.voices
        var voiceCount = 0
        var matching = 0
        var offline = 0
        if (voices != null) {
          voiceCount = voices.size
          for (voice in voices) {
            val voiceLocale = voice.locale
            val matchesLang = voiceLocale != null &&
              (voiceLocale.language == locale.language || voiceLocale.toLanguageTag() == locale.toLanguageTag())
            if (matchesLang) matching++
            if (!voice.isNetworkConnectionRequired) offline++
          }
        }
        diagnostics.putInt("voiceCount", voiceCount)
        diagnostics.putInt("matchingVoiceCount", matching)
        diagnostics.putInt("offlineVoiceCount", offline)
      } catch (e: Exception) {
        Log.e(TAG, "getDiagnostics failed", e)
        diagnostics.putString("errorCode", ERR_ENGINE_INIT_FAILED)
        diagnostics.putString("errorMessage", e.message)
      }
      promise.resolve(diagnostics)
    }
  }

  @ReactMethod
  fun installTtsData(promise: Promise) {
    try {
      val intent = Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA)
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      val resolved = intent.resolveActivity(reactApplicationContext.packageManager)
      if (resolved != null) {
        reactApplicationContext.startActivity(intent)
        promise.resolve(true)
      } else {
        promise.resolve(false)
      }
    } catch (e: Exception) {
      Log.e(TAG, "installTtsData failed", e)
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun openTtsSettings(promise: Promise) {
    val intents = listOf(
      Intent("com.android.settings.TTS_SETTINGS"),
      Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS),
      Intent(Settings.ACTION_SETTINGS),
    )
    for (intent in intents) {
      try {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (intent.resolveActivity(reactApplicationContext.packageManager) != null) {
          reactApplicationContext.startActivity(intent)
          promise.resolve(true)
          return
        }
      } catch (e: Exception) {
        Log.w(TAG, "openTtsSettings attempt failed for ${intent.action}", e)
      }
    }
    Log.e(TAG, "openTtsSettings all attempts failed")
    promise.resolve(false)
  }

  // NativeEventEmitter no-ops
  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}

  // ===== Internal TTS lifecycle =====

  private fun ensureTts(requestedEngine: String?, callback: (Boolean) -> Unit) {
    val targetEngine = requestedEngine?.takeIf { it.isNotEmpty() }

    synchronized(this) {
      when (initState) {
        TtsInitState.READY -> {
          if (targetEngine == currentEnginePackage || targetEngine == null) {
            mainHandler.post { callback(true) }
            return
          }
          // Engine mismatch: fall through to re-init
        }
        TtsInitState.INITIALIZING -> {
          if (targetEngine == currentEnginePackage || (targetEngine == null && currentEnginePackage == null)) {
            initCallbacks.add(callback)
            return
          }
          // Engine mismatch: fall through to re-init
        }
        TtsInitState.IDLE, TtsInitState.FAILED -> {
          // fall through to init
        }
      }

      shutdownTts(resetEngine = true)
      initState = TtsInitState.INITIALIZING
      currentEnginePackage = targetEngine
      initCallbacks.add(callback)
    }

    mainHandler.post { initializeTtsInstance(targetEngine) }
  }

  private fun initializeTts(requestedEngine: String?) {
    synchronized(this) {
      if (initState == TtsInitState.INITIALIZING) {
        return
      }
      shutdownTts(resetEngine = true)
      initState = TtsInitState.INITIALIZING
      currentEnginePackage = requestedEngine
    }
    mainHandler.post { initializeTtsInstance(requestedEngine) }
  }

  private fun initializeTtsInstance(engine: String?) {
    Log.i(TAG, "initializeTtsInstance start engine=${engine ?: "default"}")

    initTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
    val timeout = Runnable {
      synchronized(this) {
        Log.e(TAG, "TTS init timeout")
        initState = TtsInitState.FAILED
        shutdownTts(resetEngine = true)
        drainInitCallbacks(false)
      }
    }
    initTimeoutRunnable = timeout
    mainHandler.postDelayed(timeout, TTS_INIT_TIMEOUT_MS)

    try {
      val listener = TextToSpeech.OnInitListener { status ->
        initTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
        initTimeoutRunnable = null

        val success = status == TextToSpeech.SUCCESS
        if (success) {
          val instance = tts
          if (instance == null) {
            Log.e(TAG, "TTS init success but instance is null")
            synchronized(this) {
              initState = TtsInitState.FAILED
              drainInitCallbacks(false)
            }
            return@OnInitListener
          }
          applyAudioAttributes(instance)
          instance.setOnUtteranceProgressListener(utteranceListener)
          synchronized(this) {
            initState = TtsInitState.READY
            ttsReady = true
          }
          Log.i(TAG, "TTS init success engine=${currentEnginePackage ?: "default"}")
          drainInitCallbacks(true)
        } else {
          Log.e(TAG, "TTS init failed status=$status")
          synchronized(this) {
            initState = TtsInitState.FAILED
            ttsReady = false
          }
          shutdownTts(resetEngine = true)
          drainInitCallbacks(false)
        }
      }

      tts = if (engine.isNullOrEmpty()) {
        TextToSpeech(reactApplicationContext, listener)
      } else {
        TextToSpeech(reactApplicationContext, listener, engine)
      }
    } catch (e: Exception) {
      Log.e(TAG, "initializeTtsInstance exception", e)
      initTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
      initTimeoutRunnable = null
      synchronized(this) {
        initState = TtsInitState.FAILED
        ttsReady = false
      }
      shutdownTts(resetEngine = true)
      drainInitCallbacks(false)
    }
  }

  private fun drainInitCallbacks(success: Boolean) {
    synchronized(this) {
      val callbacks = initCallbacks.toList()
      initCallbacks.clear()
      for (cb in callbacks) {
        try {
          cb(success)
        } catch (e: Exception) {
          Log.e(TAG, "init callback error", e)
        }
      }
    }
  }

  private fun shutdownTts(resetEngine: Boolean) {
    initTimeoutRunnable?.let { mainHandler.removeCallbacks(it) }
    initTimeoutRunnable = null

    try {
      tts?.stop()
    } catch (e: Exception) {
      Log.e(TAG, "tts stop during shutdown error", e)
    }
    try {
      tts?.shutdown()
    } catch (e: Exception) {
      Log.e(TAG, "tts shutdown error", e)
    }
    tts = null
    ttsReady = false
    synchronized(this) {
      initState = TtsInitState.IDLE
      if (resetEngine) {
        currentEnginePackage = null
      }
      activeSession = null
    }
  }

  // ===== Speaking logic =====

  private fun doSpeak() {
    val ttsInstance = tts
    val text = pendingSpeakText
    val config = pendingSpeakConfig
    val promise = pendingSpeakPromise
    if (ttsInstance == null || text == null || config == null || promise == null) {
      return
    }

    try {
      val voiceKey = config.optString("voiceKey")
      val language = config.optString("language") ?: "zh-CN"
      val speed = if (config.hasKey("speed")) config.getDouble("speed") else 1.0
      val pitch = if (config.hasKey("pitch")) config.getDouble("pitch") else 1.0
      val volume = if (config.hasKey("volume")) config.getDouble("volume") else 1.0
      val offlineOnly = config.hasKey("offlineOnly") && config.getBoolean("offlineOnly")

      // Validate ranges
      val safeSpeed = speed.coerceIn(0.1, 4.0)
      val safePitch = pitch.coerceIn(0.1, 2.0)
      val safeVolume = volume.coerceIn(0.0, 1.0)

      // Language
      val locale = parseLocale(language)
      when (ttsInstance.isLanguageAvailable(locale)) {
        TextToSpeech.LANG_MISSING_DATA -> {
          promise.reject(ERR_LANGUAGE_DATA_MISSING, "当前引擎缺少中文语音数据")
          clearPendingSpeak()
          return
        }
        TextToSpeech.LANG_NOT_SUPPORTED -> {
          promise.reject(ERR_LANGUAGE_NOT_SUPPORTED, "当前引擎不支持所选语言: $language")
          clearPendingSpeak()
          return
        }
        else -> {
          val setResult = ttsInstance.setLanguage(locale)
          if (setResult < 0) {
            promise.reject(ERR_LANGUAGE_NOT_SUPPORTED, "设置语言失败: $language")
            clearPendingSpeak()
            return
          }
        }
      }

      // Voice
      if (!voiceKey.isNullOrEmpty()) {
        val voices = ttsInstance.voices
        val matched = voices?.find { it.name == voiceKey }
        if (matched == null) {
          promise.reject(ERR_VOICE_NOT_FOUND, "已保存的声线不存在，请重新选择")
          clearPendingSpeak()
          return
        }
        if (offlineOnly && matched.isNetworkConnectionRequired) {
          promise.reject(ERR_VOICE_REQUIRES_NETWORK, "所选声线需要联网，不符合离线设置")
          clearPendingSpeak()
          return
        }
        ttsInstance.voice = matched
      }

      ttsInstance.setSpeechRate(safeSpeed.toFloat())
      ttsInstance.setPitch(safePitch.toFloat())

      val params = android.os.Bundle()
      params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, safeVolume.toFloat())

      val maxLength = (TextToSpeech.getMaxSpeechInputLength() - 256).coerceAtLeast(500)
      val chunks = TtsTextChunker.split(text, maxLength)
      if (chunks.isEmpty()) {
        promise.reject(ERR_EMPTY_TEXT, "朗读文本为空")
        clearPendingSpeak()
        return
      }

      val sessionId = config.optString("sessionId")?.takeIf { it.isNotEmpty() }
        ?: UUID.randomUUID().toString()
      activeSession = TtsSession(sessionId, chunks)

      Log.i(TAG, "starting TTS session=$sessionId chunks=${chunks.size} maxLength=$maxLength")

      val firstUtteranceId = utteranceIdFor(sessionId, 0, chunks.size)
      val result = ttsInstance.speak(chunks[0], TextToSpeech.QUEUE_FLUSH, params, firstUtteranceId)
      if (result == TextToSpeech.SUCCESS) {
        promise.resolve(null)
        clearPendingSpeak()
      } else {
        activeSession = null
        promise.reject(ERR_SPEAK_FAILED, "系统未能开始朗读")
        clearPendingSpeak()
      }
    } catch (e: Exception) {
      Log.e(TAG, "doSpeak failed", e)
      activeSession = null
      promise.reject(ERR_SPEAK_FAILED, "朗读异常: ${e.message}")
      clearPendingSpeak()
    }
  }

  private fun utteranceIdFor(sessionId: String, index: Int, total: Int): String {
    return "$SESSION_ID_PREFIX$CHUNK_SEPARATOR$sessionId$CHUNK_SEPARATOR$index$CHUNK_SEPARATOR$total"
  }

  private fun parseUtteranceId(utteranceId: String?): Triple<String, Int, Int>? {
    if (utteranceId.isNullOrEmpty() || !utteranceId.startsWith(SESSION_ID_PREFIX)) return null
    val parts = utteranceId.split(CHUNK_SEPARATOR)
    if (parts.size != 4) return null
    return try {
      Triple(parts[1], parts[2].toInt(), parts[3].toInt())
    } catch (e: Exception) {
      null
    }
  }

  private fun utteranceProgressEvent(session: TtsSession): WritableMap {
    val map = Arguments.createMap()
    map.putString("sessionId", session.sessionId)
    map.putString("enginePackage", currentEnginePackage ?: "")
    map.putInt("chunkIndex", session.currentIndex)
    map.putInt("chunkCount", session.chunks.size)
    return map
  }

  private val utteranceListener = object : UtteranceProgressListener() {
    override fun onStart(utteranceId: String?) {
      Log.i(TAG, "onStart utteranceId=$utteranceId")
      val session = activeSession ?: return
      val parsed = parseUtteranceId(utteranceId) ?: return
      val (_, index, _) = parsed
      session.currentIndex = index
      if (index == 0) {
        sendEvent("ttsStart", utteranceProgressEvent(session))
      }
      sendEvent("ttsProgress", utteranceProgressEvent(session))
    }

    override fun onDone(utteranceId: String?) {
      Log.i(TAG, "onDone utteranceId=$utteranceId")
      val session = activeSession ?: return
      val parsed = parseUtteranceId(utteranceId) ?: return
      val (_, index, total) = parsed
      session.currentIndex = index

      if (index >= total - 1 || session.stopped) {
        if (!session.stopped) {
          sendEvent("ttsDone", utteranceProgressEvent(session))
        }
        activeSession = null
        return
      }

      val nextIndex = index + 1
      val nextText = session.chunks[nextIndex]
      val params = android.os.Bundle()
      params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f)
      val nextUtteranceId = utteranceIdFor(session.sessionId, nextIndex, total)
      try {
        val result = tts?.speak(nextText, TextToSpeech.QUEUE_ADD, params, nextUtteranceId)
        if (result != TextToSpeech.SUCCESS) {
          sendErrorEvent(session, ERR_SPEAK_FAILED, "系统未能继续朗读下一段")
          activeSession = null
        }
      } catch (e: Exception) {
        Log.e(TAG, "speak next chunk failed", e)
        sendErrorEvent(session, ERR_SPEAK_FAILED, "朗读下一段异常: ${e.message}")
        activeSession = null
      }
    }

    override fun onError(utteranceId: String?, errorCode: Int) {
      Log.w(TAG, "onError utteranceId=$utteranceId code=$errorCode")
      val session = activeSession ?: return
      sendErrorEvent(session, ERR_SPEAK_FAILED, "系统朗读错误 code=$errorCode", errorCode)
      activeSession = null
    }

    @Deprecated("旧版回调")
    override fun onError(utteranceId: String?) {
      Log.w(TAG, "onError legacy utteranceId=$utteranceId")
      val session = activeSession ?: return
      sendErrorEvent(session, ERR_SPEAK_FAILED, "系统朗读错误")
      activeSession = null
    }

    override fun onStop(utteranceId: String?, interrupted: Boolean) {
      Log.i(TAG, "onStop utteranceId=$utteranceId interrupted=$interrupted")
      activeSession = null
    }
  }

  private fun sendErrorEvent(session: TtsSession, code: String, message: String, nativeCode: Int? = null) {
    val map = utteranceProgressEvent(session)
    map.putString("errorCode", code)
    map.putString("message", message)
    nativeCode?.let { map.putInt("nativeErrorCode", it) }
    sendEvent("ttsError", map)
  }

  private fun stopSpeakInternal(rejectPending: Boolean, emitStopped: Boolean) {
    val session = activeSession
    if (session != null) {
      session.stopped = true
      if (emitStopped) {
        sendEvent("ttsStopped", utteranceProgressEvent(session))
      }
    }
    activeSession = null
    try {
      tts?.stop()
    } catch (e: Exception) {
      Log.e(TAG, "stopSpeak error", e)
    }
    if (rejectPending && pendingSpeakPromise != null) {
      pendingSpeakPromise?.reject(ERR_CANCELLED, "朗读已停止")
    }
    clearPendingSpeak()
  }

  private fun clearPendingSpeak() {
    pendingSpeakPromise = null
    pendingSpeakText = null
    pendingSpeakConfig = null
  }

  // ===== Helpers =====

  private fun applyAudioAttributes(ttsInstance: TextToSpeech) {
    try {
      ttsInstance.setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build(),
      )
    } catch (e: Exception) {
      Log.e(TAG, "applyAudioAttributes failed", e)
    }
  }

  private fun sendEvent(eventName: String, params: WritableMap?) {
    val sessionId = params?.getString("sessionId") ?: "<none>"
    Log.i(TAG, "sendEvent $eventName sessionId=$sessionId")
    try {
      reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(eventName, params)
    } catch (e: Exception) {
      Log.e(TAG, "sendEvent $eventName failed", e)
    }
  }

  private fun parseLocale(languageTag: String): Locale {
    return try {
      Locale.forLanguageTag(languageTag).takeIf { it.language.isNotEmpty() } ?: Locale.SIMPLIFIED_CHINESE
    } catch (e: Exception) {
      Locale.SIMPLIFIED_CHINESE
    }
  }

  private fun languageStatusFromResult(result: Int): String {
    return when (result) {
      TextToSpeech.LANG_AVAILABLE -> "available"
      TextToSpeech.LANG_COUNTRY_AVAILABLE -> "country_available"
      TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE -> "variant_available"
      TextToSpeech.LANG_MISSING_DATA -> "missing_data"
      TextToSpeech.LANG_NOT_SUPPORTED -> "not_supported"
      else -> "unknown"
    }
  }

  private fun voiceToMap(voice: Voice): WritableMap? {
    return try {
      val map: WritableMap = Arguments.createMap()
      map.putString("key", voice.name ?: "")
      map.putString("name", voice.name ?: "")
      map.putString("locale", voice.locale?.toLanguageTag() ?: "")
      map.putInt("quality", voice.quality)
      map.putInt("latency", voice.latency)
      map.putBoolean("requiresNetwork", voice.isNetworkConnectionRequired)
      val features: WritableArray = Arguments.createArray()
      try {
        voice.features?.forEach { features.pushString(it) }
      } catch (e: Exception) {
        // ignore
      }
      map.putArray("features", features)
      map
    } catch (e: Exception) {
      null
    }
  }

  private fun logDeviceInfo() {
    Log.i(TAG, "device manufacturer=${Build.MANUFACTURER} model=${Build.MODEL} sdk=${Build.VERSION.SDK_INT}")
  }

  private fun ReadableMap.optString(key: String): String? {
    return if (hasKey(key)) getString(key) else null
  }

  // ===== Lifecycle cleanup =====

  override fun onCatalystInstanceDestroy() {
    stopAudioInternal(rejectPending = false)
    stopSpeakInternal(rejectPending = false, emitStopped = false)
    shutdownTts(resetEngine = true)
    super.onCatalystInstanceDestroy()
  }

  private data class TtsSession(
    val sessionId: String,
    val chunks: List<String>,
    var currentIndex: Int = 0,
    var stopped: Boolean = false,
  )
}
