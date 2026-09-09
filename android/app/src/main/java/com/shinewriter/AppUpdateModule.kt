package com.shinewriter

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
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
    private const val UPDATE_PREFS = "shinewriter.update.download"
    private const val KEY_DOWNLOAD_ID = "download_id"
    private const val KEY_VERSION_CODE = "version_code"
    private const val KEY_VERSION_NAME = "version_name"
    private const val KEY_APK_NAME = "apk_name"
    private const val KEY_APK_URL = "apk_url"
    private const val KEY_SHA256 = "sha256"
    private const val KEY_RELEASE_INFO = "release_info"
    private const val KEY_CREATED_AT = "created_at"
    private const val APK_NAME_PATTERN = "^ShineWriter-V\\d+\\.\\d+\\.\\d+-release\\.apk$"

    private fun normalizeDigest(value: String): String =
      value.replace(":", "").trim().lowercase(Locale.US)
  }

  private val ioExecutor = Executors.newSingleThreadExecutor()
  private val downloadLock = Any()
  private val updatePrefs by lazy {
    reactContext.getSharedPreferences(UPDATE_PREFS, Context.MODE_PRIVATE)
  }

  override fun getName(): String = MODULE_NAME

  private data class StoredDownload(
    val id: Long,
    val versionCode: Int,
    val versionName: String,
    val apkName: String,
    val apkUrl: String,
    val sha256: String,
    val releaseInfo: String,
    val createdAt: Long,
  )

  private data class DownloadSnapshot(
    val status: Int,
    val bytesDownloaded: Long,
    val totalBytes: Long,
    val reason: Int,
    val localUri: String?,
  )

  private fun storedDownload(): StoredDownload? {
    if (!updatePrefs.contains(KEY_DOWNLOAD_ID)) return null
    val id = updatePrefs.getLong(KEY_DOWNLOAD_ID, -1L)
    if (id <= 0L) return null
    return StoredDownload(
      id = id,
      versionCode = updatePrefs.getInt(KEY_VERSION_CODE, 0),
      versionName = updatePrefs.getString(KEY_VERSION_NAME, "") ?: "",
      apkName = updatePrefs.getString(KEY_APK_NAME, "") ?: "",
      apkUrl = updatePrefs.getString(KEY_APK_URL, "") ?: "",
      sha256 = updatePrefs.getString(KEY_SHA256, "") ?: "",
      releaseInfo = updatePrefs.getString(KEY_RELEASE_INFO, "") ?: "",
      createdAt = updatePrefs.getLong(KEY_CREATED_AT, 0L),
    )
  }

  private fun persistDownload(task: StoredDownload) {
    updatePrefs.edit()
      .putLong(KEY_DOWNLOAD_ID, task.id)
      .putInt(KEY_VERSION_CODE, task.versionCode)
      .putString(KEY_VERSION_NAME, task.versionName)
      .putString(KEY_APK_NAME, task.apkName)
      .putString(KEY_APK_URL, task.apkUrl)
      .putString(KEY_SHA256, task.sha256)
      .putString(KEY_RELEASE_INFO, task.releaseInfo)
      .putLong(KEY_CREATED_AT, task.createdAt)
      .apply()
  }

  private fun clearStoredDownload() {
    updatePrefs.edit().clear().apply()
  }

  private fun downloadManager(): DownloadManager =
    reactContext.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

  private fun queryDownload(id: Long): DownloadSnapshot? {
    val cursor = downloadManager().query(DownloadManager.Query().setFilterById(id))
      ?: return null
    return try {
      if (!cursor.moveToFirst()) return null
      DownloadSnapshot(
        status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)),
        bytesDownloaded = cursor.getLong(
          cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR),
        ).coerceAtLeast(0L),
        totalBytes = cursor.getLong(
          cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES),
        ),
        reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)),
        localUri = cursor.getString(
          cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI),
        ),
      )
    } finally {
      cursor.close()
    }
  }

  private fun statusName(status: Int): String = when (status) {
    DownloadManager.STATUS_PENDING -> "pending"
    DownloadManager.STATUS_RUNNING -> "running"
    DownloadManager.STATUS_PAUSED -> "paused"
    DownloadManager.STATUS_SUCCESSFUL -> "successful"
    DownloadManager.STATUS_FAILED -> "failed"
    else -> "failed"
  }

  private fun reasonMessage(status: Int, reason: Int): String = when {
    status == DownloadManager.STATUS_PAUSED &&
      reason == DownloadManager.PAUSED_WAITING_FOR_NETWORK -> "等待网络连接。"
    status == DownloadManager.STATUS_PAUSED &&
      reason == DownloadManager.PAUSED_QUEUED_FOR_WIFI -> "等待 Wi-Fi 网络。"
    status == DownloadManager.STATUS_FAILED &&
      reason == DownloadManager.ERROR_INSUFFICIENT_SPACE -> "设备存储空间不足。"
    status == DownloadManager.STATUS_FAILED &&
      reason == DownloadManager.ERROR_DEVICE_NOT_FOUND -> "下载目标不可用。"
    status == DownloadManager.STATUS_FAILED &&
      reason == DownloadManager.ERROR_HTTP_DATA_ERROR -> "网络数据错误。"
    status == DownloadManager.STATUS_FAILED && reason != 0 -> "系统下载错误（$reason）。"
    else -> ""
  }

  private fun statusMap(
    task: StoredDownload,
    snapshot: DownloadSnapshot,
  ) = Arguments.createMap().apply {
    putDouble("downloadId", task.id.toDouble())
    putString("status", statusName(snapshot.status))
    putDouble("bytesDownloaded", snapshot.bytesDownloaded.toDouble())
    putDouble("totalBytes", snapshot.totalBytes.toDouble())
    putInt("reason", snapshot.reason)
    putString("reasonMessage", reasonMessage(snapshot.status, snapshot.reason))
    putInt("versionCode", task.versionCode)
    putString("versionName", task.versionName)
    putString("apkName", task.apkName)
    putString("apkUrl", task.apkUrl)
    putString("sha256", task.sha256)
    putString("releaseInfo", task.releaseInfo)
    putDouble("createdAt", task.createdAt.toDouble())
    if (!snapshot.localUri.isNullOrBlank()) putString("localUri", snapshot.localUri)
  }

  private fun validApkName(value: String): String {
    require(Regex(APK_NAME_PATTERN).matches(value)) { "APK 文件名无效。" }
    return value
  }

  private fun validDownloadUrl(value: String): Uri {
    val uri = Uri.parse(value)
    val host = uri.host?.lowercase(Locale.US)
    require(uri.scheme == "https" &&
      (host == "github.com" || host == "objects.githubusercontent.com")) {
      "APK 下载地址不是受信任的 HTTPS GitHub 地址。"
    }
    return uri
  }

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

  /**
   * Enqueue the APK in Android's system DownloadManager. The DownloadManager
   * row and this small metadata record outlive the React Native runtime, so a
   * normal background/screen-removal/process-restart does not lose the task.
   */
  @ReactMethod
  fun enqueueUpdateDownload(
    apkUrl: String,
    apkName: String,
    versionCode: Int,
    versionName: String,
    sha256: String,
    releaseInfo: String,
    promise: Promise,
  ) {
    try {
      val safeApkName = validApkName(apkName)
      val trustedUrl = validDownloadUrl(apkUrl)
      require(versionCode > 0) { "APK versionCode 无效。" }
      require(Regex("^[a-fA-F0-9]{64}$").matches(sha256)) {
        "APK SHA-256 无效。"
      }

      synchronized(downloadLock) {
        val existing = storedDownload()
        if (existing != null) {
          val existingSnapshot = queryDownload(existing.id)
          val sameVersion = existing.versionCode == versionCode
          val existingIsReusable = existingSnapshot != null &&
            existingSnapshot.status != DownloadManager.STATUS_FAILED
          if (sameVersion && existingIsReusable) {
            promise.resolve(statusMap(existing, existingSnapshot!!))
            return
          }
          // A failed task is replaced only when this method is explicitly
          // called again. A different version never inherits an old id.
          downloadManager().remove(existing.id)
          deleteMaterializedFiles(existing.apkName)
          clearStoredDownload()
        }

        val request = DownloadManager.Request(trustedUrl).apply {
          setTitle("ShineWriter $versionName 更新包")
          setDescription("系统后台下载 APK，完成后返回 ShineWriter 校验并安装")
          setMimeType("application/vnd.android.package-archive")
          setNotificationVisibility(
            DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED,
          )
          setAllowedOverMetered(true)
          setAllowedOverRoaming(false)
          setDestinationInExternalFilesDir(
            reactContext,
            Environment.DIRECTORY_DOWNLOADS,
            safeApkName,
          )
        }
        val id = downloadManager().enqueue(request)
        val task = StoredDownload(
          id = id,
          versionCode = versionCode,
          versionName = versionName,
          apkName = safeApkName,
          apkUrl = apkUrl,
          sha256 = sha256.lowercase(Locale.US),
          releaseInfo = releaseInfo,
          createdAt = System.currentTimeMillis(),
        )
        persistDownload(task)
        val snapshot = queryDownload(id) ?: DownloadSnapshot(
          status = DownloadManager.STATUS_PENDING,
          bytesDownloaded = 0L,
          totalBytes = -1L,
          reason = 0,
          localUri = null,
        )
        promise.resolve(statusMap(task, snapshot))
      }
    } catch (error: Exception) {
      promise.reject("UPDATE_DOWNLOAD_ENQUEUE_FAILED", "无法交给 Android 系统下载: ${error.message}", error)
    }
  }

  @ReactMethod
  fun getUpdateDownloadStatus(promise: Promise) {
    ioExecutor.execute {
      try {
        synchronized(downloadLock) {
          val task = storedDownload()
          if (task == null) {
            promise.resolve(null)
            return@execute
          }
          val snapshot = queryDownload(task.id)
          if (snapshot == null) {
            // Keep the record so the UI can show a failed/recoverable task and
            // an explicit retry can replace it safely.
            promise.resolve(
              statusMap(
                task,
                DownloadSnapshot(
                  status = DownloadManager.STATUS_FAILED,
                  bytesDownloaded = 0L,
                  totalBytes = 0L,
                  reason = DownloadManager.ERROR_UNKNOWN,
                  localUri = null,
                ),
              ),
            )
          } else {
            promise.resolve(statusMap(task, snapshot))
          }
        }
      } catch (error: Exception) {
        promise.reject("UPDATE_DOWNLOAD_STATUS_FAILED", "读取系统下载任务失败: ${error.message}", error)
      }
    }
  }

  @ReactMethod
  fun cancelUpdateDownload(promise: Promise) {
    ioExecutor.execute {
      try {
        synchronized(downloadLock) {
          val task = storedDownload()
          val removed = if (task == null) {
            false
          } else {
            downloadManager().remove(task.id) > 0
          }
          if (task != null) deleteMaterializedFiles(task.apkName)
          clearStoredDownload()
          promise.resolve(removed)
        }
      } catch (error: Exception) {
        promise.reject("UPDATE_DOWNLOAD_CANCEL_FAILED", "清理系统下载任务失败: ${error.message}", error)
      }
    }
  }

  /**
   * DownloadManager may expose a content:// URI. Copy it through
   * ContentResolver into the app-private cache before any hash/package/signing
   * validation. The .part -> rename boundary prevents a partial APK from ever
   * reaching the installer.
   */
  @ReactMethod
  fun materializeDownloadedUpdate(versionCode: Int, promise: Promise) {
    ioExecutor.execute {
      try {
        synchronized(downloadLock) {
          val task = storedDownload()
            ?: throw IllegalStateException("没有可恢复的系统下载任务。")
          require(task.versionCode == versionCode) {
            "系统下载任务版本与当前 Release 不一致。"
          }
          val snapshot = queryDownload(task.id)
            ?: throw IllegalStateException("系统下载任务已不存在。")
          require(snapshot.status == DownloadManager.STATUS_SUCCESSFUL) {
            "系统下载任务尚未完成。"
          }
          val sourceUri = snapshot.localUri?.let(Uri::parse)
            ?: throw IllegalStateException("系统下载结果缺少安全 URI。")

          val directory = File(reactContext.cacheDir, UPDATE_DIRECTORY).apply {
            if (!exists() && !mkdirs()) {
              throw IllegalStateException("无法创建更新缓存目录。")
            }
          }
          val output = File(directory, validApkName(task.apkName)).canonicalFile
          val part = File("${output.path}.part")
          if (part.exists() && !part.delete()) {
            throw IllegalStateException("无法清理上一次未完成的更新缓存。")
          }

          val input = openDownloadedInputStream(sourceUri)
            ?: throw IllegalStateException("无法读取系统下载结果。")
          input.use { inputStream ->
            FileOutputStream(part).use { outputStream ->
              inputStream.copyTo(outputStream, 1024 * 1024)
              outputStream.fd.sync()
            }
          }
          require(part.isFile && part.length() > 0L) {
            "系统下载结果为空。"
          }
          if (output.exists() && !output.delete()) {
            throw IllegalStateException("无法替换旧的更新缓存。")
          }
          require(part.renameTo(output)) {
            "无法原子保存更新缓存。"
          }
          promise.resolve(output.absolutePath)
        }
      } catch (error: Exception) {
        promise.reject("UPDATE_DOWNLOAD_MATERIALIZE_FAILED", "无法安全读取系统下载结果: ${error.message}", error)
      }
    }
  }

  private fun openDownloadedInputStream(uri: Uri): java.io.InputStream? {
    return when (uri.scheme?.lowercase(Locale.US)) {
      "content" -> reactContext.contentResolver.openInputStream(uri)
      "file" -> FileInputStream(
        File(uri.path ?: throw IllegalStateException("下载文件路径为空。")),
      )
      null -> FileInputStream(File(uri.toString()))
      else -> throw IllegalStateException("不支持的系统下载 URI 类型。")
    }
  }

  private fun deleteMaterializedFiles(apkName: String) {
    if (apkName.isBlank()) return
    val safeName = try {
      validApkName(apkName)
    } catch (_: Exception) {
      return
    }
    val directory = File(reactContext.cacheDir, UPDATE_DIRECTORY)
    File(directory, safeName).delete()
    File(directory, "$safeName.part").delete()
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
