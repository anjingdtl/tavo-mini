package com.shinewriter.react

import android.util.Log
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.ExceptionsManagerModule
import com.facebook.react.modules.debug.SourceCodeModule
import com.facebook.react.modules.systeminfo.AndroidInfoModule
import com.facebook.react.uimanager.ViewManager

/**
 * RN 0.85 Bridgeless + D8 strip @ReactModule 注解的 workaround。
 *
 * The real fix would be to keep @ReactModule annotations in dex. Until that's done,
 * we provide an explicit ReactModuleInfoProvider that hard-codes the core module
 * names + class names so TurboModuleManager can find them via the bridge instead
 * of via the stripped annotation reflection.
 */
class CoreTurboModuleBridge : BaseReactPackage() {

    companion object {
        private const val TAG = "CoreTurboModuleBridge"

        private val CORE_MODULES: List<Triple<String, Class<out NativeModule>, Boolean>> = listOf(
            Triple(AndroidInfoModule.NAME, AndroidInfoModule::class.java, true),
            Triple(SourceCodeModule.NAME, SourceCodeModule::class.java, true),
            Triple(DeviceEventManagerModule.NAME, DeviceEventManagerModule::class.java, true),
            Triple(ExceptionsManagerModule.NAME, ExceptionsManagerModule::class.java, true),
        )
    }

    override fun getModule(
        name: String,
        reactContext: ReactApplicationContext,
    ): NativeModule? {
        Log.d(TAG, "getModule called: name='$name'")
        val entry = CORE_MODULES.firstOrNull { it.first == name } ?: return null
        Log.d(TAG, "getModule: $name -> ${entry.second.simpleName}")
        return try {
            val ctor = entry.second.getDeclaredConstructor(ReactApplicationContext::class.java)
            ctor.newInstance(reactContext)
        } catch (e: NoSuchMethodException) {
            Log.w(TAG, "getModule: $name has no single-arg ctor: ${e.message}")
            null
        } catch (e: Throwable) {
            Log.e(TAG, "getModule: $name failed", e)
            null
        }
    }

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
        val map = mutableMapOf<String, ReactModuleInfo>()
        for ((name, clazz, isTurbo) in CORE_MODULES) {
            map[name] = ReactModuleInfo(
                name,
                clazz.name,
                false,
                false,
                false,
                isTurbo,
            )
        }
        Log.i(TAG, "getReactModuleInfoProvider: registering ${map.size} core modules: ${map.keys}")

        // The provider is invoked once at ReactInstance.initialize#initTurboModules
        // and its result is cached in packageModuleInfos. Subsequent lookups in
        // unstable_isModuleRegistered iterate moduleProviders + cached maps without
        // calling back into here.
        return ReactModuleInfoProvider { map }
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<in Nothing, in Nothing>> {
        return emptyList()
    }
}