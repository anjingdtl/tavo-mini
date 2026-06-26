package com.shinewriter

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JS 侧流水线保活/通知的桥接模块。
 *
 * 设计原则：所有方法 try/catch，失败时 reject，但 JS 侧必须捕获并静默——
 * 绝不让原生层缺失或异常阻塞流水线业务。
 */
class PipelineForegroundModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "PipelineForeground"

  /**
   * 启动前台服务（开始写作）。taskId 用于标识当前任务。
   */
  @ReactMethod
  fun start(taskId: String, title: String, stageLabel: String, promise: Promise) {
    try {
      val intent = Intent(reactContext, PipelineForegroundService::class.java).apply {
        putExtra(PipelineForegroundService.EXTRA_TASK_ID, taskId)
        putExtra(PipelineForegroundService.EXTRA_TITLE, title)
        putExtra(PipelineForegroundService.EXTRA_STAGE_LABEL, stageLabel)
      }
      ContextCompat.startForegroundService(reactContext, intent)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("START_FAILED", "启动前台服务失败: ${e.message}", e)
    }
  }

  /**
   * 更新常驻通知文本（不弹新通知）。
   * 通过重新投递 start intent 让 Service.onStartCommand 刷新前台通知。
   */
  @ReactMethod
  fun updateProgress(taskId: String, stageLabel: String, promise: Promise) {
    try {
      val intent = Intent(reactContext, PipelineForegroundService::class.java).apply {
        putExtra(PipelineForegroundService.EXTRA_TASK_ID, taskId)
        putExtra(PipelineForegroundService.EXTRA_STAGE_LABEL, stageLabel)
      }
      ContextCompat.startForegroundService(reactContext, intent)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("UPDATE_FAILED", "更新进度失败: ${e.message}", e)
    }
  }

  /**
   * 发"完成"系统通知（独立 id，可点击跳转）。
   */
  @ReactMethod
  fun notifyComplete(taskId: String, title: String, message: String, promise: Promise) {
    try {
      postDoneNotification(taskId, title, message, true)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("NOTIFY_FAILED", "发送完成通知失败: ${e.message}", e)
    }
  }

  /**
   * 发"失败/取消"系统通知。
   */
  @ReactMethod
  fun notifyFailed(taskId: String, title: String, message: String, promise: Promise) {
    try {
      postDoneNotification(taskId, title, message, false)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("NOTIFY_FAILED", "发送失败通知失败: ${e.message}", e)
    }
  }

  /**
   * 停止前台服务、移除常驻通知、释放 wakelock。
   */
  @ReactMethod
  fun stop(taskId: String, promise: Promise) {
    try {
      val intent = Intent(reactContext, PipelineForegroundService::class.java)
      reactContext.stopService(intent)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("STOP_FAILED", "停止服务失败: ${e.message}", e)
    }
  }

  /**
   * 供 JS 判断当前是否可用（Android 8+ 且通知已启用）。
   */
  @ReactMethod
  fun isAvailable(promise: Promise) {
    try {
      val nm = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val hasPermission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        reactContext.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
          android.content.pm.PackageManager.PERMISSION_GRANTED
      } else true
      promise.resolve(
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
          nm.areNotificationsEnabled() && hasPermission
      )
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }

  /**
   * 读取并清除 MainActivity 暂存的 deep link taskId。
   * JS 侧 App 启动时调用，若返回非 null 则导航到对应任务结果。
   * 用静态字段存储，因为 Module 和 Activity 是不同实例，但同进程。
   */
  @ReactMethod
  fun consumeDeepLinkTaskId(promise: Promise) {
    try {
      val id = pendingDeepLinkTaskId
      pendingDeepLinkTaskId = null
      promise.resolve(id)
    } catch (e: Exception) {
      promise.resolve(null)
    }
  }

  private fun postDoneNotification(taskId: String, title: String, message: String, success: Boolean) {
    // 先确保 channel 已创建（Service 可能从未启动，channel 不存在会导致 Android 8.0+ 静默丢弃通知）
    PipelineForegroundService.ensureNotificationChannels(reactContext)

    val launchIntent = Intent(reactContext, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      putExtra(EXTRA_DEEP_LINK_TASK_ID, taskId)
    }
    val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val contentIntent = PendingIntent.getActivity(reactContext, taskId.hashCode(), launchIntent, pendingFlags)

    val smallIcon = if (success) android.R.drawable.stat_sys_download_done else android.R.drawable.stat_notify_error
    val builder = NotificationCompat.Builder(reactContext, "pipeline_done")
      .setSmallIcon(smallIcon)
      .setContentTitle(title)
      .setContentText(message)
      .setContentIntent(contentIntent)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)

    val nm = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    // 用 taskId hashCode 做通知 id，避免不同任务互相覆盖
    val notifId = PipelineForegroundService.DONE_NOTIFICATION_BASE_ID + (taskId.hashCode() and 0xFFF)
    nm.notify(notifId, builder.build())
  }

  companion object {
    /**
     * MainActivity 通过此 extra 读取要跳转的 taskId。
     * 必须与 MainActivity.kt 中读取的 key 一致。
     */
    const val EXTRA_DEEP_LINK_TASK_ID = "shinewriter.deeplink.task_id"

    /**
     * 暂存从通知 intent 读到的 taskId，供 JS 通过 consumeDeepLinkTaskId 取走。
     * 用静态字段，跨 Activity/Module 实例共享（同进程）。
     */
    @Volatile
    private var pendingDeepLinkTaskId: String? = null

    fun setPendingDeepLinkTaskId(id: String?) {
      pendingDeepLinkTaskId = id
    }
  }
}
