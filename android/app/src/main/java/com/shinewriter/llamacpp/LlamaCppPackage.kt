package com.shinewriter.llamacpp

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * ReactPackage 注册：把 [LlamaCppModule] 注册进 RN 的 native module 列表。
 *
 * TS 侧通过 `NativeModules.LlamaCpp` 访问模块方法。
 */
class LlamaCppPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(LlamaCppModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
