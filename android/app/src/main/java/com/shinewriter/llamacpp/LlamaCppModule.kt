package com.shinewriter.llamacpp

import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.shinewriter.specs.NativeLlamaCppSpec

/**
 * ReactMethod 桥接层：RN 调 Kotlin 的唯一入口。
 *
 * Promise 方法用于一次性请求/响应；流式生成通过 DeviceEventEmitter
 * 发送事件（LlamaCppToken / LlamaCppCompleted / LlamaCppError /
 * LlamaCppImportProgress / LlamaCppImportState），TS 侧监听这些事件。
 *
 * P0-#1 后续修复：RN 0.85 bridgeless 模式下，TurboModuleManager 走 cpp 端
 * javaModuleProvider 找不到没有 codegen 的 Java module；fallback 到
 * ReactPackageTurboModuleManagerDelegate.getModule()，但那里第 125-128 行
 * 检查 `resolvedModule !is TurboModule` 时会直接 return null。
 * 2026-07-10：补上 codegen spec 后继承 NativeLlamaCppSpec，让 bridgeless
 * JSI 层按生成签名调用 Kotlin module。
 */
@ReactModule(name = NativeLlamaCppSpec.NAME)
class LlamaCppModule(reactContext: ReactApplicationContext) :
    NativeLlamaCppSpec(reactContext) {

    companion object {
        private const val TAG = "LlamaCppModule"

        @Volatile
        private var engine: LlamaCppEngine? = null
        @Volatile
        private var instance: LlamaCppModule? = null
        private var fileManager: ModelFileManager? = null
        private var importer: ModelImporter? = null

        /** MainApplication.onTrimMemory 转发入口。 */
        @JvmStatic
        fun onTrimMemory(level: Int) {
          engine?.trimMemory(level)
          instance?.sendMemoryPressure(true, level)
        }

        /** MainApplication.onLowMemory 转发入口。 */
        @JvmStatic
        fun onLowMemory() {
          engine?.unload()
          instance?.sendMemoryPressure(true, -1)
        }
    }

    init {
        instance = this
    }

    private val engineInstance: LlamaCppEngine
        get() = engine ?: synchronized(this) {
            engine ?: LlamaCppEngine.getInstance(reactApplicationContext).also { engine = it }
        }

    private val fileManagerInstance: ModelFileManager
        get() = fileManager ?: synchronized(this) {
            fileManager ?: ModelFileManager(reactApplicationContext).also { fileManager = it }
        }

    private val importerInstance: ModelImporter
        get() = importer ?: synchronized(this) {
            importer ?: ModelImporter(reactApplicationContext, fileManagerInstance).also { importer = it }
        }

    // ── ReactMethod: 能力查询 ────────────────────────────────────

    @ReactMethod
    override fun getCapabilities(promise: Promise) {
        try {
            val mi = engineInstance.checkAvailableMemory()
            val result = Arguments.createMap().apply {
                putBoolean("available", true)
                putBoolean("cpuSupported", true)
                putDouble("freeMemoryMB", mi.availableMB.toDouble())
                putDouble("totalMemoryMB", mi.totalMB.toDouble())
            }
            promise.resolve(result)
        } catch (e: Exception) {
            Log.e(TAG, "getCapabilities failed", e)
            promise.reject(LlamaCppErrors.ENGINE_UNAVAILABLE, e.message, e)
        }
    }

    // ── ReactMethod: 导入 ────────────────────────────────────────

    @ReactMethod
    override fun importModel(
        sourceUri: String,
        originalFilename: String,
        displayName: String,
        promise: Promise,
    ) {
        val svcIntent = Intent(reactApplicationContext, LlamaCppForegroundService::class.java)
        try {
            // 启动前台服务，防止导入期间进程被杀。
            // 若服务已经在跑（用户连续触发导入），跳过 startForeground 避免 ANR。
            if (!LlamaCppForegroundService.isRunning) {
                LlamaCppNotification.createChannel(reactApplicationContext)
                ContextCompat.startForegroundService(reactApplicationContext, svcIntent)
            }

            importerInstance.importModel(
                sourceUri = sourceUri,
                originalFilename = originalFilename,
                displayName = displayName,
                onProgress = { importId, bytesCopied, totalBytes ->
                    sendEvent(LlamaCppEvents.IMPORT_PROGRESS, Arguments.createMap().apply {
                        putString("importId", importId)
                        putDouble("bytesCopied", bytesCopied.toDouble())
                        putDouble("totalBytes", totalBytes.toDouble())
                        putInt("percent", if (totalBytes > 0) (bytesCopied * 100 / totalBytes).toInt() else 0)
                    })
                },
                onStateChanged = { importId, state ->
                    sendEvent(LlamaCppEvents.IMPORT_STATE, Arguments.createMap().apply {
                        putString("importId", importId)
                        putString("state", state)
                    })
                },
                onComplete = { result ->
                    stopServiceIfRunning(svcIntent)
                    val map = Arguments.createMap().apply {
                        putString("importId", result.importId)
                        putString("originalFilename", result.originalFilename)
                        putString("displayName", result.displayName)
                        putDouble("fileSize", result.fileSize.toDouble())
                        putString("sha256", result.sha256)
                        putString("stagingRelativePath", result.stagingRelativePath)
                    }
                    promise.resolve(map)
                },
                onError = { importId, code, message ->
                    stopServiceIfRunning(svcIntent)
                    promise.reject(code, message)
                },
            )
        } catch (e: Exception) {
            Log.e(TAG, "importModel failed", e)
            // startForegroundService 或 importModel 自身抛异常时，确保 service 不残留
            stopServiceIfRunning(svcIntent)
            promise.reject(LlamaCppErrors.IMPORT_COPY_FAILED, e.message, e)
        }
    }

    /**
     * 仅当 service 真的在跑时才 stop。
     * P1-#7 修复：importModel 可能 startForegroundService 抛异常（onCreate 失败、OOM 等），
     * 或 service 已被系统 / 其它流程 stop 过；这两种情况再次 stopService 是无意义的，
     * 某些 Android 版本会返回 false 但调用本身没副作用。为避免噪音日志显式检查。
     */
    private fun stopServiceIfRunning(intent: Intent) {
        if (LlamaCppForegroundService.isRunning) {
            reactApplicationContext.stopService(intent)
        }
    }

    // ── ReactMethod: 校验（加载后立即卸载）────────────────────────

    @ReactMethod
    override fun validateModel(modelId: String, relativePath: String, promise: Promise) {
        // P0-#2/#3 配套修复：load/unload 可能等待活跃生成结束，不能阻塞 RN bridge 线程。
        Thread {
            try {
                val absPath = fileManagerInstance.resolveModelPath(relativePath).absolutePath
                val loadResult = engineInstance.load(modelId, absPath)
                if (loadResult.isSuccess) {
                    // 仅校验，加载后立即卸载
                    engineInstance.unload()
                    val result = loadResult.getOrThrow()
                    promise.resolve(loadResultMap(result))
                } else {
                    promise.reject(
                        LlamaCppErrors.MODEL_LOAD_FAILED,
                        loadResult.exceptionOrNull()?.message ?: "模型校验失败",
                    )
                }
            } catch (e: SecurityException) {
                promise.reject(LlamaCppErrors.MODEL_FILE_OUTSIDE_ROOT, e.message, e)
            } catch (e: Exception) {
                Log.e(TAG, "validateModel failed", e)
                promise.reject(LlamaCppErrors.MODEL_LOAD_FAILED, e.message, e)
            }
        }.start()
    }

    // ── ReactMethod: 加载（保持加载状态）──────────────────────────

    @ReactMethod
    override fun loadModel(modelId: String, relativePath: String, contextLength: Double, promise: Promise) {
        // P0-#2/#3 配套修复：load 可能先 unload 等待活跃生成，模型加载本身也耗时，放后台线程。
        Thread {
            try {
                val absPath = fileManagerInstance.resolveModelPath(relativePath).absolutePath
                val ctxLen = contextLength.toInt().coerceIn(512, 8192)
                val loadResult = engineInstance.load(modelId, absPath, ctxLen)
                if (loadResult.isSuccess) {
                    promise.resolve(loadResultMap(loadResult.getOrThrow()))
                } else {
                    promise.reject(
                        LlamaCppErrors.MODEL_LOAD_FAILED,
                        loadResult.exceptionOrNull()?.message ?: "模型加载失败",
                    )
                }
            } catch (e: SecurityException) {
                promise.reject(LlamaCppErrors.MODEL_FILE_OUTSIDE_ROOT, e.message, e)
            } catch (e: Exception) {
                Log.e(TAG, "loadModel failed", e)
                promise.reject(LlamaCppErrors.MODEL_LOAD_FAILED, e.message, e)
            }
        }.start()
    }

    // ── ReactMethod: 流式生成（结果走事件）────────────────────────

    @ReactMethod
    override fun generate(requestId: String, modelId: String, request: ReadableMap, promise: Promise) {
        try {
            if (!engineInstance.loaded) {
                promise.reject(LlamaCppErrors.ENGINE_NOT_READY, "模型未加载")
                return
            }

            // 优先用 TS 侧格式化好的 prompt；否则回退用 messages + chatml
            val prompt = if (request.hasKey("prompt")) {
                request.getString("prompt") ?: ""
            } else {
                buildPromptFromMessages(request.getArray("messages"))
            }

            val opts = GenerateOptions(
                maxTokens = if (request.hasKey("max_tokens")) request.getInt("max_tokens") else 512,
                temperature = if (request.hasKey("temperature")) request.getDouble("temperature").toFloat() else 0.8f,
                topP = if (request.hasKey("top_p")) request.getDouble("top_p").toFloat() else 0.9f,
            )

            val cb = LlamaCppGenCallback().apply {
                bind(
                    requestId,
                    onToken = { reqId, delta, sequence ->
                        sendEvent(LlamaCppEvents.TOKEN, Arguments.createMap().apply {
                            putString("requestId", reqId)
                            putString("delta", delta)
                            putInt("sequence", sequence)
                        })
                    },
                    onComplete = { reqId, text, outputTokens, tps, elapsedMs, cancelled ->
                        sendEvent(LlamaCppEvents.COMPLETED, Arguments.createMap().apply {
                            putString("requestId", reqId)
                            putString("text", text)
                            putInt("outputTokens", outputTokens)
                            putDouble("tokensPerSecond", tps.toDouble())
                            putInt("elapsedMs", elapsedMs)
                            putBoolean("cancelled", cancelled)
                        })
                    },
                    onError = { reqId, message ->
                        sendEvent(LlamaCppEvents.ERROR, Arguments.createMap().apply {
                            putString("requestId", reqId)
                            putString("code", LlamaCppErrors.GENERATION_FAILED)
                            putString("message", message)
                        })
                    },
                    onTerminal = { reqId ->
                        // 先释放 Kotlin 侧的 activeRequestId，再同步派发 RN 终态事件。
                        // 否则用户刚完成第一章就开始第二章时，会撞上上一轮的退出窗口。
                        engineInstance.markRequestFinished(reqId)
                    },
                )
            }
            engineInstance.generate(
                requestId = requestId,
                prompt = prompt,
                opts = opts,
                callback = cb,
            )
            // 立即 resolve 表示「开始生成」，实际结果走事件
            promise.resolve(null)
        } catch (e: Exception) {
            Log.e(TAG, "generate failed", e)
            promise.reject(LlamaCppErrors.GENERATION_FAILED, e.message, e)
        }
    }

    // ── ReactMethod: 取消 ────────────────────────────────────────

    @ReactMethod
    override fun cancel(requestId: String, promise: Promise) {
        engineInstance.cancel()
        promise.resolve(null)
    }

    // ── ReactMethod: 卸载 ────────────────────────────────────────

    @ReactMethod
    override fun unloadModel(promise: Promise) {
        // P0-#2/#3 配套修复：unload 会等待活跃生成，放后台线程避免 bridge 无响应。
        Thread {
            engineInstance.unload()
            promise.resolve(null)
        }.start()
    }

    // ── ReactMethod: 删除 ────────────────────────────────────────

    @ReactMethod
    override fun deleteModelFiles(modelId: String, relativePath: String, promise: Promise) {
        // 删除前先卸载（若当前加载的正是该模型）；unload 可能等待生成，放后台线程。
        Thread {
            try {
                if (engineInstance.loaded && engineInstance.loadedModelId == modelId) {
                    engineInstance.unload()
                }
                val ok = fileManagerInstance.deleteModelFiles(relativePath)
                if (ok) {
                    promise.resolve(null)
                } else {
                    promise.reject(LlamaCppErrors.DELETE_FAILED, "删除模型文件失败")
                }
            } catch (e: Exception) {
                Log.e(TAG, "deleteModelFiles failed", e)
                promise.reject(LlamaCppErrors.DELETE_FAILED, e.message, e)
            }
        }.start()
    }

    // ── ReactMethod: 文件存在检查 ────────────────────────────────

    @ReactMethod
    override fun modelFileExists(relativePath: String, promise: Promise) {
        promise.resolve(fileManagerInstance.modelFileExists(relativePath))
    }

    // ── ReactMethod: 清理 staging ────────────────────────────────

    @ReactMethod
    override fun cleanupStagingFiles(promise: Promise) {
        promise.resolve(fileManagerInstance.cleanupStagingFiles())
    }

    // ── RN 0.65+ 事件监听器要求（no-op）──────────────────────────

    @ReactMethod
    override fun addListener(eventName: String) {
        // no-op: required by RN event emitter
    }

    @ReactMethod
    override fun removeListeners(count: Double) {
        // no-op: required by RN event emitter
    }

    // ── 辅助方法 ────────────────────────────────────────────────

    private fun sendEvent(eventName: String, params: WritableMap?) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    private fun sendMemoryPressure(lowMemory: Boolean, level: Int) {
        sendEvent(LlamaCppMemoryPressure.EVENT, Arguments.createMap().apply {
            putBoolean("lowMemory", lowMemory)
            putInt("level", level)
        })
    }

    private fun loadResultMap(result: LoadResult): WritableMap {
        return Arguments.createMap().apply {
            putString("backend", result.backend)
            putDouble("loadTimeMs", result.loadTimeMs.toDouble())
        }
    }

    /** chatml 回退：TS 侧未格式化 prompt 时用 messages 拼装。 */
    private fun buildPromptFromMessages(messagesArray: ReadableArray?): String {
        if (messagesArray == null) return ""
        val sb = StringBuilder()
        for (i in 0 until messagesArray.size()) {
            val msg = messagesArray.getMap(i) ?: continue
            val role = msg.getString("role") ?: "user"
            val content = msg.getString("content") ?: ""
            when (role) {
                "system" -> sb.append("<|im_start|>system\n$content<|im_end|>\n")
                "user" -> sb.append("<|im_start|>user\n$content<|im_end|>\n")
                "assistant" -> sb.append("<|im_start|>assistant\n$content<|im_end|>\n")
            }
        }
        sb.append("<|im_start|>assistant\n")
        return sb.toString()
    }
}
