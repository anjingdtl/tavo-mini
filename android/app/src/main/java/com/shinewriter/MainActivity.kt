package com.shinewriter

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
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
      // 10.20 修复：去除已处理 extra，Activity 重建（如旋转屏幕）时不会重复导航
      intent.removeExtra(PipelineForegroundModule.EXTRA_DEEP_LINK_TASK_ID)
    }

    // Debug-only QA seam.  It is intentionally intent-driven and whitelisted
    // here, before JS starts, so it cannot alter release behavior or accept an
    // arbitrary payload from an external caller.
    if (BuildConfig.DEBUG) {
      val scenario = intent?.getStringExtra(
        PipelineForegroundModule.EXTRA_STORY_MEMORY_DEBUG_SCENARIO,
      )
      if (PipelineForegroundModule.isStoryMemoryDebugScenario(scenario)) {
        PipelineForegroundModule.setPendingStoryMemoryDebugScenario(scenario)
        intent?.removeExtra(PipelineForegroundModule.EXTRA_STORY_MEMORY_DEBUG_SCENARIO)
      }
    }
  }

  override fun getMainComponentName(): String = "ShineWriter"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
