package com.shinewriter.llamacpp

/**
 * 顶层 callback class，供 LlamaCppModule 传给 LlamaCppEngine。
 *
 * 必须是 top-level class（不能在 object 内部、不能在 inline lambda 内），
 * 否则 D8/R8 会把 onCompleted / onError 方法签名中的参数 strip 掉，
 * 导致 JNI 端 GetMethodID("onCompleted", "(Ljava/lang/String;IFII)V") 失败。
 *
 * 用法：
 *   val cb = LlamaCppGenCallback()
 *   cb.bind(requestId, onToken, onComplete, onError, onTerminal)
 *   engineInstance.generate(..., callback = cb)
 *
 * bind 必须在调用 engine.generate 之前完成（Kotlin 层会在启动后台线程
 * 之前同步设 activeRequestId 并立即调 nativeGenerate）。
 */
class LlamaCppGenCallback : LlamaCppEngine.GenerationCallback {

    private var requestId: String = ""
    private var onTokenFn: ((String, String, Int) -> Unit)? = null
    private var onCompleteFn: ((String, String, Int, Float, Int, Boolean) -> Unit)? = null
    private var onErrorFn: ((String, String) -> Unit)? = null
    private var onTerminalFn: ((String) -> Unit)? = null

    fun bind(
        requestId: String,
        onToken: (String, String, Int) -> Unit,
        onComplete: (String, String, Int, Float, Int, Boolean) -> Unit,
        onError: (String, String) -> Unit,
        onTerminal: (String) -> Unit,
    ) {
        this.requestId = requestId
        this.onTokenFn = onToken
        this.onCompleteFn = onComplete
        this.onErrorFn = onError
        this.onTerminalFn = onTerminal
    }

    override fun onToken(token: String, sequence: Int) {
        onTokenFn?.invoke(requestId, token, sequence)
    }

    override fun onCompleted(
        text: String,
        outputTokens: Int,
        tokensPerSecond: Float,
        elapsedMs: Int,
        cancelled: Int,
    ) {
        onTerminalFn?.invoke(requestId)
        onCompleteFn?.invoke(requestId, text, outputTokens, tokensPerSecond, elapsedMs, cancelled == 1)
    }

    override fun onError(message: String) {
        onTerminalFn?.invoke(requestId)
        onErrorFn?.invoke(requestId, message)
    }
}
