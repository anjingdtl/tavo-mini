package com.shinewriter

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import java.io.DataInputStream
import java.io.EOFException
import java.io.FileInputStream

/**
 * 解析 PNG 文件中的 tEXt 块（用于角色卡导入）。
 *
 * PNG 格式：8 字节签名后是多个 chunk，每个 chunk 由
 * length(4) + type(4) + data(length) + crc(4) 组成。
 * tEXt 类型的 data 包含 keyword\0text，按 null 字节分隔。
 */
class PngMetadataModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "PngMetadata"

  @ReactMethod
  fun parsePngMetadata(filePath: String, promise: Promise) {
    try {
      val result: WritableArray = Arguments.createArray()
      DataInputStream(FileInputStream(filePath)).use { input ->
        // 校验 PNG 签名（8 字节）
        val signature = ByteArray(8)
        input.readFully(signature)
        if (!isPngSignature(signature)) {
          promise.reject("INVALID_PNG", "文件不是有效的 PNG")
          return
        }

        // 依次读取 chunk
        while (true) {
          val length: Int = try {
            input.readInt()  // big-endian，正好匹配 PNG 格式
          } catch (e: EOFException) {
            break  // 到达文件末尾
          }

          val typeBytes = ByteArray(4)
          input.readFully(typeBytes)
          val type = String(typeBytes, Charsets.US_ASCII)

          // chunk data（length 可能为 0）
          val data = ByteArray(length)
          if (length > 0) {
            input.readFully(data)
          }

          // CRC 4 字节（直接丢弃）
          input.readInt()

          if (type == "tEXt" && length > 0) {
            val entry = parseTextChunk(data)
            if (entry != null) {
              result.pushMap(entry)
            }
          }

          // 到达末尾 chunk
          if (type == "IEND") break
        }
      }
      promise.resolve(result)
    } catch (e: Exception) {
      promise.reject("PARSE_FAILED", "解析 PNG 元数据失败: ${e.message}", e)
    }
  }

  /**
   * 校验 PNG 签名：89 50 4E 47 0D 0A 1A 0A
   */
  private fun isPngSignature(bytes: ByteArray): Boolean {
    val pngSig = byteArrayOf(
      0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A
    )
    if (bytes.size < 8) return false
    for (i in 0 until 8) {
      if (bytes[i] != pngSig[i]) return false
    }
    return true
  }

  /**
   * 解析 tEXt chunk 数据：keyword\0text。
   * 返回包含 key 和 data 字段的 WritableMap（与 TS 侧 PngMetadataResult 接口一致）。
   */
  private fun parseTextChunk(data: ByteArray): WritableMap? {
    var separatorIndex = -1
    for (i in data.indices) {
      if (data[i].toInt() == 0) {
        separatorIndex = i
        break
      }
    }
    // 缺少 null 分隔符或 keyword 为空，跳过
    if (separatorIndex <= 0 || separatorIndex >= data.size) return null

    val keyword = String(data, 0, separatorIndex, Charsets.UTF_8)
    val text = String(data, separatorIndex + 1, data.size - separatorIndex - 1, Charsets.UTF_8)

    val map: WritableMap = Arguments.createMap()
    map.putString("key", keyword)
    map.putString("data", text)
    return map
  }

  // NativeEventEmitter 要求原生模块实现这两个方法（空实现即可）
  @ReactMethod
  fun addListener(eventName: String) {
    // No-op: 此模块不发事件，仅满足 NativeEventEmitter 协议
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // No-op: 同上
  }
}
