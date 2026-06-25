package com.shinewriter

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
    handleDeepLinkIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleDeepLinkIntent(intent)
  }

  /**
   * 通知点击带过来的 taskId 由 PipelineForegroundModule 暂存，
   * JS 侧 App 启动/恢复时通过 consumeDeepLinkTaskId() 读取并导航。
   */
  private fun handleDeepLinkIntent(intent: Intent?) {
    val taskId = intent?.getStringExtra(PipelineForegroundModule.EXTRA_DEEP_LINK_TASK_ID)
    if (!taskId.isNullOrEmpty()) {
      PipelineForegroundModule.setPendingDeepLinkTaskId(taskId)
    }
  }

  override fun getMainComponentName(): String = "ShineWriter"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
