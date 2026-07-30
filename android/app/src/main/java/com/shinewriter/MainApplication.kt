package com.shinewriter

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.shinewriter.react.CoreTurboModuleBridge

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    // WORKAROUND for RN 0.85 + D8: CoreReactPackage.fallbackForMissingClass()
    // 反射读 @ReactModule 注解来构 ReactModuleInfo，但 RUNTIME 注解 / TurboModule
    // 反射在 OSS build 中不可靠。把 CoreTurboModuleBridge 放到 packages[0]，
    // 显式提供 PlatformConstants / SourceCode / DeviceEventManager /
    // ExceptionsManager 的 hardcode ReactModuleInfo，绕过反射路径。
    val finalList = PackageList(this).packages.apply {
      add(0, CoreTurboModuleBridge())
      // 未走 autolinking 的包在这里手动加：
      add(TtsAudioPackage())
      add(PipelineForegroundPackage())
      add(PngMetadataPackage())
      add(ContinuationTextImportPackage())
    }
    getDefaultReactHost(
      context = applicationContext,
      packageList = finalList,
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}

