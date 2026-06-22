package com.shinewriter

import android.media.MediaPlayer
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class TtsAudioModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private var mediaPlayer: MediaPlayer? = null
  private var currentPromise: Promise? = null

  override fun getName(): String = "TtsAudio"

  @ReactMethod
  fun playAudioFile(path: String, promise: Promise) {
    stopAudioInternal(rejectPending = true)

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
}
