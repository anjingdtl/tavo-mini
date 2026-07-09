package com.shinewriter.llamacpp

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build

/**
 * 导入进度通知渠道管理。
 *
 * 渠道 ID 固定为 `llamacpp_import`，IMPORTANCE_LOW（静默，长任务不应打扰用户）。
 * createChannel 幂等，重复调用安全。
 */
object LlamaCppNotification {
    const val CHANNEL_ID = "llamacpp_import"
    const val NOTIFICATION_ID = 2001

    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "模型导入",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "本地 GGUF 模型导入进度通知"
                setShowBadge(false)
            }
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }
}
