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
        // Q4_K_M 量化的 GGUF 模型 mmap 加载实际只用模型文件大小的 RAM
        // （CPU 推理时还会有 KV cache 临时占用，0.5B 模型约 100MB）。
        // 这里用 1.05 留出 KV cache 余量。
        private const val MEMORY_SAFETY_FACTOR = 1.05
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
    // P1-#6: 防止同一 requestId 重复启动，或两次 generate 串行混乱
    // 用 synchronized 块做轻量级互斥（仅 Kotlin 层标志，不与 JNI mutex 重复锁）
    @Volatile
    private var activeRequestId: String? = null
    private val generateLock = Any()

    /**
     * 加载模型到内存。若已有模型加载则先卸载。
     * 加载前做内存安全检查：可用内存 < 模型文件大小 × 1.5 时拒绝。
     */
    fun load(modelId: String, absolutePath: String, contextLength: Int = 4096): Result<LoadResult> {
        return try {
            Log.i(TAG, "load: enter, modelId=$modelId path=$absolutePath ctx=$contextLength")
            if (isLoaded) {
                Log.i(TAG, "load: a model is already loaded, unloading first")
                unload()
            }

            val modelFile = File(absolutePath)
            if (!modelFile.exists()) {
                return Result.failure(Exception("模型文件不存在：$absolutePath"))
            }
            Log.i(TAG, "load: file exists, size=${modelFile.length()} bytes")

            // 内存安全检查
            val memoryInfo = checkAvailableMemory()
            val requiredMB = (modelFile.length() * MEMORY_SAFETY_FACTOR / (1024 * 1024)).toLong()
            Log.i(TAG, "load: availableMB=${memoryInfo.availableMB}, requiredMB=$requiredMB")
            if (memoryInfo.availableMB < requiredMB) {
                return Result.failure(
                    Exception("内存不足：需要约 ${requiredMB}MB，当前可用 ${memoryInfo.availableMB}MB"),
                )
            }

            val startTime = System.currentTimeMillis()
            Log.i(TAG, "load: calling nativeInit")
            nativeInit(DEFAULT_NUM_THREADS)
            Log.i(TAG, "load: nativeInit done, calling nativeLoadModel")
            modelHandle = nativeLoadModel(absolutePath, contextLength)
            Log.i(TAG, "load: nativeLoadModel returned handle=$modelHandle")

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
     * 流式生成。在后台线程执行 JNI 调用，通过 callback 返回 token/完成/错误。
     * 调用方无需等待，结果异步到达 callback。
     *
     * callback 必须是 caller 自定义的 top-level class（不能是 inline object），
     * 否则 R8/D8 会将 callback 内联优化掉 onCompleted 方法名，导致 JNI
     * GetMethodID 找不到对应方法。生产路径使用 [LlamaCppGenCallback]；
     * debug 路径使用 [com.shinewriter.debug.TestGenCallback]。
     */
    fun generate(
        requestId: String,
        prompt: String,
        opts: GenerateOptions,
        callback: GenerationCallback,
    ) {
        if (!isLoaded || modelHandle == 0L) {
            callback.onError("模型未加载")
            return
        }
        // P1-#6: 同 requestId 已经在跑则直接 reject，
        // 避免重复 token 流 / completed 事件重复触发。
        // JNI 层 try_lock 是第二道防线，防止两个不同 requestId 并发。
        val alreadyActive: String? = synchronized(generateLock) {
            if (activeRequestId != null) activeRequestId else null
        }
        if (alreadyActive != null) {
            callback.onError(
                if (alreadyActive == requestId) "请求 $requestId 已在生成中" else "已有其他生成在进行中",
            )
            return
        }
        synchronized(generateLock) {
            activeRequestId = requestId
        }

        // JNI 长任务不能阻塞 RN bridge 线程，放到独立线程
        Thread {
            try {
                nativeGenerate(
                    modelHandle,
                    prompt,
                    opts.maxTokens,
                    opts.temperature,
                    opts.topP,
                    callback,
                )
            } finally {
                synchronized(generateLock) {
                    activeRequestId = null
                }
            }
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
