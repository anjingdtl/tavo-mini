package com.shinewriter

import android.app.Application
import android.content.ComponentCallbacks2
import android.content.res.Configuration
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

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
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    registerComponentCallbacks(object : ComponentCallbacks2 {
      override fun onTrimMemory(level: Int) {
        // Reserved for future memory-sensitive cleanup.
      }

      override fun onConfigurationChanged(newConfig: Configuration) {
        // No-op.
      }

      override fun onLowMemory() {
        // Reserved for future low-memory cleanup.
      }
    })
  }
}
