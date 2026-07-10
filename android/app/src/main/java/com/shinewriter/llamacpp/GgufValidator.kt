package com.shinewriter.llamacpp

import android.util.Log
import java.io.File

/**
 * GGUF 文件头校验。
 *
 * 只读前 8 字节（magic + version），不做全文件扫描。
 * magic = 0x46554747（ASCII "GGUF"，小端 uint32），version 接受 v2/v3。
 */
object GgufValidator {
    private const val TAG = "GgufValidator"
    private const val GGUF_MAGIC: Long = 0x46554747L // "GGUF" little-endian uint32

    fun validateHeader(file: File): Boolean {
        return try {
            file.inputStream().buffered(12).use { input ->
                val magicBuf = ByteArray(4)
                if (input.read(magicBuf) != 4) {
                    Log.w(TAG, "validateHeader: file too short: ${file.name}")
                    return false
                }
                val magic = (magicBuf[0].toLong() and 0xFF) or
                    ((magicBuf[1].toLong() and 0xFF) shl 8) or
                    ((magicBuf[2].toLong() and 0xFF) shl 16) or
                    ((magicBuf[3].toLong() and 0xFF) shl 24)
                if (magic != GGUF_MAGIC) {
                    Log.w(TAG, "validateHeader: invalid magic 0x${magic.toString(16)} for ${file.name}")
                    return false
                }
                val versionBuf = ByteArray(4)
                if (input.read(versionBuf) != 4) {
                    Log.w(TAG, "validateHeader: missing version bytes: ${file.name}")
                    return false
                }
                val version = (versionBuf[0].toInt() and 0xFF) or
                    ((versionBuf[1].toInt() and 0xFF) shl 8) or
                    ((versionBuf[2].toInt() and 0xFF) shl 16) or
                    ((versionBuf[3].toInt() and 0xFF) shl 24)
                if (version !in 2..3) {
                    Log.w(TAG, "validateHeader: unsupported GGUF version $version for ${file.name}")
                    return false
                }
                Log.i(TAG, "Valid GGUF v$version file: ${file.name}")
                true
            }
        } catch (e: Exception) {
            Log.e(TAG, "validateHeader failed for ${file.name}", e)
            false
        }
    }
}
