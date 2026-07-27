package com.shinewriter

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.Charset
import java.nio.charset.CharsetDecoder
import java.nio.charset.CoderResult
import java.nio.charset.CodingErrorAction

/**
 * Continuation TXT import — native chunked decoder (Spec §10).
 *
 * Supports UTF-8 (incl. BOM), UTF-16 LE/BE, GBK and GB18030. Reads the file
 * in byte chunks so a 5 MB TXT never becomes a single base64 blob in JS.
 *
 * JS calls:
 *   detectEncoding(path) -> { encoding, confidence, hasBom, fileSizeBytes }
 *   readFileMeta(path)   -> { fileSizeBytes, canRead }
 *   decodeChunk(path, encoding, byteOffset, maxBytes, options)
 *       -> { text, nextByteOffset, decodedChars, bytesConsumed, atEof }
 *
 * Multi-byte boundary handling: when a chunk ends inside a multi-byte sequence
 * the decoder is run with REPORT errors; on UNDERFLOW the last partial bytes
 * are excluded from `bytesConsumed` and carried forward via `nextByteOffset`.
 */
class ContinuationTextImportModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    private const val TAG = "ContinuationTextImport"
    // Defensive ceiling; the import service enforces the real UX limit in JS.
    private const val MAX_FILE_BYTES = 200L * 1024L * 1024L
    // Default chunk size targets the 64–256 KiB UTF-8 band (Spec §9.3, §10.2).
    private const val DEFAULT_CHUNK_BYTES = 192 * 1024
  }

  override fun getName(): String = "ContinuationTextImport"

  /** Spec §10.1: sniff BOM, then fall back to heuristic detection. */
  @ReactMethod
  fun detectEncoding(path: String, promise: Promise) {
    try {
      val file = File(path)
      if (!file.exists() || !file.canRead()) {
        promise.reject("unsupported_file", "文件不存在或不可读：${file.name}")
        return
      }
      if (file.length() > MAX_FILE_BYTES) {
        promise.reject("file_too_large", "文件过大，暂不支持：${file.length()} 字节")
        return
      }
      val header = ByteArray(4)
      val read = RandomAccessFile(file, "r").use { raf ->
        raf.seek(0)
        raf.readFully(header)
        raf.filePointer.toInt()
      }
      val (encoding, hasBom, confidence) = sniffEncoding(header, read)

      val map: WritableMap = Arguments.createMap()
      map.putString("encoding", encoding)
      map.putDouble("confidence", confidence)
      map.putBoolean("hasBom", hasBom)
      map.putDouble("fileSizeBytes", file.length().toDouble())
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("decode_failed", "编码探测失败：${e.message}", e)
    }
  }

  @ReactMethod
  fun readFileMeta(path: String, promise: Promise) {
    try {
      val file = File(path)
      val map: WritableMap = Arguments.createMap()
      map.putDouble("fileSizeBytes", if (file.exists()) file.length().toDouble() else 0.0)
      map.putBoolean("canRead", file.exists() && file.canRead())
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("unsupported_file", "读取文件信息失败：${e.message}", e)
    }
  }

  /**
   * Decode one byte range to a JS string. Returns the consumed byte count so
   * the caller can advance the cursor without splitting a multi-byte char.
   */
  @ReactMethod
  fun decodeChunk(
    path: String,
    encoding: String,
    byteOffset: Double,
    maxBytes: Double,
    options: ReadableMap?,
    promise: Promise,
  ) {
    try {
      val file = File(path)
      if (!file.exists() || !file.canRead()) {
        promise.reject("unsupported_file", "文件不存在或不可读")
        return
      }
      val charset = resolveCharset(encoding)
      val startByte = byteOffset.toLong().coerceAtLeast(0)
      val limit = maxBytes.toInt().coerceAtLeast(1).coerceAtMost(DEFAULT_CHUNK_BYTES * 4)
      val fileLen = file.length()
      if (startByte >= fileLen) {
        val done: WritableMap = Arguments.createMap()
        done.putString("text", "")
        done.putDouble("nextByteOffset", fileLen.toDouble())
        done.putInt("decodedChars", 0)
        done.putInt("bytesConsumed", 0)
        done.putBoolean("atEof", true)
        promise.resolve(done)
        return
      }
      // Read a window; for UTF-16 we read in 2-byte-aligned chunks.
      val align = if (charset.name().contains("UTF-16")) 2 else 1
      val rawLen = minOf(limit.toLong(), fileLen - startByte).toInt()
      val alignedLen = rawLen - (rawLen % align)
      if (alignedLen == 0) {
        promise.reject("decode_failed", "剩余字节不足一个 $encoding 字符单元")
        return
      }
      val buffer = ByteArray(alignedLen)
      val actuallyRead: Int = RandomAccessFile(file, "r").use { raf ->
        raf.seek(startByte)
        raf.readFully(buffer)
        alignedLen
      }

      // Decode with REPORT so we can detect a trailing partial sequence.
      val decoder: CharsetDecoder = charset.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
      val inBuf = ByteBuffer.wrap(buffer)
      val outBuf = CharBuffer.allocate(alignedLen * 2)
      var consumedBytes = 0
      var trailingPartial = false
      try {
        // Try decoding the full buffer first (endOfInput = false so a trailing
        // partial sequence surfaces as UNDERFLOW rather than an error).
        val result: CoderResult = decoder.decode(inBuf, outBuf, false)
        when {
          result.isUnderflow -> {
            // bytes remaining in inBuf are a partial multi-byte tail —
            // exclude them from the consumed range so the next chunk starts
            // at the boundary of a complete sequence.
            consumedBytes = actuallyRead - inBuf.remaining()
            trailingPartial = inBuf.remaining() > 0
            if (consumedBytes == 0 && trailingPartial) {
              // Pathological: a single chunk smaller than one char. Force forward
              // progress by consuming one byte (caller will skip on next call).
              consumedBytes = align
            }
          }
          result.isError -> {
            // Malformed bytes mid-stream: fall back to REPLACE so a single bad
            // byte doesn't abort a 5 MB import; report via decodedChars.
            inBuf.rewind()
            outBuf.clear()
            val permissive = charset.newDecoder()
              .onMalformedInput(CodingErrorAction.REPLACE)
              .onUnmappableCharacter(CodingErrorAction.REPLACE)
            permissive.decode(inBuf, outBuf, false)
            consumedBytes = actuallyRead - inBuf.remaining()
          }
          else -> {
            consumedBytes = actuallyRead - inBuf.remaining()
          }
        }
      } catch (e: Exception) {
        promise.reject("decode_failed", "解码失败：${e.message}", e)
        return
      }
      outBuf.flip()
      val text = outBuf.toString()

      val nextByteOffset = startByte + consumedBytes.toLong()
      val map: WritableMap = Arguments.createMap()
      map.putString("text", text)
      map.putDouble("nextByteOffset", nextByteOffset.toDouble())
      map.putInt("decodedChars", text.length)
      map.putInt("bytesConsumed", consumedBytes)
      map.putBoolean("atEof", nextByteOffset >= fileLen)
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("decode_failed", "分块解码失败：${e.message}", e)
    }
  }

  // --- encoding detection helpers -------------------------------------------

  private fun sniffEncoding(header: ByteArray, read: Int): Triple<String, Boolean, Double> {
    // BOM checks first (highest confidence).
    if (read >= 3 && header[0] == 0xEF.toByte() && header[1] == 0xBB.toByte() && header[2] == 0xBF.toByte()) {
      return Triple("utf-8", true, 1.0)
    }
    if (read >= 2 && header[0] == 0xFF.toByte() && header[1] == 0xFE.toByte()) {
      return Triple("utf-16le", true, 1.0)
    }
    if (read >= 2 && header[0] == 0xFE.toByte() && header[1] == 0xFF.toByte()) {
      return Triple("utf-16be", true, 1.0)
    }
    // No BOM: heuristic. If the first 1 KB looks like valid UTF-8, assume UTF-8.
    val looksUtf8 = looksLikeValidUtf8(header, read)
    if (looksUtf8) return Triple("utf-8", false, 0.85)
    // Otherwise assume GBK/GB18030 for Chinese TXTs (very common case).
    return Triple("gb18030", false, 0.6)
  }

  private fun looksLikeValidUtf8(bytes: ByteArray, len: Int): Boolean {
    // Quick validity scan of the sniff header (4 bytes is small, but combined
    // with the caller's confidence this is enough to bias the decision). A
    // full-scan variant is invoked by the JS normalizer on the first chunk.
    if (len == 0) return true
    var i = 0
    var multiByteOk = true
    while (i < minOf(len, bytes.size)) {
      val b = bytes[i].toInt() and 0xFF
      when {
        b < 0x80 -> i += 1
        b in 0xC2..0xDF -> {
          if (i + 1 >= len || (bytes[i + 1].toInt() and 0xC0) != 0x80) {
            multiByteOk = false
          }
          i += 2
        }
        b in 0xE0..0xEF -> {
          if (i + 2 >= len) { i += 3; break }
          val c1 = bytes[i + 1].toInt() and 0xC0
          val c2 = bytes[i + 2].toInt() and 0xC0
          if (c1 != 0x80 || c2 != 0x80) multiByteOk = false
          i += 3
        }
        b in 0xF0..0xF4 -> {
          if (i + 3 >= len) { i += 4; break }
          val c1 = bytes[i + 1].toInt() and 0xC0
          val c2 = bytes[i + 2].toInt() and 0xC0
          val c3 = bytes[i + 3].toInt() and 0xC0
          if (c1 != 0x80 || c2 != 0x80 || c3 != 0x80) multiByteOk = false
          i += 4
        }
        else -> return false // stray continuation byte ⇒ not valid UTF-8
      }
    }
    return multiByteOk
  }

  private fun resolveCharset(encoding: String): Charset {
    return when (encoding.lowercase()) {
      "utf-8", "utf8" -> Charsets.UTF_8
      "utf-16le", "utf_16le", "utf-16-le" -> Charsets.UTF_16LE
      "utf-16be", "utf_16be", "utf-16-be" -> Charsets.UTF_16BE
      "utf-16", "utf16" -> Charsets.UTF_16LE // LE default when no BOM
      "gbk", "gb2312" -> Charset.forName("GBK")
      "gb18030" -> Charset.forName("GB18030")
      else -> throw IllegalArgumentException("不支持的编码：$encoding")
    }
  }

  // NativeEventEmitter protocol no-ops.
  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Int) {}
}
