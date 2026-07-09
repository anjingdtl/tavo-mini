package com.shinewriter.llamacpp

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * 导入大文件期间的前台通知服务，防止 Android 杀进程导致导入中断。
 *
 * Manifest 声明 foregroundServiceType="dataTransfer"（Android 15+ 推荐的文件传输场景类型）。
 * onCreate 内 5 秒内必须调 startForeground，否则 Android 11+ 抛异常。
 */
class LlamaCppForegroundService : Service() {

    companion object {
        private const val TAG = "LlamaCppForegroundSvc"
        @Volatile
        var isRunning: Boolean = false
            private set
    }

    override fun onCreate() {
        super.onCreate()
        LlamaCppNotification.createChannel(this)
        val notification = NotificationCompat.Builder(this, LlamaCppNotification.CHANNEL_ID)
            .setContentTitle("正在导入模型")
            .setContentText("请勿关闭应用")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // API 34+ 必须显式指定 foregroundServiceType，与 Manifest 一致
            startForeground(
                LlamaCppNotification.NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_TRANSFER,
            )
        } else {
            startForeground(LlamaCppNotification.NOTIFICATION_ID, notification)
        }
        isRunning = true
        Log.i(TAG, "Foreground service started")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        isRunning = false
        Log.i(TAG, "Foreground service destroyed")
    }
}
