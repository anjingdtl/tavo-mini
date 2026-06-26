package com.shinewriter

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * 写作流水线前台保活服务。
 *
 * 职责仅限两件事：
 *  1. startForeground 持有常驻通知，让系统把 App 当作前台进程，
 *     避免 JS 线程在 App 切后台时被冻结/杀死。
 *  2. 持有 PARTIAL_WAKE_LOCK 防止 CPU 休眠。
 *
 * 不做任何 LLM 网络调用、不读写数据库、不触碰密钥——所有业务在 JS 层。
 * 终态通知（完成/失败）由 PipelineForegroundModule 直接通过
 * NotificationManager 发出，不走本 Service。
 */
class PipelineForegroundService : Service() {

  private var wakeLock: PowerManager.WakeLock? = null
  private var currentTaskId: String? = null
  private val handler = Handler(Looper.getMainLooper())
  private val wakeLockRenewRunnable = object : Runnable {
    override fun run() {
      // 10.18 修复：wakelock 超时后无续期，长任务 CPU 休眠；周期检查并重新 acquire
      try {
        if (wakeLock?.isHeld != true) {
          Log.d("PipelineFgSvc", "wakelock released (timeout?), re-acquiring")
          acquireWakeLock()
        }
      } catch (e: Exception) {
        Log.w("PipelineFgSvc", "wakelock renew check failed", e)
      }
      handler.postDelayed(this, WAKE_LOCK_RENEW_INTERVAL_MS)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    ensureNotificationChannels(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val taskId = intent?.getStringExtra(EXTRA_TASK_ID)
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "ShineWriter 写作中"
    val stageLabel = intent?.getStringExtra(EXTRA_STAGE_LABEL) ?: "正在生成"

    if (taskId != null) currentTaskId = taskId

    startForegroundInternal(title, stageLabel)
    acquireWakeLock()
    // 启动周期续期检查
    handler.removeCallbacks(wakeLockRenewRunnable)
    handler.postDelayed(wakeLockRenewRunnable, WAKE_LOCK_RENEW_INTERVAL_MS)

    return START_NOT_STICKY
  }

  override fun onDestroy() {
    handler.removeCallbacks(wakeLockRenewRunnable)
    releaseWakeLock()
    super.onDestroy()
  }

  private fun startForegroundInternal(title: String, stageLabel: String) {
    val notification = buildOngoingNotification(title, stageLabel)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      // Android 14+ 必须指定 foregroundServiceType
      startForeground(ONGOING_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(ONGOING_NOTIFICATION_ID, notification)
    }
  }

  private fun buildOngoingNotification(title: String, stageLabel: String): Notification {
    val text = if (stageLabel.isNotBlank()) "$title · $stageLabel" else title
    return NotificationCompat.Builder(this, CHANNEL_ONGOING)
      .setContentTitle("ShineWriter 写作中")
      .setContentText(text)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    // 10.19 修复：newWakeLock 可能抛 SecurityException，未 catch 会传播到 onStartCommand 致 Service 崩溃
    try {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG)
      wakeLock?.acquire(WAKE_LOCK_TIMEOUT_MS)
    } catch (e: Exception) {
      Log.e("PipelineFgSvc", "acquireWakeLock failed", e)
      wakeLock = null
    }
  }

  private fun releaseWakeLock() {
    try {
      if (wakeLock?.isHeld == true) wakeLock?.release()
    } catch (e: Exception) {
      // best-effort
    }
    wakeLock = null
  }

  companion object {
    const val EXTRA_TASK_ID = "shinewriter.pipeline.task_id"
    const val EXTRA_TITLE = "shinewriter.pipeline.title"
    const val EXTRA_STAGE_LABEL = "shinewriter.pipeline.stage_label"
    const val ONGOING_NOTIFICATION_ID = 0x5A01
    const val DONE_NOTIFICATION_BASE_ID = 0x5B00
    private const val CHANNEL_ONGOING = "pipeline_ongoing"
    private const val CHANNEL_DONE = "pipeline_done"
    private const val WAKE_LOCK_TAG = "shinewriter:pipeline"
    private const val WAKE_LOCK_TIMEOUT_MS = 30 * 60 * 1000L // 30 分钟上限
    // 10.18：续期检查间隔，取 timeout 的一半，确保超时前有一次续期机会
    private const val WAKE_LOCK_RENEW_INTERVAL_MS = 15 * 60 * 1000L

    /**
     * 确保通知 channel 已创建。
     * Service onCreate 和 Module postDoneNotification 都会调用，
     * 保证无论 Service 是否启动过，完成通知 channel 都存在（Android 8.0+ 否则静默丢弃通知）。
     */
    fun ensureNotificationChannels(context: Context) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // 运行中常驻通知：低重要性，无声
        val ongoing = NotificationChannel(
          CHANNEL_ONGOING,
          "写作运行状态",
          NotificationManager.IMPORTANCE_LOW
        ).apply {
          description = "显示当前流水线写作进度"
          setShowBadge(false)
        }
        // 完成通知：默认重要性，可响
        val done = NotificationChannel(
          CHANNEL_DONE,
          "写作完成通知",
          NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
          description = "流水线完成、失败或取消时通知"
        }
        nm.createNotificationChannels(listOf(ongoing, done))
      }
    }
  }
}
