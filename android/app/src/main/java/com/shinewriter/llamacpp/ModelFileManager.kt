package com.shinewriter.llamacpp

import android.content.Context
import android.util.Log
import java.io.File
import java.security.MessageDigest

/**
 * 模型文件沙箱目录管理 + 路径安全校验。
 *
 * 所有模型文件存放在 `context.filesDir/local_models/` 下，
 * staging 临时文件放在 `.staging/` 子目录。所有外部传入的相对路径
 * 必须经 [resolveModelPath] 做 canonicalPath 越界校验，防止目录穿越攻击。
 */
class ModelFileManager(private val context: Context) {

    companion object {
        private const val TAG = "ModelFileManager"
        private const val MODELS_DIR = "local_models"
        private const val STAGING_DIR = ".staging"
    }

    /** 模型根目录：filesDir/local_models（访问时自动创建）。 */
    val modelsRoot: File
        get() {
            val dir = File(context.filesDir, MODELS_DIR)
            if (!dir.exists()) dir.mkdirs()
            return dir
        }

    /** staging 临时目录：modelsRoot/.staging（访问时自动创建）。 */
    val stagingRoot: File
        get() {
            val dir = File(modelsRoot, STAGING_DIR)
            if (!dir.exists()) dir.mkdirs()
            return dir
        }

    /**
     * 解析相对路径为绝对 File，并做 canonicalPath 越界校验。
     * 若目标路径不在 [modelsRoot] 之下，抛 SecurityException。
     */
    fun resolveModelPath(relativePath: String): File {
        val rootCanon = modelsRoot.canonicalPath
        val target = File(modelsRoot, relativePath)
        val targetCanon = target.canonicalPath
        if (!targetCanon.startsWith(rootCanon)) {
            throw SecurityException("模型文件路径越界：$relativePath")
        }
        return target
    }

    /** 由绝对 File 反算相对 [modelsRoot] 的路径。 */
    fun getRelativePath(absoluteFile: File): String {
        val rootCanon = modelsRoot.canonicalPath
        val fileCanon = absoluteFile.canonicalPath
        if (!fileCanon.startsWith(rootCanon)) {
            throw SecurityException("文件不在模型根目录下：$absoluteFile")
        }
        return fileCanon.removePrefix(rootCanon).removePrefix(File.separator)
    }

    /** 生成 staging 临时文件路径：.staging/{importId}.{ext}.tmp。 */
    fun getStagingFile(importId: String, filename: String): File {
        val ext = filename.substringAfterLast('.', "gguf")
        return File(stagingRoot, "$importId.$ext.tmp")
    }

    /**
     * 将 staging 文件移动到最终目录：local_models/{importId}/model.{ext}。
     * 优先 renameTo（同分区原子快），失败则流式 copy + delete。
     */
    fun moveFromStagingToFinal(stagingFile: File, importId: String, extension: String = "gguf"): File {
        val modelDir = newModelDir(importId)
        val finalFile = File(modelDir, "model.$extension")
        if (finalFile.exists()) finalFile.delete()
        if (!stagingFile.renameTo(finalFile)) {
            // 跨分区 fallback：流式复制后删除源文件
            stagingFile.inputStream().buffered(65536).use { input ->
                finalFile.outputStream().buffered(65536).use { output ->
                    input.copyTo(output)
                }
            }
            stagingFile.delete()
        }
        return finalFile
    }

    /** 创建并返回模型子目录：local_models/{importId}/。 */
    fun newModelDir(importId: String): File {
        val dir = File(modelsRoot, importId)
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    /** 返回模型文件：local_models/{importId}/model.{ext}。 */
    fun modelFile(importId: String, extension: String = "gguf"): File {
        return File(newModelDir(importId), "model.$extension")
    }

    /** 删除指定相对路径的模型文件，父目录若空则一并删除。 */
    fun deleteModelFiles(relativePath: String): Boolean {
        return try {
            val target = resolveModelPath(relativePath)
            var ok = true
            if (target.isFile) {
                ok = target.delete()
            } else if (target.isDirectory) {
                target.walkBottomUp().forEach { it.delete() }
            }
            // 清理空的父目录（直到 modelsRoot）
            var parent = target.parentFile
            val rootCanon = modelsRoot.canonicalPath
            while (parent != null && parent.canonicalPath != rootCanon) {
                if (parent.listFiles()?.isEmpty() == true) {
                    parent.delete()
                    parent = parent.parentFile
                } else {
                    break
                }
            }
            ok
        } catch (e: Exception) {
            Log.e(TAG, "deleteModelFiles failed: $relativePath", e)
            false
        }
    }

    /** 检查相对路径对应的文件是否存在。 */
    fun modelFileExists(relativePath: String): Boolean {
        return try {
            resolveModelPath(relativePath).exists()
        } catch (e: SecurityException) {
            Log.w(TAG, "modelFileExists rejected: $relativePath", e)
            false
        }
    }

    /** 流式计算文件 SHA-256，返回小写十六进制字符串。 */
    fun computeSha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered(65536).use { input ->
            val buffer = ByteArray(8192)
            var read: Int
            while (input.read(buffer).also { read = it } != -1) {
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** 清理 staging 目录下所有 .tmp 文件，返回删除数量。 */
    fun cleanupStagingFiles(): Int {
        var count = 0
        val root = stagingRoot
        root.listFiles()?.forEach { f ->
            if (f.isFile && f.name.endsWith(".tmp")) {
                if (f.delete()) count++
            }
        }
        if (count > 0) Log.i(TAG, "cleanupStagingFiles: removed $count staging file(s)")
        return count
    }
}
