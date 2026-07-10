package com.shinewriter.llamacpp

import android.content.Context
import android.net.Uri
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID

/**
 * 流式导入 content:// URI 到沙箱，同步计算 SHA-256（避免二次读大文件），
 * 复制完成后校验 GGUF 头，最后 move 到最终目录。
 *
 * 支持取消：[cancelImport] 标记 importId 后，复制循环检测到即终止并清理 staging。
 */
class ModelImporter(
    private val context: Context,
    private val fileManager: ModelFileManager,
) {

    companion object {
        private const val TAG = "ModelImporter"
        private const val BUFFER_SIZE = 65536 // 64KB
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val activeJobs = mutableMapOf<String, Job>()
    private val cancelledImports = mutableSetOf<String>()

    /**
     * 启动导入。立即返回 importId（RN 侧用此 id 调 [cancelImport]）。
     * 所有结果通过回调返回（回调在 IO 线程触发，调用方需自行切线程）。
     */
    fun importModel(
        sourceUri: String,
        originalFilename: String,
        displayName: String,
        onProgress: (importId: String, bytesCopied: Long, totalBytes: Long) -> Unit,
        onStateChanged: (importId: String, state: String) -> Unit,
        onComplete: (result: ImportResult) -> Unit,
        onError: (importId: String, code: String, message: String) -> Unit,
    ): String {
        val importId = "import-${UUID.randomUUID()}"
        val stagingFile = fileManager.getStagingFile(importId, originalFilename)

        // 在创建协程前同步通知调用方。RN 侧靠第一条状态事件确认原生模块
        // 已接到请求；若等到 Dispatchers.IO 实际开始调度，某些真机在前台服务
        // 切换期间可能长时间没有事件，最终被 JS 的导入看门狗误判为“引擎无响应”。
        // 后台协程仍会发送一次 copying 状态，以兼容已有的事件消费者。
        onStateChanged(importId, "copying")

        val job = scope.launch {
            try {
                onStateChanged(importId, "copying")
                val digest = MessageDigest.getInstance("SHA-256")
                val resolver = context.contentResolver
                val input = resolver.openInputStream(Uri.parse(sourceUri))
                    ?: throw IOException("无法读取源文件 URI")

                var bytesCopied = 0L
                input.use { ins ->
                    stagingFile.outputStream().buffered(BUFFER_SIZE).use { out ->
                        val buffer = ByteArray(BUFFER_SIZE)
                        var read: Int
                        while (ins.read(buffer).also { read = it } != -1) {
                            if (cancelledImports.contains(importId) || !isActive) {
                                throw CancellationException("import cancelled")
                            }
                            out.write(buffer, 0, read)
                            digest.update(buffer, 0, read)
                            bytesCopied += read
                            // totalBytes=-1：content URI 通常无法预知大小
                            onProgress(importId, bytesCopied, -1L)
                        }
                    }
                }

                if (bytesCopied == 0L) {
                    stagingFile.delete()
                    onError(importId, LlamaCppErrors.SOURCE_FILE_EMPTY, "源文件为空")
                    return@launch
                }

                // GGUF 头校验
                if (!GgufValidator.validateHeader(stagingFile)) {
                    stagingFile.delete()
                    onError(
                        importId,
                        LlamaCppErrors.GGUF_HEADER_INVALID,
                        "文件格式不正确，请选择有效的 .gguf 模型文件",
                    )
                    return@launch
                }

                val sha256 = digest.digest().joinToString("") { "%02x".format(it) }
                val finalFile = fileManager.moveFromStagingToFinal(stagingFile, importId)
                val relativePath = fileManager.getRelativePath(finalFile)

                onComplete(
                    ImportResult(
                        importId = importId,
                        originalFilename = originalFilename,
                        displayName = displayName,
                        fileSize = bytesCopied,
                        sha256 = sha256,
                        stagingRelativePath = relativePath,
                    ),
                )
            } catch (e: CancellationException) {
                stagingFile.delete()
                onError(importId, LlamaCppErrors.IMPORT_CANCELLED, "导入已取消")
            } catch (e: Exception) {
                Log.e(TAG, "importModel failed for $importId", e)
                stagingFile.delete()
                onError(
                    importId,
                    LlamaCppErrors.IMPORT_COPY_FAILED,
                    e.message ?: "导入失败",
                )
            } finally {
                activeJobs.remove(importId)
                cancelledImports.remove(importId)
            }
        }
        activeJobs[importId] = job
        return importId
    }

    /** 取消指定导入：标记取消标志 + 取消协程。 */
    fun cancelImport(importId: String) {
        cancelledImports.add(importId)
        activeJobs[importId]?.cancel()
    }
}
