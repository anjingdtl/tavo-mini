package com.shinewriter.llamacpp

/**
 * RN 事件名常量 + 跨层数据类集中定义。
 *
 * 事件名通过 DeviceEventEmitter 发送到 TS 侧，TS 侧监听这些字符串。
 * 数据类用于 Kotlin 内部传递，LlamaCppModule 再将其转成 WritableMap。
 */
object LlamaCppEvents {
    const val TOKEN = "LlamaCppToken"
    const val COMPLETED = "LlamaCppCompleted"
    const val ERROR = "LlamaCppError"
    const val IMPORT_PROGRESS = "LlamaCppImportProgress"
    const val IMPORT_STATE = "LlamaCppImportState"
}

data class TokenEvent(
    val requestId: String,
    val delta: String,
    val sequence: Int,
)

data class CompletedEvent(
    val requestId: String,
    val text: String,
    val outputTokens: Int,
    val tokensPerSecond: Float,
    val elapsedMs: Int,
    val cancelled: Boolean = false,
)

data class ErrorEvent(
    val requestId: String,
    val code: String,
    val message: String,
)

data class ImportProgressEvent(
    val importId: String,
    val bytesCopied: Long,
    val totalBytes: Long,
    val percent: Int,
)

data class ImportStateEvent(
    val importId: String,
    val state: String,
)

data class CapabilitiesResult(
    val available: Boolean,
    val cpuSupported: Boolean,
    val freeMemoryMB: Long,
    val totalMemoryMB: Long,
)

data class ImportResult(
    val importId: String,
    val originalFilename: String,
    val displayName: String,
    val fileSize: Long,
    val sha256: String,
    val stagingRelativePath: String,
)

data class LoadResult(
    val backend: String,
    val loadTimeMs: Long,
)

/** validateModel 与 loadModel 返回结构同构，复用同一类型。 */
typealias ValidationResult = LoadResult

data class MemoryInfo(
    val availableMB: Long,
    val totalMB: Long,
    val lowMemory: Boolean,
)

data class GenerateOptions(
    val maxTokens: Int = 512,
    val temperature: Float = 0.8f,
    val topP: Float = 0.9f,
)
