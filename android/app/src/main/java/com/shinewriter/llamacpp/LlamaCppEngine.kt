package com.shinewriter.llamacpp

import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.util.Log
import java.io.File

/**
 * llama.cpp 引擎单例，封装 JNI 调用 libllama.so。
 *
 * 管理 modelHandle 生命周期、内存安全检查、流式生成回调。
 * 一次只加载一个模型（符合 SPEC 约束）。
 */
class LlamaCppEngine private constructor(private val context: Context) {

    companion object {
        private const val TAG = "LlamaCppEngine"
        private const val MEMORY_SAFETY_FACTOR = 1.5 // 模型文件大小 × 1.5 作为 RAM 估算
        private const val DEFAULT_NUM_THREADS = 4

        @Volatile
        private var instance: LlamaCppEngine? = null

        fun getInstance(context: Context): LlamaCppEngine {
            return instance ?: synchronized(this) {
                instance ?: LlamaCppEngine(context.applicationContext).also { instance = it }
            }
        }

        init {
            System.loadLibrary("llamacpp_jni")
            Log.i(TAG, "llamacpp_jni library loaded")
        }
    }

    /** JNI 流式生成回调接口（onCompleted 含 cancelled 标记）。 */
    interface GenerationCallback {
        fun onToken(token: String, sequence: Int)
        fun onCompleted(text: String, outputTokens: Int, tokensPerSecond: Float, elapsedMs: Int, cancelled: Int)
        fun onError(message: String)
    }

    @Volatile
    private var modelHandle: Long = 0
    @Volatile
    private var isLoaded: Boolean = false
    @Volatile
    private var currentModelId: String? = null
    @Volatile
    private var currentModelPath: String? = null

    /**
     * 加载模型到内存。若已有模型加载则先卸载。
     * 加载前做内存安全检查：可用内存 < 模型文件大小 × 1.5 时拒绝。
     */
    fun load(modelId: String, absolutePath: String, contextLength: Int = 4096): Result<LoadResult> {
        return try {
            if (isLoaded) {
                Log.i(TAG, "load: a model is already loaded, unloading first")
                unload()
            }

            val modelFile = File(absolutePath)
            if (!modelFile.exists()) {
                return Result.failure(Exception("模型文件不存在：$absolutePath"))
            }

            // 内存安全检查
            val memoryInfo = checkAvailableMemory()
            val requiredMB = (modelFile.length() * MEMORY_SAFETY_FACTOR / (1024 * 1024)).toLong()
            if (memoryInfo.availableMB < requiredMB) {
                return Result.failure(
                    Exception("内存不足：需要约 ${requiredMB}MB，当前可用 ${memoryInfo.availableMB}MB"),
                )
            }

            val startTime = System.currentTimeMillis()
            nativeInit(DEFAULT_NUM_THREADS)
            modelHandle = nativeLoadModel(absolutePath, contextLength)

            if (modelHandle == 0L) {
                return Result.failure(Exception("模型加载失败，请确认文件格式正确"))
            }

            isLoaded = true
            currentModelId = modelId
            currentModelPath = absolutePath
            val elapsed = System.currentTimeMillis() - startTime
            Log.i(TAG, "load: success, modelId=$modelId, ${elapsed}ms")
            Result.success(LoadResult(backend = "cpu", loadTimeMs = elapsed))
        } catch (e: Exception) {
            Log.e(TAG, "load failed", e)
            Result.failure(e)
        }
    }

    /**
     * 流式生成。在后台线程执行 JNI 调用，通过回调返回 token/完成/错误。
     * 调用方无需等待，结果异步到达回调。
     */
    fun generate(
        requestId: String,
        prompt: String,
        opts: GenerateOptions,
        onToken: (requestId: String, delta: String, sequence: Int) -> Unit,
        onComplete: (requestId: String, text: String, outputTokens: Int, tokensPerSecond: Float, elapsedMs: Int, cancelled: Boolean) -> Unit,
        onError: (requestId: String, message: String) -> Unit,
    ) {
        if (!isLoaded || modelHandle == 0L) {
            onError(requestId, "模型未加载")
            return
        }
        val callback = object : GenerationCallback {
            override fun onToken(token: String, sequence: Int) = onToken(requestId, token, sequence)
            override fun onCompleted(
                text: String,
                outputTokens: Int,
                tokensPerSecond: Float,
                elapsedMs: Int,
                cancelled: Int,
            ) = onComplete(requestId, text, outputTokens, tokensPerSecond, elapsedMs, cancelled == 1)
            override fun onError(message: String) = onError(requestId, message)
        }
        // JNI 长任务不能阻塞 RN bridge 线程，放到独立线程
        Thread {
            nativeGenerate(
                modelHandle,
                prompt,
                opts.maxTokens,
                opts.temperature,
                opts.topP,
                callback,
            )
        }.start()
    }

    /** 取消当前生成（设置 atomic 标志，生成线程自然结束）。 */
    fun cancel() {
        if (modelHandle != 0L) {
            Log.i(TAG, "cancel: requesting cancellation")
            nativeCancel(modelHandle)
        }
    }

    /** 卸载当前模型，释放 JNI 资源。 */
    fun unload() {
        if (modelHandle != 0L) {
            Log.i(TAG, "unload: releasing model handle")
            nativeUnload(modelHandle)
            modelHandle = 0
        }
        isLoaded = false
        currentModelId = null
        currentModelPath = null
    }

    /** 系统内存压力回调：级别较高时卸载模型。 */
    fun trimMemory(level: Int) {
        if (level >= ComponentCallbacks2.TRIM_MEMORY_MODERATE) {
            Log.i(TAG, "trimMemory: level=$level, unloading model")
            unload()
        }
    }

    /** 兼容 SPEC 命名，等同 [unload]（单模型场景）。 */
    fun unloadAll() = unload()

    /** 查询当前可用内存。 */
    fun checkAvailableMemory(): MemoryInfo {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mi = ActivityManager.MemoryInfo()
        am.getMemoryInfo(mi)
        return MemoryInfo(
            availableMB = mi.availMem / (1024 * 1024),
            totalMB = mi.totalMem / (1024 * 1024),
            lowMemory = mi.lowMemory,
        )
    }

    val loaded: Boolean get() = isLoaded
    val loadedModelId: String? get() = currentModelId

    private external fun nativeInit(numThreads: Int): Int
    private external fun nativeLoadModel(modelPath: String, contextLen: Int): Long
    private external fun nativeGenerate(
        modelHandle: Long,
        prompt: String,
        maxTokens: Int,
        temperature: Float,
        topP: Float,
        callback: GenerationCallback,
    )
    private external fun nativeCancel(modelHandle: Long)
    private external fun nativeUnload(modelHandle: Long)
}
