package com.shinewriter.llamacpp

import android.util.Log
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.modules.systeminfo.AndroidInfoModule
import com.facebook.react.uimanager.ViewManager

class LlamaCppPackage : BaseReactPackage() {

    companion object {
        private const val TAG = "LlamaCppPackage"
    }

    override fun getModule(
        name: String,
        reactContext: ReactApplicationContext,
    ): NativeModule? {
        Log.d(TAG, "LlamaCppPackage.getModule: name='$name' (BEFORE ROUTING)")
        return when (name) {
            "LlamaCpp" -> LlamaCppModule(reactContext)
            "PlatformConstants" -> {
                Log.i(TAG, "LlamaCppPackage routing PlatformConstants -> AndroidInfoModule")
                AndroidInfoModule::class.java
                    .getDeclaredConstructor(ReactApplicationContext::class.java)
                    .newInstance(reactContext)
            }
            else -> null
        }
    }

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
        val pcInfo = ReactModuleInfo(
            "PlatformConstants",
            AndroidInfoModule::class.java.name,
            false,
            false,
            false,
            true,
        )
        Log.i(TAG, "LlamaCppPackage.getReactModuleInfoProvider: creating PlatformConstants ReactModuleInfo=" +
            "name=${pcInfo.name} class=${pcInfo.className} isTurboModule=${pcInfo.isTurboModule}")
        val map = mutableMapOf<String, ReactModuleInfo>()
        map["LlamaCpp"] = ReactModuleInfo(
            "LlamaCpp",
            LlamaCppModule::class.java.name,
            false,
            false,
            false,
            true,
        )
        map["PlatformConstants"] = pcInfo
        return ReactModuleInfoProvider {
            Log.d(TAG, "LlamaCppPackage.getReactModuleInfos() invoked")
            map
        }
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<in Nothing, in Nothing>> {
        return emptyList()
    }
}