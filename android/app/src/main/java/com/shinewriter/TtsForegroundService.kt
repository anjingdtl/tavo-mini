package com.shinewriter

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * 语音朗读的前台服务。
 *
 * 云端朗读先以 dataSync 类型保活合成请求，拿到音频或系统 TTS 入队后切换为
 * mediaPlayback。这样既能覆盖“合成期间切后台”，也能像音乐播放器一样在播放期间
 * 保留进程优先级、音频焦点和常驻通知。
 */
class TtsForegroundService : Service() {

  private var phase = PHASE_PREPARING
  private var wakeLock: PowerManager.WakeLock? = null
  private var mediaSession: MediaSession? = null
  private var audioFocusRequest: AudioFocusRequest? = null
  private var hasAudioFocus = false

  private val audioFocusListener = AudioManager.OnAudioFocusChangeListener { change ->
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS,
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
        // 系统 TTS 和当前 MediaPlayer 都没有可靠的跨引擎暂停恢复接口；失焦时停止，
        // 避免朗读与电话、导航或其他媒体叠音。
        Log.i(TAG, "audio focus lost, stopping TTS playback")
        requestPlaybackStop()
        stopForegroundAndSelf()
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    ensureNotificationChannel(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        requestPlaybackStop()
        stopForegroundAndSelf()
        return START_NOT_STICKY
      }
      ACTION_PLAYING -> {
        phase = PHASE_PLAYING
        ensureMediaSession()
        requestAudioFocus()
      }
      else -> {
        phase = PHASE_PREPARING
        abandonAudioFocus()
        releaseMediaSession()
      }
    }

    startForegroundInternal()
    acquireWakeLock()
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    releaseWakeLock()
    abandonAudioFocus()
    releaseMediaSession()
    super.onDestroy()
  }

  private fun startForegroundInternal() {
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val serviceType = if (phase == PHASE_PLAYING) {
        // 从合成阶段升级到播放阶段时保留 dataSync 类型；Android 要求再次调用
        // startForeground 时把已有类型与新加入的类型一起声明。
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
      } else {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      }
      startForeground(NOTIFICATION_ID, notification, serviceType)
    } else {
      @Suppress("DEPRECATION")
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun buildNotification(): Notification {
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val contentIntent = launchIntent?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    val isPlaying = phase == PHASE_PLAYING
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setContentTitle(if (isPlaying) "ShineWriter 正在朗读" else "ShineWriter 正在准备朗读")
      .setContentText(if (isPlaying) "切到后台后会继续朗读" else "正在合成语音，请稍候")
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)

    if (contentIntent != null) builder.setContentIntent(contentIntent)
    if (isPlaying) {
      val stopIntent = Intent(this, TtsForegroundService::class.java).setAction(ACTION_STOP)
      val stopPendingIntent = PendingIntent.getService(
        this,
        STOP_REQUEST_CODE,
        stopIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      builder.addAction(android.R.drawable.ic_media_pause, "停止朗读", stopPendingIntent)
    }
    return builder.build()
  }

  private fun ensureMediaSession() {
    if (mediaSession != null) return
    try {
      mediaSession = MediaSession(this, TAG).apply {
        setCallback(object : MediaSession.Callback() {
          override fun onStop() {
            requestPlaybackStop()
            stopForegroundAndSelf()
          }
        })
        setPlaybackState(
          PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_STOP)
            .setState(
              PlaybackState.STATE_PLAYING,
              PlaybackState.PLAYBACK_POSITION_UNKNOWN,
              1f,
            )
            .build(),
        )
        isActive = true
      }
    } catch (e: Exception) {
      Log.w(TAG, "create media session failed", e)
    }
  }

  private fun releaseMediaSession() {
    try {
      mediaSession?.isActive = false
      mediaSession?.release()
    } catch (e: Exception) {
      Log.w(TAG, "release media session failed", e)
    } finally {
      mediaSession = null
    }
  }

  private fun requestAudioFocus() {
    if (hasAudioFocus) return
    try {
      val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
      val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
          .setAudioAttributes(attributes)
          .setOnAudioFocusChangeListener(audioFocusListener)
          .build()
        audioFocusRequest = request
        audioManager.requestAudioFocus(request)
      } else {
        @Suppress("DEPRECATION")
        audioManager.requestAudioFocus(
          audioFocusListener,
          AudioManager.STREAM_MUSIC,
          AudioManager.AUDIOFOCUS_GAIN,
        )
      }
      hasAudioFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    } catch (e: Exception) {
      Log.w(TAG, "request audio focus failed", e)
    }
  }

  private fun abandonAudioFocus() {
    if (!hasAudioFocus) return
    try {
      val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
        audioManager.abandonAudioFocusRequest(audioFocusRequest!!)
      } else {
        @Suppress("DEPRECATION")
        audioManager.abandonAudioFocus(audioFocusListener)
      }
    } catch (e: Exception) {
      Log.w(TAG, "abandon audio focus failed", e)
    } finally {
      audioFocusRequest = null
      hasAudioFocus = false
    }
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    try {
      val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$TAG:playback").apply {
        setReferenceCounted(false)
        acquire()
      }
    } catch (e: Exception) {
      Log.w(TAG, "acquire wake lock failed", e)
      wakeLock = null
    }
  }

  private fun releaseWakeLock() {
    try {
      if (wakeLock?.isHeld == true) wakeLock?.release()
    } catch (e: Exception) {
      Log.w(TAG, "release wake lock failed", e)
    } finally {
      wakeLock = null
    }
  }

  private fun requestPlaybackStop() {
    TtsAudioModule.stopActivePlaybackFromForegroundService()
  }

  private fun stopForegroundAndSelf() {
    try {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } catch (e: Exception) {
      Log.w(TAG, "stop foreground failed", e)
    }
    stopSelf()
  }

  companion object {
    private const val TAG = "ShineWriterTtsFg"
    private const val CHANNEL_ID = "tts_playback"
    private const val NOTIFICATION_ID = 0x5A02
    private const val STOP_REQUEST_CODE = 0x5A03
    private const val PHASE_PREPARING = "preparing"
    private const val PHASE_PLAYING = "playing"
    private const val ACTION_PREPARE = "com.shinewriter.tts.PREPARE"
    private const val ACTION_PLAYING = "com.shinewriter.tts.PLAYING"
    private const val ACTION_STOP = "com.shinewriter.tts.STOP"

    fun begin(context: Context) {
      start(context, ACTION_PREPARE)
    }

    fun promoteToPlayback(context: Context) {
      start(context, ACTION_PLAYING)
    }

    fun stop(context: Context) {
      try {
        context.applicationContext.stopService(Intent(context, TtsForegroundService::class.java))
      } catch (e: Exception) {
        Log.w(TAG, "stop foreground service failed", e)
      }
    }

    private fun start(context: Context, action: String) {
      try {
        val intent = Intent(context.applicationContext, TtsForegroundService::class.java).setAction(action)
        ContextCompat.startForegroundService(context.applicationContext, intent)
      } catch (e: Exception) {
        // 前台时启动失败不应阻止正常朗读；调用方会继续走已有前台播放降级路径。
        Log.w(TAG, "start foreground service failed", e)
      }
    }

    private fun ensureNotificationChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val channel = NotificationChannel(
        CHANNEL_ID,
        "语音朗读",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "显示语音朗读和后台合成状态"
        setShowBadge(false)
      }
      manager.createNotificationChannel(channel)
    }
  }
}
