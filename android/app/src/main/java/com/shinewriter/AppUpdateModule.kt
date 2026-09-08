package com.shinewriter

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Small, fail-closed Android boundary for the GitHub Release updater.
 *
 * JS decides which public release is eligible. This module only verifies local
 * APK bytes/metadata against JS-provided expectations and hands a content:// URI
 * to Android's own package installer. It never attempts a silent install.
 */
class AppUpdateModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    private const val MODULE_NAME = "AppUpdate"
    private const val UPDATE_DIRECTORY = "updates"
    private const val FILE_PROVIDER_SUFFIX = ".fileprovider"

    private fun normalizeDigest(value: String): String =
      value.replace(":", "").trim().lowercase(Locale.US)
  }

  private val ioExecutor = Executors.newSingleThreadExecutor()

  override fun getName(): String = MODULE_NAME

  @ReactMethod
  fun getInstalledAppInfo(promise: Promise) {
    try {
      val packageInfo = installedPackageInfo()
      val result = Arguments.createMap()
      result.putString("packageName", reactContext.packageName)
      result.putString("versionName", packageInfo.versionName ?: "")
      result.putInt("versionCode", versionCode(packageInfo))
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("APP_INFO_FAILED", "读取当前应用版本失败: ${error.message}", error)
    }
  }

  @ReactMethod
  fun canInstallUnknownApps(promise: Promise) {
    try {
      val allowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactContext.packageManager.canRequestPackageInstalls()
      } else {
        true
      }
      promise.resolve(allowed)
    } catch (error: Exception) {
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun openUnknownAppSettings(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        promise.resolve(true)
        return
      }
      val intent = Intent(
        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:${reactContext.packageName}"),
      ).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      reactContext.startActivity(intent)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("UNKNOWN_SOURCES_SETTINGS_FAILED", "无法打开安装权限设置: ${error.message}", error)
    }
  }

  @ReactMethod
  fun sha256File(path: String, promise: Promise) {
    ioExecutor.execute {
      try {
        val file = File(path)
        if (!file.isFile) {
          promise.reject("FILE_NOT_FOUND", "文件不存在: $path")
          return@execute
        }
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
          val buffer = ByteArray(1024 * 1024)
          while (true) {
            val read = input.read(buffer)
            if (read <= 0) break
            digest.update(buffer, 0, read)
          }
        }
        promise.resolve(digest.digest().joinToString("") { byte -> "%02x".format(byte) })
      } catch (error: Exception) {
        promise.reject("SHA256_FAILED", "计算文件 SHA-256 失败: ${error.message}", error)
      }
    }
  }

  @ReactMethod
  fun validateApk(
    path: String,
    expectedPackageName: String,
    expectedVersionCode: Int,
    expectedSignerSha256: String,
    promise: Promise,
  ) {
    ioExecutor.execute {
      try {
        val file = File(path)
        if (!file.isFile) {
          promise.resolve(invalidValidation("FILE_NOT_FOUND", "APK 文件不存在。"))
          return@execute
        }
        val packageInfo = archivePackageInfo(file)
        if (packageInfo == null) {
          promise.resolve(invalidValidation("INVALID_APK", "无法读取 APK 包信息。"))
          return@execute
        }
        val signerSha256 = archiveSignerSha256(packageInfo)
        val packageMatches = packageInfo.packageName == expectedPackageName
        val actualVersionCode = versionCode(packageInfo)
        val versionMatches = actualVersionCode == expectedVersionCode
        val signerMatches =
          signerSha256 != null &&
            normalizeDigest(signerSha256) == normalizeDigest(expectedSignerSha256)

        val result = Arguments.createMap()
        result.putBoolean("valid", packageMatches && versionMatches && signerMatches)
        result.putString("packageName", packageInfo.packageName)
        result.putString("versionName", packageInfo.versionName ?: "")
        result.putInt("versionCode", actualVersionCode)
        result.putString("signerSha256", signerSha256 ?: "")
        result.putBoolean("packageMatches", packageMatches)
        result.putBoolean("versionMatches", versionMatches)
        result.putBoolean("signerMatches", signerMatches)
        promise.resolve(result)
      } catch (error: Exception) {
        promise.resolve(invalidValidation("VALIDATION_FAILED", error.message ?: "APK 验证失败。"))
      }
    }
  }

  @ReactMethod
  fun installApk(path: String, promise: Promise) {
    try {
      val file = File(path).canonicalFile
      val updateDirectory = File(reactContext.cacheDir, UPDATE_DIRECTORY).canonicalFile
      val allowedPrefix = updateDirectory.path + File.separator
      if (!file.path.startsWith(allowedPrefix) || !file.isFile) {
        promise.reject("INVALID_INSTALL_PATH", "安装包路径不在受限更新缓存目录内。")
        return
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        !reactContext.packageManager.canRequestPackageInstalls()
      ) {
        promise.reject("UNKNOWN_SOURCES_NOT_ALLOWED", "尚未允许本应用安装未知来源应用。")
        return
      }
      val authority = reactContext.packageName + FILE_PROVIDER_SUFFIX
      val contentUri = FileProvider.getUriForFile(reactContext, authority, file)
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(contentUri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      reactContext.startActivity(intent)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("INSTALL_FAILED", "无法打开 Android 安装器: ${error.message}", error)
    }
  }

  private fun installedPackageInfo(): PackageInfo {
    @Suppress("DEPRECATION")
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      reactContext.packageManager.getPackageInfo(
        reactContext.packageName,
        PackageManager.PackageInfoFlags.of(0),
      )
    } else {
      reactContext.packageManager.getPackageInfo(reactContext.packageName, 0)
    }
  }

  @Suppress("DEPRECATION")
  private fun archivePackageInfo(file: File): PackageInfo? {
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      PackageManager.GET_SIGNING_CERTIFICATES.toLong()
    } else {
      PackageManager.GET_SIGNATURES.toLong()
    }
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      reactContext.packageManager.getPackageArchiveInfo(
        file.absolutePath,
        PackageManager.PackageInfoFlags.of(flags),
      )
    } else {
      reactContext.packageManager.getPackageArchiveInfo(file.absolutePath, flags.toInt())
    }
  }

  @Suppress("DEPRECATION")
  private fun archiveSignerSha256(packageInfo: PackageInfo): String? {
    val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      packageInfo.signingInfo?.apkContentsSigners
    } else {
      packageInfo.signatures
    }
    val signature = signatures?.firstOrNull() ?: return null
    val digest = MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
    return digest.joinToString("") { byte -> "%02x".format(byte) }
  }

  @Suppress("DEPRECATION")
  private fun versionCode(packageInfo: PackageInfo): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      packageInfo.longVersionCode.toInt()
    } else {
      packageInfo.versionCode
    }

  private fun invalidValidation(code: String, message: String) =
    Arguments.createMap().apply {
      putBoolean("valid", false)
      putBoolean("packageMatches", false)
      putBoolean("versionMatches", false)
      putBoolean("signerMatches", false)
      putString("errorCode", code)
      putString("errorMessage", message)
    }

  @ReactMethod
  fun addListener(eventName: String) {
    // Required by NativeEventEmitter when the JS boundary is used by a host.
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // Required by NativeEventEmitter when the JS boundary is used by a host.
  }
}
