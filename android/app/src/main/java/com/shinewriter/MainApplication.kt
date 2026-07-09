package com.shinewriter

import android.app.Application
import android.content.ComponentCallbacks2
import android.content.res.Configuration
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.shinewriter.llamacpp.LlamaCppModule
import com.shinewriter.llamacpp.LlamaCppPackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          add(TtsAudioPackage())
          add(PipelineForegroundPackage())
          add(PngMetadataPackage())
          add(LlamaCppPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    registerComponentCallbacks(object : ComponentCallbacks2 {
      override fun onTrimMemory(level: Int) {
        if (level >= ComponentCallbacks2.TRIM_MEMORY_MODERATE) {
          LlamaCppModule.onTrimMemory(level)
        }
      }

      override fun onConfigurationChanged(newConfig: Configuration) {
        // No-op.
      }

      override fun onLowMemory() {
        LlamaCppModule.onLowMemory()
      }
    })
  }
}
